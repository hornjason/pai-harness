/**
 * Ambient overload for bodyless `test.todo(label)`.
 *
 * bun-types 1.4.2 declares `todo: Test<T>` (node_modules/bun-types/test.d.ts),
 * and `Test<T>`'s only call signature requires the test function:
 * `(label: string, fn: ..., options?): void`. Bun's *runtime* accepts
 * `test.todo("label")` with no body at all — that is the documented way to
 * register an unwritten test. The types and the runtime disagree, and the
 * types are the ones that are wrong, so 49 correct call sites across this repo
 * report TS2554 "Expected 2-3 arguments, but got 1".
 *
 * Interface merging adds a call signature rather than editing 49 call sites to
 * carry a no-op body that would change `bun test` output (a todo with a body
 * runs under `--todo`; a bodyless one never does).
 *
 * The merged signature lands on `Test<T>` itself, so it also makes
 * `test("label")` and `test.skip("label")` type-check. That is the cost of the
 * workaround: TypeScript cannot retype the existing `todo` property in an
 * augmentation, only widen the shared call signature. `bun test` still fails a
 * bodyless `test()` at runtime, so the hole is narrow.
 *
 * REMOVE THIS FILE when bun-types ships a bodyless overload for `test.todo`
 * (i.e. when `test.todo("x")` type-checks with this file deleted). Verify with
 * `bun scripts/typecheck.ts` and drop the baseline in the same commit.
 */
declare module "bun:test" {
  interface Test<T extends ReadonlyArray<unknown>> {
    /** `test.todo("label")` — registers an unwritten test with no body. */
    (label: string): void;
  }
}

export {};
