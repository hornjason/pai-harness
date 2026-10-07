/**
 * A Rook FAIL stops the run (#129)
 *
 * SC-566, SC-567, SC-568, SC-569 (HARNESS-STANDARD.md)
 *
 * Rook was asked for a gate verdict in gate-verdict shape and nothing read it.
 * On `wf_7c91ba3a-a22` it returned FAIL carrying a reproduced HIGH guard
 * bypass, and the workflow returned `SHIPPED` and opened a PR — the verdict
 * surfaced only as a compliance grade, which measures whether rook followed
 * its brief, not what it found.
 *
 * The decision logic is EXTRACTED AND EXECUTED here, not grepped. Asserting
 * that ship.js "contains rookResult" stays true after the branch that acts on
 * it is deleted, which is precisely the mutation this file has to catch —
 * `.claude/rules/checks-must-be-able-to-fail.md`. The extraction pattern is
 * the established one: see test/ship-collect-destination.test.ts.
 *
 * What was broken to prove these can fail:
 *   - deleting the `if (securityVerdict.verdict === 'FAIL')` branch from
 *     MERGE-DECISION  -> every test in "blocks the run" fails
 *   - `return { spawned: true, verdict: 'PASS', failures: [] }` from
 *     rookGateVerdict -> every test in "the verdict fails closed" fails
 *   - relaxing rookReviewSha to `return reported` -> the refusal tests fail
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function block(startMarker: string, endMarker: string): string {
  const start = shipSource.indexOf(startMarker);
  const end = shipSource.indexOf(endMarker);
  if (start < 0 || end < 0) {
    throw new Error(`${startMarker} / ${endMarker} not found in ship.js`);
  }
  return shipSource.slice(start, end);
}

type Verdict = { spawned: boolean; verdict: string; failures: string[] };

type Helpers = {
  rookReviewSha: (reported: unknown) => string | null;
  rookScopeCommand: (
    projectRoot: string,
    base: string,
    sha: string,
    outFile: string,
  ) => string;
  rookGateVerdict: (scope: unknown, rookResult: unknown) => Verdict;
};

const helpers: Helpers = new Function(
  `${block("// ──── ROOK-SECURITY-START ────", "// ──── ROOK-SECURITY-END ────")}
   return { rookReviewSha, rookScopeCommand, rookGateVerdict }`,
)();

const { rookReviewSha, rookScopeCommand, rookGateVerdict } = helpers;

/** The merge decision, run for real. Returns the workflow's return value, or null. */
function decide(opts: {
  securityVerdict: Verdict;
  verifyResult: unknown;
}): { result: Record<string, unknown> | null; logs: string[] } {
  const logs: string[] = [];
  const body = block(
    "// ──── MERGE-DECISION-START ────",
    "// ──── MERGE-DECISION-END ────",
  );
  const run = new Function(
    "securityVerdict",
    "verifyResult",
    "log",
    "shipBranch",
    "ISSUE",
    "SLUG",
    "WORK_DIR",
    `return (() => {\n${body}\nreturn null })()`,
  );
  const result = run(
    opts.securityVerdict,
    opts.verifyResult,
    (m: unknown) => logs.push(String(m)),
    "ship-129",
    129,
    "pai-harness-129",
    "/tmp/work",
  ) as Record<string, unknown> | null;
  return { result, logs };
}

const PASS: Verdict = { spawned: true, verdict: "PASS", failures: [] };
const FAIL: Verdict = {
  spawned: true,
  verdict: "FAIL",
  failures: ["HIGH: command injection in scripts/github-op.ts"],
};

