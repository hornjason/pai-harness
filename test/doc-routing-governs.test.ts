/**
 * #617 — the routing table must not drop a document for having nothing to say.
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-8 (#617) and AC-6 (#619).
 *
 * `scanDocRouting`'s last step filtered out "obvious mappings" — a row whose
 * description starts with its own filename. A top-level `docs/*.md` with no
 * `governs:` falls back to exactly that, so every such document was removed
 * from the only table that tells an agent the document exists. Measured on the
 * asaCommandCenter consumer: 0 of 38 carried the field, so all 38 vanished.
 *
 * A document with no `governs:` is UNMEASURED, not "governs nothing". The row
 * is emitted with a visible marker; exclusion is something a document declares
 * about itself.
 *
 * ## Why this file drives BOTH sites through one fixture
 *
 * #91 is the precedent and the warning: `lib/scaffold/steps.ts` holds a second
 * copy of this scan and it is the one the scaffold actually calls, so a fix to
 * `lib/scanner.ts` alone changed no generated output at all while the scanner
 * tests went green over the copy nobody calls. Every assertion here is made
 * twice — once against `scanProject`, once against the `.claude/rules/docs-routing.md`
 * a reader opens — and the two must agree (AC-8).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanProject } from "../lib/scanner";
import { generateAgentsMdContent } from "../lib/scaffold/steps";
import { NO_GOVERNS_MARKER, topLevelDocRoute } from "../lib/doc-routing";
import { structuralCut } from "../lib/source-slice";
import { stripJsComments } from "../lib/strip-js-comments";

// ── Fixtures ───────────────────────────────────────────────────

/** No frontmatter at all. The 38-of-38 shape. */
const NO_GOVERNS = "# Environments\n\nWhich host serves production.\n";

/** A real `governs:`. AC-5's case. */
const WITH_GOVERNS =
  "---\ndoc-type: guide\ngoverns: Environment tiers, hosts and promotion rule\n---\n\n# Demo env\n";

/**
 * AC-3's case, and AC-4's negative control is DERIVED from it rather than
 * written beside it (#585): two hand-written literals can diverge in a second
 * dimension and the pair then measures neither. `ARCHIVED_LINE` is removed and
 * the derivation is asserted, so the only difference between the two fixtures
 * is the line this feature reads.
 */
const ARCHIVED_LINE = "status: archived";
const ARCHIVED = `---\ndoc-type: guide\n${ARCHIVED_LINE}\n---\n\n# Superseded\n`;
const ARCHIVED_CONTROL = ARCHIVED.split("\n").filter(l => l !== ARCHIVED_LINE).join("\n");

/** The other opt-out, so each spelling has an input only it can reach. */
const ROUTING_EXCLUDE = "---\ndoc-type: guide\nrouting: exclude\n---\n\n# Not routed\n";

function buildFixture(docs: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "doc-routing-617-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "routing-fixture" }));
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    writeFileSync(join(root, "docs", name), content);
  }
  return root;
}

/** The rows the scanner produces, as `need` keyed by `file`. */
function scannerRows(root: string): Map<string, string> {
  return new Map(scanProject(root).docRouting.map(d => [d.file, d.need]));
}

/**
 * The rows in the artifact a reader opens, parsed out of the generated rule
 * file. This is the scaffold's own copy of the scan, via the only path that
 * writes it.
 */
function generatedRows(root: string): Map<string, string> {
  const actions: string[] = [];
  generateAgentsMdContent(root, "code", actions);
  const rulePath = join(root, ".claude", "rules", "docs-routing.md");
  if (!existsSync(rulePath)) throw new Error("the scaffold wrote no docs-routing.md — nothing to read");
  const rows = new Map<string, string>();
  for (const line of readFileSync(rulePath, "utf-8").split("\n")) {
    const m = /^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*$/.exec(line);
    if (m) rows.set(m[2], m[1]);
  }
  if (rows.size === 0) {
    // An empty table answers every "is this absent" question with yes. A
    // reading taken off one is UNMEASURED, not a clean result.
    throw new Error("the generated routing table has no rows at all — the reading is UNMEASURED");
  }
  return rows;
}

/**
 * The control string. `CODE-MAP.md` is pushed unconditionally by both sites
 * before any document is read, so its absence means the instrument stopped
 * reporting rather than that the table is correct.
 */
function assertInstrumentReporting(rows: Map<string, string>, where: string): void {
  expect(rows.has("CODE-MAP.md"), `${where}: the unconditional CODE-MAP.md row is missing`).toBe(true);
}

// ── Cases ──────────────────────────────────────────────────────

