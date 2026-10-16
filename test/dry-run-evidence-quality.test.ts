/**
 * Covers SC-1721..SC-1730 (HARNESS-STANDARD.md), #59 SC-4 and SC-5.
 *
 * #59 asked for a dry run that reports "sizing, AC count, evidence quality,
 * blockers". Three of its five criteria arrived with the issue still open —
 * `DRY_RUN` already stops after scope (SC-1), `lib/evidence-prevalidator.ts`
 * already pre-validates every AC's evidence command (SC-2), and
 * `prevalidationViolations` already refuses on the reading rather than warning
 * (SC-3). What was missing is the last hop: the answer never reached the
 * report. A caller doing a dry run got sizing, an AC list and a scope verdict,
 * and had to open `workflow-state.json` to find out whether any of those ACs
 * could be satisfied at all.
 *
 * **The draft of this feature got the interesting part wrong, and that is what
 * most of this file is about.** The first `dryRunEvidenceQuality` DERIVED a
 * PASS from a scope PASS, on the reasoning that `prevalidationViolations`
 * refuses an absent reading, an `UNMEASURED` one, a `FAIL`, a non-`PASS`
 * verdict and a `PASS` carrying broken ids — so a scope gate that passed could
 * not be hiding a bad reading. Every clause of that is true of the function.
 * It is false of the GATE, because the check sits behind
 * `if (!isVerifyPlus()) return` and `isVerifyPlus` is `["VERIFY","SHIP","DONE"]`.
 * At SCOPE the check returns before it asserts anything, so a scope PASS
 * carries no information about the evidence commands whatsoever.
 *
 * That is exactly the defect class in
 * `.claude/rules/checks-must-be-able-to-fail.md` — a report that would have
 * been green because of what it never looked at — written into the one
 * function whose docstring claimed to have ruled it out. So the entailment is
 * pinned here as a fact about `gates/workflow.test.ts` (SC-1724) rather than
 * trusted as a comment: if the scope gate ever does start refusing on the
 * reading, that test goes red and whoever makes the change has to decide,
 * deliberately, whether the report may derive anything from the verdict.
 *
 * Nothing here matches source text for behaviour it claims. The function is
 * extracted from its markers and RUN, and the dry-run payload is extracted
 * from `workflows/ship.js` and EXECUTED, because this repo's record is that
 * every source-text assertion it has written survived its first mutation.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
const gateChecks = readFileSync(join(REPO_ROOT, "gates", "workflow.test.ts"), "utf-8");
const gateExecutor = readFileSync(join(REPO_ROOT, "gates", "gate-executor.ts"), "utf-8");

const START = "// ──── DRY-RUN-EVIDENCE-QUALITY-START ────";
const END = "// ──── DRY-RUN-EVIDENCE-QUALITY-END ────";

// ── extraction ───────────────────────────────────────────────

type Reading = { verdict?: unknown; brokenAcs?: unknown } | undefined | null;
type Quality = { status: string; blockers: string[]; reason?: string };

function qualityBlock(source = shipSource): string {
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a < 0 || b <= a) {
    throw new Error("workflows/ship.js is missing the DRY-RUN-EVIDENCE-QUALITY markers");
  }
  return source.slice(a, b);
}

/** The reporter, extracted from its markers and executed. */
function loadQuality(source = shipSource): (r: Reading, v: string, f?: unknown) => Quality {
  return new Function(`${qualityBlock(source)}\nreturn dryRunEvidenceQuality`)();
}

/**
 * `GATE_RESULT_SCHEMA`, lifted and evaluated rather than grepped.
 *
 * The schema is the contract that lets the reading cross the sandbox boundary
 * at all. A grep for the property name would pass over a schema that declared
 * it in a comment, or in a sibling object, or with the field nested somewhere
 * the agent runner never reads.
 */
function gateResultSchema(source = shipSource): any {
  const a = source.indexOf("const GATE_RESULT_SCHEMA = {");
  if (a < 0) throw new Error("workflows/ship.js no longer declares GATE_RESULT_SCHEMA");
  const b = source.indexOf("\n}\n", a);
  if (b < 0) throw new Error("could not find the end of GATE_RESULT_SCHEMA");
  return new Function(`${source.slice(a, b + 3)}\nreturn GATE_RESULT_SCHEMA`)();
}

