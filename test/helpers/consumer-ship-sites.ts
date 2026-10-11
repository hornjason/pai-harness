import { readFileSync } from "fs";
import { join } from "path";

import { loadRungateConfig } from "../../lib/config-loader";

/**
 * #274 — the consumer fixture, and the `workflows/ship.js` sites it drives.
 *
 * rungate's own config declares `pages: {}`, no `container` and no
 * `remoteHosts`, so the CLI downgrade in ship.js rewrites every self-run to
 * LIGHT and five tier-gated subsystems have never executed in this repo's
 * history. A real consumer (DailyBriefDashboard — 18 pages, a container on the
 * Mac mini, a remote runner) differs in exactly those facts and takes the other
 * branch at every one of them.
 *
 * This module owns the extraction harness and the fixture READER; the
 * assertions live in `test/consumer-tier-gated-subsystems.test.ts`. The split
 * is deliberate: the test file is scanned for assertions that read the ceremony
 * tier back (there must be none), and the token has to live somewhere for the
 * scanner to look for it. Keeping it here keeps that scan from refuting itself.
 *
 * The fixture itself is NOT written here. It is loaded from
 * `test/fixtures/consumer-ui-project/.claude/rungate.json` through
 * `lib/config-loader.ts`, the loader ship.js's setup phase uses. Run
 * `wf_536df065-969` had two worktrees independently typing a consumer config
 * into TypeScript with different contents; one fact belongs in one place, and
 * the on-disk file is the one `test/consumer-ceremony-fixture.test.ts` already
 * validates.
 *
 * Every block below is SLICED OUT OF ship.js AND EXECUTED. Nothing matches
 * source text for the behaviour it claims — `.claude/rules/checks-must-be-able-to-fail.md`
 * records that every source-text assertion in this repo survived its first
 * mutation. The only lines this module contributes are the ones standing in
 * for `log`, the agent spawners and the nested `workflow()` call, none of which
 * can run outside the Workflow sandbox.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIP = join(REPO_ROOT, "workflows", "ship.js");
const FIXTURE_ROOT = join(REPO_ROOT, "test", "fixtures", "consumer-ui-project");
const shipSource = readFileSync(SHIP, "utf-8");

// ── extraction ───────────────────────────────────────────────

/**
 * The one occurrence of `re` in `source`, or a thrown error naming the site.
 *
 * Exactly-once is the point rather than a convenience: a second copy of any of
 * these sites would make the slice boundaries ambiguous, and a harness that
 * silently picked the first of two would execute code nobody meant to run.
 */
