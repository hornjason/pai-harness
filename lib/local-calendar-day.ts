/**
 * The calendar day, as the person running the command would write it (#600).
 *
 * A LEAF module, in the shape `lib/git-dates.ts` established (#508/#323): one
 * exported binding, nothing imported, so every caller shares one rule and
 * there is exactly one site to mutate when somebody wants to know whether the
 * rule is load-bearing.
 *
 * ## Why this exists
 *
 * `new Date().toISOString().split("T")[0]` is the **UTC** calendar day, and
 * twenty sites in this tree used it to stamp a document with "today". Between
 * 20:00 EDT and midnight the UTC day is already tomorrow, so an evening
 * session stamped `updated:` with a day the work did not happen on — in
 * `PROJECT-STATE.md`, in generated specs, in agent briefs, in `CODE-MAP.md`.
 *
 * It also made #599 intermittent rather than constant, which is the more
 * expensive half. The pre-commit hook only produces a staged diff from
 * `scripts/update-project-state.ts` when the computed date differs from the
 * stored one, so the DA-owned-file violation fired for roughly four hours a
 * day and the other twenty hours of green runs were never evidence of
 * compliance — they were evidence that the clock had not rolled over yet.
 *
 * ## When NOT to use it
 *
 * An INSTANT is not a day. A timestamp recording when something happened —
 * `measuredAt`, a witness `ts`, anything another machine will compare — stays
 * a full UTC ISO string, because the point of those is to be comparable
 * across zones. This function is for the other thing: the human-facing
 * calendar day a document is dated with.
 */

/**
 * Render `at` as `YYYY-MM-DD` in the process's own time zone.
 *
 * `getFullYear`/`getMonth`/`getDate` are the local-time accessors, so the
 * answer follows `TZ`. Note that Bun reads `TZ` once at startup — setting
 * `process.env.TZ` later does not move this, which is why every zone-sensitive
 * case in `test/unit/local-calendar-day.test.ts` is a subprocess.
 */
export function localCalendarDay(at: Date = new Date()): string {
  const [y, m, d] = [at.getFullYear(), at.getMonth() + 1, at.getDate()];
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
