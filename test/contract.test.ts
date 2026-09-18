import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const TEST_BASE = "/tmp/harness-contract-tests";
const PROJECT_ROOT = join(process.env.HOME || "", "Projects/DailyBriefDashboard");
const GATES_DIR = join(import.meta.dir, "..", "gates");

function makeFixture(name: string, state: any): string {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2));
  return dir;
}

function runGate(gate: string, fixtureDir: string): { pass: number; fail: number; output: string } {
  try { execSync("pkill -f 'bun test.*workflow.test' 2>/dev/null || true", { timeout: 3000 }); } catch {}
  const env = `TEST_WORK_DIR=${fixtureDir} GATE=${gate} PROJECT_ROOT=${PROJECT_ROOT}`;
  const cmd = `${env} bun test ${GATES_DIR}/workflow.test.ts --test-name-pattern "${gate}" 2>&1`;
  try {
    const output = execSync(cmd, { cwd: GATES_DIR, timeout: 15000, encoding: "utf-8" });
    const passMatch = output.match(/(\d+) pass/);
    const failMatch = output.match(/(\d+) fail/);
    return {
      pass: passMatch ? parseInt(passMatch[1]) : 0,
      fail: failMatch ? parseInt(failMatch[1]) : 0,
      output,
    };
  } catch (e: any) {
    const out = (e.stdout || "") + (e.stderr || "");
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    return {
      pass: passMatch ? parseInt(passMatch[1]) : 0,
      fail: failMatch ? parseInt(failMatch[1]) : 0,
      output: out,
    };
  }
}

beforeAll(() => {
  if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true });
  mkdirSync(TEST_BASE, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true });
});

const VALID_LIGHT = {
  schemaVersion: 2,
  issue: 9999,
  repo: "hornjason/asaCommandCenter",
  issueRepo: "hornjason/asaCommandCenter",
  projectRoot: PROJECT_ROOT,
  slug: "test-valid-light",
  phase: "DONE",
  issueGoal: "Test canary — valid LIGHT tier",
  sizing: { predicted: "XS", ceremonyTier: "LIGHT" },
  acs: [
    {
      id: "AC-1", type: "CODE",
      statement: "Unit tests pass including canary",
      threshold: { op: ">=", value: 1 },
      evidenceMethod: { type: "BUN_TEST", command: "bun test test/unit/persona-selector.test.ts" },
      evidence: { type: "command-output", content: "24 pass" },
      verdict: "PASS",
    },
  ],
  gates: {
    scope: { result: "PASS", attempt: 1, failures: [] },
    verify: { result: "PASS", attempt: 1, failures: [] },
  },
  environments: {
    local: { api: "200", ui: "200", tests: "24 pass, 0 fail" },
  },
  agents: { marcus: { spawned: true, verdict: "PASS" } },
  buildCommit: "abc1234",
  changelog: [],
  bootstrappedFrom: "ship-workflow",
};

const VALID_STANDARD = {
  ...VALID_LIGHT,
  issue: 9998,
  slug: "test-valid-standard",
  sizing: { predicted: "S", ceremonyTier: "STANDARD" },
  acs: [
    { id: "AC-1", type: "CODE", statement: "Fix applied", threshold: { op: "contains", value: "fix" }, evidenceMethod: { type: "grep", command: "grep fix src/test.ts" }, evidence: { type: "command-output", content: "fix" }, verdict: "PASS" },
    { id: "AC-2", type: "CODE", statement: "Tests pass", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "BUN_TEST", command: "bun test test/unit/test.ts" }, evidence: { type: "command-output", content: "1 pass" }, verdict: "PASS" },
  ],
  environments: {
    local: { api: "200", ui: "200", tests: "24 pass, 0 fail" },
    prod: { rebuild: "SKIP", smoke: "SKIP", quinn: "SKIP" },
  },
  agents: { marcus: { spawned: true, verdict: "PASS" }, quinn: { spawned: true, verdict: "PASS" } },
};

const BROKEN_NO_ENV = {
  ...VALID_STANDARD,
  issue: 9997,
  slug: "test-broken-env",
  environments: {},
};

const BROKEN_ALL_GREP = {
  ...VALID_STANDARD,
  issue: 9996,
  slug: "test-broken-grep",
  acs: [
    { id: "AC-1", type: "CODE", statement: "A", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "1" }, verdict: "PASS" },
    { id: "AC-2", type: "CODE", statement: "B", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "1" }, verdict: "PASS" },
    { id: "AC-3", type: "CODE", statement: "C", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "1" }, verdict: "PASS" },
    { id: "AC-4", type: "CODE", statement: "D", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "grep", command: "grep x y" }, evidence: { type: "command-output", content: "1" }, verdict: "PASS" },
  ],
};

const BROKEN_NO_EVIDENCE = {
  ...VALID_STANDARD,
  issue: 9995,
  slug: "test-broken-evidence",
  acs: [
    { id: "AC-1", type: "CODE", statement: "Has evidence", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" }, evidence: { type: "command-output", content: "pass" }, verdict: "PASS" },
    { id: "AC-2", type: "CODE", statement: "Missing evidence", threshold: { op: ">=", value: 1 }, evidenceMethod: { type: "grep", command: "grep x y" }, verdict: "PENDING" },
  ],
};

describe("contract: valid LIGHT passes all gates", () => {
  const dir = makeFixture("valid-light", VALID_LIGHT);

  test("scope gate passes", () => {
    const r = runGate("scope", dir);
    expect(r.fail).toBe(0);
    expect(r.pass).toBeGreaterThan(0);
  });

  test("ship gate passes", () => {
    const r = runGate("ship", dir);
    expect(r.fail).toBe(0);
  });
});

describe("contract: valid STANDARD passes all gates", () => {
  const dir = makeFixture("valid-standard", VALID_STANDARD);

  test("scope gate passes", () => {
    const r = runGate("scope", dir);
    expect(r.fail).toBe(0);
  });

  test("verify gate passes", () => {
    const r = runGate("verify", dir);
    expect(r.fail).toBe(0);
  });

  test("ship gate passes", () => {
    const r = runGate("ship", dir);
    expect(r.fail).toBe(0);
  });
});

describe("contract: missing environments fails ship gate", () => {
  test("ship gate catches missing environments", () => {
    const dir = makeFixture("broken-env", BROKEN_NO_ENV);
    const r = runGate("ship", dir);
    const hasEnvCheck = r.output.includes("local-api-validated") || r.output.includes("local-ui-validated") || r.output.includes("tests-pass");
    expect(hasEnvCheck).toBe(true);
  });
});

describe("contract: all-grep evidence fails ratio check", () => {
  test("ship gate catches evidence-type-ratio", () => {
    const dir = makeFixture("broken-grep", BROKEN_ALL_GREP);
    const r = runGate("ship", dir);
    expect(r.output).toContain("evidence-type-ratio");
  });
});

describe("contract: missing AC evidence fails at ship", () => {
  test("ship gate catches missing evidence", () => {
    const dir = makeFixture("broken-evidence", BROKEN_NO_EVIDENCE);
    const r = runGate("ship", dir);
    expect(r.output).toContain("all-acs-have-evidence");
  });
});
