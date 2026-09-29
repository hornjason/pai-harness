/**
 * create-brief — Generate agent brief templates and register roles in config.
 *
 * Deep module: all logic here, CLI is a thin consumer.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import type { AgentMeta } from "./generators/types";

/**
 * Generate an agent brief markdown template with standard sections and variable placeholders.
 */
export function generateBriefTemplate(roleName: string, description: string): string {
  const today = new Date().toISOString().split("T")[0];
  const displayName = roleName.charAt(0).toUpperCase() + roleName.slice(1);

  return `---
doc-type: reference
status: active
owner: TODO
updated: ${today}
---

You are ${displayName}, ${description}.

\${PROJECT_IDENTITY}

\${SHARED_RULES}

## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity, critical rules, documentation routing
2. **PROJECT-STATE.md** — current priorities, session handoff
3. **Governing spec** — look up in AGENTS.md Specs table for the area you're changing

## Workflow

1. Read AGENTS.md for project rules and routing
2. Read the governing spec if your task touches a spec'd area
3. Execute your task following project conventions
4. Report results with evidence

## Never Do

- Read the same file twice — get what you need in one pass
- Use \`cat\`, \`head\`, or \`tail\` via Bash — use the Read tool instead
- Run \`pwd\` or \`ls -la\` for orientation — your CWD is always the project root
- Guess at file structure — use AGENTS.md routing table

## Report

- PASS/FAIL per AC with evidence (command output or screenshots)
- Any new findings flagged as blocking or non-blocking

## Rules

- Never run \`make rebuild\` — only the DA does that
- Verify before asserting — try it first, report what actually happened
`;
}

/**
 * Write a generated brief template to the templates directory.
 * Returns the file path written to.
 */
export function writeBriefTemplate(templatesDir: string, roleName: string, description: string): string {
  const filePath = `${templatesDir}/${roleName}.md`;
  if (existsSync(filePath)) {
    throw new Error(`Template already exists: ${filePath}`);
  }
  const content = generateBriefTemplate(roleName, description);
  writeFileSync(filePath, content);
  return filePath;
}

/** Agent metadata shape used for frontmatter generation */
export type AgentMeta = {
  description: string;
  tools: string;
  model: string;
  tiers?: Record<string, string[]>;
};

/**
 * Build agent metadata map exclusively from rungate.json roles config.
 * No hardcoded defaults — all metadata comes from config.
 * Falls back to sensible per-field defaults only when a config entry omits a field.
 */
export function buildAgentMeta(
  roles: Record<string, any> | undefined,
): Record<string, AgentMeta> {
  const agentMeta: Record<string, AgentMeta> = {};
  if (!roles) return agentMeta;

  for (const [roleName, roleConfig] of Object.entries(roles)) {
    const cfg = roleConfig as any;
    agentMeta[roleName] = {
      description: cfg.description || `${roleName} agent`,
      tools: cfg.tools || "[Bash, Read]",
      model: cfg.model || "sonnet",
      ...(cfg.tiers ? { tiers: cfg.tiers } : {}),
    };
  }

  return agentMeta;
}

/**
 * Add a new role to the project's rungate.json config.
 * Adds brief path, isolation: worktree, and a standardTask.
 */
export function addRoleToConfig(configPath: string, roleName: string, description: string): void {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!config.roles) {
    config.roles = {};
  }
  if (config.roles[roleName]) {
    throw new Error(`Role '${roleName}' already exists in ${configPath}`);
  }
  config.roles[roleName] = {
    brief: `.claude/agents/${roleName}.md`,
    isolation: "worktree",
    standardTask: `Perform ${description.toLowerCase()} tasks as assigned`,
    description,
    tools: "[Bash, Read]",
    model: "sonnet",
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export const DEFAULT_AGENT_META: Record<string, AgentMeta> = {
  discovery: { description: "Discovery agent — reads issue, sizes work, writes ACs with evidence methods", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Discovery Rules"] } },
  marcus: { description: "Principal engineer — implements code changes with TDD, writes tests, commits", tools: "[Bash, Read, Write, Edit]", model: "sonnet", tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] } },
  quinn: { description: "QA engineer — tests as a brand-new user using Playwright MCP tools", tools: "[Bash, Read, mcp__playwright__*]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection", "CLI Testing Mode"] } },
  rook: { description: "Security engineer — scans changed files for vulnerabilities", tools: "[Bash, Read]", model: "sonnet" },
  serena: { description: "Software architect — structural decisions, ADRs, module boundary review", tools: "[Bash, Read]", model: "sonnet" },
  aditi: { description: "UX/UI designer — component specs, visual review, accessibility", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection"] } },
};

/**
 * Build agentMeta record from harness roles config.
 * Returns only config-sourced entries — callers merge with DEFAULT_AGENT_META if needed.
 */
export function buildAgentMeta(harnessConfig: Record<string, any> | null): Record<string, AgentMeta> {
  const result: Record<string, AgentMeta> = {};
  if (!harnessConfig?.roles) return result;

  for (const [roleName, roleConfig] of Object.entries(harnessConfig.roles as Record<string, any>)) {
    result[roleName] = {
      description: roleConfig.description || `${roleName} agent`,
      tools: roleConfig.tools || "[Bash, Read]",
      model: roleConfig.model || "sonnet",
      ...(roleConfig.tiers ? { tiers: roleConfig.tiers } : {}),
    };
  }
  return result;
}
