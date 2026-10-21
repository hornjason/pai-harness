import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  ABSENT_STATE,
  containmentVerdict,
  readContainment,
  WATCHED_DIRS,
} from "../lib/containment";

/**
 * #921 — two claims about `test/structure.test.ts`'s containment check, each
 * with the case that can see it go wrong.
 *
 * **AC-1: the suite's verdict does not depend on a directory outside the
 * project root.** ST-2b used to `readdirSync` a path composed from
 * `process.env.HOME`, so two unrelated scripts belonging to another running
 * process made every full local suite 1-fail while CI — with an empty home
 * directory — was green on the same commit. The witness runs the real
 * `test/structure.test.ts` twice under two fixture home directories that
 * differ only in a planted stray, and compares the two results. On the
 * pre-#921 file the planted run is 1-fail and the clean run is 0-fail.
 *
 * **AC-5 / AC-3: the reading can fail, and absence is not a pass.** A
 * fixture tree alone cannot show that: a freshly built tree is EMPTY, so
 * "the old locations hold no harness files" is true of it before the check
 * exists and true of it after. So the stray is PLANTED, the refusal is
 * asserted first, and only then is the stray removed and the pass asserted.
 * Both mutations below are applied to a copy of `lib/containment.ts` in a
 * temp directory; nothing in `lib/` is modified.
 *
 * Predicted before the battery ran, with the baseline row read first:
 *
 *   - baseline, unmutated — 8 pass, 0 fail
 *   - the directory listing never filtered (`strays` always empty), which is
 *     the reading not being taken — 1 red, the planted-stray row
 *   - `ABSENT_STATE` flipped to `"CLEAN"`, which is `if (!existsSync(dir))
 *     return` restored — 1 red, the absent row
 *
 * Measured counts are in the PR for #921.
 */

const REPO = resolve(import.meta.dir, "..");
const CONTAINMENT_SOURCE = join(REPO, "lib", "containment.ts");

/** The one expression that turns a directory listing into a stray list. */
const READING_ANCHOR = "const strays = entries.filter(f => f.endsWith(ext)).map(f => join(path, f));";

/** The declaration an absent location's state is routed through. */
const ABSENT_ANCHOR = 'export const ABSENT_STATE: ContainmentState = "UNMEASURED";';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rungate-921-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fixture old-harness root with every watched directory present. */
function fixtureRoot(name: string, strays: Record<string, string> = {}): string {
  const root = join(scratch, name, ".claude");
  for (const { dir } of WATCHED_DIRS) mkdirSync(join(root, dir), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const [rel, body] of Object.entries(strays)) writeFileSync(join(root, rel), body);
  return root;
}

describe("#921 AC-5/AC-3: the containment reading refuses a planted stray, and absence is not a pass", () => {
  // The refusing direction first. Written in this order on purpose: a case
  // that only ever sees a clean tree cannot tell "no stray present" from "no
  // longer looking".
  test("a .js planted in the old workflows location is REFUSED", () => {
    const root = fixtureRoot("planted", { "workflows/stray-harness.js": "// a second copy\n" });
    const readings = readContainment(root);
    expect(containmentVerdict(readings)).toBe("STRAY");
    const workflows = readings.find(r => r.subject === "workflows/*.js")!;
    expect(workflows.state).toBe("STRAY");
    expect(workflows.strays).toEqual([join(root, "workflows", "stray-harness.js")]);
  });

  test("the same tree with the stray removed reads CLEAN", () => {
    const root = fixtureRoot("clean");
    const readings = readContainment(root);
    expect(
      containmentVerdict(readings),
      `expected CLEAN, got ${readings.map(r => `${r.subject}=${r.state}`).join(", ")}`,
    ).toBe("CLEAN");
  });

  test("a location that does not exist is UNMEASURED, and UNMEASURED is not a pass", () => {
    const root = join(scratch, "absent", ".claude");
    mkdirSync(root, { recursive: true });
    const readings = readContainment(root);
    expect(readings.every(r => r.state === "UNMEASURED")).toBe(true);
    expect(containmentVerdict(readings)).not.toBe("CLEAN");
    expect(containmentVerdict(readings)).toBe("UNMEASURED");
  });

  test("an empty reading set is UNMEASURED — zero locations examined is not zero strays found", () => {
    expect(containmentVerdict([])).toBe("UNMEASURED");
  });
});

/**
 * A copy of `lib/containment.ts` with one anchor replaced, written where it
 * can be imported. The relative import is rewritten to an absolute path, and
 * any other relative specifier aborts the build rather than letting the
 * mutant die on module resolution — a mutant that cannot load refuses
 * everything, which reads exactly like a mutant that was caught.
 */
