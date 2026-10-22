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
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "fs";
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
      const childAbs = join(root, childRel);
      // `lstat`, not `stat`. A symlink inside a published directory points
      // wherever it likes, and `relative()` cannot see that because the path
      // STRING is still under the root — a `linked/` symlink enumerated
      // `secret.txt` from a directory outside the package entirely. npm would
      // follow it into the tarball too, so this is a packaging hazard either
      // way and the honest answer is to refuse rather than to model it.
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        throw new Error(`package.json files[] reaches a symlink at "${childRel}" — refusing to resolve it`);
      }
      if (st.isDirectory()) addDir(childRel);
      else out.add(childRel);
    }
  }

  /** npm expands these; this checker does not, and must not pretend to. */
  const GLOB_META = /[*?[\]{}!]/;

  for (const pattern of patterns) {
    // A glob is not a path, and treating it as one resolves to NOTHING:
    // `files: ["scripts/*.ts"]` produced a published set containing only
    // package.json, so the closure loop had almost nothing to walk and
    // reported zero violations over a package it had not looked at. That is
    // the same vacuous-scan failure CONFIG-1 refuses, reached through the
    // manifest instead of through the file walk.
    if (GLOB_META.test(pattern)) {
      throw new Error(
        `package.json files[] entry "${pattern}" is a glob, which this checker does not expand — ` +
          `it would report a clean closure over files it never resolved`,
      );
    }
    const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    const abs = join(root, clean);
    // A files[] entry that climbs out of the package is never legitimate, and
    // this function walks directories recursively — so an unchecked `../..`
    // would enumerate the filesystem above the project. Refuse rather than
    // normalise: npm would not publish it either, and silently reading it as
    // the directory it resolves to would hide a malformed manifest.
    if (relative(root, abs).startsWith("..")) {
      throw new Error(`package.json files[] entry "${pattern}" escapes the package root`);
    }
    if (!existsSync(abs)) continue;
    // The same lstat the recursion does. A first draft checked only inside
    // addDir, so `files: ["linked/"]` — the symlink named as the entry itself
    // — walked straight past it and enumerated a directory outside the
    // package. The guard has to sit on every path that becomes a published
    // name, not only on the ones reached by recursion.
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(`package.json files[] entry "${pattern}" is a symlink — refusing to resolve it`);
    }
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

/**
 * A segment the scanner is willing to resolve.
 *
 * No backslash: an escaped character means the written text and the runtime
 * string differ, and resolving the text would name a path the code does not
 * read. Such a segment falls through to `unresolved`, where it is reported,
 * rather than being turned into a plausible wrong answer.
 */
