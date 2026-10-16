/**
 * The two AC-quality readings `gates/workflow.test.ts` used to compute inline
 * and then `console.warn` about (#423).
 *
 * #183 audited the ported check list and found four checks that warn without
 * asserting. Two were documented decisions. These two were not: they were
 * `tsc-pass`'s shape — a name promising a verdict over a body that cannot
 * produce one — and they sat in `WARN_TIER_CHECKS` with a reason reading
 * "reported, not fixed".
 *
 * #423 settles them in opposite directions, and the reason they go different
 * ways is the whole point of separating the READING from the VERDICT:
 *
 * - `outcomeEvidenceViolations` now **refuses**. An OUTCOME AC records that a
 *   user-visible outcome was observed; a bare number cannot establish one, and
 *   `0`, `{}`, `null` and `SKIP` being indistinguishable from success is the
 *   *Silent Default Substitution* anti-pattern this repo already names in
 *   `.claude/rules/config-access.md`. Its sibling two tests above it,
 *   `outcome-acs-no-skip`, has always asserted.
 *
 * - `goalKeywordCoverage` stays a **warning**, and that is now a measured
 *   decision rather than a deferral. Measured over the 153 `workflow-state.json`
 *   files under `~/.rungate` carrying a goal: **71% of real runs** fall under
 *   the 50% threshold, median coverage 38%. Restricting to states whose ACs
 *   carry real statements (>80 chars) gives 66% of 131, median 41%; >300 chars
 *   gives 73% of 101. The number does not move. A check that would refuse two
 *   runs in three is not a gate, it is an outage, and a stopword-filtered
 *   substring match over prose is the same basis #409 Decision #9 already
 *   rejected for `spec-decision-compliance`.
 *
 * Both are here rather than inline in the gate suite for the reason
 * `.claude/rules/checks-must-be-able-to-fail.md` gives: one exported binding
 * per reading, so there is exactly one thing to mutate and the test can drive
 * both sides of it without a workflow run.
 */

/** An AC as the gate suite sees it — untyped on the wire, so read defensively. */
interface LooseAc {
  id?: unknown;
  type?: unknown;
  verdict?: unknown;
  statement?: unknown;
  evidence?: { content?: unknown } | null;
}

function asAcs(acs: unknown): LooseAc[] {
  return Array.isArray(acs) ? (acs as LooseAc[]) : [];
}

/**
 * Evidence that is a bare measurement — a number and nothing a reader could
 * check.
 *
 * Deliberately wider than the `/^\d+$/` the inline body used. That form read
 * `3` as numeric-only and `3/3`, `12%`, `0.0` and `-1` as behavioural, which
 * is the second shape in `.claude/rules/checks-must-be-able-to-fail.md`: a
 * detector narrower than what it detects, where a reformat of the same
 * non-answer walks straight through. The question is whether the evidence
 * contains a WORD, so that is what is asked.
 */
export function isBareMeasurement(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (trimmed === "") return false; // absence is a different check's question
  return !/[a-z]/i.test(trimmed);
}

/**
 * OUTCOME ACs marked PASS whose evidence is a bare measurement.
 *
 * **Absent evidence is deliberately out of scope.** `all-acs-have-evidence`
 * exempts OUTCOME ACs from mechanical evidence at ship time by design — they
 * are verified live at prove — so reporting absence here would duplicate a
 * decision another check already owns, and two deciders answering one question
 * are behaviourally one (the fourth shape, #420). This one answers: when there
 * IS evidence, does it say anything.
 */
export function outcomeEvidenceViolations(acs: unknown): string[] {
  return asAcs(acs)
    .filter(ac => ac.type === "OUTCOME" && ac.verdict === "PASS")
    .filter(ac => isBareMeasurement(ac.evidence?.content))
    .map(ac => `${String(ac.id ?? "?")}: evidence is ${JSON.stringify(String(ac.evidence?.content ?? "")).slice(0, 40)}`);
}

/** The words in a goal worth asking about: long enough to mean something. */
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "been",
  "will", "must", "when", "into", "also", "each", "than",
]);

/** ADR-009 C4's threshold, warned under — never refused. See the file docblock. */
export const GOAL_COVERAGE_WARN_BELOW = 0.5;

export interface GoalCoverage {
  keywords: string[];
  covered: string[];
  coverage: number;
}

/**
 * How much of the issue goal's vocabulary the ACs repeat (ADR-009 C4).
 *
 * `null` when there is nothing to ask — no goal, or a goal of nothing but
 * short words. A caller must not read that as full coverage; it is the
 * difference between measuring zero and not measuring, which is the
 * distinction `.claude/rules/config-access.md` calls out by name.
 */
export function goalKeywordCoverage(goal: unknown, acs: unknown): GoalCoverage | null {
  if (typeof goal !== "string" || goal.trim() === "") return null;
  const keywords = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w));
  if (keywords.length === 0) return null;
  const acText = asAcs(acs).map(ac => String(ac.statement ?? "").toLowerCase()).join(" ");
  const covered = keywords.filter(kw => acText.includes(kw));
  return { keywords, covered, coverage: covered.length / keywords.length };
}
