/**
 * Is the session's cwd a safe place to cut agent worktrees from? (#644)
 *
 * ## The thing this does NOT do, stated first
 *
 * It does not derive the worktree base. `workflows/ship.js:1235` has pinned
 * `opts.cwd = PROJECT_ROOT` for every worktree-isolated spawn since
 * `804b9a43` on 2026-09-23, and there is no spawn path that bypasses it —
 * all six roles resolve to `isolation: 'worktree'` and no call site sets it
 * explicitly. **Rungate already passes the explicit argument.**
 *
 * It does not hold. `isolation: 'worktree'` is resolved by the agent
 * runtime against the SESSION'S cwd, and `opts.cwd` is applied to the
 * spawned agent afterwards. Run `wf_5e3ed885-98c` on 2026-10-14 put a
 * remediation Marcus in a worktree of one consumer's repository while
 * working an issue in another — three weeks after the pin landed. The
 * repositories are named on #218; they are deliberately not named here,
 * because the harness must not name its consumers (#304, SC-A1).
 *
 * So the one thing rungate controls is whether the run STARTS. This refuses
 * at launch, before any agent is spawned, when the session's cwd would
 * produce a worktree the run does not want.
 *
 * ## Two failures, one input
 *
 * Both of #644's failures are the same fact wearing different clothes, and
 * the silent one is worse:
 *
 *   1. cwd is not a git repository at all. The runtime says *"not in a git
 *      repository and no WorktreeCreate hooks are configured… to use
 *      worktree isolation with other VCS systems"*, which is about the
 *      session's cwd while naming neither it nor the session. A reader
 *      configures hooks they do not need and still has the bug.
 *   2. cwd IS a git repository, in another project or on another branch.
 *      Nothing fails. The run cuts its worktrees from somebody else's work
 *      and succeeds onto the wrong base, found later by the PR behaving
 *      oddly.
 *
 * A check that covers only the first is the cheapest wrong fix for this
 * issue, named in #644's own body: it fixes the symptom that announces
 * itself and leaves the one that does not.
 *
 * ## Why a refusal and not a repair
 *
 * `process.chdir()` would be the repair, and it is not available to a
 * workflow script, nor would it be right: the session's cwd is shared with
 * the operator and with whatever they do next. A run that quietly moved it
 * would be a side effect outside its own worktrees, which is #640's
 * complaint about the shared primary, arriving from the other direction.
 *
 * ## Three readings, not two
 *
 * `SAME_REPO` is not the same as `SAME_CHECKOUT`. The shared primary sits on
 * `rungate/run-<issue>` for the life of a run (#640) — the same repository
 * as `projectRoot`, a different working tree, on a branch belonging to
 * another issue. Collapsing that into "same repo, fine" is the precondition
 * blindness in `.claude/rules/checks-must-be-able-to-fail.md`: every natural
 * fixture runs from the right directory, so the branch where cwd and
 * `projectRoot` are the same repo and disagree anyway is outside the
 * battery's reach entirely.
 */
import { spawnSync } from "child_process";

import { readWorktreeRemote, redactRemote, repoSlug } from "./worktree-repo";

/**
 * A path or branch name, quoted and redacted.
 *
 * `worktreeDiskIdentity` in the sibling module redacts everything it
 * interpolates, and a control that does not is a parity gap a reader has
 * to notice. Paths and branch names are not usually credential-bearing —
 * but they come from the environment, a worktree can live under a
 * directory named after one, and `redactRemote` leaves an ordinary path
 * untouched, so the check costs nothing and the omission costs a leak
 * nobody is looking for.
 */
const safe = (v: unknown) => JSON.stringify(redactRemote(String(v)));

