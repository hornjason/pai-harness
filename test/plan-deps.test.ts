/**
 * `lib/spec-deps.ts` — the phase order as `blocked by` edges (#1647).
 *
 * ## Every case asserts MEMBERSHIP, not a count
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, seventh shape: predict the
 * membership, not just the total. A cross-product of 2x6 is twelve edges, and
 * twelve is also what you get from pairing the wrong two phases, from
 * reversing blocked and blocker, and from chaining the last phase to the
 * first. Each of those is a real way to write this function and a count
 * cannot see any of them, so the cases below name the pairs.
 *
 * ## And the write cases assert on the CALLS, not the exit code
 *
 * `scripts/plan-spec.ts` shipped a refusal that was computed AFTER its write
 * loop: every milestone was created and the command then exited 1. Nothing
 * reading an exit code can tell that apart from a refusal that stopped
 * something, so the negative cases here record what reached GitHub.
 */
import { describe, expect, test } from "bun:test";
import { dependencyPlan, groupByBlocked } from "../lib/spec-deps";
import type { DepIssue } from "../lib/spec-deps";
import { REFUSAL_EXIT, main as planDepsMain } from "../scripts/plan-deps";
import type { PlanDepsGitHub } from "../scripts/plan-deps";

/** One issue, spelled the way the GraphQL read spells it. */
function iss(
  number: number,
  phase: number | null,
  opts: { state?: string; blockedBy?: number[] } = {},
): DepIssue {
  return {
    number,
    state: opts.state ?? "OPEN",
    milestone: phase === null ? null : `Convergence Phase ${phase} — whatever it is called`,
    blockedBy: opts.blockedBy ?? [],
  };
}

/** `blocked<-blocker`, so a reversal is visible in the assertion text. */
const keys = (es: readonly { blocked: number; blocker: number }[]): string[] =>
  es.map(e => `${e.blocked}<-${e.blocker}`).sort();

describe("lib/spec-deps: the edges are the adjacent-phase cross product", () => {
  test("two phases: every phase-1 issue is blocked by every phase-0 issue, and not the reverse", () => {
    const plan = dependencyPlan([iss(10, 0), iss(11, 0), iss(20, 1), iss(21, 1)]);
    expect(keys(plan.missing)).toEqual(["20<-10", "20<-11", "21<-10", "21<-11"]);
    // The reversal is the wrong answer with the same count. Name it.
    expect(keys(plan.missing)).not.toContain("10<-20");
    expect(plan.phases).toEqual([0, 1]);
  });

  test("three phases chain ADJACENTLY — phase 2 is not blocked by phase 0 directly", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(30, 2)]);
    expect(keys(plan.missing)).toEqual(["20<-10", "30<-20"]);
    // The full-prefix version is the other plausible implementation and it is
    // the one the header argues against. It would add this edge.
    expect(keys(plan.missing)).not.toContain("30<-10");
  });

  test("a GAP in the numbering chains the phases that EXIST, not N-1", () => {
    // Phase 2 carries nothing. `p - 1` would leave #30 blocked by a phase
    // with no issues — zero blockers — which reads as startable and puts the
    // LAST phase in the Ready lane beside the first.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(30, 3)]);
    expect(plan.phases).toEqual([0, 1, 3]);
    expect(keys(plan.missing)).toEqual(["20<-10", "30<-20"]);
  });

  test("the lowest phase is blocked by nothing — that is the frontier", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(plan.missing.some(e => e.blocked === 10)).toBe(false);
    expect(plan.frontier).toBe(0);
  });
});

