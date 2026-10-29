/**
 * `lib/spec-placement.ts` — the placement table, and the milestones derived
 * from it (#1647).
 *
 * Every case here plants a whole document and runs it through the real
 * parser. None of them reimplements the id extraction or the cell split: a
 * control that reimplements the thing it controls proves `Array.filter`
 * works, and it goes green under exactly the mutations that matter
 * (`.claude/rules/checks-must-be-able-to-fail.md`, *two deciders that
 * agree*). That specific mistake was made in this file's sibling, caught by
 * a reviewer on #1647, and is the reason the helper below builds text.
 *
 * ## What was broken to prove each case can fail
 *
 * Each `*_violation` case is paired with a `*_clean` assertion over a
 * document differing in ONE row, so the red is attributable to that row and
 * not to the plant being malformed. The pairs are stated in each case's
 * name. Without the pair, a plant with a typo'd heading reports every
 * criterion unplaced and every case passes for the instrument's reason.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  NON_PHASE_PLACEMENTS,
  PLACEMENT_HEADING,
  milestoneBody,
  milestonePlan,
  parsePhaseHeadings,
  parsePlacementRows,
  placementReading,
  uncoveredByMilestone,
} from "../lib/spec-placement";
import { REFUSAL_EXIT, main as planSpecMain } from "../scripts/plan-spec";
import type { PlanSpecGitHub } from "../scripts/plan-spec";

const REPO = join(import.meta.dir, "..");

/** A whole spec document: criteria, phase headings, then a placement table. */
function plant(opts: {
  criteria?: string[];
  phases?: [number, string][];
  rows?: [string, string][];
  heading?: string;
}): string {
  const criteria = opts.criteria ?? ["CRC-A1", "CRC-A2", "CRC-A3"];
  const phases = opts.phases ?? [
    [1, "stop the repeats"],
    [2, "stop the false findings"],
  ];
  const rows = opts.rows ?? [
    ["**Phase 1**", "CRC-A1, CRC-A2"],
    ["**Phase 2**", "CRC-A3"],
  ];
  return [
    "---",
    "doc-type: spec",
    "---",
    "",
    "# Planted",
    "",
    ...criteria.map((id, i) => `- [ ] ${id}: criterion number ${i + 1}`),
    "",
    ...phases.flatMap(([n, t]) => [`### Phase ${n} — ${t}`, "", "Some prose.", ""]),
    opts.heading ?? `${PLACEMENT_HEADING} — every criterion has exactly one home`,
    "",
    "| Placement | Criteria | What the value means |",
    "|---|---|---|",
    ...rows.map(([p, ids]) => `| ${p} | ${ids} | because |`),
    "",
    "### Exit conditions",
    "",
    "Nothing here.",
  ].join("\n");
}

describe("lib/spec-placement: the table parses, and parses only the table", () => {
  test("rows come from the second cell, and prose outside the section is not a placement", () => {
    const rows = parsePlacementRows(plant({}));
    expect(rows.map(r => r.placement)).toEqual(["Phase 1", "Phase 2"]);
    expect(rows.flatMap(r => r.ids)).toEqual(["CRC-A1", "CRC-A2", "CRC-A3"]);
  });

  test("a heading at ### ends the section — a table AFTER it is not read", () => {
    const withTrailer = plant({}) + "\n| **Phase 9** | CRC-Z9 | a table in another section |\n";
    expect(parsePlacementRows(withTrailer).map(r => r.placement)).toEqual(["Phase 1", "Phase 2"]);
  });

  test("an absent section is UNMEASURED, not a clean reading", () => {
    const r = placementReading(plant({ heading: "### Something else entirely" }));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.unmeasuredReasons.join(" ")).toContain(PLACEMENT_HEADING);
    // The pair: the SAME document with the right heading is MEASURED. Without
    // this, the case above passes for any plant at all.
    expect(placementReading(plant({})).reading).toBe("MEASURED");
  });

  test("a section with no rows is UNMEASURED, and differs from a section with one", () => {
    expect(placementReading(plant({ rows: [] })).reading).toBe("UNMEASURED");
    expect(placementReading(plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2, CRC-A3"]] })).reading)
      .toBe("MEASURED");
  });

  test("a spec stating no criteria is UNMEASURED — nothing to place is not placed", () => {
    expect(placementReading(plant({ criteria: [], rows: [["**Phase 1**", "CRC-A1"]] })).reading)
      .toBe("UNMEASURED");
  });
});

describe("lib/spec-placement: what the reading refuses", () => {
  test("unplaced: dropping CRC-A3 from the table names it, and restoring it clears", () => {
    const bad = placementReading(plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] }));
    expect(bad.unplaced).toEqual(["CRC-A3"]);
    expect(placementReading(plant({})).unplaced).toEqual([]);
  });

  test("doubled: the same id in two rows names both placements", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Phase 2**", "CRC-A2, CRC-A3"]] }),
    );
    expect(bad.doubled).toEqual([{ id: "CRC-A2", placements: ["Phase 1", "Phase 2"] }]);
    expect(placementReading(plant({})).doubled).toEqual([]);
  });

  test("unknown: an id in the table the spec states nowhere", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Phase 2**", "CRC-A3, CRC-Z9"]] }),
    );
    expect(bad.unknown).toEqual(["CRC-Z9"]);
    expect(placementReading(plant({})).unknown).toEqual([]);
  });

  test("unrecognised: a placement value outside the closed set", () => {
    const bad = placementReading(
      plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], ["**Later maybe**", "CRC-A3"]] }),
    );
    expect(bad.unrecognised).toEqual(["Later maybe"]);
    // Every declared non-phase value is accepted, so the refusal above is
    // about THAT value and not about the set being empty.
    for (const v of NON_PHASE_PLACEMENTS) {
      const r = placementReading(
        plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"], [`**${v} — why**`, "CRC-A3"]] }),
      );
      expect(r.unrecognised, `${v} should be an accepted placement`).toEqual([]);
    }
  });
});

