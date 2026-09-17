import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TEST_BASE = `/tmp/brief-asm-test-${process.pid}`;
const TEST_SLUG = `brief-test-${process.pid}`;
const WORK_DIR = join(TEST_BASE, TEST_SLUG);
const SF = join(WORK_DIR, "workflow-state.json");
const PROJECT_ROOT = join(TEST_BASE, "project");

function minimalState(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    issue: 9999,
    repo: "test/repo",
    issueRepo: "test/repo",
    projectRoot: PROJECT_ROOT,
    slug: TEST_SLUG,
    phase: "BUILD",
    issueGoal: "Implement the brief assembler module for deterministic Marcus brief generation",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "brief-assembler.ts exports assembleBrief function with correct signature",
        threshold: { op: "contains", value: "assembleBrief", unit: "export" },
        evidenceMethod: { type: "grep", command: "grep 'export.*assembleBrief' gates/brief-assembler.ts" },
        evidence: null,
        verdict: "PENDING",
      },
      {
        id: "AC-2",
        type: "CODE",
        statement: "Generated brief includes Goal, ACs, Files, Scope, and Verify sections",
        threshold: { op: ">=", value: 5, unit: "sections" },
        evidenceMethod: { type: "grep", command: "grep -c '## ' /tmp/brief.md" },
        evidence: null,
        verdict: "PENDING",
        contextFiles: [
          { path: "gates/brief-assembler.ts", reason: "implementation" },
          { path: "gates/orchestrator.ts", reason: "state management" },
        ],
      },
    ],
    gates: {},
    changelog: [],
    governingSpec: {
      path: "/tmp/test-spec.md",
      detectedFrom: "test",
    },
    ...overrides,
  };
}

function createState(overrides: Record<string, any> = {}): void {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(SF, JSON.stringify(minimalState(overrides), null, 2));
}

function setupProjectRoot(): void {
  mkdirSync(join(PROJECT_ROOT, ".claude"), { recursive: true });
  writeFileSync(
    join(PROJECT_ROOT, ".claude", "project-harness.json"),
    JSON.stringify({
      project: "TestProject",
      dev: { apiBase: "http://localhost:7778", start: "make dev-all" },
      test: { apiBase: "http://localhost:7776" },
      prod: { apiBase: "http://localhost:7777" },
    }),
  );
}

import { assembleBrief, type AssembleResult } from "./brief-assembler";

