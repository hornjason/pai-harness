/**
 * CRC-N4's suppression gate — the production caller `suppressRepeats` never
 * had (#1586).
 *
 * `lib/ai-review-rounds.ts` has exported `carryKey → suppressRepeats` since
 * #1351 and nothing called either. #1381 shipped the WALKER — the generated
 * `ai-review-carry` step reads the ledger and hands the reviewer the
 * unresolved set — so a repeat became *marked* rather than *dropped*. This is
 * the half that drops it.
 *
 * ## Since AC-1 the prior set is the pull request's review threads
 *
 * The ledger keyed a repeat by `file + cited line text + summary`, which a
 * reformat moves — measured on #1616 as 11 threads for 3 findings. A thread
 * is GitHub's own answer to the same question, so AC-1 moved the gate onto
 * it: `priorKeysFrom` reads the list the carry step fetched and nothing else.
 * The ledger reader is kept as `ledgerPriorKeysFrom`, called by no production
 * path, until AC-5 stops writing the snapshot it parses.
 *
 * ## Why the prior state arrives as a file and not as a fetch
 *
 * Unchanged, and for a sharper reason than before. The generated job runs
 * `ai-review-carry` → the reviewer → `ai-review-run` (this gate) →
 * `ai-review-threads`, **which posts this round's threads**. Fetching here
 * would be safe only because of that ordering, and a gate whose correctness
 * depends on where in a YAML file somebody put a step is a gate one
 * reordering silently breaks: it would read its own threads as prior,
 * suppress the entire payload and report CLEAN forever. The carry step runs
 * before the reviewer, so a list taken there cannot contain this round's
 * work whatever the later order becomes.
 *
 * ## Every refusal suppresses NOTHING
 *
 * There is one direction of error this module is allowed to make. Re-posting
 * an advisory that was already answered is loud, cheap and self-correcting;
 * dropping a finding that is still live is silent and permanent. So a thread
 * list that was never fetched, one that was cut off mid-write, and one that
 * parsed into something that is not a list all produce the same behaviour —
 * report everything — and each produces a DIFFERENT sentence saying so
 * (AC-4), because "nothing was a repeat" and "nothing could be compared" are
 * different facts about this round's report.
 *
 * ## It never sees a blocking finding
 *
 * `findingMustAlwaysBeReported` in `lib/scaffold/ai-review-findings.ts`
 * filters before anything reaches this gate. The exemption is structural, not
 * a rule this module is trusted to follow — see that predicate for the
 * measurement, and for the declared deviation from the spec it rests on.
 */
import { readFileSync } from "fs";
import { isAbsolute, resolve, sep } from "path";

import {
  AI_REVIEW_PRIOR_MEASURED,
  carryKey,
  priorFindings,
  readLedger,
  type ReviewFinding,
} from "./ai-review-rounds";
import { threadReadingFromJson } from "./ai-review-threads";
import {
  AI_REVIEW_CARRY_ABSENT,
  AI_REVIEW_CARRY_READ,
  AI_REVIEW_CARRY_STATE_KEY,
  AI_REVIEW_CARRY_UNMEASURED,
  AI_REVIEW_SNAPSHOT_ROUND_KEY,
} from "./scaffold/ai-review-step";
import type { AiReviewSuppressionGate } from "./scaffold/ai-review-findings";

/** What the gate reads, so a test can drive it without a filesystem. */
export interface SuppressionInputs {
  /**
   * The review-thread list the carry step fetched, or `null` when the file
   * was not there. Since AC-1 this is the ONLY thing the gate decides from —
   * see `priorKeysFrom`.
   */
  threads: string | null;
  /** The text at a finding's cited line NOW, or `undefined`. */
  lineTextFor: (finding: ReviewFinding) => string | undefined;
}

/** A prior set that was established, or the sentence saying it was not. */
export type PriorKeys =
  | { status: "MEASURED"; keys: string[] }
  | { status: "UNMEASURED"; reason: string };

/**
 * The carry file's first line, which is the one site that decided the state.
 *
 * Read rather than re-derived: the walker already made this decision against
 * the live API, and a second reading here would be a second decider over the
 * same question — which is the shape #1568 cost three rounds of #1569.
 */
export function carryStateOf(carry: string | null): string | null {
  if (carry === null) return null;
  const first = carry.split("\n", 1)[0] ?? "";
  const prefix = `${AI_REVIEW_CARRY_STATE_KEY}=`;
  return first.startsWith(prefix) ? first.slice(prefix.length).trim() : null;
}

/**
 * Split the snapshot into the round it precedes and the ledger body.
 *
 * `round` is `null` when the header is missing or not an integer, and that is
 * a REFUSAL rather than a default: a snapshot that cannot say which round it
 * precedes cannot be shown to predate this one.
 */
