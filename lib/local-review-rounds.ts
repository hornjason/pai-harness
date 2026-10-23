/**
 * Bounding the LOCAL review loop (#1342).
 *
 * The loop a person drives: run the local review, relay what it found, the
 * agent pushes a fix, run the local review again. On 2026-10-23 it went five
 * rounds on #1304 and **four of the five pushes were triggered by review
 * output rather than by anything the implementing agent found**. Nothing
 * ended it except the lead noticing, and a lead who is AFK is not a mechanism.
 *
 * ## This module reimplements neither half of what it joins
 *
 * - **Is there a round left in the budget?** `lib/ai-review-rounds.ts`'s
 *   `roundOutcome` already answers that, and already fails closed on a budget
 *   nobody can read. It is called, not restated, so the two cannot be changed
 *   apart and a mutation of its `spent < cap` is observable through here.
 * - **Do two findings describe one symptom?** `lib/finding-arbiter.ts`'s
 *   `duplicateOverlap` already answers that, over a key set tuned on a
 *   40-issue corpus with its false positives listed by number rather than
 *   tuned away. It is called, not restated.
 *
 * What is added is the one thing neither has an opinion about: **when the
 * loop has stopped learning anything.**
 *
 * ## Why a round counter alone is the wrong fix, in the issue's own words
 *
 * "If round N returns a new *class*, that is information worth having and the
 * cap should not eat it. If it returns a variant of a class already resolved,
 * the loop is done."
 *
 * Those are two separate corrections to a counter and they point opposite
 * ways, which is why neither is reachable by moving the cap:
 *
 * - A counter is **too slow**. Rounds 2-5 on #1304 returned variants of one
 *   class — *"the gate reads a different value than `gh`"* — and a counter
 *   with a cap of three happily spends rounds 2 and 3 on them. After the
 *   first pass a repeat tells you about the reviewer, not about the code, so
 *   `SETTLED` is reachable at round 2 here and does not wait for the cap.
 * - A counter is **too blunt**. A round past the cap that raises a class no
 *   earlier round raised is the one case where continuing was right, and a
 *   counter either loops on it forever or throws it away.
 *
 * `AT_CAP` is the answer to the second, and it is deliberately not silence:
 * the reading **carries the new classes out** in `newClasses`. The cap bounds
 * the LOOP, never the INFORMATION — what changes past the cap is that a new
 * class is filed rather than fixed-pushed-and-re-reviewed. That is the same
 * shape `atCapInstruction` takes for the CI reviewer (it keeps speaking, it
 * stops enumerating) and the same shape `record-security-verdict.ts` gives
 * `EXHAUSTED` (its own verdict, because a spent cap is neither a pass nor a
 * finding).
 *
 * ## The one invariant that keeps the two mechanisms from fighting
 *
 * **The class rule can only ever end the loop SOONER. It never outlives the
 * cap.** A round full of findings too thin to key is all-new by construction —
 * that is `suppressRepeats`'s direction-of-error rule, kept here — so without
 * this invariant an unkeyable reviewer would loop forever. `AC-LR6` in
 * `test/local-review-rounds.test.ts` walks eight rounds of brand-new classes,
 * the most favourable input the class rule has, and the cap still stops it.
 */

import {
  AI_REVIEW_ROUND_AT_CAP,
  AI_REVIEW_ROUND_CAP,
  AI_REVIEW_ROUNDS_UNMEASURED,
  roundOutcome,
} from "./ai-review-rounds.ts";
import { duplicateOverlap, UNFILED_ID, type Finding } from "./finding-arbiter.ts";
import { ghRepoTarget } from "./issue-filing-gate.ts";
import { homedir } from "os";
import { join } from "path";

/** Another round is worth spending: this one raised something new. */
export const LOCAL_REVIEW_CONTINUE = "LOCAL_REVIEW_CONTINUE";

/**
 * The loop is done because it converged, at whatever round that happened.
 *
 * Either the review raised nothing, or everything it raised is a restatement
 * of a class an earlier round already raised.
 */
export const LOCAL_REVIEW_SETTLED = "LOCAL_REVIEW_SETTLED";

