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
  unlinkSync,
  writeFileSync,
} from 'fs';

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
 * Persist the incremented strike count, but only for the tool class that
 * earns a strike.
 *
 * SC-369 (#209): this branch and the doc-hygiene one below were the last
 * decision logic left in the hook file. A hook is a trigger; a branch that
 * decides whether state is written is logic, and it belongs where a test can
 * reach it without simulating a PreToolUse payload.
 */
export function persistStrikeCount(
  pendingFile: string,
  pending: GatePending,
  newStrikeCount: number,
  toolName: string,
): boolean {
  if (toolName !== 'Skill') return false;
  try {
    writeFileSync(
      pendingFile,
      JSON.stringify({ ...pending, strike_count: newStrikeCount }, null, 2),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a stale pending record. Called when no workflow gate is failing.
 */
export function clearGatePending(pendingFile: string): void {
  if (!existsSync(pendingFile)) return;
  try { unlinkSync(pendingFile); } catch { /* best effort */ }
}

/**
 * SC-508: emit one signal per doc-hygiene finding, for promotion tracking.
 *
 * Takes the checker as a parameter so the caller owns the import and a test
 * can drive the failure path without a real project tree. Best-effort by
 * design — a hygiene scan must never decide whether a gate nag is delivered —
 * and it returns the count so "it ran and found nothing" is distinguishable
 * from "it threw", which a bare try/catch here would have hidden.
 */
export function logDocHygieneSignals(
  signalsDir: string,
  signalsFile: string,
  projectRoot: string,
  check: (root: string) => {
    pass: boolean;
    findings: ReadonlyArray<{ checkId?: string; file?: string; level?: string; message?: string }>;
  },
): number {
  try {
    const result = check(projectRoot);
    if (result.pass) return 0;
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
    return result.findings.length;
  } catch {
    return -1;
  }
}
