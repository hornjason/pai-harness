/**
 * #827: `lib/scaffold/steps.ts` carries its own copy of the spec scan that
 * `lib/scanner.ts` already does, and the copy has drifted three times.
 *
 * Every drift has the same shape: a fix lands in `scanner.ts`, nobody knows
 * the second copy exists, and the scaffold path keeps the old behaviour.
 * `scanner.ts:114-118` records the first one in a comment — the two filters
 * "reached the opposite verdict for `SPEC-TEMPLATE.md`" (#382). The other two
 * are #579's, and both are still live on the scaffold path:
 *
 *   - `criteriaNone` is never set, so `STATES NO CRITERIA` is dropped from
 *     every row that earned it.
 *   - the subdirectory group row hardcodes `testable: "yes"`, a word that
 *     `scanner.ts:168` notes "means false to the code and true to a reader".
 *
 * These assertions are pointed at `generateAgentsMdContent`, the scaffold
 * entry point, NOT at `scanSpecs`. Testing the scanner would pass today and
 * say nothing about the path that actually writes the file — which is the
 * whole defect.
 *
 * The cheapest wrong fix, named so the next reader can tell it apart: patch
 * the two lines in `steps.ts` and leave the duplicate standing. That makes
 * this file green and leaves the fourth drift waiting for the next fix to
 * land in `scanner.ts` alone.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { generateAgentsMdContent } from "../lib/scaffold/steps";

let root = "";

function spec(dir: string, name: string, frontmatter: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `---\n${frontmatter}\n---\n\n# ${name}\n`, "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scaffold-spec-scan-"));
  const specs = join(root, "specs");

  // Earns the prefix.
  spec(specs, "SILENT-SPEC.md", "governs: the population that declares no criteria at all\ncriteria: none\ntestable: true");
  // The control for the prefix. Identical but for the `criteria:` line, so a
  // generator that printed the prefix unconditionally would fail here.
  spec(specs, "NORMAL-SPEC.md", "governs: the population that does declare criteria\ntestable: true");
  // #382's file. One filter omits it deliberately; the other never learned to.
  spec(specs, "SPEC-TEMPLATE.md", "governs: the template nobody should see in the routing table\ntestable: true");

  // A group row whose members ARE testable.
  spec(join(specs, "live-group"), "ONE.md", "governs: a member that is testable\ntestable: true");
  spec(join(specs, "live-group"), "TWO.md", "governs: another member\ntestable: false");
  // The control for the derivation. No member is testable, so a row reading
  // `true` here is hardcoded rather than derived — which is exactly what the
  // `"yes"` literal was.
  spec(join(specs, "dead-group"), "THREE.md", "governs: a member that is not testable\ntestable: false");
  spec(join(specs, "dead-group"), "FOUR.md", "governs: another untestable member\ntestable: false");
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * The routing table is written to `.claude/rules/specs-routing.md` as a side
 * effect of the scaffold entry point, not returned from it. Running the entry
 * point and then reading the file is deliberate: it is the only path that
 * exercises `steps.ts`'s own scan, which is the subject.
 */
function routingTable(): string {
  generateAgentsMdContent(root, "code", []);
  const path = join(root, ".claude", "rules", "specs-routing.md");
  if (!existsSync(path)) throw new Error(`the scaffold wrote no ${path}`);
  return readFileSync(path, "utf-8");
}

function rowFor(md: string, file: string): string {
  const row = md.split("\n").find(l => l.startsWith(`| ${file} `));
  if (!row) throw new Error(`no routing row for ${file}. The table was:\n${md}`);
  return row;
}

describe("#827: the scaffold path scans specs the same way the scanner does", () => {
  test("a spec declaring `criteria: none` keeps its STATES NO CRITERIA prefix", () => {
    const md = routingTable();
    expect(rowFor(md, "SILENT-SPEC.md")).toContain("STATES NO CRITERIA");
  });

  test("the control: a spec that declares criteria does NOT get the prefix", () => {
    const md = routingTable();
    expect(rowFor(md, "NORMAL-SPEC.md")).not.toContain("STATES NO CRITERIA");
  });

  test("a group row states testability as true/false, never the word yes", () => {
    const md = routingTable();
    const row = rowFor(md, "live-group/ (2 specs)");
    // Asserted on the whole table, not just this row: `yes` is a word every
    // reader of this column compares against `"true"` and loses.
    expect(md, "the routing table still spells a boolean as `yes`").not.toMatch(/\|\s*yes\s*\|/);
    expect(row).toMatch(/\|\s*true\s*\|/);
  });

  test("the control: a group with no testable member reads false, so the column is derived", () => {
    const md = routingTable();
    expect(rowFor(md, "dead-group/ (2 specs)")).toMatch(/\|\s*false\s*\|/);
  });

  test("SPEC-TEMPLATE.md is omitted, the verdict #382 found the two scans disagreeing on", () => {
    const md = routingTable();
    expect(md).not.toContain("SPEC-TEMPLATE.md");
  });
});
