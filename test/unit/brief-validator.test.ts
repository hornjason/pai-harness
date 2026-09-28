/**
 * Unit tests for lib/brief-validator.ts
 *
 * Tests the extracted validation logic independent of hook stdin parsing.
 * Covers: detectAgent, bypass logic, marker validation, policy checks,
 * ship-active detection, sizing, and the main validateBrief orchestrator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Import from the module under test
import {
  detectNamedAgent,
  checkBypass,
  validateMarkers,
  checkShipActive,
  findSizingFromCheckpoint,
  validateBriefPolicies,
  validateBrief,
  NAMED_AGENTS,
  SHIP_MARKER_TTL_MS,
  SIZE_MAX_TURNS,
  DEFAULT_MAX_TURNS,
} from '../../hooks/lib/brief-validator';

import type { AgentDef, ShipMarker, BriefValidationInput, BriefValidationResult } from '../../hooks/lib/brief-validator';

let tempDir: string;
let workDir: string;
let signalsDir: string;

const origPaiDir = process.env.PAI_DIR;
const origWorkDir = process.env.RUNGATE_WORK_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'brief-validator-test-'));
  workDir = join(tempDir, 'work');
  signalsDir = join(tempDir, 'MEMORY', 'LEARNING', 'SIGNALS');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(signalsDir, { recursive: true });
  writeFileSync(join(signalsDir, 'signals.jsonl'), '');
  process.env.PAI_DIR = tempDir;
  process.env.RUNGATE_WORK_DIR = workDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (origPaiDir !== undefined) {
    process.env.PAI_DIR = origPaiDir;
  } else {
    delete process.env.PAI_DIR;
  }
  if (origWorkDir !== undefined) {
    process.env.RUNGATE_WORK_DIR = origWorkDir;
  } else {
    delete process.env.RUNGATE_WORK_DIR;
  }
});

// ─── detectNamedAgent ───────────────────────────────────────

describe('detectNamedAgent', () => {
  it('detects Engineer by subagent_type', () => {
    const result = detectNamedAgent({ subagent_type: 'Engineer', name: '' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Marcus');
  });

  it('detects Quinn by name pattern', () => {
    const result = detectNamedAgent({ subagent_type: '', name: 'quinn-tester' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Quinn');
  });

  it('detects Rook by subagent_type', () => {
    const result = detectNamedAgent({ subagent_type: 'Pentester', name: '' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Rook');
  });

  it('detects Serena by name pattern', () => {
    const result = detectNamedAgent({ subagent_type: '', name: 'serena-review' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Serena');
  });

  it('detects Aditi by subagent_type', () => {
    const result = detectNamedAgent({ subagent_type: 'Designer', name: '' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Aditi');
  });

  it('returns null for unknown agent', () => {
    const result = detectNamedAgent({ subagent_type: 'Unknown', name: 'random-agent' });
    expect(result).toBeNull();
  });

  it('prefers subagent_type over name', () => {
    const result = detectNamedAgent({ subagent_type: 'Engineer', name: 'quinn' });
    expect(result).not.toBeNull();
    expect(result!.label).toBe('Marcus');
  });
});

// ─── checkBypass ────────────────────────────────────────────

describe('checkBypass', () => {
  it('bypasses council agents', () => {
    const result = checkBypass('This is a council discussion about architecture');
    expect(result).toBe('council');
  });

  it('bypasses research agents without implementation markers', () => {
    const result = checkBypass('Research the API surface for this library');
    expect(result).toBe('research');
  });

  it('does NOT bypass research agents with implementation markers', () => {
    const result = checkBypass('Research the API\n## Task\nDo the thing\n## Verify\nCheck it');
    expect(result).toBeNull();
  });

  it('bypasses investigate agents', () => {
    const result = checkBypass('Investigate why the test fails');
    expect(result).toBe('research');
  });

  it('bypasses audit agents without implementation markers', () => {
    const result = checkBypass('Audit the codebase for security issues');
    expect(result).toBe('research');
  });

  it('returns null for regular prompts', () => {
    const result = checkBypass('Implement the feature as described in the spec');
    expect(result).toBeNull();
  });
});

// ─── validateMarkers ────────────────────────────────────────

describe('validateMarkers', () => {
  it('returns empty array when all markers present', () => {
    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Marcus')!;
    const prompt = '## Context\nSome context\n## Task\nDo it\n## Verify\nCheck\n## Report back\nDone';
    expect(validateMarkers(agent, prompt)).toEqual([]);
  });

  it('returns missing markers', () => {
    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Marcus')!;
    const prompt = '## Context\nSome context\n## Task\nDo it';
    const missing = validateMarkers(agent, prompt);
    expect(missing).toContain('## Verify');
    expect(missing).toContain('## Report back');
    expect(missing.length).toBe(2);
  });

  it('returns all markers when prompt is empty', () => {
    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Quinn')!;
    const missing = validateMarkers(agent, '');
    expect(missing.length).toBe(agent.markers.length);
  });
});

// ─── checkShipActive ────────────────────────────────────────

describe('checkShipActive', () => {
  it('returns null when no markers exist', () => {
    mkdirSync(join(workDir, '65-some-work'), { recursive: true });
    const result = checkShipActive(workDir);
    expect(result).toBeNull();
  });

  it('returns marker when valid .ship-active exists', () => {
    const now = new Date().toISOString();
    const dir = join(workDir, '65-engineer-guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 65, ts: now }));
    const result = checkShipActive(workDir);
    expect(result).not.toBeNull();
    expect(result!.issue).toBe(65);
  });

  it('returns most recent marker when multiple exist', () => {
    const older = '2026-06-29T10:00:00Z';
    const newer = '2026-06-29T14:00:00Z';

    const dir1 = join(workDir, '60-old');
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, '.ship-active'), JSON.stringify({ issue: 60, ts: older }));

    const dir2 = join(workDir, '65-new');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, '.ship-active'), JSON.stringify({ issue: 65, ts: newer }));

    const result = checkShipActive(workDir);
    expect(result).not.toBeNull();
    expect(result!.issue).toBe(65);
  });

  it('returns null when workDir does not exist', () => {
    rmSync(workDir, { recursive: true, force: true });
    const result = checkShipActive(workDir);
    expect(result).toBeNull();
  });

  it('skips malformed marker files', () => {
    const dir = join(workDir, '65-bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), 'not json');
    const result = checkShipActive(workDir);
    expect(result).toBeNull();
  });

  it('finds nested markers (2-level)', () => {
    const now = new Date().toISOString();
    const dir = join(workDir, 'pai', '352');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 352, ts: now }));
    const result = checkShipActive(workDir);
    expect(result).not.toBeNull();
    expect(result!.issue).toBe(352);
  });
});

// ─── findSizingFromCheckpoint ───────────────────────────────

describe('findSizingFromCheckpoint', () => {
  it('returns null when workDir has no checkpoints', () => {
    const result = findSizingFromCheckpoint(workDir);
    expect(result).toBeNull();
  });

  it('extracts sizing from **Size:** pattern', () => {
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CHECKPOINT.md'), '# Checkpoint\n**Size:** M\n');
    const result = findSizingFromCheckpoint(workDir);
    expect(result).toBe('M');
  });

  it('extracts sizing from ## Sizing pattern', () => {
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CHECKPOINT.md'), '# Checkpoint\n## Sizing\nThis is XS\n');
    const result = findSizingFromCheckpoint(workDir);
    expect(result).toBe('XS');
  });
});

// ─── validateBriefPolicies ──────────────────────────────────

describe('validateBriefPolicies', () => {
  it('returns empty when no policy file exists', () => {
    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Marcus')!;
    const result = validateBriefPolicies(agent, 'some prompt', tempDir);
    expect(result).toEqual([]);
  });

  it('returns missing patterns when policy exists', () => {
    // Create a brief-policies.json
    const skillsDir = join(tempDir, 'skills', 'ship');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'brief-policies.json'), JSON.stringify({
      policies: {
        marcus: {
          requiredPatterns: [
            { name: 'acceptance-criteria', pattern: '## Acceptance Criteria' },
            { name: 'git-protocol', pattern: '## Git protocol' },
          ],
        },
      },
    }));

    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Marcus')!;
    const result = validateBriefPolicies(agent, 'No matching content here', tempDir);
    expect(result).toContain('acceptance-criteria');
    expect(result).toContain('git-protocol');
  });

  it('returns empty when all patterns match', () => {
    const skillsDir = join(tempDir, 'skills', 'ship');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'brief-policies.json'), JSON.stringify({
      policies: {
        marcus: {
          requiredPatterns: [
            { name: 'task-section', pattern: '## Task' },
          ],
        },
      },
    }));

    const agent: AgentDef = NAMED_AGENTS.find(a => a.label === 'Marcus')!;
    const result = validateBriefPolicies(agent, '## Task\nDo the work', tempDir);
    expect(result).toEqual([]);
  });
});

// ─── validateBrief (main orchestrator) ──────────────────────

describe('validateBrief', () => {
  it('returns pass for non-Agent tool calls', () => {
    const result = validateBrief({
      tool_name: 'Write',
      tool_input: {},
    });
    expect(result.action).toBe('pass');
  });

  it('bypasses council agents', () => {
    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: 'This is a council discussion',
        mode: 'bypassPermissions',
        subagent_type: 'Engineer',
      },
    });
    expect(result.action).toBe('pass');
    expect(result.bypass).toBe('council');
  });

  it('blocks Engineer missing bypassPermissions', () => {
    // Need active ship
    const now = new Date().toISOString();
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 65, ts: now }));

    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: '## Context\n## Task\n## Verify\n## Report back',
        mode: 'normal',
        subagent_type: 'Engineer',
      },
    });
    expect(result.action).toBe('block');
    expect(result.blockReason).toContain('bypassPermissions');
  });

  it('blocks Engineer missing template markers', () => {
    const now = new Date().toISOString();
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 65, ts: now }));

    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: 'Just do some work',
        mode: 'bypassPermissions',
        subagent_type: 'Engineer',
      },
    });
    expect(result.action).toBe('block');
    expect(result.blockReason).toContain('template');
  });

  it('blocks Engineer without active ship session', () => {
    // No ship-active marker anywhere
    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: '## Context\n## Task\n## Verify\n## Report back',
        mode: 'bypassPermissions',
        subagent_type: 'Engineer',
      },
    });
    expect(result.action).toBe('block');
    expect(result.blockReason).toContain('ship session');
  });

  it('passes valid Engineer spawn with all checks', () => {
    const now = new Date().toISOString();
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 65, ts: now }));

    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: '## Context\nHere\n## Task\nDo it\n## Verify\nCheck\n## Report back\nDone',
        mode: 'bypassPermissions',
        subagent_type: 'Engineer',
        max_turns: 30,
      },
    });
    expect(result.action).toBe('pass');
    expect(result.agent?.label).toBe('Marcus');
  });

  it('warns non-Engineer about missing markers (does not block)', () => {
    const now = new Date().toISOString();
    const dir = join(workDir, '65-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue: 65, ts: now }));

    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: 'Missing all template markers',
        mode: 'bypassPermissions',
        subagent_type: 'QATester',
        max_turns: 30,
      },
    });
    expect(result.action).toBe('pass');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns null agent for unknown subagent_type', () => {
    const result = validateBrief({
      tool_name: 'Agent',
      tool_input: {
        prompt: 'Do something',
        mode: 'bypassPermissions',
        subagent_type: 'RandomAgent',
      },
    });
    expect(result.action).toBe('pass');
    expect(result.agent).toBeNull();
  });
});
