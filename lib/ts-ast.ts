/**
 * Parse TypeScript source into an ESTree AST, for detectors that must not be
 * fooled by their own fixtures.
 *
 * ## Why an AST and not a regex (#968)
 *
 * The two detectors built on this module both replace a regex that was
 * narrower than its own subject, and both were narrower in the SAME way: the
 * regex described one spelling of a construct and the construct has several.
 * `/\}\s*,\s*([0-9_]+)\s*\)\s*;/` describes `}, 60_000);` and not
 * `}, TIMEOUT);`, `}, 60 * 1000);`, `}, 60_000)` without the semicolon, or
 * `}, { timeout: 60_000 });` — all four of which were MEASURED on bun 1.3.14
 * to raise the per-test budget exactly as the matched form does. Widening the
 * regex to `\}\s*,\s*([^)]+)\)` covers them, and also covers
 * `expect(() => { f(); }, "message").toThrow()`, which is not a timeout at
 * all. A detector widened until it refuses everything is the same failure
 * wearing the opposite sign.
 *
 * An AST ends the trade. "The third argument of a call rooted at `test`" is
 * exact in every spelling and matches nothing else, so widening costs no
 * precision rather than trading one for the other.
 *
 * It also closes the self-reference trap that
 * `test/scratch-paths-unique.test.ts` documents at length: a detector that
 * reads source text sees its own negative fixtures as hits, which is why that
 * file had to exclude itself from its own scan. In an AST, `"mkdirSync("`
 * inside a fixture is a `Literal`, and a call is a `CallExpression`. They are
 * different node types and no amount of comment-stripping is required to tell
 * them apart.
 *
 * ## Why transpile first
 *
 * acorn parses JavaScript. `lib/reachability.ts` uses it directly because its
 * subject is `workflows/*.js`. These detectors read `.ts` test files, so the
 * types come off first with `Bun.Transpiler`, which is in-process and adds no
 * dependency.
 *
 * The consequence to know: **positions refer to the TRANSPILED text, not the
 * original.** `parseTsModule` returns the transpiled source alongside the tree
 * for exactly that reason — slicing a node out of the original source would
 * silently read the wrong characters. Callers slice `js`, never their input.
 */

import { parse } from "acorn";

/** The minimum of an ESTree node this module's walk relies on. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/**
 * A parsed module: the tree, and the text its positions index into.
 *
 * `null` from `parseTsModule` means the source did not transpile or did not
 * parse. Every caller treats that as a REFUSAL rather than as "no findings" —
 * a parser that stopped parsing and a file that is clean produce the same
 * empty list, and that is the whole defect class #968 is about.
 */
export interface ParsedModule {
  tree: AstNode;
  /** The transpiled JavaScript. Node `start`/`end` index into THIS string. */
  js: string;
}

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AstNode).type === "string" &&
    typeof (value as AstNode).start === "number" &&
    typeof (value as AstNode).end === "number"
  );
}

/**
 * Transpile TypeScript to JavaScript and parse it, or `null` if either step
 * fails.
 */
export function parseTsModule(source: string): ParsedModule | null {
  let js: string;
  try {
    js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  } catch {
    return null;
  }
  try {
    return { tree: parse(js, PARSE_OPTIONS) as unknown as AstNode, js };
  } catch {
    return null;
  }
}

/**
 * Parse JavaScript that needs no type stripping, or `null` if it does not
 * parse.
 *
 * Distinct from `parseTsModule` for two reasons, both measured on
 * `workflows/*.js` (#1566):
 *
 *  - **`Bun.Transpiler` refuses all six of them**, on every loader — `js`,
 *    `jsx`, `ts` and `tsx` — while acorn parses the raw source without
 *    complaint. Routing `.js` through the transpiler turns six readable files
 *    into six refusals.
 *  - **Positions index the ORIGINAL text**, because nothing was rewritten. So
 *    a caller can report an exact line instead of reconciling by ordinal,
 *    which is the one real cost `parseTsModule` imposes.
 *
 * `js` is the input, unchanged, so the `ParsedModule` contract still holds:
 * node positions index `js`.
 */
export function parseJsModule(source: string): ParsedModule | null {
  try {
    return { tree: parse(source, PARSE_OPTIONS) as unknown as AstNode, js: source };
  } catch {
    return null;
  }
}

/** Every node in the tree, depth-first, parents before children. */
export function* walkNodes(node: AstNode): Generator<AstNode> {
  yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) yield* walkNodes(child);
    } else if (isNode(value)) {
      yield* walkNodes(value);
    }
  }
}

/**
 * The identifier a callee is rooted at, following member access and call
 * chains: `test` for `test`, `test.only`, `test.each([1])`,
 * `test.skip.each([1])`. `null` when the root is not a plain identifier.
 *
 * This is what makes "a per-test timeout" one question instead of a list of
 * spellings to keep current.
 */
export function calleeRoot(callee: unknown): string | null {
  let node = callee;
  for (;;) {
    if (!isNode(node)) return null;
    if (node.type === "Identifier") return String(node.name);
    if (node.type === "MemberExpression") node = node.object;
    else if (node.type === "CallExpression") node = node.callee;
    else if (node.type === "TaggedTemplateExpression") node = node.tag;
    else return null;
  }
}

/**
 * The property name accessed directly on the root identifier, or `null` when
 * the callee IS the root. `rootProperty(bt.test.only)` is `"test"`.
 *
 * Needed so a namespace import (`import * as bt from "bun:test"`, then
 * `bt.test(…)`) resolves to the same question as a named one, rather than
 * being a spelling the detector cannot see.
 */
export function rootProperty(callee: unknown): string | null {
  let node = callee;
  let property: string | null = null;
  for (;;) {
    if (!isNode(node)) return null;
    if (node.type === "Identifier") return property;
    if (node.type === "MemberExpression") {
      const prop = node.property as AstNode | undefined;
      // Computed access (`bt["test"]`) is deliberately not resolved — see
      // the UNRESOLVED boundary in lib/per-test-timeouts.ts.
      property = !node.computed && prop?.type === "Identifier" ? String(prop.name) : null;
      node = node.object;
    } else if (node.type === "CallExpression") node = node.callee;
    else if (node.type === "TaggedTemplateExpression") node = node.tag;
    else return null;
  }
}

/** What a module specifier was bound to, local name → how it was imported. */
export interface ImportBinding {
  /** The module specifier, e.g. `"bun:test"`. */
  module: string;
  /**
   * The name as the module exports it, or `"*"` for a namespace binding and
   * `"default"` for a default binding.
   */
  imported: string;
}

/**
 * Every import binding in the module, keyed by the LOCAL name.
 *
 * This is what closes the alias hole: `import { test as t } from "bun:test"`
 * binds local `t` to imported `test`, and a detector matching the local
 * identifier reports clean on its own subject.
 */
export function importBindings(tree: AstNode): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const node of walkNodes(tree)) {
    if (node.type !== "ImportDeclaration") continue;
    const src = node.source as AstNode | undefined;
    if (src?.type !== "Literal" || typeof src.value !== "string") continue;
    const module = src.value;
    for (const s of (node.specifiers ?? []) as AstNode[]) {
      const local = (s.local as AstNode | undefined)?.name;
      if (typeof local !== "string") continue;
      const imported =
        s.type === "ImportNamespaceSpecifier"
          ? "*"
          : s.type === "ImportDefaultSpecifier"
            ? "default"
            : String((s.imported as AstNode | undefined)?.name ?? local);
      out.set(local, { module, imported });
    }
  }
  return out;
}
