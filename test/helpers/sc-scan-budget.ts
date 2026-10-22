/**
 * A per-test budget for the suites whose cases scan the whole test tree (#1223).
 *
 * `test/sc-id-namespace.test.ts` → *"no test file is credited for a
 * single-digit criterion"* was red on `origin/main` at 6045.90ms, 5479.08ms
 * and 5948.25ms against bun's 5000ms default, the third on a detached
 * worktree with nobody's branch in it. Five readings, all over, the lowest
 * 2.9% over and the highest 21% over: a distribution with no mass below the
 * line is not a flake.
 *
 * ## What the work is
 *
 * One **tree-wide claim scan** — `walkTestFiles(test/)`, then
 * `coverageClaimSites()` on every file. MEASURED on 2026-10-22 at `76eed806`
 * over 567 files / 9.27 MiB:
 *
 * | | CPU |
 * |---|---|
 * | reading all 567 files | 23ms |
 * | parsing them | 731ms |
 * | → one scan | **~753ms** |
 *
 * It is 97% parse, and the parse is three full-source passes
 * (`stripJsComments` twice and `commentMask` once) per file.
 *
 * ## It tracks the test-file count, which is what the issue asked
 *
 * Predicted before measuring: cpu(600)/cpu(300) between 1.8 and 2.2.
 * Measured over subsets of the real tree: N=150 → 323ms, N=300 → 709ms,
 * N=600 → 1486ms. **Ratio 2.10 — linear in the number of test files.**
 *
 * So a constant raised just above today's maximum is a postponement with a
 * known expiry, exactly as #1223 warned. The budget below has no expiry
 * because it is not a constant: it **re-times the real scan on the real tree
 * at module scope**, so a tree with twice the files hands itself twice the
 * budget, and a slower runner the same. That is the difference between this
 * and `AI_REVIEW_MAX_TURNS` (#1244/#1245), where 50 was twice a single
 * observation and sat inside the working distribution.
 *
 * ## The work was also halved before the budget was raised
 *
 * A budget is the wrong first move when the scan is doing redundant work, and
 * it was doing two kinds:
 *
 *  - `findTestFilesForSCs` walked and parsed the tree **twice per call** —
 *    once inside `intendedOnly`, once for the credit loop. Folded into one
 *    `scanTestTree`.
 *  - `coverageClaimSites` ran its three full-source passes on every file
 *    **before** looking for an id, and **half the tree has no SC id at all**
 *    (286 files of 567). Now short-circuited.
 *
 * Measured, one whole-registry `findTestFilesForSCs` call against the real
 * tree, best of three, with the two implementations loaded side by side in
 * one process and their outputs asserted identical (213 credited files, 53
 * intended ids, byte-equal):
 *
 * | | CPU per call |
 * |---|---|
 * | `origin/main` | 1665ms |
 * | after | 491ms |
 * | | **3.39x** |
 *
 * There are **6 unscoped `findTestFilesForSCs` calls** in `test/` — against
 * 19 that pass a scratch directory and are cheap — so that is ~10.0s → ~2.9s
 * of CPU per suite run from this one function. Predicted 3.5–4.5x before
 * measuring; 3.39 is below that band, and the reason is the 3% that is file
 * reading, which the fold does not remove and the short-circuit only partly
 * does.
 *
 * ## Why there is still a budget after a 3.4x cheapening
 *
 * Because the margin, not the verdict, is what contention moves. This repo
 * routinely runs 20-27 agent suites at once; `test/helpers/git-fixture-
 * budget.ts` measured 6.2x inflation between an ordinary load and a
 * thrashing one on this machine. A case at 2141ms today is one busy
 * afternoon from 5000ms, which is the band #1140 named and the reason that
 * file admits a suite at HALF the inherited default rather than after it has
 * gone red.
 *
 * ## The floor is what carries this machine
 *
 * `BUDGET_FLOOR_MS` is 30_000 and it is the number actually in force here —
 * the calibration only overtakes it on a box, or a tree, several times
 * larger than this one. It is not a guess:
 *
 *  - It is **6x** `INHERITED_DEFAULT_MS`, so declaring this budget can never
 *    LOWER the budget a file already had.
 *  - It is **~5x the 6045ms worst reading** in #1223's table, which was taken
 *    before the scan was cheapened.
 *  - It is **a quarter of** `GATE_TEST_TIMEOUT_MS` (120_000), this repo's
 *    answer to a case that spawns real heavy subprocesses. These cases spawn
 *    nothing; they are in-process CPU. A pure scan is not entitled to the
 *    same ceiling as a `git` fixture, and saying so is the only thing that
 *    keeps the two numbers meaning different things.
 *
 * Measured at load 125 on 2026-10-22: calibration 737ms × 3 × 4 = **8849ms**,
 * so the floor is what is in force here by a factor of 3.4. The calibration
 * overtakes it at roughly 2500ms a scan — this tree at ~1900 test files, or
 * a runner 3.4x slower than this machine.
 *
 * ## A budget is not a licence
 *
 * Every assertion in the roster is unchanged. A case that hangs still dies,
 * at 30s instead of 5s. What it buys is that a red in these files means a
 * credit rule is wrong, which for #1223 it did not.
 *
 * ## What this does NOT close
 *
 * The growth direction. A seventh file that starts scanning the real tree
 * inherits 5000ms and nothing goes red until it crosses — which is #1172's
 * finding about `GIT_FIXTURE_SUITES` exactly. `scScanSurface()` below states
 * the surface in the shape `lib/junit-checks.ts` consumes so the check can be
 * built, but no JUnit reading is wired to it here and it is therefore
 * UNMEASURED rather than passing. `test/sc-scan-cost.test.ts` closes the
 * membership direction only: every file on the roster must declare.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";

import type { BudgetSurface } from "../../lib/junit-checks";
import { perTestTimeoutDeclarations } from "../../lib/per-test-timeouts";
import { stripJsComments } from "../../lib/strip-js-comments";
import { walkTestFiles } from "../../lib/walk-test-files";
import { scanTestTree } from "../../scripts/sync-sc-status";

/** `test/`, the tree the scan walks and the tree the roster lives in. */
const TEST_DIR = dirname(import.meta.dir);

