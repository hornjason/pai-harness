#!/usr/bin/env bun
import { parseHookInput } from './lib/parseStdin';
/**
 * ActionVerificationGate.hook.ts - Post-Deploy Verification Reminder (PostToolUse/Bash)
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * PURPOSE:
 * After state-changing bash commands (deploy, publish, push) that succeed,
 * injects a verification reminder into the conversation so the agent reads
 * actual system state before reporting done.
 *
 * ROOT CAUSE ADDRESSED:
 * Agents report "done" without re-reading actual state after deploy/push.
 *
 * TRIGGER: PostToolUse (matcher: Bash)
 *
 * INPUT:
 * - stdin: JSON with session_id, tool_name, tool_input.command, tool_response.output
 *
 * OUTPUT:
 * - stdout: JSON message when a state-changing command succeeded
 * - stderr: Status messages
 * - exit(0): Always (non-blocking — never interrupts session)
 *
 * SIDE EFFECTS:
 * - None (read-only pattern matching)
 *
 * PORTABILITY (#713): no file I/O and no PAI-owned path. The only import is
 * `./lib/parseStdin`, which is byte-identical in both trees. Functions the
 * same on a consumer repo that has never heard of PAI.
 */

// State-changing command patterns — case-insensitive match against command string
const STATE_CHANGING_PATTERNS: RegExp[] = [
  /make\s+rebuild/i,
  /make\s+build/i,
  /docker\s+push/i,
  /podman\s+push/i,
  /gh\s+release/i,
  /git\s+push/i,
  /npm\s+publish/i,
  /bun\s+publish/i,
];

function isStateChangingCommand(command: string): boolean {
  return STATE_CHANGING_PATTERNS.some(pattern => pattern.test(command));
}

function commandAppearedToSucceed(output: string): boolean {
  // Only suppress on clear error indicators in the output.
  // Absence of error = likely success (exit code 0 path)
  return !/error/i.test(output);
}

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  const command: string = payload?.tool_input?.command ?? '';

  // `tool_response` is EITHER a string or an object carrying `output`. The
  // `.pai` copy read `.output` unconditionally, which is `undefined` on the
  // string form — so a command whose response came back as a bare string was
  // read as empty, counted as "no error", and always got the reminder. That
  // copy lives outside any tsconfig and never had to typecheck; this one does.
  const response = payload?.tool_response;
  const output: string = typeof response === 'string' ? response : (response?.output ?? '');

  if (!command) {
    process.exit(0);
  }

  if (!isStateChangingCommand(command)) {
    process.exit(0);
  }

  if (!commandAppearedToSucceed(output)) {
    // Command failed — no point reminding to verify a broken deploy
    console.error('[ActionVerificationGate] Command appears to have failed, skipping reminder');
    process.exit(0);
  }

  console.error(`[ActionVerificationGate] State-changing command detected: ${command.slice(0, 60)}`);

  // Output the verification reminder to stdout — Claude Code reads this back into context
  const reminder = {
    message:
      "VERIFY BEFORE REPORTING: A state-changing command just ran. Read actual system state before claiming success — check the deploy is live, the release is visible, the image is pushed. Do NOT say 'done' without evidence.",
  };

  process.stdout.write(JSON.stringify(reminder) + '\n');
  process.exit(0);
}

main();
