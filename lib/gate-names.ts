/**
 * Gate names, and the two different questions people ask about them (#1137).
 *
 * A LEAF module with no imports, so there is one thing to mutate and every
 * tree can reach it — `hooks/` and `gates/` both import from `lib/`, and
 * `lib/` is in `package.json` `files[]` while `gates/` is not, so this is the
 * only directory a published hook may take a gate name from.
 *
 * ## Why there are two lists and not one
 *
 * The first draft of this file had one, `PROTECTED_GATES`, and used it as the
 * guard's allowlist. A review round found that wrong twice over, and both
 * corrections are worth keeping:
 *
 *  1. The list was INCOMPLETE. `gates/gate-executor.ts` calls
 *     `writeGateResult(sf, "merge", …)`, `(sf, "gaps", …)` and the dynamic
 *     `(sf, gate, …)` that `prove` reaches, so `gates.merge.result`,
 *     `gates.gaps.result` and `gates.prove.result` are all persisted and none
 *     of them was guarded. None is visible to a `gates\.[a-z]+` grep, because
 *     the name arrives as a function ARGUMENT and the write is
 *     `state.gates[gate] = …`.
 *  2. An enumerated allowlist on a security boundary is correct exactly until
 *     someone adds a gate, and nothing makes the next person update it.
 *
 * So the guard no longer reads a list at all. `lib/gate-result-protection.ts`
 * blocks a `result` under ANY key of `gates`, which cannot go stale — the
 * question "is the list complete?" stops being askable. Neither list below is
 * the guard's allowlist, and adding a name to either must never be required
 * to make the guard see a new gate.
 */

/**
 * Gates whose FAIL blocks an agent, in the priority order
 * `findWorkflowGateFailure` reports them: scope, then verify, then ship.
 *
 * NOT a security boundary and NOT the set of gates that record a result —
 * `merge`, `prove` and `gaps` record results and are deliberately absent.
 * `gaps` is WARN-only and is passed `fails = 0` unconditionally, so it can
 * never be a blocking failure; `merge` and `prove` run after the ship gate
 * has already decided. Widening this list would start nagging agents about
 * gates that are not theirs to fix.
 *
 * Consumed by `lib/gate-enforcement.ts`.
 */
export const BLOCKING_GATES = ['scope', 'verify', 'ship'] as const;

export type BlockingGate = (typeof BLOCKING_GATES)[number];

/**
 * Every gate name `writeGateResult` is called with, so every key that can
 * appear under `gates` carrying a `result`.
 *
 * **This is a TEST POPULATION, not an allowlist.** Nothing in the guard reads
 * it. `test/gate-name-registry.test.ts` asserts the gate-agnostic guard
 * refuses a forged result for every name here, so adding a name STRENGTHENS
 * the evidence and forgetting to add one cannot weaken the guard. That
 * direction is the whole point: a list that can only make the test weaker by
 * omission is safe to leave slightly stale, and an allowlist is not.
 *
 * Derived 2026-10-22 from the `writeGateResult` call sites in
 * `gates/gate-executor.ts` and the argument vocabulary in `gates/run-gate.ts`.
 */
export const RESULT_BEARING_GATES = [
  'scope',
  'verify',
  'ship',
  'merge',
  'prove',
  'gaps',
] as const;

export type ResultBearingGate = (typeof RESULT_BEARING_GATES)[number];
