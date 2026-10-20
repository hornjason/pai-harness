/**
 * Covers SC-1560..SC-1571 (HARNESS-STANDARD.md), #420.
 *
 * #189 shipped the ordering half of dependency waves: wave N+1 does not start
 * until wave N has SUCCEEDED. It did not ship the other half — wave N+1 still
 * could not READ what wave N built, so a consumer sub-issue wrote against an
 * API it had only been told about in prose. That is the `wf_92dbb346-949`
 * failure mode (two `harnessRootFor`s with opposite contracts) with only its
 * cheaper variant prevented.
 *
 * The reason it was left out is the reason this file is shaped the way it is.
 * Worktrees are spawned with `isolation: 'worktree'` against `PROJECT_ROOT`
 * and there is no base parameter, so the ONLY lever on where a wave-2
 * worktree starts is where `PROJECT_ROOT`'s HEAD points when the harness
 * creates it. Making wave 1 visible therefore means committing mid-run — the
 * #267/#136 manoeuvre that left 907 lines of unreviewed output on `main`. So
 * two things are asserted together throughout: the output arrives, AND it
 * never arrives on a default branch.
 *
 * Covers SC-2084..SC-2091 (HARNESS-STANDARD.md), #652 — the two describes at
 * the foot of this file. #420 shipped the ref and the comparison; #652 is
 * about what the run SAYS when either goes wrong, and about the one input
 * #420 never considered: the shared checkout is shared, so a peer session can
 * move it between the moment the ref is established and the moment a wave
 * commits onto it.
 *
 * ## #653: the battery behind SC-2084..SC-2091, re-measured against this tree
 *
 * The ten rows recorded in `specs/HARNESS-STANDARD.md` were taken on a
 * `git archive` export carrying an implementation the repository did not yet
 * hold, and the spec said so and asked for a re-run. **All ten reproduce
 * here — same counts, same named criteria** — and the spec now records that
 * rather than the promise.
 *
 * Two rows needed their mutation re-cut before they were faithful, which is
 * the reusable part: a prose description of a mutant is not a mutant.
 *
 * - The pre-#652 row is the whole pre-#652 tree. Mutating only
 *   `waveCommitFailure` is 3, not 6, because nothing touched the re-read the
 *   three dispatch criteria measure.
 * - The composed-message row must leave the `!landedOn` early return INSIDE
 *   the committed-false arm. Hoisted ahead of both arms it also intercepts
 *   `{committed: true, branch: ""}`, which SC-1565 owns, and the row reads 3
 *   with an extra red that is about the mutant rather than its subject.
 *
 * **The cheapest wrong fix was applied and counted, and its GREENS are the
 * finding.** Appending the branch to the generic sentence without moving the
 * check makes the dead run's symptom go away, and SC-2084, SC-2086 and
 * SC-2087 are green over it — three cells that only ask whether the branch
 * is named are satisfied by a repair that names it and distinguishes
 * nothing. What catches it is SC-2088 alone: an empty branch becomes
 * `(branch , run ref …)`, and SC-2088 demands nothing about a branch AT ALL
 * rather than merely no branch name. It was written as the
 * unconditional-clause control and it is the whole protection against the
 * cheap repair.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const RUN_REPO = "owner/project";
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function sliceBlock(name: string): string {
  const a = shipSource.indexOf(`// ──── ${name}-START ────`);
  const b = shipSource.indexOf(`// ──── ${name}-END ────`);
  expect(a, `ship.js is missing the ${name}-START marker`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing the ${name}-END marker`).toBeGreaterThan(a);
  // Exactly once each: a second copy would survive any mutation of the first
  // and the guard would go green for the wrong reason.
  expect(shipSource.indexOf(`// ──── ${name}-START ────`, a + 1)).toBe(-1);
  expect(shipSource.indexOf(`// ──── ${name}-END ────`, b + 1)).toBe(-1);
  return shipSource.slice(a, b);
}

const RUN_REF_BLOCK = sliceBlock("RUN-REF");
const DECOMPOSED_BLOCK = sliceBlock("DECOMPOSED-SHIP");
// #611 put a free reference in the decomposed block. The real block text is
// evaluated alongside it rather than stubbed — a stub would let this suite
// and ship.js disagree about what a reported path is.
// #830 put `reportedPathRefusal` in those same markers, and it calls
// `pathRefusal` from SECURITY-HELPERS, so the real table is evaluated
// beneath the block: one decider for contributability, asked at the report
// and again at collection, never a second copy of two of its rules.
const SHAPE_BLOCK = `${sliceBlock("SECURITY-HELPERS")}\n${sliceBlock("FILES-CHANGED-SHAPE")}`;
// #627 put a third free reference in the RUN-REF block: the wave path pairs
// each settled sub-issue with the claim the plan issued for it, through the
// same binding the end-of-run collect uses. Evaluated from its own markers
// rather than stubbed, for the reason above — a stub would let this suite and
// ship.js disagree about what the collector is handed, which is precisely the
// disagreement #627 is.
const CLAIM_PAIRING_BLOCK = sliceBlock("CLAIM-PAIRING");

type AgentCall = { label: string; prompt: string };

/**
 * The RUN-REF block, run with fakes. `timedAgent` and `collectAgentWork` are
 * injected because this file has no agents; everything else is ship.js's own
 * code, evaluated rather than read as text — a text assertion holds over a
 * block that no longer parses (#204).
 */
