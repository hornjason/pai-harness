/**
 * Covers #664 — no guard in `test/` cuts a FIXED CHARACTER COUNT out of a
 * source it is making a claim about.
 *
 * ## The defect, measured
 *
 * `test/worktree-repo.test.ts` SC-1446 cut `shipSource.slice(at, at + 6000)`
 * and asserted two strings were inside it. On `430df61b` the second of them
 * sat 5,421 characters past the anchor: 650 characters of headroom that
 * nobody had measured. A 2,119-character prompt insertion for an unrelated
 * issue, in the branch ABOVE the one the case guards, pushed both targets
 * 1,469 characters past the boundary. `bun test test/worktree-repo.test.ts`
 * went from 93 pass / 0 fail to 92 pass / 1 fail, and the failing case is
 * named *"the Verify BUILD regression has an else, and it is terminal"* —
 * the `else` is still there, still terminal, and entirely untouched.
 *
 * A window is a guess about how long a construct will stay that size. The
 * guess decays silently, and the day it fails it accuses the wrong code. The
 * replacement is `lib/source-slice.ts`, whose API has no numeric-length
 * parameter anywhere: a cut ends at a matching bracket or at a named anchor.
 *
 * ## Why this is a scan and not a line-by-line fix
 *
 * The ten sites #664 lists were found by hand. A hand-found population stays
 * found for exactly as long as nobody writes an eleventh, so the deliverable
 * is the sweep rather than the ten edits. The sweep is a ratchet at ZERO and
 * there is deliberately **no exemption file and no allowlist** — an allowlist
 * naming exempt files is a second thing to maintain, and
 * `.claude/rules/feedback-exemption-list-self-reference.md`'s instance is a
 * list that became evidence for the files it exempted.
 *
 * ## The two ways this scan could pass while measuring nothing
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`, third shape — *assertions
 * that hold vacuously*. Both are asserted rather than assumed:
 *
 *  - **A walk that reads no files reports no occurrences**, and zero of zero
 *    is byte-indistinguishable from a clean tree. So the scan asserts the
 *    number of files it actually read, and refuses below a hundred — this
 *    tree holds hundreds, and a walk that comes back with eleven has lost
 *    its root, not found a clean repository.
 *  - **A detector that matches nothing reports no occurrences.** So the same
 *    matcher is run over a synthetic source carrying one of each form, and
 *    must report both. Without that case, narrowing the pattern to something
 *    unmatchable buys a green sweep.
 *
 * ## What it reads, and why that view
 *
 * `stripJsComments(src, { blankLiterals: true })` — comments and the CONTENTS
 * of string, template and regex literals blanked, every offset preserved. A
 * window form quoted in a test title or in a docblock is prose about the
 * defect, not an instance of it; `test/source-slice-structural.test.ts:220`
 * names `slice(at - 1_500, at + 1_500)` in a `test(...)` title, and this very
 * file carries the pattern as a regex literal. #484 is the row where a
 * scanner reported its own docstring as a call site.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file alone (4 tests), every count predicted
 * before the battery ran, and the baseline read first.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 4 pass, 0 fail | **4 pass, 0 fail** |
 * | one window restored — `shipSource.slice(at, at + 1400)` back in `test/ac-coverage.test.ts:313` | 1 | **1 of 4** — the sweep, naming the file and line |
 * | the walk truncated to its first eleven files | 1 | **1 of 4** — the vacuity case; the sweep stays GREEN over eleven clean files, which is the whole point of having it |
 * | the matcher narrowed to `\.sliceZZ\(` — a pattern nothing can match | 1 | **1 of 4** — the planted-forms case; the sweep stays green over a tree it can no longer see |
 * | `blankLiterals` dropped from the read | 2 | **2 of 4** — the prose case and the sweep, the latter because this file's own planted fixtures become instances |
 *
 * Before believing any of those, the input on which mutant and original
 * differ: the restored window is `test/ac-coverage.test.ts:313`, where the
 * original reports `[]` and the mutant reports that one line; the truncated
 * walk reads 11 files where the original reads 384; the narrowed matcher
 * reports 0 on the planted pair where the original reports lines 1 and 2.
 *
 * **The `blankLiterals` row came back 1 on its first measurement, not 2, and
 * the missing red was the prose case.** Its fixture was the real title at
 * `test/source-slice-structural.test.ts:220`, which says `slice(at - 1_500,
 * …)` with **no receiver** — and the matcher requires `.slice(`, so that
 * string never matched with or without blanking. A fixture that reaches the
 * assertion without the feature (#500). The fixture is dotted now and the row
 * is 2.
 *
 * None of the four mutations is left in the tree; all were run and reverted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { stripJsComments } from "../lib/strip-js-comments";

const TEST_DIR = join(import.meta.dir);

/**
 * The fixed-character window form, in both the one-sided and two-sided
 * spellings `#664` names.
 *
 * The back-reference is what makes it a WINDOW rather than any slice: the
 * same identifier on both sides, offset by a literal. `slice(at, i + 1)` —
 * the brace-matched form already written by hand in several files — has two
 * different identifiers and is structural, so it is not matched and must not
 * be: converting those to a window is the regression this is pointed away
 * from.
 */
