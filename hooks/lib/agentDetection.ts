/**
 * Shared Agent Detection — Config-Driven
 *
 * Reads agent matching patterns from agent-config.json instead of hardcoding.
 * Adding new agents requires only a JSON change, zero code changes.
 *
 * ## The config was not in the tree, and the `catch` hid it (#1000)
 *
 * From #382 until 2026-10-21 this module read an `agent-config.json` that was
 * in no commit on any branch of this repository. `readFileSync` threw
 * `ENOENT`, a bare `catch` returned `{ agents: {} }`, the loop below ran zero
 * times, and `detectAgent` returned `null` for **every** input. Its only
 * consumer, `hooks/CommitEnforcement.hook.ts`, exits on `null` — so that
 * hook's UI-file detection and its uncommitted-changes tripwire never fired
 * once, in either this tree or the registered one.
 *
 * Two things follow, and the second is the one that matters:
 *
 * 1. The config now ships beside this file. Its five agents and the
 *    `exclude: ["council"]` on `marcus` are RECOVERED from the copy that has
 *    sat at `~/.claude/hooks/lib/agent-config.json` since Sep 9 — not
 *    reconstructed from the match patterns, which would have invented the
 *    exclusions. (#1000 said the file "has never existed on any branch",
 *    which is true of this repo and false of the machine: a census over one
 *    scope reporting confident absence, which is #910 and #713 again.)
 *
 * 2. **An unreadable config is a REFUSAL.** Adding the file fixes the outage;
 *    it does not fix the thing that let the outage last a month. A bare
 *    `catch` returning an empty reading is `.claude/rules/config-access.md`'s
 *    *Silent Default Substitution*: "no agent matched" and "I could not read
 *    my own config" produced the same `null`, so no search, log or test could
 *    tell them apart. Absent, unparseable, wrong-shaped and **zero-agent**
 *    configs all throw now. Zero agents is included deliberately — it is the
 *    exact value the `catch` used to fabricate, and a real file holding it
 *    would reinstate the defect in a form every other check passes.
 *
 * Callers must decide what to do with the throw; `CommitEnforcement` records
 * it as `unmeasured-agent-config` through `lib/hook-evidence.ts` so a hook
 * that COULD NOT RUN stays distinguishable from one that declined (#910).
 *
 * Issue: #374 (extracted from AutoVerifyGate + MarcusCommitCheck)
 * Refactored: #382 (config-driven, supports N agents)
 * Fixed: #1000 (config shipped; silent default substitution removed)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { errorFacts, recordHookFiring } from '../../lib/hook-evidence';

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

/** Raised instead of substituting an empty reading. Named so a caller can tell this apart from a bug in the matcher. */
export class AgentConfigUnreadable extends Error {
  readonly name = 'AgentConfigUnreadable';
}

/**
 * The config beside this module.
 *
 * `fileURLToPath` and not `new URL(…).pathname`: the latter is
 * percent-encoded, so under any checkout whose path contains a space it
 * produced `…/My%20Repo/…`, `ENOENT`, and — through the old `catch` — this
 * issue's exact symptom from a second, environment-dependent direction.
 */
export function agentConfigPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'agent-config.json');
}

function loadConfig(): AgentConfigFile {
  if (_configCache) return _configCache;
  const configPath = agentConfigPath();

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (e) {
    throw new AgentConfigUnreadable(
      `agent-config.json could not be read at ${configPath}: ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AgentConfigUnreadable(
      `agent-config.json at ${configPath} is not valid JSON: ${(e as Error).message}`,
    );
  }

  const agents = (parsed as AgentConfigFile | null)?.agents;
  if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) {
    throw new AgentConfigUnreadable(
      `agent-config.json at ${configPath} has no "agents" object`,
    );
  }
  // The value the old `catch` invented. A file that really holds it detects
  // nothing, exactly as the missing file did, and would pass every check that
  // only asks whether the config loaded.
  if (Object.keys(agents).length === 0) {
    throw new AgentConfigUnreadable(
      `agent-config.json at ${configPath} declares zero agents, so nothing can ever match`,
    );
  }
  for (const [key, cfg] of Object.entries(agents)) {
    if (!Array.isArray(cfg?.match) || cfg.match.length === 0) {
      throw new AgentConfigUnreadable(
        `agent-config.json at ${configPath}: agent "${key}" has no match patterns, so it can never be detected`,
      );
    }
  }

  _configCache = { agents };
  return _configCache;
}

/**
 * Detect which known agent a tool invocation targets.
 * Returns null if no agent from config matches.
 *
 * THROWS `AgentConfigUnreadable` if the config cannot be read, parsed, or
 * declares no usable agent. `null` means "no agent matched" and nothing else;
 * a caller that treats the throw as `null` reinstates #1000.
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

/**
 * `detectAgent`, with the unreadable case RECORDED instead of silent.
 *
 * This is the form a hook should call. `detectAgent` throws so that no
 * caller can mistake "could not read my config" for "no agent matched", but
 * a `PreToolUse`/`PostToolUse` hook that throws is a crash on every tool
 * call — so the hook needs the throw turned back into a skip, and the ONLY
 * thing that makes that skip safe is the record it leaves behind.
 *
 * Both halves live here rather than in the hook for the reason #1000 exists:
 * the next consumer that writes its own `try { detectAgent() } catch {}` will
 * write the `catch {}`, and that is precisely the defect. One place knows
 * what "could not run" looks like, and it is the place that knows how the
 * reading can fail.
 *
 * Returns `null` for both outcomes; the evidence file is what distinguishes
 * them. Only the unreadable case is recorded — this hook is attached to every
 * `Agent` call, and a record per call is a file nobody can read.
 */
export function detectAgentOrRecord(
  toolInput: { name?: string; subagent_type?: string; prompt?: string },
  hook: string,
  detail: Record<string, unknown> = {},
): DetectedAgent | null {
  try {
    return detectAgent(toolInput);
  } catch (e) {
    recordHookFiring(hook, 'unmeasured-agent-config', {
      ...detail,
      configPath: agentConfigPath(),
      ...errorFacts(e),
    });
    return null;
  }
}
