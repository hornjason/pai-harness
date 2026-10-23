/**
 * The verifier jury: who agrees a finding is real, what kind it is, and where
 * it goes (#1187).
 *
 * ## The topology this implements, and the one it replaces
 *
 * #1187 was filed asking which findings are worth **filing**. That framing is
 * wrong, and the correction is the point of this module. The published design
 * it was inspired by files nothing at all:
 *
 * > Several agents look for bugs at the same time. Then a separate group votes
 * > on each finding, and it only gets posted if enough of them agree it's
 * > real. Findings that are only about style, diagnostics, or cleanup get
 * > dropped. We A/B tested those filters on our own PRs before keeping them.
 * > What's left shows up as inline comments sorted by severity. Each is tagged
 * > Important, Nit, or Pre-existing.
 *
 * So the pipeline is **hunters → a separate verifier group votes → quorum →
 * category filter → severity sort → inline PR comments that block merge until
 * answered.** A finding is resolved by being fixed or by the thread being
 * closed with a reason. Nothing becomes a tracker issue, which is why that
 * pipeline has no backlog and ours regenerates: we added a filing step it does
 * not have. Measured on this tracker on 2026-10-22, **23 of 27 open issues
 * were created the same day and 10 of them name one subsystem.**
 *
 * `DEFAULT_DISPOSITION` is therefore `COMMENT`, and `ISSUE` is reachable only
 * by an explicit, reasoned declaration from the caller — see `adjudicate`.
 *
 * ## What this module owns, and what it does not
 *
 * It owns the **gate**, not the agents. Spawning hunters and verifiers is the
 * orchestrator's job; a library that spawned them could not be tested without
 * a model in the loop, and `lib/rule-promotion.ts` already set the precedent —
 * it owns the ranking and the budget and nothing that produces candidates.
 *
 * So a caller hands in `VerifierVote[]` and this counts them.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * - **Whether the verifiers are independent.** Three votes from one agent run
 *   three times is not a group, and the only shape of that this can see is a
 *   repeated `verifier` id, which it refuses. Three genuinely separate agents
 *   given the same prompt and the same context are correlated in a way nothing
 *   here can read.
 * - **Whether the category a verifier reports is the right one.**
 *   `classifyCategory` is a keyword fallback and a measuring instrument, not
 *   an adjudicator. Its error direction is deliberately toward KEEP.
 * - **Whether a dropped finding was real.** A dropped finding leaves a reason
 *   and a category on the reading; nothing re-examines it later.
 */

import type { Finding } from "./finding-arbiter";

// ── Cardinalities ────────────────────────────────────────────────────────

/**
 * How many verifiers vote on each finding.
 *
 * **Three, and this is a default rather than a derivation.** The published
 * design gives the topology and publishes no cardinality — not the number of
 * hunters, not the number of verifiers, not the quorum. Writing a number into
 * the code as though it had been measured would be the worst of both.
 *
 * What can be argued for three:
 *
 * - It is the smallest group in which **one voter does not decide the
 *   outcome**. At two, a single dissent either deadlocks or wins.
 * - It is odd, so a majority always exists and no tie-break rule is needed —
 *   and a tie-break rule is a second decider over the same input
 *   (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 * - Each verifier is a full agent context. Five-of-three costs 67% more per
 *   finding and buys tolerance of **two** dissenters, which is only worth
 *   paying once a measured single-dissent rate shows it is common.
 *
 * What would derive it: the disagreement rate between independent verifiers on
 * one finding. **That cannot be measured in this repository today**, because
 * nothing records a finding before it is filed — every artefact on this
 * tracker and in `.claude/` is already post-filter. Recording the pre-filter
 * population is the prerequisite, not a tuning pass.
 */
export const VERIFIER_GROUP_SIZE = 3;

/**
 * How many of them must agree a finding is real for it to be posted.
 *
 * Two of three: the weakest threshold that still means *agreement* rather than
 * *anyone*. `juryReading` refuses a configured quorum that is not a strict
 * majority — see `NON_MAJORITY_QUORUM` — because a "quorum" of one is a group
 * with no gate in it, and that failure is invisible from the outcome.
 */
export const VERIFIER_QUORUM = 2;

export const INCOMPLETE_GROUP = "the ballot's size does not match the declared group size: an absent vote is neither agreement nor dissent, and an extra one is not a larger group";
export const REPEATED_VERIFIER = "one verifier voted more than once, so the votes are not independent";
export const NON_MAJORITY_QUORUM = "the configured quorum is not a strict majority of the group";

