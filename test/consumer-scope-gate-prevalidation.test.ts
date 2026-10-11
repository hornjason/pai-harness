import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EvidencePrevalidationSchema } from "../gates/schema";
import { measureEvidencePrevalidation, prevalidateEvidence } from "../lib/evidence-prevalidator";

/**
 * #274 Phase 2 — the scope gate's pre-validation, measured over a CONSUMER's
 * real AC set rather than over a hand-written reading.
 *
 * test/suite-binding-mutation.test.ts already proves the binding can fail. It
 * does it with a planted `{ verdict, broken }` object — a shape **no writer has
 * ever produced**. `measureEvidencePrevalidation` returns per-AC results under
 * `acs`, so on every real run `prevalidationViolations` read `reading.broken`,
 * found nothing, and refused with "no broken AC ids were recorded": true of the
 * key, false of the reading. The refusal was fail-closed and therefore invisible
 * — a heal round that cannot be told which AC to fix costs a round and teaches
 * nothing, which is part of how #261 cost two. It was filed at the foot of
 * test/evidence-prevalidation-at-verify.test.ts and is what this file closes.
 *
 * What was broken to prove it, run and counted rather than asserted, over this
 * file's 14 tests:
 *
 * | Mutation | Red |
 * |---|---|
 * | nothing — the tree before the fix | 11 of 14, and the gate's own output read "FAIL — but no broken AC ids were recorded, so the refusal cannot name what to fix" over a reading that had classified AC-2 broken |
 * | `broken: broken.map(r => r.id)` short-circuited to `broken: []` in `measureEvidencePrevalidation` | 2 of 14 — the measured FAIL names nothing and the gate goes back to refusing anonymously |
 * | the schema's `broken`-vs-`acs` comparison short-circuited (`differs = false`) | 2 of 14 — a FAIL may then name an AC it never classified broken, which is the second-source-of-truth this field could become |
 * | the schema stops reading `broken` at all (`const named = undefined`) | 3 of 14 — every real FAIL, and the guide's own worked example, stop validating |
 *
 * None is left in the tree; all were run and reverted.
 *
 * Nothing here is written inside the repo: the consumer fixture is a temp
 * directory, and the gate is reached by SPAWNING it, because
 * `prevalidationViolations` lives in a `.test.ts` file and importing it would
 * run the whole gate suite inside this one.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");
const SPEC = join(REPO_ROOT, "specs", "CONFIG-DIRECTORY-STRUCTURE-SPEC.md");
const GUIDE = join(REPO_ROOT, "gates", "SCHEMA-GUIDE.md");

let SCRATCH = "";
let WORK = "";
let PROJECT = "";

// ── the consumer fixture ────────────────────────────────────────────────────

/**
 * A consumer project in the shape #274 is about: a container on :7776 the test
 * environment runs on, a production deploy on :7777, a `make`-driven rebuild,
 * and a `test.command` with no `dev.testCmd` beside it — the config split
 * `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md` now records.
 */
