/**
 * Covers SC-1748..SC-1757 (HARNESS-STANDARD.md), #61 re-scoped.
 *
 * `workflows/ship.js` is 7,300 lines of orchestration, and until now the only
 * way to find out whether a change to it was correct was to run the pipeline:
 * real agents, real model calls, fifteen minutes. So 98 test files read it as
 * TEXT instead, and this repo's standing record is that every source-text
 * assertion it has written survived its first mutation.
 *
 * This file runs it. `lib/workflow-test-harness.ts` strips the `meta` export,
 * wraps the top-level body in an async function and supplies the six globals
 * the Workflow sandbox would — so the real control flow executes, with the
 * real conditionals, and the harness records the order of what happened.
 *
 * **Measured: 14-20 ms, 18 agent calls, Goal → Discovery → Scope → Implement.**
 * #61 asked for under a second.
 *
 * Why it is this cheap is worth stating, because it reads like luck and is
 * not: a workflow script has no filesystem, no subprocess and no imports
 * (#69), so stubbing `agent` removes everything slow by construction. The
 * property that makes ship.js untestable by ordinary means is the same one
 * that makes it instant here.
 *
 * Two things the harness found on its first run, before any of these tests
 * were written, which is the argument for it existing:
 *
 *   - `brief-preflight-assemble` declares no schema (SC-1752)
 *   - a call site may legitimately declare a phase it has not reached, so the
 *     obvious boundary check is wrong in the loud direction (SC-1753)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  HarnessRefusal,
  SHIP_PHASES,
  agentPhaseViolations,
  callGraph,
  phaseOrderViolations,
  runWorkflow,
  syntheticFromSchema,
  workflowBody,
  type HarnessCall,
} from "../lib/workflow-test-harness";

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

const ARGS = {
  issue: 61,
  projectRoot: "/tmp/rungate-harness-contract",
  repo: "owner/repo",
  issueRepo: "owner/repo",
  harnessRoot: "/tmp/rungate-harness-root",
};

/**
 * Overrides that make one coherent synthetic run.
 *
 * Each one exists because the script REFUSED without it, and the refusals are
 * the script working: a one-word AC statement is too short for the state
 * schema, an AC that covers no success criterion is a criterion nobody
 * measures (#251), and a `priorWork` whose every AC reads MET is an
 * already-shipped issue. Driving past them is supplying a plausible run, not
 * disabling checks — each override is the smallest edit that makes the
 * synthetic data self-consistent.
 */
const COHERENT = (tier: string, pages: Record<string, string>) => ({
  "read-issue": (s: any) => ({
    ...s,
    successCriteria: ["- [ ] SC-1: the harness executes the workflow end to end"],
  }),
  setup: (s: any) => ({ ...s, config: { ...(s.config ?? {}), pages } }),
  discovery: (s: any) => ({
    ...s,
    sizing: "M",
    ceremonyTier: tier,
    priorWork: null,
    acs: (s.acs ?? []).slice(0, 1).map((a: any) => ({ ...a, id: "AC-1", coversCriteria: ["SC-1"] })),
  }),
});

const phasesOf = (calls: HarnessCall[]) =>
  calls.filter((c): c is Extract<HarnessCall, { kind: "phase" }> => c.kind === "phase").map((c) => c.title);
const labelsOf = (calls: HarnessCall[]) =>
  calls.filter((c) => c.kind === "agent").map((c) => (c as any).label);

// ── SC-1: it runs ────────────────────────────────────────────

