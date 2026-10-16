/**
 * Covers SC-1622..SC-1629 (HARNESS-STANDARD.md), #440.
 *
 * `collectScanTargets` was four flat `readdirSync` loops with no recursion:
 * `*.md`, `docs/*.md` (skipping `archive`), `docs/adr/*.md`, `specs/*.md`.
 *
 * Measured on a consumer project: 84 files scanned, 28 missed, and every one
 * of the 28 sat in a directory that project's own routing table names as a
 * documentation location — `docs/specs/` (17), `reference/` (5),
 * `docs/designs/` (3), `docs/agents/` (3).
 *
 * `docs/specs/` is the headline: specs are the densest source of hard
 * constraints in a repo, and the extractor scanned `specs/` (2 files) while
 * skipping `docs/specs/` (17). Same word, different directory.
 *
 * Why the old tests did not catch it: the single scope test was "scans
 * arbitrary root-level .md files beyond hardcoded list" — root-level BREADTH
 * only. Nothing asserted that any subdirectory was reached. A detector
 * narrower than what it detects, with a test narrower still.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import {
  planDocScan, routedDirectories, planSummary,
  SCAN_EXCLUDE_DIRS, DEFAULT_SCAN_DIRS, MAX_SCAN_DEPTH, ROUTING_RELATIVE_PATH,
} from "../lib/doc-scan-targets";
import { extractConstraints } from "../scripts/extract-constraints";

let root: string;

function doc(rel: string, body = "# doc\n\n- The system MUST do the thing.\n"): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function routing(dirs: string[]): void {
  const rows = dirs.map(d => `| ${d} — things | \`${d}/\` |`).join("\n");
  const path = join(root, ROUTING_RELATIVE_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `## Documentation Routing\n\n| I need... | Read |\n|---|---|\n${rows}\n`);
}

/** Scanned paths relative to the project, which is what the assertions are about. */
function scanned(): string[] {
  return planDocScan(root).files.map(f => relative(root, f)).sort();
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rg-440-")); });
afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

describe("SC-1622: scan targets come from the project's routing table", () => {
  test("a directory the hardcoded four never named is scanned", () => {
    // SC-1. `blueprints/` is in none of the four, and the only reason it is
    // reached is that the project says it is a documentation location.
    routing(["blueprints"]);
    doc("blueprints/ONE.md");

    const plan = planDocScan(root);
    expect(plan.source).toBe("routing");
    expect(plan.files.map(f => relative(root, f))).toContain(join("blueprints", "ONE.md"));
  });

  test("the routing table ADDS to the default set, it does not replace it", () => {
    // The direction this fix is allowed to be wrong in. This repo's own
    // routing table names `docs/adr/` and `docs/research/` but NOT `docs/`,
    // so a routing-only scan would have dropped every top-level `docs/*.md`
    // the old flat code read — fixing a 28-file miss by causing a different
    // one.
    routing(["blueprints"]);
    doc("blueprints/ONE.md");
    doc("docs/UNROUTED.md");
    doc("specs/UNROUTED.md");

    const files = scanned();
    for (const expected of ["blueprints/ONE.md", "docs/UNROUTED.md", "specs/UNROUTED.md"]) {
      expect(files, `${expected} was lost`).toContain(expected);
    }
    expect(planDocScan(root).roots.sort()).toEqual(["blueprints", "docs", "specs"]);
  });

  test("SC-1622: only the READ table is a documentation table", () => {
    // Measured on this repo: `docs-routing.md` has two tables, and the second
    // — "Where to Create Things" — names `src/` and `test/`. Reading both
    // pulled 36 files out of `test/fixtures/`, a scaffolded fixture project
    // whose documents are props. Extracting constraints from them attributes
    // a synthetic project's rules to the real one.
    const path = join(root, ROUTING_RELATIVE_PATH);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path,
      "## Documentation Routing\n\n| I need... | Read |\n|---|---|\n| Specs | `blueprints/` |\n\n" +
      "## Where to Create Things\n\n| Type | Location |\n|---|---|\n| Source | `src/` |\n| Tests | `test/` |\n");
    doc("blueprints/REAL.md");
    doc("test/fixtures/golden-project/specs/PROP.md");
    doc("src/README.md");

    const files = scanned();
    expect(files).toContain(join("blueprints", "REAL.md"));
    expect(files, "a fixture project's docs became this project's constraints")
      .not.toContain(join("test", "fixtures", "golden-project", "specs", "PROP.md"));
    expect(files, "a source directory was read as documentation")
      .not.toContain(join("src", "README.md"));
  });

  test("SC-1622: the cut is the heading, and a file without one still parses", () => {
    const both = "| x | `docs/` |\n\n## Where to Create Things\n\n| y | `test/` |\n";
    expect(routedDirectories(both)).toEqual(["docs"]);
    // No heading — there is no second table to exclude, so nothing is cut.
    expect(routedDirectories("| x | `docs/` |\n| y | `reference/` |")).toEqual(["docs", "reference"]);
  });

  test("SC-1623: docs/specs and reference are both reached — the measured regression", () => {
    // SC-2, as the specific 28-file miss. `specs/` and `docs/specs/` are the
    // same word in different directories, and the old scan took one.
    routing(["docs", "docs/adr", "docs/specs", "specs", "reference"]);
    doc("specs/SHALLOW.md");
    doc("docs/specs/DEEP.md");
    doc("reference/OLD.md");
    doc("docs/designs/DESIGN.md");
    doc("docs/agents/AGENT.md");

    const files = scanned();
    for (const expected of [
      "specs/SHALLOW.md", "docs/specs/DEEP.md", "reference/OLD.md",
      "docs/designs/DESIGN.md", "docs/agents/AGENT.md",
    ]) {
      expect(files, `${expected} was missed`).toContain(expected);
    }
  });

  test("SC-1623: recursion reaches a nested directory nobody named", () => {
    // `docs/` is routed; `docs/a/b/c/` is not, and is reached because the
    // walk descends. The old loops were flat, which is why 28 files in
    // subdirectories of named locations were invisible.
    routing(["docs"]);
    doc("docs/a/b/c/NESTED.md");
    expect(scanned()).toContain(join("docs", "a", "b", "c", "NESTED.md"));
  });

  test("the parser reads a table of backticked directory tokens", () => {
    expect(routedDirectories("| x | `docs/` |\n| y | `docs/adr/` |")).toEqual(["docs", "docs/adr"]);
    // Single files are already caught by the flat root scan.
    expect(routedDirectories("| x | `CODE-MAP.md` |")).toEqual([]);
    // Prose in backticks is not a path.
    expect(routedDirectories("read `the docs/ directory/`")).toEqual([]);
    // Nothing that escapes the project.
    expect(routedDirectories("| x | `/etc/` |\n| y | `../other/` |")).toEqual([]);
    expect(routedDirectories("| x | `docs/` |\n| y | `docs/` |"), "duplicates").toEqual(["docs"]);
  });
});

