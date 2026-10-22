/**
 * #1200 — CODE-MAP's `Types` column reported directory names, not file types.
 *
 * `readdirSync(dir, { recursive: true })` returns DIRECTORIES as well as
 * files, and `"unit".split(".").pop()` is `"unit"`. So every extensionless
 * entry contributed its own name as a "type": the shipped `CODE-MAP.md` read
 *
 *     | test/   | ts, unit, types, json, fixtures |
 *     | evals/  | marcus-tdd-order, marcus-tdd-vs-speed, … |
 *     | scripts/| ts, sh, git-hooks, lib, git-hooks/pre-push |
 *
 * — `unit`, `types` and `fixtures` are directories under `test/`, not one
 * entry in the `evals/` row was a file type, and `git-hooks/pre-push` is a
 * path, because the split ran on the whole relative path rather than on a
 * basename. After #1163 removed the `Files` column this was the only data
 * column left in `## Directory Structure`.
 *
 * `.slice(0, 5)` over a `Set` fed by a raw `readdirSync` was also
 * filesystem-ordered, so even a corrected list would have been a
 * non-deterministic five of N — the defect `lib/readdir-sorted.ts` exists
 * for, one indirection further in.
 *
 * ## What this file has to separate, and how the fixture does it
 *
 * Three cheap wrong fixes go green against a careless fixture, so the tree
 * planted below is built to red each one:
 *
 * | wrong fix | what reds it here |
 * |---|---|
 * | keep every entry, just filter the empties | `unit/`, `nested/`, `LICENSE` |
 * | filter on "the name contains a `.`" | `fixtures.d/` — a DIRECTORY with a dot |
 * | filter on files, but do not sort before slicing | eight extensions, so the slice is live, and the five that survive are the alphabetical five |
 *
 * The dotfile case (`.gitignore`) is the fourth: a leading dot does not open
 * an extension, and the old code emitted `gitignore` as a type.
 *
 * ## The three scanners
 *
 * `scripts/generate-code-map.ts`, `lib/scanner.ts` and
 * `generateCodeMapInline` in `lib/scaffold/steps.ts` each carried their own
 * copy of the same four lines. That is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` — fix one and the other two
 * keep the answer up, and the scaffold's inline fallback silently
 * reintroduces whatever was fixed. Two of the three are driven behaviourally
 * below; the inline fallback only runs inside a full scaffold, so the last
 * case asserts structurally that all three route through the one binding and
 * that none of them extracts an extension itself.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { fileExtensions } from "../lib/file-extensions";
import { scanProject } from "../lib/scanner";

const REPO_ROOT = join(import.meta.dir, "..");
const GENERATOR = join(REPO_ROOT, "scripts", "generate-code-map.ts");

/**
 * Eight distinct extensions, so `.slice(0, 5)` drops three and the question
 * "which five" has a wrong answer available. Created in an order that is not
 * the alphabetical one.
 */
const PLANTED_FILES = [
  "g.zzz",
  "d.yaml",
  "a.ts",
  "f.toml",
  "e.sh",
  "c.json",
  "b.md",
  "unit/nested/deep.css",
];

/** The alphabetical five of the eight. Nothing here is a directory name. */
const EXPECTED = ["css", "json", "md", "sh", "toml"];