describe("#61 SC-1: the whole workflow executes with no agents", () => {
  test("SC-1748: ship.js runs end to end in well under a second and returns a terminal status", async () => {
    const run = await runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) });

    // The error is surfaced rather than converted to a verdict. A harness
    // reporting "the workflow did not complete" is indistinguishable from one
    // whose own stubs are wrong, which is the failure a mock is most prone to
    // and least able to see.
    expect(run.error, run.error ? `the workflow threw: ${run.error.message}` : "").toBeNull();
    expect(run.ms, `${run.ms}ms — #61's criterion is under a second`).toBeLessThan(1000);

    // It reaches a terminal status rather than falling off the end.
    expect(typeof (run.result as any)?.status).toBe("string");

    // And it actually DID something. A run that made no agent calls would
    // satisfy every assertion above and measure nothing — the vacuity guard
    // that matters most in a file whose subject is a mock.
    expect(labelsOf(run.calls).length).toBeGreaterThan(10);
    expect(phasesOf(run.calls)).toContain("Implement");

    // And a runaway script fails the harness loudly rather than hanging the
    // suite or stopping quietly — a quiet stop is indistinguishable from a
    // short run, which is the reading that would send someone looking at the
    // script instead of at the cap.
    const capped = await runWorkflow(SHIP, { args: { ...ARGS }, maxCalls: 3 });
    expect(capped.error?.message).toMatch(/more than 3 agent calls/);
  });

  test("SC-1749: the meta export is removed by slicing its literal - and a script without one is refused", () => {
    const body = workflowBody(SHIP);
    expect(body.startsWith("export const meta")).toBe(false);
    // The slice must not eat the script. A `\n}\n` found too late would
    // silently remove real code, and the harness would report a short run.
    expect(body.length).toBeGreaterThan(SHIP.length * 0.9);
    expect(body).toContain("phase('Goal')");

    expect(() => workflowBody("const x = 1\n")).toThrow(HarnessRefusal);
    expect(() => workflowBody("export const meta = { name: 'x'")).toThrow(/end of the workflow's .meta. literal/);
  });
});

// ── SC-2: the ceremony tiers ─────────────────────────────────

describe("#61 SC-2: all three ceremony tiers are driven and observed", () => {
  test("SC-1750: each declared tier produces a different run - and a UI project floors LIGHT to STANDARD", async () => {
    const run = (tier: string, pages: Record<string, string>) =>
      runWorkflow(SHIP, { args: { ...ARGS, dryRun: true }, overrides: COHERENT(tier, pages) });

    const [light, standard, thorough, flooredIn] = await Promise.all([
      run("LIGHT", {}),
      run("STANDARD", { home: "/" }),
      run("THOROUGH", { home: "/" }),
      run("LIGHT", { home: "/" }),
    ]);

    expect((light.result as any).ceremonyTier).toBe("LIGHT");
    expect((standard.result as any).ceremonyTier).toBe("STANDARD");
    expect((thorough.result as any).ceremonyTier).toBe("THOROUGH");

    // The floor (#127-era behaviour), observed rather than read off the
    // source: a project that declares pages cannot run LIGHT, because LIGHT
    // means no Quinn and no container.
    expect((flooredIn.result as any).ceremonyTier).toBe("STANDARD");

    // And the tiers are not three names for one run. LIGHT skips the scope
    // gate; the others do not. This is the assertion that makes the three
    // rows above more than a field echo.
    expect(labelsOf(light.calls)).not.toContain("scope-1");
    expect(labelsOf(standard.calls)).toContain("scope-1");
    expect(labelsOf(thorough.calls)).toContain("scope-1");
  });

  test("SC-1751: a dry run stops after scope and a full run reaches Implement", async () => {
    const dry = await runWorkflow(SHIP, {
      args: { ...ARGS, dryRun: true },
      overrides: COHERENT("STANDARD", { home: "/" }),
    });
    const full = await runWorkflow(SHIP, {
      args: { ...ARGS },
      overrides: COHERENT("STANDARD", { home: "/" }),
    });

    expect((dry.result as any).status).toBe("DRY_RUN_COMPLETE");
    expect(phasesOf(dry.calls)).toEqual(["Goal", "Discovery", "Scope"]);
    expect(phasesOf(dry.calls)).not.toContain("Implement");

    // #59's payload, reached by execution rather than by extraction — this is
    // the same claim test/dry-run-evidence-quality.test.ts makes about the
    // lifted block, now made about the running script.
    expect((dry.result as any).acCount).toBe(1);
    expect((dry.result as any).evidenceQuality?.status).toBeTruthy();

    expect(phasesOf(full.calls)).toContain("Implement");
    expect(labelsOf(full.calls)).toContain("marcus");
  });
});

// ── the harness's own honesty ────────────────────────────────

