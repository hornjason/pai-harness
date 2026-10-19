/**
 * #646 — the persist-compliance receipt reports all five hill-climb outcome
 * states separately.
 *
 * Covers AC-B1, AC-B2, AC-B3, AC-B4 (#646).
 *
 * `persistCompliance` can finish a role five different ways without applying
 * a reinforcement: no action was detected, the grader-accuracy gate dropped
 * the action, the action needs a tier promotion a text patch cannot make, the
 * reinforcement was already in the brief, or the brief had no section to write
 * into. Every one of them used to be a `logger()` line and `hillClimbApplied:
 * 0` — the same receipt a clean run produces. `0` is indistinguishable from
 * success, which is *Silent Default Substitution*
 * (`.claude/rules/config-access.md`).
 *
 * Every case here drives the real `persistCompliance` and reads the RETURNED
 * receipt. Reading the logger instead would assert that a sentence was
 * printed, which is what the defective version already did.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  persistCompliance,
  hillClimbReceipt,
  emptyHillClimbStates,
  classifySkip,
  HILL_CLIMB_STATES,
  UNMEASURED_HILL_CLIMB_STATES,
  type PersistResult,
} from "../../scripts/persist-compliance";
import {
  setComplianceProjectRoot,
  type ComplianceEntry,
} from "../../lib/compliance-report";

const ROLE = "marcus";
/**
 * COMP-13 carries a reinforcement AND a tier-2 promotion in the fallback maps,
 * so one COMP can reach four of the five states depending only on how many
 * consecutive fails its history holds and what the brief contains.
 */
const COMP = "COMP-13";

let root: string;
let workDir: string;
let harnessRoot: string;
let briefPath: string;

/** The history `persistCompliance` reads — one directory above the work dir. */
const historyPath = () => join(root, "compliance-history.jsonl");

function writeState(dir: string) {
  writeFileSync(
    join(dir, "workflow-state.json"),
    JSON.stringify({
      schemaVersion: 2,
      issue: 646,
      slug: "hill-climb-receipt",
      phase: "VERIFY",
      issueGoal: "report all five hill-climb outcome states",
      acs: [],
    }),
  );
}

function writeGrade(verdicts: Record<string, string>) {
  const rules = Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
  const followed = rules.filter(r => r.verdict === "FOLLOWED").length;
  writeFileSync(
    join(workDir, "compliance-grade.json"),
    JSON.stringify({ grades: [{ role: ROLE, total: rules.length, followed, flagged: [], rules }] }),
  );
}

/** Prior runs, oldest first. `generateComplianceReport` reads the last five. */
function seedHistory(runs: Array<Record<string, string>>) {
  const lines = runs.map((verdicts, i) => {
    const rules = Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
    const entry: ComplianceEntry = {
      timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      issue: `#${600 + i}`,
      role: ROLE,
      schema: 2,
      rules,
      total: rules.length,
      followed: rules.filter(r => r.verdict === "FOLLOWED").length,
      pct: 0,
      flagged: [],
    };
    return JSON.stringify(entry);
  });
  writeFileSync(historyPath(), lines.length ? lines.join("\n") + "\n" : "");
}

/** A brief with an insertion point `applyHillClimb` recognises. */
const BRIEF_WITH_SECTION = `# Marcus\n\n## Efficiency Rules\n\n- Batch related reads.\n\n## Workflow\n\n1. Test first.\n`;
/** The same brief with every insertion-point heading removed. */
const BRIEF_WITHOUT_SECTION = `# Marcus\n\n## Context\n\n- Read the brief.\n\n## Workflow\n\n1. Test first.\n`;

function writeBrief(content: string) {
  writeFileSync(briefPath, content);
}

function run(issue = "646"): PersistResult {
  return persistCompliance(workDir, harnessRoot, issue, () => {});
}

