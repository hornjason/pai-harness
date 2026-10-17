/**
 * Covers SC-1864..SC-1869 (HARNESS-STANDARD.md), #532.
 *
 * Run `wf_e230fddc-a71` returned nineteen refusals. Several were already
 * resolved: the ship gate RE-RUNS the verify checks, so a refusal banked at
 * verify had been measured a second time, later, and passed. The terminal
 * report was the UNION of every gate's list rather than the latest reading
 * of each check, and the one refusal that actually blocked the run — a
 * `SECURITY_REVIEW_STALE` — was buried among the stale ones.
 *
 * From that run's own `workflow-state.json`, which is the evidence rather
 * than the claim:
 *
 *   gates.verify.failures  → tests-pass, evidence-prevalidation, tsc-pass,
 *                            local-api-validated, local-ui-validated
 *   gates.ship.failures    → tests-pass, tsc-pass, local-api-validated,
 *                            local-ui-validated, …          (no evidence-prevalidation)
 *   state.evidencePrevalidation → {"verdict":"PASS", acs: [… all "ok" …]}
 *
 * `workflows/ship.js` cannot import (#69), so it carries an inlined copy of
 * the retirement rule. Both copies are driven here over ONE matrix — the
 * technique test/suite-measurement-parity.test.ts uses for `suiteCurrency`,
 * for the same reason: two copies of a rule is a defect waiting for one of
 * them to drift, and the drift is silent.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolvedCheckNames as libResolved,
  retireSupersededRefusals as libRetire,
} from "../lib/gate-refusal-currency";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const START = "// ──── REFUSAL-CURRENCY-START ────";
const END = "// ──── REFUSAL-CURRENCY-END ────";

/**
 * Module scope on purpose. If the markers go missing this throws while the
 * file is loading and every test below fails to run — resolving it lazily
 * and skipping when absent would turn "ship.js lost its retirement rule"
 * into a quiet green run.
 */
const BLOCK: string = (() => {
  const start = SHIP.indexOf(START);
  const end = SHIP.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`workflows/ship.js is missing the ${START} / ${END} markers`);
  }
  return SHIP.slice(start, end);
})();

const shipCopy = new Function(
  `${BLOCK}\nreturn { resolvedCheckNames, retireSupersededRefusals }`,
)() as {
  resolvedCheckNames: (r: unknown) => string[] | null;
  retireSupersededRefusals: (e: any[], r: unknown) => any[];
};

/** One row run through both copies, so neither can be right alone. */
const IMPLS = [
  ["lib", { resolvedCheckNames: libResolved as any, retireSupersededRefusals: libRetire as any }],
  ["ship.js", shipCopy],
] as const;

// ── what a later gate retires ───────────────────────────────────────────────

