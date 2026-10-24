/**
 * WHICH kind of unmeasured a review round was (#1486).
 *
 * `lib/ai-review-rounds.ts` already keeps apart the two facts that matter
 * most: `findings: []` is a round that was read and found nothing, and
 * `findings: null` is a round nobody read. `readLedger` normalises the second
 * into `measured: false`, and **this module does not touch that boolean.**
 * Everything downstream reads it — `summariseRoundsToPass`, `priorFindings`,
 * the eval runner — and the whole of this is additive beside it.
 *
 * What it adds is the next question down. UNMEASURED is at least three facts
 * that cost the same and are fixed differently:
 *
 * | state | the tell | the cure |
 * |---|---|---|
 * | structural decline | the action's skip line is in the FULL job log | #1455 |
 * | no-payload | no skip line; the action ran and wrote nothing | #1478 |
 * | unparseable payload | a payload exists and does not parse | a contract bug |
 *
 * A row that cannot tell them apart is a row nobody can act on, and 48 of 117
 * rounds across the 45 most recent pull requests are that row (#1485) — the
 * single largest identified contributor to CRC-M11's 2.65 mean
 * rounds-to-pass. Scoring only the measured rounds gives 1.58.
 *
 * ## The reading is the FULL log, and the two cheaper readings are both wrong
 *
 * **Not `--log-failed`.** It returns only the FAILING step's log, and the
 * skip line is emitted by a step that SUCCEEDS — `Run the AI review` carries
 * `continue-on-error: true` and the action exits zero on its own
 * workflow-validation guard. So grepping `--log-failed` for the marker
 * returns 0 by construction. Measured on run 40047304108, a declined run:
 * `--log` is 733,973 bytes and contains the marker once; `--log-failed` is 0
 * bytes. That mistake has produced four wrong public statements here.
 *
 * **Not the clock.** #1485 measured no-payload runs at 4m11s, 4m38s, 5m35s
 * and 5m05s, a decline at ~16s, and a real review at 2m16s. The clock looks
 * diagnostic, separates nothing, and is the reading every reader reaches for
 * first.
 *
 * ## Why a job cannot do this for itself, which is why this is not in the step
 *
 * `lib/scaffold/ai-review-step.ts` would be the obvious home: the persist
 * step writes the round, so it could write the discriminator in the same
 * breath. It cannot read the evidence. A later step cannot read an earlier
 * step's stdout — `AI_REVIEW_APP_INSTALL_CAUSE` settled that for #803 and
 * says so in its own docblock — and the Actions log endpoint does not serve a
 * job that is still running: `gh run view --log` refuses an in-progress run
 * outright. `test/ai-review-payload-reading.test.ts` AC-6 separately forbids
 * the action's skip prose anywhere in the generated script, because a check
 * cannot tell a grep from a mention.
 *
 * So the evidence is only available from OUTSIDE the run, after it finishes
 * and before its logs expire. That is what `scripts/record-ai-review-unmeasured.ts`
 * does with this module, and the urgency in #1486 is the expiry: each day a
 * round goes unclassified, another population becomes permanently
 * unmeasurable.
 *
 * ## No imports, deliberately
 *
 * `test/ai-review-unmeasured-split.test.ts` AC-U4 builds a mutant by copying
 * this file alone into an `mkdtemp`. A relative import added here resolves to
 * nothing there, the mutant fails to LOAD, and a mutant that failed to load
 * reports the same zero as a guard that held —
 * `.claude/rules/self-referential-tests.md`, Tier 1. AC-U7 asserts the
 * property rather than leaving it as a convention.
 */

/**
 * The bytes `anthropics/claude-code-action` writes when its anti-tampering
 * guard declines the run.
 *
 * QUOTED, from run 40047304108's full job log, not paraphrased and not read
 * off the action's source:
 *
 * ```
 * ##[warning]Skipping action due to workflow validation: Workflow validation
 * failed. The workflow file must exist and have identical content to the
 * version on the default branch.
 * ```
 *
 * Two spellings are in circulation here and both are real — the next line of
 * that same log reads `Exiting due to workflow validation skip`, which is
 * what `lib/scaffold/ai-review-step.ts` quotes. This one is used because it
 * is the one #1486 measured the population with, and because a classifier
 * that matched both would be two deciders that agree.
 *
 * The negative control is the half that matters. The generated workflow
 * script is echoed into the job log in full, so a marker the script happens
 * to mention matches on every run. Measured 2026-10-23 over seven full logs:
 * present once on all three declined runs, absent on all four that reviewed.
 * The script's own spelling is hyphenated (`workflow-validation`), which is
 * why it does not collide.
 */
