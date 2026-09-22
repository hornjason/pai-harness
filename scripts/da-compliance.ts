#!/usr/bin/env bun
/**
 * DA Compliance Skill — audits DA session transcripts against role-specific
 * evaluation criteria and produces a structured compliance dashboard.
 *
 * Usage:
 *   bun scripts/da-compliance.ts <transcript-dir> [--role=da|marcus|quinn] [--dashboard] [--json]
 *
 * Reads all agent-*.jsonl files from the given directory, runs role-aware
 * grading via shared eval criteria from lib/eval-criteria.ts, and outputs
 * per-criterion verdicts with an overall compliance score.
 */
import { readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { auditAgent, type AgentAudit, type Role } from "./audit-transcript.js";
import { ROLES, getCriteria } from "../lib/eval-criteria.js";

interface ComplianceOutput {
  date: string;
  directory: string;
  sessionsAudited: number;
  overallScore: number;
  overallGrade: string;
  perRole: Record<string, RoleCompliance>;
  perCriterion: CriterionCompliance[];
}

interface RoleCompliance {
  sessions: number;
  avgScore: number;
  grade: string;
}

interface CriterionCompliance {
  id: string;
  rule: string;
  source: string;
  followed: number;
  ignored: number;
  total: number;
  complianceRate: string;
}

function computeCompliance(audits: AgentAudit[]): ComplianceOutput {
  const date = new Date().toISOString().split("T")[0];
  const overallScore = audits.length > 0
    ? Math.round(audits.reduce((s, a) => s + a.score, 0) / audits.length)
    : 0;
  const overallGrade = overallScore >= 90 ? "A" : overallScore >= 75 ? "B" : overallScore >= 60 ? "C" : overallScore >= 40 ? "D" : "F";

  // Per-role aggregation
  const roleGroups: Record<string, AgentAudit[]> = {};
  for (const a of audits) {
    const role = a.role;
    if (!roleGroups[role]) roleGroups[role] = [];
    roleGroups[role].push(a);
  }

  const perRole: Record<string, RoleCompliance> = {};
  for (const [role, group] of Object.entries(roleGroups)) {
    const avg = Math.round(group.reduce((s, a) => s + a.score, 0) / group.length);
    perRole[role] = {
      sessions: group.length,
      avgScore: avg,
      grade: avg >= 90 ? "A" : avg >= 75 ? "B" : avg >= 60 ? "C" : avg >= 40 ? "D" : "F",
    };
  }

  // Per-criterion aggregation across all audits
  const criterionMap = new Map<string, CriterionCompliance>();
  for (const audit of audits) {
    for (const r of audit.rules) {
      const existing = criterionMap.get(r.id);
      if (existing) {
        existing.total++;
        if (r.verdict === "FOLLOWED") existing.followed++;
        else existing.ignored++;
        existing.complianceRate = `${Math.round((existing.followed / existing.total) * 100)}%`;
      } else {
        criterionMap.set(r.id, {
          id: r.id,
          rule: r.rule,
          source: r.source,
          followed: r.verdict === "FOLLOWED" ? 1 : 0,
          ignored: r.verdict === "IGNORED" ? 1 : 0,
          total: 1,
          complianceRate: r.verdict === "FOLLOWED" ? "100%" : "0%",
        });
      }
    }
  }

  return {
    date,
    directory: audits.length > 0 ? "transcript-dir" : "",
    sessionsAudited: audits.length,
    overallScore,
    overallGrade,
    perRole,
    perCriterion: Array.from(criterionMap.values()),
  };
}

function formatDashboard(compliance: ComplianceOutput): string {
  const lines: string[] = [];
  lines.push("# DA Compliance Dashboard");
  lines.push(`\nDate: ${compliance.date}`);
  lines.push(`Sessions audited: ${compliance.sessionsAudited}`);
  lines.push(`Overall score: ${compliance.overallScore}% (${compliance.overallGrade})`);

  lines.push("\n## Per-Role Summary");
  lines.push("| Role | Sessions | Avg Score | Grade |");
  lines.push("|------|----------|-----------|-------|");
  for (const [role, data] of Object.entries(compliance.perRole)) {
    lines.push(`| ${role} | ${data.sessions} | ${data.avgScore}% | ${data.grade} |`);
  }

  lines.push("\n## Per-Criterion Compliance");
  lines.push("| ID | Rule | Followed | Ignored | Compliance |");
  lines.push("|----|------|----------|---------|------------|");
  for (const c of compliance.perCriterion) {
    lines.push(`| ${c.id} | ${c.rule} | ${c.followed} | ${c.ignored} | ${c.complianceRate} |`);
  }

  // Highlight failures
  const failures = compliance.perCriterion.filter((c) => c.ignored > 0);
  if (failures.length > 0) {
    lines.push("\n## Lowest Compliance Criteria");
    const sorted = [...failures].sort(
      (a, b) => parseInt(a.complianceRate) - parseInt(b.complianceRate)
    );
    for (const f of sorted.slice(0, 5)) {
      lines.push(`- **${f.id}** ${f.rule}: ${f.complianceRate} (${f.followed}/${f.total})`);
    }
  }

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const helpFlag = args.includes("--help") || args.includes("-h");
  const dashboardFlag = args.includes("--dashboard");
  const jsonFlag = args.includes("--json");
  const roleFlag = args.find((a) => a.startsWith("--role="));
  const roleOverride = roleFlag ? (roleFlag.split("=")[1] as Role) : undefined;
  const dir = args.find((a) => !a.startsWith("--") && !a.startsWith("-"));

  if (helpFlag) {
    console.log("da-compliance — DA session transcript compliance auditor");
    console.log("");
    console.log("Usage: bun scripts/da-compliance.ts <transcript-dir> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --role=ROLE     Override role detection (da, marcus, quinn)");
    console.log("  --dashboard     Show compliance dashboard with per-criterion rates");
    console.log("  --json          Output structured JSON instead of markdown");
    console.log("  --help, -h      Show this help");
    console.log("");
    console.log("Examples:");
    console.log("  bun scripts/da-compliance.ts ./transcripts --dashboard");
    console.log("  bun scripts/da-compliance.ts ./transcripts --role=da --json");
    process.exit(0);
  }

  if (!dir) {
    console.error("Usage: bun scripts/da-compliance.ts <transcript-dir> [--role=da|marcus|quinn] [--dashboard] [--json]");
    process.exit(1);
  }

  if (roleOverride && !ROLES.includes(roleOverride)) {
    console.error(`Invalid role: ${roleOverride}. Must be one of: ${ROLES.join(", ")}`);
    process.exit(1);
  }

  const resolvedDir = resolve(dir);
  if (!existsSync(resolvedDir)) {
    console.error(`Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const files = readdirSync(resolvedDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`No agent-*.jsonl files found in ${resolvedDir}`);
    process.exit(1);
  }

  const audits = files.map((f) => auditAgent(join(resolvedDir, f), roleOverride));
  const compliance = computeCompliance(audits);
  compliance.directory = resolvedDir;

  if (jsonFlag) {
    console.log(JSON.stringify(compliance, null, 2));
  } else if (dashboardFlag) {
    console.log(formatDashboard(compliance));
  } else {
    // Default: show both summary and detailed per-agent results
    console.log(formatDashboard(compliance));
    console.log("\n---\n");
    for (const audit of audits) {
      console.log(`### ${audit.label} [${audit.role}] — ${audit.grade} (${audit.score}%)`);
      for (const r of audit.rules) {
        console.log(`  ${r.verdict === "FOLLOWED" ? "PASS" : "FAIL"} ${r.id} ${r.rule}: ${r.evidence}`);
      }
      console.log("");
    }
  }

  // Write output file
  const outPath = join(resolvedDir, "da-compliance-output.json");
  Bun.write(outPath, JSON.stringify(compliance, null, 2));
  console.error(`\nCompliance output written to: ${outPath}`);
}
