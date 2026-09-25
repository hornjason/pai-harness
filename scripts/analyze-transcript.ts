#!/usr/bin/env bun
/**
 * Transcript analyzer — efficiency metrics from agent transcripts.
 *
 * Usage:
 *   bun scripts/analyze-transcript.ts <transcript-dir> [--role marcus]
 *   bun scripts/analyze-transcript.ts <transcript-dir> --all
 *
 * Reads agent-*.jsonl transcripts and produces:
 * - File efficiency (read vs used)
 * - Tool call breakdown
 * - Test run count
 * - Context growth
 * - Rule compliance vs behavior
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";

interface ToolCall {
  name: string;
  input: Record<string, any>;
  turn: number;
}

export interface TranscriptAnalysis {
  agent: string;
  role: string;
  toolCalls: {
    total: number;
    reads: number;
    bashes: number;
    edits: number;
    writes: number;
    other: number;
  };
  efficiency: {
    filesRead: string[];
    filesChanged: string[];
    filesWasted: string[];
    ratio: number;
  };
  testRuns: {
    full: string[];
    targeted: string[];
    total: number;
  };
  bashInsteadOfRead: string[];
  duplicateReads: Record<string, number>;
  context: {
    startTokens: number;
    endTokens: number;
    growthRatio: number;
    turns: number;
  };
  readOrder: { file: string; used: boolean }[];
  deliverableRatio: number;
}

function parseToolCalls(transcriptPath: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let turn = 0;
  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "assistant") {
        turn++;
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              calls.push({ name: block.name, input: block.input || {}, turn });
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }
  return calls;
}

function parseContextGrowth(transcriptPath: string): { start: number; end: number; turns: number } {
  const sizes: number[] = [];
  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      const usage = d.usage || d.message?.usage;
      if (usage && "input_tokens" in usage) {
        const total = (usage.input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0);
        sizes.push(total);
      }
    } catch { /* skip */ }
  }
  return {
    start: sizes[0] || 0,
    end: sizes[sizes.length - 1] || 0,
    turns: sizes.length,
  };
}

function inferRole(metaPath: string): string {
  if (!existsSync(metaPath)) return "unknown";
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    return meta.description || meta.label || "unknown";
  } catch { return "unknown"; }
}

