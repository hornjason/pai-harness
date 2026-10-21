import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  MIN_ORPHAN_AGE_SECONDS,
  orphanDecision,
  reapOrphans,
  type ReapDecision,
} from "../lib/orphan-reaper";
import { readProcessTable, type ProcessRow } from "../lib/process-table";

/**
 * #690 AC-1 and AC-2, over processes this file spawns (#690).
 *
 * `test/orphan-reaper.test.ts` drives `orphanDecision` over synthetic rows and
 * says so: *"Nothing here spawns or signals a real process."* That is the right
 * shape for the decision logic and it leaves two of #690's criteria unasserted,
 * both of which are about a real process table:
 *
 * - **AC-1** asks for *"a test that plants a running suite owned by a live
 *   session and shows it survives, **not by reading the hook**"*. A synthetic
 *   row carrying `ppid: 4000` proves the comparison; it does not prove that the
 *   `ppid` arriving from `ps -axo pid=,ppid=,etime=,command=` is the one the
 *   comparison reads. Nothing had ever run `readProcessTable` and
 *   `orphanDecision` against each other.
 * - **AC-2** is *"the pattern cannot match the launching shell; a wrapper that
 *   records the exit code still records it after the cleanup runs"* — the half
 *   of the title that reads *"and takes the measuring shell with it"*. The
 *   nearest existing case scans this repository for the string `pkill`, which
 *   is a proxy for the property and not the property: it would stay green over
 *   a pid-based reaper that signalled the wrapper's pid.
 *
 * ## Why a measuring wrapper is not the same process as the orphan
 *
 * In the 2026-10-19 incident one shell launched a suite and waited to record
 * its exit code, and `pkill -f` matched both because `-f` matches the whole
 * command line. Reconstructing that needs three processes and not two, because
 * a wrapper that is *waiting* for its child is by definition a live parent:
 *
 * | role | shape | what it is for |
 * |---|---|---|
 * | `M` | `/bin/sh -c '(<runner> test …); echo EXIT=$? > log'` | the measuring shell. Its command line CONTAINS the suite's, so a pattern kill takes it |
 * | `S` | `<runner> test --measured`, child of `M` | a suite with a live owner — AC-1 |
 * | `C` | `<runner> test --orphan`, reparented to pid 1 | a genuine orphan — the negative control |
 *
 * A reaper that signals `C` and leaves `M` and `S` alone is AC-1 and AC-2 at
 * once, and the evidence that `M` survived is `M`'s own exit line, written
 * after the reap — the artefact whose absence was the whole of #690.
 *
 * ## Safety, because five suites belong to other people on this machine
 *
 * Four independent constraints, in the order they would have to fail:
 *
 * 1. **The armed arm never sees a foreign row.** It is driven over a real
 *    reading NARROWED to pids this file spawned. The dry-run arm reads the
 *    whole machine and signals nothing, which is what makes the narrowing
 *    affordable.
 * 2. **The injected `kill` refuses any pid outside the spawned set**, and the
 *    refusal is itself asserted never to happen. A decision defect cannot
 *    reach a stranger's process; it reds the case instead.
 *
 *    **"Spawned" is defined without consulting the process table**, and that
 *    sentence is here because the first draft of this file did consult it and
 *    killed its own test runner. The suite's pid is found by looking for the
 *    wrapper's child, so under the `parseProcessTable` mutation that swaps the
 *    pid and ppid columns the row that matched was the WRAPPER's, carrying
 *    bun's pid in the pid field — and cleanup duly SIGKILLed the suite,
 *    exit 137, no summary line, which is #690's own artefact produced by
 *    #690's own regression test. A reading taken with the instrument under
 *    test cannot be the thing that authorises a signal. So every owned pid
 *    is either returned by this file's own `spawn`/`$!`, or comes off a row
 *    whose argv[0] IS this plantation's `mkdtemp` runner path, and `own`
 *    refuses this process's pid outright.
 * 3. **The planted processes are `unknown` to every other reader.** `runner`
 *    is a symlink to `/bin/sleep`, so the production `classifyPsLine`
 *    resolves argv[0] to a basename that is not `bun` and declines to call it
 *    a suite. Only this file's injected `ExecutableResolver` — the seam
 *    `lib/test-suite-lock.ts` already exports for exactly this — reads it as
 *    one. A peer's `anySuiteRunning` therefore keeps slots rather than seeing
 *    a phantom suite, and a peer's reaper, if anyone ever arms one, spares
 *    these rows by the `UNCLASSIFIED` reason.
 * 4. **The names carry no `bun`.** `SPELLED_BUN` would classify
 *    `…/bun test …` with no resolution at all, so the runner is spelled
 *    `rg690runner` — r-u-n-n-e-r, which contains no `bun` substring, the same
 *    arithmetic #727 recorded about `brun`.
 *
 * ## The cheapest wrong fix, named before the cases
 *
 * **Spare the wrapper by excluding `/bin/sh` from the reap.** It makes AC-2's
 * symptom go away — the exit line comes back — and leaves a reaper that still
 * kills live suites, because `S` is not a shell. Do these cases survive it?
 * **Yes, non-vacuously:** AC-1 asserts `S` is spared for `LIVE_PARENT`, and an
 * argv[0] exclusion does not give `S` a parent. The second cheapest is to
 * signal nothing at all, which AC-2's `C` assertion is the control against.
 */

