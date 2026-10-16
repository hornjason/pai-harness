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
  pathRefusal: (key: string) => { rule: string; boundary: boolean } | null;
} {
  // Both blocks. #400 gave staging and the audit one path-safety decider, and
  // it lives in SECURITY-HELPERS because that is the half mirrored by
  // lib/workflow-security.ts. Loading COLLECT-CLAIM alone would throw on the
  // first call — which is the structural proof that the audit really reaches
  // into the shared table rather than keeping a second copy of two of its rules.
  return new Function(
    "PROJECT_ROOT",
    "log",
    `${block("SECURITY-HELPERS")}\n${block("COLLECT-CLAIM")}\nreturn { auditWorktreeClaims, claimKey, pathRefusal }`,
  )("/repo", () => {});
}

// `pathRefusal` is exported alongside the other two because #229's fix
// changes claimKey's normalisation and the refusal reads the same segments.
// Asserting the two together is the point: "the key still looks absolute" and
// "the boundary still refuses it" are different claims, and only the second
// one is the property that matters.
//
// #400 replaced `escapesWorktree` with the shared decider. `.boundary` is the
// field that predicate returns, not a comparison rebuilt here — a test that
// re-implemented the branch would pass against a predicate that had stopped
// making it.
const { auditWorktreeClaims, claimKey, pathRefusal } = loadClaimAudit();

function escapesWorktree(key: string): boolean {
  const refusal = pathRefusal(key);
  return refusal !== null && refusal.boundary;
}

/**
 * `collectAgentWork` with its collaborators injected, so the refusal can be
 * observed as behaviour — including which steps it does and does not spawn.
 *
 * `agentReply` may be a value or a function of the prompt, because a refused
 * collection now makes a SECOND kind of agent call: the preserve step (#228).
 * One fixed reply for both would make the preserve step look like a collect
 * step that succeeded.
 */
function loadCollectAgentWork(
  agentReply: unknown | ((prompt: string) => unknown) = { ok: true, collected: 1 },
) {
  const calls: Array<{ prompt: string; label: string }> = [];
  const logs: string[] = [];
  // SECURITY-HELPERS first: #400 put the path-safety decider there, and
  // COLLECT-CLAIM calls it. It also carries the real `shellQuote`, which this
  // loader used to inject a copy of — the copy is gone, so the quoting these
  // tests assert on is the quoting ship.js performs.
  const body = [
    block("SECURITY-HELPERS"),
    block("COLLECT-DESTINATION"),
    block("COLLECT-CLAIM"),
    block("PRESERVE-REFUSED"),
    block("COLLECT-AGENT-WORK"),
  ].join("\n");

  const collectAgentWork = new Function(
    "log",
    "timedAgent",
    "WORK_DIR",
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    `${body}\nreturn collectAgentWork`,
  )(
    (m: string) => logs.push(String(m)),
    async (prompt: string, opts: { label: string }) => {
      calls.push({ prompt, label: opts.label });
      return typeof agentReply === "function"
        ? (agentReply as (p: string) => unknown)(prompt)
        : agentReply;
    },
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

    // Nothing was COLLECTED: the collect script is never reached, nothing is
    // staged, and no later step can mistake this for a collection that
    // happened. The one call that does go out is the preserve step (#228),
    // asserted on its own below.
    const collectCalls = calls.filter(c => c.prompt.includes("collect-worktree-files.ts"));
    expect(collectCalls, "the collect script ran despite the refusal").toHaveLength(0);
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

// ── #228 ─────────────────────────────────────────────────────
//
// Run wf_74366574-136: one worktree, correct work, a partial `claimedFiles`
// list — and the audit refused the whole collection because one changed file
// had no claimant. Nothing was being contested; there was nobody to contest
// with. The refusal then returned SHIP_FAILED without committing anything, so
// the only copy of the work stayed loose in the worktree.

describe("#228 / AC-1: a lone worktree is not held to its own claim", () => {
  test("a partial claim from the only worktree produces no violations", () => {
    // The exact shape from wf_74366574-136: more changed than claimed, and no
    // other worktree in the run.
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_A,
        filesChanged: ["lib/a.ts", "lib/b.ts", "workflows/ship.js"],
        claimedFiles: ["lib/a.ts"],
      },
    ]);
    expect(audit.violations, JSON.stringify(audit.violations)).toEqual([]);
    expect(audit.candidates).toEqual([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/b.ts", "workflows/ship.js"] },
    ]);
  });

  test("an empty claim list from the only worktree is treated the same way", () => {
    // `claimedFiles: []` is "claimed nothing yet", and it took the same strict
    // branch — the worst version of the bug, refusing every file in the run.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: [] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(audit.candidates).toEqual([{ worktreePath: WT_A, filesChanged: ["lib/a.ts"] }]);
  });

  test("the same worktree reporting twice is still one participant", () => {
    // Two result rows, one worktree. Counting rows rather than worktrees would
    // make a remediation round that reports in two parts fail the exemption.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_A, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/a.ts"] },
    ]);
    expect(audit.violations).toEqual([]);
  });
});