function one(source: string, re: RegExp, label: string): { text: string; index: number } {
  const all = [...source.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  if (all.length !== 1) {
    throw new Error(
      `could not locate ${label} in workflows/ship.js: ${re} matched ${all.length} times, ` +
        `so this harness proves nothing`,
    );
  }
  return { text: all[0][0], index: all[0].index! };
}

/** The contiguous region between two exactly-once anchors, both included. */
function region(startRe: RegExp, endRe: RegExp, label: string): string {
  const start = one(shipSource, startRe, `${label} (start)`);
  const end = one(shipSource, endRe, `${label} (end)`);
  if (end.index <= start.index) {
    throw new Error(`${label} is inverted in workflows/ship.js — the end anchor precedes the start`);
  }
  return shipSource.slice(start.index, end.index + end.text.length);
}

/**
 * The consumer-config flatten, `pagesConfig`, `hasUI`, the test command, the
 * CEREMONY-TIER-FLOOR block, the CLI downgrade, the floor call and the raise.
 *
 * Taken as ONE contiguous slice rather than as statements reassembled in an
 * order this file chose: the downgrade overwriting the floor is a regression
 * this has to be able to see, and only source order can see it.
 */
const TIER_CHAIN = region(
  /^if \(!projectConfig\.apiUrl && projectConfig\.dev\?\.apiBase\) projectConfig\.apiUrl = projectConfig\.dev\.apiBase$/m,
  /^if \(flooredTier !== discovery\.ceremonyTier\) \{\n[\s\S]*?\n\}$/m,
  "the config-to-ceremony-tier chain",
);

/** `skipScope`, the scope-verdict block, the gate call, the verdict and its log. */
const SCOPE_BLOCK = region(
  /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m,
  /^log\(`Scope: \$\{scopeVerdict\}`\)$/m,
  "the scope gate block",
);

/** The Quinn-local loop and its LIGHT-tier else arm. */
const QUINN_LOCAL_BLOCK = region(
  /^if \(discovery\.ceremonyTier !== 'LIGHT'\) \{$/m,
  // Anchored on the shape of the else arm, not on what it says. The text of
  // that log line is asserted by RUNNING the block; an anchor spelling it out
  // would turn a changed message into "could not locate", which is a different
  // outcome from the assertion the test file actually makes.
  /^\} else \{\n {2}log\('Quinn local: .*'\)\n\}$/m,
  "the Quinn local block",
);

/** The container-verdict holders the block assigns. */
const QUINN_CONTAINER_DECLS = region(
  /^let quinnContainerResult = null$/m,
  /^let quinnContainerRan = false$/m,
  "the container Quinn declarations",
);

/** The container config read. */
const CONTAINER_CONFIG_DECL = one(
  shipSource,
  /^const containerConfig = projectConfig\.container \|\| null$/m,
  "the container config declaration",
).text;

/** Both arms of the container-verify statement, function wrapper included. */
const CONTAINER_BLOCK = region(
  /^async function runContainerVerify\(\) \{$/m,
  // Same reason as above: the end anchor is the else-if arm and the two braces
  // that close it and the function, not the skip message inside it. The test
  // asserts that message by running the block.
  /^\} else if \(discovery\.ceremonyTier !== 'LIGHT'\) \{\n[\s\S]*?\n\}\n\}$/m,
  "the container verify function",
);

/** `hasUIACs`, the prove dispatch and its skip log. */
const PROVE_BLOCK = region(
  /^const hasUIACs = /m,
  /^log\(`Prove: \$\{proveVerdict\}`\)$/m,
  "the prove dispatch",
);

/**
 * The remote pre-flight.
 *
 * It sits ~450 lines before `discovery.ceremonyTier` is first read, and that
 * asymmetry is why it is observed separately: this one is NOT tier-gated, so
 * it is the one observation that must survive restoring the unconditional
 * LIGHT downgrade.
 */
const PREFLIGHT_BLOCK = one(
  shipSource,
  /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}\n[\s\S]*?\n\}$/m,
  "the remote pre-flight block",
).text;

/**
 * ship.js's own `shellQuote` and `safeSSHCommand`, extracted from the
 * SECURITY-HELPERS block rather than stubbed — the pre-flight filters out any
 * host it refuses, so a stub that always returned a command would make the
 * fixture's host reach the agent through a door the real run keeps shut.
 */
const SECURITY_HELPERS = region(
  /^\/\/ ──── SECURITY-HELPERS-START ────$/m,
  /^\/\/ ──── SECURITY-HELPERS-END ────$/m,
  "the security helpers block",
);

// ── the consumer fixture, read from disk ─────────────────────

export type FixtureAC = {
  id: string;
  type: string;
  statement: string;
  evidenceMethod?: { type: string };
};

export type ConsumerConfigLike = {
  pages: Record<string, string>;
  container?: {
    rebuildCommand?: string;
    hosts?: string[];
    port?: number;
    healthPath?: string;
  } | null;
  remoteHosts?: Record<string, { host?: string; purpose?: string; preFlightCmd?: string }>;
  dev?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * The consumer's config, LOADED from the on-disk fixture through the harness's
 * own loader. It differs from rungate's own in exactly the four facts that
 * matter: declared pages, a container, a remote host, and a nested `dev` block
 * the flatten lines have to unpack.
 */
export const CONSUMER_FIXTURE = loadRungateConfig(FIXTURE_ROOT) as unknown as ConsumerConfigLike;

/** The same consumer, with the container declined in config. */
export const CONSUMER_WITHOUT_CONTAINER: ConsumerConfigLike = {
  ...CONSUMER_FIXTURE,
  container: null,
};

/** rungate's own shape: `pages: {}`, which the downgrade rewrites to LIGHT. */
export const CONSUMER_CLI: ConsumerConfigLike = { ...CONSUMER_FIXTURE, pages: {} };

/** Gated out by the tier AND carrying no container — the contrast case. */
export const CONSUMER_CLI_WITHOUT_CONTAINER: ConsumerConfigLike = {
  ...CONSUMER_CLI,
  container: null,
};

const fixtureState = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, "workflow-state.json"), "utf-8"),
) as { acs: FixtureAC[]; sizing: { ceremonyTier: string } };

