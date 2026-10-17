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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "fs";
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
  /**
   * The root the operator actually named, kept so the notice can say what it
   * was SUBSTITUTED for (#481).
   *
   * `dir` always comes from `mkdtemp` and is therefore always absolute. So the
   * audit takes the absolute code path no matter what the operator typed, and
   * `bunx rungate scaffold .` was rehearsed as an absolute invocation, passed,
   * and then threw in the real run on every repo-root owned file. The
   * rehearsal was not wrong about the steps; it was silent about the input it
   * had replaced.
   */
  source: string;
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
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch (err) {
      // NOT `return`. A directory we cannot read is a directory whose
      // symlinks we did not check, and a check that skips what it cannot
      // see reports the same empty list as a tree with nothing wrong —
      // `.claude/rules/checks-must-be-able-to-fail.md`'s fail-open shape,
      // found by the commit security review. Unreadable counts as
      // escaping, so the audit refuses rather than previewing blind.
      out.push(`${rel || "."} (unreadable: ${(err as Error).message})`);
      return;
    }
    for (const e of entries) {
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) {
        if (linkEscapes(root, child)) out.push(child);
      } else if (e.isDirectory()) {
        walk(child);
      }
    }
  };
  walk("");
  return out.sort();
}

/**
 * Does the link at `root/rel` resolve outside `root`?
 *
 * `realpathSync` is right for a link whose target exists and wrong for one
 * whose target does not: it throws, and the first version treated a throw as
 * "resolves to the link's own path", i.e. inside the root, i.e. safe. A
 * DANGLING link to `/etc/thing` was therefore not flagged — and a step that
 * writes through it creates `/etc/thing`. A dangling link is the more
 * dangerous case, not the less, because writing is exactly what makes the
 * target exist. Found by the commit security review.
 */
function linkEscapes(root: string, rel: string): boolean {
  const link = join(root, rel);
  try {
    const target = realpathSync(link);
    return target !== root && !target.startsWith(root + sep);
  } catch {
    // Unresolvable: fall back to the literal target, resolved against the
    // link's own directory the way the kernel would.
    try {
      const literal = resolve(join(link, ".."), readlinkSync(link));
      return literal !== root && !literal.startsWith(root + sep);
    } catch {
      // Cannot even read the link. Unknown is not safe.
      return true;
    }
  }
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
    // Through `removeTree`: what a failed copy leaves behind is whatever
    // made it fail, and a bare `rmSync` here throws that errno in place of
    // the refusal below — so the caller is told the audit crashed rather
    // than why it declined. A clone we cannot clean up is still a decline,
    // so a leftover is appended to the sentence rather than replacing it.
    const leaked = removeTree(parent);
    throw new Error(
      `audit did NOT run: ${why}` +
      (leaked === null ? "" : ` (and the clone is still on disk: ${parent} — ${leaked})`),
    );
  };

  // `-c` asks for an APFS clonefile. It fails on filesystems that cannot do
  // it, so the fallback is explicit rather than a silent slow path.
  //
  // Both attempts go through `attemptCopy`, which clears the destination
  // first. A failed `cp` may have copied some of the tree before giving up,
  // and falling back on top of that leaves a PARTIAL clone — the steps then
  // run over a tree missing files, report less than `--fix` will do, and
  // look like a clean preview, which is this module's whole subject. The
  // first draft cleared only in the fallback, and the mutation battery
  // scored that guard 0: `cp -Rc` succeeds on every machine the tests run
  // on, so no test could ever reach the second branch. One shared helper
  // removes the ordering rather than testing it.
  let method: Rehearsal["method"] = "clone";
  if (attemptCopy(root, dir, "-Rc", 300_000) !== 0) {
    if (attemptCopy(root, dir, "-R", 600_000) !== 0) {
      return fail("the tree could not be copied");
    }
    method = "copy";
  }

  const missing = missingTopLevel(root, dir);
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

  return { dir, parent, method, source: root };
}

/**
 * One `cp` invocation. Injectable so a test can record what was copied
 * rather than infer it from the result — "this path is absent from the
 * clone" is true under BOTH orderings, so absence cannot witness the fix.
 */
export type CopyRunner = (args: string[], timeout: number) => number;

const realCp: CopyRunner = (args, timeout) =>
  spawnSync("cp", args, { encoding: "utf-8", timeout }).status ?? 1;

