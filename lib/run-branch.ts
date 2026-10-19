/**
 * The `rungate/run-<issue>` branch: is it safe to delete, and did the run
 * leave the shared checkout somewhere it did not find it (#640).
 *
 * ## What actually happens today
 *
 * A ship run checks `rungate/run-<issue>` out **in the shared primary**,
 * commits each wave onto it there, and then ends. Nothing puts the checkout
 * back and nothing deletes the branch. Measured on the primary on 2026-10-09
 * it was sitting on `rungate/run-597` with `run-621` and `run-627` left over
 * from runs that had finished hours earlier; measured again on 2026-10-19 it
 * was on `rungate/run-631`, eleven days later, same defect.
 *
 * Three costs, in increasing order:
 *
 *   1. The primary lies about where it is. `git -C <primary> …` is the
 *      documented way to avoid `cd` in this repo, and it answers with a run
 *      branch.
 *   2. The refs accumulate. The name is keyed on the ISSUE, not the run, so
 *      a leftover from a previous run of the same issue is indistinguishable
 *      by name from the current one.
 *   3. A stale ref has already cost a run an IMPLEMENT failure.
 *
 * ## Why containment is a BLOB comparison and never an ancestry one
 *
 * This is the part that decides whether the cleanup is usable at all.
 *
 * Every branch this repo creates is **squash-merged**, and a squash merge
 * destroys ancestry: the merged content has no commit in common with the
 * branch that produced it. `git merge-base --is-ancestor` therefore reports
 * ORPHANED for content that is fully present on main — measured on the six
 * commits #511 and #512 recovered, all six reported orphaned, all six fully
 * landed. A cleanup built on ancestry would refuse to delete **every branch
 * it ever created**, which is a refusal nobody can act on and everybody
 * learns to click past.
 *
 * So the question asked here is the one `scripts/verify-merge-content.ts`
 * asks at merge time, pointed at a branch instead of a merge commit: of the
 * paths this branch CHANGED, does the base hold the same bytes, mode and
 * type? The blob reading comes from `lib/tree-entries.ts`, which both files
 * import, so there is one binding to mutate rather than two that agree.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward NOT deleting. A branch whose work landed and whose files the base
 * has since modified reads `NOT_CONTAINED`, and the cleanup leaves it alone.
 * That costs a stale ref somebody deletes by hand. The other direction
 * destroys unmerged work, so `UNMEASURED` — an unreadable repo, an
 * unresolvable ref — refuses too, and is reported rather than treated as a
 * clean branch with nothing in it.
 */
import { treeEntries, gitRead } from "./tree-entries";

/** The branch a ship run commits its waves onto. Keyed on the issue. */
export function runBranchName(issue: number | string): string {
  return `rungate/run-${issue}`;
}

/** A path the branch changed, and what each side holds there. */
export interface ContainmentDivergence {
  path: string;
  /** `<mode> <type> <oid>` the branch holds, or `ABSENT`. */
  branch: string;
  /** `<mode> <type> <oid>` the base holds, or `ABSENT`. */
  base: string;
}

export type ContainmentReading =
  /** Every path the branch changed is present on the base, byte for byte. */
  | { reading: "CONTAINED"; branch: string; base: string; comparedPaths: number }
  /** The branch holds something the base does not. Refuse to delete it. */
  | {
      reading: "NOT_CONTAINED";
      branch: string;
      base: string;
      comparedPaths: number;
      divergent: ContainmentDivergence[];
      refusal: string;
    }
  /** The question could not be asked. Not the same as a clean answer. */
  | { reading: "UNMEASURED"; branch: string; base: string; refusal: string };

const MAX_NAMED = 8;

function refusalSuffix(d: ContainmentDivergence[]): string {
  const named = d.slice(0, MAX_NAMED).map(x => x.path).join(", ");
  return d.length > MAX_NAMED ? `${named}, … (${d.length} total)` : named;
}

