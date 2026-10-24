/**
 * #990 — a spec EDIT and a spec TICK are the same path and different events.
 *
 * `.claude/rules/self-referential-tests.md` routed the first and not the
 * second. Ticking one criterion on PR #985 moved `splitUnmatchedChecked`'s
 * claimed half 72 -> 73; every targeted suite was green locally and CI went
 * red in `test/sc-binding-split.test.ts`, a file the change does not touch.
 *
 * ## What is a witness here and what is a control
 *
 * Say which, or the next reader counts seven.
 *
 *   WITNESS  "a tick routes to the three SC census tests" — red on the
 *            pre-#990 table, which has no `spec-tick` row.
 *   WITNESS  "the rule file's table is the router's table" — red the moment
 *            the two drift, which is the only thing keeping the prose true.
 *   CONTROL  "a spec edit that ticks nothing does NOT route to them" — green
 *            on the pre-#990 table too, because that table cannot route them
 *            at all. It is not evidence of the fix. It exists to stop the
 *            cheapest wrong *generalisation* — firing `spec-tick` on every
 *            `specs/` change — from reading as a pass.
 *   CONTROL  "every routed path exists on disk" — green before and after. It
 *            stops the table naming a test that was renamed away, which is
 *            the failure mode `test/rule-provenance.test.ts` exists for one
 *            directory over.
 *
 * ## The cheapest wrong fix, named
 *
 * Add the bash row to the rule file and stop. The symptom — "an agent who
 * reads the list still misses the census tests" — goes away for anybody who
 * reads the list, and the list is prose, so it rots at the next rename with
 * nothing to notice. Every case below drives the router, so none of them is
 * satisfied by an edit to the document alone; and the table-agreement case
 * turns the document into something that cannot silently disagree with code.
 *
 * SC ids in fixtures are in the 9000 range on purpose — a real id in a test
 * is credited as covered (`.claude/rules/claiming-sc-coverage.md`), so a test
 * about routing SC census checks would otherwise tick the criteria it names.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (12 tests). The named cases were predicted before the
 * battery ran, and the baseline row was read first — an instrument that has
 * stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 12 pass, 0 fail | **12 pass, 0 fail** | — |
 * | the `spec-tick` entry deleted — the genuinely pre-#990 table | the 7 named below | **7 of 12** | `{path: "specs/HARNESS-STANDARD.md", added: ["- [x] SC-9101: …"]}`: the original routes the three SC census files, the mutant routes only the spec-edit pair |
 * | `spec-tick.fires` widened to any `specs/*.md` change — the cheapest wrong generalisation | 3 | **3 of 12** | `{path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9103: …"]}`: the original routes two tests, the mutant routes five |
 * | the tick row deleted from the rule file's table, router untouched | 2 | **2 of 12** | the document itself: the rendered table no longer appears in it |
 * | the `---` header no longer skipped in `parseUnifiedDiff` | 1 | **1 of 12** | the seven-line diff in the last describe: `removed` gains `"-- a/specs/X.md"` |
 *
 * The first row's PREDICTION was written as a list of seven case names and
 * then mis-added to six in the same sentence. The seven measured are the
 * seven named; the arithmetic was wrong and the prediction was not. Recorded
 * rather than quietly corrected, because a row that matches after the number
 * is edited is not a row anybody can check.
 *
 * Row 2 is the one that makes the control case above a measurement. Row 3
 * is the instrument: without it the table could drift from the router with
 * everything else green, which is the state this issue is about.
 *
 * None of the four is left in the tree; all were run and reverted, and
 * `scripts/census-routing.ts` and
 * `.claude/rules/self-referential-tests.md` were confirmed byte-identical to
 * the measured source afterwards by sha256.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  CENSUS_TRIGGERS,
  allCensusTests,
  censusTestsFor,
  ownSpecTestPath,
  parseUnifiedDiff,
  type Change,
} from "../scripts/census-routing";
import { TRACKED_ID_PREFIXES } from "../lib/sc-ids";
import { LINE_CITATION } from "../lib/line-citation";

const REPO = join(import.meta.dir, "..");
const RULE = join(REPO, ".claude/rules/self-referential-tests.md");

// Four since #1161 added `ticked-sc-absent-symbol`, which refuses a tick
// naming a symbol the tree does not contain — an event only a spec edit can
// cause, in a file the spec edit does not touch. Written out rather than
// read from `CENSUS_TRIGGERS`, because a list derived from the thing it
// checks agrees with it by construction.
const SC_CENSUS = [
  "test/sc-binding-split.test.ts",
  "test/ticked-sc-cover.test.ts",
  "test/behavioral-sc-ratchet.test.ts",
  "test/ticked-sc-absent-symbol.test.ts",
];

// The two files #1306 measured as reddening on a new spec and routed by
// nothing. Written out rather than read from `CENSUS_TRIGGERS`, for the same
// reason `SC_CENSUS` is: a list derived from the thing it checks agrees with
// it by construction.
const NEW_SPEC_CENSUS = ["test/audit-specs.test.ts", "test/scanner.test.ts"];

const change = (p: Partial<Change> & { path: string }): Change => ({
  isNew: false,
  added: [],
  removed: [],
  // No census trigger reads `hunks`; `lib/text-dependents.ts` does (#1054).
  hunks: [],
  ...p,
});

describe("#990: a tick is routed, and an edit that is not a tick is not", () => {
  // WITNESS. The whole of #990.
  test("ticking a criterion routes to all three SC census tests", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["- [x] SC-9101: a thing is true"] }),
    ]);
    for (const t of SC_CENSUS) {
      expect(tests, `a tick did not route to ${t} — this is #985 again`).toContain(t);
    }
  });

  // The discrimination that makes the case above a measurement. A spec tick
  // also fires `spec-edit`, so `tests.length > 0` is green under a router
  // with no `spec-tick` row at all. Naming the three paths is what differs.
  test("a tick routes to MORE than the spec-edit pair", () => {
    const tick = censusTestsFor([
      change({ path: "specs/X.md", added: ["- [x] SC-9102: another thing"] }),
    ]);
    const edit = censusTestsFor([change({ path: "specs/X.md", added: ["some prose"] })]);
    expect(edit.tests.length, "the spec-edit row stopped firing").toBeGreaterThan(0);
    expect(
      tick.tests.length - edit.tests.length,
      "a tick and a prose edit route to the same set, so the tick row is doing nothing",
    ).toBe(SC_CENSUS.length);
  });

  // The SECOND namespace, and the row that would have caught #1298 leaving
  // this router behind. `CRC-A1`..`CRC-N5` are tracked criteria by
  // `TRACKED_ID_PREFIXES`, so ticking one moves `UNCLAIMED_RATCHET`,
  // `CLAIMED_UNBINDABLE` and the per-spec census exactly as ticking an `SC-`
  // does — and until the prefix here came out of `lib/sc-ids.ts`, a `CRC-`
  // tick routed the spec-edit pair and nothing else.
  //
  // Driven from `TRACKED_ID_PREFIXES` rather than over the literal string
  // "CRC", so a THIRD prefix added to that list is covered the day it lands
  // instead of reproducing this defect a second time. `SC` is skipped
  // because the two cases above already measure it; what this asserts is
  // that no member of the list is unrouted.
  //
  // The baseline is a prose edit to the SAME path, not to `specs/X.md`. #1442
  // added a row whose target is derived from the spec's own name, so a
  // baseline on a different spec varies two things at once — the tick AND
  // whether the spec has a suite named after it — and the delta would be 5
  // for `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` and 4 for a spec with no such
  // suite. Same path, differing only in the tick, is the pair discipline
  // `.claude/rules/checks-must-be-able-to-fail.md` asks for.
  test("every tracked prefix routes a tick, not only the first one", () => {
    const edit = censusTestsFor([
      change({ path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"] }),
    ]);
    for (const prefix of TRACKED_ID_PREFIXES) {
      const { tests } = censusTestsFor([
        change({
          path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md",
          added: [`- [x] ${prefix}-9104: a criterion in the ${prefix} namespace`],
        }),
      ]);
      for (const t of SC_CENSUS) {
        expect(tests, `a ${prefix}- tick did not route to ${t} — #990 in a second namespace`)
          .toContain(t);
      }
      // Same discrimination as the SC case: `spec-edit` fires on any specs/
      // line, so membership alone is green under a router with no tick row.
      expect(
        tests.length - edit.tests.length,
        `a ${prefix}- tick routes the same set as a prose edit`,
      ).toBe(SC_CENSUS.length);
    }
    expect(
      TRACKED_ID_PREFIXES.length,
      "the prefix list is empty, so the loop above asserted nothing",
    ).toBeGreaterThan(1);
  });

  // CONTROL against the cheapest wrong generalisation: fire on any specs/
  // change. That would make the witness above green while routing three
  // census suites on every spec edit in the repo.
  test("a spec edit that ticks nothing does not route to the SC census", () => {
    const { tests } = censusTestsFor([
      change({
        path: "specs/HARNESS-STANDARD.md",
        added: ["- [ ] SC-9103: a new, unticked criterion", "some prose"],
        removed: ["older prose"],
      }),
    ]);
    for (const t of SC_CENSUS) {
      expect(tests, `an unticked edit routed to ${t}`).not.toContain(t);
    }
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // An UNTICK lowers the same numbers. `sc-binding-split.test.ts` brackets
  // both of its counts with an equality, so a fall is red there even where
  // `ticked-sc-cover.test.ts`'s per-spec `<=` ratchet stays green — which is
  // the inverse #990 says it does not cover, and routing it is free.
  test("unticking a criterion routes to the same three", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/X.md", removed: ["- [x] SC-9104: withdrawn"] }),
    ]);
    for (const t of SC_CENSUS) expect(tests).toContain(t);
  });

  test("a change outside specs/ carrying a ticked line does not route the census", () => {
    // A docstring quoting a criterion is not a tick. The path is half the
    // trigger for exactly this reason.
    const { tests } = censusTestsFor([
      change({ path: "lib/thing.ts", added: ["// - [x] SC-9105: quoted in a comment"] }),
    ]);
    for (const t of SC_CENSUS) expect(tests).not.toContain(t);
  });
});

describe("#990: the rule file's block is the router's table", () => {
  /**
   * Rendered from the triggers, so the document has no independent copy to
   * drift. This is the answer to "what keeps the prose correct when the
   * census set changes": nothing in the document is maintained by hand.
   */
  function expectedBlock(): string {
    const rows = CENSUS_TRIGGERS.map(
      t =>
        `| ${t.event} | ${t.derivedTarget ?? t.tests.map(p => `\`${p}\``).join(" ")} |`,
    );
    return ["| what you did | what to run |", "|---|---|", ...rows].join("\n");
  }

  test("the table in the rule file is byte-identical to the rendered one", () => {
    const doc = readFileSync(RULE, "utf-8");
    expect(
      doc.includes(expectedBlock()),
      "the routing table in .claude/rules/self-referential-tests.md no longer matches " +
        "CENSUS_TRIGGERS in scripts/census-routing.ts. The router is the source of truth; " +
        `replace the table with exactly:\n\n${expectedBlock()}\n`,
    ).toBe(true);
  });

  test("the rule file names no census test the router cannot route", () => {
    // The other direction. Without it the document may carry an extra row
    // below the rendered block and still contain it.
    const doc = readFileSync(RULE, "utf-8");
    const at = doc.indexOf("## What to run before you push");
    expect(at, "the section heading moved; this search read nothing").toBeGreaterThan(-1);
    // Cut to the NEXT heading, not to the end of the document. The sections
    // below this one name census tests for other reasons, and a search over
    // the whole file is satisfied by any of them — `.claude/rules/
    // checks-must-be-able-to-fail.md`, "search the slice, not the document".
    const rest = doc.slice(at + 1);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);
    const named = [...new Set(section.match(/test\/[\w.-]+\.test\.tsx?/g) ?? [])].sort();
    expect(named.length, "the section names no test at all").toBeGreaterThan(0);
    expect(named, "a test is named in the section that no trigger routes to").toEqual(
      [...allCensusTests()].sort(),
    );
  });

  // CONTROL. A table naming a renamed-away file is a table that sends the
  // next agent to a `bun test` that silently matches nothing.
  test("every routed test exists on disk", () => {
    const missing = allCensusTests().filter(t => !existsSync(join(REPO, t)));
    expect(missing, "a routed census test does not exist").toEqual([]);
  });

  // #1442. A derived row has no fixed path list, so its cell is prose, and
  // prose in this section is read by the case above as a routed test the
  // moment it spells one. That is an accident of the regex today; this binds
  // it. A derived cell that names a concrete path would have to be in
  // `allCensusTests()` too, and a derived row's membership is a property of
  // the tree rather than of the table — which is the whole reason it is
  // derived.
  test("a derived row's table cell spells no concrete test path", () => {
    const derived = CENSUS_TRIGGERS.filter(t => t.derivedTarget !== undefined);
    expect(derived.length, "no row derives its targets, so this asserted nothing").toBeGreaterThan(
      0,
    );
    for (const t of derived) {
      expect(
        t.derivedTarget!.match(/test\/[\w.-]+\.test\.tsx?/g) ?? [],
        `the ${t.id} row's table cell spells a concrete test path, which the rule file's ` +
          "section comparison would then read as a routed test",
      ).toEqual([]);
    }
  });

  test("the router routes the SC census, which it is the point of", () => {
    // Non-vacuity for the two cases above: they compare sets, and two empty
    // sets are equal.
    for (const t of SC_CENSUS) expect(allCensusTests()).toContain(t);
  });
});

