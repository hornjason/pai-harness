#!/usr/bin/env bun
/**
 * Persist grades, report compliance trends, and hill-climb briefs (#69).
 *
 * This is the Grade phase's tail, lifted out of workflows/ship.js.
 *
 * WHY IT MOVED
 *
 * ship.js runs in the Workflow sandbox, which has no module loading at all —
 * no require, no dynamic import, no fs. Nine top-level require() calls lived
 * in that block and every one of them threw. Unlike the original offender at
 * module scope, which killed the run outright and so was impossible to miss,
 * all nine sat inside try/catch:
 *
 *     } catch (e) {
 *       log(`WARN: Could not persist compliance data: ${e.message}`)
 *     }
 *
 * So the run reported success while compliance persistence, compliance
 * history, hill-climb brief patching and transcript re-grading had never once
 * executed. The harness's own measurement and self-improvement loop was off,
 * quietly, for as long as that code has existed. That is the same family as
 * #78, #82 and #89: green because of what it could not see.
 *
 * WHY IT READS A FILE INSTEAD OF TAKING THE GRADE AS INPUT
 *
 * The obvious port passes ship.js's `gradeResult` in. But `gradeResult` is an
 * agent's re-typed copy of a file that already exists: scripts/
 * grade-deterministic.ts writes `compliance-grade.json` into WORK_DIR, and the
 * Grade agent reads that output and restates it as JSON. Re-reading the file
 * keeps a language model out of the data path, which is the #81 lesson — an
 * LLM inside a boundary is a place for the data to change shape silently.
 *
 * `efficiency` is the one field not in compliance-grade.json — it comes from
 * analyze-transcript.ts. The Grade agent now redirects that output to
 * `efficiency.json` in WORK_DIR and this reads it from there. Passing it as a
 * CLI argument instead would mean interpolating an agent-derived JSON blob
 * into a shell command, which is the same shape as the #81 defect; there is no
 * reason to take that risk for a presentational field. A missing or malformed
 * efficiency.json therefore degrades to null rather than failing the run.
 *
 * Usage:
 *   bun scripts/persist-compliance.ts <workDir> <harnessRoot> <issue>
 *
 * Human-readable progress goes to stderr; stdout carries a single
 * machine-readable receipt line.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

import {
  appendComplianceHistory,
  loadComplianceHistory,
  generateComplianceReport,
  formatComplianceReport,
  detectHillClimbNeeds,
  applyHillClimb,
  type ComplianceEntry,
} from "../lib/compliance-report";
import { writeWorkflowState } from "../gates/orchestrator";
import { loadRoleBriefPaths, type GradeOutput } from "./grade-deterministic";

const COMPLIANCE_THRESHOLD = 70;

type Grade = GradeOutput["grades"][number];

const pct = (g: Grade) => (g.total > 0 ? Math.round((100 * g.followed) / g.total) : 0);

export interface PersistResult {
  ok: boolean;
  persisted: boolean;
  graded: number;
  hillClimbApplied: number;
  verified: string[];
}

/**
 * Read analyze-transcript.ts's output if the Grade agent left it behind.
 *
 * Presentational only, so every failure mode degrades to null: absent file,
 * unreadable file, malformed JSON. Losing an efficiency line must never cost
 * the grade record, which is the artifact that actually matters.
 */
function readEfficiency(workDir: string, logger: (m: string) => void): unknown {
  const path = join(workDir, "efficiency.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    logger(`WARNING efficiency.json is unreadable, recording null: ${(e as Error).message}`);
    return null;
  }
}

