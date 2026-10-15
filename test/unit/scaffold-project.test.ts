#!/usr/bin/env bun
/**
 * scaffold-project.test.ts — TDD tests for scripts/scaffold-project.ts
 *
 * Tests the CLI that bootstraps any project to scaffold conformity.
 * Validates: project type detection, directory creation, AGENTS.md generation,
 * test file creation, spec frontmatter injection, no-overwrite guarantee.
 */
import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { writtenPath } from "../../lib/scaffold/steps";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "scaffold-project.ts");

/**
 * How long a single scaffold is allowed to take, and how long the test
 * running it is allowed to take. The second must exceed the first.
 *
 * Every case in this file spawns a real `bun scripts/scaffold-project.ts`,
 * and a `--fix` run on a project with no CODE-MAP.md spawns a SECOND bun
 * process to generate one (`lib/scaffold/steps.ts`). Measured on this
 * machine: 1.42s for the whole scaffold, 1.04s of it the nested generator —
 * 73% of the operation is a second cold bun start.
 *
 * Bun's default per-test timeout is 5000ms, which is a THIRD of what
 * `runScaffold` itself declares the operation may take. So the runner killed
 * the test while the helper was still willing to wait, and on 2026-10-13 it
 * did: `reports what it created and what it skipped` died at 5007ms on CI
 * while its near-identical neighbour passed in 834ms. The report read
 * "this test timed out after 5000ms" and carried none of the scaffold's
 * output, because the helper never got to catch anything. An earlier run on
 * main lost `SC-525 > --type code (default) behavior is unchanged` the same
 * way at 30s.
 *
 * A verdict that depends on how busy the runner was is not a measurement of
 * the code — the same defect as a check that cannot fail, pointed the other
 * way. The fix is one budget, derived in both places, with the ordering
 * asserted below rather than left as a comment.
 */
const SCAFFOLD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = SCAFFOLD_TIMEOUT_MS + 5_000;
setDefaultTimeout(TEST_TIMEOUT_MS);

