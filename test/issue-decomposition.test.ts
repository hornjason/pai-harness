/**
 * Step 4 of ADR-003: one criterion into the right number of issues.
 *
 * The interesting half is the refusals. A parser that silently drops a row it
 * cannot read produces a shorter list, and a shorter list is exactly what a
 * plan with less work in it produces — so every rejection below is paired with
 * a prediction about WHICH rows survive, not just how many
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the seventh shape).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REFUSAL_EXIT, main as planIssuesMain } from "../scripts/plan-issues";
import type { DecomposeGitHub } from "../scripts/plan-issues";
import {
  MAX_FILES,
  MIN_OUTCOME,
  type DecompositionRow,
  type LiveTracker,
  decomposedBody,
  parseDecompositionPlan,
  planDecomposition,
} from "../lib/issue-decomposition";

const HEAD = ["| Criterion | Outcome | Files | Milestone | Blocked by |", "|---|---|---|---|---|"];

function plan(...rows: string[]): string {
  return ["# A plan somebody reviewed", "", ...HEAD, ...rows, ""].join("\n");
}

const GOOD = "| CRC-C2 | plan-deps refuses a single-phase reading | lib/spec-deps.ts | Phase 3 | — |";

describe("parseDecompositionPlan reads a reviewed table", () => {
  test("a well-formed row becomes one issue", () => {
    const r = parseDecompositionPlan(plan(GOOD));
    expect(r.reading).toBe("MEASURED");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      criterion: "CRC-C2",
      outcome: "plan-deps refuses a single-phase reading",
      files: ["lib/spec-deps.ts"],
      milestone: "Phase 3",
      blockedBy: [],
    });
  });

  test("several rows MAY name one criterion — that is what decomposition IS", () => {
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | — |",
      ),
    );
    expect(r.reading).toBe("MEASURED");
    expect(r.rows.map(x => x.criterion)).toEqual(["CRC-C2", "CRC-C2"]);
  });

  test("a row may be blocked by another row in the same plan", () => {
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
      ),
    );
    expect(r.reading).toBe("MEASURED");
    expect(r.rows[1].blockedBy).toEqual(["the first half of the work"]);
  });

  /**
   * Every row here is a plan that must NOT be applied. The prediction is the
   * reading AND that nothing survived to be created — an UNMEASURED reading
   * whose rows still got used would be the whole point missed.
   */
  const refuse: { why: string; row: string; reason: RegExp }[] = [
    {
      why: "no criterion id in the first cell",
      row: "| something | an outcome long enough to pass | lib/a.ts | — | — |",
      reason: /holds no criterion id/,
    },
    {
      why: "two criteria in one row — one row is one issue serving one criterion",
      row: "| CRC-C2, CRC-C3 | an outcome long enough to pass | lib/a.ts | — | — |",
      reason: /names 2 criteria/,
    },
    {
      why: "an outcome too short to be a title",
      row: "| CRC-C2 | wip | lib/a.ts | — | — |",
      reason: /characters — it becomes the issue title/,
    },
    {
      why: "names no file — AGENTS.md rule 2 says it is not ready",
      row: "| CRC-C2 | an outcome long enough to pass | — | — | — |",
      reason: /names no file/,
    },
    {
      why: `names more than ${MAX_FILES} files — AGENTS.md rule 3`,
      row: `| CRC-C2 | an outcome long enough to pass | ${Array.from({ length: MAX_FILES + 1 }, (_, i) => `lib/f${i}.ts`).join(", ")} | — | — |`,
      reason: new RegExp(`names ${MAX_FILES + 1} files`),
    },
    {
      why: "too few cells to be a row at all",
      row: "| CRC-C2 | an outcome long enough to pass |",
      reason: /only 2 cells, need 5/,
    },
    {
      // `c.length < 5` let this through and only c[0]..c[4] were read, so
      // the tail was silently truncated — the one thing this module promises
      // not to do. Found by the AI review of this change.
      why: "TOO MANY cells — an unescaped `|` leaked into a cell",
      row: "| CRC-C2 | an outcome with a | pipe in it | lib/a.ts | — | — |",
      reason: /6 cells, need 5/,
    },
    {
      // Refused here rather than at the blocker check, where the message
      // would blame the referencing row for a table that is correct.
      why: "an outcome containing a comma — nothing could ever reference it",
      row: "| CRC-C2 | fix off-by-one, add bounds check | lib/a.ts | — | — |",
      reason: /contains a comma/,
    },
  ];

  for (const r of refuse) {
    test(`REFUSED: ${r.why}`, () => {
      const reading = parseDecompositionPlan(plan(r.row));
      expect(reading.reading, `this plan was readable: ${r.why}`).toBe("UNMEASURED");
      expect(reading.rejected.map(x => x.why).join(" | ")).toMatch(r.reason);
      expect(reading.rows, "a refused row still produced an issue to create").toEqual([]);
    });
  }

  test("one bad row makes the WHOLE reading unmeasured, not a partial plan", () => {
    // The control the rows above need: the good row is readable on its own,
    // so a red here is the contamination and not the fixture.
    expect(parseDecompositionPlan(plan(GOOD)).reading).toBe("MEASURED");
    const mixed = parseDecompositionPlan(plan(GOOD, "| CRC-C3 | wip | lib/b.ts | — | — |"));
    expect(mixed.reading).toBe("UNMEASURED");
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.unmeasuredReasons.join(" ")).toMatch(/partly unreadable is not a plan/);
  });

  test("two rows with one outcome are refused — nothing could say which an edge meant", () => {
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the very same outcome text | lib/a.ts | — | — |",
        "| CRC-C3 | the very same outcome text | lib/b.ts | — | — |",
      ),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/appears twice/);
  });

  test("a row blocked by ITSELF is refused — it would never start", () => {
    // `byOutcome` holds every row INCLUDING this one, so the membership test
    // was true for the row's own outcome even though the message two lines
    // below said "another row". On --write both ends of the edge resolved to
    // one freshly created number and the issue was filed blocked by itself.
    // Found by the AI review of this change.
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome long enough to pass | lib/a.ts | — | an outcome long enough to pass |"),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/blocked by itself/);
  });

  test("TWO rows blocking each other are refused — the self-block case at N=2", () => {
    // The self-block guard tested `b === r.outcome`, so a 2-cycle walked
    // straight past it: each row names the OTHER row's real outcome, so
    // neither is self-referential and both resolve. On --write that created
    // both issues and wired each blocked by the other — the same permanently
    // unstartable pair, reached by two rows. Found by the AI review of this
    // change, after the N=1 fix.
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the first half of the work | lib/a.ts | — | the second half of the work |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
      ),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/blocking CYCLE/);
  });

  test("a THREE-row ring is refused too — the property is acyclicity, not pairs", () => {
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the first part of the work | lib/a.ts | — | the second part of the work |",
        "| CRC-C2 | the second part of the work | lib/b.ts | — | the third part of the work |",
        "| CRC-C2 | the third part of the work | lib/c.ts | — | the first part of the work |",
      ),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/blocking CYCLE/);
  });

  test("a three-row CHAIN is accepted — the control the two cases above need", () => {
    // Same three rows, one edge reversed so the ring opens. Without this,
    // a detector that refused every multi-row ordering would pass both
    // cases above while making the whole feature unusable.
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the first part of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second part of the work | lib/b.ts | — | the first part of the work |",
        "| CRC-C2 | the third part of the work | lib/c.ts | — | the second part of the work |",
      ),
    );
    expect(r.reading, r.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(r.rows).toHaveLength(3);
  });

  test("a DIAMOND is accepted — two rows sharing a blocker is not a cycle", () => {
    // The other way a cycle detector goes wrong: revisiting a node that is
    // merely reachable twice, rather than one that is on the current path.
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | the groundwork everything needs | lib/a.ts | — | — |",
        "| CRC-C2 | the left branch of the work | lib/b.ts | — | the groundwork everything needs |",
        "| CRC-C2 | the right branch of the work | lib/c.ts | — | the groundwork everything needs |",
        "| CRC-C2 | the join at the end of it | lib/d.ts | — | the left branch of the work, the right branch of the work |",
      ),
    );
    expect(r.reading, r.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(r.rows).toHaveLength(4);
  });

  test("an outcome with an INLINE backtick can still be referenced", () => {
    // Two normalisations: the outcome stripped every backtick and a cell
    // entry stripped only boundary ones. They agree on everything except a
    // title naming a function — which is most titles — so a blocked-by
    // quoting the row character for character missed, and the plan was
    // refused about a row that was right there. Found by the AI review.
    const r = parseDecompositionPlan(
      plan(
        "| CRC-C2 | add bounds check to `cells()` | lib/a.ts | — | — |",
        "| CRC-C2 | the work that comes after it | lib/b.ts | — | add bounds check to `cells()` |",
      ),
    );
    expect(r.reading, r.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(r.rows[0].outcome).toBe("add bounds check to cells()");
    expect(r.rows[1].blockedBy).toEqual(["add bounds check to cells()"]);
  });

  test("ONE normalisation, not two that agree on most inputs", () => {
    // The control for the case above. Both sides must land on the same
    // string for a value where a boundary-only strip and an all-strip give
    // different answers — asserting the agreement, not just one output.
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | wraps `a` and `b` tightly | `lib/a.ts`, lib/`b`.ts | — | — |"),
    );
    expect(r.reading, r.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(r.rows[0].outcome).toBe("wraps a and b tightly");
    expect(r.rows[0].files).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("TWO backslashes before a pipe: the pipe stays escaped, as GFM reads it", () => {
    // Round 11 reported this as a column merge — "GFM renders these as two
    // columns and rowCells() merges them". MEASURED against POST /markdown
    // mode=gfm on 2026-10-30, it does not:
    //
    //   | CRC-C2 | ends in backslash\\| lib/a.ts | x | y |
    //     -> ['CRC-C2', 'ends in backslash| lib/a.ts', 'x', 'y', '']
    //   | CRC-C2 | has a \| pipe here | lib/a.ts | x |      (the control)
    //     -> ['CRC-C2', 'has a | pipe here', 'lib/a.ts', 'x', '']
    //
    // Identical shape. GFM's table splitter uses a ONE-character lookbehind,
    // so a pipe preceded by a backslash is never a delimiter however many
    // backslashes precede THAT. The renderer pads the short row to the
    // header width; this parser refuses it on the cell count, which is the
    // safe direction and the one #1671 established.
    //
    // Written as a case rather than only as a reply because the premise was
    // asserted about a renderer, and on #1671 accepting exactly that kind of
    // unmeasured premise introduced a real bypass.
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | ends in backslash\\| lib/a.ts | Phase 3 | — |"),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.rejected.map(x => x.why).join(" ")).toMatch(/only 4 cells, need 5/);
  });

  test("a backticked MILESTONE matches the live one — the third normalisation site", () => {
    // The outcome and the cells were collapsed onto one `plain()` and this
    // was left on a bare trim, so `` `Phase 3` `` kept its backticks, missed
    // a milestone that exists, and the plan was refused telling the author
    // to create it. Found by the AI review one round after that collapse.
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome long enough to pass | lib/a.ts | `Phase 3` | — |"),
    );
    expect(r.reading, r.unmeasuredReasons.join(" | ")).toBe("MEASURED");
    expect(r.rows[0].milestone).toBe("Phase 3");
  });

  test("a blocker naming neither #<n> nor another row is refused, never dropped", () => {
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome long enough to pass | lib/a.ts | — | some work elsewhere |"),
    );
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/neither #<issue> nor the outcome of another row/);
  });

  test("a #<n> blocker is accepted — it names an issue that already exists", () => {
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome long enough to pass | lib/a.ts | — | #1234 |"),
    );
    expect(r.reading).toBe("MEASURED");
    expect(r.rows[0].blockedBy).toEqual(["#1234"]);
  });

  test("no table at all is UNMEASURED, not an empty plan", () => {
    // These are different facts: one is a plan with nothing left to create,
    // the other is a file this command cannot read.
    const r = parseDecompositionPlan("# A document with prose and no table\n");
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toMatch(/no .* table/);
  });

  test("a header with no rows under it is UNMEASURED too", () => {
    expect(parseDecompositionPlan(plan()).reading).toBe("UNMEASURED");
  });

  /**
   * The refusal above tells the author to write `\|`. These are the cases
   * that make that sentence true rather than a loop they cannot escape — the
   * previous round shipped the message while `split("|")` still read the
   * escape as a separator, so following the advice reproduced the identical
   * refusal.
   *
   * The expectations are what `POST /markdown` with `mode=gfm` returned on
   * 2026-10-30, not what the escape ought to mean.
   */
  test("an ESCAPED pipe is one cell, and the backslash does not survive into the title", () => {
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome with a \\| pipe in it | lib/a.ts | — | — |"),
    );
    expect(r.reading).toBe("MEASURED");
    expect(r.rows[0].outcome).toBe("an outcome with a | pipe in it");
  });

  test("an escaped pipe in a FILES cell is part of the path, not a column break", () => {
    const r = parseDecompositionPlan(
      plan("| CRC-C2 | an outcome long enough to pass | lib/a\\|b.ts | — | — |"),
    );
    expect(r.reading).toBe("MEASURED");
    expect(r.rows[0].files).toEqual(["lib/a|b.ts"]);
  });

  test("the escape is the ONLY thing that saves the row — the control", () => {
    // Same bytes without the backslash. If this went MEASURED too, the case
    // above would be green whether or not the escape was ever implemented.
    expect(
      parseDecompositionPlan(
        plan("| CRC-C2 | an outcome with a | pipe in it | lib/a.ts | — | — |"),
      ).reading,
    ).toBe("UNMEASURED");
  });

  test("the thresholds the refusals quote are the ones the module exports", () => {
    expect(MAX_FILES).toBe(9);
    expect(MIN_OUTCOME).toBe(12);
  });
});

