/**
 * DOC-DIST: a document may not state in prose how far away one of its own
 * parts is.
 *
 * ## The negative rows are the point of this file
 *
 * The first version of this check was a blanket ban on "N lines above". Run
 * against the tree on 2026-10-27 it matched **19** lines, and reading them
 * showed **17** were true statements about SOURCE FILES the document
 * describes — "the comment recording #174 sits four lines above it". Banning
 * those would have been seventeen false positives bought to catch two real
 * ones, and the check would have been deleted by whoever hit it first.
 *
 * So `NOT_A_CLAIM` below is not padding. Every row in it but the last is a
 * real sentence from the tree — `grep -rF` before pasting, and `DOC-DIST-3c`
 * keeps the equivalent claim about `UNCAUGHT` honest over time — and together
 * they are the evidence that the rule separates the two populations rather
 * than merely firing on the ones it was written from.
 *
 * ## Both real instances were TRUE when this shipped
 *
 * `INSTRUCTION-COMPLIANCE-SPEC.md`'s *Layer 3* section and its SC-453 each
 * said "167 lines below", and at `f0a9d973` they sat 167 lines apart. This
 * check is therefore not cleaning up wrong numbers; it exists because nothing
 * in the tree would have gone red on the day those numbers stopped being
 * right.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  PROSE_SELF_DISTANCE_FIX,
  proseSelfDistanceViolations,
} from "../lib/prose-self-distance.ts";
import { remedyMessage } from "../lib/check-remedy.ts";

const ROOT = join(import.meta.dir, "..");
const SCANNED = ["specs", ".claude/rules", "docs", "reference"];

/**
 * What the rule MUST refuse. The first two are the tree's live instances,
 * verbatim; the rest are **written for this file**, covering the spellings a
 * writer reaches for next — a word-number, a structural unit, a hedge. Saying
 * which is which matters: a row invented to match the regex it is testing
 * proves only that I can read my own pattern.
 */
const IS_A_CLAIM = [
  // live, specs/INSTRUCTION-COMPLIANCE-SPEC.md
  "ticked it, 167 lines below this line — so the spec asserted both",
  "and 167 lines below this spec's own \"(to be built)\".",
  // written here
  "roughly two hundred lines above this bullet, and the two sat in one file",
  "the table three rows below this row says the opposite",
  "a heading some 40 lines above this paragraph",
  "one section below this section, the count is restated",
];

/**
 * Sentences the rule MUST NOT refuse: a distance in a file the document is
 * DESCRIBING, which is an ordinary quotable fact. **Every row but the last is
 * verbatim from this tree** — each was confirmed present with `grep -rF`
 * before it was pasted — and the last is marked where it sits.
 */
const NOT_A_CLAIM = [
  "Six lines above the loop, a comment records the first: `slice(0, 3)`",
  "`${testCommand}` from it three lines above. The URL was the one value left for",
  "is a note about a step, three lines above the step. Three of the six therefore",
  "Split out of #171. The verdict refusal sat 49 lines ABOVE the currency",
  "`detectExistingPR`'s own comment names that hazard two lines above the",
  "comment two lines above it named the same id — and the same comment BELOW the",
  "line one line above prints `'unknown'` and throws it away. Different defect",
  "The other two had the reason sitting in a local variable one line earlier.",
  "along, and the comment recording #174 sits four lines above it.",
  "The original was still there, 460 lines down. The committed result declared",
  "worktree registry, roughly 3,800 lines above the only line that assigns it,",
  "## The commit prompt pasted an issue title four lines above `git push` (#706)",
  "branch one line above itself.",
  "The same shape hid a **second bypass one line down**, which the issue did not",
  // WRITTEN HERE, not from the tree. A distance and a deictic in one line,
  // but not one claim: the sentence boundary separates them. Without a row
  // for it the 60-character window is an untested number.
  "the helper sits four lines above the call. This section explains why.",
];

/**
 * The BARE form, and the declared limit of this check — all four live
 * instances, verbatim.
 *
 * These are the same defect: a self-referential count no insertion updates.
 * They go free because the signal that would catch them — a structural unit
 * with no deictic — also catches the fifth row, which is a true sentence
 * about a source file's docstring. So the limit is not an oversight, and
 * this row is where it is recorded: if somebody widens the rule, this goes
 * red and they must come back and rewrite the claim rather than leave a
 * docblock describing a check that no longer behaves that way.
 */
const UNCAUGHT = [
  "Three deciders agreeing; collapsed to one, and the two rows above are that one being mutated",
  "### The remaining gap, recorded here and closed one section below",
  "- *Before you believe a 0, check the instrument (#60)* is one section up, and",
  "The three sections below were moved out of the rule by #1069, for the same",
  // the counterexample — a bare structural distance that is TRUE, about a
  // source file, which is why the bare form cannot simply be banned
  "was breaking, two paragraphs above the code that breaks it.",
];

