/**
 * What a test file declares, and what each declaration's BODY is (#880).
 *
 * ## Why a body, when a title was enough for #659
 *
 * It was never enough. `lib/test-case-deletion.ts` has said since it was
 * written that *"a name that is gone is a deleted passing test, a deleted
 * failing test, a renamed test, or a test somebody moved to another file"*,
 * and then compared `Set<string>` of titles — so three of those four read as
 * the first one. Run `wf_99ed276b-cf3` is the bill: eight cases reported
 * missing, seven of them renamed by the repair round, net coverage over the
 * run 19 → 27, and the run refused.
 *
 * A title is the one part of a test that a rename is DEFINED as changing.
 * The body is the part a rename is defined as leaving alone, so the body is
 * what the comparison has to be about. #880 ranks its own three remedies and
 * puts this first — *"the only one that is actually a measurement"* — with
 * the other two, title similarity and a louder refusal, as heuristics.
 *
 * ## The comparison is identity, not similarity
 *
 * Two bodies are the same body when they are IDENTICAL after `normalisedBody`
 * removes comments and collapses runs of whitespace. Those are the two kinds
 * of difference that carry no behaviour. There is no threshold, no distance
 * and no score, and that is a deliberate refusal of #880's option 2: a
 * heuristic that guesses wrong in the reassuring direction — pairing a
 * deleted case with an unrelated new one and reporting "renamed" — is worse
 * than the refusal it replaces, because the operator stops looking.
 *
 * Everything this cannot pair is reported as a deletion, which is the
 * pre-#880 answer. A case renamed AND edited in one round reads as a
 * deletion plus an addition, and that is the direction to be wrong in.
 *
 * ## Why no hash
 *
 * #880 says "hash the normalised test body". The hash is an implementation
 * detail of "compare the normalised body", and omitting it removes a whole
 * class of reasoning about collisions for nothing — a test file holds
 * hundreds of cases, not millions, so the normalised string IS the key. One
 * fewer binding to mutate, and `normalisedBody` is the only thing deciding
 * what "the same body" means.
 *
 * ## The scan knows about strings, templates, comments and regexes
 *
 * `lib/source-slice.ts` is the repository's structural-cut binding and is
 * deliberately NOT used here: its docblock says in as many words that its
 * bracket scan *"does not know about strings, comments or regex literals"*,
 * and it refuses an anchor that occurs twice. Both are right for cutting one
 * named construct out of a document and wrong for cutting every `test(...)`
 * call out of a suite, where titles repeat and bodies are full of
 * `toMatch(/[)(]/)`. So the scanner below is its own thing, and
 * `matchingCallParen` is the ONE place that decides where a call ends.
 *
 * ## What was broken to prove it
 *
 * Run and counted over `test/unit/case-rename-detection.test.ts` +
 * `test/deletion-verdict-relay.test.ts` +
 * `test/unit/deleted-case-non-vacuous.test.ts` — 87 tests. Every count was
 * predicted before the battery ran, and **the baseline row was read before
 * any mutation row**: an instrument that has stopped reporting takes the
 * baseline down with it, and that is the row nobody mutates anything to
 * produce.
 *
 * **Provenance.** P1–P11 were first measured at a baseline of 82, before the
 * second security review added the `describe`-chain key and two cases. They
 * were ALL re-run against the final tree rather than carried over — a row
 * measured on a tree nobody can check out is a claim rather than a count
 * (`.claude/rules/parallel-sessions.md`). Only P1 moved, from 7 to 8, and
 * the extra red is AC-18's control.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 87 pass, 0 fail | **87 pass, 0 fail** | — |
 * | P1 `renamePairs` short-circuited to `return []` | 8 | **8 of 87** | AC-1's pair: the original returns one `{from, to}`, the mutant none, and the renamed case goes back to being reported deleted |
 * | P2 the call-site modifier dropped from `pairingKey` | 1 | **1 of 87** | `test("x", BODY)` becoming `test.skip("y", BODY)`: the original reports a deletion, the mutant a rename |
 * | P3 the phantom `continue` removed | 3 | **3 of 87** | a line reading `const GATE_CHECK = 'test("a free port passes", …)'`: the original reports no case, the mutant one — whose name then discharges a real deletion |
 * | P4 `MIN_IDENTIFYING_BODY` set to 0 | 4 | **4 of 87** | #659's fixture: a placeholder body disappearing beside an identical one appearing |
 * | P5 the body index narrowed to the CHANGED cases | 1 | **1 of 87** | a file where one rename is the only change and a third case carries the same body at both commits |
 * | P6 `normalisedBody` stops stripping comments | 2 | **2 of 87** | one body carrying a line comment and an otherwise identical one that does not |
 * | P7 **the cheapest wrong fix** — string and numeric literals discarded | 2 | **2 of 87** | `expect(reading.total).toBe(4)` against the same body with `5`: the original calls them different cases, the mutant pairs them |
 * | P8 `v2` reverted to `v1` in the library only | 4 | **13 of 87** | every artefact: the token the library writes stops matching the one `workflows/ship.js` recomputes |
 * | P9 `renamedIds` dropped from the signature members, BOTH positions | 2 | **2 of 87** | one rename with `to` altered and the count unchanged — the `:n1` prefix still agrees, so only membership can see it |
 * | P10 the `DELETION_RENAMED` block removed from `ship.js` | 2 | **2 of 87** | a CLEAN reply carrying one rename: the original prints both titles, the mutant prints what a round that renamed nothing prints |
 * | P11 the rename line moved inside the CLEAN arm | 1 | **1 of 87** | a reply carrying one rename AND one deletion — #880's own scope note, and the arm a CLEAN-only line skips |
 * | P12 the enclosing chain dropped from `pairingKey` | 1 | **1 of 87** | a case wrapped in `describe.skip` at the current commit, body unchanged |
 * | P13 `blockSpans` short-circuited to `return []` | 3 | **3 of 87** | the same input, plus a case nested two blocks deep whose chain reads `["", ".skip"]` |
 * | P14 the block-comment branch dropped from `literalSpans` | 1 | **1 of 87** | a source holding a star-slash comment: the original spans it, the mutant does not |
 * | P15 `literalSpans` returning one span over the whole file | ≥15, with the phantom-drop control among them | **26 of 87**, control among them | every file: the original reads 7,514 declarations over the tree, the mutant none |
 *
 * **P7's first cut came back 1 against a predicted 2, and the low row was
 * the finding.** AC-4's two bodies normalise to 39 characters once their
 * literals are discarded, which is below `MIN_IDENTIFYING_BODY` — so the
 * FLOOR refused that pair, not the normalisation, and the case witnessed
 * nothing about the mutation it was written for (#492: a case held up by a
 * guard it is not about). AC-9 was the same shape one layer in: only its
 * direct `normalisedBody` comparison went red, while its `renamePairs`
 * half was held up by the floor too. Both bodies were lengthened past the
 * floor, and the row is 2 with the pairing as a witness rather than one
 * unit assertion.
 *
 * **P8 came back 13 against a predicted 4, and the extra reds are the real
 * kind** — read by name before the number was recorded. The prediction
 * covered the four cases that compare the two signature implementations
 * directly. The other nine are operator-line cases: a version disagreement
 * makes `deletionVerdictReading` return `DELETION_SIGNATURE_DISAGREEMENT`
 * for EVERY reply, so every case that reads a verdict goes red. Squarely
 * about the mutated behaviour, the mutant parses, and 74 cases still pass.
 * The fact it records is that a one-sided version bump is caught by the
 * whole relay suite and not only by the parity cases.
 *
 * **P11's first cut came back 30, and it was not a mutation.** The `&&` in
 * the replacement text was mangled on its way through the shell and
 * `ship.js` stopped parsing, so every case that loads it died. A mutant
 * that crashes is not a mutant — it measures that the file still parses
 * (#485). Re-cut as a ternary with no ampersand, the row is 1, and the
 * single red is the DELETED-arm case it was aimed at.
 *
 * None of the fifteen mutations is left in the tree; all were run and
 * restored from a `cp` backup, and `lib/test-case-bodies.ts`,
 * `lib/test-case-deletion.ts` and `workflows/ship.js` were confirmed
 * byte-identical afterwards by sha256 — never by `git checkout --`.
 */

