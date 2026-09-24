import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { matchPattern, type ParsedSC } from "../lib/conformity";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "create-sc.ts");

function runCreateSC(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 15000,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("create-sc CLI", () => {
  // AC-1: accepts --pattern and --params flags, generates SC text
  test("AC-1: generates SC text from --pattern and --params matching file-exists pattern", () => {
    const result = runCreateSC([
      "--pattern", "file-exists",
      "--params", JSON.stringify({ file: "AGENTS.md" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exists");
    expect(result.stdout).toContain("AGENTS.md");
  });

  test("AC-1: generates SC text for content-contains pattern", () => {
    const result = runCreateSC([
      "--pattern", "content-contains",
      "--params", JSON.stringify({ file: "AGENTS.md", items: "Rules, Specs" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AGENTS.md");
    expect(result.stdout).toContain("contains");
  });

  test("AC-1: generates SC text for dir-exists pattern", () => {
    const result = runCreateSC([
      "--pattern", "dir-exists",
      "--params", JSON.stringify({ dir: "specs" }),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("specs");
    expect(result.stdout).toContain("directory exists");
  });

  // AC-2: --list prints all 19 patterns with syntax and examples
  test("AC-2: --list prints all 19+ patterns with syntax and examples", () => {
    const result = runCreateSC(["--list"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    // Count pattern entries (lines that contain both a pattern name format and syntax info)
    const patternLines = lines.filter(l => l.includes("syntax") || l.includes("example") || l.includes("Syntax") || l.includes("Example"));
    expect(patternLines.length).toBeGreaterThanOrEqual(19);
    // Verify some known patterns appear
    expect(result.stdout).toContain("file-exists");
    expect(result.stdout).toContain("dir-exists");
    expect(result.stdout).toContain("content-contains");
  });

  // AC-3: scaffold-project.ts Commands table includes create-sc
  test("AC-3: scaffold-project.ts Commands table includes create-sc entry", () => {
    const scaffoldContent = readFileSync(join(ROOT, "scripts", "scaffold-project.ts"), "utf-8");
    expect(scaffoldContent).toContain("create-sc");
  });

  // AC-4: Invalid pattern name produces clear error listing valid patterns
  test("AC-4: invalid pattern name produces error with valid pattern names", () => {
    const result = runCreateSC(["--pattern", "nonexistent-pattern"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toContain("file-exists");
    expect(output).toContain("dir-exists");
    expect(output).toContain("content-contains");
  });

  // AC-5: Missing required params produces clear error
  test("AC-5: missing required params for file-exists produces error", () => {
    const result = runCreateSC(["--pattern", "file-exists"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output.toLowerCase()).toMatch(/required|missing|param/);
  });

  test("AC-5: missing required params for content-contains produces error", () => {
    const result = runCreateSC(["--pattern", "content-contains"]);
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output.toLowerCase()).toMatch(/required|missing|param/);
  });

  // AC-6: With --spec flag, appends SC line to spec file with auto-incremented SC number
  describe("AC-6: --spec flag appends SC to spec file", () => {
    const tmpSpecDir = join(ROOT, "test", "fixtures", "create-sc-tmp");
    const tmpSpec = join(tmpSpecDir, "TEST-SPEC.md");

    beforeEach(() => {
      mkdirSync(tmpSpecDir, { recursive: true });
      writeFileSync(tmpSpec, `---
doc-type: spec
status: draft
testable: true
---

# Test Spec

## Success Criteria

- [ ] SC-100: some existing criterion
`);
    });

    afterEach(() => {
      if (existsSync(tmpSpecDir)) {
        rmSync(tmpSpecDir, { recursive: true });
      }
    });

    test("appends SC line with auto-incremented number", () => {
      const result = runCreateSC([
        "--pattern", "file-exists",
        "--params", JSON.stringify({ file: "README.md" }),
        "--spec", tmpSpec,
      ]);
      expect(result.exitCode).toBe(0);
      const content = readFileSync(tmpSpec, "utf-8");
      // Should contain both the original SC-100 and a new SC-101
      expect(content).toContain("SC-100");
      expect(content).toContain("SC-101");
      expect(content).toContain("README.md");
      expect(content).toContain("exists");
    });
  });

  // AC-7: Without --spec flag, outputs SC text to stdout
  test("AC-7: without --spec, outputs SC text to stdout", () => {
    const result = runCreateSC([
      "--pattern", "file-exists",
      "--params", JSON.stringify({ file: "AGENTS.md" }),
    ]);
    expect(result.exitCode).toBe(0);
    // Output should contain SC- prefix and the statement
    expect(result.stdout).toContain("SC-");
    expect(result.stdout).toContain("AGENTS.md");
  });

  // AC-8: Generated SC text round-trips through matchPattern()
  describe("AC-8: round-trip through matchPattern()", () => {
    const patternsToTest: Array<{ pattern: string; params: Record<string, string> }> = [
      { pattern: "file-exists", params: { file: "AGENTS.md" } },
      { pattern: "dir-exists", params: { dir: "specs" } },
      { pattern: "content-contains", params: { file: "AGENTS.md", items: "Rules, Specs" } },
      { pattern: "section-exists", params: { file: "AGENTS.md", section: "Rules" } },
      { pattern: "pointer-exists", params: { file: "CLAUDE.md", target: "AGENTS.md" } },
      { pattern: "json-field-equals", params: { file: "package.json", field: "name", value: "rungate" } },
    ];

    for (const { pattern, params } of patternsToTest) {
      test(`${pattern} round-trips through matchPattern`, () => {
        const result = runCreateSC([
          "--pattern", pattern,
          "--params", JSON.stringify(params),
        ]);
        expect(result.exitCode).toBe(0);

        // Extract the SC statement from stdout (after "SC-NNN: ")
        const scLine = result.stdout.trim();
        const scMatch = scLine.match(/SC-(\d+):\s*(.+)/);
        expect(scMatch).not.toBeNull();

        const statement = scMatch![2].trim();
        const sc: ParsedSC = { id: "SC-999", statement, specFile: "test.md" };
        const assertion = matchPattern(sc);
        expect(assertion).not.toBeNull();
      });
    }
  });
});

// ── create-spec SC validation tests ──────────────────────────

const CREATE_SPEC_SCRIPT = join(ROOT, "scripts", "create-spec.ts");

function runCreateSpec(args: string[], opts?: { input?: string }): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [CREATE_SPEC_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 15000,
    input: opts?.input,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("create-spec SC validation", () => {
  const tmpSpecsDir = join(ROOT, "specs");
  const testSpecName = "CREATE-SPEC-VALIDATION-TEST-SPEC.md";
  const testSpecPath = join(tmpSpecsDir, testSpecName);

  afterEach(() => {
    // Clean up any test spec files
    if (existsSync(testSpecPath)) {
      rmSync(testSpecPath);
    }
  });

  // AC-6: create-spec with matchable SCs succeeds and writes the spec file
  test("create-spec with matchable SCs succeeds and writes spec file", () => {
    // Use --sc flag to pass SC lines that will be validated
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing SC validation",
      "--sc", "AGENTS.md exists",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("AGENTS.md exists");
  });

  // AC-7: create-spec with unmatchable SC fails with exit code 1 and outputs pattern suggestions
  test("create-spec with unmatchable SC fails with exit code 1 and pattern suggestions", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing unmatchable SC",
      "--sc", "this is totally freeform garbage text that matches nothing",
    ]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(testSpecPath)).toBe(false);
    const output = result.stdout + result.stderr;
    // Should suggest closest matching patterns
    expect(output).toMatch(/closest|suggest|pattern/i);
  });

  // AC-8: create-spec with behavioral SC tagged (behavioral) succeeds without matchPattern validation
  test("create-spec with behavioral SC tagged (behavioral) succeeds without validation", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing behavioral bypass",
      "--sc", "Agent reads AGENTS.md before starting work (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("(behavioral)");
  });

  // AC-1: create-spec.ts imports matchPattern and validates SC lines
  test("create-spec.ts uses matchPattern from conformity to validate SCs", () => {
    const content = readFileSync(CREATE_SPEC_SCRIPT, "utf-8");
    expect(content).toContain("matchPattern");
  });

  // AC-2: Freeform SC text shows closest matching patterns
  test("freeform SC text that does not match produces error with closest patterns", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing error messages",
      "--sc", "something completely unrecognizable by any pattern",
    ]);
    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    // Should show pattern suggestions from matcher-registry.json
    expect(output).toMatch(/closest|suggest|pattern/i);
  });

  // AC-3: Behavioral SCs bypass matchPattern validation
  test("behavioral SCs bypass matchPattern validation and are saved", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing behavioral",
      "--sc", "Marcus follows TDD workflow (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
  });

  // AC-4: Validation uses same matchPattern and loadRegistry as conformity engine
  test("create-spec uses matchPattern and loadRegistry from conformity, not duplicate logic", () => {
    const content = readFileSync(CREATE_SPEC_SCRIPT, "utf-8");
    // Should import from conformity or create-sc, not redefine patterns
    expect(content).toMatch(/matchPattern|loadRegistry/);
    // Should not contain raw regex pattern definitions
    expect(content).not.toContain("new RegExp(entry.regex");
  });

  // AC-5: Existing create-spec workflow preserved — title and governs still work
  test("existing create-spec workflow preserved — title and governs arguments still work", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing workflow preservation",
    ]);
    // Should succeed with exit code 0 when no --sc flags (just template)
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
    const content = readFileSync(testSpecPath, "utf-8");
    expect(content).toContain("doc-type: spec");
    expect(content).toContain("governs: Testing workflow preservation");
    expect(content).toContain("# Create Spec Validation Test");
  });

  // Mixed: matchable + unmatchable SCs — should fail
  test("mixed matchable and unmatchable SCs — fails on unmatchable", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing mixed SCs",
      "--sc", "AGENTS.md exists",
      "--sc", "this will not match anything at all",
    ]);
    expect(result.exitCode).toBe(1);
    expect(existsSync(testSpecPath)).toBe(false);
  });

  // Mixed: matchable + behavioral SCs — should succeed
  test("mixed matchable and behavioral SCs — succeeds", () => {
    const result = runCreateSpec([
      "Create Spec Validation Test",
      "Testing mixed success",
      "--sc", "AGENTS.md exists",
      "--sc", "Agent follows coding standards (behavioral)",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(testSpecPath)).toBe(true);
  });
});