describe("#1306: adding a spec is a third event, with its own blast radius", () => {
  /**
   * #990 split `specs/` into an edit and a tick. It is three events, not two:
   * ADDING a spec reddens census files that neither of the other two can.
   *
   * Measured on this tree rather than grepped. A probe spec was planted in
   * `specs/`, the 143 test files whose source names `specs` were run against
   * it, and the baseline was read first — 6802 pass, 0 fail, 143 files. With
   * the probe present, six files went red, of which `sc-fixture-namespace`
   * was the probe's own fault (its id sat in the reserved fixture range above
   * nine thousand; re-cut below that floor, where a real allocation lands, it
   * is green — and that is the input on which the two probes differ). The id
   * is spelled in words here deliberately: writing the digits would plant a
   * live-namespace fixture id in a test file, which `SC-1522` refuses, and
   * this docstring did exactly that on its first push. The five that fire on
   * an ordinary new spec:
   *
   *   test/scaffold-conformity.test.ts   DRIFT-2, HYGIENE-2/3/4   routed: new-file
   *   test/agents-md-spec-listing.test.ts SC-1891                 routed: spec-edit
   *   test/audit-specs.test.ts           SC-398 compliance:strict routed: NOTHING
   *   test/scanner.test.ts               #91 docs-routing count   routed: NOTHING
   *   test/spec-drift.test.ts            DRIFT-2                  routed: NOTHING
   *
   * `spec-drift.test.ts` is deliberately NOT routed. Its whole body is
   * `runSpecDrift(ROOT)` — the same binding `scaffold-conformity.test.ts`
   * runs DRIFT-2 through, and that file is already routed by `new-file`. Two
   * deciders that agree are behaviourally one, and a row naming both spends
   * instruction surface to run the same check twice.
   *
   * So the row routes two files and costs 1.3s, against a 36-file list the
   * issue sized by grep. The denominator matters less than the direction: a
   * router that names everything is ignored, and an ignored router is the
   * state before #990.
   *
   * ## What was broken to prove it, run and counted
   *
   * Over this file (15 tests). Every count AND membership was predicted
   * before the battery ran, and the baseline row was read first.
   *
   * | Row | Predicted | Measured | The input on which mutant and original differ |
   * |---|---|---|---|
   * | **baseline** — unmutated | 15 pass, 0 fail | **15 pass, 0 fail** | — |
   * | the `new-spec` row deleted — the genuinely pre-#1306 router | 3: W1, T1, T2 | **3 of 15**, the three named | `{path: "specs/NEW-THING-SPEC.md", isNew: true}`: the original routes `audit-specs` and `scanner`, the mutant routes neither |
   * | wrong fix #1, router only: the two appended to `spec-edit` | 3: C2, T1, T2 | **2 of 15**: C2, T1 | a prose edit to an existing spec: the original routes neither file, the mutant routes both |
   * | wrong fix #2, router only: the two appended to `new-file` | 3: C3, T1, T2 | **2 of 15**: C3, T1 | a new `lib/unrelated.ts`: same |
   * | wrong fix #1 applied FAITHFULLY — router AND rendered table | not predicted | **1 of 15**: C2 | the prose edit above |
   * | wrong fix #2 applied FAITHFULLY — router AND rendered table | not predicted | **1 of 15**: C3 | the new `lib/` file above |
   *
   * **Rows 3 and 4 came back LOW, and the reason is a fact about T2 worth
   * recording rather than a collapsed pair.** T2 compares the SET of test
   * names in the rule file's section to `allCensusTests()`. Moving a test
   * from one row to another leaves that set identical, so T2 cannot see row
   * placement at all — by design, since what it exists to catch is a test
   * named in the prose that no row routes. Only T1, which is byte-for-byte,
   * sees which row a test sits on. The prediction assumed two table cases
   * where there is one.
   *
   * **Rows 5 and 6 are the ones that matter, and they are why rows 3 and 4
   * are not the real measurement.** T1 goes red the instant the router
   * changes, so nobody can apply either wrong fix and leave it: the 5pm
   * repair regenerates the table in the same breath, and then T1 and T2 are
   * both green. What is left is one case — the control written against that
   * exact fix — and it is red. Both controls survive their wrong fix
   * NON-vacuously, which is the only grade of survival that is protection.
   */
  const newSpec = () =>
    censusTestsFor([change({ path: "specs/NEW-THING-SPEC.md", isNew: true, added: ["# New"] })]);

  // WITNESS. Red on the pre-#1306 router, which routes neither.
  test("adding a specs/ file routes the census tests a new spec reddens", () => {
    const { tests } = newSpec();
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `adding a spec did not route to ${t} — this is #1298 again`).toContain(t);
    }
  });

  // CONTROL against the cheapest wrong fix: append the two to `spec-edit`.
  // That is one line, it makes the witness above green, and it routes them on
  // every prose edit to every spec forever. Measured: a prose edit to
  // `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` reddens neither file.
  test("a prose edit to an existing spec does not route them", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"] }),
    ]);
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `a prose edit routed to ${t}, which it cannot redden`).not.toContain(t);
    }
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // CONTROL against the second-cheapest wrong fix: append the two to
  // `new-file`, which already fires on this diff. Also one line, also makes
  // the witness green, and routes a spec census on every new `lib/` file.
  test("a new file outside specs/ does not route them", () => {
    const { tests } = censusTestsFor([
      change({ path: "lib/unrelated.ts", isNew: true, added: ["export const a = 1;"] }),
    ]);
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `a new lib/ file routed to ${t}`).not.toContain(t);
    }
    expect(tests, "the new-file row stopped firing").toContain(
      "test/scaffold-conformity.test.ts",
    );
  });
});

