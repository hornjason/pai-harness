/**
 * What a commit SHA looks like, in ONE place (#602).
 *
 * `gates/schema.ts` has carried this pattern since #224 to keep a ref name
 * out of `suiteMeasurement.measuredSha` — the field that says which tree a
 * suite verdict is about. #602 adds a second field with the same job for
 * the harness that did the grading, and a second copy of the pattern would
 * be two deciders for one question: they would agree today, a mutation of
 * either would leave the other refusing, and no behavioural test could
 * tell them apart (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * fourth shape).
 *
 * It lives in `lib/` and not in `gates/` because the dependency runs that
 * way: `gates/schema.ts` already imports from `lib/`, and `lib/` importing
 * back would be a cycle.
 *
 * ## Why 7 and not 40
 *
 * `git rev-parse --short` is the form a human pastes and the form several
 * scripts in this tree print. Demanding 40 would refuse readings that are
 * correct, and a refusal that fires on correct input is the fastest way to
 * build one everybody learns to work around. The thing being excluded is a
 * REF NAME — `main`, `HEAD`, `origin/main`, `rungate/run-602` — because a
 * ref is a pointer and the whole point of recording a SHA is that it still
 * names the same tree tomorrow.
 */

/** A commit SHA, short or full. Anchored at both ends: a ref name containing hex is not one. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Is this string a commit SHA?
 *
 * Exported beside the pattern so a caller never has to spell `.test()`
 * against a shared `RegExp`. `COMMIT_SHA` carries no `g` flag, so it is
 * stateless and safe to share — a `g` flag would make `lastIndex` persist
 * across callers and produce alternating answers for one input, which is a
 * check that cannot fail every other time it is asked.
 */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA.test(value);
}
