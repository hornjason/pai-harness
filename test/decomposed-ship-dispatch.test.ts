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
/** The run repo, and the remote every fixture worktree reports (#218). */
const RUN_REPO = "owner/project";
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

  // #181 added a per-sub-issue guard that lives outside these markers, so
  // the block now has a free reference. The REAL one is injected, sliced
  // from its own markers — a stub here would let the two blocks disagree
  // about what an empty implement result means, and nothing would notice.
  const guardStart = shipSource.indexOf("// ──── IMPLEMENT-RESULT-START ────");
  const guardEnd = shipSource.indexOf("// ──── IMPLEMENT-RESULT-END ────");
  if (guardStart === -1 || guardEnd === -1) {
    throw new Error("ship.js is missing the IMPLEMENT-RESULT-START/END markers");
  }
  const implementRefusal = new Function(
    `${shipSource.slice(guardStart, guardEnd)}\nreturn implementRefusal;`,
  )();

  // #611 added a second free reference the same way. The block text is
  // evaluated into the factory body below rather than injected, because
  // ship.js declares it at module scope beside the decomposed block.
  const shapeStart = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-START ────");
  const shapeEnd = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-END ────");
  if (shapeStart === -1 || shapeEnd === -1) {
    throw new Error("ship.js is missing the FILES-CHANGED-SHAPE-START/END markers");
  }
  const shapeBlock = shipSource.slice(shapeStart, shapeEnd);

  // #218's guard, injected for the same reason as the one above: a stub
  // would let this block and the real one disagree about which repository a
  // worktree belongs to, and nothing would notice.
  const identityStart = shipSource.indexOf("// ──── WORKTREE-IDENTITY-START ────");
  const identityEnd = shipSource.indexOf("// ──── WORKTREE-IDENTITY-END ────");
  if (identityStart === -1 || identityEnd === -1) {
    throw new Error("ship.js is missing the WORKTREE-IDENTITY-START/END markers");
  }
  const worktreeIdentity = new Function(
    `${shipSource.slice(identityStart, identityEnd)}\nreturn worktreeIdentity;`,
  )();

  // #180's guard, injected for the reason the two above are.
  const precStart = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-START ────");
  const precEnd = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-END ────");
  if (precStart === -1 || precEnd === -1) {
    throw new Error("ship.js is missing the BRIEF-PRECEDENCE-START/END markers");
  }
  const taskSourceRefusal = new Function(
    `${shipSource.slice(precStart, precEnd)}\nreturn taskSourceRefusal;`,
  )();

  // #420's predicate, injected for the reason the three above are.
  const refStart = shipSource.indexOf("// ──── RUN-REF-START ────");
  const refEnd = shipSource.indexOf("// ──── RUN-REF-END ────");
  if (refStart === -1 || refEnd === -1) {
    throw new Error("ship.js is missing the RUN-REF-START/END markers");
  }
  const sliced = (_name: string, fn: string) =>
    new Function(`${shipSource.slice(refStart, refEnd)}\nreturn ${fn};`)();

  const factory = new Function(
    "log",
    "briefedAgent",
    "parallel",
    "WORK_DIR",
    "ISSUE",
    "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA",
    "runImplement",
    "implementRefusal",
    "worktreeIdentity",
    "REPO",
    "taskSourceRefusal",
    "establishRunRef",
    "integrateWave",
    "waveNeedsIntegration",
    // #611's element-shape guard, evaluated INTO the block's scope for the
    // same reason the guards above are injected: a stub would let this suite
    // and the real block disagree about what a reported path is.
    `${shapeBlock}\n${block}\nreturn runDecomposedShip;`,
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
    implementRefusal,
    worktreeIdentity,
    RUN_REPO,
    // #180 guard, injected from its own markers rather than stubbed — the
    // same reason the two above are.
    taskSourceRefusal,
    async () => ({ branch: "rungate/run-66", refusal: null }),
    async () => ({ ok: true, integrated: 0 }),
    sliced("RUN-REF", "waveNeedsIntegration"),
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
    return { success: true, filesChanged: [`${label}.ts`], worktreePath: "/tmp/wt", worktreeRepo: `git@github.com:${RUN_REPO}.git`, taskSource: "brief" };
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
