/**
 * Which binding does the identifier at a write site resolve to? (#1566)
 *
 * ## Why this module exists
 *
 * #1552 shipped a spec-write sweep whose target resolution was a file-global
 * name scan (`initialiserOf`). The AI review on #1557 found it reading the
 * FIRST same-named declaration in the file; the fix taken there was a UNION
 * over all same-named declarations. Both are name scans, and the question is
 * not a name question — it is "which binding does this identifier resolve to",
 * which is scope and position. A name scan answers it correctly only when the
 * file happens to contain one binding of that name.
 *
 * The direction of the error matters more than its size. The first-match scan
 * was wrong in the PERMISSIVE direction: a file with `const filePath =
 * join(outDir, "report.json")` in one function and `const filePath =
 * join(specsDir, "NEW-SPEC.md")` in another reads the real spec write through
 * the report path, matches nothing, and reports CLEAN. That is the exact miss
 * #1552 exists to end, rebuilt inside the detector meant to catch it.
 *
 * This repository has paid for this lesson twice already — #968 (a regex
 * narrower than its own subject) and #1555 (a brace-depth token scan wrong
 * five times across four revisions, with two shapes still wrong in merged
 * code). Both ended at an AST. This is the same ending, reached one patch
 * earlier.
 *
 * ## The parser, and why not TypeScript's
 *
 * `acorn`, through `lib/ts-ast.ts` — this repository's existing binding for
 * "a detector that must not be fooled by its own fixtures". `typescript` is a
 * **devDependency** and `lib/` is published (`files[]` in package.json), so a
 * published module importing it resolves here and breaks at
 * `bunx rungate@<version>` on a consumer's CI runner, where nothing in this
 * suite would see it. `test/package-closure.test.ts` is the check for that
 * class. `acorn` is a runtime dependency.
 *
 * ## The consequence that this module has to carry
 *
 * `parseTsModule` transpiles the types off before parsing, and
 * `Bun.Transpiler` drops comments and blank lines. MEASURED on bun 1.3.14: an
 * 11-line fixture transpiles to 6 lines, and the offset of the same call moves
 * from 152 to 93. **Node positions index the transpiled text and cannot be
 * converted to a line in the original.** `resolveLines` therefore maps them by
 * ordinal against the original text and REFUSES — reporting `line: null`
 * rather than a number — when the two counts disagree. A wrong line in a
 * violation message sends the next reader to the wrong place, which is worse
 * than no line.
 *
 * ## WHAT THIS DOES NOT RESOLVE
 *
 * Stated because an unstated boundary reads as coverage, and a clean report
 * from an incomplete detector is worse than no detector (#968's own thesis).
 * Each of these is reported as UNRESOLVED with its reason rather than
 * silently resolving to something plausible:
 *
 *  - **A parameter.** The value comes from callers; this reading is per-module.
 *  - **An import.** The value is in another module. Not followed, by design —
 *    the alternative is an import graph, which this is not.
 *  - **A destructured binding.** `const { p } = cfg` binds a property of a
 *    value this module does not evaluate.
 *  - **A declaration with no initialiser** that is never assigned.
 *  - **A loop binding that reassigns an existing identifier** — `for (p of
 *    paths) writeFileSync(p, …)`, where `p` is declared elsewhere. The write
 *    is still found; only the VALUE is unread, so the site reads as
 *    unresolved rather than as clean. `for (const p of …)` is a declaration
 *    and is resolved normally.
 *

 * And one case is deliberately OVER-approximated rather than refused: a
 * binding that is REASSIGNED is read as the union of its initialiser and every
 * assigned expression. Over-reporting costs one classified line; under-
 * reporting costs an unguarded writer nobody can see.
 */
import {
  type AstNode,
  calleeRoot,
  importBindings,
  parseJsModule,
  parseTsModule,
  rootProperty,
  walkNodes,
} from "./ts-ast";

/**
 * Everything that can put bytes on disk, excluding the `Bun.write` spelling,
 * which is a member expression and is matched separately.
 */