/**
 * Four rounds of this PR found four defects and the AI review's fourth round
 * named the thing they had in common: each was a read or a check that treated
 * an incomplete result as a clean one, and each was repaired one call site at
 * a time. Fixing `openTitles` did not prevent the identical miss in
 * `milestones` one function away.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` calls that the N-sites shape
 * and says what to do about it: **assert the property across the sites**
 * rather than repairing them one at a time, because a behavioural suite
 * catches only the last site to regress. This is that assertion. It reads the
 * source because the completeness of a paginated read is not observable from
 * a fake in a unit test — the fake returns whatever it was handed.
 */
describe("every live list read proves it is complete", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "scripts", "plan-issues.ts"), "utf8");

  /**
   * The first version of this keyed on `per_page`: it flagged a call that
   * asked for a page size without asking for every page. That could not
   * fail for the population it was written about — the two sites it missed
   * (`dep()` in the repair path, `blockedBy` in the decompose path) carried
   * NO `per_page`, so the predicate never looked at them, and the check
   * certified a completeness it had not examined. It was a control written
   * against the two defects already fixed rather than against the property.
   * Found by the AI review of this change, one round after the check landed.
   *
   * The predicate is now the property: a `gh api` call reads every page.
   */
  const apiCalls = (): string[] =>
    [...SRC.matchAll(/gh\(\[([\s\S]*?)\]\)/g)].map(m => m[1]).filter(c => c.includes('"api"'));

  test("EVERY `gh api` call reads every page", () => {
    expect(
      apiCalls().filter(c => !c.includes("--paginate")),
      "a `gh api` read with no `--paginate` returns the FIRST page and reports it as the " +
        "whole answer. Add `--paginate` (and `--jq` per row — `--paginate` concatenates each " +
        "page's response, so the result is not one JSON document). If the endpoint really " +
        "returns a single resource rather than a list, say so in a comment on the call.",
    ).toEqual([]);
  });

  test("the scan can see the calls at all — the control", () => {
    // Without this, renaming `gh` or deleting the readers makes the case
    // above green by matching nothing, which is the failure it exists to
    // catch wearing the costume of a pass. Four today: two dependency
    // reads, the issue list and the milestone list.
    expect(apiCalls().length).toBeGreaterThanOrEqual(4);
  });
});

