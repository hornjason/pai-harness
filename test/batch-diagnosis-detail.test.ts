/**
 * #700 — the batch diagnosis names the check and throws away the reason.
 *
 * `parseTestResults` already recovers bun's error excerpt for every failing
 * check and stores it on `GateResult.detail` (`gates/gate-executor.ts:104-121`).
 * `printBatchDiagnosis` then printed `r.check` and nothing else, so the one
 * field that says WHY never reached the operator.
 *
 * What that cost, with the run beside it. #700's trio reproduces only in CI,
 * which makes a red run the scarce resource. #726 widened `expectGateGreen` so
 * the gate's own output survives, and the next red run — `main` at `71e3f413`,
 * run `39325676895` — printed:
 *
 *     BATCH DIAGNOSIS: 2 failures — fix all before re-running
 *       AC/Evidence (2): brief-ac-alignment: brief covers all ACs,
 *                        brief-ac-alignment: brief covers all ACs
 *
 * A name, and only a name. `gates/workflow.test.ts:1212` fails two different
 * ways — the brief file is absent at `:1221`, or it is present and missing an
 * id at `:1230` — and those are different bugs with different fixes. Neither
 * assertion message appears anywhere in that log: `grep -c` over the whole run
 * gives 0 for `brief missing AC ids` and 0 for `brief file required when
 * Marcus spawned`. The information existed on the result object and was
 * dropped one line before anyone could read it.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Append `r.detail` to the comma-joined name list.** One expression, the
 * detail stops being dropped, and the output becomes a single unreadable line
 * — bun's excerpts are multi-line source quotes, so N failures produce one
 * paragraph with no boundary between them and no way to tell which fragment
 * belongs to which check. That is the defect this issue is about wearing a
 * fix: the reason is present and still not attributable.
 *
 * Do these cases survive it? Yes, NON-vacuously, and by construction rather
 * than by luck: `AC-4` asserts each failure's detail is attributable to its
 * own check, and `AC-5` asserts a multi-line detail does not collapse the
 * structure. Both are red under the one-expression version. `AC-1` alone
 * would go green under it, which is exactly why it is not the only case.
 *
 * ## One binding
 *
 * `batchDiagnosisLines` is exported and `printBatchDiagnosis` is the only
 * caller, so there is one thing to mutate and the cases can watch it stop
 * reporting. A second composition inlined at the call site would survive any
 * mutation of this one and the cases would hold it up —
 * `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape.
 */
import { describe, expect, test } from "bun:test";

import { batchDiagnosisLines } from "../gates/gate-executor";
import type { GateResult } from "../gates/orchestrator";

const fail = (check: string, detail: string): GateResult => ({ check, result: "FAIL", detail });
const pass = (check: string): GateResult => ({ check, result: "PASS", detail: "passed" });

/** The shape bun really produces, taken from run 39325676895 rather than invented. */
const BRIEF_MISSING = [
  "error: expect(received).toEqual(expected)",
  "brief-ac-alignment: brief missing AC ids: AC-2",
  "Expected: []",
  "Received: [ \"AC-2\" ]",
].join("\n");

const BRIEF_ABSENT = [
  "error: expect(received).toBe(expected)",
  "Expected: \"brief file required when Marcus spawned (ADR-009 C2)\"",
  "Received: \"marcus-brief.md missing\"",
].join("\n");

describe("#700 AC-1: the reason travels with the name", () => {
  test("a failing check's own detail reaches the output", () => {
    const out = batchDiagnosisLines(1, [fail("brief-ac-alignment: brief covers all ACs", BRIEF_MISSING)]);
    const text = out.join("\n");
    expect(text).toContain("brief-ac-alignment: brief covers all ACs");
    // The line that was missing from a full CI log for a day.
    expect(text).toContain("brief missing AC ids: AC-2");
  });

  test("the categories still group, so this is an addition and not a rewrite", () => {
    // The four buckets are the pre-existing behaviour and nothing here is
    // allowed to quietly drop one. Asserted by NAME rather than by count: a
    // count of four is satisfied by any four headings (#532).
    const out = batchDiagnosisLines(4, [
      fail("B1-adversary: report missing", "d1"),
      fail("acs-have-evidence", "d2"),
      fail("code-pushed", "d3"),
      fail("governing-spec-exists", "d4"),
    ]).join("\n");
    for (const heading of ["Infrastructure (1)", "AC/Evidence (1)", "Chain integrity (1)", "Other (1)"]) {
      expect(out, `${heading} is no longer printed`).toContain(heading);
    }
  });
});

