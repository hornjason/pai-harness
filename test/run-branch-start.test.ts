/**
 * #702 — a run re-based onto main and discarded six commits already on the
 * branch it derives for that issue, and nothing reported it.
 *
 * Run `wf_9d22ecf5-aed`: issue #631 had six commits on `rungate/run-631`, the
 * exact branch ship derives. The run cut from main, re-implemented the issue,
 * and pushed over it. Not a refusal, not a warning, not a line in the
 * journal — and every artefact afterwards names `rungate/run-631` and means
 * two different things depending on when it was written. That is
 * *Silent Default Substitution* with a branch instead of a config value.
 *
 * ## What was measured before any code was written, because it changed the job
 *
 * #640 and #644 landed in this region AFTER that run. So the first thing was
 * to plant a repository in exactly the #702 state — six commits on
 * `rungate/run-631`, main moved on independently, checkout on main — and
 * execute the branch-setup shell against it. **It resumes.** `git switch -c`
 * fails because the branch exists, and `|| git switch` adopts it; HEAD after
 * is the prior tip.
 *
 * So AC-1's "either resumes it or REFUSES" was already satisfied
 * BEHAVIOURALLY, and the real gap is narrower and worse: **nothing held it.**
 * The shell lived inside an agent prompt's template literal, so reading it
 * was the only thing anyone could do — which is precisely what AC-1 says not
 * to rely on. An edit to either `case` arm would reintroduce the discard with
 * every test in the repository still green.
 *
 * This file closes that, and adds the reading AC-2 asks for.
 *
 * ## Why `runBranchStart` is not a second `leftoverRunBranch`
 *
 * `leftoverRunBranch` (#640) says what was THERE before the run. This says
 * what the run DID about it. A leftover can be present and resumed, present
 * and discarded, or present and never reached, and those are the three
 * outcomes AC-2 wants distinguishable. Collapsing them into the existing
 * reading would make one function answer two questions, and no mutation
 * could say which half a red belonged to.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * #702 names it: **always branch from the existing local ref when one is
 * present** — drop the `-c` and always `git switch <ref>`. It silences the
 * symptom, and it breaks every run of an issue whose branch does not exist
 * yet, which is most of them.
 *
 * `AC-1b` is the case that does not survive it, and the pair is what makes
 * that visible: the resume case passes under the wrong fix and the first-run
 * case does not. AC-2's reading is the other half — #702 says the criterion
 * "must demand the REPORTED state and not merely that nothing was
 * discarded", so the behavioural cases assert the reading too.
 *
 * ## A precondition this battery cannot reach, said rather than omitted
 *
 * **No fixture here has a remote.** That is deliberate for AC-3 — a branch
 * adopted in a repo with no remote can only have come from `refs/heads` — and
 * it means the branch where `git switch <ref>` resolves a REMOTE-tracking ref
 * and creates a local branch from it is outside this battery's reach entirely
 * (#492). A run against a fresh clone whose `origin/rungate/run-N` exists and
 * whose local ref does not would take that path, and nothing here measures it.
 * It is named rather than papered over: every fixture meets the precondition,
 * so no count in the table below says anything past it.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/unit/run-branch.test.ts` (41 tests). Counts
 * predicted in `/tmp/702-battery/predictions.md` before the battery ran, and
 * **the baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 41 pass, 0 fail | **41 pass, 0 fail** | — |
 * | M1 **the cheapest wrong fix**: the `-c` dropped, always `git switch <ref>`, BOTH copies | 2 | **2 of 41** | a repo with no `rungate/run-999`: the original creates it at the base, the mutant exits 1 with nothing to switch to |
 * | M2 the `case "$branch" in ""\|main\|master)` guard removed — switch always | 2 | **2 of 41** | a checkout on `feature/someone-else`: the original leaves it, the mutant moves it |
 * | M3 `priorTip === undefined` reads NO_PRIOR_BRANCH, BOTH copies — the collapse #702 is about | 1 | **1 of 41** | an omitted `priorTip`: the original is UNMEASURED, the mutant says the branch was not there |
 * | M4 `runBranchStartRefusal` returns `null` for UNMEASURED, BOTH copies | 1 | **1 of 41** | an UNMEASURED reading: the original refuses, the mutant lets the run proceed blind |
 * | M5 ship.js's `RUN_BRANCH_START:` log removed | 1 | **1 of 41** | the workflow source: the reading is computed and nobody can read it |
 * | M6 `priorTip` dropped from ship.js's reply schema — the #646 shape | 1 | **1 of 41** | the workflow source: a schema is a filter, so the field is stripped on the way back and every run reads UNMEASURED |
 * | M7 `priorTip === null` reads PRIOR_BRANCH_DISCARDED, **lib only** | 3 | **3 of 41** | `priorTip: null`: the lib copy says DISCARDED, the inlined copy says NO_PRIOR_BRANCH |
 *
 * **M1 is the row this file exists for.** Under it the resume case — the one
 * #702 is written about — stays GREEN, and only the first-run case goes red.
 * A battery with the resume case alone would have certified the wrong fix.
 *
 * **M7 is 3 and the ship.js impl row stays green**, which is what makes the
 * matrix a measurement of divergence rather than a second copy of the
 * behavioural cases. Each `IMPLS` row drives its own script AND its own
 * reading; handing both rows the library binding would make a lib-only
 * mutation red in both and no row could say which copy owned the red (#484).
 *
 * None of the seven mutations is left in the tree; all were run and reverted
 * from `cp` backups, never `git checkout --`, and `lib/run-branch.ts` and
 * `workflows/ship.js` were confirmed byte-identical by sha256 afterwards.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  runBranchName,
  runBranchSetupScript,
  runBranchStart,
  runBranchStartRefusal,
} from "../lib/run-branch";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const SETUP_START = "// ──── RUN-BRANCH-SETUP-START ────";
const SETUP_END = "// ──── RUN-BRANCH-SETUP-END ────";

/**
 * Module scope on purpose. A missing marker throws and the whole file fails
 * to load, rather than skipping — a skipped parity check reads exactly like
 * a passing one.
 */
