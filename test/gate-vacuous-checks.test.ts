import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * #176 — the three checks in gates/workflow.test.ts that could not fail.
 *
 * `tsc-pass` was two early returns and an empty tail: no `expect`, no tsc
 * invocation, no baseline comparison, under a name that promises all three.
 * `local-api-validated` and `local-ui-validated` read `environments.local.api`
 * and `.ui`, and the only writer of those fields was
 * `scripts/record-build-commit.ts`, fed by `workflows/ship.js` passing
 * `--api PASS` whenever `projectConfig.apiUrl` was merely truthy. Unconfigured
 * returned early and passed; configured arrived already PASS and passed. There
 * was no third branch, so neither check had a red state to reach.
 *
 * Every case here plants a defect and watches the named check go red, then
 * removes the defect and watches the same check go green. A red case on its
 * own is satisfied by a check that fails on everything, which is why each one
 * is paired (.claude/rules/checks-must-be-able-to-fail.md).
 *
 * The checks are EXECUTED — `bun test gates/workflow.test.ts -t <name>` against
 * a planted work dir — rather than asserted on source text. Every mutation
 * that survived a first pass in session 34 was a source-text assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");
const SHIP_JS = join(REPO_ROOT, "workflows", "ship.js");
const RECORDER = join(REPO_ROOT, "scripts", "record-build-commit.ts");
const SHA = "dd242a62aea9371d788abb58f3d26922d5dd6cbc";

/**
 * Scratch root. Inside the repo rather than in os.tmpdir() so that a planted
 * project's `bunx tsc` resolves the same compiler the real check uses; from an
 * unrelated temp directory a resolution failure exits non-zero, which reads as
 * "the type error was caught" no matter what the file contains.
 */
const SCRATCH = join(REPO_ROOT, ".gate-vacuous-test");

let WORK = "";
let PROJECT = "";

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  WORK = join(SCRATCH, "work");
  PROJECT = join(SCRATCH, "project");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(PROJECT, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The smallest workflow-state.json the gate suite will read fields out of. */
function state(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    issue: 176,
    slug: "pai-harness-176",
    phase: "VERIFY",
    projectRoot: PROJECT,
    issueGoal: "three gate checks that could not fail now have a red state",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the tsc-pass check compares an error count against the baseline",
        threshold: { op: "==", value: 0, unit: "errors above baseline" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...extra,
  };
}

function plantState(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state(extra), null, 2));
}

function plantHarness(config: Record<string, unknown>): void {
  writeFileSync(join(PROJECT, ".claude", "rungate.json"), JSON.stringify(config, null, 2));
}

/**
 * Run one named check out of gates/workflow.test.ts against the planted work
 * dir and report whether it went red.
 *
 * `ran` is not a formality. A filter that matches nothing leaves bun reporting
 * zero failures, which is indistinguishable from the check passing — the exact
 * shape this file exists to catch. Every assertion below goes through `ran`
 * first.
 */
function runCheck(name: string): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", GATE_SUITE, "-t", name], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, TEST_WORK_DIR: WORK },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const passed = count("pass");
  const failed = count("fail");
  // Exactly one, not at least one: a filter that widens to two checks would
  // otherwise let a green one mask a red one, or vice versa.
  return { ran: passed + failed === 1, red: failed === 1, output };
}

function expectRed(name: string, why: string) {
  const r = runCheck(name);
  expect(r.ran, `"${name}" never ran — the filter matched nothing:\n${r.output}`).toBe(true);
  expect(r.red, `${why}\n${r.output}`).toBe(true);
}

function expectGreen(name: string, why: string) {
  const r = runCheck(name);
  expect(r.ran, `"${name}" never ran — the filter matched nothing:\n${r.output}`).toBe(true);
  expect(r.red, `${why}\n${r.output}`).toBe(false);
}

