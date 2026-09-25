#!/usr/bin/env bun
import { readFileSync, readdirSync } from "fs";
import { join, basename, resolve } from "path";
import {
  type ToolCall,
  type TranscriptData,
  type CriterionResult,
  type Role,
  type Verdict,
  evaluateCriteria,
  ROLES,
} from "../lib/eval-criteria.js";

export { type ToolCall, type CriterionResult, type Role, type Verdict };

export interface AgentAudit {
  agentId: string;
  label: string;
  phase: string;
  role: Role;
  toolCalls: ToolCall[];
  reads: string[];
  duplicateReads: Record<string, number>;
  bashes: string[];
  edits: string[];
  writes: string[];
  totalCalls: number;
  firstThreeReads: string[];
  rules: CriterionResult[];
  score: number;
  grade: string;
}

export function parseTranscript(filePath: string): ToolCall[] {
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

function extractMeta(filePath: string): { label: string; phase: string; role: Role } {
  const metaPath = filePath.replace(".jsonl", ".meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const role = inferRole(meta.agentType || meta.description || "");
    return {
      label: meta.description || "unknown",
      phase: meta.workflowPhase || "unknown",
      role,
    };
  } catch {
    return { label: "unknown", phase: "unknown", role: "marcus" };
  }
}

function inferRole(hint: string): Role {
  const lower = hint.toLowerCase();
  if (lower.includes("da") || lower.includes("orchestrat")) return "da";
  if (lower.includes("quinn") || lower.includes("valid") || lower.includes("qa")) return "quinn";
  return "marcus";
}

function buildTranscriptData(
  calls: ToolCall[],
  reads: string[],
  bashes: string[],
  edits: string[],
  writes: string[],
  duplicateReads: Record<string, number>,
  firstThreeReads: string[]
): TranscriptData {
  return { calls, reads, bashes, edits, writes, duplicateReads, firstThreeReads, promptContent: '' };
}

function applyUtilityExemptions(results: CriterionResult[], totalCalls: number): CriterionResult[] {
  if (totalCalls > 3) return results;
  return results.map((r) => {
    if (r.id === "SHARED-01" || r.id === "SHARED-04") {
      return { ...r, verdict: "FOLLOWED" as Verdict, evidence: "Exempt (utility agent, <= 3 calls)" };
    }
    return r;
  });
}

/**
 * Grade a transcript using role-specific evaluation criteria.
 * Central grading entry point used by both audit-transcript and da-compliance.
 */
export function gradeByRole(
  role: Role,
  calls: ToolCall[],
  reads: string[],
  bashes: string[],
  edits: string[],
  writes: string[],
  duplicateReads: Record<string, number>,
  firstThreeReads: string[]
): CriterionResult[] {
  const data = buildTranscriptData(calls, reads, bashes, edits, writes, duplicateReads, firstThreeReads);
  const results = evaluateCriteria(role, data);
  return applyUtilityExemptions(results, calls.length);
}

export function auditAgent(filePath: string, roleOverride?: Role): AgentAudit {
  const agentId = basename(filePath).replace("agent-", "").replace(".jsonl", "");
  const { label, phase, role: inferredRole } = extractMeta(filePath);
  const role = roleOverride ?? inferredRole;
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
  const rules = gradeByRole(role, toolCalls, reads, bashes, edits, writes, duplicateReads, firstThreeReads);
  const maxScore = rules.reduce((s, r) => s + r.weight, 0);
  const score = rules.reduce((s, r) => s + (r.verdict === "FOLLOWED" ? r.weight : 0), 0);
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 60 ? "C" : pct >= 40 ? "D" : "F";

  return {
    agentId,
    label,
    phase,
    role,
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

export function formatReport(audits: AgentAudit[]): string {
  const lines: string[] = [];
  lines.push("# Workflow Transcript Audit Report");
  lines.push(`\nAudited: ${audits.length} agents`);
  lines.push(`Date: ${new Date().toISOString().split("T")[0]}`);

  const avgScore = Math.round(audits.reduce((s, a) => s + a.score, 0) / audits.length);
  lines.push(`\n## Summary: ${avgScore}% average (${audits.map((a) => a.grade).join(", ")})`);

  for (const audit of audits) {
    lines.push(`\n### ${audit.label} [${audit.role}] (${audit.phase}) — ${audit.grade} (${audit.score}%)`);
    lines.push(`- Tool calls: ${audit.totalCalls} (${audit.reads.length} reads, ${audit.bashes.length} bash, ${audit.edits.length} edits)`);

    if (Object.keys(audit.duplicateReads).length > 0) {
      lines.push(`- **Duplicate reads:** ${Object.entries(audit.duplicateReads).map(([p, c]) => `${basename(p)} (${c}x)`).join(", ")}`);
    }

    lines.push(`- First reads: ${audit.firstThreeReads.join(" -> ")}`);
    lines.push("");
    lines.push("| ID | Rule | Verdict | Evidence |");
    lines.push("|----|------|---------|----------|");
    for (const r of audit.rules) {
      lines.push(`| ${r.id} | ${r.rule} | ${r.verdict} | ${r.evidence} |`);
    }
  }

  lines.push("\n## Recommendations");
  const allFails = audits.flatMap((a) =>
    a.rules.filter((r) => r.verdict === "IGNORED").map((r) => ({ ...r, agent: a.label }))
  );
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
if (import.meta.main) {
  const args = process.argv.slice(2);
  const roleFlag = args.find((a) => a.startsWith("--role="));
  const roleOverride = roleFlag ? (roleFlag.split("=")[1] as Role) : undefined;
  const dir = args.find((a) => !a.startsWith("--"));

  if (!dir) {
    console.error("Usage: bun scripts/audit-transcript.ts [--role=da|marcus|quinn] <transcript-dir>");
    console.error("  transcript-dir: path to workflow transcript directory containing agent-*.jsonl files");
    console.error("  --role=ROLE: override role detection for all agents");
    process.exit(1);
  }

  if (roleOverride && !ROLES.includes(roleOverride)) {
    console.error(`Invalid role: ${roleOverride}. Must be one of: ${ROLES.join(", ")}`);
    process.exit(1);
  }

  const resolvedDir = resolve(dir);
  const files = readdirSync(resolvedDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));

  if (files.length === 0) {
    console.error(`No agent-*.jsonl files found in ${resolvedDir}`);
    process.exit(1);
  }

  const audits = files.map((f) => auditAgent(join(resolvedDir, f), roleOverride));
  const report = formatReport(audits);

  console.log(report);

  const outPath = join(resolvedDir, "audit-report.md");
  Bun.write(outPath, report);
  console.error(`\nReport written to: ${outPath}`);
}