function runLogged(issue = "646"): { result: PersistResult; logs: string[] } {
  const logs: string[] = [];
  const result = persistCompliance(workDir, harnessRoot, issue, m => logs.push(m));
  return { result, logs };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hill-climb-receipt-"));
  workDir = join(root, "run");
  harnessRoot = join(root, "harness");
  briefPath = join(harnessRoot, ".claude", "agents", `${ROLE}.md`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "rungate"), { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "agents"), { recursive: true });
  // A fake harness root, so a hill-climb that DOES apply writes a brief in
  // /tmp. A test that patched this repository's own briefs would leave the
  // reinforcement behind for the next run to read as "already present".
  writeFileSync(join(harnessRoot, ".claude", "rungate", "config.json"), JSON.stringify({ project: "fixture" }));
  writeFileSync(
    join(harnessRoot, ".claude", "rungate", "roles.json"),
    JSON.stringify({ [ROLE]: { brief: join(".claude", "agents", `${ROLE}.md`) } }),
  );
  writeState(workDir);
  writeBrief(BRIEF_WITH_SECTION);
  // Pin the reinforcement/promotion/threshold maps to the built-in fallbacks:
  // an empty root resolves no compliance.json. Without this the fixtures would
  // depend on whichever root another test file left in the module's cache.
  setComplianceProjectRoot("");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setComplianceProjectRoot("");
});

describe("#646 AC-B1/AC-B2: one receipt entry per hill-climb outcome state", () => {
  test("NO_ACTIONS_DETECTED: a clean grade says so rather than saying nothing", () => {
    seedHistory([]);
    writeGrade({ [COMP]: "FOLLOWED" });

    const r = run();

    expect(r.hillClimb.states).toEqual({
      ...emptyHillClimbStates(),
      NO_ACTIONS_DETECTED: [
        { role: ROLE, compId: null, detail: "no COMP reached the consecutive-fail threshold" },
      ],
    });
    expect(r.hillClimb.reading).toBe("MEASURED");
    expect(r.hillClimbApplied).toBe(0);
  });

  test("GRADER_ACCURACY_DROP: an action the grader gate dropped is named with its reason", () => {
    // Three N/A, then IGNORED, VIOLATED, VIOLATED (the current run).
    // countConsecutiveFails counts IGNORED *and* VIOLATED, so the tail is 3 —
    // enough for a tier-1 action. The gate counts only IGNORED against N/A, so
    // 3/4 of the checkable verdicts are N/A and it drops the action.
    seedHistory([
      { "COMP-1": "FOLLOWED" },
      { "COMP-1": "FOLLOWED" },
      { "COMP-1": "FOLLOWED" },
      { [COMP]: "IGNORED" },
      { [COMP]: "VIOLATED" },
    ]);
    writeGrade({ [COMP]: "VIOLATED" });

    const r = run();

    expect(r.hillClimb.states.GRADER_ACCURACY_DROP).toEqual([
      { role: ROLE, compId: COMP, detail: "3/4 recent verdicts are N/A" },
    ]);
    // Not "nothing was detected" — something was, and it was thrown away.
    expect(r.hillClimb.states.NO_ACTIONS_DETECTED).toEqual([]);
    expect(r.hillClimb.reading).toBe("MEASURED");
  });

  test("TIER_PROMOTION_RECOMMENDED: a promotion a text patch cannot make is reported", () => {
    // Five consecutive fails and COMP-13 has a tier-2 promotion, so
    // detectHillClimbNeeds raises the tier and applyHillClimb declines to patch.
    seedHistory([
      { [COMP]: "IGNORED" },
      { [COMP]: "IGNORED" },
      { [COMP]: "IGNORED" },
      { [COMP]: "IGNORED" },
    ]);
    writeGrade({ [COMP]: "IGNORED" });

    const r = run();

    expect(r.hillClimb.states.TIER_PROMOTION_RECOMMENDED).toMatchObject([
      { role: ROLE, compId: COMP, detail: expect.stringContaining("PROMOTION needed") },
    ]);
    expect(r.hillClimb.states.REINFORCEMENT_ALREADY_PRESENT).toEqual([]);
    expect(r.hillClimbApplied).toBe(0);
    expect(r.hillClimb.reading).toBe("MEASURED");
  });

  test("REINFORCEMENT_ALREADY_PRESENT: a brief that already carries the rule is reported", () => {
    // The fixture is DERIVED, not typed: the first run writes whatever the
    // live reinforcement map says into the brief, so this cannot drift into
    // asserting a sentence the code stopped producing.
    seedHistory([{ [COMP]: "IGNORED" }, { [COMP]: "IGNORED" }]);
    writeGrade({ [COMP]: "IGNORED" });
    const first = run("645");
    expect(first.hillClimbApplied).toBe(1);
    expect(readFileSync(briefPath, "utf-8")).toContain("REINFORCED (auto)");

    const r = run();

    expect(r.hillClimb.states.REINFORCEMENT_ALREADY_PRESENT).toMatchObject([
      { role: ROLE, compId: COMP, detail: expect.stringContaining("already present") },
    ]);
    expect(r.hillClimbApplied).toBe(0);
    expect(r.hillClimb.reading).toBe("MEASURED");
  });

  test("NO_SUITABLE_SECTION: a brief with no insertion point is UNMEASURED, not clean", () => {
    // AC-B4. The reinforcement was composed and had nowhere to go. A receipt
    // that reported 0 applied would be the same receipt a role with nothing
    // wrong with it produces.
    seedHistory([{ [COMP]: "IGNORED" }, { [COMP]: "IGNORED" }]);
    writeGrade({ [COMP]: "IGNORED" });
    writeBrief(BRIEF_WITHOUT_SECTION);

    const { result: r, logs } = runLogged();

    expect(r.hillClimb.states.NO_SUITABLE_SECTION).toMatchObject([
      { role: ROLE, compId: COMP, detail: expect.stringContaining("no suitable section") },
    ]);
    expect(r.hillClimb.reading).toBe("UNMEASURED");
    expect(r.hillClimb.unmeasuredReasons).toEqual([
      expect.stringContaining("NO_SUITABLE_SECTION"),
    ]);
    expect(logs.join("\n")).toContain("UNMEASURED hill-climb");
    expect(r.hillClimbApplied).toBe(0);
    // The brief was not written, which is why the outcome is unmeasured.
    expect(readFileSync(briefPath, "utf-8")).toBe(BRIEF_WITHOUT_SECTION);
  });

  test("every state is a key on every receipt, so an empty list is a reading", () => {
    seedHistory([]);
    writeGrade({ [COMP]: "FOLLOWED" });
    const r = run();
    expect(Object.keys(r.hillClimb.states).sort()).toEqual([...HILL_CLIMB_STATES].sort());
  });
});

