/**
 * Covers SC-860, SC-861, SC-862, SC-863 (HARNESS-STANDARD.md).
 *
 * #280 — the ship gate consumed whatever evidence-pre-validation block the
 * verify gate left behind. `gates/gate-executor.ts` had a branch for verify
 * and none for ship.
 *
 * Measured on run `wf_ea3e428f-64f`: re-running the pre-validator against
 * `projectRoot` reported 5 of 6 ACs broken; the persisted block said one,
 * was stamped `takenAt: "verify"`, and carried a `checkedAt` an hour old.
 * The ship gate recorded a description of a tree it was not gating.
 *
 * ## What went wrong is narrower than it sounds, and worse
 *
 * The gate still REFUSED, via `all-gates-pass` and the witness check, and it
 * named the real cause. Nothing was let through. What it did was file a
 * **stale artefact as current** — which is exactly what `takenAt` was added
 * in #264 to make impossible to misread.
 *
 * Third instance in one family: #261 (producer in a phase the consumer does
 * not share), #264 (reading taken in the wrong directory and not re-taken on
 * heal), #280 (reading not re-taken at the next phase). Each fix moved the
 * boundary one phase and stopped, which is why the policy is now ONE
 * predicate — `shouldRetakePrevalidation` — rather than a condition inlined
 * at each call site.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ensurePrevalidationPersisted,
  prevalidationForGate,
  shouldRetakePrevalidation,
} from "../../gates/gate-executor";
import { PREVALIDATION_SOURCES, EvidencePrevalidationSchema } from "../../gates/schema";
import { prevalidationViolations } from "../../gates/workflow.test";

const GUIDE = readFileSync(join(import.meta.dir, "..", "..", "gates", "SCHEMA-GUIDE.md"), "utf-8");

/**
 * A state whose single AC's evidence command AGREES with the tree, beside a
 * planted reading that says it does not. The disagreement is the instrument:
 * if the gate re-measures, the verdict flips; if it consumes the block, the
 * verdict is whatever the fixture said.
 */
function plant(takenAt: string | undefined): {
  dir: string;
  sf: string;
  state: Record<string, any>;
} {
  const dir = mkdtempSync(join(tmpdir(), "prevalidation-ship-"));
  const stale = {
    verdict: "FAIL",
    checkedAt: "2026-10-11T04:43:11.000Z",
    acs: [{ id: "AC-1", status: "broken", needsRewrite: true, diagnostic: "measured an hour ago" }],
    reason: null,
    ...(takenAt ? { takenAt } : {}),
  };
  const state: Record<string, any> = {
    schemaVersion: 2,
    issue: 280,
    slug: "prevalidation-ship-fixture",
    projectRoot: dir,
    phase: "SHIP",
    issueGoal: "The ship gate measures its own tree",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the evidence command runs clean on the tree being shipped",
        threshold: { op: "contains", value: "shipped" },
        evidenceMethod: { type: "command", command: "echo shipped" },
      },
    ],
    evidencePrevalidation: stale,
  };
  const sf = join(dir, "workflow-state.json");
  writeFileSync(sf, JSON.stringify(state, null, 2));
  return { dir, sf, state };
}

describe("#280 SC-860: the ship gate re-measures against its own tree", () => {
  test("a stale verify-era reading that disagrees with the tree is replaced", async () => {
    const { sf, state } = plant("verify");

    // The planted block says FAIL. If the gate consumed it, the assertions
    // below would read the fixture's own answer back — so the disagreement
    // with the tree is what makes this measure anything.
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.verdict).toBe("FAIL");

    const retook = await ensurePrevalidationPersisted(state, sf, "ship");
    expect(retook, "the ship gate did not re-measure").toBe(true);

    const reading = JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation;
    expect(reading.takenAt, "the reading still claims the phase that took it").toBe("ship");
    expect(reading.verdict, "the stale FAIL survived its own replacement").toBe("PASS");
    expect(reading.checkedAt).not.toBe("2026-10-11T04:43:11.000Z");
    expect(reading.acs.find((a: any) => a.id === "AC-1").status).toBe("ok");

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  }, 30000);

  test("a SCOPE reading does not survive to ship either — SC-5's decision", async () => {
    // The old condition was `takenAt !== "verify"`, which would have carried a
    // scope reading all the way through. Defensible one phase later,
    // indefensible three: it describes the tree before any work was done.
    const { sf, state } = plant("scope");
    expect(await ensurePrevalidationPersisted(state, sf, "ship")).toBe(true);
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.takenAt).toBe("ship");
  }, 30000);

  test("a scope reading DOES still survive to verify", async () => {
    // The positive control for the decision above. A predicate that re-takes
    // unconditionally everywhere satisfies both cases above and undoes #264.
    const { sf, state } = plant("scope");
    expect(await ensurePrevalidationPersisted(state, sf, "verify")).toBe(false);
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.takenAt).toBe("scope");
  }, 30000);
});

