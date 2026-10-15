/**
 * Dependency waves for decomposed sub-issues (#189).
 *
 * Covers SC-1461, SC-1462, SC-1463, SC-1464, SC-1465 (HARNESS-STANDARD.md).
 *
 * `workflows/ship.js` asked the decomposer for "sub-issues in dependency order
 * (foundations first)", gave the schema nowhere to record the answer, and
 * dispatched every sub-issue at once. #166's shape exactly: an instruction the
 * agent can follow perfectly without its output changing anything.
 *
 * The shape of this file follows from what is easy to get wrong here. A
 * scheduler that serialises EVERYTHING satisfies every ordering case for free
 * and throws away the whole benefit of decomposition, so the all-independent
 * case is not a nicety — it is the positive control, and it is asserted on both
 * the plan and the measured execution windows.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { dependencyWaves, wavePlanSummary } from "../lib/decomposition-waves";
import { assertMarkedBlockReachable } from "../lib/reachability";

const REPO_ROOT = join(import.meta.dir, "..");
const RUN_REPO = "owner/project";
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const WAVE_START = "// ──── WAVE-DISPATCH-START ────";
const WAVE_END = "// ──── WAVE-DISPATCH-END ────";
const BLOCK_START = "// ──── DECOMPOSED-SHIP-START ────";
const BLOCK_END = "// ──── DECOMPOSED-SHIP-END ────";

type Plan = { waves: number[][]; reasons: string[]; refusal: string | null };
type WaveFns = {
  dependencyWaves: (subIssues: unknown) => Plan;
  wavePlanSummary: (plan: Plan, total: number) => string;
};

/**
 * The inline copy ship.js actually runs. Sliced by marker and evaluated, not
 * read as text: a text assertion would hold over a block that no longer parses
 * (#204), and the point of this file is that the two copies AGREE.
 */
function loadInlineWaves(): WaveFns {
  const start = shipSource.indexOf(WAVE_START);
  const end = shipSource.indexOf(WAVE_END);
  expect(start, "ship.js is missing the WAVE-DISPATCH-START marker").toBeGreaterThan(-1);
  expect(end, "ship.js is missing the WAVE-DISPATCH-END marker").toBeGreaterThan(start);
  // Exactly once, each. A second copy would let a mutation of one survive in
  // the other, and the parity matrix below would compare a block against
  // itself.
  expect(shipSource.indexOf(WAVE_START, start + 1)).toBe(-1);
  expect(shipSource.indexOf(WAVE_END, end + 1)).toBe(-1);
  return new Function(
    `${shipSource.slice(start, end)}\nreturn { dependencyWaves, wavePlanSummary };`,
  )() as WaveFns;
}

const inline = loadInlineWaves();

/** Both copies, so every behavioural case below runs twice. */
const IMPLEMENTATIONS: Array<[string, WaveFns]> = [
  ["library", { dependencyWaves, wavePlanSummary } as WaveFns],
  ["ship.js inline", inline],
];

const INDEPENDENT = [
  { title: "alpha" },
  { title: "beta" },
  { title: "gamma" },
];

const LAYERED = [
  { title: "add harnessRootFor to lib/paths.ts" },
  { title: "unrelated doc change" },
  { title: "call harnessRootFor from the scanner", dependsOn: ["add harnessRootFor to lib/paths.ts"] },
  { title: "test the scanner", dependsOn: ["call harnessRootFor from the scanner"] },
];

// ── SC-1461 ─────────────────────────────────────────────────────────────────

describe("SC-1461: a dependent sub-issue waits for its foundation", () => {
  for (const [name, impl] of IMPLEMENTATIONS) {
    test(`${name}: dependsOn produces topological waves`, () => {
      const plan = impl.dependencyWaves(LAYERED);
      expect(plan.refusal).toBeNull();
      expect(plan.waves).toEqual([[0, 1], [2], [3]]);
    });

    test(`${name}: the wave boundary says what it waited for`, () => {
      // AC-5. A run that quietly takes three times as long is a bug report
      // nobody files.
      const plan = impl.dependencyWaves(LAYERED);
      expect(plan.reasons.length).toBe(2);
      expect(plan.reasons[0]).toContain("add harnessRootFor to lib/paths.ts");
      expect(plan.reasons[1]).toContain("call harnessRootFor from the scanner");
      expect(plan.reasons[0]).toContain("declared dependsOn");
    });

    test(`${name}: titles match after trimming and case folding`, () => {
      const plan = impl.dependencyWaves([
        { title: "Build The Thing" },
        { title: "use it", dependsOn: ["  build the thing  "] },
      ]);
      expect(plan.refusal).toBeNull();
      expect(plan.waves).toEqual([[0], [1]]);
    });

    test(`${name}: a sub-issue waits for every foundation and not just the first`, () => {
      const plan = impl.dependencyWaves([
        { title: "a" },
        { title: "b", dependsOn: ["a"] },
        { title: "c", dependsOn: ["a", "b"] },
      ]);
      expect(plan.waves).toEqual([[0], [1], [2]]);
    });
  }
});

