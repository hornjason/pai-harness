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
import { readFileSync } from "fs";
import { join } from "path";
import {
  NON_PHASE_PLACEMENTS,
  PLACEMENT_HEADING,
  milestonePlan,
  parsePhaseHeadings,
  parsePlacementRows,
  placementReading,
  uncoveredByMilestone,
} from "../lib/spec-placement";

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

  test("an exactly-matching title is unchanged, and nothing is written for it", () => {
    const { actions } = milestonePlan(spec, [{ number: 4, title: "Conv Phase 1 — stop the repeats" }], "Conv");
    expect(actions.find(a => a.phase === 1)?.action).toBe("unchanged");
  });

  test("a DRIFTED title is a rename, never a second create — the live defect", () => {
    // Exactly what `Convergence Phase 0 — three settings` is against
    // `### Phase 0 — three settings, no engineering` on 2026-10-28: the live
    // milestone was typed from the heading and the heading moved. Matching on
    // the title would make this a create, and a duplicate milestone splits a
    // phase's issues into two lanes that each look complete.
    const { actions } = milestonePlan(spec, [{ number: 4, title: "Conv Phase 1 — stop repeats" }], "Conv");
    const one = actions.find(a => a.phase === 1)!;
    expect(one.action).toBe("rename");
    expect(one.existing).toEqual({ number: 4, title: "Conv Phase 1 — stop repeats" });
    expect(actions.filter(a => a.phase === 1)).toHaveLength(1);
  });

  test("a milestone this spec does not derive is reported, never touched", () => {
    const { actions, unmanaged } = milestonePlan(spec, [{ number: 10, title: "Conv Machinery" }], "Conv");
    expect(unmanaged).toEqual([{ number: 10, title: "Conv Machinery" }]);
    expect(actions.every(a => a.action === "create")).toBe(true);
  });

  test("another spec's milestones are unmanaged, not renamed into this one's", () => {
    const { actions, unmanaged } = milestonePlan(spec, [{ number: 2, title: "Bootstrap Phase 1 — scan" }], "Conv");
    expect(unmanaged.map(m => m.number)).toEqual([2]);
    expect(actions.find(a => a.phase === 1)?.action).toBe("create");
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
