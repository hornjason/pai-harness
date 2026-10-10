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
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

const DEFAULT_CAPACITY = 2;
const DEFAULT_TTL_SECONDS = 420;

/**
 * How far back the DIR-L29 budget looks. Issue #73: this used to be "forever",
 * which turned a rate limit into a one-way lockout — and because subagents
 * carry the parent session's id, the whole pipeline shared one lifetime budget
 * and ran out partway through.
 *
 * 30 minutes is a little longer than two full suites back to back (~190s each
 * plus the agent work between them), so it still stops thrashing while letting
 * a long session come back for a legitimate later run.
 */
const DEFAULT_BUDGET_WINDOW_MS = 30 * 60_000;

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
   * Which worker inside the session is asking (#239). Sub-agents share their
   * parent's session id, so without this the whole fan-out shares one rate
   * budget. Derived from the hook payload by `workerIdFromHook`; absent means
   * "unknown worker", which reproduces the pre-#239 per-session behaviour.
   */
  workerId?: string;
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

/**
 * One path segment, with every character that could mean something to a
 * filesystem removed.
 *
 * `.` is not in the allowed set, which is deliberate overkill: no surviving
 * segment can be `.` or `..`, so no composition of them can walk anywhere.
 * Bounded too — a session id is attacker-adjacent only in the sense that it
 * arrives from outside this module, but an unbounded name is an ENAMETOOLONG
 * away from a write that throws and is swallowed as best-effort.
 */
function safeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unkeyed";
}

