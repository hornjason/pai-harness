import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * #274 AC-3 — the subsystem observations can FAIL.
 *
 * `test/ship-ceremony-tier-floor.test.ts` proves the floor computes the right
 * tier. That is not the same claim as "the subsystems a tier switches on
 * actually ran". A suite that watched four subsystems and never watched them
 * NOT run would be the decorative check `.claude/rules/checks-must-be-able-to-fail.md`
 * is about: every one of its observations would be satisfied by a harness that
 * resolved STANDARD for every input, including inputs that must stay LIGHT.
 *
 * So the pre-#215 defect is REBUILT as a mutant — the `CEREMONY-TIER-FLOOR`
 * block deleted, the floor call and the raise removed, leaving `hasUI` with
 * nothing but its one-way downgrade — and a five-observation suite is SPAWNED
 * against it. Real source: 5 of 5 green. Mutant: exactly 4 red, and the one
 * green has to be the remote pre-flight, because the pre-flight is the one
 * observation in that set that is not tier-gated and therefore the one whose
 * greenness proves the spawn ran at all rather than dying on load.
 *
 * ## Why four tier-gated observations and not five
 *
 * `workflows/ship.js` has five tier-gated CONDITIONS but four tier-gated
 * STATEMENTS: container verify and the container-declined arm are the two arms
 * of a single `if (… && containerConfig) { … } else if (…) { … }`. One
 * statement, one gate, one observation — and the observation asserts BOTH arms,
 * so neither half can go quiet unnoticed. Splitting them would report five reds
 * for one mutation applied to one branch point, which overstates what the
 * mutant measured. `test/consumer-tier-gated-subsystems.test.ts` observes the
 * two arms separately; this file is the count, and a count has to say what it
 * counted.
 *
 * Three properties make this worth running, and all three are asserted here
 * rather than left as conventions:
 *
 * - **The suite is spawned, identically, twice.** `ran` is read out of the
 *   junit report before any verdict is, because a suite that failed to resolve
 *   its imports reports zero failures and is indistinguishable from a suite
 *   that passed. The two spawns share one argv; only `SHIP_UNDER_TEST` differs.
 * - **Green and red are compared by NAME.** "1 of 5" is satisfied by any one
 *   of the five; only the pre-flight one means what this claims.
 * - **The mutation is local.** Every subsystem block is asserted byte-identical
 *   between the real source and the mutant, so the four reds are caused by the
 *   tier the chain resolved and not by a mutant that damaged the blocks.
 *
 * The mutant builder throws rather than returning an unmutated copy when its
 * target moves — a mutation harness that silently no-ops when the downgrade is
 * renamed reports green over a mutation that never happened.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

const FLOOR_START = "// ──── CEREMONY-TIER-FLOOR-START ────";
const FLOOR_END = "// ──── CEREMONY-TIER-FLOOR-END ────";

