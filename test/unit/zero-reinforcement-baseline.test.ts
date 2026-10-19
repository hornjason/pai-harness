/**
 * Covers SC-2116 (INSTRUCTION-COMPLIANCE-SPEC.md), #645.
 *
 * The spec section this file backs records a measurement taken on 2026-10-19
 * over `~/.rungate/compliance-history.jsonl` — 377 entries, 193 detected
 * actions, 136 of them landing on `NO_SECTION`. Those numbers are NOT
 * asserted here, and that is deliberate: the store is outside this repository
 * and grows every run, so a case pinning 377 would be red tomorrow for a
 * reason that has nothing to do with the code. The spec records each count
 * beside the command that produced it instead.
 *
 * What IS durable is the two MECHANISM claims the section makes about this
 * repository's own code, and those are the ones a later reader would act on:
 *
 *   1. the section selector reaches `## Testing Rules` for COMP-2 and for
 *      nothing else, so a brief carrying only that heading sends every other
 *      COMP to NO_SECTION;
 *   2. the consecutive-fail counter is reset by an N/A, not merely by a pass.
 *
 * Both are driven through the real functions. The first is the correction
 * #645's own premise needed — the issue says no brief carries the sections,
 * and the measured answer is that two do and the selector cannot reach one of
 * them — so it is the claim most worth making executable rather than leaving
 * as a sentence in a spec nobody runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  applyHillClimb,
  detectHillClimbNeeds,
  setComplianceProjectRoot,
  type HillClimbAction,
} from "../../lib/compliance-report";

const ROLE = "marcus";

let root: string;
let briefPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zero-reinforcement-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  briefPath = join(root, ".claude", "agents", `${ROLE}.md`);
  setComplianceProjectRoot("");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setComplianceProjectRoot("");
});

/** One detected action, as `detectHillClimbNeeds` would hand it over. */
const action = (compId: string): HillClimbAction => ({
  compId,
  rule: `${compId}: the rule text`,
  reinforcement: `${compId}: a reinforcement nothing in this brief already says`,
  consecutiveFails: 4,
  tier: 1,
});

/**
 * What a run over `brief` did with one action for `compId`.
 *
 * Both halves are returned, and the positive cases assert `applied` rather
 * than the ABSENCE of a skip. "No NO_SECTION in the list" is satisfied by an
 * empty list, and an empty list is what a run that did nothing at all
 * produces — the vacuous assertion
 * `.claude/rules/checks-must-be-able-to-fail.md` names, which here would read
 * as the selector working.
 */
function runOne(brief: string, compId: string): { applied: string[]; kinds: string[] } {
  writeFileSync(briefPath, brief);
  const { applied, skipOutcomes } = applyHillClimb(briefPath, [action(compId)], {
    destination: "DISCARD",
  });
  return { applied, kinds: skipOutcomes.map((o) => o.kind) };
}

describe("SC-2116: the selector reaches `## Testing Rules` for COMP-2 and nothing else", () => {
  const TESTING_ONLY = `# Marcus\n\n## Testing Rules\n\n- Write the test first.\n`;

  test("COMP-2 reaches the Testing Rules heading and inserts", () => {
    // The positive control, asserted on what was APPLIED. Without it the case
    // below passes over a selector that reaches nothing at all, which is a
    // different defect reading the same way.
    const { applied, kinds } = runOne(TESTING_ONLY, "COMP-2");
    expect(applied).toHaveLength(1);
    expect(kinds).toEqual([]);
  });

  test("a COMP that is not COMP-2 lands on NO_SECTION in the same brief", () => {
    // #645's real cause, and not the one the issue states. The brief DOES
    // carry one of the three headings the inserter looks for — so the premise
    // "no brief carries the sections" is false — and the action is dropped
    // anyway, because the only heading present is reachable for one COMP id.
    const { applied, kinds } = runOne(TESTING_ONLY, "COMP-7");
    expect(applied).toEqual([]);
    expect(kinds).toContain("NO_SECTION");
  });

  test("the same COMP inserts once the brief carries a heading it can reach", () => {
    // Non-vacuous: COMP-7 is not simply un-insertable. Varying ONE thing —
    // the heading in the brief — flips the outcome, so the case above is
    // about the selector and not about COMP-7.
    const WITH_NEVER_DO = `# Marcus\n\n## Testing Rules\n\n- Write the test first.\n\n## Never Do\n\n- Guess.\n`;
    const { applied, kinds } = runOne(WITH_NEVER_DO, "COMP-7");
    expect(applied).toHaveLength(1);
    expect(kinds).toEqual([]);
  });
});

describe("SC-2116: an N/A resets the consecutive-fail counter", () => {
  /**
   * Driven through the REAL `detectHillClimbNeeds`, not a local copy.
   *
   * `countConsecutiveFails` is not exported, and the obvious move —
   * reimplementing it here and asserting properties of the copy — would be a
   * test of itself: the lib could stop resetting on an N/A entirely and every
   * case would stay green. `detectHillClimbNeeds` is the exported binding
   * that consumes it, so the claim is asked of the thing that does the work.
   */
  const detectsFor = (lastN: string[], compId = "COMP-7"): boolean => {
    const report = {
      role: ROLE,
      compTrends: [{ compId, rule: `${compId}: rule`, lastN, passRate: 0, direction: "stable" }],
    };
    return detectHillClimbNeeds(report as never).some((a) => a.compId === compId);
  };

  test("a qualifying streak is detected — the positive control", () => {
    // Without this, every case below passes over a detector that detects
    // nothing at all, which is a different defect reading the same way.
    expect(detectsFor(["VIOLATED", "IGNORED", "VIOLATED", "IGNORED"])).toBe(true);
  });

  test("one N/A appended to that same streak suppresses it", () => {
    // The pair varies exactly one element (#585), so the difference can only
    // be explained by the verdict that was added.
    const qualifying = ["VIOLATED", "IGNORED", "VIOLATED", "IGNORED"];
    expect(detectsFor(qualifying)).toBe(true);
    expect(detectsFor([...qualifying, "N/A"])).toBe(false);
  });

  test("an N/A truncates rather than being skipped over", () => {
    // What makes this a cause and not a detail: the counter does not step
    // past an N/A and keep counting. Four fails with one N/A third-from-last
    // leave a tail of 1, under the threshold of 3.
    expect(detectsFor(["VIOLATED", "VIOLATED", "VIOLATED", "N/A", "IGNORED"])).toBe(false);
  });

  test("a FOLLOWED truncates it the same way, so the spec's wording is precise", () => {
    // An N/A is not treated specially — the rule is "anything that is not a
    // fail". That is why the section records the mechanism as real and its
    // consequence as PARTIAL: roles whose grades are mostly fails still reach
    // the threshold, measured at 137 runs over the real history.
    expect(detectsFor(["VIOLATED", "VIOLATED", "VIOLATED", "FOLLOWED"])).toBe(false);
  });
});
