/**
 * The phase order as `blocked by` edges — step 5 of ADR-003, made executable.
 *
 * `AGENTS.md` rule 4: *"Ordering is data, not prose. Use GitHub's `blocked
 * by`. 'Not adoptable before X' in a sentence is unreadable by every tool we
 * own."* The convergence spec states its phase order deliberately — Phase 3
 * is *"sequenced third rather than first because a reviewer given more
 * context and no falsification step produces more confident false premises"*
 * — and until this file existed that ordering reached the board only as the
 * milestone a card sat in. A milestone is a label, not an edge: nothing could
 * answer *what can I pick up* without a person reading the phase numbers.
 *
 * ## Why the previous phase and not the whole prefix
 *
 * An issue in phase N is blocked by every issue in the phase immediately
 * before it, and transitively by everything earlier through those. Writing
 * the full prefix instead would state the same ordering with O(n²) edges that
 * each have to be removed by hand when a phase is re-scoped, and GitHub
 * renders every one of them on the card.
 *
 * ## The phase sequence is the phases that EXIST, never N-1 arithmetic
 *
 * {@link dependencyPlan} sorts the phases that actually carry issues and
 * chains adjacent members of that list. A spec whose placement table skips a
 * number — Phase 0, 1, 3 with nothing in 2 — would otherwise leave Phase 3
 * blocked by a phase that does not exist, which reads as *unblocked* and puts
 * the last phase in the Ready lane beside the first.
 *
 * ## It never removes an edge
 *
 * An edge this file did not derive is reported as {@link DependencyPlan.extra}
 * and left alone. Two live instances on 2026-10-29 are real and neither is
 * derivable here: #1481 blocked by #1591 (the ballot cannot subtract until the
 * jury runs) and #1659 blocked by #1658 (nothing to rescore until the case set
 * exists) — both WITHIN a phase, which is exactly the dependency a phase order
 * cannot express. A tool that reconciled by deletion would silently destroy
 * the only hand-authored ordering in the repository.
 *
 * ## Closed issues are not blockers, and that is why the derivation skips them
 *
 * A closed issue can never block anything — GitHub's
 * `issueDependenciesSummary.blockedBy` counts OPEN blockers, and
 * `lib/board-mirror.ts`'s `isUnblocked` reads that count. An edge to a closed
 * issue is therefore a row on a card that changes no decision. Pass
 * `includeClosed` to derive them anyway; the default is to leave them out.
 */
import { phaseOf } from "./board-mirror";

export interface DepIssue {
  readonly number: number;
  /** `OPEN` or `CLOSED`, spelled as the GitHub API spells it. */
  readonly state: string;
  /** The milestone title the phase is read from, or null for none. */
  readonly milestone: string | null;
  /** The issue numbers that already block this one, live. */
  readonly blockedBy: readonly number[];
  /**
   * True when the reader could not see all of them — a paged connection that
   * reported another page. A truncated list is not a short list: an unread
   * blocker past the cut reads as {@link DependencyPlan.missing} and is
   * re-added, and a real {@link DependencyPlan.extra} goes unreported.
   */
  readonly blockedByTruncated?: boolean;
}

/** One `blocked by` link: `blocked` waits for `blocker`. */
export interface DepEdge {
  readonly blocked: number;
  readonly blocker: number;
}

export interface DependencyPlan {
  /** UNMEASURED FAILS. An empty edge list from an unread input is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** The phase numbers that carry at least one considered issue, ascending. */
  phases: number[];
  /** Derived and not yet present — what `--write` would add. */
  missing: DepEdge[];
  /** Derived and already there — what makes a re-run a no-op. */
  present: DepEdge[];
  /** Present and NOT derived. Reported, never removed. */
  extra: DepEdge[];
  /** Considered issues carrying no `Phase N` milestone. */
  unphased: number[];
  /** The lowest phase with an open issue — the only phase that can be Ready. */
  frontier: number | null;
}

/**
 * Every way this reading can fail to carry an order — the whole class, once.
 *
 * ## Why this is a table and not another `if`
 *
 * The first version refused on `issues.length === 0` and on
 * `phases.length === 1`, and four review rounds each found a different input
 * that walks between them. The last was `phases.length === 0`: issues exist,
 * so the empty-input guard is skipped, and there is no single phase, so the
 * one-phase guard is skipped — and an unphased board reports `0 missing`,
 * which `scripts/plan-deps.ts` prints as *"the tracker already carries the
 * phase order"*. That sentence is false and it is the flattering reading.
 *
 * The reviewer's own process finding named the shape: *a UNMEASURED check
 * written for one specific empty-input shape, not the class of them*, which
 * a line-level patch keeps reintroducing variants of. `AGENTS.md` rule 5
 * says to stop repairing and re-scope at the third round. So the guard is
 * stated once, as the property it is actually about:
 *
 * > **An order needs two phases.** Fewer than two cannot express one, and
 * > every row below is a different way of arriving at fewer than two.
 *
 * | # | Condition | What it means |
 * |---|---|---|
 * | 1 | nothing read | a failed fetch and an empty repository are the same bytes |
 * | 2 | read, none considered | every issue was filtered out — all closed, without `--include-closed` |
 * | 3 | considered, no phase | nobody carries a `Phase N` milestone: `plan-spec` never ran, or the naming drifted from `phaseOf` |
 * | 4 | one phase | nothing to sequence, which is not the same as already sequenced |
 * | 5 | a truncated blocker list | an unread edge past the page boundary reads as missing and gets re-added |
 *
 * Rows 1-4 are exhaustive over `phases.length < 2` by construction: a
 * non-empty considered set with two or more distinct phases is the only
 * input that reaches none of them. Row 5 is orthogonal — the phases can be
 * fine while the live edge list is short — so it is checked alongside rather
 * than inside the count.
 */
