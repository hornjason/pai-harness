/**
 * Reap test-suite processes that have no owner left (#690, #712).
 *
 * The thing this replaces never tested for orphanhood.
 * `~/.pai/hooks/OrphanProcessCleanup.hook.ts` is, in its entirety:
 *
 * ```
 * pgrep -f "bun test"        # find every bun test process on the machine
 * pkill  -f "bun test"       # SIGTERM all of them
 * sleep 1
 * pkill -9 -f "bun test"     # SIGKILL the survivors
 * ```
 *
 * No parent check, no age check, no session check, and it was registered on
 * `SessionStart` **and** `SessionEnd`, so every session start — including a
 * compaction resume — killed every suite on the machine. Measured on
 * 2026-10-19: a consumer project's suite baseline and a peer session's suite
 * died at the same instant, both mid-run, both with no summary line and no
 * failure count, which is why it was diagnosed as a hang first. Its banner
 * said `Cleaned up 4 orphaned bun test processes` while reaping four
 * processes that all had live parents.
 *
 * ## What it was named for, and never did
 *
 * A genuinely parentless `bun test` burns CPU until reboot. `TestSuiteRelease`
 * returns the lock slot and the TTL backstops it, so slot correctness never
 * depended on the reaper — but nothing reaps the PROCESS. That job is real,
 * and a fix that merely stops killing things does not do it. The negative
 * control for this module is therefore not "nothing died": it is
 * **a genuine orphan still dies**, asserted by name in
 * `test/orphan-reaper.test.ts`.
 *
 * ## Three conditions, all of them, and a pid rather than a pattern
 *
 * `orphanDecision` is the one decider and it reaps only when every one of
 * these holds:
 *
 * 1. **The row is positively a suite.** `classifyPsLine` in
 *    `lib/test-suite-lock.ts` is asked — the same binding the concurrency
 *    guard uses to decide what keeps a slot, so the two cannot drift. Its
 *    third reading, `unknown`, is never reaped: a slot is kept on `unknown`
 *    because over-detection is safe there, and a process is spared on
 *    `unknown` because over-detection is not safe here. One classifier, read
 *    in opposite directions, each named.
 * 2. **The parent is gone.** `ppid === 1` means the launching session exited
 *    and the kernel reparented the process to init. A suite with a live
 *    parent belongs to somebody who is still there, and `LIVE_PARENT` is the
 *    reason that keeps a peer's run alive.
 * 3. **It is older than the floor.** A suite started seconds ago is never an
 *    orphan (#690 AC-3), and the floor is set well past any plausible run
 *    rather than at the edge of one.
 *
 * Signals go to one pid at a time, read off the row that was judged. There is
 * no pattern anywhere: `pkill -f` acts on whatever matches at signal time,
 * including processes that started after the decision, and it matches the
 * measuring shell as readily as the suite — which is the half of #690 that
 * destroyed the evidence.
 *
 * ## Arming is a deployment decision, and it is not this module's to take
 *
 * `reapOrphans` is inert unless `armed` is passed. The report is identical
 * either way except for `armed` and `signalled`, so a dry run says exactly
 * which pids it would have signalled and why. #690's own scope note says to
 * confirm with Jason before changing kill behaviour on this machine, and the
 * hook that would call this runs from the shared checkout at every
 * `SessionStart` — so a merge that armed it would arm it for every live peer
 * at once. See `hooks/StaleTTLCleanup.hook.ts` for the one-line flip.
 */

import { classifyPsLine, type ExecutableResolver } from "./test-suite-lock";
import { readProcessTable, type ProcessRow } from "./process-table";

/**
 * How old a parentless suite must be before it is residue (#690 AC-3).
 *
 * ONE declaration, so there is one thing for a battery to mutate. Thirty
 * minutes is deliberately far past a real run rather than next to one: the
 * cost of waiting is some CPU, and the cost of being wrong is somebody's
 * measurement. A suite reparented to init and still going after half an hour
 * has no shell left to read its exit code.
 */
