/**
 * #935 — FALLOW-1 is dead at 5s with a 30s budget, and reports the corpse as
 * "fallow is not installed".
 *
 * Three defects in one function, and they compound:
 *
 * 1. `runFallowCommand` spawns with `timeout: 30_000`. The `test()` that
 *    calls it passes no timeout, so bun kills the BODY at its 5000ms default.
 *    The spawn is allowed six times longer than the clock that actually
 *    fires, which makes the 30s unreachable — nothing can use it.
 * 2. A killed process has empty stdout, and the empty-stdout branch returns
 *    `null` — the same value `fallowAvailable() === false` returns. So a
 *    timeout is reported as `SKIP … fallow is not installed (not a declared
 *    dependency)`, for a tree where fallow is an exactly-pinned declared
 *    dependency. A reader acting on that goes and declares a dependency that
 *    is already there. `.claude/rules/config-access.md`, *Silent Default
 *    Substitution*, with the operator as the victim.
 * 3. FALLOW-1 runs first and so pays fallow's cold index build alone —
 *    ~1.5s cold against ~455ms warm, measured. It is not FALLOW-1 that is
 *    slow; it is whichever check runs first.
 *
 * Measured on `hornjason/agentgrit` PR #310, a commit changing two markdown
 * files: FALLOW-1 5010ms FAIL, FALLOW-2 1226ms pass, FALLOW-3 410ms pass,
 * FALLOW-4 408ms pass. The three after it finish in a quarter of the time
 * because the first one warmed the cache for them. The same shape produced
 * four red `main` pushes on that repo in one day.
 *
 * ## Why this file is here and not in the consumer
 *
 * agentgrit#311 fixed this in that repo's own test files, and agentgrit#313
 * added a preload that warms fallow once per process. Neither can reach the
 * defect: `test/scaffold-conformity.test.ts` is GENERATED, and the function
 * it calls is in this library. Every scaffolded consumer inherits the
 * unreachable budget and the wrong sentence. This is the half that stops the
 * next consumer inheriting it.
 *
 * ## The reading vocabulary already existed
 *
 * `lib/fallow-availability.ts` has had `FallowUnavailable` since #581, with
 * `not-installed` and `run-failed` as separate kinds and an UNMEASURED
 * notice — and `scripts/generate-code-map.ts` uses it. `lib/conformity.ts`
 * collapses all of it to `null`. #581's own docstring says the fix "landed
 * in the cheap caller and not in the expensive one"; this is the same
 * sentence pointing the other way, two call sites later.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  FALLOW_BUDGET_MS,
  fallowNotInstalled,
  fallowRunFailed,
  fallowTimedOut,
  runFallowJson,
  warmFallow,
  type FallowSpawnResult,
} from "../lib/fallow-availability";
import { structuralCut } from "../lib/source-slice";

const REPO_ROOT = join(import.meta.dir, "..");
const CONFORMITY = readFileSync(join(REPO_ROOT, "lib", "conformity.ts"), "utf-8");
const AVAILABILITY = readFileSync(join(REPO_ROOT, "lib", "fallow-availability.ts"), "utf-8");
const CODE_MAP = readFileSync(join(REPO_ROOT, "scripts", "generate-code-map.ts"), "utf-8");

/** A spawn reading, with only the fields the classifier is allowed to read. */
function spawned(over: Partial<FallowSpawnResult> = {}): FallowSpawnResult {
  return {
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    exitCode: 0,
    exitedDueToTimeout: false,
    ...over,
  } as FallowSpawnResult;
}

/** `runFallowJson` against a planted spawn, with availability forced true. */
function read(over: Partial<FallowSpawnResult>, budgetMs?: number) {
  return runFallowJson<{ total_issues: number }>(REPO_ROOT, ["dead-code"], {
    budgetMs,
    available: () => true,
    spawn: () => spawned(over),
  });
}

const unavailable = (r: ReturnType<typeof read>) =>
  "unavailable" in r ? r.unavailable : null;

