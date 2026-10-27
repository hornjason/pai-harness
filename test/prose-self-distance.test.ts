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
 * carries **41** distance claims and **none** self-referential, which is the
 * same answer at four times the sample. The count moved every round — 40,
 * then 38, then 41 — so it is restated from a fresh measurement each time
 * rather than carried forward. Round 3 attributed the last move to the
 * wrap-crossing window on the strength of the delta alone, with two changes
 * in one commit; counted directly it is five spanning matches and two
 * removals. `lib/prose-self-distance.ts` carries the correction and the
 * consequence — the GAP's newline has no live instance in this tree, so
 * `DOC-DIST-3d` and `DOC-DIST-3e` are its only evidence.
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
  PROSE_SELF_DISTANCE_DEICTIC,
  PROSE_SELF_DISTANCE_FIX,
  PROSE_SELF_DISTANCE_PATTERN,
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
  // the teens, which the first two drafts skipped entirely — the reviewer's
  // own example, with its id moved into the fixture range. The reviewer's id
  // sat in the LIVE range, which the fixture-namespace census refuses — and
  // refused twice, because naming the old id in this very comment counts as
  // using it. The sentence is otherwise unchanged, and saying so matters
  // because "verbatim" was the claim the row was added under.
  "SC-9001 is ticked, fourteen lines above this heading, confirming the criterion.",
  "nineteen rows below this table the same id appears again",
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
  // WRITTEN HERE. The reviewer's #1624 counter-example, verbatim: `on` is a
  // preposition, not a direction, and admitting it refused this. It is kept
  // as a row rather than deleted with the word, because the cheapest way to
  // bring `on` back is not to notice it was ever a problem.
  "This file lists two pages on this document that still need review.",
  // WRITTEN HERE. Round 3 of the #1624 review: `a` is a determiner, not a
  // count, and admitting it refused ordinary instructions. Kept for the same
  // reason as the row above — a removed character leaves no trace of why.
  "Add a line above this heading explaining the exception.",
  "Put a paragraph below this section saying which claim it moves.",
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

/**
 * A SECOND declared limit, found at round 5 and deliberately not fixed here.
 *
 * The gap stops at any `.`, so a period that is not a sentence end — a
 * decimal, a version, a file name like `ai-review.yml` — ends the window
 * early and a claim reaching past one goes unrefused. The reviewer's decimal
 * example turns out to be this, not the block-marker bug it looked like, and
 * the two have different causes.
 *
 * Not fixed in this pull request, and the reason is the pull request's own
 * history: a widening at round 3 reintroduced the false-positive class the
 * module was narrowed to avoid, and round 4 was spent undoing it. Teaching
 * the gap to tell a sentence end from a decimal widens the window again,
 * at round 5, in a change nobody has measured. It belongs in its own commit
 * with its own corpus reading.
 *
 * Asserted rather than described, for the same reason as `UNCAUGHT`: when
 * somebody does fix it these rows go red and the claim above has to be
 * rewritten instead of quietly surviving.
 */
const UNCAUGHT_PERIOD = [
  "the ratio is three lines above\n3.14 times this paragraph's estimate",
  "the note sits three lines above\nai-review.yml is what this section edits",
];

/**
 * A THIRD declared limit: the vocabulary is a closed list over an open
 * language, and the three parts of the phrase must be adjacent.
 *
 * Round 6 of the #1624 review made the objection that rounds 2, 3 and its own
 * re-check had each found the same shape — a word missing from or wrongly
 * admitted to a hand-enumerated list — so patching a word predicts another
 * round. It is right, and this is the half of its own suggestion that does not
 * require widening the match window a third time in a pull request where the
 * first two widenings each shipped a defect.
 *
 * **Every row is a PAIR.** `text` must stay uncaught and `control` must stay
 * caught, and they differ by one word. Without the control a row is satisfied
 * by a rule that refuses nothing, and `why` would be a guess — which is the
 * mistake round 5 nearly made, attributing a decimal to the block markers when
 * the period was what stopped it.
 *
 * The last row is the cost of round 3's own fix, which the module did not
 * previously admit to: removing `a`/`an` spares the instruction reading and
 * gives up the claim reading, and the two are the same bytes here.
 */
