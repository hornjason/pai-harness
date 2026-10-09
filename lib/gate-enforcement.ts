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
 * Everything the hook needs from its environment. Passed in rather than
 * read from module scope so the whole decision path is callable from a test.
 */
export interface GateEnforcementInput {
  /** Directory holding the per-issue workflow-state.json files. */
  workDir: string;
  /** Directory for the signals log; created on demand. */
  signalsDir: string;
  /** Signals JSONL path. */
  signalsFile: string;
  /** gate-pending.json path — the strike counter's home. */
  pendingFile: string;
  /** Project root, scanned for doc-hygiene findings (SC-508). */
  projectRoot: string;
  sessionId: string;
  toolName: string;
}

export interface GateEnforcementResult {
  /** What the hook should print on stdout, or null to stay silent. */
  stdout: string | null;
  action: EnforcementAction;
}

/**
 * The whole GateEnforcement decision, extracted from the hook (SC-369).
 *
 * The hook is now a trigger: parse stdin, call this, print, exit 0. Keeping
 * the logic here is what makes it reachable by test/gate-enforcement.test.ts
 * without simulating a PreToolUse payload.
 */
export function runGateEnforcement(input: GateEnforcementInput): GateEnforcementResult {
  const wfFailure = findWorkflowGateFailure(input.workDir);
  if (!wfFailure) {
    if (existsSync(input.pendingFile)) {
      try {
        unlinkSync(input.pendingFile);
      } catch (err) {
        console.error(`[GateEnforcement] Could not clear ${input.pendingFile}: ${err}`);
      }
    }
    return { stdout: null, action: 'pass' };
  }

  const strikeCount = loadStrikeCount(input.pendingFile, wfFailure.issue, wfFailure.gate);
  const pending = buildGatePending(wfFailure, input.sessionId, strikeCount);
  const decision = makeEnforcementDecision(pending, input.toolName);
  const ts = new Date().toISOString();

  if (decision.action === 'block') {
    logSignal(input.signalsDir, input.signalsFile, {
      ts, type: 'gate_enforcement', gate: pending.gate, issue: pending.issue,
      strike: pending.strike_count, tool: input.toolName, action: 'block',
      reason: pending.outcome_ac_failure ? 'outcome_ac_failure' : 'max_strikes',
    });
    return {
      stdout: JSON.stringify({ decision: 'block', reason: decision.reason }),
      action: 'block',
    };
  }

  if (input.toolName === 'Skill') {
    try {
      writeFileSync(
        input.pendingFile,
        JSON.stringify({ ...pending, strike_count: decision.newStrikeCount }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error(`[GateEnforcement] Strike count write failed: ${err}`);
    }
  }

  logSignal(input.signalsDir, input.signalsFile, {
    ts, type: 'gate_enforcement', gate: pending.gate, issue: pending.issue,
    strike: decision.newStrikeCount, tool: input.toolName, action: 'nag',
  });
  logHygieneSignals(input.signalsDir, input.signalsFile, input.projectRoot);

  return { stdout: decision.reminder ?? null, action: 'nag' };
}

/**
 * SC-508: doc-hygiene findings ride along as signals for promotion tracking.
 * Best-effort by design — a hygiene scan failure must not block a tool call —
 * but it says so on stderr rather than vanishing.
 */
export function logHygieneSignals(signalsDir: string, signalsFile: string, projectRoot: string): number {
  try {
    const result = checkDocHygiene(projectRoot);
    if (result.pass) return 0;
    for (const finding of result.findings) {
      logSignal(signalsDir, signalsFile, {
        ts: new Date().toISOString(), type: 'doc-hygiene',
        checkId: finding.checkId, file: finding.file,
        level: finding.level, message: finding.message,
      });
    }
    return result.findings.length;
  } catch (err) {
    console.error(`[GateEnforcement] doc-hygiene signal sweep skipped: ${err}`);
    return 0;
  }
}
