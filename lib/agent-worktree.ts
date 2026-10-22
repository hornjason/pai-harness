/**
 * Which directory `CommitEnforcement` is allowed to run `git` in (#1001).
 *
 * ## The defect this exists to close
 *
 * The hook found its subject by matching `payload.tool_response` against a
 * case-insensitive pattern for "a slash, any non-space run, `worktrees/`,
 * `agent-<hex>`, any non-space run". (Written out rather than quoted: the
 * pattern ends in a sequence that closes a block comment, which is its own
 * small lesson.)
 *
 * That text is the subagent's own reply — agent-authored, and reachable by
 * anything able to influence what an agent writes. **A regex match is not a
 * confinement.** The hook then ran `git -C <that>` twice, and `git` executes
 * the config of whatever repository it is pointed at.
 *
 * ## Why the first fix was wrong, measured
 *
 * PR #1024 confined the candidate to `$HOME/.claude/.claude/worktrees` — the
 * spelling the hook's own fallback branch already had inline. The doubled
 * `.claude` is not a typo; that directory exists. It is also **dead**:
 *
 * ```
 * registered worktrees under $HOME/.claude/.claude/worktrees  →    0
 * registered worktrees under <main>/.claude/worktrees         →  136
 * directory entries under $HOME/.claude/.claude/worktrees     →   16  (all stale)
 * ```
 *
 * Every live agent worktree on this machine is repo-local. Confining to the
 * other base does not merely fail to protect — combined with a fallback that
 * ran whenever confinement returned null, it **actively misattributed**: the
 * reply names a real repo-local worktree, confinement refuses it for being in
 * the wrong place, and the fallback then emits a tripwire signal naming the
 * most recently touched of sixteen stale directories. With several agents
 * running at once that is not a corner case. A check confined to a location
 * nothing uses is a check that cannot fail.
 *
 * ## The anchor: ask git, from a root the subject cannot choose
 *
 * A path list is the wrong shape for this question twice over — it has to be
 * kept in agreement with where worktrees actually get created, and it answers
 * "does this path look right" when the question is "is this a worktree of my
 * own repository". So the subject must appear in `git worktree list` for the
 * harness's own repo, resolved from `import.meta.dir` — this file's location,
 * which no agent reply can influence.
 *
 * **This repository already knew that.** `gitWorktreeBase` below is moved,
 * not written: #120 established "asking git removes the guess" for the
 * collection path, and `scripts/collect-worktree-files.ts` has derived the
 * base from `--git-common-dir` ever since. The hook guessed anyway, because
 * the knowledge lived in a script a hook could not import. That is the same
 * failure as #1001's own git-isolation half — *a lesson learned once and
 * propagated nowhere* — so the function moves here and the script re-exports
 * it rather than a second derivation being written.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A hostile repository that IS a registered worktree.** Registration says
 *   this tree belongs to my repo, not that its contents are safe.
 *   `lib/git-isolation.ts` is what makes running `git` there survivable.
 * - **A race between the check and the `git` call.** The path is resolved and
 *   matched once; a symlink swapped in afterwards is not detected. Closing
 *   that needs a file descriptor held across both, which `git -C` cannot take.
 * - **Worktrees of OTHER repositories.** Deliberately: the hook's subject is
 *   an agent of this harness.
 *
 * Issue: #1001. Refs #120, #971, #999, #960, PR #1024.
 */

import { execFileSync } from "child_process";
import { realpathSync, statSync } from "fs";
import { basename, join } from "path";
import { repoRootFrom } from "./paths";
import { recordHookFiring } from "./hook-evidence";
import { gitIsolatedArgs, gitIsolatedEnv } from "./git-isolation";

/** Agent worktree directory names, as `git worktree add` is asked for them. */
const AGENT_WORKTREE_NAME = /^agent-[a-f0-9]+$/i;

/**
 * Where git itself puts this repo's agent worktrees (#120).
 *
 * `git worktree add` run from inside a linked worktree resolves against the
 * COMMON dir, so agent worktrees land under the main checkout regardless of
 * which worktree the caller is in. No caller-supplied root controls that,
 * which is why a root-derived base only *happens* to work: it covers the
 * usual case where the caller is the main checkout, and fails silently
 * whenever it is not.
 *
 * Returns null rather than throwing. For `collect-worktree-files` this is an
 * additional base and losing it degrades to caller-supplied behaviour; the
 * failure is logged there, because a silent catch would turn "git is broken"
 * into "there is no such directory", which is the fail-open shape this
 * project keeps getting bitten by.
 */
export function gitWorktreeBase(projectRoot: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", projectRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    const msg = (e as Error).message || "";
    if (!/not a git repository/i.test(msg)) {
      console.error(`collect: WARNING could not ask git where worktrees live: ${msg.split("\n")[0]}`);
    }
    return null;
  }
  if (!commonDir) return null;

  // <main>/.git -> <main>. Anchored to a trailing path segment so a repo at
  // /srv/.github or a directory merely containing ".git" in its name is not
  // silently truncated. A bare repo (no trailing /.git) yields no match and
  // returns null — it has no working tree, so no agent worktrees either.
  const mainRepo = commonDir.replace(/\/\.git\/?$/, "");
  if (mainRepo === commonDir || mainRepo === "") return null;

  // Resolve before handing it out. Comparisons downstream are against
  // realpath'd worktree paths, and on macOS /tmp is a symlink to /private/tmp
  // — an unresolved base silently matches nothing.
  let resolved: string;
  try {
    resolved = realpathSync(mainRepo);
  } catch {
    return null;
  }
  return join(resolved, ".claude", "worktrees");
}

