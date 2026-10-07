#!/usr/bin/env bun
/**
 * Resolve the security review's scope from git, or refuse to resolve one (#129).
 *
 * `workflows/ship.js` used to tell rook to work its own scope out:
 *
 *   Derive the changed files yourself: `git diff --name-only origin/main...HEAD`
 *
 * Measured twice in live runs, that produced an EMPTY diff both times. Rook is
 * given `"isolation": "worktree"` and the worktree is cut from `origin/main`,
 * so inside it there is nothing between the base and HEAD. Both runs only
 * found anything because rook reconstructed the scope from git refs on its own
 * initiative. A less thorough reviewer reports "no changed files, nothing to
 * review" and passes — and "I reviewed everything and found nothing" and "I
 * reviewed nothing" are the same verdict shape coming out of an agent.
 *
 * So: the workflow resolves the scope, from git, before rook is spawned.
 *
 *   bun scripts/rook-review-scope.ts <worktree> <baseRef> [headRef]
 *
 * stdout is one line of JSON and nothing else — the caller parses it.
 * stderr carries every diagnostic, so a diagnostic can never land in the
 * channel a machine reads.
 *
 * ── Fail closed, on every path ────────────────────────────────────────────
 *
 * There is no "scope is empty" success. The whole point of this script is to
 * be the thing that cannot report a clean review of nothing, so an empty,
 * missing, or malformed report exits non-zero and prints NOTHING on stdout.
 * `.claude/rules/checks-must-be-able-to-fail.md` is the house rule; this file
 * is downstream of five same-day defects that were all "a check that passed
 * because of what it never looked at".
 *
 * Two shapes from that rule are specifically designed out:
 *
 *   - Fail-open error handling. Nothing here catches an error and continues
 *     with a default. Every catch converts to a non-zero exit.
 *   - Assertions that hold vacuously. `parseChangedFiles` cannot return an
 *     empty array; the only way out of it with a value is a non-empty list of
 *     paths git plausibly emitted.
 *
 * ── No caller-supplied file list, ever ────────────────────────────────────
 *
 * The scope is derived ONLY from git. A file list from a caller — in practice
 * an LLM's `filesToModify` — is the #115 defect: three consecutive security
 * reviews found three different holes in the filter that sanitised it, and the
 * third (`.env`, `.git/config`, `.claude/settings.json`) has no filter-shaped
 * answer, because nothing about those paths' SHAPE distinguishes them from
 * `lib/a.ts`. Removing the channel removes the whole class. Extra arguments
 * are rejected rather than ignored, so a caller that believes it is narrowing
 * the scope is told it is not.
 */

import { execFileSync } from "child_process";
import { existsSync, statSync } from "fs";

/**
 * The exit code for every refusal.
 *
 * ONE constant, used by every fail-closed path, because
 * `test/rook-review-scope.test.ts` flips it to 0 in a copy of this file and
 * re-runs each negative case to prove the non-zero exit is what the assertions
 * rest on. Inlining `process.exit(1)` anywhere below would hide that path from
 * the mutation and leave it unproven. Keep the declaration on one line and
 * spelled exactly as it is — the test matches the text.
 */
export const SCOPE_FAILURE_EXIT = 1;

/** Why a scope could not be resolved. Distinct, because the causes differ. */
export type ScopeFailureKind =
  /** git produced no report at all — the command failed, or was never run. */
  | "missing"
  /** The report is not a list of paths (wrong type entirely). */
  | "not-a-list"
  /** It is a string, but not one git's `--name-only -z` would have written. */
  | "unparseable"
  /** Well-formed and genuinely zero files. Still a refusal — SC-568. */
  | "empty";

export class ScopeError extends Error {
  readonly kind: ScopeFailureKind;
  constructor(kind: ScopeFailureKind, message: string) {
    super(message);
    this.name = "ScopeError";
    this.kind = kind;
  }
}

/** The resolved review scope. Only ever constructed with a non-empty file list. */
export interface ReviewScope {
  /** The commit actually reviewed, resolved to a full SHA. */
  commit: string;
  /** The base it was diffed against, resolved to a full SHA. */
  base: string;
  /** The base as the caller named it, for the run log. */
  baseRef: string;
  /** The head as the caller named it (`HEAD` when not given). */
  headRef: string;
  worktree: string;
  files: string[];
  fileCount: number;
}

/**
 * Turn git's `--name-only -z` output into a file list, or throw.
 *
 * Takes `unknown` on purpose. The interesting failures are the ones where the
 * caller THINKS it has a report: a null from a swallowed error, a parsed JSON
 * object, an array from some future refactor. Typing the parameter as `string`
 * would move those into the type system and out of the runtime, where they
 * actually occur.
 *
 * NEVER RETURNS AN EMPTY ARRAY. Returning `[]` for "nothing changed" is the
 * exact call site that produced a passing security review of nothing, so the
 * empty case is an exception like every other refusal and the success type
 * carries the non-emptiness.
 */
