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
  COMPLIANCE_HISTORY_SCHEMA,
  type ComplianceEntry,
  type HillClimbSkipOutcome,
} from "../lib/compliance-report";
import { writeWorkflowState } from "../gates/orchestrator";
import { loadRoleBriefPaths, type GradeOutput } from "./grade-deterministic";

const COMPLIANCE_THRESHOLD = 70;

type Grade = GradeOutput["grades"][number];

const pct = (g: Grade) => (g.total > 0 ? Math.round((100 * g.followed) / g.total) : 0);

/**
 * The five outcomes a hill-climb attempt can reach without applying anything
 * (#646).
 *
 * Every one of them used to be a `logger()` line and a `continue`, and the
 * receipt said `hillClimbApplied: 0` for all five — the same number it says
 * when a role had nothing wrong with it. A run in which the grader gate
 * dropped every action, a run in which the brief had no section to write
 * into, and a clean run were byte-identical receipts. That is *Silent Default
 * Substitution*: `0` is indistinguishable from success.
 */
export const HILL_CLIMB_STATES = [
  "NO_ACTIONS_DETECTED",
  "GRADER_ACCURACY_DROP",
  "TIER_PROMOTION_RECOMMENDED",
  "REINFORCEMENT_ALREADY_PRESENT",
  "NO_SUITABLE_SECTION",
  // #662 — two sibling paths that reached a `continue` without leaving an
  // occurrence, so a role whose actions were dropped produced the same
  // receipt as a role that needed nothing. They are not skips
  // `applyHillClimb` decided, which is why they are not in
  // `SKIP_OUTCOME_STATE`: the first happens before it is called and the
  // second is the discovery that its answer does not account for its input.
  "NO_BRIEF_REGISTERED",
  "OUTCOMES_UNACCOUNTED",
] as const;

export type HillClimbState = (typeof HILL_CLIMB_STATES)[number];

/**
 * The states that mean the hill-climb did not happen and nobody knows what it
 * would have done.
 *
 * A brief with no insertion point is not a brief that needed no reinforcement
 * — the reinforcement was composed, had nowhere to go, and was dropped. Only
 * one of those two is reportable as a pass, so the receipt says which.
 */
export const UNMEASURED_HILL_CLIMB_STATES: readonly HillClimbState[] = [
  "NO_SUITABLE_SECTION",
  // #662. Both are the same sentence as the one above with a different
  // reason: the actions were detected, survived the grader-accuracy gate,
  // and then nobody ever found out what applying them would have done. A
  // role with no registered brief has not been reinforced and has not been
  // examined, and an `applyHillClimb` whose two arrays do not account for
  // the actions it was handed has returned an answer about fewer actions
  // than it was asked about.
  "NO_BRIEF_REGISTERED",
  "OUTCOMES_UNACCOUNTED",
];

/** One occurrence of a state, carrying the producing code's own reason. */
export interface HillClimbOccurrence {
  role: string;
  /** The COMP the outcome is about, or null for a role-level outcome. */
  compId: string | null;
  /** The reason as the producing code stated it — kept whole, not re-worded. */
  detail: string;
}

export interface HillClimbReceipt {
  /** One list per state. Every state is present, so an empty one is a reading. */
  states: Record<HillClimbState, HillClimbOccurrence[]>;
  /**
   * Skip lines `applyHillClimb` emitted that no state claims. A reword
   * upstream must not read as nothing having happened, so an unclassified
   * line raises the reading rather than disappearing.
   */
  unclassified: HillClimbOccurrence[];
  /** Derived from the lists above in `hillClimbReceipt` and nowhere else. */
  reading: "MEASURED" | "UNMEASURED";
  /** Why the reading is UNMEASURED, each naming its state. Empty when MEASURED. */
  unmeasuredReasons: string[];
}

export interface PersistResult {
  ok: boolean;
  persisted: boolean;
  graded: number;
  hillClimbApplied: number;
  verified: string[];
  /** What happened when nothing was applied — see HILL_CLIMB_STATES (#646). */
  hillClimb: HillClimbReceipt;
}

