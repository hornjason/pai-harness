#!/usr/bin/env bun
/**
 * Observability Phase 0: Validate evaluateCriteria() against real transcripts.
 *
 * Runs the scorer on 5 historical transcripts and outputs results for human review.
 * Council decision D-5: no auto-healing until scorer matches human judgment.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { parseTranscript, type AgentAudit } from "../scripts/audit-transcript.js";
import { evaluateCriteria, type Role, type TranscriptData, type ToolCall } from "../lib/eval-criteria.js";

const SESSION_DIR = process.env.HOME + "/.claude/projects/-Users-jhorn";

function findTranscripts(minLines = 50, limit = 10): string[] {
  const results: string[] = [];
  try {
    const sessions = readdirSync(SESSION_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(SESSION_DIR, d.name, "subagents"))
      .filter(p => existsSync(p));

    for (const subDir of sessions) {
      const files = readdirSync(subDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => join(subDir, f));
      for (const f of files) {
        try {
          const lines = readFileSync(f, "utf-8").split("\n").filter(Boolean).length;
          if (lines >= minLines) results.push(f);
        } catch { /* skip */ }
      }
      if (results.length >= limit) break;
    }
  } catch { /* skip */ }
  return results.slice(0, limit);
}

function detectRole(calls: ToolCall[], filename: string): Role {
  const fn = filename.toLowerCase();
  if (fn.includes("marcus") || fn.includes("impl") || fn.includes("fix")) return "marcus";
  if (fn.includes("quinn") || fn.includes("validate") || fn.includes("test")) return "quinn";
  if (fn.includes("da-") || fn.includes("session")) return "da";

  const hasEdits = calls.some(c => c.name === "Edit" || c.name === "Write");
  const hasBunTest = calls.some(c => c.name === "Bash" && JSON.stringify(c.input).includes("bun test"));
  if (hasBunTest && !hasEdits) return "quinn";
  if (hasEdits) return "marcus";
  return "da";
}

/**
 * Concatenate the user-authored turns of a transcript.
 *
 * Several criteria in evaluateCriteria() ask whether a file was *injected* into
 * the prompt rather than read by the agent, which they answer off
 * `TranscriptData.promptContent`. Passing it empty (or passing the raw JSONL,
 * which also carries the agent's own output) would have scored those criteria
 * against text the agent never received.
 */
function extractPromptContent(transcriptContent: string): string {
  const parts: string[] = [];
  for (const line of transcriptContent.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "human" && entry.type !== "user" && entry.role !== "user") continue;
      const content = entry.message?.content ?? entry.content ?? "";
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        parts.push(
          content
            .filter((b: { type?: string }) => b.type === "text")
            .map((b: { text?: string }) => b.text ?? "")
            .join("\n"),
        );
      }
    } catch { /* skip */ }
  }
  return parts.join("\n");
}

function buildTranscriptData(calls: ToolCall[], promptContent: string): TranscriptData {
  const reads = calls.filter(c => c.name === "Read").map(c => c.input.file_path || "");
  const bashes = calls.filter(c => c.name === "Bash").map(c => c.input.command || "");
  const edits = calls.filter(c => c.name === "Edit").map(c => c.input.file_path || "");
  const writes = calls.filter(c => c.name === "Write").map(c => c.input.file_path || "");

  const readCounts: Record<string, number> = {};
  for (const r of reads) {
    readCounts[r] = (readCounts[r] || 0) + 1;
  }
  const duplicateReads: Record<string, number> = {};
  for (const [path, count] of Object.entries(readCounts)) {
    if (count > 1) duplicateReads[path] = count;
  }

  return {
    calls,
    reads,
    bashes,
    edits,
    writes,
    duplicateReads,
    firstThreeReads: reads.slice(0, 3),
    promptContent,
  };
}

// Find transcripts
const transcripts = findTranscripts(50, 10);
if (transcripts.length === 0) {
  console.error("No transcripts found with >= 50 lines");
  process.exit(1);
}

// Pick 5 diverse transcripts
const selected = transcripts.slice(0, 5);

console.log("═══ Observability Phase 0: Scorer Validation ═══\n");
console.log(`Found ${transcripts.length} transcripts, validating ${selected.length}:\n`);

const results: Array<{
  file: string;
  role: Role;
  totalCalls: number;
  score: number;
  criteria: Array<{ id: string; rule: string; verdict: string; evidence: string; weight: number }>;
}> = [];

for (const file of selected) {
  const calls = parseTranscript(file);
  const role = detectRole(calls, basename(file));
  const data = buildTranscriptData(calls, extractPromptContent(readFileSync(file, "utf-8")));
  const criteria = evaluateCriteria(role, data);

  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  const passedWeight = criteria.filter(c => c.verdict === "FOLLOWED").reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 100) : 0;

  results.push({
    file: basename(file),
    role,
    totalCalls: calls.length,
    score,
    criteria,
  });

  console.log(`── ${basename(file)} ──`);
  console.log(`   Role: ${role} | Calls: ${calls.length} | Score: ${score}%`);
  for (const c of criteria) {
    const icon = c.verdict === "FOLLOWED" ? "✓" : "✗";
    console.log(`   ${icon} ${c.id} (${c.weight}w): ${c.rule}`);
    console.log(`     → ${c.evidence}`);
  }
  console.log();
}

console.log("═══ Summary ═══\n");
console.log("| Transcript | Role | Calls | Score |");
console.log("|------------|------|-------|-------|");
for (const r of results) {
  console.log(`| ${r.file.slice(0, 40)} | ${r.role} | ${r.totalCalls} | ${r.score}% |`);
}

console.log("\n═══ Human Review Required ═══");
console.log("For each transcript above, verify:");
console.log("1. Does the ROLE detection match what the agent actually did?");
console.log("2. Do FOLLOWED/IGNORED verdicts match your judgment?");
console.log("3. Are there false positives (scored well but agent was bad)?");
console.log("4. Are there false negatives (scored poorly but agent was fine)?");
console.log("\nIf scorer matches human judgment on 4/5+ transcripts, Phase 0 passes.");
