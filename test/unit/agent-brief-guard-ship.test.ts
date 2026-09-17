/**
 * Regression tests for AgentBriefGuard.hook.ts — ship-active enforcement
 * Covers:
 *   1. Engineer BLOCKED when no .ship-active marker exists anywhere in MEMORY/WORK/
 *   2. Engineer ALLOWED when valid .ship-active marker exists (< 4 hours old)
 *   3. Engineer BLOCKED when marker exists but is > 4 hours old (stale)
 *   4. Quinn/Rook NOT affected by ship-active check (they pass without marker)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;
let workDir: string;
let signalsDir: string;

const origPaiDir = process.env.PAI_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ship-guard-test-'));
  workDir = join(tempDir, 'MEMORY', 'WORK');
  signalsDir = join(tempDir, 'MEMORY', 'LEARNING', 'SIGNALS');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(signalsDir, { recursive: true });
  // Create signals.jsonl so logSignal doesn't skip
  writeFileSync(join(signalsDir, 'signals.jsonl'), '');
  process.env.PAI_DIR = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (origPaiDir !== undefined) {
    process.env.PAI_DIR = origPaiDir;
  } else {
    delete process.env.PAI_DIR;
  }
});

// ─── Reimplementation of checkShipActive matching the expected hook behavior ───

interface ShipMarker {
  issue: number;
  ts: string;
}

function checkShipActive(testWorkDir: string): ShipMarker | null {
  if (!existsSync(testWorkDir)) return null;

  const markers: ShipMarker[] = [];

  try {
    const entries = readdirSync(testWorkDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = join(testWorkDir, entry.name, '.ship-active');
      if (!existsSync(markerPath)) continue;

      try {
        const raw = readFileSync(markerPath, 'utf-8');
        const parsed = JSON.parse(raw) as ShipMarker;
        if (parsed.issue && parsed.ts) {
          markers.push(parsed);
        }
      } catch {
        // Skip malformed markers
      }
    }
  } catch {
    return null;
  }

  if (markers.length === 0) return null;

  // Return most recent by ts
  markers.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return markers[0];
}

function isMarkerStale(marker: ShipMarker, maxAgeMs = 4 * 60 * 60 * 1000): boolean {
  const age = Date.now() - new Date(marker.ts).getTime();
  return age > maxAgeMs;
}

// Helper: create a .ship-active marker
function createShipMarker(dirName: string, issue: number, ts: string) {
  const dir = join(workDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.ship-active'), JSON.stringify({ issue, ts }));
}

// Helper: create a CHECKPOINT.md with sizing (needed for existing checks)
function createCheckpointWithSizing(dirName: string, size: string) {
  const dir = join(workDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CHECKPOINT.md'), `# Checkpoint\n**Size:** ${size}\n`);
}

describe('AgentBriefGuard — ship-active enforcement', () => {

  describe('checkShipActive function', () => {
    it('returns null when no .ship-active markers exist', () => {
      mkdirSync(join(workDir, '65-some-work'), { recursive: true });
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });

    it('returns marker when valid .ship-active exists', () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);
      const result = checkShipActive(workDir);
      expect(result).not.toBeNull();
      expect(result!.issue).toBe(65);
      expect(result!.ts).toBe(now);
    });

    it('returns most recent marker when multiple exist', () => {
      const older = '2026-06-29T10:00:00Z';
      const newer = '2026-06-29T14:00:00Z';
      createShipMarker('60-old-work', 60, older);
      createShipMarker('65-new-work', 65, newer);
      const result = checkShipActive(workDir);
      expect(result).not.toBeNull();
      expect(result!.issue).toBe(65);
      expect(result!.ts).toBe(newer);
    });

    it('returns null when WORK_DIR does not exist', () => {
      rmSync(workDir, { recursive: true, force: true });
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });

    it('skips malformed marker files', () => {
      const dir = join(workDir, '65-bad-marker');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.ship-active'), 'not json');
      const result = checkShipActive(workDir);
      expect(result).toBeNull();
    });
  });

  describe('isMarkerStale', () => {
    it('marker < 4 hours old is NOT stale', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const marker: ShipMarker = { issue: 65, ts: twoHoursAgo };
      expect(isMarkerStale(marker)).toBe(false);
    });

    it('marker > 4 hours old IS stale', () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const marker: ShipMarker = { issue: 65, ts: fiveHoursAgo };
      expect(isMarkerStale(marker)).toBe(true);
    });

    it('marker slightly over 4 hours is stale', () => {
      const slightlyOver = new Date(Date.now() - 4 * 60 * 60 * 1000 - 1000).toISOString();
      const overMarker: ShipMarker = { issue: 65, ts: slightlyOver };
      expect(isMarkerStale(overMarker)).toBe(true);
    });
  });

  describe('Integration: hook blocks/allows Engineer spawns', () => {
    const hookPath = join(process.env.HOME!, '.pai', 'hooks', 'AgentBriefGuard.hook.ts');

    // Build a valid agent payload with correct template markers
    function makePayload(agentType: string, extras: Record<string, unknown> = {}) {
      const markers: Record<string, string[]> = {
        Engineer: ['## Context', '## Task', '## Verify', '## Report back'],
        QATester: ['## Context', '## Environment', '## Test scenarios'],
        Pentester: ['## Context', '## Scan scope', '## Report'],
      };

      const prompt = (markers[agentType] || []).join('\n\nContent here.\n\n');
      return JSON.stringify({
        tool_name: 'Agent',
        tool_input: {
          prompt,
          subagent_type: agentType,
          mode: 'bypassPermissions',
          ...extras,
        },
      });
    }

    it('BLOCKS Engineer when no .ship-active marker exists', async () => {
      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).toContain('"decision":"block"');
      expect(stdout).toContain('ship');
      expect(stderr).toContain('no_ship_session');
    });

    it('ALLOWS Engineer when valid .ship-active marker exists', async () => {
      const now = new Date().toISOString();
      createShipMarker('65-engineer-guard', 65, now);
      createCheckpointWithSizing('65-engineer-guard', 'S');

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });

    it('BLOCKS Engineer when marker is stale (> 4 hours old)', async () => {
      const staleTs = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      createShipMarker('65-engineer-guard', 65, staleTs);

      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Engineer')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).toContain('"decision":"block"');
      expect(stdout).toContain('ship');
      expect(stderr).toContain('no_ship_session');
    });

    it('Quinn NOT affected — passes without .ship-active marker', async () => {
      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('QATester')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });

    it('Rook NOT affected — passes without .ship-active marker', async () => {
      const proc = Bun.spawn(['bun', 'run', hookPath], {
        stdin: Buffer.from(makePayload('Pentester')),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PAI_DIR: tempDir },
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(stdout).not.toContain('"decision":"block"');
      expect(stdout).toContain('system-reminder');
      expect(stderr).toContain('spawn validated');
    });
  });
});
