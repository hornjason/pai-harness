/**
 * #1223 — the tree-wide SC scan, and the budget the suites that run it declare.
 *
 * `test/sc-id-namespace.test.ts` → *"no test file is credited for a
 * single-digit criterion"* was red on `origin/main` at 6045.90ms, 5479.08ms
 * and 5948.25ms against bun's 5000ms default. The fix is two things and this
 * file holds both to their claims:
 *
 *  1. The scan was **cheapened** — one tree parse per `findTestFilesForSCs`
 *     call instead of two, and no parse at all for a file with no SC id in
 *     it. A cheapening is only allowed if the output does not move, so the
 *     cases below compare against a MUTANT with the short-circuit removed,
 *     over every file in the real tree.
 *  2. The remainder is **budgeted**, by re-timing the real scan rather than
 *     by writing a number down. `test/helpers/sc-scan-budget.ts` carries the
 *     reasoning; the cases below hold the roster to it in both directions.
 *
 * ## What was broken to prove each case can fail
 *
 * Six mutations, each applied alone against the real tree, with the count
 * predicted before it ran. Six distinct single reds — a battery whose rows
 * all look the same is a battery measuring its own scaffolding:
 *
 * | # | mutation | predicted | measured |
 * |---|---|---|---|
 * | M1 | probe narrowed to `/SC-\d/` | **0 disagree** | **6 disagree** → exactness red |
 * | M2 | probe narrowed to `source.startsWith("SC-")` | ≥200 disagree | red |
 * | M3 | probe deleted — the cheapening reverted | green | **presence** red, exactness green |
 * | M4 | a name deleted from `SC_SCAN_SUITES` | roster red | roster red |
 * | M5 | a `setDefaultTimeout` deleted from a member | declares red | declares red |
 * | M6 | `if (!cal.ok) return BUDGET_FLOOR_MS` deleted | floor red | **0** → case rewritten |
 *
 * **M1's prediction was wrong, and in the direction that matters.** Six test
 * files carry ONLY the letter form — `ai-review-wif`, `branch-protection-
 * gate`, `ceremony-overrides`, `consumer-tier-downgrade-mutation`,
 * `gate-vacuous-checks`, `unit/gates-tier1-jwt`, holding `SC-A1`..`SC-A5`,
 * `SC-A11` and `SC-E4`. `SC_ID_SOURCE` is `SC-[A-Z]?\d+`, so the obvious
 * narrowing drops every one of them and the scan would silently stop
 * crediting them. That is the defect this case exists for and it would have
 * been invisible had the population been zero.
 *
 * **M6 scored zero and the case was rewritten, not excused.** With a small
 * `scanMs` the floor returns 30000 whether the guard is present or not, so
 * the assertion was true for a reason unconnected to the thing it named —
 * the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`. The
 * case now drives a large `scanMs`, where the two branches differ, and
 * carries the completed-scan control beside it.
 *
 * ## The mutant, and why it is built the way it is
 *
 * `scripts/sync-sc-status.ts` has relative imports, so a copy in an
 * `mkdtemp` dies on module resolution — and a mutant that fails to load
 * reads exactly like a mutant that disagreed
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row). Every
 * `from "../x"` is therefore rewritten to an absolute path before the copy
 * is written, and the first case asserts the mutant LOADED and returned a
 * non-empty reading before any comparison is made.
 *
 * Covers SC-1410 and SC-1411 of HARNESS-STANDARD.md are NOT claimed here —
 * this file claims nothing. It is a cost and roster census.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { walkTestFiles } from "../lib/walk-test-files";
import { coverageClaimSites } from "../scripts/sync-sc-status";
import {
  BUDGET_FLOOR_MS,
  HEADROOM_MULTIPLE,
  INHERITED_DEFAULT_MS,
  SCAN_PRIMITIVE,
  SC_SCAN_SUITES,
  SC_SCAN_SURFACE,
  SLOWEST_CASE_IN_SCANS,
  calibrateScScan,
  declaresFileBudget,
  scScanBudget,
  scScanCallers,
  scScanTestTimeout,
  scanEntryPointPattern,
  scanReachingSymbols,
  type ScScanCalibration,
} from "./helpers/sc-scan-budget";

setDefaultTimeout(scScanTestTimeout());

const REPO = join(import.meta.dir, "..");
const TEST_DIR = join(REPO, "test");
const SYNC_SOURCE = join(REPO, "scripts", "sync-sc-status.ts");

/** Where the probe lives: the first statement of the scan. */
const SCAN_OPENS = "export function coverageClaimSites(source: string): ClaimSite[] {\n";

