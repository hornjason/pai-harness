/**
 * Does the reporting worktree's copy of a file say the same thing as the
 * claiming worktree's copy? (#892)
 *
 * The collection audit decides on the CLAIM LEDGER alone. That makes two very
 * different situations indistinguishable:
 *
 *   two worktrees edited a file differently, one did not claim it  → refuse
 *   two worktrees produced the SAME BYTES for a file               → nothing
 *                                                                    to lose
 *
 * On run `wf_161c4e96-f01` — 24 agents, ~35 minutes, 0 errors — the second
 * case cost the whole run: three preserved branches whose overlapping files
 * were byte-identical, nine files refused as unclaimed, `SHIP_FAILED`, no PR.
 *
 * This module is the second reading that separates them, and nothing else. It
 * does not relax the guard and it cannot: a reading of DIFFERENT still refuses,
 * with a strictly better sentence, and a reading nobody could take is
 * `UNMEASURED` — which refuses too, because a comparison that did not happen is
 * not a comparison that passed.
 *
 * ## One binding
 *
 * `compareClaimedFileContent` is the only export, so there is exactly one site
 * to mutate and one position in the tree that performs the comparison. A second
 * copy would survive any mutation of the first and both would read as covered
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * ## What it deliberately does NOT do
 *
 * - **It does not normalise the path.** `claimKey` in `workflows/ship.js`'s
 *   COLLECT-CLAIM block already does, and the audit calls this with the key it
 *   produced. A second normaliser here would be two deciders for one question.
 * - **It does not judge path safety.** `pathRefusal` is asked by staging and by
 *   the audit, before this is ever reached (#400). A third asker would be the
 *   defect #400 removed, reinstated.
 * - **It does not decide what to do about the answer.** The arm that refuses,
 *   keeps, or words a violation is the audit's, which is what makes this a
 *   reading rather than a policy.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * What a comparison concluded.
 *
 * `UNMEASURED` is a first-class answer rather than a falsy IDENTICAL. `0`,
 * `{}`, `null` and silence are all indistinguishable from success;
 * `UNMEASURED` is not (`.claude/rules/config-access.md`).
 */
export type ClaimContentReading = "IDENTICAL" | "DIFFERENT" | "UNMEASURED";

/**
 * One side's reading of one copy, as the reader reports it.
 *
 * `digest` is whatever representation of the bytes the reader chose; two copies
 * are IDENTICAL exactly when their digests are equal. The built-in reader
 * returns a sha256 hex digest of the file's bytes, so equality of digests is
 * equality of bytes rather than equality of some decoding of them.
 *
 * `readable: true` with no `digest` is NOT a reading. It is a reader that
 * answered without answering, and it resolves to UNMEASURED — see
 * `usableDigest` below.
 */
export interface ClaimContentCopy {
  readable: boolean;
  digest?: string | null;
  reason?: string | null;
}

/** How a copy is read. Injected so a case can force every state. */
export type ClaimContentReader = (absolutePath: string) => ClaimContentCopy;

/** A side whose copy could not be read, named with its own failure sentence. */
export interface ClaimContentUnreadable {
  side: "reporting" | "claiming";
  /** The exact path the read was attempted against. */
  path: string;
  /** The reader's own reason, never an empty string. */
  reason: string;
}

export interface ClaimContentComparison {
  reading: ClaimContentReading;
  /** The path compared, as handed in. */
  path: string;
  reportingPath: string;
  claimingPath: string;
  /**
   * Every side that could not be read. Empty for IDENTICAL and DIFFERENT, and
   * non-empty for every UNMEASURED — the two are projections of one decision
   * taken in `compareClaimedFileContent` and nowhere else, so they cannot
   * disagree about whether a reading happened.
   */
  unreadable: ClaimContentUnreadable[];
}

export interface ClaimContentRequest {
  path: string;
  reportingWorktree: string;
  claimingWorktree: string;
  /** Omit to read the filesystem. */
  read?: ClaimContentReader;
}

/**
 * A failure with no sentence beside it reads, downstream, exactly like a
 * failure nobody recorded. Both of these are substituted in, by name, so the
 * operator is told that the reader was silent rather than told nothing.
 */
