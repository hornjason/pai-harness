#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename, resolve } from "path";

interface ToolCall {
  name: string;
  input: Record<string, any>;
  order: number;
}

interface AgentAudit {
  agentId: string;
  label: string;
  phase: string;
  toolCalls: ToolCall[];
  reads: string[];
  duplicateReads: Record<string, number>;
  bashes: string[];
  edits: string[];
  writes: string[];
  totalCalls: number;
  firstThreeReads: string[];
  rules: RuleResult[];
  score: number;
  grade: string;
}

interface RuleResult {
  rule: string;
  pass: boolean;
  detail: string;
  weight: number;
}

function parseTranscript(filePath: string): ToolCall[] {
  const content = readFileSync(filePath, "utf-8");
  const calls: ToolCall[] = [];
  let order = 0;

  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        const msg = entry.message?.content;
        if (Array.isArray(msg)) {
          for (const block of msg) {
            if (block?.type === "tool_use") {
              calls.push({ name: block.name, input: block.input || {}, order: order++ });
            }
          }
        }
      }
    } catch {}
  }
  return calls;
}

function extractMeta(filePath: string): { label: string; phase: string } {
  const metaPath = filePath.replace(".jsonl", ".meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    return { label: meta.description || "unknown", phase: meta.workflowPhase || "unknown" };
  } catch {
    return { label: "unknown", phase: "unknown" };
  }
}

function auditAgent(filePath: string): AgentAudit {
  const agentId = basename(filePath).replace("agent-", "").replace(".jsonl", "");
  const { label, phase } = extractMeta(filePath);
  const toolCalls = parseTranscript(filePath);

  const reads: string[] = [];
  const bashes: string[] = [];
  const edits: string[] = [];
  const writes: string[] = [];

  for (const tc of toolCalls) {
    switch (tc.name) {
      case "Read":
        reads.push(tc.input.file_path || "?");
        break;
      case "Bash":
        bashes.push(tc.input.command || "?");
        break;
      case "Edit":
        edits.push(tc.input.file_path || "?");
        break;
      case "Write":
        writes.push(tc.input.file_path || "?");
        break;
    }
  }

  const readCounts: Record<string, number> = {};
  for (const r of reads) {
    readCounts[r] = (readCounts[r] || 0) + 1;
  }
  const duplicateReads: Record<string, number> = {};
  for (const [path, count] of Object.entries(readCounts)) {
    if (count > 1) duplicateReads[path] = count;
  }

  const firstThreeReads = reads.slice(0, 3).map((r) => basename(r));
  const rules = gradeRules(toolCalls, reads, bashes, edits, writes, duplicateReads, firstThreeReads);
  const maxScore = rules.reduce((s, r) => s + r.weight, 0);
  const score = rules.reduce((s, r) => s + (r.pass ? r.weight : 0), 0);
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 60 ? "C" : pct >= 40 ? "D" : "F";

  return {
    agentId,
    label,
    phase,
    toolCalls,
    reads,
    duplicateReads,
    bashes,
    edits,
    writes,
    totalCalls: toolCalls.length,
    firstThreeReads,
    rules,
    score: pct,
    grade,
  };
}

