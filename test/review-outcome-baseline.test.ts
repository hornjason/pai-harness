/**
 * The frozen pre-arbiter reading, and the scope of what it can be compared to
 * (#1278).
 *
 * Two jobs. The first is ordinary: a stored baseline that has been truncated,
 * hand-edited or written by a blind detector must be red rather than quietly
 * wrong, so every refusal in `loadBaseline` is exercised against a mutated
 * copy. The second is the one that matters — **this file is where the claim
 * "the artefact is not a temporal before-arm" is executed rather than
 * asserted in prose.** A document saying so is a document; a case is a check.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BASELINE_REFUSED, loadBaseline, type OutcomeBaseline } from "../evals/ai-review-control/baselines";
import { compareReviewOutcomes } from "../evals/ai-review-control/outcomes";

/** The artefact, mutated one field at a time, written where a loader can read it. */
function withBaseline<T>(mutate: (b: OutcomeBaseline) => unknown, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rg-baseline-"));
  try {
    const copy = JSON.parse(JSON.stringify(loadBaseline("pre-arbiter"))) as OutcomeBaseline;
    writeFileSync(join(dir, "m.json"), JSON.stringify(mutate(copy) ?? copy));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#1278: the pre-arbiter baseline is a reading, and says so", () => {
  const base = loadBaseline("pre-arbiter");

  test("the four counts are the ones that were measured", () => {
    expect(base.summary.fixed).toBe(418);
    expect(base.summary.superseded).toBe(105);
    expect(base.summary.noAction).toBe(74);
    expect(base.summary.open).toBe(30);
    expect(base.summary.population).toBe(627);
  });

  test("the three verbal categories stayed UNMEASURED rather than becoming zeros", () => {
    // The whole reason the instrument is trustworthy. `noiseRate` must be
    // null, not 0: "no noise" and "nobody recorded whether there was noise"
    // are different facts, and a clean categorical source downstream is
    // exactly the thing that would tempt this into a 0.
    expect(base.summary.wrong).toBe(0);
    expect(base.summary.intentional).toBe(0);
    expect(base.summary.didntMatter).toBe(0);
    expect(base.summary.declaredCoverage).toBe(0);
    expect(base.summary.noiseRate).toBeNull();
  });

  test("the reading carries its own provenance", () => {
    expect(base.pinnedCommit).toBe("52750f04c54e26b8643b8c00b3f41687a6a6f780");
    expect(base.plantsAgreed).toBe(base.plantsTotal);
    expect(base.plantsTotal).toBe(4);
    expect(base.summary.usable).toBe(true);
  });

  test("the population line and the citation filter travel with the counts", () => {
    // A number without the population it was taken over is not a reading.
    expect(base.summary.filter).toContain("627 findings");
    expect(base.summary.filter).toContain("hornjason/pai-harness");
    expect(base.summary.citationFilter.length).toBeGreaterThan(0);
    expect(base.summary.droppedCitations).toBeGreaterThan(0);
  });
});

describe("#1278: the artefact refuses to be read as a temporal before-arm", () => {
  test("against a later run of a different size the verdict is UNMEASURED, not an improvement", () => {
    const base = loadBaseline("pre-arbiter");
    // A post-arbiter tracker run is a different population by construction:
    // the mechanism changes which findings reach the tracker at all. Here it
    // is smaller AND has fewer fixed — the shape a filing filter produces,
    // and the shape that must never read as a win.
    const later = { ...base.summary, population: 500, fixed: 300, cost: 120 };

    const verdict = compareReviewOutcomes(base.summary, later);
    expect(verdict.verdict).toBe("UNMEASURED");
    expect(verdict.detail.join(" ")).toContain("not the same corpus");
  });

  test("and it is UNMEASURED even when every count moved the flattering way", () => {
    // The case that says the refusal is about the population and not about
    // the direction. Fewer findings, more of them fixed, less cost — every
    // number better, and still not a measurement.
    const base = loadBaseline("pre-arbiter");
    const flattering = { ...base.summary, population: 400, fixed: 390, cost: 10 };

    const verdict = compareReviewOutcomes(base.summary, flattering);
    expect(verdict.verdict).toBe("UNMEASURED");
  });

  test("losing a fixed finding at equal population is REGRESSION however far cost falls", () => {
    // The property the baseline exists to protect, exercised against the
    // real stored arm rather than a synthetic one: a mechanism whose job is
    // to file less cannot buy its way out of dropping a real finding.
    const base = loadBaseline("pre-arbiter");
    const suppressed = { ...base.summary, fixed: base.summary.fixed - 1, cost: 0 };

    const verdict = compareReviewOutcomes(base.summary, suppressed);
    expect(verdict.verdict).toBe("REGRESSION");
    expect(verdict.detail.join(" ")).toContain("catching real bugs first");
  });

  test("the artefact states its own scope, so a reader does not have to find this file", () => {
    expect(loadBaseline("pre-arbiter").comparableWith).toContain("UNMEASURED");
  });
});

describe("#1278: a baseline that was never a reading is refused", () => {
  // Each case mutates the real artefact and asserts the refusal fires. Red
  // against the stored file is not evidence — the stored file is valid — so
  // the mutation is what separates pass from fail here.
  test("a missing provenance field refuses rather than loading a dateless number", () => {
    withBaseline(
      b => {
        delete (b as Partial<OutcomeBaseline>).pinnedCommit;
        return b;
      },
      dir => expect(() => loadBaseline("m", dir)).toThrow(BASELINE_REFUSED),
    );
  });

  test("a short SHA refuses — it and a wrong-length string are indistinguishable", () => {
    withBaseline(
      b => ({ ...b, pinnedCommit: "52750f04" }),
      dir => expect(() => loadBaseline("m", dir)).toThrow("not a 40-character SHA"),
    );
  });

  test("a summary that is not usable refuses — it was never a reading", () => {
    withBaseline(
      b => ({ ...b, summary: { ...b.summary, usable: false } }),
      dir => expect(() => loadBaseline("m", dir)).toThrow("never a reading"),
    );
  });

  test("a baseline whose plants disagreed refuses, so a blind detector is never ground truth", () => {
    withBaseline(
      b => ({ ...b, plantsAgreed: 3 }),
      dir => expect(() => loadBaseline("m", dir)).toThrow("known-positives"),
    );
  });

  test("CONTROL: the unmutated copy loads, so the refusals above are not the copier failing", () => {
    withBaseline(
      b => b,
      dir => expect(loadBaseline("m", dir).summary.fixed).toBe(418),
    );
  });
});
