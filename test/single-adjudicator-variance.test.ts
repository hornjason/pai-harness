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
  batchFrom,
  detailOf,
  plantsFor,
  readPlants,
  runBatch,
  type VarianceCapture,
} from "../evals/ai-review-control/variance-capture";
import type { Finding } from "../lib/finding-arbiter";

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

  // CONTROL: without this the case above is three assertions about an
  // adjudicator that might refuse everything. The duplicate plant copies
  // EXISTING[0], so removing EXISTING[0] from the comparison set is the one
  // edit that must turn exactly that plant and no other.
  test("the duplicate plant stops landing when its source leaves the set", async () => {
    const detail = await readPlants(EXISTING.slice(1), "b");
    const dup = detail.find(p => p.plant.endsWith("plant-duplicate"))!;
    expect(dup.agreed).toBe(false);
    expect(dup.observed).toBe("ALLOW");
    expect(detail.filter(p => !p.agreed)).toHaveLength(1);
  });

  test("an empty set yields no plants at all, rather than plants that vacuously agree", () => {
    expect(plantsFor([], "b")).toEqual([]);
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
