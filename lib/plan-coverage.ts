/**
 * Does a decomposition's plan allocate every file discovery said the issue
 * touches? (#751)
 *
 * `workflows/ship.js` interpolates `discovery.filesToModify` into the
 * to-issues prompt as "Files to modify" and then validates the answer two
 * ways: no sub-issue may claim an out-of-scope file, and no two sub-issues
 * may claim the same one. **Nothing compared the UNION of the sub-issues'
 * `filesToModify` against the list it had just asked about.** The prompt
 * asks; nothing checked that the answer covers it — the same gap the comment
 * beside `denylistViolations` names for the deny-list and was never extended
 * past.
 *
 * On the consumer run that motivated #751, the file the issue was *about* was
 * claimed by no sub-issue, edited by two worktrees, and the run reached
 * Commit before SC-413 refused with *"no worktree claimed that file"* —
 * 2h06m and 2.03M subagent tokens of correct work ending `SHIP_FAILED` /
 * `NO_PR`. The run is named on the issue; naming a consumer repository in
 * harness source is what `test/anti.test.ts` SC-A1 refuses, and it is right
 * to — this module ships to every project rungate scaffolds. That
 * refusal is correct and is not loosened here; widening it is the documented
 * cheapest wrong fix for this family (`.claude/rules/checks-must-be-able-to-fail.md`,
 * the #627 section). This moves the detection to plan time, where it costs
 * nothing.
 *
 * ## The decision #751 asked to be made out loud
 *
 * Three candidates, all precedented in `ship.js`. **Option 1: refuse the
 * parallel plan and fall back to single-agent implement** — the same branch
 * `hasOverlap` already takes, one line away.
 *
 * - **Not auto-claim (option 2).** The decomposer had the file list and chose
 *   not to allocate it. Assigning the file by a heuristic — same directory,
 *   first sub-issue, largest — hands work to an agent whose brief never
 *   mentions it, and whose claim audit then PASSES while the allocation is
 *   wrong. It converts a loud, early, correct refusal into a quiet
 *   misallocation, which is strictly worse than the state being fixed.
 * - **Not warn-and-proceed (option 3).** That is the status quo, and the
 *   status quo is a run spending its whole agent budget to discover at Commit
 *   what was knowable before the first agent spawned.
 * - **Option 1 loses nothing.** The single-agent path may modify every file,
 *   so the work still ships; what is given up is parallelism, which is an
 *   optimisation and not a requirement. The failure is moved from the end of
 *   the run to the start of it.
 *
 * ## An empty discovery list is UNMEASURED, not "fully covered"
 *
 * The union of nothing covers nothing perfectly — the third shape, and #751
 * names it as the cheapest wrong fix for this check specifically: *treat an
 * absent or empty `discovery.filesToModify` as satisfied*. It silences every
 * synthetic fixture and leaves exactly the #1585 case uncaught, because the
 * thing that needs covering is a list nobody is obliged to produce.
 *
 * **That branch is unreachable from today's call site, and saying so is the
 * point** (#492). `ship.js` only decomposes when
 * `discovery.sizing === 'M' && (discovery.filesToModify || []).length >= 3`,
 * so every live plan arrives with at least three files and the empty reading
 * cannot occur. It is reported anyway, because the precondition is one `if`
 * in another function that nothing holds still, and a branch that only exists
 * while an unrelated guard keeps its shape is a branch that goes silently
 * wrong the day that guard moves.
 */

import { normalisePath } from "./scope-denylist";

export interface PlanSubIssue {
  title?: string;
  filesToModify?: string[];
}

export interface PlanCoverageReading {
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  /** Discovered files no sub-issue claims, in the spelling discovery used. */
  uncovered: string[];
  /** How many files were compared, so a PASS can report its own coverage. */
  discovered: number;
  /** How many distinct files the plan allocates, including any not discovered. */
  claimed: number;
}

/**
 * Compare the plan's union against what discovery found.
 *
 * Path equality goes through `normalisePath`, the same binding the deny-list
 * uses, so `./lib/a.ts` and `lib/a.ts` are one file here exactly as they are
 * there. A second notion of "same path" in the same workflow would agree on
 * every input anyone has and diverge on the one that matters.
 */
export function planCoverage(
  discoveryFiles: string[] | undefined | null,
  subIssues: PlanSubIssue[] | undefined | null,
): PlanCoverageReading {
  const discovered = (discoveryFiles || []).map(f => String(f)).filter(f => f.trim() !== "");
  const subs = subIssues || [];

  const claimedSet = new Set<string>();
  for (const s of subs) {
    for (const f of s.filesToModify || []) {
      const n = normalisePath(f);
      if (n !== "") claimedSet.add(n);
    }
  }

  const reasons: string[] = [];
  if (discovered.length === 0) {
    reasons.push(
      "discovery named no files to modify, so there is nothing to compare the plan against. " +
        'The union of an empty list is covered by any plan at all, which is not "the plan is ' +
        'complete" — it is "nobody looked" (#751).',
    );
  }
  if (subs.length === 0) {
    reasons.push(
      "the decomposition produced no sub-issues, so there is no plan to compare. An empty " +
        "plan agrees with every discovery.",
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    uncovered:
      reasons.length === 0 ? discovered.filter(f => !claimedSet.has(normalisePath(f))) : [],
    discovered: discovered.length,
    claimed: claimedSet.size,
  };
}

/**
 * The sentence `ship.js` logs when the plan must not be used, or `null`.
 *
 * One binding so there is one thing to mutate, and so the refusal and the
 * reading cannot disagree about whether a plan is usable. An UNMEASURED
 * reading refuses too: a plan nobody could check is not a plan that passed.
 */
export function planCoverageRefusal(r: PlanCoverageReading): string | null {
  if (r.reading === "UNMEASURED") {
    return (
      `PLAN COVERAGE UNMEASURED: ${r.unmeasuredReasons.join(" ")} ` +
      `Falling back to single-agent implement, which may touch any file.`
    );
  }
  if (r.uncovered.length === 0) return null;
  return (
    `PLAN COVERAGE: ${r.uncovered.length} of ${r.discovered} discovered file(s) are claimed by ` +
    `no sub-issue — ${r.uncovered.join(", ")}. A file nobody claims is a file two worktrees ` +
    `may both edit, and the SC-413 claim audit refuses it at Commit after the whole agent ` +
    `budget is spent (#751). Falling back to single-agent implement.`
  );
}
