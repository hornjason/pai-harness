/**
 * Which run wrote what is in a WORK_DIR, and whether that run is still alive
 * (#288).
 *
 * `WORK_DIR` is `~/.rungate/<slug>/`, and the slug is repo + issue number. So
 * every run of one issue writes into one directory, nothing clears it and
 * nothing stamps it. After a failed run the directory holds a complete,
 * plausible, WRONG set of artefacts and a reader has no way to tell.
 *
 * Measured: `~/.rungate/pai-harness-254/workflow-state.json` was read while a
 * fresh #254 run was in flight. It showed `phase: VERIFY`, 6 ACs and a
 * populated `rook-findings.json`. The run was actually at `setup`, three
 * agents in. Everything read was the previous night's failed run, and a
 * healthy run was cancelled on that misreading.
 *
 * ## No new write sites
 *
 * Disposition is derived from what the harness already writes — the marker,
 * the run id in the state file, the state's own `updatedTs` heartbeat, and
 * the ship gate's verdict. `workflows/ship.js` has 45 return points, and a
 * design requiring a stamp at each would be wrong by the time the 46th was
 * added. Nothing here needs ship.js to remember anything.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

/** The marker file that says whose directory this is. */
export const RUN_MARKER_FILE = "run.json";

/** Directory prefix a swept run's artefacts are moved under. */
export const ARCHIVE_PREFIX = "previous-run-";

/**
 * How long a run may go without writing before a reader calls it abandoned.
 *
 * Generous on purpose. A container rebuild and a full suite can leave the
 * state file untouched for a long stretch, and calling a live run abandoned
 * is the mistake that gets a healthy run cancelled — which is the mistake
 * this module exists to prevent, not one to reintroduce from the other side.
 */
export const HEARTBEAT_WINDOW_MS = 4 * 3_600_000;

export interface RunMarker {
  runId: string;
  issue: number;
  slug: string;
  startedTs: string;
}

export interface BeginRunOptions {
  issue: number;
  slug: string;
  /** Supplied by tests and by a caller that already minted one. */
  runId?: string;
}

export type DispositionStatus =
  | "NO_MARKER"
  | "UNREADABLE"
  | "MIXED"
  | "RUNNING"
  | "ABANDONED"
  | "COMPLETED";

export interface Disposition {
  status: DispositionStatus;
  runId?: string;
  startedTs?: string;
  shipVerdict?: string;
  /** Why, when the status alone does not say it. */
  detail?: string;
}

/**
 * A run id that cannot collide with the run before it.
 *
 * Not a timestamp. The two runs this has to tell apart are a failed run and
 * its immediate re-run, which is exactly the pair a second-resolution clock
 * reports as one.
 */
