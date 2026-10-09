#!/usr/bin/env bun
/**
 * Record a start or an end timestamp for one agent call site (#227).
 *
 * WHY A SCRIPT. A workflow script cannot do this itself. The Workflow sandbox
 * has no filesystem and no module loading (#69), and `Date.now()` /
 * argless `new Date()` throw inside it — they would break resume. So the only
 * clock and the only writer a ship run can reach is a shell inside an agent,
 * and the only way to attach one to every call site is to put the command in
 * the prompt. `timedAgent` in workflows/ship.js is the single place that
 * happens; this is what it calls.
 *
 * WHAT IT REPLACES. The grade step read birth and modification times off the
 * `agent-*.jsonl` transcript files with `stat -f '%B' || stat -c '%W'`. That
 * could not be attributed to a call site — a transcript is named after the
 * agent id, so `quinn-local-1` and `quinn-local-2` were indistinguishable —
 * and it could not fail: both `stat` forms are `2>/dev/null`-chained, so on a
 * filesystem with no birth time the loop printed nothing and the step
 * reported `"timing": []`. A measurement that answers "no data" and "this
 * platform cannot measure" with the same value is the shape
 * .claude/rules/checks-must-be-able-to-fail.md is about.
 *
 * WHY IT APPENDS RATHER THAN ASSIGNS. Keyed by label and assigning, a retry —
 * `marcus-fix-1` running twice, a gate heal loop re-entering — would silently
 * replace the first attempt's record. That looks correct on every run that
 * never retried and loses exactly the runs the timings are wanted for. Every
 * `--start` appends; every `--end` closes the most recent still-open record
 * for that label, and an `--end` with nothing open is kept as its own orphan
 * record rather than written onto a closed one.
 *
 * WHY A MISSING STAMP STAYS VISIBLE. The stamps are commands in an agent's
 * prompt, so an agent can fail to run them. A record whose `endedAt` is null
 * is reported as `UNCLOSED` rather than omitted, and an empty artifact
 * reports `NO RECORDS`. Neither is allowed to read as "that agent took no
 * time".
 *
 * Usage:
 *   bun scripts/record-agent-timings.ts --work-dir <dir> --label <label> --start
 *   bun scripts/record-agent-timings.ts --work-dir <dir> --label <label> --end
 *   bun scripts/record-agent-timings.ts --file <artifact.json> --report
 *
 * --at <ISO-8601> overrides the clock (tests, and replaying a known time).
 * --file names the artifact directly; --work-dir derives it as
 * <work-dir>/agent-timings.json.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

/**
 * The one exit code every refusal goes through.
 *
 * Declared once and used once, so test/record-agent-timings.test.ts can build
 * a copy of this file with it set to 0 and prove each refusal is this script
 * saying no rather than something else failing by coincidence
 * (.claude/rules/checks-must-be-able-to-fail.md). No relative import appears
 * anywhere in this file, so the mutant runs from a temp directory.
 */
export const REFUSE_EXIT = 1;

/** The artifact's filename, under the run's WORK_DIR. */
export const TIMING_FILENAME = "agent-timings.json";

export interface TimingRecord {
  label: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface TimingDoc {
  version: number;
  records: TimingRecord[];
}

export function timingArtifactPath(workDir: string): string {
  return join(workDir, TIMING_FILENAME);
}

export function emptyDoc(): TimingDoc {
  return { version: 1, records: [] };
}

/** A label has to survive being read back out of JSON and printed in a report. */
export function isUsableLabel(label: unknown): label is string {
  return typeof label === "string" && label.length > 0 && !/[\n\r\u0000]/.test(label);
}

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function durationBetween(startedAt: string, endedAt: string): number {
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number((ms / 1000).toFixed(3));
}

/**
 * Open a new record. Always appends — see "WHY IT APPENDS" above.
 */
export function applyStart(doc: TimingDoc, label: string, at: string): TimingDoc {
  return {
    ...doc,
    records: [...doc.records, { label, startedAt: at, endedAt: null, durationSeconds: null }],
  };
}

/**
 * Close the most recent still-open record for this label.
 *
 * Most recent, not first: a re-entrant call site closes inner-before-outer,
 * and `parallel()` can have two labels open at once.
 */
export function applyEnd(doc: TimingDoc, label: string, at: string): TimingDoc {
  const records = doc.records.map(r => ({ ...r }));
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.label !== label || r.endedAt !== null) continue;
    r.endedAt = at;
    r.durationSeconds = r.startedAt ? durationBetween(r.startedAt, at) : null;
    return { ...doc, records };
  }
  // No open record. Keeping the orphan is the point: overwriting a closed
  // record would lose a measured attempt, and dropping it would hide a
  // double-stamp.
  records.push({ label, startedAt: null, endedAt: at, durationSeconds: null });
  return { ...doc, records };
}

