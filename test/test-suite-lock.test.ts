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

  test("a session re-entering does not consume a second slot", () => {
    acquireFullSuiteSlot("session-a", opts());
    expect(acquireFullSuiteSlot("session-a", opts()).ok).toBe(true);

    expect(heldSlots(dir)).toHaveLength(1);
    // A different session can still take the remaining slot.
    expect(acquireFullSuiteSlot("session-b", opts()).ok).toBe(true);
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

describe("release", () => {
  test("releasing frees the slot for another session", () => {
    acquireFullSuiteSlot("session-a", opts());
    acquireFullSuiteSlot("session-b", opts());
    expect(acquireFullSuiteSlot("session-c", opts()).ok).toBe(false);

    releaseFullSuiteSlot("session-a", opts());

    expect(acquireFullSuiteSlot("session-c", opts()).ok).toBe(true);
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