export const SIMPLE_PRIMITIVES = [
  "writeFileSync",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "renameSync",
  "copyFileSync",
  "truncateSync",
] as const;

/** Primitives that write their SECOND argument rather than their first. */
const WRITTEN_ARGUMENT: Record<string, number> = { renameSync: 1, copyFileSync: 1 };

/**
 * What counts as a target naming a derived document.
 *
 * Anchored at a token boundary rather than matched as a bare substring, so
 * `quadrant` and `inspectPath` are not derived documents while `adrDir` and
 * `specsDir` are. `adr` is in deliberately — see #1548.
 */
export const SPEC_TARGET = /(?:^|[^A-Za-z0-9])(spec|adr)/i;

/** Maximum links of a `const a = f(b); const b = f(c)` chain the view follows. */
export const EXPANSION_DEPTH = 3;

/**
 * Identifiers that are ambient rather than bound in the module. Not reported
 * as unresolved: "I could not find a binding for `process`" is noise, and a
 * noisy unresolved list is one nobody reads.
 */
const AMBIENT = new Set([
  "Bun", "process", "JSON", "Math", "String", "Number", "Boolean", "Array",
  "Object", "Date", "RegExp", "Error", "console", "require", "globalThis",
  "__dirname", "__filename", "undefined", "NaN", "Infinity",
]);

type BindingKind =
  | "const" | "let" | "var" | "param" | "import"
  | "destructured" | "function" | "class" | "catch";

/** Why an identifier carries no readable value. */
type UnresolvedReason = "parameter" | "import" | "destructured" | "no-initialiser" | "not-found";

interface Binding {
  kind: BindingKind;
  /** Initialiser source text, or `null` when there is none to read. */
  init: string | null;
  /**
   * Expressions assigned to this binding after declaration, as NODES.
   *
   * Stored as nodes rather than as source text so the expansion can follow
   * through them the way it follows an initialiser. Holding the text alone
   * meant `p = q` appended the characters `q` to `view` and never resolved
   * `q` — one of two symmetric inputs reaching the frontier (#1582). The
   * text is derived at the read site, so there is no second copy to desync.
   */
  assigned: AstNode[];
  /** Position of the declaration in the TRANSPILED text. */
  declStart: number;
}

interface Scope {
  parent: Scope | null;
  isFunction: boolean;
  start: number;
  end: number;
  bindings: Map<string, Binding>;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const BLOCK_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "CatchClause",
  "SwitchStatement",
]);

function isNodeLike(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AstNode).type === "string" &&
    typeof (value as AstNode).start === "number"
  );
}

/** Child nodes of `node`, in document order. */
function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const c of value) if (isNodeLike(c)) out.push(c);
    } else if (isNodeLike(value)) {
      out.push(value);
    }
  }
  return out;
}

/** Every name a binding pattern introduces, with whether it was destructured. */
function patternNames(node: AstNode | undefined, destructured: boolean): [string, boolean][] {
  if (!node) return [];
  switch (node.type) {
    case "Identifier":
      return [[String(node.name), destructured]];
    case "ObjectPattern":
      return ((node.properties ?? []) as AstNode[]).flatMap((p) =>
        p.type === "RestElement"
          ? patternNames(p.argument as AstNode, true)
          : patternNames(p.value as AstNode, true),
      );
    case "ArrayPattern":
      return ((node.elements ?? []) as (AstNode | null)[]).flatMap((e) =>
        e ? patternNames(e, true) : [],
      );
    case "AssignmentPattern":
      return patternNames(node.left as AstNode, destructured);
    case "RestElement":
      return patternNames(node.argument as AstNode, destructured);
    default:
      return [];
  }
}

/**
 * Build the scope tree, with every declaration attached to the scope that
 * actually holds it: `var` and parameters to the nearest FUNCTION scope,
 * `let`/`const`/`class` to the nearest block, imports to the module scope.
 */
