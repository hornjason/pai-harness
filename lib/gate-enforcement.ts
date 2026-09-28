/**
 * Gate enforcement logic — extracted from GateEnforcement.hook.ts
 *
 * Provides workflow gate failure scanning and enforcement decision logic.
 * The hook is a thin trigger; this module holds the testable logic.
 *
 * Per Hook Architecture Spec (D-1, D-2):
 *   Hooks are thin triggers — under 50 lines each.
 *   Hook logic extracted to lib/ modules.
 *
 * Issue: #544
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────

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

export interface EnforcementDecision {
  action: "block" | "nag";
  reason: string;
  gate: string;
  issue: number;
  newStrikeCount: number;
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

// ── Formatting ─────────────────────────────────────────────

/**
 * Format gate failures as indented bullet list.
 */
export function formatFailures(failures: GateFailure[]): string {
  return failures.map((f) => `  - ${f.check}: ${f.detail}`).join("\n");
}

// ── Workflow gate failure scanning ─────────────────────────

/**
 * Scan workflow-state.json files under workDir for active gate failures.
 * Returns the first workflow with a FAIL gate (scope, verify, or ship)
 * that is not in DONE phase.
 */
export function findWorkflowGateFailure(workDir: string): WorkflowGateFailure | null {
  if (!existsSync(workDir)) return null;

  try {
    const dirs = readdirSync(workDir, { withFileTypes: true }).filter((d) => d.isDirectory());

    for (const d of dirs) {
      // Level 1: direct children
      const result = checkWorkflowFile(join(workDir, d.name, "workflow-state.json"), d.name);
      if (result) return result;

      // Level 2: nested subdirectories (e.g., pai/361)
      const subDir = join(workDir, d.name);
      try {
        const subDirs = readdirSync(subDir, { withFileTypes: true }).filter((sd) => sd.isDirectory());
        for (const sd of subDirs) {
          const nestedResult = checkWorkflowFile(
            join(subDir, sd.name, "workflow-state.json"),
            `${d.name}/${sd.name}`,
          );
          if (nestedResult) return nestedResult;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  return null;
}

/**
 * Check a single workflow-state.json file for gate failures.
 */
function checkWorkflowFile(wfPath: string, slug: string): WorkflowGateFailure | null {
  if (!existsSync(wfPath)) return null;

  try {
    const wf = JSON.parse(readFileSync(wfPath, "utf-8"));
    if (wf.phase === "DONE") return null;

    const gates = wf.gates || {};
    for (const gateName of ["scope", "verify", "ship"]) {
      const gate = gates[gateName];
      if (gate?.result === "FAIL" && Array.isArray(gate.failures) && gate.failures.length > 0) {
        const acs = Array.isArray(wf.acs) ? wf.acs : [];
        const hasOutcomeAcFailure = acs.some(
          (ac: { type?: string; verdict?: string }) => ac.type === "OUTCOME" && ac.verdict === "FAIL",
        );
        return {
          gate: gateName,
          issue: wf.issue,
          slug: wf.slug || slug,
          failures: gate.failures.map(
            (f: { check?: string; id?: string; detail?: string; message?: string }) => ({
              check: f.check || f.id || "unknown",
              detail: f.detail || f.message || JSON.stringify(f),
            }),
          ),
          hasOutcomeAcFailure,
        };
      }
    }
  } catch {
    /* skip malformed */
  }

  return null;
}

// ── Enforcement decision logic ─────────────────────────────

/**
 * Determine the enforcement action based on gate failure state.
 *
 * Decision tree:
 *  1. outcome_ac_failure + Skill call → block (immediate, no strike counting)
 *  2. Skill + strike_count >= max_strikes → block
 *  3. Otherwise → nag (increment strike only for Skill calls)
 */
export function makeEnforcementDecision(
  failure: WorkflowGateFailure,
  toolName: string,
  strikeCount: number,
  maxStrikes: number,
): EnforcementDecision {
  const isSkillCall = toolName === "Skill";
  const failureText = formatFailures(failure.failures);

  // Priority 1: OUTCOME AC failure blocks Skill calls immediately
  if (failure.hasOutcomeAcFailure && isSkillCall) {
    return {
      action: "block",
      reason: `OUTCOME AC failed — must fix before proceeding. Gate: ${failure.gate}, issue #${failure.issue}.\n${failureText}`,
      gate: failure.gate,
      issue: failure.issue,
      newStrikeCount: strikeCount,
    };
  }

  // Priority 2: Strike-based block on Skill calls
  if (isSkillCall && strikeCount >= maxStrikes) {
    return {
      action: "block",
      reason: `Gate blocked after ${strikeCount} strikes: ${failure.gate} (issue #${failure.issue}).\n${failureText}\nFix the failures or post skip-reason to the issue.`,
      gate: failure.gate,
      issue: failure.issue,
      newStrikeCount: strikeCount,
    };
  }

  // Nag — increment strike only for Skill calls
  const newStrikeCount = isSkillCall ? strikeCount + 1 : strikeCount;

  return {
    action: "nag",
    reason: `Gate ${failure.gate} failing on issue #${failure.issue}.\n${failureText}\nStrike ${newStrikeCount}/${maxStrikes}.`,
    gate: failure.gate,
    issue: failure.issue,
    newStrikeCount,
  };
}

// ── Signal logging ─────────────────────────────────────────

/**
 * Log an enforcement signal to the signals JSONL file.
 * Non-blocking — catches all errors.
 */
export function logSignal(
  signalsDir: string,
  signalsFile: string,
  event: Record<string, unknown>,
): void {
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    if (existsSync(signalsFile)) {
      appendFileSync(signalsFile, JSON.stringify(event) + "\n", "utf-8");
    }
  } catch (err) {
    console.error(`[GateEnforcement] Signal log write failed: ${err}`);
  }
}

/**
 * Load cached strike count from gate-pending.json if it matches current failure.
 */
export function loadCachedStrikeCount(
  pendingFile: string,
  issue: number,
  gate: string,
): number {
  if (!existsSync(pendingFile)) return 0;
  try {
    const cached = JSON.parse(readFileSync(pendingFile, "utf-8"));
    if (cached.issue === issue && cached.gate === gate) {
      return cached.strike_count || 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}