describe("#61 SC-2': a call site with no schema is reported - never defaulted", () => {
  test("SC-1752: ship.js's unschemaed call sites are named", async () => {
    const run = await runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) });

    // A mock that returns `{}` for a schemaless call is a mock testing
    // itself: the script reads a field, gets `undefined`, and takes a branch
    // nobody chose. They are reported instead, and this is the harness's
    // first real finding about ship.js — `brief-preflight-assemble` asks an
    // agent for work and declares nothing about the shape of the answer.
    expect(run.unschemaed).toContain("brief-preflight-assemble");

    // Not a blanket complaint: the overwhelming majority DO declare one, so
    // the list is a finding rather than a property of the harness.
    expect(run.unschemaed.length).toBeLessThan(labelsOf(run.calls).length / 2);

    // And the synthesiser populates optional properties, not just required
    // ones. A minimal object satisfies the schema and exercises only the
    // branches that handle absence, so a harness returning `{required: ...}`
    // would systematically run the script's fallbacks and never its mainline.
    const synthetic = syntheticFromSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "array", items: { type: "number" } } },
      required: ["a"],
    });
    expect(Object.keys(synthetic).sort()).toEqual(["a", "b"]);
    // One element, not zero — an empty array makes every downstream `.map`,
    // `.length` and `for…of` a no-op, and the run reads as clean.
    expect(synthetic.b).toHaveLength(1);
    // An enum takes its first value, which is the knob `overrides` exists to turn.
    expect(syntheticFromSchema({ type: "string", enum: ["LIGHT", "STANDARD"] })).toBe("LIGHT");
  });
});

// ── SC-3/4: phase boundaries ─────────────────────────────────

describe("#61 SC-3: phase boundary violations are caught", () => {
  test("SC-1753: ship.js's real run has no backwards phase - and declaring ahead is not a violation", async () => {
    const run = await runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) });
    expect(phaseOrderViolations(run.calls)).toEqual([]);
    expect(agentPhaseViolations(run.calls)).toEqual([]);

    // The narrowing, pinned. The harness's FIRST output was
    // `preload-contexts` — which declares `Discovery` and runs 264 lines
    // before `phase('Discovery')`. That is not a defect: `opts.phase` assigns
    // a progress GROUP and the workflow API documents declaring one ahead of
    // the global state so parallel stages do not race it. A check that
    // refused it would be a detector wider than what it detects, and would be
    // switched off within a week.
    const declaresAhead = run.calls.find(
      (c) => c.kind === "agent" && (c as any).label === "preload-contexts",
    ) as any;
    expect(declaresAhead?.phase, "preload-contexts no longer declares a phase ahead").toBe("Discovery");
    const before = run.calls.indexOf(declaresAhead);
    const discoveryAt = run.calls.findIndex((c) => c.kind === "phase" && c.title === "Discovery");
    expect(before, "preload-contexts no longer runs before phase('Discovery')").toBeLessThan(discoveryAt);
    expect(agentPhaseViolations(run.calls)).toEqual([]);
  });

  test("SC-1754: a planted backwards phase is caught - and so is a phase the order does not know", () => {
    const ok: HarnessCall[] = [
      { kind: "phase", title: "Goal" },
      { kind: "phase", title: "Scope" },
      { kind: "phase", title: "Implement" },
    ];
    expect(phaseOrderViolations(ok)).toEqual([]);

    // The violation #61 names by example.
    const backwards: HarnessCall[] = [
      { kind: "phase", title: "Goal" },
      { kind: "phase", title: "Implement" },
      { kind: "phase", title: "Scope" },
    ];
    expect(phaseOrderViolations(backwards)).toHaveLength(1);
    expect(phaseOrderViolations(backwards)[0]).toContain("Scope");
    expect(phaseOrderViolations(backwards)[0]).toContain("Implement");

    // Re-entry is not a backwards jump — a regression path re-runs a phase,
    // and refusing that would make the check wrong on the runs it exists for.
    expect(phaseOrderViolations([
      { kind: "phase", title: "Discovery" },
      { kind: "phase", title: "Discovery" },
    ])).toEqual([]);

    // A phase the order does not know is a violation, not a pass. Adding one
    // to ship.js without adding it here means the harness has stopped
    // describing the script, and defaulting that to "fine" is how a contract
    // check goes blind.
    expect(phaseOrderViolations([{ kind: "phase", title: "Teatime" }])).toHaveLength(1);
    expect(SHIP_PHASES).toContain("Prove");
  });

  test("SC-1755: an agent that has escaped its phase is caught - in the backwards direction only", () => {
    const escaped: HarnessCall[] = [
      { kind: "phase", title: "Goal" },
      { kind: "phase", title: "Ship" },
      { kind: "agent", label: "read-issue", phase: "Goal", schemaed: true },
    ];
    expect(agentPhaseViolations(escaped)).toHaveLength(1);
    expect(agentPhaseViolations(escaped)[0]).toContain("escaped its phase");

    const ahead: HarnessCall[] = [
      { kind: "phase", title: "Goal" },
      { kind: "agent", label: "preload", phase: "Discovery", schemaed: true },
    ];
    expect(agentPhaseViolations(ahead)).toEqual([]);

    // An unknown phase belongs to `phaseOrderViolations` and is not reported
    // twice. Two deciders on one fact is the fourth shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`, and the split is
    // deliberate rather than accidental.
    expect(agentPhaseViolations([
      { kind: "phase", title: "Teatime" },
      { kind: "agent", label: "x", phase: "Goal", schemaed: true },
    ])).toEqual([]);
  });

  test("SC-1756: a planted violation in ship.js itself is caught by the running harness", async () => {
    // The end-to-end demonstration #61 asks for: not a hand-built call list,
    // but the real script, edited, executed, and refused. `phase('Scope')`
    // becomes `phase('Prove')`, so the run enters the last phase third and
    // everything after it is backwards.
    const mutated = SHIP.replace("phase('Scope')", "phase('Prove')");
    expect(mutated, "the planted edit did not apply").not.toBe(SHIP);

    const run = await runWorkflow(mutated, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) });
    const violations = phaseOrderViolations(run.calls);
    expect(violations.length, "a backwards phase in the real script was not caught").toBeGreaterThan(0);
    expect(violations.join("\n")).toContain("Implement");

    // The control. The unedited script through the same code path is clean,
    // so the row above is the mutation and not the harness.
    const clean = await runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) });
    expect(phaseOrderViolations(clean.calls)).toEqual([]);
  });
});

