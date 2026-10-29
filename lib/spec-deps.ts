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
  const reasons: string[] = [];
  if (issues.length === 0) {
    reasons.push(
      "no issues were read — an empty repository and a failed fetch produce the same " +
        "empty edge list, and only one of them is a clean reading",
    );
  }

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
  if (phases.length === 1) {
    reasons.push(
      `every issue read sits in Phase ${phases[0]} — one phase states no order, so an ` +
        `empty plan here means "nothing to sequence" and not "already sequenced"`,
    );
  }

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
