/**
 * Covers #627 AC-1..AC-3 — SC-413 (PARALLEL-AGENT-COORDINATION-SPEC.md) on the
 * WAVE staging path.
 *
 * #420 gave a decomposition a second place that stages and commits agent
 * output: `integrateWave`, which runs between waves so wave N+1's worktrees
 * contain what wave N built. #178 gave the end-of-run path a claim —
 * `claimedFiles` travelling back beside `filesChanged`, so
 * `auditWorktreeClaims` can refuse a worktree that reported a file no
 * sub-issue claimed. The two were never joined: `integrateWave` handed
 * `collectAgentWork` the bare `buildResult`s, which carry no claim, so in any
 * wave with two worktrees every file was "claimed by nobody" and the whole
 * wave was refused — correct work, refused, and the run dead at the barrier.
 *
 * The fixture is a THREE sub-issue, two-wave decomposition on purpose. With a
 * single sub-issue in wave 1 the audit takes `SINGLE_WORKTREE_EXEMPT` and
 * keeps every file whether a claim travelled or not, so the case would reach
 * its assertion without the feature (.claude/rules/checks-must-be-able-to-fail.md,
 * "a fixture that reached the assertion without the feature"). Two worktrees
 * in wave 1 is the smallest shape in which the claim is load-bearing, and the
 * mutation case below measures that it is.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const SPEC_PATH = join(REPO_ROOT, "specs", "PARALLEL-AGENT-COORDINATION-SPEC.md");
const shipSource = readFileSync(SHIP_PATH, "utf-8");
const RUN_REPO = "owner/project";
const PROJECT_ROOT = "/tmp/project";

/** The one line that pairs a result with its sub-issue's claim. */
const PAIRING_LINE = "    claimedFiles: sub.filesToModify || [],\n";

function sliceBlock(source: string, name: string): string {
  const a = source.indexOf(`// ──── ${name}-START ────`);
  const b = source.indexOf(`// ──── ${name}-END ────`);
  expect(a, `ship.js is missing the ${name}-START marker`).toBeGreaterThan(-1);
  expect(b, `ship.js is missing the ${name}-END marker`).toBeGreaterThan(a);
  // Exactly once each: a second copy would survive any mutation of the first.
  expect(source.indexOf(`// ──── ${name}-START ────`, a + 1)).toBe(-1);
  expect(source.indexOf(`// ──── ${name}-END ────`, b + 1)).toBe(-1);
  return source.slice(a, b);
}

interface Row {
  worktreePath?: string;
  worktreeRepo?: string;
  filesChanged?: string[];
  claimedFiles?: string[];
}

interface SubIssue {
  title: string;
  acs: string[];
  filesToModify: string[];
  size: string;
  dependsOn?: string[];
}

/**
 * `runDecomposedShip`, driven over the REAL `integrateWave` and the REAL claim
 * audit. Only the agents are faked.
 *
 * `collectAgentWork` is the one collaborator that is a stand-in, and it is a
 * stand-in that runs `auditWorktreeClaims` on exactly the rows it was handed —
 * which is the whole question this file asks. A fake that merely returned
 * `{ok: true}` would be green over a wave carrying no claim at all.
 */