export function parseChangedFiles(raw: unknown): string[] {
  if (raw === null || raw === undefined) {
    throw new ScopeError("missing", "git produced no changed-file report at all");
  }
  if (typeof raw !== "string") {
    throw new ScopeError(
      "not-a-list",
      `git's changed-file report is a ${Array.isArray(raw) ? "array" : typeof raw}, not a NUL-separated path list`,
    );
  }
  if (raw === "") {
    throw new ScopeError("empty", "git reports zero changed files");
  }

  // `-z` terminates every entry, including the last. Output that does not end
  // in NUL did not come from `--name-only -z`, so whatever wrote it was not
  // doing what this script asked — splitting it on newlines anyway would
  // invent a scope out of something that is not one.
  if (!raw.endsWith("\0")) {
    throw new ScopeError(
      "unparseable",
      `git's changed-file report is not a NUL-terminated list (${JSON.stringify(raw.slice(0, 120))})`,
    );
  }

  const entries = raw.slice(0, -1).split("\0");
  for (const entry of entries) {
    if (entry === "") {
      throw new ScopeError("unparseable", "git's changed-file report contains an empty path entry");
    }
    // git emits repository-relative paths for an in-repo diff. An absolute or
    // traversing path means the report is not describing this worktree, and
    // passing it on would point the reviewer — which reads files and quotes
    // them into a persisted transcript — outside it.
    if (entry.startsWith("/")) {
      throw new ScopeError("unparseable", `git's changed-file report contains an absolute path: ${entry}`);
    }
    if (entry.split("/").includes("..")) {
      throw new ScopeError("unparseable", `git's changed-file report contains a traversing path: ${entry}`);
    }
  }

  // Defensive, and deliberately not reachable from the branches above: an
  // empty `entries` would make the whole script vacuous, so it refuses rather
  // than relying on a reader tracing why it cannot happen.
  if (entries.length === 0) {
    throw new ScopeError("empty", "git reports zero changed files");
  }
  return entries;
}

function git(worktree: string, args: string[]): string {
  return execFileSync("git", ["-C", worktree, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Resolve a ref to a full commit SHA, or throw a `missing` ScopeError. */
function resolveCommit(worktree: string, ref: string, label: string): string {
  let out: string;
  try {
    out = git(worktree, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  } catch (e) {
    const detail = ((e as { stderr?: string }).stderr || (e as Error).message || "").split("\n")[0];
    throw new ScopeError("missing", `cannot resolve ${label} ref "${ref}" in ${worktree}: ${detail}`);
  }
  const sha = out.trim();
  // `rev-parse` exiting 0 with nothing is not a thing git does — but a shim, a
  // wrapper, or a future refactor that captures the wrong stream is, and an
  // empty SHA flowing on would label the review with no commit at all.
  if (!/^[0-9a-f]{7,64}$/.test(sha)) {
    throw new ScopeError("missing", `git did not return a commit SHA for ${label} ref "${ref}" (got ${JSON.stringify(sha)})`);
  }
  return sha;
}

/**
 * The review scope for `worktree`, or a ScopeError. Git is the only input.
 */
export function resolveReviewScope(worktree: string, baseRef: string, headRef = "HEAD"): ReviewScope {
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
    throw new ScopeError("missing", `no such worktree directory: ${worktree}`);
  }

  const base = resolveCommit(worktree, baseRef, "base");
  const commit = resolveCommit(worktree, headRef, "head");

  // `base...commit` — the merge-base diff, so work on the base branch since
  // the branch point is not counted as this run's changes.
  let raw: string | null = null;
  try {
    raw = git(worktree, ["diff", "--name-only", "-z", "--end-of-options", `${base}...${commit}`]);
  } catch (e) {
    const detail = ((e as { stderr?: string }).stderr || (e as Error).message || "").split("\n")[0];
    // Explicitly `missing`, not "no files": a diff that failed to run is the
    // fail-open shape this script exists to close.
    throw new ScopeError("missing", `git diff ${base}...${commit} failed in ${worktree}: ${detail}`);
  }

  const files = parseChangedFiles(raw);
  return { commit, base, baseRef, headRef, worktree, files, fileCount: files.length };
}

const USAGE = "usage: bun scripts/rook-review-scope.ts <worktree> <baseRef> [headRef]";

function fail(message: string): never {
  console.error(`rook-scope: ${message}`);
  process.exit(SCOPE_FAILURE_EXIT);
}

function main(argv: string[]): void {
  // Rejected, not ignored. `--files lib/a.ts` from a caller that believes it is
  // choosing the scope must be an error it sees, not a flag silently dropped.
  const flag = argv.find((a) => a.startsWith("-"));
  if (flag !== undefined) {
    fail(`no options are accepted — the file list comes from git and nowhere else (got "${flag}"). ${USAGE}`);
  }
  if (argv.length < 2 || argv.length > 3) {
    fail(
      argv.length > 3
        ? `too many arguments — a caller-supplied file list is not accepted. ${USAGE}`
        : USAGE,
    );
  }

  const [worktree, baseRef, headRef = "HEAD"] = argv as [string, string, string?];

  let scope: ReviewScope;
  try {
    scope = resolveReviewScope(worktree, baseRef, headRef);
  } catch (e) {
    if (e instanceof ScopeError) {
      fail(
        e.kind === "empty"
          ? `no changed files between ${baseRef} and ${headRef} in ${worktree} — refusing to emit an empty review scope (a security review of nothing is not a pass)`
          : `${e.kind}: ${e.message}`,
      );
    }
    fail(`could not resolve a review scope: ${(e as Error).message}`);
  }

  console.error(`rook-scope: ${scope.fileCount} changed file(s) at ${scope.commit} vs ${scope.base} (${baseRef})`);
  for (const f of scope.files) console.error(`rook-scope:   ${f}`);

  // The one and only thing stdout ever carries.
  console.log(JSON.stringify(scope));
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