describe("#700 AC-2: nothing is printed when nothing failed", () => {
  test("zero failures produces no lines at all", () => {
    // Not an empty string — no lines. A heading over an empty list reads as a
    // diagnosis that found nothing to say, which is the state this whole
    // issue is about being unable to distinguish from a real one.
    expect(batchDiagnosisLines(0, [pass("a"), pass("b")])).toEqual([]);
  });

  test("a PASS never appears in the diagnosis", () => {
    const out = batchDiagnosisLines(1, [
      pass("this-one-passed"),
      fail("this-one-failed", "because"),
    ]).join("\n");
    expect(out).toContain("this-one-failed");
    expect(out).not.toContain("this-one-passed");
  });
});

describe("#700 AC-3: a failure with nothing to say says that, rather than going quiet", () => {
  test("the parser's own sentinel is relayed, not swallowed", () => {
    // `parseTestResults` writes UNEXPLAINED_FAILURE when the runner printed
    // nothing between two markers (#550). A diagnosis that dropped it would
    // make "the runner said nothing" and "the reporter dropped it"
    // indistinguishable — which is the same substitution one layer up.
    const sentinel = "no explanation was captured for this failure";
    const out = batchDiagnosisLines(1, [fail("tsc-pass", `${sentinel} — and so on (#550).`)]).join("\n");
    expect(out).toContain("tsc-pass");
    expect(out).toContain(sentinel);
  });

  test("an empty detail is reported as absent rather than as a blank line", () => {
    // A blank line under a check name reads as a reason that was asked for
    // and came back empty. `0`, `{}` and silence are indistinguishable from
    // success — `.claude/rules/config-access.md`, Silent Default Substitution.
    const out = batchDiagnosisLines(1, [fail("some-check", "   ")]).join("\n");
    expect(out).toContain("some-check");
    expect(out).toMatch(/no detail was recorded/i);
  });
});

describe("#700 AC-4: each reason is attributable to its own check", () => {
  test("two failures in one category do not merge into one paragraph", () => {
    // The cheapest wrong fix — appending details to the comma-joined name
    // list — satisfies AC-1 and fails here, which is the point of having
    // this case: the reason has to be attributable, not merely present.
    const lines = batchDiagnosisLines(2, [
      fail("brief-ac-alignment: brief covers all ACs", BRIEF_MISSING),
      fail("all-acs-have-evidence", "error: AC-2 has no evidence"),
    ]);

    const briefAt = lines.findIndex(l => l.includes("brief-ac-alignment"));
    const evidenceAt = lines.findIndex(l => l.includes("all-acs-have-evidence"));
    expect(briefAt, "the first check is not named on any line").toBeGreaterThan(-1);
    expect(evidenceAt, "the second check is not named on any line").toBeGreaterThan(-1);
    expect(briefAt).not.toBe(evidenceAt);

    // Each reason sits in the span belonging to its own check. Asserted as a
    // SPAN rather than as "both strings appear somewhere", because both
    // strings appearing somewhere is exactly what the wrong fix achieves.
    const span = (at: number) => {
      const nextAt = lines.findIndex((l, i) => i > at && /^\s{2}\S/.test(l));
      return lines.slice(at, nextAt === -1 ? lines.length : nextAt).join("\n");
    };
    expect(span(briefAt)).toContain("brief missing AC ids: AC-2");
    expect(span(briefAt)).not.toContain("AC-2 has no evidence");
    expect(span(evidenceAt)).toContain("AC-2 has no evidence");
    expect(span(evidenceAt)).not.toContain("brief missing AC ids");
  });
});

describe("#700 AC-5: a multi-line detail stays readable", () => {
  test("every line of a detail is indented under its check, and none is lost", () => {
    const lines = batchDiagnosisLines(1, [fail("brief-ac-alignment", BRIEF_ABSENT)]);
    for (const piece of BRIEF_ABSENT.split("\n")) {
      expect(lines.join("\n"), `"${piece}" was dropped`).toContain(piece);
    }
    // Indented, so a reader can see where one check's reason ends. A detail
    // flush against the left margin is indistinguishable from the next
    // heading in a log that is already 4,000 lines long.
    const detailLines = lines.filter(l => BRIEF_ABSENT.split("\n").some(p => l.includes(p)));
    expect(detailLines.length).toBe(BRIEF_ABSENT.split("\n").length);
    for (const l of detailLines) expect(l).toMatch(/^\s{4,}/);
  });

  test("a detail is bounded, so one runaway failure cannot bury the rest", () => {
    // The whole point of the diagnosis is that it is readable at the end of a
    // long log. An unbounded relay would reintroduce the problem from the
    // other side: #726 removed a 3000-character window because it discarded
    // the answer, and a reporter that prints a megabyte discards it too.
    const huge = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const lines = batchDiagnosisLines(2, [fail("noisy", huge), fail("quiet", "the second reason")]);
    const text = lines.join("\n");
    // The second check survives the first one's noise.
    expect(text).toContain("quiet");
    expect(text).toContain("the second reason");
    // And the truncation says it truncated, rather than just stopping.
    expect(text).toMatch(/truncated/i);
  });
});
