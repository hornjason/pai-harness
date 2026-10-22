/**
 * The import list of a TypeScript source, read by parsing it (#1219).
 *
 * `test/unit/scanner.test.ts` used to answer "does `lib/scanner.ts` import a
 * generator?" by running four function names over the raw file text. That
 * reading is wrong in both directions and they are not equally bad:
 *
 *   - A COMMENT naming a generator counted as an import. Measured: #1200 added
 *     `generateCodeMapInline` to a comment in `scanDirs`, CI shard 4 went red
 *     on that case alone, and the repair was to reword the comment.
 *   - A generation module imported for a symbol OUTSIDE the four names did
 *     not count at all. `lib/generators/code-map.ts` also exports
 *     `FRESHNESS_NOTICE` and `directoryTable`; importing either breaks the
 *     isolation property just as badly and the text reading said nothing.
 *
 * The second direction is the one that matters — a guard that cannot see the
 * thing it exists to see. A better regular expression is the cheapest wrong
 * fix: one that skips `//` and `/* *\/` and also matches `import(` is still a
 * text matcher, the shape `.claude/rules/checks-must-be-able-to-fail.md` names
 * as "a detector narrower than what it detects".
 *
 * So this reads the imports instead. `Bun.Transpiler.scanImports` is the
 * parser bun uses to resolve a module's dependencies: it reports static
 * imports, dynamic `import(...)` and `require(...)` with literal specifiers,
 * and it has already discarded comments and string literals by the time it
 * answers.
 *
 * ## Why there is a second pass
 *
 * `scanImports` runs the TS loader, so `import type` / `export type` are
 * ERASED before it ever sees them — measured on bun 1.3.14, with and without
 * `trimUnusedImports`. For "does this pull in generation logic at runtime"
 * that erasure is correct, but the text reading it replaces DID flag a
 * type-only import of a generator, and a replacement that is weaker on a case
 * the old one caught is not an improvement.
 *
 * So the source is scanned twice: once as written, and once with the `type`
 * keyword removed from import/export declarations. The parser stays the sole
 * detector — the rewrite only un-erases a syntax the TS loader drops. It
 * cannot manufacture a violation, because a rewritten mention inside a comment
 * or a string literal is still inside a comment or a string literal, and the
 * parser discards both. Anything the second pass sees and the first does not
 * is type-only.
 *
 * ## An empty reading is UNMEASURED, not zero
 *
 * `scanImports` THROWS on a source it cannot parse rather than returning `[]`
 * (verified: "Failed to scan imports", "Unexpected end of file"), so an empty
 * list means a file with no imports. This module re-throws with UNMEASURED in
 * the message so a reading that could not be taken can never read as a clean
 * one, and callers additionally assert the count they expect.
 *
 * ## Why this is a helper and not an export from a test file
 *
 * Same reason as `./strip-comments`: importing from a test file registers that
 * file's cases into the importer. A helper has no `test()` at module scope.
 */
import { dirname, resolve, relative, sep } from "path";

export interface ParsedImport {
  /** The specifier exactly as written, e.g. `./generators/code-map`. */
  specifier: string;
  /** `import-statement`, `dynamic-import`, `require-call`, … (bun's own kinds). */
  kind: string;
  /** True when only the type-erasing pass saw it (`import type` / `export type`). */
  typeOnly: boolean;
  /** Repo-relative, extensionless path, or null for a package specifier. */
  resolved: string | null;
}

/** Repo root — this file is `test/helpers/`, so two levels up. */
const ROOT = resolve(import.meta.dir, "..", "..");

/**
 * `import type {…} from "x"` → `import {…} from "x"`, same for `export type`.
 *
 * Deliberately narrow: `export type Foo = …` must NOT be touched, because
 * `export Foo = …` does not parse — so the `export` form requires a following
 * `{`. If a rewrite ever does produce an unparseable source, `scanImports`
 * throws and the reading is reported UNMEASURED rather than coming back empty.
 */
