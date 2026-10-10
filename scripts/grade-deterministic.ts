#!/usr/bin/env bun
/**
 * Deterministic agent compliance grading.
 * Replaces LLM-based grading in ship.js GRADE phase.
 *
 * Usage: bun scripts/grade-deterministic.ts <work-dir>
 *
 * Reads agent transcripts from <work-dir>, evaluates compliance against
 * role-specific criteria, and writes compliance-grade.json.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import {
  type TranscriptData,
  type Role,
  evaluateCriteria,
  checkTDD,
  checkCompliance,
  parseToolCalls,
} from "../lib/transcript-checker.js";
import { extractDirectives } from "../lib/directive-extractor.js";
import type { DirectiveCategory } from "../lib/directive-extractor.js";
import { analyzeTranscript } from "./analyze-transcript.js";

interface EfficiencyMetrics {
  ratio: number;
  deliverableRatio: number;
  contextGrowthRatio: number;
  duplicateReads: number;
}

interface RuleResult {
  id: string;
  rule: string;
  verdict: string;
  evidence: string;
  category?: DirectiveCategory;
}

/**
 * A duration is only ever reported when the run itself recorded it (#227).
 * `measured: false` means the call site produced no timing record — it does
 * NOT mean the agent took no time, which is what the file-timestamp
 * derivation this replaced silently implied for every unrecorded call.
 */
export interface TimingEntry {
  role: string;
  /** Stable call-site label, the key into the run timing artifact. */
  label: string;
  measured: boolean;
  durationSeconds?: number;
}

/** Written into the run's work dir by the orchestrator; keyed by call-site label. */
export const RUN_TIMING_FILENAME = "run-timing.json";

interface RunTimingCall {
  label?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationSeconds?: unknown;
}

export interface GradeOutput {
  grades: {
    role: string;
    /**
     * The call site this grade is about (#240).
     *
     * `role` alone is not an identity. Run wf_18abb197-f03 produced four
     * `marcus` grades and one of them carried a BLOCKING violation; finding
     * out which agent was accused meant re-running `checkTDD` over each
     * transcript by hand. A refusal has to name what it refuses.
     */
    label: string;
    total: number;
    followed: number;
    rules: RuleResult[];
    flagged?: string[];
    efficiency?: EfficiencyMetrics;
  }[];
  timing?: TimingEntry[];
  canary?: { total: number; triggered: number; results: { id: string; phrase: string; triggered: boolean }[] };
}

export function loadValidRoles(projectRoot?: string): Set<string> {
  const configPaths = [
    projectRoot ? join(projectRoot, ".claude", "rungate.json") : "",
    join(process.cwd(), ".claude", "rungate.json"),
  ].filter(Boolean);
  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        const config = JSON.parse(readFileSync(p, "utf-8"));
        if (config.roles) return new Set(Object.keys(config.roles));
      } catch { /* fall through */ }
    }
  }
  return new Set(["marcus", "quinn", "discovery", "rook", "serena", "aditi", "da"]);
}

