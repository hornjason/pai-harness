/**
 * doc-routing.ts — the one decider for the top-level `docs/*.md` rows of the
 * Documentation Routing table (#617).
 *
 * ## What was wrong
 *
 * A document's row description came from its `governs:` frontmatter field and
 * fell back to the filename with dashes replaced by spaces. A similarity
 * filter then deleted any row whose description started with the file's own
 * slug — which the fallback description always does, exactly. So a document
 * with no `governs:` field was not given a weak row; it was given no row.
 *
 * Measured on hornjason/asaCommandCenter: zero of thirty-eight top-level docs
 * markdown files carry the field, so all thirty-eight were absent from the
 * table agents read to decide what to open — including ENVIRONMENTS.md, which
 * a DA never found before inferring the production topology wrong and filing a
 * false P1 saying production was down.
 *
 * ## Why a low-information row beats silence
 *
 * The filter's instinct was sound: `environments` next to
 * `docs/ENVIRONMENTS.md` teaches a reader nothing. But deleting the row does
 * not produce a better one, it produces no evidence the document exists. That
 * is *Silent Default Substitution* from `.claude/rules/config-access.md` — an
 * absent value recorded as UNMEASURED rather than quietly standing in for
 * success. So the row is emitted with a visible gap marker, following the
 * `STATES NO CRITERIA — ` precedent at lib/generators/agents-md.ts, and reads
 * as a to-do rather than as an answer.
 *
 * Dropping a row therefore needs a DECLARED reason: a document that should not
 * be routed says so in its own frontmatter with `status: archived`. Without a
 * route out, every consumer gains rows it does not want and the next
 * maintainer widens a similarity filter again, which is how this arose.
 *
 * ## One decider
 *
 * `lib/scanner.ts` and `lib/scaffold/steps.ts` each held a complete copy of
 * this scan, and the scaffold calls the second one — #91 fixed the scanner's
 * copy alone and changed no generated output at all. Both now call the
 * functions here, so there is a single binding to mutate.
 *
 * Frontmatter is read with `lib/frontmatter.ts`, never with a second regex: a
 * second parser is a second decider that no mutation of the first can reach.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "./frontmatter";
import type { DocRoute } from "./generators/types";

/** Marks a row whose description is the filename because the doc declares none. */
export const NO_GOVERNS_PREFIX = "NO GOVERNS FIELD — ";

/**
 * Frontmatter `status:` values that opt a document OUT of the routing table.
 *
 * This is the deliberate exclusion route that makes emitting weak rows safe.
 * It is a declaration by the document, not a guess about the document.
 */
export const UNROUTED_STATUSES = ["archived", "superseded", "historical"] as const;

/** `governs:` values that are placeholders rather than descriptions. */
const PLACEHOLDER_GOVERNS = ["todo", "tbd"];

function frontmatterValue(content: string, key: string): string | null {
  // Returns null for a block this module cannot represent, which means "do not
  // claim to know what it said" — not "it was empty".
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const entry = parsed.entries.find(e => e.key === key);
  return entry ? entry.inline.trim() : null;
}

/** The description a filename alone can support: `MAC-MINI-SETUP.md` → `MAC MINI SETUP`. */
export function filenameDescription(filename: string): string {
  return filename.replace(/\.md$/, "").replace(/-/g, " ");
}

/**
 * The routing row for one top-level docs markdown file, or null when the
 * document has declared itself out of the table.
 */
export function docRouteFor(filename: string, content: string): DocRoute | null {
  const status = (frontmatterValue(content, "status") ?? "").toLowerCase();
  if ((UNROUTED_STATUSES as readonly string[]).includes(status)) return null;

  const governs = frontmatterValue(content, "governs") ?? "";
  const need =
    governs !== "" && !PLACEHOLDER_GOVERNS.includes(governs.toLowerCase())
      ? governs
      : `${NO_GOVERNS_PREFIX}${filenameDescription(filename)}`;

  return { need, file: `docs/${filename}` };
}

/** Every routable top-level `docs/*.md` file, in directory order. */
export function topLevelDocRoutes(root: string): DocRoute[] {
  const docsDir = join(root, "docs");
  if (!existsSync(docsDir)) return [];
  const routes: DocRoute[] = [];
  for (const f of readdirSync(docsDir).filter(n => n.endsWith(".md"))) {
    const route = docRouteFor(f, readFileSync(join(docsDir, f), "utf-8"));
    if (route) routes.push(route);
  }
  return routes;
}

/**
 * Drop rows whose description only restates the filename — for every row the
 * caller has NOT exempted.
 *
 * `exemptFiles` is how the top-level docs rows stay in the table: their
 * exclusion is decided by `docRouteFor` reading the document, so a second
 * opinion taken from the shape of the text would silently overrule it. The
 * filter still applies to category and subdirectory rows, which nobody can
 * annotate with frontmatter.
 */
export function pruneObviousRoutes(rows: DocRoute[], exemptFiles: Set<string>): DocRoute[] {
  return rows.filter(d => {
    if (exemptFiles.has(d.file)) return true;
    const slug = d.file.replace(/\.md$/, "").replace(/.*\//, "").toLowerCase().replace(/-/g, " ");
    const needLower = d.need.toLowerCase();
    return !needLower.startsWith(slug) || d.need.includes("—") || d.need.includes("(");
  });
}
