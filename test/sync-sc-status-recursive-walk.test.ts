/**
 * #733 — `sync-sc-status` walked specs recursively and tests flat, so every
 * test file in a subdirectory of `test/` was invisible to the credit rule.
 *
 * Measured on `main` at `eb3612a3`: `test/unit` holds **59** `.test.ts` files
 * and **50** (spec, id) credits that the flat walk cannot see — 47 in
 * `HARNESS-STANDARD.md`, 2 in `INSTRUCTION-COMPLIANCE-SPEC.md`, 1 in
 * `HOOK-ARCHITECTURE-SPEC.md`.
 *
 * ## Nothing was red, and that is the interesting part
 *
 * Not one of those 50 showed up as an unticked criterion, because
 * `lib/sc-cover.ts` runs `matchPattern(d)` and executes the assertion, and a
 * conformity matcher happens to pass for all of them. A second route rescued
 * every id the first route could not see, so the defect was invisible from
 * every direction anybody looks: the checkboxes were right, the suite was
 * green, and the credit rule had been half-blind for its whole life.
 *
 * That is `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape with
 * the deciders disagreeing rather than agreeing — two routes to one verdict,
 * one of them broken, and the working one covering for it.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Add `test/unit` as a second hardcoded directory beside the existing one.**
 * It makes the 50 appear, it is two lines, and it is wrong for exactly the
 * reason the flat walk was wrong: the next subdirectory anybody adds is
 * invisible again, and now there are two lists to keep in step instead of one.
 *
 * `AC-1` is the case that survives it. Its fixture nests the claim TWO levels
 * deep under directory names that appear nowhere in `scripts/sync-sc-status.ts`
 * — asserted, not promised — so no list of hardcoded directories can satisfy
 * it. A fixture named `unit` would have gone green under the wrong fix.
 *
 * ## Why the fixtures case is not written on its own
 *
 * `test/fixtures/` yields **0** credits on this tree today, so an exclusion
 * that excludes nothing is indistinguishable from an exclusion that works —
 * and from no exclusion at all, since the pre-fix walk credited nothing in any
 * subdirectory. `AC-2` therefore plants a claim in a fixture tree and a claim
 * in an ordinary nested tree IN THE SAME FIXTURE, and asserts the first is
 * refused while the second is credited. Either half alone passes vacuously.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readSpecs, splitUnmatchedChecked } from "../lib/sc-cover";
import { isTemplateSpec, parseScDeclarations } from "../lib/sc-ids";
import { claimedScKeys, intendedOnly, scopedKey } from "../scripts/sync-sc-status";
import { walkTestFiles } from "../lib/walk-test-files";
import { scScanTestTimeout } from "./helpers/sc-scan-budget";
// The per-test budget for a case that scans the whole test tree (#1223).
// Calibrated on this machine and this tree rather than written down, so it
// has no expiry — see test/helpers/sc-scan-budget.ts.
setDefaultTimeout(scScanTestTimeout());

const REPO_ROOT = join(import.meta.dir, "..");
const SPECS_DIR = join(REPO_ROOT, "specs");
const TEST_DIR = join(REPO_ROOT, "test");

const SCRIPT = join(import.meta.dir, "..", "scripts", "sync-sc-status.ts");

/**
 * Directory names the fixture nests under.
 *
 * Deliberately not `unit`, `types`, `helpers` or any other name this repo
 * uses, and `AC-1` asserts they appear nowhere in the script — a hardcoded
 * list that happened to contain the fixture's directory would make the case
 * green while leaving the defect in place.
 */
const OUTER = "burrowed";
const INNER = "deeper-still";

/** Fixture criteria live in the 9000 range; this repo does not issue those. */
const NESTED_ID = "SC-9731";
const FIXTURE_ID = "SC-9732";
const INTENDED_ID = "SC-9733";

interface Tree { root: string; specs: string; tests: string; cleanup: () => void }

/**
 * A project with one spec and test files at several depths.
 *
 * Built under `mkdtemp` and naming no path that exists in this repository, so
 * it keeps witnessing after the real `test/` tree is reorganised.
 */
