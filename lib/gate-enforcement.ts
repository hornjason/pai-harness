/**
 * Gate enforcement logic — extracted from GateEnforcement.hook.ts
 *
 * Contains workflow gate failure detection, enforcement decisions,
 * and signal logging. Hook file is thin trigger only.
 *
 * Per Hook Architecture Spec D-2: hook logic in lib/ with unit tests.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';

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

export interface EnforcementInput {
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  hasOutcomeAcFailure: boolean;
  strikeCount: number;
  maxStrikes: number;
}

export interface EnforcementDecision {
  action: 'block' | 'nag';
  output: string;
  reason?: string;
  newStrikeCount: number;
}

/**
 * Format gate failures into a readable string.
 */
export function formatFailures(failures: GateFailure[]): string {
  return failures.map(f => `  - ${f.check}: ${f.detail}`).join('\n');
}

/**
 * Scan workflow directories for active gate failures.
 * Returns the first failure found, or null if none.
 */
export function findWorkflowGateFailure(workDir: string): WorkflowGateFailure | null {
  if (!existsSync(workDir)) return null;

  try {
    const dirs = readdirSync(workDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      const wfPath = join(workDir, d.name, 'workflow-state.json');
      if (!existsSync(wfPath)) continue;

      try {
        const wf = JSON.parse(readFileSync(wfPath, 'utf-8'));
        if (wf.phase === 'DONE') continue;

        const gates = wf.gates || {};
        for (const gateName of ['scope', 'verify', 'ship']) {
          const gate = gates[gateName];
          if (gate?.result === 'FAIL' && Array.isArray(gate.failures) && gate.failures.length > 0) {
            const acs = Array.isArray(wf.acs) ? wf.acs : [];
            const hasOutcomeAcFailure = acs.some(
              (ac: { type?: string; verdict?: string }) => ac.type === 'OUTCOME' && ac.verdict === 'FAIL'
            );
            return {
              gate: gateName,
              issue: wf.issue,
              slug: wf.slug || d.name,
              failures: gate.failures.map((f: { check?: string; id?: string; detail?: string; message?: string }) => ({
                check: f.check || f.id || 'unknown',
                detail: f.detail || f.message || JSON.stringify(f),
              })),
              hasOutcomeAcFailure,
            };
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* skip */ }

  return null;
}

/**
 * Determine the enforcement action: block or nag.
 */
export function makeEnforcementDecision(input: EnforcementInput, toolName: string): EnforcementDecision {
  const isSkillCall = toolName === 'Skill';
  const failureText = formatFailures(input.failures);

  // OUTCOME AC failure -> immediate block on Skill calls
  if (input.hasOutcomeAcFailure && isSkillCall) {
    return {
      action: 'block',
      output: JSON.stringify({
        decision: 'block',
        reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${input.gate}, issue #${input.issue}.\n${failureText}`,
      }),
      reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${input.gate}, issue #${input.issue}.\n${failureText}`,
      newStrikeCount: input.strikeCount,
    };
  }

  // Strike-based block on Skill calls
  if (isSkillCall && input.strikeCount >= input.maxStrikes) {
    return {
      action: 'block',
      output: JSON.stringify({
        decision: 'block',
        reason: `Gate blocked after ${input.strikeCount} strikes: ${input.gate} (issue #${input.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      }),
      reason: `Gate blocked after ${input.strikeCount} strikes: ${input.gate} (issue #${input.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      newStrikeCount: input.strikeCount,
    };
  }

  // Nag — increment strikes only for Skill calls
  const newStrikeCount = isSkillCall ? input.strikeCount + 1 : input.strikeCount;

  const reminder = [
    '<system-reminder>',
    `⚠️ GATE FAIL (${input.gate}): issue #${input.issue}`,
    failureText,
    `Strike ${newStrikeCount}/${input.maxStrikes}. Fix before proceeding or post skip-reason to issue.`,
    '</system-reminder>',
  ].join('\n');

  return {
    action: 'nag',
    output: reminder,
    newStrikeCount,
  };
}

export interface GatePendingRecord {
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

/**
 * Build a pending record for persisting strike state.
 */
export function buildPendingRecord(
  wfFailure: WorkflowGateFailure,
  strikeCount: number,
  sessionId?: string,
): GatePendingRecord {
  return {
    session_id: sessionId || '',
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
 * Append a signal event to the signals JSONL file.
 */
export function logSignal(
  event: Record<string, unknown>,
  signalsDir: string,
  signalsFile: string,
): void {
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    if (existsSync(signalsFile)) {
      appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch (err) {
    console.error(`[GateEnforcement] Signal log write failed: ${err}`);
  }
}