describe("#532: a refusal a later gate re-ran and did not reproduce", () => {
  // The live run, as a fixture. Names shortened to their check titles; the
  // relationship between the two lists is the whole subject and is exact.
  const VERIFY_FAILED = [
    "verify checks > tests-pass: test suite passes",
    "verify checks > evidence-prevalidation: AC evidence commands pre-validated before ship",
    "verify checks > tsc-pass: no new TypeScript errors above baseline",
  ];
  const SHIP_REPORT = {
    checksRun: [
      "verify checks > tests-pass: test suite passes",
      "verify checks > evidence-prevalidation: AC evidence commands pre-validated before ship",
      "verify checks > tsc-pass: no new TypeScript errors above baseline",
      "ship checks > all-gates-pass: scope + verify gates PASS",
    ],
    failedChecks: [
      "verify checks > tests-pass: test suite passes",
      "verify checks > tsc-pass: no new TypeScript errors above baseline",
      "ship checks > all-gates-pass: scope + verify gates PASS",
    ],
  };

  for (const [name, impl] of IMPLS) {
    test(`SC-1864 (${name}): the resolved check is retired and the others are kept`, () => {
      const ledger = VERIFY_FAILED.map(check => ({ kind: "GATE_FAIL", phase: "Verify", check }));
      const dropped = impl.retireSupersededRefusals(ledger, SHIP_REPORT);

      expect(dropped.map((d: any) => d.check)).toEqual([
        "verify checks > evidence-prevalidation: AC evidence commands pre-validated before ship",
      ]);
      // And the two that are STILL failing are still there. Without this the
      // row is satisfied by a retirement that empties the ledger.
      expect(ledger.map(e => e.check)).toEqual([
        "verify checks > tests-pass: test suite passes",
        "verify checks > tsc-pass: no new TypeScript errors above baseline",
      ]);
    });

    test(`SC-1865 (${name}): a gate that reported no checksRun retires nothing`, () => {
      // The distinction the whole thing turns on. Absence from a failure
      // list means "passed" OR "never ran", and those are opposite facts —
      // so with no positive witness, nothing is retired.
      const ledger = VERIFY_FAILED.map(check => ({ kind: "GATE_FAIL", phase: "Verify", check }));
      expect(impl.retireSupersededRefusals(ledger, { failedChecks: [] })).toEqual([]);
      expect(ledger).toHaveLength(3);

      expect(impl.resolvedCheckNames({ failedChecks: [] }), "null, not []").toBeNull();
      expect(impl.resolvedCheckNames(undefined)).toBeNull();
      expect(impl.resolvedCheckNames({ checksRun: "not an array" })).toBeNull();
      // …and a gate that genuinely ran nothing is an EMPTY list, not null.
      expect(impl.resolvedCheckNames({ checksRun: [], failedChecks: [] })).toEqual([]);
    });

    test(`SC-1866 (${name}): a refusal with no check name is never retired`, () => {
      // Refusals that no gate produced — a stale security review, a commit
      // that could not be pushed. Nothing re-measures them, so nothing can
      // show them resolved, and the run that filed this issue was blocked
      // by exactly one of them.
      const ledger: any[] = [
        { kind: "SECURITY_REVIEW_STALE", phase: "Verify", detail: "the review is two commits behind" },
        { kind: "GATE_FAIL", phase: "Verify", check: "verify checks > tsc-pass: no new TypeScript errors above baseline" },
      ];
      const dropped = impl.retireSupersededRefusals(ledger, {
        checksRun: ["verify checks > tsc-pass: no new TypeScript errors above baseline"],
        failedChecks: [],
      });
      expect(dropped).toHaveLength(1);
      expect(ledger).toHaveLength(1);
      expect(ledger[0].kind).toBe("SECURITY_REVIEW_STALE");
    });

    test(`SC-1867 (${name}): the ledger is edited in place, and the removals are returned`, () => {
      // In place, because the ledger is one array the whole run appends to —
      // a copy would leave the original for whichever reader got there
      // first. Returned, because a retired refusal is a thing an operator
      // may want to see and a silently shortened list stops being checkable.
      const ledger: any[] = [
        { kind: "GATE_FAIL", phase: "Scope", check: "a" },
        { kind: "GATE_FAIL", phase: "Verify", check: "b" },
        { kind: "GATE_FAIL", phase: "Verify", check: "c" },
      ];
      const same = ledger;
      const dropped = impl.retireSupersededRefusals(ledger, {
        checksRun: ["a", "c"],
        failedChecks: [],
      });
      expect(same, "a new array was returned instead of the ledger being edited").toBe(ledger);
      expect(ledger.map(e => e.check)).toEqual(["b"]);
      // Order preserved, so the report still reads chronologically.
      expect(dropped.map((d: any) => d.check)).toEqual(["a", "c"]);
    });

    test(`SC-1868 (${name}): a check the later gate ALSO failed is not retired`, () => {
      // The direction that would be worse than the bug: retiring a refusal
      // that is still true. `checksRun` contains every name the gate
      // measured, failures included, so the subtraction is what makes it a
      // list of passes rather than a list of names.
      const ledger: any[] = [{ kind: "GATE_FAIL", phase: "Verify", check: "still-broken" }];
      expect(
        impl.retireSupersededRefusals(ledger, {
          checksRun: ["still-broken"],
          failedChecks: ["still-broken"],
        }),
      ).toEqual([]);
      expect(ledger).toHaveLength(1);
    });
  }
});

// ── the two copies agree ────────────────────────────────────────────────────

