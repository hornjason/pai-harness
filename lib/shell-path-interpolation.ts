/**
 * shell-path-interpolation.ts — the decision behind the quoting half of the
 * `cd` rewrite (#1086)
 *
 * One question: does this source line hand a shell a DIRECTORY it built by
 * interpolation, without quoting it?
 *
 * ## What actually breaks, stated as the thing it is
 *
 * Not injection. Every value that reaches these positions in this repo's
 * workflows is a CLI argument or something derived from a repo slug and an
 * issue NUMBER — `PROJECT_ROOT`, `HARNESS_ROOT`, `WORK_DIR`, `commitDir`,
 * `marcusWorktreePath`. No issue title and no agent-reported text reaches
 * them, and #1086 traced each one to its origin before filing.
 *
 * What breaks is a consumer who checks out into `/Users/x/My Projects/thing`.
 * The prompt renders
 *
 *     git -C /Users/x/My Projects/thing status
 *
 * and git reads `-C /Users/x/My` with two stray arguments after it. The
 * agent told to run that command gets an error naming a directory nobody
 * typed. `test/workflow-prompt-top-level-cd.test.ts` runs exactly that
 * against a real shell and a real git rather than asserting it here.
 *
 * ## Why #1077 made the count go UP, and why that was still the right fix
 *
 * #1056 replaced `cd <dir> && git …` with `git -C <dir> …` throughout the
 * workflow prompts. The old form interpolated the path bare and so does the
 * new one, so a rewrite that fixed the `cd` carried the unquoted path to
 * every site it touched. The directory was always unquoted; #1077 only made
 * there be more places where it is.
 *
 * ## The reason this is a module and not a grep
 *
 * `workflows/ship.js` already defines `shellQuote` and already calls it 65
 * times. A reader who greps the file finds those 65 and concludes the file
 * handles quoting. Partial application reads as full application, which is
 * why the 64 sites measured on `91386f0f` survived every review of the file
 * they are in. A decider makes the unquoted ones enumerable instead of
 * inferable.
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward REFUSAL, same as `lib/top-level-cd.ts`. A false refusal costs one
 * `shellQuote(…)`; a false allow costs a consumer a pipeline that fails in a
 * prompt they cannot edit.
 *
 * So `grep -C ${n}` (context lines, not a directory) would be refused if it
 * ever appeared with an interpolated count, and `-C` is matched without
 * asking which program precedes it.
 *
 * ## Double quotes are REFUSED, and that is the point of the exercise
 *
 * `git -C "${PROJECT_ROOT}"` survives a space and is still refused here. It
 * is the cheapest wrong fix for #1086: it answers the failure that was filed
 * and leaves `$(…)` and backticks expanding inside the quotes. That is not
 * hypothetical in this file — `gitDerivedStaging` in `workflows/ship.js`
 * carries a comment about a security review that caught exactly this shape,
 * where a `worktreePath` of `/tmp/$(touch pwned)` executed inside a
 * double-quoted echo while the `git` command beside it was safe.
 *
 * Single quotes are the only shell quoting with no interior expansion at
 * all, which is why `shellQuote` emits them and why nothing else is accepted.
 *
 * ## KNOWN GAPS — declared, not discovered later
 *
 * - **Only flag-position and `cd`-position arguments are examined.** A path
 *   interpolated somewhere a human reads as a path but a parser cannot —
 *   `mkdir -p ${WORK_DIR}`, `> ${WORK_DIR}/issue.json`, prose naming a
 *   directory — is NOT refused. Widening to every `${…}` on a command line
 *   would refuse most of the prompt text in these files, which is English.
 * - **The quoter is recognised by NAME.** `QUOTER_NAMES` below is a fixed
 *   list, so a future `q` that is not a quoter would be accepted. Two of the
 *   three spellings exist because the block they live in is extracted by
 *   marker and executed standalone by its own test, so it cannot reference
 *   anything outside itself; new code should use `shellQuote`.
 * - **A quoted value reaching the site through a variable** is accepted via
 *   `quoterBindingsByLine`, which resolves the name against the scope chain
 *   at the use. This used to be a file-wide name scan, and a later
 *   `const d = somethingElse()` in another function laundered the name —
 *   closed in #1106, with the measurement in that function's docblock.
 *   What remains is narrower: the resolver trusts `acorn`'s parse, so a name
 *   introduced by something it models as a binding and a human does not —
 *   or the reverse — is resolved acorn's way, not the shell's.
 *
 * Issue: #1086. Related: #1056 (the `cd` rewrite), #992 (the guard it serves).
 */

