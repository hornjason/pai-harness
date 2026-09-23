#!/usr/bin/env bun
/**
 * create-sc CLI — Generate matchable SC lines from structured input.
 *
 * Usage:
 *   bun scripts/create-sc.ts --pattern file-exists --params '{"file":"AGENTS.md"}'
 *   bun scripts/create-sc.ts --pattern file-exists --params '{"file":"AGENTS.md"}' --spec specs/MY-SPEC.md
 *   bun scripts/create-sc.ts --list
 *
 * Thin CLI consumer — all logic lives in lib/create-sc.ts.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  generateSCText,
  listPatterns,
  nextSCNumber,
  formatSCLine,
} from "../lib/create-sc";

// ── Argument parsing ──────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// ── Main ──────────────────────────────────────────────────────

if (hasFlag("list")) {
  console.log(listPatterns());
  process.exit(0);
}

const patternName = getFlag("pattern");
if (!patternName) {
  console.error("Usage: bun scripts/create-sc.ts --pattern <name> --params '<json>'");
  console.error("       bun scripts/create-sc.ts --list");
  process.exit(1);
}

// Parse params
const paramsRaw = getFlag("params");
let params: Record<string, string> = {};
if (paramsRaw) {
  try {
    params = JSON.parse(paramsRaw);
  } catch {
    console.error(`ERROR: Invalid JSON in --params: ${paramsRaw}`);
    process.exit(1);
  }
}

// Validate and generate
try {
  const statement = generateSCText(patternName, params);
  const specPath = getFlag("spec");

  if (specPath) {
    // Append to spec file
    if (!existsSync(specPath)) {
      console.error(`ERROR: Spec file not found: ${specPath}`);
      process.exit(1);
    }
    const content = readFileSync(specPath, "utf-8");
    const scNumber = nextSCNumber(content);
    const scLine = formatSCLine(scNumber, statement);

    // Append SC line to the end of the file
    const newContent = content.trimEnd() + "\n" + scLine + "\n";
    writeFileSync(specPath, newContent);
    console.log(`Appended to ${specPath}: ${scLine}`);
  } else {
    // Output to stdout for piping
    const scLine = formatSCLine(0, statement);
    console.log(scLine);
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
