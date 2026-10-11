/**
 * #274 AC-1 / AC-5 — the consumer-UI fixture, and ship.js's tier chain run over it.
 *
 * Every self-run rungate has ever made was rewritten to LIGHT. `.claude/rungate/
 * config.json` declares `"pages": {}`, so `hasUI` is false, so the downgrade at
 * workflows/ship.js fires and five tier-gated subsystems never execute. A
 * consumer that declares pages takes the other branch, and nothing in this repo
 * has ever stood in for one.
 *
 * This file builds that stand-in and proves the tier chain resolves it.
 *
 * Three things make it a measurement rather than a restatement:
 *
 * - The config is loaded through `lib/config-loader.ts`, the loader ship.js's
 *   setup uses. A `JSON.parse` in the test would assert that the fixture file
 *   contains what I typed into it, which is true of any file.
 * - The tier statements are SLICED OUT OF ship.js AND EXECUTED. Asserting that
 *   ship.js "contains ceremonyTierFloor" stays green after the call is reduced
 *   to a comment — the failure mode .claude/rules/checks-must-be-able-to-fail.md
 *   exists for.
 * - The same extracted chain is run twice over inputs that differ in `pages`
 *   alone. Without the second run, an extraction that always returned STANDARD
 *   would look exactly like a tier chain that works.
 *
 * ship.js is resolved from this file's own directory, never from HARNESS_ROOT:
 * under worktree isolation that variable can point at a different checkout than
 * the one being graded (#190).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadRungateConfig, tryLoadRungateConfig } from "../lib/config-loader";
import { WorkflowStateSchema } from "../gates/schema";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "consumer-ui-project");
const SPEC_PATH = join(REPO_ROOT, "specs", "CONFIG-DIRECTORY-STRUCTURE-SPEC.md");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");

const shipSource = readFileSync(SHIP_PATH, "utf-8");

// ── Extraction ───────────────────────────────────────────────────────────
//
// Module scope on purpose. If a statement moves, is reworded, or gains a second
// copy, these throw while the file is LOADING and every test in it fails. A
// harness that silently no-ops when its target moves is the decorative check
// the rules file is about, and "the statement was not found" must never be
// indistinguishable from "the statement passed".

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) throw new Error("countOccurrences: empty needle");
  return haystack.split(needle).length - 1;
}

interface Slice {
  /** The name AC-1 gives this statement. */
  name: string;
  /** Verbatim source text, executable as-is. */
  text: string;
  /** Byte offset in ship.js, so source order is derived rather than assumed. */
  index: number;
}

/**
 * A single statement, anchored on its own text.
 *
 * `occurrences !== 1` throws: a second copy means the mutation proofs below
 * could silently exercise the wrong one, and zero copies means the chain has
 * moved and nothing here is measuring ship.js any more.
 */
function statementSlice(source: string, name: string, literal: string): Slice {
  const n = countOccurrences(source, literal);
  if (n !== 1) {
    throw new Error(
      `could not extract the tier chain: the ${name} statement appears ${n} times in workflows/ship.js (expected exactly 1)`,
    );
  }
  return { name, text: literal, index: source.indexOf(literal) };
}

/**
 * A braced block, anchored on its header line and closed by brace matching.
 *
 * Brace matching rather than a line count: the log lines inside these blocks
 * are reworded often, and a slice that stops at a fixed offset would start
 * executing half a statement without saying so.
 */
function blockSlice(source: string, name: string, header: string): Slice {
  const n = countOccurrences(source, header);
  if (n !== 1) {
    throw new Error(
      `could not extract the tier chain: the ${name} block header appears ${n} times in workflows/ship.js (expected exactly 1)`,
    );
  }
  const start = source.indexOf(header);
  const open = source.indexOf("{", start + header.length - 1);
  if (open === -1) throw new Error(`the ${name} block header has no opening brace`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return { name, text: source.slice(start, i + 1), index: start };
      }
    }
  }
  throw new Error(`the ${name} block is never closed`);
}