describe("lib/spec-placement: milestones are derived, and matched on the phase NUMBER", () => {
  const spec = plant({});

  test("phase headings parse with their titles", () => {
    expect(parsePhaseHeadings(spec).map(h => h.heading)).toEqual([
      "Phase 1 — stop the repeats",
      "Phase 2 — stop the false findings",
    ]);
  });

  test("no live milestones: every phase is a create, and only phases get one", () => {
    const withBlocked = plant({
      rows: [["**Phase 1**", "CRC-A1"], ["**Phase 2**", "CRC-A2"], ["**Done**", "CRC-A3"]],
    });
    const { actions } = milestonePlan(withBlocked, [], "Conv");
    expect(actions.map(a => `${a.action} ${a.title}`)).toEqual([
      "create Conv Phase 1 — stop the repeats",
      "create Conv Phase 2 — stop the false findings",
    ]);
  });

  /** The description `--write` would put on phase 1 of `spec`. */
  const PHASE_1_BODY = milestoneBody(["CRC-A1", "CRC-A2"]);

  test("an exactly-matching title AND description is unchanged — nothing is written", () => {
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop the repeats", description: PHASE_1_BODY }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("unchanged");
  });

  test("a DRIFTED title is a rename, never a second create — the live defect", () => {
    // Exactly what `Convergence Phase 0 — three settings` is against
    // `### Phase 0 — three settings, no engineering` on 2026-10-28: the live
    // milestone was typed from the heading and the heading moved. Matching on
    // the title would make this a create, and a duplicate milestone splits a
    // phase's issues into two lanes that each look complete.
    const existing = { number: 4, title: "Conv Phase 1 — stop repeats", description: PHASE_1_BODY };
    const { actions } = milestonePlan(spec, [existing], "Conv");
    const one = actions.find(a => a.phase === 1)!;
    expect(one.action).toBe("rename");
    expect(one.existing).toEqual(existing);
    expect(actions.filter(a => a.phase === 1)).toHaveLength(1);
  });

  // ── The description half, found by the AI review of PR #1647 ─────────────
  //
  // `action` was `existing.title === title ? "unchanged" : "rename"`, so a
  // phase whose criteria list moved while its heading text did not was never
  // rewritten. These three differ in ONE thing — the live description — and
  // the pairing is what makes the red attributable: restoring the title-only
  // comparison turns the first two green and leaves the third alone, which is
  // the mutation reported in the commit.

  test("the same title with a STALE criteria list is an update, not unchanged", () => {
    const { actions } = milestonePlan(
      spec,
      [
        {
          number: 4,
          title: "Conv Phase 1 — stop the repeats",
          description: milestoneBody(["CRC-A1"]), // the table now says A1 AND A2
        },
      ],
      "Conv",
    );
    const one = actions.find(a => a.phase === 1)!;
    expect(one.action).toBe("update");
    expect(one.title).toBe("Conv Phase 1 — stop the repeats");
  });

  test("a milestone with NO description at all is an update — null is not the derived body", () => {
    // `null` is what the API returns for a milestone created by hand, which
    // is how all eight live ones were made. An `unchanged` here would mean
    // the board never shows a phase's criteria until its heading changes.
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop the repeats", description: null }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("update");
  });

  test("a title that moved AND a description that moved is a rename, not an update", () => {
    // Both halves differ, so the two arms could each claim it. `rename` wins
    // because the human output prints `was: <old title>` and that line is the
    // one a reader needs; the description is rewritten either way.
    const { actions } = milestonePlan(
      spec,
      [{ number: 4, title: "Conv Phase 1 — stop repeats", description: null }],
      "Conv",
    );
    expect(actions.find(a => a.phase === 1)?.action).toBe("rename");
  });

  test("a milestone this spec does not derive is reported, never touched", () => {
    const outsider = { number: 10, title: "Conv Machinery", description: null };
    const { actions, unmanaged } = milestonePlan(spec, [outsider], "Conv");
    expect(unmanaged).toEqual([outsider]);
    expect(actions.every(a => a.action === "create")).toBe(true);
  });

  test("another spec's milestones are unmanaged, not renamed into this one's", () => {
    const { actions, unmanaged } = milestonePlan(
      spec,
      [{ number: 2, title: "Bootstrap Phase 1 — scan", description: null }],
      "Conv",
    );
    expect(unmanaged.map(m => m.number)).toEqual([2]);
    expect(actions.find(a => a.phase === 1)?.action).toBe("create");
  });
});