/** Every refusal and every pass travels through one of these. */
export type LaunchBaseReading =
  /** cwd and projectRoot are the same working tree. The only clean answer. */
  | { reading: "SAME_CHECKOUT"; cwd: string; projectRoot: string }
  /** cwd is a git repository, and not one git can resolve a toplevel for. */
  | { reading: "CWD_NOT_A_REPO"; cwd: string; projectRoot: string; refusal: string }
  /** cwd is a repository in a DIFFERENT project. Failure 2, loud version. */
  | { reading: "DIFFERENT_REPO"; cwd: string; projectRoot: string; refusal: string }
  /** Same repository, different working tree or branch. Failure 2, quiet version. */
  | { reading: "DIFFERENT_CHECKOUT"; cwd: string; projectRoot: string; refusal: string }
  /**
   * Something could not be read. NOT a pass: a reading that could not be
   * taken is indistinguishable from a clean one, and only one of them is
   * reportable (`.claude/rules/config-access.md`).
   */
  | { reading: "UNMEASURED"; cwd: string; projectRoot: string; refusal: string };

/** `git -C <dir> rev-parse --show-toplevel`, or `null`. */
function toplevel(dir: string): string | null {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const got = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (got.error || got.status !== 0) return null;
  const out = String(got.stdout || "").trim();
  return out === "" ? null : out;
}

/** `git -C <dir> rev-parse --abbrev-ref HEAD`, or `null`. */
function branchOf(dir: string): string | null {
  const got = spawnSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (got.error || got.status !== 0) return null;
  const out = String(got.stdout || "").trim();
  return out === "" ? null : out;
}

/**
 * The reading for one launch.
 *
 * ONE discriminator, `reading`. Every other field is a projection of the
 * same two probes taken here and nowhere else, so no two of them can
 * disagree — and a caller that only wants a boolean derives it with
 * `launchBaseRefusal` rather than re-asking git.
 *
 * The comparison is by RESOLVED TOPLEVEL first and by remote slug second,
 * in that order and for a reason. Two worktrees of one repository have
 * different toplevels and the same remote; two clones of one repository
 * have different toplevels and the same remote as well. Only the toplevel
 * separates "the tree the run was handed" from "another tree of the same
 * project", and that distinction is the whole of failure 2's quiet half.
 */
