/**
 * The spec-to-test generator reads this repo's specs (#141)
 *
 * SC-544..SC-547 (CONFIG-DRIVEN-TESTING-SPEC.md)
 *
 * `scripts/sync-spec-tests.ts` computed its own harness root:
 *
 *     const HARNESS_ROOT = process.env.HARNESS_ROOT || join(HOME, ".claude");
 *     const SPECS_DIR    = resolve(HARNESS_ROOT, "PAI/Specs");
 *     const OUTPUT_PATH  = resolve(HARNESS_ROOT, "test/spec-compliance-auto.test.ts");
 *
 * Nothing exports `HARNESS_ROOT` — not a profile, not CI, not a hook, not a
 * skill; it is only ever a workflow argument. So the default applied, and the
 * generator read `~/.claude/PAI/Specs` and wrote `~/.claude/test/`, while
 * `lib/paths.ts` `harnessRoot()` resolved to this checkout. Both directories
 * exist, so it read a real spec tree and wrote a real test file — just not
 * this repo's, on every gate, reporting success each time.
 *
 * `specs/` holds 30 spec files and not one had ever been read. The project's
 * own rule is "SCs without tests are wishes"; the mechanism meant to enforce
 * it was pointed somewhere else.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveSyncPaths, syncRoot } from "../scripts/sync-spec-tests";

const REPO_ROOT = join(import.meta.dir, "..");

describe("#141: the generator resolves to the repo it lives in", () => {
  test("the spec directory is specs/, not PAI/Specs", () => {
    // The second half of the bug, and independent of the root: even pointed
    // at the right root it would have looked in a directory this repo does
    // not have.
    const { specsDir } = resolveSyncPaths("/some/root");
    expect(specsDir).toBe("/some/root/specs");
  });

  test("the output is the file the suite actually runs", () => {
    const { outputPath } = resolveSyncPaths("/some/root");
    expect(outputPath).toBe("/some/root/test/spec-compliance-auto.test.ts");
  });

  test("ship and prove resolve under the same root", () => {
    const p = resolveSyncPaths("/some/root");
    expect(p.shipPath).toBe("/some/root/workflows/ship.js");
    expect(p.provePath).toBe("/some/root/workflows/prove.js");
  });

  test("with HARNESS_ROOT unset the root is this checkout, not ~/.claude", () => {
    const saved = process.env.HARNESS_ROOT;
    delete process.env.HARNESS_ROOT;
    try {
      // This is the assertion the old default failed. It passed `~/.claude`
      // every time, and `~/.claude/PAI/Specs` exists, so nothing complained.
      expect(syncRoot([])).toBe(REPO_ROOT);
      expect(resolveSyncPaths(syncRoot([])).specsDir).toBe(join(REPO_ROOT, "specs"));
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ROOT;
      else process.env.HARNESS_ROOT = saved;
    }
  });

  test("argv[2] is the root, so a caller can state the tree it means", () => {
    expect(syncRoot(["bun", "sync-spec-tests.ts", "/some/other/tree"])).toBe("/some/other/tree");
  });

  test("HARNESS_ROOT does NOT redirect the write", () => {
    // The whole of AC-3. `gates/gate-executor.ts` runs this script on every
    // scope gate, and the ship workflow sets HARNESS_ROOT for reasons that
    // have nothing to do with where generated tests belong. A writer aimed by
    // an env var regenerates one checkout's test file and leaves another's
    // stale, silently, because both are real files.
    const saved = process.env.HARNESS_ROOT;
    process.env.HARNESS_ROOT = "/nonexistent/env/override";
    try {
      expect(syncRoot([])).toBe(REPO_ROOT);
    } finally {
      if (saved === undefined) delete process.env.HARNESS_ROOT;
      else process.env.HARNESS_ROOT = saved;
    }
  });

  test("the positive control: an empty root is refused, not resolved", () => {
    // `harnessRootFor` is what makes the two cases above answers rather than
    // guesses. Hand it nothing and it throws; a plain `resolve()` in its place
    // would hand back the cwd and the write would land somewhere nobody named.
    expect(() => syncRoot(["bun", "sync-spec-tests.ts", "   "])).toThrow(/empty root/);
  });

  test("the directories it resolves to are real", () => {
    // Guards against the whole suite above agreeing on a path that does not
    // exist — the failure the old code could not see was precisely that both
    // candidates existed.
    const p = resolveSyncPaths(REPO_ROOT);
    expect(existsSync(p.specsDir)).toBe(true);
    expect(existsSync(p.shipPath)).toBe(true);
    expect(existsSync(p.provePath)).toBe(true);
  });
});

/**
 * Every assertion in a generated file is one a human never read before it
 * joined the suite total, so the generator's output shape is the only place
 * the quality bar can live.
 *
 * `wholeFileContainsIn` is that bar, and it is why the twelve cases this file
 * used to demand are gone (#343). They were all
 * `expect(SHIP_JS.toLowerCase()).toContain("gate")` against a file containing
 * "gate" 196 times — assertions that were true before the spec sentence
 * existed and would stay true if the behaviour were deleted.
 */