/**
 * ship.js's own `if (DRY_RUN) { … }` block, executed over a planted run.
 *
 * Every executed line is lifted verbatim. The only things this file supplies
 * are the bindings the block closes over, which is the whole point: a payload
 * test that rebuilt the object would assert that this file can write an object
 * literal.
 */
function runDryRunBlock(source = shipSource, planted: Record<string, unknown> = {}): any {
  const a = source.indexOf("if (DRY_RUN) {");
  if (a < 0) throw new Error("workflows/ship.js no longer has a DRY_RUN block");
  const b = source.indexOf("\n}\n", a);
  if (b < 0) throw new Error("could not find the end of the DRY_RUN block");
  const block = source.slice(a, b + 2);

  const names = [
    "DRY_RUN", "ISSUE", "SLUG", "discovery", "scopeVerdict", "evidenceQuality", "WORK_DIR",
  ];
  const env: Record<string, unknown> = {
    DRY_RUN: true,
    ISSUE: 59,
    SLUG: "rungate-59",
    discovery: {
      sizing: "S",
      ceremonyTier: "STANDARD",
      acs: [
        { id: "AC-1", type: "code", statement: "a thing" },
        { id: "AC-2", type: "code", statement: "another thing" },
      ],
      priorWork: null,
    },
    scopeVerdict: "PASS",
    evidenceQuality: { status: "PASS", blockers: [] },
    WORK_DIR: "/tmp/dry-run-evidence-quality-test",
    ...planted,
  };
  const body = ["const log = () => {}", "const inner = () => {", block, "}", "return inner()"].join("\n");
  return new Function(...names, body)(...names.map((n) => env[n]));
}

// ── the reading is carried, never inferred ───────────────────

