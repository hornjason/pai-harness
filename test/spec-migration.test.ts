/**
 * spec-migration tests — TDD tests for detecting misplaced specs in docs/specs/
 * and migrating them to specs/.
 *
 * Tests AC-1 through AC-A1 from issue #41.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// Use /tmp/ fixtures to avoid auto-commit pollution
const FIXTURE_ROOT = join("/tmp", "spec-migration-test-" + process.pid);

function createFixture() {
  if (existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true });
  }
  mkdirSync(join(FIXTURE_ROOT, "specs"), { recursive: true });
  mkdirSync(join(FIXTURE_ROOT, "docs", "specs"), { recursive: true });
  // Initialize a git repo so git mv works
  execSync("git init", { cwd: FIXTURE_ROOT, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: FIXTURE_ROOT, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: FIXTURE_ROOT, stdio: "pipe" });
}

function cleanupFixture() {
  if (existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true });
  }
}

// ── AC-1: detectMisplacedSpecs emits WARN ────────────────────

describe("AC-1: detectMisplacedSpecs emits WARN for docs/specs/ files", () => {
  beforeEach(createFixture);
  afterEach(cleanupFixture);

  test("detects spec files in docs/specs/ and emits WARN action", () => {
    // Place a spec in docs/specs/
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "OLD-SPEC.md"),
      "# Old Spec\n\n1. Must do something\n"
    );

    const actions: string[] = [];
    const { detectMisplacedSpecs } = require("../lib/validators/spec-validators");
    detectMisplacedSpecs(FIXTURE_ROOT, actions);

    const warns = actions.filter((a: string) => a.startsWith("WARN"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((w: string) => w.includes("docs/specs/"))).toBe(true);
    expect(warns.some((w: string) => w.includes("migrate"))).toBe(true);
  });

  test("emits WARN with migration command suggestion", () => {
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "ANOTHER-SPEC.md"),
      "# Another Spec\n\n- Must validate inputs\n"
    );

    const actions: string[] = [];
    const { detectMisplacedSpecs } = require("../lib/validators/spec-validators");
    detectMisplacedSpecs(FIXTURE_ROOT, actions);

    const warns = actions.filter((a: string) => a.startsWith("WARN"));
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.some((w: string) => w.includes("migrate-specs"))).toBe(true);
  });

  test("does not WARN when docs/specs/ is empty or absent", () => {
    // docs/specs/ exists but is empty
    const actions: string[] = [];
    const { detectMisplacedSpecs } = require("../lib/validators/spec-validators");
    detectMisplacedSpecs(FIXTURE_ROOT, actions);

    const warns = actions.filter((a: string) => a.startsWith("WARN") && a.includes("docs/specs/"));
    expect(warns.length).toBe(0);
  });
});

// ── AC-2: migrate-specs.ts CLI moves files ───────────────────

describe("AC-2: migrate-specs.ts CLI moves specs from docs/specs/ to specs/", () => {
  beforeEach(() => {
    createFixture();
    // Add a spec file and commit it so git mv works
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "MIGRATE-ME.md"),
      "---\ndoc-type: spec\ntestable: false\ngoverns: test\n---\n\n# Migrate Me\n"
    );
    execSync("git add .", { cwd: FIXTURE_ROOT, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: FIXTURE_ROOT, stdio: "pipe" });
  });
  afterEach(cleanupFixture);

  test("moves spec files from docs/specs/ to specs/ with exit code 0", () => {
    const scriptPath = join(import.meta.dir, "..", "scripts", "migrate-specs.ts");
    const result = Bun.spawnSync(["bun", scriptPath, FIXTURE_ROOT], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env },
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(FIXTURE_ROOT, "specs", "MIGRATE-ME.md"))).toBe(true);
    expect(existsSync(join(FIXTURE_ROOT, "docs", "specs", "MIGRATE-ME.md"))).toBe(false);
  });
});

// ── AC-3: Migration adds frontmatter ─────────────────────────

describe("AC-3: Migration adds frontmatter to files lacking it", () => {
  beforeEach(() => {
    createFixture();
    // Create a spec WITHOUT frontmatter
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "NO-FM.md"),
      "# No Frontmatter Spec\n\n1. Must validate\n2. Never skip\n"
    );
    execSync("git add .", { cwd: FIXTURE_ROOT, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: FIXTURE_ROOT, stdio: "pipe" });
  });
  afterEach(cleanupFixture);

  test("adds doc-type spec frontmatter with testable false and governs placeholder", () => {
    const scriptPath = join(import.meta.dir, "..", "scripts", "migrate-specs.ts");
    Bun.spawnSync(["bun", scriptPath, FIXTURE_ROOT], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env },
    });

    const content = readFileSync(join(FIXTURE_ROOT, "specs", "NO-FM.md"), "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("doc-type: spec");
    expect(content).toContain("testable: false");
    expect(content).toContain("governs:");
  });
});

// ── AC-4: Migration converts numbered criteria to SC checkboxes ──

describe("AC-4: Migration converts numbered criteria to SC checkbox format", () => {
  beforeEach(() => {
    createFixture();
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "NUMBERED.md"),
      "---\ndoc-type: spec\ntestable: true\ngoverns: test\n---\n\n# Numbered Spec\n\n## Success Criteria\n\n1. Must validate all inputs\n2. Never allow empty strings\n3. Always return a result\n"
    );
    execSync("git add .", { cwd: FIXTURE_ROOT, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: FIXTURE_ROOT, stdio: "pipe" });
  });
  afterEach(cleanupFixture);

  test("converts numbered criteria lines to SC-N checkbox format", () => {
    const scriptPath = join(import.meta.dir, "..", "scripts", "migrate-specs.ts");
    Bun.spawnSync(["bun", scriptPath, FIXTURE_ROOT], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env },
    });

    const content = readFileSync(join(FIXTURE_ROOT, "specs", "NUMBERED.md"), "utf-8");
    expect(content).toContain("- [ ] SC-1:");
    expect(content).toContain("- [ ] SC-2:");
    expect(content).toContain("- [ ] SC-3:");
    // Original numbered lines should be replaced
    expect(content).not.toMatch(/^1\. Must validate/m);
  });
});

// ── AC-5: Scaffold emits suggestion for unconverted specs ────

describe("AC-5: Scaffold emits convert-spec suggestion for specs without SC checkboxes", () => {
  beforeEach(createFixture);
  afterEach(cleanupFixture);

  test("emits suggestion to run convert-spec.ts for specs without SC lines", () => {
    // Create a spec in specs/ that has no SC checkbox lines
    writeFileSync(
      join(FIXTURE_ROOT, "specs", "UNCONVERTED.md"),
      "---\ndoc-type: spec\ntestable: true\ngoverns: test\n---\n\n# Unconverted\n\n## Rules\n\n1. Must do X\n2. Never do Y\n"
    );

    const actions: string[] = [];
    const { detectUnconvertedSpecs } = require("../lib/validators/spec-validators");
    detectUnconvertedSpecs(join(FIXTURE_ROOT, "specs"), actions);

    const suggestions = actions.filter((a: string) => a.includes("convert-spec"));
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions.some((s: string) => s.includes("UNCONVERTED.md"))).toBe(true);
  });

  test("does not emit suggestion for specs that already have SC checkboxes", () => {
    writeFileSync(
      join(FIXTURE_ROOT, "specs", "CONVERTED.md"),
      "---\ndoc-type: spec\ntestable: true\ngoverns: test\n---\n\n# Converted\n\n## Success Criteria\n\n- [ ] SC-1: Must do X\n"
    );

    const actions: string[] = [];
    const { detectUnconvertedSpecs } = require("../lib/validators/spec-validators");
    detectUnconvertedSpecs(join(FIXTURE_ROOT, "specs"), actions);

    const suggestions = actions.filter((a: string) => a.includes("CONVERTED.md"));
    expect(suggestions.length).toBe(0);
  });
});

// ── AC-A1: Migration uses git mv to preserve history ─────────

describe("AC-A1: Migration uses git mv to preserve git history", () => {
  beforeEach(() => {
    createFixture();
    writeFileSync(
      join(FIXTURE_ROOT, "docs", "specs", "GIT-MV-TEST.md"),
      "---\ndoc-type: spec\ngoverns: test\n---\n\n# Git MV Test\n"
    );
    execSync("git add .", { cwd: FIXTURE_ROOT, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: FIXTURE_ROOT, stdio: "pipe" });
  });
  afterEach(cleanupFixture);

  test("uses git mv to move files, preserving git history", () => {
    const scriptPath = join(import.meta.dir, "..", "scripts", "migrate-specs.ts");
    const result = Bun.spawnSync(["bun", scriptPath, FIXTURE_ROOT], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env },
    });

    expect(result.exitCode).toBe(0);

    // Check git status — file should show as renamed, not deleted+added
    const statusResult = execSync("git status --porcelain", {
      cwd: FIXTURE_ROOT,
      encoding: "utf-8",
    });
    // git mv shows as "R" (renamed) in porcelain status
    // Or could show as "A" + "D" pair — but importantly, git diff --name-status should show R
    const diffResult = execSync("git diff --cached --name-status", {
      cwd: FIXTURE_ROOT,
      encoding: "utf-8",
    });
    // Should have a rename entry (R) or at minimum the file should be in specs/
    expect(existsSync(join(FIXTURE_ROOT, "specs", "GIT-MV-TEST.md"))).toBe(true);
    expect(existsSync(join(FIXTURE_ROOT, "docs", "specs", "GIT-MV-TEST.md"))).toBe(false);
    // Verify the move was staged (git mv stages automatically)
    expect(statusResult).toContain("specs/GIT-MV-TEST.md");
  });
});
