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
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  /** `clone` when copy-on-write was used, `copy` when it fell back. */
  method: "clone" | "copy";
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

  // `-c` asks for an APFS clonefile. It fails outright on filesystems that
  // cannot do it rather than silently copying, so the fallback is explicit.
  const cow = spawnSync("cp", ["-Rc", root, dir], { encoding: "utf-8", timeout: 300_000 });
  if (cow.status === 0) return pruned({ dir, method: "clone" });

  const plain = spawnSync("cp", ["-R", root, dir], { encoding: "utf-8", timeout: 600_000 });
  if (plain.status !== 0) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(
      `audit could not clone the tree to rehearse against: ${plain.stderr?.trim() || "cp failed"}`,
    );
  }
  return pruned({ dir, method: "copy" });
}

function pruned(r: Rehearsal): Rehearsal {
  for (const rel of REHEARSAL_EXCLUDES) {
    const p = join(r.dir, rel);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  return r;
}

/** Throw the clone away. Safe to call twice. */
export function discardRehearsal(r: Rehearsal): void {
  // The parent, not the tree: `cloneForRehearsal` owns both and leaving the
  // mkdtemp behind is the leak #437 is about.
  rmSync(join(r.dir, ".."), { recursive: true, force: true });
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
