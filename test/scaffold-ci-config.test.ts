/**
 * scaffold-ci-config.test.ts — CI workflow emission from .claude/rungate config.
 *
 * AC-1: a glob branch entry in ci.branches produces a ci.yml that parses as valid YAML
 * AC-2: the same glob branch entry produces a gates.yml that also parses as valid YAML
 * AC-3: the emitted runs-on value is wrapped in double quotes in both workflow files
 * AC-5: no string written by lib/scaffold/steps.ts names .claude/rungate.json as the
 *       customization path (the config lives in .claude/rungate/config.json)
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createCiWorkflows } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const TMP = "/tmp/rungate-ci-config-test";

// `*` is an alias indicator and `*-dev` an unresolved alias in plain YAML, so an
// unquoted branch list turns a legal GitHub Actions glob into a parse error.
const GLOB_BRANCHES = ["main", "*", "*-dev", "release/**"];
const RUNNER = "ubuntu-latest";
const BUN_VERSION = "1.2.0";

function readWorkflow(name: string): string {
  return readFileSync(join(TMP, ".github", "workflows", name), "utf-8");
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(TMP, ".claude", "rungate", "config.json"),
    JSON.stringify({
      project: "ci-config-fixture",
      ci: { runner: RUNNER, bunVersion: BUN_VERSION, branches: GLOB_BRANCHES },
    }, null, 2) + "\n"
  );
  createCiWorkflows(TMP, []);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("AC-1: ci.yml parses as valid YAML with glob branches", () => {
  test("ci.yml parses", () => {
    const yml = readWorkflow("ci.yml");
    expect(() => Bun.YAML.parse(yml)).not.toThrow();
  });

  test("ci.yml keeps every glob branch on push and pull_request", () => {
    const parsed = Bun.YAML.parse(readWorkflow("ci.yml")) as any;
    // YAML 1.1 folds a bare `on` key to boolean true; accept either spelling.
    const triggers = parsed.on ?? parsed[true as unknown as string];
    expect(triggers.push.branches).toEqual(GLOB_BRANCHES);
    expect(triggers.pull_request.branches).toEqual(GLOB_BRANCHES);
  });
});

describe("AC-2: gates.yml parses as valid YAML with glob branches", () => {
  test("gates.yml parses", () => {
    const yml = readWorkflow("gates.yml");
    expect(() => Bun.YAML.parse(yml)).not.toThrow();
  });

  test("gates.yml keeps every glob branch on push and pull_request", () => {
    const parsed = Bun.YAML.parse(readWorkflow("gates.yml")) as any;
    const triggers = parsed.on ?? parsed[true as unknown as string];
    expect(triggers.push.branches).toEqual(GLOB_BRANCHES);
    expect(triggers.pull_request.branches).toEqual(GLOB_BRANCHES);
  });
});

describe("AC-3: runs-on is double quoted", () => {
  for (const file of ["ci.yml", "gates.yml"]) {
    test(`${file} quotes runs-on`, () => {
      expect(readWorkflow(file)).toContain(`runs-on: "${RUNNER}"`);
    });
  }
});

describe("AC-5: customization path points at the config directory", () => {
  for (const file of ["ci.yml", "gates.yml"]) {
    test(`${file} does not name .claude/rungate.json`, () => {
      const yml = readWorkflow(file);
      expect(yml).not.toContain(".claude/rungate.json");
      expect(yml).toContain(".claude/rungate/config.json");
    });
  }

  test("steps.ts has no 'Customize via ... rungate.json' string", () => {
    const src = readFileSync(join(ROOT, "lib", "scaffold", "steps.ts"), "utf-8");
    const offenders = src
      .split("\n")
      .filter((l) => /[Cc]ustomize[^\n]*rungate\.json/.test(l));
    expect(offenders).toEqual([]);
  });
});
