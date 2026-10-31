/**
 * Is this project the harness itself?
 *
 * One question, one answer, one place (#380). It was answered in four places
 * with four inline implementations, and they had drifted:
 *
 * | site | unreadable package.json |
 * |---|---|
 * | `isHarnessItself` in `lib/generators/agents-md.ts` | caught — reads as a consumer |
 * | `generateAgentBriefsStep`'s `isSelf` | **threw**, killing the scaffold run |
 * | `lib/scanner.ts` | caught |
 * | `lib/conformity.ts` PKG-3 | caught |
 *
 * Three of four agreed, and nothing could notice the fourth because there
 * was nothing to compare it against. #208 added the fourth copy while its
 * own commit message argued — about a different function — that two deciders
 * of the same fact survive any mutation of either.
 *
 * ## Why a leaf module rather than the owner it already had
 *
 * `lib/generators/agents-md.ts` declared it first and SC-811 names it there,
 * so that is where it should live. It cannot: `lib/scanner.ts` is forbidden
 * by SC-365 / AC-3 from importing any generator, and that constraint is
 * right — the scanner is the module other scripts pull in precisely because
 * it drags nothing behind it.
 *
 * So the predicate moves down to a leaf that imports nothing but `fs` and
 * `path`, and `agents-md.ts` re-exports it. A re-export is one binding under
 * two names, which is the opposite of two deciders: mutate this and both
 * callers change.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward "consumer". A consumer form run inside the harness is visibly wrong
 * on its first command — `bunx rungate` resolves to the published package
 * rather than the working tree. The source form in a consumer resolves to
 * nothing at all, silently, in a project whose maintainer has no reason to
 * suspect the harness guessed.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** The harness's own package name. The one fact this module knows. */
export const HARNESS_PACKAGE = "rungate";

/**
 * What the CLI says about itself before it does anything (#1598 follow-up).
 *
 * ## The reading this exists to make possible
 *
 * CI invokes the adjudicator as `bunx rungate@<version>`, and the version in
 * that command is **authored text**. It is written into
 * `.github/workflows/ai-review.yml` by the scaffold at generation time, and
 * it is written again into the `::notice` annotation that quotes the command
 * back to the reader. So a log can carry the string `rungate@0.8.4` three
 * times and still not contain a single resolved reading of which version ran.
 *
 * That is not hypothetical. On 2026-10-24 three consecutive attempts to
 * establish a version from a run log were wrong in the same direction, each
 * correction finding the next layer:
 *
 * | the reading | why it cannot attribute a version |
 * |---|---|
 * | grep the log for `rungate@0.8.x` | matches the PR body, echoed by the round-counting step |
 * | the same grep with colour codes excluded | still matches the annotation, which is authored |
 * | bun's resolve block above the adjudication | prints `Resolved, downloaded and extracted [76]` — a count, no name, no version |
 *
 * The version had to be recovered from outside the log entirely, by reading
 * the pin out of `ai-review.yml` at main's commit as of the run's
 * `createdAt`. That works and it is three readings, two of which are easy to
 * take against the wrong tree — `refs/pull/<N>/merge` is recomputed when main
 * moves, so it describes a tree the run never saw.
 *
 * One line printed by the running process collapses all three into one.
 *
 * ## Why the spelling is deliberately not the pin's
 *
 * `rungate-version:` rather than `rungate@<v>`. If the announcement used the
 * pin's spelling, a grep for a resolved value would match authored text again
 * and this would have bought nothing — the defect reproduced inside its own
 * fix. The marker is the discriminator; the version is the payload.
 *
 * ## UNMEASURED rather than a plausible default
 *
 * An unreadable or version-less `package.json` returns `UNMEASURED`, not a
 * guess and not an empty string. A version that could not be read must not be
 * spelled the same as one that could — `.claude/rules/config-access.md`,
 * *Silent Default Substitution*. It does not throw: a CLI that dies because
 * it could not introduce itself is worse than one that cannot.
 */
export function harnessVersionLine(root: string): string {
  let version: unknown;
  try {
    version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))?.version;
  } catch {
    version = undefined;
  }
  const resolved = typeof version === "string" && version.length > 0 ? version : "UNMEASURED";
  return `rungate-version: ${resolved} (resolved at runtime, not the pin)`;
}

export function isHarnessItself(root: string): boolean {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))?.name === HARNESS_PACKAGE;
  } catch {
    // Missing, or unreadable. A consumer, as far as this is concerned.
    //
    // This `catch` is the drift the issue is about: one of the four copies
    // did not have it, so a half-written package.json aborted the scaffold
    // there and was a shrug everywhere else.
    //
    // There is no `existsSync` guard in front of it on purpose. The first
    // draft had one and it scored 0 on mutation — removing it changed no
    // answer, because a missing file throws into this same `catch`. A
    // branch that cannot change an answer reads to the next person as if it
    // can, so it is gone rather than commented.
    return false;
  }
}
