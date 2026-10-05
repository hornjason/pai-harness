import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Regression coverage for issue #66 — SC-411.
 *
 * `runDecomposedShip` computes a pairwise file-overlap check and then takes one
 * of two paths. The disjoint path logged "parallel execution" while running a
 * sequential `for` loop, and discarded completed siblings when a later sub-issue
 * failed.
 *
 * ship.js runs inside the Workflow sandbox and is not importable as a module, so
 * this follows the same marker-extraction pattern as
 * test/workflow-security-integration.ts: pull the delimited block out and
 * evaluate it against injected fakes, giving behavioural coverage rather than
 * grep coverage.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const BLOCK_START = "// ──── DECOMPOSED-SHIP-START ────";
const BLOCK_END = "// ──── DECOMPOSED-SHIP-END ────";

type AgentCall = { label: string; start: number; end: number };

type BriefedAgentFake = (
  prompt: string,
  opts: { label: string },
) => Promise<unknown>;

function loadRunDecomposedShip(deps: {
  briefedAgent: BriefedAgentFake;
  runImplement?: () => Promise<unknown>;
}) {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error(
      "ship.js is missing the DECOMPOSED-SHIP-START/END markers",
    );
  }
  const block = shipSource.slice(start + BLOCK_START.length, end);
  const logs: string[] = [];

  // The real Workflow runtime injects `parallel` as a global that takes an array
  // of thunks and resolves them concurrently — mirrored here exactly.
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t()));

  const factory = new Function(
    "log",
    "briefedAgent",
    "parallel",
    "WORK_DIR",
    "ISSUE",
    "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA",
    "runImplement",
    `${block}\nreturn runDecomposedShip;`,
  );

  const runDecomposedShip = factory(
    (m: string) => logs.push(String(m)),
    deps.briefedAgent,
    parallel,
    "/tmp/work",
    66,
    REPO_ROOT,
    {},
    deps.runImplement ?? (async () => ({ success: true, buildResult: {} })),
  );

  return { runDecomposedShip, logs };
}

/** Records the execution window of each call so overlap can be measured. */
function makeTimingAgent(opts: {
  delayMs: number;
  failOn?: string;
  calls: AgentCall[];
}): BriefedAgentFake {
  return async (_prompt, { label }) => {
    const start = performance.now();
    await new Promise((r) => setTimeout(r, opts.delayMs));
    const end = performance.now();
    opts.calls.push({ label, start, end });
    if (opts.failOn && label.includes(opts.failOn)) {
      return { success: false, findings: ["injected failure"] };
    }
    return { success: true, filesChanged: [`${label}.ts`], worktreePath: "/tmp/wt" };
  };
}

const DISJOINT_SUB_ISSUES = [
  { title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
  { title: "gamma", acs: ["g1"], filesToModify: ["lib/gamma.ts"], size: "S" },
];

const OVERLAPPING_SUB_ISSUES = [
  { title: "alpha", acs: ["a1"], filesToModify: ["lib/shared.ts"], size: "S" },
  { title: "beta", acs: ["b1"], filesToModify: ["lib/shared.ts"], size: "S" },
];

/** True when every call's window intersects at least one other call's window. */
function windowsOverlap(calls: AgentCall[]): boolean {
  return calls.every((a) =>
    calls.some((b) => a !== b && a.start < b.end && b.start < a.end),
  );
}

describe("AC-1: disjoint sub-issues dispatch concurrently (#66, SC-411)", () => {
  test("execution windows of independent sub-issues overlap", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 60, calls }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      buildResult: { filesChanged: string[] };
    };

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
    expect(windowsOverlap(calls)).toBe(true);
  });

  test("wall-clock is bounded by the slowest sub-issue, not their sum", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 60, calls }),
    });

    const started = performance.now();
    await runDecomposedShip(DISJOINT_SUB_ISSUES);
    const elapsed = performance.now() - started;

    // Serial would be >=180ms for three 60ms sub-issues.
    expect(elapsed).toBeLessThan(150);
  });

  test("every sub-issue's changed files reach the merged result", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 5, calls }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      buildResult: { filesChanged: string[] };
    };

    expect(result.buildResult.filesChanged).toHaveLength(3);
  });
});

describe("AC-2: a failing sub-issue preserves completed siblings (#66, D-4)", () => {
  test("results from succeeded siblings survive a mid-batch failure", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({
        delayMs: 5,
        failOn: "66002", // the second sub-issue: ISSUE * 1000 + 1 + 1
        calls,
      }),
    });

    const result = (await runDecomposedShip(DISJOINT_SUB_ISSUES)) as {
      success: boolean;
      completed?: unknown[];
      failed?: unknown[];
    };

    expect(result.success).toBe(false);
    // D-4: "no work is lost" — the two siblings that succeeded must be reported.
    expect(result.completed).toBeDefined();
    expect(result.completed).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });
});

describe("AC-3: logging matches the dispatch mechanism actually used", () => {
  test("the disjoint path does not claim batch-ship dispatch", async () => {
    const calls: AgentCall[] = [];
    const { runDecomposedShip, logs } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 1, calls }),
    });

    await runDecomposedShip(DISJOINT_SUB_ISSUES);

    const claimsBatchShip = logs.some((l) => /batch-ship/i.test(l));
    expect(claimsBatchShip).toBe(false);
  });

  test("ship.js does not reference batch-ship without importing it", () => {
    const mentionsBatchShip = /batch-ship/i.test(shipSource);
    const importsBatchShip =
      /import\s[^\n]*batch-ship/.test(shipSource) ||
      /scriptPath:[^\n]*batch-ship/.test(shipSource);
    if (mentionsBatchShip) {
      expect(importsBatchShip).toBe(true);
    }
  });
});

describe("overlapping sub-issues still serialize (SC-411, D-2)", () => {
  test("the overlap path delegates to the single-agent implement", async () => {
    const calls: AgentCall[] = [];
    let implementCalled = 0;
    const { runDecomposedShip } = loadRunDecomposedShip({
      briefedAgent: makeTimingAgent({ delayMs: 1, calls }),
      runImplement: async () => {
        implementCalled += 1;
        return { success: true, buildResult: { filesChanged: ["lib/shared.ts"] } };
      },
    });

    const result = (await runDecomposedShip(OVERLAPPING_SUB_ISSUES)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(implementCalled).toBe(1);
    // No per-sub-issue agents on the overlap path.
    expect(calls).toHaveLength(0);
  });
});
