/**
 * Agent brief validation logic — extracted from AgentBriefGuard.hook.ts
 *
 * Deep module: contains agent definitions, ship-active detection,
 * sizing lookup, brief policy validation, and the full validation pipeline.
 * The hook file is a thin trigger that delegates here.
 *
 * Issue: #544
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

// --- Interfaces ---

export interface AgentDef {
  names: string[];
  subagentTypes: string[];
  markers: string[];
  label: string;
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

export type ValidationAction = 'pass' | 'block' | 'exit';

export interface ValidationResult {
  action: ValidationAction;
  blockReason?: string;
  outputs: string[];
  signalEvents: Record<string, unknown>[];
  agent?: AgentDef;
  sizing?: string | null;
  recommendedMaxTurns?: number;
}

// --- Constants ---

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

const SIZE_MAX_TURNS: Record<string, number> = { XS: 20, S: 30, M: 50, L: 75 };
const DEFAULT_MAX_TURNS = 30;
const SHIP_MARKER_TTL_MS = 4 * 60 * 60 * 1000;

// --- Helper Functions ---

function detectAgentDef(input: BriefValidationInput): AgentDef | null {
  const toolInput = input.tool_input || {};
  const subagentType = (toolInput.subagent_type || '').trim();
  const agentName = (toolInput.name || '').toLowerCase();

  for (const agent of NAMED_AGENTS) {
    if (subagentType && agent.subagentTypes.includes(subagentType)) return agent;
    if (agentName) {
      for (const name of agent.names) {
        if (agentName.includes(name.toLowerCase())) return agent;
      }
    }
  }
  return null;
}

function checkShipActive(workDir: string): ShipMarker | null {
  if (!existsSync(workDir)) return null;
  const markers: ShipMarker[] = [];

  try {
    const entries = readdirSync(workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = join(workDir, entry.name, '.ship-active');
      if (existsSync(markerPath)) {
        try {
          const raw = readFileSync(markerPath, 'utf-8').trim();
          if (!raw.startsWith('{')) continue;
          const parsed = JSON.parse(raw) as ShipMarker;
          if (parsed.issue && parsed.ts) markers.push(parsed);
        } catch {}
      }
      // Nested scan for 2-level slugs
      try {
        const subs = readdirSync(join(workDir, entry.name), { withFileTypes: true });
        for (const sub of subs) {
          if (!sub.isDirectory()) continue;
          const nested = join(workDir, entry.name, sub.name, '.ship-active');
          if (!existsSync(nested)) continue;
          try {
            const raw = readFileSync(nested, 'utf-8').trim();
            if (!raw.startsWith('{')) continue;
            const parsed = JSON.parse(raw) as ShipMarker;
            if (parsed.issue && parsed.ts) markers.push(parsed);
          } catch {}
        }
      } catch {}
    }
  } catch { return null; }

  if (markers.length === 0) return null;
  markers.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return markers[0];
}

function checkWorkflowState(workDir: string): ShipMarker | null {
  if (!existsSync(workDir)) return null;
  const BUILD_PHASES = ['BUILD', 'VERIFY', 'SHIP', 'DONE'];
  try {
    const entries = readdirSync(workDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wfPath = join(workDir, entry.name, 'workflow-state.json');
      if (!existsSync(wfPath)) continue;
      try {
        const raw = readFileSync(wfPath, 'utf-8').trim();
        if (!raw.startsWith('{')) continue;
        const wf = JSON.parse(raw);
        if (wf.issue && wf.phase && BUILD_PHASES.includes(wf.phase)) {
          return { issue: wf.issue, ts: new Date().toISOString() };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function findSizingFromCheckpoint(workDir: string): string | null {
  try {
    if (!existsSync(workDir)) return null;
    const entries = readdirSync(workDir)
      .map(name => {
        const full = join(workDir, name);
        try {
          const stat = statSync(full);
          return { name, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
        } catch { return null; }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null && e.isDir)
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of entries.slice(0, 5)) {
      const cp = join(workDir, entry.name, 'CHECKPOINT.md');
      if (!existsSync(cp)) continue;
      try {
        const content = readFileSync(cp, 'utf-8');
        const match = content.match(/\*\*Size:\*\*\s*(XS|S|M|L)\b/i)
          || content.match(/##\s*Sizing[\s\S]*?\b(XS|S|M|L)\b/i);
        if (match) return match[1].toUpperCase();
      } catch { continue; }
    }
    return null;
  } catch { return null; }
}

function validateBriefPolicies(baseDir: string, agent: AgentDef, prompt: string): string[] {
  const policyPath = join(baseDir, 'skills', 'ship', 'brief-policies.json');
  if (!existsSync(policyPath)) return [];
  try {
    const raw = readFileSync(policyPath, 'utf-8').trim();
    if (!raw.startsWith('{')) return [];
    const policies = JSON.parse(raw);
    const policy = policies.policies?.[agent.label.toLowerCase()];
    if (!policy?.requiredPatterns) return [];
    const missing: string[] = [];
    for (const req of policy.requiredPatterns) {
      if (!new RegExp(req.pattern, 'i').test(prompt)) missing.push(req.name);
    }
    return missing;
  } catch { return []; }
}

// --- Signal Logging ---

export function logBriefSignal(baseDir: string, event: Record<string, unknown>): void {
  try {
    const signalsDir = join(baseDir, 'MEMORY', 'LEARNING', 'SIGNALS');
    const signalsFile = join(signalsDir, 'signals.jsonl');
    if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
    if (existsSync(signalsFile)) {
      appendFileSync(signalsFile, JSON.stringify(event) + '\n', 'utf-8');
    }
  } catch {}
}

// --- Validation Pipeline ---

export function validateAgentBrief(
  input: BriefValidationInput,
  workDir: string,
  baseDir: string,
): ValidationResult {
  const toolInput = input.tool_input || {};
  const rawPrompt = toolInput.prompt || '';
  const outputs: string[] = [];
  const signalEvents: Record<string, unknown>[] = [];

  // Bypass 1: Council
  if (/\bcouncil\b/i.test(rawPrompt)) return { action: 'exit', outputs, signalEvents };

  // Bypass 2: Research without implementation markers
  if (/\b(research|investigate|audit)\b/i.test(rawPrompt) &&
      !(rawPrompt.includes('## Task') && rawPrompt.includes('## Verify'))) {
    return { action: 'exit', outputs, signalEvents };
  }

  const agent = detectAgentDef(input);
  const earlyShipMarker = checkShipActive(workDir);
  const shipIsActive = earlyShipMarker &&
    (Date.now() - new Date(earlyShipMarker.ts).getTime()) <= SHIP_MARKER_TTL_MS;

  // Bypass 3: No active ship (except Engineer)
  if (!shipIsActive && agent?.label !== 'Marcus') return { action: 'exit', outputs, signalEvents };
  if (!agent) return { action: 'exit', outputs, signalEvents };

  // Check 1: bypassPermissions
  if (toolInput.mode !== 'bypassPermissions') {
    signalEvents.push({
      ts: new Date().toISOString(), type: 'agent_spawn',
      agent: agent.label.toLowerCase(), blocked: true, block_reason: 'missing_bypass_permissions',
    });
    return {
      action: 'block', agent,
      blockReason: `${agent.label} agent must use mode: "bypassPermissions". Current mode: "${toolInput.mode || 'not set'}". Without bypassPermissions, the agent hangs on permission prompts nobody sees. Add mode: "bypassPermissions" to the Agent call.`,
      outputs, signalEvents,
    };
  }

  // Check 2: Template markers
  const isEngineer = agent.label === 'Marcus';
  const missingMarkers = agent.markers.filter(m => !rawPrompt.includes(m));
  if (missingMarkers.length > 0) {
    if (isEngineer) {
      signalEvents.push({
        ts: new Date().toISOString(), type: 'agent_spawn',
        agent: agent.label.toLowerCase(), blocked: true,
        block_reason: 'missing_template_markers', missing_markers: missingMarkers,
      });
      return {
        action: 'block', agent,
        blockReason: `${agent.label} brief doesn't use template from BRIEF-TEMPLATES.md. Missing required markers: ${missingMarkers.join(', ')}. Read BRIEF-TEMPLATES.md (in harness repo) and use the ${agent.label} template.`,
        outputs, signalEvents,
      };
    }
    outputs.push(
      `ADVISORY: ${agent.label} brief is missing recommended template markers from BRIEF-TEMPLATES.md: ${missingMarkers.join(', ')}. Using the template improves agent output quality. Read BRIEF-TEMPLATES.md (in harness repo) for the ${agent.label} template.`
    );
    signalEvents.push({
      ts: new Date().toISOString(), type: 'agent_spawn_advisory',
      agent: agent.label.toLowerCase(), blocked: false,
      advisory_reason: 'missing_template_markers', missing_markers: missingMarkers,
    });
  }

  // Check 3: Ship-active (Engineer only)
  if (isEngineer) {
    const shipMarker = checkShipActive(workDir) || checkWorkflowState(workDir);
    const isStale = shipMarker ? (Date.now() - new Date(shipMarker.ts).getTime()) > SHIP_MARKER_TTL_MS : true;
    if (!shipMarker || isStale) {
      signalEvents.push({
        ts: new Date().toISOString(), type: 'agent_spawn',
        agent: agent.label.toLowerCase(), blocked: true, block_reason: 'no_ship_session',
      });
      return {
        action: 'block', agent,
        blockReason: `Engineer (Marcus) requires an active ship session. No .ship-active marker found in ~/.rungate/. Run Skill('ship') first — ship writes the marker during SCOPE. Direct Engineer spawns bypass SCOPE (templates, ACs, DISCOVERY, sizing) and produce incomplete gate artifacts.`,
        outputs, signalEvents,
      };
    }
  }

  // Check 6: Brief content policies
  const policyMissing = validateBriefPolicies(baseDir, agent, rawPrompt);
  if (policyMissing.length > 0) {
    outputs.push(`BRIEF CONTENT WARN: ${agent.label} brief missing: ${policyMissing.join(', ')}. See BRIEF-TEMPLATES/${agent.label.toLowerCase()}.md for required content.`);
    signalEvents.push({
      ts: new Date().toISOString(), type: 'agent_spawn_content_warn',
      agent: agent.label.toLowerCase(), missing_content: policyMissing, blocked: false,
    });
  }

  // Check 4: max_turns advisory
  const sizing = findSizingFromCheckpoint(workDir);
  const recommendedMaxTurns = sizing ? SIZE_MAX_TURNS[sizing] || DEFAULT_MAX_TURNS : DEFAULT_MAX_TURNS;
  if (!toolInput.max_turns) {
    outputs.push(`NOTE: No max_turns set for ${agent.label}. Recommended: ${recommendedMaxTurns} (sizing: ${sizing || 'unknown'}).`);
  }

  // Check 5: Single-attempt constraint
  outputs.push(
    `SCOPE CONSTRAINT: Try to resolve errors within a few attempts. If you encounter a persistent error you cannot fix:`,
    `1. STOP — do not attempt 10+ different approaches`,
    `2. Report back: what you tried, the exact error, your hypothesis`,
    `3. Do NOT work around errors silently — surface them`,
  );

  signalEvents.push({
    ts: new Date().toISOString(), type: 'agent_spawn',
    agent: agent.label.toLowerCase(), has_template: true, has_bypass: true,
    max_turns: toolInput.max_turns || null, recommended_max_turns: recommendedMaxTurns,
    sizing: sizing || 'unknown', blocked: false,
  });

  return { action: 'pass', agent, outputs, signalEvents, sizing, recommendedMaxTurns };
}