function createTempDir(): string {
  const dir = join("/tmp", `scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runScaffold(projectPath: string, opts?: { expectFail?: boolean; fix?: boolean; args?: string[] }): string {
  const extraArgs: string[] = opts?.args || [];
  if (opts?.fix) extraArgs.push("--fix");
  const argStr = extraArgs.length > 0 ? " " + extraArgs.join(" ") : "";
  try {
    return execSync(`bun ${SCRIPT} ${projectPath}${argStr}`, {
      encoding: "utf-8",
      timeout: SCAFFOLD_TIMEOUT_MS,
    });
  } catch (e: any) {
    if (opts?.expectFail) return e.stderr || e.stdout || "";
    throw e;
  }
}

describe("scaffold-project: the test budget must outlast the thing it measures", () => {
  test("the per-test timeout strictly exceeds the scaffold's own", () => {
    // If this ever inverts, every one of the spawning cases in this file can
    // be killed before `runScaffold` is allowed to fail, and the failure
    // report loses the scaffold's output — which is the only thing in it that
    // says what went wrong.
    expect(
      TEST_TIMEOUT_MS,
      "bun would kill the test before execSync times out, discarding the scaffold's output",
    ).toBeGreaterThan(SCAFFOLD_TIMEOUT_MS);
  });

  test("no case in this file relies on bun's 5s default", () => {
    // A positive control on the line that makes the budget apply. Deleting
    // the call leaves both constants declared, correctly ordered, and
    // completely inert — the exact shape of a check that passes because of
    // what it never looked at.
    //
    // Anchored to a top-level statement, and that is not fussiness. The
    // first draft used `toContain` on the bare call text, and deleting the
    // real call left this file green: the only remaining occurrence was the
    // string literal inside this assertion, certifying itself. Same trap as
    // `.claude/rules/claiming-sc-coverage.md`, met from the other side.
    const APPLIED = /^setDefaultTimeout\(TEST_TIMEOUT_MS\);$/m;
    const src = readFileSync(join(import.meta.dir, "scaffold-project.test.ts"), "utf-8");
    expect(APPLIED.test(src), "the budget is declared but never applied").toBe(true);
  });
});

// ── Test 1: Project Type Detection ─────────────────────────────

describe("scaffold-project: project type detection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("detects code project when src/ and package.json exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-code", dependencies: {} }));
    const output = runScaffold(tmpDir, { fix: true });
    expect(output).toContain("code");
  });

  test("detects content project when only markdown files exist", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "posts.md"), "# Posts\n\nSome content.");
    writeFileSync(join(tmpDir, "README.md"), "# readme");
    const output = runScaffold(tmpDir, { fix: true });
    expect(output).toContain("content");
  });

  test("detects infra project when scripts/ or manifests exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const output = runScaffold(tmpDir, { fix: true });
    expect(output).toContain("infra");
  });
});

// ── Test 2: Directory Creation ─────────────────────────────────

describe("scaffold-project: directory creation", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates specs/, reference/, tests/, .github/ when missing", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    expect(existsSync(join(tmpDir, "specs"))).toBe(true);
    expect(existsSync(join(tmpDir, "reference"))).toBe(true);
    // tests/ OR test/ accepted
    const hasTests = existsSync(join(tmpDir, "tests")) || existsSync(join(tmpDir, "test"));
    expect(hasTests).toBe(true);
    expect(existsSync(join(tmpDir, ".github"))).toBe(true);
  });

  test("does not create dirs that already exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    writeFileSync(join(tmpDir, "specs", "existing.md"), "---\ntestable: true\n---\n# Existing");
    runScaffold(tmpDir, { fix: true });

    // specs/ still exists, existing file still there
    expect(existsSync(join(tmpDir, "specs", "existing.md"))).toBe(true);
  });
});

// ── Test 3: AGENTS.md Generation ───────────────────────────────

describe("scaffold-project: AGENTS.md generation", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("generates AGENTS.md with all standard sections", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "my-project" }));
    runScaffold(tmpDir, { fix: true });

    const agentsPath = join(tmpDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    const content = readFileSync(agentsPath, "utf-8");
    const requiredSections = [
      "Project Identity",
      "Rules",
      "Commands",
      "Workflow",
    ];
    for (const section of requiredSections) {
      expect(content.toLowerCase()).toContain(section.toLowerCase());
    }
  });

  test("AGENTS.md is ≤150 lines", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content.split("\n").length).toBeLessThanOrEqual(150);
  });

  test("AGENTS.md contains TODO markers for customization", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("TODO");
  });
});

// ── Test 4: No-Overwrite Guarantee ─────────────────────────────

describe("scaffold-project: no-overwrite guarantee", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("always regenerates AGENTS.md (SC-11 — harness-owned)", () => {
    tmpDir = createTempDir();
    const existingContent = "# My Custom AGENTS.md\n\nThis should be regenerated.";
    writeFileSync(join(tmpDir, "AGENTS.md"), existingContent);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).not.toBe(existingContent);
    expect(content).toContain("## Rules");
  });

  test("never overwrites existing copilot-instructions.md", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    const existing = "# Custom instructions\nDo not touch.";
    writeFileSync(join(tmpDir, ".github", "copilot-instructions.md"), existing);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, ".github", "copilot-instructions.md"), "utf-8");
    expect(content).toBe(existing);
  });

  test("regenerates a drifted scaffold-conformity.test.ts (#208)", () => {
    // INVERTED, deliberately. This test used to assert
    // `expect(content).toBe(existing)` — never overwrites — and it passed
    // for four months. `.claude/rules/harness-managed.md` says the file is
    // "regenerated on re-scaffold", so the test and the doc had been
    // contradicting each other in writing, and the test won silently. #208
    // is that contradiction. Deleting the case would lose the strongest
    // evidence for the fix: this one SPAWNS the real scaffold.
    //
    // Note the directory is `tests/`, not `test/`, so the declaration in
    // OWNED_FILES does not match by path — the call site names the strategy.
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    const stale = "// my custom test\n";
    writeFileSync(join(tmpDir, "tests", "scaffold-conformity.test.ts"), stale);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "tests", "scaffold-conformity.test.ts"), "utf-8");
    expect(content, "the drifted conformity test was skipped, which is #208").not.toBe(stale);
    expect(content).toContain("runScaffoldConformity(ROOT);");
  });

  test("a test file the harness does not own is left alone", () => {
    // AC-1's positive control at the spawn level. A scaffold that rewrites
    // every file in `tests/` satisfies the case above for free.
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    const mine = "// a human wrote this\n";
    writeFileSync(join(tmpDir, "tests", "my-own.test.ts"), mine);
    runScaffold(tmpDir, { fix: true });

    expect(readFileSync(join(tmpDir, "tests", "my-own.test.ts"), "utf-8")).toBe(mine);
  });
});

// ── Test 5: Copilot Instructions ───────────────────────────────

describe("scaffold-project: copilot instructions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates .github/copilot-instructions.md with pointer to AGENTS.md", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    const path = join(tmpDir, ".github", "copilot-instructions.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("AGENTS.md");
  });
});

// ── Test 6: Thin Conformity Test File ──────────────────────────

describe("scaffold-project: conformity test file", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("creates scaffold-conformity.test.ts in tests/", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    // Should create in tests/ (or test/ if that already exists)
    const testDir = existsSync(join(tmpDir, "test")) ? "test" : "tests";
    const testFile = join(tmpDir, testDir, "scaffold-conformity.test.ts");
    expect(existsSync(testFile)).toBe(true);

    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("runScaffoldConformity");
    expect(content).toContain("rungate");
  });
});

// ── Test 7: Spec Frontmatter Injection ─────────────────────────

describe("scaffold-project: spec frontmatter injection", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("adds frontmatter to bare spec files in specs/", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    // Write a spec file WITHOUT frontmatter
    writeFileSync(join(tmpDir, "specs", "bare-spec.md"), "# My Spec\n\nSome content here.");
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "specs", "bare-spec.md"), "utf-8");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("testable:");
    expect(content).toContain("doc-type: spec");
  });

  test("does not modify spec files that already have complete frontmatter", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const existing = "---\ndoc-type: spec\ntestable: true\ncreated: 2026-01-01\ngoverns: test\n---\n# Already Good";
    writeFileSync(join(tmpDir, "specs", "good-spec.md"), existing);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "specs", "good-spec.md"), "utf-8");
    expect(content).toBe(existing);
  });

  test("adds missing required fields to existing frontmatter", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const partial = "---\ndoc-type: spec\n---\n# Partial";
    writeFileSync(join(tmpDir, "specs", "partial-spec.md"), partial);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "specs", "partial-spec.md"), "utf-8");
    expect(content).toContain("testable:");
    expect(content).toContain("created:");
  });
});

// ── Test 8: Package.json devDeps ───────────────────────────────

describe("scaffold-project: package.json devDeps", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("adds rungate to package.json devDependencies when package.json exists", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test", dependencies: {} }, null, 2));
    runScaffold(tmpDir, { fix: true });

    const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies["rungate"]).toBeDefined();
  });

  test("does not create package.json when it does not exist", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(join(tmpDir, "docs", "notes.md"), "# Notes");
    runScaffold(tmpDir, { fix: true });

    // Content project — no package.json should be created
    expect(existsSync(join(tmpDir, "package.json"))).toBe(false);
  });
});

// ── Test 9: Report Output ──────────────────────────────────────

describe("scaffold-project: report output", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("reports what it created and what it skipped", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const output = runScaffold(tmpDir, { fix: true });

    expect(output).toContain("CREATED");
    // Should report at least AGENTS.md creation
    expect(output).toContain("AGENTS.md");
  });

  test("reports AUDITED or SKIPPED for existing files", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Existing");
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    const output = runScaffold(tmpDir, { fix: true });

    expect(output).toMatch(/SKIP|AUDITED/);
    expect(output).toContain("AGENTS.md");
  });
});

// ── Test 10: CLI Error Handling ────────────────────────────────

describe("scaffold-project: CLI error handling", () => {
  test("exits with error when no path provided", () => {
    try {
      execSync(`bun ${SCRIPT}`, { encoding: "utf-8", timeout: 10000 });
      expect(false).toBe(true); // should not reach here
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
  });

  test("exits with error when path does not exist", () => {
    try {
      execSync(`bun ${SCRIPT} /nonexistent/path/that/surely/does/not/exist`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(false).toBe(true);
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
  });
});

// ── Test 11: Existing test/ dir is respected ───────────────────

describe("scaffold-project: respects existing test/ directory name", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("uses test/ if it exists instead of creating tests/", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    runScaffold(tmpDir, { fix: true });

    // Should place conformity test in existing test/ dir
    expect(existsSync(join(tmpDir, "test", "scaffold-conformity.test.ts"))).toBe(true);
    // Should NOT create a second tests/ dir
    expect(existsSync(join(tmpDir, "tests"))).toBe(false);
  });
});

// ── Test 12: Hard Constraints last-section edge case ─────────

describe("scaffold-project: hard constraints regex", () => {
  test("Hard Constraints preserved when last section in AGENTS.md", () => {
    const content = `## Identity\nTest project\n\n## Hard Constraints (non-inferrable)\n\n- **Rule one** — important\n- **Rule two** — also important\n`;
    const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
    expect(hcMatch).not.toBeNull();
    expect(hcMatch![1]).toContain("Rule one");
    expect(hcMatch![1]).toContain("Rule two");
  });
});

