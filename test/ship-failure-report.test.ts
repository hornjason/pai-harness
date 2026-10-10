/**
 * A failed run reports every refusal, not only its last one (#252, criteria 1 and 2)
 *
 * Run `wf_e105dd33-220` on #216 ended with one sentence:
 *
 *     SECURITY_REVIEW_STALE: the security review is stale … the reviewed code
 *     is not the code this run would ship
 *
 * Read alone that says "the work was fine, a commit landed late, re-run it".
 * All three implications were wrong. The same run had recorded, in
 * `workflow-state.json` and `journal.jsonl`: the verify gate FAILED, two of its
 * fan-out slots were never written, the ship gate FAILED on three checks, and
 * scope had produced 6 ACs for 7 SCs. The run KNEW and the summary did not say.
 *
 * The ordering is what makes it dangerous rather than merely incomplete: the
 * reason that survives is the one from the latest phase, so the later a
 * failure happens the more it hides — and staleness, which happens nearly
 * last, is also the most innocuous-sounding of the list. The obvious response
 * to it is "re-run", which would have reproduced the same six-of-seven
 * coverage and the same unreviewed destruction of a consumer's CI.
 *
 * So the ledger is ordered by SEVERITY, not by time, and the immediate reason
 * is entered into it as one refusal among the others rather than standing in
 * for all of them.
 *
 * The block is EXTRACTED BY MARKER AND EXECUTED. "ship.js mentions failures"
 * stays true after `failureSummary` is reduced to returning the last entry,
 * which is the exact defect this file exists to rule out.
 *
 * WHAT WAS BROKEN TO PROVE THESE FAIL (.claude/rules/checks-must-be-able-to-fail.md):
 * the mutants in the last describe are built here, on every run, from the real
 * block, and each builder throws if its substitution changed nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const shipSource = readFileSync(SHIP_PATH, "utf-8");

const START = "// ──── FAILURE-LEDGER-START ────";
const END = "// ──── FAILURE-LEDGER-END ────";

/** Module scope on purpose: a missing marker fails this file loudly at load. */
const BLOCK: string = (() => {
  const a = shipSource.indexOf(START);
  const b = shipSource.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`workflows/ship.js is missing the ${START} / ${END} markers`);
  }
  if (shipSource.indexOf(START, a + 1) !== -1 || shipSource.indexOf(END, b + 1) !== -1) {
    throw new Error("the failure-ledger markers appear more than once — the slice is ambiguous");
  }
  return shipSource.slice(a, b);
})();

interface Entry {
  kind: string;
  phase: string;
  detail: string;
}
interface Result {
  status: string;
  reason: string;
  immediateReason: string | null;
  failures: Entry[];
  pr: { number: number | null; readiness: string; reason: string | null; draft: boolean | null };
}
interface Ledger {
  recordRefusal: (kind: unknown, phase: unknown, detail: unknown) => Entry;
  recordGateRefusal: (phase: unknown, gate: unknown, result: unknown) => Entry[];
  /** The real `shipFailed`, which records the immediate reason and then summarises. */
  shipFailed: (phase: unknown, immediate?: unknown) => Result;
  /** Plant what the PR step reported, the way ship.js's Ship phase does. */
  setOpenedPr: (pr: unknown) => void;
}

/**
 * Compile one extracted block and hand back its exports.
 *
 * `new Function` over this repository's own workflows/ship.js, read at test
 * time — the same trust boundary as importing it, which the Workflow sandbox
 * makes impossible (#69). Never give it a source from elsewhere. A FRESH
 * instance per test, because the ledger is stateful and a shared one would
 * make every assertion depend on execution order.
 */
function loadLedger(block: string, logs: string[] = []): Ledger {
  // The three names ship.js reads from module scope, supplied so the REAL
  // shipFailed can be returned rather than a reimplementation of its first two
  // lines — the ordering bug lives in exactly those two lines.
  const prelude = "var ISSUE = 252, SLUG = 'pai-harness-252', WORK_DIR = '/tmp/work';\n";
  const out = new Function(
    "__log__",
    `var log = __log__;\n${prelude}${block}\n` +
      "return { recordRefusal, recordGateRefusal, shipFailed, setOpenedPr: (p) => { openedPr = p } }",
  )((m: unknown) => logs.push(String(m)));
  for (const name of ["recordRefusal", "recordGateRefusal", "shipFailed", "setOpenedPr"]) {
    if (typeof (out as any)[name] !== "function") {
      throw new Error(`the FAILURE-LEDGER block does not define ${name}`);
    }
  }
  return out as Ledger;
}

