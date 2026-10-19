/**
 * Covers SC-1636..SC-1640 (CONFIG-DRIVEN-TESTING-SPEC.md), #441.
 *
 * `UNMATCHED_CHECKED_RATCHET` counted checked SCs the engine can build no
 * assertion for, and read that number as debt: "marked done, carry no
 * assertion, and are therefore wishes by this project's own rule."
 *
 * That reading was right at 54. It stopped being right once the repo started
 * writing criteria about REFUSALS, because the registry's whole vocabulary —
 * file-exists, content-contains, count-threshold, json-field-equals — is
 * claims about the STATE OF THE TREE, and no state of a tree expresses "X
 * refuses, and says which of two things happened".
 *
 * So 239 → 242 → 252 → 258 across #397, #398 and #399, for criteria that are
 * every one of them covered by executed tests. The only way to lower it was
 * to rewrite them as weaker claims about file contents — lowering the number
 * by making the spec say less. A ratchet that rises whenever an issue writes
 * a good behavioural criterion is measuring the matcher's vocabulary, not the
 * project's honesty.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  splitUnmatchedChecked,
  unclaimedCensusResidue,
  uncoveredTickedScs,
} from "../lib/sc-cover";
import { claimedScKeys, scopedKey } from "../scripts/sync-sc-status";

const REPO = join(import.meta.dir, "..");
const SPECS = join(REPO, "specs");

/**
 * Checked, unmatchable, and no test file declares it.
 *
 * This is the half the old docblock actually meant, and it is a ratchet: it
 * may fall freely, and a rise means a criterion was ticked with nothing
 * testing it.
 *
 * It is NOT the primary refusal. 153 of these 153 are in the census
 * `test/ticked-sc-cover.test.ts` already ratchets PER SPEC, both directions,
 * naming the ids — so banking a second global number here would be two
 * deciders answering one question, and a mutation of either would leave the
 * other holding every case up. The subset relation is asserted below instead,
 * which is what makes this number safe to carry: it cannot drift away from
 * the ratchet that does the refusing.
 */
const UNCLAIMED_RATCHET = 153;

/**
 * Checked, unmatchable, and a test file DOES declare it.
 *
 * Tracked and reported; it does not fail the suite. This is a measure of the
 * registry's vocabulary, and the honest way down is a matcher shape that can
 * express a refusal — see the recorded decision in
 * CONFIG-DRIVEN-TESTING-SPEC.md — not a rewritten criterion.
 *
 * Asserted only for non-vacuity, in both directions. A floor, because a zero
 * here would mean the split collapsed and every assertion below it would hold
 * over an empty set. A ceiling, because "tracked" has to mean somebody
 * notices it moving, and a number nothing can refuse is a number nobody
 * lowers.
 */
// 100 -> 66 on 2026-10-17 (#574). A criterion whose only test was a
// `test.todo` was being counted as claimed, and a todo claims nothing: 34
// of the 100 were ids named by a test that can never run. The number moved
// because the question got stricter, not because anything was bound.
const CLAIMED_UNBINDABLE = 66;

function split() {
  return splitUnmatchedChecked({ projectRoot: REPO, claimed: claimedScKeys(SPECS), scopedKey });
}

describe("SC-1636: unmatched checked SCs are split by whether a test claims them", () => {
  test("both halves are non-empty, so neither assertion below is vacuous", () => {
    const s = split();
    expect(s.unclaimed.length, "nothing landed in the unclaimed half").toBeGreaterThan(0);
    expect(s.claimed.length, "nothing landed in the claimed half").toBeGreaterThan(0);
  });

  test("every row carries the spec that declares it, so a rise is actionable", () => {
    for (const row of [...split().unclaimed, ...split().claimed]) {
      expect(row.specFile, `${row.id} has no spec`).toMatch(/\.md$/);
      expect(row.statement.length, `${row.id} has no statement`).toBeGreaterThan(0);
    }
  });
});

describe("SC-1637: the unclaimed count is the ratchet and may only fall", () => {
  test(`at most ${UNCLAIMED_RATCHET} checked SCs are unmatched AND unclaimed`, () => {
    const unclaimed = split().unclaimed;
    expect(
      unclaimed.length,
      unclaimed.slice(0, 5).map(u => `${u.specFile} ${u.id}`).join("\n"),
    ).toBeLessThanOrEqual(UNCLAIMED_RATCHET);
  });

  test("the ratchet carries no slack, so raising it cannot buy green", () => {
    // A ratchet is `<=`, so raising the constant is invisible to the test
    // above — the vacuity shape in `.claude/rules/checks-must-be-able-to-fail.md`,
    // and the one that measured 0 red on #440's depth bound. Headroom is
    // what makes a ratchet decorative, so the headroom is the assertion:
    // the number must track what was actually measured, and lowering it is
    // an edit somebody makes deliberately.
    expect(
      UNCLAIMED_RATCHET - split().unclaimed.length,
      "the ratchet has slack and would not notice a new untested criterion",
    ).toBe(0);
  });
});

