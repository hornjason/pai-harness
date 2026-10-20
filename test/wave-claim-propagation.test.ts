/**
 * Covers SC-2058..SC-2063 (PARALLEL-AGENT-COORDINATION-SPEC.md), #627.
 *
 * #420 made wave N's output visible to wave N+1 by committing it mid-run, and
 * it stages that output through the SAME collector the end-of-run path uses.
 * The two paths did not hand it the same rows.
 *
 * The end-of-run path pairs each sub-issue's `buildResult` with the claim the
 * plan issued for it (`subIssue.filesToModify`) — which is the whole of #178 /
 * SC-413: the manifest reaches the agent as prose, and only the pairing on the
 * way back makes it checkable. `integrateWave` did
 *
 *     accepted.map(r => r && r.buildResult)
 *
 * which drops `subIssue` on the floor. Every row then reaches
 * `auditWorktreeClaims` with no `claimedFiles`, and in a multi-worktree wave
 * that is not "unconstrained" — it is "no worktree claimed that file", for
 * every file in every worktree. So the collection is refused, the wave cannot
 * be integrated, and the run fails. ANY decomposition with more than one wave
 * died there, regardless of how good the work was.
 *
 * Two deciders cannot both own that pairing (`checks-must-be-able-to-fail.md`,
 * the fourth shape), so there is one binding — `claimedWorktreeRow` — and both
 * staging paths call it.
 *
 * What is asserted here is NOT "the collection succeeded". A collection can be
 * made to succeed by widening the audit until it permits an absent claim, and
 * that is the cheapest repair available to anyone who sees this test red (the
 * fifth shape). So every case asserts the CLAIM ITSELF arrived at
 * `collectAgentWork`, and the mutation battery below builds that cheap repair
 * and watches the case stay red under it.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SHIP = join(REPO_ROOT, "workflows", "ship.js");
const SELF = join(REPO_ROOT, "test", "wave-claim-propagation.test.ts");

/**
 * The tree under test. A mutant run re-executes THIS file with the variable
 * pointing at a mutated copy of ship.js, so the cases below are the same cases
 * in both colours — a separate "mutant assertion" would measure a second test,
 * not this one.
 */
const SHIP_UNDER_TEST = process.env.WAVE_CLAIM_SHIP_UNDER_TEST || REAL_SHIP;
const IS_MUTANT_CHILD = Boolean(process.env.WAVE_CLAIM_SHIP_UNDER_TEST);
const shipSource = readFileSync(SHIP_UNDER_TEST, "utf-8");

const RUN_REPO = "owner/project";
const REMOTE = `git@github.com:${RUN_REPO}.git`;
const RUN_REF = "rungate/run-627";
const ISSUE = 627;

/** Slice a marked block, refusing a name that is declared twice. */
function block(name: string, source: string = shipSource): string {
  const a = source.indexOf(`// ──── ${name}-START ────`);
  const b = source.indexOf(`// ──── ${name}-END ────`);
  if (a < 0) throw new Error(`ship.js is missing the ${name}-START marker`);
  if (b < a) throw new Error(`ship.js is missing the ${name}-END marker`);
  if (source.indexOf(`// ──── ${name}-START ────`, a + 1) >= 0) {
    throw new Error(`${name} is declared twice — a mutation of one copy would leave the other`);
  }
  return source.slice(a, b);
}

/**
 * The source with whole-line comments removed.
 *
 * "The inline pairing appears nowhere" is a claim about CODE, and this file's
 * subject is a defect whose docblock quotes the expression it replaced. A
 * whole-document search would be satisfied by the prose explaining the fix —
 * `.claude/rules/checks-must-be-able-to-fail.md`'s "search the slice, not the
 * document", arriving as a claim scoped to a syntactic class rather than to a
 * region. Whole-line only: ship.js's comments are line or block style at the
 * start of a line, and a cleverer stripper is a second parser to get wrong.
 */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

