import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fsWriteCapabilities } from "../lib/fs-write-capabilities";
import { fixedScratchRoots, uniqueScratchPrefixes } from "../lib/scratch-roots";
import { scratchPrefixes } from "../lib/scratch-cleanup";
import { describeScanBudget, measureScan, scanBudgetFromBunfig, scanBudgetViolations } from "../lib/scan-budget";

/**
 * #323 SC-6 — a fixed scratch path is a shared mutable resource.
 *
 * Four suites planted their fixtures at a hard-coded directory inside the
 * repo: `.gate-vacuous-test`, `.tree-under-test-scratch`,
 * `.spec-collection-scratch`, `.state-contract-scratch`. Each one works
 * perfectly alone. Run two of them at once — two sessions, two worktrees, or
 * one `bun test` interleaving files — and they write the same directory, and
 * `afterEach(() => rmSync(SCRATCH, ...))` in one deletes the fixtures another
 * is mid-assertion over.
 *
 * The failure that produces is the worst kind to chase, because it does not
 * look like contention. It looks like a logic error: a file the test just
 * wrote is missing, an expected violation is absent, a count is short. The
 * suite points at the assertion rather than at the cause, and the cause is not
 * in the file you are reading.
 *
 * This repo had three other sessions running against it while this was
 * written, so the collision is not hypothetical.
 *
 * `mkdtempSync` gives each run its own directory. The suffix is the fix; this
 * file is what stops the next scratch root from arriving without one.
 *
 * ## What this guard does and does not cover
 *
 * It flags a dot-directory built from a root constant AND passed to
 * `mkdirSync`/`rmSync` — created or destroyed, i.e. actually used as scratch
 * rather than merely read. A directory the suite only reads (`.claude`,
 * `.github`) is not scratch and is correctly ignored.
 *
 * It cannot see a scratch root assembled at runtime from pieces, or one built
 * with `resolve()` instead of `join()`. Those would escape. The criterion is
 * behavioural rather than a name list, which is the widest honest net here —
 * a list of forbidden names is a second place to forget, and forgetting there
 * reads as the path being safe.
 */

const ROOT = join(import.meta.dir, "..");
const TEST_DIR = join(ROOT, "test");

/**
 * This file is skipped by its own live scan, and the next case proves that is
 * safe rather than convenient.
 *
 * The negative fixtures below are source text — `const S = join(ROOT, ".x")`
 * and friends — so the detector reads its own test data as four violations.
 * This is the fourth time the self-reference trap has fired in this codebase
 * today, and the first time `lib/strip-js-comments.ts` is not the answer:
 * these are string LITERALS, not comments, and they have to stay literal
 * because they are the only way to prove the detector still fires.
 *
 * An unchecked skip is how an exemption becomes a hole, so the exemption is
 * paired with an assertion that this file creates no directories at all.
 */
const SELF = "scratch-paths-unique.test.ts";

/**
 * The detectors moved to `lib/scratch-roots.ts` in #437 and are imported above.
 *
 * They had to move because #437's sweeper needs the other half of the same
 * parse — which prefixes the `mkdtempSync` roots use — to build its deletion
 * allowlist. A second copy of the parse would be two deciders that agree, and
 * this one has a recursive delete on the end of it: a copy that quietly
 * stopped seeing a prefix would not go red, it would stop sweeping, which is
 * indistinguishable from nothing having leaked.
 */

/**
 * The scan, run through `measureScan` (#804) and memoised so the two cases
 * below read ONE walk rather than two. A second walk would be a second
 * population, and the budget case would then be reporting on a scan nobody
 * asserted over.
 *
 * **Lazy on purpose, and the next case checks that it stayed lazy.** The
 * tempting shape is a `const SCAN = measureScan(...)` at module scope, or the
 * same thing in `beforeAll`. Both work, both are tidier, and both move the
 * cost OUT of the per-test budget — module and hook time are not what bun's
 * per-test timeout measures. That is the `}, 60_000)` override again through a
 * different door: the scan stops being killable, so it stops being visible to
 * `timeoutProximityViolations`, and a scan that grows back to 30 seconds hangs
 * the file load with no budget and no message at all. Whichever case runs
 * first pays for the walk, inside the budget, where #621 can read it.
 */
