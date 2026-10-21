/**
 * The other half of #523: is the list of "fields that must be stable" still true?
 *
 * `lib/discovery-stability.ts` compares k recorded runs over
 * `STABLE_DISCOVERY_FIELDS`. That list was not written by taste — it was
 * derived from one criterion, stated on #523 before any code:
 *
 *   **A discovery field is required to be stable exactly when something
 *   downstream BRANCHES on it.**
 *
 * The same comment named the consequence and did not build it:
 *
 *   *"The list is derivable, so it can be a test rather than a document.
 *   Something walking the branch points in `workflows/ship.js` and comparing
 *   them to the declared stable set would catch a new branch on a field
 *   nobody declared stable — which is the failure mode a hand-maintained
 *   list has."*
 *
 * This module is that walk. Without it the comparator has a hole that is
 * invisible from inside itself: add `if (discovery.riskTier === 'HIGH')` to
 * the workflow tomorrow and every test in `test/discovery-stability.test.ts`
 * stays green, because every one of them reads the declared list, the schema,
 * or synthetic states — never the workflow. The measurement would go on
 * reporting "8 fields observed, 0 varied" while the field that actually
 * decides the run was not among them. A list that can only be checked against
 * itself is a document.
 *
 * ## The two readings, and what varies between them
 *
 * Reading A is the DECLARATION: `STABLE_DISCOVERY_FIELDS` plus `NOT_ASSERTED`,
 * hand-written in `lib/discovery-stability.ts`.
 *
 * Reading B is the CODE: the conditions in `workflows/ship.js`, parsed, and
 * the discovery properties read inside them.
 *
 * They have different producers and different inputs, which is the whole
 * point — a determinism check that builds the same thing twice with the same
 * code is 0 red against the mutation it exists to catch. Editing either side
 * alone changes the result here: a new branch grows B, deleting an entry
 * shrinks A, and `auditBranchCoverage` reports the disagreement either way.
 *
 * What this asserts is therefore (c): **a refusal when the two readings
 * disagree.** Not a shape, not an order. No model is called and nothing here
 * can red on a model-day.
 *
 * ## Why an empty reading is refused rather than counted as agreement
 *
 * A census that finds nothing agrees with every possible list. If the
 * extractor breaks — the workflow stops parsing, the discovery object is
 * renamed, acorn changes a node name — the honest result is UNMEASURED, not
 * "no undeclared fields". Both the empty-source and the zero-branch-point
 * cases leave through `refuse()`, which is guarded by the single exported
 * `BRANCH_CENSUS_REFUSE` constant so a test can zero it and show each negative
 * case passing only because the refusal fired
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { parse } from "acorn";

import { NOT_ASSERTED, STABLE_DISCOVERY_FIELDS, type StableField } from "./discovery-stability";

/**
 * The one switch every refusal goes through. Declared on a single line and
 * assigned exactly once, so a mutant copy with `= 0` neutralises ALL refusals
 * and no branch can quietly bypass the mutation by raising directly.
 */
export const BRANCH_CENSUS_REFUSE = 1;

/** Raised by every refusal in this module. */
export class BranchCensusRefusal extends Error {
  constructor(reason: string) {
    super(`branch census REFUSED: ${reason}`);
    this.name = "BranchCensusRefusal";
  }
}

function refuse(reason: string): never | void {
  if (BRANCH_CENSUS_REFUSE) throw new BranchCensusRefusal(reason);
}

/**
 * The identifiers the workflow holds DISCOVERY's model output in.
 *
 * `discovery` is the object `workflows/ship.js` parses the discovery agent's
 * JSON into; `disc` is the short alias the same file uses in a few helpers.
 * A rename that misses this list drops the census to zero branch points,
 * which is refused rather than reported as agreement.
 */
export const DISCOVERY_ROOTS = ["discovery", "disc"] as const;

/**
 * Where a read of a discovery field decides what the run does.
 *
 * Keyed by acorn node type, valued by the property holding the deciding
 * expression. A read anywhere else in the program — interpolated into a
 * prompt, logged, copied into the state file — is not a branch and is not
 * the subject of #523's criterion.
 */
export const CONDITION_POSITIONS: Record<string, readonly string[]> = {
  IfStatement: ["test"],
  ConditionalExpression: ["test"],
  SwitchStatement: ["discriminant"],
  SwitchCase: ["test"],
  WhileStatement: ["test"],
  DoWhileStatement: ["test"],
  ForStatement: ["test"],
  /**
   * `a && b` / `a || c` / `a ?? b`: the LEFT operand decides whether the right
   * one is evaluated, so it is a branch wherever it appears. The right operand
   * is not — it is the consequent.
   */
  LogicalExpression: ["left"],
};

export interface BranchPoint {
  /** The discovery property the condition reads, e.g. `ceremonyTier`. */
  field: string;
  /** The root identifier it was read off — one of `DISCOVERY_ROOTS`. */
  root: string;
  /** The acorn construct that makes it a branch, e.g. `IfStatement.test`. */
  construct: string;
  /** 1-based line in the source, so a finding can be opened. */
  line: number;
  /** The condition text, collapsed and clipped. Evidence, not decoration. */
  snippet: string;
}