// ── Categories ───────────────────────────────────────────────────────────

export type FindingCategory =
  | "correctness"
  | "security"
  | "performance"
  | "style"
  | "diagnostics"
  | "cleanup"
  /** No signal either way. Kept, never dropped. */
  | "unclassified";

/** Dropped outright. The three the source design names, and no others. */
export const DROPPED_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>([
  "style",
  "diagnostics",
  "cleanup",
]);

const KEEP_SIGNALS: Array<[Exclude<FindingCategory, "style" | "diagnostics" | "cleanup" | "unclassified">, RegExp]> = [
  [
    "security",
    /\b(secret|credential|token|api key|injection|traversal|privilege|sandbox escape|arbitrary (read|write|code)|unauthenticated|spoof)\b/i,
  ],
  [
    "correctness",
    /\b(bug|defect|regression|incorrect|wrong|broken|crash|throws|race|deadlock|off.by.one|silently|never fires|cannot fail|false (positive|negative)|fails? (open|closed|to)|returns the wrong|mismatch|data loss|corrupt|does not (match|fire|run|refuse|catch))\b/i,
  ],
  ["performance", /\b(timeout|unbounded|memory leak|leaks? (memory|descriptors)|hangs?|exhaust)\b/i],
];

const DROP_SIGNALS: Array<[Extract<FindingCategory, "style" | "diagnostics" | "cleanup">, RegExp]> = [
  ["style", /\b(nit|typo|formatting|indentation|naming convention|rename (it|this|the variable)|readability|capitalisation|capitalization|whitespace)\b/i],
  ["diagnostics", /\b(error message|log(ging| line| statement)|warning text|annotation text|stack trace|observability|console\.log|more helpful message)\b/i],
  ["cleanup", /\b(unused (import|variable|export|function)|commented.out|refactor|tidy|house ?keeping|nitpick|cosmetic|delete the comment|redundant comment)\b/i],
];

/**
 * A keyword reading of what kind of finding this is.
 *
 * **This is a fallback and a measuring instrument, not an adjudicator.** In
 * production the category comes from the verifier vote, which is a model
 * reading the finding; this runs only when no verifier supplied one, and it is
 * what `adjudicate` reports so the category is never silently absent.
 *
 * ## The error direction, chosen deliberately
 *
 * A drop category is returned **only when a drop signal matched and no keep
 * signal did.** So the cheap way for this to be wrong is to keep a nit, which
 * costs one comment thread; the expensive way — dropping a real bug — requires
 * a finding that uses none of the correctness, security or performance
 * vocabulary while using the style, diagnostics or cleanup vocabulary.
 *
 * ## THE SCOPE IS THE TITLE, AND THAT IS THE WHOLE RULE
 *
 * **A finding's title states what it is about; its body argues, and an
 * argument quotes the vocabulary of the thing it is not.**
 *
 * Measured, not asserted. Over the 385 issues on this tracker closed as
 * COMPLETED, reading the whole text drops **8**, and all eight are that
 * failure: `prose` inside `refs(c.branch) || prose(c.subject)` (#900), inside
 * "template prose" (#515), inside "entries carried prose" (#611) — and #781,
 * whose body contains the sentence *"the reason this is not just a wording
 * fix"*. Scoping to the title drops **0** of the same 385.
 *
 * Three terms were then removed from the signal lists, and this is a fit to
 * this corpus rather than a forecast, so it is stated as one: `prose` and
 * `wording` are **domain vocabulary here** — this project argues about prose
 * versus mechanism constantly — and `dead code` is how a reachability defect
 * is *described* (#1110's title calls an unreachable blocking branch "dead
 * code"), not a request to tidy. They would be reasonable signals in a
 * codebase that did not talk this way.
 *
 * ## Measured backwards, before the filter shipped
 *
 * The source design A/B tested its filters before keeping them. The
 * backwards-equivalent available here is to run the filter over findings whose
 * outcome is already known: closed as COMPLETED means a merged PR fixed it, so
 * it was real.
 *
 * | population | n | dropped |
 * |---|---|---|
 * | closed COMPLETED — real, somebody wrote the fix | 385 | **0** |
 * | closed NOT_PLANNED | 15 | **0** |
 * | open on 2026-10-22 | 27 | **0** |
 * | planted: one style, one diagnostics, one cleanup, one correctness control | 4 | **3** |
 *
 * **Read the fourth row before the first three.** Zero drops over 427 real
 * issues would otherwise be indistinguishable from a filter that cannot fire
 * — the inert-knob shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 * The planted row is in `test/finding-jury.test.ts` under `JURY-4` and it is
 * what separates those two readings.
 *
 * **And read the first three as safety, not as usefulness.** The filter is
 * inert on this corpus because what this tracker carries is already almost
 * entirely correctness-shaped (278 of 385 by this same classifier). Its real
 * population is raw hunter output *before* anybody decided to file, and
 * **this repository does not record that population anywhere** — which is the
 * same gap that makes the quorum cardinality above a default rather than a
 * derivation. So: safe to ship, not yet shown to earn its place.
 */
