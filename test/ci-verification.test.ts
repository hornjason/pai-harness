/**
 * Covers SC-1758..SC-1770 (HARNESS-STANDARD.md), #46.
 *
 * A CI gate is the easiest check in this repo to write wrong, because the
 * obvious implementation is one line and it is fail-open:
 *
 *     const passed = !checks.some(c => c.conclusion === "failure")
 *
 * That returns `true` for a commit CI has never heard of, for a commit whose
 * run is still queued, for a run that was skipped, and for a run that belongs
 * to the previous push. Four distinct ways to certify nothing, all of which
 * read as a green gate and none of which are visible in the diff.
 *
 * So the tests are organised around those four, not around the happy path.
 * `readCi` is pure and gets them directly; the subprocess tests then prove the
 * same verdicts survive the wire, the flag parsing and the exit code.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";

import { readCi, waitForCi, type CheckRunSummary, type GitHubClient } from "../lib/github";
import { exitCodeFor, positiveMs } from "../scripts/github-op";

const SHA = "a4e993251f0c2b7d4e6a8c0f1b2d3e4f5a6b7c8d";
const OTHER = "0000111122223333444455556666777788889999";

const check = (over: Partial<CheckRunSummary> = {}): CheckRunSummary => ({
  name: "test",
  status: "completed",
  conclusion: "success",
  headSha: SHA,
  ...over,
});

// ── the four fail-open shapes ────────────────────────────────

describe("#46: a CI verdict that cannot be reached by failing to find a failure", () => {
  test("SC-1758: a commit CI has never reported on is UNMEASURED - never a pass", () => {
    const r = readCi(SHA, []);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.reason).toContain("no check has been recorded");
    expect(r.reason).toContain(SHA);
    // The distinction in words, because the whole defect is that the two are
    // the same value in the obvious implementation.
    expect(r.reason).toContain("not the same as reporting success");
    expect(r.failed).toEqual([]);
  });

  test("SC-1759: checks belonging to another commit are discarded - not counted as this one's", () => {
    // The stale reading. The checks API accepts a branch as `ref` and answers
    // about whatever commit that branch pointed at when CI last ran, so a
    // gate keyed on the branch certifies the previous push — green, plausible,
    // and about code that is not in the PR.
    const r = readCi(SHA, [check({ headSha: OTHER }), check({ name: "gates", headSha: OTHER })]);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.reason).toContain(OTHER);
    expect(r.reason).toContain("this is the stale reading, not a pass");

    // Two passing checks on the wrong commit, which is what the naive version
    // would have reported PASS on.
    expect(r.failed).toEqual([]);

    // A mix keeps only what belongs here, and a single real pending check is
    // enough to hold the verdict back.
    const mixed = readCi(SHA, [check({ headSha: OTHER }), check({ name: "gates", status: "in_progress", conclusion: null })]);
    expect(mixed.verdict).toBe("UNMEASURED");
    expect(mixed.pending).toEqual(["gates"]);
    expect(mixed.checks).toHaveLength(1);
  });

  test("SC-1760: a check still running is UNMEASURED and says which one", () => {
    const r = readCi(SHA, [check(), check({ name: "gates", status: "in_progress", conclusion: null })]);
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.pending).toEqual(["gates"]);
    expect(r.reason).toContain("gates");
    expect(r.reason).toContain("has not finished");
    // And `queued` is pending too — it is a different status string and the
    // same fact.
    expect(readCi(SHA, [check({ status: "queued", conclusion: null })]).pending).toEqual(["test"]);
  });

  test("SC-1761: a skipped or neutral check measured nothing and cannot carry a pass", () => {
    // The most convincing of the four. The run exists, it completed, it did
    // not fail — and "no failures" calls it green.
    const skipped = readCi(SHA, [check({ conclusion: "skipped" })]);
    expect(skipped.verdict).toBe("UNMEASURED");
    expect(skipped.inconclusive).toEqual(["test"]);
    expect(skipped.reason).toContain("neither passed nor failed");

    expect(readCi(SHA, [check({ conclusion: "neutral" })]).verdict).toBe("UNMEASURED");

    // A null conclusion on a completed run is the same fact arriving as a
    // missing field rather than a word.
    expect(readCi(SHA, [check({ conclusion: null })]).verdict).toBe("UNMEASURED");

    // And one skipped check is enough: a green one beside it does not rescue it.
    const mixed = readCi(SHA, [check({ name: "gates" }), check({ conclusion: "skipped" })]);
    expect(mixed.verdict).toBe("UNMEASURED");
    expect(mixed.inconclusive).toEqual(["test"]);
  });
});

// ── the verdicts that are decisive ───────────────────────────

describe("#46: the verdicts that are decisive, and the order between them", () => {
  test("SC-1762: a failure outranks a check still running", () => {
    // More waiting cannot un-fail a check, so reporting UNMEASURED here would
    // turn a known red into "we did not find out" — and the operator would
    // re-run rather than read the failure.
    const r = readCi(SHA, [check({ conclusion: "failure" }), check({ name: "gates", status: "in_progress", conclusion: null })]);
    expect(r.verdict).toBe("FAIL");
    expect(r.failed).toEqual(["test"]);
    expect(r.pending).toEqual(["gates"]);
    expect(r.reason).toContain("CI failed");
  });

  test("SC-1763: every way a run can end badly is a failure - including cancelled", () => {
    for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure", "stale"]) {
      expect(readCi(SHA, [check({ conclusion })]).verdict, `conclusion ${conclusion}`).toBe("FAIL");
    }
    // `cancelled` is the judgement call, and it is recorded as one rather than
    // left to look obvious: a cancellation measured nothing, which argues for
    // UNMEASURED — but on this repo's CI it is nearly always
    // `cancel-in-progress` superseding the run, and calling that "unmeasured"
    // lets a superseded commit's gate pass. FAIL costs a re-run; the other
    // direction costs a bad merge.
    expect(readCi(SHA, [check({ conclusion: "cancelled" })]).verdict).toBe("FAIL");
  });

  test("SC-1764: PASS requires every check present - completed and successful", () => {
    const r = readCi(SHA, [check(), check({ name: "gates" }), check({ name: "GitGuardian Security Checks" })]);
    expect(r.verdict).toBe("PASS");
    expect(r.reason).toContain("all 3 checks passed");
    expect(r.reason).toContain(SHA);
    expect(r.failed).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.inconclusive).toEqual([]);

    // A ref that is not a commit SHA never reaches a verdict at all, because
    // the question "did CI pass on `main`" has no stable answer.
    for (const bad of ["main", "", "fix/46", "HEAD", "not-hex-at-all"]) {
      const r2 = readCi(bad, [check({ headSha: bad })]);
      expect(r2.verdict, `ref ${bad}`).toBe("UNMEASURED");
      expect(r2.reason).toContain("not a commit SHA");
    }
  });
});

// ── the wait ─────────────────────────────────────────────────

describe("#46: a bounded wait that cannot improve the verdict by running out", () => {
  const clientReturning = (pages: CheckRunSummary[][]): { client: GitHubClient; calls: () => number } => {
    let i = 0;
    const client = {
      rest: {
        checks: {
          listForRef: async () => {
            const page = pages[Math.min(i, pages.length - 1)];
            i++;
            return { data: { total_count: page.length, check_runs: page.map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, head_sha: c.headSha })) } };
          },
        },
      },
    } as unknown as GitHubClient;
    return { client, calls: () => i };
  };

  test("SC-1765: polling stops as soon as the answer arrives and reports it", async () => {
    const { client, calls } = clientReturning([
      [],
      [check({ status: "queued", conclusion: null })],
      [check()],
      [check({ conclusion: "failure" })], // never reached — proves it stopped
    ]);
    let slept = 0;
    const r = await waitForCi(client, "o/n", SHA, {
      timeoutMs: 10_000,
      intervalMs: 100,
      sleep: async () => { slept++; },
      now: () => 0, // the clock never advances, so only the verdict can end the loop
    });
    expect(r.verdict).toBe("PASS");
    expect(calls()).toBe(3);
    expect(slept).toBe(2);
  });

  test("SC-1766: running out of time returns UNMEASURED and says the wait is what ran out", async () => {
    const { client, calls } = clientReturning([[check({ name: "gates", status: "in_progress", conclusion: null })]]);
    let t = 0;
    const r = await waitForCi(client, "o/n", SHA, {
      timeoutMs: 300,
      intervalMs: 100,
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(r.verdict).toBe("UNMEASURED");
    expect(r.pending).toEqual(["gates"]);
    // It does not become a pass by giving up, and it does not become a
    // failure either — impatience is not evidence about the code.
    expect(r.reason).toContain("gates");
    expect(r.reason).toContain("statement about the wait and not about the code");
    expect(calls()).toBeGreaterThan(1);

    // A zero timeout is a real request — read once, report what is there —
    // and must not be swallowed and replaced by the default.
    const once = clientReturning([[check({ status: "queued", conclusion: null })]]);
    const r0 = await waitForCi(once.client, "o/n", SHA, { timeoutMs: 0, intervalMs: 100, sleep: async () => {}, now: () => 0 });
    expect(r0.verdict).toBe("UNMEASURED");
    expect(once.calls()).toBe(1);
  });

  test("SC-1767: a decided verdict is never polled again", async () => {
    for (const first of [[check({ conclusion: "failure" })], [check()], [check({ conclusion: "skipped" })]]) {
      const { client, calls } = clientReturning([first]);
      let slept = 0;
      await waitForCi(client, "o/n", SHA, { timeoutMs: 60_000, intervalMs: 10, sleep: async () => { slept++; }, now: () => 0 });
      // A FAIL will not improve, a PASS will not get better, and a skipped
      // check has already finished. Polling any of them is time spent to
      // reach the same answer — and with a frozen clock, a loop that did poll
      // would never return at all.
      expect(calls()).toBe(1);
      expect(slept).toBe(0);
    }
  });
});

// ── over the wire ────────────────────────────────────────────

describe("#46: the verdict survives the wire, the flags and the exit code", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "github-op.ts");
  let server: ReturnType<typeof Bun.serve>;
  let runs: any[] = [];
  let paths: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        paths.push(url.pathname);
        return Response.json({ total_count: runs.length, check_runs: runs });
      },
    });
  });
  afterAll(() => server.stop(true));

  const runOp = async (args: string[]) => {
    const proc = Bun.spawn(["bun", SCRIPT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GITHUB_TOKEN: "test-token", GH_TOKEN: "", GITHUB_API_URL: `http://127.0.0.1:${server.port}` },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  };

  test("SC-1768: ci-status asks about the SHA and reports PASS on stdout with exit zero", async () => {
    runs = [{ name: "test", status: "completed", conclusion: "success", head_sha: SHA }];
    paths = [];
    const { stdout, exitCode } = await runOp(["ci-status", "--repo", "owner/name", "--sha", SHA, "--timeout-ms", "0"]);
    expect(exitCode).toBe(0);
    const reading = JSON.parse(stdout);
    expect(reading.verdict).toBe("PASS");
    expect(reading.sha).toBe(SHA);
    // The request names the commit, not a branch. This is the assertion that
    // makes SC-1759 a property of the deployed path and not only of the pure
    // function behind it.
    expect(paths.some(p => p.includes(`/commits/${SHA}/check-runs`))).toBe(true);
    expect(paths.some(p => /\/commits\/(main|fix)/.test(p))).toBe(false);
  });

  test("SC-1769: a non-PASS verdict exits non-zero and still prints the reading", async () => {
    const cases: Array<[any[], string]> = [
      [[{ name: "test", status: "completed", conclusion: "failure", head_sha: SHA }], "FAIL"],
      [[], "UNMEASURED"],
      [[{ name: "test", status: "completed", conclusion: "skipped", head_sha: SHA }], "UNMEASURED"],
    ];
    for (const [these, verdict] of cases) {
      runs = these;
      const { stdout, exitCode } = await runOp(["ci-status", "--repo", "owner/name", "--sha", SHA, "--timeout-ms", "0"]);
      // Exit non-zero, because a verdict reaching a caller as exit 0 is the
      // fail-open this gate exists to prevent...
      expect(exitCode, verdict).toBe(1);
      // ...and the reading is still on stdout, because a gate that exits
      // non-zero with nothing printed tells the operator only that something
      // went wrong.
      expect(JSON.parse(stdout).verdict).toBe(verdict);
    }

    // The three-way distinction lives in the JSON and nowhere else. FAIL and
    // UNMEASURED share an exit code, so a caller reading only the code has
    // lost the difference between "CI said no" and "CI did not say" — which
    // is why the prompt is told to copy `verdict` rather than derive it.
    expect(exitCodeFor("ci-status", { verdict: "FAIL" })).toBe(exitCodeFor("ci-status", { verdict: "UNMEASURED" }));
    expect(exitCodeFor("ci-status", { verdict: "PASS" })).toBe(0);
    // No other command's exit code changed, including one that has no verdict
    // at all and would read as non-PASS under a rule applied blindly.
    expect(exitCodeFor("pr-upsert", { number: 1 })).toBe(0);
    expect(exitCodeFor("comment", null)).toBe(0);
  });

  test("SC-1770: a malformed duration is refused rather than defaulted", async () => {
    runs = [{ name: "test", status: "completed", conclusion: "success", head_sha: SHA }];
    const { exitCode, stderr } = await runOp(["ci-status", "--repo", "owner/name", "--sha", SHA, "--timeout-ms", "soon"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--timeout-ms must be a non-negative number");

    // Zero is a request, not an absence — the substitution this guards is a
    // falsy check quietly restoring the fifteen-minute default and making a
    // run that asked to read CI once block for a quarter of an hour.
    expect(positiveMs({ "timeout-ms": "0" }, "timeout-ms", 900_000)).toBe(0);
    expect(positiveMs({}, "timeout-ms", 900_000)).toBe(900_000);
    expect(() => positiveMs({ "timeout-ms": "-1" }, "timeout-ms", 900_000)).toThrow(/non-negative/);
  });
});
