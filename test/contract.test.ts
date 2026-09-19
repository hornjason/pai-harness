import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const TEST_BASE = "/tmp/harness-contract-tests";
const GATES_DIR = join(import.meta.dir, "..", "gates");

function runGate(gate: string, slug: string): { pass: number; fail: number; output: string } {
  const gateRunner = join(GATES_DIR, "run-gate.ts");
  const cmd = `RUNGATE_WORK_DIR=${TEST_BASE} RUNGATE_SKIP_AGENTS=1 bun run ${gateRunner} --gate ${gate} --slug ${slug} --issue 9999 2>&1`;
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
  });

  test("ship passes", () => {
    const r = runGate("ship", "light");
    expect(r.pass).toBeGreaterThan(0);
  });
});

describe("contract: STANDARD tier", () => {
  beforeAll(() => {
    const dir = join(TEST_BASE, "standard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9998, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "standard", phase: "DONE",
      issueGoal: "Test canary standard", sizing: { predicted: "S", ceremonyTier: "STANDARD" },
      acs: [
        { id: "AC-1", type: "CODE", statement: "Fix applied to target module correctly", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "grep", command: "grep fix src/test.ts" }, evidence: { type: "command-output", content: "fix" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "All unit tests pass without regression", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" },
      ],
      sourceSpecs: [{ path: join(process.env.HOME || "", "Projects/rungate/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), citedInDiscovery: true }],
      gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
      environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" }, prod: { rebuild: "SKIP", smoke: "SKIP", quinn: "SKIP" } },
      agents: { marcus: { spawned: true, verdict: "PASS" }, quinn: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow"
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1, AC-2\n\n## AC-1\nFix applied\n\n## AC-2\nAll unit tests pass\n");
  });

  test("scope passes", () => {
    const r = runGate("scope", "standard");
    expect(r.fail).toBe(0);
  });

  test("verify passes", () => {
    const r = runGate("verify", "standard");
    expect(r.fail).toBe(0);
  });

  test("ship passes", () => {
    const r = runGate("ship", "standard");
    expect(r.fail).toBe(0);
  });
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
      sourceSpecs: [{ path: join(process.env.HOME || "", "Projects/rungate/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), citedInDiscovery: true }],
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
      sourceSpecs: [{ path: join(process.env.HOME || "", "Projects/rungate/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), citedInDiscovery: true }],
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
      sourceSpecs: [{ path: join(process.env.HOME || "", "Projects/rungate/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), citedInDiscovery: true }],
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
