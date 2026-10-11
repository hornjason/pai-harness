/**
 * #274 — the consumer fixture, and the `workflows/ship.js` sites it drives.
 *
 * rungate's own config declares `pages: {}`, no `container` and no
 * `remoteHosts`, so ship.js rewrites every self-run to LIGHT and five
 * tier-gated subsystems have never executed in this repo's history. A real
 * consumer (DailyBriefDashboard — 18 pages, a container, a remote host) differs
 * in exactly those facts and takes the other branch at all six sites.
 *
 * This module owns two things and nothing else:
 *
 * 1. The on-disk consumer fixture, loaded through the harness's OWN readers
 *    (`lib/config-loader.ts`, `gates/schema.ts`). The fixture is one fact in
 *    one place — `test/fixtures/consumer-ui-project/` — so a test cannot drift
 *    from the config a real consumer run would read.
 * 2. Extraction of the named `workflows/ship.js` sites, from the file on disk,
 *    with exactly-once enforced at every site.
 *
 * Every block below is SLICED OUT OF ship.js AND EXECUTED. Nothing matches
 * source text for the behaviour it claims — `.claude/rules/checks-must-be-able-to-fail.md`
 * records that every source-text assertion in this repo survived its first
 * mutation. The only lines this module contributes are the ones standing in for
 * `log`, the agent spawners and the nested `workflow()` call, none of which can
 * run outside the Workflow sandbox.
 *
 * Exactly-once is the point rather than a convenience: a second copy of a site
 * would let a proof silently exercise the wrong one, and zero copies means the
 * chain has moved and nothing here measures ship.js any more. "The statement was
 * not found" must never be indistinguishable from "the statement passed", so
 * every locator THROWS rather than returning an empty slice.
 */
import { readFileSync } from "fs";
import { join } from "path";

import { WorkflowStateSchema, type WorkflowState } from "../../gates/schema";
import { loadRungateConfig, type RungateConfig } from "../../lib/config-loader";

export const REPO_ROOT = join(import.meta.dir, "..", "..");
export const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
export const CONSUMER_FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "consumer-ui-project");

/** `workflows/ship.js` as it is ON DISK — never a copy pasted into a test. */
export const shipSource = readFileSync(SHIP_PATH, "utf-8");

// ── Locating ─────────────────────────────────────────────────────────────

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) throw new Error("countOccurrences: empty needle");
  return haystack.split(needle).length - 1;
}

export interface Slice {
  /** The name this module gives the site. */
  name: string;
  /** Verbatim ship.js source text, executable as-is. */
  text: string;
  /** Byte offset in ship.js, so source order is derived rather than assumed. */
  index: number;
}

