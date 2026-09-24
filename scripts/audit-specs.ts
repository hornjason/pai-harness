#!/usr/bin/env bun
/**
 * audit-specs — Scan spec files, classify SCs, optionally fix unmatched ones.
 *
 * Usage:
 *   bun scripts/audit-specs.ts .              # audit mode
 *   bun scripts/audit-specs.ts . --fix        # fix mode (rewrite in-place)
 *
 * Thin CLI consumer — core logic exported for testing.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseFrontmatter,
  matchPattern,
  isBehavioralSC,
  type ParsedSC,
} from "../lib/conformity";

// ── Types ─────────────────────────────────────────────────────

export interface SpecAuditResult {
  specFile: string;
  total: number;
  matched: number;
  unmatched: number;
  behavioral: number;
  compliance: "strict" | "permissive";
  matchedSCs: SCClassification[];
  unmatchedSCs: SCClassification[];
  behavioralSCs: SCClassification[];
}

export interface SCClassification {
  id: string;
  statement: string;
  category: "matched" | "unmatched" | "behavioral";
}

export interface RewriteEntry {
  scId: string;
  specFile: string;
  before: string;
  after: string;
  patternUsed: string;
  ambiguous: boolean;
}

export interface AuditResult {
  specs: SpecAuditResult[];
  totalSCs: number;
  totalMatched: number;
  totalUnmatched: number;
  totalBehavioral: number;
  strictUnmatched: number;
  rewrites?: RewriteEntry[];
}

// ── Registry loading ──────────────────────────────────────────

interface RegistryEntry {
  name: string;
  syntax: string;
  regex: string;
  example: string;
  notes: string;
}

let _registryCache: RegistryEntry[] | null = null;

function loadRegistry(): RegistryEntry[] {
  if (_registryCache) return _registryCache;
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "matcher-registry.json"
  );
  _registryCache = JSON.parse(readFileSync(configPath, "utf-8"));
  return _registryCache!;
}

// ── SC extraction ─────────────────────────────────────────────

function extractSCs(content: string, specFile: string): ParsedSC[] {
  const scs: ParsedSC[] = [];
  const pattern = /^- \[ \] (SC-\w+):\s*(.+)$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    scs.push({ id: match[1], statement: match[2].trim(), specFile });
  }
  return scs;
}

// ── Closest pattern matching for rewrites ─────────────────────

/**
 * Score how well an SC statement matches a registry pattern by
 * looking for keyword overlaps. Returns the best pattern name and
 * a generated rewrite, or null if nothing is close enough.
 */
