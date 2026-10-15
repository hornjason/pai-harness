/**
 * Covers #446 — every relative import in a published file resolves to another
 * published file.
 *
 * The defect this exists for: `lib/conformity.ts` imported
 * `../scripts/split-spec` while `files[]` omitted it, through two releases.
 * Every suite in this repo resolved that path against the working tree and
 * went green; `bun add rungate && import "rungate/lib/conformity"` died on
 * import. The repo could not see the artifact it was shipping.
 *
 * What was broken to prove this can fail, run and counted rather than
 * asserted:
 *
 * | Mutation | Red of 13 |
 * |---|---|
 * | `scripts/split-spec.ts` removed from `files[]` | 1 — CLOSURE-1, naming conformity.ts and the path |
 * | `packageClosureViolations` short-circuited to `return []` | 2 — the planted-defect case and the real-source half of CLOSURE-4 |
 * | `relativeImports` short-circuited to `return []` | 6 — the same pair plus all four CLOSURE-5 import forms, which read the scanner directly |
 *
 * None is left in the tree; all were run and reverted, and the counts above
 * are measured rather than predicted — the third was expected to be 2.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  packageClosureViolations,
  publishedFiles,
  readPackageFiles,
  relativeImports,
} from "../lib/package-closure";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = join(ROOT, "lib", "package-closure.ts");
const BINDING = "export function packageClosureViolations(root: string, published: Set<string>): string[] {";

const temps: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "closure-"));
  temps.push(dir);
  return dir;
}
afterAll(() => temps.forEach(d => rmSync(d, { recursive: true, force: true })));

/** A package shaped exactly like the defect: lib/ ships, scripts/ ships by allowlist. */
function plantPackage(opts: { publishTheImport: boolean }): string {
  const dir = scratch();
  mkdirSync(join(dir, "lib"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "lib", "conformity.ts"), 'import { x } from "../scripts/helper";\nexport const y = x;\n');
  writeFileSync(join(dir, "scripts", "helper.ts"), "export const x = 1;\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      files: opts.publishTheImport ? ["lib/", "scripts/helper.ts"] : ["lib/"],
    }),
  );
  return dir;
}

describe("#446 CLOSURE-1: this package's own tarball is closed", () => {
  test("every relative import in a published file is itself published", () => {
    const published = publishedFiles(ROOT, readPackageFiles(ROOT));
    // A closure check over an empty file set passes for free.
    expect(published.size).toBeGreaterThan(20);
    expect(packageClosureViolations(ROOT, published)).toEqual([]);
  });
});

describe("#446 CLOSURE-2: the check reads the real defect", () => {
  test("an import into an unpublished script is a violation", () => {
    const dir = plantPackage({ publishTheImport: false });
    const violations = packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)));
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("scripts/helper");
  });

  test("publishing that script clears it", () => {
    const dir = plantPackage({ publishTheImport: true });
    expect(packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)))).toEqual([]);
  });

  test("a path absent from the working tree is not this check's business", () => {
    const dir = scratch();
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "a.ts"), 'import "./nowhere";\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0", files: ["lib/"] }));
    // Typecheck owns a broken path. Reporting it here would mean two checks
    // failing for one cause, and neither one trustworthy about the other.
    expect(packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)))).toEqual([]);
  });
});

describe("#446 CLOSURE-3: a malformed manifest is never a clean one", () => {
  test("files[] missing throws rather than reading as empty", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0" }));
    expect(() => readPackageFiles(dir)).toThrow(/no files\[\]/);
  });

  test("unparseable package.json throws", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(() => readPackageFiles(dir)).toThrow();
  });
});

describe("#446 CLOSURE-4: the check is load-bearing", () => {
  test("the binding appears exactly once, so no violation can route around it", () => {
    const src = readFileSync(SOURCE, "utf-8");
    expect(src.split(BINDING).length - 1).toBe(1);
  });

  test("short-circuiting it lets the planted defect through", async () => {
    const src = readFileSync(SOURCE, "utf-8");
    expect(src).toContain(BINDING);

    const dir = scratch();
    const mutantPath = join(dir, "mutant.ts");
    // No relative imports in the source, so the mutant runs from anywhere.
    expect(relativeImports(src)).toEqual([]);
    writeFileSync(mutantPath, src.replace(BINDING, `${BINDING}\n  return [];`));

    const broken = plantPackage({ publishTheImport: false });
    const published = publishedFiles(broken, readPackageFiles(broken));

    // Real check refuses...
    expect(packageClosureViolations(broken, published).length).toBe(1);
    // ...mutant waves it through. That gap is the proof.
    const mutant = await import(mutantPath);
    expect(mutant.packageClosureViolations(broken, published)).toEqual([]);
  });
});

describe("#446 CLOSURE-5: import forms the scanner must see", () => {
  for (const [label, line] of [
    ["static from", 'import { a } from "./x";'],
    ["bare side-effect", 'import "./x";'],
    ["dynamic", 'const m = await import("./x");'],
    ["require", 'const m = require("./x");'],
  ] as Array<[string, string]>) {
    test(`${label} is detected`, () => {
      expect(relativeImports(line)).toContain("./x");
    });
  }

  test("bare specifiers are ignored", () => {
    expect(relativeImports('import { z } from "zod";')).toEqual([]);
  });
});
