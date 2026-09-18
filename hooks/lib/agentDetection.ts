/**
 * Shared Agent Detection — Config-Driven
 *
 * Reads agent matching patterns from agent-config.json instead of hardcoding.
 * Adding new agents requires only a JSON change, zero code changes.
 *
 * Issue: #374 (extracted from AutoVerifyGate + MarcusCommitCheck)
 * Refactored: #382 (config-driven, supports N agents)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

interface AgentConfig {
  match: string[];
  exclude?: string[];
}

interface AgentConfigFile {
  agents: Record<string, AgentConfig>;
}

export type AgentKey = string;

export interface DetectedAgent {
  key: AgentKey;
  name: string;
}

let _configCache: AgentConfigFile | null = null;

function loadConfig(): AgentConfigFile {
  if (_configCache) return _configCache;
  try {
    const configPath = join(dirname(new URL(import.meta.url).pathname), 'agent-config.json');
    _configCache = JSON.parse(readFileSync(configPath, 'utf-8'));
    return _configCache!;
  } catch {
    return { agents: {} };
  }
}

/**
 * Detect which known agent a tool invocation targets.
 * Returns null if no agent from config matches.
 *
 * Detection signals (checked per agent):
 *   1. Exclude check — if prompt contains any exclude term, skip agent
 *   2. Name contains a match pattern
 *   3. subagent_type equals a match pattern
 *   4. Prompt contains a match pattern
 */
export function detectAgent(toolInput: { name?: string; subagent_type?: string; prompt?: string }): DetectedAgent | null {
  const agentName = (toolInput.name || '').toLowerCase();
  const agentType = (toolInput.subagent_type || '').toLowerCase();
  const prompt = (toolInput.prompt || '').toLowerCase();
  const config = loadConfig();

  for (const [key, cfg] of Object.entries(config.agents)) {
    const excluded = (cfg.exclude || []).some(ex => prompt.includes(ex));
    if (excluded) continue;

    const matched = cfg.match.some(pattern =>
      agentName.includes(pattern) || agentType === pattern || prompt.includes(pattern)
    );
    if (matched) return { key, name: toolInput.name || key };
  }

  return null;
}
