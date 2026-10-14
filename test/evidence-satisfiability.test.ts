/**
 * Covers SC-856, SC-857, SC-858, SC-859 (HARNESS-STANDARD.md).
 *
 * #217 — the discovery agent writes the AC statement, the threshold AND the
 * evidence command in one pass, and nothing then checks that the command it
 * wrote can produce output satisfying the threshold it wrote.
 *
 * Captured live on `wf_5e3ed885-98c`, in a single AC, two independent ways:
 *
 * 1. threshold `contains 'checked: boolean'` against a field legitimately
 *    declared `checked?: boolean`
 * 2. `grep -n 'SC-\w+'` — a BASIC regular expression, where `+` is a
 *    literal. It selects nothing under ANY implementation; `grep -E` returns
 *    lines 199 and 318
 *
 * The second is the one that matters: it is not wrong about that code, it is
 * wrong about all code.
 *
 * ## The boundary this file exists to hold
 *
 * The refuser has to prove a verdict is a CONSTANT, not merely that it is
 * currently unsatisfied. Before the work is done, `grep -c newThing src/`
 * returning 0 against `>= 1` is what a correct AC looks like. So every
 * negative case below is as load-bearing as the positive ones — a refuser
 * that rejects `grep 'checked?: boolean'` (a valid BRE whose `?` is meant
 * literally) would block more correct runs than it saves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { satisfiabilityRefusal } from "../lib/evidence-satisfiability";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";

const REPO_ROOT = join(import.meta.dir, "..");

const ac = (command: string, op?: string, value: string | number = 1) => ({
  id: "AC-1",
  evidenceMethod: { type: "COMMAND", command },
  ...(op ? { threshold: { op, value } } : {}),
});

describe("#217 SC-856: a quantifier that a basic regular expression reads as a literal", () => {
  test("the exact clause from wf_5e3ed885-98c is refused", () => {
    const refusal = satisfiabilityRefusal(
      ac(`grep -n 'SC-\\w+' lib/conformity.ts | grep 'x]'`, ">=", 1),
    );
    expect(refusal, "the unsatisfiable BRE was accepted").not.toBeNull();
    expect(refusal, "the refusal does not name the construct").toContain("\\w");
  });

  test("the same pattern with -E is accepted", () => {
    // The positive control. A refuser that rejects every grep satisfies the
    // case above and stops the pipeline authoring any evidence at all.
    for (const cmd of [
      `grep -nE 'SC-\\w+' lib/conformity.ts`,
      `grep -E 'SC-\\w+' lib/conformity.ts`,
      `grep -P 'SC-\\w+' lib/conformity.ts`,
      `egrep 'SC-\\w+' lib/conformity.ts`,
      `grep --extended-regexp 'SC-\\w+' lib/conformity.ts`,
    ]) {
      expect(satisfiabilityRefusal(ac(cmd, ">=", 1)), cmd).toBeNull();
    }
  });

  test("a quantifier after a class or a group is refused", () => {
    for (const pattern of [`SC-\\w+`, `[0-9]+`, `a\\d?`, `\\s+$`, `(foo)?`, `[a-z]+bar`]) {
      expect(
        satisfiabilityRefusal(ac(`grep '${pattern}' f.ts`, ">=", 1)),
        `grep '${pattern}' was read as a working basic regular expression`,
      ).not.toBeNull();
    }
  });

  test("a literal + or ? that an author plainly meant is NOT refused", () => {
    // The half that keeps this usable. Every one of these is a correct BRE
    // and several are shapes this repo's own ACs use. `checked?: boolean` is
    // the field from the measured run — refusing it would turn #217's own
    // reproduction into a false refusal.
    for (const pattern of [
      `checked?: boolean`,
      `function foo(`,
      `C++`,
      `a+b`,
      `SC-`,
      `lib/conformity`,
      `^export `,
      `a.c`,
      `[0-9]*`,
      `\\w*`,
      `a\\+`,
    ]) {
      expect(
        satisfiabilityRefusal(ac(`grep '${pattern}' f.ts`, ">=", 1)),
        `grep '${pattern}' is a valid BRE and was refused`,
      ).toBeNull();
    }
  });

  test("the pattern is found wherever grep's flags put it", () => {
    // Flag parsing is the part most likely to go quietly blind: a parser that
    // mistook a filename for the pattern would refuse nothing and look
    // identical to a clean tree.
    for (const cmd of [
      `grep -e 'a\\w+' f.ts`,
      `grep -n -e 'a\\w+' f.ts`,
      `grep -m 3 'a\\w+' f.ts`,
      `grep --include=*.ts -r 'a\\w+' lib`,
      `grep -rn 'a\\w+' lib`,
      `cat f.ts | grep 'a\\w+'`,
    ]) {
      expect(satisfiabilityRefusal(ac(cmd, ">=", 1)), cmd).not.toBeNull();
    }
    // …and the same flags must not make a filename look like a pattern.
    expect(satisfiabilityRefusal(ac(`grep -rn 'plain' lib/a\\w+.ts`, ">=", 1))).toBeNull();
  });

  test("a pattern that begins with a dash is found, not skipped as a flag", () => {
    // The case that makes `-e` and `--` load-bearing rather than decorative.
    // Dropping their handling changes NOTHING for an ordinary pattern — it is
    // the next token either way — so without this the branch could be deleted
    // and every other assertion here would stay green. Measured: removing it
    // scored 0 red before this case existed.
    expect(satisfiabilityRefusal(ac(`grep -e '-\\w+' f.ts`, ">=", 1))).not.toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -- '-\\w+' f.ts`, ">=", 1))).not.toBeNull();
    // The other side: a dash-leading pattern that is a valid BRE is accepted,
    // so this is not just "anything after -e is suspicious".
    expect(satisfiabilityRefusal(ac(`grep -e '-plain' f.ts`, ">=", 1))).toBeNull();
  });

  test("a non-grep command is not inspected for BRE at all", () => {
    expect(satisfiabilityRefusal(ac(`bun test 2>&1 | tail -1`, ">=", 1))).toBeNull();
    expect(satisfiabilityRefusal(ac(`rg 'a\\w+' lib`, ">=", 1))).toBeNull();
  });
});

describe("#217 SC-857: a count compared as text", () => {
  test("grep -c with `contains` is refused", () => {
    const refusal = satisfiabilityRefusal(ac(`grep -c 'foo' f.ts`, "contains", "foo"));
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/count/i);
  });

  test("the counting commands are recognised, not just grep -c", () => {
    for (const command of [
      `grep -c 'x' f.ts`,
      `grep 'x' f.ts | wc -l`,
      `ls lib | wc -l | tr -d ' '`,
      `grep -nc 'x' f.ts`,
    ]) {
      expect(
        satisfiabilityRefusal({ id: "AC-1", evidenceMethod: { command }, threshold: { op: "contains", value: "x" } }),
        `${command} emits a count and was accepted with a 'contains' threshold`,
      ).not.toBeNull();
    }
  });

  test("a counting command with a numeric operator is accepted", () => {
    // Refusing every `grep -c` would make the most common evidence shape in
    // the repo unusable.
    for (const op of [">=", "<=", ">", "<", "==", "!="]) {
      expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, op, 1)), op).toBeNull();
    }
  });

  test("a text-emitting command with `contains` is accepted", () => {
    expect(satisfiabilityRefusal(ac(`grep -o 'x' f.ts`, "contains", "x"))).toBeNull();
    expect(satisfiabilityRefusal(ac(`cat f.ts`, "contains", "x"))).toBeNull();
    // `wc -l` upstream of a text stage is not the producing stage.
    expect(satisfiabilityRefusal(ac(`wc -l f.ts | awk '{print $2}'`, "contains", "f.ts"))).toBeNull();
  });
});

describe("#217 SC-858: a count of counts, whose answer cannot vary with the code", () => {
  test("grep -c piped into wc -l is refused even with a numeric threshold", () => {
    // ship.js's own comment calls this the "always-1 bug". A threshold over a
    // constant is a check that cannot fail — the house defect, reached from
    // the other side.
    const refusal = satisfiabilityRefusal(ac(`grep -c 'x' f.ts | wc -l`, ">=", 1));
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/wc -l/);
  });

  test("the trailing tr does not hide it", () => {
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts | wc -l | tr -d ' '`, ">=", 1))).not.toBeNull();
  });

  test("a plain grep piped into wc -l is the correct idiom and is accepted", () => {
    expect(satisfiabilityRefusal(ac(`grep 'x' f.ts | wc -l`, ">=", 1))).toBeNull();
    expect(satisfiabilityRefusal(ac(`grep -c 'x' f.ts`, ">=", 1))).toBeNull();
  });
});

describe("#217 SC-859: an AC the refuser cannot read is not refused", () => {
  test("absent command, absent threshold, absent AC", () => {
    // Absence is a different problem and `missingEvidenceViolations` owns it.
    // Refusing here too would report one AC twice under two explanations.
    expect(satisfiabilityRefusal({ id: "AC-1" })).toBeNull();
    expect(satisfiabilityRefusal({ id: "AC-1", evidenceMethod: {} })).toBeNull();
    expect(satisfiabilityRefusal({ id: "AC-1", evidenceMethod: { command: "   " } })).toBeNull();
    expect(satisfiabilityRefusal(null)).toBeNull();
    expect(satisfiabilityRefusal(undefined)).toBeNull();
  });

  test("a grep whose pattern cannot be located is not refused", () => {
    // Null means "not provably unsatisfiable", not "verified satisfiable".
    expect(satisfiabilityRefusal(ac(`grep -n`, ">=", 1))).toBeNull();
  });
});

describe("#217 SC-859: the refusal reaches the gate, it is not merely computed", () => {
  // A refuser nothing consults is the same defect one layer up. These run the
  // REAL pre-validator, which is what `measureEvidencePrevalidation` reduces
  // to the verdict the scope gate refuses on.

  test("an unsatisfiable AC is classified broken before it is ever run", async () => {
    const [r] = await prevalidateEvidence(
      [{ id: "AC-1", evidenceMethod: { command: `grep -c 'export' package.json | wc -l` }, threshold: { op: ">=", value: 1 } }] as never,
      REPO_ROOT,
    );
    // That command SUCCEEDS and prints "1". Dry-running it reports `ok`, which
    // is exactly why a dry-run cannot own this question.
    expect(r.status, "a command that runs fine was waved through").toBe("broken");
    expect(r.needsRewrite).toBe(true);
    expect(r.diagnostic).toMatch(/wc -l/);
  });

  test("the BRE case is classified broken rather than merely empty", async () => {
    const [r] = await prevalidateEvidence(
      [{ id: "AC-1", evidenceMethod: { command: `grep -c 'name\\w+' package.json` }, threshold: { op: ">=", value: 1 } }] as never,
      REPO_ROOT,
    );
    // `empty` is a WARNING in measureEvidencePrevalidation — only `broken`
    // moves the verdict to FAIL. Before this the run was told the command
    // produced nothing, which is indistinguishable from work not yet done.
    expect(r.status).toBe("broken");
  });

  test("a working AC still pre-validates clean", async () => {
    const [r] = await prevalidateEvidence(
      [{ id: "AC-1", evidenceMethod: { command: `grep -cE 'name' package.json` }, threshold: { op: ">=", value: 1 } }] as never,
      REPO_ROOT,
    );
    expect(r.status).toBe("ok");
  });
});

describe("#217 SC-859: ship.js refuses rather than rewriting the AC", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  test("the silent threshold rewrite is gone", () => {
    // A silently repaired AC is a changed acceptance criterion nobody
    // reviewed. Asserted on the LOG LINE the repair emitted, because that
    // string is what a reader of a past run actually saw.
    expect(
      shipSource,
      "ship.js still rewrites a 'contains' threshold into '>= 1' behind the user's back",
    ).not.toContain("returns count, changed 'contains'");
  });

  test("the evidence-type upgrade only changes a threshold it changed the command for", () => {
    // P1-4 appends `| wc -l` to satisfy the evidence-type ratio, and a
    // threshold must follow a command it actually rewrote. The `grep -c`
    // branch leaves the command alone, so rewriting its threshold there was
    // the same unreviewed edit wearing the upgrade's hat — and it made the
    // measured AC from wf_5e3ed885-98c unreachable by the refuser.
    const start = shipSource.indexOf("P1-4: Enforce evidence-type-ratio");
    const block = shipSource.slice(start, shipSource.indexOf("DECOMPOSE_REQUIRED gate", start));
    expect(start, "the P1-4 block moved or was renamed").toBeGreaterThan(-1);
    const rewriteAt = block.indexOf("op = '>='");
    const elseAt = block.indexOf("| wc -l | tr -d");
    expect(rewriteAt, "the threshold rewrite is gone from the branch that appends | wc -l")
      .toBeGreaterThan(elseAt);
    expect(
      block.slice(0, elseAt),
      "the grep -c branch still rewrites a threshold whose command it did not touch",
    ).not.toContain("op = '>='");
  });

  test("the refuser has exactly one definition", () => {
    const lib = readFileSync(join(REPO_ROOT, "lib", "evidence-satisfiability.ts"), "utf-8");
    expect(lib.match(/export function satisfiabilityRefusal\b/g) ?? []).toHaveLength(1);
  });
});
