/**
 * The commit subject a ship run writes, composed from an UNTRUSTED issue title.
 *
 * An issue title is picked by whoever filed the issue. It reaches a commit
 * message in two positions — `workflows/ship.js`'s COMMIT phase, and
 * `scripts/github-op.ts --title-from-issue`, whose PR title becomes the
 * squash-merge subject — and both of them land that text on `main`.
 *
 * GitHub closes an issue when a merged commit message contains a closing
 * keyword next to an issue reference, and **it does not care about markdown**.
 * On 2026-10-19 commit `cfc1415d` quoted ``Fixes #644`` inside a backtick code
 * span, as a SAMPLE INPUT in a message explaining this very class of bug, and
 * #644 was closed three seconds after the merge. Backticks are not an escape;
 * neither are quotes, parentheses or a code fence.
 *
 * So the title is neutralised here, in one binding, and `workflows/ship.js`
 * carries an inline copy only because a workflow script cannot import (#69) —
 * `test/commit-subject-quoting.test.ts` lifts that copy out and asserts the
 * two agree over every fixture, so they are one decider with a comparator
 * rather than two that silently diverge (#621).
 */

/**
 * GitHub's closing syntax, as documented: one of nine keywords, optional
 * colon, whitespace, then an issue reference in any of the forms GitHub
 * resolves.
 *
 * The capture ends at the character before the digits so the fix can insert a
 * space there — see `neutraliseClosingKeywords`. Written with a lookahead on
 * the digits rather than consuming them, so a reference is never truncated.
 */
export const CLOSING_REFERENCE =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:[\w.-]+\/[\w.-]+)?#|GH-|https?:\/\/\S*?\/issues\/)(?=\d)/gi;

/**
 * Break the adjacency GitHub parses, leaving the keyword and the number both
 * readable.
 *
 * Breaking the adjacency rather than deleting anything is deliberate: this
 * runs over a human's issue title, and a subject line with the number redacted
 * is worse to read than one with a space in it. `fixes #500` becomes
 * `fixes # 500`, which links nothing and says the same thing.
 */
export function neutraliseClosingKeywords(text: unknown): string {
  return String(text ?? "").replace(CLOSING_REFERENCE, "$1$2$3 ");
}

/**
 * `fix(#N): <neutralised title>`.
 *
 * The run's OWN `fix(#N):` prefix is composed after the transform and is
 * deliberately untouched — that reference is the one this commit means, and
 * neutralising it would break the link between every ship commit and its
 * issue.
 */
export function commitSubject(issue: number, title: unknown): string {
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new TypeError(`commitSubject needs a positive integer issue number, got ${JSON.stringify(issue)}`);
  }
  return `fix(#${issue}): ${neutraliseClosingKeywords(title)}`;
}