/** `ceremonyTierFloor`'s definition, taken from its own markers in ship.js. */
function floorRegion(source: string): Slice {
  const START = "// ──── CEREMONY-TIER-FLOOR-START ────";
  const END = "// ──── CEREMONY-TIER-FLOOR-END ────";
  const a = countOccurrences(source, START);
  const b = countOccurrences(source, END);
  if (a !== 1 || b !== 1) {
    throw new Error(
      `workflows/ship.js has ${a} CEREMONY-TIER-FLOOR-START and ${b} CEREMONY-TIER-FLOOR-END markers (expected 1 of each)`,
    );
  }
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (end <= start) throw new Error("the CEREMONY-TIER-FLOOR markers are out of order");
  const text = source.slice(start, end + END.length);
  if (!text.includes("function ceremonyTierFloor(")) {
    throw new Error("the CEREMONY-TIER-FLOOR region no longer defines ceremonyTierFloor");
  }
  return { name: "ceremonyTierFloor definition", text, index: start };
}

/**
 * The four statements AC-1 names. `pagesConfig` and `hasUI` are one anchor
 * because they are one computation: splitting them would let the test supply
 * its own `pagesConfig` and never read the loaded config at all.
 */
const HAS_UI_COMPUTATION =
  "const pagesConfig = projectConfig.pages || parsedArgs.pages || {}\n" +
  "const hasUI = Object.keys(pagesConfig).length > 0";
const DOWNGRADE_HEADER = "if (!hasUI && discovery.ceremonyTier !== 'LIGHT') {";
const FLOOR_CALL = "const flooredTier = ceremonyTierFloor(discovery.ceremonyTier, hasUI)";
const RAISE_HEADER = "if (flooredTier !== discovery.ceremonyTier) {";

function tierStatements(source: string): Slice[] {
  return [
    statementSlice(source, "hasUI computation", HAS_UI_COMPUTATION),
    blockSlice(source, "!hasUI downgrade", DOWNGRADE_HEADER),
    statementSlice(source, "ceremonyTierFloor call", FLOOR_CALL),
    blockSlice(source, "raise", RAISE_HEADER),
  ];
}

const STATEMENTS = tierStatements(shipSource);

/**
 * The executable chain: the four statements plus the function the third one
 * calls, concatenated in the order their offsets put them in. Sorting by the
 * measured offset is what makes "in source order" a reading of ship.js rather
 * than a claim about the array literal above.
 */
function chainSource(source: string): string {
  const pieces = [...tierStatements(source), floorRegion(source)].sort((a, b) => a.index - b.index);
  return pieces.map((p) => p.text).join("\n");
}

const CHAIN_SOURCE = chainSource(shipSource);

// ── Execution ────────────────────────────────────────────────────────────

interface ChainOutcome {
  tier: string;
  hasUI: boolean;
  pageCount: number;
  logs: string[];
}

/**
 * Run the extracted chain over one config.
 *
 * `with` over a Proxy rather than a parameter list: the slices declare names
 * with `const`, and a parameter of the same name is a SyntaxError. Names the
 * sandbox does not carry fall through to the real globals, so `Object` still
 * resolves.
 */
function runTierChain(
  projectConfig: unknown,
  discoveryTier: string | undefined,
  chain: string = CHAIN_SOURCE,
): ChainOutcome {
  const logs: string[] = [];
  const discovery: { ceremonyTier: string | undefined } = { ceremonyTier: discoveryTier };
  const scope: Record<string, unknown> = {
    projectConfig,
    parsedArgs: {},
    discovery,
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
    `return (function () { with (__scope__) {
${chain}
return { tier: discovery.ceremonyTier, hasUI, pageCount: Object.keys(pagesConfig).length }
} })()`,
  );
  const out = factory(sandbox) as { tier: string; hasUI: boolean; pageCount: number };
  return { ...out, logs };
}

// ── The fixture, read back through the harness's own readers ─────────────

/** `lib/config-loader.ts` — the loader ship.js's setup phase uses. */
const fixtureConfig = loadRungateConfig(FIXTURE_ROOT);

/** The same object, keyed loosely, for the documented-shape checks below. */
const fixtureRaw = fixtureConfig as unknown as Record<string, unknown>;

/** `gates/schema.ts` — the validator every workflow-state write goes through. */
const fixtureState = WorkflowStateSchema.passthrough().parse(
  JSON.parse(readFileSync(join(FIXTURE_ROOT, "workflow-state.json"), "utf-8")),
);

