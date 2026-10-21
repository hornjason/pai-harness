/**
 * One reading of the process table, for every caller that needs one (#690, #707).
 *
 * Two subsystems ask about running processes and they used to ask differently:
 * `lib/test-suite-lock.ts` ran `ps -axo command` and pattern-matched the text,
 * and `~/.pai/hooks/OrphanProcessCleanup.hook.ts` ran `pgrep -f "bun test"` and
 * then `pkill -f "bun test"`. Neither could answer the only question that
 * matters when processes belong to other people — **whose process is this** —
 * because neither read a pid, a parent, or an age.
 *
 * ## A pattern is not a reading, and `pkill` is not a decision
 *
 * `pkill -f <pattern>` has no observation step at all: it matches and signals
 * in one syscall sequence, against whatever the table holds at signal time,
 * including processes that started after whoever ran it decided to run it.
 * There is no pid to record, no list to report, and no way to exclude the
 * shell that launched the thing being killed — `-f` matches the full command
 * line, so the measuring wrapper dies with the measured suite and the exit
 * code is never written. That is #690: two full suites died mid-run on
 * 2026-10-19 leaving logs that end at 323 lines with no summary, which is
 * byte-indistinguishable from a hang.
 *
 * So this module reads ROWS — pid, ppid, elapsed seconds, command — and every
 * decision downstream is taken about a row and signalled to a pid. Nothing in
 * this repository may signal by pattern; `test/orphan-reaper.test.ts` holds
 * that population at zero over `lib`, `hooks`, `scripts`, `workflows`,
 * `gates` and `bin`, with no exemption list.
 *
 * ## An unreadable table is UNMEASURED, and it has a control string
 *
 * `ps` exiting non-zero, printing nothing, or printing something this parser
 * cannot read must NOT come back as "no processes are running" — `0`, `[]`
 * and silence are indistinguishable from success
 * (`.claude/rules/config-access.md`). The control is the cheapest one
 * available and it cannot be absent from a real reading: **the reading must
 * contain the pid of the process taking it.** A table that cannot see its own
 * reader is an instrument failure, and `readProcessTable` throws rather than
 * returning a short list that every caller would read as an idle machine.
 */

import { execFileSync } from "child_process";

/** One row of the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Wall-clock seconds since the process started, from `ps` `etime`. */
  elapsedSeconds: number;
  /** The full command line, `argv` joined by spaces, as `ps` reports it. */
  command: string;
}

/**
 * The process table could not be read, or the reading failed its own control.
 *
 * A distinct type so a caller can report UNMEASURED by name instead of
 * folding the failure into an empty list.
 */
export class ProcessTableUnreadable extends Error {
  constructor(reason: string) {
    super(`the process table is UNMEASURED: ${reason}`);
    this.name = "ProcessTableUnreadable";
  }
}

/** The `ps` invocation, in one place so there is one thing to mutate. */
export const PS_ARGS = ["-axo", "pid=,ppid=,etime=,command="];

/**
 * `etime` in seconds, from BSD `ps`'s four shapes: `SS`, `MM:SS`, `HH:MM:SS`
 * and `DD-HH:MM:SS`.
 *
 * Returns `null` rather than 0 on anything it cannot read. Zero is a real age
 * — a process that started this second — so returning it for a parse failure
 * would make an unreadable row look like the youngest possible process, which
 * is the one state an age floor treats as "definitely leave this alone". That
 * is the safe direction for the floor and the wrong direction for honesty, so
 * the caller is made to decide.
 */
export function parseEtime(raw: string): number | null {
  const text = raw.trim();
  if (!/^(\d+-)?(\d+:)?(\d+:)?\d+$/.test(text)) return null;
  const [days, clock] = text.includes("-")
    ? [Number(text.slice(0, text.indexOf("-"))), text.slice(text.indexOf("-") + 1)]
    : [0, text];
  const parts = clock.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86_400 + seconds;
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,command=` output into rows.
 *
 * Lines this cannot read are DROPPED and counted by the caller's control
 * rather than guessed at — a row with an unparseable age is a row nobody can
 * apply an age floor to.
 */
export function parseProcessTable(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const elapsedSeconds = parseEtime(m[3]);
    if (elapsedSeconds === null) continue;
    const command = m[4].trim();
    if (!command) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsedSeconds, command });
  }
  return rows;
}

/** How the table is fetched. Injected so no test has to run `ps`. */
export type ProcessTableReader = () => string;

const defaultReader: ProcessTableReader = () =>
  execFileSync("ps", PS_ARGS, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });

/**
 * Read the process table, or throw `ProcessTableUnreadable`.
 *
 * The control is applied here and not left to callers: a reading that does
 * not contain `selfPid` is refused. Every caller then gets rows it can trust
 * or an exception it has to name, and neither can be mistaken for an idle
 * machine.
 */
export function readProcessTable(
  options: { read?: ProcessTableReader; selfPid?: number } = {},
): ProcessRow[] {
  const selfPid = options.selfPid ?? process.pid;
  let raw: string;
  try {
    raw = (options.read ?? defaultReader)();
  } catch (e) {
    throw new ProcessTableUnreadable(`ps could not be run (${(e as Error).message})`);
  }
  const rows = parseProcessTable(raw);
  if (!rows.some((r) => r.pid === selfPid)) {
    throw new ProcessTableUnreadable(
      `the reading does not contain the reader's own pid ${selfPid}, ` +
        `so ${rows.length} rows is not a count of what is running`,
    );
  }
  return rows;
}