// ── SC-1462 ─────────────────────────────────────────────────────────────────

describe("SC-1462: independent sub-issues still run in parallel", () => {
  for (const [name, impl] of IMPLEMENTATIONS) {
    test(`${name}: no dependsOn means ONE wave containing everything`, () => {
      // THE POSITIVE CONTROL. A scheduler that returned one sub-issue per wave
      // would satisfy every SC-1461 case above and destroy the feature.
      const plan = impl.dependencyWaves(INDEPENDENT);
      expect(plan.refusal).toBeNull();
      expect(plan.waves).toEqual([[0, 1, 2]]);
      expect(plan.reasons).toEqual([]);
    });

    test(`${name}: an empty dependsOn array is not a dependency`, () => {
      const plan = impl.dependencyWaves([{ title: "a", dependsOn: [] }, { title: "b", dependsOn: [] }]);
      expect(plan.waves).toEqual([[0, 1]]);
    });

    test(`${name}: the summary distinguishes a concurrent run from a serialised one`, () => {
      expect(impl.wavePlanSummary(impl.dependencyWaves(INDEPENDENT), 3)).toContain("concurrently");
      const serialised = impl.wavePlanSummary(impl.dependencyWaves(LAYERED), 4);
      expect(serialised).toContain("3 dependency waves");
      expect(serialised).toContain("2 barrier");
    });

    test(`${name}: no sub-issues is not a refusal`, () => {
      const plan = impl.dependencyWaves([]);
      expect(plan.refusal).toBeNull();
      expect(plan.waves).toEqual([]);
    });
  }
});

// ── SC-1463 ─────────────────────────────────────────────────────────────────

describe("SC-1463: a dependency cycle is refused", () => {
  for (const [name, impl] of IMPLEMENTATIONS) {
    test(`${name}: a cycle refuses and schedules nothing`, () => {
      // AC-4. The direction this is allowed to be wrong in is toward refusing.
      // Falling back to parallel would run exactly the schedule the field
      // exists to prevent, and report that it had ordered the work.
      const plan = impl.dependencyWaves([
        { title: "a", dependsOn: ["b"] },
        { title: "b", dependsOn: ["a"] },
      ]);
      expect(plan.waves).toEqual([]);
      expect(plan.refusal).toContain("cycle");
      expect(plan.refusal).toContain("a");
      expect(plan.refusal).toContain("b");
    });

    test(`${name}: a cycle among three does not deadlock`, () => {
      const plan = impl.dependencyWaves([
        { title: "a", dependsOn: ["c"] },
        { title: "b", dependsOn: ["a"] },
        { title: "c", dependsOn: ["b"] },
      ]);
      expect(plan.refusal).toContain("cycle");
    });

    test(`${name}: a cycle beside independent work still refuses the whole run`, () => {
      // Partial scheduling would dispatch the independent half and leave the
      // cycle unreported — a run that looks like it worked.
      const plan = impl.dependencyWaves([
        { title: "free" },
        { title: "a", dependsOn: ["b"] },
        { title: "b", dependsOn: ["a"] },
      ]);
      expect(plan.waves).toEqual([]);
      expect(plan.refusal).toContain("cycle");
    });

    test(`${name}: a dependsOn naming nothing in the list refuses`, () => {
      const plan = impl.dependencyWaves([{ title: "a" }, { title: "b", dependsOn: ["ghost"] }]);
      expect(plan.waves).toEqual([]);
      expect(plan.refusal).toContain("ghost");
    });

    test(`${name}: a self-dependency refuses`, () => {
      const plan = impl.dependencyWaves([{ title: "a", dependsOn: ["a"] }]);
      expect(plan.refusal).toContain("itself");
    });

    test(`${name}: two sub-issues with the same title refuse`, () => {
      const plan = impl.dependencyWaves([{ title: "a" }, { title: " A " }, { title: "c", dependsOn: ["a"] }]);
      expect(plan.refusal).toContain("two possible targets");
    });

    test(`${name}: a missing title refuses rather than becoming an unnameable node`, () => {
      expect(impl.dependencyWaves([{ title: "a" }, { title: "  " }]).refusal).toContain("no title");
    });

    test(`${name}: the summary of a refusal is the refusal`, () => {
      const plan = impl.dependencyWaves([{ title: "a", dependsOn: ["a"] }]);
      expect(impl.wavePlanSummary(plan, 1)).toBe(plan.refusal);
    });
  }
});

