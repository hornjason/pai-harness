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
 */
export function readFreshCache(path: string): BehavioralCache {
  const cache = readCache(path);
  const fresh: BehavioralCache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (!isStale(entry.timestamp)) {
      fresh[id] = entry;
    }
  }
  return fresh;
}
