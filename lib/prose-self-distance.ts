/**
 * DOC-DIST: a document may not state, in prose, how many lines away one of
 * its OWN parts is.
 *
 * ## What this refuses, and what it deliberately does not
 *
 * "the comment recording #174 sits four lines above it" is about a source
 * file this document is describing. That distance is a fact about another
 * artefact, it is as checkable as any other quoted fact, and nothing here
 * touches it.
 *
 * The deciding measurement, 2026-10-27, over `specs/`, `.claude/rules/`,
 * `docs/` and `reference/`: **19** distance claims, **17** of that kind.
 * After three rounds of #1624 review moved the pattern and the scanned set,
 * the population is **41** distance claims across **205** tracked
 * non-fixture markdown files, and the ratio did not move in the direction
 * that would matter — **none** of the 41 is self-referential.
 *
 * The figure is the count under the CURRENT rule, and it has moved every
 * round, which is why it is restated rather than inherited: 40 at round 1,
 * **38** at round 2 (teens added, `on` removed), **41** at rounds 3 and 4.
 *
 * **Round 3 explained that last move wrongly and the correction matters.**
 * It said the wrap-crossing window "found three claims no line-by-line scan
 * could see" — read off the delta 38 → 41, with two changes in the commit.
 * Counted directly: **5** of the 41 span a newline, and every one of them
 * spans it inside the distance phrase itself (`"twenty\nlines above"`),
 * where the separator is `\s+` and always was. Removing `a`/`an` took two
 * away; whole-text matching added five; the net was three and the three were
 * never a population.
 *
 * Which leaves a fact worth stating plainly rather than leaving implied:
 * **no claim in this tree exercises the GAP's newline at all.** The wrap
 * case is real — it is why round 3 exists — but against the live corpus the
 * crossing is UNMEASURED, and its only evidence is the planted rows in
 * `DOC-DIST-3d` and `DOC-DIST-3e`.
 *
 * The two that were not are a different animal: *"roughly two hundred lines
 * above this bullet"*. The referent is the document itself, so the claim is
 * about a number that every insertion above it changes, in a file whose whole
 * job is to be edited. Nobody recomputes it, nothing can, and it is wrong
 * quietly.
 *
 * So the signal is the **deictic referent** — `this line`, `this bullet`,
 * `this spec` — not the distance. That is what separates the 2 from the 17,
 * and it is why a blanket ban on "N lines above" is the wrong check: it would
 * have refused seventeen true sentences to catch two false ones.
 *
 * ## Why a ban rather than a comparison
 *
 * The obvious check is to recompute the distance and compare. It cannot be
 * written: "167 lines below this line" names no target, so there is nothing
 * to measure TO. Resolving the referent is a reading-comprehension problem,
 * and a checker that guessed would be a detector narrower than what it
 * detects.
 *
 * A self-referential distance is therefore unverifiable **by construction**,
 * and the honest response to an unverifiable claim is not to check it but to
 * stop writing it. The replacement is always available and never rots: name
 * the section. A heading reference breaks loudly, because the heading has to
 * change for it to break.
 *
 * ## Both instances in the tree were TRUE when this was written
 *
 * In `INSTRUCTION-COMPLIANCE-SPEC.md` the *Layer 3 — Behavioral Compliance*
 * section said "167 lines below this line" and SC-453 said "167 lines below
 * this spec's own". At `f0a9d973` they sat at lines 88 and 255, and
 * 255 − 88 is 167 — the commit is named because a bare line number in a
 * sentence is the thing this module exists to object to.
 *
 * That both were TRUE is the point rather than a mitigation: this check is
 * not green because the numbers were wrong, it exists because nothing would
 * have gone red on the day they stopped being right.
 *
 * ## There is no allowlist, by design
 *
 * Every instance has a mechanical fix that is strictly better, so an
 * exemption would only ever record that somebody did not want to apply it.
 *
 * ## What this does NOT catch, measured rather than assumed
 *
 * The deictic is required, so the **bare** form goes free: *"the two rows
 * above are that one being mutated"*, *"the three sections below were moved
 * out of the rule"*. Measured 2026-10-27 the tree holds **4** of those, and
 * they are the same defect — a count that no insertion updates.
 *
 * They are not caught because the signal that would catch them also catches a
 * true sentence. *"The function's own docstring states the property it was
 * breaking, two paragraphs above the code that breaks it"*
 * (`specs/HARNESS-STANDARD.md`) is a bare structural distance about a SOURCE
 * FILE, so "a structural unit with no deictic" is not the separator it looks
 * like, and a rule built on it would be the blanket ban again at smaller
 * scale. `UNCAUGHT` in the test file holds all four and asserts this returns
 * nothing for them, so the limit is a row that goes red when somebody widens
 * the rule rather than a paragraph that quietly stops being true.
 *
 * ## The vocabulary is a closed list over an open language
 *
 * Three rounds of the #1624 review each found the same shape — a word missing
 * from, or wrongly admitted to, a hand-enumerated list. Round 2: the teens
 * were missing and `on` was wrongly in `DIRECTION`. Round 3: bare `a`/`an`
 * were wrongly in `QUANTITY`. Each was fixed as a one-off, and round 6 made
 * the right objection: **the class is what keeps producing findings, not the
 * words**, so fixing a word at a time predicts another round rather than a
 * last one.
 *
 * Measured, so the shape is a reading rather than a worry — four ways in, each
 * one word away from a sentence this DOES refuse:
 *
 * | uncaught | what stopped it |
 * |---|---|
 * | "couple lines above this section" | not in `QUANTITY` |
 * | "two lines removed from this section" | not in `DIRECTION` |
 * | "two short lines above this section" | `QUANTITY`→`UNIT` must be adjacent |
 * | "two lines further above this section" | `UNIT`→`DIRECTION` must be adjacent |
 *
 * The reviewer offered the alternative of widening `GAP` so the three parts
 * need not be contiguous, "closing a shape rather than a word". That is the
 * right diagnosis and the wrong moment: it is a third widening of the same
 * window, and this pull request's own history is that the first reintroduced
 * the seventeen-false-positive class (round 3) and the second cost a round to
 * undo (round 4). A widening whose false-positive cost nobody has measured is
 * how both of those shipped.
 *
 * So the other half of the reviewer's own suggestion is taken instead: this is
 * a **standing, named limitation**, with `UNCAUGHT_VOCABULARY` asserting each
 * row above beside the control that differs from it by one word. Every row is
 * therefore falsifiable in both directions — the uncaught sentence must stay
 * uncaught, and the control must stay caught, or the limit is misattributed
 * and the table above is wrong rather than merely incomplete.
 *
 * ## `a` and `an`: no setting of that switch is right
 *
 * Round 3 removed the articles from `QUANTITY` because
 * *"Add a line above this heading explaining the exception"* is an instruction
 * and was being refused. Round 6 pointed out the cost was never written down:
 * *"A note sits a line above this heading, restating the same count"* is a
 * genuine self-referential claim, with a real deictic, and it is now missed.
 *
 * Both are right, and the measurement says why the gap cannot be closed by
 * choosing better. Re-admitting `a|an` to `QUANTITY` moves the count of real
 * claims across all **205** tracked non-fixture markdown files by **zero**.
 *
 * It now matches twice, and both are this argument quoting itself: #1626
 * landed a session entry reproducing the two worked examples below, so the
 * tree contains the phrase as a MENTION. `DOC-DIST-3h` therefore asserts over
 * the distinct phrases rather than a count — the quotations are named and
 * skipped, anything else is red. The row went red on that merge, which is the
 * check behaving correctly about a corpus that had genuinely changed. So round
 * 3's removal was decided by a sentence somebody constructed in a review
 * comment and not by anything in this repository — and the two sentences are
 * the same bytes to this detector, `a line above this heading` in both. What
 * separates them is grammatical mood, which is the reading-comprehension
 * problem this module refuses to pretend to solve.
 *
 * The articles stay out, because a false positive on an instruction is a
 * sentence somebody must rewrite to satisfy a checker, and a false negative is
 * a claim that goes unrefused — the direction this check is allowed to be
 * wrong in. That is a choice, not an oversight, and `UNCAUGHT_VOCABULARY`
 * holds the sentence it gives up.
 */

