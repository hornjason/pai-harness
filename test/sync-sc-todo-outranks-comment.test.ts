/**
 * #810 — a `.todo` naming a criterion outranks a comment that cites it.
 *
 * `main` is green. What is not green is `main` after running a command this
 * repository documents: `bun scripts/sync-sc-status.ts` flips four checkboxes
 * in `RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` and four tests go red. The
 * tree and its own sync tool disagree, and the only way to find out is to run
 * it.
 *
 * ## The loop, which is the part worth reading
 *
 * `audit-specs-fallback-scope.test.ts` is a test of the spec-REWRITING tool.
 * It quotes SC-1940 and SC-1943 in its docstring, on their own lines, because
 * they are its fixture input — and a line beginning with an id is a declaring
 * form, so `commentClaimForm` credits it. The sync ticks the criteria. The
 * same file then fails, because its premise asserts the spec still contains
 * the literal `- [ ] SC-1940: …`.
 *
 * A citation is read as a claim, the claim moves the tree, and the move breaks
 * the citing file. Nothing compared the two ends of it.
 *
 * ## Two readings of one question, and the weaker one won
 *
 * `coverageClaimSites` already marks a `.todo` title `unrun-title`, and
 * `findTestFilesForSCs` already refuses it — *"nothing can go red, so nothing
 * can be measured"* (#574). That refusal was per-POSITION: it drops the todo's
 * own claim and then accepts a comment in another file for the same id.
 *
 * So the tree held two statements about SC-1930 — *"no test runs for this"*
 * and *"a file declares this"* — and the second one decided. A todo is a
 * statement about execution. A comment is not. When no running title exists
 * for an id, the todo is the better evidence and it now wins.
 *
 * A running title still outranks a todo. A criterion with a real test beside a
 * stale todo is unaffected, which is `intendedOnly`'s original reasoning and
 * is kept: a report that cries wolf is ignored within a week.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Bank `CLAIMED_UNBINDABLE` at 76 and relax `rule-lifecycle-spec.test.ts`'s
 * "no SC is pre-checked".** Two one-line edits, both tests green, and four
 * citations are permanently certified as coverage for criteria that have no
 * test of any kind. It is the 5pm repair and it is invisible afterwards.
 *
 * Every case here survives it NON-vacuously: it changes no crediting decision,
 * so AC-1 through AC-4 are red on an unrepaired tree whether or not the
 * ratchet has been re-banked.
 *
 * ## What was broken to prove it
 *
 * Counted over this file plus `test/sc-todo-credit.test.ts` (10 tests). Every
 * count predicted before the battery ran, in `/tmp/810-battery/predictions.md`,
 * and **the baseline row was read before any mutation row**.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** | 10 pass, 0 fail | **10 pass, 0 fail** | — |
 * | B1 the `intended.has(id)` guard removed from `findTestFilesForSCs` | 4 | **4** — AC-1, AC-2, AC-4, SC-1957 | `CITING_SOURCE + TODO_LINE`: the original credits nothing for the probe, the mutant credits it |
 * | B2 `intendedOnly`'s `measured` widened back to `title \|\| (comment && form)` | 4 | **4** — AC-1, AC-2, AC-3, AC-4 | the same source: the original's report names the probe, the mutant's does not, so the guard has nothing to fire on |
 * | B3 `measured` never populated — a running title stops rescuing an id | 1 | **2** — AC-2, SC-1959 | `… + RUNNING_LINE`: the original credits the probe, the mutant does not |
 * | B4 the genuinely pre-#810 `scripts/sync-sc-status.ts` from `origin/main` | 4 | **4** — AC-1, AC-2, AC-3, AC-4 | the live tree: the original's dry-run prints no `Would flip … in RULE-LIFECYCLE…`, the pre-#810 source prints `Would flip 4 SCs` in it |
 * | B5 the intent-report `console.log` removed from the sync's main | 1 | **1** — AC-4 | the live tree: the original prints `SC-1930: … a declaration of intent`, the mutant prints nothing for it |
 *
 * **B1 and B2 are one wire mutated at each end** (#235), and they red
 * overlapping but different sets — which is the evidence the two ends are
 * independent rather than one decider wearing two names. B1 leaves the report
 * narrowed, so SC-1957 has something to see; B2 un-narrows it, so SC-1957 goes
 * back to holding vacuously and AC-3 reds instead.
 *
 * **B4 equals B2 and that is not a collapse.** B4 is B1 and B2 applied
 * together and B2 dominates: once the report un-narrows there is nothing for
 * the guard to suppress. Its value is that it is a real tree rather than a
 * reconstruction, and its count matching B2's is the evidence the
 * reconstruction is faithful.
 *
 * ## The row that found a dead decider
 *
 * A sixth row was run against the FIRST draft of the fix, whose guard read
 * `kind === "comment" && intended.has(id)`. Widening it to `intended.has(id)`
 * measured **0 of 10** against a predicted 1. Before believing a zero: there
 * is no input on which those two differ. `intendedOnly` excludes every id with
 * a running title, so the only kinds that can reach the guard for an id it
 * names are the ones the conjunct admits anyway. Two deciders answering one
 * question — the fourth shape — and the conjunct was the dead one.
 *
 * It mattered. On that draft **AC-2 was green under every row in the table**:
 * the case asserting that a running title outranks a todo had no witness,
 * because the property it names was enforced by a conjunct no mutation could
 * reach. Collapsing to one decider is what gives B3 something to break, and
 * B3 is the row that moved from 1 to 2 as a result.
 *
 * ## What this does NOT do
 *
 * It does not decide whether the four criteria are implemented. Nobody made
 * that judgement and this change does not make it either — it stops a tool
 * making it from a docstring in a file about something else.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { structuralCut } from "../lib/source-slice";
import {
  findTestFilesForSCs,
  findUncheckedSCs,
  intendedOnly,
  readScRegistry,
} from "../scripts/sync-sc-status";
import { scScanTestTimeout } from "./helpers/sc-scan-budget";

// The per-test budget for a case that scans the whole test tree (#1223).
// Calibrated on this machine and this tree rather than written down, so it
// has no expiry — see test/helpers/sc-scan-budget.ts.
setDefaultTimeout(scScanTestTimeout());

const REPO_ROOT = join(import.meta.dir, "..");
const SYNC_SOURCE = join(REPO_ROOT, "scripts", "sync-sc-status.ts");

/** The four #810 names, all unticked on `main` and all todo-declared. */
const CITED = ["SC-1930", "SC-1940", "SC-1943", "SC-1944"] as const;
const SPEC = "RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md";