describe("planDecomposition resolves rows against the tracker as it is now", () => {
  const row = (over: Partial<DecompositionRow> = {}): DecompositionRow => ({
    criterion: "CRC-C2",
    outcome: "plan-deps refuses a single-phase reading",
    files: ["lib/spec-deps.ts"],
    milestone: null,
    blockedBy: [],
    line: 3,
    ...over,
  });
  const empty: LiveTracker = { openTitles: new Map(), milestones: new Set() };
  const HEADING = "## Criteria this serves";

  test("a title nothing holds becomes a create", () => {
    const p = planDecomposition([row()], empty, "docs/adr/ADR-009.md", HEADING);
    expect(p.reading).toBe("MEASURED");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].kind).toBe("create");
    if (p.actions[0].kind === "create") {
      expect(p.actions[0].title).toBe("plan-deps refuses a single-phase reading");
      expect(p.actions[0].body).toContain("CRC-C2");
      expect(p.actions[0].body).toContain("lib/spec-deps.ts");
    }
  });

  test("RE-RUN: an open issue with the same title is not created again", () => {
    const live: LiveTracker = {
      openTitles: new Map([["plan-deps refuses a single-phase reading", 1700]]),
      milestones: new Set(),
    };
    const p = planDecomposition([row()], live, "docs/adr/ADR-009.md", HEADING);
    expect(p.actions[0]).toEqual({ kind: "exists", row: row(), number: 1700 });
  });

  test("the match is EXACT — a title containing a row's outcome is a different issue", () => {
    // The control for the re-run case. A substring match here would read a
    // longer, unrelated title as "already created" and silently skip the row.
    const live: LiveTracker = {
      openTitles: new Map([
        ["plan-deps refuses a single-phase reading, and also deletes main", 1700],
      ]),
      milestones: new Set(),
    };
    expect(planDecomposition([row()], live, "p.md", HEADING).actions[0].kind).toBe("create");
  });

  test("a milestone that does not exist refuses the run rather than inventing a phase", () => {
    const p = planDecomposition([row({ milestone: "Phase 9" })], empty, "p.md", HEADING);
    expect(p.reading).toBe("UNMEASURED");
    expect(p.unmeasuredReasons.join(" ")).toMatch(/Phase 9.*does not exist.*plan-spec/);
  });

  test("a milestone that DOES exist is accepted — the control for the refusal above", () => {
    const live: LiveTracker = { openTitles: new Map(), milestones: new Set(["Phase 9"]) };
    expect(planDecomposition([row({ milestone: "Phase 9" })], live, "p.md", HEADING).reading).toBe(
      "MEASURED",
    );
  });

  test("edges are emitted for every blocker, including to a row that already exists", () => {
    const live: LiveTracker = { openTitles: new Map([["the first half", 1700]]), milestones: new Set() };
    const p = planDecomposition(
      [
        row({ outcome: "the first half" }),
        row({ outcome: "the second half", blockedBy: ["the first half", "#9"] }),
      ],
      live,
      "p.md",
      HEADING,
    );
    expect(p.edges).toEqual([
      { blocked: "the second half", blocker: "the first half" },
      { blocked: "the second half", blocker: "#9" },
    ]);
  });
});

