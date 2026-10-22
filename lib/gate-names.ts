/**
 * The gates whose `result` only the gate runner may write (#1137).
 *
 * A LEAF module with no imports, so there is one thing to mutate and every
 * tree can reach it — `hooks/` and `gates/` both import from `lib/`, and
 * `lib/` is in `package.json` `files[]` while `gates/` is not, so this is the
 * only directory a published hook may take a gate name from.
 *
 * ## Why this exists
 *
 * `hooks/GateResultProtection.hook.ts` hard-coded `scope`, `verify`, `ship`
 * in its Write branch while `lib/gate-enforcement.ts` carried its own
 * `['scope', 'verify', 'ship']` for the same artifact and the same
 * `gates.<name>.result` field. Two enumerations of one set is the fourth
 * shape in `.claude/rules/checks-must-be-able-to-fail.md` with a twist: they
 * agree on every input anyone has, so nothing can go red, and the first
 * observation of the divergence is a gate result the guard did not refuse.
 *
 * `test/gate-name-registry.test.ts` iterates this list against both
 * consumers, so a name added here is asserted in both with no second edit,
 * and a consumer that kept a literal three goes red on the fourth.
 *
 * ## What this is NOT
 *
 * Not the set of gates the CLI accepts. `gates/run-gate.ts` takes `merge`,
 * `prove` and `gaps` as well, and `gates/self-heal.ts` takes `prove` and
 * `merge`; those are argument vocabularies for different commands, and
 * folding them in here would widen what the guard protects on the strength of
 * a name collision. This list answers one question — **which gates write a
 * `result` into `workflow-state.json`** — and only that question's consumers
 * should read it.
 */

/** Gates that record a `result` in `workflow-state.json`. */
export const PROTECTED_GATES = ["scope", "verify", "ship"] as const;

export type ProtectedGate = (typeof PROTECTED_GATES)[number];