export function emptyHillClimbStates(): Record<HillClimbState, HillClimbOccurrence[]> {
  return {
    NO_ACTIONS_DETECTED: [],
    GRADER_ACCURACY_DROP: [],
    TIER_PROMOTION_RECOMMENDED: [],
    REINFORCEMENT_ALREADY_PRESENT: [],
    NO_SUITABLE_SECTION: [],
    NO_BRIEF_REGISTERED: [],
    OUTCOMES_UNACCOUNTED: [],
  };
}

/**
 * Which receipt state each of `applyHillClimb`'s own decisions is (#646).
 *
 * `applyHillClimb` decides which skip a skip is; this only renames its
 * answer. Deciding it again here — by matching the sentence with a regex, or
 * by asking the brief and the action a second time — would be two deciders
 * for one question: they would always agree, and a mutation of either would
 * leave the other holding the case up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). A sentence
 * matcher is also a second position spelling strings `hillClimbSkipSentence`
 * owns, which SC-2093 refuses by name.
 *
 * It is a total `Record` rather than a lookup with a fallback, so a `kind`
 * added to `HillClimbSkipOutcome` and not mapped here is a type error at the
 * build, not an `UNCLASSIFIED_SKIP` at the end of a ship run.
 */
const SKIP_OUTCOME_STATE: Record<HillClimbSkipOutcome["kind"], HillClimbState> = {
  TIER_PROMOTION: "TIER_PROMOTION_RECOMMENDED",
  REINFORCEMENT_PRESENT: "REINFORCEMENT_ALREADY_PRESENT",
  NO_SECTION: "NO_SUITABLE_SECTION",
};

/**
 * The state a reported skip belongs to, or `null` when nothing decided it.
 *
 * A `HillClimbSkipOutcome` is the producing code's answer, read as given. A
 * bare STRING is a line that arrived with no outcome beside it — a
 * `skipped.push` upstream that does not go through `skipOutcomes`, leaving
 * `skipped` longer than the outcomes it is supposed to be derived from. Such
 * a line carries no decision to read, so it is unclassified rather than
 * guessed at from its wording, and `hillClimbReceipt` turns it into an
 * UNMEASURED reading instead of letting it vanish.
 */
export function classifySkip(skip: HillClimbSkipOutcome | string): HillClimbState | null {
  return typeof skip === "string" ? null : SKIP_OUTCOME_STATE[skip.kind];
}

/**
 * The one place a reading is derived from the state lists.
 *
 * `reading` and `unmeasuredReasons` are projections of the same lists, so they
 * cannot disagree, and `reading === "UNMEASURED"` is the whole answer for a
 * caller that only wants the boolean.
 */