export function loadRoleBriefPaths(projectRoot: string): Record<string, string> {
  const configPath = join(projectRoot, ".claude", "rungate.json");
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const result: Record<string, string> = {};
    if (config.roles) {
      for (const [name, roleConfig] of Object.entries(config.roles)) {
        const brief = (roleConfig as Record<string, unknown>).brief;
        if (typeof brief === "string") {
          result[name] = join(projectRoot, brief);
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function inferRole(metaPath: string, transcriptPath: string, validRoles: Set<string>): Role | null {
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const label = (meta.label || meta.description || "").toLowerCase();
      for (const role of validRoles) {
        if (label === role || label.startsWith(`${role}-`)) return role as Role;
      }
      const agentType = (meta.agentType || "").toLowerCase();
      for (const role of validRoles) {
        if (agentType === role) return role as Role;
      }
    } catch { /* fall through */ }
  }
  return null;
}

function extractPromptContent(transcriptContent: string): string {
  const parts: string[] = [];
  for (const line of transcriptContent.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "human" || entry.type === "user" || entry.role === "user") {
        const content = entry.message?.content || entry.content || "";
        if (typeof content === "string") {
          parts.push(content);
        } else if (Array.isArray(content)) {
          parts.push(content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
        }
      }
    } catch { /* skip */ }
  }
  return parts.join("\n");
}

function buildTranscriptData(calls: any[], promptContent: string): TranscriptData {
  const reads: string[] = [];
  const bashes: string[] = [];
  const edits: string[] = [];
  const writes: string[] = [];

  for (const call of calls) {
    switch (call.name) {
      case "Read":
        reads.push(call.input.file_path || "");
        break;
      case "Bash":
        bashes.push(call.input.command || "");
        break;
      case "Edit":
        edits.push(call.input.file_path || "");
        break;
      case "Write":
        writes.push(call.input.file_path || "");
        break;
    }
  }

  // Calculate duplicate reads
  const readCounts: Record<string, number> = {};
  for (const r of reads) {
    readCounts[r] = (readCounts[r] || 0) + 1;
  }
  const duplicateReads: Record<string, number> = {};
  for (const [path, count] of Object.entries(readCounts)) {
    if (count > 1) duplicateReads[path] = count;
  }

  const firstThreeReads = reads.slice(0, 3).map(r => basename(r));

  return {
    calls,
    reads,
    bashes,
    edits,
    writes,
    duplicateReads,
    firstThreeReads,
    promptContent,
  };
}

export function gradeTranscript(transcriptPath: string, validRoles: Set<string>, projectRoot?: string): GradeOutput["grades"][0] | null {
  const metaPath = transcriptPath.replace(".jsonl", ".meta.json");
  const role = inferRole(metaPath, transcriptPath, validRoles);
  if (!role) return null;

  let transcriptContent: string;
  try {
    transcriptContent = readFileSync(transcriptPath, "utf-8");
  } catch (err) {
    console.error(`Failed to read transcript ${transcriptPath}:`, err);
    return null;
  }

  const calls = parseToolCalls(transcriptContent);
  const promptContent = extractPromptContent(transcriptContent);
  const data = buildTranscriptData(calls, promptContent);

  const flagged: string[] = [];
  const rules: RuleResult[] = [];

  // For Marcus, also check TDD (behavioral — not directive-based)
  if (role === "marcus") {
    const tddResult = checkTDD(transcriptContent);
    const tddRule = "Write failing test before implementation (TDD)";
    if (tddResult.verdict === "TDD") {
      rules.push({ id: "COMP-13", rule: tddRule, verdict: "FOLLOWED", evidence: tddResult.evidence });
    } else if (tddResult.verdict === "NO_TESTS" || tddResult.verdict === "NO_SOURCE") {
      rules.push({ id: "COMP-13", rule: tddRule, verdict: "N/A", evidence: tddResult.evidence });
    } else {
      flagged.push(`TDD_SEQUENCE_VIOLATED: ${tddResult.evidence}`);
      rules.push({ id: "COMP-13", rule: tddRule, verdict: "IGNORED", evidence: tddResult.evidence });
    }
  }

  // Directive-based grading: extract directives from the role's brief and check compliance
  if (projectRoot) {
    const briefPaths = loadRoleBriefPaths(projectRoot);
    const briefPath = briefPaths[role];
    if (briefPath && existsSync(briefPath)) {
      const briefContent = readFileSync(briefPath, "utf-8");
      const directives = extractDirectives(briefContent);
      const complianceResults = checkCompliance(directives, transcriptContent);

      for (const cr of complianceResults) {
        const verdict = cr.status === "N/A" ? "N/A" : cr.status;
        rules.push({
          id: `DIR-L${cr.directive.line}`,
          rule: cr.directive.text,
          verdict,
          evidence: cr.evidence,
          category: cr.directive.category,
        });
        if (verdict === "IGNORED" || verdict === "VIOLATED") {
          flagged.push(`DIR-L${cr.directive.line}: ${cr.directive.text}`);
        }
      }
    }
  }

  // Always run hardcoded COMP checks — they have mechanical precision
  // Directive-based checks supplement but don't replace COMP checks
  const compResults = evaluateCriteria(role, data);
  const existingIds = new Set(rules.map(r => r.id));
  for (const r of compResults) {
    if (!existingIds.has(r.id)) {
      rules.push({ id: r.id, rule: r.rule, verdict: r.verdict, evidence: r.evidence });
      if (r.verdict === "IGNORED") {
        flagged.push(`${r.id}: ${r.rule}`);
      }
    }
  }

  const checkableRules = rules.filter(r => r.verdict !== "N/A");
  const total = checkableRules.length;
  const followed = checkableRules.filter(r => r.verdict === "FOLLOWED").length;

  // Compute efficiency metrics from transcript analysis
  const analysis = analyzeTranscript(transcriptPath);
  const efficiency: EfficiencyMetrics = {
    ratio: analysis.efficiency.ratio,
    deliverableRatio: analysis.deliverableRatio,
    contextGrowthRatio: analysis.context.growthRatio,
    duplicateReads: Object.keys(analysis.duplicateReads).length,
  };

  return {
    role,
    label: callSiteLabel(metaPath, transcriptPath),
    total,
    followed,
    rules,
    ...(flagged.length > 0 && { flagged }),
    efficiency,
  };
}

/**
 * The call-site label a transcript belongs to. The orchestrator stamps it into
 * the transcript's meta.json; the filename is the fallback for transcripts
 * written before the label was recorded.
 */
export function callSiteLabel(metaPath: string, transcriptPath: string): string {
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      for (const key of ["label", "name"]) {
        const value = meta[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch { /* fall through to the filename */ }
  }
  return basename(transcriptPath).replace(/\.jsonl$/, "").replace(/^agent-/, "");
}

/**
 * Read the run timing artifact into a label → seconds map.
 *
 * A call site is in the map ONLY when the artifact carries a usable duration
 * for it. A missing file, unparseable JSON, or an entry whose timestamps do
 * not parse all yield absence — never a zero — so an unrecorded call site
 * cannot be mistaken for an instant one.
 */
export function loadRunTiming(artifactPath: string): Map<string, number> {
  const durations = new Map<string, number>();
  if (!existsSync(artifactPath)) return durations;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf-8"));
  } catch (err) {
    console.error(`Run timing artifact ${artifactPath} is unreadable — all call sites report unmeasured:`, err);
    return durations;
  }

  const calls: RunTimingCall[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { calls?: unknown })?.calls)
      ? (parsed as { calls: RunTimingCall[] }).calls
      : [];

  for (const call of calls) {
    const label = typeof call?.label === "string" ? call.label.trim() : "";
    if (!label) continue;

    const seconds = callDurationSeconds(call);
    if (seconds === null) continue;
    durations.set(label, seconds);
  }
  return durations;
}