async function loadMutant(name: string, anchor: string, replacement: string) {
  const source = readFileSync(CONTAINMENT_SOURCE, "utf8");
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the anchor appears ${occurrences} times. At 0 it has ` +
        `moved and the mutant would be a copy of the original; above 1 the surviving copy ` +
        `would hold every case up and the reds would mean nothing.`,
    );
  }
  const mutated = source
    .replace(anchor, replacement)
    .replace('from "./check-remedy"', `from "${join(REPO, "lib", "check-remedy")}"`);
  const leftover = mutated.match(/from "\.\.?\//g);
  if (leftover) {
    throw new Error(`could not build the mutant: ${leftover.length} relative import(s) left`);
  }
  // One directory per mutant: bun caches its resolution of a directory after
  // the first import out of it, and a second file written there afterwards
  // is reported as a missing module — which looks exactly like a mutant that
  // failed to build.
  const dir = mkdtempSync(join(scratch, `mutant-${name}-`));
  const path = join(dir, "containment.ts");
  writeFileSync(path, mutated);
  return (await import(path)) as typeof import("../lib/containment");
}

describe("#921 AC-5: a mutation that stops the reading being taken turns a case red", () => {
  test("with the listing never filtered, the planted stray reads CLEAN", async () => {
    const mutant = await loadMutant("no-reading", READING_ANCHOR, "const strays: string[] = [];");
    const root = fixtureRoot("mutant-planted", { "workflows/stray-harness.js": "// a second copy\n" });

    // The real source refuses this exact tree — asserted before the mutant,
    // so the row cannot be satisfied by a tree nothing would refuse.
    expect(containmentVerdict(readContainment(root))).toBe("STRAY");
    expect(mutant.containmentVerdict(mutant.readContainment(root))).toBe("CLEAN");
  });

  test("with ABSENT_STATE flipped to CLEAN, an absent location passes — the pre-#921 behaviour", async () => {
    const mutant = await loadMutant(
      "absent-is-clean",
      ABSENT_ANCHOR,
      'export const ABSENT_STATE: ContainmentState = "CLEAN";',
    );
    const root = join(scratch, "mutant-absent", ".claude");
    mkdirSync(root, { recursive: true });

    expect(ABSENT_STATE).toBe("UNMEASURED");
    expect(containmentVerdict(readContainment(root))).toBe("UNMEASURED");
    expect(mutant.containmentVerdict(mutant.readContainment(root))).toBe("CLEAN");
  });
});

interface SuiteResult {
  pass: number;
  fail: number;
}

/**
 * Run the real structure suite with `HOME` pointed at a fixture.
 *
 * The counts are read off bun's own summary. A run that failed to load
 * reports no failures, which is indistinguishable from a run that passed, so
 * every caller asserts `pass > 0` before comparing anything.
 */
function runStructureSuite(home: string): SuiteResult {
  const r = Bun.spawnSync(["bun", "test", "test/structure.test.ts"], {
    cwd: REPO,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${r.stdout.toString()}\n${r.stderr.toString()}`;
  const pass = /^\s*(\d+) pass$/m.exec(out);
  const fail = /^\s*(\d+) fail$/m.exec(out);
  if (!pass || !fail) {
    throw new Error(`could not read the suite's summary — the instrument stopped reporting:\n${out}`);
  }
  return { pass: Number(pass[1]), fail: Number(fail[1]) };
}

describe("#921 AC-1: the structure suite's verdict does not depend on $HOME", () => {
  test("a stray planted in a fixture HOME leaves the suite's result unchanged", () => {
    const strayHome = join(scratch, "home-stray");
    fixtureRoot("home-stray", {
      "workflows/stray-harness.js": "// another process's file\n",
      "gates/stray-gate.ts": "export {};\n",
      "lib/stray-lib.ts": "export {};\n",
      "scripts/sync-spec-tests.ts": "export {};\n",
    });
    const cleanHome = join(scratch, "home-clean");
    fixtureRoot("home-clean");

    const planted = runStructureSuite(strayHome);
    const clean = runStructureSuite(cleanHome);

    expect(planted.pass, "the planted run reported no passing tests — it never loaded").toBeGreaterThan(0);
    expect(clean.pass, "the clean run reported no passing tests — it never loaded").toBeGreaterThan(0);
    expect(
      planted,
      `the suite read the home directory: ${JSON.stringify(planted)} with a stray planted, ` +
        `${JSON.stringify(clean)} without one`,
    ).toEqual(clean);
    expect(clean.fail, "the structure suite is not green on a clean fixture home").toBe(0);
  });
});