/**
 * Is a test case currently running? (#968.)
 *
 * The guard this replaces was `const SCANNED_BEFORE_ANY_CASE_RAN = MEMO !==
 * null` read at the end of module evaluation. It worked only because that
 * `const` happened to sit after every other module-scope statement, so it
 * was POSITIONAL where the property is STRUCTURAL — and it caught exactly
 * one of the hoists it was written to refuse.
 *
 * MEASURED by hoisting the walk and running the file:
 *
 * | hoist destination | 600ms work under a 300ms budget | old guard |
 * |---|---|---|
 * | module scope       | 1 pass — escapes entirely | caught |
 * | a `describe` body  | 1 pass — escapes entirely | **8 pass / 0 fail, missed** |
 * | `beforeAll`        | KILLED at 300ms           | **8 pass / 0 fail, missed** |
 *
 * The middle row is the defect: a `describe` body runs at collection time,
 * is not covered by any per-test timeout, and the old guard let it through.
 *
 * The third row corrects #968's own reasoning, which grouped `beforeAll`
 * with module scope as "also outside the per-test timeout". On bun 1.3.14 it
 * is not — the hook is killed at the budget and the JUnit report carries
 * `<failure type="TimeoutError" />`, so `timeoutProximityViolations` DOES
 * fire on it. What it loses is the name: the testcase is reported as
 * `(unnamed)`, so the proximity row cannot say which case was killed. That
 * is a real loss and `beforeAll` is still refused below, but it is refused
 * for the name, not for the budget.
 *
 * `beforeEach` runs after `beforeAll` and before the case body, so one
 * boolean separates all four positions with no reliance on where a `const`
 * sits in the file.
 */
let IN_CASE = false;
beforeEach(() => {
  IN_CASE = true;
});
afterEach(() => {
  IN_CASE = false;
});

/**
 * Throws unless a case is running. Takes the flag as an argument so that a
 * case can assert the guard is ARMED — from inside a case `IN_CASE` is
 * necessarily true, so a guard reading only the module variable could never
 * be shown to fire.
 */
export function assertInCase(inCase: boolean): void {
  if (inCase) return;
  throw new Error(
    "the scratch-root scan ran outside a test case — at module load, in a describe body, or in a " +
      "beforeAll. Module and describe-body time is not covered by bun's per-test timeout at all, and " +
      "a beforeAll that is killed is reported as `(unnamed)`, so the proximity row cannot say which " +
      "case died. Either way the scan stops being readable by timeoutProximityViolations — the same " +
      "blind spot the `}, 60_000)` override created in #802. Call scan() from inside a test case.",
  );
}

let MEMO: { values: string[]; reading: ReturnType<typeof measureScan<string>>["reading"] } | null = null;
function scan() {
  assertInCase(IN_CASE);
  if (MEMO === null) {
    MEMO = measureScan<string>({
      root: "test/",
      files: readdirSync(TEST_DIR)
        .filter(f => f.endsWith(".ts"))
        .filter(f => f !== SELF), // see the exemption case below, which checks this is safe
      budgetMs: scanBudgetFromBunfig(readFileSync(join(ROOT, "bunfig.toml"), "utf-8")),
      read: f =>
        fixedScratchRoots(readFileSync(join(TEST_DIR, f), "utf-8")).map(
          hit =>
            `test/${f} — ${hit} is a fixed path; wrap it in mkdtempSync(join(ROOT, "<prefix>-")) ` +
            `so two concurrent runs cannot delete each other's fixtures (#323 SC-6)`,
        ),
    });
  }
  return MEMO;
}

