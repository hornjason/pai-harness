#!/usr/bin/env bun
/**
 * Generates the "Recognized Patterns" section of specs/SPEC-TEMPLATE.md
 * from config/matcher-registry.json
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { skipLine } from "../lib/derived-spec";
import { maySpecBeWritten, writeSpec } from "../lib/write-spec";

const PROJECT_ROOT = join(import.meta.dir, "..");
const REGISTRY_PATH = join(PROJECT_ROOT, "config/matcher-registry.json");
const TEMPLATE_PATH = join(PROJECT_ROOT, "specs/SPEC-TEMPLATE.md");

const BEGIN_MARKER = "<!-- BEGIN GENERATED PATTERNS -->";
const END_MARKER = "<!-- END GENERATED PATTERNS -->";

interface Pattern {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

function generatePatternSection(patterns: Pattern[]): string {
  let output = "Use these exact patterns for auto-testable SCs:\n\n";

  for (const pattern of patterns) {
    output += `#### ${pattern.name}\n`;
    output += `**Syntax:** \`${pattern.syntax}\`\n\n`;
    output += `**Example:** \`- [ ] SC-N: ${pattern.example}\`\n\n`;
    output += `**Notes:** ${pattern.notes}\n\n`;
  }

  return output.trimEnd();
}

function main() {
  // Read matcher registry
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Pattern[];

  // Generate patterns section
  const generatedContent = generatePatternSection(registry);

  // Read template
  const template = readFileSync(TEMPLATE_PATH, "utf-8");

  // Find markers
  const beginIndex = template.indexOf(BEGIN_MARKER);
  const endIndex = template.indexOf(END_MARKER);

  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(
      `Could not find markers in ${TEMPLATE_PATH}. Expected ${BEGIN_MARKER} and ${END_MARKER}`
    );
  }

  // Replace content between markers
  const before = template.substring(0, beginIndex + BEGIN_MARKER.length);
  const after = template.substring(endIndex);
  const updated = `${before}\n${generatedContent}\n${after}`;

  // #1286: in place, on an existing spec. SPEC-TEMPLATE.md itself declares
  // no generator — its `<!-- BEGIN GENERATED PATTERNS -->` delimits a region
  // rather than the file — so this reads `authored` and proceeds. The guard
  // is here for a consumer whose template IS produced by something else.
  const early = maySpecBeWritten(template);
  if (!early.allowed) {
    console.error(skipLine(TEMPLATE_PATH, early.reading));
    process.exit(1);
  }

  // Write back
  writeSpec(TEMPLATE_PATH, updated);

  console.log(`Generated ${registry.length} patterns in SPEC-TEMPLATE.md`);
}

main();
