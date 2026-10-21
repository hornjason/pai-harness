/**
 * #804 / #323 — what a scan says about itself while it is still running.
 *
 * ## The gap this fills, and why the instrument next door does not fill it
 *
 * `lib/suite-timeout-margin.ts` (#811) composes `timeoutProximityViolations`
 * over a JUnit report. It is the right reading and it is a reading taken
 * AFTERWARDS: a `bun test` run cannot read its own report, because the file is
 * written when the run ends. Three consequences, each of which is the whole of
 * why this module exists rather than a call into that one:
 *
 *   1. **A killed case is a row with no message.** #804's subject in one
 *      sentence. The report says `TimeoutError` and `5005.68ms`; it does not
 *      say what the scan was reading at 5005ms, how many files it had got
 *      through, or what the budget was. An agent sees a red case named after a
 *      rule it has not broken and goes looking for a violation that does not
 *      exist.
 *   2. **A per-test timeout SILENCES the proximity row**, deliberately —
 *      `lib/junit-checks.ts` says so in those words, and it is right to: an
 *      8-second test that says it needs 8 seconds is a decision somebody made.
 *      So the case that carried `}, 60_000)` was the one case #804 is about
 *      AND the one case the #621 instrument could not see.
 *   3. **Nothing has wired a report to it yet.** That decision is #804's own
 *      open half and is not taken here.
 *
 * This is therefore not a second decider for the question
 * `suiteMarginReading` answers. That question is *"across a finished run's
 * report, which cases ended near the budget"*. This one is *"while THIS scan
 * is running, has it crossed its stated fraction of the budget, and on which
 * path"* — a different population, a different clock, and an answer that has
 * to exist before the runner's kill rather than after it. The budget itself
 * has one reader for both: `bunfigTestTimeoutMs`.
 *
 * ## One comparison, read twice
 *
 * `scanBudgetViolations` is the only comparison in this file.
 * `measureScan` calls it on a PARTIAL reading after each file and emits
 * whatever it returns, and the caller calls it again on the final reading and
 * asserts. Mid-scan emission is what survives a kill — a line already written
 * to stdout is in the captured transcript whether or not the case lives to
 * assert anything. A second renderer for the mid-scan line would be two
 * deciders that agree (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
 * shape), so there is not one.
 */
import { bunfigTestTimeoutMs } from "./junit-checks";

/**
 * The fraction of the per-test budget a scan is allowed to spend: 50%.
 *
 * Not 1% and not 20%. Those are PROXIMITY bands — "this case nearly died" —
 * and the two numbers `lib/suite-timeout-margin.ts` documents are the right
 * ones for that question. This is a CEILING on a cost that grows with the
 * tree, so it has to fire with room left to fix it, and it has to not fire on
 * a loaded machine running a scan that is fine.
 *
 * Both halves, measured rather than asserted, against the 5000ms budget
 * `bunfig.toml` declares:
 *
 *   - **It catches the defect it was written for.** The pre-#798 scan was
 *     3482ms idle over 378 files, and it is what took `main` red twice at
 *     5005.68ms and 5172.46ms on loaded CI shards. 3482 is past 2500, so this
 *     reports it — by name, with a duration and a path — on an IDLE machine,
 *     before any shard is loaded.
 *   - **It does not fire on the scan that exists.** Measured 2026-10-21 on
 *     `41d287c5`: 174.68ms over 427 files, which is 3.5% of the budget. A
 *     false red needs 14.3x inflation. The observed idle-to-loaded inflation
 *     on the pre-#798 numbers is 5005/3482 = 1.44x.
 *
 * The cheapest wrong fix for a red here is to raise this number, and it is
 * refused above 1 for a reason that is not tidiness: a ceiling at or past the
 * budget cannot fire at all, because the runner kills the case first. Below 1
 * it is a judgement call and a reviewer's problem, which is the right place
 * for it.
 */
export const SCAN_CEILING = 0.5;

export interface ScanBudgetReading {
  /** The budget in force, or null when none could be read. */
  budgetMs: number | null;
  /** Wall-clock spent in the scan at the moment this reading was taken. */
  elapsedMs: number;
  /** Files read so far. */
  filesRead: number;
  /** Files the scan set out to read. */
  filesTotal: number;
  /** The directory being scanned — "which path it was scanning", at the top. */
  root: string;
  /** The file in hand when this reading was taken, if the scan is mid-flight. */
  current: string | null;
  /** The single costliest file, which is where a regression usually is. */
  slowest: { path: string; ms: number } | null;
  /** False for a mid-scan reading. An incomplete scan read fewer files than it will. */
  complete: boolean;
}

/**
 * Everything wrong with the reading AND everything wrong with what it read,
 * as ONE list.
 *
 * FAILS CLOSED, in both directions that matter:
 *
 *   - **No budget is not a clean scan.** A reading with nothing to compare
 *     against is UNMEASURED and says so by name. `0`, `null` and silence are
 *     indistinguishable from success (`.claude/rules/config-access.md`).
 *   - **An empty scan is not a fast scan.** A completed scan that read zero
 *     files finishes inside any budget by having nothing in it — the #492
 *     shape, and the one this check is most able to acquire by accident,
 *     because a `readdirSync` filter that stops matching produces exactly it.
 */
