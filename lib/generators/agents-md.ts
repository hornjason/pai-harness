/**
 * AGENTS.md generator — produces lean AGENTS.md (<100 lines) from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2).
 * Reference tables moved to .claude/rules/ per context-management research:
 * - Sigmoid collapse at 16+ rules (arXiv 2608.02639)
 * - Osmani test: delete anything the agent can find by reading code
 * - Three-tier: hot (<100 lines), specialist (scoped rules), cold (on-demand)
 */
import type { ProjectScan } from "./types";

export interface GeneratedRule {
  filename: string;
  content: string;
}

export function generateAgentsMd(scan: ProjectScan): string {
  const {
    name,
    identity,
    techStack,
    repoUrl,
    testCmd,
    keyFiles,
    hasCodeMap,
    consumers,
    makeTargets,
  } = scan;

  const techLine = techStack.length > 0 ? `\n**Tech:** ${techStack.join(", ")}` : "";
  const repoLine = repoUrl ? `- **Repo:** ${repoUrl}` : "<!-- TODO: Add repo URL -->";

  const consumerSection = consumers.length > 0
    ? `\n## Consumers (${consumers.length})\n\n${consumers.map(c => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.`
    : "";

  return `# ${name}

## Project Identity

${identity}${techLine}
${repoLine}

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (\`${testCmd}\`) and show real output — no summaries, no skipped files
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Commands

| Action | Command |
|--------|---------|
| Test | \`${testCmd}\` |
| Type check | \`bunx tsc --noEmit\` |
| Conformity | \`bun test test/scaffold-conformity.test.ts\` |
| Create spec | \`bunx rungate create-spec "title"\` |
| Create SC | \`bunx rungate create-sc --pattern <name> --params '<json>'\` |
| Re-scaffold | \`bun ~/Projects/rungate/scripts/scaffold-project.ts .\` |
${consumerSection}

## Workflow
${repoLine}${makeTargets}
- **Test:** \`${testCmd}\`
`;
}

export function generateScopedRules(scan: ProjectScan): GeneratedRule[] {
  const {
    keyFiles,
    specs,
    testFiles,
    docRouting,
    categories,
    refFiles,
    hasCodeMap,
    testCmd,
  } = scan;

  const rules: GeneratedRule[] = [];

  const codeMapRef = hasCodeMap
    ? "\n| `CODE-MAP.md` | Auto-generated codebase map | Understanding codebase structure |"
    : "";
  const keyFilesTable = keyFiles.map(kf => `| ${kf.file} | ${kf.what} | ${kf.when} |`).join("\n");
  rules.push({
    filename: "key-files.md",
    content: `---
description: Key files and documentation routing for this project
---

## Key Files

| File | What | When to Read |
|------|------|--------------|
${keyFilesTable}
${codeMapRef}
`,
  });

  rules.push({
    filename: "agent-principles.md",
    content: `---
description: Shared behavioral principles for all agents working in this project
---

## Core Principles

- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap

## Never Do

- Self-attest evidence (tier F)
- Skip ACs without rationale
- Commit secrets or credentials
- Spawn subagents for single-file tasks — do the work directly
`,
  });

  if (specs.length > 0) {
    const specsTable = specs.map(s => `| ${s.file} | ${s.governs} | ${s.testable} |`).join("\n");
    rules.push({
      filename: "specs-routing.md",
      content: `---
description: Read the governing spec BEFORE making changes in spec-governed areas
paths:
  - "specs/**"
  - "lib/**"
  - "gates/**"
  - "hooks/**"
  - "scripts/**"
---

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
${specsTable}
`,
    });
  }

  if (docRouting.length > 0) {
    const docRoutingTable = docRouting.map(d => `| ${d.need} | \`${d.file}\` |`).join("\n");
    const createRows = categories.map(c => {
      const label = c.label.split(" — ")[0];
      return `| ${label} | \`${c.dir}/\` | ${c.frontmatter} | ${c.notes} |`;
    });
    createRows.push("| Source code | `src/` | — | Follow existing module structure |");
    createRows.push("| Tests | `test/` | — | Mirror source structure |");
    rules.push({
      filename: "docs-routing.md",
      content: `---
description: Documentation routing and file creation conventions
---

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
${docRoutingTable}

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
${createRows.join("\n")}
`,
    });
  }

  rules.push({
    filename: "harness-managed.md",
    content: `---
description: Files managed by rungate scaffold — do not edit directly
paths:
  - ".github/workflows/**"
  - ".claude/agents/**"
  - "CODE-MAP.md"
  - "test/scaffold-conformity.test.ts"
---

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| \`.github/workflows/ci.yml\` | Set \`ci\` fields in \`.claude/rungate.json\` | Don't edit the YAML |
| \`.github/workflows/gates.yml\` | Settings from \`.claude/rungate.json\` | Don't edit the YAML |
| \`.claude/agents/*.md\` | Settings from \`.claude/rungate.json\` | Don't edit briefs |
| \`test/scaffold-conformity.test.ts\` | Runs automatically | Don't edit |
| \`CODE-MAP.md\` | Auto-generated from code scan | Don't edit |
`,
  });

  return rules;
}
