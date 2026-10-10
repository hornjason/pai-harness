#!/usr/bin/env bun
/**
 * Pre-computes goal data for the ship workflow.
 * Eliminates 2-3 LLM ceremony agents by doing deterministic work upfront.
 *
 * Usage: bun scripts/precompute-goal.ts --issue 48 --repo hornjason/pai-harness [--project-root .]
 * Output: JSON to stdout with { goalData, preflightResults?, preloadedContexts? }
 *
 * GOAL SELECTION (#202). `issueGoal` used to be the first paragraph of the body
 * verbatim, and the harness writes its own paragraphs above that one: the
 * decomposition step PREPENDS a rescope banner to a parent issue and opens every
 * sub-issue body with "Parent: #N". Measured twice on 2026-10-09 — #200 came
 * back as 414 characters describing the split, #201 as the literal string
 * "Parent: #200", 12 characters — and gates/brief-assembler.ts turns this field
 * into Marcus's "## Task **Goal:**" line, so both runs would have briefed the
 * split instead of the defect. The banners are only written on the LARGE
 * rescoped issues, which is where the goal matters most.
 *
 * The fix is here rather than in the banner format: consumer repos have their
 * own conventions, and a parser that only works against this harness's current
 * wording is not a parser. And a goal that resolves to nothing is REFUSED, not
 * returned short — "short goal" and "no goal" were the same state, which is how
 * 12 characters reached a brief without anything going red.
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { resolve, join } from "path";

// ── Goal selection (#202) ────────────────────────────────────────────────

/**
 * The one exit code every refusal goes through.
 *
 * Declared once and used once, so test/precompute-goal.test.ts can build a copy
 * of this file with it set to 0 and prove each refusal is this script saying no
 * rather than something else failing by coincidence
 * (.claude/rules/checks-must-be-able-to-fail.md). This file has no relative
 * imports, which is what lets that copy run from a temp directory.
 */
export const GOAL_REFUSE_EXIT = 1;

/**
 * Leading paragraphs the harness writes above an issue's problem statement.
 *
 * Named literally, because the alternative — "a leading blockquote is
 * metadata" — is a detector WIDER than what it detects: it would eat a
 * blockquote an author wrote as their problem statement, and the banner test
 * would still be green. The phrase is what makes a paragraph the harness's.
 *
 * `instructedIn` is the generator that writes the phrase verbatim. The test
 * "banner phrases still match what the harness writes" greps each one out of
 * that file, so rewording the decomposition prompt turns red here instead of
 * silently restoring the bug this constant exists to fix.
 */
export const HARNESS_BANNERS: ReadonlyArray<{ phrase: string; instructedIn?: string }> = [
  { phrase: "Rescoped to Phase", instructedIn: "workflows/ship.js" },
  { phrase: "Parent: #", instructedIn: "workflows/ship.js" },
  { phrase: "Spec:", instructedIn: "workflows/ship.js" },
  // Observed in the bodies the decomposition step produced on #200. ship.js
  // asks for "the sub-issue numbers" in prose, so there is no literal in the
  // generator to couple this one to.
  { phrase: "Sub-issues:" },
];

/** The bar a paragraph clears to be a problem statement rather than a label. */
export const GOAL_MIN_WORDS = 4;
export const GOAL_MIN_CHARS = 20;

/**
 * A line with its blockquote marker and leading bold/italic run removed.
 *
 * Stripping rather than rejecting is the whole design: "> **Rescoped to Phase 1
 * only.**" and "Rescoped to Phase 1 only" are the same banner, and a blockquote
 * carrying neither is somebody's prose.
 */
function unquote(line: string): string {
  return line.replace(/^[ \t]*>+[ \t]?/, "").replace(/^[*_]{1,2}/, "").trimStart();
}

/** Paragraph text as one line, blockquote markers removed. */
function flatten(paragraph: string): string {
  return paragraph.split("\n").map(unquote).join(" ").trim();
}

/**
 * The body's prose paragraphs, in order.
 *
 * Headings, bullets, checkboxes, tables, fenced code and HTML comments are not
 * problem statements. The old regex had no such filter, so a body opening with
 * "## Problem" returned "## Problem" as the goal.
 */
