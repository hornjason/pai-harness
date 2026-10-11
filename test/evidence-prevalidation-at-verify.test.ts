/**
 * The evidence pre-validation reading exists wherever the gate checks it (#261)
 *
 * #235 made an absent `evidencePrevalidation` a refusal, correctly: "the writer
 * never ran" and "the writer ran and measured nothing" are the same failure.
 * The only writer was the SCOPE gate. `workflows/ship.js` skips the whole scope
 * gate when Discovery sizes a run LIGHT:
 *
 *     const skipScope = discovery.ceremonyTier === 'LIGHT'
 *
 * The consumer is guarded by `isVerifyPlus()`, so it runs anyway. Composed:
 * every LIGHT-tier run failed its verify gate, on every attempt, no matter what
 * code it was shipping. Run wf_ed24496e-e49 reached VERIFY with all six of its
 * ACs PASS and burned two heal rounds against a refusal no change to the
 * shipped code could have satisfied.
 *
 * This is `.claude/rules/checks-must-be-able-to-fail.md` met from the mirror
 * side. That rule is about a check that cannot FAIL; this is a check that
 * cannot PASS. Both come from the same root — a check whose phase did not imply
 * its producer's phase — and both are invisible for the same reason: the gate
 * output looked exactly like a run with a real problem.
 *
 * So the fix is only half the work. Making the producer run at verify would
 * make this check green forever if it rubber-stamped, which is the first
 * failure mode back. Every case below therefore runs the REAL gate executor —
 * `bun run gates/run-gate.ts --gate verify` against a planted work dir, the
 * same shape as test/verify-fanout-recording.test.ts — and reads what it
 * actually wrote. None of them reads the source.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_RUNNER = join(REPO_ROOT, "gates", "run-gate.ts");
const GOVERNING_SPEC = join(REPO_ROOT, "specs", "HARNESS-STANDARD.md");
const BASE_DIR = "/tmp/harness-prevalidation-at-verify";

/** A command that cannot be auto-fixed into success, so it classifies broken. */
const BROKEN_COMMAND = "exit 7";
/** A command that succeeds with output, so it classifies ok. */
const WORKING_COMMAND = "echo evidence-reachable";

beforeEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
  mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

/**
 * A verify-phase state with NO scope gate entry and NO pre-validation reading.
 *
 * Both absences are the fixture. A LIGHT run arrives at verify exactly like
 * this, because the phase that used to take the reading never happened — so
 * anything found at `evidencePrevalidation` on the way out was written by the
 * verify gate itself.
 */
function plant(
  slug: string,
  opts: { command?: string; tier?: string; extra?: Record<string, unknown> } = {},
): string {
  const dir = join(BASE_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const state = {
    schemaVersion: 2,
    issue: 261,
    slug,
    repo: "test/repo",
    issueRepo: "test/repo",
    // A real directory, because the pre-validator runs the command with this as
    // its cwd — a missing cwd makes execSync throw and EVERY command classify
    // broken, which would make the PASS cases below pass for the wrong reason.
    projectRoot: BASE_DIR,
    phase: "VERIFY",
    issueGoal: "the pre-validation reading exists wherever the gate checks it",
    sizing: { predicted: "XS", ceremonyTier: opts.tier || "LIGHT" },
    sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "the reading is taken wherever it is read",
        threshold: { op: "==", value: 0, unit: "failures" },
        evidenceMethod: { type: "BASH", command: opts.command || WORKING_COMMAND },
      },
    ],
    // No `gates.scope`. That is the whole fixture.
    gates: {},
    environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
    agents: { marcus: { spawned: true, verdict: "PASS" } },
    buildCommit: "abc1234",
    changelog: [],
    bootstrappedFrom: "ship-workflow",
    ...(opts.extra || {}),
  };
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2));
  return dir;
}

/**
 * Run the real verify gate and return what it wrote — having first checked
 * that it ran.
 *
 * The check is not ceremony. A gate runner that dies before `runGateTests` —
 * on a bad path, a missing env var, a throw in a pre-flight — leaves
 * `evidencePrevalidation` absent, which is EXACTLY what the unfixed code
 * leaves. Red for the right reason and red because the subject never executed
 * are indistinguishable from the assertion alone, and the second one turns
 * green the moment the fix lands, for no reason connected to the fix. So every
 * case goes through the gate's own changelog first: the verify entry records
 * the suite's pass count, and a run that reports fewer than this many checks
 * did not get as far as the thing being tested.
 *
 * This is the `ran === 1` discipline from
 * .claude/rules/checks-must-be-able-to-fail.md, applied to a spawn whose
 * failure mode is silence rather than an exception.
 */
