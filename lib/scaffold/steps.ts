/**
 * scaffold/steps.ts — All scaffold step functions extracted from scaffold-project.ts.
 *
 * Each function takes a project root path and an actions array for reporting.
 * Pure side-effect functions: read from disk, write to disk, push to actions.
 *
 * Extracted per SCAFFOLD-DECOMPOSITION-SPEC to keep scaffold-project.ts
 * as orchestrator-only (under 200 lines).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { readdirSorted } from "../readdir-sorted";
import { fileExtensions } from "../file-extensions";
import { join, basename, dirname, resolve, sep } from "path";
import { auditSpecs } from "../../scripts/audit-specs";
import { mayWrite, readDerivedDeclaration, skipLine } from "../derived-spec";
import { generateAgentsMd as buildAgentsMdContent, generateScopedRules } from "../generators/agents-md";
import { HARNESS_PACKAGE, isHarnessItself } from "../harness-identity";
import { scanSpecs } from "../scanner";
import { projectStateDerivation, projectStateKeyFileNote } from "../project-state-derivation";
import { generateAgentBriefs as buildAgentBriefsContent } from "../generators/agent-briefs";
import { generateCodeMap as buildCodeMapContent } from "../generators/code-map";
import { buildAgentMeta, DEFAULT_AGENT_META } from "../create-brief";
import { buildDefaultRoles, buildDefaultHooks } from "./defaults";
import {
  mergeManagedWorkflowRecording,
  duplicateTopLevelKeys,
  managedPreamble,
  MANAGED_BANNER_PREFIX,
  movedTopLevelKeys,
  WORKFLOW_OVERRIDE_COMMENT,
  workflowOverrides,
  type ComputedSubKeys,
  type MergeProvenance,
  type MovedKey,
  type RevokedSubKey,
} from "./managed-workflow";
import { PRE_PUSH_MANAGED_MARKER, prePushHookScript } from "./pre-push-hook";
import {
  AI_REVIEW_JOB,
  AI_REVIEW_PULL_REQUEST_TYPES,
  aiReviewScaffoldAction,
  buildAuthDetectStep,
  buildOutcomesHeader,
  buildReviewRunStep,
  vertexCiConfig,
} from "./ai-review-step";
import {
  AI_REVIEW_WORKFLOW_NAME,
  buildAiReviewUnmeasuredWorkflow,
} from "./ai-review-unmeasured-workflow";
import { CI_SUITE_FETCH_DEPTH, baseRefFetchDepth } from "../ci-history-depth";
import { CLAUDE_CODE_ACTION } from "../claude-code-action";
import { GOOGLE_AUTH_ACTION } from "../google-auth-action";
import { loadComplianceConfig, tryLoadRungateConfig } from "../config-loader";
import { organizeProjectReport } from "../organize";
import type { ProjectScan, ProjectType, SpecEntry, TestFile, RefFile, DocRoute, Category } from "../generators/types";
import {
  TIER2_ALLOWED_VALUE_ERE,
  TIER2_GREP_CASE_FLAG,
  TIER3_ALLOWED_VALUE_ERE,
  tier1Ere,
  tier2Ere,
  tier3Ere,
} from "../secret-patterns";
import { healthPathIn } from "../liveness-contradiction";
import { localCalendarDay } from "../local-calendar-day";
import { decideRuleWrite } from "../rule-provenance";
import { actionRef } from "../workflow-actions";
import { ciSetupStep } from "../ci-setup-step";
import { DEFAULT_PROFILE, isRuleIncluded, type ScaffoldProfile } from "./profiles";
import { referencedPaths } from "../agents-md-refs";
import { scanDocsDirectory } from "../doc-routing";
import { inferredTestCommand, testCommandDecision } from "../test-command";
import { declaredBunVersion, setupBunWith } from "../bun-version";
import { codeMapUnreferenced, unlistedSpecs } from "../spec-listing";
import { censusReport, stampWorkflow, workflowBody, workflowCensus } from "./workflow-census";
import {
  readSuccessDoc,
  readSuccessTemplate,
  seedFromTemplate,
  successViolations,
  TEMPLATE_MISSING,
} from "../success-doc";
import { TS_SOURCE_DIRS, typeScriptSourceDirs, typecheckDecision } from "../typescript-project";
import {
  SCAFFOLD_REFUSE,
  decideOwnedWrite,
  ownedFileFor,
  type WriteStrategy,
} from "./owned-files";
import type { SectionSpec } from "../agents-md-sections";
import { executedHookPath, hookRegistrationPath } from "../hook-trees";

/**
 * Look for a declared health route in the places a server declares one.
 *
 * Bounded deliberately: a handful of conventional entry points, read once
 * each. A recursive scan of the whole tree would find more and would also
 * find the word "health" in a test fixture, and a detector that reports a
 * fixture's route as the server's is worse than one that reports null —
 * null is honest, a wrong path is a DOWN verdict on a healthy server.
 */
function detectHealthPath(root: string): string | null {
  const candidates = [
    "src/server.ts", "src/server.js", "src/index.ts", "src/index.js",
    "src/app.ts", "src/app.js", "src/api.ts", "src/routes.ts",
    "server.ts", "server.js", "index.ts", "app.ts",
  ];
  for (const rel of candidates) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const found = healthPathIn(readFileSync(abs, "utf-8"));
    if (found) return found;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Seed a file once. The content afterwards belongs to someone else.
 *
 * This is `create-only` in `OWNED_FILES` terms, and it is correct for
 * `project-state.json` and `PROJECT-STATE.md` (DA-owned, #296) and for the
 * two files the harness seeds but does not claim.
 *
 * It was ALSO being used for `test/scaffold-conformity.test.ts`, which
 * `.claude/rules/harness-managed.md` claims is "regenerated on re-scaffold"
 * (#208). It was not: it was skipped forever, and the run said
 * `SKIP (already exists)`, which reads exactly like "already current". That
 * call site now uses `regenerateOwned`.
 *
 * The wording changed with it. "SKIP … already exists" describes the check
 * that was performed; "seeded once" describes the policy, and a reader of
 * the log can tell that apart from "looked and found no difference".
 *
 * **It delegates rather than reimplementing, and that is load-bearing.** The
 * first draft read the decision and then branched on `action !== "create"`,
 * which is equivalent for every input `create-only` can produce today — and
 * exactly because it is equivalent, it ABSORBED a mutation: deleting the
 * `create-only` branch from `decideOwnedWrite` made every seeded file fall
 * through to the regenerate path, and `safeWrite` reported `UNCHANGED` and
 * declined to write anyway. Nothing went red. The #296 protection was
 * asserted in the declaration and enforced in a second place, so mutating
 * the declaration proved nothing. One writer, one decider.
 */
export function safeWrite(filePath: string, content: string, label: string, actions: string[]): void {
  regenerateOwned(filePath, content, label, actions, "create-only");
}

/**
 * Write a file the harness OWNS, and report what actually changed.
 *
 * The difference from `safeWrite` is the whole of #208: this one writes
 * every run, compares bytes, and reports `UNCHANGED` only after looking.
 * `0 changed` becomes a measurement rather than the absence of an attempt.
 *
 * `strategy` comes from `OWNED_FILES`, which is the declaration the doc
 * table is reconciled against — so a file cannot be claimed as managed in
 * prose while being written by a helper that skips it.
 */
export function ownedStrategy(label: string): WriteStrategy {
  // An unlisted file is regenerated. The direction this is allowed to be
  // wrong in: a file nobody declared gets rewritten with the generator's
  // own output, which is recoverable. Defaulting to create-only would make
  // forgetting to declare a file look exactly like #208.
  return ownedFileFor(label)?.strategy ?? "regenerate";
}

/**
 * Which section of this label carries forward, from the declaration (#655).
 *
 * `undefined` for every strategy that preserves nothing, and for a
 * `section-preserving` row that forgot to declare one — which
 * `test/scaffold-ownership.test.ts` refuses, because reading it here would
 * make the omission resolve to AGENTS.md's heading and look deliberate.
 */
export function ownedSections(label: string): SectionSpec | undefined {
  return ownedFileFor(label)?.sections;
}

export function regenerateOwned(
  filePath: string,
  content: string,
  label: string,
  actions: string[],
  strategy: WriteStrategy = ownedStrategy(label),
): void {
  // `lstatSync`, NOT `existsSync` — BUG-440-A's shape, found by security
  // review of #502 and PRE-EXISTING: it reaches `project-state.json` and
  // every other owned file, not just the one that surfaced it.
  //
  // `existsSync` RESOLVES a symlink and `writeFileSync` FOLLOWS one, so the
  // two disagree about exactly one input: a dangling `SUCCESS.md ->
  // /elsewhere/x` is "absent" to the guard and a live write target to the
  // writer. Measured: the scaffold created `/tmp/dang/victim/newfile.json`
  // from a symlink planted at `project-state.json`, outside the project root
  // entirely, and reported `CREATED: project-state.json`.
  //
  // `lstatSync` describes the LINK, so a symlink of either kind is something
  // that is already there — which is what create-only means by "exists", and
  // what the regenerate strategies must refuse rather than write through.
  let link: ReturnType<typeof lstatSync> | null = null;
  try {
    link = lstatSync(filePath);
  } catch {
    link = null;
  }
  if (link?.isSymbolicLink()) {
    actions.push(
      `${SCAFFOLD_REFUSE}: ${label} is a symlink, and the generator does not write through ` +
        `one — the target may be outside this project. Replace it with a real file, or ` +
        `delete it and re-run.`,
    );
    return;
  }
  if (link && !link.isFile()) {
    // A directory (or a device, or a socket) where an owned file belongs.
    // `readFileSync` throws EISDIR, and that throw ESCAPES the step and
    // aborts the whole scaffold run mid-way — after some files are written
    // and before others. A refusal that names the path leaves the tree in a
    // state someone can reason about; a half-finished run does not.
    actions.push(
      `${SCAFFOLD_REFUSE}: ${label} exists but is not a regular file, so the generator ` +
        `will not read or replace it. Remove it and re-run.`,
    );
    return;
  }
  const existing = link ? readFileSync(filePath, "utf-8") : null;
  const decision = decideOwnedWrite(strategy, existing, content, ownedSections(label));

  if (decision.action === "preserve") {
    actions.push(
      `${SCAFFOLD_REFUSE}: ${label} (${decision.reason}) — generator output withheld; ` +
        `delete the file and re-run to accept it`,
    );
    return;
  }
  if (decision.action === "refuse") {
    // Not the same thing as `preserve`, and the advice is the opposite:
    // `preserve` means the file on disk is yours and the generator stood
    // down, so deleting it accepts the generator. This means the generator
    // cannot produce an output that keeps a promise the spec makes, and
    // deleting the file would destroy exactly the content at issue.
    actions.push(`${SCAFFOLD_REFUSE}: ${label} not written — ${decision.reason}`);
    return;
  }
  if (decision.action === "unchanged") {
    actions.push(`UNCHANGED: ${label} (${decision.reason})`);
    return;
  }

  // `dirname`, not a hand-rolled slice (#481). `substring(0, lastIndexOf("/"))`
  // is correct for every path carrying a separator and silently wrong for the
  // one that does not: `lastIndexOf` returns -1, `substring` CLAMPS a negative
  // end to zero, and the directory to create becomes `""` — which does not
  // exist, so the guard admits it, and `mkdirSync("")` throws ENOENT. Every
  // repo-root owned file hits that under a relative root, which is the form
  // the harness documents.
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, decision.content!);
  actions.push(`${decision.action === "create" ? "CREATED" : "CHANGED"}: ${label}`);
}

export function safeDir(dirPath: string, label: string, actions: string[]): void {
  if (existsSync(dirPath)) {
    actions.push(`SKIP: ${label}/ (already exists)`);
    return;
  }
  mkdirSync(dirPath, { recursive: true });
  actions.push(`CREATED: ${label}/`);
}

function loadHarnessConfig(root: string): any {
  const dirConfig = join(root, ".claude", "rungate", "config.json");
  if (existsSync(dirConfig)) {
    try {
      const config = JSON.parse(readFileSync(dirConfig, "utf-8"));
      // The split moved roles out of config.json into roles.json. Callers
      // (buildAgentMeta) still read `.roles` off one object, so re-attach it
      // here — otherwise every project on the directory layout silently falls
      // back to DEFAULT_AGENT_META and its role config is ignored.
      const rolesPath = join(root, ".claude", "rungate", "roles.json");
      if (existsSync(rolesPath)) {
        try {
          const roles = JSON.parse(readFileSync(rolesPath, "utf-8"));
          if (roles && typeof roles === "object" && !Array.isArray(roles)) {
            config.roles = { ...(config.roles || {}), ...roles };
          }
        } catch {}
      }
      return config;
    } catch {}
  }
  const p = join(root, ".claude", "rungate.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

// ── AGENTS.md generation and updates ───────────────────────────

export function injectEnvironmentSection(root: string, actions: string[]): void {
  const agentsMdPath = join(root, "AGENTS.md");
  if (!existsSync(agentsMdPath)) return;

  let harness: any;
  const dirConfig = join(root, ".claude", "rungate", "config.json");
  const harnessPath = join(root, ".claude", "rungate.json");
  if (existsSync(dirConfig)) {
    try { harness = JSON.parse(readFileSync(dirConfig, "utf-8")); } catch { return; }
  } else if (existsSync(harnessPath)) {
    try { harness = JSON.parse(readFileSync(harnessPath, "utf-8")); } catch { return; }
  } else {
    return;
  }

  const lines: string[] = [];
  if (harness.dev) {
    lines.push("**Dev:**");
    if (harness.dev.start) lines.push(`- Start: \`${harness.dev.start}\``);
    if (harness.dev.apiBase) lines.push(`- API: ${harness.dev.apiBase}`);
    if (harness.dev.uiBase) lines.push(`- UI: ${harness.dev.uiBase}`);
    if (harness.dev.testCmd) lines.push(`- Test: \`${harness.dev.testCmd}\``);
  }
  if (harness.prod) {
    const prodLines: string[] = [];
    if (harness.prod.rebuild) prodLines.push(`- Deploy: \`${harness.prod.rebuild}\``);
    if (harness.prod.apiBase) prodLines.push(`- API: ${harness.prod.apiBase}`);
    if (prodLines.length > 0) {
      lines.push("\n**Prod:**");
      lines.push(...prodLines);
    }
  }
  if (lines.length === 0) return;

  const envSection = `## Environment\n\n${lines.join("\n")}`;
  const existing = readFileSync(agentsMdPath, "utf-8");

  // Insert before ## Workflow or append before last section
  if (existing.includes("## Workflow")) {
    const updated = existing.replace("## Workflow", `${envSection}\n\n## Workflow`);
    writeFileSync(agentsMdPath, updated);
  } else {
    writeFileSync(agentsMdPath, existing + "\n\n" + envSection + "\n");
  }
  actions.push("UPDATED: AGENTS.md environment section from rungate.json");
}

export function generateAgentsMdContent(
  projectPath: string,
  type: ProjectType,
  actions: string[],
  profile: ScaffoldProfile = DEFAULT_PROFILE,
): string {
  const pkgPath = join(projectPath, "package.json");
  let pkgDesc = "";
  let pkgName = basename(projectPath);
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkgDesc = pkg.description || "";
      pkgName = pkg.name || pkgName;
    } catch {}
  }

  // Read README.md first paragraph for identity
  let readmeDesc = "";
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    try {
      let readme = readFileSync(readmePath, "utf-8");
      while (readme.startsWith("---\n")) {
        const endFm = readme.indexOf("\n---\n", 4);
        if (endFm > 0) { readme = readme.slice(endFm + 5); } else { break; }
      }
      readme = readme.replace(/<!--[\s\S]*?-->/g, "");
      const paragraphs = readme.split(/\n\n+/).filter(p =>
        !p.startsWith("#") && !p.startsWith("---") && !p.startsWith("<") &&
        !/^[\s]*$/.test(p) && p.trim().length > 20
      );
      if (paragraphs.length > 0) readmeDesc = paragraphs[0].replace(/\n/g, " ").trim();
    } catch {}
  }

  const typeLabel = type === "code" ? "Code" : type === "content" ? "Content" : "Infrastructure";
  const identity = readmeDesc || pkgDesc || `${typeLabel} project. <!-- TODO: Describe what this project is -->`;

  // Detect tech stack
  const techStack: string[] = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test?.includes("bun") || pkg.scripts?.dev?.includes("bun") || pkg.scripts?.start?.includes("bun")) {
        techStack.push("Bun");
      } else if (pkg.scripts?.test?.includes("node") || pkg.scripts?.dev?.includes("node")) {
        techStack.push("Node.js");
      }
      if (existsSync(join(projectPath, "tsconfig.json")) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("TypeScript");
      }
      if (pkg.type === "module") {
        techStack.push("ESM");
      }
    } catch {}
  }

  // Detect git remote
  let repoUrl = "";
  try {
    const result = Bun.spawnSync(["git", "-C", projectPath, "remote", "get-url", "origin"]);
    repoUrl = result.stdout.toString().trim().replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
  } catch {}

  // Scan key files
  const keyFiles: Array<{ file: string; what: string; when: string }> = [
    { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
    { file: "PROJECT-STATE.md", what: projectStateKeyFileNote(projectStateDerivation(projectPath)), when: "Session start, always first after AGENTS.md" },
    { file: "project-state.json", what: "Source of truth for project status", when: "When editing state" },
  ];
  const conditionalPatterns: Array<{ pattern: string; what: string; when: string }> = [
    { pattern: "package.json", what: "Dependencies and scripts", when: "Adding deps or scripts" },
    { pattern: "Makefile", what: "Build/deploy commands", when: "Building or deploying" },
    { pattern: "tsconfig.json", what: "TypeScript configuration", when: "Changing TS settings" },
    { pattern: "Containerfile", what: "Container build definition", when: "Modifying container" },
    { pattern: "Dockerfile", what: "Container build definition", when: "Modifying container" },
  ];
  // Include rungate config reference — check directory first, fall back to monolith
  if (existsSync(join(projectPath, ".claude", "rungate", "config.json"))) {
    keyFiles.push({ file: ".claude/rungate/", what: "Harness project config (directory)", when: "Shipping through harness" });
  } else {
    keyFiles.push({ file: ".claude/rungate.json", what: "Harness project config", when: "Shipping through harness" });
  }
  for (const kf of conditionalPatterns) {
    if (existsSync(join(projectPath, kf.pattern))) {
      keyFiles.push({ file: kf.pattern, what: kf.what, when: kf.when });
    }
  }
  for (const srcDir of ["src", "lib", "gates", "workflows", "hooks"]) {
    if (existsSync(join(projectPath, srcDir))) {
      keyFiles.push({ file: `${srcDir}/`, what: `${srcDir.charAt(0).toUpperCase() + srcDir.slice(1)} directory`, when: `Working on ${srcDir}` });
    }
  }

  // Scan specs — delegated to `lib/scanner.ts`, which is the one derivation.
  // This function used to carry its own copy, and the copy drifted three
  // times (#827): it never set `criteriaNone`, so `STATES NO CRITERIA` was
  // dropped from every row that earned it; it hardcoded `testable: "yes"` on
  // group rows, a word `scanner.ts` notes "means false to the code and true
  // to a reader"; and it filtered spec files by name instead of `isSpecFile`,
  // which is how #382's two scans disagreed about `SPEC-TEMPLATE.md`. All
  // three were fixed in `scanner.ts` alone, because nobody knew this existed.
  const specEntries: SpecEntry[] = scanSpecs(projectPath);

  // Scan tests
  const testDir = existsSync(join(projectPath, "test")) ? "test" : existsSync(join(projectPath, "tests")) ? "tests" : null;
  const testEntries: TestFile[] = [];
  if (testDir) {
    for (const f of readdirSorted(join(projectPath, testDir)).filter(f => f.endsWith(".test.ts"))) {
      const label = f.replace(".test.ts", "").replace(/-/g, " ");
      testEntries.push({ label, file: f });
    }
  }

  // Detect test command — through the one binding (#488). This copy read
  // package.json and nothing else, so AGENTS.md's Commands row ignored a
  // `dev.testCmd` the agent briefs honoured and CI ignored both.
  const testCmd = testCommandDecision(projectPath).command;

  // Scan reference files
  const refDir = join(projectPath, "reference");
  const refEntries: RefFile[] = [];
  if (existsSync(refDir)) {
    for (const f of readdirSorted(refDir)) {
      refEntries.push({ file: f, what: "Historical reference" });
    }
  }

  // Detect workflow info
  let makeTargets = "";
  if (existsSync(join(projectPath, "Makefile"))) {
    try {
      const makefile = readFileSync(join(projectPath, "Makefile"), "utf-8");
      const targets = makefile.match(/^[\w-]+(?=:)/gm)?.filter(t => !t.startsWith(".") && !t.startsWith("_")).slice(0, 8);
      if (targets?.length) makeTargets = `\n- **Key commands:** \`make ${targets.join("`, `make ")}\``;
    } catch {}
  }

  // Load harness config
  const harness = loadHarnessConfig(projectPath);

  // Scan docs/ for routing
  const docsDir = join(projectPath, "docs");
  const categories = [
    { dir: "specs", label: "Specs — success criteria, constraints, requirements", frontmatter: "`doc-type: spec`, `testable`, `governs`", notes: "SCs auto-generate tests" },
    { dir: "docs/adr", label: "ADRs — architecture decisions", frontmatter: "`doc-type: adr`, `status`, `created`", notes: "Architecture decisions" },
    { dir: "docs/research", label: "Research — findings, evaluations, competitive analysis", frontmatter: "`doc-type: research`, `governs`", notes: "Tool evaluations, competitive analysis, findings" },
    { dir: "docs/council", label: "Council — synthesis, design debates", frontmatter: "`doc-type: council`", notes: "Council synthesis, design debates" },
    { dir: "docs/guides", label: "Guides — setup, onboarding, reference", frontmatter: "`doc-type: guide`", notes: "Setup, onboarding, reference" },
    { dir: "reference", label: "Reference — historical and inactive docs", frontmatter: "—", notes: "Historical reference" },
  ];

  const rootDocIntents: Record<string, string> = {
    "ARCHITECTURE.md": "System architecture and design principles",
    "PRINCIPLES.md": "Core engineering principles and standards",
    "CONTRIBUTING.md": "How to contribute — workflow, conventions, review process",
    "MODEL.md": "Domain model and data relationships",
    "PROJECT-STATE.md": "Current project state, priorities, and session history",
  };

  const docRouting: Array<{ need: string; file: string }> = [];
  // Always include scaffold-generated files for idempotency (SC-364)
  docRouting.push({ need: "Codebase structure (routes, components, modules, health)", file: "CODE-MAP.md" });
  docRouting.push({ need: "Current project state, priorities, and session history", file: "PROJECT-STATE.md" });
  // Conditionally include other root docs
  for (const [f, intent] of Object.entries(rootDocIntents)) {
    if (f !== "PROJECT-STATE.md" && existsSync(join(projectPath, f))) {
      docRouting.push({ need: intent, file: f });
    }
  }
  for (const cat of categories) {
    const catPath = join(projectPath, cat.dir);
    if (existsSync(catPath)) {
      // Recursive — see the same fix in scanner.ts. This is a second copy of
      // scanDocRouting and it is the one the scaffold actually calls, so the
      // scanner fix alone changed no generated output at all (#91).
      const files = readdirSorted(catPath, { recursive: true }).filter(f => f.endsWith(".md"));
      docRouting.push({ need: `${cat.label} (${files.length} files)`, file: `${cat.dir}/` });
    } else {
      docRouting.push({ need: cat.label, file: `${cat.dir}/` });
      actions.push(`WARN: ${cat.dir}/ listed in routing but directory does not exist`);
    }
  }
  // Through the one binding (#617, #619). This was a complete second copy of
  // `scanDocRouting`, with its own inline `governs:` regex — and it is the copy
  // the scaffold actually calls, so a fix applied only to the scanner changes
  // no generated output at all (#91).
  docRouting.push(...scanDocsDirectory(docsDir, categories.map(c => c.dir)));

  // The "filter to non-obvious mappings" is deleted here for the same reason
  // as in lib/scanner.ts: it could only ever drop a top-level `docs/*.md`, and
  // dropping those is #617. See lib/doc-routing.ts.
  const filteredRouting = docRouting;

  const consumers = harness?.consumers || [];

  const scan: ProjectScan = {
    name: pkgName,
    type,
    root: projectPath,
    identity,
    techStack,
    repoUrl,
    testCmd,
    keyFiles,
    specs: specEntries,
    testFiles: testEntries,
    refFiles: refEntries,
    docRouting: filteredRouting as DocRoute[],
    categories: categories as Category[],
    consumers,
    hasCodeMap: true, // Always true for idempotency — scaffold generates CODE-MAP.md (SC-364)
    makeTargets,
    sourceDirs: [],
    promptRouting: {},
    harnessConfig: harness,
    agentMeta: {},
    dirs: [],
    deps: 0,
    devDeps: 0,
    modules: [],
    routes: [],
    harnessTemplatesDir: "",
    promptPrefix: "",
  };

  // Write scoped rules to .claude/rules/ — but only the ones the harness is
  // still the author of. This loop used to be an unconditional writeFileSync,
  // which truncated .claude/rules/checks-must-be-able-to-fail.md from 262
  // lines to 65 and reported GENERATED (#370). See lib/rule-provenance.ts for
  // why neither "never overwrite" nor "always overwrite" is the answer.
  const rulesDir = join(projectPath, ".claude", "rules");
  if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
  // A rule is instructions to an agent, so one naming machinery the profile
  // did not install is worse than no rule at all. See RULES_NOT_MINIMAL.
  const scopedRules = generateScopedRules(scan).filter(r => isRuleIncluded(r.filename, profile));
  for (const rule of scopedRules) {
    const rulePath = join(rulesDir, rule.filename);
    const existing = existsSync(rulePath) ? readFileSync(rulePath, "utf-8") : null;
    const decision = decideRuleWrite(existing, rule.content);
    if (decision.action === "preserve") {
      // Reported, never resolved. A divergence the run silently fixed is the
      // defect; a divergence named in the report is a decision for a human.
      actions.push(
        `PRESERVED: .claude/rules/${rule.filename} (${decision.reason}) — ` +
          `generator output withheld; delete the file and re-run to accept it`,
      );
      continue;
    }
    writeFileSync(rulePath, decision.content!);
    actions.push(
      `${decision.action === "create" ? "GENERATED" : "UPDATED"}: .claude/rules/${rule.filename}`,
    );
  }

  return buildAgentsMdContent(scan);
}

/**
 * Rewrite `.claude/rules/` from a scan of the tree the run actually left (#123).
 *
 * The first pass happens in Phase 0.5, before `generateOrAuditProjectHarness`
 * creates `.claude/rungate/` and before `copySpecTemplateIfEmpty` creates
 * `specs/`. So a freshly scaffolded project shipped rules describing a tree that
 * no longer existed:
 *
 *   docs-routing.md  "Specs — ... (0 files)"   in a project with a spec
 *   key-files.md     `.claude/rungate.json`    the LEGACY monolith path, in a
 *                                              project using the directory layout
 *
 * The second one is the damaging one: it sends every agent in a new project to a
 * config file that is not there, and key-files.md is the table agents are told
 * to read first.
 *
 * Re-running the generator is safe and cheap: `generateAgentsMdContent` writes
 * only the rules, and returns AGENTS.md content for its caller to write. The
 * return value is discarded here on purpose — AGENTS.md has already been
 * through `injectEnvironmentSection` by this point, and rewriting it would
 * undo that.
 *
 * It used to say `updateSpecsTable` as well. That function ran immediately
 * after the generator had rewritten AGENTS.md, edited an EXISTING table
 * matched on a header row containing `Spec`, and the generator emits no such
 * table — so the match never succeeded, the `if` had no `else`, and its
 * action string never once appeared in a report. It is deleted (#382).
 */
