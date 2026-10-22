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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

function finding(over: Partial<ReviewFinding> & { id: string }): ReviewFinding {
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

function outcomes(findings: ReviewFinding[], shipped: string[] = []): Map<string, FindingOutcome> {
  const readings = readFindingOutcomes(findings, new Set(shipped));
  return new Map(readings.map(r => [r.id, r.outcome]));
}

describe("#1225: FIXED is derived from the diff, and from nothing else", () => {
  test("a citing commit dated after the filing that changed files is FIXED", () => {
    const f = finding({ id: "1", citations: [cite(T + DAY)] });
    expect(outcomes([f]).get("1")).toBe("FIXED");
  });

  test("a citation dated BEFORE the filing is dropped, and the finding is not FIXED", () => {
    // The real shape: `fix(#547): verify gate regression fix` is dated
    // 2026-09-27 and issue #547 was filed 2026-10-17. The 547 is an SC id.
    // A commit cannot cite an issue that does not exist yet.
    const f = finding({ id: "547", citations: [cite(T - 20 * DAY)] });
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
    const kept = finding({ id: "547", citations: [cite(T + DAY)] });
    expect(outcomes([kept]).get("547")).toBe("FIXED");
  });

  test("a citation that changed no file is dropped — a merge of nothing is not a fix", () => {
    const f = finding({ id: "2", citations: [cite(T + DAY, 0)] });
    const [reading] = readFindingOutcomes([f], new Set());

    expect(reading.outcome).toBe("NO_ACTION");
    expect(reading.dropped.map(d => d.reason)).toEqual(["CHANGED_NOTHING"]);
  });

  test("an open finding has no outcome at all, rather than counting as noise", () => {
    expect(outcomes([finding({ id: "3", closed: false })]).get("3")).toBe("OPEN");
  });
});

describe("#1225: SUPERSEDED follows the chain, because duplicates are filed in chains", () => {
  test("a finding closed in favour of a FIXED one is SUPERSEDED", () => {
    const fixed = finding({ id: "10", citations: [cite(T + DAY)] });
    const dup = finding({ id: "11", closedInFavourOf: ["10"] });
    expect(outcomes([fixed, dup]).get("11")).toBe("SUPERSEDED");
  });

  test("a duplicate OF a duplicate is SUPERSEDED, and the chain is recorded", () => {
    // The case that caught the first version of this module. #547 names #530,
    // and #530 is itself a duplicate; a non-transitive walk scored both as
    // NO_ACTION and overstated the noise bucket by 26 rows out of 98. A noise
    // metric biased upward is the one that gets used to suppress.
    const fixed = finding({ id: "20", citations: [cite(T + DAY)] });
    const mid = finding({ id: "21", closedInFavourOf: ["20"] });
    const outer = finding({ id: "22", closedInFavourOf: ["21"] });

    const readings = readFindingOutcomes([fixed, mid, outer], new Set());
    const walked = readings.find(r => r.id === "22");

    expect(walked?.outcome).toBe("SUPERSEDED");
    expect(walked?.supersedeChain).toEqual(["21", "20"]);
  });

  test("a chain ending in NO_ACTION stays NO_ACTION — superseding nothing is not an answer", () => {
    const dead = finding({ id: "30" });
    const pointer = finding({ id: "31", closedInFavourOf: ["30"] });
    expect(outcomes([dead, pointer]).get("31")).toBe("NO_ACTION");
  });

  test("a reference to a merged pull request terminates the chain as SUPERSEDED", () => {
    // #473's close names #483, which is a PR and never appears in the issue
    // corpus. Without the shipped set it reads as a dangling reference.
    const dup = finding({ id: "473", closedInFavourOf: ["483"] });
    expect(outcomes([dup], ["483"]).get("473")).toBe("SUPERSEDED");
  });

  test("a reference cycle terminates instead of hanging, and is not SUPERSEDED", () => {
    const a = finding({ id: "40", closedInFavourOf: ["41"] });
    const b = finding({ id: "41", closedInFavourOf: ["40"] });
    expect(outcomes([a, b])).toEqual(new Map([["40", "NO_ACTION"], ["41", "NO_ACTION"]]));
  });
});

describe("#1225: the three verbal categories are UNMEASURED, not guessed", () => {
  test("NO_ACTION is the union of wrong, intentional and didn't-matter — never one of them", () => {
    // Nothing in the close path records which. Routing the whole bucket into
    // any single category would be a number with no evidence under it, and
    // three real categories beat four where one is a guess.
    const readings = readFindingOutcomes([finding({ id: "50" })], new Set());
    expect(readings[0].outcome).toBe("NO_ACTION");
    expect(readings[0].detail.join(" ")).toContain("wrong, intentional or didn't-matter");
  });

  test("a declared disposition is honoured, because that is the responder answering", () => {
    const f = finding({ id: "51", declared: "intentional" });
    expect(outcomes([f]).get("51")).toBe("INTENTIONAL");
  });

  test("a disposition that contradicts a fix commit is UNMEASURED, not a tiebreak", () => {
    // "the behaviour is intentional" and "here is the commit that changed it"
    // are both evidence and they disagree. Picking one silently is how a
    // contradiction becomes a clean number.
    const f = finding({ id: "52", declared: "wrong", citations: [cite(T + DAY)] });
    const [reading] = readFindingOutcomes([f], new Set());

    expect(reading.outcome).toBe("UNMEASURED");
    expect(reading.detail.join(" ")).toContain("contradicts");
  });

  test("the noise rate is withheld, not zero, while nothing declares a disposition", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: "60", citations: [cite(T + DAY)] }), finding({ id: "61" })], new Set()),
      "test corpus",
    );
    expect(run.declaredCoverage).toBe(0);
    expect(run.noiseRate).toBeNull();
  });

  test("once dispositions exist the rate is a number, so the null is a reading and not a stub", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [finding({ id: "70", citations: [cite(T + DAY)] }), finding({ id: "71", declared: "wrong" })],
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
      readFindingOutcomes([finding({ id: "80", citations: [cite(T + DAY)] })], new Set()),
      "566 closed issues in hornjason/pai-harness",
    );
    expect(run.population).toBe(1);
    expect(run.filter).toBe("566 closed issues in hornjason/pai-harness");
    expect(run.citationFilter).toContain("PREDATES_FILING");
  });

  test("dropped citations are reported rather than silently applied", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [finding({ id: "90", citations: [cite(T - DAY), cite(T + DAY, 0)] })],
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
      readFindingOutcomes([finding({ id: "100", closed: false })], new Set()),
      "test corpus",
    );
    expect(run.usable).toBe(false);
  });
});

