import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// The governing spec these fixtures cite, resolved from this file rather than
// from the developer's home directory (#71). It used to read
// `join(process.env.HOME, "Projects/rungate/specs/...")` — the path where Jason
// happens to keep his checkout. The gate resolves absolute paths as-is, so
// projectRoot never rescued it: on CI, HOME is /home/runner while the checkout
// is /home/runner/work/pai-harness/pai-harness, the file is not there, and
// `governing-spec-exists` fails. That single missing file produced three of the
// 28 CI failures, because gate-executor runs the scope checks inside verify and
// ship too, and ship then cascaded on verify's recorded FAIL.
const GOVERNING_SPEC = join(import.meta.dir, "..", "specs", "BOOTSTRAP-DATA-FLOW-SPEC.md");

const TEST_BASE = "/tmp/harness-contract-tests";
const GATES_DIR = join(import.meta.dir, "..", "gates");

/**
 * Run one gate against a fixture, through the same CLI ship.js uses.
 *
 * `--tree-under-test` is passed rather than written into the fixture by hand
 * (#314). ship.js supplies it on the command line and `run-gate.ts` persists
 * it into the state file before any check reads it, so planting the field
 * directly would leave that plumbing — the half of #314 that lives in the
 * runner rather than in the checks — unexercised by the contract test that is
 * supposed to be the gate's own proof.
 *
 * The gate runs with NO GitHub token, which is the same environment CI gives
 * it (#405). The fixture's `issueRepo` is `test/repo`; before #405 the
 * resulting 404 was swallowed by a `catch { return }`, so the fixture did not
 * satisfy `prove-label-enforcement`, it was merely unreadable by it — exactly
 * as it had been unreadable by `code-pushed` until it was made a real pushed
 * repository (#174). With the fail-open gone, a token in the environment
 * turns that 404 into a refusal, so the contract would pass in CI and fail on
 * a developer's machine. A contract whose verdict depends on who runs it is
 * worse than either verdict, so the difference is removed rather than the
 * failure: the token is cleared here, so both environments agree and the
 * check reports `UNMEASURED`.
 *
 * That the report is actually EMITTED — rather than the check having quietly
 * returned, which is the #405 defect — is asserted where it can be observed,
 * by spawning this check against planted state in
 * `test/prove-label-gate.test.ts`. `run-gate.ts` prints a batch summary and
 * records detail only for failures, so a passing check's stderr does not
 * reach this function's `output` and asserting on it here would be a string
 * match against text that was never in the buffer.
 */
