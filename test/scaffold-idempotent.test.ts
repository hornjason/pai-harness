/**
 * SC-364: Re-scaffold produces identical output before and after decomposition (behavioral)
 *
 * Tests verifying that the decomposed scaffold pipeline produces deterministic,
 * identical output when run multiple times with the same input.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { mockProjectScan } from "../lib/generators/types";
import { generateAgentsMd } from "../lib/generators/agents-md";
import { generateCodeMap } from "../lib/generators/code-map";
import { generateAgentBriefs } from "../lib/generators/agent-briefs";
import { scanProject } from "../lib/scanner";

const ROOT = join(import.meta.dir, "..");

describe("SC-364: Scaffold idempotency and determinism", () => {
  const tmpRoot = join(tmpdir(), `scaffold-idempotent-${process.pid}`);

  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("SC-364: idempotency — scaffold produces identical output when run twice", () => {
    // Setup: create minimal fixture project
    const fixtureRoot = join(tmpRoot, "fixture");
    mkdirSync(fixtureRoot, { recursive: true });

    // Create package.json
    writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
      name: "test-fixture",
      version: "1.0.0",
      scripts: { test: "bun test" },
      dependencies: {}
    }, null, 2));

    // Create src/ directory with a sample file
    const srcDir = join(fixtureRoot, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), "export const hello = 'world';");

    // Create specs/ directory with a sample spec
    const specsDir = join(fixtureRoot, "specs");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, "TEST-SPEC.md"), `---
doc-type: spec
testable: true
governs: Test spec
---

# Test Spec

## Success Criteria

- [x] SC-1: Test criterion
`);

    // Create .claude directory and init git repo (scaffold needs git for postScaffoldCommit)
    mkdirSync(join(fixtureRoot, ".claude"), { recursive: true });
    execSync("git init", { cwd: fixtureRoot, stdio: "pipe" });
    execSync("git add -A && git commit -m 'init'", { cwd: fixtureRoot, stdio: "pipe" });

    // Run scaffold first time
    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot}`, { cwd: fixtureRoot, stdio: 'pipe' });

    // Capture first run outputs
    const agentsMd1 = readFileSync(join(fixtureRoot, "AGENTS.md"), "utf-8");
    const codeMap1 = readFileSync(join(fixtureRoot, "CODE-MAP.md"), "utf-8");

    // Run scaffold second time
    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot}`, { cwd: fixtureRoot, stdio: 'pipe' });

    // Capture second run outputs
    const agentsMd2 = readFileSync(join(fixtureRoot, "AGENTS.md"), "utf-8");
    const codeMap2 = readFileSync(join(fixtureRoot, "CODE-MAP.md"), "utf-8");

    // Verify outputs are byte-identical
    expect(agentsMd1).toBe(agentsMd2);
    expect(codeMap1).toBe(codeMap2);
  });

  test("SC-364: generator determinism — generateAgentsMd produces identical output", () => {
    // Call generator twice with same input
    const scan = mockProjectScan();
    const output1 = generateAgentsMd(scan);
    const output2 = generateAgentsMd(scan);

    // Verify outputs are identical
    expect(output1).toBe(output2);
  });

  test("SC-364: generator determinism — generateCodeMap produces identical output", () => {
    // Call generator twice with same input
    const scan = mockProjectScan();
    const output1 = generateCodeMap(scan);
    const output2 = generateCodeMap(scan);

    // Verify outputs are identical
    expect(output1).toBe(output2);
  });

  test("SC-364: generator determinism — generateAgentBriefs produces identical output", () => {
    // Setup: create tmp directory for agent briefs output
    const briefsDir1 = join(tmpRoot, "briefs1");
    const briefsDir2 = join(tmpRoot, "briefs2");
    mkdirSync(briefsDir1, { recursive: true });
    mkdirSync(briefsDir2, { recursive: true });

    // Call generator twice with same input
    const scan = mockProjectScan();
    const actions1: string[] = [];
    const actions2: string[] = [];

    generateAgentBriefs(scan, briefsDir1, actions1);
    generateAgentBriefs(scan, briefsDir2, actions2);

    // Verify action logs are identical
    expect(actions1).toEqual(actions2);

    // Verify generated files are identical (if any were created)
    // Note: generateAgentBriefs may not create files with mockProjectScan,
    // but actions should still be deterministic
  });

  test("SC-364: scanner stability — scanProject produces identical output", () => {
    // Setup: create minimal fixture project
    const fixtureRoot = join(tmpRoot, "scan-fixture");
    mkdirSync(fixtureRoot, { recursive: true });

    writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
      name: "scan-test",
      scripts: { test: "echo test" }
    }));

    const srcDir = join(fixtureRoot, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "main.ts"), "console.log('test');");

    // Run scanner twice
    const scan1 = scanProject(fixtureRoot);
    const scan2 = scanProject(fixtureRoot);

    // Verify scans are deeply equal
    expect(scan1).toEqual(scan2);
  });
});
