import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Coverage for the Verify-phase fan-out (#66 follow-on).
 *
 * Container verification (rebuild → env-check → Quinn) and Rook's security
 * review are independent and read-only, but ship.js ran them as back-to-back
 * awaits while verify.js:169 already paired the same two roles with parallel().
 *
 * ship.js is not importable (Workflow sandbox), so this uses the same
 * marker-extraction approach as test/workflow-security-integration.test.ts.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Design Decisions

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const BLOCK_START = "// ──── VERIFY-FANOUT-START ────";
const BLOCK_END = "// ──── VERIFY-FANOUT-END ────";

type Call = { label: string; start: number; end: number };

function runFanout(opts: {
  ceremonyTier: string;
  container: Record<string, unknown> | null;
  delayMs?: number;
}) {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error("ship.js is missing the VERIFY-FANOUT-START/END markers");
  }
  const block = shipSource.slice(start + BLOCK_START.length, end);

  const calls: Call[] = [];
  const logs: string[] = [];
  const delayMs = opts.delayMs ?? 40;

  const record = async (label: string, result: unknown) => {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, delayMs));
    calls.push({ label, start: t0, end: performance.now() });
    return result;
  };

  const agent = (_p: string, o: { label: string }) =>
    record(o.label, o.label === "env-check" ? { host0: true } : {});
  const briefedAgent = (_p: string, o: { label: string }) =>
    record(o.label, { result: "PASS" });
  const parallel = (thunks: Array<() => Promise<unknown>>) =>
    Promise.all(thunks.map((t) => t()));

  const factory = new Function(
    "log",
    "agent",
    "briefedAgent",
    "parallel",
    "discovery",
    "projectConfig",
    "PROJECT_ROOT",
    "WORK_DIR",
    "ISSUE",
    "GATE_RESULT_SCHEMA",
    `return (async () => {${block}})()`,
  );

  const done = factory(
    (m: string) => logs.push(String(m)),
    agent,
    briefedAgent,
    parallel,
    {
      ceremonyTier: opts.ceremonyTier,
      acs: [{ id: "AC-1", statement: "works" }],
      filesToModify: ["lib/a.ts"],
    },
    { container: opts.container },
    REPO_ROOT,
    "/tmp/work",
    66,
    {},
  ) as Promise<void>;

  return { done, calls, logs };
}

const CONTAINER = {
  rebuildCommand: "echo rebuild",
  hosts: ["localhost"],
  port: 8080,
  healthPath: "/health",
};

const byLabel = (calls: Call[], label: string) =>
  calls.find((c) => c.label === label);

describe("Verify fan-out: container chain and Rook run concurrently", () => {
  test("Rook starts before the container chain finishes", async () => {
    const { done, calls } = runFanout({
      ceremonyTier: "THOROUGH",
      container: CONTAINER,
    });
    await done;

    const rook = byLabel(calls, "rook");
    const rebuild = byLabel(calls, "container-rebuild");
    const quinn = byLabel(calls, "quinn-container");

    expect(rook).toBeDefined();
    expect(rebuild).toBeDefined();
    expect(quinn).toBeDefined();

    // Serial execution would put Rook strictly after Quinn finished.
    expect(rook!.start).toBeLessThan(quinn!.end);
    // Rook and the first container step begin together.
    expect(rook!.start).toBeLessThan(rebuild!.end);
  });

  test("wall-clock is the container chain, not chain plus Rook", async () => {
    const { done } = runFanout({
      ceremonyTier: "THOROUGH",
      container: CONTAINER,
      delayMs: 40,
    });
    const t0 = performance.now();
    await done;
    const elapsed = performance.now() - t0;

    // Container chain is 3 sequential steps (~120ms). Serial would add Rook
    // for a 4th (~160ms).
    expect(elapsed).toBeLessThan(155);
  });

  test("the container chain keeps its internal ordering", async () => {
    const { done, calls } = runFanout({
      ceremonyTier: "THOROUGH",
      container: CONTAINER,
    });
    await done;

    const rebuild = byLabel(calls, "container-rebuild")!;
    const envCheck = byLabel(calls, "env-check")!;
    const quinn = byLabel(calls, "quinn-container")!;

    // Quinn must not start until the container is rebuilt and confirmed up.
    expect(rebuild.end).toBeLessThanOrEqual(envCheck.start);
    expect(envCheck.end).toBeLessThanOrEqual(quinn.start);
  });
});