/** The run that motivated this, replayed in the order it actually happened. */
function replayRun216(l: Ledger) {
  l.recordGateRefusal("Verify", "verify", {
    result: "FAIL",
    failures: [
      "gates.verify.evidenceValidator not populated — B2 agent may not have run",
      "gates.verify.adversary not populated — B1 agent may not have run",
    ],
  });
  l.recordGateRefusal("Ship", "ship", {
    result: "FAIL",
    failures: ["all-gates-pass", "witness-ac-verdict", "evidence-prevalidation"],
  });
}

const STALE =
  "SECURITY_REVIEW_STALE: the security review is stale: it was pinned to add48767… " +
  "but the branch now ends at 007cf3a8…";

describe("#252 criterion 1: the terminal result enumerates every refusal", () => {
  test("the run that shipped this bug names both failed gates, not only the staleness", () => {
    const l = loadLedger(BLOCK);
    replayRun216(l);
    const summary = l.shipFailed('Ship', STALE);

    expect(summary.failures.length).toBe(6);
    const text = summary.reason;
    expect(text, "the verify gate failure is still missing from the summary").toContain("verify");
    expect(text, "the ship gate failure is still missing from the summary").toContain("ship");
    expect(text, "the reason that was reported is now absent — it is one of the refusals, not none of them")
      .toContain("SECURITY_REVIEW_STALE");
  });

  test("the two unpopulated fan-out slots are named individually", () => {
    const l = loadLedger(BLOCK);
    replayRun216(l);
    const slots = l.shipFailed('Ship', STALE).failures.filter(f => f.kind === "UNPOPULATED_SLOT");
    expect(slots.map(s => s.detail).join(" ")).toContain("evidenceValidator");
    expect(slots.map(s => s.detail).join(" ")).toContain("adversary");
    expect(slots).toHaveLength(2);
  });

  test("a refusal with no gate failures at all still produces a reason", () => {
    // Three of ship.js's fourteen SHIP_FAILED returns carried no reason
    // whatsoever. A bare status is the degenerate case of this whole bug.
    const l = loadLedger(BLOCK);
    const summary = l.shipFailed('Ship');
    expect(summary.failures).toEqual([]);
    expect(summary.reason.length, "a run refused and recorded nothing readable").toBeGreaterThan(0);
  });
});

describe("#252 criterion 2: each entry names the phase it came from", () => {
  test("every entry carries a phase", () => {
    const l = loadLedger(BLOCK);
    replayRun216(l);
    for (const f of l.shipFailed('Ship', STALE).failures) {
      expect(f.phase, `an entry with no phase: ${f.detail}`).toBeTruthy();
    }
  });

  test("the summary distinguishes 'verify failed then the review went stale' from 'the review went stale'", () => {
    const l = loadLedger(BLOCK);
    replayRun216(l);
    const reason = l.shipFailed('Ship', STALE).reason;
    expect(reason).toContain("[Verify]");
    expect(reason).toContain("[Ship]");
  });

  test("a missing phase is recorded as unknown rather than dropped", () => {
    const l = loadLedger(BLOCK);
    const e = l.recordRefusal("REFUSAL", undefined, "something refused");
    expect(e.phase).toBe("unknown");
    expect(l.shipFailed('Ship').failures).toHaveLength(1);
  });
});

describe("#252: severity, not recency, decides the order", () => {
  test("the immediate reason does not come first just because it came last", () => {
    const l = loadLedger(BLOCK);
    replayRun216(l);
    const failures = l.shipFailed('Ship', STALE).failures;
    expect(failures[0].kind).toBe("GATE_FAIL");
    expect(failures[failures.length - 1].detail).toContain("SECURITY_REVIEW_STALE");
  });

  test("within one severity, the order is the order it happened", () => {
    // Driven with two gate failures in different phases rather than with
    // replayRun216: that run's verify failures are both UNPOPULATED_SLOT, so
    // it has only one phase's worth of GATE_FAIL and the comparison would hold
    // vacuously.
    const l = loadLedger(BLOCK);
    l.recordGateRefusal("Verify", "verify", { result: "FAIL", failures: ["witness-ac-verdict"] });
    l.recordGateRefusal("Ship", "ship", { result: "FAIL", failures: ["all-gates-pass"] });
    const gateFails = l.shipFailed("Ship", STALE).failures.filter(f => f.kind === "GATE_FAIL");
    expect(gateFails).toHaveLength(2);
    expect(gateFails[0].phase).toBe("Verify");
    expect(gateFails[1].phase).toBe("Ship");
  });

  test("an unrecognised kind sorts last rather than first", () => {
    // Fail-closed in the reporting direction: a kind nobody ranked must not
    // displace a measured gate failure at the top of the summary.
    const l = loadLedger(BLOCK);
    l.recordRefusal("SOMETHING_NEW", "Build", "unranked");
    l.recordGateRefusal("Ship", "ship", { result: "FAIL", failures: ["all-gates-pass"] });
    const failures = l.shipFailed('Ship').failures;
    expect(failures[0].kind).toBe("GATE_FAIL");
  });
});