const MIN_GATE_CHECKS = 100;

function runVerify(slug: string, env: Record<string, string> = {}): Record<string, any> {
  let output = "";
  const prefix = Object.entries({
    RUNGATE_WORK_DIR: BASE_DIR,
    RUNGATE_SKIP_AGENTS: "1",
    ...env,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  try {
    output = execSync(
      `${prefix} bun run ${GATE_RUNNER} --gate verify --slug ${slug} --issue 261 2>&1`,
      { encoding: "utf-8", timeout: 300000 },
    );
  } catch (e: any) {
    // A failing verify gate exits non-zero. Half these cases are supposed to
    // fail; what matters is what the run wrote before exiting.
    output = e?.stdout?.toString?.() || "";
  }

  const out = JSON.parse(readFileSync(join(BASE_DIR, slug, "workflow-state.json"), "utf-8"));

  // The LAST entry, not the first. The changelog accumulates across attempts,
  // and the heal case below runs this twice against one work dir — reading
  // attempt 1's record while asserting on attempt 2's state is the kind of
  // off-by-one that makes a test agree with whatever it is given.
  const entries = (out.changelog || []).filter((c: any) => c?.event === "gate-verify");
  const entry = entries[entries.length - 1];
  expect(entry, `the verify gate never recorded a result. Gate output:\n${output}`).toBeTruthy();
  const passes = parseInt(String(entry.detail).match(/(\d+)\s+pass/)?.[1] || "0", 10);
  expect(
    passes,
    `the verify gate reported only ${passes} checks, so the gate suite did not really run — ` +
      `this case would be red whether or not the subject works. Gate output:\n${output}`,
  ).toBeGreaterThan(MIN_GATE_CHECKS);

  return out;
}

/** The gate's own record of which checks refused, by check name. */
function prevalidationFailures(out: Record<string, any>): string[] {
  return (out.gates?.verify?.failures || [])
    .map((f: any) => `${f?.check ?? ""} ${f?.detail ?? ""}`)
    .filter((s: string) => /evidence-prevalidation/.test(s));
}

describe("#261: a LIGHT run reaches a verify verdict on its own merits", () => {
  test("the verify gate writes the reading the scope gate never took", () => {
    const out = runVerify((plant("light-clean"), "light-clean"));

    const reading = out.evidencePrevalidation;
    expect(reading, "no pre-validation reading was written at the verify gate").toBeTruthy();
    expect(reading.verdict, `reading: ${JSON.stringify(reading)}`).toBe("PASS");
    expect(reading.acs.map((r: any) => r.id)).toContain("AC-1");
    // The scope gate genuinely did not run — otherwise this test would be
    // measuring the old path and would stay green after a revert.
    expect(out.gates?.scope, "a scope gate ran, so this is not the LIGHT path").toBeUndefined();
  });

  test("the reading is on disk BEFORE the gate suite is spawned", () => {
    // The ordering assertion, and it is the reason the two halves below are in
    // one test rather than two. The gate suite is a separate `bun test` process
    // that reads workflow-state.json AS IT STANDS ON DISK. So:
    //
    //   - the reading present in the final file proves the producer ran;
    //   - the absence of its refusal from the failures the suite reported
    //     proves the producer ran FIRST.
    //
    // A reading written after `runGateTests` would satisfy the first and fail
    // the second, and only the second distinguishes a fix from a fix-shaped
    // write in the wrong place. Nothing here reads the source (SC-2).
    const out = runVerify((plant("light-ordering"), "light-ordering"));

    expect(out.evidencePrevalidation?.verdict).toBe("PASS");
    const refusals = prevalidationFailures(out);
    expect(
      refusals,
      `the suite refused on a reading the run had taken: ${refusals.join("; ")}`,
    ).toEqual([]);
  });

  test("a broken evidence command on a LIGHT run still refuses", () => {
    // The rubber-stamp case. Measuring at verify buys nothing if the
    // measurement cannot come back FAIL — that would be the same defect with
    // the sign flipped, and it would be green forever.
    const out = runVerify((plant("light-broken", { command: BROKEN_COMMAND }), "light-broken"));

    expect(out.evidencePrevalidation?.verdict, "a command that exits 7 measured clean").toBe("FAIL");
    expect(out.evidencePrevalidation.acs.find((r: any) => r.id === "AC-1")?.status).toBe("broken");
    expect(
      prevalidationFailures(out),
      "the gate accepted a measured FAIL",
    ).not.toEqual([]);
    expect(out.gates?.verify?.result).toBe("FAIL");
  });

  test("an explicit UNMEASURED reading is still a refusal, not a retry", () => {
    // SC-5, and the fail-open this fix could most easily have introduced: "if
    // the reading is missing, go get one" must not become "if the reading is
    // bad, go get a better one". A recorded UNMEASURED is a recorded failure.
    const out = runVerify((
      plant("light-unmeasured", {
        extra: {
          evidencePrevalidation: {
            verdict: "UNMEASURED",
            checkedAt: "2020-01-01T00:00:00.000Z",
            acs: [],
            reason: "the pre-validator threw",
          },
        },
      }),
      "light-unmeasured"
    ));

    expect(out.evidencePrevalidation.verdict, "an UNMEASURED reading was overwritten").toBe("UNMEASURED");
    expect(out.evidencePrevalidation.checkedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(prevalidationFailures(out), "the gate accepted an UNMEASURED reading").not.toEqual([]);
  });

  test("a STANDARD run that already measured is not measured a second time", () => {
    // SC-3. The sentinel is a PASS reading on an AC whose command is broken: if
    // the verify gate re-measured, the verdict would flip to FAIL and
    // `checkedAt` would move. Both staying put is the only shape that proves
    // exactly one measurement happened, and it needs no clock.
    const out = runVerify((
      plant("standard-once", {
        tier: "STANDARD",
        command: BROKEN_COMMAND,
        extra: {
          gates: { scope: { result: "PASS", attempt: 1, failures: [] } },
          evidencePrevalidation: {
            verdict: "PASS",
            checkedAt: "2020-01-01T00:00:00.000Z",
            acs: [{ id: "AC-1", status: "ok" }],
            reason: null,
          },
        },
      }),
      "standard-once"
    ));

    expect(out.evidencePrevalidation.checkedAt, "the scope gate's reading was re-taken at verify")
      .toBe("2020-01-01T00:00:00.000Z");
    expect(out.evidencePrevalidation.verdict).toBe("PASS");
    expect(prevalidationFailures(out)).toEqual([]);
  });
});

/**
 * #264 — the two defects #261 shipped, found by the first real run after it.
 *
 * Run `wf_c71f950f-c88` on #254: four verify attempts over thirteen minutes,
 * all six ACs PASS, and the gate refused every time on one reading taken at
 * 00:29 in the wrong directory. SHIP_FAILED. The fix for "a check that cannot
 * pass" had reintroduced the same shape in a narrower form.
 *
 * **D1, the directory.** The pre-validator dry-ran the AC commands with
 * `state.projectRoot` while the evidence COLLECTOR runs them with
 * `EVIDENCE_CWD` — which `workflows/ship.js` sets exactly when the gate's cwd
 * differs from the project root, i.e. under the worktree isolation `marcus`
 * always uses. One set of commands, two directories, opposite answers: the
 * command the pre-validator called broken reported 18 pass in the worktree.
 *
 * **D2, the freeze.** The measure-once guard — correct for "the scope gate
 * already measured this" — also froze a reading taken at VERIFY, so attempts
 * 2, 3 and 4 were judged against attempt 1's measurement and no heal round
 * could clear it.
 *
 * Neither is fatal alone. D1 costs one attempt and heals; D2 is invisible if
 * the first reading is right. The composition is a refusal the branch cannot
 * satisfy, which is #261 again.
 *
 * Both cases below set the two directories to DIFFERENT paths and put the file
 * the AC command needs in only one of them. A fixture where they are the same
 * directory passes whichever one the code picks, which is how this shipped.
 */
describe("#264: the reading is taken where the evidence is, and re-taken when it heals", () => {
  /** Exists only under the "worktree", so the chosen cwd decides the verdict. */
  const MARKER_COMMAND = "test -f ./ac-marker.txt && echo found-the-marker";

  test("the dry run follows EVIDENCE_CWD, like the evidence collector does", () => {
    // projectRoot is the planted dir and has no marker. The "worktree" is a
    // sibling that does. With the pre-validator reading projectRoot the
    // command is broken; with it reading EVIDENCE_CWD the command is fine.
    // Exactly the #254 shape: a file that exists only on the branch.
    const worktree = join(BASE_DIR, "pretend-worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "ac-marker.txt"), "the branch created this\n");

    plant("cwd-follows-evidence", { command: MARKER_COMMAND });
    const out = runVerify("cwd-follows-evidence", { EVIDENCE_CWD: worktree });

    const reading = out.evidencePrevalidation;
    expect(
      reading?.verdict,
      `the dry run looked in the wrong directory: ${JSON.stringify(reading?.acs)}`,
    ).toBe("PASS");
    expect(reading.acs.find((r: any) => r.id === "AC-1")?.status).toBe("ok");
  });

  test("a verify-taken reading is re-taken on the next attempt, so a heal can clear it", () => {
    // The heal round, simulated without an agent: attempt 1 runs with the file
    // absent and records FAIL; the file then appears, the way a heal round
    // makes a broken evidence command work; attempt 2 must MEASURE AGAIN.
    //
    // Nothing about the state is edited between the runs. The only thing that
    // changes is the world the command looks at, which is the only thing a
    // heal round changes.
    const worktree = join(BASE_DIR, "healing-worktree");
    mkdirSync(worktree, { recursive: true });

    plant("heal-reading", { command: MARKER_COMMAND });
    const first = runVerify("heal-reading", { EVIDENCE_CWD: worktree });
    expect(first.evidencePrevalidation?.verdict, "attempt 1 should have failed").toBe("FAIL");
    const firstCheckedAt = first.evidencePrevalidation.checkedAt;

    writeFileSync(join(worktree, "ac-marker.txt"), "the heal round created this\n");
    const second = runVerify("heal-reading", { EVIDENCE_CWD: worktree });

    expect(
      second.evidencePrevalidation?.verdict,
      "attempt 2 was judged against attempt 1's reading, so the heal could not clear it",
    ).toBe("PASS");
    expect(
      second.evidencePrevalidation.checkedAt,
      "the reading was never re-taken — same timestamp on both attempts",
    ).not.toBe(firstCheckedAt);
    expect(prevalidationFailures(second), "the gate refused on a stale reading").toEqual([]);
  });

  test("the state records WHICH gate took the reading", () => {
    // The distinction the fix needs. "A reading exists" cannot separate "the
    // scope gate measured this run's starting conditions" from "a previous
    // verify attempt measured this", and those two want opposite treatment on
    // the next attempt. Without it the fix has to guess, and guessing is how
    // D2 got written.
    plant("records-its-source");
    const out = runVerify("records-its-source");
    expect(out.evidencePrevalidation?.takenAt, "the reading does not say where it came from")
      .toBe("verify");
  });

  test("a scope-taken reading still survives verify, unchanged", () => {
    // The guard D2's fix must not break, stated against the new field rather
    // than inherited from the older case above. A STANDARD run measured its
    // starting conditions at scope; re-measuring them after Marcus has run
    // answers a different question.
    const out = runVerify((
      plant("scope-reading-survives", {
        tier: "STANDARD",
        command: BROKEN_COMMAND,
        extra: {
          gates: { scope: { result: "PASS", attempt: 1, failures: [] } },
          evidencePrevalidation: {
            verdict: "PASS",
            checkedAt: "2020-01-01T00:00:00.000Z",
            acs: [{ id: "AC-1", status: "ok" }],
            reason: null,
            takenAt: "scope",
          },
        },
      }),
      "scope-reading-survives"
    ));

    expect(out.evidencePrevalidation.checkedAt, "a scope reading was re-taken at verify")
      .toBe("2020-01-01T00:00:00.000Z");
    expect(out.evidencePrevalidation.verdict).toBe("PASS");
  });
});

/**
 * Not asserted here, and filed instead: `prevalidationViolations` in
 * gates/workflow.test.ts names the broken ACs out of `reading.broken`, and no
 * writer has ever produced that key — `measureEvidencePrevalidation` returns
 * per-AC results under `acs`, and `EvidencePrevalidationSchema` enforces that a
 * FAIL carries at least one `acs[].status === "broken"`. So every genuine FAIL
 * refuses with "no broken AC ids were recorded", which is true of the key and
 * false of the reading.
 *
 * Fail-closed, so the gate still refuses — the "a broken evidence command on a
 * LIGHT run still refuses" case above is real. But a refusal the heal loop
 * cannot act on costs a round and teaches nothing, which is part of how #261
 * cost two. It is a separate defect in a separate function and it gets its own
 * issue rather than riding along in this one.
 *
 * It is not asserted in this file for a mechanical reason as well: the function
 * lives in a `.test.ts` file, so importing it would run the entire gate suite
 * inside this one. test/suite-binding-mutation.test.ts reaches it by spawning,
 * which is where that fix's test belongs.
 */
