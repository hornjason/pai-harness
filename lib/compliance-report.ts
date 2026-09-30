import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

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
    if (ct.passRate <= ALERT_THRESHOLD && ct.lastN.length >= 2) {
      alerts.push(
        `${ct.compId}: ${Math.round(ct.passRate * 100)}% pass rate — ${ct.rule} needs improvement`
      );
    }
    if (ct.direction === "declining") {
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

  if (report.compTrends.length > 0) {
    lines.push("");
    lines.push("Per-COMP breakdown:");
    for (const ct of report.compTrends) {
      const icon = ct.passRate >= 0.8 ? "✅" : ct.passRate >= 0.5 ? "⚠️" : "❌";
      const pctStr = Math.round(ct.passRate * 100);
      lines.push(
        `  ${icon} ${ct.compId.padEnd(8)} ${ct.rule.padEnd(28)} ${pctStr}% pass`
      );
    }
  }

  if (report.alerts.length > 0) {
    lines.push("");
    lines.push("ALERTS:");
    for (const alert of report.alerts) {
      lines.push(`  ⚠️  ${alert}`);
    }
  }

  lines.push(bar);
  return lines.join("\n");
}
