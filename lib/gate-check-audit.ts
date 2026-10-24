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

import {
  parseTsModule,
  walkNodes,
  calleeRoot,
  rootProperty,
  type AstNode,
} from "./ts-ast";

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
 *
 * ## Why this is an AST and not a token scan (#1555)
 *
 * The question "does a path out of this `console.warn` leave the check without
 * asserting" is a **reachability analysis**. Until #1555 it was a forward token
 * scan over the check body that tracked brace depth, paired `else` to `if` by
 * remembering head positions per depth, and carried a running minimum depth
 * between tokens to notice a block closing. That is a parser, written badly,
 * and it was wrong five times across four revisions of #1539 — three of them
 * found one at a time by an AI reviewer handing back one side of the shape per
 * round, and one of those three a regression a previous round's own fix had
 * introduced.
 *
 * #1555 enumerated every way a path out of a warn can terminate — twelve
 * shapes — and measured the merged scan against all of them. **Three were
 * wrong**, not the two the issue predicted: `try { warn; return } finally
 * { expect }`, a warn inside a callback with an `expect` after it, and a
 * `throw` after the warn. Each is a direct question about the tree:
 * `ThrowStatement`, `TryStatement.finalizer`, a closure as a node boundary,
 * `IfStatement.alternate`, `SwitchCase`. The scan had to approximate all of
 * them from brace depth, and shape 7 (warn OUTSIDE a closure, right) beside
 * shape 12 (warn INSIDE one, wrong) is what that looks like: brace depth
 * getting the right answer for the wrong reason.
 *
 * The parser is `acorn`, through `lib/ts-ast.ts`, which is this repository's
 * existing binding for "a detector that must not be fooled by its own
 * fixtures" (#968) and the one five other `lib/` modules already use. #1555
 * recommended TypeScript's own parser on the grounds that it is a declared
 * dependency; it is declared as a **devDependency**, and `lib/` is published
 * (`files[]` in package.json), so a published module importing it would be
 * broken in every consumer's install. `acorn` is a runtime dependency.
 *
 * The consequence of that choice, which the code below has to carry:
 * `parseTsModule` transpiles the types off before parsing, and
 * `Bun.Transpiler` drops comments and blank lines — so **node positions index
 * the transpiled text and cannot be converted to a line in the original**.
 * `warnLine` is therefore resolved by ordinal against the original body, and
 * the counts are required to agree rather than assumed to (`warnOffsets`).
 */

/** The decision for one path out of a warn, and what it is allowed to be. */
interface PathFlow {
  /** An `expect` MAY execute along this path. Disqualifies the candidate. */
  expect: boolean;
  /** Control may reach the end of the construct normally. */
  fall: boolean;
  /** Control may execute a `return` — a normal exit from the function. */
  ret: boolean;
  /** Control may `break` out of the enclosing loop or switch. */
  brk: boolean;
  /** Control may `continue` the enclosing loop. */
  cont: boolean;
}

const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

function isNodeLike(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AstNode).type === "string" &&
    typeof (value as AstNode).start === "number"
  );
}

/**
 * `expect(...)` in any spelling, including `expect<T>(...)` (the type argument
 * is gone by the time acorn sees it) and `expect(x).toBe(y)`.
 *
 * `calleeRoot` is what makes this one question rather than a list of
 * spellings: it follows member and call chains to the identifier at the root,
 * so `s.expect(...)` resolves to `s` and is correctly NOT an assertion — the
 * boundary the old regex had to hand-check with a character class.
 */
function isExpectCall(node: AstNode): boolean {
  return node.type === "CallExpression" && calleeRoot(node.callee) === "expect";
}

/** `console.warn(...)`. */
function isWarnCall(node: AstNode): boolean {
  return (
    node.type === "CallExpression" &&
    calleeRoot(node.callee) === "console" &&
    rootProperty(node.callee) === "warn"
  );
}

/**
 * Does an `expect` appear anywhere under this node, INCLUDING inside nested
 * functions?
 *
 * Including them is deliberate and is the allowed direction. A callback passed
 * to `forEach` runs synchronously and its assertion does execute; a callback
 * stored and never called does not, and counting it costs a check nobody
 * names. Per the rule above, that is the direction to be wrong in.
 */
