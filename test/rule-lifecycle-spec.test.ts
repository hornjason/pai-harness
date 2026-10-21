/**
 * Covers the structural integrity of
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` (#544).
 *
 * The spec's 19 behavioural criteria (SC-1930..SC-1948) are NOT covered here.
 * Nothing implements them yet, and a test that asserts an unimplemented
 * criterion either fails the suite or — far worse — passes vacuously and
 * certifies work that was never done. `.claude/rules/checks-must-be-able-to-
 * fail.md` names that third shape by name, and #209 established the honest
 * alternative: an unimplemented criterion emits `test.todo`, never a swallowed
 * pass.
 *
 * What IS asserted here is everything about the spec document that can be
 * checked today: that its ids are unique, inside the range reserved for it,
 * declared in a position `sync-sc-status.ts` can read, and that the two
 * statements the design depends on — `paths` being the only load-time lever,
 * and the budget being concurrent-load rather than a count — are actually in
 * the document rather than only in an issue comment.
 *
 * To see this fail: renumber one SC to collide with another, or delete the
 * concurrent-load sentence from the spec body.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SPEC_REL = "specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md";
const SPEC = join(ROOT, SPEC_REL);

/**
 * The blocks reserved for this spec, each with the owner that reserved it in
 * `specs/sc-reservations.json`. Widening this is a decision, not a typo fix —
 * which is why it is a list of named blocks rather than one widened interval:
 * `{ lo: 1930, hi: 2459 }` would accept 500 unreserved ids and read as the
 * same edit in a diff.
 */
const SC_RANGES = [
  { owner: "#544", lo: 1930, hi: 1948 },
  { owner: "#1009 (PR #1011)", lo: 2440, hi: 2459 },
] as const;

function specBody(): string {
  expect(existsSync(SPEC)).toBe(true);
  return readFileSync(SPEC, "utf-8");
}

function declaredSCs(body: string): number[] {
  // The declaring position sync-sc-status.ts reads: `- [ ] SC-N:` at line start.
  return [...body.matchAll(/^- \[([ xX])\] SC-(\d+):/gm)].map(m => Number(m[2]));
}