describe("brief-assembler", () => {
  beforeEach(() => {
    mkdirSync(WORK_DIR, { recursive: true });
    setupProjectRoot();
  });

  afterEach(() => {
    try { rmSync(TEST_BASE, { recursive: true, force: true }); } catch {}
  });

  describe("assembleBrief", () => {
    test("generates brief with all required sections", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.validated).toBe(true);
      expect(result.acCount).toBe(2);
      expect(existsSync(result.briefPath)).toBe(true);

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("## Context");
      expect(brief).toContain("## Task");
      expect(brief).toContain("## Scope");
      expect(brief).toContain("## Verify");
    });

    test("includes issue goal in task section", async () => {
      createState({ issueGoal: "Fix the widget rendering bug in customer detail view" });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("Fix the widget rendering bug in customer detail view");
    });

    test("includes ACs with thresholds", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("AC-1");
      expect(brief).toContain("AC-2");
      expect(brief).toContain("assembleBrief");
    });

    test("deduplicates context files in Files section", async () => {
      createState({
        acs: [
          {
            id: "AC-1", type: "CODE",
            statement: "First criterion with context files for testing dedup",
            threshold: { op: "contains", value: "foo" },
            evidenceMethod: { type: "grep", command: "grep foo bar" },
            evidence: null, verdict: "PENDING",
            contextFiles: [
              { path: "gates/orchestrator.ts", reason: "state" },
              { path: "gates/schema.ts", reason: "types" },
            ],
          },
          {
            id: "AC-2", type: "CODE",
            statement: "Second criterion sharing context file for dedup test",
            threshold: { op: "contains", value: "bar" },
            evidenceMethod: { type: "grep", command: "grep bar baz" },
            evidence: null, verdict: "PENDING",
            contextFiles: [
              { path: "gates/orchestrator.ts", reason: "state again" },
              { path: "gates/run-gate.ts", reason: "runner" },
            ],
          },
        ],
      });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.contextFileCount).toBe(3);
      const brief = readFileSync(result.briefPath, "utf-8");
      const orchestratorMatches = brief.match(/gates\/orchestrator\.ts/g);
      expect(orchestratorMatches).toHaveLength(1);
    });

    test("includes governing spec in Spec Alignment section", async () => {
      createState({
        governingSpec: {
          path: "/Users/test/specs/MY-SPEC.md",
          detectedFrom: "discovery",
        },
      });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("Spec Alignment");
      expect(brief).toContain("MY-SPEC.md");
    });

    test("includes verify commands from AC evidence methods", async () => {
      createState({
        acs: [
          {
            id: "AC-1", type: "CODE",
            statement: "Verify command appears in brief for validation purposes",
            threshold: { op: "contains", value: "PASS" },
            evidenceMethod: { type: "command", command: "bun test --isolate gates/self-heal.test.ts" },
            evidence: null, verdict: "PENDING",
          },
        ],
      });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("bun test --isolate gates/self-heal.test.ts");
    });

    test("writes brief to workDir/marcus-brief.md", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.briefPath).toBe(join(WORK_DIR, "marcus-brief.md"));
    });

    test("handles missing governingSpec gracefully", async () => {
      createState({ governingSpec: undefined });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.validated).toBe(true);
      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("## Context");
    });

    test("handles empty ACs array", async () => {
      createState({ acs: [] });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.acCount).toBe(0);
      expect(result.validated).toBe(true);
    });

    test("handles missing workflow-state.json", async () => {
      await expect(
        assembleBrief({
          slug: TEST_SLUG,
          workDir: "/tmp/nonexistent-dir-xyz",
          projectRoot: PROJECT_ROOT,
        }),
      ).rejects.toThrow(/workflow-state\.json/i);
    });

    test("includes git protocol section with issue number", async () => {
      createState({ issue: 1372 });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("Git protocol");
      expect(brief).toContain("1372");
    });

    test("includes scope-out boundaries when available", async () => {
      createState({
        scopeOut: ["gates/run-gate.ts", "gates/orchestrator.ts", "src/"],
      });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("gates/run-gate.ts");
      expect(brief).toContain("do NOT touch");
    });

    test("validates brief against policy patterns", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      expect(result.validated).toBe(true);
    });

    test("AC-1: includes AGENTS.md from projectRoot when present", async () => {
      writeFileSync(
        join(PROJECT_ROOT, "AGENTS.md"),
        "# Agents\n\n## Marcus Webb\nSenior engineer\n\n## Quinn Torres\nQA lead\n",
      );
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("AGENTS.md");
      expect(brief).toContain("## Context");
    });

    test("AC-1: omits AGENTS.md reference when file does not exist", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).not.toContain("AGENTS.md");
    });

    test("AC-2: includes contextDocs from project-harness.json (array form)", async () => {
      writeFileSync(
        join(PROJECT_ROOT, ".claude", "project-harness.json"),
        JSON.stringify({
          project: "TestProject",
          contextDocs: ["HARNESS.md", "DESIGN.md"],
        }),
      );
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("HARNESS.md");
      expect(brief).toContain("DESIGN.md");
      expect(result.contextFileCount).toBeGreaterThanOrEqual(2);
    });

    test("AC-2: includes contextDocs from project-harness.json (object form)", async () => {
      writeFileSync(
        join(PROJECT_ROOT, ".claude", "project-harness.json"),
        JSON.stringify({
          project: "TestProject",
          contextDocs: {
            routing: "DOCS.md",
            model: "MODEL.md",
            architecture: "ARCHITECTURE.md",
          },
        }),
      );
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).toContain("DOCS.md");
      expect(brief).toContain("MODEL.md");
      expect(brief).toContain("ARCHITECTURE.md");
    });

    test("AC-3: no hardcoded harness-owned template paths in context", async () => {
      createState();

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      expect(brief).not.toContain("MarcusContext.md");
      expect(brief).not.toContain("MarcusChecklist.md");
    });

    test("AC-4: produces >= 5 sections from structured data only", async () => {
      writeFileSync(
        join(PROJECT_ROOT, "AGENTS.md"),
        "# Agents\n## Marcus Webb\nSenior engineer\n",
      );
      writeFileSync(
        join(PROJECT_ROOT, ".claude", "project-harness.json"),
        JSON.stringify({
          project: "TestProject",
          contextDocs: ["HARNESS.md"],
        }),
      );
      createState({
        governingSpec: { path: "/tmp/spec.md", detectedFrom: "test" },
        scopeOut: ["src/secret.ts"],
      });

      const result = await assembleBrief({
        slug: TEST_SLUG,
        workDir: WORK_DIR,
        projectRoot: PROJECT_ROOT,
      });

      const brief = readFileSync(result.briefPath, "utf-8");
      const sectionHeaders = brief.match(/^## /gm) || [];
      expect(sectionHeaders.length).toBeGreaterThanOrEqual(5);
      expect(result.validated).toBe(true);
    });
  });
});
