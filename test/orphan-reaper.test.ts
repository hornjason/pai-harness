import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import {
  MIN_ORPHAN_AGE_SECONDS,
  ancestryOf,
  orphanDecision,
  reapOrphans,
  reapReportLines,
  type ReapDecision,
  type SignalRecord,
} from "../lib/orphan-reaper";
import {
  ProcessTableUnreadable,
  parseEtime,
  parseProcessTable,
  readProcessTable,
  type ProcessRow,
} from "../lib/process-table";
import { stripJsComments } from "../lib/strip-js-comments";

/**
 * #690 / #712 — the reaper that never tested for orphanhood.
 *
 * `~/.pai/hooks/OrphanProcessCleanup.hook.ts` found every `bun test` on the
 * machine with `pgrep -f` and signalled all of them with the matching
 * pattern kill, at every `SessionStart` AND `SessionEnd`. No parent check, no
 * age check, no session check. Two real suites belonging to two different
 * sessions died mid-run on 2026-10-19 and left logs that end with no summary,
 * which is byte-indistinguishable from a hang.
 *
 * Nothing here spawns or signals a real process. Peers run live suites on
 * this machine, so the process list and the signal function are both
 * injected — which is also the only way to assert that a SPECIFIC pid was
 * signalled, and "which pid" is the whole question the old hook could not
 * answer.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **#690's own AC-6 names it: narrow the pattern so it stops matching the
 * launching shell, and keep killing by pattern.** The reported symptom —
 * truncated logs with no exit line — disappears, because the measuring
 * wrapper survives. Every suite on the machine still dies.
 *
 * Do the cases here survive it? **Yes, non-vacuously, and by construction:**
 * no case asserts anything about a log or an exit code. `AC-1` asserts that a
 * suite WITH A LIVE PARENT is never signalled, which a narrower pattern does
 * not change, and `SC-3` asserts that no pattern kill exists in this
 * repository at all, which that repair reintroduces by definition.
 *
 * **The second cheapest wrong fix is the opposite one: stop killing
 * anything.** It satisfies #690's headline completely. `AC-2` is the negative
 * control against it and it is the only case in this file that asserts a
 * signal was sent.
 */

const ROOT = join(import.meta.dir, "..");

/** A row builder, so each case varies exactly one thing (#585). */
const row = (over: Partial<ProcessRow> = {}): ProcessRow => ({
  pid: 4242,
  ppid: 1,
  elapsedSeconds: MIN_ORPHAN_AGE_SECONDS + 60,
  command: "bun test",
  ...over,
});

/** A kill function that signals nothing and records everything. */
function recordingKill() {
  const calls: Array<{ pid: number; signal: string }> = [];
  return {
    calls,
    kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      calls.push({ pid, signal });
    },
  };
}

const reasonOf = (decisions: ReapDecision[], pid: number) =>
  decisions.find((d) => d.pid === pid)?.reason;

describe("#690 AC-1: a suite with a live owner is never signalled", () => {
  test("a running suite whose parent is alive is spared, and the reason says why", () => {
    const peer = row({ pid: 5001, ppid: 4000, command: "bun test" });
    const self = row({ pid: 9, ppid: 1, command: "bun /x/test-runner.ts" });
    const { calls, kill } = recordingKill();

    const report = reapOrphans({
      rows: [peer, self, row({ pid: 4000, ppid: 1, command: "claude" })],
      selfPid: 9,
      kill,
      armed: true,
    });

    expect(calls).toEqual([]);
    expect(reasonOf(report.decisions, 5001)).toBe("LIVE_PARENT");
  });

  test("a whole table of live suites is signalled zero times — the 2026-10-19 shape", () => {
    // Four suites, four different sessions, every one of them alive. This is
    // the exact input on which the old hook printed "Cleaned up 4 orphaned
    // bun test processes" while reaping four processes with live parents.
    const live = [11, 12, 13, 14].map((pid) =>
      row({ pid, ppid: pid + 100, elapsedSeconds: 3_600, command: "bun test" }),
    );
    const parents = [111, 112, 113, 114].map((pid) => row({ pid, ppid: 1, command: "claude" }));
    const { calls, kill } = recordingKill();

    const report = reapOrphans({
      rows: [...live, ...parents, row({ pid: 1, ppid: 0, command: "/sbin/launchd" })],
      selfPid: 1,
      kill,
      armed: true,
    });

    expect(calls).toEqual([]);
    expect(report.decisions.filter((d) => d.reap)).toEqual([]);
    expect(report.decisions.map((d) => d.reason)).toEqual([
      "LIVE_PARENT",
      "LIVE_PARENT",
      "LIVE_PARENT",
      "LIVE_PARENT",
    ]);
  });
});