export const MIN_ORPHAN_AGE_SECONDS = 1800;

/** The pid a process is reparented to when its parent exits. */
export const INIT_PID = 1;

/** Why a row was or was not signalled. Every row carries one. */
export type ReapReason =
  | "ORPHANED"
  | "NOT_A_SUITE"
  | "UNCLASSIFIED"
  | "SELF_OR_ANCESTOR"
  | "LIVE_PARENT"
  | "TOO_YOUNG";

export interface ReapDecision {
  pid: number;
  ppid: number;
  ageSeconds: number;
  command: string;
  reap: boolean;
  reason: ReapReason;
}

export interface OrphanDecisionOptions {
  minAgeSeconds?: number;
  /** Pids that must never be signalled: this process and its ancestors. */
  protectedPids?: ReadonlySet<number>;
  resolveExecutable?: ExecutableResolver;
}

/**
 * The one place a process is judged to be an orphan.
 *
 * Exported so there is exactly one binding to mutate, and so a case can drive
 * it over a table of rows without a process existing anywhere.
 */
export function orphanDecision(
  row: ProcessRow,
  options: OrphanDecisionOptions = {},
): ReapDecision {
  const base = {
    pid: row.pid,
    ppid: row.ppid,
    ageSeconds: row.elapsedSeconds,
    command: row.command,
  };
  const reading = classifyPsLine(row.command, options);
  if (reading === "not-suite") return { ...base, reap: false, reason: "NOT_A_SUITE" };
  if (reading === "unknown") return { ...base, reap: false, reason: "UNCLASSIFIED" };
  if (options.protectedPids?.has(row.pid)) {
    return { ...base, reap: false, reason: "SELF_OR_ANCESTOR" };
  }
  if (row.ppid !== INIT_PID) return { ...base, reap: false, reason: "LIVE_PARENT" };
  const floor = options.minAgeSeconds ?? MIN_ORPHAN_AGE_SECONDS;
  if (row.elapsedSeconds < floor) return { ...base, reap: false, reason: "TOO_YOUNG" };
  return { ...base, reap: true, reason: "ORPHANED" };
}

/** Every pid between `pid` and the root of the table, inclusive. */
export function ancestryOf(rows: readonly ProcessRow[], pid: number): Set<number> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>([pid]);
  let cursor = byPid.get(pid);
  while (cursor && !seen.has(cursor.ppid)) {
    seen.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return seen;
}

export interface SignalRecord {
  pid: number;
  signal: "SIGTERM" | "SIGKILL";
  ageSeconds: number;
  command: string;
}

export interface ReapReport {
  /** `UNMEASURED` means nothing was judged and nothing was signalled. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReason?: string;
  /** How many rows the reading contained, so a verdict reports its coverage. */
  examined: number;
  /**
   * One entry per CANDIDATE row — anything the classifier did not rule out as
   * `not-suite` — carrying the pid, the parent, the age and the reason.
   * "Cleaned up N" and "No orphaned processes found" were the only two things
   * the old hook could say, and neither distinguishes a real orphan from a
   * live run (#690 AC-4).
   */
  decisions: ReapDecision[];
  /** Whether signals were allowed at all. A dry run still reports decisions. */
  armed: boolean;
  signalled: SignalRecord[];
  /** Pids signalled with SIGTERM that were still present on the re-read. */
  survivors: number[];
  /** Set when the post-SIGTERM re-read could not be taken. */
  escalationUnmeasuredReason?: string;
}

export interface ReapOptions extends OrphanDecisionOptions {
  rows?: ProcessRow[];
  readRows?: () => ProcessRow[];
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Called between SIGTERM and the re-read. Injected so no case sleeps. */
  settle?: () => void;
  selfPid?: number;
  armed?: boolean;
}

