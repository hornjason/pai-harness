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
  parseUnifiedDiff,
  type Change,
} from "../scripts/census-routing";

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
      t => `| ${t.event} | ${t.tests.map(p => `\`${p}\``).join(" ")} |`,
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

  test("the router routes the SC census, which it is the point of", () => {
    // Non-vacuity for the two cases above: they compare sets, and two empty
    // sets are equal.
    for (const t of SC_CENSUS) expect(allCensusTests()).toContain(t);
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
