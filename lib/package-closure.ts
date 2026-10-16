/**
 * Package closure — does everything the tarball ships still resolve once it is
 * the only thing on disk?
 *
 * `lib/` publishes whole. `scripts/` publishes by allowlist, one path at a
 * time. An import that crosses from the first into the second is only sound
 * while the allowlist happens to name its target, and nothing checked that.
 * `lib/conformity.ts` imported `../scripts/split-spec` through two releases
 * with the file left out, so every consumer of `rungate/lib/conformity` died
 * on import while the repo stayed green — the suites resolve that path against
 * the working tree, where it exists (#446).
 *
 * The check is static and offline: expand `files[]` into the set the tarball
 * would carry, then walk the relative imports of every published source file
 * and assert each target is in that set. One `catch` here would turn a
 * malformed package.json into "no violations", so there is none.
 *
 * ## Imports were half of it (#484)
 *
 * The version of this module that shipped with #446 asked one question —
 * *does every relative IMPORT resolve to a published file?* — and `0.4.1` went
 * out with `SUCCESS.md` recording that the distribution had been verified. It
 * had been verified for imports.
 *
 * `lib/conformity.ts:495` does not import its matcher registry. It builds a
 * path and reads it:
 *
 *     join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json")
 *
 * `config/` was not in `files[]`, so `resolveMatcher()` threw ENOENT for every
 * consumer, and `bunx rungate create-sc --list` — a command the README
 * documents — died the same way. Same defect as #446, different syntax, and
 * the guard written for #446 was structurally incapable of seeing it: a
 * detector narrower than what it detects, which is the shape
 * `.claude/rules/checks-must-be-able-to-fail.md` names third.
 *
 * What made it latent rather than loud is worth recording. An external
 * consumer does not reach `resolveMatcher` until one of its success criteria
 * MATCHES a registry pattern. Measured on `pov-plugin`: 21 pass, 0 fail, over
 * a library that could not load its own registry, purely because all 40 of its
 * SCs were unmatched. The reward for making its spec more testable would have
 * been an ENOENT crash, and nothing connected those two events.
 *
 * So both syntaxes are asked the same question here, and `runtimeReads` is
 * deliberately NOT a second copy of the import walker — the two find different
 * things and both feed the one `packageClosureViolations` binding, so there is
 * still exactly one decider to mutate.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { stripStringsAndComments } from "./js-top-level-code";

/** Extensions a bare specifier may acquire, in the order a resolver tries. */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".json", "/index.ts", "/index.js"];

const SOURCE_EXT = /\.(ts|tsx|mts|js|mjs)$/;

/** `files[]` entries are either a directory ("lib/") or one exact path. */
export function publishedFiles(root: string, patterns: string[]): Set<string> {
  const out = new Set<string>();

  function addDir(rel: string) {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      const childRel = `${rel}/${entry}`.replace(/\/+/g, "/");
      if (statSync(join(root, childRel)).isDirectory()) addDir(childRel);
      else out.add(childRel);
    }
  }

  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    const abs = join(root, clean);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) addDir(clean);
    else out.add(clean);
  }

  // npm always includes these regardless of files[].
  for (const always of ["package.json", "README.md", "LICENSE"]) {
    if (existsSync(join(root, always))) out.add(always);
  }
  return out;
}

/** Relative specifiers only — bare ones are the dependency resolver's problem. */
export function relativeImports(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["'](\.[^"']+)["']/g,
    /\bimport\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(source)) !== null) found.push(m[1]);
  }
  return found;
}

/**
 * A path a module builds from its OWN location and then reads at runtime.
 *
 * `up` is how many directories above the source file the path starts, and
 * `segments` is what is appended. The two anchors below both mean "the
 * directory this module is in", so they are 0; every `dirname()` wrapped
 * around one, and every `".."` among the segments, adds a level.
 */
export interface RuntimeRead {
  /** The expression as written, for the violation message. */
  expression: string;
  /** Directories above the source file's own directory. */
  up: number;
  /** Literal path segments below that, `..` already folded into `up`. */
  segments: string[];
}

/** Spellings of "the directory this module lives in". */
const MODULE_DIR_ANCHORS = [
  /\bdirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)/,
  /\bimport\.meta\.dir\b/,
  /\b__dirname\b/,
];

