import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";

/**
 * workflows/ship.js — a skipped scope gate says SKIPPED, and only a gate that
 * ran and passed says PASS (#276).
 *
 * The code this replaces:
 *
 *     let scopeResult = { result: 'PASS' }
 *     if (!skipScope) { scopeResult = await runGateWithHeal('scope', …) }
 *     log(`Scope: ${scopeResult?.result || 'SKIPPED'}`)
 *
 * The initialiser IS the did-not-run value, so the two words were swapped over
 * the four reachable states: never executed → PASS, ran and passed → PASS, ran
 * and failed → FAIL, ran and reported nothing → SKIPPED. Every LIGHT run in
 * this repo's history printed `Scope: PASS` without a scope gate ever running,
 * and the one state that genuinely deserves suspicion — a gate that answered
 * with nothing — was the only one reported as skipped.
 *
 * #173 had already solved this shape 430 lines below, for Quinn: a separate
 * OBSERVED `ran` boolean, an unrecognised reply treated as the failing value,
 * and the logic in a marked block so a test can EXECUTE it. This file follows
 * `test/record-build-commit.test.ts:326-369` and does the same for scope.
 *
 * Nothing here matches source text for the behaviour it claims. The verdict
 * function is extracted from its markers and run; the four reporting sites —
 * the declarations, the verdict computation, the SCOPE_FAILED refusal, the
 * operator log and the dry-run payload field — are extracted from ship.js and
 * EXECUTED together, because `.claude/rules/checks-must-be-able-to-fail.md`
 * records that every source-text assertion in this repo survived its first
 * mutation.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

const START = "// ──── SCOPE-VERDICT-START ────";
const END = "// ──── SCOPE-VERDICT-END ────";

// ── extraction ───────────────────────────────────────────────

/**
 * The one occurrence of `re` in `source`, or a thrown error naming the site.
 *
 * Exactly-once is the point rather than a convenience: a second copy of any of
 * these sites would survive the mutation below and leave the mutant red for a
 * reason unconnected to the mutation working.
 */
