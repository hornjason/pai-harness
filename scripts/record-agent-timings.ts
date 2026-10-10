#!/usr/bin/env bun
/**
 * The run's agent timing artifact: one JSONL file, one line per bracket event.
 *
 * WHY THIS EXISTS (#227)
 *
 * workflows/ship.js runs inside the Workflow sandbox, which has no filesystem
 * access and no `Date.now()` — both would break resume. The workflow therefore
 * cannot time its own agent calls: it can neither read a clock nor write a
 * file. The only participant able to do both is the agent being spawned, which
 * has Bash.
 *
 * So ship.js appends an instruction to every agent prompt telling it to run
 * `start` before the work and `end` after it, under that call site's label,
 * and this script is both halves of that bracket plus the reader that turns
 * the file back into durations.
 *
 * WHAT IT REPLACES
 *
 * The grade step used to derive durations from `stat` on agent-*.jsonl —
 * creation time to modification time of a transcript file. That is the file's
 * lifetime, not the call's: a transcript flushed once at the end reads as
 * zero, one touched later by the runtime reads as longer than the call, and
 * two call sites sharing a transcript are indistinguishable. The numbers were
 * printed every run and meant nothing.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * The bracket is written by a language model, so it is lossy: an agent that
 * dies, is skipped by the user, or ignores the instruction leaves a start with
 * no end. That case is REPORTED as `unterminated`, never dropped — a dropped
 * start is indistinguishable from a call that never happened, which is the
 * same failure the stat-based version had. Fail-closed is the rule here:
 * `unterminated` starts true and is cleared only by an observed end.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";

/**
 * The one exit code every usage refusal goes through.
 *
 * Declared once, on one line, so a refusal cannot bypass it by inlining
 * `process.exit(2)` — see .claude/rules/checks-must-be-able-to-fail.md.
 */
export const TIMING_USAGE_EXIT = 2;

/**
 * `queued` is the third kind (#239): an interval the call spent WAITING on a
 * machine-wide resource rather than working.
 *
 * It carries its own duration instead of being a second bracket. The agent
 * only knows how long it waited after the wait is over — it is told the number
 * by the thing that made it wait, or it measures its own sleep — so a
 * `queued-start` it was supposed to have written beforehand would be the one
 * event it could never get right.
 */
export type TimingEvent = "start" | "end" | "queued";

export interface TimingRecord {
  label: string;
  event: TimingEvent;
  at: number;
  /** Milliseconds waited. Required for `queued`, absent otherwise. */
  waitedMs?: number;
}

export interface TimingEntry {
  /** The call site's label, as ship.js passed it to the agent. */
  agent: string;
  /** Wall-clock seconds, or null when the bracket is incomplete. */
  seconds: number | null;
  /**
   * Seconds of the above spent waiting on a shared resource (#239). Zero when
   * the call never waited — which is known, not unknown. Null only when there
   * is no bracket at all to attribute the wait to.
   */
  queuedSeconds: number | null;
  /**
   * `seconds` minus `queuedSeconds` — the part of the call that was work.
   *
   * Not clamped. It can only go negative when the agent reports a wait longer
   * than its own bracket, and that contradiction is worth seeing: clamped to
   * zero it would read as an ordinary very fast call.
   */
  workSeconds: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** A start that was never closed. Default true; only an end clears it. */
  unterminated: boolean;
  /** An end with no start — the artifact saw half a bracket from the far side. */
  orphanEnd: boolean;
}

export interface TimingRead {
  records: TimingRecord[];
  /** Lines that did not parse as a timing record, verbatim. Never discarded. */
  malformed: string[];
  /** The artifact does not exist. Distinct from "it exists and is empty". */
  missing: boolean;
}

