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
