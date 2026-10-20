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
import { probeExternalTool, type ToolProbe, type ToolProbeOutcome } from "./tool-probe";

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
  /**
   * Which tools READ this file — not which found something in it (#755).
   *
   * A file on the surface gets a `FileScore` whether or not any tool ever
   * looked at it, so `findings.length` is the only per-file evidence the
   * report used to carry, and it cannot tell three states apart: the tool
   * ran and found nothing, the tool ran and returned nothing because it
   * broke, and the file genuinely improved. All three are zero findings.
   * This is the reading the count is not.
   */
  scoredBy: ComplianceTool[];
}

/** The external tools Layer 1 scores with, in the order they are reported. */
export const COMPLIANCE_TOOLS = ["agnix", "reporails"] as const;

export type ComplianceTool = (typeof COMPLIANCE_TOOLS)[number];

/** A tool that did not answer, as the report names it. */
export interface UnmeasuredTool {
  /** The tool's name in this report — not the command line it was probed with. */
  tool: ComplianceTool;
  outcome: ToolProbeOutcome;
  /** The probe's own one-liner, carried through unedited. */
  reason: string;
}

/**
 * Whether this report measured what it claims to have measured.
 *
 * A scan that one of its two tools sat out is not a scan with a slightly
 * smaller finding count — it is a scan of an unknown fraction of the surface,
 * and the number it would print is indistinguishable from the number a clean
 * run prints. `UNMEASURED` is the only value that is not.
 */
