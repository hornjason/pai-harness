import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { extractDirectives, extractDirectivesWithRules } from "../lib/directive-extractor.js";
import { checkCompliance, computeScore } from "../lib/transcript-checker.js";
import { createWorktree, type WorktreeConfig } from "../lib/worktree-isolation.js";
import { MAX_ITERATIONS, DEFAULT_TARGET_SCORE, buildIteration, isTargetReached, canContinue } from "../lib/hill-climb.js";

const ROOT = join(import.meta.dir, "..");

const SUPPORTED_ROLES = ["marcus", "quinn", "rook", "serena", "aditi", "discovery"] as const;

const FIXTURE_MAP: Record<string, string> = {
  marcus: "agent-marcus-impl1.jsonl",
  quinn: "agent-quinn-validate1.jsonl",
  rook: "agent-rook-scan1.jsonl",
  serena: "agent-serena-review1.jsonl",
  aditi: "agent-aditi-design1.jsonl",
  discovery: "agent-discovery-scan1.jsonl",
};

describe("test-brief-roles", () => {
  test("all 6 agent briefs exist (AC-9)", () => {
    for (const role of SUPPORTED_ROLES) {
      const briefPath = join(ROOT, ".claude/agents", `${role}.md`);
      expect(existsSync(briefPath)).toBe(true);
    }
  });

  test("supported roles count is exactly 6 (AC-9)", () => {
    expect(SUPPORTED_ROLES).toHaveLength(6);
  });

  test("each brief + rules extracts at least 3 directives", () => {
    for (const role of SUPPORTED_ROLES) {
      const briefPath = join(ROOT, ".claude/agents", `${role}.md`);
      const content = readFileSync(briefPath, "utf-8");
      const directives = extractDirectivesWithRules(content, ROOT);

      expect(directives.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("rungate.json has standardTask for all 6 roles (AC-8)", () => {
    const configPath = join(ROOT, ".claude/rungate.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    const roles = Object.keys(config.roles || {});
    expect(roles.length).toBeGreaterThanOrEqual(6);

    for (const role of SUPPORTED_ROLES) {
      expect(config.roles[role]).toBeDefined();
      expect(config.roles[role].standardTask).toBeTruthy();
    }
  });

  test("rungate.json roles have brief paths that exist", () => {
    const configPath = join(ROOT, ".claude/rungate.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    for (const [role, roleConfig] of Object.entries(config.roles as Record<string, { brief: string }>)) {
      const briefPath = join(ROOT, roleConfig.brief);
      expect(existsSync(briefPath)).toBe(true);
    }
  });

  test("marcus.md extracts >= 6 directives (AC-2)", () => {
    const content = readFileSync(join(ROOT, ".claude/agents/marcus.md"), "utf-8");
    const directives = extractDirectives(content);
    expect(directives.length).toBeGreaterThanOrEqual(6);
  });

  test("createWorktree function is available for agent isolation (AC-7)", () => {
    expect(typeof createWorktree).toBe("function");
    // Verify the config interface shape
    const config: WorktreeConfig = { projectRoot: ROOT };
    expect(config.projectRoot).toBeTruthy();
  });

  test("all 6 roles score >= 75% directive compliance (AC-6, SC-405)", () => {
    for (const role of SUPPORTED_ROLES) {
      const briefPath = join(ROOT, ".claude/agents", `${role}.md`);
      const fixturePath = join(ROOT, "test/fixtures/transcripts", FIXTURE_MAP[role]);

      expect(existsSync(fixturePath)).toBe(true);

      const briefContent = readFileSync(briefPath, "utf-8");
      const transcript = readFileSync(fixturePath, "utf-8");
      const directives = extractDirectives(briefContent);
      const results = checkCompliance(directives, transcript);
      const { score, grade } = computeScore(results);

      expect(score).toBeGreaterThanOrEqual(75);
    }
  });

  test("transcript fixtures exist for all 6 roles (AC-6)", () => {
    for (const role of SUPPORTED_ROLES) {
      const fixturePath = join(ROOT, "test/fixtures/transcripts", FIXTURE_MAP[role]);
      expect(existsSync(fixturePath)).toBe(true);
    }
  });

  test("hill climb infrastructure is wired: MAX_ITERATIONS, buildIteration, isTargetReached, canContinue (AC-5, SC-404)", () => {
    expect(MAX_ITERATIONS).toBe(5);
    expect(DEFAULT_TARGET_SCORE).toBe(80);
    expect(typeof buildIteration).toBe("function");
    expect(typeof isTargetReached).toBe("function");
    expect(typeof canContinue).toBe("function");

    // Verify hill climb logic works end-to-end
    const briefContent = readFileSync(join(ROOT, ".claude/agents/marcus.md"), "utf-8");
    const transcript = readFileSync(join(ROOT, "test/fixtures/transcripts/agent-marcus-impl1.jsonl"), "utf-8");
    const directives = extractDirectives(briefContent);
    const results = checkCompliance(directives, transcript);
    const iteration = buildIteration(1, results);

    expect(iteration.iteration).toBe(1);
    expect(iteration.score).toBeGreaterThanOrEqual(80);
    expect(isTargetReached(iteration.score, 80)).toBe(true);
    expect(canContinue(1)).toBe(true);
    expect(canContinue(5)).toBe(false);
  });

  test("ship.js contains preflightScore gate that halts below 80% (SC-407)", () => {
    const shipContent = readFileSync(join(ROOT, "workflows/ship.js"), "utf-8");
    // Must contain a preflightScore function or gate
    expect(shipContent).toMatch(/preflightScore/);
    // Must contain score threshold check at 80
    expect(shipContent).toMatch(/score.*<.*80/);
    // Must contain halt/stop logic for compliance failure
    expect(shipContent).toMatch(/briefCompliance.*halt|HALT.*compliance|compliance.*FATAL/i);
  });

  test("test-brief uses standardTask from config as default task from role config (SC-408)", () => {
    const scriptContent = readFileSync(join(ROOT, "scripts/test-brief.ts"), "utf-8");
    // The script should use standardTask as fallback when no task arg is provided
    expect(scriptContent).toContain("standardTask");
    // The old guard `if (!role || !task)` should be replaced with just `if (!role)`
    // because task now falls back to standardTask from config
    expect(scriptContent).not.toMatch(/if\s*\(\s*!role\s*\|\|\s*!task\s*\)/);
    // Should contain fallback logic that reads standardTask from roleConfig
    expect(scriptContent).toMatch(/roleConfig.*standardTask|standardTask.*fallback|task\s*=\s*.*standardTask/);
  });
});
