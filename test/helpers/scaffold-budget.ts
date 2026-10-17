/**
 * A scaffold budget that tracks the machine, and an over-budget run that is
 * UNMEASURED rather than wrong (#478).
 *
 * `test/unit/scaffold-project.test.ts` spawns a real
 * `bun scripts/scaffold-project.ts` in 32 places. On 2026-10-13 one of them
 * died at 5007ms, bun's default; the response was to declare
 * `SCAFFOLD_TIMEOUT_MS = 15_000`, assert that the test ceiling exceeds it, and
 * move on. The ordering assertion was right and is kept. The NUMBER did not
 * hold: on 2026-10-16 the same case, by name, died at **15007.04ms** — the new
 * budget, exactly — while a re-run of the same tree reported 0 fail and the
 * file passes 39/39 in isolation.
 *
 * ## Why not 30 seconds
 *
 * Because that is the move that did not converge. #445 is in this repo's
 * history for guessing bigger rather than differently, and #407 widened a
 * window from 1 read to 10 and blew through it the next day. A constant
 * encodes one machine's speed on one afternoon; the runner's speed is the
 * variable, and a constant cannot see it.
 *
 * **So the budget is a RATIO to a calibration run taken on the machine the
 * suite is running on.** One cheap scaffold is timed at module load, and every
 * case gets `calibration × BUDGET_MULTIPLE`. A loaded runner makes the
 * calibration slow too, so both numbers move together and the verdict stops
 * depending on how busy the box was.
 *
 * `BUDGET_FLOOR_MS` is the one constant left and it is deliberately **not
 * raised**: it is 15_000, the number that is already there, now acting as a
 * floor under a calibrated budget rather than as the budget. On this machine
 * calibration measures ~1.4s, so the floor still wins and today's behaviour is
 * unchanged — which is the point. The mechanism changes; the number does not.
 *
 * ## An over-budget run did not observe anything
 *
 * A case killed by its budget is not evidence the scaffold is broken. It is
 * the absence of evidence, and `0`, `SKIP`, `FAIL` and silence are all
 * indistinguishable from each other while `UNMEASURED` is not — which is
 * `.claude/rules/config-access.md`'s *Silent Default Substitution*, and the
 * split `.claude/rules/checks-must-be-able-to-fail.md` asks for: enforce the
 * half the repo owns, and make the other half report UNMEASURED on every run.
 *
 * So `runScaffoldProcess` reports the timeout, the caller throws
 * `ScaffoldUnmeasured`, and the test file's own `test` wrapper converts
 * exactly that error into a recorded, printed UNMEASURED instead of a red.
 * Every other throw propagates untouched.
 *
 * What stops that becoming a file that passes having measured nothing is the
 * coverage line it is required to print — `measured N of M` — and the refusal
 * when N is zero. A machine that could not feed one case is a hiccup worth
 * naming; a machine that could not feed any of them is an instrument failure.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** How many times the calibration a single scaffold may take. */
export const BUDGET_MULTIPLE = 10;

/**
 * The lowest the calibrated budget may fall.
 *
 * 15_000 — the value #454's fix already set, unchanged. It is here so a
 * suspiciously fast calibration (a warm cache, a trivial fixture) cannot
 * tighten the budget below what is known to work.
 */
export const BUDGET_FLOOR_MS = 15_000;

/** Headroom between the scaffold's budget and the ceiling of the test holding it. */
export const TEST_HEADROOM_MS = 5_000;

export interface ScaffoldReading {
  /** stdout and stderr together. Empty when the run was killed before it spoke. */
  output: string;
  /** Wall-clock milliseconds the spawn took. */
  elapsedMs: number;
  /** The budget this run was given, so a notice can quote it rather than imply it. */
  budgetMs: number;
  /** The exit status, or null when a signal ended the run before it could set one. */
  exitCode: number | null;
  /** The signal that ended it, or null. */
  signal: string | null;
  /**
   * The budget was exhausted.
   *
   * Read off the spawn's own report, never inferred from empty output —
   * empty output is what a starved run and a crashed run share, and
   * conflating them is the defect #508 fixed one file over.
   */
  timedOut: boolean;
}

export interface ScaffoldRunOptions {
  /** Absolute path to `scripts/scaffold-project.ts`. */
  script: string;
  projectPath: string;
  args?: string[];
  /** Injectable so the starved path is testable without a starved machine. */
  budgetMs: number;
}

export function runScaffoldProcess(opts: ScaffoldRunOptions): ScaffoldReading {
  const started = Date.now();
  const proc = Bun.spawnSync({
    cmd: ["bun", opts.script, opts.projectPath, ...(opts.args ?? [])],
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.budgetMs,
  });
  const elapsedMs = Date.now() - started;
  const signal = proc.signalCode ?? null;
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    elapsedMs,
    budgetMs: opts.budgetMs,
    exitCode: proc.exitCode ?? null,
    signal,
    timedOut: proc.exitCode === null && signal !== null,
  };
}