export const AI_REVIEW_DECLINE_LOG_LINE = "Skipping action due to workflow validation";

/** The full job log was obtained. */
export const AI_REVIEW_JOB_LOG_READ = "AI_REVIEW_JOB_LOG_READ";

/**
 * The full job log could NOT be obtained — expired, unauthorised, the run id
 * is unknown, the request failed.
 *
 * It is a status and not an empty string, for the reason `readLedger` keeps
 * ABSENT and UNREADABLE apart: a grep that could not run and a grep that
 * found nothing are the two readings this module exists to separate, and an
 * empty string is a perfectly good log of a run that was declined.
 */
export const AI_REVIEW_JOB_LOG_UNREADABLE = "AI_REVIEW_JOB_LOG_UNREADABLE";

export type JobLogReading =
  | { status: typeof AI_REVIEW_JOB_LOG_READ; text: string }
  | { status: typeof AI_REVIEW_JOB_LOG_UNREADABLE; reason: string };

/** The action declined on its own workflow-validation guard. #1455's state. */
export const AI_REVIEW_UNMEASURED_DECLINED = "declined";

/**
 * The action was not declined, ran, and no review came out of it. #1478's
 * state.
 *
 * **Its boundary is honest and it is wider than its name.** This is the
 * reading "a readable log with no skip line in it", so it also catches the
 * third row of the table above — a payload that existed and did not parse —
 * because that round is `findings: null` too and its log carries no skip
 * line. Separating that needs a second positive marker, which would have to
 * be one of this repository's OWN annotations rather than the action's; it is
 * not done here and is recorded as the known boundary rather than hidden
 * behind a confident name.
 */
export const AI_REVIEW_UNMEASURED_NO_PAYLOAD = "no_payload";

/** The log could not be read, so WHICH state this round is in is unknown. */
export const AI_REVIEW_UNMEASURED_LOG_UNREADABLE = "log_unreadable";

/**
 * The evidence was a shape this classifier has no rule for.
 *
 * #1486's first acceptance row, and the reason the field is a NAME and not a
 * boolean: *"a fourth state nobody predicted must not be recorded as a
 * decline."* A classifier whose last branch is `return DECLINED` or whose
 * negation is written one branch too wide records a confident reading of
 * something it never understood, and nothing afterwards can tell.
 */
export const AI_REVIEW_UNMEASURED_UNCLASSIFIED = "unclassified";

/**
 * The round carries no discriminator at all.
 *
 * Reader-side only — nothing ever WRITES this. It is every round written
 * before #1486, and it is a fourth thing that is true: the discriminator was
 * not recorded. Not a decline, not a no-payload, and not "the log could not
 * be read" either, because nobody tried.
 */
export const AI_REVIEW_UNMEASURED_NOT_RECORDED = "not_recorded";

/**
 * The round carries a discriminator this reader does not know.
 *
 * Reader-side only. The same one-sided safety `AI_REVIEW_LEDGER_IDENTITY`
 * buys: a later version of this module may add a state, and a ledger written
 * by it must not be read under a rule that predates it. An unknown value
 * reads as unknown rather than as the nearest thing.
 */
export const AI_REVIEW_UNMEASURED_UNRECOGNISED = "unrecognised";

/** The four states this module can WRITE. */
export type UnmeasuredState =
  | typeof AI_REVIEW_UNMEASURED_DECLINED
  | typeof AI_REVIEW_UNMEASURED_NO_PAYLOAD
  | typeof AI_REVIEW_UNMEASURED_LOG_UNREADABLE
  | typeof AI_REVIEW_UNMEASURED_UNCLASSIFIED;

/** Everything a READER of a ledger round can meet, including the two above. */
export type RecordedUnmeasuredState =
  | UnmeasuredState
  | typeof AI_REVIEW_UNMEASURED_NOT_RECORDED
  | typeof AI_REVIEW_UNMEASURED_UNRECOGNISED;

