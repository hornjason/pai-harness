/**
 * Covers #1570 — a bare specifier in a published file must name a package the
 * consumer's installer will have.
 *
 * The defect: `import ts from "typescript"` under `lib/` typechecks, resolves,
 * and passes every suite here, because `typescript` is a devDependency and is
 * installed in this checkout. A consumer who ran `bunx rungate@<version>` got
 * `dependencies` only — `@octokit/rest`, `acorn`, `zod` — and the import dies
 * on their runner. `test/package-closure.test.ts` CLOSURE-5 declines the
 * question by design (`"bare specifiers are ignored"`, and correctly so: the
 * tarball carries no `node_modules`), so until this file nothing asked it.
 *
 * The live tree is clean of this today, which is exactly why the live-tree
 * case alone proves nothing. The evidence is the planted violation in
 * DEVDEP-2, its `acorn` control, and the mutation in DEVDEP-7.
 *
 * ## What was broken to make it fail
 *
 * An `import ts from "typescript"` planted in a published file of a fixture
 * package. DEVDEP-2 runs that plant and its control — the identical file
 * importing `acorn` instead — so the row cannot go green by refusing
 * everything. DEVDEP-7 then short-circuits `publishedDependencyViolations` to
 * `return []` and asserts the planted case stops being caught, which is the
 * only thing that distinguishes a working check from an absent one.
 *
 * ## Predicted, then measured
 *
 * Six mutations of `test/helpers/published-deps.ts`. Every number below was
 * written down before the battery ran, against the 55 cases this file had at
 * the time.
 *
 * | Mutation | Predicted | Red of 55 |
 * |---|---|---|
 * | `publishedDependencyViolations` → `return []` | 29 | 29 |
 * | `isRuntimeModule` → `return false` | 14 | 14 |
 * | `packageNameOf` → `return specifier` (no subpath strip) | 8 | **6** |
 * | self-name exemption (`pkg === self`) removed | 1 | 1 |
 * | `dev-only`/`undeclared` collapsed to one state | 3 | 3 |
 * | empty-scan refusal removed | 1 | 1 |
 *
 * **One row did not come back as predicted, and it was a finding.**
 *
 * The subpath row was predicted at 8 and measured 6. The two cases that
 * stayed green were both about `fs/promises`, and the reason is that
 * `module.builtinModules` carries **twelve subpath members of its own** —
 * `fs/promises`, `stream/web`, `path/posix`, `timers/promises` and the rest.
 * So a listed subpath is exempt by direct membership and never reaches the
 * strip at all. The prediction had assumed the strip was what exempted it.
 *
 * That left `packageNameOf`'s role inside `isRuntimeModule` with no input
 * only it could reach — a line that reads as load-bearing and is not, which
 * is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`. The
 * case *"a listed subpath is exempt by membership; an unlisted one by the
 * strip"* in DEVDEP-8 was added for exactly that, and it is the difference
 * between the two batteries below.
 *
 * Re-run over the 56 cases this file now has, all six as predicted:
 *
 * | Mutation | Predicted | Red of 56 |
 * |---|---|---|
 * | `publishedDependencyViolations` → `return []` | 29 | 29 |
 * | `isRuntimeModule` → `return false` | 15 | 15 |
 * | `packageNameOf` → `return specifier` | 7 | 7 |
 * | self-name exemption removed | 1 | 1 |
 * | `dev-only`/`undeclared` collapsed | 3 | 3 |
 * | empty-scan refusal removed | 1 | 1 |
 *
 * None is left in the tree; each was applied to a copy, run, and restored
 * from a backup taken before the battery — not with `git checkout --`, which
 * has eaten an uncommitted rewrite here before.
 *
 * The battery's own positive control earned its place on the first attempt:
 * the mutator took its argument from the wrong `argv` index and changed
 * nothing, and the `MUTATION CHANGED NOTHING — aborting` guard is the only
 * reason six rows of `0 fail` were not recorded as six confirmed predictions.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { builtinModules } from "module";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { remedyMessage } from "../lib/check-remedy";
import { packageClosureViolations, publishedFiles, readPackageFiles, relativeImports } from "../lib/package-closure";
import {
  isRuntimeModule,
  packageNameOf,
  publishedDependencyViolations,
  readDeclarations,
  type DependencyViolation,
} from "./helpers/published-deps";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = join(ROOT, "test", "helpers", "published-deps.ts");
const BINDING =
  "export function publishedDependencyViolations(root: string, published: Set<string>): DependencyViolation[] {";

const temps: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "devdep-"));
  temps.push(dir);
  return dir;
}
afterAll(() => temps.forEach(d => rmSync(d, { recursive: true, force: true })));

interface Fixture {
  /** repo-relative path -> source text. Directories are created as needed. */
  sources: Record<string, string>;
  /** `files[]`. Defaults to `["lib/"]`. */
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  name?: string;
}

