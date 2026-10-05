#!/usr/bin/env bun
/**
 * BashToolGuard.hook.ts -- PreToolUse on Bash
 * SC-457, SC-370
 *
 * Tier 3 mechanical enforcement for COMP-7.
 * Blocks cat/head/tail used for file reading via Bash.
 * Agents must use the Read tool instead.
 *
 * ROOT CAUSE (#45 — worktree bypass):
 * This hook was originally registered only in the project-level
 * .claude/settings.json. Claude Code worktree subagents do NOT inherit
 * project-level hooks — they only receive user-level hooks from
 * ~/.claude/settings.json. Additionally, permissions.deny glob patterns
 * (e.g. "Bash(cat *)") only match commands that START with cat/head/tail;
 * piped usage like "grep foo | head" bypasses the deny rule entirely.
 *
 * Fix: (1) register this hook in user-level ~/.claude/settings.json so
 * worktree agents execute it, (2) add piped pattern detection below,
 * (3) keep permissions.deny in project settings as defense-in-depth.
 */

import { parseHookInput } from './lib/utils';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = (input.tool_input?.command as string) || '';

  // Direct invocation: cat file.txt, head -20 file.txt, tail file.txt
  if (/^\s*(cat|head|tail)\s+/.test(cmd)) {
    block();
    return;
  }

  // Semicolon-chained: cd /tmp; cat file.txt
  if (/;\s*(cat|head|tail)\s+/.test(cmd)) {
    block();
    return;
  }

  // Double-ampersand chained: cd /tmp && cat file.txt
  if (/&&\s*(cat|head|tail)\s+/.test(cmd)) {
    block();
    return;
  }

  // Piped: grep foo | head, sort data | tail -5, find . | cat -n
  // Also handles bare pipe-to-command: grep foo | cat (no trailing args)
  if (/\|\s*(cat|head|tail)(\s|$)/.test(cmd)) {
    block();
    return;
  }
}

function block() {
  console.log(JSON.stringify({
    decision: 'block',
    reason: 'COMP-7: Use the Read tool instead of cat/head/tail via Bash.\nExample: Read({ file_path: "/path/to/file", offset: 0, limit: 50 })',
  }));
}

main();
