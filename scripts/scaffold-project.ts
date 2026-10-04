#!/usr/bin/env bun
/**
 * scaffold-project.ts — Bootstrap any project to scaffold conformity.
 *
 * Usage: bun ~/Projects/rungate/scripts/scaffold-project.ts /path/to/project
 *
 * Orchestrator-only: calls scanner, passes data to generators, writes output.
 * All logic lives in lib/scaffold/steps.ts and lib/validators/spec-validators.ts.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
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
  detectMisplacedSpecs,
  detectUnconvertedSpecs,
} from "../lib/validators/spec-validators";
import type { ProjectType } from "../lib/generators/types";

// ── CLI argument parsing ───────────────────────────────────────

const args = process.argv.slice(2);
const projectPath = args.find(arg => !arg.startsWith('--'));
const typeFlag = args.find(arg => arg.startsWith('--type='))?.split('=')[1] ||
                 (args.indexOf('--type') !== -1 ? args[args.indexOf('--type') + 1] : null);
const fixMode = args.includes('--fix');
const dryRun = args.includes('--dry-run') || !fixMode;

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project [--type code|workflow] [--fix] [--dry-run]");
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
console.log(`Mode: ${fixMode ? "fix" : "dry-run (pass --fix to apply changes)"}`);
console.log("---");

if (dryRun) {
  // ── Dry-run mode: report gaps without modifying anything ──────
  // Check directories
  for (const dir of ["specs", "reference", ".github", ".github/workflows", "scripts", "docs", "docs/adr"]) {
    if (!existsSync(join(projectPath, dir))) {
      actions.push(`GAP: ${dir}/ does not exist`);
    }
  }
  const testDir = existsSync(join(projectPath, "test")) ? "test" : existsSync(join(projectPath, "tests")) ? "tests" : null;
  if (!testDir) actions.push("GAP: test/ or tests/ does not exist");

  // Check AGENTS.md
  if (!existsSync(join(projectPath, "AGENTS.md"))) {
    actions.push("GAP: AGENTS.md does not exist");
  }

  // Check copilot instructions
  if (!existsSync(join(projectPath, ".github", "copilot-instructions.md"))) {
    actions.push("GAP: .github/copilot-instructions.md does not exist");
  }

  // Check conformity test
  const testDirForCheck = testDir || "tests";
  if (!existsSync(join(projectPath, testDirForCheck, "scaffold-conformity.test.ts"))) {
    actions.push(`GAP: ${testDirForCheck}/scaffold-conformity.test.ts does not exist`);
  }

  // Validate specs (report-only, no writes)
  addFrontmatterToSpecs(join(projectPath, "specs"), actions, { fix: false });
  addFrontmatterToAdrs(join(projectPath, "docs", "adr"), actions, { fix: false });
  detectOversizedSpecs(join(projectPath, "specs"), actions);
  checkGovernsAlignment(join(projectPath, "specs"), actions);
  detectMisplacedSpecs(projectPath, actions);
  detectUnconvertedSpecs(join(projectPath, "specs"), actions);

  // Check CODE-MAP.md for code projects
  if (projectType === "code") {
    if (!existsSync(join(projectPath, "CODE-MAP.md"))) {
      actions.push("GAP: CODE-MAP.md does not exist");
    }
  }

  // Check harness config
  if (!existsSync(join(projectPath, ".claude", "rungate.json")) && !existsSync(join(projectPath, ".claude", "rungate", "config.json"))) {
    actions.push("GAP: .claude/rungate.json does not exist");
  }

  // Check CLAUDE.md bridge
  if (!existsSync(join(projectPath, "CLAUDE.md"))) {
    actions.push("GAP: CLAUDE.md does not exist");
  } else {
    const claudeContent = readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
    if (!claudeContent.includes("@AGENTS.md")) {
      actions.push("GAP: CLAUDE.md missing @AGENTS.md bridge");
    }
  }

  // Check .gitignore
  if (!existsSync(join(projectPath, ".gitignore"))) {
    actions.push("GAP: .gitignore does not exist");
  }

  // Check docs-routing rule
  if (!existsSync(join(projectPath, ".claude", "rules", "docs-routing.md"))) {
    actions.push("GAP: .claude/rules/docs-routing.md does not exist");
  }
} else {
  // ── Fix mode: apply all changes ───────────────────────────────

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
  addFrontmatterToSpecs(join(projectPath, "specs"), actions, { fix: true });
  addFrontmatterToAdrs(join(projectPath, "docs", "adr"), actions, { fix: true });
  detectOversizedSpecs(join(projectPath, "specs"), actions);
  checkGovernsAlignment(join(projectPath, "specs"), actions);
  detectMisplacedSpecs(projectPath, actions);
  detectUnconvertedSpecs(join(projectPath, "specs"), actions);

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
}

// ── Report ─────────────────────────────────────────────────────

console.log("\n=== Scaffold Report ===");
for (const action of actions) {
  console.log(`  ${action}`);
}
if (dryRun) {
  const gapCount = actions.filter(a => a.startsWith("GAP")).length;
  const warnCount = actions.filter(a => a.startsWith("WARN")).length;
  console.log(`\nTotal: ${gapCount} gaps, ${warnCount} warnings (pass --fix to apply changes)`);
} else {
  console.log(`\nTotal: ${actions.filter(a => a.startsWith("CREATED")).length} created, ${actions.filter(a => a.startsWith("SKIP")).length} skipped`);
}
