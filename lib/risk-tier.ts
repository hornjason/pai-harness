/**
 * Risk tiers, and the classifier that reads a change to set one (#1437).
 *
 * Covers CRC-E1, CRC-E2, CRC-E4 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md,
 * Layer 5 — human approval scaled by risk).
 *
 * ## What problem this is pointed at
 *
 * Measured on this repository on 2026-10-23 at 19:15Z: 15 open pull requests,
 * 2 with auto-merge armed. Nine were red on `ai-review` and not one of them
 * for a defect in its own code — five because `main` had moved
 * `.github/workflows/ai-review.yml` underneath them, and five because they
 * EDIT that file, which the action refuses by construction.
 *
 * The thing deciding whether each of those merges was a person reading
 * fifteen diffs. That is the bottleneck a tier is for: a change that needs
 * nobody should not wait for somebody.
 *
 * ## CRC-E2 — the change sets the tier, not the author
 *
 * `classifyChange` takes a change. There is no author, actor, login, team or
 * branch name in `ChangeUnderReview`, and `test/risk-tier.test.ts` asserts
 * that the key set contains no such field, because the criterion is about
 * what the function is ALLOWED to read and a docblock promising it cannot be
 * checked. A classifier that can see who wrote something will eventually be
 * asked to be lenient about it.
 *
 * ## CRC-E4 — a CI workflow file always needs a human
 *
 * `ALWAYS_HIGH_PREFIXES` is the floor and it is not reachable from config.
 * Owner-listed sensitive paths ADD to it; nothing subtracts. A deployment
 * that could configure its way out of "a CI workflow file needs a person"
 * has a setting whose only use is to switch the criterion off, and the
 * criterion exists because that is the change class where switching it off is
 * most attractive and worst.
 *
 * Today this repository satisfies CRC-E4 by accident and in its worst form:
 * `ai-review` refuses any pull request whose copy of its own workflow file
 * differs from the default branch's, so a change to the reviewer cannot pass
 * the reviewer, and the documented escape — the `ai-review-override` label —
 * WAIVES the check rather than routing to a person. A waiver records nothing
 * about whether anybody read the diff. A tier does.
 *
 * ## UNMEASURED is not LOW
 *
 * A change list that could not be read is not a small change. Every refusal
 * here returns `tier: null` with the entries that caused it, and a caller
 * that treats `null` as "fine" has rebuilt the fail-open this module exists
 * to avoid. `.claude/rules/config-access.md` calls the alternative *Silent
 * Default Substitution*; in a risk classifier it is the whole failure.
 *
 * ## Where the numbers came from, and CRC-E9
 *
 * `LOW_MAX_FILES` and `LOW_MAX_LINES` start strict and are not evidence-based
 * yet — nothing in this repository has measured what size of change reaches
 * main without a defect. CRC-E9 ("tiers start strict and loosen with
 * evidence") is the criterion that makes them move, and it is deliberately
 * not implemented here: loosening needs a recorded outcome to loosen against,
 * and the ledger that would hold it does not carry tiers yet. Starting strict
 * and staying there is the honest state, and it is the direction this is
 * allowed to be wrong in.
 */

import { underPrefix, normaliseRepoPath } from "./repo-path";

/** Low needs no human, medium one, high two. */
export type RiskTier = "low" | "medium" | "high";

export interface TierPolicy {
  /** CRC-E1: how many PEOPLE must approve. An agent is never one of them. */
  readonly humansRequired: 0 | 1 | 2;
  readonly meaning: string;
}

/**
 * CRC-E1: the tiers, written down, in one place.
 *
 * `humansRequired` is a count of people. CRC-E6 — an agent's approval never
 * counts as a person's — is a property of whoever reads this number, and this
 * repository cannot currently observe it: branch protection declares no
 * required reviews, so there is no approval state for an agent to pollute.
 * The field is named `humansRequired` rather than `approvalsRequired` so that
 * the day there is one, the distinction is already in the type.
 */
export const RISK_TIERS: Record<RiskTier, TierPolicy> = {
  low: {
    humansRequired: 0,
    meaning: "Checks are the review. Arm auto-merge and move on.",
  },
  medium: {
    humansRequired: 1,
    meaning: "One person reads the diff before it merges.",
  },
  high: {
    humansRequired: 2,
    meaning: "Two people read the diff. No waiver substitutes for either.",
  },
};

