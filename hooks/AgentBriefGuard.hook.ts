#!/usr/bin/env bun
/**
 * AgentBriefGuard.hook.ts — PreToolUse on Agent
 * TRIGGER: PreToolUse (matcher: Agent)
 *
 * Validates agent spawn briefs use templates, bypassPermissions mode,
 * and sizing-aware max_turns. Thin trigger: delegates to lib/agent-brief-validation.ts.
 *
 * Issue: #544 (extracted to deep module)
 */

import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';
import {
  logBriefSignal,
  validateAgentBrief,
} from '../lib/agent-brief-validation';

const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');

async function main() {
  const input = await parseHookInput();
  if (!input) process.exit(0);

  try {
    if (input.tool_name !== 'Agent') process.exit(0);

    const result = validateAgentBrief(input, WORK_DIR, BASE_DIR);

    // Log all signal events
    for (const event of result.signalEvents) {
      logBriefSignal(SIGNALS_DIR, SIGNALS_FILE, event);
    }

    if (result.action === 'exit') process.exit(0);

    if (result.action === 'block') {
      console.log(JSON.stringify({ decision: 'block', reason: result.blockReason }));
      console.error(`[AgentBriefGuard] BLOCKED ${result.agent?.label || 'agent'}`);
      process.exit(0);
    }

    // Pass — emit advisory outputs as system-reminder
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
