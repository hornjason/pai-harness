/**
 * Telling a coverage CLAIM from a CITATION inside a comment (#360).
 *
 * `coverageClaimSites` credits a test file with covering `SC-N` when the file
 * mentions the id in a comment. #149 chose that position deliberately and is
 * right about it — a comment is prose, and prose is where a project declares
 * intent. What the position cannot do is tell these apart:
 *
 *     // covers SC-640                                 ← a claim
 *     // SC-640 was the criterion the collision broke  ← a citation
 *
 * Two of those were caught in the wild while shipping #330, both of them a
 * file that discusses coverage attribution certifying the criterion it
 * discusses. That is the self-reference this area keeps producing.
 *
 * ## Why these five forms and not a new marker
 *
 * Measured first, per the project's own rule, and the measurement chose the
 * design. Of 220 comment-position credits on the tree at the time:
 *
 *     67  a coverage verb within 60 chars before the id
 *     34  the id ends a leading id-list terminated by `:`
 *     40  the id is the first token on its line
 *     79  none of those
 *
 * A systematic sample of 16 of the 79, read in full, split 11 claims to 5
 * citations — and the split was not subtle. Every one of the five citations
 * sat MID-SENTENCE inside running prose; every one of the eleven claims sat
 * in a structural position, in two forms the first three rules missed.
 *
 * So the rule is not "adopt a `covers:` marker". The population already
 * separates itself by structural position, and a new marker would mean
 * migrating ~70 files to re-state something they already say. The rule is:
 * **a declaration occupies a structural position; a bare id inside a running
 * sentence is a citation.**
 *
 * Projected loss when this landed: ~25 of 220, not 206 — which is what makes
 * the staging requirement satisfiable by the design instead of by a
 * migration.
 *
 * ## The failure direction this is allowed to have
 *
 * Toward NOT crediting. A form nobody thought of is a lost credit, which
 * shows up as an unticked checkbox someone fixes by adding one line. The
 * other direction certifies a criterion nothing tests, and
 * `.claude/rules/checks-must-be-able-to-fail.md` says never to fail that way.
 */

/** A structural position that could only have been written to declare coverage. */
export type ClaimForm =
  /** `covers`/`covering`/`coverage` within 60 chars before the id. */
  | "covers"
  /** The id ends a leading id-list terminated by `:` — `AC-2 / SC-516 / SC-517:`. */
  | "label"
  /** The id is the first token on its line, after comment delimiters. */
  | "line"
  /** A `SPEC-REF:` line, whatever follows it on that line. */
  | "spec-ref"
  /** The id is inside a parenthetical holding only ids — `… turns it red (SC-4).` */
  | "attribution";

const COVERS_NEAR = /\b(?:covers?|covered|covering|coverage)\b[^\n]{0,60}$/i;

/**
 * A verb directly after the id, making the line a SENTENCE about the
 * criterion rather than a heading naming it.
 *
 * Opening a line is not quite enough on its own:
 * `// SC-621 was the criterion the collision broke` is a citation that
 * happens to come first. But the first fix for that was worse than the bug.
 * An allowlist of what may follow a heading — end of line, a parenthetical,
 * a dash, a spec filename — rejected ` * SC-722 of GATE-CONTRACTS-SPEC.md.`
 * and ` * #173 — SC-587, SC-588, SC-589, SC-590.`, and took 30 criteria to
 * zero coverage in one step. Measured, not argued: the loose rule costs 13
 * credits across the tree, the allowlist costs 44.
 *
 * So this is a small closed stop-list instead, which is the one place a
 * stop-list beats an allowlist. The set of English words that turn a heading
 * into a sentence is small and closed; the set of ways to write a heading is
 * neither. A word missing from this list costs ONE false credit on a line
 * that still had to begin with the id — bounded. A heading form missing from
 * an allowlist costs every credit written that way.
 *
 * Every entry was taken from a real citation in this tree.
 */