/**
 * A package shaped like this one: `acorn` in dependencies, `typescript` in
 * devDependencies, `lib/` published.
 */
function plant(fixture: Fixture): string {
  const dir = scratch();
  for (const [rel, source] of Object.entries(fixture.sources)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), source);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: fixture.name ?? "fixture-pkg",
      version: "0.0.0",
      files: fixture.files ?? ["lib/"],
      dependencies: fixture.dependencies ?? { acorn: "^8.19.0" },
      devDependencies: fixture.devDependencies ?? { typescript: "5.9.3" },
      ...(fixture.peerDependencies ? { peerDependencies: fixture.peerDependencies } : {}),
      ...(fixture.optionalDependencies ? { optionalDependencies: fixture.optionalDependencies } : {}),
    }),
  );
  return dir;
}

function violationsIn(dir: string): DependencyViolation[] {
  return publishedDependencyViolations(dir, publishedFiles(dir, readPackageFiles(dir)));
}

/** One published file containing exactly `line`, in the standard fixture. */
function planted(line: string, extra: Partial<Fixture> = {}): DependencyViolation[] {
  return violationsIn(plant({ sources: { "lib/a.ts": `${line}\nexport const marker = 1;\n` }, ...extra }));
}

describe("#1570 DEVDEP-1: this package's published files import only declared packages", () => {
  test("every bare specifier in a published file names something a consumer will have", () => {
    const published = publishedFiles(ROOT, readPackageFiles(ROOT));
    // A dependency check over an empty file set passes for free.
    expect(published.size).toBeGreaterThan(20);
    const violations = publishedDependencyViolations(ROOT, published);
    expect(
      violations.map(v => v.message),
      remedyMessage({
        root: ROOT,
        check: "DEVDEP-1",
        violations: violations.map(v => v.message),
        fix:
          "import a package that is in `dependencies`, not `devDependencies` — `lib/ts-ast.ts` wraps " +
          "`acorn` for parsing (#968) — or move the package into `dependencies` if a consumer really " +
          "needs it shipped.",
      }),
    ).toEqual([]);
  });
});

describe("#1570 DEVDEP-2: the planted violation, and the control that makes it mean something", () => {
  test("a published file importing a devDependency is named", () => {
    const violations = planted('import ts from "typescript";');
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe("typescript");
    expect(violations[0].state).toBe("dev-only");
    expect(violations[0].file).toBe("lib/a.ts");
  });

  test("the identical file importing a dependency is not", () => {
    // Without this the row above is satisfied by a check that refuses
    // everything, which is the same failure wearing the opposite sign.
    expect(planted('import { Parser } from "acorn";')).toEqual([]);
  });

  test("a subpath resolves to the same package and is caught", () => {
    const violations = planted('import ts from "typescript/lib/typescript.js";');
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe("typescript");
    expect(violations[0].state).toBe("dev-only");
    expect(violations[0].specifier).toBe("typescript/lib/typescript.js");
  });

  test("a package in neither dependency field is refused with a different message", () => {
    const violations = planted('import pad from "left-pad";');
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe("left-pad");
    expect(violations[0].state).toBe("undeclared");
    // "dev-only" and "undeclared" have different fixes, so a reader who cannot
    // tell them apart has been told which line is wrong and not what to do.
    expect(violations[0].message).toContain("does not declare in any dependency field");
    expect(planted('import ts from "typescript";')[0].message).toContain("only in devDependencies");
  });

  test("a peerDependency satisfies an import, because the consumer is told to install it", () => {
    expect(
      planted('import r from "react";', { peerDependencies: { react: "^18" } }),
    ).toEqual([]);
  });

  test("an optionalDependency does too", () => {
    expect(
      planted('import f from "fsevents";', { optionalDependencies: { fsevents: "^2" } }),
    ).toEqual([]);
  });
});

