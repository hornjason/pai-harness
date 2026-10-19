/**
 * #700 — every `brief-ac-alignment` refusal names the path it resolved.
 *
 * The check failed on five consecutive pushes to `main` (`71e3f413`,
 * `eaf4bf24`, `e1b39c8c`, `1e8160b1`, `94b4c299`) and the log could not say
 * which of its two branches fired. `grep -c` over the whole of run
 * `39325676895` gives 0 for `brief missing AC ids` and 0 for `brief file
 * required when Marcus spawned`.
 *
 * Recovering those messages is #700's other half. This half is jhorn-1f's
 * correction to it, and it is the part that actually settles the question:
 * **a message is not enough, because the path is the question.** The check
 * composes `briefPath` at call time from `RUNGATE_WORK_DIR`, a
 * `$HOME/.rungate` fallback and the state's slug. `brief missing AC ids:
 * AC-2` is the same sentence whether the file was read from the right
 * directory or the wrong one.
 *
 * Reading the fixture makes that the live hypothesis rather than a
 * precaution: `test/contract.test.ts:326` sets `slug: "standard"`, `:82`
 * passes `RUNGATE_WORK_DIR=${TEST_BASE}`, so the path resolves to
 * `/tmp/harness-contract-tests/standard/marcus-brief.md`, and `:338` writes
 * exactly that file carrying both AC ids. On a reading of the source this
 * check cannot fail — so it is failing on *where* or *when*, and only the
 * path can tell those apart.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Append the path to the existing `brief missing AC ids` message and stop
 * there.** One interpolation, the sentence gains a path, and the OTHER
 * branch — Marcus spawned with no brief at all, `:1221` — still says
 * `marcus-brief.md missing` with no path, which is the branch the source
 * reading above points at. The fix lands on the message that was already the
 * more informative of the two and leaves the blind one blind.
 *
 * Do these cases survive it? Yes, non-vacuously: `AC-2` drives the absent
 * branch and asserts the path is in ITS refusal, so the one-sided repair is
 * red there while `AC-3` goes green. Asserting the path on only one branch
 * would have been the same defect in test form.
 *
 * ## One binding
 *
 * `briefAcAlignment` is the whole decision and `gates/workflow.test.ts` is a
 * call site that composes a path and reads a verdict. A second judgement at
 * the call site would be two deciders that agree
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape), and the
 * last case here asserts there is not one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { briefAcAlignment } from "../lib/brief-ac-alignment";

const PATH = "/tmp/harness-contract-tests/standard/marcus-brief.md";

const input = (over: Partial<Parameters<typeof briefAcAlignment>[0]> = {}) => ({
  briefPath: PATH,
  briefExists: true,
  briefText: "# Marcus Brief\n\n## AC-1\nfix it\n\n## AC-2\ntest it\n",
  acIds: ["AC-1", "AC-2"],
  marcusSpawned: true,
  ...over,
});

describe("#700 AC-1: a brief naming every AC is ALIGNED and refuses nothing", () => {
  test("the happy path, which is what the contract fixture builds", () => {
    const r = briefAcAlignment(input());
    expect(r.reading).toBe("ALIGNED");
    expect(r.refusal).toBeNull();
    expect(r.missingIds).toEqual([]);
    // The path is reported even when nothing is wrong. A reading that only
    // carries its path on failure cannot be used to confirm the check looked
    // in the right place on a green run — which is the run this fixture
    // produces locally and the one that makes #700 intermittent.
    expect(r.briefPath).toBe(PATH);
  });

  test("no ACs is ALIGNED, not a refusal", () => {
    // Vacuous, deliberately: a state with no ACs has no coverage to fail.
    // Stated as a case so a later `missingIds.length >= 0` style mistake has
    // something to go red against.
    expect(briefAcAlignment(input({ acIds: [] })).reading).toBe("ALIGNED");
  });
});

describe("#700 AC-2: an absent brief refuses, and the refusal names the path", () => {
  test("Marcus spawned with no brief is BRIEF_ABSENT and says where it looked", () => {
    const r = briefAcAlignment(input({ briefExists: false, briefText: "" }));
    expect(r.reading).toBe("BRIEF_ABSENT");
    expect(r.refusal).not.toBeNull();
    // The whole point. This is the branch the source reading points at, and
    // the branch the cheapest wrong fix leaves untouched.
    expect(r.refusal).toContain(PATH);
    // And it says the path is itself suspect, because it is composed from
    // env at call time. A refusal that names a path without saying the path
    // might be the bug sends the reader to the file.
    expect(r.refusal).toContain("RUNGATE_WORK_DIR");
  });

  test("an absent brief with Marcus never spawned is NOT_APPLICABLE, and says so out loud", () => {
    // The inline version `return`ed here, which made "nothing was wrong" and
    // "I declined to look" the same observation from outside the check.
    const r = briefAcAlignment(input({ briefExists: false, briefText: "", marcusSpawned: false }));
    expect(r.reading).toBe("NOT_APPLICABLE");
    expect(r.refusal).toBeNull();
    expect(r.declined).not.toBeNull();
    expect(r.declined).toContain(PATH);
    expect(r.declined).toMatch(/UNMEASURED/);
  });

  test("the two absent readings are distinguishable, which is the whole distinction", () => {
    const spawned = briefAcAlignment(input({ briefExists: false, briefText: "" }));
    const not = briefAcAlignment(input({ briefExists: false, briefText: "", marcusSpawned: false }));
    // Same file state, opposite verdicts, varying exactly one input (#585).
    expect(spawned.reading).not.toBe(not.reading);
    expect(Boolean(spawned.refusal)).not.toBe(Boolean(not.refusal));
  });
});

describe("#700 AC-3: a short brief refuses, names the ids AND the path", () => {
  test("a missing id is reported with the path it was read from", () => {
    const r = briefAcAlignment(input({ briefText: "# Marcus Brief\n\n## AC-1\nfix it\n" }));
    expect(r.reading).toBe("IDS_MISSING");
    expect(r.missingIds).toEqual(["AC-2"]);
    expect(r.refusal).toContain("AC-2");
    expect(r.refusal).toContain(PATH);
  });

  test("the refusal says the file WAS read, so the reader does not chase the path", () => {
    // The asymmetry that makes the path useful rather than noise: on this
    // branch the path is confirmed good, on BRIEF_ABSENT it is the prime
    // suspect. A refusal that named the path identically in both cases would
    // be a path nobody can act on.
    const r = briefAcAlignment(input({ briefText: "nothing here" }));
    expect(r.refusal).toMatch(/exists and was read/);
    expect(r.refusal).not.toContain("RUNGATE_WORK_DIR");
  });

  test("every missing id is named, not just the first", () => {
    // A count is satisfied by any N; the property is WHICH ids (#532).
    const r = briefAcAlignment(input({ briefText: "nothing", acIds: ["AC-1", "AC-2", "AC-7"] }));
    expect(r.missingIds).toEqual(["AC-1", "AC-2", "AC-7"]);
    for (const id of ["AC-1", "AC-2", "AC-7"]) expect(r.refusal).toContain(id);
  });
});

describe("#700 AC-4: the gate is a call site and not a second decider", () => {
  const GATE = readFileSync(join(import.meta.dir, "..", "gates", "workflow.test.ts"), "utf-8");

  test("the check calls the binding", () => {
    expect(GATE).toContain("briefAcAlignment({");
    expect(GATE).toContain('import { briefAcAlignment } from "../lib/brief-ac-alignment"');
  });

  test("the call site composes a path and judges nothing", () => {
    // Two deciders that agree are behaviourally one, and mutating either
    // leaves the other holding the case up. The old inline comparison is the
    // thing that must not come back.
    const start = GATE.indexOf('test("brief-ac-alignment: brief covers all ACs"');
    expect(start, "the check is gone").toBeGreaterThan(-1);
    const cut = GATE.slice(start, GATE.indexOf("\n  });", start));
    expect(cut.length).toBeGreaterThan(200);
    expect(cut, "the call site filters AC ids itself — that is the second decider")
      .not.toMatch(/\.filter\([^)]*includes/);
    expect(cut, "the call site decides what counts as missing")
      .not.toContain("missingIds");
  });
});
