/**
 * A remediation round's work reaches the branch (#155)
 *
 * SC-555..SC-558, SC-571, SC-572, SC-573 (HARNESS-STANDARD.md)
 *
 * `commitDir` is set once, from the FIRST implement pass. The verify and ship
 * remediation loops call `runImplement()` again — a new agent in a new
 * worktree — and then commit from `commitDir`, which still points at the old
 * one. Nothing is staged, `git commit` has nothing to commit, and the agent
 * reports the pre-existing HEAD as "the commit SHA" because the step's schema
 * asks only for a string.
 *
 * Measured on wf_67f052e6-1a5 (shipping #143): three Marcus passes, and the
 * SHA never moved off d6a0c358. Both remediation worktrees were still on disk
 * afterwards, sitting at origin/main with the work uncommitted.
 *
 * The second half is worse than the lost work. The retry gate was handed
 * `reimpl.buildResult?.worktreePath` as its cwd — the NEW worktree — so it
 * graded files that are not on the branch and could not be fetched. The only
 * reason that run did not record a PASS for a tree nobody can see is that the
 * remediation also failed.
 *
 * These assertions read ship.js's source because a workflow script is not
 * importable: the sandbox gives it no module loading (#69). Same constraint,
 * same approach, as test/ship-never-writes-main.test.ts.
 *
 * ── #162 ──────────────────────────────────────────────────────────────────
 *
 * The collection from #155 was wired in and still discarded the work, because
 * what it was handed was `undefined`. `runImplement()` builds `agentResults`
 * only on the decomposed sub-issue path; the single-Marcus path — which is
 * what EVERY remediation round runs — returned a `buildResult` without it. So
 * `collectAgentWork(undefined, …)` defaulted to `[]`, found no worktree to
 * collect from, and returned `{ok: true, collected: 0}` without spawning
 * anything. `gathered.staged` was false, the caller fell back to staging
 * `commitDir`, and `commitDir` is the FIRST pass's worktree, where the new
 * work is not.
 *
 * Measured twice on wf_14bb327b-5d2: both recommit steps reported
 * RUNGATE_NO_CHANGES against an unmoved HEAD, and the better of that run's
 * three implementations was thrown away — recovered by hand from
 * .claude/worktrees/wf_14bb327b-5d2-28.
 *
 * `{ok: true, collected: 0}` was serving two different situations: "there was
 * nothing to collect" and "I was never told what to collect". Only the first
 * is a success.
 *
 * The #162 suites below EXECUTE the collector and `runImplement`, extracted
 * from ship.js by marker and by brace matching, rather than asserting that
 * ship.js contains some string. .claude/rules/checks-must-be-able-to-fail.md
 * is why: "ship.js contains collectAgentWork" stayed true for the entire time
 * the collector was being handed `undefined` on every single remediation
 * round. The source-text sweeps above are kept for the structural properties
 * — ordering, cwd, schema shape — that have no runtime surface.
 *
 * What was broken to prove these fail: reverting `agentResults` out of
 * runImplement's single-agent return turns 4 tests red, and replacing the
 * `Array.isArray` guard with the old `results || []` turns 3 more red.
 * Neither mutation is left in the tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

/** Source with comment lines removed — prose must be able to name the bug. */
function code(source: string): string {
  return source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const shipCode = code(shipSource);

/**
 * Each remediation block: from a re-implementation call to the end of the
 * `if (reimpl.success) {` body that follows it.
 *
 * Sliced by brace depth rather than by a line count, so inserting a step into
 * a block cannot silently drop it out of the window being asserted on.
 */
function remediationBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /const reimpl = await runImplement\(\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf("{", source.indexOf("if (reimpl.success)", m.index));
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) break;
    }
    blocks.push(source.slice(m.index, i + 1));
  }
  return blocks;
}

describe("#155: the remediation loops exist and are found", () => {
  test("there are exactly two of them — verify and ship", () => {
    // A positive control for every assertion below: if the slicer stops
    // matching, the sweeps would pass against an empty list.
    expect(remediationBlocks(shipCode).length).toBe(2);
  });
});

