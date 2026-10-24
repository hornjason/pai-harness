#!/usr/bin/env bun
/**
 * report-provenance — the tree a peer report was measured against (#553).
 *
 * Usage:
 *   bun scripts/report-provenance.ts
 *   bun scripts/report-provenance.ts --measured 7fdfa72a --ref origin/fix/540
 *   bun scripts/report-provenance.ts --project /path/to/worktree
 *   bun scripts/report-provenance.ts --expect-branch rg/1348
 *
 * Prints a block to paste at the top of a report, and exits non-zero when the
 * branch has moved past the tree you measured — which is the moment to
 * re-measure rather than to send.
 *
 * `--expect-branch` is for the case where you are not where you think you
 * are: it refuses when the directory read is not the one holding the branch
 * under review (#1348). Pass it whenever the work lives in a worktree you
 * reached with `git -C`, because then every cwd-sensitive command — this
 * one, and `/security-review` — reads your launch directory instead.
 *
 * It also ages the tree the session's HOOKS execute out of (#1341), which is
 * a different checkout from the one you are editing and is the one nothing
 * updates. `RUNGATE_HOOKS_DIR` is the binding; `--hooks-dir` overrides it and
 * an unset binding skips that half rather than failing it. A behind or
 * unmeasurable hook tree exits non-zero for the same reason a moved branch
 * does: the numbers this session produces describe a tree nobody named.
 *
 * Thin CLI consumer: every decision lives in lib/report-provenance.ts.
 */
import { spawnSync } from "child_process";

import { spawnGitRunner } from "../lib/hook-tree-currency";
import { sessionProvenance, sessionProvenanceBlock, STALE_EXIT } from "../lib/report-provenance";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i + 1 >= args.length ? undefined : args[i + 1];
}

const reading = sessionProvenance({
  root: flag("project") ?? process.cwd(),
  measured: flag("measured"),
  ref: flag("ref"),
  expectBranch: flag("expect-branch"),
  // The env var is the binding. No machine's path is written here, and a
  // machine that has not set it is skipped, not refused.
  hooksDir: flag("hooks-dir") ?? process.env.RUNGATE_HOOKS_DIR ?? null,
  // Named at the call site, never defaulted inside the module — see the
  // module header, and `hooks/HookCurrency.hook.ts`, which says the same.
  base: flag("base") ?? "origin/main",
  // `spawnGitRunner`, never an inline spawn: the hooks directory is the
  // unsupervised one, and `git -C` executes keys out of its `.git/config`.
  git: spawnGitRunner(spawnSync),
});
console.log(sessionProvenanceBlock(reading));
if (!reading.current) process.exit(STALE_EXIT);