describe("#990: the diff parser does not invent a tick", () => {
  test("a `--- a/path` header is not read as a removed line", () => {
    // `--- a/specs/X.md` starts with `-`. Counted as a removal, every diff
    // touching a spec would look like an untick — the router would fire on
    // every spec edit and the control case above would be the only thing
    // between that and a silently useless table.
    const diff = [
      "diff --git a/specs/X.md b/specs/X.md",
      "index 1111111..2222222 100644",
      "--- a/specs/X.md",
      "+++ b/specs/X.md",
      "@@ -1 +1 @@",
      "-older prose",
      "+newer prose",
    ].join("\n");
    const [c] = parseUnifiedDiff(diff);
    expect(c.path).toBe("specs/X.md");
    expect(c.removed).toEqual(["older prose"]);
    expect(c.added).toEqual(["newer prose"]);
    expect(censusTestsFor([c]).tests).not.toContain("test/sc-binding-split.test.ts");
  });

  test("a new file is read as new, and a modified one is not", () => {
    const diff = [
      "diff --git a/test/new-thing.test.ts b/test/new-thing.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/new-thing.test.ts",
      "@@ -0,0 +1 @@",
      '+test("x", () => {});',
      "diff --git a/lib/old.ts b/lib/old.ts",
      "--- a/lib/old.ts",
      "+++ b/lib/old.ts",
      "@@ -1 +1 @@",
      "+const a = 1;",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.map(c => [c.path, c.isNew])).toEqual([
      ["test/new-thing.test.ts", true],
      ["lib/old.ts", false],
    ]);
    const { tests } = censusTestsFor(parsed);
    expect(tests).toContain("test/sc-id-namespace.test.ts");
    expect(tests).toContain("test/package-closure.test.ts");
  });

  test("each fired row carries the paths that fired it", () => {
    // A router that says what to run and not why is a list again.
    const { fired } = censusTestsFor([
      change({ path: "specs/A.md", added: ["- [x] SC-9106: a"] }),
      change({ path: "lib/b.ts", added: ["const b = 1;"] }),
    ]);
    const tick = fired.find(f => f.trigger.id === "spec-tick");
    expect(tick?.because).toEqual(["specs/A.md"]);
  });
});

