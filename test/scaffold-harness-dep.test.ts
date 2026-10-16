/**
 * Re-scaffolding never removed a file: spec, and added a second one (#475).
 *
 * `addPaiHarnessDevDep` decided whether a consumer already had the harness
 * with exactly one test:
 *
 * ```ts
 * if (pkg.devDependencies["rungate"] || isHarnessItself(root)) { ...skip... }
 * ```
 *
 * One key, one section, one name. It could not see `rungate` in
 * `dependencies` or `optionalDependencies`, could not see `pai-harness` —
 * the package's former name, which older scaffold runs wrote — and could not
 * see a `file:` spec under any of them. `harnessDevDepRange`'s comment says
 * "`file:` is the bug": the EMISSION was fixed and nothing was ever written
 * to undo what the broken emission left behind.
 *
 * **The sharper half is that it adds a second declaration.** With
 * `optionalDependencies: { "rungate": "file:../rungate" }` and no
 * `devDependencies.rungate`, the guard does not fire, so the scaffold writes
 * `devDependencies.rungate = "^0.4.0"` beside it. One package declared
 * twice, in two sections, with two incompatible specs — reported as
 * `UPDATED: package.json (rungate devDep)`.
 *
 * Measured in a real consumer, two declarations from two scaffold runs two
 * days apart under the two different names:
 *
 * ```
 * file:../pai-harness -> 34f03818  2026-09-17
 * file:../rungate     -> 3a6501a9  2026-09-19
 * ```
 *
 * They survived every re-scaffold since September, and the cost was a dead
 * container build — bun resolves `file:` optionals and fails on a folder
 * outside the build context.
 *
 * Covers SC-1, SC-2, SC-3, SC-4, SC-5 (#475).
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * `test/scaffold-harness-dep.test.ts` (19 tests):
 *
 * | Mutation | Red | Predicted |
 * |---|---|---|
 * | the scanner narrowed to `devDependencies.rungate` — #475's guard restored | 13 | 13 |
 * | the removal loop dropped, so the write lands beside the old entry | 6 | 6 |
 * | `pai-harness` dropped from the name list | 9 | 8 |
 * | skip whenever anything is found, so nothing is ever migrated | 8 | 8 |
 * | the skip branch removed, so a correct consumer is rewritten | 2 | 2 |
 *
 * None is left in the tree; all were run and reverted.
 *
 * The `pai-harness` row is the one worth reading. It was predicted at 7 and
 * came back **4**, because the matrix was derived from the exported
 * constants: dropping a name did not fail the three cases covering it, it
 * DELETED them. The file went from 18 tests to 15 and reported green — a
 * shrinking corpus and a clean one are the same answer. The matrix is now
 * written out by hand with a separate case asserting it still matches what
 * ships, and the same mutation is 9. The second prediction missed by one
 * (the every-cell case also covers those names), which is a counting slip
 * rather than a second defect.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  addPaiHarnessDevDep,
  DEP_SECTIONS,
  findHarnessDeclarations,
  harnessDepPlan,
  HARNESS_PKG_NAMES,
} from "../lib/scaffold/steps";

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A consumer project carrying exactly the package.json given. */
function consumer(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "rungate-dep-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "a-consumer", ...pkg }, null, 2));
  return dir;
}

const readPkg = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));

/**
 * The matrix, WRITTEN OUT rather than derived from the exported constants.
 *
 * Deriving it is how a corpus certifies itself. The first draft of this file
 * looped over `DEP_SECTIONS` and `HARNESS_PKG_NAMES`, and the battery caught
 * it: dropping `pai-harness` from the list was predicted at 7 red and came
 * back 4, because the three cases testing that name did not fail — they
 * stopped existing. The suite shrank from 18 tests to 15 and reported green.
 * A shrinking corpus and a clean one are the same answer.
 */
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const NAMES = ["rungate", "pai-harness"] as const;

/** Every declaration of the harness left in a package.json, across all sections. */
function declarationCount(pkg: Record<string, Record<string, unknown>>): number {
  let n = 0;
  for (const s of SECTIONS) for (const name of NAMES) if (pkg[s]?.[name]) n++;
  return n;
}