export function persistCompliance(
  workDir: string,
  harnessRoot: string,
  issue: string,
  logger: (m: string) => void = m => console.error(m),
): PersistResult {
  const gradePath = join(workDir, "compliance-grade.json");
  if (!existsSync(gradePath)) {
    throw new Error(
      `no compliance-grade.json in ${workDir} — grade-deterministic.ts did not run, ` +
        `so there is nothing to persist`,
    );
  }

  let graded: GradeOutput;
  try {
    graded = JSON.parse(readFileSync(gradePath, "utf-8"));
  } catch (e) {
    throw new Error(`${gradePath} is not valid JSON: ${(e as Error).message}`);
  }
  const grades = graded?.grades ?? [];

  // ── Persist grade data into workflow-state.json for cross-run tracking ──
  const wsPath = join(workDir, "workflow-state.json");
  let persisted = false;
  try {
    const ws = JSON.parse(readFileSync(wsPath, "utf-8"));
    ws.compliance = {
      grades: grades.map(g => ({
        role: g.role,
        followed: g.followed,
        total: g.total,
        pct: pct(g),
        flagged: g.flagged || [],
      })),
      efficiency: readEfficiency(workDir, logger),
      timing: graded.timing || [],
    };
    writeWorkflowState(wsPath, ws);
    persisted = true;
    logger("compliance data written to workflow-state.json");
  } catch (e) {
    // Non-fatal, as it was in ship.js: a missing workflow-state.json should not
    // discard the report below. But it is REPORTED rather than swallowed — the
    // whole defect being fixed here was a warning nobody could see.
    logger(`WARNING could not persist compliance data: ${(e as Error).message}`);
  }

  // ── Compliance report, trend tracking, and hill-climb ──
  const historyPath = join(workDir, "..", "compliance-history.jsonl");
  const verified: string[] = [];
  let hillClimbApplied = 0;

  for (const g of grades) {
    const scores: Record<string, string> = {};
    for (const r of g.rules || []) {
      if (r.id) scores[r.id] = r.verdict || "N/A";
    }
    const entry: ComplianceEntry = {
      timestamp: new Date().toISOString(),
      issue: `#${issue}`,
      role: g.role,
      scores,
      total: g.total,
      followed: g.followed,
      pct: pct(g),
      flagged: g.flagged || [],
    };

    appendComplianceHistory(historyPath, entry);
    // Drop the entry just appended — the report compares current against PRIOR
    // runs, and leaving it in would have every run trending against itself.
    const history = loadComplianceHistory(historyPath).slice(0, -1);
    const report = generateComplianceReport(entry, history, COMPLIANCE_THRESHOLD);
    logger("\n" + formatComplianceReport(report));

    if (report.belowThreshold) {
      logger(`WARNING ${g.role} compliance ${entry.pct}% is below the ${COMPLIANCE_THRESHOLD}% threshold — brief improvement needed`);
    }
    if (report.alerts.length > 0) {
      logger(`${report.alerts.length} compliance alert(s) for ${g.role} — see report above`);
    }

    // Grader accuracy gate: skip hill-climb for COMPs where more than half the
    // recent verdicts are N/A, so briefs are not patched to paper over grader
    // false positives.
    const graderAccuracySkips = new Set<string>();
    for (const ct of report.compTrends) {
      const naCount = ct.lastN.filter(v => v === "N/A").length;
      const ignoredCount = ct.lastN.filter(v => v === "IGNORED").length;
      if (naCount > 0 && ignoredCount > 0 && naCount / (naCount + ignoredCount) > 0.5) {
        graderAccuracySkips.add(ct.compId);
        logger(`GRADER-GATE: skipping hill-climb for ${ct.compId} — ${naCount}/${naCount + ignoredCount} recent verdicts are N/A`);
      }
    }

    const actions = detectHillClimbNeeds(report).filter(a => !graderAccuracySkips.has(a.compId));
    if (actions.length === 0) continue;

    const briefPath = loadRoleBriefPaths(harnessRoot)[g.role];
    if (!briefPath) {
      logger(`no brief registered for role ${g.role} — skipping hill-climb`);
      continue;
    }

    const { applied, skipped } = applyHillClimb(briefPath, actions);
    for (const a of applied) logger(`HILL-CLIMB: ${a}`);
    for (const s of skipped) logger(`HILL-CLIMB skipped: ${s}`);
    if (applied.length === 0) continue;
    hillClimbApplied += applied.length;
    logger(`brief updated for ${g.role} — ${applied.length} reinforcement(s) applied`);

    // Auto-rerun: confirm the patched brief actually scores better.
    //
    // In ship.js this spawned an agent purely to shell out to test-brief.ts.
    // Running it directly removes that round trip — one less agent, and the
    // result no longer has to survive being relayed through generated text.
    try {
      const transcriptDir = join(workDir, "transcripts");
      const transcripts = existsSync(transcriptDir)
        ? readdirSync(transcriptDir).filter(f => f.includes(g.role) && f.endsWith(".jsonl")).sort()
        : [];
      if (transcripts.length === 0) continue;

      const latest = join(transcriptDir, transcripts[transcripts.length - 1]);
      logger(`HILL-CLIMB VERIFY: re-grading ${g.role} with the patched brief`);
      const out = execFileSync(
        "bun",
        [join(harnessRoot, "scripts", "test-brief.ts"), g.role, `--prompt=${latest}`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      verified.push(g.role);
      logger(`HILL-CLIMB RESULT (${g.role}): ${out.trim().slice(0, 300)}`);
    } catch (e) {
      // Verification is best-effort: a failed re-grade must not discard the
      // reinforcement that was already written to the brief.
      logger(`WARNING hill-climb verify failed for ${g.role}: ${(e as Error).message}`);
    }
  }

  return { ok: true, persisted, graded: grades.length, hillClimbApplied, verified };
}

if (import.meta.main) {
  const [workDir, harnessRoot, issue] = process.argv.slice(2);
  if (!workDir || !harnessRoot || !issue) {
    console.error("usage: bun scripts/persist-compliance.ts <workDir> <harnessRoot> <issue>");
    process.exit(2);
  }

  try {
    const result = persistCompliance(workDir, harnessRoot, issue);
    // Single machine-readable receipt. The caller reaches this through an agent
    // step, so stdout comes back as generated text — keep it to facts the
    // caller can act on without parsing prose.
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(`persist-compliance: ${(e as Error).message}`);
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exit(1);
  }
}
