/**
 * How much history a generated CI job keeps, and whether that is enough for
 * the failure intake to report MEASURED (#987).
 *
 * ## The reading this exists to fix
 *
 * `lib/failure-intake.ts` mines `fix:` and `Revert` subjects out of `git log`.
 * Its refusal is `SHALLOW_HISTORY`, taken from
 * `git rev-parse --is-shallow-repository`, and `actions/checkout@v4` with no
 * `fetch-depth` clones to depth 1. So the intake has reported UNMEASURED on
 * every run of every generated workflow since it shipped — uniformly absent
 * rather than occasionally missing, which is why nobody noticed.
 *
 * ## Why this is a module and not a `fetch-depth: 0` on one line
 *
 * Two things were measured on 2026-10-21 against real repositories, and each
 * one falsifies a step of the obvious fix. Both are asserted as cases in
 * `test/ci-history-depth.test.ts` rather than described here.
 *
 * **A bounded depth does not make the intake MEASURED on a repository longer
 * than the depth.** `--is-shallow-repository` is a fact about `.git/shallow`,
 * not about how many commits you fetched: a clone deepened to
 * `MAX_COMMITS_SCANNED` and a clone at depth 1 both answer `true` as long as
 * there is any history past the boundary. #987 proposes `fetch-depth: 500` as
 * the bounded option that "matches what the code actually asks for"; measured
 * on a 520-commit repository, a depth-500 clone holds all 500 commits the
 * intake would read and still reports UNMEASURED. This repository's `main`
 * carries 1090 commits and only grows, so that is its permanent state.
 *
 * The exception, stated because it is the direction this module is
 * deliberately wrong in: when the depth exceeds the whole history, git has
 * nothing left to truncate and removes `.git/shallow`, so the intake reports
 * MEASURED. `ciHistoryReading` below refuses a bounded depth anyway — see its
 * docblock.
 *
 * And it is not even cheaper. Three clones of this repository, each repeated
 * three times: depth 1 took 1.23–1.64s for 6MB, depth 500 took 1.54–2.75s for
 * 9MB, and full history took 1.43–1.64s for 13MB. A bounded deepen makes the
 * server compute a cut of the graph; a full clone is served from a pack it
 * already has. The cheap option is the one that does not work, and the
 * bounded middle is the slowest of the three.
 *
 * **A bounded `git fetch` AFTER the checkout re-shallows a complete clone.**
 * This is the one that makes `fetch-depth: 0` alone inert. The generated job
 * already runs `git fetch --no-tags --depth=200 origin '+refs/heads/main:…'`
 * one step after the checkout, for the conformity ratchet's comparison base.
 * Measured on a complete 40-commit clone: `is-shallow-repository` goes
 * `false` → `true` and `rev-list --count HEAD` drops 40 → 20. Setting
 * `fetch-depth: 0` and leaving that step alone buys nothing at all.
 *
 * So the depth of the base-ref fetch is DERIVED from the checkout's depth
 * here, rather than declared beside it. Two numbers that have to agree, with
 * nothing comparing them, is the defect class this repository pays for most
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **It does not make the intake's reading good, only present.** Whether the
 *   mined set is worth anything is #988, and nothing here touches the
 *   classifier.
 * - **It says nothing about a job it cannot see.** The reading is taken from a
 *   parsed `CheckoutModel`; a job that acquires history some other way — a
 *   cache restore, a submodule, a hand-rolled `git clone` inside `run:` — is
 *   invisible to it and will read UNMEASURED while being fine. The direction
 *   is deliberate: a false UNMEASURED costs a conversation, a false MEASURED
 *   costs the whole point of #987.
 * - **It does not check that the history is ENOUGH**, only that it is
 *   untruncated. A repository younger than `MAX_COMMITS_SCANNED` commits
 *   reports MEASURED over fewer commits than the intake asked for, which is
 *   correct — there is no more history to have — but it is not the same claim.
 * - **It disagrees with the intake on one input, on purpose.** A bounded depth
 *   GREATER than the repository's whole history leaves nothing to truncate, so
 *   the real `mineFixCommits` reports MEASURED there while this reports
 *   UNMEASURED. The disagreement is asserted as a case rather than described.
 *   A generator cannot know how long a consumer's history is, still less how
 *   long it will be next year, so the only honest reading of a bounded depth
 *   at generation time is "this will truncate" — and the cost of being wrong
 *   is a young repository being told to keep history it already keeps.
 */