// ── Test 13: Per-type staleness thresholds ────────────────────

describe("scaffold-project: per-type staleness thresholds", () => {
  function classifyStale(ref: string, daysSince: number): boolean {
    const isAdr = ref.includes('docs/adr/') || /ADR/i.test(ref);
    if (isAdr) return false;
    const threshold = ref.startsWith('specs/') ? 90 : 180;
    return daysSince > threshold;
  }

  test("ADR paths are never stale regardless of age", () => {
    expect(classifyStale("docs/adr/ADR-001.md", 500)).toBe(false);
  });

  test("spec paths use 90-day threshold", () => {
    expect(classifyStale("specs/BOOTSTRAP.md", 91)).toBe(true);
    expect(classifyStale("specs/BOOTSTRAP.md", 89)).toBe(false);
  });

  test("other doc paths use 180-day threshold", () => {
    expect(classifyStale("docs/GUIDE.md", 181)).toBe(true);
    expect(classifyStale("docs/GUIDE.md", 179)).toBe(false);
  });
});

// ── Test 14: Consumer hook deployment (SC-472) ──────────────

describe("scaffold-project: consumer hook deployment", () => {
  let tmpDir: string;
  let consumerDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    if (consumerDir && existsSync(consumerDir)) rmSync(consumerDir, { recursive: true });
  });

  test("deploys hooks with deployToConsumers:true to consumer settings.local.json (SC-472)", () => {
    tmpDir = createTempDir();
    consumerDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    mkdirSync(join(tmpDir, "hooks"), { recursive: true });
    writeFileSync(join(tmpDir, "hooks", "TestHook.hook.ts"), "// test hook");
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      project: "test",
      roles: {},
      consumers: [consumerDir],
      hooks: [
        {
          name: "TestHook",
          hookFor: "PreToolUse",
          command: "bun ${RUNGATE_HOOKS_DIR}/TestHook.hook.ts",
          enabled: true,
          matcher: "Bash",
          deployToConsumers: true,
        },
        {
          name: "LocalOnly",
          hookFor: "PostToolUse",
          command: "bun ${RUNGATE_HOOKS_DIR}/LocalOnly.hook.ts",
          enabled: true,
          matcher: "Write",
          deployToConsumers: false,
        },
      ],
    }));
    runScaffold(tmpDir, { fix: true });

    const consumerSettings = join(consumerDir, ".claude", "settings.local.json");
    expect(existsSync(consumerSettings)).toBe(true);
    const settings = JSON.parse(readFileSync(consumerSettings, "utf-8"));
    // deployToConsumers:true hook should be deployed
    expect(settings.hooks?.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse.length).toBeGreaterThanOrEqual(1);
    // deployToConsumers:false hook should NOT be deployed
    expect(settings.hooks?.PostToolUse).toBeUndefined();
  });

  test("consumer hook has correct hookFor and resolved command path", () => {
    tmpDir = createTempDir();
    consumerDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    mkdirSync(join(tmpDir, "hooks"), { recursive: true });
    writeFileSync(join(tmpDir, "hooks", "TestHook.hook.ts"), "// test hook");
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      project: "test",
      roles: {},
      consumers: [consumerDir],
      hooks: [
        {
          name: "TestHook",
          hookFor: "PreToolUse",
          command: "bun ${RUNGATE_HOOKS_DIR}/TestHook.hook.ts",
          enabled: true,
          matcher: "Bash",
          deployToConsumers: true,
        },
      ],
    }));
    runScaffold(tmpDir, { fix: true });

    const consumerSettings = join(consumerDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(consumerSettings, "utf-8"));
    const hook = settings.hooks.PreToolUse[0];
    // Command should be resolved (no ${RUNGATE_HOOKS_DIR})
    expect(hook.command).not.toContain("${RUNGATE_HOOKS_DIR}");
    expect(hook.command).toContain("hooks/TestHook.hook.ts");
  });
});