describe("#274 AC-1: the consumer fixture loads through the harness's own readers", () => {
  test("the fixture is on the CONSUMER form: a monolith, with no config.json to shadow it", () => {
    // D-2's fallback is not a legacy path, it is the shape every consumer uses.
    // Asserting the directory marker is absent is what proves the monolith
    // branch is the one that ran — otherwise this test would pass for a fixture
    // that had quietly been migrated to the directory form.
    expect(existsSync(join(FIXTURE_ROOT, ".claude", "rungate", "config.json"))).toBe(false);
    expect(existsSync(join(FIXTURE_ROOT, ".claude", "rungate.json"))).toBe(true);
    expect(tryLoadRungateConfig(FIXTURE_ROOT)).not.toBeNull();
  });

  test("the loaded config declares four distinct pages", () => {
    const pages = fixtureConfig.pages as Record<string, string>;
    expect(typeof pages).toBe("object");
    const routes = Object.keys(pages);
    expect(routes.length).toBe(4);
    // Distinct routes, non-empty names: three copies of one entry is one page
    // wearing a count, and ship.js's `hasUI` would read it as three.
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) {
      expect(route.startsWith("/")).toBe(true);
      expect(String(pages[route]).length).toBeGreaterThan(0);
    }
  });

  test("the fixture declares the other three facts the tier-gated sites need", () => {
    // Four config facts, not one. A fixture setting only a non-empty `pages`
    // map raises the tier and still executes THREE of five subsystems silently:
    // container verify also needs `container`, prove also needs a UI-shaped AC,
    // and the pre-flight needs a remote host.
    const container = fixtureRaw.container as Record<string, unknown>;
    expect(container).toBeDefined();
    expect(Array.isArray(container.hosts)).toBe(true);
    expect((container.hosts as unknown[]).length).toBeGreaterThan(0);
    expect(typeof container.port).toBe("number");

    const remoteHosts = fixtureRaw.remoteHosts as Record<string, { host?: string }>;
    expect(Object.keys(remoteHosts ?? {}).length).toBeGreaterThan(0);

    const uiACs = (fixtureState.acs ?? []).filter(
      (ac) =>
        ac.type === "OUTCOME" ||
        ac.evidenceMethod?.type === "PLAYWRIGHT" ||
        ac.evidenceMethod?.type === "SCREENSHOT",
    );
    expect(uiACs.length).toBeGreaterThan(0);
  });

  test("the fixture workflow-state reads back as XS / LIGHT", () => {
    expect(fixtureState.sizing?.predicted).toBe("XS");
    expect(fixtureState.sizing?.ceremonyTier).toBe("LIGHT");
  });

  test("the workflow-state reader is load-bearing — a bad tier is refused, not passed through", () => {
    // Without this, `WorkflowStateSchema.parse` could have been replaced by the
    // identity function and the test above would be unchanged.
    const raw = JSON.parse(readFileSync(join(FIXTURE_ROOT, "workflow-state.json"), "utf-8"));
    raw.sizing.ceremonyTier = "CEREMONIAL";
    expect(() => WorkflowStateSchema.passthrough().parse(raw)).toThrow();
  });
});

