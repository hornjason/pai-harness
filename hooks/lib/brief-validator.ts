/**
 * Brief Validator — Extracted validation logic from AgentBriefGuard.hook.ts
 *
 * Pure validation functions with no stdin/stdout/process.exit side effects.
 * The hook file calls these functions and translates results to hook output.
 *
 * Issue: #543 (deep-modules extraction)
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
import { BASE_DIR, getWorkDir } from './paths';

// ─── Types ──────────────────────────────────────────────────

export interface AgentDef {
  names: string[];          // case-insensitive patterns to match in tool_input.name
  subagentTypes: string[];  // subagent_type values to match
  markers: string[];        // required template section headers
  label: string;            // display name for logs/messages
}

export interface ShipMarker {
  issue: number;
  ts: string;
}

export interface BriefValidationInput {
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

export interface BriefValidationResult {
  action: 'pass' | 'block';
  bypass?: string;
  agent: AgentDef | null;
  blockReason?: string;
  blockCode?: string;
  warnings: string[];
  advisories: string[];
  sizing?: string | null;
  recommendedMaxTurns?: number;
}

// ─── Constants ──────────────────────────────────────────────

export const NAMED_AGENTS: AgentDef[] = [
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

export const SIZE_MAX_TURNS: Record<string, number> = {
  XS: 20,
  S: 30,
  M: 50,
  L: 75,
};

export const DEFAULT_MAX_TURNS = 30;

export const SHIP_MARKER_TTL_MS = 4 * 60 * 60 * 1000;

// ─── Exported Functions ─────────────────────────────────────

/**
 * Detect which named agent (if any) is being spawned.
 * Checks subagent_type first, then matches name patterns against name.
 */
export function detectNamedAgent(input: { subagent_type?: string; name?: string }): AgentDef | null {
  const subagentType = (input.subagent_type || '').trim();
  const agentName = (input.name || '').toLowerCase();

  for (const agent of NAMED_AGENTS) {
    if (subagentType && agent.subagentTypes.includes(subagentType)) {
      return agent;
    }
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
 * Check bypass conditions on the prompt.
 * Returns bypass reason string if bypassed, null otherwise.
 *
 * Bypass rules:
 *  B1. Council: prompt contains "council" → 'council'
 *  B2. Research: prompt contains "research|investigate|audit" without
 *      implementation markers (## Task + ## Verify) → 'research'
 */
export function checkBypass(prompt: string): string | null {
  if (/\bcouncil\b/i.test(prompt)) {
    return 'council';
  }

  const isResearchAgent = /\b(research|investigate|audit)\b/i.test(prompt);
  const hasImplementationMarkers = prompt.includes('## Task') && prompt.includes('## Verify');
  if (isResearchAgent && !hasImplementationMarkers) {
    return 'research';
  }

  return null;
}

/**
 * Validate template markers against an agent definition.
 * Returns list of missing markers. Empty = all present.
 */
export function validateMarkers(agent: AgentDef, prompt: string): string[] {
  return agent.markers.filter(marker => !prompt.includes(marker));
}

/**
 * Scan a work directory for .ship-active marker files.
 * Returns the most recent valid marker, or null if none found.
 * Supports 1-level and 2-level nested directories.
 */
export function checkShipActive(scanDir: string): ShipMarker | null {
  if (!existsSync(scanDir)) return null;

  const markers: ShipMarker[] = [];

  try {
    const entries = readdirSync(scanDir, { withFileTypes: true });

    // Level 1 scan
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = join(scanDir, entry.name, '.ship-active');
      if (!existsSync(markerPath)) continue;

      try {
        const raw = readFileSync(markerPath, 'utf-8').trim();
        if (!raw.startsWith('{')) continue;
        const parsed = JSON.parse(raw) as ShipMarker;
        if (parsed.issue && parsed.ts) {
          markers.push(parsed);
        }
      } catch {
        // Skip malformed markers
      }
    }

    // Level 2 (nested) scan for 2-level slugs (e.g., pai/352/)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const subEntries = readdirSync(join(scanDir, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const nestedPath = join(scanDir, entry.name, sub.name, '.ship-active');
          if (!existsSync(nestedPath)) continue;
          try {
            const raw = readFileSync(nestedPath, 'utf-8').trim();
            if (!raw.startsWith('{')) continue;
            const parsed = JSON.parse(raw) as ShipMarker;
            if (parsed.issue && parsed.ts) markers.push(parsed);
          } catch {
            // Skip malformed
          }
        }
      } catch {
        // Skip scan errors
      }
    }
  } catch {
    return null;
  }

  if (markers.length === 0) return null;

  markers.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return markers[0];
}

/**
 * Check workflow-state.json files for active build phase.
 * Returns a synthetic ShipMarker if found, null otherwise.
 */
