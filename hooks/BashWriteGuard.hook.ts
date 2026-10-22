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
 * ORDER MATTERS (#1120). The allowlist used to be read FIRST, so
 * `gh --version; echo x > .gate-salt` was allowed: a prefix says nothing
 * about what follows a `;`. Write targets are now extracted BEFORE the
 * allowlist and the allowlist can no longer exempt one.
 *
 * What the allowlist still gates is the two SUBSTRING checks at the bottom,
 * which scan the whole command string rather than a target — and that is the
 * only thing it was ever needed for. The one recorded false positive is a
 * `gh issue close --comment` whose body quotes `chflags` and a hook
 * filename, and it trips the chmod/chflags check, not the write-target one.
 * Measured both ways: empty the allowlist and that case goes red.
 *
 * Issue: hornjason/pai-config#473, tuned for a false positive in
 * hornjason/pai-config#474 — a DIFFERENT repository from this one, whose
 * #473/#474 are `lib/scaffold/steps.ts` bugs. Reordered in #1120.
 */

import { parseHookInput } from './lib/parseStdin';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const cmd: string = input.tool_input?.command || '';
  if (!cmd) process.exit(0);

  // Commands that may mention a protected file without touching it. This no
  // longer exempts a write — see ORDER MATTERS above; it exempts only the two
  // substring checks at the bottom of this file.
  //
  // `python3? -c` and `find` were dropped in #1120. Neither is read-only
  // (`-c` is arbitrary code, `find` has `-delete` and `-exec`) and neither
  // was in the set pai-config#474 recorded, which was exactly
  // `gh, grep, cat, ls, bun test`. The other four were added later with no
  // record; they are kept because under the new order they can only reach a
  // protected file through a redirect, which is now checked first.
  const READ_ONLY_PREFIXES = [
    /^\s*gh\s/, // GitHub CLI — the one recorded false positive (pai-config#474)
    /^\s*grep\b/,
    /^\s*cat\b/,
    /^\s*ls\b/,
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*wc\b/,
    /^\s*bun\s+test\b/,
    /^\s*jq\b/,
  ];

  const PROTECTED_FILES = ['workflow-state.json', '.gate-salt', '/witnesses/'];

  const PROTECTED_HOOKS = ['.hook.ts', '.hook.sh'];

  const block = (reason: string): never => {
    console.log(JSON.stringify({ decision: 'block', reason }));
    process.exit(0);
  };

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

  // ── Check write targets. The allowlist has not been read yet and cannot
  // exempt anything here: this is the arm #1120 moved above it.
  for (const target of writeTargets) {
    for (const pf of PROTECTED_FILES) {
      if (target.includes(pf)) {
        block(`Bash write to protected file "${pf}" blocked. Use gate-runner.ts for gate results.`);
      }
    }
    for (const hf of PROTECTED_HOOKS) {
      if (target.includes(hf)) block('Bash write to hook file blocked. Hook integrity is protected.');
    }
  }

  // ── Opaque writers: a command whose writes are not on the command line.
  // An interpreter `-c`/`-e` body and `find -delete`/`-exec` can write
  // without a shell redirect, so writeTargets is empty for them and the
  // check above sees nothing. Naming a protected artifact inside one is
  // refused rather than parsed — this hook does not read Python.
  //
  // This is the arm that catches the second #1120 bypass, and emptying the
  // allowlist does NOT catch it: measured, the `python3 -c` probe is allowed
  // either way. The two defects are independent.
  const OPAQUE =
    /(?:^|[;&|]|\$\()\s*(?:python3?|perl|ruby|node|bun|osascript|sh|bash|zsh)\s+-(?:c|e)\b|\bfind\b[^;&|]*\s-(?:delete|exec)\b/;
  if (OPAQUE.test(cmd)) {
    for (const pf of [...PROTECTED_FILES, ...PROTECTED_HOOKS]) {
      if (cmd.includes(pf)) {
        block(
          `Bash command runs an interpreter or \`find -delete/-exec\` naming "${pf}". ` +
            `What it writes cannot be read off the command line, so it is refused. ` +
            `Use gate-runner.ts for gate results.`,
        );
      }
    }
  }

  // ── Substring checks. These scan the WHOLE command, so they are the ones
  // that fire on a filename merely quoted in a `gh` comment body — the one
  // recorded false positive (pai-config#474). The allowlist is read here,
  // and only here.
  if (READ_ONLY_PREFIXES.some(p => p.test(cmd))) process.exit(0);

  if (/\b(?:chmod|chflags)\b/.test(cmd)) {
    for (const hf of PROTECTED_HOOKS) {
      if (cmd.includes(hf)) block('Permission change on hook file blocked. Hook integrity is protected.');
    }
  }

  if (cmd.includes('pai-gate-salt') && cmd.includes('security')) {
    block('Access to gate salt Keychain entry blocked.');
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
