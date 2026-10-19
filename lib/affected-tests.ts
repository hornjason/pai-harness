/**
 * Which test files can reach a given set of changed files (#676).
 *
 * A ship run pays for the whole suite to learn about the handful of files it
 * changed: 374 files, 13,915 tests, ~8.9 minutes and 5,360 MB. That last
 * number is why `lib/test-suite-lock.ts` sets `DEFAULT_CAPACITY = 2` — the
 * suite, not the checkout, is what holds concurrent runs at two.
 *
 * **The direction this is allowed to be wrong in is TOWARD running too much.**
 * A selection that is too large costs minutes. A selection that is too small
 * reports a green suite over a regression, wearing the most convincing
 * disguise available. So every question this module cannot answer resolves to
 * "run everything", and it says which question it was.
 *
 * In particular an empty `tests` list is NEVER an instruction to run nothing.
 * `0`, `{}`, `null` and `SKIP` are indistinguishable from success
 * (`.claude/rules/config-access.md`); `UNMEASURED` is not. A caller must be
 * able to tell "nothing is affected" from "I could not work out what is
 * affected", and those are `reading`, not `tests.length`.
 *
 * Three ways a test reaches a file, because a graph that knows only the first
 * reads exactly like a graph that is satisfied (#484 — an import and a
 * `readFileSync(join(...))` are one question in two syntaxes):
 *
 *   1. a chain of relative imports, followed transitively
 *   2. a module-relative `readFileSync(join(import.meta.dir, ...))`
 *   3. a sweep — `readdirSync` or a glob — which is affected by anything
 *      under the tree it walks and cannot be expressed as an edge at all
 *
 * Sweeps are included unconditionally AND listed in `sweeps`. Including one
 * silently would make "the graph selected this" and "I could not reason about
 * this so I kept it" the same output, which is the reporting-position defect
 * this repo keeps finding.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { join, dirname } from "path";

import { relativeImports, runtimeReads, unresolvedModuleRelativeJoins } from "./package-closure";
import { stripJsComments } from "./strip-js-comments";

/** Extensions whose dependencies this module can actually resolve. */
export const SELECTABLE_SOURCE = /\.(ts|tsx|js|jsx|mts|cts)$/;

/** A test file, by the convention this repo uses everywhere. */
export const TEST_FILE = /\.test\.(ts|tsx)$/;

/**
 * Directories walked when building the graph.
 *
 * `workflows` is in this list for a reason worth stating: `ship.js` is the
 * most-changed file in this repository and it cannot be imported (#69), so
 * it is reached only by the tests that read it as text. Leaving the
 * directory out did not make a change to it UNMEASURED — it made the change
 * resolve to nothing and report MEASURED, which is silent under-selection
 * and the exact failure this module exists to prevent. Found in review
 * before it shipped; every fixture in the battery put its changed files
 * inside the walked tree, so the branch where that is false was outside the
 * battery's reach entirely (#492).
 */
