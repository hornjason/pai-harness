/**
 * Promotion and eviction for extracted constraint candidates (#544).
 *
 * ## The one criterion enforced here
 *
 * **A candidate that cannot be traced to a dated observation is not
 * promoted.** Evidence is a GATE, not a tiebreak.
 *
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` SC-1939 states the weaker
 * form — *a candidate with no evidence never outranks one that has it* — and
 * this satisfies it a fortiori: an evidence-less candidate never appears in
 * `promoted` at all, at any budget, so there is no ordering in which it can
 * outrank anything.
 *
 * The stronger form is the one the evidence supports. Every rule in this
 * repository's `.claude/rules/` that an agent demonstrably acts on narrates a
 * dated incident — the #70 collision, run `wf_0b15a933-b2b`, the five bugs of
 * 2026-10-06. `agent-principles.md` ships *"verify before asserting"* to every
 * consumer, costs budget in every session, and the learning loop still carries
 * four separate low-rating patterns for failing to do exactly that. A general
 * principle with nothing behind it is not a weak rule; it is a rule that has
 * been measured not to work.
 *
 * ## Eviction is here, not in a follow-up
 *
 * `docs/research/context-management.md` records the measured collapse: rule
 * sets lose effectiveness past roughly sixteen rules, and the threshold is
 * about the TOTAL in context. So a lifecycle that only adds degrades the thing
 * it feeds, and a promoter that cannot evict is a cap with no teeth. The
 * budget cut and the promotion decision are therefore one reading, returned
 * together, with every withheld candidate carrying the reason it lost.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Each escape is asserted as a case in `test/failure-intake-promotion.test.ts`.
 *
 * - **The budget is a COUNT of promoted rules, not max-concurrent-load.**
 *   The spec's budget criterion asks for max-concurrent-load — for every
 *   file in the repository, count the rules whose globs match it, and take
 *   the maximum — and nothing here computes it, because nothing here emits
 *   `paths:` globs yet. A count is strictly more pessimistic than concurrent
 *   load, so this cannot under-report; it can refuse a set that would have
 *   been fine.
 * - **Nothing reads whether the cited evidence still resolves.** The spec's
 *   auto-retirement criterion is not implemented: a candidate citing a commit
 *   that has been rebased away still ranks on its date.
 * - **Recency is the only ranking signal among evidence-backed candidates.**
 *   The spec names four more — whether the governed code changed recently,
 *   the violation count in graded runs, whether the text states a prohibition,
 *   and whether the cited `file:line` resolves. A commit-subject candidate has
 *   no `file:line`, and the other three need producers that do not exist yet.
 *   So "the mechanical evidence score" is currently one term, and saying so is
 *   the difference between a scorer and a sort.
 * - **A rejected hash is permanent and global.** The veto table has no
 *   per-source scoping, so vetoing a sentence mined from a commit also vetoes
 *   the identical sentence if it later appears in a doc. That is the intended
 *   reading of the permanent-veto criterion and is recorded here because it
 *   is a decision, not an accident.
 */
import type { CandidateEvidence } from "./failure-intake";

export interface PromotableCandidate {
  rule: string;
  source: string;
  hash: string;
  /** Absent for a doc-prose candidate. Its absence is the gate below. */
  evidence?: CandidateEvidence;
}

export type WithheldReason =
  /** Vetoed previously, per the table at `reference/rejected-constraints.md`. */
  | "REJECTED"
  /** No dated observation behind it. The criterion this module exists for. */
  | "NO_EVIDENCE"
  /** Evidence-backed, and ranked below the cut. The eviction. */
  | "OVER_BUDGET";

export interface WithheldCandidate {
  candidate: PromotableCandidate;
  reason: WithheldReason;
}

/**
 * The number of mined rules allowed to be active at once.
 *
 * Sixteen, from `docs/research/context-management.md`: effectiveness collapses
 * past roughly that many rules, and the threshold is over the total in
 * context. ONE declaring position — a second literal somewhere else would be a
 * second decider for a question this module answers.
 *
 * Superseded by the spec's max-concurrent-load budget once mined rules carry
 * `paths:`. Until then this is the pessimistic stand-in, and the comment is
 * here so the number is not mistaken for the budget the spec specifies.
 */
export const PROMOTION_BUDGET_RULES = 16;

