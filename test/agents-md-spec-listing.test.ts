/**
 * Covers SC-1891..SC-1895 (AGENTS-MD-TEMPLATE-SPEC.md), #382 and #552.
 *
 * Two checks in `refreshAgentsMd` looked for tables D-15 moved out of
 * AGENTS.md and into `.claude/rules/`. Both warned on every `--fix` run —
 * 23 spec filenames and a `CODE-MAP.md exists but not referenced` on this
 * repo, every time — and neither was fixable from the document's side.
 *
 * **Every case here EXECUTES `refreshAgentsMd` and counts what it reports.**
 * The nearest prior defect in this same function (#380, SC-848) was asserted
 * by grepping the function's source, and replacing the call it grepped for
 * with an empty list left the case green because the comment above the call
 * used the same word.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { refreshAgentsMd } from "../lib/scaffold/steps";
import {
  codeMapUnreferenced, isSpecFile, listingSurfaces, specFilesIn, unlistedSpecs,
} from "../lib/spec-listing";
import { generateScopedRules } from "../lib/generators/agents-md";
import { scanProject } from "../lib/scanner";

const REPO = join(import.meta.dir, "..");

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `spec-listing-${name}-`));
  roots.push(d);
  return d;
}

/** A project with one spec and an AGENTS.md that does not name it. */
function project(name: string, opts: { routing?: string; codeMap?: boolean } = {}): string {
  const root = scratch(name);
  writeFileSync(join(root, "AGENTS.md"), "# p\n\n## Commands\n\n| Action | Command |\n|---|---|\n| Test | `bun test` |\n");
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "POV-SPEC.md"), "---\ndoc-type: spec\ntestable: true\ngoverns: the point of view\n---\n# POV\n");
  if (opts.routing !== undefined) {
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(root, ".claude", "rules", "specs-routing.md"), opts.routing);
  }
  if (opts.codeMap) writeFileSync(join(root, "CODE-MAP.md"), "# map\n");
  return root;
}

/** What the audit printed, as a list, by running it. */
function auditIssues(root: string): string[] {
  const actions: string[] = [];
  const said: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  try { refreshAgentsMd(root, "code", actions); } finally { console.log = log; }
  return said.filter(l => l.includes("⚠")).map(l => l.replace(/^\s*⚠\s*/, "").trim());
}

