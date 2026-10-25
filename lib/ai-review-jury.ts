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
 * pull request, beside the blocking decision.
 *
 * ## IT RECORDS. IT DOES NOT SUBTRACT. (read this before the rest)
 *
 * CRC-B4 has two halves — *"a separate group of agents votes on each
 * finding"*, and *"it is surfaced only if enough agree it is real"*. This
 * ships the first and deliberately not the second, and the reason is not
 * caution, it is that the second is **unsafe until two other things are
 * true**:
 *
 *  - **Independence has to be structural, not textual.** The review action
 *    runs with `AI_REVIEW_ALLOWED_TOOLS` = `Read,Grep,Glob,Write` and
 *    `AI_REVIEW_DENY_RULES` denying `Task`. An instruction to spawn three
 *    verifier subagents therefore cannot execute, and what comes back is
 *    one model, in one context, emitting three votes. That ballot is
 *    populated, plausible, well-formed and worth nothing — it is the
 *    counterfeit the criterion names, reached by a prompt that could not
 *    run. So the group is `VERIFIER_GROUP_SIZE` SEPARATE action
 *    invocations, each writing its own file, merged here: independence is a
 *    property of the generated workflow rather than of a sentence.
 *  - **The verifier reads the head checkout.** A ballot that subtracted
 *    from the blocking set would make the branch under review an input to
 *    the gate on the branch under review: an author who can write code
 *    could write code that argues itself clean. Fixing that means reading
 *    the cited file at the base ref, which is not built.
 *
 * The half that is shipped is the half that is **permanently lost if it is
 * not done now**: the criterion's own words are *"without them every
 * threshold except the one actually used is permanently UNMEASURED, and
 * re-running to recover the votes re-samples the thing being measured."* A
 * verifier is a sampled instrument, so the second ballot is a second draw.
 * Recording the first one is the prerequisite for CRC-B6's A/B, and it
 * creates no bypass because nothing acts on it.
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
 * 3. **A group that could not be convened is UNMEASURED, never a reading.**
 *    "Did not reach a quorum" and "did not have one" are different facts
 *    with different fixes, and only the first is a decision. The finding
 *    keeps blocking either way — because nothing here withdraws one — so
 *    the distinction is about what the ledger records, which is the whole
 *    output.
 * 4. **A ballot source that was named and could not be read is UNMEASURED
 *    and announced**, never an empty ballot set. An empty set would record
 *    a group that met and agreed with everything, which is a different and
 *    false fact. It does not fail the run: nothing the quorum says changes
 *    a verdict, so a quorum that could not be read must not either.
 *
 * ## What this does NOT do
 *
 * It does not convene the group. Spawning verifiers is the generated
 * workflow's job and `lib/finding-jury.ts`'s header says why: a library
 * that spawned them could not be tested without a model in the loop.
 *
 * Nor can it see whether the verifiers were independent. What it CAN see is
 * cardinality — `VERIFIER_GROUP_SIZE` ballot files, each contributing one
 * vote per finding under its own id — and that is why the merge below is
 * over files rather than over one file's array. A single file claiming
 * three votes is exactly the shape one context produces.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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
import {
  AI_REVIEW_BALLOT_BASENAME,
  AI_REVIEW_BALLOT_KEY,
  AI_REVIEW_BALLOT_VOTES_KEY,
} from "./scaffold/ai-review-step";

/**
 * The key the ballot payload hangs its per-finding votes off.
 *
 * Declared in `./scaffold/ai-review-step`, beside the prompt that asks a
 * verifier group to write the file, and re-exported here rather than
 * restated. #295 is the measured instance of what a second spelling costs: a
 * reader asked for a key no writer ever produced, the list was empty on
 * every run, and an absent key read as an empty list read as clean.
 */
export { AI_REVIEW_BALLOT_KEY } from "./scaffold/ai-review-step";

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
  unmeasured: string | null;
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
 * The VOTES are not validated here. `parseVotes` owns that boundary and is
 * the only thing in the tree that reads an untrusted vote — a second reader
 * agreeing with it would be two deciders over one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape), and a
 * malformed vote refuses ONE finding's ballot rather than the whole file.
 *
 * What IS checked here is the envelope: an entry names a finding, carries a
 * votes list, and names it only once. Those are facts about the ballot as a
 * document rather than about any vote on it, and a document this reader
 * cannot index is a file it did not read.
 */
