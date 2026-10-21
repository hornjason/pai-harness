import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { runWorkflow } from "../lib/workflow-test-harness";
import { structuralCut } from "../lib/source-slice";

/**
 * #889 — a resume replays a terminal refusal from cache instead of
 * re-evaluating it, and the refusal tells the operator to do the one thing
 * that cannot work.
 *
 * Measured twice, on two different terminal statuses, in two runs for the
 * same consumer issue:
 *
 *   resume of PRIOR_WORK_OPEN_PR   13 ms   0 subagent tokens   same refusal
 *   resume of SCOPE_FAILED          9 ms   0 subagent tokens   same refusal
 *
 * The second is proof rather than inference. `workflow-state.json` was
 * repaired through the harness's own documented channel and the live file
 * confirmed afterwards — `acs[4].evidence.type` read `command-output`, and
 * the string `unmeasured` was nowhere in it. The resume still reported
 * `received 'unmeasured'`, in 9 ms, with zero tokens. The gate did not
 * re-read the file.
 *
 * ## What this change is, and what it is NOT
 *
 * It is NOT "resume re-executes the failing phase". That fix is correct and
 * is not available from here. The gate verdict is produced by an AGENT —
 * ship.js has no subprocess access in the Workflow sandbox (#69), so it
 * cannot run the gate or read the state file itself — and the runtime caches
 * a completed `agent()` call on `(prompt, opts)`. Varying the cache key on
 * the state file's contents would be the targeted fix, and it needs a hash
 * of a file ship.js cannot open. On resume, any value derived from a prior
 * agent is itself the cached one.
 *
 * That is the third issue to bottom out in the same constraint, and it is
 * filed as #903 rather than decided here.
 *
 * So this ships the interim the issue explicitly asks for: *"the refusal text
 * should say that resume will replay it and a fresh run is required — right
 * now it says the opposite."* `PRIOR_WORK_OPEN_PR` says "re-run";
 * `SCOPE_FAILED` prints repair instructions for a file the retry will not
 * read. Both now carry the truth beside them.
 *
 * ## The half that is easy to leave out
 *
 * A fresh run does not preserve a hand-repaired state either: `workDir` is
 * keyed by slug, and starting a run archives the current
 * `workflow-state.json` into `previous-run-<runId>/`. Telling an operator
 * "start a fresh run" without that sentence sends them to repair the file
 * again and watch the new run file it away. Both halves or neither — which
 * is what AC-3 is for.
 */

const SHIP = readFileSync(join(import.meta.dir, "..", "workflows", "ship.js"), "utf-8");

/** The one binding, so there is one thing to mutate. */
const BINDING = "RESUME_REPLAYS_NOTE";

