/**
 * Rule health trend aggregation — reads daily rule-health JSON files
 * and produces trend data with per-rule score trajectories.
 *
 * Deep module: 1 export (aggregateTrend), simple interface hiding
 * file discovery, parsing, and trend classification.
 *
 * AC-6: aggregateTrend export
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

// ── Types ───────────────────────────────────────────────

export type TrendDirection = "improving" | "declining" | "stable";

export interface RuleTrajectory {
  scores: number[];
  verdicts: string[];
  trend: TrendDirection;
  latestScore: number;
  delta: number;
}

export interface TrendData {
  dates: string[];
  trajectories: Record<string, RuleTrajectory>;
  overallTrend: TrendDirection;
  timestamp: string;
}

interface DailyRuleEntry {
  score: number;
  verdict: string;
}

interface DailyFile {
  date: string;
  rules: Record<string, DailyRuleEntry>;
}

// ── Trend classification ────────────────────────────────

const STABLE_THRESHOLD = 5; // Score change <= 5 is considered stable

function classifyTrend(scores: number[]): TrendDirection {
  if (scores.length < 2) return "stable";

  const first = scores[0];
  const last = scores[scores.length - 1];
  const delta = last - first;

  if (Math.abs(delta) <= STABLE_THRESHOLD) return "stable";
  return delta > 0 ? "improving" : "declining";
}

// ── Public API ──────────────────────────────────────────

/**
 * Read daily rule-health JSON files from .rungate/rule-health-history
 * and produce trend data with per-rule score trajectories.
 *
 * Files are named YYYY-MM-DD.json and contain:
 * { date, rules: { ruleId: { score, verdict } } }
 *
 * Returns sorted chronological data with trend classification.
 */
export function aggregateTrend(projectRoot: string): TrendData {
  const historyDir = join(projectRoot, ".rungate", "rule-health-history");

  if (!existsSync(historyDir)) {
    return {
      dates: [],
      trajectories: {},
      overallTrend: "stable",
      timestamp: new Date().toISOString(),
    };
  }

  // Discover and sort daily files
  const files = readdirSync(historyDir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // YYYY-MM-DD sorts chronologically

  if (files.length === 0) {
    return {
      dates: [],
      trajectories: {},
      overallTrend: "stable",
      timestamp: new Date().toISOString(),
    };
  }

  // Parse all daily files
  const dailyData: DailyFile[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(historyDir, file), "utf-8");
      const parsed: DailyFile = JSON.parse(content);
      dailyData.push(parsed);
    } catch {
      // Skip malformed files
    }
  }

  const dates = dailyData.map((d) => d.date);

  // Build per-rule trajectories
  const ruleIds = new Set<string>();
  for (const daily of dailyData) {
    for (const ruleId of Object.keys(daily.rules)) {
      ruleIds.add(ruleId);
    }
  }

  const trajectories: Record<string, RuleTrajectory> = {};
  const allDeltas: number[] = [];

  for (const ruleId of ruleIds) {
    const scores: number[] = [];
    const verdicts: string[] = [];

    for (const daily of dailyData) {
      const entry = daily.rules[ruleId];
      if (entry) {
        scores.push(entry.score);
        verdicts.push(entry.verdict);
      }
    }

    const trend = classifyTrend(scores);
    const latestScore = scores[scores.length - 1] ?? 0;
    const delta = scores.length >= 2 ? scores[scores.length - 1] - scores[0] : 0;
    allDeltas.push(delta);

    trajectories[ruleId] = {
      scores,
      verdicts,
      trend,
      latestScore,
      delta,
    };
  }

  // Overall trend from average delta
  const avgDelta = allDeltas.length > 0
    ? allDeltas.reduce((a, b) => a + b, 0) / allDeltas.length
    : 0;

  const overallTrend: TrendDirection =
    Math.abs(avgDelta) <= STABLE_THRESHOLD ? "stable" :
    avgDelta > 0 ? "improving" : "declining";

  return {
    dates,
    trajectories,
    overallTrend,
    timestamp: new Date().toISOString(),
  };
}