/**
 * The probe line, found STRUCTURALLY rather than by its text.
 *
 * The first draft matched the exact line. Measured, that made the whole
 * battery meaningless: every mutation of the probe — including narrowing it
 * to `/SC-\d/`, which is the cheapest wrong fix — stopped the literal
 * matching, so the mutant builder aborted and the two cases below went red
 * **without ever comparing anything**. Three different mutations produced
 * three identical reds, which is the tell.
 *
 * `null` when the scan has no early return at all, which is a different
 * fact and gets its own case.
 */
function probeLine(raw: string): string | null {
  const at = raw.indexOf(SCAN_OPENS);
  if (at === -1) throw new Error("coverageClaimSites' signature moved — this file cannot read it");
  const first = raw.slice(at + SCAN_OPENS.length).split("\n")[0] + "\n";
  return /^\s*if \(.*\) return \[\];\n$/.test(first) ? first : null;
}

/**
 * `coverageClaimSites` with the short-circuit taken out, loadable.
 *
 * Built once for the file — it is a module compile, and three cases want it.
 */
let referencePromise: Promise<(source: string) => Array<{ id: string; kind: string }>> | null =
  null;

function reference(): Promise<(source: string) => Array<{ id: string; kind: string }>> {
  if (referencePromise === null) {
    referencePromise = (async () => {
      const raw = readFileSync(SYNC_SOURCE, "utf-8");
      const probe = probeLine(raw);
      // Relative specifiers resolve against the mutant's directory, so they
      // are rewritten before the copy moves. A mutant that fails to load
      // looks like a mutant that disagreed.
      const absolute = (probe === null ? raw : raw.replace(probe, ""))
        .replace(/from "(\.\.?)\/([^"]+)"/g, (_m, dots: string, p: string) =>
          dots === ".." ? `from "${join(REPO, p)}"` : `from "${join(REPO, "scripts", p)}"`,
        );
      if (/from "\.\.?\//.test(absolute)) {
        throw new Error("a relative import survived the rewrite — the mutant will not load");
      }
      const dir = mkdtempSync(join(tmpdir(), "sc-scan-reference-"));
      const file = join(dir, "reference.ts");
      writeFileSync(file, absolute);
      const mod = await import(file);
      return mod.coverageClaimSites;
    })();
  }
  return referencePromise;
}

/** Every file of the real test tree, read once. */
const TREE = walkTestFiles(TEST_DIR).map(file => ({
  file,
  source: readFileSync(join(TEST_DIR, file), "utf-8"),
}));

describe("#1223: the short-circuit is exact, not a heuristic", () => {
  test("the scan has an early return before its three full-source passes", () => {
    // The PRESENCE half, separate from the exactness half below, because
    // deleting the probe makes that one vacuously true: a reference built
    // from a source with no probe is the source. Without this case, the
    // cheapening can be reverted and nothing goes red.
    const probe = probeLine(readFileSync(SYNC_SOURCE, "utf-8"));
    expect(
      probe,
      "coverageClaimSites no longer short-circuits on a source with no id — it is paying " +
        "stripJsComments twice and commentMask once for every file in the tree again (#1223)",
    ).not.toBeNull();
  });

  test("the mutant loads and reads the tree, so a comparison against it means something", async () => {
    const ref = await reference();
    expect(typeof ref, "the reference did not load — every comparison below would be vacuous").toBe(
      "function",
    );
    const total = TREE.reduce((n, t) => n + ref(t.source).length, 0);
    expect(
      total,
      "the reference found no claim sites anywhere in the tree — it is not reading the tree",
    ).toBeGreaterThan(1000);
  });

  test("every file in the tree parses identically with and without it", async () => {
    const ref = await reference();
    const disagree: string[] = [];
    for (const { file, source } of TREE) {
      const a = JSON.stringify(coverageClaimSites(source));
      const b = JSON.stringify(ref(source));
      if (a !== b) disagree.push(file);
    }
    expect(
      disagree,
      "the short-circuit changed what the scan reads — it must be the same pattern the " +
        "site loop uses, or it skips a file that had a claim in it",
    ).toEqual([]);
  });

  test("it actually skips a large part of the tree, so the saving is not notional", () => {
    const skipped = TREE.filter(t => coverageClaimSites(t.source).length === 0).length;
    expect(
      skipped,
      "no file in the tree is skipped — the short-circuit is a branch that never runs, " +
        "and the measurement in test/helpers/sc-scan-budget.ts no longer describes it",
    ).toBeGreaterThan(TREE.length / 4);
  });
});

