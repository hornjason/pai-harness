#!/usr/bin/env bun
/**
 * BashToolGuard.hook.ts -- PreToolUse on Bash
 * SC-457, SC-370
 *
 * Tier 3 mechanical enforcement for COMP-7.
 * Blocks cat/head/tail used for file reading via Bash — including piped usage.
 * Agents must use the Read tool instead.
 *
 * ROOT CAUSE (#45): BashToolGuard hook registered at project level in
 * .claude/settings.json does not fire for worktree subagents because Claude Code
 * only inherits user-level hooks (~/.claude/settings.json) for isolated agents.
 * The project-level .claude/ directory is gitignored and not copied to worktrees.
 * Additionally, permissions.deny glob patterns (e.g. "Bash(cat *)") miss piped
 * cat/head/tail usage like "grep foo | head -20".
 *
 * Fix: This hook is registered in BOTH user-level (~/.claude/settings.json) and
 * project-level (.claude/settings.json) settings. The regex patterns below block
 * direct, semicolon-chained, &&-chained, AND piped cat/head/tail patterns.
 * permissions.deny entries are retained as defense-in-depth for direct invocations.
 */

import { parseHookInput } from './lib/utils';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = (input.tool_input?.command as string) || '';

  // Block cat/head/tail in ALL positions:
  // 1. Direct: cat file.txt, head -20 file.txt, tail file.txt
  // 2. Semicolon-chained: cd /tmp; cat file.txt
  // 3. &&-chained: cd /tmp && cat file.txt
  // 4. Piped: grep foo | cat, grep foo | head -20, cmd | grep x | tail -5
  if (
    /^\s*(cat|head|tail)\s+/.test(cmd) ||
    /;\s*(cat|head|tail)\s+/.test(cmd) ||
    /&&\s*(cat|head|tail)\s+/.test(cmd) ||
    /\|\s*(cat|head|tail)(\s|$)/.test(cmd)
  ) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: 'COMP-7: Use the Read tool instead of cat/head/tail via Bash.\nExample: Read({ file_path: "/path/to/file", offset: 0, limit: 50 })',
    }));
    return;
  }
}

main();
