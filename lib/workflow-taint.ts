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
export const SANITISERS: readonly string[] = ["shellQuote"];

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

/**
 * Every name a binding target introduces.
 *
 * Destructuring counts (#1113). `const { branch } = await agent(…)` binds
 * `branch` to agent text as surely as `const r = await agent(…)` binds `r`,
 * and a reader of `bindings()` that only emitted for `Identifier` saw neither
 * the name nor the hole where it should have been — a checker's silence,
 * which is the thing this module exists to stop. Nested patterns, array
 * patterns, defaults and rest elements all reach the same place.
 */
function boundNames(target: Node): string[] {
  if (target.type === "Identifier") return [target.name as string];
  const names: string[] = [];
  for (const node of walk(target)) {
    if (node.type === "Property" && isNode(node.value)) names.push(...boundNames(node.value));
    if (node.type === "RestElement" && isNode(node.argument)) names.push(...boundNames(node.argument));
    if (node.type === "AssignmentPattern" && isNode(node.left)) names.push(...boundNames(node.left));
    if (node.type === "ArrayPattern") {
      for (const el of node.elements as (Node | null)[]) if (el && isNode(el)) names.push(...boundNames(el));
    }
  }
  // A property VALUE that is a plain Identifier is the bound name; the KEY is
  // not, and `walk` reaches both, so the dedupe is not cosmetic.
  return [...new Set(names)];
}

/** Every `<name> = <expression>` in the tree, declaration or assignment. */
function bindings(tree: Node): { name: string; rhs: Node; topLevel: boolean }[] {
  const top = new Set<string>();
  for (const stmt of tree.body as Node[]) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const dec of stmt.declarations as Node[]) {
      if (isNode(dec.id)) for (const name of boundNames(dec.id)) top.add(name);
    }
  }
  const out: { name: string; rhs: Node; topLevel: boolean }[] = [];
  for (const node of walk(tree)) {
    if (node.type === "VariableDeclarator" && isNode(node.id) && isNode(node.init)) {
      for (const name of boundNames(node.id)) out.push({ name, rhs: node.init, topLevel: top.has(name) });
    }
    if (node.type === "AssignmentExpression" && isNode(node.left) && isNode(node.right)) {
      for (const name of boundNames(node.left)) out.push({ name, rhs: node.right, topLevel: top.has(name) });
    }
  }
  return out;
}

/** A name that holds agent text, and the byte range over which it does. */
interface TaintScope {
  name: string;
  why: string;
  from: number;
  to: number;
  /**
   * Byte spans inside `[from, to]` where the name means something else.
   *
   * A byte span is not a lexical scope. An inner function that re-binds the
   * name sits INSIDE the outer span, so without this it inherits the outer
   * verdict instead of shadowing it — and for an alias that means an inner
   * `quote` which is a plain string formatter is read as a sanitiser
   * everywhere the outer function's body reaches. Fail-open, and invisible.
   */
  holes?: [number, number][];
}

/** Is `at` inside the scope, and not inside one of its shadowed holes? */
function covers(scope: TaintScope, at: number): boolean {
  if (at < scope.from || at > scope.to) return false;
  return !(scope.holes ?? []).some(([from, to]) => at >= from && at <= to);
}

/**
 * Spans inside `fn` where `name` is re-bound and therefore is not `fn`'s.
 *
 * Nested parameters, nested `var`/`let`/`const`, and nested function
 * declarations all shadow. The function's own node is skipped, or every
 * parameter would shadow itself.
 */
function shadowsOf(fn: Node, name: string): [number, number][] {
  const holes: [number, number][] = [];
  for (const node of walk(fn)) {
    if (node === fn) continue;
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (isFn) {
      if (paramNames(node).includes(name)) holes.push([node.start, node.end]);
      if (isNode(node.id) && node.id.name === name) holes.push([node.start, node.end]);
      continue;
    }
    if (node.type === "VariableDeclarator" && isNode(node.id) && boundNames(node.id).includes(name)) {
      // From the declarator to the end of the function: a `const` rebinding
      // the name governs the rest of its block, and the block's end is the
      // nearest cheap over-approximation that stays FAIL-CLOSED.
      holes.push([node.start, fn.end]);
    }
  }
  return holes;
}