describe("#1223: the roster is read off the tree, in both directions", () => {
  test("every file calling a scan entry point declares the budget", () => {
    const callers = scScanCallers(TEST_DIR);
    const undeclared = callers.filter(f => !declaresFileBudget(f, TEST_DIR));
    expect(
      undeclared,
      `these files call a tree-scan entry point and inherit bun's ${INHERITED_DEFAULT_MS}ms ` +
        `default: add \`setDefaultTimeout(scScanTestTimeout())\` from ` +
        `test/helpers/sc-scan-budget.ts`,
    ).toEqual([]);
  });

  test("SC_SCAN_SUITES is exactly that set", () => {
    expect(
      scScanCallers(TEST_DIR),
      "SC_SCAN_SUITES in test/helpers/sc-scan-budget.ts has drifted from the tree — a file " +
        "started or stopped reaching the tree scan. The roster is derived by reachability " +
        "from " +
        SCAN_PRIMITIVE +
        ", so a NEW WRAPPER moves it too, not only a new call site.",
    ).toEqual([...SC_SCAN_SUITES]);
  });

  test("the entry-point pattern finds the call this issue was about", () => {
    // The positive control. A pattern that matched nothing would satisfy
    // both cases above perfectly.
    const pattern = scanEntryPointPattern(scanReachingSymbols(REPO));
    const src = readFileSync(join(TEST_DIR, "sc-id-namespace.test.ts"), "utf-8");
    expect(pattern.test(src)).toBe(true);
    expect(pattern.test("const x = 1;\n")).toBe(false);
  });
});

