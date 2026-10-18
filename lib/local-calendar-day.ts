/**
 * The project's one day stamp (#600).
 *
 * A LEAF module, in the shape `lib/git-dates.ts` established (#508): one
 * exported binding, no relative imports, so there is exactly one thing to
 * mutate and every call site names the same rule.
 *
 * ## Why this exists
 *
 * `new Date().toISOString().split("T")[0]` is the UTC calendar day. Between
 * 20:00 EDT and midnight that is TOMORROW, so an evening session stamps work
 * on a day it did not happen. Twenty sites in this tree did it, and the one
 * that mattered was `scripts/update-project-state.ts`, whose stamp is read
 * back by the pre-commit hook: the hook only produced a staged diff when the
 * computed stamp differed from the stored one, so the DA-owned-file violation
 * of #599 fired for about four hours a day and the other twenty hours of
 * green runs were not evidence of compliance. A date that is wrong for four
 * hours a day is worse than one that is wrong always, because the twenty
 * green hours look like a passing check.
 *
 * ## What it is NOT for
 *
 * Instants. `new Date().toISOString()` — the whole timestamp — is correct and
 * stays correct: an instant is zone-free and UTC is its canonical spelling.
 * This module is only about collapsing an instant to the calendar day a
 * HUMAN would write next to it, and that question has no answer without a
 * zone.
 *
 * ## Why Intl rather than getFullYear/getMonth/getDate
 *
 * The local-getter form is three calls that must each be padded correctly and
 * cannot be pointed at another zone, so a test for the defect would have to
 * mutate `process.env.TZ` and could never assert the explicit-zone case.
 * `formatToParts` answers both from one binding, and `calendar`/
 * `numberingSystem` are pinned so a host default cannot hand back a
 * non-Gregorian year or non-Latin digits.
 */

const PART_FORMAT: Intl.DateTimeFormatOptions = {
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

/**
 * The calendar day `at` falls on, in `timeZone`, as `YYYY-MM-DD`.
 *
 * @param at        the instant to collapse. Defaults to now.
 * @param timeZone  an IANA zone. Defaults to the process zone, which is what
 *                  every call site in this repo wants — the day the person
 *                  running the command is living in.
 */
export function localCalendarDay(at: Date = new Date(), timeZone?: string): string {
  if (Number.isNaN(at.getTime())) {
    // Intl renders an invalid date as literal "Invalid Date" parts rather
    // than throwing, and a frontmatter block reading `updated: Invalid Date`
    // is worse than a crash: it is written, committed, and read as a date.
    throw new Error("localCalendarDay: invalid Date — nothing to stamp");
  }
  const parts = new Intl.DateTimeFormat(
    "en-US",
    timeZone ? { ...PART_FORMAT, timeZone } : PART_FORMAT,
  ).formatToParts(at);
  const of = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
  const year = of("year");
  const month = of("month");
  const day = of("day");
  if (!year || !month || !day) {
    // Only reachable if a host's ICU stops emitting a requested part. Loud,
    // because the alternative is `undefined-undefined-undefined` in a doc.
    throw new Error(
      `localCalendarDay: Intl did not return year/month/day for ${timeZone ?? "the process zone"}`,
    );
  }
  return `${year.padStart(4, "0")}-${month}-${day}`;
}
