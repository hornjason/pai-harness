/**
 * What the board is allowed to say (#1647).
 *
 * ## What was broken to prove these can fail
 *
 * Run `bash /tmp/rg-bm-battery/battery.sh`, 2026-10-28, against a 28-pass
 * baseline. Every row replaces one line in `lib/board-mirror.ts`:
 *
 *   baseline                                 0 red / 28 pass
 *   cap mirrorText at 6 with `+N more`       1 red / 27 pass
 *   criteriaNamedBy in mention order         1 red / 27 pass
 *   phaseOf without the `\b`                 1 red / 27 pass
 *   openFrontier ignores issue state         2 red / 26 pass
 *   isReady drops `phase !== frontier`       2 red / 26 pass
 *   isReady drops `frontier === null`        1 red / 27 pass
 *   isReady drops the assignee test          1 red / 27 pass
 *   restored                                 0 red / 28 pass
 *
 * **Two of those rows were GREEN on the first run and are the reason the
 * battery was worth running.** `phaseOf` without the boundary changed
 * nothing because the case said `"Subphase 3"`, and the pattern is
 * case-sensitive — it never matched that string with or without the `\b`, so
 * the case could not disagree. And removing the null-phase guard changed
 * nothing because `null !== frontier` already carried it: two lines, one
 * decider, no behavioural test able to say which was live. The guard was
 * deleted rather than tested, and the one case it genuinely earns — both
 * sides null — was added.
 *
 * The first row is not hypothetical either. The cap SHIPPED, with a docblock saying
 * the overflow branch was unreachable because the widest issue named six ids,
 * and the first live run produced
 * `CRC-E1 CRC-E2 CRC-E3 CRC-E4 CRC-E5 CRC-E6 +3 more` for #1437, which names
 * nine. The bound was never measured; it was asserted in a comment. The case
 * below is that issue's real id list.
 *
 * The `isReady` rows are the ones worth having. An earlier version returned
 * "unblocked and unassigned", which made 36 of 46 open issues Ready because
 * this repository has almost no dependency edges — a lane holding the whole
 * backlog, answering "what can I pick up" with "anything".
 */
import { describe, expect, test } from "bun:test";
import {
  criteriaNamedBy,
  isReady,
  isUnblocked,
  mirrorRows,
  mirrorText,
  NAMES_NONE,
  openFrontier,
  phaseOf,
} from "../lib/board-mirror";

const SPEC_ORDER = [
  "CRC-A4",
  "CRC-B3",
  "CRC-B4",
  "CRC-B6",
  "CRC-E1",
  "CRC-E2",
  "CRC-E3",
  "CRC-E4",
  "CRC-E5",
  "CRC-E6",
  "CRC-E7",
  "CRC-E8",
  "CRC-E9",
  "CRC-M11",
  "CRC-N2",
];

describe("#1647: the Criteria column", () => {
  describe("mirrorText carries every id", () => {
    test("no criteria is an empty cell, not a word", () => {
      // A cell reading "none" sorts and filters as a value. Empty is absence.
      expect(mirrorText([])).toBe(NAMES_NONE);
      expect(NAMES_NONE).toBe("");
    });

    test("one id is just the id", () => {
      expect(mirrorText(["CRC-F1"])).toBe("CRC-F1");
    });

    test("nine ids — #1437's real list — are all nine, uncut", () => {
      const nine = ["CRC-E1", "CRC-E2", "CRC-E3", "CRC-E4", "CRC-E5", "CRC-E6", "CRC-E7", "CRC-E8", "CRC-E9"];
      const cell = mirrorText(nine);
      expect(cell).toBe(nine.join(" "));
      expect(cell).not.toContain("more");
      for (const id of nine) expect(cell).toContain(id);
    });
  });

  describe("criteriaNamedBy asks the question criterion-inventory already asks", () => {
    test("a title mention counts", () => {
      expect(criteriaNamedBy({ title: "CRC-B4's jury never runs in CI", body: "" }, SPEC_ORDER)).toEqual(
        ["CRC-B4"],
      );
    });

    test("a body mention counts", () => {
      expect(criteriaNamedBy({ title: "something", body: "serves CRC-N2 only" }, SPEC_ORDER)).toEqual([
        "CRC-N2",
      ]);
    });

    test("a null body is not a crash and not a match", () => {
      expect(criteriaNamedBy({ title: "nothing here", body: null }, SPEC_ORDER)).toEqual([]);
    });

    test("CRC-B4 does not match inside CRC-B41", () => {
      // The trailing boundary in `oneScMentionPattern` is "not a word
      // character and not a hyphen". Without it the column would credit a
      // criterion the issue never names.
      expect(criteriaNamedBy({ title: "about CRC-B41", body: "" }, ["CRC-B4"])).toEqual([]);
    });

    test("the order is the spec's, not the order the prose happens to mention them", () => {
      // Two issues serving the same pair must render identically, or the
      // column stops being scannable down a group.
      const a = criteriaNamedBy({ title: "CRC-N2 then CRC-A4", body: "" }, SPEC_ORDER);
      const b = criteriaNamedBy({ title: "CRC-A4 then CRC-N2", body: "" }, SPEC_ORDER);
      expect(a).toEqual(["CRC-A4", "CRC-N2"]);
      expect(a).toEqual(b);
    });

    test("an id absent from the spec is never credited, however loudly the issue says it", () => {
      expect(criteriaNamedBy({ title: "CRC-Z9 CRC-Z9 CRC-Z9", body: "" }, SPEC_ORDER)).toEqual([]);
    });
  });

  test("mirrorRows pairs each issue with its own cell", () => {
    const rows = mirrorRows(
      [
        { number: 1, title: "CRC-B3 and CRC-B4", body: "" },
        { number: 2, title: "nothing", body: "" },
      ],
      SPEC_ORDER,
    );
    expect(rows).toEqual([
      { number: 1, criteria: ["CRC-B3", "CRC-B4"], text: "CRC-B3 CRC-B4" },
      { number: 2, criteria: [], text: "" },
    ]);
  });
});