export interface ComplianceReading {
  reading: "MEASURED" | "UNMEASURED";
  /** Every tool that did not answer, in probe order. Empty exactly when MEASURED. */
  unmeasured: UnmeasuredTool[];
  /** Names every tool that did not answer and why. Null exactly when MEASURED. */
  reason: string | null;
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
  /**
   * The whole probe per tool — outcome and reason, not just the boolean.
   * `toolsAvailable` above is a projection of these and stays for the callers
   * that only ever wanted "can I run this".
   */
  toolProbes: Record<ComplianceTool, ToolProbe>;
  reading: ComplianceReading;
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

/**
 * RepoRails ships only as an npx package here, so every invocation pays a cold
 * `npx` resolve (~8s). Running the surface one file at a time serially put the
 * whole scan at ~257s. These run concurrently instead.
 */
async function runRepoRailsOne(path: string): Promise<RepoRailsOutput | null> {
  try {
    const proc = Bun.spawn(["npx", "@reporails/cli", "check", path, "--format", "json"], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const timer = setTimeout(() => proc.kill(), 60_000);
    try {
      const stdout = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (!stdout) return null;
      return JSON.parse(stdout) as RepoRailsOutput;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** How many RepoRails processes to keep in flight at once. */
export const REPORAILS_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );

  await Promise.all(workers);
  return results;
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
//
// The probe lives in `lib/tool-probe.ts` and has THREE outcomes (#626 AC-10).
// What was here returned `false` for "agnix is not installed", "npx ran and
// failed" and "the registry timed out" alike, which is why #597's CI failures
// could be re-run red to green on an identical SHA with nothing to read that
// said why. `available` below is the same boolean these two call sites always
// wanted — the difference is that it is now a projection of a reading that
// still knows which of the three happened.

/** How each tool is asked whether it is there. */
const COMPLIANCE_TOOL_PROBE_ARGV: Record<ComplianceTool, string[]> = {
  agnix: ["agnix", "--version"],
  reporails: ["npx", "@reporails/cli", "version"],
};

/**
 * The single seam between this module and the outside world (#597).
 *
 * Every availability question Layer 1 asks is asked here, once per tool, and
 * `probeExternalTool` is called from nowhere else in this file — two deciders
 * that agree are behaviourally one, and a second probe would survive any
 * mutation of this one.
 *
 * A caller may supply a reading per tool. That is how a test forces a tool
 * absent or errored without mutating `PATH`, which is both unavailable to a
 * test running in-process and a global mutation that leaks into whatever else
 * the suite is doing. An injected tool overrides; an omitted one still spawns,
 * so the seam cannot silently drop a tool it was not told about.
 */
export function probeComplianceTools(
  injected?: Partial<Record<ComplianceTool, ToolProbe>>,
): Record<ComplianceTool, ToolProbe> {
  const probes = {} as Record<ComplianceTool, ToolProbe>;
  for (const tool of COMPLIANCE_TOOLS) {
    const given = injected?.[tool];
    if (given) {
      probes[tool] = given;
      continue;
    }
    const [command, ...args] = COMPLIANCE_TOOL_PROBE_ARGV[tool];
    probes[tool] = probeExternalTool(command, args);
  }
  return probes;
}

/**
 * Turns the probes into the report's own verdict about itself.
 *
 * One binding, so there is one thing to mutate, and so no branch can decide
 * separately that a report is clean enough to print a number.
 */
export function complianceReading(
  probes: Record<ComplianceTool, ToolProbe>,
): ComplianceReading {
  const unmeasured: UnmeasuredTool[] = [];
  for (const tool of COMPLIANCE_TOOLS) {
    const probe = probes[tool];
    if (probe.available) continue;
    unmeasured.push({ tool, outcome: probe.outcome, reason: probe.reason });
  }

  if (unmeasured.length === 0) {
    return { reading: "MEASURED", unmeasured: [], reason: null };
  }

  // Name every one of them. A warning that does not say what was missing is a
  // warning nobody can act on, and "a tool was unavailable" does not tell an
  // operator whether to install something or to look at a stderr line.
  const named = unmeasured.map(u => `${u.tool} (${u.outcome}): ${u.reason}`).join("; ");
  return {
    reading: "UNMEASURED",
    unmeasured,
    reason:
      `UNMEASURED: ${unmeasured.length} of ${COMPLIANCE_TOOLS.length} compliance tools did not ` +
      `answer — ${named}. The quality score is withheld rather than averaged over the tools ` +
      `that did, because a surface nobody scored has not passed and a number would say it had.`,
  };
}

/**
 * The surface's quality score, or nothing when the reading says nothing was
 * measured.
 *
 * Averaging whatever came back is the shape this exists to refuse: with one
 * tool silent the mean is taken over the files the other tool happened to
 * reach, and it prints as an ordinary number beside an ordinary PASS.
 */
export function overallQualityOf(
  fileScores: FileScore[],
  reading: ComplianceReading,
): number | null {
  if (reading.reading === "UNMEASURED") return null;
  const scored = fileScores.filter(f => f.reporailsQuality !== null);
  if (scored.length === 0) return null;
  return scored.reduce((sum, f) => sum + f.reporailsQuality!, 0) / scored.length;
}

/**
 * The tools that read one file, from a per-tool reading of whether they did.
 *
 * One binding, so a case can mutate the thing that decides coverage rather
 * than a boolean each caller re-derives. The two tools report their having
 * read a file by different routes and neither is a finding count:
 *
 * - agnix is run ONCE over the whole surface, and `runAgnixBatch` returns
 *   `null` when it produced nothing parseable. A batch that parsed read every
 *   file in it, including the clean ones it says nothing about.
 * - RepoRails is run per file and returns a quality score for each, so its
 *   receipt is per file: an entry exists or it does not.
 */
export function scoredByOf(read: Record<ComplianceTool, boolean>): ComplianceTool[] {
  return COMPLIANCE_TOOLS.filter(tool => read[tool]);
}

// ── Layer 1: Template Compliance ───────────────────────────

export interface TemplateComplianceOpts {
  surface?: string[];
  writeReport?: boolean;
  /**
   * Readings to use instead of spawning. Per tool — an omitted tool is still
   * probed for real.
   */
  probes?: Partial<Record<ComplianceTool, ToolProbe>>;
}

export async function runTemplateCompliance(
  root: string,
  opts?: TemplateComplianceOpts,
): Promise<ComplianceReport> {
  const files = collectComplianceSurface(root, opts?.surface);

  const toolProbes = probeComplianceTools(opts?.probes);
  const reading = complianceReading(toolProbes);
  const agnixAvailable = toolProbes.agnix.available;
  const reporailsAvailable = toolProbes.reporails.available;

  // agnix: batch mode works fine for file attribution
  const agnixByFile = new Map<string, AgnixDiagnostic[]>();
  // RepoRails: per-file mode — batch drops findings for small files
  const rrByFile = new Map<string, { quality: number | null; findings: RepoRailsFinding[] }>();

  // Whether the batch answered at all. `agnixAvailable` says the probe found
  // the binary; this says the run over this surface produced a reading.
  let agnixRead = false;

  if (agnixAvailable && files.length > 0) {
    const results = runAgnixBatch(files);
    if (results) {
      agnixRead = true;
      for (const d of results) {
        const key = d.file;
        if (!agnixByFile.has(key)) agnixByFile.set(key, []);
        agnixByFile.get(key)!.push(d);
      }
    }
  }

  if (reporailsAvailable && files.length > 0) {
    const results = await mapWithConcurrency(files, REPORAILS_CONCURRENCY, runRepoRailsOne);
    files.forEach((filePath, i) => {
      const result = results[i];
      if (!result) return;
      rrByFile.set(relative(root, filePath), {
        quality: result.quality,
        findings: Object.values(result.files).flatMap(d => d.findings),
      });
    });
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
      scoredBy: scoredByOf({ agnix: agnixRead, reporails: rrData !== undefined }),
    });
  }

  const totalFindings = fileScores.reduce((sum, f) => sum + f.findings.length, 0);
  const highCount = fileScores.reduce(
    (sum, f) => sum + f.findings.filter(fi => fi.severity === "HIGH").length,
    0,
  );

  const report: ComplianceReport = {
    timestamp: new Date().toISOString(),
    layer: "template",
    surface: files.map(f => relative(root, f)),
    files: fileScores,
    overallQuality: overallQualityOf(fileScores, reading),
    totalFindings,
    highCount,
    toolsAvailable: { agnix: agnixAvailable, reporails: reporailsAvailable },
    toolProbes,
    reading,
  };

  if (opts?.writeReport !== false) {
    const outDir = join(root, ".rungate");
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "compliance-report.json"),
      JSON.stringify(report, null, 2),
    );
  }