export function hillClimbReceipt(
  states: Record<HillClimbState, HillClimbOccurrence[]>,
  unclassified: HillClimbOccurrence[],
): HillClimbReceipt {
  const unmeasuredReasons = [
    ...UNMEASURED_HILL_CLIMB_STATES.flatMap(state =>
      states[state].map(o => `${state}: ${o.role} — ${o.detail}`),
    ),
    ...unclassified.map(o => `UNCLASSIFIED_SKIP: ${o.role} — ${o.detail}`),
  ];
  return {
    states,
    unclassified,
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
  };
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

/**
 * The one injection seam, exported (#662).
 *
 * `OUTCOMES_UNACCOUNTED` is a statement about a reply `applyHillClimb` is
 * not supposed to make, so there is no input to this script that provokes
 * it — and a branch no test can enter is the thing
 * `.claude/rules/checks-must-be-able-to-fail.md` is about. The seam lets a
 * case hand the loop a reply that does not account for its actions, without
 * mutating the real function or reaching for a fixture that happens to
 * produce one today.
 *
 * Optional and defaulted to the real function, so every existing caller is
 * unchanged and a test that forgets to pass it is testing the real thing.
 */
export interface PersistSeams {
  applyHillClimb?: typeof applyHillClimb;
}

export function persistCompliance(
  workDir: string,
  harnessRoot: string,
  issue: string,
  logger: (m: string) => void = m => console.error(m),
  seams: PersistSeams = {},
): PersistResult {
  const applyHillClimbFn = seams.applyHillClimb ?? applyHillClimb;
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
    // A Map, not a Set: the reason the gate computed is the reason the receipt
    // reports, so there is one statement of why a COMP was dropped.
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

    const detected = detectHillClimbNeeds(report);
    if (detected.length === 0) {
      states.NO_ACTIONS_DETECTED.push({
        role: g.role,
        compId: null,
        detail: "no COMP reached the consecutive-fail threshold",
      });
      continue;
    }

    const actions: typeof detected = [];
    for (const a of detected) {
      const droppedBecause = graderAccuracySkips.get(a.compId);
      if (droppedBecause !== undefined) {
        states.GRADER_ACCURACY_DROP.push({ role: g.role, compId: a.compId, detail: droppedBecause });
        continue;
      }
      actions.push(a);
    }
    if (actions.length === 0) continue;

    const briefPath = loadRoleBriefPaths(harnessRoot)[g.role];
    if (!briefPath) {
      // #662. This `continue` used to leave nothing behind, and a role whose
      // actions were detected and then discarded produced the same receipt
      // as a role that needed nothing — which is the reading #646 exists to
      // abolish, surviving one branch above the place it was abolished.
      logger(`no brief registered for role ${g.role} — skipping hill-climb`);
      states.NO_BRIEF_REGISTERED.push({
        role: g.role,
        compId: null,
        detail:
          `${actions.length} action(s) were detected and no brief is registered for this role, ` +
          `so nothing was composed and nobody knows what reinforcing it would have done`,
      });
      continue;
    }

    const { applied, skipped, skipOutcomes } = applyHillClimbFn(briefPath, actions);
    // #662. The two arrays are the whole answer about `actions`, and nothing
    // required them to be an answer about all of it. A call that returns
    // both empty for a non-empty input has reported neither an application
    // nor a skip, and the receipt's five lists are then empty for this role
    // — `hillClimbApplied: 0` one layer in.
    //
    // Counted rather than asked as `length === 0`: a reply accounting for
    // two of three actions is the same defect in a quieter size, and a
    // guard worded after the cheapest proxy is a guard people satisfy
    // directly (`.claude/rules/checks-must-be-able-to-fail.md`).
    if (applied.length + skipped.length < actions.length) {
      states.OUTCOMES_UNACCOUNTED.push({
        role: g.role,
        compId: null,
        detail:
          `${actions.length} action(s) went in and ${applied.length} application(s) plus ` +
          `${skipped.length} skip(s) came back, so ${actions.length - applied.length - skipped.length} ` +
          `of them produced no outcome at all`,
      });
    }
    for (const a of applied) logger(`HILL-CLIMB: ${a}`);
    // `skipped` is `skipOutcomes.map(hillClimbSkipSentence)` at a single
    // return in `applyHillClimb`, so index i of one is index i of the other.
    // Iterating the SENTENCES rather than the outcomes is deliberate: every
    // line that is reported gets an occurrence, and a line with no outcome
    // beside it is reported as unclassified instead of being dropped.
    skipped.forEach((s, i) => {
      logger(`HILL-CLIMB skipped: ${s}`);
      const outcome = skipOutcomes[i];
      const occurrence: HillClimbOccurrence = {
        role: g.role,
        // The COMP as the decision carried it, not as a sentence spells it.
        compId: outcome?.compId ?? null,
        detail: s,
      };
      const state = classifySkip(outcome ?? s);
      if (state) states[state].push(occurrence);
      else unclassified.push(occurrence);
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
  if (hillClimb.reading === "UNMEASURED") {
    // Named, not silent: exiting 0 having applied nothing is the default this
    // receipt exists to distinguish from a clean run.
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