describe("#274 AC-1: ship.js's four tier statements, located once and executed", () => {
  test("each of the four statements appears exactly once in workflows/ship.js", () => {
    expect(countOccurrences(shipSource, HAS_UI_COMPUTATION)).toBe(1);
    expect(countOccurrences(shipSource, DOWNGRADE_HEADER)).toBe(1);
    expect(countOccurrences(shipSource, FLOOR_CALL)).toBe(1);
    expect(countOccurrences(shipSource, RAISE_HEADER)).toBe(1);
    expect(STATEMENTS.map((s) => s.name)).toEqual([
      "hasUI computation",
      "!hasUI downgrade",
      "ceremonyTierFloor call",
      "raise",
    ]);
  });

  test("the extracted statements are assembled in source order", () => {
    const offsets = STATEMENTS.map((s) => s.index);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    // And the assembled chain preserves that order verbatim.
    let cursor = -1;
    for (const s of STATEMENTS) {
      const at = CHAIN_SOURCE.indexOf(s.text);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("a second copy of any statement aborts extraction rather than passing", () => {
    // The mutation this file's correctness rests on, performed and observed.
    // A duplicated statement is the case where "exactly one" silently becomes
    // "the first one I happened to find".
    for (const literal of [HAS_UI_COMPUTATION, DOWNGRADE_HEADER, FLOOR_CALL, RAISE_HEADER]) {
      const doubled = shipSource + "\n" + literal + "\n";
      expect(() => chainSource(doubled)).toThrow(/appears 2 times/);
    }
  });

  test("a renamed statement aborts extraction rather than passing", () => {
    const renamed = shipSource.replace(
      FLOOR_CALL,
      "const flooredTier = ceremonyFloor(discovery.ceremonyTier, hasUI)",
    );
    expect(renamed).not.toBe(shipSource);
    expect(() => chainSource(renamed)).toThrow(/appears 0 times/);
  });

  test("the chain resolves the fixture's XS/LIGHT discovery to STANDARD", () => {
    const out = runTierChain(fixtureConfig, fixtureState.sizing?.ceremonyTier);
    expect(out.hasUI).toBe(true);
    expect(out.pageCount).toBe(Object.keys(fixtureConfig.pages as object).length);
    expect(out.tier).toBe("STANDARD");
    expect(out.logs.join("\n")).toContain(`${out.pageCount} pages declared`);
    expect(out.logs.join("\n")).toContain("LIGHT → STANDARD");
  });

  test("the chain raises and never lowers — a THOROUGH discovery keeps THOROUGH", () => {
    const out = runTierChain(fixtureConfig, "THOROUGH");
    expect(out.tier).toBe("THOROUGH");
  });
});

/**
 * Each statement removed from the assembled chain, one at a time, and the run
 * re-executed. Without these, "the chain resolves to STANDARD" would stay green
 * if the resolution came from anywhere other than the statements this file
 * claims to be measuring — a hardcode, a default, or a second copy.
 *
 * The mutations are performed on the assembled STRING, never on ship.js: the
 * tree stays clean and the proof is re-run on every suite run rather than
 * living in a commit message a reader has to trust.
 */
describe("#274 AC-1: each extracted statement is load-bearing", () => {
  const sliceByName = (name: string): string => {
    const found = STATEMENTS.find((s) => s.name === name);
    if (!found) throw new Error(`no extracted slice named ${name}`);
    return found.text;
  };

  const without = (name: string): string => {
    const text = sliceByName(name);
    const mutated = CHAIN_SOURCE.replace(text, "");
    if (mutated === CHAIN_SOURCE) throw new Error(`could not remove the ${name} slice from the chain`);
    return mutated;
  };

  test("dropping the raise block leaves the fixture at LIGHT", () => {
    expect(runTierChain(fixtureConfig, "LIGHT", without("raise")).tier).toBe("LIGHT");
  });

  test("dropping the ceremonyTierFloor call leaves the fixture at LIGHT", () => {
    // `flooredTier` goes undefined, the raise block sees a difference and
    // assigns it — so the observable result is a tier that is no longer
    // STANDARD, which is the whole point of asserting the value not the delta.
    expect(runTierChain(fixtureConfig, "LIGHT", without("ceremonyTierFloor call")).tier).not.toBe(
      "STANDARD",
    );
  });

  test("dropping the downgrade block leaves rungate's own STANDARD un-downgraded", () => {
    const ownConfig = loadRungateConfig(REPO_ROOT);
    expect(runTierChain(ownConfig, "STANDARD").tier).toBe("LIGHT");
    expect(runTierChain(ownConfig, "STANDARD", without("!hasUI downgrade")).tier).toBe("STANDARD");
  });
});

describe("#274 AC-1: the STANDARD result is attributable to the declared pages", () => {
  const emptyPages = (): Record<string, unknown> => ({ ...fixtureRaw, pages: {} });

  test("the same chain over a pages:{} config leaves the tier at LIGHT", () => {
    const out = runTierChain(emptyPages(), fixtureState.sizing?.ceremonyTier);
    expect(out.hasUI).toBe(false);
    expect(out.pageCount).toBe(0);
    expect(out.tier).toBe("LIGHT");
  });

  test("pages is the only input that differs between the two runs", () => {
    const emptied = emptyPages();
    const differing = Object.keys(fixtureRaw).filter(
      (k) => JSON.stringify(fixtureRaw[k]) !== JSON.stringify(emptied[k]),
    );
    expect(differing).toEqual(["pages"]);
    expect(runTierChain(fixtureConfig, "LIGHT").tier).toBe("STANDARD");
    expect(runTierChain(emptied, "LIGHT").tier).toBe("LIGHT");
  });

  test("rungate's own directory config is the real pages:{} case, and stays LIGHT", () => {
    // Not a hypothetical: this is why no self-run has entered a tier-gated path.
    const ownConfig = loadRungateConfig(REPO_ROOT);
    expect(Object.keys(ownConfig.pages as object).length).toBe(0);
    expect(runTierChain(ownConfig, "LIGHT").tier).toBe("LIGHT");
    const downgraded = runTierChain(ownConfig, "STANDARD");
    expect(downgraded.tier).toBe("LIGHT");
    expect(downgraded.logs.join("\n")).toContain("pages:{} empty");
  });
});

// ── AC-5 — the documented consumer shape, and the three measured facts ───

const specSource = readFileSync(SPEC_PATH, "utf-8");

const CONSUMER_SECTION_HEADING = "## Consumer Config Shape (`.claude/rungate.json`)";
const GAP_SECTION_HEADING = "## What a Consumer's Test Environment Needs (#274)";

/**
 * The documented keys, parsed out of the spec's own table. Hardcoding the list
 * here would make this a test of two copies I keep in step by hand, which goes
 * green the moment the spec stops describing the fixture.
 */
function documentedConsumerKeys(spec: string): Array<{ key: string; required: boolean }> {
  const n = countOccurrences(spec, CONSUMER_SECTION_HEADING);
  if (n !== 1) {
    throw new Error(
      `specs/CONFIG-DIRECTORY-STRUCTURE-SPEC.md has ${n} "${CONSUMER_SECTION_HEADING}" sections (expected exactly 1)`,
    );
  }
  const start = spec.indexOf(CONSUMER_SECTION_HEADING);
  const after = spec.slice(start + CONSUMER_SECTION_HEADING.length);
  const nextHeading = after.search(/\n## /);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);

  const rows: Array<{ key: string; required: boolean }> = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*`([a-zA-Z.]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    rows.push({ key: m[1], required: m[2].trim().toLowerCase() === "required" });
  }
  if (rows.length === 0) {
    throw new Error("the Consumer Config Shape section documents no keys — its table did not parse");
  }
  return rows;
}

describe("#274 AC-5: the spec documents the consumer shape, and the fixture conforms", () => {
  test("both config forms are documented in the same spec", () => {
    // "Beside": the directory form rungate itself uses, and the monolith every
    // consumer uses, in one file a reader lands on once.
    expect(specSource).toContain(".claude/rungate/\n  config.json");
    expect(specSource).toContain(CONSUMER_SECTION_HEADING);
    expect(specSource.indexOf(".claude/rungate/\n  config.json")).toBeLessThan(
      specSource.indexOf(CONSUMER_SECTION_HEADING),
    );
  });

  test("the documented table carries the keys ship.js actually reads", () => {
    const documented = documentedConsumerKeys(specSource);
    const keys = documented.map((d) => d.key);
    // A one-row table would make the conformity check below vacuous.
    expect(documented.length).toBeGreaterThanOrEqual(8);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ["project", "repo", "issueRepo", "pages", "dev", "prod", "container", "remoteHosts"]) {
      expect(keys).toContain(key);
    }
    expect(documented.filter((d) => d.required).length).toBeGreaterThanOrEqual(4);
  });

  test("the fixture carries every key the spec marks required", () => {
    const required = documentedConsumerKeys(specSource).filter((d) => d.required);
    for (const { key } of required) {
      expect(Object.keys(fixtureRaw)).toContain(key);
      expect(fixtureRaw[key]).toBeDefined();
    }
  });

  test("the fixture carries the optional keys too, since this issue owns their shape", () => {
    const container = fixtureRaw.container as Record<string, unknown> | undefined;
    const remoteHosts = fixtureRaw.remoteHosts as Record<string, unknown> | undefined;
    expect(container).toBeDefined();
    expect(typeof container?.rebuildCommand).toBe("string");
    expect(Array.isArray(container?.hosts)).toBe(true);
    expect(typeof container?.port).toBe("number");
    expect(remoteHosts).toBeDefined();
    expect(Object.keys(remoteHosts ?? {}).length).toBeGreaterThan(0);
    for (const host of Object.values(remoteHosts ?? {}) as Array<Record<string, unknown>>) {
      expect(typeof host.host).toBe("string");
      expect(typeof host.preFlightCmd).toBe("string");
    }
  });

  test("the spec's claim about the fixture names the fixture that exists", () => {
    // A spec section describing a fixture path that was never created is the
    // documentation equivalent of a vacuous assertion.
    expect(specSource).toContain("test/fixtures/consumer-ui-project/.claude/rungate.json");
  });
});

/**
 * AC-5's written answer. The three facts are not a reading comprehension test —
 * each one is a defect a DailyBriefDashboard run will hit, and each is matched
 * by a probe that also checks the fact is still TRUE of the source. A spec
 * paragraph describing a key-name split that someone has since unified is
 * worse than no paragraph.
 */
const MEASURED_FACTS: Array<{ name: string; documented: RegExp; stillTrue: () => boolean }> = [
  {
    name: "the dev.testCmd versus test.command key-name split",
    documented: /`dev\.testCmd`[\s\S]{0,400}?`test\.command`|`test\.command`[\s\S]{0,400}?`dev\.testCmd`/,
    stillTrue: () => {
      const executor = readFileSync(join(REPO_ROOT, "gates", "gate-executor.ts"), "utf-8");
      const gate = readFileSync(join(REPO_ROOT, "gates", "workflow.test.ts"), "utf-8");
      return executor.includes("harness.test?.command") && gate.includes("harness?.dev?.testCmd");
    },
  },
  {
    name: "the gate checks sitting behind loadProjectHarness",
    documented: /loadProjectHarness/,
    stillTrue: () => {
      const gate = readFileSync(join(REPO_ROOT, "gates", "workflow.test.ts"), "utf-8");
      // More than one check reads the consumer's config through the loader, and
      // the loader returns null when there is no `.claude/rungate.json` — which
      // is how a check passes having made zero assertions.
      return (gate.split("loadProjectHarness()").length - 1) > 1;
    },
  },
  {
    name: "the agent prompt that writes environments.prod.rebuild to PASS",
    documented: /environments\.prod\.rebuild/,
    stillTrue: () => shipSource.includes("environments.prod.rebuild"),
  },
];

describe("#274 AC-5: the consumer test-environment answer is recorded in the spec", () => {
  test("the spec has a section answering the 7776-before-7777 question", () => {
    expect(countOccurrences(specSource, GAP_SECTION_HEADING)).toBe(1);
    const start = specSource.indexOf(GAP_SECTION_HEADING);
    const after = specSource.slice(start);
    const section = after.slice(0, after.slice(2).search(/\n## /) + 2);
    expect(section).toContain("7776");
    expect(section).toContain("7777");
  });

  test("all three measured facts are documented, by name", () => {
    const matched = MEASURED_FACTS.filter((f) => f.documented.test(specSource));
    expect(matched.map((f) => f.name)).toEqual(MEASURED_FACTS.map((f) => f.name));
    expect(matched.length).toBeGreaterThanOrEqual(3);
  });

  test("each documented fact is still true of the source it describes", () => {
    // The half that makes the one above a measurement. A spec can describe a
    // split that no longer exists, and a grep for the words would never know.
    for (const fact of MEASURED_FACTS) {
      expect(fact.stillTrue(), `the spec still documents "${fact.name}" but the source has moved`).toBe(
        true,
      );
    }
  });

  test("the fact probes can see an absence", () => {
    // Vacuity guard: a regex that matched the empty string would report all
    // three documented over a spec that says nothing.
    for (const fact of MEASURED_FACTS) {
      expect(fact.documented.test("")).toBe(false);
    }
  });
});