/** A project tsc will actually compile, with `errors` lines or without them. */
function plantProject(opts: { typeError: boolean; baseline?: string | null }): void {
  writeFileSync(
    join(PROJECT, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(PROJECT, "src.ts"),
    opts.typeError
      ? "export const n: number = 'not a number';\n"
      : "export const n: number = 1;\n",
  );
  const baselineFile = join(PROJECT, ".claude", "typecheck-baseline.json");
  if (opts.baseline === undefined) {
    writeFileSync(baselineFile, JSON.stringify({ errors: 0, updated: "2026-10-08" }, null, 2));
  } else if (opts.baseline !== null) {
    writeFileSync(baselineFile, opts.baseline);
  }
}

// ═══ tsc-pass ═════════════════════════════════════════════════════════
describe("#176 tsc-pass: the check now runs tsc", () => {
  test(
    "tsc-pass fails on a new type error",
    () => {
      // THE PLANTED DEFECT: one assignment that does not typecheck, in a
      // project whose baseline says zero. Before #176 this passed, because the
      // check never invoked tsc at all.
      plantProject({ typeError: true });
      plantState();
      expectRed("tsc-pass", "a project with 1 type error above a baseline of 0 did not fail tsc-pass");
    },
    120000,
  );

  test(
    "tsc-pass passes on a clean project at its baseline",
    () => {
      // The positive control. Without it, a check that fails unconditionally
      // satisfies the case above.
      plantProject({ typeError: false });
      plantState();
      expectGreen("tsc-pass", "a project with zero type errors and a baseline of 0 failed tsc-pass");
    },
    120000,
  );

  test(
    "tsc-pass honours a baseline that admits the error",
    () => {
      // The ratchet, not a clean-tree rule: a declared tolerance of 1 makes the
      // same planted error acceptable. This is what separates "compares against
      // the baseline" from "runs tsc and demands zero".
      plantProject({ typeError: true, baseline: JSON.stringify({ errors: 1, updated: "2026-10-08" }) });
      plantState();
      expectGreen("tsc-pass", "a baseline of 1 did not admit 1 error");
    },
    120000,
  );

  test(
    "tsc-pass refuses a baseline it cannot read",
    () => {
      // Fail-closed. `{"error": 1}` is a one-character edit to a four-line JSON
      // file, and reading it as "no baseline" would quietly disable the gate
      // while still reporting a result.
      plantProject({ typeError: false, baseline: JSON.stringify({ error: 0 }) });
      plantState();
      expectRed("tsc-pass", "a baseline file with no integer errors field was treated as readable");
    },
    120000,
  );

  test("tsc-pass no longer defers to the agent it is gating", () => {
    // AC-5. `if (tests === "PASS" || tests === "SKIP") return; // trust Marcus`
    // was the whole check: a gate that asks the agent under test whether it
    // should run is not a gate.
    const gate = readFileSync(GATE_SUITE, "utf-8");
    expect(gate.match(/trust Marcus/g) || []).toEqual([]);
  });
});

// ═══ local-api-validated ══════════════════════════════════════════════
describe("#176 local-api-validated: an unmeasured api is a red state", () => {
  test("api PASS is not written from config", () => {
    // THE PLANTED DEFECT, as it stood: `--api ${shellQuote(projectConfig.apiUrl
    // ? 'PASS' : 'SKIP')}`. Presence of a URL in rungate.json became a verdict,
    // so `environments.local.api` was PASS on every run of every configured
    // project and the check below had nothing left to catch.
    const ship = readFileSync(SHIP_JS, "utf-8");
    expect(
      ship.match(/(apiUrl|hasUI)\s*\?\s*'PASS'/g) || [],
      "ship.js is turning configuration presence back into a verdict",
    ).toEqual([]);

    // The executing half: the recorder, handed a commit and nothing else,
    // leaves the field alone rather than inventing a value for it.
    plantState({ environments: { local: { tests: "PASS" } } });
    const r = spawnSync(
      "bun",
      [RECORDER, "--state", join(WORK, "workflow-state.json"), "--sha", SHA, "--branch", "ship-176", "--quinn", "SKIP"],
      { encoding: "utf-8" },
    );
    expect(r.status, r.stderr ?? "").toBe(0);
    const written = JSON.parse(readFileSync(join(WORK, "workflow-state.json"), "utf-8"));
    expect(
      written.environments.local.api,
      "the commit recorder invented an api verdict it never measured",
    ).toBeUndefined();
    expect(written.environments.local.ui).toBeUndefined();
    expect(written.environments.local.tests, "the measured suite result was clobbered").toBe("PASS");
  });

  test(
    "local-api-validated fails when apiBase is configured and nothing measured it",
    () => {
      plantHarness({ dev: { apiBase: "http://localhost:3000" } });
      plantState({ environments: { local: {} } });
      expectRed(
        "local-api-validated",
        "a configured apiBase with no recorded verdict did not fail local-api-validated",
      );
    },
    60000,
  );

  test(
    "local-api-validated passes once the api was actually measured",
    () => {
      plantHarness({ dev: { apiBase: "http://localhost:3000" } });
      plantState({ environments: { local: { api: "PASS" } } });
      expectGreen("local-api-validated", "a measured api PASS failed local-api-validated");
    },
    60000,
  );
});

// ═══ local-ui-validated ═══════════════════════════════════════════════
describe("#176 local-ui-validated: an unmeasured ui is a red state", () => {
  test(
    "local-ui-validated fails when uiBase is configured and nothing measured it",
    () => {
      plantHarness({ dev: { uiBase: "http://localhost:5173" } });
      plantState({ environments: { local: {} } });
      expectRed(
        "local-ui-validated",
        "a configured uiBase with no recorded verdict did not fail local-ui-validated",
      );
    },
    60000,
  );

  test(
    "local-ui-validated passes once the ui was actually measured",
    () => {
      plantHarness({ dev: { uiBase: "http://localhost:5173" } });
      plantState({ environments: { local: { ui: "PASS" } } });
      expectGreen("local-ui-validated", "a measured ui PASS failed local-ui-validated");
    },
    60000,
  );

  test("a measured ui verdict survives the commit recorder", () => {
    // The other half of #176 for ui: Quinn runs during Validate, the commit
    // step runs after it, and the recorder used to overwrite whatever Quinn
    // had written with a value derived from `pages` in rungate.json.
    plantState({ environments: { local: { ui: "FAIL", uiSkipReason: "" } } });
    const r = spawnSync(
      "bun",
      [
        RECORDER,
        "--state", join(WORK, "workflow-state.json"),
        "--sha", SHA,
        "--branch", "ship-176",
        "--quinn", "PASS",
        "--ui", "PASS",
      ],
      { encoding: "utf-8" },
    );
    expect(r.status, r.stderr ?? "").toBe(0);
    const written = JSON.parse(readFileSync(join(WORK, "workflow-state.json"), "utf-8"));
    expect(written.environments.local.ui, "a measured ui FAIL was overwritten by the commit step").toBe("FAIL");
  });
});

// ═══ the verify fan-out ═══════════════════════════════════════════════

/**
 * #126 — the two checks that read the Verify fan-out could not fail.
 *
 * `gates/workflow.test.ts` carried these, under names promising they validate
 * the fan-out's results:
 *
 *     const ev = sf("gates.verify.evidenceValidator");
 *     if (!ev) {
 *       console.warn("WARN: gates.verify.evidenceValidator not populated — B2 agent may not have run");
 *       return;                                   // <- PASSES
 *     }
 *
 * A test that returns early passes. The only input either one could fail on
 * was a slot that had been written and written WRONG — so the failure mode
 * #126 is about, the agent never running, was the single case they were
 * structurally incapable of catching. The names said so: "when populated".
 *
 * The producer had four ways to arrive at not-populated, three of them silent:
 * `fails === 0` (a verify gate with any failure skips the agents, then reports
 * their absence), `RUNGATE_SKIP_AGENTS`, a LIGHT tier, and a missing prompt
 * file. So the fan-out could be absent in its entirety and the gate said PASS,
 * which means every compliance number recorded for Verify was a number for a
 * stage that may not have run.
 *
 * Absence is now a refusal and a DELIBERATE skip is a recorded one. Both
 * halves matter: a fix that only refused would brick every LIGHT run, and a
 * fix that brings its own outage is how the next fail-open gets argued for.
 *
 * Every case below is paired — defect planted, check red; defect removed, same
 * check green — because a red case alone is satisfied by a check that fails on
 * everything.
 */
describe("#126 verify fan-out: an absent agent is a refusal, not a warning", () => {
  /** A populated record of the shape each agent really writes. */
  const B1_RAN = { ts: "2026-10-10T00:00:00Z", gameable: 0, approved: true };
  const B2_RAN = { ts: "2026-10-10T00:00:00Z", verdicts: [] };

  /**
   * Phase SHIP, not VERIFY. gate-executor runs the gate suite BEFORE it spawns
   * the fan-out and persists the slots, so at verify the slot cannot yet
   * exist and a check that refused its absence would refuse every first
   * attempt — the original circularity with the sign flipped. The check reads
   * at ship, by which point the fan-out has run or recorded why it did not.
   */
  function plantFanout(
    verify: Record<string, unknown> | undefined,
    tier = "STANDARD",
  ): void {
    plantState({
      phase: "SHIP",
      sizing: { predicted: "S", ceremonyTier: tier },
      ...(verify === undefined ? {} : { gates: { verify } }),
    });
  }

  const B1 = "b1-adversary-verify-structure";
  const B2 = "b2-evidence-validator-structure";

  test("B1: a missing adversary record is red — the case that used to warn and pass", () => {
    plantFanout({ evidenceValidator: B2_RAN });
    const r = runCheck(B1);
    expect(r.ran, `the ${B1} check did not run:\n${r.output}`).toBe(true);
    expect(r.red, "an absent adversary record was waved through").toBe(true);
    expect(r.output, "the refusal does not say what is missing").toContain("adversary");
  });

  test("B1: the same run with the record present is green", () => {
    plantFanout({ adversary: B1_RAN, evidenceValidator: B2_RAN });
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, `a complete fan-out was refused:\n${r.output}`).toBe(false);
  });

  test("B2: a missing evidence-validator record is red", () => {
    plantFanout({ adversary: B1_RAN });
    const r = runCheck(B2);
    expect(r.ran, `the ${B2} check did not run:\n${r.output}`).toBe(true);
    expect(r.red, "an absent evidence-validator record was waved through").toBe(true);
    expect(r.output).toContain("evidenceValidator");
  });

  test("B2: the same run with the record present is green", () => {
    plantFanout({ adversary: B1_RAN, evidenceValidator: B2_RAN });
    const r = runCheck(B2);
    expect(r.ran).toBe(true);
    expect(r.red, `a complete fan-out was refused:\n${r.output}`).toBe(false);
  });

  test("no gates.verify key at all is red, not merely a missing field", () => {
    // The shape a run that never reached the fan-out actually leaves behind.
    plantFanout(undefined);
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, "a state with no gates.verify at all was read as clean").toBe(true);
  });

  test("a LIGHT tier is green — the skip the producer makes on purpose", () => {
    // B1 is tier-gated in gates/gate-executor.ts:1093. Refusing here would
    // brick every LIGHT run, and a fix that brings its own outage is how the
    // next fail-open gets argued for.
    plantFanout({}, "LIGHT");
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, `a LIGHT run was refused for a tier-gated agent:\n${r.output}`).toBe(false);
  });

  test("a recorded skip with a reason is green", () => {
    plantFanout({ adversary: { skipped: "ac-adversary.md prompt not found" } });
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, `an explicitly recorded skip was refused:\n${r.output}`).toBe(false);
  });

  test("a recorded skip with NO reason is red", () => {
    // The loophole the escape hatch would otherwise open: `{skipped: ""}` is
    // an absence with extra steps, and it would be the cheapest way to make
    // every case above green again.
    plantFanout({ adversary: { skipped: "" } });
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, "a reasonless skip bought silence").toBe(true);
  });

  test("a populated but malformed record is still red — the old check's one input", () => {
    // What the original check could catch. It has to keep working: the fix
    // adds a failure mode, it does not trade one for another.
    plantFanout({ adversary: { gameable: 0, approved: true } });
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red, "a record with no timestamp was accepted").toBe(true);
  });

  test("a non-object in the slot is red rather than crashing the check", () => {
    plantFanout({ adversary: "ran" });
    const r = runCheck(B1);
    expect(r.ran).toBe(true);
    expect(r.red).toBe(true);
  });
});