/** One `test(...)` or `it(...)` declaration, in source order. */
export interface CaseDeclaration {
  /** The title as the source declared it, escapes resolved. */
  name: string;
  /**
   * The call's arguments AFTER the title — the comma, the options object if
   * there is one, and the callback — up to but excluding the call's closing
   * paren.
   *
   * `null` when the call never closes, which is the honest reading for a
   * truncated or unparseable file, and also when the declaration is not one
   * — see `caseDeclarations` on phantoms. A `null` body pairs with nothing,
   * so an unreadable case is reported as a deletion rather than matched.
   */
  body: string | null;
  /**
   * `""` for a plain `test(`, or the modifier as written — `.skip`,
   * `.todo`, `.only`, `.failing`, `.skipIf`, `.todoIf`, `.runIf`.
   *
   * ## Why this is part of the case's identity and not metadata
   *
   * Found by the security review of this change, and it is the defect this
   * whole module exists to avoid, arriving inside the fix for it. A round
   * that turns
   *
   *     test("a free port passes", () => { …body… })
   *
   * into
   *
   *     test.skip("a free port passes, now quarantined", () => { …body… })
   *
   * leaves the body byte-identical. Pairing on the body alone reports it as
   * a rename and says *"no coverage left with them"* — which is false: the
   * assertions no longer run, which is #659's *"a gate that passes because
   * its test is gone is not a gate that passed"* with the test still
   * sitting in the file.
   *
   * The pre-#880 title comparison ignored the modifier too, and that was
   * harmless because it never claimed anything had survived. The claim is
   * what makes this load-bearing, so the modifier is keyed into the
   * pairing and a case that changed modifier is reported as a DELETION.
   */
  modifier: string;
  /**
   * The modifiers of the `describe` / `suite` calls this one sits inside,
   * outermost first — `[]` at the top level, `[".skip"]` inside a
   * `describe.skip`, `["", ".skip"]` inside a plain describe holding a
   * skipped one.
   *
   * The same defect as `modifier`, one level out, and found by the second
   * security review after the first found the call-site one. Wrapping a
   * renamed case in `describe.skip(...)` leaves the case's own call
   * untouched and its body byte-identical, so a key built from the call
   * site alone pairs it and says no coverage left with it. It did.
   *
   * A separate field rather than being folded into `modifier` at the scan,
   * because `modifier` means what it says — the call-site modifier, which
   * `AC-16` asserts directly. Both are data; `pairingKey` is the single
   * place that decides what they MEAN for identity.
   */
  enclosing: string[];
}