describe("#323 SC-6: no suite plants its fixtures at a path another run shares", () => {
  test("every in-repo scratch root in test/ is unique per run", () => {
    const { values } = scan();
    expect(values, `shared scratch roots:\n${values.join("\n")}`).toEqual([]);
  });

  /**
   * #804 — the scan's own cost, measured rather than asserted.
   *
   * A timeout carries no message: the runner kills the case and the failure
   * text above, which names the file, the offending path and the repair, is
   * never reached. This reports the duration, the path and the budget while
   * there is still room to act on it — and `measureScan` has already printed
   * the same sentence to stdout mid-scan, so the evidence survives even the
   * run where the kill wins and this case never executes.
   *
   * It no longer carries `}, 60_000)`. That override arrived in #802, when the
   * scan cost 3.48s over 378 files and CI was killing it at 5005.68ms and
   * 5172.46ms with no message. #798 rewrote the scan and it is 174.68ms over
   * 427 files on `41d287c5`, measured 2026-10-21 — so the override bought
   * nothing, and it cost the one thing that would have warned.
   */
  test("#804: the scan stays well inside the per-test budget, measured", () => {
    const { reading } = scan();
    expect(scanBudgetViolations(reading), describeScanBudget(reading)).toEqual([]);
  });

  /**
   * #804 — the wrong fix that does not look like one, refused. #968 made the
   * refusal structural.
   *
   * Hoisting the walk out of a case leaves a green suite, a fast-looking
   * case, and a scan the proximity reading cannot name. The refusal is now
   * inside `scan()` itself, so it does not matter WHERE the hoist goes: no
   * case is running at module load, in a `describe` body or in a
   * `beforeAll`, and all three throw.
   *
   * These two cases are what keep that mechanism honest. The guard cannot
   * demonstrate itself from inside a case — `IN_CASE` is true there by
   * definition — so the flag's liveness and the throw are asserted
   * separately.
   */
  test("#968: the in-case flag is live, not a constant", () => {
    expect(
      IN_CASE,
      "beforeEach did not set IN_CASE, so assertInCase would throw inside every case or never at all",
    ).toBe(true);
  });

  test("#968: the guard throws outside a case and not inside one", () => {
    expect(() => assertInCase(false)).toThrow(/outside a test case/);
    expect(() => assertInCase(true)).not.toThrow();
  });

  /**
   * The WIRING witness. The two cases above prove the guard works; this
   * proves `scan()` consults it. Without this, removing the
   * `assertInCase(IN_CASE)` line from `scan()` leaves all three green — the
   * detector-that-measures-nothing shape #968 is about, one level in.
   *
   * Read from the AST, not from source text: this file's own fixtures are
   * strings full of call-shaped text, and a text count reads them as calls.
   */
  test("#968: scan() consults the guard before it walks", () => {
    const src = readFileSync(join(TEST_DIR, SELF), "utf-8");
    const body = /function scan\(\)\s*\{\s*([^\n;]+);/.exec(src);
    expect(body, "scan() no longer has a recognisable body — this wiring check is UNMEASURED").not.toBeNull();
    expect(
      body?.[1],
      "the first statement of scan() is no longer the in-case guard, so the scan can be hoisted out " +
        "of a case with every assertion above still green",
    ).toBe("assertInCase(IN_CASE)");
  });

  /**
   * The exemption, checked. If someone later adds a real scratch directory
   * here, the self-exclusion above would hide it — so the exclusion is
   * conditional on this file holding no write capability at all, which is
   * true of a pure source-analysis guard and stops being true the moment it
   * is not.
   *
   * #968 moved the reading to `lib/fs-write-capabilities.ts`. It used to be
   * `/import\s*\{([^}]*)\}\s*from\s*"fs";/.exec(self)`, and `exec` returns
   * the FIRST match. MEASURED by mutating this very file and running it: a
   * SECOND `import { mkdirSync } from "fs";` left the suite at 8 pass / 0
   * fail, and so did `import { mkdirSync } from "node:fs";`. The file gained
   * a write primitive and the case that exists to notice stayed green.
   *
   * Reading the import list was the old way of dodging the self-reference
   * trap — this file's fixtures contain `mkdtempSync(` and `rmSync(` as
   * string DATA, and a text count reads them as calls. That dodge is what
   * made it blind to the second import. An AST does not need the dodge: a
   * string is a `Literal` and a call is a `CallExpression`, so the detector
   * now reads imports, `require`, dynamic `import()`, `Bun.write` and
   * `Bun.$` alike without its own fixtures lying to it.
   */
  test("skipping this file is safe, because it creates nothing", () => {
    const capabilities = fsWriteCapabilities(readFileSync(join(TEST_DIR, SELF), "utf-8"));
    // REFUSAL, kept distinct from `[]`. A file that stopped parsing reports
    // exactly as clean as one that cannot write.
    expect(
      capabilities,
      `test/${SELF} did not parse, so its write capability is UNMEASURED rather than absent`,
    ).not.toBeNull();
    expect(
      capabilities,
      `test/${SELF} can write to the filesystem:\n${(capabilities ?? []).join("\n")}\n` +
        `so it can create a scratch root that its self-exclusion from the scan above would hide — ` +
        `either drop the exclusion or move the writes out`,
    ).toEqual([]);
  });

  test("the guard fires on the four paths it was written for", () => {
    // The mutation, as literals rather than file edits. Without this the test
    // above is satisfied by a regex that stopped matching — which is how a
    // detector goes quiet and gets trusted more for it.
    const reintroduced = `
      const REPO_ROOT = join(import.meta.dir, "..");
      const SCRATCH = join(REPO_ROOT, ".gate-vacuous-test");
      beforeAll(() => { rmSync(SCRATCH, { recursive: true, force: true }); });
    `;
    expect(fixedScratchRoots(reintroduced)).toEqual(['SCRATCH = .gate-vacuous-test']);
  });

  test("the fixed form is caught and the mkdtemp form is not", () => {
    // The boundary. A guard that flagged both would be permanently red and
    // would be deleted; one that flagged neither is this file's subject.
    const R = 'const ROOT = join(import.meta.dir, "..");\n';
    const fixed = R + 'const S = join(ROOT, ".x");\nmkdirSync(S);';
    const unique = R + 'const S = mkdtempSync(join(ROOT, ".x-"));\nmkdirSync(S);';
    expect(fixedScratchRoots(fixed)).toHaveLength(1);
    expect(fixedScratchRoots(unique)).toHaveLength(0);
  });

  test("a directory that is only read is not reported", () => {
    // `.claude` is configuration. Renaming it per run would break the read,
    // so a guard that flagged every dot-directory would be wrong, not strict.
    const readOnly =
      'const ROOT = join(import.meta.dir, "..");\n' +
      'const CFG = join(ROOT, ".claude");\nreadFileSync(join(CFG, "settings.json"));';
    expect(fixedScratchRoots(readOnly)).toEqual([]);
  });

  /**
   * #1473 — the root does not have to be given a name to be the shared
   * checkout.
   *
   * `repoRootIdents` finds identifiers BOUND to `import.meta.dir` or
   * `process.cwd()`. It cannot find a use that never bound one, and `DECL`
   * required `join`'s first argument to be an identifier, so this escaped
   * entirely:
   *
   *     const tmpDir = join(import.meta.dir, ".tmp-scan-test");
   *
   * `test/scan-stale-issues.test.ts` sat in the tree writing exactly that,
   * and `fixedScratchRoots` returned `[]` for it. The live case above went
   * green over it for as long as it existed — a rule whose check cannot see
   * an instance in its own tree, which is what
   * `.claude/rules/checks-must-be-able-to-fail.md` is about.
   *
   * MEASURED over 531 files before widening the parse: three declarations in
   * the inline form, two of them `join(process.cwd(), ".claude")` reads in
   * `config-access-conformity.test.ts`, which the `mutates` filter already
   * excluded and still does, and one the mutating instance above. So the
   * widening flags exactly one file and it is the defect.
   *
   * These are unit fixtures because the TREE no longer exercises the
   * widening — the one instance is fixed in the same change. The live case
   * above is the right place for the population and the wrong place for the
   * boundary.
   */
  test("#1473: an inline import.meta.dir root is caught", () => {
    const src = 'const t = join(import.meta.dir, ".x");\nmkdirSync(t);';
    expect(fixedScratchRoots(src)).toEqual(["t = .x"]);
  });

  test("#1473: an inline process.cwd() root is caught", () => {
    const src = 'const t = join(process.cwd(), ".x");\nrmSync(t, { recursive: true });';
    expect(fixedScratchRoots(src)).toEqual(["t = .x"]);
  });

  test("#1473 CONTROL: the named-root form still reads exactly as before", () => {
    // The regression direction. A widening that broke the form the guard was
    // built for would be caught by the live case, but only while the tree
    // still contains one — which is not a property this file controls.
    const src = 'const ROOT = join(import.meta.dir, "..");\nconst t = join(ROOT, ".x");\nmkdirSync(t);';
    expect(fixedScratchRoots(src)).toEqual(["t = .x"]);
  });

  test("#1473 CONTROL: an inline root that is only READ is not scratch", () => {
    // Live instance: config-access-conformity.test.ts does this twice with
    // `.claude`. Renaming configuration per run would break the read, so a
    // guard that flagged it would be wrong rather than strict — and this is
    // the only thing standing between the widening and two false positives
    // in the tree today.
    const src = 'const p = join(process.cwd(), ".claude");\nreadFileSync(join(p, "settings.json"));';
    expect(fixedScratchRoots(src)).toEqual([]);
  });

  test("#1473 CONTROL: an inline root wrapped in mkdtempSync is not a fixed root", () => {
    const src = 'const t = mkdtempSync(join(import.meta.dir, ".x-"));\nmkdirSync(t);';
    expect(fixedScratchRoots(src)).toEqual([]);
  });

  test("#1473 CONTROL: navigation through an inline root is not a scratch name", () => {
    const src = 'const t = join(import.meta.dir, "..");\nmkdirSync(t);';
    expect(fixedScratchRoots(src)).toEqual([]);
  });

  /**
   * The direction that needed justifying: the same parse feeds
   * `lib/scratch-cleanup.ts`'s DELETION allowlist, so widening it widens what
   * the sweeper may remove.
   *
   * It widens by exactly one shape — a genuine
   * `mkdtempSync(join(import.meta.dir, "<prefix>"))`, which is a directory
   * this tree really does plant and really should sweep. The prefix is still
   * returned exactly as written, so nothing is widened by a character.
   *
   * That the real tree's allowlist did not change is held next door, by
   * `test/scratch-cleanup.test.ts`'s element-by-element comparison against
   * the frozen pre-#793 reference: zero inline `mkdtempSync` declarations
   * exist in `test/`, so live and reference still agree on every file. That
   * reference is frozen on purpose and was NOT updated for this change.
   */
  test("#1473: the sweeper sees an inline mkdtemp prefix, exactly as written", () => {
    expect(
      uniqueScratchPrefixes('const t = mkdtempSync(join(import.meta.dir, ".inline-"));'),
    ).toEqual([".inline-"]);
    expect(
      uniqueScratchPrefixes('const t = join(import.meta.dir, ".inline-");'),
      "a FIXED inline root reached the deletion allowlist",
    ).toEqual([]);
  });

  test("the scan reads real files, so the live check is not vacuous", () => {
    // The four suites still declare scratch roots; if they ever stop, the
    // live test passes by having nothing to look at.
    const withScratch = readdirSync(TEST_DIR)
      .filter(f => f.endsWith(".ts"))
      .filter(f => /mkdtempSync\s*\(\s*join\(/.test(readFileSync(join(TEST_DIR, f), "utf-8")));
    expect(
      withScratch.length,
      "no suite declares an mkdtemp scratch root — the live check has no subject",
    ).toBeGreaterThanOrEqual(4);
  });
});
