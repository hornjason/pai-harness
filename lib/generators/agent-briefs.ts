/**
 * Agent briefs generator — reads template files from templates/agent-briefs/
 * and fills variables from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2)
 * and AGENT-BRIEF-TEMPLATE-SPEC (SC-348).
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import type { ProjectScan, AgentMeta } from "./types";

/**
 * Default agent metadata — used when roles config is absent.
 */
const DEFAULT_AGENT_META: Record<string, AgentMeta> = {
  discovery: { description: "Discovery agent — reads issue, sizes work, writes ACs with evidence methods", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Discovery Rules"] } },
  marcus: { description: "Principal engineer — implements code changes with TDD, writes tests, commits", tools: "[Bash, Read, Write, Edit]", model: "sonnet", tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] } },
  quinn: { description: "QA engineer — tests as a brand-new user using Playwright MCP tools", tools: "[Bash, Read, mcp__playwright__*]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection", "CLI Testing Mode"] } },
  rook: { description: "Security engineer — scans changed files for vulnerabilities", tools: "[Bash, Read]", model: "sonnet" },
  serena: { description: "Software architect — structural decisions, ADRs, module boundary review", tools: "[Bash, Read]", model: "sonnet" },
  aditi: { description: "UX/UI designer — component specs, visual review, accessibility", tools: "[Bash, Read]", model: "sonnet", tiers: { reinforcement: ["Project Type Detection"] } },
};

/**
 * Resolve the templates directory. Checks:
 * 1. Explicit harnessTemplatesDir from scan
 * 2. Relative to this file's location (lib/generators/ -> ../../templates/agent-briefs/)
 */
function resolveTemplatesDir(scan: ProjectScan): string {
  if (scan.harnessTemplatesDir && existsSync(scan.harnessTemplatesDir)) {
    return scan.harnessTemplatesDir;
  }
  // Default: relative to this module (lib/generators/../../templates/agent-briefs/)
  const fallback = join(dirname(dirname(__dirname)), "templates", "agent-briefs");
  return fallback;
}

/**
 * Generate all agent briefs from templates/agent-briefs/ templates.
 *
 * Returns a record mapping agent name to generated brief content.
 * Does NOT write files — caller decides where to write.
 */
export function generateAgentBriefs(scan: ProjectScan): Record<string, string> {
  const templatesDir = resolveTemplatesDir(scan);
  const result: Record<string, string> = {};

  if (!existsSync(templatesDir)) {
    return result;
  }

  // Load shared rules partial
  const sharedRulesPath = join(templatesDir, "_shared.md");
  let sharedRules = existsSync(sharedRulesPath)
    ? readFileSync(sharedRulesPath, "utf-8").trim()
    : "";
  // Strip frontmatter from partials
  sharedRules = sharedRules.replace(/^---[\s\S]*?---\n*/, "");

  // Build project identity section
  const identitySection = scan.identity
    ? `## Project\n\n${scan.identity}\n`
    : "";

  // Build source dirs list
  const dirList = scan.sourceDirs.length > 0
    ? scan.sourceDirs.map(d => `- \`${d}/\``).join("\n")
    : "";

  // Build consumer note
  const consumerNote = scan.consumers.length > 0
    ? `\n## Consumers (${scan.consumers.length})\n\n${scan.consumers.map(c => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.\n`
    : "";

  // Harness config shortcuts
  const harness = scan.harnessConfig;
  const devUi = harness?.dev?.uiBase || null;
  const devApi = harness?.dev?.apiBase || null;
  const testCmd = harness?.dev?.testCmd || scan.testCmd || "bun test";
  const typeCheck = harness?.dev?.typeCheck || "bunx tsc --noEmit";
  const pages = harness?.pages || {};
  const pagesTable = Object.keys(pages).length > 0
    ? "### Pages Map\n\n| Path | Page |\n|------|------|\n" +
      Object.entries(pages).map(([k, v]) => `| ${v} | ${k} |`).join("\n")
    : "";

  // Merge agent metadata from roles config with defaults
  const agentMeta: Record<string, AgentMeta> = { ...DEFAULT_AGENT_META };
  if (scan.agentMeta) {
    for (const [roleName, meta] of Object.entries(scan.agentMeta)) {
      agentMeta[roleName] = { ...DEFAULT_AGENT_META[roleName], ...meta };
    }
  }
  if (harness?.roles) {
    for (const [roleName, roleConfig] of Object.entries(harness.roles as Record<string, any>)) {
      if (roleConfig.description || roleConfig.tools || roleConfig.model) {
        agentMeta[roleName] = {
          description: roleConfig.description || agentMeta[roleName]?.description || `${roleName} agent`,
          tools: roleConfig.tools || agentMeta[roleName]?.tools || "[Bash, Read]",
          model: roleConfig.model || agentMeta[roleName]?.model || "sonnet",
          ...(roleConfig.tiers || agentMeta[roleName]?.tiers
            ? { tiers: roleConfig.tiers || agentMeta[roleName]?.tiers }
            : {}),
        };
      }
    }
  }

  // Discover template files (excludes _shared.md partial)
  const templateFiles = readdirSync(templatesDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("_"));

  for (const templateFile of templateFiles) {
    const agentName = templateFile.replace(".md", "");
    const templatePath = join(templatesDir, templateFile);

    let content = readFileSync(templatePath, "utf-8");
    // Strip any hook-injected frontmatter from template
    content = content.replace(/^---[\s\S]*?---\n*/, "");

    // Apply variable substitution
    content = content.replace(/\$\{PROJECT_IDENTITY\}/g, identitySection);
    content = content.replace(/\$\{SHARED_RULES\}/g, sharedRules);
    content = content.replace(/\$\{SOURCE_DIRS\}/g, dirList);
    content = content.replace(/\$\{CONSUMERS\}/g, consumerNote);
    content = content.replace(/\$\{PROMPT_PREFIX\}/g, scan.promptPrefix);
    content = content.replace(/\$\{DEV_UI_LINE\}/g, devUi ? `- **Dev UI:** ${devUi}` : "- **Dev UI:** not configured — check .claude/rungate.json");
    content = content.replace(/\$\{DEV_API_LINE\}/g, devApi ? `- **Dev API:** ${devApi}` : "- **Dev API:** not configured — check .claude/rungate.json");
    content = content.replace(/\$\{PAGES_TABLE\}/g, pagesTable);
    content = content.replace(/\$\{TEST_CMD\}/g, testCmd);
    content = content.replace(/\$\{TYPE_CHECK\}/g, typeCheck);

    // Prepend frontmatter with agent metadata
    const meta = agentMeta[agentName];
    if (meta) {
      let fm = `---\nname: ${agentName}\ndescription: ${meta.description}\ntools: ${meta.tools}\nmodel: ${meta.model}`;
      if (meta.tiers) {
        fm += `\ntiers:`;
        for (const [tier, sections] of Object.entries(meta.tiers)) {
          fm += `\n  ${tier}: [${sections.map(s => `'${s}'`).join(", ")}]`;
        }
      }
      fm += `\n---\n\n`;
      content = fm + content;
    }

    // Append prompt routing section if available
    const prompts = scan.promptRouting[agentName] || [];
    if (prompts.length > 0) {
      content += `\n## Reference (read when needed)\n\n| Prompt | When to Read |\n|--------|-------------|\n`;
      content += prompts.map(p => `| ${p.file} | ${p.when} |`).join("\n") + "\n";
    }

    result[agentName] = content;
  }

  return result;
}
