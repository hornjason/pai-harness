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

import { adjudicateFiling, openFindings, type FilingAttempt, type FilingAdjudication } from "../../lib/issue-filing-gate";
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
  pinnedCommit: string;
  /** Re-read at the END of the run. Unequal to `pinnedCommit` makes this UNMEASURED. */
  commitAtEnd: string;
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
  return { title, body, labels: [], bodyFile: null };
}

/**
 * The three plants, built from the live set so the duplicate one is real.
 *
 * `duplicate` copies an existing issue verbatim and is compared against the
 * whole set INCLUDING it, which is the one row where the hold-out is
 * deliberately not applied — that is what makes it a known positive for the
 * dedupe stage rather than for the category stage.
 */
export function plantsFor(existing: readonly Finding[], batch: string): BatchRow[] {
  const source = existing[0];
  if (source === undefined) return [];
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
      provenance: `PLANT: issue #${source.id} replayed verbatim against a set that still contains it`,
      attempt: attemptOf(source.title, source.body),
      holdOut: null,
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

/** One pass of the whole batch through the deployed adjudicator. */
export async function runBatch(batch: readonly BatchRow[], existing: readonly Finding[]): Promise<RunReading> {
  const withheld: string[] = [];
  const allowed: string[] = [];
  const unmeasured: string[] = [];
  for (const row of batch) {
    const set = row.holdOut === null ? existing : existing.filter(f => f.id !== row.holdOut);
    const v: FilingAdjudication = await adjudicateFiling(row.attempt, async () => set);
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
    const set = row.holdOut === null ? existing : existing.filter(f => f.id !== row.holdOut);
    const v = await adjudicateFiling(row.attempt, async () => set);
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
    const v = await adjudicateFiling(row.attempt, async () => existing);
    const observed = v.outcome === "ALLOW" ? "ALLOW" : `${v.outcome}/${v.refusal}`;
    out.push({ plant: row.key, expected: expected[row.key]!, observed, agreed: observed === expected[row.key] });
  }
  return out;
}

export const PERMANENTLY_UNMEASURED = [
  "There is no deployed agent verifier. `arbitrate` has no caller outside lib/ and test/, and only " +
    "`scripts/arbitrate-finding.ts` can supply `--votes`. The single-AGENT control the quorum is a variance " +
    "control FOR has never been read, and is not read here.",
  "A withheld candidate leaves no trace on either arm. It is never filed, never commented on and never " +
    "fixed, so nothing downstream records whether withholding it was right. `outcomes.ts` derives from commits " +
    "and the reference graph; a candidate that reached neither is invisible to it, permanently.",
  "A finding nobody ever acted on leaves no trace either — the same hole from the other side. There is no " +
    "artefact to read, so this is not a measurement that is merely expensive.",
];

export async function capture(opts: { root: string; runs: number; commit: string }): Promise<VarianceCapture> {
  const batchName = `variance-${opts.commit.slice(0, 12)}`;
  const snapshot = await openFindings(opts.root);
  const measuredAt = new Date().toISOString();

  if (snapshot === null) {
    return {
      kind: "single-adjudicator-variance",
      name: "single-adjudicator-variance",
      pinnedCommit: opts.commit,
      commitAtEnd: opts.commit,
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
        "UNMEASURED: `openFindings` returned null, so the comparison set was never read. A missing token, a " +
        "403, a rate limit and an unreachable API all land here, and none of them is an empty tracker.",
      permanentlyUnmeasured: PERMANENTLY_UNMEASURED,
      arms: [],
    };
  }

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
    if (now === null) break;
    live.push(await runBatch(batch, now));
    if (i === 0) liveDetail = await detailOf(batch, now);
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

  const first = pinned[0];
  const degenerate =
    first === undefined || first.withheld.length === 0 || first.allowed.length === 0;

  return {
    kind: "single-adjudicator-variance",
    name: "single-adjudicator-variance",
    pinnedCommit: opts.commit,
    commitAtEnd: opts.commit,
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
    usable: plantsAgreed === plantDetail.length && plantDetail.length > 0 && !degenerate,
    caveat:
      plantsAgreed !== plantDetail.length
        ? "UNMEASURED: a plant did not land, so this run is not distinguishable from a blind one."
        : degenerate
          ? "UNMEASURED: the withheld set is empty or is the whole batch, so `identical every run` is vacuous."
          : "The pinned arm's zero is zero BY CONSTRUCTION — `adjudicateFiling` is regex plus set arithmetic, " +
            "with no clock, no randomness, no network and no model. Read it as a control establishing that the " +
            "deterministic half contributes no variance, never as evidence that a quorum has nothing to fix. " +
            `And the live arm's zero is bounded by its span (${liveSpan.toFixed(1)}s): M reads taken back to ` +
            "back cannot catch a tracker that moves on the scale of tens of minutes, so `distinctTrackerSets: 1` " +
            "here is a control on the API read and NOT a measurement of tracker drift. Measuring that needs an " +
            "hours-long window, which is a separate capture and was not taken — deliberately, because a window " +
            "that long would likely straddle a merge to `lib/issue-filing-gate.ts` and measure a mixture.",
    permanentlyUnmeasured: PERMANENTLY_UNMEASURED,
    arms: [arm("pinned", pinned, pinnedSpan, pinnedDetail), arm("live", live, liveSpan, liveDetail)],
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runsFlag = argv.indexOf("--runs");
  const runs = runsFlag === -1 ? DEFAULT_RUNS : Number(argv[runsFlag + 1]);
  const root = process.env.RUNGATE_PROJECT_ROOT ?? join(import.meta.dir, "..", "..");
  const { execFileSync } = await import("child_process");
  const rev = (): string => execFileSync("git", ["-C", root, "rev-parse", "origin/main"], { encoding: "utf-8" }).trim();

  const commit = rev();
  const out = await capture({ root, runs, commit });
  out.commitAtEnd = rev();

  if (out.commitAtEnd !== out.pinnedCommit) {
    out.usable = false;
    out.caveat =
      `UNMEASURED: origin/main moved from ${out.pinnedCommit} to ${out.commitAtEnd} during the run, so the M ` +
      "runs may straddle two adjudicators and the artefact would measure a mixture. Re-take it.";
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
