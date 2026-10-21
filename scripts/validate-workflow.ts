#!/usr/bin/env bun
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

/**
 * Every refusal exits through this one constant, declared exactly once, so a
 * test can build a mutant copy with it set to 0 and watch a case that used to
 * refuse stop refusing. Without that, "exit code != 0" is indistinguishable
 * from a crash or a module-resolution failure — see
 * .claude/rules/checks-must-be-able-to-fail.md, "For a script whose job is to
 * exit non-zero". Do not inline a literal non-zero exit code anywhere below;
 * the only other exit permitted in this file is the success one, zero.
 *
 * The mutant runs from a temp directory, so this file must keep having no
 * relative imports.
 */
export const REFUSE_EXIT = 1;

const args = process.argv.slice(2);
const workflowPath = args[0] || join(import.meta.dir, "..", "workflows", "ship.js");
const resolved = resolve(workflowPath);

if (!existsSync(resolved)) {
  console.error(`Workflow not found: ${resolved}`);
  process.exit(REFUSE_EXIT);
}

let errors = 0;

console.log(`Validating workflow: ${resolved}`);

// 1. Syntax check — wrap in async function (matching workflow runtime) and parse
try {
  const content = readFileSync(resolved, "utf-8");
  const stripped = content
    .replace(/^export\s+(const|let|var|function|class|async\s+function)/gm, "$1")
    .replace(/^import\s+[^;]*;?\s*$/gm, "");
  // Workflow runtime wraps scripts in async function with injected globals
  const wrapped = `(async function(agent, phase, log, parallel, pipeline, workflow, args) {\n${stripped}\n})`;
  new Function(wrapped);
  console.log("  ✓ Syntax: valid JavaScript");
} catch (e: any) {
  console.error(`  ✗ Syntax error: ${e.message}`);
  errors++;
}

// ── Temporal dead zone detection ─────────────────────────────────────────
//
// #585: this used to recognise a usage only when the line ASSIGNED to the
// name (`^\s+NAME = `), and only when that line was indented. A READ matched
// nothing, and the shape that actually fired was not even a textual read:
// ship.js's `auditWorktreeClaims` reads `SINGLE_WORKTREE_EXEMPT` from the same
// marked block the `const` lives in — so no line-order comparison sees
// anything — and a decomposed run REACHES that function from a module-scope
// call ~350 lines above the declaration. It died with
// `Cannot access 'SINGLE_WORKTREE_EXEMPT' before initialization` after this
// validator had passed it in CI.
//
// The widened rule is three different questions, not one:
//
//   - a WRITE before the declaration is reported wherever it appears, which
//     is the pre-#585 behaviour kept intact.
//   - a READ before the declaration is a violation when the sandbox evaluates
//     it at MODULE SCOPE. A hoisted function may legitimately reference a
//     const declared below it, because the call happens later.
//   - a read inside a function body is a violation when that function is
//     REACHED, directly or transitively, from a module-scope call that sits
//     above the declaration. That is the #585 crash, and it is the only one
//     of the three a line-order grep cannot express.
//
// All of them match at any column. Where the scanner is unsure it stays
// silent: a missed TDZ costs one line somebody adds later, and a false
// positive on ship.js makes the whole validator something people route around.

/** One mention of a tracked name in code the sandbox will actually run. */
interface Usage {
  name: string;
  line: number;
  /** Inside a function body or a concise arrow body — evaluated later. */
  deferred: boolean;
  /** The name is being assigned to rather than read. */
  write: boolean;
  /** Nearest enclosing named function, or null at module scope. */
  owner: string | null;
}

/** One `name(` in code, with the same scope facts a usage carries. */
interface CallRef {
  callee: string;
  line: number;
  deferred: boolean;
  owner: string | null;
}

interface ScanResult {
  usages: Usage[];
  calls: CallRef[];
  /** Every function this scan could name. */
  functions: Set<string>;
}

/**
 * Words whose parenthesised clause is never a call's argument list.
 *
 * Declared HERE, above the module-scope block that reaches `scanSource`,
 * rather than beside the function that reads it — this script's own check
 * refuses it otherwise, which is the first thing the widened detector caught
 * and the reason the position is worth a comment rather than a shrug.
 */
const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "with", "return", "typeof",
  "instanceof", "void", "delete", "await", "yield", "function", "new", "in",
  "of", "do", "else", "case", "throw",
]);

/**
 * The keywords that introduce a binding. Declared beside CONTROL_KEYWORDS and
 * above the module-scope block for the same reason that one is.
 */
const DECLARATION_KEYWORDS = new Set(["let", "const", "var"]);

/** Heads whose parenthesised clause is a condition, not a parameter list. */
const CONDITION_HEADS = new Set(["if", "for", "while", "switch", "with"]);

