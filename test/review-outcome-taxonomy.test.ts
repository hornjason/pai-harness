/**
 * #1225 — the finding-outcome taxonomy, and the comparison a filter has to pass.
 *
 * The control next door (#1169) answers "did the reviewer find the bug". This
 * one answers the other half: "of the findings it wrote, how many were worth
 * writing". Recall alone cannot separate a filter that drops a third of the
 * noise from one that drops a third of the real bugs, and two filters are being
 * built against exactly that blind spot right now.
 *
 * Every case here either asserts a mutant is red or names the input that
 * separates pass from fail. The two that matter most:
 *
 * - the pre-filing citation filter, because dropping it relabels 28 real rows
 *   in this repo's history (`fix(#547)` commits from three weeks before #547
 *   existed are SC ids, not citations);
 * - `compareReviewOutcomes`, because an instrument that reports REGRESSION when
 *   the true-finding count falls is the only thing standing between a noise
 *   metric and a tool for suppressing true findings.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildCorpus, graftedRoots } from "../evals/ai-review-control/outcomes-run";
import {
  REVIEW_OUTCOME_PLANTS,
  compareReviewOutcomes,
  readFindingOutcomes,
  summariseFindingOutcomes,
  verifyOutcomePlants,
  type FindingOutcome,
  type ReviewFinding,
} from "../evals/ai-review-control/outcomes";

/** 2026-10-01T00:00:00Z, so every relative time below reads at a glance. */
const T = 1759276800;
const DAY = 86400;
const REPO_ROOT = join(import.meta.dir, "..");

function finding(over: Partial<ReviewFinding> & { id: number }): ReviewFinding {
  return {
    filedAt: T,
    closed: true,
    citations: [],
    closedInFavourOf: [],
    declared: null,
    ...over,
  };
}

/** A citation dated after its finding that changed something: the FIXED shape. */
function cite(at: number, filesChanged = 3) {
  return { sha: "a".repeat(40), at, filesChanged };
}

function outcomes(findings: ReviewFinding[], shipped: number[] = []): Map<number, FindingOutcome> {
  const readings = readFindingOutcomes(findings, new Set(shipped));
  return new Map(readings.map(r => [r.id, r.outcome]));
}

describe("#1225: FIXED is derived from the diff, and from nothing else", () => {
  test("a citing commit dated after the filing that changed files is FIXED", () => {
    const f = finding({ id: 1, citations: [cite(T + DAY)] });
    expect(outcomes([f]).get(1)).toBe("FIXED");
  });

  test("a citation dated BEFORE the filing is dropped, and the finding is not FIXED", () => {
    // The real shape: `fix(#547): verify gate regression fix` is dated
    // 2026-09-27 and issue #547 was filed 2026-10-17. The 547 is an SC id.
    // A commit cannot cite an issue that does not exist yet.
    const f = finding({ id: 547, citations: [cite(T - 20 * DAY)] });
    const [reading] = readFindingOutcomes([f], new Set());

    expect(reading.outcome).toBe("NO_ACTION");
    expect(reading.citations).toEqual([]);
    expect(reading.dropped.map(d => d.reason)).toEqual(["PREDATES_FILING"]);
  });

  test("the cheapest wrong fix — keeping pre-filing citations — flips that row to FIXED", () => {
    // Applying the wrong fix and measuring it. If the row were FIXED either
    // way the filter would be untested, so the separating input is stated and
    // read here rather than asserted in prose: the SAME finding, with its one
    // citation moved to after the filing, is FIXED.
    const kept = finding({ id: 547, citations: [cite(T + DAY)] });
    expect(outcomes([kept]).get(547)).toBe("FIXED");
  });

  test("a citation that changed no file is dropped — a merge of nothing is not a fix", () => {
    const f = finding({ id: 2, citations: [cite(T + DAY, 0)] });
    const [reading] = readFindingOutcomes([f], new Set());

    expect(reading.outcome).toBe("NO_ACTION");
    expect(reading.dropped.map(d => d.reason)).toEqual(["CHANGED_NOTHING"]);
  });

  test("an open finding has no outcome at all, rather than counting as noise", () => {
    expect(outcomes([finding({ id: 3, closed: false })]).get(3)).toBe("OPEN");
  });
});

