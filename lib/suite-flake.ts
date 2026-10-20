/**
 * #323 SC-5 — whether a series of suite runs says anything.
 *
 * `lib/suite-run-reading.ts` reads ONE run. This reads a SERIES, and the two
 * questions are genuinely different: a run is clean or it is not, and a
 * series is consistent, flaky, failing, or not a series at all.
 *
 * One binding, because the interesting part is not any single run — it is
 * the relationship between them, and a caller composing its own verdict
 * would get that relationship right on the series it had seen and wrong on
 * the one that matters. `scripts/suite-flake-run.ts` executes the runs and
 * decides nothing.
 */
import { describeSuiteFailures, type SuiteRun } from "./suite-run-reading";

/**
 * What tree a run was taken against.
 *
 * `head` alone is not enough: the suites #323 suspects write scratch
 * directories under the repository, and a run that dirties the tree it is
 * measuring has changed the input to the next run without moving HEAD. The
 * dirty list is `git status --porcelain` paths.
 */
export interface TreeSignature {
  head: string;
  dirty: string[];
}

/**
 * How the process ended, which no reading of its TEXT can establish.
 *
 * `readSuiteRun` deliberately takes no exit code: #469's run exited 0 having
 * measured nothing and run `39405680063` exited `null` having measured
 * nothing, and nothing in either output says which way to resolve that. A
 * SIGNAL is not ambiguous — but only the process's caller ever sees one, so
 * it is carried here and read by the series.
 */
export interface RunExit {
  status: number | null;
  signal: string | null;
  /** The spawn's own error, e.g. `ENOBUFS`, which names the cause. */
  error: string | null;
}

export interface FlakeRun {
  /** 1-based, so a reason can name the run an operator will look for. */
  index: number;
  signature: TreeSignature;
  run: SuiteRun;
  /** Where the full output was kept. A failure that is not kept is #323. */
  log: string;
  seconds: number;
  exit: RunExit;
}

/**
 * Why a run's ENDING disqualifies it, or null.
 *
 * `bun test` exits 0 for a clean suite and 1 for a failing one. **1 must not
 * be refused**: refusing every non-zero exit would turn every FLAKY and
 * FAILING series into UNMEASURED and leave the instrument unable to report
 * its own subject.
 */
export function exitRefusal(exit: RunExit): string | null {
  if (exit.error !== null && exit.error !== "") {
    return `the spawn failed: ${exit.error}`;
  }
  if (exit.signal !== null) {
    return (
      `it was killed by ${exit.signal}, so its log ends wherever the process did — and a truncated log ` +
      "still parses as a clean reading when the output it captured contains a nested suite's summary, " +
      "which is how run 39405680063 reported CONSISTENT over ten killed runs (#323)"
    );
  }
  if (exit.status === null) {
    return "the spawn reported no exit status and no signal, so nothing says how it ended";
  }
  if (exit.status !== 0 && exit.status !== 1) {
    return `it exited ${exit.status}, which is not a verdict about the tests — bun uses 0 for a clean suite and 1 for a failing one`;
  }
  return null;
}

/**
 * CONSISTENT, FLAKY and FAILING are three facts, not two.
 *
 * A suite that fails every run is red — an ordinary thing to be, and
 * somebody's build to fix. A suite that fails SOME runs is the defect #323
 * is about. One word for both would leave the series unable to report its
 * own subject.
 */
export type FlakeVerdict = "CONSISTENT" | "FLAKY" | "FAILING" | "UNMEASURED";

/**
 * Whether the runs agreed about how much work they did.
 *
 * Reported BESIDE the verdict and never folded into it. The 2026-10-11
 * reading's only surviving lead is that the failing run executed 384 more
 * `expect()` calls than either clean one — so a varying count is a finding.
 * It is not, on its own, evidence that anything is wrong: a case enumerating
 * a directory legitimately varies. Folding it into the verdict would make
 * one of those two readings unavailable.
 *
 * `UNREPORTED` is first-class. A runner that printed no count and a runner
 * whose count held steady are opposite facts, and `STABLE` is the value that
 * would let a reader treat the first as the second.
 */
export type AssertionStability = "STABLE" | "VARIED" | "UNREPORTED";

export interface FlakeReading {
  verdict: FlakeVerdict;
  /** Why it is not CONSISTENT. Empty exactly when it is. */
  reasons: string[];
  assertions: AssertionStability;
  /** One entry per run, in order, `null` where the runner did not say. */
  assertionCounts: Array<number | null>;
  runs: number;
}

/**
 * One string per tree, so two readings can be compared without anybody
 * deciding field by field what counts as the same tree.
 *
 * The dirty list is sorted: `git status --porcelain` order is not a property
 * of the tree, and two runs differing only in it are one tree.
 */
export function treeSignatureKey(signature: TreeSignature): string {
  return `${signature.head}\n${[...signature.dirty].sort().join("\n")}`;
}

/** The runs that could be read at all. */
function measured(runs: FlakeRun[]) {
  return runs.flatMap(r => (r.run.status === "MEASURED" ? [{ entry: r, run: r.run }] : []));
}