/**
 * #1368: a generated workflow is routed to the suites that READ it.
 *
 * `lib/scaffold/**` already routed to the ownership family — which files the
 * scaffold owns, which gates exist, which hooks are traceable. Nothing routed
 * to the suites that read the committed `.github/workflows/*.yml` and assert
 * properties of its TEXT.
 *
 * Paid for on PR #1351. Shard 3 went red on `AC-2 (#1116)` in
 * `test/ai-review-runner-shell-parity.test.ts` — two new `rf=$(...)`
 * assignments were #1110's shape — after every suite the router named, and
 * the four `ai-review-*` suites a person would think to name, came back
 * green locally. The guard is unreachable from the diff by any route an
 * agent would take: not the source file's own suite, not the ownership
 * family, and its name shares no string with anything in the diff.
 */
const GENERATED_WORKFLOW_CENSUS = [
  "test/ai-review-runner-shell-parity.test.ts",
  "test/action-pin-parity.test.ts",
  "test/scaffold-permissions-merge.test.ts",
  // #1401. Both caught a real defect in #1387, both on shard 4, and both
  // survived a targeted run of the three above. Same shape as #1351: a
  // guard the diff gives an agent no route to.
  "test/ai-review-wif.test.ts",
  "test/no-fixed-window-slices.test.ts",
];

