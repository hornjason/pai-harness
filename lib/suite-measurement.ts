/**
 * The suite result, and the commit it was measured against (#224).
 *
 * Run `wf_7ac5f614-d21` reported `{"status":"SHIPPED","regressions":0}` over
 * `worktree-wf_7ac5f614-d21-9`. Checked out, that branch's suite reported one
 * failing test — a guard from #149 that had caught a real regression, named
 * it, and pointed at the file. The guard worked. The number the run published
 * did not come from the tree being shipped, and nothing could tell, because a
 * count with no commit attached cannot be checked against anything.
 *
 * Two facts have to be inseparable for that to be detectable:
 *
 *   1. A suite result carries the SHA it was measured against. A count on its
 *      own is not evidence; it is a number whose provenance was discarded.
 *   2. The absence of a result is its own verdict. "Nobody measured" and "it
 *      measured clean" serialise to the same object as soon as a missing
 *      record is allowed to default to zero failures — which is the shape of
 *      every fail-open in .claude/rules/checks-must-be-able-to-fail.md.
 *
 * So this module has three verdicts, not two, and UNMEASURED is the one it
 * reaches for whenever it cannot positively establish both facts. Nothing here
 * throws: it is read on the path that decides whether a run may ship, and a
 * throw is a refusal the caller's error handling can turn back into a ship.
 */

/** A commit SHA: 7-40 hex, case-insensitive. Normalised to lowercase. */
const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * UNMEASURED is not a result. It is the statement that this run has no suite
 * evidence, and it is deliberately not writable — see gates/schema.ts, which
 * accepts PASS and FAIL only. A recorded UNMEASURED would be a measurement
 * saying there was no measurement.
 */
export type SuiteVerdict = "PASS" | "FAIL" | "UNMEASURED";

/** What a recorder persists at `suiteMeasurement` in workflow-state.json. */
export interface SuiteMeasurement {
  verdict: "PASS" | "FAIL";
  /** The commit the suite actually ran against. */
  measuredSha: string;
  /** Failing tests. 0 for a PASS, at least 1 for a FAIL. */
  failures: number;
  measuredAt?: string;
}

export interface SuiteReading {
  verdict: SuiteVerdict;
  /**
   * The failing-test count, or null when the suite was not measured.
   *
   * null rather than 0 on purpose. 0 is the answer a consumer adds up, and
   * "no failures recorded" counting as "no failures" is the whole of #224.
   */
  failures: number | null;
  /** The commit the count describes, or null when there isn't one. */
  measuredSha: string | null;
  /** Why the reading is UNMEASURED. Null — and only null — when it is not. */
  reason: string | null;
}

/**
 * The SHA a measurement is pinned to, or null.
 *
 * Returning null rather than a fallback is the point: there is no safe default
 * commit for a suite result, and "it must have been HEAD" is the assumption
 * that let an unpinned count stand in for a measured one.
 */
export function suiteMeasurementSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SHA.test(trimmed) ? trimmed.toLowerCase() : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "object") return "an object";
  return JSON.stringify(v);
}

function unmeasured(reason: string): SuiteReading {
  return { verdict: "UNMEASURED", failures: null, measuredSha: null, reason };
}

/**
 * Resolve the suite verdict carried by a workflow state.
 *
 * FAILS CLOSED EVERYWHERE. A state that is not an object, a missing record, a
 * record with no SHA, a malformed SHA, a count that is not a count, a verdict
 * nobody recognises, and a verdict its own count contradicts all return
 * UNMEASURED. Each of those is the absence of a usable measurement, and the
 * one thing this function may never do is turn an absence into a PASS.
 *
 * The contradiction cases are here rather than left to the schema because the
 * schema guards the write path only. A file edited by hand, produced by an
 * older harness, or merged from somewhere else reaches this function without
 * ever passing through writeWorkflowState, and `{"verdict":"PASS",
 * "failures":3}` is not a result anyone can act on in either direction.
 */
export function readSuiteMeasurement(state: unknown): SuiteReading {
  if (!isRecord(state)) {
    return unmeasured(
      `the suite was not measured: the workflow state is ${describe(state)}, so it carries no suite result`,
    );
  }

  const raw = state.suiteMeasurement;
  if (!isRecord(raw)) {
    return unmeasured(
      `the suite was not measured: workflow-state.json has no suiteMeasurement record (got ${describe(raw)}) — ` +
        `no run of the suite has been bound to a commit, so there is no failure count to read`,
    );
  }

  const measuredSha = suiteMeasurementSha(raw.measuredSha);
  if (!measuredSha) {
    return unmeasured(
      `the suite measurement is not bound to a commit: measuredSha is ${describe(raw.measuredSha)}, not a ` +
        `commit SHA — a count that cannot be checked against the tree being shipped is not evidence (#224)`,
    );
  }

  const failures = raw.failures;
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) {
    return unmeasured(
      `the suite measurement for ${measuredSha} has no usable failure count (got ${describe(failures)})`,
    );
  }

  const verdict = raw.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return unmeasured(
      `the suite measurement for ${measuredSha} carries no usable verdict (got ${describe(verdict)}) — ` +
        `only PASS and FAIL are results; anything else means the suite was not measured`,
    );
  }

  if (verdict === "PASS" && failures > 0) {
    return unmeasured(
      `the suite measurement for ${measuredSha} contradicts itself: PASS with ${failures} failing test(s) — ` +
        `refusing to read it as either result`,
    );
  }
  if (verdict === "FAIL" && failures === 0) {
    return unmeasured(
      `the suite measurement for ${measuredSha} contradicts itself: FAIL with no failing tests — ` +
        `refusing to read it as either result`,
    );
  }

  return { verdict, failures, measuredSha, reason: null };
}
