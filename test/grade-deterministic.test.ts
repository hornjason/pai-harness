import { describe, test, expect } from "bun:test";
import { join } from "path";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { gradeTranscript, loadValidRoles, loadRoleBriefPaths } from "../scripts/grade-deterministic.js";
import type { GradeOutput } from "../scripts/grade-deterministic.js";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "transcripts");

describe("grade-deterministic", () => {
  const validRoles = loadValidRoles(join(import.meta.dir, ".."));

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

  describe("role filtering", () => {
    test("loadValidRoles reads roles from rungate.json", () => {
      const roles = loadValidRoles(join(import.meta.dir, ".."));
      expect(roles.has("marcus")).toBe(true);
      expect(roles.has("quinn")).toBe(true);
      expect(roles.has("discovery")).toBe(true);
    });

    test("inferRole returns null for unknown agent type", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-nonexistent-session.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles);
      expect(result).toBeNull();
    });

    test("loadRoleBriefPaths returns brief paths from rungate.json", () => {
      const PROJECT_ROOT = join(import.meta.dir, "..");
      const paths = loadRoleBriefPaths(PROJECT_ROOT);
      expect(paths["marcus"]).toBeDefined();
      expect(paths["marcus"]).toContain(".claude/agents/marcus.md");
    });
  });

  describe("directive-based grading", () => {
    const PROJECT_ROOT = join(import.meta.dir, "..");

    test("gradeTranscript with projectRoot produces DIR- prefixed rules from extractDirectives", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles, PROJECT_ROOT);

      expect(result).not.toBeNull();
      expect(result!.role).toBe("marcus");
      // Should have directive-based rules with DIR-L prefix
      const dirRules = result!.rules.filter(r => r.id.startsWith("DIR-L"));
      expect(dirRules.length).toBeGreaterThan(0);
    });

    test("directive-based rules include category (quality|process)", () => {
      const transcriptPath = join(FIXTURE_DIR, "agent-marcus-impl1.jsonl");
      const result = gradeTranscript(transcriptPath, validRoles, PROJECT_ROOT);

      expect(result).not.toBeNull();
      const dirRules = result!.rules.filter(r => r.id.startsWith("DIR-L"));
      expect(dirRules.length).toBeGreaterThan(0);
      for (const rule of dirRules) {
        expect(rule.category).toBeDefined();
        expect(["quality", "process"]).toContain(rule.category);
      }
    });
  });

  describe("CLI integration", () => {
    test("--transcripts flag produces non-empty grades with correct roles", async () => {
      const workDir = await import("os").then(os => {
        const tmpdir = os.tmpdir();
        const dir = join(tmpdir, `grade-test-${Date.now()}`);
        import("fs").then(fs => fs.mkdirSync(dir, { recursive: true }));
        return dir;
      });
      // Ensure workDir exists
      const { mkdirSync, readFileSync } = await import("fs");
      mkdirSync(workDir, { recursive: true });

      const proc = Bun.spawnSync([
        "bun", "scripts/grade-deterministic.ts",
        "--transcripts", FIXTURE_DIR,
        "--project", join(import.meta.dir, ".."),
        workDir,
      ], { cwd: join(import.meta.dir, "..") });

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
      const { rmSync } = await import("fs");
      rmSync(workDir, { recursive: true, force: true });
    });
  });
});
