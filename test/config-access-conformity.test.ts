/**
 * The two config-access checks ADR-001 specified and never shipped (#309).
 *
 * Covers SC-1427, SC-1428, SC-1429, SC-1430, SC-1431 (HARNESS-STANDARD.md).
 *
 * ADR-001 decided the single-loader policy on 2026-10-05 and named the
 * enforcement: a conformity check that FAILS the suite, not a lint rule and
 * not convention. It explained why convention would not work, citing the 24
 * violations that accumulated after the same policy was stated in prose on
 * 2026-10-02. `runConfigAccessValidation` was never built, and six days later
 * the count had roughly tripled. ADR-001 became an instance of the defect
 * class it describes.
 *
 * ## Why this file exists beside the conformity suite
 *
 * The suite is the enforcement; this is where the collector is proven able to
 * fail. Measured, and it is the reason this file exists rather than a note in
 * the PR: short-circuiting `configAccessViolations` to `return []` scored
 * **ZERO** against the conformity suite alone. The tree sits AT its ratchet,
 * so the real collector also returns `[]`, and the two are indistinguishable
 * on a green tree. Every refusal case below drives a PLANTED scan.
 *
 * That is ADR-002 D4's own warning turned on the check: "a conformity check
 * that silently scans zero files reports zero violations and is
 * indistinguishable from compliance."
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  configAccessViolations,
  readConfigAccessRatchet,
  scanConfigAccess,
  projectSourceEvidence,
  scanPromptConfigAccess,
  unmeasuredScanReason,
  type ConfigAccessScan,
} from "../lib/conformity";
import { isTypeScriptProject } from "../lib/typescript-project";

const REPO = join(import.meta.dir, "..");
const CONFORMITY = join(REPO, "lib", "conformity.ts");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scan with the bookkeeping filled in, so cases say only what they vary. */
const scan = (counts: Record<string, number>, files = 50, bytes = 100_000): ConfigAccessScan => ({
  counts,
  filesScanned: files,
  bytesScanned: bytes,
});