import { parse } from "acorn";

import { stripJsComments } from "./strip-js-comments";

/**
 * Argument positions that name a DIRECTORY on every command this repo's
 * workflow prompts use.
 *
 * This is the same ladder `lib/top-level-cd.ts` tells callers to climb when
 * it refuses their `cd` — `git -C`, `bun --cwd`, `npm --prefix`, and a
 * `--project` flag. Refusing a `cd` into one of these and then interpolating
 * the path bare is the half-done rewrite #1086 is about, so the two lists
 * being the same list is deliberate.
 */
export const PATH_FLAGS = ["-C", "--cwd", "--prefix", "--project"] as const;

/**
 * Names this project binds to a single-quoting function.
 *
 * `shellQuote` is the one to use. The other three exist because the blocks
 * they live in are extracted by marker and executed standalone by their own
 * tests, so a reference to the module-level `shellQuote` is a test that
 * cannot run: `quote` is a PARAMETER of `suiteCaptureCommand`
 * (`test/recorder-command-executed.test.ts`), `q` is a local arrow in the
 * rook-review-scope block (`test/security-verdict-blocks.test.ts`), and
 * `shellSingleQuote` is declared inside the phase-2 decomposition block
 * (`test/evidence-command-roundtrip.test.ts`). See the gap declared above:
 * this is a name list, not a proof that the name quotes.
 */
export const QUOTER_NAMES = ["shellQuote", "shellSingleQuote", "quote", "q"] as const;

export interface BarePathInterpolation {
  /** The argument position that takes the path: a flag, or `cd`. */
  form: string;
  /** The interpolation exactly as written, e.g. `${PROJECT_ROOT}`. */
  expression: string;
  /**
   * `double` when the site is written `"${…}"`. Refused like `none`, and
   * distinguished because the remedy sentence is a different one: the author
   * reached for a fix and reached for the one that stops at spaces.
   */
  quoting: "none" | "double";
}

/** `${…}` content that is a call to a known quoter, spanning the whole thing. */
function isQuoterCall(expression: string): boolean {
  const m = expression.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (!m || !(QUOTER_NAMES as readonly string[]).includes(m[1])) return false;
  // The call must cover the entire expression. `shellQuote(a) + b` does not:
  // the concatenated tail reaches the shell unquoted.
  return matchingParen(expression, expression.indexOf("(")) === expression.length - 1;
}

/** Index of the `)` closing the `(` at `open`, or -1. Quote-aware. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Index just past the `}` closing the `${` whose `{` is at `open`, or -1.
 *
 * Brace-counting rather than a regex because the expressions nest:
 * `${shellQuote(`${HARNESS_ROOT}/scripts/x.ts`)}` has three levels and
 * `${PROJECT_ROOT || '.'}` carries a quoted brace-free string that a lazy
 * `[^}]*` happens to survive and a greedy one does not.
 */