/**
 * `scripts/plan-spec.ts --write` — what reaches GitHub, and when it does not.
 *
 * **These assert on the CALLS, not on the exit code.** The defect they cover
 * is that the refusal was a non-zero return computed after the write loop had
 * already run: every milestone was created, and the command then exited 1. An
 * exit code cannot tell that apart from a refusal that stopped something, so a
 * case reading only `expect(code).toBe(REFUSAL_EXIT)` would have been green
 * against the bug — `.claude/rules/checks-must-be-able-to-fail.md`, *green on
 * the exit code, witnessing the wrong mechanism*. Found by the AI review of
 * PR #1647.
 *
 * Every case is paired with a control differing in ONE row of the planted
 * table, so the red is attributable to the placement problem and not to a
 * plant the parser could not read at all.
 */
describe("scripts/plan-spec --write: nothing reaches GitHub on an unsound table", () => {
  /** Records every call, and returns the shapes the command reads. */
  function spy(live: { number: number; title: string; description: string | null }[] = []) {
    const created: string[] = [];
    const renamed: string[] = [];
    const gh: PlanSpecGitHub = {
      createClient: (() => ({}) as any) as PlanSpecGitHub["createClient"],
      listMilestones: (async () => live) as unknown as PlanSpecGitHub["listMilestones"],
      listOpenIssues: (async () => ({
        issues: [],
        droppedRows: [],
      })) as unknown as PlanSpecGitHub["listOpenIssues"],
      createMilestone: (async (_c: unknown, _r: unknown, o: { title: string }) => {
        created.push(o.title);
        return { number: 900 + created.length };
      }) as unknown as PlanSpecGitHub["createMilestone"],
      renameMilestone: (async (_c: unknown, _r: unknown, n: number, o: { title: string }) => {
        renamed.push(`#${n} -> ${o.title}`);
      }) as unknown as PlanSpecGitHub["renameMilestone"],
    };
    return { gh, created, renamed };
  }

  /** Run the real `main` against a planted spec on disk. */
  async function run(
    content: string,
    extra: string[],
    live?: { number: number; title: string; description: string | null }[],
  ) {
    const dir = mkdtempSync(join(tmpdir(), "rg-plan-spec-"));
    try {
      writeFileSync(join(dir, "SPEC.md"), content);
      const s = spy(live);
      const code = await planSpecMain(
        ["SPEC.md", "--repo", "o/r", "--prefix", "Conv", "--project-root", dir, ...extra],
        s.gh,
      );
      return { code, created: s.created, renamed: s.renamed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** CRC-A3 is stated and placed nowhere — `reading.unplaced` names it. */
  const UNPLACED = plant({ rows: [["**Phase 1**", "CRC-A1, CRC-A2"]] });
  /** The same document with that one row restored. */
  const SOUND = plant({
    rows: [
      ["**Phase 1**", "CRC-A1, CRC-A2"],
      ["**Phase 2**", "CRC-A3"],
    ],
  });

  test("an unplaced criterion: --write creates NOTHING and refuses", async () => {
    const { code, created, renamed } = await run(UNPLACED, ["--write"]);
    expect(created, "a milestone was created despite the refusal").toEqual([]);
    expect(renamed).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("the control: the same table with CRC-A3 placed DOES write", async () => {
    // Without this the case above passes against a command that never writes
    // at all — a plant the parser rejects outright looks identical to a
    // refusal that worked.
    const { code, created } = await run(SOUND, ["--write"]);
    expect(created).toEqual([
      "Conv Phase 1 — stop the repeats",
      "Conv Phase 2 — stop the false findings",
    ]);
    expect(code).toBe(0);
  });

  test("a DOUBLED placement also writes nothing", async () => {
    const doubled = plant({
      rows: [
        ["**Phase 1**", "CRC-A1, CRC-A2"],
        ["**Phase 2**", "CRC-A2, CRC-A3"],
      ],
    });
    const { code, created } = await run(doubled, ["--write"]);
    expect(created).toEqual([]);
    expect(code).toBe(REFUSAL_EXIT);
  });

  test("--json --write writes too, and says which of the three states it was in", async () => {
    // It used to return before the write loop, so `--json --write` did
    // nothing and reported the same object as a run that had written eight.
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    let result;
    try {
      result = await run(SOUND, ["--write", "--json"]);
    } finally {
      console.log = log;
    }
    expect(result.created).toHaveLength(2);
    expect(JSON.parse(out.join("\n")).wrote).toBe("yes");
  });

  test("--json --write on an unsound table reports `refused`, and writes nothing", async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    let result;
    try {
      result = await run(UNPLACED, ["--write", "--json"]);
    } finally {
      console.log = log;
    }
    expect(result.created).toEqual([]);
    expect(result.code).toBe(REFUSAL_EXIT);
    expect(JSON.parse(out.join("\n")).wrote).toBe("refused");
  });

  test("a stale description on a sound table is written, and it is a rename call", async () => {
    const { code, created, renamed } = await run(SOUND, ["--write"], [
      { number: 4, title: "Conv Phase 1 — stop the repeats", description: null },
      { number: 5, title: "Conv Phase 2 — stop the false findings", description: milestoneBody(["CRC-A3"]) },
    ]);
    // Phase 1's body moved; phase 2's already matches and must not be touched.
    expect(renamed).toEqual(["#4 -> Conv Phase 1 — stop the repeats"]);
    expect(created).toEqual([]);
    expect(code).toBe(0);
  });
});

describe("lib/spec-placement: coverage is a NAME match, and the boundary is load-bearing", () => {
  const actions = milestonePlan(
    plant({ criteria: ["CRC-M1", "CRC-M15"], rows: [["**Phase 1**", "CRC-M1, CRC-M15"]] }),
    [],
    "Conv",
  ).actions;

  test("CRC-M1 is not named by an issue that only mentions CRC-M15", () => {
    const [m] = uncoveredByMilestone(actions, [{ number: 1, text: "fix CRC-M15 at last" }]);
    expect(m.covered).toEqual(["CRC-M15"]);
    expect(m.uncovered).toEqual(["CRC-M1"]);
  });

  test("the same id as a whole word IS named, so the case above is about the boundary", () => {
    const [m] = uncoveredByMilestone(actions, [{ number: 1, text: "fix CRC-M1 and CRC-M15" }]);
    expect(m.uncovered).toEqual([]);
  });

  test("no issues at all leaves everything uncovered", () => {
    const [m] = uncoveredByMilestone(actions, []);
    expect(m.uncovered).toEqual(["CRC-M1", "CRC-M15"]);
  });
});

describe("the live convergence spec, against this parser", () => {
  const spec = readFileSync(join(REPO, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md"), "utf-8");

  test("it reads MEASURED with every criterion placed exactly once", () => {
    const r = placementReading(spec);
    expect(r.reading, r.unmeasuredReasons.join("; ")).toBe("MEASURED");
    expect(r.unplaced).toEqual([]);
    expect(r.doubled).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.unrecognised).toEqual([]);
    // Anti-vacuity: the three assertions above are over a real population.
    expect(r.criteria.length).toBeGreaterThan(40);
    expect(r.rows.length).toBeGreaterThan(5);
  });

  test("every phase row has a heading to take its milestone name from", () => {
    const { actions } = milestonePlan(spec, [], "Convergence");
    expect(actions.length).toBeGreaterThan(5);
    for (const a of actions) {
      expect(a.title, `Phase ${a.phase} has no "### Phase ${a.phase} — …" heading to name a milestone from`)
        .not.toBe(`Convergence Phase ${a.phase}`);
    }
  });
});
