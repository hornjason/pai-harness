/**
 * doc-hygiene.ts — Content alignment and drift detection module
 *
 * SC-509: exports [runContentAlignment, checkDocHygiene]
 *
 * Initial module for doc-hygiene enforcement. Phase 0 provides the
 * foundation: governs-field validation via spec-registry. Phase 1
 * will add CONTENT-1 (dead-reference lint) and CONTENT-2 (hash-based drift).
 *
 * All new content-alignment checks start as WARN, not FAIL (DEC-005).
 * No LLM-based detection (DEC-006) — all checks are deterministic.
 *
 * Issue: #24
 */

import { getGoverningSpecs, getUngoverned } from './spec-registry';

export interface DocHygieneFinding {
  check: string;
  file: string;
  level: 'WARN' | 'FAIL';
  message: string;
}

export interface DocHygieneSummary {
  total: number;
  governed: number;
  ungoverned: number;
  findings: number;
}

export interface DocHygieneResult {
  findings: DocHygieneFinding[];
  summary: DocHygieneSummary;
}

/**
 * Run content alignment checks on specs in the given root.
 * Returns findings for specs that have issues (missing governs, etc.).
 * All findings start at WARN level per DEC-005.
 */
export function runContentAlignment(root: string, specDirs: string[] = ['specs']): DocHygieneFinding[] {
  const findings: DocHygieneFinding[] = [];
  const ungoverned = getUngoverned(root, specDirs);

  for (const file of ungoverned) {
    findings.push({
      check: 'GOVERNS-MISSING',
      file,
      level: 'WARN',
      message: `Spec ${file} has no valid governs field — add a governs: line to frontmatter`,
    });
  }

  return findings;
}

/**
 * Run full doc-hygiene check and return result with findings and summary.
 */
export function checkDocHygiene(root: string, specDirs: string[] = ['specs']): DocHygieneResult {
  const governed = getGoverningSpecs(root, specDirs);
  const ungoverned = getUngoverned(root, specDirs);
  const findings = runContentAlignment(root, specDirs);

  return {
    findings,
    summary: {
      total: governed.length + ungoverned.length,
      governed: governed.length,
      ungoverned: ungoverned.length,
      findings: findings.length,
    },
  };
}
