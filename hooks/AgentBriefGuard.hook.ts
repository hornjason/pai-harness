#!/usr/bin/env bun
/**
 * AgentBriefGuard — PreToolUse on Agent (SC-367, SC-370)
 * Validates briefs use templates + bypassPermissions. Delegates to lib/agent-brief-validation.ts
 */
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import { logBriefSignal, validateAgentBrief } from '../lib/agent-brief-validation';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  try {
    if (input.tool_name !== 'Agent') process.exit(0);
    const result = validateAgentBrief(input, WORK_DIR, BASE_DIR);
    for (const event of result.signalEvents) {
      logBriefSignal(BASE_DIR, event);
    }
    if (result.action === 'exit') process.exit(0);
    if (result.action === 'block') {
      console.log(JSON.stringify({ decision: 'block', reason: result.blockReason }));
      console.error(`[AgentBriefGuard] BLOCKED ${result.agent?.label || 'agent'}`);
      process.exit(0);
    }
    if (result.outputs.length > 0) {
      console.log(['<system-reminder>', ...result.outputs, '</system-reminder>'].join('\n'));
    }
    console.error(
      `[AgentBriefGuard] ${result.agent?.label} spawn validated — sizing: ${result.sizing || 'unknown'}`
    );
    process.exit(0);
  } catch (err) {
    console.error(`[AgentBriefGuard] Error: ${err}`);
    process.exit(0);
  }
}

main();