describe("#889: a terminal refusal says that resume will replay it", () => {
  test("AC-1: the note is declared exactly once", () => {
    // Two copies would survive any mutation of the first, and the funnel that
    // kept the stale wording would read as covered.
    const declarations = (SHIP.match(new RegExp(`const ${BINDING}\\s*=`, "g")) || []).length;
    expect(declarations, `${BINDING} is not declared exactly once in ship.js`).toBe(1);
  });

  test("AC-2: the note names the mechanism, not just the advice", () => {
    // The anchor is spelled out rather than built from BINDING, and that is
    // #668's rule rather than a style choice: the ambiguity scan reads anchor
    // LITERALS at each call site, so a template literal is unscannable and a
    // duplicated anchor pointing at ship.js would go unnoticed. Measured —
    // the interpolated form reds `no UNREADABLE anchor is pointed at ship.js`.
    const note = structuralCut(SHIP, "const RESUME_REPLAYS_NOTE =", { endAnchor: "\n\n" });
    // "Start a fresh run" on its own is advice. What makes it actionable is
    // WHY the cheap retry cannot work, because an operator who does not know
    // that will reach for resume again on the next refusal.
    expect(note, "the note does not name resume").toMatch(/resumeFromRunId|resume/i);
    expect(note, "the note does not say the verdict is replayed from cache").toMatch(/cache/i);
    expect(note, "the note does not say a fresh run is required").toMatch(/fresh run/i);
  });

  test("AC-3: the note carries the archive trap too", () => {
    // Without this, the advice sends an operator to repair state and watch a
    // fresh run archive the repair. Half an instruction is the thing the
    // issue is complaining about, reissued.
    // The anchor is spelled out rather than built from BINDING, and that is
    // #668's rule rather than a style choice: the ambiguity scan reads anchor
    // LITERALS at each call site, so a template literal is unscannable and a
    // duplicated anchor pointing at ship.js would go unnoticed. Measured —
    // the interpolated form reds `no UNREADABLE anchor is pointed at ship.js`.
    const note = structuralCut(SHIP, "const RESUME_REPLAYS_NOTE =", { endAnchor: "\n\n" });
    expect(note, "the note does not warn that a fresh run archives the repaired state").toMatch(
      /archiv/i,
    );
  });

  test("AC-4: BOTH terminal funnels carry it", () => {
    // ship.js has two, and they are separate on purpose: `shipFailed` carries
    // the refusal ledger. A note added to one is exactly the kind of partial
    // fix that reads as done — and `SHIP_FAILED` is a status an operator is
    // especially likely to retry, because the work exists and only the ship
    // step refused.
    // Anchored on the RETURNED OBJECT, not the signature, and that is not a
    // convenience. `structuralCut` balances from the anchor's own index, so
    // ANY anchor beginning `async function terminalFailure(` resolves to the
    // `{}` of the `extra = {}` default parameter — a two-character cut that
    // is well-formed, non-empty, and about something else
    // (`.claude/rules/checks-must-be-able-to-fail.md`, "search the slice").
    // It cost two red runs against an implementation that was already
    // correct, which is the cheap way to find it; left written down because
    // the next person reaching for a function-signature anchor in this file
    // will hit the same default parameter.
    //
    // The object is also the better subject: the claim is that an operator
    // READS the note, and a note declared in a function it never returns is
    // the defect this file is about.
    // Unrolled rather than looped, for the same #668 reason as AC-2: a loop
    // variable is an anchor the ambiguity scan cannot read, and an anchor it
    // cannot read is one it cannot warn about when ship.js grows a second
    // copy of it. Two call sites, two literals, nothing computed.
    const fromTerminalFailure = structuralCut(SHIP, "  return {\n    status,\n    ...extra,", {
      balanced: "{",
    });
    expect(
      fromTerminalFailure,
      `terminalFailure's returned object does not carry ${BINDING}`,
    ).toContain(BINDING);

    const fromShipFailed = structuralCut(SHIP, "  return {\n    status: 'SHIP_FAILED',", {
      balanced: "{",
    });
    expect(fromShipFailed, `shipFailed's returned object does not carry ${BINDING}`).toContain(
      BINDING,
    );
  });
});

describe("#889: the note reaches the object an operator reads", () => {
  // The structural cases above prove the text exists in the right places. A
  // field that is composed and never returned is the defect this repo keeps
  // finding, so the run is DRIVEN and the result read.
  const REACHES_IMPLEMENT: Record<string, (s: any) => unknown> = {
    "launch-base": () => ({ reading: "SAME_CHECKOUT", cwd: "/tmp/p", refusal: null, exitCode: 0 }),
    "read-issue": s => ({ ...s, successCriteria: [] }),
    discovery: s => ({
      ...s,
      priorWork: { explicitCommits: [], acStatus: [{ id: "AC-1", status: "UNMET" }] },
    }),
  };

  const run = (overrides: Record<string, (s: any) => unknown>) => {
    const merged = { ...REACHES_IMPLEMENT };
    for (const [label, fn] of Object.entries(overrides)) {
      const before = merged[label];
      merged[label] = before ? (s: any) => fn(before(s)) : fn;
    }
    return runWorkflow(SHIP, {
      args: { issue: 1, projectRoot: "/tmp/p", repo: "o/r", harnessRoot: "/tmp/h" },
      overrides: merged,
    });
  };

  test("AC-5: a real terminal exit returns the note as a field", async () => {
    // The #524 exit, reused: the implement agent replies with nothing, which
    // goes through `terminalFailure`. What is asserted is the RETURNED
    // object, not the source.
    const r = await run({ marcus: (() => undefined) as (s: any) => unknown });
    expect(r.error, `the harness itself threw: ${r.error?.message}`).toBeNull();
    const out = (r.result ?? {}) as Record<string, unknown>;

    expect(String(out.status), "the run did not end terminally").toMatch(/FAILED/);
    expect(
      typeof out.retryGuidance === "string" && out.retryGuidance.length > 0,
      "the terminal result carries no retryGuidance field",
    ).toBe(true);
    expect(String(out.retryGuidance)).toMatch(/cache/i);
    expect(String(out.retryGuidance)).toMatch(/fresh run/i);
  });

  test("AC-6: it does not displace the reason the run stopped", async () => {
    // The control. A note appended into `reason` would satisfy every case
    // above while burying the thing #524 put there, and the two fields answer
    // different questions: why it stopped, and what to do about it.
    const r = await run({ marcus: (() => undefined) as (s: any) => unknown });
    const out = (r.result ?? {}) as Record<string, unknown>;
    expect(String(out.reason), "the reason was replaced by the retry note").not.toMatch(/cache/i);
    expect(String(out.reason).length, "the run stopped with no reason").toBeGreaterThan(0);
  });
});