function endOfInterpolation(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Which names are quoter-bound AT EACH LINE: `1-based line -> names`.
 *
 * `${d}` three lines below `const d = shellQuote(dir)` is not refused, which
 * is how `gitDerivedStaging` in `workflows/ship.js` is written and is written
 * that way on purpose — the quoted value is used twice and one use sits
 * inside a double-quoted `echo`, where re-quoting at the site would be wrong.
 * The exemplar predates this check; the check accommodates it rather than the
 * other way round.
 *
 * ## Why this resolves scopes instead of scanning names (#1106)
 *
 * The first version of this returned ONE set of names for the whole file,
 * which made the exemption an alias granted by bare name. A security review
 * measured the consequence: `ship.js` binds `d` four times and only the one
 * at `gitDerivedStaging` is a quoter, so injecting `git -C ${d}` beside any
 * of the other three produced **0 refusals**, while the same line with
 * `${zz}` produced **1**. The decider laundered an unquoted interpolation
 * whenever the variable happened to share a name with a quoter elsewhere in
 * the file.
 *
 * **"Bound exactly once in the file" is NOT the fix, and measuring says so.**
 * It sounds equivalent and is not: under it `ship.js`'s `d` — four
 * declarations — stops being laundered everywhere, including at the two real
 * `git -C ${d}` uses inside `gitDerivedStaging`, which are correctly quoted.
 * That turns 0 refusals into 2 false ones and breaks the exemplar this check
 * exists to accommodate. The correct claim is the narrower one: *bound, in a
 * scope that encloses this use, to a quoter* — which is what this computes.
 *
 * Resolution is innermost-scope-outward over a real parse, so a parameter, a
 * destructuring target, a `catch` binding and a `for` head all shadow an
 * outer quoter. A name scan cannot see any of those, because none of them is
 * spelled `const NAME =`.
 *
 * ## It fails CLOSED
 *
 * A source acorn cannot parse launders nothing, so an unparseable file is
 * refused on every bare interpolation rather than exempted on all of them.
 * The opposite default would make a syntax error the most effective way to
 * switch this check off.
 */
export function quoterBindingsByLine(source: string): Map<number, Set<string>> {
  const byLine = new Map<number, Set<string>>();

  let program: AcornNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      // The workflow files are function BODIES, not modules — every one of
      // them carries a top-level `return`, and without these two acorn
      // rejects all six. Measured: with them, all six parse.
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    }) as unknown as AcornNode;
  } catch {
    return byLine; // fail closed: nothing is laundered
  }

  interface Scope {
    parent: Scope | null;
    /** name -> the offset at which it is bound, and whether that is a quoter. */
    names: Map<string, { start: number; quoter: boolean }>;
  }
  const scopeOf = new Map<AcornNode, Scope>();

  const bindName = (scope: Scope, name: string, start: number, quoter: boolean) => {
    // First binding in a scope wins the position; a redeclaration of the same
    // name in one scope is only ever a reason NOT to launder, so a later
    // non-quoter binding clears the flag rather than being ignored.
    const prior = scope.names.get(name);
    if (prior === undefined) scope.names.set(name, { start, quoter });
    else if (!quoter) prior.quoter = false;
  };

  /** Every name a binding pattern introduces. */
  const patternNames = (value: unknown, out: string[]): void => {
    if (!isNode(value)) return;
    const node = value as AcornNode;
    switch (node.type) {
      case "Identifier": out.push(node.name as string); break;
      case "ObjectPattern":
        for (const p of asNodes(node.properties)) patternNames(p.value ?? p.argument, out);
        break;
      case "ArrayPattern": for (const e of asNodes(node.elements)) patternNames(e, out); break;
      case "AssignmentPattern": patternNames(node.left, out); break;
      case "RestElement": patternNames(node.argument, out); break;
      default: break;
    }
  };

  const isQuoterInit = (init: unknown): boolean => {
    if (!isNode(init)) return false;
    const node = init as AcornNode;
    if (node.type !== "CallExpression") return false;
    const callee = node.callee;
    return (
      isNode(callee) &&
      (callee as AcornNode).type === "Identifier" &&
      (QUOTER_NAMES as readonly string[]).includes((callee as AcornNode).name as string)
    );
  };

  const SCOPED = new Set([
    "Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
    "BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "CatchClause",
  ]);

  // Pass 1: build the scope tree and its bindings.
  const build = (node: AcornNode, parent: Scope | null): void => {
    let scope = parent;
    if (SCOPED.has(node.type)) {
      scope = { parent, names: new Map() };
      scopeOf.set(node, scope);
    }
    if (scope) {
      if (node.type === "VariableDeclarator") {
        const names: string[] = [];
        patternNames(node.id, names);
        // A quoter only ever launders a PLAIN identifier binding: destructuring
        // out of a quoter's return value is not a quoted string.
        const quoter =
          isNode(node.id) && (node.id as AcornNode).type === "Identifier" && isQuoterInit(node.init);
        for (const n of names) bindName(scope, n, node.start as number, quoter);
      } else if (
        node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
      ) {
        const names: string[] = [];
        for (const p of asNodes(node.params)) patternNames(p, names);
        for (const n of names) bindName(scope, n, node.start as number, false);
        if (isNode(node.id) && parent) {
          bindName(parent, (node.id as AcornNode).name as string, node.start as number, false);
        }
      } else if (node.type === "CatchClause" && node.param) {
        const names: string[] = [];
        patternNames(node.param, names);
        for (const n of names) bindName(scope, n, node.start as number, false);
      } else if (node.type === "ClassDeclaration" && isNode(node.id)) {
        bindName(scope, (node.id as AcornNode).name as string, node.start as number, false);
      }
    }
    for (const child of childNodes(node)) build(child, scope);
  };
  build(program, null);

  // Pass 2: resolve every bare `${name}` against the scope chain at its site.
  const resolve = (scope: Scope | null, name: string, useStart: number): boolean => {
    for (let s = scope; s; s = s.parent) {
      const b = s.names.get(name);
      // A binding that starts AFTER the use does not govern it. Requiring
      // this is the safe direction: it only ever withholds laundering.
      if (b && b.start <= useStart) return b.quoter;
      if (b) return false;
    }
    return false;
  };

  const visit = (node: AcornNode, scope: Scope | null): void => {
    const here = scopeOf.get(node) ?? scope;
    if (node.type === "TemplateLiteral") {
      for (const expr of asNodes(node.expressions)) {
        if (expr.type !== "Identifier") continue;
        if (!resolve(here, expr.name as string, expr.start as number)) continue;
        const line = (expr.loc as { start: { line: number } } | undefined)?.start.line;
        if (line === undefined) continue;
        let set = byLine.get(line);
        if (!set) byLine.set(line, (set = new Set()));
        set.add(expr.name as string);
      }
    }
    for (const child of childNodes(node)) visit(child, here);
  };
  visit(program, null);

  return byLine;
}

