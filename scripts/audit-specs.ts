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
  /**
   * Set when the line was DELIBERATELY left alone (#426), carrying why.
   * `before === after` alone cannot say this: it is also what a rewrite that
   * happened to be a no-op looks like, and the caller reports the two
   * differently.
   */
  kept?: string;
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
    /** All keywords must be present, not any one of them (#586). */
    requireAll?: boolean;
    /** The extractor ignores its argument, so it cannot be unambiguous (#586). */
    constant?: boolean;
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
      // #586: `requireAll`, because the keyword test below is `some` and the
      // bare word `frontmatter` was firing a rule about ALL SPECS. It turned
      // `Baseline rules carry no paths: key in frontmatter` into
      // `all specs have frontmatter` — a different, weaker property.
      // "all specs" is the phrase that scopes this rule; "frontmatter" is
      // the phrase it shares with every other frontmatter criterion.
      requireAll: true,
      keywords: ["all specs", "frontmatter"],
      extractor: () => "all specs have frontmatter",
      /**
       * The extractor never reads its argument, so it cannot know what the
       * criterion said. #586: that is precisely when the original must be
       * kept in the file, and this rule claimed `ambiguous: false` — the
       * one flag that suppresses the `<!-- REVIEW: original — … -->` marker.
       */
      constant: true,
    },
    {
      pattern: "canary",
      keywords: ["canary"],
      extractor: () => "canary test exists",
      constant: true,
    },
  ];

  // Try each heuristic — first one whose extractor succeeds wins
  for (const h of heuristics) {
    const hasKeyword = h.requireAll
      ? h.keywords.every((k) => lower.includes(k))
      : h.keywords.some((k) => lower.includes(k));
    if (!hasKeyword) continue;

    const rewrite = h.extractor(statement);
    if (rewrite) {
      // A constant extractor is ambiguous BY CONSTRUCTION. Marking it
      // otherwise discards the original from the file in the only case where
      // nothing can reconstruct it.
      return { patternName: h.pattern, rewrite, ambiguous: h.constant === true };
    }
  }

  // If no heuristic matched, try a loose file-exists match.
  //
  // #586: and only where the criterion is ABOUT the file existing. This
  // fallback fires on any filename-like token anywhere in the sentence, so
  // it was turning behaviour into presence:
  //
  //   "Rejecting a promoted rule writes its hash to
  //    `reference/rejected-constraints.md` and it is never re-promoted"
  //      -> "reference/rejected-constraints.md exists"
  //
  //   "Makefile targets, `package.json` scripts and CI workflow files are
  //    scanned for constraints alongside markdown"
  //      -> "package.json exists"
  //
  // Both keep a word from the original — the filename — so the
  // distinguishing-terms guard in `decideRewrite` passes them, and both
  // discard the entire requirement. A filename a criterion MENTIONS is not
  // what the criterion is about, which is `lib/spec-listing.ts`'s "a mention
  // is not a listing" arriving in a third place.
  //
  // The narrowing is to the case the fallback was for: a short statement
  // whose verb is existence. Anything else is reported as unmatched and kept
  // intact, which is #426's path and the honest answer — a criterion the
  // registry cannot express needs a pattern or a human, not a downgrade.
  const fileToken = statement.match(/\b(\S+\.\w{1,5})\b/);
  const isAboutExistence =
    /\b(exists?|is present|are present|is created|has been created|must exist)\b/i.test(statement);
  if (fileToken && isAboutExistence) {
    return {
      patternName: "file-exists",
      rewrite: `${fileToken[1]} exists`,
      ambiguous: true,
    };
  }

  // Truly unresolvable
  return null;
}

// ── Whether to rewrite at all, and into what (#426) ───────────

/**
 * A file-ish leading token: `workflows/ship.js`, `AGENTS.md`, `specs/X.md`.
 *
 * Anchored, because the question is whether the statement OPENS by naming
 * its target. A filename mentioned halfway through a sentence of prose is
 * not a structured criterion, and treating it as one is how
 * `findClosestPattern`'s last resort turns a whole criterion into
 * `foo.ts exists`.
 */
function leadingFileToken(statement: string): string | null {
  const m = /^(\S*[./]\S*)\s/.exec(statement);
  return m ? m[1]! : null;
}

/** The prose after the em dash — the part that says why the criterion exists. */
function rationaleOf(statement: string): string | null {
  const m = /\s+—\s+(.+)$/.exec(statement);
  return m ? m[1]!.trim() : null;
}

/**
 * Is this already written in the structured grammar?
 *
 * A target named up front and a bracketed payload. That is the authored
 * shape of every matcher in `config/matcher-registry.json` that takes one —
 * `contains [...]`, `not contains [...]`, `is under [N] lines`,
 * `has field [x]` — and it is deliberately asked of the SHAPE rather than
 * by running the registry.
 *
 * The distinction matters: SC-1469 is structured and the registry did not
 * recognise it, because `content-not-contains` accepted `must NOT contain`
 * and `has no` but not the `not contains` form the compound matcher's own
 * example uses. Asking the registry would therefore have answered "rewrite
 * it", which is the bug. A matcher gap is a matcher gap; it is not a licence
 * to delete what the author wrote.
 */
export function alreadyStructured(statement: string): boolean {
  return leadingFileToken(statement) !== null && /\[[^\]]+\]/.test(statement);
}

export type RewriteDecision =
  | { kind: "keep"; reason: string }
  | { kind: "rewrite"; statement: string };