/** `/bin/sleep`, under a name that contains no `bun`. */
const RUNNER_NAME = "rg690runner";

/** What the injected resolver claims `runner` points at. */
const BUN_IDENTITY = "/opt/homebrew/Cellar/bun/1.3.14/bin/bun";

/**
 * Seconds `S` runs for.
 *
 * Long enough that it is still in the table when the reap is judged — if it
 * exited first the case would observe "the suite was not signalled" about a
 * process that was not there, which is the vacuous shape — and short enough
 * that the wrapper's exit line arrives inside the case's own wait.
 */
const MEASURED_SECONDS = 8;

/** How long a planted process is waited for before the case gives up. */
const APPEAR_TIMEOUT_MS = 4_000;

const sleepFor = (seconds: number) => spawnSync("/bin/sleep", [String(seconds)]);

/**
 * Processes this file spawned, the directory they live in, and nothing else.
 *
 * Every pid the armed arm is allowed to signal comes from `owned`, and the
 * set is written only by the spawn helpers.
 */
class Plantation {
  readonly dir = mkdtempSync(join(tmpdir(), "rg690-live-"));
  readonly runner = join(this.dir, RUNNER_NAME);
  readonly owned = new Set<number>();
  private readonly children: ChildProcess[] = [];

  constructor() {
    symlinkSync("/bin/sleep", this.runner);
  }