/** The repository root, where the wrapper directories live. */
const REPO_ROOT = dirname(TEST_DIR);

/**
 * How many scans are timed. The SLOWEST is the reading.
 *
 * Three, not six: the scan is deterministic in-process CPU with no
 * subprocess spawn, so it has nothing like the spawn distribution
 * `git-fixture-budget.ts` samples against — the variance here is the
 * scheduler, and `HEADROOM_MULTIPLE` is what covers that. Three is enough to
 * discard a first-call JIT reading, and at ~0.75s each it is the whole cost
 * this file adds to a run.
 */
export const SCAN_CALIBRATION_RUNS = 3;

/**
 * bun's BUILT-IN per-test default, which a file inheriting declares nothing.
 *
 * NOT `bunfig.toml`'s — #621 measured on bun 1.3.14 that `[test] timeout` is
 * not read by the test runner at all. `test/test-timeout-population.test.ts`
 * probes the real number rather than trusting either.
 */
export const INHERITED_DEFAULT_MS = 5_000;

/**
 * The slowest case on the roster, in scans, on the machine that measured it.
 *
 * The unit the cost is denominated in, so a bigger tree or a slower runner
 * re-prices it automatically instead of by anybody's arithmetic. Derived the
 * way #1140 derived `SLOWEST_CASE_IN_FIXTURES`: the slowest case's duration
 * over the calibration taken in the same run.
 *
 * MEASURED 2026-10-22 over the whole roster — 136 cases, 0 fail — at load
 * average 137 with peer agent suites running. Said out loud because #1223's
 * own filing warns that an absolute duration taken on this machine carries
 * contention:
 *
 * | | |
 * |---|---|
 * | calibration, one scan of 568 files | 737ms |
 * | slowest governable case (`sc-scan-cost.test.ts`) | 1992ms |
 * | → | **2.7, taken as 3** |
 *
 * For scale, the case #1223 was filed about — `sc-id-namespace.test.ts` →
 * *"no test file is credited for a single-digit criterion"* — does not reach
 * the slowest eight. That file's worst case is now **720ms**, against the
 * 6045ms that filed the issue.
 *
 * Excluded, deliberately: `sync-sc-todo-outranks-comment.test.ts` → `AC-4:
 * the live tree`, at **25929ms**. It spawns the whole sync script through a
 * synchronous `execFileSync`, and bun's per-test timer cannot interrupt a
 * blocking syscall — so that case overruns every budget without being killed
 * and has never been red. It is not evidence about what a budget must cover,
 * because no budget covers it. Calibrating on it would inflate this number
 * 10x off a case the mechanism cannot see.
 */
export const SLOWEST_CASE_IN_SCANS = 3;

/**
 * Headroom over the slowest measured case.
 *
 * Four, matching `git-fixture-budget.ts`. The calibration is taken at module
 * scope minutes before the case runs and in the same process, so it already
 * carries the contention present at calibration time; the headroom covers
 * the CHANGE in contention between then and the case, not the contention
 * itself.
 */