export function checkWorkflowState(scanDir: string): ShipMarker | null {
  if (!existsSync(scanDir)) return null;
  const BUILD_PHASES = ['BUILD', 'VERIFY', 'SHIP', 'DONE'];
  try {
    const entries = readdirSync(scanDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wfPath = join(scanDir, entry.name, 'workflow-state.json');
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
 * Find sizing from the most recent checkpoint.
 * Looks for **Size:** or ## Sizing in CHECKPOINT.md files.
 */
export function findSizingFromCheckpoint(scanDir: string): string | null {
  try {
    if (!existsSync(scanDir)) return null;

    const entries = readdirSync(scanDir)
      .map(name => {
        const full = join(scanDir, name);
        try {
          const stat = statSync(full);
          return { name, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && e.isDir)
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of entries.slice(0, 5)) {
      const checkpointPath = join(scanDir, entry.name, 'CHECKPOINT.md');
      if (!existsSync(checkpointPath)) continue;

      try {
        const content = readFileSync(checkpointPath, 'utf-8');
        const sizeMatch = content.match(/\*\*Size:\*\*\s*(XS|S|M|L)\b/i)
          || content.match(/##\s*Sizing[\s\S]*?\b(XS|S|M|L)\b/i);
        if (sizeMatch) {
          return sizeMatch[1].toUpperCase();
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate brief content against policies from brief-policies.json.
 * Returns list of missing content field names. Empty = all present.
 */
export function validateBriefPolicies(agent: AgentDef, prompt: string, baseDir?: string): string[] {
  const base = baseDir || BASE_DIR;
  const policyPath = join(base, 'skills', 'ship', 'brief-policies.json');
  if (!existsSync(policyPath)) return [];

  try {
    const raw = readFileSync(policyPath, 'utf-8').trim();
    if (!raw.startsWith('{')) return [];
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
  } catch {
    return [];
  }
}

/**
 * Log a signal event to the signals file.
 */
export function logSignal(event: Record<string, unknown>, baseDir?: string): void {
  const base = baseDir || BASE_DIR;
  const signalsDir = join(base, 'MEMORY', 'LEARNING', 'SIGNALS');
  const signalsFile = join(signalsDir, 'signals.jsonl');
  try {
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    if (existsSync(signalsFile)) {
      appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch {
    // Silently ignore signal write failures
  }
}

/**
 * Main validation orchestrator.
 * Runs all checks and returns a structured result instead of side effects.
 */
export function validateBrief(input: BriefValidationInput): BriefValidationResult {
  const result: BriefValidationResult = {
    action: 'pass',
    agent: null,
    warnings: [],
    advisories: [],
  };

  // Only process Agent tool calls
  if (input.tool_name !== 'Agent') {
    return result;
  }

  const toolInput = input.tool_input || {};
  const prompt = toolInput.prompt || '';

  // Bypass checks
  const bypass = checkBypass(prompt);

  // Detect agent
  const agent = detectNamedAgent({
    subagent_type: toolInput.subagent_type,
    name: toolInput.name,
  });

  // Bypass 3: No active ship → skip (except Engineer)
  const workDir = getWorkDir();
  const shipMarker = checkShipActive(workDir);
  const shipIsActive = shipMarker
    && (Date.now() - new Date(shipMarker.ts).getTime()) <= SHIP_MARKER_TTL_MS;

  if (bypass) {
    result.bypass = bypass;
    return result;
  }

  if (!shipIsActive && agent?.label !== 'Marcus') {
    result.bypass = 'no_ship';
    return result;
  }

  // Non-named agent → pass silently
  if (!agent) {
    return result;
  }

  result.agent = agent;
  const isEngineer = agent.label === 'Marcus';

  // Check 1: bypassPermissions
  if (toolInput.mode !== 'bypassPermissions') {
    result.action = 'block';
    result.blockCode = 'missing_bypass_permissions';
    result.blockReason = `${agent.label} agent must use mode: "bypassPermissions". Current mode: "${toolInput.mode || 'not set'}". Without bypassPermissions, the agent hangs on permission prompts nobody sees.`;
    return result;
  }

  // Check 2: Template markers
  const missingMarkers = validateMarkers(agent, prompt);
  if (missingMarkers.length > 0) {
    if (isEngineer) {
      result.action = 'block';
      result.blockCode = 'missing_template_markers';
      result.blockReason = `${agent.label} brief doesn't use template from BRIEF-TEMPLATES.md. Missing required markers: ${missingMarkers.join(', ')}.`;
      return result;
    } else {
      result.warnings.push(
        `${agent.label} brief is missing recommended template markers: ${missingMarkers.join(', ')}.`
      );
    }
  }

  // Check 3: Ship-active marker (Engineer only)
  if (isEngineer) {
    const engineerMarker = checkShipActive(workDir) || checkWorkflowState(workDir);
    const isStale = engineerMarker
      ? (Date.now() - new Date(engineerMarker.ts).getTime()) > SHIP_MARKER_TTL_MS
      : true;

    if (!engineerMarker || isStale) {
      result.action = 'block';
      result.blockCode = 'no_ship_session';
      result.blockReason = `Engineer (Marcus) requires an active ship session. No .ship-active marker found. Run Skill('ship') first.`;
      return result;
    }
  }

  // Check 6: Brief content policy validation
  const policyMissing = validateBriefPolicies(agent, prompt);
  if (policyMissing.length > 0) {
    result.warnings.push(
      `${agent.label} brief missing content: ${policyMissing.join(', ')}.`
    );
  }

  // Check 4: max_turns advisory
  const sizing = findSizingFromCheckpoint(workDir);
  const recommendedMaxTurns = sizing
    ? SIZE_MAX_TURNS[sizing] || DEFAULT_MAX_TURNS
    : DEFAULT_MAX_TURNS;
  result.sizing = sizing;
  result.recommendedMaxTurns = recommendedMaxTurns;

  if (!toolInput.max_turns) {
    result.advisories.push(
      `No max_turns set for ${agent.label}. Recommended: ${recommendedMaxTurns} (sizing: ${sizing || 'unknown'}).`
    );
  }

  // Check 5: Single-attempt constraint (always injected)
  result.advisories.push(
    'SCOPE CONSTRAINT: Try to resolve errors within a few attempts. If you encounter a persistent error you cannot fix: 1. STOP 2. Report back 3. Do NOT work around errors silently.'
  );

  return result;
}
