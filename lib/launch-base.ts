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
import { resolve } from "path";

import { canonicalRoot } from "./paths";
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
   * A root is reached through a symlink, so it has two spellings (#1129).
   *
   * This reading exists because its absence was the gap. `--show-toplevel`
   * RESOLVES symlinks, so both spellings of one directory produce one
   * answer and the comparison below reads `SAME_CHECKOUT` — the one gate
   * that sees both the session and the root is structurally blind to the
   * difference, and then hands the unresolved string onward to a workflow
   * that can only compare strings. "The roots are canonical" and "the roots
   * are two spellings that happen to resolve alike" were indistinguishable
   * in this output; they no longer are.
   */
  | { reading: "NON_CANONICAL_ROOT"; cwd: string; projectRoot: string; refusal: string }
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

/**
 * `git -C <dir> rev-parse --abbrev-ref HEAD`, or `null`.
 *
 * Exported since #1595 so the filing chokepoint names the branch a comment
 * should go on through this binding rather than a second `rev-parse` of its
 * own. `HEAD` — a detached checkout — is a real answer here and is filtered
 * by the caller that cares, because "which branch" and "is this a branch"
 * are different questions and only one of them belongs in a git wrapper.
 */
export function branchOf(dir: string): string | null {
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
/**
 * The roots that are not their own canonical spelling, as a reading (#1129).
 *
 * Returns `null` when every root given resolves to itself — which is the
 * only state the rest of `launchBaseReading` can reason about, because
 * every comparison downstream of it is between strings.
 *
 * `harnessRoot` is optional and skipped when absent rather than treated as
 * canonical. `harnessRootFor()` in `lib/paths.ts` canonicalises the roots it
 * produces, but it is not the only producer — a hand-typed `--harness-root`
 * never goes through it, which is why this takes the value rather than
 * trusting the producer.
 *
 * An unresolvable root is UNMEASURED and refuses. It is deliberately NOT
 * folded into NON_CANONICAL_ROOT: "this root has two names" is fixed by
 * relaunching with the other one, and "this root does not exist" is not, so
 * collapsing them would hand the operator a remedy that cannot work.
 */
function nonCanonicalRoots(roots: {
  projectRoot: string;
  harnessRoot?: string;
}): { reading: "NON_CANONICAL_ROOT" | "UNMEASURED"; refusal: string } | null {
  for (const [name, given] of Object.entries(roots)) {
    if (typeof given !== "string" || !given.trim()) continue;
    let canonical: string;
    try {
      canonical = canonicalRoot(given);
    } catch (e: any) {
      return {
        reading: "UNMEASURED",
        refusal:
          `${name} ${safe(given)} cannot be resolved to a real path (${redactRemote(String(e?.message || e))}). ` +
          "Whether this run's containment checks would agree with the paths git reports is therefore " +
          "unknown, and unknown is not canonical — it is refused rather than passed through unresolved (#1129)",
      };
    }
    if (canonical === given) continue;

    // TWO conditions, and they are reported apart because only one of them
    // is about symlinks. Comparing `canonical` straight back against the raw
    // string folds them together, and then a root spelled `…/rungate/` is
    // refused with "which is a symlink to …/rungate" — a false statement
    // about the operator's disk, offering as a remedy the path they just
    // typed with one character removed. Found by the AI review of PR #1150.
    //
    // Both still refuse. A non-normalised root breaks the comparison in
    // ship.js just as surely: it builds `${root}/.claude/worktrees/` and a
    // trailing slash makes that a doubled separator no git-reported path
    // matches. The verdict is the same; the sentence is not.
    const normalised = resolve(given);
    const why =
      canonical !== normalised
        ? `it is a symlink to ${safe(canonical)} — one directory under two names`
        : `it is not a normalised path; it names ${safe(canonical)} with redundant or relative segments`;

    return {
      reading: "NON_CANONICAL_ROOT",
      refusal:
        `${name} was given as ${safe(given)}, and ${why}. ` +
        "`git rev-parse --show-toplevel` resolves symlinks and every path git reports is canonical, " +
        "but `collectDestination` in workflows/ship.js compares roots as STRINGS and cannot resolve " +
        "anything: the sandbox has no filesystem (#69). So this run would refuse its own agent " +
        `worktrees, and the refusal would read as "this directory is not yours". Relaunch with ` +
        `${name} set to ${safe(canonical)}`,
    };
  }
  return null;
}

export function launchBaseReading(
  cwd: string,
  projectRoot: string,
  harnessRoot?: string,
): LaunchBaseReading {
  // RAW for probing, REDACTED for reporting, and the two are never mixed
  // up: `git -C` must receive the real path, and a redacted one would send
  // the probe to a directory that does not exist — which resolves to
  // CWD_NOT_A_REPO and reads exactly like the finding this module exists
  // to report. Everything returned is built from `here`; everything handed
  // to git comes from `raw`.
  const raw = {
    cwd: String(cwd ?? ""),
    projectRoot: String(projectRoot ?? ""),
    // Absent stays absent rather than becoming "": the canonicality check
    // skips a root it was not given, and an empty string would be
    // indistinguishable from a caller that passed one and got it wrong.
    harnessRoot: harnessRoot === undefined ? undefined : String(harnessRoot ?? ""),
  };
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

  if (cwdTop === rootTop) {
    // #1129 refines THIS answer and only this one, and the position is the
    // whole point. `--show-toplevel` resolves symlinks, so two spellings of
    // one directory arrive here as one toplevel and the comparison above
    // cannot tell them apart — the unresolved string then travels on to
    // `collectDestination`, which compares it by `startsWith` against paths
    // git has already resolved.
    //
    // It is NOT checked earlier. A symlinked root is the mildest thing that
    // can be wrong here: CWD_NOT_A_REPO, DIFFERENT_REPO and
    // DIFFERENT_CHECKOUT are all worse and all more urgent, and a
    // canonicality check placed above them MASKS them. Measured — on macOS
    // `tmpdir()` is `/var/folders/...`, itself a symlink to `/private/var`,
    // so every fixture built under it is non-canonical by accident: the
    // early placement turned 15 cases in this module's own suite into
    // NON_CANONICAL_ROOT, on macOS only, while Linux CI (`tmpdir()` is
    // `/tmp`, not a link) stayed green. A check that changes which defect
    // you are told about, per platform, is worse than the defect.
    const nonCanonical = nonCanonicalRoots({
      projectRoot: raw.projectRoot,
      harnessRoot: raw.harnessRoot,
    });
    if (nonCanonical) return { ...here, ...nonCanonical };
    return { ...here, reading: "SAME_CHECKOUT" };
  }

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
export function launchBaseRefusal(
  cwd: string,
  projectRoot: string,
  harnessRoot?: string,
): string | null {
  const reading = launchBaseReading(cwd, projectRoot, harnessRoot);
  return reading.reading === "SAME_CHECKOUT" ? null : reading.refusal;
}