describe("lib/spec-deps: what it refuses to touch", () => {
  test("an edge it did not derive is EXTRA and never appears in missing", () => {
    // #1481 blocked by #1591 is live, real, and WITHIN a phase. A tool that
    // reconciled by deletion would destroy it.
    const plan = dependencyPlan([iss(10, 0), iss(20, 2), iss(21, 2, { blockedBy: [20] })]);
    expect(keys(plan.extra)).toEqual(["21<-20"]);
    expect(keys(plan.missing)).toEqual(["20<-10", "21<-10"]);
  });

  test("an already-present derived edge is PRESENT, so a re-run adds nothing", () => {
    const first = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(keys(first.missing)).toEqual(["20<-10"]);
    // Replay the world as it is after `--write`.
    const second = dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })]);
    expect(second.missing).toEqual([]);
    expect(keys(second.present)).toEqual(["20<-10"]);
    expect(second.extra).toEqual([]);
  });

  test("an issue with no Phase milestone gets no edge and is reported", () => {
    const plan = dependencyPlan([iss(10, 0), iss(20, 1), iss(99, null)]);
    expect(plan.unphased).toEqual([99]);
    expect(plan.missing.some(e => e.blocked === 99 || e.blocker === 99)).toBe(false);
  });

  test("a CLOSED issue is neither blocked nor a blocker by default", () => {
    const plan = dependencyPlan([iss(10, 0, { state: "CLOSED" }), iss(11, 0), iss(20, 1)]);
    expect(keys(plan.missing)).toEqual(["20<-11"]);
    // The pair: asking for them puts both back, so the case above is about
    // the filter and not about #10 being malformed.
    const withClosed = dependencyPlan(
      [iss(10, 0, { state: "CLOSED" }), iss(11, 0), iss(20, 1)],
      { includeClosed: true },
    );
    expect(keys(withClosed.missing)).toEqual(["20<-10", "20<-11"]);
  });
});

/**
 * The WHOLE class of degenerate readings, as one table.
 *
 * Four review rounds each found a different input that walked between two
 * hand-written guards — the last was `phases.length === 0`, where issues
 * exist (so the empty check is skipped) and there is no single phase (so the
 * one-phase check is skipped), and the command prints *"the tracker already
 * carries the phase order"* about a board it could not read.
 *
 * So the cases below are not four more `if`s. They enumerate every route to
 * **fewer than two phases**, which is the property, and the last case is the
 * negative control: the only input that must reach none of them.
 */
describe("lib/spec-deps: every route to fewer than two phases is UNMEASURED", () => {
  const cases: [string, DepIssue[], { includeClosed?: boolean }, string][] = [
    ["nothing read", [], {}, "failed fetch"],
    [
      "read, but nothing considered — every issue closed",
      [iss(10, 0, { state: "CLOSED" }), iss(20, 1, { state: "CLOSED" })],
      {},
      "none was considered",
    ],
    [
      "considered, but NOT ONE carries a Phase milestone",
      [iss(10, null), iss(20, null), iss(30, null)],
      {},
      "NONE carries a Phase milestone",
    ],
    ["exactly one phase", [iss(10, 0), iss(11, 0)], {}, "one phase states no order"],
  ];
  for (const [name, issues, opts, reason] of cases) {
    test(`${name} is UNMEASURED, and says which`, () => {
      const plan = dependencyPlan(issues, opts);
      expect(plan.reading).toBe("UNMEASURED");
      expect(plan.unmeasuredReasons.join(" ")).toContain(reason);
      expect(plan.missing, "an edge was derived from a reading that could not be taken").toEqual([]);
    });
  }

  test("THE NEGATIVE CONTROL: two phases over a considered set reads MEASURED", () => {
    // Without this, every case above passes against a function that refuses
    // unconditionally — four green rows witnessing nothing.
    const plan = dependencyPlan([iss(10, 0), iss(20, 1)]);
    expect(plan.reading).toBe("MEASURED");
    expect(keys(plan.missing)).toEqual(["20<-10"]);
  });

  test("the unphased case is NOT the same as the no-issues case — the reasons differ", () => {
    // Both produce `missing: []`. Only the text distinguishes them, and the
    // whole point of the row is that a reader can act on which one it is.
    const empty = dependencyPlan([]).unmeasuredReasons.join(" ");
    const unphased = dependencyPlan([iss(10, null)]).unmeasuredReasons.join(" ");
    expect(unphased).not.toBe(empty);
    expect(unphased).toContain("plan-spec has not run");
  });

  test("a TRUNCATED blocker list refuses even when the phases are sound", () => {
    // Orthogonal to the count: two phases, a derivable order, and a live edge
    // list the reader could not see the end of. Deriving from it would re-add
    // an edge that already exists past the page boundary.
    const plan = dependencyPlan([
      iss(10, 0),
      { ...iss(20, 1), blockedBy: [10], blockedByTruncated: true },
    ]);
    expect(plan.reading).toBe("UNMEASURED");
    expect(plan.unmeasuredReasons.join(" ")).toContain("truncated");
    expect(plan.unmeasuredReasons.join(" ")).toContain("#20");
    // The pair: the identical input with the flag off is MEASURED.
    expect(dependencyPlan([iss(10, 0), iss(20, 1, { blockedBy: [10] })]).reading).toBe("MEASURED");
  });
});

