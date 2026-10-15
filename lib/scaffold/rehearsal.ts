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
import { mkdtempSync, rmSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "fs";
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
    rmSync(parent, { recursive: true, force: true });
    throw new Error(`audit did NOT run: ${why}`);
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
  if (attemptCopy(["-Rc", root, dir], 300_000) !== 0) {
    if (attemptCopy(["-R", root, dir], 600_000) !== 0) {
      return fail("the tree could not be copied");
    }
    method = "copy";
  }

  // Pruning happens through `rmSync(..., { recursive: true })`, which
  // follows a symlinked PARENT. `.claude/worktrees` in a tree where
  // `.claude -> /real/.claude` therefore resolves outside the clone and
  // deletes the consumer's real worktrees — a destructive path traversal
  // performed by the mode that promises to write nothing. Found by the
  // commit security review.
  //
  // So nothing is deleted through a symlink. Each excluded path is walked
  // component by component; the moment a component is a link, the link
  // itself is unlinked (never followed) and the walk stops. `node_modules`
  // being a symlink is the common case — the pre-push hook makes one — and
  // must stay cheap rather than refusing the audit.
  for (const rel of REHEARSAL_EXCLUDES) {
    prunePathWithoutFollowingLinks(dir, rel);
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

  return { dir, parent, method };
}

/**
 * Copy into `dir`, having first removed whatever is there.
 *
 * The clear is unconditional so there is one code path rather than two with
 * an ordering between them. See `cloneForRehearsal` for why.
 */
function attemptCopy(args: string[], timeout: number): number {
  const dest = args[args.length - 1]!;
  rmSync(dest, { recursive: true, force: true });
  return spawnSync("cp", args, { encoding: "utf-8", timeout }).status ?? 1;
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
 * Remove `root/rel`, never passing through a symlink on the way.
 *
 * Two different answers, depending on WHERE the link is:
 *
 * - **The link is the path itself** (`node_modules -> /elsewhere/mods`):
 *   unlink it. `rmSync` on a link removes the link and leaves the target
 *   alone, and an excluded directory is one we did not want in the clone
 *   anyway. This is the common case — the pre-push hook makes exactly this
 *   link — and it has to stay cheap rather than refusing the audit.
 *
 * - **The link is an ANCESTOR** (`.claude -> /real/.claude`, pruning
 *   `.claude/worktrees`): leave it entirely alone. Unlinking it would throw
 *   away `.claude` — rules, agents, config — and the steps would then run
 *   over a tree missing the directory half of them read, reporting less than
 *   `--fix` will do. That is #398 itself, reintroduced by its own fix. It is
 *   also invisible to the completeness check, which cannot ask for `.claude`
 *   back while `.claude/worktrees` is on the exclude list.
 *
 *   Deleting through it is worse still: `rmSync(..., { recursive: true })`
 *   follows a symlinked parent, so the consumer's real worktrees go. So
 *   neither — the link stays, and `escapingSymlinks` refuses the audit a
 *   moment later because an ancestor pointing out of the clone is exactly
 *   what it is for. Found by the commit security review.
 */
function prunePathWithoutFollowingLinks(root: string, rel: string): void {
  let current = root;
  const parts = rel.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let st;
    try { st = lstatSync(current); } catch { return; }   // absent: nothing to prune
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) {
      if (last) rmSync(current, { force: true });
      return;   // an ancestor link: prune nothing, and let the refusal catch it
    }
    if (!last && !st.isDirectory()) return;
  }
  rmSync(current, { recursive: true, force: true });
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