const inlined = (() => {
  const start = shipSource.indexOf(SETUP_START);
  const end = shipSource.indexOf(SETUP_END);
  if (start === -1 || end === -1) {
    throw new Error(`ship.js is missing the ${SETUP_START} / ${SETUP_END} markers`);
  }
  const body = shipSource.slice(start + SETUP_START.length, end);
  const fns = new Function(
    `${body}\nreturn { runBranchSetupScript, runBranchStart, runBranchStartRefusal }`,
  )();
  for (const n of ["runBranchSetupScript", "runBranchStart", "runBranchStartRefusal"]) {
    if (typeof fns[n] !== "function") throw new Error(`ship.js's block does not define ${n}`);
  }
  return fns as {
    runBranchSetupScript: typeof runBranchSetupScript;
    runBranchStart: typeof runBranchStart;
    runBranchStartRefusal: typeof runBranchStartRefusal;
  };
})();

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim();
}

/**
 * A repository in a named state, built rather than described.
 *
 * `priorCommits > 0` puts that many commits on the run branch for `issue` and
 * then moves main on independently, so the two lines genuinely diverge —
 * which is the #702 shape. A fixture whose branch is an ancestor of main
 * would be resumed by a setup that did nothing at all.
 */
function plantRepo(opts: {
  issue: number;
  priorCommits: number;
  startOn?: string;
}): { root: string; priorTip: string | null; mainTip: string } {
  const root = mkdtempSync(join(tmpdir(), "rungate-702-"));
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main", ".");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");

  let priorTip: string | null = null;
  if (opts.priorCommits > 0) {
    git(root, "switch", "-qc", runBranchName(opts.issue));
    for (let i = 1; i <= opts.priorCommits; i++) {
      writeFileSync(join(root, `prior-${i}.txt`), `prior ${i}\n`);
      git(root, "add", "-A");
      git(root, "commit", "-qm", `fix(#${opts.issue}): prior work ${i}`);
    }
    priorTip = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-q", "main");
  }

  // Main moves on, so the prior line is not an ancestor of the base.
  writeFileSync(join(root, "moved.txt"), "main moved\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "main moves on");
  const mainTip = git(root, "rev-parse", "HEAD");

  if (opts.startOn && opts.startOn !== "main") {
    git(root, "switch", "-qc", opts.startOn);
  }
  return { root, priorTip, mainTip };
}

/**
 * Execute the real setup script against a planted repo and read the outcome.
 *
 * The script, not a paraphrase of it: `script` is whichever copy the caller
 * hands in, so the same driver measures `lib/` and the inlined `ship.js`
 * block. #702 AC-1 asks for exactly this — a run driven against a planted
 * repo, not the branch-setup code read.
 */
