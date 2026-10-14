/**
 * Covers SC-868, SC-869, SC-870, SC-871 (HARNESS-STANDARD.md).
 *
 * #223 — issue #209 was shipped TWICE. Measured cost of the one occurrence:
 * 45 minutes, 20 agents, 911k tokens, and two divergent open PRs for one
 * issue, where merging either silently discards the other's work.
 *
 * | run | branch | result |
 * |---|---|---|
 * | `wf_5e3ed885-98c` | `worktree-wf_5e3ed885-98c-9` | SHIP_FAILED, PR #219 |
 * | `wf_7ac5f614-d21` | `worktree-wf_7ac5f614-d21-9` | SHIPPED, PR #221 |
 *
 * `git merge-base --is-ancestor 96fde39f origin/worktree-wf_7ac5f614-d21-9`
 * → NO. Run 2 did not contain run 1's work at all; it branched from `main`
 * and re-implemented from scratch.
 *
 * ## The cause is narrower than "nothing checks"
 *
 * `detectExistingPR` and `detectPriorBranch` both existed. Three things were
 * wrong with them, and all three had to be fixed for either to have helped:
 *
 * 1. **`detectExistingPR` was never called by anything.** Grepping the tree
 *    found it imported only by its own test.
 * 2. **Both detectors look for the issue number in a BRANCH NAME**, and the
 *    harness's own branches are called `worktree-wf_5e3ed885-98c-9`. There
 *    is no issue number in that. The detector could not have matched the
 *    very branches the harness creates.
 * 3. **`detectExistingPR` matched the PR's OWN number** against the issue
 *    number — `issuePattern.test(String(pr.number))` — so PR #209 would be
 *    reported as the prior work for issue #209 whatever it was about. A
 *    false-positive generator sitting where a detector was supposed to be.
 *
 * It also read only the ten most recent open PRs and swallowed every API
 * error as "no existing PR", which is the fail-open shape
 * `.claude/rules/checks-must-be-able-to-fail.md` is about: "no PR found" and
 * "could not look" were the same answer.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  detectExistingPR,
  detectPriorBranch,
  issueReference,
  priorWorkRefusal,
} from "../lib/prior-branch";

function fakeClient(prs: unknown[], opts: { throws?: boolean } = {}) {
  return {
    rest: {
      pulls: {
        list: async () => {
          if (opts.throws) throw new Error("GitHub API is unreachable");
          return { data: prs };
        },
      },
    },
  } as never;
}

const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `fix(#999): something else`,
  body: "",
  head: { ref: `fix/999-something` },
  ...over,
});

describe("#223 SC-868: a text references an issue, decided in one place", () => {
  test("a bare reference, a closing keyword, and a branch name all count", () => {
    const refs209 = issueReference(209);
    for (const text of [
      "Closes #209.",
      "closes #209",
      "Fixes #209 and tidies up",
      "see issue 209 for context",
      "fix(#209): the title ship.js writes",
      "fix/209-prior-work",
      "209-deep-modules",
    ]) {
      expect(refs209(text), text).toBe(true);
    }
  });

  test("a superset number is not a reference", () => {
    // `5150` must not match a search for `515`. This was already right and
    // is pinned here because the rewrite below moved the regex.
    const refs515 = issueReference(515);
    for (const text of ["Closes #5150", "fix/1515-x", "5150", "#51"]) {
      expect(refs515(text), text).toBe(false);
    }
  });

  test("it is total over junk rather than throwing", () => {
    const refs1 = issueReference(1);
    for (const text of [undefined, null, 1, {}, []]) {
      expect(() => refs1(text as never)).not.toThrow();
      expect(refs1(text as never), String(text)).toBe(false);
    }
  });
});

describe("#223 SC-869: an open PR for the issue is found by what it SAYS", () => {
  test("the measured case: a harness branch name with no issue number in it", async () => {
    // PR #219's head was `worktree-wf_5e3ed885-98c-9` and its body said
    // `Closes #209`. The old detector read only the head ref, so it found
    // nothing — for the exact PR this issue is about.
    const found = await detectExistingPR({
      issueNumber: 209,
      repo: "owner/repo",
      client: fakeClient([
        pr(219, { head: { ref: "worktree-wf_5e3ed885-98c-9" }, body: "Closes #209.\n\nDetail." }),
      ]),
    });
    expect(found, "the PR for the issue was not found by its body").not.toBeNull();
    expect(found!.prNumber).toBe(219);
    expect(found!.branch).toBe("worktree-wf_5e3ed885-98c-9");
  });

  test("the title counts too", async () => {
    const found = await detectExistingPR({
      issueNumber: 209,
      repo: "owner/repo",
      client: fakeClient([pr(300, { title: "fix(#209): strict-mode matchers" })]),
    });
    expect(found!.prNumber).toBe(300);
  });

  test("a PR whose own NUMBER is the issue number is not a match", async () => {
    // The false-positive generator: `issuePattern.test(String(pr.number))`.
    // PR #209 is not evidence of prior work on issue #209.
    const found = await detectExistingPR({
      issueNumber: 209,
      repo: "owner/repo",
      client: fakeClient([pr(209)]),
    });
    expect(found, "a PR was matched to an issue purely by sharing a number").toBeNull();
  });

  test("an unrelated PR is still not a match", async () => {
    expect(
      await detectExistingPR({
        issueNumber: 209,
        repo: "owner/repo",
        client: fakeClient([pr(300), pr(301, { body: "Closes #2090" })]),
      }),
    ).toBeNull();
  });

  test("an API failure is NOT reported as 'no PR'", async () => {
    // The fail-open. "Nothing found" and "could not look" must not be the
    // same answer on the path that decides whether to re-implement an issue.
    const out = await detectExistingPR({
      issueNumber: 209,
      repo: "owner/repo",
      client: fakeClient([], { throws: true }),
    });
    expect(out, "an unreachable API read as 'no existing PR'").not.toBeNull();
    expect(out!.unreadable).toBe(true);
    expect(out!.reason).toContain("unreachable");
  });

  test("a clean empty list IS 'no PR', and says so without a reason", () => {
    return detectExistingPR({ issueNumber: 209, repo: "owner/repo", client: fakeClient([]) })
      .then(out => expect(out).toBeNull());
  });
});

describe("#223 SC-870: a prior branch is found by its commits, not only its name", () => {
  function repo(branch: string, subject: string): string {
    const dir = mkdtempSync(join(tmpdir(), "prior-work-223-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@t.t");
    run("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "base\n");
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    run("checkout", "-q", "-b", branch);
    writeFileSync(join(dir, "b.txt"), "work\n");
    run("add", "-A");
    run("commit", "-q", "-m", subject);
    run("checkout", "-q", "main");
    return dir;
  }

  test("a branch whose NAME has no issue number is found by its commit subject", async () => {
    // `fix(#209): …` is the subject ship.js writes for every commit it makes,
    // so the number is on the branch even when the name drops it. A name-only
    // detector returns null here — and a run that finds nothing starts over.
    const dir = repo("fix/strict-mode-matchers", "fix(#209): strict-mode matcher coverage");
    const found = await detectPriorBranch({ issueNumber: 209, projectRoot: dir, runTests: false });
    expect(found, "the branch holding the work was not found").not.toBeNull();
    expect(found!.branch).toBe("fix/strict-mode-matchers");
    expect(found!.commitCount).toBe(1);
  });

  test("a branch for a DIFFERENT issue is not claimed", async () => {
    // The control. A detector that matched any branch with any `fix(#N)`
    // subject would nominate the most recent branch for every issue.
    const dir = repo("fix/something-else", "fix(#777): something else entirely");
    expect(await detectPriorBranch({ issueNumber: 209, projectRoot: dir, runTests: false })).toBeNull();
  });

  test("the name still wins when it has the number — nothing regressed", async () => {
    const dir = repo("209-deep-modules", "no reference in this subject");
    const found = await detectPriorBranch({ issueNumber: 209, projectRoot: dir, runTests: false });
    expect(found!.branch).toBe("209-deep-modules");
  });

  test("a harness scratch ref is STILL excluded, subject match or not", async () => {
    // #185 ruled these out on purpose: `scripts/preserve-worktree-work.ts`
    // names work a run REFUSED to collect, and the branch this repo carries
    // for issue 254 says "NOT reviewed, do not merge" in its own tip message.
    // Reading subjects widens which REAL branches are found; it must not
    // readmit the ones that were excluded for being unresumable.
    for (const scratch of ["worktree-wf_5e3ed885-98c-9", "run/209-rescue", "rungate-preserved/209"]) {
      const dir = repo(scratch, "fix(#209): strict-mode matcher coverage");
      expect(
        await detectPriorBranch({ issueNumber: 209, projectRoot: dir, runTests: false }),
        `${scratch} was nominated as resumable prior work`,
      ).toBeNull();
    }
  });

  test("a subject containing a tab does not become a second branch", async () => {
    // The field separator is a tab, and a commit subject is written by
    // whoever made the commit. A split that took field three as `rest[0]`
    // would truncate the subject at the first tab.
    const dir = repo("fix/tabbed", "wip:\tfix(#209) tabbed subject");
    const found = await detectPriorBranch({ issueNumber: 209, projectRoot: dir, runTests: false });
    expect(found!.branch).toBe("fix/tabbed");
  });
});

/**
 * ## What a refusal here must NOT do
 *
 * An unmerged prior branch on its own is not a reason to stop. That is
 * RESUME, and it already works: ship.js merges the prior ref into the
 * worktree and pushes back onto the same branch. A refusal there would break
 * the one mechanism that makes a second run cheap — so the condition is
 * narrower than "prior work exists".
 *
 * It is "an open PR exists for this issue that this run is NOT working on",
 * which is exactly what run 2 of #209 could not see.
 */