/**
 * #1387's diff, verbatim, as the exemplar that motivated #1401.
 *
 * `git show --name-only --format='' 1de742aa` — the merge of #1387, the
 * change on which both new members caught something. Written out rather
 * than read from git, because a fixture that re-reads the commit tests
 * whatever that commit is today, and the point is the shape of the diff
 * that was in front of CI.
 */
const PR_1387_PATHS = [
  ".github/workflows/ai-review.yml",
  "lib/scaffold/ai-review-step.ts",
  "specs/CODE-REVIEW-CONVERGENCE-SPEC.md",
  "test/ai-review-rounds-step.test.ts",
];

describe("#1368: a generated workflow routes to the suites that read it", () => {
  test("PR #1351's own diff routes the guard that caught it", () => {
    const { tests } = censusTestsFor([
      change({ path: "lib/scaffold/ai-review-step.ts" }),
      change({ path: ".github/workflows/ai-review.yml" }),
    ]);
    for (const t of GENERATED_WORKFLOW_CENSUS) {
      expect(tests, `#1351's diff did not route to ${t} — this is #1368 again`).toContain(t);
    }
  });

  test("a change confined to .github/workflows/ routes something at all", () => {
    // Before this row, a diff touching only a generated workflow fired NO
    // row: the router printed nothing, which an agent reads as "nothing else
    // has an opinion about this change" rather than as "the router has no
    // rule for it". Those are the two states this whole file is about.
    const { tests } = censusTestsFor([change({ path: ".github/workflows/ai-review.yml" })]);
    expect(tests, "a generated-workflow change still routes nothing").not.toEqual([]);
    for (const t of GENERATED_WORKFLOW_CENSUS) expect(tests).toContain(t);
  });

  test("a scaffold edit routes MORE than the ownership trio", () => {
    // The discrimination, and the reason membership alone is not enough:
    // `lib/scaffold/**` fires `gates-hooks-scaffold` too, so a case asserting
    // only that SOME tests routed is green under a router with no row here.
    // `hooks/` fires that row and nothing else, so the delta is this row.
    const scaffold = censusTestsFor([change({ path: "lib/scaffold/ai-review-step.ts" })]);
    const hooks = censusTestsFor([change({ path: "hooks/Example.hook.ts" })]);
    expect(hooks.tests.length, "the gates-hooks-scaffold row stopped firing").toBeGreaterThan(0);
    expect(
      scaffold.tests.length - hooks.tests.length,
      "a scaffold edit and a hooks edit route the same set, so this row is doing nothing",
    ).toBe(GENERATED_WORKFLOW_CENSUS.length);
  });

  test("an ordinary source edit is NOT routed here", () => {
    // The negative control. A row that fires on everything routes the whole
    // suite for every diff, which is the same as having no router — and it
    // would make all three cases above pass for the wrong reason.
    const { tests } = censusTestsFor([change({ path: "lib/ai-review-rounds.ts" })]);
    for (const t of GENERATED_WORKFLOW_CENSUS) {
      expect(tests, `${t} is routed by an edit touching no generated workflow`).not.toContain(t);
    }
  });

  // #1401's own acceptance: run the amended row against the exemplar that
  // motivated it. A row justified by "it would have caught #1387" that does
  // not select those suites for #1387's actual paths is still the wrong row,
  // and nothing above would say so — the cases there use a two-path fixture
  // written to fire it.
  test("#1387's real four paths select both suites that caught it", () => {
    const { tests, fired } = censusTestsFor(PR_1387_PATHS.map(path => change({ path })));
    expect(tests, "#1387's diff does not route the WIF guard that caught it").toContain(
      "test/ai-review-wif.test.ts",
    );
    expect(tests, "#1387's diff does not route the fixed-window guard that caught it").toContain(
      "test/no-fixed-window-slices.test.ts",
    );
    // Not vacuous on the row: two of those four paths fire other rows, so a
    // table with no generated-workflow row at all still returns a non-empty
    // set for this diff. Name the row that has to be among the fired ones.
    expect(
      fired.map(f => f.trigger.id),
      "the generated-workflow row did not fire on the diff it was written for",
    ).toContain("generated-workflow");
  });

  // The spec file and the rounds-step suite in #1387's diff are the half
  // that fire OTHER rows. Without this, the case above could be green on a
  // router whose generated-workflow row matched every path.
  test("the two non-generated paths in #1387 do NOT fire this row", () => {
    const { fired } = censusTestsFor(
      ["specs/CODE-REVIEW-CONVERGENCE-SPEC.md", "test/ai-review-rounds-step.test.ts"].map(path =>
        change({ path }),
      ),
    );
    expect(fired.map(f => f.trigger.id)).not.toContain("generated-workflow");
  });
});