/**
 * The loop is done because the budget is spent, and it had not converged.
 *
 * Kept apart from `SETTLED` rather than folded into it, for the reason
 * `roundOutcome` keeps `REVIEW_CURRENT` apart from exhaustion: the two mean
 * opposite things, and a reading that collapsed them would report every
 * converged loop as a truncated one and every truncated one as converged.
 */
export const LOCAL_REVIEW_AT_CAP = "LOCAL_REVIEW_AT_CAP";

/**
 * The rounds could not be read, so this is not a reading.
 *
 * A REFUSAL and not a warning, on `roundOutcome`'s own reasoning: a history
 * nobody can read makes round 12 indistinguishable from round 1, and reading
 * it as round 1 resets the bound on every call — a cap that can never be
 * reached. `runAnotherRound` says no to it, so an unreadable history stops
 * the loop rather than licensing it.
 */
export const LOCAL_REVIEW_UNMEASURED = "LOCAL_REVIEW_UNMEASURED";

export type LocalRoundDecision =
  | typeof LOCAL_REVIEW_CONTINUE
  | typeof LOCAL_REVIEW_SETTLED
  | typeof LOCAL_REVIEW_AT_CAP
  | typeof LOCAL_REVIEW_UNMEASURED;

export interface RepeatedFinding {
  /** The finding this round raised. */
  finding: Finding;
  /** The earlier finding it restates. */
  of: Finding;
  /** The symptom keys the two share, so the suppression is reviewable. */
  keys: string[];
}

export interface LocalRoundReading {
  decision: LocalRoundDecision;
  /** The round the reading is about, or null when the history was unreadable. */
  round: number | null;
  /**
   * Findings this round raised that no earlier round did.
   *
   * **Populated on `AT_CAP` too.** That is the point of the verdict: the loop
   * ends and the classes do not.
   */
  newClasses: Finding[];
  /** Findings this round raised that an earlier one already had. */
  repeats: RepeatedFinding[];
  /** Why this is not an ordinary CONTINUE. Never empty. */
  reason: string;
}

/** A round of the loop, as the caller records it. */
export interface LocalRound {
  findings: Finding[];
  [k: string]: unknown;
}

/**
 * Read one finding, or say why it could not be read.
 *
 * `title` and `body` must BOTH be strings. `symptomKeys` reads them and
 * nothing else, so a finding missing either is a finding whose class is
 * partly unobservable — and a key formed from half the evidence does not
 * fail, it silently compares two different things.
 *
 * A missing `id` becomes `UNFILED_ID`. The id is only ever used by
 * `duplicateOverlap`'s cross-citation escape, which needs a digit string to
 * fire at all, so an absent one costs nothing and refusing it would reject
 * every reviewer payload that does not file issues.
 */
function readFinding(raw: unknown, where: string): Finding | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${where} is ${describe(raw)} rather than a finding object`;
  }
  const f = raw as Record<string, unknown>;
  const id = typeof f.id === "string" ? f.id : UNFILED_ID;

  // The arbiter's own shape, when a caller already has one.
  if (typeof f.title === "string" && typeof f.body === "string") {
    return { id, title: f.title, body: f.body };
  }

  // THE SHAPE A REAL REVIEWER WRITES, and the one this module existed
  // without reading for two pushes. `AI_REVIEW_FINDING_FIELDS` is
  // `{severity, file, line, summary, failure_scenario}` — no `title` and no
  // `body` — so a reader that accepts only the arbiter's shape refuses every
  // genuine payload, on every round, and the mechanism is unreachable on
  // real input while every test of it passes. A caller that exists and can
  // never be fed is the same defect as no caller at all, one level in.
  //
  // `summary` is the title because it is the one sentence stating the
  // defect, which is what `symptomKeys` reads a title for. The body is
  // SYNTHESISED rather than taken from one field, and the two halves are
  // load-bearing on different inputs — measured, because the first draft of
  // this comment claimed both were load-bearing everywhere and half of that
  // was false:
  //
  //   * dropping `failure_scenario` reddens the ordinary rows at once. It
  //     carries the measured integers, and `sameSymptom` needs two shared
  //     quantities before anything else matters.
  //   * dropping the bare `file` path reddens NOTHING on findings whose
  //     prose shares backticked symbols — those already supply the one
  //     location key the rule asks for. It is load-bearing only for a pair
  //     of plain-prose findings naming no symbols, where the `file:` key
  //     `pathsIn` extracts is the only location key there is. `AC-LL12` is
  //     that pair, and it exists because without it this half of the
  //     synthesis was unfalsifiable.
  //
  // Either way the failure mode is the same and it looks like success: the
  // loop still runs, it just stops settling, two rounds later.
  if (typeof f.summary === "string") {
    const file = typeof f.file === "string" ? f.file : "";
    const scenario = typeof f.failure_scenario === "string" ? f.failure_scenario : "";
    return { id, title: f.summary, body: `${f.summary}\n\n${scenario}\n\n${file}` };
  }

  return (
    `${where} carries neither shape this reader knows: no \`summary\` (the reviewer ` +
    `contract's) and no \`title\`/\`body\` pair (the arbiter's). A finding naming no defect ` +
    `cannot be compared against anything, and recording it as a round that found nothing ` +
    `would clear the loop on an unread finding`
  );
}

