import { test, expect, describe } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const TEST_BASE = "/tmp/harness-contract-neg";
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

function makeNegFixture(slug: string, state: any): void {
  const dir = join(TEST_BASE, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2));
  if (state.agents?.marcus?.spawned) {
    const acIds = (state.acs || []).map((ac: any) => ac.id).join(", ");
    writeFileSync(join(dir, "marcus-brief.md"), `# Marcus Brief\n\nCovers: ${acIds}\n\n${(state.acs || []).map((ac: any) => `## ${ac.id}\n${ac.statement}`).join("\n\n")}\n`);
  }
}

const BASE = {
  schemaVersion: 2, repo: "test/repo", issueRepo: "test/repo",
  projectRoot: "/tmp/test", phase: "DONE",
  sizing: { predicted: "S", ceremonyTier: "STANDARD" },
  sourceSpecs: [{ path: join(process.env.HOME || "", "Projects/rungate/specs/BOOTSTRAP-DATA-FLOW-SPEC.md"), citedInDiscovery: true }],
  gates: { scope: { result: "PASS", attempt: 1, failures: [] }, verify: { result: "PASS", attempt: 1, failures: [] } },
  environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
  agents: { marcus: { spawned: true, verdict: "PASS" } },
  buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow",
};

describe("contract: negative — missing environments fails ship", () => {
  test("fails", () => {
    makeNegFixture("broken-env", {
      ...BASE, issue: 9997, slug: "broken-env", issueGoal: "Broken env test",
      acs: [{ id: "AC-1", type: "CODE", statement: "Fix applied correctly to module", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" }],
      environments: {},
    });
    const r = runGate("ship", "broken-env");
    expect(r.fail).toBeGreaterThan(0);
  });
});

describe("contract: negative — all-grep evidence fails ratio", () => {
  test("fails", () => {
    makeNegFixture("broken-grep", {
      ...BASE, issue: 9996, slug: "broken-grep", issueGoal: "Broken grep test",
      acs: [
        { id: "AC-1", type: "CODE", statement: "First check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "Second check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-3", type: "CODE", statement: "Third check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
        { id: "AC-4", type: "CODE", statement: "Fourth check passes via grep only", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "10" }, verdict: "PASS" },
      ],
    });
    const r = runGate("ship", "broken-grep");
    expect(r.output).toContain("evidence-type-ratio");
  });
});

describe("contract: negative — missing AC evidence fails ship", () => {
  test("fails", () => {
    makeNegFixture("broken-evidence", {
      ...BASE, issue: 9995, slug: "broken-evidence", issueGoal: "Broken evidence test",
      acs: [
        { id: "AC-1", type: "CODE", statement: "Has evidence from test run output", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS" },
        { id: "AC-2", type: "CODE", statement: "Missing evidence for grep verification", threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "grep", command: "grep x y" }, verdict: "PENDING" },
      ],
    });
    const r = runGate("ship", "broken-evidence");
    expect(r.output).toContain("all-acs-have-evidence");
  });
});