describe("#155: a remediation round's work is collected before it is committed", () => {
  test("every remediation block collects the new worktree's files", () => {
    const missing = remediationBlocks(shipCode).filter(b => !b.includes("collectAgentWork("));
    expect(missing).toEqual([]);
  });

  test("the collection runs before the commit, not after it", () => {
    for (const block of remediationBlocks(shipCode)) {
      const collect = block.indexOf("collectAgentWork(");
      const commit = block.indexOf("git commit");
      expect(collect).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThanOrEqual(0);
      expect(collect).toBeLessThan(commit);
    }
  });

  test("the retry gate is not pointed at the re-implementation's worktree", () => {
    // The exact line from the measured run:
    //   { cwd: reimpl.buildResult?.worktreePath || marcusWorktreePath }
    // Grading a directory whose contents are not on the branch is how a run
    // records a PASS for a tree nobody can fetch.
    expect(shipCode).not.toContain("reimpl.buildResult?.worktreePath");
    expect(shipCode).not.toContain("reimpl.buildResult.worktreePath");
  });

  test("every remediation gate runs from the directory that was committed", () => {
    for (const block of remediationBlocks(shipCode)) {
      const cwds = [...block.matchAll(/cwd:\s*([A-Za-z0-9_.?[\]'" ]+?)\s*[}),]/g)].map(m => m[1].trim());
      for (const cwd of cwds) expect(cwd).toBe("commitDir");
    }
  });
});

describe("#155: a commit that committed nothing is not reportable as success", () => {
  test("the recommit schema asks for the parent too", () => {
    // {commitSha: string} is satisfied by echoing the HEAD that was already
    // there — which is exactly what happened three times on wf_67f052e6-1a5.
    // Requiring the parent makes "I committed nothing" a statement the step
    // has to make rather than one it can omit.
    const blocks = remediationBlocks(shipCode);
    for (const block of blocks) {
      expect(block).toContain("parentSha");
      expect(block).toMatch(/required:\s*\[[^\]]*'parentSha'/);
    }
  });

  test("a recommit whose parent equals its SHA is treated as a failure", () => {
    for (const block of remediationBlocks(shipCode)) {
      expect(block).toContain("commitSha === ");
    }
  });
});

// ── #162: the collector and runImplement, executed rather than grepped ──────

const PROJECT = "/Users/dev/proj";
const HARNESS = "/Users/dev/harness";
const WORK = "/Users/dev/.rungate/run-162";
const WORKTREE_A = `${PROJECT}/.claude/worktrees/wf_a-1`;
const WORKTREE_B = `${PROJECT}/.claude/worktrees/wf_a-2`;

/** The text between a START/END marker pair, markers included. */
function markedBlock(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers not found in ship.js`);
  return shipSource.slice(start, end);
}

/**
 * A named function declaration, sliced by brace depth from its header.
 *
 * `runImplement` has no markers around it and does not need any: the header
 * is unique and the body's braces balance. Slicing by depth rather than by a
 * line count means adding a step to the function cannot silently drop the
 * part under test out of the window.
 */
function slicedFunction(header: string): string {
  const at = shipSource.indexOf(header);
  if (at < 0) throw new Error(`${header} not found in ship.js`);
  const open = shipSource.indexOf("{", at);
  let depth = 0;
  let i = open;
  for (; i < shipSource.length; i++) {
    if (shipSource[i] === "{") depth++;
    else if (shipSource[i] === "}" && --depth === 0) break;
  }
  return shipSource.slice(at, i + 1);
}

type AgentCall = { prompt: string; opts: unknown };
type CollectResult = { ok: boolean; collected: number; staged: boolean; detail?: string };

/**
 * The real `collectAgentWork`, with the real `collectDestination` beside it,
 * running against an injected `agent`.
 *
 * All three marker blocks go into one function body so the allowlist and the
 * claim check under test are the shipped ones rather than stand-ins —
 * `collectAgentWork` calls `collectDestination(intoDir)` with one argument and
 * relies on its module-scope defaults, which are passed in here as parameters,
 * and `auditWorktreeClaims(results)` from COLLECT-CLAIM (#178). Same
 * extraction pattern as `loadCollectDestination` in
 * test/ship-collect-destination.test.ts.
 */
function loadCollectAgentWork(agentImpl: (p: string, o: unknown) => unknown) {
  const body = [
    markedBlock("COLLECT-DESTINATION"),
    markedBlock("COLLECT-CLAIM"),
    // Every refusal preserves the worktrees before returning (#228), so the
    // collector no longer stands up without it.
    markedBlock("PRESERVE-REFUSED"),
    markedBlock("COLLECT-AGENT-WORK"),
  ].join("\n");
  return new Function(
    "PROJECT_ROOT",
    "HARNESS_ROOT",
    "WORK_DIR",
    "log",
    "agent",
    "shellQuote",
    `${body}\nreturn collectAgentWork`,
  )(
    PROJECT,
    HARNESS,
    WORK,
    () => {},
    agentImpl,
    (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`,
  ) as (
    results: unknown,
    intoDir: string,
    phase: string,
    label: string,
  ) => Promise<CollectResult>;
}

/** A collector whose agent step returns `reply`, plus the calls it received. */
function collectorWithAgent(reply: unknown) {
  const calls: AgentCall[] = [];
  const collect = loadCollectAgentWork((prompt, opts) => {
    calls.push({ prompt, opts });
    return reply;
  });
  return { collect, calls };
}

/** The real `runImplement`, with every dependency it reaches for injected. */
function loadRunImplement(opts: { ceremony?: unknown; buildResult: unknown }) {
  return new Function(
    "runCeremonyOnce",
    "briefedAgent",
    "log",
    "WORK_DIR",
    "testTimeout",
    "BUILD_RESULT_SCHEMA",
    `${slicedFunction("async function runImplement()")}\nreturn runImplement`,
  )(
    async () => opts.ceremony ?? { contextExcerpts: [], acContextFiles: [] },
    async () => opts.buildResult,
    () => {},
    WORK,
    300000,
    {},
  ) as () => Promise<{ success?: boolean; status?: string; buildResult?: any }>;
}

describe("#162: the extraction finds real code", () => {
  // Positive controls. Without these, a marker rename or a renamed function
  // would make every suite below pass against a function that does nothing —
  // which is the #155 failure mode repeating one level up.
  test("the collector is a function with the expected arity", () => {
    const { collect } = collectorWithAgent({ ok: true, collected: 1 });
    expect(typeof collect).toBe("function");
    expect(collect.length).toBe(4);
  });

  test("runImplement is a function sliced whole", () => {
    const sliced = slicedFunction("async function runImplement()");
    expect(sliced.startsWith("async function runImplement()")).toBe(true);
    expect(sliced.endsWith("}")).toBe(true);
    expect(sliced).toContain("briefedAgent(");
  });
});

describe("#162: runImplement's single-agent path reports what to collect", () => {
  test("success carries agentResults pairing its worktree with its files", async () => {
    const runImplement = loadRunImplement({
      buildResult: {
        success: true,
        worktreePath: WORKTREE_B,
        filesChanged: ["lib/a.ts", "test/a.test.ts"],
      },
    });
    const result = await runImplement();
    expect(result.success).toBe(true);
    // The pairing is the point. `filesChanged` alone cannot be relativized
    // against the right directory, which is what #81 lost and what #162 then
    // lost again by not producing the field at all.
    expect(result.buildResult.agentResults).toEqual([
      { worktreePath: WORKTREE_B, filesChanged: ["lib/a.ts", "test/a.test.ts"] },
    ]);
  });

  test("a build that reported no files still yields an array, not undefined", async () => {
    const runImplement = loadRunImplement({
      buildResult: { success: true, worktreePath: WORKTREE_B },
    });
    const result = await runImplement();
    expect(Array.isArray(result.buildResult.agentResults)).toBe(true);
    expect(result.buildResult.agentResults[0].filesChanged).toEqual([]);
  });

  test("a failed build is still a failure and is not dressed up", async () => {
    const runImplement = loadRunImplement({
      buildResult: { success: false, findings: ["tests red"] },
    });
    const result = await runImplement();
    expect(result.success).toBe(false);
  });

  test("its output is accepted by the collector without a caller error", async () => {
    // The two halves, joined. This is the exact hand-off that silently
    // produced {ok:true, collected:0} on every remediation round: the shape
    // runImplement returns, fed to the collector the remediation calls.
    const runImplement = loadRunImplement({
      buildResult: { success: true, worktreePath: WORKTREE_B, filesChanged: ["lib/a.ts"] },
    });
    const impl = await runImplement();
    const { collect, calls } = collectorWithAgent({ ok: true, collected: 1 });
    const gathered = await collect(impl.buildResult.agentResults, WORKTREE_A, "Verify", "l");
    expect(gathered.ok).toBe(true);
    expect(gathered.staged).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].prompt).toContain(WORKTREE_B);
  });
});

describe("#162: a caller that cannot say what to collect is a failure", () => {
  const notLists: [string, unknown][] = [
    ["undefined — the measured bug", undefined],
    ["null", null],
    ["a string", "lib/a.ts"],
    ["an object that is not an array", { worktreePath: WORKTREE_B }],
    ["a number", 3],
  ];

  for (const [name, value] of notLists) {
    test(`${name} is refused, and no collection is attempted`, async () => {
      const { collect, calls } = collectorWithAgent({ ok: true, collected: 9 });
      const gathered = await collect(value, WORKTREE_A, "Verify", "l");
      expect(gathered.ok).toBe(false);
      expect(gathered.collected).toBe(0);
      expect(gathered.staged).toBe(false);
      // The detail has to name the CALLER, not the worktrees — the operator
      // reading the log needs "nobody told me what to collect", which reads
      // nothing like "there was nothing to collect".
      expect(gathered.detail ?? "").toMatch(/caller/i);
      expect(calls.length).toBe(0);
    });
  }

  test("an empty list is still an ordinary success", async () => {
    // The distinction the fix exists to make. Refusing [] too would break the
    // single-worktree case, where there is genuinely nothing to move.
    const { collect, calls } = collectorWithAgent({ ok: true, collected: 9 });
    const gathered = await collect([], WORKTREE_A, "Verify", "l");
    expect(gathered.ok).toBe(true);
    expect(gathered.collected).toBe(0);
    expect(gathered.staged).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("a list naming only the destination itself collects nothing, successfully", async () => {
    const { collect, calls } = collectorWithAgent({ ok: true, collected: 9 });
    const gathered = await collect(
      [{ worktreePath: WORKTREE_A, filesChanged: ["lib/a.ts"] }], WORKTREE_A, "Verify", "l");
    expect(gathered.ok).toBe(true);
    expect(gathered.collected).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe("#162: the refusals that were already there still hold", () => {
  // The new guard runs before all of these. If it were written as an early
  // `return {ok: true}` for anything unexpected, or placed after the
  // destination check, these would go red.
  test("a destination outside the allowlist is refused", async () => {
    const { collect, calls } = collectorWithAgent({ ok: true, collected: 9 });
    const gathered = await collect(
      [{ worktreePath: WORKTREE_B }], "/tmp/$(touch pwned)", "Verify", "l");
    expect(gathered.ok).toBe(false);
    // No COLLECTION ran. The refusal does now spawn a preserve step (#228),
    // which commits the refused worktree onto its own branch and touches the
    // destination not at all — so count the collect step, not every call.
    const collectCalls = calls.filter(c => String(c.prompt).includes("collect-worktree-files.ts"));
    expect(collectCalls.length).toBe(0);
    expect(calls.every(c => !String(c.prompt).includes("touch pwned"))).toBe(true);
  });

  test("the project root is a valid destination", async () => {
    const { collect, calls } = collectorWithAgent({ ok: true, collected: 2 });
    const gathered = await collect([{ worktreePath: WORKTREE_B }], PROJECT, "Commit", "l");
    expect(gathered.ok).toBe(true);
    expect(gathered.collected).toBe(2);
    expect(calls.length).toBe(1);
  });

  test("an agent claiming success with nothing collected fails closed", async () => {
    const { collect } = collectorWithAgent({ ok: true, collected: 0 });
    const gathered = await collect([{ worktreePath: WORKTREE_B }], WORKTREE_A, "Verify", "l");
    expect(gathered.ok).toBe(false);
    expect(gathered.staged).toBe(false);
  });

  test("a malformed agent reply fails closed", async () => {
    const { collect } = collectorWithAgent(null);
    const gathered = await collect([{ worktreePath: WORKTREE_B }], WORKTREE_A, "Verify", "l");
    expect(gathered.ok).toBe(false);
  });
});