// ── Test 15: Dry-run mode (no --fix) ─────────────────────────

describe("scaffold-project: dry-run mode", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("dry-run: reports gaps without modifying spec frontmatter", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const original = "# Bare Spec\n\nNo frontmatter.";
    writeFileSync(join(tmpDir, "specs", "bare.md"), original);
    const output = runScaffold(tmpDir); // no --fix
    // Should report the gap
    expect(output).toMatch(/GAP|WARN/);
    // Should NOT modify the file
    const content = readFileSync(join(tmpDir, "specs", "bare.md"), "utf-8");
    expect(content).toBe(original);
  });

  test("dry-run: does not create directories or files", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-dry" }));
    const output = runScaffold(tmpDir); // no --fix
    // Should NOT create specs/ or other scaffold dirs
    expect(existsSync(join(tmpDir, "specs"))).toBe(false);
    expect(existsSync(join(tmpDir, "AGENTS.md"))).toBe(false);
    // Should report gaps
    expect(output).toMatch(/GAP|audit/i);
  });

  /**
   * #398 changed the verb these two cases assert, and the change is
   * deliberate — flagged in the PR rather than slipped in.
   *
   * Audit used to PREDICT: four `existsSync` checks emitting
   * `GAP: X missing — run with --fix to generate`, standing in for
   * twenty-five write steps. It reported 0 changes on a tree `--fix` rewrote
   * in 28 places. Audit now REHEARSES — the real steps run against a
   * throwaway clone — so the report says `GENERATED: CODE-MAP.md`, because
   * that is what the step did.
   *
   * The GAP vocabulary cannot be kept on top of that. A translation layer
   * from write verbs back to GAP would be a second vocabulary maintained by
   * hand beside the first, which is the exact shape #398 removes; and
   * `writtenPath()`'s negative control requires that GAP name no path, so an
   * audit emitting GAP could never be compared against what `--fix` wrote.
   * The "run with --fix" half is not lost — `rehearsalNotice()` prints it
   * once per run instead of once per file.
   *
   * What these cases still assert is the part that matters and did not
   * change: audit NAMES the file, and audit WRITES NOTHING.
   */
  test("dry-run: names the missing CODE-MAP.md for code projects, and writes nothing", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-codemap" }));
    const output = runScaffold(tmpDir); // no --fix
    // Which write verb is the step's business, not this test's — asserted
    // through the same binding `postScaffoldCommit` stages by and the
    // agreement property compares with, so a verb rename cannot make this
    // pass while breaking those.
    const named = output.split("\n").map(writtenPath).filter(Boolean);
    expect(named, "audit did not name CODE-MAP.md as a write").toContain("CODE-MAP.md");
    expect(
      existsSync(join(tmpDir, "CODE-MAP.md")),
      "audit wrote into the tree it was previewing",
    ).toBe(false);
  });

  test("dry-run: names the missing docs-routing rule, and writes nothing", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-routing" }));
    const output = runScaffold(tmpDir); // no --fix
    expect(output).toMatch(/docs-routing/);
    expect(
      existsSync(join(tmpDir, ".claude", "rules", "docs-routing.md")),
      "audit wrote into the tree it was previewing",
    ).toBe(false);
  });

  test("dry-run: exits with code 0", () => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test-exit" }));
    // If it doesn't throw, exit code is 0
    const output = runScaffold(tmpDir);
    expect(output).toBeDefined();
  });
});

