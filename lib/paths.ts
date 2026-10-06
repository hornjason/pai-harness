import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

export function harnessRoot(): string {
  if (process.env.HARNESS_ROOT) return process.env.HARNESS_ROOT;
  const repoRoot = resolve(import.meta.dir, "..");
  if (existsSync(join(repoRoot, "HARNESS.md"))) return repoRoot;
  return join(process.env.HOME || "", ".claude");
}

/**
 * The MAIN repository root containing `dir`, or null if `dir` is not in a repo
 * (#68).
 *
 * SessionStart hooks were calling `process.cwd()` and treating it as the
 * project root. A session opened in `~` therefore skipped worktree cleanup
 * entirely while still reporting "no stale files found", and sessions started
 * in `~/.claude` created a stray worktree tree at `~/.claude/.claude/worktrees`
 * with 16 entries in it. Cleanup ran or didn't based on where a terminal
 * happened to be.
 *
 * `--git-common-dir`, not `--show-toplevel`: from inside a LINKED WORKTREE,
 * `--show-toplevel` returns that worktree. `.claude/worktrees/` lives in the
 * main checkout, so resolving to the worktree would make cleanup look at a
 * directory that is never there — failing silently in the exact situation the
 * cleanup exists to handle. `--git-common-dir` always points at the main
 * repo's `.git`, from a worktree or not.
 */
export function repoRootFrom(dir: string): string | null {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (r.status !== 0) return null;
  const gitDir = r.stdout.trim();
  if (!gitDir) return null;
  // Relative when `dir` is already the repo root (".git"); absolute otherwise.
  const repo = dirname(resolve(dir, gitDir));
  // Always hand back a real path. Git returns an absolute, symlink-resolved
  // path from inside a worktree but a bare relative ".git" from the root, so
  // without this the same repo resolves to "/var/..." or "/private/var/..."
  // depending on which directory you asked from. Callers compare these to
  // decide whether to DELETE a worktree, so a string mismatch is not cosmetic.
  try {
    return realpathSync(repo);
  } catch {
    return repo;
  }
}

export function paiRoot(): string {
  return process.env.PAI_ROOT || join(process.env.HOME || "", ".claude");
}

export function workDir(slug: string): string {
  if (slug.includes('..') || slug.startsWith('/')) throw new Error(`Invalid slug: ${slug}`);
  const base = process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate");
  return join(base, slug);
}

export function gateSaltPath(): string {
  return join(harnessRoot(), "gates", ".gate-salt");
}

/**
 * Return the gate salt path, minting the salt if it does not exist yet.
 *
 * The salt is gitignored, so a fresh checkout has none. Creation used to live
 * inline in `generateHmac` (gates/orchestrator.ts), which made every other
 * reader depend on that one function having run first: `gates/adversarial.test.ts`
 * read the salt directly and threw ENOENT unless `gates/orchestrator.test.ts`
 * happened to execute earlier in the same run. Eight tests were passing on
 * readdir order, which is not alphabetical on ext4 — they would have flipped
 * red on an unrelated commit, and the diff would have explained nothing.
 *
 * Deliberately NOT used by `gates/witness.ts`: verification must fail when the
 * salt is missing rather than quietly mint a new one and validate against it.
 */
export function ensureGateSalt(): string {
  const path = gateSaltPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    // mode at creation: writeFileSync-then-chmod leaves the salt world-readable
    // for a moment, and a readable salt is a forgeable gate witness.
    writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  }
  // Re-assert the mode even when the file already existed: a salt readable by
  // other users is a forgeable gate witness.
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  return path;
}
