/**
 * One runner buffer, split into the runs it actually holds (#737).
 *
 * A LEAF module, in the shape `lib/git-dates.ts` established (#508): one
 * exported reading, no relative imports, so there is exactly one thing to
 * mutate and every consumer names the same rule.
 *
 * ## Why this exists
 *
 * `parseGateResults` read one buffer two ways. The summary reading collected
 * every `N pass` / `N fail` line and took the LAST — something nobody writes
 * unless they know the buffer can hold more than one run. Three lines later
 * `parseTestResults(testOutput)` was handed the whole buffer with no scoping
 * at all, and pushed a result for every `(fail)` marker anywhere in it.
 *
 * On `main` at `71e3f413`, run `39325676895`:
 *
 *     Test results: 158 pass, 1 fail, 1 warn
 *     BATCH DIAGNOSIS: 2 failures — fix all before re-running
 *       AC/Evidence (2): brief-ac-alignment: ..., brief-ac-alignment: ...
 *     Gate verify: FAIL (attempt 2)
 *
 * One check, named twice, counted as one. `1 fail` is attempt 2's summary;
 * `2 failures` is one check failing in both attempts. Two deciders for "how
 * many checks failed" that agree on every single-run output — which is every
 * output anyone had looked at — and diverge only on a retry
 * (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
 *
 * **And the disagreement was printed.** Those two numbers appeared eleven
 * lines apart in every retried gate run this project has ever produced, and
 * nobody read them as contradicting each other, because each is individually
 * believable. #700 was being diagnosed off the corrupted one.
 *
 * ## The semantics, decided rather than fallen into (#737 SC-5)
 *
 * **Last attempt wins.** A retry exists precisely so the later attempt is the
 * verdict: the branch moved, and attempt 1's failures describe a tree that
 * has been superseded. Reporting them under attempt 2's heading sends an
 * operator to reasons that may already be fixed.
 *
 * The alternative — accumulate every attempt — was rejected because it makes
 * a gate that eventually passed still report failures, and there is no way to
 * tell those from failures that are still live.
 *
 * This is also written down in `specs/GATE-CONTRACTS-SPEC.md`, because a
 * parser is a bad place to learn what a retry means.
 *
 * ## Why an absent final summary is UNMEASURED and not an earlier run's number
 *
 * #469's shape, which `lib/suite-run-reading.ts` already refuses: a run that
 * produced no summary did not report zero failures, it reported nothing.
 * Falling back to the previous run's numbers is *Silent Default
 * Substitution* — `0`, `{}`, `null` and silence are indistinguishable from
 * success, and the pre-#737 code did exactly that by taking the last match
 * in the whole buffer regardless of which run it came from.
 */

/** Bun prints this once per invocation; it is the only run boundary available. */
const RUN_BANNER = /^bun test v.*$/gm;

const PASS_LINE = /^\s*(\d+)\s+pass\s*$/gm;
const FAIL_LINE = /^\s*(\d+)\s+fail\s*$/gm;

export interface RunSummary {
  pass: number;
  fail: number;
}

export interface GateRun {
  /** 0-based position in the buffer. */
  index: number;
  /** This run's slice of the buffer, verbatim. Concatenated, the runs ARE the buffer. */
  text: string;
  /** The run's own summary, or null when it printed none. */
  summary: RunSummary | null;
}

export interface GateBufferReading {
  /** The one discriminator. Everything else is a projection of `runs`. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  runs: GateRun[];
  /**
   * The run whose verdict counts — the last one. `null` under an UNMEASURED
   * reading, so a caller cannot read numbers off a buffer that has none.
   */
  verdict: GateRun | null;
}

function summaryOf(text: string): RunSummary | null {
  // Last within THIS run: bun prints one summary per invocation, but a
  // nested runner or a wrapper can emit more, and the final one is the
  // run's own. Scoped to the slice, never to the document.
  const passes = [...text.matchAll(PASS_LINE)];
  const fails = [...text.matchAll(FAIL_LINE)];
  if (passes.length === 0 && fails.length === 0) return null;
  return {
    pass: passes.length > 0 ? parseInt(passes[passes.length - 1][1], 10) : 0,
    fail: fails.length > 0 ? parseInt(fails[fails.length - 1][1], 10) : 0,
  };
}

/**
 * Split a runner buffer into runs, and say which one is the verdict.
 *
 * The ONE binding. `fails`, `passes` and the per-check results are all
 * derived from this split by `parseGateResults`, so the two readings cannot
 * be scoped differently again — which was the whole defect.
 *
 * Text before the first banner belongs to the first run, so for a buffer
 * with one run the slice is the buffer byte for byte. That is asserted
 * rather than promised (#737 SC-6): this change has to be provably confined
 * to the multi-run case.
 */
export function splitGateRuns(buffer: string): GateBufferReading {
  const starts = [...buffer.matchAll(RUN_BANNER)].map(m => m.index!);
  // Run 0 starts at byte 0 whether or not a banner does, so a preamble
  // belongs to the first run rather than becoming a run of its own. Only
  // the SECOND banner onwards opens a new run.
  const bounds = [0, ...starts.slice(1)];

  const runs: GateRun[] = bounds.map((start, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1] : buffer.length;
    const text = buffer.slice(start, end);
    return { index: i, text, summary: summaryOf(text) };
  });

  const reasons: string[] = [];
  // An empty buffer agrees with every claim. Said first, because the
  // summary check below cannot distinguish "no runs" from "one clean run".
  if (buffer.trim() === "") {
    reasons.push("the runner produced no output at all, so no run can be read from it");
  } else if (runs[runs.length - 1].summary === null) {
    reasons.push(
      `the last of ${runs.length} run(s) in the buffer printed no summary line, so its ` +
        `pass/fail counts are unknown. Taking an earlier run's numbers would report a ` +
        `superseded attempt as this one's result (#469).`,
    );
  }

  return {
    reading: reasons.length === 0 ? "MEASURED" : "UNMEASURED",
    unmeasuredReasons: reasons,
    runs,
    verdict: reasons.length === 0 ? runs[runs.length - 1] : null,
  };
}
