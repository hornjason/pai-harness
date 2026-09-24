#!/usr/bin/env bun
/**
 * Scan for stale issues — open GitHub issues whose phase SCs are all done.
 * Mechanical replacement for the agent-based scanner in ship.js.
 *
 * Usage:
 *   bun scripts/scan-stale-issues.ts [--dry-run] [--repo owner/repo] [--exclude 123]
 */
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

interface SC { id: string; what: string; done: boolean }
interface Phase { name: string; scs: SC[]; note?: string }
interface ProjectState { phases: Phase[] }

export interface ScanResult {
  scanned: number;
  staleFound: number;
  closed: number[];
  dryRun: boolean;
}

function extractIssueNumbers(phaseName: string): number[] {
  const matches = phaseName.match(/#(\d+)/g);
  if (!matches) return [];
  return matches.map(m => parseInt(m.replace("#", ""), 10));
}

function isPhaseComplete(phase: Phase): boolean {
  if (phase.scs.length === 0) return false;
  return phase.scs.every(sc => sc.done);
}

function checkIssueOpen(issueNum: number, repo: string): boolean {
  const result = spawnSync("gh", [
    "issue", "view", String(issueNum),
    "--repo", repo,
    "--json", "state",
    "--jq", ".state",
  ], { encoding: "utf-8", timeout: 15_000 });
  return result.stdout?.trim() === "OPEN";
}

function closeIssue(issueNum: number, repo: string): boolean {
  const result = spawnSync("gh", [
    "issue", "close", String(issueNum),
    "--repo", repo,
    "--comment", "Auto-closed: all SCs in phase are done.",
  ], { encoding: "utf-8", timeout: 15_000 });
  return result.status === 0;
}

export function scanStaleIssues(opts: {
  projectRoot?: string;
  repo?: string;
  exclude?: number[];
  dryRun?: boolean;
}): ScanResult {
  const root = opts.projectRoot || ROOT;
  const repo = opts.repo || "hornjason/pai-config";
  const exclude = new Set(opts.exclude || []);
  const dryRun = opts.dryRun ?? false;

  const stateFile = join(root, "project-state.json");
  const state: ProjectState = JSON.parse(readFileSync(stateFile, "utf-8"));

  const completedIssues: number[] = [];
  for (const phase of state.phases) {
    if (!isPhaseComplete(phase)) continue;
    const issues = extractIssueNumbers(phase.name);
    for (const num of issues) {
      if (!exclude.has(num)) completedIssues.push(num);
    }
  }

  const closed: number[] = [];
  let scanned = 0;
  for (const num of completedIssues) {
    scanned++;
    if (!checkIssueOpen(num, repo)) continue;
    if (dryRun) {
      console.log(`Would close #${num}`);
      closed.push(num);
    } else {
      if (closeIssue(num, repo)) {
        console.log(`Closed #${num}`);
        closed.push(num);
      } else {
        console.error(`Failed to close #${num}`);
      }
    }
  }

  return { scanned, staleFound: closed.length, closed, dryRun };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : undefined;
  const excludeIdx = args.indexOf("--exclude");
  const exclude = excludeIdx >= 0 ? [parseInt(args[excludeIdx + 1], 10)] : [];

  const result = scanStaleIssues({ dryRun, repo, exclude });
  console.log(`\nScanned: ${result.scanned}, Stale: ${result.staleFound}, Closed: ${result.closed.join(", ") || "none"}`);
}
