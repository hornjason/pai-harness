import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * #274 — restoring the unconditional `hasUI` downgrade turns exactly FOUR
 * tier-gated observations red, and leaves the remote pre-flight green.
 *
 * `workflows/ship.js` rewrites the ceremony tier from the consumer's declared
 * `pages`. rungate's own config declares `pages: {}`, so `hasUI` is false on
 * every self-run and the downgrade at that site fires every time: the scope
 * gate, Quinn local, container verify and prove have never once executed in
 * this repo's history. A consumer that declares pages keeps STANDARD and
 * enters all of them.
 *
 * This file is the PROOF that the observations of those subsystems are
 * load-bearing rather than decorative. It runs in two modes, selected by one
 * environment variable:
 *
 * - `CONSUMER_TIER_SHIP_SOURCE` set → OBSERVATION mode. Six observations are
 *   made against the ship.js at that path, each one evaluating a guard
 *   expression lifted VERBATIM out of that source over a declared-pages
 *   consumer fixture. Nothing here reads the tier string: an observation that
 *   asserted `tier === 'STANDARD'` would go red under the mutant for a reason
 *   that says nothing about whether the subsystem runs.
 * - unset → DRIVER mode. It builds the mutant into a temp path, spawns the
 *   observation suite twice over the same argv, and counts.
 *
 * Why the one differing element travels in the environment rather than in
 * argv: `bun test` rewrites `process.argv` to `[bun, <test file>]` and drops
 * everything else, so a path appended to the command line cannot be read by
 * the child. That is not asserted by comment — a probe spawn below proves it,
 * and the two spawn descriptors are compared leaf by leaf so "differing only
 * in the path to the source under test" is a measured property.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const SELF = import.meta.path;
const SOURCE_ENV = "CONSUMER_TIER_SHIP_SOURCE";
const SOURCE_UNDER_TEST = process.env[SOURCE_ENV];

// ── the observations, named once and shared by both modes ───────────────────

const OBS = {
  scope: "OBS-1 the scope gate runs",
  quinnLocal: "OBS-2 Quinn local runs",
  containerCheck: "OBS-3 container verify reaches its config check",
  prove: "OBS-4 prove runs",
  containerQuinn: "OBS-5 container Quinn stays skipped — the fixture declares no container",
  preflight: "OBS-6 the remote pre-flight runs — it is not tier-gated",
} as const;

/**
 * The four that MUST turn red when the downgrade is restored.
 *
 * ship.js has five tier-gated sites, not four. Two of them —
 * `if (tier !== 'LIGHT' && containerConfig)` and its `else if (tier !== 'LIGHT')`
 * — are exclusive branches of ONE decision, so no single fixture can enter
 * both. The fixture here declares no container (DailyBriefDashboard declares
 * none either), so the branch it enters is the config check, and the count is
 * four. The driver asserts the other branch is tier-gated too, on a fixture
 * variant that declares a container, so "four" is a property of the decision
 * tree rather than a site this file forgot.
 */
const EXPECTED_RED = [OBS.scope, OBS.quinnLocal, OBS.containerCheck, OBS.prove];
const EXPECTED_GREEN = [OBS.containerQuinn, OBS.preflight];
const ALL_OBSERVATIONS = [...EXPECTED_RED, ...EXPECTED_GREEN];

// ── the fixture: a consumer that declares pages ─────────────────────────────

type Fixture = {
  tier: string;
  config: Record<string, unknown>;
  args: Record<string, unknown>;
  acs: Array<Record<string, unknown>>;
};

/** 18 pages, the number DailyBriefDashboard declares. */
const DECLARED_PAGES = Object.fromEntries(
  Array.from({ length: 18 }, (_, i) => [`page-${i + 1}`, `/page-${i + 1}`]),
);

const CONSUMER: Fixture = {
  // What the discovery LLM sized the issue at. The point of the fixture is
  // that this SURVIVES on a declared-pages consumer and does not on rungate.
  tier: "STANDARD",
  config: {
    pages: DECLARED_PAGES,
    dev: { uiBase: "http://localhost:7777", testCmd: "bun test" },
  },
  args: {
    remoteHosts: { mini: { host: "mini.local", purpose: "container host" } },
  },
  acs: [
    { id: "AC-1", type: "OUTCOME", evidenceMethod: { type: "PLAYWRIGHT" } },
    { id: "AC-2", type: "CODE", evidenceMethod: { type: "BUN_TEST" } },
  ],
};

