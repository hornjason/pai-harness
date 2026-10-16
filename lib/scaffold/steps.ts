/**
 * scaffold/steps.ts — All scaffold step functions extracted from scaffold-project.ts.
 *
 * Each function takes a project root path and an actions array for reporting.
 * Pure side-effect functions: read from disk, write to disk, push to actions.
 *
 * Extracted per SCAFFOLD-DECOMPOSITION-SPEC to keep scaffold-project.ts
 * as orchestrator-only (under 200 lines).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { auditSpecs } from "../../scripts/audit-specs";
import { generateAgentsMd as buildAgentsMdContent, generateScopedRules } from "../generators/agents-md";
import { isHarnessItself } from "../harness-identity";
import { generateAgentBriefs as buildAgentBriefsContent } from "../generators/agent-briefs";
import { generateCodeMap as buildCodeMapContent } from "../generators/code-map";
import { buildAgentMeta, DEFAULT_AGENT_META } from "../create-brief";
import { buildDefaultRoles, buildDefaultHooks } from "./defaults";
import {
  mergeManagedWorkflow,
  duplicateTopLevelKeys,
  movedTopLevelKeys,
  type MovedKey,
} from "./managed-workflow";
import { PRE_PUSH_MANAGED_MARKER, prePushHookScript } from "./pre-push-hook";
import { loadComplianceConfig, tryLoadRungateConfig } from "../config-loader";
import { organizeProjectReport } from "../organize";
import type { ProjectScan, ProjectType, SpecEntry, TestFile, RefFile, DocRoute, Category } from "../generators/types";
import { tier1Ere } from "../secret-patterns";
import { healthPathIn } from "../liveness-contradiction";
import { decideRuleWrite } from "../rule-provenance";
import { DEFAULT_PROFILE, isRuleIncluded, type ScaffoldProfile } from "./profiles";
import { referencedPaths } from "../agents-md-refs";
import { readSuccessDoc, seedFromTemplate, successViolations } from "../success-doc";
import { TS_SOURCE_DIRS, typeScriptSourceDirs, typecheckDecision } from "../typescript-project";
import {
  OWNED_FILES,
  SCAFFOLD_REFUSE,
  decideOwnedWrite,
  type WriteStrategy,
} from "./owned-files";

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
  for (const owned of OWNED_FILES) {
    if (owned.path === label) return owned.strategy;
    if (owned.path.includes("*")) {
      const [prefix, suffix] = owned.path.split("*");
      if (label.startsWith(prefix) && label.endsWith(suffix)) return owned.strategy;
    }
  }
  // An unlisted file is regenerated. The direction this is allowed to be
  // wrong in: a file nobody declared gets rewritten with the generator's
  // own output, which is recoverable. Defaulting to create-only would make
  // forgetting to declare a file look exactly like #208.
  return "regenerate";
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
  const decision = decideOwnedWrite(strategy, existing, content);

  if (decision.action === "preserve") {
    actions.push(
      `${SCAFFOLD_REFUSE}: ${label} (${decision.reason}) — generator output withheld; ` +
        `delete the file and re-run to accept it`,
    );
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

export function updateSpecsTable(agentsMdPath: string, actions: string[]): void {
  if (!existsSync(agentsMdPath)) return;
  const specsDir = join(dirname(agentsMdPath), "specs");
  if (!existsSync(specsDir)) return;

  const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
  if (specFiles.length === 0) return;

  const specRows: string[] = [];
  for (const f of specFiles) {
    const content = readFileSync(join(specsDir, f), "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let testable = "false";
    let governs = f.replace(/\.md$/, "");
    if (fmMatch) {
      const tMatch = fmMatch[1].match(/testable:\s*(true|false)/);
      if (tMatch) testable = tMatch[1];
      const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
      if (gMatch) governs = gMatch[1].trim();
    }
    specRows.push(`| ${f} | ${governs} | ${testable === "true" ? "yes" : "no"} |`);
  }

  const existing = readFileSync(agentsMdPath, "utf-8");
  const tablePattern = /(\|[^\n]*Spec[^\n]*\|\n\|[-| ]+\|\n)((?:\|[^\n]+\|\n)*)/;
  const match = existing.match(tablePattern);
  if (match) {
    const newTable = match[1] + specRows.join("\n") + "\n";
    const updated = existing.replace(tablePattern, newTable);
    writeFileSync(agentsMdPath, updated);
    actions.push("UPDATED: AGENTS.md specs table from frontmatter");
  }
}

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
    { file: "PROJECT-STATE.md", what: "Live status + handoff (generated from project-state.json — don't edit directly)", when: "Session start, always first after AGENTS.md" },
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

  // Scan specs
  const specsDir = join(projectPath, "specs");
  const specEntries: SpecEntry[] = [];
  if (existsSync(specsDir)) {
    const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
    for (const f of specFiles) {
      const content = readFileSync(join(specsDir, f), "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let governs = "";
      let testable = "TODO";
      if (fmMatch) {
        const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
        if (gMatch && gMatch[1].trim() !== "TODO" && gMatch[1].trim().length > 5) {
          governs = gMatch[1].trim().replace(/\|/g, "—").slice(0, 120);
        }
        const tMatch = fmMatch[1].match(/testable:\s*(.+)/);
        if (tMatch) testable = tMatch[1].trim();
      }
      specEntries.push({ file: f, governs, testable });
    }

    // Also scan specs subdirectories
    try {
      const specSubDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const sub of specSubDirs) {
        const subPath = join(specsDir, sub);
        const subFiles = readdirSync(subPath).filter(f => f.endsWith(".md") && f !== "INDEX.md");
        if (subFiles.length > 0) {
          const indexPath = join(subPath, "INDEX.md");
          let groupGoverns = `${sub} (${subFiles.length} specs)`;
          if (existsSync(indexPath)) {
            const indexContent = readFileSync(indexPath, "utf-8");
            const fmMatch = indexContent.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
              if (gMatch && gMatch[1].trim().length > 5) {
                groupGoverns = gMatch[1].trim().replace(/\|/g, "—").slice(0, 120);
              }
            }
          }
          specEntries.push({ file: `${sub}/ (${subFiles.length} specs)`, governs: groupGoverns, testable: "yes" });
        }
      }
    } catch {}
  }

  // Scan tests
  const testDir = existsSync(join(projectPath, "test")) ? "test" : existsSync(join(projectPath, "tests")) ? "tests" : null;
  const testEntries: TestFile[] = [];
  if (testDir) {
    for (const f of readdirSync(join(projectPath, testDir)).filter(f => f.endsWith(".test.ts"))) {
      const label = f.replace(".test.ts", "").replace(/-/g, " ");
      testEntries.push({ label, file: f });
    }
  }

  // Detect test command
  let testCmd = "bun test";
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test) testCmd = pkg.scripts.test;
    } catch {}
  }

  // Scan reference files
  const refDir = join(projectPath, "reference");
  const refEntries: RefFile[] = [];
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
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
      const files = readdirSync(catPath, { recursive: true }).map(String).filter(f => f.endsWith(".md"));
      docRouting.push({ need: `${cat.label} (${files.length} files)`, file: `${cat.dir}/` });
    } else {
      docRouting.push({ need: cat.label, file: `${cat.dir}/` });
      actions.push(`WARN: ${cat.dir}/ listed in routing but directory does not exist`);
    }
  }
  if (existsSync(docsDir)) {
    const allDocs = readdirSync(docsDir).filter(f => f.endsWith(".md"));
    for (const f of allDocs) {
      const docPath = join(docsDir, f);
      const content = readFileSync(docPath, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let need = f.replace(/\.md$/, "").replace(/-/g, " ");
      if (fmMatch) {
        const gMatch = fmMatch[1].match(/governs:\s*(.+)/);
        if (gMatch && gMatch[1].trim() !== "TODO") need = gMatch[1].trim();
      }
      docRouting.push({ need, file: `docs/${f}` });
    }
    const subDirs = readdirSync(docsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !categories.some(c => c.dir === `docs/${d.name}`))
      .map(d => d.name);
    for (const sub of subDirs) {
      const subPath = join(docsDir, sub);
      const subFiles = readdirSync(subPath).filter(f => f.endsWith(".md"));
      if (subFiles.length > 0) {
        docRouting.push({ need: `${sub} (${subFiles.length} files)`, file: `docs/${sub}/` });
      }
    }
  }
  const filteredRouting = docRouting.filter(d => {
    const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "").toLowerCase().replace(/-/g, " ");
    const needLower = d.need.toLowerCase();
    return !needLower.startsWith(slug) || d.need.includes("—") || d.need.includes("(");
  });

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
 * through `updateSpecsTable` and `injectEnvironmentSection` by this point, and
 * rewriting it would undo both.
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

  // Check specs table
  const specsDir = join(root, "specs");
  if (existsSync(specsDir)) {
    const actualSpecs = readdirSync(specsDir).filter(f => f.endsWith(".md"));
    const unlisted = actualSpecs.filter(f => !content.includes(f));
    if (unlisted.length > 0) {
      issues.push(`UNLISTED specs: ${unlisted.join(", ")} (in specs/ but not in AGENTS.md)`);
    }
  }

  // Check CODE-MAP.md reference
  if (existsSync(join(root, "CODE-MAP.md")) && !content.includes("CODE-MAP")) {
    issues.push("CODE-MAP.md exists but not referenced in AGENTS.md routing table");
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
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runDirectoryValidation, runPackageValidation, runTsconfigValidation, runConfigAccessValidation, runPromptConfigAccessValidation, runSuccessDocValidation, writeFindingsReport } from "${from}";

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

afterAll(() => writeFindingsReport(ROOT));
`;
}

// ── Agent briefs generation ────────────────────────────────────

export function generateAgentBriefsStep(root: string, actions: string[]): void {
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
    const promptFiles = readdirSync(promptsDir).filter(f => f.endsWith(".md"));
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
  const harnessTemplatesDir = join(dirname(dirname(__dirname)), "templates", "agent-briefs");

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
    testCmd: harness?.dev?.testCmd || "bun test",
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
    writeFileSync(p, content);
    actions.push(existsSync(p) ? `UPDATED: .claude/agents/${agentName}.md` : `CREATED: .claude/agents/${agentName}.md`);
  }
}

// ── Harness config generation/audit ────────────────────────────

export function generateOrAuditProjectHarness(root: string, actions: string[]): void {
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
    const pageFiles = readdirSync(dashboardPagesDir).filter(f => f.endsWith(".tsx") || f.endsWith(".jsx"));
    for (const f of pageFiles) {
      const componentName = f.replace(/\.(tsx|jsx)$/, "");
      // Convert CamelCase to kebab-case route path
      const routePath = "/" + componentName
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
      scannedPages[routePath] = componentName;
    }
  }

  // Scan test commands
  const pkgPath = join(root, "package.json");
  let testCmd = "bun test";
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.scripts?.test) testCmd = pkg.scripts.test;
  }
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
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
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
    auditExistingConfig(existing, scannedPages, scannedConsumers, actions, rungateDir);
  } else if (existsSync(harnessPath)) {
    // Monolith exists — split into directory structure
    const existing = JSON.parse(readFileSync(harnessPath, "utf-8"));

    // Check if monolith has roles/hooks/compliance to split
    if (existing.roles || existing.hooks || existing.compliance) {
      splitMonolithToDirectory(root, existing, actions);
    } else {
      // Simple monolith without split-worthy content — audit only
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
        bunVersion: "latest",
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

function auditExistingConfig(
  existing: any,
  scannedPages: Record<string, string>,
  scannedConsumers: string[],
  actions: string[],
  rungateDir?: string
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
      issues.push(`CONSUMERS: ${staleConsumers.length} stale consumers in rungate.json not found in source: ${staleConsumers.slice(0, 5).join(", ")}`);
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
export function generateCodeMapStep(root: string, actions: string[]): void {
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
  const scriptPath = join(dirname(dirname(__dirname)), "scripts", "generate-code-map.ts");
  if (existsSync(scriptPath)) {
    const result = Bun.spawnSync(["bun", scriptPath, root], { timeout: 60_000 });
    if (result.exitCode === 0) {
      actions.push(existsSync(codeMapPath) ? "UPDATED: CODE-MAP.md" : "CREATED: CODE-MAP.md");
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
  const dirs: Array<{ name: string; fileCount: number; types: string[] }> = [];
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(".") && entry !== ".claude") continue;
    if (skip.has(entry)) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      const files = readdirSync(full, { recursive: true }).map(String);
      const exts = new Set(files.map(f => f.split(".").pop()).filter((e): e is string => Boolean(e)));
      dirs.push({ name: entry, fileCount: files.length, types: [...exts].slice(0, 5) });
    } catch {}
  }
  dirs.sort((a, b) => b.fileCount - a.fileCount);

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
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
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
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"))) {
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
  const existingSpecs = readdirSync(specsDir).filter(
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
  writeFileSync(join(specsDir, "SPEC-TEMPLATE.md"), template);
  actions.push("CREATED: specs/SPEC-TEMPLATE.md (starter template)");
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
  return requiredGitignorePatterns().filter(p => !present.has(p));
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

  const today = new Date().toISOString().split("T")[0];

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
  const templatePath = join(dirname(dirname(__dirname)), "templates", "SUCCESS-TEMPLATE.md");
  if (!existsSync(templatePath)) {
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

  const today = new Date().toISOString().slice(0, 10);
  const owner = process.env.USER || "TODO-OWNER";
  // The SHARED substitution. Writing the template raw here while
  // `create-success` substituted meant one seed with two possible byte
  // sequences, and a scaffolded SUCCESS.md kept `owner: TODO-OWNER` forever.
  const seeded = seedFromTemplate(readFileSync(templatePath, "utf-8"), owner, today);
  safeWrite(join(root, "SUCCESS.md"), seeded, "SUCCESS.md", actions);

  const verdict = successViolations(readSuccessDoc(root), readFileSync(templatePath, "utf-8"));
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
export function resolveManagedWrite(existing: string | null, generated: string): ManagedWrite {
  const base: ManagedWrite = {
    content: generated, verb: "CREATED", lineDelta: lineCount(generated),
    preservedJobs: [], droppedJobs: [], overwrittenLines: [], movedKeys: [], refusal: null,
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
  const content = mergeManagedWorkflow(existing, generated);
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
  // The harness's own banner is the harness's to reword. Without this, the
  // first run after the banner's text changed refused to update a file the
  // harness had written itself, naming its own previous sentence as consumer
  // content it declined to drop — a refusal is only useful if it is about
  // somebody else's work.
  for (const l of nonBlankLines(existing)) {
    if (l.startsWith(MANAGED_BANNER_PREFIX)) harnessOwned.add(l);
  }

  const kept = new Set(nonBlankLines(content));
  const gone = nonBlankLines(existing).filter(l => !kept.has(l));
  const lostLines = gone.filter(l => !harnessOwned.has(l));
  const overwrittenLines = gone.filter(l => harnessOwned.has(l) && !l.startsWith(MANAGED_BANNER_PREFIX));
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

  return { content, ...measureWrite(existing, content), preservedJobs, droppedJobs: [], overwrittenLines, movedKeys, refusal: null };
}

/** Non-blank lines, trimmed — the unit the loss set is counted in. */
function nonBlankLines(text: string): string[] {
  return text.split("\n").map(l => l.trim()).filter(l => l !== "");
}

