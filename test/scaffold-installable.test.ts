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
import { NPM_REGISTRY, registryState, satisfiesCaret } from "../lib/release-preflight";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];

const treeVersion = (): string =>
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

/**
 * A version that is actually on the registry, for the cases that really
 * install (#364).
 *
 * Pinning these to the TREE's version made every minor bump un-releasable.
 * The range is floored at the harness's own minor, so a tree carrying an
 * unpublished `0.3.0` emits `^0.3.0`, which resolves to nothing until the
 * publish — and `.github/workflows/release.yml` runs this suite BEFORE
 * publishing, with no bypass by design. The check could not pass until the
 * step it gates had already run. Measured: `0.2.2` emits `^0.2.0` and
 * resolves, `0.3.0` emits `^0.3.0` and does not.
 *
 * What these cases are actually for is the `file:` regression, and that is
 * independent of which version string the range was built from. So they are
 * driven over a published one. Whether the TREE's range will resolve once
 * shipped is a pure question, asked separately below without a network.
 *
 * An unreachable registry THROWS rather than falling back to a default. A
 * default would let these install something unrelated to the scaffold's
 * output and still report green — the fail-open shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
let publishedCache: string | null = null;
async function publishedVersion(): Promise<string> {
  if (publishedCache) return publishedCache;
  const state = await registryState("rungate", fetch, NPM_REGISTRY);
  const v = state.latest ?? state.versions[0];
  if (!v) {
    throw new Error(
      "rungate has never been published, so no range can be resolved — these " +
        "cases cannot measure resolvability and must not report green",
    );
  }
  publishedCache = v;
  return v;
}

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
  test("bun install succeeds in a temp dir with no sibling harness", async () => {
    // The case the issue asked for. tmpdir() shares no ancestor with this
    // checkout, so a relative file: path from here cannot reach the harness
    // by any route — which is what makes the mutation able to turn it red.
    const dir = project({ name: "consumer", version: "1.0.0", private: true });
    addPaiHarnessDevDep(dir, [], await publishedVersion());

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

  test("and the lockfile it pins is resolvable again from scratch", async () => {
    // --frozen-lockfile is the CI invocation, and it is the one that fails
    // over a pinned file: entry even with --no-optional. Running it as a
    // SECOND install over the lock the first one wrote is what reproduces
    // CI's conditions rather than approximating them.
    const dir = project({ name: "consumer", version: "1.0.0", private: true });
    addPaiHarnessDevDep(dir, [], await publishedVersion());
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

  test("the version actually installed is the one the range asked for", async () => {
    // The positive control the two cases above need once they stopped using
    // the tree's version. Without it, a range that silently resolved to
    // something unrelated — or an install that wrote nothing — satisfies
    // both, and they would be measuring that `bun install` exits 0 rather
    // than that the scaffold's output is resolvable.
    const published = await publishedVersion();
    const dir = project({ name: "consumer", version: "1.0.0", private: true });
    addPaiHarnessDevDep(dir, [], published);
    expect(readPkg(dir).devDependencies.rungate).toBe(harnessDevDepRange(published));

    const r = spawnSync("bun", ["install"], { cwd: dir, encoding: "utf-8", timeout: 180_000 });
    expect(r.status, r.stderr).toBe(0);
    const installed = JSON.parse(
      readFileSync(join(dir, "node_modules", "rungate", "package.json"), "utf-8"),
    ).version;
    expect(satisfiesCaret(installed, harnessDevDepRange(published))).toBe(true);
  }, 200_000);
});

describe("#364: this tree's own range will resolve once it is published", () => {
  /**
   * The half that cannot be asked of the registry before a release, and the
   * reason the two cases above no longer use the tree's version.
   *
   * `release.yml` runs this suite BEFORE `npm publish`, with no
   * `continue-on-error` and no conditional — deliberately, and
   * `test/release-guard.test.ts` asserts both. So any check requiring the
   * tree's version to already be on npm is a check that cannot pass on the
   * run that would make it pass. Every minor and major bump was
   * un-releasable: `0.3.0` emits `^0.3.0`, npm's newest was `0.2.1`, and the
   * suite failed before the publish step it was gating.
   *
   * The property that actually matters is provable without a network: a
   * caret floored at a version's own minor is satisfied by that version.
   * Asserted over the real `package.json` so it tracks the tree rather than
   * a fixture.
   */
  test("the range the scaffold emits is satisfied by the version that emits it", () => {
    const v = treeVersion();
    expect(satisfiesCaret(v, harnessDevDepRange(v))).toBe(true);
  });

  test("it holds across a major, a minor and a patch bump", () => {
    for (const v of ["0.2.1", "0.2.2", "0.3.0", "1.0.0", "2.7.13"]) {
      expect(satisfiesCaret(v, harnessDevDepRange(v)), `${v} cannot install itself`).toBe(true);
    }
  });

  test("the check can fail — a floor above the version is refused", () => {
    // Proven able to fail on every run. A range floored at the next minor
    // is exactly the un-releasable shape, and without this case the two
    // above pass just as well if satisfiesCaret always returned true.
    expect(satisfiesCaret("0.3.0", "^0.4.0")).toBe(false);
    expect(satisfiesCaret("0.3.0", "^1.0.0")).toBe(false);
    expect(satisfiesCaret("1.0.0", "^0.3.0")).toBe(false);
  });

  test("below 1.0.0 a caret is pinned to the MINOR, not the major", () => {
    /**
     * Measured, and the reason this case exists rather than the comment
     * that used to stand in for it: replacing the three upper-bound lines
     * with `return vMaj === rMaj` — the classic 0.x caret error, and the
     * one the function's own docblock calls the whole point — scored ZERO
     * red across 48 tests. Every case above compares versions that differ
     * in the MAJOR or fall below the floor, and the lower-bound check
     * answers all of those before the 0.x branch is ever reached.
     *
     * The two readings only diverge for a version at or above the floor
     * whose minor has moved, with a major of zero. That is this pair, and
     * nothing else in the file produces it.
     */
    expect(satisfiesCaret("0.4.0", "^0.3.0"), "^0.3.0 must not admit 0.4.0").toBe(false);
    expect(satisfiesCaret("0.3.9", "^0.3.0")).toBe(true);

    // The other side of the same branch: at or above 1.0.0 the caret IS
    // major-pinned, so a moved minor is allowed. Without this the bug could
    // be "fixed" by pinning every caret to the minor, which would make the
    // case above pass and break every 1.x consumer.
    expect(satisfiesCaret("1.5.0", "^1.2.0"), "^1.2.0 must admit 1.5.0").toBe(true);
    expect(satisfiesCaret("2.0.0", "^1.2.0")).toBe(false);
  });

  test("a version below the floor is refused even inside the same minor", () => {
    // Also measured at ZERO: deleting the lower-bound check entirely left
    // all 48 green, because every other case differs in the major or the
    // minor and the upper bound catches those on its own. A version that
    // shares the floor's minor and sits BELOW its patch is the only shape
    // that isolates it.
    expect(satisfiesCaret("0.3.0", "^0.3.5"), "^0.3.5 must not admit 0.3.0").toBe(false);
    expect(satisfiesCaret("1.1.0", "^1.2.0"), "^1.2.0 must not admit 1.1.0").toBe(false);
    expect(satisfiesCaret("0.3.5", "^0.3.5")).toBe(true);
  });
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