function gradeRules(
  calls: ToolCall[],
  reads: string[],
  bashes: string[],
  edits: string[],
  writes: string[],
  duplicateReads: Record<string, number>,
  firstThreeReads: string[]
): RuleResult[] {
  const results: RuleResult[] = [];

  // R1: Read AGENTS.md in first 5 tool calls
  const first5 = calls.slice(0, 5);
  const agentsMdEarly = first5.some(
    (c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")
  );
  results.push({
    rule: "Read AGENTS.md in first 5 calls",
    pass: agentsMdEarly,
    detail: agentsMdEarly
      ? `AGENTS.md read at position ${calls.findIndex((c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")) + 1}`
      : `First reads: ${firstThreeReads.join(", ")}`,
    weight: 20,
  });

  // R2: No duplicate file reads (same full path)
  const dupCount = Object.keys(duplicateReads).length;
  results.push({
    rule: "No duplicate file reads",
    pass: dupCount === 0,
    detail:
      dupCount === 0
        ? "All reads unique"
        : `${dupCount} files read multiple times: ${Object.entries(duplicateReads)
            .map(([p, c]) => `${basename(p)} (${c}x)`)
            .join(", ")}`,
    weight: 15,
  });

  // R3: Total tool calls under 30 (efficient agents stay focused)
  const totalCalls = calls.length;
  results.push({
    rule: "Total tool calls ≤ 30",
    pass: totalCalls <= 30,
    detail: `${totalCalls} calls`,
    weight: 10,
  });

  // R4: Grep-to-read ratio — too many greps means fishing
  const grepBashes = bashes.filter((b) => b.includes("grep"));
  const grepRatio = reads.length > 0 ? grepBashes.length / reads.length : 0;
  results.push({
    rule: "Grep:Read ratio ≤ 2:1",
    pass: grepRatio <= 2,
    detail: `${grepBashes.length} greps, ${reads.length} reads (ratio: ${grepRatio.toFixed(1)})`,
    weight: 10,
  });

  // R5: No `cat` or `head` via Bash (should use Read tool)
  const catBashes = bashes.filter((b) => /\bcat\b/.test(b) && !b.includes("<<"));
  results.push({
    rule: "No cat/head via Bash (use Read)",
    pass: catBashes.length === 0,
    detail: catBashes.length === 0 ? "Clean" : `${catBashes.length} cat commands found`,
    weight: 5,
  });

  // R6: Read PROJECT-STATE.md or project-state.json early (first 10 calls)
  const first10 = calls.slice(0, 10);
  const projectStateEarly = first10.some(
    (c) =>
      c.name === "Read" &&
      ((c.input.file_path || "").includes("PROJECT-STATE") ||
        (c.input.file_path || "").includes("project-state.json"))
  );
  results.push({
    rule: "Read PROJECT-STATE early (first 10 calls)",
    pass: projectStateEarly,
    detail: projectStateEarly ? "Project state read early" : "PROJECT-STATE not read in first 10 calls",
    weight: 10,
  });

  // R7: No repeated bun test runs
  const bunTestRuns = bashes.filter((b) => /\bbun test\b/.test(b) && !b.includes("grep"));
  results.push({
    rule: "≤ 1 full bun test run",
    pass: bunTestRuns.length <= 1,
    detail: `${bunTestRuns.length} bun test runs`,
    weight: 10,
  });

  // R8: Read governing spec before edits
  const firstEdit = calls.findIndex((c) => c.name === "Edit" || c.name === "Write");
  if (firstEdit >= 0) {
    const specReadBefore = calls
      .slice(0, firstEdit)
      .some((c) => c.name === "Read" && (c.input.file_path || "").includes("specs/"));
    results.push({
      rule: "Read governing spec before first edit",
      pass: specReadBefore,
      detail: specReadBefore ? "Spec read before edits" : "No spec read before first edit",
      weight: 15,
    });
  }

  // R9: Grep before Read (not reading whole files blindly)
  const readWithoutGrep = reads.filter((r) => {
    const readIdx = calls.findIndex((c) => c.name === "Read" && c.input.file_path === r);
    const fn = basename(r);
    if (["AGENTS.md", "PROJECT-STATE.md", "CLAUDE.md", "rungate.json", "SCHEMA-GUIDE.md"].includes(fn))
      return false;
    const priorGrep = calls
      .slice(0, readIdx)
      .some((c) => c.name === "Bash" && (c.input.command || "").includes(basename(r)));
    return !priorGrep;
  });
  const blindReadRatio = reads.length > 0 ? readWithoutGrep.length / reads.length : 0;
  results.push({
    rule: "Grep before Read for non-key files",
    pass: blindReadRatio <= 0.5,
    detail: `${readWithoutGrep.length}/${reads.length} reads without prior grep (${Math.round(blindReadRatio * 100)}%)`,
    weight: 5,
  });

  return results;
}

function formatReport(audits: AgentAudit[]): string {
  const lines: string[] = [];
  lines.push("# Workflow Transcript Audit Report");
  lines.push(`\nAudited: ${audits.length} agents`);
  lines.push(`Date: ${new Date().toISOString().split("T")[0]}`);

  const avgScore = Math.round(audits.reduce((s, a) => s + a.score, 0) / audits.length);
  lines.push(`\n## Summary: ${avgScore}% average (${audits.map((a) => a.grade).join(", ")})`);

  for (const audit of audits) {
    lines.push(`\n### ${audit.label} (${audit.phase}) — ${audit.grade} (${audit.score}%)`);
    lines.push(`- Tool calls: ${audit.totalCalls} (${audit.reads.length} reads, ${audit.bashes.length} bash, ${audit.edits.length} edits)`);

    if (Object.keys(audit.duplicateReads).length > 0) {
      lines.push(`- **Duplicate reads:** ${Object.entries(audit.duplicateReads).map(([p, c]) => `${basename(p)} (${c}x)`).join(", ")}`);
    }

    lines.push(`- First reads: ${audit.firstThreeReads.join(" → ")}`);
    lines.push("");
    lines.push("| Rule | Pass | Detail |");
    lines.push("|------|------|--------|");
    for (const r of audit.rules) {
      lines.push(`| ${r.rule} | ${r.pass ? "✅" : "❌"} | ${r.detail} |`);
    }
  }

  lines.push("\n## Recommendations");
  const allFails = audits.flatMap((a) => a.rules.filter((r) => !r.pass).map((r) => ({ ...r, agent: a.label })));
  const failCounts: Record<string, number> = {};
  for (const f of allFails) {
    failCounts[f.rule] = (failCounts[f.rule] || 0) + 1;
  }
  for (const [rule, count] of Object.entries(failCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- **${rule}** — failed by ${count} agent(s)`);
  }

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────
const dir = process.argv[2];
if (!dir) {
  console.error("Usage: bun scripts/audit-transcript.ts <transcript-dir>");
  console.error("  transcript-dir: path to workflow transcript directory containing agent-*.jsonl files");
  process.exit(1);
}

const resolvedDir = resolve(dir);
const files = readdirSync(resolvedDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));

if (files.length === 0) {
  console.error(`No agent-*.jsonl files found in ${resolvedDir}`);
  process.exit(1);
}

const audits = files.map((f) => auditAgent(join(resolvedDir, f)));
const report = formatReport(audits);

console.log(report);

const outPath = join(resolvedDir, "audit-report.md");
Bun.write(outPath, report);
console.error(`\nReport written to: ${outPath}`);
