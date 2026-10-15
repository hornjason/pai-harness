/**
 * Tests for task completion quality checks
 *
 * Issue: #579
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkTests,
  checkUncommittedChanges,
  checkConformity,
  runAllCompletionChecks,
} from '../lib/task-completion-checks';
import { spawnSync } from 'child_process';

describe('task-completion-checks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-completion-test-'));
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

  describe('checkTests', () => {
    it('passes when tests pass', () => {
      // Create a minimal test file that passes
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' })
      );
      writeFileSync(
        join(tempDir, 'pass.test.ts'),
        'import { test, expect } from "bun:test"; test("pass", () => expect(true).toBe(true));'
      );

      const result = checkTests(tempDir);
      expect(result.passed).toBe(true);
      expect(result.blockers).toHaveLength(0);
    });

    it('blocks when tests fail', () => {
      // Create a test file that fails
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' })
      );
      writeFileSync(
        join(tempDir, 'fail.test.ts'),
        'import { test, expect } from "bun:test"; test("fail", () => expect(true).toBe(false));'
      );

      const result = checkTests(tempDir);
      expect(result.passed).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.blockers[0]).toContain('failing test');
    });

    it('warns when tests cannot run', () => {
      // No test files or package.json
      const result = checkTests(tempDir);
      expect(result.passed).toBe(true); // No blockers, but may have warnings
      // Either passes with no tests or warns about test issues
    });
  });

  describe('checkUncommittedChanges', () => {
    it('passes with no uncommitted changes', () => {
      // Initialize git repo with no changes
      spawnSync('git', ['init'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

      const result = checkUncommittedChanges(tempDir);
      expect(result.passed).toBe(true);
      expect(result.blockers).toHaveLength(0);
    });

    it('warns with uncommitted changes', () => {
      // Initialize git repo and create an uncommitted file
      spawnSync('git', ['init'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
      writeFileSync(join(tempDir, 'uncommitted.txt'), 'test');

      const result = checkUncommittedChanges(tempDir);
      expect(result.passed).toBe(true); // Warnings don't block
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('uncommitted');
    });

    it('passes gracefully when not in a git repo', () => {
      const result = checkUncommittedChanges(tempDir);
      expect(result.passed).toBe(true);
      expect(result.blockers).toHaveLength(0);
    });
  });

  describe('checkConformity', () => {
    it('passes when no rungate.json exists', () => {
      const result = checkConformity(tempDir);
      expect(result.passed).toBe(true);
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('runs conformity check when rungate.json exists', () => {
      // Create .claude/rungate.json
      const claudeDir = join(tempDir, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'rungate.json'), JSON.stringify({ version: '1.0' }));

      // Create package.json
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' })
      );

      const result = checkConformity(tempDir);
      // Result depends on whether conformity test exists
      expect(result).toBeDefined();
    });

    it('runs conformity check on the directory layout too', () => {
      // The monolith-only existence check meant every consumer that followed
      // the documented migration to `.claude/rungate/` silently stopped having
      // this gate run, and it reported passed (#214).
      const dir = join(tempDir, '.claude', 'rungate');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ project: 'x' }));
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'test', type: 'module' }));

      const result = checkConformity(tempDir);
      // No conformity suite in the fixture, so the run cannot come back clean.
      // The assertion is that it RAN — a skipped gate returns the empty shape.
      expect(result.blockers.length + result.warnings.length).toBeGreaterThan(0);
    });

    it('blocks rather than throwing when the config cannot be read', () => {
      // #214 regression. `tryLoadRungateConfig` throws on malformed JSON by
      // design — a corrupt config is never a missing one — but this function
      // is reached from `hooks/TaskCompleted.hook.ts`, which has no catch. An
      // escaping throw exits the hook 1, and 1 is neither "allow" (0) nor
      // "block" (2): the WHOLE completion gate stops blocking, not just the
      // conformity part. One unparseable byte would have disabled it.
      const dir = join(tempDir, '.claude', 'rungate');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), '{ not json');

      let result!: ReturnType<typeof checkConformity>;
      expect(() => { result = checkConformity(tempDir); }).not.toThrow();
      expect(result.passed, 'an unreadable config waved the gate through').toBe(false);
      expect(result.blockers.join(' ')).toMatch(/config/i);
      // And it must not be mistaken for the unscaffolded case, which passes.
      expect(checkConformity(mkdtempSync(join(tmpdir(), 'tcc-none-'))).passed).toBe(true);
    });

    it('does not quote the file back when reporting that it could not be parsed', () => {
      // Second push-review finding. `JSON.parse` names the token it choked on,
      // so a config whose malformation sits next to a credential would print
      // it into a blocker that reaches stderr and the transcript. The blocker
      // carries the error CLASS and a command the operator can run locally.
      const dir = join(tempDir, '.claude', 'rungate');
      mkdirSync(dir, { recursive: true });
      const SECRET = 'NOT-A-REAL-TOKEN-0123456789';
      writeFileSync(join(dir, 'config.json'), `{ "token": ${SECRET} }`);

      const result = checkConformity(tempDir);
      expect(result.passed).toBe(false);
      const text = result.blockers.join(' ');
      expect(text, 'the parser quoted the file into the blocker').not.toContain(SECRET);
      // Still actionable: it says which class of failure and how to see more.
      expect(text).toContain('SyntaxError');
      expect(text).toContain('loadRungateConfig');
    });

    it('hands the operator no line to paste built from the project root', () => {
      // Third push-review finding. The first draft of the blocker printed
      // `bun -e '…${projectRoot}…'` for the operator to run. This is a library
      // function and the root comes from the caller, so a path carrying a
      // quote and a semicolon would have been printed as a command a human is
      // being told to execute — an execution path with a person in the middle.
      const root = mkdtempSync(join(tmpdir(), "tcc-inject-'; touch pwned; '"));
      const dir = join(root, '.claude', 'rungate');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), '{ broken');

      const text = checkConformity(root).blockers.join(' ');
      try {
        expect(text, 'the blocker suggests a shell command').not.toMatch(/\bbun -e\b/);
        // The path still appears, so the refusal is still actionable — but
        // JSON-quoted, so the injected quote is escaped rather than closing
        // the one around it.
        expect(text).toContain(JSON.stringify(join(root, '.claude')));
        expect(text).not.toContain(`'${join(root, '.claude')}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('runAllCompletionChecks', () => {
    it('aggregates all check results', () => {
      // Initialize git repo with passing tests
      spawnSync('git', ['init'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' })
      );
      writeFileSync(
        join(tempDir, 'pass.test.ts'),
        'import { test, expect } from "bun:test"; test("pass", () => expect(true).toBe(true));'
      );

      const result = runAllCompletionChecks(tempDir);
      expect(result).toBeDefined();
      expect(result.passed).toBeDefined();
      expect(Array.isArray(result.blockers)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('blocks when any check fails', () => {
      // Create failing test
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', type: 'module' })
      );
      writeFileSync(
        join(tempDir, 'fail.test.ts'),
        'import { test, expect } from "bun:test"; test("fail", () => expect(true).toBe(false));'
      );

      const result = runAllCompletionChecks(tempDir);
      expect(result.passed).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
    });
  });
});