interface SubFixture {
  title: string;
  files: string[];
  dependsOn?: string[];
}

interface CollectCall {
  label: string;
  intoDir: string;
  rows: Array<{
    worktreePath?: string;
    worktreeRepo?: string;
    filesChanged?: string[];
    claimedFiles?: string[];
  }>;
}

/**
 * The real dispatch loop, the real `integrateWave`, and the real
 * `collectAgentWork` — only the agents are fakes.
 *
 * Nothing between the plan and the audit is stubbed, because the defect lives
 * precisely in the handover between two of those three: a stub for
 * `integrateWave` (which is what every other suite injects) is exactly what
 * let this ship.
 */
function buildPipeline(root: string, subs: SubFixture[], source: string = shipSource) {
  const logs: string[] = [];
  const log = (m: unknown) => void logs.push(String(m));
  const collectCalls: CollectCall[] = [];
  /** The pruned candidate groups the collector was actually handed. */
  const groupsSeen: Array<Array<{ worktreePath: string; filesChanged: string[] }>> = [];
  const agentCalls: Array<{ label: string; prompt: string }> = [];

  const worktreeOf = (title: string) => join(root, ".claude", "worktrees", `wf_${title}`);

  // The real quoting, sliced rather than re-implemented: a local copy would
  // let this suite and ship.js disagree about what reaches a shell.
  const shellQuote = new Function(
    `${block("SECURITY-HELPERS", source)}\nreturn shellQuote;`,
  )() as (s: string) => string;

  const timedAgent = async (prompt: string, opts: { label: string }) => {
    agentCalls.push({ label: opts.label, prompt });
    if (prompt.includes("preserve-worktree-work.ts")) return { entries: [] };
    if (opts.label.startsWith("collect-")) {
      const m = /RUNGATE_GROUPS_EOF'\n([\s\S]*?)\nRUNGATE_GROUPS_EOF/.exec(prompt);
      const groups = m ? JSON.parse(m[1]!) : [];
      groupsSeen.push(groups);
      const collected = groups.reduce(
        (n: number, g: { filesChanged: string[] }) => n + g.filesChanged.length,
        0,
      );
      return { ok: true, collected };
    }
    if (opts.label.startsWith("commit-wave-")) {
      return { committed: true, sha: "abc1234", branch: RUN_REF };
    }
    return {};
  };

  const realCollect = new Function(
    "log",
    "timedAgent",
    "WORK_DIR",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${[
      block("SECURITY-HELPERS", source),
      block("COLLECT-DESTINATION", source),
      block("COLLECT-CLAIM", source),
      block("PRESERVE-REFUSED", source),
      block("COLLECT-AGENT-WORK", source),
    ].join("\n")}\nreturn collectAgentWork;`,
  )(log, timedAgent, join(root, "work"), root, root) as (
    results: unknown,
    intoDir: string,
    phaseName: string,
    label: string,
  ) => Promise<{ ok: boolean; collected: number; staged: boolean; detail?: string }>;

  // The spy records what the WAVE PATH hands the collector. That list is the
  // subject of this file: a run can be green with the claim missing from it
  // (widen the audit) and red with the claim present (break something else),
  // so the list is read directly rather than inferred from the verdict.
  const collectAgentWork = async (
    results: CollectCall["rows"],
    intoDir: string,
    phaseName: string,
    label: string,
  ) => {
    collectCalls.push({
      label,
      intoDir,
      rows: JSON.parse(JSON.stringify(Array.isArray(results) ? results : [])),
    });
    return realCollect(results, intoDir, phaseName, label);
  };

  const worktreeIdentityFns = new Function(
    `${block("WORKTREE-IDENTITY", source)}\nreturn { worktreeIdentity, worktreeIdentityViolations };`,
  )() as {
    worktreeIdentity: (p: string, repo: string, reported: unknown) => { refusal: string | null };
    worktreeIdentityViolations: (rows: unknown, repo: string, opts?: unknown) => string[];
  };

  const runRef = new Function(
    "timedAgent",
    "collectAgentWork",
    "shellQuote",
    "log",
    "PROJECT_ROOT",
    "ISSUE",
    "worktreeIdentityViolations",
    "REPO",
    `${block("CLAIM-PAIRING", source)}\n${block("RUN-REF", source)}\n` +
      `return { integrateWave, waveNeedsIntegration, claimedWorktreeRow };`,
  )(
    timedAgent,
    collectAgentWork,
    shellQuote,
    log,
    root,
    ISSUE,
    worktreeIdentityFns.worktreeIdentityViolations,
    RUN_REPO,
  ) as {
    integrateWave: (
      accepted: unknown,
      waveIndex: number,
      total: number,
      runRef: string,
    ) => Promise<{ ok: boolean; integrated: number; detail?: string }>;
    waveNeedsIntegration: (i: number, total: number) => boolean;
    claimedWorktreeRow: (settled: unknown) => Record<string, unknown>;
  };

  const implementRefusal = new Function(
    `${block("IMPLEMENT-RESULT", source)}\nreturn implementRefusal;`,
  )();
  const taskSourceRefusal = new Function(
    `${block("BRIEF-PRECEDENCE", source)}\nreturn taskSourceRefusal;`,
  )();

  const briefedAgent = async (prompt: string, _opts: { label: string }) => {
    const title = /## Sub-issue: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
    const sub = subs.find(s => s.title === title);
    if (!sub) throw new Error(`no fixture for sub-issue ${JSON.stringify(title)}`);
    return {
      success: true,
      filesChanged: [...sub.files],
      worktreePath: worktreeOf(sub.title),
      worktreeRepo: REMOTE,
      taskSource: "brief",
    };
  };

  const runDecomposedShip = new Function(
    "log",
    "briefedAgent",
    "parallel",
    "WORK_DIR",
    "ISSUE",
    "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA",
    "runImplement",
    "implementRefusal",
    "worktreeIdentity",
    "REPO",
    "taskSourceRefusal",
    "establishRunRef",
    "integrateWave",
    "waveNeedsIntegration",
    "measureLaunchBase",
    // SECURITY-HELPERS beneath the shape block: #830's
    // `reportedPathRefusal` shares those markers and calls `pathRefusal`,
    // which lives there.
    `${block("SECURITY-HELPERS", source)}\n${block("FILES-CHANGED-SHAPE", source)}\n`
      + `${block("DECOMPOSED-SHIP", source)}\nreturn runDecomposedShip;`,
  )(
    log,
    briefedAgent,
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    join(root, "work"),
    ISSUE,
    root,
    {},
    async () => ({ success: true, buildResult: {} }),
    implementRefusal,
    worktreeIdentityFns.worktreeIdentity,
    RUN_REPO,
    taskSourceRefusal,
    async () => ({ branch: RUN_REF, refusal: null }),
    runRef.integrateWave,
    runRef.waveNeedsIntegration,
    async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
  ) as (subIssues: unknown) => Promise<{ success: boolean; refusal?: string }>;

  const plan = subs.map(s => ({
    title: s.title,
    acs: [`${s.title}-ac`],
    filesToModify: [...s.files],
    size: "S",
    ...(s.dependsOn ? { dependsOn: [...s.dependsOn] } : {}),
  }));

  return { runDecomposedShip, plan, logs, collectCalls, groupsSeen, agentCalls, worktreeOf, runRef };
}

/**
 * A worktree tree of this run's own making (AC-6).
 *
 * Nothing here names a path from the run that found the bug. A fixture keyed
 * on another run's filenames stops witnessing the moment those files move, and
 * the thing under test is the SHAPE of the handover, not any file in it.
 */
function makeTree(subs: SubFixture[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wave-claim-")));
  for (const sub of subs) {
    const wt = join(root, ".claude", "worktrees", `wf_${sub.title}`);
    for (const f of sub.files) {
      mkdirSync(join(wt, f.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(wt, f), `// ${sub.title}\n`);
    }
  }
  return root;
}