describe("#1570 DEVDEP-3: import forms the reading must see", () => {
  const FORMS: Array<[string, string]> = [
    ["static default", 'import ts from "%s";'],
    ["static named", 'import { x } from "%s";'],
    ["namespace", 'import * as ns from "%s";'],
    ["bare side-effect", 'import "%s";'],
    ["dynamic", 'const m = await import("%s");'],
    ["require", 'const m = require("%s");'],
    ["re-export", 'export { x } from "%s";'],
    // Erased by bun before execution, so it would not break `bunx` at runtime.
    // Refused anyway — this package ships raw `.ts` and a consumer who
    // typechecks resolves the specifier for real. The reasoning is in
    // `test/helpers/published-deps.ts`.
    ["import type", 'import type { N } from "%s";'],
  ];

  for (const [label, template] of FORMS) {
    test(`${label} of a devDependency is caught`, () => {
      const violations = planted(template.replace("%s", "typescript"));
      expect(violations, `${label} was not detected at all`).toHaveLength(1);
      expect(violations[0].pkg).toBe("typescript");
    });

    test(`${label} of a dependency is not`, () => {
      expect(planted(template.replace("%s", "acorn"))).toEqual([]);
    });
  }

  test("a specifier quoted inside a comment is not an import", () => {
    // The shape a regular-expression reading gets wrong, and the reason this
    // parses rather than matches text.
    expect(planted('// the mistake was `import ts from "typescript"` here')).toEqual([]);
  });

  test("a specifier inside a string literal is not an import", () => {
    expect(planted('export const advice = \'do not import "typescript"\';')).toEqual([]);
  });
});