export const HEADROOM_MULTIPLE = 4;

/** The lowest the calibrated budget may fall. See "The floor is what carries this machine". */
export const BUDGET_FLOOR_MS = 30_000;

/**
 * Every test file that calls a tree-scan entry point.
 *
 * **Membership is derived, not remembered.** `scScanCallers()` below reads
 * the roster off the tree, and `test/sc-scan-cost.test.ts` compares the two
 * in both directions: a file that starts calling one of these functions and
 * is not here fails, and a name here that no longer calls one fails too.
 *
 * The criterion is deliberately the WIDER one — "reaches an entry point at
 * all", not "reaches it against the real tree". Telling those apart from
 * source means guessing whether a directory expression denotes the
 * repository's own `test/`, and a detector narrower than what it detects is
 * the second shape in `.claude/rules/checks-must-be-able-to-fail.md`. The
 * cost of being wide is that a file whose every call plants a scratch
 * directory — `sc-claim-forms.test.ts`, and `sync-sc-status.test.ts` at 2ms
 * — carries a `setDefaultTimeout` it does not need. That is a harmless
 * line. The other direction silently exempts the file this issue is about.
 *
 * ## #1271 widened "calls" to "reaches"
 *
 * Three files joined, and the two that matter were paying the full cost
 * while governed by nothing. Measured at load average 160:
 *
 * | file | worst case | reaches the scan via |
 * |---|---|---|
 * | `sc-binding-split.test.ts` | **4093ms** | `claimedScKeys` |
 * | `ticked-sc-cover.test.ts` | **3317ms** | `claimedScKeys` |
 * | `sync-sc-status.test.ts` | 2ms | `generateReport`, on a scratch tree |
 *
 * 4093ms is 82% of the 5000ms that file inherited. It was the WORST file in
 * #1223's population and it was never on the roster, because its call is
 * one level down inside `scripts/sync-sc-status.ts`. See
 * `scanReachingSymbols` for why the repair is the fixpoint and not four
 * more names in an alternation.
 *
 * ## One file LEFT, and it says the old reader was wrong both ways
 *
 * `sc-coverage-claims.test.ts` was a member and is not one now. Its only
 * occurrence of an entry point is test DATA — a source line built inside a
 * single-quoted string at `test/sc-coverage-claims.test.ts:128` — so it
 * never called the scan at all. The superseded reader matched raw text, so
 * it admitted a file for a string and exempted a file for a wrapper: wrong
 * in both directions, and only one of them was loud.
 *
 * Its `setDefaultTimeout` is deliberately left in place. A file may declare
 * a budget whether or not a roster knows about it — `declaresOwnBudget` is
 * the criterion `lib/junit-checks.ts` actually uses — and removing a budget
 * to tidy a list is a behaviour change made for a bookkeeping reason.
 */
export const SC_SCAN_SUITES = [
  "sc-binding-split.test.ts",
  "sc-claim-forms.test.ts",
  "sc-id-namespace.test.ts",
  "sc-todo-credit.test.ts",
  "sync-sc-status-matching.test.ts",
  "sync-sc-status-recursive-walk.test.ts",
  "sync-sc-status.test.ts",
  "sync-sc-todo-outranks-comment.test.ts",
  "ticked-sc-cover.test.ts",
] as const;

/**
 * The primitive that actually walks the test tree. Everything expensive
 * reaches it; nothing reaches it by accident.
 *
 * This is the seed of the reachability fixpoint below, and it is the one
 * thing here that is written down rather than derived — because it is the
 * definition of the cost, not a guess about who pays it.
 */
export const SCAN_PRIMITIVE = "walkTestFiles";

/** Where a wrapper can live: the directories a test file imports helpers from. */
export const SCAN_WRAPPER_DIRS = ["lib", "scripts"] as const;

/**
 * A source file as CODE: comments blanked, and the contents of every string,
 * template and regex literal blanked with it.
 *
 * Both halves are load-bearing, and both were learned from this detector
 * conscripting files that scan nothing. A test file that *discusses* the
 * scan in a comment, or hands a call-shaped string to an assertion as data,
 * is not calling anything — and `test/sc-scan-cost.test.ts` did both while
 * #1271 was being written, joining its own roster twice.
 *
 * Narrowing the view this way cannot hide a real call, because a real call
 * is never inside a comment or a literal. That is the only reason it is
 * safe: every other narrowing of this detector trades a false member for a
 * silently exempt one, which is the direction #1271 exists to close.
 */