export function refreshScopedRulesStep(
  root: string,
  type: ProjectType,
  actions: string[],
  profile: ScaffoldProfile = DEFAULT_PROFILE,
): void {
  const sink: string[] = [];
  generateAgentsMdContent(root, type, sink, profile);
  // Forward everything except the per-rule lines already reported by the
  // Phase 0.5 pass. Swallowing the rest would hide a warning raised only on
  // the second scan — the fail-open shape .claude/rules/checks-must-be-able-to-fail.md
  // exists to prevent. PRESERVED is in the list because both passes reach the
  // same decision over the same file, so the second is a duplicate and not a
  // new finding; dropping the whole prefix is what keeps it that way.
  for (const a of sink) {
    if (!/^(GENERATED|UPDATED|PRESERVED): \.claude\/rules\//.test(a)) actions.push(a);
  }
  actions.push(`REFRESHED: .claude/rules/ (rescanned after harness config and specs/ existed)`);
}

export function refreshAgentsMd(root: string, type: ProjectType, actions: string[]): void {
  const agentsPath = join(root, "AGENTS.md");
  const content = readFileSync(agentsPath, "utf-8");
  const issues: string[] = [];

  // Check all file references resolve.
  //
  // `referencedPaths` rather than an inline backtick pattern (#380). The old
  // one treated any backtick span ending in a known extension as a path, so
  // the Commands table's `bun test test/scaffold-conformity.test.ts` was
  // handed to existsSync whole. Three reports on this repo, three false
  // positives, zero true positives.
  const refs = referencedPaths(content);
  for (const ref of refs) {
    if (!existsSync(join(root, ref))) {
      issues.push(`BROKEN: ${ref} (referenced in AGENTS.md but doesn't exist)`);
    }
  }

  // Check staleness. The SAME predicate: this scan had its own copy of the
  // pattern, and two scans with two ideas of what a reference is means the
  // second silently stops covering spans the first rejects, with nothing
  // able to notice because they never compare answers.
  const staleFiles: string[] = [];
  for (const ref of refs) {
    if (!ref.endsWith(".md")) continue;
    if (!existsSync(join(root, ref))) continue;
    try {
      const result = Bun.spawnSync(["git", "-C", root, "log", "-1", "--format=%ci", "--", ref], { timeout: 5_000 });
      const dateStr = result.stdout.toString().trim().split(" ")[0];
      if (dateStr) {
        const daysSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
        const isAdr = ref.includes('docs/adr/') || /ADR/i.test(ref);
        if (isAdr) continue;
        const threshold = ref.startsWith('specs/') ? 90 : 180;
        if (daysSince > threshold) staleFiles.push(`${ref} (${Math.floor(daysSince)}d old)`);
      }
    } catch (e: unknown) { console.warn('Staleness check failed for', ref, (e as Error).message); }
  }

  // Check specs table.
  //
  // Across AGENTS.md AND `.claude/rules/`, because D-15 capped AGENTS.md at
  // 100 lines and moved both tables there (#382). Asked of `lib/spec-listing.ts`
  // rather than inline: this site had its own idea of what counts as a spec —
  // every `.md` in `specs/`, including `SPEC-TEMPLATE.md` — and the routing
  // generator had another, so the one entry that could never be listed
  // anywhere was reported on every run.
  const unlisted = unlistedSpecs(root);
  if (unlisted.length > 0) {
    issues.push(`UNLISTED specs: ${unlisted.join(", ")} (in specs/ but not in AGENTS.md or .claude/rules/)`);
  }

  // Check CODE-MAP.md reference — same surfaces, same reason. It is named in
  // the first row of `.claude/rules/docs-routing.md`.
  if (codeMapUnreferenced(root)) {
    issues.push("CODE-MAP.md exists but not referenced in AGENTS.md or .claude/rules/");
  }

  if (issues.length > 0 || staleFiles.length > 0) {
    console.log("\n  AGENTS.md audit:");
    for (const issue of issues) console.log(`    ⚠ ${issue}`);
    if (staleFiles.length > 0) {
      console.log(`    ⚠ STALE (>90 days): ${staleFiles.join(", ")}`);
    }
    actions.push(`AUDITED: AGENTS.md (${issues.length} broken refs, ${staleFiles.length} stale docs)`);
  } else {
    actions.push("AUDITED: AGENTS.md (all references valid, no stale docs)");
  }
}

// ── Conformity test generation ─────────────────────────────────

/**
 * The conformity suite every scaffolded project runs.
 *
 * Two things here were only ever wrong because nothing regenerated this file
 * (#208), and both are fixed in the same change that makes it regenerate:
 *
 * 1. Every call passed a `findings` array. No entry point has ever taken one
 *    — findings accumulate in a module-level collector that
 *    `writeFindingsReport(root)` reads. The extra argument typechecked
 *    nowhere and did nothing anywhere; it survived because the only tree that
 *    typechecks this file is rungate's, and rungate's copy was the
 *    hand-adapted one the skip preserved.
 * 2. `runDirectoryValidation` was missing. rungate's hand-adapted copy ran
 *    it; the template did not. Regenerating without it would have deleted a
 *    live check — the same silent-coverage-loss this issue is about, just
 *    pointed the other way.
 */
export function generateConformityTest(root?: string): string {
  // A package cannot import itself by name without an `exports` map, and
  // adding one to make a generated string uniform would be the tail wagging
  // the dog.
  //
  // `isHarnessItself` rather than a second predicate of my own. #208 shipped
  // one — identical in intent and in implementation to this, which already
  // existed and which SC-811 names by name. Two deciders of the same fact
  // survive any mutation of either, which is the defect #208 was about.
  const from = root && isHarnessItself(root) ? "../lib/conformity" : "rungate/lib/conformity";
  return `import { resolve } from "path";
import { afterAll } from "bun:test";
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runDirectoryValidation, runPackageValidation, runTsconfigValidation, runConfigAccessValidation, runPromptConfigAccessValidation, runSuccessDocValidation, runAiReviewValidation, runBranchProtectionValidation, runWorkflowDriftValidation, writeFindingsReport } from "${from}";

const ROOT = resolve(import.meta.dir, "..");

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
runSpecDrift(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT);
runAgentFileValidation(ROOT);
runDirectoryValidation(ROOT);
runPackageValidation(ROOT);
runTsconfigValidation(ROOT);
runConfigAccessValidation(ROOT);
runPromptConfigAccessValidation(ROOT);
runSuccessDocValidation(ROOT);
runAiReviewValidation(ROOT);
runBranchProtectionValidation(ROOT);
runWorkflowDriftValidation(ROOT);

afterAll(() => writeFindingsReport(ROOT));
`;
}

// ── Agent briefs generation ────────────────────────────────────

export function generateAgentBriefsStep(
  root: string,
  actions: string[],
  opts: {
    /**
     * Where the brief templates live. Defaults to the harness's own
     * `templates/agent-briefs/`, which is what every production caller
     * wants and what makes the templates harness-wide (#655).
     *
     * The seam exists because the `section-preserving` refusal below can
     * only fire when the GENERATED brief carries the project-owned heading
     * itself, and no input `root` accepts can produce that — the identity
     * extractor stops at the first `\n##` and the README fallback flattens
     * newlines. Without a seam the refusal would be reachable in
     * production and unreachable in a test, which is the shape
     * `.claude/rules/checks-must-be-able-to-fail.md` is about.
     */
    templatesDir?: string;
  } = {},
): void {
  const agentsDir = join(root, ".claude", "agents");
  safeDir(agentsDir, ".claude/agents", actions);

  // This copy had no try/catch, so an unreadable package.json threw here and
  // killed the scaffold run, while the other three sites answering the same
  // question shrugged and said "consumer" (#380).
  const promptPrefix = isHarnessItself(root) ? "prompts" : "node_modules/rungate/prompts";

  const harness = loadHarnessConfig(root);

  let projectIdentity = "";
  const agentsMdPath = join(root, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, "utf-8");
    const identityMatch = content.match(/## Project Identity\n\n([\s\S]*?)(?=\n##|\n\|)/);
    if (identityMatch) projectIdentity = identityMatch[1].trim();
  }
  if (!projectIdentity) {
    const readmePath = join(root, "README.md");
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, "utf-8");
      const paragraphs = readme.split(/\n\n+/).filter(p => !p.startsWith("#") && p.trim().length > 20);
      if (paragraphs.length > 0) projectIdentity = paragraphs[0].replace(/\n/g, " ").trim();
    }
  }

  // Prompt routing
  const promptsDir = join(root, "prompts");
  const defaultKeywords: Record<string, string[]> = {
    marcus: ["coding", "code", "standard", "implementation", "engineering", "convention", "principle"],
    quinn: ["testing", "test", "qa", "quality", "coverage"],
    rook: ["security", "auth", "secret", "vulnerability", "access"],
    serena: ["architecture", "design-pattern", "system", "module", "structure"],
    aditi: ["design", "ui", "ux", "component", "visual", "accessibility"],
    discovery: ["discovery", "ac-format", "evidence", "scope", "sizing"],
  };
  const agentKeywords: Record<string, string[]> = { ...defaultKeywords, ...harness?.promptKeywords };
  const promptsByAgent: Record<string, Array<{ file: string; when: string }>> = {
    marcus: [], quinn: [], rook: [], serena: [], aditi: [], discovery: []
  };
  if (existsSync(promptsDir)) {
    const promptFiles = readdirSorted(promptsDir).filter(f => f.endsWith(".md"));
    for (const f of promptFiles) {
      const content = readFileSync(join(promptsDir, f), "utf-8");
      const lower = f.toLowerCase();

      let whenToRead = f.replace(/\.md$/, "").replace(/-/g, " ");
      const headingMatch = content.match(/^#\s+(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) {
        whenToRead = descMatch[1].trim();
      } else if (headingMatch) {
        whenToRead = headingMatch[1].trim();
      }

      const stem = lower.replace(/\.md$/, "");
      const segments = stem.split(/[-_]/);
      for (const [agent, keywords] of Object.entries(agentKeywords)) {
        const matches = stem === agent || keywords.some(kw =>
          kw.includes("-") ? stem.includes(kw) : segments.includes(kw)
        );
        if (matches) {
          promptsByAgent[agent].push({ file: `prompts/${f}`, when: whenToRead });
        }
      }
    }
  }

  const srcDirs = ["src", "dashboard/src", "lib", "gates", "hooks"].filter(d => existsSync(join(root, d)));
  const consumers = harness?.consumers || [];

  // Resolve templates directory relative to this module
  const harnessTemplatesDir =
    opts.templatesDir ?? join(dirname(dirname(__dirname)), "templates", "agent-briefs");

  // buildAgentMeta takes the whole harness config and reads .roles itself.
  // Passing harness?.roles made it look for roles.roles, so every consumer's
  // role config was silently dropped and DEFAULT_AGENT_META always won.
  const configMeta = buildAgentMeta(harness ?? null);
  const agentMeta: Record<string, any> = {};
  for (const name of Object.keys({ ...DEFAULT_AGENT_META, ...configMeta })) {
    agentMeta[name] = { ...DEFAULT_AGENT_META[name], ...configMeta[name] };
  }

  // Detect project type for accurate briefs. A DIFFERENT question from
  // "is this the harness" — it also admits any project keyworded `harness` —
  // so it keeps its own branch and borrows only the identity half (#380).
  const pkgPath = join(root, "package.json");
  let detectedType: ProjectType = "code";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (isHarnessItself(root) || pkg.keywords?.includes("harness")) detectedType = "infra";
    } catch {}
  } else if (!existsSync(join(root, "src")) && !existsSync(join(root, "lib"))) {
    detectedType = "infra";
  }

  const briefScan: ProjectScan = {
    name: basename(root),
    type: detectedType,
    root,
    identity: projectIdentity,
    techStack: [],
    repoUrl: "",
    testCmd: testCommandDecision(root).command,
    keyFiles: [],
    specs: [],
    testFiles: [],
    refFiles: [],
    docRouting: [],
    categories: [],
    consumers,
    hasCodeMap: false,
    makeTargets: "",
    sourceDirs: srcDirs,
    promptRouting: promptsByAgent,
    harnessConfig: harness,
    agentMeta,
    dirs: [],
    deps: 0,
    devDeps: 0,
    modules: [],
    routes: [],
    harnessTemplatesDir,
    promptPrefix,
  };

  const briefs = buildAgentBriefsContent(briefScan);

  for (const [agentName, content] of Object.entries(briefs)) {
    const p = join(agentsDir, `${agentName}.md`);
    const label = `.claude/agents/${agentName}.md`;
    // #654. The probe is taken BEFORE the write it describes. Asked
    // afterwards it is true on every path that reaches it — `writeFileSync`
    // either succeeded, in which case the file is there, or threw, in which
    // case this line never runs — so the `CREATED:` arm was unreachable and
    // a consumer scaffolding for the first time was told its briefs were
    // updated.
    const existedBefore = existsSync(p);

    // #655. The write used to be a bare `writeFileSync(p, content)` — no
    // `decideOwnedWrite`, no strategy read, nothing. The row in
    // `OWNED_FILES` said `regenerate` and a bare overwrite happens to
    // behave like `regenerate`, so nothing ever disagreed and the
    // declaration test could not see it: reading a strategy is not the same
    // as honouring it. Flipping the row alone would have changed nothing
    // here; this is the other half.
    const existing = existedBefore ? readFileSync(p, "utf-8") : null;
    const decision = decideOwnedWrite(
      ownedStrategy(label),
      existing,
      content,
      ownedSections(label),
    );

    if (decision.action === "refuse" || decision.action === "preserve") {
      actions.push(`${SCAFFOLD_REFUSE}: ${label} not written — ${decision.reason}`);
      continue;
    }
    if (decision.action === "unchanged") {
      actions.push(`UNCHANGED: ${label} (${decision.reason})`);
      continue;
    }
    writeFileSync(p, decision.content!);
    actions.push(`${existedBefore ? "UPDATED" : "CREATED"}: ${label}`);
  }
}

// ── Harness config generation/audit ────────────────────────────

export function generateOrAuditProjectHarness(root: string, actions: string[], opts: { pruneConsumers?: boolean } = {}): void {
  const harnessPath = join(root, ".claude", "rungate.json");

  const detectedHealthPath = detectHealthPath(root);

  // Scan pages from route files
  const scannedPages: Record<string, string> = {};
  const routeFiles = ["src/App.tsx", "src/routes.tsx", "src/index.tsx", "src/app.tsx"]
    .map(f => join(root, f))
    .filter(f => existsSync(f));
  for (const routeFile of routeFiles) {
    const content = readFileSync(routeFile, "utf-8");
    const routePattern = /path="([^"]+)"/g;
    let m;
    while ((m = routePattern.exec(content)) !== null) {
      const path = m[1];
      if (path === "*" || path.includes(":")) continue;
      const label = path.split("/").pop() || "home";
      scannedPages[path] = label;
    }
  }

  // Scan pages from dashboard/src/pages/*.tsx (file-based routing)
  const dashboardPagesDir = join(root, "dashboard", "src", "pages");
  if (existsSync(dashboardPagesDir)) {
    const pageFiles = readdirSorted(dashboardPagesDir).filter(f => f.endsWith(".tsx") || f.endsWith(".jsx"));
    for (const f of pageFiles) {
      const componentName = f.replace(/\.(tsx|jsx)$/, "");
      // Convert CamelCase to kebab-case route path
      const routePath = "/" + componentName
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
      scannedPages[routePath] = componentName;
    }
  }

  // `inferredTestCommand`, not the full decision (#488). This value is what
  // gets WRITTEN into `dev.testCmd`, so reading `dev.testCmd` to choose it
  // is circular — and this step runs against trees whose config is
  // malformed, which is what it exists to repair.
  const testCmd = inferredTestCommand(root).command;
  const pkgPath = join(root, "package.json");
  // #87 — this defaulted to `bunx tsc --noEmit` for every project, including
  // one with no tsconfig, and `gates/gate-executor.ts` RUNS what lands here.
  // Without a tsconfig that command prints 147 lines of help and exits 1, so
  // the verify gate reported "Type check FAIL" at every consumer that the
  // three other sites had already agreed should not be type-checked at all.
  // `null` is the honest value and the gate already skips on a falsy one.
  const typeCheckCmd = typecheckDecision(root).command;

  // Scan port from Makefile, docker-compose.yml, or .env.example
  const makefile = join(root, "Makefile");

  /**
   * #343 — does the Makefile actually declare this target?
   *
   * The `dev.start` and `prod.rebuild` defaults tested only that a Makefile
   * EXISTED, then wrote `make dev-all` / `make rebuild` into the consumer's
   * config. Those are one consumer's target names. A project with a Makefile
   * and no `rebuild` target got a `prod.rebuild` that cannot run, and the
   * failure surfaces at rebuild time as "No rule to make target" rather than
   * as a scaffold that guessed.
   *
   * `scripts/scaffold-rungate-config.ts:66` already did it this way; this
   * brings the two into line rather than inventing a third behaviour.
   */
  const makeTarget = (name: string): boolean => {
    if (!existsSync(makefile)) return false;
    try {
      return new RegExp(`^${name}\\s*:`, "m").test(readFileSync(makefile, "utf-8"));
    } catch {
      return false;
    }
  };
  const detectedPort = (() => {
    if (existsSync(makefile)) {
      const content = readFileSync(makefile, "utf-8");
      const portMatch = content.match(/(?:--port\s+|PORT=|-p\s+|:)(\d{4,5})/);
      if (portMatch) return parseInt(portMatch[1]);
    }
    // Scan docker-compose.yml for port mappings
    const dockerComposePaths = ["docker-compose.yml", "docker-compose.yaml"]
      .map(f => join(root, f));
    for (const dcPath of dockerComposePaths) {
      if (existsSync(dcPath)) {
        const content = readFileSync(dcPath, "utf-8");
        // Match port mappings like "3001:3001" or "- 8080:8080"
        const portMatch = content.match(/["']?(\d{4,5}):\d{4,5}["']?/);
        if (portMatch) return parseInt(portMatch[1]);
      }
    }
    const envExample = join(root, ".env.example");
    if (existsSync(envExample)) {
      const content = readFileSync(envExample, "utf-8");
      const portMatch = content.match(/^PORT=(\d{4,5})/m);
      if (portMatch) return parseInt(portMatch[1]);
    }
    return null;
  })();

  // Scan envVars
  const envVars = (() => {
    const envPath = join(root, ".env.example");
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, "utf-8");
    return content.split("\n")
      .filter(line => line.trim() && !line.startsWith("#"))
      .map(line => line.split("=")[0].trim())
      .filter(Boolean);
  })();

  // Detect git remote
  let repo = "";
  try {
    const result = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"], { timeout: 5_000 });
    repo = result.stdout.toString().trim()
      .replace(/\.git$/, "")
      .replace("git@github.com:", "")
      .replace("https://github.com/", "");
  } catch {}

  // Scan consumers
  const scannedConsumers: string[] = [];
  const srcDir = join(root, "src");
  if (existsSync(srcDir)) {
    const consumerPatterns = ["-routes.ts", "-generator.ts", "-plan.ts", "-intel.ts"];
    for (const f of readdirSorted(srcDir).filter(f => f.endsWith(".ts"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const isConsumer = consumerPatterns.some(p => f.includes(p)) ||
        content.includes("app.get(") || content.includes("app.post(") ||
        content.includes("router.") || content.includes("export default");
      if (isConsumer) {
        scannedConsumers.push(f.replace(/\.ts$/, "").replace(/-routes|-generator/, ""));
      }
    }
  }

  const rungateDir = join(root, ".claude", "rungate");
  const hasDirectory = existsSync(join(rungateDir, "config.json"));

  if (hasDirectory) {
    // Directory structure already exists — audit it, and repair the two
    // files #75 only ever fixed for greenfield projects (#121).
    const existing = JSON.parse(readFileSync(join(rungateDir, "config.json"), "utf-8"));
    repairEmptySidecars(rungateDir, actions);
    auditExistingConfig(existing, scannedPages, scannedConsumers, actions, rungateDir, opts.pruneConsumers === true);
  } else if (existsSync(harnessPath)) {
    // Monolith exists — split into directory structure
    const existing = JSON.parse(readFileSync(harnessPath, "utf-8"));

    // Check if monolith has roles/hooks/compliance to split
    if (existing.roles || existing.hooks || existing.compliance) {
      splitMonolithToDirectory(root, existing, actions);
    } else {
      // Simple monolith without split-worthy content — audit only
      // No rungateDir on this path (the monolith layout), so pruning has
      // nowhere to write and is not offered rather than silently not happening.
      auditExistingConfig(existing, scannedPages, scannedConsumers, actions);
    }
  } else {
    // No config exists — create directory structure
    let harnessVersion = "unknown";
    try {
      const harnessPkg = JSON.parse(readFileSync(join(dirname(dirname(__dirname)), "package.json"), "utf-8"));
      harnessVersion = harnessPkg.version || "unknown";
    } catch {}

    // Prefer package.json name, fall back to directory basename
    let projectName = basename(root);
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name) projectName = pkg.name;
      } catch {}
    }

    const config = {
      "$schema": "rungate",
      harnessVersion,
      scaffoldedAt: new Date().toISOString(),
      project: projectName,
      repo,
      issueRepo: repo,
      dev: {
        start: makeTarget("dev-all") ? "make dev-all" : "bun run dev",
        apiBase: detectedPort ? `http://localhost:${detectedPort}` : null,
        // Detected, never defaulted (#346).
        //
        // #346 suggested scaffolding a conventional value so the UNMEASURED
        // population shrinks. A plain default would re-create #304's bug
        // through a different door: `DevSchema.healthPath` says in so many
        // words "No default. A probe that guesses a path reports DOWN for a
        // server that is up", and a guess the scaffold writes into the
        // consumer's config is still a guess — it is just one the harness can
        // point at the consumer afterwards.
        //
        // So the route is looked for, and `null` when it is not found. That
        // keeps UNMEASURED meaning what it should: this project has no health
        // endpoint we could locate, rather than this probe did not try.
        healthPath: detectedHealthPath,
        uiBase: null as string | null,
        testCmd,
        typeCheck: typeCheckCmd,
      },
      prod: {
        rebuild: makeTarget("rebuild") ? "make rebuild" : undefined,
        apiBase: null as string | null,
      },
      pages: scannedPages,
      consumers: [...new Set(scannedConsumers)].sort(),
      envVars: envVars || [],
      ci: {
        runner: "ubuntu-latest",
        // Detected, never defaulted (#346, #622). `"latest"` here wrote an
        // UNPINNED runtime into every greenfield project's CI and called it a
        // configuration: the job installs whatever shipped this morning, so
        // re-running a red build is also a Bun upgrade. The bun that ran the
        // scaffold is a measurement of what this project has been built with,
        // which is the honest thing to write down, and the operator can change
        // it in one place afterwards.
        bunVersion: Bun.version,
        branches: ["main"],
      },
      contextDocs: {},
      test: {
        command: testCmd,
        timeout: 300000,
      },
    };

    // Greenfield gets the DEFAULT roles and hooks, not `{}` and `[]`. An empty
    // roles.json reads as a configured project with nothing to dispatch (#70).
    // The split path below is deliberately NOT routed through these defaults.
    const roles = buildDefaultRoles();
    const hooks = buildDefaultHooks();
    writeDirectoryStructure(root, config, roles, hooks, undefined, actions);
    actions.push(
      `CREATED: .claude/rungate/ (${Object.keys(scannedPages).length} pages, ${scannedConsumers.length} consumers, ` +
      `${Object.keys(roles).length} roles, ${hooks.length} hooks)`
    );
  }
}

/**
 * The two config files that are useless when empty, and what fills them.
 *
 * ONE table, read by both the repair and the audit, so they cannot disagree
 * about what "empty" means. Two deciders here would let the audit call a
 * project aligned that the repair had just declined to touch.
 */
const SIDECARS = [
  { file: "roles.json", empty: "{}", fill: () => buildDefaultRoles() },
  { file: "hooks.json", empty: "[]", fill: () => buildDefaultHooks() },
] as const;

export type SidecarState = "missing" | "empty" | "unreadable" | "populated";

/**
 * What state one sidecar is in. FOUR answers, not two.
 *
 * The first draft returned a boolean, and the boolean hid a case: an
 * unreadable `roles.json` is neither empty nor populated. Repair must not
 * touch it — overwriting a file we failed to parse is how a repair destroys
 * work, and #370 and #208 already settled that for every other owned file —
 * but the audit must not call it aligned either. A boolean forced those two
 * needs onto one answer, and whichever way it fell, one of them was wrong.
 *
 * `{}` and `[]` are `empty`: the states #70 produced and #75 stopped
 * producing. They parse, they are valid, and they mean "a configured
 * project with nothing to dispatch".
 */
export function sidecarState(dir: string, file: string): SidecarState {
  const p = join(dir, file);
  if (!existsSync(p)) return "missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return "unreadable";
  }
  if (Array.isArray(parsed)) return parsed.length === 0 ? "empty" : "populated";
  if (parsed !== null && typeof parsed === "object") {
    return Object.keys(parsed).length === 0 ? "empty" : "populated";
  }
  // A number, a string, `null` — parses, but is not a config.
  return "unreadable";
}

/**
 * Fill an empty `roles.json` / `hooks.json` from the greenfield defaults.
 *
 * #121. #75 fixed the greenfield branch; a project scaffolded before it has
 * `config.json`, so every re-scaffold takes the audit branch and the empty
 * files were never touched. There was no path that repaired them.
 *
 * **A populated file is left alone, byte for byte.** Repair that overwrites
 * is not repair, and "some roles appeared" is satisfied by a `--fix` that
 * rewrites the whole directory — the opposite failure and the worse one,
 * because the overwritten file is gone and the skipped one is still there.
 */
function repairEmptySidecars(rungateDir: string, actions: string[]): void {
  for (const { file, fill } of SIDECARS) {
    const state = sidecarState(rungateDir, file);
    if (state === "populated") continue;
    if (state === "unreadable") {
      // Reported, never resolved. A run that quietly declined to write is
      // indistinguishable from one that had nothing to do (#208, SC-819).
      actions.push(
        `PRESERVED: .claude/rungate/${file} (unreadable — not overwritten; ` +
          `fix the JSON or delete the file and re-run to reseed it)`,
      );
      continue;
    }
    const content = fill();
    writeFileSync(join(rungateDir, file), JSON.stringify(content, null, 2) + "\n");
    const n = Array.isArray(content) ? content.length : Object.keys(content).length;
    actions.push(`REPAIRED: .claude/rungate/${file} (was ${state} — seeded ${n} from defaults)`);
  }
}

/**
 * Remove consumers the source scan did not find — only when asked (#42).
 *
 * **Opt-in, against the issue's own SC-4, and the asymmetry is the reason.**
 * SC-2 says to remove them "when source scan confirms they don't exist". A
 * source scan cannot confirm absence; it reports that it did not find
 * something, and the gap between those two claims is where a dynamic import,
 * a generated file, a file type the scanner does not read, and a scanner that
 * errored all live. A stale entry left in config costs a warning line. A live
 * entry deleted costs that consumer its role grading, compliance policy and
 * pre-flight checks — silently, in a report nobody reads line by line.
 *
 * So adding a frontmatter field stays opt-out as SC-4 asks, and this one
 * operation does not: deleting is not in the same risk class as adding.
 *
 * Returns true when it pruned, so the caller reports the finding only when it
 * did not — a run must never both remove something and complain it is there.
 */
export function pruneStaleConsumers(
  existing: any,
  scannedConsumers: string[],
  stale: string[],
  actions: string[],
  rungateDir: string | undefined,
  prune: boolean,
): boolean {
  if (!prune) return false;

  // The refusal that matters most, and the one nothing in #42 asked for: a
  // scanner that returns nothing makes EVERY declared consumer look stale, so
  // one broken scan would empty the list in a single pass. "The scan found no
  // consumers" and "this project has no consumers" are not the same reading,
  // and treating them alike is Silent Default Substitution
  // (`.claude/rules/config-access.md`).
  if (scannedConsumers.length === 0) {
    actions.push(
      `REFUSED: --prune-consumers (the source scan found no consumers at all, so all ${stale.length} ` +
        `look stale — a scan that found nothing is a broken scan, not an empty project)`,
    );
    return false;
  }

  if (!rungateDir || !existsSync(join(rungateDir, "config.json"))) {
    actions.push(
      "REFUSED: --prune-consumers (no .claude/rungate/config.json to write — " +
        "refusing rather than guessing which file holds the consumer list)",
    );
    return false;
  }

  const configPath = join(rungateDir, "config.json");
  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    // A corrupt config is never an empty config. Rewriting it from `existing`
    // would discard every key this function does not know about.
    actions.push(`REFUSED: --prune-consumers (config.json is unreadable: ${(err as Error).message})`);
    return false;
  }

  config.consumers = (config.consumers || []).filter((c: string) => !stale.includes(c));
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  existing.consumers = config.consumers;

  // Every name, not a count. A removal the report summarises as a number is
  // one nobody can audit or put back.
  actions.push(`AUTO-FIXED: .claude/rungate/config.json (pruned ${stale.length} stale consumers: ${stale.join(", ")})`);
  return true;
}

function auditExistingConfig(
  existing: any,
  scannedPages: Record<string, string>,
  scannedConsumers: string[],
  actions: string[],
  rungateDir?: string,
  prune = false,
): void {
  const issues: string[] = [];

  // #121. The audit used to not even be PASSED the directory, so it could
  // not have read these if it wanted to — and it said "aligned with code"
  // over zero roles and zero hooks. A check that passes because of what it
  // never looked at, asserting health rather than staying silent.
  //
  // This runs AFTER `repairEmptySidecars`, so reaching it means the repair
  // declined: the file was unparseable, or not writable. Either way the
  // project is not aligned and the run must say so.
  if (rungateDir) {
    for (const { file } of SIDECARS) {
      const state = sidecarState(rungateDir, file);
      if (state !== "populated") {
        issues.push(`CONFIG: .claude/rungate/${file} is ${state} — nothing to dispatch`);
      }
    }
  }

  const declaredPages = Object.keys(existing.pages || {});
  const scannedPaths = Object.keys(scannedPages);
  const missingPages = scannedPaths.filter(p => !declaredPages.some(d => existing.pages[d] === p || d === p));
  if (missingPages.length > 0) {
    issues.push(`PAGES: ${missingPages.length} routes in code not in rungate.json: ${missingPages.slice(0, 5).join(", ")}`);
  }

  // Audit consumers: flag declared consumers not found in source code as stale
  const declaredConsumers = existing.consumers || [];
  if (declaredConsumers.length > 0) {
    const staleConsumers = declaredConsumers.filter((c: string) => !scannedConsumers.includes(c));
    if (staleConsumers.length > 0) {
      const pruned = pruneStaleConsumers(existing, scannedConsumers, staleConsumers, actions, rungateDir, prune);
      if (!pruned) {
        issues.push(`CONSUMERS: ${staleConsumers.length} stale consumers in rungate.json not found in source: ${staleConsumers.slice(0, 5).join(", ")}`);
      }
    }
  }

  if (issues.length > 0) {
    console.log("\n  rungate.json audit:");
    for (const issue of issues) console.log(`    ⚠ ${issue}`);
    // Every gap goes into the actions, not just its count (#121). The
    // detail used to reach `console.log` alone — so the returned report
    // said `1 gaps` and nothing about WHICH, and anything reading actions
    // rather than stdout could not tell one gap from another. CONSUMERS
    // was the single exception, pushed by hand; it is now the rule.
    for (const issue of issues) actions.push(`AUDIT: ${issue}`);
    actions.push(`AUDITED: rungate.json (${issues.length} gaps)`);
  } else {
    actions.push("AUDITED: rungate.json (aligned with code)");
  }
}