/**
 * Names in `fns` whose identifier is used anywhere other than as a callee.
 *
 * If a function's identifier is assigned, passed as an argument, returned or
 * stored, then `callsByFunction` cannot see every call site — and unanimity
 * over the subset you can see is not unanimity. The honest answer is to
 * decline to grant that function's parameters any alias at all, so this list
 * is consulted to FAIL CLOSED rather than to widen anything.
 */
function escapedFunctions(tree: Node, fns: Map<string, Node>): Set<string> {
  const referencedAsCallee = new Set<Node>();
  const declarationIds = new Set<Node>();
  const notAReference = new Set<Node>();

  for (const node of walk(tree)) {
    if (node.type === "CallExpression" && isNode(node.callee) && node.callee.type === "Identifier") {
      referencedAsCallee.add(node.callee);
    }
    if (isNode(node.id) && node.id.type === "Identifier") declarationIds.add(node.id);
    // `a.foo` and `{ foo: … }` mention the name without referring to the
    // binding, unless the lookup is computed.
    if (node.type === "MemberExpression" && !node.computed && isNode(node.property)) {
      notAReference.add(node.property);
    }
    if (node.type === "Property" && !node.computed && isNode(node.key)) notAReference.add(node.key);
  }

  const escaped = new Set<string>();
  for (const node of walk(tree)) {
    if (node.type !== "Identifier" || !fns.has(node.name as string)) continue;
    if (referencedAsCallee.has(node) || declarationIds.has(node) || notAReference.has(node)) continue;
    escaped.add(node.name as string);
  }
  return escaped;
}

