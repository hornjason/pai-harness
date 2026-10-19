/**
 * #659 AC-1 — an evidence command that emits MORE THAN ONE value, judged by
 * ONE threshold.
 *
 * Measured on `wf_2abbe96f-546`, issue #646. Its AC-9 carried
 *
 *   grep -c -E 'SKIP_STATES|pattern: …' scripts/persist-compliance.ts; grep -c 'UNCLASSIFIED_SKIP' scripts/persist-compliance.ts
 *
 * (the first pattern is elided here only because it contains the sequence
 * that would close this comment; `MEASURED_COMMAND` below carries it whole)
 *
 * against `{op: "==", value: 0}`. Two commands, two numbers — `0` and `2` at
 * both of the run's build commits — and one threshold. The scorer recorded
 * `{type: "command-output", content: "2"}`, the SECOND number, which the AC
 * required to be non-zero, and the verdict came back FAIL over code that
 * satisfied the criterion.
 *
 * ## Why this is a satisfiability defect and not a scoring bug
 *
 * `lib/evidence-satisfiability.ts` refuses only what is wrong for ALL
 * possible code. This clears that bar: whichever number the scorer reads is
 * a property of the scorer, not of the tree, and no implementation can make
 * the pair of numbers into the one value `== 0` needs. The AC does not say
 * which half it means, so there is no implementation under which the verdict
 * means what the statement says.
 *
 * ## The boundary, and why the clause is narrow
 *
 * Two counts against a NUMERIC threshold cannot be scored — `"0\n2"` is not
 * a number. Two text-emitting commands against `contains` can be: the
 * concatenation is text and the substring may be in it. So the clause asks
 * for a numeric operator, and the negative cases below are as load-bearing
 * as the positive ones (`.claude/rules/checks-must-be-able-to-fail.md` — a
 * refuser that rejects every `;` blocks more correct runs than it saves).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import { satisfiabilityRefusal } from "../../lib/evidence-satisfiability";
import { prevalidateEvidence } from "../../lib/evidence-prevalidator";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The command `wf_2abbe96f-546`'s AC-9 carried, verbatim from its state file. */
const MEASURED_COMMAND =
  "grep -c -E 'SKIP_STATES|pattern: */(TIER|reinforcement|no suitable)' scripts/persist-compliance.ts" +
  "; grep -c 'UNCLASSIFIED_SKIP' scripts/persist-compliance.ts";

const ac = (command: string, op?: string, value: string | number = 0) => ({
  id: "AC-9",
  evidenceMethod: { type: "COMMAND", command },
  ...(op ? { threshold: { op, value } } : {}),
});

