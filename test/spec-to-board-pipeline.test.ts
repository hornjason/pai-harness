/**
 * SPEC-TO-BOARD-PIPELINE-SPEC.md — the pipeline reads its own spec.
 *
 * This file exists for a narrower reason than "the new spec needs a test".
 * The spec's argument is that the machinery which makes every issue name a
 * criterion was itself governed by none, and the first thing that claim
 * implies is checkable: the pipeline's own steps must be able to READ this
 * document. A spec the tools cannot parse states its criteria to nobody, and
 * that failure is silent — `plan-spec` would make no milestones and report
 * exactly what it reports for a spec with no work left.
 *
 * So every case below runs a real pipeline step against the real file, and
 * each is paired with a control that would also go green if the step had
 * simply found nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PHASE_VALUE, parsePhaseHeadings, parsePlacementRows } from "../lib/spec-placement";
import { parseCriteria } from "../lib/spec-evidence";

const ROOT = join(import.meta.dir, "..");
const PATH = "specs/SPEC-TO-BOARD-PIPELINE-SPEC.md";
const SPEC = readFileSync(join(ROOT, PATH), "utf-8");

/** The spec this suite is about, named where a scanner can see the claim. */
describe("SPEC-TO-BOARD-PIPELINE-SPEC.md is readable by the pipeline it governs", () => {
  test("it states criteria, and they are the ones the placement table places", () => {
    const stated = parseCriteria(SPEC).map(c => c.id);
    expect(stated.length, "the spec states no criteria, so it governs nothing").toBeGreaterThan(0);

    const placed = parsePlacementRows(SPEC).flatMap(r => r.ids);
    // Both directions. A criterion in no phase is unreadable as anything —
    // *nobody has reached it*, *it cannot start* and *it is finished* all
    // render as absence — and a phase naming an id the spec does not state
    // is a milestone pointing at nothing.
    expect(stated.filter(id => !placed.includes(id)), "criteria in no phase").toEqual([]);
    expect(placed.filter(id => !stated.includes(id)), "phases naming unstated ids").toEqual([]);
  });

  test("every placement value is one plan-spec can turn into a milestone", () => {
    const rows = parsePlacementRows(SPEC);
    expect(rows.length, "no placement table was found at all").toBeGreaterThan(0);
    // The control the row above needs: an unparsed table and a table of
    // values `PHASE_VALUE` rejects both yield zero milestones, and only one
    // of them is a spec somebody has to fix.
    const unusable = rows.map(r => r.placement).filter(p => !PHASE_VALUE.test(p));
    expect(
      unusable,
      "a placement cell plan-spec cannot read — it must be exactly `Phase N`, with the " +
        "title carried by the `### Phase N — …` heading instead",
    ).toEqual([]);
  });

  test("every phase placed has a heading, and every heading is placed", () => {
    const headings = new Set(parsePhaseHeadings(SPEC).map(h => h.number));
    const placed = new Set(
      parsePlacementRows(SPEC)
        .map(r => PHASE_VALUE.exec(r.placement)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    );
    expect(placed.size, "nothing was placed, so this agrees vacuously").toBeGreaterThan(0);
    expect([...placed].filter(n => !headings.has(n)), "phases with no heading").toEqual([]);
    expect([...headings].filter(n => !placed.has(n)), "headings placing nothing").toEqual([]);
  });

  test("the ids it consumes are inside the block reserved for them", () => {
    // `.claude/rules/parallel-sessions.md`: every path that consumes an id is
    // an allocation, including hand-written ones. A collision is only visible
    // in the union of two branches, so neither PR's CI can see it.
    const store = JSON.parse(readFileSync(join(ROOT, "specs/sc-reservations.json"), "utf-8")) as {
      reservations: { owner: string; from: number; to: number; namespace?: string }[];
    };
    const mine = store.reservations.filter(
      r => r.owner === "rg/pipeline-spec" && (r.namespace ?? "SC") === "SC",
    );
    expect(mine.length, "no reservation was declared for this spec's ids").toBe(1);

    // An id this check cannot parse must FAIL it, never be filtered out of
    // the population. `.filter(Number.isInteger)` dropped anything that was
    // not exactly `SC-<digits>`, and the only guard was that SOME id parsed
    // — so a single differently-shaped criterion sitting outside the
    // reserved block would have been skipped silently while the check went
    // green. "Assertions that hold vacuously", in
    // `.claude/rules/checks-must-be-able-to-fail.md`. Found by the AI review
    // of this change.
    const ids = parseCriteria(SPEC).map(c => c.id);
    expect(ids.length, "no criteria were read, so the range check is vacuous").toBeGreaterThan(0);
    expect(
      ids.filter(id => !/^SC-\d+$/.test(id)),
      "an id this check cannot parse would be dropped from the range test below rather " +
        "than examined by it, so a criterion outside the reservation could pass unseen",
    ).toEqual([]);
    const used = ids.map(id => Number(/^SC-(\d+)$/.exec(id)![1]));
    expect(
      used.filter(n => n < mine[0].from || n > mine[0].to),
      `ids outside the reserved ${mine[0].from}..${mine[0].to}`,
    ).toEqual([]);
  });

  test("it is listed in the spec routing table", () => {
    // HYGIENE-4 enforces this across all specs; asserting it here means the
    // failure names THIS file rather than arriving as a bare empty-array
    // mismatch in the conformity suite.
    const routing = readFileSync(join(ROOT, ".claude/rules/specs-routing.md"), "utf-8");
    expect(routing).toContain("SPEC-TO-BOARD-PIPELINE-SPEC.md");
  });
});