function one(source: string, re: RegExp, label: string): { text: string; index: number } {
  const all = [...source.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  if (all.length !== 1) {
    throw new Error(
      `could not locate ${label} in workflows/ship.js: ${re} matched ${all.length} times, ` +
        `so this test proves nothing`,
    );
  }
  return { text: all[0][0], index: all[0].index! };
}

/**
 * The sites #276 changes, each anchored to a whole line.
 *
 * The two reporting sites and the result declaration are matched on their
 * SHAPE, not on the expression they hold, so the mutant below — which changes
 * exactly those expressions — is extracted by the same code the real source
 * is. An anchor spelling out `${scopeVerdict}` would fail to find the mutant's
 * line and the mutation would read as "could not build", which is a different
 * outcome from the one being proved. What they report is asserted by running
 * them, not by matching them.
 */
const SITES = {
  declRan: /^let scopeRan = false$/m,
  declResult: /^let scopeResult = .+$/m,
  gateRan: /^ {2}scopeRan = true$/m,
  verdict: /^const scopeVerdict = scopeVerdictFor\(scopeRan, scopeResult\)$/m,
  refusal: /^if \(scopeVerdict === 'FAIL'\) return \{ status: 'SCOPE_FAILED'.*$/m,
  log: /^log\(`Scope: .+`\)$/m,
  payload: /^ {4}scopeResult: .+,$/m,
};

function verdictBlock(source: string): string {
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a < 0 || b <= a) throw new Error("workflows/ship.js is missing the SCOPE-VERDICT markers");
  return source.slice(a, b);
}

/** The verdict chooser, extracted from its markers and executed. */
function loadScopeVerdict(source = shipSource): (ran: boolean, result: unknown) => string {
  return new Function(`${verdictBlock(source)}\nreturn scopeVerdictFor`)();
}

type ScopeOutcome = { logged: string | null } & (
  | { status: "SCOPE_FAILED"; failures: unknown; workDir: string }
  | { reported: true; payload: { scopeResult: string }; scopeResult: unknown }
);

/**
 * ship.js's own scope statements, run IN SOURCE ORDER over a planted gate
 * outcome.
 *
 * This is not a model of the phase — every executed line is lifted verbatim
 * from `workflows/ship.js`. The only lines this file contributes are the ones
 * standing in for the awaited gate call and for `log`, neither of which can be
 * run here.
 *
 * Source order is the point and not an implementation detail: the statements
 * are sorted by where they appear in the file, so moving the refusal below the
 * operator log changes what this function does. A fixed assembly order would
 * run the refusal first no matter where ship.js put it, and that mutation —
 * run, and green — is why the sort is here.
 *
 * `logged` is captured outside the early return, so a refusal that happened
 * AFTER something was logged is distinguishable from one that happened before.
 */
function runScopeBlock(source: string, opts: { gateRan: boolean; gateResult?: unknown }): ScopeOutcome {
  const parts: Array<{ index: number; code: string }> = [
    { index: source.indexOf(START), code: verdictBlock(source) },
  ];
  for (const [key, label] of [
    ["declRan", "the observed-ran declaration"],
    ["declResult", "the scopeResult declaration"],
    ["verdict", "the verdict computation"],
    ["refusal", "the SCOPE_FAILED refusal"],
    ["log", "the operator log line"],
  ] as const) {
    const site = one(source, SITES[key], label);
    parts.push({ index: site.index, code: site.text });
  }
  // Stands in for `scopeResult = await runGateWithHeal('scope', …)` guarded by
  // `if (!skipScope)`, placed where ship.js sets the observed-ran flag so it
  // sorts into the same position the real gate call occupies.
  const gateSite = one(source, SITES.gateRan, "the observed-ran assignment inside the gate branch");
  parts.push({ index: gateSite.index, code: "if (gateRan) { scopeRan = true; scopeResult = gateResult }" });

  const payload = one(source, SITES.payload, "the dry-run payload field");
  parts.push({
    index: payload.index,
    code: `return { reported: true, scopeResult, payload: { ${payload.text.trim()} } }`,
  });

  parts.sort((a, b) => a.index - b.index);

  const body = [
    "const trace = { logged: null }",
    "const log = (m) => { trace.logged = m }",
    "const WORK_DIR = '/tmp/scope-verdict-test'",
    "const inner = () => {",
    ...parts.map((p) => p.code),
    "}",
    "return { ...inner(), logged: trace.logged }",
  ].join("\n");
  return new Function("gateRan", "gateResult", body)(opts.gateRan, opts.gateResult);
}

function reported(out: ScopeOutcome): { logged: string | null; payload: string } {
  if ("status" in out) throw new Error(`the scope block refused instead of reporting: ${out.status}`);
  return { logged: out.logged, payload: out.payload.scopeResult };
}

// ── the four reachable states ────────────────────────────────

/**
 * Every state the phase can be in. `#276` is a claim about this table and
 * nothing else: before the fix it read PASS, PASS, FAIL, SKIPPED.
 */
const ROWS = [
  { name: "the gate never ran (LIGHT tier)", gateRan: false, gateResult: undefined, verdict: "SKIPPED" },
  { name: "the gate ran and passed", gateRan: true, gateResult: { result: "PASS" }, verdict: "PASS" },
  { name: "the gate ran and failed", gateRan: true, gateResult: { result: "FAIL" }, verdict: "FAIL" },
  { name: "the gate ran and reported nothing", gateRan: true, gateResult: undefined, verdict: "FAIL" },
] as const;

describe("#276 AC-2: the verdict function, extracted and executed", () => {
  test("the four reachable states are SKIPPED, PASS, FAIL, FAIL", () => {
    const scopeVerdictFor = loadScopeVerdict();
    expect(ROWS.map((r) => scopeVerdictFor(r.gateRan, r.gateResult))).toEqual([
      "SKIPPED",
      "PASS",
      "FAIL",
      "FAIL",
    ]);
  });

  test("a gate that never ran is SKIPPED whatever is sitting in the result slot", () => {
    // The precise bug: a value nobody measured must not be reportable. This is
    // the assertion that makes the `ran` argument load-bearing rather than
    // decorative — a function ignoring it and reading the result would pass
    // the row above and fail here.
    const scopeVerdictFor = loadScopeVerdict();
    for (const planted of [{ result: "PASS" }, { result: "FAIL" }, undefined, null]) {
      expect(scopeVerdictFor(false, planted), `${JSON.stringify(planted)} leaked into a skipped run`).toBe(
        "SKIPPED",
      );
    }
  });

  test("a gate that ran but said nothing usable is not a pass", () => {
    // The positive control for the table: returning 'PASS' for everything
    // satisfies one of its four rows, and an unrecognised reply is the state
    // the old code called SKIPPED.
    const scopeVerdictFor = loadScopeVerdict();
    for (const reply of [undefined, null, {}, { result: "MAYBE" }, { result: "SKIPPED" }, "PASS", []]) {
      expect(scopeVerdictFor(true, reply), `${JSON.stringify(reply)} was read as a verdict`).toBe("FAIL");
    }
  });
});

describe("#276 AC-1: what the run reports, executed from ship.js's own lines", () => {
  test("a scope gate that never ran reports SKIPPED at the operator log", () => {
    const { logged } = reported(runScopeBlock(shipSource, { gateRan: false }));
    expect(logged).toBe("Scope: SKIPPED");
  });

  test("a scope gate that never ran reports SKIPPED in the dry-run payload", () => {
    const { payload } = reported(runScopeBlock(shipSource, { gateRan: false }));
    expect(payload).toBe("SKIPPED");
  });

  test("neither reporting site says PASS for a gate that never ran", () => {
    const { logged, payload } = reported(runScopeBlock(shipSource, { gateRan: false }));
    expect(logged).not.toContain("PASS");
    expect(payload).not.toBe("PASS");
  });

  test("a scope gate that never ran leaves no result behind", () => {
    // The initialiser must not be a verdict. Restoring `{ result: 'PASS' }`
    // turns this red on its own, which is what makes the mutation below a
    // mutation of something load-bearing rather than of dead weight.
    const out = runScopeBlock(shipSource, { gateRan: false });
    if ("status" in out) throw new Error("the scope block refused on a skipped gate");
    expect(out.scopeResult).toBeNull();
  });

  test("a scope gate that ran and passed reports PASS at both sites", () => {
    const { logged, payload } = reported(runScopeBlock(shipSource, { gateRan: true, gateResult: { result: "PASS" } }));
    expect(logged).toBe("Scope: PASS");
    expect(payload).toBe("PASS");
  });
});

describe("#276 AC-4: the refusal reads the computed verdict and runs first", () => {
  test("a genuine scope FAIL refuses the run before anything is logged", () => {
    const out = runScopeBlock(shipSource, { gateRan: true, gateResult: { result: "FAIL" } });
    expect(out).toMatchObject({ status: "SCOPE_FAILED" });
    expect(out.logged, "the operator log ran before the refusal").toBeNull();
  });

  test("a gate that ran and reported nothing reaches the refusal as FAIL", () => {
    // Under the old initialiser this state inherited nothing to refuse and
    // fell through to `Scope: SKIPPED`.
    const out = runScopeBlock(shipSource, { gateRan: true, gateResult: undefined });
    expect(out).toMatchObject({ status: "SCOPE_FAILED" });
    expect(out.logged).toBeNull();
  });

  test("exactly one call site gates SCOPE_FAILED on the computed verdict", () => {
    const sites = [...shipSource.matchAll(/if \(scopeVerdict === 'FAIL'\) return \{ status: 'SCOPE_FAILED'/g)];
    expect(sites).toHaveLength(1);
    // A second refusal reading the raw result would reintroduce the fall-through.
    expect(shipSource).not.toMatch(/scopeResult\?\.result === 'FAIL'/);
  });
});

// ── the mutation ─────────────────────────────────────────────

/**
 * `workflows/ship.js` as it was before #276, at the three sites that produced
 * the swap. Each edit must match exactly once; a miss aborts the file rather
 * than letting a mutation that no-ops read as a passing test.
 *
 * All three, because the defect needed all three. With the verdict reporting
 * in place the initialiser is unreachable, and with the initialiser `null` the
 * old `|| 'SKIPPED'` reporting is accidentally right — only the pair prints
 * `Scope: PASS` for a gate nobody ran. That is also why the initialiser is
 * separately pinned by "leaves no result behind" above: restoring it alone
 * turns that test red and leaves every mutant-building test here throwing
 * `could not build the mutant`, so the harness cannot silently no-op when its
 * target moves.
 */
const PRE_FIX_EDITS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/let scopeResult = null/g, "let scopeResult = { result: 'PASS' }", "the PASS initialiser"],
  [
    /log\(`Scope: \$\{scopeVerdict\}`\)/g,
    "log(`Scope: ${scopeResult?.result || 'SKIPPED'}`)",
    "the operator log",
  ],
  [/scopeResult: scopeVerdict,/g, "scopeResult: scopeResult?.result || 'SKIPPED',", "the dry-run payload"],
];

