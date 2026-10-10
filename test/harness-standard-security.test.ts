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
const specText = readFileSync(SPEC_PATH, "utf-8");
const specLines = specText.split("\n");

/** A line that talks about rook or about the security review/scan step. */
const MENTIONS_SECURITY_REVIEW = /\brook\b|security\s+(review|scan)/i;

/**
 * A size qualifier: "M+", "if M+ size", "L size", "(if M+)", "M or larger".
 * Deliberately broad — any way of saying "only for big issues" is the defect.
 */
const SIZE_CONDITION =
  /\b(?:X?[SML])\s*\+|\bif\s+(?:X?[SML])\b|\b(?:X?[SML])\s+size\b|\bsize\b|\bconditional\b|\bor\s+larger\b/i;

/**
 * Drop clauses that DENY a condition before looking for one.
 *
 * "Not conditional on size and not conditional on having a UI" is the spec
 * saying exactly what SC-570 asks for, and a bag-of-tokens matcher reads it as
 * the violation because the words `conditional` and `size` are in it. Same
 * root shape as #141 and #158 in `detect-sc-drift`: a statement parsed as
 * tokens rather than as a sequence of clauses. Each negation runs to the next
 * sentence boundary, so only the denial is removed.
 */
function dropNegatedConditions(text: string): string {
  return text
    .replace(/\bnot\s+(?:conditional|gated|dependent)\s+on\s+[^.,;]*/gi, "")
    .replace(/\bno\s+(?:size|tier)\s+(?:condition|gate|qualifier)[^.,;]*/gi, "");
}

