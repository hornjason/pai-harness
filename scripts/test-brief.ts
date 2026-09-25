#!/usr/bin/env bun
/**
 * test-brief — compliance test bench for agent briefs
 *
 * Spawns an agent in isolated worktree with a standard task,
 * audits the transcript, reports directive compliance.
 *
 * Usage:
 *   bun scripts/test-brief.ts marcus "Add config/test.json"
 *   bun scripts/test-brief.ts marcus "Add config/test.json" --dry-run
 *   bun scripts/test-brief.ts marcus "task" --hill-climb --target=90
 *   bun scripts/test-brief.ts marcus "task" --score-only
 *   bun scripts/test-brief.ts marcus "task" <transcript-dir>
 *
 * SC-400: test-brief CLI: isolated worktree compliance test
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join, basename, resolve } from "path";
import { spawnSync } from "child_process";
import { extractDirectives } from "../lib/directive-extractor.js";
import { checkCompliance, computeScore, formatReport } from "../lib/transcript-checker.js";
import { createWorktree, type WorktreeResult } from "../lib/worktree-isolation.js";
import {
  MAX_ITERATIONS,
  DEFAULT_TARGET_SCORE,
  buildIteration,
  isTargetReached,
  canContinue,
  formatHillClimbReport,
  type HillClimbResult,
} from "../lib/hill-climb.js";

const ROOT = join(import.meta.dir, "..");

// ── Supported roles ──────────────────────────────────────

const SUPPORTED_ROLES = ["marcus", "quinn", "rook", "serena", "aditi", "discovery"] as const;
type SupportedRole = typeof SUPPORTED_ROLES[number];

function isValidRole(role: string): role is SupportedRole {
  return SUPPORTED_ROLES.includes(role as SupportedRole);
}

// ── Config loading ───────────────────────────────────────

interface RoleConfig {
  brief: string;
  isolation?: string;
  standardTask?: string;
}

function loadRoleConfig(): Record<string, RoleConfig> {
  const configPath = join(ROOT, ".claude", "rungate.json");
  if (!existsSync(configPath)) return {};
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  return config.roles || {};
}

// ── RepoRails integration ────────────────────────────────

function runRepoRails(filePath: string): number {
  const result = spawnSync("npx", ["@reporails/cli", "check", filePath, "--format", "json"], {
    cwd: ROOT, timeout: 15000, encoding: "utf-8",
  });
  try {
    const data = JSON.parse(result.stdout);
    return data?.findings?.length || data?.length || 0;
  } catch {
    return -1;
  }
}

// ── Parse CLI args ───────────────────────────────────────

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const role = positional[0];
const task = positional[1];
const transcriptDir = positional[2];

const isDryRun = flags.includes("--dry-run");
const isScoreOnly = flags.includes("--score-only");
const isHillClimb = flags.includes("--hill-climb");
const targetFlag = flags.find((f) => f.startsWith("--target="));
const targetScore = targetFlag ? parseInt(targetFlag.split("=")[1], 10) : DEFAULT_TARGET_SCORE;

if (!role || !task) {
  console.error("Usage: bun scripts/test-brief.ts <role> <task> [options]");
  console.error("");
  console.error("Roles: " + SUPPORTED_ROLES.join(", "));
  console.error("");
  console.error("Options:");
  console.error("  --dry-run       Extract directives only, no agent spawn");
  console.error("  --score-only    Output only the compliance score");
  console.error("  --hill-climb    Run up to 5 iterations to improve score");
  console.error("  --target=N      Set target score (default: 80)");
  console.error("");
  console.error("Examples:");
  console.error('  bun scripts/test-brief.ts marcus "Add config/test.json" --dry-run');
  console.error('  bun scripts/test-brief.ts quinn "Validate tests" --score-only');
  process.exit(1);
}

if (!isValidRole(role)) {
  console.error(`Invalid role: ${role}`);
  console.error(`Supported roles: ${SUPPORTED_ROLES.join(", ")}`);
  process.exit(1);
}

const roleConfig = loadRoleConfig();
const briefRelPath = roleConfig[role]?.brief || `.claude/agents/${role}.md`;
const briefPath = join(ROOT, briefRelPath);

if (!existsSync(briefPath)) {
  console.error(`Brief not found: ${briefPath}`);
  process.exit(1);
}

// ── Extract directives ───────────────────────────────────

console.log(`\nExtracting directives from ${role}.md...`);
const briefContent = readFileSync(briefPath, "utf-8");
const directives = extractDirectives(briefContent);
console.log(`Found ${directives.length} directives`);

// ── Dry run mode ─────────────────────────────────────────

if (isDryRun) {
  console.log("\nExtracted directives:");
  for (const d of directives) {
    console.log(`  L${d.line} [${d.type}] (${d.section}): ${d.text.substring(0, 70)}`);
  }
  console.log(`\nDirective compliance score: pending (dry run)`);
  console.log(`Total directives: ${directives.length}`);
  process.exit(0);
}

// ── Transcript audit mode ────────────────────────────────

if (transcriptDir) {
  const resolvedDir = resolve(transcriptDir);
  if (!existsSync(resolvedDir)) {
    console.error(`Transcript directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const files = readdirSync(resolvedDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`No agent transcripts found in ${resolvedDir}`);
    process.exit(1);
  }

  console.log(`\nRunning RepoRails on brief...`);
  const rrCount = runRepoRails(briefPath);

  console.log(`\nChecking ${files.length} agent transcript(s)...`);
  for (const file of files) {
    const content = readFileSync(join(resolvedDir, file), "utf-8");
    const results = checkCompliance(directives, content);

    if (isScoreOnly) {
      const { score, grade } = computeScore(results);
      console.log(`${role}: ${grade} (${score}%)`);
    } else {
      console.log(formatReport(role, results, rrCount));
    }
  }
  process.exit(0);
}

// ── Agent spawning helper ───────────────────────────────

function spawnAgent(worktreePath: string, agentRole: string, agentTask: string, transcriptPath: string): boolean {
  console.log(`  Spawning ${agentRole} in ${worktreePath}...`);
  console.log(`  Task: "${agentTask}"`);
  console.log(`  Transcript: ${transcriptPath}`);

  const result = spawnSync(
    "claude",
    [
      "--print",
      "--output-format", "stream-json",
      "--allowedTools", "Read,Write,Edit,Bash,Grep,Glob",
      "--agent-type", agentRole,
      agentTask,
    ],
    {
      cwd: worktreePath,
      timeout: 600_000,
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_TRANSCRIPT_DIR: transcriptPath,
      },
    },
  );

  if (result.status !== 0) {
    console.error(`  Agent spawn failed: ${result.stderr?.substring(0, 200)}`);
    return false;
  }

  // Write transcript output to file
  const outputFile = join(transcriptPath, `agent-${agentRole}-run.jsonl`);
  writeFileSync(outputFile, result.stdout);
  console.log(`  Transcript written to ${outputFile}`);
  return true;
}

function runComplianceCheck(
  agentRole: string,
  extractedDirectives: ReturnType<typeof extractDirectives>,
  transcriptDirPath: string,
  rrCount: number,
  scoreOnly: boolean,
): { score: number; grade: string } {
  const files = readdirSync(transcriptDirPath).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  if (files.length === 0) {
    console.error(`  No transcripts found in ${transcriptDirPath}`);
    return { score: 0, grade: "F" };
  }

  let lastScore = 0;
  let lastGrade = "F";
  for (const file of files) {
    const content = readFileSync(join(transcriptDirPath, file), "utf-8");
    const results = checkCompliance(extractedDirectives, content);
    const computed = computeScore(results);
    lastScore = computed.score;
    lastGrade = computed.grade;

    if (scoreOnly) {
      console.log(`${agentRole}: ${computed.grade} (${computed.score}%)`);
    } else {
      console.log(formatReport(agentRole, results, rrCount));
    }
  }
  return { score: lastScore, grade: lastGrade };
}

// ── Hill climb mode ──────────────────────────────────────

if (isHillClimb) {
  console.log(`\nHill climb mode: target=${targetScore}%, max=${MAX_ITERATIONS} iterations`);

  const hillClimbResult: HillClimbResult = {
    role,
    iterations: [],
    finalScore: 0,
    targetReached: false,
    targetScore,
  };

  if (transcriptDir) {
    // Hill climb with existing transcript directory
    const resolvedDir = resolve(transcriptDir);
    if (!existsSync(resolvedDir)) {
      console.error(`Transcript directory not found: ${resolvedDir}`);
      process.exit(1);
    }

    console.log(`\nRunning RepoRails on brief...`);
    const rrCount = runRepoRails(briefPath);

    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      console.log(`\nIteration ${i}/${MAX_ITERATIONS}:`);

      const files = readdirSync(resolvedDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
      if (files.length === 0) {
        console.error("  No agent transcripts found.");
        break;
      }

      const content = readFileSync(join(resolvedDir, files[files.length - 1]), "utf-8");
      const results = checkCompliance(directives, content);
      const iteration = buildIteration(i, results);
      hillClimbResult.iterations.push(iteration);
      hillClimbResult.finalScore = iteration.score;

      console.log(`  Score: ${iteration.grade} (${iteration.score}%) -- ${iteration.followed}/${iteration.checkable} followed`);

      if (isTargetReached(iteration.score, targetScore)) {
        hillClimbResult.targetReached = true;
        console.log(`  Target ${targetScore}% reached!`);
        break;
      }

      if (!canContinue(i)) {
        console.log(`  Max iterations (${MAX_ITERATIONS}) reached. ESCALATED-TO-MECHANICAL.`);
        break;
      }

      // Show recommendations for next iteration
      if (iteration.recommendations.length > 0) {
        console.log("  Recommendations:");
        for (const rec of iteration.recommendations.slice(0, 5)) {
          console.log(`    ${rec}`);
        }
      }
    }

    console.log(formatHillClimbReport(hillClimbResult));
  } else {
    // Hill climb with agent spawning — create worktree and iterate
    console.log("  Creating worktree for agent isolation...");
    const worktree = createWorktree({ projectRoot: ROOT });
    console.log(`  Worktree: ${worktree.worktreePath}`);

    try {
      const rrCount = runRepoRails(briefPath);

      for (let i = 1; i <= MAX_ITERATIONS; i++) {
        console.log(`\nIteration ${i}/${MAX_ITERATIONS}:`);

        const spawned = spawnAgent(worktree.worktreePath, role, task, worktree.transcriptDir);
        if (!spawned) {
          console.error("  Agent spawn failed, stopping hill climb.");
          break;
        }

        const { score } = runComplianceCheck(role, directives, worktree.transcriptDir, rrCount, isScoreOnly);
        const files = readdirSync(worktree.transcriptDir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
        const content = readFileSync(join(worktree.transcriptDir, files[files.length - 1]), "utf-8");
        const results = checkCompliance(directives, content);
        const iteration = buildIteration(i, results);
        hillClimbResult.iterations.push(iteration);
        hillClimbResult.finalScore = iteration.score;

        if (isTargetReached(iteration.score, targetScore)) {
          hillClimbResult.targetReached = true;
          console.log(`  Target ${targetScore}% reached!`);
          break;
        }

        if (!canContinue(i)) {
          console.log(`  Max iterations (${MAX_ITERATIONS}) reached. ESCALATED-TO-MECHANICAL.`);
          break;
        }

        if (iteration.recommendations.length > 0) {
          console.log("  Recommendations for next iteration:");
          for (const rec of iteration.recommendations.slice(0, 5)) {
            console.log(`    ${rec}`);
          }
        }
      }

      console.log(formatHillClimbReport(hillClimbResult));
    } finally {
      worktree.cleanup();
      console.log("  Worktree cleaned up.");
    }
  }

  process.exit(hillClimbResult.targetReached ? 0 : 1);
}

// ── Default: spawn agent in worktree and audit ──────────

console.log("\nExtracted directives:");
for (const d of directives) {
  console.log(`  L${d.line} [${d.type}] (${d.section}): ${d.text.substring(0, 70)}`);
}

if (isScoreOnly && !transcriptDir) {
  console.log(`\n${role}: pending (no transcript)`);
  console.log(`\nTo spawn agent: bun scripts/test-brief.ts ${role} "${task}"`);
} else if (!transcriptDir) {
  // Default mode: create worktree and spawn agent
  console.log("\nCreating worktree for agent isolation...");
  const worktree = createWorktree({ projectRoot: ROOT });
  console.log(`Worktree: ${worktree.worktreePath}`);
  console.log(`Transcript dir: ${worktree.transcriptDir}`);

  try {
    const spawned = spawnAgent(worktree.worktreePath, role, task, worktree.transcriptDir);
    if (spawned) {
      console.log("\nRunning RepoRails on brief...");
      const rrCount = runRepoRails(briefPath);
      runComplianceCheck(role, directives, worktree.transcriptDir, rrCount, isScoreOnly);
    } else {
      console.error("\nAgent spawn failed. To audit manually:");
      console.log(`  bun scripts/test-brief.ts ${role} "${task}" <transcript-dir>`);
    }
  } finally {
    worktree.cleanup();
    console.log("\nWorktree cleaned up.");
  }
}