describe("#228 / AC-2: the exemption does not reach a contested run", () => {
  test("two worktrees, one claimed path, the non-claimant is still refused", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "workflows/ship.js"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
    ]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]!.worktreePath).toBe(WT_A);
    expect(audit.violations[0]!.path).toBe("workflows/ship.js");
    expect(audit.violations[0]!.claimant).toBe(WT_B);
  });

  test("two worktrees, a path nobody claimed, still refused", () => {
    // The exemption is about there being nobody to contest with. With a second
    // worktree in the run, an unclaimed file is the #178 shape again.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["workflows/ship.js"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
    ]);
    expect(audit.violations.map(v => [v.worktreePath, v.path, v.claimant])).toEqual([
      [WT_A, "workflows/ship.js", null],
    ]);
  });
});

describe("#228 / AC-6: the exemption does not exempt escaping paths", () => {
  test("a lone worktree reporting outside itself is still refused", () => {
    const audit = auditWorktreeClaims([
      {
        worktreePath: WT_A,
        filesChanged: [`${WT_B}/lib/a.ts`, "../outside.ts", "lib/a.ts"],
        claimedFiles: ["lib/a.ts"],
      },
    ]);
    expect(audit.violations).toHaveLength(2);
    expect(audit.violations.map(v => v.path).sort()).toEqual(
      [`${WT_B}/lib/a.ts`, "../outside.ts"].sort(),
    );
    expect(audit.candidates).toEqual([{ worktreePath: WT_A, filesChanged: ["lib/a.ts"] }]);
  });

  test("...and refused with no claim at all, where the exemption is widest", () => {
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["/etc/passwd", "a/../../b.ts"] },
    ]);
    expect(audit.violations).toHaveLength(2);
    expect(audit.candidates).toEqual([]);
  });

  test("a nested path inside the worktree is not mistaken for an escape", () => {
    // Positive control. Without it the previous two pass against "refuse
    // everything", which is the bug this issue is about.
    const audit = auditWorktreeClaims([
      { worktreePath: WT_A, filesChanged: ["lib/deep/nested/file.ts", `${WT_A}/lib/x.ts`] },
    ]);
    expect(audit.violations).toEqual([]);
    expect(audit.candidates[0]!.filesChanged).toEqual(["lib/deep/nested/file.ts", "lib/x.ts"]);
  });
});

// ── AC-5: the exemption reverted, and observed ───────────────

