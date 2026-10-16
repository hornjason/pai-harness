/**
 * Covers SC-1604..SC-1611 (HARNESS-STANDARD.md), #437.
 *
 * Jason found 34 hidden directories in the repo root:
 *
 *   .tree-under-test-scratch-<6 chars>   × 23
 *   .tmp-sc-drift-test-<6 chars>         × …
 *
 * All but one were 0 bytes. They are gitignored, so nothing was ever at risk
 * of being committed — this is litter, not corruption.
 *
 * Five suites built them with `mkdtempSync(join(REPO_ROOT, "<prefix>"))` at
 * MODULE SCOPE. Every one of them also had correct `afterAll` cleanup, and
 * that is the whole point: the directory appears when bun imports the file,
 * which is before any lifecycle hook can run and before any hook is
 * guaranteed to run at all. 0 bytes is the fingerprint — created at import,
 * never populated, never cleaned. This repo kills suites often (the DIR-L29
 * guard, Ctrl-C, one jetsam kill), so the leak rate is not theoretical.
 *
 * The directories are deliberately inside the repo root rather than /tmp —
 * `tree-under-test` scans the repo tree and `sc-drift` needs repo-relative
 * paths — so relocating them is not available as a fix.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cleanupScratchDirs, scratchPrefixes, isScratchEntry } from "../lib/scratch-cleanup";
import { uniqueScratchPrefixes, fixedScratchRoots, repoRootIdents } from "../lib/scratch-roots";
import { stripJsComments } from "../lib/strip-js-comments";

const REAL_ROOT = join(import.meta.dir, "..");
let root: string;

/** A fake repo whose test/ plants exactly the prefixes given. */
function plantSuites(prefixes: string[]): void {
  mkdirSync(join(root, "test"), { recursive: true });
  prefixes.forEach((p, i) => {
    writeFileSync(
      join(root, "test", `fixture-${i}.test.ts`),
      `const REPO_ROOT = join(import.meta.dir, "..");\n` +
        `const SCRATCH = mkdtempSync(join(REPO_ROOT, "${p}"));\n`,
    );
  });
}

/** A directory in the repo root, aged so the sweeper will consider it. */
function plantDir(name: string, ageMs = 2 * 60 * 60 * 1000): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rg-437-")); });
afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

