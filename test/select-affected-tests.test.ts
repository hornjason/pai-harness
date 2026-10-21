/**
 * #1004 — the selector that feeds a ship run could not see a census test.
 *
 * `scripts/select-affected-tests.ts` routes by import graph. A census test
 * imports none of the things that move it: `test/sc-binding-split.test.ts`
 * walks `specs/`, it does not import any spec. Measured on this repository
 * with one spec file changed and nothing else, `selectionFor` returned
 * SELECTED — so no fallback — with 114 of 388 files, reached
 * `ticked-sc-cover` only because it trips a sweep pattern, and omitted
 * `sc-binding-split` and `behavioral-sc-ratchet` entirely. A ship run whose
 * only change was a tick did not run two of the three tests the tick can
 * break.
 *
 * #990 built the other router, `scripts/census-routing.ts`, which routes by
 * what the diff DID. This file is about the union: the selector asks both,
 * and the artefact says which half each test came from.
 *
 * ## What is a witness here and what is a control
 *
 *   WITNESS  "a tick routes the SC census into the SELECTED set" — the
 *            defect verbatim, committed and uncommitted.
 *   WITNESS  "a rule-doc edit routes `rule-provenance`" — the class. The
 *            cheapest wrong fix cannot reach it.
 *   CONTROL  "a change that is census-neutral adds nothing" — a selector
 *            that unions everything always is as useless as one that unions
 *            nothing, and the count goes UP under both.
 *   CONTROL  "a spec edit that ticks nothing does not route the SC census" —
 *            this is what stops "append the two missing filenames whenever
 *            `specs/` moves" from reading as a pass.
 *   CONTROL  "an UNMEASURED graph stays FULL_SUITE" — the census half must
 *            not manufacture a selection out of a reading nobody took.
 *   CONTROL  "a routed test absent from the tree is recorded, not appended"
 *            — this script runs in scaffolded projects that have none of
 *            these files, and `bun test <path that matches nothing>` is a
 *            run with a denominator nobody can explain.
 *
 * ## The cheapest wrong fix, named
 *
 * Append `test/sc-binding-split.test.ts` and
 * `test/behavioral-sc-ratchet.test.ts` whenever a `specs/*.md` is in the
 * change set. The issue's measurement goes green. It fixes the instance and
 * leaves the class — exactly what #990 refused to do — and three cases below
 * do not survive it: the rule-doc case (it routes nothing outside `specs/`),
 * the unticked-edit control (it fires on an edit that is not a tick), and
 * the attribution case (it has no row to name).
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (10 tests). Each count AND the cases it would redden were
 * written down before the battery ran, and the baseline was read first — an
 * instrument that has stopped reporting takes the baseline with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 10 pass, 0 fail | **10 pass, 0 fail** | — |
 * | `censusTests` forced to `[]` — the genuinely pre-#1004 selector | 4 | **4 of 10** | a committed tick of `specs/X.md`: the original puts `test/sc-binding-split.test.ts` in `tests`, the mutant does not |
 * | the cheapest wrong fix — append the two missing names whenever a `specs/*.md` moves, no router | 8 | **8 of 10** | an edit to `.claude/rules/y.md`: the original routes `rule-provenance`, the mutant routes nothing; and an unticked spec edit, where the mutant routes two census files the original does not |
 * | `allCensusTests()` unioned unconditionally — a router that selects everything | 3 | **3 of 10** | a `lib/thing.ts`-only change: the original adds 0 census files, the mutant adds every one present |
 * | the `existsSync` filter dropped | 1 | **1 of 10** | a tree with no census files and a tick: the original appends nothing, the mutant hands `bun test` five paths that are not there |
 * | the census router fed names only — `added`/`removed` emptied, which is the question the two routers used to ask git separately | 5 | **5 of 10** | a committed tick: `spec-tick` cannot fire without the `+`/`-` payload, so the SC census is unrouted while `spec-edit` still fires |
 *
 * Every row reddened exactly the cases named for it. The third row is the
 * one that makes the census-neutral control a measurement rather than a
 * decoration; the fifth is the one that makes "both routers read one
 * `changesFor` call" a property of the code rather than of this paragraph.
 *
 * None of the five is left in the tree. All were run and reverted, and
 * `scripts/select-affected-tests.ts` was confirmed byte-identical to the
 * measured source afterwards by sha256.
 *
 * SC ids in fixtures are in the 9000 range on purpose — a real id in a test
 * is credited as covered (`.claude/rules/claiming-sc-coverage.md`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { allCensusTests } from "../scripts/census-routing";
import { selectionFor } from "../scripts/select-affected-tests";

const SC_CENSUS = [
  "test/sc-binding-split.test.ts",
  "test/ticked-sc-cover.test.ts",
  "test/behavioral-sc-ratchet.test.ts",
];

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Write a file and every directory above it. */
function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

