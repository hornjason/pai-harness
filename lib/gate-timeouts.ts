/**
 * The gate run's three nested time budgets, and the order they must be in (#550).
 *
 * A gate check is three processes deep, and each layer can kill the one
 * inside it. Before this file the three numbers were written in three places
 * by three issues and **two of the three orderings were backwards**:
 *
 * | Layer | Was | Where |
 * |---|---|---|
 * | the compiler `tsc-pass` spawns | 240000 | `gates/workflow.test.ts` |
 * | the `test()` around that spawn | 5000 (bun's default) | nowhere — undeclared |
 * | the whole `bun test gates/` run | 120000 | `gates/gate-executor.ts` |
 *
 * So the compiler was allowed four minutes by a call killed after five
 * seconds, inside a run killed after two. `tsc-pass` **could not pass on any
 * project whose typecheck takes longer than five seconds**, which is every
 * project large enough to have a gate run. Observed live: the check printed
 * `Type check PASS: bunx tsc --noEmit` to its own stdout and recorded FAIL,
 * and the timeout line that said why was attributed to the NEXT check by the
 * parser (the other half of #550).
 *
 * Nothing could say so, because a timeout and a genuine failure are the same
 * red, and the 240000 beside the spawn reads as deliberate.
 *
 * **The rule is one line: each layer must strictly outlive the one inside
 * it.** Equal is not enough — a spawn killed at the same instant as its test
 * is a race, and which of the two messages you get is not decided by this
 * repo.
 *
 * Declared here, once, so the ordering is a property of four exported
 * constants rather than of four numbers nobody reads together. The numbers
 * themselves are judgement, and the judgement is written down:
 *
 *  - `EXEC_TIMEOUT_MS` — the `git`/shell helpers. Unchanged at 30s; these are
 *    local repository reads and one that takes longer is hung, not slow.
 *  - `TYPECHECK_TIMEOUT_MS` — 90s, LOWERED from 240s. 240 was never reachable,
 *    and a single check is not entitled to twice the whole gate's budget.
 *  - `GATE_TEST_TIMEOUT_MS` — 120s, the per-test default. Declared at file
 *    level with `setDefaultTimeout` and not as a per-test argument, because
 *    `}, 120000);` on `tsc-pass` alone covers exactly one check and the next
 *    spawning check added inherits nothing. A rule naming one test is a rule
 *    the next one evades.
 *  - `GATE_SUITE_TIMEOUT_MS` — 180s, RAISED from 120s, so the outer kill is
 *    above the per-test budget rather than below it.
 */

/** `exec`, `execArgv`, `execArgvOf` — local git and shell reads. */
export const EXEC_TIMEOUT_MS = 30_000;

/** `bunx tsc --noEmit`, the slowest single subprocess a check starts. */
export const TYPECHECK_TIMEOUT_MS = 90_000;

/** The per-test default for `gates/workflow.test.ts`. */
export const GATE_TEST_TIMEOUT_MS = 120_000;

/** The whole `bun test gates/` run, spawned by `runGateTests`. */
export const GATE_SUITE_TIMEOUT_MS = 180_000;

/**
 * The ordering, as a function so it can be driven over values that are not
 * these ones — otherwise the check compares the constants against themselves
 * and no mutation of them can be observed.
 */
export function gateTimeoutOrderingViolations(t: {
  exec: number;
  typecheck: number;
  test: number;
  suite: number;
}): string[] {
  const layers: Array<[string, number, string, number]> = [
    ["the exec helpers", t.exec, "the typecheck spawn", t.typecheck],
    ["the typecheck spawn", t.typecheck, "the test around it", t.test],
    ["the test", t.test, "the gate suite run", t.suite],
  ];
  return layers
    .filter(([, inner, , outer]) => !(inner < outer))
    .map(
      ([innerName, inner, outerName, outer]) =>
        `${innerName} is allowed ${inner}ms inside ${outerName}'s ${outer}ms — the inner process ` +
        `outlives the thing that started it, so it is killed before it can report (#550)`,
    );
}