describe("#1225: the comparison cannot be read as a licence to suppress", () => {
  const corpus = (fixedIds: string[], noiseIds: string[]) =>
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
  const filtered = (withheld: string[]) =>
    summariseFindingOutcomes(
      readFindingOutcomes(
        [
          ...["1", "2", "3"].map(id =>
            finding({ id, citations: [cite(T + DAY)], suppressed: withheld.includes(id) }),
          ),
          ...["4", "5", "6"].map(id => finding({ id, suppressed: withheld.includes(id) })),
        ],
        new Set(),
      ),
      "test corpus",
    );

  test("cutting noise while keeping every true finding is IMPROVED", () => {
    const result = compareReviewOutcomes(corpus(["1", "2", "3"], ["4", "5", "6"]), filtered(["5", "6"]));

    expect(result.fixedDelta).toBe(0);
    expect(result.costDelta).toBe(-2);
    expect(result.verdict).toBe("IMPROVED");
  });

  test("a suppressed candidate stays in the population, so the corpus cannot shrink", () => {
    // Without this the only way to model a filter is a smaller sweep, and a
    // smaller sweep reads as an improvement on every count at once.
    const after = filtered(["5", "6"]);
    expect(after.population).toBe(6);
    expect(after.suppressed).toBe(2);
    expect(after.closed).toBe(4);
  });

  test("losing one true finding is REGRESSION even when the noise falls to zero", () => {
    // The whole reason this function exists. A filter that silenced every
    // finding would read as a perfect noise score on any single-number metric.
    const result = compareReviewOutcomes(corpus(["1", "2", "3"], ["4", "5", "6"]), filtered(["3", "4", "5", "6"]));

    expect(result.fixedDelta).toBe(-1);
    expect(result.costDelta).toBe(-3);
    expect(result.verdict).toBe("REGRESSION");
    expect(result.detail.join(" ")).toContain("catching real bugs first");
  });

  test("silencing the reviewer entirely is REGRESSION, not a perfect score", () => {
    const result = compareReviewOutcomes(corpus(["1", "2", "3"], ["4", "5", "6"]), filtered(["1", "2", "3", "4", "5", "6"]));

    expect(result.costDelta).toBe(-3);
    expect(result.verdict).toBe("REGRESSION");
  });

  test("holding noise steady while keeping every true finding is NEUTRAL, not a win", () => {
    const before = corpus(["1", "2", "3"], ["4", "5", "6"]);
    const after = corpus(["1", "2", "3"], ["4", "5", "6"]);
    expect(compareReviewOutcomes(before, after).verdict).toBe("NEUTRAL");
  });

  test("two corpora of different sizes are UNMEASURED — a smaller sweep is not an improvement", () => {
    const before = corpus(["1", "2", "3"], ["4", "5", "6"]);
    const after = corpus(["1", "2", "3"], ["4"]);

    const result = compareReviewOutcomes(before, after);
    expect(result.verdict).toBe("UNMEASURED");
    expect(result.detail.join(" ")).toContain("not the same corpus");
  });

  test("an unusable reading on either side is UNMEASURED rather than defaulted", () => {
    const empty = summariseFindingOutcomes([], "test corpus");
    expect(compareReviewOutcomes(corpus(["1"], ["2"]), empty).verdict).toBe("UNMEASURED");
    expect(compareReviewOutcomes(empty, corpus(["1"], ["2"])).verdict).toBe("UNMEASURED");
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
    expect(shipped.has("1201")).toBe(true);
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
    expect(findings[0].closedInFavourOf).toEqual(["481", "483"]);
  });

  test("an open finding's comments are not read as a close", () => {
    const open = { ...issue(900), state: "open" };
    const { findings } = buildCorpus([open], new Map([[900, "related to #901"]]), []);
    expect(findings[0].closedInFavourOf).toEqual([]);
  });
});

