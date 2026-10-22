/**
 * ai-review-control/outcomes.ts — what happened to the findings the reviewer
 * wrote, and the comparison a filter has to pass before it may claim it helped
 * (#1225).
 *
 * ## The gap this closes
 *
 * `control.ts` next door answers "did the reviewer find a bug that is known to
 * be there". That is recall, and recall alone cannot grade a filter. Anthropic
 * say so in the post this is taken from:
 *
 * > We measure noise by watching what people do with the comments. It's easy
 * > to catch more bugs if you don't mind flagging a lot of non-bugs, so we
 * > need a check on that. We sort every comment the reviewer leaves by how the
 * > person on the PR responded: they fixed it, said it was wrong, said the
 * > behavior was intentional, or decided it didn't matter.
 *
 * Two filters are being built against this blind spot right now — the round
 * cap, diff-only re-review and no-repeats work on #1168, and the verifier
 * quorum and category filter on PR #1206 (#1187). Both will reduce the number
 * of findings. Nothing in the tree can currently tell either of them apart
 * from a filter that suppressed true findings, because the only number we
 * watch is how many findings there were.
 *
 * ## Three of the four categories are verbal, and this repo records none
 *
 * "Said it was wrong", "said the behavior was intentional" and "decided it
 * didn't matter" are all things a responder *says*. Anthropic can sort by them
 * because every finding there has to be answered — "you either fix it or
 * resolve the thread with a reason" — so the reason exists as data.
 *
 * Here it does not. Measured over the whole tracker on 2026-10-22: 195 of 566
 * closed findings carry zero comments, and the closing comments that do exist
 * cluster into no parseable convention. So a classifier over that prose would
 * be inventing three of the four numbers.
 *
 * This module therefore derives what the evidence can carry and refuses the
 * rest by name:
 *
 * | outcome | derived from | measured? |
 * |---|---|---|
 * | `FIXED` | a commit on main citing the finding, dated after it, that changed files | yes — the diff |
 * | `SUPERSEDED` | no such commit; the close names a finding whose chain reaches one | yes — the reference graph |
 * | `NO_ACTION` | closed, neither of the above | yes, as a UNION |
 * | `WRONG` / `INTENTIONAL` / `DIDNT_MATTER` | the responder's stated reason | only when declared |
 *
 * `NO_ACTION` is the union of the three verbal categories and is never
 * reported as one of them. Three real numbers beat four where one is a guess.
 * `declared` exists so the day a close records its reason — one line, the
 * convention the tree half-follows already — the split becomes real without a
 * code change, and `declaredCoverage` says how much of the corpus has one.
 *
 * ## Why the citation filter is not a detail
 *
 * A commit cannot cite a finding that does not exist yet. `fix(#547): verify
 * gate regression fix` is dated 2026-09-27 and issue #547 was filed
 * 2026-10-17, so that `547` is an SC id. 28 raw citations across this repo's
 * history have that shape. Counting them would move real findings into FIXED
 * and understate the cost side, which is the direction that flatters a filter.
 * The filter is applied here, the drops are counted, and `citationFilter`
 * states it in the summary next to every number it produced.
 *
 * ## Why the supersede walk is transitive
 *
 * It was not, in the first version, and the plants caught it. Duplicates here
 * are filed in chains — #547 names #530, which is itself a duplicate — and a
 * one-step walk scored every link after the first as `NO_ACTION`. That
 * overstated the noise bucket by 26 rows out of 98, in the direction that
 * makes a filter look more necessary than it is. A noise metric biased upward
 * is exactly the one that gets used to suppress.
 *
 * ## Why this cannot be read as a licence to suppress
 *
 * `compareReviewOutcomes` is the only comparison exported, and it returns
 * `REGRESSION` whenever `fixed` falls — whatever happened to the cost side,
 * including a filter that silenced the reviewer completely and drove the cost
 * to zero. There is no single scalar here that improves when a true finding is
 * deleted. Jason's standing priority and the post's are the same one, and it
 * is quoted in the detail line that refusal emits: catching real bugs first,
 * cutting review rounds second.
 *
 * ## Why an empty run is not a pass
 *
 * Same clause as `control.ts`, same reason: zero failures over zero findings
 * is an assertion that holds vacuously, and it is the shape this instrument
 * would decay into first. `usable` is false for an empty corpus and for one
 * with nothing closed in it, and `noiseRate` is `null` rather than `0` while
 * nothing declares a disposition — a withheld ratio, because "no noise" and
 * "nobody recorded whether there was noise" are different facts.
 */

