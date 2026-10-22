/**
 * The verifier jury: quorum, category filter, severity tags (#1187).
 *
 * Two things in here are doing real work and the rest is bookkeeping.
 *
 * `JURY-1` holds the **refusals**: a short group, a repeated verifier and a
 * non-majority quorum each report UNMEASURED rather than deciding, which is
 * #1187's doctrine applied to the one input that arrives as a judgement.
 *
 * `JURY-4` is the **planted control for the category filter**, and it is the
 * row to read before any of the corpus numbers. The filter drops zero
 * findings across 427 real issues on this tracker; a filter that cannot fire
 * at all would report exactly the same zero, and nothing else in this file
 * tells those two readings apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the inert-knob shape).
 */

import { describe, expect, test } from "bun:test";

import {
  classifyCategory,
  DROPPED_CATEGORIES,
  juryCategory,
  juryReading,
  renderComment,
  severityOf,
  SEVERITY_RANK,
  VERIFIER_GROUP_SIZE,
  VERIFIER_QUORUM,
  type VerifierVote,
} from "../lib/finding-jury";

const vote = (verifier: string, real: boolean, extra: Partial<VerifierVote> = {}): VerifierVote => ({
  verifier,
  real,
  reason: "because",
  ...extra,
});

describe("JURY-1: an unreadable vote refuses, it does not decide", () => {
  test("a full group that agrees passes", () => {
    const r = juryReading([vote("a", true), vote("b", true), vote("c", false)]);
    expect(r.reading).toBe("MEASURED");
    expect(r.passed).toBe(true);
    expect(r.agree).toBe(2);
  });

  test("CONTROL: a full group that does not agree fails, and it is MEASURED", () => {
    const r = juryReading([vote("a", true), vote("b", false), vote("c", false)]);
    expect(r.reading).toBe("MEASURED");
    expect(r.passed).toBe(false);
  });

  test("a short group is UNMEASURED — an absent vote is neither agreement nor dissent", () => {
    // Two YES votes would clear a quorum of 2 if the group size were ignored.
    // That is the whole hazard: it is indistinguishable from a real pass.
    const r = juryReading([vote("a", true), vote("b", true)]);
    expect(r.agree).toBe(VERIFIER_QUORUM);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.passed).toBe(false);
  });

  test("one verifier voting three times is one opinion, not a group", () => {
    const r = juryReading([vote("a", true), vote("a", true), vote("a", true)]);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain("independent");
  });

  test("a quorum that is not a strict majority is a configuration refusal", () => {
    const r = juryReading([vote("a", true), vote("b", false), vote("c", false)], { groupSize: 3, quorum: 1 });
    expect(r.reading).toBe("UNMEASURED");
    expect(r.passed).toBe(false);
  });

  test("the cardinalities are configurable, and 5/3 behaves", () => {
    const five = [vote("a", true), vote("b", true), vote("c", true), vote("d", false), vote("e", false)];
    const r = juryReading(five, { groupSize: 5, quorum: 3 });
    expect(r.reading).toBe("MEASURED");
    expect(r.passed).toBe(true);
  });

  test("the defaults are 2 of 3 and are stated as defaults, not derived", () => {
    expect(VERIFIER_GROUP_SIZE).toBe(3);
    expect(VERIFIER_QUORUM).toBe(2);
    // A strict majority, which is what makes the group a gate rather than an OR.
    expect(VERIFIER_QUORUM * 2).toBeGreaterThan(VERIFIER_GROUP_SIZE);
  });
});

describe("JURY-2: the category is the verifiers' when they gave one", () => {
  test("a verifier majority beats the keyword fallback", () => {
    const finding = { title: "commandWord returns the wrong verb", body: "x" };
    expect(classifyCategory(finding)).toBe("correctness");
    const votes = [
      vote("a", true, { category: "cleanup" }),
      vote("b", true, { category: "cleanup" }),
      vote("c", true, { category: "correctness" }),
    ];
    expect(juryCategory(finding, votes)).toBe("cleanup");
  });

  test("a verifier who called it NOT real does not get to categorise it", () => {
    const finding = { title: "an unremarkable title", body: "x" };
    expect(juryCategory(finding, [vote("a", false, { category: "style" })])).toBe("unclassified");
  });
});

