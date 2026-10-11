import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { stripJsComments } from "../lib/strip-js-comments";

/**
 * workflows/ship.js — a skipped scope gate says SKIPPED, and a scope gate that
 * ran says what it returned (#276).
 *
 * The initialiser WAS the skipped value: `let scopeResult = { result: 'PASS' }`
 * at ship.js:1798, reported at :1821 and :1831 as
 * `scopeResult?.result || 'SKIPPED'`. Over the four reachable states that
 * reads never-ran → PASS, ran-PASS → PASS, ran-FAIL → FAIL, ran-nothing →
 * SKIPPED. The two words are swapped: every LIGHT run in this repo's history
 * printed `Scope: PASS` without a scope gate ever being spawned, and the one
 * state that genuinely measured nothing — the agent produced no reply — was
 * the only one that admitted it.
 *
 * Same fix as #173 took for Quinn 430 lines below: an observed `ran` boolean
 * instead of an initialiser, an unrecognised reply treated as FAIL rather than
 * PASS, and the chooser inside markers so this file can EXECUTE it. Every
 * source-text assertion in this repo has survived its first mutation
 * (.claude/rules/checks-must-be-able-to-fail.md), so the four states are run
 * through the real block, and the four report sites are run by executing the
 * Scope phase itself rather than by matching its text.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const SHIP = readFileSync(SHIP_PATH, "utf-8");
/**
 * ship.js with its comments blanked, offsets preserved (#273).
 *
 * The enumeration below searches for a declaration, and a docblock quoting the
 * declaration it removed is prose, not a declaration. Caught on this very
 * change: the first draft's comment contained the old initialiser verbatim and
 * the enumeration dutifully reported it as a live candidate.
 */
const SHIP_CODE = stripJsComments(SHIP);

const START_MARKER = "// ──── SCOPE-VERDICT-START ────";
const END_MARKER = "// ──── SCOPE-VERDICT-END ────";

/** The Scope phase, from its first statement to the step after the DRY_RUN exit. */
const BLOCK_START = "phase('Scope')";
const BLOCK_END = "// Prior branch detection";

/**
 * The pre-#276 source, rebuilt from the real file.
 *
 * Two edits, because the defect was the pair: the initialiser that doubles as
 * the skipped value, and the report expression that reads it. Either one
 * failing to match aborts the file rather than producing a mutant that differs
 * from the real source in no way — a mutation harness that silently no-ops
 * when its target moves is the decorative check this repo keeps rediscovering.
 */
function restorePassInitialiser(source = SHIP): string {
  const edits: Array<[RegExp, string]> = [
    [/let scopeResult = null\b/, "let scopeResult = { result: 'PASS' }"],
    [/scopeVerdictFor\(scopeRan, scopeResult\)/, "(scopeResult?.result || 'SKIPPED')"],
  ];
  let out = source;
  for (const [find, replace] of edits) {
    const next = out.replace(find, replace);
    if (next === out) {
      throw new Error(
        `could not build the "PASS initialiser restored" mutant: ${find} no longer ` +
          `matches workflows/ship.js, so this test proves nothing`,
      );
    }
    out = next;
  }
  return out;
}

/** The verdict chooser, extracted from its markers and executed. */
function loadScopeVerdict(source = SHIP): (ran: boolean, result: unknown) => string {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  expect(start, "ship.js is missing the SCOPE-VERDICT markers").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(`${source.slice(start, end)}\nreturn scopeVerdictFor`)();
}

type PhaseRun = {
  /** Everything the phase printed through log(). */
  logs: string[];
  /** What the phase returned — a status object, or CONTINUED if it fell through. */
  returned: any;
  /** How many times the scope gate was actually spawned. */
  gateCalls: number;
};

/**
 * Run ship.js's Scope phase for real, with its collaborators stubbed.
 *
 * The phase is sliced out of the file and executed, not matched: the operator
 * log line and the DRY_RUN payload field are two separate report sites, and a
 * grep for either one says nothing about which of the four states produced it.
 * Every free identifier the block uses is a named parameter, so a block that
 * grows a new dependency throws a ReferenceError here rather than quietly
 * reading `undefined`.
 */