function drive(
  root: string,
  issue: number,
  script: (quotedRef: string) => string,
): { branchBefore: string; branchAfter: string; headAfter: string; priorTip: string | null } {
  const ref = runBranchName(issue);
  const priorRaw = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
    cwd: root,
    encoding: "utf-8",
  });
  const priorTip = priorRaw.status === 0 ? priorRaw.stdout.trim() : null;

  const branchBefore = git(root, "branch", "--show-current");
  const body = `set -uo pipefail\nbranch=$(git branch --show-current)\n${script(`'${ref}'`)}\n`;
  const run = spawnSync("bash", ["-c", body], { cwd: root, encoding: "utf-8" });
  if (run.status !== 0) {
    throw new Error(`setup script exited ${run.status}: ${run.stderr || run.stdout}`);
  }
  return {
    branchBefore,
    branchAfter: git(root, "branch", "--show-current"),
    headAfter: git(root, "rev-parse", "HEAD"),
    priorTip,
  };
}

/**
 * Each row drives ONE copy end to end — its own script AND its own reading.
 * Handing both rows the library's `runBranchStart` would make a lib-only
 * mutation red in both, and no row could say which copy the red belongs to
 * (#484).
 */
const IMPLS: [string, typeof runBranchSetupScript, typeof runBranchStart][] = [
  ["lib/run-branch.ts", runBranchSetupScript, runBranchStart],
  ["workflows/ship.js (inlined)", inlined.runBranchSetupScript, inlined.runBranchStart],
];