describe("SC-1624: the exclusions are one list, and each is proved", () => {
  test("a planted file under every excluded directory is NOT scanned", () => {
    // SC-3. Driven over the exported list rather than a copy of it, so a
    // name added there without a fixture cannot pass by being untested.
    routing(["docs"]);
    doc("docs/KEEP.md");
    for (const excluded of SCAN_EXCLUDE_DIRS) {
      doc(join("docs", excluded, "HIDDEN.md"));
    }

    const files = scanned();
    expect(files).toContain(join("docs", "KEEP.md"));
    for (const excluded of SCAN_EXCLUDE_DIRS) {
      expect(files, `${excluded} was descended into`).not.toContain(join("docs", excluded, "HIDDEN.md"));
    }
    expect(SCAN_EXCLUDE_DIRS.length, "the list emptied out, so the loop above asserts nothing")
      .toBeGreaterThanOrEqual(5);
  });

  test("a worktree under .claude is not a second copy of the repo's constraints", () => {
    routing([".claude"]);
    doc(join(".claude", "RULE.md"));
    doc(join(".claude", "worktrees", "wf_x", "specs", "COPY.md"));

    const files = scanned();
    expect(files).toContain(join(".claude", "RULE.md"));
    expect(files).not.toContain(join(".claude", "worktrees", "wf_x", "specs", "COPY.md"));
  });

  test("SC-1624: recursion is bounded, and the bound is past anything real", () => {
    // The depth fixture is a LITERAL 12, not `MAX_SCAN_DEPTH + 3`. Deriving
    // it from the constant made the assertion vacuous in the exact way
    // `.claude/rules/checks-must-be-able-to-fail.md` names third: raising
    // the bound raised the fixture with it, and the mutation measured 0 red.
    // A bound driven by repo content needs a ceiling as well as a floor.
    const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join("/");
    routing(["docs"]);
    doc(join("docs", deep, "TOO-DEEP.md"));
    doc(join("docs", "d0", "d1", "SHALLOW-ENOUGH.md"));

    const files = scanned();
    expect(files).toContain(join("docs", "d0", "d1", "SHALLOW-ENOUGH.md"));
    expect(files, "the walk is unbounded").not.toContain(join("docs", deep, "TOO-DEEP.md"));
    expect(MAX_SCAN_DEPTH, "too shallow to reach real documentation").toBeGreaterThanOrEqual(4);
    expect(MAX_SCAN_DEPTH, "deep enough that the fixture above cannot catch a raise")
      .toBeLessThan(12);
  });
});

