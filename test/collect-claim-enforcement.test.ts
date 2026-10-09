/**
 * #178 / SC-413: a worktree may only contribute the files it claimed.
 *
 * On run wf_2b3ff032-a4b three of four parallel worktrees modified
 * `workflows/ship.js`. The claims themselves were right — exactly one
 * sub-issue claimed the file, so SC-411's pairwise overlap check had nothing
 * to catch. The claim reached the agents as PROSE ("## Files — modify ONLY
 * these", ship.js:1376) and nothing afterwards compared what came back
 * against it. Collection flattened the three copies, one non-claimant's copy
 * landed last, and the commit documented controls it did not contain.
 *
 * SC-413 of PARALLEL-AGENT-COORDINATION-SPEC.md is exactly this check:
 * "Post-wave integration check detects unclaimed file modifications".
 *
 * Two layers are tested here, because either alone is insufficient:
 *
 *   1. REFUSAL — a worktree reporting an unclaimed path fails the collection,
 *      naming the worktree, the path and the claimant.
 *   2. CANDIDATE PRUNING — the list handed to the collector contains only
 *      claimed files, so the claimant's copy is the only one that can ever be
 *      written. `AC-3 / the bug, reproduced` below runs the real collector on
 *      the UNPRUNED groups and watches the wrong copy win; that is the
 *      "prove it can fail" evidence required by
 *      .claude/rules/checks-must-be-able-to-fail.md, performed rather than
 *      asserted in prose.
 *
 * Marker extraction rather than import: ship.js runs in the Workflow sandbox
 * and is not a module. Same technique as test/ship-collect-destination.test.ts
 * — and for the same reason: "ship.js contains the word claimant" stays true
 * after the function is reduced to `return { violations: [], candidates }`.
 */

// SPEC-REF: PARALLEL-AGENT-COORDINATION-SPEC.md § Success Criteria (SC-413)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { collectWorktreeFiles, groupFilesByWorktree } from "../lib/worktree-collect";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const PROJECT = "/Users/dev/proj";
const HARNESS = "/Users/dev/harness";

interface AgentResult {
  worktreePath?: string;
  filesChanged?: string[];
  claimedFiles?: string[] | null;
}

interface Violation {
  worktreePath: string;
  path: string;
  claimant: string | null;
  detail: string;
}

interface ClaimAudit {
  violations: Violation[];
  candidates: Array<{ worktreePath: string; filesChanged: string[] }>;
}