describe("#532: the inlined copy and the library agree", () => {
  const MATRIX: Array<{ label: string; report: unknown; ledger: () => any[] }> = [
    { label: "no report at all", report: undefined, ledger: () => [{ check: "a" }] },
    { label: "report is null", report: null, ledger: () => [{ check: "a" }] },
    { label: "checksRun absent", report: { failedChecks: ["a"] }, ledger: () => [{ check: "a" }] },
    { label: "checksRun not an array", report: { checksRun: 7 }, ledger: () => [{ check: "a" }] },
    { label: "checksRun empty", report: { checksRun: [] }, ledger: () => [{ check: "a" }] },
    { label: "failedChecks absent", report: { checksRun: ["a", "b"] }, ledger: () => [{ check: "a" }, { check: "b" }] },
    { label: "failedChecks not an array", report: { checksRun: ["a"], failedChecks: "a" }, ledger: () => [{ check: "a" }] },
    { label: "non-string names are ignored", report: { checksRun: ["a", 3, null, ""] }, ledger: () => [{ check: "a" }, { check: "" }] },
    { label: "a non-string check on the entry", report: { checksRun: ["a"] }, ledger: () => [{ check: 7 }, { check: "a" }] },
    { label: "duplicate names", report: { checksRun: ["a", "a"], failedChecks: [] }, ledger: () => [{ check: "a" }, { check: "a" }] },
    { label: "nothing matches", report: { checksRun: ["z"] }, ledger: () => [{ check: "a" }] },
    { label: "an empty ledger", report: { checksRun: ["a"] }, ledger: () => [] },
  ];

  test("SC-1869: both copies give the same answer on every row", () => {
    const divergent: string[] = [];
    for (const row of MATRIX) {
      const a = row.ledger();
      const b = row.ledger();
      const da = libRetire(a, row.report as any);
      const db = shipCopy.retireSupersededRefusals(b, row.report);
      const same =
        JSON.stringify(da) === JSON.stringify(db) &&
        JSON.stringify(a) === JSON.stringify(b) &&
        JSON.stringify(libResolved(row.report as any)) ===
          JSON.stringify(shipCopy.resolvedCheckNames(row.report));
      if (!same) {
        divergent.push(
          `${row.label}: lib dropped ${JSON.stringify(da)} leaving ${JSON.stringify(a)}; ` +
            `ship.js dropped ${JSON.stringify(db)} leaving ${JSON.stringify(b)}`,
        );
      }
    }
    expect(divergent, `the two copies disagree:\n${divergent.join("\n")}`).toEqual([]);
    // The matrix is not empty, which is the one way the row above passes for
    // no reason at all.
    expect(MATRIX.length).toBeGreaterThanOrEqual(10);
  });

  test("the matrix can see a divergence", () => {
    // The instrument. Two copies that agree prove nothing unless a
    // disagreement would be caught, and the comparison above is exact
    // equality over JSON — easy to get subtly wrong on `undefined` vs
    // absent. A deliberately wrong copy must be reported.
    const wrong = (entries: any[], report: any) => {
      // The fail-open this whole file exists to rule out: absence read as a
      // pass, with no `checksRun` witness required.
      const failed = new Set((report?.failedChecks ?? []) as string[]);
      const dropped: any[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (typeof entries[i]?.check === "string" && !failed.has(entries[i].check)) {
          dropped.unshift(entries.splice(i, 1)[0]);
        }
      }
      return dropped;
    };
    // Which rows separate them is a fact to be measured, not guessed: the
    // first draft picked `checksRun absent` by name, and on that row the
    // fail-open happens to agree because `failedChecks` already holds the
    // entry. So the matrix is asked how many of its rows can tell them
    // apart, and the answer has to be more than none.
    const separating = MATRIX.filter(row => {
      const a = row.ledger();
      const b = row.ledger();
      libRetire(a, row.report as any);
      wrong(b, row.report);
      return JSON.stringify(a) !== JSON.stringify(b);
    }).map(r => r.label);

    expect(
      separating,
      "no row in the matrix can tell the real rule from a fail-open one — it is blind",
    ).not.toEqual([]);
    // Named, so a later edit that quietly removes the separating rows shows
    // up as this list shrinking rather than as nothing at all.
    expect(separating).toContain("checksRun not an array");
    expect(separating).toContain("no report at all");
    // And the rows that do NOT separate them are named too, because the
    // interesting ones are where the fail-open is accidentally right:
    // `failedChecks absent` with every name resolved gives the same answer
    // either way, which is why picking a row by name was the wrong method.
    expect(separating).not.toContain("failedChecks absent");
  });
});