let root = "";
let zoo = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "code-map-types-"));
  zoo = join(root, "zoo");
  mkdirSync(join(zoo, "unit", "nested"), { recursive: true });
  // A DIRECTORY whose name carries a dot. `"fixtures.d".split(".").pop()` is
  // `"d"`, so a filter that only asks "is there a dot" still emits a type
  // here and this row stays red under it.
  mkdirSync(join(zoo, "fixtures.d"), { recursive: true });
  for (const rel of PLANTED_FILES) writeFileSync(join(zoo, rel), "x\n");
  // No extension at all, and a dotfile whose leading dot does not open one.
  writeFileSync(join(zoo, "LICENSE"), "x\n");
  writeFileSync(join(zoo, ".gitignore"), "x\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "types-fixture", scripts: { test: "bun test" } }),
  );
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("#1200: the Types column reports file extensions", () => {
  test("the binding returns extensions, not directory names", () => {
    const types = fileExtensions(zoo);

    // The instrument first. An empty reading satisfies "contains no
    // directory name" for free, and that is the shape this whole file is
    // about.
    expect(types.length, `no types were read from ${zoo} — this reading is a refusal, not a pass`)
      .toBe(EXPECTED.length);

    for (const name of ["unit", "nested", "fixtures", "d", "LICENSE", "gitignore"]) {
      expect(types, `"${name}" is a directory, a dotfile or an extensionless file — not a file type`)
        .not.toContain(name);
    }
    expect(types, "the five survivors of the slice are not the alphabetical five").toEqual(EXPECTED);
  });

  test("the slice is deterministic, so the same tree reads the same twice", () => {
    const a = fileExtensions(zoo);
    // Ascending is the property `.slice(0, 5)` needs in front of it. Without
    // it the five are whichever five the filesystem happened to yield first,
    // which differs between APFS and ext4 — `lib/readdir-sorted.ts`.
    expect([...a].sort(), "the result is not in ascending order, so the slice is filesystem-ordered").toEqual(a);
    expect(fileExtensions(zoo), "two reads of one unchanged tree disagreed").toEqual(a);
  });

  test("a directory holding no file with an extension reads empty, not as its own children", () => {
    const bare = join(root, "bare");
    mkdirSync(join(bare, "alpha"), { recursive: true });
    mkdirSync(join(bare, "beta"), { recursive: true });
    writeFileSync(join(bare, "Makefile"), "x\n");
    // Predicted before it was run, per #1200's second acceptance note: an
    // empty cell is the honest answer for a directory with no extensions in
    // it, and it is what the `specs/` witness in
    // `test/scaffold-determinism.test.ts` relies on being distinguishable.
    expect(fileExtensions(bare), "an extensionless tree reported types").toEqual([]);
  });

  test("lib/scanner.ts reports the same extensions as the binding", () => {
    const scan = scanProject(root);
    const entry = scan.dirs.find(d => d.name === "zoo");
    expect(entry, "lib/scanner.ts did not scan the planted directory").toBeDefined();
    expect(entry!.types, "lib/scanner.ts kept its own extension extraction").toEqual(EXPECTED);
  });

  test("the real generator renders a row of extensions", () => {
    const proc = Bun.spawnSync(["bun", GENERATOR, root], { cwd: REPO_ROOT });
    expect(proc.exitCode, `generate-code-map.ts exited ${proc.exitCode}: ${proc.stderr.toString()}`).toBe(0);

    const md = readFileSync(join(root, "CODE-MAP.md"), "utf-8");
    const row = md.split("\n").find(l => l.startsWith("| zoo/ |"));
    expect(row, `no zoo/ row in the generated Directory Structure table:\n${md}`).toBeDefined();
    expect(row, "the generated row is not the extension list").toBe(`| zoo/ | ${EXPECTED.join(", ")} |`);
  });

  test("all three scanners route through the one binding", () => {
    // `generateCodeMapInline` runs only inside a full scaffold, so this is
    // the case that keeps the inline fallback from reintroducing the defect
    // the other two cases just measured.
    const scanners = ["scripts/generate-code-map.ts", "lib/scanner.ts", "lib/scaffold/steps.ts"];
    const missing: string[] = [];
    const ownExtraction: string[] = [];
    for (const rel of scanners) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      if (!src.includes("fileExtensions(")) missing.push(rel);
      if (src.includes('.split(".").pop()')) ownExtraction.push(rel);
    }
    expect(missing, "a scanner does not call fileExtensions — it has its own answer for the Types column")
      .toEqual([]);
    expect(ownExtraction, "a scanner still extracts an extension itself, so a fix to the binding misses it")
      .toEqual([]);
  });
});
