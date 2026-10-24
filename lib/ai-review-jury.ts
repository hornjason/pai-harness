/**
 * The verifier quorum, in front of the findings that would otherwise BLOCK
 * (#1476, CRC-B4).
 *
 * ## What was missing, and it was not the arithmetic
 *
 * `lib/finding-jury.ts` has held the group size, the quorum, the per-verifier
 * ballot and the disagreement flag since #1187, and #1468 typed the ledger
 * row's `jury` field so a row could hold a reading. Neither put a vote in
 * front of anything. `arbitrate` had exactly one caller in the whole tree and
 * it was `scripts/arbitrate-finding.ts`, hand-run. The spec's own entry said
 * it: *nothing deployed takes a vote*.
 *
 * This is the deployed caller. It sits in the path
 * `bunx rungate ai-review-findings` runs on every scaffolded project's
 * pull request, between the reviewer's payload and the blocking decision.
 *
 * ## Why here and not at the filing chokepoint
 *
 * `hooks/VerifyPhaseLock.hook.ts` → `filingGate` → `adjudicateFiling` is the
 * other place a finding is adjudicated, and it is the wrong one. It is a
 * PreToolUse hook: no verifier group, no network budget, no changed-file
 * list, no branch. Convening a quorum there would INTRODUCE variance rather
 * than reduce it — the deployed adjudicator is a regex over the title plus
 * set arithmetic over symptom keys, with no clock, no model and no network,
 * so twenty runs report one distinct outcome set and zero variance **by
 * construction**. A variance control over it reads zero whether or not it
 * works, and that reading is the signature of the failure mode rather than
 * evidence of success.
 *
 * A false blocking finding on `ai-review`, by contrast, costs a remedy
 * commit, a CI round, a review round and an agent's whole context. Every
 * measured instance of the reviewer disagreeing with itself on a held-fixed
 * tree has had the false positive on the blocking side — four of them, in
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`. That is the cost this group is
 * spent against.
 *
 * ## Four properties, and each is a case in `test/ai-review-jury-gate.test.ts`
 *
 * 1. **Only findings that would otherwise block are voted on.** The caller
 *    hands in `blockingReported` — the output of the one decider that already
 *    answers "does this block" — so this never re-derives it. A quorum over
 *    the advisory tail would spend a full agent context per nit.
 * 2. **Every vote and the disagreement flag reach the ledger at decision
 *    time**, for the withheld findings as much as the surfaced ones. The
 *    withheld row is the one that cannot be reconstructed later: it is never
 *    commented on, never fixed and never filed, so it enters no downstream
 *    record at all. Re-running to recover it re-samples the thing being
 *    measured, because a verifier is a sampled instrument and the second
 *    ballot is a second draw.
 * 3. **A group that could not be convened is UNMEASURED, and the finding
 *    keeps blocking.** "Did not reach a quorum" and "did not have one" are
 *    different facts with different fixes, and only the first is a decision.
 *    The direction this is allowed to be wrong in is toward blocking.
 * 4. **A ballot source that was named and could not be read fails the run.**
 *    Not an empty ballot set, which would withhold nothing and look exactly
 *    like a group that unanimously agreed with every finding.
 *
 * ## What this does NOT do
 *
 * It does not convene the group. Spawning verifiers is the orchestrator's
 * job and `lib/finding-jury.ts`'s header says why: a library that spawned
 * them could not be tested without a model in the loop. The generated
 * `ai-review` workflow writes the ballot; this counts it.
 *
 * Nor can it see whether the verifiers were independent. Three agent runs
 * behind three ids look exactly like three agents from in here.
 */

import { readFileSync } from "fs";

import { symptomHash, UNFILED_ID, type ArbiterRefusal, type Finding } from "./finding-arbiter";
import {
  classifyCategory,
  juryCategory,
  juryReading,
  parseVotes,
  severityOf,
  type JuryReading,
  type VerifierVote,
} from "./finding-jury";
import { filingBatch, recordAdjudication, type FilingLedgerRow } from "./issue-filing-gate";
import {
  AI_REVIEW_FINDING_FIELDS,
  AI_REVIEW_JURY_NOTICE_TITLE,
  advisoryKey,
} from "./scaffold/ai-review-findings";