/** Read the whole history, or say why it could not be read. */
function readRounds(raw: unknown): LocalRound[] | string {
  if (!Array.isArray(raw)) {
    return (
      `the review history is ${describe(raw)} rather than an array of rounds, so this call ` +
      `cannot tell a first review from a twelfth`
    );
  }
  if (raw.length === 0) {
    return (
      `the review history holds no rounds at all. A decision about "this round" needs the ` +
      `round it is about, and an empty history is the absence of one rather than a reading ` +
      `that the loop has settled`
    );
  }
  const out: LocalRound[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `round ${i + 1} is ${describe(entry)} rather than a round object`;
    }
    const list = (entry as Record<string, unknown>).findings;
    if (!Array.isArray(list)) {
      // Counted as unreadable rather than as a round that found nothing. The
      // two are the same shape downstream and only one of them is a reading:
      // `toLedgerRound` makes the same distinction for the CI ledger, and for
      // the same reason — a round that vanishes makes a five-round loop look
      // like a four-round one.
      return (
        `round ${i + 1} records its findings as ${describe(list)} rather than an array, so ` +
        `whether that round raised anything is unknown — which is not the same fact as its ` +
        `having raised nothing`
      );
    }
    const findings: Finding[] = [];
    for (let j = 0; j < list.length; j++) {
      const read = readFinding(list[j], `round ${i + 1}, finding ${j + 1},`);
      if (typeof read === "string") return read;
      findings.push(read);
    }
    out.push({ ...(entry as Record<string, unknown>), findings });
  }
  return out;
}

function unmeasured(reason: string): LocalRoundReading {
  return { decision: LOCAL_REVIEW_UNMEASURED, round: null, newClasses: [], repeats: [], reason };
}

/**
 * Should the loop spend another round?
 *
 * `rounds` is every round so far, oldest first, the one just returned
 * included; the reading is about the last entry. It is a PARAMETER and not
 * something fetched here, deliberately: a function that fetches its own
 * evidence cannot be given a negative control.
 */