/**
 * What `--fix` may do to one SC line (#426).
 *
 * `scaffold . --fix` is the documented way to take a harness update, and it
 * was rewriting SC-1469 on every run into
 * `not contains [s.environments.prod.rebuild = 'PASS']` — dropping both the
 * file the criterion is about and the whole rationale clause, silently, under
 * a summary line naming `ci.yml`.
 *
 * Three rules, and the third is the one that makes this a fix rather than a
 * patch over one line:
 *
 *   1. A statement already in the structured grammar is never rewritten.
 *   2. A rewrite that would drop the file the criterion names is refused
 *      outright. `findClosestPattern`'s last resort collapses anything with a
 *      filename in it to `<file> exists`, which is an assertion that holds
 *      vacuously against a file that obviously exists.
 *   3. A rewrite that survives both carries the em-dash rationale across.
 *
 * One exported binding, so there is exactly one thing to mutate.
 */
export function decideRewrite(
  statement: string,
  closest: { patternName: string; rewrite: string; ambiguous: boolean } | null,
): RewriteDecision {
  if (alreadyStructured(statement)) {
    return { kind: "keep", reason: "already a structured criterion — a matcher gap is not a licence to rewrite it" };
  }
  if (!closest) {
    return { kind: "keep", reason: "no registry pattern was close enough" };
  }

  const file = leadingFileToken(statement);
  if (file !== null && !closest.rewrite.includes(file)) {
    return {
      kind: "keep",
      reason: `rewriting as ${closest.patternName} would drop the file ${file} the criterion names`,
    };
  }

  // #586: the fourth guard, and the general one. The three above protect
  // specific things — a structured line, a missing pattern, a named file.
  // This one asks the question they are each a special case of: **does the
  // rewrite still say what the criterion was about?**
  //
  // It exists because the three above all passed on
  // `Baseline rules carry no paths: key in frontmatter`, which was rewritten
  // to `all specs have frontmatter`. Nothing of the original survived and no
  // guard was looking at that.
  const kept = distinguishingTerms(statement).filter(t =>
    closest.rewrite.toLowerCase().includes(t),
  );
  if (distinguishingTerms(statement).length > 0 && kept.length === 0) {
    return {
      kind: "keep",
      reason:
        `rewriting as ${closest.patternName} would drop every distinguishing term the ` +
        `criterion uses (${distinguishingTerms(statement).join(", ")}) — the rewrite would be ` +
        `about something else`,
    };
  }

  const rationale = rationaleOf(statement);
  const rewritten = rationale ? `${closest.rewrite} — ${rationale}` : closest.rewrite;
  if (rewritten === statement) {
    return { kind: "keep", reason: "the rewrite is what is already written" };
  }
  return { kind: "rewrite", statement: rewritten };
}

/**
 * The words that say what THIS criterion is about (#586).
 *
 * Deliberately not "every word": a rewrite legitimately drops grammar, and
 * the term that caused the heuristic to fire is shared with every other
 * criterion the heuristic matches. Counting the MATCHED keyword as retained
 * content is how a constant rewrite reads as a faithful one — the proxy
 * standing in for the property, which `.claude/rules/checks-must-be-able-to-fail.md`
 * names as the trap in wording a refusal.
 *
 * So: lowercase alphanumeric tokens of four characters or more, minus
 * stopwords, minus the vocabulary every registry pattern already uses.
 */
const REWRITE_STOPWORDS = new Set([
  "that", "this", "with", "from", "have", "has", "does", "must", "will", "when",
  "then", "than", "each", "every", "into", "over", "under", "about", "there",
  "their", "which", "where", "while", "been", "being", "they", "them", "than",
  // The registry's own vocabulary. A rewrite keeping only these has kept
  // nothing specific to the criterion it replaced.
  "frontmatter", "specs", "spec", "exists", "contains", "canary", "test",
  "tests", "file", "files", "all", "none",
]);

export function distinguishingTerms(statement: string): string[] {
  const words = statement.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(words)].filter(w => !REWRITE_STOPWORDS.has(w));
}

/**
 * `findClosestPattern`, exported so a test can drive the real decision.
 *
 * One binding (#586). A test that reimplemented the heuristic walk would
 * agree with it right up until somebody changed one of them.
 */
export function closestPatternFor(
  statement: string,
): { patternName: string; rewrite: string; ambiguous: boolean } | null {
  return findClosestPattern(statement);
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
        const decision = decideRewrite(usc.statement, closest);

        const scLinePattern = new RegExp(`^(- \\[ \\] ${usc.id}:\\s*)(.+)$`, "m");
        const scMatch = modified.match(scLinePattern);
        if (!scMatch) continue;

        // #426: a line we decline to rewrite keeps its text exactly. The
        // REVIEW marker records that the matcher could not bind it — which
        // is a coverage gap worth seeing — without the line itself losing
        // the file it names or the prose that says why it exists.
        if (decision.kind === "keep") {
          const marker = `<!-- REVIEW: unmatched (${decision.reason}) -->`;
          if (!modified.includes(marker)) {
            modified = modified.replace(scLinePattern, `${scMatch[0]}\n${marker}`);
            hasChanges = true;
          }
          rewrites.push({
            scId: usc.id,
            specFile,
            before: usc.statement,
            after: usc.statement, // unchanged, and that is the point
            patternUsed: closest?.patternName ?? "none",
            ambiguous: true,
            kept: decision.reason,
          });
          continue;
        }

        let replacement = `${scMatch[1]}${decision.statement}`;
        if (closest!.ambiguous) {
          replacement += `\n<!-- REVIEW: original — ${usc.statement} -->`;
        }
        modified = modified.replace(scLinePattern, replacement);
        hasChanges = true;
        rewrites.push({
          scId: usc.id,
          specFile,
          before: usc.statement,
          after: decision.statement,
          patternUsed: closest!.patternName,
          ambiguous: closest!.ambiguous,
        });
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
