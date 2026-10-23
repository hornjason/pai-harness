/**
 * ai-review-control/variance-capture.ts — how much does the DEPLOYED single
 * adjudicator's withheld set move when you run the same batch through it
 * again?
 *
 * ## Read this before you read the number
 *
 * The answer this produces for the pinned arm is **zero, and it is zero by
 * construction**. That is the whole reason the artefact exists in the shape
 * it does, because a zero here is the single most misleading reading in this
 * subsystem:
 *
 * > *"We measured the single adjudicator twenty times and it never disagreed
 * > with itself, so there is nothing for a quorum to fix."*
 *
 * That sentence is the failure mode wearing the result's clothes. The quorum
 * is a variance control for an **agent** verifier — a model reading a finding
 * and voting on whether it is real. What is deployed at the filing chokepoint
 * is not that. `hooks/VerifyPhaseLock.hook.ts` calls `filingGate`, which calls
 * `adjudicateFiling`, which runs exactly two stages:
 *
 * | stage | binding | what it is |
 * |---|---|---|
 * | category | `classifyCategory` + `DROPPED_CATEGORIES` | regex over the title |
 * | dedupe | `duplicateCollisions` | set arithmetic over `symptomKeys` |
 *
 * Both are pure. Inspected at the pinned commit: no clock, no randomness, no
 * network, no model. `arbitrate` — the five-stage path that takes votes — has
 * **zero callers** outside `lib/` and `test/`; the only thing that supplies
 * `--votes` is `scripts/arbitrate-finding.ts`, a CLI nothing in production
 * invokes, and with no `--votes` it prints `DROP new (UNMEASURED)`.
 *
 * So a repeated run cannot disagree with itself, and twenty of them cannot
 * disagree twenty times. The pinned arm is a **control on the instrument**,
 * not a measurement of the thing the quorum is for: it establishes that the
 * deterministic half of the deployed path contributes none of the variance,
 * so any variance the live arm shows is attributable elsewhere.
 *
 * ## The two arms, and why the second one is the measurement
 *
 * - **pinned** — the open-issue set is snapshotted once and all M runs see
 *   the same bytes. Both inputs fixed. Predicted distinct withheld sets: 1.
 * - **live** — `openFindings` is re-read from the tracker on every run.
 *   The adjudicator is unchanged; its *input* moves. Any divergence here is
 *   deployed instability in the withheld set that has nothing to do with
 *   verifier nondeterminism, and the tracker fingerprint recorded beside each
 *   run is what attributes it.
 *
 * ## What is permanently UNMEASURED, stated because a reader will assume
 * ## otherwise
 *
 * Neither arm can price the thing the quorum exists for. Three gaps, and
 * none of them closes by running M higher:
 *
 * 1. **There is no deployed agent verifier to vary.** The single-*agent*
 *    control the quorum genuinely needs does not exist in this tree, so its
 *    variance has never been read and is not read here.
 * 2. **A withheld candidate leaves no trace on either arm.** A finding the
 *    gate refuses is never filed, never commented on, and never fixed, so
 *    nothing downstream records whether refusing it was right. The outcome
 *    taxonomy in `outcomes.ts` is derived from commits and the reference
 *    graph; a candidate that reached neither is invisible to it, permanently.
 * 3. **A finding nobody ever acted on leaves no trace on either arm either**
 *    — the same hole from the other side. It is not that the measurement is
 *    hard; there is no artefact to read.
 *
 * ## Plants
 *
 * Three, one per outcome, because "the withheld set was identical every run"
 * is vacuous if the withheld set is empty or is everything — the third shape
 * in `.claude/rules/checks-must-be-able-to-fail.md`. A plant that does not
 * land makes the whole capture UNMEASURED rather than lowering a score.
 *
 * | plant | must land | proves |
 * |---|---|---|
 * | `dropped` | REFUSE / DROPPED_CATEGORY | the category stage ran |
 * | `duplicate` | REFUSE / DUPLICATE | the dedupe stage ran — a stage `dropped` never reaches |
 * | `allowed` | ALLOW | the gate is not refusing everything |
 *
 * Usage:
 *
 *     bun evals/ai-review-control/variance-capture.ts [--runs 20] [--write]
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

import {
  adjudicateFiling,
  measuredCorpus,
  openFindings,
  type FilingAttempt,
  type FilingAdjudication,
} from "../../lib/issue-filing-gate";
import type { Finding } from "../../lib/finding-arbiter";

/** Non-zero for every refusal, through one constant. */
export const CAPTURE_REFUSED = "variance capture refused";

