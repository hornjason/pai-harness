import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stubGh, type StubbedGh } from "./helpers/stub-gh";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "precompute-goal.ts");
const SOURCE = readFileSync(SCRIPT, "utf-8");
const FIXTURES = join(import.meta.dir, "fixtures", "github");
const ISSUE_FIXTURE = join(FIXTURES, "issue-48.json");

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

// ── The mutant (#202) ─────────────────────────────────────────────────────
//
// Every refusal below runs TWICE: once against the real script, once against a
// copy whose single exit-code constant is set to 0. The second run is the
// evidence. "exit code != 0" alone cannot tell a refusal from a crash, a typo
// or a module-resolution failure, and .claude/rules/checks-must-be-able-to-fail.md
// counts five shipped bugs of exactly that shape in one day.
//
// The mutant lives in a temp directory OUTSIDE the repo, which is what proves
// the script has no relative imports: a later `from "../lib/..."` would make
// every mutant die on module resolution, exiting non-zero, which would read as
// "the mutation was rejected on the merits" when in fact the mutant never ran.

let MUTANT = "";
let MUTANT_DIR = "";

beforeAll(() => {
  MUTANT_DIR = mkdtempSync(join(tmpdir(), "precompute-goal-mutant-"));
  const mutated = SOURCE.replace(/GOAL_REFUSE_EXIT\s*=\s*1\b/, "GOAL_REFUSE_EXIT = 0");
  if (mutated === SOURCE) {
    throw new Error(
      "could not build the mutant: no `GOAL_REFUSE_EXIT = 1` in scripts/precompute-goal.ts",
    );
  }
  MUTANT = join(MUTANT_DIR, "precompute-goal.ts");
  writeFileSync(MUTANT, mutated);
});

afterAll(() => {
  if (MUTANT_DIR) rmSync(MUTANT_DIR, { recursive: true, force: true });
});

/** Run a script against one fixture body, with `gh` stubbed for that issue. */
function run(script: string, fixture: string, issue: string, extra: string[] = []) {
  const stub = stubGh(join(FIXTURES, fixture), issue);
  try {
    const r = spawnSync("bun", [script, "--issue", issue, "--repo", "hornjason/pai-harness", ...extra], {
      encoding: "utf-8",
      timeout: 20000,
      env: stub.env,
    });
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  } finally {
    stub.cleanup();
  }
}

/** The goalData the script prints for a fixture body. */
function goalFor(fixture: string, issue: string): any {
  const r = run(SCRIPT, fixture, issue);
  expect(r.code, `expected a goal for ${fixture}\n${r.err}`).toBe(0);
  return JSON.parse(r.out).goalData;
}

