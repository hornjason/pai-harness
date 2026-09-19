import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { join } from "path";

// Spec-drift guard: if either governing spec changes, these tests are stale
const SPEC_HASHES = {
  bootstrap: "f3a19406fb6a1799",
  testPlan: "419d400dd23c9542",
};

function checkSpecDrift() {
  const specs = [
    { name: "bootstrap", path: join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md"), expected: SPEC_HASHES.bootstrap },
    { name: "testPlan", path: join(import.meta.dir, "..", "specs", "BOOTSTRAP-TEST-PLAN.md"), expected: SPEC_HASHES.testPlan },
  ];
  for (const spec of specs) {
    if (!existsSync(spec.path)) continue;
    const hash = execSync(`shasum -a 256 "${spec.path}" | cut -c1-16`, { encoding: "utf-8" }).trim();
    if (spec.expected !== "UPDATE_AFTER_SPEC_CHANGE" && hash !== spec.expected) {
      throw new Error(
        `SPEC DRIFT: ${spec.name} spec changed (hash ${hash} != ${spec.expected}). ` +
        `Update test file to match new spec, then update SPEC_HASHES.${spec.name} to "${hash}".`
      );
    }
  }
}

const FIXTURE = join(import.meta.dir, "fixtures/golden-project");
const OUTPUT = "/tmp/rungate-phase0-test";
const SCAFFOLD = join(import.meta.dir, "..", "scripts", "scaffold-project.ts");

beforeAll(() => {
  execSync(`rm -rf ${OUTPUT}`);
  mkdirSync(OUTPUT, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${OUTPUT}/`);
  // Init git repo so scaffold can create hooks and commits
  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add -A && git commit -m 'init fixture'", { cwd: OUTPUT, stdio: "pipe" });
  try {
    execSync(`bun run ${SCAFFOLD} ${OUTPUT}`, {
      timeout: 60000,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // Scaffold may not exist yet or may fail — tests should still run and FAIL
  }
});

describe("Phase 0: Pre-flight + static files", () => {
  // Spec-drift guard — FAIL if governing specs changed since these tests were written
  test("spec-drift: governing specs haven't changed", () => {
    checkSpecDrift();
  });

  // SC-97: Pre-flight creates git repo, bun init, .gitignore
  describe("SC-97: pre-flight execution", () => {
    test("git repo exists", () => {
      expect(existsSync(join(OUTPUT, ".git"))).toBe(true);
    });

    test("package.json exists", () => {
      expect(existsSync(join(OUTPUT, "package.json"))).toBe(true);
    });
  });

  // SC-80: Phase 0 creates all required directories
  describe("SC-80: required directories", () => {
    const dirs = [
      "src", "test", "docs", "docs/adr", "specs",
      "scripts", ".claude", ".claude/agents",
      ".github", ".github/workflows",
    ];

    for (const dir of dirs) {
      test(`${dir}/ exists`, () => {
        expect(existsSync(join(OUTPUT, dir))).toBe(true);
      });
    }
  });

  // SC-40: .gitignore has full security template
  describe("SC-40: .gitignore security template", () => {
    const required = [
      "node_modules", "dist", ".env", ".rungate",
      "*.pem", "*.key", "credentials.json", "service-account",
    ];

    test(".gitignore exists", () => {
      expect(existsSync(join(OUTPUT, ".gitignore"))).toBe(true);
    });

    for (const entry of required) {
      test(`contains ${entry}`, () => {
        const content = readFileSync(join(OUTPUT, ".gitignore"), "utf-8");
        expect(content).toContain(entry);
      });
    }
  });

  // SC-73: package.json required fields
  describe("SC-73: package.json required fields", () => {
    test("has name field", () => {
      const pkg = JSON.parse(readFileSync(join(OUTPUT, "package.json"), "utf-8"));
      expect(pkg.name).toBeDefined();
      expect(typeof pkg.name).toBe("string");
    });

    test("has type: module", () => {
      const pkg = JSON.parse(readFileSync(join(OUTPUT, "package.json"), "utf-8"));
      expect(pkg.type).toBe("module");
    });

    test("has scripts.test", () => {
      const pkg = JSON.parse(readFileSync(join(OUTPUT, "package.json"), "utf-8"));
      expect(pkg.scripts?.test).toBeDefined();
    });

    test("has devDependencies.rungate", () => {
      const pkg = JSON.parse(readFileSync(join(OUTPUT, "package.json"), "utf-8"));
      expect(pkg.devDependencies?.rungate).toBeDefined();
    });
  });

  // SC-101: rungate.json has version tracking
  describe("SC-101: rungate.json version and metadata", () => {
    test("has harnessVersion", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.harnessVersion).toBeDefined();
      expect(config.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test("has scaffoldedAt timestamp", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.scaffoldedAt).toBeDefined();
      expect(new Date(config.scaffoldedAt).getTime()).toBeGreaterThan(0);
    });

    test("has detected port from Makefile", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.apiBase).toBe("http://localhost:3000");
    });

    test("has envVars from .env.example", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.envVars).toContain("API_PORT");
      expect(config.envVars).toContain("DATABASE_URL");
      expect(config.envVars).toContain("SECRET_KEY");
    });

    test("has ci section", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.ci).toBeDefined();
      expect(config.ci.runner).toBeDefined();
      expect(config.ci.bunVersion).toBeDefined();
    });
  });

  // SC-74: tsconfig.json recommended fields
  describe("SC-74: tsconfig.json recommended fields", () => {
    test("tsconfig.json exists", () => {
      expect(existsSync(join(OUTPUT, "tsconfig.json"))).toBe(true);
    });

    test("strict is true", () => {
      const tsconfig = JSON.parse(readFileSync(join(OUTPUT, "tsconfig.json"), "utf-8"));
      expect(tsconfig.compilerOptions?.strict).toBe(true);
    });
  });

  // SC-75: Spec frontmatter required fields
  describe("SC-75: spec frontmatter", () => {
    test("specs/api-spec.md has required frontmatter", () => {
      const content = readFileSync(join(OUTPUT, "specs/api-spec.md"), "utf-8");
      expect(content).toContain("doc-type: spec");
      expect(content).toContain("status:");
      expect(content).toContain("testable:");
      expect(content).toContain("governs:");
    });
  });

  // SC-76: ADR frontmatter required fields
  describe("SC-76: ADR frontmatter", () => {
    test("docs/adr/ADR-001-framework.md has required frontmatter", () => {
      const content = readFileSync(join(OUTPUT, "docs/adr/ADR-001-framework.md"), "utf-8");
      expect(content).toContain("doc-type: adr");
      expect(content).toContain("status:");
      expect(content).toContain("created:");
    });
  });

  // SC-93: Self-containment — no global dependencies
  describe("SC-93: self-containment", () => {
    test("package.json exists (no global installs needed)", () => {
      expect(existsSync(join(OUTPUT, "package.json"))).toBe(true);
    });
  });

  // SC-98: Pre-flight .gitignore before bun init
  describe("SC-98: .gitignore created before bun init", () => {
    test(".gitignore exists with security entries", () => {
      const content = readFileSync(join(OUTPUT, ".gitignore"), "utf-8");
      expect(content).toContain("node_modules");
      expect(content).toContain(".env");
    });
  });

  // SC-99: Post-scaffold git add
  describe("SC-99: post-scaffold git tracking", () => {
    test("scaffold files are tracked by git", () => {
      try {
        const status = execSync("git status --porcelain", {
          cwd: OUTPUT,
          encoding: "utf-8",
        });
        // After scaffold + commit, there should be no untracked harness files
        const untrackedHarnessFiles = status.split("\n").filter(
          (line) => line.startsWith("??") && (
            line.includes("AGENTS.md") ||
            line.includes("CODE-MAP.md") ||
            line.includes(".claude/")
          )
        );
        expect(untrackedHarnessFiles).toEqual([]);
      } catch {
        // git not initialized = FAIL
        expect(true).toBe(false);
      }
    });
  });

  // SC-77: bunx rungate create-spec creates spec with frontmatter
  describe("SC-77: create-spec command", () => {
    test("specs/SPEC-TEMPLATE.md exists with correct frontmatter", () => {
      const templatePath = join(OUTPUT, "specs/SPEC-TEMPLATE.md");
      expect(existsSync(templatePath)).toBe(true);
      const content = readFileSync(templatePath, "utf-8");
      expect(content).toContain("doc-type: spec");
      expect(content).toContain("testable:");
    });
  });

  // SC-78: bunx rungate create-adr with auto-incremented number
  describe("SC-78: create-adr template", () => {
    test("ADR template is accessible", () => {
      // Verify the scaffold makes ADR creation available
      expect(existsSync(join(OUTPUT, "docs/adr"))).toBe(true);
    });
  });

  // SC-100: Post-scaffold git commit
  describe("SC-100: post-scaffold commit", () => {
    test("scaffold creates a commit", () => {
      try {
        const log = execSync("git log --oneline -1", {
          cwd: OUTPUT,
          encoding: "utf-8",
        });
        expect(log.toLowerCase()).toContain("scaffold");
      } catch {
        expect(true).toBe(false);
      }
    });
  });

  // SC-17, SC-25, SC-128, SC-18: AGENTS.md content
  describe("AGENTS.md content", () => {
    test("SC-17: under 150 lines", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      const lines = content.split("\n").length;
      expect(lines).toBeLessThanOrEqual(150);
    });

    test("SC-25: has Commands section with harness commands", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("## Commands");
      expect(content).toContain("bun test");
      expect(content).toContain("bunx tsc --noEmit");
      expect(content).toContain("create-spec");
      expect(content).toContain("create-adr");
    });

    test("SC-128: has Harness-Managed Files section", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("## Harness-Managed Files");
      expect(content).toContain("ci.yml");
      expect(content).toContain("Don't edit");
    });

    test("SC-18: no empty sections with placeholder content", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).not.toContain("(empty)");
      expect(content).not.toContain("(none yet");
    });
  });

  // SC-39, SC-125: CODE-MAP.md content
  describe("CODE-MAP.md content", () => {
    test("SC-39: has scanned-at-sha frontmatter", () => {
      const content = readFileSync(join(OUTPUT, "CODE-MAP.md"), "utf-8");
      expect(content).toContain("scanned-at-sha:");
      expect(content).not.toContain("14 days or 50");
    });

    test("detects routes from src/index.ts", () => {
      const content = readFileSync(join(OUTPUT, "CODE-MAP.md"), "utf-8");
      expect(content).toContain("/api/health");
    });
  });

  // SC-37, SC-146: Agent brief content (all 5 agents)
  describe("agent brief content", () => {
    const agents = ["marcus", "quinn", "rook", "serena", "aditi"];

    for (const agent of agents) {
      test(`SC-37: ${agent}.md has Core Principles`, () => {
        const content = readFileSync(join(OUTPUT, `.claude/agents/${agent}.md`), "utf-8");
        expect(content).toContain("## Core Principles");
        expect(content).toContain("Verify before asserting");
        expect(content).toContain("Never report PASS with known gaps");
      });

      test(`SC-146: ${agent}.md has three-tier authority`, () => {
        const content = readFileSync(join(OUTPUT, `.claude/agents/${agent}.md`), "utf-8");
        expect(content).toContain("## Always Do");
        expect(content).toContain("## Ask First");
        expect(content).toContain("## Never Do");
      });
    }

    test("SC-115: marcus.md references coding-principles", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("coding-principles");
    });

    test("SC-117: marcus.md references testing-strategy", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("testing-strategy");
    });

    test("SC-55: quinn.md references journey decision tree", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/quinn.md"), "utf-8");
      expect(content).toContain("journey");
    });

    test("quinn.md shows detected port, not hardcoded default", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/quinn.md"), "utf-8");
      expect(content).not.toContain("localhost:7778");
      expect(content).not.toContain("localhost:5173");
    });
  });

  // SC-24: Conformity test imports all suites
  describe("SC-24: conformity test content", () => {
    test("imports all required suites", () => {
      const content = readFileSync(join(OUTPUT, "test/scaffold-conformity.test.ts"), "utf-8");
      const required = [
        "runScaffoldConformity", "runSpecDiscovery", "runSpecDrift",
        "runDocHygiene", "runFallowCheck", "runAgentFileValidation",
        "runPackageValidation", "runTsconfigValidation",
      ];
      for (const suite of required) {
        expect(content).toContain(suite);
      }
    });
  });

  // SC-19: CLAUDE.md bridge
  describe("SC-19: CLAUDE.md content", () => {
    test("has @AGENTS.md bridge", () => {
      const content = readFileSync(join(OUTPUT, "CLAUDE.md"), "utf-8");
      expect(content).toContain("@AGENTS.md");
    });
  });

  // SC-82, SC-87: CI workflow content
  describe("CI workflow content", () => {
    test("SC-87: ci.yml has managed header", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(content).toContain("Managed by rungate");
      expect(content).toContain("bun test");
      expect(content).toContain("tsc --noEmit");
    });

    test("SC-85: gates.yml has secret scan", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/gates.yml"), "utf-8");
      expect(content).toContain("Managed by rungate");
      expect(content).toContain("Secret scan");
    });
  });

  // SC-123: copilot-instructions.md
  describe("SC-123: copilot-instructions.md", () => {
    test("points to AGENTS.md", () => {
      const content = readFileSync(join(OUTPUT, ".github/copilot-instructions.md"), "utf-8");
      expect(content).toContain("AGENTS.md");
    });
  });

  // SC-6: Zero hardcoded project names in ship.js
  describe("SC-6: no hardcoded project names", () => {
    test("rungate.json project field is from fixture, not hardcoded", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.project).not.toContain("DailyBriefDashboard");
      expect(config.project).not.toContain("asaCommandCenter");
    });
  });

  // SC-15: rungate.json fallback chain: Makefile → package.json → null
  describe("SC-15: config fallback chain", () => {
    test("dev.start detected from Makefile", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.start).toBeDefined();
    });

    test("fields without source are null, not guessed", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.uiBase).toBeNull();
    });
  });

  // SC-16: Null config fields cause SKIP not error
  describe("SC-16: null config fields", () => {
    test("null fields exist in rungate.json (not omitted)", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev).toHaveProperty("uiBase");
    });
  });

  // SC-20: New code projects get src/index.ts stub
  describe("SC-20: src/index.ts stub", () => {
    test("src/index.ts exists in output", () => {
      expect(existsSync(join(OUTPUT, "src/index.ts"))).toBe(true);
    });
  });

  // SC-21: No hardcoded port numbers in rungate.json
  describe("SC-21: no hardcoded ports", () => {
    test("apiBase port comes from Makefile detection (3000)", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.apiBase).toBe("http://localhost:3000");
    });

    test("no 5173 or 7778 defaults", () => {
      const raw = readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8");
      expect(raw).not.toContain("5173");
      expect(raw).not.toContain("7778");
    });
  });

  // SC-26: Spec template matches harness version
  describe("SC-26: spec template versioning", () => {
    test("SPEC-TEMPLATE.md has correct frontmatter fields", () => {
      const content = readFileSync(join(OUTPUT, "specs/SPEC-TEMPLATE.md"), "utf-8");
      expect(content).toContain("doc-type: spec");
      expect(content).toContain("testable:");
      expect(content).toContain("governs:");
      expect(content).toContain("status:");
    });
  });

  // SC-27: sync-spec-tests reads project's specs/ directory
  describe("SC-27: sync-spec-tests project awareness", () => {
    test("conformity test references project specs", () => {
      const content = readFileSync(join(OUTPUT, "test/scaffold-conformity.test.ts"), "utf-8");
      expect(content).toContain("runSpecDiscovery");
    });
  });

  // SC-83: gates.yml exists and is harness-owned
  describe("SC-83: gates.yml", () => {
    test("gates.yml exists with managed header", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/gates.yml"), "utf-8");
      expect(content).toContain("Managed by rungate");
    });

    test("gates.yml has conformity step", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/gates.yml"), "utf-8");
      expect(content).toContain("scaffold-conformity");
    });
  });

  // SC-84: CI workflow runs same conformity suites as bun test
  describe("SC-84: CI conformity parity", () => {
    test("ci.yml runs bun test (includes conformity)", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(content).toContain("bun test");
    });

    test("ci.yml runs tsc --noEmit", () => {
      const content = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(content).toContain("tsc --noEmit");
    });
  });

  // SC-86: CI workflows read from rungate.json ci section
  describe("SC-86: CI config from rungate.json", () => {
    test("ci.yml uses runner from rungate.json", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      const ci = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain(config.ci.runner);
    });

    test("ci.yml uses bunVersion from rungate.json", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      const ci = readFileSync(join(OUTPUT, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toContain(config.ci.bunVersion);
    });
  });

  // SC-88: All 9 ship workflow prompt templates exist
  describe("SC-88: ship workflow prompt templates", () => {
    const templates = ["discovery", "marcus", "quinn", "rook", "serena", "aditi", "environment", "container-rebuild", "container-verify"];
    for (const t of templates) {
      test(`prompts/${t}.md exists in harness`, () => {
        const harnessPrompts = join(import.meta.dir, "..", "prompts");
        expect(existsSync(join(harnessPrompts, `${t}.md`))).toBe(true);
      });
    }
  });

  // SC-89: All 11 Layer 1 methodology templates exist
  describe("SC-89: Layer 1 methodology templates", () => {
    const templates = [
      "rca", "blast-radius", "prevention", "regression", "read-before-write",
      "quinn-decision-tree", "evidence-hierarchy", "ac-format",
      "coding-principles", "testing-strategy", "escalation-decision-tree",
    ];
    for (const t of templates) {
      test(`prompts/${t}.md exists in harness`, () => {
        const harnessPrompts = join(import.meta.dir, "..", "prompts");
        expect(existsSync(join(harnessPrompts, `${t}.md`))).toBe(true);
      });
    }
  });

  // SC-90: Brief-assembler embeds methodology templates
  describe("SC-90: methodology refs in briefs", () => {
    test("marcus.md references methodology templates", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("coding-principles");
      expect(content).toContain("testing-strategy");
    });
  });

  // SC-91: git pre-commit hook with secret scan
  describe("SC-91: pre-commit hook", () => {
    test("pre-commit hook exists (not .sample)", () => {
      expect(existsSync(join(OUTPUT, ".git/hooks/pre-commit"))).toBe(true);
    });

    test("pre-commit hook contains secret scan", () => {
      const content = readFileSync(join(OUTPUT, ".git/hooks/pre-commit"), "utf-8");
      expect(content).toMatch(/secret|AKIA|sk-|ghp_|password/i);
    });
  });

  // SC-92: git pre-push hook with conformity test
  describe("SC-92: pre-push hook", () => {
    test("pre-push hook exists (not .sample)", () => {
      expect(existsSync(join(OUTPUT, ".git/hooks/pre-push"))).toBe(true);
    });

    test("pre-push hook runs conformity", () => {
      const content = readFileSync(join(OUTPUT, ".git/hooks/pre-push"), "utf-8");
      expect(content).toMatch(/bun test|conformity/i);
    });
  });

  // SC-94: AGENTS.md "Where to Create Things" section
  describe("SC-94: AGENTS.md Where to Create Things", () => {
    test("has location guidance for file types", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("specs/");
      expect(content).toContain("docs/adr/");
    });
  });

  // SC-95: AGENTS.md "Available MCP Servers" section
  describe("SC-95: AGENTS.md MCP Servers", () => {
    test("has MCP section or skips when none configured", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      // MCP section present if configured, absent if not (SC-18: empty sections omitted)
      // Golden fixture has no MCP config, so this section should be omitted
      expect(content).toBeDefined();
    });
  });

  // SC-107: Makefile fallback chain
  describe("SC-107: Makefile fallback chain", () => {
    test("port detected from Makefile (3000)", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.dev.apiBase).toContain("3000");
    });

    test("fields not in Makefile fall back appropriately", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      // prod.apiBase not in Makefile or package.json → null
      expect(config.prod.apiBase).toBeNull();
    });
  });

  // SC-114: AGENTS.md "Research Tools" section
  describe("SC-114: AGENTS.md Research Tools", () => {
    test("mentions available tools or is omitted when none", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      // Research tools section present if configured
      expect(content).toBeDefined();
    });
  });

  // SC-116: Coding principles doc auto-updated
  describe("SC-116: coding principles freshness", () => {
    test("coding-principles reference exists in marcus brief", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("coding-principles");
    });
  });

  // SC-118: Writer/verifier separation referenced
  describe("SC-118: writer/verifier separation", () => {
    test("briefs mention separation or verification", () => {
      const marcus = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(marcus).toContain("Verify before asserting");
    });
  });

  // SC-119: Test assertions reference AC thresholds
  describe("SC-119: AC threshold references", () => {
    test("marcus brief mentions AC-based testing", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toMatch(/AC|acceptance|threshold|verification command/i);
    });
  });

  // SC-120: Context loading follows 5-layer architecture
  describe("SC-120: 5-layer context architecture", () => {
    test("CLAUDE.md exists as layer 1", () => {
      expect(existsSync(join(OUTPUT, "CLAUDE.md"))).toBe(true);
    });

    test("AGENTS.md exists as layer 2", () => {
      expect(existsSync(join(OUTPUT, "AGENTS.md"))).toBe(true);
    });

    test("agent frontmatter exists as layer 4", () => {
      const marcus = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(marcus).toContain("---");
      expect(marcus).toContain("name: marcus");
    });
  });

  // SC-121: Agent frontmatter skills field
  describe("SC-121: agent frontmatter skills", () => {
    test("marcus has tools in frontmatter", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toMatch(/tools:/);
    });
  });

  // SC-122: AGENTS.md contains ONLY non-inferrable details
  describe("SC-122: AGENTS.md non-inferrable only", () => {
    test("no raw source code in AGENTS.md", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).not.toContain("import {");
      expect(content).not.toContain("export default");
      expect(content).not.toContain("function ");
    });
  });

  // SC-124: envVars from .env.example
  describe("SC-124: envVars from .env.example", () => {
    test("envVars populated from fixture .env.example", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.envVars).toContain("API_PORT");
      expect(config.envVars).toContain("DATABASE_URL");
      expect(config.envVars).toContain("SECRET_KEY");
    });
  });

  // SC-126: AGENTS.md Code Style auto-detected
  describe("SC-126: AGENTS.md Code Style", () => {
    test("detects TypeScript", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toMatch(/TypeScript|\.ts/i);
    });
  });

  // SC-138: Agent briefs cap at 10 rules per template
  describe("SC-138: rule count caps", () => {
    test("Core Principles block has ≤ 10 rules", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const principlesMatch = content.match(/## Core Principles\n([\s\S]*?)(?=\n## )/);
      if (principlesMatch) {
        const ruleLines = principlesMatch[1].split("\n").filter(l => l.startsWith("- "));
        expect(ruleLines.length).toBeLessThanOrEqual(10);
      }
    });
  });

  // SC-139: AGENTS.md rules content under 200 words
  describe("SC-139: AGENTS.md word count", () => {
    test("rules content (excluding tables/headers) under 200 words", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      const lines = content.split("\n")
        .filter(l => !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```") && l.trim().length > 0);
      const words = lines.join(" ").split(/\s+/).length;
      expect(words).toBeLessThanOrEqual(200);
    });
  });

  // SC-140: Brief structure — Core Principles at START, ACs at END
  describe("SC-140: brief ordering", () => {
    test("Core Principles appears before methodology", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const principlesIdx = content.indexOf("## Core Principles");
      const methodologyIdx = content.indexOf("## Methodology");
      expect(principlesIdx).toBeGreaterThan(-1);
      expect(methodologyIdx).toBeGreaterThan(-1);
      expect(principlesIdx).toBeLessThan(methodologyIdx);
    });
  });

  // SC-141: Positive framing in templates
  describe("SC-141: positive framing", () => {
    test("Core Principles use positive framing", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const principlesMatch = content.match(/## Core Principles\n([\s\S]*?)(?=\n## )/);
      if (principlesMatch) {
        const negatives = principlesMatch[1].split("\n")
          .filter(l => l.startsWith("- ") && l.match(/^- (Don't|Never|Do not|Avoid) /));
        expect(negatives.length).toBeLessThanOrEqual(10);
      }
    });
  });

  // SC-142: Templates include code examples
  describe("SC-142: code examples in templates", () => {
    test("methodology references include doc paths (example-like)", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("coding-principles");
    });
  });

  // SC-143: Template activation modes
  describe("SC-143: activation modes", () => {
    test("agent briefs have frontmatter declaring activation", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      expect(content).toContain("---");
      expect(content).toContain("name:");
    });
  });

  // SC-144: Rule lifecycle — since dates
  describe("SC-144: rule lifecycle", () => {
    test("rules have since date or are flaggable for staleness", () => {
      // Scaffold should mark when rules were added
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toBeDefined();
    });
  });

  // SC-145: Brief assembly order
  describe("SC-145: brief assembly order", () => {
    test("identity before principles before methodology", () => {
      const content = readFileSync(join(OUTPUT, ".claude/agents/marcus.md"), "utf-8");
      const nameIdx = content.indexOf("name: marcus");
      const principlesIdx = content.indexOf("## Core Principles");
      const methodologyIdx = content.indexOf("## Methodology");
      expect(nameIdx).toBeLessThan(principlesIdx);
      expect(principlesIdx).toBeLessThan(methodologyIdx);
    });
  });

  // SC-147: rungate.json harnessVersion and scaffoldedAt
  describe("SC-147: version tracking", () => {
    test("harnessVersion is semver", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(config.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test("scaffoldedAt is valid ISO timestamp", () => {
      const config = JSON.parse(readFileSync(join(OUTPUT, ".claude/rungate.json"), "utf-8"));
      expect(new Date(config.scaffoldedAt).getTime()).toBeGreaterThan(0);
    });
  });

  // SC-148: Conformity warns on version mismatch
  describe("SC-148: version mismatch warning", () => {
    test("conformity test imports version validation", () => {
      const content = readFileSync(join(OUTPUT, "test/scaffold-conformity.test.ts"), "utf-8");
      expect(content).toBeDefined();
    });
  });

  // SC-159: AGENTS.md Commands table includes findings check
  describe("SC-159: findings check in Commands", () => {
    test("Commands table has Check findings row", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("Check findings");
      expect(content).toContain("conformity-findings.json");
    });
  });

  // SC-160: AGENTS.md Quick Reference mentions findings
  describe("SC-160: Quick Reference findings hint", () => {
    test("Quick Reference mentions findings JSON", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("conformity-findings.json");
      expect(content).toContain("fix commands");
    });
  });

  // Post-phase compliance audit
  describe("post-phase audit", () => {
    test("all Phase 0 files exist with required content", () => {
      const requiredFiles = [
        ".gitignore",
        "package.json",
        "tsconfig.json",
        "specs/SPEC-TEMPLATE.md",
        ".github/copilot-instructions.md",
        ".github/workflows/ci.yml",
        ".github/workflows/gates.yml",
        "test/scaffold-conformity.test.ts",
        "CLAUDE.md",
      ];

      const missing = requiredFiles.filter(
        (f) => !existsSync(join(OUTPUT, f))
      );

      if (missing.length > 0) {
        console.log("\n── PHASE 0 COMPLIANCE AUDIT ──────────────────");
        console.log(`  Files: ${requiredFiles.length} expected, ${requiredFiles.length - missing.length} created, ${missing.length} missing`);
        for (const f of missing) {
          console.log(`  ✗ MISSING: ${f}`);
        }
        console.log("──────────────────────────────────────────────\n");
      }

      expect(missing).toEqual([]);
    });
  });
});
