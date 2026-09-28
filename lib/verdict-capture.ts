/**
 * Verdict Capture Logic
 *
 * Extracted from AgentVerdictCapture.hook.ts (#544).
 * Contains workflow discovery and verdict parsing from agent output.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Find the most recently modified active workflow-state.json.
 * Active phases: BUILD, VERIFY, SHIP.
 */
export function findActiveWorkflow(workDir: string): { path: string; data: any } | null {
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

/**
 * Extract a structured verdict from agent output text.
 * Looks for a "## Verdict" heading followed by a JSON block.
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
