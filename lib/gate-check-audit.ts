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
  "ac-issue-alignment: ACs cover goal keywords":
    "#423 Decision — measured, then kept as a warning. ADR-009 C4 asks that ACs cover the " +
    "goal's keywords and the body warns under 50% coverage. Measured over the 153 " +
    "workflow-state.json files under ~/.rungate carrying a goal: 71% fall under that " +
    "threshold, median coverage 38%. Restricted to states whose ACs carry real statements " +
    "the figure is 66% of 131, median 41%; for substantial ones, 73% of 101. The number does " +
    "not move, and a check that would refuse two runs in three is an outage rather than a " +
    "gate. Same basis #409 Decision #9 rejected for spec-decision-compliance: a match over " +
    "prose is not grounds for refusing a run. The reading is lib/ac-quality.ts's " +
    "goalKeywordCoverage so the threshold is drivable from both sides by a test.",
  "before-state-captured: STANDARD+ must have beforeState in workflow-state":
    "#1411 wrote the check and #1384 found it could not fail on the condition it is named " +
    "for. Measured before deciding, over the 155 workflow-state.json files under ~/.rungate " +
    "on 2026-10-24: 30 are STANDARD or THOROUGH, and 30 of those 30 — 100% — have no " +
    "beforeState at all. Not one run in the corpus has ever carried one. The reason is the " +
    "producer, not the runs: nothing in the shipped tree WRITES beforeState. gates/schema.ts " +
    "declares its shape, gates/gate-executor.ts reads it with a `|| null` fallback and " +
    "workflows/prove.js reads it if present; the only thing that describes writing one is " +
    "reference/prompts/goal-skill.md, and this project has been in direct-ship mode since " +
    "2026-10-19, so no goal skill runs. Making this refuse would fail every STANDARD+ run " +
    "immediately — the #423 basis exactly, where 71% was already judged an outage rather " +
    "than a gate. The missing producer is the fixable half and is filed separately; this " +
    "entry is the honest reading until something writes the field.",
  "brief-ac-alignment: brief covers all ACs":
    "#1384 named this through the widened path-level predicate, and the warn-return is a " +
    "deliberate scope-out rather than a swallowed refusal. The condition the check is named " +
    "for DOES refuse: lib/brief-ac-alignment.ts returns BRIEF_ABSENT with a refusal when " +
    "Marcus was spawned and no brief exists, and IDS_MISSING when the brief omits an AC, " +
    "and gates/workflow.test.ts asserts `reading.refusal` is null. The warned path is the " +
    "fourth reading, NOT_APPLICABLE, which fires only when Marcus was never spawned — so " +
    "nothing was expected to write a brief. That reading exists because the inline version " +
    "returned bare in two places and made 'decided nothing was wrong' and 'declined to " +
    "look' the same observation; per .claude/rules/config-access.md that is UNMEASURED, not " +
    "a pass, and it is reported with the resolved path rather than silently. Turning a " +
    "scope-out into a refusal would fail every run that does not spawn Marcus.",
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

/** One `console.warn` that leads out of a check with nothing asserted (#1384). */
export interface WarnReturnPath {
  /** The check's name, as written. */
  check: string;
  /** 1-indexed line of the `test(` call. */
  line: number;
  /** 1-indexed line of the `console.warn` that leads the path. */
  warnLine: number;
}

/**
 * The view this detector takes, stated rather than left to be inferred.
 *
 * It is anchored on `console.warn`, and that is a deliberate narrowing. The
 * general property — "a path through the check executes no assertion" — holds
 * for `if (tier === "LIGHT") return;`, which opens most checks in the suite
 * and is legitimate scoping rather than a swallowed refusal. A predicate that
 * named those would report the whole file and be switched off within a day.
 *
 * A `console.warn` is the author writing down that something is wrong. A warn
 * followed by a path that leaves the check without asserting is that author
 * declining to refuse — which is the thing `WARN_TIER_CHECKS` exists to make
 * someone decide about, in the one place the body-level predicate cannot see.
 *
 * Per `.claude/rules/checks-must-be-able-to-fail.md`, the direction this is
 * allowed to be wrong in is toward NOT naming: an intervening `expect` at any
 * depth disqualifies a candidate, even one a branch could skip. A missed check
 * costs an entry nobody wrote; a false one costs the list its credibility.
 */