describe("SC-1604: the prefix list is derived from the suites, never listed", () => {
  test("a prefix a suite plants is found, and one nobody plants is not", () => {
    plantSuites([".tree-under-test-scratch-", ".tmp-sc-drift-test-"]);
    const found = scratchPrefixes(root);
    expect(found).toEqual([".tmp-sc-drift-test-", ".tree-under-test-scratch-"]);
    expect(found).not.toContain(".gate-vacuous-test-");
  });

  test("SC-1605: the real tree's prefixes are all found, and the fixture file's are not", () => {
    // The live check. A derived list has one failure mode a hand-written list
    // does not: it can silently come back empty, and an empty deletion
    // allowlist sweeps nothing, which looks exactly like nothing having
    // leaked.
    const real = scratchPrefixes(REAL_ROOT);
    expect(real.length, "no prefix was derived from the real tree — the sweeper has no subject")
      .toBeGreaterThanOrEqual(5);
    for (const p of [
      ".tree-under-test-scratch-", ".tmp-sc-drift-test-", ".gate-vacuous-test-",
      ".spec-collection-scratch-", ".scaffold-make-targets-",
    ]) {
      expect(real, `${p} is planted by a live suite but is not in the sweep list`).toContain(p);
    }

    // `.x-` is a STRING LITERAL inside scratch-paths-unique.test.ts, where it
    // exists to prove that file's detector still fires. Deriving from it would
    // put a test fixture into a deletion allowlist — the self-reference trap
    // with a recursive delete on the end. That file is excluded, and this is
    // the assertion that the exclusion is doing something.
    expect(real, "a fixture literal reached the deletion allowlist").not.toContain(".x-");
    expect(uniqueScratchPrefixes(
      readFileSync(join(REAL_ROOT, "test", "scratch-paths-unique.test.ts"), "utf-8"),
    ), "the fixture file does declare .x-, so the exclusion is load-bearing").toContain(".x-");
  });

  test("SC-1606: the two readings of a scratch root come from one parse", () => {
    // SC-5. `fixedScratchRoots` (is this path shared?) and
    // `uniqueScratchPrefixes` (what may be swept?) are the same parse asked
    // two ways, and they are exported from one module so there is one thing
    // to mutate. Asserted behaviourally rather than by grepping imports: the
    // same source must be classified by exactly one of them.
    const src =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `const FIXED = join(ROOT, ".shared-scratch");\nmkdirSync(FIXED);\n` +
      `const UNIQ = mkdtempSync(join(ROOT, ".unique-scratch-"));\n`;
    expect(fixedScratchRoots(src)).toEqual(["FIXED = .shared-scratch"]);
    expect(uniqueScratchPrefixes(src)).toEqual([".unique-scratch-"]);
  });

  test("SC-1606: the assignment form is seen, not just the const form", () => {
    // #437's own fix writes `let SCRATCH = ""` at the top and
    // `SCRATCH = mkdtempSync(...)` inside beforeAll. A const-only pattern
    // would stop seeing both readings at once — so the fix for the leak would
    // have opened a hole in the guard against fixed paths, and the hole would
    // be invisible because both functions would simply return nothing.
    const assigned =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `let SCRATCH = "";\nbeforeAll(() => { SCRATCH = mkdtempSync(join(ROOT, ".late-")); });\n`;
    expect(uniqueScratchPrefixes(assigned)).toEqual([".late-"]);

    const assignedFixed =
      `const ROOT = join(import.meta.dir, "..");\n` +
      `let SCRATCH = "";\nbeforeAll(() => { SCRATCH = join(ROOT, ".late-fixed"); mkdirSync(SCRATCH); });\n`;
    expect(fixedScratchRoots(assignedFixed)).toEqual(["SCRATCH = .late-fixed"]);
  });
});

