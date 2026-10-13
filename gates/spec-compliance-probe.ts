/**
 * Did the spec-compliance suite drift, pass, or not run at all? (#197)
 *
 * The scope gate shelled out to `bun test test/spec-compliance.test.ts
 * test/spec-compliance-auto.test.ts` and wrapped it in a try/catch. `execSync`
 * throws on any non-zero exit, and bun exits non-zero both when tests fail
 * and when the files do not exist, so the catch arm printed
 *
 *     SPEC DRIFT DETECTED: spec-compliance tests failed
 *
 * followed by an empty list of failures. Every fixture project in the suite
 * produced that line — four times in one clean-env run — because fixtures are
 * not this repo and have no spec-compliance suite.
 *
 * Two defects in one output, and both are this codebase's recurring shape:
 * "the suite failed" and "there is no suite" were one fact, and an alarm
 * naming zero drifted claims teaches its reader to skip the line. A line
 * everyone skips is the same as no line, on the run where it matters.
 *
 * Extracted to its own module rather than fixed in place so the
 * classification is one exported function with no `execSync` in it — the
 * single mutatable binding, drivable from fixtures.
 */
import { existsSync } from "fs";
import { join } from "path";

/** The files the probe runs. Read by the caller, never restated by it. */
export const SPEC_COMPLIANCE_FILES = [
  "test/spec-compliance.test.ts",
  "test/spec-compliance-auto.test.ts",
] as const;

export interface SpecComplianceRun {
  /** Did the command exit zero? */
  ok: boolean;
  /** Everything it printed, stdout and stderr together. */
  output: string;
  /** Files from SPEC_COMPLIANCE_FILES that are not present. */
  missing: string[];
}

export interface SpecComplianceVerdict {
  verdict: "PASS" | "DRIFT" | "UNMEASURED";
  detail: string;
  /** The `(fail)` lines, when there are any. */
  failures: string[];
}

/**
 * What `execSync` printed before it threw.
 *
 * Here rather than inline at the call site for two reasons. `e.stdout` carries
 * the pass/fail summary and `e.message` does not, so reading the message first
 * would throw away the only reading in the box — and a classifier handed a
 * message instead of a summary returns UNMEASURED for every ordinary failing
 * run, which is the alarm-off direction. The second reason is mechanical: it
 * leaves the gate's block free of type annotations, so the wiring test can
 * execute the real source rather than grep it.
 */
export function execErrorOutput(e: unknown): string {
  const err = e as { stdout?: unknown; message?: unknown };
  if (typeof err?.stdout === "string" && err.stdout.length > 0) return err.stdout;
  if (err?.stdout instanceof Uint8Array) return new TextDecoder().decode(err.stdout);
  if (typeof err?.message === "string") return err.message;
  return "";
}

/** Which of the probe's files this project does not have. */
export function missingSpecComplianceFiles(root: string): string[] {
  return SPEC_COMPLIANCE_FILES.filter(f => !existsSync(join(root, f)));
}

/**
 * Three outcomes, because there are three facts.
 *
 * Order matters. A non-zero exit WITH a parsed failure count is DRIFT, not
 * UNMEASURED — classifying the ordinary failing case as unmeasured would turn
 * the real alarm off, which is the opposite mistake and the more expensive
 * one. UNMEASURED is only for a run that produced no reading to interpret.
 */
export function classifySpecComplianceRun(run: SpecComplianceRun): SpecComplianceVerdict {
  const failures = run.output.split("\n").filter(l => l.includes("(fail)"));

  // A project with NONE of the files is a project without the suite — every
  // fixture in this repo's own test tree. A project with SOME of them is a
  // different fact entirely: a file that was deleted, renamed or never
  // generated, in a repo that is supposed to have it. Collapsing the two
  // would mean deleting one of the two files silences the gate with the
  // reassuring words "this project has no spec-compliance suite".
  if (run.missing.length >= SPEC_COMPLIANCE_FILES.length) {
    return {
      verdict: "UNMEASURED",
      detail:
        `this project has no spec-compliance suite — missing ${run.missing.join(", ")}. ` +
        `Nothing drifted; nothing was checked.`,
      failures: [],
    };
  }
  if (run.missing.length > 0) {
    return {
      verdict: "DRIFT",
      detail:
        `the spec-compliance suite is incomplete — ${run.missing.join(", ")} ` +
        `${run.missing.length === 1 ? "is" : "are"} gone, but the rest of the suite is here. ` +
        `A project that has part of the suite is missing the other part, not exempt from it.`,
      failures: run.missing.map(f => `(fail) missing spec-compliance file: ${f}`),
    };
  }

  const failMatch = /(\d+)\s+fail/.exec(run.output);
  const passMatch = /(\d+)\s+pass/.exec(run.output);
  if (!failMatch && !passMatch) {
    return {
      verdict: "UNMEASURED",
      detail:
        `the spec-compliance command produced no pass/fail summary, so there is no reading to ` +
        `interpret: ${run.output.trim().split("\n").slice(-3).join(" / ").slice(0, 200)}`,
      failures,
    };
  }

  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  if (failed > 0) {
    return {
      verdict: "DRIFT",
      detail: `${failed} spec-compliance check(s) failed — ship.js has diverged from its spec`,
      failures,
    };
  }

  // The command said it failed and the summary says nothing did. Both
  // readings are real and they disagree, so there is no result here — a
  // timeout, a crash after the summary printed, a non-zero exit from
  // something downstream of the tests. `ok` was in this interface and unread
  // for a while, which meant any of those classified as a clean PASS.
  if (!run.ok) {
    return {
      verdict: "UNMEASURED",
      detail:
        `the spec-compliance command exited non-zero but its summary reports no failures — ` +
        `the two readings disagree, so neither is a result: ` +
        `${run.output.trim().split("\n").slice(-3).join(" / ").slice(0, 200)}`,
      failures,
    };
  }

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  if (passed === 0) {
    // Reachable since #343 emptied the generated file: a pair that between
    // them runs nothing has not shown that ship.js matches the spec.
    return {
      verdict: "UNMEASURED",
      detail: "the spec-compliance suite ran 0 checks — that is not a clean result",
      failures,
    };
  }

  return { verdict: "PASS", detail: `${passed} checks PASS — ship.js matches spec`, failures };
}