function readAsCode(file: string): string {
  return stripJsComments(readFileSync(file, "utf-8"), { blankLiterals: true });
}

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") sourceFiles(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every exported symbol in `lib/` and `scripts/` that REACHES the tree walk.
 *
 * ## Why this is a fixpoint and not a list of three names
 *
 * #1271. `SCAN_ENTRY_POINTS` used to be the literal alternation
 * `findTestFilesForSCs|intendedOnly|scanTestTree`, matched against a test
 * file's own source. That is a membership test on three identifier
 * SPELLINGS, and it cannot see a call one level down: `sc-binding-split.
 * test.ts` calls `claimedScKeys`, which calls the credit entry point inside
 * `scripts/sync-sc-status.ts`. So the file that was **worst** in #1223 —
 * 7958ms and 8192ms, 64% over the inherited default — was not on the roster,
 * got no budget, and went green only as a side effect of the scan being
 * cheapened. Measured at load 160 after that cheapening it is still 4093ms,
 * which is 82% of the 5000ms it inherits.
 *
 * Adding the wrapper names to the alternation is the repair that does not
 * hold: it changes the ROSTER without changing how membership is DETERMINED,
 * so the next wrapper is invisible again. `lib/junit-checks.ts` says this
 * about `GIT_FIXTURE_SUITES` in almost these words (#1172), and it is the
 * same defect one layer down.
 *
 * So membership is REACHABILITY, computed from the tree on every run. A
 * wrapper added tomorrow is picked up without anyone editing this file.
 *
 * ## What it reads, and what it cannot see
 *
 * Comments are stripped first. Without that, a file that merely *discusses*
 * the scan is conscripted into the roster — which is not hypothetical: the
 * first draft of #1271's own regression test wrote an entry point in call
 * shape inside a comment and made `test/sc-scan-cost.test.ts` a member.
 *
 * Both `export function f()` and `export const f = () =>` are read, though
 * no scan-reaching wrapper uses the second form today. It is handled so the
 * detector does not depend on a style that could change, which is the second
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * It is a NAME-level reader, not a type-aware one: a symbol re-exported
 * under a different name, or reached through a method call, is not followed.
 * That direction is toward NOT crediting, which costs a missing budget and
 * is the direction `test/sc-scan-cost.test.ts` holds a positive control for.
 */
export function scanReachingSymbols(repoRoot: string = REPO_ROOT): string[] {
  const marker = /^export (?:async )?function (\w+)|^export const (\w+)\s*(?::[^=]*)?=/gm;
  const bodies: Array<{ name: string; body: string }> = [];

  for (const dir of SCAN_WRAPPER_DIRS) {
    for (const file of sourceFiles(join(repoRoot, dir))) {
      const source = readAsCode(file);
      const marks: Array<[string, number]> = [];
      marker.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = marker.exec(source)) !== null) marks.push([m[1] ?? m[2], m.index]);
      for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1][1] : source.length;
        bodies.push({ name: marks[i][0], body: source.slice(marks[i][1], end) });
      }
    }
  }

  const reaching = new Set<string>([SCAN_PRIMITIVE]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of bodies) {
      if (reaching.has(fn.name)) continue;
      for (const seen of reaching) {
        if (new RegExp(`\\b${seen}\\s*\\(`).test(fn.body)) {
          reaching.add(fn.name);
          changed = true;
          break;
        }
      }
    }
  }
  reaching.delete(SCAN_PRIMITIVE);
  return [...reaching].sort();
}

/**
 * The call that makes a file a member, built from the derived symbol set.
 *
 * One binding, so there is one thing to mutate.
 */
export function scanEntryPointPattern(symbols: readonly string[]): RegExp {
  if (symbols.length === 0) {
    // An empty alternation is `()`, which matches every file. A reader that
    // found nothing must credit nothing, not everything.
    return /(?!)/;
  }
  return new RegExp(`\\b(${symbols.join("|")})\\s*\\(`);
}

/**
 * The roster, read off the tree.
 *
 * Sorted, so the comparison in `test/sc-scan-cost.test.ts` is about
 * membership and not about the order `walkTestFiles` happens to return.
 */
export function scScanCallers(testDir: string = TEST_DIR, repoRoot: string = REPO_ROOT): string[] {
  const pattern = scanEntryPointPattern(scanReachingSymbols(repoRoot));
  return walkTestFiles(testDir)
    .filter(f => !f.includes("/"))
    .filter(f => pattern.test(readAsCode(join(testDir, f))))
    .sort();
}