describe("SC-1607: the sweeper removes the leak and nothing else", () => {
  test("a leaked directory goes and an unrelated one stays", () => {
    plantSuites([".tree-under-test-scratch-"]);
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const innocent = plantDir("src");
    const dotted = plantDir(".github");

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(existsSync(leaked), "the leak survived the sweep").toBe(false);
    expect(result.removed).toContain(".tree-under-test-scratch-ab12cd");
    expect(existsSync(innocent)).toBe(true);
    expect(existsSync(dotted)).toBe(true);
    expect(result.refused).toContain("src");
    expect(result.refused).toContain(".github");
  });

  test("SC-1608: a prefix is a deletion allowlist and is refused as one", () => {
    // SC-3. Every near miss, each of which a looser predicate would take.
    plantSuites([".tree-under-test-scratch-"]);
    const nearMisses = [
      // EXACTLY the prefix, nothing appended. `mkdtempSync` cannot produce
      // this, so someone made it deliberately. Predicted 2 red for dropping
      // the suffix requirement and measured 1 — this case was missing, and
      // the branch was guarded only by the unit test below. A behavioural
      // list that omits the case the predicate exists for is the third shape
      // in `.claude/rules/checks-must-be-able-to-fail.md`.
      ".tree-under-test-scratch-",
      ".tree-under-test-scratch",        // the prefix minus its separator
      ".tree-under-test",                // a shorter name the prefix starts with
      "tree-under-test-scratch-ab12cd",  // no leading dot
      // Contains the prefix but does not START with it — the difference
      // between `startsWith` and `includes`, which was also unguarded
      // behaviourally.
      "x.tree-under-test-scratch-ab12",
      ".tree_under_test_scratch-ab12",   // underscores, not the planted name
      ".Tree-under-test-scratch-ab12",   // case
    ];
    const paths = nearMisses.map(n => plantDir(n));

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(result.removed, `the sweeper took a path it did not build: ${result.removed.join(", ")}`)
      .toEqual([]);
    for (const p of paths) expect(existsSync(p), `${p} was deleted`).toBe(true);
  });

  test("SC-1608: with no prefixes derived, the sweeper deletes nothing at all", () => {
    // The fail-safe direction. An empty allowlist must mean "sweep nothing",
    // never "sweep anything" — and an empty `prefixes.some(...)` is false,
    // which is the right answer for the right reason, asserted rather than
    // assumed.
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const result = cleanupScratchDirs({ repoRoot: root }); // no test/ planted

    expect(scratchPrefixes(root)).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(existsSync(leaked)).toBe(true);
  });

  test("SC-1609: a scratch directory young enough to be in use is kept", () => {
    // This runs at SessionStart while another session may be three minutes
    // into a suite. The directory is anonymous and holds no lock, so the
    // suite that created it cannot defend it — age is the only signal there
    // is, and the direction to be wrong in is leaving litter.
    plantSuites([".tree-under-test-scratch-"]);
    const fresh = plantDir(".tree-under-test-scratch-fresh1", 30 * 1000);
    const old = plantDir(".tree-under-test-scratch-old111", 2 * 60 * 60 * 1000);

    const result = cleanupScratchDirs({ repoRoot: root });

    expect(existsSync(fresh), "a scratch directory 30s old was swept out from under a live suite").toBe(true);
    expect(result.kept.join("\n")).toContain(".tree-under-test-scratch-fresh1");
    expect(existsSync(old)).toBe(false);
  });

  test("SC-1609: a file matching a prefix is refused — only directories are swept", () => {
    plantSuites([".tree-under-test-scratch-"]);
    writeFileSync(join(root, ".tree-under-test-scratch-notes"), "not a directory\n");
    const result = cleanupScratchDirs({ repoRoot: root });
    expect(result.refused).toContain(".tree-under-test-scratch-notes");
    expect(existsSync(join(root, ".tree-under-test-scratch-notes"))).toBe(true);
  });

  test("SC-1609: a dry run reports what would go and removes nothing", () => {
    plantSuites([".tree-under-test-scratch-"]);
    const leaked = plantDir(".tree-under-test-scratch-ab12cd");
    const result = cleanupScratchDirs({ repoRoot: root, dryRun: true });
    expect(result.removed.join("\n")).toContain(".tree-under-test-scratch-ab12cd");
    expect(existsSync(leaked), "a dry run deleted something").toBe(true);
  });

  test("the predicate is callable alone, so the allowlist is testable alone", () => {
    expect(isScratchEntry(".a-b12", [".a-"])).toBe(true);
    expect(isScratchEntry(".a-", [".a-"])).toBe(false);   // bare prefix, no suffix
    expect(isScratchEntry(".a-b12", [])).toBe(false);     // empty allowlist
    expect(isScratchEntry("x.a-b12", [".a-"])).toBe(false); // must be a prefix, not a substring
  });
});

describe("SC-1611: the sweep runs where worktree cleanup already runs", () => {
  test("the SessionStart hook calls both, so the two leaks are reported together", () => {
    // SC-4. 34 scratch directories and 39 stale worktrees (#68) were both
    // found by eye, months apart. A cleaner nobody invokes is a function, not
    // a cleaner — so the assertion is on the call site, in the one hook that
    // already sweeps the other leak of the same family.
    const hook = readFileSync(join(REAL_ROOT, "hooks", "StaleTTLCleanup.hook.ts"), "utf-8");
    expect(hook, "worktree cleanup moved — this test is pointing at the wrong hook")
      .toContain("cleanupWorktrees(");
    expect(hook, "the scratch sweep is not wired into SessionStart").toContain("cleanupScratchDirs(");
    // Counted into the same total the hook prints, not logged and forgotten.
    expect(/deletedCount \+= sr\.removed\.length/.test(hook)).toBe(true);
  });

  test("the hook stays a thin trigger — SC-371's 150-line budget", () => {
    const lines = readFileSync(join(REAL_ROOT, "hooks", "StaleTTLCleanup.hook.ts"), "utf-8").split("\n").length;
    expect(lines, `the hook is ${lines} lines; logic belongs in lib/`).toBeLessThanOrEqual(150);
  });
});

