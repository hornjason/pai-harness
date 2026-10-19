/**
 * #659 AC-3, AC-4 — the deletion check compares BUILD COMMIT against BUILD
 * COMMIT, and names exactly what left.
 *
 * Measured on `wf_2abbe96f-546` (issue #646). The verify gate recorded AC-9
 * FAIL over a two-value evidence command, and the repair round it triggered
 * deleted three PASSING test cases instead of investigating the verdict. The
 * run's two build commits are both preserved:
 *
 *   59bfda75  the commit the run built and the gate graded
 *   b08b3a37  the repair commit, net -296 lines
 *
 * ## Why the pair, and not the ordinary diff
 *
 * The three cases were ADDED at 59bfda75 and REMOVED at b08b3a37, both on the
 * run's own branch. Against the merge base — `3b10f745`, the parent of the
 * first build commit — they never existed, so the net diff a reviewer reads,
 * the PR, and every "what did this branch change" question are all clean of
 * the deletion. The only window it is visible in is the one between the two
 * build commits, which is why the comparison is pinned to them and why
 * `deletedCases` takes two commits rather than a branch.
 *
 * That makes the pair above the fixture this file needs, rather than one
 * invented for it: a deletion that is real, measured, and invisible to the
 * comparison everything else in the harness makes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { caseNames, deletedCases } from "../../lib/test-case-deletion";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The first build commit — what the gate graded. */
const BUILD_1 = "59bfda75";
/** The repair commit the FAIL verdict caused. */
const BUILD_2 = "b08b3a37";

const DELETED_FILE = "test/unit/hill-climb-receipt.test.ts";

/**
 * The three cases `wf_2abbe96f-546`'s repair round removed from
 * `test/unit/hill-climb-receipt.test.ts`, verbatim.
 *
 * All three passed at `BUILD_1` — 12 pass / 0 fail / exit 0 over that file
 * alone — and deleting them changed nothing about what AC-9 measures.
 */
const EXPECTED = [
  "the decision classifies; the sentence it renders to does not",
  "every outcome kind applyHillClimb can return maps to a state",
  "no fragment of a skip sentence is spelled in the consuming script",
];

/**
 * …and the five the SAME commit removed from `test/compliance-report.test.ts`,
 * which #659's AC-3 does not name.
 *
 * **Measured, not inferred, because the issue says the answer is three.** It
 * is eight. `git archive 59bfda75` was exported to a scratch directory and
 * `bun test test/compliance-report.test.ts` run against it: 30 pass, 0 fail,
 * and the JUnit report from that run carries all five of these names as
 * passing testcases. The repair replaced a five-case `describe("hill-climb
 * skip outcomes (#646)")` block with a three-case one, so the file went
 * 30 → 28 while losing five green cases — which is exactly the shape that
 * makes a net count unable to see a deletion, and exactly why this check
 * compares NAMES.
 *
 * The issue's own context note is scoped correctly ("the three deleted test
 * cases IN test/unit/hill-climb-receipt.test.ts"); AC-3 dropped the scope.
 * Reporting three here would mean filtering five real deletions out of the
 * answer to hit a number, which is the defect
 * `.claude/rules/checks-must-be-able-to-fail.md` calls a case that goes
 * green under the wrong fix. So the check reports eight, this file pins all
 * eight by name, and the three the issue names are asserted as the subset
 * they are.
 */
const ALSO_DELETED = [
  "SC-2092: a tier promotion is a typed outcome carrying tier and promotion as fields",
  "SC-2092: a reinforcement already in the brief is its own outcome kind",
  "SC-2092: a brief with no section the rule belongs in is its own outcome kind",
  "SC-2094: the skip sentences are byte-identical to the three recovered from the transcripts",
  "SC-2093: one exported binding produces the sentence, and it is spelled once",
];