describe("#475 SC-1: the presence check consults every section and both names", () => {
  test("the exported lists are exactly the matrix below", () => {
    // The link between the hand-written corpus and the code. Without it the
    // two drift and the matrix quietly stops covering what ships; with it,
    // narrowing either list is a visible, failing change rather than a
    // silently smaller test file.
    expect([...DEP_SECTIONS], "a section was added or removed").toEqual([...SECTIONS]);
    expect([...HARNESS_PKG_NAMES], "a package name was added or removed").toEqual([...NAMES]);
  });

  // The matrix the old one-key test could not see. Six cells; it saw one.
  for (const section of SECTIONS) {
    for (const name of NAMES) {
      test(`${section}.${name} is recognised`, () => {
        const found = findHarnessDeclarations({ [section]: { [name]: "file:../x" } });
        expect(found, `${section}.${name} is invisible to the scanner`).toHaveLength(1);
        expect(found[0]).toEqual({ section, name, spec: "file:../x" });
      });
    }
  }

  test("the positive control: an unrelated dependency is not a harness declaration", () => {
    // A scanner that returned everything would satisfy all six cells above.
    expect(findHarnessDeclarations({ devDependencies: { typescript: "^5" } })).toEqual([]);
    expect(findHarnessDeclarations({})).toEqual([]);
    expect(findHarnessDeclarations(null)).toEqual([]);
    // A near-miss name must NOT match: renaming on a substring would rewrite
    // somebody else's package.
    expect(findHarnessDeclarations({ devDependencies: { "rungate-plugin": "^1" } })).toEqual([]);
  });
});

describe("#475 SC-2: the outcome is ONE declaration, counted across all sections", () => {
  test("THE BUG: a file: optional no longer gets a second declaration beside it", () => {
    // Verbatim reproduction. Before the fix this ended with the package
    // declared twice, with two incompatible specs, reported as a success.
    const dir = consumer({ optionalDependencies: { rungate: "file:../rungate" } });
    const actions: string[] = [];
    addPaiHarnessDevDep(dir, actions, "0.4.2");

    const pkg = readPkg(dir);
    expect(declarationCount(pkg), "the package is declared more than once").toBe(1);
    expect(pkg.devDependencies.rungate).toBe("^0.4.0");
    expect(pkg.optionalDependencies?.rungate, "the file: spec survived").toBeUndefined();
  });

  test("the real consumer's state: two names, two sections, both file:", () => {
    // DailyBriefDashboard as traced, after its later commit moved both to
    // optionalDependencies — wrong section AND wrong name, so a migration
    // written only against devDependencies would miss them twice over.
    const dir = consumer({
      optionalDependencies: {
        rungate: "file:../rungate",
        "pai-harness": "file:../pai-harness",
      },
    });
    addPaiHarnessDevDep(dir, [], "0.4.2");

    const pkg = readPkg(dir);
    expect(declarationCount(pkg)).toBe(1);
    expect(pkg.devDependencies.rungate).toBe("^0.4.0");
    expect(pkg.optionalDependencies, "an emptied section was left behind").toBeUndefined();
  });

  test("every MISPLACED cell of the matrix ends with exactly one declaration", () => {
    for (const section of SECTIONS) {
      for (const name of NAMES) {
        // The one cell that is not misplaced is left alone on purpose —
        // see `devDependencies.rungate is where intent looks like` below.
        if (section === "devDependencies" && name === "rungate") continue;
        const dir = consumer({ [section]: { [name]: "file:../rungate" } });
        addPaiHarnessDevDep(dir, [], "0.4.2");
        const pkg = readPkg(dir);
        expect(declarationCount(pkg), `${section}.${name} left more than one declaration`).toBe(1);
        expect(pkg.devDependencies.rungate, `${section}.${name} did not consolidate`).toBe("^0.4.0");
      }
    }
  });

  test("devDependencies.rungate is where intent looks like, so a lone file: pin stays", () => {
    // #362 SC-815 and #475 SC-2 contradict each other read literally, and
    // this is the line between them: PLACEMENT, not spec. Both `file:`
    // entries #475 traced were written by scaffold runs and both landed in
    // `optionalDependencies` under two names — a position the scaffold would
    // never choose. A lone `devDependencies.rungate` is exactly where a
    // developer linking a local checkout puts one.
    const dir = consumer({ devDependencies: { rungate: "file:../rungate" } });
    const actions: string[] = [];
    addPaiHarnessDevDep(dir, actions, "0.4.2");
    expect(readPkg(dir).devDependencies.rungate).toBe("file:../rungate");
    expect(actions.join("\n")).toContain("SKIP");

    // ...but the SAME spec one section over is the scaffold's to clean up.
    const misplaced = consumer({ dependencies: { rungate: "file:../rungate" } });
    addPaiHarnessDevDep(misplaced, [], "0.4.2");
    expect(readPkg(misplaced).devDependencies.rungate).toBe("^0.4.0");
    expect(readPkg(misplaced).dependencies).toBeUndefined();
  });

  test("an unrelated dependency in the same section is untouched", () => {
    // The migration deletes keys. It must delete only its own.
    const dir = consumer({
      optionalDependencies: { rungate: "file:../rungate", fsevents: "^2.3.0" },
    });
    addPaiHarnessDevDep(dir, [], "0.4.2");
    const pkg = readPkg(dir);
    expect(pkg.optionalDependencies, "a section with a surviving entry was deleted").toEqual({
      fsevents: "^2.3.0",
    });
  });
});