function plantConsumer(): void {
  mkdirSync(join(PROJECT, ".claude"), { recursive: true });
  mkdirSync(join(PROJECT, "src"), { recursive: true });
  writeFileSync(
    join(PROJECT, ".claude", "rungate.json"),
    JSON.stringify(
      {
        project: "DailyBriefDashboard",
        container: { port: 7776, hosts: ["localhost"], rebuildCommand: "make rebuild" },
        prod: { port: 7777 },
        test: { command: "make test", timeout: 300000 },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(PROJECT, "src", "app.ts"),
    "export const TEST_PORT = 7776;\nexport const PROD_PORT = 7777;\n",
  );
  writeFileSync(join(PROJECT, "Makefile"), "rebuild:\n\t@echo rebuilt\n");
}

/**
 * The fixture's AC set, written the way a consumer's ACs are written — one
 * evidence command each, none of them chosen to flatter the pre-validator.
 *
 * AC-1 and AC-4 are the two faces of a zero-match grep, which is the case #271
 * exists for: `grep -c` prints `0` — the exact value a zero-count threshold
 * requires — and exits 1, while plain `grep` prints nothing and exits 1. Both
 * must be classified from grep's documented contract, and NEITHER may be
 * repaired into a command that cannot fail.
 *
 * AC-2 is the unexecutable one. It is not a bare `grep` and not a `bun test`
 * pipe, so nothing in `attemptAutoFix` can reach it and it is classified broken
 * on its own merits.
 */
const AC_ZERO_MATCH_COUNTED = {
  id: "AC-1",
  type: "CODE",
  statement: "no hardcoded production port survives in the dashboard source",
  threshold: { op: "==", value: 0, unit: "occurrences" },
  evidenceMethod: { type: "COMMAND", command: 'grep -c "localhost:7777" src/app.ts' },
};

const AC_UNEXECUTABLE = {
  id: "AC-2",
  type: "CODE",
  statement: "the test environment answers before the production one is rebuilt",
  threshold: { op: "==", value: 0, unit: "failures" },
  evidenceMethod: { type: "COMMAND", command: "./scripts/check-test-env.sh --test 7776 --prod 7777" },
};

const AC_WORKING = {
  id: "AC-3",
  type: "CODE",
  statement: "the container port is configured",
  threshold: { op: ">=", value: 1, unit: "matches" },
  evidenceMethod: { type: "COMMAND", command: 'grep -c "7776" .claude/rungate.json' },
};

const AC_ZERO_MATCH_SILENT = {
  id: "AC-4",
  type: "CODE",
  statement: "no TODO markers remain in the dashboard source",
  threshold: { op: "==", value: 0, unit: "occurrences" },
  evidenceMethod: { type: "COMMAND", command: 'grep "TODO-BEFORE-SHIP" src/app.ts' },
};

/** The consumer's real AC set — one of its commands cannot run. */
const CONSUMER_ACS = [AC_ZERO_MATCH_COUNTED, AC_UNEXECUTABLE, AC_WORKING, AC_ZERO_MATCH_SILENT];

/** The same set with the unexecutable command removed. The positive control. */
const CLEAN_ACS = [AC_ZERO_MATCH_COUNTED, AC_WORKING, AC_ZERO_MATCH_SILENT];

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "consumer-prevalidation-"));
  WORK = join(SCRATCH, "work");
  PROJECT = join(SCRATCH, "consumer");
  mkdirSync(WORK, { recursive: true });
  plantConsumer();
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function plantState(reading: unknown, acs: Array<Record<string, unknown>>): void {
  const state: Record<string, unknown> = {
    schemaVersion: 2,
    issue: 274,
    slug: "pai-harness-274",
    phase: "VERIFY",
    projectRoot: PROJECT,
    issueGoal: "a consumer's broken evidence command refuses the gate BY NAME",
    sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs,
  };
  if (reading !== undefined) state.evidencePrevalidation = reading;
  writeFileSync(join(WORK, "workflow-state.json"), JSON.stringify(state, null, 2));
}

/**
 * `ran` is not a formality: a `-t` filter that matches nothing leaves bun
 * reporting zero failures, which is indistinguishable from the check passing.
 * Every assertion below goes through it first.
 */
function runGateCheck(): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", GATE_SUITE, "-t", "evidence-prevalidation"], {
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
  return { ran: count("pass") + count("fail") === 1, red: count("fail") === 1, output };
}

// ── AC-1: the pre-validator, over the consumer's real AC set ────────────────