export function readSnapshot(snapshot: string): { round: number | null; body: string } {
  const at = snapshot.indexOf("\n");
  const head = at === -1 ? snapshot : snapshot.slice(0, at);
  const body = at === -1 ? "" : snapshot.slice(at + 1);
  const prefix = `${AI_REVIEW_SNAPSHOT_ROUND_KEY}=`;
  if (!head.startsWith(prefix)) return { round: null, body };
  const raw = head.slice(prefix.length).trim();
  return { round: /^\d+$/.test(raw) ? Number(raw) : null, body };
}

/**
 * THE PRIOR SET, read from the pull request's own review threads (AC-1).
 *
 * ## Why a thread and not the ledger
 *
 * The ledger answers "was this raised before?" with a text heuristic —
 * `file + the text at the cited line + summary` — and a reformat moves the
 * key, so round 4 cannot tell it is re-raising round 1's finding. Measured on
 * #1616: **11 threads for 3 distinct findings**, re-raised across four rounds
 * while the line numbers moved under them. A thread is the authoritative
 * answer to the same question: the comment is on the pull request, or it is
 * not.
 *
 * ## A RESOLVED thread is still a prior key
 *
 * This is the one place this reader and `carryForwardFromThreads` deliberately
 * disagree, and the difference is the question each is asking:
 *
 * | Reader | Question | Resolved thread |
 * |---|---|---|
 * | this gate | has this already been **raised**? | yes — do not post it twice |
 * | carry-forward | is this still **unanswered**? | no — a human answered it |
 *
 * A gate that treated resolution as "not raised" would re-post a thread the
 * moment someone resolved it, which is the duplicate-per-round failure the
 * whole increment exists to prevent, aimed at the people who are doing the
 * work.
 *
 * ## Self-suppression is prevented by step order, not by a guard
 *
 * The ledger reader needed a provenance header because the ledger is written
 * *during* the job, before the adjudicator reads it. Threads are posted by
 * `ai-review-threads`, which runs AFTER the adjudicator — so no thread this
 * round creates can be in this round's list, and there is nothing for a
 * header to compare against. That property lives in the workflow's step
 * order and is asserted there; see `test/ai-review-suppression.test.ts`.
 *
 * Exported and pure so the battery can drive every refusal without a
 * filesystem, and so there is one place to mutate.
 */
export function priorKeysFrom(threads: string | null): PriorKeys {
  const reading = threadReadingFromJson(threads);
  if (reading.status !== "MEASURED") {
    return { status: "UNMEASURED", reason: reading.reason };
  }
  // Open and resolved alike. The fold that distinguishes them belongs to
  // carry-forward, for the reason tabled above.
  return { status: "MEASURED", keys: reading.threads.map(t => t.key) };
}

/**
 * THE LEDGER READER, dormant since AC-1 and deleted by AC-5.
 *
 * Nothing in production calls this: `aiReviewSuppressionGate` decides from
 * threads. It is kept, and kept under a name that says what it reads, because
 * the carry step still WRITES the snapshot it parses — AC-5 is the increment
 * that stops writing it and removes the steps rather than leaving them
 * dormant, and until then `test/ai-review-carry-forward.test.ts` is the only
 * thing asserting that what bash writes is what a reader can key. A writer
 * whose only reader was deleted is a writer nobody can tell is broken.
 */
export function ledgerPriorKeysFrom(carry: string | null, snapshot: string | null): PriorKeys {
  const state = carryStateOf(carry);
  if (state === null) {
    return {
      status: "UNMEASURED",
      reason:
        "the carry step's own reading could not be read, so whether this pull request has " +
        "earlier rounds is unknown",
    };
  }
  if (state === AI_REVIEW_CARRY_UNMEASURED) {
    return {
      status: "UNMEASURED",
      reason: "the carry step reported that the pull request's history could not be read",
    };
  }
  // A complete reading, and the answer is that there is nothing to compare
  // against. MEASURED with no keys, which is not the same statement as the
  // branch above and must not print the same sentence.
  if (state === AI_REVIEW_CARRY_ABSENT) return { status: "MEASURED", keys: [] };
  if (state !== AI_REVIEW_CARRY_READ) {
    return {
      status: "UNMEASURED",
      reason: `the carry step reported a state this reader does not know (${JSON.stringify(state)})`,
    };
  }

  if (snapshot === null) {
    return {
      status: "UNMEASURED",
      reason:
        "the carry step read the pull request's history and the copy it left for this step " +
        "could not be read",
    };
  }
  const { round, body } = readSnapshot(snapshot);
  if (round === null) {
    return {
      status: "UNMEASURED",
      reason:
        "the history copy does not say which round it precedes, so it cannot be shown to " +
        "predate this round's own findings",
    };
  }

  const reading = priorFindings(readLedger(body));
  if (reading.status !== AI_REVIEW_PRIOR_MEASURED) {
    return { status: "UNMEASURED", reason: reading.reason };
  }

  // THE ORDERING GUARD. A snapshot taken after the persist step is the same
  // comment fetched the same way and is byte-shaped like a correct one; the
  // only tell is that it already holds this round. Without this, the wrong
  // ordering suppresses the entire payload and reports CLEAN every round.
  const stale = reading.prior.filter(p => typeof p.round === "number" && p.round >= round);
  if (stale.length > 0) {
    return {
      status: "UNMEASURED",
      reason:
        `the history copy holds ${stale.length} finding(s) from round ${round} or later, so it ` +
        `was taken AFTER this round was recorded rather than before it. Suppressing against it ` +
        `would drop this round's own findings`,
    };
  }

  // `unmeasuredRounds` and `unkeyableRounds` are deliberately NOT a refusal.
  // Both mean the key set is INCOMPLETE, and an incomplete key set suppresses
  // less than a complete one — the direction this module is allowed to be
  // wrong in. Refusing on them would turn a partially readable history into
  // no history at all, which is the same report with a worse sentence.
  return { status: "MEASURED", keys: reading.keys };
}

