#!/usr/bin/env bun
/**
 * TestSuiteGuard.hook.ts -- PreToolUse on Bash
 * Tier 3 mechanical enforcement for DIR-L29.
 *
 * Blocks `bun test` (full suite) after 2 invocations per session.
 * Agents must use targeted tests: `bun test test/specific-file.test.ts`
 */

import { parseHookInput } from './lib/utils';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const COUNTER_DIR = process.env.TMPDIR || '/tmp';
const MAX_FULL_RUNS = 2;

function getCounterPath(sessionId: string): string {
  return join(COUNTER_DIR, `rungate-test-suite-count-${sessionId}`);
}

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = (input.tool_input?.command as string) || '';

  // Detect full suite run: `bun test` without a specific file path
  // Allow: bun test test/foo.test.ts, bun test test/unit/bar.test.ts
  // Block (after limit): bun test, bun test --parallel, bun test 2>&1 | tail
  const isFullSuite = /^\s*bun\s+test(?:\s+(?:--[^\s]+|2>&1|\|))*\s*$/.test(cmd.split('|')[0].trim())
    || /^\s*bun\s+test\s+2>&1/.test(cmd);

  if (!isFullSuite) process.exit(0);

  const sessionId = input.session_id || 'default';
  const counterPath = getCounterPath(sessionId);

  let count = 0;
  if (existsSync(counterPath)) {
    count = parseInt(readFileSync(counterPath, 'utf-8').trim()) || 0;
  }

  count++;
  writeFileSync(counterPath, String(count));

  if (count > MAX_FULL_RUNS) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `DIR-L29: Full test suite limit reached (${count}/${MAX_FULL_RUNS}). Use targeted tests instead:\n  bun test test/specific-file.test.ts\nFull suite runs waste ~4 minutes each. You've already run it ${MAX_FULL_RUNS} times.`,
    }));
    return;
  }
}

main();
