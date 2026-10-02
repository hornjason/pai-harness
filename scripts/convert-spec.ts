#!/usr/bin/env bun
/**
 * Convert freeform documents into RunGate spec format.
 *
 * Takes a file containing numbered rules, design guidelines, or requirements
 * and converts it into a proper RunGate spec with frontmatter and SC checkboxes.
 *
 * Usage:
 *   bun scripts/convert-spec.ts <input-file> [options]
 *   bun scripts/convert-spec.ts rules.md                    # writes to specs/RULES-SPEC.md
 *   bun scripts/convert-spec.ts rules.md --dry-run          # preview without writing
 *   bun scripts/convert-spec.ts rules.md --title "My Spec"  # custom title
 *   bun scripts/convert-spec.ts rules.md --governs "input validation"  # custom governs
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import { SIGNAL_PHRASE_PATTERNS } from "../lib/signal-phrases";

// ── Argument parsing ──────────────────────────────────────────

const rawArgs = process.argv.slice(2);

let inputFile: string | undefined;
let dryRun = false;
let customTitle: string | undefined;
let customGoverns: string | undefined;
let projectRoot: string | undefined;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--title" && i + 1 < rawArgs.length) {
    customTitle = rawArgs[++i];
  } else if (arg === "--governs" && i + 1 < rawArgs.length) {
    customGoverns = rawArgs[++i];
  } else if (arg === "--project-root" && i + 1 < rawArgs.length) {
    projectRoot = rawArgs[++i];
  } else if (!inputFile) {
    inputFile = arg;
  }
}

if (!inputFile) {
  console.error('Usage: bun scripts/convert-spec.ts <input-file> [--dry-run] [--title "Title"] [--governs "description"]');
  process.exit(1);
}

if (!existsSync(inputFile)) {
  console.error(`ERROR: Input file not found: ${inputFile}`);
  process.exit(1);
}

// ── Rule extraction ───────────────────────────────────────────

interface ExtractedRule {
  text: string;
  testable: boolean;
  source: "numbered" | "signal-phrase" | "bullet";
}

/**
 * Determine whether a rule statement is mechanically testable.
 *
 * Testable rules contain actionable signal words (must, never, always, shall, required)
 * and describe a concrete, verifiable behavior.
 *
 * Non-testable rules are subjective, vague, or advisory (should, think, consider, elegant).
 */
function isTestable(text: string): boolean {
  const lower = text.toLowerCase();

  // Non-testable indicators: subjective or advisory language
  const nonTestablePatterns = [
    /\bshould\b/,
    /\bthink\b/,
    /\bconsider\b/,
    /\belegant\b/,
    /\breadable\b/,
    /\bclean\b(?![\s-]*up)/,   // "clean" as adjective, not "clean up"
    /\bcareful(?:ly)?\b/,
    /\bideally\b/,
    /\bpreferable\b/,
    /\bnice\b/,
    /\bgood practice\b/,
    /\bbest practice\b/,
    /\btry to\b/,
    /\baim to\b/,
    /\bstrive\b/,
  ];

  // Testable indicators: mandatory/prohibitive language
  const testablePatterns = [
    /\bmust\b/,
    /\bmust not\b/,
    /\bnever\b/,
    /\balways\b/,
    /\bshall\b/,
    /\brequired\b/,
    /\bdo not\b/,
    /\bprefer\b/,
    /\beliminate\b/,
  ];

  const hasNonTestable = nonTestablePatterns.some((p) => p.test(lower));
  const hasTestable = testablePatterns.some((p) => p.test(lower));

  // If it has testable language, it's testable even if it also has non-testable words
  if (hasTestable) return true;

  // If it only has non-testable language, it's non-testable
  if (hasNonTestable) return false;

  // Default: numbered rules without signal phrases are potentially testable
  // if they describe a concrete action
  const concreteActionPatterns = [
    /\brun\b/,
    /\buse\b/,
    /\bwrite\b/,
    /\bcreate\b/,
    /\btest\b/,
    /\bvalidate\b/,
    /\bcheck\b/,
    /\breview\b/,
    /\bensure\b/,
    /\bimplement\b/,
    /\breturn\b/,
    /\binclude\b/,
    /\bexport\b/,
    /\bimport\b/,
    /\blog\b/,
  ];

  return concreteActionPatterns.some((p) => p.test(lower));
}