export function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, "")}`;
}

function markerPath(dir: string): string {
  return join(dir, RUN_MARKER_FILE);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The marker, or null when there is none and when there is an unreadable one. */
export function readRunMarker(dir: string): RunMarker | null {
  const raw = readJson(markerPath(dir));
  if (!isRecord(raw) || typeof raw.runId !== "string" || !raw.runId) return null;
  return {
    runId: raw.runId,
    issue: typeof raw.issue === "number" ? raw.issue : -1,
    slug: typeof raw.slug === "string" ? raw.slug : "",
    startedTs: typeof raw.startedTs === "string" ? raw.startedTs : "",
  };
}

/** Entries in `dir` that are not this run's and not bookkeeping. */
export function staleArtefacts(dir: string, runId: string): string[] {
  const marker = readRunMarker(dir);
  if (marker && marker.runId === runId) return [];
  return readdirSync(dir).filter(
    name => name !== RUN_MARKER_FILE && !name.startsWith(ARCHIVE_PREFIX),
  );
}

/**
 * Claim the directory for a new run, moving everything that is not this
 * run's out of the way first.
 *
 * ARCHIVED, never deleted. `scripts/preserve-worktree-work.ts` exists because
 * output a run refused to collect is still output, sometimes the only copy —
 * trading a misattribution bug for a data-loss bug is not a fix. The archive
 * is named for the run that WROTE the files, so a reader walking the
 * directory gets a history rather than a pile.
 *
 * Existing archives are left where they are. Sweeping them into each other
 * would nest a tenth run's directory nine deep and bury the first.
 */
export function beginRun(dir: string, opts: BeginRunOptions): RunMarker {
  mkdirSync(dir, { recursive: true });

  const previous = readRunMarker(dir);
  // `previous` is null both when there was no marker and when there was an
  // unreadable one. Either way the files beside it are not this run's, and a
  // marker nobody can parse is not evidence that they are. The id is a
  // placeholder in that case, so the archive still has a name.
  const leftovers = readdirSync(dir).filter(
    name => name !== RUN_MARKER_FILE && !name.startsWith(ARCHIVE_PREFIX),
  );
  if (leftovers.length > 0) {
    const archive = join(dir, `${ARCHIVE_PREFIX}${previous?.runId ?? newRunId()}`);
    mkdirSync(archive, { recursive: true });
    for (const name of leftovers) renameSync(join(dir, name), join(archive, name));
  }

  const marker: RunMarker = {
    runId: opts.runId || newRunId(),
    issue: opts.issue,
    slug: opts.slug,
    startedTs: new Date().toISOString(),
  };
  writeFileSync(markerPath(dir), JSON.stringify(marker, null, 2));
  return marker;
}

/**
 * What a reader should believe about this directory.
 *
 * The order matters, and each step is the question the one before it leaves
 * open:
 *
 * 1. No marker — say that, rather than a verdict about a run. Every WORK_DIR
 *    in `~/.rungate` is in this state until its next run.
 * 2. An unreadable marker — also said, not repaired.
 * 3. The state file naming a different run than the marker, or naming none:
 *    MIXED. This is the misreading itself, caught. Neither value is more
 *    trustworthy than the other, so neither wins.
 * 4. A ship verdict — the run reached its end. COMPLETED is about whether it
 *    finished, not whether it liked what it found; a FAIL counts, or every
 *    refusal would file as abandoned and hide the ones that really were.
 * 5. Otherwise the heartbeat decides, and an unparseable one is ABANDONED.
 *    Defaulting it to `now` would report every corrupt directory as live.
 */
export function runDisposition(dir: string, nowMs: number): Disposition {
  if (!existsSync(markerPath(dir))) return { status: "NO_MARKER" };

  const marker = readRunMarker(dir);
  if (!marker) {
    return { status: "UNREADABLE", detail: `${RUN_MARKER_FILE} could not be parsed` };
  }

  const base = { runId: marker.runId, startedTs: marker.startedTs };
  const state = readJson(join(dir, "workflow-state.json"));

  // No state file yet. `beginRun` stamps before `initWorkflow` writes, so
  // there is a real window where this is the honest reading of a healthy run.
  if (!isRecord(state)) return { ...base, status: "RUNNING" };

  const stateRunId = typeof state.runId === "string" ? state.runId : "";
  if (stateRunId !== marker.runId) {
    return {
      ...base,
      status: "MIXED",
      detail:
        `workflow-state.json was written by ${stateRunId || "a run that recorded no id"}, ` +
        `and ${RUN_MARKER_FILE} says this directory belongs to ${marker.runId}`,
    };
  }

  const gates = isRecord(state.gates) ? state.gates : {};
  const ship = isRecord(gates.ship) ? gates.ship : undefined;
  if (ship && typeof ship.verdict === "string" && ship.verdict) {
    return { ...base, status: "COMPLETED", shipVerdict: ship.verdict };
  }

  const beat = typeof state.updatedTs === "string" ? Date.parse(state.updatedTs) : NaN;
  if (!Number.isFinite(beat)) {
    return { ...base, status: "ABANDONED", detail: "updatedTs could not be read as a time" };
  }
  if (nowMs - beat > HEARTBEAT_WINDOW_MS) {
    return {
      ...base,
      status: "ABANDONED",
      detail: `nothing has been written for ${Math.round((nowMs - beat) / 3_600_000)}h`,
    };
  }
  return { ...base, status: "RUNNING" };
}

/**
 * Where each AC's MET verdict came from (#288).
 *
 * A run that inherited six passing ACs and a run that implemented six passing
 * ACs produce the same artefact, which is the reading `acCoverage` was added
 * for in #251, missing on the neighbouring field. Every AC in the list is
 * labelled — an absent entry is what an AC nobody classified looks like, and
 * the two have to stay distinguishable.
 */
export function acProvenance(priorWork: unknown): Record<string, { source: string; branch?: string }> | undefined {
  if (!isRecord(priorWork)) return undefined;
  const statuses = Array.isArray(priorWork.acStatus) ? priorWork.acStatus : [];
  const branch = typeof priorWork.branch === "string" ? priorWork.branch : "";

  const out: Record<string, { source: string; branch?: string }> = {};
  for (const entry of statuses) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue;
    out[entry.id] =
      entry.status === "MET" ? { source: "adopted", branch } : { source: "this-run" };
  }
  return out;
}
