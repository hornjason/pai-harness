/**
 * Covers SC-1871..SC-1876 (HARNESS-STANDARD.md), #532.
 *
 * `checksRun` is the positive witness refusal retirement rests on, and its
 * first implementation read it off `results` — the array
 * `gates/gate-executor.ts` builds from the console output. Measured on a
 * real scope gate run: 2 names out of 118 checks, because bun 1.3.14 prints
 * no `(pass)` markers and `results` is therefore a failure list. A witness
 * that names only the failures retires nothing, on any run that has ever
 * happened.
 *
 * The names now come from the run's JUnit report. Everything below is about
 * the two ways that can go wrong, and the second is the one that matters:
 *
 *  - too FEW names → the retirement is inert, which is the bug unchanged;
 *  - too MANY names → a refusal is retired that the gate never re-ran,
 *    which erases a true refusal and is worse than the bug.
 *
 * The second is not hypothetical. bun lists a test excluded by
 * `--test-name-pattern` as a `<skipped />` testcase, and the gate's pattern
 * excludes most of `gates/` on every run — 279 of 397 on the run measured
 * here.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import {
  checksRunFrom,
  parseJunitCheckNames,
  readJunitCheckNames,
  unionNames,
} from "../lib/junit-checks";
import { junitReportPath } from "../gates/gate-executor";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * CAPTURED, not imagined. bun 1.3.14, `bun test p.test.ts -t "keep me"
 * --reporter=junit` over a file holding two matching tests, one
 * non-matching test, one `.skip` and one `.todo`. Paths shortened; the
 * structure — and the `<skipped />` on the FILTERED-OUT test — is the whole
 * subject and is reproduced exactly.
 */
const FILTERED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="2" failures="1" skipped="3" time="0.011499">
  <testsuite name="/tmp/p.test.ts" file="/tmp/p.test.ts" tests="5" assertions="2" failures="1" skipped="3" time="0" hostname="h">
    <testsuite name="alpha group" file="/tmp/p.test.ts" line="2" tests="4" assertions="1" failures="0" skipped="3" time="0" hostname="h">
      <testcase name="keep me one" classname="alpha group" time="0.000038" file="/tmp/p.test.ts" line="3" assertions="1" />
      <testcase name="skip me two" classname="alpha group" time="0" file="/tmp/p.test.ts" line="4" assertions="0">
        <skipped />
      </testcase>
      <testcase name="explicitly skipped" classname="alpha group" time="0" file="/tmp/p.test.ts" line="5" assertions="0">
        <skipped />
      </testcase>
      <testcase name="a todo one" classname="alpha group" time="0" file="/tmp/p.test.ts" line="6" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
    <testsuite name="beta group" file="/tmp/p.test.ts" line="8" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="keep me three" classname="beta group" time="0.000129" file="/tmp/p.test.ts" line="9" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;

/**
 * Also captured. A `describe("outer") > describe("inner")`, whose console
 * marker reads `(fail) outer > inner > deep fails`. Note `classname`:
 * reversed, and double-escaped.
 */
const NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="1" skipped="0" time="0.010358">
  <testsuite name="/tmp/n.test.ts" file="/tmp/n.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
    <testsuite name="outer" file="/tmp/n.test.ts" line="2" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
      <testsuite name="inner" file="/tmp/n.test.ts" line="3" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="h">
        <testcase name="deep fails" classname="inner &amp;gt; outer" time="0.000151" file="/tmp/n.test.ts" line="4" assertions="1">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>