/**
 * Extract rules from freeform text.
 *
 * Detects:
 * 1. Numbered rules: "1. Rule text"
 * 2. Bullet rules with signal phrases: "- Must do X", "- Never do Y"
 * 3. Signal phrase patterns from SIGNAL_PHRASE_PATTERNS
 */
function extractRules(content: string): ExtractedRule[] {
  const lines = content.split("\n");
  const rules: ExtractedRule[] = [];
  const seenTexts = new Set<string>();

  const normalizeKey = (t: string) => t.toLowerCase().replace(/[.;,\s]+$/, "");

  // Pass 1: Extract numbered rules
  for (const line of lines) {
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      const text = numbered[1].replace(/\*\*/g, "").trim();
      if (text && !seenTexts.has(normalizeKey(text))) {
        seenTexts.add(normalizeKey(text));
        rules.push({
          text,
          testable: isTestable(text),
          source: "numbered",
        });
      }
    }
  }

  // Pass 2: Extract bullet items with signal phrases
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const text = bullet[1].trim();
      const lower = text.toLowerCase();
      const hasSignal = /\b(must not|never|must|always|required|shall|prefer|eliminate|do not)\b/.test(lower);
      if (hasSignal && !seenTexts.has(normalizeKey(text))) {
        seenTexts.add(normalizeKey(text));
        rules.push({
          text,
          testable: isTestable(text),
          source: "bullet",
        });
      }
    }
  }

  // Pass 3: Use SIGNAL_PHRASE_PATTERNS for any remaining matches
  for (const pattern of SIGNAL_PHRASE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of content.matchAll(re)) {
      const text = m[0]
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+\.\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/^[.;,\s]+/, "")   // strip leading punctuation/whitespace
        .trim()
        .replace(/[.;]$/, "");
      if (text && text.length >= 10 && !seenTexts.has(normalizeKey(text))) {
        seenTexts.add(normalizeKey(text));
        rules.push({
          text,
          testable: isTestable(text),
          source: "signal-phrase",
        });
      }
    }
  }

  return rules;
}

// ── Title derivation ──────────────────────────────────────────

function deriveTitle(filePath: string): string {
  const name = basename(filePath, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name;
}

function deriveSlug(title: string): string {
  return title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ── Spec generation ───────────────────────────────────────────

function generateSpec(rules: ExtractedRule[], title: string, governs: string): string {
  const today = new Date().toISOString().split("T")[0];

  // Build SC lines
  const scLines = rules.map((rule, i) => {
    const scId = `SC-${i + 1}`;
    const annotation = rule.testable ? "" : " (non-testable)";
    return `- [ ] ${scId}: ${rule.text}${annotation}`;
  });

  // If no rules were extracted, add a placeholder
  if (scLines.length === 0) {
    scLines.push("- [ ] SC-1: [first criterion -- atomic, verifiable, 8-12 words]");
  }

  return `---
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

Converted from freeform document. Review and refine the success criteria below.

## Success Criteria

${scLines.join("\n")}
`;
}

// ── Main ──────────────────────────────────────────────────────

const content = readFileSync(inputFile, "utf-8");
const rules = extractRules(content);
const title = customTitle ?? deriveTitle(inputFile);
const governs = customGoverns ?? "TODO -- describe what this spec governs";
const specContent = generateSpec(rules, title, governs);

if (dryRun) {
  process.stdout.write(specContent);
  process.exit(0);
}

// Write to specs/ directory
const root = projectRoot ?? join(dirname(import.meta.dir), "");
const specsDir = join(root, "specs");
const slug = deriveSlug(title);
const filename = `${slug}-SPEC.md`;
const outputPath = join(specsDir, filename);

if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true });

if (existsSync(outputPath)) {
  console.error(`ERROR: ${filename} already exists`);
  process.exit(1);
}

writeFileSync(outputPath, specContent);
console.log(`Created specs/${filename}`);
console.log(`  ${rules.length} rules extracted (${rules.filter((r) => !r.testable).length} non-testable)`);
