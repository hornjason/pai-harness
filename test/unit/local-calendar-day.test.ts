/**
 * #600 — the day stamp must be the LOCAL calendar day, not the UTC one.
 *
 * `scripts/update-project-state.ts` stamped `new Date().toISOString()
 * .split("T")[0]`. Between 20:00 EDT and midnight that reads tomorrow, so an
 * evening session records work on a day it did not happen — and it is the
 * half that made #599 visible, because the pre-commit hook only produced a
 * staged diff on the four hours a day when the computed stamp differed from
 * the stored one. A date that is wrong for four hours a day is worse than one
 * that is wrong always: the other twenty hours look like a passing check.
 *
 * Every discriminating case fixes an INSTANT and asks for it in a zone where
 * local and UTC disagree, then asserts the UTC rendering of that same instant
 * IN THE SAME CASE. A zone where the two agree makes the case vacuous
 * (`.claude/rules/checks-must-be-able-to-fail.md`), and the in-case UTC
 * assertion is what makes the fixture say so rather than pass quietly.
 *
 * The default-zone cases run in a SUBPROCESS with `TZ` in its environment.
 * Bun resolves the host zone once per process and caches it — measured:
 * after one default-zone format, assigning `process.env.TZ` changes nothing
 * and `resolvedOptions().timeZone` keeps reporting the original. An
 * in-process `process.env.TZ = ...` fixture therefore asserts the machine's
 * own zone while looking like it asserts Tokyo's, which is exactly the
 * "fixture that reached the assertion without the feature" shape.
 *
 * `LOCAL_CALENDAR_DAY_SOURCE` exists for
 * `test/unit/local-calendar-day-mutation.test.ts`, which spawns this file
 * twice: once against `lib/local-calendar-day.ts` and once against a copy
 * whose body is the UTC stamp this issue removed. Nothing else sets it.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const REAL_SOURCE = join(import.meta.dir, "..", "..", "lib", "local-calendar-day.ts");
const SOURCE = process.env.LOCAL_CALENDAR_DAY_SOURCE || REAL_SOURCE;

const mod = (await import(SOURCE)) as { localCalendarDay?: unknown };
if (typeof mod.localCalendarDay !== "function") {
  // A module that loaded but exports nothing usable would leave every case
  // below throwing an unhelpful "not a function" — say which file it was.
  throw new Error(`local-calendar-day: ${SOURCE} does not export a localCalendarDay function`);
}
const localCalendarDay = mod.localCalendarDay as (at?: Date, timeZone?: string) => string;

/** 23:30 on 2026-03-10 in America/New_York. In UTC it is already 2026-03-11. */
const EVENING_EDT = "2026-03-11T03:30:00.000Z";
/** 00:30 on 2026-03-10 in Asia/Tokyo. In UTC it is still 2026-03-09. */
const EARLY_TOKYO = "2026-03-09T15:30:00.000Z";

/** The stamp the defect produced, written once so no case re-derives it. */
// UTC-INTENTIONAL: this reproduces the DEFECT so each case can assert that the
// two renderings of one instant disagree. It is the subject of the test, not a
// day stamp this project writes anywhere.
const utcDay = (iso: string) => new Date(iso).toISOString().split("T")[0];

/**
 * The stamp the helper produces with NO zone argument, in a process whose
 * `TZ` is `tz`. This is the path every converted call site takes.
 */
function defaultZoneStamp(tz: string, iso: string): string {
  const r = spawnSync(
    "bun",
    ["-e", `const m = await import(process.env.SRC); console.log(m.localCalendarDay(new Date(process.env.AT)));`],
    { encoding: "utf-8", env: { ...process.env, TZ: tz, SRC: SOURCE, AT: iso }, timeout: 60_000 },
  );
  if (r.status !== 0) {
    throw new Error(`defaultZoneStamp(${tz}) exited ${r.status}: ${(r.stderr || "").trim() || "(no stderr)"}`);
  }
  return (r.stdout || "").trim();
}

describe("localCalendarDay (#600)", () => {
  test("23:30 in America/New_York stamps that day, while UTC reads the next one", () => {
    // Both halves in one case on purpose: the claim is that the two
    // renderings of ONE instant disagree and the helper takes the local one.
    expect(utcDay(EVENING_EDT), "fixture no longer straddles UTC midnight").toBe("2026-03-11");
    expect(localCalendarDay(new Date(EVENING_EDT), "America/New_York")).toBe("2026-03-10");
  });

  test("the default zone is the process zone, not UTC — 23:30 EDT", () => {
    // The converted call sites pass no zone, so this is the path they take.
    // Asserting only the explicit-zone overload would leave the default
    // reachable by a route no case covers.
    expect(utcDay(EVENING_EDT), "fixture no longer straddles UTC midnight").toBe("2026-03-11");
    expect(defaultZoneStamp("America/New_York", EVENING_EDT)).toBe("2026-03-10");
  });

  test("00:30 in Asia/Tokyo stamps that day, while UTC reads the previous one", () => {
    // The other direction. A zone ahead of UTC fails differently from one
    // behind it, and a helper that subtracted a fixed offset would pass the
    // two cases above and fail here.
    expect(utcDay(EARLY_TOKYO), "fixture no longer straddles UTC midnight").toBe("2026-03-09");
    expect(localCalendarDay(new Date(EARLY_TOKYO), "Asia/Tokyo")).toBe("2026-03-10");
    expect(defaultZoneStamp("Asia/Tokyo", EARLY_TOKYO)).toBe("2026-03-10");
  });

  test("single-digit months and days are zero-padded to YYYY-MM-DD", () => {
    expect(localCalendarDay(new Date("2026-01-05T12:00:00.000Z"), "UTC")).toBe("2026-01-05");
    expect(localCalendarDay(new Date("2026-12-31T12:00:00.000Z"), "UTC")).toBe("2026-12-31");
  });

  test("called with no argument it stamps now, in the process zone", () => {
    const now = new Date();
    expect(localCalendarDay()).toBe(localCalendarDay(now));
    expect(localCalendarDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("an invalid Date is refused rather than stamped", () => {
    // Intl renders an invalid date as literal "Invalid Date" parts rather
    // than throwing, which would put that text into a frontmatter block.
    expect(() => localCalendarDay(new Date("not a date"))).toThrow(/invalid/i);
  });
});