function wholeFileContainsIn(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /expect\(\s*([A-Z_][A-Z0-9_]*)(?:\.toLowerCase\(\))?\s*\)\s*\.toContain\(\s*(["'`])(.*?)\2/g,
  )) {
    // Only the whole-file bindings. A `toContain` against a value the test
    // computed is an ordinary assertion.
    if (!/_JS$/.test(m[1])) continue;
    out.push(`${m[1]} contains ${JSON.stringify(m[3])}`);
  }
  return out;
}

describe("#141/#343: the generated file is runnable where it lands", () => {
  const generated = readFileSync(join(REPO_ROOT, "test", "spec-compliance-auto.test.ts"), "utf-8");
  const cases = generated.match(/^\s*test\(/gm)?.length ?? 0;

  test("it says where it came from", () => {
    expect(generated).toContain("AUTO-GENERATED by scripts/sync-spec-tests.ts");
  });

  test("no case is a bare substring search of a whole workflow file", () => {
    // SC-753. The defect class this repo keeps finding: an assertion that
    // passes because of what it never looked at. Searching a 4,000-line file
    // for "ship" is not a measurement of anything a spec sentence said.
    //
    // Structural, not a threshold — rebuilding claim extraction means
    // answering "what IS the checkable content of this sentence?", and
    // whole-file presence is the answer that dodges the question.
    expect(
      wholeFileContainsIn(generated),
      `scripts/sync-spec-tests.ts emitted whole-file substring checks again. ` +
        `Assert something the spec sentence actually constrains — a call site, ` +
        `an ordering, a value — not that a long file mentions a common word.`,
    ).toEqual([]);
  });

  test("the whole-file detector fires on the output it was written against", () => {
    // Without this the case above is green on an empty file for the same
    // reason the deleted cases were green on a full one.
    expect(
      wholeFileContainsIn(
        `test("AUTO-GATE-1: x", () => { expect(SHIP_JS.toLowerCase()).toContain("gate"); });\n` +
          `test("AUTO-QUINN-7: y", () => { expect(PROVE_JS.toLowerCase()).toContain("quinn"); });`,
      ),
    ).toEqual([`SHIP_JS contains "gate"`, `PROVE_JS contains "quinn"`]);
    // ...and does not fire on an assertion against a computed value.
    expect(wholeFileContainsIn(`expect(names.toLowerCase()).toContain("gate")`)).toEqual([]);
  });

  test("a file with no cases explains why, and one with cases reads its own tree", () => {
    if (cases === 0) {
      // Emptiness is the current, deliberate state. It has to be legible as
      // that rather than as a generator that silently stopped working, which
      // is the same observable.
      expect(generated).toContain("No generated claims");
      expect(generated).toContain("extractClaims returns nothing on purpose");
      return;
    }
    // The generator used to interpolate absolute paths from whoever last ran
    // it, which makes the committed file unrunnable anywhere else, CI
    // included. It then used `harnessRoot()`, which honours HARNESS_ROOT — so
    // a run with that set graded a different checkout's ship.js than the one
    // the file was generated from (#190).
    expect(generated).toContain('import { harnessRootFor } from "../lib/paths"');
    expect(generated).toContain('harnessRootFor(join(import.meta.dir, ".."))');
    expect(generated).not.toMatch(/\bharnessRoot\(\)/);
    expect(generated).not.toMatch(/readFileSync\("\/Users\//);
    expect(generated).not.toMatch(/readFileSync\("\/home\//);
  });
});

describe("#141: importing the generator does not run it", () => {
  test("a module import leaves the generated file untouched", () => {
    // SC-545. Grepping for `import.meta.main` cannot tell whether the guard
    // is wired to anything — `if (true) main()` keeps the string and still
    // rewrites a tracked file on every import, including this test's own.
    // So: plant a sentinel, import in a subprocess, and check it survived.
    const target = join(REPO_ROOT, "test", "spec-compliance-auto.test.ts");
    const original = readFileSync(target, "utf-8");
    const sentinel = `${original}// sentinel: removed if the generator ran on import\n`;

    writeFileSync(target, sentinel);
    try {
      // late-env-ok: this child only observes whether importing the module
      // WRITES, and the sentinel survives or does not whatever HARNESS_ROOT
      // says; the root only selects where a write would land, and the claim
      // is that no write happens at all. The sibling case below, which does
      // depend on the root, passes env explicitly.
      const proc = Bun.spawnSync(
        ["bun", "-e", 'await import("./scripts/sync-spec-tests.ts")'],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).toBe(0);
      expect(readFileSync(target, "utf-8")).toBe(sentinel);
    } finally {
      writeFileSync(target, original);
    }
  });

  test("running it as a script writes THIS repo's test file", () => {
    // The assertions above all call `resolveSyncPaths(root)` with a root
    // handed to them, so they say nothing about the root the script picks for
    // itself — which is the whole of #141. Replacing `harnessRoot()` with
    // `~/.claude` leaves every one of them green.
    //
    // So run it the way a gate runs it, with HARNESS_ROOT unset, and check
    // that the file it rewrote is this one. Under the old default it wrote
    // `~/.claude/test/` and the sentinel here survived untouched.
    const target = join(REPO_ROOT, "test", "spec-compliance-auto.test.ts");
    const original = readFileSync(target, "utf-8");
    const sentinel = `${original}// sentinel: survives only if the generator wrote somewhere else\n`;

    writeFileSync(target, sentinel);
    try {
      const env = { ...process.env };
      delete env.HARNESS_ROOT;
      const proc = Bun.spawnSync(["bun", "scripts/sync-spec-tests.ts"], {
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      const after = readFileSync(target, "utf-8");
      expect(after).not.toContain("// sentinel:");
      expect(after).toContain("AUTO-GENERATED by scripts/sync-spec-tests.ts");
    } finally {
      writeFileSync(target, original);
    }
  });
});