/** Short, stable, collision-resistant, and filename-safe by construction. */
function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * The identity a budget and a slot are recorded under (#239).
 *
 * THE BUDGET IS PER WORKER, NOT PER SESSION, for the same reason a slot is one
 * running suite and not one session (#67-B): workflow sub-agents reach
 * PreToolUse carrying the PARENT session's id. Keyed on the session alone, a
 * ship run that fans out to three implementers gave three agents two runs per
 * 30 minutes between them, spent by whoever asked first. On run wf_18abb197-f03
 * that left sub-agent 235002 asleep in `sleep 580` loops for ~22 minutes,
 * twenty of them after its siblings had finished.
 *
 * Raising `maxRunsPerSession` would have been the wrong fix: the budget exists
 * because concurrent full suites exhausted the VM compressor and rebooted this
 * machine on 2026-10-05. The budget is right; its key was wrong. Concurrency is
 * unaffected — the cap counts slot FILES, so more keys cannot buy more suites.
 *
 * The result is ONE FILENAME-SAFE SEGMENT, always. A worker identity is a
 * working directory, so it arrives full of separators, and the counter path is
 * `join(lockDir, 'rungate-test-suite-count-' + key)`. Interpolating a raw cwd
 * there has two silent failure modes: the write lands outside the lock
 * directory (`/../../x` resolves to a sibling of it), or it lands in a
 * directory that does not exist, throws, is swallowed by the best-effort catch
 * around budget tracking, and the cap quietly stops counting while every
 * message still looks normal. Hence the hash: unbounded, hostile input in, one
 * `[A-Za-z0-9_-]` segment out, and still distinct per worker.
 *
 * An absent `workerId` reproduces the pre-#239 key exactly, so a hook that
 * cannot learn a worker identity degrades to the old shared budget rather than
 * to no budget at all.
 */
export function budgetKey(sessionId: string, workerId?: string): string {
  const session = safeSegment(sessionId);
  if (!workerId) return session;
  return `${session}-${fingerprint(workerId)}`;
}

/** The key this call's options name, for the slot file and the counter alike. */
function identityOf(sessionId: string, options: LockOptions): string {
  return budgetKey(sessionId, options.workerId);
}

/**
 * What distinguishes one worker from its siblings inside a hook payload (#239).
 *
 * `session_id` cannot: a sub-agent's Bash call reaches PreToolUse carrying the
 * PARENT session's id — all 292 records of a live three-agent run did (#67-B).
 * Two things in the payload do vary per worker, and both are used:
 *
 *   cwd             — pipeline sub-agents run in their own git worktree, which
 *                     is exactly how #239 was observed: three implementers,
 *                     three worktrees, one shared budget.
 *   transcript_path — the agent's own JSONL. Separates two workers that happen
 *                     to share a directory, which cwd alone cannot.
 *
 * Hashed together rather than used raw, because the result becomes a filename;
 * see `budgetKey`.
 *
 * The honest cost: a new transcript path for the same worker (a resume, a
 * compaction that rotates the file) reads as a new worker and hands it a fresh
 * window. That is bounded — two extra runs — and it cannot touch the thing the
 * budget was protecting, because concurrency is capped by counting slot FILES
 * and no number of keys adds a slot. Undetectable drift in the other direction
 * would be worse: a worker wrongly merged with a sibling sleeps for half an
 * hour and the run looks slow for no visible reason.
 *
 * Returns undefined when the payload carries neither, which degrades to the
 * pre-#239 per-session budget rather than to no budget at all.
 */
export function workerIdFromHook(input: {
  cwd?: string;
  transcript_path?: string;
}): string | undefined {
  const parts = [input.cwd, input.transcript_path].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join("\u0000") : undefined;
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

/**
 * True when no full suite is running anywhere, so every slot is provably false.
 *
 * A detector that throws means "cannot determine", which must read as "keep the
 * slots": reclaiming on an unreadable process table would let two real suites
 * run against a cap of one.
 */
function noSuiteRunningNow(options: LockOptions): boolean {
  try {
    return (options.suitesRunning ?? anySuiteRunning)() === false;
  } catch {
    return false;
  }
}

/**
 * The one staleness rule, so the acquirer and the read-only predicate cannot
 * drift apart. A prediction that disagrees with the gate is worse than no
 * prediction — it reports a deadlock the gate does not actually have.
 */
function slotIsStale(
  ageSeconds: number,
  ttlSeconds: number,
  noSuiteRunning: boolean,
): boolean {
  return (
    ageSeconds >= ttlSeconds ||
    (noSuiteRunning && ageSeconds >= LIVENESS_GRACE_SECONDS)
  );
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
  // The slot records the WORKER, not the session (#239), so that two
  // sub-agents sharing a parent session id can each release exactly the slot
  // they took. The cap is unaffected: it counts slot files.
  const identity = identityOf(sessionId, options);

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
    const noSuiteRunning = noSuiteRunningNow(options);

    for (let i = 0; i < capacity; i++) {
      const path = slotPath(lockDir, i);
      const entry = readSlot(path);
      const ageSeconds = entry ? Math.floor((now - entry.startedAt) / 1000) : Infinity;
      const stale = !entry || slotIsStale(ageSeconds, ttlSeconds, noSuiteRunning);

      const claim = JSON.stringify({ sessionId: identity, startedAt: now });

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
          if (readSlot(path)?.sessionId === identity) return { ok: true };
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

/**
 * Where one worker's rolling window lives.
 *
 * `key` is a `budgetKey` result and nothing else: one filename-safe segment,
 * so this `join` cannot be steered anywhere but inside `lockDir` (#239).
 */
function counterPath(lockDir: string, key: string): string {
  return join(lockDir, `rungate-test-suite-count-${key}`);
}

/**
 * Timestamps of the runs this session has spent, newest last.
 *
 * Three file shapes have to be read, and the difference between them matters:
 *
 *   missing          -> no runs. Genuinely nothing spent.
 *   `{"runs":[...]}` -> the current format.
 *   `2`              -> written before #73. Dated from the file's mtime, which
 *                       is when that run actually happened, so an existing
 *                       lockout ages out instead of being reset to a free
 *                       budget the moment this ships.
 *
 * Anything else is corrupt, and corrupt returns a FULL budget rather than an
 * empty one. An unreadable counter that parses as "zero runs spent" is the
 * check-that-reports-success-without-checking shape (#65, #71): a one-character
 * edit would silently disable the cap while every message still looked normal.
 *
 * Every bound below exists because the counter lives in a world-writable
 * TMPDIR and TestSuiteGuard ends in `catch { process.exit(0) }`. That catch is
 * a deliberate fail-open so a broken guard can never wedge the repo — which
 * means ANY throw in here silently removes the cap, with nothing printed.
 * Crashing is therefore the most dangerous thing this function can do, worse
 * than reading a wrong number, so it allocates nothing it has not bounded.
 * Found by the security review of b95438cf.
 */

/** Generous for the real format (~20 bytes/run); far below a memory problem. */
const MAX_COUNTER_BYTES = 64 * 1024;

/** Entries kept per session. Only `maxRuns` can ever be spent; the rest is slack. */
const MAX_TRACKED_RUNS = 8;

function readRuns(path: string, maxRuns: number): number[] {
  const budget = Math.max(0, Math.min(maxRuns, MAX_TRACKED_RUNS));
  let raw: string;
  let mtimeMs: number;
  try {
    const stat = statSync(path);
    // Checked before the read, not after: the point is to not load it.
    if (stat.size > MAX_COUNTER_BYTES) {
      return Array.from({ length: budget }, () => stat.mtimeMs);
    }
    mtimeMs = stat.mtimeMs;
    raw = readFileSync(path, "utf-8").trim();
  } catch {
    return [];
  }
  if (!raw) return [];

  // Legacy: a bare integer, with no record of when those runs happened.
  // Clamped — `99999999999` is a RangeError at the allocation, not a big array.
  if (/^\d+$/.test(raw)) {
    const count = Math.min(parseInt(raw, 10) || 0, budget);
    return Array.from({ length: count }, () => mtimeMs);
  }

  try {
    const parsed = JSON.parse(raw) as { runs?: unknown };
    const runs = parsed?.runs;
    if (
      Array.isArray(runs) &&
      runs.length <= MAX_COUNTER_BYTES &&
      runs.every((t) => typeof t === "number" && Number.isFinite(t))
    ) {
      // Newest first, then trimmed: the oldest entries are the ones about to
      // expire anyway, and this keeps every later read cheap.
      return (runs as number[]).slice().sort((a, b) => a - b).slice(-MAX_TRACKED_RUNS);
    }
  } catch {
    // fall through to the fail-closed path
  }

  // Fail closed: spend the whole budget so a corrupt file blocks rather than
  // waves everything through. Dated from mtime, so it clears after one window
  // instead of wedging the session permanently.
  return Array.from({ length: budget }, () => mtimeMs);
}

/** `Math.min(...xs)` throws on a large array — every element is an argument. */
function earliest(values: number[]): number | null {
  let min: number | null = null;
  for (const v of values) if (min === null || v < min) min = v;
  return min;
}

/** Plain-English wait, for a refusal that would otherwise offer no way out. */
function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export interface GateOptions extends LockOptions {
  maxRunsPerSession?: number;
  /** Rolling window the budget is measured over (#73). */
  budgetWindowMs?: number;
  /** Injected clock, so the window is testable without sleeping. */
  now?: number;
}

interface BudgetView {
  /** In-window runs, oldest first — what a new run is appended to. */
  recent: number[];
  /** The DIR-L29 refusal, present only when the budget is spent. */
  refusal?: GateDecision;
}

/**
 * What this session has spent inside the rolling window, and whether that is
 * already too much.
 *
 * The window arithmetic lives here and nowhere else. Two copies of it — one
 * that decides and one that reports — is how a predicate starts telling people
 * something the gate does not do.
 */
function budgetView(sessionId: string, options: GateOptions): BudgetView {
  const lockDir = options.lockDir ?? defaultLockDir();
  const maxRuns = options.maxRunsPerSession ?? 2;
  const windowMs = options.budgetWindowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const now = options.now ?? Date.now();

  // Runs older than the window are forgotten, which is the whole of #73: the
  // budget is a rate limit again rather than a lifetime total.
  const recent = readRuns(
    counterPath(lockDir, identityOf(sessionId, options)),
    maxRuns,
  ).filter((t) => t > now - windowMs);
  if (recent.length < maxRuns) return { recent };

  const oldest = earliest(recent);
  // `recent` is empty only when maxRuns is 0 — a configured stop, with no run
  // to wait for. Saying "frees up in Infinity minutes" taught people to stop
  // reading the refusal.
  const when =
    oldest === null
      ? "Full suite runs are disabled for this session (budget 0)."
      : `One run frees up in ${describeWait(oldest + windowMs - now)}.`;
  return {
    recent,
    refusal: {
      allow: false,
      reason:
        `DIR-L29: Full test suite limit reached (${recent.length}/${maxRuns}) in the last ` +
        `${describeWait(windowMs)}. ${when}\n` +
        `Use targeted tests until then:\n  bun test test/specific-file.test.ts\n` +
        `Full suite runs cost ~190s and ~5.4 GB each.`,
    },
  };
}

/** The "no slot for you" refusal, worded for whoever is holding them. */
function concurrencyRefusal(
  sessionId: string,
  holders: SlotHolder[],
): GateDecision {
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
  const who = holders.map((h) => `${h.sessionId} (${h.ageSeconds}s)`).join(", ");
  return {
    allow: false,
    reason:
      `Another full test suite is already running: ${who}.\n` +
      `Concurrent full suites exhausted the VM compressor and rebooted this machine on 2026-10-05 ` +
      `(one suite peaks at ~5.4 GB across 33 processes).\n` +
      `Wait for it to finish, or run targeted tests now:\n  bun test test/specific-file.test.ts`,
  };
}

/**
 * Would this command be allowed right now? Answers without changing the answer.
 *
 * `evaluateFullSuiteRequest` reads as a predicate and behaves as a transaction:
 * it takes one of two machine-wide slots and spends a unit of the DIR-L29
 * budget. On 2026-10-05 a three-call diagnostic that only wanted the verdict
 * took both slots, and every other session was refused by a message naming two
 * holders that were running nothing (#103).
 *
 * This reads the same slot files and the same counter — it must, or it would be
 * answering about a different world — but it writes nothing and creates
 * nothing. Both verdicts come from the same `budgetView`, `slotIsStale` and
 * refusal builders the gate uses, so the prediction cannot drift from the act.
 *
 * It is a prediction, not a reservation: between asking and running, another
 * session may take the last slot. Callers that intend to RUN must still call
 * `evaluateFullSuiteRequest`, which re-checks atomically.
 */
export function wouldAllowFullSuite(
  sessionId: string,
  command: string,
  options: GateOptions = {},
): GateDecision {
  if (!isFullSuiteCommand(command)) return { allow: true };

  const budget = budgetView(sessionId, options);
  if (budget.refusal) return budget.refusal;

  const lockDir = options.lockDir ?? defaultLockDir();
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = options.now ?? Date.now();

  // The slots the acquirer would refuse to overwrite: present, parseable, and
  // neither past the TTL nor provably dead.
  const noSuiteRunning = noSuiteRunningNow(options);
  const holders = heldSlots(lockDir, now, capacity, ttlSeconds).filter(
    (h) => !slotIsStale(h.ageSeconds, ttlSeconds, noSuiteRunning),
  );
  if (holders.length >= capacity) {
    return concurrencyRefusal(identityOf(sessionId, options), holders);
  }

  return { allow: true };
}

/**
 * The whole gate: per-session budget (DIR-L29) then cross-session concurrency.
 *
 * Order is deliberate. The per-session cap is checked first so its behaviour is
 * unchanged, and a run refused by either check does not consume the other's
 * budget. Both checks are `wouldAllowFullSuite`; what this adds is the
 * side effects — claiming a slot and spending a unit of budget.
 */
export function evaluateFullSuiteRequest(
  sessionId: string,
  command: string,
  options: GateOptions = {},
): GateDecision {
  const predicted = wouldAllowFullSuite(sessionId, command, options);
  if (!predicted.allow) return predicted;
  // Targeted runs are neither capped nor counted, so there is nothing to spend.
  if (!isFullSuiteCommand(command)) return { allow: true };

  const lockDir = options.lockDir ?? defaultLockDir();
  const now = options.now ?? Date.now();

  // The prediction above is advisory; this is the atomic claim. Another session
  // can take the last slot in between, and then the acquirer's answer wins.
  const slot = acquireFullSuiteSlot(sessionId, options);
  if (!slot.ok) {
    return concurrencyRefusal(identityOf(sessionId, options), slot.holders ?? []);
  }

  try {
    // Only the in-window runs are carried forward, and never more than the
    // tracked maximum, so neither a long session nor a poisoned file can leave
    // an expensive read behind.
    const runs = [...budgetView(sessionId, options).recent, now].slice(
      -MAX_TRACKED_RUNS,
    );
    writeFileSync(
      counterPath(lockDir, identityOf(sessionId, options)),
      JSON.stringify({ runs }),
    );
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
  // Must be derived the same way the acquirer derived it (#239). If the two
  // disagree the slot is unreleasable and leaks for a full TTL, which is the
  // 420s wedge the release hook exists to avoid.
  const identity = identityOf(sessionId, options);

  let newestPath: string | null = null;
  let newestStartedAt = -Infinity;

  for (let i = 0; i < capacity; i++) {
    const path = slotPath(lockDir, i);
    const entry = readSlot(path);
    if (!entry || entry.sessionId !== identity) continue;
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
