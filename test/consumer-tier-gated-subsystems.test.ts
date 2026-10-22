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
  FIXTURE_TIER,
  UI_ACS,
  runContainerVerify,
  runProveDispatch,
  runQuinnLocal,
  runRemotePreflight,
  runScopeGate,
  scanAssertions,
} from "./helpers/consumer-ship-sites";

/**
 * #274 AC-2 — the ship.js subsystems a consumer run enters, observed by each
 * subsystem's OWN output rather than by the tier string that admitted it.
 *
 * rungate's own config declares `pages: {}`, so the downgrade in
 * `workflows/ship.js` rewrites every self-run to LIGHT and five tier-gated
 * subsystems have never executed once in this repo's history. A consumer
 * (DailyBriefDashboard: 18 pages, a container, a remote host) takes the other
 * branch at all five. This file loads that consumer's config from disk as a
 * FIXTURE and runs the real ship.js blocks against it.
 *
 * The five tier-gated sites, grepped on main rather than taken from the issue
 * body, which is wrong in one slot:
 *
 *   scope gate        `const skipScope = discovery.ceremonyTier === 'LIGHT'`
 *   Quinn local       `if (discovery.ceremonyTier !== 'LIGHT') {`
 *   container verify  `if (… !== 'LIGHT' && containerConfig) {`
 *   container skip    `} else if (discovery.ceremonyTier !== 'LIGHT') {`
 *   prove             `const shouldProve = … !== 'LIGHT' && hasUIACs`
 *
 * The fourth is the arm the issue calls "Quinn verify". It is not: it spawns no
 * agent, it emits one log line saying the container config declined. It is
 * still tier-gated and still unexecuted on this repo, so it is observed here —
 * by the only output it has.
 *
 * The remote pre-flight is NOT in that list. It runs ~450 lines before
 * `ceremonyTier` is first read, so no tier change can reach it, and it is
 * observed separately at both tiers for exactly that reason.
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
 */

const SELF = join(import.meta.dir, "consumer-tier-gated-subsystems.test.ts");
const selfSource = readFileSync(SELF, "utf-8");

// ── The premise every observation below rests on ─────────────────────

describe("#274 AC-2: every run starts from the fixture's own discovered tier", () => {
  test("the fixture's discovery produced the skipping tier, not the running one", () => {
    // Without this, the whole file could be handed a tier it typed in itself,
    // the floor would be irrelevant, and the subsystems would run whether or
    // not ship.js raised anything. `FIXTURE_TIER` is read from the fixture's
    // workflow-state.json and is the default for every run below.
    expect(FIXTURE_TIER).toBe("LIGHT");
  });
});

// ── Tier-gated site 1: the scope gate, by its recorded invocation ────

describe("#274 AC-2: the scope gate executes on the consumer fixture", () => {
  test("the fixture-resolved run records a gate invocation named scope", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE });
    // The gate's own output: what `runGateWithHeal` was asked to run. Not the
    // tier that let it through, and not a `skipScope` boolean this file set.
    expect(run.gateInvocations).toEqual(["scope"]);
  });

  test("the same block resolved to LIGHT records no invocation at all", async () => {
    const run = await runScopeGate({ config: CONSUMER_CLI });
    expect(run.gateInvocations).toEqual([]);
  });

  test("the two runs are distinguishable by the gate's own verdict line", async () => {
    // Vacuity guard for the pair above: if the harness silently failed to
    // execute the block, both runs would record nothing and the LIGHT case
    // would pass for the wrong reason.
    const ran = await runScopeGate({ config: CONSUMER_FIXTURE });
    const skipped = await runScopeGate({ config: CONSUMER_CLI });
    expect(ran.logs).toContain("Scope: PASS");
    expect(skipped.logs).toContain("Scope: SKIPPED");
  });

  test("the invocation carries the gate's phase, so it is a real call site", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE });
    expect(run.gateCalls[0]?.phase).toBe("Scope");
  });
});

// ── Tier-gated site 2: Quinn local, by agent label ───────────────────

describe("#274 AC-2: Quinn local executes, observed by its own agent label", () => {
  test("the fixture run spawns the quinn-local agent", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE });
    expect(run.agentLabels).toContain("quinn-local-1");
  });

  test("the spawn carries Quinn's role and the Validate phase", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE });
    const call = run.agentCalls.find((c) => c.label === "quinn-local-1");
    expect(call?.phase).toBe("Validate");
    expect(call?.role).toBe("quinn");
  });

  test("the same block resolved to LIGHT spawns no agent and says so", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_CLI });
    expect(run.agentLabels).toEqual([]);
    expect(run.logs).toContain("Quinn local: SKIPPED (LIGHT tier)");
  });
});

// ── Tier-gated site 3: container verify, by its three labels ─────────