describe("#280 SC-861: the gate→reading mapping is executed, not a branch nobody runs", () => {
  // The first draft of SC-860 called `ensurePrevalidationPersisted("ship")`
  // directly, so deleting `runGate`'s ship branch scored ZERO red across 52
  // tests — the branch existed, nothing observed it. A per-gate `if` inside a
  // 300-line dispatch that spawns bun is unprovable, which is the shape of
  // the bug itself. The mapping is a function now, and this runs it.

  test("ship takes a reading", async () => {
    const { sf, state } = plant("verify");
    expect(await prevalidationForGate("ship", state, sf)).toBe(true);
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.takenAt).toBe("ship");
  }, 30000);

  test("verify takes one too, and stamps its own phase", async () => {
    const { sf, state } = plant("verify");
    expect(await prevalidationForGate("verify", state, sf)).toBe(true);
    expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.takenAt).toBe("verify");
  }, 30000);

  test("no other gate does — scope has its own ordered writer", async () => {
    // The negative half. A mapping that fires for every gate would put the
    // scope write out of the measure-then-persist order
    // `runScopePreflightsAndPersist` exists to hold.
    for (const gate of ["scope", "prove", "merge", ""]) {
      const { sf, state } = plant("verify");
      expect(await prevalidationForGate(gate, state, sf), gate).toBe(false);
      expect(JSON.parse(readFileSync(sf, "utf-8")).evidencePrevalidation.takenAt).toBe("verify");
    }
  }, 30000);

  test("runGate reaches the mapping exactly once, and hands it the live gate", () => {
    // The other link of the chain. The executed cases above prove the
    // mapping is right; this proves `runGate` still consults it, and that it
    // does not pass a literal — which would make the mapping decide nothing.
    const source = readFileSync(join(import.meta.dir, "..", "..", "gates", "gate-executor.ts"), "utf-8");
    const calls = source.match(/await prevalidationForGate\(([^)]*)\)/g) ?? [];
    expect(calls, "runGate no longer calls the mapping").toHaveLength(1);
    expect(calls[0]).toContain("gate, state, sf");
  });
});

describe("#280 SC-861: the retake policy is one predicate, and it is phase-aware", () => {
  const reading = (takenAt?: string) => ({ verdict: "PASS", ...(takenAt ? { takenAt } : {}) });

  test("ship re-takes whatever is there", () => {
    for (const source of [...PREVALIDATION_SOURCES, undefined]) {
      expect(shouldRetakePrevalidation(reading(source), "ship"), String(source)).toBe(true);
    }
  });

  test("verify re-takes a verify reading and preserves the others", () => {
    expect(shouldRetakePrevalidation(reading("verify"), "verify")).toBe(true);
    expect(shouldRetakePrevalidation(reading("scope"), "verify")).toBe(false);
    // Absent `takenAt` on an EXISTING reading means a run older than #264,
    // and preserving it is the behaviour that predates the field.
    expect(shouldRetakePrevalidation(reading(undefined), "verify")).toBe(false);
  });

  test("an absent reading is always re-taken — the #261 case", () => {
    for (const at of ["verify", "ship"] as const) {
      expect(shouldRetakePrevalidation(undefined, at), at).toBe(true);
      expect(shouldRetakePrevalidation(null, at), at).toBe(true);
      expect(shouldRetakePrevalidation("not a reading", at), at).toBe(true);
    }
  });
});