// ── SC-5: pass^k over the orchestration ──────────────────────

describe("#61 SC-5: pass^k, over the thing this repo controls", () => {
  test("SC-1757: five runs with the same inputs produce one identical call graph", async () => {
    // #61 asked for pass^k across five real dry-runs on one issue. That is
    // five pipelines, real model calls, unreproducible in CI, and what it
    // measures is a property of the model on the day rather than of this
    // tree. Two different questions were bundled: is the ORCHESTRATION
    // deterministic, and is DISCOVERY'S OUTPUT deterministic. This is the
    // first, which is free and is the half the repo can fix. The second is
    // filed separately with its cost written down.
    const k = 5;
    const runs = await Promise.all(
      Array.from({ length: k }, () =>
        runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("STANDARD", { home: "/" }) }),
      ),
    );

    const graphs = runs.map((r) => callGraph(r.calls));
    const distinct = new Set(graphs);
    expect(
      distinct.size,
      `pass^${k} failed: ${distinct.size} distinct call graphs across ${k} runs:\n` +
        [...distinct].map((g, i) => `--- graph ${i} ---\n${g}`).join("\n"),
    ).toBe(1);

    // Vacuity guard, and the one that matters: an empty graph is identical to
    // an empty graph. `pass^k = 1` over nothing is the cheapest green in this
    // file.
    expect(graphs[0]!.split("\n").length).toBeGreaterThan(10);
    expect(graphs[0]).toContain("phase:Goal");
    expect(graphs[0]).toContain("agent:marcus@Implement");

    // And the instrument can report a difference, or the row above means
    // nothing. Two runs that genuinely differ must produce two graphs.
    const light = await runWorkflow(SHIP, { args: { ...ARGS }, overrides: COHERENT("LIGHT", {}) });
    expect(callGraph(light.calls)).not.toBe(graphs[0]);
  });
});