describe("#274 AC-2: the container path executes, observed by its own labels", () => {
  test("the fixture declares the container config this path requires", () => {
    expect(Object.keys(CONSUMER_FIXTURE.container ?? {}).length).toBeGreaterThan(0);
    expect((CONSUMER_FIXTURE.container?.hosts ?? []).length).toBeGreaterThan(0);
  });

  test("the rebuild, the env check and the container Quinn are all spawned", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE });
    expect(run.agentLabels).toContain("container-rebuild");
    expect(run.agentLabels).toContain("env-check");
    expect(run.agentLabels).toContain("quinn-container");
  });

  test("the three spawns happen in ship.js's order, all in the Verify phase", async () => {
    // Order is output too: an env check that ran before the rebuild would be
    // probing the previous container, which is the bug the sequencing exists
    // to prevent.
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE });
    expect(run.agentLabels).toEqual(["container-rebuild", "env-check", "quinn-container"]);
    for (const call of run.agentCalls) expect(call.phase).toBe("Verify");
  });

  test("the env check's own log names the host the fixture declared", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE });
    const host = (CONSUMER_FIXTURE.container?.hosts ?? [])[0];
    expect(
      run.logs.some((l) => l.startsWith("Container env:") && l.includes(`${host}=true`)),
    ).toBe(true);
  });

  test("the same block resolved to LIGHT spawns none of the three", async () => {
    const run = await runContainerVerify({ config: CONSUMER_CLI });
    expect(run.agentLabels).toEqual([]);
  });
});

// ── Tier-gated site 4: the container-declined arm, by its log ────────

// #1035: the log named `rungate.json`, the legacy monolith, which is not
// where a consumer on the directory layout keeps its container config and is
// not what ship.js reads either — it reads this run's resolved config.
const SKIP_LOG = "No container config in the resolved config — skipping container verify";

describe("#274 AC-2: the container-declined arm executes and says the config declined", () => {
  test("it emits the skip log and spawns nothing", async () => {
    const run = await runContainerVerify({
      config: CONSUMER_WITHOUT_CONTAINER,
    });
    expect(run.logs).toContain(SKIP_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("a run the tier gated out stays silent, so the two are distinguishable", async () => {
    // Same absent container, different reason. Without this pair the skip log
    // would only prove the string exists in ship.js.
    const run = await runContainerVerify({
      config: CONSUMER_CLI_WITHOUT_CONTAINER,
    });
    expect(run.logs).not.toContain(SKIP_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("the fixture WITH a container takes neither skip path", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE });
    expect(run.logs).not.toContain(SKIP_LOG);
  });
});

// ── Tier-gated site 5: prove, by the workflow it dispatched ──────────

describe("#274 AC-2: prove dispatches the prove workflow for the fixture's UI ACs", () => {
  test("the captured workflow call points at workflows/prove.js", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      acs: UI_ACS,
    });
    const paths = run.workflowCalls.map((c) => c.scriptPath);
    expect(paths.filter((p) => p.endsWith("workflows/prove.js")).length).toBe(1);
  });

  test("the run reports the verdict prove returned, by its own log", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      acs: UI_ACS,
    });
    expect(run.logs).toContain("Prove: PROVEN");
  });

  test("the same block resolved to LIGHT dispatches nothing", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_CLI,
      acs: UI_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
  });

  test("with the UI ACs removed it skips instead, by its own log", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      acs: CODE_ONLY_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
    expect(run.logs.some((l) => l.startsWith("Prove: SKIPPED"))).toBe(true);
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

// ── Not tier-gated: the remote pre-flight, observed at both tiers ────

describe("#274 AC-2: the remote pre-flight runs at both tiers", () => {
  test("both runs emit a PRE-FLIGHT line — 2 emissions across the two tiers", async () => {
    const light = await runRemotePreflight({ config: CONSUMER_CLI });
    const standard = await runRemotePreflight({
      config: CONSUMER_FIXTURE,
    });
    const emissions = [...light.logs, ...standard.logs].filter((l) => l.startsWith("PRE-FLIGHT:"));
    expect(emissions.length).toBe(2);
  });

  test("the two runs really did resolve to different tiers", async () => {
    // Read from the harness, not asserted as a tier: if both configs resolved
    // the same way the count above would be a pair of identical runs.
    const light = await runRemotePreflight({ config: CONSUMER_CLI });
    const standard = await runRemotePreflight({
      config: CONSUMER_FIXTURE,
    });
    expect(light.tiersDiffer(standard)).toBe(true);
  });

  test("a fixture with no remote hosts emits nothing, so the log is load-bearing", async () => {
    const run = await runRemotePreflight({
      config: { ...CONSUMER_FIXTURE, remoteHosts: {} },
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
    expect(scanAssertions(selfSource).total).toBeGreaterThan(30);
  });

  test("the scan can see a reading when there is one", () => {
    // Positive control, held in the helper so writing it does not put the token
    // inside an assertion in this file and make the scan above self-refuting.
    expect(scanAssertions(CONTROL_ASSERTIONS).readingCeremonyTier).toBe(1);
    expect(scanAssertions(CONTROL_ASSERTIONS).total).toBe(2);
  });
});
