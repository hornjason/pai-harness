import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import { extractConstraints } from "../scripts/extract-constraints";
import { runScaffoldConformity } from "../lib/conformity";

const TEST_PLAN_HASH = "7fb0bb69a53a466d";
const OUTPUT = "/tmp/rungate-phase1-test";
const HARNESS = resolve(import.meta.dir, "..");
const SCAFFOLD = join(HARNESS, "scripts", "scaffold-project.ts");

function parseResults(out: string) {
  return { pass: parseInt(out.match(/(\d+) pass/)?.[1] || "0"), fail: parseInt(out.match(/(\d+) fail/)?.[1] || "0"), output: out };
}

function runConformitySubprocess(root: string, suiteFilter?: string) {
  const tmpTest = join(root, "_conformity-check.test.ts");
  const suites = suiteFilter || "runDocHygiene, runSpecDiscovery";
  writeFileSync(tmpTest, `import { ${suites} } from "${join(HARNESS, "lib", "conformity")}";\n${suites.split(",").map(s => `${s.trim()}("${root}");`).join("\n")}`);
  try {
    const out = execSync(`bun test ${tmpTest} 2>&1`, { encoding: "utf-8", timeout: 30000 });
    try { rmSync(tmpTest); } catch {}
    return parseResults(out);
  } catch (e: any) {
    try { rmSync(tmpTest); } catch {}
    return parseResults((e.stdout || "") + (e.stderr || ""));
  }
}

beforeAll(() => {
  execSync(`rm -rf ${OUTPUT}`);
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(join(OUTPUT, "src"), { recursive: true });
  mkdirSync(join(OUTPUT, "docs"), { recursive: true });
  mkdirSync(join(OUTPUT, "docs/adr"), { recursive: true });
  mkdirSync(join(OUTPUT, "specs"), { recursive: true });
  mkdirSync(join(OUTPUT, "reference"), { recursive: true });
  mkdirSync(join(OUTPUT, ".git"), { recursive: true });

  writeFileSync(join(OUTPUT, "package.json"), JSON.stringify({
    name: "phase1-test", type: "module", scripts: { test: "bun test" },
  }, null, 2));

  writeFileSync(join(OUTPUT, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ESNext", module: "ESNext" },
  }, null, 2));

  writeFileSync(join(OUTPUT, "docs/rules.md"), `---
doc-type: guide
status: active
updated: 2026-09-01
---

# Project Rules

- Never deploy on Fridays; this is a hard rule.
- The auth module must always be imported before the db module.
- All API responses must include a requestId header.
- Do not modify the migration files after they have been applied; intentional constraint.
`);

  writeFileSync(join(OUTPUT, "docs/old-guide.md"), `---
doc-type: guide
status: active
updated: 2024-01-15
last-verified: 2024-01-15
---

# Old Setup Guide

This guide is outdated.
`);

  writeFileSync(join(OUTPUT, "specs/api-spec.md"), `---
doc-type: spec
status: draft
owner: test
created: 2026-09-01
updated: 2026-09-01
governs: API behavior
testable: true
---

# API Spec

## Success Criteria

- [ ] SC-1: API responds within 200ms
`);

  writeFileSync(join(OUTPUT, "specs/bare-spec.md"), `# Bare Spec Without Frontmatter\n\nThis should fail.`);

  writeFileSync(join(OUTPUT, "docs/adr/ADR-001-framework.md"), `---
doc-type: adr
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 001: Framework Choice

We chose Bun.
`);

  writeFileSync(join(OUTPUT, "docs/rejected-constraints.md"), `---
doc-type: guide
status: active
updated: 2026-09-01
---

# Rejected Constraints

- Never deploy on Fridays (too restrictive)
`);

  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add docs/old-guide.md && git commit -m 'add old guide'", {
    cwd: OUTPUT, stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: "2024-01-15T00:00:00", GIT_COMMITTER_DATE: "2024-01-15T00:00:00" },
  });
  execSync("git add -A && git commit -m 'init'", { cwd: OUTPUT, stdio: "pipe" });
});