function splitMonolithToDirectory(
  root: string,
  monolith: any,
  actions: string[]
): void {
  // Extract split-worthy fields
  const { roles, hooks, compliance, ...configFields } = monolith;

  writeDirectoryStructure(
    root,
    configFields,
    roles || {},
    hooks || [],
    compliance,
    actions
  );
  actions.push(`SPLIT: .claude/rungate.json → .claude/rungate/ (config.json, roles.json, hooks.json, compliance.json)`);
}

function writeDirectoryStructure(
  root: string,
  config: any,
  roles: any,
  hooks: any[],
  compliance: any | undefined,
  actions: string[]
): void {
  const rungateDir = join(root, ".claude", "rungate");
  if (!existsSync(rungateDir)) mkdirSync(rungateDir, { recursive: true });

  writeFileSync(join(rungateDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(rungateDir, "roles.json"), JSON.stringify(roles, null, 2) + "\n");
  writeFileSync(join(rungateDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");

  const defaultCompliance = compliance || {
    rules: {},
    defaults: { consecutiveFailThreshold: 3, tierPromotionThreshold: 5 },
    organize: { fileTypes: [".md"], artifactClassification: {}, externalSources: [] },
  };
  writeFileSync(join(rungateDir, "compliance.json"), JSON.stringify(defaultCompliance, null, 2) + "\n");
}

// ── Code map generation ────────────────────────────────────────

/**
 * Generate CODE-MAP.md. Must run LAST in the scaffold (#123).
 *
 * This used to be invoked in Phase 1, before `generateAgentBriefsStep` wrote
 * `.claude/agents/`, before `copySpecTemplateIfEmpty` wrote `specs/`, and
 * before `addPaiHarnessDevDep` added a devDependency — so a fresh project's
 * CODE-MAP.md described a tree that stopped existing moments later in the same
 * run, reporting `specs/ 0 files` and no agents directory in a project with
 * both.
 *
 * The lag was permanent rather than one-run-behind, because of the staleness
 * skip below: while the file is under 14 days old it is not regenerated at all,
 * so no later scaffold ever corrected it. Running this step last is what makes
 * that skip safe — the content it preserves is now right from run 1.
 */
export function generateCodeMapStep(
  root: string,
  actions: string[],
  // #654 — the one injection seam, so the branch where the generator exits 0
  // and writes nothing can be entered. There is no input to the real
  // generator that provokes it, and a branch no test can enter is the thing
  // `.claude/rules/checks-must-be-able-to-fail.md` is about. Optional and
  // defaulted to the real script, so every caller is unchanged and a test
  // that forgets it is testing the real thing.
  opts: { generatorPath?: string } = {},
): void {
  // No dry-run branch. It reported `GAP: CODE-MAP.md missing` and nothing
  // else — one of the four `existsSync` checks that stood in for twenty-five
  // write steps and made audit report 0 changes on a tree `--fix` rewrote in
  // 28 places. #398 replaced prediction with rehearsal: audit runs THIS,
  // against a throwaway clone, and reports `GENERATED: CODE-MAP.md` because
  // that is what happened. Reachable from one caller, which has always passed
  // fix mode, so the branch was dead as well as wrong.
  const codeMapPath = join(root, "CODE-MAP.md");

  // Check staleness
  if (existsSync(codeMapPath)) {
    const content = readFileSync(codeMapPath, "utf-8");
    const updatedMatch = content.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
    if (updatedMatch) {
      const lastScan = new Date(updatedMatch[1]);
      const daysSince = (Date.now() - lastScan.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 14) {
        const gitResult = Bun.spawnSync(
          ["git", "-C", root, "rev-list", "--count", `--since=${updatedMatch[1]}`, "HEAD"],
          { timeout: 5_000 }
        );
        const commits = parseInt(gitResult.stdout.toString().trim()) || 0;
        if (commits < 50) {
          actions.push(`SKIP: CODE-MAP.md (${daysSince.toFixed(0)}d old, ${commits} commits — still fresh)`);
          return;
        }
      }
    }
  }

  // Run generate-code-map.ts if available
  const scriptPath =
    opts.generatorPath ?? join(dirname(dirname(__dirname)), "scripts", "generate-code-map.ts");
  if (existsSync(scriptPath)) {
    // #654, and the same shape as the brief loop above with one extra arm.
    // Asked after the generator ran, `existsSync` answered two questions at
    // once and got both wrong: a successful generation reported `UPDATED:`
    // whether or not the file was new, and a generator that exits 0 WITHOUT
    // writing reported `CREATED:` for a file that is not there. The second
    // is the one that matters — `lib/scaffold/rehearsal.ts:481` records the
    // same defect at a site that was fixed, and it survived here because
    // the note was attached to the site rather than to the shape.
    const existedBefore = existsSync(codeMapPath);
    const result = Bun.spawnSync(["bun", scriptPath, root], { timeout: 60_000 });
    if (result.exitCode === 0) {
      const existsNow = existsSync(codeMapPath);
      actions.push(
        !existsNow
          // Neither created nor updated: the generator reported success and
          // produced nothing, which is a measurement that did not happen
          // and must not read as one that did.
          ? "UNMEASURED: CODE-MAP.md — the generator exited 0 and wrote no file"
          : existedBefore
            ? "UPDATED: CODE-MAP.md"
            : "CREATED: CODE-MAP.md",
      );
    } else {
      actions.push("WARN: CODE-MAP.md generation failed via script — trying inline");
      generateCodeMapInline(root, codeMapPath, actions);
    }
  } else {
    generateCodeMapInline(root, codeMapPath, actions);
  }
}

function generateCodeMapInline(root: string, outPath: string, actions: string[]): void {
  const name = basename(root);
  const skip = new Set(["node_modules", ".git", "reference", "dist", "build", ".next", ".fallow"]);
  const dirs: Array<{ name: string; types: string[] }> = [];
  for (const entry of readdirSorted(root)) {
    if (entry.startsWith(".") && entry !== ".claude") continue;
    if (skip.has(entry)) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      // One binding for what a "type" is, shared with `lib/scanner.ts` and
      // `scripts/generate-code-map.ts` (#1200). This is the fallback that
      // runs when the script is unavailable, so a copy here reintroduces
      // whatever the other two fix.
      dirs.push({ name: entry, types: fileExtensions(full) });
    } catch {}
  }
  // Unsorted. Row order is `directoryTable`'s single decision (#1163).

  let deps = 0, devDeps = 0;
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      deps = Object.keys(pkg.dependencies || {}).length;
      devDeps = Object.keys(pkg.devDependencies || {}).length;
    } catch {}
  }

  const srcDir = join(root, "src");
  const modules: Array<{ file: string; exports: string[] }> = [];
  if (existsSync(srcDir)) {
    for (const f of readdirSorted(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const exports: string[] = [];
      const exportPattern = /export\s+(?:function|const|class|type|interface)\s+(\w+)/g;
      let m;
      while ((m = exportPattern.exec(content)) !== null) exports.push(m[1]);
      if (exports.length > 0) modules.push({ file: `src/${f}`, exports });
    }
  }

  // Detect API routes
  const routes: Array<{ method: string; path: string; file: string }> = [];
  if (existsSync(srcDir)) {
    for (const f of readdirSorted(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
      const content = readFileSync(join(srcDir, f), "utf-8");
      const routePatterns = [
        /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
        /router\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
        /["'`]((?:GET|POST|PUT|DELETE|PATCH)\s+\/[^"'`]+)["'`]/g,
      ];
      for (const pattern of routePatterns) {
        let rm;
        while ((rm = pattern.exec(content)) !== null) {
          if (rm[2]) routes.push({ method: rm[1].toUpperCase(), path: rm[2], file: `src/${f}` });
          else if (rm[1]) {
            const parts = rm[1].split(/\s+/);
            if (parts.length === 2) routes.push({ method: parts[0], path: parts[1], file: `src/${f}` });
          }
        }
      }
    }
  }

  const mapScan: ProjectScan = {
    name,
    type: "code",
    root,
    identity: "",
    techStack: [],
    repoUrl: "",
    testCmd: "",
    keyFiles: [],
    specs: [],
    testFiles: [],
    refFiles: [],
    docRouting: [],
    categories: [],
    consumers: [],
    hasCodeMap: false,
    makeTargets: "",
    sourceDirs: [],
    promptRouting: {},
    harnessConfig: null,
    agentMeta: {},
    dirs,
    deps,
    devDeps,
    modules,
    routes,
    harnessTemplatesDir: "",
    promptPrefix: "",
  };

  const md = buildCodeMapContent(mapScan);
  writeFileSync(outPath, md);
  actions.push("CREATED: CODE-MAP.md (inline)");
}

// ── Misc scaffold steps ────────────────────────────────────────

export function copySpecTemplateIfEmpty(specsDir: string, actions: string[]): void {
  if (!existsSync(specsDir)) return;

  // Skip if specs/ already has .md files (besides SPEC-TEMPLATE.md itself)
  const existingSpecs = readdirSorted(specsDir).filter(
    f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md"
  );
  if (existingSpecs.length > 0) {
    actions.push("SKIP: spec template (specs/ already has .md files)");
    return;
  }

  const templatePath = join(dirname(dirname(__dirname)), "specs", "SPEC-TEMPLATE.md");
  if (!existsSync(templatePath)) {
    actions.push("SKIP: spec template (SPEC-TEMPLATE.md not found in harness)");
    return;
  }

  const template = readFileSync(templatePath, "utf-8");
  const destPath = join(specsDir, "SPEC-TEMPLATE.md");

  // #1549: the emptiness test above excludes `SPEC-TEMPLATE.md` by name, so a
  // `specs/` holding ONLY that file reads as empty and we arrive here with the
  // consumer's own template already on disk. #1286 guarded eleven in-place
  // spec writers and missed this one, because its completeness check is built
  // from files that read and write the same path — and this writes a path it
  // never read. Ask who owns the bytes before replacing them.
  const existed = existsSync(destPath);
  if (existed) {
    const reading = readDerivedDeclaration(readFileSync(destPath, "utf-8"));
    if (!mayWrite(reading)) {
      actions.push(skipLine("specs/SPEC-TEMPLATE.md", reading));
      return;
    }
  }

  writeFileSync(destPath, template);
  // #1549: the verb is a reading, not a label. `CREATED` for a file that was
  // already on disk tells a reader scanning the report for destructive
  // actions the opposite of what happened.
  actions.push(
    `${existed ? "UPDATED" : "CREATED"}: specs/SPEC-TEMPLATE.md (starter template)`,
  );
}

// ── tsconfig.json ──────────────────────────────────────────────

// `TS_SOURCE_DIRS`, `containsTypeScript` and the directory filter all moved to
// lib/typescript-project.ts in #87. Five sites decided "is this a TypeScript
// project" and they disagreed; two copies of a predicate survive any mutation
// of either, which is what SC-842 and SC-843 already say about this file.

/**
 * Write a tsconfig.json for a TypeScript consumer that has none (#72, #65/#76).
 *
 * AGENTS.md has documented `bunx tsc --noEmit` as THE type check for every
 * scaffolded project since the scaffold existed, and `.github/workflows/ci.yml`
 * ran it — over a file rungate never created. With no tsconfig.json tsc prints
 * 147 lines of help text and exits 1, so the documented check had never checked
 * anything anywhere. `lib/generators/agents-md.ts` and `createCiWorkflows` were
 * taught to stop ADVERTISING the command without a tsconfig; this creates the
 * file so the command can be advertised again and mean something.
 *
 * Must run before AGENTS.md is generated and before createCiWorkflows: both
 * decide whether to emit the type check by looking for this file on disk.
 *
 * Never overwrites. A consumer's compiler settings are the consumer's, and
 * re-scaffold is routine.
 */
export function createTsconfig(root: string, actions: string[]): void {
  const tsconfigPath = join(root, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    actions.push("SKIP: tsconfig.json (already exists)");
    return;
  }

  // The include list, the "is this a TypeScript project" test and TSC-1's
  // applicability are the same question, answered once in
  // lib/typescript-project.ts. Deriving them separately is how you get a
  // tsconfig whose include matches no files — tsc error TS18003, which reads
  // as a broken type check rather than as "nothing to check" — and how TSC-1
  // came to hard-fail over a file this function had deliberately not written
  // (#87).
  const include = typeScriptSourceDirs(root).map(dir => `${dir}/**/*.ts`);

  if (include.length === 0) {
    actions.push(`SKIP: tsconfig.json (no TypeScript source in ${TS_SOURCE_DIRS.join("/, ")}/)`);
    return;
  }

  const tsconfig = {
    "//": "Created by rungate. Edit freely — re-scaffold never overwrites an existing tsconfig.json.",
    compilerOptions: {
      strict: true,
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
    },
    include,
    exclude: ["node_modules"],
  };

  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
  actions.push("CREATED: tsconfig.json");
}

/**
 * One `.gitignore` section, and whether an ADOPTING project must get it (#474).
 *
 * The two branches of `createGitignore` used to hold two lists written in two
 * syntaxes, and they disagreed. The fresh-template branch wrote
 * `credentials.json`; the append branch derived its own form with
 * `e.includes("*") ? e : \`${e}/\``, which appends a trailing slash — and a
 * trailing slash in gitignore syntax RESTRICTS THE PATTERN TO DIRECTORIES:
 *
 * | Intended | Appended | Matches a file `credentials.json`? |
 * |---|---|---|
 * | `credentials.json` | `credentials.json/` | no |
 * | `service-account*` | `service-account/` | no |
 *
 * Six of the eight entries are directories, so the bug was invisible for them
 * and the block it broke is the one labelled "Environment and secrets" — the
 * two entries that are FILES are the two it silently inverted. The scaffold
 * reported `UPDATED: .gitignore (added 8 missing entries)` with two of them
 * inert, on exactly the path an existing project takes when it adopts
 * rungate. Found while scaffolding a plugin whose whole integration is Google
 * Drive, where `credentials.json` is the default client-secrets filename.
 *
 * So there is ONE list, and every pattern is written here EXACTLY as it must
 * appear on disk. Nothing downstream may transform a pattern — a second place
 * that decides syntax is the shape this bug had.
 */
interface GitignoreSection {
  heading: string;
  patterns: string[];
  /**
   * Ensured when appending to a `.gitignore` that already exists. A project
   * adopting rungate keeps its own conventions for build output and editors;
   * what it does not get to opt out of is leaking a credential.
   */
  requiredOnAdoption: boolean;
}

/** The single source for both branches below. Patterns are verbatim. */
export const GITIGNORE_SECTIONS: GitignoreSection[] = [
  { heading: "Dependencies", requiredOnAdoption: true, patterns: ["node_modules/", ".bun/"] },
  // Required because the list this replaced required `dist`. Rounded up to
  // the whole section rather than down: #474 is about the two branches
  // disagreeing, and quietly shrinking what an adopting project gets would
  // be a second behaviour change hiding inside the fix for the first.
  { heading: "Build output", requiredOnAdoption: true, patterns: ["dist/", "build/", "*.tsbuildinfo"] },
  {
    heading: "Environment and secrets",
    requiredOnAdoption: true,
    patterns: [
      ".env",
      ".env.*",
      "!.env.example",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
      "credentials.json",
      "service-account*",
      ".secret*",
    ],
  },
  { heading: "Harness working directory", requiredOnAdoption: true, patterns: [".rungate/"] },
  { heading: "IDE", requiredOnAdoption: false, patterns: [".vscode/", ".idea/", "*.swp", "*.swo"] },
  { heading: "OS", requiredOnAdoption: false, patterns: [".DS_Store", "Thumbs.db"] },
  { heading: "Test artifacts", requiredOnAdoption: false, patterns: ["coverage/"] },
];

/** The patterns an adopting project must end up with, in order. */
export function requiredGitignorePatterns(): string[] {
  return GITIGNORE_SECTIONS.filter(s => s.requiredOnAdoption).flatMap(s => s.patterns);
}

/** The fresh-project file, rendered from the one list. */
export function gitignoreTemplate(): string {
  return (
    GITIGNORE_SECTIONS.map(s => `# ${s.heading}\n${s.patterns.join("\n")}\n`).join("\n") + ""
  );
}

/**
 * Which required patterns an existing `.gitignore` does not already carry.
 *
 * Compared LINE-WISE against uncommented lines, not with `existing.includes`
 * (#474). A substring test over the whole file reports `credentials.json` as
 * present because of a comment reading `# credentials.json lives in
 * 1Password`, and then appends nothing — the entry is "handled" by a sentence
 * about it. It also made `*.key` satisfied by `*.keystore` and
 * `service-account` satisfied by the longer `service-account*`, which is how
 * the two lists stayed different without anything noticing.
 */
export function missingGitignorePatterns(existing: string): string[] {
  const present = new Set(
    existing
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "" && !l.startsWith("#")),
  );
  // #586: `X/` is satisfied by an existing `X`, and ONLY in that direction.
  // This repo's `.gitignore` opens with `node_modules` and the required
  // pattern is `node_modules/`, so exact matching reported it absent and
  // every scaffold run re-added a line that changes nothing.
  //
  // The direction is the whole safety argument, and it is the opposite of
  // the trap the docstring above names. A bare `node_modules` matches files
  // AND directories, so it is STRICTLY BROADER than `node_modules/` — the
  // requirement is already met. `service-account` present against a required
  // `service-account*` is the reverse: the required pattern is broader, the
  // requirement is NOT met, and that case must keep failing.
  const satisfied = (p: string): boolean =>
    present.has(p) || (p.endsWith("/") && present.has(p.slice(0, -1)));
  return requiredGitignorePatterns().filter(p => !satisfied(p));
}

export function createGitignore(root: string, actions: string[]): void {
  const gitignorePath = join(root, ".gitignore");

  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, "utf-8");
    const missing = missingGitignorePatterns(existing);
    if (missing.length > 0) {
      // Written VERBATIM. The transform that used to live here is the bug.
      const additions = "\n# Added by rungate scaffold\n" + missing.join("\n") + "\n";
      writeFileSync(gitignorePath, existing.trimEnd() + "\n" + additions);
      actions.push(`UPDATED: .gitignore (added ${missing.length} missing entries)`);
    } else {
      actions.push("SKIP: .gitignore (all required entries present)");
    }
  } else {
    writeFileSync(gitignorePath, gitignoreTemplate());
    actions.push("CREATED: .gitignore (security template)");
  }
}

export function generateProjectState(root: string, actions: string[]): void {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) {
    actions.push("SKIP: PROJECT-STATE.md (no specs directory)");
    return;
  }

  const today = localCalendarDay();

  interface SC { id: string; what: string; done: boolean; }
  const scs: SC[] = [];

  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: specsDir, absolute: true })) {
    if (file.endsWith("SPEC-TEMPLATE.md")) continue;
    const content = readFileSync(file, "utf-8");
    for (const line of content.split("\n")) {
      const doneMatch = line.match(/^- \[x\] (SC-\d+):\s*(.+)/i);
      if (doneMatch) {
        scs.push({ id: doneMatch[1].toUpperCase(), what: doneMatch[2].trim(), done: true });
        continue;
      }
      const openMatch = line.match(/^- \[ \] (SC-\d+):\s*(.+)/i);
      if (openMatch) {
        scs.push({ id: openMatch[1].toUpperCase(), what: openMatch[2].trim(), done: false });
      }
    }
  }

  if (scs.length === 0) {
    actions.push("SKIP: PROJECT-STATE.md (no SCs found in specs)");
    return;
  }

  scs.sort((a, b) => {
    const aNum = parseInt(a.id.replace("SC-", ""));
    const bNum = parseInt(b.id.replace("SC-", ""));
    return aNum - bNum;
  });

  const state = {
    updated: today,
    priorities: ["Review and update priorities in project-state.json"],
    notes: `${scs.length} SCs discovered from specs. Organize into phases as project evolves.`,
    phases: [{ name: "Initial Implementation", scs }],
    sessions: []
  };

  const openCount = scs.filter(sc => !sc.done).length;
  const currentLabel = openCount > 0
    ? `Initial Implementation — ${openCount} SCs open`
    : "All SCs complete";

  const lines: string[] = [];
  lines.push("# Project State");
  lines.push("");
  lines.push(`**Current phase: ${currentLabel}**`);
  lines.push("");
  lines.push(state.notes);
  lines.push("");

  if (state.priorities.length > 0) {
    lines.push("**Next priorities:**");
    state.priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  lines.push(`## ${openCount === 0 ? "✅" : openCount < scs.length ? "🔄" : "⬜"} Initial Implementation (${openCount === 0 ? "COMPLETE" : openCount < scs.length ? "IN PROGRESS" : "NOT STARTED"})`);
  lines.push("");
  if (scs.length > 0) {
    lines.push("| Status | SC | What |");
    lines.push("|---|---|---|");
    for (const sc of scs) {
      lines.push(`| ${sc.done ? "✅" : "⬜"} | ${sc.id} | ${sc.what} |`);
    }
    lines.push("");
  }

  const stateJson = join(root, "project-state.json");
  const stateMd = join(root, "PROJECT-STATE.md");

  safeWrite(stateJson, JSON.stringify(state, null, 2) + "\n", "project-state.json", actions);
  safeWrite(stateMd, lines.join("\n") + "\n", "PROJECT-STATE.md", actions);
}

/**
 * Seed `SUCCESS.md`, then say out loud that the seed is not an answer (#485).
 *
 * `CLAUDE.md` opens its rules with "SUCCESS.md is the measure" and the
 * scaffold never wrote one. rungate's was hand-written once and nothing
 * reproduced it for anyone else, so a consumer scaffolded a project, read the
 * generated `AGENTS.md`, and never learned the file was supposed to exist.
 *
 * Two halves, and the second is the one that makes this more than a nicety.
 *
 * **It is `create-only`.** A project's claims are the one thing the harness
 * must never regenerate over. `safeWrite` is the single writer for that, and
 * it is delegated to rather than reimplemented for the reason recorded on
 * that function: a second copy of the decision absorbs any mutation of the
 * first.
 *
 * **The WARN reads the real checker.** `successViolations` is the same
 * binding `SUCCESS-1` refuses with, so the scaffold's warning and the
 * conformity suite's refusal cannot disagree. A second "is it filled in?"
 * predicate here would be two deciders answering one question — the fourth
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`, which no
 * behavioural test can tell apart.
 *
 * The direction this is deliberately wrong in: a project that runs the
 * scaffold and stops is now LOUDER than one that never ran it. An unfilled
 * template is refused; an absent file is only UNMEASURED. That is the point —
 * an unfilled template is indistinguishable from a considered one to
 * everything except a reader, so the generator must not make the project
 * quieter than it found it.
 */
export function seedSuccessDoc(root: string, actions: string[]): void {
  // `readSuccessTemplate()` rather than a fourth expression resolving the
  // same path. There were three — here, `lib/success-doc.ts` and
  // `scripts/create-success.ts` — agreeing today and with nothing making them
  // agree tomorrow.
  const template = readSuccessTemplate();
  if (template === TEMPLATE_MISSING) {
    // Named, not swallowed. #484 was a documented command that ENOENTed for
    // every consumer because `files[]` omitted the directory it read from,
    // and the symptom was a check that reported 21 pass over a library that
    // could not load its own data.
    actions.push(
      "WARN: SUCCESS.md not seeded — templates/SUCCESS-TEMPLATE.md is missing from this " +
        "rungate installation (see test/package-closure.test.ts)",
    );
    return;
  }

  const today = localCalendarDay();
  const owner = process.env.USER || "TODO-OWNER";
  // The SHARED substitution. Writing the template raw here while
  // `create-success` substituted meant one seed with two possible byte
  // sequences, and a scaffolded SUCCESS.md kept `owner: TODO-OWNER` forever.
  const seeded = seedFromTemplate(template, owner, today);
  safeWrite(join(root, "SUCCESS.md"), seeded, "SUCCESS.md", actions);

  const verdict = successViolations(readSuccessDoc(root), template);
  if (verdict.unmeasured) {
    actions.push(`WARN: ${verdict.unmeasured}`);
    return;
  }
  if (verdict.violations.length > 0) {
    actions.push(
      // NOT "run create-success" — by the time anyone reads this the file is
      // already there, so that command refuses and the advice is a dead end.
      `WARN: SUCCESS.md is not filled in — ${verdict.violations.length} item(s). ` +
        `The conformity suite REFUSES it in this state, deliberately. Edit ` +
        `${join(root, "SUCCESS.md")} (or re-seed it with ` +
        `\`bunx rungate create-success --force\`):`,
    );
    for (const v of verdict.violations) actions.push(`  - ${v}`);
  }
}

export function createClaudeMdBridge(root: string, actions: string[]): void {
  const claudeMdPath = join(root, "CLAUDE.md");
  const bridgeLine = "@AGENTS.md";

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    if (!existing.includes(bridgeLine)) {
      writeFileSync(claudeMdPath, existing.trimEnd() + "\n\n" + bridgeLine + "\n");
      actions.push("UPDATED: CLAUDE.md (added @AGENTS.md bridge)");
    } else {
      actions.push("SKIP: CLAUDE.md (@AGENTS.md bridge already present)");
    }
  } else {
    const content = `# Project Rules\n\n${bridgeLine}\n`;
    writeFileSync(claudeMdPath, content);
    actions.push("CREATED: CLAUDE.md (with @AGENTS.md bridge)");
  }
}

// ── Managed writes that cannot destroy a consumer's content (#216) ─────────
//
// Re-scaffolding is the documented way to BOTH onboard and update a consumer,
// and `createCiWorkflows` ended in two unconditional `writeFileSync` calls.
// The first real consumer that added a deploy job to `.github/workflows/ci.yml`
// would have lost it the moment they took an update — and the harness cannot
// generate a deploy job, so nothing could have put it back. That is SUCCESS.md
// claim 5 (the harness works on a repo that is not this one) failing in the
// most expensive way available.
//
// The design is one binding, `resolveManagedWrite`, that turns the BEFORE and
// AFTER content into the bytes to write, the verb to report, and — when the
// write would destroy something — a refusal. Detection is semantic (a YAML
// parse) and preservation is textual (a verbatim line slice). Where the two
// disagree the write is refused rather than guessed at, because a guess here
// deletes someone's pipeline.

export interface ManagedWrite {
  /** The bytes to write: generated content plus every job the harness did not author. */
  content: string;
  /** Derived from the measured before/after, never assumed by the caller. */
  verb: "CREATED" | "UPDATED" | "REPLACED" | "SKIP";
  /** after − before, in lines. Negative means content was removed. */
  lineDelta: number;
  /** Jobs carried forward from the existing file. */
  preservedJobs: string[];
  /** Jobs that could not be carried forward. Non-empty ⇒ refusal. */
  droppedJobs: string[];
  /**
   * Lines inside a harness-owned job that the regeneration overwrote.
   *
   * Not a refusal: a file whose banner says "do not edit" is the harness's to
   * rewrite, and refusing on any edit to it would make every update refuse.
   * It IS reported, because the whole of #216 is that a consumer reading the
   * log had no signal anything of theirs had gone. DailyBriefDashboard had
   * added `bun install --no-optional` inside the harness's own gates job for
   * CI resilience, and "REPLACED (+33 lines)" does not tell anyone that.
   */
  overwrittenLines: string[];
  /**
   * Top-level keys the merge put somewhere else (#482).
   *
   * Not a refusal — YAML top-level keys are order-independent, so a moved key
   * means what it meant. It IS reported, because `UPDATED` with nothing said
   * about position is a report that is accurate and still misleads: a
   * consumer's `concurrency:` arrived below `jobs:` while the comment
   * introducing it stayed above, the reader concluded it had been deleted,
   * restored it by hand, and the file stopped parsing. "Nothing was lost" and
   * "everything is where you left it" are different claims and only the first
   * was being made.
   */
  movedKeys: MovedKey[];
  /**
   * Derived grants the merge withdrew because the generator stopped computing
   * them (#923).
   *
   * Not a refusal and not an overwrite — a third thing, and it needs its own
   * field because the other two would both misreport it. In `lostLines` it is
   * a refusal over two lines the harness wrote itself; in `overwrittenLines`
   * it is a report that says "in harness-owned jobs" about a top-level key.
   *
   * Reported rather than silent, because the removal is the whole point: a
   * consumer who removes `ci.vertex` keeps `id-token: write` — the right to
   * mint an OIDC token for a federation that no longer exists — and a
   * permission nobody consumes is a permission nobody audits. Taking it away
   * without saying so would make the scaffold do, silently, the one thing
   * `ci.workflowOverrides` was built to guarantee is always visible.
   *
   * The record travels from the merge rather than being recomputed here. See
   * `mergeManagedWorkflowRecording`.
   */
  revokedGrants: RevokedSubKey[];
  /** Non-null ⇒ the write must not happen. Names the dropped jobs and the line delta. */
  refusal: string | null;
}

