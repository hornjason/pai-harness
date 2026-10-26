/**
 * The worktree-cleanup result must reach the run.
 *
 * Measured 2026-10-25: 77 worktrees had accumulated on one machine, 73 of
 * them holding work that never became a commit. `lib/worktree-cleanup.ts`
 * had been computing an `errors` array for all of it and ship.js was
 * discarding the whole reading:
 *
 *     bun -e "...cleanupWorktrees..." 2>/dev/null || echo "cleanup skipped"
 *
 * `2>/dev/null` drops the diagnostic and `|| echo` converts any non-zero
 * exit into a cheerful log line, so a cleanup that refused and a cleanup
 * that removed nothing emitted the same observable. That is the
 * fail-open shape in `.claude/rules/checks-must-be-able-to-fail.md`: the
 * quieter it got, the more it was trusted.
 *
 * These cases are about the SWALLOW, not about what cleanup decides. They
 * fail against the tree as it stood before this change.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(ROOT, "workflows", "ship.js"), "utf8");

/** The step-3 line, located by the one thing that cannot move: the import. */
function cleanupInvocation(): string {
  const line = SHIP.split("\n").find(
    (l) => l.includes("cleanupWorktrees") && l.includes("bun -e"),
  );
  // A located line is the premise of every assertion below. If the
  // invocation is ever rewritten into another shape, these cases must fail
  // loudly rather than pass over an empty string.
  expect(line, "no `bun -e` line invoking cleanupWorktrees found in ship.js").toBeString();
  return line as string;
}

describe("worktree cleanup: the run must see the result", () => {
  test("the invocation does not send stderr to /dev/null", () => {
    expect(cleanupInvocation()).not.toInclude("2>/dev/null");
  });

  test("the invocation does not convert a non-zero exit into a log line", () => {
    const line = cleanupInvocation();
    expect(line).not.toInclude('|| echo "cleanup skipped"');
    expect(line, "any `|| echo` on this line re-swallows the exit").not.toMatch(
      /\|\|\s*echo/,
    );
  });

  test("the prompt tells the agent a non-zero exit is a failure to report", () => {
    // Without this the agent is free to read a red exit as noise, which is
    // the same swallow one layer up.
    const idx = SHIP.indexOf("Cleanup worktrees:");
    expect(idx, "step 3 heading not found").toBeGreaterThan(-1);
    const step = SHIP.slice(idx, idx + 700);
    expect(step.toLowerCase()).toInclude("non-zero");
  });
});
