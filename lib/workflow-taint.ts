/**
 * Which values in a `workflows/*.js` prompt builder came out of an agent, and
 * which of those reach a template literal without passing a sanitiser (#1103).
 *
 * ## Why this module exists rather than a list
 *
 * #1100 shipped a census holding "bare interpolations of agent-derived
 * bindings" at zero. It held zero, and three agent-derived branch bindings
 * were bare at the time it was written. The population was a hand-written
 * array of six names, enumerated by the same work that quoted the six — so it
 * contained exactly the sites that had been fixed. **A census whose membership
 * is written down by the fix cannot fail on the day it ships: it measures the
 * fix, not the property.** Its positive control caught a RENAME leaving the
 * sweep scanning for an absent symbol; nothing caught an OMISSION, and
 * omission is what happened.
 *
 * So membership is computed here. The caller may still say a derived name is
 * safe, but it has to say so about a name this module produced, which means a
 * new binding appears as an unclassified name rather than as silence.
 *
 * ## The derivation, and where it is deliberately imprecise
 *
 * Three steps, each a fixpoint:
 *
 * 1. **Spawners.** `agent` and `parallel` are the only injected globals that
 *    run an agent — that is `lib/workflow-test-harness.ts`'s list, not a guess,
 *    and the harness is what these files actually run against. Any function in
 *    the file whose body calls a spawner is itself a spawner, which picks up
 *    `timedAgent`, `briefedAgent`, `runImplement` and the rest without naming
 *    them. Naming the wrappers is the omission trap again, one level up.
 *
 * 2. **Seeds, at any scope.** A binding initialised from a spawner call holds
 *    agent text. Block scope matters here and the first draft of this analysis
 *    got it wrong: `priorBranchResult` is a top-level `let` whose agent value
 *    arrives from `priorResult`, a `const` inside an `if` block. Restricting
 *    the scan to top-level declarations missed the one binding #1103 was filed
 *    about.
 *
 * 3. **Members, at top level only.** A top-level binding whose assignment
 *    mentions a seed, or another member, is a member. Top-level because those
 *    are the bindings prompts interpolate; widening to every scope taints loop
 *    variables and then, within two hops, `WORK_DIR`. Measured: 200 names and
 *    490 sites, against 39 and 107 — an over-approximation that large is not a
 *    stricter check, it is an unreadable one.
 *
 * The result over-approximates on purpose. `projectConfig` is read back
 * through an agent, so everything derived from it is a member even though the
 * values originate in `rungate.json`. That is the right direction to be wrong
 * in: a name that does not belong costs one line of classification, a name
 * that is missing costs what #1103 cost.
 *
 * ## Why an AST
 *
 * The same argument `lib/ts-ast.ts` makes. The regex this replaces skipped any
 * line matching `/^\s*(\/\/|\*|\/\*)/` as "a comment" — and inside a template
 * literal, a line starting `*` or `//` is CONTENT. Several of these prompts
 * are markdown-ish and full of bullet lines. It also read `${commitDir}` and
 * not `${ commitDir }` or `${commitDir.path}`. In a tree a comment is absent
 * entirely, a prompt's bullet is a quasi, and all three spellings are one
 * `Identifier` inside one `TemplateLiteral` expression.
 */

import { parse } from "acorn";

/**
 * The injected globals that run an agent.
 *
 * From `lib/workflow-test-harness.ts`, which stubs exactly these to run a
 * workflow with no agents. If the runtime grows a third, the harness has to
 * stub it or every test of it hangs — so that file failing loudly is what
 * keeps this list honest, rather than this list being audited.
 */
export const AGENT_SPAWNING_GLOBALS: readonly string[] = ["agent", "parallel"];

/**
 * Calls that make a value safe to interpolate.
 *
 * `shellQuote` single-quotes for a shell. `heredocSafe` makes a value safe
 * inside the heredoc it is given the delimiter for. Both are named rather than
 * pattern-matched: a function is a sanitiser because someone decided it is,
 * and adding one here is the decision, visible in a diff.
 */
export const SANITISERS: readonly string[] = ["shellQuote", "heredocSafe"];

/**
 * Calls whose arguments reach the run's own output and never a shell.
 *
 * Checked as an enclosing CALL, not as a word to the left on the same line.
 * The regex this replaces did the latter, which exempted every line of a
 * multi-line literal after the one holding `log(` — and failed to exempt the
 * first line of a `log()` whose template began on the next.
 */
export const MESSAGE_CALLEES: readonly string[] = [
  "log",
  "refuse",
  "terminalFailure",
  "shipFailed",
  "warn",
  "Error",
];

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  // Workflows are executed as the body of an async function (#69), so they
  // legitimately carry top-level `return` and `await`.
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string" &&
    typeof (value as Node).start === "number"
  );
}

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) yield* walk(child);
    } else if (isNode(value)) {
      yield* walk(value);
    }
  }
}

/** `a.b.c()` and `a()` both root at `a`; anything else has no name. */
function calleeName(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "MemberExpression") return calleeName(node.object);
  return null;
}

/** Every `<name> = <expression>` in the tree, declaration or assignment. */
function bindings(tree: Node): { name: string; rhs: Node; topLevel: boolean }[] {
  const top = new Set<string>();
  for (const stmt of tree.body as Node[]) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const dec of stmt.declarations as Node[]) {
      if (isNode(dec.id) && dec.id.type === "Identifier") top.add(dec.id.name as string);
    }
  }
  const out: { name: string; rhs: Node; topLevel: boolean }[] = [];
  for (const node of walk(tree)) {
    if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.type === "Identifier" && isNode(node.init)) {
      const name = node.id.name as string;
      out.push({ name, rhs: node.init, topLevel: top.has(name) });
    }
    if (node.type === "AssignmentExpression" && isNode(node.left) && node.left.type === "Identifier" && isNode(node.right)) {
      const name = node.left.name as string;
      out.push({ name, rhs: node.right, topLevel: top.has(name) });
    }
  }
  return out;
}