/** The closed set, so the reader can refuse anything outside it by name. */
const WRITABLE_STATES: readonly string[] = [
  AI_REVIEW_UNMEASURED_DECLINED,
  AI_REVIEW_UNMEASURED_NO_PAYLOAD,
  AI_REVIEW_UNMEASURED_LOG_UNREADABLE,
  AI_REVIEW_UNMEASURED_UNCLASSIFIED,
];

/**
 * The key the discriminator hangs off a ledger round under.
 *
 * Additive beside `findings`, never instead of it. A round carries
 * `findings: null` exactly as before and this key beside it, so a reader that
 * has never heard of #1486 behaves identically.
 */
export const AI_REVIEW_LEDGER_UNMEASURED_KEY = "unmeasured";

/**
 * Which kind of unmeasured round this is, from the FULL job log.
 *
 * THE SINGLE DECISION SITE. Every state recorded anywhere comes through this
 * function, which is what makes `test/ai-review-unmeasured-split.test.ts`
 * AC-U4's mutation a mutation of the whole feature: a caller that greps the
 * log itself would bypass it, and the case would go green having witnessed a
 * classifier it never ran. AC-U4 asserts the signature appears exactly once
 * in this file for the same reason `SECURITY_REREVIEW_EXHAUSTED` asserts it
 * about its own name.
 *
 * FAILS TOWARD UNCLASSIFIED. The order of the branches below is load-bearing:
 * the unreadable reading is answered before anything looks for the marker, so
 * "I could not grep" can never arrive at "I grepped and found nothing", and
 * the final `return` is the no-payload reading only for an input that has
 * already been established as a readable log with a string body.
 */
export function classifyUnmeasuredRound(reading: unknown): UnmeasuredState {
  if (typeof reading !== "object" || reading === null || Array.isArray(reading)) {
    return AI_REVIEW_UNMEASURED_UNCLASSIFIED;
  }
  const r = reading as Record<string, unknown>;
  if (r.status === AI_REVIEW_JOB_LOG_UNREADABLE) return AI_REVIEW_UNMEASURED_LOG_UNREADABLE;
  if (r.status !== AI_REVIEW_JOB_LOG_READ) return AI_REVIEW_UNMEASURED_UNCLASSIFIED;
  // A READ reading whose body is not text is not an empty log. It is a
  // reading that claims to have succeeded and carries nothing, which is a
  // shape nobody wrote a rule for — and calling it no-payload would be the
  // same substitution one field over.
  if (typeof r.text !== "string") return AI_REVIEW_UNMEASURED_UNCLASSIFIED;
  if (r.text.includes(AI_REVIEW_DECLINE_LOG_LINE)) return AI_REVIEW_UNMEASURED_DECLINED;
  return AI_REVIEW_UNMEASURED_NO_PAYLOAD;
}

/**
 * What a ledger round says about itself, for a reader.
 *
 * `undefined` — no key at all — is NOT_RECORDED, which is true of every round
 * written before #1486 and is a different fact from any of the four states. A
 * value outside the closed set is UNRECOGNISED rather than the nearest match.
 */
export function readRecordedUnmeasuredState(round: unknown): RecordedUnmeasuredState {
  if (typeof round !== "object" || round === null || Array.isArray(round)) {
    return AI_REVIEW_UNMEASURED_NOT_RECORDED;
  }
  const raw = (round as Record<string, unknown>)[AI_REVIEW_LEDGER_UNMEASURED_KEY];
  if (raw === undefined) return AI_REVIEW_UNMEASURED_NOT_RECORDED;
  if (typeof raw === "string" && WRITABLE_STATES.includes(raw)) {
    return raw as UnmeasuredState;
  }
  return AI_REVIEW_UNMEASURED_UNRECOGNISED;
}

/** Is this ledger round one that recorded no review? */
function roundIsUnmeasured(round: Record<string, unknown>): boolean {
  // The writer's own rule, restated rather than imported: `readLedger` calls
  // a round measured exactly when its `findings` is an array. Anything else —
  // `null`, absent, a string — is a round nobody read.
  return !Array.isArray(round.findings);
}

export interface AnnotationReading {
  /** The rounds, with the discriminator added where one was missing. */
  rounds: unknown[];
  /** How many rounds gained a reading on this pass. */
  recorded: number;
  /** State -> how many rounds now carry it, counting ones already recorded. */
  counts: Record<string, number>;
}

