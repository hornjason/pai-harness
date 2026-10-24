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

  test("a warn that ends the check without returning is named", () => {
    // PR #1539's review, second round. The scan implemented only half of what
    // it documented: a path leaves the check at a `return` OR at the end of
    // the check, and running out of tokens was treated as "did not leave".
    //
    // This is the shape that gets past BOTH halves of the audit. The
    // if-branch's `expect` makes the body assert, so the body-level predicate
    // says nothing; the else-branch warns and simply ends, so no `return`
    // token exists for the path-level scan to stop on. It is the #1384 defect
    // written with an `else` instead of an early return.
    const src = [
      `test("a: asserts on one branch, warns on the other", () => {`,
      `  if (a) {`,
      `    expect(p, "m").toBe(true);`,
      `  } else {`,
      `    console.warn("WARN: nothing to check");`,
      `  }`,
      `});`,
    ].join("\n");
    expect(gateChecks(src)[0]!.hasAssertion, "the body does contain an assertion").toBe(true);
    expect(checksWithoutAssertions(src), "the body-level predicate is blind here too").toEqual([]);
    expect(unassertedWarnPaths(src).length).toBe(1);
    expect(checksThatCannotFail(src).map(c => c.name)).toEqual([
      "a: asserts on one branch, warns on the other",
    ]);
  });

  test("a mutually exclusive branch's assertion does not cover the warn", () => {
    // PR #1539's review, third round. The enclosing-assertion state was reset
    // by brace depth alone, so it only noticed exclusivity when the branches
    // were braced and the depth actually dipped between them. Written without
    // braces, or as switch cases, the `expect` and the `console.warn` sit at
    // the SAME depth with nothing closing in between — and the assertion was
    // credited to a path that can never execute it.
    const braceless = [
      `test("a: braceless else", () => {`,
      `  if (a) expect(p, "m").toBe(true);`,
      `  else console.warn("WARN: nothing to check");`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(braceless).length, "a braceless else is exclusive too").toBe(1);

    const switched = [
      `test("a: switch", () => {`,
      `  switch (k) {`,
      `    case 1: expect(p, "m").toBe(true); break;`,
      `    case 2: console.warn("WARN: nothing to check"); return;`,
      `  }`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(switched).length, "switch cases are exclusive too").toBe(1);
  });

  test("an assertion BEFORE the if still covers a warn in its else", () => {
    // THE CONTROL for the case above, and the one a careless fix breaks. An
    // `else` only supersedes an assertion that lives in the `if` branch it
    // pairs with. This `expect` runs before the branch opens, so it runs on
    // every path including the warned one, and naming this would be a false
    // refusal rather than a missed one.
    const src = [
      `test("a: asserts, then branches", () => {`,
      `  expect(p, "m").toBe(true);`,
      `  if (a) { q(); } else { console.warn("WARN: y"); }`,
      `});`,
    ].join("\n");
    expect(unassertedWarnPaths(src)).toEqual([]);
    expect(checksThatCannotFail(src)).toEqual([]);
  });

  test("an assertion earlier in the SAME branch still covers a nested warn", () => {
    // The second control. The `expect` and the warn are on one path here, so
    // the path can fail and the warn is a remark.
    const src = [
      `test("a: asserts, then warns deeper in the same branch", () => {`,
      `  if (a) {`,
      `    expect(p, "m").toBe(true);`,
      `    if (b) { console.warn("WARN: y"); return; }`,
      `  }`,
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

// ── SC-2520, SC-2521 (#1555) ────────────────────────────────────────────────

/**
 * Every way a path out of a `console.warn` can terminate, one case per shape.
 *
 * #1555. The three defects PR #1539's review found were handed back one per
 * round, and the fix for round 1 introduced the defect round 2 found. That is
 * what patching a reachability analysis one symptom at a time looks like, so
 * this is the enumeration instead: twelve shapes, each asserting its own
 * direction, run against the predicate after every change rather than at the
 * end.
 *
 * **Seven of the twelve must NOT flag.** A predicate that flags everything
 * passes every positive case ever written, so the negative half is the half
 * that does the work.
 *
 * Measured against the token scan that merged in #1539 (`2729ce62`), THREE
 * were wrong, not the two #1555 predicted: 3, 11 and 12. #1555's own shape-3
 * case read correct because it was written with an assertion after the
 * `try`/`throw` block, so it answered `–` whether or not the `throw` was
 * there — the seventh shape in `.claude/rules/checks-must-be-able-to-fail.md`,
 * a case green by construction. `NEGATIVE_CONTROLS` below is what keeps that
 * from happening again: each is the same fixture with the one feature under
 * test removed, and each must FLAG.
 */
interface PathShape {
  n: number;
  shape: string;
  /** What the predicate must answer. */
  flags: boolean;
  source: string;
}

const PATH_SHAPES: PathShape[] = [
  {
    n: 1,
    shape: "explicit `return` in the warn's block",
    flags: true,
    source: [
      `test("s1: warns and returns on its named condition", () => {`,
      `  const v = sf("thing");`,
      `  if (!v) {`,
      `    console.warn("WARN: thing missing");`,
      `    return;`,
      `  }`,
      `  expect(v.type, "m").toBe(true);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 2,
    shape: "falls off the end of the body",
    flags: true,
    source: [
      `test("s2: asserts on one branch, warns on the other", () => {`,
      `  if (a) {`,
      `    expect(p, "m").toBe(true);`,
      `  } else {`,
      `    console.warn("WARN: nothing to check");`,
      `  }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 3,
    shape: "`throw` after the warn",
    flags: false,
    source: [
      `test("s3: warns, then throws", () => {`,
      `  if (!a) {`,
      `    console.warn("WARN: context for the failure below");`,
      `    throw new Error("a is missing");`,
      `  }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 4,
    shape: "`break` inside a loop",
    flags: false,
    source: [
      `test("s4: warns and breaks out of the loop", () => {`,
      `  for (const x of xs) {`,
      `    if (!x.ok) {`,
      `      console.warn("WARN: one is bad");`,
      `      break;`,
      `    }`,
      `  }`,
      `  expect(xs.length, "m").toBeGreaterThan(0);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 5,
    shape: "`continue` inside a loop",
    flags: false,
    source: [
      `test("s5: warns and continues", () => {`,
      `  for (const x of xs) {`,
      `    if (!x.ok) {`,
      `      console.warn("WARN: skipping one");`,
      `      continue;`,
      `    }`,
      `    seen.push(x);`,
      `  }`,
      `  expect(seen.length, "m").toBeGreaterThan(0);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 6,
    shape: "`expect` reachable after the warn",
    flags: false,
    source: [
      `test("s6: warns then carries on", () => {`,
      `  if (!a) { console.warn("WARN: odd"); }`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 7,
    shape: "`return` in a nested closure, warn outside",
    flags: false,
    source: [
      `test("s7: warns, then a closure returns", () => {`,
      `  console.warn("WARN: odd");`,
      `  items.forEach(i => { if (!i.ok) return; seen.push(i); });`,
      `  expect(seen.length, "m").toBeGreaterThan(0);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 8,
    shape: "sibling branch's `return`",
    flags: false,
    source: [
      `test("s8: warns, then merges back into the main flow", () => {`,
      `  if (!a) {`,
      `    console.warn("WARN: odd");`,
      `  }`,
      `  if (b) return;`,
      `  expect(y, "m").toBe(true);`,
      `});`,
    ].join("\n"),
  },
  {
    n: 9,
    shape: "braceless exclusive `else`",
    flags: true,
    source: [
      `test("s9: braceless else", () => {`,
      `  if (a) expect(p, "m").toBe(true);`,
      `  else console.warn("WARN: nothing to check");`,
      `});`,
    ].join("\n"),
  },
  {
    n: 10,
    shape: "assertion before the `if`, warn in its `else`",
    flags: false,
    source: [
      `test("s10: asserts, then branches", () => {`,
      `  expect(p, "m").toBe(true);`,
      `  if (a) { q(); } else { console.warn("WARN: y"); }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 11,
    shape: "`try { warn; return } finally { expect }`",
    flags: false,
    source: [
      `test("s11: warns and returns inside a try with an asserting finally", () => {`,
      `  try {`,
      `    console.warn("WARN: odd");`,
      `    return;`,
      `  } finally {`,
      `    expect(cleanup(), "m").toBe(true);`,
      `  }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 12,
    shape: "warn inside a callback, `expect` after it",
    flags: false,
    source: [
      `test("s12: warns inside a callback", () => {`,
      `  items.forEach(i => {`,
      `    if (!i.ok) {`,
      `      console.warn("WARN: one is bad");`,
      `      return;`,
      `    }`,
      `    seen.push(i);`,
      `  });`,
      `  expect(seen.length, "m").toBeGreaterThan(0);`,
      `});`,
    ].join("\n"),
  },
];

/**
 * For each NOT-FLAG shape whose answer the merged token scan got wrong, the
 * same fixture with the one feature under test removed.
 *
 * Every one must FLAG. Without these the three cases are satisfied by a
 * predicate that happens to answer `–` for an unrelated reason, which is
 * exactly how #1555's own shape-3 reading came to be wrong.
 */
const NEGATIVE_CONTROLS: { n: number; removed: string; source: string }[] = [
  {
    n: 3,
    removed: "the `throw`",
    source: [
      `test("s3-control: warns, no throw", () => {`,
      `  if (!a) {`,
      `    console.warn("WARN: context for the failure below");`,
      `  }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 11,
    removed: "the asserting `finally`",
    source: [
      `test("s11-control: warns and returns inside a try with no finally", () => {`,
      `  try {`,
      `    console.warn("WARN: odd");`,
      `    return;`,
      `  } catch (e) {`,
      `    rethrow(e);`,
      `  }`,
      `});`,
    ].join("\n"),
  },
  {
    n: 12,
    removed: "the `expect` after the callback",
    source: [
      `test("s12-control: warns inside a callback, nothing after it", () => {`,
      `  items.forEach(i => {`,
      `    if (!i.ok) {`,
      `      console.warn("WARN: one is bad");`,
      `      return;`,
      `    }`,
      `    seen.push(i);`,
      `  });`,
      `});`,
    ].join("\n"),
  },
];

describe("SC-2520, SC-2521 (#1555): every way a warn path can terminate", () => {
  for (const s of PATH_SHAPES) {
    test(`shape ${s.n} — ${s.shape} — ${s.flags ? "FLAG" : "not flagged"}`, () => {
      // Parsed as exactly one check first. A fixture that did not parse would
      // answer `–` for every shape and pass seven of the twelve for free.
      expect(gateChecks(s.source).length, "the fixture did not parse as one check").toBe(1);
      expect(
        unassertedWarnPaths(s.source).length,
        s.flags
          ? `shape ${s.n} leaves the check with nothing asserted and is not being named`
          : `shape ${s.n} is a false finding — the path does reach an assertion, or it ` +
            "cannot leave the check without failing",
      ).toBe(s.flags ? 1 : 0);
    });
  }

  test("nine of the twelve must NOT flag, or the battery proves nothing", () => {
    // A predicate that flags everything satisfies every positive case. This
    // pins the balance so the negative half cannot be quietly dropped.
    //
    // NINE, not the seven #1555's acceptance text says. Its own table has
    // three FLAG rows — 1, 2 and 9 — so the prose count disagrees with the
    // table beside it. The table is the specification and the count is a
    // miscount; recorded here rather than silently resolved, because a
    // battery that quietly adopts the smaller number is a battery two cases
    // short.
    expect(PATH_SHAPES.filter(s => !s.flags).length).toBe(9);
    expect(PATH_SHAPES.filter(s => s.flags).length).toBe(3);
    expect(PATH_SHAPES.length).toBe(12);
  });

  for (const c of NEGATIVE_CONTROLS) {
    test(`shape ${c.n}'s control — with ${c.removed} removed it DOES flag`, () => {
      expect(
        unassertedWarnPaths(c.source).length,
        `shape ${c.n} answers "not flagged" for a reason other than ${c.removed}, so the ` +
          "case is green by construction and would not notice losing it",
      ).toBe(1);
    });
  }

  test("a source that does not parse is a refusal, not an empty finding list", () => {
    // The first shape in `.claude/rules/checks-must-be-able-to-fail.md`. A
    // parse failure that returned [] reads exactly like a clean file, and the
    // whole audit would go quietly green.
    const broken = `test("a: unbalanced", () => { if (a { console.warn("x"); });`;
    expect(() => unassertedWarnPaths(broken)).toThrow(/UNMEASURED/);
  });

  test("the re-measured population of the real gate suite, named", () => {
    // #1555 asked for the population to be re-measured after the predicate
    // changed, and for any movement to be NAMED rather than reported as a
    // delta. Written as an assertion instead of prose so the next change to
    // either side has to come past it.
    //
    // The CHECK population did not move: body-level 3 and path-level 5 here,
    // the same five names, identical to what the token scan read. That is
    // zero spread across five implementations of this predicate — v1..v4 and
    // this one — which is the result, not a non-result.
    //
    // The PATH population did move, by one, and it is the same single path on
    // every tree measured: the INNER warn of `spec-decision-compliance`, the
    // one inside the triple-nested loop. The token scan could not see it
    // because its running-minimum rule — added in PR #1539's round 1 to stop
    // a sibling branch's `return` closing a warn's path — treats the warn's
    // block closing as the path having "merged back into the main flow and
    // reached whatever that flow asserts". Here the main flow asserts
    // nothing, so merging back is not coverage. An under-report, which is the
    // safe direction, and invisible in the check population because the same
    // check is already named through its second warn.
    const body = checksWithoutAssertions(gateSource).map(c => c.name).sort();
    const path = checksThatCannotFail(gateSource).map(c => c.name).sort();
    expect(body.length, "the body-level reading moved").toBe(3);
    expect(
      path,
      "the path-level population of gates/workflow.test.ts moved. That is news, not a " +
        "number to adjust: say which checks entered or left and why. A check that LEFT " +
        "should have gained a real assertion — delete its WARN_TIER_CHECKS entry in the " +
        "same commit. A check that ENTERED needs an entry with a reason, or an assertion.",
    ).toEqual(Object.keys(WARN_TIER_CHECKS).sort());

    const paths = unassertedWarnPaths(gateSource);
    const perCheck = new Map<string, number>();
    for (const p of paths) perCheck.set(p.check, (perCheck.get(p.check) ?? 0) + 1);
    expect(
      perCheck.get("spec-decision-compliance: AC language aligns with spec decisions"),
      "spec-decision-compliance has TWO unasserted warn paths, not one — the inner warn " +
        "inside the nested loops as well as the trailing summary warn. The token scan saw " +
        "only the second. If this is 1 again the running-minimum blind spot is back.",
    ).toBe(2);
    expect(paths.length, "the path-level reading of the whole suite moved").toBe(8);
  });

  test("the warn's own line is reported, not the check's", () => {
    // The report has to point at the PATH. Node positions index the
    // transpiled text, where comments and blank lines are gone, so this is
    // the case that holds the ordinal mapping back onto the original honest.
    const src = [
      `test("a: two branches, one warns", () => {`,
      `  // a comment, which the transpiler drops`,
      ``,
      `  if (!v) {`,
      `    console.warn("WARN: missing");`,
      `    return;`,
      `  }`,
      `  expect(v, "m").toBe(true);`,
      `});`,
    ].join("\n");
    const paths = unassertedWarnPaths(src);
    expect(paths.length).toBe(1);
    expect(paths[0]!.warnLine, "the warn is on line 5 of the original source").toBe(5);
    expect(paths[0]!.line, "and the check opens on line 1").toBe(1);
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
