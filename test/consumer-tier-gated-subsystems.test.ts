import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * #274 — the tier-gated `workflows/ship.js` subsystems a CONSUMER run enters,
 * observed by each subsystem's OWN output rather than by the tier string that
 * admitted it.
 *
 * rungate's own `.claude/rungate/config.json` declares `pages: {}`, so
 * `workflows/ship.js:1735` rewrites every self-run to LIGHT. Five tier-gated
 * branches have therefore never executed once in this repo's history. A real
 * consumer (DailyBriefDashboard — 18 pages, a container on a Mac mini, a
 * remote host) differs in exactly the facts that take the other branch. This
 * file builds that consumer's config as a FIXTURE and runs the real ship.js
 * blocks against it.
 *
 * Three properties make the observation honest, and all three are asserted
 * here rather than left as conventions:
 *
 * - **Nothing asserts on a tier.** A test that read `ceremonyTier` back would
 *   be re-reading the input the fixture planted, and would stay green over a
 *   subsystem that never ran. Every "it ran" assertion reads a gate invocation
 *   name, an agent label, a recorded agent phase/role, a workflow scriptPath,
 *   or the subsystem's own log line. The prohibition is MEASURED:
 *   `scanAssertions` counts the assertions in this file that name the tier
 *   field, and the count must be 0.
 * - **Nothing matches source text for the behaviour it claims.** Each block is
 *   marker- or anchor-extracted out of `workflows/ship.js` and EXECUTED via
 *   `new Function` — ship.js cannot be imported by the sandbox (#69), and
 *   `.claude/rules/checks-must-be-able-to-fail.md` records that every
 *   source-text assertion in this repo has survived its first mutation.
 * - **Every "it ran" is paired with a "it did not run"** driven by a real
 *   resolution of the same block over a different config, so a harness that
 *   recorded invocations unconditionally would go red.
 *
 * Nothing here runs `make rebuild`, podman or docker. The fixture carries a
 * `rebuildCommand` as an INERT STRING and the only thing that ever receives it
 * is a recording stub; `test/consumer-no-rebuild-delegation.test.ts` scans this
 * file and proves it.
 */

// ── the source under observation ─────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * `SHIP_UNDER_TEST` lets a mutation harness point this suite at a modified
 * copy of ship.js and spawn it unchanged. Unset, it observes the real file.
 */
const SHIP = process.env.SHIP_UNDER_TEST || join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP, "utf-8");

/**
 * The one occurrence of `re` in the ship source, or a thrown error naming the
 * site.
 *
 * Exactly-once is load-bearing rather than convenient: a second copy of any of
 * these sites makes the slice boundaries ambiguous, and a harness that
 * silently picked the first of two would execute code nobody meant to run.
 */
