/**
 * scaffold-fixture.ts — golden-project fixture setup for phase tests.
 *
 * Extracted from test/phase-0.test.ts to keep that file a thin consumer under
 * the 200-line deep-modules cap (AC-1 in the phase test conformity check).
 * The fixture mechanics live here; the test file asserts.
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { initFixtureRepo, commitFixture } from "./git-fixture";

// bootstrap re-hashed 2026-10-05 (#80): redirect-stub `governs` was "TODO".
const SPEC_HASHES: Record<string, string> = { bootstrap: "05f388d8b3a2e036", testPlan: "352ebe436fbd3330" };

/** Throws if either bootstrap spec changed without its hash being updated. */
export function checkSpecDrift(): void {
  const specsDir = join(import.meta.dir, "..", "..", "specs");
  const specs = [
    { name: "bootstrap", path: join(specsDir, "BOOTSTRAP-DATA-FLOW-SPEC.md") },
    { name: "testPlan", path: join(specsDir, "BOOTSTRAP-TEST-PLAN.md") },
  ];
  for (const { name, path } of specs) {
    if (!existsSync(path)) continue;
    const hash = execSync(`shasum -a 256 "${path}" | cut -c1-16`, { encoding: "utf-8" }).trim();
    const expected = SPEC_HASHES[name];
    if (expected !== "UPDATE_AFTER_SPEC_CHANGE" && hash !== expected)
      throw new Error(`SPEC DRIFT: ${name} changed (${hash} != ${expected}). Update SPEC_HASHES.${name} to "${hash}".`);
  }
}

const FIXTURE = join(import.meta.dir, "..", "fixtures/golden-project");
const SCAFFOLD = join(import.meta.dir, "..", "..", "scripts", "scaffold-project.ts");

/**
 * Canary value planted in .claude/rungate/roles.json only. It appears in no
 * default and in no other config file, so finding it in a generated brief
 * proves roles.json was actually read rather than DEFAULT_AGENT_META winning.
 */
export const ROLES_CANARY_MODEL = "canary-model-from-roles-json";

/** Copy the golden project to `dest`, optionally seed it, then scaffold it. */
export function scaffoldFixture(dest: string, seed?: () => void): void {
  try { execSync(`rm -rf ${dest}`, { stdio: "pipe" }); } catch {}
  mkdirSync(dest, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${dest}/`);
  seed?.();
  // Shared helpers rather than raw git init/commit: they pin an identity so the
  // fixture does not depend on the developer's global git config (#71).
  initFixtureRepo(dest);
  commitFixture(dest, "init fixture");
  try {
    execSync(`bun run ${SCAFFOLD} ${dest} --fix`, { timeout: 60000, encoding: "utf-8", stdio: "pipe" });
  } catch {
    // Scaffold may not exist yet or may fail — tests should still run and FAIL
  }
}

/**
 * A TypeScript consumer with NO tsconfig.json — the shape #65/#76 broke on.
 *
 * Deliberately minimal and deliberately missing the tsconfig: callers assert
 * that the scaffold creates one. Adding a tsconfig here would make every one
 * of those assertions pass for the wrong reason.
 */
export const MINIMAL_TS_PROJECT: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "minimal-ts-consumer", version: "1.0.0", type: "module", scripts: { test: "bun test" } },
    null,
    2,
  ) + "\n",
  "src/index.ts": 'export const greeting: string = "hello";\n',
};

/**
 * Write `files` into a fresh `dest`, commit them, then scaffold with --fix.
 *
 * Unlike `scaffoldFixture`, a scaffold failure is NOT swallowed here. These
 * callers assert on what the scaffold produced, so a silent scaffold crash
 * would turn into a confusing "file missing" rather than the real error.
 */
export function scaffoldMinimalProject(
  dest: string,
  files: Record<string, string> = MINIMAL_TS_PROJECT,
): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  initFixtureRepo(dest);
  commitFixture(dest, "init minimal project");
  execSync(`bun run ${SCAFFOLD} ${dest} --fix`, { timeout: 120000, encoding: "utf-8", stdio: "pipe" });
}

/** Seeder that writes a directory-layout config whose roles.json holds the canary. */
export function seedRolesConfig(dest: string): () => void {
  return () => {
    const rungateDir = join(dest, ".claude", "rungate");
    mkdirSync(rungateDir, { recursive: true });
    writeFileSync(join(rungateDir, "config.json"), JSON.stringify({
      project: "golden-project",
      ci: { runner: "ubuntu-latest", bunVersion: "latest", branches: ["main"] },
    }, null, 2) + "\n");
    writeFileSync(join(rungateDir, "roles.json"), JSON.stringify({
      marcus: {
        description: "Principal engineer — roles.json sourced",
        tools: "[Bash, Read, Write, Edit]",
        model: ROLES_CANARY_MODEL,
      },
    }, null, 2) + "\n");
  };
}