describe("#1225: SUPERSEDED follows the chain, because duplicates are filed in chains", () => {
  test("a finding closed in favour of a FIXED one is SUPERSEDED", () => {
    const fixed = finding({ id: 10, citations: [cite(T + DAY)] });
    const dup = finding({ id: 11, closedInFavourOf: [10] });
    expect(outcomes([fixed, dup]).get(11)).toBe("SUPERSEDED");
  });

  test("a duplicate OF a duplicate is SUPERSEDED, and the chain is recorded", () => {
    // The case that caught the first version of this module. #547 names #530,
    // and #530 is itself a duplicate; a non-transitive walk scored both as
    // NO_ACTION and overstated the noise bucket by 26 rows out of 98. A noise
    // metric biased upward is the one that gets used to suppress.
    const fixed = finding({ id: 20, citations: [cite(T + DAY)] });
    const mid = finding({ id: 21, closedInFavourOf: [20] });
    const outer = finding({ id: 22, closedInFavourOf: [21] });

    const readings = readFindingOutcomes([fixed, mid, outer], new Set());
    const walked = readings.find(r => r.id === 22);

    expect(walked?.outcome).toBe("SUPERSEDED");
    expect(walked?.supersedeChain).toEqual([21, 20]);
  });

  test("a chain ending in NO_ACTION stays NO_ACTION — superseding nothing is not an answer", () => {
    const dead = finding({ id: 30 });
    const pointer = finding({ id: 31, closedInFavourOf: [30] });
    expect(outcomes([dead, pointer]).get(31)).toBe("NO_ACTION");
  });

  test("a reference to a merged pull request terminates the chain as SUPERSEDED", () => {
    // #473's close names #483, which is a PR and never appears in the issue
    // corpus. Without the shipped set it reads as a dangling reference.
    const dup = finding({ id: 473, closedInFavourOf: [483] });
    expect(outcomes([dup], [483]).get(473)).toBe("SUPERSEDED");
  });

  test("a reference cycle terminates instead of hanging, and is not SUPERSEDED", () => {
    const a = finding({ id: 40, closedInFavourOf: [41] });
    const b = finding({ id: 41, closedInFavourOf: [40] });
    expect(outcomes([a, b])).toEqual(new Map([[40, "NO_ACTION"], [41, "NO_ACTION"]]));
  });
});

describe("#1225: the three verbal categories are UNMEASURED, not guessed", () => {
  test("NO_ACTION is the union of wrong, intentional and didn't-matter — never one of them", () => {
    // Nothing in the close path records which. Routing the whole bucket into
    // any single category would be a number with no evidence under it, and
    // three real categories beat four where one is a guess.
    const readings = readFindingOutcomes([finding({ id: 50 })], new Set());
    expect(readings[0].outcome).toBe("NO_ACTION");
    expect(readings[0].detail.join(" ")).toContain("wrong, intentional or didn't-matter");
  });

  test("a declared disposition is honoured, because that is the responder answering", () => {
    const f = finding({ id: 51, declared: "intentional" });
    expect(outcomes([f]).get(51)).toBe("INTENTIONAL");
  });

  test("a disposition that contradicts a fix commit is UNMEASURED, not a tiebreak", () => {
    // "the behaviour is intentional" and "here is the commit that changed it"
    // are both evidence and they disagree. Picking one silently is how a
    // contradiction becomes a clean number.
    const f = finding({ id: 52, declared: "wrong", citations: [cite(T + DAY)] });
    const [reading] = readFindingOutcomes([f], new Set());

    expect(reading.outcome).toBe("UNMEASURED");
    expect(reading.detail.join(" ")).toContain("contradicts");
  });

  test("the noise rate is withheld, not zero, while nothing declares a disposition", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: 60, citations: [cite(T + DAY)] }), finding({ id: 61 })], new Set()),
      "test corpus",
    );
    expect(run.declaredCoverage).toBe(0);
    expect(run.noiseRate).toBeNull();
  });

  test("once dispositions exist the rate is a number, so the null is a reading and not a stub", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [finding({ id: 70, citations: [cite(T + DAY)] }), finding({ id: 71, declared: "wrong" })],
        new Set(),
      ),
      "test corpus",
    );
    expect(run.declaredCoverage).toBe(1);
    expect(run.noiseRate).toBe(0.5);
  });
});

describe("#1225: every number names the population it came from", () => {
  test("the summary carries the population size and the filter, not just the counts", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: 80, citations: [cite(T + DAY)] })], new Set()),
      "566 closed issues in hornjason/pai-harness",
    );
    expect(run.population).toBe(1);
    expect(run.filter).toBe("566 closed issues in hornjason/pai-harness");
    expect(run.citationFilter).toContain("PREDATES_FILING");
  });

  test("dropped citations are reported rather than silently applied", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [finding({ id: 90, citations: [cite(T - DAY), cite(T + DAY, 0)] })],
        new Set(),
      ),
      "test corpus",
    );
    expect(run.droppedCitations).toBe(2);
  });

  test("an empty run is not a pass — zero failures over zero findings is vacuous", () => {
    const run = summariseFindingOutcomes([], "test corpus");
    expect(run.usable).toBe(false);
    expect(run.detail.join(" ")).toContain("measured nothing");
  });

  test("a run with no closed finding is not usable either", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: 100, closed: false })], new Set()),
      "test corpus",
    );
    expect(run.usable).toBe(false);
  });
});