function one(re: RegExp, label: string): { text: string; index: number } {
  const all = [...shipSource.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  if (all.length !== 1) {
    throw new Error(
      `could not locate ${label} in ${SHIP}: ${re} matched ${all.length} times, so this harness proves nothing`,
    );
  }
  return { text: all[0][0], index: all[0].index! };
}

/** The contiguous region between two exactly-once anchors, both included. */
function region(startRe: RegExp, endRe: RegExp, label: string): string {
  const start = one(startRe, `${label} (start)`);
  const end = one(endRe, `${label} (end)`);
  if (end.index <= start.index) {
    throw new Error(`${label} is inverted in ${SHIP} — the end anchor precedes the start`);
  }
  return shipSource.slice(start.index, end.index + end.text.length);
}

/**
 * ship.js:208-421 — the real `safeSSHCommand` and `shellQuote`, extracted
 * rather than stubbed. The pre-flight filters out any host `safeSSHCommand`
 * refuses, so a stub that always returned a command would let the fixture's
 * host reach the agent through a door the real run keeps shut.
 */
const SECURITY_HELPERS = region(
  /^\/\/ ──── SECURITY-HELPERS-START ────$/m,
  /^\/\/ ──── SECURITY-HELPERS-END ────$/m,
  "the security helpers block",
);

/**
 * ship.js:1698-1744 — the consumer-config flatten, `pagesConfig`, `hasUI`, the
 * CEREMONY-TIER-FLOOR block (#215), the one-way downgrade and the raise.
 *
 * Taken as ONE contiguous slice in source order rather than as statements this
 * file reassembled: the downgrade overwriting the floor is the regression this
 * has to be able to see, and only source order can see it.
 */
const TIER_CHAIN = region(
  /^if \(!projectConfig\.apiUrl && projectConfig\.dev\?\.apiBase\) projectConfig\.apiUrl = projectConfig\.dev\.apiBase$/m,
  /^if \(flooredTier !== discovery\.ceremonyTier\) \{\n[\s\S]*?\n\}$/m,
  "the config-to-ceremony-tier chain",
);

/** ship.js:1832-1894 — `skipScope`, the gate call, the verdict and its log. */
const SCOPE_BLOCK = region(
  /^const skipScope = discovery\.ceremonyTier === 'LIGHT'$/m,
  /^log\(`Scope: \$\{scopeVerdict\}`\)$/m,
  "the scope gate block",
);

/**
 * ship.js:2378-2463 — the Quinn-local loop and its LIGHT arm.
 *
 * The end anchor is the SHAPE of the else arm, not what it says. The text of
 * that log line is asserted by RUNNING the block; an anchor spelling it out
 * would turn a reworded message into "could not locate", which is a different
 * outcome from the assertion this file makes.
 */
const QUINN_LOCAL_BLOCK = region(
  /^if \(discovery\.ceremonyTier !== 'LIGHT'\) \{$/m,
  /^\} else \{\n {2}log\('Quinn local: .*'\)\n\}$/m,
  "the Quinn local block",
);

/** ship.js:2374-2375 — the container-verdict holders the verify block assigns. */
const QUINN_CONTAINER_DECLS = region(
  /^let quinnContainerResult = null$/m,
  /^let quinnContainerRan = false$/m,
  "the container Quinn declarations",
);

/** ship.js:3753 — the container config read the verify block also requires. */
const CONTAINER_CONFIG_DECL = one(
  /^const containerConfig = projectConfig\.container \|\| null$/m,
  "the container config declaration",
).text;

/**
 * ship.js:3755-3832 — `runContainerVerify`, both arms. The end anchor is the
 * else-if arm and the braces closing it and the function, not the skip message
 * inside it, for the same reason as the Quinn local anchor.
 */
const CONTAINER_BLOCK = region(
  /^async function runContainerVerify\(\) \{$/m,
  /^\} else if \(discovery\.ceremonyTier !== 'LIGHT'\) \{\n[\s\S]*?\n\}\n\}$/m,
  "the container verify function",
);

/** ship.js:4802-4817 — `hasUIACs`, the prove dispatch and its skip log. */
const PROVE_BLOCK = region(
  /^const hasUIACs = /m,
  /^log\(`Prove: \$\{proveVerdict\}`\)$/m,
  "the prove dispatch",
);

/**
 * ship.js:1227-1277 — the remote pre-flight.
 *
 * It sits ~470 lines before `discovery.ceremonyTier` is first read, so it
 * CANNOT be tier-gated. That asymmetry is the point of the pre-flight group
 * below: it is the one subsystem in this file that must still be observed
 * running when the tier-gated four are gated out.
 */
const PREFLIGHT_BLOCK = one(
  /^const remoteHosts = parsedArgs\.remoteHosts \|\| \{\}\n[\s\S]*?\n\}$/m,
  "the remote pre-flight block",
).text;

// ── the consumer fixture ─────────────────────────────────────

type FixtureAC = {
  id: string;
  type: string;
  statement: string;
  evidenceMethod?: { type: string };
};