/**
 * The key the ballot payload hangs its per-finding votes off.
 *
 * One exported constant, named by the reader here and by the prompt that
 * asks a verifier group to write the file, so the two cannot drift. #295 is
 * the measured instance of what drift costs: a reader asked for a key no
 * writer ever produced, the list was empty on every run, and an absent key
 * read as an empty list read as clean.
 */
export const AI_REVIEW_BALLOT_KEY = "ballots";

/**
 * The annotation title the jury's own reading is printed under.
 *
 * Declared in `./scaffold/ai-review-findings` beside the `console.log` that
 * emits it and re-exported here, never re-declared. A title spelled in two
 * places is two contracts, and nothing fails to compile when they diverge —
 * #295, in the module next door.
 */
export const AI_REVIEW_JURY_TITLE = AI_REVIEW_JURY_NOTICE_TITLE;

/** What a finding nobody voted on is called. One string, one binding. */
export const NO_GROUP_CONVENED = "no verifier group was convened for this finding";

/** Opens every refusal of the ballot source itself, so a caller can match it. */
export const BALLOT_UNREADABLE_PREFIX = "the verifier ballot could not be read";

/** Per-finding ballots, as the payload declares them. Values are unvalidated. */
export type BallotSet = Record<string, unknown>;

export interface BallotReading {
  /** `null` when the source could not be read. Never an empty set standing in. */
  ballots: BallotSet | null;
  /** The sentence naming what went wrong, or `null`. */
  unreadable: string | null;
}

/**
 * Read the ballot payload, or refuse it.
 *
 * **An unreadable source is never an empty ballot set.** They differ in the
 * direction that matters: an empty set withholds nothing, which is
 * indistinguishable from a group that unanimously upheld every finding, and
 * a run reporting that about a file it never parsed is the Silent Default
 * Substitution `.claude/rules/config-access.md` forbids.
 *
 * The entries are NOT validated here. `parseVotes` owns that boundary and is
 * the only thing in the tree that reads an untrusted vote — a second reader
 * agreeing with it would be two deciders over one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape), and a
 * malformed entry refuses ONE finding's ballot rather than the whole file.
 */
