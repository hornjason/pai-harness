/**
 * Dependency order for decomposed sub-issues (#189).
 *
 * `workflows/ship.js` asked the decomposer for "sub-issues in dependency order
 * (foundations first)", gave it nowhere in the schema to record the answer,
 * and dispatched every sub-issue at once. The ordering was produced, accepted
 * and discarded — #166's shape exactly: **an instruction the agent can follow
 * perfectly without its output changing anything.**
 *
 * ## The run this comes from
 *
 * `wf_92dbb346-949` (#105) decomposed into four sub-issues with genuinely
 * disjoint file claims, which is all `ship.js` validated. The dependency was
 * not in the files — it was in the API. Sub-issue 1 was building
 * `harnessRootFor()` in `lib/paths.ts`; sub-issue 4 needed to call it and
 * could not see sub-issue 1, so it wrote its own:
 *
 * | worktree | signature | behaviour |
 * |---|---|---|
 * | `-5` | `harnessRootFor(root: string)` | resolves the root the caller names |
 * | `-8` | `harnessRootFor(dir: string)` | walks up looking for `HARNESS.md` |
 *
 * Two functions, one name, one file, opposite contracts. Both defensible,
 * both carefully commented, neither author aware of the other. Eight agents,
 * 77 minutes, four worktrees of good work that cannot be combined.
 *
 * ## Why file-disjointness is the wrong test
 *
 * File overlap detects MERGE conflicts. It does not detect SEMANTIC
 * dependencies, and two sub-issues can hold disjoint files and still be
 * ordered whenever one creates something the other consumes: a function, an
 * exported type, a config key one writes and the other reads, a test helper,
 * a CLI flag. The overlap check stays — it catches a different thing and both
 * are needed (#189 AC-3).
 *
 * ## The direction this is allowed to be wrong in
 *
 * Toward REFUSING, never toward running anyway. A cycle, a reference to a
 * sub-issue that does not exist, and a self-dependency all refuse. Falling
 * back to parallel on a dependency it could not read is the fail-open shape
 * `.claude/rules/checks-must-be-able-to-fail.md` opens with, and it would
 * reproduce `wf_92dbb346-949` exactly while reporting that it had scheduled
 * the work.
 */

export interface WaveSubIssue {
  title: string;
  /** Titles of sub-issues that must finish first. Absent means none. */
  dependsOn?: string[] | null;
}

export interface WavePlan {
  /** Indexes into the input array, grouped. Everything in a wave is parallel. */
  waves: number[][];
  /** One line per wave that is not the first, saying what it waited for. */
  reasons: string[];
  /** Non-null when no order exists; `waves` is empty and nothing may run. */
  refusal: string | null;
}

/** Titles are matched after trimming and case-folding; agents are inconsistent. */
function key(title: unknown): string {
  return String(title ?? "").trim().toLowerCase();
}

/**
 * Group sub-issues into waves. Everything in a wave runs concurrently; wave
 * N+1 does not start until wave N is done.
 *
 * Kahn's algorithm, with every failure mode a refusal rather than a dropped
 * edge:
 *
 *  - a `dependsOn` naming a sub-issue that is not in the list — the agent
 *    invented a dependency or misspelled one, and ignoring it would schedule
 *    the work as if the dependency did not exist
 *  - a self-dependency, which can never be satisfied
 *  - two sub-issues with the same title, because then an edge has two possible
 *    targets and picking one is a guess
 *  - a cycle, named by the sub-issues still unscheduled
 *
 * The all-independent case returns ONE wave containing everything, which is
 * the positive control: a scheduler that serialised everything would satisfy
 * every ordering case and throw away the whole benefit of decomposition
 * (#189 AC-1).
 */
export function dependencyWaves(subIssues: readonly WaveSubIssue[] | null | undefined): WavePlan {
  const list = Array.isArray(subIssues) ? subIssues : [];
  if (list.length === 0) return { waves: [], reasons: [], refusal: null };

  const byTitle = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const k = key(list[i]?.title);
    if (!k) {
      return {
        waves: [],
        reasons: [],
        refusal: `sub-issue ${i + 1} has no title, so nothing can declare a dependency on it (#189)`,
      };
    }
    if (byTitle.has(k)) {
      return {
        waves: [],
        reasons: [],
        refusal:
          `two sub-issues are both titled ${JSON.stringify(String(list[i]!.title).trim())} — a dependency ` +
          `naming that title has two possible targets and picking one is a guess (#189)`,
      };
    }
    byTitle.set(k, i);
  }

  const needs: number[][] = list.map(() => []);
  for (let i = 0; i < list.length; i++) {
    for (const raw of list[i]?.dependsOn ?? []) {
      const k = key(raw);
      if (!k) continue;
      const target = byTitle.get(k);
      if (target === undefined) {
        return {
          waves: [],
          reasons: [],
          refusal:
            `sub-issue ${JSON.stringify(String(list[i]!.title).trim())} depends on ` +
            `${JSON.stringify(String(raw).trim())}, which is not one of the sub-issues — ` +
            `scheduling around a dependency this run cannot see is how ${"wf_92dbb346-949"} ` +
            `produced two functions with one name (#189)`,
        };
      }
      if (target === i) {
        return {
          waves: [],
          reasons: [],
          refusal:
            `sub-issue ${JSON.stringify(String(list[i]!.title).trim())} depends on itself (#189)`,
        };
      }
      if (!needs[i]!.includes(target)) needs[i]!.push(target);
    }
  }

  const waves: number[][] = [];
  const reasons: string[] = [];
  const done = new Set<number>();

  while (done.size < list.length) {
    const ready = [];
    for (let i = 0; i < list.length; i++) {
      if (done.has(i)) continue;
      if (needs[i]!.every(d => done.has(d))) ready.push(i);
    }
    if (ready.length === 0) {
      const stuck = list
        .map((s, i) => (done.has(i) ? null : String(s.title).trim()))
        .filter(Boolean);
      return {
        waves: [],
        reasons: [],
        refusal:
          `the dependsOn graph has a cycle — ${JSON.stringify(stuck)} can never start, because each ` +
          `waits on another of them. Refusing rather than falling back to parallel: a fallback would ` +
          `run exactly the schedule this field exists to prevent, and report that it had ordered the ` +
          `work (#189)`,
      };
    }
    if (waves.length > 0) {
      const waited = [...new Set(ready.flatMap(i => needs[i]!))]
        .map(d => String(list[d]!.title).trim())
        .sort();
      reasons.push(
        `wave ${waves.length + 1} (${ready.map(i => String(list[i]!.title).trim()).join(", ")}) ` +
          `waited for ${waited.join(", ")} — a declared dependsOn, not a file overlap`,
      );
    }
    waves.push(ready);
    for (const i of ready) done.add(i);
  }

  return { waves, reasons, refusal: null };
}

/**
 * Was this plan serialised, and how much?
 *
 * A run that quietly takes four times as long is a bug report nobody files
 * (#189 AC-5), so the dispatcher logs this whether or not anything waited.
 */
export function wavePlanSummary(plan: WavePlan, total: number): string {
  if (plan.refusal) return plan.refusal;
  if (plan.waves.length <= 1) {
    return `${total} sub-issue(s) declared no dependsOn — dispatching all of them concurrently`;
  }
  return (
    `${total} sub-issues in ${plan.waves.length} dependency waves ` +
    `(${plan.waves.map(w => w.length).join(" then ")}) — this run is serialised by ` +
    `${plan.waves.length - 1} barrier(s) and will take correspondingly longer`
  );
}
