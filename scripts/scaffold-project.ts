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
  refreshScopedRulesStep,
  refreshAgentsMd,
  updateSpecsTable,
  injectEnvironmentSection,
  generateConformityTest,
  generateAgentBriefsStep,
  generateOrAuditProjectHarness,
  generateCodeMapStep,
  copySpecTemplateIfEmpty,
  createGitignore,
  createTsconfig,
  generateProjectState,
  createClaudeMdBridge,
  createCiWorkflows,
  createWorkflowDefinitionSpec,
  createGitHooks,
  deployHooksToConsumers,
  addPaiHarnessDevDep,
  runAuditSpecsFix,
  postScaffoldCommit,
} from "../lib/scaffold/steps";
import {
  addFrontmatterToSpecs, addFrontmatterToAdrs, detectOversizedSpecs,
  checkGovernsAlignment, detectMisplacedSpecs, detectUnconvertedSpecs,
} from "../lib/validators/spec-validators";
import type { ProjectType } from "../lib/generators/types";

// ── CLI argument parsing ───────────────────────────────────────

const args = process.argv.slice(2);
const projectPath = args.find(arg => !arg.startsWith('--'));
const typeFlag = args.find(arg => arg.startsWith('--type='))?.split('=')[1] ||
                 (args.indexOf('--type') !== -1 ? args[args.indexOf('--type') + 1] : null);
const fix = args.includes('--fix');
// #216: both opt-in. --force overwrites consumer content in harness-managed
// workflow files; --commit lets the run write to the consumer's git history.
// Defaulting either to true is how a re-scaffold destroys a consumer's build.
const force = args.includes('--force');
const commit = args.includes('--commit');

if (!projectPath) {
  console.error("Usage: scaffold-project.ts /path/to/project [--type code|workflow] [--fix] [--force] [--commit]");
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
if (!fix) console.log(`Mode: audit (pass --fix to apply changes)`);
console.log("---");

if (fix) {
  // Phase 0: Security and directory setup
  createGitignore(projectPath, actions);
  safeDir(join(projectPath, "specs"), "specs", actions);
  safeDir(join(projectPath, "reference"), "reference", actions);
  safeDir(join(projectPath, ".github"), ".github", actions);
  safeDir(join(projectPath, ".github", "workflows"), ".github/workflows", actions);
  safeDir(join(projectPath, "scripts"), "scripts", actions);
  safeDir(join(projectPath, "docs"), "docs", actions);
  safeDir(join(projectPath, "docs", "adr"), "docs/adr", actions);

  const testDirName = existsSync(join(projectPath, "test")) ? "test" : "tests";
  safeDir(join(projectPath, testDirName), testDirName, actions);

  // Before Phase 0.5 and before createCiWorkflows on purpose (#72): both decide
  // whether to emit a type check by looking for tsconfig.json on disk.
  createTsconfig(projectPath, actions);

  // Phase 0.5: Generate AGENTS.md
  const agentsMd = generateAgentsMdContent(projectPath, projectType, actions);
  writeFileSync(join(projectPath, "AGENTS.md"), agentsMd);
  actions.push("REGENERATED: AGENTS.md");
  refreshAgentsMd(projectPath, projectType, actions);
  updateSpecsTable(join(projectPath, "AGENTS.md"), actions);

  // Phase 0.6: Create copilot instructions
  const copilotInstructions = `# Copilot Instructions\n\nRead [AGENTS.md](../AGENTS.md) for project context, key files, specs, and workflow.\n\nAll project knowledge lives in AGENTS.md. Start there.\n`;
  safeWrite(join(projectPath, ".github", "copilot-instructions.md"), copilotInstructions, ".github/copilot-instructions.md", actions);

  // Phase 0.7: Create conformity test
  const conformityTest = generateConformityTest();
  safeWrite(join(projectPath, testDirName, "scaffold-conformity.test.ts"), conformityTest, `${testDirName}/scaffold-conformity.test.ts`, actions);
}

// Validators always run — only write when --fix is passed
addFrontmatterToSpecs(join(projectPath, "specs"), actions, { fix });
addFrontmatterToAdrs(join(projectPath, "docs", "adr"), actions, { fix });
detectOversizedSpecs(join(projectPath, "specs"), actions);
checkGovernsAlignment(join(projectPath, "specs"), actions);
detectMisplacedSpecs(projectPath, actions);
detectUnconvertedSpecs(join(projectPath, "specs"), actions);

if (fix) {
  // Phase 0.8: Workflow project setup
  if (projectType === "workflow") createWorkflowDefinitionSpec(projectPath, actions);

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
  createCiWorkflows(projectPath, actions, { force });
  createGitHooks(projectPath, actions);
  deployHooksToConsumers(projectPath, actions);

  // Phase 3.5: steps that DESCRIBE the project run last, so they describe the tree this run left (#123).
  refreshScopedRulesStep(projectPath, projectType, actions);
  if (projectType === "code") {
    generateCodeMapStep(projectPath, actions);
  }

  postScaffoldCommit(projectPath, actions, { commit });
} else {
  // Dry-run: report gaps for items that --fix would generate
  if (projectType === "code" && !existsSync(join(projectPath, "CODE-MAP.md"))) {
    actions.push("GAP: CODE-MAP.md missing — run with --fix to generate");
  }
  if (!existsSync(join(projectPath, ".claude", "rules", "docs-routing.md"))) {
    actions.push("GAP: .claude/rules/docs-routing.md missing — run with --fix to generate");
  }
  if (!existsSync(join(projectPath, "AGENTS.md"))) {
    actions.push("GAP: AGENTS.md missing — run with --fix to generate");
  }
  if (!existsSync(join(projectPath, "specs"))) {
    actions.push("GAP: specs/ directory missing — run with --fix to create");
  }
}

// ── Report ─────────────────────────────────────────────────────

console.log("\n=== Scaffold Report ===");
for (const action of actions) {
  console.log(`  ${action}`);
}
const count = (verb: string) => actions.filter(a => a.startsWith(verb)).length;
console.log(`\nTotal: ${count("CREATED")} created, ${count("SKIP")} skipped, ${count("REPLACED")} replaced, ${count("REFUSED")} refused`);
// A refusal means a consumer's file was NOT written over. Exiting 0 would make
// that indistinguishable from a clean run in CI, which is how a preserved file
// turns into a silently stale one (#216).
if (count("REFUSED") > 0) process.exit(2);
