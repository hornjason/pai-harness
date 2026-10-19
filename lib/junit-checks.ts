/**
 * Every check a gate run actually executed, read off bun's JUnit report (#532).
 *
 * ## Why the console output cannot answer this
 *
 * `gates/gate-executor.ts`'s `parseTestResults` scans for `(pass)` and
 * `(fail)` markers. Measured on bun 1.3.14, with stdout piped:
 *
 * ```
 * $ bun test p.test.ts            # 2 passing, 1 failing
 * (fail) beta fails [0.18ms]
 *  2 pass
 *  1 fail
 * ```
 *
 * **There are no `(pass)` lines.** The runner prints a marker for a failure
 * and a count for everything else, so the `(pass)` branch of
 * `parseTestResults` matches nothing on the runner this repo uses, and the
 * `results` array it returns is a FAILURE list wearing a neutral name.
 *
 * That is fine for the failure ledger, which is all it was ever read for.
 * It is fatal for #532: the retirement rule needs the names a later gate
 * **ran and did not fail**, and a failure list cannot name a single one of
 * them. Sourcing `checksRun` from `results` produced two entries out of a
 * hundred and seventeen on a real scope run — a positive witness that
 * witnesses nothing, which is this repo's central defect class
 * (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * ## Why the JUnit report can
 *
 * `--reporter=junit --reporter-outfile=<path>` writes every testcase, and it
 * runs ALONGSIDE the console output rather than replacing it — one spawn
 * still prints the `(fail)` markers the detail parser reads.
 *
 * ## The trap in it, and it is the dangerous direction
 *
 * A test excluded by `--test-name-pattern` is **still listed**, as a
 * `<skipped />`. Measured, with `-t "keep me"` over a file of five tests:
 *
 * ```xml
 * <testcase name="keep me one" classname="alpha group" ... />
 * <testcase name="skip me two" classname="alpha group" ...><skipped /></testcase>
 * ```
 *
 * The gate's whole pattern is an exclusion — the scope gate runs
 * `schema|scope` over `gates/`, so most of the file is filtered out on every
 * run. Counting a filtered test as "run" would retire a refusal the gate
 * never re-measured, which is worse than the bug #532 closes: it would erase
 * a true refusal rather than keep a stale one.
 *
 * So a `<skipped />` testcase is NOT a check that ran, and the count of them
 * is returned rather than discarded, because "ran 2, skipped 115" and
 * "ran 117" are different facts about the same report.
 *
 * ## Why the names are rebuilt from the element nesting
 *
 * `classname` looks like the obvious source and is not usable: bun emits the
 * describe chain REVERSED and double-escaped. Measured on a
 * `describe("outer") > describe("inner")`, whose console name is
 * `outer > inner > deep fails`:
 *
 * ```xml
 * <testcase name="deep fails" classname="inner &amp;gt; outer" ... />
 * ```
 *
 * The nested `<testsuite>` elements carry the same chain in the right order,
 * so the name is rebuilt from the stack. The outermost suite is the FILE —
 * its `name` is a path — and it is dropped, which is what makes the rebuilt
 * string match the `(fail)` marker the console printed for the same test.
 * That match is load-bearing: `checksRun` has to be a superset of
 * `failedChecks` or the subtraction in `lib/gate-refusal-currency.ts` reports
 * a still-failing check as resolved.
 */
import { readFileSync } from "fs";

/** What one JUnit report says about which checks ran. */
export interface JunitReading {
  /**
   * The full names of the checks that RAN — passed or failed. `null` when
   * the report could not be read, which is a different answer from `[]`
   * ("the report says nothing ran") and has to stay different all the way
   * to the consumer (.claude/rules/config-access.md, Silent Default
   * Substitution).
   */
  names: string[] | null;
  /** Why `names` is null, or why the reading is partial. */
  reason?: string;
  /** Testcases listed but not run — filtered out, `.skip`, or `.todo`. */
  skipped: number;
}

const ENTITIES: Array<[RegExp, string]> = [
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  // Last, so `&amp;gt;` decodes to `&gt;` and not to `>`.
  [/&amp;/g, "&"],
];