const STUB = 'import { test } from "bun:test";\ntest("stub", () => {});\n';

/**
 * A project whose graph can see `lib/thing.ts`, `specs/X.md` and
 * `.claude/rules/y.md`, and whose census tests are present but unreachable.
 *
 * The two markdown paths are named as literals in `test/thing.test.ts` on
 * purpose: `affectedTests` refuses a non-module that no file under the
 * walked tree names, and an UNMEASURED reading would make every case below
 * a FULL_SUITE fallback that proves nothing about the union.
 *
 * The census stubs import only `bun:test` and enumerate nothing, so the
 * graph cannot reach them and they are not sweeps. That is what makes
 * "present in `tests`" attributable to the census router and nothing else.
 */
function project(opts: { censusFiles?: boolean; overlap?: boolean } = {}): {
  root: string;
  base: string;
} {
  const root = mkdtempSync(join(tmpdir(), "select-affected-"));
  made.push(root);

  put(root, "lib/thing.ts", "export const thing = 1;\n");
  put(
    root,
    "test/thing.test.ts",
    'import { test, expect } from "bun:test";\n' +
      'import { thing } from "../lib/thing";\n' +
      'const SPEC = "specs/X.md";\n' +
      'const RULE = ".claude/rules/y.md";\n' +
      'test("thing", () => { expect(thing + SPEC.length + RULE.length).toBeGreaterThan(0); });\n',
  );
  if (opts.censusFiles !== false) {
    for (const t of allCensusTests()) {
      const overlapping = opts.overlap && t === "test/sc-binding-split.test.ts";
      put(root, t, overlapping ? `import { thing } from "../lib/thing";\n${STUB}` : STUB);
    }
  }
  put(root, "specs/X.md", "- [ ] SC-9201: a criterion that is not yet met\n");
  put(root, ".claude/rules/y.md", "# a rule\n\nSome prose.\n");

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);

  return { root, base: git(root, ["rev-parse", "HEAD"]).trim() };
}

const TICKED = "- [x] SC-9201: a criterion that is not yet met\n";
const commit = (root: string, msg: string): void => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", msg]);
};

describe("#1004: a census test reaches the SELECTED set", () => {
  // WITNESS. The defect verbatim.
  test("a committed tick routes all three SC census tests", () => {
    const { root, base } = project();
    put(root, "specs/X.md", TICKED);
    commit(root, "tick");

    const s = selectionFor(root, base);
    expect(s.mode, `fell back instead of selecting: ${s.fellBackBecause[0]}`).toBe("SELECTED");
    for (const t of SC_CENSUS) {
      expect(s.tests, `a tick did not select ${t} — this is #1004 again`).toContain(t);
      expect(s.censusTests, `${t} is in tests but not attributed to the census router`).toContain(t);
    }
    expect(s.graphTests, "the graph reached a census stub, so the case proves nothing").not.toContain(
      "test/sc-binding-split.test.ts",
    );
  });

  // WITNESS, uncommitted. The old reading asked git for NAMES
  // (`git status --porcelain`), and a name list cannot tell a tick from an
  // edit — which is the whole of #990. Both routers now read one
  // `changesFor` call, and this is the half that proves it covers the
  // working tree and not just `base...HEAD`.
  test("an uncommitted tick routes all three, from the same git reading", () => {
    const { root, base } = project();
    put(root, "specs/X.md", TICKED);

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    expect(s.changed, "the working-tree change was not read at all").toContain("specs/X.md");
    for (const t of SC_CENSUS) expect(s.tests, `uncommitted tick missed ${t}`).toContain(t);
  });

  // WITNESS for the CLASS. The cheapest wrong fix knows two filenames and
  // the word `specs/`; it cannot reach this at all.
  test("editing a .claude/rules/ doc routes rule-provenance", () => {
    const { root, base } = project();
    put(root, ".claude/rules/y.md", "# a rule\n\nSome different prose.\n");
    commit(root, "rule");

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    expect(s.censusTests).toContain("test/rule-provenance.test.ts");
    expect(s.censusFired.map(f => f.id)).toContain("rule-doc");
    for (const t of SC_CENSUS) expect(s.tests, `a rule edit routed ${t}`).not.toContain(t);
  });

  // CONTROL against "append the two names on any specs/ change".
  test("a spec edit that ticks nothing does not route the SC census", () => {
    const { root, base } = project();
    put(root, "specs/X.md", "- [ ] SC-9201: a criterion that is not yet met\n\nNew prose.\n");
    commit(root, "prose");

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    for (const t of SC_CENSUS) expect(s.tests, `an unticked spec edit routed ${t}`).not.toContain(t);
    expect(s.censusTests, "the spec-edit row stopped firing").toContain(
      "test/spec-requirements.test.ts",
    );
  });

  // CONTROL against a union that fires on everything. A count going up is
  // not evidence; a count that stays put on a census-neutral change is.
  test("a census-neutral change adds nothing, and tests equals graphTests", () => {
    const { root, base } = project();
    put(root, "lib/thing.ts", "export const thing = 2;\n");
    commit(root, "code");

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    expect(s.censusFired, "a row fired on a plain source edit").toEqual([]);
    expect(s.censusTests).toEqual([]);
    expect(s.tests, "the union added files no row asked for").toEqual(s.graphTests);
    expect(s.tests, "the graph selection itself moved").toEqual(["test/thing.test.ts"]);
  });
});