describe("SC-1427: the collector refuses, and can be made to", () => {
  test("a file over its banked number is refused by name", () => {
    const out = configAccessViolations(scan({ "lib/x.ts": 3 }), { "lib/x.ts": 2 }, "CONFIG-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("lib/x.ts");
    expect(out[0]).toContain("3 direct config access site(s), 2 allowed");
    expect(out[0], "the refusal does not say what to do instead").toContain("loadRungateConfig");
  });

  test("a file NOT on the ratchet is allowed nothing", () => {
    // ADR-002 D4: the ratchet "refuses on any new file entering the violation
    // set even while the count is above zero". The migration window is
    // exactly when the next reader is most likely to be written, and a
    // count-only ratchet would permit it for the whole duration.
    const out = configAccessViolations(scan({ "lib/new.ts": 1 }), { "lib/old.ts": 9 }, "CONFIG-1");
    expect(out.join("\n")).toContain("lib/new.ts");
    expect(out.join("\n")).toContain("0 allowed");
  });

  test("a file AT its banked number is allowed", () => {
    // The positive control. A collector that refused everything would satisfy
    // both cases above and fail the whole suite on day one.
    expect(configAccessViolations(scan({ "lib/x.ts": 2 }), { "lib/x.ts": 2 }, "CONFIG-1")).toEqual([]);
  });

  test("the ratchet refuses in BOTH directions", () => {
    // An entry that has stopped being a violation is an entry nobody will
    // ever remove, and the list rots into one more artefact that certifies
    // nothing. Under its number, and gone entirely, both refuse.
    const under = configAccessViolations(scan({ "lib/x.ts": 1 }), { "lib/x.ts": 2 }, "CONFIG-1");
    expect(under).toHaveLength(1);
    expect(under[0]).toContain("banked at 2 but only 1 remain");

    const gone = configAccessViolations(scan({}), { "lib/x.ts": 2 }, "CONFIG-1");
    expect(gone).toHaveLength(1);
    expect(gone[0]).toContain("has no violations left");
  });
});

describe("SC-1428: a scan that read nothing refuses rather than reporting clean", () => {
  test("zero files scanned is a refusal", () => {
    // ADR-002 D4 mutation 5, and the one it says matters most: a check that
    // silently scans zero files reports zero violations and is
    // indistinguishable from compliance. That is this repo's defining defect
    // and would be the most embarrassing possible place to reproduce it.
    const out = configAccessViolations(scan({}, 0, 0), {}, "CONFIG-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("read NO files");
  });

  test("files walked but nothing read is also a refusal", () => {
    const out = configAccessViolations(scan({}, 12, 0), {}, "CONFIG-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("none had any content");
  });

  test("the emptiness check can be waived, and only deliberately", () => {
    // CHECK-2 waives it for a project with no `workflows/` directory, which
    // is not in violation. The waiver is a parameter rather than a special
    // case inside the collector, so the one site stays mutable.
    expect(configAccessViolations(scan({}, 0, 0), {}, "CONFIG-2", false)).toEqual([]);
  });

  test("a non-empty scan with no violations is clean", () => {
    expect(configAccessViolations(scan({}), {}, "CONFIG-1")).toEqual([]);
  });
});

describe("SC-1429: the scanners read code, and enough of it", () => {
  test("CHECK-1 walks a substantial corpus, so finding nothing would mean something", () => {
    const got = scanConfigAccess(REPO);
    expect(got.filesScanned, "the walk found no source at all").toBeGreaterThan(100);
    expect(got.bytesScanned).toBeGreaterThan(500_000);
  });

  test("CHECK-2 sees inside prompt text, which is what ADR-001's check could not", () => {
    // The eleven sites ADR-001's TypeScript-source scan missed all live
    // inside template literals handed to agents. A scanner that blanked
    // literals would report zero here and look like success.
    const got = scanPromptConfigAccess(REPO);
    expect(got.filesScanned, "no workflows were read").toBeGreaterThan(0);
    expect(
      Object.keys(got.counts),
      "no workflow config access found — either it is all migrated (lower the ratchet) or the scan is blind to prompts",
    ).toContain("workflows/ship.js");
  });

  test("comments are not counted as access", () => {
    // Prose that DISCUSSES the config is not a read, and counting it buries
    // the real sites until the ratchet becomes a number nobody reads. The
    // stripping is `stripJsComments`, which is offset-preserving and has its
    // own suite — not a line rule invented here.
    const got = scanConfigAccess(REPO);
    expect(
      got.counts["lib/conformity.ts"] ?? 0,
      "the check counts its own prose, or its own migrated reads came back",
    ).toBe(0);
  });
});

describe("SC-1430: the check does not match its own source", () => {
  test("lib/conformity.ts reports zero against itself", () => {
    // The self-reference trap, which this repo has hit three times. The file
    // hosting the check is inside the scanned set and contains the literals
    // it searches for. The pattern is assembled from fragments that never
    // appear adjacent here, and the three real violations this file used to
    // carry are migrated to the loader in the same change — so the zero is a
    // fact, not an exemption.
    //
    // An allowlist naming the exempt files becomes evidence those files are
    // referenced. `lib/conformity.ts` is NOT on the allowlist, and this
    // asserts it.
    const src = readFileSync(join(REPO, "lib", "conformity.ts"), "utf-8");
    expect(src, "conformity.ts allowlisted itself instead of migrating").not.toContain(
      'CONFIG_LOADER = "lib/conformity.ts"',
    );
    expect(scanConfigAccess(REPO).counts["lib/conformity.ts"]).toBeUndefined();
  });

  test("the loader IS the allowlist, and it is a real file with real reads", () => {
    // The allowlist has to be consulted for the case above to mean anything.
    // Removing `lib/config-loader.ts` from it must change the answer, which
    // requires that the file actually contain accesses.
    const src = readFileSync(join(REPO, "lib", "config-loader.ts"), "utf-8");
    const { stripJsComments } = require("../lib/strip-js-comments");
    const hits = stripJsComments(src).match(/\.claude["'`/\\,\s)]+\s*["'`]?rungate/g) || [];
    expect(hits.length, "the allowlisted file has no reads, so the allowlist is untested")
      .toBeGreaterThan(0);
  });
});

describe("SC-1431: the ratchet is data, scoped per check", () => {
  test("rungate's ratchet is present and non-trivial", () => {
    // #415: this read `> 10` and was a floor under a number whose whole job is
    // to fall. Nineteen sites left the ratchet in one change because they were
    // never reads, and a test pinned to the size the file happened to have
    // would have been the thing blocking that — "a check that passed because
    // of what it never looked at", pointed at progress instead of regression.
    //
    // What the assertion was actually for is that the file LOADED: an absent
    // or unparseable ratchet yields `{}`, which reads as zero tolerance and
    // would make every banked site fail at once. So assert loaded, and
    // non-empty, and leave the magnitude to the both-ways check below.
    const all = readConfigAccessRatchet(REPO);
    expect(Object.keys(all).length, "the ratchet file is missing or empty").toBeGreaterThan(0);
    expect(
      Object.values(all).every(n => typeof n === "number" && n > 0),
      "a banked entry at zero is an entry nobody will remove — delete it instead",
    ).toBe(true);
  });

  test("the two checks read disjoint halves of one file", () => {
    // One file, two checks. Scoping matters because the both-ways ratchet
    // complains about a banked entry with no violations left, and CHECK-1
    // never scans `workflows/` — unscoped, it would demand the removal of
    // every entry CHECK-2 owns, and vice versa.
    const sources = readConfigAccessRatchet(REPO, "sources");
    const workflows = readConfigAccessRatchet(REPO, "workflows");
    expect(Object.keys(sources).some(k => k.startsWith("workflows/"))).toBe(false);
    expect(Object.keys(workflows).every(k => k.startsWith("workflows/"))).toBe(true);
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    expect(
      Object.keys(sources).length + Object.keys(workflows).length,
      "scoping dropped or duplicated entries",
    ).toBe(Object.keys(readConfigAccessRatchet(REPO)).length);
  });

  test("a project with no ratchet file gets zero tolerance", () => {
    // `lib/conformity.ts` travels into every scaffolded project, and
    // rungate's numbers have no business there. Absent file -> {} -> any
    // violation fails, which is right for a tree that never had the defect.
    expect(readConfigAccessRatchet("/nonexistent-root-for-config-ratchet")).toEqual({});
  });

  test("the tree is exactly at its ratchet, in both directions", () => {
    // The whole point of banking: this goes red if a site is added AND if one
    // is removed without lowering the number.
    expect(
      configAccessViolations(scanConfigAccess(REPO), readConfigAccessRatchet(REPO, "sources"), "CONFIG-1"),
    ).toEqual([]);
    expect(
      configAccessViolations(
        scanPromptConfigAccess(REPO),
        readConfigAccessRatchet(REPO, "workflows"),
        "CONFIG-2",
      ),
    ).toEqual([]);
  });

  // Dash, not a comma: SC-1431 quotes this title verbatim and the conformity
  // parser splits an SC's token list on commas. Third time today.
  test("both checks are registered by the GENERATOR - not hand-added", () => {
    // test/scaffold-conformity.test.ts is harness-managed: editing it
    // directly is reverted by the next re-scaffold, and the check would
    // silently stop running in every consumer project.
    const gen = readFileSync(join(REPO, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(gen).toContain("runConfigAccessValidation(ROOT);");
    expect(gen).toContain("runPromptConfigAccessValidation(ROOT);");
    const suite = readFileSync(join(REPO, "test", "scaffold-conformity.test.ts"), "utf-8");
    expect(suite).toContain("runConfigAccessValidation(ROOT);");
    expect(suite).toContain("runPromptConfigAccessValidation(ROOT);");
  });
});

/**
 * #476: a scan that read nothing is two different situations, and the refusal
 * alone cannot tell them apart.
 *
 * `--profile=minimal` (#449) lets a project take rungate's structure without
 * the ship harness. The first consumer to use it ships a skill, a spec and two
 * reference files and has no TypeScript at all, so CONFIG-1's empty-scan
 * refusal fired over a check it could only satisfy by adding source it does
 * not want: 21 pass, 1 fail, unsatisfiable.
 *
 * The fix must not be a blanket waiver. Three cases, and two of them are the
 * ones a careless fix breaks — case 2 goes red if this is implemented as a
 * `--type content` exemption, case 3 goes red if the refusal is deleted.
 *
 * What was broken to prove it, run and counted rather than asserted, over
 * `test/config-access-conformity.test.ts` (25 tests):
 *
 * ## The second pass (security review of the merged commit)
 *
 * A review of `0362a59f` found the fix both wrong and untested, and both
 * halves were reproduced here before being fixed:
 *
 * - Five layouts carrying a real direct config read flipped FAIL -> green:
 *   `lib/loader.mjs`, `lib/loader.cjs`, `src/app.js`, `bin/cli.ts` and a
 *   root-level `index.ts`. The waiver asked `isTypeScriptProject` (`.tsx?`
 *   under TS_SOURCE_DIRS) while the scan reads `.ts` AND `.js` under a
 *   different list, so wherever the scan's reach exceeded the predicate's a
 *   blind check reported clean.
 * - Deleting the entire `if (unmeasured) { addFinding(...); return; }` block
 *   — #476 reintroduced outright — was **0 red over 9,652 tests**, because
 *   every case ran through a helper that reimplemented the composition. The
 *   guard written against that exact risk counted call sites, which the
 *   mutation leaves intact: it deletes the consumer, not the call.
 *
 * `projectSourceEvidence` replaces the predicate and cannot have the first
 * defect by construction — it answers over every code extension in the whole
 * tree, so it can never be narrower than a scanner's filter. `config1` no
 * longer composes anything: it spawns a suite that runs the real
 * `runConfigAccessValidation` and reads `getFindings()`.
 *
 * | Mutation (second pass) | Red | Was |
 * |---|---|---|
 * | the whole UNMEASURED block deleted from CONFIG-1 | 1 | **0** |
 * | only the `addFinding` deleted, leaving a silent return | 1 | **0** |
 * | `SOURCE_EXTENSIONS` narrowed back to `.tsx?` | 1 | — |
 * | the `unreadable` guard removed | 1 | — |
 * | the `found` guard removed — the fail-open itself | 4 | — |
 *
 * | Mutation (first pass) | Red | Predicted |
 * |---|---|---|
 * | `unmeasuredScanReason` short-circuited to `return null` — #476 restored | 3 | 3 |
 * | short-circuited to always return the reason — the blanket waiver | 5 | 4 |
 * | the `sourcesPresent` guard removed — every empty scan waived | 3 | 3 |
 * | the `filesScanned` guard removed — the answer stops depending on the scan | 2 | 2 |
 * | CONFIG-2's call site reverted to `requireNonEmpty = scan.filesScanned > 0` | 1 | 1 |
 *
 * None is left in the tree; all were run and reverted.
 *
 * The one row that missed is a counting slip and not a finding: case 4 was
 * written after the prediction table and never added to that row. Its failure
 * is for its own reason — a `.js` project is invisible to the TypeScript
 * predicate and must still be measured — and the five reds are five distinct
 * questions, which is what the row is for.
 */
/**
 * A throwaway project tree, shared by every case below.
 *
 * Module scope rather than per-`describe`, so the two blocks cannot drift
 * into disagreeing about what a project or a config read looks like.
 */
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "rungate-476-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
};

/** One direct config read, in the syntax `classifyConfigSites` calls a use. */
const READS_CONFIG = [
  'import { join } from "path";',
  'export const p = join(process.cwd(), ".claude", "rungate.json");',
].join("\n");

describe("#476: an empty scan is UNMEASURED or a refusal, and which one is decided", () => {
  /**
   * CONFIG-1 by RUNNING IT — `runConfigAccessValidation` in a spawned suite,
   * reading the findings it actually recorded.
   *
   * The first version of this helper reimplemented the composition, and a
   * security review showed what that bought: deleting the entire
   * `if (unmeasured) { addFinding(...); return; }` block from the production
   * check — #476 reintroduced outright — was **0 red over 9,652 tests**.
   * Every case here passed because every case was exercising the helper. The
   * file's own guard named that exact risk and then counted
   * `unmeasuredScanReason(` call sites, which the mutation leaves untouched
   * because it deletes the CONSUMER and not the call.
   *
   * So the composition is no longer written here at all. The pattern is
   * `test/typescript-project.test.ts`'s `runTsc1`: a generated suite imports
   * the real validator, runs it against a planted project and prints what
   * `getFindings()` holds, because findings are recorded while the suite runs
   * and can only be read from a test declared after it.
   */
  const config1 = (root: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "rungate-476-run-")), "probe.test.ts");
    scratch.push(dirname(file));
    writeFileSync(
      file,
      `import { test } from "bun:test";\n` +
        `import { runConfigAccessValidation, getFindings, clearFindings } from ${JSON.stringify(CONFORMITY)};\n` +
        `clearFindings();\n` +
        `runConfigAccessValidation(${JSON.stringify(root)});\n` +
        `test("zz-report", () => {\n` +
        `  console.log("F:" + JSON.stringify(getFindings().filter(f => f.ruleId === "CONFIG-1")));\n` +
        `});\n`,
    );
    const r = spawnSync("bun", ["test", file], { cwd: REPO, encoding: "utf-8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const findings = JSON.parse(out.match(/F:(\[.*\])/)?.[1] ?? "null") as
      | Array<{ severity: string; message: string }>
      | null;
    if (findings === null) throw new Error(`the probe suite never reported findings:\n${out}`);
    const warns = findings.filter(f => f.severity === "WARN");
    const fails = findings.filter(f => f.severity === "FAIL");
    return {
      /** The UNMEASURED message CONFIG-1 recorded, or null if it recorded none. */
      unmeasured: warns.length > 0 ? warns.map(f => f.message).join("\n") : null,
      /** The FAIL findings CONFIG-1 recorded — its violations, as it reported them. */
      violations: fails.map(f => f.message),
      /** Did the check itself pass? A refusal fails the spawned suite. */
      red: /\b[1-9]\d* fail/.test(out),
    };
  };

  test("case 1: a content project with no TypeScript reports UNMEASURED, not a pass", () => {
    const root = project({
      "README.md": "# docs",
      "skills/pov/SKILL.md": "---\nname: pov\n---\n",
      "specs/SPEC.md": "# spec",
    });
    const got = config1(root);
    expect(got.red, "a content project failed the suite").toBe(false);
    expect(got.violations, "a content project is not in violation").toEqual([]);
    expect(got.unmeasured, "silence is indistinguishable from a pass").not.toBeNull();
    expect(got.unmeasured).toContain("UNMEASURED");
    expect(got.unmeasured, "the skip does not say what it skipped over").toContain(
      "TypeScript or JavaScript in lib/",
    );
    expect(got.unmeasured, "the skip does not say the whole tree was checked").toContain(
      "no source files of any kind were found anywhere",
    );
    rmSync(root, { recursive: true, force: true });
  });

  test("case 2: a content project that DOES carry TypeScript is still checked", () => {
    // The case a `--type content` exemption breaks. One markdown-heavy project
    // with a single source file that reads the config directly: a waiver keyed
    // on project type reports this clean.
    const root = project({
      "README.md": "# docs",
      "specs/SPEC.md": "# spec",
      "lib/loader.ts": READS_CONFIG,
    });
    const got = config1(root);
    expect(got.unmeasured, "a project with TypeScript was skipped").toBeNull();
    expect(got.violations.join("\n")).toContain("lib/loader.ts");
    expect(got.violations.join("\n")).toContain("direct config access site(s), 0 allowed");
    rmSync(root, { recursive: true, force: true });
  });

  test("case 3: a project with TypeScript the walk never reached still REFUSES", () => {
    // The case deleting the refusal breaks. `src/` is a TypeScript source
    // directory and is NOT one of CONFIG_SCAN_DIRS, so the walk comes back
    // empty over a project that is full of TypeScript. The scan read nothing
    // and there WAS something to read, which is what the refusal is for.
    const root = project({ "src/index.ts": READS_CONFIG });
    const got = config1(root);
    expect(got.unmeasured, "an unreached source tree was waived as absent").toBeNull();
    expect(got.violations).toHaveLength(1);
    expect(got.violations[0]).toContain("read NO files");
    rmSync(root, { recursive: true, force: true });
  });

  test("case 4: a JavaScript project the TypeScript predicate cannot see is still checked", () => {
    // `isTypeScriptProject` is false here and the check still measures, because
    // the scan reads `.js` too and it came back non-empty. Asking "was there
    // anything to read" INSTEAD of "did I read anything" would waive a hook
    // that reaches the config directly.
    const root = project({ "hooks/notify.js": READS_CONFIG });
    expect(isTypeScriptProject(root), "the fixture must be invisible to the predicate").toBe(false);
    const got = config1(root);
    expect(got.unmeasured, "a scan that read a file was reported as unmeasured").toBeNull();
    expect(got.violations.join("\n")).toContain("hooks/notify.js");
    rmSync(root, { recursive: true, force: true });
  });

  const noCode = { found: false, examples: [], unreadable: [] };
  const hasCode = { found: true, examples: ["lib/x.ts"], unreadable: [] };

  test("the two questions are separate, and the binding needs both answers", () => {
    // `filesScanned` answers "did I read anything"; `sourcesPresent` answers
    // "was there anything to read". One decider asked twice could not produce
    // the middle row, which is the whole of this issue.
    expect(unmeasuredScanReason(scan({}, 0, 0), noCode, "CONFIG-1", "x")).toContain("UNMEASURED");
    expect(unmeasuredScanReason(scan({}, 0, 0), hasCode, "CONFIG-1", "x")).toBeNull();
    expect(unmeasuredScanReason(scan({}, 9, 100), noCode, "CONFIG-1", "x")).toBeNull();
    expect(unmeasuredScanReason(scan({}, 9, 100), hasCode, "CONFIG-1", "x")).toBeNull();
  });

  test("CONFIG-2's waiver is reachable, which `filesScanned > 0` never was", () => {
    // The previous waiver read `requireNonEmpty = scan.filesScanned > 0`,
    // evaluated at the one place `filesScanned === 0` is the whole question.
    // It required a non-empty scan only when the scan was already non-empty,
    // so CONFIG-2's empty-scan refusal had never once been able to fire.
    const empty = scan({}, 0, 0);
    expect(
      configAccessViolations(empty, {}, "CONFIG-2", empty.filesScanned > 0),
      "the old waiver should be provably vacuous",
    ).toEqual([]);

    // The replacement distinguishes. A project with no workflows/ is waived;
    // one that has the directory and read nothing out of it refuses.
    const root = project({ "README.md": "# docs" });
    expect(
      unmeasuredScanReason(scanPromptConfigAccess(root), { found: existsSync(join(root, "workflows")), examples: [], unreadable: [] }, "CONFIG-2", "workflows/ directory"),
    ).toContain("UNMEASURED");

    mkdirSync(join(root, "workflows"), { recursive: true });
    const withDir = scanPromptConfigAccess(root);
    expect(
      unmeasuredScanReason(withDir, { found: existsSync(join(root, "workflows")), examples: [], unreadable: [] }, "CONFIG-2", "workflows/ directory"),
      "an empty workflows/ directory was waived",
    ).toBeNull();
    expect(configAccessViolations(withDir, {}, "CONFIG-2")[0]).toContain("read NO files");
    rmSync(root, { recursive: true, force: true });
  });

  test("F1: an extension the scan reads but the old predicate could not see", () => {
    // Five layouts a security review found flipping FAIL -> green. The old
    // waiver asked `isTypeScriptProject`, which matches `.tsx?` under
    // TS_SOURCE_DIRS, while the scan reads `.ts` AND `.js` under a different
    // list. `lib/loader.mjs` is the sharpest: it is in the FIRST directory
    // CONFIG-1 walks, and the waiver told the consumer the project had no
    // TypeScript. True sentence, wrong inference.
    for (const rel of ["lib/loader.mjs", "lib/loader.cjs", "src/app.js", "bin/cli.ts", "index.ts"]) {
      const root = project({ [rel]: READS_CONFIG });
      const got = config1(root);
      expect(got.unmeasured, `${rel}: a project full of code was waived as having none`).toBeNull();
      expect(got.red, `${rel}: a blind check reported clean`).toBe(true);
    }
  });

  test("F5: a directory the walk could not READ is not a directory with no code", () => {
    // Both walks swallowed readdirSync errors. Harmless before the waiver
    // existed — a failed walk left filesScanned at zero and the refusal
    // fired. With a waiver reading the same silence, two fail-opens point
    // the same way and a chmod turns a FAIL into a green run.
    const root = project({ "lib/reader.ts": READS_CONFIG });
    expect(projectSourceEvidence(root).found, "the fixture has no code in it").toBe(true);
    chmodSync(join(root, "lib"), 0o000);
    try {
      const ev = projectSourceEvidence(root);
      // Some environments (root, certain CI sandboxes) ignore the mode. Only
      // assert when the chmod actually took, so this cannot pass vacuously.
      if (ev.unreadable.length > 0) {
        expect(ev.found, "an unreadable tree reported code it never saw").toBe(false);
        expect(
          unmeasuredScanReason(scan({}, 0, 0), ev, "CONFIG-1", "x"),
          "a walk that could not look was waived as a walk that found nothing",
        ).toBeNull();
      } else {
        expect(ev.found, "the chmod did not take, so the tree is still readable").toBe(true);
      }
    } finally {
      chmodSync(join(root, "lib"), 0o755);
    }
  });

  test("F6: a symlinked source directory is followed, and a cycle terminates", () => {
    // `packages/core` behind `lib/impl` is an ordinary monorepo shape, and
    // `withFileTypes` reports a symlink as not-a-directory, so a predicate
    // that does not stat it waives a project full of code.
    const root = project({ "packages/core/reader.ts": READS_CONFIG });
    symlinkSync(join(root, "packages", "core"), join(root, "lib-impl"), "dir");
    const ev = projectSourceEvidence(root);
    expect(ev.found, "a symlinked source directory was invisible").toBe(true);

    // A cycle must terminate rather than hang. `realpathSync` keys the
    // visited set, so the second arrival at the same inode stops.
    const looped = project({ "a/x.ts": "export const x = 1;" });
    symlinkSync(join(looped, "a"), join(looped, "a", "self"), "dir");
    expect(projectSourceEvidence(looped).found).toBe(true);
  });

  test("the predicate is WIDER than any scanner, which is the property that matters", () => {
    // The old defect was a predicate narrower than the scan. This asserts
    // the direction rather than a list, so widening a scanner later cannot
    // reopen the hole: anything `scanConfigAccess` reads, the evidence walk
    // must also have seen.
    const root = project({
      "lib/a.ts": "export const a = 1;",
      "gates/b.js": "export const b = 1;",
      "scripts/c.ts": "export const c = 1;",
      "hooks/d.js": "export const d = 1;",
      "generators/e.ts": "export const e = 1;",
    });
    expect(scanConfigAccess(root).filesScanned).toBe(5);
    expect(projectSourceEvidence(root).found).toBe(true);

    // ...and the one direction that must still waive: no code at all.
    const content = project({ "README.md": "# docs", "specs/S.md": "# s", "data.json": "{}" });
    expect(scanConfigAccess(content).filesScanned).toBe(0);
    expect(projectSourceEvidence(content).found, "a content project reported code").toBe(false);
    expect(projectSourceEvidence(content).unreadable).toEqual([]);
  });

  test("both checks route their empty scan through the one binding", () => {
    // A test helper that composes the decision itself is a second decider, and
    // it would keep passing after the production site stopped calling this.
    const src = readFileSync(join(REPO, "lib", "conformity.ts"), "utf-8");
    const calls = src.match(/unmeasuredScanReason\(/g) || [];
    expect(calls, "CONFIG-1, CONFIG-2 and the declaration").toHaveLength(3);
    expect(src).toContain('projectSourceEvidence(root);');
    expect(src).toContain('existsSync(join(root, "workflows")),');
    // And neither still passes the vacuous waiver.
    expect(src.replace(/\s+/g, " ")).not.toMatch(/unmeasuredScanReason\([^)]*scan\.filesScanned > 0/);
  });
});

/**
 * The evidence walk must agree with the scan about what source IS (#500 review).
 *
 * `projectSourceEvidence` answers "should the scan have found something?" So
 * a file the scan would never read is not an answer to that question, and
 * every case below is one where the first draft said it was.
 *
 * The blocker, found by running the real CLI rather than reasoning about it:
 * the scaffold writes `tests/scaffold-conformity.test.ts`, which on a
 * `--profile=minimal` content project is the ONLY code-extension file in the
 * tree. The walk saw it, reported source present, and CONFIG-1 refused with
 * "the scan read NO files" — on every scaffolded content project, with no way
 * out but adding source the project does not want or deleting the suite.
 * **The file that made the evidence true was the generated suite running the
 * check.** #476's own complaint, arriving through the fix for the fix.
 *
 * Mutation counts for this block are recorded in the #476 docstring above.
 */
describe("#500 review: the walk is not wider than the question it answers", () => {
  const content = (extra: Record<string, string> = {}) =>
    project({ "README.md": "# docs", "docs/a.md": "# a", ...extra });

  /** The waiver decision, composed exactly as `runConfigAccessValidation` does. */
  const waived = (root: string): boolean =>
    unmeasuredScanReason(
      scanConfigAccess(root),
      projectSourceEvidence(root),
      "CONFIG-1",
      "hand-written TypeScript",
    ) !== null;

  test("B1: the scaffold's OWN generated suite does not make CONFIG-1 red", () => {
    // The blocker. Named with the path the generator actually writes, and the
    // next case holds that name to the generator so this fixture cannot
    // quietly stop describing reality.
    const root = content({ "tests/scaffold-conformity.test.ts": "import { x } from 'y';\n" });
    expect(projectSourceEvidence(root).found, "the generated suite counted as project source")
      .toBe(false);
    expect(waived(root), "every scaffolded content project is CONFIG-1 red").toBe(true);
  });

  test("B1: the fixture above is the path the scaffold really writes", () => {
    // Without this, B1 is a test about a string I chose. The conformity suite
    // is written to `test/` or `tests/` depending on which the project has;
    // both are excluded, and both are asserted so a rename cannot silently
    // reopen the blocker.
    const src = readFileSync(join(REPO, "lib", "scaffold", "steps.ts"), "utf-8");
    expect(src, "the generated suite is no longer named scaffold-conformity.test.ts")
      .toContain("scaffold-conformity.test.ts");
    for (const dir of ["test", "tests"]) {
      const root = content({ [`${dir}/scaffold-conformity.test.ts`]: "export const a = 1;\n" });
      expect(projectSourceEvidence(root).found, `${dir}/ was treated as project source`).toBe(false);
    }
  });

  test("the TEST_DIRS decider, on an input only it reaches", () => {
    // `tests/scaffold-conformity.test.ts` is caught by BOTH the directory
    // exclusion and the filename exclusion, so removing either left the other
    // holding B1 up and each mutation was 0 red — two deciders that agree,
    // the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`,
    // found by the count coming back 1 where 3 was predicted.
    //
    // This is the directory decider's own input: a helper inside a test
    // directory whose NAME is not a test file.
    const root = content({ "tests/helpers/setup.ts": "export const s = 1;\n" });
    expect(projectSourceEvidence(root).found, "a test helper counted as project source")
      .toBe(false);
  });

  test("the test-FILE decider, on an input only it reaches", () => {
    // And the filename decider's own: a test file that is not in a test
    // directory. Co-located tests are ordinary in `src/`, and neither
    // exclusion covers both of these cases.
    const root = content({ "src/app.test.ts": "import { test } from 'bun:test';\n" });
    expect(projectSourceEvidence(root).found, "a co-located test counted as project source")
      .toBe(false);
  });

  test("B2: tooling in dot-directories is not the project's source", () => {
    // `containsTypeScript` skipped every entry starting with "." and this walk
    // replaced it. Dropping that was a silent widening: a release script is
    // not source, and a content project that has one is still unmeasurable.
    for (const f of [".eslintrc.js", "prettier.config.js", ".github/scripts/release.js", ".husky/pre-commit.js"]) {
      const root = content({ [f]: "module.exports = {};\n" });
      expect(waived(root), `${f} turned a content project CONFIG-1 red`).toBe(true);
    }
  });

  test("B3: a DANGLING symlink is empty, not unmeasured", () => {
    // `unreadable` exists for source that might be hiding behind something we
    // could not open. A link resolving to nothing cannot hide anything, and
    // counting it meant one broken link refused CONFIG-1 for the life of the
    // project.
    const root = content();
    symlinkSync("/nonexistent/target", join(root, "docs", "dangling"));
    const ev = projectSourceEvidence(root);
    expect(ev.unreadable, "a dangling symlink was recorded as unmeasured").toEqual([]);
    expect(waived(root)).toBe(true);
  });

  test("B3: a directory that cannot be opened IS still unmeasured", () => {
    // The control for the case above, and the reason it is narrowed rather
    // than deleted. Real source can hide behind a permission error, so that
    // one must still refuse. Skipped as root, which can open anything.
    const root = content();
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "app.ts"), "export const a = 1;\n");
    chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      const ev = projectSourceEvidence(root);
      expect(ev.unreadable, "an unopenable directory was waved through").not.toEqual([]);
      expect(waived(root), "a tree we could not fully read was waived").toBe(false);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("B4: the walk does not leave the project", () => {
    // `found` must not be true because of code that is not in this project.
    // The consequence of the unbounded version is the interesting one: a link
    // to `$HOME` or `/` would walk all of it to decide.
    const outside = mkdtempSync(join(tmpdir(), "rungate-outside-"));
    mkdirSync(join(outside, "deep"), { recursive: true });
    writeFileSync(join(outside, "deep", "stray.js"), "export const x = 1;\n");
    const root = content();
    symlinkSync(outside, join(root, "extlink"));
    const ev = projectSourceEvidence(root);
    expect(ev.examples, "source outside the project was counted as evidence").toEqual([]);
    expect(ev.found).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  test("the positive control: F1's layouts are still refused", () => {
    // Narrowing a detector is the change most likely to buy green with
    // blindness, so every layout the original review confirmed is re-asserted
    // here rather than trusted to the cases above.
    for (const f of ["lib/loader.mjs", "lib/loader.cjs", "src/app.js", "bin/cli.ts", "index.ts"]) {
      const root = content({ [f]: READS_CONFIG });
      expect(waived(root), `${f} is real source and was waived`).toBe(false);
    }
  });

  test("the refusal NAMES the source that caused it", () => {
    // `SourceEvidence.examples` was computed and read by nothing — its own
    // docstring promised "so a refusal can name what went unscanned" and that
    // was unimplemented. A consumer hitting this got "the scan read NO files"
    // on a project they believe has no code, with no pointer to the file
    // responsible. That is the difference between a two-minute fix and an
    // undiagnosable red, and it is why this residual case is shippable.
    const root = content({ "docs/assets/search.js": "var x = 1;\n" });
    const ev = projectSourceEvidence(root);
    const [refusal] = configAccessViolations(scanConfigAccess(root), {}, "CONFIG-1", true, ev);
    expect(refusal, "the refusal does not name the file that caused it")
      .toContain("docs/assets/search.js");
    expect(refusal, "the refusal does not say the check is blind rather than clean")
      .toContain("blind rather than satisfied");
  });

  test("the other control: a pure content project is still waived", () => {
    // Without this, a walk that found nothing anywhere would satisfy every
    // case above and CONFIG-1 would waive every project in existence.
    expect(waived(content())).toBe(true);
    expect(projectSourceEvidence(content()).found).toBe(false);
  });
});