/**
 * Read a series.
 *
 * FAILS CLOSED, like the single-run reader it sits on. Every path that
 * cannot positively establish that `minimum` readable runs were taken over
 * one tree returns UNMEASURED with reasons. There is no path that returns
 * CONSISTENT from a series that does not say so.
 */
export function flakeReading(runs: FlakeRun[], minimum: number): FlakeReading {
  const assertionCounts = runs.map(r => (r.run.status === "MEASURED" ? r.run.expectCalls : null));
  const reasons: string[] = [];

  // A short series first, because it explains every other absence. A job
  // that died after three runs has measured three runs, and ten is what was
  // asked for — the instrument failing is not the subject passing (#60).
  if (runs.length < minimum) {
    reasons.push(
      `only ${runs.length} of ${minimum} run(s) completed, so the series was cut short — ` +
        "a short series is not a clean series, however green the runs in it were (#323 SC-5)",
    );
  }

  // Every run that did not FINISH, before anything is read off its text.
  // This is the guard run 39405680063 did not have: ten children killed by
  // SIGTERM on a 1 MiB `maxBuffer` overflow, ten truncated logs whose only
  // surviving summary belonged to a nested suite, and a CONSISTENT verdict
  // over a suite of 5,500 tests reporting one pass.
  for (const r of runs) {
    const why = exitRefusal(r.exit);
    if (why !== null) reasons.push(`run ${r.index} did not finish (log ${r.log}): ${why}`);
  }

  // Every unreadable run, by index. An UNMEASURED run is not a clean run:
  // `readSuiteRun` returns it for a log that printed no summary, and this
  // repository's logs carry nested suites' summaries, so such a log still
  // contains the text a `grep "0 fail"` would match.
  for (const r of runs) {
    if (r.run.status !== "MEASURED") {
      reasons.push(`run ${r.index} could not be read (log ${r.log}): ${r.run.reason}`);
    }
  }

  // One tree, or it is not a series. Named by what differs, because
  // "the tree moved" tells nobody where to look and a scratch directory
  // appearing under the repository is SC-6's whole hypothesis.
  const trees = new Map<string, FlakeRun[]>();
  for (const r of runs) {
    const key = treeSignatureKey(r.signature);
    trees.set(key, [...(trees.get(key) ?? []), r]);
  }
  if (trees.size > 1) {
    const described = [...trees.entries()].map(([key, group]) => {
      const where = group.map(g => g.index).join(", ");
      const [head, ...dirty] = key.split("\n");
      const paths = dirty.filter(d => d !== "");
      return `run(s) ${where} at ${head}${paths.length === 0 ? " with a clean tree" : ` with ${paths.join(", ")}`}`;
    });
    reasons.push(
      `the tree changed during the series, so these runs did not measure one thing: ${described.join("; ")} ` +
        "— ten green runs over three trees is not ten green runs (#323 SC-5)",
    );
  }

  const counts = assertionCounts.filter((c): c is number => c !== null);
  const assertions: AssertionStability =
    counts.length !== runs.length || runs.length === 0
      ? "UNREPORTED"
      : new Set(counts).size === 1
        ? "STABLE"
        : "VARIED";

  if (reasons.length > 0) {
    return { verdict: "UNMEASURED", reasons, assertions, assertionCounts, runs: runs.length };
  }

  const readable = measured(runs);
  const failing = readable.filter(r => r.run.fail > 0);
  if (failing.length > 0) {
    for (const f of failing) {
      reasons.push(`run ${f.entry.index} (log ${f.entry.log}): ${describeSuiteFailures(f.run)}`);
    }
  }

  const verdict: FlakeVerdict =
    failing.length === 0 ? "CONSISTENT" : failing.length === readable.length ? "FAILING" : "FLAKY";

  return { verdict, reasons, assertions, assertionCounts, runs: runs.length };
}

/** The sentence a caller prints instead of the verdict on its own. */
export function describeFlakeReading(reading: FlakeReading): string {
  const { verdict, runs, assertions, assertionCounts, reasons } = reading;
  const counts = assertionCounts.filter((c): c is number => c !== null);
  const spread =
    assertions === "VARIED"
      ? ` The runs did not agree about how much work they did: ${Math.min(...counts)} to ` +
        `${Math.max(...counts)} expect() calls, a spread of ${Math.max(...counts) - Math.min(...counts)}. ` +
        "That is the only surviving lead from the 2026-10-11 reading (#323 SC-4)."
      : assertions === "UNREPORTED"
        ? " The runner did not report an assertion count for every run, so nothing is claimed about one."
        : ` Every run executed ${counts[0]} expect() calls.`;

  const failed = reasons.length;
  const head =
    verdict === "CONSISTENT"
      ? `CONSISTENT: ${runs} consecutive run(s) on one tree, none failing.`
      : verdict === "FLAKY"
        ? `FLAKY: ${failed} of ${runs} consecutive run(s) on one tree failed — the same tree, different answers.`
        : verdict === "FAILING"
          ? `FAILING: all ${runs} run(s) failed. The suite is red; this is not flake.`
          : `UNMEASURED: the series does not support a verdict.`;

  return [head, ...reasons.map(r => `  - ${r}`), spread.trim()].join("\n");
}