describe("SC-566: a Rook FAIL blocks the run at the merge decision", () => {
  test("the run returns SHIP_FAILED", () => {
    const { result } = decide({ securityVerdict: FAIL, verifyResult: { result: "PASS" } });
    expect(result?.status).toBe("SHIP_FAILED");
  });

  test("it stops even when the verify gate passed", () => {
    // The whole defect: verify PASS was the only thing consulted, so a FAIL
    // from the one gate whose job is to say no reached a PR.
    const { result } = decide({ securityVerdict: FAIL, verifyResult: { result: "PASS" } });
    expect(result, "a security FAIL let a verify-PASS run continue to the PR step").not.toBeNull();
  });

  test("the reason names the finding, so the blocked run is readable", () => {
    const { result } = decide({ securityVerdict: FAIL, verifyResult: { result: "PASS" } });
    expect(String(result?.reason)).toContain("command injection in scripts/github-op.ts");
    expect((result?.security as Verdict).failures).toEqual(FAIL.failures);
  });

  test("the work is not discarded — the branch is reported back", () => {
    const { result } = decide({ securityVerdict: FAIL, verifyResult: { result: "PASS" } });
    expect(result?.branch).toBe("ship-129");
    expect(result?.issue).toBe(129);
  });

  test("a PASS verdict does not stop the run", () => {
    // The over-fix guard. A block that fires on every run is not a gate.
    const { result } = decide({ securityVerdict: PASS, verifyResult: { result: "PASS" } });
    expect(result).toBeNull();
  });

  test("a verify FAIL still only logs — this change did not alter that path", () => {
    const { result, logs } = decide({ securityVerdict: PASS, verifyResult: { result: "FAIL" } });
    expect(result).toBeNull();
    expect(logs.some(l => /branch stays unmerged/.test(l))).toBe(true);
  });

  test("the decision reads verifyResult at the same point", () => {
    // SC-566 is specific about WHERE: the security verdict is decided beside
    // the verify verdict, not in some later block a future edit can reorder
    // past the PR step.
    const body = block(
      "// ──── MERGE-DECISION-START ────",
      "// ──── MERGE-DECISION-END ────",
    );
    expect(body).toContain("verifyResult?.result === 'FAIL'");
    expect(body).toContain("securityVerdict.verdict === 'FAIL'");
  });

  test("the decision happens before the PR step", () => {
    const decisionEnd = shipSource.indexOf("// ──── MERGE-DECISION-END ────");
    const prStep = shipSource.indexOf("pr-upsert");
    expect(decisionEnd).toBeGreaterThan(0);
    expect(prStep).toBeGreaterThan(decisionEnd);
  });

  test("the decision happens after grading, so a blocked run is still measured", () => {
    const gradeStep = shipSource.indexOf("GRADE: skipped (skipGrade=true)");
    const decisionStart = shipSource.indexOf("// ──── MERGE-DECISION-START ────");
    expect(gradeStep).toBeGreaterThan(0);
    expect(decisionStart).toBeGreaterThan(gradeStep);
  });
});

describe("SC-568: the verdict fails closed on anything it cannot establish", () => {
  const goodScope = { exitCode: 0, files: ["workflows/ship.js"] };

  test("a clean scope and a rook PASS is the only PASS", () => {
    expect(rookGateVerdict(goodScope, { result: "PASS" })).toEqual({
      spawned: true,
      verdict: "PASS",
      failures: [],
    });
  });

  const closed: Array<[string, unknown, unknown]> = [
    // The empty-scope case, which used to pass. `test -s` turns it into a
    // non-zero exit, and a non-zero exit blocks regardless of rook's verdict.
    ["a non-zero exit from the scope command", { exitCode: 1, files: [] }, { result: "PASS" }],
    ["a non-zero exit even with files reported", { exitCode: 128, files: ["a.ts"] }, { result: "PASS" }],
    ["zero changed files on a zero exit", { exitCode: 0, files: [] }, { result: "PASS" }],
    ["a scope report with no file list", { exitCode: 0 }, { result: "PASS" }],
    ["a file list of blank strings", { exitCode: 0, files: ["", "  "] }, { result: "PASS" }],
    ["a file list that is not an array", { exitCode: 0, files: "lib/a.ts" }, { result: "PASS" }],
    ["an exit code that is not a number", { exitCode: "0", files: ["a.ts"] }, { result: "PASS" }],
    ["no exit code at all", { files: ["a.ts"] }, { result: "PASS" }],
    ["no scope report", null, { result: "PASS" }],
    ["a scope report that is a string", "ok", { result: "PASS" }],
    ["no verdict from rook", goodScope, null],
    ["a verdict rook never gave", goodScope, {}],
    ["a verdict outside the schema", goodScope, { result: "WARN" }],
    ["a rook FAIL", goodScope, { result: "FAIL", failures: ["HIGH: path traversal"] }],
    ["a rook FAIL with no detail", goodScope, { result: "FAIL" }],
    ["a rook FAIL with a blank detail list", goodScope, { result: "FAIL", failures: ["", " "] }],
  ];

  for (const [name, scope, rook] of closed) {
    test(`FAIL on ${name}`, () => {
      expect(rookGateVerdict(scope, rook).verdict).toBe("FAIL");
    });
  }

  test("every FAIL carries a non-empty reason", () => {
    // SC-569's other half. A blocked run whose state file says FAIL with an
    // empty failures list is an artefact nobody can act on.
    for (const [name, scope, rook] of closed) {
      const v = rookGateVerdict(scope, rook);
      expect(v.failures.length, `${name} produced a FAIL with no reason`).toBeGreaterThan(0);
      expect(v.failures.every(f => typeof f === "string" && f.trim().length > 0)).toBe(true);
    }
  });

  test("rook's own findings survive into the verdict verbatim", () => {
    const v = rookGateVerdict(goodScope, {
      result: "FAIL",
      failures: ["HIGH: ISSUE_URL matched anywhere in the closing segment"],
    });
    expect(v.failures).toContain("HIGH: ISSUE_URL matched anywhere in the closing segment");
  });

  test("the verdict always records that the review was spawned", () => {
    expect(rookGateVerdict(goodScope, { result: "PASS" }).spawned).toBe(true);
    expect(rookGateVerdict(null, null).spawned).toBe(true);
  });
});

