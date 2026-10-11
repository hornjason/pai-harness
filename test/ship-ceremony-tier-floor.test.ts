import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { ReachabilityRefusal, assertMarkedBlockReachable } from "../lib/reachability";
import { markerRegion, one } from "./helpers/consumer-ship-sites";

/**
 * workflows/ship.js — a project that DECLARES pages cannot run below STANDARD,
 * whatever size the discovery agent gave the issue (#215).
 *
 * The only code that touched `discovery.ceremonyTier` was a one-way DOWNGRADE:
 * `if (!hasUI && tier !== 'LIGHT') tier = 'LIGHT'`. `hasUI === true` never
 * raised anything, so a UI project whose issue the discovery LLM sized XS ran
 * LIGHT — no scope gate, no Quinn local, no Quinn verify, no container verify,
 * no prove — and still reported DONE.
 *
 * Nothing here matches source text for the behaviour it claims. The floor is
 * extracted from its markers and RUN against a table of (tier, hasUI) pairs,
 * and ship.js's own tier statements — the `hasUI` computation, the existing
 * downgrade, the floor call and the raise — are extracted and EXECUTED
 * together IN SOURCE ORDER, because `.claude/rules/checks-must-be-able-to-fail.md`
 * records that every source-text assertion in this repo survived its first
 * mutation.
 *
 * Reachability is asserted separately and for a specific reason: the mutation
 * that defeated BLOCKING-GRADES, SECURITY-DECISION and COMMIT-STATE-GUARD on
 * 2026-10-08 wraps the whole region in `if (false)` with the wrapper placed
 * OUTSIDE the marker comments, which leaves every extraction here
 * byte-identical and every execution green over a block that never runs.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

const MARKER = "CEREMONY-TIER-FLOOR";
const START = `// ──── ${MARKER}-START ────`;
const END = `// ──── ${MARKER}-END ────`;

// ── extraction ───────────────────────────────────────────────

/**
 * `one()` and `markerRegion()` come from `test/helpers/consumer-ship-sites.ts`
 * so that the repo has ONE extractor over ship.js rather than one per suite
 * (#274). Exactly-once is the point rather than a convenience: a second copy of
 * any of these sites would survive the mutations below and leave a mutant red
 * for a reason unconnected to the mutation working.
 */

/**
 * The tier statements, each anchored to a whole line (or to a whole brace-closed
 * block starting at column zero).
 */
