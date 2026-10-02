#!/usr/bin/env bun
/**
 * Convert a freeform document into RunGate spec format.
 *
 * Takes numbered rules, design guidelines, or requirements docs and converts
 * them into a spec with proper frontmatter and SC checkboxes.
 *
 * Usage:
 *   bun scripts/convert-spec.ts <input-file> [--dry-run] [--output <path>]
 *
 * Flags:
 *   --dry-run   Preview converted spec to stdout without writing any file
 *   --output    Write to a specific path instead of specs/
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { SIGNAL_PHRASE_PATTERNS } from "../lib/signal-phrases";

// ── Argument parsing ──────────────────────────────────────────

const rawArgs = process.argv.slice(2);

let inputFile: string | undefined;
let dryRun = false;
let outputPath: string | undefined;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--dry-run") {
    dryRun = true;
  } else if (rawArgs[i] === "--output" && i + 1 < rawArgs.length) {
    outputPath = rawArgs[i + 1];
    i++;
  } else if (!rawArgs[i].startsWith("--")) {
    inputFile = rawArgs[i];
  }
}

if (!inputFile) {
  console.error("Usage: bun scripts/convert-spec.ts <input-file> [--dry-run] [--output <path>]");
  process.exit(1);
}

if (!existsSync(inputFile)) {
  console.error(`ERROR: File not found: ${inputFile}`);
  process.exit(1);
}

const inputContent = readFileSync(inputFile, "utf-8");
if (!inputContent.trim()) {
  console.error("WARNING: Input file is empty — no rules to convert");
  process.exit(1);
}

// ── Extract title ──────────────────────────────────────────────

function extractTitle(content: string, filePath: string): string {
  // Look for # heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();

  // Fall back to filename
  const name = basename(filePath, ".md");
  return name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Extract rules ──────────────────────────────────────────────

interface ExtractedRule {
  text: string;
  testable: boolean;
}

/**
 * Heuristic: a rule is non-testable if it lacks actionable signal phrases
 * and contains subjective/vague language.
 */
const NON_TESTABLE_INDICATORS = [
  /\bshould be\b.*\b(elegant|clean|readable|beautiful|nice|good)\b/i,
  /\bthink\b.*\b(carefully|about|through)\b/i,
  /\bconsider\b/i,
  /\bkeep in mind\b/i,
  /\bstrive\b/i,
  /\baim for\b/i,
  /\btry to\b/i,
  /\bideally\b/i,
];

const TESTABLE_INDICATORS = [
  /\b(must|shall|always|never|required|must not)\b/i,
  /\b(run|execute|validate|check|verify|test|ensure)\b/i,
  /\b(file|directory|path|config|output|input|field|section)\b/i,
  /\b(contains?|exists?|returns?|produces?)\b/i,
];

function isTestable(text: string): boolean {
  // If it has non-testable indicators, check if it also has testable ones
  const hasNonTestable = NON_TESTABLE_INDICATORS.some((re) => re.test(text));
  const hasTestable = TESTABLE_INDICATORS.some((re) => re.test(text));

  if (hasNonTestable && !hasTestable) return false;
  if (hasTestable) return true;

  // Default: if it has a signal phrase, it's testable
  return false;
}

function extractRules(content: string): ExtractedRule[] {
  const rules: ExtractedRule[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");

  // Pass 1: Extract numbered rules (e.g., "1. Must validate inputs")
  for (const line of lines) {
    const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      const text = numberedMatch[1].trim();
      if (text.length < 5) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ text, testable: isTestable(text) });
    }
  }

  // Pass 2: Extract bullet-point rules with signal phrases
  for (const line of lines) {
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) continue;
    const text = bulletMatch[1].trim();
    if (text.length < 5) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    // Only include if it has a signal phrase
    const hasSignal = SIGNAL_PHRASE_PATTERNS.some((pattern) => {
      const re = new RegExp(pattern.source, pattern.flags);
      return re.test(line);
    });
    if (hasSignal) {
      seen.add(key);
      rules.push({ text, testable: isTestable(text) });
    }
  }

  // Pass 3: Check for inline signal phrases in prose (non-list, non-numbered lines)
  for (const line of lines) {
    // Skip lines already handled (numbered or bullet)
    if (/^\d+\.\s+/.test(line) || /^[-*]\s+/.test(line)) continue;
    // Skip headings and empty lines
    if (/^#/.test(line) || !line.trim()) continue;

    for (const pattern of SIGNAL_PHRASE_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      for (const match of line.matchAll(re)) {
        const text = match[0].trim().replace(/[.;]$/, "");
        if (text.length < 10) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push({ text, testable: isTestable(text) });
      }
    }
  }

  return rules;
}

// ── Generate spec ──────────────────────────────────────────────

const title = extractTitle(inputContent, inputFile);
const rules = extractRules(inputContent);

if (rules.length === 0) {
  console.error("WARNING: No convertible rules found in input");
  process.exit(1);
}

const today = new Date().toISOString().split("T")[0];

const scLines = rules.map((rule, i) => {
  const num = i + 1;
  const annotation = rule.testable ? "" : " (non-testable)";
  return `- [ ] SC-${num}: ${rule.text}${annotation}`;
});

const specContent = `---
doc-type: spec
status: draft
owner: TODO
created: ${today}
updated: ${today}
governs: TODO — describe what this spec governs
testable: true
---

# ${title}

## Context

Converted from ${basename(inputFile)} on ${today}.

## Success Criteria

${scLines.join("\n")}
`;

// ── Output ────────────────────────────────────────────────────

if (dryRun) {
  process.stdout.write(specContent);
  process.exit(0);
}

if (outputPath) {
  writeFileSync(outputPath, specContent);
  console.log(`Wrote converted spec to ${outputPath}`);
  process.exit(0);
}

// Default: write to specs/ directory
const slug = title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const filename = `${slug}-SPEC.md`;
const root = join(import.meta.dir, "..");
const specsDir = join(root, "specs");

if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });

const filePath = join(specsDir, filename);
if (existsSync(filePath)) {
  console.error(`ERROR: ${filename} already exists in specs/`);
  process.exit(1);
}

writeFileSync(filePath, specContent);
console.log(`Created specs/${filename}`);
