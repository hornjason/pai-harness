/**
 * Compliance iteration loop — runs Layer 1 + behavioral tests on all template files.
 * Outputs: .rungate/compliance-iterations.json
 *
 * Usage: bun run scripts/compliance-loop.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, ".rungate");
const REPORT_PATH = join(OUT_DIR, "compliance-iterations.json");

interface ToolFinding {
  rule: string;
  source: "agnix" | "reporails";
  severity: string;
  line: number;
  message: string;
  suggestion: string;
}

interface FileIteration {
  iteration: number;
  timestamp: string;
  agnixCount: number;
  reporailsCount: number;
  highCount: number;
  findings: ToolFinding[];
  changes: string[];
  behavioralTest?: {
    ran: boolean;
    canaryPlanted?: string;
    canaryFound?: boolean;
    compResults?: Record<string, "PASS" | "FAIL" | "SKIP">;
    transcriptEvidence?: string;
  };
}

interface FileReport {
  file: string;
  fileType: "prompt" | "agent-brief" | "agents-md" | "claude-md";
  iterations: FileIteration[];
  baselineHigh: number;
  currentHigh: number;
  improved: boolean;
  status: "improved" | "unchanged" | "needs-behavioral" | "escalate";
}

interface IterationReport {
  startedAt: string;
  completedAt?: string;
  totalFiles: number;
  filesProcessed: number;
  files: FileReport[];
  summary: {
    improved: number;
    unchanged: number;
    needsBehavioral: number;
    escalated: number;
    totalHighBefore: number;
    totalHighAfter: number;
  };
}

function runAgnixBatch(paths: string[]): ToolFinding[] {
  try {
    const result = Bun.spawnSync(["agnix", ...paths, "--format", "json"], {
      timeout: 15_000, cwd: ROOT,
    });
    const stdout = result.stdout.toString().trim();
    if (!stdout) return [];
    const parsed = JSON.parse(stdout);
    return (parsed.diagnostics || []).map((d: any) => ({
      rule: `AGNIX-${d.rule}`,
      source: "agnix" as const,
      severity: d.rule_severity || (d.level === "error" ? "HIGH" : "MEDIUM"),
      line: d.line,
      message: d.message,
      suggestion: d.suggestion || "",
    }));
  } catch { return []; }
}

function runRepoRailsBatch(paths: string[]): Map<string, { findings: ToolFinding[]; quality: number | null }> {
  const result = new Map<string, { findings: ToolFinding[]; quality: number | null }>();
  try {
    const proc = Bun.spawnSync(["npx", "@reporails/cli", "check", ...paths, "--format", "json"], {
      timeout: 30_000, cwd: ROOT,
    });
    const stdout = proc.stdout.toString().trim();
    if (!stdout) return result;
    const parsed = JSON.parse(stdout);
    for (const [filePath, data] of Object.entries(parsed.files || {})) {
      const d = data as any;
      result.set(filePath, {
        quality: parsed.quality,
        findings: (d.findings || []).map((f: any) => ({
          rule: `REPORAILS-${f.rule}`,
          source: "reporails" as const,
          severity: f.severity === "error" ? "HIGH" : "MEDIUM",
          line: f.line,
          message: f.message,
          suggestion: f.fix || "",
        })),
      });
    }
  } catch {}
  return result;
}

function classifyFile(relPath: string): FileReport["fileType"] {
  if (relPath.startsWith("prompts/")) return "prompt";
  if (relPath.startsWith(".claude/agents/")) return "agent-brief";
  if (relPath === "AGENTS.md") return "agents-md";
  return "claude-md";
}

function scoreFile(filePath: string, relPath: string): FileIteration {
  const agnixFindings = runAgnixBatch([filePath]).filter(f =>
    f.message.includes(relPath) || true
  );
  const rrMap = runRepoRailsBatch([filePath]);
  const rrData = rrMap.get(relPath) || rrMap.get(filePath) || { findings: [], quality: null };

  const allFindings = [...agnixFindings, ...rrData.findings];

  return {
    iteration: 0,
    timestamp: new Date().toISOString(),
    agnixCount: agnixFindings.length,
    reporailsCount: rrData.findings.length,
    highCount: allFindings.filter(f => f.severity === "HIGH").length,
    findings: allFindings,
    changes: [],
  };
}

// ── Main ───────────────────────────────────────────────────

export function initReport(): IterationReport {
  const surface = [
    ...readdirSync(join(ROOT, "prompts")).filter(f => f.endsWith(".md")).map(f => `prompts/${f}`),
    ...readdirSync(join(ROOT, ".claude", "agents")).filter(f => f.endsWith(".md")).map(f => `.claude/agents/${f}`),
    "AGENTS.md",
    "CLAUDE.md",
  ].filter(f => existsSync(join(ROOT, f)));

  return {
    startedAt: new Date().toISOString(),
    totalFiles: surface.length,
    filesProcessed: 0,
    files: surface.map(f => ({
      file: f,
      fileType: classifyFile(f),
      iterations: [],
      baselineHigh: 0,
      currentHigh: 0,
      improved: false,
      status: "unchanged" as const,
    })),
    summary: {
      improved: 0,
      unchanged: 0,
      needsBehavioral: 0,
      escalated: 0,
      totalHighBefore: 0,
      totalHighAfter: 0,
    },
  };
}

export function runBaseline(report: IterationReport): IterationReport {
  console.log(`\nRunning baseline on ${report.totalFiles} files...`);

  for (const fileReport of report.files) {
    const relPath = fileReport.file;
    const fullPath = join(ROOT, relPath);

    // Per-file scoring — batch mode drops findings for small files
    const perFileAgnix = runAgnixBatch([fullPath]);
    const rrMap = runRepoRailsBatch([fullPath]);
    const rrData = rrMap.get(relPath) || rrMap.get(fullPath);
    const rrFindings = rrData?.findings || [];

    const allFindings = [...perFileAgnix, ...rrFindings];
    const highCount = allFindings.filter(f => f.severity === "HIGH").length;

    const iteration: FileIteration = {
      iteration: 0,
      timestamp: new Date().toISOString(),
      agnixCount: perFileAgnix.length,
      reporailsCount: rrFindings.length,
      highCount,
      findings: allFindings,
      changes: ["baseline"],
    };

    fileReport.iterations.push(iteration);
    fileReport.baselineHigh = highCount;
    fileReport.currentHigh = highCount;
    report.filesProcessed++;

    console.log(`  ${relPath}: agnix=${perFileAgnix.length} rr=${rrFindings.length} HIGH=${highCount}`);
  }

  report.summary.totalHighBefore = report.files.reduce((s, f) => s + f.baselineHigh, 0);
  report.summary.totalHighAfter = report.summary.totalHighBefore;

  return report;
}

export function saveReport(report: IterationReport): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${REPORT_PATH}`);
}

export function updateSummary(report: IterationReport): void {
  let improved = 0, unchanged = 0, needsBehavioral = 0, escalated = 0;
  let totalHighAfter = 0;

  for (const f of report.files) {
    const last = f.iterations[f.iterations.length - 1];
    f.currentHigh = last?.highCount ?? f.baselineHigh;
    totalHighAfter += f.currentHigh;

    if (f.currentHigh < f.baselineHigh) { improved++; f.status = "improved"; f.improved = true; }
    else if (f.iterations.length > 5) { escalated++; f.status = "escalate"; }
    else if (f.iterations.length > 1) { unchanged++; f.status = "unchanged"; }
    else { needsBehavioral++; f.status = "needs-behavioral"; }
  }

  report.summary = { improved, unchanged, needsBehavioral, escalated, totalHighBefore: report.summary.totalHighBefore, totalHighAfter };
}

// Run if executed directly
if (import.meta.main) {
  const report = initReport();
  runBaseline(report);
  updateSummary(report);
  saveReport(report);

  console.log(`\n=== Baseline Complete ===`);
  console.log(`Files: ${report.totalFiles}`);
  console.log(`Total HIGH: ${report.summary.totalHighBefore}`);
  console.log(`Ready for iteration loop.`);
}
