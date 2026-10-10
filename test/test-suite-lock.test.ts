import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Design Decisions

import {
  acquireFullSuiteSlot,
  counterKey,
  deriveWorkerId,
  evaluateFullSuiteRequest,
  heldSlots,
  isFullSuiteCommand,
  releaseFullSuiteSlot,
  wouldAllowFullSuite,
} from "../lib/test-suite-lock";

/**
 * Issue #67 — cross-session concurrency guard for the full test suite.
 *
 * CLAUDE.md requires a full `bun test` before implementation work, and
 * TestSuiteGuard caps that per session. Nothing capped it ACROSS sessions, so N
 * open sessions meant N simultaneous 5.4 GB suites, which exhausted the VM
 * compressor and rebooted the machine at 16:22 on 2026-10-05.
 *
 * Capacity is 2, from measurement on this machine (session jhorn-8e): one full
 * suite peaks at 5,360 MB / 33 processes; one is comfortably safe, two is fine,
 * four-plus is the cliff once an editor and containers are also resident.
 *
 * Slots are explicit files rather than a `pgrep` count: the agentgrit suite
 * leaks ~31 dangling bun processes per run, so a process count cannot tell a
 * live suite from residue.
 */

let dir: string;

const opts = (extra: Record<string, unknown> = {}) => ({
  lockDir: dir,
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suite-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isFullSuiteCommand — AC-3: targeted runs are never guarded", () => {
  const full = [
    "bun test",
    "  bun test  ",
    "bun test 2>&1 | tail -12",
    "bun test --coverage",
    "cd /Users/jhorn/Projects/rungate && bun test",
  ];
  const targeted = [
    "bun test test/foo.test.ts",
    "bun test test/unit/bar.test.ts test/baz.test.ts",
    "bun test gates/workflow.test.ts 2>&1 | tail -5",
    "bun run build",
    "bunx tsc --noEmit",
    "git commit -m 'bun test'",
  ];

  for (const cmd of full) {
    test(`treats as full suite: ${cmd.trim()}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(true);
    });
  }

  for (const cmd of targeted) {
    test(`does not guard: ${cmd}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(false);
    });
  }
});

describe("AC-1: concurrent full suites are capped at the measured safe limit", () => {
  test("two sessions may hold slots, a third is refused", () => {
    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);
    expect(acquireFullSuiteSlot("session-b", opts()).ok).toBe(true);

    const third = acquireFullSuiteSlot("session-c", opts());
    expect(third.ok).toBe(false);
    expect(heldSlots(dir).map((h) => h.sessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  test("AC-5: refusal names the holders and how long they have run", () => {
    acquireFullSuiteSlot("session-a", opts({ now: 1_000_000 }));
    acquireFullSuiteSlot("session-b", opts({ now: 1_000_000 + 10_000 }));

    const third = acquireFullSuiteSlot(
      "session-c",
      opts({ now: 1_000_000 + 45_000 }),
    );

    expect(third.ok).toBe(false);
    expect(third.holders?.map((h) => h.sessionId).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
    // Oldest holder has been running 45s.
    expect(Math.max(...third.holders!.map((h) => h.ageSeconds))).toBe(45);
  });

  test("a session's second concurrent suite takes its own slot (#67-B)", () => {
    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);

    // One slot is one RUNNING SUITE, not one session. A backgrounded run plus a
    // foreground one is two live suites, so it must cost two slots — not one
    // (the original re-entrant bug, three suites on a cap of two) and not a
    // refusal (the over-correction, which failed legitimate second runs).
    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);
    expect(heldSlots(dir)).toHaveLength(2);

    // Capacity is still 2 suites total, whoever is running them.
    expect(acquireFullSuiteSlot("session-b", opts()).ok).toBe(false);
  });

  test("two agents sharing a parent session id are not falsely refused (#67-B)", () => {
    // Subagent Bash calls surface under the PARENT session id — jhorn-8e found
    // all 292 transcript records in a live run carrying the parent's id, with
    // agent identity in a separate agentId field. Keying ownership on the
    // session meant Quinn's mandatory suite was blocked by Marcus's slot and
    // the pipeline reported it as a test failure rather than a lock collision.
    expect(evaluateFullSuiteRequest("parent", "bun test", opts()).allow).toBe(
      true,
    );
    expect(evaluateFullSuiteRequest("parent", "bun test", opts()).allow).toBe(
      true,
    );
    expect(heldSlots(dir)).toHaveLength(2);
  });

  test("three concurrent suites are unreachable, however they are spread (#67 review, HIGH)", () => {
    // The invariant is about SUITES, not sessions: no distribution of requests
    // across session ids may put more than `capacity` suites in flight.
    expect(evaluateFullSuiteRequest("A", "bun test", opts()).allow).toBe(true);
    expect(evaluateFullSuiteRequest("B", "bun test", opts()).allow).toBe(true);
    // A third live suite — previously reachable via re-entrancy, 3 x 5.4 GB.
    expect(evaluateFullSuiteRequest("A", "bun test", opts()).allow).toBe(false);
    expect(evaluateFullSuiteRequest("C", "bun test", opts()).allow).toBe(false);
    expect(heldSlots(dir)).toHaveLength(2);
  });

  test("two suites in one session still exclude everyone else (#67-B)", () => {
    expect(evaluateFullSuiteRequest("solo", "bun test", opts()).allow).toBe(
      true,
    );
    expect(evaluateFullSuiteRequest("solo", "bun test", opts()).allow).toBe(
      true,
    );
    // Allowing a session two slots must not be a route to extra capacity.
    expect(evaluateFullSuiteRequest("other", "bun test", opts()).allow).toBe(
      false,
    );
    expect(heldSlots(dir)).toHaveLength(2);
  });

  test("a session releases, then may run again", () => {
    acquireFullSuiteSlot("session-a", opts());
    releaseFullSuiteSlot("session-a", opts());
    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);
  });

  test("capacity is configurable for callers that measure differently", () => {
    expect(acquireFullSuiteSlot("a", opts({ capacity: 1 })).ok).toBe(true);
    expect(acquireFullSuiteSlot("b", opts({ capacity: 1 })).ok).toBe(false);
  });
});

describe("AC-2: stale slots never deadlock the repo", () => {
  test("slots older than the TTL are reclaimed", () => {
    acquireFullSuiteSlot("dead-a", opts({ now: 0 }));
    acquireFullSuiteSlot("dead-b", opts({ now: 0 }));

    // 500s later — past the 420s default TTL.
    const result = acquireFullSuiteSlot("session-c", opts({ now: 500_000 }));

    expect(result.ok).toBe(true);
    expect(heldSlots(dir, 500_000).map((h) => h.sessionId)).toContain(
      "session-c",
    );
  });

  test("slots inside the TTL are still honoured", () => {
    acquireFullSuiteSlot("live-a", opts({ now: 0 }));
    acquireFullSuiteSlot("live-b", opts({ now: 0 }));

    // 400s — inside the 420s TTL.
    expect(acquireFullSuiteSlot("session-c", opts({ now: 400_000 })).ok).toBe(
      false,
    );
  });

  test("a corrupt slot file is reclaimed rather than treated as live", () => {
    writeFileSync(join(dir, "full-suite.slot-0.lock"), "{ not json");
    writeFileSync(join(dir, "full-suite.slot-1.lock"), "{ not json");

    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);
  });

  test("an unusable lock directory fails open rather than blocking work", () => {
    const result = acquireFullSuiteSlot("session-a", {
      lockDir: "/nonexistent-dir-xyz/nested",
    });
    // Never block a suite because the guard itself is broken.
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
  });
});