function preFixMutant(source = shipSource): string {
  let mutated = source;
  for (const [find, replace, label] of PRE_FIX_EDITS) {
    const hits = [...mutated.matchAll(find)].length;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: ${label} (${find}) matched ${hits} times in ` +
          `workflows/ship.js, so this test proves nothing`,
      );
    }
    mutated = mutated.replace(find, replace);
  }
  return mutated;
}

describe("#276 AC-3: the mutation, built and observed here", () => {
  test("the pre-#276 mutant prints PASS for a gate that never ran, and the real source does not", () => {
    const mutant = reported(runScopeBlock(preFixMutant(), { gateRan: false }));
    const real = reported(runScopeBlock(shipSource, { gateRan: false }));
    expect(mutant.logged, "the mutation no longer reintroduces the defect").toBe("Scope: PASS");
    expect(real.logged).toBe("Scope: SKIPPED");
  });

  test("the pre-#276 mutant's dry-run payload reports PASS, and the real source does not", () => {
    const mutant = reported(runScopeBlock(preFixMutant(), { gateRan: false }));
    const real = reported(runScopeBlock(shipSource, { gateRan: false }));
    expect(mutant.payload).toBe("PASS");
    expect(real.payload).toBe("SKIPPED");
  });

  test("the mutant differs from the real source on the skipped row and nowhere else", () => {
    // Without this the mutation could be satisfied by a copy that reports PASS
    // for everything, which is a different bug and would not prove this one.
    // The mutant must still refuse a genuine FAIL and still report a genuine
    // PASS — the ONE row it gets wrong is the gate that never ran.
    const mutant = preFixMutant();
    expect(runScopeBlock(mutant, { gateRan: true, gateResult: { result: "FAIL" } })).toMatchObject({
      status: "SCOPE_FAILED",
    });
    expect(reported(runScopeBlock(mutant, { gateRan: true, gateResult: { result: "PASS" } })).logged).toBe(
      "Scope: PASS",
    );
  });

  test("the mutant builder refuses when a site it needs is gone", () => {
    expect(() => preFixMutant(shipSource.replace("let scopeResult = null", "let scopeResult = undefined"))).toThrow(
      /could not build the mutant: the PASS initialiser/,
    );
  });
});

// ── the class, not the instance ──────────────────────────────

/**
 * Every `let xResult = { result: 'PASS' }` in ship.js, and whether an OBSERVED
 * `let xRan = false` sits beside it. Exported shape kept deliberately boring:
 * the enumeration is the check, so it has to be runnable over a planted source
 * as well as the real one.
 */
const PASS_INITIALISER = /^let (\w+?)Result = \{ result: 'PASS' \}$/gm;

function passInitialisers(source: string): string[] {
  return [...source.matchAll(PASS_INITIALISER)].map((m) => m[1]);
}

function unpairedPassInitialisers(source: string): string[] {
  return passInitialisers(source).filter((name) => !new RegExp(`let ${name}Ran = false`).test(source));
}

describe("#276 AC-5: a did-not-run-means-PASS initialiser is never left unpaired", () => {
  test("the enumeration has something to look at", () => {
    // Vacuity guard. An empty match list satisfies "zero unpaired" forever,
    // and would also be what a renamed initialiser looks like.
    expect(passInitialisers(shipSource).length).toBeGreaterThanOrEqual(1);
  });

  test("ship.js has no unpaired did-not-run-means-PASS initialiser", () => {
    expect(unpairedPassInitialisers(shipSource)).toEqual([]);
  });

  test("the enumeration catches one that is planted", () => {
    const planted = `${shipSource}\nlet verifyResult = { result: 'PASS' }\n`;
    expect(unpairedPassInitialisers(planted)).toEqual(["verify"]);
  });

  test("the enumeration accepts a planted one that brings its own observed boolean", () => {
    const planted = `${shipSource}\nlet verifyRan = false\nlet verifyResult = { result: 'PASS' }\n`;
    expect(unpairedPassInitialisers(planted)).toEqual([]);
  });

  test("the enumeration reads code, not prose about code", () => {
    // The self-reference trap, met from the other direction. An unanchored
    // probe counted `let scopeResult = { result: 'PASS' }` inside the docblock
    // that explains why it is gone — a detector wide enough to read a comment
    // as a declaration would report the defect it documents, forever.
    const planted = `${shipSource}\n// what was here: let verifyResult = { result: 'PASS' }\n`;
    expect(passInitialisers(planted)).toEqual(passInitialisers(shipSource));
  });

  test("ship.js's own docblock does not read as a declaration", () => {
    expect(passInitialisers(shipSource)).toEqual(["quinnLocal"]);
  });
});

