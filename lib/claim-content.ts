/**
 * Do two worktrees' copies of one file say the same thing? (#892)
 *
 * The collection audit in `workflows/ship.js` decides on the CLAIM LEDGER
 * alone, which makes two very different situations one refusal:
 *
 *   two worktrees edited a file differently, one did not claim it → refuse
 *   two worktrees produced the SAME BYTES                         → nothing
 *                                                                   to lose
 *
 * On run `wf_161c4e96-f01` — 24 agents, ~35 minutes, 0 errors — the second
 * case cost the whole run: the overlapping files were byte-identical across
 * three preserved branches and one branch was a strict superset of the other
 * two, so there was no divergence to catch and the work was refused anyway.
 *
 * This module is the second reading and nothing else. It does not relax the
 * guard and it cannot: DIFFERENT still refuses, and a reading nobody could
 * take is `UNMEASURED`, which refuses too — a comparison that did not happen
 * is not a comparison that passed (`.claude/rules/config-access.md`).
 *
 * ## One binding
 *
 * `contentComparison` is the only export that compares anything, so there is
 * exactly one site to mutate and one position in the tree that performs the
 * comparison. ship.js cannot import it (#69) and therefore does not re-derive
 * it either: it CONSUMES a reading produced here, through a key both sides
 * build with `contentReadingKey`. A digest computed inside the workflow
 * sandbox would be a second decider for one question, and a mutation of
 * either would leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * ## What it deliberately does NOT do
 *
 * - **It does not normalise the path.** `claimKey` in the COLLECT-CLAIM block
 *   already does, and the audit calls this with the key it produced.
 * - **It does not judge path safety.** `pathRefusal` is asked by staging and
 *   by the audit before this is ever reached (#400). A third asker would
 *   reinstate the divergence #400 removed.
 * - **It does not decide what to do about the answer.** Keeping, refusing and
 *   wording a violation are the audit's, which is what makes this a reading
 *   rather than a policy.
 *
 * Importing this module has no side effects: it reads nothing until it is
 * called, and `scripts/` may import it beside `lib/worktree-collect.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * What a comparison concluded.
 *
 * `UNMEASURED` is a first-class answer rather than a falsy IDENTICAL. `0`,
 * `{}`, `null` and silence are all indistinguishable from success; UNMEASURED
 * is not.
 */
export type ClaimContentReading = "IDENTICAL" | "DIFFERENT" | "UNMEASURED";

/**
 * One side's reading of one copy, as the reader reports it.
 *
 * `readable: true` with no `digest` is NOT a reading — it is a reader that
 * answered without answering, and it resolves to UNMEASURED. Without that
 * check `undefined === undefined` would make two copies nobody could read
 * compare IDENTICAL.
 */
export interface ClaimCopyReading {
  readable: boolean;
  digest?: string | null;
  reason?: string | null;
}

/** How a copy is read. Injected so a case can force every state. */
export type ClaimCopyReader = (absolutePath: string) => ClaimCopyReading;

/** A side whose copy could not be read, named with its own failure sentence. */
export interface UnreadableCopy {
  side: "reporting" | "claiming";
  /** The exact path the read was attempted against. */
  path: string;
  /** The reader's own reason, never an empty string. */
  reason: string;
}

export interface ContentComparison {
  reading: ClaimContentReading;
  /** The path compared, as handed in. */
  path: string;
  reportingPath: string;
  claimingPath: string;
  /**
   * Every side that could not be read. Empty for IDENTICAL and DIFFERENT and
   * non-empty for every UNMEASURED: the two are projections of one decision
   * taken below and nowhere else, so they cannot disagree about whether a
   * reading happened.
   */
  unreadable: UnreadableCopy[];
}

export interface ContentComparisonRequest {
  path: string;
  reportingWorktree: string;
  claimingWorktree: string;
  /** Omit to read the filesystem. */
  read?: ClaimCopyReader;
}

