/**
 * The push target consults the prior branch's currency (#185)
 *
 * The issue was first filed as latent, on the reasoning that the resume path
 * at ship.js's Implement phase is unreachable — both detection call sites pass
 * `runTests: false`, so `testsPass` is always false. That reasoning was right
 * about that branch and wrong about the consequence, because there is a SECOND
 * consumer that never looks at `testsPass` at all: `branchToReuse` takes the
 * nominated branch unconditionally and `pushTarget` turns it into
 * `HEAD:<branch>`. Every nomination was a push target.
 *
 * Measured live on 2026-10-11: for issue 254 detection nominated
 * `run/254-wf19f7def7-rescue` — 1 ahead of main, 8 behind, tip message "NOT
 * reviewed, do not merge" — so the push could only be rejected as a
 * non-fast-forward. That is a hard blocker on #254.
 *
 * ship.js is not importable (the Workflow sandbox has no module loading, #69),
 * so the block is extracted by marker and executed with stubs, the same way
 * test/security-verdict-blocks.test.ts does it.
 *
 * Positive control (.claude/rules/checks-must-be-able-to-fail.md): every
 * refusal case is run twice — against the real source, and against a mutant
 * whose single decision function is short-circuited back to the old
 * `prior?.branch || null`. The real one must refuse and the mutant must reuse;
 * a check that refuses everything fails the current-branch case, and one that
 * refuses nothing fails the stale, merged and unknown cases. The mutant build
 * aborts if the signature is not found exactly once, so renaming the function
 * cannot turn this file green.
 *
 * What was broken to prove it, run and counted rather than asserted, over the
 * six prior-branch suites (59 tests):
 *
 * | Mutation | Red |
 * |---|---|
 * | `reusablePriorBranch` short-circuited to `(prior && prior.branch) \|\| null` in the real source | 5 — the three refusals, their mutant halves having nothing left to distinguish, and the "why" assertion |
 * | `reusablePriorBranch` renamed to `currentEnoughPriorBranch` | 4 — three throwing `could not build the mutant: the decision signature appears 0 times`, plus the call-site count |
 *
 * Neither is left in the tree; both were run and reverted.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const PUSH_TARGET_START = "// ──── PUSH-TARGET-CURRENCY-START ────";
const PUSH_TARGET_END = "// ──── PUSH-TARGET-CURRENCY-END ────";

/**
 * The one function the whole decision goes through. Declared here as a
 * literal so the mutation below has a single, named target: a second refusal
 * path for the same fact would survive the mutation and the mutant would go
 * red for a reason that has nothing to do with the mutation working.
 */
const DECISION_SIGNATURE = "function reusablePriorBranch(prior) {";

/**
 * The mutation: the decision collapses to what ship.js did before #185 —
 * take whatever detection nominated.
 */
const DECISION_MUTANT = `${DECISION_SIGNATURE} return (prior && prior.branch) || null;`;

function sliceBlock(startMarker: string, endMarker: string): string {
  const start = shipSource.indexOf(startMarker);
  const end = shipSource.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(`ship.js is missing the ${startMarker} / ${endMarker} markers`);
  }
  return shipSource.slice(start + startMarker.length, end);
}

/**
 * Module scope on purpose: if the markers go missing, this throws and every
 * test in the file fails to load, rather than the file quietly asserting
 * nothing about a ship.js that lost its currency check.
 */
const PUSH_TARGET_BLOCK = sliceBlock(PUSH_TARGET_START, PUSH_TARGET_END);

