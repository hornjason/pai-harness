import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { stubGh, type StubbedGh } from "./helpers/stub-gh";

const SCRIPT = join(import.meta.dir, "..", "scripts", "precompute-goal.ts");
const ISSUE_FIXTURE = join(import.meta.dir, "fixtures", "github", "issue-48.json");

// The script shells out to `gh issue view` (scripts/precompute-goal.ts:32).
// Left live, these tests 401 on any machine without Jason's gh credentials —
// six of the 28 CI failures in #71 — and they asserted on the *current* body of
// issue #48, so editing that issue could turn the suite red. The fixture is a
// capture of #48 at the time the assertions below were written.
let gh: StubbedGh;
beforeAll(() => { gh = stubGh(ISSUE_FIXTURE); });
afterAll(() => gh.cleanup());

function runScript(args: string[]): string {
  return execFileSync("bun", [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 20000,
    env: gh.env,
  });
}

describe("precompute-goal", () => {
  test("extracts goalData from a real issue", () => {
    const output = runScript(["--issue", "48", "--repo", "hornjason/pai-harness"]);
    const result = JSON.parse(output);

    expect(result.goalData).toBeDefined();
    expect(result.goalData.issueTitle).toContain("Phase 1");
    expect(result.goalData.successCriteria.length).toBeGreaterThanOrEqual(4);
    expect(result.goalData.labels).toBeInstanceOf(Array);
  });

  test("extracts preloadedContexts with reinforcement rules", () => {
    const output = runScript(["--issue", "48", "--repo", "hornjason/pai-harness"]);
    const result = JSON.parse(output);

    expect(result.preloadedContexts).toBeDefined();
    expect(result.preloadedContexts.marcus).toBeDefined();
    expect(result.preloadedContexts.marcus.rules.length).toBeGreaterThanOrEqual(3);
    expect(result.preloadedContexts.marcus.rules.some((r: string) => r.includes("bun test"))).toBe(true);
    expect(result.preloadedContexts.discovery.rules.length).toBeGreaterThanOrEqual(4);
  });

  test("does not include non-rule lines in reinforcement", () => {
    const output = runScript(["--issue", "48", "--repo", "hornjason/pai-harness"]);
    const result = JSON.parse(output);
    const marcusRules = result.preloadedContexts.marcus.rules;
    expect(marcusRules.every((r: string) => !r.startsWith("`lib/"))).toBe(true);
    expect(marcusRules.every((r: string) => !r.startsWith("`gates/"))).toBe(true);
  });

  test("exits with error on missing args", () => {
    expect(() => {
      execFileSync("bun", [SCRIPT], { encoding: "utf-8", timeout: 10000, env: gh.env });
    }).toThrow();
  });
});
