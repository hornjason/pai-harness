/**
 * Tests for instruction-effectiveness.ts
 *
 * Covers AC-7
 */
import { describe, it, expect } from "bun:test";

import {
  trackEffectiveness,
  type EffectivenessResult,
  type WordComplianceRate,
} from "../lib/instruction-effectiveness";

import type { AgentAuditResult } from "../lib/agent-audit";

function makeAuditRules(
  rules: Array<{ id: string; rule: string; verdict: "FOLLOWED" | "IGNORED"; weight?: number }>,
): AgentAuditResult["rules"] {
  return rules.map((r) => ({
    id: r.id,
    rule: r.rule,
    verdict: r.verdict,
    evidence: `${r.verdict} evidence`,
    weight: r.weight ?? 10,
  }));
}

describe("track effectiveness", () => {
  it("correlates instruction words with compliance outcomes", () => {
    const instructions = [
      "MUST read AGENTS.md first",
      "Never skip tests",
      "Always verify before asserting",
    ];

    const auditRules = makeAuditRules([
      { id: "R-1", rule: "MUST read AGENTS.md first", verdict: "FOLLOWED" },
      { id: "R-2", rule: "Never skip tests", verdict: "IGNORED" },
      { id: "R-3", rule: "Always verify before asserting", verdict: "FOLLOWED" },
    ]);

    const result = trackEffectiveness(instructions, auditRules);

    expect(result.wordRates).toBeDefined();
    expect(result.wordRates.length).toBeGreaterThan(0);
  });

  it("produces per-word compliance rates", () => {
    const instructions = [
      "MUST read AGENTS.md first",
      "MUST run tests before reporting",
    ];

    const auditRules = makeAuditRules([
      { id: "R-1", rule: "MUST read AGENTS.md first", verdict: "FOLLOWED" },
      { id: "R-2", rule: "MUST run tests before reporting", verdict: "FOLLOWED" },
    ]);

    const result = trackEffectiveness(instructions, auditRules);

    const mustRate = result.wordRates.find((w) => w.word.toLowerCase() === "must");
    expect(mustRate).toBeDefined();
    expect(mustRate!.complianceRate).toBe(1.0);
    expect(mustRate!.occurrences).toBe(2);
  });

  it("computes lower compliance rate for words in ignored rules", () => {
    const instructions = [
      "Should read AGENTS.md",
      "Should verify tests",
    ];

    const auditRules = makeAuditRules([
      { id: "R-1", rule: "Should read AGENTS.md", verdict: "FOLLOWED" },
      { id: "R-2", rule: "Should verify tests", verdict: "IGNORED" },
    ]);

    const result = trackEffectiveness(instructions, auditRules);

    const shouldRate = result.wordRates.find((w) => w.word.toLowerCase() === "should");
    expect(shouldRate).toBeDefined();
    expect(shouldRate!.complianceRate).toBe(0.5);
    expect(shouldRate!.occurrences).toBe(2);
  });

  it("filters out common stop words", () => {
    const instructions = ["the quick brown fox"];
    const auditRules = makeAuditRules([
      { id: "R-1", rule: "the quick brown fox", verdict: "FOLLOWED" },
    ]);

    const result = trackEffectiveness(instructions, auditRules);

    const theRate = result.wordRates.find((w) => w.word === "the");
    expect(theRate).toBeUndefined();
  });

  it("handles empty inputs gracefully", () => {
    const result = trackEffectiveness([], []);
    expect(result.wordRates).toHaveLength(0);
    expect(result.timestamp).toBeDefined();
  });

  it("sorts word rates by compliance rate descending", () => {
    const instructions = [
      "MUST always read docs",
      "Should maybe check tests",
    ];

    const auditRules = makeAuditRules([
      { id: "R-1", rule: "MUST always read docs", verdict: "FOLLOWED" },
      { id: "R-2", rule: "Should maybe check tests", verdict: "IGNORED" },
    ]);

    const result = trackEffectiveness(instructions, auditRules);

    for (let i = 1; i < result.wordRates.length; i++) {
      expect(result.wordRates[i - 1].complianceRate).toBeGreaterThanOrEqual(
        result.wordRates[i].complianceRate,
      );
    }
  });
});
