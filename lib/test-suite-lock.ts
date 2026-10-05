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

/** Leading `FOO=bar` assignments, which precede the real command word. */
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/** Wrappers that delegate to the command word after them. */
const WRAPPER_PREFIX = /^(?:time|nice|exec|command|env|npx|stdbuf|nohup)\s+/;

/** `bash -c "<inner>"` and friends — the suite hides inside the quotes. */
const SHELL_DASH_C = /^(?:ba|z|k|)sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/;

/** A redirection operator, attached target or not: `>`, `2>`, `&>>`, `2>&1`, `2>/dev/null`. */
const REDIRECT = /^(?:\d*|&)>>?(?:&\d+)?(.*)$/;

/**
 * True for a full-suite invocation, false for targeted paths.
 *
 * Fails CLOSED. A missed full suite is unlimited concurrency — the condition that
 * rebooted this machine — whereas a false positive is a loud, recoverable block.
 * So anything that reaches `bun test` at a command position is guarded unless a
 * surviving argument is demonstrably a path.
 *
 * Targeted runs are cheap (415 MB / 7 processes for test/unit) and must never be
 * guarded, which is the only reason this does argument analysis at all.
 */
export function isFullSuiteCommand(command: string): boolean {
  // Split on every construct that can begin a new command word. Newlines matter:
  // multi-line Bash bodies are routine, and omitting them hid `bun test` on any
  // line but the first.
  const segments = command.split(/\n|;|&&|\|\||\||&/);

  for (const segment of segments) {
    if (segmentIsFullSuite(segment)) return true;
  }
  return false;
}

function segmentIsFullSuite(segment: string, depth = 0): boolean {
  if (depth > 3) return false;

  let s = segment.trim();

  // Peel env assignments and pass-through wrappers off the front.
  for (let i = 0; i < 8; i++) {
    const next = s.replace(ENV_PREFIX, "").replace(WRAPPER_PREFIX, "");
    if (next === s) break;
    s = next.trim();
  }

  // `bash -c "bun test"` — recurse into the quoted body.
  const shellC = s.match(SHELL_DASH_C);
  if (shellC) return segmentIsFullSuite(shellC[2], depth + 1);

  if (!/^bun\s+test\b/.test(s)) return false;

  const tokens = s.replace(/^bun\s+test\b/, "").trim().split(/\s+/).filter(Boolean);

  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Flags never make a run targeted.
    if (t.startsWith("-")) continue;

    const redirect = t.match(REDIRECT);
    if (redirect) {
      // `2>/dev/null` carries its target; a bare `>` consumes the next token.
      // Either way the target is a sink, not a test path.
      if (!redirect[1]) i++;
      continue;
    }

    args.push(t);
  }

  const hasPath = args.some(
    (a) => a.includes("/") || /\.(test\.)?(ts|tsx|js|jsx)$/.test(a),
  );
  return !hasPath;
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
        // Re-entrant, but the TTL stays ABSOLUTE from first acquisition. Refreshing
        // it here let a session hold a slot indefinitely by issuing further
        // full-suite commands, which is an unbounded-hold bypass of the cap.
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
  /**
   * Present when the run was allowed only because the guard could not function.
   * Fail-open is deliberate; fail-open-and-quiet is not — an unreadable lock
   * directory would otherwise restore unlimited concurrency invisibly.
   */
  warning?: string;
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

  if (slot.degraded) {
    return {
      allow: true,
      warning:
        `Concurrency guard DEGRADED — lock directory ${lockDir} is unusable, so this run ` +
        `was allowed without taking a slot. The cap is not being enforced right now. ` +
        `Check with other sessions before starting a full suite.`,
    };
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