try {
  const content = readFileSync(resolved, "utf-8");
  // Blanked, not stripped: the offsets and line numbers still line up with
  // the file, and a `const` or a brace quoted inside a string cannot move the
  // scanner's idea of scope.
  const code = stripNonCode(content);
  const lines = code.split("\n");

  // #598: the identifier class used to be `[A-Z_][A-Z_0-9]*`, so every name
  // that is not SCREAMING_SNAKE_CASE sat outside this check entirely while the
  // success line still said "no temporal dead zone issues". The live instance
  // is `let primaryBranchBefore` in workflows/ship.js: it is declared beside
  // the worktree registry, ~3,800 lines above the line that assigns it,
  // BECAUSE `terminalFailure` reads it and the exits are reachable long before
  // the assignment runs. Had it stayed where it was assigned, the run would
  // have died on the way out and this validator would have passed the file.
  //
  // The column-zero anchor stays. It is not a naming restriction, it is the
  // scope test: an indented `let`/`const` is block- or function-scoped, its
  // TDZ is bounded by its own block, and tracking it would compare a read in
  // one scope against a declaration in another.
  const moduleDeclarations = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const declMatch = lines[i].match(/^(?:let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
    if (declMatch) moduleDeclarations.set(declMatch[1], i + 1);
  }

  // Widening the name class makes collisions ordinary: `testCommand`,
  // `headSha` and `agentResults` are module-scope consts in ship.js AND
  // parameter names on functions declared above them. A mention inside a
  // scope that re-binds the name is not a reference to the module binding at
  // all, and reporting one is a false positive on a correct workflow — which
  // is the direction this check must not be wrong in, because a validator
  // that fails correct files is a validator people route around.
  //
  // So a name that is bound anywhere else in the file is DROPPED rather than
  // resolved. That under-detects, deliberately, and the count of what was
  // dropped is printed beside the verdict: a scan that reports a verdict has
  // to report its own coverage, or a PASS over 20 names reads exactly like a
  // PASS over 62 (#492).
  const bindings = bindingSites(code);
  const declarations = new Map<string, number>();
  const shadowed: string[] = [];
  for (const [name, declLine] of moduleDeclarations) {
    if ((bindings.get(name) || 0) > 1) shadowed.push(name);
    else declarations.set(name, declLine);
  }
  shadowed.sort();

  const scan: ScanResult = declarations.size > 0
    ? scanSource(code, new Set(declarations.keys()))
    : { usages: [], calls: [], functions: new Set() };

  const violations: string[] = [];
  const seen = new Set<string>();
  const report = (key: string, message: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(message);
  };

  // (a) and (b): the textual rules.
  for (const usage of scan.usages) {
    const declLine = declarations.get(usage.name)!;
    if (usage.line >= declLine) continue;
    if (usage.deferred && !usage.write) continue;
    report(
      `text:${usage.name}:${usage.line}`,
      `  ✗ TDZ: '${usage.name}' ${usage.write ? "assigned" : "read"} at line ` +
        `${usage.line} but declared at line ${declLine}`,
    );
  }

  // (c): the reachability rule. A module-scope call runs during module
  // evaluation, so everything it can reach runs there too.
  for (const entry of moduleScopeReads(scan)) {
    const declLine = declarations.get(entry.name)!;
    if (entry.callLine >= declLine) continue;
    report(
      `reach:${entry.name}:${entry.readLine}:${entry.callLine}`,
      `  ✗ TDZ: '${entry.name}' read at line ${entry.readLine} inside ` +
        `${entry.inFunction}(), reached from the module-scope call to ` +
        `${entry.entryFunction}() at line ${entry.callLine}, but declared at ` +
        `line ${declLine}`,
    );
  }

  // Report the scan's own coverage, pass or fail. A clean verdict over a file
  // the scanner never read looks exactly like a clean verdict over a file it
  // read all of — #492 in .claude/rules/checks-must-be-able-to-fail.md — and
  // this check is green on every workflow in the tree, so the coverage number
  // is the only part of its output that can change when it stops working.
  //
  // #598: the dropped names are NAMED, not counted. "3 not tracked" tells a
  // reader the scan is partial; naming them tells the one person who needs to
  // know which three, and that is the difference between a coverage number
  // and an actionable one.
  const coverage =
    `${declarations.size} of ${moduleDeclarations.size} module declaration(s) tracked, ` +
    `${scan.usages.length} reference(s) scanned` +
    (shadowed.length > 0
      ? `; ${shadowed.length} re-bound elsewhere and NOT checked: ${shadowed.join(", ")}`
      : "");
  if (violations.length === 0) {
    console.log(`  ✓ TDZ check: no temporal dead zone issues — ${coverage}`);
  } else {
    for (const v of violations) console.error(v);
    console.error(`  ✗ TDZ check: ${violations.length} violation(s) — ${coverage}`);
    errors += violations.length;
  }
} catch (e: any) {
  console.error(`  ✗ TDZ check failed: ${e.message}`);
  errors++;
}

interface ReachedRead {
  name: string;
  readLine: number;
  inFunction: string;
  entryFunction: string;
  callLine: number;
}

/**
 * Tracked names reached from a module-scope call, with the call that reaches
 * them. The call graph is followed transitively, because `runDecomposedShip`
 * does not touch `SINGLE_WORKTREE_EXEMPT` itself — it is three frames up from
 * the read that crashed.
 */
function moduleScopeReads(scan: ScanResult): ReachedRead[] {
  const readsIn = new Map<string, Array<{ name: string; line: number }>>();
  for (const u of scan.usages) {
    if (!u.deferred || u.write || u.owner === null) continue;
    const list = readsIn.get(u.owner) || [];
    list.push({ name: u.name, line: u.line });
    readsIn.set(u.owner, list);
  }

  const callsIn = new Map<string, Set<string>>();
  for (const c of scan.calls) {
    if (c.owner === null || !scan.functions.has(c.callee)) continue;
    const set = callsIn.get(c.owner) || new Set<string>();
    set.add(c.callee);
    callsIn.set(c.owner, set);
  }

  const out: ReachedRead[] = [];
  for (const entry of scan.calls) {
    if (entry.deferred || !scan.functions.has(entry.callee)) continue;

    const visited = new Set<string>();
    const queue = [entry.callee];
    while (queue.length > 0) {
      const fn = queue.shift()!;
      if (visited.has(fn)) continue;
      visited.add(fn);
      for (const r of readsIn.get(fn) || []) {
        out.push({
          name: r.name,
          readLine: r.line,
          inFunction: fn,
          entryFunction: entry.callee,
          callLine: entry.line,
        });
      }
      for (const callee of callsIn.get(fn) || []) queue.push(callee);
    }
  }
  return out;
}

/**
 * How many times each name is BOUND in blanked source — declared, named as a
 * function, or introduced as a parameter or catch binding.
 *
 * It exists to answer one question: is a mention of this name somewhere in
 * the file certainly a mention of the module-scope binding? A name bound
 * exactly once has no other binding it could refer to. A name bound twice
 * might, and this scanner does not resolve scopes, so the caller drops it.
 *
 * Every judgement here is biased toward counting MORE bindings than exist,
 * never fewer. `function f(a, b = LIMIT)` counts `LIMIT` as bound, which is
 * wrong and harmless: an extra count only ever removes a name from the
 * tracked set, and a missed TDZ costs one line somebody adds later while a
 * false positive on a correct workflow costs the validator its credibility.
 * A binding form nobody thought of is the one failure this ordering cannot
 * absorb, which is why the parameter rule reads every identifier inside a
 * parameter list rather than trying to parse the pattern.
 */
function bindingSites(src: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: string) => counts.set(name, (counts.get(name) || 0) + 1);
  const idChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

  /**
   * Count every identifier in the binding pattern `[from, to)` as bound,
   * skipping default-value expressions: `projectRoot = PROJECT_ROOT` binds
   * `projectRoot` and READS `PROJECT_ROOT`, and ship.js has exactly that
   * twice. Counting the default as a binding would drop a SCREAMING_SNAKE
   * name this check has tracked since before #598 — under-detection is the
   * safe direction, but it is not free, and a rule that pays for a widening
   * by narrowing somewhere else should be made to say so.
   *
   * Only a default at the TOP level of the pattern is skipped. A nested one
   * (`{ a = LIMIT }`) still counts `LIMIT`, which over-counts and is safe. An
   * arrow inside a default has its own parameter list, and the main loop
   * reaches it independently of this pass.
   */
  const bumpBindings = (from: number, to: number) => {
    let k = from;
    let depth = 0;
    let inDefault = false;
    while (k < to) {
      const ch = src[k];
      if (ch === "(" || ch === "[" || ch === "{") { depth++; k++; continue; }
      if (ch === ")" || ch === "]" || ch === "}") { depth--; k++; continue; }
      if (depth === 0 && ch === ",") { inDefault = false; k++; continue; }
      if (depth === 0 && ch === "=" && src[k + 1] !== "=" && src[k - 1] !== "=") {
        inDefault = true;
        k++;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch) && !idChar(src[k - 1])) {
        let m = k;
        while (m < to && idChar(src[m])) m++;
        const w = src.slice(k, m);
        if (!inDefault && !CONTROL_KEYWORDS.has(w) && !DECLARATION_KEYWORDS.has(w)
          && w !== "async") {
          bump(w);
        }
        k = m;
        continue;
      }
      k++;
    }
  };

  /** Open parens, with the word that preceded each one. */
  const open: Array<{ at: number; head: string }> = [];
  let prevWord = "";
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (/[A-Za-z_$]/.test(c) && !idChar(src[i - 1])) {
      let j = i;
      while (j < src.length && idChar(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;

      // `const x`, `let x`, `var x`, `function f` — the name after the keyword.
      if (DECLARATION_KEYWORDS.has(prevWord) || prevWord === "function") bump(word);
      // `const { a, b } = …` and `const [a, b] = …`: every identifier in the
      // pattern. Property keys are counted too, which over-counts in the safe
      // direction rather than parsing `{ a: b }` by hand.
      if (DECLARATION_KEYWORDS.has(word) && (src[k] === "{" || src[k] === "[")) {
        const close = src[k] === "{"
          ? matchingClose(src, k, "{", "}")
          : matchingClose(src, k, "[", "]");
        if (close > k) bumpBindings(k + 1, close);
      }
      // `x => …`, the one parameter list with no parentheses.
      if (src[k] === "=" && src[k + 1] === ">") bump(word);

      prevWord = word;
      i = j;
      continue;
    }

    if (c === "(") {
      open.push({ at: i, head: prevWord });
      prevWord = "";
      i++;
      continue;
    }

    if (c === ")") {
      const frame = open.pop();
      if (frame) {
        let m = i + 1;
        while (m < src.length && /\s/.test(src[m])) m++;
        // A parenthesised clause is a binding list when an arrow or a body
        // follows it, or when it belongs to `catch`. `catch (e) {` is the one
        // place a `{` is NOT a function body and the parens ARE bindings,
        // which is why this asks its own question rather than reusing
        // opensFunctionBody.
        const isBindingList =
          frame.head === "catch" ||
          (src[m] === "=" && src[m + 1] === ">") ||
          (src[m] === "{" && !CONDITION_HEADS.has(frame.head));
        if (isBindingList) bumpBindings(frame.at + 1, i);
      }
      prevWord = "";
      i++;
      continue;
    }

    if (!/\s/.test(c)) prevWord = "";
    i++;
  }

  return counts;
}

