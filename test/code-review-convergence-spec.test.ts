/**
 * The citations in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` resolve.
 *
 * That spec is an alignment reference rather than a design: it reads an
 * external document and records, criterion by criterion, which mechanisms
 * this repo has already built and where they live. Its criteria are
 * deliberately unticked — the spec states a target, and nothing in it claims
 * coverage.
 *
 * So the usual spec checks have almost nothing to bite on here. `DRIFT-2`
 * asks that some test reference a testable spec; `ticked-sc-cover` and
 * `sc-binding-split` are satisfied vacuously while every box is `- [ ]`. The
 * one part of the document that can go wrong on its own, with no edit to the
 * spec at all, is the set of paths it points at. `evals/ai-review-control/`
 * is cited as the clean-PR control that already exists; `REVIEW.md` is cited
 * as shipped. Either can be moved or deleted by work in another subsystem,
 * and the spec would keep asserting them.
 *
 * That is the whole of what is asserted here, and it is asserted because it
 * is the only claim in the file that the tree can contradict. A test that
 * re-read the criteria and agreed with them would be reading the document to
 * confirm the document.
 *
 * ## What separates pass from fail
 *
 * Changing `evals/ai-review-control/` to `evals/ai-review-controls/` in the
 * spec reds the second case; so does deleting the directory. Measured on this
 * tree at the time of writing: four paths extracted, four resolved. The third
 * case plants the mis-citation rather than describing it, because a matcher
 * that had stopped matching would pass the second case with an empty list and
 * say nothing — which is why the first case asserts the extraction is not
 * empty before the second case reads it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SPEC = "specs/CODE-REVIEW-CONVERGENCE-SPEC.md";

/**
 * A backticked repo path: either something with a directory separator, or a
 * bare filename with a known source extension.
 *
 * Narrow on purpose. The spec backticks a good deal that is not a path —
 * `full`, `UNMEASURED`, `noiseRate`, `DROP_SIGNALS` — and crediting those as
 * missing files would make the check fire on prose.
 */
