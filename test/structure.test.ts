import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "/Users/jhorn";
const CLAUDE_DIR = join(HOME, ".claude");

interface ManifestEntry {
  source: string;
  dest: string;
  migrated: boolean;
  note?: string;
}

interface Manifest {
  files: ManifestEntry[];
}

function loadManifest(): Manifest {
  const raw = readFileSync(join(HARNESS_ROOT, "reference", "migration-manifest.json"), "utf8");
  return JSON.parse(raw);
}

describe("ST-1: Migrated files exist at dest", () => {
  const manifest = loadManifest();
  const migrated = manifest.files.filter(f => f.migrated && f.dest !== "DUPLICATE-DELETE");

  test("at least one file is marked migrated", () => {
    expect(migrated.length).toBeGreaterThan(0);
  });

  for (const entry of migrated) {
    test(`${entry.dest} exists`, () => {
      const fullPath = join(HARNESS_ROOT, entry.dest);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

describe("ST-2: Containment — harness files not in old locations", () => {
  const harnessPatterns = [
    "workflows/ship.js",
    "workflows/prove.js",
    "workflows/council.js",
    "workflows/batch-ship.js",
    "workflows/verify.js",
    "gates/run-gate.ts",
    "gates/orchestrator.ts",
    "gates/schema.ts",
    "gates/witness.ts",
    "gates/ship-orchestrator.ts",
    "gates/brief-assembler.ts",
    "scripts/sync-spec-tests.ts",
    "scripts/scaffold-project-harness.ts",
    "lib/paths.ts",
  ];

  for (const pattern of harnessPatterns) {
    const oldPath = join(CLAUDE_DIR, pattern);
    test(`${pattern} not in ~/.claude/`, () => {
      expect(existsSync(oldPath)).toBe(false);
    });
  }
});

describe("ST-2c: Hook independence — no PAI imports", () => {
  test("hooks have zero imports from ~/.pai/hooks/lib/", () => {
    const hooksDir = join(HARNESS_ROOT, "hooks");
    if (!existsSync(hooksDir)) return;
    const result = execSync(
      `grep -rn "from.*\\.pai/hooks\\|require.*\\.pai/hooks\\|from.*hooks/lib/paths\\|from.*hooks/lib/parseStdin\\|from.*hooks/lib/findWorkflow\\|from.*hooks/lib/agentDetection" ${hooksDir} --include='*.ts' 2>/dev/null || true`,
      { encoding: "utf8" }
    );
    const lines = result.trim().split("\n").filter(l => l.length > 0);
    expect(lines).toEqual([]);
  });
});

describe("ST-2b: Containment — no harness-pattern files in old locations", () => {
  const oldHarnessDirs = [
    { dir: join(CLAUDE_DIR, "workflows"), ext: ".js" },
    { dir: join(CLAUDE_DIR, "gates"), ext: ".ts" },
    { dir: join(CLAUDE_DIR, "lib"), ext: ".ts" },
  ];

  for (const { dir, ext } of oldHarnessDirs) {
    test(`no ${ext} files in ${dir.replace(HOME, "~")}`, () => {
      if (!existsSync(dir)) return;
      const files = readdirSync(dir).filter(f => f.endsWith(ext));
      expect(files).toEqual([]);
    });
  }
});

describe("ST-3: Path purity — no hardcoded ~/.claude/ paths", () => {
  test("no hardcoded paths in .ts/.js files", () => {
    const dirs = ["workflows", "gates", "scripts", "lib"].map(d => join(HARNESS_ROOT, d));
    const existingDirs = dirs.filter(d => existsSync(d));
    if (existingDirs.length === 0) {
      expect(existingDirs.length).toBeGreaterThan(0);
      return;
    }
    const result = execSync(
      `grep -rn '/Users/jhorn/.claude' ${existingDirs.join(" ")} --include='*.ts' --include='*.js' 2>/dev/null || true`,
      { encoding: "utf8" }
    );
    const lines = result.trim().split("\n").filter(l => l.length > 0);
    expect(lines).toEqual([]);
  });
});

describe("ST-4: Config dedup — each config file exists exactly once", () => {
  const configFiles = ["ceremony-profiles.json", "workflow-schema.json", "spec-policies.json"];

  for (const file of configFiles) {
    test(`${file} exists exactly once`, () => {
      const result = execSync(
        `find ${HARNESS_ROOT} -name '${file}' -type f 2>/dev/null`,
        { encoding: "utf8" }
      );
      const matches = result.trim().split("\n").filter(l => l.length > 0);
      expect(matches.length).toBe(1);
    });
  }
});

describe("ST-5: No skills/ directory in rungate", () => {
  test("skills/ directory does not exist", () => {
    expect(existsSync(join(HARNESS_ROOT, "skills"))).toBe(false);
  });
});

describe("ST-6: No templates/ directory in rungate", () => {
  test("templates/ directory does not exist", () => {
    expect(existsSync(join(HARNESS_ROOT, "templates"))).toBe(false);
  });
});

describe("ST-7: lib/paths.ts exports required functions", () => {
  test("lib/paths.ts exists", () => {
    expect(existsSync(join(HARNESS_ROOT, "lib", "paths.ts"))).toBe(true);
  });

  test("exports harnessRoot", () => {
    const content = readFileSync(join(HARNESS_ROOT, "lib", "paths.ts"), "utf8");
    expect(content).toContain("harnessRoot");
  });

  test("exports paiRoot", () => {
    const content = readFileSync(join(HARNESS_ROOT, "lib", "paths.ts"), "utf8");
    expect(content).toContain("paiRoot");
  });

  test("exports workDir", () => {
    const content = readFileSync(join(HARNESS_ROOT, "lib", "paths.ts"), "utf8");
    expect(content).toContain("workDir");
  });

  test("exports gateSaltPath", () => {
    const content = readFileSync(join(HARNESS_ROOT, "lib", "paths.ts"), "utf8");
    expect(content).toContain("gateSaltPath");
  });
});