describe("#646 AC-B3: two runs that applied nothing are not the same run", () => {
  test("a run whose every action was skipped differs from a run with no actions", () => {
    // Set up the skipped run first: a brief with no insertion point means the
    // one detected action is skipped, and nothing is applied.
    seedHistory([{ [COMP]: "IGNORED" }, { [COMP]: "IGNORED" }]);
    writeGrade({ [COMP]: "IGNORED" });
    writeBrief(BRIEF_WITHOUT_SECTION);
    const everyActionSkipped = run("646");

    // A second, independent run with a clean grade: no action is detected.
    rmSync(historyPath(), { force: true });
    writeGrade({ [COMP]: "FOLLOWED" });
    const noActionsDetected = run("647");

    // The receipt as it was BEFORE #646 — these two runs were byte-identical,
    // which is the defect, measured rather than asserted.
    const preReceipt = (r: PersistResult) => ({
      ok: r.ok,
      persisted: r.persisted,
      graded: r.graded,
      hillClimbApplied: r.hillClimbApplied,
      verified: r.verified,
    });
    expect(preReceipt(everyActionSkipped)).toEqual(preReceipt(noActionsDetected));

    // The whole receipts, compared directly — not one field of each.
    expect(everyActionSkipped).not.toEqual(noActionsDetected);
  });
});

describe("#646: the reading is derived in one place", () => {
  test("an UNMEASURED-class state raises the reading; the others do not", () => {
    for (const state of HILL_CLIMB_STATES) {
      const states = emptyHillClimbStates();
      states[state].push({ role: ROLE, compId: COMP, detail: "fixture" });
      const receipt = hillClimbReceipt(states, []);
      const expected = UNMEASURED_HILL_CLIMB_STATES.includes(state) ? "UNMEASURED" : "MEASURED";
      expect(`${state}:${receipt.reading}`).toBe(`${state}:${expected}`);
    }
  });

  test("a skip line no state claims raises the reading rather than vanishing", () => {
    // The classifier reads phrases `applyHillClimb` writes. If one is reworded
    // the line must not read as nothing having happened.
    expect(classifySkip("COMP-13: some wording nobody here has seen")).toBeNull();
    const receipt = hillClimbReceipt(emptyHillClimbStates(), [
      { role: ROLE, compId: COMP, detail: "COMP-13: some wording nobody here has seen" },
    ]);
    expect(receipt.reading).toBe("UNMEASURED");
    expect(receipt.unmeasuredReasons).toEqual([expect.stringContaining("UNCLASSIFIED_SKIP")]);
  });
});