/** Append one bracket event. Creates the artifact's directory if needed. */
export function recordEvent(
  artifact: string,
  label: string,
  event: TimingEvent,
  at: number = Date.now(),
  waitedMs?: number,
): TimingRecord {
  const record: TimingRecord = {
    label,
    event,
    at,
    ...(waitedMs === undefined ? {} : { waitedMs }),
  };
  mkdirSync(dirname(artifact), { recursive: true });
  // One short line per append: a single write(2) under the pipe-buffer size,
  // which is what keeps concurrent agents from interleaving mid-line.
  appendFileSync(artifact, `${JSON.stringify(record)}\n`);
  return record;
}

function parseRecord(line: string): TimingRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { label, event, at, waitedMs } = value as Record<string, unknown>;
  if (typeof label !== "string" || label.length === 0) return null;
  if (event !== "start" && event !== "end" && event !== "queued") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (event === "queued") {
    // A queued record with no readable duration is MALFORMED, never a zero
    // wait: reading it as zero would make the one record whose entire job is
    // to say "this call waited" report that it did not (#239).
    if (typeof waitedMs !== "number" || !Number.isFinite(waitedMs) || waitedMs < 0) {
      return null;
    }
    return { label, event, at, waitedMs };
  }
  return { label, event, at };
}

export function readTimings(artifact: string): TimingRead {
  if (!existsSync(artifact)) return { records: [], malformed: [], missing: true };

  const records: TimingRecord[] = [];
  const malformed: string[] = [];
  for (const line of readFileSync(artifact, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record) records.push(record);
    else malformed.push(line);
  }
  return { records, malformed, missing: false };
}

/**
 * Pair starts with ends, in file order, per label.
 *
 * Per label rather than globally because parallel agents append to one
 * artifact, so the nearest `end` in the file usually belongs to someone else.
 * FIFO within a label because a label can legitimately repeat — a remediation
 * round reuses `collect-worktrees` — and collapsing the repeats would report
 * one round and hide the other.
 *
 * A `queued` record is folded into the OPEN entry for its label rather than
 * opening one of its own: the wait happened inside the bracket, which is why
 * it has to be subtracted from it. Same per-label rule, and for the same
 * reason — with parallel agents writing one artifact, the nearest open
 * bracket in file order usually belongs to somebody else (#239).
 */
export function summarize(records: TimingRecord[]): TimingEntry[] {
  const entries: TimingEntry[] = [];
  const open = new Map<string, number[]>();

  const blank = (label: string): TimingEntry => ({
    agent: label,
    seconds: null,
    queuedSeconds: null,
    workSeconds: null,
    startedAt: null,
    endedAt: null,
    unterminated: false,
    orphanEnd: false,
  });

  for (const record of records) {
    if (record.event === "start") {
      const index = entries.length;
      entries.push({
        ...blank(record.label),
        startedAt: record.at,
        // A bracket that opened has, so far, waited for nothing. Zero rather
        // than null: "it did not wait" is a measurement, "unknown" is not.
        queuedSeconds: 0,
        unterminated: true, // fail-closed: only an observed end clears this
      });
      const queue = open.get(record.label);
      if (queue) queue.push(index);
      else open.set(record.label, [index]);
      continue;
    }

    if (record.event === "queued") {
      // Peeked, not shifted: the bracket is still open, and consuming it here
      // would leave the real `end` looking like an orphan.
      const openIndex = open.get(record.label)?.[0];
      const waited = Math.round((record.waitedMs ?? 0) / 1000 * 1000) / 1000;
      if (openIndex === undefined) {
        // No bracket to attribute it to. Surfaced anyway — a dropped record is
        // indistinguishable from a wait that never happened, which is the
        // defect #227 exists to rule out.
        entries.push({ ...blank(record.label), queuedSeconds: waited });
        continue;
      }
      const target = entries[openIndex]!;
      // Several refusals mean several waits; keeping only the last would
      // report less waiting than happened.
      target.queuedSeconds = (target.queuedSeconds ?? 0) + waited;
      continue;
    }

    const index = open.get(record.label)?.shift();
    if (index === undefined) {
      entries.push({
        ...blank(record.label),
        endedAt: record.at,
        orphanEnd: true,
      });
      continue;
    }
    const entry = entries[index]!;
    entry.endedAt = record.at;
    entry.unterminated = false;
    entry.seconds = Math.round(((record.at - (entry.startedAt ?? record.at)) / 1000) * 1000) / 1000;
    entry.workSeconds =
      Math.round((entry.seconds - (entry.queuedSeconds ?? 0)) * 1000) / 1000;
  }

  return entries;
}

