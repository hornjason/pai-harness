/**
 * #662 — the two paths #646 did not reach.
 *
 * #646 made `persistCompliance` say WHICH of five outcomes a hill-climb
 * reached instead of printing `hillClimbApplied: 0` for all of them. Two
 * sibling paths reach a `continue` ABOVE the place those five are
 * enumerated, so they kept the behaviour the issue was filed to abolish:
 *
 *  - a role with no registered brief. The actions were detected, survived
 *    the grader-accuracy gate, and were discarded with a `logger()` line.
 *  - `applyHillClimb` returning neither an application nor a skip for an
 *    action it was handed. Nothing required its two arrays to account for
 *    its input.
 *
 * In both the receipt's state lists are all empty for that role, which is
 * what a role that needed nothing produces. `.claude/rules/config-access.md`:
 * `0`, `{}`, `null` and `SKIP` are indistinguishable from success.
 *
 * Both new states are UNMEASURED, and that is the claim rather than a
 * classification detail: in neither case did anybody find out what applying
 * the reinforcement would have done.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  HILL_CLIMB_STATES,
  UNMEASURED_HILL_CLIMB_STATES,
  persistCompliance,
  type PersistResult,
  type PersistSeams,
} from "../../scripts/persist-compliance";
import {
  setComplianceProjectRoot,
  type ComplianceEntry,
} from "../../lib/compliance-report";

const ROLE = "marcus";
/** COMP-13 carries a reinforcement in the fallback maps. */
const COMP = "COMP-13";

let root: string;
let workDir: string;
let harnessRoot: string;
let briefPath: string;

const historyPath = () => join(root, "compliance-history.jsonl");

const BRIEF_WITH_SECTION = "# Marcus\n\n## Efficiency Rules\n\n- Batch related reads.\n";

/** Prior runs, oldest first. */
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
  writeFileSync(historyPath(), lines.length ? `${lines.join("\n")}\n` : "");
}

function writeGrade(verdicts: Record<string, string>) {
  const rules = Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict }));
  writeFileSync(
    join(workDir, "compliance-grade.json"),
    JSON.stringify({
      grades: [{
        role: ROLE,
        total: rules.length,
        followed: rules.filter(r => r.verdict === "FOLLOWED").length,
        flagged: [],
        rules,
      }],
    }),
  );
}

/** Register the role's brief, or don't. */
function writeRoles(registered: boolean) {
  writeFileSync(
    join(harnessRoot, ".claude", "rungate", "roles.json"),
    JSON.stringify(registered ? { [ROLE]: { brief: join(".claude", "agents", `${ROLE}.md`) } } : {}),
  );
}

function run(issue = "662", seams: PersistSeams = {}): PersistResult {
  return persistCompliance(workDir, harnessRoot, issue, () => {}, seams);
}

function runLogged(issue = "662", seams: PersistSeams = {}): { result: PersistResult; logs: string[] } {
  const logs: string[] = [];
  const result = persistCompliance(workDir, harnessRoot, issue, m => logs.push(m), seams);
  return { result, logs };
}

/**
 * The grade and history that produce exactly one action reaching the brief.
 *
 * Two prior IGNOREDs plus an IGNORED this run is three consecutive fails,
 * which is a tier-1 action, and no verdict is N/A so the grader-accuracy
 * gate does not drop it. Shared by every case here precisely so the thing
 * each case varies is the only thing that differs.
 */
