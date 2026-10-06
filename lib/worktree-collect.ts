/**
 * Collect the output of N parallel agents, each working in its own worktree,
 * into one tree that can be staged and committed (#81).
 *
 * `workflows/ship.js` flattened every agent's `filesChanged` into a single list
 * and then kept only the LAST agent's `worktreePath`. `relativizePaths` only
 * tries `[commitDir, PROJECT_ROOT]`, so paths belonging to the other N-1
 * worktrees stayed absolute and `buildSafeGitAdd` rejected them — correctly, it
 * refuses absolute paths. Eleven agents produced 37 minutes of valid work on
 * run wf_5e32e9d4-dd2 and none of it could be committed.
 *
 * The losing information was the pairing: which files came from which worktree.
 * Keep that, and collection is straightforward.
 *
 * Copying rather than merging branches is deliberate. The parallel path is only
 * taken when the sub-issues have NON-OVERLAPPING file sets (ship.js falls back
 * to a single sequential agent otherwise), so no two worktrees can claim the
 * same file and there is nothing for a merge to resolve. A copy also leaves the
 * agents' worktrees untouched, which matters when one sibling fails and the
 * others' work has to survive.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

export interface AgentBuildResult {
  worktreePath?: string;
  filesChanged?: string[];
}

export interface WorktreeGroup {
  worktreePath: string;
  /** Paths relative to `worktreePath`. */
  files: string[];
}

export interface CollectResult {
  /** Paths relative to the project root — safe to hand to buildSafeGitAdd. */
  copied: string[];
  /** Absolute source paths an agent claimed to have written that do not exist. */
  missing: string[];
}

/**
 * True when `child` is at or beneath `parent`, comparing LEXICALLY.
 *
 * Used only to reject obviously-escaping paths before touching the disk.
 * Lexical containment alone is not a security boundary: `resolve` and
 * `relative` never consult the filesystem, so `wt/lib/a.ts` is "inside" the
 * worktree by string even when `wt/lib` is a symlink to somewhere else
 * entirely. `realIsInside` is the check that actually decides.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when `child`'s REAL path is at or beneath `parent`'s real path.
 *
 * `child` may not exist yet (a destination), so walk up to the deepest
 * ancestor that does, resolve that, and re-attach the remainder. This is what
 * catches a symlinked intermediate directory, which lexical comparison cannot.
 */
