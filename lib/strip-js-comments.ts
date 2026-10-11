/**
 * A copy of a JavaScript/TypeScript source with every COMMENT blanked and
 * every string, template literal and regex left exactly as written (#273).
 *
 * Why this exists: an assertion that locates a token with `indexOf` over the
 * raw text of a source file cannot tell whether it found the code or a comment
 * ABOUT the code. test/spec-compliance.test.ts's six phase-ordering checks
 * looked for `"PHASE 6: COMMIT"` and `"create-pr"`, both of which occur in
 * workflows/ship.js only inside comments — so deleting the PR step while
 * leaving its comment in place left all six green against a harness with zero
 * `pr-upsert` call sites. Searching this copy instead makes "found" mean
 * "found in code".
 *
 * Two properties the callers rely on, both asserted in
 * test/strip-js-comments.test.ts rather than left as conventions:
 *
 *  - **Offsets are preserved.** A comment is replaced by the same number of
 *    spaces, and its newlines are kept, so an index into the stripped copy is
 *    the same index into the original and a line number is still a line
 *    number. It is also the cheapest check that the scanner did not swallow a
 *    region it failed to parse: the lengths would stop matching.
 *  - **Literals are untouched.** This is a character scanner, not a regex,
 *    because the regex version of this idea is the worked example in
 *    .claude/rules/checks-must-be-able-to-fail.md — one that paired a backtick
 *    in a comment with an unrelated one and deleted 61% of the file while the
 *    suite reported 48 pass. ship.js's PR step is a shell command inside a
 *    template literal, so a stripper that peers inside literals would delete
 *    the very anchor the ordering checks were fixed to use.
 */

/** Characters after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set("([{,;:=!&|?+-*%~^<>".split(""));

/** Keywords after which a `/` begins a regex literal. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

const WORD = /[A-Za-z0-9_$]/;

/** Same length, same newlines, no content — what a removed comment becomes. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

export function stripJsComments(src: string): string {
  const out: string[] = [];
  let i = 0;

  /** Last non-whitespace character emitted in CODE context. */
  let prevSig = "";
  /** The identifier being accumulated, and the one before the current gap. */
  let curWord = "";
  let prevWord = "";

  function note(c: string): void {
    if (WORD.test(c)) {
      curWord += c;
    } else {
      if (curWord) prevWord = curWord;
      curWord = "";
    }
    if (!/\s/.test(c)) prevSig = c;
  }

  function regexAllowed(): boolean {
    if (!prevSig) return true;
    if (WORD.test(prevSig)) {
      const word = curWord || prevWord;
      return REGEX_KEYWORDS.has(word);
    }
    return REGEX_PRECEDERS.has(prevSig);
  }

  /** Copy a quoted string verbatim. Bails at an unescaped newline, which an
   *  unterminated literal in a MUTANT copy would otherwise turn into a
   *  file-length string that eats every later comment. */
  function quoted(quote: string): void {
    out.push(src[i]!);
    i++;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      out.push(c);
      i++;
      if (c === quote || c === "\n") break;
    }
    prevSig = quote;
    if (curWord) prevWord = curWord;
    curWord = "";
  }

  /** Copy a template literal verbatim, recursing into `${…}` as code. */
  function template(): void {
    out.push("`");
    i++;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === "`") {
        out.push(c);
        i++;
        break;
      }
      if (c === "$" && src[i + 1] === "{") {
        out.push("${");
        i += 2;
        code(true);
        if (src[i] === "}") {
          out.push("}");
          i++;
        }
        continue;
      }
      out.push(c);
      i++;
    }
    prevSig = "`";
    if (curWord) prevWord = curWord;
    curWord = "";
  }

  /** Copy a regex literal verbatim, character class and all. */
  function regex(): void {
    out.push("/");
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === "\n") break; // unterminated — do not run away
      out.push(c);
      i++;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
    }
    // Flags.
    while (i < src.length && /[a-z]/.test(src[i]!)) {
      out.push(src[i]!);
      i++;
    }
    prevSig = "/";
    if (curWord) prevWord = curWord;
    curWord = "";
  }

  /**
   * Scan code. `insideSubstitution` stops at the `}` that closes a template
   * substitution — the caller consumes it — while nested braces are counted so
   * an object literal inside `${…}` does not end it early.
   */
  function code(insideSubstitution: boolean): void {
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      const d = src[i + 1];

      if (insideSubstitution && c === "}" && depth === 0) return;

      if (c === "/" && d === "/") {
        let j = i;
        while (j < src.length && src[j] !== "\n") j++;
        out.push(blank(src.slice(i, j)));
        i = j;
        continue;
      }
      if (c === "/" && d === "*") {
        const close = src.indexOf("*/", i + 2);
        const j = close < 0 ? src.length : close + 2;
        out.push(blank(src.slice(i, j)));
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        quoted(c);
        continue;
      }
      if (c === "`") {
        template();
        continue;
      }
      if (c === "/" && regexAllowed()) {
        regex();
        continue;
      }

      if (c === "{") depth++;
      else if (c === "}") depth--;
      out.push(c);
      note(c);
      i++;
    }
  }

  code(false);
  return out.join("");
}
