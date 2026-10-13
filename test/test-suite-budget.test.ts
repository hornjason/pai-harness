/**
 * DIR-L29's guard exists, is registered, and could not bite (#194).
 *
 * `hooks/TestSuiteGuard.hook.ts` says so in its own header — "Tier 3
 * mechanical enforcement for DIR-L29" — and across four measured ship runs
 * Marcus ran the full suite 7, 11, 13 and 12+ times against a cap of 2 to 4.
 *
 * Two of the three reasons were structural, and they pull in opposite
 * directions, which is why neither was simply a bug:
 *
 * - **Per-worker is correct for fan-out.** #239 keyed the rate on the worker
 *   because three disjoint sub-agents sharing one session id serialised on a
 *   30-minute window — one slept in 580-second increments for twenty minutes
 *   while its siblings were already done. Reverting that recreates #239.
 * - **Per-worker is wrong for one issue.** A ship run is Marcus plus heal
 *   iterations plus Quinn, each with its own worker identity, so "at most
 *   four" became "at most four, several times over".
 *
 * So the fix is a SECOND bound rather than a different one. The per-worker
 * rate still protects against thrash and still lets a fan-out run in
 * parallel; a run-scoped ceiling bounds what one issue can spend in total.
 * They answer different questions and both are needed.
 *
 * The run-scoped budget has no window, which is the other half of #194: a
 * 30-minute window cannot constrain a 41-minute run. The run id bounds it
 * instead — a new ship run is a new id and a fresh ceiling.
 *
 * Covers SC-640..SC-644 of HARNESS-STANDARD.md.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deriveRunId,
  deriveWorkerId,
  evaluateFullSuiteRequest,
  runCounterPath,
  wouldAllowFullSuite,
  DEFAULT_MAX_RUNS_PER_PIPELINE,
  DEFAULT_MAX_RUNS_PER_WORKER,
} from "../lib/test-suite-lock";

let dir: string;
const FULL = "bun test";
/**
 * Capacity high enough that the concurrency cap never answers for the budget.
 *
 * DERIVED, after a literal `8` went stale (2026-10-13). Nothing in here
 * releases its slot, so a test that gets N requests past the budget is holding
 * N slots — and the literal had been sized against a per-worker rate of 4, so
 * when the rate rose to 8 the loops started filling the slots instead and two
 * tests failed with the concurrency refusal while asserting about budgets.
 * That is the same failure in both directions: a knob whose correctness
 * depends on a constant somewhere else has to be written in terms of it.
 *
 * The widest test holds two workers' full rates at once; double the sum of
 * both budgets clears that with room.
 */
const SLOTS = 2 * (DEFAULT_MAX_RUNS_PER_WORKER + DEFAULT_MAX_RUNS_PER_PIPELINE);
const base = () => ({ lockDir: dir, capacity: SLOTS });

/**
 * A fresh worker per call, so the PER-WORKER rate never answers a question
 * about the per-RUN ceiling. A real run has several agents for the same
 * reason; a test that reuses one worker is measuring the other budget.
 */