function callDurationSeconds(call: RunTimingCall): number | null {
  const started = Date.parse(String(call.startedAt));
  const ended = Date.parse(String(call.endedAt));
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    return Math.round((ended - started) / 1000);
  }
  const explicit = call.durationSeconds;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return Math.round(explicit);
  }
  return null;
}

export function buildTimingEntry(role: string, label: string, durations: Map<string, number>): TimingEntry {
  const durationSeconds = durations.get(label);
  if (durationSeconds === undefined) return { role, label, measured: false };
  return { role, label, measured: true, durationSeconds };
}

function main() {
  const rawArgs = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--transcripts" && rawArgs[i + 1]) {
      flags.transcripts = rawArgs[++i];
    } else if (rawArgs[i] === "--project" && rawArgs[i + 1]) {
      flags.project = rawArgs[++i];
    } else if (rawArgs[i] === "--timing" && rawArgs[i + 1]) {
      flags.timing = rawArgs[++i];
    } else {
      positional.push(rawArgs[i]);
    }
  }

  const workDir = positional[0];

  if (!workDir) {
    console.error("Usage: bun scripts/grade-deterministic.ts [--transcripts <dir>] [--project <root>] [--timing <file>] <work-dir>");
    process.exit(1);
  }

  if (!existsSync(workDir)) {
    console.error(`Work directory does not exist: ${workDir}`);
    process.exit(1);
  }

  const validRoles = loadValidRoles(flags.project);
  console.error(`Valid roles: ${[...validRoles].join(", ")}`);

  // Look for agent transcript files
  const possibleDirs = [
    flags.transcripts,
    workDir,
    join(workDir, "subagents"),
    join(workDir, "transcripts"),
  ].filter(Boolean) as string[];

  let transcriptFiles: string[] = [];
  let transcriptDir = workDir;

  for (const dir of possibleDirs) {
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f =>
        f.startsWith("agent-") && f.endsWith(".jsonl")
      );
      if (files.length > 0) {
        transcriptFiles = files.map(f => join(dir, f));
        transcriptDir = dir;
        break;
      }
    }
  }

  if (transcriptFiles.length === 0) {
    console.error(`No agent-*.jsonl transcript files found in ${workDir} or subdirectories`);
    // Write empty grade result so workflow can continue
    const emptyGrade: GradeOutput = { grades: [] };
    const outputPath = join(workDir, "compliance-grade.json");
    writeFileSync(outputPath, JSON.stringify(emptyGrade, null, 2));
    console.log("Wrote empty compliance-grade.json (no transcripts found)");
    process.exit(0);
  }

  console.error(`Found ${transcriptFiles.length} transcript(s) in ${transcriptDir}`);

  const grades: GradeOutput["grades"] = [];
  const timing: TimingEntry[] = [];

  const timingPath = flags.timing || join(workDir, RUN_TIMING_FILENAME);
  const durations = loadRunTiming(timingPath);
  console.error(
    durations.size > 0
      ? `Run timing artifact ${timingPath}: ${durations.size} call site(s) measured`
      : `No run timing artifact at ${timingPath} — every call site reports unmeasured`
  );

  let skipped = 0;
  for (const transcriptPath of transcriptFiles) {
    const grade = gradeTranscript(transcriptPath, validRoles, flags.project);
    if (grade) {
      grades.push(grade);
      const label = callSiteLabel(transcriptPath.replace(".jsonl", ".meta.json"), transcriptPath);
      const entry = buildTimingEntry(grade.role, label, durations);
      timing.push(entry);
      console.error(
        `Graded ${basename(transcriptPath)}: ${grade.role} - ${grade.followed}/${grade.total}` +
        ` (${entry.measured ? `${entry.durationSeconds}s` : "unmeasured"})`
      );
    } else {
      skipped++;
    }
  }

  const unmeasured = timing.filter(t => !t.measured);
  if (unmeasured.length > 0) {
    console.error(`UNMEASURED: ${unmeasured.length}/${timing.length} graded call site(s) have no timing record: ${unmeasured.map(t => t.label).join(", ")}`);
  }
  if (skipped > 0) {
    console.error(`Skipped ${skipped} agent(s) — no matching role in config`);
  }

  // Check canary phrases if canaries.json exists
  let canaryResult: GradeOutput["canary"] = undefined;
  const canaryPath = join(workDir, "canaries.json");
  if (existsSync(canaryPath)) {
    try {
      const planted = JSON.parse(readFileSync(canaryPath, "utf-8"));
      const allTranscriptText = transcriptFiles.map(f => readFileSync(f, "utf-8")).join("\n");
      const results = planted.map((c: any) => ({
        id: c.id,
        phrase: c.phrase,
        triggered: allTranscriptText.includes(c.phrase),
      }));
      canaryResult = {
        total: results.length,
        triggered: results.filter((r: any) => r.triggered).length,
        results,
      };
      console.error(`Canary check: ${canaryResult.triggered}/${canaryResult.total} triggered`);
    } catch { /* canary check is best-effort */ }
  }

  const output: GradeOutput = { grades, timing, canary: canaryResult };
  const outputPath = join(workDir, "compliance-grade.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify(output, null, 2));
  console.error(`\nWrote compliance-grade.json to ${outputPath}`);
}

if (import.meta.main) {
  main();
}