/**
 * `test("…")` and `it("…")`, including the `.skip`, `.only`, `.todo` and
 * `.failing` forms.
 *
 * Moved here from `lib/test-case-deletion.ts` unchanged, so that the names
 * and the bodies come from ONE scan. Two regexes answering "what is a test
 * declaration" would be two deciders that agree until they do not, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape — and this
 * repository already has that defect once over, between this expression and
 * `lib/test-census.ts`'s `DECLARATION`. Measured 2026-10-21: the two
 * disagree on 174 of 483 test files here. That one is not #880's to fix and
 * is filed separately; this module at least does not add a third.
 *
 * `describe` is deliberately not matched: a renamed describe block is not a
 * renamed case. The first group is the quote character and the second is the
 * raw name, escapes included.
 */
const CASE_DECLARATION =
  /(?:^|[^.\w$])(?:test|it)(\.(?:skip|only|todo|failing|skipIf|todoIf|runIf))?\s*\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** A source-level string literal's VALUE. */
function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => ESCAPES[ch] ?? ch);
}

// ── The scanner ──────────────────────────────────────────────────────────

/**
 * Keywords after which a `/` opens a regular expression rather than dividing.
 *
 * The list is explicit rather than "any identifier", because the common case
 * by far is `a / b` and reading that as a regex runs the scan to the end of
 * the file. A form nobody thought of costs a `body` of `null`, which reports
 * the case as a deletion — the direction this module is allowed to be wrong
 * in.
 */
const REGEX_AFTER = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "do", "else", "yield", "await", "case", "throw",
]);

/**
 * Whether the `/` at `i` opens a regular expression.
 *
 * Reads the source backwards rather than threading a "previous token" through
 * every caller. One binding, asked by both the paren scan and the
 * normaliser, so the two cannot disagree about where a regex starts.
 */
function regexHere(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  // A closer, a quote or a digit ends a VALUE, and a `/` after a value is
  // division. `if (x) /re/.test(y)` is legal and is not written.
  if (/[)\]}"'`\d]/.test(c)) return false;
  if (/[\w$]/.test(c)) {
    const m = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, j - 24), j + 1));
    return m !== null && REGEX_AFTER.has(m[1]);
  }
  // `(`, `,`, `=`, `:`, `;`, `!`, `&`, `|`, `?`, an operator, `{`, `[` — an
  // expression is starting, so a `/` is a regex.
  return true;
}