const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);
const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n}`;

/**
 * Top-level job names, or null when the source cannot be read as a workflow.
 *
 * Null is handled as a refusal by every caller, never as "no jobs" — a parse
 * failure that defaults to an empty list is the fail-open this whole mechanism
 * exists to avoid (.claude/rules/checks-must-be-able-to-fail.md).
 */
function workflowJobNames(src: string): string[] | null {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(src);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const jobs = (doc as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return null;
  return Object.keys(jobs as Record<string, unknown>);
}

/**
 * Verbatim text of each job block, keyed by job name.
 *
 * Deliberately narrower than the parser: it only understands a top-level
 * `jobs:` key followed by indented `name:` blocks, which is the form every
 * generator and every hand-written workflow in practice uses. A job the
 * parser can see and this cannot is reported as dropped, which refuses the
 * write — the narrowness fails closed.
 */
function sliceJobBlocks(src: string): Map<string, string> {
  const lines = src.split("\n");
  const out = new Map<string, string>();

  let i = lines.findIndex(l => /^jobs:\s*$/.test(l));
  if (i < 0) return out;
  i++;

  let childIndent = -1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // left the jobs block
    if (childIndent < 0) childIndent = indent;
    const m = indent === childIndent ? /^\s*([A-Za-z0-9_.\-]+):\s*$/.exec(line) : null;
    if (!m) { i++; continue; }

    const start = i;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") { i++; continue; }
      if (l.length - l.trimStart().length <= childIndent) break;
      i++;
    }
    let end = i;
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    out.set(m[1], lines.slice(start, end).join("\n"));
  }
  return out;
}

/** True when any non-blank line of `before` is absent from `after`. */
function removesContent(before: string, after: string): boolean {
  const kept = new Set(after.split("\n").map(l => l.trim()).filter(Boolean));
  return before.split("\n").map(l => l.trim()).filter(Boolean).some(l => !kept.has(l));
}

/**
 * The one place a scaffold action verb comes from: a comparison of the bytes
 * that were there with the bytes going out. Nothing passes a verb in, so no
 * write that removes content can be reported as a CREATED.
 */
function measureWrite(existing: string | null, next: string): { verb: ManagedWrite["verb"]; lineDelta: number } {
  if (existing === null) return { verb: "CREATED", lineDelta: lineCount(next) };
  if (next === existing) return { verb: "SKIP", lineDelta: 0 };
  return {
    verb: removesContent(existing, next) ? "REPLACED" : "UPDATED",
    lineDelta: lineCount(next) - lineCount(existing),
  };
}

/**
 * The single site that decides what a managed write does.
 *
 * Short-circuiting this to `return { content: generated, ... }` is an
 * unconditional overwrite — which is exactly the mutation
 * test/scaffold-ci-preservation-mutation.test.ts performs, so that
 * "preservation works" is a claim with a demonstrated way of being false.
 */
export function resolveManagedWrite(existing: string | null, generated: string, overrides: readonly string[] = [], provenance: MergeProvenance = "UNPROVEN", computed: ComputedSubKeys = new Map()): ManagedWrite {
  const base: ManagedWrite = {
    content: generated, verb: "CREATED", lineDelta: lineCount(generated),
    preservedJobs: [], droppedJobs: [], overwrittenLines: [], movedKeys: [], revokedGrants: [],
    refusal: null,
  };
  if (existing === null) return base;

  const before = lineCount(existing);
  const unchanged = { ...base, content: existing, verb: "SKIP" as const, lineDelta: 0 };

  const generatedJobs = workflowJobNames(generated);
  if (generatedJobs === null) {
    return { ...unchanged, refusal: `the generated workflow could not be parsed, so nothing can be compared against it (line delta ${signed(lineCount(generated) - before)})` };
  }

  const existingJobs = workflowJobNames(existing);
  if (existingJobs === null) {
    return { ...unchanged, refusal: `the existing file could not be read as a workflow, so its jobs cannot be carried forward (line delta ${signed(lineCount(generated) - before)})` };
  }

  // One merge, and it understands the whole file rather than only its jobs.
  //
  // The previous form appended consumer-only JOB blocks and computed its loss
  // set as a list of job NAMES, so content outside a job could not enter it and
  // therefore could not make a write refuse. Measured against a throwaway
  // worktree of DailyBriefDashboard at e8ef2823: every job survived and
  // `concurrency`, `cancel-in-progress`, `paths-ignore`, the top-level
  // `workflow_dispatch` trigger and the consumer's header comments were all
  // destroyed, reported as `REPLACED (+0 lines, preserved ...)` with 0 refused.
  // A refusal that is structurally incapable of firing on the thing being
  // destroyed is the defect class .claude/rules/checks-must-be-able-to-fail.md
  // exists for, and it was in the fix written to prevent a data-loss bug.
  const { content, revoked: revokedGrants } = mergeManagedWorkflowRecording(existing, generated, overrides, provenance, computed);
  const lineDelta = lineCount(content) - before;

  const preservedJobs = existingJobs.filter(j => !generatedJobs.includes(j));

  // Verify rather than assume: re-read the bytes about to be written. A merge
  // that produced unparseable YAML must refuse like any other destructive
  // write, because the consumer cannot run a file that will not parse.
  const resultJobs = workflowJobNames(content);
  if (resultJobs === null) {
    return {
      ...unchanged, preservedJobs: [], droppedJobs: existingJobs, overwrittenLines: [], movedKeys: [], lineDelta,
      refusal: `the merged workflow does not parse, so it cannot be written (line delta ${signed(lineDelta)})`,
    };
  }

  // A top-level key declared twice is a workflow YAML rejects and GitHub
  // Actions refuses to run (#482). The realistic way one appears is the
  // correction this issue is about — somebody restores a block they believe
  // the merge deleted while the original is still further down — so the
  // refusal has to look at the EXISTING file as well as the merged one, and
  // name the key rather than the symptom.
  const duplicated = [
    ...duplicateTopLevelKeys(existing).map(k => [k, "the existing file"] as const),
    ...duplicateTopLevelKeys(content)
      .filter(k => !duplicateTopLevelKeys(existing).includes(k))
      .map(k => [k, "the merged output"] as const),
  ];
  if (duplicated.length > 0) {
    return {
      ...unchanged, preservedJobs: [], droppedJobs: [], overwrittenLines: [], movedKeys: [], lineDelta,
      refusal:
        `${duplicated.length} top-level key(s) declared more than once in ` +
        `${duplicated.map(([k, where]) => `${k} (${where})`).join(", ")} — ` +
        `YAML rejects a duplicate mapping key, so the workflow would not run. ` +
        `Delete the extra declaration and re-run (line delta ${signed(lineDelta)})`,
    };
  }

  // The merge's contract since #482 is that the consumer's top-level ORDER is
  // the consumer's. So movement is no longer something to report — it is a
  // bug in the merge, and shipping one is what produced the incident: a
  // `concurrency:` block 460 lines below the comment introducing it, read as
  // a deletion, "restored", and the workflow stopped parsing.
  //
  // A refusal rather than a warning, because the cost is asymmetric. A
  // consumer who hits an unenumerated edge case gets a named refusal and
  // `--force`; a consumer who does not get one gets a file they will
  // misread. Measured against this repo's three real workflow files — one of
  // which carries a `permissions:` key between `on:` and `jobs:`, exactly the
  // shape that used to move: zero movement in all three.
  //
  // The file is not named here on purpose. `test/anti.test.ts` SC-A1 keeps
  // the scaffold from naming a workflow it does not own, and a comment is as
  // nameable as a code path.
  const movedKeys = movedTopLevelKeys(existing, content);
  if (movedKeys.length > 0) {
    return {
      ...unchanged, preservedJobs, droppedJobs: [], overwrittenLines: [], movedKeys, lineDelta,
      refusal:
        `${movedKeys.length} top-level key(s) would move: ` +
        `${movedKeys.slice(0, 3).map(m => `${m.key} (line ${m.from + 1} -> ${m.to + 1})`).join(", ")}` +
        `${movedKeys.length > 3 ? ` and ${movedKeys.length - 3} more` : ""} — ` +
        `a key that moves away from the comment introducing it reads as a deletion ` +
        `(line delta ${signed(lineDelta)})`,
    };
  }

  // The loss set is LINES, not job names. Every non-blank line the consumer
  // has that the merge did not carry is content the harness is about to drop,
  // wherever in the file it sits.
  //
  // Minus the lines the harness is entitled to rewrite, which is the same
  // ownership rule the merge states: the jobs the generator emits are the
  // harness's. Without that subtraction the harness's own stale output reads
  // as consumer content, and a regenerated `bun-version` would refuse its own
  // update — preservation by declining to write, which freezes the managed
  // half while passing every preservation assertion.
  const blocks = sliceJobBlocks(existing);
  const harnessOwned = new Set<string>();
  for (const name of generatedJobs) {
    const block = blocks.get(name);
    if (block !== undefined) for (const l of nonBlankLines(block)) harnessOwned.add(l);
  }
  // The harness's own bookkeeping lines are the harness's to reword or
  // withdraw. Without this, the first run after the banner's text changed
  // refused to update a file the harness had written itself, naming its own
  // previous sentence as consumer content it declined to drop — a refusal is
  // only useful if it is about somebody else's work. The override notice is
  // here for the same reason and one more: it is DELETED, not reworded, the
  // run after a consumer removes the config entry, so without this the way
  // back from an override is a refusal (#839).
  for (const l of nonBlankLines(existing)) {
    if (HARNESS_BOOKKEEPING_PREFIXES.some(p => l.startsWith(p))) harnessOwned.add(l);
  }

  // The harness's own preamble is the harness's to reword — the WHOLE of it
  // from the banner down, not just the banner line (#834). A bookkeeping
  // PREFIX catches the sentence it opens and nothing else, so the paragraphs
  // underneath read as consumer content: a consumer that added `ci.vertex`
  // had its re-scaffold refused over three lines of the harness's own "no
  // credential is configured" header, which is precisely the header the new
  // one replaces. The merge already declares that preamble its own, so this
  // reads the boundary from `managedPreamble` rather than restating it —
  // the two disagreeing is what made the refusal possible.
  //
  // This SUBSUMES the banner entry in `HARNESS_BOOKKEEPING_PREFIXES` for the
  // LEADING PREAMBLE, and only there. The banner of a generated workflow is
  // always in that preamble, so for the file the generator wrote the two
  // deciders cannot disagree — which is why giving the constant a second
  // spelling in this module turned 0 of 107 red when #916 landed, and why
  // saying so was cheaper than implying a guard that is not there
  // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
  //
  // "Only there" is the part that was missing, and #926 is where it was
  // measured. `managedPreamble` reads the HEAD section and returns `[]` when
  // the banner is not in it, so a bookkeeping line anywhere else in the file
  // — beside the job key it introduces, which is exactly where the override
  // notice sits — reaches this loss set with nothing above covering it. The
  // entry is what keeps it out, and the write refuses without it. Both
  // entries now carry that witness in
  // `test/scaffold-permissions-merge.test.ts`, generated from the array.
  //
  // What the entry is not any more is the thing keeping the HEADER out of the
  // loss set. That job is `harnessPreamble`'s.
  const harnessPreamble = new Set(nonBlankLines(managedPreamble(existing).join("\n")));

  // The grants the merge withdrew, as the lines it took out (#923).
  //
  // Taken FROM THE MERGE, not recomputed. A second reading here of which
  // sub-keys ought to have gone would be a decider that can disagree with the
  // one that actually removed them, and #834 is the bill for exactly that
  // arrangement: the merge computed the correct file, the write's own view of
  // what it was allowed to drop refused to put it on disk, and `id-token:
  // write` stayed off every consumer for it. Here the disagreement would run
  // the other way and be worse — a line the merge removed and this set did
  // not cover is a REFUSED re-scaffold, and a line this set covered and the
  // merge did not remove is a consumer's own content dropped in silence.
  // A MULTISET, and spending it is what makes it one. A `Set` of line TEXT
  // excuses every line in the file that happens to share that text, and
  // `  id-token: write` is a line a multi-job workflow plausibly carries more
  // than once — one legitimately withdrawn occurrence would then silently
  // excuse an unrelated one the consumer still wants. A set also cannot
  // count: two revoked and five present is indistinguishable from one and
  // one. Exactly as many occurrences are forgiven as the merge removed, and
  // the rest refuse like any other dropped line.
  const revocationBudget = new Map<string, number>();
  for (const r of revokedGrants) {
    for (const l of nonBlankLines(r.lines.join("\n"))) {
      revocationBudget.set(l, (revocationBudget.get(l) ?? 0) + 1);
    }
  }
  /** Spend one occurrence, or report that there is none left to spend. */
  const spendRevocation = (line: string): boolean => {
    const left = revocationBudget.get(line) ?? 0;
    if (left === 0) return false;
    revocationBudget.set(line, left - 1);
    return true;
  };

  const kept = new Set(nonBlankLines(content));
  const gone = nonBlankLines(existing).filter(l => !kept.has(l));
  // Order matters: `spendRevocation` is reached only when the two cheaper
  // owners decline, so a line the harness already owns does not burn a
  // revocation another occurrence may need.
  const lostLines = gone.filter(
    l => !harnessOwned.has(l) && !harnessPreamble.has(l) && !spendRevocation(l),
  );
  // Rewording its own header is not overwriting somebody's edit, and this
  // report says "in harness-owned jobs" — which the preamble is not.
  const overwrittenLines = gone.filter(
    l =>
      harnessOwned.has(l) &&
      !harnessPreamble.has(l) &&
      !HARNESS_BOOKKEEPING_PREFIXES.some(p => l.startsWith(p)),
  );
  const droppedJobs = existingJobs.filter(j => !resultJobs.includes(j));

  if (lostLines.length > 0) {
    const where = droppedJobs.length > 0
      ? `job(s) ${droppedJobs.join(", ")}`
      : "content outside any job";
    return {
      ...unchanged, preservedJobs, droppedJobs, overwrittenLines: [], movedKeys: [], lineDelta,
      refusal:
        `${lostLines.length} line(s) the harness did not author would be dropped from ${where}` +
        `: ${lostLines.slice(0, 3).map(l => JSON.stringify(l)).join(", ")}` +
        `${lostLines.length > 3 ? ` and ${lostLines.length - 3} more` : ""}` +
        ` (line delta ${signed(lineDelta)})`,
    };
  }

  // `revokedGrants` only reaches a caller on this path. Every return above is
  // a refusal and `unchanged` carries the empty list from `base`: nothing was
  // written, so nothing was withdrawn, and a report naming a grant that is
  // still in the file on disk is the reading disagreeing with reality again.
  return { content, ...measureWrite(existing, content), preservedJobs, droppedJobs: [], overwrittenLines, movedKeys, revokedGrants, refusal: null };
}

/** Non-blank lines, trimmed — the unit the loss set is counted in. */
function nonBlankLines(text: string): string[] {
  return text.split("\n").map(l => l.trim()).filter(l => l !== "");
}

/**
 * Lines in a managed file that are the harness talking to the consumer, not
 * the consumer's content.
 *
 * Both are prefixes rather than whole sentences: the rest of each names a
 * config path, and that tail is exactly the part that changes.
 *
 * EXPORTED so the list itself can be tested rather than its members (#926).
 * `test/scaffold-permissions-merge.test.ts` demands a WITNESS for every entry
 * — an input where matching the prefix is what decides the outcome — and
 * ratchets this array against the witnessed population, so an entry added
 * here with no case there is red. An entry nothing asserts reads as covered,
 * and adding the next one is how a dead decider gets in; this is what stops
 * the next one arriving dead the way the banner entry did.
 *
 * The witnesses plant lines built from the constants in `managed-workflow.ts`
 * rather than from this array, deliberately. A fixture read out of the list
 * under test matches whatever the list says and cannot see it drift.
 */
export const HARNESS_BOOKKEEPING_PREFIXES = [MANAGED_BANNER_PREFIX, WORKFLOW_OVERRIDE_COMMENT];

/**
 * The sub-keys each generated workflow COMPUTES, by file and then by the
 * top-level key they sit under (#923).
 *
 * Same shape as `HARNESS_OWNED_JOBS` and for the same reason: a
 * conditionally emitted thing cannot be recognised from the generated side
 * once it stops being emitted. `mergeTopLevelSection`'s rule — a sub-key
 * only the consumer declares is the consumer's — is right for a LOCAL KNOB
 * and wrong for a DERIVED GRANT. `pull-requests: write` that a consumer
 * added for a job of their own is theirs. `id-token: write` that this
 * generator emitted because `ci.vertex` resolved is nobody's choice; the
 * config made it, and when the config goes the justification goes with it.
 * By the time the merge runs both are just lines in the consumer's file and
 * nothing records which side wrote them, so this records it instead.
 *
 * A sub-key named here is REMOVED from the consumer's section when that
 * file's generated side does not declare it. Add a conditionally emitted
 * sub-key in the same commit that makes it conditional.
 *
 * ## Keyed by FILE, which is the whole of the scoping
 *
 * The merge runs over every managed workflow. Keyed by section alone,
 * `permissions.id-token` becomes revocable in files whose generator never
 * emits it under any config — and all three of these emit a top-level
 * `permissions:`, so a consumer with a deploy job of their own would have
 * the grant withdrawn out of a workflow this feature was not reasoning
 * about. That is #923's own defect wearing the other hat: the issue is a
 * grant outliving its reason, and an unscoped revoker is a WITHDRAWAL
 * outliving its reason.
 *
 * Declared HERE rather than in `managed-workflow.ts` because the write loop
 * below is the only place that knows which file it is writing, and because
 * this module already spells that tuple as a literal for
 * `test/release-guard.test.ts`. A file absent from this map revokes nothing.
 *
 * ## Scoped to what the generator COMPUTES
 *
 * Not to everything it emits. `contents: read` is unconditional in all three
 * files, so both sides always declare it, #839's rule already settles it,
 * and an entry for it would be one no input can reach.
 * `test/scaffold-permissions-merge.test.ts` holds this map against the
 * generators themselves — it scaffolds every generated workflow with and
 * without the config that drives the grant and takes the per-file symmetric
 * difference of the emitted sub-keys — so the population is read off the
 * emitting module rather than off this list, and an entry for a file whose
 * generator never computes the sub-key is red.
 *
 * ## Not `ci.workflowOverrides`, which could not be the mechanism
 *
 * That is an opt-OUT: a consumer names a key and the merge stops touching
 * it. Revocation needs the opposite default, because the consumer who has
 * stopped using Vertex is exactly the consumer who will not think to declare
 * anything about it. The override still wins where it is declared — naming
 * the top-level key short-circuits `mergeTopLevelSection` before this is
 * read — so the escape hatch covers the path with no new config surface.
 */
export const HARNESS_COMPUTED_SUBKEYS: ReadonlyMap<string, ComputedSubKeys> = new Map([
  ["ai-review.yml", new Map([["permissions", new Set(["id-token"])]])],
]);

/**
 * Write a harness-managed file, preserving whatever the harness did not author.
 *
 * Throws on refusal. Callers decide whether a refusal aborts the run or is
 * recorded and reported; what they may not do is write anyway.
 */
/**
 * How a managed file carries the record of who wrote it (#767).
 *
 * Optional, because most managed files have no marker. When present it is
 * applied LAST, to the bytes that land on disk, and stripped from both sides
 * of every comparison — a marker that describes anything other than the file
 * it is attached to is worse than no marker, because the census believes it.
 */
export interface WriteProvenance {
  /** The document with its marker line removed. */
  body(text: string): string;
  /** The document with a marker describing its own body. */
  stamp(text: string): string;
}

