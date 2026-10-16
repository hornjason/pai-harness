/**
 * Every step that writes, as one callable body (#398).
 *
 * This used to be the inside of `if (fix) { … }` in
 * `scripts/scaffold-project.ts`, with a four-`existsSync` `else` standing in
 * for it during an audit. Those two branches shared no code, so they could
 * only agree by somebody keeping them in step, and the measured disagreement
 * was 28 paths to 0.
 *
 * Pulling the body out here is what lets audit RUN it against a clone instead
 * of predicting it — see `lib/scaffold/rehearsal.ts`. Nothing about the
 * ordering changed in the move, including the two comments that explain why
 * particular steps sit where they do (#72, #123); they are load-bearing and
 * are carried verbatim.
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import {
  safeDir,
  safeWrite,
  regenerateOwned,
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
  seedSuccessDoc,
  createCiWorkflows,
  createGitHooks,
  deployHooksToConsumers,
  addPaiHarnessDevDep,
  reportExternalAdoptionStep,
  runAuditSpecsFix,
  postScaffoldCommit,
} from "./steps";
import {
  addFrontmatterToSpecs, addFrontmatterToAdrs, detectOversizedSpecs,
  checkGovernsAlignment, detectMisplacedSpecs, detectUnconvertedSpecs,
} from "../validators/spec-validators";
import type { ProjectType } from "../generators/types";
import { DEFAULT_PROFILE, isStepIncluded, type ScaffoldProfile } from "./profiles";

export interface WriteStepOptions {
  force?: boolean;
  commit?: boolean;
  /**
   * True when running against a disposable clone. The two steps that reach
   * outside the tree are skipped — see `STEPS_NOT_REHEARSED` in
   * `./rehearsal.ts`, which carries the reason for each.
   */
  rehearsing?: boolean;
  /**
   * How much of the harness this project opted into. Orthogonal to
   * `projectType`, which selects WHICH generators run; this selects whether
   * the harness-only ones run at all. See `STEPS_NOT_MINIMAL` in
   * `./profiles.ts`, which carries the reason for each exclusion.
   */
  profile?: ScaffoldProfile;
  /**
   * Opt OUT of the mechanical fixes (#42 SC-4). Default on, because a
   * re-scaffold that reports a gap it could have closed is a worse onboarding
   * than one that closes it.
   */
  autoFix?: boolean;
  /**
   * Opt IN to removing consumers the source scan did not find (#42 SC-2).
   *
   * Deliberately NOT covered by `autoFix`'s opt-out default — see
   * `pruneStaleConsumers`. Adding a frontmatter line and deleting a config
   * entry are not in the same risk class, and one flag governing both would
   * make the safe default impossible to express.
   */
  pruneConsumers?: boolean;
}

export function runScaffoldWriteSteps(
  projectPath: string,
  projectType: ProjectType,
  actions: string[],
  opts: WriteStepOptions = {},
): void {
  const { force = false, commit = false, rehearsing = false, profile = DEFAULT_PROFILE, autoFix = true, pruneConsumers = false } = opts;

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
  const agentsMd = generateAgentsMdContent(projectPath, projectType, actions, profile);
  writeFileSync(join(projectPath, "AGENTS.md"), agentsMd);
  actions.push("REGENERATED: AGENTS.md");
  refreshAgentsMd(projectPath, projectType, actions);
  updateSpecsTable(join(projectPath, "AGENTS.md"), actions);

  // Phase 0.6: Create copilot instructions
  const copilotInstructions = `# Copilot Instructions\n\nRead [AGENTS.md](../AGENTS.md) for project context, key files, specs, and workflow.\n\nAll project knowledge lives in AGENTS.md. Start there.\n`;
  safeWrite(join(projectPath, ".github", "copilot-instructions.md"), copilotInstructions, ".github/copilot-instructions.md", actions);

  // Phase 0.7: regenerate the conformity test. Strategy passed, not looked up — the label carries the project's own test dir, which may not be `test/` (#208).
  regenerateOwned(join(projectPath, testDirName, "scaffold-conformity.test.ts"), generateConformityTest(projectPath), `${testDirName}/scaffold-conformity.test.ts`, actions, "regenerate");

  // Validators. These used to run outside the `if (fix)` block with a `{ fix }`
  // flag, which is why `addFrontmatterToSpecs` is the one step audit ever
  // reported anything from.
  if (autoFix) {
    addFrontmatterToSpecs(join(projectPath, "specs"), actions);
    addFrontmatterToAdrs(join(projectPath, "docs", "adr"), actions);
  } else {
    // Named, not silent. A run that declined to fix and said nothing is
    // indistinguishable from one that had nothing to fix (#208, SC-819).
    actions.push("SKIP: auto-fix of spec and ADR frontmatter (--no-auto-fix)");
  }
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

  // Phase 1.5: Harness config + briefs. Harness-only under `minimal` — see
  // STEPS_NOT_MINIMAL for why each is excluded.
  if (isStepIncluded("generateOrAuditProjectHarness", profile)) {
    generateOrAuditProjectHarness(projectPath, actions, { pruneConsumers });
  }
  injectEnvironmentSection(projectPath, actions);
  if (isStepIncluded("generateAgentBriefsStep", profile)) {
    generateAgentBriefsStep(projectPath, actions);
  }

  // Phase 3: Final setup
  copySpecTemplateIfEmpty(join(projectPath, "specs"), actions);
  generateProjectState(projectPath, actions);
  // Both profiles. #485 is about the file existing at all, and `minimal` is
  // the profile the consumer that found the gap was scaffolded with.
  seedSuccessDoc(projectPath, actions);
  runAuditSpecsFix(projectPath, actions);
  addPaiHarnessDevDep(projectPath, actions);
  createClaudeMdBridge(projectPath, actions);
  // See STEPS_NOT_MINIMAL.
  if (isStepIncluded("createCiWorkflows", profile)) {
    createCiWorkflows(projectPath, actions, { force });
  }
  createGitHooks(projectPath, actions);

  // Leaves the tree. See STEPS_NOT_REHEARSED.
  if (!rehearsing) deployHooksToConsumers(projectPath, actions);

  // Phase 3.5: steps that DESCRIBE the project run last, so they describe the tree this run left (#123).
  reportExternalAdoptionStep(projectPath, actions);
  refreshScopedRulesStep(projectPath, projectType, actions, profile);
  if (projectType === "code") {
    generateCodeMapStep(projectPath, actions);
  }

  // Leaves the tree. See STEPS_NOT_REHEARSED.
  if (!rehearsing) postScaffoldCommit(projectPath, actions, { commit });
}
