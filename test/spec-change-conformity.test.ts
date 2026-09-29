/**
 * Tests for spec-change-conformity lib module
 *
 * Issue: #581
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isSpecFile,
  runSpecChangeConformity,
  syncSpecTests,
  type SpecChangeConformityResult,
} from '../lib/spec-change-conformity';

describe('spec-change-conformity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spec-change-conformity-'));
  });

  afterEach(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('isSpecFile', () => {
    it('returns true for spec file paths', () => {
      expect(isSpecFile('specs/HOOK-ARCHITECTURE-SPEC.md')).toBe(true);
      expect(isSpecFile('/project/specs/MY-SPEC.md')).toBe(true);
      expect(isSpecFile('specs/foo.md')).toBe(true);
    });

    it('returns false for non-spec file paths', () => {
      expect(isSpecFile('lib/conformity.ts')).toBe(false);
      expect(isSpecFile('test/foo.test.ts')).toBe(false);
      expect(isSpecFile('specs/sub/nested.md')).toBe(false);
      expect(isSpecFile('hooks/SpecSCGuard.hook.ts')).toBe(false);
      expect(isSpecFile('not-specs/foo.md')).toBe(false);
    });
  });

  describe('runSpecChangeConformity', () => {
    it('returns zero counts when no unchecked SCs exist', () => {
      // Create a specs dir with a spec that has only checked SCs
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(
        join(specsDir, 'TEST-SPEC.md'),
        '# Test Spec\n\n- [x] SC-900: Already checked\n'
      );

      const result = runSpecChangeConformity(tempDir);
      expect(result.triggered).toBe(true);
      expect(result.flippedCount).toBe(0);
      expect(result.passing).toHaveLength(0);
      expect(result.failing).toHaveLength(0);
    });

    it('flips checkboxes for passing conformity SCs', () => {
      // Create a specs dir with an unchecked SC that uses the file-exists pattern
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      // file-exists regex: ^(\S+)\s+exists?\b — backtick-wrapped path, then "exists"
      writeFileSync(
        join(specsDir, 'TEST-SPEC.md'),
        '# Test Spec\n\n- [ ] SC-999: `specs/TEST-SPEC.md` exists\n'
      );

      const result = runSpecChangeConformity(tempDir);
      expect(result.triggered).toBe(true);
      // The SC references specs/TEST-SPEC.md which exists — should pass and flip
      expect(result.flippedCount).toBeGreaterThanOrEqual(1);
      expect(result.passing.length).toBeGreaterThanOrEqual(1);
    });

    it('reports failing SCs without flipping their checkboxes', () => {
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      // Use file-exists pattern with a file that doesn't exist
      writeFileSync(
        join(specsDir, 'TEST-SPEC.md'),
        '# Test Spec\n\n- [ ] SC-998: `nonexistent/file.ts` exists\n'
      );

      const result = runSpecChangeConformity(tempDir);
      expect(result.triggered).toBe(true);
      expect(result.flippedCount).toBe(0);
      // SC-998 should be in failing or unmatchable (not passing)
      expect(result.passing).not.toContain('SC-998');
    });
  });

  // AC-1: syncSpecTests triggers regeneration for testable specs
  describe('syncSpecTests', () => {
    it('returns syncTriggered:true when spec has testable:true frontmatter', () => {
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(
        join(specsDir, 'TESTABLE-SPEC.md'),
        '---\ndoc-type: spec\ntestable: true\n---\n# Testable Spec\n\n4. **GATE: some gate check**\n'
      );
      const result = syncSpecTests(tempDir, join(specsDir, 'TESTABLE-SPEC.md'));
      expect(result.syncTriggered).toBe(true);
    });

    it('returns syncTriggered:false when spec has testable:false', () => {
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(
        join(specsDir, 'NON-TESTABLE.md'),
        '---\ndoc-type: spec\ntestable: false\n---\n# Non-Testable\n'
      );
      const result = syncSpecTests(tempDir, join(specsDir, 'NON-TESTABLE.md'));
      expect(result.syncTriggered).toBe(false);
    });

    it('returns syncTriggered:false when spec has no frontmatter', () => {
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(
        join(specsDir, 'NO-FM.md'),
        '# No Frontmatter Spec\n\nJust text.\n'
      );
      const result = syncSpecTests(tempDir, join(specsDir, 'NO-FM.md'));
      expect(result.syncTriggered).toBe(false);
    });

    it('extracts claims from testable spec and returns claim count', () => {
      const specsDir = join(tempDir, 'specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(
        join(specsDir, 'CLAIMS-SPEC.md'),
        '---\ndoc-type: spec\ntestable: true\n---\n# Claims Spec\n\n**GATE: some check passes**\n\nQuinn validates on local dev\n'
      );
      const result = syncSpecTests(tempDir, join(specsDir, 'CLAIMS-SPEC.md'));
      expect(result.syncTriggered).toBe(true);
      expect(result.claimsExtracted).toBeGreaterThan(0);
    });
  });
});