const STRING_LITERAL = /^["'`]([^"'`\\]*)["'`]$/;

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
 * A path an instruction STRING tells the user to run, rooted at the installed
 * harness rather than at the user's own project.
 *
 * ## The third syntax (#1174)
 *
 * The two scanners above ask what published CODE reaches. Neither can see a
 * path that only ever appears in a message, and a message is how this package
 * hands a consumer the way out of a refusal.
 *
 * `REPAIR_HINT` in `lib/gate-result-protection.ts` is the documented repair
 * for a corrupt `workflow-state.json`, and it names
 * `<harness>/gates/orchestrator.ts`. `gates/` had **zero** entries in the
 * published `0.8.0` tarball, so that command could not resolve for any npm
 * consumer — and by #1137's design the guard printing it is deliberately
 * unbypassable, so there was no second route out. `packageClosureViolations`
 * reported the package closed the whole time, because every IMPORT and every
 * READ did resolve. A detector narrower than what it detects, which is the
 * shape `.claude/rules/checks-must-be-able-to-fail.md` names second and which
 * #484 records one paragraph above having already made once.
 *
 * Shipping `hooks/` for the first time in 0.8.0 took this from two
 * instructions to six. A published directory brings its instructions with it,
 * so closing one packaging gap widens this surface rather than narrowing it —
 * which is the argument for a check here instead of a one-time fix.
 *
 * ## Only harness-rooted paths count
 *
 * `lib/typescript-project.ts` emits `bun scripts/typecheck.ts`, and that
 * `scripts/` is the CONSUMER's, where the scaffold writes one. Resolving a
 * bare relative path against this package would invent a defect in the
 * commonest kind of instruction we emit. So the path has to say it means the
 * harness: an explicit `$HARNESS_ROOT`/`<harness>` anchor, or the `./` of a
 * `bun -e` one-liner, which these hints run from the harness root.
 */
export interface InstructionPath {
  /** How the string named the harness root, for the violation message. */
  anchor: string;
  /** Package-relative path the instruction names. */
  path: string;
}

/** Spellings of "the installed harness package root" inside a message. */
const HARNESS_ROOT_ANCHOR =
  /(\$\{HARNESS_ROOT\}|\$HARNESS_ROOT|<harness>)\/((?:[\w.-]+\/)*[\w.-]+\.\w+)/g;

/**
 * The import specifier of a `bun -e` one-liner — a `./`-rooted path after the
 * `from` keyword. Quotes are optional here because the hint is itself inside
 * a string, so they arrive backslash-escaped as often as not.
 *
 * Spelled without an example of the thing it matches on purpose:
 * `relativeImports` above scans RAW source, so a docstring quoting a real
 * specifier is read as a phantom import and the mutation battery in
 * `test/package-closure.test.ts` aborts rewriting it. Found by that battery.
 */
const BUN_EVAL_SPECIFIER = /from\s*\\?["']?\.\/((?:[\w.-]+\/)*[\w.-]+\.\w+)/g;

export function instructionPaths(raw: string): InstructionPath[] {
  // Comments out, string and template text kept. `runtimeReads` does the same
  // thing for the same reason, and here the live tree proves it is needed in
  // both directions: `lib/shell-path-interpolation.ts` explains shell quoting
  // with a `${HARNESS_ROOT}/scripts/x.ts` example in a DOCSTRING, which a
  // scanner reading raw source reports as a shipped instruction; and three of
  // the six real instructions are template literals, which `keepStringContents`
  // alone blanks. Either half alone gets the live tree wrong.
  const source = stripStringsAndComments(raw, {
    keepStringContents: true,
    keepTemplateText: true,
  });
  const found: InstructionPath[] = [];
  let m: RegExpExecArray | null;

  HARNESS_ROOT_ANCHOR.lastIndex = 0;
  while ((m = HARNESS_ROOT_ANCHOR.exec(source)) !== null) {
    found.push({ anchor: m[1], path: m[2] });
  }

  // Scoped to the line carrying the `bun -e`, not to `./` generally: a bare
  // `./` in any other message is relative to wherever the user is standing,
  // and this package cannot say where that is.
  for (const line of source.split("\n")) {
    if (!line.includes("bun -e")) continue;
    BUN_EVAL_SPECIFIER.lastIndex = 0;
    while ((m = BUN_EVAL_SPECIFIER.exec(line)) !== null) {
      found.push({ anchor: "bun -e .", path: m[1] });
    }
  }

  return found;
}

/**
 * The single binding. `test/package-closure.test.ts` builds a mutant of this
 * module with the body short-circuited to `return []` and asserts the suite
 * goes quiet over a package that is genuinely broken — which is the only thing
 * separating this from a line in a report.
 */
export function packageClosureViolations(root: string, published: Set<string>): string[] {
  const violations: string[] = [];
  let scanned = 0;

  for (const file of published) {
    if (!SOURCE_EXT.test(file)) continue;
    scanned++;
    const source = readFileSync(join(root, file), "utf-8");

    // A module-relative path the scanner could not resolve statically is
    // UNMEASURED, and unmeasured is not clean. The first draft of this module
    // exported `unresolvedModuleRelativeJoins`, tested it in isolation, and
    // never called it from here — so its own docstring claimed these were
    // "NOT silently dropped" while the only path that produces violations
    // dropped them. Found by the push security review, in the same commit
    // that adds a section about exactly this to
    // `.claude/rules/checks-must-be-able-to-fail.md`.
    //
    // Enforced strictly because the live tree has zero: there is no migration
    // window to ratchet through, so a new one fails immediately.
    for (const expression of unresolvedModuleRelativeJoins(source)) {
      violations.push(
        `${file} builds ${expression} from its own directory and the segments are not all literal — ` +
          `the scanner cannot say what it reads, so whether it ships is UNMEASURED`,
      );
    }

    // `join` resolved by identifier. An aliased import would be invisible, so
    // it is refused rather than missed — the blind spot is small, and the
    // point is that entering it cannot be silent.
    if (/\bimport\s*\{[^}]*\bjoin\s+as\s+\w/.test(source)) {
      violations.push(
        `${file} imports join under an alias, which this scanner resolves by name and would not see`,
      );
    }

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

    // #1174. An instruction naming a path the tarball does not carry is the
    // same closure property again, in the one syntax neither scanner above
    // can reach — so it is answered here, against the same `published` set,
    // rather than in a fourth checker that could drift from these three.
    for (const { anchor, path } of instructionPaths(source)) {
      // Absent from the working tree too is a different bug — a stale or
      // illustrative path — and not this check's business. Same rule the
      // import walker below applies, and on the live tree it is what keeps
      // `$HARNESS_ROOT/scripts/x.ts` out of the violation list.
      if (!existsSync(join(root, path))) continue;

      const isPublished = statSync(join(root, path)).isDirectory()
        ? [...published].some(p => p.startsWith(`${path}/`))
        : published.has(path);

      if (!isPublished) {
        violations.push(
          `${file} instructs the user to run ${anchor}/${path}, which files[] does not publish`,
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

  // A closure check that walked no source reports a closed package and cannot
  // be told from one. Every way of producing an empty set found so far — a
  // glob entry, a files[] naming only non-source, a wrong root — throws or
  // refuses somewhere above; this is the backstop for the next one, because
  // the list of ways is not knowable in advance. ADR-002 D4, same argument.
  if (scanned === 0) {
    return [
      "package closure: NO published source files were scanned. A check that reads nothing " +
        "reports nothing and cannot be told from a closed package — refusing rather than " +
        "reporting clean.",
    ];
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
