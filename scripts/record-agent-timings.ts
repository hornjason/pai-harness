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

export type TimingEvent = "start" | "end";

export interface TimingRecord {
  label: string;
  event: TimingEvent;
  at: number;
}

export interface TimingEntry {
  /** The call site's label, as ship.js passed it to the agent. */
  agent: string;
  /** Wall-clock seconds, or null when the bracket is incomplete. */
  seconds: number | null;
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
): TimingRecord {
  const record: TimingRecord = { label, event, at };
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
  const { label, event, at } = value as Record<string, unknown>;
  if (typeof label !== "string" || label.length === 0) return null;
  if (event !== "start" && event !== "end") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
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
 */
export function summarize(records: TimingRecord[]): TimingEntry[] {
  const entries: TimingEntry[] = [];
  const open = new Map<string, number[]>();

  for (const record of records) {
    if (record.event === "start") {
      const index = entries.length;
      entries.push({
        agent: record.label,
        seconds: null,
        startedAt: record.at,
        endedAt: null,
        unterminated: true, // fail-closed: only an observed end clears this
        orphanEnd: false,
      });
      const queue = open.get(record.label);
      if (queue) queue.push(index);
      else open.set(record.label, [index]);
      continue;
    }

    const index = open.get(record.label)?.shift();
    if (index === undefined) {
      entries.push({
        agent: record.label,
        seconds: null,
        startedAt: null,
        endedAt: record.at,
        unterminated: false,
        orphanEnd: true,
      });
      continue;
    }
    const entry = entries[index]!;
    entry.endedAt = record.at;
    entry.unterminated = false;
    entry.seconds = Math.round(((record.at - (entry.startedAt ?? record.at)) / 1000) * 1000) / 1000;
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
      if (entry.orphanEnd) process.stdout.write(`${entry.agent}: END WITH NO START\n`);
      else if (entry.unterminated) process.stdout.write(`${entry.agent}: UNTERMINATED\n`);
      else process.stdout.write(`${entry.agent}: ${entry.seconds}s\n`);
    }
    for (const line of result.malformed) {
      process.stderr.write(`malformed timing line ignored: ${line}\n`);
    }
    return;
  }

  refuse(`unknown command ${command === undefined ? "(none given)" : `"${command}"`}`);
}

if (import.meta.main) main(process.argv.slice(2));
