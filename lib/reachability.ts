/**
 * Is a marked block actually reachable? (#200, Phase 1)
 *
 * This repo's strong form of verification is marker extraction plus
 * `new Function`: a test slices the source between two comments and executes
 * the slice over a sandbox. It proves the extracted logic refuses for the
 * right reason. It does not prove the block runs.
 *
 * Measured, on 2026-10-08: wrapping the `BLOCKING-GRADES` region of
 * workflows/ship.js in `if (false) { ... }` — with the wrapper placed OUTSIDE
 * the marker comments, so the extracted slice stays byte-identical — left
 * test/blocking-grades.test.ts at 19 pass / 0 fail. The same mutation of
 * `SECURITY-DECISION` left test/security-verdict-blocks.test.ts at
 * 113 pass / 0 fail, and of `COMMIT-STATE-GUARD` left
 * test/record-build-commit.test.ts at 52 pass / 0 fail. Everything those
 * suites observe is a property of the TEXT between the markers, and the text
 * did not change.
 *
 * So this helper never decides from the text. It parses the file, finds where
 * the marked region sits in the resulting tree, and reads two properties off
 * the parse:
 *
 *   1. the region's ancestor chain — `if (false)`, a relocation into a
 *      function nobody calls, a loop, a `catch` all change it;
 *   2. the statements that precede the region in each enclosing statement
 *      list — an early `return` above the block changes nothing about the
 *      chain, and is the one dead-code shape an ancestor check alone misses.
 *
 * None of those mutations changes a single byte between the markers.
 *
 * ## Permitted enclosing constructs — stated, not inferred (AC-3)
 *
 * A permissive list silently restores the defect, so the allowlist is tiny and
 * every entry has a reason attached in `PERMITTED_ENCLOSING`. Anything not on
 * it is a refusal, including constructs nobody has thought of yet: the default
 * is deny. Note that a conditional ancestor is always *in* the chain alongside
 * the `BlockStatement` it owns, so allowing `BlockStatement` generically is
 * safe — an `if`/loop/`catch`/function body is caught by its own entry.
 *
 * Deny-by-default also means a block inside a function that IS called is
 * refused. That is deliberate: nothing here resolves call graphs, so accepting
 * it would mean trusting the author's word, which is the thing this module
 * exists to stop doing.
 *
 * ## What this cannot catch (AC-5)
 *
 * Reachability here is a parse-time property. A block that the parser says is
 * unconditionally reached can still never execute at runtime:
 *
 *   - a preceding `if (x) return` whose condition is true on every real input
 *     — the terminator scan below only sees UNCONDITIONAL siblings, because a
 *     conditional `return` above the block is the normal shape of
 *     workflows/ship.js and refusing it would reject the real file;
 *   - a preceding call that exits the process or raises on every real input;
 *   - a preceding `await` on a promise that never settles;
 *   - a top-level guard like `if (!enabled) return` where `enabled` is false
 *     in every deployed configuration.
 *
 * No static check sees any of those, and this one does not pretend to. It
 * closes exactly one hole — the block's position in the program is now
 * observed instead of assumed — and leaves the runtime hole open and written
 * down. It is also complementary to, not a replacement for, the `new Function`
 * mutant tests: those prove the logic refuses correctly, this proves the logic
 * is wired in. Both properties are needed; neither implies the other.
 *
 * ## Fail-closed refusals
 *
 * Every refusal leaves through `refuse()`, whose single raise statement — the
 * only one in this file, which the test asserts — is guarded by the one
 * exported `REACHABILITY_REFUSE` constant. That constant exists so
 * test/reachability-refusals.test.ts can build a mutant copy of this file with
 * it set to 0 and show each negative case passing only because the refusal
 * fired — see .claude/rules/checks-must-be-able-to-fail.md.
 */

import { parse } from "acorn";

/**
 * The one switch every refusal goes through. Declared on a single line and
 * assigned exactly once, so the test's mutant (`= 0`) neutralises ALL
 * refusals and no branch can quietly bypass the mutation by raising directly.
 */
export const REACHABILITY_REFUSE = 1;

/** Raised by every refusal in this module. */
export class ReachabilityRefusal extends Error {
  constructor(reason: string) {
    super(`reachability REFUSED: ${reason}`);
    this.name = "ReachabilityRefusal";
  }
}

/**
 * The complete allowlist of constructs a marked block may sit inside, with the
 * reason each is unconditional. Everything absent from this map is refused.
 */
export const PERMITTED_ENCLOSING: Record<string, string> = {
  Program:
    "the module body itself — workflows/ship.js runs top to bottom, so a statement here executes on every run",
  TryStatement:
    "a `try` runs its block unconditionally; the handler is a separate node and is NOT permitted",
  BlockStatement:
    "a bare, `try` or `finally` block body; any conditional owner (if/loop/catch/function) appears in the chain under its own name and is refused there",
};

/**
 * Statements that end control flow for the rest of their statement list. One
 * of these as an UNCONDITIONAL preceding sibling makes everything after it
 * dead, however unconditional the ancestor chain looks.
 */
export const UNCONDITIONAL_TERMINATORS: Record<string, string> = {
  ReturnStatement:
    "control leaves the enclosing body here, so nothing later in the same statement list can run — the #200 `early return` mutation",
  ThrowStatement:
    "an error is raised unconditionally, so the rest of the statement list is dead code",
  BreakStatement:
    "control leaves the enclosing loop or switch case, skipping everything after it in the list",
  ContinueStatement:
    "control jumps to the next iteration, skipping everything after it in the list",
};

