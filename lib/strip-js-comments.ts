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
 *
 * ## `literals: "blank"` — the same scanner, one brace question further (#254)
 *
 * Asking "is this call site inside `if (containerConfig) { … } else { … }`?"
 * means matching that conditional's braces, and a brace counter run over the
 * default output counts the braces inside `${…}`-free agent prompts and
 * `bun -e "… s.environments.prod = {rebuild:'SKIP'} …"` strings too. Those are
 * balanced today and a one-character prompt edit is all it takes for them not
 * to be — a detector whose view of the input can silently shrink, which is the
 * second shape `.claude/rules/checks-must-be-able-to-fail.md` names.
 *
 * So the option blanks literal CONTENTS as well, through this one scanner
 * rather than a second copy of it. Offsets are still preserved, so a caller
 * locates a token in the default output and matches braces in the blanked one,
 * and the two answers are about the same bytes. `pr-upsert` lives inside a
 * template literal, so the default output is the only one that can find it —
 * the pair is the point, not either half.
 */

export interface StripJsCommentsOptions {
  /**
   * `"keep"` (default) leaves string, template and regex contents alone.
   * `"blank"` replaces them with spaces too, leaving only code punctuation.
   */
  literals?: "keep" | "blank";
}

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

export function stripJsComments(src: string, options: StripJsCommentsOptions = {}): string {
  const blankLiterals = options.literals === "blank";
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
      let closedAt = -1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { closedAt = j; j++; break; }
        // An unterminated string would otherwise swallow the rest of the file
        // and silently disable the whole stripper — a fail-open.
        if (src[j] === "\n") break;
        j++;
      }
      if (blankLiterals) blank(i + 1, closedAt >= 0 ? closedAt : j);
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
        // Closes a `${ … }` interpolation; the enclosing template resumes.
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
        while (j < n) {
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === "\n") break;
          if (inClass) { if (ch === "]") inClass = false; }
          else if (ch === "[") inClass = true;
          else if (ch === "/") { j++; closed = true; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[a-z]/i.test(src[j])) j++;
          // The delimiters go too: `/a{2}/` carries braces that belong to the
          // pattern, and a brace counter has no business seeing them.
          if (blankLiterals) blank(i, j);
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