async function runScopePhase(opts: {
  tier: string;
  /** What the scope gate returns when it is spawned. Default: nothing at all. */
  gate?: () => unknown;
  dryRun?: boolean;
  source?: string;
}): Promise<PhaseRun> {
  const source = opts.source ?? SHIP;
  const a = source.indexOf(BLOCK_START);
  const b = source.indexOf(BLOCK_END, a);
  if (a === -1 || b <= a) {
    throw new Error(
      "could not find the Scope phase in workflows/ship.js between " +
        `${BLOCK_START} and ${BLOCK_END}, so this test proves nothing`,
    );
  }
  const block = source.slice(a, b);

  const logs: string[] = [];
  let gateCalls = 0;
  const fn = new Function(
    "phase",
    "log",
    "discovery",
    "runGateWithHeal",
    "DRY_RUN",
    "ISSUE",
    "SLUG",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    "WORK_DIR",
    "testCommand",
    "testTimeout",
    "shellQuote",
    `return (async () => {\n${block}\nreturn { status: 'CONTINUED' }\n})()`,
  );

  const returned = await fn(
    () => {},
    (m: unknown) => logs.push(String(m)),
    {
      ceremonyTier: opts.tier,
      sizing: "S",
      acs: [{ id: "AC-1", type: "CODE", statement: "s" }],
      priorWork: { explicitCommits: [], acStatus: [] },
    },
    async () => {
      gateCalls++;
      return opts.gate ? opts.gate() : undefined;
    },
    opts.dryRun ?? false,
    276,
    "pai-harness-276",
    "/project",
    "/harness",
    "/work",
    "bun test",
    300000,
    (s: string) => `'${s}'`,
  );

  return { logs, returned, gateCalls };
}

describe("#276: the four reachable states of the scope gate", () => {
  test("the extracted chooser reports SKIPPED, PASS, FAIL, FAIL in that order", () => {
    const scopeVerdictFor = loadScopeVerdict();
    expect([
      scopeVerdictFor(false, { result: "PASS" }),
      scopeVerdictFor(true, { result: "PASS" }),
      scopeVerdictFor(true, { result: "FAIL" }),
      scopeVerdictFor(true, undefined),
    ]).toEqual(["SKIPPED", "PASS", "FAIL", "FAIL"]);
  });

  test("a gate that ran but said nothing usable is not a pass and is not a skip", () => {
    // The positive control for the row above: returning 'PASS' for everything
    // satisfies two of its four entries, and returning 'SKIPPED' for the
    // unusable replies would put the run back where #276 found it — unable to
    // tell a gate nobody spawned from a gate that answered with nothing.
    const scopeVerdictFor = loadScopeVerdict();
    for (const reply of [undefined, null, {}, { result: "MAYBE" }, { result: "SKIPPED" }, "PASS"]) {
      const v = scopeVerdictFor(true, reply);
      expect(v, `${JSON.stringify(reply)} was read as a verdict`).toBe("FAIL");
    }
    expect(scopeVerdictFor(false, undefined)).toBe("SKIPPED");
  });

  test("the markers appear exactly once each, so there is one chooser to extract", () => {
    expect(SHIP.split(START_MARKER).length - 1).toBe(1);
    expect(SHIP.split(END_MARKER).length - 1).toBe(1);
  });
});

describe("#276: what the run reports when the scope gate never ran", () => {
  test("the operator log says SKIPPED, and never PASS", async () => {
    const r = await runScopePhase({ tier: "LIGHT" });
    expect(r.gateCalls, "the scope gate was spawned on a LIGHT run").toBe(0);
    expect(r.logs).toContain("Scope: SKIPPED");
    expect(r.logs).not.toContain("Scope: PASS");
  });

  test("the dry-run payload says SKIPPED, and never PASS", async () => {
    const r = await runScopePhase({ tier: "LIGHT", dryRun: true });
    expect(r.gateCalls).toBe(0);
    expect(r.returned.status).toBe("DRY_RUN_COMPLETE");
    expect(r.returned.scopeResult).toBe("SKIPPED");
    expect(r.returned.scopeResult).not.toBe("PASS");
  });

  test("a gate that ran and passed still reports PASS at both sites", async () => {
    // Without this the fix is satisfied by reporting SKIPPED unconditionally.
    const r = await runScopePhase({
      tier: "STANDARD",
      dryRun: true,
      gate: () => ({ result: "PASS" }),
    });
    expect(r.gateCalls).toBe(1);
    expect(r.logs).toContain("Scope: PASS");
    expect(r.returned.scopeResult).toBe("PASS");
  });
});