describe("#274 AC-1: the consumer's AC set is dry-run by the real pre-validator", () => {
  test("a zero-match grep is CLASSIFIED, not auto-widened", async () => {
    // What was broken to prove this can fail: restoring the `|| true` auto-fix
    // #271 deleted makes both of these report `autoFixed` with a widened
    // command, and the exit-2 cases it used to swallow come back with it.
    const results = await prevalidateEvidence(CONSUMER_ACS as any, PROJECT);
    const by = (id: string) => results.find(r => r.id === id)!;

    // `grep -c` printed "0" — the value the `== 0` threshold wants — and exited
    // 1. That is a measurement, so it is `ok`.
    expect(by("AC-1").status, "a counted zero-match grep was not classified ok").toBe("ok");
    // Plain `grep` printed nothing. That is `empty`: the command ran and
    // produced no value. Collapsing it into `ok` would hand the gate an AC with
    // no evidence, which is #277.
    expect(by("AC-4").status, "a silent zero-match grep was not classified empty").toBe("empty");

    for (const id of ["AC-1", "AC-4"]) {
      expect(by(id).autoFixed, `${id} was auto-widened instead of classified`).toBeUndefined();
      expect(by(id).fixedCommand, `${id} was rewritten`).toBeUndefined();
    }
    // The widening this replaced, named so it cannot come back silently.
    expect(JSON.stringify(results)).not.toContain("|| true");
  }, 60000);

  test("an unexecutable command is classified broken, and nothing repairs it", async () => {
    const results = await prevalidateEvidence(CONSUMER_ACS as any, PROJECT);
    const broken = results.filter(r => r.status === "broken");
    expect(broken.map(r => r.id), "the unexecutable command was not the only broken one").toEqual([
      "AC-2",
    ]);
    expect(broken[0].needsRewrite).toBe(true);
    expect(broken[0].autoFixed, "the unexecutable command was auto-fixed").toBeUndefined();
    expect(broken[0].diagnostic, "the diagnostic does not say what happened").toContain("exit code");

    // The positive control: with that AC removed, nothing is broken. Without
    // it, a classifier that calls everything broken satisfies the case above.
    const clean = await prevalidateEvidence(CLEAN_ACS as any, PROJECT);
    expect(clean.filter(r => r.status === "broken")).toEqual([]);
  }, 60000);
});

// ── AC-2: the derived reading is a schema-valid FAIL that names the AC ──────

describe("#274 AC-2: the reading is a schema-valid FAIL naming the offending AC", () => {
  test("the measured FAIL validates under gates/schema.ts and names AC-2", async () => {
    const reading = await measureEvidencePrevalidation(CONSUMER_ACS as any, PROJECT);
    expect(reading.verdict).toBe("FAIL");

    const parsed = EvidencePrevalidationSchema.safeParse(reading);
    expect(
      parsed.success,
      parsed.success ? "" : parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "),
    ).toBe(true);

    // The whole point of the sub-issue: the reading says WHICH AC, in the key
    // the gate's refusal site reads. Before this, `broken` existed only in
    // `prevalidationViolations`' expectations and in no writer.
    expect(reading.broken, "the FAIL does not name the AC it refuses for").toEqual(["AC-2"]);
    expect(reading.acs.find(a => a.id === "AC-2")?.status).toBe("broken");
  }, 60000);

  test("the clean AC set measures a schema-valid PASS that names nothing", async () => {
    const reading = await measureEvidencePrevalidation(CLEAN_ACS as any, PROJECT);
    expect(reading.verdict).toBe("PASS");
    expect(reading.broken).toEqual([]);
    expect(EvidencePrevalidationSchema.safeParse(reading).success).toBe(true);
  }, 60000);

  test("the schema refuses a FAIL whose named ACs do not match what it measured", async () => {
    // Three mutations of the measured reading, so the validation above is not
    // satisfied by a schema that accepts everything.
    const reading = await measureEvidencePrevalidation(CONSUMER_ACS as any, PROJECT);

    const dropped: Record<string, unknown> = { ...reading };
    delete dropped.broken;
    expect(
      EvidencePrevalidationSchema.safeParse(dropped).success,
      "a FAIL with no named AC was accepted",
    ).toBe(false);

    expect(
      EvidencePrevalidationSchema.safeParse({ ...reading, broken: [] }).success,
      "a FAIL naming nothing was accepted",
    ).toBe(false);

    expect(
      EvidencePrevalidationSchema.safeParse({ ...reading, broken: ["AC-9"] }).success,
      "a FAIL naming an AC it never classified broken was accepted",
    ).toBe(false);

    expect(
      EvidencePrevalidationSchema.safeParse({ ...reading, broken: ["AC-1", "AC-2"] }).success,
      "a FAIL naming an AC that measured ok was accepted",
    ).toBe(false);
  }, 60000);

  test("an UNMEASURED reading names nothing, and a reading that names nothing stays valid", async () => {
    const reading = await measureEvidencePrevalidation([], PROJECT);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.broken).toEqual([]);
    expect(EvidencePrevalidationSchema.safeParse(reading).success).toBe(true);
    expect(
      EvidencePrevalidationSchema.safeParse({ ...reading, broken: ["AC-2"] }).success,
      "an UNMEASURED reading named a broken AC it has no results for",
    ).toBe(false);
  }, 60000);
});