import type { CheckoutModel } from "./ci-checkout";

/**
 * The `fetch-depth:` the generated suite and gates jobs declare. `0` is
 * `actions/checkout`'s spelling for full history, and per the module docblock
 * it is the only value under which the intake can report MEASURED.
 *
 * One declaring position. The generator reads it, the base-ref fetch derives
 * from it, and the tests compare the emitted YAML against it.
 */
export const CI_SUITE_FETCH_DEPTH = 0;

/**
 * How deep the post-checkout base-ref fetch may go, given the checkout's own
 * depth.
 *
 * A function rather than a second constant, because the whole finding is that
 * these two cannot be chosen independently: a bounded fetch re-shallows a
 * complete checkout and silently undoes the `fetch-depth` above it. Passing
 * the suite depth in makes that dependency something a mutation can reach.
 *
 * `null` means "no `--depth` flag at all". It is not a wasteful choice when
 * the checkout is already full: the objects are local, so the fetch moves a
 * ref and nothing else.
 */
export function baseRefFetchDepth(suiteDepth: number): number | null {
  return suiteDepth === 0 ? null : 200;
}

/** Why a job's history is not a history. Exported so callers compare against the producer's spelling. */
export const SHALLOW_CHECKOUT = "SHALLOW_CHECKOUT";
export const RESHALLOWED_BY_FETCH = "RESHALLOWED_BY_FETCH";

export interface HistoryReading {
  /** The single discriminator; `reasons` is the other projection of one computation. */
  reading: "MEASURED" | "UNMEASURED";
  reasons: string[];
}

/**
 * THE decider: can the failure intake report MEASURED in a job with this
 * checkout?
 *
 * One binding, so there is one thing to mutate. It reads the `CheckoutModel`
 * `lib/ci-checkout.ts` already parses out of a workflow, rather than
 * re-parsing the YAML — a second reader of the same file would survive any
 * mutation of the first and both would read as covered.
 *
 * This PREDICTS what `mineFixCommits` will say. It is not a second copy of
 * that decision: the prediction is compared against the real intake run over
 * real clones built to this exact model, so the two are held to each other
 * instead of merely agreeing.
 *
 * It is a CONSERVATIVE prediction, and the one input on which it is knowingly
 * wrong is named in WHAT THIS DOES NOT COVER above: a bounded depth longer
 * than the repository's entire history is MEASURED in fact and UNMEASURED
 * here. Refusing every bounded depth is the only reading available at
 * generation time, when the history's length is unknown and unbounded.
 */
export function ciHistoryReading(model: CheckoutModel): HistoryReading {
  const reasons: string[] = [];

  // `depth: null` is `fetch-depth: 0`. Any number — including one larger than
  // MAX_COMMITS_SCANNED — leaves `.git/shallow` on disk, and the intake reads
  // that file and not the commit count.
  if (model.depth !== null) {
    reasons.push(`${SHALLOW_CHECKOUT}: fetch-depth ${model.depth}`);
  }

  // Order matters to a reader and not to the verdict: a bounded fetch
  // re-shallows whatever the checkout left, so it is a reason on its own even
  // when the checkout above it was full.
  for (const f of model.fetches) {
    if (f.depth !== null) {
      reasons.push(`${RESHALLOWED_BY_FETCH}: git fetch --depth=${f.depth} ${f.refspec}`);
    }
  }

  return { reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED", reasons };
}
