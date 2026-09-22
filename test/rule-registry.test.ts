import { describe, test, expect } from "bun:test";
import { join } from "path";
import { loadRules, getRulesForRole, getRulesForTier } from "../lib/rule-registry.js";

const ROOT = join(import.meta.dir, "..");

describe("rule-registry", () => {
  test("loadRules returns Rule objects with all required fields", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    expect(rules.length).toBeGreaterThan(0);

    const r = rules[0];
    expect(typeof r.id).toBe("string");
    expect(typeof r.text).toBe("string");
    expect(typeof r.type).toBe("string");
    expect(typeof r.tier).toBe("string");
    expect(typeof r.section).toBe("string");
    expect(typeof r.source).toBe("string");
    expect(typeof r.line).toBe("number");
  });

  test("Never Do rules are identity tier", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    const neverRules = rules.filter((r) => r.type === "never");
    expect(neverRules.length).toBeGreaterThan(0);
    expect(neverRules.every((r) => r.tier === "identity")).toBe(true);
  });

  test("Testing Rules section classified as reinforcement tier", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    const reinforcement = rules.filter((r) => r.tier === "reinforcement");
    expect(reinforcement.length).toBeGreaterThan(0);
    expect(reinforcement.every((r) => r.section === "Testing Rules")).toBe(true);
  });

  test("Workflow section classified as mechanical tier", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    const mechanical = rules.filter((r) => r.tier === "mechanical");
    expect(mechanical.length).toBeGreaterThan(0);
    expect(mechanical.every((r) => r.section === "Workflow")).toBe(true);
  });

  test("getRulesForTier filters correctly", () => {
    const reinforcement = getRulesForTier("marcus", "reinforcement");
    const identity = getRulesForTier("marcus", "identity");
    expect(reinforcement.length).toBeGreaterThan(0);
    expect(identity.length).toBeGreaterThan(0);
    expect(reinforcement.every((r) => r.tier === "reinforcement")).toBe(true);
    expect(identity.every((r) => r.tier === "identity")).toBe(true);
    expect(reinforcement.length).toBeLessThan(identity.length);
  });

  test("getRulesForRole loads from .claude/agents/{role}.md", () => {
    const rules = getRulesForRole("marcus");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].source).toBe("marcus.md");
  });

  test("different roles return different rules", () => {
    const marcus = getRulesForRole("marcus");
    const quinn = getRulesForRole("quinn");
    expect(marcus.length).not.toBe(quinn.length);
  });

  test("unique IDs per rule", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    expect(rules.length).toBe(new Set(rules.map((r) => r.id)).size);
  });

  test("line numbers are positive", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/marcus.md"));
    expect(rules.every((r) => r.line > 0)).toBe(true);
  });

  test("briefs without tiers frontmatter default to identity", () => {
    const rules = loadRules(join(ROOT, ".claude/agents/discovery.md"));
    if (rules.length > 0) {
      expect(rules.every((r) => r.tier === "identity")).toBe(true);
    }
  });
});