describe("SC-567: the review commit is fixed by the workflow", () => {
  test("a short SHA is accepted", () => {
    expect(rookReviewSha("3192a75")).toBe("3192a75");
  });

  test("a full SHA is accepted", () => {
    const full = "3192a759".padEnd(40, "a");
    expect(rookReviewSha(full)).toBe(full);
  });

  test("surrounding whitespace is trimmed, not rejected", () => {
    expect(rookReviewSha("  3192a759\n")).toBe("3192a759");
  });

  const refused: Array<[string, unknown]> = [
    ["a ref name", "HEAD"],
    ["a revision range", "origin/main...HEAD"],
    ["a branch", "worktree-wf_7c91ba3a-a22-9"],
    ["command substitution", "3192a75$(touch pwned)"],
    ["backticks", "3192a75`id`"],
    ["a semicolon", "3192a75; rm -rf /"],
    ["a newline carrying a second command", "3192a75\ntouch pwned"],
    ["an upper-case SHA git never prints", "3192A759"],
    ["too short to be a git abbreviation", "319"],
    ["longer than a SHA", "a".repeat(41)],
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 3192759],
  ];

  for (const [name, value] of refused) {
    test(`refuses ${name}`, () => {
      expect(rookReviewSha(value)).toBeNull();
    });
  }

  test("the scope command pins the diff to that commit and nothing else", () => {
    const cmd = rookScopeCommand("/repo", "origin/main", "3192a75", "/work/rook-scope.txt");
    expect(cmd).toContain("git diff --name-only origin/main 3192a75");
    // The defect being fixed: `origin/main...HEAD` inside a worktree cut from
    // origin/main is empty, so the review ran on nothing.
    expect(cmd).not.toContain("HEAD");
    expect(cmd).not.toContain("...");
  });

  test("an empty diff is a non-zero exit, established by the command itself", () => {
    // SC-568: the emptiness is git's statement, not the reviewing agent's.
    const cmd = rookScopeCommand("/repo", "origin/main", "3192a75", "/work/rook-scope.txt");
    expect(cmd).toContain("test -s /work/rook-scope.txt");
    expect(cmd).toContain("&&");
  });
});

describe("SC-569: the run's own artefact records the verdict", () => {
  const fanout = () =>
    shipSource.slice(
      shipSource.indexOf("// ──── VERIFY-FANOUT-START ────"),
      shipSource.indexOf("// ──── VERIFY-FANOUT-END ────"),
    );

  test("workflow-state.json gets agents.rook", () => {
    expect(fanout()).toContain("s.agents.rook =");
  });

  test("the verdict reaches the state file through a file, not the shell", () => {
    // `failures` is text a language model wrote. ship.js:377 records the cost
    // of interpolating agent-derived strings into a shell command once.
    const body = fanout();
    expect(body).toContain("<<'RUNGATE_ROOK_VERDICT_EOF'");
    expect(body).toContain("rook-verdict.json");
    const writeLine = body
      .split("\n")
      .find(l => l.includes("s.agents.rook ="));
    expect(writeLine).toBeDefined();
    expect(writeLine, "the verdict text was interpolated into the bun -e command")
      .not.toContain("securityVerdict");
  });

  test("the default verdict before the review is FAIL, not PASS or absent", () => {
    // #129's third finding was rook being ABSENT from workflow-state.json.
    // The initial value also decides what happens if the fan-out never runs:
    // an absent review must block, not sail through.
    const decl = shipSource
      .split("\n")
      .find(l => l.includes("let securityVerdict ="));
    expect(decl).toBeDefined();
    expect(decl).toContain("verdict: 'FAIL'");
    const { result } = decide({
      securityVerdict: { spawned: false, verdict: "FAIL", failures: ["the security review did not run"] },
      verifyResult: { result: "PASS" },
    });
    expect(result?.status).toBe("SHIP_FAILED");
  });
});