// ── the markers ──────────────────────────────────────────────

describe("#276 AC-6: the verdict logic is a marked, reachable block", () => {
  test("each marker appears exactly once", () => {
    expect(shipSource.split("SCOPE-VERDICT-START").length - 1).toBe(1);
    expect(shipSource.split("SCOPE-VERDICT-END").length - 1).toBe(1);
    expect(shipSource.indexOf(END)).toBeGreaterThan(shipSource.indexOf(START));
  });

  test("the block sits somewhere that runs on every run", () => {
    const chain = assertMarkedBlockReachable(shipSource, "SCOPE-VERDICT");
    expect(chain[0]).toBe("Program");
  });

  test("a duplicated marker is refused rather than silently sliced", () => {
    const doubled = shipSource.replace(END, `${END}\n${START}\n${END}`);
    expect(() => assertMarkedBlockReachable(doubled, "SCOPE-VERDICT")).toThrow(/must be unique/);
  });

  test("the block defines the chooser and nothing calls it before it exists", () => {
    expect(verdictBlock(shipSource)).toContain("function scopeVerdictFor(ran, result)");
    expect(shipSource.indexOf(START)).toBeLessThan(
      shipSource.indexOf("const scopeVerdict = scopeVerdictFor(scopeRan, scopeResult)"),
    );
  });
});
