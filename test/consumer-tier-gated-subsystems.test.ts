import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  CODE_ONLY_ACS,
  CONSUMER_CLI,
  CONSUMER_CLI_WITHOUT_CONTAINER,
  CONSUMER_FIXTURE,
  CONSUMER_WITHOUT_CONTAINER,
  CONTROL_ASSERTIONS,
  UI_ACS,
  runContainerVerify,
  runProveDispatch,
  runQuinnLocal,
  runRemotePreflight,
  runScopeGate,
  scanAssertions,
} from "./helpers/consumer-ship-sites";

/**
 * #274 AC-2 — the five tier-gated ship.js subsystems a consumer run enters,
 * observed by each subsystem's OWN output rather than by the tier string that
 * admitted it, plus the remote pre-flight which is NOT tier-gated.
 *
 * rungate's own config declares `pages: {}`, so `workflows/ship.js` rewrites
 * every self-run to LIGHT and all five have never executed once in this repo's
 * history. A consumer (DailyBriefDashboard: 18 pages, a container, a remote
 * host) takes the other branch at every one of them. This file loads that
 * consumer as an on-disk FIXTURE and runs the real ship.js blocks against it.
 *
 * The five tier-gated sites, and the output each is observed by:
 *
 * | ship.js site | gate | observed by |
 * |---|---|---|
 * | `const skipScope = … === 'LIGHT'` | tier | the `scope` gate invocation record |
 * | `if (… !== 'LIGHT')` (Quinn local) | tier | the `quinn-local-1` agent label |
 * | `if (… !== 'LIGHT' && containerConfig)` | tier + config | the `container-rebuild`, `env-check` and `quinn-container` labels |
 * | `} else if (… !== 'LIGHT')` | tier | the container-less arm's own skip log |
 * | `shouldProve = … !== 'LIGHT' && hasUIACs` | tier + UI ACs | the prove workflow's `scriptPath` |
 *
 * What makes the observation honest, and why the file is shaped this way:
 *
 * - Nothing here asserts on a tier. A test that read `ceremonyTier` back would
 *   be re-reading the input the fixture planted — it would stay green over a
 *   subsystem that never ran. Every assertion reads a gate invocation name, an
 *   agent label, a workflow scriptPath, or the subsystem's own log line. That
 *   prohibition is itself measured: `scanAssertions` counts the assertions in
 *   this file that read the tier field, and the count must be 0.
 * - Nothing here matches source text for the behaviour it claims. Each block is
 *   extracted from `workflows/ship.js` and EXECUTED, per
 *   `.claude/rules/checks-must-be-able-to-fail.md`.
 * - Every "it ran" assertion is paired with a NOT-ran case driven by a real
 *   resolution of the same block, so a harness that recorded invocations
 *   unconditionally would go red.
 *
 * The mutation that proves all of this can fail lives in
 * `test/consumer-tier-downgrade-mutation.test.ts`, which rebuilds the pre-#215
 * source and spawns an equivalent observation set against it.
 */

const SELF = join(import.meta.dir, "consumer-tier-gated-subsystems.test.ts");
const selfSource = readFileSync(SELF, "utf-8");

// ── Site 1: the scope gate, by its recorded gate invocation ──

describe("#274 AC-2 site 1/5: the scope gate executes on the consumer fixture", () => {
  test("the fixture-resolved run records a gate invocation named scope", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    // The gate's own output: what `runGateWithHeal` was asked to run. Not the
    // tier that let it through, and not a `skipScope` boolean this file set.
    expect(run.gateInvocations).toEqual(["scope"]);
  });

  test("the same block resolved to LIGHT records no invocation at all", async () => {
    const run = await runScopeGate({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.gateInvocations).toEqual([]);
  });

  test("the two runs are distinguishable by the gate's own verdict line", async () => {
    // Vacuity guard for the pair above: if the harness silently failed to
    // execute the block, both runs would record nothing and the LIGHT case
    // would pass for the wrong reason.
    const ran = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    const skipped = await runScopeGate({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(ran.logs).toContain("Scope: PASS");
    expect(skipped.logs).toContain("Scope: SKIPPED");
  });

  test("the invocation carries the gate's phase, so it is a real call site", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.gateCalls[0]?.phase).toBe("Scope");
  });
});

// ── Site 2: Quinn local, by agent label ──────────────────────

describe("#274 AC-2 site 2/5: Quinn local executes, observed by its own agent label", () => {
  test("the fixture run spawns the quinn-local agent", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toContain("quinn-local-1");
  });

  test("the spawn carries the Validate phase, so it is a real call site", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.agentCalls.find((c) => c.label === "quinn-local-1")?.phase).toBe("Validate");
  });

  test("the same block resolved to LIGHT spawns no agent and says so", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toEqual([]);
    expect(run.logs).toContain("Quinn local: SKIPPED (LIGHT tier)");
  });
});

// ── Site 3: container verify, by its three agent labels ──────

describe("#274 AC-2 site 3/5: the container path executes, observed by its three labels", () => {
  test("the fixture declares the container config this path requires", () => {
    expect(Object.keys(CONSUMER_FIXTURE.container ?? {}).length).toBeGreaterThan(0);
    expect((CONSUMER_FIXTURE.container?.hosts ?? []).length).toBeGreaterThan(0);
  });

  test("the rebuild, the env check and the container Quinn are all spawned", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toContain("container-rebuild");
    expect(run.agentLabels).toContain("env-check");
    expect(run.agentLabels).toContain("quinn-container");
  });

  test("the container-rebuild spawn is recorded against the Verify phase", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.agentCalls.find((c) => c.label === "container-rebuild")?.phase).toBe("Verify");
  });

  test("the env check's own log names the host the fixture declared", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    const host = (CONSUMER_FIXTURE.container?.hosts ?? [])[0];
    expect(
      run.logs.some((l) => l.startsWith("Container env:") && l.includes(`${host}=true`)),
    ).toBe(true);
  });

  test("the same block resolved to LIGHT spawns none of the three, with the same container config", async () => {
    const run = await runContainerVerify({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toEqual([]);
  });
});