describe("#59 SC-4: what the report may honestly say", () => {
  test("SC-1721: no reading means UNMEASURED - and a scope PASS does not upgrade it", () => {
    const quality = loadQuality();

    // The draft's bug, stated as a table. Each of these is a scope gate that
    // PASSED while telling the report nothing, and the pre-#59 reasoning
    // called every one of them PASS.
    for (const reading of [undefined, null, {}, "PASS", 0, [], { verdict: "UNMEASURED" }, { verdict: "" }]) {
      const out = quality(reading as Reading, "PASS", []);
      expect(out.status, `${JSON.stringify(reading)} was read as a measurement`).toBe("UNMEASURED");
      expect(out.reason, `${JSON.stringify(reading)} reported UNMEASURED with no reason`).toBeTruthy();
      expect(out.blockers).toEqual([]);
    }

    // A tier whose scope gate never ran has nothing behind it either, and the
    // reason has to say which of the two silences it is — "the gate reported
    // nothing" and "there was no gate" are different problems with different
    // fixes.
    const skipped = quality(undefined, "SKIPPED", []);
    expect(skipped.status).toBe("UNMEASURED");
    expect(skipped.reason).toContain("did not run on this tier");
    expect(quality(undefined, "PASS", []).reason).not.toContain("did not run on this tier");

    // And the positive control: a real PASS reading still reports PASS, so
    // "always UNMEASURED" does not satisfy the rows above.
    expect(quality({ verdict: "PASS", brokenAcs: [] }, "PASS", []).status).toBe("PASS");
  });

  test("SC-1722: a FAIL reading names the broken ACs - and says so when it cannot", () => {
    const quality = loadQuality();

    const named = quality({ verdict: "FAIL", brokenAcs: ["AC-2", "AC-5"] }, "PASS", []);
    expect(named.status).toBe("FAIL");
    expect(named.blockers).toHaveLength(1);
    expect(named.blockers[0]).toContain("AC-2");
    expect(named.blockers[0]).toContain("AC-5");

    // A FAIL with nothing to point at is still a FAIL, and must say that the
    // refusal cannot name what to fix rather than presenting an empty blocker
    // list — which reads identically to a clean run.
    const anonymous = quality({ verdict: "FAIL", brokenAcs: [] }, "PASS", []);
    expect(anonymous.status).toBe("FAIL");
    expect(anonymous.blockers).toHaveLength(1);
    expect(anonymous.blockers[0]).toContain("no broken AC ids");
  });

  test("SC-1723: a PASS carrying broken ACs is a contradiction - not a pass", () => {
    const quality = loadQuality();
    const out = quality({ verdict: "PASS", brokenAcs: ["AC-3"] }, "PASS", []);
    expect(out.status).toBe("FAIL");
    expect(out.blockers[0]).toContain("AC-3");

    // This mirrors `prevalidationViolations`'s last branch deliberately, and
    // the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md` says
    // to write down why two deciders are allowed to agree. They are not one
    // guard here: that one refuses a run at VERIFY and this one labels a
    // report at SCOPE, they read different inputs on different phases, and
    // deleting either leaves the other unable to cover the other's case. The
    // shared row is asserted in both files against the same shape so the pair
    // cannot drift into disagreeing.
    expect(gateChecks).toContain("evidence pre-validation: PASS recorded alongside broken evidence commands");
  });

  test("SC-1724: a scope PASS entails nothing about the evidence - the gate does not check it there", () => {
    // The load-bearing fact, and the reason this function carries the reading
    // instead of deriving it.
    //
    // The scope gate TAKES the reading…
    expect(gateExecutor).toContain('await stampEvidencePrevalidation(state, "scope")');

    // …and does not REFUSE on it, because the check that would is gated to
    // VERIFY and later. If either of these stops being true, the derivation
    // the draft attempted becomes available and somebody should decide,
    // deliberately, whether to take it.
    const check = gateChecks.slice(
      gateChecks.indexOf('test("evidence-prevalidation:'),
      gateChecks.indexOf("prevalidationViolations(sf(\"evidencePrevalidation\")"),
    );
    expect(check, "the evidence-prevalidation gate check could not be located").not.toBe("");
    expect(check, "the evidence-prevalidation check is no longer gated to VERIFY+").toContain(
      "if (!isVerifyPlus()) return;",
    );
    expect(gateChecks).toContain(
      'const isVerifyPlus = () => { const p = sf("phase"); return ["VERIFY", "SHIP", "DONE"].includes(p); };',
    );

    // And ship.js must not have quietly reacquired the shortcut. The verdict
    // is an ARGUMENT to the reporter, so it is legal to read — what is not
    // legal is a PASS that comes out of the verdict alone, which the first row
    // of SC-1721 is the behavioural half of.
    const quality = loadQuality();
    expect(quality(undefined, "PASS", []).status).not.toBe("PASS");
  });

  test("SC-1725: a gate refusal naming the pre-validation outranks the reading it carries", () => {
    const quality = loadQuality();
    const refusal = "evidence pre-validation: FAIL — broken evidence commands on AC-9";

    // Nothing at SCOPE produces this today — that is SC-1724. It is handled
    // anyway because the alternative is a filter that silently drops a gate
    // refusal the moment the phase gating changes, and a report that discards
    // the one message it most needs to show is worse than one that never had
    // it.
    const out = quality({ verdict: "PASS", brokenAcs: [] }, "FAIL", [refusal, "unrelated: tsc-pass"]);
    expect(out.status).toBe("FAIL");
    expect(out.blockers).toEqual([refusal]);

    // Unrelated failures are not blockers of the EVIDENCE. They still reach
    // the caller through `failures` on the SCOPE_FAILED detail.
    const unrelated = quality({ verdict: "PASS", brokenAcs: [] }, "FAIL", ["tsc-pass: 3 errors"]);
    expect(unrelated.status).toBe("PASS");
    expect(unrelated.blockers).toEqual([]);
  });
});

// ── the wiring ───────────────────────────────────────────────