/**
 * CRC-E4's floor. Any changed path at or under one of these is HIGH, and no
 * configuration can lower it.
 *
 * `.github/workflows/` is a GitHub fact, not a consumer-specific value, which
 * is why it is built in rather than read from a project's config — a consumer
 * that has never configured anything still gets the criterion.
 */
export const ALWAYS_HIGH_PREFIXES: readonly string[] = [".github/workflows"];

/** Below these a change may be LOW. They start strict — see CRC-E9 above. */
export const LOW_MAX_FILES = 5;
export const LOW_MAX_LINES = 150;

export type RiskReason =
  /** CRC-E4, the built-in floor. */
  | "CI_WORKFLOW_FILE"
  /** CRC-E4, an owner-listed path. */
  | "OWNER_SENSITIVE_PATH"
  /** Too many files or lines to call small. */
  | "SIZE"
  /** The size of the change was not supplied, so it is not known to be small. */
  | "SIZE_UNKNOWN"
  /** Nothing raised it. */
  | "NO_ESCALATION";

export type RiskRefusal =
  /** The list could not be read at all — a caller passed null. */
  | "CHANGED_FILES_UNREADABLE"
  /** The list was read and is empty. A change touching nothing is not small. */
  | "CHANGED_FILES_EMPTY"
  /** At least one entry is not a repository path. */
  | "CHANGED_FILE_UNREADABLE"
  /**
   * An owner CONFIGURED a sensitive path the classifier cannot read.
   *
   * This is the refusal it is most tempting to skip, and the most dangerous
   * to. `underPrefix` returns false on a prefix it cannot read, so a
   * configured `billing/**` or `src/auth/*` would match nothing, every path
   * under it would read as not-sensitive, and the owner would see LOW on
   * exactly the changes they wrote the setting to catch. The classifier
   * being silent is what makes it worse than having no setting at all.
   */
  | "SENSITIVE_PATH_UNREADABLE";

export interface ChangeUnderReview {
  /**
   * Every path the change touches. `null` means the list could not be read,
   * which is UNMEASURED and never LOW.
   */
  readonly changedFiles: readonly unknown[] | null;
  /** Added plus deleted lines. Absent means unknown, which is never LOW. */
  readonly linesChanged?: number;
  /** Owner-listed sensitive paths. These ADD to the floor; none subtracts. */
  readonly sensitivePaths?: readonly string[];
}

export interface RiskReading {
  /** `null` is UNMEASURED. It is not a tier and it is not LOW. */
  readonly tier: RiskTier | null;
  readonly humansRequired: number | null;
  readonly reasons: readonly RiskReason[];
  readonly refusals: readonly RiskRefusal[];
  /** Human-readable lines naming what was read and what it implied. */
  readonly detail: readonly string[];
}

/**
 * CRC-E4, as ONE exported decision site.
 *
 * Every escalation to HIGH goes through this function, so a mutation of it is
 * a mutation of the whole criterion and `test/risk-tier.test.ts` can prove the
 * classifier is able to fail. A later branch that inlines its own prefix
 * comparison bypasses that mutation and the criterion goes green having
 * witnessed nothing — `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * Returns `null` when nothing about the path forces HIGH. An unreadable path
 * also returns `null` here: it is not a REASON for HIGH, it is a refusal, and
 * `classifyChange` handles it one layer up so the two states stay distinct.
 */
export function alwaysHighReason(
  path: unknown,
  sensitivePaths: readonly string[] = [],
): RiskReason | null {
  for (const prefix of ALWAYS_HIGH_PREFIXES) {
    if (underPrefix(path, prefix)) return "CI_WORKFLOW_FILE";
  }
  for (const prefix of sensitivePaths) {
    if (underPrefix(path, prefix)) return "OWNER_SENSITIVE_PATH";
  }
  return null;
}

/**
 * Read a change and say which tier it is in, or refuse.
 *
 * The order is deliberate and is the same ordering lesson as the filing gate:
 * **refusals are read before escalations are counted.** A list with an
 * unreadable entry is UNMEASURED even if another entry already forced HIGH,
 * because "HIGH, and also I could not read part of this" is a reading the
 * caller must see rather than one it should be spared.
 */
