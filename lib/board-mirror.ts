/**
 * What a board COLUMN may say about an issue, and where that sentence is
 * allowed to come from.
 *
 * ## The field is a mirror. The issue body is the source.
 *
 * A Projects v2 custom field is invisible to `gh`: `gh issue list --json
 * projectItems` returns Status and nothing else, measured on #1592, which had
 * two custom fields set at the time. Agents read the tracker through `gh`, so
 * nothing an agent must ACT on can live in a project field — that is step 3 of
 * `docs/adr/ADR-003-spec-to-tracker-mapping.md` and it has not changed.
 *
 * What a field CAN do is be looked at. Jason asked to open the board and see,
 * per issue, the milestone it sits in and the criteria it serves, without
 * opening anything. The milestone is already a built-in field. The criteria
 * are in the issue body, and a board does not render bodies.
 *
 * So: this module derives the column from the body and never the other way
 * round. `mirrorText` is a pure function of the issue's own text. If the field
 * and the body ever disagree, the body is right and the field is stale, and
 * the repair is to re-run the command — never to edit the column.
 *
 * ## One decider, which already existed
 *
 * "Does this issue name this criterion" is answered by `oneScMentionPattern`
 * against the title and the body, which is exactly what
 * `scripts/criterion-inventory.ts` has always asked. This module calls it
 * rather than spelling the question again: two deciders that agree are
 * behaviourally one, and no test can tell which of them is dead
 * (`.claude/rules/checks-must-be-able-to-fail.md`). A duplicate of this very
 * matcher was built and removed earlier in #1647, so the trap is not
 * hypothetical here.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import { idAsLiteral, oneScMentionPattern } from "./sc-ids";
import { parseCriteria } from "./spec-evidence";

/** One spec, and the criterion ids it states. */
export interface SpecCriteria {
  /** Repo-relative, with `/` separators, so a reading is comparable across machines. */
  readonly path: string;
  readonly ids: readonly string[];
}

/** What `specCriteriaIn` found, including what it could not resolve. */
export interface SpecSweep {
  readonly reading: "MEASURED" | "UNMEASURED";
  readonly specs: readonly SpecCriteria[];
  /** The union, in (spec path, then spec) order. Deterministic across runs. */
  readonly ids: readonly string[];
  /** An id two specs both state — reported, never silently merged. */
  readonly collisions: readonly { readonly id: string; readonly specs: readonly string[] }[];
  readonly unmeasuredReasons: readonly string[];
}

/**
 * The one spec whose ids are illustrative rather than stated.
 *
 * `specs/SPEC-TEMPLATE.md` is the frame a new spec is copied from, and its
 * criteria read `- [ ] SC-1: [first criterion]`. Those ids are the lowest and
 * most collidable in the whole namespace, so including them credits any issue
 * mentioning `SC-1` to a criterion nobody ever wrote.
 *
 * It is named rather than detected. A heuristic — "skip drafts", "skip
 * `testable: false`" — would also drop `DA-COMPLIANCE-SPEC.md`, which states
 * real criteria, and blanking a real cell is the exact failure SC-2610 is
 * about. `test/board-mirror.test.ts` asserts the file still exists, so this
 * cannot rot into an exclusion pointing at nothing.
 */
export const NOT_A_SPEC = ["specs/SPEC-TEMPLATE.md"] as const;

/**
 * Every criterion id in `<root>/specs`, from every spec, including nested ones.
 *
 * **Why this is not a `--spec` argument.** The column answers "which criteria
 * does this issue serve", and an issue does not know which spec the person at
 * the keyboard happened to name. Filtering the id set to one spec means every
 * issue serving any of the other 25 specs' criteria renders as an EMPTY cell —
 * and a blank cell reads as *not yet filled in*, *the tool could not tell* and
 * *deliberately none* at once. 28 cells on the live board were blank for this
 * reason on 2026-10-29, which is the measurement behind SC-2610.
 *
 * A directory that exists and yields no criteria at all is UNMEASURED rather
 * than an empty set: a tree with no specs and a tree whose specs could not be
 * parsed produce the same empty list, and only one of them is a board in good
 * order (*Silent Default Substitution*, `.claude/rules/config-access.md`).
 */