/** A refused claim, with enough to find it without opening the file. */
export interface ProseSelfDistance {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * The deictic referents that make a distance self-referential. `this spec`
 * and `this document` are here because a distance measured from the document
 * as a whole decays the same way one measured from a line does.
 *
 * **`rule` and `check` were added at round 9 of the #1624 review**, and the
 * finding behind them is the one about process rather than about words:
 * `QUANTITY`, `UNIT` and `DIRECTION` were each revisited across several
 * rounds and **this list never was**, so it kept whatever the first draft
 * guessed. *"ticked, 46 lines above this check"* and *"two lines above this
 * rule"* are the shape the module exists to refuse, in the vocabulary
 * `.claude/rules/*.md` actually uses, and both went free.
 *
 * Free, measured: admitting them moves the count across all 205 tracked
 * non-fixture markdown files by **zero**, so this is the same category as
 * `before`/`after` and the structural units — a gap closed at no cost, not a
 * widening traded against false positives.
 *
 * **A wider set was measured and deliberately not taken.** `criterion`,
 * `entry`, `item` and `step` also cost zero today. They are not here, because
 * "costs zero today" is exactly the argument behind both widenings this pull
 * request had to undo (rounds 3 and 4): every word is future false-positive
 * surface, and the two that are here are the two a reviewer produced a real
 * sentence for. A third should arrive the same way.
 *
 * **Round 10 made that paragraph into rows, which is this module's own
 * standard applied back to it.** Describing a limit in a docblock is what
 * `UNCAUGHT` exists not to do. REFERENTS was the fourth closed vocabulary and
 * the only one with no declared limit, so the next reviewer to notice a
 * missing word was set up to repeat the rounds 2–3 patch cycle on it. The
 * four words above, and a bare `this one`, are now `UNCAUGHT_VOCABULARY`
 * rows: each paired with a control that must stay caught, and admitting one
 * means deleting its row rather than quietly outgrowing a sentence.
 *
 * `this one` is the row that is NOT a candidate. A bare pronoun names
 * whatever the previous clause named, so admitting it would not widen the
 * deictic requirement, it would dissolve it.
 */
const REFERENTS =
  "line|bullet|paragraph|section|sentence|spec|document|file|row|table|heading|list|comment|note|rule|check";

/**
 * Spelled-out numbers as well as digits: *"two hundred lines away"* carries
 * no digit and so is invisible to `.claude/line-citation-ratchet.json`, which
 * counts `path:NNN` citations. That gap is why this is a separate check and
 * not a widening of that one.
 *
 * **`a` and `an` are NOT counts, and were removed in round 3 of the #1624
 * review.** *"Add a line above this heading explaining the exception"* is an
 * instruction, not a claim, and the first two drafts refused it — the same
 * false positive as `on` in `DIRECTION`, which I had already found and fixed
 * without applying the lesson one constant over. An article is a determiner;
 * every member left is a number or a word that means one.
 */
const QUANTITY =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve" +
  "|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen" +
  "|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety" +
  "|hundred|dozen|several|many|[0-9][0-9,]*)" +
  "(?:[ -](?:hundred|thousand))?";

/**
 * `before` and `after` are here because a position is as natural a way to
 * spell a self-referential distance as a direction — *"three lines before
 * this section"* — and the first draft of this module omitted both, which the
 * review of #1624 caught. Measured over all 205 tracked non-fixture markdown
 * files on 2026-10-27, admitting them adds **zero** violations, so this is a
 * gap closed at no cost rather than a widening traded against false
 * positives. The same measurement admitted `sixty`…`ninety`, `dozen` and a
 * standalone `hundred` to `QUANTITY`: three lines in the tree spell a
 * distance that way, none carries a deictic.
 *
 * `on` was here in the first two drafts and is **removed**: it is not a
 * direction, it is the commonest preposition in English, and the review of
 * #1624 produced the sentence that breaks it — *"This file lists two pages
 * on this document that still need review"* is not a distance claim at all
 * and was refused. Nothing in the tree needed it; every direction left is a
 * word that can only mean displacement.
 */
const DIRECTION =
  "above|below|away|apart|earlier|later|up|down|back|before|after";

/**
 * The unit the distance is counted in. `lines` is where both live instances
 * were; the structural units are here because they are what a writer reaches
 * for next and the widening is free — measured 2026-10-27, a structural unit
 * followed by a deictic referent occurs **zero** times in the tree, so no
 * true sentence is refused by admitting them.
 */
const UNIT = "lines?|rows?|sections?|paragraphs?|bullets?|columns?|pages?";

/**
 * The deictic half of the pattern, as its own exported substring.
 *
 * This exists so the mutation can be PERFORMED on the real pattern rather
 * than approximated. The first version of `DOC-DIST-6` hand-wrote a widened
 * regex beside the real one and called it the mutant; the review of #1624
 * pointed out it had already drifted — it was missing `eleven`, `twenty`,
 * `many`, `back` and more — so the row was comparing two independent
 * vocabularies and reporting it as the deictic requirement being removed.
 * Two deciders that agree, in the test written to demonstrate they must not
 * be.
 *
 * `PROSE_SELF_DISTANCE_PATTERN` contains this string **exactly once**, which
 * the test asserts before it mutates, so deleting it is the whole and only
 * difference between the real rule and the banned one.
 *
 * The distance and the referent are allowed up to 60 characters apart so that
 * "167 lines below this spec's own …" matches, and no more, because the wider
 * the window the more likely two unrelated clauses are joined into a claim
 * nobody made.
 *
 * ## The window crosses a line break, and that is the whole point
 *
 * The first two drafts matched each physical line on its own. This repo
 * hard-wraps prose at around 76 characters, so a claim whose distance and
 * deictic land on opposite sides of a wrap was invisible:
 *
 *     that criterion was ticked some 46 lines above
 *     this document's own listing of criteria.
 *
 * — exactly the shape the module exists to refuse. The review of #1624 found
 * it, and the measurement this module reported did not: both live instances
 * sat on single very long unwrapped lines, so **"0 violations" was a property
 * of how today's tree happens to wrap**, not of the rule. A detector narrower
 * than what it detects, in the one place that is least excusable.
 *
 * So the gap admits a newline and the scan runs over the whole file rather
 * than line by line.
 *
 * ## But a newline is not only a wrap, and a blank line is not the only stop
 *
 * The first attempt at the above crossed ANY non-blank newline, which let the
 * window walk out of one block and into the next. Round 4 of the #1624 review
 * produced the input:
 *
 *     - the offset drifts three lines down
 *     - this paragraph is unrelated
 *
 * Two unrelated bullets. The first ends with no terminal stop, so the gap
 * crossed `\n- ` — three characters of its sixty — and read them as one
 * claim. That is the seventeen-false-positives shape the whole module was
 * narrowed to avoid, reintroduced by the fix for the wrap. The reviewer's
 * sharper point is the one worth keeping: **`DOC-DIST-4` passing proved only
 * that today's tree does not contain the input**, and no row covered it, so
 * the mechanism had no evidence either way.
 *
 * A newline may therefore be crossed only into a **continuation** — a line
 * that starts no new block. A blank line stops it, and so does a list
 * marker, a table row, a heading, a blockquote and a fence, because each of
 * those opens something the previous line was not part of. `DOC-DIST-3e`
 * plants one of each.
 *
 * ### The markers require their space, because CommonMark does
 *
 * The first spelling of this was a bare character class, and round 5 of the
 * review found it stopping on lines that start no block at all: `#1624` is
 * an issue number this repository writes constantly and not an ATX heading,
 * `3.14` is a decimal and not an ordered-list marker, and `*italic*` is
 * emphasis. Each of those made the window refuse to cross a line it should
 * have crossed.
 *
 * The direction is the opposite of round 4's — these are false NEGATIVES, a
 * claim going unrefused rather than a true sentence being refused — which
 * makes them quieter and no less wrong. CommonMark requires a space after
 * `-`, `*`, `+`, `#` and an ordered marker, so the pattern requires one too;
 * `>` and `|` do not take one and so do not ask for one.
 */
const BLOCK_START = "[-*+][ \\t]|#{1,6}[ \\t]|[0-9]+[.)][ \\t]|[>|]|```|~~~";

const GAP = `(?:[^.!?\\n]|\\n(?![ \\t]*(?:\\n|${BLOCK_START})))`;

export const PROSE_SELF_DISTANCE_DEICTIC = `${GAP}{0,60}?\\bthis\\s+(?:${REFERENTS})\\b`;

/**
 * ONE binding, so there is one site for a mutation to remove. A second
 * predicate deciding the same question would leave this one dead with the
 * suite still green — `.claude/rules/checks-must-be-able-to-fail.md`, *two
 * deciders that agree*.
 */
export const PROSE_SELF_DISTANCE_PATTERN =
  `\\b${QUANTITY}\\s+(?:${UNIT})\\s+(?:${DIRECTION})\\b` + PROSE_SELF_DISTANCE_DEICTIC;

/**
 * Every claim in every file, each with the line its distance phrase STARTS on.
 *
 * `g`, not a single `exec`: the earlier version reported the first match per
 * line and stopped, so a line carrying two claims answered for one — the
 * reviewer's lower-severity half of the same finding. The scan is over the
 * whole text because the window crosses wraps (see
 * `PROSE_SELF_DISTANCE_DEICTIC`), so the line number is counted from the
 * match offset rather than handed over by a loop index, and the quoted text
 * has its newlines flattened so a failure message stays one line per claim.
 */
export function proseSelfDistanceViolations(
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): ProseSelfDistance[] {
  const out: ProseSelfDistance[] = [];
  for (const { path, text } of files) {
    const pattern = new RegExp(PROSE_SELF_DISTANCE_PATTERN, "gi");
    for (const hit of text.matchAll(pattern)) {
      const line = text.slice(0, hit.index).split("\n").length;
      out.push({ file: path, line, text: hit[0].replace(/\s*\n\s*/g, " ") });
    }
  }
  return out;
}

/** What to do about one, in the failure message rather than in a rule nobody opens. */
export const PROSE_SELF_DISTANCE_FIX =
  "name the section instead of counting lines to it — a heading reference cannot " +
  "drift without the heading changing, and a line count drifts on every insertion " +
  "above it with nothing going red. There is no allowlist: the replacement is " +
  "always available.";