/**
 * The error a starved run raises.
 *
 * A distinct class rather than a message prefix, because the wrapper that
 * converts it into an UNMEASURED record must not also swallow an ordinary
 * assertion failure that happens to mention a timeout.
 */
export class ScaffoldUnmeasured extends Error {
  constructor(readonly reading: ScaffoldReading) {
    super(
      `UNMEASURED: the scaffold ran ${reading.elapsedMs}ms against a ${reading.budgetMs}ms budget and was ` +
        `killed (${reading.signal}). It produced ${reading.output.length} bytes, so the code was NOT observed ` +
        `to behave incorrectly — this is the absence of a measurement, not a failing one.`,
    );
    this.name = "ScaffoldUnmeasured";
  }
}

/** True for the starved-run error and nothing else. */
export function isScaffoldUnmeasured(e: unknown): e is ScaffoldUnmeasured {
  return e instanceof ScaffoldUnmeasured;
}

export interface Calibration {
  /** What one cheap scaffold cost on this machine, right now. */
  elapsedMs: number;
  /** Whether the calibration run itself succeeded. */
  ok: boolean;
  /** Said out loud when it did not, because a failed calibration is not a fast one. */
  note: string;
}

/**
 * Time one scaffold on this machine.
 *
 * The fixture carries `src/` and a `package.json` and runs with `--fix`, so
 * the calibration includes the nested `bun` that generates CODE-MAP.md —
 * measured at 1.04s of a 1.42s run, 73% of the operation. A calibration that
 * skipped it would time something the cases do not do.
 */
export function calibrateScaffold(script: string): Calibration {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-calibration-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "calibration", dependencies: {} }));
    // A generous ceiling: the calibration must not itself be the thing that
    // gets killed, or the budget it produces would be a measurement of the
    // kill rather than of the machine.
    const r = runScaffoldProcess({ script, projectPath: dir, args: ["--fix"], budgetMs: 120_000 });
    return {
      elapsedMs: r.elapsedMs,
      ok: !r.timedOut && r.exitCode === 0,
      note: r.timedOut
        ? `the calibration run was killed after ${r.elapsedMs}ms — the floor applies`
        : r.exitCode === 0
          ? `one scaffold took ${r.elapsedMs}ms on this machine`
          : `the calibration scaffold exited ${r.exitCode} after ${r.elapsedMs}ms — timing kept, verdict ignored`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The per-case budget: a multiple of what this machine just did, never below
 * the floor.
 *
 * A calibration that failed still contributes its timing — the run happened
 * and took that long — but a calibration that was KILLED contributes nothing
 * but its ceiling, so the floor carries it.
 */
export function scaffoldBudget(cal: Calibration): number {
  return Math.max(BUDGET_FLOOR_MS, Math.round(cal.elapsedMs * BUDGET_MULTIPLE));
}

/** The ceiling of a test holding one scaffold run. Strictly above the budget. */
export function scaffoldTestTimeout(budgetMs: number): number {
  return budgetMs + TEST_HEADROOM_MS;
}

export interface UnmeasuredCase {
  name: string;
  elapsedMs: number;
  budgetMs: number;
}

/**
 * The census, and the thing that stops UNMEASURED becoming silence.
 *
 * One module-level record per process. The file that uses it is required to
 * print `measured N of M` and to refuse when N is zero: a machine that could
 * not feed one case is a hiccup worth naming, and a machine that could not
 * feed any of them is an instrument that stopped reporting.
 */
export class ScaffoldCensus {
  readonly unmeasured: UnmeasuredCase[] = [];
  private measuredCount = 0;

  recordMeasured(): void {
    this.measuredCount++;
  }

  recordUnmeasured(name: string, reading: ScaffoldReading): void {
    this.unmeasured.push({ name, elapsedMs: reading.elapsedMs, budgetMs: reading.budgetMs });
  }

  get measured(): number {
    return this.measuredCount;
  }

  get total(): number {
    return this.measuredCount + this.unmeasured.length;
  }

  /** One line a reader can act on, named after coverage rather than after a count. */
  summary(budgetMs: number, cal: Calibration): string {
    const lines = [
      `scaffold coverage: measured ${this.measured} of ${this.total} cases — ` +
        `budget ${budgetMs}ms (${cal.note}, x${BUDGET_MULTIPLE}, floor ${BUDGET_FLOOR_MS}ms)`,
    ];
    for (const u of this.unmeasured) {
      lines.push(
        `  UNMEASURED: ${u.name} — killed at ${u.elapsedMs}ms of a ${u.budgetMs}ms budget. ` +
          `The code was not observed to be wrong.`,
      );
    }
    return lines.join("\n");
  }
}
