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
  AI_REVIEW_SAME_TREE_READINGS,
  DUPLICATE_PLANT_TWIN,
  aiReviewVarianceResidue,
  batchFrom,
  detailOf,
  liveArmCaveat,
  plantsFor,
  promptHeld,
  provenanceRefusal,
  readPlants,
  runBatch,
  type SameTreeReading,
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
    originMain: sha,
    // Hex, because a tree hash is hex. This fixture used `"t".repeat(40)` and
    // loaded cleanly, which is how the missing shape check stayed invisible.
    libTree: "d".repeat(40),
    originMainLibTree: "d".repeat(40),
    dirtyPaths: [],
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

  // The input a forged or truncated artefact actually looks like: MALFORMED
  // BUT INTERNALLY CONSISTENT. Every case above plants either a good artefact
  // or a mismatched one, and the `libTree` guard was an equality with no shape
  // check behind it — so two equal non-hashes satisfied the one comparison
  // whose job is to establish that the measured tree was the deployed tree.
  // This fixture passed the whole loader before the shape check existed.
  test("two `libTree` fields that agree but are not tree hashes", () => {
    const { dir, name } = written(capture({ libTree: "x", originMainLibTree: "x" }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/not a 40-character tree hash/);
    rmSync(dir, { recursive: true });
  });

  // The 40-character non-hex placeholder, which is the near miss a length
  // check would wave through and the exact value this file's own fixture
  // carried.
  test("a 40-character `libTree` that is not hex", () => {
    const { dir, name } = written(capture({ libTree: "t".repeat(40), originMainLibTree: "t".repeat(40) }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/not a 40-character tree hash/);
    rmSync(dir, { recursive: true });
  });

  test("a truncated tree hash, agreeing with itself", () => {
    const { dir, name } = written(capture({ libTree: "abc1234", originMainLibTree: "abc1234" }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/not a 40-character tree hash/);
    rmSync(dir, { recursive: true });
  });

  // CONTROL for the three above: the shape check must not have become a
  // refusal of everything. A real pair of equal hex tree hashes still loads,
  // and this is the case that separates "the guard works" from "the guard
  // throws".
  test("and a well-formed `libTree` pair still loads", () => {
    const { dir, name } = written(capture({ libTree: "0".repeat(40), originMainLibTree: "0".repeat(40) }));
    expect(loadVarianceCapture(name, dir).libTree).toBe("0".repeat(40));
    rmSync(dir, { recursive: true });
  });

  // The mismatch case must still be reachable AFTER the shape check — a shape
  // check placed wrongly would make the equality unreachable and nothing would
  // notice, because both refusals are refusals.
  test("two well-formed tree hashes that differ are still refused as a mismatch", () => {
    const { dir, name } = written(capture({ libTree: "a".repeat(40), originMainLibTree: "b".repeat(40) }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/was not the deployed one/);
    rmSync(dir, { recursive: true });
  });

  // The second half of the review finding, recorded because it is NOT
  // actionable and the next reader deserves to know why rather than
  // rediscovering it. `dirtyPaths` elements cannot be type-checked
  // observably: any array with a non-string element is non-empty, and the
  // emptiness check already refuses every non-empty array. An element-type
  // guard would be unreachable code that reads like a check.
  test("a non-string `dirtyPaths` element is already refused — by the emptiness check", () => {
    const { dir, name } = written(capture({ dirtyPaths: [42 as unknown as string] }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/uncommitted path\(s\) under/);
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

// #1320. The capture recorded `origin/main` as `pinnedCommit` while
// adjudicating with the working tree's `lib/`. Those agree only by
// coincidence, and the first artefact was right by coincidence.
describe("#1320: the pin names the tree that ran, not the tree that is deployed", () => {
  const sha = (c: string) => c.repeat(40);

  test("a tree level with origin/main and clean is not refused", () => {
    expect(provenanceRefusal({ libTree: sha("a"), originMainLibTree: sha("a"), dirtyPaths: [] })).toBeNull();
  });

  test("a lib/ differing from the deployed one is UNMEASURED, naming both trees", () => {
    const r = provenanceRefusal({ libTree: sha("a"), originMainLibTree: sha("b"), dirtyPaths: [] });
    expect(r).toContain("UNMEASURED");
    expect(r).toContain(sha("a"));
    expect(r).toContain(sha("b"));
    expect(r).toContain("not the deployed one");
  });

  // A dirty tree is the case no SHA can express, so it must outrank the SHA
  // comparison — a tree level with origin/main AND dirty would otherwise read
  // as clean.
  test("a dirty lib/ is UNMEASURED even when the trees agree", () => {
    const r = provenanceRefusal({ libTree: sha("a"), originMainLibTree: sha("a"), dirtyPaths: ["lib/issue-filing-gate.ts"] });
    expect(r).toContain("uncommitted path");
    expect(r).toContain("lib/issue-filing-gate.ts");
  });

  // CONTROL: the three cases above pass against a function that refuses
  // everything except one exact input. This names the two independent axes
  // and asserts each moves the verdict on its own.
  test("each axis refuses on its own, so neither is dead", () => {
    const dirtyOnly = provenanceRefusal({ libTree: sha("a"), originMainLibTree: sha("a"), dirtyPaths: ["lib/x.ts"] });
    const staleOnly = provenanceRefusal({ libTree: sha("a"), originMainLibTree: sha("b"), dirtyPaths: [] });
    expect(dirtyOnly).not.toBeNull();
    expect(staleOnly).not.toBeNull();
    expect(dirtyOnly).not.toBe(staleOnly);
  });

  test("the loader refuses a capture whose tree was not the deployed one", () => {
    const { dir, name } = written(capture({ originMainLibTree: sha("b") }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/not the deployed one/);
    rmSync(dir, { recursive: true });
  });

  test("the loader refuses a capture taken on a dirty tree", () => {
    const { dir, name } = written(capture({ dirtyPaths: ["lib/finding-jury.ts"] }));
    expect(() => loadVarianceCapture(name, dir)).toThrow(/uncommitted path/);
    rmSync(dir, { recursive: true });
  });

  // An absent reading and a clean tree are different facts, and the whole
  // point of the field is that they not collapse.
  test("the loader refuses a capture with no dirtyPaths reading at all", () => {
    const c = capture();
    delete (c as Partial<VarianceCapture>).dirtyPaths;
    const { dir, name } = written(c);
    expect(() => loadVarianceCapture(name, dir)).toThrow(/An absent reading is not a clean tree/);
    rmSync(dir, { recursive: true });
  });

  test("the stored artefact was taken on the deployed tree, clean", () => {
    const c = loadVarianceCapture("single-adjudicator-variance");
    expect(c.libTree).toBe(c.originMainLibTree);
    expect(c.dirtyPaths).toEqual([]);
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
    const residue = c.permanentlyUnmeasured.join(" ");
    // Both halves, because "no agent verifier exists" would be false and
    // "one exists" alone would not say why its variance is still unread.
    expect(residue).toContain("No agent verifier feeds THIS gate");
    expect(residue).toContain("A deployed agent verifier does exist elsewhere");
  });

  test("records the span, which is what bounds the live arm's claim", () => {
    const live = loadVarianceCapture("single-adjudicator-variance").arms.find(a => a.arm === "live")!;
    expect(live.spanSeconds).toBeGreaterThan(0);
    expect(live.runs).toBeGreaterThan(1);
  });
});

// #1329. The residue entry asserted that no two runs in this repository's
// history had ever reviewed the same tree, and that the settling experiment
// was unrun and would cost real money. Three same-tree pairs already existed
// in the run logs, and one of them flipped BLOCKED to CLEAN. A confident
// claim that nothing can be known, contradicted by data already on disk, is
// the exact failure this artefact exists to prevent — so the entry is now
// DERIVED from the readings instead of asserted beside them (#1310's lesson).
describe("#1329: the ai-review residue reads the same-tree readings", () => {
  const FLIP: SameTreeReading = {
    run: "39962683401",
    mergeCommit: "99d50fc",
    rounds: [5, 5],
    turns: [51, 52],
    verdicts: ["BLOCKED", "CLEAN"],
  };
  const AGREED: SameTreeReading = { ...FLIP, run: "x1", verdicts: ["CLEAN", "CLEAN"] };
  const NO_VERDICT: SameTreeReading = { ...FLIP, run: "x2", mergeCommit: null, verdicts: null };
  const CONFOUNDED: SameTreeReading = { ...FLIP, run: "x3", rounds: [3, 4] };

  test("a pair whose round changed is not a repeat — it is a different prompt", () => {
    expect(promptHeld(FLIP)).toBe(true);
    expect(promptHeld(CONFOUNDED)).toBe(false);
  });

  test("the shipped residue states the flip and never calls the variance unmeasured", () => {
    const s = aiReviewVarianceResidue(AI_REVIEW_SAME_TREE_READINGS);
    expect(s).toContain("IS now partly read");
    expect(s).toContain("39962683401");
    expect(s).toContain("BLOCKED then CLEAN");
    expect(s).not.toContain("variance is unmeasured");
  });

  // CONTROL. Without this the case above is satisfied by any function that
  // returns one string mentioning the flip, and the entry could never go back
  // to reporting an absence even when an absence is the honest reading.
  test("with no verdict anywhere it DOES report an absence, and names the experiment", () => {
    const s = aiReviewVarianceResidue([NO_VERDICT, CONFOUNDED]);
    expect(s).toContain("variance is unmeasured");
    expect(s).toContain("gh run rerun");
    expect(s).not.toContain("IS now partly read");
  });

  // The second control: scored pairs that AGREE must not be reported as a
  // flip. A residue that said "disagreed" whenever it had any verdict at all
  // would pass the shipped case for the wrong reason.
  test("two attempts that agreed are counted, and reported as zero disagreements", () => {
    const s = aiReviewVarianceResidue([AGREED]);
    expect(s).toContain("1 same-tree pair(s) carry two verdicts");
    expect(s).toContain("0 of them DISAGREED");
    expect(s).not.toContain("BLOCKED then CLEAN");
  });

  test("a confounded pair is excluded from the scored set and named as excluded", () => {
    const s = aiReviewVarianceResidue([FLIP, CONFOUNDED]);
    expect(s).toContain("1 same-tree pair(s) carry two verdicts");
    expect(s).toContain("1 because the round changed between attempts");
  });

  test("an unread verdict is reported as UNMEASURED, never as agreement", () => {
    const s = aiReviewVarianceResidue([FLIP, NO_VERDICT]);
    expect(s).toContain("UNMEASURED and are not attempts that agreed");
  });

  // The recorded data has to be internally honest: a pair cited as evidence of
  // a flip must have held the prompt, or it is the confound rather than the
  // measurement.
  test("every recorded pair that carries verdicts also held its prompt", () => {
    for (const r of AI_REVIEW_SAME_TREE_READINGS) {
      if (r.verdicts !== null) {
        expect(promptHeld(r), `pair ${r.run} carries verdicts but its rounds differ`).toBe(true);
        expect(r.mergeCommit, `pair ${r.run} carries verdicts but no commit was read`).not.toBeNull();
      }
    }
  });

  test("the stored artefact's residue agrees with the readings it describes", () => {
    const c = loadVarianceCapture("single-adjudicator-variance");
    expect(c.permanentlyUnmeasured).toContain(aiReviewVarianceResidue(AI_REVIEW_SAME_TREE_READINGS));
  });
});
