#!/usr/bin/env bun
/**
 * Rule-level test runner for agent briefs.
 *
 * Phase 1: Test each rule in isolation against a canary task.
 *
 * Usage:
 *   bun scripts/test-rules.ts marcus          # test all rules for marcus
 *   bun scripts/test-rules.ts marcus M-03     # test one rule
 *   bun scripts/test-rules.ts marcus --list   # list all rules
 *   bun scripts/test-rules.ts marcus --report # show last results
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { extractDirectives, type Directive } from "../lib/directive-extractor.js";
import { checkTDD, type TDDResult, type SequenceEvent } from "../lib/transcript-checker.js";

// ── Types ───────────────────────────────────────────────

interface Rule {
  id: string;
  text: string;
  type: "read" | "run" | "never" | "always" | "principle";
  source: string;
  line: number;
  checkType: "mechanical" | "sequence" | "output" | "judge";
  canaryTask?: string;
  check?: string;
}

interface RuleResult {
  id: string;
  rule: string;
  status: "PASS" | "FAIL" | "SKIP" | "UNTESTED";
  evidence: string;
  timestamp: string;
}

// ── Rule extraction ─────────────────────────────────────

function extractProseRules(content: string, source: string): Rule[] {
  const rules: Rule[] = [];
  const lines = content.split("\n");
  let ruleIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^### /)) {
      const ruleText = line.replace("### ", "");
      let desc = "";
      for (let j = i + 1; j < lines.length && j < i + 3; j++) {
        if (lines[j].trim() && !lines[j].startsWith("#")) {
          desc = lines[j].trim();
          break;
        }
      }
      rules.push({
        id: `P-${ruleIndex++}`,
        text: ruleText,
        type: "principle",
        source,
        line: i + 1,
        checkType: "judge",
      });
    }
  }
  return rules;
}

function loadRulesForRole(role: string): Rule[] {
  const briefPath = join(".claude/agents", `${role}.md`);
  const brief = readFileSync(briefPath, "utf-8");
  const rules: Rule[] = [];

  // Extract directive-style rules from brief
  const directives = extractDirectives(brief);
  directives.forEach((d, i) => {
    rules.push({
      id: `D-${i}`,
      text: d.text,
      type: d.type as Rule["type"],
      source: basename(briefPath),
      line: d.line,
      checkType: d.type === "read" || d.type === "run" || d.type === "never" ? "mechanical" : "judge",
    });
  });

  // Find Context file references and extract their rules too
  const contextFiles = brief.match(/\*\*([^*]+\.md)\*\*/g) || [];
  const promptRefs = contextFiles
    .map((m) => m.replace(/\*\*/g, ""))
    .filter((f) => f.includes("prompts/") || f.includes("coding-") || f.includes("testing-"));

  for (const ref of promptRefs) {
    const refPath = ref.startsWith("prompts/") ? ref : `prompts/${ref}`;
    if (existsSync(refPath)) {
      const content = readFileSync(refPath, "utf-8");
      const proseRules = extractProseRules(content, basename(refPath));
      rules.push(...proseRules);

      // Also extract any directive-style rules from prompt files
      const promptDirectives = extractDirectives(content);
      promptDirectives.forEach((d, i) => {
        rules.push({
          id: `PD-${i}`,
          text: d.text,
          type: d.type as Rule["type"],
          source: basename(refPath),
          line: d.line,
          checkType: "mechanical",
        });
      });
    }
  }

  // Re-index IDs
  rules.forEach((r, i) => {
    const prefix = role.charAt(0).toUpperCase();
    r.id = `${prefix}-${String(i + 1).padStart(2, "0")}`;
  });

  return rules;
}

// ── Canary tasks per check type ─────────────────────────

