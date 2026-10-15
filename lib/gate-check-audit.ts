/**
 * Which gate checks cannot fail, and which of those meant to (#183, #176).
 *
 * #176 found three checks in `gates/workflow.test.ts` that were satisfied by
 * configuration or by nothing at all. `tsc-pass` was the clearest: two early
 * returns and an empty tail, no `expect`, no `tsc` invocation, no baseline
 * comparison. It had been counted as a passing gate check for its whole life.
 *
 * #183 is the audit of the rest of that list, and the thing worth building is
 * not a one-time report. **Nothing in the repo could tell a check that is
 * deliberately a warning from a check whose assertion was forgotten**, and
 * that is exactly the gap `tsc-pass` lived in. Three checks are warn-only
 * today; two say so in their own comments and one does not.
 *
 * So the audit is a binding instead of a paragraph: every check with no
 * assertion must be named here with a reason, and every name here must still
 * be a check with no assertion. Both directions fail. Adding an `expect` to a
 * warn-tier check means deleting its entry in the same commit, and adding a
 * check with no assertion means either writing the reason down or writing the
 * assertion.
 */

/** One `test(...)` in a gate suite, with the body a brace matcher found. */
export interface GateCheck {
  /** The first argument to `test(...)`, as written. */
  name: string;
  /** 1-indexed line of the `test(` call. */
  line: number;
  /** Everything between the callback's braces. */
  body: string;
  /** Does any `expect(` appear in the body? */
  hasAssertion: boolean;
}

/**
 * Checks that intentionally only warn, each with the reason.
 *
 * A reason is required because the entry is the documentation. "It is on the
 * list" is the same non-answer as a green check that never looked.
 */
export const WARN_TIER_CHECKS: Readonly<Record<string, string>> = Object.freeze({
  "quinn-container-port: Quinn tested the container, not the dev server":
    "#344 — turning this into a refusal changes what blocks live runs and needs its own " +
    "measurement. The fix there was that it stops being WRONG (it compared against one " +
    "consumer's literal port); making it block is a separate decision.",
  "spec-decision-compliance: AC language aligns with spec decisions":
    "#409 Decision #9 placed this in the WARN tier explicitly: it matches AC prose against " +
    "regex anti-patterns, and a regex over prose is not a basis for refusing a run.",
  "outcome-evidence-behavioral: OUTCOME AC evidence is not just a number":
    "#183 — reported, not fixed. This one is NOT a documented decision like the two above; " +
    "it is `tsc-pass`'s shape with a console.warn where the assertion should be, and the " +
    "sibling check `outcome-acs-no-skip` two tests above it does assert. Tightening it is a " +
    "behaviour change to a live gate and belongs to its own issue.",
  "ac-issue-alignment: ACs cover goal keywords":
    "#183 — reported, not fixed. Found by this audit, not by #176. ADR-009 C4 asks that ACs " +
    "cover the goal's keywords; the body computes a coverage ratio and warns under 50%. A " +
    "stopword-filtered substring match is not a basis for refusing a run, but nothing said " +
    "so until this entry, which is the whole point of the list.",
});

/**
 * The stub a `describe` block substitutes when there is no workflow state.
 *
 * Not a check and not a warn-tier check — a placeholder so bun does not report
 * an empty describe. It is separated out rather than allowlisted because the
 * property that matters is different: a stub must have an EMPTY body. A stub
 * that grew logic would be a check that runs only when nothing is being gated.
 */
export const STANDALONE_STUB_NAME = "skipped — no active workflow (standalone run)";

/**
 * `expect(` — and `expect<T>(`, which the first draft of this regex missed.
 *
 * It reported `workflow-state.json validates` as having no assertion when the
 * assertion is on the line below, written `expect<boolean>(...)` to widen a
 * narrowed type. A detector that misses a form in its own tree is the second
 * shape in `.claude/rules/checks-must-be-able-to-fail.md`, so the generic form
 * is a case in the test rather than a note here.
 */
const ASSERTION = /\bexpect\s*(?:<[^>()]*>)?\s*\(/;

/** `(`/`[`/`{` depth-aware scan that skips strings, templates and comments. */
function matchingParen(source: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      for (; i < source.length; i++) {
        if (source[i] === "\\") { i++; continue; }
        if (source[i] === quote) break;
        // A `${` inside a template can itself contain the quote character, so
        // the expression is skipped as a unit rather than scanned for one.
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
          let d = 1;
          i += 2;
          for (; i < source.length && d > 0; i++) {
            if (source[i] === "{") d++;
            else if (source[i] === "}") d--;
          }
          i--;
        }
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `test("...", ...)` in a suite source, with its body.
 *
 * Brace-matched rather than indentation-matched. An indentation heuristic was
 * the first attempt and it found 27 of 79 — it stopped at the first `});` that
 * happened to sit at the right column, which in a file of nested `describe`
 * blocks is almost immediately. A parser that silently sees a third of its
 * input is the defect this whole file is about, so `parsesEveryCheck` below is
 * asserted by the test rather than assumed here.
 */
export function gateChecks(source: string): GateCheck[] {
  const checks: GateCheck[] = [];
  const re = /(^|\n)(\s*)test\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = (m[3] ?? m[4] ?? m[5])!;
    const callAt = m.index + m[1]!.length + m[2]!.length;
    const openAt = source.indexOf("(", callAt);
    const closeAt = matchingParen(source, openAt);
    if (closeAt === -1) continue;
    const call = source.slice(openAt, closeAt);
    // The body is everything after the first `=> {` or `function () {` inside
    // the call. Taking the whole call would count an `expect` in the test's
    // own name or options object as an assertion.
    const arrow = call.indexOf("=> {");
    const body = arrow === -1 ? call : call.slice(arrow + 4);
    checks.push({
      name,
      line: source.slice(0, callAt).split("\n").length,
      body,
      hasAssertion: ASSERTION.test(body),
    });
    re.lastIndex = closeAt;
  }
  return checks;
}

/** Checks with no `expect(` anywhere in the body, in source order. */
export function checksWithoutAssertions(source: string): GateCheck[] {
  return gateChecks(source).filter(c => !c.hasAssertion && c.name !== STANDALONE_STUB_NAME);
}

/** The standalone placeholders, so their emptiness can be asserted. */
export function standaloneStubs(source: string): GateCheck[] {
  return gateChecks(source).filter(c => c.name === STANDALONE_STUB_NAME);
}

/**
 * Reads a field off `environments` that something other than a measurement
 * writes — #176's second shape.
 *
 * Returns one entry per `sf("environments")?.<env>?.<field>` read, so the
 * audit can name the writer of each. Text, deliberately: the point is to
 * enumerate the reads so a human checks each writer, not to decide which are
 * honest. A detector that tried to decide would be the narrower-than-what-it-
 * detects shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function environmentVerdictReads(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/sf\("environments"\)\?\.(\w+)\?\.(\w+)/g)) {
    out.add(`${m[1]}.${m[2]}`);
  }
  return [...out].sort();
}