export function degenerateReasons(r: {
  readonly read: number;
  readonly considered: number;
  readonly phases: readonly number[];
  readonly includeClosed: boolean;
  readonly truncated: readonly number[];
}): string[] {
  const out: string[] = [];
  if (r.read === 0) {
    out.push(
      "no issues were read — an empty repository and a failed fetch produce the same " +
        "empty edge list, and only one of them is a clean reading",
    );
  } else if (r.considered === 0) {
    out.push(
      `${r.read} issue(s) were read and none was considered` +
        (r.includeClosed ? "" : " — every one is closed, and --include-closed was not passed"),
    );
  } else if (r.phases.length === 0) {
    out.push(
      `${r.considered} issue(s) were considered and NONE carries a Phase milestone — ` +
        `either plan-spec has not run here, or the milestone titles no longer match ` +
        `what phaseOf reads. An empty plan from this input means "nothing was read", ` +
        `not "the tracker already carries the phase order"`,
    );
  } else if (r.phases.length === 1) {
    out.push(
      `every issue read sits in Phase ${r.phases[0]} — one phase states no order, so an ` +
        `empty plan here means "nothing to sequence" and not "already sequenced"`,
    );
  }
  if (r.truncated.length > 0) {
    out.push(
      `the blocker list was truncated for ${r.truncated.length} issue(s) ` +
        `(${r.truncated.map(n => `#${n}`).join(", ")}) — an edge past the page boundary ` +
        `reads as missing and would be re-added`,
    );
  }
  return out;
}

/**
 * What the repository's `blocked by` edges should be, given the phases its
 * issues sit in.
 *
 * Pure: it takes the live reading and returns three disjoint sets. Nothing
 * here calls GitHub, so `test/plan-deps.test.ts` can state a whole repository
 * as a literal and assert on membership rather than on a count — the seventh
 * shape in `.claude/rules/checks-must-be-able-to-fail.md` is a battery whose
 * rows all share the caller's blind spot, and a count cannot distinguish
 * "twelve right edges" from "twelve wrong ones".
 */
export function dependencyPlan(
  issues: readonly DepIssue[],
  opts: { readonly includeClosed?: boolean } = {},
): DependencyPlan {
  const considered = issues.filter(i => opts.includeClosed || i.state === "OPEN");
  const unphased: number[] = [];
  const byPhase = new Map<number, DepIssue[]>();
  for (const i of considered) {
    const p = phaseOf(i.milestone);
    if (p === null) {
      unphased.push(i.number);
      continue;
    }
    byPhase.set(p, [...(byPhase.get(p) ?? []), i]);
  }

  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const reasons = degenerateReasons({
    read: issues.length,
    considered: considered.length,
    phases,
    includeClosed: opts.includeClosed === true,
    truncated: issues.filter(i => i.blockedByTruncated === true).map(i => i.number),
  });

  // Adjacent members of the phases that EXIST. See the header: `p - 1` would
  // leave a phase after a gap blocked by nothing and reading as startable.
  const derived: DepEdge[] = [];
  for (let k = 1; k < phases.length; k++) {
    for (const blocked of byPhase.get(phases[k])!) {
      for (const blocker of byPhase.get(phases[k - 1])!) {
        derived.push({ blocked: blocked.number, blocker: blocker.number });
      }
    }
  }

  const key = (e: DepEdge): string => `${e.blocked}<-${e.blocker}`;
  const derivedKeys = new Set(derived.map(key));
  const liveKeys = new Set<string>();
  for (const i of issues) for (const b of i.blockedBy) liveKeys.add(key({ blocked: i.number, blocker: b }));

  const extra: DepEdge[] = [];
  for (const i of issues) {
    for (const b of i.blockedBy) {
      const e = { blocked: i.number, blocker: b };
      if (!derivedKeys.has(key(e))) extra.push(e);
    }
  }

  const open = considered.filter(i => i.state === "OPEN").map(i => phaseOf(i.milestone));
  const openPhases = open.filter((p): p is number => p !== null);

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    phases,
    missing: derived.filter(e => !liveKeys.has(key(e))),
    present: derived.filter(e => liveKeys.has(key(e))),
    extra,
    unphased,
    frontier: openPhases.length === 0 ? null : Math.min(...openPhases),
  };
}

/**
 * The missing edges grouped by the issue that carries them.
 *
 * `gh issue edit <N> --add-blocked-by <M>` takes the flag repeatedly, so one
 * call per BLOCKED issue applies all of its blockers. Measured on the live
 * convergence set: 37 calls instead of 194. The grouping is here rather than
 * in the script because it is the shape the plan is applied in, and a test
 * that asserts on it is asserting on what actually reaches GitHub.
 */
export function groupByBlocked(edges: readonly DepEdge[]): { blocked: number; blockers: number[] }[] {
  const g = new Map<number, number[]>();
  for (const e of edges) g.set(e.blocked, [...(g.get(e.blocked) ?? []), e.blocker]);
  return [...g]
    .sort((a, b) => a[0] - b[0])
    .map(([blocked, blockers]) => ({ blocked, blockers: [...blockers].sort((a, b) => a - b) }));
}
