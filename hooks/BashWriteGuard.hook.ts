#!/usr/bin/env bun
/**
 * BashWriteGuard.hook.ts — PreToolUse on Bash
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * TRIGGER: PreToolUse (matcher: Bash)
 *
 * Blocks Bash writes to the gate artifacts — `workflow-state.json`,
 * `.gate-salt`, `witnesses/` — and to hook sources, plus `chmod`/`chflags`
 * on a hook file and `security` access to the gate-salt Keychain entry.
 *
 * Since #1175 a protected NAME under an OS scratch root is a fixture and is
 * allowed; everything else, including a destination this module cannot place
 * in a tree, keeps the refusal. The scratch roots are FIXED — `TMPDIR` can
 * select among them and cannot name a new one, because the writer sets it —
 * and a command that creates a symlink voids the exemption outright. The run
 * store and the directories hook registrations actually resolve to are
 * SUBTRACTED from the exemption wherever they are, including under `/tmp`:
 * a checkout is the live hook exactly when a variable says it is, which
 * `lib/hook-target-tree.ts` measured happening. The scoping is to the scratch tree and not to
 * the project root because a live `workflow-state.json` is not in the project
 * root — see `lib/bash-write-guard.ts` for the measurement.
 *
 * #1240: a heredoc or herestring handed to an INTERPRETER is a program and
 * is decided as one. Before that the body was stripped before every arm and
 * only a `-c`/`-e` body was read back, so `bash <<'EOF'` and `python3 <<'PY'`
 * reached a live gate artifact with the guard deciding on the single word
 * `bash`. A body fed to anything else — `cat > doc.md <<'EOF'`,
 * `gh --body-file - <<'EOF'` — is still a DOCUMENT and still stripped.
 *
 * THE DECISION LIVES IN `lib/bash-write-guard.ts` (#1120), which is where
 * the reasoning and the measurements are. It was extracted for the same
 * reason #1137 extracted `lib/gate-result-protection.ts`: a decision that
 * only exists inside a subprocess cannot be swept over a corpus, and this
 * one was wrong in two directions at once until 5,060 real commands were
 * run through it.
 *
 * PORTABILITY (#713): every protected artifact is a rungate gate artifact,
 * both imports are rungate-owned and in `package.json` `files[]`. No
 * PAI-owned path is read.
 *
 * Issues: hornjason/pai-config#473, tuned there in
 * hornjason/pai-config#474 — a DIFFERENT repository from this one, whose
 * own #473/#474 are `lib/scaffold/steps.ts` bugs. Reworked in #1120.
 */

import { parseHookInput } from './lib/parseStdin';
import { decideBashWrite } from '../lib/bash-write-guard';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  const cmd: string = input.tool_input?.command || '';
  if (!cmd) process.exit(0);

  let decision;
  try {
    decision = decideBashWrite(cmd);
  } catch (e) {
    // A guard that crashes must not thereby allow the thing it guards
    // (#1137). Scoped to a command that already names a protected artifact,
    // so a bug here refuses a narrow class rather than bricking the session.
    const touches = ['workflow-state.json', '.gate-salt', '/witnesses/', '.hook.ts', '.hook.sh'];
    if (!touches.some(t => cmd.includes(t))) process.exit(0);
    decision = {
      blocked: true,
      reason: `Refused: BashWriteGuard could not evaluate this command (${String(e)}).`,
    };
  }

  if (decision.blocked) {
    console.log(JSON.stringify({ decision: 'block', reason: decision.reason }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