export function analyzeTranscript(transcriptPath: string): TranscriptAnalysis {
  const metaPath = transcriptPath.replace(".jsonl", ".meta.json");
  const role = inferRole(metaPath);
  const calls = parseToolCalls(transcriptPath);
  const ctx = parseContextGrowth(transcriptPath);

  const reads: string[] = [];
  const bashes: string[] = [];
  const editPaths: string[] = [];
  const writePaths: string[] = [];
  let otherCount = 0;

  for (const call of calls) {
    switch (call.name) {
      case "Read": reads.push(call.input.file_path || ""); break;
      case "Bash": bashes.push(call.input.command || ""); break;
      case "Edit": editPaths.push(call.input.file_path || ""); break;
      case "Write": writePaths.push(call.input.file_path || ""); break;
      default: otherCount++; break;
    }
  }

  const readFiles = [...new Set(reads.map(r => basename(r)).filter(Boolean))];
  const changedFiles = [...new Set([...editPaths, ...writePaths].map(f => basename(f)).filter(Boolean))];
  const wastedFiles = readFiles.filter(f => !changedFiles.includes(f));

  // Duplicate reads
  const readCounts: Record<string, number> = {};
  for (const r of reads) {
    const name = basename(r);
    readCounts[name] = (readCounts[name] || 0) + 1;
  }
  const dupes: Record<string, number> = {};
  for (const [k, v] of Object.entries(readCounts)) {
    if (v > 1) dupes[k] = v;
  }

  // Bash instead of Read
  const bashReads = bashes.filter(c =>
    /\bcat\b|\bhead\b|\btail\b/.test(c) && !c.includes("bun test")
  );

  // Test runs
  const fullTests = bashes.filter(c => /bun test\b/.test(c) && !/--grep/.test(c) && !/test\//.test(c));
  const targetedTests = bashes.filter(c => /bun test\b/.test(c) && (/test\//.test(c) || /--grep/.test(c)));

  // Read order with usage tracking
  const readOrder = reads.map(r => ({
    file: basename(r),
    used: changedFiles.includes(basename(r)),
  }));

  // Deliverable ratio: Write+Edit calls / total calls
  const deliverableCalls = editPaths.length + writePaths.length;
  const deliverableRatio = calls.length > 0 ? deliverableCalls / calls.length : 0;

  return {
    agent: basename(transcriptPath),
    role,
    toolCalls: {
      total: calls.length,
      reads: reads.length,
      bashes: bashes.length,
      edits: editPaths.length,
      writes: writePaths.length,
      other: otherCount,
    },
    efficiency: {
      filesRead: readFiles,
      filesChanged: changedFiles,
      filesWasted: wastedFiles,
      ratio: readFiles.length > 0 ? changedFiles.length / readFiles.length : 1,
    },
    testRuns: {
      full: fullTests,
      targeted: targetedTests,
      total: fullTests.length + targetedTests.length,
    },
    bashInsteadOfRead: bashReads,
    duplicateReads: dupes,
    context: {
      startTokens: ctx.start,
      endTokens: ctx.end,
      growthRatio: ctx.start > 0 ? ctx.end / ctx.start : 0,
      turns: ctx.turns,
    },
    readOrder,
    deliverableRatio,
  };
}

function formatReport(analysis: TranscriptAnalysis): string {
  const lines: string[] = [];
  const a = analysis;

  lines.push(`═══ ${a.role} (${a.agent}) ═══`);
  lines.push("");

  // Tool calls
  lines.push(`TOOL CALLS: ${a.toolCalls.total}`);
  lines.push(`  Read: ${a.toolCalls.reads}, Bash: ${a.toolCalls.bashes}, Edit: ${a.toolCalls.edits}, Write: ${a.toolCalls.writes}`);
  lines.push("");

  // Efficiency
  const pct = Math.round(a.efficiency.ratio * 100);
  lines.push(`FILE EFFICIENCY: ${pct}% (${a.efficiency.filesChanged.length} used / ${a.efficiency.filesRead.length} read)`);
  lines.push(`  Changed: ${a.efficiency.filesChanged.join(", ") || "none"}`);
  if (a.efficiency.filesWasted.length > 0) {
    lines.push(`  Wasted:  ${a.efficiency.filesWasted.join(", ")}`);
  }
  lines.push("");

  // Deliverable ratio
  lines.push(`DELIVERABLE RATIO: ${Math.round(a.deliverableRatio * 100)}% of tool calls produced output`);
  lines.push("");

  // Test runs
  lines.push(`TEST RUNS: ${a.testRuns.total} (${a.testRuns.full.length} full suite, ${a.testRuns.targeted.length} targeted)`);
  lines.push("");

  // Context growth
  if (a.context.startTokens > 0) {
    lines.push(`CONTEXT: ${a.context.startTokens.toLocaleString()} → ${a.context.endTokens.toLocaleString()} tokens (${Math.round((a.context.growthRatio - 1) * 100)}% growth, ${a.context.turns} turns)`);
    lines.push("");
  }

  // Violations
  if (a.bashInsteadOfRead.length > 0) {
    lines.push(`BASH INSTEAD OF READ: ${a.bashInsteadOfRead.length}`);
    for (const c of a.bashInsteadOfRead) lines.push(`  → ${c.slice(0, 80)}`);
    lines.push("");
  }

  if (Object.keys(a.duplicateReads).length > 0) {
    lines.push(`DUPLICATE READS:`);
    for (const [f, c] of Object.entries(a.duplicateReads)) lines.push(`  ${f}: ${c}x`);
    lines.push("");
  }

  // Read order
  lines.push(`READ ORDER:`);
  for (let i = 0; i < a.readOrder.length; i++) {
    const r = a.readOrder[i];
    const marker = r.used ? "✓ used  " : "✗ UNUSED";
    lines.push(`  ${(i + 1).toString().padStart(2)}. [${marker}] ${r.file}`);
  }

  return lines.join("\n");
}

// ── Main ──

const args = process.argv.slice(2);
// Parse flags that take values
const outputIdx = args.indexOf("--output");
const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
const roleFilter = args.find(a => a.startsWith("--role="))?.split("=")[1];
const showAll = args.includes("--all");
const jsonOutput = args.includes("--json");
// Positional arg is the transcript dir — skip flag values
const skipIndices = new Set<number>();
if (outputIdx >= 0) { skipIndices.add(outputIdx); skipIndices.add(outputIdx + 1); }
const transcriptDir = args.find((a, i) => !a.startsWith("--") && !skipIndices.has(i));

if (!transcriptDir) {
  console.error("Usage: bun scripts/analyze-transcript.ts <transcript-dir> [--role=marcus] [--all] [--json]");
  process.exit(1);
}

if (!existsSync(transcriptDir)) {
  console.error(`Directory not found: ${transcriptDir}`);
  process.exit(1);
}

const transcripts = readdirSync(transcriptDir)
  .filter(f => f.startsWith("agent-") && f.endsWith(".jsonl"))
  .map(f => join(transcriptDir, f));

if (transcripts.length === 0) {
  console.error("No agent-*.jsonl files found");
  process.exit(1);
}

const analyses: TranscriptAnalysis[] = [];

for (const t of transcripts) {
  const a = analyzeTranscript(t);
  if (roleFilter && a.role !== roleFilter) continue;
  if (!showAll && !roleFilter) {
    // Default: only show known implementation roles
    const known = ["marcus", "quinn", "discovery", "rook", "serena", "aditi"];
    if (!known.includes(a.role)) continue;
  }
  analyses.push(a);
}

if (jsonOutput) {
  const jsonStr = JSON.stringify(analyses, null, 2);
  console.log(jsonStr);

  // Write transcript-analysis.json if --output dir specified
  if (outputDir) {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "transcript-analysis.json"), jsonStr);
    console.error(`Wrote transcript-analysis.json to ${outputDir}`);
  }
} else {
  if (analyses.length === 0) {
    console.log("No matching agents found. Use --all to show all agents.");
  }
  for (const a of analyses) {
    console.log(formatReport(a));
    console.log("");
  }

  // Summary if multiple agents
  if (analyses.length > 1) {
    const totalCalls = analyses.reduce((n, a) => n + a.toolCalls.total, 0);
    const totalRead = analyses.reduce((n, a) => n + a.efficiency.filesRead.length, 0);
    const totalUsed = analyses.reduce((n, a) => n + a.efficiency.filesChanged.length, 0);
    const avgEfficiency = totalRead > 0 ? Math.round((totalUsed / totalRead) * 100) : 0;
    const avgDeliverable = Math.round(analyses.reduce((n, a) => n + a.deliverableRatio, 0) / analyses.length * 100);

    console.log(`═══ SUMMARY (${analyses.length} agents) ═══`);
    console.log(`  Total tool calls: ${totalCalls}`);
    console.log(`  Avg file efficiency: ${avgEfficiency}%`);
    console.log(`  Avg deliverable ratio: ${avgDeliverable}%`);
  }
}
