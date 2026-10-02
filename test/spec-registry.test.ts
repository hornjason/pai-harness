/**
 * Tests for spec-registry — governs-field discovery module
 *
 * SC-507: test/spec-registry.test.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned, mock]
 * Issue: #24
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  getGoverningSpecs,
  getGovernedFiles,
  getUngoverned,
} from '../lib/spec-registry';

describe('spec-registry', () => {
  let mockRoot: string;
  let specsDir: string;

  beforeEach(() => {
    mockRoot = mkdtempSync(join(tmpdir(), 'spec-registry-test-'));
    specsDir = join(mockRoot, 'specs');
    mkdirSync(specsDir, { recursive: true });
  });

  afterEach(() => {
    if (mockRoot) {
      try { rmSync(mockRoot, { recursive: true, force: true }); } catch {}
    }
  });

  describe('getGoverningSpecs', () => {
    it('returns empty array when no specs directory exists', () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'spec-registry-empty-'));
      try {
        const result = getGoverningSpecs(emptyRoot);
        expect(result).toEqual([]);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });

    it('returns specs with governs frontmatter', () => {
      writeFileSync(join(specsDir, 'TEST-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Hook architecture — hooks delegate to lib/',
        'testable: true',
        '---',
        '',
        '# Test Spec',
      ].join('\n'));

      const result = getGoverningSpecs(mockRoot);
      expect(result.length).toBe(1);
      expect(result[0].file).toBe('TEST-SPEC.md');
      expect(result[0].governs).toContain('Hook architecture');
    });

    it('skips specs with missing or TODO governs', () => {
      writeFileSync(join(specsDir, 'NO-GOVERNS.md'), [
        '---',
        'doc-type: spec',
        'testable: false',
        '---',
        '',
        '# No Governs',
      ].join('\n'));

      writeFileSync(join(specsDir, 'TODO-GOVERNS.md'), [
        '---',
        'doc-type: spec',
        'governs: TODO',
        'testable: false',
        '---',
        '',
        '# TODO Governs',
      ].join('\n'));

      const result = getGoverningSpecs(mockRoot);
      expect(result).toEqual([]);
    });

    it('skips SPEC-TEMPLATE.md', () => {
      writeFileSync(join(specsDir, 'SPEC-TEMPLATE.md'), [
        '---',
        'doc-type: spec',
        'governs: Template — do not use',
        'testable: false',
        '---',
        '',
        '# Template',
      ].join('\n'));

      const result = getGoverningSpecs(mockRoot);
      expect(result).toEqual([]);
    });

    it('includes subdirectory specs', () => {
      const subDir = join(specsDir, 'bootstrap-data-flow');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'PHASE-1.md'), [
        '---',
        'doc-type: spec',
        'governs: Bootstrap phase 1 — initial data loading',
        'testable: true',
        '---',
        '',
        '# Phase 1',
      ].join('\n'));

      const result = getGoverningSpecs(mockRoot);
      expect(result.length).toBe(1);
      expect(result[0].file).toContain('bootstrap-data-flow/PHASE-1.md');
    });
  });

  describe('getGovernedFiles', () => {
    it('returns an invertedIndex mapping governs text to spec files', () => {
      writeFileSync(join(specsDir, 'GATE-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Gate definitions — what checks run at each gate',
        'testable: true',
        '---',
        '',
        '# Gate Spec',
      ].join('\n'));

      writeFileSync(join(specsDir, 'HOOK-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Hook architecture — hooks as thin triggers',
        'testable: true',
        '---',
        '',
        '# Hook Spec',
      ].join('\n'));

      const result = getGovernedFiles(mockRoot);
      expect(Object.keys(result).length).toBe(2);
      // Each governs text maps to its spec file
      const values = Object.values(result);
      expect(values).toContainEqual(expect.arrayContaining(['GATE-SPEC.md']));
      expect(values).toContainEqual(expect.arrayContaining(['HOOK-SPEC.md']));
    });

    it('returns empty object when no specs have governs', () => {
      writeFileSync(join(specsDir, 'EMPTY.md'), [
        '---',
        'doc-type: spec',
        'testable: false',
        '---',
        '',
        '# Empty',
      ].join('\n'));

      const result = getGovernedFiles(mockRoot);
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe('getUngoverned', () => {
    it('returns specs that have no governs field', () => {
      writeFileSync(join(specsDir, 'GOVERNED.md'), [
        '---',
        'doc-type: spec',
        'governs: Something specific — does a thing',
        'testable: true',
        '---',
        '',
        '# Governed',
      ].join('\n'));

      writeFileSync(join(specsDir, 'UNGOVERNED.md'), [
        '---',
        'doc-type: spec',
        'testable: false',
        '---',
        '',
        '# Ungoverned',
      ].join('\n'));

      const result = getUngoverned(mockRoot);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('UNGOVERNED.md');
    });

    it('includes specs with TODO governs as ungoverned', () => {
      writeFileSync(join(specsDir, 'TODO-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: TODO — describe what this spec governs',
        'testable: false',
        '---',
        '',
        '# TODO',
      ].join('\n'));

      const result = getUngoverned(mockRoot);
      expect(result).toContainEqual('TODO-SPEC.md');
    });

    it('returns empty array when all specs are governed', () => {
      writeFileSync(join(specsDir, 'FULL.md'), [
        '---',
        'doc-type: spec',
        'governs: Full governance — covers everything needed',
        'testable: true',
        '---',
        '',
        '# Full',
      ].join('\n'));

      const result = getUngoverned(mockRoot);
      expect(result).toHaveLength(0);
    });
  });
});