// ── Test 16: Fix mode preserves existing content ─────────────

describe("scaffold-project: fix mode preserves existing content", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("fix mode preserves existing frontmatter values when adding missing fields", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const partial = "---\ndoc-type: spec\nstatus: approved\nowner: alice\n---\n# My Spec\n\nContent here.";
    writeFileSync(join(tmpDir, "specs", "owned.md"), partial);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "specs", "owned.md"), "utf-8");
    // Existing values preserved
    expect(content).toContain("status: approved");
    expect(content).toContain("owner: alice");
    // Missing fields added
    expect(content).toContain("testable:");
    expect(content).toContain("created:");
  });

  test("fix mode never overwrites existing governs value", () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    const existing = "---\ndoc-type: spec\ntestable: true\ncreated: 2026-01-01\ngoverns: my-custom-scope\n---\n# Scoped Spec";
    writeFileSync(join(tmpDir, "specs", "scoped.md"), existing);
    runScaffold(tmpDir, { fix: true });

    const content = readFileSync(join(tmpDir, "specs", "scoped.md"), "utf-8");
    expect(content).toContain("governs: my-custom-scope");
    // Should NOT have a second governs field
    const governsCount = (content.match(/governs:/g) || []).length;
    expect(governsCount).toBe(1);
  });
});
