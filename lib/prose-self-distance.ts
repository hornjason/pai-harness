/**
 * DOC-DIST: a document may not state, in prose, how many lines away one of
 * its OWN parts is.
 *
 * ## What this refuses, and what it deliberately does not
 *
 * "the comment recording #174 sits four lines above it" is about a source
 * file this document is describing. That distance is a fact about another
 * artefact, it is as checkable as any other quoted fact, and nothing here
 * touches it. Measured on 2026-10-27 the tree held **19** distance claims and
 * **17** were of that kind.
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
 */
const REFERENTS =
  "line|bullet|paragraph|section|sentence|spec|document|file|row|table|heading|list|comment|note";

/**
 * Spelled-out numbers as well as digits: *"two hundred lines away"* carries
 * no digit and so is invisible to `.claude/line-citation-ratchet.json`, which
 * counts `path:NNN` citations. That gap is why this is a separate check and
 * not a widening of that one.
 */
const QUANTITY =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|a|an|several|many|[0-9][0-9,]*)" +
  "(?:[ -](?:hundred|thousand))?";

const DIRECTION = "above|below|away|apart|earlier|later|up|down|back|on";

/**
 * The unit the distance is counted in. `lines` is where both live instances
 * were; the structural units are here because they are what a writer reaches
 * for next and the widening is free — measured 2026-10-27, a structural unit
 * followed by a deictic referent occurs **zero** times in the tree, so no
 * true sentence is refused by admitting them.
 */
const UNIT = "lines?|rows?|sections?|paragraphs?|bullets?|columns?|pages?";

/**
 * ONE binding, so there is one site for a mutation to remove. A second
 * predicate deciding the same question would leave this one dead with the
 * suite still green — `.claude/rules/checks-must-be-able-to-fail.md`, *two
 * deciders that agree*.
 *
 * The distance and the referent are allowed up to 60 characters apart so that
 * "167 lines below this spec's own …" matches, and no more, because the wider
 * the window the more likely two unrelated clauses are joined into a claim
 * nobody made.
 */
export function proseSelfDistanceViolations(
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): ProseSelfDistance[] {
  const pattern = new RegExp(
    `\\b${QUANTITY}\\s+(?:${UNIT})\\s+(?:${DIRECTION})\\b[^.!?\\n]{0,60}?\\bthis\\s+(?:${REFERENTS})\\b`,
    "i",
  );
  const out: ProseSelfDistance[] = [];
  for (const { path, text } of files) {
    text.split("\n").forEach((raw, i) => {
      const hit = pattern.exec(raw);
      if (hit !== null) out.push({ file: path, line: i + 1, text: hit[0] });
    });
  }
  return out;
}

/** What to do about one, in the failure message rather than in a rule nobody opens. */
export const PROSE_SELF_DISTANCE_FIX =
  "name the section instead of counting lines to it — a heading reference cannot " +
  "drift without the heading changing, and a line count drifts on every insertion " +
  "above it with nothing going red. There is no allowlist: the replacement is " +
  "always available.";
