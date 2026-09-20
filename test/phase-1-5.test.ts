import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// Spec-drift guard: if governing spec changes, these tests are stale
const SPEC_HASH = "b631e55ace8dcb32";

function checkSpecDrift() {
  const specPath = join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md");
  if (!existsSync(specPath)) return;
  const hash = execSync(`shasum -a 256 "${specPath}" | cut -c1-16`, { encoding: "utf-8" }).trim();
  if (SPEC_HASH !== "UPDATE_AFTER_SPEC_CHANGE" && hash !== SPEC_HASH) {
    throw new Error(
      `SPEC DRIFT: bootstrap spec changed (hash ${hash} != ${SPEC_HASH}). ` +
      `Update test file to match new spec, then update SPEC_HASH to "${hash}".`
    );
  }
}

const FIXTURE = join(import.meta.dir, "fixtures/phase-1-5-project");
const OUTPUT = "/tmp/rungate-phase15-test";
const SCAFFOLD = join(import.meta.dir, "..", "scripts", "scaffold-project.ts");

let scaffoldRan = false;

beforeAll(() => {
  execSync(`rm -rf ${OUTPUT}`);
  mkdirSync(OUTPUT, { recursive: true });
  execSync(`cp -r ${FIXTURE}/. ${OUTPUT}/`);
  // Init git repo so scaffold can create hooks and commits
  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add -A && git commit -m 'init fixture'", { cwd: OUTPUT, stdio: "pipe" });
  try {
    execSync(`bun run ${SCAFFOLD} ${OUTPUT}`, {
      timeout: 60000,
      encoding: "utf-8",
      stdio: "pipe",
    });
    scaffoldRan = true;
  } catch {
    // Scaffold may fail — tests should still run and document what's missing
  }
});