/** Index of the delimiter matching the one at `openIdx`, or -1. */
function matchingClose(src: string, openIdx: number, o: string, c: string): number {
  let depth = 0;
  for (let k = openIdx; k < src.length; k++) {
    if (src[k] === o) depth++;
    else if (src[k] === c) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Every mention of `names` in blanked source, plus every call, with the facts
 * the TDZ rules need about each one: whether it runs at module scope, whether
 * it is a write, and which named function encloses it.
 *
 * Scope is tracked with a bracket stack. A `{` is a function body when the
 * token in front of it is `=>`, or a `)` whose matching `(` is not preceded
 * by `if`/`for`/`while`/`switch`/`catch`/`with` — which covers
 * `function f() {`, `async () => {`, `method() {` and `get x() {` while
 * leaving `if (…) {`, `try {`, `else {` and object literals at module scope,
 * because that is where they run.
 */
function scanSource(src: string, names: Set<string>): ScanResult {
  const usages: Usage[] = [];
  const calls: CallRef[] = [];
  const functions = new Set<string>();
  const stack: Array<{ fn: boolean; name: string | null }> = [];
  /** Stack depths at which a concise (unbraced) arrow body is open. */
  const arrows: number[] = [];
  const idChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

  /** Nearest enclosing named function — an anonymous body belongs to it. */
  const owner = (): string | null => {
    for (let d = stack.length - 1; d >= 0; d--) {
      if (stack[d].fn && stack[d].name) return stack[d].name;
    }
    return null;
  };
  const deferred = () => arrows.length > 0 || stack.some((f) => f.fn);

  let line = 1;
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\n") { line++; i++; continue; }

    if (c === "{") {
      const fn = opensFunctionBody(src, i);
      const name = fn ? functionNameAt(src, i) : null;
      if (name) functions.add(name);
      stack.push({ fn, name });
      i++;
      continue;
    }
    if (c === "(" || c === "[") { stack.push({ fn: false, name: null }); i++; continue; }
    if (c === "}" || c === ")" || c === "]") {
      stack.pop();
      while (arrows.length > 0 && arrows[arrows.length - 1] > stack.length) arrows.pop();
      i++;
      continue;
    }

    if (c === "=" && src[i + 1] === ">") {
      // A braced arrow body is already handled by opensFunctionBody; this is
      // the concise form, which runs to the end of its expression.
      let j = i + 2;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      if (src[j] !== "{") arrows.push(stack.length);
      i += 2;
      continue;
    }

    if ((c === "," || c === ";") && arrows.length > 0 && arrows[arrows.length - 1] >= stack.length) {
      arrows.pop();
      i++;
      continue;
    }

    if (/[A-Za-z_$]/.test(c) && !idChar(src[i - 1])) {
      let j = i;
      while (j < src.length && idChar(src[j])) j++;
      const word = src.slice(i, j);
      const member = src.slice(0, i).trimEnd().slice(-1) === ".";
      let k = j;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;

      if (!member && src[k] === "(" && !CONTROL_KEYWORDS.has(word)
        && !isFunctionHead(src, i, k)) {
        calls.push({ callee: word, line, deferred: deferred(), owner: owner() });
      }

      if (names.has(word) && !member) {
        const top = stack[stack.length - 1];
        // `{ NAME: … }` is a key, not a read. A property name in an object
        // literal is the one place this shape is never a reference.
        const isObjectKey = src[k] === ":" && top !== undefined && !top.fn
          && src[lastMeaningfulIndex(src, i)] !== "?";
        if (!isObjectKey) {
          usages.push({
            name: word,
            line,
            deferred: deferred(),
            write: src[k] === "=" && src[k + 1] !== "=" && src[k + 1] !== ">",
            owner: owner(),
          });
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return { usages, calls, functions };
}

/** Index of the last non-whitespace character before `i`, or -1. */
function lastMeaningfulIndex(src: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j;
}

/** The identifier immediately before `(`, walking back from `end`. */
function wordEndingAt(src: string, end: number): string {
  let m = end;
  while (m >= 0 && /[A-Za-z0-9_$]/.test(src[m])) m--;
  return src.slice(m + 1, end + 1);
}

/** Whether the `{` at `braceIdx` opens a function body rather than a block. */
function opensFunctionBody(src: string, braceIdx: number): boolean {
  const j = lastMeaningfulIndex(src, braceIdx);
  if (j < 0) return false;
  if (src[j] === ">" && src[j - 1] === "=") return true;
  if (src[j] !== ")") return false;

  const k = matchingOpenParen(src, j);
  if (k < 0) return false;

  const end = lastMeaningfulIndex(src, k);
  if (end < 0) return false;
  const head = wordEndingAt(src, end);
  if (!head) return false;
  // Heads whose parenthesised clause is a condition, not a parameter list:
  // the `{` after one of these is a block that runs where it sits.
  return !["if", "for", "while", "switch", "catch", "with"].includes(head);
}

/**
 * Whether `name(` at `nameIdx`, with its `(` at `parenIdx`, is a function
 * being DECLARED rather than called. `function timedAgent(prompt) {` reads as
 * a call to every tokenizer that only looks at `identifier` + `(` — and
 * reading a declaration as a module-scope call makes every const the body
 * touches a violation, which is five false positives on ship.js and the
 * reason this is a function rather than one more condition inline.
 */
function isFunctionHead(src: string, nameIdx: number, parenIdx: number): boolean {
  const before = lastMeaningfulIndex(src, nameIdx);
  if (before >= 0 && wordEndingAt(src, before) === "function") return true;

  const close = matchingCloseParen(src, parenIdx);
  if (close < 0) return false;
  const after = close + 1;
  let j = after;
  while (j < src.length && /\s/.test(src[j])) j++;
  // `method() {` and `f() => …` are heads; `f()` followed by anything else is
  // a call. A `{` here cannot be a block statement, because a call expression
  // is never followed by one.
  if (src[j] === "{") return true;
  if (src[j] === "=" && src[j + 1] === ">") return true;
  return false;
}

/** Index of the `)` matching the `(` at `openIdx`, or -1. */
function matchingCloseParen(src: string, openIdx: number): number {
  let depth = 0;
  for (let k = openIdx; k < src.length; k++) {
    if (src[k] === "(") depth++;
    else if (src[k] === ")") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Index of the `(` matching the `)` at `closeIdx`, or -1. */
function matchingOpenParen(src: string, closeIdx: number): number {
  let depth = 0;
  for (let k = closeIdx; k >= 0; k--) {
    if (src[k] === ")") depth++;
    else if (src[k] === "(") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * The name of the function whose body opens at `braceIdx`, or null when it is
 * anonymous. Covers `function f() {`, `async function f() {`, `method() {`,
 * `const f = () => {` and `const f = async function () {` — the shapes
 * workflow scripts are written in. An anonymous body is attributed to its
 * nearest named ancestor by the caller, which is the conservative direction:
 * reaching a callback through its enclosing function is a reachability claim
 * that may be too generous, never one that is missed.
 */
function functionNameAt(src: string, braceIdx: number): string | null {
  const j = lastMeaningfulIndex(src, braceIdx);
  if (j < 0) return null;

  // `=> {` — the name, if any, is on the binding the arrow was assigned to.
  if (src[j] === ">" && src[j - 1] === "=") {
    return bindingNameBefore(src, j - 1);
  }

  if (src[j] !== ")") return null;
  const open = matchingOpenParen(src, j);
  if (open < 0) return null;
  const end = lastMeaningfulIndex(src, open);
  if (end < 0) return null;
  const head = wordEndingAt(src, end);
  // `function () {` and `function* () {` are anonymous; so is a bare `) {`.
  if (!head || head === "function") return bindingNameBefore(src, end);
  return head;
}

/**
 * Walking left from `end`, the identifier an anonymous function is being
 * assigned to: `const run = async () => {` gives `run`. Null when there is
 * no such binding.
 */
function bindingNameBefore(src: string, end: number): string | null {
  let p = end;
  // Skip a parameter list or a parenthesised single parameter.
  if (src[p] === ")") {
    p = matchingOpenParen(src, p);
    if (p < 0) return null;
    p = lastMeaningfulIndex(src, p);
  } else if (/[A-Za-z0-9_$]/.test(src[p] || "")) {
    const word = wordEndingAt(src, p);
    p = lastMeaningfulIndex(src, p - word.length + 1 - 1);
  }
  // Skip `async`, and `function` for `const f = function () {`.
  for (let guard = 0; guard < 3; guard++) {
    if (p < 0) return null;
    const word = wordEndingAt(src, p);
    if (word === "async" || word === "function") {
      p = lastMeaningfulIndex(src, p - word.length + 1 - 1);
      continue;
    }
    break;
  }
  if (p < 0 || src[p] !== "=") return null;
  const beforeEq = lastMeaningfulIndex(src, p);
  if (beforeEq < 0) return null;
  const name = wordEndingAt(src, beforeEq);
  return name || null;
}

// 3. Undeclared globals check — workflow sandbox provides specific globals
//
// This list is MEASURED, not assumed (#69). It comes from running a probe
// workflow that reports `typeof <name>` for each candidate. Do not add a name
// here on the belief that it "should" be available — re-run the probe.
//
// The previous list claimed require, process, Buffer and eval were available.
// None of them are. That is what let ship.js ship a top-level require() which
// killed every run: the validator approved it and no test ever executed it.
const WORKFLOW_GLOBALS = new Set([
  // harness-provided
  "agent", "phase", "log", "parallel", "pipeline", "workflow", "args", "budget",
  // runtime-provided
  "console", "globalThis", "JSON", "Math", "Date",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  // language built-ins
  "Object", "Array", "String", "Number", "Boolean",
  "Map", "Set", "Error", "RegExp", "Promise", "Proxy", "Symbol",
  "parseInt", "parseFloat", "isNaN", "isFinite", "undefined", "NaN",
  "Infinity", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI",
]);

// Names the sandbox does NOT provide, with the reason, so the error is
// actionable rather than a bare "undeclared global".
//
// These are only a problem at the top level of a workflow script. Inside a
// template literal they are fine — those strings are executed by `bun -e` in a
// real Bun runtime, not by the sandbox.
const FORBIDDEN_SANDBOX_GLOBALS = new Map([
  ["require", "no module loading in the sandbox — inline the code instead (#69)"],
  ["process", "no Node process object — pass values in through args"],
  ["Buffer", "no Node Buffer"],
  ["module", "not a CommonJS module"],
  ["exports", "not a CommonJS module"],
  ["__dirname", "no filesystem context"],
  ["__filename", "no filesystem context"],
  ["Bun", "no Bun global — shell out through an agent instead"],
  ["fetch", "no network primitives in the sandbox"],
  ["eval", "code generation from strings is disallowed by the sandbox"],
]);

/**
 * The sandbox constraint this validator could not express until #903.
 *
 * `FORBIDDEN_SANDBOX_GLOBALS` keys on a bare global NAME. Three of the
 * constructs the sandbox refuses are not bare names — they are members of
 * globals that DO exist. `Date` and `Math` are both in `WORKFLOW_GLOBALS` and
 * both really are there, so a name-shaped detector is structurally incapable
 * of seeing `Date.now()`. Measured on 2026-10-21 against `origin/main`: a
 * workflow whose every top-level statement throws in the sandbox
 * (`Date.now()`, `Math.random()`, `new Date()`) validated with
 * `✓ Sandbox globals: no unavailable globals referenced` and exit 0.
 *
 * That is a detector narrower than the thing it detects, and #903 is the
 * record of what the gap costs: the constraint was priced three separate
 * times in one session, each time by reading a prose comment someone had hand-
 * written beside the code. `workflows/prove.js`, `workflows/ship.js` and
 * `lib/trajectory.ts` each carry one of those comments. A constraint
 * maintained by comment is the tell that no detector covers it.
 *
 * SOURCE, AND HOW TO RE-CHECK IT. These three are stated by the host's own
 * `workflow-authoring` reference, read 2026-10-21: *"Standard JS built-ins
 * (JSON, Math, Array, etc.) are available — EXCEPT `Date.now()`/
 * `Math.random()`/argless `new Date()`, which throw (they would break
 * resume)"*. The reason is resume: a cached prefix of `agent()` calls has to
 * replay to the same values. Do not add an entry here on the belief that it
 * "should" be unavailable — the list above says the same thing, and says it
 * because a previous version of it was wrong in exactly that way. Re-check by
 * running a workflow whose script body is only:
 *
 *     const probe = (l, f) => { try { return l + '=' + String(f()) } catch (e) { return l + '=THREW:' + e.message } }
 *     return [probe('Date.now', () => Date.now()), probe('Math.random', () => Math.random()),
 *             probe('new Date', () => new Date().toISOString()), probe('typeof require', () => typeof require)]
 *
 * It spawns no agents and costs nothing. A constraint that ships with its own
 * falsification recipe does not rot the way a bare assertion does.
 */
const FORBIDDEN_SANDBOX_CAPABILITIES: { label: string; pattern: RegExp; reason: string }[] = [
  {
    label: "Date.now()",
    pattern: /(?<![.\w$])Date\s*\.\s*now\s*\(/g,
    reason:
      "the sandbox throws on Date.now() — it would break resume (#69, #903). Stamp the time after the workflow returns, or pass it in through `args`.",
  },
  {
    label: "Math.random()",
    pattern: /(?<![.\w$])Math\s*\.\s*random\s*\(/g,
    reason:
      "the sandbox throws on Math.random() — it would break resume (#69, #903). Vary the agent prompt or label by index instead.",
  },
  {
    label: "new Date()",
    pattern: /(?<![.\w$])new\s+Date\s*\(\s*\)/g,
    reason:
      "the sandbox throws on an ARGLESS new Date() — it would break resume (#69, #903). `new Date(someIso)` is fine and is not matched here; it is reading the clock that is refused.",
  },
  {
    label: "import()",
    pattern: /(?<![.\w$])import\s*\(/g,
    reason:
      "no dynamic module loading in the sandbox, for the same reason `require` is refused above (#69). Put the code in scripts/ and invoke it through an agent step.",
  },
];

/**
 * Blank everything the sandbox never evaluates as script — comments, and the
 * contents of string, template and regular-expression literals — replacing
 * each character with a space and leaving newlines alone. What remains is
 * code the sandbox actually runs, so an identifier found here is really being
 * referenced, and its offset and line number are still the ones a reader will
 * open the file at.
 *
 * Template literals matter most — ship.js legitimately embeds `require('fs')`
 * inside `bun -e` strings, and those run in a real Bun runtime. Interpolations
 * are blanked along with the rest of the literal: that loses a read inside
 * `${...}`, which is the direction this is allowed to be wrong in.
 *
 * Regex literals are blanked because they are the one construct that reliably
 * breaks a scanner built from `String.replace`. ship.js contains a character
 * class holding a backtick, a quote, an apostrophe and four brackets at once.
 * Pairing those with unrelated ones elsewhere in the file is exactly the
 * defect .claude/rules/checks-must-be-able-to-fail.md records against the
 * previous top-level-`require` guard, which deleted 61% of the file it was
 * scanning.
 */
function stripNonCode(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  const n = src.length;
  let i = 0;
  // The last meaningful code character, and the last word, seen before `i`.
  // Together they decide whether a `/` opens a regex or divides.
  let prevChar = "";
  let prevWord = "";

  while (i < n) {
    const c = src[i];

    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      const j2 = src[j] === c ? j + 1 : j;
      blank(i, j2);
      i = j2;
      prevChar = c;
      prevWord = "";
      continue;
    }

    if (c === "`") {
      const j = endOfTemplate(src, i);
      blank(i, j);
      i = j;
      prevChar = "`";
      prevWord = "";
      continue;
    }

    if (c === "/" && regexCanStartHere(prevChar, prevWord)) {
      const j = endOfRegex(src, i);
      if (j > i) {
        blank(i, j);
        i = j;
        prevChar = "/";
        prevWord = "";
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prevChar = src[j - 1];
      i = j;
      continue;
    }

    if (!/\s/.test(c)) {
      prevChar = c;
      prevWord = "";
    }
    i++;
  }

  return out.join("");
}

/** Index one past the backtick that closes the template opened at `start`. */
function endOfTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      // Skip the interpolation wholesale: it may hold another template.
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "`") { i = endOfTemplate(src, i); continue; }
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return src.length;
}

/**
 * Whether a `/` at this point opens a regex literal rather than dividing. The
 * standard lexical test: a regex may start wherever an expression may start.
 */
function regexCanStartHere(prevChar: string, prevWord: string): boolean {
  if (prevWord) {
    return ["return", "typeof", "instanceof", "in", "of", "new", "delete",
      "void", "case", "do", "else", "yield", "await"].includes(prevWord);
  }
  if (prevChar === "") return true;
  return "(,=:[!&|?{};+-*%~^<>".includes(prevChar);
}

/**
 * Index one past the closing `/` and flags of the regex opened at `start`, or
 * `start` itself when the literal does not close on this line — in which case
 * it was a division after all and nothing should be blanked.
 */
function endOfRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") return start;
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      return i;
    }
    i++;
  }
  return start;
}

// 3b. Forbidden-global check — the sandbox does not provide these at all
try {
  const code = stripNonCode(readFileSync(resolved, "utf-8"));
  let forbidden = 0;

  for (const [name, reason] of FORBIDDEN_SANDBOX_GLOBALS) {
    const pattern = new RegExp(`(?<![.\\w$])${name}\\s*[({.[]`, "g");
    const hits = code.match(pattern);
    if (hits) {
      console.error(
        `  ✗ \`${name}\` used ${hits.length}x at workflow top level — ${reason}`,
      );
      forbidden += hits.length;
      errors++;
    }
  }

  // Capabilities, not names (#903). A member of an available global is
  // invisible to the loop above, and three of the sandbox's refusals have
  // exactly that shape.
  //
  // Each candidate is re-tested against the RAW source at the same offsets.
  // `stripNonCode` replaces every blanked character with a space and leaves
  // newlines alone, so offsets and lengths map 1:1 and the raw span is exactly
  // the text a reader sees. That second look is load-bearing for `new Date()`:
  // blanking turns `new Date('2026-01-01T00:00:00Z')` into
  // `new Date(                      )`, which is argless to a regex. The first
  // draft of this check reported that line as a violation — a detector that
  // flags legal code is the same defect as one that misses illegal code, just
  // pointed the other way.
  const raw = readFileSync(resolved, "utf-8");
  for (const { label, pattern, reason } of FORBIDDEN_SANDBOX_CAPABILITIES) {
    const scanner = new RegExp(pattern.source, "g");
    const hits: string[] = [];
    for (const m of code.matchAll(scanner)) {
      const span = raw.slice(m.index!, m.index! + m[0].length);
      if (new RegExp(`^(?:${pattern.source})$`).test(span)) hits.push(span);
    }
    if (hits.length > 0) {
      console.error(
        `  ✗ \`${label}\` used ${hits.length}x at workflow top level — ${reason}`,
      );
      forbidden += hits.length;
      errors++;
    }
  }

  if (forbidden === 0) {
    // Names the two things that were checked, because "no unavailable globals
    // referenced" was the exact line this check printed while approving a
    // script whose every statement throws (#903).
    console.log(
      `  ✓ Sandbox capabilities: none of the ${FORBIDDEN_SANDBOX_GLOBALS.size} unavailable global(s) ` +
        `or ${FORBIDDEN_SANDBOX_CAPABILITIES.length} unavailable capability form(s) referenced`,
    );
  }
} catch (e: any) {
  console.error(`  ✗ Forbidden-global check failed: ${e.message}`);
  errors++;
}

// 4. Check for dangerous inline shell patterns
try {
  const content = readFileSync(resolved, "utf-8");
  const lines = content.split("\n");
  let dangerousPatterns = 0;

  // The SECURITY-HELPERS block is the one sanctioned home for shell
  // construction — it IS the vetted builder. Scanning it flags the fix as the
  // defect, so skip it here and let the behavioural parity tests cover it.
  let inHelpers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("SECURITY-HELPERS-START")) { inHelpers = true; continue; }
    if (line.includes("SECURITY-HELPERS-END")) { inHelpers = false; continue; }
    if (inHelpers) continue;

    // git add with unquoted interpolation (not using buildSafeGitAdd)
    if (line.match(/git add \$\{/) && !line.includes("buildSafeGitAdd")) {
      console.warn(
        `  ⚠ Line ${i + 1}: Inline git add with interpolation — consider buildSafeGitAdd()`,
      );
      dangerousPatterns++;
    }
  }

  if (dangerousPatterns === 0) {
    console.log("  ✓ Shell patterns: no dangerous inline construction");
  } else {
    console.warn(`  ⚠ ${dangerousPatterns} inline shell pattern(s) found (warnings, not errors)`);
  }
} catch (e: any) {
  console.error(`  ✗ Shell pattern check failed: ${e.message}`);
  errors++;
}

if (errors > 0) {
  console.error(`\n✗ FAILED: ${errors} error(s) found`);
  process.exit(REFUSE_EXIT);
} else {
  console.log(`\n✓ PASSED: workflow validation complete`);
  process.exit(0);
}