// ── the producer ────────────────────────────────────────────────────────────

/**
 * Everything above is the CONSUMER. `checksRun` is the positive witness the
 * whole rule rests on, and a consumer with no producer is the defect #530
 * had just finished being — so the gate runner is executed here and the
 * field read back off the state it wrote.
 */
describe("#532: the gate runner records what it measured, not only what it failed", () => {
  const WORK = mkdtempSync(join(tmpdir(), "refusal-currency-"));

  test("SC-1870: a real gate run writes checksRun, and it is a superset of its failures", () => {
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

    const runner = join(REPO_ROOT, "gates", "run-gate.ts");
    spawnSync(
      "bun",
      ["run", runner, "--gate", "scope", "--slug", "light", "--issue", "9999",
       "--tree-under-test", "/tmp/test", "--force"],
      {
        encoding: "utf-8",
        timeout: 120000,
        cwd: REPO_ROOT,
        env: { ...process.env, RUNGATE_WORK_DIR: WORK, RUNGATE_SKIP_AGENTS: "1", GITHUB_TOKEN: "", GH_TOKEN: "" },
      },
    );

    const written = JSON.parse(readFileSync(join(dir, "workflow-state.json"), "utf-8"));
    const gate = written.gates?.scope;
    expect(gate, "the gate recorded no result at all").toBeTruthy();
    expect(Array.isArray(gate.checksRun), "the gate recorded no checksRun — the witness has no producer")
      .toBe(true);
    // Non-empty, because an empty list retires nothing and would make every
    // consumer row above vacuous against a real run.
    expect(gate.checksRun.length, "the gate ran and measured nothing").toBeGreaterThan(3);

    // The superset property is what makes the subtraction meaningful: a
    // `checksRun` that omitted failures would report a failing check as
    // resolved, which is worse than the bug this closes.
    const failed = (gate.failures || []).map((f: any) => f?.check).filter(Boolean);
    const missing = failed.filter((c: string) => !gate.checksRun.includes(c));
    expect(missing, `checksRun omits checks this gate failed:\n${missing.join("\n")}`).toEqual([]);

    // And the consumer agrees with the producer over the real record.
    const resolved = libResolved({ checksRun: gate.checksRun, failedChecks: failed });
    expect(resolved).not.toBeNull();
    expect(resolved!.length).toBe(gate.checksRun.length - failed.length);
  }, 180000);
});

// ── the wiring ──────────────────────────────────────────────────────────────

describe("#532: the retirement runs where it has to", () => {
  test("gateExit retires before it records, and the block appears once", () => {
    // Order matters: recording first would bank this gate's own refusals and
    // then retire them against its own passes, which is a different and
    // wrong operation.
    const exit = SHIP.slice(SHIP.indexOf("const gateExit = result =>"));
    const retireAt = exit.indexOf("retireSupersededRefusals(refusals, result)");
    const recordAt = exit.indexOf("recordGateRefusal(phaseName, gateName, result)");
    expect(retireAt, "gateExit does not retire superseded refusals").toBeGreaterThan(-1);
    expect(recordAt, "gateExit does not record this gate's refusals").toBeGreaterThan(-1);
    expect(retireAt, "the retirement runs after the recording").toBeLessThan(recordAt);

    // One block, so there is one binding to mutate.
    expect(SHIP.split("REFUSAL-CURRENCY-START").length - 1).toBe(1);
  });

  test("the gate prompt asks for the names, and forbids reconstructing them", () => {
    // `checksRun` is the positive witness. An agent that assembled it from
    // somewhere else would retire refusals the gate never ran, which is the
    // failure mode worse than the bug.
    expect(SHIP).toContain("checksRun: { type: 'array', items: { type: 'string' } }");
    expect(SHIP).toContain("failedChecks: { type: 'array', items: { type: 'string' } }");
    expect(SHIP).toContain("do NOT reconstruct it from anything");
  });
});
