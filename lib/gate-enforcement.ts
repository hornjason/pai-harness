/**
 * Gate Enforcement Logic
 *
 * Extracted from GateEnforcement.hook.ts (#544).
 * Contains workflow gate failure detection, strike counting,
 * enforcement decisions, and signal logging.
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

export interface WorkflowGateFailure {
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  hasOutcomeAcFailure: boolean;
}

export interface EnforcementDecision {
  action: 'block' | 'nag';
  reason?: string;
  reminder?: string;
  newStrikeCount: number;
}

/**
 * Log a signal event to the signals JSONL file.
 */
export function logSignal(
  signalsDir: string,
  signalsFile: string,
  event: Record<string, unknown>,
): void {
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    if (existsSync(signalsFile)) {
      appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch {
    // Signal log write failed — non-fatal
  }
}

function formatFailures(failures: GateFailure[]): string {
  return failures.map(f => `  - ${f.check}: ${f.detail}`).join('\n');
}

/**
 * Find active gate failures from workflow-state.json files in the work directory.
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
 * Load strike count from cached gate-pending.json if it matches current failure.
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
 * Build a GatePending object from a workflow gate failure.
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
 * Make an enforcement decision based on pending state and current tool call.
 */
export function makeEnforcementDecision(
  pending: GatePending,
  toolName: string,
): EnforcementDecision {
  const isSkillCall = toolName === 'Skill';
  const failureText = formatFailures(pending.failures);

  // OUTCOME AC failure -> immediate block on Skill calls
  if (pending.outcome_ac_failure && isSkillCall) {
    return {
      action: 'block',
      reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${pending.gate}, issue #${pending.issue}.\n${failureText}`,
      newStrikeCount: pending.strike_count,
    };
  }

  // Strike-based block on Skill calls
  if (isSkillCall && pending.strike_count >= pending.max_strikes) {
    return {
      action: 'block',
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
