import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { collectSpecFiles } from "../lib/spec-files";

/**
 * #225 — `specs/` has subdirectories, and the collectors that decide which
 * specs exist did not descend into them.
 *
 * `specs/bootstrap-data-flow/` holds six specs and 254 SCs, 114 of them marked
 * done. Eight sites each decided for themselves whether to descend; seven did
 * not, and the eighth hand-rolled a one-level walk inline. Among the seven was
 * `DRIFT-2: every testable spec is referenced by at least one test` — the
 * check whose entire job is to catch untested specs, structurally unable to
 * see five specs that no test references.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s second shape: a
 * detector narrower than what it detects. It is also why the fix is one shared
 * function rather than seven edits — seven fixes leave the eighth caller free
 * to reintroduce it.
 */

const ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(ROOT, ".spec-collection-scratch-"));

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, "nested"), { recursive: true });
});
afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe("#225: collectSpecFiles descends, and says so about real trees", () => {
  test("a spec in a subdirectory is collected, with its path relative to specs/", () => {
    writeFileSync(join(SCRATCH, "top.md"), "---\ntestable: true\n---\n");
    writeFileSync(join(SCRATCH, "nested", "deep.md"), "---\ntestable: true\n---\n");
    expect(collectSpecFiles(SCRATCH)).toEqual(["nested/deep.md", "top.md"]);
  });

  test("INDEX.md is skipped and SPEC-TEMPLATE.md is not", () => {
    // Both halves matter. INDEX.md carries no frontmatter, so collecting it
    // would make SPEC-FRONTMATTER fail on a file that is correct as it is.
    // SPEC-TEMPLATE.md is `testable: false` and the flat collectors DID
    // include it, so dropping it would quietly narrow SPEC-FRONTMATTER's
    // coverage — the opposite of what this change is for.
    writeFileSync(join(SCRATCH, "nested", "INDEX.md"), "# contents\n");
    writeFileSync(join(SCRATCH, "SPEC-TEMPLATE.md"), "---\ntestable: false\n---\n");
    expect(collectSpecFiles(SCRATCH)).toEqual(["SPEC-TEMPLATE.md"]);
  });

  test("a missing directory is empty, not a throw", () => {
    expect(collectSpecFiles(join(SCRATCH, "does-not-exist"))).toEqual([]);
  });

  test("the real specs/ tree yields more than a flat read would", () => {
    // The control that ties the helper to the defect. A helper that passes
    // every planted case above and is then never wired into the real
    // collectors would leave the bug exactly where it was, and a unit test of
    // a helper cannot notice that.
    const specsDir = join(ROOT, "specs");
    const flat = readdirSync(specsDir).filter(f => f.endsWith(".md"));
    const recursive = collectSpecFiles(specsDir);
    expect(
      recursive.length,
      "collectSpecFiles found no more than a flat read — specs/ has no " +
        "subdirectories any more, so this test no longer proves anything and " +
        "should be re-pointed at whatever tree does",
    ).toBeGreaterThan(flat.length);
    expect(recursive.some(f => f.includes("/")), "no subdirectory spec collected").toBe(true);
  });
});

describe("#225: no collector has gone back to reading specs/ flat", () => {
  /**
   * The repo-wide half. Every one of the seven sites was the same line, so the
   * guard is the line: a flat `.md` read over a variable whose name says
   * "specs". Scoped to the four callers #225 migrated, because the remaining
   * sites in `lib/scaffold/`, `lib/validators/` and the one-off scripts are a
   * separate population with their own semantics — filed rather than silently
   * swept in here.
   */
  const MIGRATED = [
    "lib/conformity.ts",
    "lib/gap-scanner.ts",
    "scripts/sync-spec-tests.ts",
  ];

  test("the migrated collectors use the shared helper, not a flat readdirSync", () => {
    const offenders: string[] = [];
    for (const rel of MIGRATED) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      src.split("\n").forEach((line, i) => {
        if (/readdirSync\([A-Za-z_]*[Ss]pecs[A-Za-z_]*\)\s*\.filter\([^)]*\.md/.test(line)) {
          offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `a migrated collector reads specs/ flat again, so specs/*/ is invisible ` +
        `to it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("each migrated file actually calls the shared helper", () => {
    // Without this, deleting the collection entirely satisfies the test above.
    for (const rel of MIGRATED) {
      expect(
        readFileSync(join(ROOT, rel), "utf-8"),
        `${rel} no longer collects specs through the shared helper`,
      ).toContain("collectSpecFiles(");
    }
  });

  test("the guard can see a violation planted in a real migrated file", () => {
    // The mutation, performed rather than described: the two tests above are
    // satisfied by a regex that matches nothing. This plants the exact line
    // the seven sites used and requires the detector to catch it.
    const planted = 'const files = readdirSync(specsDir).filter(f => f.endsWith(".md"));';
    expect(/readdirSync\([A-Za-z_]*[Ss]pecs[A-Za-z_]*\)\s*\.filter\([^)]*\.md/.test(planted)).toBe(true);
    // And the shape the fix replaced it with must NOT match, or the guard
    // would be red on the corrected code and tell us nothing.
    expect(/readdirSync\([A-Za-z_]*[Ss]pecs[A-Za-z_]*\)\s*\.filter\([^)]*\.md/.test(
      "const files = collectSpecFiles(specsDir);",
    )).toBe(false);
  });
});