/** The check SIZE_CONDITION is actually meant to apply. */
function carriesSizeCondition(text: string): boolean {
  return SIZE_CONDITION.test(dropNegatedConditions(text));
}

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
      .filter((l) => carriesSizeCondition(l.text))
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
    expect(carriesSizeCondition(step.text)).toBe(false);
  });

  test("the Quality bar requires Rook PASS with no qualifier", () => {
    const bar = lineContaining("**Quality bar:** ALL ACs have evidence");
    expect(bar.text).toMatch(/Rook (must )?PASS/i);
    expect(carriesSizeCondition(bar.text)).toBe(false);
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
    expect(rookBranch.filter((seg) => carriesSizeCondition(seg))).toEqual([]);
  });

  // Positive control for the negation stripper. Without these, widening
  // `dropNegatedConditions` until nothing matches would turn every assertion
  // above green while the spec still gated the review on size — the exact
  // shape .claude/rules/checks-must-be-able-to-fail.md is about. These are
  // fixtures, not spec text, so they assert the matcher rather than the file.
  test("the matcher still catches a real size condition", () => {
    for (const offender of [
      "5. If M+ size → spawn Rook (security scan on changed files)",
      "**Quality bar:** Rook PASS if M+",
      "Rook security scan (M or larger)",
      "spawn Rook, conditional on the ceremony tier",
      "if L, run the security review",
    ]) {
      expect(carriesSizeCondition(offender)).toBe(true);
    }
  });

  test("the negation stripper removes only the denial", () => {
    expect(dropNegatedConditions("Always spawn Rook. Not conditional on size.")).not.toMatch(
      /conditional|size/i,
    );
    // A denial in one clause must not launder a real condition in the next.
    expect(carriesSizeCondition("Not conditional on having a UI; spawn Rook if M+")).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * The re-review decision is recorded, not left open (#171)
 *
 * SC-621..SC-624 (HARNESS-STANDARD.md)
 *
 * #169 shipped the detection half — a verdict pinned to a commit the branch no
 * longer ends at becomes SECURITY_REVIEW_STALE — and closed its section with a
 * paragraph saying the other half was still open: the refusal stopped the run
 * and nothing looked at the new tip. #171 decides it. This block asserts the
 * decision is in the file and that every criterion the section lists is bound
 * to the file and tokens it names.
 *
 * The parse is deliberately mechanical. A registry a reader maintains by hand
 * drifts away from the spec silently, and a hand-written list of four ids is
 * satisfied by a section that lists five
 * (.claude/rules/checks-must-be-able-to-fail.md). So the ids are read out of
 * the section and compared against the registry in BOTH directions, and the
 * count is asserted before anything iterates — a parser that returns nothing
 * generates no per-criterion tests, which looks exactly like every criterion
 * passing.
 * ------------------------------------------------------------------------ */

/** The heading the re-review record lives under. */
const REREVIEW_HEADING = "### Re-review after a remediation round (#171)";

/**
 * The exact sentences the #169 open-gap paragraph was made of. The acceptance
 * condition for this change is that they are gone from the spec, so they are
 * held here — in the test, where reintroducing them turns something red —
 * rather than in the spec, where holding them would be reintroducing them.
 */
const CLOSED_GAP_PHRASINGS = [
  "One gap remains open",
  "it does not re-review the new tip",
  "does not re-review",
];

/** One `- [x] SC-NNN: path contains [a, b]` line from the re-review section. */
interface RereviewCriterion {
  id: string;
  file: string;
  tokens: string[];
  line: string;
}

/**
 * The criteria listed in the re-review section, parsed from the spec.
 *
 * Exported-by-name as the single binding: short-circuiting this to `return []`
 * must turn the assertions below red rather than leaving them with nothing to
 * iterate over, which is what the count assertion is for.
 */
export function rereviewCriteria(): RereviewCriterion[] {
  const start = specText.indexOf(REREVIEW_HEADING);
  if (start === -1) return [];
  const rest = specText.slice(start + REREVIEW_HEADING.length);
  const next = rest.indexOf("\n### ");
  const section = next === -1 ? rest : rest.slice(0, next);
  const out: RereviewCriterion[] = [];
  for (const line of section.split("\n")) {
    const m = /^- \[x\] (SC-\d+): (\S+) contains \[([^\]]*)\]/.exec(line.trim());
    if (!m) continue;
    out.push({
      id: m[1],
      file: m[2],
      tokens: m[3].split(",").map(t => t.trim()).filter(Boolean),
      line,
    });
  }
  return out;
}

/** The section's prose — everything above the first criterion bullet. */
function rereviewProse(): string {
  const start = specText.indexOf(REREVIEW_HEADING);
  if (start === -1) return "";
  const rest = specText.slice(start + REREVIEW_HEADING.length);
  const next = rest.indexOf("\n### ");
  const section = next === -1 ? rest : rest.slice(0, next);
  const firstBullet = section.indexOf("\n- [x] SC-");
  return firstBullet === -1 ? section : section.slice(0, firstBullet);
}

const EXPECTED_REREVIEW_SCS = ["SC-621", "SC-622", "SC-623", "SC-624"];

describe("#171: the re-review decision is recorded in HARNESS-STANDARD.md", () => {
  test("the section exists", () => {
    expect(specText, `${SPEC_PATH} has no re-review section`).toContain(REREVIEW_HEADING);
  });

  test("the #169 open-gap paragraph is gone, not merely contradicted", () => {
    for (const phrase of CLOSED_GAP_PHRASINGS) {
      expect(
        specText.includes(phrase),
        `${SPEC_PATH} still says "${phrase}" — the gap it describes is closed`,
      ).toBe(false);
    }
  });

  test("the section names all three outcomes and says the attempts can run out", () => {
    const prose = rereviewProse();
    expect(prose.length, "the re-review section has no prose above its criteria").toBeGreaterThan(
      200,
    );
    expect(prose).toContain("RE_REVIEW");
    expect(prose).toContain("SECURITY_REREVIEW_EXHAUSTED");
    expect(prose).toContain("SECURITY_REVIEW_STALE");
    expect(prose, "the section does not say what spending the cap means").toMatch(
      /ran out of attempts/i,
    );
  });

  test("the section records the measurement, not only the decision", () => {
    // A decision with no evidence behind it is a preference. #169 predicted
    // that refusing would make the common path the failing one; the run below
    // is that prediction measured.
    const prose = rereviewProse();
    expect(prose).toContain("wf_6fbfa028-14e");
    expect(prose).toContain("00f21e21");
  });

  test("the criteria parse, and there are exactly as many as the registry knows", () => {
    // Asserted BEFORE anything iterates: a parser returning nothing generates
    // no per-criterion cases, and a file that runs zero of its cases reports
    // the same green as one that passes all of them.
    expect(rereviewCriteria().length, "the re-review section lists no criteria").toBe(
      EXPECTED_REREVIEW_SCS.length,
    );
  });

  test("the ids in the spec and the ids in this test are the same set", () => {
    const found = rereviewCriteria().map(c => c.id).sort();
    expect(found, "an SC was added to or removed from the section").toEqual(
      [...EXPECTED_REREVIEW_SCS].sort(),
    );
  });

  test("the numbering starts at SC-621, where AC-5 says it does", () => {
    const ids = rereviewCriteria().map(c => c.id);
    expect(ids[0]).toBe("SC-621");
    // And nothing earlier in the file already claimed these numbers.
    for (const id of EXPECTED_REREVIEW_SCS) {
      expect(
        (specText.match(new RegExp(`- \\[[x ]\\] ${id}:`, "g")) || []).length,
        `${id} is listed more than once in ${SPEC_PATH}`,
      ).toBe(1);
    }
  });

  for (const id of EXPECTED_REREVIEW_SCS) {
    test(`${id} is bound to the file and tokens it names`, () => {
      const criterion = rereviewCriteria().find(c => c.id === id);
      expect(criterion, `${id} is not listed in the re-review section`).toBeDefined();
      const path = join(REPO_ROOT, criterion!.file);
      const haystack = readFileSync(path, "utf-8")
        .split("\n")
        // A criterion naming the spec cannot be its own evidence: the SC line
        // contains the tokens it demands, so every SC line is removed before
        // the search. The tokens have to be earned by the code or the prose.
        .filter(line => !/^- \[[x ]\] SC-\d+:/.test(line.trim()))
        .join("\n");
      expect(criterion!.tokens.length, `${id} names no tokens`).toBeGreaterThan(0);
      for (const token of criterion!.tokens) {
        expect(
          haystack.includes(token),
          `${id}: ${criterion!.file} does not contain "${token}"`,
        ).toBe(true);
      }
    });
  }
});