/** Past a `'…'` or `"…"` opening at `i`, or `null` when it does not close. */
function skipQuoted(src: string, i: number): number | null {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === quote) return j + 1;
    if (c === "\n") return null;
  }
  return null;
}

/**
 * Past the star-slash closing a block comment opening at `i`.
 *
 * Spelled in words rather than as the two characters, because those two
 * characters inside this very comment would end it — which is how #877's
 * first draft turned the rest of its own module into code.
 */
function skipBlockComment(src: string, i: number): number | null {
  const end = src.indexOf("*/", i + 2);
  return end < 0 ? null : end + 2;
}

/** Past a regex literal opening at `i`, flags included. */
function skipRegex(src: string, i: number): number | null {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "\n") return null;
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") { inClass = true; continue; }
    if (c === "/") {
      let k = j + 1;
      while (k < src.length && /[a-z]/.test(src[k])) k++;
      return k;
    }
  }
  return null;
}

/** Past the backtick closing a template opening at `i`, interpolations and all. */
function skipTemplate(src: string, i: number): number | null {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") return j + 1;
    if (c === "$" && src[j + 1] === "{") {
      const end = skipBalanced(src, j + 1, "{", "}");
      if (end === null) return null;
      j = end - 1;
      continue;
    }
  }
  return null;
}

/**
 * Past the closer matching the opener at `i`, skipping every literal and
 * comment between them.
 *
 * The ONE place a bracket is counted, so the call scan, the template scan
 * and anything added later cannot end up with three opinions about whether a
 * `)` inside a string closes a call.
 */
function skipBalanced(src: string, i: number, open: string, close: string): number | null {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      const end = skipQuoted(src, j);
      if (end === null) return null;
      j = end;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(src, j);
      if (end === null) return null;
      j = end;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      const nl = src.indexOf("\n", j);
      j = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const end = skipBlockComment(src, j);
      if (end === null) return null;
      j = end;
      continue;
    }
    if (c === "/" && regexHere(src, j)) {
      const end = skipRegex(src, j);
      // A `/` the regex scan cannot close is division after all; step over it
      // rather than abandoning the whole cut.
      j = end === null ? j + 1 : end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return null;
}

/**
 * The index of the `)` closing the call whose `(` is at `open`, or `null`.
 *
 * Exported so a caller can establish that the scan reaches past a hostile
 * body rather than inferring it from a body that happens to look right.
 */
export function matchingCallParen(src: string, open: number): number | null {
  const end = skipBalanced(src, open, "(", ")");
  return end === null ? null : end - 1;
}

/**
 * The `[start, end)` ranges of every string, template, comment and regex in
 * a source file, in ascending order.
 *
 * A `test("…"` sequence inside one of those is not a declaration: it is a
 * repository that writes about its own tests. Measured 2026-10-21, this
 * tree has eleven, `const GATE_CHECK = 'test("prove-label-…"'` in
 * `test/prove-label-gate.test.ts` being the clearest.
 *
 * They were already harmless BY ACCIDENT — a paren that was never opened as
 * code does not close, so the body came back `null` and a `null` body pairs
 * with nothing. Accidental protection is the thing this repository's rules
 * are mostly about, so it is made deliberate here: a phantom on the AFTER
 * side whose parens happened to balance could otherwise discharge a real
 * deletion, which is the reassuring-direction error with no witness.
 */
export function literalSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    let end: number | null = null;
    if (c === '"' || c === "'") end = skipQuoted(source, i);
    else if (c === "`") end = skipTemplate(source, i);
    else if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      end = nl < 0 ? source.length : nl;
    } else if (c === "/" && source[i + 1] === "*") end = skipBlockComment(source, i);
    else if (c === "/" && regexHere(source, i)) end = skipRegex(source, i);
    else {
      i++;
      continue;
    }
    // An unterminated literal: step one character rather than giving up on
    // the file. The rest of the scan is still worth having, and the
    // declarations inside the unterminated region simply are not marked.
    if (end === null || end <= i) {
      i++;
      continue;
    }
    spans.push([i, end]);
    i = end;
  }
  return spans;
}

// ── The declarations ─────────────────────────────────────────────────────

