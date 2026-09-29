/**
 * AC-5: Verify scaffold pipeline uses generators from lib/generators/
 * AC-4: Verify >= 3 test files reference ProjectScan
 *
 * After SCAFFOLD-DECOMPOSITION-SPEC, scaffold-project.ts is orchestrator-only.
 * Generator imports live in lib/scaffold/steps.ts (the deep module).
 *
 * DDB-532: Tests for dashboard page scanning, docker-compose port scanning,
 * and stale consumer audit in generateOrAuditProjectHarness.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { mockProjectScan } from "../lib/generators/types";
import { generateOrAuditProjectHarness, copySpecTemplateIfEmpty } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");

describe("AC-5: scaffold pipeline imports from lib/generators/", () => {
  // After decomposition, generator imports live in lib/scaffold/steps.ts
  const stepsSrc = readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8");
  const scaffoldSrc = readFileSync(join(ROOT, "scripts/scaffold-project.ts"), "utf-8");

  test("scaffold imports from lib/scaffold/ (orchestrator pattern)", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/scaffold/);
  });

  test("scaffold imports from lib/validators/ (decomposed validators)", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/validators/);
  });

  test("steps.ts has >= 3 import statements from lib/generators/", () => {
    const importMatches = stepsSrc.match(/from\s+["']\.\.\/generators[^"']*["']/g) || [];
    expect(importMatches.length).toBeGreaterThanOrEqual(3);
  });

  test("scaffold imports ProjectType from lib/generators/types", () => {
    expect(scaffoldSrc).toMatch(/from\s+["']\.\.\/lib\/generators\/types["']/);
  });
});

describe("AC-4: >= 3 test files reference ProjectScan", () => {
  test("at least 3 test files import or reference ProjectScan", () => {
    const testDir = join(ROOT, "test");
    const testFiles = readdirSync(testDir).filter(f => f.endsWith(".test.ts"));
    let count = 0;
    for (const f of testFiles) {
      const content = readFileSync(join(testDir, f), "utf-8");
      if (content.includes("ProjectScan") || content.includes("mockProjectScan")) {
        count++;
      }
    }
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

// ── DDB-532: Harness generation with dashboard pages & docker-compose ports ──

describe("DDB-532 AC-1: dashboard page scanning and docker-compose port scanning", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-harness-gen");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("dashboard page detection: scans dashboard/src/pages/*.tsx for page components", () => {
    // Setup: create dashboard/src/pages/ with .tsx files
    const pagesDir = join(tmpRoot, "dashboard", "src", "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "Settings.tsx"), "export default function Settings() { return <div>Settings</div>; }");
    writeFileSync(join(pagesDir, "Dashboard.tsx"), "export default function Dashboard() { return <div>Dashboard</div>; }");
    writeFileSync(join(pagesDir, "Users.tsx"), "export default function Users() { return <div>Users</div>; }");

    // Also create a package.json so it looks like a real project
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "test-project", scripts: { test: "bun test" } }));

    const actions: string[] = [];
    generateOrAuditProjectHarness(tmpRoot, actions);

    // Verify the generated rungate.json has pages from dashboard
    const harnessPath = join(tmpRoot, ".claude", "rungate.json");
    expect(existsSync(harnessPath)).toBe(true);
    const config = JSON.parse(readFileSync(harnessPath, "utf-8"));
    expect(Object.keys(config.pages).length).toBeGreaterThanOrEqual(2);
    // Pages should be keyed by derived route path from filename
    expect(config.pages).toHaveProperty("/settings");
    expect(config.pages).toHaveProperty("/dashboard");
  });

  test("docker-compose port detection: scans docker-compose.yml for port mappings", () => {
    // Setup: create docker-compose.yml with port mapping
    writeFileSync(join(tmpRoot, "docker-compose.yml"), `
services:
  api:
    build: .
    ports:
      - "3001:3001"
  web:
    build: ./dashboard
    ports:
      - "5173:5173"
`);
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "test-project", scripts: { test: "bun test" } }));

    const actions: string[] = [];
    generateOrAuditProjectHarness(tmpRoot, actions);

    const harnessPath = join(tmpRoot, ".claude", "rungate.json");
    expect(existsSync(harnessPath)).toBe(true);
    const config = JSON.parse(readFileSync(harnessPath, "utf-8"));
    // Should detect port from docker-compose.yml
    expect(config.dev.apiBase).toContain("3001");
  });

  test("steps.ts references both dashboard/src/pages and docker-compose scan sources", () => {
    const stepsSrc = readFileSync(join(ROOT, "lib/scaffold/steps.ts"), "utf-8");
    expect(stepsSrc).toContain("dashboard/src/pages");
    expect(stepsSrc).toMatch(/docker.compose/);
  });
});

describe("DDB-532 AC-2: stale consumer audit", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-harness-audit");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("consumer audit flags stale consumers not found in source code", () => {
    // Setup: create existing rungate.json with consumers that don't exist in src/
    // The scanner strips -routes/-generator suffix, so valid-routes.ts becomes "valid"
    const claudeDir = join(tmpRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "rungate.json"), JSON.stringify({
      project: "test",
      consumers: ["stale-module", "removed-service", "valid"],
      pages: {},
    }, null, 2));

    // Create src/ with only valid-routes.ts (scans to consumer name "valid")
    const srcDir = join(tmpRoot, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "valid-routes.ts"), "export default {};");

    const actions: string[] = [];
    generateOrAuditProjectHarness(tmpRoot, actions);

    // Should report stale consumers in audit output
    const auditAction = actions.find(a => a.includes("CONSUMERS") || a.includes("consumer") || a.includes("stale"));
    expect(auditAction).toBeDefined();
    expect(auditAction).toContain("stale");
  });
});

describe("DDB-532 AC-3: page components from dashboard produce route-keyed entries", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-harness-pages");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("page filenames become route paths: Settings.tsx -> /settings", () => {
    const pagesDir = join(tmpRoot, "dashboard", "src", "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "Settings.tsx"), "export default function Settings() {}");
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "test" }));

    const actions: string[] = [];
    generateOrAuditProjectHarness(tmpRoot, actions);

    const config = JSON.parse(readFileSync(join(tmpRoot, ".claude", "rungate.json"), "utf-8"));
    expect(config.pages["/settings"]).toBe("Settings");
  });

  test("page filenames become route paths: UserProfile.tsx -> /user-profile", () => {
    const pagesDir = join(tmpRoot, "dashboard", "src", "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "UserProfile.tsx"), "export default function UserProfile() {}");
    writeFileSync(join(pagesDir, "Analytics.tsx"), "export default function Analytics() {}");
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "test" }));

    const actions: string[] = [];
    generateOrAuditProjectHarness(tmpRoot, actions);

    const config = JSON.parse(readFileSync(join(tmpRoot, ".claude", "rungate.json"), "utf-8"));
    // CamelCase filenames should produce kebab-case route paths
    expect(config.pages["/user-profile"]).toBe("UserProfile");
    expect(config.pages["/analytics"]).toBe("Analytics");
  });
});

describe("DDB-532 AC-4: >= 4 test cases covering harness generation and audit", () => {
  test("this file has >= 4 test cases covering dashboard pages, docker-compose ports, and stale consumers", () => {
    const content = readFileSync(join(ROOT, "test/scaffold-generators.test.ts"), "utf-8");
    const dashboardTests = (content.match(/test\([^)]*dashboard[^)]*page/gi) || []).length;
    const dockerTests = (content.match(/test\([^)]*docker.compose[^)]*port/gi) || []).length;
    const staleTests = (content.match(/test\([^)]*stale[^)]*consumer/gi) || []).length;
    const routeTests = (content.match(/test\([^)]*page[^)]*filename[^)]*route/gi) || []).length;
    const total = dashboardTests + dockerTests + staleTests + routeTests;
    expect(total).toBeGreaterThanOrEqual(4);
  });
});

// ── DDB-529: copySpecTemplateIfEmpty emptiness check ─────────────────────

describe("DDB-529 AC-1: copySpecTemplateIfEmpty skips when specs/ has existing .md files", () => {
  const tmpRoot = join(ROOT, "test", ".tmp-spec-template");

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("copySpecTemplateIfEmpty copies template when specs/ is empty", () => {
    const specsDir = join(tmpRoot, "specs");
    mkdirSync(specsDir, { recursive: true });

    const actions: string[] = [];
    copySpecTemplateIfEmpty(specsDir, actions);

    expect(existsSync(join(specsDir, "SPEC-TEMPLATE.md"))).toBe(true);
    expect(actions.some(a => a.includes("CREATED") && a.includes("SPEC-TEMPLATE.md"))).toBe(true);
  });

  test("copySpecTemplateIfEmpty skips when specs/ has existing .md files", () => {
    const specsDir = join(tmpRoot, "specs");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, "MY-SPEC.md"), "# My Spec\nSome content");

    const actions: string[] = [];
    copySpecTemplateIfEmpty(specsDir, actions);

    // Should skip because non-template .md files exist
    expect(actions.some(a => a.includes("SKIP"))).toBe(true);
    expect(actions.some(a => a.includes("CREATED"))).toBe(false);
  });

  test("copySpecTemplateIfEmpty copies when only SPEC-TEMPLATE.md exists (not counted)", () => {
    const specsDir = join(tmpRoot, "specs");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, "SPEC-TEMPLATE.md"), "# Old template");

    const actions: string[] = [];
    copySpecTemplateIfEmpty(specsDir, actions);

    // SPEC-TEMPLATE.md itself should not count as an existing spec
    expect(existsSync(join(specsDir, "SPEC-TEMPLATE.md"))).toBe(true);
    expect(actions.some(a => a.includes("CREATED") || a.includes("UPDATED"))).toBe(true);
  });
});

describe("DDB-529 AC-2: SPEC-TEMPLATE.md has testable: false frontmatter", () => {
  test("SPEC-TEMPLATE.md frontmatter includes testable: false", () => {
    const templatePath = join(ROOT, "specs", "SPEC-TEMPLATE.md");
    const content = readFileSync(templatePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("testable: false");
  });
});
