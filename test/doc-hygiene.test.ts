/**
 * Tests for doc-hygiene — content alignment and drift detection module
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
    it('returns empty findings when all specs have valid governs', () => {
      writeFileSync(join(specsDir, 'GOOD-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Gate definitions — what checks run',
        'testable: true',
        '---',
        '',
        '# Good Spec',
      ].join('\n'));

      const findings = runContentAlignment(mockRoot);
      expect(findings).toEqual([]);
    });

    it('reports findings for specs with missing governs', () => {
      writeFileSync(join(specsDir, 'MISSING.md'), [
        '---',
        'doc-type: spec',
        'testable: false',
        '---',
        '',
        '# Missing governs',
      ].join('\n'));

      const findings = runContentAlignment(mockRoot);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].level).toBe('WARN');
    });

    it('returns empty findings when specs dir does not exist', () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'doc-hygiene-empty-'));
      try {
        const findings = runContentAlignment(emptyRoot);
        expect(findings).toEqual([]);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });
  });

  describe('checkDocHygiene', () => {
    it('returns a result with findings and summary', () => {
      writeFileSync(join(specsDir, 'SOME-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Something useful — does a specific thing',
        'testable: true',
        '---',
        '',
        '# Some Spec',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      expect(result).toHaveProperty('findings');
      expect(result).toHaveProperty('summary');
      expect(Array.isArray(result.findings)).toBe(true);
    });

    it('includes ungoverned spec count in summary', () => {
      writeFileSync(join(specsDir, 'UNGOVERNED.md'), [
        '---',
        'doc-type: spec',
        'testable: false',
        '---',
        '',
        '# Ungoverned',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      expect(result.summary.ungoverned).toBeGreaterThanOrEqual(1);
    });

    it('returns clean summary when all specs governed', () => {
      writeFileSync(join(specsDir, 'ALL-GOOD.md'), [
        '---',
        'doc-type: spec',
        'governs: Everything is fine — no issues here',
        'testable: true',
        '---',
        '',
        '# All Good',
      ].join('\n'));

      const result = checkDocHygiene(mockRoot);
      expect(result.summary.ungoverned).toBe(0);
      expect(result.findings).toHaveLength(0);
    });
  });
});
