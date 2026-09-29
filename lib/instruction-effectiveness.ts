/**
 * Instruction effectiveness tracking — correlates specific instruction words
 * and phrases with compliance outcomes from auditor data.
 *
 * Deep module: 1 export (trackEffectiveness), simple interface hiding
 * tokenization, stop-word filtering, and compliance correlation.
 *
 * AC-7: trackEffectiveness export
 */

import type { AgentAuditResult } from "./agent-audit.js";

// ── Types ───────────────────────────────────────────────

export interface WordComplianceRate {
  word: string;
  occurrences: number;
  followedCount: number;
  ignoredCount: number;
  complianceRate: number;
}

export interface EffectivenessResult {
  wordRates: WordComplianceRate[];
  totalInstructions: number;
  totalRules: number;
  timestamp: string;
}

// ── Stop words ──────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "shall", "can", "may", "might", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "into", "through", "during", "before", "after",
  "above", "below", "between", "out", "off", "over", "under", "again",
  "further", "then", "once", "here", "there", "when", "where", "why",
  "how", "all", "both", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "but", "and", "or", "if", "it", "its", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "him", "his", "she", "her", "they", "them", "their", "what", "which",
  "who", "whom",
]);

// ── Tokenization ────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ── Public API ──────────────────────────────────────────

/**
 * Correlate specific instruction words and phrases with compliance outcomes
 * from auditor data, producing per-word compliance rates.
 *
 * Matches instructions to audit rules by exact text match (case-insensitive).
 * For each word in matched instructions, tracks how often it appears in
 * FOLLOWED vs IGNORED rules.
 *
 * Returns sorted by compliance rate descending.
 */
export function trackEffectiveness(
  instructions: string[],
  auditRules: AgentAuditResult["rules"],
): EffectivenessResult {
  if (instructions.length === 0 || auditRules.length === 0) {
    return {
      wordRates: [],
      totalInstructions: instructions.length,
      totalRules: auditRules.length,
      timestamp: new Date().toISOString(),
    };
  }

  // Build a map of rule text (lowered) -> verdict
  const ruleVerdicts = new Map<string, "FOLLOWED" | "IGNORED">();
  for (const rule of auditRules) {
    ruleVerdicts.set(rule.rule.toLowerCase(), rule.verdict);
  }

  // Per-word counters
  const wordFollowed = new Map<string, number>();
  const wordIgnored = new Map<string, number>();
  const wordTotal = new Map<string, number>();

  for (const instruction of instructions) {
    const verdict = ruleVerdicts.get(instruction.toLowerCase());
    if (!verdict) continue;

    const tokens = tokenize(instruction);
    for (const token of tokens) {
      wordTotal.set(token, (wordTotal.get(token) || 0) + 1);
      if (verdict === "FOLLOWED") {
        wordFollowed.set(token, (wordFollowed.get(token) || 0) + 1);
      } else {
        wordIgnored.set(token, (wordIgnored.get(token) || 0) + 1);
      }
    }
  }

  // Build rates
  const wordRates: WordComplianceRate[] = [];
  for (const [word, total] of wordTotal.entries()) {
    const followed = wordFollowed.get(word) || 0;
    const ignored = wordIgnored.get(word) || 0;
    wordRates.push({
      word,
      occurrences: total,
      followedCount: followed,
      ignoredCount: ignored,
      complianceRate: total > 0 ? followed / total : 0,
    });
  }

  // Sort by compliance rate descending
  wordRates.sort((a, b) => b.complianceRate - a.complianceRate);

  return {
    wordRates,
    totalInstructions: instructions.length,
    totalRules: auditRules.length,
    timestamp: new Date().toISOString(),
  };
}
