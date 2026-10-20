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
 * GitHub's closing syntax: one of nine keywords, a colon or whitespace, then
 * an issue reference in any of the four forms GitHub resolves — `#N`, `GH-N`,
 * `owner/repo#N`, and a `github.com/owner/repo/(issues|pull)/N` URL.
 *
 * **This is deliberately a SECOND spelling of the grammar in
 * `scripts/check-state-record-closes.ts`, not a shared literal.** That script
 * detects closing references in a session record (#590, filed after
 * `Filed and not fixed: #586` closed #586 one second after a merge); this
 * neutralises them. They are exact duals, so sharing a regex literal would
 * make a mutation of the grammar move both and leave the comparison green —
 * two deciders that agree (`.claude/rules/checks-must-be-able-to-fail.md`,
 * fourth shape). Instead the two are compared over a corpus, with the
 * detector as the oracle, in `test/commit-subject-quoting.test.ts`.
 *
 * The script cannot be the owner either: `test/state-record-closes-mutation.ts`
 * runs a mutant copy of it from a temp directory, and that only works while it
 * has no relative imports. Same shape as #69 forcing ship.js's copy — the
 * duplication is structural, so the answer is a comparator.
 *
 * Three details come from that grammar rather than from first principles, and
 * each was wrong in this file's first draft:
 *
 *   - `\b` AFTER the stem, so `closing #586` is not a keyword.
 *   - `\s*:\s*` as an alternative to `\s+`, because `fixed:#586` with no
 *     space is the form that shipped #586's defect.
 *   - the URL pinned to `github.com` and to `issues|pull`, where the first
 *     draft had `https?://\S*?/issues/` and would have mangled a link to any
 *     other tracker.
 *
 * The capture ends at the character before the digits so the fix can insert a
 * space there, and the digits are a lookahead rather than consumed, so a
 * reference is never truncated.
 */
const SLUG = "[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._-]*";
export const CLOSING_REFERENCE = new RegExp(
  `\\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b(\\s*:\\s*|\\s+)` +
    `((?:${SLUG})?#|GH-|https?:\\/\\/github\\.com\\/${SLUG}\\/(?:issues|pull)\\/)(?=\\d)`,
  "gi",
);

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