function buildScopes(tree: AstNode, js: string): { root: Scope; scopeOf: Map<AstNode, Scope> } {
  const root: Scope = {
    parent: null,
    isFunction: true,
    start: tree.start,
    end: tree.end,
    bindings: new Map(),
  };
  const scopeOf = new Map<AstNode, Scope>();

  const text = (n: AstNode | undefined | null): string | null =>
    n ? js.slice(n.start, n.end) : null;

  const functionScope = (s: Scope): Scope => {
    let cur: Scope = s;
    while (!cur.isFunction && cur.parent) cur = cur.parent;
    return cur;
  };

  const bindName = (scope: Scope, name: string, binding: Binding) => {
    // First declaration wins within a scope. A redeclaration of the same name
    // in the same scope is either a `var` repeat or invalid code; either way
    // the later one does not create a second resolution target.
    if (!scope.bindings.has(name)) scope.bindings.set(name, binding);
  };

  const visit = (node: AstNode, scope: Scope): void => {
    let current = scope;

    if (FUNCTION_TYPES.has(node.type)) {
      current = {
        parent: scope,
        isFunction: true,
        start: node.start,
        end: node.end,
        bindings: new Map(),
      };
      for (const p of (node.params ?? []) as AstNode[]) {
        for (const [name] of patternNames(p, false)) {
          bindName(current, name, { kind: "param", init: null, assigned: [], declStart: node.start });
        }
      }
    } else if (BLOCK_TYPES.has(node.type)) {
      current = {
        parent: scope,
        isFunction: false,
        start: node.start,
        end: node.end,
        bindings: new Map(),
      };
      if (node.type === "CatchClause" && node.param) {
        for (const [name] of patternNames(node.param as AstNode, false)) {
          bindName(current, name, { kind: "catch", init: null, assigned: [], declStart: node.start });
        }
      }
    }
    scopeOf.set(node, current);

    if (node.type === "VariableDeclaration") {
      const kind = String(node.kind) as "const" | "let" | "var";
      const target = kind === "var" ? functionScope(current) : current;
      for (const d of (node.declarations ?? []) as AstNode[]) {
        const init = text(d.init as AstNode | undefined);
        for (const [name, destructured] of patternNames(d.id as AstNode, false)) {
          bindName(target, name, {
            kind: destructured ? "destructured" : kind,
            init: destructured ? null : init,
            assigned: [],
            declStart: d.start,
          });
        }
      }
    } else if (node.type === "FunctionDeclaration" && node.id) {
      bindName(scope, String((node.id as AstNode).name), {
        kind: "function", init: null, assigned: [], declStart: node.start,
      });
    } else if (node.type === "ClassDeclaration" && node.id) {
      bindName(scope, String((node.id as AstNode).name), {
        kind: "class", init: null, assigned: [], declStart: node.start,
      });
    } else if (node.type === "ImportDeclaration") {
      for (const s of (node.specifiers ?? []) as AstNode[]) {
        const local = (s.local as AstNode | undefined)?.name;
        if (typeof local === "string") {
          bindName(root, local, { kind: "import", init: null, assigned: [], declStart: node.start });
        }
      }
    }

    for (const c of children(node)) visit(c, current);
  };

  visit(tree, root);
  return { root, scopeOf };
}

/**
 * Resolve `name` as seen from `pos`.
 *
 * Walks the scope chain outward from the use site. Declaration position is
 * respected for `let`/`const`, but ONLY while no function boundary has been
 * crossed: `function f() { return p } const p = 1` is legal and `p` does
 * resolve, because `f` runs after the declaration is evaluated. Applying the
 * positional rule across a function boundary would wrongly refuse it.
 */
function lookup(from: Scope, name: string, pos: number): Binding | null {
  let scope: Scope | null = from;
  let crossedFunction = false;
  /**
   * A binding the positional rule skipped. Position is used to PREFER one
   * binding over another, never to refuse resolution outright: a reference
   * that precedes its own `const` is broken code, and reading it anyway
   * over-reports, while refusing it reads as clean. The sweep's allowed
   * direction is over-reporting — MEASURED, this is what the round-3
   * `const outPath = mask + tail` fixture needs, where every link of the
   * chain is declared after its use.
   */
  let deferred: Binding | null = null;
  while (scope) {
    const b = scope.bindings.get(name);
    if (b) {
      const temporalDeadZone =
        !crossedFunction && (b.kind === "const" || b.kind === "let") && b.declStart > pos;
      if (!temporalDeadZone) return b;
      deferred ??= b;
    }
    if (scope.isFunction) crossedFunction = true;
    scope = scope.parent;
  }
  return deferred;
}