/**
 * The fraction of `INHERITED_DEFAULT_MS` at which an unbudgeted file
 * qualifies for the roster.
 *
 * Half, for #1140's reason: a file admitted only once a case has crossed the
 * line is admitted after it has already gone red, which is the tax rather
 * than a guard against it.
 */
export const GROWTH_FRACTION = 0.5;

/**
 * The surface the budget governs. Every file that reads the SC registry lives here.
 *
 * `ticked-sc-` was added by #1271, which put `ticked-sc-cover.test.ts` on
 * the roster: a surface narrower than its own membership would let the
 * growth check certify a member it cannot see.
 *
 * This stays a NAME-SHAPE heuristic deliberately, and deliberately WIDER
 * than `SC_SCAN_SUITES`. Deriving it from the member list instead would make
 * the growth check a list consulting itself about its own completeness,
 * which is the defect #1172 is filed about — the check exists precisely to
 * find files the roster does not have yet.
 */
export const SC_SCAN_SURFACE = /^(sc-|sync-sc-|ticked-sc-).*\.test\.ts$/;

/**
 * Does `test/<basename>` open with a `setDefaultTimeout(…)`?
 *
 * Read through the same AST reader both directions of the check use, so
 * "declares a budget" means one thing everywhere and a file cannot satisfy
 * one spelling and fail the other. A file that does not parse counts as NOT
 * declaring — a reader failing open here would exempt exactly the files it
 * could not understand.
 */
export function declaresFileBudget(basename: string, testDir: string = TEST_DIR): boolean {
  let src: string;
  try {
    src = readFileSync(join(testDir, basename), "utf-8");
  } catch {
    return false;
  }
  const found = perTestTimeoutDeclarations(src);
  return found !== null && found.some(d => d.kind === "file-default");
}

/** The growth rule, in the shape `lib/junit-checks.ts` consumes. */
export function scScanSurface(
  declaresOwnBudget: (basename: string) => boolean = b => declaresFileBudget(b),
): BudgetSurface {
  return {
    label: "the SC-registry scan suites",
    pattern: SC_SCAN_SURFACE,
    declaresOwnBudget,
    members: SC_SCAN_SUITES,
    inheritedMs: INHERITED_DEFAULT_MS,
    qualifyingFraction: GROWTH_FRACTION,
  };
}

export interface ScScanCalibration {
  /** The SLOWEST of `SCAN_CALIBRATION_RUNS` tree scans on this machine, in milliseconds. */
  scanMs: number;
  /** How many files that scan read. Carried so the reading says what size of tree it describes. */
  files: number;
  /**
   * The scan found a tree to walk.
   *
   * An empty reading is not a measurement of a cheap scan, it is a
   * measurement of a missing directory, and the two must not produce the
   * same number. When it is false only the floor applies.
   */
  ok: boolean;
  /** Said out loud, so a floor that applied because the tree was unreadable is not silence. */
  note: string;
}

/** Time `SCAN_CALIBRATION_RUNS` real scans of the real tree on this machine. */
export function calibrateScScan(testDir: string = TEST_DIR): ScScanCalibration {
  let slowest = 0;
  let files = 0;
  for (let i = 0; i < SCAN_CALIBRATION_RUNS; i++) {
    const started = performance.now();
    const scan = scanTestTree(testDir);
    slowest = Math.max(slowest, performance.now() - started);
    files = scan.length;
  }
  const ok = files > 0;
  return {
    scanMs: slowest,
    files,
    ok,
    note: ok
      ? `the slowest of ${SCAN_CALIBRATION_RUNS} scans of ${files} test files took ${slowest.toFixed(0)}ms on this machine`
      : `the test tree scanned to zero files — the floor applies, and this is not a reading of the work`,
  };
}

/**
 * The per-case budget: the slowest measured case, re-priced at this machine's
 * scan cost, times the stated headroom — never below the floor.
 */
export function scScanBudget(cal: ScScanCalibration): number {
  if (!cal.ok) return BUDGET_FLOOR_MS;
  return Math.max(
    BUDGET_FLOOR_MS,
    Math.round(cal.scanMs * SLOWEST_CASE_IN_SCANS * HEADROOM_MULTIPLE),
  );
}

/**
 * The budget for this machine, calibrated once per process.
 *
 * Memoised, and not as a micro-optimisation: every file on the roster calls
 * this at module scope and bun runs them in one process, so an uncached
 * version re-measures an unchanged machine six times — ~13s of pure overhead
 * added to every roster run, CI included.
 */
let memoised: number | null = null;

export function scScanTestTimeout(): number {
  if (memoised === null) memoised = scScanBudget(calibrateScScan());
  return memoised;
}