// ── AC-3: the gate's single refusal site, observed from its own output ──────

describe("#274 AC-3: the scope gate refuses the measured reading and passes the clean one", () => {
  test("the gate refuses, and the refusal names AC-2", async () => {
    const reading = await measureEvidencePrevalidation(CONSUMER_ACS as any, PROJECT);
    expect(reading.verdict).toBe("FAIL");
    plantState(reading, CONSUMER_ACS);

    const r = runGateCheck();
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(
      true,
    );
    expect(r.red, `a measured pre-validation FAIL did not fail the gate:\n${r.output}`).toBe(true);
    // Red for the stated reason. A gate suite that failed to load is red too,
    // and the count alone cannot tell them apart.
    expect(r.output, "the refusal does not name the AC to fix").toContain(
      "broken evidence commands on AC-2",
    );
    // The defect itself, asserted as its own absence: every genuine FAIL used
    // to land here, because no writer produced the key the refusal reads.
    expect(r.output, "the refusal still cannot name what to fix").not.toContain(
      "no broken AC ids were recorded",
    );
  }, 180000);

  test("the same gate passes the clean AC set", async () => {
    // Without this control, a gate that refuses everything satisfies the case
    // above.
    const reading = await measureEvidencePrevalidation(CLEAN_ACS as any, PROJECT);
    expect(reading.verdict).toBe("PASS");
    plantState(reading, CLEAN_ACS);

    const r = runGateCheck();
    expect(r.ran, `evidence-prevalidation never ran — the filter matched nothing:\n${r.output}`).toBe(
      true,
    );
    expect(r.red, `a measured pre-validation PASS failed the gate:\n${r.output}`).toBe(false);
  }, 180000);
});

// ── AC-4: the guide documents the FAIL shape the pre-validator emits ────────

