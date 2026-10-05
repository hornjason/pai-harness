/**
 * Cross-session concurrency guard for full `bun test` runs (issue #67).
 *
 * CLAUDE.md mandates a full suite before implementation work and
 * hooks/TestSuiteGuard.hook.ts caps that per session. Nothing capped it across
 * sessions, so N open sessions meant N simultaneous suites. On 2026-10-05 that
 * exhausted the VM compressor and rebooted the machine.
 *
 * Capacity is measured, not guessed. One rungate full suite peaks at 5,360 MB
 * across 33 processes on this hardware; one is comfortably safe, two is fine,
 * four-plus is the cliff once an editor and containers are also resident.
 *
 * Slots are explicit files rather than a process count, for two reasons found
 * on this machine: the agentgrit suite leaks ~31 dangling bun processes per run
 * so a count cannot distinguish live work from residue, and BSD `pgrep` has no
 * `-c` flag, so the obvious `pgrep -c bun` exits 2 and silently counts nothing.
 *
 * The guard fails OPEN: if the lock directory is unusable, work proceeds. A
 * broken guard must never be able to block the suite. It does not, however,
 * fail SILENT — a refusal is always reported to the caller.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEFAULT_CAPACITY = 2;
const DEFAULT_TTL_SECONDS = 420;

export interface SlotHolder {
  sessionId: string;
  startedAt: number;
  ageSeconds: number;
}

export interface AcquireResult {
  ok: boolean;
  /** Present when refused — who is holding the slots and for how long. */
  holders?: SlotHolder[];
  /** True when the guard could not function and allowed the run anyway. */
  degraded?: boolean;
}

export interface LockOptions {
  lockDir?: string;
  capacity?: number;
  ttlSeconds?: number;
  now?: number;
}

interface SlotEntry {
  sessionId: string;
  startedAt: number;
}

function defaultLockDir(): string {
  return process.env.TMPDIR || tmpdir() || "/tmp";
}

function slotPath(lockDir: string, index: number): string {
  return join(lockDir, `full-suite.slot-${index}.lock`);
}

function readSlot(path: string): SlotEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as SlotEntry;
    }
    return null;
  } catch {
    // Missing or corrupt — either way there is no live holder here.
    return null;
  }
}

/**
 * True for a bare full-suite invocation, false for targeted paths.
 *
 * A targeted run is cheap (415 MB / 7 processes for test/unit) and must never
 * be guarded, so anything carrying a file argument passes straight through.
 */
export function isFullSuiteCommand(command: string): boolean {
  // Only the first pipeline stage can be the suite; `... | grep 'bun test'` is not.
  const head = command.split("|")[0];

  // `cd /repo && bun test` is still a full suite run.
  for (const segment of head.split(/&&|;/)) {
    const trimmed = segment.trim();
    if (!/^bun\s+test\b/.test(trimmed)) continue;

    const args = trimmed
      .replace(/^bun\s+test\b/, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      // Flags and redirections do not make a run targeted.
      .filter((a) => !a.startsWith("-") && !/^\d*>&?\d*$/.test(a));

    const hasPath = args.some(
      (a) => a.includes("/") || /\.(test\.)?(ts|tsx|js|jsx)$/.test(a),
    );
    if (!hasPath) return true;
  }

  return false;
}

/** Non-stale slot holders, newest timestamp wins. */
export function heldSlots(
  lockDir: string,
  now: number = Date.now(),
  capacity: number = DEFAULT_CAPACITY,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): SlotHolder[] {
  const holders: SlotHolder[] = [];
  for (let i = 0; i < capacity; i++) {
    const entry = readSlot(slotPath(lockDir, i));
    if (!entry) continue;
    const ageSeconds = Math.floor((now - entry.startedAt) / 1000);
    if (ageSeconds >= ttlSeconds) continue;
    holders.push({ ...entry, ageSeconds });
  }
  return holders;
}

/**
 * Take one of the concurrency slots, or report who is holding them.
 *
 * Slots are created with O_EXCL so two sessions racing for the last slot cannot
 * both win — the loser falls through and is refused rather than silently
 * doubling the concurrency.
 */
export function acquireFullSuiteSlot(
  sessionId: string,
  options: LockOptions = {},
): AcquireResult {
  const lockDir = options.lockDir ?? defaultLockDir();
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = options.now ?? Date.now();

  try {
    mkdirSync(lockDir, { recursive: true });

    // Already holding a slot — re-entrant, and refresh so a long suite does not
    // expire out from under itself mid-run.
    for (let i = 0; i < capacity; i++) {
      const path = slotPath(lockDir, i);
      const entry = readSlot(path);
      if (entry?.sessionId === sessionId) {
        writeFileSync(path, JSON.stringify({ sessionId, startedAt: now }));
        return { ok: true };
      }
    }

    for (let i = 0; i < capacity; i++) {
      const path = slotPath(lockDir, i);
      const entry = readSlot(path);
      const stale =
        !entry || Math.floor((now - entry.startedAt) / 1000) >= ttlSeconds;

      if (stale) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone, or claimed by a racing session — the O_EXCL below decides.
        }
      }

      try {
        const fd = openSync(path, "wx");
        writeSync(fd, JSON.stringify({ sessionId, startedAt: now }));
        closeSync(fd);
        return { ok: true };
      } catch {
        // Slot taken between the staleness check and the create — try the next.
      }
    }

    return { ok: false, holders: heldSlots(lockDir, now, capacity, ttlSeconds) };
  } catch {
    // The guard itself is broken. Allow the run rather than wedge the repo.
    return { ok: true, degraded: true };
  }
}

