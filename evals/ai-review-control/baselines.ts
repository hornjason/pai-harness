/**
 * ai-review-control/baselines.ts — frozen outcome readings, loaded back as
 * `FindingOutcomeSummary` so a comparison does not have to re-derive one
 * (#1278).
 *
 * ## Why a baseline is stored at all
 *
 * Most of what `outcomes-run.ts` reads is append-only and could be rebuilt
 * later: git history does not change, and an issue's `created_at` is fixed.
 * One part is not. The script reads each issue's **current** `state`, so a
 * finding that is OPEN today and closed next week reads differently in a run
 * taken next week — and the 30 OPEN rows in the pre-arbiter reading are
 * exactly the rows whose fate is undecided. Re-deriving the reading as of a
 * past date is possible with a `closed_at` filter nobody has written; a
 * stored artefact is the cheaper honest answer, and it removes the question.
 *
 * ## What a baseline is NOT
 *
 * **It is not a drop-in `before` arm for a temporal comparison, and nothing
 * here will pretend otherwise.** `compareReviewOutcomes` refuses unequal
 * populations by design — a smaller sweep is not an improvement — and a
 * tracker run taken after a filing-path change is a different population. So
 * `compareReviewOutcomes(loadBaseline("pre-arbiter"), aLaterFullRun)` returns
 * UNMEASURED, correctly, every time.
 *
 * That refusal is the feature. A mechanism whose whole job is to file less
 * makes "fewer findings" structurally tempting to read as success, and the
 * one comparison this module will not perform is the one that rewards it.
 *
 * The comparison that genuinely prices such a mechanism is the same-population
 * one: score the adjudicated batch twice, once with nothing suppressed and
 * once with the withholding applied, so the arms differ only in `suppressed`
 * and the population cannot shrink. A withheld candidate stays in the corpus.
 */
import { readFileSync } from "fs";
import { join } from "path";

import type { FindingOutcomeSummary } from "./outcomes";
import type { VarianceCapture } from "./variance-capture";

/** Non-zero for every refusal, through one constant. */
export const BASELINE_REFUSED = "baseline refused";

export interface OutcomeBaseline {
  name: string;
  /** The 40-character commit the reading was taken at. */
  pinnedCommit: string;
  measuredAt: string;
  repo: string;
  command: string;
  plantsAgreed: number;
  plantsTotal: number;
  why: string;
  comparableWith: string;
  summary: FindingOutcomeSummary;
}

/**
 * Load a stored reading.
 *
 * Refuses rather than returning a partial baseline. A number whose provenance
 * is missing is a number nobody can date, and the failure mode this guards is
 * a truncated or hand-edited artefact reading as a measurement: `0`, `{}` and
 * a half-written file are all indistinguishable from success, so each of the
 * provenance fields is required by name.
 *
 * The plants matter most of the three checks. A reading whose known-positives
 * disagreed was never a reading, and freezing one would preserve a blind
 * detector's output as ground truth for everything measured against it after.
 */
