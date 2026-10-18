/**
 * #600 — the proof that `test/unit/local-calendar-day.test.ts` can fail.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: before you trust a check,
 * break the thing it guards and watch it go red. The thing guarded here is
 * one function, so the break is one function — the UTC stamp this issue
 * removed, restored inside `localCalendarDay` — and the 23:30 suite is
 * SPAWNED twice against one argv, differing only in
 * `LOCAL_CALENDAR_DAY_SOURCE`.
 *
 * Four properties, all asserted rather than left as conventions:
 *
 * - **The mutation is proven to change behaviour before any count is read.**
 *   A 0 and a mutation that was never applied look identical. The
 *   distinguishing input is named, run against both sources, and the two
 *   answers compared, before the suites are spawned at all.
 * - **The signature appears exactly once**, so no second day-stamp rule can
 *   survive the mutation and hold the suite up.
 * - **The module has no relative imports**, so the mutant runs from a temp
 *   directory. Without that a later `from "../x"` would make the mutant die
 *   on module resolution, and a suite that failed to load reports no
 *   failures — indistinguishable from a mutant nothing caught.
 * - **`ran` is read before any verdict.** Both spawns must come back with the
 *   whole case list; a suite that never loaded is 0 fail.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractTestFailureCount } from "../../gates/gate-executor";

const ROOT = join(import.meta.dir, "..", "..");
const HELPER = join(ROOT, "lib", "local-calendar-day.ts");
const SUITE = join(ROOT, "test", "unit", "local-calendar-day.test.ts");

/** The one binding this file mutates. Declared as a literal so a rename aborts. */
const SIGNATURE = "export function localCalendarDay(at: Date = new Date(), timeZone?: string): string {";

/**
 * The defect, restored. The marker travels with the line into the generated
 * mutant, where it is equally true — this is the bug #600 removed, rebuilt so
 * the suite can be seen going red against it, and never written back to lib/.
 */
const RESTORED_UTC_BODY = `
  void timeZone;
  // UTC-INTENTIONAL: the restored #600 defect, built only inside a temp-dir mutant
  return at.toISOString().split("T")[0];
}
`;

function buildRestoredUtcMutant(source: string): string {
  const occurrences = source.split(SIGNATURE).length - 1;
  if (occurrences !== 1) {
    throw new Error(`could not build the mutant: the binding signature appears ${occurrences} times`);
  }
  const relativeImports = source.match(/from\s+["']\.{1,2}\//g) ?? [];
  if (relativeImports.length > 0) {
    throw new Error(
      `could not build the mutant: ${HELPER} grew ${relativeImports.length} relative import(s), ` +
        `so a mutant in a temp directory would die on module resolution rather than on the mutation`,
    );
  }
  return source.slice(0, source.indexOf(SIGNATURE)) + SIGNATURE + RESTORED_UTC_BODY;
}

function withMutant<T>(fn: (mutantPath: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lcd-mutant-"));
  try {
    const path = join(dir, "local-calendar-day.ts");
    writeFileSync(path, buildRestoredUtcMutant(readFileSync(HELPER, "utf-8")));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One instant, one zone, through whichever source is named. */
function stampVia(source: string, iso: string, tz: string): string {
  const r = spawnSync(
    "bun",
    ["-e", `const m = await import(process.env.SRC); console.log(m.localCalendarDay(new Date(process.env.AT), process.env.TZNAME));`],
    { encoding: "utf-8", cwd: ROOT, env: { ...process.env, SRC: source, AT: iso, TZNAME: tz }, timeout: 60_000 },
  );
  if (r.status !== 0) throw new Error(`stampVia(${source}) exited ${r.status}: ${(r.stderr || "").trim()}`);
  return (r.stdout || "").trim();
}

function runSuite(source: string): { ran: number; failures: number; out: string } {
  const r = spawnSync("bun", ["test", SUITE], {
    encoding: "utf-8",
    cwd: ROOT,
    env: { ...process.env, LOCAL_CALENDAR_DAY_SOURCE: source },
    timeout: 300_000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  const failures = extractTestFailureCount(out);
  return { ran: pass + failures, failures, out };
}

/** 23:30 on 2026-03-10 in America/New_York; 2026-03-11 in UTC. */
const STRADDLING_INSTANT = "2026-03-11T03:30:00.000Z";

describe("local-calendar-day mutation battery (#600)", () => {
  test("the mutant and the original differ on a named input", () => {
    // Read this row before any count below. A mutation that changes nothing
    // produces the same zeros as a mutation nothing catches.
    const real = stampVia(HELPER, STRADDLING_INSTANT, "America/New_York");
    const mutant = withMutant(path => stampVia(path, STRADDLING_INSTANT, "America/New_York"));
    expect(real).toBe("2026-03-10");
    expect(mutant).toBe("2026-03-11");
    expect(mutant).not.toBe(real);
  }, 120_000);

  test("the baseline suite runs every case and is 0 fail", () => {
    // The instrument. An empty or shrunken baseline means the measurement
    // stopped reporting, and every mutation row below is then meaningless.
    const baseline = runSuite(HELPER);
    expect(baseline.ran, `the suite never loaded:\n${baseline.out}`).toBeGreaterThanOrEqual(4);
    expect(baseline.failures, baseline.out).toBe(0);
  }, 300_000);

  test("restoring the UTC stamp inside the helper turns the suite red", () => {
    const baseline = runSuite(HELPER);
    const mutated = withMutant(runSuite);
    expect(mutated.ran, `the mutant suite never loaded:\n${mutated.out}`).toBe(baseline.ran);
    console.log(
      `local-calendar-day mutation: baseline ${baseline.ran - baseline.failures} pass / ${baseline.failures} fail; ` +
        `restored-UTC mutant ${mutated.ran - mutated.failures} pass / ${mutated.failures} fail of ${mutated.ran}`,
    );
    expect(baseline.failures).toBe(0);
    expect(mutated.failures).toBeGreaterThanOrEqual(2);
    // Named, so a later case that goes red for an unrelated reason cannot
    // quietly substitute for one of these.
    expect(mutated.out).toContain("23:30 in America/New_York");
    expect(mutated.out).toContain("the default zone is the process zone");
    expect(mutated.out).toContain("00:30 in Asia/Tokyo");
  }, 300_000);

  test("a renamed binding aborts the build rather than measuring nothing", () => {
    // A mutation harness that silently no-ops when its target moves is the
    // decorative check this whole exercise is about.
    expect(() => buildRestoredUtcMutant("export function someoneRenamedIt() {}\n")).toThrow(
      /the binding signature appears 0 times/,
    );
  });

  test("a relative import in the helper aborts the build", () => {
    const withImport = `import { x } from "../x";\n${SIGNATURE}\n  return "";\n}\n`;
    expect(() => buildRestoredUtcMutant(withImport)).toThrow(/relative import/);
  });
});