describe("#935: the budget is one number, and both clocks read it", () => {
  test("AC-1: the spawn timeout and the per-test timeout come from one constant", () => {
    // Two clocks, one number. The defect is that they were two numbers and
    // only the smaller one fired, so the assertion is not "a timeout is
    // passed" — it is that no caller spells a budget of its own.
    expect(typeof FALLOW_BUDGET_MS, "FALLOW_BUDGET_MS is not a number").toBe("number");
    expect(FALLOW_BUDGET_MS).toBeGreaterThan(5_000);

    const declarations = (AVAILABILITY.match(/export const FALLOW_BUDGET_MS\s*=/g) || []).length;
    expect(declarations, "FALLOW_BUDGET_MS is not declared exactly once").toBe(1);

    // No second numeric budget anywhere a fallow spawn or registration can
    // read one. `30_000` and `30000` are the two spellings the tree had.
    for (const [name, src] of [
      ["lib/conformity.ts", CONFORMITY],
      ["scripts/generate-code-map.ts", CODE_MAP],
    ] as const) {
      expect(src, `${name} still spells a fallow budget of its own`).not.toMatch(
        /timeout:\s*30_?000/,
      );
    }

    // And the spawn itself reads the budget rather than a literal. Without
    // this the two clocks can diverge again inside the one binding — the
    // registrations would still carry the constant, every case above would
    // still pass, and the spawn would be back on a number of its own. Found
    // by reading the cases rather than by a row coming back zero, which is
    // the cheaper of the two routes and the one this file's subject rewards.
    const spawnCall = structuralCut(AVAILABILITY, "const result = spawn(", { balanced: "(" });
    expect(spawnCall, "the spawn does not take its timeout from the budget").toContain(
      "timeout: budgetMs",
    );
    expect(spawnCall, "the spawn spells a budget literal of its own").not.toMatch(/timeout:\s*\d/);
  });

  test("AC-2: every FALLOW registration is given the budget as its test timeout", () => {
    // The whole of the defect, in the position it lives: `test(name, body)`
    // with no third argument is `test(name, body, 5000)`, and no amount of
    // spawn budget reaches it.
    // Anchored on the describe, NOT on `export function runFallowCheck(`.
    // `structuralCut` balances from the anchor's own index, and that
    // signature carries `opts?: { skipUnusedExports?: boolean; … }` — so a
    // signature anchor resolves to the options TYPE, a 103-character cut
    // that is well-formed, non-empty and about something else. Measured
    // here, after the identical trap cost two red runs in #889; it is worth
    // the comment because the next person reaching for a function-signature
    // anchor in a file with a destructured or typed parameter will hit it.
    const block = structuralCut(CONFORMITY, 'describe("Fallow: static analysis"', {
      balanced: "{",
    });
    expect(block.length, "runFallowCheck's body did not slice").toBeGreaterThan(200);

    const registrations = block.match(/test\(\s*"FALLOW-\d/g) || [];
    expect(registrations.length, "the four FALLOW checks are not all registered here").toBe(4);

    // Each registration's own call, cut and checked — asserting the constant
    // appears four times in the block would be satisfied by four uses in one
    // check and none in the others.
    for (const id of ["FALLOW-1", "FALLOW-2", "FALLOW-3", "FALLOW-4"]) {
      const call = structuralCut(block, `test("${id}`, { balanced: "(" });
      expect(call, `${id} is registered without the budget as its timeout`).toContain(
        "FALLOW_BUDGET_MS",
      );
    }
  });
});

describe("#935: a timeout is not an absent tool", () => {
  test("AC-3: a killed run reads as timed-out, not as not-installed", () => {
    const u = unavailable(read({ exitedDueToTimeout: true, exitCode: null }));
    expect(u, "a killed run produced a reading rather than a refusal").not.toBeNull();
    expect(u!.kind).toBe("timed-out");
    expect(u!.kind).not.toBe("not-installed");
    // The sentence has to carry the number an operator would change.
    expect(u!.reason).toContain(String(FALLOW_BUDGET_MS));
  });

  test("AC-4: timed-out is classified BEFORE empty stdout, because a killed run has both", () => {
    // The ordering IS the fix. A killed process writes nothing, so the
    // empty-stdout branch catches every timeout if it is reached first —
    // which is how the live code turns a 30-second hang into "not installed".
    // The fixture therefore sets BOTH conditions, and only the order can
    // decide the answer.
    const both = unavailable(read({ exitedDueToTimeout: true, stdout: Buffer.from("") }));
    expect(both!.kind, "empty stdout won the race against the timeout flag").toBe("timed-out");

    // The control, and it is not decoration: without it a classifier that
    // answered "timed-out" to everything would satisfy the case above, and
    // the fixture would be proving the arm exists rather than that the order
    // is right. An empty reading that was NOT killed is still run-failed.
    const empty = unavailable(read({ exitedDueToTimeout: false, stdout: Buffer.from("") }));
    expect(empty!.kind, "an ordinary empty reading was blamed on the clock").toBe("run-failed");
  });

  test("AC-5: the four outcomes are four distinguishable sentences", () => {
    // #300's property, applied here: the sentence is the entire interface.
    // An operator reads one line and decides whether to install something,
    // raise a budget, or go and look at the tool. Two outcomes sharing a
    // sentence send them to the wrong one.
    const reasons = [
      fallowNotInstalled().reason,
      fallowTimedOut(FALLOW_BUDGET_MS, FALLOW_BUDGET_MS + 7).reason,
      fallowRunFailed("exit 2, no output").reason,
    ];
    expect(new Set(reasons).size, "two outcomes produce the same sentence").toBe(reasons.length);

    // And each names its own cause, not merely a different string. A set of
    // three distinct sentences is satisfied by three ways of saying nothing.
    expect(reasons[0]).toMatch(/not installed/i);
    expect(reasons[1]).toMatch(/budget|timed out/i);
    expect(reasons[2]).toMatch(/did not produce a reading/i);
    // The timeout sentence must not borrow the install sentence's advice.
    expect(reasons[1], "the timeout notice blames the installation").not.toMatch(
      /not installed|not a declared dependency/i,
    );
  });

  test("AC-6: an absent tool is still an absent tool, and a good reading still parses", () => {
    // Both ends of the range, so the classifier cannot pass by refusing
    // everything or by accepting everything.
    const absent = runFallowJson(REPO_ROOT, ["dead-code"], {
      available: () => false,
      spawn: () => {
        throw new Error("the spawn ran for a tool that is not installed");
      },
    });
    expect("unavailable" in absent && absent.unavailable.kind).toBe("not-installed");

    const good = read({ stdout: Buffer.from(JSON.stringify({ total_issues: 3 })) });
    expect("data" in good, "a well-formed reading was refused").toBe(true);
    expect("data" in good && good.data.total_issues).toBe(3);

    // fallow's own error envelope is a run failure, not a reading.
    const envelope = unavailable(read({ stdout: Buffer.from('{"error":"no tsconfig"}') }));
    expect(envelope!.kind).toBe("run-failed");

    const garbage = unavailable(read({ stdout: Buffer.from("not json at all") }));
    expect(garbage!.kind).toBe("run-failed");
  });
});

describe("#935: one spawn, one budget, warmed once", () => {
  test("AC-7: exactly one place in the tree spawns fallow", () => {
    // Two spawns is #621: two positions answering one question with nothing
    // comparing them, and it is not hypothetical here — `conformity.ts` and
    // `generate-code-map.ts` each had their own, each with its own `30_000`,
    // and only one of them classified anything. Mutating either leaves the
    // other spawning.
    const sites: string[] = [];
    for (const [name, src] of [
      ["lib/conformity.ts", CONFORMITY],
      ["lib/fallow-availability.ts", AVAILABILITY],
      ["scripts/generate-code-map.ts", CODE_MAP],
    ] as const) {
      // The literal argv, not the word "fallow" — the word appears in prose
      // throughout all three files, and a detector that cannot tell code from
      // the comment about it is this repo's most-repeated defect (#235).
      const spawns = (src.match(/"npx",\s*"fallow"/g) || []).length;
      for (let i = 0; i < spawns; i++) sites.push(name);
    }
    expect(sites, "fallow is spawned from more than one place").toEqual([
      "lib/fallow-availability.ts",
    ]);
  });

  test("AC-8: the index is warmed before the four checks, not by the first of them", () => {
    const block = structuralCut(CONFORMITY, 'describe("Fallow: static analysis"', {
      balanced: "{",
    });
    const warmAt = block.indexOf("warmFallow(");
    const firstCheckAt = block.indexOf('test("FALLOW-1');
    expect(warmAt, "nothing warms fallow before the checks").toBeGreaterThan(-1);
    expect(firstCheckAt).toBeGreaterThan(-1);
    // Position is the claim: a warm call AFTER the first registration warms
    // nothing that FALLOW-1 can use, and reads identically in a diff.
    expect(
      warmAt,
      "the warm-up is registered after FALLOW-1, so FALLOW-1 still pays the cold start",
    ).toBeLessThan(firstCheckAt);
  });

  test("AC-9: the warm-up actually spawns — once when available, never when not", () => {
    // AC-8 asserts WHERE the call sits. That is satisfied by a `warmFallow`
    // short-circuited to `return`, and the battery measured exactly that: row
    // M7 was 0 of 14. Nothing in this repository could have caught it either,
    // because fallow is not installed here or on CI, so the real function and
    // a no-op both return without spawning. A position is not a behaviour.
    let spawns = 0;
    warmFallow(REPO_ROOT, {
      available: () => true,
      spawn: () => {
        spawns++;
        return spawned({ stdout: Buffer.from(JSON.stringify({ total_issues: 0 })) });
      },
    });
    expect(spawns, "the warm-up did not spawn fallow at all").toBe(1);

    // And it stays off the network when the tool is absent, which is #581's
    // property and the reason this module exists. A warm-up that spawned
    // unconditionally would reintroduce the registry fetch on the scaffold
    // path — once per consumer, forever.
    let absentSpawns = 0;
    warmFallow(REPO_ROOT, {
      available: () => false,
      spawn: () => {
        absentSpawns++;
        return spawned();
      },
    });
    expect(absentSpawns, "the warm-up spawned for a tool that is not installed").toBe(0);
  });
});