describe("#382: the audit reads the surfaces the generator writes to", () => {
  test("SC-1891: this repo reports no unlisted spec and no unreferenced CODE-MAP", () => {
    // The live case, and the one the issue is about: 23 filenames and a
    // CODE-MAP line on every scaffold run, all false, none clearable.
    const issues = auditIssues(REPO);
    expect(issues.filter(i => i.startsWith("UNLISTED specs")), "a spec this repo lists is still reported")
      .toEqual([]);
    expect(issues.filter(i => i.includes("CODE-MAP")), "CODE-MAP is routed and still reported")
      .toEqual([]);

    // The INSTRUMENT. An audit that reports nothing because it looked at
    // nothing is the thing this file exists to stop, so the surfaces have to
    // be real and the spec list non-trivial.
    expect(specFilesIn(REPO).length, "the repo scan found no specs, so reporting none proves nothing")
      .toBeGreaterThan(10);
    expect(listingSurfaces(REPO).map(s => s.path), "AGENTS.md is not among the surfaces searched")
      .toContain("AGENTS.md");
    expect(listingSurfaces(REPO).length, "only AGENTS.md was searched — the rules directory was not read")
      .toBeGreaterThan(1);
  });

  test("SC-1892: a spec named by no surface is still reported", () => {
    // The other direction, and without it everything above is satisfied by
    // a check that returns an empty list.
    const root = project("unlisted");
    expect(unlistedSpecs(root)).toEqual(["POV-SPEC.md"]);
    expect(auditIssues(root).filter(i => i.startsWith("UNLISTED specs")))
      .toEqual(["UNLISTED specs: POV-SPEC.md (in specs/ but not in AGENTS.md or .claude/rules/)"]);
  });

  test("SC-1893: a spec listed only in .claude/rules/ is listed", () => {
    // The exact shape D-15 created: the table is current, it is just not in
    // AGENTS.md. This is the case that was false on every run.
    const root = project("routed", { routing: "| Spec | Governs |\n|---|---|\n| POV-SPEC.md | the point of view | true |\n" });
    expect(unlistedSpecs(root)).toEqual([]);
    expect(auditIssues(root).filter(i => i.startsWith("UNLISTED specs"))).toEqual([]);

    // The control, and it is the fixture one line different: the same
    // project with that rule file absent reports the spec. Without it this
    // row passes against a check that reports nothing at all.
    const bare = project("routed-control");
    expect(auditIssues(bare).filter(i => i.startsWith("UNLISTED specs"))).toHaveLength(1);
  });

  test("SC-1893: CODE-MAP referenced only from .claude/rules/ is not reported", () => {
    const routed = project("codemap", {
      codeMap: true,
      routing: "| POV-SPEC.md | x | true |\n\nSee `CODE-MAP.md` for structure.\n",
    });
    expect(codeMapUnreferenced(routed)).toBe(false);
    expect(auditIssues(routed).filter(i => i.includes("CODE-MAP"))).toEqual([]);

    // …and a CODE-MAP.md nothing points at is still reported, or the row
    // above is satisfied by a check that was deleted.
    const orphan = project("codemap-orphan", { codeMap: true, routing: "| POV-SPEC.md | x | true |\n" });
    expect(codeMapUnreferenced(orphan)).toBe(true);
    expect(auditIssues(orphan).filter(i => i.includes("CODE-MAP"))).toHaveLength(1);
  });

  test("SC-1894: SPEC-TEMPLATE.md is not a spec, and one binding says so", () => {
    // The decision #382 asked for, recorded rather than absorbed by
    // whichever file a check happens to read. It was in the warning list as
    // the one entry that was never going to be listed anywhere, because the
    // scanner excluded it from the routing table and the audit did not.
    expect(isSpecFile("SPEC-TEMPLATE.md")).toBe(false);
    expect(isSpecFile("POV-SPEC.md")).toBe(true);
    expect(isSpecFile("notes.txt")).toBe(false);

    const root = scratch("template-only");
    writeFileSync(join(root, "AGENTS.md"), "# p\n");
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "SPEC-TEMPLATE.md"), "---\ndoc-type: spec\n---\n# template\n");
    expect(specFilesIn(root), "the template was counted as a spec").toEqual([]);
    expect(auditIssues(root).filter(i => i.startsWith("UNLISTED specs"))).toEqual([]);

    // The two sides that used to disagree, asked over the same tree: the
    // scanner's routing table and the audit's spec list. A project whose
    // only `specs/` entry is the template gets no routing table at all, so
    // "listed" and "is a spec" cannot be answered differently.
    expect(scanProject(root).specs.map(s => s.file), "the scanner put the template in the routing table")
      .toEqual([]);
    expect(generateScopedRules(scanProject(root)).map(r => r.filename))
      .not.toContain("specs-routing.md");
  });

  test("SC-1895: every rule the generator writes is a surface the audit searches", () => {
    // The anti-drift link, and the reason `listingSurfaces` reads a
    // DIRECTORY rather than naming `specs-routing.md`. A generator that
    // renames its rule file, or splits the table across two, would otherwise
    // put every spec back in the unlisted list with nothing able to say why.
    const written = generateScopedRules(scanProject(REPO)).map(r => `.claude/rules/${r.filename}`);
    expect(written.length, "the generator wrote no rules, so containing them all proves nothing")
      .toBeGreaterThan(3);
    const searched = new Set(listingSurfaces(REPO).map(s => s.path));
    expect(written.filter(w => !searched.has(w)), "the generator writes a rule the audit never reads")
      .toEqual([]);
    // Specifically the one carrying the table, named here so the link is
    // legible — but asserted through the set above, not instead of it.
    expect(written).toContain(".claude/rules/specs-routing.md");
  });
});
