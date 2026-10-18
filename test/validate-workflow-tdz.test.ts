import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Covers AC-3 of #585: a usage written at column zero is detected.
 *
 * The pre-#585 detector matched a usage with `^\s+([A-Z_][A-Z_0-9]*)\s*=\s`.
 * Two separate things made that blind, and a fixture that varies both cannot
 * say which one it is measuring. This file holds the column dimension on its
 * own: ONE source string, and a second derived from it by removing the
 * indentation of the usage line, so the pair cannot diverge in any other
 * character. A hand-written pair can drift — the two halves are two literals,
 * and nothing stops a later edit from changing something else in one of them.
 *
 * The detector is read-blind as well as column-blind, so the usage here is a
 * READ. That is deliberate and it is the fifth shape in
 * .claude/rules/checks-must-be-able-to-fail.md: the cheapest wrong fix for a
 * missed column-zero usage is to widen `^\s+` to `^\s*` in the old
 * assignment-only regex, and an assignment pair goes GREEN under that repair
 * while the shape that crashed ship.js stays undetected. A read pair stays red
 * under it, because the old regex never matched a read at any column.
 *
 * The evidence that the pair measures the column and nothing else is run
 * rather than argued: a mutant copy of the validator with the
 * leading-whitespace requirement restored must still refuse the indented half
 * — the positive control, which also proves the mutant loaded and ran — and
 * must NOT refuse the column-zero half.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const VALIDATOR = join(REPO_ROOT, "scripts", "validate-workflow.ts");

/** The usage line, indented. Everything below is derived from this string. */
const INDENTED = [
  "  console.log(EXEMPT_FLAG)",
  "const EXEMPT_FLAG = true",
  "",
].join("\n");

/** Index of the line whose indentation is the single variable under test. */
const USAGE_LINE = 0;

/**
 * The same bytes with the usage line's leading whitespace removed, and nothing
 * else touched. Derivation, not transcription.
 */
function atColumnZero(src: string): string {
  const lines = src.split("\n");
  lines[USAGE_LINE] = lines[USAGE_LINE].replace(/^[ \t]+/, "");
  return lines.join("\n");
}

const COLUMN_ZERO = atColumnZero(INDENTED);

/**
 * The reporting site in `scripts/validate-workflow.ts`, and the line the
 * pre-#585 `^\s+` amounted to once the detector stopped being a line regex:
 * report a usage only when its line begins with whitespace.
 */
const REPORT_ANCHOR = "    if (usage.deferred && !usage.write) continue;";
const COLUMN_SENSITIVE =
  REPORT_ANCHOR + "\n    if (!/^\\s/.test(lines[usage.line - 1])) continue;";

function anchorHits(src: string): number {
  return src.split(REPORT_ANCHOR).length - 1;
}

describe("validate-workflow.ts — a usage at column zero (#585 AC-3)", () => {
  const source = readFileSync(VALIDATOR, "utf-8");

  let WORK = "";
  let COLUMN_MUTANT = "";
  let indentedFixture = "";
  let columnZeroFixture = "";

  beforeAll(() => {
    WORK = mkdtempSync(join(tmpdir(), "tdz-column-"));

    const hits = anchorHits(source);
    if (hits !== 1) {
      throw new Error(
        `could not build the column-sensitive mutant: the usage-reporting ` +
          `anchor appears ${hits} times in scripts/validate-workflow.ts`,
      );
    }
    COLUMN_MUTANT = join(WORK, "validate-workflow.ts");
    writeFileSync(COLUMN_MUTANT, source.replace(REPORT_ANCHOR, COLUMN_SENSITIVE));

    indentedFixture = join(WORK, "usage-indented.js");
    columnZeroFixture = join(WORK, "usage-column-zero.js");
    writeFileSync(indentedFixture, INDENTED);
    writeFileSync(columnZeroFixture, COLUMN_ZERO);
  });

  afterAll(() => {
    if (WORK) rmSync(WORK, { recursive: true, force: true });
  });

  function run(script: string, target: string) {
    const r = spawnSync("bun", [script, target], { encoding: "utf-8" });
    return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  /**
   * A non-zero exit cannot tell a refusal from a crash or a failed module
   * resolution, so every refusal below is read off the detector's own line as
   * well as the exit code.
   */
  function expectTdzRefusal(result: { code: number; out: string }, where: string) {
    expect(result.out, `${where}: the detector printed no TDZ line\n${result.out}`)
      .toContain("TDZ: 'EXEMPT_FLAG'");
    expect(result.code, `${where}: expected a refusal\n${result.out}`).not.toBe(0);
  }

  test("AC-3: the pair differs only in the indentation of the usage line", () => {
    const a = INDENTED.split("\n");
    const b = COLUMN_ZERO.split("\n");
    expect(b.length, "the derivation changed the line count").toBe(a.length);

    const differing = a
      .map((line, i) => (line === b[i] ? -1 : i))
      .filter((i) => i >= 0);
    expect(
      differing,
      "the derivation touched something other than the usage line",
    ).toEqual([USAGE_LINE]);
    expect(
      b[USAGE_LINE],
      "the two halves differ in more than whitespace",
    ).toBe(a[USAGE_LINE].trimStart());
    expect(a[USAGE_LINE], "the first half is not indented").toMatch(/^[ \t]+\S/);
    expect(b[USAGE_LINE], "the second half is not at column zero").toMatch(/^\S/);
  });

  test("AC-3: the usage-reporting site appears exactly once", () => {
    // A second reporting site would survive the column-sensitive mutation
    // below, and the mutant would then behave like the real script for a
    // reason that has nothing to do with the column.
    expect(
      anchorHits(source),
      "the usage-reporting anchor is not a single site in scripts/validate-workflow.ts",
    ).toBe(1);
  });

  test("AC-3: the indented usage before the declaration is refused", () => {
    expectTdzRefusal(run(VALIDATOR, indentedFixture), "indented");
  });

  test("AC-3: the same usage at column zero is refused", () => {
    expectTdzRefusal(run(VALIDATOR, columnZeroFixture), "column zero");
  });

  test("AC-3: restoring the leading-whitespace requirement blinds the detector to the column-zero half alone", () => {
    // The positive control comes first: a mutant that failed to load prints
    // nothing and exits non-zero, which is indistinguishable from a mutant
    // that refused on the merits. The indented half must still be caught.
    expectTdzRefusal(run(COLUMN_MUTANT, indentedFixture), "mutant, indented");

    const blind = run(COLUMN_MUTANT, columnZeroFixture);
    expect(
      blind.out,
      "the column-sensitive mutant still reported the column-zero usage — " +
        "this pair is not measuring the leading-whitespace requirement",
    ).not.toContain("TDZ: 'EXEMPT_FLAG'");
    expect(blind.code, `the column-sensitive mutant refused anyway\n${blind.out}`).toBe(0);
  });
});