describe("#1004: the artefact says which half each test came from", () => {
  test("graphTests and censusTests partition tests, with no duplicate", () => {
    const { root, base } = project({ overlap: true });
    put(root, "lib/thing.ts", "export const thing = 2;\n");
    put(root, "specs/X.md", TICKED);
    commit(root, "code and tick");

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    // The overlap: this stub imports lib/thing, so the graph reaches it AND
    // the tick routes it. Counted once, and attributed to the graph.
    expect(s.graphTests).toContain("test/sc-binding-split.test.ts");
    expect(s.censusTests, "a graph-reached test was re-attributed to the census").not.toContain(
      "test/sc-binding-split.test.ts",
    );
    expect(s.tests).toEqual([...s.graphTests, ...s.censusTests]);
    expect(
      s.tests.length,
      `a path is listed twice, so bun test would run it twice: ${s.tests.join(" ")}`,
    ).toBe(new Set(s.tests).size);
  });

  test("a tick and a prose edit are not the same record", () => {
    const ticked = project();
    put(ticked.root, "specs/X.md", TICKED);
    commit(ticked.root, "tick");
    const prose = project();
    put(prose.root, "specs/X.md", "- [ ] SC-9201: a criterion that is not yet met\n\nPo.\n");
    commit(prose.root, "prose");

    const a = selectionFor(ticked.root, ticked.base);
    const b = selectionFor(prose.root, prose.base);
    // Same mode, same graph half, same changed path. The census half is the
    // only thing that differs, and it must differ in the RECORD and not
    // only in the list of tests — `fellBackBecause` exists for this reason
    // one branch over.
    expect(a.mode).toBe(b.mode);
    expect(a.graphTests).toEqual(b.graphTests);
    expect(a.changed).toEqual(b.changed);
    expect(
      a.censusFired.map(f => f.id),
      "a tick and a prose edit fired the same rows",
    ).not.toEqual(b.censusFired.map(f => f.id));
    expect(a.censusFired.find(f => f.id === "spec-tick")?.because).toEqual(["specs/X.md"]);
  });
});

describe("#1004: the union never invents a selection", () => {
  // The issue says: leave FULL_SUITE alone. A fallback already runs
  // everything, and a census union on top of it would make the artefact
  // read like a selection that happened to be small.
  test("an UNMEASURED graph stays FULL_SUITE even when rows fired", () => {
    const { root, base } = project();
    // A new spec nothing under the walked tree names. `affectedTests`
    // refuses it by name, which is UNMEASURED, not "nothing affected".
    put(root, "specs/orphan.md", TICKED);
    commit(root, "orphan");

    const s = selectionFor(root, base);
    expect(s.mode, "the census half turned an unmeasured reading into a selection").toBe(
      "FULL_SUITE",
    );
    expect(s.tests).toEqual([]);
    expect(s.censusTests).toEqual([]);
    expect(s.fellBackBecause[0], "the fallback stopped saying why").toContain("specs/orphan.md");
    // The reading the router DID take is still recorded. A FULL_SUITE whose
    // census rows are invisible cannot be distinguished afterwards from one
    // where no row fired.
    expect(s.censusFired.map(f => f.id)).toContain("spec-tick");
  });

  test("a routed test absent from the tree is recorded, not appended", () => {
    const { root, base } = project({ censusFiles: false });
    put(root, "specs/X.md", TICKED);
    commit(root, "tick");

    const s = selectionFor(root, base);
    expect(s.mode).toBe("SELECTED");
    expect(s.censusTests, "a path that is not in the tree was handed to bun test").toEqual([]);
    for (const t of SC_CENSUS) {
      expect(s.tests).not.toContain(t);
      expect(s.censusAbsent, `${t} was dropped without being recorded`).toContain(t);
    }
  });

  test("a git reading that could not be taken falls back and says so", () => {
    const { root } = project();
    const s = selectionFor(root, "no-such-ref-9201");
    expect(s.mode, "an unreadable diff produced a selection").toBe("FULL_SUITE");
    expect(s.tests).toEqual([]);
    expect(s.fellBackBecause[0]).toContain("git could not name the changed files");
    expect(s.censusFired, "rows fired off a diff that was never read").toEqual([]);
  });
});
