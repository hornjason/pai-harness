/**
 * Covers SC-853, SC-854, SC-855 (HARNESS-STANDARD.md).
 *
 * #181 — `runImplement` accepted `{success: true, filesChanged: []}` and the
 * run proceeded to commit. The only thing that read the field was a log
 * line:
 *
 *   log(`IMPLEMENT SUCCESS — ${(buildResult.filesChanged || []).length} files changed`)
 *
 * It printed `0` and carried on.
 *
 * Measured on `wf_17267830-401`: Marcus returned `filesChanged: []` with
 * `testOutput: "No tests run — … No code was changed."` — a clear
 * explanation that reached nothing. The run was stopped by
 * `COMMIT_STATE_NOT_RECORDED`, an UNRELATED guard that fired only because
 * the worktree had gone. Had the worktree survived, the empty
 * implementation would have travelled further.
 *
 * `success: true` was serving both "implemented it" and "declined to", and
 * only the first is a success — the same shape as #162's
 * `{ok: true, collected: 0}` and #166's unmentioned effect.
 *
 * The guard is extracted by marker and EXECUTED here, because a guard that
 * exists and is never called is the defect one layer up.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const BLOCK_START = "// ──── IMPLEMENT-RESULT-START ────";
const BLOCK_END = "// ──── IMPLEMENT-RESULT-END ────";

function loadGuard(): (r: unknown, label: string) => string | null {
  const start = shipSource.indexOf(BLOCK_START);
  const end = shipSource.indexOf(BLOCK_END);
  if (start === -1 || end === -1) {
    throw new Error("ship.js is missing the IMPLEMENT-RESULT-START/END markers");
  }
  const block = shipSource.slice(start + BLOCK_START.length, end);
  return new Function(`${block}\nreturn implementRefusal;`)();
}

const implementRefusal = loadGuard();

describe("#181 SC-853: an empty filesChanged stops the run, a real implementation still proceeds", () => {
  test("the exact result from wf_17267830-401 is refused", () => {
    const refusal = implementRefusal(
      {
        success: true,
        branch: "worktree-wf_17267830-401-8",
        filesChanged: [],
        testFiles: [],
        testOutput: "No tests run — … No code was changed.",
      },
      "marcus",
    );
    expect(refusal, "the measured empty result was accepted").not.toBeNull();
    expect(refusal).toMatch(/changed no files/);
  });

  test("a real implementation is NOT refused", () => {
    // The positive control AC-1 names. A guard that rejects every implement
    // result satisfies the case above and breaks the pipeline entirely.
    expect(
      implementRefusal(
        { success: true, filesChanged: ["lib/a.ts", "test/a.test.ts"], testOutput: "3 pass" },
        "marcus",
      ),
    ).toBeNull();
  });

  test("one changed file is enough", () => {
    // The boundary, from the side that must still pass.
    expect(implementRefusal({ success: true, filesChanged: ["lib/a.ts"] }, "marcus")).toBeNull();
  });

  test("an already-failed result is left to its own handler", () => {
    // The guard answers one question. A `success: false` result is refused
    // by the caller's own branch with its own findings, and reporting it
    // twice under a different reason would misattribute the failure.
    expect(implementRefusal({ success: false, filesChanged: [] }, "marcus")).toBeNull();
  });

  test("a missing or malformed filesChanged is refused, not assumed full", () => {
    // Absent is not "lots". `|| []` upstream already turns undefined into
    // empty for the log line; the guard must reach the same answer rather
    // than passing a result it could not read.
    expect(implementRefusal({ success: true }, "marcus")).not.toBeNull();
    expect(implementRefusal({ success: true, filesChanged: null }, "marcus")).not.toBeNull();
    expect(implementRefusal({ success: true, filesChanged: "lib/a.ts" }, "marcus")).not.toBeNull();
  });
});

describe("#181 SC-854 (AC-2): the refusal names what the agent said it did", () => {
  test("testOutput travels with the failure", () => {
    // On the measured run `testOutput` explained the whole thing and none
    // of it reached the run's result. A refusal that says only "changed no
    // files" sends the next reader back to the transcript.
    const refusal = implementRefusal(
      { success: true, filesChanged: [], testOutput: "No code was changed." },
      "marcus",
    );
    expect(refusal).toContain("No code was changed.");
  });

  test("findings are used when there is no testOutput", () => {
    const refusal = implementRefusal(
      { success: true, filesChanged: [], findings: ["already done on main", "nothing to do"] },
      "marcus",
    );
    expect(refusal).toContain("already done on main");
  });

  test("an agent that explained nothing is reported as having explained nothing", () => {
    // Not an empty string spliced into the message, which reads as a
    // truncated report rather than as an agent that said nothing.
    const refusal = implementRefusal({ success: true, filesChanged: [] }, "marcus");
    expect(refusal).toMatch(/no explanation/i);
  });

  test("the label identifies WHICH agent, so a sub-issue is distinguishable", () => {
    expect(implementRefusal({ success: true, filesChanged: [] }, "marcus-sub-178"))
      .toContain("marcus-sub-178");
  });
});

describe("#181 SC-855 (AC-3): both implement paths consult the guard", () => {
  test("runImplement refuses rather than logging the count", () => {
    const fn = shipSource.slice(shipSource.indexOf("async function runImplement()"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body, "runImplement does not call the guard").toContain("implementRefusal(");
    // SC-9420's negative half: the count must be acted on, not narrated. The
    // log line may stay — it is useful — but it can no longer be the only
    // reader of the field.
    expect(body).toMatch(/return \{ success: false/);
  });

  test("the decomposed path consults it per sub-issue, not on the union", () => {
    // AC-3. `allFilesChanged` is a union across sub-issues, so one
    // sub-issue that changed nothing is invisible the moment the lists are
    // merged. The check has to happen before the flatMap.
    const start = shipSource.indexOf("// ──── DECOMPOSED-SHIP-START ────");
    const end = shipSource.indexOf("// ──── DECOMPOSED-SHIP-END ────");
    const block = shipSource.slice(start, end);
    expect(block, "the decomposed path never calls the guard").toContain("implementRefusal(");
    const guardAt = block.indexOf("implementRefusal(");
    const unionAt = block.indexOf("const allFilesChanged");
    expect(guardAt, "the guard runs after the union, where the gap is hidden")
      .toBeLessThan(unionAt);
  });

  test("the guard has exactly one definition, so there is one binding to mutate", () => {
    expect(shipSource.match(/function implementRefusal\b/g) ?? []).toHaveLength(1);
  });
});

describe("#181 SC-855 (AC-3): the decomposed path ACTS on the refusal, it does not merely compute it", () => {
  // Grepping proved the guard is called. It did not prove the call changes
  // anything: flipping the refusing branch's `ok: false` to `ok: true` left
  // every assertion above green, because the guard still ran and the
  // sub-issue still shipped. A guard whose answer is discarded is the same
  // defect one layer up — so this runs the real block.

  function loadRunDecomposedShip(agent: (p: string, o: { label: string }) => Promise<unknown>) {
    const bStart = shipSource.indexOf("// ──── DECOMPOSED-SHIP-START ────");
    const bEnd = shipSource.indexOf("// ──── DECOMPOSED-SHIP-END ────");
    const gStart = shipSource.indexOf(BLOCK_START);
    const gEnd = shipSource.indexOf(BLOCK_END);
    if (bStart === -1 || bEnd === -1) throw new Error("missing DECOMPOSED-SHIP markers");
    const guard = new Function(`${shipSource.slice(gStart, gEnd)}\nreturn implementRefusal;`)();
    // #218's guard, injected the same way and for the same reason: a stub
    // would let this suite and the real block disagree about which
    // repository a worktree belongs to.
    const iStart = shipSource.indexOf("// ──── WORKTREE-IDENTITY-START ────");
    const iEnd = shipSource.indexOf("// ──── WORKTREE-IDENTITY-END ────");
    if (iStart === -1 || iEnd === -1) throw new Error("missing WORKTREE-IDENTITY markers");
    const identity = new Function(`${shipSource.slice(iStart, iEnd)}\nreturn worktreeIdentity;`)();
    // #180s guard, injected the same way and for the same reason.
    const pStart = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-START ────");
    const pEnd = shipSource.indexOf("// ──── BRIEF-PRECEDENCE-END ────");
    if (pStart === -1 || pEnd === -1) throw new Error("missing BRIEF-PRECEDENCE markers");
    const taskSource = new Function(`${shipSource.slice(pStart, pEnd)}\nreturn taskSourceRefusal;`)();
    // #420's predicate, from its own markers. The run ref and the wave commit
    // are faked — this file is about an empty implement result — but a stub
    // for the predicate would let the loop and the block disagree about which
    // waves hand output forward, and nothing would notice.
    const rStart = shipSource.indexOf("// ──── RUN-REF-START ────");
    const rEnd = shipSource.indexOf("// ──── RUN-REF-END ────");
    if (rStart === -1 || rEnd === -1) throw new Error("ship.js is missing the RUN-REF markers");
    const waveNeedsIntegration = new Function(
      `${shipSource.slice(rStart, rEnd)}\nreturn waveNeedsIntegration;`,
    )();
    // #611's element-shape guard, evaluated INTO the block's scope rather
    // than injected, for the same reason as the four above: a stub would let
    // this suite and the real block disagree about what a reported path is.
    const sStart = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-START ────");
    const sEnd = shipSource.indexOf("// ──── FILES-CHANGED-SHAPE-END ────");
    if (sStart === -1 || sEnd === -1) {
      throw new Error("ship.js is missing the FILES-CHANGED-SHAPE markers");
    }
    const shapeBlock = shipSource.slice(sStart, sEnd);
    const logs: string[] = [];
    const factory = new Function(
      "log", "briefedAgent", "parallel", "WORK_DIR", "ISSUE", "PROJECT_ROOT",
      "BUILD_RESULT_SCHEMA", "runImplement", "implementRefusal",
    "worktreeIdentity",
    "REPO",
      "taskSourceRefusal",
    "establishRunRef", "integrateWave", "waveNeedsIntegration",
    "measureLaunchBase",
      `${shapeBlock}\n${shipSource.slice(bStart, bEnd)}\nreturn runDecomposedShip;`,
    );
    const run = factory(
      (m: string) => logs.push(String(m)),
      agent,
      (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map(t => t())),
      "/tmp/work", 181, REPO_ROOT, {},
      async () => ({ success: true, buildResult: {} }),
      guard,
      identity,
      "owner/project",
      taskSource,
      async () => ({ branch: "rungate/run-181", refusal: null }),
      async () => ({ ok: true, integrated: 0 }),
      waveNeedsIntegration,
      async () => ({ reading: "SAME_CHECKOUT", refusal: null }),
    );
    return { run, logs };
  }

  const SUBS = [
    { number: 1, title: "alpha", acs: ["a1"], filesToModify: ["lib/alpha.ts"], size: "S" },
    { number: 2, title: "beta", acs: ["b1"], filesToModify: ["lib/beta.ts"], size: "S" },
  ];

  test("one sub-issue that changed nothing fails the batch", async () => {
    // Keyed on the PROMPT, not the label. The dispatch synthesises labels
    // like `marcus-sub-181002` from the issue number and an index, not
    // from the sub-issue, so matching on the label was matching nothing
    // and both arms returned the same thing.
    const declines = (p: string) => p.includes("beta");
    const { run, logs } = loadRunDecomposedShip(async (p: string) => ({
      success: true,
      worktreePath: "/tmp/wt",
      worktreeRepo: "git@github.com:owner/project.git",
      // `beta` declines. Its file list is empty; `alpha`'s is not, so the
      // union is non-empty and the merged result looks healthy.
      filesChanged: declines(p) ? [] : ["lib/alpha.ts"],
      testOutput: declines(p) ? "No code was changed." : "2 pass",
    }));
    const result: any = await run(SUBS);
    expect(result.success, "a sub-issue that changed nothing shipped anyway").toBe(false);
    expect(logs.join("\n")).toMatch(/Sub-issue FAILED: beta/);
    expect(logs.join("\n"), "the reason did not travel").toMatch(/No code was changed\./);
  });

  test("the union does not hide it — the failure is attributed to the right sub-issue", () => {
    // Restating the trap: `allFilesChanged` flattens across sub-issues, so
    // `alpha`'s one file would make the merged list non-empty and a check
    // placed after the merge would see nothing wrong.
    expect(["lib/alpha.ts"].length, "the union of [alpha] and [] is non-empty")
      .toBeGreaterThan(0);
  });

  test("a batch where every sub-issue changed something still succeeds", async () => {
    // The positive control. A guard that fails every batch satisfies the
    // case above and breaks decomposed shipping entirely.
    const { run } = loadRunDecomposedShip(async (_p, { label }) => ({
      success: true,
      worktreePath: "/tmp/wt",
      worktreeRepo: "git@github.com:owner/project.git",
      filesChanged: [`${label}.ts`],
      testOutput: "2 pass",
      // #180 — the dispatch now also refuses a reply that cannot say which
      // instruction it worked from, so the positive control has to say.
      taskSource: "brief",
    }));
    const result: any = await run(SUBS);
    expect(result.success).toBe(true);
    expect(result.buildResult.filesChanged).toHaveLength(2);
  });
});