/** Every value-reference identifier under `node` — not property names or callees. */
function valueIdentifiers(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const skip = new Set<AstNode>();
  for (const n of walkNodes(node)) {
    if (n.type === "MemberExpression" && !n.computed) skip.add(n.property as AstNode);
    if (n.type === "CallExpression" || n.type === "NewExpression") skip.add(n.callee as AstNode);
    if (n.type === "Property" && !n.computed) skip.add(n.key as AstNode);
    // `import.meta` is a MetaProperty: two Identifier nodes that reference no
    // binding at all. Without this they resolve to nothing and are reported as
    // `import: not-found` / `meta: not-found` — a hole invented by the walker,
    // in the one construct every script in this repo uses to find its own
    // directory. `__dirname`, its CJS equivalent, is already in AMBIENT.
    if (n.type === "MetaProperty") {
      skip.add(n.meta as AstNode);
      skip.add(n.property as AstNode);
    }
  }
  for (const n of walkNodes(node)) {
    if (n.type === "Identifier" && !skip.has(n)) out.push(n);
  }
  return out;
}

/** One write-primitive call site, as the tree sees it. */
export interface AstWriteSite {
  /** Canonical primitive name, e.g. `writeFileSync` or `Bun.write`. */
  primitive: string;
  /** The callee's source text as written, e.g. `fs.writeFileSync` or `wfs`. */
  callee: string;
  /** The written argument's source text, whitespace-collapsed. */
  target: string;
  /** `target` plus every initialiser the resolver could reach from it. */
  view: string;
  /** `name: reason` for each identifier in the target carrying no value. */
  unresolved: string[];
  /**
   * True when the sweep cannot determine this target's path, so it must not
   * claim the site is not a spec write. Two causes:
   *
   *  - the target has an unresolved identifier at ANY depth — some component
   *    of the path is invisible. A partial reading like
   *    `join(root, "report.json")` IS one of these: the filename is readable
   *    and the directory is not, and the directory is the half that decides
   *    whether the write lands under `specs/`. An earlier predicate cleared
   *    those on the strength of the visible literal (#1584);
   *  - the target depends on a binding whose value set is not closed, so the
   *    value at the write is not what its initialiser says. See `reassignable`.
   */
  opaque: boolean;
  /**
   * True when `view` is a LOWER BOUND: some identifier in the target
   * contributed a value while its complete set of values is not knowable here.
   * The sweep can see some of what this write can aim at and cannot see all of
   * it, so a reading of "not a spec" is not available.
   *
   * This is the property that replaced enumerating assignment spellings. The
   * first fix for the #1569 review finding widened the tracker from `x = …` to
   * destructuring patterns; MEASURED against six spellings, three were still
   * missed — a default inside a pattern, `for ([p] of …)` and `for (p of …)`.
   * Widening again just moves the boundary.
   *
   * A value set is complete only when the declaration established it and
   * nothing can change it afterwards: a `const` with an initialiser. That is
   * the language's own guarantee rather than a list this file has to keep
   * current, so a new assignment spelling nobody enumerated changes no answer.
   *
   * It has been wrong in both directions and both are recorded here, because
   * the shape of the error is the point:
   *
   *  - It first asked `kind === "let" || kind === "var"`, which is a statement
   *    about how the name was INTRODUCED and not about what can be seen. A
   *    `param`, a `catch` binding and a destructured one are assignable too,
   *    and one conditional assignment to any of them read as a complete
   *    resolution (#1569 round 4).
   *  - An earlier draft of this comment put the cost at 3 sites. That came
   *    from a probe which only inspected module-level declarations, so it
   *    could not see a parameter or a function-local — the instrument's scope
   *    was narrower than the question it was quoted as answering.
   *
   * MEASURED on this tree: 6 of 131 write sites, unchanged across both
   * corrections — no parameter or destructured binding here is reassigned, so
   * the widened reading costs nothing and closes a reachable hole. The flag
   * propagates through the expansion, so a locally-`const` target counts when
   * an identifier inside it is not complete. Those 6 are declared in
   * `REASSIGNABLE_TARGETS` rather than silently cleared.
   */
  reassignable: boolean;
  /** Offset of the call in the TRANSPILED text. Never an original-file offset. */
  start: number;
}