`;

describe("#532: the JUnit report names the checks that RAN", () => {
  test("SC-1871: a filtered-out or skipped testcase is not a check that ran", () => {
    // The dangerous direction. The gate's `--test-name-pattern` excludes
    // most of `gates/` on every run, and bun lists every excluded test as a
    // `<skipped />` rather than omitting it. Counting those as run would
    // retire refusals from checks the gate never re-measured.
    const reading = parseJunitCheckNames(FILTERED);
    expect(reading.names).toEqual(["alpha group > keep me one", "beta group > keep me three"]);
    // The count is kept rather than discarded: "ran 2, skipped 3" and
    // "ran 5" are different facts about the same report, and only one of
    // them is true.
    expect(reading.skipped).toBe(3);
  });

  test("SC-1872: a failing testcase is a check that ran", () => {
    // The half a `<skipped />` filter is most likely to take out with it:
    // both a failure and a skip are a testcase with a CHILD element, and a
    // rule that said "self-closing means it ran" would drop every failure.
    // Without this, `checksRun` stops covering `failures` and the
    // subtraction in lib/gate-refusal-currency.ts reads a still-failing
    // check as resolved.
    expect(parseJunitCheckNames(FILTERED).names).toContain("beta group > keep me three");
  });

  test("SC-1873: the name is rebuilt from the nesting, in the order the console prints", () => {
    // `classname` is the obvious source and is unusable: bun writes the
    // describe chain BACKWARDS (`inner > outer` for an `outer > inner`
    // nesting) and escapes it twice. The nested <testsuite> elements carry
    // the same chain the right way round.
    const reading = parseJunitCheckNames(NESTED);
    expect(reading.names).toEqual(["outer > inner > deep fails"]);
    // Named explicitly, because "outer > inner" and "inner > outer" are
    // the same set of words and an assertion on membership would accept
    // either.
    expect(reading.names![0]).not.toContain("inner > outer");
    // And the file-level suite is dropped — a path in the middle of a
    // check name matches no `(fail)` marker bun ever printed.
    expect(reading.names![0]).not.toContain("/tmp/");
  });

  test("SC-1874: a report that cannot be read is null, never an empty list", () => {
    // `[]` says the gate ran nothing. `null` says the gate said nothing
    // about what it ran. Retirement treats them as opposite facts, so they
    // have to survive the reader
    // (.claude/rules/config-access.md, Silent Default Substitution).
    const missing = readJunitCheckNames(join(tmpdir(), "no-such-junit-report-532.xml"));
    expect(missing.names).toBeNull();
    expect(missing.reason, "an unreadable report refuses without saying why").toBeTruthy();

    const notAReport = parseJunitCheckNames("<html><body>502 Bad Gateway</body></html>");
    expect(notAReport.names).toBeNull();

    // …and a report that genuinely lists nothing is an empty list, which is
    // a measurement. Without this row the two answers could be collapsed
    // into one and every assertion above would still pass.
    const empty = parseJunitCheckNames(
      '<?xml version="1.0"?>\n<testsuites name="bun test" tests="0"></testsuites>\n',
    );
    expect(empty.names).toEqual([]);
  });

  test("SC-1875: the verdicts the gate reaches on its own are in the witness too", () => {
    // `test-census: UNMEASURED`, `ac-verdict-fail: AC-2`, the liveness
    // probe — real verdicts with no testcase behind them, which appear in
    // the failure ledger. The JUnit report cannot know about them, so the
    // union is what keeps `checksRun` a superset of `failures`.
    const reading = parseJunitCheckNames(FILTERED);
    const run = checksRunFrom(reading, ["test-census: UNMEASURED", "alpha group > keep me one"]);
    expect(run).toEqual([
      "alpha group > keep me one",
      "beta group > keep me three",
      "test-census: UNMEASURED",
    ]);

    // null in, null out. A gate whose report could not be read must not
    // acquire a witness from its own failure list — that list is the thing
    // the witness exists to be checked against.
    expect(checksRunFrom({ names: null, skipped: 0 }, ["anything"])).toBeNull();
    expect(unionNames(null, ["anything"])).toBeNull();
    // And the de-duplication is real rather than incidental above.
    expect(unionNames(["a", "b"], ["b", "", "c"])).toEqual(["a", "b", "c"]);
  });
});

// ── the producer, end to end ────────────────────────────────────────────────

describe("#532: a real gate run writes a report the reader can use", () => {
  const WORK = mkdtempSync(join(tmpdir(), "junit-checks-"));

  test("SC-1876: the scope gate's JUnit report names far more checks than it failed", () => {
    const dir = join(WORK, "light");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "workflow-state.json"),
      JSON.stringify({
        schemaVersion: 2,
        issue: 9999,
        repo: "test/repo",
        issueRepo: "test/repo",
        projectRoot: "/tmp/test",
        slug: "light",
        phase: "DONE",
        issueGoal: "the gate records every check it measured",
        sizing: { predicted: "XS", ceremonyTier: "LIGHT" },
        acs: [
          {
            id: "AC-1",
            type: "CODE",
            statement: "the gate records every check it measured",
            threshold: { op: ">=", value: 1 },
            evidenceMethod: { type: "BUN_TEST", command: "bun test" },
            evidence: { type: "command-output", content: "24 pass" },
            verdict: "PASS",
          },
        ],
        gates: {},
        environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
        agents: { marcus: { spawned: true, verdict: "PASS" } },
        buildCommit: "abc1234",
        changelog: [],
        bootstrappedFrom: "ship-workflow",
      }),
    );

    const gateRun = spawnSync(
      "bun",
      ["run", join(REPO_ROOT, "gates", "run-gate.ts"), "--gate", "scope", "--slug", "light",
       "--issue", "9999", "--tree-under-test", "/tmp/test", "--force"],
      {
        encoding: "utf-8",
        timeout: 180000,
        cwd: REPO_ROOT,
        env: { ...process.env, RUNGATE_WORK_DIR: WORK, RUNGATE_SKIP_AGENTS: "1", GITHUB_TOKEN: "", GH_TOKEN: "" },
      },
    );

    // The gate wrote the report where the reader looks for it. Asserted
    // through `junitReportPath` rather than a literal, so the two cannot
    // drift to different directories while both look right.
    const reading = readJunitCheckNames(junitReportPath(dir, "scope"));
    if (reading.names === null) {
      console.error(`gate run exited ${gateRun.status}:\n${(gateRun.stdout || "") + (gateRun.stderr || "")}`);
    }
    expect(reading.names, `the scope gate wrote no readable JUnit report — ${reading.reason}`)
      .not.toBeNull();

    // Measured 2026-10-17 on bun 1.3.14: 117 ran, 279 filtered out, and the
    // old `results`-sourced witness produced **2**. The threshold has to
    // separate those two numbers and nothing finer — it is deliberately far
    // below 117 so ordinary churn in `gates/` cannot turn it red, and far
    // above 2 so the behaviour it replaced cannot reach it.
    expect(reading.names!.length, "the witness names about as few checks as the failure list did")
      .toBeGreaterThan(50);
    // The filtered-out tests are the majority and are NOT in the list.
    expect(reading.skipped, "nothing was filtered out — the gate ran the whole directory")
      .toBeGreaterThan(50);
    // …and "not in the list" is asserted by MEMBERSHIP, not by the count.
    // The count is unchanged by a reader that treats `<skipped />` as a
    // check that ran — measured: that mutation leaves `skipped` at 279 and
    // simply adds all 279 names. The scope gate's filter is
    // `--test-name-pattern "schema|scope"`, so a name matching neither is a
    // test this run did not execute, and retiring a refusal on it would
    // erase a true refusal.
    const offPattern = reading.names!.filter(n => !/schema|scope/.test(n));
    expect(offPattern.slice(0, 5), `names the gate's own filter excluded: ${offPattern.length}`)
      .toEqual([]);

    const state = JSON.parse(readFileSync(join(dir, "workflow-state.json"), "utf-8"));
    const failed = (state.gates?.scope?.failures || []).map((f: any) => f?.check).filter(Boolean);
    const run: string[] = state.gates?.scope?.checksRun || [];
    expect(run.length).toBeGreaterThan(50);
    // The superset property, over the real record rather than a fixture.
    expect(failed.filter((c: string) => !run.includes(c))).toEqual([]);
    // And the witness says strictly more than the ledger, which is the only
    // reason it exists.
    expect(run.length).toBeGreaterThan(failed.length);
  }, 240000);
});