describe("#690 AC-2 (negative control): a genuine orphan still dies", () => {
  /**
   * The one case in this file that asserts a signal. Without it, "the reaper
   * never kills anything" passes every other case here, satisfies #690's
   * headline, and deletes the job the hook was named for — a parentless
   * suite burning CPU until reboot.
   */
  test("a reparented suite older than the floor is signalled, by pid", () => {
    const orphan = row({ pid: 7777, ppid: 1, elapsedSeconds: MIN_ORPHAN_AGE_SECONDS + 1 });
    const { calls, kill } = recordingKill();

    const report = reapOrphans({
      rows: [orphan, row({ pid: 9, ppid: 1, command: "claude" })],
      selfPid: 9,
      kill,
      armed: true,
      // The re-read reports it gone, so there is nothing to escalate.
      readRows: () => [row({ pid: 9, ppid: 1, command: "claude" })],
    });

    expect(calls).toEqual([{ pid: 7777, signal: "SIGTERM" }]);
    expect(reasonOf(report.decisions, 7777)).toBe("ORPHANED");
    expect(report.signalled).toEqual([
      {
        pid: 7777,
        signal: "SIGTERM",
        ageSeconds: MIN_ORPHAN_AGE_SECONDS + 1,
        command: "bun test",
      } satisfies SignalRecord,
    ]);
  });

  test("a survivor is escalated to SIGKILL, and only the survivor", () => {
    const stubborn = row({ pid: 8001 });
    const compliant = row({ pid: 8002 });
    const me = row({ pid: 9, ppid: 1, command: "claude" });
    const { calls, kill } = recordingKill();

    reapOrphans({
      rows: [stubborn, compliant, me],
      selfPid: 9,
      kill,
      armed: true,
      readRows: () => [stubborn, me],
    });

    expect(calls).toEqual([
      { pid: 8001, signal: "SIGTERM" },
      { pid: 8002, signal: "SIGTERM" },
      { pid: 8001, signal: "SIGKILL" },
    ]);
  });

  test("the escalation re-read failing is UNMEASURED, not a licence to SIGKILL", () => {
    const { calls, kill } = recordingKill();
    const report = reapOrphans({
      rows: [row({ pid: 8100 }), row({ pid: 9, ppid: 1, command: "claude" })],
      selfPid: 9,
      kill,
      armed: true,
      readRows: () => {
        throw new ProcessTableUnreadable("ps died");
      },
    });

    expect(calls).toEqual([{ pid: 8100, signal: "SIGTERM" }]);
    expect(report.escalationUnmeasuredReason).toContain("ps died");
    expect(report.survivors).toEqual([]);
  });
});