  /**
   * Record a pid as this file's to signal, or refuse it.
   *
   * The only gate between a misread process table and a SIGKILL sent to
   * something nobody asked about. It refuses this process outright, because
   * a derivation that goes wrong lands here first.
   */
  private own(pid: number, how: string): number {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`${how}: implausible pid ${pid}`);
    if (pid === process.pid) throw new Error(`${how}: that pid is this test process`);
    this.owned.add(pid);
    return pid;
  }

  /** argv[0] resolves to bun for THIS plantation's runner and nothing else. */
  readonly resolveExecutable = (path: string): string =>
    path === this.runner ? BUN_IDENTITY : realpathSync(path);

  /** The substring `pkill -f` would have been given: shared by all three rows. */
  get patternNeedle(): string {
    return `${this.runner} test`;
  }

  get exitLog(): string {
    return join(this.dir, "exit.log");
  }

  /**
   * `M`, a shell that runs `S` and records its exit code, and `S` itself.
   *
   * `( exec -a … )` forks a subshell and replaces it, so `S` is a direct child
   * of `M` with an argv `M` chose — a real process whose command line is a
   * suite invocation, without a suite having been started.
   */
  plantMeasuredPair(): { measurer: number; suite: number } {
    const script =
      `( exec -a '${this.runner} test --measured' /bin/sleep ${MEASURED_SECONDS} ); ` +
      `echo "EXIT=$?" > '${this.exitLog}'`;
    const child = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
    this.children.push(child);
    const measurer = this.own(child.pid ?? 0, "the measuring shell");
    // argv[0] must BE the runner, not merely contain it: the wrapper's own
    // command line contains the runner path too, and a table misread as pid
    // and ppid transposed matches the wrapper on `ppid === measurer`.
    const row = this.awaitRow((r) => r.ppid === measurer && r.command.startsWith(this.runner));
    const suite = this.own(row.pid, "the planted suite");
    return { measurer, suite };
  }

  /**
   * `C`, reparented to pid 1 for real: the shell that spawns it exits at once,
   * and the kernel hands its child to init.
   */
  plantOrphan(): number {
    const pidFile = join(this.dir, "orphan.pid");
    const r = spawnSync("/bin/sh", [
      "-c",
      `( exec -a '${this.runner} test --orphan' /bin/sleep 120 ) & echo $! > '${pidFile}'`,
    ]);
    if (r.status !== 0) throw new Error(`the orphan launcher exited ${r.status}`);
    // `$!` is written by a shell this file started, so it is a spawn record
    // and not a reading. The table is then consulted only to WAIT for the
    // reparenting, never to decide which pid is ours.
    const pid = this.own(Number(readFileSync(pidFile, "utf-8").trim()), "the planted orphan");
    this.awaitRow(
      (row) => row.pid === pid && row.ppid === 1 && row.command.startsWith(this.runner),
    );
    return pid;
  }

  /** A real row matching `want`, or a throw naming what never appeared. */
  awaitRow(want: (row: ProcessRow) => boolean): ProcessRow {
    const deadline = Date.now() + APPEAR_TIMEOUT_MS;
    for (;;) {
      const found = readProcessTable().find(want);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("a planted process never appeared in ps");
      sleepFor(0.05);
    }
  }

  alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Every pid here was spawned by this object. Nothing else is signalled. */
  cleanup(): void {
    // A sweep as well as the set, because a case that threw between spawning
    // a process and recording it would otherwise leak a `sleep` that outlives
    // the run — measured: a failed `awaitRow` left one behind every time.
    // The predicate is argv[0] EQUAL to this plantation's `mkdtemp` runner
    // path, which no process on the machine but ours can have, so this is a
    // sweep over a name we created rather than over a pattern.
    try {
      for (const r of readProcessTable()) {
        if (r.command.startsWith(this.runner)) this.owned.add(r.pid);
      }
    } catch {
      // An unreadable table leaves the recorded set, which is the floor.
    }
    for (const pid of this.owned) {
      if (pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone, which is the expected state for the orphan.
      }
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let plantation: Plantation | null = null;
const plant = (): Plantation => (plantation = new Plantation());

afterEach(() => {
  plantation?.cleanup();
  plantation = null;
});

const decisionFor = (decisions: ReapDecision[], pid: number): ReapDecision => {
  const found = decisions.find((d) => d.pid === pid);
  if (!found) throw new Error(`pid ${pid} is absent from the reading — the case is vacuous`);
  return found;
};

describe("#690 AC-1: a planted suite with a live owner survives a real reading", () => {
  test(
    "the whole machine is read through ps, and the live-parent suite is spared",
    () => {
      const p = plant();
      const { measurer, suite } = p.plantMeasuredPair();
      const orphan = p.plantOrphan();

      // No `rows`, no `readRows`: the production reader runs `ps` for real.
      const report = reapOrphans({ resolveExecutable: p.resolveExecutable });

      // Controls first. A reading that cannot see the planted processes would
      // satisfy every assertion below by having nothing to say about them.
      expect(report.reading).toBe("MEASURED");
      expect(report.examined).toBeGreaterThan(10);
      const live = decisionFor(report.decisions, suite);
      const dead = decisionFor(report.decisions, orphan);

      // AC-1: the ppid came off the real table, and it is the wrapper's.
      expect(live.ppid).toBe(measurer);
      expect(live.conditions.suite).toBe("suite");
      expect(live.conditions.parentGone).toBe(false);
      expect(live.reason).toBe("LIVE_PARENT");
      expect(live.reap).toBe(false);

      // The negative control, from the same reading: a process that really is
      // reparented to init reads as parentless, so `parentGone` is measuring
      // something. Without this, `false` above could be a constant.
      expect(dead.conditions.parentGone).toBe(true);

      // AC-3 against a real clock rather than a field: the orphan is seconds
      // old, so the production floor spares it and says which condition did it.
      expect(dead.ageSeconds).toBeLessThan(MIN_ORPHAN_AGE_SECONDS);
      expect(dead.reason).toBe("TOO_YOUNG");
      expect(dead.reap).toBe(false);

      // A dry run signals nothing, whatever it decided.
      expect(report.armed).toBe(false);
      expect(report.signalled).toEqual([]);
      expect(p.alive(suite)).toBe(true);
      expect(p.alive(measurer)).toBe(true);
    },
    20_000,
  );

  test(
    "the planted rows are invisible as suites to every reader but this one",
    () => {
      const p = plant();
      const { suite } = p.plantMeasuredPair();

      // Safety property 3, executed rather than promised: with the PRODUCTION
      // resolver the same row is `unknown`, so nothing else on this machine
      // reads these processes as a running suite while they live.
      const ambient = reapOrphans();
      expect(decisionFor(ambient.decisions, suite).conditions.suite).toBe("unknown");
      expect(decisionFor(ambient.decisions, suite).reason).toBe("UNCLASSIFIED");
    },
    20_000,
  );
});

describe("#690: the spawn-ownership guard this file's armed arm rests on", () => {
  test("a pid this file did not spawn is refused, and the refusal is observable", () => {
    const p = plant();
    // `expect(foreign).toEqual([])` in the armed case below is only evidence
    // if `foreign` can be non-empty. A guard can be unreachable without being
    // absent, so this drives it with a row that meets every reap condition
    // and is not ours. The pid is above macOS's pid ceiling, so no process
    // has it and nothing could be signalled even if the guard were deleted.
    const stranger: ProcessRow = {
      pid: 999_999,
      ppid: 1,
      elapsedSeconds: MIN_ORPHAN_AGE_SECONDS + 1,
      command: `${p.runner} test --not-ours`,
    };
    const foreign: number[] = [];
    const signalled: number[] = [];
    const kill = (pid: number) => {
      if (!p.owned.has(pid)) {
        foreign.push(pid);
        return;
      }
      signalled.push(pid);
    };

    const report = reapOrphans({
      rows: [stranger],
      readRows: () => [],
      protectedPids: new Set([process.pid]),
      resolveExecutable: p.resolveExecutable,
      kill,
      armed: true,
    });

    // The decision says reap — so the guard, not the decision, is what spares
    // it. A case whose stranger was spared by the reaper would prove nothing.
    expect(decisionFor(report.decisions, 999_999).reason).toBe("ORPHANED");
    expect(foreign).toEqual([999_999]);
    expect(signalled).toEqual([]);
  });
});

describe("#690 AC-2: the measuring shell survives, and still records the exit code", () => {
  test(
    "an armed reap signals the orphan by pid; the wrapper writes its exit line after",
    () => {
      const p = plant();
      const { measurer, suite } = p.plantMeasuredPair();
      const orphan = p.plantOrphan();

      const table = readProcessTable();
      const mine = table.filter((r) => p.owned.has(r.pid));
      // The control for the narrowing: all three roles are in the reading
      // being judged. Two of three would make "only the orphan died" cheap.
      expect(mine.map((r) => r.pid).sort()).toEqual([measurer, suite, orphan].sort());

      const mRow = mine.find((r) => r.pid === measurer)!;
      const sRow = mine.find((r) => r.pid === suite)!;
      const cRow = mine.find((r) => r.pid === orphan)!;

      // What the old hook was given. `pkill -f` matches the FULL command line,
      // so the one substring shared by the suite and its launcher takes both.
      expect(mRow.command).toContain(p.patternNeedle);
      expect(sRow.command).toContain(p.patternNeedle);
      expect(cRow.command).toContain(p.patternNeedle);

      // The wrapper is not a suite: argv[0] is the shell, whatever follows it.
      expect(
        orphanDecision(mRow, { resolveExecutable: p.resolveExecutable }).reason,
      ).toBe("NOT_A_SUITE");

      const signalled: Array<{ pid: number; signal: string }> = [];
      const foreign: number[] = [];
      const kill = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
        // The last line of defence, and it is a measurement too: a pid this
        // file did not spawn is recorded and NOT signalled, so a decision
        // defect reds the case instead of reaching a peer's suite.
        if (!p.owned.has(pid)) {
          foreign.push(pid);
          return;
        }
        signalled.push({ pid, signal });
        process.kill(pid, signal);
      };

      const report = reapOrphans({
        rows: mine,
        readRows: () => readProcessTable().filter((r) => p.owned.has(r.pid)),
        protectedPids: new Set([process.pid]),
        resolveExecutable: p.resolveExecutable,
        minAgeSeconds: 0,
        settle: () => sleepFor(0.3),
        kill,
        armed: true,
      });

      expect(foreign).toEqual([]);
      expect(report.armed).toBe(true);
      // Exactly one process was signalled, and it is the one with no owner.
      expect([...new Set(signalled.map((s) => s.pid))]).toEqual([orphan]);
      expect(signalled[0]?.signal).toBe("SIGTERM");
      expect(decisionFor(report.decisions, orphan).reason).toBe("ORPHANED");
      expect(decisionFor(report.decisions, suite).reason).toBe("LIVE_PARENT");

      // AC-2, the property itself: the measuring shell is still there.
      expect(p.alive(measurer)).toBe(true);
      expect(p.alive(suite)).toBe(true);

      // …and still measuring. The artefact #690 destroyed was the exit line;
      // this waits for it rather than for the process, because a wrapper that
      // survived the signal and died before writing would pass a liveness
      // check and leave the same truncated log.
      const deadline = Date.now() + 15_000;
      while (!existsSync(p.exitLog) && Date.now() < deadline) sleepFor(0.1);
      expect(existsSync(p.exitLog)).toBe(true);
      // EXIT=0, not EXIT=143: `S` was never signalled either, so the wrapper
      // records the run's real outcome and not the reaper's.
      expect(readFileSync(p.exitLog, "utf-8").trim()).toBe("EXIT=0");
    },
    40_000,
  );
});