describe("#617: a document with no governs: is UNMEASURED, not absent", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
  });
  function fixture(docs: Record<string, string>): string {
    const root = buildFixture(docs);
    roots.push(root);
    return root;
  }

  test("AC-1: a top-level doc with no governs: field produces exactly one row", () => {
    const root = fixture({ "ENVIRONMENTS.md": NO_GOVERNS });

    const scanned = scanProject(root).docRouting.filter(d => d.file === "docs/ENVIRONMENTS.md");
    expect(scanned.length, "scanner rows for docs/ENVIRONMENTS.md").toBe(1);

    const generated = generatedRows(root);
    assertInstrumentReporting(generated, "generated");
    expect(generated.has("docs/ENVIRONMENTS.md"), "the generated table omits docs/ENVIRONMENTS.md").toBe(true);
  });

  test("AC-2: the row for a doc with no governs: carries a visible gap marker", () => {
    const root = fixture({ "ENVIRONMENTS.md": NO_GOVERNS });

    const need = scannerRows(root).get("docs/ENVIRONMENTS.md");
    expect(need, "scanner need for docs/ENVIRONMENTS.md").toBeDefined();
    expect(need!.startsWith(NO_GOVERNS_MARKER), `need was ${JSON.stringify(need)}`).toBe(true);
    // The filename-derived description survives behind the marker — the row
    // still has to tell a reader what the document is called.
    expect(need).toContain("environments");

    expect(generatedRows(root).get("docs/ENVIRONMENTS.md")).toBe(need!);
  });

  test("AC-3: a doc declaring status: archived produces no row", () => {
    const root = fixture({ "SUPERSEDED.md": ARCHIVED, "ENVIRONMENTS.md": NO_GOVERNS });

    // The fixture is on disk, so "no row" cannot be satisfied by the document
    // not being there (#500: a fixture must not reach its assertion by a route
    // that bypasses the feature).
    expect(existsSync(join(root, "docs", "SUPERSEDED.md"))).toBe(true);

    const scanned = scannerRows(root);
    assertInstrumentReporting(scanned, "scanner");
    expect(scanned.has("docs/ENVIRONMENTS.md"), "the sibling row proves the scan reached this directory").toBe(true);
    expect(scanned.has("docs/SUPERSEDED.md")).toBe(false);

    const generated = generatedRows(root);
    assertInstrumentReporting(generated, "generated");
    expect(generated.has("docs/ENVIRONMENTS.md")).toBe(true);
    expect(generated.has("docs/SUPERSEDED.md")).toBe(false);
  });

  test("AC-4: the negative control — the identical fixture without the status line produces one row", () => {
    // The derivation, asserted. Without this the pair is two literals and the
    // next edit touches one of them.
    expect(ARCHIVED.split("\n").length - ARCHIVED_CONTROL.split("\n").length).toBe(1);
    const removed = ARCHIVED.split("\n").filter(l => !ARCHIVED_CONTROL.split("\n").includes(l));
    expect(removed).toEqual([ARCHIVED_LINE]);

    const root = fixture({ "SUPERSEDED.md": ARCHIVED_CONTROL });

    const scanned = scannerRows(root);
    assertInstrumentReporting(scanned, "scanner");
    expect(scanned.has("docs/SUPERSEDED.md"), "the archived-status twin without the status line").toBe(true);

    const generated = generatedRows(root);
    assertInstrumentReporting(generated, "generated");
    expect(generated.has("docs/SUPERSEDED.md")).toBe(true);
  });

  test("AC-3b: routing: exclude is the other opt-out, and it reaches the same decision", () => {
    const root = fixture({ "NOT-ROUTED.md": ROUTING_EXCLUDE, "ENVIRONMENTS.md": NO_GOVERNS });

    const scanned = scannerRows(root);
    expect(scanned.has("docs/ENVIRONMENTS.md")).toBe(true);
    expect(scanned.has("docs/NOT-ROUTED.md")).toBe(false);
    expect(generatedRows(root).has("docs/NOT-ROUTED.md")).toBe(false);
  });

  test("AC-5: a doc with a real governs: renders that text, unprefixed", () => {
    const root = fixture({ "DEMO-ENV.md": WITH_GOVERNS });

    const need = scannerRows(root).get("docs/DEMO-ENV.md");
    expect(need).toBe("Environment tiers, hosts and promotion rule");
    expect(need!.startsWith(NO_GOVERNS_MARKER)).toBe(false);

    expect(generatedRows(root).get("docs/DEMO-ENV.md")).toBe("Environment tiers, hosts and promotion rule");
  });

  test("AC-8: the scaffold copy agrees with the scanner on every fixture at once", () => {
    const root = fixture({
      "ENVIRONMENTS.md": NO_GOVERNS,
      "DEMO-ENV.md": WITH_GOVERNS,
      "SUPERSEDED.md": ARCHIVED,
      "NOT-ROUTED.md": ROUTING_EXCLUDE,
    });

    const scanned = scannerRows(root);
    const generated = generatedRows(root);
    assertInstrumentReporting(scanned, "scanner");
    assertInstrumentReporting(generated, "generated");

    // Agreement on the four documents by name, rather than on set size — a
    // count is satisfied by any four rows (#532: ask whether the defect
    // changes the number or only the membership).
    for (const f of ["docs/ENVIRONMENTS.md", "docs/DEMO-ENV.md", "docs/SUPERSEDED.md", "docs/NOT-ROUTED.md"]) {
      expect(generated.get(f), `generated row for ${f}`).toBe(scanned.get(f) as any);
    }
    expect(scanned.get("docs/ENVIRONMENTS.md")!.startsWith(NO_GOVERNS_MARKER)).toBe(true);
    expect(scanned.get("docs/DEMO-ENV.md")).toBe("Environment tiers, hosts and promotion rule");
    expect(scanned.has("docs/SUPERSEDED.md")).toBe(false);
    expect(scanned.has("docs/NOT-ROUTED.md")).toBe(false);
  });
});

