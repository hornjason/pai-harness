import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export interface ComplianceEntry {
  timestamp: string;
  issue: string;
  role: string;
  scores: Record<string, string>;
  total: number;
  followed: number;
  pct: number;
  flagged: string[];
}

export interface TrendLine {
  compId: string;
  rule: string;
  lastN: string[];
  passRate: number;
  direction: "improving" | "stable" | "declining";
}

export interface ComplianceReport {
  role: string;
  issue: string;
  current: { followed: number; total: number; pct: number };
  threshold: number;
  belowThreshold: boolean;
  trend: { pcts: number[]; direction: string };
  compTrends: TrendLine[];
  alerts: string[];
}

const TREND_WINDOW = 5;
const ALERT_THRESHOLD = 0.4;

export function appendComplianceHistory(
  historyPath: string,
  entry: ComplianceEntry
): void {
  const dir = dirname(historyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(historyPath, JSON.stringify(entry) + "\n");
}

export function loadComplianceHistory(historyPath: string): ComplianceEntry[] {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function computeDirection(pcts: number[]): string {
  if (pcts.length < 2) return "stable";
  const first = pcts.slice(0, Math.ceil(pcts.length / 2));
  const second = pcts.slice(Math.ceil(pcts.length / 2));
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const diff = avg(second) - avg(first);
  if (diff > 5) return "improving";
  if (diff < -5) return "declining";
  return "stable";
}

const COMP_RULES: Record<string, string> = {
  "COMP-1": "AGENTS.md context",
  "COMP-2": "Suite run limit",
  "COMP-3": "Golden fixture pattern",
  "COMP-4": "Spec-drift hash update",
  "COMP-5": "Governing spec context",
  "COMP-6": "No duplicate reads",
  "COMP-7": "No cat/head via Bash",
  "COMP-8": "PROJECT-STATE context",
  "COMP-9": "Tool call budget",
  "COMP-10": "Grep:Read ratio",
  "COMP-11": "Coding principles context",
  "COMP-12": "Grep before Read",
  "COMP-13": "TDD ordering",
};

export function generateComplianceReport(
  current: ComplianceEntry,
  history: ComplianceEntry[],
  threshold: number
): ComplianceReport {
  const roleHistory = history.filter((h) => h.role === current.role);
  const window = roleHistory.slice(-TREND_WINDOW);
  const allPcts = [...window.map((h) => h.pct), current.pct];

  const allCompIds = new Set<string>();
  for (const entry of [...window, current]) {
    for (const id of Object.keys(entry.scores)) allCompIds.add(id);
  }

  const compTrends: TrendLine[] = [];
  for (const compId of [...allCompIds].sort()) {
    const verdicts = [...window, current].map(
      (e) => e.scores[compId] || "N/A"
    );
    const checkable = verdicts.filter((v) => v !== "N/A");
    const passed = checkable.filter((v) => v === "FOLLOWED").length;
    const passRate = checkable.length > 0 ? passed / checkable.length : 0;

    if (checkable.length < 2) {
      compTrends.push({ compId, rule: COMP_RULES[compId] || compId, lastN: verdicts, passRate, direction: "stable" });
      continue;
    }
    const firstHalf = checkable.slice(0, Math.ceil(checkable.length / 2));
    const secondHalf = checkable.slice(Math.ceil(checkable.length / 2));
    const firstRate =
      firstHalf.length > 0
        ? firstHalf.filter((v) => v === "FOLLOWED").length / firstHalf.length
        : 0;
    const secondRate =
      secondHalf.length > 0
        ? secondHalf.filter((v) => v === "FOLLOWED").length / secondHalf.length
        : 0;
    let direction: TrendLine["direction"] = "stable";
    if (secondRate - firstRate > 0.2) direction = "improving";
    else if (firstRate - secondRate > 0.2) direction = "declining";

    compTrends.push({
      compId,
      rule: COMP_RULES[compId] || compId,
      lastN: verdicts,
      passRate,
      direction,
    });
  }

  const alerts: string[] = [];
  for (const ct of compTrends) {
    if (!ct.compId.startsWith("COMP-") && !ct.compId.startsWith("DIR-")) continue;
    if (ct.passRate <= ALERT_THRESHOLD && ct.lastN.length >= 2) {
      alerts.push(
        `${ct.compId}: ${Math.round(ct.passRate * 100)}% pass rate — ${ct.rule} needs improvement`
      );
    }
    if (ct.direction === "declining" && ct.lastN.length >= 3) {
      alerts.push(`${ct.compId}: declining trend — was passing, now failing`);
    }
  }

  if (current.pct < threshold) {
    alerts.unshift(
      `Overall score ${current.pct}% is BELOW ${threshold}% threshold`
    );
  }

  return {
    role: current.role,
    issue: current.issue,
    current: {
      followed: current.followed,
      total: current.total,
      pct: current.pct,
    },
    threshold,
    belowThreshold: current.pct < threshold,
    trend: { pcts: allPcts, direction: computeDirection(allPcts) },
    compTrends,
    alerts,
  };
}

export function formatComplianceReport(report: ComplianceReport): string {
  const lines: string[] = [];
  const bar = "═".repeat(50);

  lines.push(bar);
  lines.push(`COMPLIANCE REPORT — ${report.role} (${report.issue})`);
  lines.push(bar);

  const statusIcon = report.belowThreshold ? "❌ BELOW THRESHOLD" : "✅";
  lines.push(
    `Score: ${report.current.followed}/${report.current.total} (${report.current.pct}%) ${statusIcon}`
  );
  lines.push(`Threshold: ${report.threshold}%`);

  if (report.trend.pcts.length > 1) {
    const arrow =
      report.trend.direction === "improving"
        ? "▲"
        : report.trend.direction === "declining"
          ? "▼"
          : "→";
    lines.push(
      `Trend (last ${report.trend.pcts.length}): ${report.trend.pcts.join("% → ")}% ${arrow} ${report.trend.direction}`
    );
  }

  const compChecks = report.compTrends.filter((ct) => ct.compId.startsWith("COMP-"));
  const dirChecks = report.compTrends.filter((ct) => ct.compId.startsWith("DIR-"));

  if (compChecks.length > 0) {
    lines.push("");
    lines.push("Per-COMP breakdown:");
    for (const ct of compChecks) {
      const icon = ct.passRate >= 0.8 ? "✅" : ct.passRate >= 0.5 ? "⚠️" : "❌";
      const pctStr = Math.round(ct.passRate * 100);
      lines.push(
        `  ${icon} ${ct.compId.padEnd(8)} ${ct.rule.padEnd(28)} ${pctStr}% pass`
      );
    }
  }

  if (dirChecks.length > 0) {
    const dirPass = dirChecks.filter((ct) => ct.passRate >= 0.5).length;
    lines.push(
      `\nDirective checks: ${dirPass}/${dirChecks.length} passing (${dirChecks.length - dirPass} need attention)`
    );
  }

  const compAlerts = report.alerts.filter(
    (a) => a.startsWith("COMP-") || a.startsWith("Overall")
  );
  if (compAlerts.length > 0) {
    lines.push("");
    lines.push("ALERTS:");
    for (const alert of compAlerts) {
      lines.push(`  ⚠️  ${alert}`);
    }
  }

  lines.push(bar);
  return lines.join("\n");
}

// ── Config-driven compliance maps ────────────────────────
// All mappings (DIR→COMP, reinforcements, tier promotions) are read
// from .claude/rungate/compliance.json. Hardcoded fallbacks exist only
// for backward compatibility when the config directory doesn't exist.
import {
  loadComplianceConfig,
  buildDirToCompMap,
  buildReinforcementMap,
  buildTierPromotionMap,
  type ComplianceConfig,
} from "./config-loader.js";

let _complianceCache: ComplianceConfig | null | undefined;
let _projectRoot: string | undefined;

export function setComplianceProjectRoot(root: string): void {
  _projectRoot = root;
  _complianceCache = undefined;
}

function getComplianceConfig(): ComplianceConfig | null {
  if (_complianceCache !== undefined) return _complianceCache;
  if (_projectRoot) {
    _complianceCache = loadComplianceConfig(_projectRoot);
  } else {
    _complianceCache = null;
  }
  return _complianceCache;
}

function getDirToComp(): Record<string, string> {
  const config = getComplianceConfig();
  if (config) return buildDirToCompMap(config);
  return {
    "DIR-L29": "COMP-2",
    "DIR-L25": "COMP-7",
    "DIR-L31": "COMP-6",
    "DIR-L23": "COMP-6",
  };
}

function getReinforcementMap(): Record<string, string> {
  const config = getComplianceConfig();
  if (config) return buildReinforcementMap(config);
  return {
    "COMP-7": "NEVER read a file with cat, head, or tail via Bash — use Read with offset/limit. Piping output into head/tail as a stdin filter is fine (no file operand).",
    "COMP-12": "Grep BEFORE Read for any file not in Key Files. Find the section, then Read with offset/limit.",
    "COMP-13": "Write the test file BEFORE the implementation file. Tool-call order is mechanically checked.",
    "COMP-6": "Read each file exactly ONCE. Use offset/limit to get what you need in one pass.",
    "COMP-9": "Total tool calls must stay under 40. Batch related reads, use targeted tests.",
    // No number here. The guard owns it, the reinforcement points at the
    // guard, and a copy of "TWICE" in an agent's brief outlives any change to
    // the rate — which is how an agent ends up obeying a limit that no longer
    // exists while the grader measures a different one.
    "COMP-2": "Run the full suite (bun test) sparingly. A per-worker rate limit enforces this mechanically and will refuse the run; do not plan around a specific number. Use targeted tests for iteration.",
  };
}

function getTierPromotions(): Record<string, { tier: 2 | 3; promotion: string }> {
  const config = getComplianceConfig();
  if (config) return buildTierPromotionMap(config);
  return {
    "COMP-7": { tier: 3, promotion: "Deploy BashToolGuard hook" },
    "COMP-12": { tier: 2, promotion: "Add grep-before-read reinforcement" },
    "COMP-13": { tier: 2, promotion: "Add TDD-sequence reinforcement" },
    "COMP-6": { tier: 2, promotion: "Add duplicate-read detection reinforcement" },
    "COMP-9": { tier: 3, promotion: "Deploy tool-call budget hook" },
    "COMP-2": { tier: 3, promotion: "Deploy test-run limiter hook" },
  };
}

function getThresholds(): { consecutive: number; promote: number } {
  const config = getComplianceConfig();
  if (config) return { consecutive: config.defaults.consecutiveFailThreshold, promote: config.defaults.tierPromotionThreshold };
  return { consecutive: 3, promote: 5 };
}

function normalizeDirToComp(id: string): string {
  return getDirToComp()[id] || id;
}

// ── Auto hill-climb ──────────────────────────────────────

export interface HillClimbAction {
  compId: string;
  rule: string;
  reinforcement: string;
  consecutiveFails: number;
  tier: 1 | 2 | 3;
  promotion?: string;
}

function countConsecutiveFails(verdicts: string[]): number {
  let count = 0;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    if (verdicts[i] === "IGNORED" || verdicts[i] === "VIOLATED") count++;
    else break;
  }
  return count;
}

export function detectHillClimbNeeds(report: ComplianceReport): HillClimbAction[] {
  const actions: HillClimbAction[] = [];
  const seen = new Set<string>();
  for (const ct of report.compTrends) {
    const compId = normalizeDirToComp(ct.compId);
    if (seen.has(compId)) continue;
    seen.add(compId);
    const reinforcements = getReinforcementMap();
    const promotions = getTierPromotions();
    const thresholds = getThresholds();
    if (!reinforcements[compId]) continue;
    const consecutiveFails = countConsecutiveFails(ct.lastN);
    if (consecutiveFails >= thresholds.promote && promotions[compId]) {
      const promo = promotions[compId];
      actions.push({
        compId,
        rule: ct.rule,
        reinforcement: reinforcements[compId],
        consecutiveFails,
        tier: promo.tier,
        promotion: promo.promotion,
      });
    } else if (consecutiveFails >= thresholds.consecutive) {
      actions.push({
        compId,
        rule: ct.rule,
        reinforcement: reinforcements[compId],
        consecutiveFails,
        tier: 1,
      });
    }
  }
  return actions;
}

export function applyHillClimb(
  briefPath: string,
  actions: HillClimbAction[]
): { applied: string[]; skipped: string[] } {
  if (!existsSync(briefPath) || actions.length === 0)
    return { applied: [], skipped: [] };

  let content = readFileSync(briefPath, "utf-8");
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const action of actions) {
    if (action.tier >= 2) {
      skipped.push(
        `${action.compId}: TIER ${action.tier} PROMOTION needed — ${action.promotion}`
      );
      continue;
    }

    const normalizedReinforcement = action.reinforcement
      .toLowerCase()
      .replace(/[`*"']/g, "");
    const normalizedContent = content.toLowerCase().replace(/[`*"']/g, "");

    if (normalizedContent.includes(normalizedReinforcement.slice(0, 40))) {
      skipped.push(
        `${action.compId}: reinforcement already present in brief`
      );
      continue;
    }

    const efficiencyIdx = content.indexOf("## Efficiency Rules");
    const testingIdx = content.indexOf("## Testing Rules");
    const neverIdx = content.indexOf("## Never Do");

    let insertIdx = -1;
    let prefix = "\n- ";

    if (
      action.compId === "COMP-2" &&
      testingIdx !== -1
    ) {
      const nextSection = content.indexOf("\n## ", testingIdx + 1);
      insertIdx = nextSection !== -1 ? nextSection : content.length;
      prefix = "\n- **REINFORCED (auto):** ";
    } else if (efficiencyIdx !== -1) {
      const nextSection = content.indexOf("\n## ", efficiencyIdx + 1);
      insertIdx = nextSection !== -1 ? nextSection : content.length;
      prefix = "\n- **REINFORCED (auto):** ";
    } else if (neverIdx !== -1) {
      const nextSection = content.indexOf("\n## ", neverIdx + 1);
      insertIdx = nextSection !== -1 ? nextSection : content.length;
      prefix = "\n- **REINFORCED (auto):** ";
    }

    if (insertIdx === -1) {
      skipped.push(`${action.compId}: no suitable section found in brief`);
      continue;
    }

    content =
      content.slice(0, insertIdx) +
      `${prefix}${action.reinforcement}` +
      content.slice(insertIdx);
    applied.push(
      `${action.compId}: added reinforcement (${action.consecutiveFails} consecutive fails)`
    );
  }

  if (applied.length > 0) {
    writeFileSync(briefPath, content);
  }

  return { applied, skipped };
}

// --- WARN-to-FAIL promotion tracking (SC-515, DEC-012) ---

export interface PromotionFinding {
  checkId: string;
  verdict: 'TRUE_POSITIVE' | 'FALSE_POSITIVE';
}

export interface PromotionPrecision {
  checkId: string;
  /** Precision percentage — ratio of true positives to total findings */
  precision: number;
  total: number;
  truePositives: number;
  /** Eligible for WARN-to-FAIL promotion: precision >= 80% AND total >= 10 cycles */
  eligible: boolean;
}

const PROMOTION_PRECISION_THRESHOLD = 80;
const PROMOTION_MIN_CYCLES = 10;

/**
 * Calculate promotion precision for a specific check ID.
 *
 * WARN checks are promoted to FAIL only when mechanical precision tracking
 * shows >80% precision over 10+ cycles (DEC-005, DEC-012).
 *
 * Filters findings by checkId, computes the ratio of TRUE_POSITIVE verdicts,
 * and determines eligibility based on the 80% threshold and minimum sample size.
 */
export function calculatePromotionPrecision(
  checkId: string,
  findings: PromotionFinding[],
): PromotionPrecision {
  const relevant = findings.filter(f => f.checkId === checkId);
  const total = relevant.length;
  const truePositives = relevant.filter(f => f.verdict === 'TRUE_POSITIVE').length;
  const precision = total > 0 ? Math.round((truePositives / total) * 100) : 0;
  const eligible = precision >= PROMOTION_PRECISION_THRESHOLD && total >= PROMOTION_MIN_CYCLES;

  return { checkId, precision, total, truePositives, eligible };
}

/**
 * Get all check IDs that are candidates for WARN-to-FAIL promotion.
 *
 * Scans all findings, groups by checkId, and returns those meeting the
 * promotion criteria: >= 80% precision over >= 10 cycles.
 */
export function getPromotionCandidates(
  findings: PromotionFinding[],
): PromotionPrecision[] {
  const checkIds = new Set(findings.map(f => f.checkId));
  const candidates: PromotionPrecision[] = [];

  for (const checkId of checkIds) {
    const result = calculatePromotionPrecision(checkId, findings);
    if (result.eligible) {
      candidates.push(result);
    }
  }

  return candidates;
}
