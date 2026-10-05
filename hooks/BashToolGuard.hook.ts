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
 *
 * SCOPE: User-level registration means this hook fires for EVERY Claude Code
 * session on the machine, including non-harness projects and bundled skills that
 * legitimately pipe through head/tail. COMP-7 is a harness compliance directive
 * (lib/compliance-report.ts) graded against Marcus/Quinn/Rook transcripts — it is
 * only meaningful inside a rungate-harnessed project. isHarnessProject() walks up
 * from cwd looking for .claude/rungate.json (the canonical harness marker used by
 * lib/config-loader.ts and lib/conformity.ts). This keeps enforcement for rungate,
 * its worktree subagents, AND consumer projects (DDB, POV) while going silent
 * everywhere else. Scoping lives here, not in the registration: project-level
 * hooks do not reach worktree subagents, so user-level registration is required.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { parseHookInput } from './lib/utils';
import { detectBashFileRead } from '../lib/bash-file-read';

/** True when cwd sits at or below a project containing .claude/rungate.json. */
function isHarnessProject(startDir: string): boolean {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, '.claude', 'rungate.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  if (!isHarnessProject(process.cwd())) process.exit(0);

  const cmd = (input.tool_input?.command as string) || '';

  // Blocks cat/head/tail reading a FILE in any position — direct,
  // ;-chained, &&-chained, or piped. Pure stdin filters (cmd | head -80)
  // are allowed: they read stdin, not a file, and Read cannot replace them.
  const offending = detectBashFileRead(cmd);
  if (offending) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `COMP-7: Use the Read tool instead of cat/head/tail via Bash.\nOffending segment: ${offending}\nExample: Read({ file_path: "/path/to/file", offset: 0, limit: 50 })`,
    }));
    return;
  }
}

main();