describe("JURY-3: Pre-existing is a fact about the diff, not a judgement", () => {
  const finding = { title: "a reading", body: "`widgetHandler` drops the operand in `lib/widget.ts`." };

  test("a finding citing no changed file is Pre-existing, whatever the verifiers said", () => {
    const votes = [vote("a", true, { severity: "Important" }), vote("b", true, { severity: "Important" })];
    expect(severityOf(finding, votes, ["lib/other.ts"])).toBe("Pre-existing");
  });

  test("CONTROL: the same finding citing a changed file is not Pre-existing", () => {
    const votes = [vote("a", true, { severity: "Important" }), vote("b", true, { severity: "Important" })];
    expect(severityOf(finding, votes, ["lib/widget.ts"])).toBe("Important");
  });

  test("with no diff read, the pre-existing axis is not available and the votes decide", () => {
    expect(severityOf(finding, [vote("a", true, { severity: "Nit" })])).toBe("Nit");
  });

  test("nothing to read it from is null, never a guessed Important", () => {
    expect(severityOf(finding, [vote("a", true)])).toBeNull();
  });

  test("the three tags sort Important, Pre-existing, Nit", () => {
    expect(SEVERITY_RANK.Important).toBeLessThan(SEVERITY_RANK["Pre-existing"]);
    expect(SEVERITY_RANK["Pre-existing"]).toBeLessThan(SEVERITY_RANK.Nit);
  });

  test("a posted comment carries its tag and the obligation to answer", () => {
    const text = renderComment(finding, "Pre-existing", "correctness");
    expect(text).toContain("**Pre-existing**");
    expect(text).toContain("resolve this thread with a reason");
  });
});

/**
 * THE PLANTED CONTROL. Read this before `JURY-5`.
 *
 * One finding of each dropped category and one correctness finding that must
 * survive. Without this row, `JURY-5`'s zero is indistinguishable from a
 * filter that matches nothing at all.
 */
describe("JURY-4: the category filter can fire, and it spares the control", () => {
  const planted = [
    { title: "Nit: rename the variable in bash-write-guard", expected: "style" },
    { title: "The error message does not say which file was refused", expected: "diagnostics" },
    { title: "Unused import of statSync left behind after the refactor", expected: "cleanup" },
  ] as const;

  for (const p of planted) {
    test(`a ${p.expected} finding is dropped`, () => {
      const c = classifyCategory({ title: p.title, body: "" });
      expect(c).toBe(p.expected);
      expect(DROPPED_CATEGORIES.has(c)).toBe(true);
    });
  }

  test("CONTROL: a correctness finding in the same shape survives", () => {
    const c = classifyCategory({
      title: "commandWord returns the wrong verb for a quoted assignment prefix",
      body: "",
    });
    expect(DROPPED_CATEGORIES.has(c)).toBe(false);
    expect(c).toBe("correctness");
  });

  test("the drop list is the three the source design names, and no fourth", () => {
    expect([...DROPPED_CATEGORIES].sort()).toEqual(["cleanup", "diagnostics", "style"]);
  });
});

/**
 * THE BACKWARDS MEASUREMENT, as a ceiling rather than a quoted number.
 *
 * The source design A/B tested its filters before keeping them. The
 * backwards-equivalent available here is to run the filter over findings
 * whose outcome is already known. Reproduce with:
 *
 *     gh issue list --repo hornjason/pai-harness --state closed --limit 400 \
 *       --json number,title,stateReason
 *
 * Measured 2026-10-22 over the 385 closed as COMPLETED — closed by a merged
 * PR, so somebody wrote the fix, so they were real: **0 dropped**. Same over
 * the 15 closed NOT_PLANNED and the 27 then open: **0 each**.
 *
 * The titles below are the eight that a whole-text scope DID drop, kept as
 * the regression: each is a real finding whose body quotes drop vocabulary in
 * passing, and #781's body contains the sentence *"the reason this is not
 * just a wording fix"*. If a later widening re-admits any of them, this goes
 * red naming the one it re-admitted.
 */
describe("JURY-5: what the filter would have dropped on real findings", () => {
  const realFindings = [
    "detectPriorBranch's commit-subject reading has no behavioural case — measured 1 red where 3 was predicted",
    "#652's battery provenance says the implementation has not landed, and it landed",
    "key-files.md hardcodes \"PROJECT-STATE.md is generated from project-state.json\" — false on asaCommandCenter",
    "#621 Phase 2: Suite measurement — record the measured `--parallel` mutation in the spec",
    "specs/PROJECT-STATE.md is a rendered snapshot from 2026-09-22, and the routing table calls it a spec",
    "environments.local is only ever written by a healing agent, and four gates refuse without it",
    "worktree cleanup reports a pruned worktree as an error forever and can never remove it",
    "Six phase-ordering checks assert on comments, so they pass whatever the code does",
    "The ai-review adjudication branch is dead code under GitHub's bash -e: a blocking refusal never runs",
    "A ship run lost its whole collection because filesChanged entries carried prose",
    "templateResidue compares whole lines, so any reflow of the template prose defeats it",
  ];

  test("none of the eleven real findings a wider scope dropped is dropped now", () => {
    const dropped = realFindings.filter(title => DROPPED_CATEGORIES.has(classifyCategory({ title, body: "" })));
    expect(dropped).toEqual([]);
  });

  test("a body quoting drop vocabulary does not drop the finding — the scope is the title", () => {
    const finding = {
      title: "commandWord returns the wrong verb for a quoted assignment prefix",
      body: "The deeper point, and the reason this is not just a wording fix: a typo here is not the issue. Nit, cosmetic, refactor.",
    };
    expect(classifyCategory(finding)).toBe("correctness");
  });
});
