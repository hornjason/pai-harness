/**
 * Documentation Routing keeps a document that has no `governs` field (#617).
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-8.
 *
 * The defect: `scanDocRouting` gave a top-level `docs/*.md` file with no
 * `governs:` frontmatter a description equal to its own slug, and the
 * similarity filter below then deleted every row whose description started
 * with that slug. On hornjason/asaCommandCenter that is 38 of 38 documents,
 * so ENVIRONMENTS.md was absent from the table a DA reads to decide what to
 * open, and the DA inferred the production topology instead.
 *
 * Silence is not better than a low-information row — that is
 * `.claude/rules/config-access.md`'s Silent Default Substitution, and the
 * answer there is the same as here: record the gap as a gap. The row is
 * emitted with a `NO GOVERNS FIELD — ` prefix, following the
 * `STATES NO CRITERIA — ` precedent in lib/generators/agents-md.ts, and a
 * document that genuinely should not be routed declares `status: archived`
 * in its own frontmatter.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { scanProject } from "../lib/scanner";
import { generateAgentsMdContent } from "../lib/scaffold/steps";
import { NO_GOVERNS_PREFIX } from "../lib/doc-routing";
import type { DocRoute } from "../lib/generators/types";

/**
 * The archived fixture, and the negative control derived FROM it.
 *
 * The control is not written out a second time by hand: a pair that varies
 * two things at once measures neither
 * (`.claude/rules/checks-must-be-able-to-fail.md`), and two hand-written
 * literals are exactly how a second difference creeps in. The derivation is
 * asserted below — same line count minus one, and the one missing line is
 * the status line.
 */
const ARCHIVED_DOC = `---
doc-type: reference
status: archived
---

# Old Environments

Superseded by ENVIRONMENTS.md.
`;

const CONTROL_DOC = ARCHIVED_DOC.split("\n")
  .filter(l => l.trim() !== "status: archived")
  .join("\n");

const GOVERNS_DOC = `---
doc-type: reference
governs: Where production runs
---

# Environments
`;

const NO_GOVERNS_DOC = `---
doc-type: reference
---

# Environments

Which host serves production.
`;

let tmpDir: string;
let seq = 0;

function project(docs: Record<string, string>): string {
  const root = join(tmpDir, `p${seq++}`);
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "routing-fixture" }));
  for (const [file, content] of Object.entries(docs)) {
    writeFileSync(join(root, "docs", file), content);
  }
  return root;
}

/** The rows the SCANNER produces for top-level `docs/*.md` files. */
function scannerRows(root: string): DocRoute[] {
  return scanProject(root).docRouting.filter(d => /^docs\/[^/]+\.md$/.test(d.file));
}

/**
 * The rows the SCAFFOLD produces, read back out of the artifact a reader
 * actually opens — `.claude/rules/docs-routing.md` — rather than out of the
 * scan object. steps.ts holds its own copy of this scan, and #91 is the
 * precedent: fixing scanner.ts alone changed no generated output at all.
 */
