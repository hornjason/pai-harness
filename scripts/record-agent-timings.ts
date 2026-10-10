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
 * The four bracket events, in two pairs (#239).
 *
 * `queued-start` / `queued-end` bracket time the agent spent WAITING rather
 * than working — specifically, waiting on the DIR-L29 full-suite budget, which
 * on run wf_18abb197-f03 cost one sub-agent ~22 minutes of `sleep 580` while
 * its siblings had already finished. Charged to the work bracket, that time is
 * indistinguishable from slow work, and the one number that would have named
 * the defect is the one number the artifact did not have.
 */
export type TimingEvent = "start" | "end" | "queued-start" | "queued-end";

/** Which clock an entry is on: doing the task, or waiting for permission to. */
export type TimingKind = "work" | "queued";

export interface TimingRecord {
  label: string;
  event: TimingEvent;
  at: number;
}

export interface TimingEntry {
  /** The call site's label, as ship.js passed it to the agent. */
  agent: string;
  /**
   * Work, or waiting. Reported separately for the same label rather than
   * summed, because the two have different causes and different fixes.
   */
  kind: TimingKind;
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

/**
 * The one place an event name is decoded, so the reader, the writer and the
 * CLI cannot disagree about what counts as an event.
 */
const EVENTS: Record<TimingEvent, { kind: TimingKind; opens: boolean }> = {
  start: { kind: "work", opens: true },
  end: { kind: "work", opens: false },
  "queued-start": { kind: "queued", opens: true },
  "queued-end": { kind: "queued", opens: false },
};

export function isTimingEvent(value: unknown): value is TimingEvent {
  return typeof value === "string" && Object.hasOwn(EVENTS, value);
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
  if (!isTimingEvent(event)) return null;
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
 * Pair starts with ends, in file order, per label AND per kind.
 *
 * Per label rather than globally because parallel agents append to one
 * artifact, so the nearest `end` in the file usually belongs to someone else.
 * FIFO within a label because a label can legitimately repeat — a remediation
 * round reuses `collect-worktrees` — and collapsing the repeats would report
 * one round and hide the other.
 *
 * Per KIND as well, because a queued interval nests inside the work bracket it
 * delays (#239): the agent writes `start`, is refused the full suite, brackets
 * its wait, then finishes and writes `end`. Pairing on the label alone would
 * close the work bracket with the queued end and report a call that took as
 * long as its own wait.
 */
export function summarize(records: TimingRecord[]): TimingEntry[] {
  const entries: TimingEntry[] = [];
  const open = new Map<string, number[]>();
  const pairKey = (label: string, kind: TimingKind) => `${kind}\u0000${label}`;

  for (const record of records) {
    const { kind, opens } = EVENTS[record.event];
    const key = pairKey(record.label, kind);

    if (opens) {
      const index = entries.length;
      entries.push({
        agent: record.label,
        kind,
        seconds: null,
        startedAt: record.at,
        endedAt: null,
        unterminated: true, // fail-closed: only an observed end clears this
        orphanEnd: false,
      });
      const queue = open.get(key);
      if (queue) queue.push(index);
      else open.set(key, [index]);
      continue;
    }

    const index = open.get(key)?.shift();
    if (index === undefined) {
      entries.push({
        agent: record.label,
        kind,
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
  /**
   * Seconds each label spent waiting rather than working (#239), summed over
   * its closed queued intervals. Reported next to the work entries, never
   * folded into them: a call that waited 22 minutes for a budget window and a
   * call that took 22 minutes to do its job need different fixes, and the
   * artifact's whole purpose is to tell them apart.
   */
  queuedSeconds: Record<string, number>;
}

export function report(artifact: string): TimingReport {
  const read = readTimings(artifact);
  const timing = summarize(read.records);
  const queuedSeconds: Record<string, number> = {};
  for (const entry of timing) {
    if (entry.kind !== "queued" || typeof entry.seconds !== "number") continue;
    queuedSeconds[entry.agent] = (queuedSeconds[entry.agent] ?? 0) + entry.seconds;
  }
  return {
    ...read,
    timing,
    unterminated: timing
      .filter((e) => e.unterminated)
      // A wait the agent opened and never closed is still a wait, and saying
      // which kind it was is the difference between "the agent died" and "the
      // agent is still queued".
      .map((e) => (e.kind === "queued" ? `${e.agent} (queued)` : e.agent)),
    queuedSeconds,
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
      "       record-agent-timings.ts <queued-start|queued-end> --label <label> --artifact <path>\n" +
      "       record-agent-timings.ts report --artifact <path> [--json]\n",
  );
  process.exit(TIMING_USAGE_EXIT);
}

export function main(argv: string[]): void {
  const command = argv[0];
  const artifact = flag(argv, "artifact");
  if (!artifact) refuse("--artifact <path> is required");

  if (isTimingEvent(command)) {
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
      // QUEUED is printed on its own line rather than added to the work line:
      // the two numbers have different causes, and a single total hides the
      // one that names a harness defect (#239).
      const what = entry.kind === "queued" ? `${entry.agent}: QUEUED` : `${entry.agent}:`;
      if (entry.orphanEnd) process.stdout.write(`${what} END WITH NO START\n`);
      else if (entry.unterminated) process.stdout.write(`${what} UNTERMINATED\n`);
      else process.stdout.write(`${what} ${entry.seconds}s\n`);
    }
    for (const line of result.malformed) {
      process.stderr.write(`malformed timing line ignored: ${line}\n`);
    }
    return;
  }

  refuse(`unknown command ${command === undefined ? "(none given)" : `"${command}"`}`);
}

if (import.meta.main) main(process.argv.slice(2));