// Auto-generated conformity tests from specs
runScaffoldConformity(HARNESS);

// Custom integration tests
describe("Phase 1: Knowledge extraction + doc hygiene (custom checks)", () => {
  test("spec-drift: test plan spec hasn't changed", () => {
    const specPath = join(HARNESS, "specs", "BOOTSTRAP-TEST-PLAN.md");
    if (existsSync(specPath)) {
      const hash = execSync(`shasum -a 256 "${specPath}" | cut -c1-16`, { encoding: "utf-8" }).trim();
      if (hash !== TEST_PLAN_HASH) {
        throw new Error(`SPEC DRIFT: test plan spec changed (hash ${hash} != ${TEST_PLAN_HASH}). Update TEST_PLAN_HASH to "${hash}".`);
      }
    }
  });

  test("SC-12: extract-constraints finds signal phrases in docs", () => {
    try {
      const output = execSync(`bun run ${HARNESS}/scripts/extract-constraints.ts ${OUTPUT} --dry-run 2>&1`,
        { encoding: "utf-8", timeout: 30000 });
      expect(output).toMatch(/never deploy|auth module|do not modify|requestId/i);
    } catch (e: any) {
      const out = (e.stdout || "") + (e.stderr || "");
      expect(out).toMatch(/never deploy|auth module|do not modify|requestId/i);
    }
  });

  test("SC-13: --dry-run does not write to AGENTS.md", () => {
    const agentsBefore = existsSync(join(OUTPUT, "AGENTS.md")) ? readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8") : "";
    try { execSync(`bun run ${HARNESS}/scripts/extract-constraints.ts ${OUTPUT} --dry-run 2>&1`, { encoding: "utf-8", timeout: 30000 }); } catch {}
    const agentsAfter = existsSync(join(OUTPUT, "AGENTS.md")) ? readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8") : "";
    expect(agentsAfter).toBe(agentsBefore);
  });

  test("SC-14: staleness checker flags old docs", async () => {
    const result = await extractConstraints(OUTPUT, { apply: false });
    const staleFiles = result.staleness || [];
    const oldGuide = staleFiles.find((s) => s.file.includes("old-guide"));
    expect(oldGuide).toBeDefined();
    expect(oldGuide!.daysSince).toBeGreaterThan(180);
  });

  test("SC-75: Spec Discovery FAILs on bare spec without frontmatter", () => {
    const result = runConformitySubprocess(OUTPUT, "runSpecDiscovery");
    expect(result.fail).toBeGreaterThan(0);
    expect(result.output).toMatch(/bare-spec|frontmatter|testable/i);
  });

  test("SC-137: extract-constraints deduplicates against rejected-constraints.md", async () => {
    const result = await extractConstraints(OUTPUT, { apply: false });
    expect(result.deduped).toHaveProperty("candidatesRemoved");
    expect(result.deduped).toHaveProperty("rejectedPrior");
    expect(result.deduped).toHaveProperty("existingConstraints");
    expect(typeof result.deduped.candidatesRemoved).toBe("number");
  });

  test("SC-268: create-spec script exists", () => {
    expect(existsSync(join(HARNESS, "scripts/create-spec.ts"))).toBe(true);
  });

  test("SC-268: create-spec generates spec with governs in frontmatter", () => {
    const output = execSync(`bun ${join(HARNESS, "scripts/create-spec.ts")} "Test Governs" "Widget rendering pipeline"`,
      { encoding: "utf-8", cwd: HARNESS, timeout: 10000 });
    expect(output).toContain("Created");
    const specPath = join(HARNESS, "specs/TEST-GOVERNS-SPEC.md");
    expect(existsSync(specPath)).toBe(true);
    const content = readFileSync(specPath, "utf-8");
    expect(content).toContain("governs: Widget rendering pipeline");
    rmSync(specPath);
  });
});