const CITED_PATH = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+|[A-Za-z0-9_-]+\.(?:ts|md|json|yml))`/g;

function citedPaths(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(CITED_PATH)) found.add(m[1]);
  return [...found].sort();
}

describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: its citations resolve", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;

  test("the spec is present and states criteria, so the readings below are not empty", () => {
    // The positive control. Every assertion in this file is a property of a
    // document, and a missing or emptied document satisfies all of them.
    expect(body, `${SPEC} is missing`).not.toBeNull();
    // The id prefix is not pinned here. Which namespace this spec's criteria
    // live in is a live decision — `SC-<letter><n>` is the per-spec
    // anti-criterion form (`isAntiCriterion`, lib/sc-ids.ts), which is not
    // what these are — and this case is a control on the parse, not a vote on
    // the outcome. The checkbox shape is what makes a line a criterion.
    const criteria = body!.match(/^- \[[ xX]\] [A-Z]+-[A-Z]?\d+:/gm) ?? [];
    expect(criteria.length, "the spec states no criteria, so there is nothing to keep aligned")
      .toBeGreaterThan(40);
    expect(citedPaths(body!).length, "the path extractor matched nothing in a spec that cites paths")
      .toBeGreaterThan(0);
  });

  test("every repo path the spec cites exists", () => {
    // A spec that says a mechanism shipped, naming a file that is not there,
    // is the drift this document exists to prevent — pointed the other way.
    const missing = citedPaths(body!).filter(p => !existsSync(join(REPO, p)));
    expect(
      missing,
      `${SPEC} cites ${missing.length} path(s) that do not exist. Either the artefact moved ` +
        `and the spec is stale, or the citation was wrong when it was written. Fix whichever ` +
        `it is — do not drop the citation.`,
    ).toEqual([]);
  });

  test("every criterion is accounted for in exactly one bucket", () => {
    // The audit section sorts all 56 criteria into five states, and the
    // difference between them is the whole point of it: "nobody can observe
    // this", "this would measure a constant here", "somebody has to decide",
    // "we decided against it" and "nobody has built it" are four different
    // things that an unticked checkbox renders identically.
    //
    // Asserted rather than stated. A document that sorts its own criteria
    // and then says "5 / 8 / 4 / 3 / 2 / 34" in prose is a document making a
    // claim nothing checks, which is the defect
    // `.claude/rules/checks-must-be-able-to-fail.md` names in *In practice*:
    // the sentence answers, in the right file, the question that would have
    // prompted a check. Ticking a criterion without moving it out of its
    // bucket now reds this.
    const declared = [...body!.matchAll(/^- \[([ xX])\] (CRC-[A-Z]?\d+):/gm)];
    expect(declared.length, "no criteria parsed, so the partition below is over nothing")
      .toBeGreaterThan(40);

    // MEMBERSHIP IS A DECLARING POSITION, not a mention — the first cell of a
    // row, or a bullet's leading bold. The same claim-vs-citation distinction
    // `.claude/rules/claiming-sc-coverage.md` draws, one level up, and it is
    // not theoretical here: a first draft of this case read every id in each
    // section and reported CRC-A6 as unobservable (it is cited in CRC-N3's
    // row) and CRC-C2 and CRC-B8 as blocked-on-owner (both cited in prose
    // there). Three false memberships from one loose matcher.
    const ID = /CRC-[A-Z]?\d+/g;
    const section = (heading: string): string => {
      const at = body!.indexOf(heading);
      expect(at, `the audit section "${heading}" is gone — rename it here too`)
        .toBeGreaterThan(-1);
      const ends = [body!.indexOf("\n### ", at + 1), body!.indexOf("\n## ", at + 1)]
        .filter(i => i > 0);
      return body!.slice(at, ends.length > 0 ? Math.min(...ends) : body!.length);
    };
    const firstCells = (s: string) =>
      s.split("\n")
        .filter(l => l.startsWith("| ") && !l.startsWith("|---"))
        .flatMap(l => [...(l.split("|")[1] ?? "").matchAll(ID)].map(m => m[0]));
    const leadingBold = (s: string) =>
      s.split("\n")
        .filter(l => l.startsWith("- **"))
        .flatMap(l => [...(/^- \*\*(.+?)\*\*/.exec(l)?.[1] ?? "").matchAll(ID)].map(m => m[0]));

    const buckets: Record<string, string[]> = {
      bound: declared.filter(m => m[1] !== " ").map(m => m[2]),
      unobservable: firstCells(section("### A mechanism exists; this repository cannot observe it")),
      "not meaningful": firstCells(section("### Cannot be meaningful in this deployment")),
      "blocked on an owner": firstCells(section("### Blocked on an owner decision")),
      // #1469. A sixth state, and NOT a shade of the one above it: blocked
      // means nobody has answered, contested means this repository answers
      // twice in opposite directions and both answers are current. The
      // distinction is what an agent does next — a blocked item waits, a
      // contested one must not be actioned from either document alone — and
      // the cost of not drawing it is on record: CRC-F1 was read out of the
      // Phase 0 list as a setting costing no engineering, applied, and
      // refused every session's push repo-wide through the pre-push hook.
      contested: firstCells(section("### Contested — this repository gives two opposite instructions")),
      "not adopted": firstCells(section("### Deliberately not adopted")),
      "not done": leadingBold(section("### Not done — the remainder")),
    };

    const placements = new Map(
      declared.map(m => [
        m[2],
        Object.entries(buckets).filter(([, ids]) => ids.includes(m[2])).map(([name]) => name),
      ]),
    );
    expect(
      [...placements].filter(([, w]) => w.length === 0).map(([id]) => id),
      "criteria in NO bucket: the audit does not account for them. Add each to one " +
        "of the six sections, or tick it.",
    ).toEqual([]);
    expect(
      [...placements].filter(([, w]) => w.length > 1).map(([id, w]) => `${id} in ${w.join(" and ")}`),
      "criteria in TWO buckets: the states are meant to be exclusive, so one of the " +
        "two placements is wrong. CRC-B8 is the one that looks like an exception and " +
        "is not — its deviations-table row says it is the defect rather than a " +
        "deviation, which is why that table is not a bucket.",
    ).toEqual([]);

    // Every bucket carries somebody, or a section silently emptied and the
    // two assertions above still hold over what is left.
    for (const [name, ids] of Object.entries(buckets)) {
      expect(ids.length, `the "${name}" bucket is empty — did its section lose its rows?`)
        .toBeGreaterThan(0);
    }
  });

  test("the stated counts are the measured ones", () => {
    // The prose says the split in words. A reader acts on that sentence and
    // not on the sections below it, so it is the thing most worth holding to
    // the tree — and the cheapest way for this whole audit to go quietly
    // wrong is for someone to move a criterion and leave the summary.
    const stated = /\*\*(\d+) bound\*\*/.exec(body!);
    expect(stated, "the summary sentence no longer states a bound count").not.toBeNull();
    const ticked = (body!.match(/^- \[[xX]\] CRC-/gm) ?? []).length;
    expect(
      Number(stated![1]),
      `the summary says ${stated![1]} bound and ${ticked} boxes are ticked`,
    ).toBe(ticked);
  });

  test("a mis-cited path is caught, so the case above is not green by construction", () => {
    // Driven over a planted body. The real spec cannot be made to mis-cite on
    // demand, and a case that cannot be staged is a case that never runs.
    const planted = "see `evals/ai-review-controls/` and `REVIEW.md` for the control";
    const found = citedPaths(planted);
    expect(found, "the extractor read the planted body differently than intended")
      .toEqual(["REVIEW.md", "evals/ai-review-controls/"]);
    expect(found.filter(p => !existsSync(join(REPO, p)))).toEqual(["evals/ai-review-controls/"]);
  });
});
