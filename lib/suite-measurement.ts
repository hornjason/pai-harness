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
  // Symbols and functions stringify to undefined, which would read as a hole
  // in the message rather than as a description of the value.
  return JSON.stringify(v) ?? String(v);
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

/**
 * Whether a suite reading is about the commit a run is shipping.
 *
 * Two failures, two words, deliberately not collapsed into one:
 *
 *  - `STALE` — the suite WAS measured, against a commit the branch has since
 *    moved past. A contradiction the run can name, and a hard refusal: a count
 *    predating the final commit cannot satisfy a gate.
 *  - `UNRECORDED` — nothing usable was written down. An absence, not a
 *    contradiction. It must never read as clean, but aborting every run that
 *    has not recorded a SHA yet would brick the harness, so it resolves to an
 *    UNMEASURED reading and caps the terminal status instead.
 *
 * An abbreviation matches in either direction: `measuredSha` arrives through
 * an agent reading workflow-state.json and `headSha` from `git rev-parse`, so
 * either may be short.
 */
export type SuiteCurrencyState = "CURRENT" | "STALE" | "UNRECORDED";

export interface SuiteCurrency {
  state: SuiteCurrencyState;
  /** Why the reading is not CURRENT. Null — and only null — when it is. */
  reason: string | null;
}

/**
 * FAILS CLOSED, and never throws, for the same reason as the rest of this
 * module: it decides whether a run may ship, and a throw is a refusal the
 * caller's error handling could turn back into a ship.
 *
 * `workflows/ship.js` carries an INLINED COPY of this function inside
 * `SUITE-CURRENCY` markers — the Workflow sandbox has no module loading and a
 * top-level require() there killed every ship run before it spawned an agent
 * (#69). This is the source of truth; the copy is held to it by
 * test/suite-measurement-parity.test.ts, which extracts the block, executes
 * it, and drives both over one input matrix. Change one, change the other.
 */
export function suiteCurrency(measuredSha: unknown, headSha: unknown): SuiteCurrency {
  const measured = suiteMeasurementSha(measuredSha);
  const head = suiteMeasurementSha(headSha);

  if (!measured) {
    return {
      state: "UNRECORDED",
      reason:
        `the suite result records ${describe(measuredSha)} as the commit it was ` +
        `measured against, which is not a commit SHA — a count with no SHA is not evidence`,
    };
  }
  if (!head) {
    return {
      state: "UNRECORDED",
      reason:
        `the branch tip read at ship time is ${describe(headSha)}, not a commit SHA, ` +
        `so the suite result measured against ${measured} cannot be confirmed against it`,
    };
  }
  if (!(measured.startsWith(head) || head.startsWith(measured))) {
    return {
      state: "STALE",
      reason:
        `the suite result is stale: it was measured against ${measured} but the branch now ends ` +
        `at ${head} — the count did not come from the tree this run would ship`,
    };
  }
  return { state: "CURRENT", reason: null };
}