function proseParagraphs(body: string): string[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/^(#{1,6}\s)/gm, "\n$1");
  const out: string[] = [];
  for (const raw of normalized.split(/\n[ \t]*\n+/)) {
    const para = raw.trim();
    if (!para) continue;
    const first = unquote(para.split("\n")[0]);
    if (/^(#{1,6}\s|[-+*]\s|\d+[.)]\s|\||```|<!--|<)/.test(first)) continue;
    out.push(para);
  }
  return out;
}

/** Whether a paragraph is one the harness wrote, not one the author wrote. */
function isHarnessBanner(paragraph: string): boolean {
  return paragraph
    .split("\n")
    .some((line) => HARNESS_BANNERS.some((b) => unquote(line).startsWith(b.phrase)));
}

/**
 * Drop the harness's own leading paragraphs (#202).
 *
 * Leading only. A later paragraph that happens to cite a parent issue is the
 * author talking about one; the banner is the thing sitting on top of the
 * problem statement.
 */
export function skipBanner(paragraphs: string[]): string[] {
  let i = 0;
  while (i < paragraphs.length && isHarnessBanner(paragraphs[i])) i++;
  return paragraphs.slice(i);
}

/**
 * The issue's goal, or the reason there isn't one.
 *
 * Refusing is half the fix. `issueGoal` is `z.string().min(1)` in
 * gates/schema.ts, so an empty string validates and travels; only a non-zero
 * exit stops a run that has nothing to brief anyone with.
 */
export function selectGoal(body: string): { goal: string } | { refusal: string } {
  const prose = proseParagraphs(body);
  const kept = skipBanner(prose);

  if (kept.length === 0) {
    const dropped = prose.length > 0 ? ` (${prose.length} leading paragraph(s) were harness metadata: ` +
      `"${flatten(prose[0]).slice(0, 60)}")` : "";
    return {
      refusal: "the issue body has no problem statement — only headings, lists " +
        `and harness metadata${dropped}. Write one paragraph saying what is wrong.`,
    };
  }

  const goal = kept[0];
  const flat = flatten(goal);
  const words = flat.split(/\s+/).filter(Boolean).length;
  if (flat.length < GOAL_MIN_CHARS || words < GOAL_MIN_WORDS) {
    return {
      refusal: `the issue body's first paragraph is not a goal: "${flat}" ` +
        `(${flat.length} characters, ${words} words; the bar is ${GOAL_MIN_CHARS} and ${GOAL_MIN_WORDS}).`,
    };
  }

  return { goal };
}

// ── Script ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function refuse(message: string): never {
  console.error(`precompute-goal: ${message}`);
  process.exit(GOAL_REFUSE_EXIT);
  // Unreachable with the real constant; reached by the mutant copy, which must
  // not fall through into the rest of the script.
  throw new Error(message);
}

if (import.meta.main) {
  const issue = getArg("issue");
  const repo = getArg("repo");
  const projectRoot = resolve(getArg("project-root") || ".");

  if (!issue || !repo) {
    refuse("Usage: bun scripts/precompute-goal.ts --issue N --repo owner/repo [--project-root .]");
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

  // Extract goal: first prose paragraph that is not harness metadata (#202).
  // No fallback to the title — the title ships in its own field, and quietly
  // substituting it is what made a missing goal indistinguishable from one.
  const selected = selectGoal(body);
  if ("refusal" in selected) {
    refuse(`issue #${issue}: ${selected.refusal}`);
  }
  const issueGoal = selected.goal;

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
    // refName is the git-resolvable ref; branch is the bare push target (#164).
    // commitCount is null when git could not count — not 0, which would claim
    // the prior branch holds nothing.
    let priorBranch: { branch: string; refName: string; commitCount: number | null } | undefined;
    try {
      const priorResult = execSync(
        `bun -e "import {detectPriorBranch} from '${resolve(projectRoot)}/node_modules/@anthropic-ai/claude-code/lib/prior-branch.ts'; void 0;" 2>/dev/null || echo '{}'`,
        { encoding: "utf-8", timeout: 10000, cwd: projectRoot }
      ).trim();
      // Prior branch detection requires harness lib — try direct import
      const harnessRoot = getArg("harness-root") || resolve(projectRoot);
      const detectResult = execSync(
        `bun -e "import {detectPriorBranch} from '${harnessRoot}/lib/prior-branch.ts'; const r = await detectPriorBranch({issueNumber:${issue},projectRoot:'${resolve(projectRoot)}',runTests:false}); console.log(JSON.stringify(r))" 2>/dev/null || echo '{"branch":"","refName":"","commitCount":null}'`,
        { encoding: "utf-8", timeout: 15000, cwd: projectRoot }
      ).trim();
      const parsed = JSON.parse(detectResult);
      if (parsed.branch) {
        priorBranch = {
          branch: parsed.branch,
          refName: parsed.refName || parsed.branch,
          commitCount: parsed.commitCount ?? null,
        };
      }
    } catch {
      // Prior branch detection failed — workflow will fall back to agent
    }

    console.log(JSON.stringify({ goalData, preflightResults, preloadedContexts, priorBranch }, null, 2));
  } else {
    console.log(JSON.stringify({ goalData }, null, 2));
  }
}