const WINDOW = /\.slice\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:-\s*\d[\d_]*\s*)?,\s*\1\s*\+\s*\d[\d_]*\s*\)/g;

/** Every `.ts` file under `test/`, recursively. */
function testSources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testSources(path, into);
    else if (entry.endsWith(".ts")) into.push(path);
  }
  return into;
}

/** Every window-form occurrence in `source`, as `line: text` for a reader. */
export function windowOccurrences(source: string): string[] {
  const code = stripJsComments(source, { blankLiterals: true });
  const out: string[] = [];
  for (const m of code.matchAll(WINDOW)) {
    const line = code.slice(0, m.index).split("\n").length;
    // Reported from the RAW source, because the blanked view renders a
    // literal as spaces and a reader needs the line they will edit.
    out.push(`${line}: ${source.split("\n")[line - 1]?.trim() ?? m[0]}`);
  }
  return out;
}

describe("#664: no guard in test/ cuts a fixed number of characters", () => {
  const files = testSources(TEST_DIR);

  test("the walk read the test tree, not a handful of files", () => {
    // The vacuity this guards against: a sweep that reads nothing finds
    // nothing, and "0 occurrences over 0 files" prints exactly like "0
    // occurrences over 384 files". If this number collapses, the sweep below
    // is reporting about a tree it never opened.
    expect(
      files.length,
      "the test/ walk read fewer than 100 files — a sweep that reads nothing " +
        "finds nothing, so the zero below would be vacuous rather than clean",
    ).toBeGreaterThan(100);
  });

  test("the matcher fires on both window forms — it is not a dead pattern", () => {
    // The other vacuity: a detector narrowed to something unmatchable reports
    // a clean tree forever. Both spellings #664 names, and the structural
    // forms that must NOT be flagged.
    const planted = [
      "const a = src.slice(at, at + 6_000);",
      "const b = src.slice(at - 1500, at + 1500);",
      "const c = src.slice(at, i + 1);",
      "const d = src.slice(at, src.indexOf('\\n}', at));",
    ].join("\n");
    expect(windowOccurrences(planted).map(o => o.split(":")[0])).toEqual(["1", "2"]);
  });

  test("a window form quoted inside a literal is prose, not an instance", () => {
    // Why the scan reads the blanked view. Deleting `blankLiterals` makes
    // this case red and turns every docblock that discusses the defect into
    // an instance of it (#484).
    // The fixture is DOTTED on purpose. Measured: the undotted spelling —
    // which is how `test/source-slice-structural.test.ts:220` happens to word
    // its title — never matches `\.slice\(` at all, so a case built on it
    // passes with `blankLiterals` deleted and witnesses nothing (#500).
    expect(windowOccurrences('test("it replaces src.slice(at - 1_500, at + 1_500)", () => {});')).toEqual([]);
  });

  test("zero fixed-character windows remain anywhere under test/", () => {
    const found: string[] = [];
    for (const path of files) {
      for (const hit of windowOccurrences(readFileSync(path, "utf-8"))) {
        found.push(`${path.slice(TEST_DIR.length + 1)}:${hit}`);
      }
    }
    expect(
      found,
      `a fixed-character window is back in test/ — cut to the construct with ` +
        `structuralCut/structuralCutAround from lib/source-slice.ts (#664). ` +
        `There is no exemption list and there is not going to be one.`,
    ).toEqual([]);
  });
});
