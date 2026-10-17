/**
 * Covers SC-1922..SC-1925 (HARNESS-STANDARD.md), #510.
 *
 * DIR-L29 rations full-suite runs to 8 per 30 minutes, and it charged a
 * reviewer's `/tmp` probe at the same rate as this repository's own suite.
 * Measured during the security review of PR #500: sec-500 hit 8/8 running
 * mutation probes on `git archive` exports, having never once run the real
 * suite to completion, and reported two findings as explicitly unmeasured
 * because of it.
 *
 * The incentive was backwards — the more carefully someone reviewed, the
 * less they were allowed to measure — and the error is treating a
 * twenty-test probe and a 400-second 12,000-test run as one unit.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DEFAULT_MAX_RUNS_PER_WORKER,
  deriveWorkerId,
  evaluateFullSuiteRequest,
  runScope,
  scratchRunsPath,
} from "../lib/test-suite-lock";

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const HOOK = join(REPO_ROOT, "hooks", "TestSuiteGuard.hook.ts");
const FULL = "bun test";

const scratch: string[] = [];
const worktrees: string[] = [];
afterAll(() => {
  for (const w of worktrees) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", w], { cwd: REPO_ROOT, timeout: 60_000 });
    } catch {
      rmSync(w, { recursive: true, force: true });
    }
  }
  for (const s of scratch) rmSync(s, { recursive: true, force: true });
});

let lockDir = "";
afterEach(() => {
  if (lockDir !== "") rmSync(lockDir, { recursive: true, force: true });
  lockDir = "";
});

function freshLockDir(): string {
  lockDir = mkdtempSync(join(tmpdir(), "rg-510-lock-"));
  return lockDir;
}

/** A real directory with no `.git` — what `git archive | tar -x` leaves. */
function exportedTree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rg-510-export-")));
  scratch.push(dir);
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "probe.test.ts"), "// a twenty-test probe\n");
  return dir;
}

function base(dir: string): Parameters<typeof evaluateFullSuiteRequest>[2] {
  return {
    lockDir: dir,
    // The concurrency slot is a separate guard and is not what this file is
    // about; without this the real process table decides whether cases pass.
    suitesRunning: () => false,
    // …and nothing here releases a slot, so the default capacity would
    // refuse the third run for a reason that has nothing to do with the
    // budget. The two-concurrent-suites cap is tested in
    // test/test-suite-lock.test.ts, where it is the subject.
    capacity: 99,
  };
}