export function writeManagedFile(
  filePath: string,
  generated: string,
  label: string,
  actions: string[],
  opts: { force?: boolean; workflowOverrides?: readonly string[]; computedSubKeys?: ComputedSubKeys } = {},
  provenance?: WriteProvenance,
): void {
  const raw = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  // The marker is stripped from BOTH sides before anything compares them, and
  // re-applied to whatever is about to be written (#767).
  //
  // It has to be both sides and it has to be last. `resolveManagedWrite`
  // treats every line outside a job as the consumer's, so the OLD marker —
  // which differs from the new one exactly when the generator changed — read
  // as content about to be dropped and REFUSED the write. And stamping the
  // generated text before the merge produced a file whose marker described
  // bytes that were never written, so a workflow with one preserved job was
  // classified `generated-and-hand-edited` for ever, about bytes the harness
  // itself had just written.
  const existing = raw === null ? null : (provenance ? provenance.body(raw) : raw);
  const incoming = provenance ? provenance.body(generated) : generated;
  // What the marker proves about the bytes on disk, read HERE because here is
  // the only layer that still holds them (#957). Everything below this line
  // has had the marker stripped, which is the whole reason #941 could not
  // repair the residue it left: the merge was handed a file with no way of
  // telling its own old output from the consumer's.
  //
  // One expression, over the `WriteProvenance` the caller already supplies:
  // re-stamping the body reproduces the file exactly when the marker is
  // present AND describes that body. An absent marker and a stale one are both
  // UNPROVEN, which is the only distinction the merge acts on, and a managed
  // file with no provenance at all reads as UNPROVEN too — the fail-closed
  // direction and the pre-#957 behaviour unchanged.
  const proven: MergeProvenance =
    provenance !== undefined && raw !== null && provenance.stamp(provenance.body(raw)) === raw
      ? "VERIFIED"
      : "UNPROVEN";
  const resolved = resolveManagedWrite(existing, incoming, opts.workflowOverrides ?? [], proven, opts.computedSubKeys ?? new Map());
  /** The bytes that land on disk: the decision's content, then the marker. */
  const stamped = (content: string): string => (provenance ? provenance.stamp(content) : content);

  if (opts.force) {
    // The escape hatch, and it still reports a measured verb: --force changes
    // what is ALLOWED, not what gets claimed about it. The dropped jobs are
    // still named, because an operator who overrides the refusal should be
    // told in the report exactly what they overrode.
    const bytes = stamped(incoming);
    if (bytes === raw) { actions.push(`SKIP: ${label} (unchanged)`); return; }
    const { verb, lineDelta } = measureWrite(existing, incoming);
    const dropped = resolved.droppedJobs.length > 0 ? `, dropped ${resolved.droppedJobs.join(", ")}` : "";
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
    actions.push(`${verb === "SKIP" ? "UPDATED" : verb}: ${label} (--force, ${signed(lineDelta)} lines${dropped})`);
    return;
  }

  if (resolved.refusal) {
    throw new Error(`${label}: ${resolved.refusal}. Re-run the scaffold with --force to overwrite it anyway.`);
  }

  // Named even on the no-op path: "unchanged" and "unchanged because three of
  // your jobs were carried back in" are different facts, and only the second
  // one tells a consumer the preservation is actually running.
  const kept = resolved.preservedJobs.length > 0 ? `, preserved ${resolved.preservedJobs.join(", ")}` : "";

  // The other half of the same honesty. A regeneration that overwrote an edit
  // a consumer made inside a harness-owned job is allowed, and it is the thing
  // they most need told: #216 is a log that said CREATED while 470 lines went.
  const over = resolved.overwrittenLines;
  const overwrote = over.length === 0
    ? ""
    : `, overwrote ${over.length} edited line(s) in harness-owned jobs: ` +
      `${over.slice(0, 2).map(l => JSON.stringify(l)).join(", ")}` +
      `${over.length > 2 ? ` and ${over.length - 2} more` : ""}`;

  const bytes = stamped(resolved.content);

  // Compared as BYTES, not as a verb. `resolved.verb` is a statement about
  // the bodies, and a file whose body is unchanged can still need writing —
  // its marker may be absent or describe something else. Reporting SKIP on
  // that file is how the stamp stayed wrong across every later run.
  if (bytes === raw) {
    actions.push(`SKIP: ${label} (unchanged${kept})`);
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  if (resolved.verb === "SKIP") {
    // Body identical, marker not. Said plainly rather than as `UPDATED (+0
    // lines)`, which is the line an operator reads as "my generator change
    // landed" (#767).
    actions.push(`UPDATED: ${label} (provenance marker refreshed, +0 lines${kept})`);
  } else {
    actions.push(`${resolved.verb}: ${label} (${signed(resolved.lineDelta)} lines${kept}${overwrote})`);
  }
  actions.push(...revocationActions(label, resolved.revokedGrants));
}

/**
 * One line per grant the merge withdrew (#923).
 *
 * Its OWN line rather than a parenthetical on the write, and after the write
 * rather than folded into it. "REPLACED (-74 lines)" is already true of a
 * re-scaffold that withdraws nothing, so a consumer cannot read a withdrawal
 * out of it, and the thing being reported is not a line count: a standing
 * right to mint a credential has been taken away. That is the fact #631 says
 * nobody audits, and burying it inside a byte-delta is how it goes on not
 * being audited.
 *
 * The reason given is the one THIS layer actually knows — the generator
 * computes this sub-key and has stopped computing it — and not the config
 * entry that drove it. The merge cannot see `ci.vertex`; a sentence naming it
 * here would be a second, unverified reading of the generator's own decision,
 * and it would be wrong the first time a different sub-key joins the map.
 */
function revocationActions(label: string, revoked: readonly RevokedSubKey[]): string[] {
  return revoked.map(r => {
    // The override hatch is named per TOP-LEVEL key, so an authored path
    // (`on.pull_request`) has to advise `on` and not the path it was found
    // at. Advice naming a key `ci.workflowOverrides` would reject is worse
    // than none: the consumer follows it and the filter goes anyway.
    const topLevel = r.section.split(".")[0];
    const keep =
      `Name \`${topLevel}\` in \`ci.workflowOverrides\` to keep it, and re-scaffold.`;
    return r.reason === "authored"
      ? `REVOKED: ${label} no longer declares \`${r.section}: ${r.key}\` — the harness ` +
          `authors that path and this version of the generator does not emit it, so the ` +
          `value here is one the harness itself wrote and has since changed its mind ` +
          `about. ${keep}`
      : `REVOKED: ${label} no longer declares \`${r.section}: ${r.key}\` — the harness ` +
          `computes that sub-key and this project's \`ci\` config no longer produces it, so ` +
          `the grant has nothing left to justify it. ${keep}`;
  });
}

/** One globally installed CI tool, and the exact version it is pinned to. */
export interface GlobalToolPin {
  package: string;
  version: string;
}

export interface GlobalToolDecision {
  /** YAML spliced into the test job ahead of the test step. Never empty. */
  step: string;
  /** What will be installed, in declaration order. */
  pins: GlobalToolPin[];
  /** Why this and not something else. */
  reason: string;
  /** Declarations refused, each naming itself, so the omission is visible. */
  rejected: string[];
}

/** An npm package name, optionally scoped. Excludes every shell metacharacter. */
const SAFE_GLOBAL_TOOL_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * An EXACT version. Deliberately not a semver test and deliberately not a
 * range: `^1.2.0`, `latest` and `next` all resolve to whatever shipped today,
 * which is the state #597 is about, and admitting one here would be a fix
 * that looks like the fix while reintroducing the defect.
 */
const PINNED_GLOBAL_TOOL_VERSION = /^[0-9][A-Za-z0-9.+-]*$/;

/**
 * A value on its way into a generated YAML comment.
 *
 * Only REJECTED entries ever reach a comment, and they are rejected precisely
 * because they did not match the two charsets above — so this is the one
 * place in the generator that formats a string nothing has validated. A
 * newline in it ends the comment, and the next line is a step.
 *
 * That was live, not theoretical. Before this function existed, a config
 * declaring a package named `pwned\n      - name: Injected step\n
 * run: echo INJECTED` produced a generated `ci.yml` containing exactly that
 * step, runnable. The version field did the same, and a config pairing one
 * VALID pin with one evil entry injected through the success path too,
 * because the refusals string is appended there as well.
 *
 * The accepted path does not need this — it is charset-validated and single
 * quoted, two defences chosen to agree. The rejection path is the one that
 * handles hostile input by definition, which is what made it the hole: the
 * branch whose whole job is to refuse an unsafe declaration was the branch
 * that emitted it verbatim.
 */
function commentSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

/**
 * The global-install step for the generated CI test job (#597).
 *
 * `lib/compliance.ts` decides three Layer 1 verdicts by spawning `agnix` and
 * `npx @reporails/cli`. CI installed neither, so the registry's mood at that
 * moment was the verdict — an identical SHA re-ran red to green with no code
 * change. The versions live in ONE position, `ci.globalTools` in
 * `.claude/rungate/config.json`; this function carries none of them, for the
 * same reason `setupBunWith` carries no Bun version (#622) and the test step
 * carries no command (#488).
 *
 * It returns LINES rather than writing, which is what lets a test assert the
 * emission for a declaration no registry has ever served.
 *
 * `npm install -g` rather than `bun add -g`: the consumers are
 * `probeExternalTool("agnix", …)`, which wants a binary on PATH, and
 * `npx @reporails/cli`, which resolves through npm.
 *
 * The absent case emits a REASON, not silence —
 * `.claude/rules/config-access.md`: `0`, `{}`, `null` and nothing at all are
 * indistinguishable from success. Same shape as `typecheckStep` below.
 */
/**
 * How many CI shards to split the test files across (#728).
 *
 * One exported binding, read off the same `ci` object as its siblings, so
 * there is one thing to mutate and the generator cannot grow a second
 * opinion about the shard count.
 *
 * **Absent means 1, and 1 means the single-job workflow byte for byte.** A
 * consumer who has never configured this gets exactly what they have today;
 * sharding is something a project opts into once its suite is slow enough to
 * be worth the runners.
 *
 * Refuses anything that is not a positive whole number, and refuses silently
 * upward rather than downward — a malformed value yields 1 (no sharding),
 * never 0 shards, because a matrix with an empty list runs NO tests and
 * reports success. `0`, `{}` and `null` are indistinguishable from a clean
 * result (`.claude/rules/config-access.md`); a suite that ran nothing and a
 * suite that passed must not produce the same verdict.
 *
 * Capped at 32: the shard count becomes a matrix leg, and an unbounded value
 * read from config is an unbounded number of runners billed to whoever
 * mistyped it.
 */
export function shardCount(ci: unknown): number {
  const raw = (ci as { shards?: unknown } | null | undefined)?.shards;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return 1;
  return Math.min(raw, 32);
}

/**
 * The one non-zero exit the shard aggregate ever takes (#1181).
 *
 * Declared once, and spelled nowhere else in the script, so
 * `test/ci-shard-aggregate-measured.test.ts` can build a mutant copy with it
 * set to `0` and prove each refusal is the thing the case observed rather
 * than something that happened to be red —
 * `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job is
 * to exit non-zero".
 */
export const SHARD_AGGREGATE_REFUSAL_EXIT = 1;

/**
 * Environment variable names the shard aggregate's script reads (#1181).
 *
 * The script contains **no `${{ }}` expression at all**. Every GitHub-side
 * value arrives through the step's `env:`, which is what makes the shipped
 * script text executable by a test that plants a marker directory on disk. A
 * script that can only run inside Actions is a script no negative control can
 * reach, and the negative control is the whole of #1181.
 */
export const SHARD_AGGREGATE_ENV = {
  rollup: "SHARD_ROLLUP",
  expected: "SHARD_EXPECTED",
  jobName: "SHARD_JOB_NAME",
  attempt: "SHARD_ATTEMPT",
  markerDir: "SHARD_MARKER_DIR",
} as const;

/**
 * Environment variable names the per-shard marker step writes from (#1190).
 *
 * Separate from `SHARD_AGGREGATE_ENV` because they are read on the other side
 * of the fan-in, by a different job, and a single map would suggest one step
 * sets them all.
 */
export const SHARD_MARKER_ENV = {
  index: "SHARD_INDEX",
  status: "SHARD_STATUS",
  attempt: "SHARD_ATTEMPT",
  dir: "SHARD_MARKER_DIR",
} as const;

/**
 * The artifact name one shard's marker is uploaded under (#1190).
 *
 * The full name is `<prefix><run_attempt>-<shard>`, and **both** halves are
 * load-bearing.
 *
 * `<shard>` because v4 artifacts are immutable and names must be unique
 * within a run — the shape `actions/upload-artifact`'s own README prescribes
 * for a matrix.
 *
 * `<run_attempt>` because **artifacts are scoped to the RUN, not the
 * attempt**, and that was measured rather than assumed. On run `39835866754`
 * a two-leg matrix was re-run with "Re-run failed jobs"; on attempt 2 the
 * aggregate's download reported `Found 2 artifact(s)` and read
 * `shard-1 => success attempt=1` — evidence written by a leg that **did not
 * execute in attempt 2 at all**. Without the attempt in the name, a re-run in
 * which a leg never executes reads that leg's stale `success` as proof it
 * ran, which is #1181 reintroduced with a required check gone green over
 * shards that did not run.
 *
 * The aggregate matches on the prefix rather than enumerating names, so the
 * two sides agree through this one declaration instead of through two copies
 * of a loop bound. It downloads EVERY attempt's artifacts deliberately: a
 * pattern narrowed to this attempt would make a stale leg indistinguishable
 * from a leg that never ran, and those want different sentences.
 */
export const SHARD_MARKER_ARTIFACT_PREFIX = "rungate-shard-marker-";

/** The file one shard writes inside its marker directory, by index. */
export const SHARD_MARKER_FILE_PREFIX = "shard-";

/**
 * The shard aggregate's verdict script — it asserts that it MEASURED (#1181).
 *
 * ## What went wrong
 *
 * PR #1154 merged on run `39799846607`. `test-shard (1)`, `(2)` and `(3)` were
 * `queued` with `completed_at: null` and **no conclusion**; only shard 4 ran.
 * The aggregate read `needs.test-shard.result` as `success`, printed "All 4
 * shards passed", and went green in three seconds. `test` is a required check
 * and auto-merge is armed repo-wide, so a quarter of the suite authorised the
 * merge. The three preceding `main` runs were 4/4 — this was an anomaly, not
 * the pattern, and **the cause of the non-conclusion is unknown**. A fix that
 * depended on knowing it would not be a fix.
 *
 * `if: always()` was added so a **failed or cancelled** shard still reaches
 * this job. It does nothing about a shard that never concludes, because
 * `needs.<job>.result` collapses a whole matrix into one word and that word
 * was `success`.
 *
 * ## What this does instead
 *
 * The rollup is still read first, so a failed or a cancelled shard produces
 * exactly the diagnostic it produces today. Then the job counts the markers
 * the shards wrote **about themselves** — one tiny artifact per matrix leg,
 * uploaded by the leg as its last step — and refuses unless there is one per
 * declared shard and every one of them says `success`. The printed count is
 * the measured one, never the generated one: a sentence that says "4" because
 * the generator wrote "4" is the thing that lied on `39799846607`.
 *
 * Every reading that cannot be taken is a refusal. No marker directory, a
 * missing marker, an unreadable marker, a malformed count — all exit
 * non-zero, because UNMEASURED is not a pass.
 *
 * ## Why not the Actions API (#1190)
 *
 * #1189 answered the same question with `gh api …/jobs`, which worked and
 * cost every consumer two things the generated `test` job never needed
 * before: **`gh` on the runner image**, which is a GitHub-hosted-image fact
 * and not a runner fact — a self-hosted or container `runs-on`, which
 * `ci.runner` lets a consumer choose, has no `gh` — and **`actions: read` on
 * the job's token**. A marker needs neither. The runner reaches the artifact
 * service for the run it is already in, so upload and same-run download take
 * no `permissions:` scope and no token at all (`actions/download-artifact`'s
 * README: a `github-token` and `actions: read` are "required when downloading
 * artifacts from a different repository or from a different workflow run").
 *
 * A marker is also strictly better evidence than a conclusion. The API says
 * what GitHub recorded about a job; a marker is a file the job's own shell
 * wrote, so a leg that was created and then never executed leaves nothing
 * behind — which is exactly `39799846607`'s three queued shards.
 *
 * And the poll is gone with it. It existed for API propagation lag; a marker
 * uploaded before the leg concluded is downloadable the moment `needs` lets
 * this job start, so there is no lag to wait out and no `SHARD_POLL_*` knob
 * to surface in config.
 */
export function buildShardAggregateScript(): string {
  const E = SHARD_AGGREGATE_ENV;
  return `set -uo pipefail

# 1. The rollup, read exactly as it is read today. A failed or a cancelled
#    shard reaches this job through \`if: always()\` and refuses here, with
#    the same sentence it has always printed.
rollup="\${${E.rollup}:-}"
if [ "$rollup" != "success" ]; then
  echo "::error::test-shard concluded '$rollup' — the suite is not green."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

# 2. A success rollup is not a measurement. Everything below establishes how
#    many shards this run actually EXECUTED (#1181).
expected="\${${E.expected}:-}"
case "$expected" in
  "" | *[!0-9]*)
    echo "::error::${E.expected} is '$expected', which is not a shard count. UNMEASURED, so refusing."
    exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
    ;;
esac
if [ "$expected" -lt 1 ]; then
  echo "::error::${E.expected} is $expected, so this job would assert nothing. UNMEASURED, so refusing."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

job_name="\${${E.jobName}:-test-shard}"

# 3. THIS attempt. Artifacts belong to the run, not the attempt — measured on
#    run 39835866754, where attempt 2's download reported \`Found 2
#    artifact(s)\` and handed back a marker a leg wrote in attempt 1 and never
#    rewrote, because that leg did not execute in attempt 2 at all. Reading it
#    as evidence about attempt 2 is #1181 with a required check green over
#    shards that did not run, so the attempt is part of what gets checked.
attempt="\${${E.attempt}:-}"
case "$attempt" in
  "" | *[!0-9]*)
    echo "::error::${E.attempt} is '$attempt', which is not a run attempt, so no marker can be dated. UNMEASURED, so refusing."
    exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
    ;;
esac

# 4. The evidence, written by the shards about THEMSELVES. Each leg's last
#    step writes one file naming its own status and uploads it; a leg that
#    was created and never executed uploads nothing, and nothing is exactly
#    what run 39799846607's three queued shards would have left (#1190).
dir="\${${E.markerDir}:-}"
if [ -z "$dir" ]; then
  echo "::error::${E.markerDir} is unset, so this job has nowhere to read the shards' own evidence."
  echo "::error::the shard count is UNMEASURED, which is not a pass. Refusing."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi
if [ ! -d "$dir" ]; then
  # The download produced nothing at all. This is the one branch most likely
  # to be written fail-open — the download step is \`continue-on-error\` so
  # that the refusal is THIS script's, with a sentence, rather than the
  # action's bare red — and fail-open here reproduces the defect exactly.
  echo "::error::no shard markers were downloaded: '$dir' does not exist, so not one of the $expected shards left evidence that it ran."
  echo "::error::the shard count is UNMEASURED, which is not a pass. Refusing."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

# Every artifact directory belonging to THIS attempt. Counted off the disk
# rather than off the 1..expected walk below, so a leg that contributed more
# than its own evidence disagrees out loud instead of being skipped by a loop
# that only looks where it expects.
found=0
for art in "$dir"/${SHARD_MARKER_ARTIFACT_PREFIX}"$attempt"-*; do
  [ -d "$art" ] || continue
  found=$((found + 1))
done

passed=0
missing=0
stale=0
unbound=0
detail=""
n=1
while [ "$n" -le "$expected" ]; do
  want="${SHARD_MARKER_FILE_PREFIX}$n"
  art="$dir/${SHARD_MARKER_ARTIFACT_PREFIX}$attempt-$n"

  if [ ! -d "$art" ]; then
    # No evidence from this attempt. Evidence from an EARLIER one is not
    # evidence about this one, but it is a different diagnosis and gets a
    # different sentence: a partial re-run leaves exactly this state for
    # every leg GitHub chose not to re-run.
    older=""
    for cand in "$dir"/${SHARD_MARKER_ARTIFACT_PREFIX}*-"$n"; do
      [ -d "$cand" ] || continue
      older="$older \${cand##*/}"
    done
    if [ -n "$older" ]; then
      stale=$((stale + 1))
      detail="$detail \\"$job_name ($n)\\"=only-from:$older"
    else
      missing=$((missing + 1))
      detail="$detail \\"$job_name ($n)\\"=no-marker"
    fi
    n=$((n + 1))
    continue
  fi

  # One artifact carries one leg's marker and nothing else. The upload names
  # a single FILE, so this can only fail if something upstream changed —
  # which is the point: "each leg produced its own marker" is the claim, and
  # a flattened directory read by filename alone does not measure it.
  files=0
  for f in "$art"/*; do
    [ -f "$f" ] || continue
    files=$((files + 1))
  done
  if [ "$files" -ne 1 ] || [ ! -f "$art/$want" ]; then
    unbound=$((unbound + 1))
    detail="$detail \\"$job_name ($n)\\"=artifact-holds-$files-file\\(s\\)-not-just-$want"
    n=$((n + 1))
    continue
  fi

  # \`|| true\` rather than a bare \`read\`. GitHub runs a \`run:\` block as
  # \`bash -e\`, and under errexit a \`read\` that returns non-zero aborts the
  # shell THERE — so the handlers below never run and the operator gets a red
  # job with no sentence saying why. Measured in #1191 on this same step.
  mstatus=""
  mattempt=""
  mshard=""
  read -r mstatus mattempt mshard < "$art/$want" || true

  # The body is the SECOND binding, independent of the name. A name is a
  # convention the generator controls; a body is a reading. A generator bug
  # that templates the wrong attempt into the name is caught here and only
  # here — which is why adding the attempt to the name alone is not the fix.
  if [ "$mattempt" != "$attempt" ] || [ "$mshard" != "$n" ]; then
    unbound=$((unbound + 1))
    detail="$detail \\"$job_name ($n)\\"=marker-says-attempt-'$mattempt'-shard-'$mshard'"
    n=$((n + 1))
    continue
  fi

  case "$mstatus" in
    success) passed=$((passed + 1)) ;;
    "") detail="$detail \\"$job_name ($n)\\"=empty-marker" ;;
    *) detail="$detail \\"$job_name ($n)\\"=$mstatus" ;;
  esac
  n=$((n + 1))
done

if [ "$missing" -ne 0 ]; then
  echo "::error::$missing of $expected shards left NO marker, so they never executed:$detail"
  echo "::error::a shard that never ran is UNMEASURED, not a pass — this is #1181, where three of four were queued and the aggregate went green."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

if [ "$stale" -ne 0 ]; then
  echo "::error::$stale of $expected shards left no marker for attempt $attempt, only for an earlier one:$detail"
  echo "::error::artifacts belong to the RUN, not the attempt, so an older marker is readable here and says nothing about attempt $attempt. Re-run ALL jobs — a partial re-run leaves the legs it did not re-run UNMEASURED, and UNMEASURED is not a pass."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

if [ "$unbound" -ne 0 ]; then
  echo "::error::$unbound of $expected shard markers do not identify the leg and attempt that wrote them:$detail"
  echo "::error::evidence that cannot be tied to one leg of this attempt is UNMEASURED, not a pass. Refusing."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

if [ "$found" -ne "$expected" ]; then
  echo "::error::attempt $attempt left $found shard-marker artifacts, and the matrix declares $expected. The aggregate cannot speak for a suite it did not measure."
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

if [ "$passed" -ne "$expected" ]; then
  echo "::error::$passed of $expected shards concluded success:$detail"
  exit ${SHARD_AGGREGATE_REFUSAL_EXIT}
fi

# $passed is the measured count, never the generated one. The sentence on
# run 39799846607 said "All 4 shards passed" because the generator wrote 4.
echo "All $passed shards concluded, and all $passed passed."
`;
}

/**
 * The steps one matrix leg runs to leave evidence that it executed (#1190).
 *
 * Two steps rather than one: a shell step writes the file, and
 * `actions/upload-artifact` carries it to the one place a sibling job can
 * read. Both are `if: always()`, because a leg that FAILED still executed and
 * the aggregate distinguishes "ran and was red" from "never ran" — collapsing
 * those two is #1181.
 *
 * The artifact name carries the run attempt as well as the matrix index, and
 * so does the marker's BODY. Two independent bindings, because a name is a
 * convention the generator controls and a body is a reading: a generator that
 * templated the wrong expression into the name would still be caught. The
 * attempt is there because artifacts are scoped to the run — see
 * `SHARD_MARKER_ARTIFACT_PREFIX` for the run this was measured on.
 *
 * The attempt in the name also removes the need for `overwrite`, which the
 * first draft of #1190 carried: names are now unique per attempt, so a
 * re-running leg collides with nothing and no deletion primitive is needed.
 *
 * `path:` names a single FILE, not the directory. A directory upload plus the
 * aggregate's `merge-multiple` flatten would discard the name's binding on
 * the reading side — a leg that wrote `shard-1`, `shard-2`, `shard-3` into
 * its own temp directory would contribute evidence for legs it is not, and
 * "each leg produced its own marker" would not be what the check measures.
 * Measured on run 39836500284: the leg writes a decoy `shard-99` and the
 * artifact carries only `shard-<its own index>`.
 *
 * The directory is created FRESH each run, so nothing an earlier step left
 * behind can ship as evidence.
 *
 * `if-no-files-found: error` because a marker step that produced no file is a
 * shard whose evidence is UNMEASURED, and the honest place to say so is in
 * the leg that failed to write it.
 */
export function buildShardMarkerSteps(indent: string): string {
  const M = SHARD_MARKER_ENV;
  const dir = `\${{ runner.temp }}/rungate-shard-marker`;
  const file = `${SHARD_MARKER_FILE_PREFIX}\${{ matrix.shard }}`;
  const lines = [
    `# #1190. The aggregate below counts these instead of asking the Actions`,
    `# API: \`gh\` is a GitHub-hosted-image fact rather than a runner fact, and`,
    `# \`actions: read\` is a scope a consumer's token has to be granted. A`,
    `# marker needs neither — same run, same artifact service.`,
    `- name: Record that this shard executed`,
    `  if: always()`,
    `  env:`,
    `    ${M.index}: \${{ matrix.shard }}`,
    `    ${M.status}: \${{ job.status }}`,
    `    ${M.attempt}: \${{ github.run_attempt }}`,
    `    ${M.dir}: ${dir}`,
    `  run: |`,
    `    # Fresh, so nothing an earlier step left behind ships as evidence.`,
    `    rm -r "$${M.dir}" 2>/dev/null || true`,
    `    mkdir -p "$${M.dir}"`,
    `    # status, attempt and leg — the body the aggregate cross-checks`,
    `    # against the artifact's own name.`,
    `    printf '%s %s %s\\n' "$${M.status}" "$${M.attempt}" "$${M.index}" > "$${M.dir}/${SHARD_MARKER_FILE_PREFIX}$${M.index}"`,
    `- uses: ${actionRef("actions/upload-artifact")}`,
    `  if: always()`,
    `  with:`,
    `    name: ${SHARD_MARKER_ARTIFACT_PREFIX}\${{ github.run_attempt }}-\${{ matrix.shard }}`,
    `    # One FILE, so this leg cannot ship evidence about another leg.`,
    `    path: ${dir}/${file}`,
    `    if-no-files-found: error`,
    `    retention-days: 1`,
  ];
  return lines.map(line => `${indent}${line}`).join("\n");
}

/** Indent a script for a YAML block scalar, leaving blank lines blank. */
function indentedScript(script: string, indent: string): string {
  return script
    .trimEnd()
    .split("\n")
    .map(line => (line ? `${indent}${line}` : ""))
    .join("\n");
}

/**
 * Top-level workflow keys this consumer has taken back from the generator
 * (#839). Declared in `lib/scaffold/managed-workflow.ts`, beside the merge
 * that consumes it and the notice it makes the merge write.
 *
 * Re-exported from here, unmoved as far as every caller is concerned, because
 * `lib/conformity.ts` needs the same reading (#915) and importing this module
 * to get it would pull the whole scaffold generator graph — the scanner, the
 * spec auditor, every generator — into the conformity suite of every consumer
 * project. `managed-workflow.ts` imports `crypto` and nothing else.
 *
 * One binding, so there is one thing to mutate. A second reader in
 * `conformity.ts` would agree with this one on every input the suite has, and
 * two deciders that agree are behaviourally one
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export { workflowOverrides } from "./managed-workflow";

export function globalToolInstallStep(ci: unknown, indent = "      "): GlobalToolDecision {
  const declared = (ci as { globalTools?: unknown } | null | undefined)?.globalTools;
  const entries =
    declared !== null && typeof declared === "object" && !Array.isArray(declared)
      ? Object.entries(declared as Record<string, unknown>)
      : [];

  const pins: GlobalToolPin[] = [];
  const rejected: string[] = [];
  for (const [name, raw] of entries) {
    const version = typeof raw === "string" ? raw.trim() : "";
    if (!SAFE_GLOBAL_TOOL_PACKAGE.test(name)) {
      rejected.push(`${commentSafe(name)}@${commentSafe(version) || "(nothing)"} (not an npm package name)`);
      continue;
    }
    if (!PINNED_GLOBAL_TOOL_VERSION.test(version)) {
      rejected.push(`${commentSafe(name)}@${commentSafe(version) || "(nothing)"} (not an exact version)`);
      continue;
    }
    pins.push({ package: name, version });
  }

  const refusals = rejected.length === 0 ? "" : ` Refused, and so NOT installed: ${rejected.join("; ")}.`;

  if (pins.length === 0) {
    const reason =
      entries.length === 0 ? "the config declares no ci.globalTools" : "every ci.globalTools entry was refused";
    return { step: `\n${indent}# No global tools installed: ${reason}.${refusals}`, pins, reason, rejected };
  }

  // Validated AND quoted, chosen to agree: the charset above admits nothing
  // the single quotes would have to defend against, which is what makes
  // neither defence a place for the other to be relaxed.
  const specs = pins.map(p => `'${p.package}@${p.version}'`).join(" ");
  return {
    // The versions appear on the `run:` line and nowhere else in the emitted
    // YAML, so a test asserting the pin is asserting the command rather than
    // a comment that happens to quote it.
    step:
      `\n${indent}# Pinned by ci.globalTools in .claude/rungate/config.json — one declaration (#597).` +
      (rejected.length === 0 ? "" : `\n${indent}#${refusals}`) +
      `\n${indent}- name: Install pinned global tools` +
      `\n${indent}  run: npm install -g ${specs}`,
    pins,
    reason: `ci.globalTools pins ${pins.map(p => `${p.package}@${p.version}`).join(", ")}`,
    rejected,
  };
}

/**
 * The top-level concurrency block for the CI workflow.
 *
 * The GROUP does the work here, not the flag. A run can only be cancelled by
 * another run in the SAME group, so a key that is unique per main commit makes
 * the question moot — there is never a second occupant to do the cancelling.
 *
 * #937 tried the other arrangement: a ref-keyed group with
 * `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`. It does not
 * work. Measured on this repository's own main after it shipped (#952): three
 * push runs cancelled inside eight minutes with that expression in the file,
 * one of them one second after the next run was created, and every cancelled
 * run had job count 0 — cancellation at queue time. The mechanism is
 * UNMEASURED; the leading hypothesis is that the result coerces to the
 * non-empty string "false", which is truthy. This form does not depend on
 * knowing which, and that is the point of choosing it.
 *
 * The three events:
 *
 *   - A pull request's ref is `refs/pull/<n>/merge`, unique to that PR, so a
 *     new push to PR #5 can only ever cancel PR #5. Superseding it is the
 *     point: the older commit's result is about code nobody will merge.
 *
 *   - A push to main shares ONE ref with every other push to main. Two merges
 *     landing within a few minutes cancel the first, and the first is the only
 *     run that ever builds that commit — a gap in main's history with no red
 *     check anywhere to say so. Measured on one consumer: five cancelled runs,
 *     all of them main pushes, and the `test` job runs on main push there, so
 *     what was lost was a test result and not just a container build. The repo
 *     and the run IDs are on #937 — the harness does not name its consumers
 *     (#304), and `test/anti.test.ts` SC-A1 is the check that says so.
 *
 *   - `merge_group` must not be cancelled either. A queue entry builds its own
 *     `gh-readonly-queue/...` ref, so it is already alone in its group, and
 *     cancelling one mid-flight dequeues the PR behind it.
 *
 * So: a push keys on `github.sha`, unique per commit and therefore never
 * shared. Everything else keys on `github.ref`, which is unique per pull
 * request and per queue entry but STABLE across pushes to the same PR — which
 * is what lets a PR supersede itself, the one case where cancelling is right.
 *
 * This is a SUB-KEY merge under `mergeManagedWorkflow`: a consumer that already
 * declares `cancel-in-progress` keeps its own value, and this reaches only the
 * consumers that have no concurrency block at all.
 */
/**
 * The `on.pull_request` trigger, carrying NO `branches:` filter — the one
 * shared binding every generated workflow renders (#1136).
 *
 * The filter used to be the same `branchList` emitted under `on.push`, which
 * made a pull request whose BASE was a feature branch match nothing and
 * trigger nothing: no `test`, no shards, no `gates`, no `ai-review`. Measured
 * on this repository before the change, by full 40-char head SHA — a short SHA
 * silently returns zero runs, so the two look identical and the query must use
 * the full one:
 *
 *   witness  #1128  base feat/713-migrate-product-hooks   0 runs
 *   witness  #1133  base feat/713-migrate-product-hooks   0 runs
 *   control  #1125  base main                             3 runs
 *   control  #1134  base main                             3 runs
 *
 * Base branch is the only input that differs. Both witnesses merged: with no
 * workflow triggered there is no required check left pending, so a pull
 * request that measured NOTHING is reported to the merge box exactly as a
 * green one is. That is the half worth naming — the gap is invisible from the
 * side that acts on it.
 *
 * `on.push` KEEPS its filter, and that is not an oversight. The two keys
 * answer different questions: `push.branches` is "which branches earn a CI run
 * on their own", `pull_request.branches` was answering "which bases may be
 * merged into", which nothing here ever wanted to ask. Deleting `branchList`
 * from both — the cheapest wrong fix, and it does turn every witness above
 * green — fires a full CI run on every push to every feature branch on top of
 * the `pull_request` run already covering that commit. Sampled over 25 recent
 * merged PRs: 44 commits, mean 1.76 pushes each, against 72 push-event runs in
 * the last 300. Roughly an order of magnitude of duplicated runner time for no
 * new coverage. The `on.push` cases in test/stacked-pr-ci-trigger.test.ts are
 * the control that stays red for it.
 *
 * Enumerating the namespaces instead (`feat/**`, `fix/**`) would have covered
 * all 6 of the non-`main`-based PRs in the last 200, so history cannot falsify
 * it. The prospective count can: of those 200, 24 head branches sit outside
 * both namespaces — `chore/`, `rg/`, `wt/`, `docs/`, `revert/`, bare names —
 * and any of them can be a base tomorrow. An allowlist re-creates this exact
 * defect the first time someone picks a prefix nobody enumerated, and does it
 * silently, which is the property that made #1136 cost two merges.
 */
export const CI_PULL_REQUEST_TRIGGER = `  # NO branches: filter, deliberately (#1136). A pull request based on a
  # feature branch matched no entry here and so triggered nothing at all —
  # and because no required check was left pending, it reported CLEAN. A
  # stack is how multi-part work is built in this repo, so the changes
  # least likely to run CI were the ones most likely to need it.
  #
  # Where a \`push\` trigger exists it KEEPS its filter — that key asks which
  # branches earn a run on their own, which is a different question.
  # Removing it there too duplicates a run on every feature-branch push for
  # no new coverage.
  pull_request:`;

/**
 * `ai-review.yml`'s own `on.pull_request`: `CI_PULL_REQUEST_TRIGGER`'s body
 * plus an explicit `types:` list (#1207).
 *
 * Why this workflow and no other, why all five types are spelled, and what the
 * label could not do without them: `AI_REVIEW_PULL_REQUEST_TYPES` in
 * `lib/scaffold/ai-review-step.ts`, which is the single list this renders.
 *
 * Built FROM `CI_PULL_REQUEST_TRIGGER` rather than beside it. The no-`branches:`
 * rationale is #1136's and is identical here; a second copy of that comment
 * block is a second thing to update when the reasoning moves, and
 * `test/stacked-pr-ci-trigger.test.ts` checks all four generated bodies for the
 * property it describes.
 */
export const AI_REVIEW_PULL_REQUEST_TRIGGER = `${CI_PULL_REQUEST_TRIGGER}
    # #1207. The three GitHub defaults, PLUS \`labeled\`/\`unlabeled\` — and
    # the defaults are spelled because \`types:\` REPLACES them rather than
    # extending them. Omitting them would fix the waiver and stop this
    # required check running on ordinary pushes.
    #
    # Only this workflow subscribes to label events, because only this
    # workflow reads a label. A label is not a code change.
    types: [${AI_REVIEW_PULL_REQUEST_TYPES.join(", ")}]`;

export const CI_CONCURRENCY = `# The GROUP does the work here, not the flag. A run is only ever cancelled by
# another run in the SAME group, so keying a push on its own commit makes the
# question moot: there is never a second occupant to do the cancelling.
#
# A push to \`main\` keys on \`github.sha\`, unique per commit. Every other main
# run is in a different group and nothing can cancel it. That matters because
# a main run is the ONLY run that will ever build that commit, so losing it
# leaves a gap in main's history with no red check anywhere saying so.
#
# Everything else keys on \`github.ref\`: unique per pull request
# (\`refs/pull/<n>/merge\`) and per merge-queue entry
# (\`gh-readonly-queue/...\`), but STABLE across pushes to the same pull
# request — which is what lets a pull request supersede itself, the one case
# where cancelling is the right answer.
#
# Do NOT "simplify" this to a ref-keyed group with an event expression in
# cancel-in-progress. That was tried and measured: three main-push runs
# cancelled inside eight minutes with the expression in place.
concurrency:
  group: ci-\${{ github.event_name == 'push' && github.sha || github.ref }}
  cancel-in-progress: true
`;

export function createCiWorkflows(root: string, actions: string[], opts: { force?: boolean } = {}): void {
  const workflowsDir = join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  const harness = loadHarnessConfig(root);
  // #622. This was `harness?.ci?.bunVersion || "latest"`, emitted at the two
  // sites below, while the two hand-owned workflow files this generator never
  // touches named versions of their own — four positions, three spellings,
  // and nothing comparing any of them. (Neither of those filenames is spelled
  // here: test/release-guard.test.ts asserts this module names no workflow it
  // does not write, and prose is indistinguishable from a write to it.) The
  // decision and the YAML it becomes are now `lib/bun-version.ts`'s, for the
  // same reason #87 took the typecheck step and #488 took the test step: two
  // sites that agree today are one decider too many, and only a mutation of a
  // SHARED binding can show the agreement is load-bearing.
  const bunStep = setupBunWith(declaredBunVersion(root), "          ");
  const runner = harness?.ci?.runner || "ubuntu-latest";
  const branches = harness?.ci?.branches || ["main"];
  // Branch patterns are globs: a bare `*` is a YAML alias indicator and `*-dev`
  // an unresolved alias, so emitting them unquoted produces a workflow file
  // GitHub Actions refuses to parse. JSON.stringify yields a YAML-compatible
  // double-quoted scalar with the right escaping.
  const branchList = branches.map((b: string) => `      - ${JSON.stringify(String(b))}`).join("\n");
  const runsOn = JSON.stringify(String(runner));

  // DRIFT-3 (#302) refuses a conformity exemption added in the same change as
  // the violation it exempts, by comparing the allowlist against the default
  // branch. `actions/checkout` fetches one commit and no remote-tracking ref,
  // so the check had nothing to compare against and reported UNMEASURED —
  // which is how a ratchet becomes decorative.
  //
  // A ONE-COMMIT fetch of the base, not `fetch-depth: 0`: `git show
  // <ref>:<path>` needs only that commit, and full history is a real cost to
  // impose on every consumer for one file read.
  //
  // The fetch must not FAIL the run — a repo whose default branch is not the
  // first configured branch, or a fork PR without access, would otherwise go
  // red over a fetch rather than over its code. But it must not be silent
  // either: a swallowed fetch leaves the ratchet unmeasured, and an
  // unmeasured ratchet is a decorative one. So the failure branch prints.
  // The check downstream is what decides — advisory for a consumer, while
  // rungate's own suite asserts the base IS readable, so a failed fetch
  // surfaces as a red test here rather than as a quiet pass.
  //
  // The branch name reaches a shell command, so it is validated AND quoted,
  // not either alone. The charset excludes every shell metacharacter and both
  // quote marks, which is what makes the single-quoted refspec below safe to
  // interpolate — the two defences are chosen to agree rather than to differ,
  // because a validator that admits something its consumer treats differently
  // is the gap, not the absence of a validator.
  const baseBranch = String(branches[0] ?? "main");
  const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
  // #987. This step used to be unconditionally `--depth=200`, and that flag is
  // what made `fetch-depth: 0` above it inert: a bounded `git fetch`
  // RE-SHALLOWS a repository that was already complete. Measured on a complete
  // 40-commit clone, `is-shallow-repository` goes false → true and
  // `rev-list --count HEAD` drops 40 → 20. The depth is therefore derived from
  // the checkout's own, in `lib/ci-history-depth.ts`, rather than written here
  // as a second number that has to agree with the first.
  //
  // Unbounded is not expensive in the full-history case: the objects are
  // already local, so the fetch updates a ref and transfers nothing.
  const baseDepth = baseRefFetchDepth(CI_SUITE_FETCH_DEPTH);
  const baseDepthFlag = baseDepth === null ? "" : `--depth=${baseDepth} `;

  // #987. `actions/checkout` with nothing declared clones ONE commit, so every
  // generated job that reads git history has been reading one commit since the
  // first workflow this harness wrote. `lib/failure-intake.ts` refuses a
  // shallow clone by name, which means its reading was UNMEASURED on every run
  // on every runner — uniformly absent rather than occasionally missing, and
  // absence looked like quiet.
  //
  // Both generated jobs declare it, not just the suite job. `test/scaffold-
  // conformity.test.ts` calls `runDocHygiene`, HYGIENE-6 inside it is the
  // intake's only caller, and the gates job names that file directly while the
  // suite job reaches it through the test command.
  //
  // The cost, measured on this repository three times each: depth 1 is
  // 1.23–1.64s for 6MB, full history is 1.43–1.64s for 13MB. A bounded middle
  // was measured too and is the worst of the three — 1.54–2.75s for 9MB, and
  // still UNMEASURED, because a shallow clone is shallow whatever its depth.
  const checkoutStep = `      - uses: ${actionRef("actions/checkout")}
        with:
          # Full history. A bounded depth leaves .git/shallow behind, and
          # lib/failure-intake.ts refuses on that file rather than on a commit
          # count — so any bounded value here reports UNMEASURED (#987).
          # Declared once, in lib/ci-history-depth.ts.
          fetch-depth: ${CI_SUITE_FETCH_DEPTH}`;
  const baseRefStep =
    SAFE_BRANCH.test(baseBranch) && !baseBranch.includes("..")
      ? // The conformity ratchet only diffs the tip and was happy with one
        // commit, but a tip with no history behind it makes any check that
        // reads the recent log unmeasurable — and an empty log is
        // indistinguishable from a clean one.
        `      - name: Fetch the comparison base for the conformity ratchet
        run: |
          git fetch --no-tags ${baseDepthFlag}origin '+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}' \\
            || echo "WARN: could not fetch ${baseBranch}; the conformity allowlist growth check will report UNMEASURED."`
      : // Not a fetchable ref: a glob pattern, a leading dash, or a traversal
        // segment. Emitted as a comment so the omission is visible in the
        // generated file rather than looking like it was never considered.
        `      # No comparison base fetched: the first configured branch (${JSON.stringify(baseBranch)}) is not a plain ref name,
      # so the conformity allowlist growth check will report UNMEASURED.`;

  // The typecheck step used to be emitted unconditionally as `bunx tsc --noEmit`.
  // Without a tsconfig.json tsc prints its help text and exits 1, so every
  // scaffolded consumer that is not already a TypeScript project got a CI step
  // that could only fail, over a file rungate never created for them (#65/#76).
  // Rungate itself was shielded from noticing because `bun test` failed first
  // and the step never ran.
  //
  // Which command, and whether there is one at all, is `typecheckDecision`'s
  // to answer — the same binding AGENTS.md's row and the scanned
  // `dev.typeCheck` read (#87). This site used to check for
  // `scripts/typecheck.ts` on disk, a branch `files:` makes unreachable for
  // every consumer, and never looked at a project's own `typecheck` script.
  // #488. This was `- run: bun test`, hardcoded, while `harness` was in
  // scope and three of its siblings read `harness?.ci?.*` four lines above.
  // Same binding AGENTS.md's Commands row and the agent briefs read, for the
  // same reason the typecheck step below it got one in #87: two sites that
  // agree today are one decider too many, and only a mutation of a shared
  // binding can show the agreement is load-bearing.
  const test = testCommandDecision(root);

  // #597. The Layer 1 compliance checks shell out to agnix and
  // @reporails/cli; CI installed neither, so what the registry served at that
  // moment decided the verdict. Pinned from the one declaration, never a
  // literal here.
  const globalTools = globalToolInstallStep(harness?.ci);

  const typecheck = typecheckDecision(root);
  const typecheckStep = typecheck.command
    ? `\n      - run: ${typecheck.command}`
    : `\n      # No type check: ${typecheck.reason}.`;

  // #728. A suite is a wall every branch pays, and this one was 313s of a
  // 376s run — one `bun test` on one runner, 13,562 tests, while `strict`
  // branch protection makes every merge re-run it. Sharding splits the FILES
  // across runners, which is not the same lever as `--parallel`: that one was
  // tried, and #621 records it starving 122 I/O-bound tests past bun's
  // per-test timeout so every ship run reported SHIP_PASSED_SUITE_FAILED over
  // a tree with zero real failures. Separate runners give each shard a whole
  // machine, so the starvation mechanism is absent by construction.
  //
  // Opt-in, and absent config means one shard and the single-job shape byte
  // for byte — a consumer who has never heard of this gets what they have
  // today. `shard` is read from the same `harness?.ci` binding as every
  // sibling above rather than a second reader.
  const shards = shardCount(harness?.ci);

  // #839. Which top-level keys this consumer has taken back, read from the
  // same binding as every sibling above rather than a second reader. Absent
  // config means none, and none means the generator's structural keys reach
  // every workflow it has ever written — which is the whole point of the
  // change this config exists to make reversible.
  const declined = workflowOverrides(harness?.ci);

  // The required status check is the JOB NAME, and a matrix renames it:
  // `test` becomes `test (1)`, `test (2)`. A repo whose protection requires
  // `test` would then require a context nothing ever reports, and GitHub
  // treats an absent required check as pending forever — every PR wedged,
  // with no error anywhere saying why. So the matrix is `test-shard` and a
  // dependent job keeps the name `test`, which is the context protection
  // already names. Do not collapse these two jobs.
  const ciYml = shards > 1
    ? `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
name: CI

on:
  # Re-run this workflow on demand, on any ref. Without the trigger the
  # Actions API refuses with \`HTTP 422: Workflow does not have
  # 'workflow_dispatch' trigger\` — measured on 2026-10-21 across the fleet,
  # where 5 of 6 re-run attempts came back 422. The cost is not the button: a
  # flake cannot be told from a real failure without pushing an empty commit,
  # and a fix landed on the default branch cannot be confirmed until unrelated
  # traffic happens to arrive (#940).
  workflow_dispatch:
  # merge_group carries NO branches: filter, deliberately. A merge queue builds
  # a temporary \`gh-readonly-queue/<base>/...\` ref, which no branch list here
  # would match — so filtering it is the same as not handling the event, and a
  # trigger that is present and inert is worse than an absent one because the
  # file then reads as handling it.
  #
  # Without this trigger a merge queue cannot work at all, and it fails in the
  # worst available way: the queue waits for a required check that will never
  # report, every entry sits pending with no error anywhere, and the repo looks
  # like it has simply stopped merging. UNMEASURED, not red.
  #
  # This is the SHARDED body, and it is the one that matters most: the required
  # context is the \`test\` aggregate below, which only exists here. The first
  # draft of #765 added the trigger to the unsharded body only — 91 tests passed
  # and the repo that needed it was untouched.
  merge_group:
  push:
    branches:
${branchList}
${CI_PULL_REQUEST_TRIGGER}

${CI_CONCURRENCY}
permissions:
  # Least privilege, and it matters most on the consumers. A workflow with
  # no permissions: block inherits the REPOSITORY default, which is a setting
  # the harness does not control and cannot read at generation time. Measured
  # 2026-10-20 across the consumers this harness serves: the default is
  # read-only on some and WRITE on others, so a generated job that declares
  # nothing holds a push-capable GITHUB_TOKEN wherever the default is write.
  # Neither job needs it: both check out, install and run tests.
  contents: read

jobs:
  test-shard:
    runs-on: ${runsOn}
    strategy:
      # One red shard must not cancel the others: the whole point is to see
      # every failure in one run rather than re-running to find the next.
      fail-fast: false
      matrix:
        shard: [${Array.from({ length: shards }, (_, i) => i + 1).join(", ")}]
    steps:
${checkoutStep}
${baseRefStep}
      - uses: ${actionRef("oven-sh/setup-bun")}
        with:
${bunStep}
      - run: bun install${globalTools.step}${ciSetupStep()}
      - run: ${test.command} --shard=\${{ matrix.shard }}/${shards}${typecheckStep}
${buildShardMarkerSteps("      ")}

  # The aggregate. Named "test" because that is the context branch protection
  # requires; it exists to turn N shard results into the one verdict.
  test:
    runs-on: ${runsOn}
    needs: test-shard
    # always() so a failed or cancelled shard reaches this job instead of
    # skipping it. A skipped required check is not a failed one, and some
    # protection configurations read a skip as satisfied — which would make
    # this aggregate a gate that cannot refuse.
    if: always()
    # #1190. \`contents: read\` and nothing else. #1189 also took
    # \`actions: read\` so the step could \`gh api\` this run's jobs, which
    # worked and made every consumer's required check depend on a token scope
    # and on \`gh\` being present — neither of which the generated test job
    # needed before, and neither of which a self-hosted or container
    # \`ci.runner\` is guaranteed to have. Same-run artifacts take no scope
    # and no token.
    permissions:
      contents: read
    steps:
      - uses: ${actionRef("actions/download-artifact")}
        # continue-on-error so the REFUSAL is the script's and carries a
        # sentence. A download that fails here is still red either way, but
        # the action's own error names none of this — and a check that is
        # correctly red and silent is the expensive half.
        continue-on-error: true
        with:
          # EVERY attempt's markers, not just this one's. The script dates
          # each marker itself, so a leg whose only evidence is older gets
          # "re-run all jobs" rather than "never ran" — a pattern narrowed to
          # this attempt would make those two indistinguishable.
          pattern: ${SHARD_MARKER_ARTIFACT_PREFIX}*
          # NO merge-multiple: each artifact keeps its own directory, which
          # is what ties a marker to the leg that uploaded it. Flattening
          # discards that and the reading falls back to filenames alone.
          path: \${{ runner.temp }}/rungate-shard-markers
      - name: Every shard concluded, and every shard passed
        env:
          # Every GitHub-side value arrives here, and the script below holds
          # no GitHub expression at all — that is what lets a test execute
          # the shipped text against a planted marker directory (#1181).
          ${SHARD_AGGREGATE_ENV.rollup}: \${{ needs.test-shard.result }}
          ${SHARD_AGGREGATE_ENV.expected}: "${shards}"
          ${SHARD_AGGREGATE_ENV.jobName}: test-shard
          ${SHARD_AGGREGATE_ENV.attempt}: \${{ github.run_attempt }}
          ${SHARD_AGGREGATE_ENV.markerDir}: \${{ runner.temp }}/rungate-shard-markers
        run: |
${indentedScript(buildShardAggregateScript(), "          ")}
`
    : `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
name: CI

on:
  # See the sharded body above: a re-run of this workflow is a 422 without
  # this trigger, so a flake and a real failure are indistinguishable.
  workflow_dispatch:
  # See the sharded body above: no branches: filter, and its absence hangs a
  # merge queue silently rather than failing it.
  merge_group:
  push:
    branches:
${branchList}
${CI_PULL_REQUEST_TRIGGER}

${CI_CONCURRENCY}
permissions:
  # Least privilege, and it matters most on the consumers. A workflow with
  # no permissions: block inherits the REPOSITORY default, which is a setting
  # the harness does not control and cannot read at generation time. Measured
  # 2026-10-20 across the consumers this harness serves: the default is
  # read-only on some and WRITE on others, so a generated job that declares
  # nothing holds a push-capable GITHUB_TOKEN wherever the default is write.
  # Neither job needs it: both check out, install and run tests.
  contents: read

jobs:
  test:
    runs-on: ${runsOn}
    steps:
${checkoutStep}
${baseRefStep}
      - uses: ${actionRef("oven-sh/setup-bun")}
        with:
${bunStep}
      - run: bun install${globalTools.step}${ciSetupStep()}
      - run: ${test.command}${typecheckStep}
`;

  const gatesYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
name: Gates

on:
  # See ci.yml above: without this the Actions API refuses a re-run with a
  # 422, and the gates are the checks most worth re-running on their own.
  workflow_dispatch:
  # See ci.yml above: a merge queue builds a ref no branch list matches, so
  # this trigger carries no filter and its absence hangs the queue silently.
  merge_group:
  push:
    branches:
${branchList}
${CI_PULL_REQUEST_TRIGGER}

permissions:
  # Least privilege, and it matters most on the consumers. A workflow with
  # no permissions: block inherits the REPOSITORY default, which is a setting
  # the harness does not control and cannot read at generation time. Measured
  # 2026-10-20 across the consumers this harness serves: the default is
  # read-only on some and WRITE on others, so a generated job that declares
  # nothing holds a push-capable GITHUB_TOKEN wherever the default is write.
  # Neither job needs it: both check out, install and run tests.
  contents: read

jobs:
  gates:
    runs-on: ${runsOn}
    steps:
${checkoutStep}
      - uses: ${actionRef("oven-sh/setup-bun")}
        with:
${bunStep}
      - run: bun install
      - name: Conformity + spec drift
        run: bun test test/scaffold-conformity.test.ts
      - name: Secret scan
        run: |
          # CI has nothing staged, so the old --cached scan examined zero files
          # on every run — a green check that verified nothing.
          # git grep handles paths with spaces natively, skips binaries with -I,
          # and surfaces real errors instead of hiding them behind 2>/dev/null,
          # so this cannot fail open the way the xargs pipeline could.
          # git grep exits 1 when nothing matches, which is the pass case.
          # Tier 1 patterns come from lib/secret-patterns.ts, the single registry
          # shared with the generated pre-commit hook. This comment used to
          # CLAIM parity while CI carried 3 patterns and the hook carried 8 —
          # CI missed gho_, ghs_, github_pat_, sk-ant- and PEM private keys
          # entirely. Asserted now in test/unit/secret-patterns.test.ts.
          # Tier 1 also owns the signed JWT, because it is the one unquoted
          # credential whose shape is a dotted identifier path and so is
          # excused by the tier-2 exclusion below (#863).
          if git grep -I -lE '${tier1Ere()}' -- .; then
            echo "::error::Potential secrets detected in tracked files"
            exit 1
          fi
          # Capture first so a git failure fails CLOSED. Piping git straight
          # into the filters would turn an error into empty input, which reads
          # as "clean" — passing exactly when the scan could not run.
          # git grep exits 1 for "no match", which is not an error.
          # NOTE: do NOT append "|| true" to the assignment below. It makes the
          # assignment itself succeed, so $? is always 0 and the error branch
          # becomes dead code — the scan would fail open on a git error.
          # -i on tier 2 only, never on the tier-1 scan above: tier 1 matches
          # anchored key FORMATS whose case is part of the format, and it has
          # no allowlist to absorb a false positive. The flag is interpolated
          # from lib/secret-patterns.ts rather than typed here, because four
          # hand-written flags are four things that can disagree about what
          # counts as a secret (#844).
          set +e
          tier2=$(git grep -I -hoE ${TIER2_GREP_CASE_FLAG} '${tier2Ere()}' -- .)
          rc=$?
          set -e
          # git grep: 0 = match, 1 = no match, >1 = real error.
          if [ "$rc" -gt 1 ]; then
            echo "::error::git grep failed (exit $rc) — refusing to report a clean scan"
            exit 1
          fi
          # Exclusion applies to the extracted VALUE, not the whole line.
          # Matching anywhere on the line let a trailing "# placeholder"
          # launder a real secret past the check.
          # It reads case the same way the capture does, for a reason
          # recorded in lib/secret-patterns.ts: the population the capture
          # newly sees is mostly .env.example, where a non-value is spelled
          # CHANGEME and PLACEHOLDER (#844).
          # The last alternative excuses a DOTTED IDENTIFIER PATH, anchored at
          # both ends so the whole value must be one. The value charset has no
          # quote characters, so in source tier 2 only ever sees an unquoted
          # value, and an unquoted value is an expression: apiKey:
          # config.judge.apiKey is a property reference, not a credential
          # (#863). A JWT has the same shape and is a credential, which is why
          # the tier-1 scan above carries it.
          # The optional dash after the separator is the shell-default
          # separator, so the placeholder vocabulary can reach the value of a
          # NAME:-default form. That vocabulary is a closed list of documented
          # non-values, not a judgement that a value looks harmless: a 32-char
          # random default carries none of its words and is still reported.
          if printf '%s\\n' "$tier2" | grep -qvE ${TIER2_GREP_CASE_FLAG} '${TIER2_ALLOWED_VALUE_ERE}'; then
            echo "::error::Potential credential assignment in tracked files"
            exit 1
          fi
          # Tier 3 — a credential written as a shell default, caught by SHAPE
          # rather than by a name. Tier 2 can only see one whose variable name
          # carries credential vocabulary; a variable named for what it holds
          # is invisible to it, and every neighbouring line in such a block
          # genuinely is a default, so the one that is not sits in a list of
          # things that look alike (#848).
          #
          # Captured first for the same reason tier 2 is: piping git straight
          # into the filter turns an error into empty input, which reads as
          # clean. No "|| true" on the assignment — see the note above.
          #
          # No -i here, and that is not an oversight: tier 3 has no vocabulary
          # to spell in the wrong case. Its classes already cover both cases,
          # and the flag would only widen the value class.
          set +e
          tier3=$(git grep -I -hoE '${tier3Ere()}' -- .)
          rc=$?
          set -e
          if [ "$rc" -gt 1 ]; then
            echo "::error::git grep failed (exit $rc) — refusing to report a clean scan"
            exit 1
          fi
          # The exclusion is the discriminator, not the length floor: a value
          # with no digit or no letter is a path, a container name or a port,
          # and those are what this shape is full of.
          if printf '%s\\n' "$tier3" | grep -qvE '${TIER3_ALLOWED_VALUE_ERE}'; then
            echo "::error::Potential credential in a shell default in tracked files"
            exit 1
          fi
          echo "Secret scan clean"
`;

  // #630. The ai-review job, and the one property that makes it a check
  // rather than a decoration: there is NO `if:` here, at job level or step
  // level. A job skipped by `if:` reports `skipped`, and a skipped required
  // check can be treated as satisfied — a green required check for a review
  // that never ran. `secrets` is unavailable in `if:` at any level anyway, so
  // the mode is resolved inside `run:`, where it can emit an annotation and
  // choose an exit code. The step text is `buildAuthDetectStep()`'s verbatim,
  // not a copy: one decider for the script, and a mutation of it has one
  // binding. See lib/scaffold/ai-review-step.ts.
  //
  // `pull_request` and `merge_group`, and NOT `push`. A review of a pull
  // request has nothing to say about a push to a branch, and a trigger that
  // fires where the job cannot do its work is a run whose outcome means
  // nothing.
  //
  // `merge_group` is the exception to that sentence, and #867 is why it had to
  // be. This job was `pull_request`-only on exactly the reasoning above: a
  // merge group has no pull request, so the review would be vacuous. True, and
  // the wrong conclusion — it is an argument about what the job can DO on the
  // event, and it was applied to whether the job REPORTS on it. A consumer
  // makes `ai-review` a required context precisely because it is the check
  // that reads the code; a required context that never reports does not fail
  // the queue, it HANGS it, with every entry pending and nothing red anywhere.
  //
  // So the trigger is here and the vacuousness is handled where it belongs, in
  // the report step, which exits 0 on this event and says in a notice that no
  // review ran and why. That is sound rather than a green check for nothing: a
  // pull request cannot enter a merge queue without first satisfying its
  // required checks, so `ai-review` has already run on that exact head commit.
  //
  // No `branches:` filter, for the reason ci.yml states at length: the queue
  // builds a `gh-readonly-queue/<base>/...` ref that no branch list matches,
  // so a filtered trigger is an absent one that reads as handled.
  // #631. Workload Identity Federation, read from the consumer's own config.
  // One reading, taken here and threaded into both the permission block and
  // the steps — a second `vertexCiConfig(...)` call beside either would be a
  // decider that always agrees with this one and could never be told apart
  // from it (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
  const vertex = vertexCiConfig(harness?.ci);

  // `id-token: write` is what lets the runner mint the OIDC token GCP's STS
  // exchanges. Granted ONLY when there is a federation to use it, because a
  // permission nobody consumes is a permission nobody audits.
  //
  // `actions: read` is #1168's, and it is granted unconditionally because
  // the round counter it serves runs on every review. It is READ on the
  // workflow's own run list and nothing else: the step lifts one integer,
  // `total_count`, which is how many times this workflow has run on this
  // pull request — the only thing in reach that is actually a review round.
  // A permission nobody consumes is a permission nobody audits, and this one
  // has exactly one consumer, named in `buildRoundsScript`.
  //
  // LAST in the block, after `id-token: write`, and the order is not
  // cosmetic. This file is job-preserving: a consumer who already has the
  // workflow gets the new key MERGED into their existing permissions block,
  // which appends. A generator emitting it in the middle therefore disagrees
  // with what every already-scaffolded tree ends up holding, and AC-12 in
  // test/ai-review-surface-census.test.ts compares the committed file
  // against a FRESH generation — so the two orders are a byte difference
  // that reads as a hand-edit. Measured: that is exactly how this was found.
  // `pull-requests: write` is #1168's second half: the findings ledger is an
  // upserted pull-request comment, and nothing else in this job writes one.
  //
  // It is APPENDED after `actions: read` for the merge reason above, and it
  // is the narrowest grant that can write a comment — `issues: write` would
  // also work and would additionally let this job edit issues, which it has
  // no reason to touch.
  //
  // On a FORK pull request GitHub hands this job a read-only token whatever
  // is written here, so the grant is inert exactly where the checked-out code
  // is untrusted. The ledger step reports that case rather than failing on
  // it. For a same-repo branch the author could already push to the
  // repository, so the grant adds no reach an attacker did not have.
  const ledgerPermission = `  # Upsert the findings ledger comment — the round history (#1168).\n  pull-requests: write`;
  const aiReviewPermissions =
    vertex.config === null
      ? `permissions:\n  contents: read\n  # Count this pull request's previous AI Review runs — the round budget (#1168).\n  actions: read\n${ledgerPermission}`
      : `permissions:\n  contents: read\n  # Mint the OIDC token Workload Identity Federation exchanges (#631).\n  id-token: write\n  # Count this pull request's previous AI Review runs — the round budget (#1168).\n  actions: read\n${ledgerPermission}`;

  const aiReviewYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
#
${buildOutcomesHeader(vertex)}#
# This job is deliberately unconditional. A job skipped by a condition reports
# \`skipped\`, which a required status check can be configured to accept, and
# that is a green check for a review that never ran. The credential check
# happens inside \`run:\` instead, and reports UNMEASURED when there is none.
#
# The second step says the same thing for the other door: a credential that
# resolved with no reviewer wired to use it (#631) has also not produced a
# review, and a check that stays quiet about that is the same defect.
#
# AUTHENTICATION. There is no service-account key in this file and no input
# that could carry one. Vertex authenticates with Workload Identity
# Federation: GitHub mints a short-lived OIDC token for this run, GCP's STS
# exchanges it for an access token that expires in an hour, and no long-lived
# credential exists anywhere on the runner (#677 AC-15). What this job holds
# as read from this consumer's config:
#   ${vertex.reason}
name: ${AI_REVIEW_WORKFLOW_NAME}

on:
  # See the block comment in lib/scaffold/steps.ts: no branches: filter, and
  # its absence hangs a merge queue silently rather than failing it (#867).
  merge_group:
${AI_REVIEW_PULL_REQUEST_TRIGGER}

${aiReviewPermissions}

jobs:
  ${AI_REVIEW_JOB}:
    runs-on: ${runsOn}
    steps:
${buildAuthDetectStep(vertex)}${buildReviewRunStep(
    vertex,
    {
      checkout: actionRef("actions/checkout"),
      auth: actionRef(GOOGLE_AUTH_ACTION),
      review: actionRef(CLAUDE_CODE_ACTION),
      setupBun: actionRef("oven-sh/setup-bun"),
      // #1307. The witness on the UNMEASURED route.
      uploadArtifact: actionRef("actions/upload-artifact"),
      // The same single declaration the test and gates jobs resolve from
      // (#622), at the indent this job's step bodies use.
      setupBunWith: setupBunWith(declaredBunVersion(root), "    "),
    },
    // #1013. The GENERATING version, and the same reading `harnessDevDepRange`
    // takes — one function, so a scaffold cannot write a `bunx rungate@X` next
    // to a `devDependencies` entry floored at a different minor.
    //
    // A tree running ahead of npm emits a command the registry cannot satisfy
    // yet, exactly as that function's own docstring describes for the
    // dependency range, and it becomes resolvable the moment the version
    // ships. It is not silent in the window: the adjudicator prints no outcome
    // line, and the verdict step reports UNMEASURED rather than reading the
    // failure as a refusal.
    harnessVersion(),
  )}`;

  // #1488. The second AI-review workflow: `workflow_run: completed`, which is
  // the first moment the finished job's log is served. It is generated here
  // rather than in `lib/scaffold/ai-review-step.ts` because that module
  // builds the STEPS of the review job and this is a different file with a
  // different trigger — and because the one thing the two must agree on, the
  // producing workflow's `name:`, is a constant the subscriber owns.
  const aiReviewUnmeasuredYml = buildAiReviewUnmeasuredWorkflow({
    runsOn,
    setupBun: actionRef("oven-sh/setup-bun"),
    // The same `bunStep` the three jobs above render, at the same indent and
    // from the same single declaration (#622).
    setupBunWith: bunStep,
    version: harnessVersion(),
  });

  // Not `writeFileSync`. The harness owns the `test` and `gates` jobs; it does
  // not own the file, and a consumer's own jobs have to survive the update
  // that re-scaffolding IS. A refusal is recorded rather than thrown so that
  // one unpreservable workflow does not abandon the rest of the scaffold
  // half-done — scripts/scaffold-project.ts exits non-zero on it.
  // The filenames are spelled here, not read from a constant, because
  // test/release-guard.test.ts pins this tuple as a literal: a directory-wide
  // write would take the caller-owned workflows with it, and a name behind an
  // import is a name that assertion cannot see. (That test also asserts this
  // module names no workflow it does not write — prose is indistinguishable
  // from a write to it — so the caller-owned files are not spelled anywhere
  // here, this comment included.) `AI_REVIEW_WORKFLOW_FILE` is the spelling
  // lib/conformity.ts reads back, and the two are held together by
  // test/ai-review-workflow.test.ts AC-1, which looks for the constant's
  // filename in what this loop actually wrote.
  for (const [name, content] of [["ci.yml", ciYml], ["gates.yml", gatesYml], ["ai-review.yml", aiReviewYml], ["ai-review-unmeasured.yml", aiReviewUnmeasuredYml]] as const) {
    const label = `.github/workflows/${name}`;
    try {
      // Keyed by FILE, and the lookup is here because this loop is the only
      // place that knows which file is being written (#923).
      const computedSubKeys = HARNESS_COMPUTED_SUBKEYS.get(name) ?? new Map();
      // Stamped, so the file says who wrote it. The owned-path list is a list
      // of files this generator writes, which is precisely why it could never
      // describe a file it does not write — ownership has to travel with the
      // bytes for an unowned workflow to be visible at all (#722). The marker
      // is a YAML comment, so nothing that parses the workflow can see it.
      writeManagedFile(join(workflowsDir, name), content, label, actions, { ...opts, workflowOverrides: declined, computedSubKeys }, {
        body: workflowBody,
        stamp: stampWorkflow,
      });
    } catch (e) {
      actions.push(`REFUSED: ${(e as Error).message}`);
    }
  }

  // #632 AC-14. One line, every scaffold, unconditional. `writeManagedFile`
  // above already reported that the FILE was written; this reports the thing
  // writing it does not establish — that the gate it contains is inert until
  // a credential resolves, which the generator cannot see and must therefore
  // not guess at. A consumer who reads only the checks list sees a green
  // `ai-review` and has no reason to look further, and that is #630.
  actions.push(aiReviewScaffoldAction(vertex));

  // Everything else in the directory, named. This generator writes three
  // files; a consumer's CI may run any number, and until #722 the ones it did
  // not write were not merely unmanaged but unreported — a clean run over 2 of
  // 7 workflow files, which reads exactly like a clean run over 7 of 7.
  // Reporting only: what a consumer does with a NOT-OWNED workflow is theirs.
  actions.push(...censusReport(workflowCensus(root)));
}

// ── Consumer hook deployment ─────────────────────────────────

/**
 * The commands Claude Code would actually RUN for one event, read the way
 * Claude Code reads them (#1088).
 *
 * The schema is `event → matcher group → hooks[] → { type, command }`, and a
 * leaf is a registration only when every level is present:
 *
 * ```json
 * "PreToolUse": [
 *   { "matcher": "Bash", "hooks": [ { "type": "command", "command": "…" } ] }
 * ]
 * ```
 *
 * `matcher` is omitted for events that do not have one — `SessionStart`,
 * `SubagentStop`, `PostCompact` and the rest — but `hooks[]` and
 * `type: "command"` are not optional anywhere. Read off a live
 * `~/.claude/settings.json` holding twenty-five groups across eleven events,
 * not off documentation.
 *
 * ## Why this is not `settingsCommands` from `lib/hook-trees.ts`
 *
 * That function walks the document recursively and collects any `command`
 * string **at any depth**, deliberately: it answers a census question —
 * *which trees does this machine register hooks from* — and a census that
 * knew one shape would report a document in the next shape as empty, which
 * is indistinguishable from a machine with no registrations.
 *
 * That tolerance is exactly why #1088 survived. `deployHooksToConsumers`
 * wrote a bare `{ command }` straight into the event array; the permissive
 * walk found the string, every test that asked "is the hook there?" said yes,
 * and Claude Code — the only reader whose answer decides whether the guard
 * runs — saw an array element it does not recognise as a hook. Two readers
 * disagreed and the authoritative one was not under test.
 *
 * So this reader is **strict on purpose**, and it is a second binding on
 * purpose. The two answer different questions and must be able to disagree:
 * their disagreement on a bare `{ command }` is the whole defect, and a
 * reading that cannot disagree cannot witness it
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 */
export function executingHookCommands(settings: unknown, event: string): string[] {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return [];
  const hooks = (settings as Record<string, unknown>).hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const groups = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(groups)) return [];

  const out: string[] = [];
  for (const group of groups) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) continue;
    // A bare `{ command }` has no `hooks[]`, and that is the #1088 shape. It
    // is not a registration, so it is not reported as one.
    const leaves = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(leaves)) continue;
    for (const leaf of leaves) {
      if (leaf === null || typeof leaf !== "object" || Array.isArray(leaf)) continue;
      const rec = leaf as Record<string, unknown>;
      // The field #1088 omitted. `type` is what tells a command hook from
      // the other leaf kinds the schema allows, so a leaf without it is not
      // a command this can claim will run.
      if (rec.type !== "command") continue;
      if (typeof rec.command === "string") out.push(rec.command);
    }
  }
  return out;
}

/**
 * Where a deployed hook command points, in the two spellings one deployment
 * needs (#1088).
 *
 * `command` is what goes into the consumer's settings file; `disk` is the
 * path this process checks for existence. They are returned together because
 * writing one and checking the other is the defect: before this, the command
 * was built from `join(harnessRoot, "hooks")` and nothing was checked at all,
 * so a consumer that installed rungate from npm received twelve guards whose
 * commands named a directory on the harness author's machine — and the run
 * reported `DEPLOYED: 12 hooks`.
 *
 * Resolved against the CONSUMER, which is the tree the hook will run in:
 *
 * | the consumer is | command | disk |
 * |---|---|---|
 * | the harness itself | `${CLAUDE_PROJECT_DIR}/hooks` | `<root>/hooks` |
 * | anything else | `${CLAUDE_PROJECT_DIR}/node_modules/rungate/hooks` | `<root>/node_modules/rungate/hooks` |
 *
 * `${CLAUDE_PROJECT_DIR}` rather than an absolute path, for the same reason
 * the harness's own `.claude/settings.json` is spelled that way: the variable
 * survives the checkout moving, and an absolute path baked at scaffold time
 * is wrong the first time the consumer is cloned somewhere else.
 *
 * Identity comes from `isHarnessItself` — the project's own `package.json`
 * `name` — which is the single existing binding for this question (#380) and
 * the same one `promptPrefix` and `detectPromptPrefix` read. A second
 * decider agreeing with it would be behaviourally one decider.
 */
export function consumerHooksDir(consumerRoot: string): { command: string; disk: string } {
  return isHarnessItself(consumerRoot)
    ? { command: "${CLAUDE_PROJECT_DIR}/hooks", disk: join(consumerRoot, "hooks") }
    : {
        command: "${CLAUDE_PROJECT_DIR}/node_modules/" + HARNESS_PACKAGE + "/hooks",
        disk: join(consumerRoot, "node_modules", HARNESS_PACKAGE, "hooks"),
      };
}

/**
 * Deploy hooks marked deployToConsumers:true to consumer projects'
 * .claude/settings.local.json with correct hookFor and command paths.
 * SC-472: scaffold deploys consumer-facing hooks
 *
 * Reads through the config loader, so the hooks come from
 * `.claude/rungate/hooks.json` under the directory layout and from
 * `.claude/rungate.json` under the monolith. Reading the monolith path
 * directly — as this did — meant a project on the directory layout deployed
 * nothing and said nothing, because the early return is indistinguishable
 * from "this project has no hooks" (#70).
 *
 * ## Every exit leaves a reading (#1047)
 *
 * #70 fixed one silent return and left four. When #1047 was written, zero of
 * twenty registry entries set `deployToConsumers`, so the eligible set was
 * empty on every run this function had ever had, and the only line it emitted
 * was `SKIP: All hooks already deployed to <consumer>` — a claim about hooks
 * that were never eligible, printed by the `else` of `deployed > 0`. A caller
 * reading the action list saw a successful no-op. So did the release.
 *
 * **That count is no longer true, and this docblock asserted it for longer
 * than it held.** Re-measured 2026-10-21 by parsing
 * `.claude/rungate/hooks.json`: **twenty entries, twelve `true`, eight
 * `false`, none absent.** #1047's AC-11 now refuses an entry that leaves the
 * field unset, which is why nothing is absent and why the number cannot drift
 * back. Corrected by #713, which found the same stale claim in two other
 * places; if you are reading this docblock you are most likely the person
 * about to decide what a consumer receives, and the old sentence told you
 * nobody had opted in when twelve entries had.
 *
 * What that does and does not mean, since the eligible set being non-empty is
 * the whole precondition for everything below:
 *
 * - Deployment is **armed**, not dormant. `hooks/` is in `package.json`'s
 *   `files[]`, so the `node_modules/<pkg>/hooks` command this function writes
 *   resolves on a consumer.
 * - **Publishing deploys nothing by itself.** This function runs from the
 *   scaffold's write-steps, not from an install hook, so the trigger is a
 *   scaffold run and the sink is `<consumerRoot>/.claude/settings.local.json`.
 * - **`consumers` is `[]` on this repository today**, so the guard below
 *   returns before any of that. The first declared consumer to be scaffolded
 *   is when twelve hook registrations first appear in somebody's settings.
 *
 * Four outcomes used to arrive as one, or as nothing:
 *
 * | what happened | what it said before | what it says now |
 * |---|---|---|
 * | no rungate config at all | nothing | `SKIP:` naming the root |
 * | config has no `hooks` array | nothing | `SKIP:` naming the absence |
 * | no `consumers` declared | nothing | `SKIP:` naming the absence |
 * | hooks exist, none opted in | `SKIP: All hooks already deployed` | `UNMEASURED:` with the count |
 * | all eligible already present | `SKIP: All hooks already deployed` | `SKIP:` with the eligible count |
 *
 * The UNMEASURED row is the one the issue turns on. `0 deployed because the
 * project wanted none` and `0 deployed because nobody set the flag` are
 * different facts and only one of them is fine; the first is now a `SKIP`
 * over a non-empty eligible set and the second is an `UNMEASURED` that names
 * how many entries were read and how many opted in. `.claude/rules/
 * config-access.md`: a reading is not `0`, `{}`, `null` or silence.
 *
 * A DEPLOYED line also names the hooks, because a count cannot be checked
 * against a registry and a list can.
 */
export function deployHooksToConsumers(root: string, actions: string[]): void {
  let harness: any;
  try {
    harness = tryLoadRungateConfig(root);
  } catch (err) {
    // A config that exists but cannot be read is not a config that is absent
    // (ADR-001 D2). Say so rather than returning as if there were no hooks.
    actions.push(`SKIP: hook deployment — unreadable rungate config: ${(err as Error).message}`);
    return;
  }
  if (!harness) {
    actions.push(`SKIP: hook deployment — no rungate config under ${root}`);
    return;
  }

  if (!harness?.hooks || !Array.isArray(harness.hooks)) {
    actions.push("SKIP: hook deployment — the rungate config declares no hooks array");
    return;
  }
  if (!harness?.consumers || !Array.isArray(harness.consumers) || harness.consumers.length === 0) {
    actions.push("SKIP: hook deployment — the rungate config declares no consumers");
    return;
  }

  // Taken ONCE, before any consumer loop, because it is a fact about the
  // registry and not about a consumer. Reporting it per-consumer would make
  // a repository with no consumers unable to say it, which is the same
  // silence one layer down.
  const eligible = harness.hooks.filter(
    (h: any) => h?.enabled && h?.hookFor && h?.command && h?.deployToConsumers === true,
  );
  if (eligible.length === 0) {
    actions.push(
      `UNMEASURED: hook deployment — 0 of ${harness.hooks.length} registry entries set ` +
        `deployToConsumers, so nothing was eligible and nothing declined it. This is not ` +
        `"this project wants no hooks"; it is "nobody said". Set deployToConsumers on the ` +
        `entries a consumer needs, or false with a notDeployedReason on the ones it does not.`,
    );
    return;
  }

  for (const consumer of harness.consumers) {
    // An absolute entry is the repository owner naming a tree outside this
    // one on purpose, and that is a supported declaration. A RELATIVE entry
    // says "inside this repository", so one containing `..` is saying two
    // things at once and only one of them can be true — refuse it rather
    // than writing to wherever it lands (#1088).
    const consumerRoot = consumer.startsWith("/") ? consumer : resolve(root, consumer);
    if (!consumer.startsWith("/")) {
      const base = resolve(root);
      if (consumerRoot !== base && !consumerRoot.startsWith(base + sep)) {
        actions.push(
          `SKIP: Consumer ${consumer} — a relative consumer path must stay inside ${base}, ` +
            `and this one resolves to ${consumerRoot}. Declare it as an absolute path if ` +
            `that is deliberate.`,
        );
        continue;
      }
    }
    if (!existsSync(consumerRoot)) {
      actions.push(`SKIP: Consumer ${consumer} — directory not found`);
      continue;
    }

    const claudeDir = join(consumerRoot, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const settingsPath = join(consumerRoot, ".claude", "settings.local.json");
    let settings: any = {};
    if (existsSync(settingsPath)) {
      // A corrupt config is never a missing config (`.claude/rules/
      // config-access.md`). The `catch {}` this replaces left `settings` as
      // `{}` and then fell through to `writeFileSync` — so a consumer's
      // settings.local.json that failed to parse for any reason, including a
      // half-written file or a merge conflict marker, was OVERWRITTEN with a
      // file containing nothing but our hooks. Their permissions, their
      // allowlists, their own hook registrations: gone, silently, during a
      // run whose purpose was to add three lines.
      //
      // Refuse this consumer and keep going to the next. Repairing somebody
      // else's security settings is not a decision a scaffold step gets to
      // take, and neither is discarding them.
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch (err) {
        actions.push(
          `SKIP: ${consumer} — .claude/settings.local.json exists but does not parse ` +
            `(${(err as Error).message}). Refusing to overwrite it. Fix the file and re-run.`,
        );
        continue;
      }
      if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
        // `JSON.parse("null")` and `JSON.parse("[]")` both succeed and both
        // take `settings.hooks = {}` without complaint, so the parse alone
        // does not establish that this is a settings object.
        actions.push(
          `SKIP: ${consumer} — .claude/settings.local.json parses but is not an object. ` +
            `Refusing to overwrite it.`,
        );
        continue;
      }
    }

    if (!settings.hooks) settings.hooks = {};

    // Resolved against the CONSUMER, not against the harness (#1088). `disk`
    // is only ever used to ask whether the file is there; `command` is the
    // only spelling that reaches the consumer's settings file.
    const dirs = consumerHooksDir(consumerRoot);

    const deployedNames: string[] = [];
    const repairedNames: string[] = [];
    let alreadyPresent = 0;
    for (const hook of eligible) {
      const resolvedCommand = hook.command.replace("${RUNGATE_HOOKS_DIR}", dirs.command);
      const diskCommand = hook.command.replace("${RUNGATE_HOOKS_DIR}", dirs.disk);
      const hookType = hook.hookFor as string;

      if (!Array.isArray(settings.hooks[hookType])) settings.hooks[hookType] = [];
      const groups: any[] = settings.hooks[hookType];

      // Does the file this command runs exist in the tree it will run in?
      //
      // Nothing asked before, so the deployment could not tell "the guard is
      // installed" from "the guard's path names nothing here" — and both
      // reported `DEPLOYED`. A silently inert security control is worse than
      // an absent one; an absent one gets noticed.
      const executed = executedHookPath(diskCommand);
      if (executed === null) {
        actions.push(
          `UNMEASURED: ${consumer} — ${hook.name}: could not read which file ` +
            `"${hook.command}" executes, so whether it is present was never established. ` +
            `Not deployed.`,
        );
        continue;
      }
      if (!existsSync(executed)) {
        actions.push(
          `UNMEASURED: ${consumer} — ${hook.name}: nothing at ${executed}, which is where ` +
            `the command being written points. Not deployed. Install ${HARNESS_PACKAGE} in ` +
            `the consumer, or drop deployToConsumers on this entry.`,
        );
        continue;
      }

      // Registrations as CLAUDE CODE would see them. Reading `groups` for a
      // top-level `command` — which is what this used to do — counts the
      // inert pre-#1088 entries as deployments, so a consumer that already
      // received the broken shape would never receive the working one and
      // the run would report "already deployed" forever.
      const registered = executingHookCommands(settings, hookType).filter(
        c => hookRegistrationPath(c, hook.name) !== null,
      );
      if (registered.includes(resolvedCommand)) {
        alreadyPresent++;
        continue;
      }
      if (registered.length > 0) {
        // Names the hook, runs something else. That is a disagreement about
        // which program a guard is, and resolving it by appending a second
        // registration — or by treating it as already deployed — both pick a
        // winner silently. Say it and leave the consumer's entry alone.
        actions.push(
          `CONFLICT: ${consumer} — ${hook.name} is already registered under ${hookType} as ` +
            `${registered.join(", ")}, which is not ${resolvedCommand}. Left alone; ` +
            `nothing was deployed for this hook.`,
        );
        continue;
      }

      // Inert leftovers from the shape this fixes: a bare `{ command }` in
      // the event array, which Claude Code does not recognise as a hook.
      // Removed rather than left beside the correct entry, because a reader
      // cannot tell one of ours from one of the consumer's — and ours is
      // identified exactly: it EXECUTES `<name>.hook.ts`, by the same parse
      // the registration check uses.
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g === null || typeof g !== "object" || Array.isArray(g)) continue;
        if (Array.isArray(g.hooks)) continue;
        if (typeof g.command !== "string") continue;
        if (hookRegistrationPath(g.command, hook.name) === null) continue;
        groups.splice(i, 1);
        repairedNames.push(hook.name);
      }

      // The executing shape: event → matcher group → `hooks[]` → `{ type,
      // command }`. An existing group with the SAME matcher is reused, so a
      // re-scaffold does not accumulate one group per run, and events with
      // no matcher get a group with the key omitted rather than set to
      // `undefined` — which is what `~/.claude/settings.json` holds for
      // SessionStart, SubagentStop and PostCompact.
      const matcher: string | undefined =
        typeof hook.matcher === "string" && hook.matcher.length > 0 ? hook.matcher : undefined;
      let group = groups.find(
        (g: any) =>
          g !== null &&
          typeof g === "object" &&
          !Array.isArray(g) &&
          Array.isArray(g.hooks) &&
          (typeof g.matcher === "string" ? g.matcher : undefined) === matcher,
      );
      if (!group) {
        group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] };
        groups.push(group);
      }
      group.hooks.push({ type: "command", command: resolvedCommand });
      deployedNames.push(hook.name);
    }

    if (deployedNames.length > 0 || repairedNames.length > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      if (repairedNames.length > 0) {
        actions.push(
          `REPAIRED: ${repairedNames.length} unrecognised hook entries removed from ` +
            `${consumer}/.claude/settings.local.json — ${repairedNames.join(", ")}. They were ` +
            `written in a shape Claude Code does not execute (#1088) and never ran.`,
        );
      }
      if (deployedNames.length > 0) {
        actions.push(
          `DEPLOYED: ${deployedNames.length} hooks to ${consumer}/.claude/settings.local.json ` +
            `— ${deployedNames.join(", ")}`,
        );
      }
    } else if (alreadyPresent === eligible.length) {
      // Reachable only with a non-empty eligible set, so this now means what
      // it says. The `eligible.length === 0` guard above took the other case,
      // and an UNMEASURED or CONFLICT hook is no longer swept in here — each
      // pushed its own line and this count excludes it.
      actions.push(
        `SKIP: all ${eligible.length} eligible hooks already deployed to ${consumer}`,
      );
    }
  }
}

