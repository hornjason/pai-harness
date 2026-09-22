/**
 * Transcript compliance checker — cross-references extracted directives
 * against agent tool calls producing FOLLOWED or IGNORED verdict per directive.
 *
 * SC-402: Transcript checker: FOLLOWED/IGNORED per directive
 */

import { readFileSync } from "fs";
import { basename } from "path";
import type { Directive } from "./directive-extractor.js";

type ComplianceVerdict = "FOLLOWED" | "IGNORED" | "VIOLATED" | "N/A";

export interface ComplianceResult {
  directive: Directive;
  status: ComplianceVerdict;
  evidence: string;
}

interface ToolCall {
  name: string;
  input: Record<string, any>;
}

// ── Transcript parsing ───────────────────────────────────

export function parseToolCalls(transcriptContent: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of transcriptContent.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        const msg = entry.message?.content;
        if (Array.isArray(msg)) {
          for (const block of msg) {
            if (block?.type === "tool_use") {
              calls.push({ name: block.name, input: block.input || {} });
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return calls;
}

// ── Compliance checking ──────────────────────────────────

function checkReadDirective(d: Directive, reads: string[]): ComplianceResult {
  const targetBase = basename(d.target!);
  const found = reads.some((r) => r.includes(targetBase));
  return {
    directive: d,
    status: found ? "FOLLOWED" : "IGNORED",
    evidence: found
      ? `Read call found for ${targetBase}`
      : `No Read call for ${targetBase} in ${reads.length} reads`,
  };
}

function checkRunDirective(d: Directive, bashes: string[]): ComplianceResult {
  if (d.target!.includes("bun test")) {
    const testRuns = bashes.filter((b) => /\bbun test\b/.test(b));
    if (testRuns.length === 0) return { directive: d, status: "IGNORED", evidence: "No bun test calls found" };
    if (testRuns.length > 2) return { directive: d, status: "VIOLATED", evidence: `${testRuns.length} bun test runs (expected 1-2)` };
    return { directive: d, status: "FOLLOWED", evidence: `${testRuns.length} bun test run(s)` };
  }
  if (d.target!.includes("tsc")) {
    const tscRuns = bashes.filter((b) => b.includes("tsc") && b.includes("--noEmit"));
    return {
      directive: d,
      status: tscRuns.length > 0 ? "FOLLOWED" : "IGNORED",
      evidence: tscRuns.length > 0 ? `${tscRuns.length} tsc run(s)` : "tsc --noEmit never run",
    };
  }
  const found = bashes.some((b) => b.includes(d.target!));
  return {
    directive: d,
    status: found ? "FOLLOWED" : "IGNORED",
    evidence: found ? "Command found" : "Command not found",
  };
}

function checkNeverDirective(d: Directive, bashes: string[], toolCalls: ToolCall[]): ComplianceResult {
  const textLower = d.text.toLowerCase();

  if (textLower.includes("cat") && (textLower.includes("bash") || textLower.includes("read tool"))) {
    const catCalls = bashes.filter((b) => /\bcat\b/.test(b) && !b.includes("<<"));
    return { directive: d, status: catCalls.length === 0 ? "FOLLOWED" : "VIOLATED", evidence: `${catCalls.length} cat commands` };
  }

  if (textLower.includes("pwd") || textLower.includes("ls -la")) {
    const orientCalls = bashes.filter((b) => /\bpwd\b/.test(b) || /\bls -la\b/.test(b));
    return { directive: d, status: orientCalls.length === 0 ? "FOLLOWED" : "VIOLATED", evidence: `${orientCalls.length} orientation calls` };
  }

  if (textLower.includes("subagent") || textLower.includes("spawn")) {
    const agentCalls = toolCalls.filter((c) => c.name === "Agent" || c.name === "TaskCreate");
    return { directive: d, status: agentCalls.length === 0 ? "FOLLOWED" : "VIOLATED", evidence: `${agentCalls.length} agent/task calls` };
  }

  if (textLower.includes("same file twice") || textLower.includes("duplicate")) {
    const readPaths = toolCalls.filter((c) => c.name === "Read").map((c) => c.input.file_path || "");
    const dupes = readPaths.filter((p, i) => readPaths.indexOf(p) !== i);
    return { directive: d, status: dupes.length === 0 ? "FOLLOWED" : "VIOLATED", evidence: `${dupes.length} duplicate reads` };
  }

  if (textLower.includes("bun test") && textLower.includes("more than twice")) {
    const testRuns = bashes.filter((b) => /\bbun test\b/.test(b) && !b.includes("grep"));
    return { directive: d, status: testRuns.length <= 2 ? "FOLLOWED" : "VIOLATED", evidence: `${testRuns.length} bun test runs` };
  }

  if (textLower.includes("make rebuild")) {
    const rebuilds = bashes.filter((b) => b.includes("make rebuild"));
    return { directive: d, status: rebuilds.length === 0 ? "FOLLOWED" : "VIOLATED", evidence: `${rebuilds.length} rebuild calls` };
  }

  return { directive: d, status: "N/A", evidence: "Cannot verify mechanically" };
}

function checkAlwaysDirective(d: Directive, reads: string[], bashes: string[]): ComplianceResult {
  const textLower = d.text.toLowerCase();

  if (textLower.includes("agents.md")) {
    const early = reads.slice(0, 5).some((r) => r.includes("AGENTS.md"));
    return { directive: d, status: early ? "FOLLOWED" : "IGNORED", evidence: early ? "AGENTS.md in first 5 reads" : "AGENTS.md not in first 5 reads" };
  }

  if (textLower.includes("bun test")) {
    const testRuns = bashes.filter((b) => /\bbun test\b/.test(b));
    return { directive: d, status: testRuns.length > 0 ? "FOLLOWED" : "IGNORED", evidence: `${testRuns.length} test runs` };
  }

  if (textLower.includes("verify before assert")) {
    // Check for verification commands (grep, test, etc.) before final output
    const verifyCount = bashes.filter((b) => b.includes("grep") || b.includes("test") || b.includes("tsc")).length;
    return { directive: d, status: verifyCount > 0 ? "FOLLOWED" : "IGNORED", evidence: `${verifyCount} verification commands` };
  }

  return { directive: d, status: "N/A", evidence: "Cannot verify mechanically" };
}

export function checkCompliance(directives: Directive[], transcriptContent: string): ComplianceResult[] {
  const toolCalls = parseToolCalls(transcriptContent);
  const reads = toolCalls.filter((c) => c.name === "Read").map((c) => c.input.file_path || "");
  const bashes = toolCalls.filter((c) => c.name === "Bash").map((c) => c.input.command || "");

  return directives.map((d) => {
    switch (d.type) {
      case "read":
        return d.target ? checkReadDirective(d, reads) : { directive: d, status: "N/A" as const, evidence: "No target" };
      case "run":
        return d.target ? checkRunDirective(d, bashes) : { directive: d, status: "N/A" as const, evidence: "No target" };
      case "never":
        return checkNeverDirective(d, bashes, toolCalls);
      case "always":
        return checkAlwaysDirective(d, reads, bashes);
      default:
        return { directive: d, status: "N/A" as const, evidence: "Unknown directive type" };
    }
  });
}

// ── Behavioral pattern checks ───────────────────────────

export interface SequenceEvent {
  type: "WRITE_TEST" | "WRITE_SOURCE" | "TEST_RUN";
  file?: string;
  cmd?: string;
}

export interface TDDResult {
  testFirst: boolean;
  redPhase: boolean;
  greenPhase: boolean;
  sequence: SequenceEvent[];
  verdict: "TDD" | "TEST_AFTER" | "NO_TESTS" | "NO_SOURCE";
  evidence: string;
}

export function checkTDD(transcriptContent: string): TDDResult {
  const calls = parseToolCalls(transcriptContent);
  const sequence: SequenceEvent[] = [];

  for (const call of calls) {
    if (call.name === "Write" || call.name === "Edit") {
      const path = call.input?.file_path || call.input?.path || "";
      const file = basename(path);
      const isTest = path.includes("test/") || path.includes(".test.");
      const isSource = path.includes("lib/") || path.includes("scripts/") || path.includes("src/");
      if (isTest) sequence.push({ type: "WRITE_TEST", file });
      else if (isSource) sequence.push({ type: "WRITE_SOURCE", file });
    }
    if (call.name === "Bash") {
      const cmd = call.input?.command || "";
      if (cmd.includes("bun test")) {
        sequence.push({ type: "TEST_RUN", cmd: cmd.slice(0, 60) });
      }
    }
  }

  const firstTest = sequence.findIndex((s) => s.type === "WRITE_TEST");
  const firstSource = sequence.findIndex((s) => s.type === "WRITE_SOURCE");

  if (firstTest === -1) return { testFirst: false, redPhase: false, greenPhase: false, sequence, verdict: "NO_TESTS", evidence: "No test files written" };
  if (firstSource === -1) return { testFirst: true, redPhase: false, greenPhase: false, sequence, verdict: "NO_SOURCE", evidence: "No source files written" };

  const testFirst = firstTest < firstSource;

  let redPhase = false;
  let greenPhase = false;
  let state: "init" | "wrote_test" | "ran_after_test" | "wrote_source" | "ran_after_source" = "init";
  for (const s of sequence) {
    if (s.type === "WRITE_TEST") state = "wrote_test";
    if (s.type === "TEST_RUN" && state === "wrote_test") { redPhase = true; state = "ran_after_test"; }
    if (s.type === "WRITE_SOURCE" && (state === "ran_after_test" || state === "wrote_test")) state = "wrote_source";
    if (s.type === "TEST_RUN" && state === "wrote_source") { greenPhase = true; state = "ran_after_source"; }
  }

  const verdict = testFirst && redPhase && greenPhase ? "TDD" : "TEST_AFTER";
  const parts: string[] = [];
  if (!testFirst) parts.push(`source written at step ${firstSource + 1} before test at step ${firstTest + 1}`);
  if (!redPhase) parts.push("no test run after writing test (missing red phase)");
  if (!greenPhase) parts.push("no test run after writing source (missing green phase)");
  const evidence = verdict === "TDD" ? "test-first → red → green pattern confirmed" : parts.join("; ");

  return { testFirst, redPhase, greenPhase, sequence, verdict, evidence };
}

// ── Scoring ──────────────────────────────────────────────

export function computeScore(results: ComplianceResult[]): { score: number; grade: string; followed: number; ignored: number; violated: number; checkable: number } {
  const followed = results.filter((r) => r.status === "FOLLOWED").length;
  const ignored = results.filter((r) => r.status === "IGNORED").length;
  const violated = results.filter((r) => r.status === "VIOLATED").length;
  const checkable = results.filter((r) => r.status !== "N/A").length;
  const score = checkable > 0 ? Math.round((followed / checkable) * 100) : 0;
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  return { score, grade, followed, ignored, violated, checkable };
}

// ── Report formatting ────────────────────────────────────

export function formatReport(
  role: string,
  results: ComplianceResult[],
  repoRailsCount: number,
): string {
  const { score, grade, followed, ignored, violated, checkable } = computeScore(results);
  const directives = results.map((r) => r.directive);

  const lines: string[] = [];
  lines.push(`\n${"=".repeat(60)}`);
  lines.push(`BRIEF COMPLIANCE: ${role} -- ${grade} (${score}%)`);
  lines.push(`${"=".repeat(60)}`);
  lines.push(`Directives: ${directives.length} extracted, ${checkable} checkable`);
  lines.push(`Followed: ${followed} | Ignored: ${ignored} | Violated: ${violated}`);
  lines.push(`RepoRails findings: ${repoRailsCount}`);
  lines.push("");

  lines.push("DIRECTIVE                                          | LINE  | SECTION         | STATUS");
  lines.push("-".repeat(95));
  for (const r of results) {
    const icon = r.status === "FOLLOWED" ? "[OK]" : r.status === "IGNORED" ? "[--]" : r.status === "VIOLATED" ? "[!!]" : "[  ]";
    const text = r.directive.text.substring(0, 48).padEnd(48);
    const line = `L${r.directive.line}`.padEnd(6);
    const section = r.directive.section.substring(0, 15).padEnd(15);
    lines.push(`${icon} ${text} | ${line}| ${section} | ${r.status}: ${r.evidence}`);
  }

  lines.push("");
  lines.push("RECOMMENDATIONS:");
  const ignoredDirectives = results.filter((r) => r.status === "IGNORED");
  for (const r of ignoredDirectives) {
    const inTop20 = r.directive.line <= 20;
    lines.push(`  -> "${r.directive.text.substring(0, 50)}" at L${r.directive.line} (${r.directive.section})`);
    if (!inTop20) lines.push(`    FIX: Move to Context or Always Do section (currently in ${r.directive.section})`);
    else lines.push(`    FIX: Strengthen language -- add MANDATORY or BEFORE keyword`);
  }

  return lines.join("\n");
}