type AstNode = { type: string; start: number; end: number; [k: string]: unknown };

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
 * acorn options, matching `lib/reachability.ts`: `workflows/ship.js` is a
 * module body the Workflow runtime wraps in an async function before running,
 * so it legitimately contains top-level `return` and `await`. Both options
 * only widen what PARSES.
 */
const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "module",
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
} as const;

function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) out.push(child);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

/**
 * The discovery property a member expression reads, or null.
 *
 * Only the FIRST property off the root is returned: `discovery.sizing` and
 * `discovery.sizing.predicted` both census as `sizing`, because the criterion
 * is about which model-authored field decides the run, and the declaration
 * side maps its own finer state paths onto these names through `readAs`.
 * Computed access (`discovery[k]`) yields no name and is reported separately.
 */
function rootedRead(node: AstNode): { root: string; field: string } | null {
  if (node.type !== "MemberExpression") return null;
  const object = node.object as AstNode | undefined;
  const property = node.property as AstNode | undefined;
  if (!isNode(object) || !isNode(property)) return null;
  if (object.type !== "Identifier") return null;
  const root = String((object as unknown as { name: string }).name);
  if (!(DISCOVERY_ROOTS as readonly string[]).includes(root)) return null;
  if (node.computed === true) return null;
  if (property.type !== "Identifier") return null;
  return { root, field: String((property as unknown as { name: string }).name) };
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function clip(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Every discovery property read inside a condition, one entry per read.
 *
 * REFUSES when the source does not parse, and when the walk finds no branch
 * point at all — see the module header for why an empty census is not
 * agreement.
 */
export function extractDiscoveryBranchPoints(source: string): BranchPoint[] {
  let program: AstNode;
  try {
    program = parse(source, PARSE_OPTIONS) as unknown as AstNode;
  } catch (err) {
    refuse(`the source does not parse as JavaScript: ${(err as Error).message}`);
    return [];
  }

  const found: BranchPoint[] = [];
  walk(program, node => {
    const positions = CONDITION_POSITIONS[node.type];
    if (!positions) return;
    for (const position of positions) {
      const condition = node[position];
      if (!isNode(condition)) continue;
      walk(condition, inner => {
        const read = rootedRead(inner);
        if (!read) return;
        found.push({
          field: read.field,
          root: read.root,
          construct: `${node.type}.${position}`,
          line: lineOf(source, inner.start),
          snippet: clip(source.slice(condition.start, condition.end)),
        });
      });
    }
  });

  if (found.length === 0) {
    refuse(
      `no condition in this source reads any of [${DISCOVERY_ROOTS.join(", ")}]. ` +
        `A census that finds nothing agrees with every possible list, so this is UNMEASURED, ` +
        `not "no undeclared fields".`,
    );
  }

  return found;
}

/* ────────────────────────── the declaration side ────────────────────────── */

/**
 * A declaration entry that names which workflow-source property it covers.
 *
 * `STABLE_DISCOVERY_FIELDS` speaks in STATE paths (`sizing.ceremonyTier`) and
 * the workflow speaks in DISCOVERY-object properties (`discovery.ceremonyTier`)
 * — `workflows/ship.js` flattens one into the other when it writes the state
 * file. `readAs` is that mapping, declared rather than guessed: a path with no
 * `readAs` covers nothing, so adding an entry does not silently excuse a
 * branch.
 */
export interface SourceMapped {
  path: string;
  readAs?: readonly string[];
}

/** The discovery properties a declaration list claims to cover. */
export function coveredFields(entries: readonly SourceMapped[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) for (const name of entry.readAs ?? []) out.add(name);
  return out;
}

/**
 * Branched on, and NOT MEASURABLE — the third register, and the one this
 * census produced.
 *
 * `filesToModify` and `scopeOut` both meet #523's criterion outright: the run
 * takes a different path on each of them. Neither is in
 * `WorkflowStateSchema`. They exist inside a run and are gone when it ends, so
 * no comparison over recorded run states can read them in either direction —
 * a declared path for one would resolve to `undefined` in every run, which is
 * perfectly stable and completely uninformative.
 *
 * They are therefore recorded as **UNMEASURED, not as excluded**. The
 * distinction is the point: `NOT_ASSERTED` means "we looked and decided not
 * to", this means "we could not look". A reading nobody could take is not a
 * reading that passed.
 *
 * The excuse is itself checked. `test/discovery-branch-coverage.test.ts`
 * asserts every entry here is genuinely ABSENT from the real
 * `WorkflowStateSchema` — so the day somebody persists `filesToModify`, this
 * entry becomes false and reddens, forcing the field into
 * `STABLE_DISCOVERY_FIELDS` where it now belongs. An excuse that cannot go
 * stale is a comment.
 */
export const BRANCHED_BUT_UNPERSISTED: { field: string; reason: string }[] = [
  {
    field: "filesToModify",
    reason:
      "`workflows/ship.js:3841` branches the M-size decomposition on `(discovery.filesToModify || []).length >= 3`, and `:2964` feeds its contents to `scopeContradiction`, which REFUSES the run. Both are decisions, so the criterion is met — but `WorkflowStateSchema` has no `filesToModify`, so a k-run series cannot observe it. Measuring this needs the field persisted first.",
  },
  {
    field: "scopeOut",
    reason:
      "`workflows/ship.js:2961` passes it to `deniedFiles`, whose result decides an early return and then a refusal; `:3837` recomputes the denied list that bounds the sub-issues. Same position as `filesToModify` — a real branch on model-authored content, absent from `WorkflowStateSchema`, therefore unobservable rather than stable.",
  },
];

export interface CoverageFinding {
  field: string;
  points: BranchPoint[];
}

export interface CoverageReport {
  /** Every branch point the walk found, in source order. */
  points: BranchPoint[];
  /** Distinct discovery properties branched on. */
  branchedFields: string[];
  /**
   * Branched on, and classified by neither list. THE FINDING: the run takes a
   * different path on this field and nobody has said whether it is allowed to
   * vary.
   */
  undeclared: CoverageFinding[];
  /**
   * Declared stable with a `branchedOnBy` justification, but no condition in
   * the workflow reads it any more. The justification has gone stale — the
   * other direction of the same rot.
   */
  staleJustification: string[];
  /** Branched on and deliberately excluded, with the reason already on record. */
  excluded: string[];
  /**
   * Branched on, meets the criterion, and the state file does not carry it —
   * so no series can measure it. UNMEASURED, never counted as stable.
   */
  unmeasurable: string[];
}

/**
 * Compare the two readings and report every disagreement, in both directions.
 *
 * REFUSES when the declaration covers nothing: a `readAs`-less list excuses
 * no branch and would report every field in the workflow as a finding, which
 * reads as a catastrophic result rather than as a broken instrument.
 */
export function auditBranchCoverage(
  points: BranchPoint[],
  stable: readonly SourceMapped[] = STABLE_DISCOVERY_FIELDS as readonly StableField[] as readonly SourceMapped[],
  notAsserted: readonly SourceMapped[] = NOT_ASSERTED as readonly SourceMapped[],
  unpersisted: readonly { field: string }[] = BRANCHED_BUT_UNPERSISTED,
): CoverageReport {
  const stableFields = coveredFields(stable);
  const excludedFields = coveredFields(notAsserted);
  const unpersistedFields = new Set(unpersisted.map(u => u.field));
  if (stableFields.size === 0 && excludedFields.size === 0) {
    refuse(
      "neither declaration list maps to a single workflow property, so every branch would " +
        "report as undeclared. That is a broken mapping, not a finding.",
    );
  }

  const byField = new Map<string, BranchPoint[]>();
  for (const point of points) {
    const list = byField.get(point.field);
    if (list) list.push(point);
    else byField.set(point.field, [point]);
  }

  const branchedFields = [...byField.keys()].sort();
  const undeclared: CoverageFinding[] = [];
  const excluded: string[] = [];
  const unmeasurable: string[] = [];
  for (const field of branchedFields) {
    if (stableFields.has(field)) continue;
    if (excludedFields.has(field)) {
      excluded.push(field);
      continue;
    }
    if (unpersistedFields.has(field)) {
      unmeasurable.push(field);
      continue;
    }
    undeclared.push({ field, points: byField.get(field) ?? [] });
  }

  const staleJustification = [...stableFields].filter(f => !byField.has(f)).sort();

  return { points, branchedFields, undeclared, staleJustification, excluded, unmeasurable };
}

/** The finding, as text. Never a verdict a gate silently consumes. */
export function formatCoverageReport(report: CoverageReport): string {
  const lines = [
    `Discovery branch-point census (#523)`,
    ``,
    `${report.points.length} branch read(s) over ${report.branchedFields.length} field(s): ${report.branchedFields.join(", ")}`,
    ``,
  ];
  if (report.undeclared.length === 0) {
    lines.push(`No undeclared branched field. Every field a condition reads is classified.`);
  } else {
    lines.push(`UNDECLARED — branched on, classified by neither list:`);
    for (const finding of report.undeclared) {
      lines.push(`  ${finding.field}`);
      for (const point of finding.points) {
        lines.push(`    line ${point.line} [${point.construct}] ${point.snippet}`);
      }
    }
  }
  if (report.staleJustification.length > 0) {
    lines.push(
      ``,
      `STALE — declared stable, but no condition reads them any more: ${report.staleJustification.join(", ")}`,
    );
  }
  if (report.unmeasurable.length > 0) {
    lines.push(
      ``,
      `UNMEASURED — branched on, but the state file does not carry them, so no series ` +
        `can read them: ${report.unmeasurable.join(", ")}. This is not a clean result for ` +
        `those fields; it is the absence of one.`,
    );
  }
  if (report.excluded.length > 0) {
    lines.push(``, `Branched and deliberately not asserted: ${report.excluded.join(", ")}`);
  }
  return lines.join("\n");
}