/** The one occurrence of `re` in `source`, or a thrown error naming the site. */
export function one(source: string, re: RegExp, label: string): Slice {
  const all = [...source.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  if (all.length !== 1) {
    throw new Error(
      `could not locate ${label} in workflows/ship.js: ${re} appears ${all.length} times ` +
        `(expected exactly 1), so this harness proves nothing`,
    );
  }
  return { name: label, text: all[0][0], index: all[0].index! };
}

/** The contiguous region between two exactly-once anchors, both included. */
export function region(source: string, startRe: RegExp, endRe: RegExp, label: string): Slice {
  const start = one(source, startRe, `${label} (start)`);
  const end = one(source, endRe, `${label} (end)`);
  if (end.index <= start.index) {
    throw new Error(`${label} is inverted in workflows/ship.js — the end anchor precedes the start`);
  }
  return { name: label, text: source.slice(start.index, end.index + end.text.length), index: start.index };
}

/** A marker-delimited region (`// ──── NAME-START ────` … `-END`), markers included. */
export function markerRegion(source: string, marker: string): string {
  const start = `// ──── ${marker}-START ────`;
  const end = `// ──── ${marker}-END ────`;
  const a = countOccurrences(source, start);
  const b = countOccurrences(source, end);
  if (a !== 1 || b !== 1) {
    throw new Error(
      `workflows/ship.js has ${a} ${marker}-START and ${b} ${marker}-END markers (expected 1 of each)`,
    );
  }
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (to <= from) throw new Error(`the ${marker} markers are out of order in workflows/ship.js`);
  return source.slice(from, to + end.length);
}

/** A single statement, anchored on its own text. */
function statementSlice(source: string, name: string, literal: string): Slice {
  const n = countOccurrences(source, literal);
  if (n !== 1) {
    throw new Error(
      `could not extract the tier chain: the ${name} statement appears ${n} times in ` +
        `workflows/ship.js (expected exactly 1)`,
    );
  }
  return { name, text: literal, index: source.indexOf(literal) };
}

/**
 * A braced block, anchored on its header line and closed by brace matching.
 *
 * Brace matching rather than a line count: the log lines inside these blocks are
 * reworded often, and a slice that stopped at a fixed offset would start
 * executing half a statement without saying so.
 */
function blockSlice(source: string, name: string, header: string): Slice {
  const n = countOccurrences(source, header);
  if (n !== 1) {
    throw new Error(
      `could not extract the tier chain: the ${name} block header appears ${n} times in ` +
        `workflows/ship.js (expected exactly 1)`,
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
      if (depth === 0) return { name, text: source.slice(start, i + 1), index: start };
    }
  }
  throw new Error(`the ${name} block is never closed`);
}

// ── The tier-decision chain ──────────────────────────────────────────────

/**
 * `pagesConfig` and `hasUI` are ONE anchor because they are one computation:
 * splitting them would let a caller supply its own `pagesConfig` and never read
 * the loaded config at all.
 */
const HAS_UI_COMPUTATION =
  "const pagesConfig = projectConfig.pages || parsedArgs.pages || {}\n" +
  "const hasUI = Object.keys(pagesConfig).length > 0";
const DOWNGRADE_HEADER = "if (!hasUI && discovery.ceremonyTier !== 'LIGHT') {";
const FLOOR_CALL = "const flooredTier = ceremonyTierFloor(discovery.ceremonyTier, hasUI)";
const RAISE_HEADER = "if (flooredTier !== discovery.ceremonyTier) {";

export const CEREMONY_TIER_FLOOR_MARKER = "CEREMONY-TIER-FLOOR";

/** The named sites that make up the tier decision, in declaration order. */
export const TIER_SITES = [
  { name: "hasUI computation", kind: "statement", anchor: HAS_UI_COMPUTATION },
  { name: "!hasUI downgrade", kind: "block", anchor: DOWNGRADE_HEADER },
  { name: "ceremonyTierFloor call", kind: "statement", anchor: FLOOR_CALL },
  { name: "raise", kind: "block", anchor: RAISE_HEADER },
  { name: "ceremonyTierFloor definition", kind: "marker", anchor: CEREMONY_TIER_FLOOR_MARKER },
] as const;

/** `ceremonyTierFloor`'s definition, taken from its own markers in ship.js. */
function floorRegion(source: string): Slice {
  const text = markerRegion(source, CEREMONY_TIER_FLOOR_MARKER);
  if (!text.includes("function ceremonyTierFloor(")) {
    throw new Error(`the ${CEREMONY_TIER_FLOOR_MARKER} region no longer defines ceremonyTierFloor`);
  }
  return {
    name: "ceremonyTierFloor definition",
    text,
    index: source.indexOf(`// ──── ${CEREMONY_TIER_FLOOR_MARKER}-START ────`),
  };
}

/** The four tier STATEMENTS, located once each and returned in source order. */
export function tierChainSlices(source: string = shipSource): Slice[] {
  return [
    statementSlice(source, "hasUI computation", HAS_UI_COMPUTATION),
    blockSlice(source, "!hasUI downgrade", DOWNGRADE_HEADER),
    statementSlice(source, "ceremonyTierFloor call", FLOOR_CALL),
    blockSlice(source, "raise", RAISE_HEADER),
  ].sort((a, b) => a.index - b.index);
}

/**
 * The executable chain: the four statements plus the function the third one
 * calls, concatenated in the order their MEASURED OFFSETS put them in.
 *
 * Sorting by offset is what makes "in source order" a reading of ship.js rather
 * than a claim about the array literal above — and source order is the point:
 * the downgrade overwriting the floor is a regression this has to be able to
 * see, and only source order can see it.
 */
export function tierChainSource(source: string = shipSource): string {
  const pieces = [...tierChainSlices(source), floorRegion(source)].sort((a, b) => a.index - b.index);
  return pieces.map((p) => p.text).join("\n");
}

/** Every named site, with the count that was enforced to get it. */
export function namedShipSites(source: string = shipSource): Array<Slice & { occurrences: number }> {
  return [...tierChainSlices(source), floorRegion(source)]
    .sort((a, b) => a.index - b.index)
    .map((slice) => ({ ...slice, occurrences: countOccurrences(source, slice.text) }));
}

export interface ChainOutcome {
  tier: string;
  hasUI: boolean;
  pageCount: number;
  logs: string[];
}

/**
 * Run the extracted chain over one project config.
 *
 * `with` over a Proxy rather than a parameter list: the slices declare names
 * with `const`, and a parameter of the same name is a SyntaxError. Names the
 * sandbox does not carry fall through to the real globals, so `Object` still
 * resolves.
 */
export function runTierChain(
  projectConfig: unknown,
  discoveryTier: string | undefined,
  chain: string = tierChainSource(),
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

/**
 * ship.js's own `hasUIACs` expression, run over an AC set.
 *
 * What counts as UI evidence is ship.js's decision, and a predicate written out
 * here would keep agreeing with itself after ship.js changed its mind.
 */
export function runHasUIACs(acs: unknown[]): boolean {
  const slice = one(shipSource, /^const hasUIACs = .*$/m, "the hasUIACs computation");
  return new Function("discovery", `${slice.text}\nreturn hasUIACs`)({ acs });
}

// ── The fixture, through the harness's own readers ───────────────────────

export interface ConsumerFixture {
  root: string;
  configPath: string;
  statePath: string;
  /** `lib/config-loader.ts` — the loader ship.js's setup phase uses. */
  config: RungateConfig;
  /** The same object keyed loosely, for the consumer-only keys. */
  raw: Record<string, unknown>;
  /** `gates/schema.ts` — the validator every workflow-state write goes through. */
  state: WorkflowState;
}

/**
 * The consumer fixture, read from disk through the harness's own readers.
 *
 * Deliberately NOT a TypeScript literal. A fixture written twice — once as a
 * file and once as an object — is two facts that drift, and the object copy is
 * the one no consumer run would ever read.
 */
export function loadConsumerFixture(root: string = CONSUMER_FIXTURE_ROOT): ConsumerFixture {
  const configPath = join(root, ".claude", "rungate.json");
  const statePath = join(root, "workflow-state.json");
  const config = loadRungateConfig(root);
  const state = WorkflowStateSchema.passthrough().parse(
    JSON.parse(readFileSync(statePath, "utf-8")),
  ) as WorkflowState;
  return {
    root,
    configPath,
    statePath,
    config,
    raw: config as unknown as Record<string, unknown>,
    state,
  };
}

// ── The tier-gated subsystem blocks ──────────────────────────────────────
//
// Extracted LAZILY, so a moved anchor fails loudly in the test that needs the
// block rather than taking down every importer of this module at load time.

const memo = new Map<string, string>();
function lazy(key: string, build: () => string): string {
  if (!memo.has(key)) memo.set(key, build());
  return memo.get(key)!;
}

/**
 * ship.js's config-to-ceremony-tier chain as ONE contiguous slice — the dev
 * flatten, `pagesConfig`, `hasUI`, the test command, the floor definition, the
 * downgrade, the floor call and the raise.
 */
export const tierChainRegion = (): string =>
  lazy("tier-chain-region", () =>
    region(
      shipSource,
      /^if \(!projectConfig\.apiUrl && projectConfig\.dev\?\.apiBase\) projectConfig\.apiUrl = projectConfig\.dev\.apiBase$/m,
      /^if \(flooredTier !== discovery\.ceremonyTier\) \{\n[\s\S]*?\n\}$/m,
      "the config-to-ceremony-tier chain",
    ).text,
  );

/** `skipScope`, the gate call, the verdict and its log. */
export const scopeBlock = (): string =>
  lazy("scope", () =>
    region(
      shipSource,
      /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m,
      /^log\(`Scope: \$\{scopeVerdict\}`\)$/m,
      "the scope gate block",
    ).text,
  );

/** The Quinn-local loop and its LIGHT-tier else arm. */
export const quinnLocalBlock = (): string =>
  lazy("quinn-local", () =>
    region(
      shipSource,
      /^if \(discovery\.ceremonyTier !== 'LIGHT'\) \{$/m,
      // Anchored on the SHAPE of the else arm, not on what it says: the text of
      // that log line is asserted by RUNNING the block, and an anchor spelling
      // it out would turn a reworded message into "could not locate", which is
      // a different outcome from the assertion a caller makes.
      /^\} else \{\n {2}log\('Quinn local: .*'\)\n\}$/m,
      "the Quinn local block",
    ).text,
  );

/** The container-verdict holders the container block assigns. */
export const quinnContainerDecls = (): string =>
  lazy("quinn-container-decls", () =>
    region(
      shipSource,
      /^let quinnContainerResult = null$/m,
      /^let quinnContainerRan = false$/m,
      "the container Quinn declarations",
    ).text,
  );

/** The container config read. */
export const containerConfigDecl = (): string =>
  lazy("container-config", () =>
    one(shipSource, /^const containerConfig = projectConfig\.container \|\| null$/m, "the container config declaration")
      .text,
  );

/** Both arms of the container-verify function. */
export const containerBlock = (): string =>
  lazy("container", () =>
    region(
      shipSource,
      /^async function runContainerVerify\(\) \{$/m,
      /^\} else if \(discovery\.ceremonyTier !== 'LIGHT'\) \{\n[\s\S]*?\n\}\n\}$/m,
      "the container verify function",
    ).text,
  );

/** `hasUIACs`, the prove dispatch and its skip log. */
export const proveBlock = (): string =>
  lazy("prove", () =>
    region(shipSource, /^const hasUIACs = /m, /^log\(`Prove: \$\{proveVerdict\}`\)$/m, "the prove dispatch").text,
  );

/**
 * The remote pre-flight.
 *
 * It sits ~450 lines before `discovery.ceremonyTier` is first read, and that
 * asymmetry is load-bearing: this subsystem is NOT tier-gated, so it is the one
 * a LIGHT consumer still enters.
 */
export const preflightBlock = (): string =>
  lazy(
    "preflight",
    () => one(shipSource, /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}\n[\s\S]*?\n\}$/m, "the remote pre-flight block").text,
  );

