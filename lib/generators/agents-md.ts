/**
 * AGENTS.md generator — produces AGENTS.md content from ProjectScan data.
 *
 * Extracted from scaffold-project.ts per SCAFFOLD-DECOMPOSITION-SPEC (D-2).
 * Takes scan data in, produces file content out. No file I/O.
 */
import type { ProjectScan } from "./types";

export function generateAgentsMd(scan: ProjectScan): string {
  const {
    name,
    identity,
    techStack,
    repoUrl,
    testCmd,
    keyFiles,
    specs,
    testFiles,
    refFiles,
    docRouting,
    categories,
    consumers,
    hasCodeMap,
    makeTargets,
  } = scan;

  const techLine = techStack.length > 0 ? `\n**Tech:** ${techStack.join(", ")}` : "";
  const repoLine = repoUrl ? `- **Repo:** ${repoUrl}` : "<!-- TODO: Add repo URL -->";

  // Key files table
  const codeMapRef = hasCodeMap
    ? "\n| `CODE-MAP.md` | Auto-generated codebase map (routes, components, modules, health) | Understanding codebase structure |"
    : "";
  const keyFilesTable = keyFiles.map(kf => `| ${kf.file} | ${kf.what} | ${kf.when} |`).join("\n");

  // Specs table
  const specsTable = specs.length > 0
    ? specs.map(s => `| ${s.file} | ${s.governs} | ${s.testable} |`).join("\n")
    : "| (no specs found) | | |";

  // Test files table
  const testsTable = testFiles.length > 0
    ? testFiles.map(t => `| ${t.label} | ${t.file} | Auto-detected |`).join("\n")
    : "| scaffold conformity | scaffold-conformity.test.ts | Structure validation |";

  // Doc routing table
  const docRoutingTable = docRouting.length > 0
    ? docRouting.map(d => `| ${d.need} | \`${d.file}\` |`).join("\n")
    : "| (no docs found) | |";

  // Where to create table
  const createRows = categories.map(c => {
    const label = c.label.split(" — ")[0];
    return `| ${label} | \`${c.dir}/\` | ${c.frontmatter} | ${c.notes} |`;
  });
  createRows.push("| Source code | `src/` | — | Follow existing module structure |");
  createRows.push("| Tests | `test/` | — | Mirror source structure |");
  const createTable = createRows.join("\n");

  // Consumer section
  const consumerSection = consumers.length > 0
    ? `## Consumers (${consumers.length})\n\n${consumers.map(c => `- ${c}`).join("\n")}\n\nCheck cascade impact when modifying shared modules.`
    : "";

  // Reference section
  const refTable = refFiles.map(r => `| ${r.file} | ${r.what} |`).join("\n");
  const refSection = refFiles.length > 0
    ? `\n## Reference Files\n\nHistorical and inactive docs live in \`reference/\`.\n\n| File | What |\n|------|------|\n${refTable}\n`
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
- Read docs before writing code — routing table shows where
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Key Files

| File | What | When to Read |
|------|------|--------------|
${keyFilesTable}
${codeMapRef}

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
${docRoutingTable}

## Where to Create Things

| Type | Location | Frontmatter | Notes |
|------|----------|-------------|-------|
${createTable}

## Specs

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
${specsTable}

## Tests

\`\`\`bash
${testCmd}
\`\`\`

| Category | File | What |
|----------|------|------|
${testsTable}

## Commands

| Action | Command |
|--------|---------|
| Install | \`bun install\` |
| Test | \`${testCmd}\` |
| Type check | \`bunx tsc --noEmit\` |
| Conformity | \`bun test test/scaffold-conformity.test.ts\` |
| Sync spec tests | \`bunx rungate sync-tests .\` |
| Create spec | \`bunx rungate create-spec "title"\` |
| Create ADR | \`bunx rungate create-adr "title"\` |
| Create SC | \`bunx rungate create-sc --pattern <name> --params '<json>'\` |
| Extract constraints | \`bunx rungate extract-constraints .\` |
| Check findings | \`cat .rungate/conformity-findings.json\` — structured findings with fix commands |
| Re-scaffold | \`bun ~/Projects/rungate/scripts/scaffold-project.ts .\` |

${consumerSection}

## Workflow
${repoLine}${makeTargets}
- **Test:** \`${testCmd}\`
- **Conformity:** Imported from rungate. \`bun update rungate && bun test\` to sync.

## Harness-Managed Files

These files are managed by rungate and regenerated on re-scaffold. **Do not edit them directly.**

| File | How to customize | What NOT to do |
|------|-----------------|----------------|
| \`.github/workflows/ci.yml\` | Set \`ci\` fields in \`.claude/rungate.json\` | Don't edit the YAML |
| \`.github/workflows/gates.yml\` | Settings from \`.claude/rungate.json\` | Don't edit the YAML |
| \`.claude/agents/*.md\` | Settings from \`.claude/rungate.json\` | Don't edit briefs |
| \`test/scaffold-conformity.test.ts\` | Runs automatically | Don't edit |
| \`CODE-MAP.md\` | Auto-generated from code scan | Don't edit |
${refSection}`;
}
