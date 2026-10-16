/**
 * The run's trajectory: one JSONL artifact, one short line per event, read
 * back as an ordered timeline (#60).
 *
 * WHY THIS IS NOT A NEW ARTIFACT
 *
 * #60 asked for `{workDir}/trajectory.jsonl` holding agent calls, phases,
 * gates and state mutations, written by wrapping `agent()` and `phase()` in
 * `workflows/ship.js`. The workflow cannot do that: it runs in the Workflow
 * sandbox with no filesystem, no subprocess and no `Date.now()` (#69). Every
 * artifact it produces crosses that boundary through a script an agent is
 * instructed to run — which is exactly what `scripts/record-agent-timings.ts`
 * already is, and it already writes one short line per event to
 * `${WORK_DIR}/agent-timings.jsonl` (#227, #239).
 *
 * So the trajectory is that file, widened. A second JSONL beside it would be a
 * second source of truth for when an agent ran, and the two would disagree the
 * first time one of them lost a line.
 *
 * WHAT A LINE LOOKS LIKE
 *
 *   {"label":"discovery","event":"start","at":1,"phase":"Discovery"}
 *   {"type":"mutation","at":2,"fields":["acs","sizing"],"source":"scope-1"}
 *   {"type":"gate","at":3,"gate":"scope","result":"PASS","failures":[]}
 *
 * An agent bracket carries NO `type`, because thousands of them are already on
 * disk in in-flight runs and a reader that called those malformed would be
 * reporting a defect it had just introduced. `type` is absent ⇒ agent bracket;
 * present ⇒ one of the kinds below.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * Phase spans are DERIVED from the agent records that carry a phase, so a
 * phase's measured span is "from the first agent that reported in it to the
 * last". The gap between two phases — gate runs, sandbox logic, the workflow
 * thinking — is visible as a gap and is not attributed to either.
 *
 * **A phase with no agent records is not a zero-length phase, and this module
 * will not say that it is.** It is absent from `phaseSpans` entirely, and
 * `scripts/view-trajectory.ts` prints a line saying the timeline reports what
 * recorded rather than what ran. `0`, `{}` and silence are indistinguishable
 * from success; absence that announces itself is not
 * (`.claude/rules/config-access.md`, Silent Default Substitution).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

/** The artifact every run writes, named for what it has always been called. */
export const TRAJECTORY_FILENAME = "agent-timings.jsonl";

/** The artifact for a run whose state file is at `sf`. */
export function trajectoryFor(stateFile: string): string {
  return join(dirname(stateFile), TRAJECTORY_FILENAME);
}

export interface AgentRecord {
  kind: "agent";
  label: string;
  event: "start" | "end" | "queued";
  at: number;
  waitedMs?: number;
  /** The ship.js phase this call site belongs to. Absent on pre-#60 lines. */
  phase?: string;
}

export interface MutationRecord {
  kind: "mutation";
  at: number;
  /** Dotted paths that changed, one level into `gates` and `environments`. */
  fields: string[];
  /**
   * Who wrote it, when that is knowable.
   *
   * It usually is not: `writeWorkflowState` is called from an agent's `bun -e`
   * one-liner and nothing in that process knows which call site spawned it.
   * #60 asked for "by which agent" and this is the honest half of it — the
   * field is omitted rather than filled with a guess, and the viewer prints
   * `unattributed`, which is a different word from a name.
   */
  source?: string;
}

export interface GateRecord {
  kind: "gate";
  at: number;
  gate: string;
  result: string;
  failures: string[];
}

export type TrajectoryRecord = AgentRecord | MutationRecord | GateRecord;

export interface TrajectoryRead {
  records: TrajectoryRecord[];
  /** Lines that did not parse as any known record, verbatim. Never discarded. */
  malformed: string[];
  /** The artifact does not exist. Distinct from "it exists and is empty". */
  missing: boolean;
}

// ── writing ──────────────────────────────────────────────────

/**
 * Append one record. One `JSON.stringify` and one `appendFileSync`, under the
 * pipe-buffer size, which is what keeps concurrent agents from interleaving
 * mid-line — the same discipline `recordEvent` has always used.
 */
export function appendTrajectory(artifact: string, record: TrajectoryRecord): void {
  mkdirSync(dirname(artifact), { recursive: true });
  const { kind, ...rest } = record;
  const line = kind === "agent" ? rest : { type: kind, ...rest };
  appendFileSync(artifact, `${JSON.stringify(line)}\n`);
}