export function localRoundReading(
  rounds: unknown,
  cap: unknown = AI_REVIEW_ROUND_CAP,
): LocalRoundReading {
  const read = readRounds(rounds);
  if (typeof read === "string") return unmeasured(read);

  const n = read.length;
  const latest = read[n - 1].findings;
  const budget = roundOutcome(n, cap);

  // n is this array's length, so it is always a positive integer and this
  // branch is unreachable today. Checked anyway rather than assumed: if the
  // round number ever stops being derived from the array, an unreadable one
  // must refuse here and not fall through to a CONTINUE.
  if (budget.decision === AI_REVIEW_ROUNDS_UNMEASURED) {
    return unmeasured(budget.reason ?? "the round budget could not be read");
  }

  if (latest.length === 0) {
    return {
      decision: LOCAL_REVIEW_SETTLED,
      round: n,
      newClasses: [],
      repeats: [],
      reason: `review round ${n} raised nothing, so there is nothing left for a round ${n + 1} to be about`,
    };
  }

  // Everything any earlier round raised, plus the classes already accepted as
  // new WITHIN this round — a reviewer listing one defect twice in one payload
  // is the same waste as one listing it on two rounds, and only the first
  // occurrence is a new class.
  const seen: Finding[] = read.slice(0, n - 1).flatMap(r => r.findings);
  const newClasses: Finding[] = [];
  const repeats: RepeatedFinding[] = [];

  for (const finding of latest) {
    let matched: RepeatedFinding | null = null;
    for (const prior of seen) {
      const overlap = duplicateOverlap(finding, prior);
      if (overlap.duplicate) {
        matched = { finding, of: prior, keys: overlap.keys };
        break;
      }
    }
    if (matched) {
      repeats.push(matched);
      continue;
    }
    newClasses.push(finding);
    seen.push(finding);
  }

  // Checked BEFORE the cap. Both end the loop, and a round that converged is
  // a different fact from one that was cut off — see LOCAL_REVIEW_AT_CAP.
  if (newClasses.length === 0) {
    return {
      decision: LOCAL_REVIEW_SETTLED,
      round: n,
      newClasses,
      repeats,
      reason:
        `every one of the ${repeats.length} finding(s) review round ${n} raised restates a ` +
        `class an earlier round already raised, so this round is evidence about the reviewer ` +
        `rather than about the code and the loop is done`,
    };
  }

  if (budget.decision === AI_REVIEW_ROUND_AT_CAP) {
    return {
      decision: LOCAL_REVIEW_AT_CAP,
      round: n,
      newClasses,
      repeats,
      reason:
        `review round ${n} raised ${newClasses.length} class(es) no earlier round raised, and ` +
        `the round budget is spent (${budget.reason ?? "no rounds left"}). The loop ends here ` +
        `and the classes do not: file them, rather than fixing and re-reviewing. A cap that ` +
        `ate a new class would truncate the one case where continuing was right`,
    };
  }

  return {
    decision: LOCAL_REVIEW_CONTINUE,
    round: n,
    newClasses,
    repeats,
    reason:
      `review round ${n} raised ${newClasses.length} class(es) no earlier round raised` +
      (repeats.length > 0 ? `, and ${repeats.length} restatement(s) of earlier ones` : "") +
      `, so another round is worth spending`,
  };
}

/* ───────────────────────── the history the loop keeps ─────────────────────
 *
 * #1342 shipped the decision above and no caller, which is the shape #1381 is
 * open about one subsystem over: a decision function nobody calls is
 * indistinguishable from one that works. This is the half that makes the
 * rounds exist.
 *
 * ## Why this is a local file and not the ai-review ledger comment
 *
 * The CI ledger (`AI_REVIEW_LEDGER_COMMENT_MARKER`) was the obvious store and
 * is the wrong one, for a reason that is about the budget rather than about
 * convenience. **A CI round and a local round are not the same round.** They
 * read the same tree with different instruments, and a shared counter means
 * CI rounds spend the local reviewer's budget — silencing the local loop for
 * rounds it did not cause. Separate stores is the statement that they are
 * separate budgets, and it is a decision rather than an omission.
 *
 * Two consequences worth knowing. The local history never leaves the machine
 * that drove the loop, which is correct for a loop a local plugin drives and
 * useless to anyone else. And it does not survive a cleaned work directory,
 * which reads as ABSENT — round 1 — rather than as a refusal, because a store
 * that is genuinely not there is a measured absence.
 */

/** No history file. A MEASURED reading of nothing: this is round 1. */
export const LOCAL_HISTORY_ABSENT = "LOCAL_HISTORY_ABSENT";

/**
 * A history is there and could not be read. NOT the same as absent.
 *
 * `lib/config-loader.ts` makes this distinction about an absent config versus
 * a corrupt one, `readLedger` makes it about the CI ledger, and it matters
 * most here: a corrupt history read as empty restarts the count at 1 on every
 * turn, which is a cap that can never be reached. That is `roundOutcome`'s
 * unreadable-budget fail-open arriving through a different door.
 */
export const LOCAL_HISTORY_UNREADABLE = "LOCAL_HISTORY_UNREADABLE";

/** The history was read. */
export const LOCAL_HISTORY_READ = "LOCAL_HISTORY_READ";

export type HistoryReading =
  | { status: typeof LOCAL_HISTORY_ABSENT }
  | { status: typeof LOCAL_HISTORY_UNREADABLE; reason: string }
  | { status: typeof LOCAL_HISTORY_READ; rounds: unknown[] };

