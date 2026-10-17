/**
 * scaffold-fixture.ts — golden-project fixture setup for phase tests.
 *
 * Extracted from test/phase-0.test.ts to keep that file a thin consumer under
 * the 200-line deep-modules cap (AC-1 in the phase test conformity check).
 * The fixture mechanics live here; the test file asserts.
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { initFixtureRepo, commitFixture } from "./git-fixture";
import { readHardConstraints, type SectionReading } from "../../lib/agents-md-sections";

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
 * The file holding the scaffold write pipeline, as ONE binding.
 *
 * `scripts/scaffold-project.ts` was both the CLI and the pipeline until #398
 * split them, and six tests across four files had each hardcoded that path to
 * assert something about the pipeline — validator imports, step ordering,
 * module boundaries. When the body moved they all went red at once, and each
 * one would have been repointed by hand at a path the next move invalidates
 * again. `.claude/rules/checks-must-be-able-to-fail.md` names the shape: a
 * source-text assertion cannot notice that it has stopped describing the
 * code, so there should be one place to update when it does.
 */
export const SCAFFOLD_PIPELINE = join(import.meta.dir, "..", "..", "lib", "scaffold", "write-steps.ts");

/** The pipeline's source text. Throws rather than returning "" if it moved. */
export function scaffoldPipelineSource(): string {
  if (!existsSync(SCAFFOLD_PIPELINE))
    throw new Error(`the scaffold write pipeline is not at ${SCAFFOLD_PIPELINE} — update SCAFFOLD_PIPELINE`);
  return readFileSync(SCAFFOLD_PIPELINE, "utf-8");
}

/**
 * Canary value planted in .claude/rungate/roles.json only. It appears in no
 * default and in no other config file, so finding it in a generated brief
 * proves roles.json was actually read rather than DEFAULT_AGENT_META winning.
 */
export const ROLES_CANARY_MODEL = "canary-model-from-roles-json";

/** Copy the golden project to `dest`, optionally seed it, then scaffold it. */
export function scaffoldFixture(
  dest: string,
  seed?: () => void,
  opts: { commit?: boolean } = {},
): void {
  try { execSync(`rm -rf ${dest}`, { stdio: "pipe" }); } catch {}
  mkdirSync(dest, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${dest}/`);
  seed?.();
  // Shared helpers rather than raw git init/commit: they pin an identity so the
  // fixture does not depend on the developer's global git config (#71).
  initFixtureRepo(dest);
  commitFixture(dest, "init fixture");
  try {
    // --commit because the callers assert on the post-scaffold commit
    // (SC-99/SC-100). #216 made committing opt-in for a CONSUMER: re-scaffolding
    // is how they take an update, and the documented command may not create a
    // commit in their repo unasked. That default is covered by
    // test/unit/post-scaffold-commit.test.ts, which asserts zero commits
    // without the flag — asserting it here too would just re-run the fixture.
    //
    // It stays on by default for THIS helper, whose callers are fixtures that
    // want a committed tree. `commit: false` is for a caller that does not.
    const commit = opts.commit !== false ? " --commit" : "";
    execSync(`bun run ${SCAFFOLD} ${dest} --fix${commit}`, { timeout: 60000, encoding: "utf-8", stdio: "pipe" });
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

export interface ProseReading {
  /** Words of prose the HARNESS wrote — the subject of SC-139's 200-word cap. */
  words: number;
  /** The user-owned section excluded from the count, or null if there is none. */
  preserved: SectionReading | null;
  /** Whether that section is still in the file. Excluding it is not deleting it. */
  stillOnDisk: boolean;
}

/**
 * Count the generated prose in an AGENTS.md, excluding the one section the
 * harness does not own (#568).
 *
 * SC-139 caps AGENTS.md prose at 200 words, and the cap is about rungate's
 * verbosity. Since #568 a consumer's `## Hard Constraints` section is
 * carried forward verbatim, so counting it would mean a project with many
 * non-inferable rules fails a check about the harness — and the cheapest
 * way to pass would be to delete constraints, which is the thing #568
 * exists to stop happening.
 *
 * The exclusion goes through `readHardConstraints`, the same binding that
 * does the preserving, so there is one definition of where the section
 * ends rather than a second one here that can drift from it.
 */
export function generatedProseWords(agentsMdPath: string): ProseReading {
  const content = readFileSync(agentsMdPath, "utf-8");
  const preserved = readHardConstraints(content);
  const generated = preserved === null ? content : content.replace(preserved.text, "");
  const lines = generated
    .split("\n")
    .filter(l => !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("```") && l.trim().length > 0);
  return {
    words: lines.join(" ").split(/\s+/).filter(w => w !== "").length,
    preserved,
    stillOnDisk: preserved === null || content.includes(preserved.text),
  };
}
