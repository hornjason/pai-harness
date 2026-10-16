#!/usr/bin/env bun
/**
 * create-brief CLI — Generate a new agent brief template and register in rungate.json.
 *
 * Usage:
 *   bun scripts/create-brief.ts <role-name> '<description>'
 *   bun scripts/create-brief.ts tester 'Test engineer who verifies changes'
 *
 * Thin CLI consumer — all logic lives in lib/create-brief.ts.
 */
import { join } from "path";
import { generateBriefTemplate, writeBriefTemplate, registerRole } from "../lib/create-brief";

// ── Argument parsing ──────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// Filter out flag arguments to get positional args
const positionalArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--") && i + 1 < args.length) {
    i++; // skip flag value
  } else if (!args[i].startsWith("--")) {
    positionalArgs.push(args[i]);
  }
}

// ── Main ──────────────────────────────────────────────────────

if (positionalArgs.length < 2) {
  console.error("Usage: bun scripts/create-brief.ts <role-name> '<description>'");
  console.error("  Example: bun scripts/create-brief.ts tester 'Test engineer who verifies changes'");
  process.exit(1);
}

const roleName = positionalArgs[0];
const description = positionalArgs[1];
const projectRoot = getFlag("project-root") || join(import.meta.dir, "..");

const templatesDir = join(projectRoot, "templates", "agent-briefs");

try {
  // Generate template file
  const templatePath = writeBriefTemplate(templatesDir, roleName, description);
  console.log(`Created ${templatePath}`);

  // Register the role in whichever layout the project is on. The loader picks
  // the file; this CLI never names one (#415) — the version that did printed
  // "not found" against a path a migrated consumer is documented not to have,
  // and the role went nowhere.
  try {
    const written = registerRole(projectRoot, roleName, description);
    console.log(`Added role '${roleName}' to ${written}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("No rungate config found")) {
      console.log(`Note: ${message} — role not registered`);
    } else {
      throw err;
    }
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
