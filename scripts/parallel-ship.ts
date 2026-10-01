#!/usr/bin/env bun

import { execSync, spawn } from "child_process";
import { rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ShipJob {
  issue: number;
  worktreePath: string;
  port: number;
  containerName: string;
  status: "pending" | "running" | "done" | "failed";
}

export function createShipWorktree(projectRoot: string, issue: number): string {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  cleanupShipWorktree(projectRoot, issue);

  execSync(`git worktree add -b ${branchName} ${worktreePath} main`, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  return worktreePath;
}

export function allocatePort(index: number, basePort: number = 7776): number {
  return basePort + index;
}

export function generateContainerName(slug: string, issue: number): string {
  return `${slug}-test-${issue}`;
}

export function cleanupShipWorktree(projectRoot: string, issue: number): void {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
  try { execSync(`git worktree remove ${worktreePath} --force`, { cwd: projectRoot, stdio: "pipe" }); } catch {}
  try { execSync(`git branch -D ${branchName}`, { cwd: projectRoot, stdio: "pipe" }); } catch {}
}

function getProjectSlug(projectRoot: string): string {
  const configPath = join(projectRoot, ".claude", "rungate.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (config.project) return config.project;
  }
  return "project";
}

function launchShipSession(job: ShipJob): void {
  const cmd = "claude";
  const args = ["--bg", "--project", job.worktreePath, `/ship ${job.issue}`];

  console.log(`  Launching: ${cmd} ${args.join(" ")}`);

  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  job.status = "running";
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage:");
    console.error("  bun scripts/parallel-ship.ts <issue1> <issue2> ...   # ship issues in parallel");
    console.error("  bun scripts/parallel-ship.ts cleanup <issue1> ...    # clean up worktrees");
    console.error("  bun scripts/parallel-ship.ts status                  # show running sessions");
    console.error("  bun scripts/parallel-ship.ts dry-run <issue1> ...    # preview without launching");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const slug = getProjectSlug(projectRoot);

  if (args[0] === "cleanup") {
    const issues = args.slice(1).map((a) => parseInt(a, 10));
    if (issues.length === 0) {
      console.error("Usage: bun scripts/parallel-ship.ts cleanup <issue1> <issue2> ...");
      process.exit(1);
    }
    for (const issue of issues) {
      console.log(`Cleaning up ship-${issue}...`);
      cleanupShipWorktree(projectRoot, issue);
    }
    console.log("Done.");
    return;
  }

  if (args[0] === "status") {
    try {
      execSync("claude agents", { stdio: "inherit" });
    } catch {
      console.log("No running claude sessions found (or claude CLI not available).");
    }
    return;
  }

  const dryRun = args[0] === "dry-run";
  const issueArgs = dryRun ? args.slice(1) : args;
  const issues = issueArgs.map((arg) => parseInt(arg, 10)).filter((n) => !isNaN(n));

  if (issues.length === 0) {
    console.error("No valid issue numbers provided.");
    process.exit(1);
  }

  const jobs: ShipJob[] = issues.map((issue, index) => ({
    issue,
    worktreePath: createShipWorktree(projectRoot, issue),
    port: allocatePort(index),
    containerName: generateContainerName(slug, issue),
    status: "pending" as const,
  }));

  console.log(`\n=== Parallel Ship: ${jobs.length} issue(s) ===\n`);

  for (const job of jobs) {
    console.log(`Issue #${job.issue}:`);
    console.log(`  Worktree: ${job.worktreePath}`);
    console.log(`  Port: ${job.port}`);
    console.log(`  Container: ${job.containerName}`);

    if (dryRun) {
      console.log(`  [dry-run] Would launch: claude --bg --project ${job.worktreePath} "/ship ${job.issue}"`);
    } else {
      launchShipSession(job);
    }
    console.log();
  }

  if (!dryRun) {
    console.log("All sessions launched. Monitor with:");
    console.log("  claude agents");
    console.log("\nCleanup when done:");
    console.log(`  bun scripts/parallel-ship.ts cleanup ${issues.join(" ")}`);
  }
}

if (import.meta.main) {
  main();
}