/** Child AST nodes of `node`, in no particular order. */
function childNodes(node: AcornNode): AcornNode[] {
  const out: AcornNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "type" || key === "start" || key === "end") continue;
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v as AcornNode);
    } else if (isNode(value)) out.push(value as AcornNode);
  }
  return out;
}

function isNode(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string";
}

/** The AST nodes in an array-valued AST property, skipping holes. */
function asNodes(v: unknown): AcornNode[] {
  return Array.isArray(v) ? (v.filter(isNode) as AcornNode[]) : [];
}

/** The shape of an acorn node this module reads. Deliberately loose. */
type AcornNode = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

/**
 * Every unquoted directory interpolation on this line.
 *
 * THE decider: the conformity scan, and anything later that wants the same
 * question answered, calls this and nothing else. A second spelling of the
 * parse somewhere else would be the two-deciders-that-agree defect
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape) — mutate
 * this one and the other would keep its caller green.
 *
 * Takes a LINE rather than a file because the unit a report has to name is a
 * line, and because these sources are 10,000-line template-literal soup
 * where no larger unit has a boundary worth finding.
 */
export function barePathInterpolations(
  line: string,
  quotedNames: ReadonlySet<string> = new Set(),
): BarePathInterpolation[] {
  const found: BarePathInterpolation[] = [];

  // `-C`/`--cwd`/`--prefix`/`--project` followed by its value, and the `cd`
  // builtin followed by its target. `cd` is here as well as in
  // `lib/top-level-cd.ts` because the two ask different questions about it:
  // that one asks whether the shell moves, this one asks whether the path
  // survives a space. A subshell `( cd ${X} && … )` passes the first and
  // fails the second.
  const anchor = new RegExp(
    `(?:^|[\\s"'\`(;&|])(${PATH_FLAGS.map(f => f.replace(/[-]/g, "\\-")).join("|")}|cd)(?:=|\\s+)`,
    "g",
  );

  let m: RegExpExecArray | null;
  while ((m = anchor.exec(line))) {
    const form = m[1];
    let at = m.index + m[0].length;

    const doubleQuoted = line[at] === '"';
    if (doubleQuoted) at++;
    if (line.slice(at, at + 2) !== "${") continue; // a literal path is not ours

    const end = endOfInterpolation(line, at + 1);
    if (end === -1) continue; // unbalanced: the line is not what it looks like

    const expression = line.slice(at, end);
    const inner = expression.slice(2, -1).trim();

    if (isQuoterCall(inner)) continue;
    if (quotedNames.has(inner)) continue;

    found.push({
      form,
      expression: doubleQuoted ? `"${expression}"` : expression,
      quoting: doubleQuoted ? "double" : "none",
    });
  }

  return found;
}