describe("#619: one parser, one decider", () => {
  test("AC-6: neither doc-routing site reads frontmatter with its own inline regex", () => {
    // Text-asserted rather than behaviourally compared, because two parsers
    // that agree on every fixture are behaviourally ONE and no behavioural
    // case can tell them apart — a mutation of either leaves the other
    // holding every case up (.claude/rules/checks-must-be-able-to-fail.md,
    // fourth shape).
    //
    // Cut the region the claim is about, structurally (#664). scanner.ts has
    // a second `governs:` regex in its SPEC scan, which this claim is not
    // about and which a whole-document search would report.
    const scanner = readFileSync(join(import.meta.dir, "..", "lib", "scanner.ts"), "utf-8");
    const steps = readFileSync(join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"), "utf-8");

    const sites: Array<[string, string]> = [
      ["lib/scanner.ts", structuralCut(scanner, "function scanDocRouting(", { balanced: "{" })],
      [
        "lib/scaffold/steps.ts",
        structuralCut(steps, "const docRouting: Array<{ need: string; file: string }> = [];", {
          endAnchor: "const consumers = harness?.consumers",
        }),
      ],
    ];

    for (const [rel, raw] of sites) {
      expect(raw.length, `${rel}: the cut is empty, so it contains nothing by construction`).toBeGreaterThan(0);
      expect(raw, `${rel} does not call the shared scanDocsDirectory`).toContain("scanDocsDirectory(");
      // Comments stripped: the replacement is documented in prose that names
      // the regex it replaced, and a detector that cannot tell prose from code
      // reports the explanation as the defect (#235).
      const cut = stripJsComments(raw);
      expect(cut.length, `${rel}: nothing left after stripping comments`).toBeGreaterThan(0);
      expect(cut, `${rel} still carries its own inline governs: regex`).not.toContain("governs:");
      expect(cut, `${rel} still carries its own frontmatter regex`).not.toContain("^---\\n(");
      expect(cut, `${rel} still carries the obvious-mapping filter`).not.toContain("startsWith(slug)");
    }

    const shared = readFileSync(join(import.meta.dir, "..", "lib", "doc-routing.ts"), "utf-8");
    expect(shared).toContain('from "./frontmatter"');
    expect(shared).toContain("parseFrontmatter(content)");
  });

  test("AC-6b: the decision is one binding, and it is the one both sites reach", () => {
    // Exercised directly, so a mutation of it has a witness that does not go
    // through either call site.
    expect(topLevelDocRoute("ENVIRONMENTS.md", NO_GOVERNS)).toEqual({
      routed: true,
      need: `${NO_GOVERNS_MARKER} environments`,
      reading: "UNMEASURED",
    });
    expect(topLevelDocRoute("DEMO-ENV.md", WITH_GOVERNS)).toEqual({
      routed: true,
      need: "Environment tiers, hosts and promotion rule",
      reading: "GOVERNS",
    });
    expect(topLevelDocRoute("SUPERSEDED.md", ARCHIVED)).toEqual({ routed: false, excludedBy: "status: archived" });
    expect(topLevelDocRoute("NOT-ROUTED.md", ROUTING_EXCLUDE)).toEqual({ routed: false, excludedBy: "routing: exclude" });
  });

  test("AC-6c: a frontmatter block the shared parser refuses is UNMEASURED, not excluded", () => {
    // parseFrontmatter returns null on a shape it cannot represent. Silence
    // from the parser must not read as "this document opted out".
    const unparseable = "---\nnot a key line at column zero\ngoverns: never read\n---\n\n# x\n";
    expect(topLevelDocRoute("WEIRD.md", unparseable)).toEqual({
      routed: true,
      need: `${NO_GOVERNS_MARKER} weird`,
      reading: "UNMEASURED",
    });
  });
});
