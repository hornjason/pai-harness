/**
 * The cap's second route: a filing named by a plan merged on `origin/main`.
 *
 * Every negative case below is a way the exemption could be beaten, and each
 * one is run twice — against the real `plannedFiling` and against a mutant
 * whose answer is hardcoded to `planned: true`. The second half is the point:
 * a case asserting `planned === false` passes just as well when the function
 * is never reached, so without the mutant none of these rows can tell a
 * working guard from an absent one
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  PLAN_DIR,
  TITLE_COLUMN,
  gitSource,
  plannedFiling,
  plannedTitles,
  type PlanSource,
} from "../lib/filing-plan";

/** A plan with one authorised title, in the shape a decomposition plan has. */
const PLAN = [
  "# A plan somebody reviewed",
  "",
  "| Criterion | Outcome | Files |",
  "|---|---|---|",
  "| CRC-C2 | plan-deps refuses a single-phase reading | lib/spec-deps.ts |",
  "| CRC-C3 | `board-mirror reads every spec` | lib/board-mirror.ts |",
  "",
].join("\n");

function sourceOf(files: Record<string, string | null>, listable = true): PlanSource {
  return {
    list: () => (listable ? Object.keys(files) : null),
    show: p => files[p] ?? null,
  };
}

const ONE_PLAN = sourceOf({ [`${PLAN_DIR}/ADR-009-plan.md`]: PLAN });

describe("plannedTitles reads the Outcome column and nothing else", () => {
  test("every non-empty cell under the Outcome header is a title", () => {
    expect(plannedTitles(PLAN).map(t => t.title)).toEqual([
      "plan-deps refuses a single-phase reading",
      "board-mirror reads every spec",
    ]);
  });

  test("a column that is not headed Outcome yields nothing", () => {
    const other = ["| Criterion | Summary |", "|---|---|", "| CRC-C2 | something |"].join("\n");
    expect(plannedTitles(other)).toEqual([]);
  });

  test("a second table does not inherit the first table's column index", () => {
    // Without the reset on a non-table line, `wrong` sits at index 1 — the
    // Outcome index of the table above — and is read as an authorised title.
    const two = [
      "| Criterion | Outcome |",
      "|---|---|",
      "| CRC-C2 | right |",
      "",
      "prose between them",
      "",
      "| Criterion | Summary |",
      "|---|---|",
      "| CRC-C3 | wrong |",
    ].join("\n");
    expect(plannedTitles(two).map(t => t.title)).toEqual(["right"]);
  });

  test("an empty Outcome cell is not a title", () => {
    const blank = ["| Criterion | Outcome |", "|---|---|", "| CRC-C2 |  |"].join("\n");
    expect(plannedTitles(blank)).toEqual([]);
  });
});

/**
 * The mutant: the exemption always granted.
 *
 * Every row below predicts `planned: false` against the real function and
 * `true` against this, so a row that stops exercising the guard stops
 * agreeing with its own prediction.
 */
const alwaysPlanned = (_title: string, _source: PlanSource) =>
  ({ planned: true, plan: "MUTANT", line: 0 }) as const;