describe("#274 AC-4: gates/SCHEMA-GUIDE.md documents the FAIL shape", () => {
  const section = () => {
    const guide = readFileSync(GUIDE, "utf-8");
    const start = guide.indexOf("## evidencePrevalidation");
    expect(start, "the guide has no evidencePrevalidation section").toBeGreaterThan(-1);
    const rest = guide.slice(start + 1);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  test("the field table documents `broken`", () => {
    // Read out of the FIRST table under the heading — the same extraction
    // test/unit/evidence-prevalidation-gate.test.ts uses for its both-ways
    // parity check, so a row added to the prose instead of the table does not
    // satisfy this.
    const fields: string[] = [];
    let inTable = false;
    for (const line of section().split("\n").slice(1)) {
      if (line.startsWith("|")) {
        inTable = true;
        const m = line.match(/^\|\s*`([^`]+)`/);
        if (m) fields.push(m[1]);
      } else if (inTable) break;
    }
    expect(fields, "`broken` is not in the evidencePrevalidation field table").toContain("broken");
  });

  test("the documented FAIL example carries the ids of its broken ACs", () => {
    const text = section();
    const block = text.slice(text.indexOf('{ "evidencePrevalidation"'));
    const json = JSON.parse(block.slice(0, block.indexOf("```"))).evidencePrevalidation;
    expect(json.verdict, "the worked example is not a FAIL").toBe("FAIL");
    expect(
      json.broken,
      "the documented FAIL does not name the ACs its own acs[] classified broken",
    ).toEqual(json.acs.filter((a: any) => a.status === "broken").map((a: any) => a.id));
    expect(json.broken.length, "the documented FAIL names nothing").toBeGreaterThan(0);
    // And the example is the real contract, not prose: it validates.
    expect(EvidencePrevalidationSchema.safeParse(json).success).toBe(true);
  });

  test("the guide says which reader the field exists for", () => {
    expect(section()).toContain("prevalidationViolations");
  });
});

// ── AC-5: the config-expressibility answer is on the record ─────────────────

describe("#274 AC-5: the 7776-before-7777 question is answered in writing", () => {
  const spec = () => readFileSync(SPEC, "utf-8");

  test("the answer carries an explicit verdict token and both ports", () => {
    const text = spec();
    expect(text, "no explicit expressible-or-not verdict").toMatch(/NOT-EXPRESSIBLE|EXPRESSIBLE/);
    expect(text, "the consumer's test port is not named").toContain("7776");
    expect(text, "the consumer's production port is not named").toContain("7777");
  });

  test("the answer names the three mechanisms the gap is made of", () => {
    const text = spec();
    // The config-key split (#294): same fact, two key names.
    expect(text, "the dev.testCmd / test.command split is not named").toContain("dev.testCmd");
    expect(text, "the dev.testCmd / test.command split is not named").toContain("test.command");
    // The gate checks that read config at all.
    expect(text, "loadProjectHarness is not named").toContain("loadProjectHarness");
    // The ship.js record-env site a DDB run surfaces the gap at.
    expect(text, "the ship.js record-env site is not named").toContain("workflows/ship.js");
    expect(text, "the field an agent writes to PASS is not named").toContain(
      "environments.prod.rebuild",
    );
  });

  test("the claims the answer makes about the code are true of the code", () => {
    // A written answer nobody re-checks is a comment. Each claim is re-derived
    // from source here, so the record goes red when the code moves under it.
    const gateSuite = readFileSync(GATE_SUITE, "utf-8");
    const executor = readFileSync(join(REPO_ROOT, "gates", "gate-executor.ts"), "utf-8");
    const shipJs = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    const text = spec();

    // 1. The two key names for one fact.
    expect(gateSuite, "tests-pass no longer reads dev.testCmd").toContain("harness?.dev?.testCmd");
    expect(executor, "the test baseline no longer reads test.command").toContain("harness.test?.command");

    // 2. The count of gate checks behind loadProjectHarness, stated in the
    //    answer and counted here rather than trusted.
    const callSites = (gateSuite.match(/loadProjectHarness\(\)/g) || []).length - 1; // minus the declaration
    const stated = Number(/(\d+) gate checks sit behind `loadProjectHarness/.exec(text)?.[1] ?? "-1");
    expect(stated, `the answer's count of loadProjectHarness-gated checks is not ${callSites}`).toBe(
      callSites,
    );

    // 3. The record-env prompt writes the rebuild verdict from a curl status.
    expect(shipJs, "ship.js no longer writes prod.rebuild = 'PASS' from a prompt").toContain(
      "s.environments.prod.rebuild = 'PASS'",
    );
    expect(shipJs).toContain("label: 'record-env'");

    // 4. The port 7776 the harness does know about is hardcoded in a check that
    //    only warns — the reason the answer's verdict is what it is.
    expect(gateSuite, "quinn-container-port no longer hardcodes 7776").toContain("port !== 7776");
  });
});