export function classifyCategory(finding: Pick<Finding, "title" | "body">): FindingCategory {
  const scope = finding.title;
  for (const [category, signal] of KEEP_SIGNALS) {
    if (signal.test(scope)) return category;
  }
  for (const [category, signal] of DROP_SIGNALS) {
    if (signal.test(scope)) return category;
  }
  return "unclassified";
}

// ── Severity ─────────────────────────────────────────────────────────────

/**
 * The three tags the source design posts, and no fourth.
 *
 * `Pre-existing` is the one that matters most here and the one we had no way
 * to say: a finding about code the change never touched is not the author's
 * defect and should not be priced like one.
 */
export type Severity = "Important" | "Nit" | "Pre-existing";

/** Sort order for the posted comments. A pre-existing bug is still a bug. */
export const SEVERITY_RANK: Record<Severity, number> = { Important: 0, "Pre-existing": 1, Nit: 2 };

// ── The vote ─────────────────────────────────────────────────────────────

export interface VerifierVote {
  /** Which verifier cast it. Two votes under one id is not a group. */
  verifier: string;
  /** The one question a vote answers: is this real? */
  real: boolean;
  reason: string;
  category?: FindingCategory;
  severity?: Severity;
}

/**
 * Every category name, bound to the union by the compiler.
 *
 * A `Record<FindingCategory, true>` is exhaustive: add a member to the union
 * and this object fails to typecheck until it carries it. That is the point —
 * a hand-written array would quietly stop recognising the new category and
 * `parseVotes` would start refusing a vote that is in fact well-formed.
 */
const CATEGORY_MEMBERS: Record<FindingCategory, true> = {
  correctness: true,
  security: true,
  performance: true,
  style: true,
  diagnostics: true,
  cleanup: true,
  unclassified: true,
};

/** What a malformed entry is called in the refusal. One string, one binding. */
export const UNREADABLE_VOTE = "a vote nobody can read is UNMEASURED, not a dissent";

/** `"a string"`, `3`, `null` — enough to identify the entry without echoing a body. */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "string" ? `the string ${JSON.stringify(value)}` : `a ${typeof value}`;
}

