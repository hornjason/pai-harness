import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/convert-spec.ts");

// Temp dir for test inputs
const TMP = "/tmp/convert-spec-test-" + Date.now();

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function runConvert(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    cwd: ROOT,
    timeout: 15_000,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("convert-spec CLI", () => {
  // ── AC-1: CLI accepts file path and outputs converted spec ──

  test("AC-1: accepts a file path and outputs converted spec with --dry-run (exit 0)", () => {
    const input = join(TMP, "ac1-input.md");
    writeFileSync(input, "1. Never commit secrets\n2. Always run tests before merging\n3. Use TypeScript for all new code\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("doc-type:");
    expect(stdout).toContain("SC-");
  });

  // ── AC-2: Generated spec includes proper frontmatter ──

  test("AC-2: output includes frontmatter with doc-type, status, owner, testable, governs", () => {
    const input = join(TMP, "ac2-input.md");
    writeFileSync(input, "1. Must validate all user inputs before processing\n2. Never store passwords in plaintext\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("doc-type: spec");
    expect(stdout).toContain("status: draft");
    expect(stdout).toContain("testable:");
    expect(stdout).toContain("governs:");
    expect(stdout).toContain("owner:");
  });

  // ── AC-3: Numbered rules and signal phrases become SC checkbox lines ──

  test("AC-3: numbered rules converted to SC-N checkbox lines (>= 3)", () => {
    const input = join(TMP, "ac3-input.md");
    writeFileSync(input, [
      "1. Must validate all user inputs before processing",
      "2. Never store passwords in plaintext",
      "3. Always use parameterized queries for database access",
      "4. Required: all API endpoints return JSON",
    ].join("\n") + "\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    const scLines = stdout.split("\n").filter((l: string) => /SC-\d+/.test(l));
    expect(scLines.length).toBeGreaterThanOrEqual(3);
    // Each SC line should be a checkbox
    for (const line of scLines) {
      expect(line).toMatch(/- \[ \] SC-\d+:/);
    }
  });

  // ── AC-4: Non-testable rules are flagged ──

  test("AC-4: non-testable rules get (non-testable) annotation", () => {
    const input = join(TMP, "ac4-input.md");
    writeFileSync(input, [
      "1. Code should be elegant and readable",
      "2. Must run bun test before merging",
      "3. Think carefully about edge cases",
    ].join("\n") + "\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("non-testable");
  });

  // ── AC-5: --dry-run shows preview without writing files ──

  test("AC-5: --dry-run does not write any file to disk", () => {
    const input = join(TMP, "ac5-input.md");
    writeFileSync(input, "1. Must validate inputs\n");
    const { exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);

    // Check that no spec file was created in the specs dir
    const specsDir = join(ROOT, "specs");
    const specFiles = existsSync(specsDir)
      ? require("fs").readdirSync(specsDir).filter((f: string) => f.includes("AC5-INPUT"))
      : [];
    expect(specFiles.length).toBe(0);
  });

  // ── AC-6: Additional coverage tests ──

  test("AC-6: exits with error when no file path argument given", () => {
    const { exitCode, stderr } = runConvert([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage");
  });

  test("AC-6: exits with error when input file does not exist", () => {
    const { exitCode, stderr } = runConvert(["/tmp/nonexistent-file-xyz.md", "--dry-run"]);
    expect(exitCode).not.toBe(0);
  });

  test("signal phrases with must/never/always are detected as rules", () => {
    const input = join(TMP, "signal-input.md");
    writeFileSync(input, [
      "- Developers must not push to main directly",
      "- Always review PRs before merging",
      "- Tests shall pass before deployment",
    ].join("\n") + "\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    const scLines = stdout.split("\n").filter((l: string) => /SC-\d+/.test(l));
    expect(scLines.length).toBeGreaterThanOrEqual(2);
  });

  test("output includes a title derived from input filename", () => {
    const input = join(TMP, "my-coding-standards.md");
    writeFileSync(input, "1. Must validate inputs\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    // Title should appear as a markdown heading
    expect(stdout).toMatch(/^# .+/m);
  });

  test("frontmatter has valid created date", () => {
    const input = join(TMP, "date-test.md");
    writeFileSync(input, "1. Must validate inputs\n");
    const { stdout, exitCode } = runConvert([input, "--dry-run"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/created: \d{4}-\d{2}-\d{2}/);
    expect(stdout).toMatch(/updated: \d{4}-\d{2}-\d{2}/);
  });
});
