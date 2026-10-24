/**
 * Does every bare specifier a PUBLISHED file imports name a package the
 * consumer will actually have? (#1570)
 *
 * `test/package-closure.test.ts` CLOSURE-5 has a case named, in its own words,
 * `"bare specifiers are ignored"`. That is correct for the question CLOSURE
 * asks — *does every relative import resolve inside the tarball* — because the
 * tarball never carries `node_modules` and resolving `zod` is the consumer's
 * installer's job. The gap is that nobody asked the next question: does the
 * installer have any reason to install it?
 *
 * `import ts from "typescript"` in `lib/` typechecks, resolves, and passes
 * every suite in this repo, because `typescript` is a devDependency and is
 * therefore installed HERE. It is not installed at a consumer, who ran
 * `bunx rungate@<version>` and got `dependencies` only. The failure lands on
 * somebody else's runner and nothing in this repo can see it.
 *
 * Three people reached that wrong conclusion from the same evidence in one
 * day (#1555, #1552/#1566, and two agent briefs that had to be retracted).
 * The reasoning is not careless: every local signal says the import is fine.
 * The only thing separating `typescript` from `acorn` is which half of
 * `package.json` declares it, which is the one place nobody looks while
 * writing an import — so an instruction telling people to look is the weakest
 * possible instrument.
 *
 * ## The property, not a list of package names
 *
 * A hardcoded list of forbidden names is a detector the next devDependency
 * defeats. This collects what the tarball ships — from `files[]`, via
 * `publishedFiles`, so a directory added to `files[]` later is covered without
 * anyone remembering — and refuses any bare specifier whose package is not in
 * `dependencies`.
 *
 * Three readings, named apart because they have different fixes:
 *
 * | state | meaning | fix |
 * |---|---|---|
 * | `dev-only` | declared, but in `devDependencies` | use a runtime binding, or move the package |
 * | `undeclared` | in no dependency field at all | declare it in `dependencies`, or stop importing it |
 * | `unmeasured` | the scan read no published source | fix the manifest; this is never a pass |
 *
 * ## `import type` is refused too, deliberately
 *
 * Bun erases `import type` before execution, so a type-only import of
 * `typescript` would not break `bunx rungate@<v>` at runtime. It is still
 * refused, for two reasons:
 *
 *   - This package ships raw `.ts` — `exports` points at `./lib/conformity.ts`
 *     — so a consumer who typechecks against it resolves that specifier for
 *     real, and `typescript` is not there to resolve.
 *   - A check that allowed it would publish its own bypass: write
 *     `import type`, then widen it to a value import in the next commit, and
 *     the guard never fires.
 *
 * Measured before deciding: the published set contains exactly **one**
 * type-only import today and it is of `fs`, so refusing the form costs
 * nothing. `@types/bun` is a devDependency but is never named by a specifier —
 * it is ambient through `tsconfig`.
 *
 * The per-occurrence `typeOnly` flag from `./import-specifiers` is
 * deliberately NOT read here. That flag is assigned by a positional multiset
 * diff, so when one module imports the same specifier both ways the COUNT is
 * right and the ATTRIBUTION is swapped (measured: a file whose `import type`
 * comes first reports the type-only import as `typeOnly: false` and the value
 * import as `typeOnly: true`). Since both are refused, the verdict does not
 * depend on it — but a message that named the form would have been wrong.
 *
 * ## Why this reuses `./import-specifiers` rather than scanning text
 *
 * `relativeImports` in `lib/package-closure.ts` is four regular expressions.
 * They are correct for the narrow thing they match, and a fifth one for bare
 * specifiers would be the shape `.claude/rules/checks-must-be-able-to-fail.md`
 * calls "a detector narrower than what it detects" — defeated by a comment
 * quoting an import, by `export … from`, by a line break inside the
 * declaration. `parseImports` runs `Bun.Transpiler.scanImports`, which has
 * already discarded comments and string literals by the time it answers, and
 * reports static imports, dynamic `import()` and `require()` alike.
 *
 * ## Why a helper and not a test export
 *
 * Same reason as `./import-specifiers`: importing from a test file registers
 * that file's cases into the importer. A helper has no `test()` at module
 * scope.
 */
import { builtinModules } from "module";
import { readFileSync } from "fs";
import { join } from "path";
import { parseImports } from "./import-specifiers";

/** Only these are parsed. A `.json` or `.md` in the tarball imports nothing. */
const SOURCE_EXT = /\.(ts|tsx|mts|js|mjs)$/;

/**
 * Specifiers the runtime provides, so no `package.json` field can declare them.
 *
 * `module.builtinModules` on bun reports 76 entries and already includes
 * `bun` and `bun:test` (measured on the bun this repo pins). `"bun"` is listed
 * explicitly anyway: `lib/screenshot-upload.ts` imports it, and the exemption
 * of a runtime module must not depend on another runtime's list staying the
 * same shape. The `node:` and `bun:` prefixes are handled before this set is
 * consulted, so a prefixed spelling never needs a member here.
 */
const RUNTIME_MODULES = new Set<string>([...builtinModules, "bun"]);

/** Which half of `package.json` a specifier's package turned out to be in. */
export type DependencyState = "dev-only" | "undeclared" | "unmeasured";

export interface DependencyViolation {
  /** Published, repo-relative path of the importing file. */
  file: string;
  /** The specifier exactly as written, e.g. `typescript/lib/typescript.js`. */
  specifier: string;
  /** The package it names, e.g. `typescript`. */
  pkg: string;
  state: DependencyState;
  /** What to tell the reader. Includes the fix, which differs per state. */
  message: string;
}