export interface TimingReport extends TimingRead {
  timing: TimingEntry[];
  /** Labels that opened and never closed — named, so they can be chased. */
  unterminated: string[];
}

export function report(artifact: string): TimingReport {
  const read = readTimings(artifact);
  const timing = summarize(read.records);
  return {
    ...read,
    timing,
    unterminated: timing.filter((e) => e.unterminated).map((e) => e.agent),
  };
}

// ── CLI ──────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at === -1 || at === argv.length - 1) return undefined;
  return argv[at + 1];
}

function refuse(message: string): never {
  process.stderr.write(`record-agent-timings: ${message}\n`);
  process.stderr.write(
    "usage: record-agent-timings.ts <start|end> --label <label> --artifact <path>\n" +
      "       record-agent-timings.ts queued --label <label> --waited-ms <ms> --artifact <path>\n" +
      "       record-agent-timings.ts report --artifact <path> [--json]\n",
  );
  process.exit(TIMING_USAGE_EXIT);
}

export function main(argv: string[]): void {
  const command = argv[0];
  const artifact = flag(argv, "artifact");
  if (!artifact) refuse("--artifact <path> is required");

  if (command === "start" || command === "end") {
    const label = flag(argv, "label");
    if (!label) refuse("--label <label> is required — an unnamed bracket cannot be matched");
    const written = recordEvent(artifact, label, command);
    process.stdout.write(`${JSON.stringify(written)}\n`);
    return;
  }

  if (command === "queued") {
    const label = flag(argv, "label");
    if (!label) refuse("--label <label> is required — an unnamed wait cannot be attributed");
    const raw = flag(argv, "waited-ms");
    if (raw === undefined) {
      refuse("--waited-ms <ms> is required — a wait with no duration is not a measurement");
    }
    // Refused rather than defaulted. Writing an unreadable duration as zero
    // would record "this call waited for nothing", which is worse than no
    // record at all: it looks like evidence that the wait did not happen.
    const waitedMs = Number(raw);
    if (!Number.isFinite(waitedMs) || waitedMs < 0) {
      refuse(`--waited-ms must be a non-negative number of milliseconds, got "${raw}"`);
    }
    const written = recordEvent(artifact, label, "queued", Date.now(), waitedMs);
    process.stdout.write(`${JSON.stringify(written)}\n`);
    return;
  }

  if (command === "report") {
    const result = report(artifact);
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (result.missing) {
      process.stdout.write(`no timing artifact at ${artifact} — no agent recorded a bracket\n`);
      return;
    }
    for (const entry of result.timing) {
      // The wait is printed beside the total rather than folded into it: a
      // call that spent 22 of its 30 minutes asleep on a rate budget reads as
      // a slow agent if the only number shown is the wall clock (#239).
      const waited = entry.queuedSeconds
        ? ` (queued ${entry.queuedSeconds}s, work ${entry.workSeconds ?? "?"}s)`
        : "";
      if (entry.orphanEnd) process.stdout.write(`${entry.agent}: END WITH NO START\n`);
      else if (entry.unterminated) {
        process.stdout.write(`${entry.agent}: UNTERMINATED${waited}\n`);
      } else if (entry.seconds === null) {
        process.stdout.write(`${entry.agent}: QUEUED ONLY${waited}\n`);
      } else process.stdout.write(`${entry.agent}: ${entry.seconds}s${waited}\n`);
    }
    for (const line of result.malformed) {
      process.stderr.write(`malformed timing line ignored: ${line}\n`);
    }
    return;
  }

  refuse(`unknown command ${command === undefined ? "(none given)" : `"${command}"`}`);
}

if (import.meta.main) main(process.argv.slice(2));
