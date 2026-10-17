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

/**
 * The names of every testcase the report says RAN, in document order.
 *
 * Written as a tag scanner rather than with an XML library because the only
 * structure it needs is the `<testsuite>` nesting depth, and a dependency
 * that parses the whole document would be a larger surface for a smaller
 * answer.
 */
export function parseJunitCheckNames(xml: string): JunitReading {
  if (!xml.includes("<testsuites")) {
    return { names: null, skipped: 0, reason: "no <testsuites> root — this is not a bun JUnit report" };
  }

  const names: string[] = [];
  const suites: string[] = [];
  let skipped = 0;

  // `pending` is non-null between a `<testcase>` open tag and its close.
  let pending: string | null = null;
  let pendingRan = true;

  const TOKEN = /<(\/?)(testsuite|testcase|skipped|error)\b([^>]*?)(\/?)>/g;
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
        if (pending !== null && pendingRan) names.push(pending);
        pending = null;
        continue;
      }
      // The first suite on the stack is the FILE, whose name is a path.
      // Everything above it is a `describe`.
      const name = [...suites.slice(1), attr(rest, "name") ?? ""].join(" > ");
      if (selfClosing) {
        names.push(name);
      } else {
        pending = name;
        pendingRan = true;
      }
      continue;
    }
    if (tag === "skipped" && !closing && pending !== null) {
      pendingRan = false;
      skipped++;
    }
  }

  return { names, skipped };
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