/** Assert a body is refused, and that the refusal is what is being observed. */
function expectRefused(fixture: string, issue: string, reason: RegExp) {
  const real = run(SCRIPT, fixture, issue);
  expect(real.code, `expected a refusal for ${fixture}\n${real.err}`).not.toBe(0);
  expect(real.err).toMatch(reason);
  expect(real.out.trim(), "a refused run printed goal data on stdout").toBe("");

  const mutant = run(MUTANT, fixture, issue);
  expect(
    mutant.code,
    `the mutant (GOAL_REFUSE_EXIT = 0) still exited ${mutant.code} for ${fixture} — ` +
      `this case is not being caught by the refusal under test.\n${mutant.err}`,
  ).toBe(0);
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

// ── Harness-authored leading metadata (#202) ──────────────────────────────

describe("goal extraction skips harness metadata", () => {
  test("the rescope banner is not the goal", () => {
    const goalData = goalFor("issue-200-rescoped.json", "200");

    // The measured failure: 414 characters describing the SPLIT, not the work.
    expect(goalData.issueGoal).not.toMatch(/Rescoped to Phase/);
    expect(goalData.issueGoal).not.toMatch(/Sub-issues:/);
    expect(goalData.issueGoal).toMatch(/takes the first paragraph of the issue body verbatim/);
  });

  test("a blockquote the author wrote is kept", () => {
    // The positive control for the test above. If the parser skipped leading
    // blockquotes on sight, this issue would lose its problem statement and the
    // banner test would still be green — a detector wider than what it detects.
    const goalData = goalFor("issue-authored-blockquote.json", "204");

    expect(goalData.issueGoal).toMatch(/scheduler drops a job/);
    expect(goalData.issueGoal).toMatch(/second write wins/);
  });

  test("a sub-issue's `Parent: #200` line is not the goal", () => {
    // Measured on #201: issueGoal came back as the literal string "Parent: #200",
    // 12 characters. Nothing follows it but headings, so there is no goal here
    // and the script must say so rather than brief Marcus on a cross-reference.
    expectRefused("issue-201-parent-only.json", "201", /Parent: #200|no goal|metadata/i);
  });

  test("issue #48's own `Parent: #47` opener is skipped, not returned", () => {
    // The fixture already in the repo carries the bug: its body opens
    // "Parent: #47", so every run of this script on it returned those 11
    // characters as the goal while four assertions above stayed green.
    const goalData = goalFor("issue-48.json", "48");

    expect(goalData.issueGoal).not.toBe("Parent: #47");
    expect(goalData.issueGoal).toMatch(/Replace `read-issue`/);
  });

  test("banner phrases still match what the harness writes", () => {
    // The failure mode this guards: a detector narrower than what it detects.
    // If the decomposition prompt in ship.js is reworded, the parser silently
    // stops recognising the banner and the goal becomes the banner again. This
    // turns that rewording into a red test instead of a quiet regression.
    const ship = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");
    const instructed = [...SOURCE.matchAll(/phrase:\s*"([^"]+)",\s*instructedIn:\s*"([^"]+)"/g)];

    expect(instructed.length, "no banner phrase claims to be instructed in a generator").toBeGreaterThan(0);
    for (const [, phrase, where] of instructed) {
      expect(where).toBe("workflows/ship.js");
      expect(ship, `"${phrase}" is no longer written by workflows/ship.js`).toContain(phrase);
    }
  });
});

// ── The property the mutant protects (#202) ───────────────────────────────

describe("refusal wiring", () => {
  test("GOAL_REFUSE_EXIT is declared once", () => {
    const decls = SOURCE.match(/GOAL_REFUSE_EXIT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment to GOAL_REFUSE_EXIT — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("every process.exit routes through GOAL_REFUSE_EXIT", () => {
    for (const [call] of SOURCE.matchAll(/process\.exit\([^)]*\)/g)) {
      expect(
        call,
        `${call} bypasses GOAL_REFUSE_EXIT, so the mutant cannot neutralise it and the ` +
          `refusal it performs is not covered by any test here`,
      ).toBe("process.exit(GOAL_REFUSE_EXIT)");
    }
  });

  test("the script has no relative imports", () => {
    const rel = [...SOURCE.matchAll(/from\s+["'](\.[^"']*)["']/g)].map((m) => m[1]);
    expect(rel, "a relative import would make every mutant run fail to resolve").toEqual([]);
  });

  test("the mutant is not simply a script that always exits 0", () => {
    // Guards the guard: if the mutant failed to parse, or exited 0 on every
    // input, the second half of expectRefused would pass vacuously.
    const r = run(MUTANT, "issue-48.json", "48");
    expect(r.code, `the mutant could not run a normal input\n${r.err}`).toBe(0);
    expect(JSON.parse(r.out).goalData.issueGoal).toMatch(/Replace `read-issue`/);
  });

  test("a missing --issue is refused through the same constant", () => {
    const real = spawnSync("bun", [SCRIPT], { encoding: "utf-8", timeout: 20000, env: gh.env });
    expect(real.status).not.toBe(0);

    const mutant = spawnSync("bun", [MUTANT], { encoding: "utf-8", timeout: 20000, env: gh.env });
    expect(
      mutant.status,
      "the usage error does not go through GOAL_REFUSE_EXIT — it exits by some other route",
    ).toBe(0);
  });
});
