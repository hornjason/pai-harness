#!/usr/bin/env bun
/**
 * Pre-computes goal data for the ship workflow.
 * Eliminates 2-3 LLM ceremony agents by doing deterministic work upfront.
 *
 * Usage: bun scripts/precompute-goal.ts --issue 48 --repo hornjason/pai-harness [--project-root .]
 * Output: JSON to stdout with { goalData, preflightResults?, preloadedContexts? }
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { resolve, join } from "path";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const issue = getArg("issue");
const repo = getArg("repo");
const projectRoot = resolve(getArg("project-root") || ".");

if (!issue || !repo) {
  console.error("Usage: bun scripts/precompute-goal.ts --issue N --repo owner/repo [--project-root .]");
  process.exit(1);
}

// ── 1. Read issue via gh CLI ──

const issueJson = JSON.parse(
  execFileSync("gh", ["issue", "view", issue, "--repo", repo, "--json", "title,body,labels"], {
    encoding: "utf-8",
    timeout: 15000,
  })
);

const title: string = issueJson.title;
const body: string = issueJson.body || "";
const labels: string[] = (issueJson.labels || []).map((l: any) => l.name);

// Extract goal: first paragraph of body
const goalMatch = body.match(/^(.+?)(?:\n\s*\n|^##)/ms);
const issueGoal = goalMatch ? goalMatch[1].trim() : title;

// Extract success criteria
const successCriteria: string[] = [];
const scPattern = /^-\s*\[[ x]\]\s*(SC-\d+:?\s*.+|.+)/gm;
let match;
while ((match = scPattern.exec(body)) !== null) {
  successCriteria.push(match[1].trim());
}

const goalData = { issueTitle: title, issueGoal, successCriteria, labels };

// ── 2. Pre-flight SSH checks ──

let preflightResults: Record<string, any> | undefined;
const configPath = join(projectRoot, ".claude/rungate.json");
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const remoteHosts = config.remoteHosts || {};
  if (Object.keys(remoteHosts).length > 0) {
    preflightResults = {};
    for (const [name, hostConfig] of Object.entries(remoteHosts) as [string, any][]) {
      if (!hostConfig.host) continue;
      const sshArgs = [
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        hostConfig.host,
        hostConfig.preFlightCmd || "hostname",
      ];
      try {
        const output = execFileSync("ssh", sshArgs, { encoding: "utf-8", timeout: 10000 }).trim();
        preflightResults[name] = { reachable: true, output, host: hostConfig.host, purpose: hostConfig.purpose };
      } catch (e: any) {
        preflightResults[name] = { reachable: false, output: e.stderr || e.message, host: hostConfig.host, purpose: hostConfig.purpose };
      }
    }
  }

  // ── 3. Preload brief contexts ──

  const roles = config.roles || {};
  const preloadedContexts: Record<string, { paths: string[]; rules: string[] }> = {};

  for (const [role, roleConfig] of Object.entries(roles) as [string, any][]) {
    const briefPath = roleConfig.brief
      ? join(projectRoot, roleConfig.brief)
      : join(projectRoot, `.claude/agents/${role}.md`);

    if (!existsSync(briefPath)) {
      preloadedContexts[role] = { paths: [], rules: [] };
      continue;
    }

    const briefContent = readFileSync(briefPath, "utf-8");

    // Extract context paths from ## Context section
    const paths: string[] = [];
    const contextMatch = briefContent.match(/^## Context\s*\n([\s\S]*?)(?=^## |\Z)/m);
    if (contextMatch) {
      const contextLines = contextMatch[1].split("\n");
      for (const line of contextLines) {
        const pathMatch = line.match(/[`"]?([/~][\w./-]+\.\w+)[`"]?/);
        if (pathMatch) paths.push(pathMatch[1]);
      }
    }

    // Extract reinforcement rules from YAML frontmatter tiers
    const rules: string[] = [];
    const fmMatch = briefContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      try {
        const reinforcementSections: string[] = [];
        // Try inline array format: reinforcement: ['Testing Rules', 'Other']
        const inlineMatch = fmMatch[1].match(/reinforcement:\s*\[([^\]]+)\]/);
        if (inlineMatch) {
          const items = inlineMatch[1].matchAll(/['"]([^'"]+)['"]/g);
          for (const item of items) reinforcementSections.push(item[1]);
        } else {
          // Try multi-line format: reinforcement:\n  - Testing Rules
          const multiMatch = fmMatch[1].match(/reinforcement:\s*\n((?:\s+-\s+.+\n)*)/);
          if (multiMatch) {
            const items = multiMatch[1].matchAll(/^\s+-\s+['"]?(.+?)['"]?\s*$/gm);
            for (const item of items) reinforcementSections.push(item[1]);
          }
        }
        for (const sectionName of reinforcementSections) {
          const sectionRegex = new RegExp(
            `^## ${sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n## |\\Z)`,
            "m"
          );
          const sectionMatch = briefContent.match(sectionRegex);
          if (sectionMatch) {
            const lines = sectionMatch[1].split("\n");
            let seenBlank = false;
            for (const line of lines) {
              if (line.trim() === "") { seenBlank = true; continue; }
              if (seenBlank) break;
              const ruleMatch = line.match(/^\s*[-*\d.]+\s+(.+)/);
              if (ruleMatch) rules.push(ruleMatch[1].trim());
            }
          }
        }
      } catch {
        // Parse failure — skip reinforcement
      }
    }

    preloadedContexts[role] = { paths, rules };
  }

  // ── 4. Prior branch detection ──
  let priorBranch: { branch: string; commitCount: number } | undefined;
  try {
    const priorResult = execSync(
      `bun -e "import {detectPriorBranch} from '${resolve(projectRoot)}/node_modules/@anthropic-ai/claude-code/lib/prior-branch.ts'; void 0;" 2>/dev/null || echo '{}'`,
      { encoding: "utf-8", timeout: 10000, cwd: projectRoot }
    ).trim();
    // Prior branch detection requires harness lib — try direct import
    const harnessRoot = getArg("harness-root") || resolve(projectRoot);
    const detectResult = execSync(
      `bun -e "import {detectPriorBranch} from '${harnessRoot}/lib/prior-branch.ts'; const r = await detectPriorBranch({issueNumber:${issue},projectRoot:'${resolve(projectRoot)}',runTests:false}); console.log(JSON.stringify(r))" 2>/dev/null || echo '{"branch":"","commitCount":0}'`,
      { encoding: "utf-8", timeout: 15000, cwd: projectRoot }
    ).trim();
    const parsed = JSON.parse(detectResult);
    if (parsed.branch) {
      priorBranch = { branch: parsed.branch, commitCount: parsed.commitCount || 0 };
    }
  } catch {
    // Prior branch detection failed — workflow will fall back to agent
  }

  console.log(JSON.stringify({ goalData, preflightResults, preloadedContexts, priorBranch }, null, 2));
} else {
  console.log(JSON.stringify({ goalData }, null, 2));
}
