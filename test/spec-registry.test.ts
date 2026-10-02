/**
 * Tests for lib/spec-registry.ts — governs-field discovery module.
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
    it('returns specs with parsed governs frontmatter', () => {
      writeFileSync(join(specsDir, 'TEST-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: Test feature — handles testing of things',
        'testable: true',
        '---',
        '',
        '# Test Spec',
      ].join('\n'));

      const specs = getGoverningSpecs(mockRoot);
      expect(specs).toHaveLength(1);
      expect(specs[0].file).toBe('TEST-SPEC.md');
      expect(specs[0].governs).toBe('Test feature — handles testing of things');
    });

    it('skips specs without governs field', () => {
      writeFileSync(join(specsDir, 'NO-GOVERNS.md'), [
        '---',
        'doc-type: spec',
        'testable: true',
        '---',
        '',
        '# No Governs',
      ].join('\n'));

      const specs = getGoverningSpecs(mockRoot);
      expect(specs).toHaveLength(0);
    });

    it('skips specs with TODO governs', () => {
      writeFileSync(join(specsDir, 'TODO-SPEC.md'), [
        '---',
        'doc-type: spec',
        'governs: TODO',
        '---',
        '',
        '# TODO Spec',
      ].join('\n'));

      const specs = getGoverningSpecs(mockRoot);
      expect(specs).toHaveLength(0);
    });

    it('skips SPEC-TEMPLATE.md', () => {
      writeFileSync(join(specsDir, 'SPEC-TEMPLATE.md'), [
        '---',
        'governs: Template',
        '---',
        '',
        '# Template',
      ].join('\n'));

      const specs = getGoverningSpecs(mockRoot);
      expect(specs).toHaveLength(0);
    });

    it('returns empty array when specs/ does not exist', () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'no-specs-'));
      try {
        const specs = getGoverningSpecs(emptyRoot);
        expect(specs).toEqual([]);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });

    it('scans subdirectories under specs/', () => {
      const subDir = join(specsDir, 'sub-feature');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'SUB-SPEC.md'), [
        '---',
        'governs: Sub feature — nested spec discovery',
        '---',
        '',
        '# Sub Spec',
      ].join('\n'));

      const specs = getGoverningSpecs(mockRoot);
      expect(specs.length).toBeGreaterThanOrEqual(1);
      const subSpec = specs.find(s => s.file.includes('SUB-SPEC.md'));
      expect(subSpec).toBeDefined();
      expect(subSpec!.governs).toContain('Sub feature');
    });
  });

  describe('getGovernedFiles', () => {
    it('returns an inverted index mapping governs text to spec files', () => {
      writeFileSync(join(specsDir, 'A-SPEC.md'), [
        '---',
        'governs: Feature A — first feature',
        '---',
        '# A',
      ].join('\n'));
      writeFileSync(join(specsDir, 'B-SPEC.md'), [
        '---',
        'governs: Feature B — second feature',
        '---',
        '# B',
      ].join('\n'));

      const invertedIndex = getGovernedFiles(mockRoot);
      expect(Object.keys(invertedIndex)).toHaveLength(2);
      expect(invertedIndex['Feature A — first feature']).toContain('A-SPEC.md');
      expect(invertedIndex['Feature B — second feature']).toContain('B-SPEC.md');
    });

    it('returns empty object when no specs have governs', () => {
      writeFileSync(join(specsDir, 'EMPTY.md'), '# No frontmatter');
      const invertedIndex = getGovernedFiles(mockRoot);
      expect(Object.keys(invertedIndex)).toHaveLength(0);
    });
  });

  describe('getUngoverned', () => {
    it('returns spec files that have no governs field', () => {
      writeFileSync(join(specsDir, 'GOVERNED.md'), [
        '---',
        'governs: Something real',
        '---',
        '# Governed',
      ].join('\n'));
      writeFileSync(join(specsDir, 'UNGOVERNED.md'), [
        '---',
        'doc-type: spec',
        '---',
        '# Ungoverned',
      ].join('\n'));
      writeFileSync(join(specsDir, 'NO-FM.md'), '# No frontmatter at all');

      const ungoverned = getUngoverned(mockRoot);
      expect(ungoverned).toContain('UNGOVERNED.md');
      expect(ungoverned).toContain('NO-FM.md');
      expect(ungoverned).not.toContain('GOVERNED.md');
    });

    it('skips SPEC-TEMPLATE.md', () => {
      writeFileSync(join(specsDir, 'SPEC-TEMPLATE.md'), '# Template');
      const ungoverned = getUngoverned(mockRoot);
      expect(ungoverned).not.toContain('SPEC-TEMPLATE.md');
    });
  });
});