describe("#223 SC-871: an open PR this run is not on stops it before implementing", () => {
  const OPEN_PR = { prNumber: 219, branch: "worktree-wf_5e3ed885-98c-9" };
  const ON_PR_BRANCH = {
    branch: "worktree-wf_5e3ed885-98c-9",
    refName: "refs/remotes/origin/worktree-wf_5e3ed885-98c-9",
    commitCount: 3,
    behindCount: 0,
    isBehind: false,
    isMerged: false,
    testsPass: true,
  };

  test("the measured case: an open PR and no prior branch picked up", () => {
    const refusal = priorWorkRefusal(209, null, OPEN_PR);
    expect(refusal, "a run proceeded to implement over an open PR").not.toBeNull();
    expect(refusal).toContain("#219");
    expect(refusal).toContain("worktree-wf_5e3ed885-98c-9");
  });

  test("an open PR on a DIFFERENT branch than the one picked up also refuses", () => {
    const refusal = priorWorkRefusal(209, { ...ON_PR_BRANCH, branch: "209-other" }, OPEN_PR);
    expect(refusal).not.toBeNull();
    expect(refusal, "the refusal does not say which branch this run is on")
      .toContain("209-other");
  });

  test("RESUME is not refused — this run is standing on the PR's own head", () => {
    // The control that matters most. A refuser that fires here stops every
    // legitimate second run, which is worse than the duplicate it prevents.
    expect(priorWorkRefusal(209, ON_PR_BRANCH, OPEN_PR)).toBeNull();
  });

  test("an unmerged prior branch with NO open PR is not refused either", () => {
    // ship.js merges it and pushes back onto it. Nothing to collide with.
    expect(priorWorkRefusal(209, ON_PR_BRANCH, null)).toBeNull();
  });

  test("an unreadable PR lookup refuses rather than proceeding", () => {
    // The fail-open one layer up: a run that could not find out whether a PR
    // exists must not act as though none does.
    const refusal = priorWorkRefusal(209, null, { unreadable: true, reason: "API is unreachable" });
    expect(refusal, "an unreadable lookup was treated as 'no prior work'").not.toBeNull();
    expect(refusal).toContain("unreachable");
  });

  test("nothing at all does NOT refuse", () => {
    expect(priorWorkRefusal(209, null, null)).toBeNull();
  });

  test("a PR record with no number is not a PR", () => {
    // Half a reading is not a reading. It is also not a refusal: `unreadable`
    // is how "could not look" is said, and anything else malformed is a bug
    // in the caller, not evidence of prior work.
    expect(priorWorkRefusal(209, null, {})).toBeNull();
    expect(priorWorkRefusal(209, null, { branch: "x" })).toBeNull();
  });

  test("the refusal is total over junk rather than throwing", () => {
    // It runs on the path that decides whether a run may implement, so a
    // throw here is a refusal the caller's error handling turns into a ship.
    for (const bad of [undefined, null, 0, "x", [], { branch: 7 }, { prNumber: "219" }]) {
      expect(() => priorWorkRefusal(209, bad as never, bad as never)).not.toThrow();
    }
  });
});

