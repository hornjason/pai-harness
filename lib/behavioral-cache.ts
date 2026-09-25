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
import { dirname } from "path";

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
