/**
 * Spawning the gate runner, with the budget and the clock in one place (#508).
 *
 * `test/evidence-prevalidation-at-verify.test.ts` spawns a real gate run per
 * case. It did so through `execSync(…, { timeout: 300000 })` inside a test
 * with no timeout of its own — so a **five-second** test wrapped a
 * **three-hundred-second** subprocess budget. The inner budget could never be
 * reached: bun's clock always won by a factor of sixty, and what it reported
 * was its own generic timeout, naming nothing.
 *
 * The catch beneath it then did this:
 *
 *     catch (e) { output = e?.stdout?.toString?.() || ""; }
 *
 * which is correct for the case it was written for — half these gates are
 * SUPPOSED to exit non-zero — and wrong for the one it also caught. A run
 * killed by the budget has empty stdout, so a starved spawn and a gate that
 * refused on the merits arrive at the next line indistinguishable, and the
 * assertion that fires reads *"the verify gate never recorded a result"*. True
 * of the file, and false about the cause. That is shape one in
 * `.claude/rules/checks-must-be-able-to-fail.md` — fail-open error handling —
 * and it is why #508 took two full runs to triage and still could not separate
 * resource contention from order dependence.
 *
 * ## The budget is not the subject
 *
 * #508's first half removed the slowness rather than raising the clock, which
 * is the right move when the slowness is incidental. **Here it is not.** The
 * spawn IS the thing under test: every case in that file runs the real gate
 * executor precisely so that none of them reads the source. Nine cases at a
 * measured 360ms each on an idle machine is irreducible work, and there is no
 * ninety-subprocess loop to collapse.
 *
 * So the budget is sized to be reached only by a run that is genuinely stuck —
 * 45 seconds against a measured 360ms, a factor of 125 — the test's own
 * timeout is set strictly above it, and exhausting it is a NAMED refusal that
 * quotes both numbers. Speed stops being a property this test asserts by
 * accident.
 *
 * ## What is not measured here
 *
 * That the suite survives a machine under memory pressure. #508 records two
 * full runs that died at exit 144 with another session active, and that is a
 * property of the machine, not of this repo — no fixture can assert it. What
 * this file makes testable is the half that is: a run that exceeds its budget
 * says so, with the elapsed time, instead of arriving as silence.
 */

/** 45s against a measured 360ms — only a stuck run reaches it. */
export const GATE_RUN_BUDGET_MS = 45_000;

/**
 * The per-test ceiling for a case that spawns gate runs.
 *
 * Strictly above `GATE_RUN_BUDGET_MS`, and above twice it, because the heal
 * case runs the gate twice in one test. A test timeout below the subprocess
 * budget is the arrangement this module exists to remove; it must not be
 * reintroduced by sizing these two independently.
 */
export const GATE_TEST_TIMEOUT_MS = 2 * GATE_RUN_BUDGET_MS + 30_000;

export interface GateRunReading {
  /** stdout and stderr together, as far as the run got. */
  output: string;
  /** Wall-clock milliseconds the spawn took. */
  elapsedMs: number;
  /** The exit status, or null when a signal ended the run before it could set one. */
  exitCode: number | null;
  /** The signal that ended it, or null. */
  signal: string | null;
  /**
   * The budget was exhausted.
   *
   * Read off the spawn's own report, never inferred from empty output — empty
   * output is exactly what a starved run and a crashed run share.
   */
  timedOut: boolean;
  /** The budget this run was given, so a refusal can quote it rather than imply it. */
  budgetMs: number;
}

export interface GateRunOptions {
  /** Absolute path to `gates/run-gate.ts`. */
  runner: string;
  gate: string;
  slug: string;
  issue: number;
  /** `RUNGATE_WORK_DIR`. */
  workDir: string;
  env?: Record<string, string>;
  /** Defaults to `GATE_RUN_BUDGET_MS`. Tests that exercise the budget pass their own. */
  budgetMs?: number;
}

export function runGateProcess(opts: GateRunOptions): GateRunReading {
  const budgetMs = opts.budgetMs ?? GATE_RUN_BUDGET_MS;
  const started = Date.now();
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", opts.runner, "--gate", opts.gate, "--slug", opts.slug, "--issue", String(opts.issue)],
    env: {
      ...process.env,
      RUNGATE_WORK_DIR: opts.workDir,
      RUNGATE_SKIP_AGENTS: "1",
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: budgetMs,
  });
  const elapsedMs = Date.now() - started;

  // `exitCode === null` with a signal is how bun reports a run it killed on
  // the budget; a gate that refuses on the merits exits non-zero and sets no
  // signal. Those are the two cases the old `catch` could not tell apart.
  const signal = proc.signalCode ?? null;
  return {
    output: proc.stdout.toString() + proc.stderr.toString(),
    elapsedMs,
    exitCode: proc.exitCode ?? null,
    signal,
    timedOut: proc.exitCode === null && signal !== null,
    budgetMs,
  };
}

/**
 * The refusal text for a run that never finished, or null when it did.
 *
 * ONE binding, so there is one thing to mutate and no second copy to hold a
 * case up after the first is broken — the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function gateRunRefusal(r: GateRunReading): string | null {
  if (!r.timedOut) return null;
  return (
    `the gate run was killed by its ${r.budgetMs}ms budget after ${r.elapsedMs}ms (${r.signal}) — ` +
    `it produced ${r.output.length} bytes, so anything missing from the state below is UNMEASURED, ` +
    `not a verdict the gate reached`
  );
}
