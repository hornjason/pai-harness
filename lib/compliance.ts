/**
 * Instruction compliance scoring for agent-read files.
 *
 * Wraps agnix (SC-180) and RepoRails (SC-181) via Bun.spawnSync.
 * Does NOT reimplement scoring with regex (SC-240).
 *
 * Layer 1: runTemplateCompliance() — scores instruction language via external tools
 * Layer 2: runGeneratedCompliance() — verifies scaffold doesn't degrade quality
 * Layer 3: runBehavioralCompliance() — spawns agent + auditor (future)
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join, relative } from "path";

// ── Types ──────────────────────────────────────────────────

export interface InstructionFinding {
  file: string;
  line: number;
  rule: string;
  source: "agnix" | "reporails";
  severity: "HIGH" | "MEDIUM" | "LOW";
  category: string;
  message: string;
  suggestion: string;
}

export interface FileScore {
  file: string;
  agnixFindings: number;
  reporailsFindings: number;
  reporailsQuality: number | null;
  findings: InstructionFinding[];
}

export interface ComplianceReport {
  timestamp: string;
  layer: "template" | "generated" | "behavioral";
  surface: string[];
  files: FileScore[];
  overallQuality: number | null;
  totalFindings: number;
  highCount: number;
  toolsAvailable: { agnix: boolean; reporails: boolean };
}

// ── Tool Runners ───────────────────────────────────────────

interface AgnixDiagnostic {
  level: string;
  rule: string;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  rule_severity?: string;
  category?: string;
}

interface AgnixOutput {
  diagnostics: AgnixDiagnostic[];
}

function runAgnixBatch(paths: string[]): AgnixDiagnostic[] | null {
  try {
    const result = Bun.spawnSync(["agnix", ...paths, "--format", "json"], {
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stdout = result.stdout.toString().trim();
    if (!stdout) return null;
    const parsed: AgnixOutput = JSON.parse(stdout);
    return parsed.diagnostics || [];
  } catch {
    return null;
  }
}

interface RepoRailsFinding {
  line: number;
  severity: string;
  rule: string;
  category: string;
  leverage?: string;
  message: string;
  fix?: string;
}

interface RepoRailsOutput {
  quality: number;
  level: string;
  files: Record<string, { findings: RepoRailsFinding[] }>;
}

function runRepoRailsBatch(paths: string[]): RepoRailsOutput | null {
  try {
    const result = Bun.spawnSync(["npx", "@reporails/cli", "check", ...paths, "--format", "json"], {
      timeout: 30_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stdout = result.stdout.toString().trim();
    if (!stdout) return null;
    return JSON.parse(stdout) as RepoRailsOutput;
  } catch {
    return null;
  }
}

// ── Severity Mapping ───────────────────────────────────────

function mapAgnixSeverity(level: string, ruleSeverity?: string): "HIGH" | "MEDIUM" | "LOW" {
  if (ruleSeverity === "HIGH" || level === "error") return "HIGH";
  if (ruleSeverity === "MEDIUM" || level === "warning") return "MEDIUM";
  return "LOW";
}

function mapRepoRailsSeverity(severity: string): "HIGH" | "MEDIUM" | "LOW" {
  if (severity === "error") return "HIGH";
  if (severity === "warning") return "MEDIUM";
  return "LOW";
}

// ── Compliance Surface ─────────────────────────────────────

const DEFAULT_SURFACE = [
  "prompts",
  "AGENTS.md",
  ".claude/agents",
  "CLAUDE.md",
];

export function collectComplianceSurface(root: string, surface?: string[]): string[] {
  const patterns = surface || DEFAULT_SURFACE;
  const files: string[] = [];

  for (const pattern of patterns) {
    const full = join(root, pattern);
    if (!existsSync(full)) continue;

    try {
      const stat = require("fs").statSync(full);
      if (stat.isDirectory()) {
        for (const f of readdirSync(full).filter(f => f.endsWith(".md"))) {
          files.push(join(full, f));
        }
      } else {
        files.push(full);
      }
    } catch {}
  }

  return files;
}

// ── Tool Availability ──────────────────────────────────────

function checkToolAvailable(command: string, args: string[]): boolean {
  try {
    const result = Bun.spawnSync([command, ...args], { timeout: 5_000 });
    return result.exitCode === 0 || result.stdout.toString().length > 0;
  } catch {
    return false;
  }
}

// ── Layer 1: Template Compliance ───────────────────────────

export interface TemplateComplianceOpts {
  surface?: string[];
  writeReport?: boolean;
}

export function runTemplateCompliance(
  root: string,
  opts?: TemplateComplianceOpts,
): ComplianceReport {
  const files = collectComplianceSurface(root, opts?.surface);

  const agnixAvailable = checkToolAvailable("agnix", ["--version"]);
  const reporailsAvailable = checkToolAvailable("npx", ["@reporails/cli", "version"]);

  // agnix: batch mode works fine for file attribution
  const agnixByFile = new Map<string, AgnixDiagnostic[]>();
  // RepoRails: per-file mode — batch drops findings for small files
  const rrByFile = new Map<string, { quality: number | null; findings: RepoRailsFinding[] }>();

  if (agnixAvailable) {
    const results = runAgnixBatch(files);
    if (results) {
      for (const d of results) {
        const key = d.file;
        if (!agnixByFile.has(key)) agnixByFile.set(key, []);
        agnixByFile.get(key)!.push(d);
      }
    }
  }

  if (reporailsAvailable) {
    for (const filePath of files) {
      const result = runRepoRailsBatch([filePath]);
      if (result) {
        const relPath = relative(root, filePath);
        for (const [fp, data] of Object.entries(result.files)) {
          rrByFile.set(relPath, { quality: result.quality, findings: data.findings });
        }
      }
    }
  }

  const fileScores: FileScore[] = [];

  for (const filePath of files) {
    const relPath = relative(root, filePath);
    const findings: InstructionFinding[] = [];
    let reporailsQuality: number | null = null;

    const agnixResults = agnixByFile.get(relPath) || agnixByFile.get(filePath) || [];
    for (const d of agnixResults) {
      findings.push({
        file: relPath,
        line: d.line,
        rule: `AGNIX-${d.rule}`,
        source: "agnix",
        severity: mapAgnixSeverity(d.level, d.rule_severity),
        category: d.category || "general",
        message: d.message,
        suggestion: d.suggestion || "",
      });
    }

    const rrData = rrByFile.get(relPath) || rrByFile.get(filePath);
    if (rrData) {
      reporailsQuality = rrData.quality;
      for (const f of rrData.findings) {
        findings.push({
          file: relPath,
          line: f.line,
          rule: `REPORAILS-${f.rule}`,
          source: "reporails",
          severity: mapRepoRailsSeverity(f.severity),
          category: f.category || "general",
          message: f.message,
          suggestion: f.fix || "",
        });
      }
    }

    fileScores.push({
      file: relPath,
      agnixFindings: findings.filter(f => f.source === "agnix").length,
      reporailsFindings: findings.filter(f => f.source === "reporails").length,
      reporailsQuality,
      findings,
    });
  }

  const totalFindings = fileScores.reduce((sum, f) => sum + f.findings.length, 0);
  const highCount = fileScores.reduce(
    (sum, f) => sum + f.findings.filter(fi => fi.severity === "HIGH").length,
    0,
  );

  const qualityScores = fileScores.filter(f => f.reporailsQuality !== null);
  const overallQuality = qualityScores.length > 0
    ? qualityScores.reduce((sum, f) => sum + f.reporailsQuality!, 0) / qualityScores.length
    : null;

  const report: ComplianceReport = {
    timestamp: new Date().toISOString(),
    layer: "template",
    surface: files.map(f => relative(root, f)),
    files: fileScores,
    overallQuality,
    totalFindings,
    highCount,
    toolsAvailable: { agnix: agnixAvailable, reporails: reporailsAvailable },
  };

  if (opts?.writeReport !== false) {
    const outDir = join(root, ".rungate");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "compliance-report.json"),
      JSON.stringify(report, null, 2),
    );
  }

  if (!agnixAvailable) {
    console.warn("WARN TOOL-NOT-INSTALLED-agnix: agnix not found — install globally or via npm");
  }
  if (!reporailsAvailable) {
    console.warn("WARN TOOL-NOT-INSTALLED-reporails: @reporails/cli not found — install via npm");
  }

  return report;
}

// ── Layer 2: Generated Compliance ──────────────────────────

export function runGeneratedCompliance(
  root: string,
  baselineReport?: ComplianceReport,
): ComplianceReport {
  const report = runTemplateCompliance(root, { writeReport: false });
  report.layer = "generated";

  if (baselineReport && baselineReport.overallQuality !== null && report.overallQuality !== null) {
    if (report.overallQuality < baselineReport.overallQuality - 0.5) {
      console.error(
        `FAIL: Scaffold degraded instruction quality from ${baselineReport.overallQuality.toFixed(1)} to ${report.overallQuality.toFixed(1)}`
      );
    }
  }

  const outDir = join(root, ".rungate");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "compliance-generated.json"),
    JSON.stringify(report, null, 2),
  );

  return report;
}