export function readBallots(raw: string | null): BallotReading {
  if (raw === null) {
    return { ballots: null, unreadable: `${BALLOT_UNREADABLE_PREFIX}: no ballot payload was produced` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ballots: null, unreadable: `${BALLOT_UNREADABLE_PREFIX}: it is not JSON (${(e as Error).message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ballots: null,
      unreadable: `${BALLOT_UNREADABLE_PREFIX}: the payload is ${
        Array.isArray(doc) ? "an array" : String(doc)
      }, not an object`,
    };
  }
  const obj = doc as Record<string, unknown>;
  if (!(AI_REVIEW_BALLOT_KEY in obj)) {
    return {
      ballots: null,
      unreadable:
        `${BALLOT_UNREADABLE_PREFIX}: it carries no '${AI_REVIEW_BALLOT_KEY}' key ` +
        `(it carries ${Object.keys(obj).join(", ") || "no keys at all"}). An absent key is not ` +
        `an empty ballot set, and an empty ballot set is not a group that agreed with everything`,
    };
  }
  const set = obj[AI_REVIEW_BALLOT_KEY];
  if (set === null || typeof set !== "object" || Array.isArray(set)) {
    return {
      ballots: null,
      unreadable:
        `${BALLOT_UNREADABLE_PREFIX}: '${AI_REVIEW_BALLOT_KEY}' is ${
          Array.isArray(set) ? "an array" : String(set)
        }, not an object keyed by finding`,
    };
  }
  return { ballots: set as BallotSet, unreadable: null };
}

export interface JuryGateVerdict {
  /** The finding's identity, as `advisoryKey` computes it. */
  key: string;
  /** The finding's own one-sentence summary, so a ledger row is readable. */
  title: string;
  /** The reading, or `null` when no group was convened for this finding. */
  reading: JuryReading | null;
  /** `true` when the finding keeps blocking. UNMEASURED is `true`. */
  surfaced: boolean;
  /** Why, in words a reader can act on without re-running anything. */
  reason: string;
  /** The refusal recorded on the ledger row, or `null` when it survived. */
  refusal: ArbiterRefusal | null;
}

export interface JuryGateResult {
  /**
   * The findings the group voted down, by key, each with the sentence saying
   * so. A map rather than a list because the reading that consumes it prints
   * the reason beside the finding, and a parallel array is a join nobody
   * maintains.
   */
  withheld: Record<string, string>;
  verdicts: JuryGateVerdict[];
  /** One sentence per finding voted on, for the annotation. */
  detail: string[];
}

/** The `Finding` shape the arbiter's identity and category functions want. */
function asFinding(item: Record<string, unknown>): Finding {
  const f = AI_REVIEW_FINDING_FIELDS;
  const where = item[f.file] !== undefined ? `${String(item[f.file])}:${String(item[f.line] ?? "?")}` : "";
  return {
    id: UNFILED_ID,
    title: String(item[f.summary] ?? ""),
    body: [where, String(item[f.failureScenario] ?? "")].filter(Boolean).join(" — "),
  };
}

/**
 * Count the group's votes on each finding that would otherwise block.
 *
 * `ballots` is `null` for "no ballot set was supplied", under which every
 * finding reads as NO_GROUP_CONVENED and keeps blocking. That is the same
 * answer an empty set gives and it is reached by a different route, which is
 * why both are a per-finding UNMEASURED rather than a single verdict about
 * the run: a ballot set can legitimately cover some findings and not others,
 * and collapsing that to one reading would lose which.
 *
 * **No case passes a `groupSize` or a `quorum`.** The defaults are what the
 * deployed path uses, so a mutation of `VERIFIER_GROUP_SIZE` reaches every
 * case in the suite — which is the degenerate control
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` asks for. A gate whose fixtures
 * declare their own cardinality is green with a group of one.
 */
export function juryGate(
  blocking: readonly unknown[],
  ballots: BallotSet | null,
): JuryGateResult {
  const withheld: Record<string, string> = {};
  const verdicts: JuryGateVerdict[] = [];
  const detail: string[] = [];

  for (const item of blocking) {
    const finding =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const key = advisoryKey(finding);
    const title = String(finding[AI_REVIEW_FINDING_FIELDS.summary] ?? "");
    const cast = ballots === null ? undefined : ballots[key];

    if (cast === undefined) {
      const reason =
        `${NO_GROUP_CONVENED} [key ${key}]. It keeps blocking: a group that did not meet ` +
        `is UNMEASURED, which is neither a quorum of zero nor a pass`;
      verdicts.push({ key, title, reading: null, surfaced: true, reason, refusal: "UNMEASURED" });
      detail.push(reason);
      continue;
    }

    let votes: readonly VerifierVote[];
    try {
      votes = parseVotes(cast);
    } catch (e) {
      const reason =
        `the verifier ballot [key ${key}] could not be read, so no vote was counted on it: ` +
        `${(e as Error).message}. It keeps blocking`;
      verdicts.push({ key, title, reading: null, surfaced: true, reason, refusal: "UNMEASURED" });
      detail.push(reason);
      continue;
    }

    const reading = juryReading(votes);
    if (reading.reading === "UNMEASURED") {
      const reason =
        `the verifier group [key ${key}] did not produce a countable ballot: ` +
        `${reading.unmeasuredReasons.join("; ")}. It keeps blocking`;
      verdicts.push({ key, title, reading, surfaced: true, reason, refusal: "UNMEASURED" });
      detail.push(reason);
      continue;
    }
    if (!reading.passed) {
      const reason =
        `${reading.agree} of ${reading.votes} verifiers called it real and the quorum is ` +
        `${reading.quorum}, so it is withheld [key ${key}]. It is still reported below and ` +
        `blocks nothing`;
      withheld[key] = reason;
      verdicts.push({ key, title, reading, surfaced: false, reason, refusal: "NO_QUORUM" });
      detail.push(reason);
      continue;
    }
    const reason =
      `${reading.agree} of ${reading.votes} verifiers called it real, quorum ${reading.quorum}` +
      `${reading.disagreed ? " (the group disagreed)" : ""}, so it blocks [key ${key}]`;
    verdicts.push({ key, title, reading, surfaced: true, reason, refusal: null });
    detail.push(reason);
  }

  return { withheld, verdicts, detail };
}

/**
 * One adjudication, as a ledger row.
 *
 * **One site, and it is the whole of the recording**, so a mutant that
 * neutralises `jury` here neutralises the thing under test and nothing else —
 * the same property `scripts/arbitrate-finding.ts`'s `ledgerRow` holds and
 * for the same reason.
 *
 * `FilingLedgerRow` and not a new shape. The value of the row populations —
 * the chokepoint's, the hand-run arbiter's and this one's — is the corpus
 * they form together, and a second vocabulary for `category` / `refusal` /
 * `withheldBy` would make that union a join nobody can write.
 *
 * Written for a withheld finding as well as a surfaced one, and that is the
 * criterion rather than a detail. The cheapest wrong version records what it
 * surfaces, which satisfies every row a reader goes looking for and leaves
 * the withheld population exactly as unrecoverable as it was.
 */
export function juryLedgerRow(
  item: unknown,
  verdict: JuryGateVerdict,
  at: string,
  index: number,
): FilingLedgerRow {
  const finding = asFinding(
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {},
  );
  const votes = verdict.reading?.ballot ?? [];
  const batch = filingBatch(at);
  const emitted = verdict.surfaced;
  return {
    at,
    key: batch === null ? null : `${batch}/${index}`,
    id: UNFILED_ID,
    title: verdict.title,
    symptomHash: symptomHash(finding),
    category: votes.length > 0 ? juryCategory(finding, votes) : classifyCategory(finding),
    // The payload's severity vocabulary — critical / high / medium / low /
    // info — is a different axis from `Severity`, so it is NOT mapped onto
    // one. Only a verifier's own tag fills this, and `null` is the honest
    // answer when none carried one.
    severity: severityOf(finding, votes),
    disposition: emitted ? "COMMENT" : "DROP",
    refusal: verdict.refusal,
    emitted,
    withheldBy: emitted ? null : (verdict.refusal ?? "UNACCOUNTED"),
    jury: verdict.reading,
    duplicateOf: [],
    // No override exists on this path. `arbiter-override` is a
    // `gh issue create` label the chokepoint reads, and nothing here has one.
    overridden: false,
  };
}

/** What the adjudicator's `main` consumes. Plain data, so it can be injected. */
export interface JuryGateOutcome {
  withheld: Record<string, string>;
  unreadable: string | null;
  detail: string[];
}

/**
 * The deployed gate: read the ballot, count it, record it, report it.
 *
 * Injected into `main` rather than imported by it. `lib/scaffold/
 * ai-review-findings.ts` is copied into a scratch directory by three mutation
 * batteries, which carry its one relative dependency with it; an import of
 * this module would drag `lib/issue-filing-gate.ts` and its whole tree behind
 * it and the mutants would die on module resolution — a failure that reads
 * identically to a guard behaving differently
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row).
 *
 * The seam is not a loophole. `main` refuses a ballot path with no gate
 * wired, as UNMEASURED, so the two entry points cannot diverge into one that
 * silently ignores the ballot and passes.
 *
 * **A ledger that cannot be written does not change the verdict.** The record
 * exists to measure the gate, and a measurement apparatus that blocks the
 * thing it measures is worse than no measurement — the same policy
 * `recordAdjudication` states. It is said out loud in `detail` instead.
 */
export function aiReviewJuryGate(blocking: readonly unknown[], ballotPath: string): JuryGateOutcome {
  let raw: string | null = null;
  try {
    raw = readFileSync(ballotPath, "utf-8");
  } catch (e) {
    return {
      withheld: {},
      unreadable:
        `${BALLOT_UNREADABLE_PREFIX} at ${ballotPath}: ${(e as Error).message}. A ballot this ` +
        `run was told to read and could not is a reading that failed, not a group that upheld ` +
        `every finding`,
      detail: [],
    };
  }

  const source = readBallots(raw);
  if (source.ballots === null) {
    return { withheld: {}, unreadable: source.unreadable, detail: [] };
  }

  const result = juryGate(blocking, source.ballots);
  const at = new Date().toISOString();
  const detail = [...result.detail];
  let unwritten = 0;
  result.verdicts.forEach((verdict, index) => {
    if (!recordAdjudication(juryLedgerRow(blocking[index], verdict, at, index))) unwritten += 1;
  });
  if (unwritten > 0) {
    detail.push(
      `${unwritten} of ${result.verdicts.length} verifier ballots could not be appended to the ` +
        `finding ledger, so those votes are UNMEASURED for every later threshold. The verdict ` +
        `above stands: a record that cannot be written must not change what it records`,
    );
  }
  return { withheld: result.withheld, unreadable: null, detail };
}