/**
 * Parse a history file's contents. `null` means the file is not there.
 *
 * **An empty file is UNREADABLE, not absent.** It is the one case where the
 * two genuinely look alike, and it is the signature of a write that was
 * interrupted — a file that exists holding nothing is a file something was
 * writing. Treating it as round 1 discards however many rounds it held.
 */
export function parseHistory(raw: string | null): HistoryReading {
  if (raw === null) return { status: LOCAL_HISTORY_ABSENT };
  if (raw.trim() === "") {
    return {
      status: LOCAL_HISTORY_UNREADABLE,
      reason:
        `the review history file exists and is empty, which is a write that did not finish ` +
        `rather than a loop that has not started — it is not being read as round 1`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      status: LOCAL_HISTORY_UNREADABLE,
      reason:
        `the review history could not be parsed (${e instanceof Error ? e.message : String(e)}), ` +
        `so how many rounds this loop has already spent is unknown`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      status: LOCAL_HISTORY_UNREADABLE,
      reason:
        `the review history is ${describe(parsed)} rather than an array of rounds, so how ` +
        `many rounds this loop has already spent is unknown`,
    };
  }
  return { status: LOCAL_HISTORY_READ, rounds: parsed };
}

/** One round, as the history records it. */
export interface RecordedRound {
  /** When the round happened. */
  at: string;
  findings: unknown[];
}

/**
 * The history with this round appended, or the reason it may not be.
 *
 * **An UNREADABLE history refuses rather than being replaced.** Starting a
 * fresh array over one is the cheapest repair and the worst: it destroys the
 * only evidence of how many rounds had already happened, at exactly the
 * moment nothing can tell that it did — and it does so silently, every turn,
 * so the loop that most needs the bound is the one that loses it.
 */
export function appendRound(
  reading: HistoryReading,
  findings: unknown[],
  at: string,
): { rounds: unknown[] } | { refusal: string } {
  if (reading.status === LOCAL_HISTORY_UNREADABLE) return { refusal: reading.reason };
  const prior = reading.status === LOCAL_HISTORY_READ ? reading.rounds : [];
  const round: RecordedRound = { at, findings };
  return { rounds: [...prior, round] };
}

/**
 * Where a pull request's local-round history lives.
 *
 * `RUNGATE_LOCAL_REVIEW_HISTORY` overrides the directory outright, and every
 * test sets it. That is not only for isolation: anything sitting at the
 * default path was put there by a real loop on this machine, so a test that
 * wrote to it would become indistinguishable from data.
 *
 * Returns null for a repo that is not an `owner/name` — `ghRepoTarget` is the
 * one binding for that question and is not restated here. Null is a refusal
 * at the caller; it is never silently replaced with the working directory's
 * slug, which would file one pull request's rounds under another's.
 */
export function localHistoryPath(repo: string, pr: unknown): string | null {
  const slug = ghRepoTarget(repo);
  if (slug === null) return null;
  const n = typeof pr === "number" ? pr : typeof pr === "string" && /^[0-9]+$/.test(pr.trim()) ? Number.parseInt(pr.trim(), 10) : null;
  if (n === null || !Number.isSafeInteger(n) || n < 1) return null;
  const base =
    process.env.RUNGATE_LOCAL_REVIEW_HISTORY ||
    process.env.RUNGATE_WORK_DIR ||
    process.env.PAI_WORK_DIR ||
    join(homedir(), ".rungate");
  return join(base, "local-review", slug.replace("/", "__"), `pr-${n}.json`);
}

/**
 * May the loop run another round?
 *
 * The ONE binding for that question, so the CLI's exit code and any other
 * caller cannot drift apart. Only `CONTINUE` is a yes — `UNMEASURED` is a no,
 * because a history nobody could read is not a budget with room left in it.
 */
export function runAnotherRound(reading: LocalRoundReading): boolean {
  return reading.decision === LOCAL_REVIEW_CONTINUE;
}

/** One line for a human watching the loop. */
export function summarise(reading: LocalRoundReading): string {
  const where = reading.round === null ? "round unknown" : `round ${reading.round}`;
  return `${reading.decision} (${where}) — ${reading.reason}`;
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return "an object";
  return JSON.stringify(v);
}
