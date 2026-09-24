#!/usr/bin/env bun
/**
 * Create a new spec file with required frontmatter including governs.
 *
 * Usage:
 *   bun scripts/create-spec.ts "Title of the spec" "What this spec governs"
 *   bun scripts/create-spec.ts "Title of the spec"  # governs defaults to TODO
 *   bun scripts/create-spec.ts "Title" "governs" --sc "AGENTS.md exists" --sc "specs/ directory exists"
 *
 * SC validation:
 *   --sc flags provide SC statements that are validated against matchPattern()
 *   before the spec is saved. Unmatched SCs block save with pattern suggestions.
 *   SCs tagged with (behavioral) bypass matchPattern validation.
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { isMatchablePattern, isBehavioralSC, type ParsedSC } from "../lib/conformity";
import { loadRegistry, type RegistryEntry } from "../lib/create-sc";

// ── Argument parsing ──────────────────────────────────────────

const rawArgs = process.argv.slice(2);

// Extract --sc and --project-root flags before positional args
const scStatements: string[] = [];
const positionalArgs: string[] = [];
let projectRoot: string | undefined;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--sc" && i + 1 < rawArgs.length) {
    scStatements.push(rawArgs[i + 1]);
    i++; // skip the value
  } else if (rawArgs[i] === "--project-root" && i + 1 < rawArgs.length) {
    projectRoot = rawArgs[i + 1];
    i++; // skip the value
  } else {
    positionalArgs.push(rawArgs[i]);
  }
}

if (positionalArgs.length === 0) {
  console.error('Usage: bun scripts/create-spec.ts "Title" ["governs description"] [--sc "SC statement"]...');
  process.exit(1);
}

const title = positionalArgs[0];
const governs = positionalArgs[1] || "TODO — describe what this spec governs";
const slug = title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const filename = `${slug}-SPEC.md`;
const root = projectRoot ?? join(import.meta.dir, "..");
const specsDir = join(root, "specs");
const filePath = join(specsDir, filename);

if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });

if (existsSync(filePath)) {
  console.error(`ERROR: ${filename} already exists`);
  process.exit(1);
}

// ── SC validation ─────────────────────────────────────────────

/**
 * Find the closest matching patterns for an unmatched SC statement.
 * Returns up to 3 pattern suggestions based on keyword overlap.
 */
function suggestClosestPatterns(statement: string): RegistryEntry[] {
  const registry = loadRegistry(projectRoot);
  const words = statement.toLowerCase().split(/\s+/);

  const scored = registry.map((entry) => {
    const syntaxWords = entry.syntax.toLowerCase().split(/\s+/);
    const exampleWords = entry.example.toLowerCase().split(/\s+/);
    const allWords = [...syntaxWords, ...exampleWords, ...entry.name.split("-")];
    const overlap = words.filter((w) => allWords.some((aw) => aw.includes(w) || w.includes(aw))).length;
    return { entry, score: overlap };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((s) => s.score > 0)
    .map((s) => s.entry);
}

if (scStatements.length > 0) {
  const failures: Array<{ statement: string; suggestions: RegistryEntry[] }> = [];

  for (const statement of scStatements) {
    const sc: ParsedSC = { id: "SC-DRAFT", statement, specFile: filename };

    // Behavioral SCs bypass matchPattern validation
    if (isBehavioralSC(sc)) {
      continue;
    }

    // Validate against registry patterns (regex match only, no handler required)
    if (!isMatchablePattern(sc, projectRoot)) {
      const suggestions = suggestClosestPatterns(statement);
      failures.push({ statement, suggestions });
    }
  }

  if (failures.length > 0) {
    console.error(`ERROR: ${failures.length} SC(s) do not match any pattern in matcher-registry.json:\n`);
    for (const { statement, suggestions } of failures) {
      console.error(`  Unmatched: "${statement}"`);
      if (suggestions.length > 0) {
        console.error(`  Closest matching patterns:`);
        for (const s of suggestions) {
          console.error(`    - ${s.name}: ${s.syntax}`);
          console.error(`      Example: ${s.example}`);
        }
      }
      console.error("");
    }
    console.error("Tip: Use `bun scripts/create-sc.ts --list` to see all available patterns.");
    console.error("     Tag behavioral SCs with (behavioral) suffix to bypass validation.");
    process.exit(1);
  }
}

// ── Generate spec content ─────────────────────────────────────

const today = new Date().toISOString().split("T")[0];

// Build SC lines from validated --sc statements, or use placeholder
let scSection: string;
if (scStatements.length > 0) {
  scSection = scStatements
    .map((stmt, i) => `- [ ] SC-TODO-${i + 1}: ${stmt}`)
    .join("\n");
} else {
  scSection = "- [ ] SC-TODO: [first criterion — atomic, verifiable, 8-12 words]";
}

const content = `---
doc-type: spec
status: draft
owner: TODO
created: ${today}
updated: ${today}
governs: ${governs}
testable: true
---

# ${title}

## Context

[Why this spec exists and what problem it solves]

## Success Criteria

${scSection}
`;

writeFileSync(filePath, content);
console.log(`Created specs/${filename}`);
if (governs.startsWith("TODO")) {
  console.log(`  governs: is TODO — update it before scaffolding`);
  console.log(`   Tip: describe what this spec governs in one line, e.g.:`);
  console.log(`   governs: API authentication flow — token issuance, refresh, and revocation`);
}