/** Parameter names of a function node, in order; non-Identifier params are null. */
function paramNames(fn: Node): (string | null)[] {
  return (fn.params as Node[]).map(p => (p.type === "Identifier" ? (p.name as string) : null));
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
 * The whole analysis: which names hold agent text, and over what byte range.
 *
 * A range rather than a flat set because a helper's parameter is agent-derived
 * inside that helper and means nothing outside it. The top-level bindings get
 * the whole file.
 */
function analyse(source: string): { members: Map<string, string>; scopes: TaintScope[]; aliasScopes: TaintScope[]; seeds: Set<string> } {
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
  const scopes: TaintScope[] = [];
  const whole = { from: 0, to: source.length };

  /** Is `name` agent-derived at this position? */
  const taintedAt = (name: string, at: number) =>
    scopes.some(s => s.name === name && at >= s.from && at <= s.to);

  const addScope = (scope: TaintScope) => {
    if (scopes.some(s => s.name === scope.name && s.from === scope.from && s.to === scope.to)) {
      return false;
    }
    scopes.push(scope);
    return true;
  };

  for (const { name, topLevel } of all) {
    if (topLevel && seeds.has(name) && !sanitised.has(name)) {
      members.set(name, "an agent call");
      addScope({ name, why: "an agent call", ...whole });
    }
  }

  // Where a helper's parameter is, so argument taint can be given a range.
  const fnRanges = new Map<string, Node>(fns);

  // ── The quoter travels as an argument, so the alias is a sanitiser too ──
  //
  // `suiteCaptureCommand(projectRoot, testCommand, workDir, shellQuote)` with
  // `function suiteCaptureCommand(projectRoot, testCommand, workDir, quote)`
  // is this repo's idiom for a helper that must quote without importing
  // (#69). Inside that helper the sanitiser is called `quote`, and a check
  // that only knows the name `shellQuote` reads every one of its correctly
  // quoted sites as bare — the mirror image of the rename this all started
  // with, and it would bury the real findings in noise.
  // ── "inside that function" is the load-bearing clause (#1114) ──
  //
  // The first version of this held a flat `Set<string>` of parameter NAMES,
  // so the moment any function anywhere bound `shellQuote` to a parameter
  // called `quote`, the name `quote` was a sanitiser in all four files — and
  // an unrelated helper with its own `quote` parameter, bound to anything at
  // all, got a free pass on every interpolation while the census reported
  // clean. Latent rather than live when it was found (three functions take a
  // `quote`, all seven call sites pass the real one), which is exactly the
  // kind of hole that becomes live on somebody else's unrelated commit.
  //
  // So an alias is a RANGE, like every other fact in this module, and it is
  // UNANIMOUS: a function called twice, once with `shellQuote` and once with
  // something else, sanitises on neither. That is the rule `sanitised` above
  // already uses for assignments — "every assignment, not the first" — and
  // the asymmetry between them was the second half of the bug.
  //
  // The transitive arm stays but is a fixpoint rather than a single pass:
  // whether an alias reached a further parameter used to depend on where the
  // call sites happened to sit in `walk` order, so the same tree could
  // analyse two ways.
  const aliasScopes: TaintScope[] = [];
  const isAliasAt = (name: string, at: number) =>
    aliasScopes.some(a => a.name === name && covers(a, at));
  /** `shellQuote`, or a parameter that is one AT THIS POSITION. */
  const sanitisesAt = (name: string | null, at: number) =>
    !!name && (SANITISERS.includes(name) || isAliasAt(name, at));

  // Only an identifier in callee position is a call this analysis can see, and
  // only a function whose identifier never escapes has a call set it can
  // enumerate. Both halves fail closed.
  const escaped = escapedFunctions(tree, fnRanges);
  const callsByFunction = new Map<string, Node[]>();
  for (const node of walk(tree)) {
    if (node.type !== "CallExpression") continue;
    if (!isNode(node.callee) || node.callee.type !== "Identifier") continue;
    const name = node.callee.name as string;
    if (!fnRanges.has(name)) continue;
    callsByFunction.set(name, [...(callsByFunction.get(name) ?? []), node]);
  }

  for (let again = true; again; ) {
    again = false;
    for (const [fnName, fn] of fnRanges) {
      // Unanimity over a call set you cannot enumerate is not unanimity.
      if (escaped.has(fnName)) continue;
      const calls = callsByFunction.get(fnName) ?? [];
      // A function nobody calls tells us nothing about its parameters.
      if (calls.length === 0) continue;
      paramNames(fn).forEach((param, i) => {
        if (!param) return;
        // Exact range, not `isAliasAt`: a nested parameter of the same name
        // lands inside this one's span, and an `isAliasAt` guard would skip
        // evaluating it on its OWN call sites and let it inherit this
        // verdict. Only an identical span is the same fact already recorded.
        if (aliasScopes.some(a => a.name === param && a.from === fn.start && a.to === fn.end)) return;
        const everyCallSite = calls.every(call => {
          const arg = (call.arguments as Node[])[i];
          // A call site that omits the argument is a call site that does not
          // pass the quoter.
          return !!arg && arg.type === "Identifier" && sanitisesAt(arg.name as string, arg.start);
        });
        if (!everyCallSite) return;
        aliasScopes.push({
          name: param,
          why: `${fnName}()'s quoter`,
          from: fn.start,
          to: fn.end,
          holes: shadowsOf(fn, param),
        });
        again = true;
      });
    }
  }

  for (let again = true; again; ) {
    again = false;

    // Top-level bindings, as before.
    for (const { name, rhs, topLevel } of all) {
      if (!topLevel || members.has(name) || sanitised.has(name)) continue;
      for (const node of walk(rhs)) {
        if (node.type !== "Identifier") continue;
        const ref = node.name as string;
        const why = seeds.has(ref) ? `${ref}, an agent reply` : taintedAt(ref, node.start) ? ref : null;
        if (!why) continue;
        members.set(name, why);
        addScope({ name, why, ...whole });
        again = true;
        break;
      }
    }

    // ── The rename, and why a source-side list could not survive it (#1103) ──
    //
    // `workflowProbeCommand(commitDir)` with `function workflowProbeCommand(dir)`
    // puts an agent-derived path into a shell string under a name no list has
    // ever heard of, and nobody forgot anything: the value crossed a function
    // boundary and changed its name, which is what function boundaries are for.
    //
    // So taint crosses with it. A member passed as an argument taints the
    // parameter it binds to, over that function's body and no further.
    // Sanitisers and message calls are excluded — `shellQuote(commitDir)`
    // taints nothing, which is the whole point of calling it, and a parameter
    // the call site bound to `shellQuote` counts as one (`quote` in
    // `suiteCaptureCommand(…, shellQuote)`).
    //
    // ONE hop, from a top-level member only, and that is a measured choice
    // rather than a simplification. Counted on this tree:
    //
    //   members only, no parameters            38 names / 106 sites
    //   + one hop from a member  ← this        54 names / 137 sites
    //   + locals inside those helpers          88 names / 200 sites
    //   + transitive parameter-to-parameter   149 names / 343 sites
    //
    // The last two are almost entirely refusal-sentence builders. They are
    // not a stricter check at that size, they are a list nobody reads, and a
    // classification nobody reads is the failure this whole file is about.
    //
    // **The hole this leaves, stated rather than hidden:** a local declared
    // INSIDE a helper and derived from a tainted parameter is not followed —
    // `function f(dir) { const d = `${dir}/x`; return `cmd ${d}` }` reports
    // the `${dir}`, not the `${d}`. The first interpolation is still caught,
    // so the helper cannot go dark; a helper that only ever uses the derived
    // copy can.
    for (const node of walk(tree)) {
      if (node.type !== "CallExpression") continue;
      const callee = calleeName(node.callee);
      if (!callee || sanitisesAt(callee, node.start) || MESSAGE_CALLEES.includes(callee)) continue;
      const fn = fnRanges.get(callee);
      if (!fn) continue;
      const params = paramNames(fn);
      (node.arguments as Node[]).forEach((arg, i) => {
        const param = params[i];
        if (!param) return;
        // `helper(shellQuote(commitDir))` passes a quoted value, so the
        // parameter is not agent text. Without this, every helper that takes
        // an already-quoted path — which is the shape #1112 adds — would be
        // reported, and the fix for it would be to UNQUOTE the call site.
        let tainted = false;
        for (const sub of walk(arg)) {
          if (sub.type === "CallExpression" && sanitisesAt(calleeName(sub.callee), sub.start)) continue;
          if (sub.type === "Identifier" && members.has(sub.name as string)) {
            const insideSanitiser = [...walk(arg)].some(
              c =>
                c.type === "CallExpression" &&
                sanitisesAt(calleeName(c.callee), c.start) &&
                sub.start >= c.start &&
                sub.end <= c.end,
            );
            if (insideSanitiser) continue;
            tainted = true;
            break;
          }
        }
        if (!tainted) return;
        if (addScope({ name: param, why: `${callee}()'s argument ${i + 1}`, from: fn.start, to: fn.end })) {
          again = true;
        }
      });
    }

  }

  return { members, scopes, aliasScopes, seeds };
}

/**
 * Top-level bindings in one workflow file that can hold text an agent wrote.
 *
 * The named half of the analysis, kept as its own export because the floor
 * assertion in the test reads it: a derivation that stopped matching would
 * otherwise report a clean tree rather than an empty one.
 */
export function agentDerivedNames(source: string): Map<string, string> {
  return analyse(source).members;
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
  const { scopes, aliasScopes, seeds } = analyse(source);
  /**
   * `shellQuote(x)`, or a helper parameter that is the quoter AT THIS
   * POSITION — a name, a function, and a byte range, never a bare name
   * (#1114).
   */
  const sanitisedCall = (expr: Node) => {
    // Identifier callee only. `calleeName` roots `x.quote(…)` at `quote`, so
    // going through it accepted a METHOD that merely shares a name with the
    // quoter — and it is the same rule the message exemption below already
    // applies, so this is a consistency fix as much as a security one.
    if (!isNode(expr.callee) || expr.callee.type !== "Identifier") return false;
    const callee = expr.callee.name as string;
    if (SANITISERS.includes(callee)) return true;
    return aliasScopes.some(a => a.name === callee && covers(a, expr.start));
  };
  const taintedAt = (name: string, at: number) =>
    scopes.some(s => s.name === name && at >= s.from && at <= s.to);

  /**
   * Identifiers in `expr` that are NOT inside a sanitiser call.
   *
   * `${probe(shellQuote(commitDir))}` is not a bare interpolation of
   * `commitDir`: the only thing reaching the string is what `shellQuote`
   * returned. Checking only the outermost call missed this, and the cheapest
   * way to silence the resulting report would have been to unquote the call
   * site — a check that pays for green with the defect it exists to find.
   */
  const unsanitisedIdentifiers = (expr: Node): Node[] => {
    const safeRanges: [number, number][] = [];
    for (const sub of walk(expr)) {
      if (sub.type !== "CallExpression" || !sanitisedCall(sub)) continue;
      // The ARGUMENTS the quoter consumes, not the whole call expression.
      // `shellQuote` returns a quoted copy of what it is given; an identifier
      // somewhere else in the same expression — a computed callee, say — is
      // not something it ever saw, and whitelisting the entire span
      // suppressed it anyway.
      for (const arg of sub.arguments as Node[]) if (isNode(arg)) safeRanges.push([arg.start, arg.end]);
    }
    return [...walk(expr)].filter(
      sub =>
        sub.type === "Identifier" &&
        !safeRanges.some(([from, to]) => sub.start >= from && sub.end <= to),
    );
  };

  // ── The message exemption is an ARGUMENT, not a byte range (#1113) ──
  //
  // `log(\`… ${f(\`git -C ${dir} x\`)} …\`)` has a command inside it, and a
  // range test exempts the lot because the inner literal sits between the
  // outer call's first and last byte. Only the literals the call receives
  // DIRECTLY are messages. `callee.type === "Identifier"` as well, so
  // `log.foo(…)` and `logger.warn(…)` are not this exemption — `calleeName`
  // walks a member chain to its root on purpose, and that is the wrong
  // question here.
  const messageLiterals = new Set<Node>();
  const messageConcats = new Set<Node>();
  for (const node of walk(tree)) {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
    if (!isNode(node.callee) || node.callee.type !== "Identifier") continue;
    if (!MESSAGE_CALLEES.includes(node.callee.name as string)) continue;
    for (const arg of node.arguments as Node[]) {
      if (arg.type === "TemplateLiteral") messageLiterals.add(arg);
      // `log('a: ' + \`b ${x}\`)` is still one message.
      if (arg.type === "BinaryExpression") {
        messageConcats.add(arg);
        for (const sub of walk(arg)) {
          if (sub.type === "TemplateLiteral") messageLiterals.add(sub);
          if (sub.type === "BinaryExpression") messageConcats.add(sub);
        }
      }
    }
  }

  const found: BareInterpolation[] = [];
  const record = (at: number, name: string, expr: Node) => {
    const where = `${relPath}:${source.slice(0, at).split("\n").length}`;
    if (found.some(f => f.where === where && f.name === name)) return;
    found.push({
      where,
      name,
      expression: source.slice(expr.start, expr.end).replace(/\s+/g, " ").slice(0, 80),
    });
  };

  // ── A template literal is not the only way to build a string (#1113) ──
  //
  // `'git -C ' + workDir + ' status'` reaches the same shell and was
  // invisible, which is a sink SHAPE the scanner could not see rather than a
  // value it decided was safe — the same class of silence as the comment
  // regex and the destructuring. Measured at 18 sites and 7 names on this
  // tree, every one of them a name the template scan already reports, so it
  // costs no new classifications and closes the shape.
  //
  // A string literal has to be in the expression: `a + b` on two numbers is
  // arithmetic, and `${count + 1}` is not a command.
  for (const node of walk(tree)) {
    if (node.type !== "BinaryExpression" || node.operator !== "+") continue;
    if (messageConcats.has(node)) continue;
    let hasStringLiteral = false;
    const names = new Set<string>();
    for (const sub of walk(node)) {
      if (sub.type === "Literal" && typeof sub.value === "string") hasStringLiteral = true;
    }
    for (const sub of unsanitisedIdentifiers(node)) {
      const ref = sub.name as string;
      if (seeds.has(ref) || taintedAt(ref, sub.start)) names.add(ref);
    }
    if (!hasStringLiteral) continue;
    for (const name of names) record(node.start, name, node);
  }

  for (const node of walk(tree)) {
    if (node.type !== "TemplateLiteral") continue;
    if (messageLiterals.has(node)) continue;
    for (const expr of node.expressions as Node[]) {
      if (expr.type === "CallExpression" && sanitisedCall(expr)) continue;
      const names = new Set<string>();
      for (const sub of unsanitisedIdentifiers(expr)) {
        const ref = sub.name as string;
        // A SEED is reported wherever it is interpolated, whatever its scope.
        // Members are top-level only — measured, and the 200/490 count that
        // justifies that restriction is about PROPAGATION, which is a
        // different question from whether to report a value that came
        // straight out of an agent call (#1113).
        if (seeds.has(ref) || taintedAt(ref, sub.start)) names.add(ref);
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
