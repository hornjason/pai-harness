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
  classifyHillClimbSkipSentence,
  COMPLIANCE_HISTORY_SCHEMA,
  type ComplianceEntry,
  type HillClimbSkipKind,
} from "../lib/compliance-report";
import { writeWorkflowState } from "../gates/orchestrator";
import { loadRoleBriefPaths, type GradeOutput } from "./grade-deterministic";

const COMPLIANCE_THRESHOLD = 70;

type Grade = GradeOutput["grades"][number];

const pct = (g: Grade) => (g.total > 0 ? Math.round((100 * g.followed) / g.total) : 0);

/**
 * The five ways a role can finish the hill-climb having applied nothing (#646).
 *
 * `hillClimbApplied: 0` was the whole answer, and it was the SAME answer for
 * a role with nothing wrong with it and for a role whose every detected
 * reinforcement was dropped. `0` is indistinguishable from success —
 * *Silent Default Substitution*, `.claude/rules/config-access.md`.
 *
 * Measured across ~4000 agent transcripts, `TIER_PROMOTION_RECOMMENDED` is
 * the most common of the five, and it is the one that needs a human: a text
 * patch cannot make the change it asks for.
 */
export const HILL_CLIMB_STATES = [
  "NO_ACTIONS_DETECTED",
  "GRADER_ACCURACY_DROP",
  "TIER_PROMOTION_RECOMMENDED",
  "REINFORCEMENT_ALREADY_PRESENT",
  "NO_SUITABLE_SECTION",
] as const;

export type HillClimbState = (typeof HILL_CLIMB_STATES)[number];

/**
 * The states under which the run did not learn what it set out to learn.
 *
 * A reinforcement that was composed and had nowhere to go is not a clean
 * run and it is not a decision either — it is a measurement that did not
 * happen, and a reading is the only thing that says so. The other four are
 * answers: nothing needed doing, the gate declined, a human has to act, the
 * rule is already there.
 */
export const UNMEASURED_HILL_CLIMB_STATES: readonly HillClimbState[] = [
  "NO_SUITABLE_SECTION",
];

/** One thing that happened, to one role, about one COMP. */
export interface HillClimbOccurrence {
  role: string;
  /** `null` when the occurrence is about the role rather than a rule. */
  compId: string | null;
  detail: string;
}

export type HillClimbStates = Record<HillClimbState, HillClimbOccurrence[]>;

/**
 * Every state as a key with an empty list.
 *
 * An ABSENT key and an empty one are indistinguishable to a reader, so every
 * receipt carries all five and an empty list is a reading
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
export function emptyHillClimbStates(): HillClimbStates {
  const states = {} as HillClimbStates;
  for (const state of HILL_CLIMB_STATES) states[state] = [];
  return states;
}

/**
 * The owning module's skip kinds, as receipt states.
 *
 * This is a renaming, not a second classification: the answer comes from
 * `applyHillClimb`, which is the only thing that knows why it declined.
 */
const SKIP_KIND_STATE: Record<HillClimbSkipKind, HillClimbState> = {
  TIER_PROMOTION: "TIER_PROMOTION_RECOMMENDED",
  REINFORCEMENT_PRESENT: "REINFORCEMENT_ALREADY_PRESENT",
  NO_SECTION: "NO_SUITABLE_SECTION",
};

/**
 * The state a skip line that arrived WITHOUT a structured outcome belongs to.
 *
 * The loop below reads `skipOutcomes`; this is reachable only for a line with
 * no outcome beside it — a skip site that pushed a string and nothing else.
 * It delegates to the owning module rather than carrying its own phrase
 * table, so there is one position spelling the sentences (SC-2093), and it
 * returns `null` rather than guessing: an unrecognised line becomes an
 * UNCLASSIFIED_SKIP, which raises the reading instead of vanishing.
 */
export function classifySkip(line: string): HillClimbState | null {
  const kind = classifyHillClimbSkipSentence(line);
  return kind === null ? null : SKIP_KIND_STATE[kind];
}

export interface HillClimbReceipt {
  states: HillClimbStates;
  /** Skip lines no state claimed. Never silently empty — see the reading. */
  unclassified: HillClimbOccurrence[];
  reading: "MEASURED" | "UNMEASURED";
  /** Empty exactly when the reading is MEASURED. */
  unmeasuredReasons: string[];
}

/**
 * The reading, derived in ONE place from the occurrences.
 *
 * A `reading` field beside a `measured` boolean would be two deciders
 * answering one question, so there is one discriminator and the reasons are
 * a projection of the same walk.
 */