function realIsInside(parent: string, child: string): boolean {
  let realParent: string;
  try {
    realParent = realpathSync(resolve(parent));
  } catch {
    return false;
  }

  let probe = resolve(child);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return false; // walked to the filesystem root
    tail.unshift(relative(up, probe));
    probe = up;
  }

  let realChild: string;
  try {
    realChild = join(realpathSync(probe), ...tail);
  } catch {
    return false;
  }

  const rel = relative(realParent, realChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Pair each agent's reported files with the worktree it reported them from,
 * converting to worktree-relative paths and discarding anything that escapes.
 *
 * An agent naming a file outside its own worktree is either confused or
 * hostile. Either way, copying it would write somewhere nobody authorised, so
 * it is dropped here rather than being handed to the copy step.
 */
export function groupFilesByWorktree(results: AgentBuildResult[]): WorktreeGroup[] {
  const groups: WorktreeGroup[] = [];

  for (const r of results || []) {
    const wt = (r?.worktreePath || "").trim();
    // No worktree means nothing can be resolved against it. Silently keeping
    // the files would reintroduce the absolute paths that caused #81.
    if (!wt) continue;

    const files: string[] = [];
    for (const raw of r.filesChanged || []) {
      const p = String(raw).trim();
      if (!p) continue;
      const abs = isAbsolute(p) ? p : join(wt, p);
      if (!isInside(wt, abs)) continue;
      const rel = relative(wt, abs);
      if (rel) files.push(rel);
    }
    if (files.length > 0) groups.push({ worktreePath: wt, files });
  }

  return groups;
}

/**
 * Copy each group's files from its worktree into `projectRoot`.
 *
 * Throws rather than skipping when a destination would land outside
 * `projectRoot`. A traversal here is not a path to sanitise away quietly — it
 * means the inputs cannot be trusted, and the caller must abort the commit
 * rather than proceed with a partially-collected tree.
 */
export function collectWorktreeFiles(
  groups: WorktreeGroup[],
  projectRoot: string,
  allowedWorktrees: string[],
): CollectResult {
  const copied: string[] = [];
  const missing: string[] = [];

  // `allowedWorktrees` is required, and an empty list authorises nothing.
  // Making it optional with an "allow anything" default would restore exactly
  // the hole it exists to close, in the quietest possible way.
  const allowed = new Set<string>();
  for (const w of allowedWorktrees || []) {
    try {
      allowed.add(realpathSync(resolve(w)));
    } catch {
      // A worktree the caller named but that does not exist authorises nothing.
    }
  }

  for (const group of groups) {
    // Every other check in this function validates a path against
    // `group.worktreePath`. That value arrives from `agentResults` and is
    // agent-reported, so until it is checked the containment root is chosen by
    // the same party the checks defend against: `worktreePath: "/"` makes every
    // file on the machine "inside the worktree". The destination stays within
    // the project root, so the payload is not a write outside — it is a read of
    // anything on disk INTO the repo, which the caller then stages, commits and
    // pushes. Authorise the root against the caller's list before trusting it.
    let realWorktree: string;
    try {
      realWorktree = realpathSync(resolve(group.worktreePath));
    } catch {
      throw new Error(`refusing an unresolvable worktree path: ${group.worktreePath}`);
    }
    if (!allowed.has(realWorktree)) {
      throw new Error(`refusing a worktree the caller did not authorise: ${group.worktreePath}`);
    }

    for (const rel of group.files) {
      const dest = resolve(projectRoot, rel);
      if (!isInside(projectRoot, dest)) {
        throw new Error(`refusing to write outside the project root: ${rel}`);
      }

      const src = resolve(group.worktreePath, rel);

      // lstat, not stat: it describes the link itself rather than its target.
      // copyFileSync FOLLOWS links, so a source symlink would copy a file the
      // agent was never given — lexical containment cannot see that, because
      // the path sits inside the worktree by string.
      const st = lstatSync(src, { throwIfNoEntry: false });
      if (!st) {
        missing.push(src);
        continue;
      }
      if (st.isSymbolicLink()) {
        throw new Error(`refusing to collect a symlink: ${rel}`);
      }
      if (!st.isFile()) {
        missing.push(src);
        continue;
      }
      // A hard link defeats every check above: lstat reports a regular file and
      // the path genuinely is inside the worktree, because a hard link has no
      // target path to resolve — it is a second name for the same inode. Only
      // the link count gives it away. Source files written by an agent have
      // one name; anything else is reaching for a file it was not given.
      if (st.nlink > 1) {
        throw new Error(`refusing to collect a hard link: ${rel}`);
      }
      // Catches a symlinked intermediate directory (`wt/lib` -> elsewhere),
      // which the lstat above cannot see because the leaf is a real file.
      if (!realIsInside(group.worktreePath, src)) {
        throw new Error(`refusing to read outside the worktree: ${rel}`);
      }

      // Same path on both sides: the agent worked directly in the project root
      // (the single-agent path). copyFileSync onto itself would truncate.
      if (src !== dest) {
        // Check BEFORE creating anything. `mkdirSync(recursive)` used to run
        // first, so a pre-existing symlink in the project root meant the
        // directories had already been created outside it by the time the
        // check threw — the refusal was correct and still left a side effect
        // where it had no business writing. realIsInside walks up to the
        // deepest existing ancestor, so it answers correctly for a path that
        // does not exist yet.
        if (!realIsInside(projectRoot, dirname(dest))) {
          throw new Error(`destination directory escapes the project root: ${rel}`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        // And again after: mkdir resolved and created real directories, but a
        // symlinked component could have been introduced between the two.
        if (!realIsInside(projectRoot, dirname(dest))) {
          throw new Error(`destination directory escapes the project root: ${rel}`);
        }
        // The leaf can be a symlink even when its directory is clean, and
        // copyFileSync writes THROUGH a link to whatever it targets. Checking
        // the directory alone would still let a planted link in the project
        // root overwrite a file outside it.
        const dst = lstatSync(dest, { throwIfNoEntry: false });
        if (dst?.isSymbolicLink()) {
          throw new Error(`refusing to overwrite a symlink in the project root: ${rel}`);
        }
        if (dst && !dst.isFile()) {
          throw new Error(`refusing to overwrite a non-regular file: ${rel}`);
        }
        // Same inode trick on the destination side: copyFileSync writes
        // through a hard link into whatever else shares the inode.
        if (dst && dst.nlink > 1) {
          throw new Error(`refusing to overwrite a hard link: ${rel}`);
        }
        copyFileSync(src, dest);
      }
      copied.push(relative(projectRoot, dest));
    }
  }

  return { copied: [...new Set(copied)], missing };
}