const SITES = {
  hasUI: /^const hasUI = Object\.keys\(pagesConfig\)\.length > 0$/m,
  downgrade: /^if \(!hasUI && discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m,
  floorCall: /^const flooredTier = ceremonyTierFloor\(discovery\.ceremonyTier, hasUI\)$/m,
  raise: /^if \(flooredTier !== discovery\.ceremonyTier\) \{[\s\S]*?\n\}$/m,
};

function floorBlock(source: string): string {
  return markerRegion(source, MARKER);
}

/** The floor chooser, extracted from its markers and executed. */
function loadFloor(source = shipSource): (tier: string, hasUI: boolean) => string {
  return new Function(`${floorBlock(source)}\nreturn ceremonyTierFloor`)();
}

type TierOutcome = { tier: string; logs: string[] };

/**
 * ship.js's own ceremony-tier statements, run IN SOURCE ORDER over a planted
 * discovery tier and a planted pages config.
 *
 * This is not a model of the phase — every executed line is lifted verbatim
 * from `workflows/ship.js`. The only lines this file contributes are the ones
 * standing in for `discovery`, `pagesConfig` and `log`, none of which can be
 * run here.
 *
 * Source order is the point and not an implementation detail (SC-677): a fixed
 * assembly order would apply the floor before the downgrade no matter where
 * ship.js put them, and the downgrade overwriting the floor is exactly the
 * regression this has to be able to see.
 */
function runTierBlock(
  source: string,
  opts: { tier: string; pages: Record<string, unknown> },
): TierOutcome {
  const parts: Array<{ index: number; code: string }> = [
    { index: source.indexOf(START), code: floorBlock(source) },
  ];
  for (const [key, label] of [
    ["hasUI", "the hasUI computation"],
    ["downgrade", "the existing CLI downgrade"],
    ["floorCall", "the floor call"],
    ["raise", "the tier raise"],
  ] as const) {
    const site = one(source, SITES[key], label);
    parts.push({ index: site.index, code: site.text });
  }
  parts.sort((a, b) => a.index - b.index);

  const body = [
    "const logs = []",
    "const log = (m) => { logs.push(String(m)) }",
    "const discovery = { ceremonyTier: tier }",
    "const pagesConfig = pages",
    ...parts.map((p) => p.code),
    "return { tier: discovery.ceremonyTier, logs }",
  ].join("\n");
  return new Function("tier", "pages", body)(opts.tier, opts.pages);
}

const UI_PAGES = { dashboard: "/", settings: "/settings" };

// ── AC-1: the floor is a marked, unambiguous region ──────────

describe("#215 AC-1: the floor is a marked block", () => {
  test("each marker appears exactly once, and the whole name appears exactly twice", () => {
    expect(shipSource.split(`${MARKER}-START`).length - 1).toBe(1);
    expect(shipSource.split(`${MARKER}-END`).length - 1).toBe(1);
    expect(shipSource.split(MARKER).length - 1).toBe(2);
  });

  test("the end marker follows the start marker", () => {
    expect(shipSource.indexOf(END)).toBeGreaterThan(shipSource.indexOf(START));
  });

  test("the block defines the chooser, and nothing calls it before it exists", () => {
    expect(floorBlock(shipSource)).toContain("function ceremonyTierFloor(tier, hasUI)");
    expect(shipSource.indexOf(START)).toBeLessThan(
      shipSource.indexOf("const flooredTier = ceremonyTierFloor(discovery.ceremonyTier, hasUI)"),
    );
  });

  test("a duplicated marker is refused rather than silently sliced", () => {
    const doubled = shipSource.replace(END, `${END}\n${START}\n${END}`);
    expect(() => assertMarkedBlockReachable(doubled, MARKER)).toThrow(/must be unique/);
  });
});

// ── AC-2: the extracted floor, executed ──────────────────────

/**
 * Every (tier, hasUI) pair the chooser can be handed. A UI project is raised to
 * STANDARD and nothing else moves — the floor RAISES, it does not set.
 */
const FLOOR_ROWS = [
  { name: "a UI project sized LIGHT is raised", tier: "LIGHT", hasUI: true, expected: "STANDARD" },
  { name: "a UI project already at STANDARD is left alone", tier: "STANDARD", hasUI: true, expected: "STANDARD" },
  { name: "a UI project at THOROUGH is never lowered", tier: "THOROUGH", hasUI: true, expected: "THOROUGH" },
  { name: "a CLI project at LIGHT stays LIGHT", tier: "LIGHT", hasUI: false, expected: "LIGHT" },
  { name: "a CLI project at STANDARD is not touched by the floor", tier: "STANDARD", hasUI: false, expected: "STANDARD" },
  { name: "a CLI project at THOROUGH is not touched by the floor", tier: "THOROUGH", hasUI: false, expected: "THOROUGH" },
] as const;

describe("#215 AC-2: the floor block is extracted from ship.js and run", () => {
  const ceremonyTierFloor = loadFloor();

  for (const row of FLOOR_ROWS) {
    test(`${row.name}: (${row.tier}, hasUI=${row.hasUI}) → ${row.expected}`, () => {
      expect(ceremonyTierFloor(row.tier, row.hasUI)).toBe(row.expected);
    });
  }

  test("a tier the floor does not recognise is raised rather than trusted", () => {
    // A value outside the enum means the ranking cannot say it is high enough,
    // and "cannot say" must not read as "high enough" for a project with pages.
    for (const unknown of ["", "XS", "light", "UNKNOWN"]) {
      expect(ceremonyTierFloor(unknown, true)).toBe("STANDARD");
    }
  });

  test("an unrecognised tier on a CLI project is still left for the downgrade to handle", () => {
    expect(ceremonyTierFloor("UNKNOWN", false)).toBe("UNKNOWN");
  });

  test("the table has something to look at", () => {
    // Vacuity guard: a chooser that returned undefined for everything would
    // satisfy an empty row list forever.
    expect(FLOOR_ROWS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(FLOOR_ROWS.map((r) => r.expected)).size).toBeGreaterThan(1);
  });
});

// ── AC-3: ship.js's own statements, executed in source order ─

const APPLIED_ROWS = [
  { name: "a UI project the discovery agent sized XS is floored at STANDARD", pages: UI_PAGES, tier: "LIGHT", expected: "STANDARD" },
  { name: "a UI project sized STANDARD stays STANDARD", pages: UI_PAGES, tier: "STANDARD", expected: "STANDARD" },
  { name: "a UI project sized THOROUGH is never lowered", pages: UI_PAGES, tier: "THOROUGH", expected: "THOROUGH" },
  { name: "a genuine CLI project stays LIGHT", pages: {}, tier: "LIGHT", expected: "LIGHT" },
  { name: "the existing downgrade still fires for a CLI project sized STANDARD", pages: {}, tier: "STANDARD", expected: "LIGHT" },
  { name: "the existing downgrade still fires for a CLI project sized THOROUGH", pages: {}, tier: "THOROUGH", expected: "LIGHT" },
] as const;

describe("#215 AC-3: the floor raises only — the downgrade and THOROUGH survive it", () => {
  for (const row of APPLIED_ROWS) {
    test(`${row.name}: pages=${Object.keys(row.pages).length}, ${row.tier} → ${row.expected}`, () => {
      expect(runTierBlock(shipSource, { tier: row.tier, pages: { ...row.pages } }).tier).toBe(row.expected);
    });
  }

  test("the raise is announced to the operator, and only when it happened", () => {
    const raised = runTierBlock(shipSource, { tier: "LIGHT", pages: { ...UI_PAGES } });
    expect(raised.logs.join("\n")).toMatch(/LIGHT.*STANDARD/);
    const untouched = runTierBlock(shipSource, { tier: "STANDARD", pages: { ...UI_PAGES } });
    expect(untouched.logs).toEqual([]);
  });

  test("the floor is not a clamp: nothing is forced to STANDARD unconditionally", () => {
    const ends = APPLIED_ROWS.map((row) => runTierBlock(shipSource, { tier: row.tier, pages: { ...row.pages } }).tier);
    expect(new Set(ends)).toEqual(new Set(["LIGHT", "STANDARD", "THOROUGH"]));
  });
});

// ── AC-4: the block is REACHED, not merely present ───────────

describe("#215 AC-4: the marked block sits somewhere that runs on every run", () => {
  test("its chain of enclosing AST nodes is the module body", () => {
    const chain = assertMarkedBlockReachable(shipSource, MARKER);
    expect(chain[0]).toBe("Program");
    expect(chain).toEqual(["Program"]);
  });
});

// ── AC-6: the mutations, built and observed here ─────────────

/**
 * The 2026-10-08 mutation, verbatim: the whole marked region wrapped in
 * `if (false)`, with the wrapper OUTSIDE the marker comments. Every extraction
 * above still reads byte-identical text, and every execution above still
 * passes, because what changed is where the block sits — not what it says.
 */
function ifFalseMutant(source = shipSource): string {
  const a = source.indexOf(START);
  const b = source.indexOf(END);
  if (a < 0 || b <= a) {
    throw new Error(`could not build the mutant: workflows/ship.js has no ${MARKER} pair to wrap`);
  }
  const close = b + END.length;
  const mutated = `${source.slice(0, a)}if (false) {\n${source.slice(a, close)}\n}\n${source.slice(close)}`;
  if (mutated === source) throw new Error("could not build the mutant: the wrapper changed nothing");
  return mutated;
}

/** The floor stops raising, while every site it lives in stays where it was. */
const FLOOR_RETURN = /return rank < CEREMONY_TIER_RANK\.STANDARD \? 'STANDARD' : tier/g;

function noRaiseMutant(source = shipSource): string {
  const hits = [...source.matchAll(FLOOR_RETURN)].length;
  if (hits !== 1) {
    throw new Error(
      `could not build the mutant: the floor's return (${FLOOR_RETURN}) matched ${hits} times in ` +
        `workflows/ship.js, so this test proves nothing`,
    );
  }
  return source.replace(FLOOR_RETURN, "return tier");
}

describe("#215 AC-6: the if (false) mutation is built and observed here", () => {
  test("the mutant can be built at all, and still parses", () => {
    const mutant = ifFalseMutant();
    expect(mutant).not.toBe(shipSource);
    expect(mutant).toContain("if (false) {");
  });

  test("the wrapper is outside the markers: the marked bytes are untouched", () => {
    // This is what makes the mutation worth running. If the slice changed, the
    // extraction tests above would catch it and reachability would be
    // redundant.
    expect(floorBlock(ifFalseMutant())).toBe(floorBlock(shipSource));
  });

  test("the real source is accepted and the if (false) mutant is REFUSED", () => {
    expect(assertMarkedBlockReachable(shipSource, MARKER)).toEqual(["Program"]);
    expect(() => assertMarkedBlockReachable(ifFalseMutant(), MARKER)).toThrow(ReachabilityRefusal);
  });

  test("the refusal names the construct responsible", () => {
    expect(() => assertMarkedBlockReachable(ifFalseMutant(), MARKER)).toThrow(/IfStatement/);
  });

  test("the mutant builder refuses when the markers are gone", () => {
    expect(() => ifFalseMutant(shipSource.replace(START, "// nothing here"))).toThrow(
      /could not build the mutant/,
    );
  });
});

describe("#215 AC-6: the floor is load-bearing, not decorative", () => {
  test("the no-raise mutant can be built", () => {
    expect(noRaiseMutant()).not.toBe(shipSource);
  });

  test("the mutant ships a UI project at LIGHT where the real source floors it", () => {
    const mutated = runTierBlock(noRaiseMutant(), { tier: "LIGHT", pages: { ...UI_PAGES } });
    const real = runTierBlock(shipSource, { tier: "LIGHT", pages: { ...UI_PAGES } });
    expect(mutated.tier).toBe("LIGHT");
    expect(real.tier).toBe("STANDARD");
  });

  test("the mutant is not a no-op elsewhere: the CLI downgrade still fires in it", () => {
    // Guards the inverse mistake — a mutant that broke everything would make
    // the row above pass for a reason unconnected to the floor.
    const cli = runTierBlock(noRaiseMutant(), { tier: "STANDARD", pages: {} });
    expect(cli.tier).toBe("LIGHT");
  });

  test("the no-raise mutant builder refuses when its target has moved", () => {
    expect(() => noRaiseMutant(shipSource.replace(FLOOR_RETURN, "return tier"))).toThrow(
      /could not build the mutant: the floor's return/,
    );
  });
});