/**
 * Read an untrusted ballot, or refuse it.
 *
 * **This is the boundary, and it is the whole of #1235.** `readVotes` in
 * `scripts/arbitrate-finding.ts` checked that the parsed JSON was an array and
 * then cast it — `parsed as VerifierVote[]` — so nothing ever looked at an
 * entry. `juryReading` counts agreement with `votes.filter(v => v.real)`, a
 * truthy test, and **the string `"false"` is truthy**. A verifier who wrote
 * `"real": "false"` was counted as agreeing with the finding they rejected.
 * Measured before the fix: three votes, all three rejecting, two of them
 * spelling it `"false"`, returned `MEASURED passed=true` at `2 of 3`.
 *
 * ## Why this refuses the ballot instead of coercing the vote
 *
 * The cheap repair is to read `"false"` as `false`. It fixes the headline case
 * and is wrong in the same direction: it invents a dissent. A vote that cannot
 * be read is not a vote that was cast, and counting it as a no is a second
 * reading nobody took — `.claude/rules/config-access.md`'s *Silent Default
 * Substitution*. One unreadable entry among two genuine yeses still clears a
 * 2-of-3 quorum under coercion, and `test/finding-arbiter.test.ts`'s `AR-16`
 * case `B` is that input.
 *
 * Nor is the entry dropped. A two-vote ballot against a declared group of
 * three refuses as `INCOMPLETE_GROUP` — "a verifier did not report" — when in
 * fact it reported unreadably. Both refuse; only one names what happened.
 *
 * ## Why here and not in `juryReading`
 *
 * `juryReading` owns the *group* properties — `INCOMPLETE_GROUP`,
 * `REPEATED_VERIFIER`, `NON_MAJORITY_QUORUM` — and should keep owning only
 * those. They are facts about a ballot already known to be made of votes. This
 * is the question of whether it is, and it belongs where the JSON enters.
 *
 * Validating the whole declared interface rather than only `real` is
 * deliberate: the cast asserted every field, so every field was unchecked, and
 * two of the others carry the same defect. An unrecognised `category` is not
 * in `DROPPED_CATEGORIES`, so it reads to `juryCategory` as a keep category.
 * An unrecognised `severity` indexes `SEVERITY_RANK` to `undefined`, making
 * the sort comparator in `severityOf` return `NaN`.
 *
 * **`Object.hasOwn`, never the `in` operator**, and this is not a style
 * preference. `in` walks the prototype chain, so `"constructor" in
 * CATEGORY_MEMBERS` is `true` and a vote claiming `category: "constructor"`
 * was accepted — an accepted-but-unrecognised category is absent from
 * `DROPPED_CATEGORIES` and so reads as a **keep**, which is this function's
 * own defect reintroduced inside its fix. Eight values were wrongly accepted
 * across the two fields; `JURY-6` runs five of them against both.
 *
 * @throws if the ballot is not an array, or any entry is not a well-formed vote.
 */
export function parseVotes(parsed: unknown): readonly VerifierVote[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`the ballot is ${shapeOf(parsed)}, not a JSON array of votes`);
  }
  return parsed.map((entry, at): VerifierVote => {
    const where = `vote ${at} of the ballot`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} is ${shapeOf(entry)}, not an object: ${UNREADABLE_VOTE}`);
    }
    const v = entry as Record<string, unknown>;
    if (typeof v.verifier !== "string" || v.verifier === "") {
      throw new Error(
        `${where} has no \`verifier\` id (${shapeOf(v.verifier)}): an anonymous vote cannot be ` +
        `checked for independence, so ${UNREADABLE_VOTE}`,
      );
    }
    if (typeof v.real !== "boolean") {
      throw new Error(
        `${where}, from \`${v.verifier}\`, has a non-boolean \`real\` (${shapeOf(v.real)}): ` +
        `agreement is counted by truthiness, so this would read as a yes — ${UNREADABLE_VOTE}`,
      );
    }
    if (typeof v.reason !== "string") {
      throw new Error(`${where}, from \`${v.verifier}\`, has no \`reason\` (${shapeOf(v.reason)}): ${UNREADABLE_VOTE}`);
    }
    if (v.category !== undefined && !(typeof v.category === "string" && Object.hasOwn(CATEGORY_MEMBERS, v.category))) {
      throw new Error(
        `${where}, from \`${v.verifier}\`, names an unknown \`category\` (${shapeOf(v.category)}): ` +
        `an unrecognised category is not a dropped one, so it would read as a keep — ${UNREADABLE_VOTE}`,
      );
    }
    if (v.severity !== undefined && !(typeof v.severity === "string" && Object.hasOwn(SEVERITY_RANK, v.severity))) {
      throw new Error(
        `${where}, from \`${v.verifier}\`, names an unknown \`severity\` (${shapeOf(v.severity)}): ` +
        `it has no rank, so the severity sort would compare against NaN — ${UNREADABLE_VOTE}`,
      );
    }
    return {
      verifier: v.verifier,
      real: v.real,
      reason: v.reason,
      ...(v.category !== undefined ? { category: v.category as FindingCategory } : {}),
      ...(v.severity !== undefined ? { severity: v.severity as Severity } : {}),
    };
  });
}

export interface JuryConfig {
  groupSize?: number;
  quorum?: number;
}

