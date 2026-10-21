import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { execSync } from "child_process";

import {
  containmentRemedy,
  containmentVerdict,
  readContainment,
  WATCHED_DIRS,
  WATCHED_FILES,
} from "../lib/containment";

const HARNESS_ROOT = resolve(import.meta.dir, "..");

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

/**
 * ST-2 and ST-2b read a fixture tree this suite builds, NOT the developer's
 * home directory (#921). The old locations on a real machine are read by
 * `bun scripts/check-containment.ts`, whose exit code is where a stray shows
 * up for whoever can act on it — a file belonging to another process must
 * not be able to set the verdict of the suite that gates this repository.
 *
 * Every case plants a stray and asserts the REFUSAL before it asserts a
 * clean tree passes. A freshly built fixture is empty, so "the old locations
 * hold no harness files" is true of it before the check exists and true of
 * it after; only the planted direction can tell those apart.
 */
let containmentFixtures: string;

beforeAll(() => {
  containmentFixtures = mkdtempSync(join(tmpdir(), "rungate-containment-"));
});

afterAll(() => {
  rmSync(containmentFixtures, { recursive: true, force: true });
});

/** An old-harness root with every watched directory present and empty. */
function oldRoot(name: string): string {
  const root = join(containmentFixtures, name);
  for (const { dir } of WATCHED_DIRS) mkdirSync(join(root, dir), { recursive: true });
  for (const f of WATCHED_FILES) {
    mkdirSync(join(root, f.split("/").slice(0, -1).join("/")), { recursive: true });
  }
  return root;
}

describe("ST-2: Containment — harness files not in old locations", () => {
  // The population the pre-#921 check named one by one. Every one of them
  // must still be something the reading would refuse; the list shrinking is
  // the way this check dies quietly.
  const harnessPatterns = [
    "workflows/ship.js",
    "workflows/prove.js",
    "workflows/council.js",
    "workflows/batch-ship.js",
    "workflows/verify.js",
    "gates/run-gate.ts",
    "gates/gate-executor.ts",
    "gates/orchestrator.ts",
    "gates/schema.ts",
    "gates/witness.ts",
    "gates/ship-orchestrator.ts",
    "gates/brief-assembler.ts",
    "scripts/sync-spec-tests.ts",
    "scripts/scaffold-rungate-config.ts",
    "lib/paths.ts",
  ];

  for (const pattern of harnessPatterns) {
    test(`${pattern} in an old location is refused`, () => {
      const root = oldRoot(`pattern-${pattern.replace(/\//g, "-")}`);
      writeFileSync(join(root, pattern), "// a second copy of the harness\n");
      const readings = readContainment(root);
      expect(containmentVerdict(readings)).toBe("STRAY");
      expect(readings.flatMap(r => r.strays)).toContain(join(root, pattern));
    });
  }

  test("the same tree without any of them reads CLEAN", () => {
    const readings = readContainment(oldRoot("patterns-clean"));
    expect(
      containmentVerdict(readings),
      readings.map(r => `${r.subject}=${r.state}`).join(", "),
    ).toBe("CLEAN");
  });
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
  for (const { dir, ext } of WATCHED_DIRS) {
    test(`a ${ext} file planted in ${dir}/ is refused`, () => {
      const root = oldRoot(`dir-${dir}`);
      const planted = join(root, dir, `stray${ext}`);
      writeFileSync(planted, "// a second copy of the harness\n");
      const readings = readContainment(root);
      expect(readings.find(r => r.subject === `${dir}/*${ext}`)!.state).toBe("STRAY");
      expect(containmentVerdict(readings)).toBe("STRAY");
    });

    test(`${dir}/ with no ${ext} file reads CLEAN, and an absent ${dir}/ does not`, () => {
      const root = oldRoot(`dir-clean-${dir}`);
      writeFileSync(join(root, dir, "unrelated.md"), "not a harness file\n");
      expect(readContainment(root).find(r => r.subject === `${dir}/*${ext}`)!.state).toBe("CLEAN");

      // Absence is the third state. The pre-#921 check returned early here
      // and reported a pass having looked at nothing.
      const bare = join(containmentFixtures, `dir-absent-${dir}`);
      mkdirSync(bare, { recursive: true });
      expect(readContainment(bare).find(r => r.subject === `${dir}/*${ext}`)!.state).toBe(
        "UNMEASURED",
      );
    });
  }

  test("the refusal names the file, its directory, and what to do", () => {
    const root = oldRoot("remedy");
    writeFileSync(join(root, "workflows", "stray.js"), "// a second copy\n");
    const message = containmentRemedy(HARNESS_ROOT, readContainment(root));
    expect(message, "the file is not named").toContain(join(root, "workflows", "stray.js"));
    expect(message, "the directory is not named").toContain("moved out of");
    expect(message, "the reader is not told where to take the real reading").toContain(
      "scripts/check-containment.ts",
    );
    expect(message, "the family of repository-level checks is not routed to").toContain(
      ".claude/rules/self-referential-tests.md",
    );
  });

  test("an UNMEASURED location is reported in the refusal, not folded into a pass", () => {
    const bare = join(containmentFixtures, "remedy-unmeasured");
    mkdirSync(bare, { recursive: true });
    const readings = readContainment(bare);
    expect(containmentVerdict(readings)).toBe("UNMEASURED");
    expect(containmentRemedy(HARNESS_ROOT, readings)).toContain("UNMEASURED and are NOT clean");
  });
});

describe("ST-3: Path purity — no hardcoded ~/.claude/ paths", () => {
  test("no hardcoded paths in .ts/.js files", () => {
    const dirs = ["workflows", "gates", "scripts", "lib"].map(d => join(HARNESS_ROOT, d));
    const existingDirs = dirs.filter(d => existsSync(d));
    if (existingDirs.length === 0) {
      expect(existingDirs.length).toBeGreaterThan(0);
      return;
    }
    // Any home-shaped absolute path, not `$HOME` interpolated (#921). The
    // old pattern searched for the path of whoever ran the suite, so in CI —
    // where the home directory is `/home/runner` and no source could name it
    // — the check was vacuous and could not fail.
    const result = execSync(
      `grep -rnE '(/Users/|/home/)[A-Za-z0-9._-]+/\\.claude' ${existingDirs.join(" ")} --include='*.ts' --include='*.js' 2>/dev/null || true`,
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
        `find ${HARNESS_ROOT} -path '*/.claude/worktrees' -prune -o -name '${file}' -type f -print 2>/dev/null`,
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

describe("ST-6: templates/ directory exists for agent brief templates", () => {
  test("templates/ directory exists", () => {
    expect(existsSync(join(HARNESS_ROOT, "templates"))).toBe(true);
  });

  test("templates/agent-briefs/ directory exists", () => {
    expect(existsSync(join(HARNESS_ROOT, "templates", "agent-briefs"))).toBe(true);
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