describe("#276: restoring the PASS initialiser, built and observed here", () => {
  test("MUTANT: the skipped run's operator log goes back to PASS", async () => {
    const mutant = restorePassInitialiser();
    const real = await runScopePhase({ tier: "LIGHT" });
    const mutated = await runScopePhase({ tier: "LIGHT", source: mutant });

    expect(real.logs).toContain("Scope: SKIPPED");
    expect(mutated.logs, "the mutant did not reintroduce #276").toContain("Scope: PASS");
    expect(mutated.logs).not.toContain("Scope: SKIPPED");
  });

  test("MUTANT: the skipped run's dry-run payload goes back to PASS", async () => {
    const mutant = restorePassInitialiser();
    const real = await runScopePhase({ tier: "LIGHT", dryRun: true });
    const mutated = await runScopePhase({ tier: "LIGHT", dryRun: true, source: mutant });

    expect(real.returned.scopeResult).toBe("SKIPPED");
    expect(mutated.returned.scopeResult, "the mutant did not reintroduce #276").toBe("PASS");
  });

  test("MUTANT: the state the old code called SKIPPED was the one that measured nothing", async () => {
    // The swap, from the other side. On the mutant a gate that ran and
    // returned nothing reports SKIPPED and the run continues; on the real
    // source that is a FAIL and the run refuses.
    const mutant = restorePassInitialiser();
    const mutated = await runScopePhase({ tier: "STANDARD", source: mutant });
    expect(mutated.gateCalls).toBe(1);
    expect(mutated.logs).toContain("Scope: SKIPPED");
    expect(mutated.returned.status).toBe("CONTINUED");

    const real = await runScopePhase({ tier: "STANDARD" });
    expect(real.returned.status).toBe("SCOPE_FAILED");
  });
});

describe("#276: the early return reads the computed verdict", () => {
  test("a genuine FAIL refuses the run before the operator log", async () => {
    const r = await runScopePhase({
      tier: "STANDARD",
      gate: () => ({ result: "FAIL", failures: ["AC-2 has no evidence command"] }),
    });
    expect(r.gateCalls).toBe(1);
    expect(r.returned.status).toBe("SCOPE_FAILED");
    expect(r.returned.failures).toContain("AC-2 has no evidence command");
    expect(r.logs).not.toContain("Scope: FAIL");
  });

  test("a gate that ran and reported nothing refuses too, and says so", async () => {
    const r = await runScopePhase({ tier: "STANDARD", gate: () => undefined });
    expect(r.gateCalls).toBe(1);
    expect(r.returned.status).toBe("SCOPE_FAILED");
    expect(Array.isArray(r.returned.failures)).toBe(true);
    expect(r.returned.failures.length).toBeGreaterThan(0);
  });

  test("exactly one call site gates SCOPE_FAILED on the computed verdict", () => {
    const sites = SHIP.split("if (scopeVerdict === 'FAIL') return { status: 'SCOPE_FAILED'").length - 1;
    expect(sites).toBe(1);
    // The old guard read the raw reply, which is how an absent result walked past it.
    expect(SHIP).not.toMatch(/if \(scopeResult\?\.result === 'FAIL'\)/);
  });
});

describe("#276: no other phase initialises a result to PASS to mean 'did not run'", () => {
  /** Names of `let xResult = { result: 'PASS' }` declarations with no `let xRan = false`. */
  function unpairedPassInitialisers(source: string): string[] {
    const names = [...source.matchAll(/let (\w+?)Result = \{ result: 'PASS' \}/g)].map(m => m[1]);
    return names.filter(n => !new RegExp(`let ${n}Ran = false`).test(source));
  }

  test("every PASS-initialised result variable is paired with an observed-ran boolean", () => {
    const names = [...SHIP_CODE.matchAll(/let (\w+?)Result = \{ result: 'PASS' \}/g)].map(m => m[1]);
    // Vacuity guard: an enumeration that finds nothing proves nothing. Today
    // quinnLocalResult is the one legitimate instance — it is paired.
    expect(names, "the enumeration found no candidates at all").toEqual(["quinnLocal"]);
    expect(unpairedPassInitialisers(SHIP_CODE)).toEqual([]);
  });

  test("the enumeration catches an unpaired one", () => {
    // The negative control for the row above, which otherwise passes because
    // of what it never looked at.
    const planted = SHIP_CODE.replace(
      /let scopeResult = null\b/,
      "let somethingResult = { result: 'PASS' }\nlet scopeResult = null",
    );
    expect(planted, "the plant did not apply").not.toBe(SHIP_CODE);
    expect(unpairedPassInitialisers(planted)).toEqual(["something"]);
  });

  test("a declaration quoted in a comment is not a candidate", () => {
    // #273's shape, which this enumeration walked into on its first draft.
    const planted = SHIP.replace(
      /let scopeResult = null\b/,
      "// let somethingResult = { result: 'PASS' }\nlet scopeResult = null",
    );
    expect(planted, "the plant did not apply").not.toBe(SHIP);
    expect(unpairedPassInitialisers(planted)).toEqual(["something"]);
    expect(unpairedPassInitialisers(stripJsComments(planted))).toEqual([]);
  });
});
