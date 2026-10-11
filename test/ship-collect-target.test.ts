/**
 * A multi-worktree collection lands somewhere the commit step may commit (#267)
 *
 * Two rules in `workflows/ship.js` contradicted each other, and the run caught
 * between them could not satisfy either.
 *
 * The collect path, when a run's implementation spans more than one worktree,
 * assembled everything into `PROJECT_ROOT` and set `commitDir` to it. The
 * commit step then runs, in `commitDir`:
 *
 *     branch=$(git branch --show-current)
 *     case "$branch" in main|master) echo "REFUSING: ..."; exit 1;; esac
 *
 * The project root is on `main`. That is its resting state and where the DA
 * sits while a run executes. So the collector wrote the work to the one
 * directory the committer is forbidden to commit from, and every such run
 * ended `COMMIT_FAILED` with no change to the shipped code able to alter it —
 * observed on run wf_19f7def7-1bf, which produced a complete implementation
 * and could not commit a line of it.
 *
 * The guard is not the defect and is not touched here. #136 is why it exists:
 * a run pushed straight to main and the ref was picked by an agent recovering
 * from a failed push. What was wrong is a destination chosen by path with no
 * regard for what is checked out there.
 *
 * The second half is worse than the refusal and is asserted separately below:
 * the refusal left 907 lines of unreviewed agent output STAGED, on `main`, in
 * the repository a human works in, where any later `git commit` would have
 * taken it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** Slice a marked block out of ship.js. */
function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

const PROJECT_ROOT = "/repo";
const HARNESS_ROOT = "/repo";
const WT = `${PROJECT_ROOT}/.claude/worktrees`;

type CollectTarget = (
  worktrees: unknown,
  marcusPath: unknown,
  projectRoot?: string,
  harnessRoot?: string,
) => string;

/**
 * The two blocks together, because the target is only meaningful if the
 * destination allowlist also accepts it. Loading `COLLECT-TARGET` alone would
 * let it return a path `collectDestination` refuses and the test would never
 * know — the collection would then fail at the call site, in a run, which is
 * where this defect was found the first time.
 */
function loadCollectTarget(): CollectTarget {
  return new Function(
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${block("COLLECT-DESTINATION")}\n${block("COLLECT-TARGET")}\nreturn collectTarget`,
  )(PROJECT_ROOT, HARNESS_ROOT);
}

const collectTarget = loadCollectTarget();

describe("#267: the collection goes where the commit step is allowed to commit", () => {
  test("two worktrees: the implementation worktree wins, not the project root", () => {
    // The exact shape of wf_19f7def7-1bf. The worktree is already on this
    // run's branch; the project root is on main. Only one of them is a legal
    // place to commit from, and the collector now picks it.
    const target = collectTarget([`${WT}/run-7`, `${WT}/run-8`], `${WT}/run-8`);
    expect(
      target,
      "the collection was sent to the project root, which the commit step refuses",
    ).toBe(`${WT}/run-8`);
    expect(target).not.toBe(PROJECT_ROOT);
  });

  test("the marcus worktree is preferred even when it is not first in the list", () => {
    // Order is not the rule. The implementation worktree is the one carrying
    // the branch the run will push, and picking "whichever worktree we saw
    // first" would be right by accident on the common case and wrong whenever
    // a remediation round reordered them.
    const target = collectTarget([`${WT}/reviewer`, `${WT}/marcus`], `${WT}/marcus`);
    expect(target).toBe(`${WT}/marcus`);
  });

  test("a marcus path outside the allowlist does not become the destination", () => {
    // `collectTarget` must not be a way around `collectDestination`. A path
    // that allowlist refuses is refused here too, rather than being passed
    // through to a `git add` that would stage another project's files.
    const target = collectTarget([`${WT}/run-7`, "/somewhere/else"], "/somewhere/else");
    expect(target, "an unallowlisted path reached the collector").not.toBe("/somewhere/else");
    expect(target).toBe(`${WT}/run-7`);
  });

  test("a traversal in the marcus path is refused, not sanitised", () => {
    const target = collectTarget([`${WT}/run-7`], `${WT}/../../../etc`);
    expect(target).toBe(`${WT}/run-7`);
  });

  test("no usable worktree falls back to the project root", () => {
    // A run with no isolation legitimately works in the project root, and the
    // branch guard then applies to it on its merits — an operator running
    // uncontained on main SHOULD be refused. The fallback exists so that case
    // keeps its existing behaviour rather than losing a destination entirely.
    expect(collectTarget([], PROJECT_ROOT)).toBe(PROJECT_ROOT);
    expect(collectTarget(["/not/allowed"], "/not/allowed")).toBe(PROJECT_ROOT);
  });

  test("garbage in the worktree list does not throw and does not win", () => {
    // The list is built from agent replies (#155), so every entry is untrusted.
    for (const junk of [null, undefined, 42, {}, [], "relative/path", `${WT}/x\ny`]) {
      const target = collectTarget([junk], junk);
      expect(target, `a junk worktree entry was accepted: ${JSON.stringify(junk)}`)
        .toBe(PROJECT_ROOT);
    }
    expect(collectTarget(null, null)).toBe(PROJECT_ROOT);
    expect(collectTarget("not-an-array", undefined)).toBe(PROJECT_ROOT);
  });
});

describe("#267: the block is wired into the run, and the guard it protects is intact", () => {
  test("the multi-worktree branch decides its destination rather than assuming one", () => {
    // A pure function nothing calls is a decision nobody makes. What matters
    // is that the collect branch CALLS it and no longer hard-assigns the
    // project root, which was the defect verbatim.
    const branch = shipSource.slice(
      shipSource.indexOf("if (distinctWorktrees.length > 1)"),
      shipSource.indexOf("// Environment status schema"),
    );
    expect(branch).toContain("collectTarget(distinctWorktrees, marcusWorktreePath)");
    expect(
      branch,
      "the collect branch still hard-assigns the project root as the commit directory",
    ).not.toContain("commitDir = PROJECT_ROOT");
  });

  test("the collection is written to the same place the commit runs", () => {
    // Two different directories here would stage the work in one and commit
    // from the other, which is a collect that reports success and a commit
    // that finds nothing — the failure mode this fix must not trade down to.
    const branch = shipSource.slice(
      shipSource.indexOf("if (distinctWorktrees.length > 1)"),
      shipSource.indexOf("// Environment status schema"),
    );
    expect(branch.length, "the multi-worktree collect branch moved").toBeGreaterThan(100);
    const destination = branch.match(/collectAgentWork\(agentResults,\s*([A-Za-z]+)/)?.[1];
    expect(destination, "could not find what the collection is addressed to").toBeTruthy();
    expect(
      branch,
      `the collection is addressed to ${destination} but the commit runs elsewhere`,
    ).toContain(`commitDir = ${destination}`);
  });

  test("the branch guard is untouched — #136 is not reopened", () => {
    // The fix must not buy its green by weakening the thing that refused. A
    // version of this change that deleted the guard would pass every case
    // above, so the guard is asserted here rather than assumed.
    expect(shipSource).toContain('case "$branch" in main|master)');
    expect(shipSource).toContain("ship never commits to the default branch");
  });
});
