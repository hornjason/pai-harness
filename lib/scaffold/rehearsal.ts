/**
 * Audit by rehearsal (#398).
 *
 * `rungate scaffold <path>` without `--fix` called itself a preview and
 * reported `0 created, 0 replaced, 0 skipped, 0 refused` on a tree that
 * `--fix` then rewrote — 28 paths on this repo's own fixture, 16 on agentgrit.
 * The cause was structural rather than a missing branch: audit was four
 * `existsSync` checks and fix was twenty-five write steps, two bodies of code
 * sharing nothing. Two implementations of the same question can only agree by
 * someone keeping them in step by hand, and nobody was.
 *
 * `--fix` is the DESTRUCTIVE mode — #370 is `--fix` truncating
 * `.claude/rules/checks-must-be-able-to-fail.md` from 262 lines to 65 — so
 * audit is the one thing standing between a consumer and that damage. A
 * preview that under-reports is worse than no preview at all, because it
 * turns "I checked first" into false confidence.
 *
 * ## So audit does not predict what fix would do. It does it, somewhere else.
 *
 * Clone the tree, run the REAL steps against the clone, report what they say,
 * throw the clone away. The two modes then agree by construction rather than
 * by maintenance, and a step added later cannot forget its audit branch
 * because there is no audit branch to forget.
 *
 * On APFS `cp -Rc` is a copy-on-write clone — measured at 0.2s for this repo —
 * so the cost is bounded by metadata rather than by tree size. Where clonefile
 * is unsupported it falls back to a real copy, which is slower and still
 * correct; `rehearsalCloneCommand` reports which one ran so a slow audit is
 * explicable rather than mysterious.
 *
 * ## The two steps that must not be rehearsed
 *
 * A rehearsal is only safe while every step it runs stays inside the clone.
 * Two do not, and both would do real damage from a mode whose entire promise
 * is that it writes nothing:
 *
 * - `deployHooksToConsumers` resolves `consumer.startsWith("/")` and writes to
 *   absolute paths in OTHER repositories (`steps.ts:2222`). Rehearsing it
 *   would deploy hooks to every consumer on the machine during a preview.
 * - `postScaffoldCommit` creates a commit. In a clone whose `.git` is a file
 *   pointing back at the real repository — which is what a git worktree's is —
 *   that commit would land in the original.
 *
 * They are named here rather than skipped inline so the exclusion is one list
 * a test can read, and so each one carries the reason it is on it. An
 * exclusion without a stated reason is indistinguishable from an oversight,
 * and the next person to read it cannot tell whether removing it is safe.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync, lstatSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";

/**
 * Steps a rehearsal must not run, and why. Keys are the exported function
 * names in `lib/scaffold/steps.ts`; `test/scaffold-audit-agreement.test.ts`
 * asserts each one still exists, so a rename cannot silently empty this list
 * and re-enable the step.
 */
export const STEPS_NOT_REHEARSED: ReadonlyMap<string, string> = new Map([
  [
    "deployHooksToConsumers",
    "writes to absolute paths in other repositories, which a preview must never touch",
  ],
  [
    "postScaffoldCommit",
    "creates a commit, and a clone's .git may point back at the real repository",
  ],
]);

/** Directories never worth cloning: huge, regenerable, or another tree entirely. */
export const REHEARSAL_EXCLUDES: readonly string[] = [
  "node_modules",
  ".claude/worktrees",
];

export interface Rehearsal {
  /** The clone the steps ran against. Always inside the OS temp directory. */
  dir: string;
  /** The mkdtemp that owns `dir`. Tracked so cleanup never walks `..`. */
  parent: string;
  /** `clone` when copy-on-write was used, `copy` when it fell back. */
  method: "clone" | "copy";
}

/**
 * Symlinks in the clone whose target resolves outside it.
 *
 * **A rehearsal is only a rehearsal while every write lands in the copy, and
 * a symlink is a hole straight through the floor.** `cp -R` preserves
 * symlinks rather than following them, so a clone of a tree containing
 * `AGENTS.md -> /elsewhere/AGENTS.md` carries a link to the ORIGINAL file,
 * and the first step that writes `AGENTS.md` overwrites it. Reproduced
 * directly: write through a cloned symlink, read the original, see the new
 * bytes.
 *
 * That is #370's damage — scaffold destroying a real file — arriving through
 * the preview built to prevent it, and in the one mode whose entire promise
 * is that it writes nothing. Found by the commit security review.
 *
 * Reported rather than deleted. Removing the links would let the audit
 * proceed over a tree that is not the consumer's, so it would answer a
 * question nobody asked; `.claude/rules/config-access.md` is the governing
 * idea — a reading that cannot be taken safely is UNMEASURED, and UNMEASURED
 * is not SKIP.
 */