export function readBallots(raw: string | null): BallotReading {
  if (raw === null) {
    return { ballots: null, unmeasured: `${BALLOT_UNREADABLE_PREFIX}: no ballot payload was produced` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ballots: null, unmeasured: `${BALLOT_UNREADABLE_PREFIX}: it is not JSON (${(e as Error).message})` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ballots: null,
      unmeasured: `${BALLOT_UNREADABLE_PREFIX}: the payload is ${
        Array.isArray(doc) ? "an array" : String(doc)
      }, not an object`,
    };
  }
  const obj = doc as Record<string, unknown>;
  if (!(AI_REVIEW_BALLOT_KEY in obj)) {
    return {
      ballots: null,
      unmeasured:
        `${BALLOT_UNREADABLE_PREFIX}: it carries no '${AI_REVIEW_BALLOT_KEY}' key ` +
        `(it carries ${Object.keys(obj).join(", ") || "no keys at all"}). An absent key is not ` +
        `an empty ballot set, and an empty ballot set is not a group that agreed with everything`,
    };
  }
  const list = obj[AI_REVIEW_BALLOT_KEY];
  if (!Array.isArray(list)) {
    return {
      ballots: null,
      unmeasured:
        `${BALLOT_UNREADABLE_PREFIX}: '${AI_REVIEW_BALLOT_KEY}' is ${
          list === null ? "null" : typeof list
        }, not a list of per-finding ballots`,
    };
  }

  const f = AI_REVIEW_FINDING_FIELDS;
  const ballots: BallotSet = {};
  for (let at = 0; at < list.length; at++) {
    const entry = list[at];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ballots: null,
        unmeasured: `${BALLOT_UNREADABLE_PREFIX}: ballot ${at} is ${
          Array.isArray(entry) ? "an array" : String(entry)
        }, not an object`,
      };
    }
    const e = entry as Record<string, unknown>;
    // The pair IS the identity, so a ballot that does not carry both names
    // no finding. Refused rather than skipped: a skipped entry is a group
    // that met and whose votes nobody counted, which reads from the outcome
    // exactly like a group that was never convened.
    for (const name of [f.file, f.summary] as const) {
      if (typeof e[name] !== "string" || (e[name] as string).trim() === "") {
        return {
          ballots: null,
          unmeasured:
            `${BALLOT_UNREADABLE_PREFIX}: ballot ${at} carries no '${name}', so it names no ` +
            `finding. The declared file and summary are how a ballot is matched to the ` +
            `finding it is about`,
        };
      }
    }
    if (!Array.isArray(e[AI_REVIEW_BALLOT_VOTES_KEY])) {
      return {
        ballots: null,
        unmeasured:
          `${BALLOT_UNREADABLE_PREFIX}: ballot ${at} carries no '${AI_REVIEW_BALLOT_VOTES_KEY}' ` +
          `list. A ballot entry with no votes on it is not an abstention, it is a malformed entry`,
      };
    }
    // ONE identity function, computed here from the pair the writer copied
    // rather than reproduced by the writer. See `AI_REVIEW_BALLOT_VOTES_KEY`.
    const key = advisoryKey(e);
    if (key in ballots) {
      return {
        ballots: null,
        unmeasured:
          `${BALLOT_UNREADABLE_PREFIX}: ballot ${at} is a second ballot for the finding at ` +
          `${JSON.stringify(e[f.file])}, and nothing here can choose between two readings of ` +
          `one question`,
      };
    }
    ballots[key] = e[AI_REVIEW_BALLOT_VOTES_KEY];
  }
  return { ballots, unmeasured: null };
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
   * One entry per blocking finding, **in input order** — the sentence saying
   * it was voted down, or `null` for a finding that keeps blocking.
   *
   * **Positional, not keyed, and this was a defect before it was a design.**
   * The first cut returned a map from `advisoryKey` to a reason, and the
   * consumer re-derived that hash in its own second pass to look the verdict
   * back up. Two findings that collide under it — the same `file` and
   * `summary`, or a genuine FNV-1a collision between different pairs — then
   * had one vote decide both: whichever the group actually voted on, the
   * other was withheld or upheld on a verdict that was never about it.
   *
   * `lib/finding-arbiter.ts` had already answered this, in the module this
   * one is built on, and answered it the other way: `SHARED_BALLOT` says
   * *"a vote is about a finding. Spreading one across a heterogeneous batch
   * does not give the other findings a quorum, it gives them somebody
   * else's"*, and its remedy is *"one group per finding, in input order"*.
   * A second module deciding the same question differently is the fourth
   * shape in `.claude/rules/checks-must-be-able-to-fail.md`.
   *
   * So the identity is derived exactly once, HERE, where a collision inside
   * the blocking set can be seen and refused — and the decision is carried
   * out by position, where nothing can collide at all.
   */
  withheld: (string | null)[];
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
  const withheld: (string | null)[] = [];
  const verdicts: JuryGateVerdict[] = [];
  const detail: string[] = [];

  const asObject = (item: unknown): Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};

  // The identity is derived ONCE, over the whole blocking set, so a key two
  // findings share can be SEEN. A ballot filed under an ambiguous key names
  // no single finding, and crediting it to whichever happened to come first
  // is the shared-ballot defect `lib/finding-arbiter.ts` refuses by name.
  // Both findings keep blocking, which is the direction this is allowed to
  // be wrong in.
  const seen = new Map<string, number>();
  for (const item of blocking) {
    const key = advisoryKey(asObject(item));
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const record = (v: JuryGateVerdict): void => {
    verdicts.push(v);
    detail.push(v.reason);
    withheld.push(v.surfaced ? null : v.reason);
  };

  for (const item of blocking) {
    const finding = asObject(item);
    const key = advisoryKey(finding);
    const title = String(finding[AI_REVIEW_FINDING_FIELDS.summary] ?? "");

    if ((seen.get(key) ?? 0) > 1) {
      record({
        key,
        title,
        reading: null,
        surfaced: true,
        reason:
          `${seen.get(key)} of the blocking findings share the identity [key ${key}], so a ` +
          `ballot filed under it names no one of them. All of them keep blocking: a vote is ` +
          `about a finding, and spreading one across several gives the others somebody ` +
          `else's quorum rather than their own`,
        refusal: "UNMEASURED",
      });
      continue;
    }

    const cast = ballots === null ? undefined : ballots[key];

    if (cast === undefined) {
      record({
        key,
        title,
        reading: null,
        surfaced: true,
        reason:
          `${NO_GROUP_CONVENED} [key ${key}]. It keeps blocking: a group that did not meet ` +
          `is UNMEASURED, which is neither a quorum of zero nor a pass`,
        refusal: "UNMEASURED",
      });
      continue;
    }

    let votes: readonly VerifierVote[];
    try {
      votes = parseVotes(cast);
    } catch (e) {
      record({
        key,
        title,
        reading: null,
        surfaced: true,
        reason:
          `the verifier ballot [key ${key}] could not be read, so no vote was counted on it: ` +
          `${(e as Error).message}. It keeps blocking`,
        refusal: "UNMEASURED",
      });
      continue;
    }

    const reading = juryReading(votes);
    if (reading.reading === "UNMEASURED") {
      record({
        key,
        title,
        reading,
        surfaced: true,
        reason:
          `the verifier group [key ${key}] did not produce a countable ballot: ` +
          `${reading.unmeasuredReasons.join("; ")}. It keeps blocking`,
        refusal: "UNMEASURED",
      });
      continue;
    }
    if (!reading.passed) {
      record({
        key,
        title,
        reading,
        surfaced: false,
        reason:
          `${reading.agree} of ${reading.votes} verifiers called it real and the quorum is ` +
          `${reading.quorum}, so it is withheld [key ${key}]. It is still reported below and ` +
          `blocks nothing`,
        refusal: "NO_QUORUM",
      });
      continue;
    }
    record({
      key,
      title,
      reading,
      surfaced: true,
      reason:
        `${reading.agree} of ${reading.votes} verifiers called it real, quorum ` +
        `${reading.quorum}${reading.disagreed ? " (the group disagreed)" : ""}, so it blocks ` +
        `[key ${key}]`,
      refusal: null,
    });
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
    // A review round adjudicates candidates, not `gh issue create` attempts,
    // so there is no earlier filing of this title for one to be a re-draft
    // of. `null` is the reading here, not an unperformed lookup (#1536).
    refiledAfter: null,
    // #1595's declaration is read off a `gh issue create` command line, and
    // a review round has none. `null` is the reading — nobody could have
    // declared one here — and not a declaration that was looked for and
    // missing. `emitted` and `refusal` already tell the two apart.
    exemption: null,
    // #1595's cap counts filings per CHECKOUT, and this path adjudicates a
    // candidate inside a review round rather than a `gh issue create` from
    // one. `null` is the reading: there is no run to attribute it to.
    run: null,
  };
}

