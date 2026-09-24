/**
 * Task Completion Quality Checks
 *
 * Quality gates that run before allowing task completion.
 * Used by TaskCompleted hook to ensure work meets minimum standards.
 *
 * Issue: #579
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface CompletionCheckResult {
  passed: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Run test suite and check for failures.
 * Returns blocker if tests fail, warning if tests can't run.
 */
export function checkTests(projectRoot: string): CompletionCheckResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  try {
    const result = spawnSync('bun', ['test'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout
    });

    // Parse test output for failures
    // Combine stdout and stderr as bun test may use either
    const output = (result.stdout || '') + (result.stderr || '');
    const failMatch = output.match(/(\d+) fail/);
    const passMatch = output.match(/(\d+) pass/);

    // Check for failures first
    if (failMatch) {
      const failCount = parseInt(failMatch[1], 10);
      if (failCount > 0) {
        blockers.push(`Test suite has ${failCount} failing test(s). Fix failures before completing task.`);
      }
    }

    // If exit code is non-zero, treat it as a failure even if we can't parse the output
    if (result.status !== 0 && blockers.length === 0) {
      // Look for test failure patterns (not just any error)
      if (output.match(/\(fail\)/i) || output.match(/test.*failed/i)) {
        blockers.push('Test suite failed with errors. Check test output for details.');
      } else if (output.match(/no test files found/i) || output.match(/0 tests/i)) {
        warnings.push('No test files found or tests defined.');
      } else {
        warnings.push('Test command exited with non-zero status, but no explicit failures found.');
      }
    }

    if (passMatch) {
      const passCount = parseInt(passMatch[1], 10);
      if (passCount === 0 && blockers.length === 0 && result.status === 0) {
        warnings.push('No tests passed — possible test suite issue.');
      }
    }
  } catch (err) {
    warnings.push(`Could not run tests: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  };
}

/**
 * Check for uncommitted changes.
 * Returns warning if there are uncommitted files.
 */
export function checkUncommittedChanges(projectRoot: string): CompletionCheckResult {
  const warnings: string[] = [];

  try {
    const result = spawnSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    const output = (result.stdout || '').trim();
    if (output) {
      const lines = output.split('\n');
      warnings.push(`${lines.length} uncommitted file(s). Consider committing work before completing task.`);
    }
  } catch (err) {
    // Not in a git repo or git not available — skip check
  }

  return {
    passed: true, // Warnings don't block
    blockers: [],
    warnings,
  };
}

/**
 * Run conformity checks if rungate.json exists.
 * Returns blocker if conformity fails.
 */
export function checkConformity(projectRoot: string): CompletionCheckResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const rungateConfig = join(projectRoot, '.claude', 'rungate.json');
  if (!existsSync(rungateConfig)) {
    // No rungate config — skip conformity check
    return { passed: true, blockers: [], warnings: [] };
  }

  try {
    const result = spawnSync('bun', ['test', 'test/scaffold-conformity.test.ts'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 60000, // 1 minute timeout
    });

    const output = result.stdout || result.stderr || '';
    const failMatch = output.match(/(\d+) fail/);

    if (failMatch) {
      const failCount = parseInt(failMatch[1], 10);
      if (failCount > 0) {
        blockers.push(`Conformity check has ${failCount} failing check(s). Fix conformity issues before completing task.`);
      }
    }

    if (result.status !== 0 && blockers.length === 0) {
      warnings.push('Conformity check exited with non-zero status, but no explicit failures found.');
    }
  } catch (err) {
    warnings.push(`Could not run conformity checks: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  };
}

/**
 * Run all completion checks and aggregate results.
 */
export function runAllCompletionChecks(projectRoot: string): CompletionCheckResult {
  const testResult = checkTests(projectRoot);
  const gitResult = checkUncommittedChanges(projectRoot);
  const conformityResult = checkConformity(projectRoot);

  const allBlockers = [
    ...testResult.blockers,
    ...gitResult.blockers,
    ...conformityResult.blockers,
  ];

  const allWarnings = [
    ...testResult.warnings,
    ...gitResult.warnings,
    ...conformityResult.warnings,
  ];

  return {
    passed: allBlockers.length === 0,
    blockers: allBlockers,
    warnings: allWarnings,
  };
}
