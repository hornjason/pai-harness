#!/usr/bin/env bun
/**
 * AgentBriefGuard.hook.ts — PreToolUse on Agent
 * Thin trigger: parse stdin -> validateBrief() -> emit hook output.
 * All validation logic lives in lib/brief-validator.ts.
 */
import { parseHookInput } from './lib/parseStdin';
import { validateBrief, logSignal } from './lib/brief-validator';

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);
  try {
    const result = validateBrief(input);
    if (result.bypass) {
      console.error(`[AgentBriefGuard] Bypass — ${result.bypass}`);
      process.exit(0);
    }
    if (result.action === 'block') {
      console.log(JSON.stringify({ decision: 'block', reason: result.blockReason }));
      const label = result.agent?.label.toLowerCase() || 'unknown';
      logSignal({ ts: new Date().toISOString(), type: 'agent_spawn', agent: label, blocked: true, block_reason: result.blockCode });
      console.error(`[AgentBriefGuard] BLOCKED ${result.agent?.label} — ${result.blockCode}`);
      process.exit(0);
    }
    const outputs = [...result.warnings, ...result.advisories];
    if (outputs.length > 0) {
      console.log(['<system-reminder>', ...outputs, '</system-reminder>'].join('\n'));
    }
    if (result.agent) {
      logSignal({ ts: new Date().toISOString(), type: 'agent_spawn', agent: result.agent.label.toLowerCase(), blocked: false, sizing: result.sizing || 'unknown' });
      console.error(`[AgentBriefGuard] ${result.agent.label} spawn validated — sizing: ${result.sizing || 'unknown'}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`[AgentBriefGuard] Error: ${err}`);
    process.exit(0);
  }
}

main();