// ── Site 4: the container-less arm, by its own skip log ──────

const SKIP_LOG = "No container config in rungate.json — skipping container verify";

describe("#274 AC-2 site 4/5: the container-less arm says the config declined", () => {
  test("it emits the skip log and spawns nothing", async () => {
    const run = await runContainerVerify({
      config: CONSUMER_WITHOUT_CONTAINER,
      discoveryTier: "STANDARD",
    });
    expect(run.logs).toContain(SKIP_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("a run the tier gated out stays silent, so the two are distinguishable", async () => {
    // Same absent container, different reason. Without this pair the skip log
    // would only prove the string exists in ship.js.
    const run = await runContainerVerify({
      config: CONSUMER_CLI_WITHOUT_CONTAINER,
      discoveryTier: "STANDARD",
    });
    expect(run.logs).not.toContain(SKIP_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("the fixture WITH a container takes neither skip path", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "STANDARD" });
    expect(run.logs).not.toContain(SKIP_LOG);
  });
});

// ── Site 5: prove, by the workflow scriptPath it dispatched ──

describe("#274 AC-2 site 5/5: prove dispatches the prove workflow for the fixture's UI ACs", () => {
  test("the captured workflow call points at workflows/prove.js", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      discoveryTier: "STANDARD",
      acs: UI_ACS,
    });
    const paths = run.workflowCalls.map((c) => c.scriptPath);
    expect(paths.filter((p) => p.endsWith("workflows/prove.js")).length).toBe(1);
  });

  test("with the UI ACs removed it skips instead, by its own log", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      discoveryTier: "STANDARD",
      acs: CODE_ONLY_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
    expect(run.logs.some((l) => l.startsWith("Prove: SKIPPED"))).toBe(true);
  });

  test("the tier gates it too — the same UI ACs resolved to LIGHT dispatch nothing", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_CLI,
      discoveryTier: "STANDARD",
      acs: UI_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
  });

  test("the fixture's AC set is what makes the difference, not the harness", () => {
    // The two runs above differ in exactly one input. If UI_ACS carried no
    // UI-shaped AC, the first test would be asserting over an empty branch.
    const uiShaped = UI_ACS.filter(
      (ac) =>
        ac.type === "OUTCOME" ||
        ac.evidenceMethod?.type === "PLAYWRIGHT" ||
        ac.evidenceMethod?.type === "SCREENSHOT",
    );
    expect(uiShaped.length).toBeGreaterThan(0);
    expect(
      CODE_ONLY_ACS.filter(
        (ac) =>
          ac.type === "OUTCOME" ||
          ac.evidenceMethod?.type === "PLAYWRIGHT" ||
          ac.evidenceMethod?.type === "SCREENSHOT",
      ).length,
    ).toBe(0);
  });
});

// ── The pre-flight is NOT tier-gated, and the scan ───────────

describe("#274 AC-2: the remote pre-flight runs at both tiers", () => {
  test("both runs emit a PRE-FLIGHT line — 2 emissions across the two tiers", async () => {
    const light = await runRemotePreflight({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    const standard = await runRemotePreflight({
      config: CONSUMER_FIXTURE,
      discoveryTier: "STANDARD",
    });
    const emissions = [...light.logs, ...standard.logs].filter((l) => l.startsWith("PRE-FLIGHT:"));
    expect(emissions.length).toBe(2);
  });

  test("the two runs really did resolve to different tiers", async () => {
    // Read from the harness, not asserted as a tier: if both configs resolved
    // the same way the count above would be a pair of identical runs.
    const light = await runRemotePreflight({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    const standard = await runRemotePreflight({
      config: CONSUMER_FIXTURE,
      discoveryTier: "STANDARD",
    });
    expect(light.tiersDiffer(standard)).toBe(true);
  });

  test("a fixture with no remote hosts emits nothing, so the log is load-bearing", async () => {
    const run = await runRemotePreflight({
      config: { ...CONSUMER_FIXTURE, remoteHosts: {} },
      discoveryTier: "STANDARD",
    });
    expect(run.logs.filter((l) => l.startsWith("PRE-FLIGHT:"))).toEqual([]);
  });
});

describe("#274 AC-2: no assertion in this file reads the tier field", () => {
  test("the scan finds 0 assertions reading it", () => {
    expect(scanAssertions(selfSource).readingCeremonyTier).toBe(0);
  });

  test("the scan has something to look at", () => {
    // Vacuity guard: a scanner that found no assertions at all would report 0
    // forever, including over a file that read the tier on every line.
    expect(scanAssertions(selfSource).total).toBeGreaterThan(20);
  });

  test("the scan can see a reading when there is one", () => {
    // Positive control, held in the helper so writing it does not put the token
    // inside an assertion in this file and make the scan above self-refuting.
    expect(scanAssertions(CONTROL_ASSERTIONS).readingCeremonyTier).toBe(1);
    expect(scanAssertions(CONTROL_ASSERTIONS).total).toBe(2);
  });
});
