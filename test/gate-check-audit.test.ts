/**
 * The audit of the ported gate-check list (#183, Phase 2 of #176).
 *
 * Covers SC-1466, SC-1467, SC-1468, SC-1469, SC-1470 (HARNESS-GATES.md).
 *
 * #176 fixed three checks that could not fail. #183 is the audit of the rest
 * of the list for the same two shapes — an early return with no tail, and a
 * field read as a verdict that only configuration writes — "reported even
 * where no fix is made".
 *
 * A report is a thing someone reads once. This file is the same audit written
 * as a binding, because the gap `tsc-pass` lived in was not that nobody had
 * looked: it was that **nothing in the repo could tell a check that is
 * deliberately a warning from a check whose assertion was forgotten.** Four
 * checks warn without asserting today. Two are documented decisions, two were
 * found here. All four are named with a reason, and the list fails in both
 * directions.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  gateChecks,
  checksWithoutAssertions,
  standaloneStubs,
  environmentVerdictReads,
  WARN_TIER_CHECKS,
  STANDALONE_STUB_NAME,
} from "../lib/gate-check-audit";
import {
  classifyContainerProvenance,
  containerProvenanceViolations,
  resolveContainerRuntime,
} from "../lib/container-provenance";

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");
const gateSource = readFileSync(GATE_SUITE, "utf-8");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

// ── SC-1466 ─────────────────────────────────────────────────────────────────

describe("SC-1466: every gate check without an assertion is named with a reason", () => {
  test("no check warns without being on the list", () => {
    const unlisted = checksWithoutAssertions(gateSource)
      .filter(c => !(c.name in WARN_TIER_CHECKS))
      .map(c => `gates/workflow.test.ts:${c.line} ${c.name}`);
    expect(
      unlisted,
      "a gate check has no assertion and no recorded reason — either write the " +
        "assertion or add it to WARN_TIER_CHECKS in lib/gate-check-audit.ts with why",
    ).toEqual([]);
  });

  test("no name on the list has quietly gained an assertion", () => {
    // The other direction. A ratchet that only fails upward lets the list
    // outlive the thing it describes, and then it is documentation of a state
    // the code left — which is how a reader ends up trusting it.
    const names = new Set(checksWithoutAssertions(gateSource).map(c => c.name));
    const stale = Object.keys(WARN_TIER_CHECKS).filter(n => !names.has(n));
    expect(stale, "these are listed as warn-tier but now assert — delete the entry").toEqual([]);
  });

  test("every reason says something", () => {
    for (const [name, reason] of Object.entries(WARN_TIER_CHECKS)) {
      expect(reason.length, `${name} has a placeholder reason`).toBeGreaterThan(80);
      expect(reason, `${name}'s reason cites nothing`).toMatch(/#\d+/);
    }
  });

  test("the two shapes #176 named are both represented in the list", () => {
    // Two of the four are documented decisions (#344, #409) and two were found
    // by this audit. Asserting the mix keeps the list from silently becoming
    // all-decisions, which would read as "nothing was found".
    const reasons = Object.values(WARN_TIER_CHECKS).join("\n");
    expect(reasons).toContain("#183 — reported, not fixed");
    expect(Object.values(WARN_TIER_CHECKS).filter(r => r.includes("#183")).length).toBe(2);
  });
});

// ── SC-1467 ─────────────────────────────────────────────────────────────────

describe("SC-1467: the standalone stub is a placeholder and stays one", () => {
  test("every standalone stub has an empty body", () => {
    const stubs = standaloneStubs(gateSource);
    expect(stubs.length, "the standalone placeholder has disappeared").toBeGreaterThan(0);
    for (const s of stubs) {
      expect(s.body.replace(/[\s})]/g, ""), `${STANDALONE_STUB_NAME} at :${s.line} grew a body`).toBe("");
    }
  });

  test("the stubs are excluded from the warn-tier list rather than allowlisted", () => {
    // They are not checks. Putting seven identical names on a list of
    // deliberate warnings would make the list unreadable and would hide a real
    // entry among them.
    expect(Object.keys(WARN_TIER_CHECKS)).not.toContain(STANDALONE_STUB_NAME);
  });
});

// ── SC-1468 ─────────────────────────────────────────────────────────────────

describe("SC-1468: the parser reads every test in the file", () => {
  test("the parse count matches the number of test( lines", () => {
    // THE POSITIVE CONTROL. A parser that returned [] would satisfy every
    // assertion in SC-1466 for free — which is the defect this whole file is
    // about, committed by the audit itself.
    const literal = (gateSource.match(/^\s*test\(/gm) || []).length;
    expect(literal).toBeGreaterThan(50);
    expect(gateChecks(gateSource).length, "the parser is seeing less than the file").toBe(literal);
  });

  test("most checks DO assert, so the audit is not reporting everything", () => {
    const all = gateChecks(gateSource);
    const asserting = all.filter(c => c.hasAssertion).length;
    expect(asserting).toBeGreaterThan(all.length / 2);
  });

  test("the generic call form counts as an assertion", () => {
    // The first draft matched `\bexpect\s*\(` and reported
    // `workflow-state.json validates` as having none, because its assertion is
    // written `expect<boolean>(...)` to widen a narrowed type. A detector that
    // misses a form present in its own input is the second shape in
    // .claude/rules/checks-must-be-able-to-fail.md.
    const generic = gateChecks(`test("a", () => { expect<boolean>(x, "m").toBe(true); });`);
    expect(generic.length).toBe(1);
    expect(generic[0]!.hasAssertion).toBe(true);
  });

  test("a check with no assertion is detected in a synthetic source", () => {
    // The control arm for the detector itself: it must say yes to something.
    const src = [
      `test("warns: only warns", () => { if (!x) return; console.warn("nope"); });`,
      `test("asserts: asserts", () => { expect(1).toBe(1); });`,
    ].join("\n");
    expect(checksWithoutAssertions(src).map(c => c.name)).toEqual(["warns: only warns"]);
  });

  test("an expect in the test NAME is not an assertion", () => {
    const src = `test("expect(this) to be named oddly", () => { console.warn("x"); });`;
    expect(checksWithoutAssertions(src).length).toBe(1);
  });

  test("braces inside strings and templates do not end a body early", () => {
    const src = [
      "test(\"a: a\", () => {",
      "  const s = \"} not the end {\";",
      "  const t = `${ { a: 1 } } also not`;",
      "  expect(s + t).toBeTruthy();",
      "});",
    ].join("\n");
    const parsed = gateChecks(src);
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.hasAssertion).toBe(true);
  });
});

// ── SC-1469 ─────────────────────────────────────────────────────────────────

describe("SC-1469: a container that answers is not a rebuild that happened", () => {
  test("the ship prompt no longer writes prod.rebuild = PASS from a health curl", () => {
    expect(shipSource, "the health-curl arm records an unmeasured rebuild as PASS again")
      .not.toContain("s.environments.prod.rebuild = 'PASS'");
  });

  test("it records SKIP with a reason, which is the standard #176 AC-3 set", () => {
    expect(shipSource).toContain("s.environments.prod.rebuild = 'SKIP'");
    expect(shipSource).toContain("s.environments.prod.rebuildSkipReason =");
    // The control. An arm that wrote SKIP for everything would satisfy the two
    // assertions above and throw away the one thing the curl does measure.
    expect(shipSource).toContain("s.environments.prod.smoke = 'PASS'");
  });

  test("every environments read in the gate suite is still enumerated", () => {
    // Shape 2 is an audit of READS against their writers, and the reads are
    // the part a machine can keep current. A new one appearing means a new
    // writer to check.
    expect(environmentVerdictReads(gateSource)).toEqual([
      "local.api",
      "local.quinn",
      "local.tests",
      "local.ui",
      "local.uiSkipReason",
      "prod.quinn",
      "prod.quinnSkipReason",
      "prod.quinnSpot",
      "prod.quinnSpotSkipReason",
      "prod.rebuild",
      "prod.rebuildSkipReason",
      "prod.smoke",
      "prod.smokeSkipReason",
    ]);
  });
});

// ── SC-1470 ─────────────────────────────────────────────────────────────────

describe("SC-1470: the suppression that the false PASS was switching off", () => {
  const behind = () => ({
    runtime: resolveContainerRuntime("podman", () => true),
    containerName: "app",
    inspect: { ok: true, output: "b".repeat(40), stderr: "" },
    head: { ok: true, output: "a".repeat(40) },
  });

  test("a container behind HEAD blocks when the rebuild is SKIP", () => {
    // What the fix restores. This is the verdict a DDB run reached before
    // something started writing PASS from a curl.
    const v = classifyContainerProvenance({ ...behind(), prodRebuild: "SKIP" });
    expect(v.outcome).toBe("BEHIND");
    expect(v.blocking).toBe(true);
    expect(containerProvenanceViolations(v).length).toBe(1);
  });

  test("the same reading does NOT block when the rebuild says PASS", () => {
    // Executed rather than described: this is why writing PASS from a health
    // check mattered. The suppression itself is correct — a rebuild that
    // really ran explains a stale label — so the defect was upstream, in what
    // was allowed to say PASS.
    const v = classifyContainerProvenance({ ...behind(), prodRebuild: "PASS" });
    expect(v.outcome).toBe("BEHIND");
    expect(v.blocking).toBe(false);
    expect(containerProvenanceViolations(v)).toEqual([]);
  });

  test("a matching container is clean either way, so the pair is not vacuous", () => {
    for (const prodRebuild of ["SKIP", "PASS"]) {
      const v = classifyContainerProvenance({
        ...behind(),
        inspect: { ok: true, output: "a".repeat(40), stderr: "" },
        prodRebuild,
      });
      expect(v.outcome).toBe("MATCH");
      expect(containerProvenanceViolations(v)).toEqual([]);
    }
  });
});