/** The default repeat count. See `whyThisM` for the argument. */
export const DEFAULT_RUNS = 20;

/**
 * Why twenty, said plainly so nobody reads it as a confidence interval.
 *
 * For a function proved pure by inspection, any M >= 2 adds nothing: the
 * second run is the proof and the other eighteen are the same proof. M is
 * only worth anything against a divergence the inspection *missed*, and
 * twenty clean runs bound an unseen per-run divergence rate at roughly 15%
 * (rule of three, 3/20) — a weak bound, and deliberately reported as weak.
 * The primary evidence is the inspection; the count is the cheap corroborant.
 */
export const WHY_THIS_M =
  "20 runs. For a function proved pure by reading it, M>=2 is the proof and the rest are the same proof again; " +
  "20 clean runs bound an unseen per-run divergence rate at only ~15% (rule of three). The inspection is the " +
  "evidence here, not the count, and reporting the count as the evidence would overstate it.";

export interface BatchRow {
  /** `${batch}/${index}` — unique by construction, the `CandidateRecord.key` shape (#1263). */
  key: string;
  /** Where this row came from, in words. */
  provenance: string;
  attempt: FilingAttempt;
  /**
   * The id to hold out of the comparison set when adjudicating this row, or
   * `null` to compare against the whole set.
   *
   * Leave-one-out: a replayed open issue compared against a set containing
   * its own tracker row collides with itself every time, which would make
   * every row REFUSE/DUPLICATE and the batch degenerate. Holding the row out
   * asks the question worth asking — *would this have been withheld if it
   * were filed fresh today?*
   */
  holdOut: string | null;
  /**
   * Rows added to the comparison set for THIS row only.
   *
   * The duplicate plant needs a twin in the set to collide with, and it must
   * not depend on the tracker to supply one. The first cut copied
   * `existing[0]` and assumed a verbatim copy is always a duplicate — false
   * under a rule that requires **two shared quantity keys**, so the plant
   * landed only while the first open issue happened to carry two numbers.
   * It stopped landing within hours of being written, on a tracker whose
   * first row had changed, and the capture correctly went UNMEASURED.
   *
   * That is the seventh shape in `.claude/rules/checks-must-be-able-to-fail.md`
   * — a battery row meeting a precondition nobody named. A known-positive
   * that is hostage to what the corpus happens to contain is not a known
   * positive.
   */
  extraExisting?: readonly Finding[];
}

export interface RunReading {
  /** Sorted keys of every row the gate did not ALLOW. */
  withheld: string[];
  /** Keys of rows the gate ALLOWed, sorted. */
  allowed: string[];
  /** Keys whose outcome was UNMEASURED, sorted — counted apart from withheld. */
  unmeasured: string[];
  /** `sha256` over the sorted withheld list, so two runs compare in one field. */
  withheldHash: string;
  /** Size and identity of the comparison set this run saw. */
  trackerCount: number;
  trackerHash: string;
}

export interface ArmReading {
  arm: "pinned" | "live";
  runs: number;
  /** How many byte-distinct withheld sets the M runs produced. 1 means stable. */
  distinctWithheldSets: number;
  /** How many distinct comparison sets the M runs saw. */
  distinctTrackerSets: number;
  /**
   * Wall-clock seconds from the first run to the last.
   *
   * Recorded because it bounds what the arm can possibly say. The `live` arm
   * runs its M reads back to back, so its span is seconds — and a tracker
   * that moves on the scale of tens of minutes cannot be caught inside one.
   * `distinctTrackerSets: 1` over a seconds-long span is a control on the
   * API read, NOT a measurement of tracker drift, and reading it as the
   * second is the arm's own version of the mistake this file is about.
   */
  spanSeconds: number;
  /** Every row's outcome on the first run, so a reader can judge the counts. */
  firstRunDetail: Array<{ key: string; provenance: string; outcome: string; reason: string }>;
  readings: RunReading[];
}

