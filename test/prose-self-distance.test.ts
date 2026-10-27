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
 * That reading was taken over four directories. The scan now covers all
 * **205** tracked non-fixture markdown files and the pattern admits
 * `before`/`after` — both because the #1624 review found the first version's
 * scope narrower than the census row advertising it. The wider reading
 * carries **40** distance-claim lines and **none** self-referential, which is
 * the same answer at four times the sample.
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
import { spawnSync } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROSE_SELF_DISTANCE_FIX,
  proseSelfDistanceViolations,
} from "../lib/prose-self-distance.ts";
import { remedyMessage } from "../lib/check-remedy.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * EVERY tracked markdown file, minus fixtures.
 *
 * The first version walked four directories — `specs`, `.claude/rules`,
 * `docs`, `reference` — and the review of #1624 caught what that makes the
 * census row say. The router event this PR adds is literally *"edited any
 * markdown at all"*, and `.claude/rules/self-referential-tests.md` is the
 * documented place an agent looks to find out what to run. So somebody
 * editing `CLAUDE.md` or `AGENTS.md`, following the table, would run this
 * suite and be told nothing — a detector narrower than the claim routing
 * people to it, which is the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 *
 * `git ls-files` rather than a directory walk, because *tracked* is the
 * population the router's predicate is about: an untracked scratch file is
 * not something a reviewer can be held to.
 *
 * **`test/fixtures/` is excluded, and that exclusion is asserted by
 * DOC-DIST-7 rather than left to this comment.** A fixture is an INPUT to
 * some other test — a planted document whose exact bytes that test asserts
 * on. Refusing a sentence inside one makes this check an opinion about
 * another suite's data, and the repo already has a name for the mistake:
 * markdown bound for a consumer of it is a payload, not a doc.
 */
const FIXTURES = "test/fixtures/";

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
  // the gap the #1624 review found: a POSITION, not a direction
  "appears three lines before this section and nowhere else",
  "the compliance factors are listed four paragraphs after this heading",
  "sixty lines after this bullet the same number is written differently",
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

/** Every tracked markdown path, fixtures included — the population before the cut. */
function trackedMarkdown(): string[] {
  const r = spawnSync(["git", "ls-files", "-z", "*.md"], { cwd: ROOT, stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error("git ls-files failed, so this scan has no population");
  return r.stdout.toString().split("\0").filter(Boolean);
}

function docs(): Array<{ path: string; text: string }> {
  return trackedMarkdown()
    .filter(p => !p.startsWith(FIXTURES))
    .map(path => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
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
    expect(all.length).toBeGreaterThan(150);
    expect(all.every(d => d.text.length > 0)).toBe(true);
    // Named individually, because the census row says "edited any markdown at
    // all" and these are the files a four-directory walk missed. A count
    // alone would stay green if the walk came back.
    for (const p of [
      "CLAUDE.md",
      "AGENTS.md",
      "REVIEW.md",
      "SUCCESS.md",
      ".claude/agents/marcus.md",
      "prompts/rook.md",
      "templates/agent-briefs/quinn.md",
      "specs/INSTRUCTION-COMPLIANCE-SPEC.md",
    ]) {
      expect(all.some(d => d.path === p), `outside the scan: ${p}`).toBe(true);
    }
  });

  test("DOC-DIST-7: fixtures are excluded, and there are fixtures to exclude", () => {
    // Both halves. Without the second, the exclusion is satisfied by a tree
    // that happens to contain no fixture markdown, and the day somebody adds
    // one this check starts having opinions about another suite's input data
    // with nothing having gone red.
    const tracked = trackedMarkdown();
    const fixtures = tracked.filter(p => p.startsWith(FIXTURES));
    expect(fixtures.length, "no fixture markdown exists, so the cut cuts nothing").toBeGreaterThan(
      10,
    );
    const scanned = docs().map(d => d.path);
    expect(scanned.filter(p => p.startsWith(FIXTURES)), "a fixture was scanned").toEqual([]);
    expect(
      scanned.length,
      "the cut removed nothing, so `docs()` is not applying it",
    ).toBe(tracked.length - fixtures.length);
  });

  test("DOC-DIST-6: the MUTANT — the referent requirement dropped — refuses the tree", () => {
    // Performed, not argued. Widening the rule to any distance at all is the
    // exact wrong version that was written first, so this row both proves the
    // check can fail AND pins the decision that separates it from the ban.
    const widened = (text: string) =>
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|sixty|hundred|dozen|a|several|[0-9][0-9,]*)(?:[ -](?:hundred|thousand))?\s+(?:lines?|rows?|sections?|paragraphs?|bullets?|columns?|pages?)\s+(?:above|below|away|apart|earlier|later|up|down|before|after)\b/i.test(
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
