/**
 * #72 AC-1 — the scaffold creates tsconfig.json for a TypeScript consumer that
 * has none, and leaves a project with no TypeScript source alone.
 *
 * Why this exists: #65/#76 found that AGENTS.md advertised `bunx tsc --noEmit`
 * as THE type check in every scaffolded consumer, while rungate never created
 * the tsconfig.json that command needs — so the documented check printed tsc's
 * help text and exited 1, having checked nothing. The generator was taught to
 * stop advertising the row without a tsconfig; this closes the other half by
 * creating the file, so the row can come back and mean something.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { createTsconfig } from "../../lib/scaffold/steps";
import { scaffoldMinimalProject } from "../helpers/scaffold-fixture";

const tmpRoot = join(tmpdir(), `rungate-tsconfig-${process.pid}`);

function project(files: Record<string, string>): string {
  const root = join(tmpRoot, `p-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

const PKG = JSON.stringify({ name: "p", type: "module", scripts: { test: "bun test" } }, null, 2);

describe("#72 AC-1: createTsconfig", () => {
  beforeEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(tmpRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  test("writes tsconfig.json into a TypeScript project that has none", () => {
    const root = project({ "package.json": PKG, "src/index.ts": "export const a = 1;\n" });
    const actions: string[] = [];

    createTsconfig(root, actions);

    expect(existsSync(join(root, "tsconfig.json"))).toBe(true);
    expect(actions).toContain("CREATED: tsconfig.json");
  });

  test("the written tsconfig is strict with an ESNext module target", () => {
    const root = project({ "package.json": PKG, "src/index.ts": "export const a = 1;\n" });
    createTsconfig(root, []);

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8"));
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe("ESNext");
    expect(tsconfig.compilerOptions.target).toBe("ESNext");
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.exclude).toContain("node_modules");
  });

  test("include covers source directories that hold .ts, and only those", () => {
    const root = project({
      "package.json": PKG,
      "src/index.ts": "export const a = 1;\n",
      "scripts/build.ts": "export const b = 1;\n",
      // lib/ exists but holds no TypeScript — including it would make tsc
      // error TS18003 on a pattern that matches nothing.
      "lib/notes.md": "# notes\n",
    });
    createTsconfig(root, []);

    const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf-8"));
    expect(tsconfig.include).toContain("src/**/*.ts");
    expect(tsconfig.include).toContain("scripts/**/*.ts");
    expect(tsconfig.include).not.toContain("lib/**/*.ts");
  });

  test("skips a project with no TypeScript signal", () => {
    const root = project({ "package.json": PKG, "src/index.js": "export const a = 1;\n" });
    const actions: string[] = [];

    createTsconfig(root, actions);

    expect(existsSync(join(root, "tsconfig.json"))).toBe(false);
    expect(actions.join("\n")).toMatch(/SKIP: tsconfig\.json \(no TypeScript/);
  });

  test("leaves an existing tsconfig.json untouched", () => {
    const original = '{ "compilerOptions": { "strict": false } }\n';
    const root = project({ "package.json": PKG, "src/index.ts": "export const a = 1;\n", "tsconfig.json": original });
    const actions: string[] = [];

    createTsconfig(root, actions);

    expect(readFileSync(join(root, "tsconfig.json"), "utf-8")).toBe(original);
    expect(actions.join("\n")).toMatch(/SKIP: tsconfig\.json \(already exists\)/);
  });
});

describe("#72 AC-1: the step is wired into the scaffold before AGENTS.md is written", () => {
  const dest = join(tmpdir(), `rungate-tsconfig-wiring-${process.pid}`);

  beforeEach(() => scaffoldMinimalProject(dest), 180_000);
  afterEach(() => rmSync(dest, { recursive: true, force: true }));

  test("a scaffolded TypeScript consumer ends up with a strict tsconfig.json", () => {
    const tsconfig = JSON.parse(readFileSync(join(dest, "tsconfig.json"), "utf-8"));
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  test("AGENTS.md advertises a Type check command, which it only does with a tsconfig", () => {
    // Ordering assertion in behavioral form: generateAgentsMdContent computes
    // the Type check row from existsSync(tsconfig.json). If the new step ran
    // after AGENTS.md was written, this row would be absent.
    const agentsMd = readFileSync(join(dest, "AGENTS.md"), "utf-8");
    expect(agentsMd).toMatch(/\|\s*Type check\s*\|/);
  });
});
