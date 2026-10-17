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
  allocateScNumber,
  generateSCText,
  listPatterns,
  formatSCLine,
} from "../lib/create-sc";
import { readScRegistry } from "./sync-sc-status";
import { describeReading } from "../lib/sc-id-cross-tree";
import { join } from "path";

/** Same resolution sync-sc-status uses, so both halves read one tree. */
const ROOT = join(import.meta.dir, "..");

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
    // The whole namespace, not just this file: SC ids are global, and
    // allocating from one spec's content is what produced ten collisions
    // (#392). A spec outside specs/ still gets the local answer.
    //
    // BOTH halves of it (#399). The registry is specs only, and test fixtures
    // spell SC ids in the same namespace without appearing in any registry,
    // so an allocation that consults only the registry can mint a criterion
    // out of a number a fixture already depends on.
    //
    // And a THIRD half, which is the one the first two could not see (#503):
    // the registry is `specs/` in whichever working tree this command runs
    // in. Two sessions in two worktrees both read "highest + 1" correctly and
    // both got the same number.
    //
    // All three widths compose inside `allocateScNumber`, so this CLI cannot
    // assemble two of them and believe it asked.
    const { number: scNumber, namespace } = allocateScNumber(ROOT, content, readScRegistry());
    const scLine = formatSCLine(scNumber, statement);

    // Append SC line to the end of the file
    const newContent = content.trimEnd() + "\n" + scLine + "\n";
    writeFileSync(specPath, newContent);
    console.log(`Appended to ${specPath}: ${scLine}`);
    // What the number is a floor over, stated rather than implied. A clone on
    // another machine is outside anything this process can reach, and an
    // allocator that printed only the number would be claiming a guarantee it
    // cannot give (`.claude/rules/config-access.md`).
    console.log(`  namespace: ${describeReading(namespace)}`);
    for (const gap of namespace.unmeasured) console.log(`  UNMEASURED: ${gap}`);
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