describe("SC-1638: the claimed-but-unbindable count is tracked, not refused", () => {
  test(`the count is ${CLAIMED_UNBINDABLE}, and moving it is visible`, () => {
    // Both directions. A floor alone lets the number grow unremarked, which
    // is how the single ratchet this issue replaces reached 258; a ceiling
    // alone would make it a ratchet, which is the thing #441 argues it must
    // not be. Bracketing it means a move is noticed and then BANKED by
    // editing this line — a decision, rather than a silent rise.
    expect(split().claimed.length).toBe(CLAIMED_UNBINDABLE);
  });

  test("a criterion covered by an executed test is not in the unclaimed half", () => {
    // The specific wrong the issue names. #397's six, #398's ten and #399's
    // six are all executed, and all of them used to count as debt.
    const unclaimed = new Set(split().unclaimed.map(u => u.id));
    const claimed = new Set(split().claimed.map(u => u.id));
    for (const id of ["SC-1506", "SC-1510", "SC-1520"]) {
      expect(claimed.has(id) || !unclaimed.has(id), `${id} is counted as a wish`).toBe(true);
    }
    // At least one of them must actually be in the claimed half, or the
    // assertion above passes by the id having vanished from the specs.
    expect(
      ["SC-1506", "SC-1510", "SC-1520"].some(id => claimed.has(id)),
      "none of the three is in the claimed half, so the loop proved nothing",
    ).toBe(true);
  });
});

describe("SC-1639: the split does not become a second decider", () => {
  test("every unclaimed criterion is one the per-spec census already governs", () => {
    // 154 of 154, measured. `test/ticked-sc-cover.test.ts` ratchets that
    // census per spec, both directions, naming the ids — so it is the one
    // place a new untested criterion is refused, and this file must not
    // quietly become a second one. The relationship is checked rather than
    // assumed, so the two cannot drift apart.
    const claimed = claimedScKeys(SPECS);
    const s = splitUnmatchedChecked({ projectRoot: REPO, claimed, scopedKey });
    const census = uncoveredTickedScs({ specsDir: SPECS, projectRoot: REPO, claimed, scopedKey });
    const residue = unclaimedCensusResidue({ unclaimed: s.unclaimed, census, scopedKey });

    expect(
      residue.onlyUnclaimed,
      "a criterion is refused here that the per-spec ratchet cannot see",
    ).toEqual([]);
  });

  test("the census residue is only what `testable: no` explains", () => {
    // The other direction, and it must stay small and named. The census
    // reads every spec; the split reads only testable ones, so a
    // `testable: no` spec is in one population and not the other. Naming
    // the ids means a THIRD cause appearing is a failure rather than a
    // number that drifted.
    const claimed = claimedScKeys(SPECS);
    const s = splitUnmatchedChecked({ projectRoot: REPO, claimed, scopedKey });
    const census = uncoveredTickedScs({ specsDir: SPECS, projectRoot: REPO, claimed, scopedKey });
    const residue = unclaimedCensusResidue({ unclaimed: s.unclaimed, census, scopedKey });

    expect(residue.onlyCensus).toEqual([
      "DA-COMPLIANCE-SPEC.md::SC-440",
      "DA-COMPLIANCE-SPEC.md::SC-441",
    ]);
  });
});

describe("SC-1640: both halves are proved against a planted spec and test", () => {
  // Fixture ids in the 9700 range. A real id written anywhere in a test file
  // is read by sync-sc-status as a coverage claim for that criterion (#149),
  // so fixtures use numbers this repo does not issue.
  const UNMATCHABLE = "The runner refuses, and says which of two things happened";

  function plant(opts: { withTest: boolean }): { root: string; testDir: string } {
    const root = mkdtempSync(join(tmpdir(), "rg-441-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "specs", "PLANTED-SPEC.md"),
      ["---", "doc-type: spec", "testable: true", "governs: a planted thing", "---", "",
       "# Planted", "", "## Success Criteria", "",
       `- [x] SC-9701: ${UNMATCHABLE}`, ""].join("\n"),
    );
    if (opts.withTest) {
      writeFileSync(
        join(root, "test", "planted.test.ts"),
        ['import { test, expect } from "bun:test";', "",
         'test("SC-9701: the runner refuses", () => { expect(1).toBe(1); });', ""].join("\n"),
      );
    }
    return { root, testDir: join(root, "test") };
  }

  test("a planted SC with no test lands in unclaimed and NOT in claimed", () => {
    const { root, testDir } = plant({ withTest: false });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(s.unclaimed.map(u => u.id)).toContain("SC-9701");
      expect(s.claimed.map(u => u.id), "an unclaimed SC escaped the ratchet").not.toContain("SC-9701");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the same SC with a test that declares it moves to claimed", () => {
    // One input, one difference: the test file. Both directions over the
    // same planted criterion, so neither bucket can be right by accident.
    const { root, testDir } = plant({ withTest: true });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(s.claimed.map(u => u.id)).toContain("SC-9701");
      expect(
        s.unclaimed.map(u => u.id),
        "a criterion with an executed test is still counted as a wish",
      ).not.toContain("SC-9701");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the planted criterion really is unmatchable, or neither case proves anything", () => {
    // The vacuity guard the two cases above depend on. If a matcher ever
    // binds this sentence, both land in neither half and both assertions
    // pass over an empty set.
    const { root, testDir } = plant({ withTest: false });
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), testDir),
        scopedKey,
      });
      expect(
        s.unclaimed.length + s.claimed.length,
        "the planted SC bound to a matcher, so the cases above are vacuous",
      ).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a SUPERSEDED tick is in neither half", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-441-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "specs", "PLANTED-SPEC.md"),
      ["---", "doc-type: spec", "testable: true", "governs: a planted thing", "---", "",
       "# Planted", "", "## Success Criteria", "",
       "- [x] SC-9702: SUPERSEDED by SC-9701 — was a refusal claim", ""].join("\n"),
    );
    try {
      const s = splitUnmatchedChecked({
        projectRoot: root,
        claimed: claimedScKeys(join(root, "specs"), join(root, "test")),
        scopedKey,
      });
      expect(s.unclaimed.map(u => u.id)).not.toContain("SC-9702");
      expect(s.claimed.map(u => u.id)).not.toContain("SC-9702");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
