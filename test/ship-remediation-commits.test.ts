/**
 * A remediation round's work reaches the branch (#155)
 *
 * SC-555..SC-558 (HARNESS-STANDARD.md)
 *
 * `commitDir` is set once, from the FIRST implement pass. The verify and ship
 * remediation loops call `runImplement()` again — a new agent in a new
 * worktree — and then commit from `commitDir`, which still points at the old
 * one. Nothing is staged, `git commit` has nothing to commit, and the agent
 * reports the pre-existing HEAD as "the commit SHA" because the step's schema
 * asks only for a string.
 *
 * Measured on wf_67f052e6-1a5 (shipping #143): three Marcus passes, and the
 * SHA never moved off d6a0c358. Both remediation worktrees were still on disk
 * afterwards, sitting at origin/main with the work uncommitted.
 *
 * The second half is worse than the lost work. The retry gate was handed
 * `reimpl.buildResult?.worktreePath` as its cwd — the NEW worktree — so it
 * graded files that are not on the branch and could not be fetched. The only
 * reason that run did not record a PASS for a tree nobody can see is that the
 * remediation also failed.
 *
 * These assertions read ship.js's source because a workflow script is not
 * importable: the sandbox gives it no module loading (#69). Same constraint,
 * same approach, as test/ship-never-writes-main.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** Source with comment lines removed — prose must be able to name the bug. */
function code(source: string): string {
  return source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const shipCode = code(shipSource);

/**
 * Each remediation block: from a re-implementation call to the end of the
 * `if (reimpl.success) {` body that follows it.
 *
 * Sliced by brace depth rather than by a line count, so inserting a step into
 * a block cannot silently drop it out of the window being asserted on.
 */
function remediationBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /const reimpl = await runImplement\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf("{", source.indexOf("if (reimpl.success)", m.index));
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    blocks.push(source.slice(m.index, i + 1));
  }
  return blocks;
}

describe("#155: the remediation loops exist and are found", () => {
  test("there are exactly two of them — verify and ship", () => {
    // A positive control for every assertion below: if the slicer stops
    // matching, the sweeps would pass against an empty list.
    expect(remediationBlocks(shipCode).length).toBe(2);
  });
});

describe("#155: a remediation round's work is collected before it is committed", () => {
  test("every remediation block collects the new worktree's files", () => {
    const missing = remediationBlocks(shipCode).filter(b => !b.includes("collectAgentWork("));
    expect(missing).toEqual([]);
  });

  test("the collection runs before the commit, not after it", () => {
    for (const block of remediationBlocks(shipCode)) {
      const collect = block.indexOf("collectAgentWork(");
      const commit = block.indexOf("git commit");
      expect(collect).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThanOrEqual(0);
      expect(collect).toBeLessThan(commit);
    }
  });

  test("the retry gate is not pointed at the re-implementation's worktree", () => {
    // The exact line from the measured run:
    //   { cwd: reimpl.buildResult?.worktreePath || marcusWorktreePath }
    // Grading a directory whose contents are not on the branch is how a run
    // records a PASS for a tree nobody can fetch.
    expect(shipCode).not.toContain("reimpl.buildResult?.worktreePath");
    expect(shipCode).not.toContain("reimpl.buildResult.worktreePath");
  });

  test("every remediation gate runs from the directory that was committed", () => {
    for (const block of remediationBlocks(shipCode)) {
      const cwds = [...block.matchAll(/cwd:\s*([A-Za-z0-9_.?[\]'" ]+?)\s*[}),]/g)].map(m => m[1].trim());
      for (const cwd of cwds) expect(cwd).toBe("commitDir");
    }
  });
});

describe("#155: a commit that committed nothing is not reportable as success", () => {
  test("the recommit schema asks for the parent too", () => {
    // {commitSha: string} is satisfied by echoing the HEAD that was already
    // there — which is exactly what happened three times on wf_67f052e6-1a5.
    // Requiring the parent makes "I committed nothing" a statement the step
    // has to make rather than one it can omit.
    const blocks = remediationBlocks(shipCode);
    for (const block of blocks) {
      expect(block).toContain("parentSha");
      expect(block).toMatch(/required:\s*\[[^\]]*'parentSha'/);
    }
  });

  test("a recommit whose parent equals its SHA is treated as a failure", () => {
    for (const block of remediationBlocks(shipCode)) {
      expect(block).toContain("commitSha === ");
    }
  });
});