/** Slice a marked block out of ship.js. */
function block(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

function loadClaimAudit(): {
  auditWorktreeClaims: (results: unknown) => ClaimAudit;
  claimKey: (worktreePath: string, p: unknown) => string;
} {
  return new Function(
    `${block("COLLECT-CLAIM")}\nreturn { auditWorktreeClaims, claimKey }`,
  )();
}

const { auditWorktreeClaims, claimKey } = loadClaimAudit();

/**
 * `collectAgentWork` with its collaborators injected, so the refusal can be
 * observed as behaviour — including the fact that it happens BEFORE any agent
 * is spawned.
 */
function loadCollectAgentWork(agentReply: unknown = { ok: true, collected: 1 }) {
  const calls: Array<{ prompt: string; label: string }> = [];
  const logs: string[] = [];
  const body = [
    block("COLLECT-DESTINATION"),
    block("COLLECT-CLAIM"),
    block("COLLECT-AGENT-WORK"),
  ].join("\n");

  const collectAgentWork = new Function(
    "log",
    // The timing wrapper, not the raw sandbox primitive (#227): every call
    // site in ship.js spawns through it, this one included.
    "timedAgent",
    "shellQuote",
    "WORK_DIR",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${body}\nreturn collectAgentWork`,
  )(
    (m: string) => logs.push(String(m)),
    async (prompt: string, opts: { label: string }) => {
      calls.push({ prompt, label: opts.label });
      return agentReply;
    },
    (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`,
    "/tmp/work",
    PROJECT,
    HARNESS,
  ) as (
    results: unknown,
    intoDir: string,
    phaseName: string,
    label: string,
  ) => Promise<{ ok: boolean; collected: number; staged: boolean; detail?: string }>;

  return { collectAgentWork, calls, logs };
}

const WT_A = `${PROJECT}/.claude/worktrees/wf_a`;
const WT_B = `${PROJECT}/.claude/worktrees/wf_b`;

// ── AC-1 ─────────────────────────────────────────────────────

describe("AC-1: ship.js computes each worktree's unclaimed files", () => {
  test("the COLLECT-CLAIM block exists and is extractable", () => {
    expect(shipSource).toContain("// ──── COLLECT-CLAIM-START ────");
    expect(shipSource).toContain("// ──── COLLECT-CLAIM-END ────");
    expect(typeof auditWorktreeClaims).toBe("function");
  });

  test("a reported file outside the claim is reported as unclaimed", () => {
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_A,
        filesChanged: ["lib/a.ts", "workflows/ship.js"],
        claimedFiles: ["lib/a.ts"],
      },
      { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
    ]);
    expect(audit.violations.map(v => v.path)).toEqual(["workflows/ship.js"]);
    expect(audit.violations[0]!.worktreePath).toBe(WT_A);
  });

  test("an absolute report is normalised against its own worktree, as the collector does", () => {
    // groupFilesByWorktree accepts absolute paths inside the worktree and makes
    // them relative. A claim check that compared raw strings would see
    // "/…/wf_a/lib/a.ts" ≠ "lib/a.ts" and refuse every absolute report — the
    // whole collection, on the most common reporting style.
    const abs = `${WT_A}/lib/a.ts`;
    expect(claimKey(WT_A, abs)).toBe("lib/a.ts");
    expect(claimKey(WT_A, "./lib/a.ts")).toBe("lib/a.ts");

    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: [abs], claimedFiles: ["lib/a.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(audit.candidates).toEqual([{ worktreePath: WT_A, filesChanged: ["lib/a.ts"] }]);

    // And the normalisation agrees with the collector's own.
    expect(groupFilesByWorktree([{ worktreePath: WT_A, filesChanged: [abs] }])[0]!.files)
      .toEqual(["lib/a.ts"]);
  });

  test("a path reaching outside its worktree is never claimed", () => {
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_A,
        filesChanged: [`${WT_B}/lib/a.ts`, "../outside.ts"],
        claimedFiles: ["lib/a.ts"],
      },
    ]);
    expect(audit.violations).toHaveLength(2);
    expect(audit.candidates).toEqual([]);
  });

  test("an agent with no claim is unconstrained — the single-agent path still collects", () => {
    // runImplement issues no claim: there is one worktree and nothing to
    // contest. Treating a missing claim as "claimed nothing" would refuse
    // every ordinary run.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/b.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(audit.candidates[0]!.filesChanged).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("...but an unclaimed agent still cannot take a file another worktree claimed", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["workflows/ship.js"] },
      { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
    ]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]!.worktreePath).toBe(WT_A);
    expect(audit.violations[0]!.claimant).toBe(WT_B);
  });

  test("a non-array input audits to nothing rather than throwing", () => {
    for (const bad of [null, undefined, "x", 7, {}]) {
      const audit = auditWorktreeClaims(bad);
      expect(audit.violations).toEqual([]);
      expect(audit.candidates).toEqual([]);
    }
  });
});

// ── AC-2 ─────────────────────────────────────────────────────