describe("#659 AC-1: the measured command", () => {
  test("the AC-9 command from wf_2abbe96f-546 is refused", () => {
    const refusal = satisfiabilityRefusal(ac(MEASURED_COMMAND, "==", 0));
    expect(refusal, "the two-value command was accepted").not.toBeNull();
    expect(refusal, "the refusal does not say how many values are produced").toMatch(/\b2\b/);
  });

  test("its two halves really do answer differently, so the ambiguity is not hypothetical", () => {
    // The fixture is MEASURED, not described. If both greps returned the same
    // number the AC would be merely redundant, and a refusal over it would be
    // a refusal of a working command. They do not: at the run's build commit
    // the first is 0 and the second is 2, and `== 0` holds of one and fails
    // of the other.
    const show = spawnSync("git", ["-C", REPO_ROOT, "show", `b08b3a37:scripts/persist-compliance.ts`], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(show.status, `git show failed: ${show.stderr}`).toBe(0);
    const lines = show.stdout.split("\n");
    const first = lines.filter(l => /SKIP_STATES|pattern: *\/(TIER|reinforcement|no suitable)/.test(l)).length;
    const second = lines.filter(l => /UNCLASSIFIED_SKIP/.test(l)).length;
    expect({ first, second }).toEqual({ first: 0, second: 2 });
  });

  test("either half ALONE is accepted, so the refusal is about the pair", () => {
    for (const half of MEASURED_COMMAND.split("; ")) {
      expect(satisfiabilityRefusal(ac(half, "==", 0)), half).toBeNull();
    }
  });
});

describe("#659 AC-1: what the clause refuses", () => {
  test("two counting commands joined by ; or && are refused", () => {
    for (const command of [
      `grep -c 'a' f.ts; grep -c 'b' f.ts`,
      `grep -c 'a' f.ts && grep -c 'b' f.ts`,
      `grep 'a' f.ts | wc -l; grep -c 'b' f.ts`,
      `grep -c 'a' f.ts\ngrep -c 'b' f.ts`,
      `grep -c 'a' f.ts; grep -c 'b' f.ts; grep -c 'c' f.ts`,
    ]) {
      expect(satisfiabilityRefusal(ac(command, "==", 0)), command).not.toBeNull();
    }
  });

  test("every numeric operator is refused, and only numeric ones", () => {
    for (const op of [">=", "<=", ">", "<", "==", "!="]) {
      expect(satisfiabilityRefusal(ac(MEASURED_COMMAND, op, 1)), op).not.toBeNull();
    }
    // `contains` and `exists` read the output as TEXT, and the concatenation
    // of two counts is text that may contain the value, so THIS clause stays
    // quiet for both. `contains` is still refused — by the older
    // count-compared-as-text clause (SC-857), which is a different sentence
    // about a different defect, and asserting on the sentence is what keeps
    // the two clauses distinguishable.
    const asText = satisfiabilityRefusal(ac(MEASURED_COMMAND, "contains", "2"));
    expect(asText).not.toBeNull();
    expect(asText, "the multi-value clause fired on a text comparison").not.toContain("separate commands");
    expect(satisfiabilityRefusal(ac(MEASURED_COMMAND, "exists", "true"))).toBeNull();
    // …and with no threshold at all there is nothing to be unsatisfiable
    // against. `missingEvidenceViolations` owns absence (SC-859).
    expect(satisfiabilityRefusal(ac(MEASURED_COMMAND))).toBeNull();
  });
});

describe("#659 AC-1: what the clause must NOT refuse", () => {
  test("one counting command with a prelude or a fallback is accepted", () => {
    for (const command of [
      `cd lib; grep -c 'a' f.ts`,
      `grep -c 'a' f.ts || true`,
      `set -e; grep -c 'a' f.ts`,
      `grep -c 'a' f.ts; echo done`,
      `git fetch origin && grep -c 'a' f.ts`,
    ]) {
      expect(satisfiabilityRefusal(ac(command, "==", 0)), command).toBeNull();
    }
  });

  test("a ; or && inside a quoted pattern does not split the command", () => {
    // The tokeniser half. A splitter that ignored quotes would read this as
    // two commands and refuse a working one, which is the direction this
    // module is not allowed to be wrong in.
    for (const command of [
      `grep -c 'a;b' f.ts`,
      `grep -c "a && b" f.ts`,
      `grep -c 'the decision classifies; the sentence does not' f.ts`,
    ]) {
      expect(satisfiabilityRefusal(ac(command, "==", 0)), command).toBeNull();
    }
  });

  test("two text-emitting commands are not refused by this clause", () => {
    // Deliberate. `grep -n` prints lines, and a single threshold over the
    // concatenation of two line lists is satisfiable. Only a pair of VALUES
    // against a value threshold is provably unscoreable.
    expect(satisfiabilityRefusal(ac(`grep -n 'a' f.ts; grep -n 'b' f.ts`, "contains", "a"))).toBeNull();
  });

  test("the existing clauses are unchanged", () => {
    // Positive controls from test/evidence-satisfiability.test.ts, re-asserted
    // here because a splitter that mangled `stages()` would silence them.
    expect(satisfiabilityRefusal(ac(`grep -nE 'SC-\\w+' lib/conformity.ts`, ">=", 1))).toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -n 'SC-\\w+' lib/conformity.ts`, ">=", 1))).not.toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts | wc -l`, ">=", 1))).not.toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, ">=", 1))).toBeNull();
  });
});

describe("#659 AC-1: the refusal reaches pre-validation", () => {
  test("the AC is classified broken and needsRewrite, never dry-run and scored", async () => {
    const results = await prevalidateEvidence(
      [
        { id: "AC-9", evidenceMethod: { type: "GREP_CHECK", command: MEASURED_COMMAND }, threshold: { op: "==", value: 0 } },
        // The control: one command, the same shape, over the same file. A
        // pre-validator that refused everything would satisfy the case above
        // and stop the pipeline authoring any evidence at all.
        { id: "AC-8", evidenceMethod: { type: "GREP_CHECK", command: `grep -c 'UNCLASSIFIED_SKIP' scripts/persist-compliance.ts` }, threshold: { op: ">=", value: 1 } },
      ],
      REPO_ROOT,
    );
    const nine = results.find(r => r.id === "AC-9");
    expect(nine?.status, JSON.stringify(nine)).toBe("broken");
    expect(nine?.needsRewrite).toBe(true);
    expect(nine?.diagnostic).toContain("The evidence cannot satisfy its own threshold");
    expect(results.find(r => r.id === "AC-8")?.status).not.toBe("broken");
  });
});