describe("decomposedBody writes what the issue has to carry", () => {
  const r: DecompositionRow = {
    criterion: "CRC-C2",
    outcome: "plan-deps refuses a single-phase reading",
    files: ["lib/spec-deps.ts", "test/spec-deps.test.ts"],
    milestone: "Phase 3",
    blockedBy: [],
    line: 3,
  };

  test("the criterion sits under the heading issue-repair already owns", () => {
    // One reader finds a created issue and a repaired one, or the inventory
    // sees half the population.
    const body = decomposedBody(r, "## Criteria this serves", "docs/adr/ADR-009.md");
    const at = body.indexOf("## Criteria this serves");
    expect(at).toBeGreaterThan(-1);
    expect(body.slice(at)).toContain("CRC-C2");
  });

  test("every file is named in the body, not only in the plan", () => {
    // AGENTS.md rule 2 is about the ISSUE. A file list that lives only in a
    // plan file is one nobody reading the tracker can check.
    const body = decomposedBody(r, "## Criteria this serves", "docs/adr/ADR-009.md");
    for (const f of r.files) expect(body).toContain(f);
  });

  test("the body names the plan it came from", () => {
    expect(decomposedBody(r, "## Criteria this serves", "docs/adr/ADR-009.md")).toContain(
      "docs/adr/ADR-009.md",
    );
  });
});