describe("plannedFiling: every route to NOT exempt, against a mutant that always exempts", () => {
  const rows: { why: string; title: string; source: PlanSource; reason: RegExp }[] = [
    {
      why: "a title no plan names",
      title: "something nobody planned",
      source: ONE_PLAN,
      reason: /no plan on the merged ref names/,
    },
    {
      why: "a SUPERSTRING of a planned title — substring matching is the `follow-up` bypass",
      title: "plan-deps refuses a single-phase reading, and also deletes main",
      source: ONE_PLAN,
      reason: /no plan on the merged ref names/,
    },
    {
      why: "a SUBSTRING of a planned title",
      title: "plan-deps refuses",
      source: ONE_PLAN,
      reason: /no plan on the merged ref names/,
    },
    {
      why: "the plans could not be listed — an unreadable plan denies, never grants",
      title: "plan-deps refuses a single-phase reading",
      source: sourceOf({ [`${PLAN_DIR}/ADR-009-plan.md`]: PLAN }, false),
      reason: /could not be listed/,
    },
    {
      why: "there are no plans at all on the ref",
      title: "plan-deps refuses a single-phase reading",
      source: sourceOf({}),
      reason: /no plan files under/,
    },
    {
      why: "the only plan file is unreadable",
      title: "plan-deps refuses a single-phase reading",
      source: sourceOf({ [`${PLAN_DIR}/ADR-009-plan.md`]: null }),
      reason: /no plan on the merged ref names/,
    },
    {
      why: "an empty title, which would otherwise match an empty cell",
      title: "   ",
      source: ONE_PLAN,
      reason: /no title/,
    },
  ];

  for (const row of rows) {
    test(row.why, () => {
      const real = plannedFiling(row.title, row.source);
      expect(real.planned, `the real reading exempted: ${row.why}`).toBe(false);
      if (real.planned === false) expect(real.why).toMatch(row.reason);
      expect(
        alwaysPlanned(row.title, row.source).planned,
        `the mutant did not exempt, so this row witnessed nothing: ${row.why}`,
      ).toBe(true);
    });
  }

  // The negative control. Without it every row above is satisfied by a
  // function that returns `planned: false` unconditionally.
  test("a title a plan DOES name is exempt — the control the rows above need", () => {
    const r = plannedFiling("plan-deps refuses a single-phase reading", ONE_PLAN);
    expect(r.planned).toBe(true);
    if (r.planned) expect(r.plan).toBe(`${PLAN_DIR}/ADR-009-plan.md`);
  });

  test("a backticked cell matches the plain title — the decoration is not part of it", () => {
    expect(plannedFiling("board-mirror reads every spec", ONE_PLAN).planned).toBe(true);
  });

  test("any plan on the ref may name it, not only the first", () => {
    const two = sourceOf({
      [`${PLAN_DIR}/ADR-008-other.md`]: "# nothing here\n",
      [`${PLAN_DIR}/ADR-009-plan.md`]: PLAN,
    });
    expect(plannedFiling("plan-deps refuses a single-phase reading", two).planned).toBe(true);
  });
});

describe("gitSource reads the merged ref, not the working tree", () => {
  test("a plan committed on the ref is seen; the same plan uncommitted is not", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-filing-plan-"));
    try {
      const git = (...args: string[]) => {
        const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
      };
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      mkdirSync(join(root, PLAN_DIR), { recursive: true });
      writeFileSync(join(root, PLAN_DIR, "ADR-009-plan.md"), PLAN);
      git("add", "-A");
      git("commit", "-q", "-m", "the reviewed plan");

      // `origin/main` is the ref the gate reads, so make one that exists.
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      const committed = plannedFiling(
        "plan-deps refuses a single-phase reading",
        gitSource(root),
      );
      expect(committed.planned, "a committed plan was not seen").toBe(true);

      // The uncommitted half. This is the property the whole module turns on:
      // an agent that writes a plan file beside its filing has not had it
      // reviewed, and the working tree cannot tell the two apart.
      writeFileSync(
        join(root, PLAN_DIR, "ADR-010-unreviewed.md"),
        ["| Criterion | Outcome |", "|---|---|", "| X-1 | a title nobody reviewed |"].join("\n"),
      );
      const uncommitted = plannedFiling("a title nobody reviewed", gitSource(root));
      expect(
        uncommitted.planned,
        "an UNCOMMITTED plan file granted the exemption — the read is hitting the working tree",
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a root that is not a repository denies rather than throws", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-filing-plan-norepo-"));
    try {
      const r = plannedFiling("anything at all", gitSource(root));
      expect(r.planned).toBe(false);
      if (r.planned === false) expect(r.why).toMatch(/could not be listed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the column name the plan contract depends on is stated once", () => {
  expect(TITLE_COLUMN).toBe("Outcome");
  expect(PLAN).toContain(`| ${TITLE_COLUMN} |`);
});