describe("#228 / AC-5: the single-worktree exemption is mutated and watched", () => {
  /**
   * A mutant copy of the claim audit with the exemption switched off. Without
   * it, "the lone worktree is not refused" is indistinguishable from an audit
   * that refuses nothing at all — the decorative-check shape counted five
   * times in one day in .claude/rules/checks-must-be-able-to-fail.md.
   *
   * Same contract as test/rook-review-scope.test.ts: one declaration, mutated
   * by name, and the harness throws rather than silently no-opping if the
   * declaration moves.
   */
  const claimSource = block("COLLECT-CLAIM");

  function loadMutant() {
    const mutated = claimSource.replace(
      /SINGLE_WORKTREE_EXEMPT\s*=\s*true\b/,
      "SINGLE_WORKTREE_EXEMPT = false",
    );
    if (mutated === claimSource) {
      throw new Error(
        "could not build the mutant: no `SINGLE_WORKTREE_EXEMPT = true` in the COLLECT-CLAIM block of ship.js",
      );
    }
    // SECURITY-HELPERS unmutated alongside it: the mutation targets the
    // exemption, and a mutant that died on a missing `pathRefusal` would
    // refuse everything and read as the mutation having worked (#400).
    return new Function(
      "PROJECT_ROOT",
      "log",
      `${block("SECURITY-HELPERS")}\n${mutated}\nreturn auditWorktreeClaims`,
    )("/repo", () => {}) as (r: unknown) => ClaimAudit;
  }

  test("the flag is declared exactly once, so the mutation cannot be half-applied", () => {
    const decls = claimSource.match(/SINGLE_WORKTREE_EXEMPT\s*=/g) || [];
    expect(
      decls.length,
      "more than one assignment — the mutant would only neutralise one of them",
    ).toBe(1);
  });

  test("the mutant refuses the partial-claim case that the real audit allows", () => {
    const results = [
      { worktreePath: WT_A, filesChanged: ["lib/a.ts", "lib/b.ts"], claimedFiles: ["lib/a.ts"] },
    ];
    expect(auditWorktreeClaims(results).violations, "the real audit still refuses #228").toEqual([]);

    const mutantViolations = loadMutant()(results).violations;
    expect(
      mutantViolations.map(v => v.path),
      "the exemption was removed and nothing changed — this test is not watching it",
    ).toEqual(["lib/b.ts"]);
  });

  test("the contested case is refused by BOTH copies — the exemption is not the whole check", () => {
    const contested = [
      { worktreePath: WT_A, filesChanged: ["workflows/ship.js"], claimedFiles: ["lib/a.ts"] },
      { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
    ];
    expect(auditWorktreeClaims(contested).violations).toHaveLength(1);
    expect(
      loadMutant()(contested).violations,
      "the mutant lost the contested-path refusal, so the comparison above proves nothing",
    ).toHaveLength(1);
  });
});

// ── AC-3 / AC-4: a refusal preserves, and says where ─────────

describe("#228 / AC-3+AC-4: a refused collection preserves the work and says where it is", () => {
  const contested = [
    { worktreePath: WT_A, filesChanged: ["lib/a.ts", "workflows/ship.js"], claimedFiles: ["lib/a.ts"] },
    { worktreePath: WT_B, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
  ];

  const preserveReply = (prompt: string) => {
    if (!prompt.includes("preserve-worktree-work.ts")) return { ok: true, collected: 1 };
    return {
      entries: [
        { worktreePath: WT_A, branch: "agent-a", sha: "aaaaaaa", status: "committed" },
        { worktreePath: WT_B, branch: "agent-b", sha: "bbbbbbb", status: "committed" },
      ],
    };
  };

  test("the preserve script is invoked on every participating worktree", async () => {
    const { collectAgentWork, calls } = loadCollectAgentWork(preserveReply);
    await collectAgentWork(contested, PROJECT, "Commit", "collect");

    const preserve = calls.filter(c => c.prompt.includes("preserve-worktree-work.ts"));
    expect(preserve, "a refusal returned without preserving anything").toHaveLength(1);
    expect(preserve[0]!.prompt).toContain(`${HARNESS}/scripts/preserve-worktree-work.ts`);
    expect(preserve[0]!.prompt).toContain(WT_A);
    expect(preserve[0]!.prompt).toContain(WT_B);
  });

  test("the refusal names the worktree and branch holding each preserved commit", async () => {
    const { collectAgentWork } = loadCollectAgentWork(preserveReply);
    const out = await collectAgentWork(contested, PROJECT, "Commit", "collect");

    expect(out.ok).toBe(false);
    expect(out.staged).toBe(false);
    // The refusal reason is what reaches SHIP_FAILED, and it is the only thing
    // the operator gets. Everything needed to reach the work must be in it.
    for (const token of [WT_A, "agent-a", WT_B, "agent-b"]) {
      expect(out.detail, `the refusal does not mention ${token}`).toContain(token);
    }
    // ...and it still says why it refused.
    expect(out.detail).toMatch(/claim/i);
  });

  test("a preserve step that reports nothing still names the worktrees it could not confirm", async () => {
    // Fail loud. An unparseable reply that produced a tidy refusal message
    // would hide exactly the state this issue is about — work on disk,
    // reachable from nothing, and nobody told.
    const { collectAgentWork } = loadCollectAgentWork((p: string) =>
      p.includes("preserve-worktree-work.ts") ? { entries: [] } : { ok: true, collected: 1 },
    );
    const out = await collectAgentWork(contested, PROJECT, "Commit", "collect");
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/not confirm|could not preserve|unconfirmed/i);
    expect(out.detail).toContain(WT_A);
    expect(out.detail).toContain(WT_B);
  });

  test("a successful collection preserves nothing — there is nothing to rescue", async () => {
    const { collectAgentWork, calls } = loadCollectAgentWork({ ok: true, collected: 2 });
    const out = await collectAgentWork(
      [
        { worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
        { worktreePath: WT_B, filesChanged: ["lib/b.ts"], claimedFiles: ["lib/b.ts"] },
      ],
      PROJECT,
      "Commit",
      "collect",
    );
    expect(out.ok).toBe(true);
    expect(calls.filter(c => c.prompt.includes("preserve-worktree-work.ts"))).toHaveLength(0);
  });

  test("a collect step that fails also preserves, not just the claim refusal", async () => {
    // The other way a finished implementation is lost: the claim audit passes,
    // the collector itself fails, and the run ends with the work still loose.
    const { collectAgentWork } = loadCollectAgentWork((p: string) =>
      p.includes("preserve-worktree-work.ts")
        ? { entries: [{ worktreePath: WT_A, branch: "agent-a", sha: "aaaaaaa", status: "committed" }] }
        : { ok: false, collected: 0, detail: "collect script exited 1" },
    );
    const out = await collectAgentWork(
      [{ worktreePath: WT_A, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] }],
      PROJECT,
      "Commit",
      "collect",
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("agent-a");
    expect(out.detail).toContain(WT_A);
  });

  test("every path on the preserve command line is quoted", async () => {
    // The worktree paths originate in an AGENT's reply and are interpolated
    // into a shell command, exactly as the collect step's were (#155).
    // collectDestination is the first layer and shellQuote the second;
    // ship.js:377 records what happens when a line has only the first.
    const preserveBlock = block("PRESERVE-REFUSED");
    const commandLine = preserveBlock
      .split("\n")
      .find(l => l.includes("preserve-worktree-work.ts"));
    expect(commandLine, "no preserve command line found").toBeDefined();

    // Every interpolation on that line, taken whole (brace-balanced, so a
    // nested `${HARNESS_ROOT}` inside a shellQuote argument is part of its
    // parent rather than a finding of its own), must route through shellQuote.
    const spans: string[] = [];
    for (let i = 0; i < commandLine!.length; ) {
      const at = commandLine!.indexOf("${", i);
      if (at < 0) break;
      let depth = 0;
      let j = at + 1;
      for (; j < commandLine!.length; j++) {
        if (commandLine![j] === "{") depth++;
        else if (commandLine![j] === "}" && --depth === 0) break;
      }
      spans.push(commandLine!.slice(at, j + 1));
      i = j + 1;
    }
    expect(spans.length, "nothing is interpolated — this line is not the command").toBeGreaterThan(0);
    for (const s of spans) {
      expect(s, `${s} reaches the shell without shellQuote`).toContain("shellQuote(");
    }

    // Observed rather than grepped: a metacharacter-laden worktree path comes
    // back single-quoted, so the shell cannot act on it.
    const { collectAgentWork, calls } = loadCollectAgentWork((p: string) =>
      p.includes("preserve-worktree-work.ts") ? { entries: [] } : { ok: true, collected: 1 },
    );
    const nasty = `${PROJECT}/.claude/worktrees/wf_$(touch pwned)`;
    await collectAgentWork(
      [
        { worktreePath: nasty, filesChanged: ["lib/a.ts"] },
        { worktreePath: WT_B, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
      ],
      PROJECT,
      "Commit",
      "collect",
    );
    const preserve = calls.find(c => c.prompt.includes("preserve-worktree-work.ts"))!;
    const emitted = preserve.prompt.split("\n").find(l => l.startsWith("bun "))!;
    expect(emitted).toContain(`'${nasty}'`);

    // Inside single quotes the shell expands nothing, so the test is whether
    // the substitution is ever reached OUTSIDE them. Walk the line rather
    // than pattern-match it: `/[^']\$\(/` passes on `wf_$(touch pwned)`
    // regardless of the quoting, which is a check that cannot fail.
    let inQuote = false;
    const unquoted: string[] = [];
    for (let i = 0; i < emitted.length; i++) {
      if (emitted[i] === "'") { inQuote = !inQuote; continue; }
      if (!inQuote && emitted.startsWith("$(", i)) unquoted.push(emitted.slice(i, i + 20));
    }
    expect(unquoted, "a command substitution reaches the shell unquoted").toEqual([]);
    expect(inQuote, "the quoting is unbalanced — the line does not parse as intended").toBe(false);
  });

  test("the preserve step is never pointed at the project root", async () => {
    // `git add -A` in the project root would sweep up unrelated working-tree
    // state and commit it under a preserve message.
    const { collectAgentWork, calls } = loadCollectAgentWork((p: string) =>
      p.includes("preserve-worktree-work.ts") ? { entries: [] } : { ok: true, collected: 1 },
    );
    await collectAgentWork(
      [
        { worktreePath: PROJECT, filesChanged: ["lib/a.ts"] },
        { worktreePath: WT_B, filesChanged: ["lib/a.ts"], claimedFiles: ["lib/a.ts"] },
      ],
      PROJECT,
      "Commit",
      "collect",
    );
    const preserve = calls.filter(c => c.prompt.includes("preserve-worktree-work.ts"));
    expect(preserve, "no preserve step ran at all").toHaveLength(1);
    const args = preserve[0]!.prompt.split("preserve-worktree-work.ts'")[1] || "";
    expect(args, "the project root was handed to the preserve step").not.toContain(`'${PROJECT}'`);
    expect(args).toContain(WT_B);
  });
});

/**
 * #229 — claimKey's normalisation, and the division of labour it depends on.
 *
 * The audit and the collector decide one path's fate and normalise it
 * differently: `claimKey` is textual, `collect-worktree-files.ts` resolves
 * with `realpathSync`. Where the two readings can differ, the key must either
 * be normalised the same way or refused — a path that reads as uncontested to
 * the audit and resolves onto a claimed file in the collector is the original
 * #178 clobber reached through normalisation.
 *
 * `escapesWorktree` already carries the refusal half and is well covered:
 * neutralising it turns 3 of these tests red, and so does breaking either of
 * its two halves on its own. The NORMALISATION half was not covered at all —
 * deleting the duplicate-slash collapse from `claimKey` measured 0 red — so
 * these cases exist to make each rewrite in that line falsifiable.
 */
describe("#229: claimKey normalises exactly what it claims to, and refuses the rest", () => {
  const WT = "/tmp/wt-a";

  test("duplicate slashes collapse, so one path cannot wear two keys", () => {
    // The measured gap. Without this, `lib//a.ts` and `lib/a.ts` are distinct
    // keys: a worktree claims one spelling and reports the other, the audit
    // finds no owner for the reported key, and the collector writes it anyway
    // because the filesystem does not distinguish them.
    expect(claimKey(WT, "lib//a.ts")).toBe("lib/a.ts");
    expect(claimKey(WT, "lib///nested////a.ts")).toBe("lib/nested/a.ts");
    expect(claimKey(WT, "lib//a.ts")).toBe(claimKey(WT, "lib/a.ts"));
  });

  test("a leading ./ is stripped, repeatedly", () => {
    expect(claimKey(WT, "./lib/a.ts")).toBe("lib/a.ts");
    expect(claimKey(WT, "././lib/a.ts")).toBe("lib/a.ts");
    expect(claimKey(WT, "./lib/a.ts")).toBe(claimKey(WT, "lib/a.ts"));
  });

  test("a trailing slash is trimmed", () => {
    expect(claimKey(WT, "lib/sub/")).toBe("lib/sub");
    expect(claimKey(WT, "lib/sub//")).toBe("lib/sub");
  });

  test("the worktree prefix is stripped, with or without its trailing slash", () => {
    expect(claimKey(WT, `${WT}/lib/a.ts`)).toBe("lib/a.ts");
    expect(claimKey(`${WT}/`, `${WT}/lib/a.ts`)).toBe("lib/a.ts");
    // A different worktree's path is NOT stripped — it stays absolute, which
    // is what escapesWorktree refuses.
    expect(claimKey(WT, "/tmp/wt-b/lib/a.ts")).toBe("/tmp/wt-b/lib/a.ts");
  });

  test("empty and nullish inputs produce the empty key, not a crash", () => {
    expect(claimKey(WT, "")).toBe("");
    expect(claimKey(WT, "   ")).toBe("");
    expect(claimKey(WT, null)).toBe("");
    expect(claimKey(WT, undefined)).toBe("");
  });

  test("a traversal segment is deliberately NOT collapsed — it is refused instead", () => {
    // This is the design decision, pinned so a later "tidy-up" that teaches
    // claimKey to resolve `..` cannot land silently. Collapsing here would
    // make the key match a claim the worktree never made; refusing keeps the
    // textual key and lets escapesWorktree reject it. Both halves are
    // asserted together because either alone permits the bypass.
    expect(claimKey(WT, "test/../workflows/ship.js")).toBe("test/../workflows/ship.js");
    expect(claimKey(WT, "test/../workflows/ship.js")).not.toBe("workflows/ship.js");

    const audit = auditWorktreeClaims([
      { worktreePath: WT, filesChanged: ["workflows/ship.js"], claimedFiles: ["workflows/ship.js"] },
      {
        worktreePath: "/tmp/wt-b",
        filesChanged: ["test/../workflows/ship.js"],
        claimedFiles: ["test/../workflows/ship.js"],
      },
    ]);

    // The second worktree claimed the path it reported, so the claim check
    // alone would wave it through. The refusal has to come from the boundary.
    const refused = audit.violations.map(v => JSON.stringify(v)).join(" ");
    expect(refused).toContain("..");
    const kept = audit.candidates.flatMap(c => c.filesChanged);
    expect(kept, "a traversal path reached the collector").not.toContain("test/../workflows/ship.js");
  });

  /**
   * SC-881 — the corpus, in the test rather than in prose.
   *
   * The issue asks for SC-1 as "claimKey maps every equivalent spelling of a
   * path to one key". It lives here rather than in a sentence so the next
   * spelling someone invents has somewhere obvious to go, and so that adding
   * one is a one-line change that either passes or does not.
   */
  test("SC-881: every equivalent spelling of one path collapses to one key", () => {
    const equivalent = [
      "a/b.ts",
      "./a/b.ts",
      "././a/b.ts",
      "a//b.ts",
      "a/./b.ts",        // the measured survivor — a MID-path `.`, which the
      "a/./././b.ts",    // old `^(?:\.\/)+` anchor could never reach
      "./a/.//b.ts",
      "a/b.ts/",
      "a/b.ts//",
      "a/./b.ts/",
      `${WT}/a/./b.ts`,  // and the same through the worktree-prefix strip
    ];
    const keys = new Set(equivalent.map(spelling => claimKey(WT, spelling)));
    expect(
      [...keys],
      "one path wearing more than one key is the whole of #229",
    ).toEqual(["a/b.ts"]);
  });

  test("SC-881: a mid-path . segment no longer buys a second worktree a claimed file", () => {
    // The bypass, reproduced. Two worktrees. A claims `a/b.ts`. B claims AND
    // reports `a/./b.ts` — so the claim check alone waves B through, because
    // B did report exactly what it claimed. `escapesWorktree` does not fire:
    // the key is relative and carries no `..`. Before the collapse the audit
    // saw two uncontested files and raised nothing, and then
    // collect-worktree-files.ts resolved B's path with realpathSync onto A's
    // file and wrote B's copy over it. That is #178's clobber reached through
    // normalisation, which is what this issue exists to close.
    const audit = auditWorktreeClaims([
      { worktreePath: WT, filesChanged: ["a/b.ts"], claimedFiles: ["a/b.ts"] },
      { worktreePath: "/tmp/wt-b", filesChanged: ["a/./b.ts"], claimedFiles: ["a/./b.ts"] },
    ]);

    // Two worktrees now claim ONE key, which is the pre-existing refusal for a
    // contested file (ship.js: "a file may have one claimant"). The spelling
    // difference stops hiding the contest; it does not need a new refusal.
    expect(audit.violations.length, "the contest went unnoticed").toBeGreaterThan(0);
    expect(audit.violations.map(v => v.detail).join(" ")).toContain("2 worktrees claim");

    // And neither copy reaches the collector, so there is nothing left to
    // resolve onto A's file.
    const kept = audit.candidates.flatMap(c => c.filesChanged);
    expect(kept, "a contested copy still reached the collector").toEqual([]);
  });

  test("SC-881: collapsing . does not cost the two properties escapesWorktree reads", () => {
    // The collapse runs over segments, and both refusals read segments too, so
    // the risk is that the tidier rewrite quietly launders a path past them.
    //
    // Absoluteness: the leading `/` survives an otherwise-empty prefix.
    expect(claimKey(WT, "/./tmp/wt-b/a.ts")).toBe("/tmp/wt-b/a.ts");
    expect(escapesWorktree(claimKey(WT, "/./tmp/wt-b/a.ts"))).toBe(true);
    expect(claimKey(WT, "//tmp//wt-b/a.ts")).toBe("/tmp/wt-b/a.ts");
    expect(escapesWorktree(claimKey(WT, "//tmp//wt-b/a.ts"))).toBe(true);

    // Traversal: `..` is left intact for escapesWorktree even when it is
    // surrounded by segments the collapse DOES remove. Ordering is the trap —
    // a rewrite that resolved `a/.` into `a` and then paired `..` with it
    // would hand back `b` and the refusal would never fire.
    expect(claimKey(WT, "a/./../b.ts")).toBe("a/../b.ts");
    expect(escapesWorktree(claimKey(WT, "a/./../b.ts"))).toBe(true);
    expect(claimKey(WT, ".././a.ts")).toBe("../a.ts");
    expect(escapesWorktree(claimKey(WT, ".././a.ts"))).toBe(true);
  });

  test("SC-881: a path that is nothing but . segments is the empty key, not a claim", () => {
    // `.` is the worktree root, not a file. The empty key is the value every
    // caller already drops (`if (!key) continue`), so this must not become a
    // one-segment key named `.` that a claim could match.
    expect(claimKey(WT, ".")).toBe("");
    expect(claimKey(WT, "./")).toBe("");
    expect(claimKey(WT, "././.")).toBe("");
    // `/` is not empty — it is an absolute path, and it is refused as one.
    expect(claimKey(WT, "/")).toBe("/");
    expect(escapesWorktree(claimKey(WT, "/"))).toBe(true);
  });
});