describe("#252: the ledger records what happened, not what was asked", () => {
  test("a gate that PASSES records nothing", () => {
    const l = loadLedger(BLOCK);
    expect(l.recordGateRefusal("Ship", "ship", { result: "PASS", failures: [] })).toEqual([]);
    expect(l.shipFailed('Ship').failures).toEqual([]);
  });

  test("a gate that failed and then healed to PASS is not reported as failed", () => {
    // runGateWithHeal retries. A ledger that kept the first attempt would put
    // "verify gate FAILED" in the terminal report of a run whose verify gate
    // passed, and a report with false entries in it is a report nobody reads.
    const l = loadLedger(BLOCK);
    l.recordGateRefusal("Verify", "verify", { result: "FAIL", failures: ["witness-ac-verdict"] });
    l.recordGateRefusal("Verify", "verify", { result: "PASS", failures: [] });
    expect(l.shipFailed('Ship').failures).toEqual([]);
  });

  test("healing one gate does not erase another gate's failure", () => {
    const l = loadLedger(BLOCK);
    l.recordGateRefusal("Verify", "verify", { result: "FAIL", failures: ["witness-ac-verdict"] });
    l.recordGateRefusal("Ship", "ship", { result: "PASS", failures: [] });
    expect(l.shipFailed('Ship').failures).toHaveLength(1);
    expect(l.shipFailed('Ship').failures[0].phase).toBe("Verify");
  });

  test("a gate step that returned nothing is a refusal, not a pass", () => {
    // `runGateWithHeal` returns undefined when the agent produced no result.
    // Treating that as clean is the fail-open this repo keeps rediscovering.
    const l = loadLedger(BLOCK);
    expect(l.recordGateRefusal("Ship", "ship", undefined)).toHaveLength(1);
    expect(l.shipFailed('Ship').failures[0].kind).toBe("GATE_FAIL");
  });

  test("a FAIL with an empty failures list still records the gate", () => {
    const l = loadLedger(BLOCK);
    l.recordGateRefusal("Ship", "ship", { result: "FAIL", failures: [] });
    const f = l.shipFailed('Ship').failures;
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("ship");
  });
});

