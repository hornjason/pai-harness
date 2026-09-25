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
  parseToolCalls,
} from "../lib/transcript-checker.js";
import { analyzeTranscript } from "./analyze-transcript.js";

interface EfficiencyMetrics {
  ratio: number;
  deliverableRatio: number;
  contextGrowthRatio: number;
  duplicateReads: number;
}

interface GradeOutput {
  grades: {
    role: string;
    total: number;
    followed: number;
    flagged?: string[];
    efficiency?: EfficiencyMetrics;
  }[];
}

function loadValidRoles(projectRoot?: string): Set<string> {
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

function inferRole(metaPath: string, transcriptPath: string, validRoles: Set<string>): Role | null {
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

function gradeTranscript(transcriptPath: string, validRoles: Set<string>): GradeOutput["grades"][0] | null {
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

  // Evaluate role-specific criteria
  const results = evaluateCriteria(role, data);
  const total = results.length;
  const followed = results.filter(r => r.verdict === "FOLLOWED").length;
  const flagged: string[] = [];

  // For Marcus, also check TDD
  if (role === "marcus") {
    const tddResult = checkTDD(transcriptContent);
    if (tddResult.verdict !== "TDD") {
      flagged.push(`TDD_SEQUENCE_VIOLATED: ${tddResult.evidence}`);
    }
  }

  // Flag ignored rules
  for (const r of results) {
    if (r.verdict === "IGNORED") {
      flagged.push(`${r.id}: ${r.rule}`);
    }
  }

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
    ...(flagged.length > 0 && { flagged }),
    efficiency,
  };
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

  let skipped = 0;
  for (const transcriptPath of transcriptFiles) {
    const grade = gradeTranscript(transcriptPath, validRoles);
    if (grade) {
      grades.push(grade);
      console.error(`Graded ${basename(transcriptPath)}: ${grade.role} - ${grade.followed}/${grade.total}`);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(`Skipped ${skipped} agent(s) — no matching role in config`);
  }

  const output: GradeOutput = { grades };
  const outputPath = join(workDir, "compliance-grade.json");
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(JSON.stringify(output, null, 2));
  console.error(`\nWrote compliance-grade.json to ${outputPath}`);
}

if (import.meta.main) {
  main();
}
