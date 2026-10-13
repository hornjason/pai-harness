/**
 * Blank every comment in a JavaScript/TypeScript source, leaving string,
 * template and regex contents alone (#273).
 *
 * ## Why this exists
 *
 * Six phase-ordering assertions in `test/spec-compliance.test.ts` located
 * their anchors with `indexOf` over the raw text of `workflows/ship.js`, and
 * five of the eight strings they searched for occur ONLY inside comments —
 * `PHASE 5: VALIDATE` is a banner, `create-pr` is a note about a step. Three
 * of the six therefore compared one comment to another. Deleting the PR step
 * out of `ship.js` while leaving its comment in place left all six green
 * against a harness with zero `pr-upsert` call sites. That is the third shape
 * `.claude/rules/checks-must-be-able-to-fail.md` names: a detector narrower
 * than what it detects, here narrowed to text that is not code at all.
 *
 * ## The one property callers depend on
 *
 * **Offsets are preserved.** Every comment character is replaced by a space —
 * newlines are kept — so the output has the same length, the same line count,
 * and the same byte offsets as the input. Two things follow, and both are
 * load-bearing:
 *
 *  - An ordering comparison over the stripped copy is directly comparable to
 *    one over the raw copy; nothing shifts.
 *  - `stripped.slice(i, i + anchor.length) === anchor` is an exact answer to
 *    "is the anchor at offset `i` code or comment?", which is how the anchor
 *    audit in `test/ship-phase-ordering-mutation.test.ts` classifies every
 *    remaining anchor in the suite rather than asserting a claim about them.
 *
 * ## What it is not
 *
 * Not a parser. It is a scanner over five contexts — code, line comment,
 * block comment, quoted string, template literal (with `${}` interpolations
 * nested to any depth) — plus the standard previous-token heuristic for
 * telling a regex literal from a division. The heuristic's known blind spot
 * is `)` followed by `/`, which is read as division; no such construct exists
 * in the files this is pointed at, and `test/strip-js-comments.test.ts`
 * asserts the outcome on the real file rather than trusting the scanner.
 */

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_ALLOWED_AFTER = new Set([
  "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n",
]);

/** Keywords after which a `/` starts a regex literal. */
const REGEX_ALLOWED_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

type Ctx = { kind: "code" | "template"; depth: number };

export interface StripOptions {
  /**
   * Also blank the CONTENTS of every string, template and regex literal,
   * keeping their delimiters and every offset (#254).
   *
   * Off by default, because the token a caller is looking for usually lives
   * inside a literal: `workflows/ship.js` is mostly prompts, and `pr-upsert` is
   * a command inside one.
   *
   * On, the result is the view a BRACE MATCHER may count over, and nothing
   * else. `${WORK_DIR}`, `{rebuild:'SKIP'}` and a JSON example in a prompt all
   * carry braces that are text, and a matcher run over the comment-stripped
   * copy closes `if (containerConfig) {` in the middle of a prompt — which is
   * how a call site trapped inside an arm measures as outside it.
   *
   * The braces of a `${ … }` interpolation go with the literal; the CODE inside
   * one is left alone, because its braces are necessarily balanced and so
   * cannot move a match. Offsets are preserved exactly as without the option,
   * which is what makes one view's index comparable to the other's range.
   */
  blankLiterals?: boolean;
}