/**
 * ship.js's own `safeSSHCommand`, extracted rather than stubbed — the pre-flight
 * filters out any host it refuses, and a stub that always returned a command
 * would let a fixture host reach the agent through a door the real run keeps
 * shut.
 */
export const securityHelpers = (): string => lazy("security-helpers", () => markerRegion(shipSource, "SECURITY-HELPERS"));

export type FixtureAC = {
  id: string;
  type?: string;
  statement?: string;
  evidenceMethod?: { type: string };
};

type AgentCall = { label: string; phase?: string };
type GateCall = { gate: string; phase: string };
type WorkflowCall = { scriptPath: string };

export interface Recorded {
  logs: string[];
  agentCalls: AgentCall[];
  agentLabels: string[];
  gateCalls: GateCall[];
  gateInvocations: string[];
  workflowCalls: WorkflowCall[];
  tier: string;
}

export interface RunOpts {
  /** A project config — by default the on-disk consumer fixture's. */
  config?: unknown;
  discoveryTier: string;
  acs?: FixtureAC[];
}

/**
 * Run a ship.js block with the module-scope names ship.js gives it, AFTER
 * running the real config-to-tier chain over the config in the same scope.
 *
 * The tier the block sees is therefore RESOLVED by ship.js from the config, not
 * a string this harness chose.
 */
