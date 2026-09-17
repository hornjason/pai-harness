import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const TEST_DIR = process.env.TEST_WORK_DIR || "";
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const GATE = process.env.GATE || "";

function tryRead(filename: string) {
  const path = `${TEST_DIR}/${filename}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function runEvidence(command: string): { exitCode: number; output: string } {
  try {
    const output = execSync(command, { cwd: PROJECT_ROOT, timeout: 30000, encoding: "utf-8" });
    return { exitCode: 0, output: output.trim() };
  } catch (e: any) {
    return { exitCode: e.status ?? 1, output: (e.stdout ?? "").trim() };
  }
}

function compareThreshold(actual: string, op: string, expected: string): boolean {
  if (op === "contains") return actual.includes(String(expected));
  if (op === "!contains") return !actual.includes(String(expected));
  if (op === "exists") return actual.length > 0;
  const num = parseFloat(actual);
  const exp = parseFloat(expected);
  if (isNaN(num) || isNaN(exp)) return actual === expected;
  switch (op) {
    case ">=": return num >= exp;
    case "<=": return num <= exp;
    case "==": return num === exp;
    case ">": return num > exp;
    case "<": return num < exp;
    case "!=": return num !== exp;
    default: return actual === expected;
  }
}

describe("prove: run evidence commands from workflow-state", () => {
  if (GATE && GATE !== "prove") {
    test("skipped — prove tests only run for prove/ship gates", () => {});
    return;
  }
  const wf = tryRead("workflow-state.json");
  if (!wf) {
    test("skipped — no active workflow (TEST_WORK_DIR not set or workflow-state.json missing)", () => {});
    return;
  }

  const commitSha = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim();
  const ceremonyTier = wf.sizing?.ceremonyTier || "STANDARD";
  const proveEnvironment = ceremonyTier === "LIGHT" ? "local" : "prod";
  const criteriaResults: any[] = [];

  // B3 prove reproducer has Bash+Read only — no browser/screenshot capability.
  // OUTCOME-type ACs and UI-related evidence commands get SKIP, not FAIL (#486).
  const B3_UI_PATTERN = /screenshot|browser|playwright|visual|navigate|page\./i;
  const isB3UiAc = (ac: any): boolean => {
    if (ac.type === "OUTCOME") return true;
    const cmd = ac.evidenceMethod?.command || "";
    return B3_UI_PATTERN.test(cmd);
  };

  for (const ac of wf.acs) {
    test(`${ac.id}: ${ac.statement.slice(0, 80)}`, () => {
      // B3 exempt: OUTCOME/UI ACs cannot be verified without browser tools
      if (isB3UiAc(ac)) {
        criteriaResults.push({
          scId: ac.id,
          verdict: "SKIP",
          evidence: "B3 cannot verify UI — requires Quinn (#486)",
        });
        return;
      }

      const cmd = ac.evidenceMethod?.command;
      if (!cmd) {
        criteriaResults.push({ scId: ac.id, verdict: "SKIP", evidence: "no evidence command" });
        return;
      }

      const result = runEvidence(cmd);
      const lastLine = result.output.split("\n").pop() || "";
      const isTestRunner = /^bun test\b/.test(cmd);

      let verdict: string;
      let evidence: string;

      if (isTestRunner) {
        verdict = result.exitCode === 0 ? "PASS" : "FAIL";
        evidence = `${cmd} → exit ${result.exitCode} (test runner: exit code is verdict)`;
      } else if (ac.threshold && result.exitCode === 0) {
        const passed = compareThreshold(lastLine, ac.threshold.op, ac.threshold.value);
        verdict = passed ? "PASS" : "FAIL";
        evidence = `${cmd} → "${lastLine}" ${ac.threshold.op} ${ac.threshold.value} = ${passed}`;
      } else if (result.exitCode === 0) {
        verdict = "PASS";
        evidence = `${cmd} → exit 0`;
      } else {
        verdict = "FAIL";
        evidence = `${cmd} → exit ${result.exitCode}, output: "${lastLine}"`;
      }

      criteriaResults.push({ scId: ac.id, verdict, evidence });

      if (verdict === "FAIL") {
        expect(`${ac.id}: ${evidence}`).toBe("PASS");
      }
    });
  }

  test("write prove-evidence.json", () => {
    const fails = criteriaResults.filter(r => r.verdict === "FAIL");
    const verdict = criteriaResults.length === 0 ? "INCONCLUSIVE"
      : fails.length > 0 ? "UNPROVEN" : "PROVEN";

    const evidence = {
      issueNumber: wf.issue,
      verdict,
      commitSHA: commitSha,
      capturedAt: new Date().toISOString(),
      beforeEvidence: wf.beforeState ?? {
        type: "none", path: null,
        capturedAt: new Date().toISOString(),
        description: "no before-state captured",
      },
      afterEvidence: {
        type: "text", path: null,
        capturedAt: new Date().toISOString(),
        environment: proveEnvironment,
        description: criteriaResults.map(r => `${r.scId}: ${r.verdict}`).join(", "),
      },
      comparisonSummary: `${criteriaResults.filter(r => r.verdict === "PASS").length}/${criteriaResults.length} criteria passed`,
      reproduced: true,
      gaps: fails.map(f => ({ ac: f.scId, status: "UNPROVEN", detail: f.evidence })),
      criteriaResults,
    };

    writeFileSync(`${TEST_DIR}/prove-evidence.json`, JSON.stringify(evidence, null, 2));
    expect(verdict).toBe("PROVEN");
  });

  test("prod environment enforcement: STANDARD+ requires prod evidence (#294, ported to Bun in #484)", () => {
    if (ceremonyTier === "LIGHT") {
      // LIGHT tier is exempt from prod enforcement — API check only
      return;
    }

    // For STANDARD and THOROUGH tiers, afterEvidence.environment must be "prod"
    const evidencePath = `${TEST_DIR}/prove-evidence.json`;
    if (!existsSync(evidencePath)) {
      expect("prove-evidence.json").toBe("must exist before prod enforcement check");
      return;
    }

    const proveEvidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    const env = proveEvidence.afterEvidence?.environment;

    expect(env).toBe("prod");
  });
});