describe("AC-2: the collector refuses a worktree that reports an unclaimed path", () => {
  const results: AgentResult[] = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "workflows/ship.js"], claimedFiles: ["lib/a.ts"] },
    { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
  ];

  test("a worktree that modifies a file it did not claim is refused, naming the worktree, the path and the claimant", async () => {
    const { collectAgentWork, calls } = loadCollectAgentWork();
    const out = await collectAgentWork(results, PROJECT, "Commit", "collect");

    expect(out.ok).toBe(false);
    expect(out.staged).toBe(false);
    expect(out.detail).toContain(WT_A); // the offending worktree
    expect(out.detail).toContain("workflows/ship.js"); // the unclaimed path
    expect(out.detail).toContain(WT_B); // the claimant
    expect(out.detail).toMatch(/claim/i);

    // Refused before anything was spawned: no agent, nothing staged, nothing
    // for a later step to mistake for a collection that happened.
    expect(calls, "an agent was spawned despite the refusal").toHaveLength(0);
  });

  test("the same two worktrees pass once the claim matches what was reported", async () => {
    // The case that MUST pass. Without it, `return { ok: false }` satisfies
    // every assertion above and the collector is simply broken.
    const { collectAgentWork, calls } = loadCollectAgentWork({ ok: true, collected: 2 });
    const out = await collectAgentWork(
      [
        { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
        results[1]!,
      ],
      PROJECT,
      "Commit",
      "collect",
    );

    expect(out.ok).toBe(true);
    expect(out.collected).toBe(2);
    expect(calls).toHaveLength(1);
  });

  test("the groups handed to the collect script carry only claimed files", async () => {
    const { collectAgentWork, calls } = loadCollectAgentWork({ ok: true, collected: 1 });
    await collectAgentWork(
      [{ worktreePath: WT_A, filesChanged: [`${WT_A}/lib/a.ts`], claimedFiles: ["lib/a.ts"] }],
      PROJECT,
      "Commit",
      "collect",
    );
    expect(calls).toHaveLength(1);
    const payload = calls[0]!.prompt.match(/<<'RUNGATE_GROUPS_EOF'\n([\s\S]*?)\nRUNGATE_GROUPS_EOF/);
    expect(payload, "the groups heredoc was not found in the prompt").not.toBeNull();
    const groups = JSON.parse(payload![1]!) as Array<{ worktreePath: string; filesChanged: string[] }>;
    expect(groups).toEqual([{ worktreePath: WT_A, filesChanged: ["lib/a.ts"] }]);
  });
});

// ── AC-3 ─────────────────────────────────────────────────────

describe("AC-3: one claimed file edited in two worktrees — the claimant wins", () => {
  let root: string;
  let project: string;
  let wtClaimant: string;
  let wtOther: string;
  const FILE = "workflows/ship.js";

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claim-contest-")));
    project = join(root, "project");
    wtClaimant = join(root, "wt-claimant");
    wtOther = join(root, "wt-other");
    for (const d of [project, wtClaimant, wtOther]) {
      mkdirSync(join(d, dirname(FILE)), { recursive: true });
    }
    writeFileSync(join(project, FILE), "ORIGINAL\n");
    writeFileSync(join(wtClaimant, FILE), "CLAIMANT\n");
    writeFileSync(join(wtOther, FILE), "INTERLOPER\n");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const results = () => [
    { worktreePath: wtOther, filesChanged: [FILE], claimedFiles: ["lib/other.ts"] },
    { worktreePath: wtClaimant, filesChanged: [FILE], claimedFiles: [FILE] },
  ];

  test("only the claimant's copy is a collection candidate", () => {
    const audit = auditWorktreeClaims(results());
    expect(audit.candidates).toEqual([{ worktreePath: wtClaimant, filesChanged: [FILE] }]);
    expect(audit.violations.map(v => [v.worktreePath, v.path, v.claimant])).toEqual([
      [wtOther, FILE, wtClaimant],
    ]);
  });

  test("the unclaimed copy never overwrites the claimant's", () => {
    const audit = auditWorktreeClaims(results());
    collectWorktreeFiles(
      groupFilesByWorktree(audit.candidates),
      project,
      [wtClaimant, wtOther],
    );
    expect(readFileSync(join(project, FILE), "utf-8")).toBe("CLAIMANT\n");
  });

  test("the bug, reproduced: unpruned, the interloper's copy wins", () => {
    // What the check prevents, performed. The ordering here is the one from
    // wf_2b3ff032-a4b — the claimant reports first, a non-claimant reports
    // after, and the last copy written is the one that gets committed.
    writeFileSync(join(project, FILE), "ORIGINAL\n");
    const unpruned = [
      { worktreePath: wtClaimant, filesChanged: [FILE] },
      { worktreePath: wtOther, filesChanged: [FILE] },
    ];
    collectWorktreeFiles(groupFilesByWorktree(unpruned), project, [wtClaimant, wtOther]);
    expect(
      readFileSync(join(project, FILE), "utf-8"),
      "the collector no longer overwrites — this test's premise is stale",
    ).toBe("INTERLOPER\n");
  });
});

// ── AC-4 ─────────────────────────────────────────────────────

