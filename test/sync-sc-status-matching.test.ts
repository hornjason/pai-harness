/**
 * An SC ID is a whole token, and a template placeholder is not a criterion (#148)
 *
 * SC-548, SC-549, SC-550 (CONFIG-DRIVEN-TESTING-SPEC.md)
 *
 * `findTestFilesForSCs` asked `content.includes(id)`. A short ID is a substring
 * of every longer one that starts with it, so eighteen test files were credited
 * as covering the shortest ID in the repo and not one of them mentioned it. One
 * passing run of any of the eighteen ticked it wherever it was unchecked:
 * `specs/SPEC-TEMPLATE.md:190`, the literal placeholder
 * `- [ ] SC-1: [first criterion]`, and a real unimplemented bootstrap criterion.
 * A ticked template means every spec generated from it inherits a criterion
 * that is done before anyone writes it.
 *
 * The mistake conceals itself. Once a criterion reads `[x]` it leaves
 * `findUncheckedSCs` and is never evaluated again.
 *
 * Note on style: this file deliberately avoids writing short SC IDs in prose.
 * A bare ID in a comment is itself read as a coverage claim (#149), so a test
 * about the matcher would otherwise certify the criteria it talks about.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findTestFilesForSCs,
  findUncheckedSCs,
  stripFixtureMentions,
} from "../scripts/sync-sc-status";

const REPO_ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(REPO_ROOT, "specs");

/**
 * The shortest ID in the repo — the one the substring bug ticked — assembled
 * rather than written.
 *
 * This file has to name it to test it, but naming it in source text IS the
 * coverage claim under the convention being tested, so a literal here would
 * certify the very criterion the suite below proves is uncertified. Building
 * it keeps the file honest without an exemption list, which would be its own
 * self-reference.
 */
const SHORTEST_ID = ["SC", "1"].join("-");

const scratch = mkdtempSync(join(tmpdir(), "sc-match-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixtureTestDir(name: string, body: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.test.ts"), body);
  return dir;
}

describe("#148: an SC ID matches as a whole token", () => {
  test("a test naming a longer ID does not count as a test for the shorter one", () => {
    // The exact collision that ticked the template, with IDs this repo does
    // not use so the file does not claim them. Before the fix this returned
    // the fixture file.
    const dir = fixtureTestDir("longer-id", 'test("SC-9144: something else", () => {});');
    const found = findTestFilesForSCs(new Set(["SC-9"]), dir);
    expect([...found.keys()]).toEqual([]);
  });

  test("a test naming the ID exactly still counts", () => {
    // Positive control. A fix that returns nothing for everything would pass
    // the assertion above and break the tool; this is what stops that.
    const dir = fixtureTestDir("exact-id", 'test("SC-9: the real one", () => {});');
    const found = findTestFilesForSCs(new Set(["SC-9"]), dir);
    expect([...found.values()].flat()).toEqual(["SC-9"]);
  });

  test("the boundary is the trailing digit, not the punctuation around it", () => {
    // IDs appear bare in prose, in comma lists, in parentheses and before a
    // colon. All of those are the ID. The only thing that makes a mention a
    // different criterion is another digit after it.
    const dir = fixtureTestDir("punctuation", "// covers SC-910: and SC-92, and (SC-93)\n");
    const found = findTestFilesForSCs(new Set(["SC-9", "SC-92", "SC-93", "SC-910"]), dir);
    expect([...found.values()].flat().sort()).toEqual(["SC-910", "SC-92", "SC-93"]);
  });

  test("against the real test directory, every credited file names the ID", () => {
    // The invariant the fix establishes, measured on the repo rather than a
    // fixture: a file is credited only if it contains the ID not followed by
    // a digit. Before the fix, 18 files were credited for the shortest ID and
    // 9 of them contained no such token at all.
    const target = SHORTEST_ID;
    const found = findTestFilesForSCs(new Set([target]));
    const liars = [...found.keys()].filter(file => {
      const text = stripFixtureMentions(readFileSync(join(REPO_ROOT, "test", file), "utf-8"));
      return !new RegExp(`\\b${target}(?!\\d)`).test(text);
    });
    expect(liars).toEqual([]);
  });
});

describe("#149: fixture data is not a coverage claim", () => {
  test("a spec checkbox line embedded in a test is stripped", () => {
    const dir = fixtureTestDir("checkbox", 'const spec = "- [ ] SC-9: API responds";\n');
    expect([...findTestFilesForSCs(new Set(["SC-9"]), dir).keys()]).toEqual([]);
  });

  test("an SC record in an object literal is stripped", () => {
    const dir = fixtureTestDir("record", 'const scs = [{ id: "SC-9", done: true }];\n');
    expect([...findTestFilesForSCs(new Set(["SC-9"]), dir).keys()]).toEqual([]);
  });

  test("a test title is still a claim — the stripping is narrow", () => {
    // Positive control for the stripper. Deleting every mention would make
    // both assertions above pass and the tool useless.
    const dir = fixtureTestDir("claim", 'test("SC-9: the criterion itself", () => {});\n');
    expect([...findTestFilesForSCs(new Set(["SC-9"]), dir).keys()]).toEqual(["fixture.test.ts"]);
  });

  test("the real bootstrap criterion is claimed by nothing", () => {
    // The harm, stated as the outcome rather than the mechanism:
    // specs/bootstrap-data-flow/success-criteria.md's first criterion is
    // behavioural and unimplemented. Seven files carried it as fixture text
    // and one more used its number as a local label; between them they
    // certified it done, twice.
    expect([...findTestFilesForSCs(new Set([SHORTEST_ID])).keys()]).toEqual([]);
  });
});

describe("#148: the spec template is not a spec", () => {
  test("no unchecked criterion is sourced from SPEC-TEMPLATE.md", () => {
    const fromTemplate = findUncheckedSCs(SPECS_DIR).filter(sc =>
      sc.specFile.includes("SPEC-TEMPLATE"),
    );
    expect(fromTemplate).toEqual([]);
  });

  test("the committed placeholder is still unticked", () => {
    // Independent of the scanner: this reads the file. If anything ever ticks
    // it again — this tool or a careless edit — every spec generated from the
    // template inherits a criterion that is done before it is written.
    const template = readFileSync(join(SPECS_DIR, "SPEC-TEMPLATE.md"), "utf-8");
    expect(template).toContain("- [ ] SC-1: [first criterion]");
    expect(template).not.toContain("- [x] SC-1: [first criterion]");
  });

  test("real specs are still scanned — the exclusion is the template, not the glob", () => {
    const unchecked = findUncheckedSCs(SPECS_DIR);
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked.some(sc => sc.specFile.endsWith(".md"))).toBe(true);
  });
});