export function specCriteriaIn(root: string): SpecSweep {
  const dir = join(root, "specs");
  let files: string[];
  try {
    files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".md"))
      .map(e => relative(root, join(e.parentPath ?? e.path ?? dir, e.name)).split(sep).join("/"))
      .filter(p => !(NOT_A_SPEC as readonly string[]).includes(p))
      .sort();
  } catch (e) {
    return {
      reading: "UNMEASURED",
      specs: [],
      ids: [],
      collisions: [],
      unmeasuredReasons: [`could not read ${dir}: ${(e as Error).message}`],
    };
  }

  const specs: SpecCriteria[] = [];
  const reasons: string[] = [];
  const seen = new Map<string, string[]>();
  for (const path of files) {
    let ids: string[];
    try {
      ids = parseCriteria(readFileSync(join(root, path), "utf-8")).map(c => c.id);
    } catch (e) {
      // One unreadable spec does not make a SHORTER id list — it makes the
      // whole sweep unmeasured, because a shorter list is exactly what a
      // repository with fewer criteria produces.
      reasons.push(`could not read ${path}: ${(e as Error).message}`);
      continue;
    }
    specs.push({ path, ids });
    for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), path]);
  }

  // An id two specs both state is AMBIGUOUS, and the column has one cell per
  // issue with no room to say which spec was meant. #312 mentions `SC-A1`
  // meaning another repository's criterion; three specs here state `SC-A1`,
  // so writing it attributes the issue to a criterion at random. Dropped from
  // the id set and reported — the issue keeps whatever unambiguous ids it
  // also names, so this narrows a cell rather than blanking it.
  const ids = [...seen.keys()].filter(id => (seen.get(id) as string[]).length === 1);
  if (reasons.length === 0 && ids.length === 0) {
    reasons.push(`no spec under ${dir} states a criterion, so no cell could be filled`);
  }
  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    specs,
    ids,
    collisions: [...seen.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([id, where]) => ({ id, specs: where })),
    unmeasuredReasons: reasons,
  };
}

/** What the board is told about one issue. */
export interface MirrorRow {
  readonly number: number;
  /** Criterion ids the issue's own text names, in spec order. */
  readonly criteria: readonly string[];
  /** Exactly what goes in the text field. */
  readonly text: string;
}

/** The text used when an issue names no criterion at all. */
export const NAMES_NONE = "";

/**
 * Every id, never a summary.
 *
 * The first version of this capped the cell at six ids and appended
 * `+N more`, on the stated grounds that a board cell is narrow and that the
 * widest issue in this repository names six, so the overflow branch would be
 * reached by nothing. **The first run falsified both halves in one line:**
 * #1437 names nine, and the cell it produced was
 * `CRC-E1 CRC-E2 CRC-E3 CRC-E4 CRC-E5 CRC-E6 +3 more`.
 *
 * Which is the worse of the two failures. The column exists so Jason can see
 * which criteria an issue serves without opening it; a cell that silently
 * drops three of them answers the question wrongly rather than partially, and
 * it does so on exactly the issue with the most to say. A visually clipped
 * cell is still the whole value — the table widens, the tooltip shows it, and
 * the JSON carries it. So there is no cap, and the bound that was never
 * measured is gone rather than raised.
 */
export function mirrorText(criteria: readonly string[]): string {
  if (criteria.length === 0) return NAMES_NONE;
  return criteria.join(" ");
}

/**
 * An issue STATING a criterion of its own, rather than naming one it serves.
 *
 * `- [ ] SC-1 — A test fails when a hook name exists in both trees` is #713
 * writing its own acceptance criteria in the shape a spec uses. It is not a
 * reference to `specs/bootstrap-data-flow/success-criteria.md`'s `SC-1`, and
 * the two are indistinguishable to a bare mention test. Measured 2026-10-30:
 * reading every spec made #713's cell read `SC-1 SC-2 SC-3 SC-4 SC-5 SC-6`,
 * six criteria it has nothing to do with.
 *
 * A wrong cell is worse than the blank one SC-2609 is about. A blank says
 * "nothing known"; a populated cell is read as a fact.
 *
 * The checkbox is the whole signal, and it is the right one: ADR-003 step 3
 * says an issue names what it serves under a CRITERIA heading as plain text.
 * Nothing in this repository's issue template writes a served criterion as a
 * task checkbox.
 */
export function declaresOwnCriterion(text: string, id: string): boolean {
  return new RegExp(`^[ \\t]*[-*][ \\t]*\\[[ xX]\\][ \\t]*${idAsLiteral(id)}\\b`, "m").test(text);
}

/**
 * Which of `criterionIds` this issue's text names.
 *
 * Order follows `criterionIds`, so the column reads in spec order rather than
 * in whatever order the issue's prose happened to mention them. Two issues
 * serving the same pair then render identically, which is what makes the
 * column scannable down a group.
 */