describe("SC-1630: BUG-440-A — a symlink is not a way out of the project", () => {
  // The old code was flat, so `docs/elsewhere -> /somewhere` was never
  // descended into. Recursion is what makes it reachable, which makes this
  // defect part of the fix rather than something the fix found.
  //
  // What it costs: `walkMarkdown` collects `.md` and `extract-constraints`
  // turns their sentences into candidate constraints written to AGENTS.md. A
  // single symlink in a cloned repo would copy markdown from anywhere the
  // process can read into this project's rules.
  let outside: string;
  beforeEach(() => { outside = mkdtempSync(join(tmpdir(), "rg-440-out-")); });
  afterEach(() => { if (existsSync(outside)) rmSync(outside, { recursive: true, force: true }); });

  test("a symlinked directory pointing out of the project is not descended into", () => {
    writeFileSync(join(outside, "SECRET.md"), "# notes\n\n- Deploys MUST use the staging key.\n");
    routing(["docs"]);
    doc("docs/REAL.md");
    symlinkSync(outside, join(root, "docs", "escape"));

    const plan = planDocScan(root);
    const files = plan.files.map(f => relative(root, f));
    expect(files).toContain(join("docs", "REAL.md"));
    expect(files.some(f => f.includes("SECRET")), "a file outside the project was scanned").toBe(false);
    expect(plan.refused.join(" "), "the refusal was silent").toContain("escape");
  });

  test("a symlinked FILE pointing out of the project is not collected", () => {
    writeFileSync(join(outside, "SECRET.md"), "# notes\n\n- Deploys MUST use the staging key.\n");
    routing(["docs"]);
    doc("docs/REAL.md");
    symlinkSync(join(outside, "SECRET.md"), join(root, "docs", "LINKED.md"));

    const plan = planDocScan(root);
    expect(plan.files.map(f => relative(root, f))).not.toContain(join("docs", "LINKED.md"));
    expect(plan.refused.join(" ")).toContain("LINKED.md");
  });

  test("a routed ROOT that is a symlink out of the project is refused, not walked", () => {
    writeFileSync(join(outside, "SECRET.md"), "# notes\n\n- Deploys MUST use the staging key.\n");
    routing(["blueprints"]);
    symlinkSync(outside, join(root, "blueprints"));

    const plan = planDocScan(root);
    expect(plan.roots, "a symlinked root was walked").not.toContain("blueprints");
    expect(plan.files.some(f => f.includes("SECRET"))).toBe(false);
    expect(plan.refused.join(" ")).toContain("blueprints");
  });

  test("SC-1631: a symlink INSIDE the project is followed, and the file is read once", () => {
    // The boundary. Containment is the rule, not "no symlinks" — and the
    // reason containment has to dedupe on the resolved path is that an
    // internal link makes one file reachable by two names, which reads as
    // two sources agreeing.
    routing(["docs", "specs"]);
    doc("specs/ONE.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    symlinkSync(join(root, "specs"), join(root, "docs", "mirror"));

    const plan = planDocScan(root);
    expect(plan.files.filter(f => f.endsWith("ONE.md")), "the same file was collected twice")
      .toHaveLength(1);
  });

  test("SC-1631: a symlink loop terminates", () => {
    routing(["docs"]);
    doc("docs/REAL.md");
    symlinkSync(join(root, "docs"), join(root, "docs", "self"));
    expect(planDocScan(root).files.map(f => relative(root, f))).toEqual([join("docs", "REAL.md")]);
  });

  test("SC-1631: a project root that does not resolve is an error, not an empty scan", () => {
    expect(() => planDocScan(join(root, "no-such-project")))
      .toThrow(/does not resolve to a directory/);
  });
});

describe("SC-1625: a project with no routing table is told so", () => {
  test("the default set is scanned and the fallback is reported", () => {
    // SC-4. The fallback is exactly the old hardcoded set, so a project
    // without a routing table sees no behaviour change — but it is named in
    // the result rather than assumed by the reader.
    doc("README.md");
    doc("docs/GUIDE.md");
    doc("specs/SPEC.md");

    const plan = planDocScan(root);
    expect(plan.source).toBe("default");
    expect(plan.reason).toContain(ROUTING_RELATIVE_PATH);
    expect(plan.roots.sort()).toEqual(["docs", "specs"]);
    expect(plan.files.map(f => relative(root, f))).toContain("README.md");
  });

  test("the default set is the four the hardcoded version used", () => {
    expect([...DEFAULT_SCAN_DIRS].sort()).toEqual(["docs", "docs/adr", "specs"]);
  });

  test("a routing table that names NOTHING is not the same as having none", () => {
    // It falls back, and says that it fell back — otherwise an empty table
    // and a correct one that happens to match the defaults are the same
    // outcome, which is Silent Default Substitution.
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(root, ROUTING_RELATIVE_PATH), "## Documentation Routing\n\nTBD.\n");
    doc("docs/G.md");

    const plan = planDocScan(root);
    // A table naming nothing left the defaults doing all the work, so saying
    // "routing" would report a derivation that did not happen.
    expect(plan.source).toBe("default");
    expect(plan.reason).toContain("names no directories");
    expect(plan.roots).toEqual(["docs"]);
  });
});

