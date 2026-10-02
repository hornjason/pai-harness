/**
 * Tests for lib/doc-hygiene.ts — content alignment and hygiene checks.
 *
 * SC-509: lib/doc-hygiene.ts exports [runContentAlignment, checkDocHygiene]
 * Issue: #24
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  runContentAlignment,
  checkDocHygiene,
} from '../lib/doc-hygiene';

describe('doc-hygiene', () => {
  let mockRoot: string;
  let specsDir: string;

  beforeEach(() => {
    mockRoot = mkdtempSync(join(tmpdir(), 'doc-hygiene-test-'));
    specsDir = join(mockRoot, 'specs');
    mkdirSync(specsDir, { recursive: true });
  });

  afterEach(() => {
    if (mockRoot) {
      try { rmSync(mockRoot, { recursive: true, force: true }); } catch {}
    }
  });

  describe('runContentAlignment', () => {
    it('returns empty findings for valid specs', () => {
      writeFileSync(join(specsDir, 'GOOD-SPEC.md'), [
        '---',
        'governs: Good feature — handles good things',
        'testable: true',
        '---',
        '',
        '# Good Spec',
        '',
        'This spec is valid.',
      ].join('\n'));

      const findings = runContentAlignment(mockRoot);
      expect(findings).toEqual([]);
    });

    it('returns WARN for specs without governs', () => {
      writeFileSync(join(specsDir, 'BAD-SPEC.md'), [
        '---',
        'doc-type: spec',
        '---',
        '',
        '# Bad Spec',
      ].join('\n'));

      const findings = runContentAlignment(mockRoot);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].level).toBe('WARN');
      expect(findings[0].file).toContain('BAD-SPEC.md');
    });

    it('returns empty findings when specs/ does not exist', () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'no-specs-dh-'));
      try {
        const findings = runContentAlignment(emptyRoot);
        expect(findings).toEqual([]);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });
  });

  describe('checkDocHygiene', () => {
    it('returns pass result when no findings', () => {
      writeFileSync(join(specsDir, 'OK-SPEC.md'), [
        '---',
        'governs: OK feature — everything fine',
        '---',
        '# OK Spec',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      expect(result.pass).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('returns fail result with findings when issues exist', () => {
      writeFileSync(join(specsDir, 'PROBLEM.md'), [
        '---',
        'doc-type: spec',
        '---',
        '# Problem Spec',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      expect(result.pass).toBe(false);
      expect(result.findings.length).toBeGreaterThanOrEqual(1);
    });

    it('includes check-id in findings for signal tracking', () => {
      writeFileSync(join(specsDir, 'SIGNAL.md'), [
        '---',
        'doc-type: spec',
        '---',
        '# Signal Spec',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      if (result.findings.length > 0) {
        expect(result.findings[0].checkId).toBeDefined();
        expect(typeof result.findings[0].checkId).toBe('string');
      }
    });
  });
});