/**
 * #1442: a `specs/` edit routes the suite named after that spec.
 *
 * #990 split `specs/` into an edit and a tick; #1306 added the add. All three
 * route the SAME fixed set, and none of them routes the spec's OWN suite —
 * the file whose entire subject is that one document.
 *
 * Measured twice, four days apart, by the same session on two branches:
 * #1439 ticked `CRC-E4` and #1450 ticked `CRC-M11` in
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`, each left the criterion in the
 * not-done bucket, each ran the six suites the router printed, each was green
 * locally, and each went red in CI on `test/code-review-convergence-spec.test.ts`
 * — *"criteria in TWO buckets: the states are meant to be exclusive"*. Two CI
 * rounds for a defect a one-second local run catches, on the spec whose own
 * ranking function is rounds-to-pass.
 *
 * ## The convention, and what was deliberately NOT adopted
 *
 * `specs/<NAME>.md` routes to `test/<lowercase NAME>.test.ts` when that file
 * exists. One pair resolves on this tree, and it is the pair that cost the
 * two rounds.
 *
 * The obvious widening — also accept the name with a trailing `-spec`
 * removed — was measured and rejected. It adds four candidates:
 * `test/gate-contracts.test.ts`, `test/instruction-compliance.test.ts` and
 * `test/scaffold-decomposition.test.ts` contain their spec's filename zero
 * times and read no spec document at all (they test `gates/`, `lib/compliance`
 * and `scripts/scaffold-project.ts`), so an edit to the spec cannot redden
 * any of them; `test/agent-brief-template.test.ts` names its spec once, in a
 * `describe` title. Routing four suites that a spec edit cannot redden is the
 * "router that names more than it has to" the #1306 row above already argues
 * against, and an ignored router is the state #990 is about.
 *
 * A spec with no suite named after it routes to NOTHING, and the row does not
 * fire at all — absent, not empty. A row that fired with an empty target
 * would read exactly like a spec whose suite was renamed away.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (35 tests). Every count AND membership was predicted before
 * the battery ran, and the baseline row was read first — an instrument that
 * has stopped reporting takes the baseline down with it, and `bun` writes its
 * summary to stderr, so a reader parsing stdout alone reports nothing at all.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 35 pass, 0 fail | **35 pass, 0 fail** | — |
 * | the `spec-own-test` entry deleted, router only | 6: W1, W2, D1, F1, T3, and the byte-identity case | **6 of 35**, the six named | the CRC prose edit below |
 * | the same, applied FAITHFULLY — the rendered table reverted too | 5: W1, W2, D1, F1, T3 | **5 of 35**, the five named | `{path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"]}`: the original routes `agents-md-spec-listing`, `spec-requirements` AND `code-review-convergence-spec`, the mutant routes the first two |
 * | the `doc` row's detector respelled back to `/[\w./-]+\.tsx?:\d+/` | 3: B1, B2, B4 | **3 of 35**, the three named | `{path: "PROJECT-STATE.md", removed: ["- the pin is read at \`workflows/ship.js:1705\`"]}` — #1466's own removed line: the original routes the ratchet pair, the mutant routes **nothing at all** |
 * | the empty-derivation filter dropped, so a derived row fires with no target | 1: C2 | **1 of 35**, the one named | `{path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9108: not yet"]}`: the original omits the row from `fired`, the mutant lists it carrying zero tests |
 * | **the cheapest wrong fix**, applied faithfully: the derived row deleted, `test/code-review-convergence-spec.test.ts` appended to `spec-edit` as a literal, table regenerated | 5: W2, D1, C2, F1, T3 | **5 of 35**, the five named | the HARNESS-STANDARD edit above: the original routes two tests, the mutant routes three, one of which is a suite about a document the diff does not touch |
 *
 * **W1 is GREEN under the wrong fix**, which is why it is not the whole
 * proof. A literal row satisfies "a spec edit routes that suite" exactly, and
 * what it cannot satisfy is D1 — the delta between a spec that has a suite
 * named after it and one that does not — or C2, or the two cases that are
 * about the derivation existing at all. Every one of C1..C3 survives the
 * wrong fixes non-vacuously, which is the only grade of survival that is
 * protection.
 *
 * Case labels, since four of the eight are controls and the next reader
 * should not count eight witnesses:
 *
 *   W1  "a prose edit to a spec routes the suite named after it"
 *   W2  "ticking a criterion routes the spec's own suite too"
 *   D1  "a spec WITH an own suite routes exactly one more test …"
 *   F1  "a spec whose suite does not exist today is routed the moment it does"
 *   T3  "a derived row's table cell spells no concrete test path"
 *   C1  "a change outside specs/ does not route a spec's own suite"
 *   C2  "a spec with no suite named after it routes nothing, and the row does not fire"
 *   C3  "a suite named after the spec's STEM is not routed when it never reads the spec"
 *   B1  "a doc LOSING a .js line citation routes the ratchet"
 *   B2  "a doc gaining a .json line citation routes the ratchet"
 *   B4  "the router and the ratchet agree about every sample, both directions"
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `scripts/census-routing.ts` and
 * `.claude/rules/self-referential-tests.md` were confirmed byte-identical to
 * the measured source afterwards by sha256.
 */