/**
 * Add the discriminator to every unmeasured round that does not have one.
 *
 * Synchronous and pure, with the log handed in. The fetch lives in the script
 * because a function that fetches its own evidence cannot be given a negative
 * control — the same argument `suppressRepeats` makes about `priorKeys`.
 *
 * THREE THINGS IT WILL NOT DO, and each is one of #1486's acceptance rows:
 *
 *  - a round with a payload is untouched. No key is added at all, rather than
 *    a "not applicable" value: a reader asking `Object.hasOwn` gets a true
 *    answer, and a measured round has nothing to discriminate.
 *  - a round that already carries a reading is not reclassified, and does not
 *    even cost a log fetch. Re-running this must be free and must not let a
 *    later expiry overwrite a reading taken while the log still existed.
 *  - `findings` is never rewritten, so `measured` is what it always was.
 */
export function annotateUnmeasuredRounds(
  rounds: readonly unknown[],
  evidenceFor: (round: Record<string, unknown>, index: number) => unknown,
): AnnotationReading {
  const out: unknown[] = [];
  const counts: Record<string, number> = {};
  let recorded = 0;

  rounds.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      // A round entry that is not an object is one `readLedger` already
      // counts and cannot read. Passed through byte-for-byte: this is a
      // recorder, and dropping an entry it does not understand would shorten
      // the history it exists to preserve.
      out.push(raw);
      return;
    }
    const round = raw as Record<string, unknown>;
    if (!roundIsUnmeasured(round)) {
      out.push(round);
      return;
    }
    const existing = readRecordedUnmeasuredState(round);
    if (existing !== AI_REVIEW_UNMEASURED_NOT_RECORDED) {
      counts[existing] = (counts[existing] ?? 0) + 1;
      out.push(round);
      return;
    }
    const state = classifyUnmeasuredRound(evidenceFor(round, i));
    counts[state] = (counts[state] ?? 0) + 1;
    recorded++;
    out.push({ ...round, [AI_REVIEW_LEDGER_UNMEASURED_KEY]: state });
  });

  return { rounds: out, recorded, counts };
}

/** The fence the ledger's machine-readable half sits inside. */
const LEDGER_FENCE = "```json";

/**
 * Put a rewritten rounds document back into a ledger comment body, touching
 * nothing outside the fenced block.
 *
 * `null` when the block cannot be located, and the caller must treat that as
 * a REFUSAL rather than as a licence to compose a fresh body. A ledger
 * holding seven rounds replaced by one holding this pass is the worst thing
 * any writer here can do and is indistinguishable from a first round
 * afterwards — the rule `buildPersistScript` is built around, restated for a
 * writer that runs outside the job.
 *
 * It is a SPLICE, not a re-render. The prose above and below the fence is
 * whatever the persist step wrote, including anything a later version of it
 * adds, and a rewrite that regenerated the whole comment would silently
 * discard it.
 *
 * The fence-finding here is deliberately the same shape as `readLedger`'s and
 * is therefore a second reader of the same bytes. That is a risk this module
 * cannot remove — it may not import `lib/ai-review-rounds.ts`, for the reason
 * the header gives — so it is closed at the call site instead:
 * `scripts/record-ai-review-unmeasured.ts` runs the real `readLedger` over
 * the spliced body and refuses to send it unless the rounds read back.
 */
export function replaceLedgerJsonBlock(body: unknown, doc: unknown): string | null {
  if (typeof body !== "string") return null;
  const fence = body.indexOf(LEDGER_FENCE);
  if (fence === -1) return null;
  const start = body.indexOf("\n", fence);
  if (start === -1) return null;
  const close = body.indexOf("\n```", start);
  if (close === -1) return null;
  // COMPACT, because `buildPersistScript` writes it with `jq -c` and the
  // ledger is a 12-round window sized against GitHub's 65,536-character
  // comment body limit. Pretty-printing inflates every round, so a rewrite
  // that re-serialised with an indent would make the window start evicting
  // earlier — and an eviction brought on by whitespace is indistinguishable
  // from the ordinary truncation the `truncated` count describes. Caught on
  // #1487 after the first real write, which did exactly that.
  return `${body.slice(0, start + 1)}${JSON.stringify(doc)}${body.slice(close)}`;
}
