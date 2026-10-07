#!/usr/bin/env bun
/**
 * Establish the security review's scope from git, and refuse when it is empty (#129).
 *
 * Rook's worktree is cut from origin/main, so `git diff origin/main...HEAD`
 * inside it is EMPTY. On both production runs that exercised this, rook
 * reconstructed a scope by its own initiative; a run where it had not would
 * have reviewed nothing and reported PASS, and nothing downstream could have
 * told the difference. "Found no problems in zero files" and "found no
 * problems" are the same string.
 *
 * So the workflow establishes the scope, from the commit it is actually
 * shipping, before rook is spawned — and an empty result is a refusal rather
 * than a clean bill of health.
 *
 * This lives in a script because `workflows/ship.js` runs in a sandbox with no
 * module loading and no filesystem access: a top-level `require()` there killed
 * every ship run before it spawned an agent (#69). The workflow shells out
 * through an agent step, exactly as scripts/collect-worktree-files.ts does.
 *
 * Usage:
 *   bun scripts/rook-review-scope.ts --project <dir> --sha <commit> [--base <ref>] [--out <file>]
 *
 * Prints one JSON object on stdout: {"sha","base","files"}. Diagnostics go to
 * stderr so stdout stays machine-readable.
 *
 * TWO PROPERTIES THIS FILE MUST KEEP, both asserted by
 * test/rook-review-scope.test.ts (see .claude/rules/checks-must-be-able-to-fail.md):
 *
 *   1. Every refusal exits through REFUSE_EXIT, declared exactly once. The
 *      test builds a mutant copy with that constant set to 0 and runs every
 *      negative case twice — real refuses, mutant does not. An exit written
 *      with a literal code instead of the constant would slip past the
 *      mutation, and the case guarding it would become indistinguishable from
 *      one passing by accident.
 *   2. No relative imports. The mutant runs from a temp directory, and a
 *      relative import of anything under lib/ would make it die on module
 *      resolution — a non-zero exit that reads as the mutation having been
 *      rejected on the merits.
 *
 * Both guards look at the whole file, prose included. That is deliberate: a
 * detector that first strips comments is a detector whose view of the input
 * can silently shrink, which is the #89 defect. A false positive here is a
 * sentence that needs rewording; a false negative is a guard that stopped
 * guarding.
 */

import { execFileSync } from "child_process";
import { statSync, writeFileSync } from "fs";

/** The one exit code every refusal travels through. See note 1 above. */
export const REFUSE_EXIT = 1;

export class ScopeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeRefused";
  }
}

/** A commit SHA, not a ref. "HEAD" is what made the production diff empty. */
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * A ref name conservative enough to hand to git as a literal argument.
 *
 * This never reaches a shell — execFileSync passes an argv array — so the
 * pattern is about refusing nonsense early and legibly rather than about
 * quoting. Branch names with spaces or metacharacters are not names this
 * harness creates.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
}

export interface ReviewScope {
  /** The full SHA of the commit under review. */
  sha: string;
  /** The full SHA of the merge base the review is measured against. */
  base: string;
  /** Project-relative paths, sorted. Never empty — an empty scope throws. */
  files: string[];
}

export function reviewScope(projectRoot: string, sha: string, base: string): ReviewScope {
  if (!projectRoot) {
    throw new ScopeRefused("--project is required: the scope has to be read out of a specific repository");
  }
  if (!sha) {
    throw new ScopeRefused("--sha is required: the review must be pinned to the commit being shipped");
  }

  let stat;
  try {
    stat = statSync(projectRoot);
  } catch {
    throw new ScopeRefused(`--project ${projectRoot} does not exist`);
  }
  if (!stat.isDirectory()) {
    throw new ScopeRefused(`--project ${projectRoot} is not a directory`);
  }

  if (!SHA.test(sha)) {
    throw new ScopeRefused(
      `--sha "${sha.slice(0, 80)}" is not a commit SHA (7-40 lowercase hex). ` +
        `A ref name is not accepted: "HEAD" means "whatever worktree you happen to be in", ` +
        `which is how the security review came to read an empty diff twice (#129).`,
    );
  }
  if (!REF.test(base)) {
    throw new ScopeRefused(`--base "${base.slice(0, 80)}" is not a usable ref name`);
  }

  let resolved = "";
  try {
    resolved = git(projectRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).trim();
  } catch {
    resolved = "";
  }
  if (!resolved) {
    throw new ScopeRefused(`git does not know commit ${sha} in ${projectRoot}`);
  }

  let baseSha = "";
  try {
    baseSha = git(projectRoot, ["merge-base", base, resolved]).trim();
  } catch (e) {
    throw new ScopeRefused(
      `no merge base between ${base} and ${sha} in ${projectRoot}: ${firstLine(e)}`,
    );
  }
  if (!baseSha) {
    throw new ScopeRefused(`git produced no merge base between ${base} and ${sha}`);
  }

  let raw = "";
  try {
    raw = git(projectRoot, ["diff", "--name-only", "-z", baseSha, resolved]);
  } catch (e) {
    throw new ScopeRefused(`git diff ${baseSha}..${resolved} failed: ${firstLine(e)}`);
  }

  // NUL-separated, so a path containing a newline cannot split into two
  // entries — and a scope this script got wrong is a scope rook reviews wrong.
  const files = raw.split("\0").map(s => s.trim()).filter(Boolean).sort();

  if (files.length === 0) {
    throw new ScopeRefused(
      `the review scope is empty: ${baseSha}..${resolved} changed no files, so there is ` +
        `nothing for the security review to read. A PASS over zero files is not a clean ` +
        `review, it is an absent one (#129).`,
    );
  }

  return { sha: resolved, base: baseSha, files };
}

function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0];
}

const OPTIONS = new Set(["project", "sha", "base", "out"]);

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([A-Za-z][A-Za-z-]*)$/.exec(arg);
    if (!m) {
      throw new ScopeRefused(`unexpected argument "${arg.slice(0, 80)}" — every input is a --flag with a value`);
    }
    if (!OPTIONS.has(m[1])) {
      throw new ScopeRefused(`unknown option --${m[1]}`);
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new ScopeRefused(`--${m[1]} needs a value`);
    }
    out[m[1]] = value;
  }
  return out;
}

// CLI entry point. Guarded so the module can be imported by tests without
// running the scope determination and calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const scope = reviewScope(args.project ?? "", args.sha ?? "", args.base ?? "origin/main");
    const json = JSON.stringify(scope);
    // Written only after the scope is known good, so a refused run never
    // leaves an artefact a later step could mistake for a successful one.
    if (args.out) writeFileSync(args.out, `${json}\n`);
    console.error(`rook-review-scope: ${scope.files.length} file(s) in ${scope.base.slice(0, 12)}..${scope.sha.slice(0, 12)}`);
    console.log(json);
  } catch (e) {
    console.error(`rook-review-scope: REFUSED — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(REFUSE_EXIT);
  }
}