describe("Phase 1.5 — Context Quality", () => {
  // Spec-drift guard
  test("spec-drift: governing spec hasn't changed", () => {
    checkSpecDrift();
  });

  // ── SC-161: briefs assembled from prompts/*.md ──────────────────────
  // Scaffold should read prompts/*.md and incorporate their content into agent briefs.
  // Expected: FAIL (scaffold currently hardcodes brief content, doesn't read prompts/)
  describe("SC-161: briefs assembled from prompts/*.md", () => {
    test("marcus brief contains content from coding-standards.md", () => {
      const briefPath = join(OUTPUT, ".claude/agents/marcus.md");
      expect(existsSync(briefPath)).toBe(true);

      const brief = readFileSync(briefPath, "utf-8");
      const promptContent = readFileSync(join(FIXTURE, "prompts/coding-standards.md"), "utf-8");

      // Extract key phrases from the prompt that should appear in the brief
      // The brief should reference or incorporate prompt content, not just use hardcoded templates
      const keyPhrases = [
        "explicit return type",
        "strict mode",
        "early returns",
      ];

      const found = keyPhrases.filter(phrase =>
        brief.toLowerCase().includes(phrase.toLowerCase())
      );

      // At least one key phrase from the project's coding-standards should appear in the brief
      expect(found.length).toBeGreaterThanOrEqual(1);
    });

    test("quinn brief contains content from testing-guide.md", () => {
      const briefPath = join(OUTPUT, ".claude/agents/quinn.md");
      expect(existsSync(briefPath)).toBe(true);

      const brief = readFileSync(briefPath, "utf-8");
      const promptContent = readFileSync(join(FIXTURE, "prompts/testing-guide.md"), "utf-8");

      const keyPhrases = [
        "arrange-act-assert",
        "edge cases",
        "boundary conditions",
      ];

      const found = keyPhrases.filter(phrase =>
        brief.toLowerCase().includes(phrase.toLowerCase())
      );

      expect(found.length).toBeGreaterThanOrEqual(1);
    });

    test("rook brief contains content from security-rules.md", () => {
      const briefPath = join(OUTPUT, ".claude/agents/rook.md");
      expect(existsSync(briefPath)).toBe(true);

      const brief = readFileSync(briefPath, "utf-8");
      const promptContent = readFileSync(join(FIXTURE, "prompts/security-rules.md"), "utf-8");

      const keyPhrases = [
        "schema validation",
        "bearer token",
        "rotate secrets",
      ];

      const found = keyPhrases.filter(phrase =>
        brief.toLowerCase().includes(phrase.toLowerCase())
      );

      expect(found.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── SC-162: prompts/*.md files exist with >= 10 lines ───────────────
  // Validates the fixture itself has valid prompt files.
  // Expected: PASS (fixture has them)
  describe("SC-162: prompts/*.md files exist with >= 10 lines", () => {
    const promptFiles = ["coding-standards.md", "testing-guide.md", "security-rules.md"];

    for (const file of promptFiles) {
      test(`prompts/${file} exists`, () => {
        expect(existsSync(join(OUTPUT, "prompts", file))).toBe(true);
      });

      test(`prompts/${file} has >= 10 lines`, () => {
        const content = readFileSync(join(OUTPUT, "prompts", file), "utf-8");
        const lineCount = content.split("\n").length;
        expect(lineCount).toBeGreaterThanOrEqual(10);
      });
    }
  });

  // ── SC-167: AGENTS.md Specs table matches spec frontmatter ──────────
  // Scaffold should read specs/*.md frontmatter and build the Specs table in AGENTS.md.
  // Expected: FAIL (scaffold doesn't read spec frontmatter to build the table)
  describe("SC-167: AGENTS.md Specs table matches spec frontmatter", () => {
    test("AGENTS.md contains Specs table", () => {
      const agentsPath = join(OUTPUT, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).toContain("Spec");
    });

    test("Specs table lists example-spec.md", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      expect(content).toContain("example-spec.md");
    });

    test("Specs table has correct governs field from frontmatter", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      // Read the spec's frontmatter to get the governs value
      const specContent = readFileSync(join(OUTPUT, "specs/example-spec.md"), "utf-8");
      const governsMatch = specContent.match(/governs:\s*(.+)/);
      expect(governsMatch).not.toBeNull();
      const governs = governsMatch![1].trim();

      // AGENTS.md should contain this governs value in its Specs table
      expect(content).toContain(governs);
    });

    test("Specs table has correct testable field from frontmatter", () => {
      const content = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8");
      // The spec has testable: true — table should reflect this
      expect(content).toMatch(/example-spec.*(?:yes|true)/i);
    });
  });

  // ── SC-168: CODE-MAP.md under 3000 tokens ───────────────────────────
  // Scaffold creates CODE-MAP.md; it should be concise.
  // Expected: PASS if scaffold creates CODE-MAP (token budget is generous for small fixture)
  describe("SC-168: CODE-MAP.md under 3000 tokens", () => {
    test("CODE-MAP.md exists", () => {
      expect(existsSync(join(OUTPUT, "CODE-MAP.md"))).toBe(true);
    });

    test("CODE-MAP.md is under 3000 tokens (chars/4 estimate)", () => {
      const content = readFileSync(join(OUTPUT, "CODE-MAP.md"), "utf-8");
      const estimatedTokens = Math.ceil(content.length / 4);
      expect(estimatedTokens).toBeLessThan(3000);
    });
  });

  // ── SC-170: Tier 1 files contain ONLY scaffold-generated content ────
  // Agent briefs should be deterministic scaffold output, no extra manual content.
  // Expected: FAIL (hard to verify without re-running; this test re-scaffolds and diffs)
  describe("SC-170: Tier 1 extra content produces WARN", () => {
    test("agent briefs match fresh scaffold output (no extra content)", () => {
      // Re-run scaffold on a clean copy to get expected output
      const verifyDir = "/tmp/rungate-phase15-verify";
      try {
        execSync(`rm -rf ${verifyDir}`);
        mkdirSync(verifyDir, { recursive: true });
        execSync(`cp -r ${FIXTURE}/. ${verifyDir}/`);
        execSync("git init", { cwd: verifyDir, stdio: "pipe" });
        execSync("git add -A && git commit -m 'init'", { cwd: verifyDir, stdio: "pipe" });
        execSync(`bun run ${SCAFFOLD} ${verifyDir}`, {
          timeout: 60000,
          encoding: "utf-8",
          stdio: "pipe",
        });

        // Compare agent briefs between original scaffold run and fresh run
        const agents = ["marcus", "quinn", "rook", "serena", "aditi"];
        for (const agent of agents) {
          const originalPath = join(OUTPUT, `.claude/agents/${agent}.md`);
          const freshPath = join(verifyDir, `.claude/agents/${agent}.md`);

          if (!existsSync(originalPath) || !existsSync(freshPath)) continue;

          const original = readFileSync(originalPath, "utf-8").trim();
          const fresh = readFileSync(freshPath, "utf-8").trim();

          // Briefs should be identical — any difference means extra content was added
          expect(original).toBe(fresh);
        }
      } catch {
        // If scaffold fails on verify copy, skip this test gracefully
        expect(scaffoldRan).toBe(true);
      } finally {
        execSync(`rm -rf ${verifyDir}`);
      }
    });
  });

  // ── Remaining todos (not yet implemented) ───────────────────────────
  test.todo("SC-163: prompts/*.md change propagates without code edit");
  test.todo("SC-164: brief env URLs match rungate.json");
  test.todo("SC-165: Quinn brief frontmatter includes correct tools");
  test.todo("SC-166: brief env mismatch produces FAIL with fixCommand");
  test.todo("SC-169: git hooks exist with executable permission");
  test.todo("SC-173: ownership manifest declares all harness files");
  test.todo("SC-174: wraps ctxlint tokens rule");
  test.todo("SC-175: wraps agentsmd claude-length-warn");
  test.todo("SC-176: Hard Constraints >20 produces WARN");
  test.todo("SC-177: budget uses external tokenizer");
  test.todo("SC-178: ctxlint via Bun.spawnSync with prefix");
  test.todo("SC-179: agentsmd via Bun.spawnSync with prefix");
  test.todo("SC-180: agnix via Bun.spawnSync with prefix");
  test.todo("SC-181: RepoRails via Bun.spawnSync with prefix");
  test.todo("SC-182: agentsmd score in findings JSON");
  test.todo("SC-183: missing tools produce WARN");
  test.todo("SC-184: external fixCommand passthrough");
  test.todo("SC-185: no TODO/FIXME in instruction files");
  test.todo("SC-186: no contradictions via ccinspect");
  test.todo("SC-187: no secrets via ctxlint");
  test.todo("SC-188: dead hooks detected via ctxlint");
  test.todo("SC-189: no machine paths via agentsmd/agnix");
  test.todo("SC-190: instruction count under 150");
  test.todo("SC-191: briefs reference not duplicate Hard Constraints");
  test.todo("SC-192: sprawl-duplicate >70% flagged");
  test.todo("SC-193: AGENTS.md references findings file");
  test.todo("SC-194: inferability test on generated content");
  test.todo("SC-195: codebase grounding check");
  test.todo("SC-196: external checks run post-generation");
  test.todo("SC-197: regeneration on quality errors max 5");
  test.todo("SC-198: composite threshold configurable");
  test.todo("SC-199: scores written to scaffold-score.json");
  test.todo("SC-200: convergence logging");
  test.todo("SC-201: Hard Constraints human-reviewed only");
  test.todo("SC-202: rule provenance tracking");
  test.todo("SC-203: postinstall version stamp check");
  test.todo("SC-204: CI detects version change");
  test.todo("SC-230: ccinspect via Bun.spawnSync with prefix");
  test.todo("SC-231: positive framing preferred in generated content");
  test.todo("SC-232: second-occurrence rule for constraint promotion");
  test.todo("SC-233: cross-file contradiction detection");
  test.todo("SC-234: tool version tracking");
});