export interface JuryReading {
  reading: "MEASURED" | "UNMEASURED";
  /** `true` only under a MEASURED reading that cleared the quorum. */
  passed: boolean;
  votes: number;
  agree: number;
  quorum: number;
  groupSize: number;
  /**
   * Every verifier's vote, as cast, in ballot order (#1467, CRC-B4).
   *
   * **The counts above are a summary and this is the record.** Before this
   * field existed, `juryReading` was handed `VerifierVote[]` and returned two
   * integers, so a reading saying *2 of 3* could not say which two agreed or
   * what the third's objection was — and a ledger row built from it carried
   * the same hole. CRC-B4 asks for the individual votes specifically because
   * *"re-running to recover the votes re-samples the thing being measured"*: a
   * verifier is a sampled instrument, so the second ballot is a second draw
   * and not a recovery of the first.
   *
   * Carried on an UNMEASURED reading too. A ballot that could not be counted
   * is still a ballot that was cast, and the votes on it are the only record
   * that a group was convened at all.
   *
   * What it is NOT: evidence the verifiers were independent. Three agent runs
   * behind three ids look exactly like three agents — see this module's
   * header.
   */
  ballot: readonly VerifierVote[];
  /**
   * Did any verifier dissent from any other?
   *
   * **Arithmetically derivable from `agree` and `votes`, and a field anyway**,
   * which is worth stating plainly rather than overselling: it carries no
   * information those two do not. It is first-class for two reasons. CRC-B4
   * names it as one, at decision time — and a consumer computing
   * `agree > 0 && agree < votes` for itself is a second decider over one
   * question, which is the fourth shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`: two deciders that agree
   * are behaviourally one, and nothing can tell which of them is dead.
   *
   * The half that genuinely cannot be recovered from the counts is `ballot`
   * above — *which* verifier dissented, and on what reasoning.
   */
  disagreed: boolean;
  unmeasuredReasons: string[];
}

/**
 * Count the votes.
 *
 * Three ways this refuses rather than deciding, all of them the same doctrine
 * #1187 states for the arbiter — **UNMEASURED fails, it never skips:**
 *
 * - **Fewer votes than the group size.** A verifier that did not report is not
 *   a "no" and not a "yes". Treating a short group as a complete one is how a
 *   quorum of three becomes a quorum of however many happened to answer, and
 *   the outcome looks identical either way.
 * - **A repeated verifier id.** One agent run three times is one opinion.
 * - **A quorum that is not a strict majority.** A configuration error that is
 *   undetectable from any single outcome.
 *
 * **The ballot size must EQUAL the declared group size, not merely reach it.**
 * Accepting an over-size ballot was wrong in the same direction as everything
 * else this module guards: with the 3/2 defaults, five votes of which two
 * agree returned `passed: true` — 2 of 5, which is not a majority of anything,
 * because the quorum was being compared against the *declaration* rather than
 * against the ballot actually counted. A ballot whose cardinality disagrees
 * with its declaration is UNMEASURED, not a smaller or a larger reading. A
 * caller who genuinely convened five verifiers says `groupSize: 5`.
 */
export function juryReading(votes: readonly VerifierVote[], config: JuryConfig = {}): JuryReading {
  const groupSize = config.groupSize ?? VERIFIER_GROUP_SIZE;
  const quorum = config.quorum ?? VERIFIER_QUORUM;
  const agree = votes.filter(v => v.real).length;
  // Written here and on every return below, so there is no path out of this
  // function that produces a reading without the ballot that made it. A
  // refused reading needs it most: it is the only record the group met.
  const base = {
    votes: votes.length,
    agree,
    quorum,
    groupSize,
    ballot: [...votes],
    disagreed: agree > 0 && agree < votes.length,
  };
  const unmeasuredReasons: string[] = [];

  if (quorum * 2 <= groupSize || quorum < 1) {
    unmeasuredReasons.push(`${NON_MAJORITY_QUORUM}: ${quorum} of ${groupSize}`);
  }
  if (votes.length !== groupSize) {
    unmeasuredReasons.push(`${INCOMPLETE_GROUP}: ${votes.length} of ${groupSize}`);
  }
  if (new Set(votes.map(v => v.verifier)).size !== votes.length) {
    unmeasuredReasons.push(REPEATED_VERIFIER);
  }

  if (unmeasuredReasons.length > 0) {
    return { ...base, reading: "UNMEASURED", passed: false, unmeasuredReasons };
  }
  return { ...base, reading: "MEASURED", passed: agree >= quorum, unmeasuredReasons };
}