describe("#690 AC-3: an age floor, so a suite started seconds ago is never an orphan", () => {
  test("a parentless suite one second under the floor is spared", () => {
    const { calls, kill } = recordingKill();
    const report = reapOrphans({
      rows: [
        row({ pid: 6001, elapsedSeconds: MIN_ORPHAN_AGE_SECONDS - 1 }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
      kill,
      armed: true,
    });

    expect(calls).toEqual([]);
    expect(reasonOf(report.decisions, 6001)).toBe("TOO_YOUNG");
  });

  test("the floor is the only thing separating the two verdicts", () => {
    // #585: vary exactly one reading. Both rows are identical apart from age,
    // so the differing verdict is a measurement of the floor and of nothing
    // else.
    const young = orphanDecision(row({ elapsedSeconds: MIN_ORPHAN_AGE_SECONDS - 1 }));
    const old = orphanDecision(row({ elapsedSeconds: MIN_ORPHAN_AGE_SECONDS }));
    expect([young.reap, old.reap]).toEqual([false, true]);
  });
});

describe("#690 AC-4: the report says what it killed and why, by pid and age", () => {
  test("every candidate carries a pid, a parent, an age and a reason", () => {
    const report = reapOrphans({
      rows: [
        row({ pid: 101, ppid: 1, elapsedSeconds: 9_000 }),
        row({ pid: 102, ppid: 500, elapsedSeconds: 9_000 }),
        row({ pid: 103, ppid: 1, elapsedSeconds: 5 }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
    });

    expect(report.decisions.map((d) => [d.pid, d.ppid, d.ageSeconds, d.reason])).toEqual([
      [101, 1, 9_000, "ORPHANED"],
      [102, 500, 9_000, "LIVE_PARENT"],
      [103, 1, 5, "TOO_YOUNG"],
    ]);
    expect(report.examined).toBe(4);
  });

  test('"Cleaned up N" and "No orphaned processes found" are no longer the whole vocabulary', () => {
    // The old hook had two sentences and neither distinguished a real orphan
    // from a live run. Two reports that the old banner would have rendered
    // identically must render differently here.
    const live = reapOrphans({
      rows: [row({ pid: 201, ppid: 300 }), row({ pid: 9, ppid: 1, command: "claude" })],
      selfPid: 9,
    });
    const dead = reapOrphans({
      rows: [row({ pid: 201, ppid: 1 }), row({ pid: 9, ppid: 1, command: "claude" })],
      selfPid: 9,
    });

    const liveLines = reapReportLines(live).join("\n");
    const deadLines = reapReportLines(dead).join("\n");
    expect(liveLines).not.toBe(deadLines);
    expect(liveLines).toContain("LIVE_PARENT");
    expect(deadLines).toContain("ORPHANED");
    expect(deadLines).toContain("pid=201");
  });
});

describe("#712 SC-3: signals go to a measured pid, never to a pattern", () => {
  /**
   * The population is a DIRECTORY LIST, not a file list, and this file lives
   * in `test/` — outside it. So there is no exemption list and this case
   * cannot exempt itself, which is the trap `.claude/rules/self-referential-tests.md`
   * records this repository falling into three times.
   *
   * Comments are stripped before the scan: `lib/orphan-reaper.ts` quotes the
   * defective hook verbatim in its docstring, and a scanner that cannot tell
   * a citation from a call would report the explanation as the offence.
   */
  const SCANNED_DIRS = ["lib", "hooks", "scripts", "workflows", "gates", "bin"];
  const PATTERN_KILLERS = /\b(pkill|killall)\b/;

  const sources = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) found.push(path);
      }
    };
    for (const d of SCANNED_DIRS) {
      const path = join(ROOT, d);
      try {
        if (statSync(path).isDirectory()) walk(path);
      } catch {
        // A directory this repository does not have is not a violation.
      }
    }
    return found;
  };

  test("the scan reads something — the control before the verdict", () => {
    // A scan that found no files agrees with every policy there is.
    expect(sources().length).toBeGreaterThan(50);
  });

  test("no executable line in this repository signals by pattern", () => {
    const offenders = sources().filter((path) =>
      PATTERN_KILLERS.test(stripJsComments(readFileSync(path, "utf-8"))),
    );
    expect(
      offenders,
      "a pattern kill acts on whatever matches at signal time, including " +
        "processes that started after the decision and the shell that " +
        "launched the one being measured (#690). Signal an explicit pid " +
        "read off a process row instead — see lib/orphan-reaper.ts.",
    ).toEqual([]);
  });

  test("the scanner can see a pattern kill when there is one to see", () => {
    // Without this the case above is satisfied by a scanner that reads
    // nothing: the comment stripper is the part most likely to eat the
    // evidence, so it is driven over a line that is code and a line that
    // is not.
    expect(PATTERN_KILLERS.test(stripJsComments('execSync("pkill -f bun");'))).toBe(true);
    expect(PATTERN_KILLERS.test(stripJsComments('// historical: pkill -f "bun test"'))).toBe(
      false,
    );
  });
});