/** Above the `SC-9000` fixture floor, so no real criterion is shadowed. */
const PROBE = "SC-9401";

/**
 * The declaring comment alone — a citation written in the shape of a claim,
 * which is the whole population this is about.
 */
const CITING_SOURCE = [
  "/**",
  " * A test of something else entirely, which quotes a criterion as input:",
  ` *   ${PROBE}: the probe criterion`,
  " */",
  'import { expect, test } from "bun:test";',
  "",
  'test("the rewriter keeps a criterion it cannot improve", () => {',
  "  expect(1).toBe(1);",
  "});",
  "",
].join("\n");

/** `test.todo` text appended; everything else is the same string. */
const TODO_LINE = `test.todo("${PROBE}: the probe criterion");`;
/** A title that RUNS, which must keep its credit whatever a todo says. */
const RUNNING_LINE = `test("${PROBE}: measured here", () => { expect(1).toBe(1); });`;

/** A project whose specs declare the probe once, so no qualifier is needed. */
function probeProject(testSource: string): { specs: string; tests: string } {
  const root = mkdtempSync(join(tmpdir(), "rungate-810-"));
  const specs = join(root, "specs");
  const tests = join(root, "test");
  mkdirSync(specs, { recursive: true });
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(specs, "PROBE.md"),
    ["---", "doc-type: spec", "testable: true", "governs: the probe", "---", "", "## Success Criteria", "", `- [ ] ${PROBE}: the probe criterion`, ""].join("\n"),
  );
  writeFileSync(join(tests, "probe.test.ts"), testSource);
  return { specs, tests };
}