describe("#252: every SHIP_FAILED return goes through the helper", () => {
  test("no SHIP_FAILED status literal is built by hand", () => {
    // The helper is the only thing that attaches the ledger, so a return site
    // that writes the status itself is a return site that reports one reason.
    // One occurrence is allowed: the helper's own.
    const sites = shipSource.match(/status: 'SHIP_FAILED'/g) || [];
    expect(
      sites.length,
      `${sites.length} hand-built SHIP_FAILED returns remain — each one reports a single reason`,
    ).toBe(1);
  });

  test("the one remaining occurrence is inside shipFailed", () => {
    const at = shipSource.indexOf("status: 'SHIP_FAILED'");
    const fnAt = shipSource.indexOf("function shipFailed(");
    expect(fnAt, "shipFailed does not exist").toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(fnAt);
    expect(at - fnAt, "the SHIP_FAILED literal is not inside shipFailed").toBeLessThan(1200);
  });

  test("shipFailed is called at least as many times as the sites it replaced", () => {
    // 14 hand-built returns existed before this change. Fewer calls than that
    // means a refusal path was deleted rather than converted — which is the
    // cheapest way to make the count above pass for the wrong reason.
    const calls = shipSource.match(/return shipFailed\(/g) || [];
    expect(calls.length, "a refusal path went missing in the conversion").toBeGreaterThanOrEqual(14);
  });

  test("the recorded draft state is observed, never inferred (#252 follow-up)", () => {
    // The first version wrote `draft: true` on every refusal, reasoning that
    // the undraft step had not run. That is a claim about a state it never
    // looked at, and `upsertPR` can be updating a PR an EARLIER run already
    // marked ready — so it was false exactly when it mattered. Three-valued
    // now: `false` is the dangerous reading and has to be distinguishable
    // from "nobody looked", which a boolean cannot do.
    const cases: Array<[string, any, boolean | null]> = [
      ["the step observed a draft", { ok: true, prNumber: 9, prDraft: true }, true],
      ["the step observed a ready PR", { ok: true, prNumber: 9, prDraft: false }, false],
      ["the step did not report it", { ok: true, prNumber: 9 }, null],
      ["the step reported a non-boolean", { ok: true, prNumber: 9, prDraft: "yes" }, null],
    ];
    for (const [label, pr, expected] of cases) {
      const l = loadLedger(BLOCK);
      l.setOpenedPr(pr);
      const out = l.shipFailed("Ship", "something refused");
      expect(out.pr.draft, `${label}: reported ${JSON.stringify(out.pr.draft)}`).toBe(expected as any);
      expect(out.pr.number).toBe(9);
      expect(out.pr.readiness).toBe("LEAVE_DRAFT");
    }
  });

  test("a refusal with a mergeable PR says so out loud", () => {
    // The combination nobody should have to infer from a JSON field: this run
    // will not ship and there is a mergeable PR on the branch.
    const logs: string[] = [];
    const l = loadLedger(BLOCK, logs);
    l.setOpenedPr({ ok: true, prNumber: 9, prDraft: false });
    l.shipFailed("Ship", "something refused");
    expect(logs.join("\n"), "a refusal left a mergeable PR and logged nothing").toMatch(/NOT a draft/);
  });

  test("a refusal whose PR is a draft does not cry wolf", () => {
    const logs: string[] = [];
    const l = loadLedger(BLOCK, logs);
    l.setOpenedPr({ ok: true, prNumber: 9, prDraft: true });
    l.shipFailed("Ship", "something refused");
    expect(logs.join("\n")).not.toMatch(/NOT a draft/);
  });

  test("a run that opened no PR says so, rather than claiming a draft", () => {
    // Executed rather than grepped. The source-text version of this read a
    // fixed window of characters after `function shipFailed(` and broke the
    // moment a comment grew — a check whose view of the input can silently
    // shrink is the second shape in checks-must-be-able-to-fail.md.
    const l = loadLedger(BLOCK);
    const out = l.shipFailed("Ship", "something refused");
    expect(out.pr).toEqual({
      number: null,
      readiness: "NO_PR",
      reason: "no PR was opened or updated by this run",
      draft: null,
    });
  });
});

/** Each builder throws if its substitution changed nothing, so a rename aborts. */
function mutate(find: string, replace: string): Ledger {
  if (!BLOCK.includes(find)) {
    throw new Error(`could not build the mutant: ${JSON.stringify(find)} appears 0 times in the block`);
  }
  return loadLedger(BLOCK.replace(find, replace));
}

describe("#252: the report can fail", () => {
  test("reporting only the last reason turns the enumeration red", () => {
    // The defect, reintroduced: the summary becomes an echo of the immediate
    // reason. The real block names six refusals; the mutant names one.
    const real = loadLedger(BLOCK);
    replayRun216(real);
    expect(real.shipFailed('Ship', STALE).failures.length).toBe(6);

    const mutant = mutate("const ranked = ", "const ranked = []; const unusedRanked = ");
    replayRun216(mutant);
    const summary = mutant.shipFailed('Ship', STALE);
    expect(summary.failures).toEqual([]);
    expect(summary.reason).not.toContain("verify");
  });

  test("dropping the phase from each entry turns the phase criterion red", () => {
    const mutant = mutate("[${e.phase}] ", "");
    replayRun216(mutant);
    expect(mutant.shipFailed('Ship', STALE).reason).not.toContain("[Verify]");
  });

  test("ranking by recency instead of severity puts the staleness first", () => {
    const mutant = mutate("return ra !== rb ? ra - rb : a.i - b.i", "return b.i - a.i");
    replayRun216(mutant);
    expect(mutant.shipFailed('Ship', STALE).failures[0].detail).toContain("SECURITY_REVIEW_STALE");
  });
});
