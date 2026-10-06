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
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";

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
    initFixtureRepo(fixtureRoot);
    commitFixture(fixtureRoot, "init");

    // Run scaffold first time
    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot} --fix`, { cwd: fixtureRoot, stdio: 'pipe' });

    // Capture first run outputs
    const agentsMd1 = readFileSync(join(fixtureRoot, "AGENTS.md"), "utf-8");
    const codeMap1 = readFileSync(join(fixtureRoot, "CODE-MAP.md"), "utf-8");

    // Run scaffold second time
    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot} --fix`, { cwd: fixtureRoot, stdio: 'pipe' });

    // Capture second run outputs
    const agentsMd2 = readFileSync(join(fixtureRoot, "AGENTS.md"), "utf-8");
    const codeMap2 = readFileSync(join(fixtureRoot, "CODE-MAP.md"), "utf-8");

    // Verify outputs are byte-identical
    expect(agentsMd1).toBe(agentsMd2);
    expect(codeMap1).toBe(codeMap2);
    // Two full scaffold runs, measured at 6.9s locally. It inherited bun's 5s
    // default and so could only ever pass by being faster than its own work —
    // on CI it timed out at exactly 5000ms. 30s is ~4x the measured time, which
    // covers a cold GitHub runner without being so loose that a genuine hang
    // reads as a slow pass. Raise it off a new measurement, never off a guess.
  }, 30_000);

  test("#72 AC-2: re-scaffolding leaves an existing tsconfig.json byte-for-byte unchanged", () => {
    const fixtureRoot = join(tmpRoot, "tsconfig-fixture");
    mkdirSync(join(fixtureRoot, "src"), { recursive: true });

    writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({
      name: "tsconfig-fixture",
      version: "1.0.0",
      type: "module",
      scripts: { test: "bun test" },
    }, null, 2) + "\n");
    writeFileSync(join(fixtureRoot, "src", "index.ts"), "export const hello = 'world';\n");

    // Hand-written and deliberately unlike anything the scaffold would emit:
    // non-strict, a different target, odd whitespace, no trailing newline. A
    // generator that "helpfully" normalises or merges would change the bytes,
    // and that is what this is guarding — the consumer's own TS settings are
    // theirs, and re-scaffold is run routinely.
    const handWritten = '{"compilerOptions":{"strict":false,    "target":"ES2020"}}';
    writeFileSync(join(fixtureRoot, "tsconfig.json"), handWritten);

    initFixtureRepo(fixtureRoot);
    commitFixture(fixtureRoot, "init");

    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot} --fix`, { cwd: fixtureRoot, stdio: "pipe" });
    const afterFirst = readFileSync(join(fixtureRoot, "tsconfig.json"), "utf-8");

    execSync(`bun ${ROOT}/scripts/scaffold-project.ts ${fixtureRoot} --fix`, { cwd: fixtureRoot, stdio: "pipe" });
    const afterSecond = readFileSync(join(fixtureRoot, "tsconfig.json"), "utf-8");

    expect(afterFirst).toBe(handWritten);
    expect(afterSecond).toBe(handWritten);
  }, 60_000);

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
    // This asserted nothing until #65. It called
    // `generateAgentBriefs(scan, briefsDir, actions)` and compared the two
    // `actions` arrays — but the generator takes ONE argument, writes no files
    // and returns the briefs. The extra arguments were discarded, both arrays
    // stayed empty, and `expect([]).toEqual([])` passed however
    // non-deterministic the generator was. The type error (TS2554, "Expected 1
    // arguments, but got 3") was the only thing pointing at it, and the type
    // check had never run.
    //
    // Now compares the real return value, and fails if there is nothing in it
    // to compare — an empty result must not read as determinism either.
    const scan = mockProjectScan();

    const briefs1 = generateAgentBriefs(scan);
    const briefs2 = generateAgentBriefs(scan);

    expect(Object.keys(briefs1).length).toBeGreaterThan(0);
    expect(briefs1).toEqual(briefs2);
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