describe("#1225: the comparison cannot be read as a licence to suppress", () => {
  const corpus = (fixedIds: number[], noiseIds: number[]) =>
    summariseFindingOutcomes(
      readFindingOutcomes(
        [
          ...fixedIds.map(id => finding({ id, citations: [cite(T + DAY)] })),
          ...noiseIds.map(id => finding({ id })),
        ],
        new Set(),
      ),
      "test corpus",
    );

  /** The same six candidates, with `withheld` suppressed by a filter. */
  const filtered = (withheld: number[]) =>
    summariseFindingOutcomes(
      readFindingOutcomes(
        [
          ...[1, 2, 3].map(id =>
            finding({ id, citations: [cite(T + DAY)], suppressed: withheld.includes(id) }),
          ),
          ...[4, 5, 6].map(id => finding({ id, suppressed: withheld.includes(id) })),
        ],
        new Set(),
      ),
      "test corpus",
    );

  test("cutting noise while keeping every true finding is IMPROVED", () => {
    const result = compareReviewOutcomes(corpus([1, 2, 3], [4, 5, 6]), filtered([5, 6]));

    expect(result.fixedDelta).toBe(0);
    expect(result.costDelta).toBe(-2);
    expect(result.verdict).toBe("IMPROVED");
  });

  test("a suppressed candidate stays in the population, so the corpus cannot shrink", () => {
    // Without this the only way to model a filter is a smaller sweep, and a
    // smaller sweep reads as an improvement on every count at once.
    const after = filtered([5, 6]);
    expect(after.population).toBe(6);
    expect(after.suppressed).toBe(2);
    expect(after.closed).toBe(4);
  });

  test("losing one true finding is REGRESSION even when the noise falls to zero", () => {
    // The whole reason this function exists. A filter that silenced every
    // finding would read as a perfect noise score on any single-number metric.
    const result = compareReviewOutcomes(corpus([1, 2, 3], [4, 5, 6]), filtered([3, 4, 5, 6]));

    expect(result.fixedDelta).toBe(-1);
    expect(result.costDelta).toBe(-3);
    expect(result.verdict).toBe("REGRESSION");
    expect(result.detail.join(" ")).toContain("catching real bugs first");
  });

  test("silencing the reviewer entirely is REGRESSION, not a perfect score", () => {
    const result = compareReviewOutcomes(corpus([1, 2, 3], [4, 5, 6]), filtered([1, 2, 3, 4, 5, 6]));

    expect(result.costDelta).toBe(-3);
    expect(result.verdict).toBe("REGRESSION");
  });

  test("holding noise steady while keeping every true finding is NEUTRAL, not a win", () => {
    const before = corpus([1, 2, 3], [4, 5, 6]);
    const after = corpus([1, 2, 3], [4, 5, 6]);
    expect(compareReviewOutcomes(before, after).verdict).toBe("NEUTRAL");
  });

  test("two corpora of different sizes are UNMEASURED — a smaller sweep is not an improvement", () => {
    const before = corpus([1, 2, 3], [4, 5, 6]);
    const after = corpus([1, 2, 3], [4]);

    const result = compareReviewOutcomes(before, after);
    expect(result.verdict).toBe("UNMEASURED");
    expect(result.detail.join(" ")).toContain("not the same corpus");
  });

  test("an unusable reading on either side is UNMEASURED rather than defaulted", () => {
    const empty = summariseFindingOutcomes([], "test corpus");
    expect(compareReviewOutcomes(corpus([1], [2]), empty).verdict).toBe("UNMEASURED");
    expect(compareReviewOutcomes(empty, corpus([1], [2])).verdict).toBe("UNMEASURED");
  });
});