/** The three verbal categories, as a responder would record them. */
export type FindingDisposition = "wrong" | "intentional" | "didnt-matter";

/**
 * What became of one finding. Exactly one is reached.
 *
 * `OPEN` is not an outcome, it is the absence of one — an unanswered finding
 * is neither a win nor noise, and counting it as either would make the metric
 * move whenever the tracker's backlog does.
 *
 * `SUPPRESSED` is how a filter appears in the data. A candidate finding the
 * filter withheld was never posted, so it cost nothing and fixed nothing —
 * but it stays in the population, because the alternative is comparing a
 * filtered sweep against a smaller corpus and calling the size difference an
 * improvement. It is the outcome that makes `compareReviewOutcomes` able to
 * grade #1168's and #1187's filters at all.
 */
export type FindingOutcome =
  | "FIXED"
  | "SUPERSEDED"
  | "NO_ACTION"
  | "WRONG"
  | "INTENTIONAL"
  | "DIDNT_MATTER"
  | "OPEN"
  | "SUPPRESSED"
  | "UNMEASURED";

/** Why a citation was not counted. Each is a different fix. */
export type CitationDropReason = "PREDATES_FILING" | "CHANGED_NOTHING";

/** A commit whose message names the finding. Unfiltered — the filter is here. */
export interface FindingCitation {
  sha: string;
  /** Commit date, epoch seconds. */
  at: number;
  /** Files the commit changed. A merge of nothing is not a fix. */
  filesChanged: number;
}

export interface ReviewFinding {
  id: number;
  /** Epoch seconds. A citation older than this is not a citation. */
  filedAt: number;
  closed: boolean;
  /** Every commit naming this id, before the filter. */
  citations: readonly FindingCitation[];
  /** Ids the close named — a duplicate's target, typically. */
  closedInFavourOf: readonly number[];
  /** The responder's own answer, when one was recorded. */
  declared: FindingDisposition | null;
  /**
   * True when a filter withheld this candidate so nobody ever saw it.
   *
   * Absent means posted, which is the right default for a historical corpus:
   * nothing suppressed anything over the window this was backfilled across,
   * and writing `false` 596 times would be ceremony. It is a real field and
   * not a default substitution — the backfill has no filter to describe, and
   * a filter A/B sets it explicitly on both sides.
   */
  suppressed?: boolean;
}

export interface FindingOutcomeReading {
  id: number;
  outcome: FindingOutcome;
  /** Citations that survived the filter. */
  citations: FindingCitation[];
  dropped: { sha: string; reason: CitationDropReason }[];
  /** The ids walked to reach SUPERSEDED, nearest first. Empty otherwise. */
  supersedeChain: number[];
  /** Sentences from the producing code — never re-derived by a caller. */
  detail: string[];
}

export interface FindingOutcomeSummary {
  /** Findings fed in. Printed beside every count, never inferred. */
  population: number;
  /** What the population IS, in the caller's words. */
  filter: string;
  /** The citation rule these counts were produced under, stated. */
  citationFilter: string;
  closed: number;
  fixed: number;
  superseded: number;
  noAction: number;
  wrong: number;
  intentional: number;
  didntMatter: number;
  open: number;
  /** Candidates a filter withheld. In neither `fixed` nor `cost`. */
  suppressed: number;
  unmeasured: number;
  /** Citations the filter refused, reported rather than silently applied. */
  droppedCitations: number;
  /** Closed findings whose three-way split is recorded at all. */
  declaredCoverage: number;
  /**
   * Everything a finding cost without being fixed: superseded, no-action, and
   * the declared three. The denominator side of any filter's claim.
   */
  cost: number;
  /** `cost / closed`. `null` when nothing closed — withheld, never 0. */
  costRate: number | null;
  /**
   * The share of closed findings a responder called wrong, intentional or
   * not worth doing. `null` until something declares a disposition: "no
   * noise" and "nobody recorded whether there was noise" are different facts.
   */
  noiseRate: number | null;
  /** False for a run that measured nothing, or nothing closed. */
  usable: boolean;
  detail: string[];
}