describe("evaluateFullSuiteRequest — the gate the hook calls", () => {
  test("AC-3: targeted runs are allowed without touching any slot", () => {
    const d = evaluateFullSuiteRequest(
      "s1",
      "bun test test/foo.test.ts",
      opts(),
    );
    expect(d.allow).toBe(true);
    expect(heldSlots(dir)).toHaveLength(0);
  });

  test("AC-4: the per-session cap still blocks a third run", () => {
    expect(evaluateFullSuiteRequest("s1", "bun test", opts()).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", opts()).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());

    const third = evaluateFullSuiteRequest("s1", "bun test", opts());
    expect(third.allow).toBe(false);
    expect(third.reason).toContain("DIR-L29");
  });

  test("AC-1: a third concurrent session is refused", () => {
    expect(evaluateFullSuiteRequest("s1", "bun test", opts()).allow).toBe(true);
    expect(evaluateFullSuiteRequest("s2", "bun test", opts()).allow).toBe(true);

    const third = evaluateFullSuiteRequest("s3", "bun test", opts());
    expect(third.allow).toBe(false);
    expect(third.reason).toContain("already running");
  });

  test("AC-5: the refusal names the holders", () => {
    evaluateFullSuiteRequest("alpha", "bun test", opts());
    evaluateFullSuiteRequest("beta", "bun test", opts());

    const { reason } = evaluateFullSuiteRequest("gamma", "bun test", opts());
    expect(reason).toContain("alpha");
    expect(reason).toContain("beta");
  });

  test("a run refused for concurrency does not burn the session budget", () => {
    evaluateFullSuiteRequest("s1", "bun test", opts());
    evaluateFullSuiteRequest("s2", "bun test", opts());

    // s3 is refused twice for concurrency...
    expect(evaluateFullSuiteRequest("s3", "bun test", opts()).allow).toBe(false);
    expect(evaluateFullSuiteRequest("s3", "bun test", opts()).allow).toBe(false);

    // ...so once a slot frees up it still has its full budget.
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s3", "bun test", opts()).allow).toBe(true);
  });

  test("refusals are never silent — a blocked run always carries a reason", () => {
    evaluateFullSuiteRequest("s1", "bun test", opts());
    evaluateFullSuiteRequest("s2", "bun test", opts());

    const blocked = evaluateFullSuiteRequest("s3", "bun test", opts());
    expect(blocked.allow).toBe(false);
    expect(blocked.reason && blocked.reason.length).toBeGreaterThan(0);
  });
});

/**
 * Issue #73 — the DIR-L29 budget was a monotonic per-session counter. Nothing
 * decremented it and nothing expired it, so a session that had run two suites
 * was locked out of the suite for the rest of its life.
 *
 * That is worse than it sounds, because subagent Bash calls reach PreToolUse
 * carrying the PARENT session's id. One budget covers the DA and every agent it
 * spawns, so a ship pipeline exhausted all 2 runs partway through and every
 * later agent was refused with a message that read like a policy violation
 * rather than an exhausted shared counter. Measured 2026-10-05: three sessions
 * pinned at 2/2, two of them for hours, with the #65 pipeline failing behind it.
 *
 * The fix keeps the rule's intent — do not thrash a 190s / 5.4 GB suite — by
 * making the budget a rolling window instead of a session-lifetime total. You
 * still cannot run it three times back to back; you are no longer locked out
 * permanently for having done so once.
 */
describe("#73: the full-suite budget is a rolling window, not a lifetime total", () => {
  const MINUTE = 60_000;
  const t0 = 1_700_000_000_000;

  // `now` is injected rather than read from the clock so the window is tested
  // in milliseconds instead of by sleeping for half an hour.
  const at = (ms: number, extra: Record<string, unknown> = {}) =>
    opts({ now: t0 + ms, ...extra });

  test("AC-1: a third run inside the window is still refused (DIR-L29 intact)", () => {
    expect(evaluateFullSuiteRequest("s1", "bun test", at(0)).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", at(MINUTE)).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());

    const third = evaluateFullSuiteRequest("s1", "bun test", at(2 * MINUTE));
    expect(third.allow).toBe(false);
    expect(third.reason).toContain("DIR-L29");
  });

  test("AC-2: the budget frees up once the window passes — no permanent lockout", () => {
    evaluateFullSuiteRequest("s1", "bun test", at(0));
    releaseFullSuiteSlot("s1", opts());
    evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", at(2 * MINUTE)).allow).toBe(false);

    // Both runs are now outside the 30-minute window.
    const later = evaluateFullSuiteRequest("s1", "bun test", at(31 * MINUTE));
    expect(later.allow).toBe(true);
  });

  test("AC-3: runs expire individually, not as a batch", () => {
    evaluateFullSuiteRequest("s1", "bun test", at(0));
    releaseFullSuiteSlot("s1", opts());
    evaluateFullSuiteRequest("s1", "bun test", at(20 * MINUTE));
    releaseFullSuiteSlot("s1", opts());

    // At t=35m the first run has aged out and the second has not, so exactly
    // one slot of budget is back — not zero, and not the full two.
    expect(evaluateFullSuiteRequest("s1", "bun test", at(35 * MINUTE)).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", at(36 * MINUTE)).allow).toBe(false);
  });

  test("AC-4: the window is per session, not shared between them", () => {
    evaluateFullSuiteRequest("s1", "bun test", at(0));
    releaseFullSuiteSlot("s1", opts());
    evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", at(2 * MINUTE)).allow).toBe(false);

    // s2 has spent nothing and must be unaffected by s1 exhausting its budget.
    expect(evaluateFullSuiteRequest("s2", "bun test", at(2 * MINUTE)).allow).toBe(true);
  });

  test("AC-5: the refusal says when the budget comes back", () => {
    evaluateFullSuiteRequest("s1", "bun test", at(0));
    releaseFullSuiteSlot("s1", opts());
    evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
    releaseFullSuiteSlot("s1", opts());

    const blocked = evaluateFullSuiteRequest("s1", "bun test", at(2 * MINUTE));
    expect(blocked.allow).toBe(false);
    // The old message offered no way out, which is why it read as a policy
    // violation. It must name the wait.
    expect(blocked.reason).toMatch(/\b2[89] minutes?\b/);
  });

  /** A pre-#73 counter file, stamped as having been written at `writtenAt`. */
  const writeLegacyCounter = (runs: number, writtenAt: number) => {
    const path = join(dir, "rungate-test-suite-count-s1");
    writeFileSync(path, String(runs));
    // Legacy files record no timestamp, so mtime is the only evidence of when
    // those runs happened. Set it rather than inheriting the real clock.
    utimesSync(path, new Date(writtenAt), new Date(writtenAt));
    return path;
  };

  test("AC-6: a legacy bare-integer counter is honoured, not silently discarded", () => {
    // Counter files written before this change hold `"2"` and nothing else.
    // Reading one as zero would hand every currently-capped session a fresh
    // budget the moment this ships — a silent reset of the live cap.
    writeLegacyCounter(2, t0);

    const blocked = evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toContain("DIR-L29");
  });

  test("AC-7: a legacy counter ages out of the window like any other run", () => {
    // Dated from mtime, so an old lockout clears instead of persisting for the
    // life of the session as it does today.
    writeLegacyCounter(2, t0);

    const later = evaluateFullSuiteRequest("s1", "bun test", at(31 * MINUTE));
    expect(later.allow).toBe(true);
  });

  /**
   * Security review of b95438cf. Every one of these reaches the gate through
   * the counter file, throws, and is swallowed by TestSuiteGuard's `catch {
   * process.exit(0) }` — which is a deliberate fail-open for a broken guard.
   * The result is no full-suite cap at all, with nothing printed. The counter
   * file is in a world-writable TMPDIR, so "who would write that" is not a
   * defence.
   */
  describe("a malformed counter cannot crash the gate into fail-open", () => {
    const writeCounter = (body: string) => {
      const path = join(dir, "rungate-test-suite-count-s1");
      writeFileSync(path, body);
      utimesSync(path, new Date(t0), new Date(t0));
      return path;
    };

    test("AC-9: an absurd legacy count does not blow up allocation", () => {
      // `Array.from({length: 99999999999})` throws RangeError before anything
      // else runs. Thrown out of the gate, caught by the hook, cap gone.
      writeCounter("99999999999");

      const d = evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("DIR-L29");
    });

    test("AC-10: a huge runs array does not blow the argument limit", () => {
      // Math.min(...runs) spreads every element as an argument. Past roughly
      // 100k the engine throws RangeError on the call itself.
      const runs = Array.from({ length: 500_000 }, (_, i) => t0 + i);
      writeCounter(JSON.stringify({ runs }));

      const d = evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("DIR-L29");
    });

    test("AC-11: an oversized counter file is rejected, not read into memory", () => {
      writeCounter(`{"runs":[${"1,".repeat(2_000_000)}1]}`);

      const d = evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
      expect(d.allow).toBe(false);
      expect(d.reason).toContain("DIR-L29");
    });

    test("AC-12: the budget never persists more entries than it can spend", () => {
      // Whatever came in, what goes back out has to stay bounded — otherwise a
      // single poisoned file keeps every later read expensive.
      const runs = Array.from({ length: 10_000 }, (_, i) => t0 + i);
      const path = writeCounter(JSON.stringify({ runs }));

      evaluateFullSuiteRequest("s1", "bun test", at(31 * MINUTE));
      const after = JSON.parse(readFileSync(path, "utf-8")) as { runs: number[] };
      expect(after.runs.length).toBeLessThanOrEqual(8);
    });

    test("AC-13: a zero budget refuses with a real wait, not 'Infinity minutes'", () => {
      // Math.min() of an empty array is Infinity, which reached the user-facing
      // string. A nonsense number in a refusal is how people learn to ignore it.
      const d = evaluateFullSuiteRequest("s1", "bun test", at(0, { maxRunsPerSession: 0 }));
      expect(d.allow).toBe(false);
      expect(d.reason).not.toContain("Infinity");
    });
  });

  test("AC-8: a corrupt counter file fails closed, not open", () => {
    // `{"runs": "two"}` must never read as an empty budget — that is the
    // report-success-without-checking shape this repo keeps finding.
    const path = join(dir, "rungate-test-suite-count-s1");
    writeFileSync(path, '{"runs": "two"}');
    utimesSync(path, new Date(t0), new Date(t0));

    const d = evaluateFullSuiteRequest("s1", "bun test", at(MINUTE));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("DIR-L29");
  });
});

describe("security: parser-differential guard bypass (#67 review)", () => {
  // Each of these ran a FULL suite while the original parser reported targeted
  // or no-match, so the slot was never taken. Fail-closed is the contract: a
  // missed suite is unlimited concurrency, a false positive is a loud block.
  const mustGuard: Array<[string, string]> = [
    ["bun test", "baseline"],
    ["echo setup\nbun test", "second line of a multi-line body"],
    ["bun test 2>/dev/null", "attached redirect target read as a path"],
    ["bun test > /tmp/out.log", "detached redirect target read as a path"],
    ["bun test 2>&1 | tail -12", "pipeline head"],
    ["CI=1 bun test", "env assignment prefix"],
    ["CI=1 FORCE_COLOR=0 bun test", "multiple env assignments"],
    ["time bun test", "timing wrapper"],
    ["npx bun test", "npx wrapper"],
    ['bash -c "bun test"', "shell -c wrapper"],
    ["cd /repo && bun test", "cd prefix"],
    ["bun test --coverage", "flag only"],
  ];

  for (const [cmd, label] of mustGuard) {
    test(`guards: ${label}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(true);
    });
  }

  // False positives are cheap but not free — these must still pass through.
  const mustPass: Array<[string, string]> = [
    ["bun test test/a.test.ts", "targeted single file"],
    ["bun test test/unit/b.test.ts test/c.test.ts", "targeted multiple"],
    ["bun test gates/workflow.test.ts 2>&1 | tail -5", "targeted with redirect"],
    ["bun run build", "different bun subcommand"],
    ["bunx tsc --noEmit", "bunx, not bun"],
    ['git commit -m "bun test"', "suite name inside a commit message"],
    ["grep -r 'bun test' docs/", "suite name as a search term"],
    ["echo 'bun test' >> notes.md", "suite name written to a file"],
  ];

  for (const [cmd, label] of mustPass) {
    test(`passes through: ${label}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(false);
    });
  }
});

describe("security: runner aliases and quote-awareness (#67 review round 2)", () => {
  // package.json defines test = "bun test", so these are the same 5.4 GB run.
  // `bun run test` was the single most obvious spelling and went unguarded.
  const aliases = [
    "bun run test",
    "npm test",
    "npm run test",
    "yarn test",
    "pnpm test",
  ];
  for (const cmd of aliases) {
    test(`guards runner alias: ${cmd}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(true);
    });
  }

  // These scripts are themselves targeted runs — blocking them also burned a
  // full-suite credit from the session budget.
  const scopedScripts = [
    "bun test:structure",
    "bun test:external-deps",
    "bun run test:structure",
  ];
  for (const cmd of scopedScripts) {
    test(`does not guard scoped script: ${cmd}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(false);
    });
  }

  test("guards a suite hidden behind a separator inside a quoted shell body", () => {
    expect(isFullSuiteCommand('bash -c "bun test; echo done"')).toBe(true);
  });

  test("guards a wrapper that takes its own argument", () => {
    expect(isFullSuiteCommand("timeout 600 bun test")).toBe(true);
  });

  // #82. splitTopLevel treats every \n as a separator, so a trailing backslash
  // left `bun test \` alone in its segment with its paths stranded on the next
  // one — zero arguments survive, the fail-closed branch fires, and a targeted
  // run is charged to the DIR-L29 budget. Multi-line Bash is routine for agents,
  // so this emptied the 2-run budget on cheap runs and then locked the session
  // out of the suite entirely. Found while the budget blocked #71 itself.
  const continued: Array<[string, string]> = [
    ["bun test \\\n  test/a.test.ts test/b.test.ts", "paths on a continuation line"],
    ["bun test test/a.test.ts \\\n  test/b.test.ts", "paths split across the continuation"],
    ["HOME=/tmp bun test \\\n  test/a.test.ts", "env prefix plus continuation"],
    ["bun test \\\n  test/a.test.ts 2>&1 | tail -5", "continuation then a pipe"],
  ];
  for (const [cmd, label] of continued) {
    test(`does not guard a line-continued targeted run: ${label}`, () => {
      expect(isFullSuiteCommand(cmd)).toBe(false);
    });
  }

  // The continuation must not become an escape hatch: a real full suite spread
  // over two lines is still a real full suite.
  test("still guards a line-continued full suite", () => {
    expect(isFullSuiteCommand("bun test \\\n  --coverage")).toBe(true);
  });

  // A backslash that is NOT a line continuation (anything before the newline)
  // must keep splitting, or `echo 'a\' ; bun test` style commands slip through.
  test("still guards a suite on a later line when the newline is a real separator", () => {
    expect(isFullSuiteCommand("echo hello\nbun test")).toBe(true);
  });

  test("does not guard a separator inside a quoted commit message", () => {
    expect(isFullSuiteCommand('git commit -m "chore: lint && bun test"')).toBe(
      false,
    );
  });

  test("does not guard a separator inside quoted text written to a file", () => {
    expect(
      isFullSuiteCommand('echo "cd /repo && bun test" >> docs/notes.md'),
    ).toBe(false);
  });

  test("does not guard args passed through a runner", () => {
    expect(isFullSuiteCommand("npm test -- test/a.test.ts")).toBe(false);
  });
});

describe("security: unbounded slot hold (#67 review)", () => {
  test("a later request never refreshes a slot already held", () => {
    acquireFullSuiteSlot("hog", opts({ now: 0 }));
    // A second request takes a SECOND slot (it is a second suite). What it must
    // never do is push the first slot's clock forward, which would let a
    // session hold a slot indefinitely by asking again.
    acquireFullSuiteSlot("hog", opts({ now: 100_000 }));
    // A third is refused — capacity is full — and must also leave both clocks alone.
    acquireFullSuiteSlot("hog", opts({ now: 300_000 }));

    const ages = heldSlots(dir, 300_000)
      .map((h) => h.ageSeconds)
      .sort((a, b) => a - b);
    expect(ages).toEqual([200, 300]);
  });

  test("TTL is absolute from acquisition, so a wedged session frees up", () => {
    acquireFullSuiteSlot("hog", opts({ now: 0 }));
    acquireFullSuiteSlot("hog", opts({ now: 0 }));

    // 500s later both slots are past the 420s TTL and reclaimable.
    expect(acquireFullSuiteSlot("other-a", opts({ now: 500_000 })).ok).toBe(
      true,
    );
    expect(acquireFullSuiteSlot("other-b", opts({ now: 500_000 })).ok).toBe(
      true,
    );
    expect(
      heldSlots(dir, 500_000)
        .map((h) => h.sessionId)
        .sort(),
    ).toEqual(["other-a", "other-b"]);
  });
});

describe("security: fail-open must not be silent (#67 review)", () => {
  test("a degraded guard allows the run but reports that the cap is off", () => {
    const decision = evaluateFullSuiteRequest("s1", "bun test", {
      lockDir: "/nonexistent-dir-xyz/nested",
    });

    expect(decision.allow).toBe(true);
    expect(decision.warning).toBeDefined();
    expect(decision.warning).toMatch(/not being enforced/i);
  });

  test("a healthy guard allows without a warning", () => {
    const decision = evaluateFullSuiteRequest("s1", "bun test", opts());
    expect(decision.allow).toBe(true);
    expect(decision.warning).toBeUndefined();
  });
});

describe("security: corrupt slot cannot grant unlimited concurrency", () => {
  // 8e's pairing: a slot that both fails open and never expires would be
  // unlimited concurrency — the exact 16:22 condition.
  test("corrupt slots are reclaimed, and the cap still binds afterwards", () => {
    writeFileSync(join(dir, "full-suite.slot-0.lock"), "{ not json");
    writeFileSync(join(dir, "full-suite.slot-1.lock"), "\u0000\u0000corrupt");

    expect(acquireFullSuiteSlot("a", opts()).ok).toBe(true);
    expect(acquireFullSuiteSlot("b", opts()).ok).toBe(true);
    // Capacity must still be 2 — reclaiming corruption is not extra capacity.
    expect(acquireFullSuiteSlot("c", opts()).ok).toBe(false);
  });

  test("a slot with a non-numeric startedAt is treated as corrupt, not immortal", () => {
    writeFileSync(
      join(dir, "full-suite.slot-0.lock"),
      JSON.stringify({ sessionId: "ghost", startedAt: "never" }),
    );
    expect(acquireFullSuiteSlot("a", opts()).ok).toBe(true);
    expect(heldSlots(dir).map((h) => h.sessionId)).toContain("a");
  });
});

describe("release", () => {
  test("releasing frees the slot for another session", () => {
    acquireFullSuiteSlot("session-a", opts());
    acquireFullSuiteSlot("session-b", opts());
    expect(acquireFullSuiteSlot("session-c", opts()).ok).toBe(false);

    releaseFullSuiteSlot("session-a", opts());

    expect(acquireFullSuiteSlot("session-c", opts()).ok).toBe(true);
  });

  test("releasing frees one finished suite, not every slot the session holds", () => {
    acquireFullSuiteSlot("A", opts({ now: 0 })); // backgrounded, still running
    acquireFullSuiteSlot("A", opts({ now: 10_000 })); // foreground

    // The foreground suite finishes and its PostToolUse hook releases.
    releaseFullSuiteSlot("A", opts());

    // The backgrounded suite is still consuming 5.4 GB — its slot must survive,
    // or the cap hands out capacity that is genuinely in use.
    const remaining = heldSlots(dir, 10_000);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe("A");
    expect(remaining[0].ageSeconds).toBe(10);
  });

  test("a session cannot release a slot it does not hold", () => {
    acquireFullSuiteSlot("session-a", opts());
    releaseFullSuiteSlot("session-b", opts());

    expect(heldSlots(dir).map((h) => h.sessionId)).toEqual(["session-a"]);
  });

  test("releasing when holding nothing is a no-op, not an error", () => {
    expect(() => releaseFullSuiteSlot("nobody", opts())).not.toThrow();
  });
});

/**
 * #74 — a slot leaks for a full TTL when a LATER PreToolUse hook blocks the
 * command.
 *
 * TestSuiteGuard acquires at PreToolUse. If another hook then refuses the same
 * command, the tool never runs, so TestSuiteRelease (PostToolUse) never fires.
 * Observed during #67: COMP-7 blocked `bun test ... ; cat /tmp/out` for the
 * `cat`, leaving slot-0 held with no suite running and a budget unit spent.
 * With capacity 2, two such blocks wedge every session on the machine for
 * ~7 minutes.
 *
 * PreToolUse cannot know whether a later hook will block, and no "tool was
 * denied" signal reaches the hook that acquired. So reconcile on the next
 * acquire instead.
 *
 * The reconciliation deliberately does NOT try to attribute processes to
 * sessions — that is the part #67 established is unreliable, because the
 * agentgrit suite leaks ~31 dangling bun processes. It only uses the zero
 * case: a slot means a running suite, so if NO suite is running anywhere on
 * the machine, every slot is provably false regardless of its age.
 */
describe("#74: a slot held with no suite running is reclaimed early", () => {
  const GRACE = 25; // seconds — covers acquire-then-spawn

  test("reclaims a leaked slot once no suite is running and the grace period has passed", () => {
    const t0 = 1_000_000;
    // capacity 1, or the second session simply takes the OTHER slot and the
    // test passes without reclaiming anything. The first draft of this test
    // omitted it and went green against unchanged code.
    const first = acquireFullSuiteSlot("blocked-session", opts({ now: t0, capacity: 1, suitesRunning: () => true }));
    expect(first.ok).toBe(true);

    // The command was blocked by another hook: no suite ever started, and no
    // release will come. 30s later, with nothing running anywhere.
    const at = t0 + (GRACE + 5) * 1000;
    const after = acquireFullSuiteSlot("next-session", opts({
      now: at,
      capacity: 1,
      suitesRunning: () => false,
    }));
    expect(after.ok).toBe(true);
    expect(heldSlots(dir, at, 1).map(h => h.sessionId)).toEqual(["next-session"]);
  });

  test("does NOT reclaim within the grace period — acquire happens before the suite spawns", () => {
    const t0 = 2_000_000;
    expect(acquireFullSuiteSlot("starting", opts({ now: t0, suitesRunning: () => false })).ok).toBe(true);

    // 5s later bun has not appeared in the process table yet. Stealing the slot
    // here would break the very case the lock exists for.
    const racer = acquireFullSuiteSlot("racer", opts({
      now: t0 + 5000,
      capacity: 1,
      suitesRunning: () => false,
    }));
    expect(racer.ok).toBe(false);
  });

  test("never reclaims while a suite IS running, however old the slot", () => {
    const t0 = 3_000_000;
    expect(acquireFullSuiteSlot("long-runner", opts({ now: t0, suitesRunning: () => true })).ok).toBe(true);

    // Well past the grace period but still under the TTL, with a suite alive.
    const other = acquireFullSuiteSlot("other", opts({
      now: t0 + 200_000,
      capacity: 1,
      suitesRunning: () => true,
    }));
    expect(other.ok).toBe(false);
  });

  test("the TTL still reclaims even when liveness cannot be determined", () => {
    const t0 = 4_000_000;
    expect(acquireFullSuiteSlot("ghost", opts({ now: t0, suitesRunning: () => true })).ok).toBe(true);

    // A detector that always claims something is running must not be able to
    // pin a slot forever — the TTL remains the backstop it was designed to be.
    const later = acquireFullSuiteSlot("after-ttl", opts({
      now: t0 + 421_000,
      capacity: 1,
      suitesRunning: () => true,
    }));
    expect(later.ok).toBe(true);
  });

  test("a detector that throws fails safe: the slot is kept, not reclaimed", () => {
    const t0 = 5_000_000;
    expect(acquireFullSuiteSlot("holder", opts({ now: t0, suitesRunning: () => true })).ok).toBe(true);

    const unknown = acquireFullSuiteSlot("next", opts({
      now: t0 + 100_000,
      capacity: 1,
      suitesRunning: () => { throw new Error("ps unavailable"); },
    }));
    // Reclaiming on an unreadable process table would let two real suites run
    // against a cap of one, which is the OOM condition the cap prevents.
    expect(unknown.ok).toBe(false);
  });
});

/**
 * #103 — `evaluateFullSuiteRequest` reads as a predicate and behaves as a
 * transaction: it takes one of only two machine-wide slots and spends a unit of
 * the DIR-L29 budget on the way through.
 *
 * Proven on 2026-10-05: a three-call diagnostic that only wanted to know
 * whether a suite WOULD be allowed took both slots, and every other session was
 * refused with a message naming two holders that were running nothing.
 *
 * `wouldAllowFullSuite` is the read-only half. It reads the same lock directory
 * and the same counter file — it has to, or it would be answering about a
 * different world — but it writes nothing, so asking the question can never
 * change the answer.
 */
describe("wouldAllowFullSuite — asking is not running (#103)", () => {
  /** Name, mtime and bytes of every file in the lock dir. Any write moves one. */
  const snapshot = () =>
    readdirSync(dir)
      .sort()
      .map((name) => {
        const p = join(dir, name);
        return `${name}\u0000${statSync(p).mtimeMs}\u0000${readFileSync(p, "utf-8")}`;
      });

  // Pinned rather than probed: the default detector shells out to `ps`, so an
  // unrelated suite elsewhere on the machine would otherwise decide whether the
  // held slots in these fixtures look live.
  const live = (extra: Record<string, unknown> = {}) =>
    opts({ suitesRunning: () => true, ...extra });

  test("wouldAllowFullSuite is pure: asking never takes a slot", () => {
    for (let i = 0; i < 3; i++) {
      expect(wouldAllowFullSuite("diagnostic", "bun test", live()).allow).toBe(true);
    }

    // The 2026-10-05 symptom: three asks, both slots gone, holders running
    // nothing. Capacity must be entirely untouched.
    expect(heldSlots(dir)).toHaveLength(0);
    expect(evaluateFullSuiteRequest("other-a", "bun test", live()).allow).toBe(true);
    expect(evaluateFullSuiteRequest("other-b", "bun test", live()).allow).toBe(true);
  });

  test("wouldAllowFullSuite is pure: asking never spends the session budget", () => {
    for (let i = 0; i < 5; i++) {
      expect(wouldAllowFullSuite("s1", "bun test", live()).allow).toBe(true);
    }

    // The full budget of 2 is still there to be spent by actual runs.
    expect(evaluateFullSuiteRequest("s1", "bun test", live()).allow).toBe(true);
    releaseFullSuiteSlot("s1", opts());
    expect(evaluateFullSuiteRequest("s1", "bun test", live()).allow).toBe(true);
  });

  test("wouldAllowFullSuite is pure: the lock directory is byte-identical afterwards", () => {
    // Ask against a populated directory — a held slot and a spent budget — so
    // the assertion is about not writing, not about there being nothing to write.
    evaluateFullSuiteRequest("holder", "bun test", live());
    const before = snapshot();
    expect(before.length).toBeGreaterThan(0);

    wouldAllowFullSuite("asker", "bun test", live());
    wouldAllowFullSuite("holder", "bun test", live());
    wouldAllowFullSuite("asker", "bun test test/foo.test.ts", live());

    expect(snapshot()).toEqual(before);
  });

  test("wouldAllowFullSuite is pure: repeated asks cannot change their own answer", () => {
    acquireFullSuiteSlot("a", live());

    const answers = Array.from({ length: 6 }, () =>
      wouldAllowFullSuite("asker", "bun test", live()).allow,
    );
    // One slot of two is taken, so every ask must say yes. A self-poisoning
    // predicate flips to false partway through this list.
    expect(answers).toEqual([true, true, true, true, true, true]);
  });

  test("the two entry points agree on the budget verdict when it is exhausted", () => {
    evaluateFullSuiteRequest("s1", "bun test", live());
    releaseFullSuiteSlot("s1", opts());
    evaluateFullSuiteRequest("s1", "bun test", live());
    releaseFullSuiteSlot("s1", opts());

    const predicted = wouldAllowFullSuite("s1", "bun test", live());
    const actual = evaluateFullSuiteRequest("s1", "bun test", live());

    expect(predicted.allow).toBe(false);
    expect(predicted.allow).toBe(actual.allow);
    // The same refusal text, not merely the same boolean — the reason is what
    // the caller acts on, and two gates that disagree about WHY are two gates.
    expect(predicted.reason).toContain("DIR-L29");
    expect(predicted.reason).toBe(actual.reason);
  });

  test("the two entry points agree on the concurrency verdict", () => {
    evaluateFullSuiteRequest("alpha", "bun test", live());
    evaluateFullSuiteRequest("beta", "bun test", live());

    const predicted = wouldAllowFullSuite("gamma", "bun test", live());
    const actual = evaluateFullSuiteRequest("gamma", "bun test", live());

    expect(predicted.allow).toBe(false);
    expect(predicted.allow).toBe(actual.allow);
    expect(predicted.reason).toBe(actual.reason);
    expect(predicted.reason).toContain("alpha");
    expect(predicted.reason).toContain("beta");
  });

  test("a targeted run is predicted allowed, like the gate itself", () => {
    const cmd = "bun test test/foo.test.ts";
    expect(wouldAllowFullSuite("s1", cmd, live()).allow).toBe(true);
    expect(wouldAllowFullSuite("s1", cmd, live()).allow).toBe(
      evaluateFullSuiteRequest("s1", cmd, live()).allow,
    );
  });

  test("a stale slot is predicted free, exactly as the acquirer would reclaim it", () => {
    acquireFullSuiteSlot("dead-a", opts({ now: 0, suitesRunning: () => true }));
    acquireFullSuiteSlot("dead-b", opts({ now: 0, suitesRunning: () => true }));

    // Inside the 420s TTL both holders are real.
    expect(
      wouldAllowFullSuite("next", "bun test", live({ now: 400_000 })).allow,
    ).toBe(false);
    // Past it, the acquirer reclaims — so the prediction must say so too, or it
    // reports a deadlock the gate does not actually have.
    expect(
      wouldAllowFullSuite("next", "bun test", live({ now: 500_000 })).allow,
    ).toBe(true);
  });
});

/**
 * Issue #239 — the rate budget is keyed on the session, and sub-agents share
 * their parent's session id.
 *
 * #73 made the budget a rolling window and #67-B made a SLOT mean one running
 * suite rather than one session. The rate half never got the same treatment:
 * `counterPath` still built `rungate-test-suite-count-${sessionId}`, so a ship
 * run that fans out to three implementers gave three agents two runs per 30
 * minutes between them, spent by whoever asked first.
 *
 * Measured on run wf_18abb197-f03: both units of budget went to sub-agents
 * 235001 and 235003, and 235002 spent ~22 minutes in `sleep 580` loops waiting
 * for a window to age out while its siblings had been finished for twenty.
 *
 * Raising maxRuns is the wrong fix — the budget exists because concurrent full
 * suites jetsam-killed this machine on 2026-10-05. The budget is right; its key
 * is wrong. A worker is the unit of work asking for the suite, derived from the
 * session id plus the working directory, which is what distinguishes sibling
 * agents in their own worktrees.
 */
describe("#239: the rate budget is keyed on the worker, not the session", () => {
  const MINUTE = 60_000;
  const t0 = 1_700_000_000_000;

  /**
   * Liveness is pinned ON throughout. These cases are about the BUDGET, and a
   * reclaimed slot would let a case pass for a concurrency reason instead.
   */
  const as = (worker: string, ms: number, extra: Record<string, unknown> = {}) =>
    opts({ workerId: worker, now: t0 + ms, suitesRunning: () => true, ...extra });

  /** One full suite, start to finish, for one worker. */
  const runSuite = (session: string, worker: string, ms: number) => {
    const verdict = evaluateFullSuiteRequest(session, "bun test", as(worker, ms));
    if (verdict.allow) releaseFullSuiteSlot(session, as(worker, ms));
    return verdict;
  };

  test("sibling workers sharing one session id spend separate rate budgets", () => {
    // One parent session, two sub-agents in their own worktrees.
    expect(runSuite("parent", "w1", 0).allow).toBe(true);
    expect(runSuite("parent", "w1", MINUTE).allow).toBe(true);

    // w1 has spent its two runs — DIR-L29 still binds for w1.
    const third = runSuite("parent", "w1", 2 * MINUTE);
    expect(third.allow).toBe(false);
    expect(third.reason).toContain("DIR-L29");

    // ...and w2, which has run nothing, is unaffected. This is the whole of
    // #239: before the key change this was the refusal that put sub-agent
    // 235002 to sleep for 22 minutes.
    expect(runSuite("parent", "w2", 2 * MINUTE).allow).toBe(true);
    expect(runSuite("parent", "w2", 3 * MINUTE).allow).toBe(true);
    expect(runSuite("parent", "w2", 4 * MINUTE).allow).toBe(false);
  });

  test("sibling workers write separate counter files, not one shared file", () => {
    // The mechanism, asserted on disk: two counters, one per worker, and
    // neither of them named for the bare session id.
    runSuite("parent", "w1", 0);
    runSuite("parent", "w2", 0);

    const counters = readdirSync(dir).filter((f) =>
      f.startsWith("rungate-test-suite-count-"),
    );
    expect(counters).toHaveLength(2);
    expect(counters).not.toContain("rungate-test-suite-count-parent");
  });

  test("a worker's own budget still binds across its own repeated runs", () => {
    // The fix must not become "every request is a new worker", which would
    // delete DIR-L29 rather than re-key it.
    expect(runSuite("parent", "w1", 0).allow).toBe(true);
    expect(runSuite("parent", "w1", MINUTE).allow).toBe(true);
    expect(runSuite("parent", "w1", 2 * MINUTE).allow).toBe(false);
  });

  test("with no worker identity the key is the session, as it was before", () => {
    // Backwards compatibility with counter files already on disk, and with
    // every caller that does not know about workers.
    evaluateFullSuiteRequest("solo", "bun test", opts({ now: t0, suitesRunning: () => true }));
    expect(readdirSync(dir)).toContain("rungate-test-suite-count-solo");
  });

  test("two distinct workers cannot exceed the concurrency capacity", () => {
    // AC-2 / SC-516 / SC-517: re-keying the RATE budget must not touch the
    // concurrency cap. A slot is still one running suite, whoever runs it, and
    // no spread of worker ids across one session can produce a third.
    expect(evaluateFullSuiteRequest("parent", "bun test", as("w1", 0)).allow).toBe(true);
    expect(evaluateFullSuiteRequest("parent", "bun test", as("w2", 0)).allow).toBe(true);
    expect(evaluateFullSuiteRequest("parent", "bun test", as("w3", 0)).allow).toBe(false);
    expect(evaluateFullSuiteRequest("other", "bun test", as("w4", 0)).allow).toBe(false);
    expect(heldSlots(dir, t0)).toHaveLength(2);
  });

  test("a worker releases its own slot, not its sibling's", () => {
    // Acquire and release must agree on the identity or a slot leaks for a
    // full TTL. w1 finishing must free exactly one slot and leave w2 holding.
    evaluateFullSuiteRequest("parent", "bun test", as("w1", 0));
    evaluateFullSuiteRequest("parent", "bun test", as("w2", MINUTE));

    releaseFullSuiteSlot("parent", as("w1", 2 * MINUTE));

    const held = heldSlots(dir, t0 + 2 * MINUTE);
    expect(held).toHaveLength(1);
    expect(held[0]!.startedAt).toBe(t0 + MINUTE);
  });

  test("a refused run neither consumes nor re-arms the budget window", () => {
    // AC-3. A refusal that appended its own attempt would spend budget the
    // worker never used; one that moved the oldest entry forward would push
    // the window out every time the worker asked, so a worker polling the
    // gate could never reach the moment it frees up.
    runSuite("parent", "w1", 0);
    runSuite("parent", "w1", MINUTE);

    const counter = join(dir, readdirSync(dir).filter((f) =>
      f.startsWith("rungate-test-suite-count-"))[0]!);
    const before = readFileSync(counter, "utf-8");

    // Refused repeatedly, at times that would each be a new window start.
    for (const ms of [2 * MINUTE, 10 * MINUTE, 20 * MINUTE, 29 * MINUTE]) {
      const blocked = evaluateFullSuiteRequest("parent", "bun test", as("w1", ms));
      expect(blocked.allow).toBe(false);
      expect(readFileSync(counter, "utf-8")).toBe(before);
    }

    // The window is measured from the runs that really happened, so it frees
    // up 30 minutes after the FIRST one regardless of how often it was asked.
    expect(evaluateFullSuiteRequest("parent", "bun test", as("w1", 31 * MINUTE)).allow).toBe(true);
  });

  test("the worker key is one filename-safe segment", () => {
    // AC-6. The worker identity is derived from a working directory, which is
    // attacker-adjacent input: it reaches `join(lockDir, ...)`, so a key
    // carrying separators or traversal would steer the counter file out of the
    // lock directory entirely.
    const hostile = [
      "/Users/jhorn/Projects/rungate/.claude/worktrees/wf_abc",
      "../../../../etc/passwd",
      "..",
      "a/b/../../../tmp/x",
      "with space/and:colon",
      "",
      "\u0000null-byte",
    ];

    for (const cwd of hostile) {
      const key = deriveWorkerId("parent", cwd);
      expect(key, `key for ${JSON.stringify(cwd)}`).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(key.length).toBeGreaterThan(0);
      expect(key.length).toBeLessThanOrEqual(72);
    }

    // Distinct directories stay distinct after sanitising — a key that
    // collapsed two worktrees into one name would re-create #239 quietly.
    expect(deriveWorkerId("parent", "/a/b")).not.toBe(deriveWorkerId("parent", "/a/c"));
    expect(deriveWorkerId("parent", "/a/b")).toBe(deriveWorkerId("parent", "/a/b"));
    expect(deriveWorkerId("p1", "/a/b")).not.toBe(deriveWorkerId("p2", "/a/b"));

    // And the counter the gate actually writes stays inside the lock dir.
    const key = counterKey("parent", { workerId: deriveWorkerId("parent", "../../etc") });
    expect(key).not.toContain("/");
    expect(key).not.toContain("..");

    evaluateFullSuiteRequest("parent", "bun test", opts({
      workerId: deriveWorkerId("parent", "../../../../tmp/escape"),
      now: t0,
      suitesRunning: () => true,
    }));
    expect(
      readdirSync(dir).filter((f) => f.startsWith("rungate-test-suite-count-")),
    ).toHaveLength(1);
  });

  test("a hostile worker id cannot overwrite the slot files", () => {
    // The same reduction applied to the slot side: a worker id is never used
    // as a path component, but it IS written into the slot file, so the cap
    // must still count two and only two slots.
    evaluateFullSuiteRequest("parent", "bun test", as("../../full-suite.slot-0.lock", 0));
    expect(readdirSync(dir).filter((f) => f.startsWith("full-suite.slot-"))).toEqual([
      "full-suite.slot-0.lock",
    ]);
  });
});

/**
 * #239, the hook end: the identity has to be derived where the session id
 * arrives, and acquire and release have to derive the same one.
 *
 * Driven as subprocesses rather than asserted as source text. Every mutation
 * that survived a first pass on 2026-10-06 was a source-text assertion, and
 * `grep workerId hooks/TestSuiteGuard.hook.ts` is exactly that shape: it stays
 * green against a hook that computes a worker and then never passes it.
 *
 * RUNGATE_LOCK_DIR is what makes this safe to run. Without it these cases
 * would compete for the real machine-wide slots — including the slot held by
 * the suite running them — and leak a live slot per case.
 */
describe("#239: the hooks derive and pass a worker identity", () => {
  const hookPath = (name: string) => join(import.meta.dir, "..", "hooks", name);

  function drive(name: string, input: Record<string, unknown>): string {
    const r = spawnSync("bun", [hookPath(name)], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, RUNGATE_LOCK_DIR: dir },
    });
    return r.stdout ?? "";
  }

  const bashInput = (cwd: string) => ({
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    session_id: "one-parent-session",
    cwd,
  });

  const guard = (cwd: string) => drive("TestSuiteGuard.hook.ts", bashInput(cwd));
  const release = (cwd: string) => drive("TestSuiteRelease.hook.ts", bashInput(cwd));

  const WORKTREE_A = "/Users/jhorn/Projects/rungate/.claude/worktrees/wf_a";
  const WORKTREE_B = "/Users/jhorn/Projects/rungate/.claude/worktrees/wf_b";

  test("a sibling sub-agent is not blocked by its sibling's spent budget", () => {
    // Worker A spends its two runs. The release hook has to recognise the same
    // worker, or the slot leaks and the next case fails for the wrong reason.
    expect(guard(WORKTREE_A)).toBe("");
    release(WORKTREE_A);
    expect(guard(WORKTREE_A)).toBe("");
    release(WORKTREE_A);

    // Its own third run inside the window is still refused — DIR-L29 intact.
    const refused = guard(WORKTREE_A);
    expect(refused).toContain("DIR-L29");
    expect(refused).toContain("block");

    // Worker B carries the SAME session id and has run nothing. Before #239
    // this was the refusal that put sub-agent 235002 to sleep for 22 minutes.
    expect(guard(WORKTREE_B)).toBe("");
    release(WORKTREE_B);
  }, 120_000);

  test("a hook input with no cwd still works, keyed on the session", () => {
    const out = drive("TestSuiteGuard.hook.ts", {
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      session_id: "cwd-less",
    });
    expect(out).toBe("");
    expect(readdirSync(dir)).toContain("rungate-test-suite-count-cwd-less");
  }, 120_000);

  test("the hooks agree on the identity, so a slot is not leaked", () => {
    // Acquire under one derivation and release under another leaves the slot
    // held for a full 420s TTL, which is how a cap meant to prevent an OOM
    // turns into a repo-wide stall.
    expect(guard(WORKTREE_A)).toBe("");
    expect(heldSlots(dir)).toHaveLength(1);
    release(WORKTREE_A);
    expect(heldSlots(dir)).toHaveLength(0);
  });
});
