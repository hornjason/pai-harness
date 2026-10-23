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