describe("#712 SC-4: an unmeasurable process list kills nothing and says so", () => {
  test("a read that throws is UNMEASURED, with the reason carried", () => {
    const { calls, kill } = recordingKill();
    const report = reapOrphans({
      readRows: () => {
        throw new ProcessTableUnreadable("ps exited 1");
      },
      kill,
      armed: true,
    });

    expect(report.reading).toBe("UNMEASURED");
    expect(report.unmeasuredReason).toContain("ps exited 1");
    expect(calls).toEqual([]);
    expect(reapReportLines(report)[0]).toContain("UNMEASURED");
  });

  test("a table that cannot see its own reader is refused, not read as idle", () => {
    // The control string, executed: our own pid must be in any real reading.
    // An empty `ps` and an idle machine are byte-identical without it.
    expect(() =>
      readProcessTable({ read: () => "  1 0 01:00 /sbin/launchd\n", selfPid: 424242 }),
    ).toThrow(ProcessTableUnreadable);

    const rows = readProcessTable({
      read: () => "  1     0 01:00:00 /sbin/launchd\n 424242 1 00:10 bun test\n",
      selfPid: 424242,
    });
    expect(rows.map((r) => r.pid)).toEqual([1, 424242]);
  });

  test("an unreadable age drops the row rather than reading as newborn", () => {
    expect(parseEtime("??")).toBeNull();
    expect(parseProcessTable("  7 1 ?? bun test\n")).toEqual([]);
    expect(parseEtime("30")).toBe(30);
    expect(parseEtime("02:30")).toBe(150);
    expect(parseEtime("01:02:30")).toBe(3_750);
    expect(parseEtime("3-01:02:30")).toBe(3 * 86_400 + 3_750);
  });
});

describe("#707 coupling: the classifier that keeps a slot is the one that may kill", () => {
  const resolveBrun = (p: string) =>
    p === "/tmp/brun" ? "/opt/homebrew/Cellar/bun/1.3.14/bin/bun" : p;

  test("a symlink-launched orphan is reaped — the #690 workaround is not a hiding place", () => {
    const { calls, kill } = recordingKill();
    reapOrphans({
      rows: [
        row({ pid: 3001, ppid: 1, command: "/tmp/brun test" }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
      resolveExecutable: resolveBrun,
      kill,
      armed: true,
      readRows: () => [row({ pid: 9, ppid: 1, command: "claude" })],
    });
    expect(calls).toEqual([{ pid: 3001, signal: "SIGTERM" }]);
  });

  test("an executable the classifier cannot identify is never signalled", () => {
    // `unknown` keeps a slot and spares a process. The two consumers read the
    // third state in opposite directions and this is the kill side of it.
    const { calls, kill } = recordingKill();
    const report = reapOrphans({
      rows: [
        row({ pid: 3002, ppid: 1, command: "/opt/mystery/runner test --all" }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
      resolveExecutable: (p) => p,
      kill,
      armed: true,
    });
    expect(calls).toEqual([]);
    expect(reasonOf(report.decisions, 3002)).toBe("UNCLASSIFIED");
  });
});

describe("the reaper never signals itself or anything it is running inside", () => {
  test("an ancestor that looks like a suite is spared", () => {
    const rows = [
      row({ pid: 1, ppid: 0, command: "/sbin/launchd" }),
      row({ pid: 500, ppid: 1, command: "bun test" }),
      row({ pid: 501, ppid: 500, command: "bun test test/orphan-reaper.test.ts" }),
    ];
    expect([...ancestryOf(rows, 501)].sort((a, b) => a - b)).toEqual([0, 1, 500, 501]);

    const { calls, kill } = recordingKill();
    const report = reapOrphans({ rows, selfPid: 501, kill, armed: true });
    expect(calls).toEqual([]);
    expect(reasonOf(report.decisions, 500)).toBe("SELF_OR_ANCESTOR");
  });
});

describe("arming is a separate decision from deciding", () => {
  test("a dry run reports the same verdicts and signals nothing", () => {
    const rows = [row({ pid: 4001 }), row({ pid: 9, ppid: 1, command: "claude" })];
    const { calls, kill } = recordingKill();

    const dry = reapOrphans({ rows, selfPid: 9, kill });
    const armed = reapOrphans({
      rows,
      selfPid: 9,
      kill,
      readRows: () => [row({ pid: 9, ppid: 1, command: "claude" })],
      armed: true,
    });

    expect(dry.armed).toBe(false);
    expect(dry.signalled).toEqual([]);
    expect(dry.decisions).toEqual(armed.decisions);
    expect(calls).toEqual([{ pid: 4001, signal: "SIGTERM" }]);
    expect(reapReportLines(dry).join("\n")).toContain("would signal");
  });
});
