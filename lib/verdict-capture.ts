/**
 * Verdict capture logic — extracted from AgentVerdictCapture.hook.ts
 *
 * Contains workflow discovery and verdict text parsing.
 * Hook file is thin trigger only.
 *
 * Per Hook Architecture Spec D-2: hook logic in lib/ with unit tests.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ActiveWorkflow {
  path: string;
  data: any;
}

/**
 * Extract a structured verdict from agent text output.
 * Looks for ## Verdict header followed by a JSON object.
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

/**
 * Find the most recently modified active workflow (BUILD/VERIFY/SHIP).
 * Scans workDir for workflow-state.json files in subdirectories.
 */
export function findActiveWorkflow(workDir: string): ActiveWorkflow | null {
  if (!existsSync(workDir)) return null;
  let best: { path: string; data: any; mtime: number } | null = null;

  function scan(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const wfPath = join(dir, entry.name, 'workflow-state.json');
        if (existsSync(wfPath)) {
          try {
            const data = JSON.parse(readFileSync(wfPath, 'utf-8'));
            if (['BUILD', 'VERIFY', 'SHIP'].includes(data.phase)) {
              const mtime = statSync(wfPath).mtimeMs;
              if (!best || mtime > best.mtime) {
                best = { path: wfPath, data, mtime };
              }
            }
          } catch {}
        }
        // Check nested subdirectories
        const nested = join(dir, entry.name);
        try {
          for (const sub of readdirSync(nested, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            const nestedWf = join(nested, sub.name, 'workflow-state.json');
            if (!existsSync(nestedWf)) continue;
            try {
              const data = JSON.parse(readFileSync(nestedWf, 'utf-8'));
              if (['BUILD', 'VERIFY', 'SHIP'].includes(data.phase)) {
                const mtime = statSync(nestedWf).mtimeMs;
                if (!best || mtime > best.mtime) {
                  best = { path: nestedWf, data, mtime };
                }
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  scan(workDir);
  return best ? { path: best.path, data: best.data } : null;
}