type ConsumerConfig = {
  pages: Record<string, string>;
  container: {
    rebuildCommand?: string;
    hosts?: string[];
    port?: number;
    healthPath?: string;
  } | null;
  remoteHosts: Record<string, { host?: string; purpose?: string; preFlightCmd?: string }>;
  dev: Record<string, string>;
};

/**
 * A consumer's config, shaped like DailyBriefDashboard's `.claude/rungate.json`
 * and differing from rungate's own in exactly the four facts that matter:
 * declared pages, a container block, a remote host, and a nested `dev` block
 * the flatten lines have to unpack.
 *
 * `rebuildCommand` is DDB's real value and is carried here as DATA. No code in
 * this repo executes it; `test/consumer-no-rebuild-delegation.test.ts` scans
 * for an execution of it and asserts there is none, while asserting the string
 * IS present — so that scan cannot pass by the text simply being absent.
 */
const CONSUMER_FIXTURE: ConsumerConfig = {
  pages: { dashboard: "/", briefs: "/briefs", settings: "/settings", sources: "/sources" },
  container: {
    rebuildCommand: "make rebuild",
    hosts: ["mini.local"],
    port: 7776,
    healthPath: "/health",
  },
  remoteHosts: {
    mini: { host: "mini.local", purpose: "container host", preFlightCmd: "hostname" },
  },
  dev: {
    apiBase: "http://localhost:7777/api",
    uiBase: "http://localhost:7777",
    testCmd: "bun test",
  },
};

/** The same consumer with the container declined in config. */
const CONSUMER_WITHOUT_CONTAINER: ConsumerConfig = { ...CONSUMER_FIXTURE, container: null };

/** rungate's own shape — `pages: {}`, which the one-way downgrade rewrites to LIGHT. */
const CONSUMER_CLI: ConsumerConfig = { ...CONSUMER_FIXTURE, pages: {} };

/** Gated out by the tier AND carrying no container — the two-reasons contrast. */
const CONSUMER_CLI_WITHOUT_CONTAINER: ConsumerConfig = { ...CONSUMER_CLI, container: null };

const UI_ACS: FixtureAC[] = [
  {
    id: "AC-1",
    type: "OUTCOME",
    statement: "the briefs page lists today's briefs",
    evidenceMethod: { type: "PLAYWRIGHT" },
  },
  {
    id: "AC-2",
    type: "CODE",
    statement: "the brief loader dedupes by source",
    evidenceMethod: { type: "BUN_TEST" },
  },
];

const CODE_ONLY_ACS: FixtureAC[] = [
  {
    id: "AC-1",
    type: "CODE",
    statement: "the brief loader dedupes by source",
    evidenceMethod: { type: "BUN_TEST" },
  },
  {
    id: "AC-2",
    type: "CODE",
    statement: "the loader refuses an unparseable feed",
    evidenceMethod: { type: "COMMAND" },
  },
];

const isUIShaped = (ac: FixtureAC) =>
  ac.type === "OUTCOME" ||
  ac.evidenceMethod?.type === "PLAYWRIGHT" ||
  ac.evidenceMethod?.type === "SCREENSHOT";

// ── execution ────────────────────────────────────────────────

type AgentCall = { label: string; phase?: string; role?: string; prompt: string };
type GateCall = { gate: string; phase: string };
type WorkflowCall = { scriptPath: string };

type Recorded = {
  logs: string[];
  agentCalls: AgentCall[];
  agentLabels: string[];
  gateCalls: GateCall[];
  gateInvocations: string[];
  workflowCalls: WorkflowCall[];
  /** Set by the recording stubs only. Proves the stub, and nothing else, served the call. */
  recordedBy: string[];
  resolvedTier: string;
};

type RunOpts = {
  config: ConsumerConfig;
  discoveryTier: string;
  acs?: FixtureAC[];
};

/** A sentinel only the local recorders write, so "stubbed" is observed, not assumed. */
const RECORDER = "local-recording-stub";

