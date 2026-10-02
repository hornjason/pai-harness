#!/usr/bin/env bun
/**
 * scaffold-project.ts — Bootstrap any project to scaffold conformity.
 *
 * Usage: bun ~/Projects/rungate/scripts/scaffold-project.ts /path/to/project
 *
 * Orchestrator-only: calls scanner, passes data to generators, writes output.
 * All logic lives in lib/scaffold/steps.ts and lib/validators/spec-validators.ts.
 */
import { existsSync, statSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { detectProjectType } from "../lib/scanner";
import {
  safeDir,
  safeWrite,
  generateAgentsMdContent,
  refreshAgentsMd,
  updateSpecsTable,
  injectEnvironmentSection,
  generateConformityTest,
  generateAgentBriefsStep,
  generateOrAuditProjectHarness,
  generateCodeMapStep,
  copySpecTemplateIfEmpty,
  createGitignore,
  generateProjectState,
  createClaudeMdBridge,
  createCiWorkflows,
  createGitHooks,
  deployHooksToConsumers,
  addPaiHarnessDevDep,
  runAuditSpecsFix,
  postScaffoldCommit,
} from "../lib/scaffold/steps";
import {
  addFrontmatterToSpecs,
  addFrontmatterToAdrs,
  detectOversizedSpecs,
  checkGovernsAlignment,
} from "../lib/validators/spec-validators";
import type { ProjectType } from "../lib/generators/types";

// ── CLI argument parsing ───────────────────────────────────────

const args = process.argv.slice(2);
const projectPath = args.find(arg => !arg.startsWith('--'));
const typeFlag = args.find(arg => arg.startsWith('--type='))?.split('=')[1] ||
                 (args.indexOf('--type') !== -1 ? args[args.indexOf('--type') + 1] : null);

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project [--type code|workflow]");
  process.exit(1);
}

if (!existsSync(projectPath)) {
  console.error(`ERROR: Path does not exist: ${projectPath}`);
  process.exit(1);
}

if (!statSync(projectPath).isDirectory()) {
  console.error(`ERROR: Not a directory: ${projectPath}`);
  process.exit(1);
}

if (typeFlag && !['code', 'content', 'infra', 'workflow'].includes(typeFlag)) {
  console.error(`ERROR: Invalid --type value: ${typeFlag}`);
  console.error(`Valid values: code, content, infra, workflow`);
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────

const actions: string[] = [];
const projectType: ProjectType = (typeFlag as ProjectType) || detectProjectType(projectPath);
const projectName = basename(projectPath);

console.log(`Detected project type: ${projectType}`);
console.log(`Project: ${projectName}`);
console.log(`Path: ${projectPath}`);
console.log("---");

// Phase 0: Security and directory setup
createGitignore(projectPath, actions);
safeDir(join(projectPath, "specs"), "specs", actions);
safeDir(join(projectPath, "reference"), "reference", actions);
safeDir(join(projectPath, ".github"), ".github", actions);
safeDir(join(projectPath, ".github", "workflows"), ".github/workflows", actions);
safeDir(join(projectPath, "scripts"), "scripts", actions);
safeDir(join(projectPath, "docs"), "docs", actions);
safeDir(join(projectPath, "docs", "adr"), "docs/adr", actions);

const existingTestDir = existsSync(join(projectPath, "test")) ? "test" : null;
const testDirName = existingTestDir || "tests";
safeDir(join(projectPath, testDirName), testDirName, actions);

// Phase 0.5: Generate AGENTS.md
const agentsMd = generateAgentsMdContent(projectPath, projectType, actions);
writeFileSync(join(projectPath, "AGENTS.md"), agentsMd);
actions.push("REGENERATED: AGENTS.md");
refreshAgentsMd(projectPath, projectType, actions);
updateSpecsTable(join(projectPath, "AGENTS.md"), actions);

// Phase 0.6: Create copilot instructions
const copilotInstructions = `# Copilot Instructions\n\nRead [AGENTS.md](../AGENTS.md) for project context, key files, specs, and workflow.\n\nAll project knowledge lives in AGENTS.md. Start there.\n`;
safeWrite(join(projectPath, ".github", "copilot-instructions.md"), copilotInstructions, ".github/copilot-instructions.md", actions);

// Phase 0.7: Create conformity test + validate specs
const conformityTest = generateConformityTest();
safeWrite(join(projectPath, testDirName, "scaffold-conformity.test.ts"), conformityTest, `${testDirName}/scaffold-conformity.test.ts`, actions);
addFrontmatterToSpecs(join(projectPath, "specs"), actions);
addFrontmatterToAdrs(join(projectPath, "docs", "adr"), actions);
detectOversizedSpecs(join(projectPath, "specs"), actions);
checkGovernsAlignment(join(projectPath, "specs"), actions);

// Phase 0.8: Workflow project setup
if (projectType === "workflow") {
  const workflowDef = `---
doc-type: spec
testable: no
governs: workflow-definition
---

# Workflow Definition

## Trigger

When should this workflow run?

## Inputs

What inputs does this workflow require?

## Process

What steps does this workflow perform?

## Output

What does this workflow produce?
`;
  safeWrite(join(projectPath, "specs", "WORKFLOW-DEFINITION.md"), workflowDef, "specs/WORKFLOW-DEFINITION.md", actions);
}

// Phase 1: Code-specific generation
if (projectType === "code") {
  generateCodeMapStep(projectPath, actions);
}

// Phase 1.5: Harness config + briefs for ALL project types
generateOrAuditProjectHarness(projectPath, actions);
injectEnvironmentSection(projectPath, actions);
generateAgentBriefsStep(projectPath, actions);

// Phase 3: Final setup
copySpecTemplateIfEmpty(join(projectPath, "specs"), actions);
generateProjectState(projectPath, actions);
runAuditSpecsFix(projectPath, actions);
addPaiHarnessDevDep(projectPath, actions);
createClaudeMdBridge(projectPath, actions);
createCiWorkflows(projectPath, actions);
createGitHooks(projectPath, actions);
deployHooksToConsumers(projectPath, actions);
postScaffoldCommit(projectPath, actions);

// ── Report ─────────────────────────────────────────────────────

console.log("\n=== Scaffold Report ===");
for (const action of actions) {
  console.log(`  ${action}`);
}
console.log(`\nTotal: ${actions.filter(a => a.startsWith("CREATED")).length} created, ${actions.filter(a => a.startsWith("SKIP")).length} skipped`);
