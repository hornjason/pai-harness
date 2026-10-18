#!/usr/bin/env bun
import { execSync } from "child_process";
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

// 2. Temporal dead zone detection — find let/const declarations and usages
//
// #585: this used to recognise a usage only when the line ASSIGNED to the
// name (`^\s+NAME = `), and only when that line was indented. A module-scope
// READ matched nothing, which is the far commoner TDZ and the one that
// actually fired: ship.js read `SINGLE_WORKTREE_EXEMPT` ~350 lines above its
// `const` and died with `Cannot access ... before initialization` after this
// validator had passed it in CI.
//
// The widened rule, stated as the two different questions it really is:
//
//   - a READ before the declaration is a violation only when the sandbox
//     evaluates it at MODULE SCOPE. A hoisted function may legitimately
//     reference a const declared below it, because the call happens later —
//     so anything inside a function body (or a concise arrow body) is
//     deferred and never reported. That is AC-6, and it is the whole reason
//     this cannot be a line-order grep.
//   - a WRITE before the declaration is reported wherever it appears, which
//     is the pre-#585 behaviour kept intact.
//
// Both now match at any column. Where the scanner is unsure it stays silent:
// a missed TDZ costs one line somebody adds later, and a false positive on
// ship.js makes the whole validator something people route around.
try {
  const content = readFileSync(resolved, "utf-8");
  // Blanked, not stripped: the offsets and line numbers still line up with
  // the file, and a `const` or a brace quoted inside a string cannot move the
  // scanner's idea of scope.
  const code = stripNonCode(content);
  const lines = code.split("\n");

  const declarations = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const declMatch = lines[i].match(/^(?:let|const)\s+([A-Z_][A-Z_0-9]*)\s*=/);
    if (declMatch) declarations.set(declMatch[1], i + 1);
  }

  const scanned = declarations.size > 0
    ? scanUsages(code, new Set(declarations.keys()))
    : [];

  let tdzFound = 0;
  for (const usage of scanned) {
    const declLine = declarations.get(usage.name)!;
    if (usage.line >= declLine) continue;
    if (usage.deferred && !usage.write) continue;
    console.error(
      `  ✗ TDZ: '${usage.name}' ${usage.write ? "assigned" : "read"} at line ` +
        `${usage.line} but declared at line ${declLine}`,
    );
    tdzFound++;
  }

  // Report the scan's own coverage, pass or fail. A clean verdict over a file
  // the scanner never read looks exactly like a clean verdict over a file it
  // read all of — #492 in .claude/rules/checks-must-be-able-to-fail.md — and
  // this check is green on every workflow in the tree, so the coverage number
  // is the only part of its output that can change when it stops working.
  const coverage = `${declarations.size} tracked declaration(s), ${scanned.length} reference(s) scanned`;
  if (tdzFound === 0) {
    console.log(`  ✓ TDZ check: no temporal dead zone issues — ${coverage}`);
  } else {
    console.error(`  ✗ TDZ check: ${tdzFound} violation(s) — ${coverage}`);
    errors += tdzFound;
  }
} catch (e: any) {
  console.error(`  ✗ TDZ check failed: ${e.message}`);
  errors++;
}

/** One mention of a tracked name in code the sandbox will actually run. */
interface Usage {
  name: string;
  line: number;
  /** Inside a function body or a concise arrow body — evaluated later. */
  deferred: boolean;
  /** The name is being assigned to rather than read. */
  write: boolean;
}

/**
 * Every mention of `names` in blanked source, with the two facts the TDZ rule
 * needs about each one: whether it runs at module scope, and whether it is a
 * write.
 *
 * Scope is tracked with a bracket stack. A `{` is a function body when the
 * token in front of it is `=>`, or a `)` whose matching `(` is not preceded
 * by `if`/`for`/`while`/`switch`/`catch`/`with` — which covers
 * `function f() {`, `async () => {`, `method() {` and `get x() {` while
 * leaving `if (…) {`, `try {`, `else {` and object literals at module scope,
 * because that is where they run.
 */
function scanUsages(src: string, names: Set<string>): Usage[] {
  const found: Usage[] = [];
  const stack: Array<{ fn: boolean }> = [];
  /** Stack depths at which a concise (unbraced) arrow body is open. */
  const arrows: number[] = [];
  const idChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

  let line = 1;
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\n") { line++; i++; continue; }

    if (c === "{") { stack.push({ fn: opensFunctionBody(src, i) }); i++; continue; }
    if (c === "(" || c === "[") { stack.push({ fn: false }); i++; continue; }
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
      if (names.has(word) && src.slice(0, i).trimEnd().slice(-1) !== ".") {
        let k = j;
        while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
        const top = stack[stack.length - 1];
        // `{ NAME: … }` is a key, not a read. A property name in an object
        // literal is the one place this shape is never a reference.
        const isObjectKey = src[k] === ":" && top !== undefined && !top.fn
          && src[lastMeaningfulIndex(src, i)] !== "?";
        if (!isObjectKey) {
          found.push({
            name: word,
            line,
            deferred: arrows.length > 0 || stack.some((f) => f.fn),
            write: src[k] === "=" && src[k + 1] !== "=" && src[k + 1] !== ">",
          });
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return found;
}

/** Index of the last non-whitespace character before `i`, or -1. */
function lastMeaningfulIndex(src: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j;
}

/** Whether the `{` at `braceIdx` opens a function body rather than a block. */
function opensFunctionBody(src: string, braceIdx: number): boolean {
  const j = lastMeaningfulIndex(src, braceIdx);
  if (j < 0) return false;
  if (src[j] === ">" && src[j - 1] === "=") return true;
  if (src[j] !== ")") return false;

  let depth = 0;
  let k = j;
  for (; k >= 0; k--) {
    if (src[k] === ")") depth++;
    else if (src[k] === "(") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (k < 0) return false;

  const end = lastMeaningfulIndex(src, k);
  if (end < 0) return false;
  let m = end;
  while (m >= 0 && /[A-Za-z0-9_$]/.test(src[m])) m--;
  const head = src.slice(m + 1, end + 1);
  if (!head) return false;
  // Heads whose parenthesised clause is a condition, not a parameter list:
  // the `{` after one of these is a block that runs where it sits.
  return !["if", "for", "while", "switch", "catch", "with"].includes(head);
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
 * breaks a scanner built from `String.replace`. `ship.js:266` is
 * `/[;&|$\`\n\r"'\\(){}[\]<>!~*?#]/` — a backtick, a quote, an apostrophe and
 * four brackets inside one character class. Pairing those with unrelated ones
 * elsewhere in the file is exactly the defect
 * .claude/rules/checks-must-be-able-to-fail.md records against the previous
 * top-level-`require` guard, which deleted 61% of the file it was scanning.
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

  if (forbidden === 0) {
    console.log("  ✓ Sandbox globals: no unavailable globals referenced");
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