const NO_TOKEN = { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" };

interface GateRun {
  pass: number;
  fail: number;
  output: string;
  /**
   * Whether the output carried a summary at all.
   *
   * `failMatch ? parse : 0` read a gate that never reported as a gate with
   * zero failures, so `expect(r.fail).toBe(0)` was GREEN over a run that
   * timed out, was killed, or died before printing — which is the fail-open
   * `.claude/rules/checks-must-be-able-to-fail.md` is about, in the contract
   * test that is supposed to be the gate's own proof. A reading with no
   * summary behind it is not a verdict, and `expectGateGreen` refuses it.
   */
  measured: boolean;
}

function readGateOutput(output: string): GateRun {
  const passMatch = output.match(/(\d+) pass/);
  const failMatch = output.match(/(\d+) fail/);
  return {
    pass: passMatch ? parseInt(passMatch[1]) : 0,
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    output,
    measured: passMatch !== null && failMatch !== null,
  };
}

function runGate(gate: string, slug: string, treeUnderTest: string): GateRun {
  const gateRunner = join(GATES_DIR, "run-gate.ts");
  const cmd = `RUNGATE_WORK_DIR=${TEST_BASE} RUNGATE_SKIP_AGENTS=1 bun run ${gateRunner} --gate ${gate} --slug ${slug} --issue 9999 --tree-under-test ${treeUnderTest} --force 2>&1`;
  try {
    return readGateOutput(execSync(cmd, { encoding: "utf-8", timeout: 30000, env: NO_TOKEN }));
  } catch (e: any) {
    return readGateOutput((e.stdout || "") + (e.stderr || ""));
  }
}

describe("#654-adjacent: a gate that never reported is not a gate that passed", () => {
  // These two are the whole reason `measured` exists, and they are cases
  // rather than a comment because the branch is otherwise unreachable: no
  // fixture in this file makes the runner die, and a branch no test can
  // enter is what `.claude/rules/checks-must-be-able-to-fail.md` is about.
  test("output with no summary reads as UNMEASURED, not as zero failures", () => {
    const killed = readGateOutput("bun run gates/run-gate.ts\n");
    expect(killed.measured).toBe(false);
    // The pre-existing reading. `fail` is 0 here and always was — which is
    // exactly why `fail` alone could not be the thing asserted on.
    expect(killed.fail).toBe(0);
    expect(() => expectGateGreen(killed, "a killed runner")).toThrow(/did not report a verdict/);
  });

  test("a real summary is measured, and a failing one carries the gate's own output", () => {
    const red = readGateOutput("running checks\ngoverning-spec-exists FAILED\n 12 pass\n 1 fail\n");
    expect(red.measured).toBe(true);
    expect(red.fail).toBe(1);
    // The information the three CI reds could not produce: which check.
    expect(() => expectGateGreen(red, "a failing gate")).toThrow(/governing-spec-exists/);
  });
});

/**
 * The gate ran and found nothing wrong — and say what it found when it did.
 *
 * `expect(r.fail).toBe(0)` with no message produces `Expected: 0 / Received:
 * 1` and nothing else. These cases spawn a gate runner that prints the names
 * of every check it failed, and that output was thrown away at exactly the
 * moment somebody needed it: three of these cases went red in CI on two
 * unrelated branches and the logs could not say which check failed, because
 * the assertion did not carry it.
 *
 * The tail rather than the head: `run-gate.ts` prints its batch diagnosis
 * last, so the end of the buffer is where the check names are.
 */
function expectGateGreen(r: GateRun, what: string): void {
  expect(r.measured, `${what}: the gate printed no pass/fail summary — it did not report a verdict, ` +
    `which is not the same as reporting a clean one. Output:\n${r.output.slice(-3000)}`).toBe(true);
  expect(r.fail, `${what}: the gate failed ${r.fail} check(s). Output:\n${r.output.slice(-3000)}`).toBe(0);
}

// Bun ignores a describe-level `timeout` option, so the 30s budget lives on each
// test inside the block (the third argument, which is the position bun-types models).
describe("contract: LIGHT tier", () => {
  beforeAll(() => {
    const dir = join(TEST_BASE, "light");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9999, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "light", phase: "DONE",
      issueGoal: "Test canary", sizing: { predicted: "XS", ceremonyTier: "LIGHT" },
      acs: [{ id: "AC-1", type: "CODE", statement: "Unit tests pass including canary test suite",
        threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" },
        evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] } },
      environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
      agents: { marcus: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1\n\n## AC-1\nUnit tests pass\n");
  });

  test("scope passes", () => {
    const r = runGate("scope", "light", "/tmp/test");
    expectGateGreen(r, "LIGHT scope");
    expect(r.pass).toBeGreaterThan(0);
  }, { timeout: 30_000 });

  test("ship passes", () => {
    const r = runGate("ship", "light", "/tmp/test");
    expect(r.pass).toBeGreaterThan(0);
  }, { timeout: 30_000 });
});

/**
 * A project root the fixture's evidence commands can actually run in (#235).
 *
 * This used to be `/tmp/test`, with `grep fix src/test.ts` and `bun test` as
 * the two evidence commands. Neither has ever been runnable there: the
 * directory holds no checkout and `src/` does not exist in this repo at all.
 * The gate passed because nothing executed them — the exact shape
 * .claude/rules/checks-must-be-able-to-fail.md is about, sitting inside the
 * contract test that is supposed to be the gate's own proof.
 *
 * #235 wired evidence pre-validation into the gate, which ran the commands and
 * refused. That refusal was correct and this fixture was wrong, so the fixture
 * now builds a real directory and cites commands that genuinely succeed in it.
 */
const STANDARD_PROJECT = join(TEST_BASE, "standard-project");
const STANDARD_BRIEF = "# Marcus Brief\n\n## Context\nProject root: /tmp/test\n\n## Task\nFix the module\n\n## AC-1\nFix applied to target module correctly\n\n## AC-2\nAll unit tests pass without regression\n\n## Verify\nbun test\n\n## Report back\nReport results\n";

/**
 * The fixture tree before the work, and after it.
 *
 * An evidence baseline is a reading of the tree the work has NOT yet been done
 * to (#669). This fixture modelled a finished run at every phase — one static
 * `target.ts` already carrying the fix — so `grep fix target.ts` against a
 * threshold of `contains "fix"` was satisfied at SCOPE, before anything had
 * been implemented, and `evidence-prevalidation` refused the whole STANDARD
 * contract. It was right to. An AC whose command passes on the pre-change tree
 * is a gate that was green before the work existed, which is the defect #669
 * exists to name.
 *
 * Note this was never specific to AC-1: a fixture that runs scope against the
 * finished tree makes EVERY passing AC already-satisfied, so the honest repair
 * is to give the two phases the two trees rather than to find a cleverer
 * command. The cheapest wrong fix — letting the refusal skip readings with no
 * baselines, or excusing an already-satisfied one — turns this file green and
 * makes the check a no-op on every project that has not opted in.
 */
const PRE_FIX_TREE = "export const placeholder = true;\n";
const POST_FIX_TREE = "export const fix = true;\n";

/**
 * Put the fixture repo at one of the two trees, committed and pushed.
 *
 * Committed and pushed because the gate contains `code-committed` and
 * `code-pushed` (#174): a working tree left dirty by this helper would turn
 * those red and the failure would be attributed to whatever the test was
 * actually about.
 */
function setFixtureTree(content: string): void {
  writeFileSync(join(STANDARD_PROJECT, "target.ts"), content);
  const g = (args: string) =>
    execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd: STANDARD_PROJECT, stdio: "ignore" });
  g("add -A");
  // Re-applying the tree it already has is a no-op commit, which git refuses.
  try { g('commit -m "fixture tree"'); } catch { /* already at this tree */ }
  g("push mirror main");
}