/**
 * ## The generated pre-commit hook, as one binding (#610)
 *
 * ## What was wrong
 *
 * The hook decided WHICH updater to run by sniffing the working tree at
 * commit time:
 *
 *     updater=""
 *     if [ -f "scripts/update-project-state.ts" ]; then
 *       updater="scripts/update-project-state.ts"
 *     elif [ -f "node_modules/rungate/scripts/update-project-state.ts" ]; then
 *       updater="node_modules/rungate/scripts/update-project-state.ts"
 *     fi
 *
 * and the comment above it said the order was deliberate because "a checkout
 * that has its own scripts/ copy is the harness". That is an identity
 * inferred from a FILENAME. "This tree holds a file at this path" and "this
 * tree is the rungate harness" are different facts, and the hook treated the
 * first as proof of the second — so a consumer that keeps a script at that
 * path for its own reasons was silently reclassified as the harness and ran a
 * different program than the one rungate installed. Nothing in the commit
 * recorded which branch fired, so the two outcomes were indistinguishable
 * afterwards.
 *
 * A detector narrower than what it detects
 * (`.claude/rules/checks-must-be-able-to-fail.md`, second shape), with the
 * *Silent Default Substitution* that `.claude/rules/config-access.md` refuses
 * sitting underneath it.
 *
 * ## What it does instead
 *
 * The decision is taken HERE, at generation time, and one concrete path is
 * baked into the emitted script. The hook names the program it runs; a tree
 * that acquires a same-named file afterwards cannot change what executes.
 *
 * Identity is read from the project's own declaration — `isHarnessItself`,
 * which reads `package.json`'s `name` and is the single existing binding for
 * this question in the tree (#380). It is deliberately NOT a second reading
 * of the same fact: two deciders that agree are behaviourally one, and no
 * mutation of either could tell them apart.
 *
 * ## Three readings, and UNMEASURED is one of them
 *
 * | the tree declares | the candidate | emitted |
 * |---|---|---|
 * | `name: "rungate"` | `scripts/update-project-state.ts` | that path, baked |
 * | anything else | `node_modules/rungate/scripts/…` | that path, baked |
 * | either, candidate absent | — | UNMEASURED, and no lookup at all |
 *
 * The third row is the one that must not be a guess. A hook carrying a
 * lookup "in case the file turns up later" succeeds at some unknown future
 * commit for a reason nobody chose, and `0`, `""`, `null` and a
 * plausible-looking path are all indistinguishable from success.
 */

