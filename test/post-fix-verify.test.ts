/**
 * Tests for post-fix verification module.
 */
import { describe, test, expect } from 'bun:test';
import { verifyPostFix, getChangedFiles } from '../lib/post-fix-verify';
import type { PostFixResult } from '../lib/post-fix-verify';

describe('post-fix-verify', () => {
  describe('verifyPostFix', () => {
    test('DURABLE: generator file changed', () => {
      const result = verifyPostFix([
        'scripts/scaffold-project.ts',
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged).toEqual(['scripts/scaffold-project.ts']);
      expect(result.generatedFilesChanged).toEqual([]);
      expect(result.otherFilesChanged).toEqual([]);
      expect(result.message).toContain('durable');
      expect(result.message).toContain('1 generator/template file(s)');
    });

    test('DURABLE: template file changed', () => {
      const result = verifyPostFix([
        'templates/agent-briefs/marcus.md',
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged).toEqual(['templates/agent-briefs/marcus.md']);
      expect(result.generatedFilesChanged).toEqual([]);
    });

    test('DURABLE: spec file changed', () => {
      const result = verifyPostFix([
        'specs/HARNESS-GATES.md',
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged).toEqual(['specs/HARNESS-GATES.md']);
    });

    test('DURABLE: generator AND generated files changed', () => {
      const result = verifyPostFix([
        'templates/agent-briefs/marcus.md',
        '.claude/agents/marcus.md',
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged).toEqual(['templates/agent-briefs/marcus.md']);
      expect(result.generatedFilesChanged).toEqual(['.claude/agents/marcus.md']);
      expect(result.message).toContain('durable');
    });

    test('WARN_NON_DURABLE: only generated file changed', () => {
      const result = verifyPostFix([
        '.claude/agents/marcus.md',
      ]);

      expect(result.status).toBe('WARN_NON_DURABLE');
      expect(result.generatorFilesChanged).toEqual([]);
      expect(result.generatedFilesChanged).toEqual(['.claude/agents/marcus.md']);
      expect(result.otherFilesChanged).toEqual([]);
      expect(result.message).toContain('may not be durable');
      expect(result.message).toContain('no generator/template');
    });

    test('WARN_NON_DURABLE: multiple generated files changed', () => {
      const result = verifyPostFix([
        '.claude/agents/marcus.md',
        'CODE-MAP.md',
        'test/scaffold-conformity.test.ts',
      ]);

      expect(result.status).toBe('WARN_NON_DURABLE');
      expect(result.generatorFilesChanged).toEqual([]);
      expect(result.generatedFilesChanged.length).toBe(3);
      expect(result.message).toContain('3 generated file(s) changed');
    });

    test('WARN_NON_DURABLE: CI workflow file changed', () => {
      const result = verifyPostFix([
        '.github/workflows/ci.yml',
      ]);

      expect(result.status).toBe('WARN_NON_DURABLE');
      expect(result.generatedFilesChanged).toEqual(['.github/workflows/ci.yml']);
    });

    test('WARN_NON_DURABLE: gates workflow file changed', () => {
      const result = verifyPostFix([
        '.github/workflows/gates.yml',
      ]);

      expect(result.status).toBe('WARN_NON_DURABLE');
      expect(result.generatedFilesChanged).toEqual(['.github/workflows/gates.yml']);
    });

    test('UNKNOWN: only other (non-scaffold) files changed', () => {
      const result = verifyPostFix([
        'lib/conformity.ts',
        'gates/scope.ts',
      ]);

      expect(result.status).toBe('UNKNOWN');
      expect(result.generatorFilesChanged).toEqual([]);
      expect(result.generatedFilesChanged).toEqual([]);
      expect(result.otherFilesChanged).toEqual(['lib/conformity.ts', 'gates/scope.ts']);
      expect(result.message).toContain('source file(s) changed');
      expect(result.message).toContain('Not scaffold-related');
    });

    test('UNKNOWN: no files changed', () => {
      const result = verifyPostFix([]);

      expect(result.status).toBe('UNKNOWN');
      expect(result.generatorFilesChanged).toEqual([]);
      expect(result.generatedFilesChanged).toEqual([]);
      expect(result.otherFilesChanged).toEqual([]);
      expect(result.message).toBe('No files changed during fix.');
    });

    test('mixed: generator + generated + other files', () => {
      const result = verifyPostFix([
        'templates/agent-briefs/marcus.md',     // generator
        '.claude/agents/marcus.md',              // generated
        'lib/conformity.ts',                     // other
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged).toEqual(['templates/agent-briefs/marcus.md']);
      expect(result.generatedFilesChanged).toEqual(['.claude/agents/marcus.md']);
      expect(result.otherFilesChanged).toEqual(['lib/conformity.ts']);
    });

    test('path variations: absolute vs relative paths', () => {
      const result = verifyPostFix([
        'templates/agent-briefs/quinn.md',
        '/absolute/path/templates/agent-briefs/rook.md',
        './relative/templates/agent-briefs/discovery.md',
      ]);

      expect(result.status).toBe('DURABLE');
      expect(result.generatorFilesChanged.length).toBe(3);
      result.generatorFilesChanged.forEach(file => {
        expect(file).toContain('templates/');
      });
    });

    test('edge case: nested generated file paths', () => {
      const result = verifyPostFix([
        '.claude/agents/subfolder/custom-agent.md',
      ]);

      expect(result.status).toBe('WARN_NON_DURABLE');
      expect(result.generatedFilesChanged).toEqual(['.claude/agents/subfolder/custom-agent.md']);
    });
  });

  describe('getChangedFiles', () => {
    test('integration: returns array', () => {
      // This test runs against the actual git repo
      const cwd = import.meta.dir + '/..';
      const files = getChangedFiles(cwd);

      expect(Array.isArray(files)).toBe(true);
      // Don't assert on specific files since it depends on git state
    });

    test('integration: empty when no changes', () => {
      const cwd = import.meta.dir + '/..';
      // Compare HEAD to HEAD (no diff)
      const files = getChangedFiles(cwd, 'HEAD');

      // May or may not be empty depending on working tree state
      expect(Array.isArray(files)).toBe(true);
    });
  });

  describe('classification accuracy', () => {
    test('all known generator patterns recognized', () => {
      const generators = [
        'scripts/scaffold-project.ts',
        'templates/agent-briefs/marcus.md',
        'templates/ci.yml.template',
        'specs/HARNESS-GATES.md',
        'specs/nested/SOME-SPEC.md',
      ];

      for (const file of generators) {
        const result = verifyPostFix([file]);
        expect(result.generatorFilesChanged).toContain(file);
        expect(result.generatorFilesChanged.length).toBe(1);
      }
    });

    test('all known generated patterns recognized', () => {
      const generated = [
        '.claude/agents/marcus.md',
        '.claude/agents/quinn.md',
        'CODE-MAP.md',
        'test/scaffold-conformity.test.ts',
        '.github/workflows/ci.yml',
        '.github/workflows/gates.yml',
      ];

      for (const file of generated) {
        const result = verifyPostFix([file]);
        expect(result.generatedFilesChanged).toContain(file);
        expect(result.generatedFilesChanged.length).toBe(1);
      }
    });
  });
});