describe("#59 SC-4: the report, executed from ship.js's own lines", () => {
  test("SC-1726: the dry-run payload carries sizing - AC count - evidence quality and blockers", () => {
    const blockers = ["evidence pre-validation: FAIL — broken evidence commands on AC-2"];
    const out = runDryRunBlock(shipSource, {
      evidenceQuality: { status: "FAIL", blockers },
    });

    // #59 SC-4's four elements, counted rather than asserted in a sentence.
    expect(out.status).toBe("DRY_RUN_COMPLETE");
    expect(out.sizing).toBe("S");
    expect(out.acCount).toBe(2);
    expect(out.evidenceQuality).toEqual({ status: "FAIL", blockers });
    expect(out.blockers).toEqual(blockers);

    // The count must be a count of the ACs, not a literal. A payload hard-wired
    // to 2 passes the line above forever.
    const one = runDryRunBlock(shipSource, {
      discovery: { sizing: "XS", ceremonyTier: "LIGHT", acs: [{ id: "AC-1" }], priorWork: null },
    });
    expect(one.acCount).toBe(1);
    expect(one.sizing).toBe("XS");
  });

  test("SC-1727: the reading is attached to the refusal a blocked dry run actually takes", () => {
    // Control flow, and the reason this is a test rather than a comment. The
    // `SCOPE_FAILED` return sits ABOVE the `if (DRY_RUN)` block, so a dry run
    // whose scope gate fails never reaches its own report. A report that only
    // the passing path gets is a report nobody in trouble ever reads.
    const refusalAt = shipSource.indexOf("if (scopeVerdict === 'FAIL') return await terminalFailure('SCOPE_FAILED'");
    const dryRunAt = shipSource.indexOf("if (DRY_RUN) {");
    expect(refusalAt).toBeGreaterThan(0);
    expect(refusalAt, "the DRY_RUN block now precedes the scope refusal").toBeLessThan(dryRunAt);

    const refusal = shipSource.slice(refusalAt, shipSource.indexOf("\n", refusalAt));
    expect(refusal).toContain("evidenceQuality");
    expect(refusal).toContain("failures: scopeFailures");

    // And the reading reaches the reporter from the gate result, not from the
    // verdict. `test/ship-scope-verdict.test.ts` executes these same lines.
    expect(shipSource).toContain(
      "const evidenceQuality = dryRunEvidenceQuality(scopeResult?.evidencePrevalidation, scopeVerdict, scopeFailures)",
    );
  });

  test("SC-1728: the gate result schema declares the field the reading crosses on", () => {
    const schema = gateResultSchema();
    const field = schema.properties?.evidencePrevalidation;
    expect(field, "GATE_RESULT_SCHEMA no longer carries the pre-validation reading").toBeTruthy();
    expect(field.properties.verdict.enum).toEqual(["PASS", "FAIL", "UNMEASURED"]);
    expect(field.properties.brokenAcs.type).toBe("array");

    // The gate prompt has to ASK for it, or the schema is a slot nothing
    // fills — and it has to ask for the reading rather than for an opinion,
    // which is the same mistake as the draft's in the agent's hands.
    expect(shipSource).toContain("Also report evidencePrevalidation, copied from");
    expect(shipSource).toContain("Do NOT\n   infer the verdict from whether the gate passed");
  });
});

// ── no side effects (#59 SC-5) ───────────────────────────────

describe("#59 SC-5: a dry run reaches no branch and no issue", () => {
  test("SC-1729: nothing before the dry-run return creates a branch or comments on the issue", () => {
    // SC-5 was unticked and already true, which is the shape that produces a
    // PR full of tests for things nobody changed — except that "already true"
    // is only worth anything if something keeps it true. The prefix is
    // enumerated rather than reasoned about.
    const prefix = shipSource.slice(0, shipSource.indexOf("if (DRY_RUN) {"));
    for (const effect of [
      "git switch -c",
      "git checkout -b",
      "git push",
      "gh issue comment",
      "gh pr create",
    ]) {
      expect(prefix.includes(effect), `a dry run reaches \`${effect}\` before it returns`).toBe(false);
    }
    // Vacuity guard: the slice has to actually contain the three phases a dry
    // run executes, not be a short string left by a marker that moved. An
    // empty prefix satisfies "contains none of these" forever.
    expect(prefix).toContain("phase('Goal')");
    expect(prefix).toContain("phase('Discovery')");
    expect(prefix).toContain("phase('Scope')");

    // And the enumeration catches one that is planted, so it is a check rather
    // than a list of strings the file happens not to contain.
    const planted = shipSource.replace("if (DRY_RUN) {", "await bash('git push')\nif (DRY_RUN) {");
    expect(planted.slice(0, planted.indexOf("if (DRY_RUN) {")).includes("git push")).toBe(true);
  });
});

// ── the markers ──────────────────────────────────────────────

describe("#59 SC-4: the reporter is a marked - reachable block", () => {
  test("SC-1730: each marker appears exactly once and the block runs on every run", () => {
    expect(shipSource.split("DRY-RUN-EVIDENCE-QUALITY-START").length - 1).toBe(1);
    expect(shipSource.split("DRY-RUN-EVIDENCE-QUALITY-END").length - 1).toBe(1);
    expect(shipSource.indexOf(END)).toBeGreaterThan(shipSource.indexOf(START));

    const chain = assertMarkedBlockReachable(shipSource, "DRY-RUN-EVIDENCE-QUALITY");
    expect(chain[0]).toBe("Program");

    const doubled = shipSource.replace(END, `${END}\n${START}\n${END}`);
    expect(() => assertMarkedBlockReachable(doubled, "DRY-RUN-EVIDENCE-QUALITY")).toThrow(/must be unique/);
  });
});
