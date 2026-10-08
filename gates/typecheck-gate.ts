/**
 * The comparison half of the `tsc-pass` gate check (#176).
 *
 * The check in gates/workflow.test.ts was two early returns and an empty tail:
 * no `expect`, no tsc invocation, no baseline comparison, under a name that
 * promises all three. Its second return read `environments.local.tests` and
 * bailed with the comment `// trust Marcus` — a gate asking the agent it is
 * gating whether it needs to run.
 *
 * The rules below are scripts/typecheck.ts's, with one deliberate difference:
 * that script is a ratchet and fails on FEWER errors than the baseline so
 * progress gets banked, while this is a gate on one issue's work and only owes
 * an answer to "did this run add errors". Unbanked progress warns here.
 *
 * Kept out of the test file so it can be unit-tested without spawning tsc, and
 * so the branches below are reachable from a test that plants each one.
 */

/** `path/to/file.ts(12,34): error TS1234: message` */
export const TSC_ERROR_LINE = /^\S.*\(\d+,\d+\): error TS\d+:/;

export function countTscErrors(output: string): number {
  return output.split("\n").filter((l) => TSC_ERROR_LINE.test(l)).length;
}

export interface TscRun {
  /** tsc's exit status, or null when it was killed or never started. */
  status: number | null;
  /** stdout and stderr concatenated — tsc writes diagnostics to stdout. */
  output: string;
}

/**
 * Everything wrong with this typecheck run. Empty means the gate passes.
 *
 * `baselineRaw` is the literal contents of the project's
 * `.claude/typecheck-baseline.json`, or null when the file is absent. Absent
 * means a declared tolerance of zero: a project that has not written the file
 * down has not claimed any errors are acceptable. Unreadable is NOT zero —
 * `{"error": 0}` is a one-character edit away from `{"errors": 0}` and reading
 * it as "no baseline" would disable the gate while still printing a result.
 */
export function typecheckFailures(run: TscRun, baselineRaw: string | null): string[] {
  const failures: string[] = [];

  const baseline = readBaseline(baselineRaw);
  if (typeof baseline === "string") return [baseline];

  // tsc with no usable config prints its help text and exits 1. Counting zero
  // parseable diagnostics out of that reads as a clean typecheck — the exact
  // defect #65/#76 found in the documented `bunx tsc --noEmit`.
  if (/tsc: The TypeScript Compiler/.test(run.output)) {
    return ["tsc printed its usage text instead of checking anything: " + run.output.slice(0, 300)];
  }

  const actual = countTscErrors(run.output);

  if (run.status === null) {
    return ["tsc did not run to completion (no exit status) — refusing to report a clean typecheck"];
  }

  // Config-level problems (TS18003 "no inputs were found", TS5083 "cannot read
  // file") carry no file(line,col) prefix, so the count is zero and the run
  // looks clean. Trust the exit status over the parse.
  if (run.status !== 0 && actual === 0) {
    failures.push(
      `tsc exited ${run.status} but produced no parseable diagnostics — treating as failure, ` +
        `not as a clean run:\n${run.output.slice(0, 500)}`,
    );
    return failures;
  }

  if (actual > baseline) {
    failures.push(
      `${actual} TypeScript errors, baseline is ${baseline} — ${actual - baseline} new error(s):\n` +
        run.output
          .split("\n")
          .filter((l) => TSC_ERROR_LINE.test(l))
          .slice(0, 20)
          .join("\n"),
    );
  } else if (actual < baseline) {
    // Not a gate failure: the gate's question is whether THIS run added
    // errors. Banking the progress is scripts/typecheck.ts's job.
    console.warn(
      `WARN: tsc-pass: ${actual} errors against a baseline of ${baseline} — ` +
        `bank it with \`bun scripts/typecheck.ts --update-baseline\` so it cannot drift back up.`,
    );
  }

  return failures;
}

/** The baseline count, or a failure message when the file cannot be trusted. */
function readBaseline(raw: string | null): number | string {
  if (raw === null) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `.claude/typecheck-baseline.json is not valid JSON: ${(e as Error).message}`;
  }
  const n = (parsed as { errors?: unknown } | null)?.errors;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    return (
      `.claude/typecheck-baseline.json has no integer "errors" field (got ${JSON.stringify(n)}). ` +
      `Refusing to report a result against a baseline I cannot read.`
    );
  }
  return n;
}