export async function runShipBlock(block: string, opts: RunOpts): Promise<Recorded> {
  const fixture = loadConsumerFixture();
  const config = (opts.config ?? fixture.raw) as Record<string, any>;
  const acs = opts.acs ?? (fixture.state.acs as unknown as FixtureAC[]);

  const logs: string[] = [];
  const agentCalls: AgentCall[] = [];
  const gateCalls: GateCall[] = [];
  const workflowCalls: WorkflowCall[] = [];
  const tierBox = { tier: "UNRESOLVED" };

  const safeSSHCommand = new Function("log", `${securityHelpers()}\nreturn safeSSHCommand`)(() => {});

  const record = (label: string, phase: string | undefined, result: unknown) => {
    agentCalls.push({ label, phase });
    return Promise.resolve(result);
  };
  const timedAgent = (_p: string, o: { label: string; phase?: string }) =>
    record(
      o.label,
      o.phase,
      o.label === "env-check"
        ? { host0: true }
        : o.label === "preflight-batch"
          ? {
              hosts: Object.entries((config.remoteHosts || {}) as Record<string, { host?: string }>).map(
                ([name, c]) => ({ name, reachable: true, output: c.host }),
              ),
            }
          : {},
    );
  const briefedAgent = (_p: string, o: { label: string; phase?: string }) => record(o.label, o.phase, { result: "PASS" });
  const runGateWithHeal = (gate: string, phase: string) => {
    gateCalls.push({ gate, phase });
    return Promise.resolve({ result: "PASS" });
  };
  const workflow = (spec: { scriptPath: string }) => {
    workflowCalls.push({ scriptPath: spec.scriptPath });
    return Promise.resolve({ verdict: "PROVEN" });
  };

  const body = [
    "const log = (m) => { logs.push(String(m)) }",
    "const discovery = { ceremonyTier: discoveryTier, acs, filesToModify: ['lib/example.ts'] }",
    "const projectConfig = JSON.parse(JSON.stringify(config))",
    "const parsedArgs = { remoteHosts: config.remoteHosts || {}, preflightResults: null }",
    tierChainRegion(),
    "tierBox.tier = discovery.ceremonyTier",
    block,
  ].join("\n");

  const factory = new Function(
    "logs",
    "tierBox",
    "config",
    "discoveryTier",
    "acs",
    "timedAgent",
    "briefedAgent",
    "runGateWithHeal",
    "workflow",
    "safeSSHCommand",
    "shellQuote",
    "marcusWorktreePath",
    "GATE_RESULT_SCHEMA",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    "WORK_DIR",
    "ISSUE",
    "REPO",
    "ISSUE_REPO",
    "HOME",
    "SLUG",
    `return (async () => {\n${body}\n})()`,
  );

  await factory(
    logs,
    tierBox,
    config,
    opts.discoveryTier,
    acs,
    timedAgent,
    briefedAgent,
    runGateWithHeal,
    workflow,
    safeSSHCommand,
    (w: unknown) => `'${String(w)}'`,
    "/tmp/marcus-worktree",
    {},
    CONSUMER_FIXTURE_ROOT,
    REPO_ROOT,
    "/tmp/work",
    274,
    "example/consumer-ui-project",
    "example/consumer-ui-project",
    "/tmp/home",
    "consumer-ui-project-274",
  );

  return {
    logs,
    agentCalls,
    agentLabels: agentCalls.map((c) => c.label),
    gateCalls,
    gateInvocations: gateCalls.map((c) => c.gate),
    workflowCalls,
    tier: tierBox.tier,
  };
}

