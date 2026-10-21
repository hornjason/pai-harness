/**
 * Covers SC-1797..SC-1804 (HARNESS-STANDARD.md), #524.
 *
 * A terminal status with no reason is the reporting layer failing the way
 * #276 failed in the deciding layer: the run knows it stopped, and the thing
 * an operator reads says nothing about why.
 *
 * `workflows/ship.js` has two funnels. #252 gave the SHIP_FAILED one a reason
 * floor — `failureSummary` ends with "the run refused without recording a
 * reason" when the ledger is empty. The other funnel never got one, and three
 * of its call sites returned a status, a work directory, and nothing else.
 *
 * Two instruments here, and they answer different questions:
 *
 * - `terminalReason`, sliced out of the source and EXECUTED, for what the
 *   floor does with each shape a caller can hand it.
 * - the whole script, run through `lib/workflow-test-harness.ts` (#61), for
 *   whether the reason an operator ends up holding is the SPECIFIC one. That
 *   distinction is the point: the cheap repair for this issue is to add the
 *   floor and stop, which makes every exit carry the same generic sentence
 *   and reads as fixed. The behavioural rows below name the text, so that
 *   repair fails them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { runWorkflow } from "../lib/workflow-test-harness";

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

/** A marked block of ship.js, by its START/END fence. */
function block(name: string): string {
  const start = SHIP.indexOf(`// ──── ${name}-START ────`);
  const end = SHIP.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} block is not in ship.js`);
  return SHIP.slice(start, end);
}

/** #889's note, read from its one declaration in ship.js rather than copied. */
function noteValue(): string {
  const at = SHIP.indexOf("const RESUME_REPLAYS_NOTE =");
  if (at < 0) throw new Error("RESUME_REPLAYS_NOTE is not in ship.js");
  const end = SHIP.indexOf("\n\n", at);
  return new Function(`${SHIP.slice(at, end)}; return RESUME_REPLAYS_NOTE;`)() as string;
}

/** `terminalReason`, lifted out of the sandbox and callable. */
function reasonFn(): (status: unknown, extra: unknown) => string {
  const body = block("TERMINAL-REASON");
  return new Function(`${body}; return terminalReason;`)() as (s: unknown, e: unknown) => string;
}

const SENTINEL = "nothing recorded why";

// ── the floor itself ─────────────────────────────────────────

describe("#524: the terminal funnel always has a reason to give", () => {
  test("SC-1797: a caller's own reason comes back verbatim", () => {
    const terminalReason = reasonFn();
    expect(terminalReason("COMMIT_FAILED", { reason: "the branch was the default branch" }))
      .toBe("the branch was the default branch");

    // Whitespace-only is not a reason. A caller that passes `reason: ' '`
    // satisfies a truthiness check and hands the operator a blank line, which
    // is the silence this issue is about wearing a field name.
    expect(terminalReason("X_FAILED", { reason: "   " })).toContain(SENTINEL);
    expect(terminalReason("X_FAILED", { reason: 42 })).toContain(SENTINEL);
  });

  test("SC-1798: each shape the existing call sites pass is read", () => {
    const terminalReason = reasonFn();
    // Not invented shapes — every one of these is what some live call site in
    // ship.js hands the funnel today. A floor that only read `reason` would
    // report the sentinel over four exits that do say why.
    expect(terminalReason("GOAL_FAILED", { message: "could not read the issue" }))
      .toBe("could not read the issue");
    expect(terminalReason("SCOPE_FAILED", { failures: ["AC-1 has no evidence", "AC-2 is untestable"] }))
      .toBe("AC-1 has no evidence; AC-2 is untestable");
    expect(terminalReason("IMPLEMENT_FAILED", { buildResult: { findings: ["the tests did not run"] } }))
      .toBe("the tests did not run");
    expect(terminalReason("VALIDATE_FAILED", { quinnLocalResult: { failures: ["the UI never loaded"] } }))
      .toBe("the UI never loaded");
  });

  test("SC-1799: an empty list is absence - not an empty reason", () => {
    const terminalReason = reasonFn();
    // `[]`, `['']` and `[null]` all join to the empty string, and a floor that
    // returned it would put a blank `reason` field on the result. That is
    // strictly worse than no field: a reader sees the key and concludes the
    // run was asked and had nothing to say.
    for (const extra of [
      { failures: [] },
      { failures: ["", "  "] },
      { failures: [null, undefined] },
      { buildResult: { findings: [] } },
      { buildResult: {} },
      { quinnLocalResult: { failures: [] } },
    ]) {
      expect(terminalReason("X_FAILED", extra), JSON.stringify(extra)).toContain(SENTINEL);
    }
  });

  test("SC-1800: with nothing at all it names the absence and blames this file", () => {
    const terminalReason = reasonFn();
    for (const extra of [undefined, null, {}, "", 0, []]) {
      const why = terminalReason("COMMIT_FAILED", extra);
      expect(why, `${JSON.stringify(extra)} produced no sentinel`).toContain(SENTINEL);
      // The status is in the text. A sentinel that did not name which exit
      // produced it is a sentence an operator cannot act on either.
      expect(why).toContain("COMMIT_FAILED");
      // And it says whose gap this is. A reason reading like a finding about
      // the work would be a Silent Default Substitution with better prose —
      // the operator would go looking for a problem in their code.
      expect(why).toContain("gap in this workflow");
    }
    // A missing status does not produce the string "undefined".
    expect(terminalReason(undefined, {})).not.toContain("undefined");
  });

  test("SC-1801: the funnel puts it on the result - and never over a real one", async () => {
    // Executed rather than grepped. `reason: terminalReason(...)` sitting
    // BEFORE the `...extra` spread would be overwritten by any caller
    // passing the field, and the source reads identically either way.
    const start = SHIP.indexOf("async function terminalFailure(");
    const open = SHIP.indexOf("{", SHIP.indexOf(")", start));
    let depth = 0;
    let close = -1;
    for (let i = open; i < SHIP.length; i++) {
      if (SHIP[i] === "{") depth++;
      else if (SHIP[i] === "}" && --depth === 0) { close = i + 1; break; }
    }
    expect(close, "could not slice terminalFailure").toBeGreaterThan(open);

    const fn = new Function(
      "preserveSeenWorktrees", "WORK_DIR", "terminalReason", "restorePrimaryCheckout",
      "RESUME_REPLAYS_NOTE",
      `${SHIP.slice(start, close)}; return terminalFailure;`,
    )(
      async () => ({ preserved: [], detail: "" }),
      "/tmp/work",
      reasonFn(),
      // #640: the funnel restores the shared checkout on the way out. Stubbed
      // rather than omitted — an absent binding is a ReferenceError inside the
      // funnel, which would red this case for a reason that has nothing to do
      // with the reason floor it is about.
      async () => ({ reading: "UNCHANGED", restoreOutcome: "ALREADY_ON_START", lines: [] }),
      // #889's note, the same way and for the same reason: the funnel now
      // reads it, so an absent binding throws inside the slice. Its VALUE is
      // taken from ship.js rather than copied here — a copy would be a second
      // declaring position for a string #889 asserts has exactly one.
      noteValue(),
    ) as (s: string, e?: unknown) => Promise<Record<string, unknown>>;

    expect((await fn("COMMIT_FAILED")).reason).toContain(SENTINEL);
    expect((await fn("SCOPE_FAILED", { failures: ["AC-1 has no evidence"] })).reason)
      .toBe("AC-1 has no evidence");
    // A caller's reason survives the funnel untouched.
    expect((await fn("VERIFY_FAILED", { reason: "the regression round built nothing" })).reason)
      .toBe("the regression round built nothing");
    // And the rest of the payload is still there — the floor adds a field, it
    // does not replace the result.
    const out = await fn("COMMIT_FAILED", { commitResult: { branch: "b" } });
    expect(out.status).toBe("COMMIT_FAILED");
    expect(out.commitResult).toEqual({ branch: "b" });
  });
});

// ── the three exits that had nothing to say ──────────────────

describe("#524: the exits that carried no reason now carry a specific one", () => {
  /**
   * The two overrides a synthetic run needs before it reaches Implement at
   * all, and both are properties of the harness rather than of ship.js.
   *
   * `syntheticFromSchema` fills every enum with its FIRST value, so every
   * prior-work AC comes back `MET` and the run correctly reports the issue
   * as already shipped; and it fills every string with the same placeholder,
   * so the issue's success criteria and the ACs' `coversCriteria` are
   * different strings and the coverage refusal fires. Neither is a defect
   * being worked around — they are the branches those guards exist for, and
   * #251 and the prior-work detector have their own tests.
   */
  const REACHES_IMPLEMENT: Record<string, (s: any) => unknown> = {
    // The launch-base check (#644) is the run's first step and refuses
    // anything but SAME_CHECKOUT — including the UNMEASURED that a synthetic
    // placeholder reading produces. `/tmp/p` has never been a repository,
    // because no case before #644 needed it to be, so without this every run
    // here terminates at LAUNCH_BASE_FAILED and none of the exits below is
    // ever reached. A third property of the harness, same as the two above.
    "launch-base": () => ({ reading: "SAME_CHECKOUT", cwd: "/tmp/p", refusal: null, exitCode: 0 }),
    "read-issue": s => ({ ...s, successCriteria: [] }),
    discovery: s => ({ ...s, priorWork: { explicitCommits: [], acStatus: [{ id: "AC-1", status: "UNMET" }] } }),
  };

  /** A whole ship.js run with stubbed agents, by label overrides. */
  const run = (overrides: Record<string, (s: any) => unknown>) => {
    const merged: Record<string, (s: any) => unknown> = { ...REACHES_IMPLEMENT };
    for (const [label, fn] of Object.entries(overrides)) {
      const before = merged[label];
      merged[label] = before ? (s: any) => fn(before(s)) : fn;
    }
    return runWorkflow(SHIP, {
      args: { issue: 1, projectRoot: "/tmp/p", repo: "o/r", harnessRoot: "/tmp/h" },
      overrides: merged,
    });
  };

  const resultOf = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.error, `the harness itself threw: ${r.error?.message}`).toBeNull();
    return (r.result ?? {}) as Record<string, unknown>;
  };

  test("SC-1802: an implement phase that returned nothing says so", async () => {
    // The case #524 was filed on, driven through the real control flow: the
    // agent produces no reply at all, `buildResult` is undefined, and the
    // terminal object used to be `{status, buildResult: undefined, workDir}`.
    const out = resultOf(await run({ marcus: (() => undefined) as (s: any) => unknown }));

    expect(out.status).toBe("IMPLEMENT_FAILED");
    expect(String(out.reason)).toContain("no build result at all");
    // NOT the floor. If this row accepted the sentinel, the cheapest repair
    // for this whole issue — add the floor, change no call site — would pass
    // it, and the operator would be told the workflow has a gap rather than
    // that the implement agent died.
    expect(String(out.reason)).not.toContain(SENTINEL);
  });

  test("SC-1803: an implement phase that failed silently is a different sentence", async () => {
    // Distinct from the row above on purpose. An agent that returned nothing
    // and an agent that answered `success: false` with no findings are
    // different failures — one is a dead spawn, the other is a live agent
    // that would not say. Collapsing them into one sentinel loses the only
    // thing that tells an operator where to look.
    //
    // A reply that reaches this branch has to survive the worktree-identity
    // check above it (#218), which the synthetic placeholder does not — so
    // the reply names the run's own repo. Without that the row measures
    // #218's refusal and never reaches the one it is about, which is how a
    // fixture passes through a path that bypasses the feature.
    const owned = (s: any) => ({ ...s, worktreePath: "/tmp/wt", worktreeRepo: "git@github.com:o/r.git" });

    const quiet = resultOf(await run({ marcus: (s: any) => ({ ...owned(s), success: false, findings: [] }) }));
    expect(quiet.status).toBe("IMPLEMENT_FAILED");
    expect(String(quiet.reason)).toContain("listed no findings");
    expect(String(quiet.reason)).not.toContain("no build result at all");

    // And a real findings list still wins over both sentences.
    const said = resultOf(await run({
      marcus: (s: any) => ({ ...owned(s), success: false, findings: ["the suite failed on 3 tests"] }),
    }));
    expect(String(said.reason)).toBe("the suite failed on 3 tests");
  });

  test("SC-1805: a commit step with no SHA says which of the two things happened", async () => {
    // The third bare exit. It is the most expensive one to be told nothing
    // about: everything up to here succeeded, the work exists in a worktree,
    // and the operator's next question is whether the commit agent ran.
    //
    // `filesChanged` is overridden for the same reason the two identity
    // fields are, and it is a property of the harness rather than of
    // ship.js: `syntheticFromSchema` fills every string with
    // `SYNTHETIC_TEXT`, which is a sentence, and #611's element-shape guard
    // refuses a sentence at the implement result read. Without this the row
    // stops at IMPLEMENT_FAILED and never reaches the exit it is about.
    const owned = (s: any) => ({
      ...s,
      worktreePath: "/tmp/wt",
      worktreeRepo: "git@github.com:o/r.git",
      filesChanged: ["lib/a.ts"],
    });

    const silent = resultOf(await run({ marcus: owned, commit: (() => undefined) as (s: any) => unknown }));
    expect(silent.status).toBe("COMMIT_FAILED");
    expect(String(silent.reason)).toContain("returned nothing at all");

    const answered = resultOf(await run({ marcus: owned, commit: (s: any) => ({ ...s, commitSha: "" }) }));
    expect(answered.status).toBe("COMMIT_FAILED");
    expect(String(answered.reason)).toContain("reported no commit SHA");
    // Distinguishable. A dead agent and an agent that answered badly send an
    // operator to different places, and one sentinel for both would not.
    expect(String(answered.reason)).not.toContain("returned nothing at all");
    for (const r of [silent, answered]) expect(String(r.reason)).not.toContain(SENTINEL);
  });

  test("SC-1804: the deny-list refusal reaches the result instead of only the log", async () => {
    // The second bare exit, and the one that is worth the drive: the refusal
    // text was computed, logged, and dropped one line later. Nothing but the
    // run's console had it.
    //
    // Driven through `scopeOut` rather than prose in the goal, because the
    // prohibition parser is not the subject here — putting the only planned
    // file out of scope is what makes `scopeContradiction` fire.
    const out = resultOf(await run({
      discovery: (s: any) => ({ ...s, filesToModify: ["lib/only.ts"], scopeOut: ["lib/only.ts"] }),
    }));

    expect(out.status).toBe("DISCOVERY_FAILED");
    expect(String(out.reason)).toContain("every file the run planned to touch is out of scope");
    expect(String(out.reason)).toContain("lib/only.ts");
    expect(String(out.reason)).not.toContain(SENTINEL);

    // The control, and it is not decoration: without it a discovery that
    // refuses for ANY reason would satisfy the row above, and the fixture
    // would be proving that the run can fail rather than that this refusal
    // travels. A run whose planned file is in scope does not stop here.
    const fine = resultOf(await run({
      discovery: (s: any) => ({ ...s, filesToModify: ["lib/only.ts"], scopeOut: ["lib/other.ts"] }),
    }));
    expect(fine.status).not.toBe("DISCOVERY_FAILED");
  });
});