/**
 * Whether every change on `branch` is already present on `base`.
 *
 * `comparedPaths` is on the reading rather than derived by the caller,
 * because a comparison over ZERO paths is the thing that reads exactly like
 * a clean one: an empty divergence list is produced both by a branch that is
 * genuinely contained and by a scope that failed to resolve. A caller that
 * wants to refuse a vacuous CONTAINED can see the number.
 */
export function branchContainment(repo: string, branch: string, base: string): ContainmentReading {
  const named = { branch, base };

  if (!String(repo || "").trim()) {
    return { ...named, reading: "UNMEASURED", refusal: "no repository was named, so nothing was read" };
  }
  for (const [label, ref] of [["branch", branch], ["base", base]] as const) {
    if (!String(ref || "").trim()) {
      return { ...named, reading: "UNMEASURED", refusal: `no ${label} ref was named, so nothing was read` };
    }
  }

  let branchTree: Map<string, string>;
  let baseTree: Map<string, string>;
  let mergeBaseTree: Map<string, string>;
  try {
    branchTree = treeEntries(repo, branch);
    baseTree = treeEntries(repo, base);
    // The scope is what the BRANCH changed, which is the diff against where
    // it left the base — not the whole tree. Comparing whole trees would
    // call every branch divergent the moment the base moved on for any
    // unrelated reason, which is the same unusable refusal as ancestry.
    //
    // `merge-base` EXITS 1 when there is none, which is the same shape as
    // any other git failure and must not be read as one: unrelated
    // histories have no scope at all, and an empty scope compares clean.
    // So it is asked separately and its own non-zero is a named reading,
    // not a generic "could not be read".
    let mergeBase = "";
    try {
      mergeBase = gitRead(repo, ["merge-base", branch, base]).out.trim();
    } catch {
      mergeBase = "";
    }
    if (!mergeBase) {
      return {
        ...named,
        reading: "UNMEASURED",
        refusal:
          `${branch} and ${base} have no merge base, so there is no scope to compare — ` +
          "unrelated histories are not an empty diff, and an empty diff is what this would " +
          "otherwise report",
      };
    }
    mergeBaseTree = treeEntries(repo, mergeBase);
  } catch (e: any) {
    return {
      ...named,
      reading: "UNMEASURED",
      refusal:
        `the trees for ${branch} and ${base} could not be read (${String(e?.message || e).split("\n")[0]}), ` +
        "and unreadable is not contained",
    };
  }

  const scope = new Set<string>();
  for (const [path, entry] of branchTree) {
    if (mergeBaseTree.get(path) !== entry) scope.add(path);
  }
  for (const path of mergeBaseTree.keys()) {
    if (!branchTree.has(path)) scope.add(path);
  }

  const divergent: ContainmentDivergence[] = [];
  for (const path of [...scope].sort()) {
    const b = branchTree.get(path) ?? "ABSENT";
    const o = baseTree.get(path) ?? "ABSENT";
    if (b !== o) divergent.push({ path, branch: b, base: o });
  }

  if (divergent.length > 0) {
    return {
      ...named,
      reading: "NOT_CONTAINED",
      comparedPaths: scope.size,
      divergent,
      refusal:
        `${branch} holds ${divergent.length} of its ${scope.size} changed path(s) that ${base} does not ` +
        `match: ${refusalSuffix(divergent)}. Deleting it would destroy that work.`,
    };
  }

  return { ...named, reading: "CONTAINED", comparedPaths: scope.size };
}

/** The one sentence a caller prints, or null when there is nothing to say. */
export function containmentRefusal(r: ContainmentReading): string | null {
  return r.reading === "CONTAINED" ? null : r.refusal;
}

/**
 * The shared checkout's HEAD, before and after, as one comparison.
 *
 * A run that leaves the primary somewhere else is cost 1 above, and the only
 * honest way to assert it is to read the branch at both ends and compare —
 * not to describe the intent, and not to assert that a restore step exists.
 */