function hasExpectIn(node: unknown): boolean {
  if (!isNodeLike(node)) return false;
  for (const n of walkNodes(node)) if (isExpectCall(n)) return true;
  return false;
}

/** Execute `statements` from `from` to the end of the list. */
function seqFlow(statements: AstNode[], from: number): PathFlow {
  const flow: PathFlow = { expect: false, fall: true, ret: false, brk: false, cont: false };
  for (let i = from; i < statements.length; i++) {
    if (!flow.fall) break;
    const s = stmtFlow(statements[i]!);
    flow.expect ||= s.expect;
    flow.ret ||= s.ret;
    flow.brk ||= s.brk;
    flow.cont ||= s.cont;
    flow.fall = s.fall;
  }
  return flow;
}

/** Enter one statement. */
function stmtFlow(node: AstNode): PathFlow {
  const base = (over: Partial<PathFlow>): PathFlow => ({
    expect: false,
    fall: true,
    ret: false,
    brk: false,
    cont: false,
    ...over,
  });
  switch (node.type) {
    case "ReturnStatement":
      return base({ expect: hasExpectIn(node.argument), fall: false, ret: true });
    // A `throw` is not an exit this detector cares about: the check FAILS on
    // that path, so it is not a swallowed refusal. `ret` stays false, which is
    // the whole of shape 3.
    case "ThrowStatement":
      return base({ expect: hasExpectIn(node.argument), fall: false });
    case "BreakStatement":
      return base({ fall: false, brk: true });
    case "ContinueStatement":
      return base({ fall: false, cont: true });
    case "BlockStatement":
      return seqFlow((node.body ?? []) as AstNode[], 0);
    case "IfStatement": {
      const c = stmtFlow(node.consequent as AstNode);
      const a = isNodeLike(node.alternate) ? stmtFlow(node.alternate) : base({});
      return {
        expect: hasExpectIn(node.test) || c.expect || a.expect,
        fall: c.fall || a.fall,
        ret: c.ret || a.ret,
        brk: c.brk || a.brk,
        cont: c.cont || a.cont,
      };
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement": {
      const b = stmtFlow(node.body as AstNode);
      // `break` and `continue` are absorbed by the loop rather than leaving
      // the check — shapes 4 and 5. The loop may also run zero times, so it
      // always falls through.
      return base({
        expect:
          b.expect ||
          hasExpectIn(node.test) ||
          hasExpectIn(node.init) ||
          hasExpectIn(node.update) ||
          hasExpectIn(node.right),
        ret: b.ret,
      });
    }
    case "SwitchStatement": {
      const flow = base({ expect: hasExpectIn(node.discriminant) });
      for (const c of (node.cases ?? []) as AstNode[]) {
        const cf = seqFlow((c.consequent ?? []) as AstNode[], 0);
        flow.expect ||= cf.expect;
        flow.ret ||= cf.ret;
        flow.cont ||= cf.cont;
      }
      return flow;
    }
    case "TryStatement": {
      const t = stmtFlow(node.block as AstNode);
      const handler = node.handler as AstNode | undefined;
      const h = isNodeLike(handler?.body) ? stmtFlow(handler.body as AstNode) : null;
      const fin = isNodeLike(node.finalizer) ? stmtFlow(node.finalizer) : null;
      const flow: PathFlow = {
        expect: t.expect || !!h?.expect || !!fin?.expect,
        fall: t.fall || !!h?.fall,
        ret: t.ret || !!h?.ret,
        brk: t.brk || !!h?.brk,
        cont: t.cont || !!h?.cont,
      };
      // A finalizer that does not fall through replaces every completion of
      // the block it guards.
      if (fin && !fin.fall) {
        flow.fall = false;
        flow.ret = fin.ret;
        flow.brk = fin.brk;
        flow.cont = fin.cont;
      }
      return flow;
    }
    case "LabeledStatement": {
      const b = stmtFlow(node.body as AstNode);
      return { ...b, fall: b.fall || b.brk, brk: false };
    }
    // A function DECLARATION is not executed where it is written.
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "EmptyStatement":
      return base({});
    default:
      return base({ expect: hasExpectIn(node) });
  }
}