describe("scripts/plan-issues --decompose: what reaches GitHub", () => {
  /** Records every call, so a case asserts on what was DONE, not what was returned. */
  function recorder(
    seed: { open?: [string, number][]; milestones?: string[]; wired?: [number, number[]][] } = {},
  ) {
    const calls: string[] = [];
    let next = 2000;
    const wired = new Map(seed.wired ?? []);
    const api: DecomposeGitHub = {
      openTitles: async () => new Map(seed.open ?? []),
      milestones: async () => new Set(seed.milestones ?? []),
      blockedBy: async (_repo, issue) => {
        calls.push(`read blocked-by of #${issue}`);
        return wired.get(issue) ?? [];
      },
      create: async (_repo, issue) => {
        const n = next++;
        calls.push(`create #${n} "${issue.title}" milestone=${issue.milestone ?? "-"}`);
        return n;
      },
      addBlockedBy: async (_repo, blocked, blocker) => {
        calls.push(`edge #${blocked} blocked by #${blocker}`);
      },
    };
    return { api, calls };
  }

  async function run(rows: string[], api: DecomposeGitHub, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "rg-decompose-"));
    try {
      const p = join(dir, "plan.md");
      writeFileSync(p, plan(...rows));
      const code = await planIssuesMain(
        ["--decompose", p, "--repo", "o/r", ...extra],
        undefined as never,
        api,
      );
      return code;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("without --write nothing is created", async () => {
    // `Phase 3` must exist even for a dry run: the reading is validated
    // against the live tracker either way, so a plan you could not apply
    // does not print a list that looks applicable.
    const { api, calls } = recorder({ milestones: ["Phase 3"] });
    expect(await run([GOOD], api, [])).toBe(0);
    expect(calls, "a dry run reached GitHub").toEqual([]);
  });

  test("with --write the issue is created, carrying its milestone", async () => {
    const { api, calls } = recorder({ milestones: ["Phase 3"] });
    expect(await run([GOOD], api, ["--write"])).toBe(0);
    expect(calls).toEqual([
      'create #2000 "plan-deps refuses a single-phase reading" milestone=Phase 3',
    ]);
  });

  /**
   * The two-pass property, and the reason the passes exist. A row blocked by
   * another row in the SAME plan has no number until that row is created, so
   * a one-pass implementation drops every forward reference — silently, since
   * an absent edge looks exactly like an order nobody asked for.
   */
  test("an edge to a row created in the same run is wired, not dropped", async () => {
    const { api, calls } = recorder();
    const code = await run(
      [
        "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
      ],
      api,
      ["--write"],
    );
    expect(code).toBe(0);
    expect(calls).toEqual([
      'create #2000 "the first half of the work" milestone=-',
      'create #2001 "the second half of the work" milestone=-',
      // The edge pass READS before it writes. Asserted in the sequence
      // rather than as a separate case, so a version that writes blind
      // cannot satisfy this list.
      "read blocked-by of #2001",
      "edge #2001 blocked by #2000",
    ]);
  });

  test("an edge to an issue that already exists uses its number", async () => {
    const { api, calls } = recorder({ open: [["the first half of the work", 1700]] });
    await run(
      [
        "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
      ],
      api,
      ["--write"],
    );
    expect(calls).toEqual([
      'create #2000 "the second half of the work" milestone=-',
      "read blocked-by of #2000",
      "edge #2000 blocked by #1700",
    ]);
  });

  /**
   * The other half of the re-run story. `openTitles` made issue creation
   * idempotent and nothing made the EDGES idempotent, so every already-wired
   * edge was re-issued.
   *
   * Measured against the live API on 2026-10-30 rather than assumed:
   * `gh issue edit 1667 --add-blocked-by 1658` on an edge that already
   * existed exited **1** with "Validation failed: Target issue has already
   * been taken", and the edge was neither duplicated nor removed. `gh()`
   * turns a non-zero exit into a throw, so a perfectly clean re-run put every
   * correct edge in `failed` and the command refused. The tracker was right
   * and the report was wrong — the worse direction, because the report is
   * what somebody acts on.
   */
  test("RE-RUN does not re-issue an edge the tracker already has", async () => {
    const { api, calls } = recorder({
      open: [
        ["the first half of the work", 1700],
        ["the second half of the work", 1701],
      ],
      wired: [[1701, [1700]]],
    });
    const code = await run(
      [
        "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
        "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
      ],
      api,
      ["--write"],
    );
    expect(code, "a clean re-run refused").toBe(0);
    expect(calls).toEqual(["read blocked-by of #1701"]);
  });

  test("the SAME plan against a tracker with no edge DOES wire it — the control", async () => {
    // Identical input, one field different: nothing is wired yet. Without
    // this, a version that skipped every edge unconditionally would pass the
    // case above and write no orders at all.
    const { api, calls } = recorder({
      open: [
        ["the first half of the work", 1700],
        ["the second half of the work", 1701],
      ],
      wired: [],
    });
    expect(
      await run(
        [
          "| CRC-C2 | the first half of the work | lib/a.ts | — | — |",
          "| CRC-C2 | the second half of the work | lib/b.ts | — | the first half of the work |",
        ],
        api,
        ["--write"],
      ),
    ).toBe(0);
    expect(calls).toEqual(["read blocked-by of #1701", "edge #1701 blocked by #1700"]);
  });

  test("RE-RUN creates nothing the second time", async () => {
    const { api, calls } = recorder({
      open: [["plan-deps refuses a single-phase reading", 1700]],
      milestones: ["Phase 3"],
    });
    expect(await run([GOOD], api, ["--write"])).toBe(0);
    expect(calls, "a re-run created a duplicate").toEqual([]);
  });

  test("an unreadable plan refuses and reaches GitHub for nothing but the reads", async () => {
    const { api, calls } = recorder();
    expect(await run(["| CRC-C2 | wip | lib/a.ts | — | — |"], api, ["--write"])).toBe(REFUSAL_EXIT);
    expect(calls).toEqual([]);
  });

  test("a milestone that does not exist refuses BEFORE creating anything", async () => {
    // The order matters: refusing after creating half the plan leaves a
    // tracker nobody planned and a command that reports failure.
    const { api, calls } = recorder({ milestones: [] });
    expect(await run([GOOD], api, ["--write"])).toBe(REFUSAL_EXIT);
    expect(calls).toEqual([]);
  });

  test("a creation that throws is reported and exits non-zero, never silently", async () => {
    const calls: string[] = [];
    const api: DecomposeGitHub = {
      openTitles: async () => new Map(),
      milestones: async () => new Set(["Phase 3"]),
      blockedBy: async () => [],
      create: async () => {
        throw new Error("rate limited");
      },
      addBlockedBy: async (_r, b, k) => {
        calls.push(`edge #${b} #${k}`);
      },
    };
    expect(await run([GOOD], api, ["--write"])).toBe(REFUSAL_EXIT);
    expect(calls).toEqual([]);
  });

  test("--repair and --decompose together are refused — two plans, one tracker", async () => {
    const { api } = recorder();
    expect(
      await planIssuesMain(
        ["--repair", "a.md", "--decompose", "b.md", "--repo", "o/r"],
        undefined as never,
        api,
      ),
    ).toBe(REFUSAL_EXIT);
  });
});
