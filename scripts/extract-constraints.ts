#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";
import { SIGNAL_PHRASE_PATTERNS } from "../lib/conformity";

// ── Types ────────────────────────────────────────────────────────

export interface Candidate {
  rule: string;
  source: string;
  context: string;
  hash: string;
}

export interface StalenessEntry {
  file: string;
  daysSince: number;
  threshold: number;
  type: string;
}

export interface ExtractResult {
  candidates: Candidate[];
  deduped: {
    existingConstraints: number;
    rejectedPrior: number;
    candidatesRemoved: number;
  };
  staleness: StalenessEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────

export function contentHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function surroundingContext(lines: string[], lineIdx: number): string {
  const start = Math.max(0, lineIdx - 1);
  const end = Math.min(lines.length, lineIdx + 2);
  return lines.slice(start, end).join("\n");
}

function collectScanTargets(projectPath: string): string[] {
  const targets: string[] = [];

  const rootFiles = ["ARCHITECTURE.md", "PRINCIPLES.md", "CONTRIBUTING.md", "CLAUDE.md"];
  for (const f of rootFiles) {
    const p = join(projectPath, f);
    if (existsSync(p)) targets.push(p);
  }

  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) {
      if (f === "archive" || !f.endsWith(".md")) continue;
      targets.push(join(docsDir, f));
    }
    const adrDir = join(docsDir, "adr");
    if (existsSync(adrDir)) {
      for (const f of readdirSync(adrDir)) {
        if (!f.endsWith(".md")) continue;
        targets.push(join(adrDir, f));
      }
    }
  }

  const specsDir = join(projectPath, "specs");
  if (existsSync(specsDir)) {
    for (const f of readdirSync(specsDir)) {
      if (!f.endsWith(".md")) continue;
      targets.push(join(specsDir, f));
    }
  }

  return targets;
}

function extractSignalPhrases(content: string, filePath: string, projectPath: string): Candidate[] {
  const lines = content.split("\n");
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const rel = relative(projectPath, filePath);

  for (const pattern of SIGNAL_PHRASE_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of content.matchAll(re)) {
      const rule = m[0].replace(/^[-*] /, "").trim().replace(/[.;]$/, "");
      if (!rule || rule.length < 10) continue;
      const hash = contentHash(rule);
      if (seen.has(hash)) continue;
      seen.add(hash);

      const matchOffset = m.index ?? 0;
      const lineIdx = content.slice(0, matchOffset).split("\n").length - 1;
      const lineNum = lineIdx + 1;

      candidates.push({
        rule,
        source: `${rel}:${lineNum}`,
        context: surroundingContext(lines, lineIdx),
        hash,
      });
    }
  }

  return candidates;
}

function loadExistingConstraints(projectPath: string): string[] {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return [];
  const content = readFileSync(agentsPath, "utf-8");
  const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!hcMatch) return [];
  return hcMatch[1]
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- \*\*[^*]+\*\*\s*—?\s*/, "").trim().toLowerCase());
}

function loadRejectedHashes(projectPath: string): Set<string> {
  const rejectedPath = join(projectPath, "reference", "rejected-constraints.md");
  if (!existsSync(rejectedPath)) return new Set();
  const content = readFileSync(rejectedPath, "utf-8");
  const hashes = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*([a-f0-9]+)\s*\|/);
    if (m) hashes.add(m[1]);
  }
  return hashes;
}

function computeStaleness(projectPath: string, files: string[]): StalenessEntry[] {
  const stale: StalenessEntry[] = [];
  for (const filePath of files) {
    const rel = relative(projectPath, filePath);
    const isAdr = rel.includes("docs/adr/") || /ADR/i.test(rel);
    if (isAdr) continue;
    try {
      const result = Bun.spawnSync(["git", "-C", projectPath, "log", "-1", "--format=%ci", "--", rel], { timeout: 5_000 });
      const dateStr = result.stdout.toString().trim().split(" ")[0];
      if (!dateStr) continue;
      const daysSince = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
      const isSpec = rel.startsWith("specs/");
      const threshold = isSpec ? 90 : 180;
      const type = isSpec ? "spec" : "guide";
      if (daysSince > threshold) {
        stale.push({ file: rel, daysSince: Math.floor(daysSince), threshold, type });
      }
    } catch {}
  }
  return stale;
}

function applyToAgentsMd(projectPath: string, candidates: Candidate[]): void {
  const agentsPath = join(projectPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return;
  let content = readFileSync(agentsPath, "utf-8");

  const formatted = candidates
    .map((c) => {
      const short = c.rule.length > 60 ? c.rule.slice(0, 57) + "..." : c.rule;
      return `- **${short}** (${c.source})`;
    })
    .join("\n");

  const markerStart = "<!-- BEGIN AUTO-EXTRACTED -->";
  const markerEnd = "<!-- END AUTO-EXTRACTED -->";

  if (content.includes(markerStart)) {
    content = content.replace(
      new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`),
      `${markerStart}\n${formatted}\n${markerEnd}`
    );
  } else {
    const hcMatch = content.match(/## Hard Constraints[^\n]*\n\n/);
    if (hcMatch) {
      const insertPos = (hcMatch.index ?? 0) + hcMatch[0].length;
      content =
        content.slice(0, insertPos) +
        `${markerStart}\n${formatted}\n${markerEnd}\n\n` +
        content.slice(insertPos);
    }
  }

  writeFileSync(agentsPath, content);
}

// ── Main export ──────────────────────────────────────────────────

export async function extractConstraints(
  projectPath: string,
  options?: { apply?: boolean }
): Promise<ExtractResult> {
  const scanFiles = collectScanTargets(projectPath);
  const existingConstraints = loadExistingConstraints(projectPath);
  const rejectedHashes = loadRejectedHashes(projectPath);

  let allCandidates: Candidate[] = [];
  for (const filePath of scanFiles) {
    const content = readFileSync(filePath, "utf-8");
    allCandidates.push(...extractSignalPhrases(content, filePath, projectPath));
  }

  const beforeCount = allCandidates.length;
  let existingRemoved = 0;
  let rejectedRemoved = 0;

  allCandidates = allCandidates.filter((c) => {
    if (rejectedHashes.has(c.hash)) {
      rejectedRemoved++;
      return false;
    }
    const lower = c.rule.toLowerCase();
    if (existingConstraints.some((ec) => lower.includes(ec) || ec.includes(lower))) {
      existingRemoved++;
      return false;
    }
    return true;
  });

  const staleness = computeStaleness(projectPath, scanFiles);

  if (options?.apply && allCandidates.length > 0) {
    applyToAgentsMd(projectPath, allCandidates);
  }

  return {
    candidates: allCandidates,
    deduped: {
      existingConstraints: existingRemoved,
      rejectedPrior: rejectedRemoved,
      candidatesRemoved: existingRemoved + rejectedRemoved,
    },
    staleness,
  };
}

// ── CLI entry ────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const projectPath = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");

  if (!projectPath) {
    console.error("Usage: extract-constraints.ts /path/to/project [--apply]");
    process.exit(1);
  }

  if (!existsSync(projectPath)) {
    console.error(`ERROR: Path does not exist: ${projectPath}`);
    process.exit(1);
  }

  const result = await extractConstraints(projectPath, { apply });
  console.log(JSON.stringify(result, null, 2));
}
