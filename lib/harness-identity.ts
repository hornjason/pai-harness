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