/**
 * The line that marks a pre-commit hook as ours, so a fix can reach one that
 * already exists (#450).
 *
 * The guard here was `if (!existsSync(preCommit))`, which meant every
 * checkout that already had a hook kept whatever version it was given the
 * first time — including the one that stages DA-owned state from every
 * worktree, which is what #450 is about. The pre-push hook had exactly this
 * bug and #85 fixed it the same way: overwrite our own managed hook, and
 * leave a hand-written one alone.
 */
export const PRE_COMMIT_MANAGED_MARKER = "# Managed by rungate — secret scan + PROJECT-STATE update";

/**
 * Present in EVERY form this generator emits, resolved or not.
 *
 * `scripts/check-installed-hook-currency.ts` probes for it to tell a hook
 * that predates #610 from one that carries it, and that probe has to work for
 * a consumer and for the harness alike — so it cannot be either baked path.
 */
export const UPDATER_GENERATION_MARKER =
  "# Which updater runs was decided when this hook was generated (#610), not here.";

/** The harness's own copy, relative to the project root. */
export const HARNESS_UPDATER = "scripts/update-project-state.ts";

/** The copy rungate installs into a consumer, relative to the project root. */
export const VENDORED_UPDATER = "node_modules/rungate/scripts/update-project-state.ts";

export type UpdaterIdentity = "harness" | "consumer";

export interface UpdaterResolution {
  /** What the tree declared itself to be, read from package.json's name. */
  identity: UpdaterIdentity;
  /** The one path that identity selects — present or not. */
  candidate: string;
  /** The path baked into the hook, or null when the candidate is absent. */
  path: string | null;
}

/**
 * The single decider. One binding to mutate, asked once by
 * `preCommitHookScript` and nowhere else.
 */
export function resolveUpdater(root: string): UpdaterResolution {
  const identity: UpdaterIdentity = isHarnessItself(root) ? "harness" : "consumer";
  const candidate = identity === "harness" ? HARNESS_UPDATER : VENDORED_UPDATER;
  return {
    identity,
    candidate,
    path: existsSync(join(root, candidate)) ? candidate : null,
  };
}

const IDENTITY_NOTE: Record<UpdaterIdentity, string> = {
  harness:
    "# package.json names this tree as the rungate harness, so the updater is its own\n" +
    "    # scripts/ copy — never a vendored duplicate of itself, which would be stale.",
  consumer:
    "# package.json does not name this tree as the harness, so the updater is the copy\n" +
    "    # rungate installed. A script this project keeps at scripts/ is its own program\n" +
    "    # and is not run here, whatever it is called.",
};

/**
 * The block that goes inside the primary-checkout arm.
 *
 * The resolved form contains the path EXACTLY ONCE — in the assignment — so
 * there is one literal to mutate and one literal for a test to count. The
 * echo below it reports `$updater` rather than repeating the path, which is
 * the same reason: a second copy would survive any mutation of the first.
 */
function updaterBlock(r: UpdaterResolution): string {
  if (r.path === null) {
    return `    ${UPDATER_GENERATION_MARKER}
    ${IDENTITY_NOTE[r.identity]}
    #
    # Nothing was found there when this hook was generated, so this hook runs
    # no updater and performs no lookup. A lookup kept "in case it turns up"
    # would succeed at some later commit for a reason nobody chose.
    echo "project-state: UNMEASURED — when this hook was generated this tree read as a ${r.identity} checkout and no updater was present at ${r.candidate}. This hook runs none and stages nothing. Re-scaffold once it is installed." >&2`;
  }
  return `    ${UPDATER_GENERATION_MARKER}
    ${IDENTITY_NOTE[r.identity]}
    updater="${r.path}"
    # Say which program is about to run, before running it. Without this the
    # commit's output records nothing about which updater fired and the
    # answer is only recoverable by inspecting the tree afterwards (#610).
    echo "project-state: running $updater (resolved when this hook was generated)" >&2
    if bun "$updater" --skip-tests >&2; then
      # Staged only after the updater SUCCEEDED. Staging regardless is the
      # fail-open the readings above exist to replace: it puts yesterday's
      # PROJECT-STATE.md in today's commit, and the commit then looks exactly
      # like one that updated it.
      git add PROJECT-STATE.md project-state.json 2>/dev/null || true
    else
      echo "project-state: UNMEASURED — $updater exited non-zero, so PROJECT-STATE.md and project-state.json were NOT staged. Run it by hand to see why." >&2
    fi`;
}

/**
 * What `createGitHooks` writes, for a given project root.
 *
 * A function of the root rather than a constant, because the updater is
 * resolved here. It writes nothing: `scripts/check-installed-hook-currency.ts`
 * has to obtain the text for a project it is only INSPECTING, and a generator
 * that could only answer by installing itself would make the check the thing
 * it is checking.
 */
export function preCommitHookScript(root: string): string {
  return `#!/bin/sh
${PRE_COMMIT_MANAGED_MARKER}
#
# Scans the staged DIFF, not files on disk. This is deliberate and fixes four
# failure modes the file-list approach had:
#   - nothing staged: the list was empty, xargs ran grep with no operands,
#     grep read stdin and exited 0, so every --amend was rejected
#   - paths with spaces: split into nonexistent fragments, grep errored,
#     2>/dev/null hid it, and the file was silently never scanned
#   - 2>/dev/null masked every real error, so the scan failed open
#   - grep read the WORKING TREE, so a secret staged and then edited out of
#     the file on disk was committed unseen
# Matching only added lines (^+) also means pre-existing matches elsewhere in
# a touched file do not block unrelated commits.
#
# Capturing the diff first makes a git failure fail CLOSED. Piping git
# straight into grep would swallow a git error as empty input, which grep
# reads as "no secrets" — the scan would pass precisely when it could not run.
staged_diff=$(git diff --cached --diff-filter=ACM -U0) || {
  echo "ERROR: could not read staged diff — refusing to commit unscanned"
  exit 1
}
# Tier 1 — anchored key formats. Unambiguous, so no exceptions.
if printf '%s\\n' "$staged_diff" | grep -qE '^\\+.*${tier1Ere()}'; then
  echo "ERROR: Potential secrets detected in staged changes"
  exit 1
fi

# Tier 2 — credential assignments. Restores the coverage the old
# password="..." pattern was meant to provide, in a form with no quote
# characters (quotes could not survive JS-template -> shell escaping).
#
# grep -o extracts just the assignment, so the exclusion below is applied to
# the VALUE and not to the whole line. Matching the exclusion anywhere on the
# line was an allowlist escape: appending "# placeholder" to a line holding a
# real secret was enough to launder it past the check.
#
# Exclusions are env lookups and explicit non-values. password =
# process.env.DB_PASSWORD is a reference, not a secret, and flagging it would
# only train people to reach for --no-verify.
#
# Both expressions are interpolated from lib/secret-patterns.ts, never
# written here. A hardcoded copy is a second binding for one string, and
# #489's narrowing then has to be applied in places nothing compares. The
# allowlist's leading \`^$|\` alternative cannot fire on this pipeline —
# grep -oE emits no empty lines — so using the one constant is the same
# behaviour with one fewer decider.
#
# -i is on both tier-2 greps and on neither tier-1 one, interpolated from the
# same constant the CI job uses. Without it the vocabulary could only see
# lowercase, which is the spelling an environment variable or a shell default
# is least often written in (#844).
if printf '%s\\n' "$staged_diff" \\
  | grep '^+' \\
  | grep -oE ${TIER2_GREP_CASE_FLAG} '${tier2Ere()}' \\
  | grep -qvE ${TIER2_GREP_CASE_FLAG} '${TIER2_ALLOWED_VALUE_ERE}'; then
  echo "ERROR: Potential credential assignment in staged changes"
  exit 1
fi

# Tier 3 — a credential written as a shell default, caught by shape rather
# than by the variable name. Tier 2 only sees one whose name carries
# credential vocabulary (#848).
#
# Both expressions are interpolated from lib/secret-patterns.ts for the
# reason tier 2's are: a hardcoded copy is a second binding for one string.
#
# No -i, deliberately. Tier 3 has no vocabulary to miss in the wrong case,
# and the flag would only widen the value class.
if printf '%s\\n' "$staged_diff" \\
  | grep '^+' \\
  | grep -oE '${tier3Ere()}' \\
  | grep -qvE '${TIER3_ALLOWED_VALUE_ERE}'; then
  echo "ERROR: Potential credential in a shell default in staged changes"
  exit 1
fi

# Update PROJECT-STATE if it exists — but NEVER from a linked worktree (#450).
#
# project-state.json, PROJECT-STATE.md and SUCCESS.md are DA-owned: a single
# shared state document that several worktrees must not each write their own
# version of (#296). The rule is written down in CLAUDE.md and in
# .claude/rules/key-files.md, and this hook used to do the opposite of it on
# every commit in every worktree — so an agent that obeyed the rule perfectly
# still shipped the violation, because the staging happened after it had
# decided not to touch the file. A rule something actively undoes is worse
# than a rule nothing executes.
#
# The hook cannot tell whether it is the DA. It CAN tell whether it is in a
# linked worktree: --git-dir points at .git/worktrees/<name> there while
# --git-common-dir points at the shared .git, and in the primary checkout the
# two are the same answer.
#
# The first draft resolved both through a cd-then-pwd-P round trip first, on
# the theory that one could come back relative and the other absolute. The
# mutation battery scored that normalisation 0 of 20 — both arms behave
# identically without it, executed against a real primary checkout and a real
# linked worktree. An unmeasured guard is indistinguishable from an absent
# one, so it is absent. git hooks run from the toplevel, and both calls share
# a cwd, so there was never a case that needed it.
#
# The primary arm had three fail-opens in two lines (#599), and the shape is
# this file's recurring one: a check that passed because of what it never
# looked at. The path was the CONSUMER layout, so in the harness's own
# checkout — which has scripts/update-project-state.ts and no
# node_modules/rungate at all — bun exited non-zero on a file that is not
# there. 2>/dev/null threw the ENOENT away, || true threw the status away, and
# the git add below then staged whatever happened to be on disk.
#
# Every message is on STDERR: stdout is what a caller captures as the
# command's answer, and a decline, a reading and an updater's progress are all
# diagnosis rather than output.
if [ -f "project-state.json" ]; then
  gitdir=$(git rev-parse --git-dir)
  commondir=$(git rev-parse --git-common-dir)
  if [ -n "$gitdir" ] && [ "$gitdir" = "$commondir" ]; then
${updaterBlock(resolveUpdater(root))}
  else
    # Announced, not silent. A developer who expected the state files to move
    # would otherwise be left guessing, and SKIP that says nothing is
    # indistinguishable from the update having happened.
    echo "project-state: SKIPPED — linked worktree. project-state.json, PROJECT-STATE.md and SUCCESS.md are DA-owned (#296); update them from the primary checkout." >&2
  fi
fi

# A script's exit status is its last command's. Without this, the [ -f ] test
# failing (no project-state.json) or git add failing (no PROJECT-STATE.md yet)
# made the hook exit non-zero and reject a perfectly good commit. Everything
# that should block has already exited 1 above.
exit 0
`;
}

