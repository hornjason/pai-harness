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
   * truncated or unparseable file. A `null` body pairs with nothing, so an
   * unreadable case is reported as a deletion rather than quietly matched.
   */
  body: string | null;
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
  /(?:^|[^.\w$])(?:test|it)(?:\.(?:skip|only|todo|failing|skipIf|todoIf|runIf))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

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
  for (const m of source.matchAll(CASE_DECLARATION)) {
    // A template literal with an interpolation has no single name to record,
    // and reporting its text as a name would make it look deleted the moment
    // the interpolation changed.
    if (m[1] === "`" && m[2].includes("${")) continue;
    // The FIRST paren in the match is the call's own: the title literal is
    // an argument, so nothing with a paren in it can precede this one.
    const open = m.index! + m[0].indexOf("(");
    const titleEnd = m.index! + m[0].length;
    const close = matchingCallParen(source, open);
    out.push({
      name: unescape(m[2]),
      body: close === null || close < titleEnd ? null : source.slice(titleEnd, close),
    });
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
 * Measured over this repository, 2026-10-21 — 7,633 cases in 483 files:
 *
 * | reading | value |
 * |---|---|
 * | cases sharing a normalised body with another case in the same file | 161 (2.1%), over 26 files |
 * | longest such shared body that is boilerplate | **30** — `, () => { expect(1).toBe(1); }` |
 * | 5th percentile of all case bodies | **73** |
 * | median | 273 |
 *
 * 48 sits between the two: above every duplicated boilerplate body in the
 * tree, and below the 5th percentile, so it excludes essentially no real
 * case from being paired. Both costs, stated rather than implied:
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
      if (d.body === null) continue;
      const key = normalisedBody(d.body);
      if (key.length < MIN_IDENTIFYING_BODY) continue;
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
    if (d.body === null) continue;
    const key = normalisedBody(d.body);
    if (key.length < MIN_IDENTIFYING_BODY) continue;
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