/** `acc`, then `rest` — `rest` only runs if `acc` can fall into it. */
function chain(acc: PathFlow, rest: PathFlow): PathFlow {
  if (!acc.fall) return acc;
  return {
    expect: acc.expect || rest.expect,
    fall: rest.fall,
    ret: acc.ret || rest.ret,
    brk: acc.brk || rest.brk,
    cont: acc.cont || rest.cont,
  };
}

/**
 * Walk OUT from the warn to the check's own boundary, accumulating what the
 * path meets on the way.
 *
 * Returns whether an `expect` is reachable, and whether a NORMAL exit from the
 * check is reachable. A `throw` is neither — it reaches no `expect` and no
 * normal exit, so it is not a finding.
 */
function forwardFromWarn(
  warn: AstNode,
  callback: AstNode,
  parentOf: Map<AstNode, AstNode>,
): { expect: boolean; normalExit: boolean } {
  // An `expect` sharing the warn's own STATEMENT — `a ? console.warn(x) :
  // expect(y)`, or an `expect` further along a comma or logical chain. The
  // walk below starts at statement granularity and would step straight past
  // it, so it is taken first. Counting an assertion that a branch could skip
  // is the direction this is allowed to be wrong in.
  let stmt: AstNode = warn;
  for (;;) {
    const up = parentOf.get(stmt);
    if (!up || /Statement$|Declaration$/.test(stmt.type)) break;
    stmt = up;
  }

  let acc: PathFlow = {
    expect: hasExpectIn(stmt),
    fall: true,
    ret: false,
    brk: false,
    cont: false,
  };
  let child: AstNode = warn;
  let parent = parentOf.get(child);
  while (parent) {
    if (parent === callback) break;
    switch (parent.type) {
      case "BlockStatement":
      case "Program": {
        const body = (parent.body ?? []) as AstNode[];
        const idx = body.indexOf(child);
        if (idx >= 0) acc = chain(acc, seqFlow(body, idx + 1));
        break;
      }
      case "SwitchCase": {
        const body = (parent.consequent ?? []) as AstNode[];
        const idx = body.indexOf(child);
        if (idx >= 0) acc = chain(acc, seqFlow(body, idx + 1));
        break;
      }
      case "SwitchStatement": {
        // Falling out of a case runs the cases below it; `break` leaves the
        // switch. Either way the path continues after the switch.
        const cases = (parent.cases ?? []) as AstNode[];
        const idx = cases.indexOf(child);
        if (idx >= 0 && acc.fall) {
          for (let i = idx + 1; i < cases.length; i++) {
            const cf = seqFlow((cases[i]!.consequent ?? []) as AstNode[], 0);
            acc.expect ||= cf.expect;
            acc.ret ||= cf.ret;
          }
        }
        acc.fall = acc.fall || acc.brk;
        acc.brk = false;
        break;
      }
      case "TryStatement": {
        // The finalizer runs on EVERY exit from the block it guards —
        // including the `return`. Shape 11.
        if (child === parent.block || child === parent.handler) {
          const finalizer = asNode(parent.finalizer);
          if (finalizer) {
            const f = stmtFlow(finalizer);
            if (acc.fall || acc.ret || acc.brk || acc.cont) acc.expect ||= f.expect;
            if (!f.fall) {
              acc.fall = false;
              acc.ret = f.ret;
              acc.brk = f.brk;
              acc.cont = f.cont;
            }
          }
        }
        break;
      }
      case "LabeledStatement":
        acc.fall = acc.fall || acc.brk;
        acc.brk = false;
        break;
      default: {
        if (LOOPS.has(parent.type) && child === parent.body) {
          // Both `continue` and falling off the end of the body re-enter it,
          // so anything the body asserts is reachable; `break` and the loop
          // finishing both continue after it. Shapes 4 and 5.
          if (acc.fall || acc.cont) {
            acc.expect ||=
              hasExpectIn(parent.body) ||
              hasExpectIn(parent.test) ||
              hasExpectIn(parent.update);
          }
          acc.fall = acc.fall || acc.cont || acc.brk;
          acc.brk = false;
          acc.cont = false;
        } else if (FUNCTIONS.has(parent.type)) {
          // A nested closure is a node boundary, not a brace depth. Its
          // `return` exits the CLOSURE and resumes the caller, so the path
          // carries on at the call site rather than leaving the check.
          // Shape 12 — and shape 7 is the same rule seen from outside.
          acc.fall = acc.fall || acc.ret;
          acc.ret = false;
          acc.brk = false;
          acc.cont = false;
        }
        break;
      }
    }
    child = parent;
    parent = parentOf.get(parent);
  }
  return { expect: acc.expect, normalExit: acc.fall || acc.ret };
}