export function launchBaseReading(cwd: string, projectRoot: string): LaunchBaseReading {
  // RAW for probing, REDACTED for reporting, and the two are never mixed
  // up: `git -C` must receive the real path, and a redacted one would send
  // the probe to a directory that does not exist — which resolves to
  // CWD_NOT_A_REPO and reads exactly like the finding this module exists
  // to report. Everything returned is built from `here`; everything handed
  // to git comes from `raw`.
  const raw = { cwd: String(cwd ?? ""), projectRoot: String(projectRoot ?? "") };
  // Redacted ON THE READING, not at each call site. `check-launch-base.ts`
  // serialises the whole object, and a caller that had to remember to
  // redact is a control one caller will forget.
  const here = { cwd: redactRemote(raw.cwd), projectRoot: redactRemote(raw.projectRoot) };

  if (!raw.projectRoot.trim()) {
    return {
      ...here,
      reading: "UNMEASURED",
      refusal:
        "no projectRoot was given, so there is nothing for the launching session's working directory to be " +
        "compared against — a run that cannot state which tree it is for cannot check that it is in it",
    };
  }

  const rootTop = toplevel(raw.projectRoot);
  if (rootTop === null) {
    return {
      ...here,
      reading: "UNMEASURED",
      refusal:
        `projectRoot ${safe(here.projectRoot)} is not a git repository git can resolve. ` +
        "This is the run's own argument and not the launching session's working directory, so it is reported " +
        "as unmeasured rather than as the cwd problem this check exists for",
    };
  }

  const cwdTop = toplevel(raw.cwd);
  if (cwdTop === null) {
    // Failure 1, said about the right input. The runtime's own message for
    // this state names neither the directory nor the fact that it is the
    // SESSION's, and recommends VCS hook configuration that is irrelevant.
    return {
      ...here,
      reading: "CWD_NOT_A_REPO",
      refusal:
        `the launching session's working directory ${safe(here.cwd)} is not a git repository. ` +
        `projectRoot ${safe(here.projectRoot)} is one, and is correct — but agent worktrees ` +
        "are cut by the runtime from the SESSION's directory, not from projectRoot, so this run " +
        "would die at the first isolated spawn. This is not a VCS-configuration problem and " +
        "WorktreeCreate hooks will not fix it: cd into projectRoot and relaunch",
    };
  }

  if (cwdTop === rootTop) return { ...here, reading: "SAME_CHECKOUT" };

  // Different trees. Which KIND of different decides what the operator does
  // next, so the two are never collapsed.
  const cwdRemote = readWorktreeRemote(cwdTop);
  const rootRemote = readWorktreeRemote(rootTop);
  const cwdSlug = repoSlug(cwdRemote.url);
  const rootSlug = repoSlug(rootRemote.url);

  if (cwdSlug === null || rootSlug === null) {
    // A tree with no resolvable origin is not a tree we can clear. Refusing
    // rather than passing: the guard must not go inert for exactly the
    // misconfigured checkout most likely to need it (#218's reasoning).
    return {
      ...here,
      reading: "UNMEASURED",
      refusal:
        `the launching session's working directory ${safe(cwdTop)} and projectRoot ` +
        `${safe(rootTop)} are different trees, and at least one of them has no origin ` +
        `remote this can resolve (cwd: ${cwdSlug ?? redactRemote(String(cwdRemote.error ?? cwdRemote.url))}, ` +
        `projectRoot: ${rootSlug ?? redactRemote(String(rootRemote.error ?? rootRemote.url))}). ` +
        "Whether they are the same project is therefore unknown, and unknown is not clean",
    };
  }

  if (cwdSlug !== rootSlug) {
    return {
      ...here,
      reading: "DIFFERENT_REPO",
      refusal:
        `the launching session's working directory ${safe(cwdTop)} is a checkout of ${cwdSlug}, but ` +
        `this run targets ${rootSlug} at ${safe(rootTop)}. Agent worktrees are cut by the ` +
        "runtime from the SESSION's directory, so this run would do its work in the wrong repository " +
        "and succeed — which is how run wf_5e3ed885-98c put a remediation agent in a checkout of " +
        "one consumer's repository while working an issue in another (#218). cd into projectRoot and relaunch",
    };
  }

  // Same project, different working tree. The quiet one: nothing fails, and
  // the run lands on whatever branch that tree happens to be parked on.
  const cwdBranch = branchOf(cwdTop);
  const rootBranch = branchOf(rootTop);
  return {
    ...here,
    reading: "DIFFERENT_CHECKOUT",
    refusal:
      `the launching session's working directory ${safe(cwdTop)} and projectRoot ` +
      `${safe(rootTop)} are two different working trees of the same repository ` +
      `(${rootSlug}) — cwd is on ${cwdBranch ?? "an unreadable branch"} and projectRoot is on ` +
      `${rootBranch ?? "an unreadable branch"}. Agent worktrees are cut by the runtime from the ` +
      "SESSION's directory, so this run would cut from a tree it was not handed, and nothing would " +
      "fail. A shared primary parked on another issue's run branch is exactly this state (#640). " +
      "cd into projectRoot and relaunch",
  };
}

/**
 * The refusal string for a launch, or `null` when there is nothing to say.
 *
 * Derived from `launchBaseReading` and never from a second probe, so the
 * boolean and the reading cannot disagree. `SAME_CHECKOUT` is the only
 * reading that clears: UNMEASURED refuses with the rest, because a check
 * that could not be run is not a check that passed.
 */
export function launchBaseRefusal(cwd: string, projectRoot: string): string | null {
  const reading = launchBaseReading(cwd, projectRoot);
  return reading.reading === "SAME_CHECKOUT" ? null : reading.refusal;
}
