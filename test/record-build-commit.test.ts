import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { REFUSE_EXIT, buildMarcusRecord } from "../scripts/record-build-commit";

/**
 * scripts/record-build-commit.ts — the commit step's state write stops being
 * an unobserved side effect (#166).
 *
 * `workflows/ship.js` told the commit agent, as step 3 of 3, to run a `bun -e`
 * one-liner setting `buildCommit` and `agents`. The schema it answered with
 * asked only for `{branch, commitSha, pushed}`. So an agent could commit,
 * push, answer correctly, and never run step 3 — and the workflow read that as
 * a fully successful commit. On `wf_b5f65252-24f` it did exactly that, and the
 * ship gate refused the run six agents later with "neither buildCommit nor
 * agents.marcus.branch present". Two earlier runs had the fields, so the
 * failure is intermittent, which is worse than always-broken.
 *
 * The second defect was in the one-liner itself: `s.agents = {marcus, quinn}`
 * is an assignment. It is safe today only because it runs before rook does.
 * #161 made `agents.rook` the record of whether security ran, so anything
 * re-running that write after the Verify phase erases it and the run reaches
 * the PR step with no security record.
 *
 * Executed against real files rather than asserted on source text: every
 * mutation that survived a first pass in session 34 was a source-text
 * assertion.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "record-build-commit.ts");
const SHA = "dd242a62aea9371d788abb58f3d26922d5dd6cbc";

let DIR = "";
let STATE = "";
let MUTANT = "";

/** The smallest workflow-state.json that writeWorkflowState will accept. */
function baseState(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    issue: 166,
    slug: "pai-harness-166",
    phase: "BUILD",
    issueGoal: "the commit step's state write is observed",
    acs: [
      {
        id: "AC-1",
        type: "CODE",
        statement: "buildCommit is present in workflow-state.json after the commit step",
        threshold: { op: "==", value: 0, unit: "exit code" },
        evidenceMethod: { type: "BUN_TEST" },
      },
    ],
    ...extra,
  };
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "record-build-commit-"));
  STATE = join(DIR, "workflow-state.json");
  writeFileSync(STATE, JSON.stringify(baseState(), null, 2));

  // The mutant: the same script with its one refusal exit code set to 0.
  // Every refusal case below runs against both, and asserts the real script
  // refuses while the mutant does not — so a case that starts passing for an
  // unrelated reason cannot be mistaken for a case that is genuinely caught
  // (.claude/rules/checks-must-be-able-to-fail.md).
  //
  // It lives in scripts/, not in the temp dir, because this script imports
  // `../gates/orchestrator`. From a temp directory that import does not
  // resolve, bun exits 1, and every mutant run reads as "the refusal was
  // rejected on the merits" — the precise false pass the rule warns about,
  // observed while writing this. Removed in afterEach, and
  // `no mutant is left behind` asserts it.
  const source = readFileSync(SCRIPT, "utf-8");
  const mutated = source.replace(/REFUSE_EXIT\s*=\s*1\b/, "REFUSE_EXIT = 0");
  if (mutated === source) {
    throw new Error("could not build the mutant: no `REFUSE_EXIT = 1` in scripts/record-build-commit.ts");
  }
  MUTANT = join(REPO_ROOT, "scripts", ".record-build-commit.mutant.ts");
  writeFileSync(MUTANT, mutated);
});

afterEach(() => {
  if (DIR) rmSync(DIR, { recursive: true, force: true });
  if (MUTANT) rmSync(MUTANT, { force: true });
});