describe("#1570 DEVDEP-4: what no package.json can declare, and the live tree needs every row", () => {
  // Each row plants the exempt import ALONGSIDE a sentinel that must be
  // caught. Asserting "exactly the sentinel" proves both that the exempt
  // specifier was waved through and that the scan actually read the file —
  // a row asserting `[]` alone would also pass over a file nobody opened.
  const EXEMPT = [
    "fs",
    "fs/promises",
    "node:fs",
    "node:child_process",
    "path",
    "child_process",
    "crypto",
    "os",
    "url",
    "zlib",
    "bun",
    "bun:test",
  ];

  for (const specifier of EXEMPT) {
    test(`"${specifier}" is the runtime's, not a package`, () => {
      const violations = violationsIn(
        plant({
          sources: {
            "lib/a.ts": `import * as m from "${specifier}";\nexport const x = m;\n`,
            "lib/sentinel.ts": 'import ts from "typescript";\nexport const y = ts;\n',
          },
        }),
      );
      expect(violations.map(v => `${v.file}:${v.pkg}`)).toEqual(["lib/sentinel.ts:typescript"]);
    });
  }

  test("a package merely NAMED like a builtin is not exempt", () => {
    // The control for the whole table above: without it, every row is also
    // satisfied by an exemption that matches far too much.
    const violations = planted('import x from "fs-extra";');
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe("fs-extra");
    expect(violations[0].state).toBe("undeclared");
  });

  test("the package importing itself by name resolves to the installed package", () => {
    const violations = violationsIn(
      plant({
        name: "fixture-pkg",
        sources: {
          "lib/a.ts": 'import { c } from "fixture-pkg/lib/other";\nexport const x = c;\n',
          "lib/other.ts": "export const c = 1;\n",
          "lib/sentinel.ts": 'import ts from "typescript";\nexport const y = ts;\n',
        },
      }),
    );
    expect(violations.map(v => `${v.file}:${v.pkg}`)).toEqual(["lib/sentinel.ts:typescript"]);
  });

  test("a relative specifier is package-closure's question, not this one", () => {
    expect(
      violationsIn(
        plant({
          sources: { "lib/a.ts": 'import { c } from "./other";\nexport const x = c;\n', "lib/other.ts": "export const c = 1;\n" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("#1570 DEVDEP-5: the boundary with package closure, executed rather than assumed", () => {
  /** `lib/a.ts` ships and imports `scripts/helper.ts`, which imports typescript. */
  function twoFileFixture(publishTheHelper: boolean): string {
    return plant({
      files: publishTheHelper ? ["lib/", "scripts/helper.ts"] : ["lib/"],
      sources: {
        "lib/a.ts": 'import { h } from "../scripts/helper";\nexport const x = h;\n',
        "scripts/helper.ts": 'import ts from "typescript";\nexport const h = ts;\n',
      },
    });
  }

  test("an unpublished file's devDependency import is CLOSURE's finding, not this check's", () => {
    const dir = twoFileFixture(false);
    const published = publishedFiles(dir, readPackageFiles(dir));
    // This check scans what ships. `scripts/helper.ts` does not ship, so the
    // specifier inside it is not reachable from the tarball at all.
    expect(publishedDependencyViolations(dir, published)).toEqual([]);
    // And the reason it does not ship is already refused, by name, next door.
    const closure = packageClosureViolations(dir, published);
    expect(closure).toHaveLength(1);
    expect(closure[0]).toContain("scripts/helper");
  });

  test("publishing that helper clears CLOSURE and hands the import to this check", () => {
    const dir = twoFileFixture(true);
    const published = publishedFiles(dir, readPackageFiles(dir));
    expect(packageClosureViolations(dir, published)).toEqual([]);
    const violations = publishedDependencyViolations(dir, published);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("scripts/helper.ts");
    expect(violations[0].pkg).toBe("typescript");
  });
});

describe("#1570 DEVDEP-6: a reading that could not be taken is never a clean one", () => {
  test("a published set with no source file refuses rather than reporting clean", () => {
    const dir = plant({ files: ["docs/"], sources: { "docs/readme.md": "# hi\n" } });
    const violations = violationsIn(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0].state).toBe("unmeasured");
    expect(violations[0].message).toContain("NO published source file was scanned");
  });

  test("a package.json with no name throws rather than resolving self-imports to nothing", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0", files: ["lib/"] }));
    expect(() => readDeclarations(dir)).toThrow(/no name/);
  });

  test("an unparseable package.json throws", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(() => readDeclarations(dir)).toThrow();
  });

  test("a published source that does not parse throws rather than reading as clean", () => {
    const dir = plant({ sources: { "lib/a.ts": "import { from 'broken'\n" } });
    expect(() => violationsIn(dir)).toThrow(/UNMEASURED/);
  });
});

describe("#1570 DEVDEP-7: the check is load-bearing", () => {
  test("the binding appears exactly once, so no reading can route around it", () => {
    const src = readFileSync(SOURCE, "utf-8");
    expect(src.split(BINDING).length - 1).toBe(1);
  });

  test("short-circuiting it lets the planted defect through", async () => {
    const src = readFileSync(SOURCE, "utf-8");
    expect(src).toContain(BINDING);

    const dir = scratch();
    const mutantPath = join(dir, "mutant.ts");
    writeFileSync(mutantPath, buildMutant(src.replace(BINDING, `${BINDING}\n  return [];`)));

    const broken = plant({ sources: { "lib/a.ts": 'import ts from "typescript";\nexport const x = ts;\n' } });
    const published = publishedFiles(broken, readPackageFiles(broken));

    // Real check refuses...
    expect(publishedDependencyViolations(broken, published)).toHaveLength(1);
    // ...mutant waves it through. That gap is the proof.
    const mutant = await import(mutantPath);
    expect(mutant.publishedDependencyViolations(broken, published)).toEqual([]);
  });
});

/**
 * A copy of the helper that loads from a temp directory.
 *
 * Every relative specifier must be rewritten. One the rewriter cannot see
 * ABORTS, rather than producing a mutant that dies on module resolution — a
 * failure to load reads as the mutation having been rejected on the merits,
 * which is the shape `.claude/rules/checks-must-be-able-to-fail.md` names in
 * its `rook-review-scope` example.
 */
function buildMutant(src: string): string {
  let out = src;
  for (const specifier of relativeImports(src)) {
    out = out.split(`"${specifier}"`).join(`"${resolve(join(ROOT, "test", "helpers"), specifier)}"`);
  }
  const leftover = relativeImports(out);
  if (leftover.length > 0) {
    throw new Error(`could not build the mutant: unrewritten specifiers ${leftover.join(", ")}`);
  }
  return out;
}

describe("#1570 DEVDEP-8: the readings the binding is composed of", () => {
  for (const [specifier, pkg] of [
    ["typescript", "typescript"],
    ["typescript/lib/typescript.js", "typescript"],
    ["@octokit/rest", "@octokit/rest"],
    ["@octokit/rest/dist-node/index.js", "@octokit/rest"],
    ["fs/promises", "fs"],
  ] as Array<[string, string]>) {
    test(`"${specifier}" names the package "${pkg}"`, () => {
      expect(packageNameOf(specifier)).toBe(pkg);
    });
  }

  test("a scoped specifier keeps both segments, or every scoped package reads as undeclared", () => {
    expect(packageNameOf("@scope/pkg/deep/path")).toBe("@scope/pkg");
  });

  test("isRuntimeModule separates the runtime from node_modules", () => {
    expect(["fs", "node:fs", "bun", "bun:sqlite", "fs/promises"].filter(s => !isRuntimeModule(s))).toEqual([]);
    expect(["typescript", "acorn", "fs-extra", "@octokit/rest"].filter(isRuntimeModule)).toEqual([]);
  });

  test("a listed subpath is exempt by membership; an unlisted one by the strip", () => {
    // Measured, not assumed: a mutation that removed the subpath strip was
    // predicted to redden `fs/promises` and left it green, because
    // `builtinModules` carries twelve subpath members of its own. So the only
    // input that reaches the strip inside `isRuntimeModule` is a subpath the
    // list does NOT carry — and without this case, removing the strike there
    // costs nothing and the line reads as dead.
    expect(builtinModules).toContain("fs/promises");
    expect(isRuntimeModule("fs/promises")).toBe(true);
    expect(builtinModules).not.toContain("fs/no-such-export");
    // Resolves to nothing, so it is the runtime's failure to report, not a
    // missing dependency — nothing installs `fs`.
    expect(isRuntimeModule("fs/no-such-export")).toBe(true);
  });
});