const CANARY_TASKS: Record<string, string> = {
  // Coding principles
  "Deep modules over shallow wrappers":
    "Create lib/formatter.ts with a format() function that handles 3 output formats (json, csv, table). The module should have one public export and hide format-specific logic internally.",
  "One export per concern":
    "Create lib/validator.ts with validation logic for 3 field types (string, number, date). Each validation should be a separate function.",
  "Immutability by default":
    "Create lib/transform.ts with a function that transforms an array of objects by adding a computed field. Return new objects, don't mutate.",
  "Boundary validation with Zod":
    "Create lib/config-loader.ts that reads a JSON config and validates it has required fields (name: string, version: number, enabled: boolean).",
  "Exhaustive matching (assertNever)":
    "Create lib/status-handler.ts with a function that handles 3 status types (pending, active, archived) using a switch statement.",
  // Testing principles
  "Inverted pyramid":
    "Create lib/calculator.ts with add/subtract functions and write tests for it.",
  "Tautological testing trap":
    "Create lib/slug.ts that converts a title to a URL slug. Write tests that verify against the spec, not the implementation.",
  "Contract tests for shared interfaces":
    "Create lib/store.ts with a Store interface (get, set, delete). Write a contract test that any Store implementation must pass.",
};

// ── Main ────────────────────────────────────────────────

const [role, filter] = process.argv.slice(2);

if (!role) {
  console.log("Usage: bun scripts/test-rules.ts <role> [rule-id|--list|--report]");
  process.exit(1);
}

const rules = loadRulesForRole(role);

if (filter === "--list") {
  console.log(`\n=== ${role}: ${rules.length} rules ===\n`);
  for (const r of rules) {
    const tag = r.checkType === "mechanical" ? "⚙️" : r.checkType === "sequence" ? "🔄" : r.checkType === "output" ? "📝" : "🧠";
    const hasCanary = CANARY_TASKS[r.text] ? "✅" : "  ";
    console.log(`  ${r.id} ${tag} ${hasCanary} [${r.source}] ${r.text.slice(0, 70)}`);
  }
  console.log(`\n${rules.filter((r) => CANARY_TASKS[r.text]).length}/${rules.length} rules have canary tasks`);
  process.exit(0);
}

if (filter === "--report") {
  const reportPath = join("evals", `${role}-results.json`);
  if (existsSync(reportPath)) {
    const results: RuleResult[] = JSON.parse(readFileSync(reportPath, "utf-8"));
    console.log(`\n=== ${role}: Last Results ===\n`);
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const untested = results.filter((r) => r.status === "UNTESTED" || r.status === "SKIP").length;
    console.log(`PASS: ${passed} | FAIL: ${failed} | UNTESTED: ${untested} | Total: ${results.length}`);
    console.log("");
    for (const r of results) {
      const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⬜";
      console.log(`  ${icon} ${r.id}: ${r.rule.slice(0, 60)}`);
      if (r.evidence) console.log(`     ${r.evidence}`);
    }
  } else {
    console.log("No results yet. Run tests first.");
  }
  process.exit(0);
}

// Default: list rules with canary task status
console.log(`\n=== ${role}: ${rules.length} rules loaded from ${new Set(rules.map((r) => r.source)).size} files ===\n`);

const bySource: Record<string, Rule[]> = {};
for (const r of rules) {
  if (!bySource[r.source]) bySource[r.source] = [];
  bySource[r.source].push(r);
}

for (const [source, sourceRules] of Object.entries(bySource)) {
  console.log(`--- ${source} (${sourceRules.length} rules) ---`);
  for (const r of sourceRules) {
    const tag = r.checkType === "mechanical" ? "⚙️ mechanical" : r.checkType === "sequence" ? "🔄 sequence " : "🧠 judge     ";
    console.log(`  ${r.id} ${tag}  ${r.text.slice(0, 65)}`);
  }
  console.log("");
}

console.log("Summary:");
console.log(`  Mechanical checks: ${rules.filter((r) => r.checkType === "mechanical").length} (can test now)`);
console.log(`  Sequence checks:   ${rules.filter((r) => r.checkType === "sequence").length} (need transcript)`);
console.log(`  Judge checks:      ${rules.filter((r) => r.checkType === "judge").length} (need LLM or canary task)`);
console.log(`  Canary tasks:      ${rules.filter((r) => CANARY_TASKS[r.text]).length} defined`);
console.log("");
console.log("Next: bun scripts/test-rules.ts marcus --list");