export type CheckoutDrift =
  | { reading: "UNCHANGED"; before: string; after: string }
  | { reading: "MOVED"; before: string; after: string; refusal: string }
  | { reading: "UNMEASURED"; before: string; after: string; refusal: string };

export function checkoutDrift(before: unknown, after: unknown): CheckoutDrift {
  const b = String(before ?? "").trim();
  const a = String(after ?? "").trim();
  // An unread end is not an unchanged one. A run that failed to report where
  // the checkout ended up has not proven it put it back — and an empty
  // string compared with an empty string is equality, which is how this
  // would otherwise pass by never having looked.
  if (!b || !a) {
    return {
      reading: "UNMEASURED",
      before: b,
      after: a,
      refusal:
        `the shared checkout's branch was not read at ${!b ? "the start" : "the end"} of the run, ` +
        "so whether the run moved it is unknown — and unknown is not unchanged (#640)",
    };
  }
  if (b === a) return { reading: "UNCHANGED", before: b, after: a };
  return {
    reading: "MOVED",
    before: b,
    after: a,
    refusal:
      `the run left the shared checkout on ${a}; it was on ${b} when the run started. ` +
      "Every other session reading that checkout now gets a run branch (#640)",
  };
}

/** The one sentence a caller prints, or null when the checkout came back. */
export function checkoutDriftRefusal(d: CheckoutDrift): string | null {
  return d.reading === "UNCHANGED" ? null : d.refusal;
}

export type LeftoverReading =
  /** No branch of that name. The ordinary start-of-run state. */
  | { reading: "ABSENT"; branch: string }
  /** A branch exists, and it is safe to reuse or remove. */
  | { reading: "LEFTOVER_CONTAINED"; branch: string; notice: string }
  /** A branch exists and holds work. Reusing it silently would bury it. */
  | { reading: "LEFTOVER_UNCONTAINED"; branch: string; notice: string; divergent: ContainmentDivergence[] }
  | { reading: "UNMEASURED"; branch: string; notice: string };

/**
 * Whether a run is about to reuse a branch somebody else left behind.
 *
 * The name is keyed on the issue, so a second run of the same issue finds
 * the first run's branch and commits onto it as if it were its own. That is
 * not hypothetical — it is the only state the primary has been observed in,
 * and nothing today distinguishes it from a fresh start.
 *
 * This REPORTS. It does not refuse: an interrupted run's branch is usually
 * exactly what you want to resume onto, and a gate that stopped every re-run
 * is one that gets switched off.
 */
export function leftoverRunBranch(repo: string, issue: number | string, base: string): LeftoverReading {
  const branch = runBranchName(issue);
  let exists: boolean;
  try {
    const { out } = gitRead(repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`]);
    exists = out.trim() === branch;
  } catch (e: any) {
    return {
      reading: "UNMEASURED",
      branch,
      notice:
        `could not ask ${repo} whether ${branch} already exists ` +
        `(${String(e?.message || e).split("\n")[0]}) — unknown is not absent (#640)`,
    };
  }
  if (!exists) return { reading: "ABSENT", branch };

  const containment = branchContainment(repo, branch, base);
  if (containment.reading === "UNMEASURED") {
    return {
      reading: "UNMEASURED",
      branch,
      notice: `${branch} already exists and ${containment.refusal}`,
    };
  }
  if (containment.reading === "CONTAINED") {
    return {
      reading: "LEFTOVER_CONTAINED",
      branch,
      notice:
        `${branch} already exists and everything on it is already on ${base} — ` +
        "a leftover from an earlier run of this issue, not work in progress (#640)",
    };
  }
  return {
    reading: "LEFTOVER_UNCONTAINED",
    branch,
    divergent: containment.divergent,
    notice:
      `${branch} already exists and ${containment.refusal} This run will commit onto it. ` +
      "If that is not an interrupted run of this issue, stop and look (#640)",
  };
}
