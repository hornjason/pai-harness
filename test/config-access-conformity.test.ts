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
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  configAccessViolations,
  readConfigAccessRatchet,
  scanConfigAccess,
  scanPromptConfigAccess,
  type ConfigAccessScan,
} from "../lib/conformity";

const REPO = join(import.meta.dir, "..");

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
    const all = readConfigAccessRatchet(REPO);
    expect(Object.keys(all).length, "the ratchet file is missing or empty").toBeGreaterThan(10);
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
