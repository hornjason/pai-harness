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
    // This asserted the literal sentence `no source files of any kind were
    // found anywhere in the tree`, and sec-500's review of #500 is that the
    // walk never established it: it declines build output, dot directories,
    // test directories, test files, root tool configs and `.d.ts`, and said
    // nothing about any of them. For THIS project the old sentence happened
    // to be true — it really is empty — which is precisely why the assertion
    // did not catch the overreach. The intent is preserved (the message must
    // state what it looked at tree-wide, not just in the scan dirs); the
    // claim is narrowed to one the walk can support.
    expect(got.unmeasured, "the skip does not say the whole tree was checked").toContain(
      "found no files of any kind that it counts as source",
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

  const noCode = { found: false, examples: [], unreadable: [], skipped: [] };
  const hasCode = { found: true, examples: ["lib/x.ts"], unreadable: [], skipped: [] };

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
      unmeasuredScanReason(scanPromptConfigAccess(root), { found: existsSync(join(root, "workflows")), examples: [], unreadable: [], skipped: [] }, "CONFIG-2", "workflows/ directory"),
    ).toContain("UNMEASURED");

    mkdirSync(join(root, "workflows"), { recursive: true });
    const withDir = scanPromptConfigAccess(root);
    expect(
      unmeasuredScanReason(withDir, { found: existsSync(join(root, "workflows")), examples: [], unreadable: [], skipped: [] }, "CONFIG-2", "workflows/ directory"),
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

  test("a non-test file in a test directory IS project source", () => {
    // This asserted the opposite until sec-500's review of #500, and the
    // reversal is deliberate rather than a loosening.
    //
    // There were two test-related deciders — a DIRECTORY exclusion and the
    // filename predicate — and `tests/scaffold-conformity.test.ts` (the whole
    // of sec-476's B1) is caught by both, so each mutation was 0 red: the
    // fourth shape. The fix I reached for first was to give each decider an
    // input only it reaches, and this test was the directory one.
    //
    // sec-500 showed the directory decider should not exist at all, by
    // checking rather than arguing: `grep -rnoE '"(test|tests)/..."'
    // lib/scaffold/*.ts` returns exactly one path, which the filename
    // predicate already matches. And the project this test described does
    // not get waived — measured through the whole chain rather than argued
    // from `filesScanned`, which an earlier draft of this comment got
    // wrong. A project whose only source is `tests/helpers/setup.ts` scans
    // zero files AND has `found === true`, so `unmeasuredScanReason`
    // declines to waive it and `configAccessViolations` refuses by name:
    // "This project DOES contain source — tests/helpers/setup.ts — none of
    // it in the directories this check reads, so the check is blind rather
    // than satisfied." That is the correct answer and the exclusion
    // suppressed it into a soft WARN. See the end-to-end case below.
    //
    // So the collapsed pair is resolved by DELETING one decider rather than
    // by feeding it, which is the first of the two options the rubric gives
    // and the one it prefers.
    const root = content({ "tests/helpers/setup.ts": "export const s = 1;\n" });
    expect(projectSourceEvidence(root).found, "a test helper stopped being project source")
      .toBe(true);
  });

  test("dropping the directory skip changes a VERDICT, and in the loud direction", () => {
    // jhorn-dd's objection, which is the right one to make: dropping the
    // skip changes which projects pass, not merely what they are told, and
    // "this is redundant" drawn from one motivating case is exactly the
    // move the #500 row in the rules file is about. So the two populations
    // are measured end to end rather than at `projectSourceEvidence`, and
    // the answer is that the change is from a soft WARN to a hard refusal
    // that names the file. A project whose only source sits where CONFIG-1
    // cannot look IS a blind check, and blind refuses.
    const verdict = (root: string) => {
      const scan = scanConfigAccess(root);
      const e = projectSourceEvidence(root);
      const u = unmeasuredScanReason(scan, e, "CONFIG-1", "ts");
      if (u) return { kind: "WARN" as const, text: u };
      const v = configAccessViolations(scan, {}, "CONFIG-1", true, e);
      return v.length ? { kind: "FAIL" as const, text: v[0] } : { kind: "PASS" as const, text: "" };
    };

    const helper = verdict(content({ "tests/helpers/setup.ts": READS_CONFIG }));
    expect(helper.kind, "a project the check cannot see was waived instead of refused")
      .toBe("FAIL");
    expect(helper.text, "the refusal does not name the source that caused it")
      .toContain("tests/helpers/setup.ts");
    expect(helper.text, "the refusal does not say the check was blind")
      .toContain("blind rather than satisfied");

    // The control, and the direction this must not drift in: B1's own case
    // must still reach the soft waiver, or dropping the skip would have
    // turned every freshly-scaffolded consumer red.
    const scaffolded = verdict(content({ "test/scaffold-conformity.test.ts": "export const s = 1;\n" }));
    expect(scaffolded.kind, "a freshly scaffolded project started failing CONFIG-1")
      .toBe("WARN");
  });

  test("B1 still holds: the scaffold's own test file is not project source", () => {
    // The thing the directory exclusion was added for, asserted against the
    // predicate that actually carries it. Both spellings, because the
    // scaffold has used each.
    for (const f of ["tests/scaffold-conformity.test.ts", "test/scaffold-conformity.test.ts"]) {
      const root = content({ [f]: "export const s = 1;\n" });
      expect(projectSourceEvidence(root).found, `${f} counted as project source — B1 reopened`)
        .toBe(false);
    }
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

/**
 * What the re-review of the fix found (#500, second round).
 *
 * All three are the narrowing itself being wrong, which is the risk the
 * review existed to catch: narrowing a detector is the change most likely to
 * buy green with blindness.
 */
describe("#500 re-review: the narrowing did not take enforcement with it", () => {
  const waived = (root: string): boolean =>
    unmeasuredScanReason(
      scanConfigAccess(root),
      projectSourceEvidence(root),
      "CONFIG-1",
      "hand-written TypeScript",
    ) !== null;

  test("N1: the SCAN still reads test paths under a source directory", () => {
    // The first draft widened `walkSources` to match the evidence walk, and
    // that silently reduced enforcement: five layouts with a real direct
    // config read went from counted violation to silent green. No WARN, no
    // UNMEASURED, no record — a non-empty scan never engages the waiver, so
    // the violation simply stopped being counted.
    //
    // The invariant is ONE-DIRECTIONAL: the evidence walk must not claim
    // source the scan would never read. The scan reading more is harmless.
    // Each case carries a clean `lib/clean.ts` so the scan is non-empty and
    // nothing can pass for the unrelated reason of an empty scan.
    for (const f of [
      "lib/tests/sneaky.ts", "lib/spec/y.ts", "lib/__mocks__/x.ts",
      "lib/sneaky.test.js", "lib/sneaky.spec.ts",
    ]) {
      const root = project({ [f]: READS_CONFIG, "lib/clean.ts": "export const a = 1;\n" });
      const scan = scanConfigAccess(root);
      expect(scan.filesScanned, `${f}: the scan read nothing, so this proves nothing`)
        .toBeGreaterThan(0);
      expect(Object.keys(scan.counts), `${f} stopped being enforced`).toContain(f);
    }
  });

  test("N1: the EVIDENCE walk and the SCAN are still not symmetric", () => {
    // The other half, stated so a later "tidy-up" cannot collapse them into
    // one shared exclusion list and reopen N1. The asymmetry is
    // one-directional: the scan may read MORE than the evidence walk counts,
    // never less.
    //
    // Rewritten with sec-500's reversal: a test HELPER is now counted, so the
    // input that shows the two lists are still distinct is a test FILE, which
    // the scan enforces (see the case above this one) and the walk declines.
    const root = project({ "README.md": "# docs", "lib/sneaky.test.js": READS_CONFIG });
    expect(
      projectSourceEvidence(root).found,
      "a test file counted as evidence — the walk now claims source the scan would skip",
    ).toBe(false);
  });

  test("N2: 'points at nothing' and 'cannot be stat-ed' are different answers", () => {
    // The B3 fix asked `existsSync`, which is false for BOTH, so a symlink
    // into an unreadable directory gave found=false AND unreadable=[] — the
    // code invisible and the walk not recording that it could not look. That
    // is the failure the `unreadable` guard exists to prevent, reintroduced
    // inside the guard. The errno is what separates them.
    if (process.getuid?.() === 0) return;
    const locked = mkdtempSync(join(tmpdir(), "rungate-locked-"));
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "code.ts"), READS_CONFIG);
    chmodSync(locked, 0o000);
    try {
      const root = project({ "README.md": "# docs" });
      symlinkSync(join(locked, "inner"), join(root, "vendored"));
      const ev = projectSourceEvidence(root);
      expect(ev.unreadable, "a link we could not follow was recorded as empty").not.toEqual([]);
      expect(waived(root), "unreadable source was waived as 'no source here'").toBe(false);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test("N3: a symlinked FILE cannot leave the project either", () => {
    // The directory containment check cannot see this case. "The walk cannot
    // leave the project" is either true of both kinds of entry or it is not
    // a property at all.
    const outside = mkdtempSync(join(tmpdir(), "rungate-outside-"));
    writeFileSync(join(outside, "x.ts"), READS_CONFIG);
    const root = project({ "README.md": "# docs" });
    symlinkSync(join(outside, "x.ts"), join(root, "linked.ts"));
    const ev = projectSourceEvidence(root);
    expect(ev.examples, "a file outside the project was counted as evidence").toEqual([]);
    expect(ev.found).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  test("the control: a symlinked file INSIDE the project still counts", () => {
    // Without this, containment that rejected every symlinked file would
    // satisfy N3 and quietly reopen F2/F6, which is the monorepo shape.
    const root = project({ "README.md": "# docs", "packages/core/a.ts": READS_CONFIG });
    symlinkSync(join(root, "packages", "core", "a.ts"), join(root, "lib.ts"));
    expect(projectSourceEvidence(root).found, "an in-project symlink was rejected").toBe(true);
  });
});

/**
 * Covers SC-1428 (HARNESS-STANDARD.md).
 *
 * sec-500's independent review of #500. Its finding is #500's own headline
 * complaint — "true sentence, wrong inference" — committed by #500's own
 * waiver, with the sentence this time actually untrue.
 *
 * The waiver said:
 *
 * > ...this project has no TypeScript or JavaScript in lib/, gates/,
 * > scripts/, hooks/ or generators/, **and no source files of any kind were
 * > found anywhere in the tree.**
 *
 * The second clause is a claim about the whole tree that the walk never
 * established. It declines five classes of entry — build output, dot
 * directories, test directories, test files, root tool configs and `.d.ts`
 * — and said nothing about any of them. sec-500 measured twelve layouts
 * carrying a real direct config read that the waiver called an empty
 * project, three of which (`.github/scripts/release.js`, `tests/helper.ts`,
 * `vite.config.ts`) refused one commit earlier.
 *
 * The fix is a third state, not a wider walk. Most of the skips are
 * correct — a content project with a release script really does have no
 * project source — so the defect is the silence, not the declining. `0`,
 * `{}`, `null` and `SKIP` are indistinguishable from success; a decline
 * nobody records is the same shape.
 */
describe("#500 re-review (sec-500): a decline is recorded, not asserted away", () => {
  const READ = 'const p = join(process.cwd(), ".claude", "rungate.json");\n';

  /** The waiver sentence, verbatim, that the walk could not support. */
  const FALSE_CLAIM = "no source files of any kind were found anywhere in the tree";

  function waiverFor(files: Record<string, string>): string | null {
    const root = project(files);
    const evidence = projectSourceEvidence(root);
    return unmeasuredScanReason(
      scanConfigAccess(root),
      evidence,
      "CONFIG-1",
      "TypeScript or JavaScript",
    );
  }

  test("a dot-directory script is declined BY NAME, not called absent", () => {
    const msg = waiverFor({ ".github/scripts/release.js": READ, "README.md": "# docs" });
    expect(msg, "the project was not waived at all").toContain("UNMEASURED");
    expect(msg, "the walk still claims it looked everywhere").not.toContain(FALSE_CLAIM);
    expect(msg, "the declined entry is not named").toContain(".github");
    expect(msg).toContain("dot-directory");
  });

  test("a TEST FILE is declined BY NAME", () => {
    // Was `tests/helper.ts` and a "test directory" decline. sec-500 showed
    // the directory exclusion should not exist, so a helper is now ordinary
    // source and there is no waiver to inspect. The surviving test-related
    // decline is the filename predicate, which is the one that carries B1.
    const msg = waiverFor({ "src/app.test.ts": READ, "README.md": "# docs" });
    expect(msg).toContain("UNMEASURED");
    expect(msg, "the walk still claims it looked everywhere").not.toContain(FALSE_CLAIM);
    expect(msg).toContain("src/app.test.ts");
    expect(msg).toContain("test file");
  });

  test("a root tool config is declined BY NAME", () => {
    const msg = waiverFor({ "vite.config.ts": READ, "README.md": "# docs" });
    expect(msg).toContain("UNMEASURED");
    expect(msg, "the walk still claims it looked everywhere").not.toContain(FALSE_CLAIM);
    expect(msg).toContain("vite.config.ts");
    expect(msg).toContain("root tool config");
  });

  test("a genuinely empty project says so, and says it DIFFERENTLY", () => {
    // The control, and the case the old sentence was written for. Without
    // this the three cases above could pass over a message that simply never
    // claims anything, which would trade a false sentence for an empty one.
    const msg = waiverFor({ "README.md": "# docs", "notes.txt": "hello" });
    expect(msg).toContain("UNMEASURED");
    expect(msg, "an empty project should not be reporting declines")
      .toContain("found no files of any kind that it counts as source");
    expect(msg, "a project with nothing skipped still listed skips").not.toContain("did not count");
  });

  test("the evidence itself carries the declines, not just the message", () => {
    // The message is one reader. A caller that wants to act on the declines
    // — a future FAIL ladder, a report — needs them as data, and asserting
    // only the prose would let the data rot while the sentence stayed right.
    const root = project({ ".github/scripts/release.js": READ, "src/app.test.ts": READ });
    const e = projectSourceEvidence(root);
    expect(e.found, "a declined entry was counted as project source").toBe(false);
    expect(e.skipped.some(s => s.startsWith(".github/")), `skipped was ${e.skipped.join(", ")}`)
      .toBe(true);
    expect(e.skipped.some(s => s.startsWith("src/app.test.ts")), `skipped was ${e.skipped.join(", ")}`)
      .toBe(true);
  });

  test("declining does not reopen B1: a scaffolded test file is still not source", () => {
    // sec-476's BLOCKER, which is what the skips were added for. The
    // direction this must not drift in: recording a decline must not turn
    // into counting it.
    const root = project({ "tests/scaffold-conformity.test.ts": READ, "README.md": "# docs" });
    expect(projectSourceEvidence(root).found, "B1 reopened — a test file counted as source")
      .toBe(false);
  });

  test("the hole the test-directory skip was costing is closed", () => {
    // sec-500's measurement: a NON-test file in `tests/`, holding a real
    // direct config read, scored 0 fail / severity WARN. It was waived.
    const root = project({ "tests/helper.ts": READS_CONFIG, "README.md": "# docs" });
    const e = projectSourceEvidence(root);
    expect(e.found, "tests/helper.ts is waived again").toBe(true);
    expect(
      unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts"),
      "a project with a live config read in tests/ was waived",
    ).toBeNull();
  });

  test("an extension-less file in a SCANNED directory is recorded", () => {
    // sec-500's sharpest case, and this repo ships two of the shape:
    // `scripts/git-hooks/pre-commit` and `pre-push`. Invisible to
    // SOURCE_EXTENSIONS, inside a directory CONFIG-1 scans. Not counted as
    // source — that would make every git hook and CI shim project source —
    // but no longer silent.
    const root = project({ "scripts/git-hooks/pre-commit": READS_CONFIG, "README.md": "# d" });
    const e = projectSourceEvidence(root);
    expect(e.found, "an extension-less hook became project source").toBe(false);
    expect(
      e.skipped.some(x => x.includes("pre-commit")),
      `skipped was [${e.skipped.join(", ")}]`,
    ).toBe(true);
    expect(unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts"))
      .toContain("pre-commit");
  });

  test("a symlink pointing outside the project is recorded, not silently dropped", () => {
    // The containment decision is right and stays. What was wrong is that
    // `found:false, unreadable:[]` rendered "I chose not to look"
    // identically to "there was nothing there" — and a pnpm workspace with
    // `lib/impl -> ../../packages/core` is an ordinary shape.
    const outside = mkdtempSync(join(tmpdir(), "rungate-outside-"));
    writeFileSync(join(outside, "core.ts"), READS_CONFIG);
    const root = project({ "README.md": "# docs" });
    symlinkSync(join(outside, "core.ts"), join(root, "linked.ts"));

    const e = projectSourceEvidence(root);
    expect(e.found, "code outside the project was counted as project source").toBe(false);
    expect(
      e.skipped.some(x => x.includes("linked.ts")),
      `the escape was silent; skipped was [${e.skipped.join(", ")}]`,
    ).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a symlinked DIRECTORY resolving outside the project is recorded too", () => {
    // The other containment site. Recorded separately because the two are
    // different code paths — the directory one is checked when the entry is
    // popped off the stack, the file one when it is classified — and a
    // record on only one of them is the same silence in half the cases.
    const outside = mkdtempSync(join(tmpdir(), "rungate-outside-"));
    mkdirSync(join(outside, "core"), { recursive: true });
    writeFileSync(join(outside, "core", "reader.ts"), READS_CONFIG);
    const root = project({ "README.md": "# docs" });
    symlinkSync(join(outside, "core"), join(root, "impl"));

    const e = projectSourceEvidence(root);
    expect(e.found, "a directory outside the project was counted as source").toBe(false);
    expect(
      e.skipped.some(x => x.includes("impl")),
      `the directory escape was silent; skipped was [${e.skipped.join(", ")}]`,
    ).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a .d.ts declaration file is declined BY NAME", () => {
    // Added because the battery said so: mutating the `.d.ts` branch was
    // 0 red while the other five deciders were 1, 2, 3 and 8. Nothing
    // reached it. A declarations-only package — `types/`, a DefinitelyTyped
    // style project — is a real shape, and it was the one skip class with
    // no case at all.
    const root = project({ "src/types.d.ts": READ, "README.md": "# docs" });
    const e = projectSourceEvidence(root);
    expect(e.found, "a .d.ts became project source").toBe(false);
    expect(
      e.skipped.some(x => x.includes("types.d.ts")),
      `skipped was [${e.skipped.join(", ")}]`,
    ).toBe(true);
    expect(waiverFor({ "src/types.d.ts": READ, "README.md": "# docs" }))
      .toContain("type declarations");
  });

  test("N-1: the entry that explains the waiver is not truncated out by boilerplate", () => {
    // sec-500 measured the first version of `skipped[]` on a realistic repo:
    // nine entries, and the five that survived `slice(0, 5)` were `.husky/`,
    // `dist/`, `node_modules/`, `.claude/` and `.github/` — all true of
    // every repo in existence — while `build/`, the directory actually
    // holding the config read, was inside ", and 4 more".
    const root = project({ "README.md": "# docs" });
    for (const d of [".husky", "dist", "node_modules", ".claude", ".github", ".git", ".vscode"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "f.js"), "export const x = 1;\n");
    }
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build", "release.ts"), READS_CONFIG);

    const e = projectSourceEvidence(root);
    const msg = unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts") ?? "";
    expect(msg, "the directory holding the config read is not in the message")
      .toContain("build/");
    // `.git` and `node_modules` are RECORDED, and that is a reversal.
    // I dropped them entirely at first, on the grounds that they can never
    // hold the project's own source. True, and still the wrong move:
    // sec-485's point is that "I declined 400 entries under node_modules/"
    // is honest and short, while silence is neither. They collapse to one
    // counted line in the message, which buys the brevity without the
    // silence — so the assertion is that they are present in the DATA and
    // collapsed in the PROSE.
    expect(
      e.skipped.some(x => x.startsWith("node_modules/")),
      "a declined dependency tree left no trace at all",
    ).toBe(true);
    expect(msg, "node_modules was listed individually instead of collapsed")
      .toContain("dependency or VCS metadata: 2");
    // The TOTAL is always stated, which is what stops truncation hiding the
    // magnitude: a reader who sees "declined 20 entries" and five names
    // knows to go looking. Without it, a tightened cap would silently shrink
    // the message with nothing saying so.
    expect(msg, "the message does not say how many entries were declined")
      .toContain(`declined ${e.skipped.length} entr`);
  });

  test("N-1: a class with many members collapses, and the rare one stays visible", () => {
    // sec-485's reason 1, which my first remedy did not touch: on rungate
    // itself `skipped` is 320 entries of which 310 are test files, so a
    // cap of eight showed ten test files and hid everything else —
    // including the extension-less scripts that are the likeliest
    // explanation for a waiver and the reason the issue was filed.
    //
    // Collapsing rather than dropping is the fix: the count is exact, the
    // data keeps every entry, and the one-of-a-kind entry is not crowded
    // out by the forty-of-a-kind one.
    const root = project({ "README.md": "# docs" });
    mkdirSync(join(root, "test"), { recursive: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, "test", `t${i}.test.ts`), "export const x = 1;\n");
    }
    mkdirSync(join(root, "scripts", "git-hooks"), { recursive: true });
    writeFileSync(join(root, "scripts", "git-hooks", "pre-commit"), READS_CONFIG);

    const e = projectSourceEvidence(root);
    const msg = unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts") ?? "";

    expect(e.skipped.length, "the data lost entries to make the message short").toBe(41);
    expect(msg, "forty test files were listed one by one").toContain("test file: 40");
    expect(msg, "the rare entry was crowded out by the common one")
      .toContain("scripts/git-hooks/pre-commit");
    expect(
      (msg.match(/\.test\.ts/g) ?? []).length,
      "the message still names test files individually",
    ).toBeLessThanOrEqual(3);
  });

  test("N-1: the record is a function of the DECISIONS, not of build state", () => {
    // Reversal, and sec-485 is the reason. The first version of this case
    // asserted the opposite — an empty `dist/` was filtered out of the
    // record on the grounds that "I declined to look at code that is really
    // there" is the only version of the list worth printing. That sentence
    // is still true about CONTENTS and it was the wrong thing to optimise:
    // the field is a log of DECISIONS, and the walk took the same decision
    // either way.
    //
    // Measured against the implementation, not argued: one tree, one set of
    // scan decisions, `dist/` empty and then holding a build artifact. The
    // filter made the evidence record differ between the two, so a reader
    // auditing a waiver saw a different list depending on whether CI had
    // run — on a clean checkout, or with a tracked-but-empty `dist/`, the
    // decline vanished entirely.
    //
    // What the filter did NOT do, which is why this is a reversal and not a
    // blocker: the verdict never moved. `found` is `true` in both trees.
    // The whole cost landed on the prose, which is the one field whose
    // entire job is to let someone audit why a waiver fired.
    const root = project({ "README.md": "# docs" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
    mkdirSync(join(root, "dist"), { recursive: true });

    const before = projectSourceEvidence(root);
    writeFileSync(join(root, "dist", "index.js"), "export const a = 1;\n");
    const after = projectSourceEvidence(root);

    // Not the vacuous shape: these are two DIFFERENT trees, and the claim is
    // that a difference the walk never looked at leaves no trace.
    expect(
      before.skipped,
      "a declined directory went unrecorded until something built into it",
    ).toEqual(after.skipped);
    expect(
      before.skipped.some(x => x.startsWith("dist/")),
      `the decline was never recorded at all; skipped was [${before.skipped.join(", ")}]`,
    ).toBe(true);
    expect(before.found, "the fixture stopped measuring a project with source").toBe(true);
  });

  test("N-1: an empty DOT-directory is recorded too, not just an empty build dir", () => {
    // A separate case rather than another assertion in the one above,
    // because the two branches are two deciders and a single case cannot
    // say which one regressed. The content predicate was applied to both;
    // restoring it to either must turn exactly one of these two red.
    const root = project({ "README.md": "# docs" });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
    mkdirSync(join(root, ".husky"), { recursive: true });

    const e = projectSourceEvidence(root);
    expect(
      e.skipped.some(x => x.startsWith(".husky/")),
      `an empty dot-directory left no trace; skipped was [${e.skipped.join(", ")}]`,
    ).toBe(true);
  });

  test("N-1: the decline list is ordered deterministically, not by readdir", () => {
    // `readdir` order is neither alphabetical nor creation order, so WHICH
    // entries survived truncation differed per machine — a consumer and CI
    // could be shown different lists, which makes the message uncitable in
    // a bug report.
    // The first version of this test built the same tree twice and compared
    // the two lists. It was VACUOUS and the battery said so — removing the
    // sort entirely was 0 red, because two trees built by the same code in
    // the same order give the same `readdir` order, so the comparison held
    // whether or not anything sorted. It asserted reproducibility on one
    // machine, which is the one thing that was never in doubt.
    //
    // The property is an ORDER, so the order is what gets asserted: ranked
    // first (entries that can plausibly hold first-party code before ones
    // that cannot), alphabetical within a rank.
    //
    // The fixture carries a dot-FILE and a FILE named `vendor` as well as
    // the directories, and both were added because sec-518's battery found
    // the ordering unpinned (F2, F3). Ranking `dot-file` alongside
    // `dot-directory` was **0 red of 71**: this was the only ordering
    // assertion and its fixture had no dot-file in it, so the one part of
    // #518 that changes ordering had nothing holding it.
    //
    // The two ranks are different on purpose. `.github/` can hide a release
    // script, so a dot-DIRECTORY ranks 3 and survives truncation; `.env`
    // cannot hide anything, so a dot-FILE falls to 5 and is cut first.
    const root = project({ "README.md": "# docs" });
    for (const d of [".zeta", ".alpha", "dist", "coverage", "build"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "f.js"), "export const x = 1;\n");
    }
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, "vendor"), "a manifest, not a directory\n");
    expect(projectSourceEvidence(root).skipped, "the decline list is not in ranked order")
      .toEqual([
        "build/ (build output or dependency)",
        // Rank 2 with no trailing slash — F3. Before the regex was widened
        // this sorted to the bottom, because `/^(?:build|vendor)\//` was
        // matching the slash #518 removes from a declined file.
        "vendor (build output or dependency)",
        ".alpha/ (dot-directory, tooling)",
        ".zeta/ (dot-directory, tooling)",
        // Rank 5: below every dot-DIRECTORY, which is the whole point.
        ".env (dot-file, tooling)",
        "coverage/ (build output or dependency)",
        "dist/ (build output or dependency)",
      ]);
  });

  test("N-2: code in a language this check cannot read is recorded, not waived silently", () => {
    // Keying the rule on "extension-less" would have missed these, and the
    // fallback sentence — "the walk found no files of any kind that it
    // counts as source" — is LITERALLY TRUE for them, which is exactly what
    // would have let the gap outlive the fix. `bin/` is not a scan dir, so
    // this is keyed on the file rather than its directory.
    const root = project({ "lib/loader.py": "x = 1\n", "bin/run.sh": "echo hi\n", "README.md": "# d" });
    const e = projectSourceEvidence(root);
    expect(e.found, "a .py became TypeScript").toBe(false);
    expect(e.skipped.some(x => x.includes("loader.py")), `skipped was [${e.skipped.join(", ")}]`)
      .toBe(true);
    expect(e.skipped.some(x => x.includes("run.sh"))).toBe(true);
    expect(unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts"))
      .toContain("not a language this check reads");
  });

  test("a real source file is still found, and is NOT a decline", () => {
    // The other direction, and the one that matters most: none of this may
    // make an ordinary project waivable.
    const root = project({ "src/app.ts": READ });
    const e = projectSourceEvidence(root);
    expect(e.found, "a real source file stopped being found").toBe(true);
    expect(unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts"), "a project with source was waived")
      .toBeNull();
  });
});

/**
 * #518: a declined entry is written down as the kind it actually is.
 *
 * The three decline-by-name branches matched a NAME and then wrote
 * `${rel}/` with a directory-shaped label, without ever asking whether the
 * entry was a directory. So every dot-FILE was recorded as a dot-directory
 * with a trailing slash.
 *
 * This is a regression from #512, and a small instance of the class #500 was
 * filed to kill: a message that asserts something false about the tree it
 * just walked. The verdict is right in every case — only the label lies.
 * Before #512 that branch was a bare `continue` and recorded nothing, so the
 * false label arrived with the fix that made declines visible at all.
 *
 * Measured before the fix, on two real trees rather than fixtures:
 *
 * | Tree | False "directory" entries |
 * |---|---|
 * | this repo | 8 of 369 — `.gitignore/`, `.mcp.json/`, `gates/.gate-salt/`, `.git/` |
 * | `pov-plugin` (a consumer) | **5 of 13** — four `.DS_Store/` and `.gitignore/` |
 *
 * `.git` is the row worth naming: in a WORKTREE it is a gitfile, not a
 * directory, so that branch was wrong in every worktree this project
 * develops in and right only in the main checkout.
 *
 * ## The wrong fix, named (`.claude/rules/checks-must-be-able-to-fail.md`)
 *
 * The cheapest way to make a dot-file stop reading as a dot-directory is to
 * stop recording dot-files. The two classes then "differ" because one is
 * absent, every label left in the list is true, and the check certifies the
 * regression — `undefined !== "dot-directory"` holds. So the first case
 * below asserts PRESENCE before it compares anything, and the comparison is
 * written against the entry it just proved is there.
 */
describe("#518: a declined entry is written down as the kind it actually is", () => {
  /** The entry for `rel`, or `undefined` — the thing the wrong fix removes. */
  const entryFor = (skipped: string[], rel: string): string | undefined =>
    skipped.find(s => s === rel || s.startsWith(`${rel} (`) || s.startsWith(`${rel}/ (`));

  test("a dot-FILE is recorded, keeps no trailing slash, and is not called a directory", () => {
    const root = project({
      ".gitignore": "node_modules\n",
      ".github/scripts/release.js": READS_CONFIG,
      "README.md": "# docs",
    });
    const e = projectSourceEvidence(root);

    // PRESENCE FIRST. Deleting the dot-file from the record satisfies every
    // assertion below it and is the repair a hurried reader reaches for.
    const dotFile = entryFor(e.skipped, ".gitignore");
    expect(dotFile, `the dot-file stopped being recorded; skipped was [${e.skipped.join(", ")}]`)
      .toBeDefined();
    expect(dotFile, "a regular file was written down with a directory's trailing slash")
      .not.toContain(".gitignore/");
    expect(dotFile, "a regular file was labelled a directory").not.toContain("directory");
    expect(dotFile).toContain("dot-file");

    // And the dot-DIRECTORY in the same tree keeps both. Without this the
    // fix could flatten every entry to the file spelling and still be green.
    const dotDir = entryFor(e.skipped, ".github");
    expect(dotDir, `the dot-directory stopped being recorded; skipped was [${e.skipped.join(", ")}]`)
      .toBeDefined();
    expect(dotDir).toContain(".github/");
    expect(dotDir).toContain("dot-directory");
  });

  test("a symlinked directory is still a directory — `Dirent.isDirectory()` says otherwise", () => {
    // The reason the fix is a stat and not `e.isDirectory()`. A symlinked
    // `node_modules` is the ordinary pnpm / npm-workspace shape, and the
    // cheap predicate writes it down as a file. Both decline-by-name
    // branches that can see a symlink are exercised here.
    const root = project({ "vendor-real/pkg/index.js": "x\n", "tooling-real/note.md": "# n" });
    symlinkSync(join(root, "vendor-real"), join(root, "node_modules"), "dir");
    symlinkSync(join(root, "tooling-real"), join(root, ".cache"), "dir");
    const e = projectSourceEvidence(root);

    expect(entryFor(e.skipped, "node_modules"), "a symlinked node_modules lost its slash")
      .toContain("node_modules/");
    const cache = entryFor(e.skipped, ".cache");
    expect(cache, `skipped was [${e.skipped.join(", ")}]`).toBeDefined();
    expect(cache, "a symlinked dot-directory was written down as a file").toContain(".cache/");
    expect(cache).toContain("dot-directory");
  });

  test("`.git` as a GITFILE loses the slash — the shape of every worktree", () => {
    // `NEVER_PROJECT_SOURCE`, not the dot branch, and a different label:
    // "dependency or VCS metadata" never said "directory", so only the
    // trailing slash was false. It was false in every worktree.
    const root = project({ ".git": "gitdir: /elsewhere/.git/worktrees/wt\n", "README.md": "# d" });
    const git = entryFor(projectSourceEvidence(root).skipped, ".git");
    expect(git, "the gitfile stopped being recorded").toBeDefined();
    expect(git, "a gitfile was written down as a directory").not.toContain(".git/");
    expect(git).toContain("VCS metadata");
  });

  test("a FILE named `dist` is not written down as `dist/`", () => {
    // `SOURCE_SKIP_DIRS`, the third branch. No instance on either tree
    // measured above, which is exactly why it gets a case: the defect is in
    // the branch, and a branch with no fixture is the one that survives.
    const root = project({ "dist": "a build manifest, not a directory\n", "README.md": "# d" });
    const dist = entryFor(projectSourceEvidence(root).skipped, "dist");
    expect(dist, "the file stopped being recorded").toBeDefined();
    expect(dist, "a regular file was written down as a build directory").not.toContain("dist/");
    expect(dist).toContain("build output");
  });

  test("a dot-symlink that cannot be resolved is a LABEL, never a refusal", () => {
    // sec-518's F1, and the mutation that found it came back **0 of 71**:
    // `declinedIsDir`'s `catch` was the only thing deciding whether a
    // failed stat stays a label or escapes, and no fixture reached it.
    // Every symlink in this file's fixtures resolves.
    //
    // Both halves matter and they fail differently.
    //
    // Deleting the `catch` lets the throw escape `projectSourceEvidence`
    // into the surrounding `test()`, so a consumer with one dangling
    // symlink — `.broken -> ./gone`, or a symlinked `node_modules` whose
    // store was pruned — gets a HARD CONFIG-1 FAILURE over an entry the
    // walk declines as tooling either way. That is the over-refusal the
    // dangling-symlink note forbids, arriving through the label path.
    //
    // Returning `true` instead of `false` is the other direction: the
    // entry gets a trailing slash and is written down as a directory that
    // is not there, which is #518 reintroduced for the unresolvable case.
    const root = project({ "README.md": "# docs", "src/app.ts": READS_CONFIG });
    const locked = mkdtempSync(join(tmpdir(), "rungate-476-locked-"));
    scratch.push(locked);
    mkdirSync(join(locked, "inner"), { recursive: true });
    symlinkSync(join(root, "gone"), join(root, ".broken"));      // ENOENT
    symlinkSync(join(locked, "inner"), join(root, ".vault"));    // EACCES below
    symlinkSync(join(root, ".loopB"), join(root, ".loopA"));     // ELOOP
    symlinkSync(join(root, ".loopA"), join(root, ".loopB"));
    chmodSync(locked, 0o000);
    try {
      let ev;
      expect(() => { ev = projectSourceEvidence(root); }, "an unresolvable symlink escaped as a throw")
        .not.toThrow();
      const e = ev!;
      for (const name of [".broken", ".vault", ".loopA", ".loopB"]) {
        const entry = e.skipped.find((s: string) => s.startsWith(`${name} (`) || s.startsWith(`${name}/ (`));
        expect(entry, `${name} was not recorded at all; skipped was [${e.skipped.join(", ")}]`)
          .toBeDefined();
        expect(entry, `${name} resolves to nothing but was written down as a directory`)
          .not.toContain(`${name}/`);
      }
      // And none of it reached the verdict. `unreadable` is what turns an
      // UNMEASURED into a refusal, and a declined-by-name entry must never
      // put anything in it — the project is declined as tooling regardless.
      expect(e.unreadable, "a declined dot-symlink was reported as unreadable").toEqual([]);
      expect(e.found, "the real source stopped being found").toBe(true);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("only the label moved: the verdict and the counts are unchanged", () => {
    // The control. Relabelling must not turn a declined entry into source,
    // must not make a dot-file unreadable, and must not change how many
    // entries the walk declines.
    const root = project({
      ".gitignore": "x\n",
      ".DS_Store": "\x00\x01binary",
      ".github/x.md": "# t",
      "src/app.ts": READS_CONFIG,
    });
    const e = projectSourceEvidence(root);
    expect(e.found, "a declined dot-file became project source").toBe(true);
    expect(e.unreadable, "declining an entry started reporting it as unreadable").toEqual([]);
    expect(e.skipped.length, `skipped was [${e.skipped.join(", ")}]`).toBe(3);
    expect(unmeasuredScanReason(scanConfigAccess(root), e, "CONFIG-1", "ts"), "a project with source was waived")
      .toBeNull();
  });

  test("the message collapses the two classes separately", () => {
    // `summariseDeclines` groups by the parenthetical, so a second label is
    // supposed to cost nothing. Asserted rather than assumed, because the
    // issue predicted it and a prediction is not a measurement.
    const root = project({
      ".gitignore": "x\n",
      ".npmrc": "registry=\n",
      ".github/scripts/release.js": READS_CONFIG,
      "README.md": "# d",
    });
    const msg = unmeasuredScanReason(scanConfigAccess(root), projectSourceEvidence(root), "CONFIG-1", "ts");
    expect(msg, "the project was not waived at all").toContain("UNMEASURED");
    expect(msg, "the two dot-files did not collapse into one counted class").toContain("dot-file, tooling: 2");
    expect(msg, "the dot-directory was absorbed into the file class").toContain("dot-directory, tooling: 1");
  });
});