/**
 * Opening of the banner every generated workflow carries.
 *
 * Deliberately the stable prefix and not the whole sentence: the rest of it
 * names the config path, and that is exactly the part that changed and caused
 * the harness to refuse to update its own file.
 */
const MANAGED_BANNER_PREFIX = "# Managed by rungate";

/**
 * Write a harness-managed file, preserving whatever the harness did not author.
 *
 * Throws on refusal. Callers decide whether a refusal aborts the run or is
 * recorded and reported; what they may not do is write anyway.
 */
export function writeManagedFile(
  filePath: string,
  generated: string,
  label: string,
  actions: string[],
  opts: { force?: boolean } = {},
): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const resolved = resolveManagedWrite(existing, generated);

  if (opts.force) {
    // The escape hatch, and it still reports a measured verb: --force changes
    // what is ALLOWED, not what gets claimed about it. The dropped jobs are
    // still named, because an operator who overrides the refusal should be
    // told in the report exactly what they overrode.
    const { verb, lineDelta } = measureWrite(existing, generated);
    if (verb === "SKIP") { actions.push(`SKIP: ${label} (unchanged)`); return; }
    const dropped = resolved.droppedJobs.length > 0 ? `, dropped ${resolved.droppedJobs.join(", ")}` : "";
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, generated);
    actions.push(`${verb}: ${label} (--force, ${signed(lineDelta)} lines${dropped})`);
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

  if (resolved.verb === "SKIP") {
    actions.push(`SKIP: ${label} (unchanged${kept})`);
    return;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, resolved.content);
  actions.push(`${resolved.verb}: ${label} (${signed(resolved.lineDelta)} lines${kept}${overwrote})`);
}

