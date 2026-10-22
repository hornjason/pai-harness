import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { BLOCKING_GATES, RESULT_BEARING_GATES } from "../lib/gate-names";
import { findWorkflowGateFailure } from "../lib/gate-enforcement";

/**
 * #1137 — the guard reads no list of gate names, and the lists that remain
 * answer a different question. Covers SC-370 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * ## What the first draft of this file got wrong
 *
 * It pinned a single `PROTECTED_GATES = ['scope', 'verify', 'ship']` and
 * asserted the guard iterated it. A review round found that list INCOMPLETE,
 * and the finding holds up: `gates/gate-executor.ts` calls
 * `writeGateResult(sf, "merge", …)` twice, `(sf, "gaps", …)` once, and a
 * dynamic `(sf, gate, …)` that `prove` reaches — so `gates.merge.result`,
 * `gates.gaps.result` and `gates.prove.result` are persisted and were all
 * unguarded. Measured against this branch before the fix: a Write of
 * `{"gates":{"merge":{"result":"PASS"}}}` was ALLOWED.
 *
 * None of those three is visible to a `gates\.[a-z]+` grep, which is how they
 * were missed in the first place — the name arrives as a function ARGUMENT
 * and the write is `state.gates[gate] = …`.
 *
 * ## So the fix is no list, not a longer one
 *
 * `lib/gate-result-protection.ts` refuses a `result` under ANY key of
 * `gates`. The cases below therefore do NOT assert that the guard iterates a
 * registry — they assert the opposite property: that a name nothing has ever
 * heard of is refused too.
 *
 * `RESULT_BEARING_GATES` is a TEST POPULATION, not an allowlist. Adding a
 * name to it strengthens the evidence here; forgetting to add one cannot
 * weaken the guard, because the guard never reads it.
 *
 * ## What was broken to prove these can fail
 *
 * Measured by hand on 2026-10-22, against the gate-agnostic implementation:
 * replacing the `Object.entries(gates)` scan in `collectGateResults` with a
 * literal `['scope','verify','ship']` loop reddens the `merge`/`prove`/`gaps`
 * rows of the population case and the unknown-name case, and leaves every
 * other case in this file green. Counts in the PR body.
 */

const ROOT = resolve(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "GateResultProtection.hook.ts");

/** The files allowed to hold an opinion about which gates exist. */
const CONSUMERS = [
  "hooks/GateResultProtection.hook.ts",
  "lib/gate-result-protection.ts",
  "lib/gate-enforcement.ts",
];

function hookAllows(content: string): boolean {
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/x/work/slug/workflow-state.json", content },
    }),
    encoding: "utf-8",
    timeout: 20_000,
  });
  return (r.stdout ?? "").trim() === "";
}

describe("#1137 the guard is gate-agnostic, so no list can make it stale", () => {
  test("the test population is non-empty and covers the blocking gates", () => {
    // A vacuous population would make the case below pass over an empty loop
    // — `.claude/rules/checks-must-be-able-to-fail.md`, third shape.
    expect(RESULT_BEARING_GATES.length).toBeGreaterThanOrEqual(6);
    expect([...RESULT_BEARING_GATES]).toEqual(
      expect.arrayContaining([...BLOCKING_GATES]),
    );
  });

  test("a forged result is refused for EVERY gate that can persist one", () => {
    const allowed = RESULT_BEARING_GATES.filter(gate =>
      hookAllows(JSON.stringify({ phase: "BUILD", gates: { [gate]: { result: "PASS" } } })),
    );
    expect(
      allowed,
      `GateResultProtection allowed a forged result for ${allowed.join(", ")}. ` +
        "The Write branch must scan every key under `gates`, not a list of names.",
    ).toEqual([]);
  });

  test("a forged result is refused for a gate name NOTHING in this repo knows", () => {
    // The property a longer allowlist could never have. If this is green, the
    // completeness of every list in the tree has stopped mattering.
    const unknown = ["quux", "zzz-not-a-gate", "__proto__x", "Scope"];
    const allowed = unknown.filter(gate =>
      hookAllows(JSON.stringify({ gates: { [gate]: { result: "FAIL" } } })),
    );
    expect(
      allowed,
      `A forged result under ${allowed.join(", ")} was allowed. The guard must be gate-agnostic.`,
    ).toEqual([]);
  });

  test("CONTROL: a gate record with no result is still allowed, for any name", () => {
    // The gate-agnostic scan must key on `result`, not on the gate's presence
    // — otherwise it blocks every legitimate write that mentions a gate.
    const blocked = [...RESULT_BEARING_GATES, "quux"].filter(
      gate => !hookAllows(JSON.stringify({ gates: { [gate]: { attempt: 1 } } })),
    );
    expect(blocked, `writes naming ${blocked.join(", ")} with no result were refused`).toEqual([]);
  });
});

describe("#1137 BLOCKING_GATES is a priority list, and is live in its one consumer", () => {
  test("findWorkflowGateFailure reports a FAIL for EVERY blocking gate", () => {
    const base = mkdtempSync(join(tmpdir(), "gate-names-"));
    try {
      const missed: string[] = [];
      for (const gate of BLOCKING_GATES) {
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
        // #1155: `failure` lives on the measured variant only. These fixtures
        // are well-formed, so anything else is itself the failure to report.
        const s = findWorkflowGateFailure(base);
        const found = s.reading === "MEASURED" ? s.failure : null;
        if (found?.gate !== gate) missed.push(gate);
        rmSync(join(base, slug), { recursive: true, force: true });
      }
      expect(
        missed,
        `findWorkflowGateFailure did not see a FAIL for ${missed.join(", ")}. ` +
          "It must iterate BLOCKING_GATES from lib/gate-names.ts, not a literal list.",
      ).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("no consumer carries its own literal list of the gate names", () => {
    const offenders: string[] = [];
    for (const rel of CONSUMERS) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      const literalList =
        /\[\s*(['"`])(scope|verify|ship)\1\s*,\s*(['"`])(scope|verify|ship)\3/.test(src) ||
        /(['"`])(scope|verify|ship)\1\s*\|\s*(['"`])(scope|verify|ship)\3/.test(src);
      if (literalList) offenders.push(rel);
    }
    expect(
      offenders,
      `${offenders.join(", ")} spell the gate set themselves. ` +
        "Import from lib/gate-names.ts instead — a second list diverges silently.",
    ).toEqual([]);
  });
});