/** Every row the collector was handed for one label, as claim pairs. */
function claimsAt(calls: CollectCall[], label: string): Record<string, string[] | undefined> {
  const call = calls.find(c => c.label === label);
  if (!call) return {};
  const out: Record<string, string[] | undefined> = {};
  for (const row of call.rows) out[String(row.worktreePath)] = row.claimedFiles;
  return out;
}

// ── AC-1 / SC-2058 ───────────────────────────────────────────

const TWO_WAVE: SubFixture[] = [
  { title: "foundation", files: ["lib/foundation.ts"] },
  { title: "consumer", files: ["lib/consumer.ts"], dependsOn: ["foundation"] },
];

describe("AC-1: the claim survives the handover into wave integration", () => {
  test("SC-2058: the claim reaches the collector through wave integration", async () => {
    const root = makeTree(TWO_WAVE);
    try {
      const p = buildPipeline(root, TWO_WAVE);
      const out = await p.runDecomposedShip(p.plan);

      // The premise: this fixture really did produce two waves, so wave 1 was
      // integrated rather than left to the end-of-run collect. Without this a
      // single-wave plan would satisfy every assertion below by never
      // integrating anything.
      expect(p.logs.join("\n"), "the fixture did not produce a dependency barrier")
        .toContain("dependency waves");
      const wave1 = p.collectCalls.find(c => c.label === "collect-wave-1");
      expect(wave1, `collector labels seen: ${p.collectCalls.map(c => c.label).join(",") || "none"}`)
        .toBeTruthy();

      // The property, not the verdict: the row the collector was handed
      // carries the claim the plan issued. A widened audit cannot satisfy it.
      expect(claimsAt(p.collectCalls, "collect-wave-1")).toEqual({
        [p.worktreeOf("foundation")]: ["lib/foundation.ts"],
      });

      // And the consequence, which is what the run actually needed: the wave
      // integrates rather than being refused, and the whole run succeeds.
      expect(out.success, JSON.stringify(out)).toBe(true);
      expect(p.logs.join("\n")).toContain(`integrated onto ${RUN_REF}`);
      expect(p.logs.join("\n")).not.toContain("refusing to collect");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-2058: the end-of-run path still carries the same claim", async () => {
    // The control for the shared binding: the path that was always correct
    // must stay correct. A "fix" that moved the pairing into the wave path
    // only would pass the case above and silently break SC-413 everywhere
    // else, and nothing in the wave path could see it.
    const singleWave: SubFixture[] = [
      { title: "alpha", files: ["lib/alpha.ts"] },
      { title: "beta", files: ["lib/beta.ts"] },
    ];
    const root = makeTree(singleWave);
    try {
      const p = buildPipeline(root, singleWave);
      const out = (await p.runDecomposedShip(p.plan)) as unknown as {
        success: boolean;
        buildResult: { agentResults: Array<{ worktreePath: string; claimedFiles: string[] }> };
      };
      expect(out.success).toBe(true);
      // One wave, so nothing was integrated mid-run — the claim travels on the
      // returned agentResults instead.
      expect(p.collectCalls).toEqual([]);
      expect(
        Object.fromEntries(out.buildResult.agentResults.map(r => [r.worktreePath, r.claimedFiles])),
      ).toEqual({
        [p.worktreeOf("alpha")]: ["lib/alpha.ts"],
        [p.worktreeOf("beta")]: ["lib/beta.ts"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── AC-2 / SC-2059 ───────────────────────────────────────────

describe("AC-2: one binding pairs a result with its claim", () => {
  test("SC-2059: one binding pairs a result with its claim, and both staging paths call it", () => {
    const code = codeOf(shipSource);
    // The stripper is not vacuous: it removed something and left the code.
    expect(code.length).toBeLessThan(shipSource.length);
    expect(code, "the comment stripper ate the block this case is about")
      .toContain("function claimedWorktreeRow(");

    const decls = code.match(/function\s+claimedWorktreeRow\s*\(/g) || [];
    expect(decls.length, "two deciders that agree are behaviourally one (#415)").toBe(1);

    // The inline pairing appears nowhere. Both halves: the expression the
    // end-of-run path used, and the strip the wave path used.
    expect(
      (code.match(/claimedFiles:\s*r\.subIssue/g) || []).length,
      "an inline pairing survives any mutation of the binding",
    ).toBe(0);
    expect(
      (code.match(/accepted\.map\(r\s*=>\s*r\s*&&\s*r\.buildResult\)/g) || []).length,
      "the claim-stripping map is still in the wave path",
    ).toBe(0);

    // Searched in the SLICES, not the document: a mention anywhere in a
    // 7,000-line file would satisfy a whole-file search while the call sat in
    // some third place.
    const run = codeOf(block("RUN-REF"));
    const decomposed = codeOf(block("DECOMPOSED-SHIP"));
    expect(run.length).toBeGreaterThan(0);
    expect(decomposed.length).toBeGreaterThan(0);
    expect(
      (run.match(/\.map\(claimedWorktreeRow\)/g) || []).length,
      "the wave path does not call the shared binding",
    ).toBe(1);
    expect(
      (decomposed.match(/\.map\(claimedWorktreeRow\)/g) || []).length,
      "the end-of-run path has two return branches and both must pair",
    ).toBe(2);
  });

  test("SC-2059: the binding is executed, not merely present", () => {
    const root = makeTree([]);
    try {
      const p = buildPipeline(root, []);
      expect(
        p.runRef.claimedWorktreeRow({
          subIssue: { filesToModify: ["lib/claimed.ts"] },
          buildResult: {
            worktreePath: "/tmp/wt",
            worktreeRepo: REMOTE,
            filesChanged: ["lib/claimed.ts"],
          },
        }),
      ).toEqual({
        worktreePath: "/tmp/wt",
        worktreeRepo: REMOTE,
        filesChanged: ["lib/claimed.ts"],
        claimedFiles: ["lib/claimed.ts"],
      });
      // A row with nothing in it is four empty fields, not a throw: the
      // failure branch of the dispatch loop builds results with no subIssue
      // fields at all.
      expect(p.runRef.claimedWorktreeRow({})).toEqual({
        worktreePath: "",
        worktreeRepo: "",
        filesChanged: [],
        claimedFiles: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── AC-4 / SC-2060 ───────────────────────────────────────────

const THREE_WORKTREES: SubFixture[] = [
  { title: "alpha", files: ["lib/alpha.ts"] },
  { title: "beta", files: ["lib/beta.ts", "lib/beta-helper.ts"] },
  { title: "gamma", files: ["lib/gamma.ts"] },
  { title: "delta", files: ["lib/delta.ts"], dependsOn: ["alpha", "beta", "gamma"] },
];

describe("AC-4: the run that found this, rebuilt", () => {
  test("SC-2060: three worktrees integrate through a wave rather than the end-of-run collect", async () => {
    const root = makeTree(THREE_WORKTREES);
    try {
      const p = buildPipeline(root, THREE_WORKTREES);
      const out = await p.runDecomposedShip(p.plan);

      const wave1 = p.collectCalls.find(c => c.label === "collect-wave-1");
      expect(wave1, "wave 1 never reached the collector").toBeTruthy();
      expect(wave1!.rows.length, "the wave did not carry three worktrees").toBe(3);
      expect(wave1!.intoDir).toBe(root);

      // Correct, non-overlapping claims — which is the point. SC-411 had
      // nothing to catch here and SC-413 refused the run anyway.
      expect(claimsAt(p.collectCalls, "collect-wave-1")).toEqual({
        [p.worktreeOf("alpha")]: ["lib/alpha.ts"],
        [p.worktreeOf("beta")]: ["lib/beta.ts", "lib/beta-helper.ts"],
        [p.worktreeOf("gamma")]: ["lib/gamma.ts"],
      });

      // The audit kept every file: pruned candidates, read off the prompt the
      // collector was actually given, so a claim that arrived and was then
      // discarded by the audit is a different failure from one that never
      // arrived.
      expect(p.groupsSeen.length).toBe(1);
      expect(
        Object.fromEntries(p.groupsSeen[0]!.map(g => [g.worktreePath, g.filesChanged.sort()])),
      ).toEqual({
        [p.worktreeOf("alpha")]: ["lib/alpha.ts"],
        [p.worktreeOf("beta")]: ["lib/beta-helper.ts", "lib/beta.ts"],
        [p.worktreeOf("gamma")]: ["lib/gamma.ts"],
      });

      expect(out.success, JSON.stringify(out)).toBe(true);
      expect(p.logs.join("\n")).not.toContain("unclaimed file modification");
      // The fourth sub-issue is the barrier's other side. Without it the plan
      // is one wave and this case measures the end-of-run path by accident.
      expect(p.agentCalls.some(c => c.label === "commit-wave-1")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SC-2060: a worktree that exceeds its claim in a wave is still refused", async () => {
    // The control, and SC-413 itself: the fix must not be "stop checking".
    // Without this case, every assertion above is satisfied by an audit that
    // permits everything — which is exactly the cheap repair SC-2062 measures.
    const root = makeTree(THREE_WORKTREES);
    try {
      const creep = THREE_WORKTREES.map(s =>
        s.title === "gamma" ? { ...s, files: [...s.files, "lib/alpha.ts"] } : s,
      );
      const p = buildPipeline(root, THREE_WORKTREES);
      // The agents report more than the plan claimed: the plan is the honest
      // one, the reports are not.
      const pCreep = buildPipeline(root, creep);
      const out = await pCreep.runDecomposedShip(p.plan);
      expect(out.success).toBe(false);
      expect(pCreep.logs.join("\n")).toContain("unclaimed file modification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── AC-5 / SC-2061, SC-2062 ──────────────────────────────────

/** One textual substitution, refusing unless its anchor appears exactly once. */
function mutate(source: string, anchor: string, replacement: string): string {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`could not build the mutant: the anchor appears ${count} times — ${anchor}`);
  }
  return source.replace(anchor, replacement);
}

/** The pairing removed from the wave path — the defect, restored verbatim. */
const STRIP_ANCHOR = "const rows = accepted.filter(r => r && r.buildResult).map(claimedWorktreeRow)";
const STRIP_MUTANT = "const rows = accepted.map(r => r && r.buildResult).filter(Boolean)";

/**
 * The cheapest wrong fix, named in advance.
 *
 * Someone who sees the regression red at 5pm can make the symptom go away
 * without ever propagating the claim: widen `claimPermits` so an absent
 * `claimedFiles` permits everything. That is the exact fail-open #296 removed,
 * and it would disable SC-413 for every decomposed run. The cases above must
 * NOT go green under it.
 */
const GUARD_ANCHOR = "return Array.isArray(claims) ? claims.includes(key) : claimant === wt";
const GUARD_MUTANT = "return !Array.isArray(claims) || claims.includes(key)";

interface SpawnReading {
  ran: number;
  pass: number;
  fail: number;
  failed: string[];
  output: string;
}

function runSuite(shipPath: string): SpawnReading {
  const res = spawnSync("bun", ["test", SELF], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 300_000,
    env: {
      ...process.env,
      ...(shipPath === REAL_SHIP ? {} : { WAVE_CLAIM_SHIP_UNDER_TEST: shipPath }),
      // The control spawn must not recurse: it would re-spawn itself forever.
      WAVE_CLAIM_NO_SPAWN: "1",
    },
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`;
  const num = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}`, "m").exec(output);
    return m ? Number(m[1]) : -1;
  };
  const pass = num("pass");
  const fail = num("fail");
  const failed = [...output.matchAll(/\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)].map(m =>
    m[1]!.trim(),
  );
  return { ran: pass + fail, pass, fail, failed, output };
}

const MEASURES = !IS_MUTANT_CHILD && !process.env.WAVE_CLAIM_NO_SPAWN;

describe.skipIf(!MEASURES)("AC-5: what was broken to prove it", () => {
  // Read the baseline row before any mutation row: a baseline that is empty,
  // absent, or not the number this suite reports means the instrument stopped
  // reporting and every row below it is noise (#60).
  let baseline: SpawnReading;

  test("SC-2061: the baseline is green and the instrument reports", () => {
    baseline = runSuite(REAL_SHIP);
    expect(baseline.pass, `no pass count in:\n${baseline.output.slice(-2000)}`).toBeGreaterThan(0);
    expect(baseline.fail, baseline.failed.join("\n")).toBe(0);
  });

  test("SC-2061: the claim-stripping mutant turns the regression red", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-claim-mutant-"));
    try {
      const mutantPath = join(dir, "ship.js");
      writeFileSync(
        mutantPath,
        mutate(readFileSync(REAL_SHIP, "utf-8"), STRIP_ANCHOR, STRIP_MUTANT),
      );

      // The input on which mutant and original differ, named before the count
      // is believed (#485): a three-worktree wave with correct, disjoint
      // claims. The original hands the collector rows carrying `claimedFiles`;
      // the mutant hands it rows that have none, and the audit refuses all of
      // them. Both run the same code otherwise.
      const got = runSuite(mutantPath);
      expect(got.ran, `the mutant suite never ran:\n${got.output.slice(-2000)}`).toBeGreaterThan(0);
      expect(got.fail, got.output.slice(-2000)).toBeGreaterThanOrEqual(2);
      // By NAME, not by count: "2 red" is satisfied by any two.
      expect(got.failed.join("\n")).toContain("SC-2058");
      expect(got.failed.join("\n")).toContain("SC-2060");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SC-2062: the widened claim guard does not buy the regression green", () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-claim-cheapfix-"));
    try {
      const mutantPath = join(dir, "ship.js");
      // The claim-stripping defect AND the cheap repair somebody reaches for
      // to silence it. The collection succeeds again under this pair — the
      // audit permits an unclaimed file — and the claim still never reached
      // the collector, which is what these cases assert.
      const both = mutate(
        mutate(readFileSync(REAL_SHIP, "utf-8"), STRIP_ANCHOR, STRIP_MUTANT),
        GUARD_ANCHOR,
        GUARD_MUTANT,
      );
      writeFileSync(mutantPath, both);

      const got = runSuite(mutantPath);
      expect(got.ran, `the mutant suite never ran:\n${got.output.slice(-2000)}`).toBeGreaterThan(0);
      expect(got.fail, "the cheapest wrong fix bought the regression green").toBeGreaterThanOrEqual(
        2,
      );
      expect(got.failed.join("\n")).toContain("SC-2058");
      expect(got.failed.join("\n")).toContain("SC-2060");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── AC-6 / SC-2063 ───────────────────────────────────────────

describe("AC-6: the fixture outlives the run that found the bug", () => {
  test("SC-2063: the fixture is built in a temp tree and names no run's files", () => {
    // Assembled from parts so this assertion is not itself the occurrence it
    // forbids — the self-reference trap `claiming-sc-coverage.md` describes.
    const runId = ["wf_", "9e60257d"].join("");
    const self = readFileSync(SELF, "utf-8");
    expect(self.includes(runId), "the fixture is keyed on a run id and will go stale").toBe(false);
    // Every worktree path this file uses is minted under the OS temp dir.
    expect(self).toContain("mkdtempSync(join(tmpdir()");
  });
});