function findClosestPattern(
  statement: string
): { patternName: string; rewrite: string; ambiguous: boolean } | null {
  const registry = loadRegistry();
  const lower = statement.toLowerCase();

  // Heuristic keyword rules per pattern — ordered by specificity
  const heuristics: Array<{
    pattern: string;
    keywords: string[];
    extractor: (stmt: string) => string | null;
  }> = [
    {
      pattern: "pointer-exists",
      keywords: ["pointer", "reference to", "contains reference"],
      extractor: (s) => {
        const m = s.match(/(?:file\s+)?(\S+\.?\w+)\s+(?:contains?|has|with)\s+(?:pointer|reference)\s+to\s+(\S+)/i);
        return m ? `${m[1]} exists with pointer to ${m[2]}` : null;
      },
    },
    {
      pattern: "content-contains",
      keywords: ["contains [", "includes ["],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:contains?|includes?)\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} contains [${m[2]}]` : null;
      },
    },
    {
      pattern: "content-not-contains",
      keywords: ["not contain", "must not have", "has no ["],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:must\s+not\s+contain|has\s+no)\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} must NOT contain [${m[2]}]` : null;
      },
    },
    {
      pattern: "dir-exists",
      keywords: ["directory"],
      extractor: (s) => {
        const m = s.match(/(?:the\s+)?(?:directory\s+)?(\S+?)\/?\s+(?:directory\s+)?(?:should\s+)?(?:be\s+present|exists?|is\s+present|must\s+exist)/i);
        if (m) return `${m[1].replace(/\/$/, "")}/ directory exists`;
        const m2 = s.match(/(?:directory|dir|folder)\s+(\S+?)\/?\s/i);
        if (m2) return `${m2[1].replace(/\/$/, "")}/ directory exists`;
        return null;
      },
    },
    {
      pattern: "file-exists",
      keywords: ["exist", "file", "present", "must be"],
      extractor: (s) => {
        // Match "file X exists" or "X should exist" or "X must exist" patterns
        const m = s.match(
          /(?:the\s+)?(?:file\s+)?(\S+\.\w+)\s+(?:should\s+|must\s+)?(?:exist|be\s+present)/i
        );
        if (m) return `${m[1]} exists`;
        // Match "exists" at end
        const m2 = s.match(/(\S+\.\w+)\s+exists/i);
        if (m2) return `${m2[1]} exists`;
        return null;
      },
    },
    {
      pattern: "section-exists",
      keywords: ["section", "heading"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+has\s+(?:a\s+)?section\s+(?:called\s+|named\s+)?\[([^\]]+)\]/i);
        return m ? `${m[1]} has section [${m[2]}]` : null;
      },
    },
    {
      pattern: "count-threshold",
      keywords: ["under", "at most", "lines", "words"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(?:is\s+under|at\s+most)\s+\[?(\d+)\]?\s+(lines?|words?)/i);
        return m ? `${m[1]} is under [${m[2]}] ${m[3]}` : null;
      },
    },
    {
      pattern: "json-field-equals",
      keywords: ["field equals"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+(\S+)\s+field\s+equals\s+\[([^\]]+)\]/i);
        return m ? `${m[1]} ${m[2]} field equals [${m[3]}]` : null;
      },
    },
    {
      pattern: "json-has-field",
      keywords: ["has field"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+has\s+field\s+(\S+)/i);
        return m ? `${m[1]} has field ${m[2]}` : null;
      },
    },
    {
      pattern: "frontmatter-field",
      keywords: ["frontmatter"],
      extractor: (s) => {
        const m = s.match(/(\S+)\s+frontmatter\s+has\s+(\S+)(?:\s*=\s*(.+))?/i);
        return m
          ? m[3]
            ? `${m[1]} frontmatter has ${m[2]} = ${m[3]}`
            : `${m[1]} frontmatter has ${m[2]}`
          : null;
      },
    },
    {
      pattern: "root-clean",
      keywords: ["root is clean", "clean root"],
      extractor: () => "root is clean",
    },
    {
      pattern: "paths-resolve",
      keywords: ["paths resolve", "links resolve"],
      extractor: (s) => {
        const m = s.match(/paths?\s+(?:referenced\s+)?in\s+(\S+)\s+resolve/i);
        return m ? `all paths referenced in ${m[1]} resolve` : null;
      },
    },
    {
      pattern: "all-specs-frontmatter",
      keywords: ["all specs", "frontmatter"],
      extractor: () => "all specs have frontmatter",
    },
    {
      pattern: "test-passes",
      keywords: ["bun test", "test passes"],
      extractor: () => "bun test passes",
    },
    {
      pattern: "canary",
      keywords: ["canary"],
      extractor: () => "canary test exists",
    },
  ];

  // Try each heuristic — first one whose extractor succeeds wins
  for (const h of heuristics) {
    // Check if any keyword matches
    const hasKeyword = h.keywords.some((k) => lower.includes(k));
    if (!hasKeyword) continue;

    const rewrite = h.extractor(statement);
    if (rewrite) {
      return { patternName: h.pattern, rewrite, ambiguous: false };
    }
  }

  // If no heuristic matched, try a loose file-exists match
  // Look for any filename-like token (word.ext) in the statement
  const fileToken = statement.match(/\b(\S+\.\w{1,5})\b/);
  if (fileToken) {
    return {
      patternName: "file-exists",
      rewrite: `${fileToken[1]} exists`,
      ambiguous: true,
    };
  }

  // Truly unresolvable
  return null;
}

// ── Core audit function ───────────────────────────────────────