function scaffoldRows(root: string): DocRoute[] {
  const actions: string[] = [];
  generateAgentsMdContent(root, "code", actions);
  const rulePath = join(root, ".claude", "rules", "docs-routing.md");
  if (!existsSync(rulePath)) throw new Error("the scaffold wrote no docs-routing.md");
  const rows: DocRoute[] = [];
  for (const line of readFileSync(rulePath, "utf-8").split("\n")) {
    const m = line.match(/^\|\s*(.*?)\s*\|\s*`(docs\/[^/`]+\.md)`\s*\|$/);
    if (m) rows.push({ need: m[1], file: m[2] });
  }
  return rows;
}

describe("#617: a docs file with no governs field keeps its routing row", () => {
  beforeEach(() => {
    tmpDir = join(tmpdir(), `doc-routing-governs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // AC-1
  test("a document with no governs field appears in the routing table", () => {
    const rows = scannerRows(project({ "ENVIRONMENTS.md": NO_GOVERNS_DOC }));
    expect(rows.map(r => r.file)).toEqual(["docs/ENVIRONMENTS.md"]);
    expect(rows.length).toBe(1);
  });

  // AC-2
  test("that row is marked as lacking a description rather than answering", () => {
    const rows = scannerRows(project({ "ENVIRONMENTS.md": NO_GOVERNS_DOC }));
    expect(rows.length).toBe(1);
    expect(rows[0].need).toBe(`${NO_GOVERNS_PREFIX}ENVIRONMENTS`);
    expect(rows[0].need.startsWith("NO GOVERNS FIELD — ")).toBe(true);
  });

  // AC-2 — a file with no frontmatter block at all is the same gap.
  test("a document with no frontmatter block at all is marked the same way", () => {
    const rows = scannerRows(project({ "MAC-MINI-DEMO-SETUP.md": "# Setup\n" }));
    expect(rows.map(r => r.need)).toEqual([`${NO_GOVERNS_PREFIX}MAC MINI DEMO SETUP`]);
  });

  // AC-3
  test("a document whose frontmatter declares an archived status is excluded", () => {
    const rows = scannerRows(project({ "OLD-ENVIRONMENTS.md": ARCHIVED_DOC }));
    expect(rows).toEqual([]);
  });

  // AC-4 — the negative control. Without it, AC-3 passes for any reason that
  // makes the document invisible, including the fixture never being written.
  test("negative control: the identical fixture without the status line appears", () => {
    // The pair differs in the status line and in nothing else, and that is
    // asserted rather than eyeballed.
    const archivedLines = ARCHIVED_DOC.split("\n");
    const controlLines = CONTROL_DOC.split("\n");
    expect(controlLines.length).toBe(archivedLines.length - 1);
    const missing = archivedLines.filter(l => !controlLines.includes(l));
    expect(missing).toEqual(["status: archived"]);

    const rows = scannerRows(project({ "OLD-ENVIRONMENTS.md": CONTROL_DOC }));
    expect(rows.map(r => r.file)).toEqual(["docs/OLD-ENVIRONMENTS.md"]);
    expect(rows[0].need).toBe(`${NO_GOVERNS_PREFIX}OLD ENVIRONMENTS`);
  });

  // AC-5
  test("a real governs field renders unprefixed", () => {
    const rows = scannerRows(project({ "ENVIRONMENTS.md": GOVERNS_DOC }));
    expect(rows.map(r => r.need)).toEqual(["Where production runs"]);
    expect(rows[0].need.includes("NO GOVERNS FIELD")).toBe(false);
  });

  // The fix has two parts that both keep a row alive, and
  // `.claude/rules/checks-must-be-able-to-fail.md` calls two deciders that
  // agree behaviourally one. They are kept apart by giving each an input only
  // it can reach:
  //
  //  - only the PREFIX can satisfy the assertions above on the row's text;
  //  - only the pruning EXEMPTION can satisfy this one. The description here
  //    is a real governs field, so it carries no em dash to ride past the
  //    similarity filter, and it restates the filename — which is precisely
  //    what that filter deletes. Measured: removing the exemption turns this
  //    case, and only this case, red.
  test("a real governs field that restates the filename is still not pruned", () => {
    const doc = "---\ngoverns: Environments\n---\n\n# Environments\n";
    const rows = scannerRows(project({ "ENVIRONMENTS.md": doc }));
    expect(rows.map(r => r.need)).toEqual(["Environments"]);
  });

  // AC-8 — the scaffold holds its own copy of this scan and it is the copy
  // that writes the rule file. Comparing two empty lists would pass over a
  // generator that emits nothing, so the expected row COUNT of each fixture
  // is asserted on both sides before the two are compared.
  test("the scaffold copy agrees with the scanner on all three fixtures", () => {
    const fixtures: Array<{ label: string; doc: string; rows: number }> = [
      { label: "no governs", doc: NO_GOVERNS_DOC, rows: 1 },
      { label: "archived", doc: ARCHIVED_DOC, rows: 0 },
      { label: "real governs", doc: GOVERNS_DOC, rows: 1 },
    ];

    let agreed = 0;
    for (const f of fixtures) {
      const root = project({ "ENVIRONMENTS.md": f.doc });
      const scanner = scannerRows(root);
      const scaffold = scaffoldRows(root);
      expect(scanner.length, `${f.label}: scanner rows`).toBe(f.rows);
      expect(scaffold.length, `${f.label}: scaffold rows`).toBe(f.rows);
      expect(scaffold, `${f.label}: scaffold vs scanner`).toEqual(scanner);
      agreed++;
    }
    expect(agreed).toBe(3);
  });
});