/**
 * Every case a source file declares, with its body, in declaration order.
 *
 * `lib/test-case-deletion.ts`'s `caseNames` is a projection of this, so the
 * list of names and the list of bodies are the same reading seen twice and
 * cannot fall out of step.
 */
export function caseDeclarations(source: string): CaseDeclaration[] {
  const out: CaseDeclaration[] = [];
  const spans = literalSpans(source);
  const inLiteral = (at: number) => spans.some(([s, e]) => at >= s && at < e);
  const blocks = blockSpans(source, inLiteral);
  // A budget across the whole call, so a malformed file cannot turn an
  // O(n) scan per declaration into a gate that never returns. It cannot be
  // reached by a well-formed file: every body is scanned once, so the total
  // is about the length of the source. A declaration past the budget gets
  // no body and is therefore reported as a deletion — loud, and the safe
  // direction — rather than silently paired.
  let budget = Math.max(source.length * 8, 1_000_000);

  for (const m of source.matchAll(CASE_DECLARATION)) {
    // A template literal with an interpolation has no single name to record,
    // and reporting its text as a name would make it look deleted the moment
    // the interpolation changed.
    if (m[2] === "`" && m[3].includes("${")) continue;
    // The FIRST paren in the match is the call's own: the title literal is
    // an argument, so nothing with a paren in it can precede this one.
    const open = m.index! + m[0].indexOf("(");
    const titleEnd = m.index! + m[0].length;
    // A phantom — the sequence inside a string, a comment or a regex — is
    // not a declaration and is DROPPED, not merely left body-less.
    //
    // Giving it a null body was the first draft and it is not enough: a
    // phantom still carries a NAME, and `caseChanges` discharges a deletion
    // whose name survives. So `const GATE_CHECK = 'test("a free port
    // passes", …)'` added in the same round that deleted that case would
    // report nothing gone — the deletion check's own defect, reachable
    // through the name set rather than through the pairing. Found by the
    // security review of this change.
    //
    // Dropped on BOTH sides, and the asymmetric alternative was declined
    // deliberately. Keeping phantoms on the BEFORE side would make every
    // edit to one of this tree's 148 string constants report a deleted
    // test — a refusal naming something that was never a test, which is
    // the cry-wolf failure #880 is about, arriving as its fix. The real
    // risk the asymmetry guards against is `literalSpans` misclassifying a
    // REAL declaration, and that is met directly instead: the control case
    // in `test/unit/case-rename-detection.test.ts` compares this reading
    // against the raw pattern over every test file in the tree and refuses
    // any file that loses all of its declarations.
    if (inLiteral(m.index! + m[0].search(/(?:test|it)/))) continue;
    let body: string | null = null;
    if (budget > 0) {
      const close = matchingCallParen(source, open);
      // Charged what the scan actually READ, not what it might have. The
      // first draft charged `source.length - open` whether the call closed
      // after forty characters or never — which spends the budget in
      // proportion to how early a case appears in the file, and reported
      // 620 of this tree's 7,650 declarations as unreadable instead of 11.
      // The instrument case below is what caught it.
      budget -= (close === null ? source.length : close) - open;
      if (close !== null && close >= titleEnd) body = source.slice(titleEnd, close);
    }
    out.push({
      name: unescape(m[3]),
      body,
      modifier: m[1] ?? "",
      enclosing: blocks.filter(b => open > b.start && open < b.end).map(b => b.modifier),
    });
  }
  return out;
}

