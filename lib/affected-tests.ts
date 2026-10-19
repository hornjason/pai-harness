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
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";

import { relativeImports, runtimeReads } from "./package-closure";

/** Extensions whose dependencies this module can actually resolve. */
export const SELECTABLE_SOURCE = /\.(ts|tsx|js|jsx|mts|cts)$/;

/** A test file, by the convention this repo uses everywhere. */
export const TEST_FILE = /\.test\.(ts|tsx)$/;

/** Directories walked when building the graph. */
export const SCAN_DIRS = ["test", "lib", "scripts", "gates", "bin", "hooks"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/**
 * A test that enumerates a directory rather than importing from it.
 *
 * `Bun.Glob` and `globSync` are here as well as `readdirSync` because the
 * question is "does this test discover its subjects at runtime", and a
 * detector that knows one spelling of that is the narrow-detector shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
const SWEEP = /\breaddirSync\s*\(|\bBun\s*\.\s*Glob\b|\bglobSync\s*\(/;

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

/** Every source file under SCAN_DIRS, repo-relative. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
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
 * a changed file whose dependencies are not expressible as imports, or a
 * walk that found no tests at all. That last one is #492's lesson: a scan
 * that reached nothing reports the same clean result as a scan that found
 * nothing wrong.
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

  for (const c of wanted) {
    if (!SELECTABLE_SOURCE.test(c)) {
      unmeasuredReasons.push(
        `${c} is not a module this graph can follow: nothing imports a template, ` +
          "a rule file or a workflow YAML, and the tests that read it do so by path",
      );
    }
  }

  const files = sourceFiles(root);
  const known = new Set(files);
  const testFiles = files.filter(f => TEST_FILE.test(f));

  if (testFiles.length === 0) {
    unmeasuredReasons.push(
      `the walk over ${SCAN_DIRS.join(", ")} found no test files, which is not the ` +
        "same as finding no affected ones",
    );
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

  // Forward edges: a file depends on what it imports and what it reads.
  const deps = new Map<string, Set<string>>();
  const sweeps: string[] = [];
  for (const f of files) {
    let source: string;
    try {
      source = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }
    const edges = new Set<string>();
    for (const spec of relativeImports(source)) {
      const target = resolveSpec(f, spec, known);
      if (target) edges.add(target);
    }
    for (const read of runtimeReads(source)) {
      edges.add(resolveRuntimeRead(f, read.up, read.segments));
    }
    deps.set(f, edges);
    if (TEST_FILE.test(f) && SWEEP.test(source)) sweeps.push(f);
  }

  const target = new Set(wanted);
  const memo = new Map<string, boolean>();

  const reaches = (file: string, seen: Set<string>): boolean => {
    if (target.has(file)) return true;
    const cached = memo.get(file);
    if (cached !== undefined) return cached;
    if (seen.has(file)) return false; // a cycle contributes nothing
    seen.add(file);
    let hit = false;
    for (const d of deps.get(file) ?? []) {
      if (reaches(d, seen)) {
        hit = true;
        break;
      }
    }
    seen.delete(file);
    memo.set(file, hit);
    return hit;
  };

  const sweepSet = new Set(sweeps);
  const tests = testFiles
    .filter(t => sweepSet.has(t) || reaches(t, new Set()))
    .sort();

  return {
    reading: "MEASURED",
    tests,
    unmeasuredReasons: [],
    testFilesSeen: testFiles.length,
    selected: tests.length,
    sweeps: sweeps.sort(),
  };
}