/**
 * The tier the fixture's DISCOVERY produced — `LIGHT`, because the issue is
 * sized XS.
 *
 * Every run below starts here rather than at a tier the test chose. That is
 * the whole consumer scenario: an XS issue on a project that declares pages.
 * Handing the blocks a `STANDARD` the test typed in would make the floor
 * irrelevant — the subsystems would run whether or not ship.js raised anything
 * — and the observations would stay green over the exact regression they exist
 * to catch.
 */
export const FIXTURE_TIER: string = fixtureState.sizing.ceremonyTier;

/**
 * The fixture's own AC set, read from its workflow-state.json.
 *
 * One OUTCOME/PLAYWRIGHT AC is what makes `hasUIACs` true and the prove
 * dispatch reachable — the fourth config fact a tier alone does not supply.
 */
export const UI_ACS: FixtureAC[] = fixtureState.acs;

/** The same set with every UI shape removed, so prove has nothing to prove. */
export const CODE_ONLY_ACS: FixtureAC[] = UI_ACS.map((ac) => ({
  ...ac,
  type: "CODE",
  evidenceMethod: { type: "BUN_TEST" },
}));

// ── execution ────────────────────────────────────────────────

type AgentCall = { label: string; phase?: string; role?: string };
type GateCall = { gate: string; phase: string };
type WorkflowCall = { scriptPath: string };

type Recorded = {
  logs: string[];
  agentCalls: AgentCall[];
  agentLabels: string[];
  gateCalls: GateCall[];
  gateInvocations: string[];
  workflowCalls: WorkflowCall[];
  tier: string;
};

type RunOpts = {
  config: ConsumerConfigLike;
  /** Defaults to the fixture's own discovered tier — see `FIXTURE_TIER`. */
  discoveryTier?: string;
  acs?: FixtureAC[];
};

const securityHelpers: { safeSSHCommand: (host: string, cmd: string) => string | null; shellQuote: (w: unknown) => string } =
  new Function(
    "log",
    `${SECURITY_HELPERS}\nreturn { safeSSHCommand, shellQuote }`,
  )(() => {});

/**
 * Run a ship.js block with the module-scope names ship.js gives it, after
 * running the real config-to-tier chain over the fixture in the same scope.
 *
 * The tier the block sees is therefore RESOLVED by ship.js from the fixture's
 * config, not a string this harness chose.
 *
 * `logs` and the call records are owned by the caller and closed over, so a
 * block that takes one of ship.js's early `return`s still reports what it did
 * before returning.
 */
