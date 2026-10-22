#!/usr/bin/env bun
/**
 * BashWriteGuard.hook.ts — PreToolUse on Bash
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * TRIGGER: PreToolUse (matcher: Bash)
 *
 * Blocks Bash write operations targeting protected files:
 *  - workflow-state.json (gate results)
 *  - .gate-salt (HMAC signing key)
 *  - witnesses/ directory files
 *  - Hook files (*.hook.ts, *.hook.sh)
 *
 * Also blocks:
 *  - chmod/chflags on hook files
 *  - security CLI access to the gate-salt Keychain entry
 *
 * PORTABILITY (#713): every protected artifact is a rungate gate artifact and
 * the only import is `./lib/parseStdin`. No PAI-owned path is read.
 *
 * Issue: #473, tuned for false positives in #474
 */

import { parseHookInput } from './lib/parseStdin';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const cmd: string = input.tool_input?.command || '';
  if (!cmd) process.exit(0);

  // Read-only commands that should never be blocked even if they mention protected files
  const READ_ONLY_PREFIXES = [
    /^\s*gh\s/, // GitHub CLI (issue create, close, comment)
    /^\s*grep\b/,
    /^\s*cat\b/,
    /^\s*ls\b/,
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*wc\b/,
    /^\s*find\b/,
    /^\s*bun\s+test\b/,
    /^\s*python3?\s+-c/, // python one-liners (read)
    /^\s*jq\b/,
  ];

  // If the command starts with a read-only prefix, allow it
  if (READ_ONLY_PREFIXES.some(p => p.test(cmd))) {
    process.exit(0);
  }

  const PROTECTED_FILES = ['workflow-state.json', '.gate-salt', '/witnesses/'];

  const PROTECTED_HOOKS = ['.hook.ts', '.hook.sh'];

  // Extract write targets: text after > or >> operators (not stderr redirects like 2>)
  const writeTargets: string[] = [];
  const redirectMatches = cmd.matchAll(/(?<![2&])\s*>{1,2}\s*(\S+)/g);
  for (const m of redirectMatches) {
    if (m[1] && m[1] !== '/dev/null') writeTargets.push(m[1]);
  }
  // Match: tee FILE, cp SRC DEST, mv SRC DEST
  const teeMatch = cmd.match(/\btee\s+(?:-a\s+)?(\S+)/);
  if (teeMatch) writeTargets.push(teeMatch[1]);
  const cpMatch = cmd.match(/\bcp\s+\S+\s+(\S+)/);
  if (cpMatch) writeTargets.push(cpMatch[1]);
  const mvMatch = cmd.match(/\bmv\s+\S+\s+(\S+)/);
  if (mvMatch) writeTargets.push(mvMatch[1]);

  // Check write targets against protected files
  for (const target of writeTargets) {
    for (const pf of PROTECTED_FILES) {
      if (target.includes(pf)) {
        console.log(
          JSON.stringify({
            decision: 'block',
            reason: `Bash write to protected file "${pf}" blocked. Use gate-runner.ts for gate results.`,
          }),
        );
        process.exit(0);
      }
    }
    for (const hf of PROTECTED_HOOKS) {
      if (target.includes(hf)) {
        console.log(
          JSON.stringify({
            decision: 'block',
            reason: `Bash write to hook file blocked. Hook integrity is protected.`,
          }),
        );
        process.exit(0);
      }
    }
  }

  // Block chmod/chflags on hook files
  if (/\b(?:chmod|chflags)\b/.test(cmd)) {
    for (const hf of PROTECTED_HOOKS) {
      if (cmd.includes(hf)) {
        console.log(
          JSON.stringify({
            decision: 'block',
            reason: `Permission change on hook file blocked. Hook integrity is protected.`,
          }),
        );
        process.exit(0);
      }
    }
  }

  // Block security CLI access to gate salt
  if (cmd.includes('pai-gate-salt') && cmd.includes('security')) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason: 'Access to gate salt Keychain entry blocked.',
      }),
    );
    process.exit(0);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