function unescapeXml(s: string): string {
  return ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

/** One testcase, as the report describes it. */
interface ScannedTestcase {
  /** The full name, rebuilt from the `<testsuite>` nesting. */
  name: string;
  /** The `time` attribute in MILLISECONDS, or `NaN` when it carries none. */
  ms: number;
  /** False for a `<skipped />` testcase — filtered out, `.skip` or `.todo`. */
  ran: boolean;
  /**
   * The `type` of the testcase's `<failure>`, or null if it did not fail.
   * bun writes `TimeoutError` for a test the runner killed and
   * `AssertionError` for one that failed on its merits — the distinction
   * #621 is entirely about, and the only place in the run where it survives
   * in machine-readable form.
   */
  failure: string | null;
}

const NOT_A_REPORT = "no <testsuites> root — this is not a bun JUnit report";

/**
 * Every testcase in the report, in document order, or `null` when the input
 * is not a bun JUnit report.
 *
 * Written as a tag scanner rather than with an XML library because the only
 * structure it needs is the `<testsuite>` nesting depth, and a dependency
 * that parses the whole document would be a larger surface for a smaller
 * answer.
 *
 * ONE scanner, two public readings. The names (#532) and the durations
 * (#621) are different questions about the same elements, and a second
 * scanner would be a second place for "a `<skipped />` testcase did not run"
 * to be decided — so a mutation of either would leave the other holding the
 * answer up (.claude/rules/checks-must-be-able-to-fail.md, the fourth shape).
 */
function scanJunitTestcases(xml: string): { cases: ScannedTestcase[]; skipped: number } | null {
  if (!xml.includes("<testsuites")) return null;

  const cases: ScannedTestcase[] = [];
  const suites: string[] = [];
  let skipped = 0;

  // `pending` is non-null between a `<testcase>` open tag and its close.
  let pending: ScannedTestcase | null = null;

  const TOKEN = /<(\/?)(testsuite|testcase|skipped|failure|error)\b([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(TOKEN)) {
    const [, closing, tag, rest, selfClosing] = m;
    if (tag === "testsuite") {
      if (closing) {
        suites.pop();
      } else if (!selfClosing) {
        suites.push(attr(rest, "name") ?? "");
      }
      continue;
    }
    if (tag === "testcase") {
      if (closing) {
        if (pending !== null) cases.push(pending);
        pending = null;
        continue;
      }
      // The first suite on the stack is the FILE, whose name is a path.
      // Everything above it is a `describe`.
      const testcase: ScannedTestcase = {
        name: [...suites.slice(1), attr(rest, "name") ?? ""].join(" > "),
        ms: durationMs(rest),
        ran: true,
        failure: null,
      };
      if (selfClosing) {
        cases.push(testcase);
      } else {
        pending = testcase;
      }
      continue;
    }
    if (tag === "skipped" && !closing && pending !== null) {
      pending.ran = false;
      skipped++;
    }
    if (tag === "failure" && !closing && pending !== null) {
      pending.failure = attr(rest, "type") ?? "";
    }
  }

  return { cases, skipped };
}

/**
 * The `time` attribute in milliseconds.
 *
 * bun writes it in fractional SECONDS — `time="1.201579"` for a test the
 * console printed as `[1201.58ms]`. Reading it as milliseconds would put
 * every duration a thousand times below any budget it is compared against,
 * and a proximity check over it would be green for every suite that has ever
 * run (#621).
 */
function durationMs(tag: string): number {
  const raw = attr(tag, "time");
  if (raw === null || raw.trim() === "") return NaN;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : NaN;
}

/** The names of every testcase the report says RAN, in document order. */
export function parseJunitCheckNames(xml: string): JunitReading {
  const scan = scanJunitTestcases(xml);
  if (scan === null) return { names: null, skipped: 0, reason: NOT_A_REPORT };
  return { names: scan.cases.filter(c => c.ran).map(c => c.name), skipped: scan.skipped };
}

/** `parseJunitCheckNames` over a file, with the read failure as a reading. */
export function readJunitCheckNames(path: string): JunitReading {
  let xml: string;
  try {
    xml = readFileSync(path, "utf-8");
  } catch (e: any) {
    // The name, not the message: a reader error quotes the path and this
    // string is written into workflow-state.json.
    return { names: null, skipped: 0, reason: `the JUnit report could not be read (${e?.code || e?.name || "unknown"})` };
  }
  return parseJunitCheckNames(xml);
}

/** What one JUnit report says about which checks PASSED (#659). */
export interface JunitOutcomeReading {
  /**
   * Full names of the testcases that ran and did not fail. `null` when the
   * report could not be read — a different answer from `[]`, which says the
   * report ran nothing, and the two must stay different all the way to the
   * consumer.
   */
  passed: string[] | null;
  /** Full names of the testcases that ran and failed. Empty when unreadable. */
  failed: string[];
  /** Why `passed` is null. */
  reason?: string;
}

/**
 * Pass and fail, off the SAME scan the names reading uses (#659).
 *
 * `lib/test-case-deletion.ts` needs to prove a deleted case was GREEN before
 * it was deleted, and `parseJunitCheckNames` answers "did it run", which is
 * satisfied by a case that ran and failed. A second scanner for the second
 * question would be two deciders for one document: both would agree on every
 * report anyone has, and a mutation of either would leave the other holding
 * the answer up (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth
 * shape). So the answer comes out of `scanJunitTestcases`, which already
 * records each testcase's `<failure>`.
 *
 * A `<skipped />` testcase is in NEITHER list. It did not run, so it did not
 * pass — and reading a filtered-out case as green is exactly the trap #532
 * records about this report format.
 */
export function parseJunitOutcomes(xml: string): JunitOutcomeReading {
  const scan = scanJunitTestcases(xml);
  if (scan === null) return { passed: null, failed: [], reason: NOT_A_REPORT };
  const ran = scan.cases.filter(c => c.ran);
  return {
    passed: ran.filter(c => c.failure === null).map(c => c.name),
    failed: ran.filter(c => c.failure !== null).map(c => c.name),
  };
}

/** `parseJunitOutcomes` over a file, with the read failure as a reading. */
export function readJunitOutcomes(path: string): JunitOutcomeReading {
  let xml: string;
  try {
    xml = readFileSync(path, "utf-8");
  } catch (e: any) {
    return { passed: null, failed: [], reason: `the JUnit report could not be read (${e?.code || e?.name || "unknown"})` };
  }
  return parseJunitOutcomes(xml);
}

/**
 * The full witness: every check the gate reported a verdict for.
 *
 * The JUnit report covers the bun tests. `reported` covers everything else
 * the gate decided on its own — `test-census: UNMEASURED`,
 * `ac-verdict-fail: AC-2`, the dev-server liveness probe — which are real
 * verdicts with no testcase behind them, and which appear in the failure
 * ledger. Leaving them out would break the superset property in exactly the
 * places where the names are not bun's.
 *
 * `null` in, `null` out. A gate whose report could not be read says nothing
 * about what it ran, and must retire nothing.
 */
export function checksRunFrom(reading: JunitReading, reported: string[]): string[] | null {
  return unionNames(reading.names, reported);
}

/**
 * `base` with `extra` appended, de-duplicated, order preserved. `null`
 * propagates.
 *
 * Exported because the union has to be applied twice: once at the gate's
 * call site, and again inside `writeGateResult`, which pushes
 * `ac-verdict-fail:` entries of its own AFTER the caller has read the
 * results. A second union there is not a second decider — it is the same
 * function over a later reading of the same list, and skipping it would
 * leave `checksRun` short of `failures` by exactly the entries that gate
 * adds last.
 */
export function unionNames(base: string[] | null, extra: string[]): string[] | null {
  if (base === null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...base, ...extra]) {
    if (typeof name !== "string" || name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────────
 * #621: how close the suite ran to the per-test timeout
 *
 * The same report, asked a different question. #621's 122 "failures" were
 * 122 timeouts: every one at or above bun's 5000ms per-test budget, 112
 * carrying `timed out after 5000ms`, and not one an assertion failure. A
 * verdict like that is a fact about machine load, not about the code.
 *
 * The warning is in the durations. A test at 99% of the budget passes today
 * and is killed the first time it runs beside 27 agents, and the console
 * output says nothing about it — only the JUnit report carries a number for
 * every testcase.
 *
 * TWO READINGS, NOT ONE VERDICT. `durationCoverageViolations` answers "did
 * this reading read anything?" and `timeoutProximityViolations` answers "is
 * anything it read near the budget?". An empty report satisfies the second
 * perfectly, which is why the first exists and why the proximity check stays
 * SILENT on an empty reading instead of refusing it: if both refused, they
 * would be one question with two names, and nothing could tell a report that
 * is clean from a reader that stopped reading (AC-7).
 * ──────────────────────────────────────────────────────────────────────── */

/** One testcase's measured duration. */
export interface TestcaseDuration {
  /** The full name, as the console prints it. */
  name: string;
  /** Milliseconds. */
  ms: number;
  /** The runner killed it: bun wrote `<failure type="TimeoutError" />`. */
  timedOut: boolean;
}

/** What one JUnit report says about how long its testcases took. */
export interface JunitDurationReading {
  /**
   * Every testcase that RAN and carried a readable duration. `null` when the
   * report could not be read at all — a different answer from `[]` ("the
   * report lists nothing"), and the two have to stay different all the way to
   * the consumer (.claude/rules/config-access.md, Silent Default
   * Substitution).
   */
  durations: TestcaseDuration[] | null;
  /** How many durations were read. The reading's own coverage (AC-7a). */
  count: number;
  /** Testcases listed but not run — filtered out, `.skip`, or `.todo`. */
  skipped: number;
  /**
   * Testcases that ran and carried no readable `time`. Counted rather than
   * dropped: a reader that silently shrinks its own population reports a
   * clean proximity check over the half it managed to parse.
   */
  withoutDuration: number;
  /** Why `durations` is null. */
  reason?: string;
}

/** Every testcase duration the report carries, in document order. */
export function parseJunitDurations(xml: string): JunitDurationReading {
  const scan = scanJunitTestcases(xml);
  if (scan === null) {
    return { durations: null, count: 0, skipped: 0, withoutDuration: 0, reason: NOT_A_REPORT };
  }
  const ran = scan.cases.filter(c => c.ran);
  const durations = ran
    .filter(c => Number.isFinite(c.ms))
    .map(c => ({ name: c.name, ms: c.ms, timedOut: c.failure === "TimeoutError" }));
  return {
    durations,
    count: durations.length,
    skipped: scan.skipped,
    withoutDuration: ran.length - durations.length,
  };
}

/** `parseJunitDurations` over a file, with the read failure as a reading. */
export function readJunitDurations(path: string): JunitDurationReading {
  let xml: string;
  try {
    xml = readFileSync(path, "utf-8");
  } catch (e: any) {
    return {
      durations: null,
      count: 0,
      skipped: 0,
      withoutDuration: 0,
      // The name, not the message: a reader error quotes the path.
      reason: `the JUnit report could not be read (${e?.code || e?.name || "unknown"})`,
    };
  }
  return parseJunitDurations(xml);
}

/**
 * The per-test timeout a `bunfig.toml` declares, or `null` if it declares
 * none.
 *
 * Scoped to the `[test]` table and nothing else. A `timeout` under
 * `[install]` is a different setting entirely, and a reader that matched the
 * key anywhere in the document would measure the suite against a number
 * about package downloads — searching the document instead of the slice is
 * how three checks in this repo went green over text they were not about
 * (.claude/rules/checks-must-be-able-to-fail.md).
 */
export function bunfigTestTimeoutMs(toml: string): number | null {
  const lines = toml.split("\n");
  const start = lines.findIndex(line => /^\s*\[test\]\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^\s*\[/.test(line));
  const section = (end === -1 ? rest : rest.slice(0, end)).join("\n");
  const m = /^\s*timeout\s*=\s*(\d+)\s*(#.*)?$/m.exec(section);
  return m ? Number(m[1]) : null;
}

/**
 * What is wrong with the READING, before anything is concluded from it
 * (AC-7a).
 *
 * A scan that reports a verdict should report its own coverage: "0 of 0 are
 * near the budget" and "0 of 13358 are near the budget" are the same PASS
 * today, and no reader can tell them apart from the output.
 */
export function durationCoverageViolations(reading: JunitDurationReading, source: string): string[] {
  if (reading.durations === null) {
    return [
      `the JUnit report at ${source} could not be read (${reading.reason ?? "no reason recorded"}), ` +
        `so nothing is known about how long anything took (#621)`,
    ];
  }
  const out: string[] = [];
  if (reading.count === 0) {
    out.push(
      `the JUnit report at ${source} carries no testcase durations (0 read, ${reading.skipped} skipped) — ` +
        `an empty report satisfies a proximity check by having nothing in it, which is not a measurement (#621)`,
    );
  }
  if (reading.withoutDuration > 0) {
    out.push(
      `${reading.withoutDuration} of ${reading.withoutDuration + reading.count} testcases that ran in ${source} ` +
        `carry no readable time attribute — the reading is partial, and the missing ones are exactly the ` +
        `population a proximity check cannot see (#621)`,
    );
  }
  return out;
}

/**
 * Every testcase the per-test budget is about to kill, or already killed —
 * named, with its duration (AC-3b).
 *
 * ## Three classes, and only two of them are findings
 *
 * | What the report shows | What it means | Reported |
 * |---|---|---|
 * | `<failure type="TimeoutError" />` | the runner killed it | **yes** — this is #621's 122 |
 * | ran, and finished inside the band `[timeout·(1−f), timeout)` | it is next | **yes** — the warning |
 * | ran, and finished at or past `timeout` without timing out | it was given a BIGGER budget, or it could not have got there | no |
 *
 * The third row is the one that keeps this check usable. A test carrying
 * `}, 240000)` — `gates/workflow.test.ts`'s typecheck check, measured at
 * 16770ms — is not at risk from a 5000ms default, and reporting it would
 * make the check red on every run forever. A gate that cries wolf trains its
 * reader to ignore it, which is the cost #621 is filed about; so the rule is
 * that **a duration past the budget is itself the evidence that the budget
 * is not this test's**.
 *
 * It follows that declaring a per-test timeout silences a row here, and that
 * is deliberate: an 8-second test that says it needs 8 seconds is a decision
 * somebody made, and an 8-second test that nobody budgeted for is a timeout
 * waiting for a loaded machine. Raising the FILE-wide default to silence a
 * row is the repair #621 refuses, and it is refused where the default is
 * declared rather than here.
 *
 * SILENT on a reading of nothing, deliberately — see the header above.
 * `durationCoverageViolations` is the question about an empty reading, and
 * keeping them apart is what makes a red row say which one broke.
 */
export function timeoutProximityViolations(
  reading: JunitDurationReading,
  timeoutMs: number,
  withinFraction = 0.01,
): string[] {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return [
      `no usable per-test timeout to compare against (${timeoutMs}) — a budget of zero or NaN makes every ` +
        `comparison below meaningless rather than clean (#621)`,
    ];
  }
  if (reading.durations === null) return [];
  const floor = timeoutMs * (1 - withinFraction);
  const out: string[] = [];
  for (const d of reading.durations) {
    if (d.timedOut) {
      out.push(
        `${d.name} was KILLED after ${d.ms.toFixed(2)}ms by a per-test timeout — it did not fail on its ` +
          `merits, and on a less loaded machine it would not have failed at all (#621)`,
      );
      continue;
    }
    if (d.ms >= floor && d.ms < timeoutMs) {
      out.push(
        `${d.name} took ${d.ms.toFixed(2)}ms, ${((d.ms / timeoutMs) * 100).toFixed(1)}% of the ${timeoutMs}ms ` +
          `per-test timeout — within ${withinFraction * 100}% of being killed instead of failing on its merits. ` +
          `Make it faster, or give it a budget of its own with a per-test timeout argument (#621)`,
      );
    }
  }
  return out;
}