export function scanBudgetViolations(r: ScanBudgetReading, ceiling: number = SCAN_CEILING): string[] {
  const out: string[] = [];

  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1) {
    out.push(
      `UNMEASURED: a scan ceiling of ${ceiling} is not a fraction of the budget. At or past 1 it can ` +
        `never fire — the runner kills the case at the budget first — so raising it past 1 silences ` +
        `this check rather than widening it (#804)`,
    );
    return out;
  }

  if (r.budgetMs === null || !Number.isFinite(r.budgetMs) || r.budgetMs <= 0) {
    out.push(
      `UNMEASURED: no usable per-test budget to compare ${r.elapsedMs.toFixed(2)}ms against ` +
        `(read ${r.budgetMs}). bunfig.toml's [test] timeout is the one declaring position for it, and ` +
        `defaulting to bun's built-in 5000 here would be a second one (#621, #804)`,
    );
    return out;
  }

  if (r.complete && r.filesRead === 0) {
    out.push(
      `UNMEASURED: the scan of ${r.root} completed having read 0 of ${r.filesTotal} files in ` +
        `${r.elapsedMs.toFixed(2)}ms. An empty scan finishes inside any budget by having nothing in ` +
        `it, so this is not a measurement of anything (#492, #804)`,
    );
    return out;
  }

  const limit = r.budgetMs * ceiling;
  if (r.elapsedMs >= limit) {
    const pct = ((r.elapsedMs / r.budgetMs) * 100).toFixed(1);
    const per = r.filesRead > 0 ? (r.elapsedMs / r.filesRead).toFixed(2) : "n/a";
    const where = r.current !== null ? ` scanning ${r.current}` : "";
    const slowest =
      r.slowest !== null ? ` Costliest file so far: ${r.slowest.path} at ${r.slowest.ms.toFixed(2)}ms.` : "";
    out.push(
      `the scan of ${r.root} has spent ${r.elapsedMs.toFixed(2)}ms of its ${r.budgetMs}ms per-test budget ` +
        `(${pct}%, ceiling ${ceiling * 100}% = ${limit.toFixed(0)}ms) after ${r.filesRead} of ` +
        `${r.filesTotal} files${where} — ${per}ms per file.${slowest} ` +
        `Make the scan cheaper or stop re-reading what it already knows. Raising the ceiling, or giving ` +
        `the case a per-test timeout of its own, moves the same red further away AND takes this case out ` +
        `of the #621 proximity reading, which is how #804 happened (#804, #323)`,
    );
  }
  return out;
}

/** The sentence a caller prints beside a reading, violations or not. */
export function describeScanBudget(r: ScanBudgetReading, ceiling: number = SCAN_CEILING): string {
  const v = scanBudgetViolations(r, ceiling);
  const head =
    v.length > 0
      ? `${v.length} finding(s) for the scan of ${r.root}:`
      : `MEASURED: the scan of ${r.root} read ${r.filesRead} of ${r.filesTotal} files in ` +
        `${r.elapsedMs.toFixed(2)}ms, ${((r.elapsedMs / (r.budgetMs || NaN)) * 100).toFixed(1)}% of the ` +
        `${r.budgetMs}ms budget (ceiling ${ceiling * 100}%).`;
  return [head, ...v.map(x => `  - ${x}`)].join("\n");
}

/**
 * The budget in force for the tree rooted at `root`, read from its
 * `bunfig.toml`, or null when it declares none.
 *
 * One reader, shared with #621 and #811. A copy of the TOML parse here would
 * be a second decider over one key.
 */
export function scanBudgetFromBunfig(source: string | null): number | null {
  return source === null ? null : bunfigTestTimeoutMs(source);
}

/**
 * Run `read` over `files`, timing each one, and emit the moment the scan
 * crosses its ceiling.
 *
 * The emission is the point. An assertion after the loop is unreachable on
 * the run that matters — the one where the runner kills the case — and a
 * killed case is #804's whole subject. A line already on stdout is in the
 * captured transcript regardless, which is #323's SC-3 arriving at the place
 * where a name is lost rather than at the transport.
 *
 * Emits AT MOST ONCE. A warning on every one of 427 iterations is a warning
 * nobody reads, which is the failure mode #804's own thread recorded for the
 * UNMEASURED line that had printed on every run for a month.
 *
 * `now` and `emit` are injected so a case can drive a slow scan without being
 * slow, and read what was emitted without capturing a stream.
 */
export function measureScan<T>(opts: {
  root: string;
  files: string[];
  budgetMs: number | null;
  read: (file: string) => T[];
  ceiling?: number;
  now?: () => number;
  emit?: (line: string) => void;
}): { values: T[]; reading: ScanBudgetReading } {
  const ceiling = opts.ceiling ?? SCAN_CEILING;
  const now = opts.now ?? (() => performance.now());
  const emit = opts.emit ?? ((line: string) => console.error(line));

  const started = now();
  const values: T[] = [];
  let slowest: { path: string; ms: number } | null = null;
  let emitted = false;
  let filesRead = 0;

  const readingAt = (current: string | null, complete: boolean): ScanBudgetReading => ({
    budgetMs: opts.budgetMs,
    elapsedMs: now() - started,
    filesRead,
    filesTotal: opts.files.length,
    root: opts.root,
    current,
    slowest,
    complete,
  });

  for (const file of opts.files) {
    const before = now();
    values.push(...opts.read(file));
    const cost = now() - before;
    filesRead += 1;
    if (slowest === null || cost > slowest.ms) slowest = { path: file, ms: cost };

    if (!emitted) {
      // The SAME comparison the caller will assert on, over a partial reading.
      const found = scanBudgetViolations(readingAt(file, false), ceiling);
      if (found.length > 0) {
        emitted = true;
        for (const line of found) emit(`[#804] ${line}`);
      }
    }
  }

  return { values, reading: readingAt(null, true) };
}
