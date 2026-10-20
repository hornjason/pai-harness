/**
 * behavioral-cache.ts — Cached behavioral results for SC status sync
 *
 * Provides read/write access to .rungate/behavioral-results.json.
 * Cache entries map SC IDs to { passed, evidence, timestamp }.
 * Entries older than 7 days are treated as stale (unmatchable).
 *
 * Deep module: 3 public functions (readCache, writeCache, readFreshCache, isStale),
 * simple interface hiding file I/O and staleness logic.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";

// ── Types ───────────────────────────────────────────────

export interface CacheEntry {
  passed: boolean;
  evidence: string;
  timestamp: string;
}

export type BehavioralCache = Record<string, CacheEntry>;

// ── Constants ───────────────────────────────────────────

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Public API ──────────────────────────────────────────

/**
 * Where the behavioral results cache lives, for a given project root.
 *
 * One binding, because this path had three. `lib/agent-audit.ts` and
 * `scripts/test-brief.ts` WRITE it and `scripts/sync-sc-status.ts` READS it,
 * and each one assembled `join(root, ".rungate", "behavioral-results.json")`
 * for itself with nothing comparing the three. A drift in any one of them
 * writes where nobody reads — and the symptom, an empty cache, is
 * indistinguishable from "no behavioral results recorded yet" (#328).
 */
export function behavioralCachePath(projectRoot: string): string {
  return join(projectRoot, ".rungate", "behavioral-results.json");
}

/**
 * Read the behavioral results cache from disk.
 * Returns empty object if file doesn't exist or is malformed.
 */
export function readCache(path: string): BehavioralCache {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write entries to the behavioral results cache, merging with existing.
 * Creates parent directories if needed.
 */
export function writeCache(path: string, data: BehavioralCache): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const existing = readCache(path);
  const merged = { ...existing, ...data };
  writeFileSync(path, JSON.stringify(merged, null, 2));
}

/**
 * Check if a timestamp is older than 7 days.
 */
export function isStale(timestamp: string): boolean {
  const age = Date.now() - new Date(timestamp).getTime();
  return age >= STALE_THRESHOLD_MS;
}

/**
 * Read cache and filter out stale entries (older than 7 days).
 *
 * Projected off `behavioralReading` rather than asking `isStale` a second
 * time. The census below answers "has this criterion been measured" and so
 * does this function; two deciders that agree are behaviourally one, and a
 * mutation of either would leave the other holding every case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 */
export function readFreshCache(path: string): BehavioralCache {
  const cache = readCache(path);
  const fresh: BehavioralCache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (behavioralReading(entry).startsWith("fresh")) {
      fresh[id] = entry;
    }
  }
  return fresh;
}

// ── The unmeasured census (#758) ────────────────────────

/**
 * What the cache says about one criterion.
 *
 * Four states, not two. `stale` and `absent` are both "nobody has measured
 * this", but they are different facts about why and a reader can act on only
 * one of them, so they are counted apart.
 */
export type BehavioralReadingKind = "fresh-pass" | "fresh-fail" | "stale" | "absent";

/**
 * Whether the cache file could be read at all.
 *
 * `readCache` returns `{}` for a file that is missing AND for one that is
 * corrupt, which is the conflation this census exists to undo — a corrupt
 * cache is never a missing cache (`.claude/rules/config-access.md`). Nothing
 * here goes through `readCache`.
 */
export type BehavioralCacheState = "absent" | "unreadable" | "present";

export interface BehavioralCensus {
  /** The one discriminator. Everything else is a projection of the lists. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  cacheState: BehavioralCacheState;
  counts: Record<BehavioralReadingKind, number>;
  /** Every criterion with no fresh reading, named — a count sends nobody anywhere. */
  unmeasured: string[];
  total: number;
}

/**
 * What the cache says about one criterion — the ONE decider.
 *
 * `readFreshCache`, `behavioralPattern` and the census all route through
 * this. An entry with no parseable timestamp is `absent` rather than fresh:
 * a reading whose date cannot be read is a reading nobody can date, and
 * `new Date("")` is `NaN`, which makes every arithmetic comparison false and
 * would otherwise read as brand new.
 */
export function behavioralReading(entry: CacheEntry | undefined): BehavioralReadingKind {
  if (!entry || typeof entry.timestamp !== "string") return "absent";
  if (Number.isNaN(new Date(entry.timestamp).getTime())) return "absent";
  if (isStale(entry.timestamp)) return "stale";
  return entry.passed ? "fresh-pass" : "fresh-fail";
}

/** Absent, corrupt, or readable — three facts, never folded into two. */
export function behavioralCacheState(path: string): BehavioralCacheState {
  if (!existsSync(path)) return "absent";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
    return "present";
  } catch {
    return "unreadable";
  }
}

/**
 * How many ticked `(behavioral)` criteria actually have a reading (#758).
 *
 * #328 connected the consumption half: a fresh `passed: false` entry now
 * fails the suite. Nothing guarantees an entry is ever WRITTEN — the two
 * writers run during a ship run or a brief test, never during an ordinary
 * `bun test` — so the live state for all 35 ticked behavioral criteria is
 * "no reading", which routed to `behavioral`: reported, ratcheted, and not
 * checked.
 *
 * A criterion nobody has measured and a criterion that passed are different
 * states and only one is reportable, but both were green and a reader could
 * not tell which they had. This is the supply end of *Silent Default
 * Substitution*, and the fix is #597's: not to make the measurement happen,
 * but to make the report say it did not.
 */
export function behavioralCensus(ids: string[], path: string): BehavioralCensus {
  const state = behavioralCacheState(path);
  const cache: BehavioralCache = state === "present"
    ? JSON.parse(readFileSync(path, "utf-8"))
    : {};

  const counts: Record<BehavioralReadingKind, number> = {
    "fresh-pass": 0, "fresh-fail": 0, stale: 0, absent: 0,
  };
  const unmeasured: string[] = [];

  for (const id of ids) {
    const kind = behavioralReading(cache[id]);
    counts[kind]++;
    if (kind === "stale" || kind === "absent") unmeasured.push(id);
  }

  const reasons: string[] = [];
  // An empty population agrees with every bound. Said first, because the two
  // counts below are both 0 for a census that collected nothing and for one
  // in which everything was measured.
  if (ids.length === 0) reasons.push("no ticked (behavioral) criteria were collected — the scan read nothing");
  if (state === "absent") reasons.push("the behavioral results cache does not exist, so no criterion has a reading");
  if (state === "unreadable") reasons.push("the behavioral results cache exists and could not be parsed");
  if (counts.stale > 0) reasons.push(`${counts.stale} criterion(s) have only a stale reading, older than the 7-day threshold`);
  if (counts.absent > 0 && state === "present") reasons.push(`${counts.absent} criterion(s) have no entry in the cache`);

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    cacheState: state,
    counts,
    unmeasured,
    total: ids.length,
  };
}

/**
 * The census as one line for the suite output (#758 SC-1).
 *
 * A figure, not a line per criterion: 35 log lines is something a reader
 * scrolls past, and the number is the thing that moves.
 */
export function behavioralCensusLine(c: BehavioralCensus): string {
  const m = c.counts["fresh-pass"] + c.counts["fresh-fail"];
  return (
    `BEHAVIORAL: ${c.reading} — ${m}/${c.total} criteria have a fresh reading ` +
    `(pass ${c.counts["fresh-pass"]}, fail ${c.counts["fresh-fail"]}, ` +
    `stale ${c.counts.stale}, no entry ${c.counts.absent}; cache ${c.cacheState})`
  );
}
