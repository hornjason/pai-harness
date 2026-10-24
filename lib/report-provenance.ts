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

import { type DirectoryCurrency, type GitRunner, directoryCurrency } from "./hook-tree-currency";
import { reviewIsCurrent } from "./security-verdict";

/** The exit code of a stale or unmeasurable reading. One site, so it can be mutated. */
export const STALE_EXIT = 1;

/**
 * The refusal when the directory read is not the one under review (#1348).
 *
 * One site, so `test/report-provenance.test.ts` can prove the refusal fires
 * rather than inferring it from an exit code that a dozen other conditions
 * also produce.
 */
export const WRONG_TREE = "UNMEASURED: wrong tree";

export interface ProvenanceReading {
  /**
   * The directory the reading was taken in. Always present: a SHA does not
   * say where it was read, and that is the fact a reader cannot reconstruct.
   */
  root: string;
  /** The branch checked out at `root`, or null for a detached HEAD. */
  branch: string | null;
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
 * The branch checked out at `root`. Null for a detached HEAD, an empty
 * answer, or a directory that is not a repository — all three are "there is
 * no branch here", which is a different fact from any branch name.
 */
export function branchAt(root: string): string | null {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch === null || branch === "" || branch === "HEAD" ? null : branch;
}

/**
 * The ref whose tip a report should be aged against.
 *
 * `origin/<branch>` when it exists, because that is what another session can
 * see; the local branch otherwise, which is the honest answer for work that
 * has not been pushed. Detached HEAD has no branch and says so.
 */
export function defaultRef(root: string): string | null {
  const branch = branchAt(root);
  if (branch === null) return null;
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
  expectBranch?: string,
): ProvenanceReading {
  const measuredSha = measured ?? git(root, ["rev-parse", "HEAD"]);
  const branch = branchAt(root);

  // Before anything else, because a reading taken in the wrong directory is
  // not stale and not current — it is about a different tree, and every
  // other field below would be a true statement about the wrong thing.
  if (expectBranch !== undefined && branch !== expectBranch) {
    return {
      root,
      branch,
      measured: measuredSha,
      tip: null,
      ref: null,
      current: false,
      reason:
        `${WRONG_TREE}: ${root} is on ${branch ?? "no branch"}, not ${expectBranch}. ` +
        `A command reads the directory it ran in, which here is not the one under ` +
        `review — re-run it in the worktree holding ${expectBranch}.`,
    };
  }

  const resolvedRef = ref ?? defaultRef(root);

  if (resolvedRef === null) {
    return {
      root,
      branch,
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
      root,
      branch,
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
    root,
    branch,
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

/**
 * The block to paste at the top of a report. Always states the directory
 * and both commits.
 *
 * The directory line is first because it is the one a reader cannot
 * reconstruct from the others (#1348): two SHAs describe a tree without
 * saying which checkout they were read in, and a report whose reviewer was
 * sitting in another worktree looks exactly like one whose reviewer was not.
 */
export function provenanceBlock(reading: ProvenanceReading): string {
  const lines = [
    `Measured in: ${reading.root} (branch ${reading.branch ?? "none"})`,
    `Measured against: ${reading.measured ?? "UNKNOWN"}`,
    `Branch tip (${reading.ref ?? "unresolved"}): ${reading.tip ?? "UNKNOWN"}`,
    reading.current
      ? `Currency: CURRENT — ${reading.reason}`
      : `Currency: NOT CURRENT — ${reading.reason}`,
  ];
  return lines.join("\n");
}

/**
 * The OTHER tree a session is standing in, and the one nothing above can see
 * (#1341).
 *
 * Everything to this point measures the checkout the session EDITS. A Claude
 * Code hook registration names a directory through `RUNGATE_HOOKS_DIR`, and
 * the code that executes out of it is on whatever commit the last hand
 * fast-forward left. Those are two different trees and only one of them has
 * ever been in the provenance block.
 *
 * ## The measured cost, 2026-10-24
 *
 * `/Users/jhorn/Projects/rg-hooks-live` sat at `7817f1df` while `origin/main`
 * was at `2729ce62` — **135 commits behind**, measured with
 * `git rev-list --count 7817f1df..2729ce62`. Every session's own checkout was
 * clean and current, so `provenanceReading` reported CURRENT for all of them.
 * In that window the finding arbiter refused three issue filings using
 * duplicate-detection logic PR #1538 had corrected seven minutes earlier: two
 * `DUPLICATE` verdicts on bare integers and one `DROPPED_CATEGORY/style` on
 * `\btypo\b`. Three `arbiter-override` escalations were spent on a fixed bug,
 * and the ledger rows record them as human overrides of real refusals.
 *
 * It had gone stale twice the day before. The gap is not an incident, it is
 * the steady state: nothing advances that tree, so the interval between a fix
 * merging and the behaviour changing is unbounded.
 *
 * ## Why the checkout's own SHA, and not a file recording one
 *
 * `rg-hooks-live` is a worktree on a detached HEAD, and a detached HEAD
 * already names a commit — `git rev-parse HEAD` is the whole of the
 * provenance. A `SYNCED_TO` file beside it would be a SECOND decider for one
 * question, and the weaker one: it is correct only while nobody moves the
 * checkout without rewriting it, so a hand fast-forward makes a current tree
 * read as behind, and a hand-edited tree keeps reading as current. The
 * checkout is right by construction. `.claude/rules/checks-must-be-able-to-fail.md`
 * calls two deciders agreeing the shape no behavioural test can separate.
 *
 * ## Why the count, and not `merge-base --is-ancestor`
 *
 * This repository squash-merges, and the standing rule against `--is-ancestor`
 * holds here for a reason the suite measures: on a hook tree that is **0
 * commits behind and 1 ahead**, `--is-ancestor HEAD origin/main` exits 1 — it
 * calls a checkout that is missing nothing stale — while
 * `rev-list --count HEAD..origin/main` reads 0. A boolean also cannot carry
 * the number, and the number is what tells a reader whether to care.
 * `directoryCurrency` is imported rather than reimplemented, so there is one
 * binding deciding what "behind" means.
 *
 * ## Why this is not a hook
 *
 * A currency check that ships through `${RUNGATE_HOOKS_DIR}` cannot bootstrap
 * itself: the copy that is behind is exactly the copy without the reporting
 * code. `scripts/report-provenance.ts` runs out of the session's own
 * checkout, so it is reachable by a path that cannot be stale for the reason
 * it reports.
 *
 * ## The binding is the env var, and an unset one SKIPS
 *
 * No path to any machine's hooks directory appears here. `hooksDir` is
 * supplied by the caller from `RUNGATE_HOOKS_DIR`, and `null` or blank means
 * no hook executes out of a foreign tree — nothing to age, so nothing to
 * refuse. A check that refused on an unset binding would refuse on every CI
 * runner and in every consumer's checkout, which is how a refusal becomes a
 * line everyone clicks past.
 */
export interface SessionProvenance {
  /** The tree the session edits. Exactly what `provenanceReading` returns. */
  tree: ProvenanceReading;
  /**
   * The tree the session's hooks execute out of, or `null` when
   * `RUNGATE_HOOKS_DIR` binds nothing.
   *
   * `null` is NOT `current`. It means the question does not arise, and the
   * block says so in those words rather than printing a pass.
   */
  hooks: DirectoryCurrency | null;
  /**
   * False when EITHER reading refuses. A rate, a refusal count or a ledger
   * row produced by this session is attributable to `base` only when both
   * trees are.
   */
  current: boolean;
}

/**
 * Both readings, and one verdict over them.
 *
 * `base` has no default, for the reason `lib/hook-tree-currency.ts` gives: a
 * default here would be a second place deciding which branch a tree is
 * measured against.
 */
export function sessionProvenance(input: {
  root: string;
  measured?: string;
  ref?: string;
  expectBranch?: string;
  /** From `RUNGATE_HOOKS_DIR`. Never a literal path — see the header. */
  hooksDir: string | null | undefined;
  base: string;
  git: GitRunner;
}): SessionProvenance {
  const tree = provenanceReading(input.root, input.measured, input.ref, input.expectBranch);

  const dir = input.hooksDir?.trim();
  const hooks = dir === undefined || dir === "" ? null : directoryCurrency(dir, input.base, input.git);

  return {
    tree,
    hooks,
    // `current` is the ONLY state that clears. `behind` and `unmeasured` both
    // refuse, and they keep their own names in the block below — folding them
    // together here would weaken the UNMEASURED refusal that
    // `lib/hook-tree-currency.ts` exists to keep separate from a count.
    current: tree.current && (hooks === null || hooks.state === "current"),
  };
}

/**
 * The block to paste at the top of a report, now carrying both trees.
 *
 * `provenanceBlock` is called rather than re-rendered: the four lines a
 * reader already knows how to read must not drift from the ones this adds to.
 */
export function sessionProvenanceBlock(p: SessionProvenance): string {
  const lines = [provenanceBlock(p.tree)];

  if (p.hooks === null) {
    lines.push(
      "Hook tree: not bound — RUNGATE_HOOKS_DIR is unset, so no hook executes out of a " +
        "directory this session could age.",
    );
    return lines.join("\n");
  }

  if (p.hooks.state === "current") {
    lines.push(`Hook tree: CURRENT — ${p.hooks.detail}`);
    return lines.join("\n");
  }

  // The state keeps its own word, and the consequence is spelled out rather
  // than left to the reader: the failure this closes is a number reported as
  // if it described main.
  const tag = p.hooks.state === "behind" ? `BEHIND ${p.hooks.behind}` : "UNMEASURED";
  lines.push(
    `Hook tree: ${tag} — ${p.hooks.detail}`,
    `  Any rate, refusal count or ledger row this session produces is UNMEASURED against ` +
      `${p.hooks.base}: it describes the hook tree above, not ${p.hooks.base}. Say UNMEASURED ` +
      `rather than reporting the number.`,
  );
  return lines.join("\n");
}