/**
 * Run one extracted ship.js block under the module-scope names ship.js gives
 * it, after running the REAL config-to-tier chain over the fixture in the same
 * scope. The tier the block sees is therefore resolved by ship.js from the
 * fixture's config — not a string this harness chose.
 *
 * The record arrays are owned by the caller and closed over, so a block that
 * takes one of ship.js's early `return`s still reports what it did first.
 */
async function runBlock(block: string, opts: RunOpts): Promise<Recorded> {
  const logs: string[] = [];
  const agentCalls: AgentCall[] = [];
  const gateCalls: GateCall[] = [];
  const workflowCalls: WorkflowCall[] = [];
  const recordedBy: string[] = [];
  const tierBox = { tier: "UNRESOLVED" };

  const record = (prompt: string, o: { label: string; phase?: string; role?: string }, result: unknown) => {
    agentCalls.push({ label: o.label, phase: o.phase, role: o.role, prompt: String(prompt) });
    recordedBy.push(RECORDER);
    return Promise.resolve(result);
  };

  const timedAgent = (p: string, o: { label: string; phase?: string; role?: string }) =>
    record(
      p,
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

  const briefedAgent = (p: string, o: { label: string; phase?: string; role?: string }) =>
    record(p, o, { result: "PASS" });

  const runGateWithHeal = (gate: string, phase: string) => {
    gateCalls.push({ gate, phase });
    recordedBy.push(RECORDER);
    return Promise.resolve({ result: "PASS" });
  };

  const workflow = (spec: { scriptPath: string }) => {
    workflowCalls.push({ scriptPath: spec.scriptPath });
    recordedBy.push(RECORDER);
    return Promise.resolve({ verdict: "PROVEN" });
  };

  const body = [
    "const log = (m) => { logs.push(String(m)) }",
    "const discovery = { ceremonyTier: discoveryTier, acs, filesToModify: ['lib/briefs.ts'] }",
    "const projectConfig = JSON.parse(JSON.stringify(config))",
    "const parsedArgs = { remoteHosts: config.remoteHosts || {}, preflightResults: null }",
    SECURITY_HELPERS,
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
    opts.discoveryTier,
    opts.acs ?? UI_ACS,
    timedAgent,
    briefedAgent,
    runGateWithHeal,
    workflow,
    "/tmp/marcus-worktree",
    {},
    "/tmp/consumer-project",
    REPO_ROOT,
    "/tmp/consumer-work",
    274,
    "hornjason/pai-harness",
    "hornjason/pai-harness",
    "/tmp/consumer-home",
    "consumer-274",
  );

  return {
    logs,
    agentCalls,
    agentLabels: agentCalls.map((c) => c.label),
    gateCalls,
    gateInvocations: gateCalls.map((c) => c.gate),
    workflowCalls,
    recordedBy,
    resolvedTier: tierBox.tier,
  };
}

/** ship.js's scope gate, run against the fixture-resolved tier. */
const runScopeGate = (opts: RunOpts) => runBlock(SCOPE_BLOCK, opts);

/** ship.js's Quinn-local loop, run against the fixture-resolved tier. */
const runQuinnLocal = (opts: RunOpts) =>
  runBlock(
    ["let quinnLocalResult = null", "let quinnLocalRan = false", QUINN_LOCAL_BLOCK].join("\n"),
    opts,
  );

/** ship.js's container verify and its container-less else arm. */
const runContainerVerify = (opts: RunOpts) =>
  runBlock(
    [QUINN_CONTAINER_DECLS, CONTAINER_CONFIG_DECL, CONTAINER_BLOCK, "await runContainerVerify()"].join("\n"),
    opts,
  );

/** ship.js's prove dispatch and its SKIPPED log. */
const runProveDispatch = (opts: RunOpts) => runBlock(PROVE_BLOCK, opts);

/** ship.js's remote pre-flight, with the resolved tier in scope and unread by the block. */
const runRemotePreflight = (opts: RunOpts) => runBlock(PREFLIGHT_BLOCK, opts);

/**
 * Whether two runs resolved the tier differently. Returned as a BOOLEAN
 * comparison made by the harness so the premise can be checked without any
 * assertion in this file naming the tier field — which the self-scan forbids.
 */
const tiersDiffer = (a: Recorded, b: Recorded) => a.resolvedTier !== b.resolvedTier;

// ── the assertion scanner ────────────────────────────────────

/**
 * Blank out everything that is not executable code — line comments, block
 * comments, string and template literals, and regex literals — leaving a
 * same-length string whose surviving characters are code and nothing else.
 *
 * Masking rather than stripping, and masking rather than a regex, because this
 * file's whole subject is detectors narrower than what they detect. A regex
 * strip of template literals is the exact mutation
 * `.claude/rules/checks-must-be-able-to-fail.md` records as having deleted 61%
 * of a guard's input; and a scan that counted `expect(` inside its own prose
 * would be reading documentation as assertions, which is how the first draft
 * of this scanner died.
 *
 * Positions are preserved so the caller can slice the ORIGINAL source at the
 * indices found here.
 */
function maskNonCode(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };

  /** Skip a quoted run at `i`, recursing through `${...}` inside templates. */
  const skipQuoted = (i: number): number => {
    const quote = src[i];
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && c === "$" && src[i + 1] === "{") {
        i = skipBraces(i + 1);
        continue;
      }
      if (c === quote) return i + 1;
      i++;
    }
    throw new Error("unterminated string literal in the scanned source");
  };

  /** Skip a `{...}` run at `i`, honouring nested quotes. */
  const skipBraces = (i: number): number => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"' || c === "`") {
        i = skipQuoted(i);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error("unterminated template substitution in the scanned source");
  };

  /** Whether a `/` after `prev` opens a regex literal rather than dividing. */
  const regexCanStart = (prev: string) => prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);

  const skipRegex = (i: number): number => {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") throw new Error("unterminated regex literal in the scanned source");
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i++;
        while (i < src.length && /[a-z]/.test(src[i])) i++;
        return i;
      }
      i++;
    }
    throw new Error("unterminated regex literal in the scanned source");
  };

  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = skipQuoted(i);
      blank(i, end);
      prev = '"';
      i = end;
      continue;
    }
    if (c === "/" && regexCanStart(prev)) {
      const end = skipRegex(i);
      blank(i, end);
      prev = "/";
      i = end;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** Skip a parenthesised group starting at `i` in already-masked code. */
function skipGroup(code: string, i: number): number {
  let depth = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new Error("unbalanced assertion in the scanned source");
}

/** The end index of the assertion whose `expect(` opens at `open`, chain included. */
function assertionEndAt(code: string, open: number): number {
  let i = open;
  for (;;) {
    i = skipGroup(code, i);
    let j = i;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== ".") break;
    let k = j;
    while (k < code.length && code[k] !== "(" && code[k] !== ";" && code[k] !== "\n") k++;
    if (code[k] !== "(") break;
    i = k;
  }
  return i;
}

/**
 * Every `expect(...)` in `source`, and how many of them name the ceremony tier
 * field.
 *
 * Proving a subsystem ran by reading back the tier that admitted it is reading
 * the fixture's own input: the assertion stays green over a subsystem that
 * never executed. This counts the violations mechanically rather than leaving
 * the prohibition as a comment.
 *
 * It counts over the MASKED source, so an `expect(` written in prose or inside
 * a string is not an assertion, and the tier field is only a reading when it
 * appears in code — a field name quoted inside a message is not an access.
 *
 * The field name is ASSEMBLED rather than written as a literal, so the
 * scanner's own text can neither defeat nor satisfy a scan pointed at the file
 * that holds it.
 */
function scanAssertions(source: string): { total: number; readingCeremonyTier: number } {
  const TIER_FIELD = "ceremony" + "Tier";
  const code = maskNonCode(source);
  let total = 0;
  let readingCeremonyTier = 0;
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const end = assertionEndAt(code, open);
    total++;
    if (code.slice(open, end).includes(TIER_FIELD)) readingCeremonyTier++;
    re.lastIndex = open + 1;
  }
  return { total, readingCeremonyTier };
}

/**
 * Positive control for the scanner: two assertions, one of which reads the
 * tier. Held as a const rather than written inline so that exercising the
 * scanner's ability to SEE a reading does not put one inside an assertion in
 * this file and make the scan self-refuting.
 */
const CONTROL_ASSERTIONS = [
  `expect(run.${"ceremony" + "Tier"}).toBe("STANDARD");`,
  `expect(run.logs).toContain("Scope: PASS");`,
].join("\n");

const SELF_SOURCE = readFileSync(join(import.meta.dir, "consumer-tier-gated-subsystems.test.ts"), "utf-8");

// ── 1 of 5: the scope gate, by its own gate invocation ───────

describe("#274: the scope gate executes on the consumer fixture", () => {
  test("the fixture-resolved run records a gate invocation named scope", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    // The gate's own output: what `runGateWithHeal` was asked to run. Not the
    // tier that let it through, and not a `skipScope` boolean this file set.
    expect(run.gateInvocations).toEqual(["scope"]);
  });

  test("the invocation carries the gate's phase, so it is a real call site", async () => {
    const run = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    expect(run.gateCalls[0]?.phase).toBe("Scope");
  });

  test("the same block over a pages:{} config records no invocation at all", async () => {
    const run = await runScopeGate({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.gateInvocations).toEqual([]);
  });

  test("the two runs are distinguishable by the gate's own verdict line", async () => {
    // Vacuity guard for the pair above: if the harness silently failed to
    // execute the block at all, both runs would record nothing and the
    // not-ran case would pass for a reason that has nothing to do with the tier.
    const ran = await runScopeGate({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const skipped = await runScopeGate({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(ran.logs).toContain("Scope: PASS");
    expect(skipped.logs).toContain("Scope: SKIPPED");
  });
});

// ── 2 of 5: Quinn local, by its own agent label ──────────────

describe("#274: Quinn local executes, observed by its own agent label", () => {
  test("the fixture run spawns the quinn-local agent", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    expect(run.agentLabels).toContain("quinn-local-1");
  });

  test("the spawn is recorded with Quinn's own phase and role", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const call = run.agentCalls.find((c) => c.label === "quinn-local-1");
    expect(call?.phase).toBe("Validate");
    expect(call?.role).toBe("quinn");
  });

  test("the same block over a pages:{} config spawns nothing and says why", async () => {
    const run = await runQuinnLocal({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toEqual([]);
    expect(run.logs).toContain("Quinn local: SKIPPED (LIGHT tier)");
  });
});

// ── 3 of 5: container verify, by its two agent labels ────────

describe("#274: the container path executes, observed by its own labels", () => {
  test("the fixture declares the container facts this path requires", () => {
    expect(Object.keys(CONSUMER_FIXTURE.container ?? {}).length).toBe(4);
    expect(CONSUMER_FIXTURE.container?.hosts).toEqual(["mini.local"]);
  });

  test("the container rebuild and the container Quinn are both spawned", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    expect(run.agentLabels).toContain("container-rebuild");
    expect(run.agentLabels).toContain("quinn-container");
  });

  test("the env check's own log names the host the fixture declared", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const host = CONSUMER_FIXTURE.container!.hosts![0];
    expect(run.logs.some((l) => l.startsWith("Container env:") && l.includes(`${host}=true`))).toBe(true);
  });

  test("the rebuild command reaches a recording stub as text and goes no further", async () => {
    // The whole of the no-rebuild prohibition at this site: ship.js builds a
    // PROMPT containing the consumer's rebuild command and hands it to an
    // agent. Here that agent is a local recorder, so the command is carried as
    // a string and nothing is delegated. `recordedBy` is written only by the
    // recorders in this file, so "stubbed" is observed rather than assumed.
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const rebuild = run.agentCalls.find((c) => c.label === "container-rebuild");
    expect(rebuild?.prompt).toContain(CONSUMER_FIXTURE.container!.rebuildCommand!);
    expect(new Set(run.recordedBy)).toEqual(new Set([RECORDER]));
  });

  test("the same block over a pages:{} config spawns neither, with the same container", async () => {
    const run = await runContainerVerify({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.agentLabels).toEqual([]);
  });
});

// ── 4 of 5: the container-less arm, by the reason it gives ───

const DECLINED_LOG = "No container config in rungate.json — skipping container verify";

describe("#274: the Quinn-verify arm distinguishes a declined config from a gated-out tier", () => {
  test("a consumer that declined the container is told so by name", async () => {
    const run = await runContainerVerify({
      config: CONSUMER_WITHOUT_CONTAINER,
      discoveryTier: "LIGHT",
    });
    expect(run.logs).toContain(DECLINED_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("a run gated out with the same absent container stays silent", async () => {
    // Same missing container, different reason. Without this pair the log
    // above would only prove the string exists somewhere in ship.js.
    const run = await runContainerVerify({
      config: CONSUMER_CLI_WITHOUT_CONTAINER,
      discoveryTier: "STANDARD",
    });
    expect(run.logs).not.toContain(DECLINED_LOG);
    expect(run.agentLabels).toEqual([]);
  });

  test("the fixture WITH a container takes neither arm", async () => {
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    expect(run.logs).not.toContain(DECLINED_LOG);
  });

  test("the Quinn that verifies at Verify is recorded with that phase and role", async () => {
    // There is no `quinn-verify` label in workflows/ship.js. The Quinn that
    // runs in the Verify phase is `quinn-container`, and this reads the phase
    // and role ship.js recorded for it rather than taking the label's word.
    const run = await runContainerVerify({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const call = run.agentCalls.find((c) => c.label === "quinn-container");
    expect(call?.phase).toBe("Verify");
    expect(call?.role).toBe("quinn");
  });
});

// ── 5 of 5: prove, by the workflow scriptPath it dispatched ──

describe("#274: prove dispatches the prove workflow for the fixture's UI ACs", () => {
  test("the captured workflow call points at workflows/prove.js", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      discoveryTier: "LIGHT",
      acs: UI_ACS,
    });
    const paths = run.workflowCalls.map((c) => c.scriptPath);
    expect(paths.filter((p) => p.endsWith("workflows/prove.js")).length).toBe(1);
  });

  test("with the UI ACs removed it skips instead, by its own log", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_FIXTURE,
      discoveryTier: "LIGHT",
      acs: CODE_ONLY_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
    expect(run.logs.some((l) => l.startsWith("Prove: SKIPPED"))).toBe(true);
  });

  test("the same UI ACs over a pages:{} config dispatch nothing", async () => {
    const run = await runProveDispatch({
      config: CONSUMER_CLI,
      discoveryTier: "STANDARD",
      acs: UI_ACS,
    });
    expect(run.workflowCalls).toEqual([]);
  });

  test("the AC sets are what makes the difference, not the harness", () => {
    // The first two runs differ in exactly one input. If UI_ACS carried no
    // UI-shaped AC the dispatch assertion would be reading an empty branch.
    expect(UI_ACS.filter(isUIShaped).length).toBe(1);
    expect(CODE_ONLY_ACS.filter(isUIShaped).length).toBe(0);
  });
});

// ── the non-tier-gated control: the remote pre-flight ────────

describe("#274: the remote pre-flight is observed at both tiers and is green in both", () => {
  test("the STANDARD-resolving consumer emits a PRE-FLIGHT line for its host", async () => {
    const run = await runRemotePreflight({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    expect(run.logs.filter((l) => l.startsWith("PRE-FLIGHT: mini (mini.local)")).length).toBe(1);
  });

  test("the LIGHT-resolving consumer emits the same line for the same host", async () => {
    // The pre-flight sits ~470 lines before the tier is first read, so this is
    // the one observation in this file that must survive the tier being gated
    // down. It is the positive control for the downgrade mutation (#274 SC-3).
    const run = await runRemotePreflight({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(run.logs.filter((l) => l.startsWith("PRE-FLIGHT: mini (mini.local)")).length).toBe(1);
  });

  test("the batched pre-flight agent is spawned in both runs", async () => {
    const standard = await runRemotePreflight({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const light = await runRemotePreflight({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect([...standard.agentLabels, ...light.agentLabels]).toEqual([
      "preflight-batch",
      "preflight-batch",
    ]);
  });

  test("the two runs really did resolve differently, so the pair is not one case twice", async () => {
    const standard = await runRemotePreflight({ config: CONSUMER_FIXTURE, discoveryTier: "LIGHT" });
    const light = await runRemotePreflight({ config: CONSUMER_CLI, discoveryTier: "STANDARD" });
    expect(tiersDiffer(standard, light)).toBe(true);
  });

  test("a consumer with no remote hosts emits nothing, so the log is load-bearing", async () => {
    const run = await runRemotePreflight({
      config: { ...CONSUMER_FIXTURE, remoteHosts: {} },
      discoveryTier: "LIGHT",
    });
    expect(run.logs.filter((l) => l.startsWith("PRE-FLIGHT:"))).toEqual([]);
    expect(run.agentLabels).toEqual([]);
  });
});

// ── the prohibition, measured over this file ─────────────────

describe("#274: no assertion in this file reads the ceremony tier field", () => {
  test("the scan finds 0 assertions naming it", () => {
    expect(scanAssertions(SELF_SOURCE).readingCeremonyTier).toBe(0);
  });

  test("the scan has something to look at", () => {
    // Vacuity guard: a scanner that found no assertions at all would report 0
    // forever, including over a file that read the tier on every line.
    expect(scanAssertions(SELF_SOURCE).total).toBeGreaterThan(40);
  });

  test("the scan can see a reading when there is one", () => {
    expect(scanAssertions(CONTROL_ASSERTIONS).readingCeremonyTier).toBe(1);
    expect(scanAssertions(CONTROL_ASSERTIONS).total).toBe(2);
  });

  test("the scan is pointed at this file and not an empty read", () => {
    expect(SELF_SOURCE).toContain("#274: the scope gate executes on the consumer fixture");
  });

  test("prose and quoted text are not assertions, and code still is", () => {
    // The first draft of this scanner counted the `expect(` written inside its
    // own doc comments and then died trying to balance parentheses across
    // English prose with an apostrophe in it. A detector that cannot tell a
    // sentence from a statement is the shape this repo's rule file names.
    const sample = [
      "// expect(run.a).toBe(1) — the scanner's own prose, not an assertion",
      "/* expect(run.b).toBe(2) */",
      'const s = "expect(run.c).toBe(3)";',
      "expect(run.d).toBe(4);",
    ].join("\n");
    expect(scanAssertions(sample).total).toBe(1);
  });

  test("a regex literal holding a quote does not derail the scan", () => {
    // Every anchor at the top of this file is a regex containing `'LIGHT'`.
    // A masker that treated those quotes as string delimiters would swallow
    // the rest of the file and report 0 assertions — green, and blind.
    const sample = ["const re = /log\\('Quinn local: .*'\\)/m;", "expect(re.test(x)).toBe(true);"].join("\n");
    expect(scanAssertions(sample).total).toBe(1);
  });
});