/**
 * The package a bare specifier names: `typescript` for
 * `typescript/lib/typescript.js`, `@octokit/rest` for `@octokit/rest/dist/x`.
 *
 * Subpath stripping is the whole reason this is a function. A reading that
 * compared the raw specifier against `dependencies` would report
 * `@octokit/rest/plugin-retry` as undeclared while `@octokit/rest` is right
 * there — a false refusal — and, worse, would let `typescript/lib/…` through
 * a name-based allowlist.
 */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Is this specifier served by the runtime rather than by `node_modules`?
 *
 * The set is consulted through `packageNameOf`, which looks redundant and is
 * not: `builtinModules` carries twelve subpath members of its own
 * (`fs/promises`, `stream/web`, `path/posix`, …), so those are exempt by
 * direct membership and never reach the strip. What the strip is for is the
 * subpath that is NOT a member — `fs/no-such-export`. That specifier resolves
 * to nothing, and the honest answer is that it is the runtime's business and
 * not the dependency graph's: nothing installs `fs`, so reporting it as an
 * undeclared dependency would be a true failure with a false diagnosis.
 *
 * A mutation predicting `fs/promises` would redden when the strip was removed
 * came back green, which is how the division above was measured rather than
 * assumed.
 */
export function isRuntimeModule(specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return true;
  return RUNTIME_MODULES.has(packageNameOf(specifier));
}

export interface Declarations {
  /** Packages the consumer's installer will have fetched. */
  satisfying: Set<string>;
  /** Packages declared only for development here. */
  dev: Set<string>;
  /** The package's own name — a self-referential import resolves to itself. */
  self: string;
}

/**
 * What `package.json` declares, split by what it means for a consumer.
 *
 * `peerDependencies` and `optionalDependencies` satisfy an import because the
 * consumer's installer is told about them; `devDependencies` does not, because
 * it is not published in the dependency graph at all.
 *
 * Deliberately unguarded: a malformed or nameless manifest THROWS. A package
 * whose name cannot be read is one whose self-imports cannot be recognised,
 * and reporting that as a clean scan is the defect this module exists for.
 */
export function readDeclarations(root: string): Declarations {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    throw new Error("package.json has no name — cannot tell a self-import from an undeclared one");
  }
  return {
    satisfying: new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]),
    dev: new Set(Object.keys(pkg.devDependencies ?? {})),
    self: pkg.name,
  };
}

function violationMessage(file: string, specifier: string, pkg: string, state: DependencyState): string {
  const named = pkg === specifier ? `"${pkg}"` : `"${specifier}" -> package "${pkg}"`;
  if (state === "dev-only") {
    return (
      `${file} imports ${named}, which package.json declares only in devDependencies. ` +
      `It resolves here and is absent at \`bunx\` on a consumer's runner. ` +
      `Use a package already in dependencies — \`lib/ts-ast.ts\` wraps \`acorn\` for parsing (#968) — ` +
      `or move "${pkg}" into dependencies if the consumer genuinely needs to ship it.`
    );
  }
  return (
    `${file} imports ${named}, which package.json does not declare in any dependency field. ` +
    `Nothing will install it for a consumer. Add "${pkg}" to dependencies, or stop importing it ` +
    `from a published file.`
  );
}

/**
 * The single binding. `test/published-deps.test.ts` builds a mutant of this
 * module with the body short-circuited to `return []` and asserts a package
 * that is genuinely broken stops being reported — which is the only thing
 * separating this from a line in a report
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * `published` is the set `publishedFiles(root, readPackageFiles(root))`
 * returns, so the population is derived from `files[]` and never from a list
 * of directory names written down here.
 */
export function publishedDependencyViolations(root: string, published: Set<string>): DependencyViolation[] {
  const { satisfying, dev, self } = readDeclarations(root);
  const violations: DependencyViolation[] = [];
  let scanned = 0;

  for (const file of [...published].sort()) {
    if (!SOURCE_EXT.test(file)) continue;
    scanned++;
    // `parseImports` THROWS on a source it cannot parse rather than returning
    // an empty list, so a file this scan could not read can never read as a
    // file with nothing wrong in it.
    for (const { specifier } of parseImports(readFileSync(join(root, file), "utf-8"), file)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (isRuntimeModule(specifier)) continue;
      const pkg = packageNameOf(specifier);
      // `rungate/lib/conformity` from inside rungate resolves to the installed
      // package itself, which the consumer has by definition.
      if (pkg === self) continue;
      if (satisfying.has(pkg)) continue;
      const state: DependencyState = dev.has(pkg) ? "dev-only" : "undeclared";
      violations.push({ file, specifier, pkg, state, message: violationMessage(file, specifier, pkg, state) });
    }
  }

  // A scan that read no source reports a clean package and cannot be told from
  // one. Every route to an empty published set found so far throws inside
  // `publishedFiles` — a glob, a `..` entry, a symlink — but a glob was not on
  // that list before #446 measured it, and the list is not knowable in
  // advance. Same backstop, same argument, as `packageClosureViolations`.
  if (scanned === 0) {
    return [
      {
        file: "(none)",
        specifier: "(none)",
        pkg: "(none)",
        state: "unmeasured",
        message:
          "published dependencies: NO published source file was scanned. A check that reads nothing " +
          "reports nothing and cannot be told from a package whose imports are all declared — " +
          "refusing rather than reporting clean.",
      },
    ];
  }
  return violations.sort((a, b) => `${a.file}|${a.specifier}`.localeCompare(`${b.file}|${b.specifier}`));
}