/**
 * A failure with no sentence beside it reads, downstream, exactly like a
 * failure nobody recorded. Each of these is substituted in by name, so an
 * operator is told that the reader was silent rather than told nothing.
 */
const NO_REASON = "the reader reported a failure and gave no reason";
const NO_DIGEST = "the reader reported success and returned no digest";
const NO_PATH = "no path was given, so there was nothing to compare";
const NO_WORKTREE = "no worktree directory was given for this side";

/** `<worktree>/<path>`, with the one separator both sides agree on. */
function joinInside(worktree: string, path: string): string {
  const base = worktree.replace(/\/+$/, "");
  const rest = path.replace(/^\/+/, "");
  return base ? `${base}/${rest}` : rest;
}

/** The built-in reader: bytes in, sha256 hex out, the OS's own sentence on failure. */
function readFromDisk(absolutePath: string): ClaimCopyReading {
  try {
    return {
      readable: true,
      digest: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    };
  } catch (err) {
    return { readable: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The digest, or the reason there is not one — three states, three sentences. */
function usableDigest(copy: ClaimCopyReading): { digest: string } | { reason: string } {
  if (!copy || copy.readable !== true) {
    const reason = typeof copy?.reason === "string" ? copy.reason.trim() : "";
    return { reason: reason || NO_REASON };
  }
  if (typeof copy.digest !== "string" || copy.digest === "") return { reason: NO_DIGEST };
  return { digest: copy.digest };
}

function readSide(
  side: UnreadableCopy["side"],
  worktree: string,
  path: string,
  read: ClaimCopyReader,
): { digest: string } | { unreadable: UnreadableCopy } {
  const absolutePath = joinInside(worktree, path);
  if (!worktree.trim()) return { unreadable: { side, path: absolutePath, reason: NO_WORKTREE } };

  let copy: ClaimCopyReading;
  try {
    copy = read(absolutePath);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).trim();
    return { unreadable: { side, path: absolutePath, reason: message || NO_REASON } };
  }

  const usable = usableDigest(copy);
  return "reason" in usable
    ? { unreadable: { side, path: absolutePath, reason: usable.reason } }
    : { digest: usable.digest };
}

/**
 * Compare the reporting worktree's copy of `path` against the claiming
 * worktree's copy.
 *
 * Both sides are always read, in order, so a comparison can never be satisfied
 * by one side alone.
 */
export function contentComparison(request: ContentComparisonRequest): ContentComparison {
  const path = String(request?.path ?? "");
  const reportingWorktree = String(request?.reportingWorktree ?? "");
  const claimingWorktree = String(request?.claimingWorktree ?? "");
  const read = request?.read ?? readFromDisk;

  const reportingPath = joinInside(reportingWorktree, path);
  const claimingPath = joinInside(claimingWorktree, path);
  const unmeasured = (unreadable: UnreadableCopy[]): ContentComparison => ({
    reading: "UNMEASURED",
    path,
    reportingPath,
    claimingPath,
    unreadable,
  });

  if (!path.trim()) {
    return unmeasured([
      { side: "reporting", path: reportingPath, reason: NO_PATH },
      { side: "claiming", path: claimingPath, reason: NO_PATH },
    ]);
  }

  const reporting = readSide("reporting", reportingWorktree, path, read);
  const claiming = readSide("claiming", claimingWorktree, path, read);

  const unreadable: UnreadableCopy[] = [];
  if ("unreadable" in reporting) unreadable.push(reporting.unreadable);
  if ("unreadable" in claiming) unreadable.push(claiming.unreadable);
  if (unreadable.length > 0) return unmeasured(unreadable);

  return {
    reading:
      (reporting as { digest: string }).digest === (claiming as { digest: string }).digest
        ? "IDENTICAL"
        : "DIFFERENT",
    path,
    reportingPath,
    claimingPath,
    unreadable: [],
  };
}