// ── reading ──────────────────────────────────────────────────

function parseAgent(v: Record<string, unknown>): AgentRecord | null {
  const { label, event, at, waitedMs, phase } = v;
  if (typeof label !== "string" || label.length === 0) return null;
  if (event !== "start" && event !== "end" && event !== "queued") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  // A queued record with no readable duration is MALFORMED, never a zero wait:
  // reading it as zero makes the one record whose job is to say "this call
  // waited" report that it did not (#239).
  if (event === "queued" && (typeof waitedMs !== "number" || !Number.isFinite(waitedMs) || waitedMs < 0)) {
    return null;
  }
  return {
    kind: "agent",
    label,
    event,
    at,
    ...(event === "queued" ? { waitedMs: waitedMs as number } : {}),
    ...(typeof phase === "string" && phase.length > 0 ? { phase } : {}),
  };
}

function parseMutation(v: Record<string, unknown>): MutationRecord | null {
  const { at, fields, source } = v;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (!Array.isArray(fields)) return null;
  const clean = fields.filter((f): f is string => typeof f === "string" && f.length > 0);
  // A mutation that changed nothing is not a mutation, and recording one would
  // put a row in the timeline saying a write happened with no content — the
  // shape a reader would treat as "something changed and we lost what".
  if (clean.length !== fields.length || clean.length === 0) return null;
  return {
    kind: "mutation",
    at,
    fields: clean,
    ...(typeof source === "string" && source.length > 0 ? { source } : {}),
  };
}

function parseGate(v: Record<string, unknown>): GateRecord | null {
  const { at, gate, result, failures } = v;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof gate !== "string" || gate.length === 0) return null;
  if (typeof result !== "string" || result.length === 0) return null;
  const lines = Array.isArray(failures) ? failures.filter((f): f is string => typeof f === "string") : [];
  return { kind: "gate", at, gate, result, failures: lines };
}

export function parseTrajectoryLine(line: string): TrajectoryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type === undefined) return parseAgent(v);
  if (v.type === "mutation") return parseMutation(v);
  if (v.type === "gate") return parseGate(v);
  // A `type` this version does not know is MALFORMED rather than skipped. A
  // reader that quietly drops record kinds it has not been taught reports a
  // complete timeline over a file it only partly understood.
  return null;
}

