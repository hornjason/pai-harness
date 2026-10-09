/**
 * Gate enforcement logic — extracted from GateEnforcement.hook.ts
 *
 * Deep module: exports enforcement decision logic, workflow gate failure
 * scanning, and signal logging. The hook file is a thin trigger that
 * delegates all logic here.
 *
 * Issue: #544
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { checkDocHygiene } from './doc-hygiene';

export interface GateFailure {
  check: string;
  detail: string;
}

export interface WorkflowGateFailure {
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  hasOutcomeAcFailure: boolean;
}

export interface GatePending {
  session_id: string;
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  strike_count: number;
  max_strikes: number;
  outcome_ac_failure: boolean;
  created_at: string;
  expires_ts: number;
}

export type EnforcementAction = 'block' | 'nag' | 'pass';

export interface EnforcementDecision {
  action: EnforcementAction;
  decision?: string;
  reason?: string;
  reminder?: string;
  newStrikeCount: number;
}

/**
 * Format gate failures into human-readable text.
 */
export function formatFailures(failures: GateFailure[]): string {
  return failures.map(f => `  - ${f.check}: ${f.detail}`).join('\n');
}

/**
 * Scan workflow-state.json files under workDir for active gate failures.
 * Returns the first failure found (scope > verify > ship priority).
 * Checks both direct children and nested subdirectories.
 */
