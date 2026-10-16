/**
 * Covers SC-1575..SC-1582 (HARNESS-GATES.md), #423.
 *
 * Two gate checks named a verdict over a body that could only `console.warn`.
 * #423 settles them in opposite directions, and the interesting part is that
 * the SAME evidence standard produced both answers:
 *
 * - `outcome-evidence-behavioral` asserts now. Driven red by a real OUTCOME
 *   AC carrying numeric-only evidence and green with behavioral evidence
 *   beside it, which is AC-2 of the issue.
 * - `ac-issue-alignment` keeps warning. Driven both ways too — a goal whose
 *   keywords ARE covered scores above the threshold — because AC-3 says it
 *   plainly: a check that fires on every issue is worse than one that never
 *   does, and this one fires on 71% of the real runs on this machine.
 *
 * Whether each check asserts is not read out of the source by hand. It is
 * asked of `gateChecks`, the parser #183 built for exactly this question, so
 * the two directions are enforced by the same binding and one of them cannot
 * quietly become the other.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  outcomeEvidenceViolations,
  isBareMeasurement,
  goalKeywordCoverage,
  GOAL_COVERAGE_WARN_BELOW,
} from "../lib/ac-quality";
import { gateChecks } from "../lib/gate-check-audit";

const REPO_ROOT = join(import.meta.dir, "..");
const gateSource = readFileSync(join(REPO_ROOT, "gates", "workflow.test.ts"), "utf-8");

const BEHAVIORAL = "navigated to /settings, toggled Dark mode, the page re-rendered dark";

describe("SC-1575: an OUTCOME AC's evidence has to say something", () => {
  test("a bare number is refused and behavioral evidence beside it is not", () => {
    const numeric = [
      { id: "AC-1", type: "OUTCOME", verdict: "PASS", evidence: { content: "3" } },
    ];
    expect(outcomeEvidenceViolations(numeric)).toHaveLength(1);
    expect(outcomeEvidenceViolations(numeric)[0]).toContain("AC-1");

    // The control AC-2 of the issue asks for, in the same shape: one OUTCOME
    // AC, PASS, with evidence a reader can check.
    const behavioral = [
      { id: "AC-1", type: "OUTCOME", verdict: "PASS", evidence: { content: BEHAVIORAL } },
    ];
    expect(outcomeEvidenceViolations(behavioral), "a real observation was refused").toEqual([]);
  });

  test("a number inside a sentence is evidence; the sentence is what makes it one", () => {
    // The boundary from the side that must still pass. "3" on its own says a
    // number was produced; "3 rows appeared in the table" says what happened.
    expect(outcomeEvidenceViolations([
      { id: "AC-1", type: "OUTCOME", verdict: "PASS", evidence: { content: "3 rows appeared in the table" } },
    ])).toEqual([]);
  });

  test("every AC is reported, not just the first", () => {
    // A check that stops at one violation makes a second one invisible until
    // the first is fixed, which is two ship runs to learn one thing.
    const violations = outcomeEvidenceViolations([
      { id: "AC-1", type: "OUTCOME", verdict: "PASS", evidence: { content: "1" } },
      { id: "AC-2", type: "OUTCOME", verdict: "PASS", evidence: { content: BEHAVIORAL } },
      { id: "AC-3", type: "OUTCOME", verdict: "PASS", evidence: { content: "0" } },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations.join(" ")).toContain("AC-3");
  });
});

describe("SC-1576: the detector is as wide as the thing it detects", () => {
  test("a reformatted non-answer is still a non-answer", () => {
    // The inline body asked `/^\d+$/`, which read `3` as a bare number and
    // `3/3`, `12%`, `0.0` and `-1` as behavioral evidence. That is the second
    // shape in .claude/rules/checks-must-be-able-to-fail.md — a detector
    // narrower than what it detects — and every form below walked through it.
    for (const content of ["3", "0", "3/3", "12%", "0.0", "-1", " 42 ", "1,024", "0%"]) {
      expect(isBareMeasurement(content), `${JSON.stringify(content)} read as behavioral`).toBe(true);
    }
  });

  test("anything carrying a word is left alone", () => {
    // The positive control. A detector that called everything bare would
    // satisfy every case above and block every run.
    for (const content of [BEHAVIORAL, "3 files", "PASS", "ok", "200 OK", "v2"]) {
      expect(isBareMeasurement(content), `${JSON.stringify(content)} refused`).toBe(false);
    }
  });

  test("absence is a different question, and is deliberately not this one", () => {
    // `all-acs-have-evidence` exempts OUTCOME ACs from mechanical evidence at
    // ship time by design. Answering it here too would be two deciders on one
    // question — the fourth shape (#420) — so this one stays silent about it.
    expect(isBareMeasurement("")).toBe(false);
    expect(isBareMeasurement("   ")).toBe(false);
    expect(isBareMeasurement(undefined)).toBe(false);
    expect(isBareMeasurement(null)).toBe(false);
    expect(outcomeEvidenceViolations([
      { id: "AC-1", type: "OUTCOME", verdict: "PASS", evidence: null },
      { id: "AC-2", type: "OUTCOME", verdict: "PASS" },
    ])).toEqual([]);
  });
});

describe("SC-1577: the check looks at OUTCOME ACs that passed, and nothing else", () => {
  test("a CODE AC with a count is not this check's business", () => {
    // A CODE AC's evidence IS often a count — a grep hit, a test total — and
    // widening to those would turn a fix into an outage.
    expect(outcomeEvidenceViolations([
      { id: "AC-1", type: "CODE", verdict: "PASS", evidence: { content: "7" } },
    ])).toEqual([]);
  });

  test("an OUTCOME AC that did not pass is left to its own handler", () => {
    // Reporting it twice under a different reason would misattribute the
    // failure — the same reasoning `implementRefusal` already follows for a
    // result that arrived already-failed.
    for (const verdict of ["FAIL", "SKIP", "PENDING", undefined]) {
      expect(outcomeEvidenceViolations([
        { id: "AC-1", type: "OUTCOME", verdict, evidence: { content: "3" } },
      ]), `verdict ${verdict} was judged`).toEqual([]);
    }
  });

  test("a missing or malformed ac list is empty, not a crash", () => {
    for (const acs of [undefined, null, {}, "acs", []]) {
      expect(outcomeEvidenceViolations(acs)).toEqual([]);
    }
  });
});

describe("SC-1578: the gate check asserts now, and the parser says so", () => {
  test("outcome-evidence-behavioral is read as asserting by the #183 parser", () => {
    const check = gateChecks(gateSource)
      .find(c => c.name.startsWith("outcome-evidence-behavioral"));
    expect(check, "the check is gone from the gate suite entirely").toBeTruthy();
    expect(check!.hasAssertion, "it is still only warning").toBe(true);
  });

  test("it calls the one binding rather than recomputing the reading inline", () => {
    // An inline copy would be a second decider — it could drift from this
    // file's cases and nothing would notice, because both would be green.
    expect(gateSource).toContain("outcomeEvidenceViolations(sf(\"acs\"))");
    expect(gateSource, "the warn it replaced is still there")
      .not.toContain("OUTCOME AC(s) have numeric-only evidence");
  });
});

describe("SC-1579: ac-issue-alignment measures, and still does not refuse", () => {
  test("the parser reads it as warn-only, which is the decision", () => {
    const check = gateChecks(gateSource).find(c => c.name.startsWith("ac-issue-alignment"));
    expect(check, "the check is gone from the gate suite entirely").toBeTruthy();
    expect(
      check!.hasAssertion,
      "ac-issue-alignment started refusing — it fires on 71% of real runs, so this " +
        "blocks two runs in three. If that is intended, the WARN_TIER_CHECKS entry and " +
        "the measurement in it have to be rewritten first",
    ).toBe(false);
  });

  test("SC-1580: a goal whose keywords ARE covered scores above the threshold", () => {
    // AC-3's control. Without it, a coverage function returning 0 for
    // everything would satisfy every "fires correctly" case below.
    const goal = "the scaffold should refuse an existing config rather than overwrite it";
    const covered = goalKeywordCoverage(goal, [
      { statement: "scaffold refuses when a config already exists" },
      { statement: "nothing is overwritten and the existing file is unchanged" },
    ]);
    expect(covered).not.toBeNull();
    expect(covered!.coverage).toBeGreaterThanOrEqual(GOAL_COVERAGE_WARN_BELOW);

    const unrelated = goalKeywordCoverage(goal, [
      { statement: "the button turns green" },
    ]);
    expect(unrelated!.coverage).toBeLessThan(GOAL_COVERAGE_WARN_BELOW);
  });

  test("SC-1581: nothing to ask is null, which is not the same as zero coverage", () => {
    // `0`, `{}`, `null` and `SKIP` being indistinguishable from success is
    // the Silent Default Substitution anti-pattern. A goal of nothing but
    // short words has not been measured at 0% — it has not been measured.
    expect(goalKeywordCoverage("", [{ statement: "x" }])).toBeNull();
    expect(goalKeywordCoverage("   ", [{ statement: "x" }])).toBeNull();
    expect(goalKeywordCoverage("a be of to the and", [{ statement: "x" }])).toBeNull();
    expect(goalKeywordCoverage(undefined, [])).toBeNull();

    const zero = goalKeywordCoverage("configuration directory layout", []);
    expect(zero, "a real goal with no ACs is a measured zero, not an absence").not.toBeNull();
    expect(zero!.coverage).toBe(0);
  });

  test("SC-1582: the reading is case-insensitive and ignores punctuation, as the goal is prose", () => {
    const read = goalKeywordCoverage("Refuse the Overwrite, always.", [
      { statement: "REFUSES to overwrite" },
    ]);
    expect(read!.covered).toContain("refuse");
    expect(read!.covered).toContain("overwrite");
  });
});