describe("#1442: a specs/ edit routes the suite named after that spec", () => {
  const CRC_SPEC = "specs/CODE-REVIEW-CONVERGENCE-SPEC.md";
  const CRC_TEST = "test/code-review-convergence-spec.test.ts";

  // Non-vacuity for every case below. Written as literals rather than read
  // from `ownSpecTestPath`, because a pair derived from the thing it checks
  // agrees with it by construction.
  test("the live pair this row exists for is still on disk", () => {
    expect(existsSync(join(REPO, CRC_SPEC)), `${CRC_SPEC} was renamed`).toBe(true);
    expect(existsSync(join(REPO, CRC_TEST)), `${CRC_TEST} was renamed`).toBe(true);
    expect(ownSpecTestPath(CRC_SPEC), "the convention stopped resolving the live pair").toBe(
      CRC_TEST,
    );
  });

  // W1. WITNESS — red on the pre-#1442 router, which routes the fixed pair
  // and nothing else for this diff.
  test("a prose edit to a spec routes the suite named after it", () => {
    const { tests } = censusTestsFor([change({ path: CRC_SPEC, added: ["some prose"] })]);
    expect(tests, `a spec edit did not route to ${CRC_TEST} — this is #1439 again`).toContain(
      CRC_TEST,
    );
  });

  // W2. WITNESS — #1439's and #1450's own event, a tick, which is the diff
  // that was in front of CI both times.
  test("ticking a criterion routes the spec's own suite too", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: CRC_SPEC, added: ["- [x] CRC-9107: a criterion that is also still in a bucket"] }),
    ]);
    expect(tests, `#1450's diff did not route to ${CRC_TEST}`).toContain(CRC_TEST);
    expect(
      fired.map(f => f.trigger.id),
      "the own-test row did not fire on the diff it was written for",
    ).toContain("spec-own-test");
  });

  // D1. The discrimination that makes W1 a measurement. A spec edit fires
  // `spec-edit` whatever else is true, so `tests.length > 0` is green on the
  // pre-#1442 router. Both halves are a prose edit to a spec; they differ in
  // exactly one thing, which is whether a suite is named after it.
  test("a spec WITH an own suite routes exactly one more test than a spec without", () => {
    const withOwn = censusTestsFor([change({ path: CRC_SPEC, added: ["some prose"] })]);
    const without = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["some prose"] }),
    ]);
    expect(without.tests.length, "the spec-edit row stopped firing").toBeGreaterThan(0);
    expect(
      withOwn.tests.length - without.tests.length,
      "the two specs route the same set, so the own-test row is doing nothing",
    ).toBe(1);
  });

  // C1. CONTROL. A diff touching no spec must not route it. Without this a
  // row that fires on everything passes W1 and D1 is the only thing between
  // that and routing the CRC suite on every diff in the repo.
  test("a change outside specs/ does not route a spec's own suite", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "lib/code-review-convergence-spec.ts", added: ["export const a = 1;"] }),
    ]);
    expect(tests, `${CRC_TEST} is routed by a change touching no spec`).not.toContain(CRC_TEST);
    expect(fired.map(f => f.trigger.id)).not.toContain("spec-own-test");
  });

  // C2. CONTROL against the cheapest wrong fix: append CRC_TEST to the
  // `spec-edit` row as a literal. One line, W1 and W2 both go green, and the
  // CRC suite then runs on every edit to every spec forever — and silently
  // routes nothing the day that file is renamed.
  //
  // It also asserts the row is ABSENT rather than firing empty: a spec with
  // no suite named after it must not appear in `fired` at all.
  test("a spec with no suite named after it routes nothing, and the row does not fire", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9108: not yet"] }),
    ]);
    expect(
      existsSync(join(REPO, "test/harness-standard.test.ts")),
      "a suite named after HARNESS-STANDARD.md now exists; this control needs a different spec",
    ).toBe(false);
    expect(tests, "an unrelated spec edit routed the CRC suite").not.toContain(CRC_TEST);
    expect(
      fired.map(f => f.trigger.id),
      "the own-test row fired for a spec with no own test — empty, not absent",
    ).not.toContain("spec-own-test");
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // C3. CONTROL against the second wrong fix: accept the name with a trailing
  // `-spec` stripped. `test/gate-contracts.test.ts` reads `gates/` and never
  // opens `specs/GATE-CONTRACTS-SPEC.md`, so an edit to that spec cannot
  // redden it. Measured, not assumed — the case reads the file.
  test("a suite named after the spec's STEM is not routed when it never reads the spec", () => {
    const stemTest = "test/gate-contracts.test.ts";
    const spec = "specs/GATE-CONTRACTS-SPEC.md";
    expect(existsSync(join(REPO, stemTest)), `${stemTest} was renamed`).toBe(true);
    expect(
      readFileSync(join(REPO, stemTest), "utf-8").includes("GATE-CONTRACTS-SPEC.md"),
      `${stemTest} now names its spec, so the measurement behind this control has moved`,
    ).toBe(false);
    const { tests } = censusTestsFor([change({ path: spec, added: ["some prose"] })]);
    expect(tests, `${stemTest} was routed by an edit to a spec it never reads`).not.toContain(
      stemTest,
    );
  });

  // The target is DERIVED, not a list. A spec that gains a suite tomorrow is
  // routed the day it lands, and this is the only case that can say so —
  // every other one is satisfied by a literal pair written into the table.
  test("a spec whose suite does not exist today is routed the moment it does", () => {
    const spec = "specs/HARNESS-STANDARD.md";
    const future = ownSpecTestPath(spec);
    expect(
      existsSync(join(REPO, future)),
      "this case needs a pair that does NOT resolve on the live tree",
    ).toBe(false);
    const { tests } = censusTestsFor([change({ path: spec, added: ["some prose"] })], p =>
      p === future ? true : existsSync(join(REPO, p)),
    );
    expect(tests, "the row reads a fixed list, not the tree").toContain(future);
  });
});

