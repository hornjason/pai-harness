/**
 * Every construct in a test file that raises the per-test budget above the
 * one `bunfig.toml` declares (#968, from #804/#621).
 *
 * ## The subject, and why it is wider than one spelling
 *
 * `timeoutProximityViolations` in `lib/junit-checks.ts` compares each case's
 * measured duration against ONE number — the budget in force. A case that
 * carries a budget of its own leaves that reading two ways: it is never
 * killed at the global budget, so the `was KILLED` row cannot fire; and once
 * it runs past the global budget the proximity row cannot fire either, since
 * that row requires `ms < timeoutMs`. That is the mechanism by which #802's
 * `}, 60_000)` took the SC-6 scan out of the one instrument that would have
 * warned before the kill — the headline finding of #804.
 *
 * The detector this replaces, in `test/scan-budget.test.ts`, was
 * `/\}\s*,\s*([0-9_]+)\s*\)\s*;/g`. MEASURED on bun 1.3.14 against a
 * `--timeout 300` budget, with a case that sleeps 600ms: the no-override
 * control is killed at 300ms, and all five of these run to completion.
 *
 * | form | raises the budget | old regex |
 * |---|---|---|
 * | `}, 60_000);`            | yes | matched |
 * | `}, TIMEOUT);`           | yes | **missed** |
 * | `}, 60 * 1000);`         | yes | **missed** |
 * | `}, 60_000)` no `;`      | yes | **missed** |
 * | `}, { timeout: 5000 });` | yes | **missed** |
 * | `setDefaultTimeout(…)`   | yes | **missed** |
 *
 * So the guard against reintroducing #802's override was walked around by
 * extracting the number into a constant. Four of the five ways to write the
 * exact defect it was written for went unseen.
 *
 * ## What it reports, and what it deliberately does not
 *
 * It reports DECLARATIONS, not values. `}, TIMEOUT)` is reported as the text
 * `TIMEOUT`, with no attempt to resolve it — resolving constants would be a
 * second interpreter, and the question here is "does this case have a budget
 * of its own", which the declaration answers on its own. A declaration that
 * happens to equal the global budget is still a declaration, and still takes
 * the case out of the `was KILLED` row.
 *
 * `null` means the source did not parse. That is a REFUSAL, distinct from
 * `[]`, and the caller must keep them distinct — a parser that stopped
 * parsing reports exactly as clean as a file with no overrides, which is the
 * defect class #968 exists to close.
 */

import { type AstNode, calleeRoot, parseTsModule, walkNodes } from "./ts-ast";

/** The callees that declare a test case and accept a per-test budget. */
const CASE_ROOTS = new Set(["test", "it"]);

/**
 * The hooks that accept a budget of their own.
 *
 * Included because a hook that is killed is reported as `(unnamed)` in
 * bun's JUnit output — MEASURED on 1.3.14 — so work moved into a hook with
 * a budget of its own is as far out of `timeoutProximityViolations`'s reach
 * as a case with one. Same AST rule, different root set; leaving them out
 * would be a gap for the sake of a shorter list.
 */
const HOOK_ROOTS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

/** The bun:test call that raises the default budget for a whole file. */
const DEFAULT_TIMEOUT_FN = "setDefaultTimeout";

/** How a budget was raised. */
export type TimeoutKind =
  /** A third argument to a `test`/`it` call: `}, 60_000)`, `}, { timeout: 60_000 })`. */
  | "per-test"
  /** A second argument to a `beforeAll`/`afterEach`/… call. */
  | "hook"
  /** A `setDefaultTimeout(…)` call, which raises it for every case in the file. */
  | "file-default";

/** One construct that gives a case a budget other than the declared one. */
export interface TimeoutDeclaration {
  kind: TimeoutKind;
  /**
   * The source text of the declaration, as it appears in the TRANSPILED
   * module. Reported rather than evaluated — see the module comment.
   */
  expression: string;
  /** The case name when it is a string literal, else `null`. */
  caseName: string | null;
}

function literalString(node: unknown): string | null {
  const n = node as AstNode | undefined;
  if (n?.type === "Literal" && typeof n.value === "string") return n.value;
  return null;
}

/**
 * Every per-test and file-default budget declaration in `source`, in document
 * order. `null` when the source does not parse.
 */
export function perTestTimeoutDeclarations(source: string): TimeoutDeclaration[] | null {
  const parsed = parseTsModule(source);
  if (parsed === null) return null;

  const out: TimeoutDeclaration[] = [];
  for (const node of walkNodes(parsed.tree)) {
    if (node.type !== "CallExpression") continue;
    const args = node.arguments as AstNode[] | undefined;
    if (!Array.isArray(args)) continue;
    const root = calleeRoot(node.callee);

    if (root === DEFAULT_TIMEOUT_FN && args.length >= 1) {
      out.push({
        kind: "file-default",
        expression: parsed.js.slice(args[0]!.start, args[0]!.end),
        caseName: null,
      });
      continue;
    }

    // A per-test budget is the THIRD argument of a call rooted at test/it.
    // Rooted, so `test.only`, `test.skip`, `test.if(x)` and
    // `test.each([…])(…)` are all the same question rather than a list of
    // spellings. `test.each([1])` on its own has one argument and is not a
    // case declaration, so the arity check excludes it without naming it.
    if (root !== null && CASE_ROOTS.has(root) && args.length >= 3) {
      const arg = args[2]!;
      out.push({
        kind: "per-test",
        expression: parsed.js.slice(arg.start, arg.end),
        caseName: literalString(args[0]),
      });
      continue;
    }

    // A hook takes its budget as the SECOND argument, there being no name.
    if (root !== null && HOOK_ROOTS.has(root) && args.length >= 2) {
      const arg = args[1]!;
      out.push({
        kind: "hook",
        expression: parsed.js.slice(arg.start, arg.end),
        caseName: root,
      });
    }
  }
  return out;
}

/** One line per declaration, for a failure message that names the repair. */
export function describeTimeoutDeclarations(found: TimeoutDeclaration[]): string {
  return found
    .map(d =>
      d.kind === "file-default"
        ? `setDefaultTimeout(${d.expression}) raises the budget for every case in the file`
        : d.kind === "hook"
          ? `a ${d.caseName} hook declares a budget of ${d.expression}, and a killed hook is reported as \`(unnamed)\``
          : `${d.caseName === null ? "a case" : `"${d.caseName}"`} declares a per-test budget of ${d.expression}`,
    )
    .join("\n");
}