const SENTENCE_TAIL =
  /^(?:'s|’s)?\s+(?:was|were|is|are|says?|said|below|above|asked|exists?|existed|had|has|became|names?|named|declares?|declared|turns?|would|will|means?|refers?)\b/i;
const SPEC_REF_LINE = /^[\s*\/|─—-]*SPEC-REF\b/i;

/**
 * An id-list opening a line: `SC-561..SC-564 (SPEC.md)`, `SC-699, SC-700, …`.
 *
 * Ranges are why `line` alone is not enough — on `SC-561..SC-564 (SPEC.md)`
 * only `SC-561` is the line's first token, and the credit being asked about
 * is usually one of the others.
 *
 * The optional `#\d+` prefix is this repo's most common header form and was
 * the single largest group in the unmarked population: `#178 / SC-413:`,
 * `#173 — SC-587, SC-588, SC-589, SC-590.`, `#323 SC-6 —`, `#190 / SC-624:`.
 * An issue number before the ids does not make the line less of a heading.
 */
const LEADING_ID_RUN = /^[\s*\/|─—-]*(?:#\d+\s*[\/|—–:-]*\s*)?(?:(?:SC|AC)-[A-Z]?\d+(?:\s*(?:\.\.+|,|\/|\||and|&|–|—|-)\s*)?)+/;

/** The same run, but required to terminate in a colon — a label, not a list. */
const LEADING_ID_LABEL = /^[\s*\/|─—-]*(?:#\d+\s*[\/|—–-]*\s*)?(?:(?:SC|AC)-[A-Z]?\d+[\s,\/|]*)+:/;

const LINE_START = /(?:^|\n)[\s*\/|─—-]*$/;

/**
 * Which structural form the mention at `at` occupies, or `null` for prose.
 *
 * `comment` is the full enclosing comment and `at` is the id's offset WITHIN
 * it. The caller owns recovering both; see `enclosingComment`.
 *
 * THE single exported predicate for this question, so there is one binding to
 * mutate. A second place to decide what counts as a claim would survive any
 * mutation of this one and the guard would go red for a reason that has
 * nothing to do with the mutation working.
 */
export function commentClaimForm(comment: string, at: number, id: string): ClaimForm | null {
  if (at < 0 || at >= comment.length) return null;
  const before = comment.slice(0, at);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = comment.slice(lineStart);
  const inLine = at - lineStart;

  if (COVERS_NEAR.test(before)) return "covers";
  if (SPEC_REF_LINE.test(line)) return "spec-ref";

  const label = LEADING_ID_LABEL.exec(line);
  if (label && label[0].length > inLine) return "label";

  const run = LEADING_ID_RUN.exec(line);
  const leading = (run && run[0].length > inLine) || LINE_START.test(before);
  if (leading && !SENTENCE_TAIL.test(line.slice(inLine + id.length))) return "line";

  if (inIdOnlyParenthetical(line, inLine)) return "attribution";

  return null;
}

/**
 * A parenthetical holding NOTHING BUT ids — `(SC-4)`, `(SC-358, SC-359)`.
 *
 * Line-scoped on purpose. A multi-line scan would let an unclosed paren three
 * paragraphs up swallow a whole docblock, and every prose mention in it would
 * read as an attribution — the fail-open direction this module is not allowed
 * to have.
 *
 * Ids-only is the second half, and it was not the first version. Allowing any
 * parenthetical credited `("see SC-621")` in test/spec-sc-ids-unique.test.ts —
 * inside a comment whose next clause is "Counting citations would make". A
 * rule that credits a sentence explaining why citations must not be credited
 * is the self-reference this whole area keeps producing, and it was caught by
 * reading the diff of lost credits rather than by the rule itself.
 */
const IDS_ONLY =
  /^[\s,\/|&+-]*(?:(?:#\d+|(?:SC|AC)-[A-Z]?\d+)(?:\s*(?:\.\.+|,|\/|\||&|and|–|—|-)\s*)?)+[\s.]*$/;

/**
 * A parenthetical that LABELS: opens with an id and a colon, then prose.
 *
 * `── Extraction floor (SC-343: this file is the engine's unit-test home) ──`
 * is a heading, and the colon is the same declaring signal as `SC-640:` at
 * the start of a line. Restricted to parentheses on purpose: the bare
 * "an id followed by a colon anywhere" rule would credit
 * `// The SC statement in a spec file: "SC-318: Something (behavioral)"`,
 * which is a QUOTED EXAMPLE of a spec line, not a claim about one.
 */
const PAREN_LABEL = /^\s*(?:SC|AC)-[A-Z]?\d+\s*:/;

/**
 * A RANGE inside a parenthetical — `(SC-1930..SC-1948)`.
 *
 * An attribution names THE criterion a statement is about. A range names a
 * group, which is how prose refers to a set it is discussing rather than
 * claiming, and the scanner can only see the two ids that are literally
 * written: a range of nineteen credits its two endpoints and silently not
 * the seventeen between them. A form that credits 2 of the 19 ids it names
 * is not measuring anything.
 *
 * Found in #574, on this sentence:
 *
 *     * The spec's 19 behavioural criteria (SC-1930..SC-1948) are NOT
 *     * covered here.
 *
 * — which credited SC-1930 and SC-1948 and ticked both boxes. The
 * self-reference this area keeps producing, now in its sharpest form: a
 * comment saying the criteria are not covered was the evidence that they
 * were.
 *
 * Measured before narrowing, because narrowing a detector is the change
 * most likely to buy green with blindness: of 32 attribution credits in the
 * tree, 30 are plain and 2 are ranges — and the 2 are these. A range at the
 * START of a line is still a claim, by the `line` form, which is where
 * `* SC-561..SC-564 (SPEC.md)` is credited and is unaffected.
 */
const PAREN_RANGE = /\.\.+/;

function inIdOnlyParenthetical(line: string, at: number): boolean {
  const open = line.lastIndexOf("(", at);
  if (open < 0) return false;
  const close = line.indexOf(")", open);
  if (close < 0 || close < at) return false;
  const inner = line.slice(open + 1, close);
  if (PAREN_RANGE.test(inner)) return false;
  return IDS_ONLY.test(inner) || PAREN_LABEL.test(inner);
}

/**
 * A `describe`/`test`/`it` call that opens a title literal, and whether it
 * will ever run (#574).
 *
 * A test title is the project's oldest coverage convention and the one
 * position that needed no rule — until `test.todo("SC-1930: …")` turned out
 * to be a title too. A todo is the one test guaranteed never to fail, so
 * crediting it produces a tick indistinguishable from a tick earned by a
 * test that can go red. Measured when this was found: 64 ids named only
 * inside a `.todo`, 37 of them ticked `[x]` in a spec, and 19 more about to
 * flip on the next run of the sync — one of them from a file whose own
 * comment says, four lines from the top, that none of its criteria are
 * covered here.
 *
 * `.skip` is the same fact with a different word, and there are five of
 * those. `.skipIf` and `.todoIf` take a condition, so whether they ran is
 * not answerable from the source at all; there are none today and they are
 * named anyway, because a predicate narrower than what it detects is this
 * repo's third defect shape and the cost of naming them is one word each.
 *
 * `.only`, `.each`, `.failing` and `.concurrent` all RUN, so they still
 * credit — `.failing` included, because a test expected to fail is still a
 * test that goes red when the expectation stops holding.
 *
 * Returns `null` when the text does not open a title call at all. The three
 * answers are distinct on purpose: a non-running title must be reported as
 * UNMEASURED rather than dropped, and dropping it would make "nobody has
 * written this test" look exactly like "nobody has mentioned this id".
 */
export type TitleCall = "runs" | "never-runs";

const NON_RUNNING = /\.(?:todo|skip|skipIf|todoIf)\b/;

/** Opens a `describe`/`test`/`it` title, allowing `.each(...)`, `.only`, `.skip`, `.todo`. */
const TITLE_CALL = /\b(?:describe|test|it)\s*((?:\.\w+\s*(?:\([^)]*\))?\s*)*)\(\s*$/;

/**
 * THE single exported predicate for whether a title call declares coverage,
 * for the same reason `commentClaimForm` is: one binding to mutate.
 */
export function titleCall(before: string): TitleCall | null {
  const m = TITLE_CALL.exec(before);
  if (m === null) return null;
  return NON_RUNNING.test(m[1] ?? "") ? "never-runs" : "runs";
}
