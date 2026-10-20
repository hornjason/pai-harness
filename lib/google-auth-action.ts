/**
 * The one pin for `google-github-actions/auth` (#689, applied to #631).
 *
 * `lib/claude-code-action.ts` is the sibling of this file and the model for
 * it. The defect is the same one, found a second time in a second action, in
 * a fleet rather than in one repository:
 *
 * | Position | Pin | Comment | What it actually was |
 * |---|---|---|---|
 * | `.github/workflows/claude-review.yml` | `c200f369` | `# v2` | v2 |
 * | agentgrit's generated `.github/workflows/ai-review.yml` | `7c6bc770` | `# v3` | v3 |
 *
 * Two positions, two values, nothing comparing them — which is #689 exactly.
 * Note what is DIFFERENT from #689 and worth saying rather than glossing:
 * **both pins were accurate.** Neither comment lied. They name two different
 * major versions of one action, chosen independently by two sessions that
 * could not see each other, and a reader of either file has no way to learn
 * that the other exists. A check that only catches a wrong comment would
 * report this tree clean.
 *
 * ## Why v2 and not v3
 *
 * v3 is the latest release (`gh api .../releases/latest` → `v3`, read
 * 2026-10-20). It is not the measured one.
 *
 * `c200f369` is the pin on `.github/workflows/claude-review.yml`, which is the
 * only configuration in this fleet that has ever authenticated to Vertex at
 * all: verified 2026-10-19 on `jhorn-pai`, `claude-sonnet-5` returning HTTP
 * 200 from `rawPredict` at location `global`, with no service-account key.
 * agentgrit's v3 pin has never run — that repository holds no `GCP_SA_KEY`
 * and its generated job resolves mode `none` on every run — so adopting it
 * would be adopting the untested half of a disagreement because it has the
 * larger number on it.
 *
 * Both majors accept `workload_identity_provider` and neither accepts a
 * directory for the credentials file, so the choice buys no behaviour either
 * way. It is a choice between a reading and a version string, and this repo's
 * rule is to keep the reading. Bumping to v3 is a deliberate edit to this
 * file plus a re-measurement, and `actionPinParity` makes every consumer
 * position follow it in the same commit.
 *
 * ## How the SHA was established, and the trap in establishing it
 *
 * ```
 * $ gh api repos/google-github-actions/auth/commits/v2 --jq .sha
 *   → c200f3691d83b41bf9bbd8638997a462592937ed
 * $ gh api repos/google-github-actions/auth/commits/v3 --jq .sha
 *   → 7c6bc770dae815cd3e89ee6cdf493a5fab2cc093
 * ```
 *
 * `commits/vN` dereferences the tag for you. Do NOT read `.object.sha` off
 * `git/ref/tags/vN` and stop: these are ANNOTATED tags, so that path returns a
 * TAG object and the commit is one dereference further down. #689's own
 * resolution step made exactly that error and concluded from it that neither
 * pinned SHA was the tag it claimed. Both of these are.
 *
 * ## What this does NOT do
 *
 * It does not keep itself fresh. `v2` is a MOVING tag upstream, so
 * `RESOLVED_ON` dates the reading rather than certifying it. Nothing here
 * fails when the pin goes stale — see `lib/claude-code-action.ts` and #377.
 */

/** The action, by the name a `uses:` line spells. */
export const GOOGLE_AUTH_ACTION = "google-github-actions/auth";

/**
 * The commit `refs/tags/v2` dereferences to, resolved on `RESOLVED_ON`.
 * A full 40-character commit SHA, because that is the only form of a `uses:`
 * reference the publisher cannot repoint.
 */
export const GOOGLE_AUTH_ACTION_SHA = "c200f3691d83b41bf9bbd8638997a462592937ed";

/**
 * The tag that SHA was v2 of, carried here so the trailing `# vN` comment in
 * every position is DERIVED from the same declaration as the pin. A comment
 * that can disagree with the pin it annotates is worse than no comment.
 */
export const GOOGLE_AUTH_ACTION_VERSION = "v2";

/** The day the tag was dereferenced. A moving tag's reading needs a date. */
export const GOOGLE_AUTH_ACTION_RESOLVED_ON = "2026-10-20";

/**
 * The exact text a position's `uses:` value must carry — pin and comment in
 * one rendering, so there is one thing to mutate and no way to update half.
 */
export function googleAuthActionRef(): string {
  return `${GOOGLE_AUTH_ACTION}@${GOOGLE_AUTH_ACTION_SHA} # ${GOOGLE_AUTH_ACTION_VERSION}`;
}
