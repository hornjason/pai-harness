/**
 * The security review in HARNESS-STANDARD.md is unconditional (#129, sub-issue 2)
 *
 * SC-570 (HARNESS-STANDARD.md)
 *
 * `workflows/ship.js:1965` defines `runRookReview()` with no skip condition —
 * deliberately, and with a comment saying so, because the previous gate
 * (`ceremonyTier === 'THOROUGH'`) was unreachable for every CLI and library
 * project and rook had been spawned 0 times across 3,555 workflow agents
 * (#126, #127).
 *
 * The spec still said "If M+ size → spawn Rook" and "Rook PASS if M+". A spec
 * that gates the security review on issue size, over code that does not, is
 * the documented permission to skip it — it is the exact sentence someone
 * reaches for when they want the review not to run.
 *
 * These assertions grep the spec rather than execute it because a markdown
 * standard has no runtime. The behaviour they describe is executed in
 * workflows/ship.js; see test/ship-*.test.ts for that side.
 *
 * Shown to fail: before the edit, the §5 process list, the Quality bar line
 * and the VERIFICATION mermaid node each carried an "M+" qualifier, and every
 * assertion below reported the offending line.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(REPO_ROOT, "specs", "HARNESS-STANDARD.md");
const specLines = readFileSync(SPEC_PATH, "utf-8").split("\n");

/** A line that talks about rook or about the security review/scan step. */
const MENTIONS_SECURITY_REVIEW = /\brook\b|security\s+(review|scan)/i;

/**
 * A size qualifier: "M+", "if M+ size", "L size", "(if M+)", "M or larger".
 * Deliberately broad — any way of saying "only for big issues" is the defect.
 */
const SIZE_CONDITION =
  /\b(?:X?[SML])\s*\+|\bif\s+(?:X?[SML])\b|\b(?:X?[SML])\s+size\b|\bsize\b|\bconditional\b|\bor\s+larger\b/i;

function securityLines(): { n: number; text: string }[] {
  return specLines
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => MENTIONS_SECURITY_REVIEW.test(l.text));
}

function lineContaining(needle: string | RegExp): { n: number; text: string } {
  const matches = (text: string) =>
    typeof needle === "string" ? text.includes(needle) : needle.test(text);
  const hit = specLines.map((text, i) => ({ n: i + 1, text })).filter((l) => matches(l.text));
  expect(
    hit.map((l) => l.n),
    `expected exactly one line matching ${needle} in ${SPEC_PATH}`,
  ).toHaveLength(1);
  return hit[0];
}

describe("HARNESS-STANDARD.md security review is unconditional", () => {
  test("the spec mentions the security review at all", () => {
    // Guards the greps below against passing vacuously if the spec is
    // renamed, moved, or emptied (.claude/rules/checks-must-be-able-to-fail.md).
    expect(securityLines().length).toBeGreaterThan(0);
  });

  test("no line mentioning rook or the security review carries a size condition", () => {
    const offenders = securityLines()
      .filter((l) => SIZE_CONDITION.test(l.text))
      .map((l) => `${SPEC_PATH}:${l.n}: ${l.text.trim()}`);
    expect(offenders).toEqual([]);
  });

  test("the stale M+ phrasings are gone", () => {
    const spec = specLines.join("\n");
    expect(spec).not.toContain("If M+ size → spawn Rook");
    expect(spec).not.toContain("Rook PASS if M+");
  });

  test("§5 process list spawns Rook unconditionally", () => {
    const step = lineContaining(/spawn Rook/i);
    expect(step.text).toMatch(/every ship run|always|unconditional/i);
    expect(SIZE_CONDITION.test(step.text)).toBe(false);
  });

  test("the Quality bar requires Rook PASS with no qualifier", () => {
    const bar = lineContaining("**Quality bar:** ALL ACs have evidence");
    expect(bar.text).toMatch(/Rook (must )?PASS/i);
    expect(SIZE_CONDITION.test(bar.text)).toBe(false);
  });

  test("the VERIFICATION mermaid node shows the security review with no size condition", () => {
    const node = lineContaining('VERIFICATION["5. VERIFICATION');
    expect(node.text).toMatch(/Rook security/i);
    // The node legitimately carries other conditions (Quinn, consumer); only
    // the rook branch of it must be unqualified.
    const rookBranch = node.text
      .split("<br/>")
      .filter((seg) => MENTIONS_SECURITY_REVIEW.test(seg));
    expect(rookBranch.length).toBeGreaterThan(0);
    expect(rookBranch.filter((seg) => SIZE_CONDITION.test(seg))).toEqual([]);
  });
});
