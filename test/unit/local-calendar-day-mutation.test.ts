/**
 * Covers AC-4 (#600) — the local-calendar-day suite is proven able to fail.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: before you trust a check,
 * restore the defect and watch it go red. The defect here is one line — the
 * UTC day stamp inside `localCalendarDay` — so the mutant is that line put
 * back, and `test/unit/local-calendar-day.test.ts` is SPAWNED twice against
 * one argv differing only in `LOCAL_CALENDAR_DAY_SOURCE`.
 *
 * Four properties, each asserted here rather than left as a convention:
 *
 * - **The mutation is proven to change behaviour before any count is read.**
 *   A row of zeros from a mutant that was never really applied is
 *   indistinguishable from a row of zeros from a check that cannot fail
 *   (#485, #297), so the first case names an input — 23:30 EDT on
 *   2026-09-14 — and shows real and mutant disagreeing on it.
 * - **The baseline is read before any mutation row.** An instrument that
 *   stopped reporting takes the baseline down with it (#60), and the baseline
 *   is the row nobody checks.
 * - **`ran` is established before any verdict.** A suite that failed to load
 *   reports no failures, which reads exactly like a suite that passed.
 * - **Red and green are compared by NAME, not by count.** "2 of 6" is
 *   satisfied by any two. The TZ=UTC control must stay GREEN under the
 *   mutant, because under UTC the two rules agree and a mutation that turned
 *   everything red would mean the mutant was broken, not that the suite
 *   measures the zone.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(import.meta.dir, "..", "..");
const HELPER = join(ROOT, "lib", "local-calendar-day.ts");
const SUITE = join(ROOT, "test", "unit", "local-calendar-day.test.ts");

/**
 * The one line that makes the helper local. Declared here as a literal so the
 * mutation has a single site; if it moves or is duplicated the builder throws
 * and this whole file ABORTS rather than passing quietly over a mutation that
 * was never applied.
 */
const LOCAL_READING = "const [y, m, d] = [at.getFullYear(), at.getMonth() + 1, at.getDate()];";

/**
 * The defect, restored. UTC-INTENTIONAL: this string is the pre-#600 stamp
 * written out on purpose — it is the mutant, not a day stamp this repo uses.
 */
const UTC_READING = 'const [y, m, d] = at.toISOString().slice(0, 10).split("-").map(Number);';

/** The instant the whole issue is about: 23:30 EDT on 2026-09-14. */
const EVENING = "2026-09-15T03:30:00.000Z";

let dir: string;
let mutant: string;
let probe: string;

function buildMutant(): string {
  const source = readFileSync(HELPER, "utf-8");
  const hits = source.split(LOCAL_READING).length - 1;
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the local reading appears ${hits} times in ${HELPER}, expected exactly 1`,
    );
  }
  const mutated = source.replace(LOCAL_READING, UTC_READING);
  // A mutant byte-identical to the original is not a mutant.
  if (mutated === source) throw new Error("could not build the mutant: the replacement changed nothing");
  return mutated;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-calendar-day-mutant-"));
  mutant = join(dir, "local-calendar-day.mutant.ts");
  writeFileSync(mutant, buildMutant());
  probe = join(dir, "probe.ts");
  writeFileSync(
    probe,
    `const [, , source, iso] = process.argv;
const mod = await import(source);
process.stdout.write(mod.localCalendarDay(new Date(iso)));
`,
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function stampFrom(source: string, tz: string, iso: string): string {
  const run = spawnSync("bun", [probe, source, iso], {
    cwd: dir,
    env: { ...process.env, TZ: tz },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (run.status !== 0) {
    throw new Error(`probe exited ${run.status}: ${(run.stderr || "").trim() || "(no stderr)"}`);
  }
  return (run.stdout || "").trim();
}

interface SuiteRun {
  pass: number;
  fail: number;
  /** The names bun printed on `(fail)` lines — the membership, not the count. */
  failed: string[];
  output: string;
}

function runSuiteAgainst(source: string): SuiteRun {
  const run = spawnSync("bun", ["test", SUITE], {
    cwd: ROOT,
    env: { ...process.env, LOCAL_CALENDAR_DAY_SOURCE: source },
    encoding: "utf-8",
    timeout: 300_000,
  });
  const output = `${run.stdout || ""}\n${run.stderr || ""}`;
  const pass = /^\s*(\d+) pass\b/m.exec(output);
  const fail = /^\s*(\d+) fail\b/m.exec(output);
  // An unreadable summary is not a zero. #60: when the instrument stops
  // reporting, every row — including the baseline — comes back blank, and a
  // blank read as 0 is the most expensive mistake this method can make.
  if (!pass || !fail) {
    throw new Error(`could not read the suite summary from the run against ${source}:\n${output.slice(-2000)}`);
  }
  const failed = output
    .split("\n")
    .filter(l => l.includes("(fail)"))
    .map(l => l.slice(l.indexOf("(fail)") + "(fail)".length).trim());
  return { pass: Number(pass[1]), fail: Number(fail[1]), failed, output };
}

let real: SuiteRun;
let mutated: SuiteRun;

describe("local-calendar-day mutation battery (#600)", () => {
  test("the mutation changes behaviour on a named input", () => {
    // Before believing any count: name an input on which mutant and original
    // differ, and run it.
    const realStamp = stampFrom(HELPER, "America/New_York", EVENING);
    const mutantStamp = stampFrom(mutant, "America/New_York", EVENING);
    expect(realStamp).toBe("2026-09-14");
    expect(mutantStamp).toBe("2026-09-15");
    expect(realStamp).not.toBe(mutantStamp);
  }, 120_000);

  test("baseline — the unmutated suite is 0 fail, and every case ran", () => {
    real = runSuiteAgainst(HELPER);
    expect(real.fail).toBe(0);
    // Read before the verdict: a suite that never loaded also reports 0 fail.
    expect(real.pass).toBeGreaterThanOrEqual(6);
  }, 300_000);

  test("the restored-UTC mutant turns at least 2 cases red, and the UTC control stays green", () => {
    mutated = runSuiteAgainst(mutant);
    // Same number of cases as the baseline, so the reds are verdicts rather
    // than a suite that half-loaded.
    expect(mutated.pass + mutated.fail).toBe(real.pass + real.fail);
    expect(mutated.fail).toBeGreaterThanOrEqual(2);
    // The baseline named no failures, so the membership below is caused by
    // the mutation and not by a case that was already red.
    expect(real.failed).toEqual([]);

    // By NAME, not by count. "2 of 6" is satisfied by any two; only these are
    // the zone-sensitive cases, and only they mean what this claims.
    const red = mutated.failed.join("\n");
    expect(red).toContain("23:30 in America/New_York");
    expect(red).toContain("midnight UTC stamps the PREVIOUS day");
    expect(red).toContain("Asia/Tokyo");

    // The positive control. Under TZ=UTC both rules name the same day, so a
    // working mutant leaves this one passing; if it went red the mutant would
    // be broken rather than the suite discriminating.
    expect(red).not.toContain("under TZ=UTC the helper agrees");
  }, 300_000);
});