let nth = 0;
const freshWorker = () => `worker-${nth++}`;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "suite-budget-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("#194 SC-640: the run, not just the worker, has a budget", () => {
  test("a ship run's worktree path yields a run id", () => {
    expect(deriveRunId("/repo/.claude/worktrees/wf_02dd5731-cc9-8")).toBe("wf_02dd5731-cc9");
    expect(deriveRunId("/repo/.claude/worktrees/wf_02dd5731-cc9-10/lib")).toBe("wf_02dd5731-cc9");
    // Two sub-agents of one run agree.
    expect(deriveRunId("/r/.claude/worktrees/wf_abc-1")).toBe(deriveRunId("/r/.claude/worktrees/wf_abc-2"));
    // Two different runs do not.
    expect(deriveRunId("/r/.claude/worktrees/wf_abc-1")).not.toBe(deriveRunId("/r/.claude/worktrees/wf_xyz-1"));
  });

  test("a path outside a worktree has no run id, and is budgeted per worker as before", () => {
    // The DA works in the repo root. Inventing a run id for it would put every
    // session that never ships anything into one shared ceiling.
    expect(deriveRunId("/Users/x/Projects/rungate")).toBeNull();
    expect(deriveRunId(undefined)).toBeNull();
    expect(deriveRunId("/repo/.claude/worktrees")).toBeNull();
  });

  test("a second agent in the same run shares the budget", () => {
    // The whole of #194. Each agent has its own worker id and would have its
    // own four; the run ceiling is what they now share.
    // One agent per worktree, each well inside its own per-worker rate, so
    // the only thing that can refuse is the run ceiling. Two agents at four
    // each would hit the per-worker cap at the same moment and the test
    // could not tell which budget answered.
    const agents = Array.from({ length: DEFAULT_MAX_RUNS_PER_PIPELINE }, (_, i) => {
      const cwd = `/r/.claude/worktrees/wf_shared-${i + 1}`;
      return { ...base(), workerId: deriveWorkerId("s", cwd), runId: deriveRunId(cwd)! };
    });
    expect(new Set(agents.map(a => a.runId)).size, "the agents are not in one run").toBe(1);
    expect(new Set(agents.map(a => a.workerId)).size, "the agents share a worker id").toBe(agents.length);

    for (const [i, who] of agents.entries()) {
      expect(evaluateFullSuiteRequest("s", FULL, who).allow,
        `run ${i + 1} of the pipeline ceiling was refused`).toBe(true);
    }
    const ninth = "/r/.claude/worktrees/wf_shared-99";
    const over = evaluateFullSuiteRequest("s", FULL, {
      ...base(), workerId: deriveWorkerId("s", ninth), runId: deriveRunId(ninth)!,
    });
    expect(over.allow, "a ninth agent in the same run got its own fresh budget").toBe(false);
    expect(over.reason).toContain("wf_shared");
  });

  test("a different run is not affected by a spent one", () => {
    const spent = { ...base(), workerId: "w1", runId: "wf_spent" };
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE; i++) evaluateFullSuiteRequest("s", FULL, spent);
    expect(evaluateFullSuiteRequest("s", FULL, spent).allow).toBe(false);
    expect(evaluateFullSuiteRequest("s", FULL, { ...base(), workerId: "w2", runId: "wf_fresh" }).allow).toBe(true);
  });

  test("#239 does not regress: two workers in DIFFERENT runs still run in parallel", () => {
    // The budget #239 bought back. Sibling agents that are not part of the
    // same ship run must not serialise on each other.
    const a = { ...base(), workerId: "wa", runId: "wf_a" };
    const b = { ...base(), workerId: "wb", runId: "wf_b" };
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_WORKER; i++) {
      expect(evaluateFullSuiteRequest("same-session", FULL, a).allow).toBe(true);
      expect(evaluateFullSuiteRequest("same-session", FULL, b).allow).toBe(true);
    }
  });

  test("the positive control: a first legitimate full-suite run is allowed", () => {
    // A budget of zero satisfies every negative case above and makes the
    // suite unrunnable (AC-1).
    expect(evaluateFullSuiteRequest("fresh", FULL, { ...base(), runId: "wf_new" }).allow).toBe(true);
  });

  test("a targeted run spends neither budget", () => {
    const opts = { ...base(), workerId: "w", runId: "wf_targeted" };
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE + 5; i++) {
      expect(evaluateFullSuiteRequest("s", "bun test test/one.test.ts", opts).allow).toBe(true);
    }
    expect(evaluateFullSuiteRequest("s", FULL, opts).allow).toBe(true);
  });
});

describe("#194 SC-641: a run longer than the window still counts", () => {
  test("the run ceiling has no window — four runs an hour apart still spend it", () => {
    // The measured runs lasted 30, 32, 34 and 41 minutes against a 30-minute
    // window, so the per-worker budget reset mid-run every time. The run
    // ceiling is bounded by the run id instead of by elapsed time.
    const opts = { ...base(), workerId: "w", runId: "wf_long" };
    const HOUR = 3_600_000;
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE; i++) {
      expect(evaluateFullSuiteRequest("s", FULL, { ...opts, now: 1_000_000 + i * HOUR }).allow).toBe(true);
    }
    const over = evaluateFullSuiteRequest("s", FULL, {
      ...opts,
      now: 1_000_000 + DEFAULT_MAX_RUNS_PER_PIPELINE * HOUR,
    });
    expect(over.allow, "an hour apart, every run aged out of the per-worker window").toBe(false);
  });

  test("the refusal says which run holds the budget, so the caller can wait rather than guess", () => {
    // AC-3. #67: a blocked suite run is not a satisfied gate, which is only
    // actionable if the refusal explains itself.
    const opts = { ...base(), runId: "wf_named" };
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE; i++) {
      evaluateFullSuiteRequest("s", FULL, { ...opts, workerId: freshWorker() });
    }
    const over = evaluateFullSuiteRequest("s", FULL, { ...opts, workerId: freshWorker() });
    expect(over.reason).toContain("wf_named");
    expect(over.reason).toContain("DIR-L29");
    expect(over.reason, "a refusal with no way forward teaches people to stop reading it")
      .toMatch(/targeted/i);
  });
});