export function classifyChange(change: ChangeUnderReview): RiskReading {
  const detail: string[] = [];
  const { changedFiles, linesChanged, sensitivePaths = [] } = change;

  if (changedFiles === null) {
    return unmeasured(["CHANGED_FILES_UNREADABLE"], [
      "The changed-file list could not be read. A change whose extent is " +
        "unknown is UNMEASURED, never low risk.",
    ]);
  }
  if (changedFiles.length === 0) {
    return unmeasured(["CHANGED_FILES_EMPTY"], [
      "The changed-file list was read and is empty. Either the change " +
        "touches nothing, or the list was produced wrongly; those are " +
        "different facts and neither is low risk.",
    ]);
  }

  // The CONFIGURED side is read before the change is. `underPrefix` refuses a
  // prefix it cannot read by returning false, which at this call site would
  // mean "not sensitive" — so the decision it defers to the caller is taken
  // here, explicitly, and taken toward refusing.
  const badPrefixes = sensitivePaths.filter(
    s => normaliseRepoPath(typeof s === "string" ? s.replace(/\/+$/, "") : s) === null,
  );
  if (badPrefixes.length > 0) {
    return unmeasured(["SENSITIVE_PATH_UNREADABLE"], [
      `${badPrefixes.length} configured sensitive path(s) could not be read ` +
        `as a repository path: ` +
        `${badPrefixes.slice(0, 3).map(p => JSON.stringify(p)).join(", ")}. ` +
        `Globs are not supported — write the directory. A prefix the ` +
        `classifier cannot read is a prefix it cannot enforce, and matching ` +
        `nothing would report LOW on exactly the paths the setting exists ` +
        `to catch.`,
    ]);
  }

  const unreadable = changedFiles.filter(p => normaliseRepoPath(p) === null);
  if (unreadable.length > 0) {
    return unmeasured(["CHANGED_FILE_UNREADABLE"], [
      `${unreadable.length} of ${changedFiles.length} changed-file entr(ies) ` +
        `could not be read as a repository path: ` +
        `${unreadable.slice(0, 3).map(p => JSON.stringify(p)).join(", ")}. ` +
        `A path the classifier cannot read is a path it cannot compare ` +
        `against a sensitive prefix.`,
    ]);
  }

  const reasons = new Set<RiskReason>();
  for (const path of changedFiles) {
    const reason = alwaysHighReason(path, sensitivePaths);
    if (reason !== null) {
      reasons.add(reason);
      detail.push(
        `${normaliseRepoPath(path)} forces HIGH (${reason}): ` +
          `${RISK_TIERS.high.meaning}`,
      );
    }
  }
  if (reasons.size > 0) return at("high", [...reasons], detail);

  if (typeof linesChanged !== "number" || !Number.isFinite(linesChanged)) {
    detail.push(
      "The size of this change was not supplied, so it is not known to be " +
        "small. Unknown size is MEDIUM, not LOW.",
    );
    return at("medium", ["SIZE_UNKNOWN"], detail);
  }
  if (changedFiles.length > LOW_MAX_FILES || linesChanged > LOW_MAX_LINES) {
    detail.push(
      `${changedFiles.length} file(s) and ${linesChanged} line(s) changed, ` +
        `over the LOW ceiling of ${LOW_MAX_FILES} file(s) and ` +
        `${LOW_MAX_LINES} line(s).`,
    );
    return at("medium", ["SIZE"], detail);
  }

  detail.push(
    `${changedFiles.length} file(s) and ${linesChanged} line(s) changed, no ` +
      `sensitive path touched. ${RISK_TIERS.low.meaning}`,
  );
  return at("low", ["NO_ESCALATION"], detail);
}

function at(
  tier: RiskTier,
  reasons: RiskReason[],
  detail: string[],
): RiskReading {
  return {
    tier,
    humansRequired: RISK_TIERS[tier].humansRequired,
    reasons,
    refusals: [],
    detail,
  };
}

function unmeasured(refusals: RiskRefusal[], detail: string[]): RiskReading {
  return { tier: null, humansRequired: null, reasons: [], refusals, detail };
}