export const SCAN_DIRS = ["test", "lib", "scripts", "gates", "bin", "hooks", "workflows"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/**
 * A test that discovers its subjects at runtime rather than importing them.
 *
 * Deliberately a family rather than one spelling: a detector that knows only
 * `readdirSync` is the narrow-detector shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, and the cost of missing a
 * sweep is a green run over a tree it never walked.
 *
 * `execSync`/`spawnSync` are included ONLY when the command text contains an
 * enumeration verb. Marking every shell-out a sweep would catch the tests
 * that `git grep` the tree — which are genuine sweeps — and also every test
 * that runs `git rev-parse`, which is most of them, and the selection would
 * collapse to the whole suite. The matched spelling is reported so the
 * over-inclusion stays visible rather than becoming a number nobody can
 * explain.
 */
const SWEEP_PATTERNS: Array<[string, RegExp]> = [
  ["readdir", /\b(readdirSync|readdir|opendirSync|opendir)\s*\(/],
  ["glob", /\b(globSync|glob)\s*\(|\bGlob\b|\.scan\s*\(/],
  ["shell-enumeration", /\b(execSync|spawnSync|execFileSync)\s*\([^)]*?(grep\s+-r|git\s+grep|git\s+ls-files|\bfind\b|\bls\b)/],
];

export interface AffectedTestsReading {
  /** `UNMEASURED` means run the full suite; `tests` is empty and means nothing. */
  reading: "MEASURED" | "UNMEASURED";
  /** Repo-relative test files to run, sorted. Empty under UNMEASURED. */
  tests: string[];
  /** Why the selection cannot be trusted. Empty when MEASURED. */
  unmeasuredReasons: string[];
  /** Test files the walk found — the denominator for `selected`. */
  testFilesSeen: number;
  /** `tests.length`, stated so a reader does not have to count. */
  selected: number;
  /** Selected because they enumerate a directory, not because of an edge. */
  sweeps: string[];
}

/** Repo-relative, forward slashes, no leading `./`. */
function norm(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

/**
 * Every source file under SCAN_DIRS, repo-relative.
 *
 * Symlinked directories are followed — a monorepo whose packages are linked
 * into place is a real layout, and `readdirSync(withFileTypes)` reports a
 * symlink as not-a-directory, so a `statSync` is the only thing that makes
 * them visible (#500). Following them means a link cycle would recurse
 * forever, so every directory is recorded by its REAL path and visited
 * once, and a link pointing outside the root is declined rather than
 * walked.
 */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const seenDirs = new Set<string>();
  const rootReal = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();

  const walk = (rel: string): void => {
    const abs = join(root, rel);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    if (real !== rootReal && !real.startsWith(rootReal + "/")) return; // escaped the tree
    if (seenDirs.has(real)) return; // a cycle, or two links to one directory
    seenDirs.add(real);

    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // a directory this project does not have
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = norm(join(rel, e.name));
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = statSync(join(root, child)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) walk(child);
      else if (SELECTABLE_SOURCE.test(e.name)) out.push(child);
    }
  };
  for (const d of SCAN_DIRS) walk(d);
  return out;
}

/**
 * Resolve a relative specifier written in `from` to a file in `known`.
 *
 * The `.js` → `.ts` candidates are not decoration: TypeScript source that
 * targets ESM writes `./x.js` for a file on disk called `x.ts`, and a
 * resolver that does not know that drops the edge silently.
 */
function resolveSpec(from: string, spec: string, known: Set<string>): string | null {
  const base = norm(join(dirname(from), spec));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    norm(join(base, "index.ts")),
    norm(join(base, "index.tsx")),
  ];
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

/** Where a module-relative `join(import.meta.dir, ...)` points, repo-relative. */
function resolveRuntimeRead(from: string, up: number, segments: string[]): string {
  let base = dirname(from);
  for (let i = 0; i < up; i++) base = dirname(base);
  return norm(join(base, ...segments));
}

/**
 * The test files that can reach any of `changed`.
 *
 * `changed` is repo-relative. The reading is UNMEASURED — meaning "run the
 * full suite" — when the graph provably cannot answer: an empty change set,
 * a changed module the walk never saw, a changed non-module nothing in the
 * tree names, or a walk that found no tests at all. That last one is #492's
 * lesson: a scan that reached nothing reports the same clean result as a
 * scan that found nothing wrong.
 */
export function affectedTests(root: string, changed: string[]): AffectedTestsReading {
  const unmeasuredReasons: string[] = [];
  const wanted = changed.map(norm);

  if (wanted.length === 0) {
    unmeasuredReasons.push(
      "no changed files were supplied, so nothing constrains the selection — " +
        "an unconstrained selection is the whole suite, not an empty one",
    );
  }

  const nonModule = wanted.filter(c => !SELECTABLE_SOURCE.test(c));
  const files = sourceFiles(root);
  const known = new Set(files);
  const testFiles = files.filter(f => TEST_FILE.test(f));

  // A changed file the walk never saw has NO EDGE to it by construction, so
  // every test comes back unaffected and the reading would say MEASURED over
  // a question it never asked. This is the one that nearly shipped: before
  // `workflows` was in SCAN_DIRS, a change to `ship.js` landed here.
  for (const c of wanted) {
    if (SELECTABLE_SOURCE.test(c) && !known.has(c)) {
      unmeasuredReasons.push(
        `${c} is outside the walked tree (${SCAN_DIRS.join(", ")}) or no longer exists, so no ` +
          "edge to it can exist — \"nothing is affected\" would be an artefact of not looking",
      );
    }
  }

  if (testFiles.length === 0) {
    unmeasuredReasons.push(
      `the walk over ${SCAN_DIRS.join(", ")} found no test files, which is not the ` +
        "same as finding no affected ones",
    );
  }

  // REVERSE edges: for each file, who depends on it.
  //
  // Walking dependents outward from the changed set is linear and has no
  // interaction with cycles at all. The first draft walked forward from each
  // test with a memo, which is unsound in exactly one way that is hard to
  // see: a `false` computed while a cycle edge was cut gets cached, and a
  // later query reads the wrong answer. Reversing the question removes the
  // bug rather than guarding it.
  const dependents = new Map<string, Set<string>>();
  const sweeps: string[] = [];
  const opaque: string[] = [];

  const addEdge = (from: string, to: string): void => {
    let s = dependents.get(to);
    if (!s) {
      s = new Set();
      dependents.set(to, s);
    }
    s.add(from);
  };

  for (const f of files) {
    let source: string;
    try {
      source = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }
    for (const spec of relativeImports(source)) {
      const target = resolveSpec(f, spec, known);
      if (target) addEdge(f, target);
    }
    const resolvedBasenames = new Set<string>();
    for (const read of runtimeReads(source)) {
      const target = resolveRuntimeRead(f, read.up, read.segments);
      resolvedBasenames.add(target.split("/").pop() as string);
      addEdge(f, target);
    }

    // A changed file that is not a module is reached by the files that NAME
    // it. Nothing imports a rule file, a spec or a YAML, so the first draft
    // refused the whole selection whenever one appeared in the change set —
    // and measured against eight real commits of this repository, seven
    // carried at least one, so the feature was inert on the input it exists
    // to serve.
    //
    // **Over a COMMENT-STRIPPED view.** A citation and a read are the same
    // bytes, and this repository cites its own rule files constantly:
    // matching raw source, `.claude/rules/checks-must-be-able-to-fail.md`
    // alone selected 322 of 388 files — 83% of the suite — because almost
    // every test mentions it in a docstring. Over code only it is 108, of
    // which 72 are the sweep floor. `blankLiterals` stays OFF: the path
    // lives in a string literal, which is exactly the thing a read is made
    // of.
    //
    // The direction of error is unchanged. A reader that does not write the
    // path down in code is assembling it at runtime, and a file that does
    // that is already a sweep.
    const code = stripJsComments(source);
    for (const c of nonModule) {
      if (code.includes(c)) addEdge(f, c);
    }

    // The same question in a third syntax (#484). `runtimeReads` sees
    // `join(import.meta.dir, "..", "workflows", "ship.js")` and nothing
    // else, so one const of indirection hides the read:
    //
    //   const REPO_ROOT = join(import.meta.dir, "..");
    //   readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8")
    //
    // Measured on this repository, that is not hypothetical — it is how
    // `test/implement-empty-result.test.ts` and
    // `test/files-changed-path-shape.test.ts` reach `ship.js`, and both
    // were silently unselected by a change to it. Resolving the
    // indirection means evaluating the module, so instead the BASENAME as
    // a quoted literal in code is an edge. It over-selects for a common
    // basename and that is the direction this is allowed to be wrong in;
    // a missed read is the direction that reports green over code it
    // never ran.
    //
    // **Skipped for a basename this file already reads resolvably**, and
    // that clause is what keeps `runtimeReads` load-bearing rather than a
    // second decider agreeing with this one. Measured before it was added:
    // deleting the `runtimeReads` call entirely was 0 red and moved the
    // real selection by 0 files, because a resolvable read always quotes
    // its own basename. With the clause, a file that resolvably reads
    // `lib/a/config.ts` is NOT selected by a change to `lib/b/config.ts`
    // — it has shown it can name that basename precisely — while a file
    // that reaches the same path through a const still is. Two deciders,
    // each with an input only it can reach.
    for (const c of wanted) {
      const b = c.split("/").pop();
      if (!b || resolvedBasenames.has(b)) continue;
      if (new RegExp(`["'\`]${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(code)) {
        addEdge(f, c);
      }
    }

    // A module-relative join whose segments are not all literals reads a
    // path nobody can name statically. `runtimeReads` drops those; dropping
    // them here would be the fail-open `lib/package-closure.ts` built
    // `unresolvedModuleRelativeJoins` to prevent. A test that does it is a
    // sweep; anything else becomes a seed, so every test that can reach it
    // runs too.
    const unresolved = unresolvedModuleRelativeJoins(source).length > 0;
    if (TEST_FILE.test(f)) {
      if (unresolved || SWEEP_PATTERNS.some(([, re]) => re.test(code))) sweeps.push(f);
    } else if (unresolved) {
      opaque.push(f);
    }
  }

  // A non-module file nothing in the tree names is not an unaffected file —
  // it is a file whose readers, if it has any, build its path at runtime,
  // and the graph has no way to see them. Refuse by name.
  for (const c of nonModule) {
    if (!dependents.has(c)) {
      unmeasuredReasons.push(
        `${c} is not a module, and no file under ${SCAN_DIRS.join(", ")} names it, so any test ` +
          "that reads it builds the path at runtime where the graph cannot follow",
      );
    }
  }

  if (unmeasuredReasons.length > 0) {
    return {
      reading: "UNMEASURED",
      tests: [],
      unmeasuredReasons,
      testFilesSeen: testFiles.length,
      selected: 0,
      sweeps: [],
    };
  }

  // Breadth-first over dependents, seeded with the change set and with every
  // module whose own reads could not be resolved.
  const reached = new Set<string>();
  const queue = [...wanted, ...opaque];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    if (reached.has(cur)) continue;
    reached.add(cur);
    for (const d of dependents.get(cur) ?? []) if (!reached.has(d)) queue.push(d);
  }

  const sweepSet = new Set(sweeps);
  const tests = testFiles.filter(t => sweepSet.has(t) || reached.has(t)).sort();

  return {
    reading: "MEASURED",
    tests,
    unmeasuredReasons: [],
    testFilesSeen: testFiles.length,
    selected: tests.length,
    sweeps: sweeps.sort(),
  };
}