export type OutcomeComparisonVerdict = "IMPROVED" | "NEUTRAL" | "REGRESSION" | "UNMEASURED";

export interface OutcomeComparison {
  verdict: OutcomeComparisonVerdict;
  /** After minus before. Negative is a true finding lost. */
  fixedDelta: number;
  /** After minus before. Negative is noise removed. */
  costDelta: number;
  detail: string[];
}

/** The citation rule, named once so the summary and the docs cannot drift. */
export const CITATION_FILTER =
  "a citing commit counts only if it is dated at or after the finding was filed " +
  "(PREDATES_FILING) and changed at least one file (CHANGED_NOTHING)";

/**
 * Real findings whose outcome is known independently, so a sweep returning
 * zero is distinguishable from a sweep whose detector is blind.
 *
 * Each was read off `origin/main` and the tracker on 2026-10-22 rather than
 * recalled. `suite-lock-redirect` next door plants a defect in source; there
 * is no equivalent here, because the corpus is history and history cannot be
 * edited — so the plants are drawn from it instead, one per measurable
 * outcome. Three of the easy one would prove only that FIXED works.
 *
 * A plant that stops agreeing is the instrument reporting that the corpus
 * moved, which is the reading it is there to give.
 */
export const REVIEW_OUTCOME_PLANTS = [
  {
    id: 1169,
    expect: "FIXED" as const,
    why:
      "closed by dbf1044579ed750a0caac3ac82940bad86834e1f, 'feat(#1169): a negative control " +
      "for the reviewer', merged as PR #1201 nine files changed, four hours after it was filed",
  },
  {
    id: 473,
    expect: "SUPERSEDED" as const,
    why:
      "no commit ever cited it; its close names #481 and #483, and #483 is a merged pull " +
      "request rather than a finding — the one-hop case, and the one that needs the shipped set",
  },
  {
    id: 547,
    expect: "SUPERSEDED" as const,
    why:
      "names #530, which is itself a duplicate — the transitive case, and the one that caught " +
      "the first version of this module scoring 26 of 98 links as NO_ACTION",
  },
  {
    id: 23,
    expect: "NO_ACTION" as const,
    why:
      "closed with no comment, no commit and no superseding reference — one of the 56 findings " +
      "whose three-way split nothing in this repo records, which is the point being measured",
  },
] as const;

function dispositionOutcome(d: FindingDisposition): FindingOutcome {
  if (d === "wrong") return "WRONG";
  if (d === "intentional") return "INTENTIONAL";
  return "DIDNT_MATTER";
}

/**
 * Score every finding in a corpus.
 *
 * `shippedIds` holds ids that are merged pull requests rather than findings.
 * A close naming one of those terminates the supersede walk: the reference is
 * to work that landed, not to a dangling number, and without the set #473
 * reads as pointing at nothing.
 */
