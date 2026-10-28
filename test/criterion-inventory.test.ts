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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODE_DIRS,
  STATES,
  changedCode,
  classify,
  collectTestFiles,
  falseTicks,
  inventory,
  renderMarkdown,
  waiverProblem,
  type Snapshot,
  type Tracked,
} from "../scripts/criterion-inventory";

const SCRIPT = join(import.meta.dir, "..", "scripts", "criterion-inventory.ts");

const TODAY = "2026-10-28";

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
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: false } }), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("DOCUMENT ONLY");
  });

  test("the SAME pull request having touched code puts it in TOUCHED", () => {
    // The control. One variable differs — the changed-file reading — so the
    // row above measured the classification and not the fixture.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: { 900: true } }), [], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("TOUCHED");
  });

  test("an unclassified pull request is DOCUMENT ONLY, never TOUCHED", () => {
    // Absent is not false and not true. TOUCHED is the claim that somebody
    // changed code, and a reading nobody took cannot support it — so the
    // unmeasured case falls to the weaker column and the script reports the
    // numbers it could not classify.
    const rows = inventory(SPEC, snapshot({ prs: namesZ2, prChangedCode: {} }), [], TODAY);
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
      TODAY,
    );
    expect(rows.find(r => r.id === "CRC-Z1")!.state).toBe("DONE");
  });

  test("a test naming an unticked criterion beats any pull request reading", () => {
    const rows = inventory(SPEC, snapshot({ prs: namesNothing(), prChangedCode: {} }), [
      { file: "z2.test.ts", content: "// covers CRC-Z2" },
    ], TODAY);
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("BOUND");
  });

  test("nothing naming it at all is NOT STARTED", () => {
    const rows = inventory(SPEC, snapshot({}), [], TODAY);
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
    const rows = inventory(waived, snapshot({}), [], TODAY);
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
      TODAY,
    );
    expect(rows.find(r => r.id === "CRC-Z2")!.state).toBe("NOT STARTED");
  });
});

describe("a waiver settles a criterion only when it actually stands", () => {
  // All three raised by the required reviewer on #1642. Each is a state
  // `lib/spec-evidence.ts` already calls a violation, and each would have
  // reported here as the most flattering reading available: SETTLED.
  const WAIVER = { reason: "nobody has run it on the live path", by: "rayford", until: "2026-12-31" };

  test("a standing waiver on a ticked criterion settles it", () => {
    // The baseline. Without it every case below could be failing for a reason
    // the case did not introduce.
    expect(waiverProblem({ ticked: true }, WAIVER, TODAY)).toBeNull();
  });

  test("a waiver on an UNTICKED criterion settles nothing", () => {
    // `parseCriteria` records a waiver whenever any `waived-*` field appears,
    // ticked or not, on purpose — "a half-written waiver on an unticked
    // criterion is still a waiver nobody can act on".
    expect(waiverProblem({ ticked: false }, WAIVER, TODAY)).toMatch(/unticked/);
  });

  test("an EXPIRED waiver settles nothing, at the day boundary", () => {
    // The boundary itself is the case worth pinning: expiring TODAY still
    // stands, expiring yesterday does not.
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: TODAY }, TODAY)).toBeNull();
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: "2026-10-27" }, TODAY)).toMatch(
      /expired on 2026-10-27/,
    );
  });

  test("an incomplete waiver, and one dated to a day that does not exist", () => {
    expect(waiverProblem({ ticked: true }, { ...WAIVER, by: "  " }, TODAY)).toMatch(/missing: by/);
    expect(waiverProblem({ ticked: true }, { ...WAIVER, until: "2026-02-30" }, TODAY)).toMatch(
      /not a real day/,
    );
  });

  test("a criterion whose waiver does not stand is NOT reported as WAIVED", () => {
    const expired = SPEC.replace(
      "      proved-by: test/nothing.test.ts\n      fingerprint: deadbeef\n",
      "      waived-reason: nobody has run it on the live path\n" +
        "      waived-by: rayford\n" +
        "      waived-until: 2026-01-01\n",
    );
    const [row] = inventory(expired, snapshot({}), [], TODAY);
    expect(row.state).not.toBe("WAIVED");
    // And it must not fall into DONE either — a tick with an expired excuse
    // behind it is the false tick this whole line of work exists to catch.
    expect(row.state).not.toBe("DONE");
    expect(row.waiverProblem).toMatch(/expired/);
  });
});