for (const [name, script, reading] of IMPLS) {
  describe(`#702 [${name}] AC-1: a derived branch carrying prior work is resumed, not discarded`, () => {
    test("six commits on the derived branch survive, and the run commits onto them", () => {
      // The #702 state, planted and driven rather than reasoned about.
      const { root, priorTip } = plantRepo({ issue: 631, priorCommits: 6 });
      try {
        expect(priorTip, "the fixture did not create a prior branch").not.toBeNull();
        const out = drive(root, 631, script);

        expect(out.branchBefore, "the fixture did not start on main").toBe("main");
        expect(out.branchAfter).toBe("rungate/run-631");
        expect(
          out.headAfter,
          "the run started somewhere other than the prior tip — the six commits are discarded",
        ).toBe(priorTip!);

        // And the commits are genuinely reachable, not merely an equal sha.
        const log = git(root, "log", "--format=%s", "-6");
        expect(log.split("\n").filter(l => l.includes("prior work")).length).toBe(6);

        expect(
          reading({ ...out, priorTip }),
          "the run resumed and did not say so",
        ).toBe("PRIOR_BRANCH_RESUMED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("AC-1b: a first run of an issue still gets its branch, cut from the base", () => {
      // **The case the cheapest wrong fix does not survive.** Dropping the
      // `-c` and always `git switch <ref>` resumes perfectly and leaves this
      // with nothing to switch to, so the run never gets a branch at all.
      const { root, mainTip } = plantRepo({ issue: 999, priorCommits: 0 });
      try {
        const out = drive(root, 999, script);
        expect(out.branchAfter, "a first run was left without its branch").toBe("rungate/run-999");
        expect(out.headAfter).toBe(mainTip);
        expect(reading({ ...out, priorTip: null })).toBe("NO_PRIOR_BRANCH");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a checkout already on somebody else's branch is left alone", () => {
      // The third arm of the `case`. A run must not move a shared checkout
      // off work in progress, and without this the guard could be deleted
      // with both cases above still green.
      const { root } = plantRepo({ issue: 631, priorCommits: 2, startOn: "feature/someone-else" });
      try {
        const out = drive(root, 631, script);
        expect(out.branchBefore).toBe("feature/someone-else");
        expect(
          out.branchAfter,
          "the run switched a shared checkout off the branch it found it on",
        ).toBe("feature/someone-else");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

describe("#702 AC-2: the three outcomes are distinguishable, and absent is UNMEASURED", () => {
  const BASE = { branchBefore: "main", branchAfter: "rungate/run-631", headAfter: "aaa" };

  test("resumed, discarded and no-prior-branch are three different readings", () => {
    expect(runBranchStart({ ...BASE, priorTip: "aaa" })).toBe("PRIOR_BRANCH_RESUMED");
    expect(runBranchStart({ ...BASE, priorTip: "bbb" })).toBe("PRIOR_BRANCH_DISCARDED");
    expect(runBranchStart({ ...BASE, priorTip: null })).toBe("NO_PRIOR_BRANCH");

    const all = ["aaa", "bbb", null].map(p => runBranchStart({ ...BASE, priorTip: p }));
    expect(new Set(all).size, "two of the three outcomes report the same thing").toBe(3);
  });

  test("an UNREAD priorTip is UNMEASURED and never NO_PRIOR_BRANCH", () => {
    // The pair #702 is about. `undefined` is "nobody looked"; `null` is "the
    // branch was genuinely not there". Collapsing them is the whole defect,
    // one layer up — which is why the prompt tells the agent to report the
    // literal string NONE rather than omitting the field.
    expect(runBranchStart({ ...BASE, priorTip: undefined })).toBe("UNMEASURED");
    expect(runBranchStart({ ...BASE, priorTip: null })).not.toBe("UNMEASURED");
  });

  test("an unreadable branch or head is UNMEASURED, not a clean start", () => {
    expect(runBranchStart({ ...BASE, branchAfter: "", priorTip: null })).toBe("UNMEASURED");
    expect(runBranchStart({ ...BASE, headAfter: "", priorTip: "aaa" })).toBe("UNMEASURED");
  });

  test("only the two states that lost information produce a refusal sentence", () => {
    expect(runBranchStartRefusal("PRIOR_BRANCH_RESUMED", "rungate/run-631")).toBeNull();
    expect(runBranchStartRefusal("NO_PRIOR_BRANCH", "rungate/run-631")).toBeNull();

    const discarded = runBranchStartRefusal("PRIOR_BRANCH_DISCARDED", "rungate/run-631", ["4acc0a17"]);
    expect(discarded).not.toBeNull();
    expect(discarded!, "the refusal does not name the commits it would discard").toContain("4acc0a17");

    const unmeasured = runBranchStartRefusal("UNMEASURED", "rungate/run-631");
    expect(unmeasured).not.toBeNull();
    expect(
      unmeasured!,
      "the unmeasured sentence does not distinguish itself from no-prior-branch",
    ).toContain("not \"there was no prior branch\"");
  });
});

describe("#702 AC-3: the reading is wired into the run, and both copies agree", () => {
  test("ship.js computes the start reading and logs it", () => {
    // A perfect binding nobody calls is #530's shape: the block can be
    // flawless while `establishRunRef` never consults it.
    expect(shipSource, "ship.js never calls runBranchStart").toContain("runBranchStart({");
    expect(shipSource, "the reading is computed and never logged").toContain("RUN_BRANCH_START:");
    expect(
      shipSource,
      "the setup shell is spelled inline again instead of going through the binding",
    ).toContain("${runBranchSetupScript(shellQuote(ref))}");
  });

  test("the agent is asked for priorTip and headAfter, and the schema declares them", () => {
    // A schema is a FILTER on the reply (#646): an undeclared field is
    // stripped on the way back, so a prompt that asks and a schema that does
    // not declare produce `undefined` — which reads UNMEASURED on every run
    // and would make the whole reading permanently blind.
    expect(shipSource, "the prompt does not ask for priorTip").toContain("as priorTip");
    expect(shipSource, "the prompt does not ask for headAfter").toContain("as headAfter");
    expect(shipSource, "priorTip is not declared in the reply schema").toContain("priorTip: { type: 'string' }");
    expect(shipSource, "headAfter is not declared in the reply schema").toContain("headAfter: { type: 'string' }");
  });

  test("an unpushed LOCAL branch at the derived name is what the fixture proves is seen", () => {
    // AC-3. The planted repo has no remote at all, so the branch the resume
    // case adopts can only have been found in `refs/heads`.
    const { root, priorTip } = plantRepo({ issue: 631, priorCommits: 3 });
    try {
      expect(git(root, "remote").trim(), "the fixture has a remote, so local-only is unproven").toBe("");
      const out = drive(root, 631, runBranchSetupScript);
      expect(priorTip, "the fixture did not create a prior branch").not.toBeNull();
      expect(out.headAfter).toBe(priorTip!);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the two copies of each binding agree over a matrix", () => {
    const MATRIX = [
      { branchBefore: "main", branchAfter: "rungate/run-1", headAfter: "aaa", priorTip: "aaa" },
      { branchBefore: "main", branchAfter: "rungate/run-1", headAfter: "aaa", priorTip: "bbb" },
      { branchBefore: "main", branchAfter: "rungate/run-1", headAfter: "aaa", priorTip: null },
      { branchBefore: "main", branchAfter: "rungate/run-1", headAfter: "aaa", priorTip: undefined },
      { branchBefore: "", branchAfter: "", headAfter: "", priorTip: null },
    ];
    const readings = MATRIX.map(m => runBranchStart(m));
    for (const [i, m] of MATRIX.entries()) {
      expect(inlined.runBranchStart(m), `copies disagree on ${JSON.stringify(m)}`).toBe(readings[i]);
      expect(inlined.runBranchStartRefusal(readings[i], "b", ["x"])).toEqual(
        runBranchStartRefusal(readings[i], "b", ["x"]),
      );
    }
    expect(new Set(readings).size, "every matrix row produces the same reading").toBeGreaterThan(2);
    expect(runBranchSetupScript("'r'")).toBe(inlined.runBranchSetupScript("'r'"));
  });
});