const WARN_CALL = /^console\s*\.\s*warn\s*\(/;
const EXPECT_CALL = /^expect\s*(?:<[^>()]*>)?\s*\(/;
const RETURN_KEYWORD = /^return\b/;
const IF_KEYWORD = /^if\b/;
/**
 * The keywords that open a branch excluding the one before it.
 *
 * Brace depth alone only notices exclusivity when the branches are braced and
 * the depth dips between them. `if (a) expect(p); else console.warn(x);` puts
 * both at the same depth with nothing closing in between, and so does a
 * `switch`, so the assertion was credited to a path that can never run it.
 * PR #1539's review caught that.
 */
const BRANCH_SPLIT = /^(?:else|case|default)\b/;

type PathToken = {
  kind: "expect" | "warn" | "return";
  at: number;
  depth: number;
  /**
   * The shallowest depth reached between the previous token and this one.
   *
   * Without it a forward scan can only compare each token's own depth against
   * the warn's, which cannot see a block closing and re-opening in between —
   * so a `return` inside a LATER, unrelated branch reads as the warn's own
   * path leaving the check. PR #1539's review caught exactly that.
   */
  minBefore: number;
};

/**
 * Bracket-depth-aware token scan over a check body, skipping strings and
 * comments the way `matchingParen` does.
 *
 * `assertDepth` is the shallowest depth at which an `expect` has been seen
 * whose enclosing block has not since closed — i.e. an assertion that runs on
 * every path reaching the current position. It resets when depth falls below
 * it, because that is the block closing.
 */
function pathTokens(body: string): { tokens: PathToken[]; assertDepthAt: Map<number, number | null> } {
  const tokens: PathToken[] = [];
  const assertDepthAt = new Map<number, number | null>();
  let depth = 0;
  let assertDepth: number | null = null;
  /** Where the assertion that set `assertDepth` sits, so an `else` can tell
   *  whether it lives in the branch being superseded. */
  let assertAt = -1;
  /** The most recent `if`/`switch` head seen at each depth. */
  const branchHeadAt = new Map<number, number>();
  let minSinceToken = 0;
  const push = (kind: PathToken["kind"], at: number) => {
    tokens.push({ kind, at, depth, minBefore: Math.min(minSinceToken, depth) });
    minSinceToken = depth;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const next = body[i + 1];
    if (c === "/" && next === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close === -1 ? body.length : close + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      for (; i < body.length; i++) {
        if (body[i] === "\\") { i++; continue; }
        if (body[i] === quote) break;
        if (quote === "`" && body[i] === "$" && body[i + 1] === "{") {
          let d = 1;
          i += 2;
          for (; i < body.length && d > 0; i++) {
            if (body[i] === "{") d++;
            else if (body[i] === "}") d--;
          }
          i--;
        }
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth < minSinceToken) minSinceToken = depth;
      if (assertDepth !== null && depth < assertDepth) { assertDepth = null; assertAt = -1; }
      continue;
    }
    // Only start a keyword match at an identifier boundary, so `s.expect(`
    // and `myreturn` are not read as the bare forms.
    if (!/[A-Za-z_$]/.test(c)) continue;
    if (i > 0 && /[\w$.]/.test(body[i - 1]!)) continue;
    const rest = body.slice(i, i + 200);
    if (IF_KEYWORD.test(rest) || /^switch\b/.test(rest)) {
      branchHeadAt.set(depth, i);
      continue;
    }
    if (BRANCH_SPLIT.test(rest)) {
      // This opens a branch excluding the one before it. An assertion is
      // superseded only if it lives INSIDE that preceding branch — i.e. after
      // the `if`/`switch` head this pairs with. An `expect` written before the
      // head runs on every path, including this one, so it still counts.
      // An `else` sits at its `if`'s own depth; a `case` sits one level INSIDE
      // its `switch`'s braces. Take whichever head is nearer — that is the
      // construct this branch belongs to.
      const head = Math.max(branchHeadAt.get(depth) ?? -1, branchHeadAt.get(depth - 1) ?? -1);
      if (assertDepth !== null && head >= 0 && assertAt > head) {
        assertDepth = null;
        assertAt = -1;
      }
      continue;
    }
    if (EXPECT_CALL.test(rest)) {
      push("expect", i);
      if (assertDepth === null || depth < assertDepth) assertAt = i;
      assertDepth = assertDepth === null ? depth : Math.min(assertDepth, depth);
    } else if (WARN_CALL.test(rest)) {
      push("warn", i);
      assertDepthAt.set(i, assertDepth);
    } else if (RETURN_KEYWORD.test(rest)) {
      push("return", i);
    }
  }
  return { tokens, assertDepthAt };
}

/**
 * Every `console.warn` whose path leaves the check with nothing asserted.
 *
 * Two conditions, and both are about the PATH rather than the body:
 *
 * - nothing has asserted on the way to the warn — no `expect` whose enclosing
 *   block still contains it;
 * - nothing asserts after it either — the path reaches a `return` at or above
 *   the warn's own depth, or runs out of check, without meeting an `expect`.
 *
 * Both halves of the second condition are implemented, and the second half is
 * the `else { console.warn(...) }` shape that gets past the body-level
 * predicate as well: the sibling branch's `expect` makes the body assert.
 *
 * Falling out of an `if` into an assertion below is NOT a finding: once the
 * warn's own enclosing block closes, the path has merged back into the main
 * flow and reaches whatever that flow asserts. A `return` belonging to a
 * later, unrelated branch is that flow's, not this warn's.
 */
export function unassertedWarnPaths(source: string): WarnReturnPath[] {
  const out: WarnReturnPath[] = [];
  for (const check of gateChecks(source)) {
    if (check.name === STANDALONE_STUB_NAME) continue;
    const { tokens, assertDepthAt } = pathTokens(check.body);
    for (let t = 0; t < tokens.length; t++) {
      const warn = tokens[t]!;
      if (warn.kind !== "warn") continue;
      if (assertDepthAt.get(warn.at) !== null) continue;
      // The warn leaves the check only if it reaches a `return` while still
      // inside its OWN enclosing block. Once the running minimum drops below
      // the warn's depth that block has closed, the path has merged back into
      // the main flow, and every `return` and `expect` after that belongs to
      // the flow rather than to this warn.
      // Running out of tokens IS the path leaving: nothing asserts after the
      // warn, so it reaches the end of the check unasserted. That is the
      // `else { console.warn(...) }` shape, which gets past both halves of
      // the audit — the sibling branch's `expect` makes the body assert, and
      // there is no `return` for this scan to stop on.
      let leaves = true;
      let runningMin = warn.depth;
      for (let u = t + 1; u < tokens.length; u++) {
        const after = tokens[u]!;
        runningMin = Math.min(runningMin, after.minBefore);
        if (runningMin < warn.depth) { leaves = false; break; }
        if (after.kind === "expect") { leaves = false; break; }
        if (after.kind === "return" && after.depth <= warn.depth) break;
      }
      if (!leaves) continue;
      out.push({
        check: check.name,
        line: check.line,
        // The body starts partway through the `test(` line, so the warn's line
        // is the check's line plus the newlines before it inside the body.
        warnLine: check.line + (check.body.slice(0, warn.at).match(/\n/g) || []).length,
      });
    }
  }
  return out;
}

/**
 * Every check that cannot fail on the condition it is named for — the union of
 * the body-level and path-level readings, in source order.
 *
 * This is the one binding the audit reads. `checksWithoutAssertions` stays
 * exported because it is the narrower of the two and the tests use it as the
 * recorded baseline: it is what the audit could see before #1384.
 */
export function checksThatCannotFail(source: string): GateCheck[] {
  const warned = new Set(unassertedWarnPaths(source).map(p => p.check));
  return gateChecks(source).filter(
    c => c.name !== STANDALONE_STUB_NAME && (!c.hasAssertion || warned.has(c.name)),
  );
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
