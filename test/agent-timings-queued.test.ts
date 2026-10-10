/**
 * Queued time is reported, and reported separately (#239).
 *
 * Run wf_18abb197-f03 fanned out to three implementers. Two of them took the
 * session's two full-suite runs; the third spent roughly 22 minutes in
 * `sleep 580` loops waiting for the 30-minute window to age out, twenty of
 * those minutes after its siblings had finished. The run's timing artifact
 * recorded that agent as a single long call. Nothing in the numbers said the
 * time was spent asleep on a rate limit rather than working, so the defect was
 * invisible in exactly the artifact built to make call cost visible (#227).
 *
 * The fix to the budget key is in lib/test-suite-lock.ts. This file is the
 * other half: making the waiting MEASURABLE, so the next time a worker queues
 * behind a harness-imposed limit the run says so in seconds instead of looking
 * like a slow agent.
 *
 * Two properties are the point, and both are asserted by execution:
 *
 *  - A queued interval nests inside the work bracket it delays. Pairing on the
 *    label alone would close the work bracket with the queued end and report a
 *    call that lasted exactly as long as its own wait.
 *  - Queued seconds are reported BESIDE work seconds for the same label, never
 *    summed into them. A single total is the thing that hid this defect.
 *
 * SC-624.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TIMING_USAGE_EXIT,
  isTimingEvent,
  readTimings,
  recordEvent,
  report,
  summarize,
} from "../scripts/record-agent-timings.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-agent-timings.ts");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const temps: string[] = [];
function tempArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-queued-"));
  temps.push(dir);
  return join(dir, "nested", "agent-timings.jsonl");
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("AC-4: a wait is recorded as a queued interval, not as work", () => {
  test("queued-start / queued-end are admitted as events", () => {
    expect(isTimingEvent("queued-start")).toBe(true);
    expect(isTimingEvent("queued-end")).toBe(true);
    expect(isTimingEvent("start")).toBe(true);
    expect(isTimingEvent("end")).toBe(true);
    expect(isTimingEvent("sleep")).toBe(false);
    expect(isTimingEvent(undefined)).toBe(false);
  });

  test("a queued pair round-trips through the artifact as its own entry", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "queued-start", 1_000);
    recordEvent(artifact, "marcus", "queued-end", 1_320_000);

    const entries = summarize(readTimings(artifact).records);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("queued");
    expect(entries[0]!.seconds).toBe(1319);
    expect(entries[0]!.unterminated).toBe(false);
  });

  test("the summarizer reports queued seconds separately from work seconds for one label", () => {
    // The real shape: the agent opens its work bracket, is refused the full
    // suite, sleeps, is allowed, finishes. The wait nests inside the work.
    const entries = summarize([
      { label: "marcus", event: "start", at: 0 },
      { label: "marcus", event: "queued-start", at: 10_000 },
      { label: "marcus", event: "queued-end", at: 1_330_000 },
      { label: "marcus", event: "end", at: 1_800_000 },
    ]);

    const work = entries.filter((e) => e.kind === "work");
    const queued = entries.filter((e) => e.kind === "queued");
    expect(work).toHaveLength(1);
    expect(queued).toHaveLength(1);

    // 30 minutes of wall clock, 22 of them asleep on the budget. Pairing on
    // the label alone would have closed the work bracket at the queued end and
    // reported 1330s of work with no wait at all.
    expect(work[0]!.seconds).toBe(1800);
    expect(queued[0]!.seconds).toBe(1320);
    expect(work[0]!.agent).toBe(queued[0]!.agent);
  });

  test("queued seconds are never folded into the work number", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "quinn-local", "start", 0);
    recordEvent(artifact, "quinn-local", "queued-start", 1_000);
    recordEvent(artifact, "quinn-local", "queued-end", 61_000);
    recordEvent(artifact, "quinn-local", "end", 120_000);

    const r = report(artifact);
    expect(r.queuedSeconds).toEqual({ "quinn-local": 60 });
    const work = r.timing.find((e) => e.kind === "work")!;
    expect(work.seconds).toBe(120);
  });

  test("two waits by the same label are summed, not collapsed", () => {
    // An agent that polls a budget waits more than once. Reporting only the
    // last one would understate exactly the case this measures.
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "queued-start", 0);
    recordEvent(artifact, "marcus", "queued-end", 10_000);
    recordEvent(artifact, "marcus", "queued-start", 20_000);
    recordEvent(artifact, "marcus", "queued-end", 50_000);

    const r = report(artifact);
    expect(r.timing.map((e) => e.seconds)).toEqual([10, 30]);
    expect(r.queuedSeconds).toEqual({ marcus: 40 });
  });

  test("a wait that was never closed is unterminated, and says it was a wait", () => {
    // Fail-closed, like the work bracket: an agent still asleep when the run
    // ended must not read as a call that never queued.
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "queued-start", 5_000);

    const r = report(artifact);
    expect(r.timing[0]!.unterminated).toBe(true);
    expect(r.timing[0]!.kind).toBe("queued");
    expect(r.timing[0]!.seconds).toBeNull();
    expect(r.unterminated).toEqual(["marcus (queued)"]);
    // An unclosed wait contributes no seconds — inventing one is the defect
    // #227 removed.
    expect(r.queuedSeconds).toEqual({});
  });

  test("work entries keep their kind, so nothing reported before #239 changes meaning", () => {
    const entries = summarize([
      { label: "rook", event: "start", at: 0 },
      { label: "rook", event: "end", at: 2_000 },
    ]);
    expect(entries[0]!.kind).toBe("work");
    expect(entries[0]!.seconds).toBe(2);
  });
});

describe("AC-4: the CLI the agents are told to run", () => {
  function run(args: string[]) {
    const p = Bun.spawnSync(["bun", SCRIPT, ...args]);
    return {
      code: p.exitCode,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
    };
  }

  test("queued-start / queued-end round-trip through the real commands", () => {
    const artifact = tempArtifact();
    expect(run(["start", "--label", "marcus", "--artifact", artifact]).code).toBe(0);
    expect(run(["queued-start", "--label", "marcus", "--artifact", artifact]).code).toBe(0);
    expect(run(["queued-end", "--label", "marcus", "--artifact", artifact]).code).toBe(0);
    expect(run(["end", "--label", "marcus", "--artifact", artifact]).code).toBe(0);

    const out = run(["report", "--artifact", artifact, "--json"]);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      timing: Array<{ agent: string; kind: string; seconds: number }>;
      queuedSeconds: Record<string, number>;
    };
    expect(parsed.timing.map((e) => e.kind).sort()).toEqual(["queued", "work"]);
    expect(parsed.queuedSeconds.marcus).toBeGreaterThanOrEqual(0);
  });

  test("the human-readable report marks a wait as QUEUED", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "queued-start", 0);
    recordEvent(artifact, "marcus", "queued-end", 90_000);
    const out = run(["report", "--artifact", artifact]);
    expect(out.stdout).toContain("marcus: QUEUED 90s");
  });

  test("an unknown event is still a usage refusal", () => {
    // The event list widened; it did not become a free-for-all. A typo'd
    // `queued_start` must refuse rather than record a nameless kind.
    const out = run(["queued_start", "--label", "marcus", "--artifact", tempArtifact()]);
    expect(out.code).toBe(TIMING_USAGE_EXIT);
  });

  test("the usage text names the queued commands", () => {
    const out = run(["frobnicate", "--artifact", tempArtifact()]);
    expect(out.stderr).toContain("queued-start");
  });
});

describe("AC-4: ship.js carries the queued bracket through to the report", () => {
  test("every agent is told how to bracket a wait on the full-suite budget", () => {
    // The agent is the only participant that can observe its own wait — the
    // Workflow sandbox has no clock and no filesystem (#227) — so the
    // instruction has to be in the prompt or the measurement cannot exist.
    expect(shipSource).toContain("queued-start");
    expect(shipSource).toContain("queued-end");
  });

  test("the grade step's schema carries kind, so queued rows survive the reporter", () => {
    // A field the schema does not declare is dropped at the tool boundary, and
    // the queued row would arrive indistinguishable from work.
    const schemaStart = shipSource.indexOf("timing: { type: 'array'");
    expect(schemaStart).toBeGreaterThan(-1);
    const schema = shipSource.slice(schemaStart, schemaStart + 1200);
    expect(schema).toContain("kind");
  });

  test("the run log prints a queued row as a wait, not as work", () => {
    expect(shipSource).toContain("QUEUED");
  });
});