/**
 * The category the jury reports.
 *
 * **A DROP category requires an outright majority of the real votes; a keep
 * category needs only a plurality.** The asymmetry is the whole function, and
 * it was measured rather than reasoned: under a plain plurality, a group of
 * three that unanimously called a finding real, with **one** member tagging
 * it `cleanup` and two tagging nothing, returned `cleanup` — one voice
 * suppressing a finding the group passed.
 *
 * The source design drops style, diagnostics and cleanup because *the group*
 * said so. A plurality of one is not the group, and the cost of the two error
 * directions is not symmetric: wrongly keeping costs one comment thread,
 * wrongly dropping withholds a real bug and leaves no artefact behind to find
 * it by. So ties resolve toward keep, and a drop that cannot command a
 * majority falls back to the best keep category the verifiers named, and only
 * then to the keyword classifier.
 */
export function juryCategory(
  finding: Pick<Finding, "title" | "body">,
  votes: readonly VerifierVote[],
): FindingCategory {
  const real = votes.filter(v => v.real);
  const tally = new Map<FindingCategory, number>();
  for (const v of real) {
    if (v.category) tally.set(v.category, (tally.get(v.category) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const keep = ranked.find(([category]) => !DROPPED_CATEGORIES.has(category));

  for (const [category, count] of ranked) {
    if (!DROPPED_CATEGORIES.has(category)) return category;
    // A drop needs a strict majority of the real votes, and must not merely
    // tie with a keep category.
    if (count * 2 > real.length && count > (keep?.[1] ?? 0)) return category;
    break;
  }
  return keep?.[0] ?? classifyCategory(finding);
}

/**
 * The severity tag.
 *
 * **`Pre-existing` is decided mechanically and beats any vote**, because it is
 * the one tag of the three that is a fact about the diff rather than a
 * judgement about the defect: a finding whose cited files are all absent from
 * the change is about code the change never touched. Letting a verifier
 * override that would put a judgement in front of a measurement.
 *
 * `changedFiles` absent means the diff was not read, so the pre-existing axis
 * is simply not available — the votes decide, and with no votes carrying a
 * tag the answer is `null` rather than a guessed `Important`.
 */
export function severityOf(
  finding: Pick<Finding, "title" | "body">,
  votes: readonly VerifierVote[],
  changedFiles?: readonly string[],
): Severity | null {
  if (changedFiles !== undefined) {
    const changed = new Set(changedFiles.map(f => f.toLowerCase()));
    const cited = citedPaths(finding);
    if (cited.length > 0 && !cited.some(p => changed.has(p))) return "Pre-existing";
  }
  const tally = new Map<Severity, number>();
  for (const v of votes) {
    if (v.real && v.severity) tally.set(v.severity, (tally.get(v.severity) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || SEVERITY_RANK[a[0]] - SEVERITY_RANK[b[0]]);
  return ranked.length > 0 ? ranked[0][0] : null;
}

/** Repository-shaped paths a finding names, lowercased. Shared with the arbiter's key. */
function citedPaths(finding: Pick<Finding, "title" | "body">): string[] {
  const out = new Set<string>();
  for (const m of `${finding.title}\n${finding.body}`.matchAll(
    /(?:[\w.@-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|md|json|ya?ml|sh)\b/g,
  )) {
    out.add(m[0].toLowerCase());
  }
  return [...out];
}

// ── Where it goes ────────────────────────────────────────────────────────

/**
 * What to do with a finding.
 *
 * `COMMENT` is the default and `ISSUE` is the exception. That is the inversion
 * of what #1187 asked for, and it is the whole correction: a tracker issue is
 * a thing nobody has to answer, so it accumulates; an inline comment blocks
 * the merge until it is fixed or closed with a reason, so it does not.
 */
export type Disposition = "COMMENT" | "ISSUE" | "DROP";

export const DEFAULT_DISPOSITION: Disposition = "COMMENT";

/**
 * The line that makes a comment a gate rather than a remark.
 *
 * The source design's whole mechanism for having no backlog is that **every
 * finding has to be answered** — fixed, or the thread closed with a reason —
 * and the PR cannot merge while one is open. A comment that carries no such
 * obligation is a tracker issue with extra steps.
 */
export const MUST_BE_ANSWERED =
  "Answer this before merge: fix it, or resolve this thread with a reason. " +
  "A reason closes a finding; silence does not.";

/** The inline comment a surviving finding becomes. */
export function renderComment(
  finding: Pick<Finding, "title" | "body">,
  severity: Severity,
  category: FindingCategory,
): string {
  return `**${severity}** · _${category}_ — ${finding.title}\n\n${finding.body}\n\n${MUST_BE_ANSWERED}`;
}