/** Does this site's resolved view name a derived document? */
export function specTargetingOf(site: AstWriteSite): boolean {
  return SPEC_TARGET.test(site.view);
}

/**
 * Every write-primitive call site in `source`.
 *
 * Throws rather than returning `[]` when the source does not parse. A parser
 * that stopped parsing and a file that is clean produce the same empty list,
 * which is the first shape in `.claude/rules/checks-must-be-able-to-fail.md`.
 */
export function writeSitesIn(
  source: string,
  opts: { loader?: "ts" | "js" } = {},
): AstWriteSite[] {
  // `.js` is parsed directly: it has no types to strip, `Bun.Transpiler`
  // refuses every `workflows/*.js` in this tree on all four loaders, and
  // skipping the rewrite makes node positions index the original text.
  const parsed = opts.loader === "js" ? parseJsModule(source) : parseTsModule(source);
  if (!parsed) {
    throw new Error(
      "writeSitesIn: UNMEASURED — the source did not transpile or did not parse, so no write " +
        "sites were read. This is not an empty list of findings.",
    );
  }
  const { tree, js } = parsed;
  const { root, scopeOf } = buildScopes(tree, js);
  const imports = importBindings(tree);

  // Attach assignments to the binding they actually target, so a reassignment
  // is read as a union rather than ignored.
  for (const node of walkNodes(tree)) {
    if (node.type !== "AssignmentExpression") continue;
    const left = node.left as AstNode | undefined;
    const right = node.right as AstNode | undefined;
    if (!left || !right) continue;
    // Every name the left-hand side binds, not just a bare `x = …`. A
    // destructuring reassignment — `[p] = […]` or `({ p } = …)` — targets an
    // already-declared identifier, and reading only `Identifier` dropped it
    // silently, so the binding resolved to its initialiser alone. That is the
    // permissive direction, inside the mechanism added to stop it (#1569).
    //
    // The whole right-hand side is attributed to each name rather than the
    // element that actually reaches it: which property lands where needs
    // evaluation, and over-attributing is the allowed direction.
    for (const [name] of patternNames(left, false)) {
      const binding = lookup(scopeOf.get(node) ?? root, name, node.start);
      if (binding) binding.assigned.push(right);
    }
  }

  /** The primitive this callee denotes, or null. */
  const primitiveOf = (callee: AstNode, scope: Scope, pos: number): string | null => {
    if (callee.type === "Identifier") {
      const name = String(callee.name);
      if ((SIMPLE_PRIMITIVES as readonly string[]).includes(name)) return name;
      // An aliased import: `import { writeFileSync as wfs } from "fs"`.
      const imported = imports.get(name)?.imported;
      if (imported && (SIMPLE_PRIMITIVES as readonly string[]).includes(imported)) return imported;
      // A local alias: `const w = writeFileSync`.
      const binding = lookup(scope, name, pos);
      const init = binding?.init?.trim();
      if (init && (SIMPLE_PRIMITIVES as readonly string[]).includes(init)) return init;
      return null;
    }
    if (callee.type === "MemberExpression" && !callee.computed) {
      const prop = callee.property as AstNode | undefined;
      if (prop?.type !== "Identifier") return null;
      const name = String(prop.name);
      if (calleeRoot(callee) === "Bun" && rootProperty(callee) === "write") return "Bun.write";
      if ((SIMPLE_PRIMITIVES as readonly string[]).includes(name)) return name;
      return null;
    }
    return null;
  };

  const sites: AstWriteSite[] = [];
  for (const node of walkNodes(tree)) {
    if (node.type !== "CallExpression") continue;
    const callee = node.callee as AstNode | undefined;
    if (!callee) continue;
    const scope = scopeOf.get(node) ?? root;
    const primitive = primitiveOf(callee, scope, node.start);
    if (!primitive) continue;

    const args = (node.arguments ?? []) as AstNode[];
    const index = WRITTEN_ARGUMENT[primitive] ?? 0;
    const arg = args[index];
    const target = arg ? js.slice(arg.start, arg.end).replace(/\s+/g, " ") : "";

    const unresolved: string[] = [];
    let view = target;
    let reassignable = false;

    if (arg) {
      // Expand identifiers transitively, resolving each from ITS OWN scope.
      //
      // The dedup is keyed on the BINDING, not on the name. Keying it on the
      // name is the same defect as `initialiserOf`, one level further in: two
      // distinct bindings sharing a name on one chain — a local reached first,
      // the module-level one holding the path reached later — and the second
      // is marked done by the first and never expanded. Found by the AI review
      // on #1569 and reproduced as shape 9. An unresolvable identifier has no
      // binding to key on, so those are deduped by name separately.
      const seen = new Set<Binding>();
      const noted = new Set<string>();

      // Record an identifier the resolver could not read a value for, AT ANY
      // DEPTH. The push used to be gated on `depth === 0`, so a hole reached
      // by FOLLOWING the chain — `const p = join(z, "report.json")` with `z` a
      // parameter — left no trace: the site reported an EMPTY unresolved list,
      // byte-identical to a fully resolved reading. A target the resolver
      // could not follow must never read like one it followed and cleared.
      //
      // The depth gate's intent was readability, and the suffix keeps it: a
      // nested hole is still tellable from a top-level one, which is what the
      // depth gate bought at the price of dropping it entirely (#1584).
      const note = (name: string, reason: UnresolvedReason, depth: number): void => {
        const entry = depth === 0 ? `${name}: ${reason}` : `${name}: ${reason} (nested)`;
        if (noted.has(entry)) return;
        noted.add(entry);
        unresolved.push(entry);
      };

      let frontier = valueIdentifiers(arg);
      for (let depth = 0; depth < EXPANSION_DEPTH && frontier.length > 0; depth++) {
        const next: AstNode[] = [];
        for (const id of frontier) {
          const name = String(id.name);
          if (AMBIENT.has(name)) continue;
          const idScope = scopeOf.get(id) ?? scope;
          const binding = lookup(idScope, name, id.start);

          if (!binding) {
            note(name, "not-found", depth);
            continue;
          }
          if (seen.has(binding)) continue;
          seen.add(binding);

          // A value set is COMPLETE only when the declaration established it
          // and nothing can change it afterwards: a `const` with an
          // initialiser. That is the language's own guarantee, so it needs no
          // list of binding kinds and no list of assignment spellings.
          //
          // An earlier draft asked `kind === "let" || kind === "var"`, which
          // is a statement about how the name was INTRODUCED rather than about
          // what the sweep can see. A `param`, a `catch` binding and a
          // destructured one are assignable too (#1569 round 4).
          const complete = binding.kind === "const" && binding.init !== null;

          // The declaration gave no value: say so, and say so whether or not
          // an assignment later supplied one. Recording the reason only on an
          // empty value list meant ONE conditional assignment erased it, and a
          // parameter whose incoming value is unknowable read as fully
          // resolved from the one branch that happened to be visible.
          if (binding.init === null) {
            const reason: UnresolvedReason =
              binding.kind === "param" || binding.kind === "catch"
                ? "parameter"
                : binding.kind === "import"
                  ? "import"
                  : binding.kind === "destructured"
                    ? "destructured"
                    : "no-initialiser";
            note(name, reason, depth);
          }

          const values = [
            binding.init,
            ...binding.assigned.map((n) => js.slice(n.start, n.end)),
          ].filter((v): v is string => typeof v === "string" && v.length > 0);
          // Nothing readable at all. The reason is already recorded above; the
          // site makes no claim about this identifier, so there is no lower
          // bound to flag.
          if (values.length === 0) continue;

          // Values exist and the set is not closed, so `view` is a LOWER
          // BOUND — the sweep can see some of what this write can aim at and
          // cannot see all of it. That is the state the chokepoint's green
          // reading must not absorb.
          if (!complete) reassignable = true;

          for (const v of values) {
            view += ` ${v}`;
          }
          // Follow the chain: re-parse each value's identifiers from the
          // position they were written at, not the write site's.
          //
          // BOTH edges, which is the whole of #1582. The frontier was fed from
          // the initialiser alone, so `p = q` appended the text `q` to `view`
          // and stopped — a target reassigned to an identifier holding a spec
          // path did not resolve. An initialiser and an assignment are
          // symmetric inputs to the same question, and only one of them was
          // being asked. The per-binding dedup (#1569 round 3) is what keeps
          // the extra edges from walking forever.
          const declNode = binding.init
            ? [...walkNodes(tree)].find(
                (n) => n.start === binding.declStart && n.type === "VariableDeclarator",
              )
            : undefined;
          if (declNode?.init) next.push(...valueIdentifiers(declNode.init as AstNode));
          for (const assignedNode of binding.assigned) {
            next.push(...valueIdentifiers(assignedNode));
          }
        }
        frontier = next;
      }
    }

    sites.push({
      primitive,
      callee: js.slice(callee.start, callee.end).replace(/\s+/g, ""),
      target,
      view: view.replace(/\s+/g, " ").trim(),
      unresolved,
      // A reassignable binding makes the target opaque even when a literal IS
      // visible: the literal may be the initialiser while the value at the
      // write came from an assignment in a form nobody enumerated.
      //
      // And a visible literal does not clear an invisible component. The
      // predicate used to be `!sawLiteral && unresolved.length > 0`, so ONE
      // readable filename cleared a target whose DIRECTORY nobody can see:
      // `join(<unknown>, "report.json")` read as transparent. That is not a
      // path the sweep has read, it is a filename plus a hole, and the hole is
      // the half that decides whether the write lands under `specs/` (#1584).
      opaque: reassignable || unresolved.length > 0,
      reassignable,
      start: node.start,
    });
  }

  return sites.sort((a, b) => a.start - b.start);
}

