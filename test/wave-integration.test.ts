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
 */

import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const RUN_REPO = "owner/project";
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

// `source` defaults to the real ship.js. It is a parameter because #627's
// cases below slice the same blocks out of MUTANTS of that text, and a second
// slicer would let the two disagree about where a block begins.
function sliceBlock(name: string, source: string = shipSource): string {
  const a = source.indexOf(`// ──── ${name}-START ────`);
  const b = source.indexOf(`// ──── ${name}-END ────`);
  expect(a, `ship.js is missing the ${name}-START marker`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing the ${name}-END marker`).toBeGreaterThan(a);
  // Exactly once each: a second copy would survive any mutation of the first
  // and the guard would go green for the wrong reason.
  expect(source.indexOf(`// ──── ${name}-START ────`, a + 1)).toBe(-1);
  expect(source.indexOf(`// ──── ${name}-END ────`, b + 1)).toBe(-1);
  return source.slice(a, b);
}

const RUN_REF_BLOCK = sliceBlock("RUN-REF");
const DECOMPOSED_BLOCK = sliceBlock("DECOMPOSED-SHIP");
// #611 put a free reference in the decomposed block. The real block text is
// evaluated alongside it rather than stubbed — a stub would let this suite
// and ship.js disagree about what a reported path is.
const SHAPE_BLOCK = sliceBlock("FILES-CHANGED-SHAPE");

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
    `${RUN_REF_BLOCK}
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

describe("#420 — the dispatch path", () => {
  type Spawn = { label: string; at: number };

  function loadDispatch(opts: {
    branchAfter?: string;
    failTitles?: string[];
    integrateFails?: boolean;
  }) {
    const spawns: Spawn[] = [];
    const integrations: Array<{ waveIndex: number; total: number; accepted: number }> = [];
    const logs: string[] = [];
    let clock = 0;

    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
      "taskSourceRefusal", "establishRunRef", "integrateWave", "waveNeedsIntegration",
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
      async () => ({ branch: opts.branchAfter ?? "rungate/run-420", refusal: null }),
      async (acc: unknown[], waveIndex: number, total: number) => {
        integrations.push({ waveIndex, total, accepted: acc.length });
        return opts.integrateFails
          ? { ok: false, integrated: 0, detail: "collect failed" }
          : { ok: true, integrated: 1 };
      },
      // The real predicate, from its own markers. A stub here would let the
      // loop and the block disagree about which waves hand output forward
      // and nothing would notice.
      loadRunRef({}).fns.waveNeedsIntegration,
    ) as (subIssues: unknown[]) => Promise<any>;

    return { runDecomposedShip, spawns, integrations, logs };
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
    expect(d.integrations).toEqual([{ waveIndex: 0, total: 2, accepted: 1 }]);
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
    ) as (subIssues: unknown[]) => Promise<any>;

    const result = await run(LAYERED);
    expect(result.success).toBe(false);
    expect(result.refusal).toMatch(/main/);
    // SC-3: nothing ran, so nothing could have committed anywhere.
    expect(spawns).toEqual([]);
  });
});

// ── #627 ─────────────────────────────────────────────────────
//
// covers #627 AC-4, AC-5, AC-6.
//
// #420 added `integrateWave` and handed `collectAgentWork` the bare
// `buildResult`s. #178's claim is a SIBLING of the build result, not a field
// inside it, so every row arrived with `claimedFiles` undefined and SC-413
// read a wave in which nobody had claimed anything. On the run this
// reproduces, three worktrees built correct, non-overlapping work — every
// reported file inside its own claim — and the wave was refused with "no
// worktree claimed that file" for every file in it.
//
// Three properties make this a witness rather than a description, and each
// one is a thing the earlier draft of this case did not have:
//
//   THREE worktrees, driven through the WAVE path. With one worktree
//   `SINGLE_WORKTREE_EXEMPT` keeps every file whether a claim travelled or
//   not, so the case would reach its assertion without the feature; and the
//   end-of-run path has carried the claim since #178, so a case driven
//   through it is green over the defect.
//
//   The REAL `collectAgentWork`, not a stand-in that re-runs the audit. The
//   question is what the collector is HANDED, and only the collector can
//   answer it. The rows it receives are recorded before it runs.
//
//   Its own worktree tree, in a temp directory, under paths that exist
//   nowhere in this repository (AC-6). The nine paths the run refused are
//   ordinary source files that will move; a case keyed to them stops
//   witnessing the moment they do.

/** The one expression that pairs each wave result with its sub-issue's claim. */
const WAVE_PAIRING =
  "waveResults.map(r => (r && r.buildResult ? { ...r, buildResult: claimedWork(r) } : r))";

/**
 * The claim guard, and the widening that is the cheapest wrong fix for the
 * symptom this reproduces.
 *
 * An operator watching a wave die of "no worktree claimed that file" has a
 * one-word repair available: make an absent claim permit everything. It makes
 * the refusal go away, it leaves the claim exactly as absent as it was, and it
 * reinstates the #296 fail-open for every run. So the case must not be
 * satisfied by it — see `.claude/rules/checks-must-be-able-to-fail.md`, "a
 * case that goes green under the WRONG fix".
 */
const CLAIM_GUARD = "return Array.isArray(claims) ? claims.includes(key) : claimant === wt";
const CLAIM_GUARD_WIDENED = "return Array.isArray(claims) ? claims.includes(key) : true";

function mutate(source: string, from: string, to: string, what: string): string {
  const seen = source.split(from).length - 1;
  // Loud, not quiet: a mutation that was never applied measures nothing, and
  // reads exactly like a mutation nothing caught (#485, #297).
  expect(seen, `could not build the mutant: ${what} appears ${seen} times in ship.js`).toBe(1);
  return source.replace(from, to);
}

interface ClaimRow {
  worktreePath?: string;
  worktreeRepo?: string;
  filesChanged?: string[];
  claimedFiles?: string[];
}

describe("#627 — three worktrees through wave integration", () => {
  // Built once, in a temp directory, and named after nothing in this
  // repository. `FIXTURE_FILES` is asserted to exist nowhere in REPO_ROOT
  // below, which is what keeps the case witnessing after the run's own nine
  // paths move.
  const WAVE_1 = ["alpha", "beta", "delta"] as const;
  const FIXTURE_FILES: Record<string, string[]> = {
    alpha: ["fixture/alpha/reader.ts", "fixture/alpha/reader.probe.ts"],
    beta: ["fixture/beta/counter.ts", "fixture/beta/counter.probe.ts"],
    delta: ["fixture/delta/config.ts", "fixture/delta/config.probe.ts"],
    omega: ["fixture/omega/consumer.ts"],
  };
  const CLAIMED_TOTAL = WAVE_1.reduce((n, t) => n + FIXTURE_FILES[t]!.length, 0);

  let root: string;
  let project: string;
  let worktrees: string;

  const worktreeFor = (title: string) => join(worktrees, `wf_fixture-${title}`);

  /** Every file under a worktree, worktree-relative — what the agent changed. */
  function filesIn(dir: string, prefix = ""): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory()
        ? filesIn(join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`]);
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rg-627-wave-")));
    project = join(root, "project");
    worktrees = join(project, ".claude", "worktrees");
    mkdirSync(worktrees, { recursive: true });
    for (const [title, files] of Object.entries(FIXTURE_FILES)) {
      for (const rel of files) {
        const at = join(worktreeFor(title), rel);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, `// ${title} wrote this\n`);
      }
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const SUBS = [
    { title: "alpha", acs: ["a"], filesToModify: FIXTURE_FILES.alpha!, size: "S" },
    { title: "beta", acs: ["b"], filesToModify: FIXTURE_FILES.beta!, size: "S" },
    { title: "delta", acs: ["d"], filesToModify: FIXTURE_FILES.delta!, size: "S" },
    {
      title: "omega", acs: ["o"], filesToModify: FIXTURE_FILES.omega!, size: "S",
      dependsOn: ["alpha", "beta", "delta"],
    },
  ];

  /**
   * `runDecomposedShip` over the REAL `integrateWave` and the REAL
   * `collectAgentWork`, with `source` as the ship.js text — the live file, or
   * a mutant of it.
   *
   * Only the agents are faked. The collect step's reply is derived from the
   * groups payload ship.js actually built, so a collection that was handed
   * nothing cannot report having collected something.
   */
  function loadWaveRun(source: string) {
    const collectRows: ClaimRow[][] = [];
    const groupsSeen: Array<Array<{ worktreePath: string; filesChanged: string[] }>> = [];
    const labels: string[] = [];
    const logs: string[] = [];

    const collectAgentWork = new Function(
      "log", "timedAgent", "WORK_DIR", "PROJECT_ROOT", "HARNESS_ROOT",
      `${[
        sliceBlock("SECURITY-HELPERS", source),
        sliceBlock("COLLECT-DESTINATION", source),
        sliceBlock("COLLECT-CLAIM", source),
        sliceBlock("PRESERVE-REFUSED", source),
        sliceBlock("COLLECT-AGENT-WORK", source),
      ].join("\n")}\nreturn collectAgentWork`,
    )(
      (m: string) => logs.push(String(m)),
      async (prompt: string, o: { label: string }) => {
        labels.push(o.label);
        const payload = prompt.match(/<<'RUNGATE_GROUPS_EOF'\n([\s\S]*?)\nRUNGATE_GROUPS_EOF/);
        if (!payload) return { entries: [] }; // the preserve step (#228)
        const groups = JSON.parse(payload[1]!);
        groupsSeen.push(groups);
        return {
          ok: true,
          collected: groups.reduce((n: number, g: { filesChanged: string[] }) => n + g.filesChanged.length, 0),
        };
      },
      join(root, "work"),
      project,
      project,
    ) as (results: unknown, intoDir: string, phase: string, label: string) => Promise<{
      ok: boolean; collected: number; staged: boolean; detail?: string;
    }>;

    // The rows are recorded BEFORE the collector runs, because what the wave
    // hands over is the question. A spy that read them afterwards would be
    // reading whatever the collector left behind.
    const spyCollect = async (results: unknown, intoDir: string, phase: string, label: string) => {
      collectRows.push(JSON.parse(JSON.stringify(results ?? null)));
      return collectAgentWork(results, intoDir, phase, label);
    };

    const identity = new Function(
      `${sliceBlock("WORKTREE-IDENTITY", source)}\nreturn { worktreeIdentity, worktreeIdentityViolations }`,
    )() as {
      worktreeIdentity: (p: string, repo: string, reported?: string) => { refusal: string | null };
      worktreeIdentityViolations: (rows: unknown[], repo: string, opts?: unknown) => string[];
    };

    const runRef = new Function(
      "timedAgent", "collectAgentWork", "shellQuote", "log", "PROJECT_ROOT", "ISSUE",
      "worktreeIdentityViolations", "REPO",
      `${sliceBlock("RUN-REF", source)}\nreturn { integrateWave, waveNeedsIntegration }`,
    )(
      async (_prompt: string, o: { label: string }) => {
        labels.push(o.label);
        return { committed: true, sha: "c0ffee1", branch: "rungate/run-627" };
      },
      spyCollect,
      (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`,
      (m: string) => logs.push(String(m)),
      project,
      627,
      identity.worktreeIdentityViolations,
      RUN_REPO,
    ) as {
      integrateWave: (a: unknown[], w: number, t: number, ref: string) => Promise<unknown>;
      waveNeedsIntegration: (w: number, t: number) => boolean;
    };

    const runDecomposedShip = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
      "taskSourceRefusal", "establishRunRef", "integrateWave", "waveNeedsIntegration",
      `${sliceBlock("FILES-CHANGED-SHAPE", source)}\n${sliceBlock("DECOMPOSED-SHIP", source)}\nreturn runDecomposedShip`,
    )(
      (m: string) => logs.push(String(m)),
      async (prompt: string, o: { label: string }) => {
        labels.push(o.label);
        const title = /## Sub-issue: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
        const wt = worktreeFor(title);
        return {
          success: true,
          // Read off the TREE, not off the prompt: what a worktree contributes
          // is what is in it, and a reply echoing the claim back could not
          // tell a compliant agent from an empty directory.
          filesChanged: filesIn(wt),
          worktreePath: wt,
          worktreeRepo: `git@github.com:${RUN_REPO}.git`,
          testOutput: "ok",
          taskSource: "brief",
        };
      },
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      join(root, "work"),
      627,
      project,
      {},
      async () => ({ success: true, buildResult: {} }),
      () => null,
      identity.worktreeIdentity,
      RUN_REPO,
      () => null,
      async () => ({ branch: "rungate/run-627", refusal: null }),
      runRef.integrateWave,
      runRef.waveNeedsIntegration,
    ) as (subIssues: unknown[]) => Promise<{
      success: boolean;
      failed: Array<{ title: string; buildResult: { findings?: string[] } | null }>;
      buildResult: { agentResults?: ClaimRow[] };
    }>;

    return { runDecomposedShip, collectRows, groupsSeen, labels, logs };
  }

  /**
   * The regression property, in one place: did each worktree's own claim
   * reach `collectAgentWork`?
   *
   * One definition, used by the live case and by both mutants, so the three
   * cannot drift apart. It deliberately does NOT read the wave's verdict —
   * that is the assertion the cheapest wrong fix satisfies, and a case built
   * on it would certify the regression it exists to block.
   */
  function claimReachedCollector(collectRows: ClaimRow[][]): { reached: boolean; why: string } {
    if (collectRows.length !== 1) {
      return { reached: false, why: `${collectRows.length} collections, expected exactly 1` };
    }
    const rows = collectRows[0]!;
    if (rows.length !== WAVE_1.length) {
      return { reached: false, why: `${rows.length} rows, expected ${WAVE_1.length}` };
    }
    for (const title of WAVE_1) {
      const row = rows.find(r => r.worktreePath === worktreeFor(title));
      if (!row) return { reached: false, why: `no row for ${title}` };
      if (!Array.isArray(row.claimedFiles)) {
        return { reached: false, why: `${title} arrived with no claim at all (claimedFiles is ${typeof row.claimedFiles})` };
      }
      const want = [...FIXTURE_FILES[title]!].sort().join(",");
      const got = [...row.claimedFiles].sort().join(",");
      if (want !== got) return { reached: false, why: `${title} claimed ${got || "nothing"}, expected ${want}` };
    }
    return { reached: true, why: "" };
  }

  test("#627 / AC-6: the fixture is its own tree, and names nothing in this repository", () => {
    // The temp tree really is three worktrees with files in them — otherwise
    // the agents below report an empty `filesChanged` and the collection is
    // refused for a reason that has nothing to do with the claim.
    for (const title of WAVE_1) {
      expect(worktreeFor(title).startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(filesIn(worktreeFor(title)).sort()).toEqual([...FIXTURE_FILES[title]!].sort());
    }
    // AC-6, stated as the property rather than as a list of the nine paths:
    // writing those down here is what would make this case go stale when they
    // move, and it is the thing this asserts the absence of.
    for (const files of Object.values(FIXTURE_FILES)) {
      for (const rel of files) {
        expect(existsSync(join(REPO_ROOT, rel)), `${rel} is a real path in this repo`).toBe(false);
      }
    }
  });

  test("#627 / AC-4: the wave integrates, and the collector is handed each worktree's own claim", async () => {
    const run = loadWaveRun(shipSource);
    const result = await run.runDecomposedShip(SUBS);

    // Observed running before any verdict: a collection that never happened
    // reports no violation either, and that is indistinguishable from a clean
    // one. Exactly one — wave 2 has no successor and is left to the
    // end-of-run collect.
    expect(
      run.collectRows.length,
      `logs: ${run.logs.join(" | ")}`,
    ).toBe(1);

    const verdict = claimReachedCollector(run.collectRows);
    expect(verdict.reached, verdict.why).toBe(true);

    // And the work was actually staged: six claimed files across three
    // worktrees reached the collect script's groups payload.
    expect(run.groupsSeen).toHaveLength(1);
    expect(run.groupsSeen[0]!.reduce((n, g) => n + g.filesChanged.length, 0)).toBe(CLAIMED_TOTAL);

    expect(result.success, JSON.stringify(result.failed)).toBe(true);
    expect(run.logs.join("\n")).toContain("Wave 1 integrated onto rungate/run-627");
    // Wave 2 ran, which is what the defect cost: four sub-issue agents, not
    // three and a dead run.
    expect(run.labels.filter(l => l.startsWith("marcus-sub-"))).toHaveLength(SUBS.length);
  });

  test("#627 / AC-5: with the pairing removed the same wave is refused, every file unclaimed", async () => {
    // Mutant one: the pre-#627 wave path, restored. `integrateWave`'s own
    // `accepted.map(r => r && r.buildResult)` then strips the claim on the way
    // in, which is the whole defect.
    const mutant = mutate(shipSource, WAVE_PAIRING, "waveResults", "the wave pairing expression");
    const run = loadWaveRun(mutant);
    const result = await run.runDecomposedShip(SUBS);

    // It still RAN. A mutant that threw before reaching the collector is also
    // "not success", and that is not what this measures.
    expect(run.collectRows.length).toBe(1);

    const verdict = claimReachedCollector(run.collectRows);
    expect(verdict.reached).toBe(false);
    expect(verdict.why).toContain("no claim at all");

    expect(result.success).toBe(false);
    const said = JSON.stringify(result.failed);
    expect(said).toContain("could not be integrated");
    expect(said).toContain("did not claim");
    expect(said).toContain("no worktree claimed that file");
    // Nothing was staged and wave 2 never started — the run dies at the
    // barrier with three worktrees of correct work loose behind it.
    expect(run.groupsSeen).toHaveLength(0);
    expect(run.labels.filter(l => l.startsWith("marcus-sub-"))).toHaveLength(WAVE_1.length);
  });

  test("#627 / AC-5: widening the claim guard silences the refusal and does NOT satisfy this case", async () => {
    // Mutant two: mutant one plus the cheapest repair for the symptom it
    // produces. An absent claim is let through, the wave stops refusing, and
    // nothing about the claim has changed.
    const stripped = mutate(shipSource, WAVE_PAIRING, "waveResults", "the wave pairing expression");
    const widened = mutate(stripped, CLAIM_GUARD, CLAIM_GUARD_WIDENED, "the claim guard");

    // The input on which this mutant and the original differ, named and run
    // rather than assumed (#485): the claim-less rows the stripped wave path
    // produces. The real audit refuses all six; the widened one keeps them.
    const auditOf = (src: string) =>
      new Function(
        "PROJECT_ROOT", "log",
        `${sliceBlock("SECURITY-HELPERS", src)}\n${sliceBlock("COLLECT-CLAIM", src)}\nreturn auditWorktreeClaims`,
      )(project, () => {}) as (rows: ClaimRow[]) => {
        violations: Array<{ detail: string }>;
        candidates: Array<{ filesChanged: string[] }>;
      };
    const claimless: ClaimRow[] = WAVE_1.map(t => ({
      worktreePath: worktreeFor(t),
      worktreeRepo: `git@github.com:${RUN_REPO}.git`,
      filesChanged: FIXTURE_FILES[t]!,
    }));
    expect(auditOf(shipSource)(claimless).violations).toHaveLength(CLAIMED_TOTAL);
    expect(auditOf(widened)(claimless).violations).toHaveLength(0);

    const run = loadWaveRun(widened);
    const result = await run.runDecomposedShip(SUBS);

    // The repair works, on its own terms. A case that asserted only "the wave
    // was not refused" is GREEN right here, over a wave whose claim is as
    // absent as it was before — and would certify the regression at the
    // moment it arrived.
    expect(result.success, JSON.stringify(result.failed)).toBe(true);
    expect(run.logs.join("\n")).toContain("Wave 1 integrated onto rungate/run-627");
    expect(run.labels.filter(l => l.startsWith("marcus-sub-"))).toHaveLength(SUBS.length);

    // This case is not green here, because the property it asserts is where
    // the claim went, not whether anybody complained about its absence.
    const verdict = claimReachedCollector(run.collectRows);
    expect(verdict.reached).toBe(false);
    expect(verdict.why).toContain("no claim at all");
  });
});
