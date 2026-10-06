#!/usr/bin/env bun
/**
 * Collect parallel agents' work into the project root so it can be committed (#81).
 *
 * `workflows/ship.js` runs inside a sandbox with no module loading — a
 * top-level `require()` there killed every ship run before it spawned an agent
 * (#69). So ship.js cannot call lib/worktree-collect.ts itself. It shells out
 * to this script through an agent step instead, which runs in a real Bun
 * runtime and imports the library directly.
 *
 * That indirection is the point: the alternative was inlining a second copy of
 * the collection logic into ship.js, and a duplicated helper in this repo has
 * already drifted from its library once — computeACHash sorted its input and
 * the inline copy did not, so the extracted function had never actually matched
 * the code it replaced. One implementation, one place.
 *
 * Usage:
 *   bun scripts/collect-worktree-files.ts <groups.json> <projectRoot>
 *
 * <groups.json> holds [{ worktreePath, filesChanged }] — one entry per agent.
 * Prints the collected project-relative paths, one per line, on stdout.
 * Diagnostics go to stderr so stdout stays a clean file list.
 */

import { existsSync, readFileSync } from "fs";
import { collectWorktreeFiles, groupFilesByWorktree, type AgentBuildResult } from "../lib/worktree-collect";

const [groupsPath, projectRoot] = process.argv.slice(2);

if (!groupsPath || !projectRoot) {
  console.error("usage: bun scripts/collect-worktree-files.ts <groups.json> <projectRoot>");
  process.exit(2);
}
if (!existsSync(groupsPath)) {
  console.error(`collect: no such groups file: ${groupsPath}`);
  process.exit(2);
}

let results: AgentBuildResult[];
try {
  const parsed = JSON.parse(readFileSync(groupsPath, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("expected an array of { worktreePath, filesChanged }");
  results = parsed;
} catch (e) {
  console.error(`collect: ${groupsPath} is not valid input: ${(e as Error).message}`);
  process.exit(2);
}

const groups = groupFilesByWorktree(results);
if (groups.length === 0) {
  // Exit non-zero: the caller is about to commit. "Nothing to collect" when
  // agents reported success means the pairing was lost somewhere upstream,
  // which is the #81 failure itself. Silence here would commit nothing and
  // call it a success.
  console.error("collect: no files resolved to any worktree — refusing to report an empty collection as success");
  process.exit(1);
}

let collected;
try {
  collected = collectWorktreeFiles(groups, projectRoot);
} catch (e) {
  // A traversal or symlink rejection means the inputs cannot be trusted. Abort
  // rather than hand the caller a partially-collected tree to commit.
  console.error(`collect: ${(e as Error).message}`);
  process.exit(1);
}

for (const m of collected.missing) {
  console.error(`collect: WARNING agent reported a file that does not exist: ${m}`);
}

console.error(
  `collect: ${collected.copied.length} file(s) from ${groups.length} worktree(s)` +
    (collected.missing.length ? `, ${collected.missing.length} missing` : ""),
);

for (const p of collected.copied) console.log(p);