export function auditSpecs(
  root: string,
  opts?: { fix?: boolean }
): AuditResult {
  const specsDir = join(root, "specs");
  const specs: SpecAuditResult[] = [];
  const rewrites: RewriteEntry[] = [];

  if (!existsSync(specsDir)) {
    return { specs, totalSCs: 0, totalMatched: 0, totalUnmatched: 0, totalBehavioral: 0, strictUnmatched: 0, rewrites };
  }

  const specFiles = readdirSync(specsDir).filter((f) => f.endsWith(".md"));

  for (const specFile of specFiles) {
    const filePath = join(specsDir, specFile);
    const content = readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);

    // Skip non-testable specs
    if (!fm || fm.testable !== "true") continue;

    const compliance: "strict" | "permissive" =
      fm.compliance === "permissive" ? "permissive" : "strict";

    const scs = extractSCs(content, specFile);
    const matchedSCs: SCClassification[] = [];
    const unmatchedSCs: SCClassification[] = [];
    const behavioralSCs: SCClassification[] = [];

    for (const sc of scs) {
      if (isBehavioralSC(sc)) {
        behavioralSCs.push({ id: sc.id, statement: sc.statement, category: "behavioral" });
      } else if (matchPattern(sc) !== null) {
        matchedSCs.push({ id: sc.id, statement: sc.statement, category: "matched" });
      } else {
        unmatchedSCs.push({ id: sc.id, statement: sc.statement, category: "unmatched" });
      }
    }

    specs.push({
      specFile,
      total: scs.length,
      matched: matchedSCs.length,
      unmatched: unmatchedSCs.length,
      behavioral: behavioralSCs.length,
      compliance,
      matchedSCs,
      unmatchedSCs,
      behavioralSCs,
    });

    // ── Fix mode: rewrite unmatched SCs in-place ──────────────
    if (opts?.fix && unmatchedSCs.length > 0) {
      let modified = content;
      let hasChanges = false;

      for (const usc of unmatchedSCs) {
        const closest = findClosestPattern(usc.statement);
        if (!closest) {
          // Can't rewrite — mark with REVIEW comment
          const scLinePattern = new RegExp(
            `^(- \\[ \\] ${usc.id}:\\s*)(.+)$`,
            "m"
          );
          const scMatch = modified.match(scLinePattern);
          if (scMatch) {
            const replacement = closest
              ? `${scMatch[1]}${closest.rewrite}`
              : `${scMatch[0]}\n<!-- REVIEW: original — ${usc.statement} -->`;
            modified = modified.replace(scLinePattern, replacement);
            hasChanges = true;
            rewrites.push({
              scId: usc.id,
              specFile,
              before: usc.statement,
              after: usc.statement, // unchanged
              patternUsed: "none",
              ambiguous: true,
            });
          }
          continue;
        }

        const scLinePattern = new RegExp(
          `^(- \\[ \\] ${usc.id}:\\s*)(.+)$`,
          "m"
        );
        const scMatch = modified.match(scLinePattern);
        if (scMatch) {
          let replacement = `${scMatch[1]}${closest.rewrite}`;
          if (closest.ambiguous) {
            replacement += `\n<!-- REVIEW: original — ${usc.statement} -->`;
          }
          modified = modified.replace(scLinePattern, replacement);
          hasChanges = true;
          rewrites.push({
            scId: usc.id,
            specFile,
            before: usc.statement,
            after: closest.rewrite,
            patternUsed: closest.patternName,
            ambiguous: closest.ambiguous,
          });
        }
      }

      if (hasChanges) {
        writeFileSync(filePath, modified);
      }
    }
  }

  const totalSCs = specs.reduce((sum, s) => sum + s.total, 0);
  const totalMatched = specs.reduce((sum, s) => sum + s.matched, 0);
  const totalUnmatched = specs.reduce((sum, s) => sum + s.unmatched, 0);
  const totalBehavioral = specs.reduce((sum, s) => sum + s.behavioral, 0);
  const strictUnmatched = specs
    .filter((s) => s.compliance === "strict")
    .reduce((sum, s) => sum + s.unmatched, 0);

  return { specs, totalSCs, totalMatched, totalUnmatched, totalBehavioral, strictUnmatched, rewrites };
}

// ── Report formatting ─────────────────────────────────────────

export function formatReport(result: AuditResult): string {
  const lines: string[] = [];
  lines.push("audit-specs report");
  lines.push("=".repeat(60));
  lines.push("");

  // Per-spec table
  lines.push(
    `${"Spec".padEnd(45)} ${"total".padEnd(6)} ${"matched".padEnd(8)} ${"unmatched".padEnd(10)} ${"behavioral".padEnd(10)}`
  );
  lines.push("-".repeat(80));

  for (const spec of result.specs) {
    lines.push(
      `${spec.specFile.padEnd(45)} ${String(spec.total).padEnd(6)} ${String(spec.matched).padEnd(8)} ${String(spec.unmatched).padEnd(10)} ${String(spec.behavioral).padEnd(10)}`
    );
  }

  lines.push("-".repeat(80));
  lines.push(
    `${"TOTAL".padEnd(45)} ${String(result.totalSCs).padEnd(6)} ${String(result.totalMatched).padEnd(8)} ${String(result.totalUnmatched).padEnd(10)} ${String(result.totalBehavioral).padEnd(10)}`
  );
  lines.push("");

  return lines.join("\n");
}

// ── Diff summary formatting ───────────────────────────────────

export function formatDiffSummary(result: AuditResult): string {
  const lines: string[] = [];

  if (!result.rewrites || result.rewrites.length === 0) {
    lines.push("No rewrites applied.");
    return lines.join("\n");
  }

  lines.push("Rewrite diff summary");
  lines.push("=".repeat(60));
  lines.push("");

  for (const r of result.rewrites) {
    lines.push(`${r.scId} (${r.specFile}):`);
    lines.push(`  before: ${r.before}`);
    lines.push(`  after:  ${r.after}`);
    lines.push(`  pattern: ${r.patternUsed}${r.ambiguous ? " (AMBIGUOUS — needs review)" : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── CLI entry point ───────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("-")) || ".";
  const fix = args.includes("--fix");

  if (!existsSync(root)) {
    console.error(`ERROR: Path does not exist: ${root}`);
    process.exit(1);
  }

  const result = auditSpecs(root, { fix });
  console.log(formatReport(result));

  if (fix && result.rewrites && result.rewrites.length > 0) {
    console.log(formatDiffSummary(result));
  }

  // Exit with non-zero if there are unmatched SCs in strict specs
  if (result.strictUnmatched > 0 && !fix) {
    process.exit(1);
  }
}