describe("AC-4: ship.js names the claimant and carries no last-writer-wins language", () => {
  const FORBIDDEN = [
    /last[-\s]?writer/i,
    /last (?:one|write|writer|edit|copy)\s+wins/i,
    /whichever (?:is )?(?:written |copied )?last/i,
  ];

  test("the claimant is named in the collection logic, not merely somewhere in the file", () => {
    const claim = block("COLLECT-CLAIM");
    expect(claim).toMatch(/claimant/);
    // Executed, not grepped: a violation actually carries the claimant.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["x.ts"], claimedFiles: [] },
      { worktreePath: WT_B, filesChanged: ["x.ts"], claimedFiles: ["x.ts"] },
    ]);
    expect(audit.violations[0]!.claimant).toBe(WT_B);
    expect(audit.violations[0]!.detail).toContain(WT_B);
  });

  test("no last-writer-wins language anywhere in ship.js", () => {
    const hits = FORBIDDEN.filter(p => p.test(shipSource)).map(String);
    expect(hits, `ship.js still describes last-writer-wins: ${hits.join(", ")}`).toEqual([]);
  });

  test("the forbidden patterns can actually match", () => {
    // Without this the previous test passes against an empty-ish pattern set,
    // which is the decorative-check shape this repo keeps shipping.
    const sample = "last-writer-wins; the last one wins; whichever is written last";
    expect(FORBIDDEN.every(p => p.test(sample))).toBe(true);
  });
});

// ── AC-5 ─────────────────────────────────────────────────────

describe("AC-5: positive control — a disjoint collection still succeeds", () => {
  let root: string;
  let mainRepo: string;
  let wtA: string;
  let wtB: string;
  let groupsPath: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "claim-positive-")));
    mainRepo = join(root, "project");
    mkdirSync(mainRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", mainRepo], { stdio: "pipe" });
    git(mainRepo, "config", "user.email", "t@example.com");
    git(mainRepo, "config", "user.name", "t");
    mkdirSync(join(mainRepo, "lib"), { recursive: true });
    writeFileSync(join(mainRepo, "lib", "alpha.ts"), "old alpha\n");
    writeFileSync(join(mainRepo, "lib", "beta.ts"), "old beta\n");
    git(mainRepo, "add", "-A");
    git(mainRepo, "commit", "-q", "-m", "init");

    mkdirSync(join(mainRepo, ".claude", "worktrees"), { recursive: true });
    wtA = join(mainRepo, ".claude", "worktrees", "wf_pos-a");
    wtB = join(mainRepo, ".claude", "worktrees", "wf_pos-b");
    git(mainRepo, "worktree", "add", "-q", "-b", "pos-a", wtA);
    git(mainRepo, "worktree", "add", "-q", "-b", "pos-b", wtB);
    writeFileSync(join(wtA, "lib", "alpha.ts"), "NEW ALPHA\n");
    writeFileSync(join(wtB, "lib", "beta.ts"), "NEW BETA\n");

    groupsPath = join(root, "groups.json");
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("each agent stays inside its claim, so the audit refuses nothing", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: wtA, filesChanged: [join(wtA, "lib/alpha.ts")], claimedFiles: ["lib/alpha.ts"] },
      { worktreePath: wtB, filesChanged: ["lib/beta.ts"], claimedFiles: ["lib/beta.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
    writeFileSync(groupsPath, JSON.stringify(audit.candidates));
  });

  test("the real collect script exits 0 and reports COLLECTED 2", () => {
    const out = execFileSync(
      "bun",
      [join(REPO_ROOT, "scripts", "collect-worktree-files.ts"), groupsPath, mainRepo,
        join(mainRepo, ".claude", "worktrees")],
      { encoding: "utf-8", cwd: mainRepo, stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(out).toContain("COLLECTED 2");
    expect(readFileSync(join(mainRepo, "lib", "alpha.ts"), "utf-8")).toBe("NEW ALPHA\n");
    expect(readFileSync(join(mainRepo, "lib", "beta.ts"), "utf-8")).toBe("NEW BETA\n");
    expect(git(mainRepo, "diff", "--cached", "--name-only").trim().split("\n").sort())
      .toEqual(["lib/alpha.ts", "lib/beta.ts"]);
  });
});