export function readFindingOutcomes(
  findings: readonly ReviewFinding[],
  shippedIds: ReadonlySet<number>,
): FindingOutcomeReading[] {
  const byId = new Map(findings.map(f => [f.id, f]));
  const kept = new Map<number, FindingCitation[]>();
  const dropped = new Map<number, { sha: string; reason: CitationDropReason }[]>();

  for (const f of findings) {
    const keep: FindingCitation[] = [];
    const drop: { sha: string; reason: CitationDropReason }[] = [];
    for (const c of f.citations) {
      // Order matters only for the reason recorded, not for the verdict: a
      // citation failing either test is not evidence of a fix. Date first,
      // because it is the one that misattributes rather than merely omits.
      if (c.at < f.filedAt) drop.push({ sha: c.sha, reason: "PREDATES_FILING" });
      else if (c.filesChanged <= 0) drop.push({ sha: c.sha, reason: "CHANGED_NOTHING" });
      else keep.push(c);
    }
    kept.set(f.id, keep);
    dropped.set(f.id, drop);
  }

  /** True when this id's own evidence is a landed change. */
  const isFixed = (id: number): boolean => {
    const f = byId.get(id);
    if (f === undefined) return shippedIds.has(id);
    return f.closed && (kept.get(id)?.length ?? 0) > 0;
  };

  /**
   * Walk the chain of "closed in favour of" until it reaches something that
   * landed. Returns the path taken, or null.
   *
   * `seen` is carried rather than memoised because a cycle must terminate as
   * "not superseded" without poisoning the answer for a caller that entered
   * the cycle from outside it.
   */
  const walk = (id: number, seen: Set<number>): number[] | null => {
    const f = byId.get(id);
    if (f === undefined) return shippedIds.has(id) ? [] : null;
    if (seen.has(id)) return null;
    seen.add(id);

    for (const target of f.closedInFavourOf) {
      if (isFixed(target)) return [target];
      const onward = walk(target, seen);
      if (onward !== null) return [target, ...onward];
    }
    return null;
  };

  return findings.map(f => {
    const citations = kept.get(f.id) ?? [];
    const drops = dropped.get(f.id) ?? [];
    const detail: string[] = [];
    for (const d of drops) {
      detail.push(`citation ${d.sha.slice(0, 8)} dropped: ${d.reason}`);
    }

    const base = { id: f.id, citations, dropped: drops, supersedeChain: [] as number[], detail };

    // FIRST. A withheld candidate has no outcome to derive — whatever the
    // tracker says about it describes a finding nobody was shown.
    if (f.suppressed === true) {
      detail.push("SUPPRESSED: a filter withheld this candidate, so it cost nothing and fixed nothing");
      return { ...base, outcome: "SUPPRESSED" as const };
    }

    if (!f.closed) return { ...base, outcome: "OPEN" as const };

    const fixed = citations.length > 0;

    // Both kinds of evidence present and disagreeing. Picking one silently is
    // how a contradiction becomes a clean number — the same call `control.ts`
    // makes about a payload whose verdict word fights its own findings.
    if (f.declared !== null && fixed) {
      detail.push(
        `UNMEASURED: the close declares '${f.declared}' and that contradicts ` +
          `${citations.length} commit(s) that changed files after it was filed`,
      );
      return { ...base, outcome: "UNMEASURED" as const };
    }

    if (f.declared !== null) return { ...base, outcome: dispositionOutcome(f.declared) };
    if (fixed) return { ...base, outcome: "FIXED" as const };

    const chain = walk(f.id, new Set());
    if (chain !== null && chain.length > 0) {
      return { ...base, outcome: "SUPERSEDED" as const, supersedeChain: chain };
    }

    detail.push(
      "NO_ACTION: closed with no landed change and no superseding finding. This is the " +
        "UNION of wrong, intentional or didn't-matter — nothing in the close records which, " +
        "so it is not reported as any one of them",
    );
    return { ...base, outcome: "NO_ACTION" as const };
  });
}

/**
 * Roll readings up, with the population printed beside the counts.
 *
 * `filter` is required and not defaulted for the reason `control.ts` requires
 * `--reviewer`: a count from a corpus that cannot say what it contained is a
 * number about nothing, and the defect class it belongs to — a window that
 * crossed a boundary, a corpus filtered by something nobody stated — is the
 * one that has cost this repo most.
 */
export function summariseFindingOutcomes(
  readings: readonly FindingOutcomeReading[],
  filter: string,
): FindingOutcomeSummary {
  const count = (o: FindingOutcome) => readings.filter(r => r.outcome === o).length;

  const fixed = count("FIXED");
  const superseded = count("SUPERSEDED");
  const noAction = count("NO_ACTION");
  const wrong = count("WRONG");
  const intentional = count("INTENTIONAL");
  const didntMatter = count("DIDNT_MATTER");
  const open = count("OPEN");
  const suppressed = count("SUPPRESSED");
  const unmeasured = count("UNMEASURED");

  const closed = readings.length - open - suppressed;
  const declaredCoverage = wrong + intentional + didntMatter;
  const cost = superseded + noAction + declaredCoverage;
  const droppedCitations = readings.reduce((n, r) => n + r.dropped.length, 0);

  const detail: string[] = [];
  for (const r of readings) detail.push(...r.detail);

  // A finding reaches a terminal state by being answered OR by being withheld.
  // Requiring `closed > 0` alone would call a totally silenced reviewer
  // UNMEASURED, and a filter that suppressed everything is the one reading
  // this must be able to call a regression.
  const usable = readings.length > 0 && closed + suppressed > 0;
  if (!usable) {
    detail.push(
      `this run measured nothing it can report on: ${readings.length} finding(s), ` +
        `${closed} closed and ${suppressed} withheld. Zero failures over zero findings ` +
        "holds vacuously, so the run is UNMEASURED rather than clean.",
    );
  }
  if (declaredCoverage === 0) {
    detail.push(
      "noiseRate is withheld: no finding in this population declares whether it was " +
        "wrong, intentional or not worth doing, so the three-way split Anthropic reports " +
        "is UNMEASURED here rather than zero.",
    );
  }

  return {
    population: readings.length,
    filter,
    citationFilter: CITATION_FILTER,
    closed,
    fixed,
    superseded,
    noAction,
    wrong,
    intentional,
    didntMatter,
    open,
    suppressed,
    unmeasured,
    droppedCitations,
    declaredCoverage,
    cost,
    costRate: closed === 0 ? null : cost / closed,
    noiseRate: declaredCoverage === 0 ? null : declaredCoverage / closed,
    usable,
    detail,
  };
}

