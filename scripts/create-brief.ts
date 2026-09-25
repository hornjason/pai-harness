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
import { generateBriefTemplate, writeBriefTemplate, addRoleToConfig } from "../lib/create-brief";

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
const configPath = join(projectRoot, ".claude", "rungate.json");

try {
  // Generate template file
  const templatePath = writeBriefTemplate(templatesDir, roleName, description);
  console.log(`Created ${templatePath}`);

  // Add role to rungate.json if it exists
  try {
    addRoleToConfig(configPath, roleName, description);
    console.log(`Added role '${roleName}' to ${configPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found")) {
      console.log(`Note: ${configPath} not found — role not registered in config`);
    } else {
      throw err;
    }
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