/**
 * acorn options. `allowReturnOutsideFunction` and `allowAwaitOutsideFunction`
 * are required because workflows/ship.js is a module body that the Workflow
 * runtime wraps in an async function before running it, so it legitimately
 * contains top-level `return` and `await`. Both options only widen what
 * PARSES; neither affects the ancestor chain a parsed block gets.
 */
const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

type AstNode = { type: string; start: number; end: number };

function refuse(reason: string): void {
  if (REACHABILITY_REFUSE) throw new ReachabilityRefusal(reason);
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AstNode).type === "string" &&
    typeof (value as AstNode).start === "number" &&
    typeof (value as AstNode).end === "number"
  );
}

/** Depth-first walk collecting every node that fully contains `[start, end]`. */
function ancestorsOf(node: AstNode, start: number, end: number, into: AstNode[]): void {
  if (node.start <= start && node.end >= end) into.push(node);
  for (const value of Object.values(node as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) ancestorsOf(child, start, end, into);
    } else if (isNode(value)) {
      ancestorsOf(value, start, end, into);
    }
  }
}

function parseOrRefuse(source: string): AstNode | null {
  try {
    return parse(source, PARSE_OPTIONS) as unknown as AstNode;
  } catch (err) {
    refuse(`the source does not parse as JavaScript: ${(err as Error).message}`);
    return null;
  }
}

function ancestorNodes(source: string, start: number, end: number): AstNode[] {
  const tree = parseOrRefuse(source);
  if (!tree) return []; // mutant path only; the real one refused above.

  const chain: AstNode[] = [];
  ancestorsOf(tree, start, end, chain);

  if (chain.length === 0) {
    refuse(
      `no parsed node contains bytes [${start}, ${end}) — the range is outside the program, so its position cannot be read`,
    );
  }
  return chain;
}

/**
 * The parsed ancestors of the byte range `[start, end)`, outermost first.
 *
 * Returns the `type` of every AST node that fully contains the range —
 * `["Program"]` for a top-level statement,
 * `["Program", "IfStatement", "BlockStatement"]` for one inside an `if`.
 * Refuses if the source does not parse; an empty chain is impossible for a
 * valid range, so it is also refused rather than read as "no ancestors".
 */
export function enclosingChain(source: string, start: number, end: number): string[] {
  return ancestorNodes(source, start, end).map((node) => node.type);
}

/**
 * The first unconditional terminator that precedes the region in any enclosing
 * statement list, innermost list first. `null` when nothing does.
 *
 * Only DIRECT siblings count. A `return` nested inside a preceding `if` is
 * conditional, and refusing those would reject workflows/ship.js, every marked
 * block of which sits below a guard of exactly that shape.
 */
function precedingTerminator(
  chain: AstNode[],
  start: number,
): { statement: string; owner: string } | null {
  for (const node of [...chain].reverse()) {
    const body = (node as unknown as { body?: unknown }).body;
    if (!Array.isArray(body)) continue;
    for (const statement of body) {
      if (!isNode(statement)) continue;
      if (statement.end > start) break; // reached the region itself
      if (statement.type in UNCONDITIONAL_TERMINATORS) {
        return { statement: statement.type, owner: node.type };
      }
    }
  }
  return null;
}

/**
 * Refuse unless the `${markerName}-START` / `${markerName}-END` region of
 * `source` sits somewhere that runs unconditionally. Returns the ancestor
 * chain on acceptance.
 *
 * The markers are located by text because comments are the only way to name a
 * region — but nothing about the region's CONTENT is inspected, and the
 * accept/refuse decision is read entirely off the parse.
 */
export function assertMarkedBlockReachable(source: string, markerName: string): string[] {
  const startMarker = `${markerName}-START`;
  const endMarker = `${markerName}-END`;

  const startCount = source.split(startMarker).length - 1;
  const endCount = source.split(endMarker).length - 1;

  // Absent markers first: a typo'd or renamed marker must never read as
  // "nothing to check here, carry on".
  if (startCount === 0) {
    refuse(`${startMarker} is absent from the source`);
    return [];
  }
  if (endCount === 0) {
    refuse(`${endMarker} is absent from the source`);
    return [];
  }
  // #200: nothing asserted this before, so a dead duplicate of the pair
  // elsewhere in the file satisfied the slice while the live copy was
  // unreachable. Ambiguity about WHICH pair is being checked is a refusal.
  if (startCount > 1) {
    refuse(`${startMarker} occurs ${startCount} times — the marked block must be unique`);
    return [];
  }
  if (endCount > 1) {
    refuse(`${endMarker} occurs ${endCount} times — the marked block must be unique`);
    return [];
  }

  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf(endMarker);
  if (end <= start) {
    refuse(`${endMarker} appears before ${startMarker} — the region is inside out`);
    return [];
  }

  const nodes = ancestorNodes(source, start, end);
  if (nodes.length === 0) return []; // mutant path only; the real one refused above.
  const chain = nodes.map((node) => node.type);

  if (chain[0] !== "Program") {
    refuse(`the ancestor chain does not start at Program: [${chain.join(" > ")}]`);
    return [];
  }

  for (const node of chain) {
    if (!(node in PERMITTED_ENCLOSING)) {
      refuse(
        `${markerName} sits inside ${node}, which is not an unconditional construct — ` +
          `chain was [${chain.join(" > ")}], permitted: [${Object.keys(PERMITTED_ENCLOSING).join(", ")}]`,
      );
      return [];
    }
  }

  const dead = precedingTerminator(nodes, start);
  if (dead) {
    refuse(
      `${markerName} follows an unconditional ${dead.statement} in the same ${dead.owner} — ` +
        `control never reaches it, even though its ancestor chain [${chain.join(" > ")}] is permitted`,
    );
    return [];
  }

  return chain;
}
