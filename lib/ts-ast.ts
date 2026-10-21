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