export interface VarianceCapture {
  kind: "single-adjudicator-variance";
  name: string;
  /**
   * The commit whose code ACTUALLY RAN — `HEAD` of the executing tree.
   *
   * It used to be `origin/main`, which is a different question (#1320): the
   * capture adjudicates with the working tree's `lib/`, so a worktree behind
   * the remote recorded the newer SHA while running the older gate, and a
   * worktree on a feature branch touching `lib/` recorded a SHA whose code
   * was not what ran. The first artefact was right by coincidence — its tree
   * happened to equal `origin/main`. A provenance field that is right by
   * coincidence is the thing this whole module exists to refuse.
   */
  pinnedCommit: string;
  /** Re-read at the END of the run. Unequal to `pinnedCommit` makes this UNMEASURED. */
  commitAtEnd: string;
  /**
   * Where `origin/main` stood. Recorded beside `pinnedCommit`, not instead
   * of it, because "what ran" and "what is deployed" are separate facts and
   * a capture is only a reading of the deployed adjudicator when they agree.
   */
  originMain: string;
  /** `HEAD:lib` — the tree object for the code that ran. */
  libTree: string;
  /** `origin/main:lib` — the same tree, as deployed. */
  originMainLibTree: string;
  /**
   * Uncommitted paths under `lib/` at the start of the run.
   *
   * **Scope stated because a count without one is unreadable:** this is the
   * whole of `lib/`, not the three files the behaviour depends on. Deliberate
   * and in the refusing direction — the capture reaches `adjudicateFiling`
   * through imports it does not enumerate, so naming three files would be a
   * detector narrower than what it detects. A dirty `lib/` means no SHA
   * describes the code that ran, whatever the SHA says.
   */
  dirtyPaths: string[];
  measuredAt: string;
  repo: string;
  command: string;
  runs: number;
  whyThisM: string;
  batchProvenance: string;
  batchSize: number;
  plantsAgreed: number;
  plantsTotal: number;
  plantDetail: Array<{ plant: string; expected: string; observed: string; agreed: boolean }>;
  usable: boolean;
  /** Why it is not usable, or why the number means less than it looks like. */
  caveat: string;
  permanentlyUnmeasured: string[];
  arms: ArmReading[];
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A finding, as the gate would see it filed from the command line. */
function attemptOf(title: string, body: string): FilingAttempt {
  // `repo` and `repeatedValueFlag` are the two suppression classes #1261
  // added to the shape. Both are stated rather than defaulted, because this
  // file is the measuring instrument: a plant filed into another repo, or one
  // whose title was given twice, is not the finding the arm thinks it scored.
  return { title, body, labels: [], bodyFile: null, repo: null, repeatedValueFlag: false };
}

/**
 * The twin the duplicate plant collides with.
 *
 * Synthetic and carried in the plant's own `extraExisting`, so the plant is a
 * known positive whatever the tracker contains. It names three quantities
 * because `duplicateOverlap` requires **two** shared `qty:` keys — one is not
 * a duplicate, and a plant built on one number is a plant that lands by luck.
 */
export const DUPLICATE_PLANT_TWIN: Finding = {
  id: "plant-twin",
  title: "`zqxjPlantTwin` miscounts and the mismatch is silent",
  body:
    "`zqxjPlantTwin()` in `lib/zqxj-plant-twin.ts` reports 60571 rows where the fixture holds 60572, " +
    "across 60573 entries. Measured 60571 against 60572 on 60573.",
};

/**
 * The three plants. None depends on what the tracker happens to contain.
 *
 * `duplicate` is compared against the set plus `DUPLICATE_PLANT_TWIN`, which
 * is the one row where the hold-out is deliberately not applied — that is
 * what makes it a known positive for the **dedupe** stage rather than for the
 * category stage, and the synthetic twin is what makes it one every time.
 */
export function plantsFor(_existing: readonly Finding[], batch: string): BatchRow[] {
  return [
    {
      key: `${batch}/plant-dropped`,
      provenance: "PLANT: a diagnostics-category title the brief names verbatim as one our own arbiter drops",
      attempt: attemptOf(
        "the error message should name the legal values",
        "When the loader refuses an unknown mode it prints `invalid mode`. It should list what is accepted.",
      ),
      holdOut: null,
    },
    {
      key: `${batch}/plant-duplicate`,
      provenance: "PLANT: a synthetic finding replayed verbatim against a set carrying its twin, so it cannot depend on tracker content",
      attempt: attemptOf(DUPLICATE_PLANT_TWIN.title, DUPLICATE_PLANT_TWIN.body),
      holdOut: null,
      extraExisting: [DUPLICATE_PLANT_TWIN],
    },
    {
      key: `${batch}/plant-allowed`,
      provenance: "PLANT: a correctness finding over symbols and quantities that exist nowhere in the tracker",
      attempt: attemptOf(
        "`zqxjVarianceProbe` returns the wrong count and the off-by-one is silent",
        "`zqxjVarianceProbe()` in `lib/zqxj-variance-probe.ts` reports 81731 rows where the fixture holds " +
          "81732. Measured 81731 against 81732 on a corpus of 40771 entries.",
      ),
      holdOut: null,
    },
  ];
}

/** Every open issue, replayed as a fresh filing, plus the plants. */
export function batchFrom(existing: readonly Finding[], batch: string): BatchRow[] {
  const replays = existing.map((f, i) => ({
    key: `${batch}/${i}`,
    provenance: `open issue #${f.id} replayed as a fresh filing (leave-one-out)`,
    attempt: attemptOf(f.title, f.body),
    holdOut: f.id,
  }));
  return [...replays, ...plantsFor(existing, batch)];
}

/**
 * The set one row is adjudicated against. One binding, three callers.
 *
 * The hold-out and the injected twin are both per-row, and keeping them in a
 * single function is what stops the plant path and the replay path drifting
 * apart — two deciders answering the same question would be behaviourally one
 * decider, and a mutation of either would leave the other holding the case up.
 */
export function comparisonSet(row: BatchRow, existing: readonly Finding[]): readonly Finding[] {
  const base = row.holdOut === null ? existing : existing.filter(f => f.id !== row.holdOut);
  return row.extraExisting === undefined ? base : [...base, ...row.extraExisting];
}

/** One pass of the whole batch through the deployed adjudicator. */
export async function runBatch(batch: readonly BatchRow[], existing: readonly Finding[]): Promise<RunReading> {
  const withheld: string[] = [];
  const allowed: string[] = [];
  const unmeasured: string[] = [];
  for (const row of batch) {
    const set = comparisonSet(row, existing);
    const v: FilingAdjudication = await adjudicateFiling(row.attempt, async () => measuredCorpus(set));
    if (v.outcome === "ALLOW") allowed.push(row.key);
    else if (v.outcome === "UNMEASURED") unmeasured.push(row.key);
    else withheld.push(row.key);
  }
  withheld.sort();
  allowed.sort();
  unmeasured.sort();
  const ids = existing.map(f => f.id).sort();
  return {
    withheld,
    allowed,
    unmeasured,
    withheldHash: hash(withheld.join("\n")),
    trackerCount: existing.length,
    trackerHash: hash(ids.join("\n")),
  };
}

/** Every row's outcome and the gate's own reason, for one pass. */
export async function detailOf(
  batch: readonly BatchRow[],
  existing: readonly Finding[],
): Promise<ArmReading["firstRunDetail"]> {
  const out: ArmReading["firstRunDetail"] = [];
  for (const row of batch) {
    const set = comparisonSet(row, existing);
    const v = await adjudicateFiling(row.attempt, async () => measuredCorpus(set));
    out.push({
      key: row.key,
      provenance: row.provenance,
      outcome: v.outcome === "ALLOW" ? "ALLOW" : `${v.outcome}/${v.refusal}`,
      reason: v.reason,
    });
  }
  return out;
}

/** What each plant must land as, and what it did. */
export async function readPlants(
  existing: readonly Finding[],
  batch: string,
): Promise<VarianceCapture["plantDetail"]> {
  const expected: Record<string, string> = {
    [`${batch}/plant-dropped`]: "REFUSE/DROPPED_CATEGORY",
    [`${batch}/plant-duplicate`]: "REFUSE/DUPLICATE",
    [`${batch}/plant-allowed`]: "ALLOW",
  };
  const out: VarianceCapture["plantDetail"] = [];
  for (const row of plantsFor(existing, batch)) {
    const v = await adjudicateFiling(row.attempt, async () => measuredCorpus(comparisonSet(row, existing)));
    const observed = v.outcome === "ALLOW" ? "ALLOW" : `${v.outcome}/${v.refusal}`;
    out.push({ plant: row.key, expected: expected[row.key]!, observed, agreed: observed === expected[row.key] });
  }
  return out;
}

/**
 * The sentence that bounds what the live arm can claim.
 *
 * One binding, and it reads the arm rather than restating it. The first cut
 * spelled `distinctTrackerSets: 1` as a literal next to an interpolated span,
 * which the AI review on #1310 caught: in an artefact whose only job is to
 * stop a reading being misread, the prose could contradict the `arms` data
 * beside it on exactly the run where the contradiction mattered — the one
 * where the tracker DID move.
 *
 * And a moved tracker is not a weaker version of the same sentence, it is a
 * different fact, so this returns different text rather than a different
 * number. A live arm that varied has measured something: the adjudicator is
 * unchanged, so the divergence is attributable to its input.
 */
export function liveArmCaveat(arm: Pick<ArmReading, "distinctTrackerSets" | "distinctWithheldSets" | "spanSeconds">): string {
  const span = arm.spanSeconds.toFixed(1);
  if (arm.distinctTrackerSets > 1 || arm.distinctWithheldSets > 1) {
    return (
      `The live arm DID vary over its ${span}s span: ${arm.distinctTrackerSets} distinct comparison set(s) and ` +
      `${arm.distinctWithheldSets} distinct withheld set(s). The adjudicator did not change between those runs, ` +
      "so the divergence is attributable to its input — the tracker moved — and not to the gate. That is a real " +
      "reading of deployed instability in the withheld set, and it is still not a reading of verifier variance."
    );
  }
  return (
    `And the live arm's zero is bounded by its span (${span}s): M reads taken back to back cannot catch a tracker ` +
    `that moves on the scale of tens of minutes, so \`distinctTrackerSets: ${arm.distinctTrackerSets}\` here is a ` +
    "control on the API read and NOT a measurement of tracker drift. Measuring that needs an hours-long window, " +
    "which is a separate capture and was not taken — deliberately, because a window that long would likely " +
    "straddle a merge to `lib/issue-filing-gate.ts` and measure a mixture."
  );
}

/**
 * A pair of `ai-review` attempts that read ONE tree.
 *
 * A re-run replays the recorded merge commit instead of recomputing it, so the
 * two attempts of a single run check out the same commit. That is the only way
 * a same-tree repeat exists in this repository's history, and it is why the
 * experiment this file once called unrun had in fact already been run — three
 * times, incidentally, by ordinary re-runs (#1329).
 */
export interface SameTreeReading {
  /** The run id. Both attempts are attempts of this one run. */
  run: string;
  /** The commit both attempts checked out, READ from each attempt's log, or `null` where it was not read. */
  mergeCommit: string | null;
  /** The resolved `ai-review round: N (cap 3)` line, per attempt. */
  rounds: [number, number];
  /** `num_turns` from the action's result, per attempt. */
  turns: [number, number];
  /**
   * The adjudicated outcome per attempt, or `null` where GitHub retained only
   * the aggregate log and no verdict survives. `null` is UNMEASURED — it is
   * emphatically not two attempts agreeing.
   */
  verdicts: [string, string] | null;
}

/**
 * The two attempts got the SAME prompt.
 *
 * Unequal rounds switch `atCapInstruction`, so the input differed and the pair
 * measures nothing about the verifier. rg-1187-jury proposed this confound for
 * all three pairs; the resolved round lines show it applies to exactly one, and
 * that one carries by far the largest turn spread.
 *
 * This docblock previously added "and widen the prior-findings set fed in to
 * suppress repeats", which is false and was shipped in #1329. There is no
 * carry-forward: the round file written by the workflow holds exactly
 * `review_round`, `round_budget` and `round_budget_spent`, the reviewer's
 * prompt says nothing carries findings forward (#1255), and the workflow's
 * only mention of `carryForward` is a comment saying narrowing stays unsafe
 * UNTIL something re-emits prior findings. The instruction switch alone is
 * sufficient to disqualify the pair; the second reason was doing reinforcing
 * work in an argument and was not real. Caught by rg-1187-jury.
 */
export const promptHeld = (r: SameTreeReading): boolean => r.rounds[0] === r.rounds[1];

/**
 * Same-tree `ai-review` pairs, every field read from the run logs.
 *
 * `verdicts` is `null` on the other two because the reviewer **wrote no
 * findings payload** (#1307), not because the log was lost. Every one of the
 * 51 attempt logs across this repository's 23 multi-attempt `ai-review` runs
 * is fetchable; 36 of them record `exited successfully WITHOUT writing a
 * findings payload`. The first version of this comment blamed GitHub
 * retention, which was a guess dressed as a reason — retention is not the
 * binding constraint and saying so sent the next reader to the wrong fix.
 *
 * A reading nobody can take is still not a reading that agreed.
 */
export const AI_REVIEW_SAME_TREE_READINGS: readonly SameTreeReading[] = [
  {
    run: "39962683401",
    mergeCommit: "99d50fc",
    rounds: [5, 5],
    turns: [51, 52],
    verdicts: ["BLOCKED", "CLEAN"],
  },
  { run: "39959490557", mergeCommit: null, rounds: [2, 2], turns: [44, 48], verdicts: null },
  { run: "39957264329", mergeCommit: null, rounds: [3, 4], turns: [37, 64], verdicts: null },
];

/**
 * What remains unread about `ai-review` variance, AFTER saying what was read.
 *
 * Derived from the readings rather than restated beside them — the #1310
 * defect, found by the AI review on this very file, was prose that could
 * contradict the data it sat next to.
 */
export function aiReviewVarianceResidue(readings: readonly SameTreeReading[]): string {
  const held = readings.filter(promptHeld);
  const confounded = readings.filter(r => !promptHeld(r));
  const scored = held.filter(r => r.verdicts !== null);
  const disagreed = scored.filter(r => r.verdicts![0] !== r.verdicts![1]);

  const lost =
    `${readings.length - scored.length} of ${readings.length} same-tree pair(s) carry NO verdict — ` +
    `${confounded.length} because the round changed between attempts (an unequal round is a different ` +
    "prompt, not a repeat), and the rest because the reviewer exited successfully without writing a " +
    "findings payload (#1307) — the logs are all fetchable, so this is the reviewer producing nothing " +
    "rather than a reading being lost. Those are UNMEASURED and are not attempts that agreed.";

  if (scored.length === 0) {
    return (
      "A deployed agent verifier does exist elsewhere — the `ai-review` workflow — and its run-to-run " +
      `variance is unmeasured at the level that matters. ${lost} The experiment that would settle it is ` +
      "`gh run rerun` on an unchanged SHA — a re-run replays the same merge ref, so the input is genuinely " +
      "fixed — at real API spend per run."
    );
  }

  const detail = disagreed
    .map(r => `run ${r.run} returned ${r.verdicts![0]} then ${r.verdicts![1]} on ${r.mergeCommit ?? "an unread commit"}`)
    .join("; ");

  return (
    "A deployed agent verifier does exist elsewhere — the `ai-review` workflow — and its run-to-run variance " +
    `IS now partly read, so this entry states a measurement rather than an absence. ${scored.length} same-tree ` +
    `pair(s) carry two verdicts with the tree, head, round and prompt all held fixed, and ${disagreed.length} ` +
    `of them DISAGREED: ${detail}. A verdict flip is the failure a quorum is for, and it is the one reading ` +
    "here taken on a verifier that actually ships. Two cautions the number does not carry on its own. The " +
    "turn counts across that flip were 51 and 52 — so `num_turns` is a poor proxy for verifier variance, and " +
    `a stability argument built on turn counts is measuring the wrong quantity. And ${lost} n is small enough ` +
    "that no rate should be read off it; what it establishes is that the rate is not zero."
  );
}

export const PERMANENTLY_UNMEASURED = [
  "No agent verifier feeds THIS gate. `arbitrate` has no caller outside lib/ and test/, and only " +
    "`scripts/arbitrate-finding.ts` can supply `--votes`, so the verifier group a quorum would be a variance " +
    "control for does not run on the filing path and is not read here.",
  aiReviewVarianceResidue(AI_REVIEW_SAME_TREE_READINGS),
  "A withheld candidate leaves no trace on either arm. It is never filed, never commented on and never " +
    "fixed, so nothing downstream records whether withholding it was right. `outcomes.ts` derives from commits " +
    "and the reference graph; a candidate that reached neither is invisible to it, permanently.",
  "A finding nobody ever acted on leaves no trace either — the same hole from the other side. There is no " +
    "artefact to read, so this is not a measurement that is merely expensive.",
];

export interface CaptureProvenance {
  root: string;
  runs: number;
  /** `HEAD` of the executing tree — the code that actually ran (#1320). */
  commit: string;
  /** Where `origin/main` stood. */
  originMain: string;
  /** `HEAD:lib` — the tree object for the code the adjudicator lives in. */
  libTree: string;
  /** `origin/main:lib` — the same tree, as deployed. */
  originMainLibTree: string;
  /** Uncommitted paths under `lib/` at the start of the run. */
  dirtyPaths: string[];
}

/**
 * Why a stale or dirty tree is UNMEASURED rather than a reading with a
 * footnote.
 *
 * The capture's subject is **the deployed adjudicator**. A reading taken
 * against code that is not deployed is not a weaker reading of that subject,
 * it is a reading of a different one — and it is indistinguishable from the
 * real thing once it is a JSON file with a SHA in it.
 */
export function provenanceRefusal(
  p: Pick<CaptureProvenance, "libTree" | "originMainLibTree" | "dirtyPaths">,
): string | null {
  if (p.dirtyPaths.length > 0) {
    return (
      `UNMEASURED: ${p.dirtyPaths.length} uncommitted path(s) under \`lib/\` — ${p.dirtyPaths.slice(0, 5).join(", ")}` +
      `${p.dirtyPaths.length > 5 ? ", …" : ""}. No commit describes the code that ran, whatever the SHA says.`
    );
  }
  // The `lib/` TREE, not the commit. Comparing whole SHAs would refuse every
  // feature branch, including this artefact's own — a detector wider than
  // what it detects, and one that would make the artefact unmaintainable.
  // The question is only ever whether the adjudicator's code is the deployed
  // code, and a tree object answers exactly that.
  if (p.libTree !== p.originMainLibTree) {
    return (
      `UNMEASURED: this tree's \`lib/\` is ${p.libTree} and \`origin/main\`'s is ${p.originMainLibTree}. The ` +
      "capture would describe an adjudicator that is not the deployed one, which is a reading of a different " +
      "subject rather than a weaker reading of this one."
    );
  }
  return null;
}

export async function capture(opts: CaptureProvenance): Promise<VarianceCapture> {
  const batchName = `variance-${opts.commit.slice(0, 12)}`;
  const reading = await openFindings(opts.root);
  const measuredAt = new Date().toISOString();

  if (reading.reading === "UNMEASURED") {
    return {
      kind: "single-adjudicator-variance",
      name: "single-adjudicator-variance",
      pinnedCommit: opts.commit,
      commitAtEnd: opts.commit,
      originMain: opts.originMain,
      libTree: opts.libTree,
      originMainLibTree: opts.originMainLibTree,
      dirtyPaths: opts.dirtyPaths,
      measuredAt,
      repo: "hornjason/pai-harness",
      command: `bun evals/ai-review-control/variance-capture.ts --runs ${opts.runs}`,
      runs: 0,
      whyThisM: WHY_THIS_M,
      batchProvenance: "none — the open-issue set could not be read",
      batchSize: 0,
      plantsAgreed: 0,
      plantsTotal: 3,
      plantDetail: [],
      usable: false,
      caveat:
        "UNMEASURED: `openFindings` took no reading, so the comparison set was never read. A missing token, " +
        "a 403, a rate limit, an unreachable API and a corpus every filter emptied all land here, and none " +
        `of them is an empty tracker. Its own reason: ${reading.why}`,
      permanentlyUnmeasured: PERMANENTLY_UNMEASURED,
      arms: [],
    };
  }

  const snapshot = reading.findings;
  const batch = batchFrom(snapshot, batchName);
  const plantDetail = await readPlants(snapshot, batchName);
  const plantsAgreed = plantDetail.filter(p => p.agreed).length;

  const pinnedStart = Date.now();
  const pinned: RunReading[] = [];
  for (let i = 0; i < opts.runs; i++) pinned.push(await runBatch(batch, snapshot));
  const pinnedSpan = (Date.now() - pinnedStart) / 1000;
  const pinnedDetail = await detailOf(batch, snapshot);

  const liveStart = Date.now();
  const live: RunReading[] = [];
  let liveDetail: ArmReading["firstRunDetail"] = [];
  for (let i = 0; i < opts.runs; i++) {
    const now = await openFindings(opts.root);
    if (now.reading === "UNMEASURED") break;
    live.push(await runBatch(batch, now.findings));
    if (i === 0) liveDetail = await detailOf(batch, now.findings);
  }
  const liveSpan = (Date.now() - liveStart) / 1000;

  const arm = (
    name: "pinned" | "live",
    readings: RunReading[],
    spanSeconds: number,
    firstRunDetail: ArmReading["firstRunDetail"],
  ): ArmReading => ({
    arm: name,
    runs: readings.length,
    distinctWithheldSets: new Set(readings.map(r => r.withheldHash)).size,
    distinctTrackerSets: new Set(readings.map(r => r.trackerHash)).size,
    spanSeconds,
    firstRunDetail,
    readings,
  });

  const pinnedArm = arm("pinned", pinned, pinnedSpan, pinnedDetail);
  const liveArm = arm("live", live, liveSpan, liveDetail);

  const provenance = provenanceRefusal(opts);
  const first = pinned[0];
  const degenerate =
    first === undefined || first.withheld.length === 0 || first.allowed.length === 0;

  return {
    kind: "single-adjudicator-variance",
    name: "single-adjudicator-variance",
    pinnedCommit: opts.commit,
    commitAtEnd: opts.commit,
    originMain: opts.originMain,
    libTree: opts.libTree,
    originMainLibTree: opts.originMainLibTree,
    dirtyPaths: opts.dirtyPaths,
    measuredAt,
    repo: "hornjason/pai-harness",
    command: `bun evals/ai-review-control/variance-capture.ts --runs ${opts.runs}`,
    runs: opts.runs,
    whyThisM: WHY_THIS_M,
    batchProvenance:
      `every open issue on hornjason/pai-harness at ${measuredAt}, read through \`openFindings\` ` +
      `(the gate's own reader, capped at OPEN_ISSUE_LIMIT), each replayed as a fresh filing against the set ` +
      `with its own row held out, plus three plants.`,
    batchSize: batch.length,
    plantsAgreed,
    plantsTotal: plantDetail.length,
    plantDetail,
    usable: provenance === null && plantsAgreed === plantDetail.length && plantDetail.length > 0 && !degenerate,
    caveat:
      provenance !== null
        ? provenance
        : plantsAgreed !== plantDetail.length
        ? "UNMEASURED: a plant did not land, so this run is not distinguishable from a blind one."
        : degenerate
          ? "UNMEASURED: the withheld set is empty or is the whole batch, so `identical every run` is vacuous."
          : "The pinned arm's zero is zero BY CONSTRUCTION — `adjudicateFiling` is regex plus set arithmetic, " +
            "with no clock, no randomness, no network and no model. Read it as a control establishing that the " +
            "deterministic half contributes no variance, never as evidence that a quorum has nothing to fix. " +
            liveArmCaveat(liveArm),
    permanentlyUnmeasured: PERMANENTLY_UNMEASURED,
    arms: [pinnedArm, liveArm],
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runsFlag = argv.indexOf("--runs");
  const runs = runsFlag === -1 ? DEFAULT_RUNS : Number(argv[runsFlag + 1]);
  const root = process.env.RUNGATE_PROJECT_ROOT ?? join(import.meta.dir, "..", "..");
  const { execFileSync } = await import("child_process");
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();

  // `HEAD`, not `origin/main` (#1320). The capture adjudicates with THIS
  // tree's `lib/`, so the only SHA that describes what ran is this one. Both
  // are recorded, and disagreeing makes the capture UNMEASURED.
  const rev = (): string => git("rev-parse", "HEAD");
  const dirtyPaths = git("status", "--porcelain", "--", "lib")
    .split("\n")
    .map(l => l.slice(3).trim())
    .filter(l => l !== "");

  const commit = rev();
  const out = await capture({
    root,
    runs,
    commit,
    originMain: git("rev-parse", "origin/main"),
    libTree: git("rev-parse", "HEAD:lib"),
    originMainLibTree: git("rev-parse", "origin/main:lib"),
    dirtyPaths,
  });
  out.commitAtEnd = rev();

  if (out.commitAtEnd !== out.pinnedCommit) {
    out.usable = false;
    out.caveat =
      `UNMEASURED: the executing tree moved from ${out.pinnedCommit} to ${out.commitAtEnd} during the run, so ` +
      "the M runs may straddle two adjudicators and the artefact would measure a mixture. Re-take it.";
  }

  if (argv.includes("--write")) {
    const path = join(import.meta.dir, "baselines", "single-adjudicator-variance.json");
    writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
  console.log(
    JSON.stringify(
      {
        usable: out.usable,
        pinnedCommit: out.pinnedCommit,
        commitAtEnd: out.commitAtEnd,
        batchSize: out.batchSize,
        plants: `${out.plantsAgreed}/${out.plantsTotal}`,
        arms: out.arms.map(a => ({
          arm: a.arm,
          runs: a.runs,
          distinctWithheldSets: a.distinctWithheldSets,
          distinctTrackerSets: a.distinctTrackerSets,
          spanSeconds: a.spanSeconds,
          withheld: a.readings[0]?.withheld.length ?? null,
          allowed: a.readings[0]?.allowed.length ?? null,
          unmeasured: a.readings[0]?.unmeasured.length ?? null,
        })),
        caveat: out.caveat,
      },
      null,
      2,
    ),
  );
}
