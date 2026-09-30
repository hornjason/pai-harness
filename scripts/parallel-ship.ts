#!/usr/bin/env bun

import { execSync } from "child_process";
import { rmSync } from "fs";

export interface ShipJob {
  issue: number;
  worktreePath: string;
  port: number;
  containerName: string;
  status: "pending" | "running" | "done" | "failed";
}

/**
 * Creates a git worktree for an issue at /tmp/ship-{issue}
 * @param projectRoot - The root directory of the git repository
 * @param issue - The issue number
 * @returns The path to the created worktree
 */
export function createShipWorktree(projectRoot: string, issue: number): string {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  // Clean up existing worktree/branch if it exists
  cleanupShipWorktree(projectRoot, issue);

  // Create worktree branching from main
  execSync(`git worktree add -b ${branchName} ${worktreePath} main`, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  return worktreePath;
}

/**
 * Allocates a port for an issue based on its index
 * @param index - The index of the issue (0-based)
 * @param basePort - The base port number (default: 7776)
 * @returns The allocated port number
 */
export function allocatePort(index: number, basePort: number = 7776): number {
  return basePort + index;
}

/**
 * Generates a container name for an issue
 * @param slug - The project slug
 * @param issue - The issue number
 * @returns The container name
 */
export function generateContainerName(slug: string, issue: number): string {
  return `${slug}-test-${issue}`;
}

/**
 * Cleans up a ship worktree and its associated branch
 * @param projectRoot - The root directory of the git repository
 * @param issue - The issue number
 */
export function cleanupShipWorktree(projectRoot: string, issue: number): void {
  const worktreePath = `/tmp/ship-${issue}`;
  const branchName = `ship-${issue}`;

  // Remove worktree directory if it exists
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch (error) {
    // Directory may not exist, continue
  }

  // Remove worktree from git
  try {
    execSync(`git worktree remove ${worktreePath} --force`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (error) {
    // Worktree may not exist, continue
  }

  // Delete branch
  try {
    execSync(`git branch -D ${branchName}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (error) {
    // Branch may not exist, continue
  }
}

/**
 * Main function - orchestrates parallel ship jobs
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun scripts/parallel-ship.ts <issue1> <issue2> ...");
    process.exit(1);
  }

  const issues = args.map((arg) => parseInt(arg, 10));
  const projectRoot = process.cwd();

  // TODO: Get slug from project config
  const slug = "rungate";

  const jobs: ShipJob[] = issues.map((issue, index) => ({
    issue,
    worktreePath: createShipWorktree(projectRoot, issue),
    port: allocatePort(index),
    containerName: generateContainerName(slug, issue),
    status: "pending" as const,
  }));

  console.log("\n=== Parallel Ship Jobs ===\n");

  for (const job of jobs) {
    console.log(`Issue #${job.issue}:`);
    console.log(`  Worktree: ${job.worktreePath}`);
    console.log(`  Port: ${job.port}`);
    console.log(`  Container: ${job.containerName}`);
    console.log(
      `  Command: claude --bg --project ${job.worktreePath} "/ship ${job.issue}"`
    );
    console.log();
  }

  console.log("=== Cleanup Commands ===\n");
  console.log("To clean up worktrees when done:");
  for (const job of jobs) {
    console.log(`  bun scripts/parallel-ship.ts cleanup ${job.issue}`);
  }
  console.log();
}

// Run main if this is the entry point
if (import.meta.main) {
  main();
}