export function criteriaNamedBy(
  issue: { readonly title: string; readonly body?: string | null },
  criterionIds: readonly string[],
): string[] {
  const text = `${issue.title}\n${issue.body ?? ""}`;
  return criterionIds.filter(
    id => oneScMentionPattern(id).test(text) && !declaresOwnCriterion(text, id),
  );
}

export function mirrorRows(
  issues: readonly { readonly number: number; readonly title: string; readonly body?: string | null }[],
  criterionIds: readonly string[],
): MirrorRow[] {
  return issues.map(i => {
    const criteria = criteriaNamedBy(i, criterionIds);
    return { number: i.number, criteria, text: mirrorText(criteria) };
  });
}

/**
 * An item is READY when nothing open is blocking it.
 *
 * **This cannot be a saved view filter, and the reason is measured.**
 * GitHub's `no:blocked-by` and `has:blocked-by` match on whether a dependency
 * LINK exists, not on whether the blocker is still open. Taken 2026-10-28
 * against `LucasDesenvGit/financas-local`, the only public repository with
 * dependency edges I could find to use as a positive control: its issues #78,
 * #92, #191 and #210 are open with `issueDependenciesSummary { blockedBy: 0,
 * totalBlockedBy: 1 }` — one dependency, already closed — and all four match
 * `has:blocked-by` while none matches `no:blocked-by`.
 *
 * So a Ready lane defined as `is:open no:blocked-by` would drop an issue the
 * moment anything was ever linked to it and never give it back, including
 * after the blocker shipped. The open count has to be read and the lane
 * written. `blockedBy` is the OPEN count and `totalBlockedBy` the lifetime
 * one; they are separate fields and only the first one answers this.
 *
 * `issueDependenciesSummary` is GraphQL-only — `gh issue view --json` exposes
 * `blockedBy` and `blocking` but not the summary.
 */
export function isUnblocked(summary: { readonly blockedBy: number }, assignees: number): boolean {
  return summary.blockedBy === 0 && assignees === 0;
}

/** The phase number in a milestone title, or null for a milestone that is not a phase. */
export function phaseOf(milestoneTitle: string | null | undefined): number | null {
  const m = /\bPhase (\d+)\b/.exec(milestoneTitle ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The lowest phase number that still has open work, or null if none does.
 *
 * This is the whole ordering, and it is derived rather than declared: the
 * spec's *Phase placement* table decides which phase a criterion is in,
 * `rungate plan-spec` turns the phases into milestones, and a milestone is
 * single-valued so an issue sits in exactly one. Nothing here is a number
 * anybody types.
 */
export function openFrontier(
  items: readonly { readonly state: string; readonly phase: number | null }[],
): number | null {
  const open = items.filter(i => i.state === "OPEN" && i.phase !== null).map(i => i.phase as number);
  return open.length === 0 ? null : Math.min(...open);
}

/**
 * READY means *pick this up next*, which is narrower than *nothing is
 * blocking it*.
 *
 * The first run of this made 36 of 46 open issues Ready, because the
 * repository has almost no dependency edges and an issue with no blockers is
 * trivially unblocked. A lane holding 36 items is the backlog with a
 * different name, and it answers the question Jason actually asked — *what
 * can I pick up* — with "anything", which is the same as not answering.
 *
 * So readiness carries the phase order too: an issue is Ready when it is
 * unblocked, unassigned, AND sits in the earliest phase that still has open
 * work. Later phases are not ready because the spec says they come later,
 * and that ordering is data — the placement table — not a judgement made
 * here.
 *
 * An issue with no phase milestone is never Ready. That is not a
 * demotion: 19 of the 46 open issues are reviewer findings that serve no
 * criterion and belong to no phase (ADR-003), and putting them in the lane
 * that means "this is the next convergence work" would make the lane lie.
 */
export function isReady(
  item: {
    readonly state: string;
    readonly phase: number | null;
    readonly blockedByOpen: number;
    readonly assignees: number;
  },
  frontier: number | null,
): boolean {
  if (item.state !== "OPEN") return false;
  // No separate `item.phase === null` guard. It was here, and the mutation
  // battery removed it with every case still green: `null !== frontier` is
  // already false for any non-null frontier, so the two lines were one
  // decider spelled twice, and no behavioural test could ever tell which of
  // them was live (`.claude/rules/checks-must-be-able-to-fail.md`).
  if (frontier === null) return false;
  if (item.phase !== frontier) return false;
  return isUnblocked({ blockedBy: item.blockedByOpen }, item.assignees);
}