export function createCiWorkflows(root: string, actions: string[], opts: { force?: boolean } = {}): void {
  const workflowsDir = join(root, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  const harness = loadHarnessConfig(root);
  const bunVersion = harness?.ci?.bunVersion || "latest";
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
  const baseRefStep =
    SAFE_BRANCH.test(baseBranch) && !baseBranch.includes("..")
      ? // `--depth=200`, not `--depth=1`. The conformity ratchet only diffs the
        // tip and was happy with one commit, but a tip with no history behind
        // it makes any check that reads the recent log unmeasurable — and an
        // empty log is indistinguishable from a clean one. Two hundred commits
        // is a few hundred KB and spans months of this project's history.
        `      - name: Fetch the comparison base for the conformity ratchet
        run: |
          git fetch --no-tags --depth=200 origin '+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}' \\
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
  const typecheck = typecheckDecision(root);
  const typecheckStep = typecheck.command
    ? `\n      - run: ${typecheck.command}`
    : `\n      # No type check: ${typecheck.reason}.`;

  const ciYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
name: CI

on:
  push:
    branches:
${branchList}
  pull_request:
    branches:
${branchList}

jobs:
  test:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
${baseRefStep}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"
      - run: bun install
      - run: bun test${typecheckStep}
`;

  const gatesYml = `# Managed by rungate — do not edit. Customize the ci section of .claude/rungate/config.json.
name: Gates

on:
  push:
    branches:
${branchList}
  pull_request:
    branches:
${branchList}

jobs:
  gates:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${bunVersion}"
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
          set +e
          tier2=$(git grep -I -hoE '(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+=_.-]{12,}' -- .)
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
          if printf '%s\\n' "$tier2" | grep -qvE '^$|[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)'; then
            echo "::error::Potential credential assignment in tracked files"
            exit 1
          fi
          echo "Secret scan clean"
`;

  // Not `writeFileSync`. The harness owns the `test` and `gates` jobs; it does
  // not own the file, and a consumer's own jobs have to survive the update
  // that re-scaffolding IS. A refusal is recorded rather than thrown so that
  // one unpreservable workflow does not abandon the rest of the scaffold
  // half-done — scripts/scaffold-project.ts exits non-zero on it.
  for (const [name, content] of [["ci.yml", ciYml], ["gates.yml", gatesYml]] as const) {
    const label = `.github/workflows/${name}`;
    try {
      writeManagedFile(join(workflowsDir, name), content, label, actions, opts);
    } catch (e) {
      actions.push(`REFUSED: ${(e as Error).message}`);
    }
  }
}

// ── Consumer hook deployment ─────────────────────────────────

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
  if (!harness) return;

  if (!harness?.hooks || !Array.isArray(harness.hooks)) return;
  if (!harness?.consumers || !Array.isArray(harness.consumers) || harness.consumers.length === 0) return;

  const hooksDir = join(root, "hooks");

  for (const consumer of harness.consumers) {
    const consumerRoot = consumer.startsWith("/") ? consumer : join(root, consumer);
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
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    }

    if (!settings.hooks) settings.hooks = {};

    let deployed = 0;
    for (const hook of harness.hooks) {
      if (!hook.enabled || !hook.hookFor || !hook.command) continue;
      if (hook.deployToConsumers !== true) continue;

      const resolvedCommand = hook.command.replace("${RUNGATE_HOOKS_DIR}", hooksDir);
      const hookType = hook.hookFor as string;

      if (!settings.hooks[hookType]) settings.hooks[hookType] = [];

      // Check if this hook is already deployed
      const existing = settings.hooks[hookType].find(
        (h: any) => h.command === resolvedCommand || (h.command && h.command.includes(hook.name))
      );
      if (existing) continue;

      const hookEntry: any = { command: resolvedCommand };
      if (hook.matcher) hookEntry.matcher = hook.matcher;

      settings.hooks[hookType].push(hookEntry);
      deployed++;
    }

    if (deployed > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      actions.push(`DEPLOYED: ${deployed} hooks to ${consumer}/.claude/settings.local.json`);
    } else {
      actions.push(`SKIP: All hooks already deployed to ${consumer}`);
    }
  }
}

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

export function createGitHooks(root: string, actions: string[]): void {
  const hooksDir = join(root, ".git", "hooks");
  if (!existsSync(hooksDir)) return;

  const { chmodSync } = require("fs");

  const preCommit = join(hooksDir, "pre-commit");
  const existingPreCommit = existsSync(preCommit) ? readFileSync(preCommit, "utf-8") : null;
  if (existingPreCommit !== null && !existingPreCommit.includes(PRE_COMMIT_MANAGED_MARKER)) {
    actions.push("SKIP: .git/hooks/pre-commit (hand-written, not overwriting)");
  } else {
    writeFileSync(preCommit, `#!/bin/sh
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
if printf '%s\\n' "$staged_diff" \\
  | grep '^+' \\
  | grep -oE '(password|passwd|api[_-]?key|secret)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9/+=_.-]{12,}' \\
  | grep -qvE '[:=][[:space:]]*(process\\.env|os\\.environ|Deno\\.env|getenv|REDACTED|CHANGEME|placeholder)'; then
  echo "ERROR: Potential credential assignment in staged changes"
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
if [ -f "project-state.json" ]; then
  gitdir=$(git rev-parse --git-dir)
  commondir=$(git rev-parse --git-common-dir)
  if [ -n "$gitdir" ] && [ "$gitdir" = "$commondir" ]; then
    bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true
    git add PROJECT-STATE.md project-state.json 2>/dev/null || true
  else
    # Announced, not silent. A developer who expected the state files to move
    # would otherwise be left guessing, and SKIP that says nothing is
    # indistinguishable from the update having happened.
    echo "project-state: SKIPPED — linked worktree. project-state.json, PROJECT-STATE.md and SUCCESS.md are DA-owned (#296); update them from the primary checkout."
  fi
fi

# A script's exit status is its last command's. Without this, the [ -f ] test
# failing (no project-state.json) or git add failing (no PROJECT-STATE.md yet)
# made the hook exit non-zero and reject a perfectly good commit. Everything
# that should block has already exited 1 above.
exit 0
`);
    chmodSync(preCommit, 0o755);
    actions.push(
      existingPreCommit === null
        ? "CREATED: .git/hooks/pre-commit (secret scan + PROJECT-STATE update)"
        : "UPDATED: .git/hooks/pre-commit (secret scan + PROJECT-STATE update)",
    );
  }

  const prePush = join(hooksDir, "pre-push");
  const MANAGED_MARKER = PRE_PUSH_MANAGED_MARKER;

  // `2>/dev/null` threw away the only output that said WHY conformity failed,
  // leaving the developer a bare "fix before pushing" and no diagnosis. And the
  // old guard was `if (!existsSync(prePush))`, so once a hook existed it was
  // never updated again — every fix to this hook, including this one, would
  // have reached nobody. Overwrite only our own managed hook; a hook a human
  // wrote is left alone.
  const existing = existsSync(prePush) ? readFileSync(prePush, "utf-8") : null;
  if (existing !== null && !existing.includes(MANAGED_MARKER)) {
    actions.push("SKIP: .git/hooks/pre-push (hand-written, not overwriting)");
    return;
  }

  // Checks the COMMITS BEING PUSHED, not the working tree (#85).
  //
  // The old hook ran the conformity suite in the working tree, which is not
  // what is being pushed. On 2026-10-05 that let a regression reach main:
  // HYGIENE-3's reference index recursed into .claude/worktrees/, 39 full repo
  // copies that exist locally and not in a clean checkout, so every file
  // looked referenced. It passed before push and Gates went red on main. A
  // gate that inspects something other than what it is gating is not a weaker
  // gate; it is a different gate wearing the name of the one you wanted.
  //
  // On node_modules, which #85 left open: symlinking the working tree's is
  // fast, and it is honest exactly while the pushed commit's lockfile matches
  // the one those modules were installed from. Installing unconditionally is
  // correct and slow enough that people disable the hook, which is worse than
  // either. So compare the lockfiles and only pay for an install when they
  // actually differ — the common push changes no dependencies and keeps the
  // fast path, and the push that does change them cannot quietly test against
  // the wrong ones.
  //
  // The script itself lives in lib/scaffold/pre-push-hook.ts (#397). As a
  // template literal here it was unrunnable, and the thing nothing runs is
  // the thing nothing checks: the lockfile comparison read the CHECKOUT's
  // `bun.lock`, so a consumer that gitignores its lockfile could never take
  // the fast path and could never pass. Over there it is one binding with one
  // exit-code constant, and test/pre-push-hook.test.ts drives it against
  // planted repositories.
  writeFileSync(prePush, prePushHookScript());
  chmodSync(prePush, 0o755);
  actions.push(existing === null
    ? "CREATED: .git/hooks/pre-push (conformity check)"
    : "UPDATED: .git/hooks/pre-push (conformity check)");
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
  const specFiles = readdirSync(specsDir).filter(f => f.endsWith(".md"));
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

  if (entries.length === 0) {
    actions.push("SKIP: audit-specs (all SCs already matchable)");
  } else {
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

export function reportScaffoldActions(actions: string[]): number {
  console.log("\n=== Scaffold Report ===");
  for (const action of actions) console.log(`  ${action}`);
  const count = (verb: string) => actions.filter(a => a.startsWith(verb)).length;
  console.log(`\nTotal: ${count("CREATED")} created, ${count("REPLACED")} replaced, ${count("SKIP")} skipped, ${count("REFUSED")} refused`);
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