export const NON_POSITIVE_BUDGET = "NON_POSITIVE_BUDGET";

export interface PromotionReading {
  /**
   * The single discriminator. `unmeasuredReasons` is the other projection of
   * the same computation, so the two cannot disagree.
   */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  budget: number;
  promoted: PromotableCandidate[];
  withheld: WithheldCandidate[];
}

/**
 * THE ordering over evidence-backed candidates. One binding.
 *
 * It deliberately does NOT re-decide whether a candidate has evidence. The
 * gate in `promoteCandidates` answers that, nothing evidence-less reaches this
 * comparator, and a second evidence clause here would be unreachable code
 * agreeing with a decision already taken — which is the fourth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md` built in on purpose.
 *
 * Dates are parsed, never compared as strings. `git log --format=%cI` emits
 * whatever offset the committer's machine had: `main` carries
 * `2026-10-21T19:18:27Z` and `2026-10-21T15:01:51-04:00` on adjacent commits,
 * and those two sort in the wrong order lexicographically while naming almost
 * the same instant.
 */
export function rankForPromotion(a: PromotableCandidate, b: PromotableCandidate): number {
  const ta = epoch(a);
  const tb = epoch(b);
  if (ta !== tb) return tb - ta;
  // Stable and content-derived, so two runs over one history agree byte for
  // byte. Falling back to input order would make the output depend on the
  // walk, which is the idempotency SC-1946 asks for, lost for free.
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

function epoch(c: PromotableCandidate): number {
  const parsed = c.evidence ? Date.parse(c.evidence.date) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Decide what gets promoted, and say why everything else did not.
 *
 * Three questions, in order, each with one binding: has this been vetoed, does
 * it carry evidence, and does it fit. They are not three readings of one fact
 * — a vetoed candidate and an evidence-less one lose for different reasons and
 * a reader can act on only one of them.
 *
 * `upstream` folds in the intake's own reading. A promotion computed over a
 * shallow clone's candidates is not a smaller promotion, it is a promotion
 * over an unknown population, and `0 promoted` from a truncated history reads
 * exactly like `0 promoted` from a repository with nothing to promote.
 */
export function promoteCandidates(
  candidates: PromotableCandidate[],
  options: {
    budget: number;
    rejectedHashes?: ReadonlySet<string>;
    upstream?: { reading: "MEASURED" | "UNMEASURED"; unmeasuredReasons: string[] };
  },
): PromotionReading {
  const { budget } = options;
  const rejected = options.rejectedHashes ?? new Set<string>();
  const unmeasuredReasons = [...(options.upstream?.unmeasuredReasons ?? [])];

  const withheld: WithheldCandidate[] = [];
  const eligible: PromotableCandidate[] = [];

  for (const candidate of candidates) {
    if (rejected.has(candidate.hash)) {
      withheld.push({ candidate, reason: "REJECTED" });
      continue;
    }
    if (!candidate.evidence) {
      withheld.push({ candidate, reason: "NO_EVIDENCE" });
      continue;
    }
    eligible.push(candidate);
  }

  if (budget < 1) {
    unmeasuredReasons.push(NON_POSITIVE_BUDGET);
    for (const candidate of eligible) withheld.push({ candidate, reason: "OVER_BUDGET" });
    return { reading: "UNMEASURED", unmeasuredReasons, budget, promoted: [], withheld };
  }

  const ranked = [...eligible].sort(rankForPromotion);
  for (const candidate of ranked.slice(budget)) {
    withheld.push({ candidate, reason: "OVER_BUDGET" });
  }

  return {
    reading: unmeasuredReasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons,
    budget,
    promoted: ranked.slice(0, budget),
    withheld,
  };
}

/** One line a caller can print without re-deriving any of the above. */
export function promotionSummary(reading: PromotionReading): string {
  const counts = new Map<WithheldReason, number>();
  for (const w of reading.withheld) counts.set(w.reason, (counts.get(w.reason) ?? 0) + 1);
  const why = [...counts.entries()].map(([r, n]) => `${r}=${n}`).join(" ");
  return (
    `promotion ${reading.reading}: ${reading.promoted.length} promoted of budget ${reading.budget}` +
    (why ? `, withheld ${why}` : "") +
    (reading.unmeasuredReasons.length > 0 ? ` — ${reading.unmeasuredReasons.join("; ")}` : "")
  );
}
