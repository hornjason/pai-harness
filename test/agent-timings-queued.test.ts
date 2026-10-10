/**
 * Queued time is not work time (#239).
 *
 * On run wf_18abb197-f03 sub-agent 235002 took 22 of its ~30 minutes sleeping
 * in `sleep 580` loops, waiting for a full-suite rate budget its two siblings
 * had already spent. The bracket from #227 measured that call at its wall
 * clock and reported it as a slow agent. Nothing in the artifact said the
 * agent had been asleep, so the one number the run printed about that call was
 * actively misleading: it looked like Marcus taking half an hour to think.
 *
 * #239 fixes the budget key so the wait should not happen. This file is the
 * other half — when a worker DOES wait on a machine-wide resource, the wait is
 * recorded as its own interval against the same label, and the summarizer
 * reports it separately from the work. A fix that silently removes a symptom
 * leaves nothing to notice when it comes back.
 *
 * What was broken to prove these can fail, run and counted rather than
 * asserted, over this file + test/agent-timings.test.ts (44 tests):
 *
 *   | Mutation                                            | Red |
 *   |-----------------------------------------------------|-----|
 *   | parseRecord stops validating `waitedMs`              | 1   |
 *   | a wait attaches to the newest entry, not its label's | 1   |
 *   | `workSeconds` set to the wall clock                  | 5   |
 *
 * None is left in the tree; all were run and reverted. The second one is the
 * reason this file is worth more than its first draft: it SURVIVED, because
 * the pairing fixture put the wait right after its own bracket's start, where
 * "the newest entry" and "the newest entry for this label" are the same
 * entry. The fixture now writes A's wait after B's start, so the two answers
 * differ and the test can tell them apart. An assertion that holds vacuously
 * is the third shape .claude/rules/checks-must-be-able-to-fail.md names, and
 * it was in here until the mutation was actually run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TIMING_USAGE_EXIT,
  readTimings,
  recordEvent,
  report,
  summarize,
} from "../scripts/record-agent-timings.ts";

// SPEC-REF: HARNESS-STANDARD.md § Waiting is not working (#239) — SC-628, SC-629, SC-630

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-agent-timings.ts");

const temps: string[] = [];
function tempArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-queued-"));
  temps.push(dir);
  return join(dir, "agent-timings.jsonl");
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

// ── AC-4: queued seconds are reported separately from work seconds ──

describe("AC-4: a wait is recorded against the label that waited", () => {
  test("queued seconds are reported separately from work seconds", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "start", 1_000);
    recordEvent(artifact, "marcus", "queued", 2_000, 1_320_000); // 22 minutes
    recordEvent(artifact, "marcus", "end", 1_800_000);

    const entries = summarize(readTimings(artifact).records);
    expect(entries).toHaveLength(1);

    const marcus = entries[0]!;
    // Wall clock is unchanged — the bracket still measures what it measured.
    expect(marcus.seconds).toBe(1799);
    // ...and the part of it the agent spent asleep is now visible.
    expect(marcus.queuedSeconds).toBe(1320);
    // Work is the difference, which is the number the run actually wanted.
    expect(marcus.workSeconds).toBe(479);
  });

  test("a call that never waited reports zero queued seconds, not null", () => {
    // Null would be "we do not know", and for a closed bracket with no queued
    // record we do know: it did not wait. The distinction matters because the
    // reporter prints the wait only when there was one.
    const entries = summarize([
      { label: "rook", event: "start", at: 0 },
      { label: "rook", event: "end", at: 2_000 },
    ]);
    expect(entries[0]!.queuedSeconds).toBe(0);
    expect(entries[0]!.workSeconds).toBe(2);
  });

  test("several waits in one call add up", () => {
    // A worker refused twice waits twice. Keeping only the last would report
    // less waiting than happened, which is the direction that hides the bug.
    const entries = summarize([
      { label: "quinn", event: "start", at: 0 },
      { label: "quinn", event: "queued", at: 1_000, waitedMs: 5_000 },
      { label: "quinn", event: "queued", at: 9_000, waitedMs: 3_000 },
      { label: "quinn", event: "end", at: 20_000 },
    ]);
    expect(entries[0]!.queuedSeconds).toBe(8);
    expect(entries[0]!.workSeconds).toBe(12);
  });

  test("queued time pairs with its own label, not the nearest bracket", () => {
    // Parallel agents append to ONE artifact, so the record next to yours in
    // file order usually belongs to somebody else. The wait below is A's, and
    // it is deliberately written AFTER B's start: the newest entry at that
    // moment is B's, so a summarizer that attaches a wait to "the last
    // bracket" rather than "the last bracket for this label" charges B.
    const entries = summarize([
      { label: "a", event: "start", at: 0 },
      { label: "b", event: "start", at: 100 },
      { label: "a", event: "queued", at: 200, waitedMs: 4_000 },
      { label: "b", event: "end", at: 10_000 },
      { label: "a", event: "end", at: 20_000 },
    ]);
    const byLabel = Object.fromEntries(
      entries.map((e) => [e.agent, [e.queuedSeconds, e.workSeconds]]),
    );
    expect(byLabel).toEqual({ a: [4, 16], b: [0, 9.9] });
  });

  test("a wait recorded with no bracket open is surfaced, not discarded", () => {
    // Same rule as an orphan end: a dropped record is indistinguishable from a
    // wait that never happened, which is the defect #227 exists to rule out.
    const entries = summarize([{ label: "ghost", event: "queued", at: 10, waitedMs: 7_000 }]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent).toBe("ghost");
    expect(entries[0]!.queuedSeconds).toBe(7);
    expect(entries[0]!.seconds).toBeNull();
    expect(entries[0]!.workSeconds).toBeNull();
    expect(entries[0]!.unterminated).toBe(false);
    expect(entries[0]!.orphanEnd).toBe(false);
  });

  test("an unterminated call still reports the wait it already recorded", () => {
    // The agent that dies mid-wait is exactly the case worth seeing.
    const entries = summarize([
      { label: "marcus", event: "start", at: 0 },
      { label: "marcus", event: "queued", at: 10, waitedMs: 600_000 },
    ]);
    expect(entries[0]!.unterminated).toBe(true);
    expect(entries[0]!.seconds).toBeNull();
    expect(entries[0]!.queuedSeconds).toBe(600);
    expect(entries[0]!.workSeconds).toBeNull();
  });

  test("a wait longer than its own bracket is reported, not clamped away", () => {
    // Only reachable when the agent mis-measures its own wait. A clamp to zero
    // would make a contradiction look like a normal fast call; a negative work
    // time says plainly that the two numbers disagree.
    const entries = summarize([
      { label: "odd", event: "start", at: 0 },
      { label: "odd", event: "queued", at: 1, waitedMs: 10_000 },
      { label: "odd", event: "end", at: 4_000 },
    ]);
    expect(entries[0]!.workSeconds).toBe(-6);
  });

  test("a queued record with no duration is malformed, not a zero wait", () => {
    // Reading it as zero is the fail-open: the one record that exists to say
    // "this call waited" would report that it did not.
    const artifact = tempArtifact();
    writeFileSync(
      artifact,
      [
        JSON.stringify({ label: "a", event: "queued", at: 1 }),
        JSON.stringify({ label: "a", event: "queued", at: 2, waitedMs: "600" }),
        JSON.stringify({ label: "a", event: "queued", at: 3, waitedMs: -5 }),
        JSON.stringify({ label: "a", event: "queued", at: 4, waitedMs: 600 }),
      ].join("\n") + "\n",
    );

    const { records, malformed } = readTimings(artifact);
    expect(records).toHaveLength(1);
    expect(malformed).toHaveLength(3);
  });
});

// ── AC-4: the CLI the agent is told to run ──

describe("AC-4: the queued command", () => {
  function run(args: string[]) {
    const p = Bun.spawnSync(["bun", SCRIPT, ...args]);
    return {
      code: p.exitCode,
      stdout: new TextDecoder().decode(p.stdout),
      stderr: new TextDecoder().decode(p.stderr),
    };
  }

  test("start / queued / end round-trips through the real commands", () => {
    const artifact = tempArtifact();
    expect(run(["start", "--label", "marcus", "--artifact", artifact]).code).toBe(0);
    expect(
      run(["queued", "--label", "marcus", "--waited-ms", "1320000", "--artifact", artifact]).code,
    ).toBe(0);
    expect(run(["end", "--label", "marcus", "--artifact", artifact]).code).toBe(0);

    const out = run(["report", "--artifact", artifact, "--json"]);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as {
      timing: Array<{ agent: string; queuedSeconds: number | null; workSeconds: number | null }>;
    };
    expect(parsed.timing).toHaveLength(1);
    expect(parsed.timing[0]!.queuedSeconds).toBe(1320);
    // The bracket is real wall clock here, so work is whatever is left after
    // the 1320s the test claimed — negative, and reported as such.
    expect(typeof parsed.timing[0]!.workSeconds).toBe("number");
  });

  test("queued without a duration is refused, not written as zero", () => {
    const artifact = tempArtifact();
    const refused = run(["queued", "--label", "marcus", "--artifact", artifact]);
    expect(refused.code).toBe(TIMING_USAGE_EXIT);
    expect(refused.stderr).toContain("--waited-ms");
    // Nothing was appended — a refused command must not leave half a record.
    expect(report(artifact).missing).toBe(true);
  });

  test("a non-numeric duration is refused", () => {
    const artifact = tempArtifact();
    for (const bad of ["soon", "-1", "NaN", "Infinity"]) {
      const refused = run([
        "queued", "--label", "m", "--waited-ms", bad, "--artifact", artifact,
      ]);
      expect(refused.code, `--waited-ms ${bad}`).toBe(TIMING_USAGE_EXIT);
    }
  });

  test("the text report names the wait rather than folding it into the total", () => {
    const artifact = tempArtifact();
    recordEvent(artifact, "marcus", "start", 1_000);
    recordEvent(artifact, "marcus", "queued", 2_000, 600_000);
    recordEvent(artifact, "marcus", "end", 901_000);

    const out = run(["report", "--artifact", artifact]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("900s");
    expect(out.stdout).toContain("queued 600s");
    expect(out.stdout).toContain("300s");
  });

  test("the usage text advertises the command, so it can be found", () => {
    const refused = run(["nonsense", "--artifact", tempArtifact()]);
    expect(refused.code).toBe(TIMING_USAGE_EXIT);
    expect(refused.stderr).toContain("queued");
  });
});

// ── AC-4: ship.js carries the field through to the reporter ──

describe("AC-4: queued time survives the trip to the run report", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the agent is told how to record a wait", () => {
    const from = shipSource.indexOf("// ──── AGENT-TIMING-START ────");
    const to = shipSource.indexOf("// ──── AGENT-TIMING-END ────");
    expect(from).toBeGreaterThan(-1);
    const block = shipSource.slice(from, to);
    expect(block).toContain("queued");
    expect(block).toContain("--waited-ms");
  });

  test("the grade schema carries queuedSeconds, or the reporter drops it", () => {
    // A field the schema does not declare is stripped at the tool boundary,
    // so the measurement would be taken, written, read — and then vanish one
    // step before anybody sees it.
    const schemaFrom = shipSource.indexOf("timing: { type: 'array'");
    expect(schemaFrom).toBeGreaterThan(-1);
    const schemaTo = shipSource.indexOf("}}", shipSource.indexOf("required:", schemaFrom));
    const timingSchema = shipSource.slice(schemaFrom, schemaTo);
    expect(timingSchema).toContain("queuedSeconds");
  });

  test("the grade prompt asks for it", () => {
    const at = shipSource.indexOf("label: 'grade'");
    const from = shipSource.lastIndexOf("timedAgent(`", at);
    const gradeStep = shipSource.slice(from, at);
    expect(gradeStep).toContain("queuedSeconds");
  });

  test("the TIMING log line prints the wait when there was one", () => {
    const at = shipSource.indexOf("TIMING: ${t.agent}");
    expect(at).toBeGreaterThan(-1);
    const block = shipSource.slice(at - 1_500, at + 1_500);
    expect(block).toContain("queuedSeconds");
  });
});