function asNode(value: unknown): AstNode | null {
  return isNodeLike(value) ? value : null;
}

/**
 * Does an assertion run on EVERY path that reaches this warn?
 *
 * Dominance, not "an `expect` appears earlier in the text". The two differ on
 * exactly the shape PR #1539's third review round was about: in
 * `if (a) expect(p); else console.warn(x);` the assertion is earlier and can
 * never have run on the path that reaches the warn. The AST answers it by
 * construction — only a PRECEDING SIBLING in an enclosing statement list can
 * dominate, and `IfStatement.alternate` is not a sibling of its consequent.
 */
function assertionDominates(
  warn: AstNode,
  callback: AstNode,
  parentOf: Map<AstNode, AstNode>,
): boolean {
  let child: AstNode = warn;
  let parent = parentOf.get(child);
  while (parent) {
    if (parent.type === "BlockStatement" || parent.type === "Program") {
      const body = (parent.body ?? []) as AstNode[];
      const idx = body.indexOf(child);
      for (let i = 0; i < idx; i++) if (alwaysAsserts(body[i]!)) return true;
    }
    if (parent.type === "SwitchCase") {
      const body = (parent.consequent ?? []) as AstNode[];
      const idx = body.indexOf(child);
      for (let i = 0; i < idx; i++) if (alwaysAsserts(body[i]!)) return true;
    }
    if (parent === callback) break;
    child = parent;
    parent = parentOf.get(parent);
  }
  return false;
}

/** Does entering this statement guarantee an `expect` runs? */
function alwaysAsserts(node: AstNode): boolean {
  switch (node.type) {
    case "BlockStatement":
      return ((node.body ?? []) as AstNode[]).some(alwaysAsserts);
    case "IfStatement":
      return (
        isNodeLike(node.alternate) &&
        alwaysAsserts(node.consequent as AstNode) &&
        alwaysAsserts(node.alternate)
      );
    case "TryStatement": {
      if (isNodeLike(node.finalizer) && alwaysAsserts(node.finalizer)) return true;
      const handler = node.handler as AstNode | undefined;
      const blockAsserts = alwaysAsserts(node.block as AstNode);
      if (!blockAsserts) return false;
      return !handler || alwaysAsserts(handler.body as AstNode);
    }
    case "LabeledStatement":
    case "DoWhileStatement":
      return alwaysAsserts(node.body as AstNode);
    case "SwitchStatement": {
      const cases = (node.cases ?? []) as AstNode[];
      if (!cases.some(c => !isNodeLike(c.test))) return false;
      return cases.every(c => ((c.consequent ?? []) as AstNode[]).some(alwaysAsserts));
    }
    // A loop may run zero times, and a declaration is not executed here.
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return false;
    default:
      return hasExpectIn(node);
  }
}

/** Every `test(...)` callback in a parsed module, in source order. */
function testCallbacks(tree: AstNode): { name: string; callback: AstNode }[] {
  const out: { name: string; callback: AstNode; at: number }[] = [];
  for (const node of walkNodes(tree)) {
    if (node.type !== "CallExpression") continue;
    const callee = node.callee as AstNode | undefined;
    // `test(...)` exactly, matching what `gateChecks` enumerates — not
    // `test.each`, not `describe`.
    if (callee?.type !== "Identifier" || callee.name !== "test") continue;
    const args = (node.arguments ?? []) as AstNode[];
    const first = args[0];
    if (first?.type !== "Literal" || typeof first.value !== "string") continue;
    const callback = args.find(a => FUNCTIONS.has(a.type));
    if (!callback) continue;
    out.push({ name: first.value, callback, at: node.start });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map(({ name, callback }) => ({ name, callback }));
}

/**
 * The offsets of each real `console.warn(` in an original check body.
 *
 * Node positions index the TRANSPILED text (see the module note above), so a
 * warn's line in the original file cannot be read off its node. It is resolved
 * by ordinal instead — and the two counts are REQUIRED to agree rather than
 * assumed to. A `console.warn(` inside a comment or a string literal would
 * make the text count exceed the AST count, and silently reporting the wrong
 * line is the kind of quiet wrongness this whole module exists to stop.
 */
function warnOffsets(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/console\s*\.\s*warn\s*\(/g)) out.push(m.index);
  return out;
}

