import { describe, test, expect } from "bun:test";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { gradeTranscript, loadValidRoles, loadRoleBriefPaths, inferRole } from "../scripts/grade-deterministic.js";
import type { GradeOutput } from "../scripts/grade-deterministic.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "transcripts");
const PROJECT_ROOT = join(import.meta.dir, "..");

describe("grade-deterministic", () => {
  const validRoles = loadValidRoles(PROJECT_ROOT);

  describe("gradeTranscript", () => {
    test("grades marcus transcript with correct role and non-empty rules", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles);

      expect(result).not.toBeNull();
      expect(result!.role).toBe("marcus");
      expect(result!.total).toBeGreaterThan(0);
      expect(result!.rules.length).toBeGreaterThan(0);
      // Marcus should have COMP-13 (TDD check) in rules
      expect(result!.rules.some(r => r.id === "COMP-13")).toBe(true);
    });

    test("grades quinn transcript with correct role", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-quinn-validate1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles);

      expect(result).not.toBeNull();
      expect(result!.role).toBe("quinn");
      expect(result!.total).toBeGreaterThan(0);
      expect(result!.followed).toBeGreaterThan(0);
      // Quinn should have Q-01 (bun test) rule
      expect(result!.rules.some(r => r.id === "Q-01")).toBe(true);
    });

    test("returns null for transcript with no matching role", () => {
      // Create a path that would have no valid meta.json or unrecognized role
      const transcriptPath = join(FIXTURE_DIR, "agent-nonexistent-session.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles);
      expect(result).toBeNull();
    });

    test("includes efficiency metrics", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles);

      expect(result).not.toBeNull();
      expect(result!.efficiency).toBeDefined();
      expect(typeof result!.efficiency!.ratio).toBe("number");
      expect(typeof result!.efficiency!.deliverableRatio).toBe("number");
      expect(typeof result!.efficiency!.contextGrowthRatio).toBe("number");
      expect(typeof result!.efficiency!.duplicateReads).toBe("number");
    });
  });

  // ── AC-3: Unmatched agents return null and are skipped ──
  describe("unmatched agent filtering", () => {
    test("returns null for agent with unrecognized agentType in meta", () => {
      // Create a temp transcript+meta with unknown agentType
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_unmatched");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const transcriptPath = join(tmpDir, "agent-utility-helper1.jsonl");
        const metaPath = join(tmpDir, "agent-utility-helper1.meta.json");
        writeFileSync(transcriptPath, '{"type":"user","content":"hello"}\n');
        writeFileSync(metaPath, JSON.stringify({ agentType: "utility-helper", description: "A helper agent" }));

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("returns null for agent whose label does not match any valid role", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_unknown_label");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const transcriptPath = join(tmpDir, "agent-research-scan1.jsonl");
        const metaPath = join(tmpDir, "agent-research-scan1.meta.json");
        writeFileSync(transcriptPath, '{"type":"user","content":"scan code"}\n');
        writeFileSync(metaPath, JSON.stringify({ label: "research-assistant", description: "Research scan" }));

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ── AC-6: Role filtering with loadValidRoles and inferRole ──
  describe("role filtering", () => {
    test("loadValidRoles returns roles from rungate.json config", () => {
      const roles = loadValidRoles(PROJECT_ROOT);
      expect(roles.has("marcus")).toBe(true);
      expect(roles.has("quinn")).toBe(true);
      expect(roles.has("discovery")).toBe(true);
      expect(roles.has("rook")).toBe(true);
      // Should NOT have fabricated roles
      expect(roles.has("nonexistent-role")).toBe(false);
    });

    test("inferRole matches agentType field from meta.json", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_infer_match");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));
        writeFileSync(transcriptPath, "");

        const role = inferRole(metaPath, transcriptPath, validRoles);
        expect(role).toBe("marcus");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("inferRole returns null for unrecognized agentType", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_infer_null");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "random-agent-42" }));
        writeFileSync(transcriptPath, "");

        const role = inferRole(metaPath, transcriptPath, validRoles);
        expect(role).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("inferRole skips agents without meta.json", () => {
      const role = inferRole("/nonexistent/path.meta.json", "/nonexistent/path.jsonl", validRoles);
      expect(role).toBeNull();
    });
  });

  // ── AC-4 + AC-7: Directive-based grading from brief ──
  describe("directive-based grading", () => {
    test("gradeTranscript with projectRoot produces rules derived from extractDirectives", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles, PROJECT_ROOT);

      expect(result).not.toBeNull();
      expect(result!.role).toBe("marcus");
      // Should have directive-derived rules (IDs start with DIR-)
      const directiveRules = result!.rules.filter(r => r.id.startsWith("DIR-"));
      expect(directiveRules.length).toBeGreaterThan(0);
    });

    test("directive-based rules include category from brief directives", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles, PROJECT_ROOT);

      expect(result).not.toBeNull();
      const directiveRules = result!.rules.filter(r => r.id.startsWith("DIR-"));
      expect(directiveRules.length).toBeGreaterThan(0);

      // Every directive-derived rule should have a category
      for (const rule of directiveRules) {
        expect(rule.category).toBeDefined();
        expect(rule.category).toBeOneOf(["quality", "process"]);
      }
    });

    test("loadRoleBriefPaths returns brief paths from rungate.json", () => {
      const briefPaths = loadRoleBriefPaths(PROJECT_ROOT);
      expect(briefPaths["marcus"]).toBeDefined();
      expect(briefPaths["marcus"]).toContain("marcus.md");
      expect(briefPaths["quinn"]).toBeDefined();
      expect(briefPaths["quinn"]).toContain("quinn.md");
    });
  });

  // ── AC-5: RuleResult includes category field ──
  describe("category in rule results", () => {
    test("graded rules with projectRoot include category typed as quality or process", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles, PROJECT_ROOT);

      expect(result).not.toBeNull();
      // At least some rules should have category set
      const rulesWithCategory = result!.rules.filter(r => r.category !== undefined);
      expect(rulesWithCategory.length).toBeGreaterThan(0);

      for (const rule of rulesWithCategory) {
        expect(rule.category).toBeOneOf(["quality", "process"]);
      }
    });
  });

  describe("CLI integration", () => {
    test("--transcripts flag produces non-empty grades with correct roles", async () => {
      const { tmpdir } = await import("os");
      const workDir = join(tmpdir(), `grade-test-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      const proc = Bun.spawnSync([
        "bun", "scripts/grade-deterministic.ts",
        "--transcripts", FIXTURE_DIR,
        "--project", PROJECT_ROOT,
        workDir,
      ], { cwd: PROJECT_ROOT });

      expect(proc.exitCode).toBe(0);

      const outputPath = join(workDir, "compliance-grade.json");
      const output: GradeOutput = JSON.parse(readFileSync(outputPath, "utf-8"));

      expect(output.grades.length).toBeGreaterThan(0);

      const marcusGrade = output.grades.find(g => g.role === "marcus");
      expect(marcusGrade).toBeDefined();
      expect(marcusGrade!.total).toBeGreaterThan(0);
      expect(marcusGrade!.rules.length).toBeGreaterThan(0);

      const quinnGrade = output.grades.find(g => g.role === "quinn");
      expect(quinnGrade).toBeDefined();
      expect(quinnGrade!.total).toBeGreaterThan(0);

      // Cleanup
      rmSync(workDir, { recursive: true, force: true });
    });
  });

  describe("COMP-13 TDD N/A for non-code tasks", () => {
    test("COMP-13 returns N/A when no test or source files written", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp13_na");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Update config file" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/path/config.json" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp13 = result!.rules.find(r => r.id === "COMP-13");
        expect(comp13).toBeDefined();
        expect(comp13!.verdict).toBe("N/A");
        expect(comp13!.evidence).toContain("No test files written");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("COMP-13 returns N/A when only test files written (NO_SOURCE)", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp13_nosource");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Write tests" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/test/foo.test.ts" } },
          ] } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Bash", input: { command: "bun test test/foo.test.ts" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp13 = result!.rules.find(r => r.id === "COMP-13");
        expect(comp13).toBeDefined();
        expect(comp13!.verdict).toBe("N/A");
        expect(comp13!.evidence).toContain("No source files written");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("COMP-13 returns IGNORED for TEST_AFTER (source before test)", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp13_testafter");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Implement feature" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/feature.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/test/feature.test.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "bun test test/feature.test.ts" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp13 = result!.rules.find(r => r.id === "COMP-13");
        expect(comp13).toBeDefined();
        expect(comp13!.verdict).toBe("IGNORED");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("COMP-13 N/A verdicts are excluded from total score", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp13_scoring");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Update config" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Edit", input: { file_path: "/path/config.json" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp13 = result!.rules.find(r => r.id === "COMP-13");
        expect(comp13!.verdict).toBe("N/A");
        // N/A rules should not count toward total
        const checkableRules = result!.rules.filter(r => r.verdict !== "N/A");
        expect(result!.total).toBe(checkableRules.length);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("COMP-8 injection detection", () => {
    test("COMP-8 FOLLOWED when PROJECT-STATE injected in prompt", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp8_inject");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Implement feature X" } }),
          JSON.stringify({ type: "user", message: { content: "### PROJECT-STATE.md\nCurrent phase: All phases complete\nSuite: 1866+ pass" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/a.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/b.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/c.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/d.ts" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp8 = result!.rules.find(r => r.id === "COMP-8");
        expect(comp8).toBeDefined();
        expect(comp8!.verdict).toBe("FOLLOWED");
        expect(comp8!.evidence).toContain("injected");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("COMP-8 IGNORED when neither read nor injected on multi-file task", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp8_missing");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "Implement feature X" } }),
          JSON.stringify({ type: "assistant", message: { content: [
            { type: "tool_use", name: "Read", input: { file_path: "/path/AGENTS.md" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/a.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/b.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/c.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "/path/lib/d.ts" } },
          ] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp8 = result!.rules.find(r => r.id === "COMP-8");
        expect(comp8).toBeDefined();
        expect(comp8!.verdict).toBe("IGNORED");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("COMP-1 injection detection", () => {
    test("detects AGENTS.md in second user message (workflow relay pattern)", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp1_inject");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "[Workflow relay] user request" } }),
          JSON.stringify({ type: "user", message: { content: "### AGENTS.md (from /path/AGENTS.md)\nProject rules here" } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/path/marcus.md" } }] } }),
          JSON.stringify({ type: "tool_result", content: "brief content" }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp1 = result!.rules.find(r => r.id === "COMP-1");
        expect(comp1).toBeDefined();
        expect(comp1!.verdict).toBe("FOLLOWED");
        expect(comp1!.evidence).toContain("injected");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("fails COMP-1 when AGENTS.md not in any user message", () => {
      const tmpDir = join(import.meta.dir, "fixtures", "transcripts", "_tmp_comp1_missing");
      mkdirSync(tmpDir, { recursive: true });
      try {
        const metaPath = join(tmpDir, "agent-test.meta.json");
        const transcriptPath = join(tmpDir, "agent-test.jsonl");
        writeFileSync(metaPath, JSON.stringify({ agentType: "marcus" }));

        const transcript = [
          JSON.stringify({ type: "user", message: { content: "[Workflow relay] user request" } }),
          JSON.stringify({ type: "user", message: { content: "Just do the task" } }),
          JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/path/marcus.md" } }] } }),
        ].join("\n");
        writeFileSync(transcriptPath, transcript);

        const result = gradeTranscript(transcriptPath, validRoles);
        expect(result).not.toBeNull();

        const comp1 = result!.rules.find(r => r.id === "COMP-1");
        expect(comp1).toBeDefined();
        expect(comp1!.verdict).toBe("IGNORED");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