/** The same consumer, declaring a container. Used only to show site five. */
const CONSUMER_WITH_CONTAINER: Fixture = {
  ...CONSUMER,
  config: {
    ...CONSUMER.config,
    container: { rebuildCommand: "make rebuild", hosts: ["mini"], port: 7777, healthPath: "/health" },
  },
};

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * The one occurrence of `re` in `source`, or a thrown error naming the site.
 *
 * Exactly-once is the point rather than a convenience: a second copy of any of
 * these sites would survive the mutation and leave the mutant red for a reason
 * unconnected to the mutation working.
 */
function one(source: string, re: RegExp, label: string): RegExpMatchArray {
  const all = [...source.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  if (all.length !== 1) {
    throw new Error(
      `could not locate ${label} in the source under test: ${re} matched ${all.length} times, ` +
        `so this test proves nothing`,
    );
  }
  return all[0];
}

/**
 * Statements lifted whole. Each is a line (or a brace-closed block starting at
 * column zero) of `workflows/ship.js`, executed below exactly as written.
 */
const STATEMENTS: Record<string, RegExp> = {
  remoteHosts: /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}$/m,
  preflightResults: /^const preflightResults = parsedArgs\.preflightResults \|\| null$/m,
  pagesConfig: /^const pagesConfig = projectConfig\.pages \|\| parsedArgs\.pages \|\| \{\}$/m,
  // Loose on the right-hand side on purpose: the mutant pins this to `false`,
  // and the runner has to be able to execute the mutant too.
  hasUI: /^const hasUI = .+$/m,
  downgrade: /^if \(!hasUI && discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m,
  floorCall: /^const flooredTier = ceremonyTierFloor\(discovery\.ceremonyTier, hasUI\)$/m,
  raise: /^if \(flooredTier !== discovery\.ceremonyTier\) \{[\s\S]*?\n\}$/m,
  skipScope: /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m,
  containerConfig: /^const containerConfig = projectConfig\.container \|\| null$/m,
  hasUIACs: /^const hasUIACs = \(discovery\?\.acs \|\| \[\]\)\.some\(.+\)$/m,
  shouldProve: /^const shouldProve = discovery\.ceremonyTier !== 'LIGHT' && hasUIACs$/m,
};

/**
 * The guards, each captured out of the `if` that ship.js actually writes.
 *
 * Group 1 is the condition text, and it is the only thing this file evaluates.
 * None of these conditions is restated here — a restated guard is a model of
 * ship.js, and a model cannot go red when ship.js changes.
 */
const GUARDS: Record<string, RegExp> = {
  preflightPrecomputed: /^if \((preflightResults)\) \{$/m,
  preflight: /^\} else if \((Object\.keys\(remoteHosts\)\.length > 0)\) \{$/m,
  scope: /^if \((!skipScope)\) \{$/m,
  quinnLocal: /^if \((discovery\.ceremonyTier !== 'LIGHT')\) \{\n  for \(let validateAttempt = 1;/m,
  containerQuinn: /^if \((discovery\.ceremonyTier !== 'LIGHT' && containerConfig)\) \{$/m,
  containerCheck: /^\} else if \((discovery\.ceremonyTier !== 'LIGHT')\) \{\n  log\('No container config/m,
  prove: /^if \((shouldProve)\) \{$/m,
};

const FLOOR_START = "// ──── CEREMONY-TIER-FLOOR-START ────";
const FLOOR_END = "// ──── CEREMONY-TIER-FLOOR-END ────";

function floorBlock(source: string): { index: number; code: string } {
  const a = source.indexOf(FLOOR_START);
  const b = source.indexOf(FLOOR_END);
  if (a < 0 || b <= a) {
    throw new Error("the source under test is missing the CEREMONY-TIER-FLOOR markers");
  }
  return { index: a, code: source.slice(a, b) };
}

type Decision = {
  tier: string;
  logs: string[];
  scopeGateRuns: boolean;
  quinnLocalRuns: boolean;
  containerQuinnRuns: boolean;
  containerCheckReached: boolean;
  proveRuns: boolean;
  preflightRuns: boolean;
};

/**
 * ship.js's own tier statements and its own guard conditions, RUN over the
 * fixture, in SOURCE ORDER.
 *
 * Source order is not an implementation detail (SC-677): a fixed assembly
 * order would apply the floor before the downgrade wherever ship.js put them,
 * and the downgrade overwriting the floor is exactly the regression this has
 * to be able to see.
 *
 * `preflightRuns` and `containerCheckReached` compose two captured conditions
 * because the sites are `else if` branches — that composition is JavaScript's
 * semantics for the chain, not a second statement of either condition. Each
 * result is wrapped in `Boolean(...)` for the same reason: ship.js writes
 * `tier !== 'LIGHT' && containerConfig`, whose value is the config object, and
 * truthiness is exactly what the `if` it was lifted from does with it.
 */
function decide(source: string, fixture: Fixture): Decision {
  const parts = [floorBlock(source)];
  for (const [label, re] of Object.entries(STATEMENTS)) {
    const m = one(source, re, label);
    parts.push({ index: m.index!, code: m[0] });
  }
  parts.sort((a, b) => a.index - b.index);

  const g = (label: string): string => one(source, GUARDS[label], label)[1];

  const body = [
    "const logs = []",
    "const log = (m) => { logs.push(String(m)) }",
    "const discovery = { ceremonyTier: fixture.tier, acs: fixture.acs }",
    "const projectConfig = fixture.config",
    "const parsedArgs = fixture.args",
    ...parts.map((p) => p.code),
    "return {",
    "  tier: discovery.ceremonyTier,",
    "  logs,",
    `  scopeGateRuns: Boolean(${g("scope")}),`,
    `  quinnLocalRuns: Boolean(${g("quinnLocal")}),`,
    `  containerQuinnRuns: Boolean(${g("containerQuinn")}),`,
    `  containerCheckReached: Boolean(!(${g("containerQuinn")}) && (${g("containerCheck")})),`,
    `  proveRuns: Boolean(${g("prove")}),`,
    `  preflightRuns: Boolean(!(${g("preflightPrecomputed")}) && (${g("preflight")})),`,
    "}",
  ].join("\n");

  return new Function("fixture", body)(fixture) as Decision;
}

// ── the mutation ────────────────────────────────────────────────────────────

/**
 * Restore the unconditional `hasUI` downgrade.
 *
 * One edit, at one site: `hasUI` stops consulting the consumer's declared
 * pages. That is the whole of the pre-#274 world — the downgrade's `!hasUI`
 * guard is then true on every run, so every run is rewritten to LIGHT, and the
 * #215 floor cannot raise it back because the floor reads the same `hasUI`.
 * Every other byte of ship.js, including all five tier-gated guards, is left
 * exactly as it is, which is what makes the four reds attributable.
 *
 * Throws rather than returning an unmutated copy when the site moves. A
 * mutation harness that silently no-ops when its target is renamed is the
 * decorative check this whole exercise exists to rule out.
 */
const HAS_UI_SITE = "const hasUI = Object.keys(pagesConfig).length > 0";
const UNCONDITIONAL_DOWNGRADE = "const hasUI = false";

export function buildMutantSource(src: string): string {
  const occurrences = src.split(HAS_UI_SITE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `could not build the mutant: the hasUI computation appears ${occurrences} times, expected exactly 1. ` +
        `Either it was changed, or a second copy exists and pinning one would leave the other reading pages.`,
    );
  }
  const mutated = src.replace(HAS_UI_SITE, UNCONDITIONAL_DOWNGRADE);
  if (mutated === src) throw new Error("could not build the mutant: the replacement changed nothing");
  return mutated;
}

// ════════════════════════════════════════════════════════════════════════════
// OBSERVATION MODE — one source under test, six observations
// ════════════════════════════════════════════════════════════════════════════

if (SOURCE_UNDER_TEST) {
  describe("#274 tier-gated subsystems on a declared-pages consumer fixture", () => {
    let cached: Decision | null = null;
    const observed = (): Decision => {
      if (!cached) cached = decide(readFileSync(SOURCE_UNDER_TEST, "utf-8"), CONSUMER);
      return cached;
    };

    test(OBS.scope, () => {
      expect(observed().scopeGateRuns).toBe(true);
    });

    test(OBS.quinnLocal, () => {
      expect(observed().quinnLocalRuns).toBe(true);
    });

    test(OBS.containerCheck, () => {
      expect(observed().containerCheckReached).toBe(true);
    });

    test(OBS.prove, () => {
      expect(observed().proveRuns).toBe(true);
    });

    test(OBS.containerQuinn, () => {
      // Doubly gated: tier AND a declared container. Green in both runs, which
      // is what stops "the mutant broke everything" from reading as a proof.
      expect(observed().containerQuinnRuns).toBe(false);
    });

    test(OBS.preflight, () => {
      // ~450 lines before the tier is first read. Green in both runs.
      expect(observed().preflightRuns).toBe(true);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// DRIVER MODE — build the mutant, spawn both suites, count the reds
// ════════════════════════════════════════════════════════════════════════════

type TestCase = { name: string; failed: boolean };
type RunResult = { cases: TestCase[]; output: string; status: number | null };
type Descriptor = { cmd: string[]; cwd: string; env: Record<string, string | undefined> };

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function decodeXml(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Per-test verdicts, read off bun's own JUnit reporter rather than guessed. */
function parseJUnit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    if (!name) continue;
    cases.push({ name: decodeXml(name[1]), failed: /<(failure|error)\b/.test(m[3] ?? "") });
  }
  return cases;
}

if (!SOURCE_UNDER_TEST) {
  const SHIP_BEFORE = readFileSync(SHIP, "utf-8");
  const SHIP_HASH_BEFORE = sha(SHIP_BEFORE);

  let SCRATCH = "";
  let MUTANT = "";
  let JUNIT = "";
  let clean: RunResult;
  let mutant: RunResult;

  /**
   * The ONE spawn descriptor. Both runs go through it, and the only argument
   * it takes is the path to the source under test.
   */
  const descriptor = (shipSource: string): Descriptor => ({
    cmd: ["bun", "test", SELF, "--reporter=junit", `--reporter-outfile=${JUNIT}`],
    cwd: REPO_ROOT,
    env: { ...process.env, [SOURCE_ENV]: shipSource },
  });

  /** Every leaf on which two descriptors disagree. */
  const descriptorDiff = (a: Descriptor, b: Descriptor): string[] => {
    const diffs: string[] = [];
    if (a.cwd !== b.cwd) diffs.push("cwd");
    for (let i = 0; i < Math.max(a.cmd.length, b.cmd.length); i++) {
      if (a.cmd[i] !== b.cmd[i]) diffs.push(`cmd[${i}]`);
    }
    for (const key of new Set([...Object.keys(a.env), ...Object.keys(b.env)])) {
      if (a.env[key] !== b.env[key]) diffs.push(`env.${key}`);
    }
    return diffs.sort();
  };

  const runObservations = (shipSource: string): RunResult => {
    if (existsSync(JUNIT)) rmSync(JUNIT, { force: true });
    const d = descriptor(shipSource);
    const r = spawnSync(d.cmd[0], d.cmd.slice(1), {
      cwd: d.cwd,
      env: d.env as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: 180000,
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const cases = existsSync(JUNIT) ? parseJUnit(readFileSync(JUNIT, "utf-8")) : [];
    if (existsSync(JUNIT)) rmSync(JUNIT, { force: true });
    return { cases, output, status: r.status };
  };

  const verdict = (run: RunResult, name: string): TestCase | undefined =>
    run.cases.find((c) => c.name === name);

  beforeAll(() => {
    SCRATCH = mkdtempSync(join(tmpdir(), "consumer-tier-downgrade-"));
    MUTANT = join(SCRATCH, "ship.mutant.js");
    JUNIT = join(SCRATCH, "observations.junit.xml");
    writeFileSync(MUTANT, buildMutantSource(SHIP_BEFORE));
    clean = runObservations(SHIP);
    mutant = runObservations(MUTANT);
  }, 600000);

  afterAll(() => {
    const mutantPath = MUTANT;
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
    // AC-1: the mutant is gone and the real file never moved.
    expect(existsSync(mutantPath)).toBe(false);
    expect(readFileSync(SHIP, "utf-8")).toBe(SHIP_BEFORE);
  });

  // ── AC-1: the mutant is a temp file, and ship.js is untouched ─────────────

  describe("#274 AC-1: the mutant lives in a temp path, never in the tree", () => {
    test("it is written outside the repository and differs from ship.js", () => {
      expect(existsSync(MUTANT)).toBe(true);
      expect(MUTANT.startsWith(REPO_ROOT)).toBe(false);
      expect(MUTANT.startsWith(tmpdir())).toBe(true);
      expect(readFileSync(MUTANT, "utf-8")).not.toBe(SHIP_BEFORE);
    });

    test("it differs from ship.js at exactly the hasUI site and nowhere else", () => {
      const m = readFileSync(MUTANT, "utf-8");
      expect(m).toContain(UNCONDITIONAL_DOWNGRADE);
      expect(m).not.toContain(HAS_UI_SITE);
      expect(m.replace(UNCONDITIONAL_DOWNGRADE, HAS_UI_SITE)).toBe(SHIP_BEFORE);
    });

    test("the real workflows/ship.js is byte-identical after both runs", () => {
      expect(sha(readFileSync(SHIP, "utf-8"))).toBe(SHIP_HASH_BEFORE);
    });

    test("the builder refuses when its target has moved", () => {
      expect(() => buildMutantSource(SHIP_BEFORE.replace(HAS_UI_SITE, UNCONDITIONAL_DOWNGRADE))).toThrow(
        /could not build the mutant: the hasUI computation appears 0 times/,
      );
      expect(() => buildMutantSource(`${SHIP_BEFORE}\n${HAS_UI_SITE}\n`)).toThrow(
        /could not build the mutant: the hasUI computation appears 2 times/,
      );
    });
  });

  // ── AC-2: one argv, one difference ────────────────────────────────────────

  describe("#274 AC-2: both suites are spawned over a single argv", () => {
    test("the two spawn descriptors differ in exactly one leaf", () => {
      const diffs = descriptorDiff(descriptor(SHIP), descriptor(MUTANT));
      expect(diffs).toEqual([`env.${SOURCE_ENV}`]);
    });

    test("that one leaf is the path to the source under test", () => {
      expect(descriptor(SHIP).env[SOURCE_ENV]).toBe(SHIP);
      expect(descriptor(MUTANT).env[SOURCE_ENV]).toBe(MUTANT);
      expect(descriptor(SHIP).cmd).toEqual(descriptor(MUTANT).cmd);
      expect(descriptor(SHIP).cmd).toContain(SELF);
    });

    test("bun drops trailing argv under `bun test`, which is why the leaf is an env entry", () => {
      // Measured rather than asserted in a comment: the child below is spawned
      // with the sentinel path on its command line and cannot see it.
      const probe = join(SCRATCH, "argv-probe.test.ts");
      writeFileSync(
        probe,
        'import { test, expect } from "bun:test";\n' +
          'test("argv", () => { console.log("ARGV:" + JSON.stringify(process.argv)); expect(1).toBe(1); });\n',
      );
      const r = spawnSync("bun", ["test", probe, "--ship-source", "/sentinel/ship.js"], {
        cwd: SCRATCH,
        encoding: "utf-8",
        timeout: 120000,
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const argv = /ARGV:(\[.*\])/.exec(out);
      expect(argv).not.toBeNull();
      expect(argv![1]).toContain("argv-probe.test.ts");
      expect(argv![1]).not.toContain("/sentinel/ship.js");
    });
  });

  // ── AC-3: exactly four reds, named ────────────────────────────────────────

  describe("#274 AC-3: restoring the downgrade turns exactly four observations red", () => {
    test("both runs observed the same six observations", () => {
      // Vacuity guard. A child that failed to load reports no test cases at
      // all, which is indistinguishable from six green ones in a count of reds.
      expect(clean.cases.map((c) => c.name).sort()).toEqual([...ALL_OBSERVATIONS].sort());
      expect(mutant.cases.map((c) => c.name).sort()).toEqual([...ALL_OBSERVATIONS].sort());
      expect(clean.cases).toHaveLength(6);
      expect(mutant.cases).toHaveLength(6);
    });

    test("the clean run is green: nothing is red before the mutation", () => {
      expect(clean.cases.filter((c) => c.failed).map((c) => c.name)).toEqual([]);
      expect(clean.status).toBe(0);
    });

    test("the mutant run is red in exactly four, and these four", () => {
      const red = mutant.cases.filter((c) => c.failed).map((c) => c.name).sort();
      expect(red).toEqual([...EXPECTED_RED].sort());
      expect(red).toHaveLength(4);
      expect(mutant.status).not.toBe(0);
    });

    test("the mutation is what moved them: the fixture's tier is STANDARD clean and LIGHT mutated", () => {
      // Asserted HERE and not in the spawned suite on purpose. An observation
      // that read the tier would go red under the mutant without saying
      // anything about whether a subsystem ran, which is what AC-3 forbids.
      expect(decide(SHIP_BEFORE, CONSUMER).tier).toBe("STANDARD");
      expect(decide(readFileSync(MUTANT, "utf-8"), CONSUMER).tier).toBe("LIGHT");
    });

    test("four and not five: the fifth tier-gated site is the other branch of the same decision", () => {
      const mutantSource = readFileSync(MUTANT, "utf-8");
      // With a container declared, the container-Quinn branch is the one
      // entered, it is tier-gated, and it flips the same way...
      expect(decide(SHIP_BEFORE, CONSUMER_WITH_CONTAINER).containerQuinnRuns).toBe(true);
      expect(decide(mutantSource, CONSUMER_WITH_CONTAINER).containerQuinnRuns).toBe(false);
      // ...and then the config-check branch is the one no fixture can reach,
      // so the count is four whichever container shape the consumer declares.
      expect(decide(SHIP_BEFORE, CONSUMER_WITH_CONTAINER).containerCheckReached).toBe(false);
      expect(decide(SHIP_BEFORE, CONSUMER).containerQuinnRuns).toBe(false);
      expect(decide(SHIP_BEFORE, CONSUMER).containerCheckReached).toBe(true);
    });
  });

  // ── AC-4: the remote pre-flight is green in both ──────────────────────────

  describe("#274 AC-4: the remote pre-flight is not tier-gated", () => {
    test("it is green in the clean run and in the mutant run", () => {
      const a = verdict(clean, OBS.preflight);
      const b = verdict(mutant, OBS.preflight);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.failed).toBe(false);
      expect(b!.failed).toBe(false);
    });

    test("so is the doubly-gated container Quinn observation", () => {
      // The second green. Both of them together are what rule out "the mutant
      // broke the suite" as an explanation for the four reds.
      expect(verdict(clean, OBS.containerQuinn)!.failed).toBe(false);
      expect(verdict(mutant, OBS.containerQuinn)!.failed).toBe(false);
      expect(EXPECTED_GREEN).toHaveLength(2);
    });

    test("the pre-flight guard is read from a site that never mentions the tier", () => {
      const site = one(SHIP_BEFORE, GUARDS.preflight, "the remote pre-flight guard")[1];
      expect(site).not.toContain("ceremonyTier");
      expect(SHIP_BEFORE.indexOf(site)).toBeLessThan(
        SHIP_BEFORE.indexOf("const skipScope = discovery.ceremonyTier === 'LIGHT'"),
      );
    });
  });

  // ── AC-5: the method and the count are written down ───────────────────────

  describe("#274 AC-5: specs/HARNESS-STANDARD.md records the method and the count", () => {
    const spec = readFileSync(join(REPO_ROOT, "specs", "HARNESS-STANDARD.md"), "utf-8");

    test("it names this file, the mutation, and the red count", () => {
      expect(spec).toContain("test/consumer-tier-downgrade-mutation.test.ts");
      expect(spec).toContain(UNCONDITIONAL_DOWNGRADE);
      expect(spec).toContain("4 of 6");
    });

    test("it names the four observations that go red", () => {
      for (const name of EXPECTED_RED) expect(spec).toContain(name);
    });

    test("it records why the count is four and not five", () => {
      expect(spec).toContain("exclusive branches of one decision");
    });
  });
}
