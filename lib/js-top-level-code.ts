/**
 * Remove string, template, comment and regex-literal CONTENT from JavaScript
 * source, leaving the code that actually executes (#89).
 *
 * This exists because the #69 guard — "ship.js must not call require() at top
 * level, the sandbox has no module loading" — was stripping template literals
 * with a regex:
 *
 *     src.replace(/`(?:\\[\s\S]|[^\\`])*`/g, " `` ")
 *
 * ship.js contains backticks that are not template delimiters: inside
 * single-quoted strings, inside comments, inside other templates. A regex has
 * no way to tell which is which, so one stray backtick paired with a later
 * unrelated one and everything between them was deleted — real code included.
 * 61% of the file vanished, and `buildSafeGitAdd` and `validateFilePaths`,
 * the two helpers #69 is actually about, were invisible to the check that
 * protects them. Two functions calling require('path') and require('fs') were
 * added and the suite reported 48 pass, 0 fail.
 *
 * A single-pass tokenizer is not clever, but it is correct for the thing a
 * regex cannot do: it knows what context it is in, so a backtick inside a
 * comment is just a character.
 *
 * TEMPLATE INTERPOLATIONS ARE KEPT. `${...}` evaluates in the enclosing scope,
 * so a require() there is top-level code and must stay visible. That requires
 * tracking brace depth per template, which is the other thing the regex could
 * not express.
 */

/** Characters after which a `/` begins a regex literal rather than division. */
function regexCanFollow(prev: string): boolean {
  // Scanning back over the last significant character is enough in practice:
  // after a value (identifier, number, closing bracket) a slash is division;
  // after an operator, keyword or opening bracket it starts a regex.
  return !/[A-Za-z0-9_$)\]]/.test(prev);
}

export function stripStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  // Stack of brace depths, one entry per template literal currently open. An
  // entry is pushed on ` and popped on the matching `; while inside an
  // interpolation the depth counts { } so the template's closing backtick is
  // not confused with a backtick in nested code.
  const templates: number[] = [];
  let lastSignificant = "\n";

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // Inside a template, but NOT inside one of its interpolations.
    if (templates.length > 0 && templates[templates.length - 1] === 0) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        templates.pop();
        out += "`";
        lastSignificant = "`";
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        templates[templates.length - 1] = 1;
        out += "${";
        lastSignificant = "{";
        i += 2;
        continue;
      }
      // Template text: drop it, but keep newlines so line numbers survive.
      out += c === "\n" ? "\n" : "";
      i++;
      continue;
    }

    // Block comment.
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end === -1 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, " ");
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    // Line comment.
    if (c === "/" && next === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }

    // Quoted string.
    if (c === '"' || c === "'") {
      const quote = c;
      out += quote;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        // Unterminated strings must not swallow the rest of the file.
        if (src[i] === "\n") break;
        out += src[i] === "\n" ? "\n" : "";
        i++;
      }
      if (src[i] === quote) {
        out += quote;
        i++;
      }
      lastSignificant = quote;
      continue;
    }

    // Regex literal. Only when a `/` cannot be division here.
    if (c === "/" && regexCanFollow(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break; // not a regex after all
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j++; // flags
        // Emit a valid placeholder, not spaces. Blanking the literal leaves
        // `const SHELL_METACHARACTERS = ` with no right-hand side, which makes
        // the output unparseable — and the output has to stay parseable,
        // because "does a real parser still accept this?" is the only
        // independent check that the tokenizer did not mangle the file.
        // The shortest possible regex literal is 3 characters, so this always
        // fits.
        out += "/x/" + " ".repeat(Math.max(0, j - i + 1 - 3));
        i = j + 1;
        lastSignificant = ")"; // a regex is a value
        continue;
      }
      // Fall through: it was division.
    }

    // Template start.
    if (c === "`") {
      templates.push(0);
      out += "`";
      lastSignificant = "`";
      i++;
      continue;
    }

    // Brace tracking so an interpolation knows where it ends.
    if (templates.length > 0) {
      if (c === "{") templates[templates.length - 1]++;
      else if (c === "}") {
        templates[templates.length - 1]--;
        if (templates[templates.length - 1] === 0) {
          // Closing `}` of the interpolation: back to template text.
          out += "}";
          lastSignificant = "}";
          i++;
          continue;
        }
      }
    }

    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }

  // Unbalanced state at EOF is the signature of a mis-parse: a template that
  // was opened by something that was not a template delimiter, and therefore a
  // run of real code consumed as template text. That is precisely the failure
  // this module exists to end, so refuse rather than hand back a plausible
  // looking fragment.
  if (templates.length > 0) {
    throw new Error(
      `stripStringsAndComments: ${templates.length} template literal(s) still open at end of input — ` +
        `the tokenizer mis-parsed and the result cannot be trusted`,
    );
  }

  return out;
}

export interface SyntaxWitness {
  /** True only for `clean`. Both failure modes are failures. */
  ok: boolean;
  verdict: "clean" | "input-unparseable" | "stripping-broke-syntax";
  detail?: string;
}

/**
 * Check the stripper against a real parser.
 *
 * Removing string and comment CONTENT must not change whether the source is
 * syntactically valid. If the stripped output stops parsing, the tokenizer ate
 * something it should not have — which is the whole defect being fixed here,
 * and exactly the parser-differential risk of hand-rolling a lexer.
 *
 * `new Function` here is a PARSER, not an evaluator. Construction compiles the
 * body and stops; the resulting function is discarded without ever being
 * called, so nothing in the input runs. That distinction is the only reason
 * this is acceptable at all — if the result were invoked, feeding it a repo
 * file would be arbitrary code execution. It must stay uninvoked.
 *
 * The wrapping neutralises `export` and makes ship.js's top-level `return`
 * legal; both sides get identical treatment, so only a DIFFERENCE is reported.
 */
export function strippingPreservesSyntax(src: string): SyntaxWitness {
  const prep = (c: string) => "(async function(){" + c.replace(/^export\s+/gm, "") + "\n})";
  const parses = (c: string): string | null => {
    try {
      new Function(prep(c));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // If the input does not parse, there is no differential to draw — but that
  // is NOT a pass. Returning ok here would mean an unparseable ship.js
  // silently turns the witness into a no-op, which is the exact failure this
  // module was written to end: a check reporting green because of what it
  // could not look at. The caller has to decide, so say which case it is.
  const before = parses(src);
  if (before !== null) {
    return { ok: false, verdict: "input-unparseable", detail: before };
  }

  const after = parses(stripStringsAndComments(src));
  return after === null
    ? { ok: true, verdict: "clean" }
    : { ok: false, verdict: "stripping-broke-syntax", detail: after };
}
