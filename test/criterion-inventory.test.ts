/**
 * The inventory's one load-bearing property: a pull request that only REWROTE
 * the spec must not read as work on the criteria it names.
 *
 * `docs/research/increment-1-criterion-inventory.md` is the reading, and the
 * distinction below is why it is worth anything. Six of the most-cited pull
 * requests in this repository are revisions of
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` — #1298, #1340, #1360, #1373, #1637
 * and #1640 — and a spec revision names every id in the document by
 * construction. Count those as progress and every criterion in the file reads
 * as started, which is the one direction that reads as good news.
 *
 * `scripts/criterion-inventory.ts` is the IO around this and is not exercised
 * here: it reads a snapshot of the live tracker off disk.
 */

import { describe, expect, test } from "bun:test";

import {
  CODE_DIRS,
  STATES,
  changedCode,
  classify,
  inventory,
  type Snapshot,
  type Tracked,
} from "../scripts/criterion-inventory";

const SPEC = [
  "---",
  "doc-type: spec",
  "evidence: required",
  "---",
  "",
  "- [x] CRC-Z1: the gate refuses an unsigned payload.",
  "      needs: test",
  "      proved-by: test/nothing.test.ts",
  "      fingerprint: deadbeef",
  "- [ ] CRC-Z2: the gate also refuses an expired one.",
  "      needs: test",
  "",
].join("\n");

function pr(number: number, text: string): Tracked {
  return { number, title: text, body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" };
}

function snapshot(partial: Partial<Snapshot>): Snapshot {
  return { issues: [], prs: [], prChangedCode: {}, ...partial };
}

describe("a spec revision is not work on the criteria it names", () => {
  const namesZ2 = [pr(900, "CRC-Z2 is restated")];

  test("a pull request that touched only prose puts the criterion in DOCUMENT ONLY", () => {
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: false } }), []);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("DOCUMENT ONLY");
  });

  test("the SAME pull request having touched code puts it in TOUCHED", () => {
    // The control. One variable differs — the changed-file reading — so the
    // row above measured the classification and not the fixture.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: true } }), []);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("TOUCHED");
  });

  test("an unclassified pull request is DOCUMENT ONLY, never TOUCHED", () => {
    // Absent is not false and not true. TOUCHED is the claim that somebody
    // changed code, and a reading nobody took cannot support it — so the
    // unmeasured case falls to the weaker column and the script reports the
    // numbers it could not classify.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: {} }), []);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("DOCUMENT ONLY");
  });
});

describe("what counts as changing code", () => {
  test("every directory in the list is recognised, and prose is not", () => {
    // Asserted per directory rather than on a sample: a list of eleven where
    // one entry is misspelled passes any test that only checks `lib/`.
    const missed = CODE_DIRS.filter(d => !changedCode([`${d}/thing.ts`]));
    expect(missed, "these directories must count as code").toEqual([]);
    expect(changedCode(["specs/A-SPEC.md", "docs/research/x.md", "README.md"])).toBe(false);
  });

  test("a prefix that is not a directory boundary does not count", () => {
    // `libretto/` is not `lib/`. Without the trailing slash it would be.
    expect(changedCode(["libretto/x.ts"])).toBe(false);
    expect(changedCode(["lib/x.ts"])).toBe(true);
  });
});

describe("the ladder is ordered, and a stronger reading wins", () => {
  test("a ticked criterion is DONE even when a pull request also names it", () => {
    const rows = inventory(
      SPEC,
      snapshot({ prs: [pr(901, "CRC-Z1 again")], prChangedCode: { 901: true } }),
      [],
    );
    expect(rows.find(r => r.id === "CRC-Z1")!.state).toBe("DONE");
  });

  test("a test naming an unticked criterion beats any pull request reading", () => {
    const rows = inventory(SPEC, snapshot({ prs: namesNothing(), prChangedCode: {} }), [
      { file: "z2.test.ts", content: "// covers CRC-Z2" },
    ]);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("BOUND");
  });

  test("nothing naming it at all is NOT STARTED", () => {
    const rows = inventory(SPEC, snapshot({}), []);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("NOT STARTED");
  });

  test("every state the classifier can return is one this file has exercised", () => {
    // WAIVED is the only state not reachable above, and it is reachable here —
    // so the ladder has no rung nothing has ever been seen on.
    const waived = SPEC.replace(
      "      proved-by: test/nothing.test.ts\n      fingerprint: deadbeef\n",
      "      waived-reason: nobody has run it on the live path\n" +
        "      waived-by: rayford (agent; not countersigned by jason)\n" +
        "      waived-until: 2026-12-31\n",
    );
    const rows = inventory(waived, snapshot({}), []);
    expect(rows.find(r => r.id === "CRC-Z1")!.state).toBe("WAIVED");
    expect(new Set(STATES).size).toBe(6);
  });
});

function namesNothing(): Tracked[] {
  return [pr(902, "unrelated")];
}

describe("the match is on a word boundary", () => {
  test("a longer id is not a hit", () => {
    const rows = inventory(
      SPEC,
      snapshot({ prs: [pr(903, "CRC-Z22 is broken")], prChangedCode: { 903: true } }),
      [],
    );
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("NOT STARTED");
  });
});

describe("classify is the single decider", () => {
  test("it reads the fields it is given, with no access to the spec", () => {
    const base = {
      id: "CRC-Z9",
      ticked: false,
      waived: false,
      needs: "test",
      provedBy: null,
      text: "x",
      openIssues: [],
      closedIssues: [],
      mergedPrs: [],
      tests: [],
    };
    expect(classify(base, {})).toBe("NOT STARTED");
    expect(classify({ ...base, openIssues: [1] }, {})).toBe("DOCUMENT ONLY");
    expect(classify({ ...base, mergedPrs: [7] }, { 7: true })).toBe("TOUCHED");
    expect(classify({ ...base, tests: ["a.test.ts"] }, {})).toBe("BOUND");
    expect(classify({ ...base, ticked: true }, {})).toBe("DONE");
    expect(classify({ ...base, ticked: true, waived: true }, {})).toBe("WAIVED");
  });
});
