/**
 * Doc Hygiene — content alignment and drift detection.
 *
 * SC-509: exports [runContentAlignment, checkDocHygiene]
 * SC-510: CONTENT-1 dead-reference lint — governs targets resolve to real files
 * SC-511: CONTENT-2 hash-based drift detection — drift-hashes.json manifest
 *
 * Phase 0: infrastructure only — validates specs have governs fields.
 * Phase 1: CONTENT-1 dead-reference lint, CONTENT-2 hash drift.
 *
 * All new checks start as WARN, not FAIL (DEC-005, spec-policies.json Decision #9).
 * No LLM-based detection (DEC-006) — all checks are deterministic.
 *
 * Issue: #24, #35
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
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

  // CONTENT-1: Dead-reference lint — governs targets resolve to real files
  findings.push(...checkDeadReferences(root));

  return findings;
}

/**
 * Determine if a governs value looks like a file/directory path.
 *
 * Path-like values contain a forward slash (e.g. "lib/scanner.ts", "gates/").
 * Prose descriptions like "Session lifecycle management" are not paths.
 */
function isPathLike(governs: string): boolean {
  return governs.includes('/');
}

/**
 * CONTENT-1: Dead-reference lint — verify governs targets resolve to real files.
 *
 * For each spec with a governs field containing a path-like value,
 * check that the target exists relative to the project root using
 * resolve and existsSync. Reports WARN per DEC-005.
 */
export function checkDeadReferences(root: string): DocHygieneFinding[] {
  const findings: DocHygieneFinding[] = [];
  const specs = getGoverningSpecs(root);

  for (const spec of specs) {
    const governs = spec.governs.trim();

    // Only validate path-like governs targets
    if (!isPathLike(governs)) continue;

    const targetPath = resolve(root, governs);

    if (!existsSync(targetPath)) {
      findings.push({
        checkId: 'CONTENT-1',
        level: 'WARN',
        file: spec.file,
        message: `Spec ${spec.file} governs "${governs}" but target does not resolve to a real file`,
      });
    }
  }

  return findings;
}

/**
 * Generate a drift-hashes.json manifest for all governed specs.
 *
 * CONTENT-2: Creates a hash manifest mapping spec filenames to their
 * SHA-256 content hashes. Used for drift detection across sessions.
 */
export function generateDriftHashes(root: string): Record<string, string> {
  const manifest: Record<string, string> = {};
  const specs = getGoverningSpecs(root);

  for (const spec of specs) {
    const content = readFileSync(spec.path, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    manifest[spec.file] = hash;
  }

  return manifest;
}

/**
 * CONTENT-2: Check for hash drift between current specs and a stored manifest.
 *
 * Compares current spec hashes against a previously-generated drift-hashes.json
 * manifest. Reports WARN findings for:
 * - Hash mismatches (spec content changed since manifest was generated)
 * - New specs not present in the manifest
 * - Specs in manifest that no longer exist on disk
 *
 * All findings are WARN per DEC-005 promotion policy.
 */
export function checkDriftHashes(
  root: string,
  manifest: Record<string, string>,
): DocHygieneFinding[] {
  const findings: DocHygieneFinding[] = [];
  const currentHashes = generateDriftHashes(root);

  // Check current specs against manifest
  for (const [file, hash] of Object.entries(currentHashes)) {
    if (!(file in manifest)) {
      findings.push({
        checkId: 'CONTENT-2',
        level: 'WARN',
        file,
        message: `Spec ${file} is not in the drift-hashes.json manifest — new or untracked`,
      });
    } else if (manifest[file] !== hash) {
      findings.push({
        checkId: 'CONTENT-2',
        level: 'WARN',
        file,
        message: `Spec ${file} has drift — hash mismatch against manifest`,
      });
    }
  }

  // Check for specs in manifest that no longer exist
  for (const file of Object.keys(manifest)) {
    if (!(file in currentHashes)) {
      findings.push({
        checkId: 'CONTENT-2',
        level: 'WARN',
        file,
        message: `Spec ${file} in drift-hashes.json manifest but no longer exists — drift detected`,
      });
    }
  }

  return findings;
}

/**
 * SC-514: Get governed specs whose targets overlap with changed files from git diff.
 *
 * Used for fast-exit scoping — if no governed files changed since the last
 * signal, skip the full content alignment check. Accepts a list of changed
 * file paths (from git diff --name-only) and returns only the SpecEntry
 * objects whose governs targets intersect with the changed set.
 *
 * Directory governs targets (e.g. "lib/") match any changed file under
 * that prefix. Prose-style governs are excluded from path matching.
 */
export function getChangedGoverned(
  root: string,
  changedFiles: string[],
): import('./spec-registry').SpecEntry[] {
  const specs = getGoverningSpecs(root);
  const matched: import('./spec-registry').SpecEntry[] = [];

  for (const spec of specs) {
    const governs = spec.governs.trim();

    // Skip prose-style governs — only match path-like targets
    if (!isPathLike(governs)) continue;

    // Check if any changed file matches this governs target
    const isDir = governs.endsWith('/');
    const hit = changedFiles.some(changed => {
      if (isDir) {
        // Directory target: any diff under that prefix counts
        return changed.startsWith(governs);
      }
      // Exact file match
      return changed === governs;
    });

    if (hit) {
      matched.push(spec);
    }
  }

  return matched;
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