export function loadBaseline(name: string, dir?: string): OutcomeBaseline {
  const path = join(dir ?? join(import.meta.dir, "baselines"), `${name}.json`);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<OutcomeBaseline>;

  for (const field of ["name", "pinnedCommit", "measuredAt", "repo", "why", "comparableWith"] as const) {
    const v = raw[field];
    if (typeof v !== "string" || v === "") {
      throw new Error(`${BASELINE_REFUSED}: ${path} has no \`${field}\`. A stored reading without its provenance is a number nobody can date.`);
    }
  }

  // A short SHA and a wrong-length string are indistinguishable to a reader,
  // and `gh run list --commit` silently returns nothing for the former.
  if (!/^[0-9a-f]{40}$/.test(raw.pinnedCommit!)) {
    throw new Error(`${BASELINE_REFUSED}: ${path} pins \`${raw.pinnedCommit}\`, which is not a 40-character SHA.`);
  }

  if (raw.summary === undefined || raw.summary.usable !== true) {
    throw new Error(`${BASELINE_REFUSED}: ${path} stores a summary that is not usable, so it was never a reading.`);
  }

  if (raw.plantsAgreed !== raw.plantsTotal || (raw.plantsTotal ?? 0) === 0) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} records ${raw.plantsAgreed} of ${raw.plantsTotal} plants agreeing. ` +
        "A sweep that cannot see its own known-positives is not distinguishable from a blind one, and " +
        "freezing its output would make a blind detector the ground truth for everything compared to it.",
    );
  }

  return raw as OutcomeBaseline;
}

/**
 * Load a stored variance capture.
 *
 * A separate loader rather than a widened `loadBaseline`, because the two
 * artefacts answer different questions and sharing a reader is how one comes
 * to be interpreted as the other. The refusals are the same discipline with
 * one addition that `pre-arbiter.json` does not need: **the commit must not
 * have moved during the run.** A capture whose M runs straddle two versions
 * of `adjudicateFiling` measures a mixture, and a mixture that happens to be
 * self-consistent is indistinguishable from a stable reading.
 */
export function loadVarianceCapture(name: string, dir?: string): VarianceCapture {
  const path = join(dir ?? join(import.meta.dir, "baselines"), `${name}.json`);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<VarianceCapture>;

  for (const field of ["name", "pinnedCommit", "commitAtEnd", "measuredAt", "repo", "caveat"] as const) {
    const v = raw[field];
    if (typeof v !== "string" || v === "") {
      throw new Error(`${BASELINE_REFUSED}: ${path} has no \`${field}\`. A stored reading without its provenance is a number nobody can date.`);
    }
  }

  for (const field of ["pinnedCommit", "commitAtEnd", "originMain"] as const) {
    if (!/^[0-9a-f]{40}$/.test(raw[field]!)) {
      throw new Error(`${BASELINE_REFUSED}: ${path} records \`${field}\` as \`${raw[field]}\`, which is not a 40-character SHA.`);
    }
  }

  if (raw.pinnedCommit !== raw.commitAtEnd) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} started at ${raw.pinnedCommit} and ended at ${raw.commitAtEnd}. The runs ` +
        "straddle two adjudicators, so the artefact measures a mixture — and a self-consistent mixture reads " +
        "exactly like a stable one. Re-take it.",
    );
  }

  // #1320. The `lib/` TREE, not the commit: comparing commits would refuse
  // every capture taken on a branch, including the branch that updates this
  // artefact. The only question is whether the adjudicator's code was the
  // deployed code, and a tree object answers exactly that.
  if (typeof raw.libTree !== "string" || raw.libTree === "") {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} has no \`libTree\`, so nothing records which adjudicator code ran.`,
    );
  }
  if (raw.libTree !== raw.originMainLibTree) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} ran with lib/ at ${raw.libTree} while origin/main's was ` +
        `${raw.originMainLibTree}, so it describes an adjudicator that was not the deployed one.`,
    );
  }

  if (!Array.isArray(raw.dirtyPaths)) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} records no \`dirtyPaths\`. An absent reading is not a clean tree — the two ` +
        "are the distinction this field exists to make.",
    );
  }

  if (raw.dirtyPaths.length > 0) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} was taken with ${raw.dirtyPaths.length} uncommitted path(s) under \`lib/\`, so ` +
        `no commit describes the code that ran: ${raw.dirtyPaths.slice(0, 5).join(", ")}.`,
    );
  }

  if (raw.usable !== true) {
    throw new Error(`${BASELINE_REFUSED}: ${path} is marked unusable: ${raw.caveat}`);
  }

  if (raw.plantsAgreed !== raw.plantsTotal || (raw.plantsTotal ?? 0) === 0) {
    throw new Error(
      `${BASELINE_REFUSED}: ${path} records ${raw.plantsAgreed} of ${raw.plantsTotal} plants agreeing. A capture ` +
        "whose known-positives did not land cannot tell a stable adjudicator from an inert one.",
    );
  }

  return raw as VarianceCapture;
}
