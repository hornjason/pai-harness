/**
 * Transcript compliance checker — cross-references extracted directives
 * against agent tool calls producing FOLLOWED or IGNORED verdict per directive.
 *
 * Also includes role-based evaluation criteria for DA compliance auditing.
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

export interface ToolCall {
  name: string;
  input: Record<string, any>;
  order?: number;
}

// ── Role-based evaluation (from eval-criteria) ──────────

export interface TranscriptData {
  calls: ToolCall[];
  reads: string[];
  bashes: string[];
  edits: string[];
  writes: string[];
  duplicateReads: Record<string, number>;
  firstThreeReads: string[];
  promptContent: string;
}

export type Verdict = "FOLLOWED" | "IGNORED";

export interface CriterionResult {
  id: string;
  rule: string;
  verdict: Verdict;
  evidence: string;
  weight: number;
  source: string;
}

export interface EvalCriterion {
  id: string;
  rule: string;
  weight: number;
  source: string;
  check: (data: TranscriptData) => { verdict: Verdict; evidence: string };
}

export type Role = "da" | "marcus" | "quinn";

// ── Transcript parsing ───────────────────────────────────

export function parseToolCalls(transcriptContent: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let order = 0;
  for (const line of transcriptContent.split("\n").filter(Boolean)) {
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

// ═══════════════════════════════════════════════════════
// Role-based evaluation criteria (merged from eval-criteria.ts)
// ═══════════════════════════════════════════════════════

// ── Shared criteria (apply to all roles) ────────────────

const sharedCriteria: EvalCriterion[] = [
  {
    id: "SHARED-01",
    rule: "AGENTS.md context available (read or injected)",
    weight: 20,
    source: "AGENTS.md § Rules",
    check(data) {
      const readIt = data.calls.some(
        (c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")
      );
      if (readIt) {
        const pos = data.calls.findIndex(
          (c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")
        );
        return { verdict: "FOLLOWED", evidence: `AGENTS.md read at position ${pos + 1}` };
      }
      const injected = data.promptContent.includes("AGENTS.md");
      if (injected) {
        return { verdict: "FOLLOWED", evidence: "AGENTS.md content injected in prompt" };
      }
      return {
        verdict: "IGNORED",
        evidence: `AGENTS.md not read or injected. First reads: ${data.firstThreeReads.join(", ")}`,
      };
    },
  },
  {
    id: "SHARED-02",
    rule: "No duplicate file reads",
    weight: 15,
    source: "marcus.md § Never Do",
    check(data) {
      const dupCount = Object.keys(data.duplicateReads).length;
      return {
        verdict: dupCount === 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          dupCount === 0
            ? "All reads unique"
            : `${dupCount} files read multiple times: ${Object.entries(data.duplicateReads)
                .map(([p, c]) => `${basename(p)} (${c}x)`)
                .join(", ")}`,
      };
    },
  },
  {
    id: "SHARED-03",
    rule: "No cat/head via Bash (use Read)",
    weight: 5,
    source: "marcus.md § Never Do",
    check(data) {
      const catBashes = data.bashes.filter((b) => /\bcat\b/.test(b) && !b.includes("<<"));
      return {
        verdict: catBashes.length === 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          catBashes.length === 0 ? "Clean" : `${catBashes.length} cat commands found`,
      };
    },
  },
  {
    id: "SHARED-04",
    rule: "Read PROJECT-STATE if task requires project context",
    weight: 10,
    source: "AGENTS.md § Key Files",
    check(data) {
      const found = data.reads.some(
        (r) => r.includes("PROJECT-STATE") || r.includes("project-state.json")
      );
      const touchesMultipleFiles = data.edits.length + data.writes.length > 3;
      if (!touchesMultipleFiles && !found) {
        return {
          verdict: "FOLLOWED",
          evidence: "Small task — PROJECT-STATE read not required",
        };
      }
      return {
        verdict: found ? "FOLLOWED" : "IGNORED",
        evidence: found
          ? "Project state read"
          : "PROJECT-STATE not read (multi-file task)",
      };
    },
  },
];

// ── DA-specific criteria ────────────────────────────────

const daCriteria: EvalCriterion[] = [
  {
    id: "DA-01",
    rule: "Invoke harness skill before implementation",
    weight: 20,
    source: "CLAUDE.md § MANDATORY GATE step 3",
    check(data) {
      const skillCall = data.calls.findIndex(
        (c) => c.name === "Skill" && (c.input.skill || "") === "harness"
      );
      const firstEdit = data.calls.findIndex(
        (c) => c.name === "Edit" || c.name === "Write"
      );
      const invoked = skillCall >= 0;
      const beforeEdit = firstEdit < 0 || skillCall < firstEdit;
      return {
        verdict: invoked && beforeEdit ? "FOLLOWED" : "IGNORED",
        evidence: invoked
          ? `Skill("harness") at position ${skillCall + 1}${beforeEdit ? " (before edits)" : " (AFTER edits)"}`
          : "Skill('harness') never invoked",
      };
    },
  },
  {
    id: "DA-02",
    rule: "Run bun test before implementation",
    weight: 15,
    source: "CLAUDE.md § MANDATORY GATE step 1",
    check(data) {
      const firstTest = data.calls.findIndex(
        (c) => c.name === "Bash" && /\bbun test\b/.test(c.input.command || "")
      );
      const firstEdit = data.calls.findIndex(
        (c) => c.name === "Edit" || c.name === "Write"
      );
      const ran = firstTest >= 0;
      const beforeEdit = firstEdit < 0 || firstTest < firstEdit;
      return {
        verdict: ran && beforeEdit ? "FOLLOWED" : "IGNORED",
        evidence: ran
          ? `bun test at position ${firstTest + 1}${beforeEdit ? " (before edits)" : " (AFTER edits)"}`
          : "bun test never run",
      };
    },
  },
  {
    id: "DA-03",
    rule: "Read governing spec before implementation",
    weight: 15,
    source: "CLAUDE.md § MANDATORY GATE step 2",
    check(data) {
      const firstEdit = data.calls.findIndex(
        (c) => c.name === "Edit" || c.name === "Write"
      );
      if (firstEdit < 0) {
        return { verdict: "FOLLOWED", evidence: "No edits — spec read not required" };
      }
      const specRead = data.calls.slice(0, firstEdit).some(
        (c) => c.name === "Read" && (c.input.file_path || "").includes("specs/")
      );
      return {
        verdict: specRead ? "FOLLOWED" : "IGNORED",
        evidence: specRead
          ? "Spec read before edits"
          : "No spec read before first edit",
      };
    },
  },
  {
    id: "DA-04",
    rule: "Delegate to named agents (no direct Edit/Write on lib/test/scripts/gates/hooks)",
    weight: 20,
    source: "CLAUDE.md § MANDATORY GATE step 4",
    check(data) {
      const directEdits = [...data.edits, ...data.writes].filter((p) =>
        /\/(lib|test|scripts|gates|hooks)\//.test(p)
      );
      return {
        verdict: directEdits.length === 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          directEdits.length === 0
            ? "No direct edits to restricted directories"
            : `${directEdits.length} direct edits to restricted dirs: ${directEdits.map((p) => basename(p)).join(", ")}`,
      };
    },
  },
  {
    id: "DA-05",
    rule: "Update PROJECT-STATE at milestones",
    weight: 10,
    source: "CLAUDE.md § Rules",
    check(data) {
      const stateEdits = [...data.edits, ...data.writes].filter(
        (p) =>
          p.includes("PROJECT-STATE") || p.includes("project-state.json")
      );
      return {
        verdict: stateEdits.length > 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          stateEdits.length > 0
            ? `PROJECT-STATE updated ${stateEdits.length} time(s)`
            : "PROJECT-STATE never updated",
      };
    },
  },
];

// ── Marcus-specific criteria ────────────────────────────

const marcusCriteria: EvalCriterion[] = [
  {
    id: "M-01",
    rule: "Total tool calls <= 30",
    weight: 10,
    source: "marcus.md § Additional Never Do",
    check(data) {
      const total = data.calls.length;
      return {
        verdict: total <= 30 ? "FOLLOWED" : "IGNORED",
        evidence: `${total} calls`,
      };
    },
  },
  {
    id: "M-02",
    rule: "Grep:Read ratio <= 2:1",
    weight: 10,
    source: "prompts/coding-principles.md",
    check(data) {
      const grepBashes = data.bashes.filter((b) => b.includes("grep"));
      const ratio = data.reads.length > 0 ? grepBashes.length / data.reads.length : 0;
      return {
        verdict: ratio <= 2 ? "FOLLOWED" : "IGNORED",
        evidence: `${grepBashes.length} greps, ${data.reads.length} reads (ratio: ${ratio.toFixed(1)})`,
      };
    },
  },
  {
    id: "M-03",
    rule: "<= 2 full suite runs (targeted runs are unlimited)",
    weight: 10,
    source: "marcus.md § Testing Rules",
    check(data) {
      const fullSuiteRuns = data.bashes.filter(
        (b) => /\bbun test\s*$/.test(b.trim()) || (/\bbun test\b/.test(b) && !b.includes("test/") && !b.includes(".test.") && !b.includes("grep"))
      );
      const targetedRuns = data.bashes.filter(
        (b) => /\bbun test\b/.test(b) && (b.includes("test/") || b.includes(".test.")) && !b.includes("grep")
      );
      return {
        verdict: fullSuiteRuns.length <= 2 ? "FOLLOWED" : "IGNORED",
        evidence: `${fullSuiteRuns.length} full suite runs, ${targetedRuns.length} targeted runs`,
      };
    },
  },
  {
    id: "M-04",
    rule: "Governing spec context available (read or injected) when touching spec'd area",
    weight: 15,
    source: "marcus.md § Context",
    check(data) {
      const firstEdit = data.calls.findIndex(
        (c) => c.name === "Edit" || c.name === "Write"
      );
      if (firstEdit < 0) {
        return { verdict: "FOLLOWED", evidence: "No edits — spec read not required" };
      }
      const specRead = data.calls.slice(0, firstEdit).some(
        (c) => c.name === "Read" && (c.input.file_path || "").includes("specs/")
      );
      if (specRead) {
        return { verdict: "FOLLOWED", evidence: "Spec read before edits" };
      }
      const specInjected = data.promptContent.includes("specs/") || data.promptContent.includes("Governing spec");
      if (specInjected) {
        return { verdict: "FOLLOWED", evidence: "Spec content injected in prompt" };
      }
      const editPaths = data.edits.concat(data.writes);
      const touchesSpecArea = editPaths.some(
        (p) => p.includes("lib/") || p.includes("gates/") || p.includes("hooks/") || p.includes("workflows/")
      );
      if (!touchesSpecArea) {
        return { verdict: "FOLLOWED", evidence: "Task does not touch spec'd area — spec read not required" };
      }
      return {
        verdict: "IGNORED",
        evidence: "No spec read or injection before first edit (touches spec'd area)",
      };
    },
  },
  {
    id: "M-05",
    rule: "Coding/testing principles available (read or injected) for core changes",
    weight: 15,
    source: "marcus.md § Context",
    check(data) {
      if (data.edits.length === 0 && data.writes.length === 0) {
        return { verdict: "FOLLOWED", evidence: "No code written — exempt" };
      }
      const promptReads = data.reads.filter((r) => r.includes("prompts/"));
      if (promptReads.length > 0) {
        return {
          verdict: "FOLLOWED",
          evidence: `${promptReads.length} prompt(s) read: ${promptReads.map((r) => basename(r)).join(", ")}`,
        };
      }
      const principlesInjected = data.promptContent.includes("prompts/") ||
        data.promptContent.includes("Coding Principles") ||
        data.promptContent.includes("coding-principles");
      if (principlesInjected) {
        return { verdict: "FOLLOWED", evidence: "Coding/testing principles injected in prompt" };
      }
      const editPaths = data.edits.concat(data.writes);
      const touchesCoreLib = editPaths.some(
        (p) => p.includes("lib/") || p.includes("src/")
      );
      const multipleFiles = editPaths.length > 3;
      if (!touchesCoreLib && !multipleFiles) {
        return { verdict: "FOLLOWED", evidence: "Simple task — prompts/ read not required" };
      }
      return {
        verdict: "IGNORED",
        evidence: "No coding principles read or injected (touches core lib or multi-file change)",
      };
    },
  },
  {
    id: "M-06",
    rule: "Grep before Read for non-key files",
    weight: 5,
    source: "memory: Grep Before Read",
    check(data) {
      const readWithoutGrep = data.reads.filter((r) => {
        const readIdx = data.calls.findIndex(
          (c) => c.name === "Read" && c.input.file_path === r
        );
        const fn = basename(r);
        if (
          ["AGENTS.md", "PROJECT-STATE.md", "CLAUDE.md", "rungate.json", "SCHEMA-GUIDE.md"].includes(fn)
        )
          return false;
        const priorGrep = data.calls
          .slice(0, readIdx)
          .some((c) => c.name === "Bash" && (c.input.command || "").includes(basename(r)));
        return !priorGrep;
      });
      const ratio = data.reads.length > 0 ? readWithoutGrep.length / data.reads.length : 0;
      return {
        verdict: ratio <= 0.5 ? "FOLLOWED" : "IGNORED",
        evidence: `${readWithoutGrep.length}/${data.reads.length} reads without prior grep (${Math.round(ratio * 100)}%)`,
      };
    },
  },
];

// ── Quinn-specific criteria ─────────────────────────────

const quinnCriteria: EvalCriterion[] = [
  {
    id: "Q-01",
    rule: "Run full test suite (bun test)",
    weight: 20,
    source: "quinn.md § Core Principles",
    check(data) {
      const bunTestRuns = data.bashes.filter((b) => /\bbun test\b/.test(b));
      return {
        verdict: bunTestRuns.length > 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          bunTestRuns.length > 0
            ? `${bunTestRuns.length} bun test run(s)`
            : "bun test never run",
      };
    },
  },
  {
    id: "Q-02",
    rule: "Run type check (tsc --noEmit)",
    weight: 15,
    source: "quinn.md § Before reporting done",
    check(data) {
      const tscRuns = data.bashes.filter((b) => b.includes("tsc") && b.includes("--noEmit"));
      return {
        verdict: tscRuns.length > 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          tscRuns.length > 0
            ? `${tscRuns.length} tsc --noEmit run(s)`
            : "tsc --noEmit never run",
      };
    },
  },
  {
    id: "Q-03",
    rule: "Verify AC evidence is not self-attested",
    weight: 15,
    source: "quinn.md § Never Do",
    check(data) {
      // Quinn should read test output or grep for evidence, not just assert it
      const evidenceBashes = data.bashes.filter(
        (b) => b.includes("grep") || b.includes("bun test") || b.includes("tsc")
      );
      return {
        verdict: evidenceBashes.length >= 2 ? "FOLLOWED" : "IGNORED",
        evidence: `${evidenceBashes.length} verification commands found`,
      };
    },
  },
  {
    id: "Q-04",
    rule: "No direct code edits (validation only)",
    weight: 20,
    source: "quinn.md § Core Principles",
    check(data) {
      const codeEdits = [...data.edits, ...data.writes].filter(
        (p) => /\.(ts|js|json)$/.test(p) && !p.includes("test")
      );
      return {
        verdict: codeEdits.length === 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          codeEdits.length === 0
            ? "No code edits — validation only"
            : `${codeEdits.length} code file(s) edited: ${codeEdits.map((p) => basename(p)).join(", ")}`,
      };
    },
  },
  {
    id: "Q-05",
    rule: "Total tool calls <= 30",
    weight: 10,
    source: "quinn.md § Efficiency",
    check(data) {
      const total = data.calls.length;
      return {
        verdict: total <= 30 ? "FOLLOWED" : "IGNORED",
        evidence: `${total} calls`,
      };
    },
  },
];

// ── Role registry ───────────────────────────────────────

const roleRegistry: Record<Role, EvalCriterion[]> = {
  da: [...sharedCriteria, ...daCriteria],
  marcus: [...sharedCriteria, ...marcusCriteria],
  quinn: [...sharedCriteria, ...quinnCriteria],
};

/**
 * Get eval criteria for a given role.
 * Combines shared criteria with role-specific ones.
 */
export function getCriteria(role: Role): EvalCriterion[] {
  return roleRegistry[role] ?? [];
}

/**
 * Evaluate transcript data against a role's criteria.
 * Returns per-criterion results with FOLLOWED/IGNORED verdicts.
 */
export function evaluateCriteria(
  role: Role,
  data: TranscriptData
): CriterionResult[] {
  const criteria = getCriteria(role);
  return criteria.map((criterion) => {
    const { verdict, evidence } = criterion.check(data);
    return {
      id: criterion.id,
      rule: criterion.rule,
      verdict,
      evidence,
      weight: criterion.weight,
      source: criterion.source,
    };
  });
}

/**
 * All supported roles.
 */
export const ROLES: readonly Role[] = ["da", "marcus", "quinn"] as const;