function unerasTypeImports(source: string): string {
  return source
    .replace(/\bimport\s+type\s+(?=[{*A-Za-z_$])/g, "import ")
    .replace(/\bexport\s+type\s+(?=\{)/g, "export ");
}

/**
 * A leading `#!/usr/bin/env bun` is module syntax `scanImports` refuses —
 * "Unexpected #!/usr/bin/env bun". Measured over the 946 TypeScript files in
 * this repo, it is the ONLY thing that makes a real file unreadable: 107
 * files failed to parse and all 107 were hashbangs. Blanked rather than
 * deleted, so every line number downstream still points where it did.
 */
function dropHashbang(source: string): string {
  return source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1 || source.length) : source;
}

function scan(source: string, label: string): Array<{ path: string; kind: string }> {
  try {
    return new Bun.Transpiler({ loader: "ts" }).scanImports(dropHashbang(source)) as Array<{
      path: string;
      kind: string;
    }>;
  } catch (err) {
    throw new Error(
      `UNMEASURED: could not parse imports (${label}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Repo-relative extensionless path for a specifier, or null if it is a package. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const spec = specifier;
  // `rungate/lib/...` is this package naming itself; it is repo-root relative,
  // not relative to the importing file.
  let abs: string;
  if (spec.startsWith("rungate/")) abs = resolve(ROOT, spec.slice("rungate/".length));
  else if (spec.startsWith("/")) abs = spec;
  else if (spec.startsWith(".")) abs = resolve(dirname(resolve(ROOT, fromFile)), spec);
  else return null;
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..")) return null;
  return rel.split(sep).join("/").replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
}

/**
 * Every import in `source`, parsed. `fromFile` is the path the source lives at
 * (absolute, or relative to the repo root) and is used only to resolve
 * relative specifiers — the reading itself never touches the filesystem, so a
 * mutated copy of a real file can be measured without being written anywhere.
 *
 * Throws (never returns `[]`) when the source cannot be parsed.
 */
export function parseImports(source: string, fromFile: string): ParsedImport[] {
  const runtime = scan(source, fromFile);
  const withTypes = scan(unerasTypeImports(source), `${fromFile} (type pass)`);

  // Multiset difference: two imports of the same path, one typed one not, must
  // not cancel each other out.
  const remaining = new Map<string, number>();
  for (const r of runtime) remaining.set(r.path, (remaining.get(r.path) ?? 0) + 1);

  const out: ParsedImport[] = [];
  for (const imp of withTypes) {
    const left = remaining.get(imp.path) ?? 0;
    const typeOnly = left === 0;
    if (!typeOnly) remaining.set(imp.path, left - 1);
    out.push({
      specifier: imp.path,
      kind: imp.kind,
      typeOnly,
      resolved: resolveSpecifier(imp.path, fromFile),
    });
  }
  return out;
}

/**
 * Is this module generation logic, for the purposes of the scanner's import
 * isolation (AC-3 of `specs/SCAFFOLD-DECOMPOSITION-SPEC.md`)?
 *
 * Wider than either text reading it replaces, by path rather than by symbol
 * spelling: every module under `lib/generators/` except `types` (which is the
 * typed interface, not generation logic), plus `lib/scaffold/steps`, which is
 * where `safeWrite` and `generateConformityTest` actually live — the path
 * reading in `test/scanner.test.ts` never covered that file, and the symbol
 * reading in `test/unit/scanner.test.ts` covered it only for as long as
 * nobody imported a fifth name from it.
 */
export function isGenerationModule(resolved: string | null): boolean {
  if (!resolved) return false;
  if (resolved === "lib/generators/types") return false;
  if (resolved.startsWith("lib/generators/")) return true;
  return resolved === "lib/scaffold/steps";
}

/** The imports of `source` that pull in generation logic. Empty is the pass. */
export function generationImports(source: string, fromFile: string): ParsedImport[] {
  return parseImports(source, fromFile).filter((i) => isGenerationModule(i.resolved));
}