/** What the adjudicator's `main` consumes. Plain data, so it can be injected. */
export interface JuryGateOutcome {
  /**
   * One entry per blocking finding, in input order — the sentence saying
   * the group WOULD have withheld it, or `null`.
   *
   * "Would have". Nothing acts on this; see the module header.
   */
  wouldWithhold: (string | null)[];
  /** Non-null when no countable ballot could be read. Never fatal. */
  unmeasured: string | null;
  detail: string[];
}

/**
 * Collect the ballots one verifier directory per verifier, merged by finding.
 *
 * **The group is N files, and that is the only independence claim anything
 * downstream can check.** One file carrying `VERIFIER_GROUP_SIZE` votes is
 * the shape a single model in a single context produces, and once written
 * it is indistinguishable from a real group — so the contract is one file
 * per verifier, and the merge happens here where the count can be seen.
 *
 * A directory with fewer than `VERIFIER_GROUP_SIZE` ballot files produces
 * short ballots, which `juryReading` refuses as `INCOMPLETE_GROUP`. That is
 * the correct reading and not a workaround: a verifier that did not report
 * is neither agreement nor dissent.
 *
 * Entries are merged in directory-name order, which is stable, so a given
 * finding's votes arrive in the same sequence on every run.
 */
export function readBallotDirectory(ballotDir: string): BallotReading {
  let entries: string[];
  try {
    entries = readdirSync(ballotDir).sort();
  } catch (e) {
    return {
      ballots: null,
      unmeasured:
        `${BALLOT_UNREADABLE_PREFIX}: the verifier directory ${ballotDir} could not be listed ` +
        `(${(e as Error).message}). A directory this run was told to read and could not is a ` +
        `group that did not meet, not a group that upheld every finding`,
    };
  }

  const merged: BallotSet = {};
  let files = 0;
  for (const entry of entries) {
    const path = join(ballotDir, entry, AI_REVIEW_BALLOT_BASENAME);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // A directory with no ballot in it is a verifier that did not report.
      // That is not an error here — it shortens the ballot, and
      // `INCOMPLETE_GROUP` is the reading that names it one level down.
      continue;
    }
    files += 1;
    const one = readBallots(raw);
    if (one.ballots === null) {
      return {
        ballots: null,
        unmeasured: `${one.unmeasured} (verifier ${JSON.stringify(entry)})`,
      };
    }
    for (const [key, votes] of Object.entries(one.ballots)) {
      const cast = votes as unknown[];
      // ONE VOTE PER FILE, and a file carrying more is REFUSED rather
      // than truncated.
      //
      // This is the counterfeit CRC-B4 names, arriving through the file
      // format instead of through a constant `agree`. One file listing
      // `VERIFIER_GROUP_SIZE` votes under distinct names reads as a full
      // group one level down: the names differ so `REPEATED_VERIFIER`
      // cannot fire, the count is right so `INCOMPLETE_GROUP` cannot,
      // and nothing below this line knows how many files the votes came
      // out of. The file count is the ONLY independence signal this
      // layer has, so it is spent here or not at all.
      //
      // Refused and not truncated, because the two readings differ:
      // keeping the first vote would report a group that met and fell
      // short, which is a reading, and this is a ballot nobody can
      // count. Found by this repository's own `ai-review` against the
      // first cut of this function, whose docblock already said a
      // self-written group "is indistinguishable from a real group"
      // while the code merged the array whole.
      //
      // **Here and not in `readBallots`**, which is the other candidate
      // and the tempting one — it is the single-file reader, so the
      // invariant would sit with the thing it describes. Two reasons it
      // does not. The refusal has to NAME the verifier that filed the
      // stuffed file, and the directory name is knowledge this loop has
      // and `readBallots` does not; putting the cap down there means the
      // caller rewrites the message to add the name, which is two places
      // shaping one refusal. And the violated property is provenance,
      // not syntax: `VERIFIER_GROUP_SIZE` votes for one finding is a
      // perfectly well-formed ballot, and what makes it a counterfeit is
      // that they arrived in one file. Only a reader counting files can
      // see that. `readBallotDirectory` is the only production caller of
      // `readBallots`, so there is exactly one decider either way —
      // this is about which one can state the fact.
      if (cast.length !== 1) {
        return {
          ballots: null,
          unmeasured:
            `${BALLOT_UNREADABLE_PREFIX}: verifier ${JSON.stringify(entry)} filed ${cast.length} ` +
            `votes for one finding in a single ${AI_REVIEW_BALLOT_BASENAME}. The contract is one ` +
            `vote per file because the file count is the only evidence the votes came from ` +
            `separate contexts: a group one writer can produce alone is the quorum wired to a ` +
            `constant that CRC-B4 refuses, wearing ${cast.length} names`,
        };
      }
      const carried = merged[key];
      merged[key] = [...(Array.isArray(carried) ? carried : []), ...cast];
    }
  }

  if (files === 0) {
    return {
      ballots: null,
      unmeasured:
        `${BALLOT_UNREADABLE_PREFIX}: no verifier under ${ballotDir} wrote a ` +
        `${AI_REVIEW_BALLOT_BASENAME}, so no group met. An empty ballot set is not a group ` +
        `that agreed with every finding`,
    };
  }
  return { ballots: merged, unmeasured: null };
}