/**
 * #1442, second population: the `doc` row's citation detector was a second
 * spelling of the ratchet's.
 *
 * `.claude/line-citation-ratchet.json` banks a count per document and
 * `test/line-citation-ratchet.test.ts` refuses a banked document that yields
 * none. The binding that decides what a citation IS is `LINE_CITATION` in
 * `lib/line-citation.ts`, and it matches `.ts`, `.js` and `.json`. This
 * router respelled it as `\.tsx?:\d+` — narrower on two extensions and wider
 * on a third.
 *
 * Measured, not inferred. PR #1466 rewrote `PROJECT-STATE.md`'s priorities
 * block and removed exactly two citations:
 *
 *   $ git show 577a078a -- PROJECT-STATE.md | grep '^-' | grep -oE '…'
 *     ship.js:2931
 *     workflows/ship.js:1705
 *
 * Both `.js`. The router saw neither, printed only the `touched specs/` row,
 * and CI went red on shard 1 with `NoLineCitationsError: PROJECT-STATE.md is
 * banked in the citation ratchet as carrying line citations and the census
 * found none`. One full CI round on a documentation-only change.
 *
 * The fix is the one `TRACKED_ID_PREFIX_SOURCE` already applies one row up:
 * import the binding instead of respelling it. A reader that respells is a
 * reader that decides again.
 */
describe("#1442: the doc row asks the ratchet's own binding what a citation is", () => {
  const RATCHET = "test/line-citation-ratchet.test.ts";
  const routes = (line: string, side: "added" | "removed" = "added") =>
    censusTestsFor([
      change({
        path: "PROJECT-STATE.md",
        added: side === "added" ? [line] : [],
        removed: side === "removed" ? [line] : [],
      }),
    ]).tests.includes(RATCHET);

  // WITNESS. #1466's own removed line, verbatim in shape.
  test("a doc LOSING a .js line citation routes the ratchet", () => {
    expect(
      routes("- the pin is read at `workflows/ship.js:1705`", "removed"),
      "a removed .js citation did not route the ratchet — this is #1466 again",
    ).toBe(true);
  });

  test("a doc gaining a .json line citation routes the ratchet", () => {
    expect(routes("see `config/check-registry.json:12`")).toBe(true);
  });

  // CONTROL. A row that fires on every markdown line would make both
  // witnesses green while routing the ratchet for every doc edit in the repo
  // — which is the `doc` row's `isNew` half doing all the work and the
  // citation half doing none.
  test("a doc edit carrying no citation does not route the ratchet", () => {
    expect(routes("a sentence about workflows/ship.js with no line number")).toBe(false);
    expect(routes("released in 1.2:3, which is a version and not a citation")).toBe(false);
  });

  // The agreement itself, in both directions. A second spelling can be
  // narrower OR wider: `.tsx:9` is matched by the old regex and by no
  // citation the ratchet counts, so a doc gaining one routed a suite that
  // could not see it.
  test("the router and the ratchet agree about every sample, both directions", () => {
    const samples = [
      "the reader is at `lib/line-citation.ts:54`",
      "the pin is at workflows/ship.js:1705",
      "the row is at config/check-registry.json:12",
      "the component is at app/Thing.tsx:9",
      "released in 1.2:3",
      "a bare lib/line-citation.ts with no line",
      "ship.js:2931 opens the line",
    ];
    const ratchet = new RegExp(LINE_CITATION.source);
    let matched = 0;
    for (const s of samples) {
      const expected = ratchet.test(s);
      if (expected) matched++;
      expect(
        routes(s),
        `the router and lib/line-citation.ts disagree about "${s}" — the router has a ` +
          "second spelling of what a citation is",
      ).toBe(expected);
    }
    expect(matched, "no sample matched, so the loop compared two constant falses").toBeGreaterThan(
      0,
    );
    expect(
      samples.length - matched,
      "every sample matched, so the loop never exercised the negative direction",
    ).toBeGreaterThan(0);
  });
});