/**
 * Copy `src` to `dst`, never reading an excluded path (#549).
 *
 * The exclusion used to be applied AFTER the clone: `cp -R` copied the whole
 * tree and `prunePathWithoutFollowingLinks` then deleted
 * `.claude/worktrees`. On this repository that directory is **737 MB across
 * 104 worktrees**, and the recursive `rm` died with `EFAULT: bad address in
 * system call argument`. So `bunx rungate scaffold .` could not run on
 * rungate — the harness could not scaffold itself, which is SUCCESS.md
 * claim 5 pointed inward. The exclude list was right the whole time; the
 * ORDERING defeated it, and a consumer with a merely LARGE gitignored
 * directory got a preview that silently spent minutes copying files it was
 * about to delete.
 *
 * ## How the level walk works, and why it is not a full recursive copy
 *
 * Only directories that are an ANCESTOR of an exclude are walked. Everything
 * else is handed to `cp` whole, so the APFS clonefile still applies to the
 * subtree and the cost stays bounded by metadata. On this repo that is two
 * walked directories — the root and `.claude` — and one `cp` per top-level
 * entry.
 *
 * ## Symlinks keep the answers `prunePathWithoutFollowingLinks` worked out
 *
 * They were paid for by a commit security review and the reasons have not
 * changed; what changed is that they are now decisions about what to COPY
 * rather than about what to delete, which is strictly safer because a
 * decision not to copy cannot escape the clone.
 *
 * - **An excluded path that is itself a link** (`node_modules -> /elsewhere`,
 *   which the pre-push hook creates): skipped. Previously it was copied and
 *   then unlinked; now it is never read. Same clone, one fewer traversal.
 * - **A link that is an ANCESTOR of an exclude** (`.claude -> /real/.claude`
 *   while excluding `.claude/worktrees`): copied AS A LINK and not descended
 *   into. Descending would read the consumer's real tree, and deleting
 *   through it is what the old code's `rmSync(..., { recursive: true })`
 *   would have done. The link then reaches `escapingSymlinks`, which refuses
 *   the audit — which is what an ancestor pointing out of the clone is for.
 *
 * Returns the first non-zero `cp` status, or 0.
 */
/**
 * Remove a tree we own, clearing what makes a removal refuse first.
 * Returns `null` when the path is gone, or the reason it is not.
 *
 * Two things stop `rm` on a tree this module created, and neither is a
 * permission the owner actually lacks:
 *
 * - **BSD file flags.** `cp -Rc` is a clonefile and a clonefile carries
 *   flags, so a clone of this repo holds the `uchg` files it sets on
 *   `gates/prompts/*.md`. `rm` answers "Operation not permitted" and bun
 *   reports it as `EFAULT: bad address in system call argument`, naming
 *   neither the file nor the flag. That is #549's error message.
 * - **A directory with no owner-read or owner-execute bit.** An unreadable
 *   directory is one `cp` cannot copy, so it is exactly what a failed first
 *   attempt leaves behind — and `rmSync` cannot list it to empty it. The
 *   owner can always chmod it; `rm -rf` never does.
 *
 * Both are best-effort: `chflags` does not exist on Linux, where there are
 * no BSD flags either, and a failing `chmod` is a tree we do not own, which
 * the removal below will report in its own words.
 */
function removeTree(path: string): string | null {
  spawnSync("chflags", ["-R", "nouchg,noschg", path], { timeout: 60_000 });
  spawnSync("chmod", ["-R", "u+rwX", path], { timeout: 60_000 });
  try {
    rmSync(path, { recursive: true, force: true });
    return null;
  } catch (err) {
    if (spawnSync("rm", ["-rf", path], { encoding: "utf-8", timeout: 120_000 }).status === 0) {
      return null;
    }
    return (err as Error).message;
  }
}

export function copyTreeExcluding(
  src: string,
  dst: string,
  excludes: readonly string[],
  cpFlag: string,
  timeout: number,
  run: CopyRunner = realCp,
): number {
  // Unconditional, so there is one code path rather than two with an
  // ordering between them: a failed `cp -Rc` may have copied part of the
  // tree, and falling back on top of that leaves a PARTIAL clone whose
  // steps report less than `--fix` will do.
  //
  // Through `removeTree`, not a bare `rmSync`. What the first attempt left
  // behind is whatever made it fail — on Linux CI an unreadable directory
  // `cp -R` could not copy and `rmSync` then cannot remove — and a throw
  // here escapes `cloneForRehearsal` as a raw EACCES instead of its refusal
  // sentence. That is the same defect as the one in `discardRehearsal`
  // below, one function earlier.
  if (removeTree(dst) !== null) return 1;
  const paths = excludes.map(e => e.split("/").filter(Boolean)).filter(p => p.length > 0);
  return copyLevel(src, dst, paths, cpFlag, timeout, run);
}

function copyLevel(
  src: string,
  dst: string,
  excludes: string[][],
  cpFlag: string,
  timeout: number,
  run: CopyRunner,
): number {
  mkdirSync(dst, { recursive: true });
  // The mode of a directory we created ourselves rather than let `cp`
  // create. Without this an 0o700 `.claude` becomes 0o755 in the clone, and
  // a step that reads permissions would see a tree that is not the
  // consumer's.
  try { chmodSync(dst, statSync(src).mode & 0o7777); } catch { /* best effort */ }

  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch {
    return 1;
  }

  for (const e of entries) {
    if (excludes.some(p => p.length === 1 && p[0] === e.name)) continue;
    const deeper = excludes.filter(p => p.length > 1 && p[0] === e.name).map(p => p.slice(1));
    // `isDirectory()` is false for a symlink, which is the behaviour this
    // relies on: an ancestor link falls through to the `cp` below and is
    // copied as a link rather than walked.
    if (deeper.length > 0 && e.isDirectory()) {
      const st = copyLevel(join(src, e.name), join(dst, e.name), deeper, cpFlag, timeout, run);
      if (st !== 0) return st;
      continue;
    }
    const st = run([cpFlag, join(src, e.name), join(dst, e.name)], timeout);
    if (st !== 0) return st;
  }
  return 0;
}

