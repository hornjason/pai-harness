/**
 * #114: the run slug comes from the repository, never from a literal.
 *
 * `workflows/ship.js` read:
 *
 *     const REPO = parsedArgs.repo || 'hornjason/asaCommandCenter'
 *     const SLUG = parsedArgs.slug || `ddb-${ISSUE}`
 *
 * The ship skill passes `repo` but has never passed `slug`, so every run in
 * every repository took the hardcoded branch. Of the 59 compliance-grade
 * directories on disk, resolved by each one's own workflow-state.json rather
 * than by its name: 27 hornjason/pai-harness, 3 asaCommandCenter, and **zero**
 * DailyBriefDashboard — while 26 of them were named `ddb-*`. Any analysis
 * grouping compliance data by slug prefix was reading a namespace that
 * belonged to a different project.
 *
 * ship.js is not importable in the Workflow sandbox, so the derivation is
 * pulled out by marker and evaluated, the same approach as the other ship.js
 * tests in this directory.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const START = "// ──── SLUG-DERIVATION-START ────";
const END = "// ──── SLUG-DERIVATION-END ────";

function loadDeriveSlug(): (repo: unknown, issue: unknown) => string | null {
  const s = shipSource.indexOf(START);
  const e = shipSource.indexOf(END);
  if (s === -1 || e === -1) throw new Error("ship.js is missing the SLUG-DERIVATION markers");
  return new Function(`${shipSource.slice(s + START.length, e)}; return deriveSlug`)();
}

const deriveSlug = loadDeriveSlug();

describe("#114: slug derives from the repository name", () => {
  // SC-3 wants at least two distinct repos, one of which is not the harness.
  test.each([
    ["hornjason/pai-harness", 75, "pai-harness-75"],
    ["hornjason/asaCommandCenter", 12, "asaCommandCenter-12"],
    ["someone/DailyBriefDashboard", 515, "DailyBriefDashboard-515"],
    // Bare name, no owner.
    ["pai-harness", 1, "pai-harness-1"],
    // Trailing slash, and a nested path shape.
    ["hornjason/pai-harness/", 9, "pai-harness-9"],
  ])("%s #%i -> %s", (repo, issue, expected) => {
    expect(deriveSlug(repo, issue)).toBe(expected);
  });

  test.each([
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a slash only", "/"],
  ])("refuses to guess when repo is %s", (_label, repo) => {
    // Returning null is what makes ship.js emit ARGS_ERROR. A default repo
    // would be the same bug one level up: runs still flow into a namespace
    // nobody chose, just a different one.
    expect(deriveSlug(repo, 7)).toBeNull();
  });

  test("the result is safe to use as a directory name", () => {
    // The slug becomes a directory under ~/.rungate/.
    expect(deriveSlug("owner/weird name;rm -rf", 3)).toBe("weird-name-rm--rf-3");
    expect(deriveSlug("owner/../../etc", 3)).toBe("etc-3");
  });
});

describe("#114: no project-specific literal survives as a fallback", () => {
  // SC-2. Code lines only — the explanation above the derivation quotes the
  // old literals verbatim, and a raw-file scan would match the documentation
  // of the bug rather than the bug.
  const codeLines = shipSource
    .split("\n")
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  test.each([
    ["ddb", /['"`]ddb[-_]/i],
    ["asaCommandCenter", /asaCommandCenter/],
    ["DailyBriefDashboard", /DailyBriefDashboard/],
  ])("%s does not appear in executable code", (_name, pattern) => {
    const hits = codeLines.filter(({ l }) => pattern.test(l));
    expect(
      hits.map(h => `line ${h.i + 1}: ${h.l.trim()}`),
      "a project-specific literal is back in ship.js",
    ).toEqual([]);
  });

  test("SLUG is assigned from deriveSlug, not from a template literal", () => {
    const assignment = codeLines.find(({ l }) => /^\s*const SLUG\s*=/.test(l));
    expect(assignment, "SLUG assignment not found").toBeDefined();
    expect(assignment!.l).toContain("deriveSlug(");
    expect(assignment!.l, "a literal prefix is being interpolated again").not.toMatch(/`[^`]*\$\{ISSUE\}/);
  });

  test("REPO has no default, and its absence is refused", () => {
    const assignment = codeLines.find(({ l }) => /^\s*const REPO\s*=/.test(l));
    expect(assignment, "REPO assignment not found").toBeDefined();
    expect(assignment!.l, "REPO fell back to a default again").not.toContain("||");

    // And the refusal exists, naming the argument rather than a project.
    const idx = shipSource.indexOf("const REPO =");
    const after = shipSource.slice(idx, idx + 800);
    expect(after).toContain("ARGS_ERROR");
    expect(after).toContain("repo is required");
  });
});

describe("#114 SC-4: a run directory is attributable without its name", () => {
  test("initWorkflow records repo into workflow-state.json", () => {
    // The directory under ~/.rungate/ is created by initWorkflow's mkdirSync,
    // and the state it writes carries `repo`. So any directory the harness
    // creates is resolvable from its contents, independent of the slug — which
    // is how the table in #114 was produced in the first place.
    const orchestrator = readFileSync(join(REPO_ROOT, "gates", "orchestrator.ts"), "utf-8");
    const init = orchestrator.slice(orchestrator.indexOf("export function initWorkflow"));
    const body = init.slice(0, init.indexOf("\n}\n") + 3);
    expect(body).toContain("repo: opts.repo");
    expect(body).toContain("slug: opts.slug");
    expect(body, "the run directory is no longer created with the state").toContain("mkdirSync");
  });
});
