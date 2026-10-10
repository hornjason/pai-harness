import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
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

function runGate(gate: string, slug: string): { pass: number; fail: number; output: string } {
  const gateRunner = join(GATES_DIR, "run-gate.ts");
  const cmd = `RUNGATE_WORK_DIR=${TEST_BASE} RUNGATE_SKIP_AGENTS=1 bun run ${gateRunner} --gate ${gate} --slug ${slug} --issue 9999 --force 2>&1`;
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 30000 });
    const passMatch = output.match(/(\d+) pass/);
    const failMatch = output.match(/(\d+) fail/);
    return { pass: passMatch ? parseInt(passMatch[1]) : 0, fail: failMatch ? parseInt(failMatch[1]) : 0, output };
  } catch (e: any) {
    const out = (e.stdout || "") + (e.stderr || "");
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    return { pass: passMatch ? parseInt(passMatch[1]) : 0, fail: failMatch ? parseInt(failMatch[1]) : 0, output: out };
  }
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
    const r = runGate("scope", "light");
    expect(r.fail).toBe(0);
    expect(r.pass).toBeGreaterThan(0);
  }, { timeout: 30_000 });

  test("ship passes", () => {
    const r = runGate("ship", "light");
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
    mkdirSync(STANDARD_PROJECT, { recursive: true });
    writeFileSync(join(STANDARD_PROJECT, "target.ts"), "export const fix = true;\n");
    writeFileSync(join(STANDARD_PROJECT, "target.test.ts"),
      'import { test, expect } from "bun:test";\ntest("canary", () => { expect(1).toBe(1); });\n');
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
    const r = runGate("scope", "standard");
    expect(r.fail).toBe(0);
  }, { timeout: 30_000 });

  test("verify passes", () => {
    const r = runGate("verify", "standard");
    expect(r.fail).toBe(0);
  }, { timeout: 30_000 });

  test("ship passes", () => {
    const r = runGate("ship", "standard");
    expect(r.fail).toBe(0);
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

    runGate("scope", "standard-broken-evidence");
    const recorded = JSON.parse(readFileSync(
      join(TEST_BASE, "standard-broken-evidence", "workflow-state.json"), "utf-8"));
    expect(recorded.evidencePrevalidation?.verdict).toBe("FAIL");
    expect(recorded.evidencePrevalidation.acs.find((a: any) => a.id === "AC-1").status).toBe("broken");

    const r = runGate("verify", "standard-broken-evidence");
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
    runGate("scope", "standard-control");
    const r = runGate("verify", "standard-control");
    expect(r.fail).toBe(0);
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
    const r = runGate("ship", "broken-env");
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
    const r = runGate("ship", "broken-grep");
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
    const r = runGate("ship", "broken-evidence");
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