const UNCAUGHT_VOCABULARY: ReadonlyArray<{
  readonly why: string;
  readonly text: string;
  readonly control: string;
}> = [
  {
    why: "`couple` is not in QUANTITY",
    text: "couple lines above this section",
    control: "two lines above this section",
  },
  {
    why: "`removed` is not in DIRECTION",
    text: "two lines removed from this section",
    control: "two lines above this section",
  },
  {
    why: "QUANTITY and UNIT must be adjacent — an adjective separates them",
    text: "two short lines above this section",
    control: "two lines above this section",
  },
  {
    why: "UNIT and DIRECTION must be adjacent — an adverb separates them",
    text: "two lines further above this section",
    control: "two lines above this section",
  },
  {
    why: "the indefinite article was removed from QUANTITY at round 3, and this " +
      "true claim went with the false positive it was removed for",
    text: "A note sits a line above this heading, restating the same count.",
    control: "A note sits one line above this heading, restating the same count.",
  },
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

  test("DOC-DIST-3f: the declared period limit — a non-terminal `.` ends the window", () => {
    for (const text of UNCAUGHT_PERIOD) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `now caught — good, but rewrite the limit UNCAUGHT_PERIOD declares ` +
          `and re-measure the corpus before you call it free: ${JSON.stringify(text)}`,
      ).toHaveLength(0);
    }
    // The control. Identical text with the period removed MUST be caught, or
    // this row is satisfied by a rule that refuses nothing and the limit it
    // claims to describe is not the reason.
    expect(
      proseSelfDistanceViolations([
        { path: "f.md", text: "the ratio is three lines above\n314 times this paragraph's estimate" },
      ]),
      "the period is not what stopped it, so this limit is misattributed",
    ).toHaveLength(1);
  });

  test("DOC-DIST-3g: the declared vocabulary limit, each row beside its control", () => {
    for (const { why, text, control } of UNCAUGHT_VOCABULARY) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `now caught — good. Rewrite the row in UNCAUGHT_VOCABULARY and the ` +
          `table in lib/prose-self-distance.ts, and re-measure the corpus ` +
          `before calling the widening free: ${JSON.stringify(text)}`,
      ).toHaveLength(0);
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text: control }]),
        `the control is no longer caught, so "${why}" is not what stopped ` +
          `the row beside it and this limit is misattributed: ${JSON.stringify(control)}`,
      ).toHaveLength(1);
    }
  });

  test("DOC-DIST-3h: re-admitting `a`/`an` would change nothing in this tree", () => {
    // The evidence that round 3's removal was decided by a CONSTRUCTED
    // sentence rather than a live one — and so that keeping the articles out
    // is a declared trade-off, not a measurement. If this ever goes red the
    // tree has grown a sentence that can settle the question, and the
    // docblock's "no setting of that switch is right" must be rewritten.
    const withArticle = PROSE_SELF_DISTANCE_PATTERN.replace(
      "(?:one|two|three",
      "(?:an?|one|two|three",
    );
    expect(
      withArticle,
      "QUANTITY no longer opens with `(?:one|two|three`, so this mutation " +
        "edited nothing and the reading below is vacuous",
    ).not.toBe(PROSE_SELF_DISTANCE_PATTERN);
    // …and it must admit the sentence it is supposed to admit, or the zero
    // below is a mutation that changed the pattern without changing the rule.
    expect(
      "A note sits a line above this heading, restating the same count."
        .match(new RegExp(withArticle, "gi")),
      "the mutant does not catch the article claim, so a zero over the tree " +
        "says nothing about whether the articles would refuse anything",
    ).toHaveLength(1);

    const hits: string[] = [];
    for (const { path, text } of docs()) {
      for (const m of text.matchAll(new RegExp(withArticle, "gi"))) {
        hits.push(`${path}: ${m[0].replace(/\s*\n\s*/g, " ")}`);
      }
    }
    expect(
      hits,
      "admitting the articles now refuses real sentences, so the trade-off " +
        "the docblock declares has a measured cost and must be restated",
    ).toEqual([]);
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

  test("DOC-DIST-3d: a claim that WRAPS is caught, and a blank line still stops it", () => {
    // Round 3 of the #1624 review. Every row above is one physical line, and
    // so were both live instances, so the whole suite — and the "0
    // violations" measurement — was silent about the way this repo actually
    // writes prose: hard-wrapped at about 76 characters.
    const wrapped = "that criterion was ticked some 46 lines above\nthis document's own listing of criteria.";
    const hits = proseSelfDistanceViolations([{ path: "f.md", text: wrapped }]);
    expect(hits, "a claim wrapped across a line break went unrefused").toHaveLength(1);
    expect(hits[0]!.line, "the line reported is not where the claim starts").toBe(1);
    expect(hits[0]!.text, "the quoted text still carries a newline").not.toContain("\n");

    // The control for the control. A blank line is a hard stop: two
    // paragraphs are two thoughts, and joining them manufactures a claim
    // nobody wrote. Without this row, "the window crosses newlines" is
    // indistinguishable from "the window crosses anything".
    const paragraphs = "that criterion was ticked some 46 lines above\n\nthis document's own listing of criteria.";
    expect(
      proseSelfDistanceViolations([{ path: "f.md", text: paragraphs }]),
      "two separate paragraphs were joined into one claim",
    ).toHaveLength(0);

    // And the `g` flag, the reviewer's lower-severity half: one `exec`
    // reported the first match on a line and stopped.
    const twice = "three lines above this bullet, and nineteen rows below this table.";
    expect(
      proseSelfDistanceViolations([{ path: "f.md", text: twice }]),
      "a second claim on the same line was not reported",
    ).toHaveLength(2);
  });

  test("DOC-DIST-3e: a newline is crossed into a CONTINUATION, never into a new block", () => {
    // Round 4 of the #1624 review. The wrap fix crossed any non-blank
    // newline, which let the window leave one block and land in the next —
    // reintroducing the false-positive shape the module was narrowed to
    // avoid, in the commit that widened it. The reviewer's sharper point was
    // that DOC-DIST-4 passing proved only that the tree lacks the input;
    // these rows are the evidence it lacked.
    const blocks: Array<[string, string]> = [
      ["list", "- the offset drifts three lines down\n- this paragraph is unrelated"],
      ["numbered list", "the offset drifts three lines down\n2. this paragraph is unrelated"],
      ["table row", "| the offset drifts three lines down | x |\n| this table says otherwise | y |"],
      ["heading", "the offset drifts three lines down\n## this section is unrelated"],
      ["blockquote", "the offset drifts three lines down\n> this note is unrelated"],
      ["fence", "the offset drifts three lines down\n```\nthis line is code\n```"],
    ];
    for (const [kind, text] of blocks) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `the window walked out of one block and into the next (${kind})`,
      ).toHaveLength(0);
    }

    // THE CONTROL, and without it every row above is satisfied by a gap that
    // crosses no newline at all — which is the bug round 3 fixed.
    expect(
      proseSelfDistanceViolations([
        { path: "f.md", text: "the offset drifts three lines down\nthis paragraph continues it" },
      ]),
      "an ordinary soft wrap stopped being crossed, so the round-3 fix is gone",
    ).toHaveLength(1);

    // Round 5. Lines that LOOK like a block start and are not: the first
    // spelling of BLOCK_START was a bare character class, so an issue number
    // read as a heading, a decimal as an ordered-list marker, and emphasis
    // as a bullet. Each stopped the window on a line it should have crossed
    // — a false NEGATIVE, which is quieter than round 4's false positive and
    // no less wrong. CommonMark wants the space; so does this.
    const lookalikes: Array<[string, string]> = [
      ["issue number, not a heading", "the note sits three lines above\n#1624 says this section is wrong"],
      ["emphasis, not a bullet", "the marker is three lines above\n*italic* text in this section"],
      ["digits and a paren, no space", "the note sits three lines above\n3)14 of this section says otherwise"],
    ];
    for (const [kind, text] of lookalikes) {
      expect(
        proseSelfDistanceViolations([{ path: "f.md", text }]),
        `the window stopped at a line that starts no block (${kind})`,
      ).toHaveLength(1);
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

  test("DOC-DIST-6: the MUTANT — the deictic clause deleted from the REAL pattern", () => {
    // Performed on the artefact, not approximated beside it.
    //
    // The first version of this row hand-wrote a widened regex. The review of
    // #1624 found it had already drifted from production — missing `eleven`,
    // `twenty`, `many`, `back` — so it was comparing two vocabularies while
    // claiming to isolate the deictic requirement. Two deciders that agree,
    // inside the test written to show they must not be. The mutant is now
    // the exported pattern with the exported deictic clause cut out of it,
    // so there is no second vocabulary that CAN drift.
    expect(
      PROSE_SELF_DISTANCE_PATTERN.split(PROSE_SELF_DISTANCE_DEICTIC).length - 1,
      "the deictic clause does not appear exactly once in the pattern, so cutting " +
        "it is not a single well-defined mutation",
    ).toBe(1);
    const mutant = new RegExp(
      PROSE_SELF_DISTANCE_PATTERN.replace(PROSE_SELF_DISTANCE_DEICTIC, ""),
      "i",
    );
    const widened = (text: string) => mutant.test(text);
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
