#!/usr/bin/env bun
/**
 * AgentBriefGuard.hook.ts — PreToolUse on Agent
 *
 * TRIGGER: PreToolUse (matcher: Agent)
 *
 * PURPOSE:
 * Validate that every named agent spawn uses the brief template from
 * BRIEF-TEMPLATES.md, has bypassPermissions mode, and gets sizing-aware
 * max_turns. Also inject single-attempt constraint.
 *
 * BYPASS (evaluated before name detection — exit 0 if any match):
 *  B1. Council: prompt contains "council" (case-insensitive) → skip all validation
 *  B2. Research: prompt contains "research|investigate|audit" AND lacks
 *      implementation markers (## Task + ## Verify) → skip all validation
 *  B3. No active ship: .ship-active absent or stale (>4h) → skip all validation
 *      EXCEPTION: Engineer (Marcus) never bypasses — falls through to Check 3
 *
 * CHECKS (only reached during active ship with non-bypassed agents):
 *  1. bypassPermissions: BLOCK if mode !== "bypassPermissions"
 *  2. Template markers: BLOCK (Engineer) or WARN (others) if missing required markers
 *  3. Ship-active marker (Engineer only): BLOCK if no valid .ship-active in ~/.rungate/
 *  4. max_turns: WARN if not set (inject reminder)
 *  5. Single-attempt constraint: inject system-reminder
 *  6. Brief content policies: WARN if prompt missing required content patterns (from brief-policies.json)
 *
 * Named agents (matched via subagent_type or tool_input.name):
 *  - Marcus / Engineer:   ## Context, ## Task, ## Verify, ## Report back
 *  - Quinn / QATester:    ## Context, ## Environment, ## What to test, ## Report back
 *  - Rook / Pentester:    ## Context, ## Files changed this session, ## Report back
 *  - Serena / Architect:  ## Context, ## Decision needed, ## Report back
 *  - Aditi / Designer:    ## Context, ## Task, ## Design direction
 *
 * For non-named agents → exit 0 silently.
 *
 * INPUT:
 *  - stdin: PreToolUse JSON payload { tool_name, tool_input }
 *
 * OUTPUT:
 *  - stdout: JSON block decision OR system-reminder injection
 *  - stderr: status messages
 *  - exit(0): always
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { BASE_DIR, WORK_DIR } from './lib/paths';
import { parseHookInput } from './lib/parseStdin';

const SIGNALS_DIR = join(BASE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS');
const SIGNALS_FILE = join(SIGNALS_DIR, 'signals.jsonl');

// Named agent definitions: name patterns → required template markers
interface AgentDef {
  names: string[];          // case-insensitive patterns to match in tool_input.name
  subagentTypes: string[];  // subagent_type values to match
  markers: string[];        // required template section headers
  label: string;            // display name for logs/messages
}

const NAMED_AGENTS: AgentDef[] = [
  {
    names: ['marcus', 'engineer'],
    subagentTypes: ['Engineer'],
    markers: ['## Context', '## Task', '## Verify', '## Report back'],
    label: 'Marcus',
  },
  {
    names: ['quinn', 'qatester', 'qa tester'],
    subagentTypes: ['QATester'],
    markers: ['## Context', '## Environment', '## What to test', '## Report back'],
    label: 'Quinn',
  },
  {
    names: ['rook', 'pentester'],
    subagentTypes: ['Pentester'],
    markers: ['## Context', '## Files changed this session', '## Report back'],
    label: 'Rook',
  },
  {
    names: ['serena', 'architect'],
    subagentTypes: ['Architect'],
    markers: ['## Context', '## Decision needed', '## Report back'],
    label: 'Serena',
  },
  {
    names: ['aditi', 'designer'],
    subagentTypes: ['Designer'],
    markers: ['## Context', '## Task', '## Design direction'],
    label: 'Aditi',
  },
];

// Sizing → max_turns mapping
const SIZE_MAX_TURNS: Record<string, number> = {
  XS: 20,
  S: 30,
  M: 50,
  L: 75,
};
const DEFAULT_MAX_TURNS = 30;

interface HookInput {
  tool_name?: string;
  tool_input?: {
    prompt?: string;
    description?: string;
    mode?: string;
    model?: string;
    subagent_type?: string;
    max_turns?: number;
    run_in_background?: boolean;
    isolation?: string;
    name?: string;
    [k: string]: unknown;
  };
}


function logSignal(event: Record<string, unknown>): void {
  try {
    if (!existsSync(SIGNALS_DIR)) mkdirSync(SIGNALS_DIR, { recursive: true });
    if (existsSync(SIGNALS_FILE)) {
      appendFileSync(SIGNALS_FILE, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch (err) {
    console.error(`[AgentBriefGuard] Signal log write failed: ${err}`);
  }
}

/**
 * Detect which named agent (if any) is being spawned.
 * Checks subagent_type first, then matches name patterns against tool_input.name only.
 */
