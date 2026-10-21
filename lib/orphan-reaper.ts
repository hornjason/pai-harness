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
 *    reason that keeps a peer's run alive. **This condition has a known
 *    false-positive path — read `INIT_PID` below before arming anything.**
 * 3. **It is older than the floor.** A suite started seconds ago is never an
 *    orphan (#690 AC-3), and the floor is set well past any plausible run
 *    rather than at the edge of one.
 *
 * Every row is judged against all three, independently, and carries all three
 * readings into the report. `reason` is the FIRST condition that failed, which
 * is what an operator wants at a glance and is not enough to diagnose a false
 * positive: a row reading `LIVE_PARENT` says nothing about whether it was even
 * a suite or whether it had cleared the floor. `conditions` says, so a
 * dry-run log can be read without reproducing the machine state that produced
 * it (#690 AC-4).
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
 *
 * **It shipped disarmed and it should stay that way until the dry-run log has
 * been read.** `armedFromEnv` is the only thing that arms it: there is no
 * config key, nothing in the scaffold writes it, and `hooks/` is not in
 * `package.json` `files[]`, so no consumer inherits the caller. The two
 * reasons to leave it disarmed are measurements, not caution — see `INIT_PID`
 * and `MIN_ORPHAN_AGE_SECONDS` below. Arm it by reading a few days of
 * `conditions` lines and checking that every row it would have signalled was
 * in fact dead.
 *
 * **"Disarmed" was an assumption until #690's last wave.** The claim rested
 * on a `===` spelled inline in a hook — nothing executed it with the values
 * that must NOT arm it, and nothing in the tree would have noticed a commit
 * adding the variable to a workflow `env:` block or a settings file. Both
 * halves are now cases: `armedFromEnv` is driven over the values, and
 * `test/orphan-reaper.test.ts` holds the population of committed ARMING
 * positions at zero over the file types that can set an environment
 * variable.
 */

import {
  classifyPsLine,
  type ExecutableResolver,
  type PsLineReading,
} from "./test-suite-lock";
import { readProcessTable, type ProcessRow } from "./process-table";

/**
 * How old a parentless suite must be before it is residue (#690 AC-3).
 *
 * ONE declaration, so there is one thing for a battery to mutate. Thirty
 * minutes is deliberately far past a real run rather than next to one: the
 * cost of waiting is some CPU, and the cost of being wrong is somebody's
 * measurement. A suite reparented to init and still going after half an hour
 * has no shell left to read its exit code.
 *
 * **Thirty minutes was chosen against a healthy machine, and this machine is
 * not reliably one.** The Linux CI runners live in a Lima VM with 9912 MB of
 * RAM running nine runner units, each peaking at 3.5–4.0 GB, and a suite
 * runs 474 files as separate processes under `--isolate`. A legitimate run
 * under that much memory pressure takes far longer than a run on an idle
 * host, so the floor that is "well past any plausible run" on a quiet machine
 * is not obviously past one here. **The dry-run log decides this number**, not
 * an estimate: read what a few days of it would have signalled, and raise the
 * floor past the oldest row that turns out to have been alive.
 */
export const MIN_ORPHAN_AGE_SECONDS = 1800;

/**
 * The pid a process is reparented to when its parent exits.
 *
 * ## `ppid === 1` is not proof the owner is gone (measured 2026-10-21)
 *
 * The design reads "reparented to init" as "the launching session exited",
 * and on a healthy machine that is what it means. There is a second way to
 * reach it, and this hardware produces it: **when the kernel OOM-killer kills
 * a parent, its children are reparented to init exactly like an orphan.**
 * Three self-hosted CI runners on the Mac Mini's Lima VM were OOM-killed
 * mid-job on 2026-10-21. Any suite one of them had spawned survived the kill,
 * kept running, kept doing useful work — and from `ps` it is byte-identical
 * to residue: `ppid 1`, a `bun test` argv, and an age that climbs.
 *
 * So the condition is **necessary and not sufficient**, and the gap is on the
 * dangerous side: it over-reports orphans rather than under-reporting them.
 * Whoever arms this is signalling that class too. Nothing here tries to tell
 * the two apart, because the distinguishing evidence is not in the process
 * table — it is in whether anything is still reading the suite's output — and
 * guessing at it would be a second decider that agrees with the first.
 *
 * What to do instead of widening this check from first principles: read the
 * dry-run log. Every candidate line carries the full argv and all three
 * conditions, so an OOM-reparented survivor is identifiable after the fact.
 * If the log names a suite that was alive, the OOM case needs handling
 * BEFORE this goes anywhere near a signal.
 */
export const INIT_PID = 1;

/** Why a row was or was not signalled. Every row carries one. */
export type ReapReason =
  | "ORPHANED"
  | "NOT_A_SUITE"
  | "UNCLASSIFIED"
  | "SELF_OR_ANCESTOR"
  | "LIVE_PARENT"
  | "TOO_YOUNG";

/**
 * Every condition, read for every row, whether or not an earlier one settled
 * the answer.
 *
 * `reason` is a short-circuit and so cannot carry this: `LIVE_PARENT` is the
 * first failing condition and says nothing about the other two. Reading a
 * dry-run log for false positives means asking "what else was true of this
 * row", and a log that answers only "the first thing that was false" sends
 * the reader back to a machine state that no longer exists.
 *
 * `suite` keeps the classifier's three-state reading rather than a boolean,
 * because `not-suite` and `unknown` are different facts and collapsing them
 * is what #707 was about.
 */
export interface ReapConditions {
  /** Condition 1, as `classifyPsLine` read it. Only `suite` can be reaped. */
  suite: PsLineReading;
  /** Condition 2 — see `INIT_PID` for the OOM-reparenting false positive. */
  parentGone: boolean;
  /** Condition 3, against `floorSeconds`. */
  olderThanFloor: boolean;
  /** Not one of the three: this process or one of its ancestors. */
  protectedPid: boolean;
}

export interface ReapDecision {
  pid: number;
  ppid: number;
  ageSeconds: number;
  command: string;
  reap: boolean;
  reason: ReapReason;
  conditions: ReapConditions;
  /** The floor `olderThanFloor` was read against, so the log is self-contained. */
  floorSeconds: number;
}

/**
 * The one decider. `reap` is `reason === "ORPHANED"` and nothing else
 * computes it, so there is no second binding that could disagree.
 */
function reasonFrom(c: ReapConditions): ReapReason {
  if (c.suite === "not-suite") return "NOT_A_SUITE";
  if (c.suite === "unknown") return "UNCLASSIFIED";
  if (c.protectedPid) return "SELF_OR_ANCESTOR";
  if (!c.parentGone) return "LIVE_PARENT";
  if (!c.olderThanFloor) return "TOO_YOUNG";
  return "ORPHANED";
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
  const floorSeconds = options.minAgeSeconds ?? MIN_ORPHAN_AGE_SECONDS;
  // Every condition is read for every row. A short-circuit here would leave
  // the later conditions unmeasured, and an unmeasured condition rendered in
  // a log is indistinguishable from one that was false.
  const conditions: ReapConditions = {
    suite: classifyPsLine(row.command, options),
    parentGone: row.ppid === INIT_PID,
    olderThanFloor: row.elapsedSeconds >= floorSeconds,
    protectedPid: options.protectedPids?.has(row.pid) === true,
  };
  const reason = reasonFrom(conditions);
  return {
    pid: row.pid,
    ppid: row.ppid,
    ageSeconds: row.elapsedSeconds,
    command: row.command,
    reap: reason === "ORPHANED",
    reason,
    conditions,
    floorSeconds,
  };
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

/** The one variable that can arm the reaper, and the one value that does it. */
export const ARM_ENV_VAR = "RUNGATE_REAP_ORPHANS";
export const ARM_ENV_VALUE = "1";

/**
 * Whether the environment arms the reaper. The ONE arming decider.
 *
 * It was `process.env.RUNGATE_REAP_ORPHANS === '1'`, spelled inline at the
 * hook's call site. That is the same comparison and it could not be driven:
 * a hook module runs its work at import, so the only way to ask "does an
 * empty environment arm this" was to read the source and agree with it. The
 * repository's claim about its own kill switch was the one claim with no
 * instrument behind it, on the one switch where being wrong costs somebody
 * else's three-hour run.
 *
 * Read EXACTLY, for the reason `.claude/rules/config-access.md` gives about
 * `RUNGATE_REQUIRE_AI_REVIEW`: a loose reading of a variable that turns a
 * gate on is a gate that turns itself on by accident. `true`, `TRUE`, `yes`,
 * `01` and a leading space are all disarmed, and each is a case.
 *
 * `env` is a parameter so a case can pass a table instead of mutating the
 * live `process.env` — a suite that armed its own environment and then threw
 * would leave the variable set for every later file in the same process.
 */
export function armedFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ARM_ENV_VAR] === ARM_ENV_VALUE;
}

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

/** `yes`/`no`, or the classifier's own word when the reading is three-state. */
const conditionLine = (d: ReapDecision): string =>
  [
    `suite=${d.conditions.suite}`,
    `parent-gone=${d.conditions.parentGone ? "yes" : "no"}`,
    `past-floor=${d.conditions.olderThanFloor ? "yes" : "no"}` +
      `(${d.ageSeconds}s/${d.floorSeconds}s)`,
    `self=${d.conditions.protectedPid ? "yes" : "no"}`,
  ].join(" ");

/**
 * The report as lines an operator can act on.
 *
 * Every line names a pid, a parent, an age, **all three conditions** and the
 * full argv, because the thing that made #690 expensive was a banner that
 * counted without saying what it counted — and the thing that would make a
 * false positive expensive is a line that names only the first condition
 * that failed. This is the log a decision to arm has to be read off, so it
 * has to be diagnosable on its own: by the time anyone reads it, the process
 * table it describes is gone and no repro is available.
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
      `  pid=${d.pid} ppid=${d.ppid} age=${d.ageSeconds}s ` +
        `${conditionLine(d)} ${d.reason} ` +
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