/** A refusal, located. */
export interface LocatedBarePath extends BarePathInterpolation {
  /** 1-based line number in the ORIGINAL source. */
  line: number;
}

/**
 * Every unquoted directory interpolation in a whole source file.
 *
 * ## Comments are stripped, and that is a decision with a measurement
 *
 * `stripJsComments` blanks comment text while preserving every byte offset,
 * so the line numbers reported here are the source's own. Without it,
 * `workflows/ship.js` is refused at the docblock above `gitAddForCommit`,
 * which reads *"the commit still ran `cd ${commitDir}`, so nothing was
 * staged"* — prose ABOUT a defect, counted as the defect. That was one of the
 * seven hits the first run of this scan produced and the only false one.
 *
 * It is also the right view for the opposite reason: a quoting fix applied
 * inside a comment changes nothing a shell ever sees, so a check that could
 * be satisfied by editing a comment is a check that can be satisfied without
 * fixing anything.
 *
 * The stripper is template-literal aware, which matters here more than
 * anywhere else in the tree — these files are mostly prompt text, and a `//`
 * inside a prompt is a URL, not a comment.
 */
export function barePathInterpolationsIn(source: string): LocatedBarePath[] {
  const code = stripJsComments(source);
  // Over the STRIPPED copy, so a `const d = shellQuote(x)` written in a
  // comment cannot launder the name `d` for real code elsewhere.
  //
  // Per LINE, not per file (#1106). A file-wide set made the exemption an
  // alias granted by bare name, so a `${d}` anywhere in `ship.js` was
  // accepted because some other function bound a `d` to a quoter.
  const quoted = quoterBindingsByLine(code);
  const none: ReadonlySet<string> = new Set();
  const found: LocatedBarePath[] = [];
  code
    .split("\n")
    .forEach((line, i) => {
      for (const b of barePathInterpolations(line, quoted.get(i + 1) ?? none)) {
        found.push({ ...b, line: i + 1 });
      }
    });
  return found;
}

/**
 * What a caller is told, naming the one accepted remedy and refusing the
 * cheap one by name.
 *
 * Spelled here rather than at the call site so the refusal and the advice
 * cannot drift, the same reason `refusalMessage` lives inside
 * `lib/top-level-cd.ts`.
 */
export const BARE_PATH_REMEDY =
  "#1086: a directory is interpolated into a shell command unquoted, so a " +
  "consumer whose checkout is at `/Users/x/My Projects/thing` gets " +
  "`git -C /Users/x/My Projects/thing status` and an error naming a " +
  "directory nobody typed. Wrap the interpolation in `shellQuote(…)` at the " +
  "site, or bind it once (`const d = shellQuote(dir)`) and interpolate the " +
  "bound name. Do NOT write `\"${…}\"` instead: double quotes stop at the " +
  "space and leave `$(…)` and backticks expanding, which is the shape a " +
  "security review already caught once in `gitDerivedStaging`. Workflow " +
  "files cannot import (#69), so each one carries its own copy of " +
  "`shellQuote`; `lib/workflow-security.ts` is the source of truth and " +
  "`test/workflow-prompt-top-level-cd.test.ts` fails on any divergence.";