describe("Verify fan-out: tier gating of the UI-dependent steps", () => {
  // These two were "LIGHT tier runs neither container verify nor Rook" and
  // "STANDARD tier runs container verify but not Rook". Both were accurate
  // descriptions of the code and wrong descriptions of the intent — see the
  // #127 block below. Rook's expectation moved there; what remains here is the
  // tier gating of the browser-driven steps, which is correct and unchanged.

  test("LIGHT tier runs no container verify", async () => {
    const { done, calls } = runFanout({
      ceremonyTier: "LIGHT",
      container: CONTAINER,
    });
    await done;
    expect(byLabel(calls, "container-rebuild")).toBeUndefined();
    expect(byLabel(calls, "quinn-container")).toBeUndefined();
  });

  test("STANDARD tier runs container verify", async () => {
    const { done, calls } = runFanout({
      ceremonyTier: "STANDARD",
      container: CONTAINER,
    });
    await done;
    expect(byLabel(calls, "quinn-container")).toBeDefined();
  });

  test("THOROUGH with no container config still runs Rook", async () => {
    const { done, calls, logs } = runFanout({
      ceremonyTier: "THOROUGH",
      container: null,
    });
    await done;
    expect(byLabel(calls, "rook")).toBeDefined();
    expect(byLabel(calls, "quinn-container")).toBeUndefined();
    expect(logs.some((l) => /skipping container verify/i.test(l))).toBe(true);
  });

  test("container present but unreachable skips Quinn without failing", async () => {
    const start = shipSource.indexOf(BLOCK_START);
    const end = shipSource.indexOf(BLOCK_END);
    const block = shipSource.slice(start + BLOCK_START.length, end);
    const logs: string[] = [];
    const labels: string[] = [];

    const agent = async (_p: string, o: { label: string }) => {
      labels.push(o.label);
      return o.label === "env-check" ? { host0: false } : {};
    };
    const briefedAgent = async (_p: string, o: { label: string }) => {
      labels.push(o.label);
      return { result: "PASS" };
    };

    const factory = new Function(
      "log",
      "agent",
      "briefedAgent",
      "parallel",
      "discovery",
      "projectConfig",
      "PROJECT_ROOT",
      "WORK_DIR",
      "ISSUE",
      "GATE_RESULT_SCHEMA",
      `return (async () => {${block}})()`,
    );

    await factory(
      (m: string) => logs.push(String(m)),
      agent,
      briefedAgent,
      (thunks: Array<() => Promise<unknown>>) =>
        Promise.all(thunks.map((t) => t())),
      {
        ceremonyTier: "THOROUGH",
        acs: [],
        filesToModify: ["lib/a.ts"],
      },
      { container: CONTAINER },
      REPO_ROOT,
      "/tmp/work",
      66,
      {},
    );

    expect(labels).not.toContain("quinn-container");
    expect(labels).toContain("rook");
    expect(logs.some((l) => /No test container available/i.test(l))).toBe(true);
  });
});

describe("#127: the security review is not a function of having a UI", () => {
  /**
   * Rook used to be gated on `ceremonyTier === 'THOROUGH'`, and ship.js:849
   * forces LIGHT for any project with an empty `pages` map. THOROUGH was
   * therefore unreachable for every CLI and library, and the security review
   * could not run on them at all — confirmed by the agent census in #126: rook
   * launched 0 times across 3,555 workflow agents.
   *
   * Two tests above previously asserted the old behaviour ("LIGHT tier runs
   * neither container verify nor Rook", "STANDARD tier runs container verify
   * but not Rook"). They were correct descriptions of the code and wrong
   * descriptions of the intent: AGENTS.md says "Security — mandatory every
   * build cycle on changed files", and "Spawn Security after every build
   * cycle. Do not wait to be asked." They are updated, not deleted.
   *
   * The tier still governs Quinn and the container, which genuinely need a UI.
   */

  test("Rook runs on a LIGHT tier — the case that never happened", async () => {
    const { done, calls } = runFanout({ ceremonyTier: "LIGHT", container: CONTAINER });
    await done;
    expect(
      byLabel(calls, "rook"),
      "a CLI project still cannot get a security review",
    ).toBeDefined();
  });

  test("Rook runs on STANDARD too", async () => {
    const { done, calls } = runFanout({ ceremonyTier: "STANDARD", container: CONTAINER });
    await done;
    expect(byLabel(calls, "rook")).toBeDefined();
  });

  test("LIGHT still skips the container chain and container Quinn", async () => {
    // The over-fix guard. Decoupling Rook from the tier must not drag the
    // browser-driven steps along with it — running Quinn against a project
    // with no pages is what the override was right about.
    const { done, calls } = runFanout({ ceremonyTier: "LIGHT", container: CONTAINER });
    await done;
    expect(byLabel(calls, "quinn-container")).toBeUndefined();
    expect(byLabel(calls, "container-rebuild")).toBeUndefined();
  });

  test("Rook is skipped when the change touched no files", async () => {
    // The new trigger is "there is something to review", so the empty case has
    // to be the one that skips — otherwise the gate can never fail closed and
    // we have swapped one unconditional for another.
    const start = shipSource.indexOf(BLOCK_START);
    const end = shipSource.indexOf(BLOCK_END);
    const block = shipSource.slice(start + BLOCK_START.length, end);
    const labels: string[] = [];

    const factory = new Function(
      "log", "agent", "briefedAgent", "parallel", "discovery",
      "projectConfig", "PROJECT_ROOT", "WORK_DIR", "ISSUE", "GATE_RESULT_SCHEMA",
      `return (async () => {${block}})()`,
    );
    await factory(
      () => {},
      async (_p: string, o: { label: string }) => { labels.push(o.label); return {}; },
      async (_p: string, o: { label: string }) => { labels.push(o.label); return { result: "PASS" }; },
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      { ceremonyTier: "LIGHT", acs: [], filesToModify: [] },
      { container: null },
      REPO_ROOT, "/tmp/work", 66, {},
    );

    expect(labels).not.toContain("rook");
  });
});
