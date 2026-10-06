import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { loadRungateConfig, tryLoadRungateConfig } from "../lib/config-loader.js";

const TMP = "/tmp/rungate-config-loader-test";

const ROLES = {
  marcus: { brief: "engineer", tools: ["Read", "Edit"] },
  quinn: { brief: "qa", tools: ["Read"] },
};

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeDirProject(name: string, opts: { config?: boolean } = {}): string {
  const projectDir = join(TMP, name);
  const configDir = join(projectDir, ".claude", "rungate");
  mkdirSync(configDir, { recursive: true });
  if (opts.config) {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        project: name,
        repo: "x/y",
        issueRepo: "x/y",
        contextDocs: {},
        consumers: [],
        pages: {},
        test: { command: "bun test", timeout: 30000 },
      })
    );
  }
  writeFileSync(join(configDir, "roles.json"), JSON.stringify(ROLES));
  return projectDir;
}

describe("config-loader", () => {
  describe("tryLoadRungateConfig", () => {
    // AC-1. Fixture carries config.json because every real directory layout
    // has one — both scaffold paths write all four files. A fragment without
    // config.json is a broken config, covered separately below.
    test("returns merged roles for a directory-only project", () => {
      const projectDir = makeDirProject("dir-only", { config: true });

      const config = tryLoadRungateConfig(projectDir);

      expect(config).not.toBeNull();
      expect(config!.roles).toHaveProperty("marcus");
      expect(config!.roles).toHaveProperty("quinn");
    });

    test("returns merged roles when the directory also has config.json", () => {
      const projectDir = makeDirProject("dir-with-config", { config: true });

      const config = tryLoadRungateConfig(projectDir);

      expect(config).not.toBeNull();
      expect(config!.project).toBe("dir-with-config");
      expect(config!.roles).toHaveProperty("marcus");
      expect(config!.hooks).toEqual([]);
    });

    // AC-2
    test("returns null (no throw) when no config exists", () => {
      const projectDir = join(TMP, "no-config");
      mkdirSync(join(projectDir, ".claude"), { recursive: true });

      expect(() => tryLoadRungateConfig(projectDir)).not.toThrow();
      expect(tryLoadRungateConfig(projectDir)).toBeNull();
    });

    test("returns null (no throw) when the project root does not exist", () => {
      expect(tryLoadRungateConfig(join(TMP, "missing-project"))).toBeNull();
    });

    // AC-3
    test("resolves the monolith rungate.json when the directory form is absent", () => {
      const projectDir = join(TMP, "monolith");
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "rungate.json"),
        JSON.stringify({
          project: "monolith-project",
          repo: "x/y",
          issueRepo: "x/y",
          contextDocs: {},
          consumers: [],
          pages: {},
          test: { command: "bun test", timeout: 30000 },
          roles: ROLES,
          hooks: [],
        })
      );

      const config = tryLoadRungateConfig(projectDir);

      expect(config).not.toBeNull();
      expect(config!.project).toBe("monolith-project");
      expect(config!.roles).toHaveProperty("marcus");
    });

    test("prefers the directory form over the monolith", () => {
      const projectDir = makeDirProject("both-forms", { config: true });
      writeFileSync(
        join(projectDir, ".claude", "rungate.json"),
        JSON.stringify({
          project: "monolith-loses",
          repo: "x/y",
          issueRepo: "x/y",
          contextDocs: {},
          consumers: [],
          pages: {},
          test: { command: "bun test", timeout: 30000 },
          roles: {},
          hooks: [],
        })
      );

      const config = tryLoadRungateConfig(projectDir);

      expect(config!.project).toBe("both-forms");
      expect(config!.roles).toHaveProperty("marcus");
    });

    // Was asserting the opposite — that a malformed monolith returns null.
    // ADR-001 D2 forbids it: "a malformed config is never a missing config."
    // A test that encodes the defect keeps the defect, so it is inverted here
    // rather than deleted.
    test("throws (does not return null) when monolith JSON is malformed", () => {
      const projectDir = join(TMP, "malformed-monolith");
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "rungate.json"), "{ not json");

      expect(() => tryLoadRungateConfig(projectDir)).toThrow();
    });
  });

  describe("loadRungateConfig", () => {
    // AC-4
    test("throws when no config is found (contract unchanged)", () => {
      const projectDir = join(TMP, "throwing");
      mkdirSync(join(projectDir, ".claude"), { recursive: true });

      expect(() => loadRungateConfig(projectDir)).toThrow(/No rungate config found/);
    });

    test("still loads the directory form", () => {
      const projectDir = makeDirProject("load-dir", { config: true });

      const config = loadRungateConfig(projectDir);

      expect(config.project).toBe("load-dir");
      expect(config.roles).toHaveProperty("marcus");
    });
  });

  // AC-10 / AC-11 — regressions found by security review on the first pass of
  // this change. Both reproduce the exact silence that caused #70.
  describe("config shadowing and malformed config", () => {
    function writeMonolith(projectDir: string): void {
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "rungate.json"),
        JSON.stringify({
          project: "mono",
          repo: "x/y",
          issueRepo: "real/repo",
          contextDocs: {},
          consumers: [],
          pages: {},
          test: { command: "bun test", timeout: 30000 },
          roles: ROLES,
        })
      );
    }

    // AC-10. A directory fragment without config.json must not be treated as
    // the directory form. ADR-001 Step E keeps the monolith in place until
    // conformity is green, so every migrating consumer passes through this
    // state — and dropping issueRepo/ci/test there is silent.
    test("an orphan directory fragment does not void an existing monolith", () => {
      const projectDir = join(TMP, "shadowed");
      const configDir = join(projectDir, ".claude", "rungate");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "roles.json"), JSON.stringify(ROLES));
      writeMonolith(projectDir);

      const config = tryLoadRungateConfig(projectDir);

      expect(config).not.toBeNull();
      expect(config!.issueRepo).toBe("real/repo");
    });

    // AC-11. ADR-001 D2: "a malformed config is never a missing config".
    // Returning null here is what let #70 stay silent — the caller cannot tell
    // "not configured" from "configured wrong".
    test("tryLoadRungateConfig throws on malformed JSON rather than returning null", () => {
      const projectDir = join(TMP, "malformed");
      const configDir = join(projectDir, ".claude", "rungate");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.json"), '{"project": "x",}');

      expect(() => tryLoadRungateConfig(projectDir)).toThrow();
    });

    test("tryLoadRungateConfig still returns null for genuine absence", () => {
      const projectDir = join(TMP, "absent");
      mkdirSync(projectDir, { recursive: true });

      expect(tryLoadRungateConfig(projectDir)).toBeNull();
    });
  });
});
