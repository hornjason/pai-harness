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
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, resolve } from "path";

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