/** The one-way downgrade #215 found alone, and the two statements that partnered it. */
export const DOWNGRADE_SITE = /^if \(!hasUI && discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m;
const FLOOR_CALL_SITE = /^const flooredTier = ceremonyTierFloor\(discovery\.ceremonyTier, hasUI\)$/m;
const RAISE_SITE = /^if \(flooredTier !== discovery\.ceremonyTier\) \{[\s\S]*?\n\}$/m;

/** The four tier-gated subsystem statements, plus the pre-flight that is not gated. */
const SUBSYSTEM_SITES = {
  "the skipScope decision": /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m,
  "the scope gate invocation": /^if \(!skipScope\) \{[\s\S]*?\n\}$/m,
  "the Quinn local loop": /^if \(discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m,
  "the container verify arms":
    /^if \(discovery\.ceremonyTier !== 'LIGHT' && containerConfig\) \{[\s\S]*?\n\} else if \(discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m,
  "the UI-AC detection": /^const hasUIACs = .*$/m,
  "the prove decision": /^const shouldProve = discovery\.ceremonyTier !== 'LIGHT' && hasUIACs$/m,
  "the prove invocation": /^if \(shouldProve\) \{[\s\S]*?\n\}$/m,
  "the remoteHosts read": /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}$/m,
  "the preflightResults read": /^const preflightResults = parsedArgs\.preflightResults \|\| null$/m,
  "the pre-flight block": /^if \(preflightResults\) \{[\s\S]*?\n\}$/m,
} as const;

function matches(src: string, re: RegExp): RegExpMatchArray[] {
  return [...src.matchAll(new RegExp(re.source, "gm"))];
}

// ── the mutation ────────────────────────────────────────────────────────────

/**
 * Rebuild the pre-#215 source: the floor block gone, the floor call and the
 * raise gone, the one-way `hasUI` downgrade left exactly as it is.
 *
 * Every site is located exactly once first. A second copy of any of them would
 * survive the removal and leave the mutant behaving like the real source for a
 * reason that has nothing to do with the mutation having worked.
 */
export function buildRestoredDowngradeMutant(src: string = shipSource): string {
  for (const [label, re] of [
    ["the hasUI downgrade site", DOWNGRADE_SITE],
    ["the floor call", FLOOR_CALL_SITE],
    ["the tier raise", RAISE_SITE],
  ] as const) {
    const hits = matches(src, re).length;
    if (hits !== 1) {
      throw new Error(
        `could not build the mutant: ${label} appears ${hits} times in workflows/ship.js, expected exactly 1. ` +
          `Either it was renamed, or a second copy exists and removing one would leave the other in place.`,
      );
    }
  }

  const a = src.indexOf(FLOOR_START);
  const b = src.indexOf(FLOOR_END);
  if (a < 0 || b <= a) {
    throw new Error(
      "could not build the mutant: workflows/ship.js has no CEREMONY-TIER-FLOOR marker pair to remove",
    );
  }

  let out = src.slice(0, a) + src.slice(b + FLOOR_END.length);
  out = out.replace(new RegExp(FLOOR_CALL_SITE.source, "m"), "");
  out = out.replace(new RegExp(RAISE_SITE.source, "m"), "");

  if (out === src) throw new Error("could not build the mutant: the removal changed nothing");
  if (out.includes("ceremonyTierFloor")) {
    throw new Error("could not build the mutant: the floor survived the removal");
  }
  if (matches(out, DOWNGRADE_SITE).length !== 1) {
    throw new Error("could not build the mutant: the removal took the downgrade with it");
  }
  return out;
}

// ── the five-observation suite, generated once and spawned twice ────────────

/**
 * The suite under spawn. It reads the ship.js it observes from
 * `SHIP_UNDER_TEST` and extracts nothing from this repo, so the identical file
 * is run against the real source and against the mutant.
 *
 * Nothing in it reads `ceremonyTier`. Each subsystem is observed through its
 * OWN output — `scopeRan`, the `quinn-local-1` agent label, the `env-check`
 * and `quinn-container` labels together with the container-declined arm's skip
 * log, the prove workflow's scriptPath, and the pre-flight log line. A
 * subsystem that is skipped produces none of those, which is the whole
 * mechanism.
 *
 * `String.raw` is load-bearing: the regexes below contain `\(`, `\s` and `\$`,
 * and an untagged template literal would eat every one of those backslashes
 * and leave detectors that match nothing.
 */
const SUITE_SOURCE = String.raw`
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const SHIP = process.env.SHIP_UNDER_TEST;
if (!SHIP) throw new Error("SHIP_UNDER_TEST is unset — this suite has nothing to observe");
const SRC = readFileSync(SHIP, "utf-8");

const START = "// ──── CEREMONY-TIER-FLOOR-START ────";
const END = "// ──── CEREMONY-TIER-FLOOR-END ────";

function hits(re) {
  return [...SRC.matchAll(new RegExp(re.source, "gm"))];
}

function one(re, label) {
  const found = hits(re);
  if (found.length !== 1) {
    throw new Error("could not locate " + label + " in the ship.js under test: " + found.length + " matches");
  }
  return found[0][0];
}

const HAS_UI = /^const hasUI = Object\.keys\(pagesConfig\)\.length > 0$/m;
const DOWNGRADE = /^if \(!hasUI && discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m;
const FLOOR_CALL = /^const flooredTier = ceremonyTierFloor\(discovery\.ceremonyTier, hasUI\)$/m;
const RAISE = /^if \(flooredTier !== discovery\.ceremonyTier\) \{[\s\S]*?\n\}$/m;

const SKIP_SCOPE = /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m;
const SCOPE_INVOKE = /^if \(!skipScope\) \{[\s\S]*?\n\}$/m;
const QUINN_LOCAL = /^if \(discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m;
const CONTAINER_VERIFY = /^if \(discovery\.ceremonyTier !== 'LIGHT' && containerConfig\) \{[\s\S]*?\n\} else if \(discovery\.ceremonyTier !== 'LIGHT'\) \{[\s\S]*?\n\}$/m;
const HAS_UI_ACS = /^const hasUIACs = .*$/m;
const SHOULD_PROVE = /^const shouldProve = discovery\.ceremonyTier !== 'LIGHT' && hasUIACs$/m;
const PROVE_BLOCK = /^if \(shouldProve\) \{[\s\S]*?\n\}$/m;
const REMOTE_HOSTS_DECL = /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}$/m;
const PREFLIGHT_RESULTS_DECL = /^const preflightResults = parsedArgs\.preflightResults \|\| null$/m;
const PREFLIGHT_BLOCK = /^if \(preflightResults\) \{[\s\S]*?\n\}$/m;

// The consumer fixture: a project that DECLARES pages, runs a test container
// and reaches a remote host, whose issue the discovery LLM sized XS. The
// rebuild command is an inert string carried in config and handed to a stub —
// nothing here delegates a rebuild to an agent or spawns a process.
const PAGES = { "/": "home", "/reports": "reports", "/settings": "settings" };
const CONTAINER = { hosts: ["localhost"], port: 7777, healthPath: "/api/health" };
const REMOTE_HOSTS = { runner: { host: "mini", purpose: "the self-hosted runner" } };
const DISCOVERED_TIER = "LIGHT";
const SKIP_LOG_FRAGMENT = "skipping container verify";

// ship.js's own tier statements, run IN SOURCE ORDER over the fixture. The
// floor sites are optional on purpose: a source that has none of them is
// exactly the pre-#215 source this is spawned against, and it must resolve a
// tier rather than throwing, or all five observations would go red together.
function resolveTier() {
  const parts = [];
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  if (a >= 0 && b > a) parts.push({ index: a, code: SRC.slice(a, b) });
  const sites = [
    [HAS_UI, "the hasUI computation", true],
    [DOWNGRADE, "the CLI downgrade", true],
    [FLOOR_CALL, "the floor call", false],
    [RAISE, "the tier raise", false],
  ];
  for (const [re, label, required] of sites) {
    const found = hits(re);
    if (found.length > 1) {
      throw new Error("could not locate " + label + ": " + found.length + " matches");
    }
    if (found.length === 0) {
      if (required) throw new Error("could not locate " + label + ": 0 matches");
      continue;
    }
    parts.push({ index: found[0].index, code: found[0][0] });
  }
  parts.sort((x, y) => x.index - y.index);
  const body = [
    "const discovery = { ceremonyTier: tier }",
    "const pagesConfig = pages",
    "const log = () => {}",
    ...parts.map((p) => p.code),
    "return discovery.ceremonyTier",
  ].join("\n");
  return new Function("tier", "pages", body)(DISCOVERED_TIER, Object.assign({}, PAGES));
}

const RESOLVED = resolveTier();

// Run a block lifted verbatim out of ship.js. Free identifiers resolve through
// a Proxy scope: the names the bag holds come from the bag, everything else
// (Object, JSON, String) falls through to the real globals, and assignments to
// the observables land back in the bag where the assertions can read them.
async function runBlock(code, extra) {
  const seen = { logs: [], labels: [], scripts: [] };
  const bag = Object.assign(
    {
      log: (m) => { seen.logs.push(String(m)); },
      briefedAgent: async (p, o) => { seen.labels.push(o && o.label); return { result: "PASS" }; },
      timedAgent: async (p, o) => {
        seen.labels.push(o && o.label);
        if (o && o.label === "env-check") return { host0: true };
        return { hosts: [{ name: "runner", reachable: true, output: "ok" }] };
      },
      workflow: async (w) => { seen.scripts.push(w && w.scriptPath); return { verdict: "PROVEN" }; },
      runGateWithHeal: async () => ({ result: "PASS" }),
      shellQuote: (s) => "'" + s + "'",
      safeSSHCommand: (h, c) => "ssh " + h + " " + c,
      HARNESS_ROOT: "/harness",
      PROJECT_ROOT: "/project",
      WORK_DIR: "/work",
      HOME: "/home",
      ISSUE: 274,
      REPO: "owner/repo",
      ISSUE_REPO: "owner/repo",
      SLUG: "pai-harness-274",
      GATE_RESULT_SCHEMA: {},
      marcusWorktreePath: "/worktree",
      testCommand: "bun test",
      testTimeout: 1000,
      containerConfig: null,
      parsedArgs: {},
      discovery: {
        ceremonyTier: RESOLVED,
        acs: [{ id: "AC-1", type: "OUTCOME", statement: "the dashboard renders" }],
      },
      scopeRan: false,
      scopeResult: null,
      quinnLocalResult: null,
      quinnLocalRan: false,
      quinnContainerResult: null,
      quinnContainerRan: false,
      proveVerdict: "UNPROVEN",
    },
    extra,
  );
  const scope = new Proxy(bag, {
    has: (t, k) => k in t,
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const run = new Function("__scope", "return (async () => { with (__scope) {\n" + code + "\n} })()");
  await run(scope);
  return { bag, seen };
}

describe("#274 the consumer fixture's tier-gated subsystems", () => {
  test("scope gate runs", async () => {
    const code = one(SKIP_SCOPE, "the skipScope decision") + "\n" + one(SCOPE_INVOKE, "the scope gate invocation");
    const { bag } = await runBlock(code, {});
    expect(bag.scopeRan).toBe(true);
  });

  test("quinn local runs", async () => {
    const { bag, seen } = await runBlock(one(QUINN_LOCAL, "the Quinn local loop"), {});
    expect(bag.quinnLocalRan).toBe(true);
    expect(seen.labels).toContain("quinn-local-1");
  });

  // One tier-gated STATEMENT, both of its arms. The container arm and the
  // container-declined arm share one branch point and one gate, so they are
  // one observation — and asserting both halves is what stops either going
  // quiet unnoticed inside a single green test.
  test("container verify runs", async () => {
    const code = one(CONTAINER_VERIFY, "the container verify arms");
    const withContainer = await runBlock(code, { containerConfig: CONTAINER });
    expect(withContainer.seen.labels).toContain("env-check");
    expect(withContainer.seen.labels).toContain("quinn-container");
    expect(withContainer.bag.quinnContainerRan).toBe(true);

    const withoutContainer = await runBlock(code, { containerConfig: null });
    expect(withoutContainer.seen.labels).toEqual([]);
    expect(withoutContainer.seen.logs.join("\n")).toContain(SKIP_LOG_FRAGMENT);
  });

  test("prove runs", async () => {
    const code = [
      one(HAS_UI_ACS, "the UI-AC detection"),
      one(SHOULD_PROVE, "the prove decision"),
      one(PROVE_BLOCK, "the prove invocation"),
    ].join("\n");
    const { bag, seen } = await runBlock(code, {});
    expect(seen.scripts.join("\n")).toContain("workflows/prove.js");
    expect(bag.proveVerdict).toBe("PROVEN");
  });

  test("remote pre-flight runs", async () => {
    const code = [
      one(REMOTE_HOSTS_DECL, "the remoteHosts read"),
      one(PREFLIGHT_RESULTS_DECL, "the preflightResults read"),
      one(PREFLIGHT_BLOCK, "the pre-flight block"),
    ].join("\n");
    const { seen } = await runBlock(code, { parsedArgs: { remoteHosts: REMOTE_HOSTS } });
    expect(seen.logs.filter((l) => l.startsWith("PRE-FLIGHT:")).length).toBe(1);
  });
});
`;

/** The five observation ids, by name. "1 of 5" is satisfied by any one of them. */
const ALL_IDS = [
  "container verify runs",
  "prove runs",
  "quinn local runs",
  "remote pre-flight runs",
  "scope gate runs",
];
const NOT_TIER_GATED = "remote pre-flight runs";
const TIER_GATED = ALL_IDS.filter((id) => id !== NOT_TIER_GATED);

let TMP = "";
let SUITE_PATH = "";
let JUNIT = "";
let MUTANT_PATH = "";
let mutantSource = "";

type SuiteRun = { ran: number; green: string[]; red: string[]; argv: string[]; output: string };

/**
 * Spawn the suite against one ship.js. The argv is returned so the two spawns
 * can be compared: "the same suite, spawned the same way" is the premise of
 * reading one against the other, and it is asserted rather than described.
 */
function spawnSuite(shipPath: string): SuiteRun {
  const argv = ["test", SUITE_PATH, "--reporter=junit", `--reporter-outfile=${JUNIT}`];
  if (existsSync(JUNIT)) rmSync(JUNIT);
  const r = spawnSync("bun", argv, {
    cwd: TMP,
    encoding: "utf-8",
    timeout: 180000,
    env: { ...process.env, SHIP_UNDER_TEST: shipPath },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const xml = existsSync(JUNIT) ? readFileSync(JUNIT, "utf-8") : "";
  const green: string[] = [];
  const red: string[] = [];
  for (const m of xml.matchAll(/<testcase name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[3] ?? "";
    (body.includes("<failure") || body.includes("<error") ? red : green).push(m[1]);
  }
  return {
    ran: green.length + red.length,
    green: green.sort(),
    red: red.sort(),
    argv,
    output: `${output}\n${xml}`,
  };
}

let real: SuiteRun;
let mutant: SuiteRun;

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "consumer-tier-mutation-"));
  SUITE_PATH = join(TMP, "five-subsystems.test.ts");
  JUNIT = join(TMP, "report.xml");
  MUTANT_PATH = join(TMP, "ship.mutant.js");
  writeFileSync(SUITE_PATH, SUITE_SOURCE);
  mutantSource = buildRestoredDowngradeMutant();
  writeFileSync(MUTANT_PATH, mutantSource);
  real = spawnSuite(SHIP);
  mutant = spawnSuite(MUTANT_PATH);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// ── the mutant is built, and the builder refuses when its target moves ──────

describe("#274 AC-3: the restored-downgrade mutant", () => {
  test("the downgrade site is located exactly once in ship.js", () => {
    expect(matches(shipSource, DOWNGRADE_SITE).length).toBe(1);
    expect(matches(shipSource, FLOOR_CALL_SITE).length).toBe(1);
    expect(matches(shipSource, RAISE_SITE).length).toBe(1);
  });

  test("the mutant drops the floor and keeps the downgrade", () => {
    expect(mutantSource).not.toBe(shipSource);
    expect(mutantSource).not.toContain("CEREMONY-TIER-FLOOR");
    expect(mutantSource).not.toContain("ceremonyTierFloor");
    expect(matches(mutantSource, DOWNGRADE_SITE).length).toBe(1);
  });

  test("the mutation is local: every subsystem block is byte-identical in the mutant", () => {
    // Without this the four reds below could be a mutant that damaged the
    // blocks rather than a mutant that resolved the wrong tier.
    for (const [label, re] of Object.entries(SUBSYSTEM_SITES)) {
      const before = matches(shipSource, re);
      const after = matches(mutantSource, re);
      expect(before.length, `${label} is not unique in ship.js`).toBe(1);
      expect(after.length, `${label} did not survive the mutation`).toBe(1);
      expect(after[0][0], `${label} was altered by the mutation`).toBe(before[0][0]);
    }
  });

  test("the build ABORTS when the downgrade site is renamed", () => {
    const renamed = shipSource.replace(
      "if (!hasUI && discovery.ceremonyTier !== 'LIGHT') {",
      "if (!hasUIProject && discovery.ceremonyTier !== 'LIGHT') {",
    );
    expect(renamed).not.toBe(shipSource);
    expect(() => buildRestoredDowngradeMutant(renamed)).toThrow(/could not build the mutant/);
    expect(() => buildRestoredDowngradeMutant(renamed)).toThrow(
      /the hasUI downgrade site appears 0 times/,
    );
  });

  test("the build ABORTS when a second copy of the downgrade exists", () => {
    const site = matches(shipSource, DOWNGRADE_SITE)[0][0];
    const doubled = shipSource.replace(site, `${site}\n${site}`);
    expect(() => buildRestoredDowngradeMutant(doubled)).toThrow(/could not build the mutant/);
  });

  test("the build ABORTS when the markers are gone", () => {
    const unmarked = shipSource.replace(FLOOR_START, "// nothing here");
    expect(() => buildRestoredDowngradeMutant(unmarked)).toThrow(
      /could not build the mutant: workflows\/ship\.js has no CEREMONY-TIER-FLOOR marker pair/,
    );
  });
});

// ── the real source, spawned ────────────────────────────────────────────────

describe("#274 AC-3: the five-observation suite against the real source", () => {
  test("the spawn ran all five observations", () => {
    // Read BEFORE any verdict: a suite that failed to load reports no
    // failures, which is indistinguishable from a suite that passed.
    expect(real.ran, `the suite did not run five observations:\n${real.output}`).toBe(5);
    expect(real.green.concat(real.red).sort()).toEqual(ALL_IDS);
  });

  test("all five are green", () => {
    expect(real.ran, `the suite did not run:\n${real.output}`).toBe(5);
    expect(real.red, `a subsystem did not run against the real source:\n${real.output}`).toEqual([]);
    expect(real.green).toEqual(ALL_IDS);
  });
});

// ── the mutant, spawned the same way ────────────────────────────────────────

describe("#274 AC-3: the same suite against the restored-downgrade mutant", () => {
  test("the mutant spawn ran all five observations", () => {
    expect(mutant.ran, `the suite did not run against the mutant:\n${mutant.output}`).toBe(5);
    expect(mutant.green.concat(mutant.red).sort()).toEqual(ALL_IDS);
  });

  test("both spawns used one argv and differed only in the source under test", () => {
    expect(mutant.argv).toEqual(real.argv);
    expect(MUTANT_PATH).not.toBe(SHIP);
  });

  test("exactly four tier-gated observations turn red", () => {
    expect(mutant.ran, `the suite did not run against the mutant:\n${mutant.output}`).toBe(5);
    expect(
      mutant.red.length,
      `the restored downgrade did not turn four tier-gated observations red:\n${mutant.output}`,
    ).toBe(4);
    expect(mutant.red).toEqual(TIER_GATED);
  });

  test("exactly one observation is green, and it is the remote pre-flight", () => {
    expect(mutant.ran, `the suite did not run against the mutant:\n${mutant.output}`).toBe(5);
    expect(mutant.green, `the wrong observation survived the mutation:\n${mutant.output}`).toEqual([
      NOT_TIER_GATED,
    ]);
  });

  test("the pre-flight is green in BOTH runs — it is not tier-gated", () => {
    // The positive control. If it were red under the mutant too, "4 red"
    // would be a suite that failed to load rather than a measurement.
    expect(real.green).toContain(NOT_TIER_GATED);
    expect(mutant.green).toContain(NOT_TIER_GATED);
  });
});
