#!/usr/bin/env bun
/**
 * fresh-eyes-test — runs a fresh agent with a standard task against current
 * instruction files and writes behavioral verification results to
 * .rungate/fresh-eyes-results.json
 *
 * Usage:
 *   bun scripts/fresh-eyes-test.ts [role] [task]
 *   bun scripts/fresh-eyes-test.ts marcus "Add config/test.json"
 *   bun scripts/fresh-eyes-test.ts --dry-run
 *
 * AC-5: fresh-eyes-results.json output file
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";
import { extractDirectives } from "../lib/directive-extractor.js";
import { checkCompliance, computeScore, parseToolCalls } from "../lib/transcript-checker.js";
import { writeAuditComplianceJSON } from "../lib/agent-audit.js";

const ROOT = join(import.meta.dir, "..");

// ── CLI args ────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const isDryRun = flags.includes("--dry-run");
const role = positional[0] || "marcus";
const task = positional[1] || "Add a config/fresh-eyes-test.json file with project metadata";

// ── Config ──────────────────────────────────────────────

interface RoleConfig {
  brief: string;
  standardTask?: string;
}

function loadRoleConfig(): Record<string, RoleConfig> {
  const configPath = join(ROOT, ".claude", "rungate.json");
  if (!existsSync(configPath)) return {};
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.roles || {};
  } catch {
    return {};
  }
}

// ── Fresh eyes results ──────────────────────────────────

interface FreshEyesResult {
  timestamp: string;
  role: string;
  task: string;
  briefPath: string;
  directiveCount: number;
  compliance: {
    score: number;
    grade: string;
    followed: number;
    ignored: number;
    violated: number;
    checkable: number;
  };
  dryRun: boolean;
  transcriptPath?: string;
}

// ── Main ────────────────────────────────────────────────

const roleConfig = loadRoleConfig();
const briefRelPath = roleConfig[role]?.brief || `.claude/agents/${role}.md`;
const briefPath = join(ROOT, briefRelPath);

if (!existsSync(briefPath)) {
  console.error(`Brief not found: ${briefPath}`);
  process.exit(1);
}

console.log(`\nFresh Eyes Test: ${role}`);
console.log(`Brief: ${briefRelPath}`);
console.log(`Task: "${task}"`);

// Extract directives
const briefContent = readFileSync(briefPath, "utf-8");
const directives = extractDirectives(briefContent);
console.log(`Directives: ${directives.length} extracted`);

if (isDryRun) {
  console.log("\n[DRY RUN] Skipping agent spawn");
  console.log(`Extracted ${directives.length} directives from ${basename(briefPath)}`);

  const result: FreshEyesResult = {
    timestamp: new Date().toISOString(),
    role,
    task,
    briefPath: briefRelPath,
    directiveCount: directives.length,
    compliance: {
      score: 0,
      grade: "N/A",
      followed: 0,
      ignored: 0,
      violated: 0,
      checkable: 0,
    },
    dryRun: true,
  };

  const outDir = join(ROOT, ".rungate");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "fresh-eyes-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(`Results written to .rungate/fresh-eyes-results.json`);
  process.exit(0);
}

// Spawn fresh agent
console.log("\nSpawning fresh agent...");

const transcriptDir = join(ROOT, ".rungate", "fresh-eyes-transcripts");
if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });

const transcriptPath = join(transcriptDir, `${role}-${Date.now()}.jsonl`);

const agentResult = spawnSync(
  "claude",
  [
    "--print",
    "--output-format", "stream-json",
    "--allowedTools", "Read,Write,Edit,Bash,Grep,Glob",
    "--agent-type", role,
    task,
  ],
  {
    cwd: ROOT,
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  },
);

const stdout = agentResult.stdout?.toString() || "";

// Write transcript
writeFileSync(transcriptPath, stdout);
console.log(`Transcript: ${transcriptPath}`);

// Analyze compliance
const results = checkCompliance(directives, stdout);
const scores = computeScore(results);

const freshResult: FreshEyesResult = {
  timestamp: new Date().toISOString(),
  role,
  task,
  briefPath: briefRelPath,
  directiveCount: directives.length,
  compliance: scores,
  dryRun: false,
  transcriptPath,
};

// Write results
const outDir = join(ROOT, ".rungate");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "fresh-eyes-results.json"),
  JSON.stringify(freshResult, null, 2),
);

console.log(`\nResults: ${scores.grade} (${scores.score}%)`);
console.log(`  Followed: ${scores.followed}`);
console.log(`  Ignored: ${scores.ignored}`);
console.log(`  Checkable: ${scores.checkable}`);
console.log(`\nWritten to .rungate/fresh-eyes-results.json`);