/** Split a `join(...)` argument list on top-level commas. */
function splitArgs(argText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (quote) {
      if (c === quote && argText[i - 1] !== "\\") quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; current += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

const STRING_LITERAL = /^["'`]([^"'`]*)["'`]$/;

/**
 * Every `join(<this module's directory>, ...literals)` in a source file.
 *
 * Only fully-literal segment lists are returned. A `join` whose segments come
 * from a variable cannot be resolved statically and is NOT silently dropped —
 * `unresolvedModuleRelativeJoins` counts those separately so a new one is
 * visible rather than absorbed, which is the fail-open this whole module
 * exists to avoid.
 */
export function runtimeReads(source: string): RuntimeRead[] {
  return scanModuleRelativeJoins(source).resolved;
}

/** Module-relative `join(...)` calls whose segments are not all literals. */
export function unresolvedModuleRelativeJoins(source: string): string[] {
  return scanModuleRelativeJoins(source).unresolved;
}

function scanModuleRelativeJoins(raw: string): { resolved: RuntimeRead[]; unresolved: string[] } {
  const resolved: RuntimeRead[] = [];
  const unresolved: string[] = [];

  // Comments out, string contents kept. The first draft of this scanner read
  // raw source and reported THIS MODULE's own docstring — which quotes the
  // `join(dirname(fileURLToPath(...)), "..", "config", ...)` expression to
  // explain the bug — as a live violation. A detector that cannot tell a call
  // from a sentence about a call is #454 again.
  const source = stripStringsAndComments(raw, { keepStringContents: true });

  for (let i = source.indexOf("join"); i !== -1; i = source.indexOf("join", i + 1)) {
    // `join` must be the whole identifier, and an open paren must follow.
    if (i > 0 && /[A-Za-z0-9_$.]/.test(source[i - 1])) continue;
    let j = i + 4;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== "(") continue;

    // Walk to the matching close paren.
    let depth = 0;
    let k = j;
    for (; k < source.length; k++) {
      if (source[k] === "(") depth++;
      else if (source[k] === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;

    const argText = source.slice(j + 1, k);
    const args = splitArgs(argText);
    if (args.length < 2) continue;

    const anchor = args[0];
    if (!MODULE_DIR_ANCHORS.some(a => a.test(anchor))) continue;

    // `dirname(fileURLToPath(import.meta.url))` IS the anchor, so remove it
    // before counting the dirname() calls that genuinely climb.
    const climbing = anchor.replace(MODULE_DIR_ANCHORS[0], "");
    let up = (climbing.match(/\bdirname\s*\(/g) || []).length;

    const expression = `join(${args.join(", ")})`;
    const segments: string[] = [];
    let literal = true;
    for (const arg of args.slice(1)) {
      const m = STRING_LITERAL.exec(arg);
      if (!m) { literal = false; break; }
      for (const part of m[1].split("/").filter(Boolean)) {
        if (part === "..") { if (segments.length) segments.pop(); else up++; }
        else if (part !== ".") segments.push(part);
      }
    }

    // `join(import.meta.dir, "..")` with nothing below it is the "find the
    // package root" idiom, not a read of a particular file. Eleven published
    // modules use it and none of them is a closure question.
    if (literal && segments.length > 0) resolved.push({ expression, up, segments });
    else if (!literal) unresolved.push(expression);
  }

  return { resolved, unresolved };
}

/**
 * The single binding. `test/package-closure.test.ts` builds a mutant of this
 * module with the body short-circuited to `return []` and asserts the suite
 * goes quiet over a package that is genuinely broken — which is the only thing
 * separating this from a line in a report.
 */
export function packageClosureViolations(root: string, published: Set<string>): string[] {
  const violations: string[] = [];

  for (const file of published) {
    if (!SOURCE_EXT.test(file)) continue;
    const source = readFileSync(join(root, file), "utf-8");

    // #484. A path built from the module's own location and read at runtime
    // asks the same question an import does, so it is answered here and not
    // in a second checker that could drift from this one.
    for (const read of runtimeReads(source)) {
      let dir = dirname(join(root, file));
      for (let n = 0; n < read.up; n++) dir = dirname(dir);
      const target = join(dir, ...read.segments);
      const targetRel = relative(root, target);

      // Outside the package entirely is not this check's business.
      if (targetRel.startsWith("..")) continue;
      if (!existsSync(target)) continue;

      const isPublished = statSync(target).isDirectory()
        ? [...published].some(p => p === targetRel || p.startsWith(`${targetRel}/`))
        : published.has(targetRel);

      if (!isPublished) {
        violations.push(
          `${file} reads ${read.expression} at runtime -> ${targetRel}, which files[] does not publish`,
        );
      }
    }

    for (const specifier of relativeImports(source)) {
      const target = resolve(dirname(join(root, file)), specifier);
      const targetRel = relative(root, target);

      // Resolvable against the working tree but absent from the tarball is
      // the whole defect — a path that does not exist at all is a different
      // bug, and typecheck already owns it.
      const existsOnDisk = CANDIDATE_SUFFIXES.some(s => existsSync(target + s));
      if (!existsOnDisk) continue;

      const isPublished = CANDIDATE_SUFFIXES.some(s => published.has(`${targetRel}${s}`.replace(/\/+/g, "/")));
      if (!isPublished) {
        violations.push(`${file} imports "${specifier}" -> ${targetRel}, which files[] does not publish`);
      }
    }
  }
  return violations.sort();
}

export function readPackageFiles(root: string): string[] {
  // Deliberately unguarded: a malformed package.json must throw, not read as
  // a package with nothing in it.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  if (!Array.isArray(pkg.files)) {
    throw new Error("package.json has no files[] array — cannot determine what ships");
  }
  return pkg.files;
}