function detectAgent(input: HookInput): AgentDef | null {
  const toolInput = input.tool_input || {};
  const subagentType = (toolInput.subagent_type || '').trim();
  const agentName = (toolInput.name || '').toLowerCase();

  for (const agent of NAMED_AGENTS) {
    // Check subagent_type first (most reliable)
    if (subagentType && agent.subagentTypes.includes(subagentType)) {
      return agent;
    }
    // Fall back to name pattern matching in tool_input.name only
    if (agentName) {
      for (const name of agent.names) {
        if (agentName.includes(name.toLowerCase())) {
          return agent;
        }
      }
    }
  }
  return null;
}

/**
 * Find the most recent checkpoint and extract sizing.
 * Looks for **Size:** or ## Sizing in CHECKPOINT.md files.
 */
function findSizingFromCheckpoint(): string | null {
  try {
    if (!existsSync(WORK_DIR)) return null;

    // Get subdirectories sorted by mtime (most recent first)
    const entries = readdirSync(WORK_DIR)
      .map(name => {
        const full = join(WORK_DIR, name);
        try {
          const stat = statSync(full);
          return { name, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
        } catch (err) {
          console.error(`[brief-guard] statSync failed for ${full}: ${err}`);
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && e.isDir)
      .sort((a, b) => b.mtime - a.mtime);

    // Check up to 5 most recent directories for a checkpoint with sizing
    for (const entry of entries.slice(0, 5)) {
      const checkpointPath = join(WORK_DIR, entry.name, 'CHECKPOINT.md');
      if (!existsSync(checkpointPath)) continue;

      try {
        const content = readFileSync(checkpointPath, 'utf-8');
        // Match **Size:** XS/S/M/L or ## Sizing ... XS/S/M/L
        const sizeMatch = content.match(/\*\*Size:\*\*\s*(XS|S|M|L)\b/i)
          || content.match(/##\s*Sizing[\s\S]*?\b(XS|S|M|L)\b/i);
        if (sizeMatch) {
          return sizeMatch[1].toUpperCase();
        }
      } catch (err) {
        console.error(`[brief-guard] checkpoint read failed for ${checkpointPath}: ${err}`);
        continue;
      }
    }
    return null;
  } catch (err) {
    console.error(`[brief-guard] findSizingFromCheckpoint failed: ${err}`);
    return null;
  }
}

// Ship-active marker TTL: 4 hours in milliseconds
const SHIP_MARKER_TTL_MS = 4 * 60 * 60 * 1000;

interface ShipMarker {
  issue: number;
  ts: string;
}

/**
 * Scan ~/.rungate/ directories for .ship-active marker files.
 * Returns the most recent valid marker, or null if none found.
 */
function checkShipActive(): ShipMarker | null {
  if (!existsSync(WORK_DIR)) return null;

  const markers: ShipMarker[] = [];

  try {
    const entries = readdirSync(WORK_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = join(WORK_DIR, entry.name, '.ship-active');
      if (!existsSync(markerPath)) continue;

      try {
        const raw = readFileSync(markerPath, 'utf-8').trim();
        if (!raw.startsWith('{')) {
          console.error(`[brief-guard] marker not JSON object at ${markerPath}: starts with "${raw.slice(0, 20)}"`);
          continue;
        }
        const parsed = JSON.parse(raw) as ShipMarker;
        if (parsed.issue && parsed.ts) {
          markers.push(parsed);
        }
      } catch (err) {
        console.error(`[brief-guard] malformed marker at ${markerPath}: ${err}`);
      }
    }

    // Nested scan for 2-level slugs (e.g., pai/352/)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const subEntries = readdirSync(join(WORK_DIR, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const nestedMarkerPath = join(WORK_DIR, entry.name, sub.name, '.ship-active');
          if (!existsSync(nestedMarkerPath)) continue;
          try {
            const raw = readFileSync(nestedMarkerPath, 'utf-8').trim();
            if (!raw.startsWith('{')) {
              console.error(`[brief-guard] nested marker not JSON object at ${nestedMarkerPath}: starts with "${raw.slice(0, 20)}"`);
              continue;
            }
            const parsed = JSON.parse(raw) as ShipMarker;
            if (parsed.issue && parsed.ts) markers.push(parsed);
          } catch (err) {
            console.error(`[brief-guard] malformed nested marker at ${nestedMarkerPath}: ${err}`);
          }
        }
      } catch (err) {
        console.error(`[brief-guard] nested scan failed for ${join(WORK_DIR, entry.name)}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[brief-guard] checkShipActive scan failed: ${err}`);
    return null;
  }

  if (markers.length === 0) return null;

  // Return most recent by ts field
  markers.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return markers[0];
}

function checkWorkflowState(): ShipMarker | null {
  if (!existsSync(WORK_DIR)) return null;
  const BUILD_PHASES = ['BUILD', 'VERIFY', 'SHIP', 'DONE'];
  try {
    const entries = readdirSync(WORK_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wfPath = join(WORK_DIR, entry.name, 'workflow-state.json');
      if (!existsSync(wfPath)) continue;
      try {
        const raw = readFileSync(wfPath, 'utf-8').trim();
        if (!raw.startsWith('{')) continue;
        const wf = JSON.parse(raw);
        if (wf.issue && wf.phase && BUILD_PHASES.includes(wf.phase)) {
          return { issue: wf.issue, ts: new Date().toISOString() };
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* skip scan errors */ }
  return null;
}


/**
 * Validate brief content against policies from brief-policies.json.
 * Returns list of missing content field names. Empty = all present.
 */
function validateBriefPolicies(agent: AgentDef, prompt: string): string[] {
  const policyPath = join(BASE_DIR, 'skills', 'ship', 'brief-policies.json');
  if (!existsSync(policyPath)) return [];

  try {
    const raw = readFileSync(policyPath, 'utf-8').trim();
    if (!raw.startsWith('{')) {
      console.error(`[brief-guard] brief-policies.json not JSON object: starts with "${raw.slice(0, 20)}"`);
      return [];
    }
    const policies = JSON.parse(raw);
    const agentKey = agent.label.toLowerCase();
    const policy = policies.policies?.[agentKey];
    if (!policy?.requiredPatterns) return [];

    const missing: string[] = [];
    for (const req of policy.requiredPatterns) {
      const regex = new RegExp(req.pattern, 'i');
      if (!regex.test(prompt)) {
        missing.push(req.name);
      }
    }
    return missing;
  } catch (err) {
    console.error(`[brief-guard] validateBriefPolicies failed: ${err}`);
    return [];
  }
}

async function main() {
  const input = await parseHookInput();
    if (!input) process.exit(0);

  try {
    // Only process Agent tool calls
    if (input.tool_name !== 'Agent') {
      process.exit(0);
    }

    const toolInput = input.tool_input || {};

    // === Early bypass checks (before name detection) ===
    // These prevent council, research, and non-ship agents from being
    // blocked by the specialist name detection that follows.
    // Order: council → research → ship-active → then name detection.
    const rawPrompt = toolInput.prompt || '';

    // Bypass 1: Council agents — never need brief templates
    if (/\bcouncil\b/i.test(rawPrompt)) {
      console.error('[AgentBriefGuard] Bypass — council agent detected');
      process.exit(0);
    }

    // Bypass 2: Research/investigate/audit agents without implementation markers
    // If prompt has implementation brief markers (## Task + ## Verify), it's an
    // implementation agent that happens to mention research — don't bypass.
    const isResearchAgent = /\b(research|investigate|audit)\b/i.test(rawPrompt);
    const hasImplementationMarkers = rawPrompt.includes('## Task') && rawPrompt.includes('## Verify');
    if (isResearchAgent && !hasImplementationMarkers) {
      console.error('[AgentBriefGuard] Bypass — research/investigate/audit agent (no implementation markers)');
      process.exit(0);
    }

    // === Name detection (moved before Bypass 3 so Engineer check works) ===
    const agent = detectAgent(input);

    // Bypass 3: No active ship session → no brief validation needed
    // Brief templates are only enforced during active ship workflows.
    // EXCEPTION: Engineer (Marcus) agents NEVER bypass — they must always
    // reach Check 3 which blocks direct spawns without an active ship session.
    const earlyShipMarker = checkShipActive();
    const shipIsActive = earlyShipMarker
      && (Date.now() - new Date(earlyShipMarker.ts).getTime()) <= SHIP_MARKER_TTL_MS;
    if (!shipIsActive && agent?.label !== 'Marcus') {
      console.error('[AgentBriefGuard] Bypass — no active ship session');
      process.exit(0);
    }

    // Non-named agent → exit silently
    if (!agent) {
      process.exit(0);
    }

    const prompt = rawPrompt;
    const outputs: string[] = [];

    // Check 1: bypassPermissions
    const hasBypass = toolInput.mode === 'bypassPermissions';
    if (!hasBypass) {
      const decision = {
        decision: 'block',
        reason: `${agent.label} agent must use mode: "bypassPermissions". Current mode: "${toolInput.mode || 'not set'}". Without bypassPermissions, the agent hangs on permission prompts nobody sees. Add mode: "bypassPermissions" to the Agent call.`,
      };
      console.log(JSON.stringify(decision));

      logSignal({
        ts: new Date().toISOString(),
        type: 'agent_spawn',
        agent: agent.label.toLowerCase(),
        has_template: false,
        has_bypass: false,
        blocked: true,
        block_reason: 'missing_bypass_permissions',
      });

      console.error(`[AgentBriefGuard] BLOCKED ${agent.label} — missing bypassPermissions`);
      process.exit(0);
    }

    // Check 2: Template markers
    const isEngineer = agent.label === 'Marcus';
    const missingMarkers = agent.markers.filter(
      marker => !prompt.includes(marker)
    );
    if (missingMarkers.length > 0) {
      if (isEngineer) {
        // Engineer: hard BLOCK — template is mandatory
        const decision = {
          decision: 'block',
          reason: `${agent.label} brief doesn't use template from BRIEF-TEMPLATES.md. Missing required markers: ${missingMarkers.join(', ')}. Read BRIEF-TEMPLATES.md (in harness repo) and use the ${agent.label} template.`,
        };
        console.log(JSON.stringify(decision));

        logSignal({
          ts: new Date().toISOString(),
          type: 'agent_spawn',
          agent: agent.label.toLowerCase(),
          has_template: false,
          has_bypass: true,
          blocked: true,
          block_reason: 'missing_template_markers',
          missing_markers: missingMarkers,
        });

        console.error(
          `[AgentBriefGuard] BLOCKED ${agent.label} — missing template markers: ${missingMarkers.join(', ')}`
        );
        process.exit(0);
      } else {
        // Non-Engineer: advisory WARN — template recommended, not required
        console.error(
          `[AgentBriefGuard] WARN ${agent.label} — missing template markers (advisory): ${missingMarkers.join(', ')}`
        );
        const advisory = [
          '<system-reminder>',
          `ADVISORY: ${agent.label} brief is missing recommended template markers from BRIEF-TEMPLATES.md: ${missingMarkers.join(', ')}. Using the template improves agent output quality. Read BRIEF-TEMPLATES.md (in harness repo) for the ${agent.label} template.`,
          '</system-reminder>',
        ].join('\n');
        console.log(advisory);

        logSignal({
          ts: new Date().toISOString(),
          type: 'agent_spawn_advisory',
          agent: agent.label.toLowerCase(),
          has_template: false,
          has_bypass: true,
          blocked: false,
          advisory_reason: 'missing_template_markers',
          missing_markers: missingMarkers,
        });
      }
    }

    // Check 3: Ship-active marker (Engineer only)
    // Marcus must be spawned through ship — direct spawns bypass SCOPE.
    if (isEngineer) {
      const shipMarker = checkShipActive() || checkWorkflowState();
      const isStale = shipMarker
        ? (Date.now() - new Date(shipMarker.ts).getTime()) > SHIP_MARKER_TTL_MS
        : true;

      if (!shipMarker || isStale) {
        const decision = {
          decision: 'block',
          reason: `Engineer (Marcus) requires an active ship session. No .ship-active marker found in ~/.rungate/. Run Skill('ship') first — ship writes the marker during SCOPE. Direct Engineer spawns bypass SCOPE (templates, ACs, DISCOVERY, sizing) and produce incomplete gate artifacts.`,
        };
        console.log(JSON.stringify(decision));

        logSignal({
          ts: new Date().toISOString(),
          type: 'agent_spawn',
          agent: agent.label.toLowerCase(),
          has_template: true,
          has_bypass: true,
          blocked: true,
          block_reason: 'no_ship_session',
          stale_marker: shipMarker ? true : false,
        });

        console.error(
          `[AgentBriefGuard] BLOCKED ${agent.label} — no_ship_session${shipMarker ? ' (stale marker)' : ''}`
        );
        process.exit(0);
      }
    }

    // Check 6: Brief content policy validation (WARN only, never blocks)
    const policyMissing = validateBriefPolicies(agent, prompt);
    if (policyMissing.length > 0) {
      console.error(
        `[AgentBriefGuard] BRIEF CONTENT WARN: ${agent.label} brief missing: ${policyMissing.join(', ')}`
      );
      outputs.push(
        `BRIEF CONTENT WARN: ${agent.label} brief missing: ${policyMissing.join(', ')}. See BRIEF-TEMPLATES/${agent.label.toLowerCase()}.md for required content.`
      );

      logSignal({
        ts: new Date().toISOString(),
        type: 'agent_spawn_content_warn',
        agent: agent.label.toLowerCase(),
        missing_content: policyMissing,
        blocked: false,
      });
    }

    // All checks passed — inject advisory and single-attempt constraint

    // Check 4: max_turns advisory
    const sizing = findSizingFromCheckpoint();
    const recommendedMaxTurns = sizing
      ? SIZE_MAX_TURNS[sizing] || DEFAULT_MAX_TURNS
      : DEFAULT_MAX_TURNS;

    if (!toolInput.max_turns) {
      outputs.push(
        `NOTE: No max_turns set for ${agent.label}. ` +
        `Recommended: ${recommendedMaxTurns} (sizing: ${sizing || 'unknown'}).`
      );
    }

    // Check 5: Single-attempt constraint
    outputs.push(
      `SCOPE CONSTRAINT: Try to resolve errors within a few attempts. If you encounter a persistent error you cannot fix:`,
      `1. STOP — do not attempt 10+ different approaches`,
      `2. Report back: what you tried, the exact error, your hypothesis`,
      `3. Do NOT work around errors silently — surface them`
    );

    if (outputs.length > 0) {
      const reminder = [
        '<system-reminder>',
        ...outputs,
        '</system-reminder>',
      ].join('\n');
      console.log(reminder);
    }

    // Log successful spawn
    logSignal({
      ts: new Date().toISOString(),
      type: 'agent_spawn',
      agent: agent.label.toLowerCase(),
      has_template: true,
      has_bypass: true,
      max_turns: toolInput.max_turns || null,
      recommended_max_turns: recommendedMaxTurns,
      sizing: sizing || 'unknown',
      blocked: false,
    });

    console.error(
      `[AgentBriefGuard] ${agent.label} spawn validated — template OK, bypass OK, sizing: ${sizing || 'unknown'}`
    );

    process.exit(0);
  } catch (err) {
    console.error(`[AgentBriefGuard] Error: ${err}`);
    process.exit(0);
  }
}

main();