const ALL_DELETED = [...EXPECTED, ...ALSO_DELETED];

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  expect(r.status, `git ${args.join(" ")} failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

describe("#659 AC-3: the check names exactly the cases that left, and no others", () => {
  test("the deleted set is the measured set, named one by one", () => {
    const got = deletedCases(REPO_ROOT, BUILD_1, BUILD_2).map(d => d.name).sort();
    expect(got).toEqual([...ALL_DELETED].sort());
  });

  test("the three the issue names are in it, and are the whole of that file's loss", () => {
    const fromFile = deletedCases(REPO_ROOT, BUILD_1, BUILD_2)
      .filter(d => d.file === DELETED_FILE)
      .map(d => d.name)
      .sort();
    expect(fromFile).toEqual([...EXPECTED].sort());
  });

  test("each is attributed to the file it was deleted from", () => {
    const files = new Set(deletedCases(REPO_ROOT, BUILD_1, BUILD_2).map(d => d.file));
    expect([...files].sort()).toEqual(["test/compliance-report.test.ts", DELETED_FILE].sort());
  });

  test("the reading of each commit matches what the gate's own census counted", () => {
    // Non-vacuity, against an instrument this module does not share. The
    // verify gate's `test-census` check recorded "12 test(s) before, 9 after"
    // for this file on the run. An extractor that found a different number of
    // cases could produce the right three names by luck; one that agrees with
    // a separate tool on both totals is reading the file.
    const before = caseNames(git(["show", `${BUILD_1}:${DELETED_FILE}`]));
    const after = caseNames(git(["show", `${BUILD_2}:${DELETED_FILE}`]));
    expect({ before: before.length, after: after.length }).toEqual({ before: 12, after: 9 });
    for (const name of EXPECTED) {
      expect(before, `${name} was not present at the first build commit`).toContain(name);
      expect(after, `${name} is still present at the repair commit`).not.toContain(name);
    }
  });

  test("the direction matters: nothing was deleted going the other way", () => {
    // The same two commits, swapped. The three cases are ADDITIONS in that
    // direction, and an implementation that returned the symmetric difference
    // would pass every assertion above.
    expect(deletedCases(REPO_ROOT, BUILD_2, BUILD_1).map(d => d.name)).not.toContain(EXPECTED[0]);
  });
});

describe("#659 AC-4: build commit against build commit", () => {
  test("the merge base is a different commit from the first build commit", () => {
    // The premise. If these were the same commit the case below would be
    // green without measuring anything.
    const base = git(["merge-base", BUILD_2, "origin/main"]).trim();
    const first = git(["rev-parse", BUILD_1]).trim();
    expect(base).not.toBe(first);
    expect(base.startsWith("3b10f745"), `merge base moved: ${base}`).toBe(true);
  });

  test("the deletion is INVISIBLE from the merge base, and visible between the build commits", () => {
    const base = git(["merge-base", BUILD_2, "origin/main"]).trim();
    const fromBase = deletedCases(REPO_ROOT, base, BUILD_2).map(d => d.name);
    for (const name of ALL_DELETED) {
      expect(fromBase, `${name} was reported against the merge base`).not.toContain(name);
    }
    const fromBuild = deletedCases(REPO_ROOT, BUILD_1, BUILD_2).map(d => d.name);
    expect(fromBuild.sort()).toEqual([...ALL_DELETED].sort());
  });

  test("the file IS in the merge-base diff — it is the deletion that is not", () => {
    // Without this the case above is satisfied by a comparison that looks at
    // nothing: a file absent from both readings produces no deleted cases for
    // the same reason an unreadable commit does.
    const base = git(["merge-base", BUILD_2, "origin/main"]).trim();
    const changed = git(["diff", "--name-only", base, BUILD_2]).split("\n");
    expect(changed).toContain(DELETED_FILE);
  });
});

describe("#659 AC-4: the caller passes the two build commits", () => {
  const ship = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the repair path captures the pre-repair HEAD and hands it to the check", () => {
    // The library can only compare what it is given. On the repair path the
    // pre-repair HEAD IS the recorded buildCommit — the commit the gate
    // graded — so capturing it before the commit is what makes the pair
    // exist. A call site that passed a merge base, `origin/main`, or the
    // repair commit's own parent range would satisfy "the check is called"
    // and measure the window this issue is about from the wrong end.
    const call = ship.split("\n").filter(l => l.includes("verify-no-deleted-cases.ts"));
    expect(call.length, "the deletion check is not called exactly once").toBe(1);
    const block = ship.slice(ship.indexOf(call[0]) - 2000, ship.indexOf(call[0]) + 500);
    expect(block, "the pre-repair HEAD is never captured").toContain("prevBuild=$(git rev-parse HEAD)");
    expect(block).toContain('--previous "$prevBuild"');
    expect(block).toContain('--current "$sha"');
    expect(block, "the comparison was pointed at a base ref rather than the build commit")
      .not.toContain("--previous origin/main");
  });
});