/**
 * The LINKED worktrees of `repoRoot`, realpath'd, or null if git could not be
 * asked.
 *
 * Null and `[]` are different answers and callers must treat them so: an
 * empty list means this repository genuinely has no linked worktrees, and a
 * null means the question was not answered. Collapsing them is how a refusal
 * turns into "nothing matched, carry on".
 *
 * The PRIMARY checkout is excluded. It is a worktree by git's reckoning, but
 * attributing a subagent's uncommitted work to the main tree — which on this
 * machine has carried staged work for weeks — would produce a signal about
 * the user's own edits on nearly every agent that runs. The test is whether
 * `.git` is a file rather than a directory, which is what actually
 * distinguishes a linked worktree, rather than a reliance on list ordering.
 */
export function registeredWorktrees(repoRoot: string): string[] | null {
  let out: string;
  try {
    out = execFileSync("git", gitIsolatedArgs(["-C", repoRoot, "worktree", "list", "--porcelain"]), {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitIsolatedEnv(),
    });
  } catch {
    return null;
  }

  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const raw = line.slice("worktree ".length).trim();
    if (!raw) continue;
    let resolved: string;
    try {
      resolved = realpathSync(raw);
    } catch {
      continue; // registered but gone from disk
    }
    try {
      if (!statSync(join(resolved, ".git")).isFile()) continue; // the primary checkout
    } catch {
      continue;
    }
    paths.push(resolved);
  }
  return paths;
}

/** The harness's own repository, located from this file rather than from input. */
export function harnessRepoRoot(): string | null {
  return repoRootFrom(import.meta.dir);
}

/**
 * `candidate` accepted only if it resolves to a registered linked worktree of
 * the harness's own repository; `null` otherwise.
 *
 * `realpathSync` on both sides. Resolving the candidate is what defeats `..`
 * and a symlink: `/base/agent-x/../../etc` resolves to `/etc` and then
 * matches nothing. Equality rather than a prefix test, because the subject of
 * the signal is the worktree, and because a prefix test is the thing that put
 * `…/worktrees-evil` inside `…/worktrees`.
 */
export function registeredWorktreePath(
  candidate: string,
  worktrees: readonly string[] | null,
): string | null {
  if (worktrees === null || worktrees.length === 0) return null;
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }
  return worktrees.includes(resolved) ? resolved : null;
}

/**
 * The subject of a worktree tripwire, resolved from an agent-authored reply.
 *
 * The whole decision in one place, because the ORDER is the security
 * property and splitting it across a hook is how the order gets lost:
 *
 *   1. a candidate named in the reply is accepted only if registered;
 *   2. **a named candidate that is refused ends here** — recorded, not
 *      replaced. PR #1024 fell through to step 3 instead, which is how a
 *      confinement became a signal naming a different agent's worktree;
 *   3. only a reply naming nothing at all reaches the scan.
 *
 * The pattern is a case-insensitive match for "a slash, any non-space run,
 * `worktrees/`, `agent-<hex>`, any non-space run" — spelled out rather than
 * quoted here because it ends in a sequence that closes a block comment.
 */
export function agentWorktreeSubject(
  respText: string,
  hook: string,
  detail: Record<string, unknown> = {},
  worktrees: readonly string[] | null = harnessWorktrees(),
): string | null {
  const pathMatch = respText.match(/(?:\/[^\s]*worktrees\/agent-[a-f0-9]+[^\s]*)/i);
  if (!pathMatch) return mostRecentAgentWorktree(worktrees);

  const subject = registeredWorktreePath(pathMatch[0], worktrees);
  if (subject === null) {
    recordHookFiring(hook, "declined-unregistered-worktree", {
      ...detail,
      candidate: pathMatch[0],
      registered: worktrees === null ? null : worktrees.length,
    });
  }
  return subject;
}

/**
 * The harness's own registered worktrees, or null if git could not be asked.
 *
 * The default argument of `agentWorktreeSubject`, separate so a case can
 * supply a fixture repository's list instead of this machine's. The DEFAULT
 * is the non-forgeable one, which is the property that matters; a parameter
 * that a caller must go out of its way to override is not an input an agent
 * reply can reach.
 */
export function harnessWorktrees(): string[] | null {
  const root = harnessRepoRoot();
  return root === null ? null : registeredWorktrees(root);
}

/**
 * The most recently modified registered worktree whose directory name is
 * `agent-<hex>`, or null.
 *
 * Only reached when the reply named NO candidate at all. A candidate that was
 * named and refused is a terminal refusal in `agentWorktreeSubject`: falling
 * back here is how a confinement becomes a misattribution.
 */
export function mostRecentAgentWorktree(worktrees: readonly string[] | null): string | null {
  if (worktrees === null) return null;
  let best: string | null = null;
  let bestMtime = -Infinity;
  for (const wt of worktrees) {
    if (!AGENT_WORKTREE_NAME.test(basename(wt))) continue;
    let mtime: number;
    try {
      mtime = statSync(wt).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = wt;
    }
  }
  return best;
}