const NO_REASON = "the reader reported a failure and gave no reason";
const NO_DIGEST = "the reader reported success and returned no digest";
const NO_PATH = "no path was given to compare";
const NO_WORKTREE = "no worktree directory was given for this side";

function joinInside(worktree: string, path: string): string {
  const base = worktree.replace(/\/+$/, "");
  const rest = path.replace(/^\/+/, "");
  return base ? `${base}/${rest}` : rest;
}

/** The built-in reader: bytes in, sha256 hex out, the OS's own sentence on failure. */
function readFromDisk(absolutePath: string): ClaimContentCopy {
  try {
    const bytes = readFileSync(absolutePath);
    return { readable: true, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch (err) {
    return { readable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The digest, or the reason there is not one.
 *
 * Three states collapse to "no digest" and each keeps its own sentence: a
 * reader that failed with a reason, a reader that failed without one, and a
 * reader that claimed success and returned nothing. The third is the dangerous
 * one — `undefined === undefined` is true, so without this check two copies
 * nobody could read would compare IDENTICAL.
 */
function usableDigest(copy: ClaimContentCopy): { digest: string } | { reason: string } {
  if (!copy.readable) {
    const reason = typeof copy.reason === "string" ? copy.reason.trim() : "";
    return { reason: reason || NO_REASON };
  }
  if (typeof copy.digest !== "string") return { reason: NO_DIGEST };
  return { digest: copy.digest };
}

function readSide(
  side: "reporting" | "claiming",
  worktree: string,
  path: string,
  read: ClaimContentReader,
): { digest: string } | { unreadable: ClaimContentUnreadable } {
  if (!worktree.trim()) {
    return { unreadable: { side, path, reason: NO_WORKTREE } };
  }
  const absolutePath = joinInside(worktree, path);
  let copy: ClaimContentCopy;
  try {
    copy = read(absolutePath);
  } catch (err) {
    return {
      unreadable: {
        side,
        path: absolutePath,
        reason: (err instanceof Error ? err.message : String(err)).trim() || NO_REASON,
      },
    };
  }
  const usable = usableDigest(copy);
  if ("reason" in usable) return { unreadable: { side, path: absolutePath, reason: usable.reason } };
  return { digest: usable.digest };
}

/**
 * Compare the reporting worktree's copy of `path` against the claiming
 * worktree's copy.
 *
 * Both sides are always read, in order, so a comparison can never be satisfied
 * by one side alone.
 */
export function compareClaimedFileContent(request: ClaimContentRequest): ClaimContentComparison {
  const path = String(request.path ?? "");
  const reportingWorktree = String(request.reportingWorktree ?? "");
  const claimingWorktree = String(request.claimingWorktree ?? "");
  const read = request.read ?? readFromDisk;

  const reportingPath = joinInside(reportingWorktree, path);
  const claimingPath = joinInside(claimingWorktree, path);

  if (!path.trim()) {
    return {
      reading: "UNMEASURED",
      path,
      reportingPath,
      claimingPath,
      unreadable: [
        { side: "reporting", path: reportingPath, reason: NO_PATH },
        { side: "claiming", path: claimingPath, reason: NO_PATH },
      ],
    };
  }

  const reporting = readSide("reporting", reportingWorktree, path, read);
  const claiming = readSide("claiming", claimingWorktree, path, read);

  const unreadable: ClaimContentUnreadable[] = [];
  if ("unreadable" in reporting) unreadable.push(reporting.unreadable);
  if ("unreadable" in claiming) unreadable.push(claiming.unreadable);
  if (unreadable.length > 0) {
    return { reading: "UNMEASURED", path, reportingPath, claimingPath, unreadable };
  }

  const reportingDigest = (reporting as { digest: string }).digest;
  const claimingDigest = (claiming as { digest: string }).digest;
  return {
    reading: reportingDigest === claimingDigest ? "IDENTICAL" : "DIFFERENT",
    path,
    reportingPath,
    claimingPath,
    unreadable: [],
  };
}
