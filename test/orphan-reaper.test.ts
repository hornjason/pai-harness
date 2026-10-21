import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import {
  ARM_ENV_VALUE,
  ARM_ENV_VAR,
  MIN_ORPHAN_AGE_SECONDS,
  ancestryOf,
  armedFromEnv,
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
 * **That is a property of this file and not of the criteria.** #690 AC-1 asks
 * for a planted RUNNING suite and AC-2 for a measuring wrapper that still
 * records its exit code; neither can be asserted over a table of literals, so
 * both live in `test/orphan-reaper-live.test.ts`, which spawns its own
 * processes and signals nothing it did not spawn.
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

  test("the flag and the reason are one answer, not two that can disagree", () => {
    // Found by the battery: short-circuiting the final `reap` to `false`
    // leaves every report still saying ORPHANED while signalling nothing, and
    // the two AC-4 cases above are green over it because they read the
    // reason. Two fields answering one question is the fourth shape; this is
    // the input that can tell them apart.
    const shapes = [
      // The ORPHANED row is FIRST and is deliberately not protected. Its
      // absence is how the first draft of this case went green under the
      // mutation it was written for: every other shape returns before the
      // reap, so a fixture without this row never reaches the branch whose
      // two fields it is comparing.
      row({ pid: 6, ppid: 1, elapsedSeconds: 99_999 }),
      row({ pid: 1, ppid: 1, elapsedSeconds: 99_999 }),
      row({ pid: 2, ppid: 77, elapsedSeconds: 99_999 }),
      row({ pid: 3, ppid: 1, elapsedSeconds: 1 }),
      row({ pid: 4, ppid: 1, command: "/usr/bin/vim notes.md" }),
      row({ pid: 5, ppid: 1, command: "/opt/mystery/runner test" }),
    ];
    const decisions = shapes.map((r) =>
      orphanDecision(r, { protectedPids: new Set([1]), resolveExecutable: (p) => p }),
    );
    expect(decisions[0].reason).toBe("ORPHANED");
    expect(new Set(decisions.map((d) => d.reason)).size).toBe(6);
    for (const d of decisions) {
      expect(d.reap, `pid ${d.pid} reported ${d.reason} with reap=${d.reap}`).toBe(
        d.reason === "ORPHANED",
      );
    }
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

describe("#690 AC-4: every row says which of the three conditions it met", () => {
  /**
   * `reason` is the FIRST failing condition. That is the right thing to lead
   * with and it is not enough to diagnose a false positive: a line reading
   * `LIVE_PARENT` says nothing about whether the row was even a suite, and a
   * reader holding only the log cannot go back and look — the process table
   * is gone by then.
   *
   * ## The cheapest wrong fix, named before the repair
   *
   * **Render a `conditions` record, but keep the short-circuit and fill the
   * conditions it never reached with `false`.** It is the smaller diff, the
   * log grows the three fields the operator asked for, and every reason in
   * the tree is unchanged. What it produces is a line that reports
   * `parent-gone=no` for a process whose parent IS gone, which is worse than
   * saying nothing: a false positive hunted through that log is hunted with
   * a reading that was never taken.
   *
   * The first case below is the one that survives it, and it survives
   * non-vacuously — the differing input is a row whose unreached condition is
   * TRUE, so the default and the measurement disagree.
   */
  test("a condition after the deciding one is still read, not defaulted", () => {
    // Not a suite, so `reason` is settled at condition 1 — and the parent IS
    // gone and the age IS past the floor. A short-circuit filling the rest
    // with false reports the opposite of both.
    const d = orphanDecision(
      row({ pid: 301, ppid: 1, elapsedSeconds: 99_999, command: "/usr/bin/vim notes.md" }),
      { resolveExecutable: (p) => p },
    );

    expect(d.reason).toBe("NOT_A_SUITE");
    expect(d.conditions).toEqual({
      suite: "not-suite",
      parentGone: true,
      olderThanFloor: true,
      protectedPid: false,
    });
  });

  test("two conditions failing are both reported, not just the first", () => {
    // A live suite that is also young. `reason` can only name one of them.
    const d = orphanDecision(row({ pid: 302, ppid: 4000, elapsedSeconds: 5 }));

    expect(d.reason).toBe("LIVE_PARENT");
    expect([d.conditions.parentGone, d.conditions.olderThanFloor]).toEqual([false, false]);
    expect(d.conditions.suite).toBe("suite");
  });

  test("the conditions and the reap flag cannot disagree", () => {
    // `reap` is `reason === "ORPHANED"` and `reason` is computed from the
    // conditions, so this is one decider read twice rather than two deciders
    // that agree (the fourth shape). The pair below varies only `ppid`.
    const shapes = [
      row({ pid: 401, ppid: 1, elapsedSeconds: 99_999 }),
      row({ pid: 402, ppid: 4000, elapsedSeconds: 99_999 }),
      row({ pid: 403, ppid: 1, elapsedSeconds: 1 }),
      row({ pid: 404, ppid: 1, elapsedSeconds: 99_999, command: "/usr/bin/vim x" }),
      row({ pid: 405, ppid: 1, elapsedSeconds: 99_999, command: "/opt/mystery/runner test" }),
      row({ pid: 406, ppid: 1, elapsedSeconds: 99_999 }),
    ];
    const decisions = shapes.map((r) =>
      orphanDecision(r, { protectedPids: new Set([406]), resolveExecutable: (p) => p }),
    );

    expect(decisions.map((d) => d.reap)).toEqual([true, false, false, false, false, false]);
    for (const d of decisions) {
      const conjunction =
        d.conditions.suite === "suite" &&
        !d.conditions.protectedPid &&
        d.conditions.parentGone &&
        d.conditions.olderThanFloor;
      expect(d.reap, `pid ${d.pid} reported ${JSON.stringify(d.conditions)}`).toBe(conjunction);
    }
  });

  test("the log line carries the pid, the age, all three conditions and the full argv", () => {
    // This is the line the decision to arm has to be read off, so everything
    // needed to recognise a false positive has to be IN it.
    const argv = "/opt/homebrew/Cellar/bun/1.3.14/bin/bun test test/some-suite.test.ts";
    const report = reapOrphans({
      rows: [
        row({ pid: 501, ppid: 1, elapsedSeconds: 7_200, command: argv }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
    });
    const line = reapReportLines(report).find((l) => l.includes("pid=501"));

    expect(line).toBeDefined();
    for (const part of [
      "pid=501",
      "ppid=1",
      "age=7200s",
      "suite=suite",
      "parent-gone=yes",
      "past-floor=yes",
      `${MIN_ORPHAN_AGE_SECONDS}s`,
      "ORPHANED",
      "(would signal)",
      argv,
    ]) {
      expect(line, `the dry-run line omits ${part}`).toContain(part);
    }
  });

  test("a spared row's line still names every condition, so the log is uniform", () => {
    // The rows worth auditing for a false positive are the ones that were
    // NOT reaped — an OOM-reparented survivor is spared today only because
    // of the age floor, and a reader has to be able to see how close it was.
    const report = reapOrphans({
      rows: [
        row({ pid: 502, ppid: 1, elapsedSeconds: 60, command: "bun test" }),
        row({ pid: 9, ppid: 1, command: "claude" }),
      ],
      selfPid: 9,
    });
    const line = reapReportLines(report).find((l) => l.includes("pid=502")) ?? "";

    expect(line).toContain(`past-floor=no(60s/${MIN_ORPHAN_AGE_SECONDS}s)`);
    expect(line).toContain("parent-gone=yes");
    expect(line).toContain("TOO_YOUNG");
    expect(line).not.toContain("would signal");
  });
});

describe("#690: ppid 1 has a known false-positive path, recorded in the file", () => {
  /**
   * Not a test of behaviour — nothing here changes what the reaper does. It
   * holds the reasoning in the file, which is the whole point: whoever arms
   * this meets the OOM case in `lib/orphan-reaper.ts` rather than
   * rediscovering it from a killed suite. A note deleted in a tidy-up is a
   * note nobody meets.
   */
  test("the OOM-reparenting note sits on the constant the condition reads", () => {
    const src = readFileSync(join(ROOT, "lib/orphan-reaper.ts"), "utf-8");
    const atInit = src.indexOf("export const INIT_PID");
    expect(atInit).toBeGreaterThan(0);

    const docblock = src.slice(src.lastIndexOf("/**", atInit), atInit);
    expect(docblock).toContain("OOM");
    expect(docblock.toLowerCase()).toContain("reparent");
    // The floor is the other thing the dry-run log is supposed to decide.
    const floorAt = src.indexOf("export const MIN_ORPHAN_AGE_SECONDS");
    expect(src.slice(src.lastIndexOf("/**", floorAt), floorAt)).toContain("dry-run log");
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

describe("#690: the reaper is disarmed by default, and that is measured", () => {
  /**
   * Everything above proves `reapOrphans` signals nothing without `armed`.
   * Nothing proved what decides `armed`.
   *
   * It was `process.env.RUNGATE_REAP_ORPHANS === '1'` spelled inline at the
   * hook's call site — unreachable from a case, because a hook module does
   * its work at import, so the only available instrument was reading the
   * source and agreeing with it. The repository's claim about its own kill
   * switch was the one claim with no measurement behind it, on the one
   * switch where being wrong destroys somebody else's three-hour run.
   *
   * Two halves, and both are needed: the decider is driven over the values
   * that must not arm it, and the tree is scanned for anything that SETS the
   * variable. Either alone is satisfiable without the other — an exact
   * decider is no help if a workflow exports the exact value, and an unset
   * variable is no help if `"true"` arms it.
   *
   * The identifier is never written as a literal in this file: every form
   * below is composed from the imported constant. A scanner whose population
   * included its own controls would report them, which is the self-reference
   * trap `.claude/rules/self-referential-tests.md` records this repository
   * falling into three times.
   */
  const NAME = ARM_ENV_VAR;

  /**
   * Every spelling that SETS an environment variable, and none that reads
   * one. `=(?!=)` is what separates them: `NAME === '1'` is the legitimate
   * comparison and `NAME = '1'` is an arming, and a scan that cannot tell
   * them apart would be red on the decider itself and green on nothing.
   *
   * The limit, stated rather than left to be discovered: a set through a
   * computed key — `process.env[someVariable] = …` — is outside these forms.
   * Nothing in the tree does that, and a scan wide enough to catch it would
   * flag every environment write there is.
   */
  const armingForms = (name: string): RegExp[] => [
    new RegExp(`\\b${name}\\b\\s*=(?!=)`), //            NAME=1, env.NAME = "1"
    new RegExp(`['"]${name}['"]\\s*:`), //               "NAME": "1" — JSON
    new RegExp(`(^|[\\s{,])${name}\\s*:`, "m"), //       NAME: "1" — YAML, object literal
    new RegExp(`\\[\\s*['"]${name}['"]\\s*\\]\\s*=(?!=)`), // env["NAME"] = "1"
  ];
  const arms = (text: string): boolean => armingForms(NAME).some((re) => re.test(text));

  /** Files that can set an environment variable for a process. */
  const ENV_CAPABLE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|bash|zsh|toml)$|^\.env/;
  const JS_FAMILY = /\.(ts|tsx|js|mjs|cjs)$/;
  const SCANNED_DIRS = ["lib", "hooks", "scripts", "workflows", "gates", "bin", ".github"];

  const envCapableSources = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (ENV_CAPABLE.test(entry.name)) found.push(path);
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
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() && ENV_CAPABLE.test(entry.name)) found.push(join(ROOT, entry.name));
    }
    return found;
  };

  /** Comments cannot set a variable, and the docs quote the arming line. */
  const scannable = (path: string): string => {
    const raw = readFileSync(path, "utf-8");
    return JS_FAMILY.test(path) ? stripJsComments(raw) : raw;
  };

  test("only the exact value arms it", () => {
    expect(armedFromEnv({ [NAME]: ARM_ENV_VALUE })).toBe(true);
  });

  test("every neighbouring value leaves it disarmed", () => {
    // A gate that turns itself on by accident is worse than one nobody can
    // turn on — `.claude/rules/config-access.md` on RUNGATE_REQUIRE_AI_REVIEW.
    const disarming = ["", "0", "true", "TRUE", "True", "yes", "on", "2", "01", "11", " 1", "1 "];
    for (const value of disarming) {
      expect(armedFromEnv({ [NAME]: value }), `${JSON.stringify(value)} must not arm`).toBe(false);
    }
    expect(armedFromEnv({}), "an absent variable must not arm").toBe(false);
    expect(armedFromEnv({ [`${NAME}_EXTRA`]: ARM_ENV_VALUE })).toBe(false);
  });

  test("the environment this suite runs in does not arm it", () => {
    // Read of the live environment, because a committed arming is only one of
    // the two ways to be armed and the other one is the shell you are in.
    expect(armedFromEnv()).toBe(false);
  });

  test("the scanner can see every arming form, and no reading form", () => {
    // Without this, "nothing arms it" is satisfied by a detector that detects
    // nothing. Every form is a shape that really does set a variable.
    expect(arms(`${NAME}=1`), "shell assignment").toBe(true);
    expect(arms(`export ${NAME}=1`), "exported shell assignment").toBe(true);
    expect(arms(`  "${NAME}": "1",`), "a JSON env block").toBe(true);
    expect(arms(`  ${NAME}: "1"`), "a YAML env key").toBe(true);
    expect(arms(`process.env.${NAME} = "1";`), "a TS assignment").toBe(true);
    expect(arms(`process.env["${NAME}"] = ARM;`), "a TS computed assignment").toBe(true);

    // And the other direction, which is what stops the scan being red on the
    // decider it is protecting: a read is not an arming.
    expect(arms(`process.env.${NAME} === "1"`), "the legitimate read").toBe(false);
    expect(arms(`if (env.${NAME} !== VALUE) {}`), "a negated read").toBe(false);
    expect(arms(`export const ARM_ENV_VAR = "${NAME}";`), "the declaration").toBe(false);
    expect(arms(`${NAME} is the only switch, and nothing sets it`), "prose").toBe(false);
  });

  test("the scan reads something — the control before the verdict", () => {
    expect(envCapableSources().length).toBeGreaterThan(50);
  });

  test("nothing committed in this repository arms the reaper", () => {
    const offenders = envCapableSources().filter((path) => arms(scannable(path)));
    expect(
      offenders.map((p) => p.slice(ROOT.length + 1)),
      `setting ${NAME} arms the orphan reaper for every session that starts from ` +
        `this checkout, simultaneously, on a machine where peers run suites that ` +
        `take hours (#690). Arming is a deployment decision taken by hand after ` +
        `reading the dry-run log — never a committed one.`,
    ).toEqual([]);
  });

  test("the hook's call site still passes the decider", () => {
    // The rebase failure this repository has hit twice: a clean auto-resolve
    // keeps a new signature and drops the argument from the call site. It
    // compiles, the suite passes, and the reaper is armed by whatever the
    // default is. So the call site is asserted, not just the function.
    const hook = stripJsComments(
      readFileSync(join(ROOT, "hooks/StaleTTLCleanup.hook.ts"), "utf-8"),
    );
    expect(hook).toMatch(/reapOrphans\(\s*\{\s*armed:\s*armedFromEnv\(\)\s*\}\s*\)/);
  });

  test("the variable is read in exactly one place", () => {
    // A separate case and not a second assertion above, because a case that
    // fails at its first expectation never runs its second: the call-site
    // regex and this population have different reddening inputs — restoring
    // the inline comparison reds both, and a second reader elsewhere reds
    // only this one.
    const naming = envCapableSources().filter((path) => scannable(path).includes(NAME));
    expect(
      naming.map((p) => p.slice(ROOT.length + 1)),
      `${NAME} is read in exactly one place. A second reader is a second ` +
        `arming decider — see .claude/rules/checks-must-be-able-to-fail.md on ` +
        `two deciders that agree.`,
    ).toEqual(["lib/orphan-reaper.ts"]);
  });
});
