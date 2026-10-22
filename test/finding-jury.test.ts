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
  parseVotes,
  renderComment,
  severityOf,
  SEVERITY_RANK,
  UNREADABLE_VOTE,
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

  /**
   * The quorum is compared against the BALLOT, not against the declaration.
   * With the 3/2 defaults, five votes of which two agree returned
   * `passed: true` — 2 of 5, a majority of nothing — because an over-size
   * ballot was accepted as a larger group it had never declared.
   */
  test("an over-size ballot is UNMEASURED, not a bigger group", () => {
    const five = [
      vote("a", true), vote("b", true),
      vote("c", false), vote("d", false), vote("e", false),
    ];
    const r = juryReading(five); // groupSize 3, quorum 2
    expect(r.agree).toBe(VERIFIER_QUORUM);
    expect(r.reading).toBe("UNMEASURED");
    expect(r.passed).toBe(false);
  });

  test("CONTROL: the same five votes DECLARED as a group of five read fine", () => {
    const five = [
      vote("a", true), vote("b", true), vote("c", true),
      vote("d", false), vote("e", false),
    ];
    expect(juryReading(five, { groupSize: 5, quorum: 3 }).reading).toBe("MEASURED");
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
    // Two of three real votes, which is the outright majority a drop needs.
    expect(juryCategory(finding, votes)).toBe("cleanup");
  });

  /**
   * One tagger is not the group. Under a plain plurality, three real votes
   * with ONE `cleanup` tag returned `cleanup` and the finding was dropped —
   * a single voice suppressing what the group had passed.
   */
  test("one tagger of three cannot drop a finding the group passed", () => {
    const finding = { title: "commandWord returns the wrong verb", body: "x" };
    const votes = [
      vote("a", true, { category: "cleanup" }),
      vote("b", true),
      vote("c", true),
    ];
    expect(juryCategory(finding, votes)).toBe("correctness");
  });

  test("CONTROL: two taggers of three — an outright majority — do drop it", () => {
    const finding = { title: "commandWord returns the wrong verb", body: "x" };
    const votes = [
      vote("a", true, { category: "cleanup" }),
      vote("b", true, { category: "cleanup" }),
      vote("c", true),
    ];
    expect(juryCategory(finding, votes)).toBe("cleanup");
  });

  test("a tie between a drop and a keep resolves toward keep", () => {
    const finding = { title: "an unremarkable title", body: "x" };
    const votes = [
      vote("a", true, { category: "cleanup" }),
      vote("b", true, { category: "security" }),
    ];
    expect(juryCategory(finding, votes)).toBe("security");
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

/**
 * JURY-6: the ballot is read, not cast (#1235).
 *
 * `scripts/arbitrate-finding.ts` checked `Array.isArray` and then cast —
 * `parsed as VerifierVote[]` — so no entry was ever inspected. Agreement is
 * counted by truthiness, and **the string `"false"` is truthy**, so a verifier
 * who rejected a finding was counted as agreeing with it.
 *
 * The end-to-end direction case, with the exit codes and the coercion control,
 * is `AR-16` in `test/finding-arbiter.test.ts`. These are the field-level
 * cases, including the two the CLI block does not reach: `category` and
 * `severity` carry the same defect as `real` and are refused for the reasons
 * the first test here measures.
 */
describe("JURY-6: the ballot is read, not cast", () => {
  const good = { verifier: "v1", real: true, reason: "reproduced" };

  test("the control — a well-formed ballot survives unchanged", () => {
    const ballot = [good, { verifier: "v2", real: false, reason: "no", category: "security", severity: "Nit" }];
    expect(parseVotes(ballot)).toEqual(ballot as VerifierVote[]);
  });

  /**
   * The premise the whole fix rests on, asserted rather than asserted-about:
   * these three are the reason an unvalidated field is a defect and not an
   * untidiness. Each is the mechanism named in `parseVotes`'s refusal.
   */
  test("the premises: a truthy `real`, an unknown category that is not dropped, an unranked severity", () => {
    // `"false"` reads as agreement. This is #1235.
    expect(juryReading([
      vote("v1", "false" as unknown as boolean),
      vote("v2", "false" as unknown as boolean),
      vote("v3", false),
    ]).agree).toBe(2);
    // An unrecognised category is not in DROPPED_CATEGORIES, so it keeps.
    expect(DROPPED_CATEGORIES.has("janitorial" as never)).toBe(false);
    // An unrecognised severity has no rank, so the comparator sees NaN.
    expect(SEVERITY_RANK["Critical" as never] as unknown).toBeUndefined();
  });

  test.each([
    ["not an array", { verifier: "v1" }, "not a JSON array"],
    ["an entry that is a string", ["v1 says yes"], "not an object"],
    ["an entry that is null", [null], "not an object"],
    ["an entry that is an array", [[]], "not an object"],
    ["`real` as the string \"false\"", [{ ...good, real: "false" }], "non-boolean `real`"],
    ["`real` as the number 1", [{ ...good, real: 1 }], "non-boolean `real`"],
    ["`real` absent", [{ verifier: "v1", reason: "r" }], "non-boolean `real`"],
    ["`verifier` absent", [{ real: true, reason: "r" }], "no `verifier` id"],
    ["`verifier` as a number", [{ ...good, verifier: 7 }], "no `verifier` id"],
    ["`verifier` as the empty string", [{ ...good, verifier: "" }], "no `verifier` id"],
    ["`reason` absent", [{ verifier: "v1", real: true }], "no `reason`"],
    ["an unknown `category`", [{ ...good, category: "janitorial" }], "unknown `category`"],
    ["an unknown `severity`", [{ ...good, severity: "Critical" }], "unknown `severity`"],
  ])("refuses %s", (_what, ballot, expected) => {
    expect(() => parseVotes(ballot)).toThrow(expected);
  });

  /**
   * The membership test must not walk the prototype chain.
   *
   * Caught by the AI reviewer on this PR's first push, and it is this issue's
   * own defect reintroduced inside its fix: `v.category in CATEGORY_MEMBERS`
   * is `true` for every `Object.prototype` key, so `category: "constructor"`
   * was accepted, and an accepted-but-unrecognised category is absent from
   * `DROPPED_CATEGORIES` and therefore reads as a **keep**. Eight values were
   * wrongly accepted across the two fields before `Object.hasOwn`.
   */
  test.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "refuses the inherited key %p in both `category` and `severity`",
    key => {
      expect(() => parseVotes([{ ...good, category: key }])).toThrow("unknown `category`");
      expect(() => parseVotes([{ ...good, severity: key }])).toThrow("unknown `severity`");
    },
  );

  test("the refusal names the entry and the reading it refused to take", () => {
    expect(() => parseVotes([good, { verifier: "v2", real: "false", reason: "no" }]))
      .toThrow("vote 1 of the ballot");
    // Not a dissent, and not a short group: the refusal has to say which.
    expect(() => parseVotes([{ verifier: "v2", real: "false", reason: "no" }])).toThrow(UNREADABLE_VOTE);
  });

  /**
   * The cheapest wrong fix, run as a case rather than described.
   *
   * Coercing `"false"` to `false` fixes the headline ballot and invents a
   * dissent on this one: two genuine yeses and one unreadable vote still clear
   * a 2-of-3 quorum, so the coerced reading passes a finding one of whose
   * verifiers said nothing legible. Only refusing the whole ballot separates
   * them (`.claude/rules/checks-must-be-able-to-fail.md`, the fifth shape).
   */
  test("the coerced reading still passes, which is why the ballot is refused instead", () => {
    const raw = [
      { verifier: "v1", real: "false", reason: "could not reproduce" },
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: true, reason: "reproduced" },
    ];
    const coerced = raw.map(v => vote(v.verifier, v.real !== "false" && Boolean(v.real)));
    expect(juryReading(coerced).passed).toBe(true);
    expect(() => parseVotes(raw)).toThrow(UNREADABLE_VOTE);
  });
});