/**
 * The deployed gate: read the ballots, count them, record them, report them.
 *
 * Injected into `main` rather than imported by it. `lib/scaffold/
 * ai-review-findings.ts` is copied into a scratch directory by three mutation
 * batteries, which carry its one relative dependency with it; an import of
 * this module would drag `lib/issue-filing-gate.ts` and its whole tree behind
 * it and the mutants would die on module resolution — a failure that reads
 * identically to a guard behaving differently
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row).
 *
 * The seam is not a loophole, because there is nothing on the other side of
 * it to bypass: the gate changes no verdict. An entry point that forgets to
 * wire it records no votes and says so under
 * `AI_REVIEW_JURY_UNMEASURED_TITLE`.
 *
 * **Including when this function throws.** That is not a property of this
 * file — nothing here is exception-safe, and `juryReading`, `advisoryKey`
 * and the whole of `juryLedgerRow` can all raise — it is a property of the
 * `try` around the call in `lib/scaffold/ai-review-findings.ts`, asserted
 * by `JG-6h`. Said here because this is where a reader will look for it,
 * and because the first cut of that sentence was true of three states out
 * of four.
 *
 * **A ledger that cannot be written does not change the verdict**, which is
 * trivially true here and is said anyway, because it will stop being
 * trivial the day the ballot is allowed to subtract. The record exists to
 * measure the gate, and a measurement apparatus that blocks the thing it
 * measures is worse than no measurement — `recordAdjudication`'s own policy.
 */
export function aiReviewJuryGate(blocking: readonly unknown[], ballotDir: string): JuryGateOutcome {
  const source = readBallotDirectory(ballotDir);
  if (source.ballots === null) {
    return { wouldWithhold: [], unmeasured: source.unmeasured, detail: [] };
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
        `finding ledger, so those votes are UNMEASURED for every later threshold. Nothing else ` +
        `changes: a record that cannot be written must not change what it records`,
    );
  }
  return { wouldWithhold: result.withheld, unmeasured: null, detail };
}