describe("SC-1626: a routed directory that does not exist is UNMEASURED", () => {
  test("drift between the routing table and the tree is a finding, not a skip", () => {
    // SC-5. The project claimed `docs/designs/` is where designs live. It is
    // not there. Dropping that silently is how a scan reports success over a
    // location it never read.
    routing(["docs", "docs/designs", "reference"]);
    doc("docs/REAL.md");

    const plan = planDocScan(root);
    expect(plan.unmeasured.sort()).toEqual(["docs/designs", "reference"]);
    expect(plan.roots).toEqual(["docs"]);
    expect(planSummary(root, plan)).toContain("UNMEASURED");
    expect(planSummary(root, plan)).toContain("docs/designs");
  });

  test("a DEFAULT directory a project simply lacks is not drift", () => {
    // The boundary. `unmeasured` means "the project said this exists and it
    // does not". A project with no `specs/` and no routing table never made
    // that claim, and reporting it would make the signal meaningless.
    doc("docs/G.md");
    const plan = planDocScan(root);
    expect(plan.source).toBe("default");
    expect(plan.unmeasured, "an unclaimed default was reported as drift").toEqual([]);
  });

  test("nothing is reported when the table and the tree agree", () => {
    routing(["docs"]);
    doc("docs/G.md");
    const plan = planDocScan(root);
    expect(plan.unmeasured).toEqual([]);
    expect(planSummary(root, plan)).not.toContain("UNMEASURED");
  });
});

describe("SC-1627: the extractor carries the plan, so a count is interpretable", () => {
  test("extractConstraints reports what it scanned and what it could not", async () => {
    routing(["docs", "docs/specs", "ghost"]);
    doc("docs/specs/HARD.md", "# spec\n\n- The runner MUST refuse an unsigned payload.\n");

    const result = await extractConstraints(root);
    expect(result.scan.source).toBe("routing");
    expect(result.scan.unmeasured).toContain("ghost");
    expect(result.scan.files.map(f => relative(root, f))).toContain(join("docs", "specs", "HARD.md"));
    expect(
      result.candidates.some(c => c.source.includes(join("docs", "specs"))),
      "a constraint in docs/specs/ produced no candidate",
    ).toBe(true);
  });

  test("SC-1628: the same file reached by two routed roots is read once", async () => {
    // `docs` and `docs/adr` are both routed on this repo, and `docs/adr`
    // nests inside `docs`. A file counted twice reads as two independent
    // sources agreeing, which is exactly the evidence a reader would weigh
    // most heavily.
    routing(["docs", "docs/adr"]);
    doc("docs/adr/ADR-1.md", "# adr\n\n- Services MUST NOT share a database.\n");

    const plan = planDocScan(root);
    const adr = plan.files.filter(f => f.endsWith("ADR-1.md"));
    expect(adr, "the nested file was collected twice").toHaveLength(1);
  });

  test("SC-1629: the old flat behaviour cannot come back unnoticed", () => {
    // The regression, stated as the file list it produces. A scan limited to
    // the four flat directories returns `specs/A.md` and nothing else here.
    routing(["docs", "specs"]);
    doc("specs/A.md");
    doc("specs/nested/B.md");
    doc("docs/nested/C.md");

    expect(scanned()).toEqual([
      join("docs", "nested", "C.md"),
      join("specs", "A.md"),
      join("specs", "nested", "B.md"),
    ]);
  });
});
