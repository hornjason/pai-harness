/**
 * Covers SC-813, SC-814, SC-815 (SCAFFOLD-DECOMPOSITION-SPEC.md).
 *
 * #362 — every scaffolded project got
 * `"rungate": "file:../../some/path/on/one/laptop"`, pinned into its
 * `bun.lock`. On CI, or on any second machine, that path does not exist and
 * `bun install` exits 1. A consumer could not install its dependencies on a
 * clean clone: a failure at step zero, before any gate or tier question, and
 * the cause of DailyBriefDashboard's CI failing on every run from
 * 2026-10-03.
 *
 * The issue named the decorative version of this test by name:
 *
 *   > Scaffold a fixture project into a temp dir with no sibling harness
 *   > directory reachable, then run `bun install --frozen-lockfile` and
 *   > assert exit 0. Mutating `addPaiHarnessDevDep` back to emitting `file:`
 *   > must turn it red — if it stays green the fixture is resolving the
 *   > harness by some other path and the test is decorative.
 *
 * So the install case RUNS `bun install`, in `os.tmpdir()`, which has no
 * ancestor in common with this checkout — a relative `file:` path from there
 * cannot reach the harness by any route.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addPaiHarnessDevDep, harnessDevDepRange } from "../lib/scaffold/steps";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-consumer-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return dir;
}

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe("#362 SC-813: the scaffold writes a version range, never a path", () => {
  test("a scaffolded project depends on a published range", () => {
    const dir = project({ name: "consumer", version: "1.0.0" });
    addPaiHarnessDevDep(dir, []);
    const dep = readPkg(dir).devDependencies.rungate;
    expect(dep).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(dep, "a file: dependency cannot resolve on a second machine").not.toContain("file:");
  });

  test("no scaffolded dependency of any kind is a path", () => {
    // Narrower than it looks: `file:` is the only form that encodes one
    // machine's layout, and asserting on the one key would miss a future
    // step adding another.
    const dir = project({ name: "consumer", version: "1.0.0" });
    addPaiHarnessDevDep(dir, []);
    const deps = Object.entries(readPkg(dir).devDependencies ?? {});
    for (const [k, v] of deps) {
      expect(String(v), `${k} is pinned to a path`).not.toMatch(/^(?:file:|link:|\.{0,2}\/)/);
    }
  });

  test("the floor is the harness's minor, not its exact patch", () => {
    // An exact-patch caret cannot resolve until that version is published,
    // and this repo runs ahead of npm — the same defect in a new costume.
    expect(harnessDevDepRange("0.2.2")).toBe("^0.2.0");
    expect(harnessDevDepRange("1.4.7")).toBe("^1.4.0");
  });

  test("an unreadable version still yields a range, not a path", () => {
    // The fallback is the branch a mutation is likeliest to reach, and the
    // wrong answers here are `*` (any major) and `file:` (the bug).
    const r = harnessDevDepRange("not-a-version");
    expect(r).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(r).not.toBe("*");
  });
});

describe("#362 SC-814: the dependency resolves where no harness is reachable", () => {
  test("bun install succeeds in a temp dir with no sibling harness", () => {
    // The case the issue asked for. tmpdir() shares no ancestor with this
    // checkout, so a relative file: path from here cannot reach the harness
    // by any route — which is what makes the mutation able to turn it red.
    const dir = project({ name: "consumer", version: "1.0.0", private: true });
    addPaiHarnessDevDep(dir, []);

    const r = spawnSync("bun", ["install"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 180_000,
      env: { ...process.env, npm_config_registry: undefined } as NodeJS.ProcessEnv,
    });

    expect(
      r.status,
      `bun install failed in a project scaffolded by this harness:\n${r.stdout}\n${r.stderr}`,
    ).toBe(0);
  }, 200_000);

  test("and the lockfile it pins is resolvable again from scratch", () => {
    // --frozen-lockfile is the CI invocation, and it is the one that fails
    // over a pinned file: entry even with --no-optional. Running it as a
    // SECOND install over the lock the first one wrote is what reproduces
    // CI's conditions rather than approximating them.
    const dir = project({ name: "consumer", version: "1.0.0", private: true });
    addPaiHarnessDevDep(dir, []);
    const first = spawnSync("bun", ["install"], { cwd: dir, encoding: "utf-8", timeout: 180_000 });
    expect(first.status, first.stderr).toBe(0);

    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    const frozen = spawnSync("bun", ["install", "--frozen-lockfile"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 180_000,
    });
    expect(
      frozen.status,
      `--frozen-lockfile failed, which is exactly how DDB's CI failed:\n${frozen.stderr}`,
    ).toBe(0);
  }, 400_000);
});

describe("#362 SC-815: the existing skips still hold", () => {
  test("the harness does not add itself as its own dependency", () => {
    const dir = project({ name: "rungate", version: "0.2.2" });
    addPaiHarnessDevDep(dir, []);
    expect(readPkg(dir).devDependencies?.rungate).toBeUndefined();
  });

  test("an existing pin is left alone", () => {
    // Including a `file:` one. A consumer who deliberately points at a local
    // checkout is not this bug, and silently rewriting their package.json is
    // not this fix's business.
    const dir = project({
      name: "consumer",
      version: "1.0.0",
      devDependencies: { rungate: "file:../rungate" },
    });
    addPaiHarnessDevDep(dir, []);
    expect(readPkg(dir).devDependencies.rungate).toBe("file:../rungate");
  });

  test("a project with no package.json is not given one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rungate-nopkg-"));
    scratch.push(dir);
    const actions: string[] = [];
    expect(() => addPaiHarnessDevDep(dir, actions)).not.toThrow();
    expect(actions).toEqual([]);
  });

  test("this repo's own package.json is untouched by running the suite", () => {
    // A guard on the test file rather than on the code. Every case above
    // operates on a temp dir; one that forgot would rewrite the harness's
    // own manifest, and the first symptom would be a mysterious diff.
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).name).toBe("rungate");
    expect(
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).devDependencies?.rungate,
    ).toBeUndefined();
  });
});