describe("SC-1610: no suite in test/ creates a filesystem path at module scope", () => {
  /**
   * The source-position half. `mkdtempSync` / `mkdirSync` / `writeFileSync`
   * outside any function body runs at import, which is where the leak comes
   * from. Inside a lifecycle hook or a helper it does not.
   */
  function moduleScopeCreations(src: string): string[] {
    // Comments are stripped FIRST. The first cut did not, and reported this
    // file's own docblock — the sentence describing the defect reads as the
    // defect. That is the self-reference trap, and it is the fourth time this
    // repo has hit it.
    const stripped = stripJsComments(src);
    const roots = repoRootIdents(stripped);
    const out: string[] = [];
    let depth = 0;
    for (const line of stripped.split("\n")) {
      const creates = /\b(mkdtempSync|mkdirSync|writeFileSync|cpSync)\s*\(/.test(line);
      // Scoped to paths rooted at the SHARED CHECKOUT. A module-scope
      // `mkdtempSync(join(tmpdir(), ...))` leaks too, but it leaks into a
      // directory the OS reaps, and #437 is about the repo root filling up.
      const atRepoRoot = [...roots].some(r => new RegExp(`\\b${r}\\b`).test(line));
      // An arrow body opened and closed on the same line is a hook, not
      // module scope — `beforeAll(() => { SCRATCH = mkdtempSync(...); });`
      if (depth === 0 && creates && atRepoRoot && !/=>/.test(line)) out.push(line.trim());
      for (const ch of line) {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
      }
      if (depth < 0) depth = 0;
    }
    return out;
  }

  test("every suite creates its scratch inside a hook, not at import", () => {
    const violations: string[] = [];
    for (const f of readdirSync(join(REAL_ROOT, "test")).filter(f => f.endsWith(".ts"))) {
      for (const hit of moduleScopeCreations(readFileSync(join(REAL_ROOT, "test", f), "utf-8"))) {
        violations.push(`test/${f} — ${hit}`);
      }
    }
    expect(
      violations,
      `these run at import, before any afterAll can be registered (#437):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  test("the detector sees the form #437 removed and not the form it installed", () => {
    // Without this the test above is satisfied by a detector that stopped
    // matching, which is how a guard goes quiet and gets trusted more for it.
    const before = `const ROOT = join(import.meta.dir, "..");\nconst S = mkdtempSync(join(ROOT, ".x-"));\n`;
    const after = `let S = "";\nbeforeAll(() => { S = mkdtempSync(join(ROOT, ".x-")); });\n`;
    expect(moduleScopeCreations(before)).toHaveLength(1);
    expect(moduleScopeCreations(after)).toEqual([]);
  });

  test("SC-1610: importing the five repaired suites creates nothing", async () => {
    // The executed half, and the one a source-position assertion cannot
    // stand in for. The modules are imported for real in a subprocess, and
    // the repo root is listed either side. A file could create a directory
    // through a helper this detector does not read; nothing reaches past an
    // actual import.
    const SUITES = [
      "test/tree-under-test.test.ts",
      "test/sc-drift.test.ts",
      "test/gate-vacuous-checks.test.ts",
      "test/spec-collection-recursive.test.ts",
      "test/scaffold-make-targets.test.ts",
    ];
    const before = new Set(readdirSync(REAL_ROOT));

    // `bun test <files> -t <pattern matching nothing>` loads every file and
    // registers its hooks, then runs none of them. That is precisely "import
    // without executing", which is the state the leak came from.
    const proc = Bun.spawnSync({
      cmd: ["bun", "test", ...SUITES, "-t", "zz-no-test-has-this-name-zz"],
      cwd: REAL_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();

    // The files must be OBSERVED loading. A run that failed to resolve an
    // import creates nothing either, and would pass this test for the one
    // reason that makes it worthless. bun names the count it skipped, and a
    // skipped test is a registered test, which is a loaded module.
    const skipped = /skipping (\d+) tests?/.exec(out);
    expect(skipped, `the suites were never loaded:\n${out.slice(0, 500)}`).not.toBeNull();
    expect(Number(skipped?.[1] ?? 0)).toBeGreaterThanOrEqual(SUITES.length);

    const appeared = readdirSync(REAL_ROOT).filter(e => !before.has(e));
    expect(
      appeared,
      `importing these suites created ${appeared.join(", ")} in the repo root`,
    ).toEqual([]);
  });
});
