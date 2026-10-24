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
  checksThatCannotFail,
  unassertedWarnPaths,
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
    // #1384 — reads `checksThatCannotFail`, not `checksWithoutAssertions`. The
    // audit's unit used to be the check BODY and the defect's unit is the
    // PATH: a check with one warn-return branch and one asserting branch
    // contains an assertion, so the body-level predicate reported nothing
    // while the check sat unable to fail on its own named condition.
    const unlisted = checksThatCannotFail(gateSource)
      .filter(c => !(c.name in WARN_TIER_CHECKS))
      .map(c => `gates/workflow.test.ts:${c.line} ${c.name}`);
    expect(
      unlisted,
      "a gate check cannot fail on the condition it is named for — it has no assertion, " +
        "or it warns and returns on that condition with nothing asserted on the path. " +
        "Either write the assertion or add it to WARN_TIER_CHECKS in " +
        "lib/gate-check-audit.ts with why",
    ).toEqual([]);
  });

  test("no name on the list has quietly gained an assertion", () => {
    // The other direction. A ratchet that only fails upward lets the list
    // outlive the thing it describes, and then it is documentation of a state
    // the code left — which is how a reader ends up trusting it.
    const names = new Set(checksThatCannotFail(gateSource).map(c => c.name));
    const stale = Object.keys(WARN_TIER_CHECKS).filter(n => !names.has(n));
    expect(stale, "these are listed as warn-tier but now assert — delete the entry").toEqual([]);
  });

  test("every reason says something", () => {
    for (const [name, reason] of Object.entries(WARN_TIER_CHECKS)) {
      expect(reason.length, `${name} has a placeholder reason`).toBeGreaterThan(80);
      expect(reason, `${name}'s reason cites nothing`).toMatch(/#\d+/);
    }
  });

  // SC-1572: a deferral is not a resting state for an entry on this list
  test("no entry is still a deferral — every one is a decision", () => {
    // #183 left two entries reading "reported, not fixed", which is an honest
    // thing to write once and a bad thing to leave. #423 settled both, in
    // opposite directions: `outcome-evidence-behavioral` asserts now and is
    // gone from the list entirely (the stale case above is what enforces
    // that), and `ac-issue-alignment` stays a warning on a measurement.
    //
    // The replaced assertion counted deferrals and required exactly two. It
    // could only ever be satisfied by NOT fixing them, so it is inverted
    // rather than retuned.
    const deferred = Object.entries(WARN_TIER_CHECKS)
      .filter(([, reason]) => /reported,\s*not fixed/i.test(reason))
      .map(([name]) => name);
    expect(
      deferred,
      "an entry that only defers is a check nobody has decided about — either make it " +
        "assert, or write what was measured to decide it should not",
    ).toEqual([]);
  });

  // SC-1573: a decision needs a number, not a preference
  test("the warning that survived on a measurement cites the measurement", () => {
    // The whole difference between #423's two outcomes is evidence. A decision
    // to keep a check warning forever is only distinguishable from never
    // having looked if it says what it would have cost to make it block.
    const reason = WARN_TIER_CHECKS["ac-issue-alignment: ACs cover goal keywords"];
    expect(reason, "ac-issue-alignment is no longer on the list").toBeTruthy();
    expect(reason, "the decision cites no sample size").toMatch(/\b1\d\d\b/);
    expect(reason, "the decision cites no rate").toMatch(/\d\d%/);
    expect(reason).toContain("#423");
  });

  // SC-1574: the check that WAS a deferral is off the list, from this side too
  test("outcome-evidence-behavioral is no longer warn-tier", () => {
    // The stale case above catches this generically by reading the gate
    // source. This names it, so a future edit that re-adds the entry has to
    // argue with the issue rather than with a list length.
    expect(Object.keys(WARN_TIER_CHECKS)).not.toContain(
      "outcome-evidence-behavioral: OUTCOME AC evidence is not just a number",
    );
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

// ── SC-2520, SC-2521 ────────────────────────────────────────────────────────

describe("SC-2520, SC-2521: the audit's unit is the path, not the check body", () => {
  // #1384. `before-state-captured` warns and returns on exactly the condition
  // its name states, and its only `expect` sits on a DIFFERENT condition. The
  // body contains an assertion, so `checksWithoutAssertions` — which asks
  // whether an assertion appears ANYWHERE in the body — reports nothing.
  //
  // The audit's unit was the check body. The defect's unit is the path.
  const PLANTED = [
    `test("planted: warns and returns on its named condition", () => {`,
    `  const v = sf("thing");`,
    `  if (!v) {`,
    `    if (tier === "LIGHT") return;`,
    `    console.warn("WARN: planted: thing missing for STANDARD+ tier");`,
    `    return;`,
    `  }`,
    `  expect(VALID.includes(v.type), "bad type").toBe(true);`,
    `});`,
  ].join("\n");

  test("the body-level predicate is blind to a warn-return path", () => {
    // THE MEASUREMENT, recorded rather than described. This is the state the
    // audit was in before #1384 widened it, and it is kept as an assertion so
    // the widening cannot be undone by quietly widening `hasAssertion`
    // instead — which would make the planted case pass for the wrong reason
    // and take every `.hasAssertion` consumer with it.
    const parsed = gateChecks(PLANTED);
    expect(parsed.length, "the planted shape did not parse as one check").toBe(1);
    expect(parsed[0]!.hasAssertion, "the planted body does contain an assertion").toBe(true);
    expect(checksWithoutAssertions(PLANTED).map(c => c.name)).toEqual([]);
  });

  test("the widened predicate names it", () => {
    const named = checksThatCannotFail(PLANTED).map(c => c.name);
    expect(
      named,
      "a check that warns and returns on its named condition is not being named",
    ).toEqual(["planted: warns and returns on its named condition"]);

    const paths = unassertedWarnPaths(PLANTED);
    expect(paths.length).toBe(1);
    // The line of the `console.warn`, not of the `test(` — the report has to
    // point at the path, or the reader re-derives which branch was meant.
    expect(paths[0]!.warnLine).toBe(5);
  });

  test("a warn that follows an assertion on the same path is not named", () => {
    // The second warn inside the real `before-state-captured`. An assertion
    // already ran on the path that reaches it, so the path can fail and the
    // warning is an extra remark rather than a swallowed refusal. Naming this
    // would make the predicate report most of the suite.
    const src = [
      `test("a: asserts first, then remarks", () => {`,
      `  expect(x.type, "bad type").toBe(true);`,
      `  if (x.type === "none") {`,
      `    console.warn("WARN: consider capturing something better");`,
      `  }`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
    expect(checksThatCannotFail(src)).toEqual([]);
  });

  test("a warn that falls through INTO an assertion is not named", () => {
    // No `return`, so the path continues into the assertion below it. The
    // defect needs the path to leave the check, not merely to warn.
    const src = [
      `test("a: warns then carries on", () => {`,
      `  if (!x) { console.warn("WARN: odd"); }`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
  });

  test("a sibling branch's return does not close the warn's path", () => {
    // PR #1539's own AI review, high. The forward scan stopped at the first
    // `return` at or above the warn's depth, wherever it sat — so a `return`
    // belonging to a LATER, unrelated branch read as the warn's path leaving
    // the check. Here the warn's own block closes without returning, the path
    // merges back into the main flow, and it reaches an assertion that can
    // fail. A warn only leaves the check if it reaches a `return` while still
    // inside its own enclosing block.
    const src = [
      `test("a: warns, then merges back into the main flow", () => {`,
      `  if (!a) {`,
      `    console.warn("WARN: odd");`,
      `  }`,
      `  if (b) return;`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
    expect(checksThatCannotFail(src)).toEqual([]);
  });

  test("a braced sibling return does not close it either", () => {
    // The same defect where the sibling's `return` sits DEEPER than the warn,
    // so the depth dips below the warn's block and comes back up. A scan that
    // only compares each token's own depth against the warn's cannot see the
    // dip; the running minimum between them is what carries it.
    const src = [
      `test("a: warns, then a deeper sibling returns", () => {`,
      `  if (!a) {`,
      `    console.warn("WARN: odd");`,
      `  }`,
      `  if (b) { return; }`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
  });

  test("a bare tier gate is not named", () => {
    // THE OUTAGE CONTROL. `if (tier === "LIGHT") return;` opens most checks in
    // the suite. It is deliberate scoping, not a swallowed refusal, and a
    // predicate that flagged every early return would name the whole file and
    // be switched off within a day. The detector is anchored on `console.warn`
    // for exactly that reason, and this case holds the anchor in place.
    const src = [
      `test("a: scoped to non-LIGHT", () => {`,
      `  if (tier === "LIGHT") return;`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
    expect(checksThatCannotFail(src)).toEqual([]);
  });

  test("a check with no assertion at all is still named, through the same door", () => {
    // The widened predicate is a superset, not a replacement. A body with no
    // assertion anywhere must keep being reported whether or not it warns.
    const src = `test("a: only warns", () => { if (!x) return; console.warn("nope"); });`;
    expect(checksWithoutAssertions(src).map(c => c.name)).toEqual(["a: only warns"]);
    expect(checksThatCannotFail(src).map(c => c.name)).toEqual(["a: only warns"]);
  });

  test("the real gate suite's path-level list is a superset of its body-level list", () => {
    const body = new Set(checksWithoutAssertions(gateSource).map(c => c.name));
    const all = new Set(checksThatCannotFail(gateSource).map(c => c.name));
    for (const name of body) expect(all, `${name} was dropped by the widening`).toContain(name);
    // And the widening actually found something, or it is the old predicate
    // wearing a new name.
    expect(all.size, "the widened predicate found nothing the body-level one did not")
      .toBeGreaterThan(body.size);
  });

  test("before-state-captured is the check #1384 was filed about", () => {
    // Named rather than counted, so a future edit that re-hides it has to
    // argue with the issue instead of with a list length.
    const named = checksThatCannotFail(gateSource).map(c => c.name);
    expect(named).toContain("before-state-captured: STANDARD+ must have beforeState in workflow-state");
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