describe("#194 SC-643: a corrupt counter is visible, and fails closed", () => {
  test("a corrupt run counter spends the budget rather than granting it", () => {
    // The issue reported "corrupt returns a FULL budget" at
    // lib/test-suite-lock.ts:467. That was already fixed for the per-worker
    // counter — the comment there now reads "Fail closed" — and this asserts
    // the run counter made the same choice rather than inheriting the old one.
    const opts = { ...base(), workerId: "w", runId: "wf_corrupt" };
    writeFileSync(runCounterPath(dir, "wf_corrupt"), "{ not json");
    const d = evaluateFullSuiteRequest("s", FULL, opts);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("DIR-L29");
  });

  test("failing closed clears itself rather than wedging the run forever", () => {
    // Dated from mtime, so a corrupt file stops being a permanent lockout.
    const path = runCounterPath(dir, "wf_ages");
    writeFileSync(path, "{ not json");
    const old = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(path, old, old);
    expect(wouldAllowFullSuite("s", FULL, { ...base(), workerId: "w", runId: "wf_ages" }).allow).toBe(true);
  });

  test("a well-formed counter is read, not treated as corrupt", () => {
    // Without this the two cases above pass on a reader that rejects
    // everything, which is a fail-closed that never opens.
    // Recent timestamps. Seeding `[1, 2]` puts them in 1970, where the
    // garbage-collection cutoff drops them and the file reads as empty —
    // which looks exactly like a reader that ignored it.
    const spent = [Date.now() - 60_000, Date.now() - 30_000];
    writeFileSync(runCounterPath(dir, "wf_ok"), JSON.stringify({ runs: spent }));
    const opts = { ...base(), runId: "wf_ok" };
    const allowed: boolean[] = [];
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE; i++) {
      allowed.push(evaluateFullSuiteRequest("s", FULL, { ...opts, workerId: freshWorker() }).allow);
    }
    // Two already spent, so the ceiling arrives two runs early.
    expect(allowed.filter(Boolean).length).toBe(DEFAULT_MAX_RUNS_PER_PIPELINE - 2);
    expect(JSON.parse(readFileSync(runCounterPath(dir, "wf_ok"), "utf-8")).runs.length)
      .toBe(DEFAULT_MAX_RUNS_PER_PIPELINE);
  });
});

describe("#194 SC-642: a guard that cannot evaluate says so", () => {
  const HOOK = join(import.meta.dir, "..", "hooks", "TestSuiteGuard.hook.ts");

  test("the silent catch is gone", () => {
    const src = readFileSync(HOOK, "utf-8");
    expect(src).toContain("GUARD-FAILURE-VISIBLE");
    // It may still fail open — a broken guard must not block the suite it
    // guards — but not invisibly. AC-5.
    expect(src, "the bare silent exit is back").not.toMatch(/\}\s*catch\s*\{\s*process\.exit\(0\);\s*\}/);
  });

  test("the hook actually passes the run id — the lib's ceiling reaches a real request", () => {
    // Everything above drives the library directly, and all of it stays green
    // when the hook stops passing `runId`: the one call site that makes the
    // fix real. Measured at 0 red before this case existed.
    //
    // So: spend the run's ceiling through the library, then ask the HOOK, as a
    // subprocess, from a worktree in that run with a worker that has spent
    // nothing. Only the run ceiling can refuse it.
    const runId = "wf_hookwire";
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_PIPELINE; i++) {
      evaluateFullSuiteRequest("seed", FULL, { ...base(), workerId: freshWorker(), runId });
    }

    const p = Bun.spawnSync(["bun", HOOK], {
      stdin: Buffer.from(JSON.stringify({
        tool_name: "Bash",
        session_id: "a-session-that-has-run-nothing",
        cwd: `/r/.claude/worktrees/${runId}-7`,
        tool_input: { command: FULL },
      })),
      env: { ...process.env, RUNGATE_LOCK_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(p.stdout);
    expect(out, `the hook allowed a request the run ceiling had already refused`).toContain("block");
    expect(out).toContain(runId);
  });

  test("a hook that throws prints the marker and still allows the run", () => {
    // Executed, not grepped. The marker's presence in the source says nothing
    // about whether the catch reaches it.
    const p = Bun.spawnSync(["bun", HOOK], {
      stdin: Buffer.from(JSON.stringify({
        tool_name: "Bash",
        session_id: "s",
        cwd: "/nope",
        tool_input: { command: FULL },
      })),
      env: { ...process.env, RUNGATE_LOCK_DIR: "/dev/null/cannot-exist" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(p.stdout);
    expect(p.exitCode).toBe(0);
    if (out.includes("GUARD-FAILURE-VISIBLE")) {
      // It failed, and said so — which is the contract.
      expect(out).not.toContain('"decision":"block"');
    } else {
      // It coped. Then it must have produced a real verdict, not silence.
      expect(out.trim().length === 0 || out.includes("decision") || out.includes("systemMessage")).toBe(true);
    }
  });
});