function docs(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
    }
  };
  for (const d of SCANNED) walk(join(ROOT, d));
  return out;
}

describe("DOC-DIST: a prose distance to the document's own parts", () => {
  test("DOC-DIST-1: every self-referential form is refused", () => {
    for (const text of IS_A_CLAIM) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `not refused: ${text}`,
      ).toHaveLength(1);
    }
  });

  test("DOC-DIST-2: a distance in a file being DESCRIBED is not refused", () => {
    // The row that stops this check from being deleted by its first victim.
    for (const text of NOT_A_CLAIM) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `falsely refused, and this is a real sentence from the tree: ${text}`,
      ).toHaveLength(0);
    }
  });

  test("DOC-DIST-3: the two populations are both non-empty", () => {
    // Guards the vacuous pass. If either list were emptied, the two rows
    // above would agree with any implementation at all, including one that
    // always returns [] and one that refuses everything.
    expect(IS_A_CLAIM.length).toBeGreaterThan(0);
    expect(NOT_A_CLAIM.length).toBeGreaterThan(0);
    expect(
      proseSelfDistanceViolations(NOT_A_CLAIM.map((text, i) => ({ path: `n${i}.md`, text }))),
    ).toHaveLength(0);
    expect(
      proseSelfDistanceViolations(IS_A_CLAIM.map((text, i) => ({ path: `y${i}.md`, text }))),
    ).toHaveLength(IS_A_CLAIM.length);
  });

  test("DOC-DIST-3b: the declared limit — the bare form is NOT caught", () => {
    for (const text of UNCAUGHT) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `now caught — widen the rule if you like, but rewrite the limit the ` +
          `docblock declares in lib/prose-self-distance.ts, and check the ` +
          `fifth row is still true: ${text}`,
      ).toHaveLength(0);
    }
  });

  test("DOC-DIST-3c: UNCAUGHT is quoting the tree, not an invented list", () => {
    // A limit recorded against sentences nobody wrote is not a limit. If one
    // of these is edited away, this row says so rather than leaving the
    // docblock's "measured 4" pointing at nothing.
    const corpus = docs().map(d => d.text).join("\n");
    for (const text of UNCAUGHT) {
      expect(corpus.includes(text), `no longer in the tree: ${text}`).toBe(true);
    }
  });

  test("DOC-DIST-4: the tree holds none", () => {
    const found = proseSelfDistanceViolations(docs());
    expect(
      found.map(v => `${v.file}:${v.line}  ${v.text}`),
      remedyMessage({
        root: ROOT,
        check: "DOC-DIST",
        violations: found.map(v => `${v.file}:${v.line}`),
        fix: PROSE_SELF_DISTANCE_FIX,
      }),
    ).toEqual([]);
  });

  test("DOC-DIST-5: the scan reaches real files, so row 4 is not vacuous", () => {
    // A `docs()` that silently returned [] would make DOC-DIST-4 green
    // against a tree full of violations — the shape this repo calls an
    // assertion that holds vacuously.
    const all = docs();
    expect(all.length).toBeGreaterThan(40);
    expect(all.some(d => d.path === "specs/INSTRUCTION-COMPLIANCE-SPEC.md")).toBe(true);
    expect(all.every(d => d.text.length > 0)).toBe(true);
  });

  test("DOC-DIST-6: the MUTANT — the referent requirement dropped — refuses the tree", () => {
    // Performed, not argued. Widening the rule to any distance at all is the
    // exact wrong version that was written first, so this row both proves the
    // check can fail AND pins the decision that separates it from the ban.
    const widened = (text: string) =>
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|a|several|[0-9][0-9,]*)(?:[ -](?:hundred|thousand))?\s+(?:lines?|rows?|sections?|paragraphs?|bullets?|columns?|pages?)\s+(?:above|below|away|apart|earlier|later|up|down)\b/i.test(
        text,
      );
    const all = docs();
    const wouldRefuse = all
      .flatMap(d => d.text.split("\n").map((l, i) => ({ at: `${d.path}:${i + 1}`, l })))
      .filter(x => widened(x.l));
    const real = new Set(proseSelfDistanceViolations(all).map(v => `${v.file}:${v.line}`));
    const spared = wouldRefuse.filter(x => !real.has(x.at));
    // The narrowing, as a count rather than as a sentence about a count: the
    // widened rule refuses lines this one does not, and every one of them is
    // a true statement about a source file. A mutation that deleted the
    // deictic requirement would empty `spared` and this goes red.
    expect(
      spared.length,
      "the widened rule spares nothing this one does, so the two are the same rule",
    ).toBeGreaterThan(10);
  });
});