  // SC-183 keeps its marker, but only for the state it describes: a tool that
  // ran and failed is not one that is missing, and telling an operator to
  // install something already installed is the advice the collapsed boolean
  // used to give.
  for (const u of reading.unmeasured) {
    if (u.outcome !== "absent") continue;
    console.warn(`WARN TOOL-NOT-INSTALLED-${u.tool}: ${u.reason} — install it, then re-run`);
  }
  if (reading.reason) console.warn(`WARN COMPLIANCE-${reading.reason}`);

  return report;
}

// ── Layer 2: Generated Compliance ──────────────────────────

export async function runGeneratedCompliance(
  root: string,
  baselineReport?: ComplianceReport,
): Promise<ComplianceReport> {
  const report = await runTemplateCompliance(root, { writeReport: false });
  report.layer = "generated";

  if (baselineReport && baselineReport.overallQuality !== null && report.overallQuality !== null) {
    if (report.overallQuality < baselineReport.overallQuality - 0.5) {
      console.error(
        `FAIL: Scaffold degraded instruction quality from ${baselineReport.overallQuality.toFixed(1)} to ${report.overallQuality.toFixed(1)}`
      );
    }
  } else if (baselineReport) {
    // A comparison that could not be made is not a comparison that passed.
    // Both sides are reported, because "which one had no number" is the first
    // thing anyone reading this will want to know.
    console.warn(
      `WARN COMPLIANCE-UNMEASURED: the Layer 2 degradation check did not run — ` +
      `baseline ${baselineReport.reading.reading}/${baselineReport.overallQuality ?? "no score"}, ` +
      `generated ${report.reading.reading}/${report.overallQuality ?? "no score"}` +
      (report.reading.reason ? ` — ${report.reading.reason}` : ""),
    );
  }

  const outDir = join(root, ".rungate");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "compliance-generated.json"),
    JSON.stringify(report, null, 2),
  );

  return report;
}
