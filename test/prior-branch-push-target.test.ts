import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";

/**
 * #185 — a nominated prior branch is a push target, so it has to be current.
 *
 * Measured on the #169 run: `detectPriorBranch` nominated `recover-169`, the
 * branch PR #177 had already been squash-merged from. It was 64 commits ahead
 * of the merge base and 4 behind main, and `commitCount: 64` — the only
 * currency signal detection reported — cannot tell those two states apart.
 * ship.js turned that nomination into `HEAD:recover-169` unconditionally, so
 * the run was one push away from reverting #176 and #178.
 *
 * The other half of the same defect was a feature that could not fire: the
 * Implement phase had a `priorBranchResult?.testsPass` resume branch, and
 * every detection call site asked for detection with `runTests: false`, so
 * `testsPass` was never anything but `false`. The resolution taken here is
 * DELETION — see `the testsPass resume path is gone` below for why.
 *
 * ship.js is not importable (the Workflow sandbox has no module loading, #69),
 * so the push-target block is extracted by marker and executed over a sandbox,
 * the same way test/security-verdict-blocks.test.ts does it. A source-text
 * assertion cannot notice that it has stopped describing the code.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const PRECOMPUTE_PATH = join(REPO_ROOT, "scripts", "precompute-goal.ts");
const shipSource = readFileSync(SHIP_PATH, "utf-8");
const precomputeSource = readFileSync(PRECOMPUTE_PATH, "utf-8");

const PUSH_TARGET_START = "// ──── PUSH-TARGET-START ────";
const PUSH_TARGET_END = "// ──── PUSH-TARGET-END ────";
const PAYLOAD_START = "// ──── PRIOR-BRANCH-PAYLOAD-START ────";
const PAYLOAD_END = "// ──── PRIOR-BRANCH-PAYLOAD-END ────";

function sliceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(`source is missing the ${startMarker} / ${endMarker} markers`);
  }
  return source.slice(start + startMarker.length, end);
}

const pushTargetBlock = () => sliceBlock(shipSource, PUSH_TARGET_START, PUSH_TARGET_END);

interface PushTargetOutcome {
  branchToReuse: string | null;
  pushTarget: string;
  logs: string[];
}

/**
 * Execute one copy of the push-target block over a sandbox.
 *
 * `with` over a Proxy rather than a parameter list, for the reason
 * test/security-verdict-blocks.test.ts gives: which module-scope names the
 * block reads is an implementation detail that moves, and a parameter list
 * throws outright when the block declares one of them with `const`.
 */
function runPushTarget(priorBranchResult: unknown, block = pushTargetBlock()): PushTargetOutcome {
  const logs: string[] = [];
  const scope: Record<string, unknown> = {
    priorBranchResult,
    log: (m: unknown) => logs.push(String(m)),
  };
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
    `with (__scope__) {\n${block}\nreturn { branchToReuse, pushTarget }\n}`,
  );
  const out = factory(sandbox) as { branchToReuse: string | null; pushTarget: string };
  return { ...out, logs };
}

/** A nomination detection measured as current with the base. */
const CURRENT = {
  branch: "185-prior-branch-currency",
  refName: "refs/heads/185-prior-branch-currency",
  commitCount: 3,
  behindCount: 0,
  isBehind: false,
  isMerged: false,
};

/**
 * The regression case, with the numbers the issue measured: 64 ahead, 4
 * behind, content already squash-merged into main.
 */
const RECOVER_169 = {
  branch: "recover-169",
  refName: "refs/heads/recover-169",
  commitCount: 64,
  behindCount: 4,
  isBehind: true,
  isMerged: true,
};