describe("#223 SC-871: ship.js consults it before it implements", () => {
  const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

  test("the refusal is reached before the implement phase", () => {
    const refusalAt = shipSource.indexOf("priorWorkRefusal(");
    const implementAt = shipSource.indexOf("PHASE 4: IMPLEMENT");
    expect(refusalAt, "ship.js never consults the refusal").toBeGreaterThan(-1);
    expect(implementAt).toBeGreaterThan(-1);
    expect(refusalAt, "the refusal runs after the implementation it exists to prevent")
      .toBeLessThan(implementAt);
  });

  test("it refuses by returning, not by logging", () => {
    // A warning the run then ignores is the 911k tokens again with a note
    // attached. The block must leave the workflow.
    const start = shipSource.indexOf("// ──── PRIOR-WORK-REFUSAL-START ────");
    const end = shipSource.indexOf("// ──── PRIOR-WORK-REFUSAL-END ────");
    expect(start, "the PRIOR-WORK-REFUSAL markers are gone").toBeGreaterThan(-1);
    const block = shipSource.slice(start, end);
    expect(block).toContain("PRIOR_WORK_OPEN_PR");
    expect(block).toMatch(/return\s*\{\s*status:\s*'PRIOR_WORK_OPEN_PR'/);
  });

  test("the existing-PR lookup happens — the refusal is not fed a constant null", () => {
    // `detectExistingPR` sat in lib/ with no caller for its whole life. The
    // refusal is only worth having if something actually looks.
    //
    // Asserted on the ASSIGNMENT, not on the name appearing somewhere. The
    // first draft of this test grepped for `detectExistingPR` and stayed
    // green when the agent call was replaced by `= null`, because the name
    // survived inside the now-dead template literal — a detector narrower
    // than what it detects, in the test for a detector narrower than what it
    // detects.
    expect(
      shipSource,
      "existingPrResult is not the awaited result of an agent that runs detectExistingPR",
    ).toMatch(/const existingPrResult = await timedAgent\(`[\s\S]*?detectExistingPR/);
    expect(
      shipSource,
      "the refusal is not fed what the lookup returned",
    ).toContain("priorWorkRefusal(ISSUE, priorBranchResult, existingPrResult)");
  });

  test("priorWorkRefusal has exactly one definition in ship.js", () => {
    expect(
      (shipSource.match(/function priorWorkRefusal\b/g) ?? []).length,
      "there is no single binding to mutate",
    ).toBe(1);
  });
});

describe("#223 SC-871: ship.js's inlined copy agrees with the library", () => {
  // ship.js runs in a sandbox with no module loading, so the refusal is
  // inlined. Two copies of one decision is two things to keep in step, and
  // the way that is kept honest is to drive both over one input set — the
  // pattern that found a real divergence on its first run in #244.
  const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

  function inlinedRefusal(): (n: number, b: unknown, p: unknown) => string | null {
    const start = shipSource.indexOf("// ──── PRIOR-WORK-REFUSAL-START ────");
    const end = shipSource.indexOf("// ──── PRIOR-WORK-REFUSAL-END ────");
    if (start < 0 || end < 0) throw new Error("could not slice the refusal out of ship.js");
    const block = shipSource.slice(start, end);
    const fn = block.match(/function priorWorkRefusal[\s\S]*?\n\}/);
    if (!fn) throw new Error("could not find priorWorkRefusal in the sliced block");
    return new Function(`${fn[0]}; return priorWorkRefusal;`)() as never;
  }

  const CASES: Array<[string, unknown, unknown]> = [
    ["no PR, no branch", null, null],
    ["open PR, no branch", null, { prNumber: 219, branch: "worktree-wf_5e3ed885-98c-9" }],
    ["open PR, same branch", { branch: "b" }, { prNumber: 7, branch: "b" }],
    ["open PR, other branch", { branch: "a" }, { prNumber: 7, branch: "b" }],
    ["open PR, unnamed head", { branch: "a" }, { prNumber: 7, branch: "" }],
    ["open PR, head not a string", { branch: "a" }, { prNumber: 7, branch: 7 }],
    ["unreadable with a reason", null, { unreadable: true, reason: "API is unreachable" }],
    ["unreadable with no reason", null, { unreadable: true }],
    ["branch but no PR", { branch: "a" }, null],
    ["PR with no number", null, { branch: "b" }],
    ["empty PR record", null, {}],
    ["junk branch", 7, { prNumber: 7, branch: "b" }],
    ["junk PR", null, "nope"],
    ["both junk", "x", 0],
  ];

  for (const [name, branch, pr] of CASES) {
    test(`parity: ${name}`, () => {
      expect(inlinedRefusal()(209, branch, pr)).toEqual(priorWorkRefusal(209, branch, pr));
    });
  }
});