export function findWorkflowGateFailure(workDir: string): WorkflowGateFailure | null {
  if (!existsSync(workDir)) return null;

  try {
    const dirs = readdirSync(workDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      // Level 1: direct children
      const result = checkWorkflowFile(`${workDir}/${d.name}/workflow-state.json`, d.name);
      if (result) return result;

      // Level 2: nested subdirectories
      try {
        const subDirs = readdirSync(`${workDir}/${d.name}`, { withFileTypes: true })
          .filter(sd => sd.isDirectory());
        for (const sd of subDirs) {
          const nestedResult = checkWorkflowFile(
            `${workDir}/${d.name}/${sd.name}/workflow-state.json`,
            `${d.name}/${sd.name}`,
          );
          if (nestedResult) return nestedResult;
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return null;
}

/**
 * Check a single workflow-state.json file for gate failures.
 */
function checkWorkflowFile(wfPath: string, slug: string): WorkflowGateFailure | null {
  if (!existsSync(wfPath)) return null;

  try {
    const wf = JSON.parse(readFileSync(wfPath, 'utf-8'));
    if (wf.phase === 'DONE') return null;

    const gates = wf.gates || {};
    for (const gateName of ['scope', 'verify', 'ship']) {
      const gate = gates[gateName];
      if (gate?.result === 'FAIL' && Array.isArray(gate.failures) && gate.failures.length > 0) {
        const acs = Array.isArray(wf.acs) ? wf.acs : [];
        const hasOutcomeAcFailure = acs.some(
          (ac: { type?: string; verdict?: string }) => ac.type === 'OUTCOME' && ac.verdict === 'FAIL',
        );
        return {
          gate: gateName,
          issue: wf.issue,
          slug: wf.slug || slug,
          failures: gate.failures.map(
            (f: { check?: string; id?: string; detail?: string; message?: string }) => ({
              check: f.check || f.id || 'unknown',
              detail: f.detail || f.message || JSON.stringify(f),
            }),
          ),
          hasOutcomeAcFailure,
        };
      }
    }
  } catch { /* skip malformed */ }

  return null;
}

/**
 * Determine the enforcement action (block/nag/pass) for a given gate state and tool call.
 */
export function makeEnforcementDecision(pending: GatePending, toolName: string): EnforcementDecision {
  const isSkillCall = toolName === 'Skill';
  const failureText = formatFailures(pending.failures);

  // OUTCOME AC failure -> immediate block on Skill calls
  if (pending.outcome_ac_failure && isSkillCall) {
    return {
      action: 'block',
      decision: 'block',
      reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${pending.gate}, issue #${pending.issue}.\n${failureText}`,
      newStrikeCount: pending.strike_count,
    };
  }

  // Strike-based block on Skill calls
  if (isSkillCall && pending.strike_count >= pending.max_strikes) {
    return {
      action: 'block',
      decision: 'block',
      reason: `Gate blocked after ${pending.strike_count} strikes: ${pending.gate} (issue #${pending.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      newStrikeCount: pending.strike_count,
    };
  }

  // Nag — only count strikes for Skill calls
  const newStrikeCount = isSkillCall ? pending.strike_count + 1 : pending.strike_count;

  const reminder = [
    '<system-reminder>',
    `⚠️ GATE FAIL (${pending.gate}): issue #${pending.issue}`,
    failureText,
    `Strike ${newStrikeCount}/${pending.max_strikes}. Fix before proceeding or post skip-reason to issue.`,
    '</system-reminder>',
  ].join('\n');

  return {
    action: 'nag',
    reminder,
    newStrikeCount,
  };
}

/**
 * Load cached strike count from gate-pending.json if it matches the current failure.
 */
export function loadStrikeCount(pendingFile: string, issue: number, gate: string): number {
  if (!existsSync(pendingFile)) return 0;
  try {
    const cached = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    if (cached.issue === issue && cached.gate === gate) {
      return cached.strike_count || 0;
    }
  } catch {}
  return 0;
}

/**
 * Build a GatePending object from a workflow gate failure and session context.
 */
export function buildGatePending(
  wfFailure: WorkflowGateFailure,
  sessionId: string,
  strikeCount: number,
): GatePending {
  return {
    session_id: sessionId,
    gate: wfFailure.gate,
    issue: wfFailure.issue,
    slug: wfFailure.slug,
    failures: wfFailure.failures,
    strike_count: strikeCount,
    max_strikes: 3,
    outcome_ac_failure: wfFailure.hasOutcomeAcFailure,
    created_at: new Date().toISOString(),
    expires_ts: Date.now() + (4 * 60 * 60 * 1000),
  };
}

/**
 * Log an enforcement signal event to the signals file.
 *
 * SC-504: appendFileSync creates the file if absent — the previous
 * existence guard silently dropped signals on first write.
 */
export function logSignal(signalsDir: string, signalsFile: string, event: Record<string, unknown>): void {
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    console.error(`[GateEnforcement] Signal log write failed: ${err}`);
  }
}

/**
 * Record one gate-enforcement outcome.
 *
 * Lifted out of GateEnforcement.hook.ts (SC-369): the block and nag branches
 * each assembled this event inline, which meant the only way to check that a
 * block is attributed to `outcome_ac_failure` rather than `max_strikes` was to
 * drive a PreToolUse payload through stdin.
 */
export function logEnforcementSignal(
  signalsDir: string,
  signalsFile: string,
  pending: GatePending,
  toolName: string,
  action: Extract<EnforcementAction, 'block' | 'nag'>,
  strike: number,
): void {
  logSignal(signalsDir, signalsFile, {
    ts: new Date().toISOString(),
    type: 'gate_enforcement',
    gate: pending.gate,
    issue: pending.issue,
    strike,
    tool: toolName,
    action,
    ...(action === 'block'
      ? { reason: pending.outcome_ac_failure ? 'outcome_ac_failure' : 'max_strikes' }
      : {}),
  });
}

interface HygieneFinding { checkId: string; file: string; level: string; message: string }
interface HygieneResult { pass: boolean; findings: HygieneFinding[] }

/**
 * SC-508: emit one signal per doc-hygiene finding, for promotion tracking.
 *
 * `check` is injectable so the emitter can be tested without a project tree,
 * and defaults to the real scan. Best-effort: a throwing scan is swallowed,
 * because this rides along on a gate nag and must not replace it with a crash.
 */
export function logDocHygieneSignals(
  signalsDir: string,
  signalsFile: string,
  projectRoot: string,
  check?: (root: string) => HygieneResult,
): void {
  try {
    // Statically imported, not `require`d inside this try. A require here
    // would throw in any environment without CommonJS loading, the catch
    // below would swallow it, and SC-508 would be silently switched off while
    // every run still looked normal — the exact shape
    // .claude/rules/checks-must-be-able-to-fail.md is about.
    const run = check ?? checkDocHygiene;
    const result = run(projectRoot) as HygieneResult;
    if (result.pass) return;
    for (const finding of result.findings) {
      logSignal(signalsDir, signalsFile, {
        ts: new Date().toISOString(),
        type: 'doc-hygiene',
        checkId: finding.checkId,
        file: finding.file,
        level: finding.level,
        message: finding.message,
      });
    }
  } catch { /* doc-hygiene signals are best-effort */ }
}