/** Copy into `dir`, excluding what the clone does not want. */
function attemptCopy(root: string, dir: string, cpFlag: string, timeout: number): number {
  return copyTreeExcluding(root, dir, REHEARSAL_EXCLUDES, cpFlag, timeout);
}

/**
 * Top-level entries present in `root` but absent from its copy at `dir`.
 *
 * The copy has to BE the tree, not most of it. Compared at the top level
 * only — a full walk would cost more than the clone did — which is enough to
 * catch a truncated copy that exited 0.
 *
 * **Only a WHOLE top-level exclude is forgiven.** `.claude/worktrees` prunes
 * a child, so `.claude` itself must still be present; matching on the first
 * path component instead excuses a missing `.claude` entirely, which is the
 * under-reporting this module exists to stop. Exported so that reading is one
 * binding a test can feed a genuinely partial copy — the first version of
 * SC-1514 re-implemented this comparison inside the test and therefore never
 * ran the real one, and the mutation battery scored it 0.
 */
export function missingTopLevel(root: string, dir: string): string[] {
  const forgiven = new Set(REHEARSAL_EXCLUDES.filter(x => !x.includes("/")));
  const got = new Set(readdirSync(dir));
  return readdirSync(root).filter(n => !forgiven.has(n) && !got.has(n));
}

/**
 * Throw the clone away. Safe to call twice. Returns why it could not, or
 * `null`.
 *
 * ## The clone can contain files that refuse to be deleted (#549)
 *
 * `cp -Rc` is a clonefile, and a clonefile carries the source's BSD FILE
 * FLAGS. This repository sets `uchg` on `gates/prompts/*.md` — that is the
 * prompt-immutability feature working as designed — so the clone contains
 * immutable files and `rm` refuses them:
 *
 * ```
 * rm: .../tree/gates/prompts/evidence-validator.md: Operation not permitted
 * ```
 *
 * bun reports that as `EFAULT: bad address in system call argument, rm`,
 * which names neither the file nor the flag, and the THROW took down a
 * scaffold run whose report had already printed. That is the whole of #549's
 * symptom: `bunx rungate scaffold .` could not complete on rungate itself.
 * The 737 MB `.claude/worktrees` directory the issue identified made it
 * slower and held most of the flagged copies, and excluding it from the copy
 * is right and necessary — but the thing `rm` was actually refusing was a
 * flag, not a size.
 *
 * So the flags are cleared in the CLONE before it is removed. Only in the
 * clone: `r.parent` always comes from `mkdtemp`, the consumer's own files
 * are never touched, and the flags are deliberately left intact DURING the
 * rehearsal so the steps see the tree the consumer has rather than a more
 * permissive one.
 *
 * ## A cleanup failure is reported, not thrown
 *
 * The report is already printed by the time this runs. Turning a leaked temp
 * directory into a non-zero exit loses the audit; saying nothing loses the
 * leak, which is #437. So it returns the sentence and the caller prints it.
 */
export function discardRehearsal(r: Rehearsal): string | null {
  // `r.parent`, not `join(r.dir, "..")`. Deriving a deletion target by
  // walking up from a path is how a cleanup ends up removing something it
  // does not own; the owner is recorded at creation instead. Leaving the
  // mkdtemp behind is the leak #437 is about, so it is the parent that goes.
  //
  // One binding with the copy's own cleanup, so the flag-clearing and the
  // mode-clearing cannot drift apart between the two places that delete a
  // tree this module made.
  const why = removeTree(r.parent);
  if (why === null) return null;
  return `the rehearsal clone could not be removed and is still on disk: ${r.parent} — ` +
    `${why}. Remove it by hand; nothing in the consumer's tree was touched.`;
}

/**
 * The line audit prints so a reader knows the report was produced by running
 * the real thing, not by predicting it — and knows what it did not run.
 */
/**
 * What the rehearsal did, and — the half #481 was missing — what it did NOT.
 *
 * A rehearsal substitutes one input by construction: the root. Steps run
 * against `r.dir`, which `mkdtemp` makes absolute, so nothing that depends on
 * the FORM of the operator's argument is exercised. That is not a bug to fix;
 * a rehearsal has to run somewhere else or it is not a rehearsal. It is a
 * thing the notice has to SAY, because an unrehearsed input reported as
 * rehearsed is `UNMEASURED is not SKIP` wearing a dry run's clothes: the
 * audit printed `CREATED: project-state.json` for a write that threw.
 */
export function rehearsalNotice(r: Rehearsal): string {
  const skipped = [...STEPS_NOT_REHEARSED.keys()].join(", ");
  return `Mode: audit — rehearsed against a ${r.method} of the tree, which was then discarded. ` +
    `Not rehearsed: ${skipped}. ` +
    `Root SUBSTITUTED: the steps ran against ${r.dir}, not ${r.source} — anything that depends ` +
    `on the form of that argument is UNMEASURED by this audit. Pass --fix to apply.`;
}