/** Functions declared in the file, by name, including `const f = () => …`. */
function functionsByName(tree: Node): Map<string, Node> {
  const fns = new Map<string, Node>();
  for (const node of walk(tree)) {
    if (node.type === "FunctionDeclaration" && isNode(node.id)) fns.set(node.id.name as string, node);
    if (
      node.type === "VariableDeclarator" &&
      isNode(node.id) &&
      node.id.type === "Identifier" &&
      isNode(node.init) &&
      (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
    ) {
      fns.set(node.id.name as string, node.init);
    }
  }
  return fns;
}

export interface TaintedName {
  /** The binding. */
  name: string;
  /** How it came to hold agent text — the sentence a reader needs. */
  from: string;
}

/**
 * Top-level bindings in one workflow file that can hold text an agent wrote.
 *
 * Exported so a caller can show its working, and so the mutation cases can run
 * the derivation over a planted source rather than over the live tree.
 */
export function agentDerivedNames(source: string): Map<string, string> {
  const tree = parse(source, PARSE_OPTIONS) as unknown as Node;
  const fns = functionsByName(tree);
  const all = bindings(tree);

  const spawners = new Set<string>(AGENT_SPAWNING_GLOBALS);
  for (let again = true; again; ) {
    again = false;
    for (const [name, fn] of fns) {
      if (spawners.has(name)) continue;
      for (const node of walk(fn)) {
        if (node.type === "CallExpression" && spawners.has(calleeName(node.callee) ?? "")) {
          spawners.add(name);
          again = true;
          break;
        }
      }
    }
  }

  const seeds = new Set<string>();
  for (const { name, rhs } of all) {
    for (const node of walk(rhs)) {
      if (node.type === "CallExpression" && spawners.has(calleeName(node.callee) ?? "")) {
        seeds.add(name);
        break;
      }
    }
  }

  // A binding whose every assignment is a sanitiser call is sanitised, and
  // the name carries that forward. Without this, `const safeProofComment =
  // heredocSafe(proofComment, DELIM)` is a member and every use of it has to
  // be classified by hand — which is asking a reader to re-derive something
  // the call already said. Every assignment, not the first: a name sanitised
  // on one branch and not on another is not sanitised.
  const sanitised = new Set<string>();
  for (const { name } of all) {
    const assignments = all.filter(a => a.name === name);
    const allSanitised = assignments.every(
      a => a.rhs.type === "CallExpression" && SANITISERS.includes(calleeName(a.rhs.callee) ?? ""),
    );
    if (allSanitised) sanitised.add(name);
  }

  const members = new Map<string, string>();
  for (const { name, topLevel } of all) {
    if (topLevel && seeds.has(name) && !sanitised.has(name)) members.set(name, "an agent call");
  }
  for (let again = true; again; ) {
    again = false;
    for (const { name, rhs, topLevel } of all) {
      if (!topLevel || members.has(name) || sanitised.has(name)) continue;
      for (const node of walk(rhs)) {
        if (node.type !== "Identifier") continue;
        const ref = node.name as string;
        if (seeds.has(ref)) {
          members.set(name, `${ref}, an agent reply`);
          again = true;
          break;
        }
        if (members.has(ref)) {
          members.set(name, ref);
          again = true;
          break;
        }
      }
    }
  }
  return members;
}

export interface BareInterpolation {
  /** `workflows/ship.js:7170`. */
  where: string;
  /** The binding this expression reads. */
  name: string;
  /** The interpolated expression, as written. */
  expression: string;
}

/**
 * Every `${…}` in a template literal that reads an agent-derived binding and
 * is neither sanitised nor inside a message call.
 *
 * Prompt PROSE counts, deliberately. "This line is only prose" is a judgement
 * a checker cannot make, a prompt line is one edit away from being a command,
 * and `git -C '/path' <subcommand>` is better advice to an agent anyway.
 */
export function bareAgentInterpolations(relPath: string, source: string): BareInterpolation[] {
  const tree = parse(source, PARSE_OPTIONS) as unknown as Node;
  const members = agentDerivedNames(source);

  const messageRanges: [number, number][] = [];
  for (const node of walk(tree)) {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
    if (MESSAGE_CALLEES.includes(calleeName(node.callee) ?? "")) messageRanges.push([node.start, node.end]);
  }
  const inMessage = (at: number) => messageRanges.some(([from, to]) => at >= from && at <= to);

  const found: BareInterpolation[] = [];
  for (const node of walk(tree)) {
    if (node.type !== "TemplateLiteral") continue;
    for (const expr of node.expressions as Node[]) {
      if (expr.type === "CallExpression" && SANITISERS.includes(calleeName(expr.callee) ?? "")) continue;
      if (inMessage(expr.start)) continue;
      const names = new Set<string>();
      for (const sub of walk(expr)) {
        if (sub.type === "Identifier" && members.has(sub.name as string)) names.add(sub.name as string);
      }
      if (names.size === 0) continue;
      const line = source.slice(0, expr.start).split("\n").length;
      for (const name of names) {
        found.push({
          where: `${relPath}:${line}`,
          name,
          expression: source.slice(expr.start, expr.end).replace(/\s+/g, " ").slice(0, 80),
        });
      }
    }
  }
  return found;
}