function loadRun(source: string) {
  const auditWorktreeClaims = new Function(
    "PROJECT_ROOT",
    "log",
    `${sliceBlock(source, "SECURITY-HELPERS")}\n${sliceBlock(source, "COLLECT-CLAIM")}\nreturn auditWorktreeClaims`,
  )(PROJECT_ROOT, () => {}) as (results: Row[]) => {
    violations: Array<{ detail: string }>;
    candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
  };

  const identity = new Function(
    `${sliceBlock(source, "WORKTREE-IDENTITY")}\nreturn { worktreeIdentity, worktreeIdentityViolations }`,
  )() as {
    worktreeIdentity: (p: string, repo: string, reported?: string) => { refusal: string | null };
    worktreeIdentityViolations: (rows: unknown[], repo: string, opts?: unknown) => string[];
  };

  const collectCalls: Row[][] = [];
  const logs: string[] = [];
  const agentLabels: string[] = [];

  const collectAgentWork = async (results: Row[]) => {
    collectCalls.push(JSON.parse(JSON.stringify(results)));
    const audit = auditWorktreeClaims(results);
    if (audit.violations.length > 0) {
      return {
        ok: false,
        collected: 0,
        staged: false,
        detail:
          `refusing to collect: ${audit.violations.length} unclaimed file modification(s) ` +
          `(#178, SC-413) — ${audit.violations.map(v => v.detail).join("; ")}`,
      };
    }
    return {
      ok: true,
      collected: audit.candidates.reduce((n, c) => n + c.filesChanged.length, 0),
      staged: true,
    };
  };

  const runRef = new Function(
    "timedAgent", "collectAgentWork", "shellQuote", "log", "PROJECT_ROOT", "ISSUE",
    "worktreeIdentityViolations", "REPO",
    `${sliceBlock(source, "RUN-REF")}\nreturn { integrateWave, waveNeedsIntegration, runRefRefusal }`,
  )(
    async (_prompt: string, o: { label: string }) => {
      agentLabels.push(o.label);
      return { committed: true, sha: "c0ffee1", branch: "rungate/run-627" };
    },
    collectAgentWork,
    (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`,
    (m: string) => logs.push(String(m)),
    PROJECT_ROOT,
    627,
    identity.worktreeIdentityViolations,
    RUN_REPO,
  ) as {
    integrateWave: (accepted: unknown[], w: number, total: number, ref: string) => Promise<{ ok: boolean; integrated: number; detail?: string }>;
    waveNeedsIntegration: (w: number, total: number) => boolean;
  };

  const runDecomposedShip = new Function(
    "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
    "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal", "worktreeIdentity", "REPO",
    "taskSourceRefusal", "establishRunRef", "integrateWave", "waveNeedsIntegration",
    `${sliceBlock(source, "FILES-CHANGED-SHAPE")}\n${sliceBlock(source, "DECOMPOSED-SHIP")}\nreturn runDecomposedShip`,
  )(
    (m: string) => logs.push(String(m)),
    async (prompt: string, o: { label: string }) => {
      agentLabels.push(o.label);
      const title = /## Sub-issue: (.+)/.exec(prompt)?.[1]?.trim() ?? "";
      // What the agent CHANGED is read back out of the prompt's own claim, so
      // a compliant agent is modelled: it touched exactly what it was told to.
      // The claim under test is the one ship.js carries alongside this reply,
      // not this reply's contents.
      const claimed = [...prompt.matchAll(/^- (\S+\.ts)$/gm)].map(m2 => m2[1]);
      return {
        success: true,
        filesChanged: [...new Set(claimed)],
        worktreePath: `${PROJECT_ROOT}/.claude/worktrees/wt-${title}`,
        worktreeRepo: `git@github.com:${RUN_REPO}.git`,
        testOutput: "ok",
        taskSource: "brief",
      };
    },
    (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
    "/tmp/work",
    627,
    PROJECT_ROOT,
    {},
    async () => ({ success: true, buildResult: {} }),
    () => null,
    identity.worktreeIdentity,
    RUN_REPO,
    () => null,
    async () => ({ branch: "rungate/run-627", refusal: null }),
    runRef.integrateWave,
    runRef.waveNeedsIntegration,
  ) as (subIssues: SubIssue[]) => Promise<{
    success: boolean;
    failed: Array<{ title: string; buildResult: { findings?: string[] } | null }>;
    buildResult: { agentResults?: Row[] };
  }>;

  return { runDecomposedShip, collectCalls, logs, agentLabels };
}

/**
 * Two waves. Wave 1 is `alpha` and `beta` — two worktrees, disjoint claims,
 * each agent touching exactly what it claimed. Wave 2 is `gamma`, which
 * depends on both and therefore forces the barrier that makes wave 1 stage.
 */
const LAYERED: SubIssue[] = [
  { title: "alpha", acs: ["a"], filesToModify: ["lib/alpha.ts"], size: "S" },
  { title: "beta", acs: ["b"], filesToModify: ["lib/beta.ts"], size: "S" },
  {
    title: "gamma", acs: ["c"], filesToModify: ["lib/gamma.ts"], size: "S",
    dependsOn: ["alpha", "beta"],
  },
];

describe("#627 AC-1 — the wave staging path carries the claim", () => {
  test("a two-wave decomposition with correct, disjoint claims integrates rather than refusing", async () => {
    const run = loadRun(shipSource);
    const result = await run.runDecomposedShip(LAYERED);

    // Observed running BEFORE any verdict: a collection that never happened
    // reports no violations either, which is indistinguishable from a clean
    // one. Exactly one wave is staged — wave 2 has no successor.
    expect(
      run.collectCalls.length,
      `collect calls: ${JSON.stringify(run.collectCalls)} / logs: ${run.logs.join(" | ")}`,
    ).toBe(1);

    const rows = run.collectCalls[0];
    expect(rows.length).toBe(2);
    const byPath = Object.fromEntries(rows.map(r => [String(r.worktreePath), r]));
    expect(Object.keys(byPath).sort()).toEqual([
      `${PROJECT_ROOT}/.claude/worktrees/wt-alpha`,
      `${PROJECT_ROOT}/.claude/worktrees/wt-beta`,
    ]);
    // The claim the wave hands the collector is the sub-issue's own
    // filesToModify — the same thing the end-of-run path hands it.
    expect(byPath[`${PROJECT_ROOT}/.claude/worktrees/wt-alpha`].claimedFiles).toEqual(["lib/alpha.ts"]);
    expect(byPath[`${PROJECT_ROOT}/.claude/worktrees/wt-beta`].claimedFiles).toEqual(["lib/beta.ts"]);
    // And the identity reading travels with it, because the wave stages and
    // the staging boundary refuses a row with no checkable origin (#218).
    expect(byPath[`${PROJECT_ROOT}/.claude/worktrees/wt-alpha`].worktreeRepo)
      .toBe(`git@github.com:${RUN_REPO}.git`);

    expect(result.success, JSON.stringify(result.failed)).toBe(true);
    expect(run.logs.join("\n")).toContain("Wave 1 integrated onto rungate/run-627");

    // The end-of-run path is handed the same pairing, for all three.
    const agentResults = result.buildResult.agentResults || [];
    expect(agentResults.map(r => r.claimedFiles)).toEqual([
      ["lib/alpha.ts"], ["lib/beta.ts"], ["lib/gamma.ts"],
    ]);
  });

  test("the claim is what makes it integrate — removing it refuses the same wave", async () => {
    // The mutation, performed rather than asserted: the single line that
    // pairs a result with its sub-issue's claim is removed, which is exactly
    // the pre-#627 wave path. `.claude/rules/checks-must-be-able-to-fail.md`
    // asks for an input on which mutant and original differ; it is the
    // fixture above, and the two assertions here are the two answers.
    const occurrences = shipSource.split(PAIRING_LINE).length - 1;
    expect(
      occurrences,
      `could not build the mutant: the pairing line appears ${occurrences} times in ship.js`,
    ).toBe(1);
    const mutant = shipSource.replace(PAIRING_LINE, "");

    const run = loadRun(mutant);
    const result = await run.runDecomposedShip(LAYERED);

    // It still RAN — the wave was staged and the collector was asked. A
    // mutant that threw before reaching the audit would also be "not
    // success", and that is not what this measures.
    expect(run.collectCalls.length).toBe(1);
    expect(run.collectCalls[0].every(r => r.claimedFiles === undefined)).toBe(true);

    expect(result.success).toBe(false);
    const said = JSON.stringify(result.failed);
    expect(said).toContain("could not be integrated");
    expect(said).toContain("did not claim");
    // Wave 2 never starts, which is the cost the defect imposed on a run
    // whose work was correct.
    expect(run.agentLabels.filter(l => l.startsWith("marcus-sub-")).length).toBe(2);
  });
});

describe("#627 AC-2 — one binding, called by both staging paths", () => {
  const decomposed = sliceBlock(shipSource, "DECOMPOSED-SHIP");

  test("claimedWork is defined exactly once", () => {
    const defined = shipSource.match(/^function claimedWork\(/gm) || [];
    expect(defined.length).toBe(1);
    // Any other declaration form is a second binding wearing a different
    // syntax, and a second one would survive any mutation of the first.
    expect(shipSource.match(/\bclaimedWork\s*=/g) || []).toEqual([]);
  });

  test("the inline pairing expression appears nowhere", () => {
    // The property is written in exactly one place: inside the binding.
    const assignments = shipSource.match(/^\s*claimedFiles:/gm) || [];
    expect(assignments.length).toBe(1);

    const at = shipSource.indexOf("function claimedWork(");
    const body = shipSource.slice(at, shipSource.indexOf("\n}\n", at));
    expect(body, "the one claimedFiles assignment is not inside the binding")
      .toContain("claimedFiles:");
    // The shape the two call sites used to carry, in either spelling.
    expect(shipSource.match(/claimedFiles:[^\n]*subIssue/g) || []).toEqual([]);
  });

  test("both the wave path and the end-of-run path call it", () => {
    // The wave path: the results handed to integrateWave go through the
    // binding on the way.
    const waveCall = /integrateWave\(\s*\n?[^)]*claimedWork\(/.test(decomposed);
    expect(waveCall, `the integrateWave call site does not pair the claim:\n${
      decomposed.slice(decomposed.indexOf("integrateWave("), decomposed.indexOf("integrateWave(") + 240)
    }`).toBe(true);

    // The end-of-run path: both the failure branch and the success branch,
    // because a run that reports partial completion stages too.
    const endOfRun = decomposed.match(/agentResults:\s*completed\.map\(claimedWork\)/g) || [];
    expect(endOfRun.length).toBe(2);
  });
});

describe("#627 AC-3 — the spec records which path the claim travels", () => {
  test("the spec names the single binding and both staging paths", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    // Search the slice, not the document: a mention anywhere in a 250-line
    // spec would be satisfied by the SC line itself.
    const at = spec.indexOf("#627");
    expect(at, "the spec does not record #627 at all").toBeGreaterThan(-1);
    const nextHeading = spec.indexOf("\n## ", at);
    const section = spec.slice(spec.lastIndexOf("\n## ", at), nextHeading < 0 ? spec.length : nextHeading);
    expect(section.length, "the #627 section sliced empty").toBeGreaterThan(200);

    expect(section).toContain("claimedWork");
    expect(section).toContain("integrateWave");
    expect(section).toContain("SC-413");
    // The reason the next reader must not add a second inline pairing.
    expect(section.toLowerCase()).toContain("one binding");
  });

  test("the SC-413 status row says the claim travels the wave path too", () => {
    const spec = readFileSync(SPEC_PATH, "utf-8");
    const row = spec.split("\n").find(l => l.startsWith("| SC-413 |")) || "";
    expect(row, "no SC-413 row in the implementation status table").not.toBe("");
    expect(row).toContain("claimedWork");
  });
});
