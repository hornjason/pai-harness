#!/usr/bin/env bun
/**
 * AgentVerdictCapture.hook.ts — SubagentStop hook
 *
 * Parses agent output for structured verdict blocks.
 * Writes verdict, testedSha, testedPaths, spawned to workflow-state.json.
 * Auto-appends blockers to verifyBlockers[].
 *
 * Issue: #439
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseHookInput } from './lib/parseStdin';
import { detectAgent } from './lib/agentDetection';

const WORK_DIR = process.env.RUNGATE_WORK_DIR || process.env.PAI_WORK_DIR || join(process.env.HOME!, '.rungate');

function findActiveWorkflow(): { path: string; data: any } | null {
  if (!existsSync(WORK_DIR)) return null;
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

  scan(WORK_DIR);
  return best ? { path: best.path, data: best.data } : null;
}

function extractVerdict(text: string): any | null {
  const match = text.match(/## Verdict\n(\{[\s\S]*?\n\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function identifyRole(toolInput: any): string | null {
  const detected = detectAgent(toolInput);
  if (detected) return detected.key;
  const name = (toolInput.name || '').toLowerCase();
  if (name.startsWith('quinn')) return 'quinn';
  if (name.startsWith('marcus')) return 'marcus';
  if (name.startsWith('rook')) return 'rook';
  return null;
}

async function main() {
  const payload = await parseHookInput();
  if (!payload) process.exit(0);

  const toolInput = payload.tool_input || {};
  const role = identifyRole(toolInput);
  if (!role) process.exit(0);

  const wf = findActiveWorkflow();
  if (!wf) process.exit(0);

  const resp = payload.tool_response;
  const respText = typeof resp === 'string' ? resp : (resp?.output || JSON.stringify(resp) || '');

  const verdict = extractVerdict(respText);
  const state = wf.data;

  if (!state.agents) state.agents = {};
  if (!state.agents[role]) state.agents[role] = {};

  state.agents[role].spawned = true;

  if (verdict) {
    state.agents[role].verdict = verdict.verdict || verdict.result || null;
    if (verdict.testedSha) state.agents[role].testedSha = verdict.testedSha;
    if (verdict.testedPaths) state.agents[role].testedPaths = verdict.testedPaths;

    if (verdict.blockers && Array.isArray(verdict.blockers)) {
      if (!state.verifyBlockers) state.verifyBlockers = [];
      for (const b of verdict.blockers) {
        const id = b.id || `${role}-blocker-${state.verifyBlockers.length + 1}`;
        if (!state.verifyBlockers.some((vb: any) => vb.id === id)) {
          state.verifyBlockers.push({
            id,
            description: b.description || b.detail || String(b),
            quinnReverified: false,
          });
        }
      }
    }
  } else {
    state.agents[role].verdict = null;
  }

  state.updatedTs = new Date().toISOString();
  writeFileSync(wf.path, JSON.stringify(state, null, 2));
  console.error(`[agent-verdict-capture] ${role}: verdict=${verdict?.verdict || 'null'}, path=${wf.path}`);
  process.exit(0);
}

main();
