import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// SPEC-REF: HOOK-ARCHITECTURE-SPEC.md § Design Decisions

import {
  acquireFullSuiteSlot,
  evaluateFullSuiteRequest,
  heldSlots,
  isFullSuiteCommand,
  releaseFullSuiteSlot,
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