// ── SC-1464 ─────────────────────────────────────────────────────────────────

describe("SC-1464: the inline copy and the library agree", () => {
  const MATRIX: unknown[] = [
    INDEPENDENT,
    LAYERED,
    [],
    [{ title: "only" }],
    [{ title: "a" }, { title: "b", dependsOn: ["a"] }],
    [{ title: "a", dependsOn: ["b"] }, { title: "b", dependsOn: ["a"] }],
    [{ title: "a" }, { title: "b", dependsOn: ["ghost"] }],
    [{ title: "a", dependsOn: ["a"] }],
    [{ title: "a" }, { title: "A" }],
    [{ title: "a" }, { title: "" }],
    [{ title: "a" }, { title: "b", dependsOn: ["a", "a"] }],
    null,
  ];

  test("every case in the matrix produces the same plan from both copies", () => {
    for (const input of MATRIX) {
      const lib = dependencyWaves(input as never);
      const ship = inline.dependencyWaves(input);
      expect(ship, `inline and library disagree on ${JSON.stringify(input)}`).toEqual(lib);
      expect(inline.wavePlanSummary(ship, 2)).toBe(wavePlanSummary(lib as never, 2));
    }
  });

  test("the matrix exercises both outcomes and is not all refusals", () => {
    // Without this the matrix could be satisfied by two copies that both
    // refuse everything — agreement proves parity, not correctness.
    const plans = MATRIX.map(i => inline.dependencyWaves(i));
    expect(plans.filter(p => p.refusal).length).toBeGreaterThan(0);
    expect(plans.filter(p => !p.refusal && p.waves.length > 0).length).toBeGreaterThan(0);
    expect(plans.filter(p => p.waves.length > 1).length).toBeGreaterThan(0);
  });

  test("the inline block is reachable at the top level of ship.js", () => {
    expect(assertMarkedBlockReachable(shipSource, "WAVE-DISPATCH")).toEqual(["Program"]);
  });
});

// ── SC-1465 ─────────────────────────────────────────────────────────────────

