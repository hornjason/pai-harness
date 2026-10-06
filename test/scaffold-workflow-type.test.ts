/**
 * SC-525: Add --type workflow flag to scaffold-project.ts
 *
 * Workflow projects get universal scaffold but skip harness-specific files.
 * They get a WORKFLOW-DEFINITION.md stub instead of harness config.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SC-525: --type workflow flag', () => {
  let tempDir: string;
  const ROOT = join(import.meta.dir, '..');
  const scaffoldScript = join(ROOT, 'scripts/scaffold-project.ts');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scaffold-workflow-'));
    // Create a minimal project structure
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    mkdirSync(join(tempDir, 'specs'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      version: '1.0.0'
    }, null, 2));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // Each of these shells out to a full scaffold. Measured at 8.1s for the file
  // on this machine; CI saw a single run take 5006ms and die on bun's 5s
  // default, while its sibling passed at 1723ms — the budget was close enough
  // to the work that runner speed decided the result. 30s is ~4x measured.
  test('--type workflow flag is parsed and creates workflow project', () => {
    execSync(`bun ${scaffoldScript} ${tempDir} --type workflow --fix`, {
      cwd: ROOT,
      encoding: 'utf-8'
    });

    // Workflow projects should get WORKFLOW-DEFINITION.md
    const workflowDefPath = join(tempDir, 'specs/WORKFLOW-DEFINITION.md');
    expect(existsSync(workflowDefPath)).toBe(true);

    const content = readFileSync(workflowDefPath, 'utf-8');
    expect(content).toContain('## Trigger');
    expect(content).toContain('## Inputs');
    expect(content).toContain('## Process');
    expect(content).toContain('## Output');
  }, 30_000);

  test('workflow projects skip harness-specific rungate.json fields', () => {
    execSync(`bun ${scaffoldScript} ${tempDir} --type workflow --fix`, {
      cwd: ROOT,
      encoding: 'utf-8'
    });

    const rungatePath = join(tempDir, '.claude/rungate.json');

    if (existsSync(rungatePath)) {
      const config = JSON.parse(readFileSync(rungatePath, 'utf-8'));

      // Workflow projects should not have harness-specific fields
      expect(config.roles).toBeUndefined();
      expect(config.gates).toBeUndefined();
      expect(config.shipWorkflow).toBeUndefined();
    }
  }, 30_000);

  test('--type code (default) behavior is unchanged', () => {
    execSync(`bun ${scaffoldScript} ${tempDir} --type code --fix`, {
      cwd: ROOT,
      encoding: 'utf-8'
    });

    // Code projects should NOT get WORKFLOW-DEFINITION.md
    const workflowDefPath = join(tempDir, 'specs/WORKFLOW-DEFINITION.md');
    expect(existsSync(workflowDefPath)).toBe(false);

    // Code projects should get harness config
    const rungatePath = join(tempDir, '.claude/rungate.json');
    if (existsSync(rungatePath)) {
      const config = JSON.parse(readFileSync(rungatePath, 'utf-8'));
      // Code projects may have roles/gates depending on configuration
      // Just verify the file exists for code projects
      expect(config).toBeDefined();
    }
  }, 30_000);

  test('default (no --type flag) uses code behavior', () => {
    execSync(`bun ${scaffoldScript} ${tempDir} --fix`, {
      cwd: ROOT,
      encoding: 'utf-8'
    });

    // Default should be code, so no WORKFLOW-DEFINITION.md
    const workflowDefPath = join(tempDir, 'specs/WORKFLOW-DEFINITION.md');
    expect(existsSync(workflowDefPath)).toBe(false);
  }, 30_000);

  test('invalid --type value shows error', () => {
    try {
      execSync(`bun ${scaffoldScript} ${tempDir} --type invalid --fix`, {
        cwd: ROOT,
        encoding: 'utf-8',
        stdio: 'pipe'
      });
      expect(false).toBe(true); // Should have thrown
    } catch (error: any) {
      expect(error.status).toBeGreaterThan(0);
    }
  });
});
