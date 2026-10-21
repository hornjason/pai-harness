/**
 * The content hash a constraint candidate is identified by — ONE binding.
 *
 * A LEAF module, moved here from `scripts/extract-constraints.ts` and
 * re-exported from it under the name every existing caller knows. That is the
 * arrangement `lib/git-dates.ts` has with `lib/conformity.ts` (#508) and
 * `lib/harness-identity.ts` has with `isHarnessItself` (#380): one binding,
 * two names.
 *
 * It moved for a reason worth stating rather than for tidiness. The permanent
 * veto in `reference/rejected-constraints.md` (SC-137) is a table of these
 * hashes, and `loadRejectedHashes` matches a candidate against it by string
 * equality. A second implementation of "the hash of a candidate" — even a
 * correct one — would make the veto silently stop applying to whichever
 * producer used the other copy, and no behavioural test could tell the two
 * apart while they agreed. `lib/failure-intake.ts` is that second producer,
 * so this is the collapse done before the pair exists rather than after
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
import { createHash } from "crypto";

export function contentHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}
