#!/usr/bin/env bun
/**
 * HarnessAFKGate.hook.ts - Block AskUserQuestion during AFK harness runs (PreToolUse)
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * PURPOSE:
 * When a harness PRD exists with phase in build/execute/verify (post-approval
 * phases), block AskUserQuestion calls. The agent must make judgment calls
 * autonomously — interrupting the user during AFK harness runs is a protocol
 * violation.
 *
 * TRIGGER: PreToolUse (matcher: AskUserQuestion)
 *
 * BEHAVIOR:
 * - Scans WORK_DIR for the most recently modified PRD.md
 * - If PRD frontmatter has phase: build|execute|verify → BLOCK (exit 2 with reason)
 * - If no PRD, or phase is observe|think|plan|complete|learn → ALLOW (exit 0)
 *
 * This is a mechanical enforcement — impossible to violate.
 * See HARNESS-STANDARD.md "AFK autonomy rule" for the policy.
 *
 * PORTABILITY (#713): the work directory comes from `./lib/paths`'s
 * `WORK_DIR`, which resolves `RUNGATE_WORK_DIR` and otherwise `~/.rungate` —
 * a rungate-owned directory, not a PAI one. The `.pai` copy's docstring said
 * it scanned `MEMORY/WORK/`; that was stale there and is corrected here,
 * because a shipped hook's stated behaviour is what a consumer debugs against.
 * The PRD-driven ship lifecycle is rungate's own.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { WORK_DIR } from './lib/paths';

const BLOCKED_PHASES = new Set(['build', 'execute', 'verify']);

function findLatestPRD(): { path: string; phase: string } | null {
  try {
    const dirs = readdirSync(WORK_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const prdPath = join(WORK_DIR, d.name, 'PRD.md');
        try {
          const stat = statSync(prdPath);
          return { path: prdPath, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b!.mtime - a!.mtime) as { path: string; mtime: number }[];

    if (dirs.length === 0) return null;

    const content = readFileSync(dirs[0].path, 'utf-8');
    const phaseMatch = content.match(/^phase:\s*(.+)$/m);
    if (!phaseMatch) return null;

    return { path: dirs[0].path, phase: phaseMatch[1].trim() };
  } catch {
    return null;
  }
}

function main() {
  const prd = findLatestPRD();

  if (!prd) {
    process.exit(0); // No active harness — allow questions
  }

  if (BLOCKED_PHASES.has(prd.phase)) {
    // BLOCK: harness is in post-approval phase
    const reason = `HARNESS AFK GATE: Active PRD in "${prd.phase}" phase — AskUserQuestion blocked. Make the judgment call yourself. Only circuit breakers and destructive actions may interrupt the user.`;
    console.error(`[HarnessAFKGate] BLOCKED: ${prd.phase} phase active`);
    // Exit 2 = block with reason shown to the AI
    process.stdout.write(JSON.stringify({ error: reason }));
    process.exit(2);
  }

  // Phase is observe/think/plan/complete/learn — allow questions
  process.exit(0);
}

main();