/**
 * Drive scope against the pre-change tree and verify against the post-change
 * one, which is the order a real run has them in.
 *
 * Both halves have to be driven and they have to see different trees. Scope
 * alone is green on a broken command — it writes the verdict and advances —
 * and a scope taken against the finished tree records a baseline that already
 * clears its own bar, so the record it leaves for verify is meaningless in a
 * way no count of passing checks reveals.
 */
function scopeThenVerify(slug: string): { verify: ReturnType<typeof runGate> } {
  setFixtureTree(PRE_FIX_TREE);
  runGate("scope", slug, STANDARD_PROJECT);
  setFixtureTree(POST_FIX_TREE);
  return { verify: runGate("verify", slug, STANDARD_PROJECT) };
}

/**
 * The STANDARD state as a fresh literal, so the broken-evidence case below can
 * differ from the passing one by exactly one command.
 *
 * It is rebuilt rather than read back from the passing fixture's file on disk:
 * running a gate writes `gates.scope.acHash` into that file, and a copy that
 * carried the hash of the *unmutated* ACs would fail on `acHash-consistency`
 * instead of on the evidence command — red for a reason that has nothing to do
 * with what the test claims to be checking.
 */
function standardState(slug: string, overrides: (s: any) => void = () => {}) {
  const state: any = {
    schemaVersion: 2, issue: 9998, repo: "test/repo", issueRepo: "test/repo",
    projectRoot: STANDARD_PROJECT, slug, phase: "DONE",
    issueGoal: "Test canary standard", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
    acs: [
      { id: "AC-1", type: "CODE", statement: "Fix applied to target module correctly", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "COMMAND", command: "grep fix target.ts" }, specElement: "target module fix", evidence: { type: "command-output", content: "fix" }, verdict: "PASS" },
      { id: "AC-2", type: "CODE", statement: "All unit tests pass without regression", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test target.test.ts" }, specElement: "test regression", evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" },
    ],
    sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
    gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
    environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" }, prod: { rebuild: "SKIP", smoke: "SKIP", quinn: "SKIP" } },
    agents: { marcus: { spawned: true, verdict: "PASS" }, quinn: { spawned: true, verdict: "PASS" } },
    buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow",
  };
  overrides(state);
  return state;
}

/** Write a STANDARD-shaped run directory and return its path. */
function writeStandardFixture(slug: string, overrides?: (s: any) => void): string {
  const dir = join(TEST_BASE, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(standardState(slug, overrides), null, 2));
  writeFileSync(join(dir, "marcus-brief.md"), STANDARD_BRIEF);
  return dir;
}

