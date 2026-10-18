/**
 * Covers AC-1, AC-2 (#600) — the local-calendar-day helper.
 *
 * `new Date().toISOString().split("T")[0]` is the UTC calendar day. Between
 * 20:00 EDT and midnight that is TOMORROW, so an evening session records work
 * on a day it did not happen. Every case here fixes a real instant and a real
 * zone and asserts the two renderings DISAGREE, because a zone where local and
 * UTC agree makes the case vacuous — it would pass over the defect
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 *
 * ## Why every case is a subprocess
 *
 * Bun reads `TZ` once, at startup: setting `process.env.TZ` afterwards does
 * nothing. Measured on bun 1.3.14 — a `Date` built under `TZ=Asia/Tokyo`
 * reports the same `getHours()` after `process.env.TZ = "America/New_York"`.
 * So a case that wants a zone has to be a process that was STARTED in it,
 * and the ambient zone of the machine running the suite is not allowed to
 * decide any verdict here.
 *
 * ## Why the module under test is an env var
 *
 * `test/unit/local-calendar-day-mutation.test.ts` spawns this whole file
 * twice — once against `lib/local-calendar-day.ts` and once against a mutant
 * with the UTC stamp restored — with one variable differing between the runs.
 * Without that, the mutation case would have to re-state these assertions and
 * the two copies would drift.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The module the probe imports. Absolute, so the probe can live in a temp
 * directory with no relative specifier to resolve — the property
 * `.claude/rules/checks-must-be-able-to-fail.md` demands of any mutant, so a
 * mutant that died on module resolution cannot read as a refusal.
 */
export const SOURCE_UNDER_TEST = process.env.LOCAL_CALENDAR_DAY_SOURCE
  ? resolve(process.env.LOCAL_CALENDAR_DAY_SOURCE)
  : join(ROOT, "lib", "local-calendar-day.ts");

let probeDir: string;
let probe: string;

/**
 * Printed by the probe for every instant: what the helper says, and what the
 * UTC rendering of the SAME instant says. One process, one `Date`, so the two
 * readings cannot differ by anything except the rule that produced them.
 */
interface Reading {
  local: string;
  utc: string;
  noArgLocal: string;
}

beforeAll(() => {
  probeDir = mkdtempSync(join(tmpdir(), "local-calendar-day-probe-"));
  probe = join(probeDir, "probe.ts");
  writeFileSync(
    probe,
    `const [, , source, iso] = process.argv;
const mod = await import(source);
const at = new Date(iso);
// UTC-INTENTIONAL: this is the CONTRAST reading, not a stamp. The whole point
// of the case is that the UTC rendering of this instant names a different day
// from the helper's, so it must be derived the old way on purpose.
const utc = at.toISOString().split("T")[0];
console.log(JSON.stringify({ local: mod.localCalendarDay(at), utc, noArgLocal: mod.localCalendarDay() }));
`,
  );
});

afterAll(() => {
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
});

function readingAt(tz: string, iso: string): Reading {
  const run = spawnSync("bun", [probe, SOURCE_UNDER_TEST, iso], {
    cwd: probeDir,
    env: { ...process.env, TZ: tz },
    encoding: "utf-8",
    timeout: 60_000,
  });
  // A probe that failed to start is not a reading. Without this the next line
  // throws a JSON parse error and the case reports a confusing red for a true
  // but unrelated reason.
  if (run.status !== 0) {
    throw new Error(
      `probe exited ${run.status} under TZ=${tz} for ${iso}: ${(run.stderr || "").trim() || "(no stderr)"}`,
    );
  }
  const out = (run.stdout || "").trim().split("\n").filter(Boolean).pop();
  if (!out) throw new Error(`probe printed nothing under TZ=${tz} for ${iso}`);
  return JSON.parse(out) as Reading;
}

describe("localCalendarDay (#600)", () => {
  test("23:30 in America/New_York stamps that day while UTC already reads the next one", () => {
    // 2026-09-15T03:30:00Z is 23:30 EDT on 2026-09-14 — the window the defect
    // lives in, and the one that made #599 visible for about four hours a day.
    const r = readingAt("America/New_York", "2026-09-15T03:30:00.000Z");
    expect(r.local).toBe("2026-09-14");
    expect(r.utc).toBe("2026-09-15");
    // Asserted in the same case: if these ever agree the case is vacuous and
    // proves nothing about which rule produced `local`.
    expect(r.local).not.toBe(r.utc);
  });

  test("midnight UTC stamps the PREVIOUS day in America/New_York", () => {
    const r = readingAt("America/New_York", "2026-07-04T00:00:00.000Z");
    expect(r.local).toBe("2026-07-03");
    expect(r.utc).toBe("2026-07-04");
    expect(r.local).not.toBe(r.utc);
  });

  test("the error runs the other way too — 08:30 in Asia/Tokyo stamps the day UTC still calls yesterday", () => {
    // East of UTC the UTC stamp is behind, not ahead. A helper that merely
    // subtracted a fixed offset would pass the two cases above and fail here.
    const r = readingAt("Asia/Tokyo", "2026-02-09T23:30:00.000Z");
    expect(r.local).toBe("2026-02-10");
    expect(r.utc).toBe("2026-02-09");
    expect(r.local).not.toBe(r.utc);
  });

  test("under TZ=UTC the helper agrees with the UTC rendering", () => {
    // The positive control. It is the one case a restored-UTC mutant must
    // still pass: a suite that failed to load reports no failures at all, and
    // a mutation row of "everything red" cannot be told apart from that.
    const r = readingAt("UTC", "2026-09-15T03:30:00.000Z");
    expect(r.local).toBe("2026-09-15");
    expect(r.utc).toBe("2026-09-15");
  });

  test("the stamp is zero-padded YYYY-MM-DD", () => {
    const r = readingAt("UTC", "2026-01-05T12:00:00.000Z");
    expect(r.local).toBe("2026-01-05");
    expect(r.local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("called with no argument it stamps the current local day", () => {
    const r = readingAt("UTC", "2026-01-05T12:00:00.000Z");
    expect(r.noArgLocal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // UTC-INTENTIONAL: the probe ran under TZ=UTC, so "now, locally" and
    // "now, in UTC" are the same day by construction and this is checkable
    // without racing the clock or importing the thing under test.
    expect(r.noArgLocal).toBe(new Date().toISOString().slice(0, 10));
  });
});