describe("#1271: membership is REACHING the scan, not spelling one of its names", () => {
  /** What the roster used to be: three names, written down. */
  const SPELLED_OUT = /\b(findTestFilesForSCs|intendedOnly|scanTestTree)\s*\(/;

  /** The roster as the superseded mechanism would compute it. */
  function callersBySpelling(): string[] {
    return walkTestFiles(TEST_DIR)
      .filter(f => !f.includes("/"))
      .filter(f => SPELLED_OUT.test(readFileSync(join(TEST_DIR, f), "utf-8")))
      .sort();
  }

  test("the superseded mechanism misses it, so the fixpoint is what is working", () => {
    // The negative control, and the reason this is not a roster edit.
    // Spelling four more names into an alternation would make the case
    // below pass while leaving membership determined the same way — the
    // fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`, a case
    // that goes green under the cheapest wrong fix. So the wrong fix is
    // built here and measured: it does NOT find the file.
    expect(
      callersBySpelling(),
      "the three-name alternation now finds sc-binding-split.test.ts — if that is real the " +
        "file grew a direct call, and this control no longer separates the two mechanisms",
    ).not.toContain("sc-binding-split.test.ts");

    expect(scScanCallers(TEST_DIR, REPO)).toContain("sc-binding-split.test.ts");
  });

  test("the fixpoint is transitive — it credits the wrapper, not just the entry points", () => {
    const symbols = scanReachingSymbols(REPO);
    // `claimedScKeys` walks nothing itself. It is reachable only because it
    // calls the credit entry point, which calls the scan.
    expect(symbols).toContain("claimedScKeys");
    expect(symbols).not.toContain(SCAN_PRIMITIVE);
  });

  test("a file that only MENTIONS the scan in a comment is not conscripted", () => {
    // Not hypothetical, and it happened TWICE while this block was written:
    // first as an entry point spelled in call shape inside a comment, then
    // as one inside a string literal in the probe below. Both times this
    // file — which scans nothing — joined its own roster. The detector
    // reads comments (stripped) and string literals (not stripped), so a
    // probe must be assembled rather than written out.
    const pattern = scanEntryPointPattern(scanReachingSymbols(REPO));
    const wrapperCall = "claimedScKeys" + "(specs, dir);\n";
    expect(pattern.test(wrapperCall)).toBe(true);
    expect(scScanCallers(TEST_DIR, REPO)).not.toContain("sc-scan-cost.test.ts");
  });

  test("a reader that found nothing credits nothing, not everything", () => {
    // An empty alternation is `()`, which matches every file — so a broken
    // fixpoint would put the WHOLE TREE on the roster and read as a very
    // thorough success. Fail closed in the direction that is loud.
    const empty = scanEntryPointPattern([]);
    expect(empty.test("findTestFilesForSCs(a, b, c);\n")).toBe(false);
    expect(empty.test("")).toBe(false);
  });

  test("the surface is wider than its own membership, and contains all of it", () => {
    // A growth check whose pattern excludes a member cannot see that member
    // go slow. The other direction — deriving the pattern FROM the members —
    // is the #1172 defect, a list consulting itself about its completeness.
    const outside = SC_SCAN_SUITES.filter(f => !SC_SCAN_SURFACE.test(f));
    expect(
      outside,
      "these roster members do not match SC_SCAN_SURFACE, so the growth check in " +
        "lib/junit-checks.ts would never read them: widen the pattern in " +
        "test/helpers/sc-scan-budget.ts",
    ).toEqual([]);
    expect(SC_SCAN_SURFACE.test("sc-a-file-not-on-the-roster.test.ts")).toBe(true);
  });

  test("a file that reaches the scan only through a wrapper is a caller", () => {
    // `sc-binding-split.test.ts` calls `claimedScKeys`, which calls the
    // credit entry point inside `scripts/sync-sc-status.ts`. The call that
    // costs the time is one level down from the test file, so a regex over
    // the test file's own source cannot see it — and the file that was WORST
    // in #1223 (7958ms / 8192ms) was therefore governed by nothing.
    //
    // This comment does not spell any entry point in call shape on purpose:
    // the first draft wrote one, and the detector — which reads comments too
    // — conscripted THIS file into the roster. See the comment-stripping case
    // below.
    expect(
      scScanCallers(TEST_DIR),
      "sc-binding-split.test.ts reaches the tree scan through claimedScKeys and is not " +
        "detected as a caller: membership is matching identifier spellings rather than " +
        "reachability (#1271)",
    ).toContain("sc-binding-split.test.ts");
  });
});

describe("#1223: the budget is calibrated, and a reading that failed is the floor", () => {
  const cal = (over: Partial<ScScanCalibration> = {}): ScScanCalibration => ({
    scanMs: 750,
    files: 567,
    ok: true,
    note: "",
    ...over,
  });

  test("a calibration that did not complete gets the floor, not a number derived from it", () => {
    // `scanMs` is LARGE here, and that is the whole case. A failed
    // calibration's duration is a reading of how long failing took, not of
    // what the scan costs — `scaffold-budget.ts`'s `killed` branch, in this
    // file's terms — so a stalled scan must not be allowed to hand itself a
    // two-minute budget.
    //
    // Measured: with `scanMs: 1` this case scores ZERO. The floor returns
    // 30000 whether the guard is there or not, so the assertion holds for a
    // reason that has nothing to do with the guard, and deleting
    // `if (!cal.ok) return BUDGET_FLOOR_MS` leaves it green. This is the
    // only configuration in which the guard is observable at all.
    const stalled = cal({ ok: false, scanMs: 10_000, files: 0 });
    expect(scScanBudget(stalled)).toBe(BUDGET_FLOOR_MS);
    expect(
      scScanBudget(cal({ ...stalled, ok: true })),
      "the control: the same duration from a COMPLETED scan does raise the budget, so the " +
        "case above is about `ok` and not about the arithmetic",
    ).toBeGreaterThan(BUDGET_FLOOR_MS);
  });

  test("the floor is never below what a file would have inherited anyway", () => {
    // Declaring a budget must not be able to LOWER one. Without this, a fast
    // machine calibrating at 100ms would hand these files 1200ms.
    expect(BUDGET_FLOOR_MS).toBeGreaterThan(INHERITED_DEFAULT_MS);
    expect(scScanBudget(cal({ scanMs: 1 }))).toBeGreaterThan(INHERITED_DEFAULT_MS);
  });

  test("a tree big enough overtakes the floor, so the calibration is not decorative", () => {
    // The whole point of calibrating: the budget has to move when the work
    // does. At 2.10x per doubling of the test-file count, this is the tree
    // roughly four doublings from here.
    const big = BUDGET_FLOOR_MS / (SLOWEST_CASE_IN_SCANS * HEADROOM_MULTIPLE);
    expect(scScanBudget(cal({ scanMs: big * 4 }))).toBeGreaterThan(BUDGET_FLOOR_MS);
  });

  test("the live calibration reads this tree and says what it read", () => {
    const live = calibrateScScan(TEST_DIR);
    expect(live.ok, live.note).toBe(true);
    expect(live.files, "the calibration walked no files — this is not a reading").toBe(TREE.length);
    expect(live.note).toContain(`${live.files} test files`);
    expect(scScanTestTimeout()).toBeGreaterThanOrEqual(BUDGET_FLOOR_MS);
  });
});
