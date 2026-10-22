#!/usr/bin/env bun
import { parseHookInput } from './lib/parseStdin';
/**
 * SkillGuard.hook.ts - Block False-Positive Skill Invocations (PreToolUse)
 *
 * Governing SCs: SC-370 (traceability), SC-371 (thin trigger, under 150 lines)
 *
 * PURPOSE:
 * Prevents the well-documented bug where the model falsely invokes
 * keybindings-help (or other position-biased built-in skills) when the
 * user's request has nothing to do with keybindings.
 *
 * ROOT CAUSE:
 * keybindings-help appears FIRST in every skills list injection, combined
 * with the Skill tool's aggressive "BLOCKING REQUIREMENT" language. On
 * ambiguous/short prompts, the model anchors on this first skill.
 *
 * TRIGGER: PreToolUse (matcher: Skill)
 *
 * INPUT:
 * - stdin: Hook input JSON with tool_input containing Skill parameters
 *   - tool_input.skill: string (skill name being invoked)
 *
 * OUTPUT:
 * - If blocked skill detected: "block" decision to prevent invocation
 * - If legitimate skill: silent pass (exit 0)
 *
 * PORTABILITY (#713): this is a Claude Code platform defect that affects
 * every consumer equally. `BLOCKED_SKILLS` is the whole configuration and
 * the only import is `./lib/parseStdin`. No PAI-owned path is read.
 */

// Skills that are known to false-positive due to list position bias.
// These get BLOCKED unless explicitly requested via /keybindings-help
const BLOCKED_SKILLS = ['keybindings-help'];

interface HookInput {
  tool_name: string;
  tool_input: {
    skill?: string;
    args?: string;
  };
}

async function main() {
  try {
    const data = await parseHookInput<HookInput>();
    if (!data) process.exit(0);
    const skillName = (data.tool_input?.skill || '').toLowerCase().trim();

    // Check if this is a blocked skill
    if (BLOCKED_SKILLS.includes(skillName)) {
      const decision = {
        decision: 'block',
        reason: `BLOCKED: "${skillName}" is a known false-positive skill triggered by position bias. The user did NOT ask about keybindings. Continue with the ACTUAL task the user requested. If the user genuinely wants keybinding help, they will explicitly say "keybindings" or use /keybindings-help.`,
      };
      console.log(JSON.stringify(decision));
      process.exit(0);
    }

    // All other skills pass through
    process.exit(0);
  } catch {
    // On any error, pass silently — don't block skill execution
    process.exit(0);
  }
}

main();