function run(args: string[], script = SCRIPT) {
  const r = spawnSync("bun", [script, ...args], { encoding: "utf-8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function readState() {
  return JSON.parse(readFileSync(STATE, "utf-8"));
}

const OK = ["--state", "", "--sha", SHA, "--branch", "ship-166", "--quinn", "SKIP"];
function okArgs(state = STATE) {
  const a = [...OK];
  a[1] = state;
  return a;
}

describe("the commit reaches workflow-state.json", () => {
  test("buildCommit and agents.marcus are written", () => {
    const r = run(okArgs());
    expect(r.code, r.err).toBe(0);
    const s = readState();
    expect(s.buildCommit).toBe(SHA);
    expect(s.agents.marcus.branch).toBe("ship-166");
    expect(s.agents.marcus.commitSha).toBe(SHA);
    expect(s.agents.marcus.spawned).toBe(true);
  });

  test("the receipt names what it wrote", () => {
    const r = run(okArgs());
    const receipt = JSON.parse(r.out.trim().split("\n").pop()!);
    expect(receipt.ok).toBe(true);
    expect(receipt.buildCommit).toBe(SHA);
  });

  test("quinn's verdict comes from the caller, not from a guess", () => {
    const a = okArgs();
    a[a.indexOf("--quinn") + 1] = "PASS";
    expect(run(a).code).toBe(0);
    expect(readState().agents.quinn).toEqual({ spawned: true, verdict: "PASS" });

    writeFileSync(STATE, JSON.stringify(baseState(), null, 2));
    expect(run(okArgs()).code).toBe(0);
    expect(readState().agents.quinn).toEqual({ spawned: false, verdict: "SKIP" });
  });
});

describe("#166: the write merges, it does not replace", () => {
  // The latent half. `s.agents = {marcus, quinn}` erases everything else in
  // `agents`, and since #161 the thing it erases is the record of whether the
  // security review ran at all.
  test("an existing agents.rook survives", () => {
    const rook = {
      spawned: true,
      verdict: "FAIL",
      failures: ["HIGH: guard bypass"],
      testedSha: SHA,
      testedPaths: ["workflows/ship.js"],
    };
    writeFileSync(STATE, JSON.stringify(baseState({ agents: { rook } }), null, 2));

    expect(run(okArgs()).code).toBe(0);
    const s = readState();
    expect(s.agents.rook, "the security record was erased by the commit step").toEqual(rook);
    expect(s.agents.marcus.branch).toBe("ship-166");
  });

  test("buildMarcusRecord leaves other agents alone", () => {
    const before = { rook: { spawned: true, verdict: "PASS" } };
    const after = buildMarcusRecord(before, SHA, "ship-166", "SKIP");
    expect(after.rook).toEqual(before.rook);
    expect(after.marcus).toBeDefined();
    // The input is not mutated — a caller holding the old object must not see
    // it change under them.
    expect(before).toEqual({ rook: { spawned: true, verdict: "PASS" } });
  });
});

describe("#166: refusals, each shown against a mutant that does not refuse", () => {
  const CASES: Array<[string, string[]]> = [
    ["no --state", ["--sha", SHA, "--branch", "b", "--quinn", "SKIP"]],
    ["no --sha", ["--state", "", "--branch", "b", "--quinn", "SKIP"]],
    ["no --branch", ["--state", "", "--sha", SHA, "--quinn", "SKIP"]],
    ["a ref name instead of a SHA", ["--state", "", "--sha", "HEAD", "--branch", "b", "--quinn", "SKIP"]],
    ["a SHA with a command in it", ["--state", "", "--sha", "dd242a6; rm -rf /", "--branch", "b", "--quinn", "SKIP"]],
    ["a branch name that is not one", ["--state", "", "--sha", SHA, "--branch", "a b; c", "--quinn", "SKIP"]],
    ["a quinn verdict nobody recognises", ["--state", "", "--sha", SHA, "--branch", "b", "--quinn", "MAYBE"]],
    ["an unknown flag", ["--state", "", "--sha", SHA, "--branch", "b", "--quinn", "SKIP", "--force", "1"]],
  ];

  for (const [label, args] of CASES) {
    test(`refuses ${label}`, () => {
      const filled = args.map(a => (a === "" ? STATE : a));
      const real = run(filled);
      expect(real.code, `the real script accepted ${label}`).toBe(REFUSE_EXIT);

      const mutant = run(filled, MUTANT);
      expect(
        mutant.code,
        `the mutant (REFUSE_EXIT = 0) still exited ${mutant.code} for ${label} — ` +
          `the refusal does not run through REFUSE_EXIT, so zeroing it proves nothing`,
      ).toBe(0);
    });
  }

  test("the positive control: a well-formed call is accepted", () => {
    // Without this, refusing everything satisfies every assertion above.
    expect(run(okArgs()).code).toBe(0);
  });

  test("no mutant is left behind in scripts/", () => {
    // The mutant is written into the repo so its relative import resolves.
    // A leftover copy would be a second, silently weaker version of a refusal
    // script sitting in the tree, so its removal is asserted rather than
    // trusted to afterEach.
    rmSync(MUTANT, { force: true });
    expect(existsSync(MUTANT)).toBe(false);
  });

  test("REFUSE_EXIT is assigned exactly once", () => {
    const decls = (readFileSync(SCRIPT, "utf-8").match(/REFUSE_EXIT\s*=/g) || []).length;
    expect(decls, "more than one assignment — the mutant would neutralise only one").toBe(1);
  });

  test("every process.exit goes through REFUSE_EXIT", () => {
    const exits = readFileSync(SCRIPT, "utf-8").match(/process\.exit\([^)]*\)/g) || [];
    for (const e of exits) {
      expect(e, `${e} bypasses REFUSE_EXIT, so the mutant cannot neutralise it`).toBe(
        "process.exit(REFUSE_EXIT)",
      );
    }
  });
});

describe("#166: ship.js asks for the receipt rather than hoping for the side effect", () => {
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  /** The `commit` agent call, sliced from its label to the close of its options. */
  function commitStep(): string {
    const start = shipSource.indexOf("const commitResult = await agent(`");
    expect(start, "ship.js no longer has a `commitResult = await agent(` step").toBeGreaterThan(-1);
    const end = shipSource.indexOf("if (!commitResult?.commitSha)", start);
    expect(end, "the commit step's guard moved — this slicer is stale").toBeGreaterThan(start);
    return shipSource.slice(start, end);
  }

  test("the commit step calls the recorder", () => {
    expect(commitStep()).toContain("record-build-commit.ts");
  });

  test("the state write is a required field of the reply, not an instruction", () => {
    // The whole defect: an instruction an agent can skip without the reply
    // changing is not a step. If `stateRecorded` is not REQUIRED, the agent
    // can omit it and ship.js cannot tell.
    const step = commitStep();
    expect(step).toContain("stateRecorded");
    const required = step.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(required, `commit step required fields were: ${required}`).toContain("stateRecorded");
  });

  test("ship.js no longer sets agents by assignment", () => {
    // `s.agents = {marcus: …}` is the line that erases agents.rook.
    expect(shipSource).not.toContain("s.agents = {marcus");
  });

  /**
   * The guard, extracted from its markers and executed.
   *
   * The first version of this test asserted `shipSource.toContain(
   * "COMMIT_STATE_NOT_RECORDED")`, and reducing the branch to `if (false)`
   * left all 21 tests green. Executing it is the difference between checking
   * that a string is in the file and checking that the run stops.
   */
  function loadGuard(): (reply: unknown) => string | null {
    const start = shipSource.indexOf("// ──── COMMIT-STATE-GUARD-START ────");
    const end = shipSource.indexOf("// ──── COMMIT-STATE-GUARD-END ────");
    expect(start, "ship.js is missing the COMMIT-STATE-GUARD markers").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(`${shipSource.slice(start, end)}\nreturn commitStateRefusal`)();
  }

  test("a reply that does not confirm the state write stops the run", () => {
    const guard = loadGuard();
    for (const reply of [
      { commitSha: "dd242a62", branch: "b", pushed: true },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: false },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: "true" },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: null },
      { commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: 1 },
      undefined,
      null,
      "ok",
    ]) {
      expect(
        guard(reply),
        `${JSON.stringify(reply)} was accepted as a recorded commit`,
      ).toBeTruthy();
    }
  });

  test("a reply that confirms it does not stop the run", () => {
    // The positive control: refusing everything satisfies the case above.
    expect(loadGuard()({ commitSha: "dd242a62", branch: "b", pushed: true, stateRecorded: true })).toBeNull();
  });

  test("the refusal names the commit it is refusing", () => {
    const reason = loadGuard()({ commitSha: "dd242a62", stateRecorded: false });
    expect(reason).toContain("dd242a62");
    expect(reason).toContain("COMMIT_STATE_NOT_RECORDED");
  });

  test("the guard is wired into the run, not merely defined", () => {
    // A function nothing calls is the shape #162's round one shipped: a
    // 270-line script, fully tested, that the workflow never executed.
    expect(shipSource).toContain("const stateRefusal = commitStateRefusal(commitResult)");
    expect(shipSource).toMatch(/if \(stateRefusal\) \{[\s\S]{0,400}status: 'COMMIT_FAILED'/);
  });

  // ── #169 ──────────────────────────────────────────────────────────────
  //
  // `buildCommit` was written once, by the first commit step, and never again.
  // Both regression rounds commit and push after it — so on any run that
  // needed one, `buildCommit` named a commit the branch had moved past, and
  // the container-verify step that compares HEAD against it was comparing
  // against a stale value. Same family as the security review's `testedSha`:
  // a value captured at one point and consumed later as though it still
  // described the run.

  /** A recommit agent step, sliced from its label backwards to its prompt. */
  function recommitStep(label: string): string {
    const marker = `'${label}'`;
    const end = shipSource.indexOf(marker);
    expect(end, `ship.js has no ${label} step`).toBeGreaterThan(-1);
    const start = shipSource.lastIndexOf("await agent(`", end);
    expect(start, `the ${label} step is no longer an agent call`).toBeGreaterThan(-1);
    // Out to the close of the options object, so `required:` is included.
    return shipSource.slice(start, shipSource.indexOf("})", end) + 2);
  }

  for (const label of ["recommit-verify", "recommit-ship"]) {
    test(`the ${label} step re-records buildCommit with the new SHA`, () => {
      const step = recommitStep(label);
      expect(step, `${label} commits and pushes without updating buildCommit (#169)`)
        .toContain("record-build-commit.ts");
      // The SHA it records is the one git just printed for the new HEAD, not
      // the SHA the run started from.
      expect(step).toMatch(/--sha "\$commitSha"|--sha "\$sha"/);
    });

    test(`the ${label} state write is a required field of the reply`, () => {
      // #166's lesson applied to the rounds that were left out of it: an
      // instruction an agent can skip without the reply changing is not a step.
      const step = recommitStep(label);
      const required = step.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
      expect(required, `${label} required fields were: ${required}`).toContain("stateRecorded");
    });
  }

  test("the recorder is reached on every path that moves the branch", () => {
    // Counted rather than spot-checked: three commit steps push to the ship
    // branch, and each one must re-record. A fourth added later without a
    // recorder makes this fail rather than slip through.
    const pushes = (shipSource.match(/git push (-u )?origin/g) || []).length;
    // The interpolated command form, not every mention of the filename —
    // `commitStateRefusal` names the script in its refusal text, and counting
    // that would let a step with no recorder borrow another step's credit.
    const records = (shipSource.match(/record-build-commit\.ts`\)\}/g) || []).length;
    expect(records, `${pushes} steps push to the branch but only ${records} record the commit`)
      .toBeGreaterThanOrEqual(pushes);
  });
});
