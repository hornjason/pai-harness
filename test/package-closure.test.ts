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
 *
 * ## #484 — the same question, asked of runtime reads
 *
 * `0.4.1` was cut TO FIX #446 and still shipped `lib/conformity.ts` reading
 * `../config/matcher-registry.json` from a directory `files[]` never named,
 * because that is not an import. Three directories and seven call sites were
 * in that state. `files[]` now carries `config/`, `templates/` and
 * `specs/SPEC-TEMPLATE.md`; `workflows/` turned out NOT to need publishing,
 * and the check established that rather than anyone asserting it — the only
 * reader, `scripts/validate-workflow.ts`, is itself unpublished.
 *
 * Predicted before running, then measured, over 29 tests:
 *
 * | Mutation | Predicted | Red |
 * |---|---|---|
 * | `config/` dropped from `files[]` | 1 | 1 |
 * | `templates/` dropped | 1 | 1 |
 * | `specs/SPEC-TEMPLATE.md` dropped | 1 | 1 |
 * | `runtimeReads` short-circuited to `return []` | 8 | 8 |
 * | comment stripping removed (scan raw source) | 4 | **3** |
 * | `keepStringContents` dropped, so segments blank | 8 | 8 |
 *
 * **Two rows did not come back as predicted, and both were findings.**
 *
 * The first draft had the three `files[]` rows at **2 red, not 1**. CLOSURE-1
 * asserted the whole violation list, so it and CLOSURE-8 were the same
 * assertion over the same input — two tests, one question, and either could be
 * deleted with the other still holding the case up. CLOSURE-1 is now filtered
 * to imports and CLOSURE-8 to reads, so each has an input only it can reach.
 *
 * The comment row came back 3 where 4 was expected, and the missing one is the
 * live-tree case. This module's own docstring quotes the broken expression to
 * explain it, and scanning raw source reports that quote as a call — which is
 * exactly how the defect was found. But now that `config/` ships, the quoted
 * path RESOLVES to a published file, so the live tree can no longer witness
 * the bug at all. The three synthetic CLOSURE-7 cases are the only thing
 * standing between this scanner and #454's mistake, and that is the whole
 * argument for not deleting them as redundant with the live-tree check.
 *
 * ## Four findings from the push security review (CLOSURE-10)
 *
 * The first is the one worth reading, because of where it was found: **a
 * fail-open, in the commit that adds a section about fail-opens to
 * `.claude/rules/checks-must-be-able-to-fail.md`.**
 *
 * `unresolvedModuleRelativeJoins` was exported, unit-tested, and never called
 * by `packageClosureViolations`. The module docstring said unresolvable reads
 * were "NOT silently dropped" while the only path that produces violations
 * dropped all of them. The unit test asserted the counter WORKED. Nothing
 * asserted the counter was CONSULTED, and those are different claims.
 *
 * The other three, each now a case:
 *
 * - The tokenizer dropped `\` and the character after it under
 *   `keepStringContents`, so `"a\"b"` came back as the segment `ab`. Not a
 *   truncated answer — a different path, which the checker would then name in
 *   a violation. Such a segment is now unresolvable, and therefore reported.
 * - `join` is resolved by identifier, so `import { join as j }` was invisible.
 *   Refused outright rather than missed; the blind spot is narrow and the
 *   point is that entering it cannot be silent.
 * - `publishedFiles` walked `files[]` entries with no containment check, and
 *   it recurses. `files: ["../../etc"]` would have enumerated the filesystem
 *   above the project. It throws.
 *
 * Measured over 53 tests, predicted first:
 *
 * | Mutation | Predicted | Red |
 * |---|---|---|
 * | unresolved joins not reported | 2 | **1** |
 * | alias refusal removed | 1 | 1 |
 * | traversal guard removed | 1 | 1 |
 *
 * The first missed because the escaped-character case asks
 * `unresolvedModuleRelativeJoins` directly rather than going through
 * `packageClosureViolations` — the scanner's classification and the reporting
 * of it are two questions, and they have a case each. The six rows above were
 * re-measured against this tree and reproduce exactly: 1, 1, 1, 8, 3, 8.
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
  runtimeReads,
  unresolvedModuleRelativeJoins,
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

/**
 * A mutant of `lib/package-closure.ts` that runs from a temp directory.
 *
 * #446's version asserted the source had NO relative imports and copied it
 * verbatim. #484 added `import { stripStringsAndComments } from
 * "./js-top-level-code"`, and that assertion caught it — which is the only
 * reason this is a rewriter and not a mutant that dies on module resolution
 * and reads as a refusal. `.claude/rules/checks-must-be-able-to-fail.md` names
 * that failure by name in the `rook-review-scope` example.
 *
 * Every specifier must be rewritten. One the rewriter cannot see ABORTS the
 * build rather than producing a mutant that cannot load.
 */
function buildMutant(src: string): string {
  let out = src;
  for (const specifier of relativeImports(src)) {
    const absolute = resolve(join(ROOT, "lib"), specifier);
    out = out.split(`"${specifier}"`).join(`"${absolute}"`);
  }
  const leftover = relativeImports(out);
  if (leftover.length > 0) {
    throw new Error(`could not build the mutant: unrewritten specifiers ${leftover.join(", ")}`);
  }
  return out;
}

describe("#446 CLOSURE-1: this package's own tarball is closed", () => {
  test("every relative import in a published file is itself published", () => {
    const published = publishedFiles(ROOT, readPackageFiles(ROOT));
    // A closure check over an empty file set passes for free.
    expect(published.size).toBeGreaterThan(20);
    // IMPORTS ONLY. #484 made `packageClosureViolations` answer two questions,
    // and asserting the whole list here made this case and CLOSURE-8 the same
    // assertion over the same input — removing `config/` from `files[]` turned
    // both red, so neither count attributed to the scanner that caught it and
    // either could be deleted with the other holding the case up. Splitting
    // the list by question gives each an input only it can reach, which is the
    // second remedy in `.claude/rules/checks-must-be-able-to-fail.md`.
    const imports = packageClosureViolations(ROOT, published).filter(v => !v.includes("at runtime"));
    expect(imports, imports.join("\n")).toEqual([]);
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
    writeFileSync(mutantPath, buildMutant(src.replace(BINDING, `${BINDING}\n  return [];`)));

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

/**
 * Covers #484 — a path a module builds from its own location and reads at
 * runtime is the same closure question an import is.
 *
 * `rungate@0.4.1` was cut TO FIX #446 and still shipped `lib/conformity.ts`
 * reading `../config/matcher-registry.json` out of a directory `files[]` never
 * named. The guard above could not see it, because it is not an import.
 */
describe("#484 CLOSURE-6: anchor forms the runtime scanner must see", () => {
  for (const [label, line, up, segments] of [
    ["import.meta.dir", 'readFileSync(join(import.meta.dir, "config", "r.json"))', 0, ["config", "r.json"]],
    ["__dirname", 'readFileSync(join(__dirname, "config", "r.json"))', 0, ["config", "r.json"]],
    [
      "dirname(fileURLToPath(import.meta.url))",
      'join(dirname(fileURLToPath(import.meta.url)), "config", "r.json")',
      0,
      ["config", "r.json"],
    ],
    // The live shapes, both of which climb. `..` as a segment and `dirname()`
    // as a wrapper mean the same thing and must fold into the same number.
    ['".." as a segment', 'join(import.meta.dir, "..", "config", "r.json")', 1, ["config", "r.json"]],
    ["nested dirname()", 'join(dirname(dirname(__dirname)), "templates", "agent-briefs")', 2, ["templates", "agent-briefs"]],
  ] as Array<[string, string, number, string[]]>) {
    test(`${label} resolves to ${up} up + ${segments.join("/")}`, () => {
      const [read] = runtimeReads(line);
      expect(read, `${label} was not detected at all`).toBeDefined();
      expect(read.up).toBe(up);
      expect(read.segments).toEqual(segments);
    });
  }

  test("a join that is not anchored to the module's own directory is ignored", () => {
    expect(runtimeReads('join(projectRoot, "config", "r.json")')).toEqual([]);
  });

  test("the bare package-root idiom is not a file read", () => {
    // Eleven published modules do this to find the package root. Reporting
    // them would have buried the three real findings in noise.
    expect(runtimeReads('const root = join(import.meta.dir, "..");')).toEqual([]);
  });

  test("a non-literal segment is recorded, not dropped", () => {
    // The fail-open this scanner could most easily have had: a path it cannot
    // resolve statically reading as a path with nothing wrong with it.
    expect(runtimeReads('join(import.meta.dir, "..", dir, "r.json")')).toEqual([]);
    expect(unresolvedModuleRelativeJoins('join(import.meta.dir, "..", dir, "r.json")')).toHaveLength(1);
  });
});

describe("#484 CLOSURE-7: a sentence about a call is not a call", () => {
  // This is not hypothetical. The first draft scanned raw source, and
  // `lib/package-closure.ts`'s own docstring — which quotes the broken
  // expression to explain the bug — was reported as a live violation of
  // itself. #454 is the same mistake in CONFIG-1, two weeks earlier.
  test("the expression inside a block comment is not detected", () => {
    const src = `/**\n * join(dirname(fileURLToPath(import.meta.url)), "..", "config", "r.json")\n */\nexport const x = 1;\n`;
    expect(runtimeReads(src)).toEqual([]);
  });

  test("the expression inside a line comment is not detected", () => {
    expect(runtimeReads('// join(import.meta.dir, "..", "config", "r.json")\n')).toEqual([]);
  });

  test("an identical expression in real code IS detected", () => {
    // The other half. A stripper that ate everything would pass the two cases
    // above for the wrong reason, and this is what tells them apart.
    const src = `/** join(import.meta.dir, "..", "config", "decoy.json") */\nconst p = join(import.meta.dir, "..", "config", "real.json");\n`;
    const reads = runtimeReads(src);
    expect(reads).toHaveLength(1);
    expect(reads[0].segments).toEqual(["config", "real.json"]);
  });
});

describe("#484 CLOSURE-8: the live tree is closed for reads as well as imports", () => {
  test("every runtime read in a published file resolves into the tarball", () => {
    const published = publishedFiles(ROOT, readPackageFiles(ROOT));
    const reads = packageClosureViolations(ROOT, published).filter(v => v.includes("at runtime"));
    expect(reads, reads.join("\n")).toEqual([]);
  });

  test("a directory target is published when the files under it are", () => {
    // `templates/agent-briefs` is a directory, and `published` is a set of
    // files. Asking `published.has("templates/agent-briefs")` would report a
    // violation for a directory that ships completely.
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "templates", "agent-briefs"), { recursive: true });
    writeFileSync(join(dir, "templates", "agent-briefs", "marcus.md"), "# brief\n");
    writeFileSync(join(dir, "lib", "s.ts"), 'const d = join(__dirname, "..", "templates", "agent-briefs");\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/", "templates/"] }));
    expect(packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)))).toEqual([]);
  });

  test("unpublishing that directory turns it red", () => {
    // The same fixture with one word changed — the direction that proves the
    // case above is not passing because nothing is being looked at.
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    mkdirSync(join(dir, "templates", "agent-briefs"), { recursive: true });
    writeFileSync(join(dir, "templates", "agent-briefs", "marcus.md"), "# brief\n");
    writeFileSync(join(dir, "lib", "s.ts"), 'const d = join(__dirname, "..", "templates", "agent-briefs");\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/"] }));
    const v = packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("templates/agent-briefs");
  });

  test("a read of something absent from the working tree is not this check's business", () => {
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "s.ts"), 'const d = join(__dirname, "..", "nowhere", "x.json");\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/"] }));
    expect(packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)))).toEqual([]);
  });
});

/**
 * Four findings from the push security review of the first #484 commit. Each
 * one is a case here, and the first is the reason the rest got written: it was
 * a fail-open in the commit that adds a section about fail-opens.
 */
describe("#484 CLOSURE-10: what the scanner cannot read, it refuses", () => {
  test("an unresolvable module-relative join is a violation, not a silence", () => {
    // THE FINDING. `unresolvedModuleRelativeJoins` was exported, unit-tested,
    // and never called by `packageClosureViolations` — so the docstring said
    // these were "NOT silently dropped" while the only path that produces
    // violations dropped every one of them. The unit test asserted the
    // counter worked; nothing asserted the counter was consulted.
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "s.ts"), 'const p = join(__dirname, "..", someDir, "r.json");\n');
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/"] }));
    const v = packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("UNMEASURED");
  });

  test("an escaped character makes a segment unresolvable rather than wrong", () => {
    // The tokenizer dropped `\` and the character after it, so `"a\"b"` came
    // back as the segment `ab` — not a truncated answer but a different path,
    // which the checker would then report on by name. A wrong answer stated
    // confidently is worse here than no answer.
    const src = String.raw`join(__dirname, "a\"b", "c.json")`;
    expect(runtimeReads(src)).toEqual([]);
    expect(unresolvedModuleRelativeJoins(src)).toHaveLength(1);
  });

  test("an aliased join import is refused, because the scanner resolves by name", () => {
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(
      join(dir, "lib", "s.ts"),
      'import { join as j } from "path";\nconst p = j(__dirname, "..", "config", "r.json");\n',
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/"] }));
    const v = packageClosureViolations(dir, publishedFiles(dir, readPackageFiles(dir)));
    expect(v.some(x => x.includes("alias"))).toBe(true);
  });

  test("a files[] entry that climbs out of the package throws", () => {
    // publishedFiles walks directories recursively. An unchecked `../..`
    // would enumerate the filesystem above the project.
    const dir = scratch();
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["../../etc"] }));
    expect(() => publishedFiles(dir, readPackageFiles(dir))).toThrow("escapes the package root");
  });

  test("the live tree has nothing unresolved, which is why this is strict", () => {
    // Enforcement is absolute rather than ratcheted because the count is zero
    // today. If this ever needs a banked number, that is a decision to make
    // deliberately, not a default to slide into.
    const published = publishedFiles(ROOT, readPackageFiles(ROOT));
    const unmeasured = packageClosureViolations(ROOT, published).filter(v => v.includes("UNMEASURED"));
    expect(unmeasured, unmeasured.join("\n")).toEqual([]);
  });
});

describe("#484 CLOSURE-9: the runtime scanner is load-bearing", () => {
  test("short-circuiting runtimeReads lets an unpublished read through", async () => {
    const src = readFileSync(SOURCE, "utf-8");
    const binding = "export function runtimeReads(source: string): RuntimeRead[] {";
    expect(src.split(binding).length - 1, "the binding signature appears other than once").toBe(1);

    const dir = scratch();
    const mutantPath = join(dir, "mutant-reads.ts");
    writeFileSync(mutantPath, buildMutant(src.replace(binding, `${binding}\n  return [];`)));

    const broken = scratch();
    mkdirSync(join(broken, "lib"), { recursive: true });
    mkdirSync(join(broken, "config"), { recursive: true });
    writeFileSync(join(broken, "config", "r.json"), "[]\n");
    writeFileSync(join(broken, "lib", "s.ts"), 'const p = join(__dirname, "..", "config", "r.json");\n');
    writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "f", version: "0.0.0", files: ["lib/"] }));
    const published = publishedFiles(broken, readPackageFiles(broken));

    // Real check refuses...
    expect(packageClosureViolations(broken, published)).toHaveLength(1);
    // ...mutant waves it through, and the import half still works, so the gap
    // is attributable to the reads scanner and nothing else.
    const mutant = await import(mutantPath);
    expect(mutant.packageClosureViolations(broken, published)).toEqual([]);
  });
});
