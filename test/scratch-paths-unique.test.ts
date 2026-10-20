import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";
import { fixedScratchRoots, uniqueScratchPrefixes } from "../lib/scratch-roots";
import { scratchPrefixes } from "../lib/scratch-cleanup";

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

describe("#323 SC-6: no suite plants its fixtures at a path another run shares", () => {
  test("every in-repo scratch root in test/ is unique per run", () => {
    const violations: string[] = [];
    for (const f of readdirSync(TEST_DIR).filter(f => f.endsWith(".ts"))) {
      if (f === SELF) continue; // see the case below, which checks this is safe
      for (const hit of fixedScratchRoots(readFileSync(join(TEST_DIR, f), "utf-8"))) {
        violations.push(
          `test/${f} — ${hit} is a fixed path; wrap it in mkdtempSync(join(ROOT, "<prefix>-")) ` +
            `so two concurrent runs cannot delete each other's fixtures (#323 SC-6)`,
        );
      }
    }
    expect(violations, `shared scratch roots:\n${violations.join("\n")}`).toEqual([]);
    // 60s, because this reads every .ts in test/ and the cost grows with the
    // tree rather than with anything this case is about. Measured 2026-10-20:
    // 3.48s over 378 files locally, and 5600ms on a CI shard — past the 5000ms
    // bunfig default, which DECLARES the budget rather than setting one here.
    // It went red on a PR that added one unrelated test file. The scan cost
    // itself is #793; this stops an unrelated author paying for it.
  }, 60_000);

  test("skipping this file is safe, because it creates nothing", () => {
    // The exemption, checked. If someone later adds a real scratch directory
    // here, the skip above would hide it — so the skip is conditional on this
    // file having no filesystem writes at all, which is true of a pure
    // source-analysis guard and stops being true the moment it is not.
    // Checked on the IMPORT LIST, not by counting call-shaped text. The
    // fixtures below contain `mkdtempSync(` and `rmSync(` as string data, and
    // a source-text count reads them as calls — the self-reference trap one
    // level further in. What the file imports cannot be faked by its fixtures.
    const self = stripJsComments(readFileSync(join(TEST_DIR, SELF), "utf-8"));
    const fsImport = /import\s*\{([^}]*)\}\s*from\s*"fs";/.exec(self);
    expect(fsImport, "this file no longer imports from fs in the expected form").not.toBeNull();
    const imported = (fsImport?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const WRITES = ["mkdirSync", "mkdtempSync", "writeFileSync", "rmSync", "rmdirSync", "cpSync", "renameSync"];
    const writes = imported.filter(n => WRITES.includes(n));
    expect(
      writes,
      `this file imports ${writes.join(", ")} from fs, so it can create a ` +
        `scratch root that the exclusion above would hide — either drop the ` +
        `exclusion or move the writes out`,
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