describe("lib/spec-deps: the grouping is what reaches GitHub", () => {
  test("edges collapse to one call per BLOCKED issue, blockers sorted", () => {
    const plan = dependencyPlan([iss(10, 0), iss(11, 0), iss(20, 1), iss(21, 1)]);
    expect(groupByBlocked(plan.missing)).toEqual([
      { blocked: 20, blockers: [10, 11] },
      { blocked: 21, blockers: [10, 11] },
    ]);
  });

  test("the grouping loses no edge — 2x3 is six edges in three calls", () => {
    const plan = dependencyPlan([iss(1, 0), iss(2, 0), iss(7, 1), iss(8, 1), iss(9, 1)]);
    const groups = groupByBlocked(plan.missing);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap(g => g.blockers.map(b => `${g.blocked}<-${b}`)).sort()).toEqual(
      keys(plan.missing),
    );
  });
});

/**
 * `scripts/plan-deps.ts --write` — what reaches GitHub, and when it does not.
 */
describe("scripts/plan-deps --write: nothing reaches GitHub on an unmeasured reading", () => {
  function spy(issues: DepIssue[]) {
    const calls: string[] = [];
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => issues,
      addBlockers: async (_repo, blocked, blockers) => {
        calls.push(`#${blocked} +${[...blockers].join(",")}`);
      },
    };
    return { gh, calls };
  }

  test("a sound two-phase reading writes, one call per blocked issue", async () => {
    const s = spy([iss(10, 0), iss(11, 0), iss(20, 1)]);
    const code = await planDepsMain(["--repo", "o/r", "--write"], s.gh);
    expect(s.calls).toEqual(["#20 +10,11"]);
    expect(code).toBe(0);
  });

  test("an EMPTY read writes nothing and refuses", async () => {
    const s = spy([]);
    const code = await planDepsMain(["--repo", "o/r", "--write"], s.gh);
    expect(s.calls, "an edge was written despite the refusal").toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a SINGLE-PHASE read writes nothing and refuses", async () => {
    const s = spy([iss(10, 0), iss(11, 0)]);
    const code = await planDepsMain(["--repo", "o/r", "--write"], s.gh);
    expect(s.calls).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("a FAILED write exits non-zero — the status is derived from what happened", async () => {
    // `applyEdges` catches each failure into a "FAILED" string and returns
    // it. Nothing read that array, so a run where every `gh issue edit` call
    // failed printed its failures among the successes and returned 0. The
    // same defect was fixed in `plan-issues` by this PR and left here.
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    const code = await planDepsMain(["--repo", "o/r", "--write"], gh);
    expect(code, "every write failed and the command reported success").toBe(REFUSAL_EXIT);
  });

  test("--json --write reports `partial` on a failed write, not `yes`", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const gh: PlanDepsGitHub = {
      createClient: (() => ({}) as never) as PlanDepsGitHub["createClient"],
      readIssues: async () => [iss(10, 0), iss(20, 1)],
      addBlockers: async () => {
        throw new Error("gh: HTTP 503");
      },
    };
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json"], gh);
    } finally {
      console.log = log;
    }
    const json = JSON.parse(out.join("\n"));
    expect(json.wrote, "a run whose every write failed printed a clean status").toBe("partial");
    expect(json.results.join(" ")).toContain("FAILED");
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("--json --write on a sound plan still reports `yes` and applies", async () => {
    // The pair for both cases above: without it they pass against a command
    // that reports "partial" unconditionally.
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)]);
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json"], s.gh);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
    expect(s.calls).toEqual(["#20 +10"]);
    expect(code).toBe(0);
  });

  test("a second --write run is a no-op — the command is idempotent", async () => {
    const s = spy([iss(10, 0), iss(20, 1, { blockedBy: [10] })]);
    const code = await planDepsMain(["--repo", "o/r", "--write"], s.gh);
    expect(s.calls, "an edge that already exists was written again").toEqual([]);
    expect(code).toBe(0);
  });

  test("--write never removes an EXTRA edge", async () => {
    const s = spy([iss(10, 0), iss(20, 1), iss(21, 1, { blockedBy: [20] })]);
    await planDepsMain(["--repo", "o/r", "--write"], s.gh);
    // Only the derived pair is added; nothing in the call list removes 21<-20
    // and `addBlockers` is the only mutation the seam exposes.
    expect(s.calls).toEqual(["#20 +10", "#21 +10"]);
  });

  test("--json --write writes too, and says which of the three states it was in", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([iss(10, 0), iss(20, 1)]);
    try {
      await planDepsMain(["--repo", "o/r", "--write", "--json"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual(["#20 +10"]);
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
  });

  test("--json --write on an unmeasured reading reports `refused`, and writes nothing", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (x: string) => void out.push(x);
    const s = spy([]);
    let code;
    try {
      code = await planDepsMain(["--repo", "o/r", "--write", "--json"], s.gh);
    } finally {
      console.log = log;
    }
    expect(s.calls).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(out.join("\n")).wrote).toBe("refused");
  });

  test("no --repo and no GITHUB_REPOSITORY refuses before reading anything", async () => {
    const s = spy([iss(10, 0), iss(20, 1)]);
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      expect(await planDepsMain(["--write"], s.gh)).toBe(REFUSAL_EXIT);
      expect(s.calls).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });
});

