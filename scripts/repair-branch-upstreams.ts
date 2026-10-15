#!/usr/bin/env bun
/**
 * Unset the upstream of every branch configured to track a ref that is not
 * its own (#429).
 *
 * `git checkout -b <name> origin/main` sets `branch.<name>.merge` to
 * `refs/heads/main`. Any push with no refspec from that branch — including
 * the ship gate's auto-push, which pushes `HEAD:${branch.<b>.merge}` — then
 * writes `main`. Fourteen branches in this repo were in that state when the
 * issue was found, and four `wip:` commits reached `origin/main` because of
 * it.
 *
 * `lib/verified-push.ts` now refuses that push, so this script is the
 * cleanup rather than the fix: it stops the refusal from firing on every run
 * and removes the hazard for any tool that does not route through it.
 *
 * The repair is to UNSET, not to retarget. A branch whose upstream names a
 * different ref may be deliberate — this repo has
 * `fix/remove-hardcoded-quinn-rules-from-ship` tracking `refs/heads/ship-1344`
 * — and inventing the "right" upstream is the kind of silent repair
 * `.claude/rules/checks-must-be-able-to-fail.md` warns about. With no
 * upstream the next `git push -u origin <branch>` sets the correct one, and
 * `verifiedPush` reports `no-upstream`, which already counts as work left
 * local.
 *
 *   bun scripts/repair-branch-upstreams.ts [--apply]
 *
 * Lists what it would change by default; `--apply` performs it. Exits 0
 * either way — this is maintenance, not a gate.
 */

import { execFileSync } from "child_process";

const APPLY = process.argv.includes("--apply");

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

const current = git(["branch", "--show-current"]).trim();
const mismatched: { branch: string; merge: string }[] = [];

for (const line of git(["config", "--get-regexp", String.raw`^branch\..*\.merge$`]).split("\n")) {
  const m = line.match(/^branch\.(.+)\.merge (.+)$/);
  if (!m) continue;
  const [, branch, merge] = m as unknown as [string, string, string];
  if (merge.trim() === `refs/heads/${branch}`) continue;
  mismatched.push({ branch, merge: merge.trim() });
}

if (mismatched.length === 0) {
  console.log("No branch tracks a ref other than its own.");
  process.exit(0);
}

console.log(`${mismatched.length} branch(es) track a ref that is not their own:\n`);
for (const { branch, merge } of mismatched) {
  const danger = merge === "refs/heads/main" ? "  ← a push from here writes main" : "";
  const here = branch === current ? "  ← CURRENT BRANCH" : "";
  console.log(`  ${branch} → ${merge}${danger}${here}`);
}

if (!APPLY) {
  console.log(`\nRe-run with --apply to unset these upstreams.`);
  process.exit(0);
}

console.log("");
let done = 0;
for (const { branch } of mismatched) {
  // `--unset-upstream` fails on a branch that has none, which cannot happen
  // here, and on a missing branch, which also cannot — both came from the
  // config of branches that exist. Reported rather than swallowed anyway.
  try {
    execFileSync("git", ["branch", "--unset-upstream", branch], { stdio: ["ignore", "pipe", "pipe"] });
    console.log(`  unset upstream: ${branch}`);
    done++;
  } catch (e) {
    console.error(`  FAILED: ${branch} — ${(e as Error).message}`);
  }
}
console.log(`\n${done} of ${mismatched.length} repaired. Set a correct one with \`git push -u origin <branch>\`.`);
