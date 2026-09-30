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

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "fs";
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

interface TimingEntry {
  role: string;
  durationSeconds: number;
}

export interface GradeOutput {
  grades: {
    role: string;
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
  for (const line of transcriptContent.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "human" || entry.type === "user" || entry.role === "user") {
        const content = entry.message?.content || entry.content || "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        }
      }
    } catch { /* skip */ }
  }
  return "";
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
    if (tddResult.verdict !== "TDD") {
      flagged.push(`TDD_SEQUENCE_VIOLATED: ${tddResult.evidence}`);
      rules.push({ id: "COMP-13", rule: "Write failing test before implementation (TDD)", verdict: "IGNORED", evidence: tddResult.evidence });
    } else {
      rules.push({ id: "COMP-13", rule: "Write failing test before implementation (TDD)", verdict: "FOLLOWED", evidence: tddResult.evidence });
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
    total,
    followed,
    rules,
    ...(flagged.length > 0 && { flagged }),
    efficiency,
  };
}

function computeTiming(transcriptPath: string, role: string): TimingEntry {
  const stats = statSync(transcriptPath);
  const durationMs = stats.mtime.getTime() - stats.birthtime.getTime();
  const durationSeconds = Math.max(0, Math.round(durationMs / 1000));
  return { role, durationSeconds };
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
    } else {
      positional.push(rawArgs[i]);
    }
  }

  const workDir = positional[0];

  if (!workDir) {
    console.error("Usage: bun scripts/grade-deterministic.ts [--transcripts <dir>] [--project <root>] <work-dir>");
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

  let skipped = 0;
  for (const transcriptPath of transcriptFiles) {
    const grade = gradeTranscript(transcriptPath, validRoles, flags.project);
    if (grade) {
      grades.push(grade);
      timing.push(computeTiming(transcriptPath, grade.role));
      console.error(`Graded ${basename(transcriptPath)}: ${grade.role} - ${grade.followed}/${grade.total}`);
    } else {
      skipped++;
    }
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
