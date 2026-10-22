import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { PROTECTED_GATES } from "../lib/gate-names";
import { findWorkflowGateFailure } from "../lib/gate-enforcement";

/**
 * #1137 — one registry of protected gate names, not one per consumer.
 * Covers SC-370 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * `hooks/GateResultProtection.hook.ts` hard-coded `scope`, `verify`, `ship`
 * in its Write branch; `lib/gate-enforcement.ts` carried its own
 * `['scope', 'verify', 'ship']` for the same artifact and the same
 * `gates.<name>.result` field. Two enumerations of one set, which diverge
 * silently: adding a fourth protected gate leaves the guard blind to it while
 * the enforcement path sees it, and nothing goes red.
 *
 * The review that raised #1137 named `gate-runner.ts` as the second consumer.
 * There is no such file in this tree. `lib/gate-enforcement.ts` is the real
 * second enumeration, and it is the one bound here.
 *
 * ## Prediction, written before measuring
 *
 * PREDICTED 3 red against `origin/main` @ 7f5df160, all red BY MISSING MODULE
 * rather than by behaviour: `lib/gate-names.ts` does not exist there, so this
 * file cannot load.
 *
 * MEASURED: the prediction was right about the KIND and wrong about the
 * COUNT, in both directions, and the second half is the interesting one.
 * This file holds 4 cases, not the 3 predicted — a vacuity guard was added
 * while writing it. And bun reports a non-loading file as **1** failure, not
 * one per case, so the measured red was `1 fail, 1 error: Cannot find module
 * '../lib/gate-names'`. A file-level red is not 4 case-level reds, and
 * counting it as 4 would be the matching-total-over-a-different-set error.
 * That asymmetry is exactly why the six behavioural cases were split into
 * `test/gate-result-protection.test.ts`, where each one is measurable alone.
 *
 * ## What was broken to prove these can fail
 *
 * The liveness cases iterate the registry rather than restating it, so a name
 * added to `lib/gate-names.ts` is asserted against both consumers with no
 * second edit. Measured by hand on 2026-10-22, with the fix in place:
 *
 *   | mutation                                      | result |
 *   |-----------------------------------------------|--------|
 *   | add a 4th name `merge` to `PROTECTED_GATES`   | 4 pass — live in both, no second edit |
 *   | …and revert `lib/gate-enforcement.ts` to a literal | 2 fail — liveness + second-list |
 *   | …and revert `lib/gate-result-protection.ts` to a literal | 2 fail — liveness + second-list |
 *
 * Each revert reddened the case naming ITS consumer, so the two liveness
 * cases are not one check counted twice. Registry restored to three
 * afterwards; `git diff` confirmed clean.
 */

const ROOT = resolve(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "GateResultProtection.hook.ts");

/** The files that are allowed to decide which gates are protected. */
const CONSUMERS = [
  "hooks/GateResultProtection.hook.ts",
  "lib/gate-result-protection.ts",
  "lib/gate-enforcement.ts",
];

describe("#1137 the protected-gate registry is live in every consumer", () => {
  test("the registry is non-empty and holds the three gates that produce results", () => {
    // A vacuous registry would make every liveness case below pass over an
    // empty loop — `.claude/rules/checks-must-be-able-to-fail.md`, third shape.
    expect(PROTECTED_GATES.length).toBeGreaterThanOrEqual(3);
    expect([...PROTECTED_GATES]).toEqual(expect.arrayContaining(["scope", "verify", "ship"]));
  });

  test("the hook blocks a gate result for EVERY name in the registry", () => {
    const allowed: string[] = [];
    for (const gate of PROTECTED_GATES) {
      const r = spawnSync("bun", [HOOK], {
        input: JSON.stringify({
          tool_name: "Write",
          tool_input: {
            file_path: "/x/work/slug/workflow-state.json",
            content: JSON.stringify({ phase: "BUILD", gates: { [gate]: { result: "PASS" } } }),
          },
        }),
        encoding: "utf-8",
        timeout: 20_000,
      });
      if ((r.stdout ?? "").trim() === "") allowed.push(gate);
    }
    expect(
      allowed,
      `GateResultProtection allowed a gate result for ${allowed.join(", ")}. ` +
        "Its Write branch must iterate PROTECTED_GATES from lib/gate-names.ts, not a literal list.",
    ).toEqual([]);
  });

  test("findWorkflowGateFailure reports a FAIL for EVERY name in the registry", () => {
    const base = mkdtempSync(join(tmpdir(), "gate-names-"));
    try {
      const missed: string[] = [];
      for (const gate of PROTECTED_GATES) {
        const slug = `slug-${gate}`;
        mkdirSync(join(base, slug), { recursive: true });
        writeFileSync(
          join(base, slug, "workflow-state.json"),
          JSON.stringify({
            phase: "VERIFY",
            issue: 1137,
            slug,
            gates: { [gate]: { result: "FAIL", failures: [{ check: "X", detail: "d" }] } },
          }),
        );
        const found = findWorkflowGateFailure(base);
        if (found?.gate !== gate) missed.push(gate);
        rmSync(join(base, slug), { recursive: true, force: true });
      }
      expect(
        missed,
        `findWorkflowGateFailure did not see a FAIL for ${missed.join(", ")}. ` +
          "It must iterate PROTECTED_GATES from lib/gate-names.ts, not a literal list.",
      ).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("no consumer carries its own literal list of the gate names", () => {
    // The whole defect: two lists that agree today. A consumer re-spelling the
    // set is re-introducing it, whether or not it also imports the registry.
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      // a literal array or union mentioning two or more of the gate names
      const literalList =
        /\[\s*(['"`])(scope|verify|ship)\1\s*,\s*(['"`])(scope|verify|ship)\3/.test(src) ||
        /(['"`])(scope|verify|ship)\1\s*\|\s*(['"`])(scope|verify|ship)\3/.test(src);
      if (literalList) offenders.push(rel);
    }
    expect(
      offenders,
      `${offenders.join(", ")} spell the gate set themselves. ` +
        "Import PROTECTED_GATES from lib/gate-names.ts instead — a second list diverges silently.",
    ).toEqual([]);
  });
});