describe("#280 SC-862: the consumer refuses a reading taken before its own phase", () => {
  const clean = {
    verdict: "PASS",
    checkedAt: "2026-10-13T00:00:00.000Z",
    acs: [{ id: "AC-1", status: "ok" }],
    reason: null,
  };

  test("a verify-era reading is refused at SHIP", () => {
    // This is what makes a producer that stops re-measuring go RED rather
    // than quietly stale. #280 was not caught by any check; it was caught by
    // a human reading a timestamp.
    const v = prevalidationViolations({ ...clean, takenAt: "verify" }, "SHIP");
    expect(v, "a verify-era reading was accepted at ship").not.toEqual([]);
    expect(v[0]).toMatch(/taken at `verify`/);
    expect(v[0]).toMatch(/#280/);
  });

  test("a scope-era reading and an unstamped one are refused at SHIP too", () => {
    expect(prevalidationViolations({ ...clean, takenAt: "scope" }, "SHIP")).not.toEqual([]);
    const unstamped = prevalidationViolations(clean, "SHIP");
    expect(unstamped).not.toEqual([]);
    expect(unstamped[0], "an unstamped reading is reported as if it named a phase")
      .toMatch(/unrecorded phase/);
  });

  test("a ship reading passes at SHIP", () => {
    // The positive control. A check that refuses every reading at ship fails
    // every run that reaches it.
    expect(prevalidationViolations({ ...clean, takenAt: "ship" }, "SHIP")).toEqual([]);
    expect(prevalidationViolations({ ...clean, takenAt: "ship" }, "DONE")).toEqual([]);
  });

  test("a scope reading still passes at VERIFY — there is no general staleness rule", () => {
    // Inventing one would turn every LIGHT run red, which is #261 restored.
    expect(prevalidationViolations({ ...clean, takenAt: "scope" }, "VERIFY")).toEqual([]);
    expect(prevalidationViolations({ ...clean, takenAt: "verify" }, "VERIFY")).toEqual([]);
    expect(prevalidationViolations(clean, "VERIFY")).toEqual([]);
    // …and with no phase supplied at all, the phase check cannot fire. The
    // caller passes `sf("phase")`, so this is the shape a pre-#280 caller has.
    expect(prevalidationViolations({ ...clean, takenAt: "verify" })).toEqual([]);
  });

  test("the gate's check site hands the phase over", () => {
    // Measured: dropping `sf("phase")` from the call scored ZERO red, because
    // every case above supplies the phase itself. A phase-aware refusal whose
    // caller never tells it the phase is a refusal that can never fire — the
    // defect one layer up, and the same shape as #280 itself.
    const suite = readFileSync(join(import.meta.dir, "..", "..", "gates", "workflow.test.ts"), "utf-8");
    const calls = suite
      .split("\n")
      .filter((l) => l.includes("prevalidationViolations(") && !l.includes("export function"));
    expect(calls, "the gate suite no longer reads the pre-validation").toHaveLength(1);
    expect(calls[0], "the check site stopped passing the phase").toContain('sf("phase")');
  });

  test("the phase check does not swallow the refusals that already existed", () => {
    // A ship-stamped FAIL must still be refused for BEING a fail, not waved
    // through because its `takenAt` was right.
    const v = prevalidationViolations(
      {
        ...clean,
        verdict: "FAIL",
        takenAt: "ship",
        acs: [{ id: "AC-2", status: "broken", needsRewrite: true, diagnostic: "boom" }],
      },
      "SHIP",
    );
    expect(v).not.toEqual([]);
    expect(v[0]).toMatch(/AC-2/);
    // Absent is still absent, at every phase.
    expect(prevalidationViolations(undefined, "SHIP")[0]).toMatch(/not recorded/);
  });
});

describe("#280 SC-863: SCHEMA-GUIDE.md and PREVALIDATION_SOURCES name the same gates", () => {
  /** The sources named in the guide's `takenAt` row, in the first field table. */
  const documented = (() => {
    const section = GUIDE.slice(GUIDE.indexOf("## evidencePrevalidation"));
    const row = section.split("\n").find((l) => /^\|\s*`takenAt`/.test(l)) ?? "";
    return [...row.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((v) => v !== "takenAt");
  })();

  test("the row exists and names something", () => {
    expect(documented.length, "no `takenAt` row with backticked values found").toBeGreaterThan(0);
  });

  // Both directions, which is what SC-2 asks for: a source added to the enum
  // and left undocumented turns this red, and so does one documented but never
  // added. The field-name parity test in evidence-prevalidation-gate.test.ts
  // cannot see this — `takenAt` is still one field whatever its values are.
  test("every source is documented and every documented source exists", () => {
    expect([...documented].sort()).toEqual([...PREVALIDATION_SOURCES].sort());
  });

  test("the guide records WHAT SURVIVES at each gate, not just the values", () => {
    const section = GUIDE.slice(GUIDE.indexOf("## evidencePrevalidation"));
    expect(section).toContain("shouldRetakePrevalidation");
    expect(section, "the guide does not say the ship gate preserves nothing")
      .toMatch(/\| ship \| \*\*nothing\*\*/);
  });
});