describe("SC-1465: the dispatcher reads the plan and the decomposer can write it", () => {
  test("the decomposition schema has somewhere for the answer to land", () => {
    // #189's whole subject: the prompt asked for dependency order and the
    // schema had no field for it, so the answer was produced and discarded.
    const schemaStart = shipSource.indexOf("const M_DECOMPOSITION_SCHEMA");
    expect(schemaStart).toBeGreaterThan(-1);
    const schema = shipSource.slice(schemaStart, schemaStart + 2000);
    expect(schema, "the schema still has no dependsOn field").toContain("dependsOn:");
  });

  test("the decompose prompt names the field the schema accepts", () => {
    // Asking for "dependency order" in prose and accepting `dependsOn` in the
    // schema is the same defect in the other direction.
    const promptAt = shipSource.indexOf("dependsOn", shipSource.indexOf("const M_DECOMPOSITION_SCHEMA") + 2000);
    expect(promptAt, "no prompt text mentions dependsOn").toBeGreaterThan(-1);
  });

  test("dispatch runs the waves rather than one flat parallel call", async () => {
    const order: string[] = [];
    const { runDecomposedShip, logs } = loadRunDecomposedShip(async (_p, { label }) => {
      order.push(`start:${label}`);
      await new Promise(r => setTimeout(r, 40));
      order.push(`end:${label}`);
      return {
        success: true,
        filesChanged: [`${label}.ts`],
        worktreePath: "/tmp/wt",
        worktreeRepo: `git@github.com:${RUN_REPO}.git`,
      };
    });

    const result = await runDecomposedShip([
      { title: "foundation", acs: ["a"], filesToModify: ["lib/a.ts"], size: "S" },
      { title: "consumer", acs: ["b"], filesToModify: ["lib/b.ts"], size: "S", dependsOn: ["foundation"] },
    ]);

    expect((result as { success: boolean }).success).toBe(true);
    const foundationEnd = order.indexOf("end:marcus-sub-66001");
    const consumerStart = order.indexOf("start:marcus-sub-66002");
    expect(foundationEnd).toBeGreaterThan(-1);
    expect(consumerStart).toBeGreaterThan(-1);
    expect(consumerStart, "the consumer started before its foundation finished")
      .toBeGreaterThan(foundationEnd);
    expect(logs.join("\n")).toContain("2 dependency waves");
  });

  test("independent sub-issues still overlap in the dispatcher itself", async () => {
    // The dispatcher's own positive control. The plan-level control above
    // cannot see a loop that awaits each wave member in turn.
    const order: string[] = [];
    const { runDecomposedShip } = loadRunDecomposedShip(async (_p, { label }) => {
      order.push(`start:${label}`);
      await new Promise(r => setTimeout(r, 40));
      order.push(`end:${label}`);
      return {
        success: true,
        filesChanged: [`${label}.ts`],
        worktreePath: "/tmp/wt",
        worktreeRepo: `git@github.com:${RUN_REPO}.git`,
      };
    });

    await runDecomposedShip([
      { title: "alpha", acs: ["a"], filesToModify: ["lib/a.ts"], size: "S" },
      { title: "beta", acs: ["b"], filesToModify: ["lib/b.ts"], size: "S" },
    ]);

    expect(order.slice(0, 2)).toEqual(["start:marcus-sub-66001", "start:marcus-sub-66002"]);
  });

  test("a cycle refuses the dispatch and spawns no agent at all", async () => {
    let spawns = 0;
    const { runDecomposedShip } = loadRunDecomposedShip(async () => {
      spawns++;
      return { success: true, filesChanged: [], worktreePath: "/tmp/wt", worktreeRepo: `git@github.com:${RUN_REPO}.git` };
    });

    const result = (await runDecomposedShip([
      { title: "a", acs: ["a"], filesToModify: ["lib/a.ts"], size: "S", dependsOn: ["b"] },
      { title: "b", acs: ["b"], filesToModify: ["lib/b.ts"], size: "S", dependsOn: ["a"] },
    ])) as { success: boolean; refusal?: string };

    expect(result.success).toBe(false);
    expect(result.refusal).toContain("cycle");
    expect(spawns, "a refused plan still dispatched work").toBe(0);
  });

  test("a sub-issue whose wave failed is reported as not started rather than dropped", async () => {
    const { runDecomposedShip } = loadRunDecomposedShip(async (_p, { label }) => {
      if (label.endsWith("66001")) return { success: false, findings: ["injected failure"] };
      return { success: true, filesChanged: [`${label}.ts`], worktreePath: "/tmp/wt", worktreeRepo: `git@github.com:${RUN_REPO}.git` };
    });

    const result = (await runDecomposedShip([
      { title: "foundation", acs: ["a"], filesToModify: ["lib/a.ts"], size: "S" },
      { title: "consumer", acs: ["b"], filesToModify: ["lib/b.ts"], size: "S", dependsOn: ["foundation"] },
    ])) as { success: boolean; failed: Array<{ title: string; buildResult: { findings?: string[] } | null }> };

    expect(result.success).toBe(false);
    expect(result.failed.map(f => f.title).sort()).toEqual(["consumer", "foundation"]);
    const consumer = result.failed.find(f => f.title === "consumer")!;
    expect(consumer.buildResult?.findings?.join(" ")).toContain("did not start");
  });
});

type BriefedAgentFake = (prompt: string, opts: { label: string }) => Promise<unknown>;

/**
 * `runDecomposedShip`, sliced from its markers and run with fakes. The guards
 * it references are injected from THEIR markers rather than stubbed, for the
 * reason `test/decomposed-ship-dispatch.test.ts` gives: a stub lets the two
 * copies disagree and nothing notices.
 */
function loadRunDecomposedShip(briefedAgent: BriefedAgentFake) {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) throw new Error("ship.js is missing the DECOMPOSED-SHIP markers");
  const block = shipSource.slice(start + BLOCK_START.length, end);
  const logs: string[] = [];

  const sliced = (name: string, fn: string) => {
    const a = shipSource.indexOf(`// ──── ${name}-START ────`);
    const b = shipSource.indexOf(`// ──── ${name}-END ────`);
    if (a === -1 || b === -1) throw new Error(`ship.js is missing the ${name} markers`);
    return new Function(`${shipSource.slice(a, b)}\nreturn ${fn};`)();
  };

  const factory = new Function(
    "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
    `${block}\nreturn runDecomposedShip;`,
  );

  const runDecomposedShip = factory(
    (m: string) => logs.push(String(m)),
    briefedAgent,
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    "/tmp/work",
    66,
    REPO_ROOT,
    {},
    async () => ({ success: true, buildResult: {} }),
    sliced("IMPLEMENT-RESULT", "implementRefusal"),
    sliced("WORKTREE-IDENTITY", "worktreeIdentity"),
    RUN_REPO,
  ) as (subIssues: unknown[]) => Promise<unknown>;

  return { runDecomposedShip, logs };
}