export function stripJsComments(src: string, opts: StripOptions = {}): string {
  const blankLiterals = opts.blankLiterals === true;
  const out = src.split("");
  const n = src.length;
  const stack: Ctx[] = [{ kind: "code", depth: 0 }];

  // Last significant code character and last identifier, for regex detection.
  let prevSig = "";
  let prevWord = "";

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";

    if (top.kind === "template") {
      if (c === "\\") { if (blankLiterals) blank(i, i + 2); i += 2; continue; }
      if (c === "`") { stack.pop(); prevSig = "`"; prevWord = ""; i++; continue; }
      if (c === "$" && d === "{") {
        // The interpolation's own braces belong to the literal; the code
        // between them does not, and is left intact.
        if (blankLiterals) blank(i, i + 2);
        stack.push({ kind: "code", depth: 0 });
        prevSig = "{"; prevWord = "";
        i += 2;
        continue;
      }
      if (blankLiterals) blank(i, i + 1);
      i++;
      continue;
    }

    // ── code context ──
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; closed = true; break; }
        // An unterminated string would otherwise swallow the rest of the file
        // and silently disable the whole stripper — a fail-open.
        if (src[j] === "\n") break;
        j++;
      }
      // Contents, not delimiters. The quotes stay so the surrounding code still
      // reads as code, and an unterminated string blanks only as far as the
      // scanner actually got.
      if (blankLiterals) blank(i + 1, closed ? j - 1 : j);
      prevSig = c; prevWord = "";
      i = j;
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "template", depth: 0 });
      i++;
      continue;
    }
    if (c === "{") { top.depth++; prevSig = "{"; prevWord = ""; i++; continue; }
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        // Closes a `${ … }` interpolation; the enclosing template resumes. It
        // is the literal's brace, so it goes wherever its `${` went.
        if (blankLiterals) blank(i, i + 1);
        stack.pop();
      } else {
        top.depth--;
      }
      prevSig = "}"; prevWord = "";
      i++;
      continue;
    }
    if (c === "/") {
      const regex = prevWord
        ? REGEX_ALLOWED_AFTER_WORD.has(prevWord)
        : REGEX_ALLOWED_AFTER.has(prevSig);
      if (regex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        let endSlash = -1;
        while (j < n) {
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === "\n") break;
          if (inClass) { if (ch === "]") inClass = false; }
          else if (ch === "[") inClass = true;
          else if (ch === "/") { endSlash = j; j++; closed = true; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[a-z]/i.test(src[j])) j++;
          // A `{` in a pattern is a quantifier or an escaped brace, never a
          // block — same reason the string contents go.
          if (blankLiterals) blank(i + 1, endSlash);
          prevSig = "/"; prevWord = "";
          i = j;
          continue;
        }
        // Unterminated — it was a division after all.
      }
      prevSig = "/"; prevWord = "";
      i++;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prevSig = src[j - 1];
      i = j;
      continue;
    }
    prevSig = c;
    prevWord = "";
    i++;
  }

  return out.join("");
}

/**
 * Which offsets lie inside a comment (#360).
 *
 * Lives here rather than beside its caller because it is the inverse of what
 * `stripJsComments` already knows, and a second scanner answering the same
 * question is a second scanner to drift.
 *
 * The subtlety is that blanking writes a SPACE and leaves newlines alone, so
 * "differs from the source" is true for a comment's words and FALSE for the
 * whitespace between them. A naive maximal run therefore stops at the first
 * space: the first version of #360's census read `SC-633,` as the whole
 * enclosing comment, which made every comment in the repo look like a bare
 * id and put 192 of 220 credits in the wrong bucket.
 *
 * So: mark the differing offsets, then bridge runs of whitespace that have a
 * marked offset on both sides. Consecutive line comments merge into one
 * block, which is the right answer for `// …\n// …` and is stated here
 * because it is a choice rather than an accident.
 */
export function commentMask(src: string): boolean[] {
  const blanked = stripJsComments(src);
  const mask = Array.from(src, (ch, i) => blanked[i] !== ch);
  let i = 0;
  while (i < src.length) {
    if (!mask[i] && /\s/.test(src[i])) {
      let j = i;
      while (j < src.length && !mask[j] && /\s/.test(src[j])) j++;
      if (i > 0 && mask[i - 1] && j < src.length && mask[j]) {
        for (let k = i; k < j; k++) mask[k] = true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return mask;
}

/** The maximal masked run around `at`, and where in it `at` fell. */
export function enclosingComment(
  src: string,
  mask: boolean[],
  at: number,
): { text: string; offset: number } {
  if (!mask[at]) return { text: "", offset: -1 };
  let lo = at;
  let hi = at;
  while (lo > 0 && mask[lo - 1]) lo--;
  while (hi + 1 < src.length && mask[hi + 1]) hi++;
  return { text: src.slice(lo, hi + 1), offset: at - lo };
}