/**
 * One hook the scaffold installs (#891).
 *
 * `createGitHooks` used to name each hook in its own paragraph of imperative
 * code, and `scripts/check-installed-hook-currency.ts` joined the literal
 * `pre-commit` and compared that one file. Two positions deciding what the
 * set of hooks is, with nothing comparing them — so the installed `pre-push`
 * in this repository sat four months and one mutation battery behind its
 * generator while the currency check printed a verdict about the other hook
 * and exited 0.
 *
 * This is the declaration both of them read. A hook added here is installed
 * by the loop below AND reported by the checker, without either being
 * edited; that is the property `test/unit/hook-currency-population.test.ts`
 * AC-5 plants a case for, and it is what the cheap repair — adding the
 * string `"pre-push"` to the checker — does not buy.
 *
 * `script` takes the project root because the pre-commit hook's content
 * depends on it (#610): the updater it names is resolved at generation time
 * from what the project declares itself to be. A hook that does not care
 * ignores the argument.
 */
export interface GeneratedHook {
  /** The file name under the hooks directory, and the name every report uses. */
  name: string;
  /** The script this project should have, generated and written nowhere. */
  script: (root: string) => string;
  /** The line that marks an installed copy as one of ours. */
  marker: string;
  /** What the scaffold's action log calls it. */
  describes: string;
}

export const GENERATED_HOOKS: ReadonlyArray<GeneratedHook> = [
  {
    name: "pre-commit",
    script: preCommitHookScript,
    marker: PRE_COMMIT_MANAGED_MARKER,
    describes: "secret scan + PROJECT-STATE update",
  },
  {
    // Checks the COMMITS BEING PUSHED, not the working tree (#85). The old
    // hook ran conformity in the working tree, which is not what is being
    // pushed: on 2026-10-05 that let a regression reach main, because
    // HYGIENE-3's reference index recursed into `.claude/worktrees/` and
    // every file looked referenced. A gate that inspects something other
    // than what it is gating is not a weaker gate; it is a different gate
    // wearing the name of the one you wanted.
    //
    // The script itself lives in `lib/scaffold/pre-push-hook.ts` (#397). As
    // a template literal here it was unrunnable, and the thing nothing runs
    // is the thing nothing checks.
    name: "pre-push",
    script: () => prePushHookScript(),
    marker: PRE_PUSH_MANAGED_MARKER,
    describes: "conformity check",
  },
];

export function createGitHooks(root: string, actions: string[]): void {
  const hooksDir = join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return;

  const { chmodSync } = require("fs");

  // A loop over the declaration, and not four paragraphs. The old shape also
  // carried a `return` in the pre-push SKIP arm, which was harmless only
  // because pre-push happened to be last — a third hook would have been
  // silently skipped for every project with a hand-written pre-push.
  for (const hook of GENERATED_HOOKS) {
    const at = join(hooksDir, hook.name);
    const existing = existsSync(at) ? readFileSync(at, "utf-8") : null;
    // Overwrite only our own managed hook; a hook a human wrote is left
    // alone. The old guard here was `if (!existsSync(prePush))`, so once a
    // hook existed it was never updated again and every fix to it — this one
    // included — would have reached nobody.
    if (existing !== null && !existing.includes(hook.marker)) {
      actions.push(`SKIP: .git/hooks/${hook.name} (hand-written, not overwriting)`);
      continue;
    }
    writeFileSync(at, hook.script(root));
    chmodSync(at, 0o755);
    actions.push(
      `${existing === null ? "CREATED" : "UPDATED"}: .git/hooks/${hook.name} (${hook.describes})`,
    );
  }
}

/**
 * The version range a scaffolded project should depend on (#362).
 *
 * This used to be `file:${relative(root, harnessRoot)}` — a path to a
 * sibling directory on whichever machine ran the scaffold, then pinned into
 * the consumer's `bun.lock`. On CI, or on any second machine, that path does
 * not exist and `bun install` exits 1, so a consumer cannot install its
 * dependencies on a clean clone. That is a failure at step zero, before any
 * gate or tier question, and it is what broke DailyBriefDashboard's CI on
 * every run from 2026-10-03.
 *
 * `--no-optional` does not help, which is worth recording because it was the
 * attempted fix: `--frozen-lockfile` resolves the `file:` entries pinned in
 * the lock whether or not they are optional.
 *
 * ## Why the MINOR floor and not the current patch
 *
 * A caret on the exact current version — `^0.2.2` from a tree at 0.2.2 —
 * cannot resolve until that version is published, and this repo runs ahead
 * of npm (0.2.1 published against 0.2.2 in the tree when this was written;
 * #364 is about there being no release workflow at all). A consumer
 * scaffolded in that window would get an unresolvable dependency, which is
 * the same defect in a new costume.
 *
 * `^0.2.0` is satisfied by every published 0.2.x, so it resolves to the
 * newest one available today AND picks up the next release with no
 * re-scaffold. The floor moves when the harness's own minor moves, which is
 * when a consumer genuinely needs a newer line.
 */
export function harnessDevDepRange(version?: string): string {
  const v = version ?? harnessVersion();
  const m = /^(\d+)\.(\d+)\./.exec(v);
  // An unparseable version falls back to the widest range that is still a
  // range rather than to `file:` or to `*`. `*` would let a consumer install
  // a major they were never scaffolded against; `file:` is the bug.
  if (!m) return "^0.2.0";
  return `^${m[1]}.${m[2]}.0`;
}

function harnessVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(__dirname)), "package.json"), "utf-8"),
    );
    return typeof pkg?.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/**
 * `version` exists for the install tests, and the reason is a release
 * blocker rather than convenience (#364).
 *
 * The range this writes is floored at the harness's own minor, so a tree
 * carrying an UNPUBLISHED minor emits a range nothing on the registry
 * satisfies — `0.3.0` emits `^0.3.0` while npm's newest is `0.2.1`. That is
 * correct output and becomes resolvable the moment the version ships. But a
 * test that really runs `bun install` cannot pass in the window before the
 * publish, and the release workflow runs the suite BEFORE publishing, with
 * no bypass, which made every minor and major bump un-releasable: the check
 * could not pass until the step it gates had already run.
 *
 * Splitting it by phase is the fix. The resolvability half is driven over a
 * version that IS published, so it keeps catching the `file:` regression it
 * was written for; the "this tree's own range will resolve once shipped"
 * half is a pure property and needs no registry. See
 * `test/scaffold-installable.test.ts`.
 */
/** Every section a dependency declaration can hide in (#475). */
export const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * Both names the harness has shipped under.
 *
 * `pai-harness` is the former name and older scaffold runs wrote it. A
 * migration that knows only the current name leaves the old declaration in
 * place and adds a new one beside it — two packages for one dependency.
 */
export const HARNESS_PKG_NAMES = ["rungate", "pai-harness"] as const;

/**
 * The name the harness ships under today; the rest of `HARNESS_PKG_NAMES` is
 * history, and migration targets this one.
 *
 * Derived rather than written out so the two cannot drift — and named rather
 * than inlined for a second reason worth stating, because it looks like
 * evasion otherwise. #380's `IDENTITY_COMPARISON` guard matches a
 * `name`-equality against the harness's own package name anywhere in
 * `lib/`, to keep "is this project the harness" decided in exactly one
 * place — and this paragraph deliberately does not spell that comparison
 * out, because the guard reads raw source and a docstring quoting the
 * pattern reports itself as a second site. The comparison below asks a
 * different question of a different type — "is this DECLARATION named
 * rungate", where `name` is a key in someone's `devDependencies` — and the
 * textual guard cannot tell the two apart. Widening the guard would narrow
 * it; this keeps #380's single binding intact and says which question is
 * being asked.
 */
export const CURRENT_HARNESS_PKG: (typeof HARNESS_PKG_NAMES)[number] = HARNESS_PKG_NAMES[0];

export interface HarnessDeclaration {
  section: (typeof DEP_SECTIONS)[number];
  name: (typeof HARNESS_PKG_NAMES)[number];
  spec: string;
}

/** Every place this package.json declares the harness. */
export function findHarnessDeclarations(pkg: unknown): HarnessDeclaration[] {
  const out: HarnessDeclaration[] = [];
  const obj = pkg as Record<string, Record<string, unknown>> | null;
  if (!obj || typeof obj !== "object") return out;
  for (const section of DEP_SECTIONS) {
    const deps = obj[section];
    if (!deps || typeof deps !== "object") continue;
    for (const name of HARNESS_PKG_NAMES) {
      const spec = deps[name];
      if (typeof spec === "string") out.push({ section, name, spec });
    }
  }
  return out;
}

/** What the scaffold intends to do about the harness dependency. */
export interface HarnessDepPlan {
  action: "skip" | "add" | "migrate";
  /** Declarations to delete before writing. */
  remove: HarnessDeclaration[];
  /** The spec to write into `devDependencies.rungate`, or null when skipping. */
  write: string | null;
  /** Said out loud in the action line, with the before and after (#475 SC-4). */
  reason: string;
}

/**
 * The ONE decision about the harness dependency (#475).
 *
 * The guard this replaces read **one key in one section under one name**:
 *
 * ```ts
 * if (pkg.devDependencies["rungate"] || isHarnessItself(root)) { ...skip... }
 * ```
 *
 * So it could not see `rungate` in `dependencies` or `optionalDependencies`,
 * could not see `pai-harness` anywhere, and could not see a `file:` spec
 * under any of them. `harnessDevDepRange`'s own comment says "`file:` is the
 * bug" — the EMISSION was fixed and nothing was ever written to undo what the
 * broken emission left behind.
 *
 * The sharper half is that re-scaffolding does not merely fail to clean it
 * up. With `optionalDependencies: { "rungate": "file:../rungate" }` and no
 * `devDependencies.rungate`, the guard does not fire, so the scaffold writes
 * `devDependencies.rungate = "^0.4.0"` BESIDE it. The consumer then declares
 * one package twice, in two sections, with two incompatible specs, and the
 * run reports `UPDATED: package.json (rungate devDep)` as a success.
 *
 * Measured in a real consumer, two declarations written by two scaffold runs
 * two days apart under the two different names:
 *
 * ```
 * file:../pai-harness -> 34f03818  2026-09-17
 * file:../rungate     -> 3a6501a9  2026-09-19
 * ```
 *
 * They survived every re-scaffold since September, and the cost was a dead
 * container build: bun resolves `file:` optionals and fails on a folder that
 * is not in the build context. A later commit moved both to
 * `optionalDependencies` trying to make the build tolerate them, which put
 * them further out of the old guard's reach — wrong section AND wrong name.
 *
 * Kept separate from the writer so there is one binding to mutate, and so
 * the whole matrix can be driven without a filesystem.
 */
export function harnessDepPlan(pkg: unknown, targetRange: string): HarnessDepPlan {
  const found = findHarnessDeclarations(pkg);

  if (found.length === 0) {
    return { action: "add", remove: [], write: targetRange, reason: "no harness dependency declared" };
  }

  // A single declaration in the RIGHT PLACE is left exactly as it is,
  // whatever its spec. Two reasons, and the second resolves a conflict
  // between two issues:
  //
  // 1. The range is not rewritten to today's floor. A scaffold that rewrites
  //    a working spec on every run is indistinguishable from one that cannot
  //    tell a working spec from a broken one, and it would churn every
  //    consumer's package.json on every release.
  //
  // 2. `file:` is included, which is #362 SC-815: "A consumer who
  //    deliberately points at a local checkout is not this bug, and silently
  //    rewriting their package.json is not this fix's business." #475 SC-2
  //    asks for `file:` to be replaced "in any of those cells", and taken
  //    literally the two contradict.
  //
  // The line drawn here is PLACEMENT, not spec, because that is what #475's
  // own evidence supports: both `file:` entries it traced were written by
  // scaffold runs (`34f03818`, `3a6501a9`), and both ended up in
  // `optionalDependencies` under two different names. A declaration the
  // scaffold would never have written in that position is the scaffold's to
  // clean up; a lone `devDependencies.rungate` is where a developer linking
  // a local checkout would put one, and it is indistinguishable from intent.
  const only = found.length === 1 ? found[0] : null;
  if (only && only.section === "devDependencies" && only.name === CURRENT_HARNESS_PKG) {
    return { action: "skip", remove: [], write: null, reason: `devDependencies.rungate is ${only.spec}` };
  }

  const where = found.map(d => `${d.section}.${d.name}=${d.spec}`).join(", ");
  return {
    action: "migrate",
    remove: found,
    write: targetRange,
    reason: `${where} -> devDependencies.rungate=${targetRange}`,
  };
}

export function addPaiHarnessDevDep(root: string, actions: string[], version?: string): void {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return;

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // A different question — "is rungate already available here" — but the
  // self-reference half is the same fact, so it routes through the one
  // predicate (#380). Asked FIRST: the harness's own package.json names
  // itself, and running the migration over it would rewrite the harness into
  // depending on itself.
  if (isHarnessItself(root)) {
    actions.push("SKIP: rungate devDep (self-reference)");
    return;
  }

  const plan = harnessDepPlan(pkg, harnessDevDepRange(version));
  if (plan.action === "skip") {
    actions.push(`SKIP: rungate devDep (${plan.reason})`);
    return;
  }

  // Removed BEFORE the write, and across every section, so a declaration
  // cannot survive in the section the writer does not touch. This is the
  // whole of SC-2: the invariant is one declaration in total, not a correct
  // `devDependencies`.
  for (const d of plan.remove) delete (pkg as Record<string, Record<string, unknown>>)[d.section][d.name];
  for (const section of DEP_SECTIONS) {
    const deps = (pkg as Record<string, unknown>)[section];
    if (deps && typeof deps === "object" && Object.keys(deps).length === 0) {
      delete (pkg as Record<string, unknown>)[section];
    }
  }

  if (!pkg.devDependencies) pkg.devDependencies = {};
  pkg.devDependencies["rungate"] = plan.write;

  if (!pkg.scripts) {
    pkg.scripts = {};
  }
  if (!pkg.scripts.test) {
    pkg.scripts.test = "bun test";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  // Names the PATH it wrote, not just what it did (#216), and for a
  // migration also the before and after (#475 SC-4) — the reported cost was
  // a consumer who did not know this was in their package.json until a
  // container build died over it.
  actions.push(
    plan.action === "migrate"
      ? `UPDATED: package.json (rungate devDep migrated: ${plan.reason})`
      : "UPDATED: package.json (rungate devDep)",
  );
}

/**
 * Report what `organizeProject` would adopt, without adopting it (#442).
 *
 * `organizeProject` had exactly one caller and it was a human running
 * `scripts/organize-project.ts`. Nothing in scaffold, ship or any hook
 * invoked it, so re-scaffolding a project — the thing people expected to
 * trigger adoption — could not. A feature nothing invokes is a feature that
 * has never fired, and this one never had.
 *
 * DRY-RUN, always. Discovery stops requiring prior knowledge that the
 * feature exists; adoption stays something a person chooses. The step writes
 * nothing, which is also why it is safe during rehearsal.
 */
export function reportExternalAdoptionStep(root: string, actions: string[]): void {
  const config = loadComplianceConfig(root);
  const sources = config?.organize?.externalSources ?? [];

  if (sources.length === 0) {
    // SC-5, and the decision is to write the list EMPTY. An external source
    // is an absolute path on one person's machine; a default would have
    // scaffold propose adopting documents out of directories the user never
    // named, in every project it touches. Recorded as a line rather than
    // left as an absence, so "nobody configured this" is distinguishable
    // from "this ran and found nothing".
    actions.push(
      "SKIP: external adoption (compliance.json declares no organize.externalSources — " +
      "deliberately empty, an external path is machine-specific and cannot be guessed)",
    );
    return;
  }

  const report = organizeProjectReport(root, { dryRun: true, harnessRoot: root });
  const external = report.proposals.filter(p => p.source.startsWith("/"));

  for (const path of report.unmeasured) {
    actions.push(`UNMEASURED: external source ${path} is declared but not on disk`);
  }
  for (const path of report.unreadable) {
    actions.push(`UNMEASURED: external source ${path} could not be read`);
  }
  for (const p of external) {
    actions.push(`PROPOSED: adopt ${p.source} -> ${p.target} (${p.reasoning})`);
  }
  if (external.length === 0 && report.unmeasured.length === 0 && report.unreadable.length === 0) {
    actions.push(
      `OK: external adoption found nothing (matched against ${report.aliases.join(", ")})`,
    );
  }
}

export function runAuditSpecsFix(root: string, actions: string[]): void {
  const specsDir = join(root, "specs");
  if (!existsSync(specsDir)) {
    actions.push("SKIP: audit-specs (no specs/ directory)");
    return;
  }
  const specFiles = readdirSorted(specsDir).filter(f => f.endsWith(".md"));
  if (specFiles.length === 0) {
    actions.push("SKIP: audit-specs (no spec files)");
    return;
  }
  const result = auditSpecs(root, { fix: true });
  const entries = result.rewrites ?? [];
  // #426: a line that was left alone is not a rewrite. Both are reported,
  // because "the matcher could not bind this" is worth seeing — but only one
  // of them changed what a reader will read, and conflating them is how a
  // silent spec edit hid behind a summary line naming `ci.yml`.
  const rewritten = entries.filter(r => r.kept === undefined);
  const kept = entries.filter(r => r.kept !== undefined);

  if (entries.length > 0) {
    // One action per spec file actually touched, naming the path (#216).
    // "rewrote 2 SCs" named no file, so the rewritten specs were never staged
    // and showed up to the dirty-tree check as somebody else's edit.
    const touched = [...new Set(entries.map(r => `specs/${r.specFile}`))];
    for (const file of touched) actions.push(`UPDATED: ${file} (audit-specs --fix)`);
  }

  // #426 SC-3: every rewritten criterion is named, with its id and its spec.
  // A spec line edited under a documented command and reported only as a
  // count is the defect, not merely the content that was lost.
  for (const r of rewritten) {
    actions.push(`REWROTE: specs/${r.specFile} ${r.scId} as ${r.patternUsed} — was: ${r.before}`);
  }
  for (const r of kept) {
    actions.push(`KEPT: specs/${r.specFile} ${r.scId} — ${r.kept}`);
  }

  // #1286: a spec a generator owns is named here, individually, with the
  // reason. This is the path that edited a consumer's hash-pinned
  // `specs/POV-SPEC.md` under a `UPDATED:` line; a refusal it did not print
  // would be the same failure with the bytes left alone.
  for (const s of result.skipped) actions.push(s.message);

  if (entries.length === 0 && result.skipped.length === 0) {
    actions.push("SKIP: audit-specs (all SCs already matchable)");
  } else if (entries.length > 0) {
    actions.push(
      `SKIP: audit-specs summary (rewrote ${rewritten.length} SCs, left ${kept.length} unmatched but intact)`,
    );
  }
}

/**
 * Paths with TRACKED modifications that this scaffold run did not produce.
 *
 * Untracked files are excluded on purpose: they were never going to be
 * committed, and treating a stray scratch file as "dirty" would refuse on
 * nearly every real repo, which is how a safety check gets switched off.
 */
function dirtyPaths(root: string, generated: string[]): string[] {
  const porcelain = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"]).stdout.toString();
  const owned = (p: string) => generated.some(g => p === g || p.startsWith(`${g}/`));
  return porcelain
    .split("\n")
    .filter(Boolean)
    .filter(l => !l.startsWith("??"))
    // Rename entries read `R  old -> new`; the destination is what matters.
    .map(l => l.slice(3).trim().split(" -> ").pop()!.replace(/^"|"$/g, ""))
    .filter(p => p && !owned(p));
}

/**
 * Print the run's action list and return how many of them were refusals.
 *
 * Lives here rather than in the orchestrator for the reason the whole file
 * exists (SCAFFOLD-DECOMPOSITION-SPEC): scripts/scaffold-project.ts sequences
 * steps, it does not implement them. The caller decides what a refusal costs;
 * this only counts them, so it stays callable from a test.
 */
/**
 * The path a report line says scaffold WROTE, or null if it wrote nothing.
 *
 * One binding, because two callers now depend on the same judgement and a
 * second copy would let them disagree about the same line. `postScaffoldCommit`
 * uses it to decide what to stage — a verb it fails to recognise leaves a
 * generated file uncommitted — and #398's audit/fix agreement check uses it to
 * compare what audit NAMED against what `--fix` actually wrote.
 *
 * Deliberately excludes SKIP / GAP / WARN / AUDIT / UNCHANGED / REFUSED: all
 * of them are lines about a write that did not happen. Getting that wrong in
 * the permissive direction would make audit and fix "agree" by both
 * over-reporting, which is agreement for the wrong reason — see
 * `.claude/rules/checks-must-be-able-to-fail.md` on assertions that hold
 * vacuously. `test/scaffold-audit-agreement.test.ts` pins both directions.
 *
 * **The verb list had drifted from the verbs scaffold emits, and #398's
 * agreement check is what found it.** `REGENERATED`, `REFRESHED` and
 * `REPAIRED` are all writes and none of them was here, so for as long as they
 * have existed `postScaffoldCommit --commit` has quietly failed to stage
 * `AGENTS.md` (REGENERATED, `write-steps.ts`), `.claude/rules/` (REFRESHED,
 * `steps.ts:611`) and any seeded config (REPAIRED, `steps.ts:1181`). The
 * comment above this list used to say missing a verb "silently leaves
 * generated files uncommitted", which was exactly right and exactly what was
 * happening.
 *
 * A prose warning did not keep the list current, so there is now a test that
 * greps the sources for emitted write verbs and fails when one is not here.
 */
export const WRITE_VERBS: readonly string[] = [
  "CREATED", "UPDATED", "REPLACED", "GENERATED", "REGENERATED",
  "REFRESHED", "REPAIRED", "DEPLOYED", "SPLIT",
  // #426: a rewritten SC line is a write to the spec that names it. The
  // `UPDATED:` action for the same file already stages it, so this is
  // belt-and-braces — but a verb that announces an edit and is not here is
  // the exact drift this list exists to stop.
  "REWROTE",
];

export function writtenPath(line: string): string | null {
  const m = line.trim().match(new RegExp(`^(?:${WRITE_VERBS.join("|")}): ([^\\s(]+)`));
  return m?.[1] ?? null;
}

/**
 * What an action line carries when the run that produced it was a rehearsal.
 *
 * **A TRAILING marker, and that is a constraint rather than a preference.**
 * `writtenPath` above matches `^(?:CREATED|UPDATED|…): path` after a trim,
 * and two callers depend on it: `postScaffoldCommit` stages by it, and
 * `test/scaffold-audit-agreement.test.ts` compares the paths audit NAMES
 * against the paths `--fix` WROTE. A leading `REHEARSED ` prefix — the form
 * #642 suggests — makes `writtenPath` return null for every audit line, so
 * that comparison would go green with nothing in it on both sides. Agreement
 * by both sides reporting nothing is the vacuous shape #398 built it to
 * avoid.
 *
 * Square brackets rather than parentheses on purpose: most action lines
 * already end in a parenthetical (`(security template)`, `(rungate devDep)`),
 * and a marker that looks like one more of those is one a reader skims past.
 *
 * One exported binding, so there is one thing to mutate and one string for a
 * consumer to grep.
 */
export const REHEARSAL_MARKER = " [REHEARSAL — not applied]";

/**
 * ## Every line, because a line is the unit a reader consumes (#642)
 *
 * The mode was announced exactly once, by `rehearsalNotice`, at the top of
 * the run — and then no line of the report carried it. Measured on two
 * planted repositories: **all 56 of an audit's report lines were
 * byte-identical to the lines `--fix` printed for the same work.** So
 * `grep ci.yml`, `| tail -25`, a scrolled terminal, and an agent reading the
 * last N lines of a tool result all received `REPLACED: … (+114 lines)` with
 * no way to tell it from a write that landed. The issue's author read one
 * four times and filed a missing-write bug off it. The report never lied;
 * its unit of qualification was wider than its unit of consumption.
 *
 * `mode` is REQUIRED rather than defaulted. A default of `false` is a silent
 * default substitution (`.claude/rules/config-access.md`): a future call site
 * that forgets to say which mode it is in would print unqualified lines and
 * look exactly like one that meant to.
 *
 * **Not sufficient: marking the `Total:` line, or the first line.** That is
 * the cheapest repair and it leaves every grep/tail/scrolled consumer in
 * precisely the position the issue is about. The `Total:` line is marked as
 * well, but after the per-line marking, not instead of it.
 */
export function reportScaffoldActions(actions: string[], mode: { rehearsed: boolean }): number {
  const qualify = (line: string) => (mode.rehearsed ? `${line}${REHEARSAL_MARKER}` : line);
  console.log("\n=== Scaffold Report ===");
  for (const action of actions) console.log(`  ${qualify(action)}`);
  const count = (verb: string) => actions.filter(a => a.startsWith(verb)).length;
  // AUTO-FIXED is reported separately from AUDITED on purpose (#42 SC-3).
  // What the scaffold CHANGED and what it merely NOTICED are different facts,
  // and a reader who cannot tell them apart has to diff the tree to find out
  // which of the reported gaps are still gaps.
  // The marker goes on the END of this line rather than into the `Total:`
  // token: `test/scaffold-auto-fix.test.ts` finds it with
  // `startsWith("\nTotal:")`, and a reader's eye finds it the same way.
  console.log(qualify(`\nTotal: ${count("CREATED")} created, ${count("REPLACED")} replaced, ${count("AUTO-FIXED")} auto-fixed, ${count("SKIP")} skipped, ${count("REFUSED")} refused`));
  return count("REFUSED");
}

export function postScaffoldCommit(
  root: string,
  actions: string[],
  opts: { commit?: boolean } = {},
): void {
  // #216: this used to commit unconditionally. On a consumer repo that meant
  // the documented onboarding command created a commit nobody asked for —
  // and, since it ran after a write that could destroy their ci.yml, it
  // committed the destruction too. Committing is the operator's call now.
  if (!opts.commit) {
    actions.push("SKIP: post-scaffold commit (--commit not passed)");
    return;
  }
  try {
    // Stage ONLY what this scaffold run generated, never `git add -A`.
    //
    // The blanket add swept up whatever else was in the working tree and
    // committed it under "scaffold: initialize rungate harness". Running
    // scaffold mid-session therefore hijacked unrelated in-progress work into
    // a commit with a message describing none of it — and, because the commit
    // already existed, the real commit then had to be an amend.
    const generated = [...new Set(
      actions
        .map(writtenPath)
        .filter((p): p is string => Boolean(p))
        // .git/ contents are not tracked; hooks live there.
        // .git/ contents are never tracked. Directories are kept — scaffold
        // reports some output as a created directory (.claude/rules/) rather
        // than per-file, and git add stages a directory's contents.
        .map(p => p.replace(/\/+$/, ""))
        .filter(p => p && !p.startsWith(".git/") && p !== ".git")
        .filter(p => existsSync(join(root, p)))
    )];

    if (generated.length === 0) {
      actions.push("SKIP: post-scaffold commit (nothing generated)");
      return;
    }

    // Refuse before staging, not after. A commit made on top of someone
    // else's half-finished edit is not something an operator can un-see.
    const dirty = dirtyPaths(root, generated);
    if (dirty.length > 0) {
      actions.push(`REFUSED: post-scaffold commit (dirty working tree: ${dirty.join(", ")})`);
      return;
    }

    Bun.spawnSync(["git", "-C", root, "add", "--", ...generated]);

    // Only commit if staging actually produced a change — re-scaffolding an
    // up-to-date project regenerates identical files and must stay a no-op.
    const staged = Bun.spawnSync(["git", "-C", root, "diff", "--cached", "--name-only"])
      .stdout.toString().trim();
    if (!staged) {
      actions.push("SKIP: post-scaffold commit (no changes)");
      return;
    }

    Bun.spawnSync(["git", "-C", root, "commit", "-m", "scaffold: regenerate harness files"]);
    actions.push("CREATED: post-scaffold commit");
  } catch {
    actions.push("SKIP: post-scaffold commit (git error)");
  }
}
