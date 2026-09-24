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

interface GradeOutput {
  grades: {
    role: string;
    total: number;
    followed: number;
    flagged?: string[];
  }[];
}

function inferRole(metaPath: string, transcriptPath: string): Role {
  // Try to read meta file first
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      const agentType = (meta.agentType || meta.description || "").toLowerCase();
      if (agentType.includes("da") || agentType.includes("orchestrat")) return "da";
      if (agentType.includes("quinn") || agentType.includes("valid") || agentType.includes("qa")) return "quinn";
      if (agentType.includes("marcus") || agentType.includes("impl") || agentType.includes("code")) return "marcus";
    } catch {
      // Fall through to filename-based inference
    }
  }

  // Infer from filename
  const filename = basename(transcriptPath).toLowerCase();
  if (filename.includes("da") || filename.includes("orchestrat")) return "da";
  if (filename.includes("quinn") || filename.includes("valid") || filename.includes("qa")) return "quinn";
  return "marcus"; // Default to marcus for code-related agents
}

function buildTranscriptData(calls: any[]): TranscriptData {
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
  };
}

function gradeTranscript(transcriptPath: string): GradeOutput["grades"][0] | null {
  const metaPath = transcriptPath.replace(".jsonl", ".meta.json");
  const role = inferRole(metaPath, transcriptPath);

  let transcriptContent: string;
  try {
    transcriptContent = readFileSync(transcriptPath, "utf-8");
  } catch (err) {
    console.error(`Failed to read transcript ${transcriptPath}:`, err);
    return null;
  }

  const calls = parseToolCalls(transcriptContent);
  const data = buildTranscriptData(calls);

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

  return {
    role,
    total,
    followed,
    ...(flagged.length > 0 && { flagged }),
  };
}

function main() {
  const args = process.argv.slice(2);
  const workDir = args[0];

  if (!workDir) {
    console.error("Usage: bun scripts/grade-deterministic.ts <work-dir>");
    process.exit(1);
  }

  if (!existsSync(workDir)) {
    console.error(`Work directory does not exist: ${workDir}`);
    process.exit(1);
  }

  // Look for agent transcript files
  // Try multiple possible locations
  const possibleDirs = [
    workDir,
    join(workDir, "subagents"),
    join(workDir, "transcripts"),
  ];

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

  for (const transcriptPath of transcriptFiles) {
    const grade = gradeTranscript(transcriptPath);
    if (grade) {
      grades.push(grade);
      console.error(`Graded ${basename(transcriptPath)}: ${grade.role} - ${grade.followed}/${grade.total}`);
    }
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
