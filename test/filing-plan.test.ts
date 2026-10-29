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

  test("a second table touching the first does not inherit its column index", () => {
    // No blank line between them. `column` used to stay set from the table
    // above, so the second table's own HEADER row was read as a data row —
    // authorising the literal string `Files`, and then every path under it.
    const touching = [
      "| Criterion | Outcome |",
      "|---|---|",
      "| C1 | fix bug X |",
      "| Criterion | Files |",
      "|---|---|",
      "| C1 | lib/x.ts |",
    ].join("\n");
    expect(plannedTitles(touching).map(t => t.title)).toEqual(["fix bug X"]);
  });

  test("a second touching table that DOES have an Outcome column is read", () => {
    // The control. Without it the row above passes against a parser that
    // stops at the first table, and "ignored the second table" would be
    // indistinguishable from "read it correctly".
    const touching = [
      "| Criterion | Files |",
      "|---|---|",
      "| C1 | lib/x.ts |",
      "| Criterion | Outcome |",
      "|---|---|",
      "| C1 | the second table's title |",
    ].join("\n");
    expect(plannedTitles(touching).map(t => t.title)).toEqual(["the second table's title"]);
  });

  test("a pipe table with no delimiter row is not a table, and authorises nothing", () => {
    // GFM renders this as a paragraph, so a reviewer never sees a table.
    const noDelimiter = ["| Criterion | Outcome |", "| C1 | not a table at all |"].join("\n");
    expect(plannedTitles(noDelimiter)).toEqual([]);
  });

  test("an empty Outcome cell is not a title", () => {
    const blank = ["| Criterion | Outcome |", "|---|---|", "| CRC-C2 |  |"].join("\n");
    expect(plannedTitles(blank)).toEqual([]);
  });

  /**
   * A fence or a comment is an EXAMPLE, and an example must not authorise.
   *
   * Every case here pairs the inert region with a live table after it, in one
   * fixture. Without that second half each one passes against a function that
   * returns `[]` for the whole file — "the fence swallowed everything" and
   * "the fence was skipped" are the same reading when nothing follows it.
   */
  const inert: { why: string; lines: string[] }[] = [
    {
      why: "a table inside a ``` fence",
      lines: ["```markdown", "| Criterion | Outcome |", "|---|---|", "| X-1 | an example |", "```"],
    },
    {
      why: "a table inside a ~~~ fence, which a ``` line does not close",
      lines: ["~~~", "| Criterion | Outcome |", "|---|---|", "| X-1 | an example |", "```", "~~~"],
    },
    {
      why: "a table inside a four-backtick fence, which a three-backtick line does not close",
      lines: [
        "````",
        "```",
        "| Criterion | Outcome |",
        "|---|---|",
        "| X-1 | an example |",
        "```",
        "````",
      ],
    },
    {
      why: "a table inside a multi-line HTML comment — a superseded plan kept for reference",
      lines: ["<!-- superseded", "| Criterion | Outcome |", "|---|---|", "| X-1 | an example |", "-->"],
    },
    {
      // CommonMark: a CLOSING fence may not carry an info string. A renderer
      // keeps the block open here and shows all of it as code; a parser that
      // accepts ```js as a closer reads the rest as plan.
      why: "a fence whose apparent closer carries an info string, so it never closed",
      lines: [
        "```markdown",
        "```javascript",
        "| Criterion | Outcome |",
        "|---|---|",
        "| X-1 | an example |",
        "```",
      ],
    },
    {
      why: "a table indented four spaces, which is a code block",
      lines: ["    | Criterion | Outcome |", "    |---|---|", "    | X-1 | an example |"],
    },
    {
      // `includes` cannot see ORDER: this line both closes and re-opens.
      why: "a comment that closes and opens again on the same line",
      lines: [
        "<!-- first",
        "--> prose between them <!-- second",
        "| Criterion | Outcome |",
        "|---|---|",
        "| X-1 | an example |",
        "-->",
      ],
    },
  ];

  for (const row of inert) {
    test(`${row.why} authorises nothing, and the live table after it still does`, () => {
      const content = [
        ...row.lines,
        "",
        "| Criterion | Outcome |",
        "|---|---|",
        "| CRC-C2 | the real one |",
      ].join("\n");
      expect(plannedTitles(content).map(t => t.title)).toEqual(["the real one"]);
    });
  }

  test("an unclosed fence swallows the rest of the file — the fail-closed direction", () => {
    const content = ["```", "| Criterion | Outcome |", "|---|---|", "| X-1 | never closed |"].join(
      "\n",
    );
    expect(plannedTitles(content)).toEqual([]);
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
    {
      why: "the plan's only Outcome table is an EXAMPLE inside a code fence",
      title: "a title shown in an example",
      source: sourceOf({
        [`${PLAN_DIR}/ADR-009-plan.md`]: [
          "# How to write one of these",
          "",
          "```markdown",
          "| Criterion | Outcome |",
          "|---|---|",
          "| CRC-C2 | a title shown in an example |",
          "```",
          "",
        ].join("\n"),
      }),
      reason: /no plan on the merged ref names/,
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

  test("a projectRoot BELOW the top level still finds the plans", () => {
    // The gate's `projectRoot` is a session's cwd and need not be the
    // checkout root — `runIdFor` says `/wt/x` and `/wt/x/lib` are one run.
    // With a bare pathspec `ls-tree` resolves `docs/adr/` against the `-C`
    // directory, finds nothing, and exits 0, so the exemption is denied for
    // every filing in every session one directory down and the reason reads
    // as though the repository had no plans. Both tests above create `root`
    // AS the repository, so neither could see it. Found by the AI review.
    const root = mkdtempSync(join(tmpdir(), "rg-filing-plan-sub-"));
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
      const below = join(root, "lib", "nested");
      mkdirSync(below, { recursive: true });
      writeFileSync(join(below, "keep.ts"), "export const x = 1;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "the reviewed plan, and a subdirectory to run from");
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      // The control first: from the top level it has always worked, so a
      // red below is about the subdirectory and not about the fixture.
      expect(
        plannedFiling("plan-deps refuses a single-phase reading", gitSource(root)).planned,
        "the control: the same plan is found from the top level",
      ).toBe(true);

      const r = plannedFiling("plan-deps refuses a single-phase reading", gitSource(below));
      expect(
        r.planned,
        "a session two directories down saw no plans — the pathspec is cwd-relative",
      ).toBe(true);
      if (r.planned) {
        expect(
          r.plan,
          "and the path is root-relative, or `show` would be handed `<ref>:../../docs/...`",
        ).toBe(`${PLAN_DIR}/ADR-009-plan.md`);
      }
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