export function readTrajectory(artifact: string): TrajectoryRead {
  if (!existsSync(artifact)) return { records: [], malformed: [], missing: true };
  const records: TrajectoryRecord[] = [];
  const malformed: string[] = [];
  for (const line of readFileSync(artifact, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    const record = parseTrajectoryLine(line);
    if (record) records.push(record);
    else malformed.push(line);
  }
  return { records, malformed, missing: false };
}

// ── phase spans ──────────────────────────────────────────────

export interface PhaseSpan {
  phase: string;
  /** First agent event observed in this phase. */
  startedAt: number;
  /** Last agent event observed in this phase. */
  endedAt: number;
  seconds: number;
  /** How many agent brackets contributed. One is a span of one call, not a phase. */
  agents: number;
}

/**
 * The span of each phase that recorded anything, in first-seen order.
 *
 * Derived rather than written, because nothing can write it: a phase boundary
 * in `workflows/ship.js` is a `phase('Goal')` call inside the sandbox, with no
 * clock and no filesystem. The agents inside the phase are the only
 * participants that can report, so the phase is as wide as its agents and no
 * wider.
 *
 * Phases that recorded nothing do not appear. That is the honest answer and it
 * is why `scripts/view-trajectory.ts` prints the caveat rather than listing a
 * phase at zero seconds.
 */
export function phaseSpans(records: TrajectoryRecord[]): PhaseSpan[] {
  const order: string[] = [];
  const byPhase = new Map<string, { first: number; last: number; labels: Set<string> }>();
  for (const r of records) {
    if (r.kind !== "agent" || !r.phase) continue;
    const seen = byPhase.get(r.phase);
    if (!seen) {
      order.push(r.phase);
      byPhase.set(r.phase, { first: r.at, last: r.at, labels: new Set([r.label]) });
      continue;
    }
    // `min`/`max` rather than first-and-last-in-file: parallel agents append
    // out of order, so the last line of a phase is not always its latest
    // event.
    seen.first = Math.min(seen.first, r.at);
    seen.last = Math.max(seen.last, r.at);
    seen.labels.add(r.label);
  }
  return order.map((phase) => {
    const s = byPhase.get(phase)!;
    return {
      phase,
      startedAt: s.first,
      endedAt: s.last,
      seconds: Math.round(((s.last - s.first) / 1000) * 1000) / 1000,
      agents: s.labels.size,
    };
  });
}

// ── the merged timeline ──────────────────────────────────────

export interface TimelineRow {
  at: number;
  kind: TrajectoryRecord["kind"];
  /** One line, already formatted. The viewer adds the clock column. */
  text: string;
}

/**
 * Every record as one ordered list of rows.
 *
 * Sorted by `at`, with ties keeping file order — several events inside one
 * millisecond are common on a fast machine, and reordering them would make the
 * timeline disagree with the artifact for no gain.
 */
export function timeline(records: TrajectoryRecord[]): TimelineRow[] {
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
    .map(({ r }) => {
      if (r.kind === "agent") {
        const where = r.phase ? ` [${r.phase}]` : "";
        const waited = r.event === "queued" ? ` waited ${r.waitedMs}ms` : "";
        return { at: r.at, kind: r.kind, text: `agent ${r.label} ${r.event}${waited}${where}` };
      }
      if (r.kind === "mutation") {
        return {
          at: r.at,
          kind: r.kind,
          text: `state ${r.source ?? "unattributed"} wrote ${r.fields.join(", ")}`,
        };
      }
      const detail = r.failures.length > 0 ? ` — ${r.failures.join("; ")}` : "";
      return { at: r.at, kind: r.kind, text: `gate ${r.gate} ${r.result}${detail}` };
    });
}

// ── state mutations ──────────────────────────────────────────

/**
 * Which field paths differ between two states.
 *
 * Top level, plus one level into the containers a run actually mutates during
 * a pipeline — `gates`, `environments` and `gateContract`. Deeper than that is
 * noise: every AC verdict edit would print a path per AC and the timeline
 * would stop being readable, which is the one thing #60 is for.
 *
 * Compared by serialised value rather than by reference, because callers read
 * the state, mutate it in place, and write the same object back — a reference
 * comparison would report that nothing ever changed.
 */
const NESTED = ["gates", "environments", "gateContract"];

export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): string[] {
  if (before === null) return ["<initial write>"];
  const changed: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const a = before[key];
    const b = after[key];
    if (stable(a) === stable(b)) continue;
    if (!NESTED.includes(key) || !isRecord(a) || !isRecord(b)) {
      changed.push(key);
      continue;
    }
    const sub = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...sub].sort()) {
      if (stable(a[k]) !== stable(b[k])) changed.push(`${key}.${k}`);
    }
  }
  return changed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stable(v: unknown): string {
  // `undefined` and absent are the same fact here, and JSON.stringify returns
  // `undefined` (the value, not the string) for both — which would compare
  // equal to itself and unequal to nothing, so it is normalised first.
  if (v === undefined) return "\u0000absent";
  return JSON.stringify(v, (_k, x) =>
    isRecord(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
      : x,
  );
}

/**
 * Record a state write on the run's trajectory.
 *
 * **Never throws.** A trajectory line is a record OF a state write and must
 * not be able to prevent one: losing the line costs a row in a timeline,
 * losing the write costs the run. The failure goes to stderr rather than being
 * swallowed — there is no channel left to record it on, since the thing that
 * failed is the recorder.
 *
 * Returns the fields it recorded, or `null` when it recorded nothing, so a
 * caller that wants to assert on the recording can.
 */
export function recordStateWrite(
  stateFile: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  source?: string,
  at: number = Date.now(),
): string[] | null {
  try {
    const fields = changedFields(before, after);
    if (fields.length === 0) return null;
    appendTrajectory(trajectoryFor(stateFile), { kind: "mutation", at, fields, ...(source ? { source } : {}) });
    return fields;
  } catch (err) {
    process.stderr.write(
      `trajectory: could not record the state write to ${stateFile} — ` +
        `${err instanceof Error ? err.message : String(err)}. The write itself is unaffected; ` +
        `this run's timeline is missing a row (#60).\n`,
    );
    return null;
  }
}