/**
 * Every `console.warn` whose path leaves the check with nothing asserted.
 *
 * Two conditions, and both are about the PATH rather than the body:
 *
 * - no assertion DOMINATES the warn — nothing that runs on every path to it;
 * - from the warn, no `expect` is reachable before the check is left by a
 *   normal exit (a `return`, or running off the end of the body).
 *
 * A path that can only leave by `throw` is not a finding: the check fails on
 * it, so it is not a swallowed refusal.
 *
 * Throws rather than returning `[]` when the source cannot be parsed, or when
 * the tree disagrees with `gateChecks` about what the checks are. A parser
 * that stopped parsing and a file that is clean otherwise produce the same
 * empty list, which is the first shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function unassertedWarnPaths(source: string): WarnReturnPath[] {
  const checks = gateChecks(source);
  // No early return on an empty check list. A source that failed to parse
  // yields no checks for the brace matcher either, so short-circuiting here
  // would convert every unparseable file into a clean one — the fail-open in
  // `.claude/rules/checks-must-be-able-to-fail.md`. An empty source parses,
  // agrees with the tree at zero, and returns [] through the normal path.
  const parsed = parseTsModule(source);
  if (!parsed) {
    throw new Error(
      "unassertedWarnPaths: UNMEASURED — the source did not transpile or did not parse, so " +
        "no reachability reading was taken. This is not an empty list of findings.",
    );
  }

  // `gateChecks` stays the single enumerator of what a check IS, and the tree
  // is a lookup rather than a second opinion. Two enumerators that disagreed
  // would silently drop a check from the join — so they are required to agree
  // here instead, by name and in order.
  const fromTree = testCallbacks(parsed.tree);
  const treeNames = fromTree.map(c => c.name).join("\n");
  const checkNames = checks.map(c => c.name).join("\n");
  if (treeNames !== checkNames) {
    throw new Error(
      `unassertedWarnPaths: UNMEASURED — the parsed tree sees ${fromTree.length} checks and ` +
        `gateChecks sees ${checks.length}, or they are in a different order. One of the two is ` +
        "reading less than the file.",
    );
  }

  const parentOf = new Map<AstNode, AstNode>();
  for (const node of walkNodes(parsed.tree)) {
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isNodeLike(child)) parentOf.set(child, node);
      } else if (isNodeLike(value)) {
        parentOf.set(value, node);
      }
    }
  }

  const out: WarnReturnPath[] = [];
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    if (check.name === STANDALONE_STUB_NAME) continue;
    const { callback } = fromTree[i]!;

    const warns = [...walkNodes(callback)].filter(isWarnCall).sort((a, b) => a.start - b.start);
    const offsets = warnOffsets(check.body);
    if (warns.length !== offsets.length) {
      throw new Error(
        `unassertedWarnPaths: UNMEASURED — "${check.name}" has ${warns.length} console.warn ` +
          `calls in the tree and ${offsets.length} in its source text, so a finding's line ` +
          "cannot be resolved by ordinal. A `console.warn(` in a comment or a string would do " +
          "this; reporting the wrong line silently would be worse.",
      );
    }

    for (let w = 0; w < warns.length; w++) {
      const warn = warns[w]!;
      if (assertionDominates(warn, callback, parentOf)) continue;
      const after = forwardFromWarn(warn, callback, parentOf);
      if (after.expect || !after.normalExit) continue;
      out.push({
        check: check.name,
        line: check.line,
        // The body starts partway through the `test(` line, so the warn's line
        // is the check's line plus the newlines before it inside the body.
        warnLine:
          check.line + (check.body.slice(0, offsets[w]!).match(/\n/g) || []).length,
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