export function escapingSymlinks(dir: string): string[] {
  const root = realpathSync(dir);
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) {
        // realpath, not readlink: a relative link, a link to a link, and a
        // link through a symlinked parent all have to resolve to the same
        // answer, and only the resolved path can be compared to the root.
        let target: string;
        try { target = realpathSync(join(root, child)); } catch { target = resolve(root, child); }
        if (target !== root && !target.startsWith(root + sep)) out.push(child);
      } else if (e.isDirectory()) {
        walk(child);
      }
    }
  };
  walk("");
  return out.sort();
}

/**
 * Copy `root` somewhere disposable.
 *
 * `.git` is copied rather than skipped: five steps shell out to
 * `git -C <root>` for the origin URL, a file's last-commit date and
 * `status --porcelain`, and a clone with no repository would make those steps
 * take different branches than they will under `--fix` — which is the exact
 * disagreement this module exists to remove.
 */
export function cloneForRehearsal(root: string): Rehearsal {
  const parent = mkdtempSync(join(tmpdir(), "rungate-rehearsal-"));
  const dir = join(parent, "tree");
  const fail = (why: string): never => {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`audit did NOT run: ${why}`);
  };

  // `-c` asks for an APFS clonefile. It fails on filesystems that cannot do
  // it, so the fallback is explicit rather than a silent slow path.
  let method: Rehearsal["method"] = "clone";
  const cow = spawnSync("cp", ["-Rc", root, dir], { encoding: "utf-8", timeout: 300_000 });
  if (cow.status !== 0) {
    // A failed `cp` may have copied some of the tree first. Falling back on
    // top of that leaves a PARTIAL clone, and a partial clone is the whole
    // bug this module exists to fix — the steps would run over a tree
    // missing files, report less than `--fix` will do, and look like a
    // clean preview. Start from nothing. Found by the commit security
    // review.
    rmSync(dir, { recursive: true, force: true });
    const plain = spawnSync("cp", ["-R", root, dir], { encoding: "utf-8", timeout: 600_000 });
    if (plain.status !== 0) {
      return fail(`the tree could not be copied: ${plain.stderr?.trim() || "cp failed"}`);
    }
    method = "copy";
  }

  for (const rel of REHEARSAL_EXCLUDES) {
    const p = join(dir, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // The copy has to BE the tree, not most of it. Compared at the top level
  // only — a full walk would cost more than the clone did — which is enough
  // to catch a truncated copy that exited 0.
  const want = readdirSync(root).filter(n => !REHEARSAL_EXCLUDES.some(x => x.split("/")[0] === n));
  const got = new Set(readdirSync(dir));
  const missing = want.filter(n => !got.has(n));
  if (missing.length > 0) {
    return fail(`the copy is incomplete — ${missing.length} top-level entr(ies) missing: ${missing.slice(0, 5).join(", ")}`);
  }

  const escaping = escapingSymlinks(dir);
  if (escaping.length > 0) {
    return fail(
      `the tree contains ${escaping.length} symlink(s) pointing outside it, and a step writing through one ` +
      `would modify the real file rather than the copy — which is the damage a preview exists to prevent (#370). ` +
      `Offending paths: ${escaping.slice(0, 5).join(", ")}${escaping.length > 5 ? ", …" : ""}. ` +
      `Re-run with --fix if you intend those writes, or replace the symlinks with real files.`,
    );
  }

  return { dir, parent, method };
}

/** Throw the clone away. Safe to call twice. */
export function discardRehearsal(r: Rehearsal): void {
  // `r.parent`, not `join(r.dir, "..")`. Deriving a deletion target by
  // walking up from a path is how a cleanup ends up removing something it
  // does not own; the owner is recorded at creation instead. Leaving the
  // mkdtemp behind is the leak #437 is about, so it is the parent that goes.
  rmSync(r.parent, { recursive: true, force: true });
}

/**
 * The line audit prints so a reader knows the report was produced by running
 * the real thing, not by predicting it — and knows what it did not run.
 */
export function rehearsalNotice(r: Rehearsal): string {
  const skipped = [...STEPS_NOT_REHEARSED.keys()].join(", ");
  return `Mode: audit — rehearsed against a ${r.method} of the tree, which was then discarded. ` +
    `Not rehearsed: ${skipped}. Pass --fix to apply.`;
}