function tree(): Tree {
  const root = mkdtempSync(join(tmpdir(), "rungate-733-"));
  const specs = join(root, "specs");
  const tests = join(root, "test");
  mkdirSync(specs, { recursive: true });
  mkdirSync(join(tests, OUTER, INNER), { recursive: true });
  mkdirSync(join(tests, "fixtures", OUTER), { recursive: true });

  writeFileSync(
    join(specs, "WALK-FIXTURE-SPEC.md"),
    [
      "# Walk fixture",
      "",
      "## Success Criteria",
      "",
      `- [ ] ${NESTED_ID}: a criterion claimed from a nested test file`,
      `- [ ] ${FIXTURE_ID}: a criterion claimed only from inside a fixture tree`,
      `- [ ] ${INTENDED_ID}: a criterion named by an unrun test title`,
      "",
    ].join("\n"),
  );

  // Two levels down, in a declaring position (`covers` + the id).
  writeFileSync(
    join(tests, OUTER, INNER, "nested.test.ts"),
    `// covers ${NESTED_ID}\nimport { test, expect } from "bun:test";\ntest("a real case", () => { expect(1).toBe(1); });\n`,
  );

  // Inside a fixture tree. Same declaring form, so the ONLY thing that can
  // distinguish it is the directory it sits in.
  writeFileSync(
    join(tests, "fixtures", OUTER, "planted.test.ts"),
    `// covers ${FIXTURE_ID}\nimport { test, expect } from "bun:test";\ntest("fixture scaffolding", () => { expect(1).toBe(1); });\n`,
  );

  return { root, specs, tests, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const key = (id: string) => `WALK-FIXTURE-SPEC.md::${id}`;

describe("#733 AC-1: the credit walk reaches arbitrary depth", () => {
  test("a claim two directories down is credited", () => {
    const t = tree();
    try {
      // Establish the subject before asserting about it. A walk that read
      // nothing credits nothing, and an empty set satisfies no assertion
      // worth making — but it would satisfy a `.not.toContain`.
      const claimed = claimedScKeys(t.specs, t.tests);
      expect(claimed.size, "the walk credited nothing at all — it read no files").toBeGreaterThan(0);
      expect(
        [...claimed],
        `${NESTED_ID} sits at test/${OUTER}/${INNER}/nested.test.ts and was not credited`,
      ).toContain(key(NESTED_ID));
    } finally { t.cleanup(); }
  });

  test("the fixture's directory names appear nowhere in the script", () => {
    // The case that makes AC-1 survive the cheapest wrong fix. If the repair
    // is "add another hardcoded directory", this fixture's directories are
    // not among them, so AC-1 stays red. A fixture named `unit` would have
    // gone green under exactly the fix the issue warns about.
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src.length, "the script read as empty — it contains no directory names either").toBeGreaterThan(2000);
    expect(src, `the script names "${OUTER}", so the fixture no longer proves recursion`).not.toContain(OUTER);
    expect(src, `the script names "${INNER}", so the fixture no longer proves recursion`).not.toContain(INNER);
  });

  test("intendedOnly reaches the same depth", () => {
    // The second of the three walks, driven rather than asserted about. It
    // had the identical flat shape and would have been left behind by a fix
    // applied only to the credit walk.
    const t = tree();
    try {
      writeFileSync(
        join(t.tests, OUTER, INNER, "intended.test.ts"),
        `import { test } from "bun:test";\ntest.todo("${INTENDED_ID}: not written yet");\n`,
      );
      const intended = intendedOnly(t.tests);
      expect(
        [...intended.keys()],
        `${INTENDED_ID} is named by a todo two directories down and was not seen`,
      ).toContain(INTENDED_ID);
    } finally { t.cleanup(); }
  });
});

describe("#733 AC-2: a fixture tree earns no credit", () => {
  test("a planted claim under fixtures/ is refused while a nested one is credited", () => {
    // Both halves in one assertion pair, deliberately. `test/fixtures/` holds
    // zero credits on the real tree, so a refusal case standing alone is
    // green whether the exclusion works, does nothing, or the whole walk is
    // broken. The credited half is what makes the refused half mean anything.
    const t = tree();
    try {
      const claimed = claimedScKeys(t.specs, t.tests);
      expect(
        [...claimed],
        "the control half is not witnessing — nothing nested was credited, so the refusal below is vacuous",
      ).toContain(key(NESTED_ID));
      expect(
        [...claimed],
        `${FIXTURE_ID} was planted under test/fixtures/ and must not earn a credit`,
      ).not.toContain(key(FIXTURE_ID));
    } finally { t.cleanup(); }
  });
});

describe("#733 AC-3: one binding, not three walks", () => {
  test("no flat test-directory read survives in the script", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    expect(raw.length).toBeGreaterThan(2000);
    // The exact shape all three walks had. Spelled as a pattern rather than
    // a literal so a reformat does not quietly stop matching.
    const flat = raw.match(/readdirSync\([A-Za-z_][A-Za-z0-9_]*\)\s*\.filter\(/g) || [];
    expect(
      flat,
      `the script still walks a test directory flat: ${flat.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * How many places in the script walk the test tree.
   *
   * An EQUALITY, so it refuses a fall as well as a rise. #733 wrote this as
   * `>= 3` against the three walks that existed then, and the direction that
   * guard could not see is the one that arrived: #1223 folded two of the
   * three into `scanTestTree` — a correct change — and a one-sided check had
   * no way to tell that from the walker being bypassed.
   *
   * The two that remain, by the function that owns them:
   *
   *  - `scanTestTree`, the one tree-wide claim scan, which `intendedOnly`
   *    and `findTestFilesForSCs` now share;
   *  - `generateReport`, which lists the files behind each credit.
   *
   * Changing this number means adding or removing a walk. Say which in the
   * commit, and check the new one goes through `walkTestFiles` — the case
   * above only sees the `readdirSync(x).filter(` spelling.
   */
  const WALK_SITES = 2;

  test("every test-tree walk in the script goes through the exported walker", () => {
    const raw = readFileSync(SCRIPT, "utf-8");
    const uses = raw.match(/walkTestFiles\(/g) || [];
    expect(
      uses.length,
      `the script has ${uses.length} walkTestFiles call(s), not ${WALK_SITES} — a walk was ` +
        `added or removed. Update WALK_SITES here and say which in the commit`,
    ).toBe(WALK_SITES);
  });
});

describe("#733 AC-5: the two cover routes are reported as different states", () => {
  test("a matcher-bound criterion and a test-claimed one do not collapse into one verdict", () => {
    // The reason #733 was invisible for its whole life. Two independent
    // routes reach "this criterion is covered":
    //
    //   A. `lib/sc-cover.ts` runs `matchPattern(d)` and executes the
    //      assertion the conformity engine built;
    //   B. `scripts/sync-sc-status.ts` credits a declaring claim in a test
    //      file.
    //
    // Route B was half-blind — 50 credits unreachable — and route A rescued
    // every one of them, so no checkbox was ever wrong and no suite was ever
    // red. Two routes to one verdict with nothing comparing them is the
    // fourth shape, and the only defence is that the states stay
    // DISTINGUISHABLE: a reader must be able to ask "which route covered
    // this?" and get an answer.
    //
    // Measured on this tree: 225 checked criteria no matcher binds, split
    // 153 with no claim and 72 with one. Both halves non-empty is the whole
    // assertion — a single boolean "covered" cannot express three states.
    const claimed = claimedScKeys(SPECS_DIR, TEST_DIR);
    const split = splitUnmatchedChecked({ projectRoot: REPO_ROOT, claimed, scopedKey });

    // Establish the subject. An empty split agrees with every claim below.
    expect(claimed.size, "no credits at all — the comparison has nothing to read").toBeGreaterThan(0);

    // Route B only: no matcher binds it, and a test file declares it.
    expect(
      split.claimed.length,
      "nothing is covered by a test claim alone, so route B is not witnessing",
    ).toBeGreaterThan(0);

    // Neither route: no matcher, no claim. The honest "wish" population.
    expect(
      split.unclaimed.length,
      "nothing is uncovered by either route, so the states cannot be told apart",
    ).toBeGreaterThan(0);

    // Route A only: a matcher binds it and NO test file claims it. Without
    // this the two states above are "unmatched, claimed or not", which is one
    // question, and the matcher route would be invisible to this case.
    const checkedKeys = readSpecs(SPECS_DIR)
      .filter(s => !isTemplateSpec(s.file))
      .flatMap(s => parseScDeclarations(s.content, s.file))
      .filter(d => d.checked)
      .map(d => scopedKey(d.specFile, d.id));
    const unmatchedKeys = new Set(
      [...split.unclaimed, ...split.claimed].map(u => scopedKey(u.specFile, u.id)),
    );
    const matcherOnly = checkedKeys.filter(k => !unmatchedKeys.has(k) && !claimed.has(k));
    expect(
      matcherOnly.length,
      "no criterion is covered by the matcher alone, so route A is not witnessing either",
    ).toBeGreaterThan(0);

    // And the three populations are genuinely disjoint, which is what makes
    // them states rather than overlapping labels.
    const claimedOnlyKeys = new Set(split.claimed.map(u => scopedKey(u.specFile, u.id)));
    for (const k of matcherOnly) {
      expect(claimedOnlyKeys.has(k), `${k} is reported in two states at once`).toBe(false);
    }
  });
});

describe("#733 AC-6: the walk returns a fixed order", () => {
  test("output is lexicographic, not whatever readdir handed back", () => {
    // Honest about what this can and cannot witness HERE.
    //
    // The walk is depth-first in `readdir` order, and on APFS that order
    // usually coincides with the lexicographic one, so removing the `.sort()`
    // scored **0 red** on this machine and I could not construct a local
    // input on which mutant and original differ. Per
    // `.claude/rules/checks-must-be-able-to-fail.md`, a 0 I cannot pair with
    // a differing input is not evidence of a gap — it is no information.
    //
    // It is not nothing in CI. Linux returns directory entries in hash
    // order, so an unsorted walk there produces a different sequence run to
    // run, and the three call sites in `sync-sc-status.ts` print these paths
    // to a human. This case is the one that fires on that machine.
    const t = tree();
    try {
      // Several files at several depths, written in an order that is not the
      // sorted one, so the sequence is a property of the walk rather than of
      // how the fixture happened to be built.
      for (const rel of ["zulu.test.ts", "alpha.test.ts", `${OUTER}/mike.test.ts`, `${OUTER}/bravo.test.ts`]) {
        writeFileSync(join(t.tests, rel), `import { test, expect } from "bun:test";\ntest("x", () => { expect(1).toBe(1); });\n`);
      }
      const files = walkTestFiles(t.tests);
      expect(files.length, "the walk found nothing — order is vacuous").toBeGreaterThan(1);
      expect(files, "the walk returned filesystem order, not a fixed one").toEqual([...files].sort());
    } finally { t.cleanup(); }
  });
});
