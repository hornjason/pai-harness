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

import { tryLoadRungateConfig } from './config-loader';

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
 * Run conformity checks if the project is scaffolded.
 * Returns blocker if conformity fails.
 */
export function checkConformity(projectRoot: string): CompletionCheckResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Either layout counts as scaffolded. The old existence check named the
  // monolith only, so every consumer that followed the documented migration
  // to `.claude/rungate/` stopped having its conformity suite run here —
  // silently, reporting passed.
  //
  // The throw is CAUGHT and converted to a blocker, which is the one place in
  // this migration that is not simply "let the loader throw". This function is
  // reached from `hooks/TaskCompleted.hook.ts`, which has no catch of its own,
  // and a hook that exits 1 is neither allow (0) nor block (2) — so an
  // escaping throw would disable the entire completion gate, not just this
  // check, on one unparseable byte. Blocking keeps ADR-001 D2's distinction
  // (a corrupt config is never a missing config) and keeps the gate closed.
  let configured: boolean;
  try {
    configured = tryLoadRungateConfig(projectRoot) !== null;
  } catch (err: unknown) {
    // The CLASS, not the message. `JSON.parse` quotes a token from the file it
    // failed on — "Unexpected identifier \"ghp_…\"" — and a config can hold
    // credentials, so the parser's text is a channel out of the file and into
    // this blocker, which is printed to stderr and captured in transcripts.
    // The reproduction command is the replacement for the detail: it gives the
    // operator the full message on their own terminal, where the config
    // already is.
    const kind = err instanceof Error && err.name ? err.name : "error";
    return {
      passed: false,
      blockers: [
        `rungate config under ${join(projectRoot, '.claude')} could not be read (${kind}), ` +
          `so conformity did not run — a config that exists and cannot be parsed is not an ` +
          `unconfigured project. Run \`bun -e 'import("${projectRoot}/node_modules/rungate/lib/config-loader.ts")` +
          `.then(m => m.loadRungateConfig("${projectRoot}"))'\` to see the parser's own message.`,
      ],
      warnings: [],
    };
  }
  if (!configured) {
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