describe("#1225: what counts as a citation, which is where the first defect was", () => {
  const commit = (subject: string, filesChanged = 4) => ({
    sha: "b".repeat(40),
    at: T + DAY,
    subject,
    filesChanged,
  });
  const issue = (number: number) => ({
    number,
    state: "closed",
    created_at: "2026-10-01T00:00:00Z",
  });

  test("the conventional-commit subject scope is a citation", () => {
    const { findings } = buildCorpus([issue(1169)], new Map(), [commit("feat(#1169): a control")]);
    expect(findings[0].citations).toHaveLength(1);
  });

  test("a multi-id scope cites every id in it", () => {
    const { findings } = buildCorpus(
      [issue(1203), issue(1205)],
      new Map(),
      [commit("fix(#1203,#1205,#1146): the tokeniser")],
    );
    expect(findings.map(f => f.citations.length)).toEqual([1, 1]);
  });

  test("the trailing (#N) is the pull request, not a citation of a finding", () => {
    // `fix(#1169): … (#1201)` cites #1169 and merges as #1201. Counting the
    // trailing number would make every merge look like a fixed finding.
    const { findings, shipped } = buildCorpus(
      [issue(1201)],
      new Map(),
      [commit("feat(#1169): a control (#1201)")],
    );
    expect(findings[0].citations).toEqual([]);
    expect(shipped.has(1201)).toBe(true);
  });

  test("a closing keyword in the commit BODY is NOT a citation", () => {
    // The regression the plants caught. Scanning bodies moved 21 findings into
    // FIXED, and both sampled were prose: `gh closes #23 in unprotected/x` is
    // a test command being described. The body is no longer read at all, so
    // the input that separates pass from fail is a subject with no scope —
    // which must yield nothing whatever a body might have said.
    const { findings } = buildCorpus([issue(23)], new Map(), [commit("Resolve the token (#142)")]);
    expect(findings[0].citations).toEqual([]);
  });

  test("the supersede target comes from the close, and a finding never supersedes itself", () => {
    const { findings } = buildCorpus(
      [issue(473)],
      new Map([[473, "Duplicate of #481, which shipped in #483. See also #473."]]),
      [],
    );
    expect(findings[0].closedInFavourOf).toEqual([481, 483]);
  });

  test("an open finding's comments are not read as a close", () => {
    const open = { ...issue(900), state: "open" };
    const { findings } = buildCorpus([open], new Map([[900, "related to #901"]]), []);
    expect(findings[0].closedInFavourOf).toEqual([]);
  });
});

describe("#1225: the truncated-history refusal, proved against a real shallow clone", () => {
  test("a full checkout has no grafted root on main", () => {
    expect(graftedRoots(REPO_ROOT)).toEqual([]);
  });

  test("a depth-1 clone of it does, and names the graft", () => {
    // The guard that would have silently ruined this instrument: a shallow
    // `git log origin/main` returns a well-formed history starting at the cut,
    // and every finding older than it lands in NO_ACTION. Cloning the repo at
    // depth 1 is the input that separates pass from fail, and it is run here
    // rather than asserted.
    const dir = mkdtempSync(join(tmpdir(), "outcome-shallow-"));
    try {
      // `--branch main` and not the worktree's own HEAD: `graftedRoots` asks
      // about `origin/main` by name, so a clone whose default head is this
      // branch would fail on an unknown revision and read as a refusal for
      // the wrong reason. `--no-local` forces the real transport, which is
      // what honours `--depth`.
      const clone = spawnSync(
        "git",
        ["clone", "--depth", "1", "--no-local", "--branch", "main", `file://${REPO_ROOT}`, dir, "--quiet"],
        { encoding: "utf-8" },
      );
      expect(clone.stderr ?? "").toBe("");
      expect(clone.status).toBe(0);
      const roots = graftedRoots(dir);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("#1225: the plants, so a sweep returning zero is not mistaken for a blind one", () => {
  test("every plant names a real finding, an expected outcome and why", () => {
    expect(REVIEW_OUTCOME_PLANTS.length).toBeGreaterThanOrEqual(3);
    for (const plant of REVIEW_OUTCOME_PLANTS) {
      expect(plant.id).toBeGreaterThan(0);
      expect(plant.why.length).toBeGreaterThan(20);
    }
  });

  test("the plants cover all three measurable outcomes, not three of the easy one", () => {
    const covered = new Set(REVIEW_OUTCOME_PLANTS.map(p => p.expect));
    expect(covered).toEqual(new Set(["FIXED", "SUPERSEDED", "NO_ACTION"]));
  });

  test("a sweep that agrees with every plant verifies", () => {
    const readings = REVIEW_OUTCOME_PLANTS.map(p => ({
      id: p.id,
      outcome: p.expect as FindingOutcome,
      citations: [],
      dropped: [],
      supersedeChain: [],
      detail: [],
    }));
    expect(verifyOutcomePlants(readings).verified).toBe(true);
  });

  test("a sweep that misses one plant fails, and names which", () => {
    const plant = REVIEW_OUTCOME_PLANTS[0];
    const readings = REVIEW_OUTCOME_PLANTS.map(p => ({
      id: p.id,
      outcome: (p.id === plant.id ? "NO_ACTION" : p.expect) as FindingOutcome,
      citations: [],
      dropped: [],
      supersedeChain: [],
      detail: [],
    }));
    const result = verifyOutcomePlants(readings);

    expect(result.verified).toBe(false);
    expect(result.detail.join(" ")).toContain(`#${plant.id}`);
  });

  test("a sweep missing a plant entirely fails — a plant absent from the corpus is blindness", () => {
    expect(verifyOutcomePlants([]).verified).toBe(false);
  });
});
