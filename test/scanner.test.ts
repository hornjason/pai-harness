/**
 * Scanner unit tests — verifies lib/scanner.ts extraction per SCAFFOLD-DECOMPOSITION-SPEC SC-358/359.
 *
 * AC-1: lib/scanner.ts exports scanProject returning ProjectScan
 * AC-2: Scanner detects tech stack, specs, consumers, source directories
 * AC-3: Scanner imports no generation logic (only fs, path, types)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// AC-1: scanner exports scanProject
import { scanProject } from "../lib/scanner";
import type { ProjectScan } from "../lib/generators/types";

const ROOT = join(import.meta.dir, "..");

describe("lib/scanner.ts — scanProject", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- AC-1: exports scanProject returning ProjectScan ---

  test("AC-1: scanProject is a function", () => {
    expect(typeof scanProject).toBe("function");
  });

  test("AC-1: scanProject returns a ProjectScan with required fields", () => {
    // Minimal code project: just package.json + src/
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-proj",
      description: "A test project",
      type: "module",
      scripts: { test: "bun test" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.name).toBe("test-proj");
    expect(scan.type).toBe("code");
    expect(scan.root).toBe(tmpDir);
    expect(scan.identity).toBeTruthy();
    expect(Array.isArray(scan.techStack)).toBe(true);
    expect(Array.isArray(scan.keyFiles)).toBe(true);
    expect(Array.isArray(scan.specs)).toBe(true);
    expect(Array.isArray(scan.consumers)).toBe(true);
    expect(Array.isArray(scan.sourceDirs)).toBe(true);
  });

  // --- AC-2: detects tech stack ---

  test("AC-2: detects Bun runtime from package.json scripts", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "bun-proj",
      scripts: { test: "bun test", dev: "bun run dev" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("Bun");
  });

  test("AC-2: detects TypeScript from tsconfig.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "ts-proj",
      scripts: { test: "bun test" },
    }));
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("TypeScript");
  });

  test("AC-2: detects ESM from package.json type field", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "esm-proj",
      type: "module",
      scripts: { test: "bun test" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.techStack).toContain("ESM");
  });

  // --- AC-2: detects specs ---

  test("AC-2: scans spec files with frontmatter", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "spec-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "specs"));
    writeFileSync(join(tmpDir, "specs", "MY-SPEC.md"), `---
doc-type: spec
governs: Something important
testable: true
---
# My Spec
`);

    const scan = scanProject(tmpDir);
    expect(scan.specs.length).toBeGreaterThanOrEqual(1);
    const spec = scan.specs.find(s => s.file === "MY-SPEC.md");
    expect(spec).toBeDefined();
    expect(spec!.governs).toBe("Something important");
    expect(spec!.testable).toBe("true");
  });

  // --- AC-2: detects consumers ---

  test("AC-2: reads consumers from harness config", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "consumer-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      consumers: ["project-a", "project-b"],
    }));

    const scan = scanProject(tmpDir);
    expect(scan.consumers).toContain("project-a");
    expect(scan.consumers).toContain("project-b");
  });

  // --- AC-2: detects source directories ---

  test("AC-2: detects source directories", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "dirs-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "lib"));

    const scan = scanProject(tmpDir);
    expect(scan.sourceDirs).toContain("src");
    expect(scan.sourceDirs).toContain("lib");
  });

  // --- AC-2: detects project type ---

  test("AC-2: detects code project type", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "code-proj" }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.type).toBe("code");
  });

  test("AC-2: detects content project type (no package.json, no manifests)", () => {
    // Content project: no package.json, no infra markers
    mkdirSync(join(tmpDir, "docs"));
    writeFileSync(join(tmpDir, "docs", "README.md"), "# Content");

    const scan = scanProject(tmpDir);
    expect(scan.type).toBe("content");
  });

  // --- AC-2: more scan fields ---

  test("AC-2: detects test command from package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      name: "test-cmd-proj",
      scripts: { test: "jest --coverage" },
    }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    expect(scan.testCmd).toBe("jest --coverage");
  });

  test("AC-2: scans key files including package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "keys-proj" }));
    mkdirSync(join(tmpDir, "src"));

    const scan = scanProject(tmpDir);
    const files = scan.keyFiles.map(kf => kf.file);
    expect(files).toContain("package.json");
  });

  test("AC-2: scans test files", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "tests-proj" }));
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "test"));
    writeFileSync(join(tmpDir, "test", "example.test.ts"), "test('x', () => {});");

    const scan = scanProject(tmpDir);
    expect(scan.testFiles.length).toBeGreaterThanOrEqual(1);
    expect(scan.testFiles[0].file).toBe("example.test.ts");
  });
});

describe("README identity extraction edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-identity-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("identity strips YAML frontmatter with LF line endings", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "fm-proj" }));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "README.md"),
      "---\ndoc-type: readme\nstatus: active\n---\n\n# My Project\n\nThis is a real content paragraph describing the project in detail.\n"
    );

    const scan = scanProject(tmpDir);
    expect(scan.identity).toBe("This is a real content paragraph describing the project in detail.");
  });

  test("identity strips YAML frontmatter with CRLF line endings", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "crlf-proj" }));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "README.md"),
      "---\r\ndoc-type: readme\r\nstatus: active\r\n---\r\n\r\n# My Project\r\n\r\nThis is a CRLF content paragraph describing the project.\r\n"
    );

    const scan = scanProject(tmpDir);
    expect(scan.identity).toBe("This is a CRLF content paragraph describing the project.");
  });

  test("identity skips badge lines and shield images", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "badge-proj" }));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "README.md"),
      "# Badge Project\n\n[![Build Status](https://img.shields.io/badge/build-passing-green)](https://example.com)\n[![Coverage](https://shields.io/badge/coverage-90-blue)](https://example.com)\n\n![Logo](./assets/logo.png)\n\nThe actual project description starts here with enough words to pass the filter.\n"
    );

    const scan = scanProject(tmpDir);
    expect(scan.identity).toBe("The actual project description starts here with enough words to pass the filter.");
  });

  test("identity handles mixed frontmatter plus template markers", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "mixed-proj" }));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "README.md"),
      "---\ndoc-type: readme\nstatus: draft\n---\n\n<!-- TODO: Add badges here -->\n\n# Mixed Template Project\n\n[![Build](https://img.shields.io/badge/build-ok-green)](https://example.com)\n\n![hero](./hero.png)\n\nThis is the real identity paragraph for a template-style README file.\n"
    );

    const scan = scanProject(tmpDir);
    expect(scan.identity).toBe("This is the real identity paragraph for a template-style README file.");
  });

  test("identity skips image-only paragraphs", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "img-proj" }));
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "README.md"),
      "# Image Project\n\n![Screenshot](./screenshot.png)\n\n![Another](https://example.com/img.jpg)\n\nA substantial description of the image project with enough detail.\n"
    );

    const scan = scanProject(tmpDir);
    expect(scan.identity).toBe("A substantial description of the image project with enough detail.");
  });
});

describe("#91: docs-routing counts include nested documents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-nested-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "nested-proj" }));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function routeFor(dir: string): string | undefined {
    return scanProject(tmpDir).docRouting.find(d => d.file === `${dir}/`)?.need;
  }

  test("a category whose documents all live in subdirectories is not reported as empty", () => {
    // The real case: reference/ held 19 .md files, every one of them nested, and
    // the routing table told readers it had 0. A row claiming a directory is
    // empty is worse than no row — it reads as an instruction not to look.
    mkdirSync(join(tmpDir, "reference", "specs"), { recursive: true });
    writeFileSync(join(tmpDir, "reference", "specs", "a.md"), "# A");
    writeFileSync(join(tmpDir, "reference", "specs", "b.md"), "# B");

    expect(routeFor("reference")).toContain("(2 files)");
  });

  test("counts nested and top-level documents together", () => {
    mkdirSync(join(tmpDir, "docs", "research", "hill-climb"), { recursive: true });
    writeFileSync(join(tmpDir, "docs", "research", "top.md"), "# Top");
    writeFileSync(join(tmpDir, "docs", "research", "hill-climb", "v1.md"), "# V1");

    expect(routeFor("docs/research")).toContain("(2 files)");
  });

  // The three tests above exercise lib/scanner.ts. The scaffold does not use
  // it for this: lib/scaffold/steps.ts:334-378 holds a second, complete copy of
  // scanDocRouting, and steps.ts:422 is what feeds generateScopedRules and
  // writes the rule file. Fixing scanner.ts alone changed no generated output
  // at all, and these tests went green anyway — they were covering the copy
  // nobody calls. This one asserts the artifact a reader actually opens.
  test("the generated rule file agrees with a recursive count on disk", () => {
    const rulePath = join(ROOT, ".claude", "rules", "docs-routing.md");
    if (!existsSync(rulePath)) return;
    const rule = readFileSync(rulePath, "utf-8");

    for (const dir of ["specs", "docs/research", "docs/council", "docs/guides", "reference"]) {
      const catPath = join(ROOT, dir);
      if (!existsSync(catPath)) continue;
      const actual = readdirSync(catPath, { recursive: true }).map(String).filter(f => f.endsWith(".md")).length;
      const row = rule.split("\n").find(l => l.includes(`\`${dir}/\``));
      if (!row) continue;
      const claimed = row.match(/\((\d+) files\)/)?.[1];
      expect(claimed, `docs-routing.md row for ${dir}/`).toBe(String(actual));
    }
  });

  test("still counts only markdown", () => {
    mkdirSync(join(tmpDir, "reference", "scripts"), { recursive: true });
    writeFileSync(join(tmpDir, "reference", "keep.md"), "# Keep");
    writeFileSync(join(tmpDir, "reference", "scripts", "run.sh"), "echo hi");
    writeFileSync(join(tmpDir, "reference", "manifest.json"), "{}");

    expect(routeFor("reference")).toContain("(1 files)");
  });
});

describe("#70: scanner resolves harnessConfig from the .claude/rungate directory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-dirconfig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Project whose ONLY harness config is the .claude/rungate/ directory form. */
  function writeDirectoryConfig(consumers: string[]) {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "dir-config-proj" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    // A file the src/ consumer heuristic WOULD pick up if the config were ignored
    writeFileSync(join(tmpDir, "src", "api-routes.ts"), "app.get('/x', () => {});\n");
    const dir = join(tmpDir, ".claude", "rungate");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      project: "dir-config-proj",
      repo: "owner/dir-config-proj",
      consumers,
    }));
    writeFileSync(join(dir, "roles.json"), JSON.stringify({
      marcus: { description: "Engineer", tools: "[Bash, Read]", model: "opus" },
    }));
  }

  // --- AC-1 ---

  test("AC-1: scanProject returns non-null harnessConfig for directory-only config", () => {
    writeDirectoryConfig(["alpha"]);
    expect(existsSync(join(tmpDir, ".claude", "rungate.json"))).toBe(false);

    const scan = scanProject(tmpDir);
    expect(scan.harnessConfig).not.toBeNull();
    expect(scan.harnessConfig!.project).toBe("dir-config-proj");
    expect(scan.harnessConfig!.repo).toBe("owner/dir-config-proj");
    // roles.json merges into the same shape as the monolith
    expect(scan.agentMeta.marcus).toBeDefined();
    expect(scan.agentMeta.marcus.model).toBe("opus");
  });

  // --- AC-2 ---

  test("AC-2: detectConsumers reads directory-form consumers, not the src/ heuristic", () => {
    writeDirectoryConfig(["project-a", "project-b"]);

    const scan = scanProject(tmpDir);
    expect(scan.consumers).toEqual(["project-a", "project-b"]);
    expect(scan.consumers).not.toContain("api");
  });

  // --- AC-3 ---

  test("AC-3: key-files entry names the rungate directory, not .claude/rungate.json", () => {
    writeDirectoryConfig(["alpha"]);

    const scan = scanProject(tmpDir);
    const files = scan.keyFiles.map(kf => kf.file);
    expect(files).toContain(".claude/rungate/");
    expect(files).not.toContain(".claude/rungate.json");

    const entry = scan.keyFiles.find(kf => kf.file === ".claude/rungate/")!;
    expect(entry.what).toContain("Harness project config");
  });

  test("AC-3: key-files entry names the directory for monolith projects too", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "mono-keys-proj" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({ project: "mono-keys-proj" }));

    const files = scanProject(tmpDir).keyFiles.map(kf => kf.file);
    expect(files).toContain(".claude/rungate/");
    expect(files).not.toContain(".claude/rungate.json");
  });

  // --- AC-4: no regression for monolith-only projects ---

  test("AC-4: scanProject still resolves harnessConfig for a monolith-only project", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "mono-proj" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "api-routes.ts"), "app.get('/x', () => {});\n");
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "rungate.json"), JSON.stringify({
      project: "mono-proj",
      repo: "owner/mono-proj",
      consumers: ["legacy-a"],
      roles: { quinn: { description: "QA", tools: "[Bash]", model: "sonnet" } },
    }));
    expect(existsSync(join(tmpDir, ".claude", "rungate"))).toBe(false);

    const scan = scanProject(tmpDir);
    expect(scan.harnessConfig).not.toBeNull();
    expect(scan.harnessConfig!.project).toBe("mono-proj");
    expect(scan.consumers).toEqual(["legacy-a"]);
    expect(scan.agentMeta.quinn).toBeDefined();
  });

  test("AC-4: scanProject returns null harnessConfig when no config exists at all", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "no-config-proj" }));
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    const scan = scanProject(tmpDir);
    expect(scan.harnessConfig).toBeNull();
  });
});

describe("AC-3: Scanner import isolation", () => {
  test("scanner.ts imports no generation modules", () => {
    const content = readFileSync(join(ROOT, "lib/scanner.ts"), "utf-8");
    // Must not import from generators/agents-md, generators/agent-briefs, generators/code-map
    expect(content).not.toMatch(/from.*generators\/(agents-md|agent-briefs|code-map)/);
    // May import from generators/types (that's the typed interface, not generation logic)
    expect(content).toMatch(/from.*generators\/types|from.*\.\/generators\/types/);
  });
});