describe("#185 AC-5: the push target consults currency", () => {
  test("a current prior branch is still reused — the positive control", () => {
    // A guard that refuses every nomination satisfies all the negative cases
    // below and deletes #515's orphan-branch fix. This is the case that stops
    // that from reading as success.
    const out = runPushTarget(CURRENT);
    expect(out.branchToReuse).toBe(CURRENT.branch);
    expect(out.pushTarget).toBe(`HEAD:${CURRENT.branch}`);
  });

  test("a branch behind the base is not reused", () => {
    const out = runPushTarget({ ...CURRENT, behindCount: 4, isBehind: true });
    expect(out.branchToReuse).toBeNull();
    expect(out.pushTarget).toBe("HEAD");
    expect(out.logs.join("\n")).toMatch(/behind/i);
  });

  test("a branch already merged into the base is not reused", () => {
    const out = runPushTarget({ ...CURRENT, isMerged: true });
    expect(out.branchToReuse).toBeNull();
    expect(out.pushTarget).toBe("HEAD");
    expect(out.logs.join("\n")).toMatch(/merged/i);
  });

  test("the recover-169 shape — 64 ahead, 4 behind, squash-merged — is not reused", () => {
    const out = runPushTarget(RECOVER_169);
    expect(out.branchToReuse).toBeNull();
    expect(out.pushTarget).toBe("HEAD");
  });

  test("a nomination with no currency measurement is not reused either", () => {
    // Unmeasured is not clean (.claude/rules/checks-must-be-able-to-fail.md).
    // This is exactly the payload detection produced before #185, and it is
    // also what an older caller's pre-computed args carry.
    const out = runPushTarget({
      branch: "recover-169",
      refName: "refs/heads/recover-169",
      commitCount: 64,
    });
    expect(out.branchToReuse).toBeNull();
    expect(out.pushTarget).toBe("HEAD");
    expect(out.logs.join("\n")).toMatch(/no currency measurement|not measured|unmeasured/i);
  });

  test("a half-measured nomination is not reused", () => {
    // isBehind measured false, isMerged absent: the squash-merge case is the
    // one `commitCount` already hid, so an absent isMerged must not pass.
    const out = runPushTarget({ ...CURRENT, isMerged: undefined });
    expect(out.branchToReuse).toBeNull();
    expect(out.pushTarget).toBe("HEAD");
  });

  test("no nomination at all falls back to HEAD", () => {
    expect(runPushTarget(null).pushTarget).toBe("HEAD");
    expect(runPushTarget({ branch: "", refName: "", commitCount: null }).pushTarget).toBe("HEAD");
  });

  test("the block is a single marked region the run actually reaches", () => {
    for (const marker of [PUSH_TARGET_START, PUSH_TARGET_END]) {
      expect(
        (shipSource.match(new RegExp(marker.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"), "g")) || []).length,
        `${marker} does not appear exactly once`,
      ).toBe(1);
    }
    expect(assertMarkedBlockReachable(shipSource, "PUSH-TARGET")).toEqual(["Program"]);
  });
});

// ── the mutation: strip the currency check from the push-target block ──

/**
 * The one line the mutation removes.
 *
 * Declared as a literal rather than built by regex so that rewriting it in
 * ship.js aborts this file instead of quietly mutating nothing — the property
 * test/suite-binding-mutation.test.ts asserts for its own binding.
 */
const CURRENCY_GUARD =
  "const branchToReuse = priorCurrency.reusable ? priorBranchResult.branch : null";

function blockWithoutCurrencyCheck(): string {
  const block = pushTargetBlock();
  const occurrences = block.split(CURRENCY_GUARD).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the currency guard appears ${occurrences} times, expected exactly 1. ` +
        `Either it was rewritten, or a second branchToReuse assignment exists and removing one would leave the other reusing.`,
    );
  }
  return block.replace(
    CURRENCY_GUARD,
    "const branchToReuse = priorBranchResult?.branch || null // MUTANT: currency is not consulted",
  );
}

describe("#185 AC-5: the currency check is load-bearing, not decorative", () => {
  test("the mutant reuses the stale branch while the real source refuses it", () => {
    // One input, both copies. The mutant must REUSE — a mutation that also
    // fell back to HEAD would mean the push target never depended on currency
    // at all, which is this whole test's subject.
    const real = runPushTarget(RECOVER_169);
    const mutant = runPushTarget(RECOVER_169, blockWithoutCurrencyCheck());

    expect(real.pushTarget, "the real source reused a squash-merged branch").toBe("HEAD");
    expect(mutant.pushTarget, "with the currency check stripped the run still fell back to HEAD").toBe(
      "HEAD:recover-169",
    );
  });

  test("the mutant also reuses an unmeasured nomination", () => {
    const unmeasured = { branch: "recover-169", refName: "refs/heads/recover-169", commitCount: 64 };
    expect(runPushTarget(unmeasured).pushTarget).toBe("HEAD");
    expect(runPushTarget(unmeasured, blockWithoutCurrencyCheck()).pushTarget).toBe("HEAD:recover-169");
  });

  test("the mutant still reuses a current branch, so the mutation is narrow", () => {
    // If the mutant disagreed with the real source on the positive control
    // too, the test above would pass for a mutation that broke something else.
    expect(runPushTarget(CURRENT, blockWithoutCurrencyCheck()).pushTarget).toBe(
      `HEAD:${CURRENT.branch}`,
    );
  });

  test("the mutation harness aborts when the guard is rewritten", () => {
    expect(() => {
      const rewritten = pushTargetBlock().replace(
        CURRENCY_GUARD,
        "const branchToReuse = somethingElse()",
      );
      const occurrences = rewritten.split(CURRENCY_GUARD).length - 1;
      if (occurrences !== 1) throw new Error("could not build the mutant");
      return rewritten;
    }).toThrow(/could not build the mutant/);
  });
});

// ── both downstream readers of branchToReuse ──────────────────────────

describe("#185 AC-5: the refusal reaches both readers of branchToReuse", () => {
  test("the push step writes `HEAD:${branchToReuse}` and nothing else", () => {
    // #164's contract: refName resolves, the bare name is the push target.
    expect(shipSource).toContain("`HEAD:${branchToReuse}`");
    expect(shipSource).toContain("-u origin ${pushTarget}");
  });

  test("the PR head name falls back to the committed branch", () => {
    // shipBranch is the second reader (#136). Because the guard nulls
    // branchToReuse rather than rewriting the push target string, both readers
    // are covered by the one check.
    expect(shipSource).toMatch(/const shipBranch = branchToReuse \|\| commitResult\.branch/);
  });
});

// ── AC-4: the dead testsPass pairing is gone ──────────────────────────

describe("#185 AC-4: the testsPass resume path is gone", () => {
  test("no branch of ship.js reads the resume signal", () => {
    // The resolution of the issue's either/or, stated here because the code is
    // now an absence and an absence cannot explain itself: DELETED, not wired
    // up. Making it reachable means running the prior branch's whole suite in
    // a throwaway worktree on every ship — minutes of wall clock, on every
    // run, to skip an Implement phase for work no run has ever resumed. The
    // path has never executed once, so nothing regresses by removing it, and
    // what it would have resumed is exactly the stale branch the currency
    // check above now refuses.
    // Counted rather than `not.toContain`, which prints the whole 4,000-line
    // file on failure and buries the one line that matters.
    expect(shipSource.split("priorBranchResult?.testsPass").length - 1).toBe(0);
    expect(shipSource.split("priorBranchResult.testsPass").length - 1).toBe(0);
  });

  test("ship.js names no suite-result field of the prior branch at all", () => {
    // Including in a comment: the issue's own evidence command is a grep, and
    // a comment quoting the deleted expression would satisfy the grep while
    // the code was still reading it.
    expect((shipSource.match(/\btestsPass\b/g) || []).length).toBe(0);
  });

  test("every detection call site asks for detection without running the suite", () => {
    const callSites = [...shipSource.matchAll(/detectPriorBranch\(\{[\s\S]*?\}\)/g)].map(m => m[0]);
    expect(callSites.length, "ship.js stopped calling detectPriorBranch").toBeGreaterThan(0);
    for (const call of callSites) {
      expect(call, `a detection call site does not pass runTests:false: ${call}`).toContain(
        "runTests:false",
      );
    }

    const precomputeCalls = [...precomputeSource.matchAll(/detectPriorBranch\(\{[\s\S]*?\}\)/g)].map(
      m => m[0],
    );
    expect(precomputeCalls.length).toBeGreaterThan(0);
    for (const call of precomputeCalls) {
      expect(call).toContain("runTests:false");
    }
  });

  test("the Implement phase worktree is taken from the implementation that ran", () => {
    expect(shipSource).toMatch(
      /const marcusWorktreePath = implementResult\.buildResult\?\.worktreePath \|\| PROJECT_ROOT/,
    );
  });
});

// ── the measurement is propagated, not re-derived ─────────────────────

/**
 * Execute precompute-goal.ts's priorBranch payload mapping over a stubbed
 * detection result.
 *
 * A grep for the three field names would pass over a mapping that mentioned
 * them in a comment, or that read them off the wrong object. This runs it.
 */
function buildPayload(parsed: Record<string, unknown>) {
  const block = sliceBlock(precomputeSource, PAYLOAD_START, PAYLOAD_END);
  const factory = new Function("parsed", `let priorBranch;\n${block}\nreturn priorBranch`);
  return factory(parsed) as Record<string, unknown> | undefined;
}

describe("#185: precompute-goal.ts propagates the currency measurement", () => {
  test("behindCount, isBehind and isMerged reach the priorBranch payload", () => {
    const payload = buildPayload({
      branch: "recover-169",
      refName: "refs/heads/recover-169",
      commitCount: 64,
      behindCount: 4,
      isBehind: true,
      isMerged: true,
    });
    expect(payload).toEqual({
      branch: "recover-169",
      refName: "refs/heads/recover-169",
      commitCount: 64,
      behindCount: 4,
      isBehind: true,
      isMerged: true,
    });
  });

  test("a detection that could not measure currency reports null, not false", () => {
    // `false` would be a claim that the branch is current. The absence of an
    // answer is not the answer "no" — the same rule commitCount already
    // follows at lib/prior-branch.ts.
    const payload = buildPayload({ branch: "x", refName: "refs/heads/x" });
    expect(payload).toEqual({
      branch: "x",
      refName: "refs/heads/x",
      commitCount: null,
      behindCount: null,
      isBehind: null,
      isMerged: null,
    });
  });

  test("the payload Scope receives is refused by the push-target block when stale", () => {
    // The two ends of the wire, joined: what precompute writes is what ship.js
    // reads, so a field renamed on one side is caught here rather than by two
    // suites that each pass against their own fixture.
    const payload = buildPayload({
      branch: "recover-169",
      refName: "refs/heads/recover-169",
      commitCount: 64,
      behindCount: 4,
      isBehind: true,
      isMerged: true,
    });
    expect(runPushTarget(payload).pushTarget).toBe("HEAD");

    const current = buildPayload({
      branch: "185-live",
      refName: "refs/heads/185-live",
      commitCount: 2,
      behindCount: 0,
      isBehind: false,
      isMerged: false,
    });
    expect(runPushTarget(current).pushTarget).toBe("HEAD:185-live");
  });
});

describe("#185: ship.js still parses as a workflow script", () => {
  test("the edited source loads", () => {
    const src = shipSource.replace(/^export /gm, "");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction("args", src)).not.toThrow();
  });
});
