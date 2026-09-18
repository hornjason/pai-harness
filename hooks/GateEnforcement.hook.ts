#!/usr/bin/env bun
/**
 * GateEnforcement.hook.ts — PreToolUse gate for harness gate failures
 *
 * TRIGGER: PreToolUse (matcher: ".*" — fires on every tool call)
 *
 * PURPOSE:
 * When a harness gate fails, nag the DA on every tool call until fixed.
 * After max_strikes, block Skill calls (Bash/Read/Agent still work for fixing).
 * OUTCOME AC failures get immediate block — no strike counting.
 *
 * BEHAVIOR:
 *  1. Read MEMORY/STATE/gate-pending.json — if missing/expired → exit 0
 *  2. Cross-session guard: if pending session_id ≠ current → exit 0
 *  3. outcome_ac_failure → immediate block on Skill calls
 *  4. Skill + strike_count >= max_strikes → block
 *  5. Otherwise → nag (system-reminder), increment strike_count
 *  6. Write updated strike_count back
 *  7. Log to MEMORY/LEARNING/SIGNALS/signals.jsonl
 *
 * INPUT:
 *  - stdin: PreToolUse JSON payload { tool_name, tool_input, session_id, ... }
 *
 * OUTPUT:
 *  - stdout: JSON block decision OR system-reminder nag
 *  - stderr: status messages
 *  - exit(0): always
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
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';

const STATE_DIR = join(BASE_DIR, 'MEMORY', 'STATE');
const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const PENDING_FILE = join(STATE_DIR, 'gate-pending.json');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');

interface GateFailure {
  check: string;
  detail: string;
}

interface GatePending {
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

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: {
    skill?: string;
    [k: string]: unknown;
  };
}


function logSignal(event: Record<string, unknown>): void {
  try {
    if (!existsSync(SIGNALS_DIR)) mkdirSync(SIGNALS_DIR, { recursive: true });
    if (existsSync(SIGNALS_FILE)) {
      appendFileSync(SIGNALS_FILE, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch (err) {
    console.error(`[GateEnforcement] Signal log write failed: ${err}`);
  }
}

function formatFailures(failures: GateFailure[]): string {
  return failures.map(f => `  - ${f.check}: ${f.detail}`).join('\n');
}

interface WorkflowGateFailure {
  gate: string;
  issue: number;
  slug: string;
  failures: GateFailure[];
  hasOutcomeAcFailure: boolean;
}

function findWorkflowGateFailure(): WorkflowGateFailure | null {
  if (!existsSync(WORK_DIR)) return null;

  try {
    const dirs = readdirSync(WORK_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const d of dirs) {
      const wfPath = join(WORK_DIR, d.name, 'workflow-state.json');
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

async function main() {
  const input = await parseHookInput();
    if (!input) process.exit(0);

  try {
    // v2: Find active gate failures from workflow-state.json in ~/.rungate/
    const wfFailure = findWorkflowGateFailure();
    if (!wfFailure) {
      if (existsSync(PENDING_FILE)) {
        try { unlinkSync(PENDING_FILE); } catch {}
      }
      process.exit(0);
    }

    // Load strike count from cache (gate-pending.json) if it matches
    let strikeCount = 0;
    if (existsSync(PENDING_FILE)) {
      try {
        const cached = JSON.parse(readFileSync(PENDING_FILE, 'utf-8'));
        if (cached.issue === wfFailure.issue && cached.gate === wfFailure.gate) {
          strikeCount = cached.strike_count || 0;
        }
      } catch {}
    }

    const pending: GatePending = {
      session_id: input.session_id || '',
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

    const toolName = input.tool_name || '';
    const isSkillCall = toolName === 'Skill';
    const failureText = formatFailures(pending.failures);

    // OUTCOME AC failure → immediate block on Skill calls (no strike counting)
    if (pending.outcome_ac_failure && isSkillCall) {
      const decision = {
        decision: 'block',
        reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${pending.gate}, issue #${pending.issue}.\n${failureText}`,
      };
      console.log(JSON.stringify(decision));

      logSignal({
        ts: new Date().toISOString(),
        type: 'gate_enforcement',
        gate: pending.gate,
        issue: pending.issue,
        strike: pending.strike_count,
        tool: toolName,
        action: 'block',
        reason: 'outcome_ac_failure',
      });

      console.error(`[GateEnforcement] BLOCKED Skill — outcome AC failure on ${pending.gate}`);
      process.exit(0);
    }

    // Strike-based block on Skill calls
    if (isSkillCall && pending.strike_count >= pending.max_strikes) {
      const decision = {
        decision: 'block',
        reason: `Gate blocked after ${pending.strike_count} strikes: ${pending.gate} (issue #${pending.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      };
      console.log(JSON.stringify(decision));

      logSignal({
        ts: new Date().toISOString(),
        type: 'gate_enforcement',
        gate: pending.gate,
        issue: pending.issue,
        strike: pending.strike_count,
        tool: toolName,
        action: 'block',
        reason: 'max_strikes',
      });

      console.error(`[GateEnforcement] BLOCKED Skill — ${pending.strike_count} strikes on ${pending.gate}`);
      process.exit(0);
    }

    // Nag — inject system-reminder on ALL tools, but only count strikes for Skill calls
    const newStrikeCount = isSkillCall ? pending.strike_count + 1 : pending.strike_count;

    const reminder = [
      '<system-reminder>',
      `⚠️ GATE FAIL (${pending.gate}): issue #${pending.issue}`,
      failureText,
      `Strike ${newStrikeCount}/${pending.max_strikes}. Fix before proceeding or post skip-reason to issue.`,
      '</system-reminder>',
    ].join('\n');

    console.log(reminder);

    // Write updated strike_count back — only when Skill call incremented it
    if (isSkillCall) {
      const updated: GatePending = { ...pending, strike_count: newStrikeCount };
      try {
        writeFileSync(PENDING_FILE, JSON.stringify(updated, null, 2), 'utf-8');
      } catch (err) {
        console.error(`[GateEnforcement] Failed to update strike_count: ${err}`);
      }
    }

    logSignal({
      ts: new Date().toISOString(),
      type: 'gate_enforcement',
      gate: pending.gate,
      issue: pending.issue,
      strike: newStrikeCount,
      tool: toolName,
      action: 'nag',
    });

    console.error(
      `[GateEnforcement] Nag injected for ${toolName} — strike ${newStrikeCount}/${pending.max_strikes} on ${pending.gate}`
    );

    process.exit(0);
  } catch (err) {
    console.error(`[GateEnforcement] Error: ${err}`);
    process.exit(0);
  }
}

main();
