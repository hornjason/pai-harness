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
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { execFileSync } from "child_process";
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
  /**
   * Whether any full suite is running on this machine. Injected so tests do
   * not depend on the real process table. Defaults to `anySuiteRunning`.
   */
  suitesRunning?: () => boolean;
}

interface SlotEntry {
  sessionId: string;
  startedAt: number;
}

/**
 * Where slot files live. TMPDIR is shared across sessions on this machine,
 * which is exactly what makes the cap work between them.
 *
 * RUNGATE_LOCK_DIR overrides it. Tests that drive the hook as a subprocess
 * cannot pass `options`, so without an override they compete for the real
 * slots — including the slot held by the very suite running them — and leak a
 * live slot per case, wedging the next run for a full TTL.
 */
function defaultLockDir(): string {
  return process.env.RUNGATE_LOCK_DIR || process.env.TMPDIR || tmpdir() || "/tmp";
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
const WRAPPER_PREFIX = /^(?:time|nice|exec|command|env|npx|stdbuf|nohup|sudo|xargs)\s+/;

/** Wrappers that take one argument of their own before the real command. */
const WRAPPER_WITH_ARG = /^(?:timeout|nice\s+-n)\s+\S+\s+/;

/** `bash -c "<inner>"` and friends — the suite hides inside the quotes. */
const SHELL_DASH_C = /^(?:ba|z|k|)sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/;

/**
 * Every spelling that runs the whole suite. `package.json` defines
 * `test` = `bun test`, so `bun run test` and `npm test` are the same 5.4 GB run
 * under different names — omitting them left the most obvious spelling unguarded.
 *
 * The negative lookahead is what keeps `bun test:structure` out: that script is
 * `bun test test/structure.test.ts`, a targeted run that must not be blocked.
 */
const SUITE_INVOCATION =
  /^(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test(?![:\w-])/;

/** A redirection operator, attached target or not: `>`, `2>`, `&>>`, `2>&1`, `2>/dev/null`. */
const REDIRECT = /^(?:\d*|&)>>?(?:&\d+)?(.*)$/;

/**
 * Split on command separators that are NOT inside quotes.
 *
 * Quote-blindness cut both ways: `git commit -m "lint && bun test"` was blocked
 * because the `&&` inside the message split the command, and
 * `bash -c "bun test; echo done"` went unguarded because the `;` inside the body
 * split it before the shell-wrapper pattern could match a balanced quoted string.
 */
function splitTopLevel(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];

    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // Backslash-newline is a line continuation, not a separator (#82). Splitting
    // on it stranded the paths of `bun test \` on the next segment, leaving a
    // zero-argument `bun test` that fails closed — so routine multi-line Bash
    // charged targeted runs to the full-suite budget. Collapse to a space rather
    // than nothing, or the tokens either side would glue into one.
    if (c === "\\" && command[i + 1] === "\n") {
      cur += " ";
      i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|") {
      if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

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
  // Newlines matter: multi-line Bash bodies are routine, and omitting them hid
  // `bun test` on any line but the first.
  for (const segment of splitTopLevel(command)) {
    if (segmentIsFullSuite(segment)) return true;
  }
  return false;
}

function segmentIsFullSuite(segment: string, depth = 0): boolean {
  if (depth > 3) return false;

  let s = segment.trim();

  // Peel env assignments and pass-through wrappers off the front.
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(ENV_PREFIX, "")
      .replace(WRAPPER_WITH_ARG, "")
      .replace(WRAPPER_PREFIX, "");
    if (next === s) break;
    s = next.trim();
  }

  // `bash -c "bun test; echo done"` — recurse into the quoted body.
  const shellC = s.match(SHELL_DASH_C);
  if (shellC) {
    return splitTopLevel(shellC[2]).some((inner) =>
      segmentIsFullSuite(inner, depth + 1),
    );
  }

  const invocation = s.match(SUITE_INVOCATION);
  if (!invocation) return false;

  const rest = s.slice(invocation[0].length).trim();
  // `npm test -- test/foo.ts` passes args through the runner.
  const tokens = rest.replace(/^--\s+/, "").split(/\s+/).filter(Boolean);

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

/**
 * Seconds a slot is protected from liveness-based reclamation.
 *
 * The slot is taken at PreToolUse, before the suite is spawned, so there is a
 * window where the slot is legitimately held and no `bun test` is in the
 * process table yet. Reclaiming inside that window would break the exact case
 * the lock exists for.
 */
const LIVENESS_GRACE_SECONDS = 25;

/**
 * True when at least one full suite is running anywhere on this machine.
 *
 * ONLY THE ZERO CASE IS USED, deliberately. #67 established that attributing
 * bun processes to sessions is unreliable — the agentgrit suite leaks ~31
 * dangling bun processes per run, which is why slots are files rather than a
 * process count. This does not attribute anything: a slot means a running
 * suite, so if NO suite is running at all, every slot is provably false.
 *
 * Matches on the command line rather than the executable name. `pgrep -f bun`
 * is useless here — it matches powerd's bundle paths, mdbulkimport and any
 * other command containing "bun" as a substring.
 *
 * Throws rather than guessing when the process table cannot be read; the
 * caller treats that as "cannot determine" and keeps the slot.
 */
export function anySuiteRunning(): boolean {
  const out = execFileSync("ps", ["-axo", "command"], { encoding: "utf-8" });
  return out
    .split("\n")
    .some(line => /(^|\/|\s)bun\s+(run\s+)?test(\s|$)/.test(line));
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

    // ONE SLOT IS ONE RUNNING SUITE, NOT ONE SESSION. A single session can
    // legitimately have two suites in flight: a backgrounded run plus a
    // foreground one, or two pipeline agents, which share their parent's
    // session id. Each takes its own slot, so the cap keeps counting suites.
    //
    // Both earlier attempts had the unit wrong. The original re-entrant branch
    // returned ok WITHOUT taking a slot, so A's two suites occupied one slot
    // while B took the other — three suites against a cap of two, the OOM
    // condition this exists to prevent. Replacing it with a flat refusal then
    // over-corrected: Marcus holds the slot, Quinn is refused, and the pipeline
    // reports a test failure that is really a lock collision.
    // #74: a slot leaks for a full TTL when a LATER PreToolUse hook blocks the
    // command — the tool never runs, so PostToolUse never releases. Nothing
    // tells the acquiring hook it was denied, so reconcile here instead.
    //
    // Only the zero case is used, and only after a grace period. If no suite
    // is running anywhere, every slot is provably false; within the grace
    // period the slot may simply be waiting for its own `bun` to appear. If
    // liveness cannot be determined the slots are KEPT: reclaiming on an
    // unreadable process table would let two real suites run against a cap of
    // one, which is the OOM condition this whole mechanism prevents.
    let noSuiteRunning = false;
    try {
      noSuiteRunning = (options.suitesRunning ?? anySuiteRunning)() === false;
    } catch {
      noSuiteRunning = false;
    }

    for (let i = 0; i < capacity; i++) {
      const path = slotPath(lockDir, i);
      const entry = readSlot(path);
      const ageSeconds = entry ? Math.floor((now - entry.startedAt) / 1000) : Infinity;
      const stale =
        !entry ||
        ageSeconds >= ttlSeconds ||
        (noSuiteRunning && ageSeconds >= LIVENESS_GRACE_SECONDS);

      const claim = JSON.stringify({ sessionId, startedAt: now });

      // A corrupt file reads as `entry === null` but still occupies the name, so
      // O_EXCL would fail. Decide on the file's existence, not on parseability.
      if (stale && existsSync(path)) {
        // Reclaiming a stale slot via unlink-then-create was racy: two sessions
        // could each unlink the other's fresh claim and both believe they held
        // slot i. rename(2) is atomic, so exactly one writer survives, and the
        // read-back below tells the loser to move on.
        const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
        try {
          writeFileSync(tmp, claim);
          renameSync(tmp, path);
          if (readSlot(path)?.sessionId === sessionId) return { ok: true };
          continue;
        } catch {
          try {
            unlinkSync(tmp);
          } catch {
            // Temp file already gone.
          }
          continue;
        }
      }

      try {
        const fd = openSync(path, "wx");
        writeSync(fd, claim);
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
    const holders = slot.holders ?? [];
    const self = holders.find((h) => h.sessionId === sessionId);
    if (self) {
      return {
        allow: false,
        reason:
          `Every full-suite slot is in use and one of them is yours ` +
          `(started ${self.ageSeconds}s ago).\n` +
          `A slot is one running suite, not one session — a backgrounded suite keeps its ` +
          `slot until it finishes or the ${DEFAULT_TTL_SECONDS}s TTL expires.\n` +
          `Wait for it, or run targeted tests now:\n  bun test test/specific-file.test.ts`,
      };
    }
    const who = holders
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

/**
 * Give up ONE slot for a finished suite. Releasing one you do not hold is a no-op.
 *
 * Exactly one, not all of them: a session may hold several slots, one per
 * running suite, and only the suite that just finished is done. Freeing every
 * slot the session owns would hand back capacity that is still in use — which
 * is the same over-count that caused the original three-concurrent-suite bug.
 *
 * The newest slot is the one released, since the run that just finished is the
 * most recent acquisition. When that guess is wrong the identity of the freed
 * slot differs but the count does not, and the count is what the cap enforces.
 */
export function releaseFullSuiteSlot(
  sessionId: string,
  options: LockOptions = {},
): void {
  const lockDir = options.lockDir ?? defaultLockDir();
  const capacity = options.capacity ?? DEFAULT_CAPACITY;

  let newestPath: string | null = null;
  let newestStartedAt = -Infinity;

  for (let i = 0; i < capacity; i++) {
    const path = slotPath(lockDir, i);
    const entry = readSlot(path);
    if (!entry || entry.sessionId !== sessionId) continue;
    if (entry.startedAt > newestStartedAt) {
      newestStartedAt = entry.startedAt;
      newestPath = path;
    }
  }

  if (!newestPath) return;
  try {
    unlinkSync(newestPath);
  } catch {
    // Already gone, or reclaimed by the TTL — either way nothing is held.
  }
}