describe("the test scan reaches every directory under test/", () => {
  // The first draft used a flat `readdirSync`, so the 70 files under
  // `test/unit/`, `test/helpers/` and `test/types/` were invisible and the
  // criteria they bind read as unbound. Raised by the required reviewer on
  // #1642.
  test("it finds a nested test file, and skips fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inventory-scan-"));
    try {
      mkdirSync(join(dir, "unit"), { recursive: true });
      mkdirSync(join(dir, "fixtures", "deep"), { recursive: true });
      writeFileSync(join(dir, "top.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "unit", "nested.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "fixtures", "deep", "planted.test.ts"), "// covers CRC-Z2");
      writeFileSync(join(dir, "unit", "helper.ts"), "// covers CRC-Z2");

      const found = collectTestFiles(dir).map(f => f.file).sort();
      expect(found).toEqual(["top.test.ts", "unit/nested.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nested test is enough to make a criterion BOUND", () => {
    // The property the flat read broke, asserted end to end rather than only
    // on the walker.
    const [, z2] = inventory(SPEC, snapshot({}), [
      { file: "unit/nested.test.ts", content: "// covers CRC-Z2" },
    ], TODAY);
    expect(z2.state).toBe("BOUND");
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
      waiverProblem: null,
    };
    expect(classify(base, {})).toBe("NOT STARTED");
    expect(classify({ ...base, openIssues: [1] }, {})).toBe("DOCUMENT ONLY");
    expect(classify({ ...base, mergedPrs: [7] }, { 7: true })).toBe("TOUCHED");
    expect(classify({ ...base, tests: ["a.test.ts"] }, {})).toBe("BOUND");
    expect(classify({ ...base, ticked: true, provedBy: "test/x.test.ts" }, {})).toBe("DONE");
    // A tick with no proof behind it is NOT done. It falls through on its
    // other evidence and the script names it as a false tick. Measured on
    // the 2026-10-28 snapshot: 10 ticked, 0 of this shape — the two that
    // look like it, CRC-B7 and CRC-M11, carry standing waivers and reach
    // WAIVED. So this case is a latent hole, not a live one, and an earlier
    // draft of this comment claiming "the two we found today" was wrong.
    expect(classify({ ...base, ticked: true }, {})).toBe("NOT STARTED");
    expect(classify({ ...base, ticked: true, waived: true }, {})).toBe("WAIVED");
  });
});

describe("the committed document names a false tick, not only the console", () => {
  // The console branch reported FALSE TICKS and `renderMarkdown()` had no
  // equivalent, so the document anybody actually reads filed a ticked
  // criterion with nothing behind it under whatever other evidence it had —
  // indistinguishable, in the tables, from an honest row. Raised by the
  // required reviewer on #1642.
  const TICKED_NO_PROOF = [
    "---",
    "doc-type: spec",
    "---",
    "",
    "- [x] CRC-Z3: the tick nobody earned.",
    "      needs: test",
    "",
  ].join("\n");

  const render = (spec: string): string => {
    const rows = inventory(spec, snapshot({}), [], TODAY);
    return renderMarkdown(rows, snapshot({}), [], TODAY);
  };

  test("a ticked criterion with no proof is named in the markdown", () => {
    const md = render(TICKED_NO_PROOF);
    expect(md).toContain("## Ticked, with nothing holding the tick up");
    expect(md).toContain("**CRC-Z3**");
    expect(md).toContain("no proof recorded");
  });

  test("a ticked criterion that DOES name its proof is not", () => {
    // The control. One variable differs — the `proved-by:` line — so the row
    // above measured the false-tick section and not the fact that the
    // heading is printed unconditionally.
    const md = render(TICKED_NO_PROOF.replace("      needs: test", "      needs: test\n      proved-by: test/x.test.ts"));
    expect(md).toContain("## Ticked, with nothing holding the tick up");
    expect(md).toContain("None. Every ticked criterion carries");
    expect(md).not.toContain("no proof recorded");
  });

  test("the document and the console read the same decider", () => {
    // Not two filters that agree: a second copy would survive any mutation of
    // the first and both surfaces would read as covered.
    const rows = inventory(TICKED_NO_PROOF, snapshot({}), [], TODAY);
    expect(falseTicks(rows).map(r => r.id)).toEqual(["CRC-Z3"]);
    expect(falseTicks(inventory(SPEC, snapshot({}), [], TODAY))).toEqual([]);
  });
});

describe("an absent pr-files.jsonl is the first pass, not a failed fetch", () => {
  // The header's own recipe was circular: the file is populated FROM the
  // UNCLASSIFIED numbers this script reports, and the script refused to run
  // until the file existed. Raised by the required reviewer on #1642. Run as
  // a subprocess because the refusal lives in `readSnapshot`, which the
  // recipe reaches only through the command line.
  const run = (dir: string, spec: string) =>
    Bun.spawnSync(["bun", SCRIPT, "--snapshot", dir, "--spec", spec, "--json"]);

  const plant = (opts: { prs: boolean }): { dir: string; spec: string } => {
    const dir = mkdtempSync(join(tmpdir(), "rg-inventory-snap-"));
    writeFileSync(
      join(dir, "issues.json"),
      JSON.stringify([{ number: 1, title: "CRC-Z2 is wrong", body: "", state: "OPEN" }]),
    );
    if (opts.prs) {
      writeFileSync(
        join(dir, "prs.json"),
        JSON.stringify([
          { number: 900, title: "CRC-Z2", body: "", state: "MERGED", mergedAt: "2026-10-28T00:00:00Z" },
        ]),
      );
    }
    const spec = join(dir, "spec.md");
    writeFileSync(spec, SPEC);
    return { dir, spec };
  };

  test("it runs, and reports the merged PR it could not classify", () => {
    const { dir, spec } = plant({ prs: true });
    try {
      const got = run(dir, spec);
      expect(got.exitCode).toBe(0);
      expect(JSON.parse(got.stdout.toString()).unclassified).toEqual([900]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent prs.json still refuses", () => {
    // The control, and the reason the relaxation is not a silent default: for
    // the two readings taken in one shot, absent means the fetch failed.
    const { dir, spec } = plant({ prs: false });
    try {
      const got = run(dir, spec);
      expect(got.exitCode).not.toBe(0);
      expect(got.stderr.toString()).toContain("prs.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
