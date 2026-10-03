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
  checkDeadReferences,
  generateDriftHashes,
  checkDriftHashes,
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

  describe('CONTENT-1: dead-reference lint', () => {
    it('returns empty when governs targets resolve to real files', () => {
      // Create the target file that governs references
      mkdirSync(join(mockRoot, 'lib'), { recursive: true });
      writeFileSync(join(mockRoot, 'lib', 'scanner.ts'), 'export {}');

      writeFileSync(join(specsDir, 'SCANNER-SPEC.md'), [
        '---',
        'governs: lib/scanner.ts',
        'testable: true',
        '---',
        '# Scanner Spec',
      ].join('\n'));

      const findings = checkDeadReferences(mockRoot);
      expect(findings).toEqual([]);
    });

    it('returns WARN when governs target does not exist', () => {
      writeFileSync(join(specsDir, 'GHOST-SPEC.md'), [
        '---',
        'governs: lib/nonexistent-module.ts',
        'testable: true',
        '---',
        '# Ghost Spec',
      ].join('\n'));

      const findings = checkDeadReferences(mockRoot);
      expect(findings.length).toBe(1);
      expect(findings[0].checkId).toBe('CONTENT-1');
      expect(findings[0].level).toBe('WARN');
      expect(findings[0].file).toContain('GHOST-SPEC.md');
      expect(findings[0].message).toContain('governs');
    });

    it('skips prose-style governs (no path separator)', () => {
      writeFileSync(join(specsDir, 'PROSE-SPEC.md'), [
        '---',
        'governs: Session lifecycle management and cold-start behavior',
        'testable: true',
        '---',
        '# Prose Spec',
      ].join('\n'));

      const findings = checkDeadReferences(mockRoot);
      expect(findings).toEqual([]);
    });

    it('validates directory governs targets', () => {
      mkdirSync(join(mockRoot, 'lib'), { recursive: true });

      writeFileSync(join(specsDir, 'LIB-SPEC.md'), [
        '---',
        'governs: lib/',
        'testable: true',
        '---',
        '# Lib Spec',
      ].join('\n'));

      const findings = checkDeadReferences(mockRoot);
      expect(findings).toEqual([]);
    });

    it('CONTENT-1 findings are included in runContentAlignment', () => {
      writeFileSync(join(specsDir, 'DEAD-REF.md'), [
        '---',
        'governs: lib/does-not-exist.ts',
        'testable: true',
        '---',
        '# Dead Ref Spec',
      ].join('\n'));

      const findings = runContentAlignment(mockRoot);
      const content1 = findings.filter(f => f.checkId === 'CONTENT-1');
      expect(content1.length).toBe(1);
    });
  });

  describe('CONTENT-2: hash drift detection', () => {
    it('generates drift-hashes.json manifest for specs', () => {
      writeFileSync(join(specsDir, 'HASH-SPEC.md'), [
        '---',
        'governs: Hash feature — drift detection',
        'testable: true',
        '---',
        '# Hash Spec',
        'Content for hashing.',
      ].join('\n'));

      const manifest = generateDriftHashes(mockRoot);
      expect(manifest).toBeDefined();
      expect(manifest['HASH-SPEC.md']).toBeDefined();
      expect(typeof manifest['HASH-SPEC.md']).toBe('string');
      expect(manifest['HASH-SPEC.md'].length).toBeGreaterThan(0);
    });

    it('detects drift when spec content changes', () => {
      const specContent = [
        '---',
        'governs: Drift feature — hash tracking',
        'testable: true',
        '---',
        '# Drift Spec',
        'Original content.',
      ].join('\n');

      writeFileSync(join(specsDir, 'DRIFT-SPEC.md'), specContent);

      // Generate the initial manifest
      const oldManifest = generateDriftHashes(mockRoot);

      // Modify the spec content
      writeFileSync(join(specsDir, 'DRIFT-SPEC.md'), specContent.replace('Original', 'Changed'));

      // Check drift against old manifest
      const findings = checkDriftHashes(mockRoot, oldManifest);
      expect(findings.length).toBe(1);
      expect(findings[0].checkId).toBe('CONTENT-2');
      expect(findings[0].level).toBe('WARN');
      expect(findings[0].file).toContain('DRIFT-SPEC.md');
      expect(findings[0].message).toContain('drift');
    });

    it('returns empty findings when hashes match', () => {
      writeFileSync(join(specsDir, 'STABLE-SPEC.md'), [
        '---',
        'governs: Stable feature — no drift',
        'testable: true',
        '---',
        '# Stable Spec',
      ].join('\n'));

      const manifest = generateDriftHashes(mockRoot);
      const findings = checkDriftHashes(mockRoot, manifest);
      expect(findings).toEqual([]);
    });

    it('detects new specs not in manifest', () => {
      const manifest: Record<string, string> = {};

      writeFileSync(join(specsDir, 'NEW-SPEC.md'), [
        '---',
        'governs: New feature — not in manifest',
        'testable: true',
        '---',
        '# New Spec',
      ].join('\n'));

      const findings = checkDriftHashes(mockRoot, manifest);
      expect(findings.length).toBe(1);
      expect(findings[0].checkId).toBe('CONTENT-2');
      expect(findings[0].level).toBe('WARN');
      expect(findings[0].message).toContain('manifest');
    });

    it('detects deleted specs still in manifest', () => {
      writeFileSync(join(specsDir, 'TEMP-SPEC.md'), [
        '---',
        'governs: Temp feature — will be deleted',
        'testable: true',
        '---',
        '# Temp Spec',
      ].join('\n'));

      const manifest = generateDriftHashes(mockRoot);
      // Delete the spec
      rmSync(join(specsDir, 'TEMP-SPEC.md'));

      const findings = checkDriftHashes(mockRoot, manifest);
      expect(findings.length).toBe(1);
      expect(findings[0].checkId).toBe('CONTENT-2');
      expect(findings[0].message).toContain('drift');
    });

    it('CONTENT-2 manifest generation includes all governed specs', () => {
      writeFileSync(join(specsDir, 'A-SPEC.md'), [
        '---',
        'governs: Feature A — handles A things',
        '---',
        '# A Spec',
      ].join('\n'));
      writeFileSync(join(specsDir, 'B-SPEC.md'), [
        '---',
        'governs: Feature B — handles B things',
        '---',
        '# B Spec',
      ].join('\n'));

      const manifest = generateDriftHashes(mockRoot);
      expect(Object.keys(manifest).length).toBe(2);
      expect(manifest['A-SPEC.md']).toBeDefined();
      expect(manifest['B-SPEC.md']).toBeDefined();
    });
  });
});