export function hillClimbReceipt(
  states: HillClimbStates,
  unclassified: HillClimbOccurrence[],
): HillClimbReceipt {
  const unmeasuredReasons: string[] = [];
  for (const state of UNMEASURED_HILL_CLIMB_STATES) {
    const occurrences = states[state];
    if (occurrences.length > 0) {
      unmeasuredReasons.push(
        `${state}: ${occurrences.length} reinforcement(s) were composed and had nowhere to go — ` +
          occurrences.map(o => `${o.role}/${o.compId ?? "-"}`).join(", "),
      );
    }
  }
  if (unclassified.length > 0) {
    unmeasuredReasons.push(
      `UNCLASSIFIED_SKIP: ${unclassified.length} skip line(s) no state claimed, so what the ` +
        `hill-climb did with them is unknown — ` +
        unclassified.map(o => `${o.role}/${o.compId ?? "-"}: ${o.detail}`).join("; "),
    );
  }
  return {
    states,
    unclassified,
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
  };
}

export interface PersistResult {
  ok: boolean;
  persisted: boolean;
  graded: number;
  hillClimbApplied: number;
  verified: string[];
  hillClimb: HillClimbReceipt;
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
  const states = emptyHillClimbStates();
  const unclassified: HillClimbOccurrence[] = [];

  for (const g of grades) {
    // #116 — the whole record, not `id → verdict`. The grader already has
    // `rule`, `evidence` and `category`; dropping them here is what made every
    // history entry an unsourced verdict. No `scores` beside it: two copies of
    // one fact in a record can disagree and nothing would notice which was right.
    const entry: ComplianceEntry = {
      timestamp: new Date().toISOString(),
      issue: `#${issue}`,
      role: g.role,
      schema: COMPLIANCE_HISTORY_SCHEMA,
      rules: (g.rules || [])
        .filter(r => r.id)
        .map(r => ({
          id: r.id as string,
          verdict: r.verdict || "N/A",
          rule: r.rule,
          evidence: r.evidence,
          category: r.category,
        })),
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
    const graderAccuracySkips = new Map<string, string>();
    for (const ct of report.compTrends) {
      const naCount = ct.lastN.filter(v => v === "N/A").length;
      const ignoredCount = ct.lastN.filter(v => v === "IGNORED").length;
      if (naCount > 0 && ignoredCount > 0 && naCount / (naCount + ignoredCount) > 0.5) {
        const reason = `${naCount}/${naCount + ignoredCount} recent verdicts are N/A`;
        graderAccuracySkips.set(ct.compId, reason);
        logger(`GRADER-GATE: skipping hill-climb for ${ct.compId} — ${reason}`);
      }
    }

    // Detected first, then filtered: an action the gate dropped is a thing
    // that happened, and reporting it as "nothing was detected" is the state
    // collapse #646 is about.
    const detected = detectHillClimbNeeds(report);
    for (const a of detected) {
      const reason = graderAccuracySkips.get(a.compId);
      if (reason !== undefined) {
        states.GRADER_ACCURACY_DROP.push({ role: g.role, compId: a.compId, detail: reason });
      }
    }
    if (detected.length === 0) {
      states.NO_ACTIONS_DETECTED.push({
        role: g.role,
        compId: null,
        detail: "no COMP reached the consecutive-fail threshold",
      });
      continue;
    }
    const actions = detected.filter(a => !graderAccuracySkips.has(a.compId));
    if (actions.length === 0) continue;

    const briefPath = loadRoleBriefPaths(harnessRoot)[g.role];
    if (!briefPath) {
      logger(`no brief registered for role ${g.role} — skipping hill-climb`);
      continue;
    }

    const { applied, skipped, skipOutcomes } = applyHillClimb(briefPath, actions);
    for (const a of applied) logger(`HILL-CLIMB: ${a}`);
    skipped.forEach((s, i) => {
      logger(`HILL-CLIMB skipped: ${s}`);
      // The structured outcome is the answer; `classifySkip` is only reached
      // by a skip line that arrived without one.
      const outcome = skipOutcomes[i];
      const state = outcome ? SKIP_KIND_STATE[outcome.kind] : classifySkip(s);
      const occurrence: HillClimbOccurrence = {
        role: g.role,
        compId: outcome?.compId ?? null,
        detail: s,
      };
      if (state === null) unclassified.push(occurrence);
      else states[state].push(occurrence);
    });
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

  const hillClimb = hillClimbReceipt(states, unclassified);
  // Said out loud as well as returned: the receipt crosses an agent on the way
  // to the operator, and a reading nobody reports is a reading nobody reads.
  if (hillClimb.reading === "UNMEASURED") {
    logger(`UNMEASURED hill-climb — ${hillClimb.unmeasuredReasons.join("; ")}`);
  }

  return { ok: true, persisted, graded: grades.length, hillClimbApplied, verified, hillClimb };
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