export function formatReport(doc: TimingDoc): string {
  if (!doc.records.length) return "NO RECORDS — no agent call site stamped a timing for this run";
  return doc.records
    .map(r => {
      if (r.endedAt === null) return `${r.label}: UNCLOSED (started ${r.startedAt ?? "never"})`;
      if (r.startedAt === null) return `${r.label}: UNSTARTED (ended ${r.endedAt})`;
      return `${r.label}: ${r.durationSeconds} seconds`;
    })
    .join("\n");
}

export function parseDoc(raw: string): TimingDoc {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
    throw new Error("artifact has no records array");
  }
  return { version: typeof parsed.version === "number" ? parsed.version : 1, records: parsed.records };
}

export function readDoc(file: string): TimingDoc {
  if (!existsSync(file)) return emptyDoc();
  return parseDoc(readFileSync(file, "utf-8"));
}

/**
 * Serialise through a temp file and rename.
 *
 * Agents run concurrently, so two stamps can land at once. The lock makes the
 * read-modify-write a unit; the rename makes a reader never see half a file.
 * `mkdir` is the lock because it is atomic on every filesystem this runs on.
 */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Ten seconds of contention means the holder died. Taking the lock is
        // better than refusing a stamp that would otherwise be lost.
        try {
          rmdirSync(lock);
        } catch {
          /* another process beat us to the cleanup */
        }
        continue;
      }
      Bun.sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function writeDoc(file: string, doc: TimingDoc): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, file);
}

export function recordTiming(opts: {
  file: string;
  label: string;
  edge: "start" | "end";
  at: string;
}): TimingDoc {
  const dir = dirname(opts.file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withLock(opts.file, () => {
    const doc = readDoc(opts.file);
    const next = opts.edge === "start"
      ? applyStart(doc, opts.label, opts.at)
      : applyEnd(doc, opts.label, opts.at);
    writeDoc(opts.file, next);
    return next;
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────

function refuse(message: string): never {
  console.error(`record-agent-timings: ${message}`);
  process.exit(REFUSE_EXIT);
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

export function main(argv: string[]): void {
  const file = flagValue(argv, "--file");
  const workDir = flagValue(argv, "--work-dir");
  if (!file && !workDir) refuse("one of --file or --work-dir is required");
  const artifact = file ?? timingArtifactPath(workDir as string);

  if (argv.includes("--report")) {
    let doc: TimingDoc;
    try {
      doc = readDoc(artifact);
    } catch (err) {
      refuse(`${artifact} is not a readable timing artifact: ${(err as Error).message}`);
    }
    console.log(formatReport(doc!));
    return;
  }

  const label = flagValue(argv, "--label");
  if (!isUsableLabel(label)) {
    refuse("--label is required and must be a non-empty single-line value — " +
      "every agent call site must be labelled (#227)");
  }

  const wantsStart = argv.includes("--start");
  const wantsEnd = argv.includes("--end");
  if (wantsStart === wantsEnd) refuse("exactly one of --start or --end is required");

  const at = flagValue(argv, "--at") ?? new Date().toISOString();
  if (!isIsoTimestamp(at)) refuse(`--at must be an ISO-8601 timestamp, got ${JSON.stringify(at)}`);

  try {
    recordTiming({ file: artifact, label, edge: wantsStart ? "start" : "end", at });
  } catch (err) {
    refuse(`could not record into ${artifact}: ${(err as Error).message}`);
  }
  console.log(`${label}: ${wantsStart ? "started" : "ended"} ${at}`);
}

if (import.meta.main) main(process.argv.slice(2));
