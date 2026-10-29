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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
      reason: /cells, need 5/,
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

  test("the thresholds the refusals quote are the ones the module exports", () => {
    expect(MAX_FILES).toBe(9);
    expect(MIN_OUTCOME).toBe(12);
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
  function recorder(seed: { open?: [string, number][]; milestones?: string[] } = {}) {
    const calls: string[] = [];
    let next = 2000;
    const api: DecomposeGitHub = {
      openTitles: async () => new Map(seed.open ?? []),
      milestones: async () => new Set(seed.milestones ?? []),
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
      "edge #2000 blocked by #1700",
    ]);
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
