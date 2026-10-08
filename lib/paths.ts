import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";

/**
 * Every refusal in this file routes through `refuse()`, and `refuse()` is the
 * only reader of this constant, which appears exactly once. `test/harness-root.test.ts`
 * builds a mutant copy of this module with it set to `0` and asserts the mutant
 * does NOT refuse on inputs the real module rejects — the positive control
 * required by .claude/rules/checks-must-be-able-to-fail.md. Inlining a `throw`
 * anywhere below would bypass that control, so don't.
 */
export const REFUSE_IMPLICIT_ROOT = 1;

function refuse(message: string): void {
  if (REFUSE_IMPLICIT_ROOT) throw new Error(message);
}

/** `file:line` of the frame that called into this module, for refusal messages. */
function callSite(): string {
  const frames = (new Error().stack || "").split("\n").slice(1);
  for (const f of frames) {
    if (f.includes("lib/paths.ts")) continue;
    const m = f.match(/\(?([^()\s]+:\d+:\d+)\)?\s*$/);
    if (m) return m[1];
  }
  return "unknown caller";
}

const FIXES =
  "Either set HARNESS_ROOT to the root of the run, " +
  "or pass the root you mean explicitly: harnessRootFor(root).";

/**
 * The harness root the CALLER means, stated rather than inferred (#105).
 *
 * Use this from anything that is about to EXECUTE or WRITE — `gate-executor`
 * spawning `bun scripts/sync-spec-tests.ts`, which regenerates files in the
 * tree it is pointed at. For those, "whichever tree this module happens to sit
 * in" is not a default, it is a coin flip between the run's root and the
 * worktree the agent is editing, and the losing side gets written to.
 */
export function harnessRootFor(root: string): string {
  if (!root || !root.trim()) {
    throw new Error(
      `harnessRootFor() was given an empty root at ${callSite()}. ` +
        "An explicit root is the caller naming the tree it means; there is no tree to fall back to.",
    );
  }
  return resolve(root);
}

export interface ImplicitRootOptions {
  /** Overrides the inferred `file:line` in refusal messages. */
  caller?: string;
  /**
   * Set by callers whose resolved root will serve reads of harness-owned
   * STATIC files — briefs, rules, templates, specs, generated tests.
   *
   * A dirty implicit root is refused for these. That combination is the exact
   * failure this module exists to stop: nobody said which tree to use, the tree
   * guessed has uncommitted edits, so the file being READ and the file under
   * TEST are two different versions of the same path — and the read succeeds,
   * which is why it was never visible.
   */
  staticReads?: boolean;
}

function isDirty(root: string): boolean {
  const r = spawnSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  // Not a repo, or git unavailable: nothing to disagree about, so not dirty.
  if (r.status !== 0) return false;
  return (r.stdout || "").trim().length > 0;
}

/**
 * The harness root inferred from the environment.
 *
 * Resolution order, with no fourth step on purpose: `HARNESS_ROOT`, then the
 * tree this module sits in if it carries the `HARNESS.md` marker, then a
 * refusal. The deleted fourth step was `join(process.env.HOME, ".claude")` —
 * a path that almost always exists, so a misconfigured run, an agent in a
 * worktree and a correct run all read happily from it and only one of them was
 * reading the tree under test. A refusal names the call site; a successful read
 * from the wrong tree names nothing.
 */
export function harnessRoot(opts: ImplicitRootOptions = {}): string {
  if (process.env.HARNESS_ROOT) return process.env.HARNESS_ROOT;
  const caller = opts.caller || callSite();
  const repoRoot = resolve(import.meta.dir, "..");

  if (!existsSync(join(repoRoot, "HARNESS.md"))) {
    refuse(
      `harnessRoot() cannot tell which harness tree ${caller} means: ` +
        `HARNESS_ROOT is unset and ${repoRoot} carries no HARNESS.md marker. ${FIXES}`,
    );
    return repoRoot; // unreachable unless the refusal has been mutated out
  }

  if (opts.staticReads && isDirty(repoRoot)) {
    refuse(
      `harnessRoot() refuses to serve reads of harness-owned files to ${caller} ` +
        `from ${repoRoot}: no root was given, and the tree it guessed has uncommitted ` +
        `changes — so the file read and the file under test are different versions. ${FIXES}`,
    );
  }

  return repoRoot;
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

/**
 * `~/.claude`, named rather than spelled inline (#105).
 *
 * This directory is PAI's actual install location, so for `paiRoot()` it is the
 * right answer. It was ALSO the last line of `harnessRoot()`, where it was the
 * wrong answer — and the two were the same anonymous expression, which is how a
 * harness read ended up pointed at PAI's tree with nothing in the output saying
 * so. Giving the concept one name and one caller makes that confusion a visible
 * edit instead of a copied line.
 */
function paiHomeDir(): string {
  // `homedir()` rather than `process.env.HOME || ""`: the old spelling degraded
  // to the RELATIVE path ".claude" when HOME was unset, which resolves against
  // the cwd — another way to read a plausible directory that is not the one
  // meant. It still honours $HOME, which is what the paiRoot probe asserts.
  return join(homedir(), ".claude");
}

export function paiRoot(): string {
  return process.env.PAI_ROOT || paiHomeDir();
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