/** `describe(` and `suite(`, with the modifier captured. */
const BLOCK_DECLARATION =
  /(?:^|[^.\w$])(?:describe|suite)(\.(?:skip|only|todo|failing|skipIf|todoIf|runIf|each))?\s*\(/g;

/**
 * Where each `describe` / `suite` call starts and ends, outermost first.
 *
 * Ordered by start, so `filter` over it yields a case's enclosing chain
 * from the outside in without a second sort. A block whose call does not
 * close is skipped rather than extended to the end of the file: a span
 * running to EOF would put every later case inside it and silently change
 * what they are compared as.
 */
function blockSpans(
  source: string,
  inLiteral: (at: number) => boolean,
): Array<{ start: number; end: number; modifier: string }> {
  const out: Array<{ start: number; end: number; modifier: string }> = [];
  for (const m of source.matchAll(BLOCK_DECLARATION)) {
    const at = m.index! + m[0].search(/(?:describe|suite)/);
    if (inLiteral(at)) continue;
    const open = m.index! + m[0].lastIndexOf("(");
    const close = matchingCallParen(source, open);
    if (close === null) continue;
    out.push({ start: open, end: close, modifier: m[1] ?? "" });
  }
  return out;
}

/**
 * A body with the differences that carry no behaviour removed.
 *
 * Comments go — a round that renames seven cases rewrites the prose around
 * them, and a comment is not a test. Runs of whitespace collapse to one
 * space — a rename reflows the indentation of everything it wraps.
 *
 * **Nothing else goes, and that is the load-bearing sentence.** Every step
 * past this point is the cheapest wrong fix for "my rename was not
 * detected": drop the string literals, compare only the identifiers, count
 * the `expect(` calls. Each one pairs more cases, each one makes the symptom
 * go away, and each one is #880's "wrong in the reassuring direction" — a
 * deleted test reported as a rename, which is strictly worse than the
 * refusal this replaces because nobody goes looking afterwards.
 */
export function normalisedBody(body: string): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = skipQuoted(body, i);
      if (end === null) { out += body.slice(i); break; }
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(body, i);
      if (end === null) { out += body.slice(i); break; }
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      out += " ";
      i = nl < 0 ? body.length : nl;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = skipBlockComment(body, i);
      out += " ";
      if (end === null) break;
      i = end;
      continue;
    }
    if (c === "/" && regexHere(body, i)) {
      const end = skipRegex(body, i);
      if (end === null) { out += c; i++; continue; }
      out += body.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** A case present at both readings under two different titles. */
export interface RenamePair {
  from: string;
  to: string;
}

/**
 * The shortest normalised body that is allowed to identify a case.
 *
 * ## This is a threshold, and here is where the number came from
 *
 * A body says "this is the same test" only insofar as it is about
 * something. `, () => { expect(1).toBe(1); }` is about nothing: it is the
 * body of a placeholder, and two placeholders in one file are two different
 * tests that happen to be written identically. Pairing on it would report a
 * deleted test as a rename — #880's reassuring-direction error, in the one
 * place nobody ever looks again, because the whole point of reporting a
 * rename is that the operator stops investigating.
 *
 * **Found by a test that is not about this, which is why it is a constant
 * and not a comment.** `test/unit/deleted-case-non-vacuous.test.ts` is
 * #659's fixture: three cases deleted, one added, and the added one's body
 * was copied from one of the deleted ones. Without a floor, the first
 * draft of this module paired them and reported one of three deletions as
 * a rename.
 *
 * Measured over this repository, 2026-10-21 — 7,508 cases in 484 files.
 * Every distinct normalised body that two cases in one file share, by
 * length: **0, 10, 42, 55, 86, 94, 160, 369**. The 5th percentile of all
 * bodies is **82** and the median is **277**.
 *
 * 48 sits between the three boilerplate lengths and the five substantial
 * ones, and below the 5th percentile, so it excludes essentially no real
 * case from being paired.
 *
 * ## The floor and the uniqueness rule are two guards, and each has an
 * input only it reaches
 *
 * Named, because two guards answering one question are behaviourally one
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape) and
 * the only thing that makes keeping both honest is being able to say which
 * input each is for:
 *
 *   - **the floor only** — #659's fixture. A 30-character body, unique
 *     among the disappeared cases AND unique among the appeared ones, so
 *     the uniqueness rule sees a clean one-to-one match. It is a
 *     placeholder shared between two unrelated tests.
 *   - **uniqueness only** — `test/unit/bash-tool-guard.test.ts`, whose two
 *     cases share a 369-character body. Far above the floor and still
 *     evidence of nothing, because it names two cases rather than one.
 *
 * Both costs of the floor, stated rather than implied:
 *
 *   - too HIGH — a short but genuine rename reads as a deletion, which is
 *     the pre-#880 answer and the direction to be wrong in.
 *   - too LOW — a deleted placeholder is reported as a rename and nobody
 *     looks for it. That is the direction this number exists to avoid.
 *
 * And the proxy, named because a threshold can always be satisfied
 * directly: padding a test body past 48 characters would make it pairable.
 * Nothing is gained by it — the worst a pair produces is a LESS severe
 * report, and anyone able to edit the test file could simply not delete the
 * test. This is a cry-wolf problem, not an adversary.
 */
export const MIN_IDENTIFYING_BODY = 48;

/**
 * The cases that changed title and nothing else.
 *
 * ## Uniqueness is a precondition, and it is asked of the WHOLE file
 *
 * A pair is only claimed when the body occurs exactly once among ALL cases
 * at the previous commit and exactly once among ALL cases at the current
 * one — not merely once among the cases that changed. A body five cases
 * share is not evidence about any of them, and narrowing the question to
 * the changed set would let the one that moved borrow the uniqueness of
 * the four that did not. Measured 2026-10-21: `test/unit/suite-denominator.test.ts`
 * has five cases sharing one body, which is exactly that input.
 *
 * The titles are checked the same way. Measured on this repository,
 * **17 of 483 test files declare the same case title twice**, so duplicate
 * titles are ordinary here rather than hypothetical, and `deletedCases` has
 * folded them into a `Set` since #659 — deleting one of two identically
 * titled cases has always been invisible and still is.
 *
 * A `null` body — a call the scan could not close — pairs with nothing, and
 * so does one below `MIN_IDENTIFYING_BODY`. "I could not read this" and
 * "this body is about nothing" are both readings that identify no case, and
 * a reading that identifies no case must not match another one that
 * identifies no case.
 */
/**
 * What a case is compared BY, or `null` when it is comparable to nothing.
 *
 * ONE binding, so there is one thing to mutate and one place where a
 * component of a case's identity can be forgotten. Asking "is the body long
 * enough" in the index and again in the loop below would be two deciders
 * that agree, and a mutation of either would leave the other refusing
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * The modifiers are part of the key and not side conditions for the same
 * reason: a side condition is a second place a rule can be dropped. `test`
 * and `test.skip` carrying one body produce two different keys and
 * therefore never pair, and they do so by the same arithmetic that already
 * refuses two unrelated bodies. The enclosing `describe` chain is in the
 * key for the same reason it exists — a case wrapped in `describe.skip`
 * does not run, and a rename report says it does.
 *
 * ## What the key does NOT claim, named rather than omitted
 *
 * A `.only` ANYWHERE in the after source suppresses every other case in
 * the file, so strictly a pair in such a file is a pair of cases that no
 * longer run. That is deliberately not refused here. It is a property of
 * the file and not of the pair: a committed `.only` means almost nothing
 * in the file ran, which the previous build commit's LEDGER reports
 * directly and far more loudly than a rename line could. Folding it in
 * would make `renamePairs` answer a question the ledger already answers,
 * which is a second decider.
 */
function pairingKey(d: CaseDeclaration): string | null {
  if (d.body === null) return null;
  const body = normalisedBody(d.body);
  if (body.length < MIN_IDENTIFYING_BODY) return null;
  return `${d.enclosing.join(">")}\u0000${d.modifier}\u0000${body}`;
}

export function renamePairs(
  before: readonly CaseDeclaration[],
  after: readonly CaseDeclaration[],
): RenamePair[] {
  const beforeTitles = new Set(before.map(d => d.name));
  const afterTitles = new Set(after.map(d => d.name));
  const disappeared = before.filter(d => !afterTitles.has(d.name));
  const appeared = after.filter(d => !beforeTitles.has(d.name));

  // Indexed over EVERY case at the commit, not over the changed ones. The
  // question "does this body identify one case" is about the file, and a
  // body shared with a case that did not move is still shared.
  const index = (all: readonly CaseDeclaration[]): Map<string, CaseDeclaration[]> => {
    const by = new Map<string, CaseDeclaration[]>();
    for (const d of all) {
      const key = pairingKey(d);
      if (key === null) continue;
      const at = by.get(key);
      if (at) at.push(d);
      else by.set(key, [d]);
    }
    return by;
  };
  const wasThere = index(before);
  const isThere = index(after);

  const once = (list: readonly CaseDeclaration[], name: string) =>
    list.filter(d => d.name === name).length === 1;

  const out: RenamePair[] = [];
  for (const d of disappeared) {
    const key = pairingKey(d);
    if (key === null) continue;
    const from = wasThere.get(key);
    const to = isThere.get(key);
    if (!from || from.length !== 1 || !to || to.length !== 1) continue;
    // The survivor carrying this body has to be a case that ARRIVED. A body
    // unchanged under an unchanged title is not a rename, and would
    // otherwise pair with itself.
    if (!appeared.includes(to[0])) continue;
    if (!once(disappeared, d.name) || !once(appeared, to[0].name)) continue;
    out.push({ from: d.name, to: to[0].name });
  }
  return out;
}