async function runBlock(block: string, opts: RunOpts): Promise<Recorded> {
  const logs: string[] = [];
  const agentCalls: AgentCall[] = [];
  const gateCalls: GateCall[] = [];
  const workflowCalls: WorkflowCall[] = [];
  const tierBox = { tier: "UNRESOLVED" };

  const record = (o: AgentCall, result: unknown) => {
    agentCalls.push({ label: o.label, phase: o.phase, role: o.role });
    return Promise.resolve(result);
  };

  const timedAgent = (_p: string, o: AgentCall) =>
    record(
      o,
      o.label === "env-check"
        ? { host0: true }
        : o.label === "preflight-batch"
          ? {
              hosts: Object.entries(opts.config.remoteHosts || {}).map(([name, c]) => ({
                name,
                reachable: true,
                output: c.host,
              })),
            }
          : {},
    );
  const briefedAgent = (_p: string, o: AgentCall) => record(o, { result: "PASS" });

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
    "const discovery = { ceremonyTier: discoveryTier, acs, filesToModify: ['src/pages/reports.tsx'] }",
    "const projectConfig = JSON.parse(JSON.stringify(config))",
    "const parsedArgs = { remoteHosts: config.remoteHosts || {}, preflightResults: null }",
    TIER_CHAIN,
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
    opts.config,
    opts.discoveryTier ?? FIXTURE_TIER,
    opts.acs ?? UI_ACS,
    timedAgent,
    briefedAgent,
    runGateWithHeal,
    workflow,
    securityHelpers.safeSSHCommand,
    securityHelpers.shellQuote,
    "/tmp/marcus-worktree",
    {},
    "/tmp/consumer",
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
export function runScopeGate(opts: RunOpts): Promise<Recorded> {
  return runBlock(SCOPE_BLOCK, opts);
}

/** ship.js's Quinn-local loop, run against the fixture-resolved tier. */
export function runQuinnLocal(opts: RunOpts): Promise<Recorded> {
  return runBlock(
    ["let quinnLocalResult = { result: 'PASS' }", "let quinnLocalRan = false", QUINN_LOCAL_BLOCK].join(
      "\n",
    ),
    opts,
  );
}

/** ship.js's container verify and its container-declined arm. */
export function runContainerVerify(opts: RunOpts): Promise<Recorded> {
  return runBlock(
    [QUINN_CONTAINER_DECLS, CONTAINER_CONFIG_DECL, CONTAINER_BLOCK, "await runContainerVerify()"].join(
      "\n",
    ),
    opts,
  );
}

/** ship.js's prove dispatch and its SKIPPED log. */
export function runProveDispatch(opts: RunOpts): Promise<Recorded> {
  return runBlock(PROVE_BLOCK, opts);
}

/**
 * ship.js's remote pre-flight, with the resolved tier in scope and unread by
 * the block — which is the fact the pre-flight observations measure.
 */
export async function runRemotePreflight(
  opts: RunOpts,
): Promise<Recorded & { tiersDiffer: (other: { tier: string }) => boolean }> {
  const run = await runBlock(PREFLIGHT_BLOCK, opts);
  return { ...run, tiersDiffer: (other) => other.tier !== run.tier };
}

// ── the tier-reading scan ────────────────────────────────────

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

/** Skip a parenthesised group starting at `i` (`src[i] === "("`). */
function skipGroup(src: string, i: number): number {
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
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error("unbalanced assertion in the scanned source");
}

/** The full text of the assertion whose `expect(` opens at `open`, chain included. */
function assertionTextAt(src: string, open: number): string {
  let i = open;
  for (;;) {
    i = skipGroup(src, i);
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== ".") break;
    let k = j;
    while (k < src.length && src[k] !== "(" && src[k] !== ";" && src[k] !== "\n") k++;
    if (src[k] !== "(") break;
    i = k;
  }
  return src.slice(open, i);
}

/**
 * Every `expect(...)` in `source`, and how many of them read the ceremony tier.
 *
 * Proving a subsystem ran by reading back the tier that admitted it is
 * forbidden — the tier is the fixture's input, so an assertion on it stays
 * green over a subsystem that never executed. This counts the violations
 * mechanically rather than leaving the prohibition as a comment.
 *
 * The field name is assembled rather than written as a literal so that a scan
 * pointed at a file importing this one cannot be defeated — and cannot be
 * satisfied — by the scanner's own text.
 */
export function scanAssertions(source: string): { total: number; readingCeremonyTier: number } {
  const TIER_FIELD = "ceremony" + "Tier";
  let total = 0;
  let readingCeremonyTier = 0;
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const text = assertionTextAt(source, open);
    total++;
    if (text.includes(TIER_FIELD)) readingCeremonyTier++;
    re.lastIndex = open + 1;
  }
  return { total, readingCeremonyTier };
}

/**
 * Positive control for the scanner: two assertions, one of which reads the
 * tier. Held here so the test file can exercise the scanner's ability to SEE a
 * reading without putting one inside an assertion of its own.
 */
export const CONTROL_ASSERTIONS = [
  `expect(run.${"ceremony" + "Tier"}).toBe("STANDARD");`,
  `expect(run.logs).toContain("Scope: PASS");`,
].join("\n");
