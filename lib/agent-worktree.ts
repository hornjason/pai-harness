/**
 * Which directory `CommitEnforcement` is allowed to run `git` in (#1001).
 *
 * ## The defect
 *
 * The hook found its subject by matching `payload.tool_response` against a
 * case-insensitive pattern for "a slash, any non-space run, `worktrees/`,
 * `agent-<hex>`, any non-space run". (Written out rather than quoted: the
 * pattern ends in a sequence that closes a block comment, which is its own
 * small lesson.)
 *
 * That text is the subagent's own reply — agent-authored, and reachable by
 * anything able to influence what an agent writes. **A regex match is not a
 * confinement.** `/tmp/worktrees/agent-dead/../../anywhere` matches it, and
 * so does any path whose middle happens to contain `worktrees/agent-<hex>`.
 * The hook then ran `git -C <that>` twice.
 *
 * Two things follow from `git -C <attacker-chosen directory>`, and the
 * argv conversion in #971/#999 addresses neither:
 *
 * 1. **git executes that repository's config.** `core.fsmonitor`,
 *    `core.hooksPath` and `core.pager` are all commands git runs. See
 *    `lib/git-isolation.ts`, which is the other half of this fix.
 * 2. The reading comes back as a tripwire signal about the wrong tree.
 *
 * ## The base is not a new list
 *
 * `agentWorktreesBase` is the directory the hook's own fallback branch
 * already constructed inline — `$HOME/.claude/.claude/worktrees`. Promoting
 * that one spelling to a named export and pointing BOTH branches at it is a
 * consolidation: before this, the regex branch was confined by nothing and
 * the fallback branch was confined by a string literal next to it. There was
 * no second position to delegate to, and this does not create one.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **A hostile repository legitimately inside the base.** Confinement says
 *   WHERE, not WHOSE. `lib/git-isolation.ts` is what makes running `git`
 *   there survivable.
 * - **`$HOME` itself being wrong.** If `HOME` is attacker-controlled the base
 *   is too; that is a larger problem than this hook.
 * - **A race between the check and the `git` call.** The path is resolved
 *   once; a symlink swapped in afterwards is not detected.
 *
 * Issue: #1001. Refs #971, #999, #960.
 */

import { realpathSync } from "fs";
import { join, sep } from "path";

/**
 * Where agent worktrees live.
 *
 * `env` is a parameter so a case can drive this against a `mkdtemp` instead
 * of the machine's real home.
 */
export function agentWorktreesBase(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? "", ".claude", ".claude", "worktrees");
}

/**
 * `candidate` resolved and required to be inside `base`, or `null`.
 *
 * `realpathSync` on BOTH sides, for the reason #1001's sibling half ran into:
 * a prefix test between a resolved and an unresolved path disagrees through
 * any symlink, and on macOS `/var` is itself one. Resolving the candidate is
 * also what defeats `..` — `/base/agent-x/../../etc` resolves to `/etc` and
 * then fails the prefix, which it would pass as a string.
 *
 * The prefix comparison appends a separator so that a sibling directory
 * named like the base plus a suffix — `…/worktrees-evil` against a base of
 * `…/worktrees` — is not read as being inside it.
 */
export function confinedWorktreePath(
  candidate: string,
  base: string = agentWorktreesBase(),
): string | null {
  let resolvedBase: string;
  try {
    resolvedBase = realpathSync(base);
  } catch {
    // No base means nothing can be inside it, so this refusal is ALREADY
    // IMPLIED by the prefix test below — if the base will not resolve, no
    // candidate under it will either. Measured: replacing this branch with
    // a fall-through to the unresolved path reddens 0 of 16 arms, and no
    // input distinguishes the two. Kept so a reader does not have to
    // re-derive that, and recorded in `test/git-isolation.test.ts` AC-W7
    // rather than left looking like coverage.
    return null;
  }

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return null;
  }

  if (resolved === resolvedBase) return null; // the base is not a worktree
  if (!resolved.startsWith(resolvedBase + sep)) return null;
  return resolved;
}
