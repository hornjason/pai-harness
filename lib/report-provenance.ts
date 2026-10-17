/**
 * The tree a report was measured against, stated by the reporter (#553).
 *
 * Two security reviews arrived from peer sessions on 2026-10-17. Both
 * reported CONFIRMED findings, both were measured against a tree the branch
 * had already moved past, and in both cases the report gave no way to tell.
 * sec-492's three findings were measured at `7fdfa72a` (20:32); two commits
 * landed about 75 minutes later and closed all three, and two of the
 * "0 red" mutation rows are 3 and 1 on main.
 *
 * ## What is missing is the SENDING side
 *
 * `.claude/rules/parallel-sessions.md` already covers the receiving side —
 * *"peer reports are evidence, not fact"* — and that rule worked both times:
 * the reports were checked before anything was acted on, which is the only
 * reason neither cost anything. But verifying every finding from scratch is
 * the expensive path to a cheap fact that **the reviewer already holds**.
 *
 * The ship pipeline solves this inside itself: `reviewIsCurrent` pins a
 * review to a commit and blocks when the branch has moved, which is #129,
 * #169, #171 and #244 of accumulated work. A review conducted OUTSIDE
 * `workflows/ship.js` inherits none of it.
 *
 * So this is that same binding, reachable from a terminal. It does not
 * reimplement the comparison — `reviewIsCurrent` is imported, because a
 * second decider answering the same question is behaviourally one decider
 * and no test can tell them apart
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * ## It fails closed, and an unanswerable question is not a pass
 *
 * A branch that cannot be resolved, a SHA that is not a SHA, a directory
 * that is not a repository: all `current: false`, each with a reason naming
 * what could not be read. A reviewer who cannot establish currency has
 * learned something worth putting in the report, and a provenance block that
 * went quiet on an error would be worse than none — it would be a claim.
 */
import { execFileSync } from "child_process";

import { reviewIsCurrent } from "./security-verdict";

/** The exit code of a stale or unmeasurable reading. One site, so it can be mutated. */
export const STALE_EXIT = 1;

export interface ProvenanceReading {
  /** The commit the report describes. */
  measured: string | null;
  /** The commit the branch ends at now, or null when it could not be read. */
  tip: string | null;
  /** The ref the tip was read from, e.g. `origin/fix/553`. */
  ref: string | null;
  current: boolean;
  /** Always present. Names both operands when there are two to name. */
  reason: string;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The ref whose tip a report should be aged against.
 *
 * `origin/<branch>` when it exists, because that is what another session can
 * see; the local branch otherwise, which is the honest answer for work that
 * has not been pushed. Detached HEAD has no branch and says so.
 */
export function defaultRef(root: string): string | null {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null || branch === "" || branch === "HEAD") return null;
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== null) {
    return `origin/${branch}`;
  }
  return branch;
}

/**
 * Compare the tree a report describes against the tree the branch ends at.
 *
 * `measured` defaults to this working tree's HEAD, which is what a reviewer
 * who just finished reading has in front of them.
 */
export function provenanceReading(
  root: string,
  measured?: string,
  ref?: string,
): ProvenanceReading {
  const measuredSha = measured ?? git(root, ["rev-parse", "HEAD"]);
  const resolvedRef = ref ?? defaultRef(root);

  if (resolvedRef === null) {
    return {
      measured: measuredSha,
      tip: null,
      ref: null,
      current: false,
      reason:
        `UNMEASURED: no branch to age this report against — ${root} is not a repository, ` +
        `or HEAD is detached. State the commit you measured and say that the branch could ` +
        `not be resolved.`,
    };
  }

  // Fetch nothing. A reviewer who has not fetched is comparing against a
  // stale remote-tracking ref, which is a different failure from a moved
  // branch and must not be hidden by a network call this function made on
  // its own.
  const tip = git(root, ["rev-parse", "--verify", `${resolvedRef}^{commit}`]);
  if (tip === null) {
    return {
      measured: measuredSha,
      tip: null,
      ref: resolvedRef,
      current: false,
      reason:
        `UNMEASURED: ${resolvedRef} could not be resolved, so there is nothing to compare ` +
        `${measuredSha ?? "an unreadable HEAD"} against.`,
    };
  }

  // The one binding. `workflows/ship.js` inlines a copy of this function for
  // the sandbox (#69) and `test/security-verdict-blocks.test.ts` holds the
  // two to parity; this is the library side, imported rather than repeated.
  const currency = reviewIsCurrent(measuredSha, tip);
  return {
    measured: measuredSha,
    tip,
    ref: resolvedRef,
    current: currency.current,
    reason: currency.current
      ? `the report describes ${measuredSha}, which is the tip of ${resolvedRef}`
      : (currency.reason ??
          `the report describes ${measuredSha}, which is not the tip of ${resolvedRef} (${tip})`),
  };
}

/** The block to paste at the top of a report. Always states both commits. */
export function provenanceBlock(reading: ProvenanceReading): string {
  const lines = [
    `Measured against: ${reading.measured ?? "UNKNOWN"}`,
    `Branch tip (${reading.ref ?? "unresolved"}): ${reading.tip ?? "UNKNOWN"}`,
    reading.current
      ? `Currency: CURRENT — ${reading.reason}`
      : `Currency: NOT CURRENT — ${reading.reason}`,
  ];
  return lines.join("\n");
}