/**
 * The live convergence set, as a regression control.
 *
 * These numbers are a snapshot of a real board and will move. What must not
 * move is the SHAPE: the frontier is blocked by nothing, each later phase is
 * blocked by exactly the size of the phase before it, and the two
 * hand-authored within-phase edges are reported as EXTRA rather than planned.
 */
describe("the shape the live convergence board has", () => {
  const phaseSizes = [2, 6, 8, 4, 3, 10, 6];
  const issues: DepIssue[] = [];
  let next = 1;
  phaseSizes.forEach((size, phase) => {
    for (let k = 0; k < size; k++) issues.push(iss(next++, phase));
  });

  test("194 edges over 37 blocked issues, and the frontier carries none", () => {
    const plan = dependencyPlan(issues);
    const expected = phaseSizes.slice(1).reduce((sum, size, k) => sum + size * phaseSizes[k], 0);
    expect(expected).toBe(194);
    expect(plan.missing).toHaveLength(194);
    expect(groupByBlocked(plan.missing)).toHaveLength(37);
    expect(plan.missing.some(e => e.blocked <= phaseSizes[0])).toBe(false);
  });

  test("each issue carries exactly the previous phase's size in blockers", () => {
    const plan = dependencyPlan(issues);
    const counts = new Map<number, number>();
    for (const e of plan.missing) counts.set(e.blocked, (counts.get(e.blocked) ?? 0) + 1);
    let n = phaseSizes[0] + 1;
    for (let p = 1; p < phaseSizes.length; p++) {
      for (let k = 0; k < phaseSizes[p]; k++, n++) {
        expect(counts.get(n), `issue ${n} in phase ${p}`).toBe(phaseSizes[p - 1]);
      }
    }
  });
});
