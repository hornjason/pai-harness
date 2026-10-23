/**
 * The variance capture, and what each of its refusals is pointed at.
 *
 * The capture's whole output is a number that is **zero by construction**, so
 * every case here is written against the one failure mode that matters: a
 * zero that came from an instrument that stopped reporting, rather than from
 * an adjudicator that did not move. Each positive case is paired with the
 * input that separates it from its vacuous twin — the third shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BASELINE_REFUSED, loadVarianceCapture } from "../evals/ai-review-control/baselines";
import {
  DUPLICATE_PLANT_TWIN,
  batchFrom,
  detailOf,
  liveArmCaveat,
  plantsFor,
  readPlants,
  runBatch,
  type VarianceCapture,
} from "../evals/ai-review-control/variance-capture";
import { symptomKeys, type Finding } from "../lib/finding-arbiter";
import { adjudicateFiling } from "../lib/issue-filing-gate";

const EXISTING: Finding[] = [
  {
    id: "900",
    title: "`loadThing` returns the wrong count and the off-by-one is silent",
    body: "`loadThing()` in `lib/thing.ts` reports 41 rows where the fixture holds 42. Measured 41 against 42.",
  },
  {
    id: "901",
    title: "the scaffold crashes when `roles.json` is absent",
    body: "`scaffoldProject()` in `lib/scaffold-project.ts` throws on a tree with no roles file. 3 of 7 consumers.",
  },
];

function capture(over: Partial<VarianceCapture> = {}): VarianceCapture {
  const sha = "a".repeat(40);
  return {
    kind: "single-adjudicator-variance",
    name: "x",
    pinnedCommit: sha,
    commitAtEnd: sha,
    measuredAt: "2026-10-23T00:00:00.000Z",
    repo: "hornjason/pai-harness",
    command: "bun evals/ai-review-control/variance-capture.ts",
    runs: 20,
    whyThisM: "because",
    batchProvenance: "synthetic",
    batchSize: 5,
    plantsAgreed: 3,
    plantsTotal: 3,
    plantDetail: [],
    usable: true,
    caveat: "zero by construction",
    permanentlyUnmeasured: [],
    arms: [],
    ...over,
  };
}

function written(c: VarianceCapture): { dir: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), "variance-capture-"));
  writeFileSync(join(dir, "c.json"), JSON.stringify(c));
  return { dir, name: "c" };
}

describe("the plants separate a live adjudicator from an inert one", () => {
  test("all three land on a real comparison set", async () => {
    const detail = await readPlants(EXISTING, "b");
    expect(detail.map(p => `${p.plant.split("/")[1]}=${p.observed}`)).toEqual([
      "plant-dropped=REFUSE/DROPPED_CATEGORY",
      "plant-duplicate=REFUSE/DUPLICATE",
      "plant-allowed=ALLOW",
    ]);
    expect(detail.every(p => p.agreed)).toBe(true);
  });

  // The regression. The first cut built the duplicate plant by copying
  // `existing[0]`, so it landed only while the tracker's first row happened
  // to carry two quantities — `duplicateOverlap` requires two shared `qty:`
  // keys and one is not a duplicate. It stopped landing within hours, on a
  // real tracker, and the capture went UNMEASURED. A known positive that
  // depends on what the corpus contains is not a known positive.
  test("all three land on an EMPTY corpus, so none depends on tracker content", async () => {
    const detail = await readPlants([], "b");
    expect(detail).toHaveLength(3);
    expect(detail.filter(p => !p.agreed)).toEqual([]);
  });

  test("the duplicate plant carries its own twin rather than borrowing one", () => {
    const dup = plantsFor([], "b").find(p => p.key.endsWith("plant-duplicate"))!;
    expect(dup.extraExisting).toEqual([DUPLICATE_PLANT_TWIN]);
    expect(dup.attempt.title).toBe(DUPLICATE_PLANT_TWIN.title);
  });

  // CONTROL: the twin must be the reason it collides. Without the injection
  // the plant is alone in an empty set and nothing can match it.
  test("without its twin the duplicate plant is ALLOWed, so the twin is what lands it", async () => {
    const dup = plantsFor([], "b").find(p => p.key.endsWith("plant-duplicate"))!;
    const v = await adjudicateFiling({ ...dup.attempt }, async () => []);
    expect(v.outcome).toBe("ALLOW");
  });

  // The twin needs TWO shared quantities, not one. A twin carrying one number
  // would reproduce the original defect in a different costume.
  test("the twin names at least two quantities", () => {
    const qty = symptomKeys(DUPLICATE_PLANT_TWIN).filter(k => k.startsWith("qty:"));
    expect(qty.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a repeated run is identical, and the comparison can tell when it is not", () => {
  test("two passes over one batch and one set agree byte for byte", async () => {
    const batch = batchFrom(EXISTING, "b");
    const a = await runBatch(batch, EXISTING);
    const b = await runBatch(batch, EXISTING);
    expect(a.withheldHash).toBe(b.withheldHash);
    expect(a.trackerHash).toBe(b.trackerHash);
  });

  // CONTROL: two identical hashes mean nothing unless a changed input
  // produces a different one. Adding an issue that duplicates #900 must move
  // #900's replay from ALLOW into the withheld set, because the leave-one-out
  // holds out #900 itself and not the new twin.
  test("a comparison set that gained a twin produces a different withheld set", async () => {
    const batch = batchFrom(EXISTING, "b");
    const base = await runBatch(batch, EXISTING);
    const twinned = await runBatch(batch, [
      ...EXISTING,
      { id: "902", title: EXISTING[0]!.title, body: EXISTING[0]!.body },
    ]);
    expect(twinned.withheldHash).not.toBe(base.withheldHash);
    expect(twinned.withheld.length).toBeGreaterThan(base.withheld.length);
  });

  test("the batch is not degenerate — something is withheld and something is allowed", async () => {
    const batch = batchFrom(EXISTING, "b");
    const r = await runBatch(batch, EXISTING);
    expect(r.withheld.length).toBeGreaterThan(0);
    expect(r.allowed.length).toBeGreaterThan(0);
    expect(r.withheld.length + r.allowed.length + r.unmeasured.length).toBe(batch.length);
  });

  test("the detail covers every row and names a reason for each", async () => {
    const batch = batchFrom(EXISTING, "b");
    const detail = await detailOf(batch, EXISTING);
    expect(detail).toHaveLength(batch.length);
    expect(detail.every(d => d.reason.length > 0)).toBe(true);
  });
});

describe("loadVarianceCapture refuses rather than returning a partial reading", () => {
  test("a capture whose commit moved during the run", () => {
    const { dir, name } = written(capture({ commitAtEnd: "b".repeat(40) }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/straddle two adjudicators/);
    rmSync(dir, { recursive: true });
  });

  test("a short SHA, which `gh run list --commit` would silently ignore", () => {
    const { dir, name } = written(capture({ pinnedCommit: "abc1234", commitAtEnd: "abc1234" }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/not a 40-character SHA/);
    rmSync(dir, { recursive: true });
  });

  test("a capture marked unusable, carrying its caveat into the refusal", () => {
    const { dir, name } = written(capture({ usable: false, caveat: "a plant did not land" }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/a plant did not land/);
    rmSync(dir, { recursive: true });
  });

  test("a capture whose plants disagreed", () => {
    const { dir, name } = written(capture({ plantsAgreed: 2 }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/2 of 3 plants agreeing/);
    rmSync(dir, { recursive: true });
  });

  test("a capture with no plants at all, which is not the same as a capture that passed", () => {
    const { dir, name } = written(capture({ plantsAgreed: 0, plantsTotal: 0 }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/0 of 0 plants agreeing/);
    rmSync(dir, { recursive: true });
  });

  test("a missing provenance field", () => {
    const { dir, name } = written(capture({ measuredAt: "" }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/has no `measuredAt`/);
    rmSync(dir, { recursive: true });
  });

  // CONTROL: six refusals above are six assertions that the loader throws.
  // Without this one, a loader that threw on EVERY input would pass all six.
  test("and loads a capture that is whole", () => {
    const { dir, name } = written(capture());
    expect(loadVarianceCapture(name, dir).kind).toBe("single-adjudicator-variance");
    rmSync(dir, { recursive: true });
  });

  test("every refusal routes through the one constant", () => {
    const { dir, name } = written(capture({ plantsAgreed: 1 }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(new RegExp(BASELINE_REFUSED));
    rmSync(dir, { recursive: true });
  });
});

// The AI review on #1310 found this: the live arm's sentence spelled
// `distinctTrackerSets: 1` as a literal beside an interpolated span, so in an
// artefact whose only job is to stop a reading being misread, the prose could
// contradict the `arms` data on exactly the run where it mattered.
describe("#1310: the live arm's caveat reads the arm instead of restating it", () => {
  test("a stable arm names its own count rather than a baked-in 1", () => {
    const s = liveArmCaveat({ distinctTrackerSets: 1, distinctWithheldSets: 1, spanSeconds: 20.6 });
    expect(s).toContain("distinctTrackerSets: 1");
    expect(s).toContain("20.6s");
    expect(s).toContain("NOT a measurement of tracker drift");
  });

  // The case the literal failed. A tracker that moved must never produce prose
  // claiming it did not, and the count it names must be the one measured.
  test("an arm that varied never claims `distinctTrackerSets: 1`", () => {
    const s = liveArmCaveat({ distinctTrackerSets: 3, distinctWithheldSets: 2, spanSeconds: 41.2 });
    expect(s).not.toContain("distinctTrackerSets: 1");
    expect(s).toContain("3 distinct comparison set(s)");
    expect(s).toContain("2 distinct withheld set(s)");
  });

  // CONTROL: the two cases above would both pass against a function that
  // returned one string mentioning every number. This is the behavioural
  // difference — a moved tracker is a different FACT, not a different number,
  // and the text has to say the divergence is attributable to the input.
  test("a varied arm attributes the divergence to the input, not the gate", () => {
    const varied = liveArmCaveat({ distinctTrackerSets: 3, distinctWithheldSets: 2, spanSeconds: 41.2 });
    const stable = liveArmCaveat({ distinctTrackerSets: 1, distinctWithheldSets: 1, spanSeconds: 41.2 });
    expect(varied).toContain("attributable to its input");
    expect(varied).toContain("still not a reading of verifier variance");
    expect(stable).not.toContain("attributable to its input");
    expect(varied).not.toBe(stable);
  });

  test("a withheld set that moved is enough on its own, even with a fixed tracker", () => {
    const s = liveArmCaveat({ distinctTrackerSets: 1, distinctWithheldSets: 2, spanSeconds: 10 });
    expect(s).toContain("DID vary");
    expect(s).not.toContain("NOT a measurement of tracker drift");
  });

  test("the stored artefact's caveat agrees with the arm it describes", () => {
    const c = loadVarianceCapture("single-adjudicator-variance");
    const live = c.arms.find(a => a.arm === "live")!;
    expect(c.caveat).toContain(liveArmCaveat(live));
  });
});

describe("the stored artefact", () => {
  test("loads, and records a commit that did not move", () => {
    const c = loadVarianceCapture("single-adjudicator-variance");
    expect(c.pinnedCommit).toBe(c.commitAtEnd);
    expect(c.plantsAgreed).toBe(c.plantsTotal);
    expect(c.arms.map(a => a.arm)).toEqual(["pinned", "live"]);
  });

  test("says in its own text that the zero is by construction, so a reader cannot miss it", () => {
    const c = loadVarianceCapture("single-adjudicator-variance");
    expect(c.caveat).toContain("BY CONSTRUCTION");
    expect(c.permanentlyUnmeasured.length).toBeGreaterThanOrEqual(3);
    expect(c.permanentlyUnmeasured.join(" ")).toContain("no deployed agent verifier");
  });

  test("records the span, which is what bounds the live arm's claim", () => {
    const live = loadVarianceCapture("single-adjudicator-variance").arms.find(a => a.arm === "live")!;
    expect(live.spanSeconds).toBeGreaterThan(0);
    expect(live.runs).toBeGreaterThan(1);
  });
});