describe("#1225: the truncated-history refusal, proved against a real shallow clone", () => {
  /**
   * A two-commit origin built from nothing, and the two clones of it.
   *
   * It does NOT clone this repository, which the first two drafts did and
   * which was wrong twice for the same reason: the ambient checkout's shape
   * is not a property of the guard. Asserting the graft COUNT passed locally
   * against a squash tip and failed on CI against a merge tip, because
   * `--depth 1` writes one boundary entry per parent. Cloning `--branch main`
   * then exited 128 on CI, because the Actions checkout has no local `main`.
   * Both reds were the fixture describing the runner rather than the code.
   *
   * Built here, the fixture states its own premise: a linear two-commit
   * history, so the full clone has exactly one real root and the depth-1
   * clone has exactly one graft, on every runner.
   */
  function fixtureOrigin(): string {
    const src = mkdtempSync(join(tmpdir(), "outcome-origin-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-C", src, ...args], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    };
    git("init", "--quiet", "--initial-branch", "main");
    git("config", "user.email", "control@test");
    git("config", "user.name", "Outcome control");
    for (const n of [1, 2]) {
      writeFileSync(join(src, `f${n}.txt`), `${n}\n`);
      git("add", "-A");
      git("commit", "--quiet", "-m", `commit ${n}`);
    }
    return src;
  }

  function cloneOf(src: string, depth: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "outcome-clone-"));
    rmSync(dir, { recursive: true, force: true });
    const clone = spawnSync(
      "git",
      ["clone", ...depth, "--no-local", "--branch", "main", `file://${src}`, dir, "--quiet"],
      { encoding: "utf-8" },
    );
    expect(clone.status).toBe(0);
    return dir;
  }

  test("a full clone has no grafted root on main", () => {
    const src = fixtureOrigin();
    const full = cloneOf(src, []);
    try {
      expect(graftedRoots(full)).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(full, { recursive: true, force: true });
    }
  }, 120_000);

  test("a depth-1 clone does, and names the graft", () => {
    // The guard that would have silently ruined this instrument: a shallow
    // `git log origin/main` returns a well-formed history starting at the
    // cut, and every finding older than it lands in NO_ACTION. The depth-1
    // clone is the input that separates pass from fail, and it is run here
    // rather than asserted. Its tip has one parent by construction, so the
    // count IS a property of the fixture now and can be asserted.
    const src = fixtureOrigin();
    const shallow = cloneOf(src, ["--depth", "1"]);
    try {
      const roots = graftedRoots(shallow);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatch(/^[0-9a-f]{40}$/);
      // And it really is the truncation, not the real root: the full clone
      // of the same origin reports none, two assertions up.
      expect(roots[0]).not.toBe(
        spawnSync("git", ["-C", src, "rev-list", "--max-parents=0", "main"], {
          encoding: "utf-8",
        }).stdout.trim(),
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(shallow, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("#1225: the plants, so a sweep returning zero is not mistaken for a blind one", () => {
  test("every plant names a real finding, an expected outcome and why", () => {
    expect(REVIEW_OUTCOME_PLANTS.length).toBeGreaterThanOrEqual(3);
    for (const plant of REVIEW_OUTCOME_PLANTS) {
      // A string id since #1253, so assert the property that matters — an id
      // that identifies something — rather than the numeric ordering that
      // `toBeGreaterThan(0)` used to stand in for. An empty string is the
      // failure this is guarding: a plant keyed on nothing matches nothing.
      expect(plant.id).not.toBe("");
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

describe("#1253: a corpus it cannot score unambiguously is refused, not scored wrong", () => {
  test("two findings sharing an id do not silently merge, and the fixed one keeps its citations", () => {
    // What #1225 shipped: `kept.set(f.id, …)` ran once per finding, so the
    // second row's empty citation list overwrote the first row's real one and
    // a genuinely FIXED finding came back NO_ACTION. Measured on b80c4985:
    // `7:NO_ACTION 7:NO_ACTION 99:NO_ACTION`, fixed=0, usable=true, nothing
    // said. The direction is what makes it serious — a row moves OUT of
    // `fixed` and INTO `cost`, manufacturing the exact REGRESSION reading
    // `compareReviewOutcomes` exists to detect.
    const readings = readFindingOutcomes(
      [
        finding({ id: "7", citations: [cite(T + DAY)] }),
        finding({ id: "7" }),
        finding({ id: "99", closedInFavourOf: ["7"] }),
      ],
      new Set(),
    );
    const run = summariseFindingOutcomes(readings, "test corpus");

    expect(run.usable).toBe(false);
    expect(run.detail.join(" ")).toContain("7");
    expect(run.detail.join(" ")).toMatch(/duplicate/i);
  });

  test("the refusal names every repeated id, not just the first", () => {
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [
          finding({ id: "a" }),
          finding({ id: "a" }),
          finding({ id: "b", citations: [cite(T + DAY)] }),
          finding({ id: "b" }),
          finding({ id: "c", citations: [cite(T + DAY)] }),
        ],
        new Set(),
      ),
      "test corpus",
    );
    const said = run.detail.join(" ");
    expect(run.usable).toBe(false);
    expect(said).toContain("a");
    expect(said).toContain("b");
  });

  test("a unique corpus is unaffected — the refusal is not a blanket one", () => {
    // The input that separates pass from fail. Same three rows, distinct ids:
    // the fixed one is FIXED and the run is usable.
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [
          finding({ id: "7", citations: [cite(T + DAY)] }),
          finding({ id: "8" }),
          finding({ id: "99", closedInFavourOf: ["7"] }),
        ],
        new Set(),
      ),
      "test corpus",
    );
    expect(run.usable).toBe(true);
    expect(run.fixed).toBe(1);
    expect(run.superseded).toBe(1);
  });

  test("a refused corpus cannot be compared, in either position", () => {
    // Otherwise the refusal is advisory: a caller that ignores `usable` still
    // gets a verdict, and the mis-scored row reads as a real regression.
    const dup = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: "x" }), finding({ id: "x" })], new Set()),
      "test corpus",
    );
    const ok = summariseFindingOutcomes(
      readFindingOutcomes([finding({ id: "x", citations: [cite(T + DAY)] })], new Set()),
      "test corpus",
    );
    expect(compareReviewOutcomes(dup, ok).verdict).toBe("UNMEASURED");
    expect(compareReviewOutcomes(ok, dup).verdict).toBe("UNMEASURED");
  });

  test("an id is a string, so an unfiled candidate's hash cannot collide with an issue number", () => {
    // A withheld candidate has no issue number and never will. Encoding its
    // symptom hash as a number is this same bug with a harder trigger: hash
    // 1169 and issue #1169 would key the same row.
    const run = summariseFindingOutcomes(
      readFindingOutcomes(
        [
          finding({ id: "1169", citations: [cite(T + DAY)] }),
          finding({ id: "sym:9f3a1c", suppressed: true }),
        ],
        new Set(),
      ),
      "test corpus",
    );
    expect(run.usable).toBe(true);
    expect(run.fixed).toBe(1);
    expect(run.suppressed).toBe(1);
  });
});
