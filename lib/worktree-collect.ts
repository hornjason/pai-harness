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

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
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
/**
 * Remove a trailing parenthesised annotation from a reported path (#279).
 *
 * Agents describe what they did to a file as they list it:
 *
 *     "lib/strip-js-comments.ts (NEW, 178 lines)"
 *     "test/spec-compliance.test.ts (MOD: +SHIP_CODE at L8-28)"
 *
 * Only a trailing ` (...)` is an annotation. Splitting on the first space
 * instead would mangle `docs/my notes.md` into a miss, which trades a silent
 * drop for a silent rejection — the same bug facing the other way.
 */
export function stripPathAnnotation(entry: string): string {
  const m = entry.match(/^(.*?)\s+\([^()]*\)$/);
  return m ? m[1] : entry;
}

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
 * One write this call made, and what undoing it means (#750).
 *
 * Recorded BEFORE the write, not after. A `copyFileSync` that throws partway
 * has already truncated the destination, so an entry appended afterwards
 * would never exist for exactly the write that needs undoing most.
 */
type CollectUndo =
  /** The destination did not exist: undoing it means REMOVING, not restoring. */
  | { kind: "created-file"; dest: string }
  /** The destination existed: its bytes and timestamps are held aside. */
  | { kind: "overwritten-file"; dest: string; backup: string; atime: Date; mtime: Date }
  /** The topmost directory `mkdirSync(recursive)` created for a destination. */
  | { kind: "created-dir"; dir: string };

/**
 * Where a rollback holds the previous bytes of a destination it overwrote.
 *
 * **Outside the project root, and exported so that is checkable.** A backup
 * staged inside the tree being collected into is a file the caller stages,
 * commits and pushes the moment the cleanup that removes it does not run.
 * Inlining `mkdtempSync` at the one call site made that property true and
 * unobservable: the directory is removed on the success path and on the
 * failure path, so every post-call assertion reads the same either way —
 * measured as battery row M8, **0 red**, which is what a vacuous case looks
 * like from the outside. One binding, so there is one thing to mutate.
 */
export function collectBackupRoot(): string {
  return mkdtempSync(join(tmpdir(), "rungate-collect-undo-"));
}

/** Raised when the copy failed AND putting the tree back also failed. */
export class CollectRollbackError extends Error {
  constructor(
    readonly cause: unknown,
    readonly rollbackFailures: string[],
  ) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)}\n` +
        `AND the project root could NOT be put back: ${rollbackFailures.join("; ")}. ` +
        `The tree is in an unknown state — do not stage or commit it.`,
    );
    this.name = "CollectRollbackError";
  }
}

/**
 * Copy each group's files from its worktree into `projectRoot`, atomically in
 * the only sense that matters here: **a throw leaves the project root as it
 * was.**
 *
 * Throws rather than skipping when a destination would land outside
 * `projectRoot`. A traversal here is not a path to sanitise away quietly — it
 * means the inputs cannot be trusted, and the caller must abort the commit
 * rather than proceed with a partially-collected tree.
 *
 * ## Why a journal, and not the two cheaper designs (#750)
 *
 * Eleven throw sites sit between the group loop and the `copyFileSync`. Any
 * that fires after the first successful copy used to leave copied files in
 * the project root with nothing putting them back, and `workflows/ship.js`
 * then reported a failed collect over a half-written tree.
 *
 * #750 offered three designs and asked for one with a reason.
 *
 * - **Validate every file before copying anything** is the issue's own named
 *   cheapest wrong fix, and it is wrong for a reason that survives careful
 *   implementation: every one of these checks is an `lstat` of a path the
 *   AGENT controls. Answering at T1 and copying at T2 lets the answer change
 *   in between, and the property asked for is about the resulting tree, not
 *   about the order the checks run in.
 * - **Stage into a temp directory and move into place in one pass** narrows
 *   the window without closing it: N renames are N operations, and a throw
 *   during the Nth leaves N−1 done. It also degrades silently when the
 *   staging directory is on another filesystem, where `renameSync` raises
 *   `EXDEV` and the "one atomic move" becomes a copy again.
 * - **A journal** — this one — delivers the property for a throw from
 *   ANYWHERE, including one this function did not generate: an `ENOSPC` from
 *   `copyFileSync`, an `EACCES` from `mkdirSync`, a race that no amount of
 *   pre-validation can see.
 *
 * ## Undoing can itself fail, and that is a different state
 *
 * A rollback that cannot complete leaves a tree nobody has validated, which
 * is worse than the original failure and must not be reported as it. It
 * raises `CollectRollbackError` carrying both the original cause and every
 * undo that failed. Swallowing them would make a half-restored tree
 * indistinguishable from a clean refusal — `0`, `{}` and silence are
 * indistinguishable from success (`.claude/rules/config-access.md`).
 */
export function collectWorktreeFiles(
  groups: WorktreeGroup[],
  projectRoot: string,
  allowedWorktrees: string[],
): CollectResult {
  const copied: string[] = [];
  const missing: string[] = [];

  /** Every write this call has made, oldest first. Undone in reverse. */
  const journal: CollectUndo[] = [];
  /** Created on the first OVERWRITE, so a run that overwrites nothing makes none. */
  let backupDir: string | null = null;

  const backupOf = (dest: string): string => {
    backupDir ??= collectBackupRoot();
    const slot = join(backupDir, String(journal.length));
    copyFileSync(dest, slot);
    return slot;
  };

  const undoAll = (): string[] => {
    const failures: string[] = [];
    // Reverse order, so a file created inside a directory this call also
    // created is removed before the directory is.
    for (const entry of [...journal].reverse()) {
      try {
        if (entry.kind === "created-file") {
          rmSync(entry.dest, { force: true });
        } else if (entry.kind === "overwritten-file") {
          copyFileSync(entry.backup, entry.dest);
          // Bytes alone are not "as it was" for anything keyed on mtime — a
          // build cache, a watcher, `make`. Restored from the stat taken
          // before the overwrite.
          utimesSync(entry.dest, entry.atime, entry.mtime);
        } else {
          // Recursive is safe here and only here: `mkdirSync(recursive)`
          // returns a path only when it CREATED it, so everything beneath
          // this directory was created by this call, and the files among
          // them have already been removed by the entries above.
          rmSync(entry.dir, { recursive: true, force: true });
        }
      } catch (e) {
        failures.push(`${entry.kind} ${"dest" in entry ? entry.dest : entry.dir}: ${String(e)}`);
      }
    }
    return failures;
  };

  try {
    collect();
  } catch (cause) {
    const failures = undoAll();
    cleanupBackups();
    throw failures.length > 0 ? new CollectRollbackError(cause, failures) : cause;
  }
  cleanupBackups();
  return { copied: [...new Set(copied)], missing };

  function cleanupBackups(): void {
    // Best effort, and genuinely best effort: a leftover temp directory is
    // litter, not a correctness problem, and raising from here would mask
    // the error being propagated.
    if (backupDir) {
      try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* litter only */ }
      backupDir = null;
    }
  }

  function collect(): void {
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

    for (const rawRel of group.files) {
      // #279: an agent may annotate the path it reports — run wf_ea3e428f-64f
      // wrote "lib/strip-js-comments.ts (NEW, 178 lines)" for all five of its
      // files, and joining that whole string onto the worktree missed every
      // one of them. 926 lines were dropped and the script exited zero.
      //
      // The literal entry is tried FIRST so a real path that happens to end in
      // parentheses keeps working, and a genuinely missing file stays missing
      // after stripping rather than becoming a second silent drop.
      const stripped = stripPathAnnotation(rawRel);
      const rel =
        stripped !== rawRel && !existsSync(resolve(group.worktreePath, rawRel))
          ? stripped
          : rawRel;

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
        // The return value is the TOPMOST directory it created, or undefined
        // when every component already existed. Journaling it is what makes
        // an empty directory tree not survive a refusal.
        const createdDir = mkdirSync(dirname(dest), { recursive: true });
        if (createdDir) journal.push({ kind: "created-dir", dir: createdDir });
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

        // Journal BEFORE the write. `copyFileSync` truncates the destination
        // before it finishes, so an entry appended after a successful copy
        // would be missing for precisely the case that needs it most — a
        // copy that threw partway and left a truncated file.
        journal.push(
          dst
            ? {
                kind: "overwritten-file",
                dest,
                backup: backupOf(dest),
                atime: dst.atime,
                mtime: dst.mtime,
              }
            : { kind: "created-file", dest },
        );
        copyFileSync(src, dest);
      }
      copied.push(relative(projectRoot, dest));
    }
  }
  }
}