const defaultKill = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
  process.kill(pid, signal);
};

/**
 * Judge every process, and — only when `armed` — signal the orphans by pid.
 *
 * An unreadable process table is `UNMEASURED` and kills nothing. An empty
 * list from a failed read must not read as "checked, nothing orphaned":
 * `readProcessTable` refuses a reading that cannot see its own reader, and
 * that refusal arrives here as an exception rather than as zero rows.
 */
export function reapOrphans(options: ReapOptions = {}): ReapReport {
  const readRows = options.readRows ?? (() => readProcessTable({ selfPid: options.selfPid }));
  let rows: ProcessRow[];
  try {
    rows = options.rows ?? readRows();
  } catch (e) {
    return {
      reading: "UNMEASURED",
      unmeasuredReason: (e as Error).message,
      examined: 0,
      decisions: [],
      armed: options.armed === true,
      signalled: [],
      survivors: [],
    };
  }

  const protectedPids =
    options.protectedPids ?? ancestryOf(rows, options.selfPid ?? process.pid);
  const decisions = rows
    .map((row) => orphanDecision(row, { ...options, protectedPids }))
    .filter((d) => d.reason !== "NOT_A_SUITE");

  const report: ReapReport = {
    reading: "MEASURED",
    examined: rows.length,
    decisions,
    armed: options.armed === true,
    signalled: [],
    survivors: [],
  };
  if (!report.armed) return report;

  const kill = options.kill ?? defaultKill;
  const doomed = decisions.filter((d) => d.reap);
  for (const d of doomed) {
    try {
      kill(d.pid, "SIGTERM");
      report.signalled.push({
        pid: d.pid,
        signal: "SIGTERM",
        ageSeconds: d.ageSeconds,
        command: d.command,
      });
    } catch {
      // Gone between the reading and the signal. Nothing to escalate.
    }
  }
  if (doomed.length === 0) return report;

  options.settle?.();
  let after: ProcessRow[];
  try {
    after = readRows();
  } catch (e) {
    report.escalationUnmeasuredReason = (e as Error).message;
    return report;
  }
  const stillThere = new Set(after.map((r) => r.pid));
  for (const d of doomed) {
    if (!stillThere.has(d.pid)) continue;
    report.survivors.push(d.pid);
    try {
      kill(d.pid, "SIGKILL");
      report.signalled.push({
        pid: d.pid,
        signal: "SIGKILL",
        ageSeconds: d.ageSeconds,
        command: d.command,
      });
    } catch {
      // Exited between the re-read and the escalation.
    }
  }
  return report;
}

/**
 * The report as lines an operator can act on.
 *
 * Every line names a pid, an age and a reason, because the thing that made
 * #690 expensive was a banner that counted without saying what it counted.
 */
export function reapReportLines(report: ReapReport): string[] {
  if (report.reading === "UNMEASURED") {
    return [`ORPHAN-REAP UNMEASURED: ${report.unmeasuredReason ?? "no reason recorded"}`];
  }
  const lines = [
    `ORPHAN-REAP ${report.armed ? "armed" : "dry-run"}: ` +
      `${report.examined} processes examined, ${report.decisions.length} candidates, ` +
      `${report.decisions.filter((d) => d.reap).length} orphaned`,
  ];
  for (const d of report.decisions) {
    lines.push(
      `  pid=${d.pid} ppid=${d.ppid} age=${d.ageSeconds}s ${d.reason} ` +
        `${d.reap && !report.armed ? "(would signal) " : ""}${d.command}`,
    );
  }
  for (const s of report.signalled) {
    lines.push(`  SIGNAL ${s.signal} pid=${s.pid} age=${s.ageSeconds}s ${s.command}`);
  }
  if (report.escalationUnmeasuredReason) {
    lines.push(`  ESCALATION UNMEASURED: ${report.escalationUnmeasuredReason}`);
  }
  return lines;
}
