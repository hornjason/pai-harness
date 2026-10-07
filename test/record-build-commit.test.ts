import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
});

describe("AC-5 (#169): every recommit re-records the commit it produced", () => {
  /**
   * Three steps commit to this run's branch — the commit step and the two
   * remediation recommits — and only the first recorded anything. So
   * `buildCommit` named the FIRST commit of the run: the value Quinn's
   * container check compares HEAD against, and the value the ship gate reads.
   * On the #164 run the recorded SHA and the branch tip were different
   * commits whose diff rewrote every file the security review had read.
   *
   * The command is EXECUTED here against a real git repository rather than
   * asserted as a substring of ship.js. Every mutation that has survived a
   * first pass in this repo was a source-text assertion, and this one has a
   * specific way to be wrong that reading it cannot catch: `--sha "$sha"`
   * depending on a shell variable an earlier prompt line set, in a step whose
   * commands each run as their own tool call.
   */
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  /** ship.js's own builder, extracted by marker and executed. */
  function recordCommitCommand(
    repoDir: string,
    harnessRoot: string,
    statePath: string,
    branch: string,
    verdicts: { quinn: string; api: string; ui: string },
  ): string {
    const start = shipSource.indexOf("// ──── RECOMMIT-RECORD-START ────");
    const end = shipSource.indexOf("// ──── RECOMMIT-RECORD-END ────");
    if (start < 0 || end < 0) throw new Error("ship.js is missing the RECOMMIT-RECORD markers");
    const fn = new Function(`${shipSource.slice(start, end)}\nreturn recordCommitCommand`)();
    return fn(repoDir, harnessRoot, statePath, branch, verdicts);
  }

  const VERDICTS = { quinn: "SKIP", api: "SKIP", ui: "SKIP" };

  /** A real repository with one commit, so `git rev-parse HEAD` has an answer. */
  function makeRepo(dir: string): string {
    const git = (...a: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        encoding: "utf-8",
      });
    spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf-8" });
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    return git("rev-parse", "HEAD").stdout.trim();
  }

  function runCommand(cmd: string) {
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf-8" });
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  }

  test("the generated command records the repository's real HEAD", () => {
    const repo = join(DIR, "repo");
    mkdirSync(repo);
    const head = makeRepo(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    const r = runCommand(recordCommitCommand(repo, REPO_ROOT, STATE, "169-deep-modules", VERDICTS));
    expect(r.code, r.err).toBe(0);

    const s = readState();
    expect(s.buildCommit, "the recommit recorded something other than the commit it made").toBe(head);
    expect(s.agents.marcus.commitSha).toBe(head);
    expect(s.agents.marcus.branch).toBe("169-deep-modules");
  });

  test("a second commit moves buildCommit", () => {
    // The whole point: recording once is indistinguishable from recording
    // every time until the branch moves twice.
    const repo = join(DIR, "repo2");
    mkdirSync(repo);
    const first = makeRepo(repo);
    const cmd = recordCommitCommand(repo, REPO_ROOT, STATE, "169-deep-modules", VERDICTS);
    expect(runCommand(cmd).code).toBe(0);
    expect(readState().buildCommit).toBe(first);

    writeFileSync(join(repo, "a.txt"), "two\n");
    spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aqm", "two"]);
    const second = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
    expect(second).not.toBe(first);

    expect(runCommand(cmd).code).toBe(0);
    expect(readState().buildCommit, "buildCommit still names the first commit of the run").toBe(second);
  });

  test("the environment verdicts travel with it", () => {
    // record-build-commit.ts REPLACES environments.local, so a recommit that
    // dropped --api would silently downgrade a PASS recorded by the commit
    // step to SKIP.
    const repo = join(DIR, "repo3");
    mkdirSync(repo);
    makeRepo(repo);
    const cmd = recordCommitCommand(repo, REPO_ROOT, STATE, "169-deep-modules", {
      quinn: "PASS",
      api: "PASS",
      ui: "SKIP",
    });
    expect(runCommand(cmd).code).toBe(0);
    const s = readState();
    expect(s.environments.local.api).toBe("PASS");
    expect(s.environments.local.ui).toBe("SKIP");
    expect(s.agents.quinn).toEqual({ spawned: true, verdict: "PASS" });
  });

  test("the command does not depend on a shell variable set by an earlier step", () => {
    // An agent runs each command in the prompt as its own tool call. A
    // `--sha "$sha"` set two lines earlier expands to nothing in a fresh
    // shell — and the recorder would refuse, loudly. The dangerous version is
    // the one where `sha` is still set from the PREVIOUS commit, which is
    // exactly the staleness #169 is about.
    const cmd = recordCommitCommand("/p", "/h", "/w/state.json", "b", VERDICTS);
    expect(cmd).toContain('--sha "$(git rev-parse HEAD)"');
    expect(cmd).not.toContain('--sha "$sha"');
    expect(cmd.startsWith("cd '/p' &&"), `the command does not cd first: ${cmd}`).toBe(true);
  });

  test("a repository the command cannot read is refused, not recorded", () => {
    // The break that proves the check: point it at a directory that is not a
    // git repository and the recorder must refuse rather than write
    // something. Run, not asserted — `git rev-parse` failing silently into an
    // empty --sha is the failure this guards.
    const notARepo = join(DIR, "empty");
    mkdirSync(notARepo);
    const before = readFileSync(STATE, "utf-8");
    const r = runCommand(recordCommitCommand(notARepo, REPO_ROOT, STATE, "b", VERDICTS));
    expect(r.code, "a non-repository was accepted as a commit").not.toBe(0);
    expect(readFileSync(STATE, "utf-8"), "the state file was written anyway").toBe(before);
  });

  test("both remediation recommits call it and require the receipt", () => {
    // The wiring half. The command above is proven to work; this is what says
    // the workflow runs it — in BOTH loops, with the receipt as a required
    // field rather than an instruction an agent can skip (#166's lesson).
    const labels = ["recommit-verify", "recommit-ship"];
    for (const label of labels) {
      const at = shipSource.indexOf(`label: '${label}'`);
      expect(at, `ship.js has no ${label} step`).toBeGreaterThan(-1);
      const start = shipSource.lastIndexOf("await agent(`", at);
      const block = shipSource.slice(start, at + 400);
      expect(block, `${label} does not record the commit it makes`).toContain(
        "recordCommitCommand(",
      );
      expect(block, `${label} does not ask for the receipt`).toContain("stateRecorded");
      const required = block.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
      expect(required, `${label} required fields were: ${required}`).toContain("stateRecorded");
    }
  });

  test("the commit step and the recommits record the same flags", () => {
    // Anti-drift: the commit step builds this command inline and the
    // recommits build it through the helper. A flag added to one and not the
    // other is how environments.local gets downgraded on a remediation round.
    const flags = (text: string) =>
      [...new Set([...text.matchAll(/--([a-z-]+)/g)].map(m => m[1]))].sort();

    const start = shipSource.indexOf("const commitResult = await agent(`");
    const from = shipSource.indexOf("record-build-commit.ts", start);
    const to = shipSource.indexOf("It prints one JSON receipt", from);
    expect(from, "the commit step no longer calls the recorder").toBeGreaterThan(-1);
    expect(to, "the commit step's recorder command no longer ends where this slicer expects")
      .toBeGreaterThan(from);

    const inline = flags(shipSource.slice(from, to));
    const helper = flags(recordCommitCommand("/p", "/h", "/w/s.json", "b", VERDICTS));
    expect(inline.length, `the slicer found no flags: ${inline.join(",")}`).toBeGreaterThan(3);
    expect(inline, "the two recorder call sites disagree on flags").toEqual(helper);
  });
});
