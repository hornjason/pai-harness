/**
 * Covers the structural integrity of
 * `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md` (#544).
 *
 * The spec's 19 behavioural criteria (SC-1667..SC-1685) are NOT covered here.
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

/** The block #544 reserved. Widening this is a decision, not a typo fix. */
const SC_RANGE = { lo: 1667, hi: 1685 } as const;

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
    // A bare `SC-1670` mid-sentence is a citation, not a claim — see
    // .claude/rules/claiming-sc-coverage.md. The count below is of claims.
    expect(scs.length).toBe(19);
  });

  test("SC ids are unique", () => {
    const scs = declaredSCs(specBody());
    const dupes = scs.filter((n, i) => scs.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("SC ids stay inside the range reserved for #544", () => {
    const out = declaredSCs(specBody()).filter(n => n < SC_RANGE.lo || n > SC_RANGE.hi);
    expect(out).toEqual([]);
  });

  test("no SC is pre-checked — nothing here is implemented yet", () => {
    const checked = [...specBody().matchAll(/^- \[[xX]\] SC-(\d+):/gm)].map(m => m[1]);
    expect(checked).toEqual([]);
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
  test.todo("SC-1667: baseline rules carry no `paths:` key in frontmatter");
  test.todo("SC-1668: baseline rule bodies contain no repo-specific identifier");
  test.todo("SC-1669: every mined rule carries a `paths:` list scoped to the code it governs");
  test.todo("SC-1670: scaffold computes and reports max-concurrent-load per file");
  test.todo("SC-1671: over-budget concurrent load FAILs and names the overlapping rules");
  test.todo("SC-1672: total rule count is not capped — only concurrent load is");
  test.todo("SC-1673: a mined rule matching every file is reported as unscoped");
  test.todo("SC-1674: glob expansion stays within 1,000 patterns and 4 MiB per rule");
  test.todo("SC-1675: a zero-interaction scaffold run produces a populated, scoped rule set");
  test.todo("SC-1676: promotion ranks on the mechanical evidence score");
  test.todo("SC-1677: a rejected rule's hash is recorded and never re-promoted");
  test.todo("SC-1678: a rule citing an unresolvable file:line is auto-retired");
  test.todo("SC-1679: eval-gated retention stays disabled until its measurement can fail");
  test.todo("SC-1680: Makefile, package.json scripts and CI workflows are scanned");
  test.todo("SC-1681: CODE-MAP.md is excluded from constraint sources");
  test.todo("SC-1682: a consumer with zero mined rules is reported as such");
  test.todo("SC-1683: scaffolding the golden fixture twice is byte-identical");
  test.todo("SC-1684: extraction runs as part of scaffold and re-scaffold");
  test.todo("SC-1685: hand-edited rule files are preserved and reported");
});