export interface GateDecision {
  allow: boolean;
  /** Present when refused — shown verbatim to the caller. Never silent. */
  reason?: string;
}

function counterPath(lockDir: string, sessionId: string): string {
  return join(lockDir, `rungate-test-suite-count-${sessionId}`);
}

function readCount(path: string): number {
  try {
    return parseInt(readFileSync(path, "utf-8").trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * The whole gate: per-session budget (DIR-L29) then cross-session concurrency.
 *
 * Order is deliberate. The per-session cap is checked first so its behaviour is
 * unchanged, and a run refused by either check does not consume the other's
 * budget.
 */
export function evaluateFullSuiteRequest(
  sessionId: string,
  command: string,
  options: LockOptions & { maxRunsPerSession?: number } = {},
): GateDecision {
  if (!isFullSuiteCommand(command)) return { allow: true };

  const lockDir = options.lockDir ?? defaultLockDir();
  const maxRuns = options.maxRunsPerSession ?? 2;

  const path = counterPath(lockDir, sessionId);
  const used = readCount(path);
  if (used >= maxRuns) {
    return {
      allow: false,
      reason:
        `DIR-L29: Full test suite limit reached (${used}/${maxRuns}) for this session. ` +
        `Use targeted tests instead:\n  bun test test/specific-file.test.ts\n` +
        `Full suite runs cost ~190s and ~5.4 GB each.`,
    };
  }

  const slot = acquireFullSuiteSlot(sessionId, options);
  if (!slot.ok) {
    const who = (slot.holders ?? [])
      .map((h) => `${h.sessionId} (${h.ageSeconds}s)`)
      .join(", ");
    return {
      allow: false,
      reason:
        `Another full test suite is already running: ${who}.\n` +
        `Concurrent full suites exhausted the VM compressor and rebooted this machine on 2026-10-05 ` +
        `(one suite peaks at ~5.4 GB across 33 processes).\n` +
        `Wait for it to finish, or run targeted tests now:\n  bun test test/specific-file.test.ts`,
    };
  }

  try {
    writeFileSync(path, String(used + 1));
  } catch {
    // Budget tracking is best-effort; the concurrency slot is the real guard.
  }
  return { allow: true };
}

/** Give up this session's slot. Releasing one you do not hold is a no-op. */
export function releaseFullSuiteSlot(
  sessionId: string,
  options: LockOptions = {},
): void {
  const lockDir = options.lockDir ?? defaultLockDir();
  const capacity = options.capacity ?? DEFAULT_CAPACITY;

  for (let i = 0; i < capacity; i++) {
    const path = slotPath(lockDir, i);
    try {
      if (readSlot(path)?.sessionId === sessionId) unlinkSync(path);
    } catch {
      // Nothing to release here.
    }
  }
}