describe("RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC: document integrity", () => {
  test("frontmatter declares it testable and names what it governs", () => {
    const fm = specBody().match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(fm).toContain("doc-type: spec");
    expect(fm).toContain("testable: true");
    // `governs` is what doc-hygiene routes on; the template ships it as TODO.
    expect(fm).toMatch(/^governs: (?!TODO)\S.*$/m);
  });

  test("every SC is declared in a position the status sync can read", () => {
    const scs = declaredSCs(specBody());
    expect(scs.length).toBeGreaterThan(0);
    // A bare `SC-1933` mid-sentence is a citation, not a claim — see
    // .claude/rules/claiming-sc-coverage.md. The count below is of claims.
    // 19 -> 27 on 2026-10-21: #1009's eight, SC-2440..SC-2447.
    expect(scs.length).toBe(27);
  });

  test("SC ids are unique", () => {
    const scs = declaredSCs(specBody());
    const dupes = scs.filter((n, i) => scs.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("SC ids stay inside the range reserved for #544", () => {
    const out = declaredSCs(specBody()).filter(
      n => !SC_RANGES.some(r => n >= r.lo && n <= r.hi),
    );
    expect(out, `ids outside every reserved block: ${SC_RANGES.map(r => `${r.lo}-${r.hi} (${r.owner})`).join(", ")}`).toEqual([]);
  });

  test("exactly the implemented criteria are checked, and no others", () => {
    const checked = [...specBody().matchAll(/^- \[[xX]\] SC-(\d+):/gm)].map(m => Number(m[1]));
    // Was `toEqual([])` while nothing was implemented. #544/#545 implement
    // two, so the honest form is an enumeration rather than a count: a list
    // keeps saying WHICH, and a count would be satisfied by any two.
    //
    // This list is what stops the next increment ticking a criterion by
    // accident. It already caught one: the first draft of
    // `test/failure-intake-promotion.test.ts` named three UNIMPLEMENTED ids
    // in declaring positions — a test title, a parenthetical — inside the
    // section whose whole subject was what the change does NOT cover, and
    // `sync-sc-status.ts` duly ticked all three. Mentioning a criterion in
    // order to disclaim it is still mentioning it
    // (`.claude/rules/claiming-sc-coverage.md`).
    //
    // #1009 ticks eight, SC-2440..SC-2447. Unlike #544's, every one is driven
    // by `test/instruction-surface-budget.test.ts` against the real script
    // and a mutant of it, so the enumeration grows rather than the list being
    // replaced by a count.
    expect(checked.sort((a, b) => a - b)).toEqual([
      1939, 2440, 2441, 2442, 2443, 2444, 2445, 2446, 2447,
    ]);
  });

  test("the spec states the two load-time facts the whole design rests on", () => {
    const body = specBody();
    // Without these the design is unmotivated, and both were established by
    // measurement rather than inference (verified against Claude Code docs
    // and reproduced in this repo, 2026-10-16).
    expect(body).toMatch(/`paths` is the \*\*only\*\* key Claude Code reads/);
    expect(body).toMatch(/max-concurrent-load, not a count/);
  });

  test("it records which SUCCESS.md claim governs it", () => {
    // SUCCESS.md:378 — an issue or spec that moves no claim is cleanup and
    // must say so rather than borrowing urgency.
    expect(specBody()).toContain("SUCCESS.md");
    expect(readFileSync(join(ROOT, "SUCCESS.md"), "utf-8"))
      .toContain("RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md");
  });
});

describe("RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC: behaviour (unimplemented)", () => {
  // One todo per criterion. These become real tests in the implementation PR;
  // until then they are visible as outstanding rather than silently absent.
  test.todo("SC-1930: baseline rules carry no `paths:` key in frontmatter");
  test.todo("SC-1931: baseline rule bodies contain no repo-specific identifier");
  test.todo("SC-1932: every mined rule carries a `paths:` list scoped to the code it governs");
  test.todo("SC-1933: scaffold computes and reports max-concurrent-load per file");
  test.todo("SC-1934: over-budget concurrent load FAILs and names the overlapping rules");
  test.todo("SC-1935: total rule count is not capped — only concurrent load is");
  test.todo("SC-1936: a mined rule matching every file is reported as unscoped");
  test.todo("SC-1937: glob expansion stays within 1,000 patterns and 4 MiB per rule");
  test.todo("SC-1938: a zero-interaction scaffold run produces a populated, scoped rule set");
  // SC-1939 is implemented and covered in
  // `test/failure-intake-promotion.test.ts` (#544/#545). Its todo is deleted
  // rather than left beside the real cases: since #810 a todo declaration
  // OUTRANKS a comment citing the same criterion, so leaving it here would
  // keep the id reading as unimplemented while tests for it ran green — two
  // positions disagreeing about one fact, with the wrong one winning.
  //
  // The todo below stays. #544/#545 implement the half of it that refuses to
  // re-promote a vetoed hash, and NOT the half that writes the hash to
  // `reference/rejected-constraints.md` — a file this repository does not
  // have. Half a criterion is not a criterion.
  test.todo("SC-1940: a rejected rule's hash is recorded and never re-promoted");
  test.todo("SC-1941: a rule citing an unresolvable file:line is auto-retired");
  test.todo("SC-1942: eval-gated retention stays disabled until its measurement can fail");
  test.todo("SC-1943: Makefile, package.json scripts and CI workflows are scanned");
  test.todo("SC-1944: CODE-MAP.md is excluded from constraint sources");
  test.todo("SC-1945: a consumer with zero mined rules is reported as such");
  test.todo("SC-1946: scaffolding the golden fixture twice is byte-identical");
  test.todo("SC-1947: extraction runs as part of scaffold and re-scaffold");
  test.todo("SC-1948: hand-edited rule files are preserved and reported");
});