function oneActionDetected() {
  seedHistory([{ [COMP]: "IGNORED" }, { [COMP]: "IGNORED" }]);
  writeGrade({ [COMP]: "IGNORED" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hill-climb-unaccounted-"));
  workDir = join(root, "run");
  harnessRoot = join(root, "harness");
  briefPath = join(harnessRoot, ".claude", "agents", `${ROLE}.md`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "rungate"), { recursive: true });
  mkdirSync(join(harnessRoot, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(harnessRoot, ".claude", "rungate", "config.json"),
    JSON.stringify({ project: "fixture" }),
  );
  writeRoles(true);
  writeFileSync(
    join(workDir, "workflow-state.json"),
    JSON.stringify({
      schemaVersion: 2,
      issue: 662,
      slug: "hill-climb-unaccounted",
      phase: "VERIFY",
      issueGoal: "name the two paths that recorded no state",
      acs: [],
    }),
  );
  writeFileSync(briefPath, BRIEF_WITH_SECTION);
  // Pin the reinforcement and threshold maps to the built-in fallbacks.
  setComplianceProjectRoot("");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setComplianceProjectRoot("");
});

/**
 * The premise every case below depends on, run as its own case.
 *
 * Criterion 4. If the fixture silently stopped detecting an action, every
 * case here would be asserting a state over a role that genuinely needed
 * nothing — and the receipt would be right to be empty. A fixture that
 * supplied nothing must not be able to reach the assertions.
 */
describe("#662: the fixture really does hand the brief an action", () => {
  test("one action is detected, survives the grader gate, and is applied", () => {
    oneActionDetected();
    const r = run();
    expect(r.hillClimbApplied).toBe(1);
    expect(r.hillClimb.states.NO_ACTIONS_DETECTED).toEqual([]);
    expect(r.hillClimb.states.GRADER_ACCURACY_DROP).toEqual([]);
    expect(r.hillClimb.reading).toBe("MEASURED");
  });
});

describe("#662 instance 1: a role with no registered brief", () => {
  test("NO_BRIEF_REGISTERED is named, and the reading is UNMEASURED", () => {
    oneActionDetected();
    writeRoles(false);

    const { result: r, logs } = runLogged();

    expect(r.hillClimb.states.NO_BRIEF_REGISTERED).toMatchObject([
      { role: ROLE, compId: null, detail: expect.stringContaining("1 action(s) were detected") },
    ]);
    // Not "nothing was detected" — something was, and it was discarded.
    expect(r.hillClimb.states.NO_ACTIONS_DETECTED).toEqual([]);
    expect(r.hillClimb.reading).toBe("UNMEASURED");
    expect(r.hillClimb.unmeasuredReasons).toEqual([
      expect.stringContaining("NO_BRIEF_REGISTERED"),
    ]);
    expect(r.hillClimbApplied).toBe(0);

    // The `logger` line stays, and it is not the fix. #646 established that
    // the receipt is the position and the transcript is not.
    expect(logs.join("\n")).toContain("no brief registered");
  });

  test("it is distinguishable from a clean run, which is the whole claim", () => {
    oneActionDetected();
    writeRoles(false);
    const discarded = run("662");

    rmSync(historyPath(), { force: true });
    writeGrade({ [COMP]: "FOLLOWED" });
    writeRoles(true);
    const clean = run("663");

    // Equal in every field the pre-#662 receipt carried for these two runs…
    expect(discarded.hillClimbApplied).toBe(clean.hillClimbApplied);
    expect(discarded.verified).toEqual(clean.verified);

    // …and the discarded run leaves an occurrence behind, which is the
    // property this case is about.
    //
    // An earlier draft asserted `discarded.hillClimb` differs from
    // `clean.hillClimb` as a whole, and that was GREEN with the new state
    // deleted — measured, 1 red where 2 was predicted. The two receipts
    // differ anyway, because the clean run names NO_ACTIONS_DETECTED. The
    // case was satisfied by #646's work and witnessed none of #662's.
    const occurrences = Object.values(discarded.hillClimb.states).flat();
    expect(occurrences.length, "the discarded run left an all-empty receipt").toBeGreaterThan(0);
    expect(discarded.hillClimb.reading).toBe("UNMEASURED");
    expect(clean.hillClimb.reading).toBe("MEASURED");
  });
});

describe("#662 instance 2: an answer that does not account for its input", () => {
  /** A reply that reports nothing about the actions it was handed. */
  const silent: PersistSeams = {
    applyHillClimb: () => ({
      applied: [],
      skipped: [],
      skipOutcomes: [],
      write: { destination: "DISCARD", path: null },
    }),
  };

  test("OUTCOMES_UNACCOUNTED is named, and the reading is UNMEASURED", () => {
    oneActionDetected();

    const r = run("662", silent);

    expect(r.hillClimb.states.OUTCOMES_UNACCOUNTED).toMatchObject([
      {
        role: ROLE,
        compId: null,
        detail: expect.stringContaining("1 action(s) went in"),
      },
    ]);
    expect(r.hillClimb.reading).toBe("UNMEASURED");
    expect(r.hillClimb.unmeasuredReasons).toEqual([
      expect.stringContaining("OUTCOMES_UNACCOUNTED"),
    ]);
    expect(r.hillClimbApplied).toBe(0);
    // Every other list is empty, which is exactly why this one has to exist:
    // without it the receipt for this run is the receipt for a clean one.
    expect(r.hillClimb.states.NO_ACTIONS_DETECTED).toEqual([]);
    expect(r.hillClimb.states.NO_SUITABLE_SECTION).toEqual([]);
  });

  test("a PARTIAL accounting is caught too — the guard counts, it does not ask for empty", () => {
    // The cheapest wrong guard here is `applied.length === 0 &&
    // skipped.length === 0`, which is satisfied by a reply accounting for
    // one of two actions. Two actions, one skip reported, is the input only
    // a counted guard refuses.
    // COMP-6 also carries a reinforcement in the fallback map, and its
    // promotion is tier 2 — out of reach at three consecutive fails, so
    // both actions are ordinary tier-1 patches.
    seedHistory([
      { [COMP]: "IGNORED", "COMP-6": "IGNORED" },
      { [COMP]: "IGNORED", "COMP-6": "IGNORED" },
    ]);
    writeGrade({ [COMP]: "IGNORED", "COMP-6": "IGNORED" });
    const twoActions = run("664");
    expect(twoActions.hillClimbApplied, "the fixture no longer produces two actions").toBe(2);

    const partial: PersistSeams = {
      applyHillClimb: () => ({
        applied: [],
        skipped: ["only one of them was considered"],
        skipOutcomes: [],
        write: { destination: "DISCARD", path: null },
      }),
    };
    const r = run("665", partial);

    expect(r.hillClimb.states.OUTCOMES_UNACCOUNTED).toMatchObject([
      { role: ROLE, detail: expect.stringContaining("2 action(s) went in") },
    ]);
    expect(r.hillClimb.reading).toBe("UNMEASURED");
  });

  test("a reply that accounts for everything records no unaccounted state", () => {
    // The control. Without it a guard that fired on every call would pass
    // both cases above having witnessed nothing.
    oneActionDetected();
    const r = run("662");
    expect(r.hillClimb.states.OUTCOMES_UNACCOUNTED).toEqual([]);
    expect(r.hillClimb.reading).toBe("MEASURED");
  });
});

describe("#662: the two states are declared where the receipt has to survive", () => {
  test("both are in HILL_CLIMB_STATES and in the UNMEASURED set", () => {
    expect(HILL_CLIMB_STATES).toContain("NO_BRIEF_REGISTERED");
    expect(HILL_CLIMB_STATES).toContain("OUTCOMES_UNACCOUNTED");
    expect(UNMEASURED_HILL_CLIMB_STATES).toContain("NO_BRIEF_REGISTERED");
    expect(UNMEASURED_HILL_CLIMB_STATES).toContain("OUTCOMES_UNACCOUNTED");
  });

  // The relay declaration is checked by test/persist-receipt-relay.test.ts,
  // which walks a receipt the real persistCompliance produced against the
  // literal in workflows/ship.js. A second list here would be a second
  // decider for the same question, and a mutation of either would leave the
  // other holding the case up.
});