function loadRunRef(opts: {
  branchAfter?: string;
  commitReply?: unknown;
  collect?: { ok: boolean; collected: number; detail?: string };
}) {
  const calls: AgentCall[] = [];
  const logs: string[] = [];
  const factory = new Function(
    "timedAgent", "collectAgentWork", "shellQuote", "log", "PROJECT_ROOT", "ISSUE",
    "worktreeIdentityViolations", "REPO",
    `${CLAIM_PAIRING_BLOCK}
     ${RUN_REF_BLOCK}
     return { runRefName, runRefRefusal, waveNeedsIntegration, establishRunRef, integrateWave };`,
  );
  return {
    calls,
    logs,
    fns: factory(
      async (prompt: string, o: { label: string }) => {
        calls.push({ label: o.label, prompt });
        if (o.label === "run-ref") return { branch: opts.branchAfter ?? "fix/420" };
        return opts.commitReply === undefined
          ? { committed: true, sha: "abc1234", branch: opts.branchAfter ?? "fix/420" }
          : opts.commitReply;
      },
      async () => opts.collect ?? { ok: true, collected: 2, staged: true },
      (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`,
      (m: string) => logs.push(String(m)),
      "/tmp/project",
      420,
      // #218/#414's guard, from ITS markers rather than stubbed. A stub would
      // let the wave staging point and the top-level one disagree about which
      // repository a worktree belongs to, and nothing would notice — which is
      // the exact warning the COLLECT-IDENTITY docblock carries.
      new Function(`${sliceBlock("WORKTREE-IDENTITY")}\nreturn worktreeIdentityViolations;`)(),
      RUN_REPO,
    ),
  };
}

describe("#420 — the pure decisions", () => {
  const { fns } = loadRunRef({});

  test("SC-1560: a default branch and a detached HEAD refuse, and say different things", () => {
    const onMain = fns.runRefRefusal("main");
    const onMaster = fns.runRefRefusal("master");
    const detached = fns.runRefRefusal("");

    expect(onMain).toBeTruthy();
    expect(onMaster).toBeTruthy();
    expect(detached).toBeTruthy();
    // Distinguishable, deliberately. "There is no branch" and "the branch is
    // main" are different facts, and a caller that cannot tell them apart
    // cannot say which one to fix.
    expect(detached).not.toBe(onMain);
    expect(onMain).toMatch(/main/);
    expect(detached).toMatch(/detached|no branch/i);

    // The positive control. Without it a refusal that fired on everything
    // would satisfy every case above.
    expect(fns.runRefRefusal("fix/420-wave-visibility")).toBeNull();
    expect(fns.runRefRefusal("rungate/run-420")).toBeNull();
  });

  test("SC-1561: only a wave with a successor is integrated", () => {
    expect(fns.waveNeedsIntegration(0, 3)).toBe(true);
    expect(fns.waveNeedsIntegration(1, 3)).toBe(true);
    expect(fns.waveNeedsIntegration(2, 3)).toBe(false);
    // The single-wave case is the one that must not move an operator's
    // checkout: there is nobody to hand anything to.
    expect(fns.waveNeedsIntegration(0, 1)).toBe(false);
    expect(fns.runRefName(420)).toBe("rungate/run-420");
  });
});

describe("#420 — a wave-2 worktree contains what wave 1 built", () => {
  function git(cwd: string, args: string): string {
    const p = Bun.spawnSync({ cmd: ["git", ...args.split(" ")], cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  }

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), "rg-420-"));
    git(root, "init -q -b main");
    git(root, "config user.email a@b.c");
    git(root, "config user.name tester");
    writeFileSync(join(root, "README.md"), "base\n");
    git(root, "add README.md");
    git(root, "commit -q -m base");
    return root;
  }

  test("SC-1562: wave 1's file is in wave 2's checkout, and absent without the commit", () => {
    const root = repo();
    try {
      git(root, "switch -q -c rungate/run-420");

      // Wave 1: its own worktree, branched from HEAD the way the harness does.
      const w1 = join(root, ".wt1");
      git(root, `worktree add -q --no-track -b sub-1 ${w1} HEAD`);
      writeFileSync(join(w1, "paths.ts"), "export const harnessRootFor = () => 1;\n");

      // The CONTROL, taken before the commit: a wave-2 worktree created now
      // does not contain it. Without this the positive case below could be
      // satisfied by a file that was in the base commit all along.
      const early = join(root, ".wt-early");
      git(root, `worktree add -q --no-track -b early ${early} HEAD`);
      expect(existsSync(join(early, "paths.ts"))).toBe(false);

      // Integration: wave 1's output is collected into the project checkout
      // and committed onto the run ref. This is what `integrateWave` drives.
      writeFileSync(join(root, "paths.ts"), readFileSync(join(w1, "paths.ts"), "utf-8"));
      git(root, "add paths.ts");
      git(root, "commit -q -m wave-1");
      expect(git(root, "branch --show-current")).toBe("rungate/run-420");

      // Wave 2, created the same way, after the commit.
      const w2 = join(root, ".wt2");
      git(root, `worktree add -q --no-track -b sub-2 ${w2} HEAD`);
      expect(existsSync(join(w2, "paths.ts"))).toBe(true);
      expect(readFileSync(join(w2, "paths.ts"), "utf-8")).toContain("harnessRootFor");

      // And nothing reached main.
      expect(git(root, "log --oneline main")).not.toContain("wave-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#420 — integrateWave", () => {
  const accepted = [
    {
      ok: true,
      buildResult: {
        success: true,
        worktreePath: "/tmp/wt1",
        worktreeRepo: "git@github.com:owner/project.git",
        filesChanged: ["a.ts"],
      },
    },
  ];

  test("SC-1563: a wave with no accepted output is not collected or committed", async () => {
    // Whether the wave has a SUCCESSOR is the loop's question, asked once
    // with `waveNeedsIntegration` — see SC-1567/SC-1568. What this one is
    // about is the other empty case: a wave whose results were all rejected
    // has nothing to hand forward, and collecting it would put refused work
    // on the ref every later wave is built from (SC-4).
    const { fns, calls } = loadRunRef({});
    const out = await fns.integrateWave([{ ok: false, buildResult: null }], 0, 2, "fix/420");
    expect(out.ok).toBe(true);
    expect(out.integrated).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("SC-1564: a wave with a successor is collected and committed, and not pushed", async () => {
    const { fns, calls, logs } = loadRunRef({});
    const out = await fns.integrateWave(accepted, 0, 2, "fix/420");
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.integrated).toBe(2);

    const commit = calls.find(c => c.label === "commit-wave-1");
    expect(commit, `labels seen: ${calls.map(c => c.label).join(",")}`).toBeTruthy();
    // The shell guard is the second line of defence and runs in the directory
    // the commit runs in, which is not where ship.js asked.
    expect(commit!.prompt).toContain("main|master");
    expect(commit!.prompt).not.toMatch(/git push/);
    expect(logs.join("\n")).toContain("integrated onto fix/420");
  });

  test("SC-1565: a commit that lands on another ref is a failure, not a success", async () => {
    // The ref it landed on is an ordinary feature branch — one `runRefRefusal`
    // is perfectly happy with. That is deliberate. Written with `main` here,
    // this case stayed green with the comparison deleted, because the refusal
    // re-check two lines below caught it instead: two deciders agreeing, so no
    // behavioural test could witness which one was load-bearing. Measured —
    // disabling the comparison was 0 of 196 red before this case existed.
    const { fns } = loadRunRef({
      commitReply: { committed: true, sha: "dead123", branch: "fix/someone-elses-work" },
    });
    const out = await fns.integrateWave(accepted, 0, 2, "rungate/run-420");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("fix/someone-elses-work");
    expect(out.detail).toContain("rungate/run-420");
  });

  test("SC-1565: a commit that lands on a default branch is refused on its own terms", async () => {
    // The other side of the same line. Both guards fire here; what this pins
    // is that the message names the branch an operator has to go and fix.
    const { fns } = loadRunRef({
      commitReply: { committed: true, sha: "dead123", branch: "main" },
    });
    const out = await fns.integrateWave(accepted, 0, 2, "rungate/run-420");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("main");
  });

  test("SC-1565: a commit that reports no branch at all is refused", async () => {
    // The only case the comparison CANNOT reach: the agent reported no branch,
    // so there is nothing to compare, and the run ref is empty too because
    // `integrateWave` was reached without one. Without this the re-check below
    // the comparison would be a line no test could turn red — the inverse of
    // the defect the first SC-1565 case documents.
    const { fns } = loadRunRef({
      commitReply: { committed: true, sha: "dead123", branch: "" },
    });
    const out = await fns.integrateWave(accepted, 0, 2, "");
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/detached|no branch/i);
  });

  test("SC-1571: a wave carrying a foreign worktree is not staged at all", async () => {
    // The COLLECT-IDENTITY block calls itself the last statement before
    // anything is staged, and warns that a third staging path added later
    // "would be committed from without passing either of them". The wave
    // commit IS that third path — it stages while that block is still
    // waiting for the decomposition to return — so the same guard is asked
    // here, and asked BEFORE the collector, not after it.
    const { fns, calls } = loadRunRef({});
    const foreign = [
      {
        ok: true,
        buildResult: {
          success: true,
          worktreePath: "/tmp/wt-elsewhere",
          worktreeRepo: "git@github.com:someone-else/other-project.git",
          filesChanged: ["a.ts"],
        },
      },
    ];
    const out = await fns.integrateWave(foreign, 0, 2, "fix/420");
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/cannot be staged/);
    // Nothing was collected and nothing was committed — the refusal is before
    // the collector, not a report written after the files had moved.
    expect(calls).toEqual([]);
  });

  test("SC-1566: a collect that moved nothing does not produce an empty commit", async () => {
    const { fns, calls } = loadRunRef({ collect: { ok: true, collected: 0 } });
    const out = await fns.integrateWave(accepted, 0, 2, "fix/420");
    expect(out.ok).toBe(true);
    expect(out.integrated).toBe(0);
    expect(calls.find(c => c.label === "commit-wave-1")).toBeUndefined();
  });
});

/**
 * Covers SC-2084..SC-2088 (HARNESS-STANDARD.md), #652.
 *
 * Two consecutive ship runs died at `IMPLEMENT_FAILED` carrying one sentence —
 * "the wave commit did not report success" — and both needed hand assembly.
 * The journal for `wf_9bb6f96d-200` holds the answer the run was holding and
 * discarded: `collect-wave-1` succeeded with four files staged, then
 * `commit-wave-1` replied `{committed:false, branch:"main", sha:""}`. A peer
 * session had moved the shared `PROJECT_ROOT` checkout onto `main` mid-run and
 * the commit prompt's own `main|master` guard refused, exactly as it should.
 *
 * `integrateWave` returned the generic sentence on `committed !== true` and
 * RETURNED. The comparison that would have named `main` and the run ref is the
 * next statement, so it never ran — the branch the agent reported was read
 * into nothing. An operator is told a commit failed and not told that their
 * checkout is the reason, which is the difference between a one-line `git
 * switch` and hand-assembling a run.
 *
 * ## Four cells, because `committed` and the branch are two readings
 *
 * `committed` says whether a commit happened. The branch says WHERE the
 * checkout was. They are independent, and folding them into one `if` is what
 * made two of the four cells unreachable. All four are driven here, each as
 * its own case, and the two cells where the branch disagrees both name it —
 * that is the clause `committed !== true` was eating.
 *
 * ## The cheapest wrong fix, and whether these cases survive it
 *
 * Delete or widen the commit prompt's `case "$branch" in main|master) …
 * exit 1`. The symptom is a refusal, so the 5pm repair is to stop refusing:
 * the wave commits, the run completes, and unreviewed agent output lands on
 * the default branch — #267/#136 verbatim, which on 2026-10-11 left 907 lines
 * of it staged on `main`.
 *
 * Every case below SURVIVES that fix, and survives it VACUOUSLY rather than by
 * catching it: the commit reply is injected here, so no shell guard runs in
 * any of them and widening or deleting it changes none of their verdicts.
 * What catches it is SC-1564 above, which reads the prompt text and asserts
 * `main|master` is in it. The halves are deliberately separate — a case that
 * both read the prompt and judged the reply would be two questions in one
 * assertion (#484), and would go green under half a repair.
 */
describe("#652 — a wave commit refusal names the branch it was handed", () => {
  const RUN_REF = "rungate/run-652";
  // The sentence the two dead runs got, and the whole of what they got.
  const GENERIC = "the wave commit did not report success";
  // An alternation, not the exact sentence. What AC-1 asks is that the detail
  // still SAYS no commit happened once it has learned to name the branch;
  // pinning the wording would turn a reworded-but-correct message red, which
  // is a detector narrower than the thing it detects.
  const SAYS_NO_COMMIT = /did not report success|did not commit|no commit|commit failed|was not committed/i;

  const accepted = [
    {
      ok: true,
      buildResult: {
        success: true,
        worktreePath: "/tmp/wt1",
        worktreeRepo: "git@github.com:owner/project.git",
        filesChanged: ["a.ts"],
      },
    },
  ];

  async function integrate(commitReply: unknown) {
    const { fns } = loadRunRef({ commitReply });
    return await fns.integrateWave(accepted, 0, 2, RUN_REF);
  }

  // `main` for the committed:false cell, because that is the reply the dead
  // run actually produced. `fix/someone-elses-work` for the committed:true
  // cell, because a default branch is caught by `runRefRefusal` as well as by
  // the comparison, and SC-1565 already measured that pair at 0 of 196 red —
  // two deciders agreeing is one decider (SC-1565's own comment says so).
  const FOREIGN_REF = "fix/someone-elses-work";

  test("SC-2084: all four committed-by-branch cells are separate outcomes", async () => {
    const tt = await integrate({ committed: true, sha: "abc1234", branch: RUN_REF });
    const tf = await integrate({ committed: true, sha: "dead123", branch: FOREIGN_REF });
    const ft = await integrate({ committed: false, sha: "", branch: RUN_REF });
    const ff = await integrate({ committed: false, sha: "", branch: "main" });

    // Exactly one cell succeeds. Without this a decider that refused
    // everything, or accepted everything, would satisfy half the file.
    expect([tt.ok, tf.ok, ft.ok, ff.ok]).toEqual([true, false, false, false]);

    // AC-2: the branch disagreement is reported in BOTH committed arms. This
    // is the clause the `committed !== true` early return ate — `ff` is the
    // reply `wf_9bb6f96d-200` got.
    for (const [name, out, landed] of [["tf", tf, FOREIGN_REF], ["ff", ff, "main"]] as const) {
      expect(out.detail, `${name} must name the branch it landed on`).toContain(landed);
      expect(out.detail, `${name} must name the ref it expected`).toContain(RUN_REF);
    }

    // And the three failures are three different sentences. Composing one
    // message for every failing cell would satisfy every `toContain` above
    // while telling an operator the same thing in all three.
    expect(new Set([tf.detail, ft.detail, ff.detail]).size).toBe(3);

    // That set is not enough on its own, and the battery said so: one
    // composed message for every failing cell measured 1 red where 2 was
    // predicted, because `tf` and `ff` name DIFFERENT branches, so the three
    // strings differ whatever the sentence around them is. Distinctness by
    // branch name is not distinctness by cell.
    //
    // So vary exactly ONE reading. `tm` and `ff` report the same branch and
    // differ only in `committed`, which makes this a measurement of the flag
    // rather than of the string interpolated beside it (#585).
    const tm = await integrate({ committed: true, sha: "dead123", branch: "main" });
    expect(tm.ok).toBe(false);
    expect(tm.detail, "a commit that landed on main and one that never happened are different facts")
      .not.toBe(ff.detail);
  });

  test("SC-2085: committed true onto another ref names both, and does not claim the commit failed", async () => {
    const out = await integrate({ committed: true, sha: "dead123", branch: FOREIGN_REF });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain(FOREIGN_REF);
    expect(out.detail).toContain(RUN_REF);
    // A commit DID happen in this cell; it landed in the wrong place. Saying
    // "did not report success" here would be false, and asserting its absence
    // is what stops the cheap repair of appending the generic sentence to
    // every failure — which would pass every `toContain` in this describe.
    expect(out.detail).not.toMatch(SAYS_NO_COMMIT);
  });

  test("SC-2086: committed false naming main names main and the run ref", async () => {
    // AC-1 verbatim: the reply `wf_9bb6f96d-200` recorded, against the run ref
    // this issue is shipping under.
    const out = await integrate({ committed: false, branch: "main", sha: "" });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("main");
    expect(out.detail).toContain(RUN_REF);
    // Both facts, not one: no commit happened AND the checkout is elsewhere.
    expect(out.detail).toMatch(SAYS_NO_COMMIT);
    // The regression stated as the exact string the two dead runs carried.
    expect(out.detail).not.toBe(GENERIC);
  });

  test("SC-2087: committed false on the run ref reports the commit, and invents no branch", async () => {
    // The cell with nothing to disagree about. It exists so the branch clause
    // cannot be unconditional: a detail that named a disagreement here would
    // be reporting one that did not happen, and `git commit` exiting non-zero
    // on the right branch is an ordinary failure with an ordinary cause.
    const out = await integrate({ committed: false, sha: "", branch: RUN_REF });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(SAYS_NO_COMMIT);
    expect(out.detail).toContain(RUN_REF);
    expect(out.detail).not.toContain("main");
  });

  test("SC-2088: committed false with no branch at all names no branch", async () => {
    // The positive control for the two cells above. The agent reported
    // nothing about where it was, so there is nothing to name — and a
    // composition that always appends a branch clause would print an empty
    // one here and read as a disagreement with the ref.
    const out = await integrate({ committed: false, sha: "", branch: "" });
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(SAYS_NO_COMMIT);
    expect(out.detail).not.toContain("main");
    expect(out.detail).not.toContain(FOREIGN_REF);
    // Nothing about a branch AT ALL, not merely no branch name. "it reported
    // branch , not the run ref rungate/run-652" names neither `main` nor any
    // other branch and would satisfy the two lines above while printing an
    // empty branch clause — which is what an unconditional composition does
    // to the one cell that has nothing to compose.
    expect(out.detail).not.toMatch(/branch|run ref|rungate\//i);
  });
});

describe("#420 — the dispatch path", () => {
  type Spawn = { label: string; at: number };

  function loadDispatch(opts: {
    branchAfter?: string;
    failTitles?: string[];
    integrateFails?: boolean;
    // #652. One reply per time the dispatcher asks where the shared checkout
    // is; the last entry is reused if it asks more often. The default below is
    // unchanged for every caller that passes none, so the #420 cases are
    // driven by exactly the harness they were written against.
    refReplies?: Array<{ branch: string; refusal: string | null }>;
    // #592. One reply per time the dispatcher asks which TREE the session is
    // in; the last entry is reused if it asks more often. Defaulting to a
    // clean reading leaves every #420/#652 case driven by exactly the
    // harness it was written against.
    baseReplies?: Array<{ reading: string; refusal: string | null }>;
  }) {
    const spawns: Spawn[] = [];
    const integrations: Array<{ waveIndex: number; total: number; accepted: number; runRef: unknown }> = [];
    // `at` is the spawn clock, so a read is ordered against the spawns rather
    // than against the other reads: "before wave 2's agents" is the claim
    // #652 AC-3 makes, and a count of reads cannot witness it.
    const refReads: Array<{ at: number; branch: string }> = [];
    /** #592: ordered against the same spawn clock, for the same reason. */
    const baseReads: Array<{ at: number; reading: string }> = [];
    const logs: string[] = [];
    let clock = 0;

    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
      "taskSourceRefusal", "establishRunRef", "integrateWave", "waveNeedsIntegration",
      "measureLaunchBase",
      `${SHAPE_BLOCK}\n${DECOMPOSED_BLOCK}\nreturn runDecomposedShip;`,
    );

    const runDecomposedShip = factory(
      (m: string) => logs.push(String(m)),
      async (prompt: string, o: { label: string }) => {
        spawns.push({ label: o.label, at: clock++ });
        const title = /## Sub-issue: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
        await new Promise(r => setTimeout(r, 5));
        return {
          success: !(opts.failTitles || []).includes(title),
          filesChanged: [`${title}.ts`],
          worktreePath: `/tmp/wt-${title}`,
          worktreeRepo: "owner/project",
          testOutput: "ok",
          taskSource: "marcus-brief.md",
        };
      },
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      "/tmp/work",
      420,
      "/tmp/project",
      {},
      async () => ({ success: true, buildResult: {} }),
      () => null,
      () => ({ refusal: null }),
      "owner/project",
      () => null,
      async () => {
        const seq = opts.refReplies;
        const reply = seq && seq.length > 0
          ? seq[Math.min(refReads.length, seq.length - 1)]
          : { branch: opts.branchAfter ?? "rungate/run-420", refusal: null };
        refReads.push({ at: clock, branch: reply.branch });
        return reply;
      },
      async (acc: unknown[], waveIndex: number, total: number, runRef: unknown) => {
        integrations.push({ waveIndex, total, accepted: acc.length, runRef });
        return opts.integrateFails
          ? { ok: false, integrated: 0, detail: "collect failed" }
          : { ok: true, integrated: 1 };
      },
      // The real predicate, from its own markers. A stub here would let the
      // loop and the block disagree about which waves hand output forward
      // and nothing would notice.
      loadRunRef({}).fns.waveNeedsIntegration,
      async () => {
        const seq = opts.baseReplies;
        const reply = seq && seq.length > 0
          ? seq[Math.min(baseReads.length, seq.length - 1)]
          : { reading: "SAME_CHECKOUT", refusal: null };
        baseReads.push({ at: clock, reading: reply.reading });
        return reply;
      },
    ) as (subIssues: unknown[]) => Promise<any>;

    return { runDecomposedShip, spawns, integrations, refReads, baseReads, logs };
  }

  const LAYERED = [
    { title: "foundation", acs: ["a"], filesToModify: ["paths.ts"], size: "M" },
    { title: "consumer", acs: ["b"], filesToModify: ["use.ts"], size: "M", dependsOn: ["foundation"] },
  ];

  const INDEPENDENT = [
    { title: "alpha", acs: ["a"], filesToModify: ["a.ts"], size: "M" },
    { title: "beta", acs: ["b"], filesToModify: ["b.ts"], size: "M" },
  ];

  test("SC-1567: each wave but the last is integrated, with only its accepted output", async () => {
    const d = loadDispatch({});
    const result = await d.runDecomposedShip(LAYERED);
    expect(result.success, JSON.stringify(result.failed || [])).toBe(true);
    // Two waves, one barrier, one integration — and it is the FIRST wave's.
    // The run ref is recorded alongside, because #652 makes it a value that
    // can change between waves rather than a constant set once.
    expect(d.integrations).toEqual([
      { waveIndex: 0, total: 2, accepted: 1, runRef: "rungate/run-420" },
    ]);
  });

  test("SC-1568: a failed wave integrates nothing, and so does a single wave", async () => {
    const failed = loadDispatch({ failTitles: ["foundation"] });
    const r1 = await failed.runDecomposedShip(LAYERED);
    expect(r1.success).toBe(false);
    // SC-4: wave 1 was rejected, so nothing from it reaches the ref wave 2
    // would have branched from.
    expect(failed.integrations).toEqual([]);

    // One wave hands its output to nobody. Establishing a ref for it would
    // move an operator's checkout off their branch to no purpose — so the
    // run ref is not established either.
    const single = loadDispatch({});
    const r2 = await single.runDecomposedShip(INDEPENDENT);
    expect(r2.success, JSON.stringify(r2.failed || [])).toBe(true);
    expect(single.integrations).toEqual([]);
    expect(single.logs.join("\n")).not.toContain("Run ref for this decomposition");

    // The positive control, and the reason this assertion is in the same test:
    // a design that serialised everything to get visibility would satisfy
    // every ordering case above for free. Both independent sub-issues must
    // still be SPAWNED before either returns.
    expect(single.spawns.map(s => s.at)).toEqual([0, 1]);
  });

  test("SC-1569: a wave that cannot be integrated fails the run rather than dispatching on", async () => {
    const d = loadDispatch({ integrateFails: true });
    const result = await d.runDecomposedShip(LAYERED);
    expect(result.success).toBe(false);
    // The consumer never starts: it would have branched from a checkout
    // without the foundation, which is the whole defect.
    expect(d.spawns.map(s => s.label)).toEqual(["marcus-sub-420001"]);
    const titles = (result.failed || []).map((f: { title: string }) => f.title);
    expect(titles).toContain("foundation");
    expect(JSON.stringify(result.failed)).toContain("could not be integrated");
  });

  test("SC-1570: a checkout the run may not commit onto refuses before anything spawns", async () => {
    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
      "taskSourceRefusal", "establishRunRef", "integrateWave", "waveNeedsIntegration",
      "measureLaunchBase",
      `${SHAPE_BLOCK}\n${DECOMPOSED_BLOCK}\nreturn runDecomposedShip;`,
    );
    const spawns: string[] = [];
    const run = factory(
      () => {},
      async (_p: string, o: { label: string }) => { spawns.push(o.label); return { success: true }; },
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      "/tmp/work", 420, "/tmp/project", {},
      async () => ({ success: true, buildResult: {} }),
      () => null,
      () => ({ refusal: null }),
      "owner/project",
      () => null,
      // The real refusal text, from the real decider.
      async () => {
        const { fns } = loadRunRef({});
        return { branch: "main", refusal: fns.runRefRefusal("main") };
      },
      async () => ({ ok: true, integrated: 1 }),
      loadRunRef({}).fns.waveNeedsIntegration,
      async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
    ) as (subIssues: unknown[]) => Promise<any>;

    const result = await run(LAYERED);
    expect(result.success).toBe(false);
    expect(result.refusal).toMatch(/main/);
    // SC-3: nothing ran, so nothing could have committed anywhere.
    expect(spawns).toEqual([]);
  });

  /*
   * Covers SC-2089..SC-2091 (HARNESS-STANDARD.md), #652.
   *
   * SC-1570 above asks the question once, before the first spawn, and #420
   * shipped exactly that. The input it did not consider is that `PROJECT_ROOT`
   * is SHARED: `wf_9bb6f96d-200` established `rungate/run-652`, dispatched
   * wave 1, and a peer session moved the checkout onto `main` while wave 1 was
   * running. By the time the wave commit asked, the ref the run had checked
   * was no longer the ref it was standing on — and the first thing to notice
   * was the commit, after the wave's whole budget had been spent.
   *
   * So the reading is taken again before each wave after the first, and it is
   * taken through `establishRunRef` — the SAME binding SC-1570's refusal comes
   * from. That is the contract these three cases pin, and it is pinned by the
   * `new Function` argument list in `loadDispatch`: a re-read written as a new
   * injected helper would be a ReferenceError here rather than a quiet second
   * decider, which is the loud-abort property the block-slicing harness exists
   * for. `establishRunRef` already switches a checkout that has drifted onto a
   * default branch and returns a refusal only when it cannot, so "refuses or
   * re-establishes" is one call and not two deciders that agree.
   *
   * ## The cheapest wrong fix, and whether these cases survive it
   *
   * The same one the describe above names: delete or widen the commit
   * prompt's `main|master` guard, because the thing an operator SEES is that
   * guard refusing. These three cases SURVIVE it, and unlike the commit-reply
   * cases they survive it non-vacuously: they never reach a commit at all.
   * The refusal here is `runRefRefusal`'s, raised before wave 2's agents are
   * spawned, so a run with no prompt guard left still fails SC-2090 — the
   * checkout is still on `main` and the dispatcher still has to say so.
   */
  const CHAINED = [
    { title: "foundation", acs: ["a"], filesToModify: ["paths.ts"], size: "M" },
    { title: "consumer", acs: ["b"], filesToModify: ["use.ts"], size: "M", dependsOn: ["foundation"] },
    { title: "finisher", acs: ["c"], filesToModify: ["end.ts"], size: "M", dependsOn: ["consumer"] },
  ];

  test("SC-2089: the shared checkout is re-read before each wave after the first", async () => {
    const d = loadDispatch({});
    const result = await d.runDecomposedShip(LAYERED);
    expect(result.success, JSON.stringify(result.failed || [])).toBe(true);

    // Two waves, two readings — not one taken before the run and trusted for
    // its duration, which is #420's behaviour and the whole of #652.
    expect(d.refReads.length).toBe(2);
    // And the second one lands BETWEEN the two spawns. A count alone is
    // satisfied by a second read taken after wave 2 had already started,
    // which would observe the drift too late to stop anything.
    expect(d.refReads.map(r => r.at)).toEqual([0, 1]);
    expect(d.spawns.map(s => s.label)).toEqual(["marcus-sub-420001", "marcus-sub-420002"]);

    // The single-wave control, in the same case for the reason SC-1568 gives:
    // a wave with no successor hands its output to nobody, so asking where
    // the operator's checkout is would be asking to no purpose.
    const single = loadDispatch({});
    await single.runDecomposedShip(INDEPENDENT);
    expect(single.refReads).toEqual([]);
  });

  test("SC-2090: a checkout that moved off the run ref refuses, and that wave spawns nothing", async () => {
    const moved = loadRunRef({}).fns.runRefRefusal("main");
    const d = loadDispatch({
      refReplies: [
        { branch: "rungate/run-420", refusal: null },
        // The peer session's move, observed on the second reading.
        { branch: "main", refusal: moved },
      ],
    });
    const result = await d.runDecomposedShip(LAYERED);

    expect(result.success).toBe(false);
    // AC-3's second half: the spawn list for the refused wave is EMPTY. Wave
    // 1 ran — it ran before the drift — and the consumer never starts, so the
    // wave's budget is not spent discovering this at commit time.
    expect(d.spawns.map(s => s.label)).toEqual(["marcus-sub-420001"]);
    // The refusal text comes from the real decider, not from a sentence this
    // test invented, and it reaches the caller rather than only the log.
    const said = JSON.stringify([result.refusal ?? null, result.failed ?? []]);
    expect(said).toContain("the project checkout is on main");
    expect((result.failed || []).map((f: { title: string }) => f.title)).toContain("consumer");
  });

  test("SC-2091: a re-established ref is the one the next wave commits onto", async () => {
    // Three waves, so there are two integrations to compare. The second
    // reading returns a DIFFERENT ref name on purpose: `runRefName` is
    // deterministic, so a re-read that returned the same string would be
    // indistinguishable from the `let runRef` #420 sets once and never
    // touches again, and the assertion would hold with the feature deleted.
    const d = loadDispatch({
      refReplies: [
        { branch: "rungate/run-420", refusal: null },
        { branch: "rungate/run-420-reestablished", refusal: null },
      ],
    });
    const result = await d.runDecomposedShip(CHAINED);
    expect(result.success, JSON.stringify(result.failed || [])).toBe(true);

    expect(d.refReads.length).toBe(3);
    expect(d.spawns.map(s => s.label)).toEqual([
      "marcus-sub-420001", "marcus-sub-420002", "marcus-sub-420003",
    ]);
    // The value flows from the reading to the commit. Wave 1 went onto what
    // the first read said; wave 2 goes onto what the second read said.
    expect(d.integrations.map(i => i.runRef)).toEqual([
      "rungate/run-420", "rungate/run-420-reestablished",
    ]);
  });

  /*
   * #592 — an isolated agent resolves its worktree from ambient cwd, not the
   * run's projectRoot.
   *
   * Run `wf_680eb8a6-29a` was launched with `projectRoot` pointing at one
   * project and `repo` at another, and the implement agent cut its worktree
   * inside a THIRD — the harness repository, which is where the launching
   * session's shell happened to be. Twelve agents, ~570k tokens, fourteen
   * minutes, then `IMPLEMENT_FAILED` from #218's guard comparing the remote
   * the checkout actually had.
   *
   * **The issue's suggested fix is not available to this file**, and saying
   * so is the point. "Resolve the worktree parent from projectRoot" is the
   * runtime's decision, not rungate's: `opts.cwd` is applied to the spawned
   * agent AFTER `isolation: 'worktree'` has been resolved against the
   * session's directory, so the explicit argument is passed and overridden
   * (#644). What rungate can do is the issue's second sentence — refuse at
   * spawn time rather than fall back to cwd.
   *
   * #644 did that once, at Goal. These cases are about the gap that leaves:
   * the session is SHARED, the reading is taken minutes or hours before the
   * spawn it governs, and a `cd` in between moves every worktree the wave is
   * about to create. #652 is the same shape one field over — it re-reads the
   * BRANCH before each wave; this re-reads the TREE.
   *
   * ## The cheapest wrong fix, named before the repair
   *
   * **Trust the Goal reading and skip the re-check** — it already passed, so
   * why pay for another agent call per wave. That is the pre-#592 behaviour
   * exactly, and it is correct on every run where nobody moves the session.
   * `AC-2` is the case it does not survive: a first reading that is clean and
   * a second that is not, which no single-reading run can tell from two clean
   * ones.
   *
   * ## What was broken to prove these can fail
   *
   * Run over this file + `test/unit/launch-base.test.ts`. Counts predicted in
   * `/tmp/592-battery/predictions.md` before the battery ran, and **the
   * baseline row read first.**
   *
   * | Row | Predicted | Measured | The input on which mutant and original differ |
   * |---|---|---|---|
   * | **baseline** | 45 pass, 0 fail | **45 pass, 0 fail** | — |
   * | M1 **the cheapest wrong fix / the defect**: the per-wave block deleted, Goal's one reading trusted | 4 | **4 of 45** | a second reading that refuses: the original never spawns wave 2, the mutant dispatches it into the wrong tree |
   * | M2 the re-check moved BELOW the wave's spawns | 3 | **3 of 45** | the same, with the refusal arriving after the agents started |
   * | M3 the drift logged, and the wave spawns anyway | 2 | **2 of 45** | the same: the original settles the sub-issues unstarted, the mutant runs them |
   * | M4 the refusal sentence replaced by a locally composed one | 1 | **1 of 45** | a NOT_A_REPO reading: the original logs the decider's own sentence, the mutant logs "the launch base moved" |
   * | M5 `readLaunchBase`'s absent-reading branch removed | 0, then **1 of 49** | a reply with no `reading` field: the original is UNMEASURED and refuses, the mutant returns an empty reading inside a composed sentence |
   *
   * **AC-5 stays green in M1, and that is the finding rather than a gap.** A
   * run where nobody moves the session is byte-identical with and without
   * the re-check — which is exactly why the defect was invisible until a
   * guard fired 570k tokens later. A control that went red under the defect
   * would mean the re-check was changing clean runs too.
   *
   * **M5 measured 0 first, and the zero was real.** Before recording it the
   * rule is to name an input on which mutant and original differ, and there
   * is one — so it was not a collapsed pair, it was a branch nothing
   * witnessed. The four `readLaunchBase` cases at the foot of this file are
   * what closed it, and the row is 1.
   *
   * Mutations run and reverted from a `cp` backup, never `git checkout --`;
   * `workflows/ship.js` confirmed byte-identical by sha256 after every row.
   */
  describe("#592 — the tree is re-read before each wave, not only at Goal", () => {
    test("AC-1: every wave asks, and each ask is before that wave's spawns", async () => {
      // Ordered against the spawn clock, not counted. A count is satisfied by
      // a reading taken after the wave had already started, which is the one
      // arrangement that measures nothing — #652's SC-2089 makes the same
      // argument about the branch.
      const d = loadDispatch({});
      const result = await d.runDecomposedShip(LAYERED);
      expect(result.success, JSON.stringify(result.failed || [])).toBe(true);
      expect(d.baseReads.length, "a wave was dispatched without asking").toBe(2);
      expect(d.spawns.map(s => s.at)).toEqual([0, 1]);
      expect(d.baseReads.map(r => r.at), "a reading was taken after its own wave spawned")
        .toEqual([0, 1]);
    });

    test("AC-2: a session that moved between waves refuses, and that wave spawns nothing", async () => {
      // The case the cheapest wrong fix does not survive. Reading one is
      // clean, so a run that trusts Goal dispatches wave 2 into the wrong
      // tree and finds out from #218 afterwards.
      const d = loadDispatch({
        baseReplies: [
          { reading: "SAME_CHECKOUT", refusal: null },
          {
            reading: "DIFFERENT_CHECKOUT",
            refusal: "LAUNCH_BASE_DIFFERENT_CHECKOUT: /Users/x/Projects/rungate is not /tmp/project",
          },
        ],
      });
      const result = await d.runDecomposedShip(LAYERED);
      expect(result.success).toBe(false);
      // Wave 1 ran; wave 2's agent never started. The count is the property:
      // a refusal taken after the spawn would leave two labels here.
      expect(d.spawns.map(s => s.label)).toEqual(["marcus-sub-420001"]);
      expect(JSON.stringify(result.failed)).toContain("wrong one");
    });

    test("AC-3: the refusal carries the reading's own sentence, not a rewrite of it", async () => {
      // The decider is `lib/launch-base.ts` through `readLaunchBase`. A
      // second sentence composed here would be a second decider about why
      // the run stopped, and the two would drift (#484).
      const d = loadDispatch({
        baseReplies: [
          {
            reading: "NOT_A_REPO",
            refusal: "LAUNCH_BASE_NOT_A_REPO: the launching session is not in a git repository",
          },
        ],
      });
      await d.runDecomposedShip(LAYERED);
      expect(d.logs.join("\n")).toContain("LAUNCH_BASE_NOT_A_REPO");
      expect(d.logs.join("\n")).toContain("not in a git repository");
    });

    test("AC-4: wave ONE is covered too — Goal is not the spawn it governs", async () => {
      // The reading #644 takes at Goal happens before the issue is read,
      // before discovery, before decomposition. Treating it as current at
      // the first spawn is the same assumption this issue is about, one wave
      // earlier, so the first wave asks as well.
      const d = loadDispatch({
        baseReplies: [
          { reading: "DIFFERENT_CHECKOUT", refusal: "LAUNCH_BASE_DIFFERENT_CHECKOUT: moved before wave 1" },
        ],
      });
      const result = await d.runDecomposedShip(INDEPENDENT);
      expect(result.success).toBe(false);
      expect(d.spawns, "the first wave spawned into a tree nobody had re-checked").toEqual([]);
    });

    test("AC-5: a clean reading costs nothing — the control", async () => {
      // Without this, every case above is satisfied by a dispatcher that
      // refuses every wave.
      const d = loadDispatch({ baseReplies: [{ reading: "SAME_CHECKOUT", refusal: null }] });
      const result = await d.runDecomposedShip(INDEPENDENT);
      expect(result.success, JSON.stringify(result.failed || [])).toBe(true);
      expect(d.spawns.map(s => s.label).sort()).toEqual(["marcus-sub-420001", "marcus-sub-420002"]);
    });
  });
});

/*
 * #592 — the reply reader, which row M5 of the battery found unwitnessed.
 *
 * `readLaunchBase` turns an agent's restatement of the check's output into a
 * reading and a refusal. Short-circuiting its absent-reading branch measured
 * **0 red** across every case in this file and `test/unit/launch-base.test.ts`,
 * and the mutant and the original genuinely differ — a reply with no
 * `reading` field returns UNMEASURED and a refusal on one, and an empty
 * reading with a composed sentence on the other. So the zero was a gap, not
 * a collapsed pair, and these are the cases that close it.
 *
 * The block is extracted rather than imported: ship.js runs in the Workflow
 * sandbox and is not a module (#69).
 */
describe("#592 — an absent or self-contradicting launch-base reply is UNMEASURED", () => {
  const readLaunchBase = (() => {
    const START = "// ──── LAUNCH-BASE-CHECK-START ────";
    const END = "// ──── LAUNCH-BASE-CHECK-END ────";
    const a = shipSource.indexOf(START);
    const b = shipSource.indexOf(END);
    if (a < 0 || b < 0) throw new Error("ship.js is missing the LAUNCH-BASE-CHECK markers");
    // Up to `measureLaunchBase` and no further. That function contains a
    // top-level `await`, which is a syntax error inside a non-async
    // `new Function` body — and the cut has to be ANCHORED rather than sized,
    // because the first draft of this cut named `const launchBaseReply`, a
    // binding #592 had just renamed away. `indexOf` returned -1, the slice
    // ran to the end of the block, and the whole describe died at module
    // scope with one unhandled error and zero reported failures (#664).
    const stop = shipSource.indexOf("async function measureLaunchBase", a);
    if (stop < 0 || stop > b) {
      throw new Error("ship.js no longer defines measureLaunchBase inside the LAUNCH-BASE-CHECK block");
    }
    const body = shipSource.slice(a, stop);
    const fn = new Function("PROJECT_ROOT", `${body}\nreturn readLaunchBase`)("/tmp/project");
    if (typeof fn !== "function") throw new Error("the block does not define readLaunchBase");
    return fn as (reply: unknown) => { reading: string; refusal: string | null };
  })();

  test("a reply with no reading at all is UNMEASURED and refuses", () => {
    // The silent-fallback shape this whole issue is about: a run launched by
    // the absence of an answer is launched by nothing.
    for (const empty of [undefined, null, {}, { cwd: "/tmp/x" }]) {
      const r = readLaunchBase(empty);
      expect(r.reading, `${JSON.stringify(empty)} was read as a measurement`).toBe("UNMEASURED");
      expect(r.refusal, "an unmeasured launch base did not stop the run").toBeTruthy();
    }
  });

  test("SAME_CHECKOUT with a non-zero exit is a contradiction, not a pass", () => {
    // The script exits non-zero for every reading but this one, so a reply
    // asserting both restated something that cannot have happened.
    const r = readLaunchBase({ reading: "SAME_CHECKOUT", exitCode: 1 });
    expect(r.reading).toBe("UNMEASURED");
    expect(r.refusal).toContain("SAME_CHECKOUT");
  });

  test("...and the control: SAME_CHECKOUT with exit 0 proceeds", () => {
    // Without this the two cases above are satisfied by a reader that
    // refuses everything.
    const r = readLaunchBase({ reading: "SAME_CHECKOUT", exitCode: 0 });
    expect(r.reading).toBe("SAME_CHECKOUT");
    expect(r.refusal).toBeNull();
  });

  test("a refusing reading with no reason still names the two trees", () => {
    // An operator reading "LAUNCH_BASE_DIFFERENT_CHECKOUT:" and nothing else
    // cannot act on it, and the reason is the only part that says what to
    // change.
    const r = readLaunchBase({ reading: "DIFFERENT_CHECKOUT", cwd: "/Users/x/other", refusal: null });
    expect(r.refusal).toContain("/Users/x/other");
    expect(r.refusal).toContain("/tmp/project");
  });
});
