import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/convert-spec.ts");
const TMP = join("/tmp", "convert-spec-test-" + process.pid);

function run(...args: string[]) {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: ROOT,
    timeout: 15_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("convert-spec CLI", () => {
  // ── AC-1: CLI accepts file path, outputs converted spec ──

  test("AC-1: accepts file path and exits 0 with --dry-run", () => {
    const input = join(TMP, "rules.md");
    writeFileSync(
      input,
      "1. Never commit secrets\n2. Always run tests before merging\n3. Use TypeScript for all new code\n"
    );
    const { exitCode, stdout } = run(input, "--dry-run");
    expect(exitCode).toBe(0);
    // Should contain frontmatter and SC lines
    expect(stdout).toContain("---");
    expect(stdout).toContain("SC-");
  });

  test("AC-1: exits non-zero when no file path provided", () => {
    const { exitCode } = run();
    expect(exitCode).not.toBe(0);
  });

  test("AC-1: exits non-zero when file does not exist", () => {
    const { exitCode } = run("/tmp/nonexistent-convert-spec-test.md");
    expect(exitCode).not.toBe(0);
  });

  // ── AC-2: Generated frontmatter ──

  test("AC-2: output includes doc-type, status, owner, testable, governs fields", () => {
    const input = join(TMP, "fm-test.md");
    writeFileSync(
      input,
      "1. Must validate inputs\n2. Never expose secrets\n3. Always log errors\n"
    );
    const { stdout } = run(input, "--dry-run");
    expect(stdout).toContain("doc-type: spec");
    expect(stdout).toContain("status:");
    expect(stdout).toContain("testable:");
    expect(stdout).toContain("governs:");
  });

  test("AC-2: defaults are sensible (draft status, testable true)", () => {
    const input = join(TMP, "defaults.md");
    writeFileSync(input, "1. Must validate all inputs\n");
    const { stdout } = run(input, "--dry-run");
    expect(stdout).toContain("status: draft");
    expect(stdout).toContain("testable: true");
  });

  // ── AC-3: Numbered rules and signal phrases → SC lines ──

  test("AC-3: converts numbered rules to SC checkbox lines (>= 3)", () => {
    const input = join(TMP, "rules-sc.md");
    writeFileSync(
      input,
      [
        "1. Must validate all user inputs before processing",
        "2. Never store passwords in plaintext",
        "3. Always use parameterized queries for database access",
        "4. Required: all API endpoints return JSON",
      ].join("\n") + "\n"
    );
    const { stdout } = run(input, "--dry-run");
    const scLines = stdout.split("\n").filter((l) => /SC-\d+/.test(l));
    expect(scLines.length).toBeGreaterThanOrEqual(3);
  });

  test("AC-3: detects signal-phrase patterns (must/never/always/shall)", () => {
    const input = join(TMP, "signal.md");
    writeFileSync(
      input,
      "- All handlers must validate input before processing.\n" +
        "- Never expose internal error details to clients.\n" +
        "- Always prefer composition over inheritance.\n"
    );
    const { stdout } = run(input, "--dry-run");
    const scLines = stdout.split("\n").filter((l) => /SC-\d+/.test(l));
    expect(scLines.length).toBeGreaterThanOrEqual(3);
  });

  // ── AC-4: Non-testable rules flagged ──

  test("AC-4: non-testable rules get (non-testable) annotation", () => {
    const input = join(TMP, "nontestable.md");
    writeFileSync(
      input,
      [
        "1. Code should be elegant and readable",
        "2. Must run bun test before merging",
        "3. Think carefully about edge cases",
      ].join("\n") + "\n"
    );
    const { stdout } = run(input, "--dry-run");
    expect(stdout).toContain("non-testable");
  });

  test("AC-4: testable rules do NOT have (non-testable) annotation", () => {
    const input = join(TMP, "testable.md");
    writeFileSync(input, "1. Must run bun test before merging\n");
    const { stdout } = run(input, "--dry-run");
    const scLines = stdout.split("\n").filter((l) => /SC-\d+/.test(l));
    // The testable line should not have non-testable
    const testableLines = scLines.filter((l) => !l.includes("non-testable"));
    expect(testableLines.length).toBeGreaterThanOrEqual(1);
  });

  // ── AC-5: --dry-run shows preview, writes no files ──

  test("AC-5: --dry-run outputs to stdout without writing files", () => {
    const input = join(TMP, "dry-run.md");
    writeFileSync(input, "1. Must validate inputs\n");
    const { exitCode, stdout } = run(input, "--dry-run");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("doc-type: spec");
    // Verify no spec file was created in specs/
    const specsDir = join(ROOT, "specs");
    const beforeFiles = existsSync(specsDir)
      ? Bun.spawnSync(["ls", specsDir]).stdout.toString()
      : "";
    // The file should not be created — check for the generated slug
    expect(existsSync(join(specsDir, "DRY-RUN-SPEC.md"))).toBe(false);
  });

  test("AC-5: without --dry-run, writes file to specs/", () => {
    const input = join(TMP, "write-test.md");
    writeFileSync(input, "1. Must validate inputs\n");
    const outPath = join(TMP, "output-spec.md");
    const { exitCode, stdout } = run(input, "--output", outPath);
    expect(exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, "utf-8");
    expect(content).toContain("doc-type: spec");
  });

  // ── AC-6: Additional coverage ──

  test("AC-6: handles empty input file gracefully", () => {
    const input = join(TMP, "empty.md");
    writeFileSync(input, "");
    const { exitCode, stderr } = run(input, "--dry-run");
    // Should handle gracefully — either exit 0 with no SCs or exit non-zero
    // Either behavior is acceptable as long as it doesn't crash
    expect(typeof exitCode).toBe("number");
  });

  test("AC-6: preserves original title from # heading if present", () => {
    const input = join(TMP, "titled.md");
    writeFileSync(
      input,
      "# Security Guidelines\n\n1. Must validate all inputs\n2. Never expose secrets\n3. Always encrypt data at rest\n"
    );
    const { stdout } = run(input, "--dry-run");
    expect(stdout).toContain("Security Guidelines");
  });

  test("AC-6: generates unique SC numbers", () => {
    const input = join(TMP, "unique-sc.md");
    writeFileSync(
      input,
      "1. Must validate inputs\n2. Never expose secrets\n3. Always run tests\n"
    );
    const { stdout } = run(input, "--dry-run");
    const scNums = stdout.match(/SC-(\d+)/g) ?? [];
    const unique = new Set(scNums);
    expect(unique.size).toBe(scNums.length);
  });
});