describe("#510: the budget belongs to this repository's suite, not to every suite", () => {
  test("SC-1922: thirty probes on an exported tree spend nothing", () => {
    const dir = freshLockDir();
    const probe = exportedTree();

    for (let i = 0; i < 30; i++) {
      const decision = evaluateFullSuiteRequest("reviewer", FULL, { ...base(dir), cwd: probe });
      expect(decision.allow, `probe ${i + 1} of 30 was refused`).toBe(true);
      expect(decision.exempt, "the exemption is silent").toBeDefined();
    }

    // The instrument: after thirty exempted runs the worker's budget is
    // untouched, so a real suite is still allowed its full allowance. A
    // version that merely raised the ceiling would pass every assertion
    // above and fail this one.
    const real = evaluateFullSuiteRequest("reviewer", FULL, { ...base(dir), cwd: REPO_ROOT });
    expect(real.allow).toBe(true);
    expect(real.exempt, "a run of this repository was exempted").toBeUndefined();
  });

  test("SC-1923: a run of this repository is still charged, and the budget still refuses", () => {
    const dir = freshLockDir();
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_WORKER; i++) {
      const d = evaluateFullSuiteRequest("worker-a", FULL, {
        ...base(dir),
        cwd: REPO_ROOT,
        workerId: "worker-a",
      });
      expect(d.allow, `the repo's own run ${i + 1} was refused early`).toBe(true);
      expect(d.exempt).toBeUndefined();
    }
    const over = evaluateFullSuiteRequest("worker-a", FULL, {
      ...base(dir),
      cwd: REPO_ROOT,
      workerId: "worker-a",
    });
    expect(over.allow, "the budget stopped being able to refuse anything").toBe(false);
    expect(over.reason).toContain("DIR-L29");

    // …and the exemption does not reopen it: a scratch run after the budget
    // is spent is allowed, and the repository's own next run is still not.
    const probe = evaluateFullSuiteRequest("worker-a", FULL, {
      ...base(dir),
      cwd: exportedTree(),
      workerId: "worker-a",
    });
    expect(probe.allow).toBe(true);
    expect(
      evaluateFullSuiteRequest("worker-a", FULL, { ...base(dir), cwd: REPO_ROOT, workerId: "worker-a" }).allow,
      "an exempted run cleared the budget it was never charged to",
    ).toBe(false);
  });

  test("SC-1924: scope is the shared git directory, not a path prefix", () => {
    // A denylist on /tmp would be a detector narrower than what it detects:
    // it exempts a real checkout that happens to live there and charges a
    // probe that lives anywhere else. So a WORKTREE OF THIS REPOSITORY,
    // created under the same /tmp a probe would use, must still be charged.
    const wt = join(realpathSync(tmpdir()), `rg-510-wt-${process.pid}`);
    execFileSync("git", ["worktree", "add", "--no-checkout", "--detach", wt], {
      cwd: REPO_ROOT,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worktrees.push(wt);
    expect(runScope(wt), "a worktree of this repository was treated as scratch").toBe("project");
    expect(wt.startsWith(realpathSync(tmpdir())), "the fixture is not under tmp, so it proves nothing").toBe(true);

    // A repository of its own is scratch even though it IS a git repository,
    // which a "has a .git" test would get wrong in the other direction.
    const own = realpathSync(mkdtempSync(join(tmpdir(), "rg-510-own-")));
    scratch.push(own);
    execFileSync("git", ["init", "-q", own], { timeout: 60_000 });
    expect(runScope(own)).toBe("scratch");

    // No git at all — the `git archive` export that filed this issue.
    expect(runScope(exportedTree())).toBe("scratch");

    // "I looked and it is not this repository" and "I could not look" are
    // different facts, and only the first may be exempt. A path that is not
    // there is charged.
    expect(runScope(undefined)).toBe("unknown");
    expect(runScope(join(own, "no", "such", "dir"))).toBe("unknown");
    expect(runScope(REPO_ROOT)).toBe("project");

    const dir = freshLockDir();
    expect(
      evaluateFullSuiteRequest("s", FULL, { ...base(dir), cwd: join(own, "no", "such", "dir") }).exempt,
      "an unanswerable scope was exempted rather than charged",
    ).toBeUndefined();
  });

  test("SC-1925: the exemption is recorded, and the HOOK is what passes the cwd", () => {
    const dir = freshLockDir();
    const probe = exportedTree();
    evaluateFullSuiteRequest("reviewer", FULL, { ...base(dir), cwd: probe });

    // Allowed-and-quiet would make an exemption indistinguishable from a
    // budget nobody spent.
    const recorded = JSON.parse(readFileSync(scratchRunsPath(dir), "utf-8"));
    expect(recorded.runs.map((r: { cwd: string }) => r.cwd)).toContain(probe);

    // Everything above drives the library, and all of it stays green when
    // the hook stops passing `cwd` — the one call site that makes the fix
    // real. #194 SC-642 learned this about `runId`; the same hole is here.
    //
    // One spawn, not eleven: the budget is spent through the library under
    // the identity the hook will derive, so only the hook's own cwd can
    // decide what happens next.
    const hookDir = freshLockDir();
    const sessionId = "hook-510";
    const workerId = deriveWorkerId(sessionId, probe);
    for (let i = 0; i < DEFAULT_MAX_RUNS_PER_WORKER; i++) {
      // Charged deliberately, by claiming the cwd is this repository, so the
      // worker arrives at the hook with nothing left to spend.
      evaluateFullSuiteRequest(sessionId, FULL, {
        ...base(hookDir),
        cwd: REPO_ROOT,
        workerId,
      });
    }
    expect(
      evaluateFullSuiteRequest(sessionId, FULL, { ...base(hookDir), cwd: REPO_ROOT, workerId }).allow,
      "the budget was not actually spent, so the hook below is asked nothing",
    ).toBe(false);

    const p = Bun.spawnSync(["bun", HOOK], {
      stdin: Buffer.from(
        JSON.stringify({ tool_name: "Bash", session_id: sessionId, cwd: probe, tool_input: { command: FULL } }),
      ),
      env: { ...process.env, RUNGATE_LOCK_DIR: hookDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(p.stdout);
    expect(out, "the hook blocked a scratch run against a spent budget").not.toContain("block");
    expect(
      JSON.parse(readFileSync(scratchRunsPath(hookDir), "utf-8")).runs.map((r: { cwd: string }) => r.cwd),
      "the hook never reached the scope decision, so it passed no cwd",
    ).toContain(probe);
  }, 30_000);
});