describe("#1647: the Ready lane", () => {
  test("phaseOf reads the number out of a milestone title", () => {
    expect(phaseOf("Convergence Phase 0 — three settings")).toBe(0);
    expect(phaseOf("Convergence Phase 6 — release and detection")).toBe(6);
  });

  test("phaseOf refuses a milestone that is not a phase", () => {
    // `Convergence Machinery` is a real milestone on this repository that no
    // phase row derives, and `plan-spec` reports it as unmanaged. Reading a
    // phase number out of it would put unordered work into the queue.
    expect(phaseOf("Convergence Machinery")).toBeNull();
    expect(phaseOf(null)).toBeNull();
    expect(phaseOf("")).toBeNull();
  });

  test("phaseOf does not read a number out of a word ENDING in Phase", () => {
    // The first spelling of this case was `"Subphase 3"`, and it could not
    // disagree with anything: the pattern is case-sensitive, so `Phase` never
    // matched `subphase` with or without the `\b`. Removing the boundary left
    // the whole file green. The word has to end in a capital `Phase` for the
    // boundary to be the thing under test.
    expect(phaseOf("TestPhase 3 — something")).toBeNull();
    expect(phaseOf("Convergence Phase 3 — something")).toBe(3);
  });

  describe("openFrontier", () => {
    test("is the lowest phase with OPEN work", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: 3 },
          { state: "OPEN", phase: 1 },
          { state: "OPEN", phase: 5 },
        ]),
      ).toBe(1);
    });

    test("a closed issue does not hold a phase open", () => {
      // The whole point of the lane: finishing Phase 0 must promote Phase 1.
      expect(
        openFrontier([
          { state: "CLOSED", phase: 0 },
          { state: "OPEN", phase: 1 },
        ]),
      ).toBe(1);
    });

    test("an issue in no phase does not become the frontier", () => {
      expect(
        openFrontier([
          { state: "OPEN", phase: null },
          { state: "OPEN", phase: 2 },
        ]),
      ).toBe(2);
    });

    test("no open phased work at all is null, not zero", () => {
      // `0` is a real phase number here, so returning it for "nothing" would
      // make every unphased issue in Phase 0 look ready.
      expect(openFrontier([{ state: "CLOSED", phase: 0 }])).toBeNull();
      expect(openFrontier([])).toBeNull();
    });
  });

  describe("isReady", () => {
    const base = { state: "OPEN", phase: 0, blockedByOpen: 0, assignees: 0 };

    test("open, at the frontier, unblocked, unclaimed", () => {
      expect(isReady(base, 0)).toBe(true);
    });

    test("a later phase is not ready, however unblocked it is", () => {
      expect(isReady({ ...base, phase: 1 }, 0)).toBe(false);
      expect(isReady({ ...base, phase: 6 }, 0)).toBe(false);
    });

    test("an issue in no phase is never ready", () => {
      // There is no guard spelling this; `null !== frontier` carries it. The
      // case stays because the PROPERTY is what matters, and a future edit
      // that special-cases a null phase has to keep it true.
      expect(isReady({ ...base, phase: null }, 0)).toBe(false);
    });

    test("an OPEN blocker refuses it even at the frontier", () => {
      expect(isReady({ ...base, blockedByOpen: 1 }, 0)).toBe(false);
    });

    test("a claimed issue is not ready — somebody already took it", () => {
      expect(isReady({ ...base, assignees: 1 }, 0)).toBe(false);
    });

    test("a closed issue is never ready", () => {
      expect(isReady({ ...base, state: "CLOSED" }, 0)).toBe(false);
    });

    test("no frontier means nothing is ready", () => {
      expect(isReady(base, null)).toBe(false);
    });

    test("an unphased issue when NOTHING is phased is still not ready", () => {
      // The case the `frontier === null` guard actually earns, and the only
      // one: with both sides null, `item.phase !== frontier` is FALSE, so
      // without the guard the function falls through and returns true for an
      // issue that is in no plan at all. A battery removing the guard left
      // every other case green.
      expect(isReady({ ...base, phase: null }, null)).toBe(false);
    });
  });

  describe("isUnblocked reads the OPEN count, which is why Ready is written and not filtered", () => {
    test("zero open blockers and nobody on it", () => {
      expect(isUnblocked({ blockedBy: 0 }, 0)).toBe(true);
    });

    test("one open blocker is blocked", () => {
      expect(isUnblocked({ blockedBy: 1 }, 0)).toBe(false);
    });

    test("an assignee is a claim, not a block, but it still leaves the lane", () => {
      expect(isUnblocked({ blockedBy: 0 }, 1)).toBe(false);
    });
  });
});