/**
 * Build the gate the adjudicator is handed, or `null` when nothing is plumbed.
 *
 * `null` rather than a gate that answers "no repeats": a consumer that has
 * not re-scaffolded gets exactly the reading it had before #1586, and "no
 * repeat reader" is a state that cannot be confused with "the reader found
 * nothing".
 */
export function aiReviewSuppressionGate(inputs: SuppressionInputs): AiReviewSuppressionGate {
  return (candidates: readonly unknown[]) => {
    const prior = priorKeysFrom(inputs.threads);
    if (prior.status === "UNMEASURED") {
      return { repeat: candidates.map(() => null), unmeasured: prior.reason };
    }
    // `suppressRepeats` is not called here, and that is deliberate: it
    // returns partitioned LISTS, and the adjudicator's contract is
    // positional. Re-deriving the position from a list would be a second
    // identity derivation over findings already in order — the fault
    // `AiReviewJuryGate`'s docblock names. `carryKey` is the shared rule and
    // the within-round half is the growing `seen` set, exactly as
    // `suppressRepeats` spells it.
    const seen = new Set<string>(prior.keys);
    const repeat = candidates.map(c => {
      const key = carryKey(c, inputs.lineTextFor(c as ReviewFinding));
      // Unkeyable CARRIES. It cannot be shown to be a repeat, and the
      // direction this is allowed to be wrong in is toward reporting.
      if (key === null) return null;
      if (!seen.has(key)) {
        seen.add(key);
        return null;
      }
      const f = c as ReviewFinding;
      return (
        `${String(f.file ?? "(no file)")}: ${String(f.summary ?? "(no summary)")} — already ` +
        `raised on an earlier round of this pull request, so it is not raised again`
      );
    });
    return { repeat, unmeasured: null };
  };
}

/**
 * THE KEY-SYMMETRY HALF. The text at a finding's cited line, read out of the
 * checkout.
 *
 * `carryKey` anchors on the TEXT of the cited line and falls back to the line
 * NUMBER when no text is supplied — so a caller that supplies nothing is not
 * computing a weaker version of the same key, it is computing keys in a
 * DIFFERENT NAMESPACE from the ledger's. The ledger records `recordedText`
 * and keys `t:<text>`; a text-less caller keys `n:<line>`; the two never
 * collide, so the dedupe silently suppresses nothing and every round looks
 * like a round with no repeats. Measured before this landed: `kept: 1,
 * suppressed: 0` on a planted exact repeat.
 *
 * A line that cannot be read yields `undefined` and the finding falls back to
 * the number anchor — asymmetric again, for that one finding, and therefore
 * reported rather than dropped.
 *
 * `root` bounds it. A payload is written by the reviewer and names its own
 * paths, so `../../etc/passwd` is an input this must handle; `resolve`
 * normalises the `..` away, which is why the containment test is on the
 * RESOLVED path and not on the spelling.
 */
export function checkoutLineText(root: string): (finding: ReviewFinding) => string | undefined {
  const base = resolve(root);
  const cache = new Map<string, string[] | null>();
  return (finding: ReviewFinding) => {
    const file = finding.file;
    const line = finding.line;
    if (typeof file !== "string" || file === "") return undefined;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
    if (isAbsolute(file)) return undefined;
    const path = resolve(base, file);
    if (path !== base && !path.startsWith(base + sep)) return undefined;
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(path, "utf-8").split("\n"));
      } catch {
        cache.set(path, null);
      }
    }
    const lines = cache.get(path) ?? null;
    if (lines === null) return undefined;
    const text = lines[line - 1];
    return typeof text === "string" && text.trim() !== "" ? text : undefined;
  };
}

/**
 * Read a path, or `null`. Absent and unreadable collapse HERE and only here,
 * because the caller's three-state reading comes from the carry file's
 * contents rather than from its presence — and every `null` reaching
 * `priorKeysFrom` produces an UNMEASURED sentence rather than an empty set.
 */
export function readOrNull(path: string | undefined): string | null {
  if (path === undefined || path === "") return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
