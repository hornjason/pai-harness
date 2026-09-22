/**
 * Shared evaluation criteria for DA compliance auditing.
 * Role-specific rule sets for DA, Marcus, and Quinn transcript grading.
 *
 * Each criterion has an ID, description, weight, source reference,
 * and a check function that evaluates transcript data.
 */

import { basename } from "path";

export interface ToolCall {
  name: string;
  input: Record<string, any>;
  order: number;
}

export interface TranscriptData {
  calls: ToolCall[];
  reads: string[];
  bashes: string[];
  edits: string[];
  writes: string[];
  duplicateReads: Record<string, number>;
  firstThreeReads: string[];
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

// ── Shared criteria (apply to all roles) ────────────────

const sharedCriteria: EvalCriterion[] = [
  {
    id: "SHARED-01",
    rule: "Read AGENTS.md in first 5 calls",
    weight: 20,
    source: "AGENTS.md § Rules",
    check(data) {
      const first5 = data.calls.slice(0, 5);
      const found = first5.some(
        (c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")
      );
      const pos = data.calls.findIndex(
        (c) => c.name === "Read" && (c.input.file_path || "").endsWith("AGENTS.md")
      );
      return {
        verdict: found ? "FOLLOWED" : "IGNORED",
        evidence: found
          ? `AGENTS.md read at position ${pos + 1}`
          : `First reads: ${data.firstThreeReads.join(", ")}`,
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
    rule: "Read PROJECT-STATE early (first 10 calls)",
    weight: 10,
    source: "AGENTS.md § Key Files",
    check(data) {
      const first10 = data.calls.slice(0, 10);
      const found = first10.some(
        (c) =>
          c.name === "Read" &&
          ((c.input.file_path || "").includes("PROJECT-STATE") ||
            (c.input.file_path || "").includes("project-state.json"))
      );
      return {
        verdict: found ? "FOLLOWED" : "IGNORED",
        evidence: found
          ? "Project state read early"
          : "PROJECT-STATE not read in first 10 calls",
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
    rule: "<= 1 full bun test run",
    weight: 10,
    source: "marcus.md § Additional Never Do",
    check(data) {
      const bunTestRuns = data.bashes.filter(
        (b) => /\bbun test\b/.test(b) && !b.includes("grep")
      );
      return {
        verdict: bunTestRuns.length <= 1 ? "FOLLOWED" : "IGNORED",
        evidence: `${bunTestRuns.length} bun test runs`,
      };
    },
  },
  {
    id: "M-04",
    rule: "Read governing spec before first edit",
    weight: 15,
    source: "marcus.md § Before writing code",
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
    id: "M-05",
    rule: "Read prompts/ before writing code",
    weight: 15,
    source: "marcus.md § Context (MANDATORY)",
    check(data) {
      if (data.edits.length === 0 && data.writes.length === 0) {
        return { verdict: "FOLLOWED", evidence: "No code written — exempt" };
      }
      const promptReads = data.reads.filter((r) => r.includes("prompts/"));
      return {
        verdict: promptReads.length > 0 ? "FOLLOWED" : "IGNORED",
        evidence:
          promptReads.length > 0
            ? `${promptReads.length} prompt(s) read: ${promptReads.map((r) => basename(r)).join(", ")}`
            : "No prompts/ files read",
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
