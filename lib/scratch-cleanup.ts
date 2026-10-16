/**
 * Sweep scratch directories the test suite leaked into the repo root (#437).
 *
 * `test/tree-under-test.test.ts` and four others plant their fixtures with
 * `mkdtempSync(join(REPO_ROOT, "<prefix>"))`. They all have correct `afterAll`
 * cleanup; that is the point. The directory is created when bun *imports* the
 * file, before any lifecycle hook can run and before any hook is guaranteed to
 * run at all, so a suite that is interrupted, killed, or that throws during
 * collection leaves one behind. 34 of them had accumulated when Jason noticed,
 * all but one 0 bytes — created at import, never populated, never cleaned.
 *
 * #437 moves creation into `beforeAll`, which stops new ones appearing. This
 * is the other half: the ones already there, and the ones a kill during
 * `beforeAll` can still produce.
 *
 * Same family as #68 (39 stale worktrees) and #436 (a worktree git had pruned
 * out from under): a resource created by tooling that only gets cleaned on the
 * happy path.
 */

import { readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { readFileSync } from "fs";
import { uniqueScratchPrefixes } from "./scratch-roots";

export interface ScratchCleanupResult {
  /** Directories removed, named relative to the repo root. */
  removed: string[];
  /** Matched a prefix but was too young to be certain it is not in use. */
  kept: string[];
  /** Did not match any derived prefix — the overwhelming majority. */
  refused: string[];
  errors: string[];
}

export interface ScratchCleanupOptions {
  repoRoot: string;
  /**
   * How old a scratch directory must be before it is swept. Default one hour.
   *
   * NOT belt-and-braces. This runs at SessionStart, and another session may be
   * three minutes into a suite whose scratch directory is live. The suite that
   * created it cannot defend it — the directory is anonymous and holds no lock
   * — so age is the only signal available, and the direction to be wrong in is
   * leaving litter rather than deleting a running suite's fixtures.
   */
  maxAgeMs?: number;
  /** Report what would go without removing anything. */
  dryRun?: boolean;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * The file whose "prefixes" are test fixtures rather than real scratch roots.
 *
 * `test/scratch-paths-unique.test.ts` carries `mkdtempSync(join(ROOT, ".x-"))`
 * as a STRING LITERAL, because that is the only way to prove its detector
 * still fires. Stripping comments does not remove it. Deriving from it would
 * put `.x-` into a deletion allowlist on the strength of a test fixture, which
 * is the self-reference trap with a recursive delete on the end of it.
 */
const FIXTURE_FILE = "scratch-paths-unique.test.ts";

/**
 * Every prefix any suite in `test/` plants under the repo root.
 *
 * Derived, never listed. A hand-maintained list is a second place to forget,
 * and forgetting there means a new suite's leak accumulates silently — which
 * is the defect this module exists for, one level up.
 */
export function scratchPrefixes(repoRoot: string): string[] {
  const testDir = join(repoRoot, "test");
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(testDir);
  } catch {
    return out; // no test directory — nothing plants anything
  }
  for (const f of entries) {
    if (!f.endsWith(".ts")) continue;
    if (f === FIXTURE_FILE) continue;
    let src: string;
    try {
      src = readFileSync(join(testDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const p of uniqueScratchPrefixes(src)) if (!out.includes(p)) out.push(p);
  }
  return out.sort();
}

/**
 * Exactly what `mkdtempSync` appends: six characters from this alphabet.
 *
 * Measured over 200 calls rather than read off the documentation — the
 * lengths set came back `[6]` and the alphabet came back `[A-Za-z0-9]`.
 */
const MKDTEMP_SUFFIX = "[A-Za-z0-9]{6}";

/** A prefix is data; it reaches a RegExp, so it is escaped rather than trusted. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `entry` is a name `mkdtempSync` could have produced from `prefixes`.
 *
 * The prefix list is a deletion allowlist, so this is written as one, and the
 * first version was written as a weaker one. It asked only that the entry
 * start with a prefix and be longer — and since the prefixes are DERIVED from
 * `test/*.ts`, a suite writing `mkdtempSync(join(REPO_ROOT, ".c"))` would have
 * armed a SessionStart hook to recursively delete `.claude/`.
 * `isScratchEntry(".claude", [".c"])` returned true; it was found by a
 * security review of the first push and confirmed by running it (BUG-437-A).
 *
 * The paths were never the hole — the sweeper builds those itself. The
 * ALLOWLIST was, and an allowlist derived from file content is content
 * steering a recursive delete just as surely as a path would be.
 *
 * So the test is the full shape, not a prefix test: the entry must be a
 * prefix followed by EXACTLY the suffix `mkdtempSync` produces. A bare prefix
 * with nothing after it is a directory someone made deliberately, and
 * anything else is not a name this repo's tooling can have written.
 *
 * ONE anchored match, not a `startsWith` beside a slice at `p.length`. Those
 * two are behaviourally identical on every input — relaxing `startsWith` to
 * `includes` measured **0 of 24**, because the fixed offset refuses whatever
 * the substring match would have let through. Two deciders that agree, with
 * the delete still on the end of them. See
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function isScratchEntry(entry: string, prefixes: string[]): boolean {
  return prefixes.some(p =>
    p.length > 1 && new RegExp(`^${escapeRegex(p)}${MKDTEMP_SUFFIX}$`).test(entry));
}

/**
 * Remove leaked scratch directories from the repo root.
 *
 * Every path this deletes is one THIS function built, from
 * `join(opts.repoRoot, entry)` where `entry` came from reading that same
 * directory. No absolute path from any other source — not a config, not a
 * prefix, not a `.git` file — can reach the `rmSync`. #436 learned that one
 * the expensive way: content must never steer a recursive delete.
 */
export function cleanupScratchDirs(opts: ScratchCleanupOptions): ScratchCleanupResult {
  const result: ScratchCleanupResult = { removed: [], kept: [], refused: [], errors: [] };
  const maxAgeMs = opts.maxAgeMs ?? ONE_HOUR_MS;
  const prefixes = scratchPrefixes(opts.repoRoot);

  let entries: string[];
  try {
    entries = readdirSync(opts.repoRoot);
  } catch (err) {
    result.errors.push(`Failed to read ${opts.repoRoot}: ${err}`);
    return result;
  }

  for (const entry of entries) {
    if (!isScratchEntry(entry, prefixes)) {
      result.refused.push(entry);
      continue;
    }
    const path = join(opts.repoRoot, entry);
    let age: number;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        result.refused.push(entry);
        continue;
      }
      age = Date.now() - stat.mtimeMs;
    } catch (err) {
      result.errors.push(`Failed to stat ${entry}: ${err}`);
      continue;
    }

    if (age < maxAgeMs) {
      result.kept.push(`${entry} (${Math.round(age / 1000)}s old — a suite may still be using it)`);
      continue;
    }
    if (opts.dryRun) {
      result.removed.push(`${entry} (dry run)`);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      result.removed.push(entry);
    } catch (err) {
      result.errors.push(`Failed to remove ${entry}: ${err}`);
    }
  }

  return result;
}