/**
 * The 1-based line of each site in the ORIGINAL source, or `null` where it
 * cannot be established.
 *
 * Node positions index the transpiled text, so the line is resolved by ordinal
 * against the original: the Nth call of a given callee name in the tree is the
 * Nth textual occurrence of that name followed by `(`. The two counts are
 * REQUIRED to agree — a `writeFileSync(` inside a comment or a string inflates
 * the text count, and reporting the wrong line silently is worse than
 * reporting none.
 */
export function resolveLines(
  original: string,
  sites: AstWriteSite[],
  opts: { positionsAreOriginal?: boolean } = {},
): (number | null)[] {
  // When nothing was rewritten (a `.js` parse), the offset IS an offset into
  // the text being reported on, so the line is exact and needs no ordinal.
  if (opts.positionsAreOriginal) {
    return sites.map((s) => original.slice(0, s.start).split("\n").length);
  }

  const trailing = (callee: string): string => callee.slice(callee.lastIndexOf(".") + 1);

  const byName = new Map<string, number[]>();
  for (const site of sites) {
    const name = trailing(site.callee);
    if (byName.has(name)) continue;
    const offsets: number[] = [];
    const re = new RegExp(`(?<![A-Za-z0-9_$])${name}\\s*\\(`, "g");
    for (const m of original.matchAll(re)) offsets.push(m.index);
    byName.set(name, offsets);
  }

  const ordinal = new Map<string, number>();
  return sites.map((site) => {
    const name = trailing(site.callee);
    const offsets = byName.get(name)!;
    const n = ordinal.get(name) ?? 0;
    ordinal.set(name, n + 1);
    const total = sites.filter((s) => trailing(s.callee) === name).length;
    if (offsets.length !== total) return null;
    return original.slice(0, offsets[n]!).split("\n").length;
  });
}