describe("#475 SC-3: the old name is renamed, not left beside the new one", () => {
  test("pai-harness becomes rungate rather than gaining a sibling", () => {
    const dir = consumer({ devDependencies: { "pai-harness": "file:../pai-harness" } });
    addPaiHarnessDevDep(dir, [], "0.4.2");
    const pkg = readPkg(dir);
    expect(pkg.devDependencies["pai-harness"], "both names are now declared").toBeUndefined();
    expect(pkg.devDependencies.rungate).toBe("^0.4.0");
    expect(declarationCount(pkg)).toBe(1);
  });

  test("a caret-ranged pai-harness is still migrated", () => {
    // `file:` is the loudest case but not the only wrong one — the old name
    // is wrong whatever its spec, because the package no longer exists.
    const dir = consumer({ devDependencies: { "pai-harness": "^0.3.0" } });
    addPaiHarnessDevDep(dir, [], "0.4.2");
    expect(readPkg(dir).devDependencies).toEqual({ rungate: "^0.4.0" });
  });
});

describe("#475 SC-4: the migration says what it did", () => {
  test("the action names the path, the before and the after", () => {
    // The reported cost was a consumer who did not know this was in their
    // package.json until a container build died. A bare `UPDATED:` is how
    // that happens twice.
    const dir = consumer({ optionalDependencies: { "pai-harness": "file:../pai-harness" } });
    const actions: string[] = [];
    addPaiHarnessDevDep(dir, actions, "0.4.2");
    const line = actions.join("\n");
    expect(line).toContain("package.json");
    expect(line, "the action does not say where it found it").toContain("optionalDependencies.pai-harness");
    expect(line, "the action does not say what it was").toContain("file:../pai-harness");
    expect(line, "the action does not say what it became").toContain("devDependencies.rungate=^0.4.0");
  });

  test("a plain add is NOT announced as a migration", () => {
    const dir = consumer({});
    const actions: string[] = [];
    addPaiHarnessDevDep(dir, actions, "0.4.2");
    expect(actions.join("\n")).toContain("UPDATED: package.json (rungate devDep)");
    expect(actions.join("\n"), "an addition was reported as a migration").not.toContain("migrated");
  });
});

describe("#475 SC-5: a correct consumer is left alone", () => {
  test("a correct caret range reports SKIP and is not rewritten", () => {
    // The positive control, and the reason the plan does not simply rewrite
    // everything: a scaffold that rewrites a working spec on every run is
    // indistinguishable from one that cannot tell a working spec from a
    // broken one, and it would churn every consumer on every release.
    const dir = consumer({ devDependencies: { rungate: "^0.3.0" } });
    const before = readFileSync(join(dir, "package.json"), "utf-8");
    const actions: string[] = [];
    addPaiHarnessDevDep(dir, actions, "0.4.2");
    expect(actions.join("\n")).toContain("SKIP");
    expect(actions.join("\n")).toContain("^0.3.0");
    expect(readFileSync(join(dir, "package.json"), "utf-8"), "a correct consumer was rewritten")
      .toBe(before);
  });

  test("the harness itself still short-circuits before anything is planned", () => {
    // `isHarnessItself` is asked FIRST: the harness's own package.json names
    // itself, and running the migration over it would rewrite the harness
    // into depending on itself.
    const repoRoot = join(import.meta.dir, "..");
    const actions: string[] = [];
    const before = readFileSync(join(repoRoot, "package.json"), "utf-8");
    addPaiHarnessDevDep(repoRoot, actions, "0.4.2");
    expect(actions.join("\n")).toContain("self-reference");
    expect(readFileSync(join(repoRoot, "package.json"), "utf-8"), "the harness rewrote itself")
      .toBe(before);
  });

  test("the plan distinguishes all three outcomes", () => {
    // One decider, three answers, asserted directly so the writer's
    // behaviour above cannot be the only evidence that it chose correctly.
    expect(harnessDepPlan({}, "^0.4.0").action).toBe("add");
    expect(harnessDepPlan({ devDependencies: { rungate: "^0.3.0" } }, "^0.4.0").action).toBe("skip");
    expect(harnessDepPlan({ devDependencies: { rungate: "file:../x" } }, "^0.4.0").action,
      "a lone devDependencies pin is intent, not drift (#362 SC-815)").toBe("skip");
    expect(harnessDepPlan({ dependencies: { rungate: "^0.4.0" } }, "^0.4.0").action)
      .toBe("migrate");
  });
});
