/**
 * Covers SC-1731..SC-1747 (HARNESS-STANDARD.md), #60 re-scoped.
 *
 * #60 asked for a trajectory module, a `{workDir}/trajectory.jsonl`, an
 * integration that wraps `agent()` and `phase()` in `workflows/ship.js`, and a
 * viewer. Most of the first two already existed under another name —
 * `scripts/record-agent-timings.ts` has written one short line per agent
 * bracket to `${WORK_DIR}/agent-timings.jsonl` since #227, with queued waits
 * since #239 — and the third is not available at all: ship.js runs in the
 * Workflow sandbox with no filesystem, no subprocess and no clock (#69), so it
 * cannot write a byte. The re-scope is recorded on the issue.
 *
 * What this file is actually defending is the set of ways a timeline lies:
 *
 *   - a phase that recorded nothing printed at zero seconds (SC-1736, SC-1743)
 *   - a missing artifact rendered as an empty run (SC-1742)
 *   - lines the reader does not understand dropped silently (SC-1733, SC-1744)
 *   - a state write recorded as having changed nothing (SC-1740)
 *   - a gate slot with no verdict printed as a pass (SC-1745)
 *
 * Each of those produces a report that looks complete. That is the whole
 * subject of `.claude/rules/checks-must-be-able-to-fail.md`, applied to a
 * diagnostic rather than to a gate: a timeline with a silent hole in it is
 * worse than no timeline, because the next reader plans around it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TRAJECTORY_FILENAME,
  appendTrajectory,
  changedFields,
  parseTrajectoryLine,
  phaseSpans,
  readTrajectory,
  recordStateWrite,
  timeline,
  trajectoryFor,
} from "../lib/trajectory";
import { gateLines, render } from "../scripts/view-trajectory";
import { readTimings, recordEvent } from "../scripts/record-agent-timings";

let DIR = "";
let ARTIFACT = "";

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "rungate-trajectory-"));
  ARTIFACT = join(DIR, TRAJECTORY_FILENAME);
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const agentLine = (label: string, event: "start" | "end", at: number, phase?: string) =>
  ({ kind: "agent", label, event, at, ...(phase ? { phase } : {}) }) as const;

// ── the record kinds ─────────────────────────────────────────

describe("#60 SC-1: the artifact carries agents - phases - gates and mutations", () => {
  test("SC-1731: an agent bracket is written without a type field so older readers still parse it", () => {
    appendTrajectory(ARTIFACT, agentLine("discovery", "start", 1000, "Discovery"));
    const raw = JSON.parse(readFileSync(ARTIFACT, "utf-8").trim());

    // The compatibility constraint, asserted on the bytes. Thousands of these
    // lines are on disk in in-flight runs with no `type`, so `type` absent has
    // to keep meaning "agent bracket" — a discriminator added to the kind that
    // already existed would have made every historical artifact unreadable.
    expect(raw).toEqual({ label: "discovery", event: "start", at: 1000, phase: "Discovery" });
    expect(Object.keys(raw)).not.toContain("type");
    expect(Object.keys(raw)).not.toContain("kind");

    // And the pre-#60 reader still reads it, phase and all.
    expect(readTimings(ARTIFACT).records).toEqual([
      { label: "discovery", event: "start", at: 1000, phase: "Discovery" },
    ]);
  });

  test("SC-1732: a mutation and a gate are written with a type and read back", () => {
    appendTrajectory(ARTIFACT, { kind: "mutation", at: 2000, fields: ["acs", "sizing"], source: "setup" });
    appendTrajectory(ARTIFACT, { kind: "gate", at: 3000, gate: "scope", result: "PASS", failures: [] });
    const read = readTrajectory(ARTIFACT);
    expect(read.malformed).toEqual([]);
    expect(read.records).toEqual([
      { kind: "mutation", at: 2000, fields: ["acs", "sizing"], source: "setup" },
      { kind: "gate", at: 3000, gate: "scope", result: "PASS", failures: [] },
    ]);
  });

  test("SC-1733: the timing reader skips lines it does not own and still reports ones it cannot read", () => {
    // The distinction this test exists for. `readTimings` must not call a
    // mutation line malformed — every run would print its own state writes as
    // corruption — and it must still report a line that is genuinely broken.
    // Dropping both would be the quieter bug and the worse one.
    appendTrajectory(ARTIFACT, agentLine("marcus", "start", 1000, "Implement"));
    appendTrajectory(ARTIFACT, { kind: "mutation", at: 1100, fields: ["acs"] });
    writeFileSync(ARTIFACT, `${readFileSync(ARTIFACT, "utf-8")}{"label":"x","event":"nonsense","at":1}\n`);

    const timings = readTimings(ARTIFACT);
    expect(timings.records.map((r) => r.label)).toEqual(["marcus"]);
    expect(timings.malformed).toEqual(['{"label":"x","event":"nonsense","at":1}']);

    // And the owner of the unknown kinds reports an unknown `type` as
    // malformed, so a record kind nobody has been taught is surfaced exactly
    // once rather than by both readers or by neither.
    writeFileSync(ARTIFACT, `{"type":"telepathy","at":5}\n`);
    const traj = readTrajectory(ARTIFACT);
    expect(traj.records).toEqual([]);
    expect(traj.malformed).toEqual(['{"type":"telepathy","at":5}']);
  });

  test("SC-1734: a queued record with no readable duration stays malformed - not a zero wait", () => {
    // #239's rule, re-asserted through the new parser. Reading an unparseable
    // wait as zero makes the one record whose job is to say "this call waited"
    // report that it did not.
    expect(parseTrajectoryLine('{"label":"a","event":"queued","at":1}')).toBeNull();
    expect(parseTrajectoryLine('{"label":"a","event":"queued","at":1,"waitedMs":-5}')).toBeNull();
    expect(parseTrajectoryLine('{"label":"a","event":"queued","at":1,"waitedMs":500}')).toEqual({
      kind: "agent", label: "a", event: "queued", at: 1, waitedMs: 500,
    });
  });

  test("SC-1735: a mutation that names no changed field is refused rather than recorded empty", () => {
    // A row saying a write happened with no content reads as "something
    // changed and we lost what", which is the shape a reader treats as a
    // defect in the recorder rather than as an absence of change.
    expect(parseTrajectoryLine('{"type":"mutation","at":1,"fields":[]}')).toBeNull();
    expect(parseTrajectoryLine('{"type":"mutation","at":1,"fields":["acs",7]}')).toBeNull();
    expect(parseTrajectoryLine('{"type":"mutation","at":1}')).toBeNull();
  });
});

// ── phase spans ──────────────────────────────────────────────

describe("#60 SC-2: phase spans are derived from the agents that reported in them", () => {
  test("SC-1736: a phase that recorded nothing is absent - never a phase at zero seconds", () => {
    const records = [
      agentLine("read-issue", "start", 1000, "Goal"),
      agentLine("read-issue", "end", 3000, "Goal"),
      agentLine("marcus", "start", 9000, "Implement"),
      agentLine("marcus", "end", 12000, "Implement"),
    ];
    const spans = phaseSpans(records);
    expect(spans.map((s) => s.phase)).toEqual(["Goal", "Implement"]);

    // The criterion. `Discovery` and `Scope` ran between these two and
    // recorded nothing. They must not appear, because a phase printed at 0.000s
    // is indistinguishable from one that genuinely took no time.
    expect(spans.map((s) => s.phase)).not.toContain("Discovery");
    expect(spans.find((s) => s.phase === "Goal")).toEqual({
      phase: "Goal", startedAt: 1000, endedAt: 3000, seconds: 2, agents: 1,
    });

    // And the gap between phases belongs to neither: Goal ends at 3000 and
    // Implement starts at 9000, and nothing claims the six seconds between.
    expect(spans[1]!.startedAt).toBe(9000);
  });

  test("SC-1737: a phase is as wide as its earliest and latest event - not its first and last line", () => {
    // Parallel agents append out of order, so the last line of a phase is
    // routinely not its latest event. Taking file order would under-report
    // every fanned-out phase in the pipeline, which is every interesting one.
    const records = [
      agentLine("sub-a", "start", 5000, "Implement"),
      agentLine("sub-b", "start", 4000, "Implement"),
      agentLine("sub-b", "end", 20000, "Implement"),
      agentLine("sub-a", "end", 9000, "Implement"),
    ];
    const [span] = phaseSpans(records);
    expect(span).toEqual({ phase: "Implement", startedAt: 4000, endedAt: 20000, seconds: 16, agents: 2 });
  });

  test("SC-1738: brackets with no phase contribute no span and are not invented one", () => {
    // Every bracket written before #60 is phaseless. They still appear on the
    // timeline; they just cannot place a phase, and a default like 'unknown'
    // would become a phase sitting beside the real ones.
    const records = [agentLine("old", "start", 1000), agentLine("old", "end", 2000)];
    expect(phaseSpans(records)).toEqual([]);
    expect(timeline(records).map((r) => r.text)).toEqual(["agent old start", "agent old end"]);
  });
});

// ── state mutations ──────────────────────────────────────────

describe("#60 SC-3: state writes are recorded at the one door they go through", () => {
  test("SC-1739: the diff names changed top-level fields and one level into the gate containers", () => {
    const before = { phase: "SCOPE", acs: [1], gates: { scope: { result: "PASS" }, verify: { result: "PASS" } } };
    const after = { phase: "BUILD", acs: [1], gates: { scope: { result: "FAIL" }, verify: { result: "PASS" } } };
    expect(changedFields(before, after)).toEqual(["gates.scope", "phase"]);

    // Compared by value, not by reference. Callers read the state, mutate it
    // in place and write the same object back — a reference comparison would
    // report that nothing ever changes, forever, on every run.
    const shared = { acs: [{ id: "AC-1" }] };
    const mutated = JSON.parse(JSON.stringify(shared));
    mutated.acs[0].id = "AC-2";
    expect(changedFields(shared, mutated)).toEqual(["acs"]);

    // Key order is not a change.
    expect(changedFields({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);

    // An absent key and an explicit `undefined` are the same fact.
    expect(changedFields({ a: 1 }, { a: 1, b: undefined })).toEqual([]);

    // A first write says so rather than listing every field as new.
    expect(changedFields(null, { a: 1, b: 2 })).toEqual(["<initial write>"]);
  });

  test("SC-1740: a write that changed nothing records nothing", () => {
    const state = { phase: "SCOPE" };
    expect(recordStateWrite(join(DIR, "workflow-state.json"), state, state)).toBeNull();
    expect(existsSync(ARTIFACT)).toBe(false);

    // And a write that changed something does record, beside the state file.
    const fields = recordStateWrite(join(DIR, "workflow-state.json"), { phase: "SCOPE" }, { phase: "BUILD" }, "scope-1", 7);
    expect(fields).toEqual(["phase"]);
    expect(JSON.parse(readFileSync(ARTIFACT, "utf-8").trim())).toEqual({
      type: "mutation", at: 7, fields: ["phase"], source: "scope-1",
    });
  });

  test("SC-1741: recording cannot prevent a state write - and says so on stderr when it fails", () => {
    // The ordering rule, as behaviour. A trajectory line is a record OF a
    // write; it must never be able to stop one. `recordStateWrite` is called
    // AFTER `writeState` in gates/orchestrator.ts and cannot throw here even
    // when the destination is impossible.
    const impossible = join(DIR, "no-such-dir\u0000", "workflow-state.json");
    expect(() => recordStateWrite(impossible, { a: 1 }, { a: 2 })).not.toThrow();
    expect(recordStateWrite(impossible, { a: 1 }, { a: 2 })).toBeNull();

    const orchestrator = readFileSync(join(import.meta.dir, "..", "gates", "orchestrator.ts"), "utf-8");
    const write = orchestrator.indexOf("writeState(sf, state as WorkflowState);");
    const record = orchestrator.indexOf("recordStateWrite(sf, before,");
    expect(write, "writeState no longer appears in writeWorkflowState").toBeGreaterThan(0);
    expect(record, "writeWorkflowState no longer records the mutation").toBeGreaterThan(write);

    // And the prior state is read BEFORE the write, because afterwards there
    // is nothing left to diff against.
    expect(orchestrator.indexOf("before = existsSync(sf)")).toBeLessThan(write);
  });
});

// ── the viewer ───────────────────────────────────────────────

describe("#60 SC-4: the viewer refuses to render a complete-looking incomplete run", () => {
  test("SC-1742: a missing artifact is UNMEASURED with its path - not an empty timeline", () => {
    const { lines, unmeasured } = render(readTrajectory(ARTIFACT), ARTIFACT);
    expect(unmeasured).toBe(true);
    expect(lines[0]).toContain("UNMEASURED");
    expect(lines[0]).toContain(ARTIFACT);
    expect(lines.join("\n")).toContain("This is not an empty run");

    // An artifact that exists and holds nothing is a DIFFERENT answer, and the
    // viewer has to be able to tell them apart — that is the whole of the
    // sentence above.
    writeFileSync(ARTIFACT, "");
    const empty = render(readTrajectory(ARTIFACT), ARTIFACT);
    expect(empty.unmeasured).toBe(true);
    expect(empty.lines[0]).toContain("exists and holds no readable records");
    expect(empty.lines.join("\n")).not.toContain("This is not an empty run");
  });

  test("SC-1743: the phase list carries the caveat that it reports what recorded", () => {
    appendTrajectory(ARTIFACT, agentLine("read-issue", "start", 1000, "Goal"));
    appendTrajectory(ARTIFACT, agentLine("read-issue", "end", 4000, "Goal"));
    appendTrajectory(ARTIFACT, { kind: "mutation", at: 4100, fields: ["acs"] });

    const { lines, unmeasured } = render(readTrajectory(ARTIFACT), ARTIFACT);
    const text = lines.join("\n");
    expect(unmeasured).toBe(false);
    expect(text).toContain("agent read-issue start [Goal]");
    expect(text).toContain("state unattributed wrote acs");
    expect(text).toContain("Goal");

    // The sentence is the check. Without it a reader counts the phases listed
    // and concludes the run had that many — the silent-hole failure this whole
    // file is about.
    expect(text).toContain("Phases that recorded nothing are ABSENT from the list above, not");
    expect(text).toContain("the timeline of what recorded, not of what ran");

    // An unattributed mutation says `unattributed`, which is a different word
    // from a name. #60 asked for "by which agent" and this is the honest half:
    // nothing in a `bun -e` one-liner knows which call site spawned it.
    expect(text).not.toContain("state  wrote");
  });

  test("SC-1744: malformed lines are printed verbatim and make the view incomplete", () => {
    appendTrajectory(ARTIFACT, agentLine("a", "start", 1000, "Goal"));
    writeFileSync(ARTIFACT, `${readFileSync(ARTIFACT, "utf-8")}not json at all\n`);
    const { lines, unmeasured } = render(readTrajectory(ARTIFACT), ARTIFACT);
    expect(unmeasured).toBe(true);
    expect(lines.join("\n")).toContain("not json at all");
    expect(lines.join("\n")).toContain("could not be parsed");
  });

  test("SC-1745: a gate slot with no verdict prints UNMEASURED - never a pass", () => {
    // #276's defect, in the reporting layer rather than the deciding one. A
    // gate slot that exists with no result is exactly the shape that was being
    // read as PASS, and a viewer that filled it in would reintroduce it where
    // nothing is watching.
    writeFileSync(join(DIR, "workflow-state.json"), JSON.stringify({
      gates: { scope: { result: "FAIL", failures: ["tsc-pass: 3 errors"] }, verify: {} },
    }));
    const out = gateLines(DIR).join("\n");
    expect(out).toContain("scope");
    expect(out).toContain("FAIL");
    expect(out).toContain("tsc-pass: 3 errors");
    expect(out).toMatch(/verify\s+UNMEASURED/);
    expect(out).not.toMatch(/verify\s+PASS/);

    // And a state file that is absent or unreadable is UNMEASURED too, rather
    // than "no gates ran".
    rmSync(join(DIR, "workflow-state.json"));
    expect(gateLines(DIR).join("\n")).toContain("UNMEASURED");
    writeFileSync(join(DIR, "workflow-state.json"), "{ broken");
    expect(gateLines(DIR).join("\n")).toContain("did not parse");
  });
});

// ── the ship.js wiring ───────────────────────────────────────

describe("#60: the phase travels on the bracket the agent already writes", () => {
  test("SC-1746: the timing instruction passes the call site's phase and omits it when there is none", () => {
    const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

    // Extracted and RUN, not matched. A source-text assertion here would pass
    // over an instruction that built the flag and never used it.
    const a = shipSource.indexOf("function timingInstruction(label, phaseName) {");
    expect(a, "ship.js no longer passes a phase to timingInstruction").toBeGreaterThan(0);
    const b = shipSource.indexOf("\n}\n", a);
    const fn = new Function(
      "shellQuote", "TIMING_SCRIPT", "TIMING_ARTIFACT",
      `${shipSource.slice(a, b + 2)}\nreturn timingInstruction`,
    )((s: string) => `'${s}'`, "/h/rec.ts", "/w/agent-timings.jsonl");

    const withPhase = fn("marcus", "Implement");
    expect(withPhase).toContain("start --label 'marcus' --artifact '/w/agent-timings.jsonl' --phase 'Implement'");
    expect(withPhase).toContain("end --label 'marcus' --artifact '/w/agent-timings.jsonl' --phase 'Implement'");

    // `queued` carries no phase: it is folded into an already-open bracket
    // that has one, so a second copy would be a second place the phase could
    // be wrong.
    expect(withPhase).toMatch(/queued --label 'marcus' --artifact '\/w\/agent-timings\.jsonl' --waited-ms/);

    // Absent rather than defaulted. 'unknown' would become a phase in the
    // timeline, sitting beside the real ones and spanning whatever those calls
    // covered.
    for (const missing of [undefined, "", null]) {
      expect(fn("collect", missing as any)).not.toContain("--phase");
    }
  });

  test("SC-1747: the artifact the viewer reads is the artifact ship.js writes", () => {
    // One name, asserted from both ends. Two constants that agree today is the
    // fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` waiting
    // to happen — a viewer pointed at a file nothing writes renders a
    // perfectly formatted UNMEASURED forever.
    const shipSource = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
    expect(shipSource).toContain("const TIMING_ARTIFACT = `${WORK_DIR}/agent-timings.jsonl`");
    expect(TRAJECTORY_FILENAME).toBe("agent-timings.jsonl");
    expect(trajectoryFor("/w/workflow-state.json")).toBe("/w/agent-timings.jsonl");

    // And a bracket the real recorder writes is read by the real reader, over
    // one file, so the two sides are joined by an execution rather than by two
    // string literals that happen to match.
    recordEvent(ARTIFACT, "setup", "start", 1000, undefined, "Discovery");
    expect(readTrajectory(ARTIFACT).records).toEqual([
      { kind: "agent", label: "setup", event: "start", at: 1000, phase: "Discovery" },
    ]);
  });
});