describe("contract: STANDARD tier", () => {
  beforeAll(() => {
    const dir = join(TEST_BASE, "standard");
    mkdirSync(dir, { recursive: true });
    rmSync(STANDARD_PROJECT, { recursive: true, force: true });
    mkdirSync(STANDARD_PROJECT, { recursive: true });
    // The tree as it stands BEFORE the work, because `scope passes` below is
    // the next thing to run and scope's job is to read the pre-change tree
    // (#669). `verify passes` applies the change first.
    writeFileSync(join(STANDARD_PROJECT, "target.ts"), PRE_FIX_TREE);
    writeFileSync(join(STANDARD_PROJECT, "target.test.ts"),
      'import { test, expect } from "bun:test";\ntest("canary", () => { expect(1).toBe(1); });\n');

    // The fixture is a real repository on a branch with an upstream, because
    // the gate it is asserted to pass contains `code-pushed: no unpushed
    // commits` (#174).
    //
    // It was a bare directory until now, and that is why this contract was
    // green: `git rev-list --count @{upstream}..HEAD` failed, and the check
    // read the failure as nothing-to-report. The fixture did not satisfy
    // `code-pushed`; it was merely unreadable by it. A contract test asserting
    // a well-formed project passes the ship gate has to MODEL a well-formed
    // project, and a shipped project is pushed.
    //
    // `-c user.*` because CI has no global git identity, and a commit that
    // cannot be authored would put the fixture straight back to unreadable.
    const g = (args: string) =>
      execSync(`git -c user.email=t@t -c user.name=t ${args}`, { cwd: STANDARD_PROJECT, stdio: "ignore" });
    // #414: `origin` carries the project's IDENTITY and `mirror` carries the
    // push. They were one remote until now, pointing at a local bare path,
    // and that is the #174 defect in this same fixture repeating itself one
    // check along: `repoSlug` cannot read `/tmp/.../standard-remote.git` as
    // owner/name, so `worktree-repo` was unreadable rather than satisfied.
    //
    // A real project's origin IS its push target, and a fixture cannot reach
    // GitHub — so the two are split rather than the parser widened. Widening
    // it to accept a local path would buy this test green by making the check
    // blind to the string it exists to read.
    const remote = join(TEST_BASE, "standard-remote.git");
    rmSync(remote, { recursive: true, force: true });
    execSync(`git init --bare -b main ${remote}`, { stdio: "ignore" });
    g("init -b main");
    g("add -A");
    g('commit -m "fixture"');
    g("remote add origin https://github.com/test/repo.git");
    g(`remote add mirror ${remote}`);
    g("push -u mirror main");
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9998, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: STANDARD_PROJECT, slug: "standard", phase: "DONE",
      issueGoal: "Test canary standard", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
      acs: [
        { id: "AC-1", type: "CODE", statement: "Fix applied to target module correctly", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "COMMAND", command: "grep fix target.ts" }, specElement: "target module fix", evidence: { type: "command-output", content: "fix" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "All unit tests pass without regression", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test target.test.ts" }, specElement: "test regression", evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" },
      ],
      sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
      environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" }, prod: { rebuild: "SKIP", smoke: "SKIP", quinn: "SKIP" } },
      agents: { marcus: { spawned: true, verdict: "PASS" }, quinn: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\n## Context\nProject root: /tmp/test\n\n## Task\nFix the module\n\n## AC-1\nFix applied to target module correctly\n\n## AC-2\nAll unit tests pass without regression\n\n## Verify\nbun test\n\n## Report back\nReport results\n");
  });

  test("scope passes", () => {
    const r = runGate("scope", "standard", STANDARD_PROJECT);
    expectGateGreen(r, "STANDARD scope");
  }, { timeout: 30_000 });

  test("verify passes", () => {
    // The work lands between scope and verify, so the tree verify reads is not
    // the tree scope measured (#669).
    setFixtureTree(POST_FIX_TREE);
    const r = runGate("verify", "standard", STANDARD_PROJECT);
    expectGateGreen(r, "STANDARD verify");
  }, { timeout: 30_000 });

  test("ship passes", () => {
    const r = runGate("ship", "standard", STANDARD_PROJECT);
    expectGateGreen(r, "STANDARD ship");
  }, { timeout: 30_000 });


  /**
   * The flag has to be load-bearing (#314). Every case above passes it, so on
   * their own they are equally satisfied by a runner that ignores it and by
   * one that threads it through — and "ignores it" is precisely the state the
   * gate was in before #314, when it measured projectRoot and passed anyway.
   *
   * Same fixture, same gate, one argument removed. A green run here would mean
   * the checks fell back to the config root, which is the defect.
   */
  test("the same gate refuses as UNMEASURED when --tree-under-test is omitted", () => {
    const gateRunner = join(GATES_DIR, "run-gate.ts");
    const cmd = `RUNGATE_WORK_DIR=${TEST_BASE} RUNGATE_SKIP_AGENTS=1 bun run ${gateRunner} --gate verify --slug standard --issue 9999 --force 2>&1`;
    let output = "";
    try {
      output = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
    } catch (e: any) {
      output = (e.stdout || "") + (e.stderr || "");
    }
    expect(parseInt(output.match(/(\d+) fail/)?.[1] ?? "0")).toBeGreaterThan(0);
    // Named, not merely counted. The gate's batch diagnosis prints check names
    // rather than their detail, and "some number of checks failed" would be
    // satisfied by a fixture that had gone stale for an unrelated reason.
    // These are the verify-phase members of the migrated set.
    for (const check of ["tsc-pass", "governing-spec-exists", "harness-port-validation"]) {
      expect(output, `${check} did not refuse without a tree under test`).toContain(check);
    }
  }, { timeout: 30_000 });

  /**
   * Repairing the fixture above is only half the job. Commands that run are
   * now the precondition for green, so without this the repair would have
   * restored a gate that passes because nothing looks — which is what the
   * fixture was doing before #235 and is the thing being fixed.
   */
  /**
   * Scope records the pre-validation; verify refuses on what scope recorded.
   *
   * Both halves have to be driven, in that order. Scope alone is green on a
   * broken command — it writes the verdict and advances — and verify alone, on
   * a slug that never ran scope, is red because the record is *absent*, which
   * is a different defect wearing the same refusal text. Running one gate
   * would have passed either way for the wrong reason.
   */
  test("an unrunnable evidence command is recorded at scope and refused at verify", () => {
    // One field of difference from the control below: the file the evidence
    // greps does not exist. Everything else is identical, so the refusal is
    // attributable to the command and nothing else.
    writeStandardFixture("standard-broken-evidence", (s) => {
      s.acs[0].evidenceMethod.command = "grep fix no-such-file.ts";
    });

    // Scope reads the pre-change tree; the previous case left the post-change
    // one in place, and a scope taken against that would record AC-1 as
    // already-satisfied — a second, unrelated reason for the same refusal,
    // which would make the status assertion below the only thing separating
    // this from a false confirmation.
    setFixtureTree(PRE_FIX_TREE);
    runGate("scope", "standard-broken-evidence", STANDARD_PROJECT);
    const recorded = JSON.parse(readFileSync(
      join(TEST_BASE, "standard-broken-evidence", "workflow-state.json"), "utf-8"));
    expect(recorded.evidencePrevalidation?.verdict).toBe("FAIL");
    expect(recorded.evidencePrevalidation.acs.find((a: any) => a.id === "AC-1").status).toBe("broken");
    // The refusal is attributable to the unrunnable command and nothing else.
    expect(recorded.evidencePrevalidation.alreadySatisfied ?? []).toEqual([]);

    setFixtureTree(POST_FIX_TREE);
    const r = runGate("verify", "standard-broken-evidence", STANDARD_PROJECT);
    expect(r.fail).toBeGreaterThan(0);
    expect(r.output).toContain("evidence-prevalidation");
  }, { timeout: 60_000 });

  test("the same fixture without that change passes — the control", () => {
    // Without this, the test above could be red because `writeStandardFixture`
    // builds a state the gate rejects for some unrelated reason, and the
    // refusal-text assertion would be the only thing standing between that and
    // a false confirmation. It has already earned its place once: the first
    // version of both tests drove verify without scope and this went red,
    // which is how the record-then-read split above was found.
    writeStandardFixture("standard-control");
    const { verify: r } = scopeThenVerify("standard-control");
    expectGateGreen(r, "the broken-evidence control");
  }, { timeout: 60_000 });
});

describe("contract: negative cases", () => {
  test("missing environments fails ship", () => {
    const dir = join(TEST_BASE, "broken-env");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9997, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "broken-env", phase: "DONE",
      issueGoal: "Broken env test", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
      acs: [{ id: "AC-1", type: "CODE", statement: "Fix applied correctly to module", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" }],
      sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
      environments: {},
      agents: { marcus: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1\n\n## AC-1\nFix applied\n");
    const r = runGate("ship", "broken-env", "/tmp/test");
    expect(r.fail).toBeGreaterThan(0);
  });

  test("all-grep evidence fails ratio check", () => {
    const dir = join(TEST_BASE, "broken-grep");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9996, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "broken-grep", phase: "DONE",
      issueGoal: "Broken grep test", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
      acs: [
        { id: "AC-1", type: "CODE", statement: "First check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "Second check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-3", type: "CODE", statement: "Third check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-4", type: "CODE", statement: "Fourth check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
      ],
      sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
      environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
      agents: { marcus: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1, AC-2, AC-3, AC-4\n\n## AC-1\nFirst check\n\n## AC-2\nSecond check\n\n## AC-3\nThird check\n\n## AC-4\nFourth check\n");
    const r = runGate("ship", "broken-grep", "/tmp/test");
    expect(r.output).toContain("evidence-type-ratio");
  });

  test("missing AC evidence fails at ship", () => {
    const dir = join(TEST_BASE, "broken-evidence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9995, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "broken-evidence", phase: "DONE",
      issueGoal: "Broken evidence test", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
      acs: [
        { id: "AC-1", type: "CODE", statement: "Has evidence from test run output", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "Missing evidence for grep verification", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, verdict: "PENDING" },
      ],
      sourceSpecs: [{ path: GOVERNING_SPEC, citedInDiscovery: true }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
      environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
      agents: { marcus: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1, AC-2\n\n## AC-1\nHas evidence\n\n## AC-2\nMissing evidence\n");
    const r = runGate("ship", "broken-evidence", "/tmp/test");
    expect(r.output).toContain("all-acs-have-evidence");
  });
});

describe("contract: M-size decomposition via to-issues", () => {
  test("ship.js invokes to-issues for M-size with 3+ filesToModify", () => {
    const { readFileSync } = require("fs");
    const shipContent = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
    // AC-1: M-size detection triggers to-issues decomposition
    expect(shipContent).toContain("to-issues");
    expect(shipContent).toContain("discovery.sizing === 'M'");
    expect(shipContent).toContain("filesToModify");
  });

  test("decomposition produces 2-4 XS/S sub-issues with <=5 ACs and independent files", () => {
    const { readFileSync } = require("fs");
    const shipContent = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
    // AC-2: Sub-issue constraints enforced in schema and prompt
    expect(shipContent).toContain("M_DECOMPOSITION_SCHEMA");
    expect(shipContent).toMatch(/minItems.*2|"minItems":\s*2/);
    expect(shipContent).toMatch(/maxItems.*4|"maxItems":\s*4/);
    expect(shipContent).toContain("XS");
    // <=5 ACs constraint
    expect(shipContent).toMatch(/maxItems.*5|no more than 5 ACs|at most 5 ACs|5 ACs max|max.*5.*ACs/i);
    // Independent files constraint
    expect(shipContent).toMatch(/independent.*filesToModify|non-overlapping.*files|no file overlap/i);
  });

  test("sub-issues dispatch sequentially or via batch-ship", () => {
    const { readFileSync } = require("fs");
    const shipContent = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
    // AC-3: Sequential ship or batch-ship dispatch
    expect(shipContent).toMatch(/batch-ship|runDecomposedShip|sub-issue.*ship|subIssues.*forEach|for.*subIssue/i);
    // Must reference the ship pipeline for each sub-issue
    expect(shipContent).toContain("subIssues");
  });

  test("old AC-batching patterns removed", () => {
    const { readFileSync } = require("fs");
    const shipContent = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");
    // AC-4: Old patterns should be gone
    expect(shipContent).not.toContain("AC_GROUPING_SCHEMA");
    expect(shipContent).not.toContain("runBatchedImplement");
    expect(shipContent).not.toContain("acBatches");
  });
});