/** ship.js's scope gate, run against the fixture-resolved tier. */
export const runScopeGate = (opts: RunOpts): Promise<Recorded> => runShipBlock(scopeBlock(), opts);

/** ship.js's Quinn-local loop, run against the fixture-resolved tier. */
export const runQuinnLocal = (opts: RunOpts): Promise<Recorded> =>
  runShipBlock(["let quinnLocalResult = { result: 'PASS' }", "let quinnLocalRan = false", quinnLocalBlock()].join("\n"), opts);

/** ship.js's container verify and its skip arm. */
export const runContainerVerify = (opts: RunOpts): Promise<Recorded> =>
  runShipBlock(
    [quinnContainerDecls(), containerConfigDecl(), containerBlock(), "await runContainerVerify()"].join("\n"),
    opts,
  );

/** ship.js's prove dispatch and its SKIPPED log. */
export const runProveDispatch = (opts: RunOpts): Promise<Recorded> => runShipBlock(proveBlock(), opts);

/** ship.js's remote pre-flight, with the resolved tier in scope and unread. */
export const runRemotePreflight = (opts: RunOpts): Promise<Recorded> => runShipBlock(preflightBlock(), opts);

// ── The assertion scan ───────────────────────────────────────────────────

/** Skip a string or template literal starting at `i`; returns the index after it. */
function skipString(src: string, i: number): number {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === quote) return i + 1;
    else i++;
  }
  throw new Error("unterminated string literal in the scanned source");
}

/** The text inside the parenthesised group opening at `i` (`src[i] === "("`). */
function groupText(src: string, i: number): { text: string; end: number } {
  const open = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { text: src.slice(open + 1, i), end: i + 1 };
    }
    i++;
  }
  throw new Error("unbalanced assertion in the scanned source");
}

/**
 * The ceremony tiers, assembled rather than written out: a file scanned by this
 * function must not be able to trip over the scanner's own vocabulary if the
 * two ever end up in the same module.
 */
const TIER_WORDS = ["LIG" + "HT", "STAND" + "ARD", "THORO" + "UGH"];
const TIER_LITERAL = new RegExp(`['"\`](${TIER_WORDS.join("|")})['"\`]`);

export interface AssertionScan {
  /** Every `expect(...)` found. */
  total: number;
  /** The ACTUAL-value expressions that carry a tier literal the test wrote. */
  tierLiteralActuals: string[];
}

/**
 * Scan `source` for assertions whose ACTUAL value is a tier the test typed in.
 *
 * A tier a test wrote into the argument of `expect(...)` is a tier nothing
 * resolved — the assertion then holds over a chain that never ran. The EXPECTED
 * side (`.toBe('STANDARD')`) is deliberately not scanned: that is where a
 * hand-written value belongs, and flagging it would leave no way to state an
 * expectation at all.
 */
export function scanExpectActuals(source: string): AssertionScan {
  const tierLiteralActuals: string[] = [];
  let total = 0;
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const { text } = groupText(source, open);
    total++;
    if (TIER_LITERAL.test(text)) tierLiteralActuals.push(text.trim());
    re.lastIndex = open + 1;
  }
  return { total, tierLiteralActuals };
}
