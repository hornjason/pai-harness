#!/usr/bin/env bun
/**
 * BashToolGuard.hook.ts -- PreToolUse on Bash
 * SC-457, SC-370
 *
 * Tier 3 mechanical enforcement for COMP-7.
 * Blocks cat/head/tail used for file reading via Bash.
 * Agents must use the Read tool instead.
 */

import { parseHookInput } from './lib/utils';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = (input.tool_input?.command as string) || '';

  // Match cat/head/tail reading files (not in pipes from other commands)
  // Allows: echo "..." | head, grep ... | tail, etc.
  // Blocks: cat file.txt, head -20 file.txt, tail file.txt
  if (/^\s*(cat|head|tail)\s+/.test(cmd) || /;\s*(cat|head|tail)\s+/.test(cmd) || /&&\s*(cat|head|tail)\s+/.test(cmd)) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: 'COMP-7: Use the Read tool instead of cat/head/tail via Bash.\nExample: Read({ file_path: "/path/to/file", offset: 0, limit: 50 })',
    }));
    return;
  }
}

main();
