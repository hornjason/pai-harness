#!/usr/bin/env bun
/**
 * TaskCompleted.hook.ts — Quality gate before task completion
 *
 * TRIGGER: TaskCompleted
 *
 * Runs quality checks before allowing an agent to mark a task as complete:
 * - Test suite must pass (no new failures)
 * - Warns on uncommitted changes
 * - Runs conformity checks if rungate.json exists
 *
 * Exit code 0 = allow completion
 * Exit code 2 = block completion
 *
 * Issue: #579
 */

import { parseHookInput } from './lib/parseStdin';
import { runAllCompletionChecks } from '../lib/task-completion-checks';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const projectRoot = process.cwd();

  const result = runAllCompletionChecks(projectRoot);

  if (result.warnings.length > 0) {
    console.error('[TaskCompleted] Warnings:');
    for (const warning of result.warnings) {
      console.error(`  - ${warning}`);
    }
  }

  if (!result.passed) {
    console.error('[TaskCompleted] BLOCKED: Task completion blocked by quality gates:');
    for (const blocker of result.blockers) {
      console.error(`  ✗ ${blocker}`);
    }
    process.exit(2); // Block completion
  }

  console.error('[TaskCompleted] Quality checks passed. Allowing task completion.');
  process.exit(0);
}

main();
