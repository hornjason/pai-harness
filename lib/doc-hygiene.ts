/**
 * Doc Hygiene — content alignment and drift detection.
 *
 * SC-509: exports [runContentAlignment, checkDocHygiene]
 *
 * Phase 0: infrastructure only — validates specs have governs fields.
 * Phase 1 (follow-up): CONTENT-1 dead-reference lint, CONTENT-2 hash drift.
 *
 * All new checks start as WARN, not FAIL (DEC-005, spec-policies.json Decision #9).
 * No LLM-based detection (DEC-006) — all checks are deterministic.
 *
 * Issue: #24
 */

import { getGoverningSpecs, getUngoverned } from './spec-registry';

export interface DocHygieneFinding {
  /** Check identifier for signal tracking (e.g. 'GOVERNS-MISSING') */
  checkId: string;
  /** Severity — all new checks start as WARN per DEC-005 */
  level: 'WARN' | 'FAIL';
  /** Affected file path relative to specs/ */
  file: string;
  /** Human-readable description */
  message: string;
}

export interface DocHygieneResult {
  /** True when zero findings */
  pass: boolean;
  /** All findings from content alignment checks */
  findings: DocHygieneFinding[];
}

/**
 * Run content alignment checks against specs in the given root directory.
 *
 * Phase 0 checks:
 * - GOVERNS-MISSING: spec has no governs field or governs is TODO
 *
 * Returns findings as WARN (not FAIL) per DEC-005 promotion policy.
 */
export function runContentAlignment(root: string): DocHygieneFinding[] {
  const findings: DocHygieneFinding[] = [];

  // Check for specs without governs field
  const ungoverned = getUngoverned(root);
  for (const file of ungoverned) {
    findings.push({
      checkId: 'GOVERNS-MISSING',
      level: 'WARN',
      file,
      message: `Spec ${file} has no governs field or governs is TODO`,
    });
  }

  return findings;
}

/**
 * Run the full doc-hygiene check suite and return a pass/fail result.
 *
 * Wraps runContentAlignment with a structured result for gate enforcement.
 * Signal logging metadata (check-id, file, finding-type) is included
 * in each finding for promotion tracking per DEC-012.
 */
export function checkDocHygiene(root: string): DocHygieneResult {
  const findings = runContentAlignment(root);

  return {
    pass: findings.length === 0,
    findings,
  };
}
