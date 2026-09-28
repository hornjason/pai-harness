/**
 * Verdict capture logic — extracted from AgentVerdictCapture.hook.ts
 *
 * Deep module: contains workflow discovery and verdict parsing.
 * The hook file is a thin trigger that delegates here.
 *
 * Issue: #544
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ActiveWorkflow {
  path: string;
  data: any;
}

/**
 * Find the most recently modified active workflow-state.json.
 * Scans 1 and 2 levels deep under workDir for BUILD/VERIFY/SHIP phases.
 */
export function findActiveWorkflow(workDir: string): ActiveWorkflow | null {
  if (!existsSync(workDir)) return null;
  let best: { path: string; data: any; mtime: number } | null = null;

  try {
    for (const entry of readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Level 1
      const wfPath = join(workDir, entry.name, 'workflow-state.json');
      if (existsSync(wfPath)) {
        try {
          const data = JSON.parse(readFileSync(wfPath, 'utf-8'));
          if (['BUILD', 'VERIFY', 'SHIP'].includes(data.phase)) {
            const mtime = statSync(wfPath).mtimeMs;
            if (!best || mtime > best.mtime) best = { path: wfPath, data, mtime };
          }
        } catch {}
      }
      // Level 2
      try {
        for (const sub of readdirSync(join(workDir, entry.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const nestedWf = join(workDir, entry.name, sub.name, 'workflow-state.json');
          if (!existsSync(nestedWf)) continue;
          try {
            const data = JSON.parse(readFileSync(nestedWf, 'utf-8'));
            if (['BUILD', 'VERIFY', 'SHIP'].includes(data.phase)) {
              const mtime = statSync(nestedWf).mtimeMs;
              if (!best || mtime > best.mtime) best = { path: nestedWf, data, mtime };
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return best ? { path: best.path, data: best.data } : null;
}

/**
 * Extract a structured verdict block from agent output text.
 * Looks for "## Verdict\n{...}" pattern.
 */
export function extractVerdict(text: string): any | null {
  const match = text.match(/## Verdict\n(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}