/**
 * Grade one reviewer configuration against another over the same corpus.
 *
 * This is the function #1168's and #1187's filters have to pass, and the
 * asymmetry in it is the whole point. A filter that removes noise is an
 * improvement; a filter that removes a true finding is a regression **even if
 * it removed every piece of noise in the corpus at the same time**. There is
 * deliberately no weighting between the two sides and no combined score,
 * because any scalar that trades them is a scalar a filter can win by going
 * quiet.
 *
 * Populations must match. A filter measured over a smaller sweep than its
 * baseline has not been measured — two different corpora produce a difference
 * that is about the corpora.
 */
export function compareReviewOutcomes(
  before: FindingOutcomeSummary,
  after: FindingOutcomeSummary,
): OutcomeComparison {
  const fixedDelta = after.fixed - before.fixed;
  const costDelta = after.cost - before.cost;
  const detail: string[] = [];

  if (!before.usable || !after.usable) {
    detail.push(
      "one side of this comparison is not a usable reading, so the difference between " +
        "them is UNMEASURED rather than neutral.",
    );
    return { verdict: "UNMEASURED", fixedDelta, costDelta, detail };
  }

  if (before.population !== after.population) {
    detail.push(
      `not the same corpus: ${before.population} finding(s) before against ` +
        `${after.population} after. A smaller sweep is not an improvement, and the ` +
        "difference between two populations is about the populations.",
    );
    return { verdict: "UNMEASURED", fixedDelta, costDelta, detail };
  }

  if (fixedDelta < 0) {
    detail.push(
      `REGRESSION: ${-fixedDelta} finding(s) that had been fixed are no longer fixed. ` +
        `The cost side moved by ${costDelta}, and it does not buy this back — the stated ` +
        "priority is catching real bugs first and cutting review rounds second.",
    );
    return { verdict: "REGRESSION", fixedDelta, costDelta, detail };
  }

  if (costDelta < 0) {
    detail.push(
      `IMPROVED: ${-costDelta} fewer finding(s) cost a round without being fixed, and no ` +
        "finding that had been fixed was lost.",
    );
    return { verdict: "IMPROVED", fixedDelta, costDelta, detail };
  }

  detail.push(
    `NEUTRAL: nothing was lost and nothing was saved — fixed moved by ${fixedDelta}, ` +
      `cost by ${costDelta}.`,
  );
  return { verdict: "NEUTRAL", fixedDelta, costDelta, detail };
}

/**
 * Check a sweep against the plants.
 *
 * A plant absent from the sweep fails the same as a plant that disagrees. A
 * detector that cannot see its own known-positives and a corpus that no longer
 * contains them are different problems, but neither is a reading.
 */
export function verifyOutcomePlants(
  readings: readonly Pick<FindingOutcomeReading, "id" | "outcome">[],
): { verified: boolean; detail: string[] } {
  const byId = new Map(readings.map(r => [r.id, r.outcome]));
  const detail: string[] = [];

  for (const plant of REVIEW_OUTCOME_PLANTS) {
    const got = byId.get(plant.id);
    if (got === undefined) {
      detail.push(
        `#${plant.id} is not in the sweep at all, so this run cannot tell a working ` +
          `detector from a blind one. Expected ${plant.expect}: ${plant.why}`,
      );
      continue;
    }
    if (got !== plant.expect) {
      detail.push(`#${plant.id}: expected ${plant.expect}, read ${got}. ${plant.why}`);
    }
  }

  return { verified: detail.length === 0, detail };
}
