/**
 * The one pin for `anthropics/claude-code-action` (#689).
 *
 * Two workflows pinned this action to two different commits and annotated
 * both `# v1`:
 *
 * | File | Pin | Comment | What it actually was |
 * |---|---|---|---|
 * | `.github/workflows/ai-review.yml` (#631, unmerged) | `5eb090f3` | `# v1` | v1 |
 * | `.github/workflows/claude-review.yml` | `f27be6b6` | `# v1` | v1 as of 2026-10-16 |
 *
 * The comment is the only thing a reader checks. It agreed with itself in both
 * files while naming neither commit, which is `.claude/rules/
 * checks-must-be-able-to-fail.md`'s "two deciders that agree" with a comment
 * standing in for the second decider.
 *
 * ## Why this is a module and not a string in two YAML files
 *
 * It was two strings, and they diverged. This is `lib/bun-version.ts`'s answer
 * (#622) applied to the step beside it: one binding, so a mutation of it can
 * show that the agreement is load-bearing rather than coincidental.
 *
 * A workflow file cannot import, so the agreement is not achieved by
 * substitution — it is CHECKED, by `actionPinParity` in
 * `scripts/contract-parity.ts`, which reads every `.github/workflows/*.yml`
 * and every literal in `lib/` and `scripts/` and compares each to this
 * declaration. That check refuses when it finds no pin at all: zero strings
 * are trivially all equal, and on this tree there is exactly one consumer, so
 * "finding nothing in every file is perfect agreement" is one renamed step
 * away rather than hypothetical.
 *
 * ## How the SHA was established, and the trap in establishing it
 *
 * ```
 * $ gh api repos/anthropics/claude-code-action/git/ref/tags/v1
 *   → object.type "tag", object.sha 310805dc335398c705877f09079340090470ff77
 * $ gh api repos/anthropics/claude-code-action/git/tags/310805dc…
 *   → object.type "commit", object.sha 5eb090f3c3afd701a0672cd32981197ca27688f6
 * $ gh api repos/anthropics/claude-code-action/commits/v1
 *   → sha 5eb090f3c3afd701a0672cd32981197ca27688f6
 * ```
 *
 * `v1` is an ANNOTATED tag, so `refs/tags/v1` points at a tag OBJECT and the
 * commit is one dereference further down. Reading `.object.sha` off the ref
 * and stopping there gives `310805dc`, which is not a commit and cannot be a
 * `uses:` pin at all — #689's own resolution step made exactly that error and
 * concluded from it that neither pinned SHA was v1. One of them was.
 *
 * ## What this does NOT do
 *
 * It does not keep itself fresh. `v1` is a MOVING tag upstream: every release
 * repoints it, so `RESOLVED_ON` dates the reading rather than certifying it.
 * Nothing here fails when the pin goes stale — a check for that needs the
 * network, and whether a staleness refusal belongs in the suite is the
 * decision #377 is open for. Bumping is a deliberate edit to this file, and
 * `actionPinParity` makes every consumer follow it in the same commit.
 */

/** The action, by the name a `uses:` line spells. */
export const CLAUDE_CODE_ACTION = "anthropics/claude-code-action";

/**
 * The commit `refs/tags/v1` dereferences to, resolved on `RESOLVED_ON`.
 * A full 40-character commit SHA, because that is the only form of a `uses:`
 * reference the publisher cannot repoint.
 */
export const CLAUDE_CODE_ACTION_SHA = "5eb090f3c3afd701a0672cd32981197ca27688f6";

/**
 * The tag that SHA was v1 of, carried here so the trailing `# vN` comment in
 * every workflow is DERIVED from the same declaration as the pin. A comment
 * that can disagree with the pin it annotates is worse than no comment.
 */
export const CLAUDE_CODE_ACTION_VERSION = "v1";

/** The day the tag was dereferenced. A moving tag's reading needs a date. */
export const CLAUDE_CODE_ACTION_RESOLVED_ON = "2026-10-19";

/**
 * The exact text a workflow's `uses:` value must carry — pin and comment in
 * one rendering, so there is one thing to mutate and no way to update half.
 */
export function claudeCodeActionRef(): string {
  return `${CLAUDE_CODE_ACTION}@${CLAUDE_CODE_ACTION_SHA} # ${CLAUDE_CODE_ACTION_VERSION}`;
}