function buildMutantBlock(): string {
  const occurrences = PUSH_TARGET_BLOCK.split(DECISION_SIGNATURE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the decision signature appears ${occurrences} times`,
    );
  }
  return PUSH_TARGET_BLOCK.replace(DECISION_SIGNATURE, DECISION_MUTANT);
}

interface PushTargetOutcome {
  branchToReuse: string | null;
  pushTarget: string;
  logs: string[];
}

/** Execute one copy of the block over a prior-branch nomination. */
function runBlock(block: string, prior: unknown): PushTargetOutcome {
  const logs: string[] = [];
  const scope: Record<string, unknown> = {
    priorBranchResult: prior,
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

const CURRENT = {
  branch: "185-deep-modules",
  refName: "refs/heads/185-deep-modules",
  commitCount: 3,
  behindCount: 0,
  isBehind: false,
  isMerged: false,
  testsPass: false,
};

/** The branch this repository actually carries for #254, by the numbers. */
const STALE = { ...CURRENT, branch: "254-pr-when-container", behindCount: 8, isBehind: true };
const MERGED = { ...CURRENT, branch: "254-pr-when-container", isMerged: true };
const UNKNOWN = {
  branch: "254-pr-when-container",
  refName: "refs/heads/254-pr-when-container",
  commitCount: null,
  behindCount: null,
  isBehind: null,
  isMerged: null,
  testsPass: false,
};

describe("ship.js: a stale prior branch is not a push target (#185)", () => {
  test("a current prior branch is still reused", () => {
    // The control that stops "refuse everything" from buying green. #515's
    // orphan-branch problem is still solved for branches that can be pushed to.
    const real = runBlock(PUSH_TARGET_BLOCK, CURRENT);
    expect(real.branchToReuse).toBe("185-deep-modules");
    expect(real.pushTarget).toBe("HEAD:185-deep-modules");
  });

  test("a branch behind the base is refused, and the mutant reuses it", () => {
    const real = runBlock(PUSH_TARGET_BLOCK, STALE);
    expect(real.branchToReuse).toBeNull();
    expect(real.pushTarget).toBe("HEAD");
    expect(real.logs.join("\n")).toContain("254-pr-when-container");

    // The removal of the check, performed and observed: without it the stale
    // branch becomes the push target again, which is exactly the live failure.
    const mutant = runBlock(buildMutantBlock(), STALE);
    expect(mutant.pushTarget).toBe("HEAD:254-pr-when-container");
  });

  test("a branch already merged into the base is refused, and the mutant reuses it", () => {
    const real = runBlock(PUSH_TARGET_BLOCK, MERGED);
    expect(real.branchToReuse).toBeNull();
    expect(real.pushTarget).toBe("HEAD");

    const mutant = runBlock(buildMutantBlock(), MERGED);
    expect(mutant.pushTarget).toBe("HEAD:254-pr-when-container");
  });

  test("a nomination whose currency is unknown is refused, and the mutant reuses it", () => {
    // Unmeasured is not clean: a pre-computed nomination from a caller that
    // never took the counts is a push target nobody vouched for.
    const real = runBlock(PUSH_TARGET_BLOCK, UNKNOWN);
    expect(real.branchToReuse).toBeNull();
    expect(real.pushTarget).toBe("HEAD");

    const mutant = runBlock(buildMutantBlock(), UNKNOWN);
    expect(mutant.pushTarget).toBe("HEAD:254-pr-when-container");
  });

  test("a legacy nomination carrying only a bare name is refused", () => {
    // What `parsedArgs.priorBranch` looked like before #185 added the fields.
    const real = runBlock(PUSH_TARGET_BLOCK, { branch: "254-pr-when-container" });
    expect(real.branchToReuse).toBeNull();
    expect(real.pushTarget).toBe("HEAD");
  });

  test("no nomination at all pushes HEAD", () => {
    expect(runBlock(PUSH_TARGET_BLOCK, null).pushTarget).toBe("HEAD");
    expect(runBlock(PUSH_TARGET_BLOCK, { branch: "" }).pushTarget).toBe("HEAD");
  });

  test("the refusal says which branch and why", () => {
    const logs = runBlock(PUSH_TARGET_BLOCK, STALE).logs.join("\n");
    expect(logs).toMatch(/behind/i);
    expect(logs).toContain("8");
  });

  test("the decision has exactly one call site, and it is the push target's", () => {
    const calls = shipSource.split("reusablePriorBranch(").length - 1;
    // One declaration, one call. A second caller would be a second place for
    // the check to be skipped.
    expect(calls).toBe(2);
    expect(shipSource).toContain("const branchToReuse = reusablePriorBranch(priorBranchResult)");
    // The old unconditional assignment must be gone, not merely shadowed.
    expect(shipSource).not.toContain("const branchToReuse = priorBranchResult?.branch || null");
  });

  test("ship.js still parses as a workflow script", () => {
    const src = shipSource.replace(/^export /gm, "");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction("args", src)).not.toThrow();
  });
});

describe("ship.js: the dead testsPass resume pairing is gone (#185)", () => {
  const precompute = readFileSync(join(REPO_ROOT, "scripts", "precompute-goal.ts"), "utf-8");

  test("no branch of ship.js reads the resume signal", () => {
    expect(shipSource).not.toContain("priorBranchResult?.testsPass");
    expect(shipSource).not.toContain("testsPass");
    expect(shipSource).not.toContain("Skipping Implement phase");
  });

  test("every detection call site asks for detection without running the suite", () => {
    // The pairing is what made the resume branch dead: `testsPass` can only be
    // true when `runTests` is, and nothing asks for that.
    // Lazy to the closing `})`, not to the first `}` — the call sites live
    // inside template literals and `${ISSUE}` would end the match early,
    // leaving a fragment that trivially fails to mention runTests.
    const callSites = (src: string) =>
      [...src.matchAll(/detectPriorBranch\(\{[\s\S]*?\}\)/g)].map(m => m[0]);

    const sites = callSites(shipSource);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) expect(site).toMatch(/runTests\s*:\s*false/);

    const precomputeSites = callSites(precompute);
    expect(precomputeSites.length).toBeGreaterThanOrEqual(1);
    for (const site of precomputeSites) expect(site).toMatch(/runTests\s*:\s*false/);
  });

  test("the worktree Quinn validates is the one the implementation ran in", () => {
    // The ternary's other arm was PROJECT_ROOT, reachable only from the dead
    // resume branch.
    expect(shipSource).toContain(
      "const marcusWorktreePath = implementResult.buildResult?.worktreePath || PROJECT_ROOT",
    );
  });
});

describe("ship.js: currency survives the trip through the workflow (#185)", () => {
  test("the pre-computed nomination carries the currency fields", () => {
    // A field the transport drops is a field the push-target check reads as
    // unknown, which would make every pre-computed run stop reusing branches.
    const block = shipSource.slice(
      shipSource.indexOf("let priorBranchResult = parsedArgs.priorBranch"),
      shipSource.indexOf("// ──── PUSH-TARGET-CURRENCY-START ────"),
    );
    for (const field of ["behindCount", "isBehind", "isMerged"]) {
      expect(block).toContain(field);
    }
  });

  test("precompute-goal.ts reports the currency fields it detected", () => {
    const precompute = readFileSync(join(REPO_ROOT, "scripts", "precompute-goal.ts"), "utf-8");
    for (const field of ["behindCount", "isBehind", "isMerged"]) {
      expect(precompute).toContain(field);
    }
  });
});