/** The ids the sync would credit in a planted tree. */
function creditedIn(testSource: string): Set<string> {
  const { specs, tests } = probeProject(testSource);
  const credits = findTestFilesForSCs(findUncheckedSCs(specs), readScRegistry(specs), tests);
  return new Set([...credits.values()].flat().map(c => c.id));
}

describe("#810: a todo declaration outranks a comment that cites the id", () => {
  test("AC-1: the pair varies exactly one line, and that line removes the credit", () => {
    // #585's discipline. The second source is DERIVED from the first by
    // appending one line, so the pair cannot carry a second difference — two
    // hand-written literals can, and the next edit touches one of them.
    const withTodo = CITING_SOURCE + TODO_LINE + "\n";

    const before = CITING_SOURCE.split("\n");
    const after = withTodo.split("\n");
    expect(after.length, "the derivation changed more than one line").toBe(before.length + 1);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, before.length - 1));
    expect(after[after.length - 2]).toBe(TODO_LINE);

    // The premise, asserted rather than assumed: the citing source really is
    // credited today. Without this the case is satisfied by a reading that
    // credits nothing at all, which is what a broken fixture produces.
    expect(creditedIn(CITING_SOURCE), `${PROBE} is not credited from the citation, so nothing is being suppressed`).toContain(PROBE);
    expect(creditedIn(withTodo), `${PROBE} kept its comment credit beside a todo`).not.toContain(PROBE);
  });

  test("AC-2: a title that RUNS outranks the todo, so the fix is not 'todos suppress everything'", () => {
    // The boundary. Narrowing is the change most likely to buy green with
    // blindness, so the half that must NOT move is asserted too: a criterion
    // with a real test beside a stale todo keeps its credit.
    //
    // Its witness is battery row B3 — `intendedOnly`'s `measured` never
    // populated — and it had none at all until the guard's dead
    // `kind === "comment" &&` conjunct came out. See the header.
    const todoOnly = CITING_SOURCE + TODO_LINE + "\n";
    const alsoRunning = todoOnly + RUNNING_LINE + "\n";

    expect(creditedIn(todoOnly)).not.toContain(PROBE);
    expect(creditedIn(alsoRunning), "a running title stopped being coverage").toContain(PROBE);
  });

  test("AC-3: the suppression and the unmeasured report are one reading, not two", () => {
    // The fourth shape, avoided by construction rather than by agreement.
    // `intendedOnly` is the single binding; the credit rule consults it. Two
    // sets computed separately would always agree and a mutation of either
    // would leave the other holding every case up.
    const cited = probeProject(CITING_SOURCE);
    const todoed = probeProject(CITING_SOURCE + TODO_LINE + "\n");

    expect([...intendedOnly(cited.tests).keys()]).not.toContain(PROBE);
    expect([...intendedOnly(todoed.tests).keys()], "the id is suppressed but not reported — it would vanish").toContain(PROBE);

    // And the source says so, in the one position that decides. A comment
    // claiming the two are connected is not a connection.
    // Anchored on the BODY, not the signature: `balanced: "{"` resolved from
    // `export function findTestFilesForSCs(` closes on the object type inside
    // the parameter list and returns a cut of the signature, which contains
    // no call at all. A cut that reads the wrong region is the failure mode
    // `lib/source-slice.ts` exists against, met from the caller's side.
    //
    // #1223 renamed the binding and did not add a second one. The intended
    // set used to be computed in `intendedOnly`'s loop, which the credit
    // function called; it is now computed in `intendedFrom`, which BOTH call
    // — `intendedOnly` is a two-line wrapper over it. That is strictly one
    // binding rather than one-and-a-caller, so this case checks both halves
    // of the funnel instead of only the credit side.
    const source = readFileSync(SYNC_SOURCE, "utf-8");
    const decide = structuralCut(source, "  const dir = testDir || TEST_DIR;", {
      endAnchor: "\n}",
    });
    expect(decide.length, "the credit function was not found — the anchor moved").toBeGreaterThan(200);
    expect(decide, "the cut is not the credit function").toContain("wanted.get(id)");
    expect(decide, "findTestFilesForSCs does not consult the intended-set binding").toContain(
      "intendedFrom(",
    );

    const reported = structuralCut(source, "export function intendedOnly(", { endAnchor: "\n}" });
    expect(reported.length, "intendedOnly was not found — the anchor moved").toBeGreaterThan(50);
    expect(
      reported,
      "intendedOnly computes its own intended set — that is a second decider, not one binding",
    ).toContain("intendedFrom(");
  });

  test("AC-4: the live tree — the four are reported as intent, and flipped by nothing", () => {
    // The regression, end to end, through the real command. Reading the
    // binding would assert that a function can refuse; only a run asserts the
    // tree this repository ships is one the command leaves alone.
    const out = execFileSync("bun", [SYNC_SOURCE, "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 180_000,
    });

    // The instrument control FIRST. A script that died prints no flips
    // either, and silence is indistinguishable from success.
    expect(out, "the sync printed no summary — this is not a reading").toMatch(/Would flip \d+ SC checkboxes/);

    const flipped = out.split("\n").filter(l => l.startsWith("Would flip ") && l.includes(" in "));
    expect(flipped.filter(l => l.includes(SPEC)), `the sync still flips criteria in ${SPEC}`).toEqual([]);

    // The positive half: they do not merely vanish from the flip list, they
    // are named in the unmeasured report with the reason. An id that is
    // dropped silently reads exactly like an id nobody ever mentioned.
    for (const id of CITED) {
      const line = out.split("\n").find(l => l.trim().startsWith(`${id}:`));
      expect(line, `${id} is credited by nothing and reported by nothing`).toBeDefined();
      expect(line).toContain("a declaration of intent, not coverage");
    }
  }, 240_000);

  test("AC-5: the four are unticked in the spec, which is what the sync must leave alone", () => {
    // The premise of all of the above, read off the tree rather than assumed.
    // If someone ticks one of these by hand, AC-4 would be asserting that a
    // tick the sync cannot make is a tick nobody made.
    const spec = readFileSync(join(REPO_ROOT, "specs", SPEC), "utf-8");
    expect(spec.length, "the spec is empty or unreadable").toBeGreaterThan(1000);
    for (const id of CITED) {
      expect(spec, `${id} is no longer declared in ${SPEC}`).toContain(`- [ ] ${id}:`);
    }

    // This used to read `filter(l => l.startsWith("- [x] SC-19"))` and expect
    // `[]` — no criterion in the whole spec ticked. That was true when #810
    // shipped, and it is broader than the premise the comment above states:
    // AC-4 is about the FOUR ids in `CITED`, and the loop directly above
    // establishes exactly that, per id, by name.
    //
    // #544/#545 implement SC-1939, which is in neither list and which this
    // file has no stake in, and the blanket form went red for it. A guard
    // that fires on correct work in a spec it does not govern is the shape
    // `.claude/rules/self-referential-tests.md` is about.
    //
    // The population is still held, and more tightly: `rule-lifecycle-spec.
    // test.ts` asserts the ticked set of that spec EQUALS an enumerated list,
    // so a criterion ticked by accident reds there, by number, in the file
    // that owns the spec.
    expect(
      CITED.filter(id => spec.includes(`- [x] ${id}:`)),
      "a criterion #810 cites as todo-declared has been ticked",
    ).toEqual([]);
  });
});
