/**
 * #617 / #619 — the one place that decides what a top-level `docs/*.md`
 * contributes to the Documentation Routing table.
 *
 * ## What was wrong
 *
 * Both doc-routing sites ended with a "filter to non-obvious mappings":
 *
 *     return docRouting.filter(d => {
 *       const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "")
 *                          .toLowerCase().replace(/-/g, " ");
 *       return !d.need.toLowerCase().startsWith(slug)
 *           || d.need.includes("—") || d.need.includes("(");
 *     });
 *
 * `need` falls back to the filename with dashes turned into spaces when a
 * document carries no `governs:`, so `need === slug` and the row was dropped.
 * Measured on the asaCommandCenter consumer: **0 of 38 top-level `docs/*.md`
 * carried the field, so all 38 were dropped** — `ENVIRONMENTS.md` among them,
 * which cost a DA a false P1 on 2026-10-17 after it inferred the production
 * host rather than reading the document that names it in three places.
 *
 * The filter's instinct is right — `| environments | docs/ENVIRONMENTS.md |`
 * teaches nothing about *when* to read the file. Its action is wrong: dropping
 * the row does not produce a better row, it produces no evidence the document
 * exists. That is `.claude/rules/config-access.md`'s *Silent Default
 * Substitution* — **a document with no `governs:` is UNMEASURED, not
 * "governs nothing"**, and a dropped row is indistinguishable from a document
 * that was never written.
 *
 * ## What it does instead
 *
 * - Never drops a document for being quiet. The row is emitted with
 *   `NO_GOVERNS_MARKER` in front of the filename-derived description, so the
 *   gap reads as a to-do rather than as an answer — the same treatment
 *   `specs-routing.md` already gives a spec with no criteria.
 * - Exclusion is something a document declares **about itself**
 *   (`status: archived`, `routing: exclude`), not a string-similarity accident.
 *   Without a deliberate way out, every consumer gets rows it does not want
 *   and the next person widens the filter again.
 *
 * ## Why this is a module and not two edits
 *
 * `lib/scanner.ts` and `lib/scaffold/steps.ts` each held a complete copy of
 * this scan, each with its own inline `governs:` regex. #91 is what that costs:
 * the scaffold calls the steps.ts copy, so a fix to scanner.ts alone changed
 * no generated output at all while the scanner tests went green over the copy
 * nobody calls. Two deciders answering one question are behaviourally one —
 * a mutation of either leaves the other holding every case up, and both read
 * as covered (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * So there is exactly ONE decider here, `topLevelDocRoute`, and exactly one
 * frontmatter parser underneath it, `lib/frontmatter.ts` `parseFrontmatter`.
 * The obvious-mapping filter is deleted rather than kept-but-defeated: the
 * marker already contains an em dash, so leaving the filter in place would
 * make it dead code that no mutation could distinguish from live code.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./frontmatter";

export interface DocRoutingRow {
  need: string;
  file: string;
}

/**
 * The marker that makes an undiscoverable document visible. It leads the row
 * so a reader scanning the first column sees the gap without reading on.
 */
export const NO_GOVERNS_MARKER = "NO GOVERNS FIELD —";

/**
 * The frontmatter declarations by which a document takes itself out of the
 * routing table. One table, so there is one place to add a spelling and one
 * place to mutate.
 */
export const ROUTING_EXCLUSIONS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "status", value: "archived" },
  { key: "routing", value: "exclude" },
];

/** A `governs:` holding this is a placeholder, not a statement. */
const GOVERNS_PLACEHOLDER = "TODO";

export type DocRoutingReading = "GOVERNS" | "UNMEASURED";

export type TopLevelDocDecision =
  | { routed: true; need: string; reading: DocRoutingReading }
  | { routed: false; excludedBy: string };

/** `MAC-MINI-DEMO-SETUP.md` → `mac mini demo setup`. */
export function filenameDescription(filename: string): string {
  return filename.replace(/\.md$/, "").replace(/.*\//, "").replace(/-/g, " ").toLowerCase();
}

/**
 * The single decider: what, if anything, this document contributes.
 *
 * A frontmatter block `parseFrontmatter` refuses is UNMEASURED, never
 * excluded — silence from the parser must not read as a document opting out.
 */
export function topLevelDocRoute(filename: string, content: string): TopLevelDocDecision {
  const parsed = parseFrontmatter(content);
  const entries = parsed?.entries ?? [];
  const valueOf = (key: string): string | null => {
    const e = entries.find(x => x.key === key);
    return e ? e.inline.trim() : null;
  };

  for (const ex of ROUTING_EXCLUSIONS) {
    if (valueOf(ex.key)?.toLowerCase() === ex.value) {
      return { routed: false, excludedBy: `${ex.key}: ${ex.value}` };
    }
  }

  const governs = valueOf("governs");
  if (governs && governs !== GOVERNS_PLACEHOLDER) {
    return { routed: true, need: governs, reading: "GOVERNS" };
  }
  return {
    routed: true,
    need: `${NO_GOVERNS_MARKER} ${filenameDescription(filename)}`,
    reading: "UNMEASURED",
  };
}

/**
 * Every row `docs/` contributes: top-level documents, then subdirectories the
 * caller has not already listed as a category.
 *
 * The caller owns the categories because the two sites build that list from
 * their own configuration; everything else about the scan lives here.
 */
export function scanDocsDirectory(docsDir: string, categoryDirs: readonly string[]): DocRoutingRow[] {
  if (!existsSync(docsDir)) return [];
  const rows: DocRoutingRow[] = [];

  for (const f of readdirSync(docsDir).filter(f => f.endsWith(".md"))) {
    const decision = topLevelDocRoute(f, readFileSync(join(docsDir, f), "utf-8"));
    if (!decision.routed) continue;
    rows.push({ need: decision.need, file: `docs/${f}` });
  }

  const subDirs = readdirSync(docsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !categoryDirs.includes(`docs/${d.name}`))
    .map(d => d.name);
  for (const sub of subDirs) {
    const subFiles = readdirSync(join(docsDir, sub)).filter(f => f.endsWith(".md"));
    if (subFiles.length > 0) {
      rows.push({ need: `${sub} (${subFiles.length} files)`, file: `docs/${sub}/` });
    }
  }

  return rows;
}
