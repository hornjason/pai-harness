/**
 * A verify repair round that deleted passing tests logged and shipped (#747).
 *
 * `workflows/ship.js`'s Verify BUILD-regression block read the round's
 * deletion verdict, printed `REPAIR_DELETED_TESTS`, ran the retry gate, and
 * then printed the sentence that states the defect exactly —
 *
 *   "a gate that passes because its test is gone is not a gate that passed"
 *
 * — in the branch that let exactly that proceed. There was no
 * `terminalFailure` between the reading and the end of the block, and no
 * suppression of the verify PASS witness. Detection with the enforcement
 * never wired is #530's shape: a recorder and a refusal that nothing
 * connected.
 *
 * `#659` specified the detection and the reporting and never asked the run
 * to refuse, so nothing in the tree went red in either direction. This file
 * is the thing that pins the decision: on a DELETED round the run REFUSES.
 *
 * WHAT THIS FILE DRIVES, and why it is not a source grep. The refusal lives
 * at a CALL SITE, not inside `deletionVerdictReading`, so a test over the
 * binding alone cannot see it — #745 added the binding and the run still
 * shipped. Both marked blocks are cut out of `workflows/ship.js` and
 * EXECUTED together, with the real `deletionVerdictReading` deciding the
 * verdict the enforcement acts on. Nothing here restates what the verdict
 * should be.
 *
 * ONE DECIDER, asserted rather than assumed. The enforcement reads
 * `deletionVerdictReading`'s own verdict. A second `reCommit.deletionVerdict`
 * test beside it would be two deciders for one question — they would always
 * agree, and a mutation of either would leave the other holding the run up
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
 *
 * THE CHEAPEST WRONG FIX, named: delete the "a gate that passes because its
 * test is gone" log line, because it reads like an unfinished thought. The
 * warning disappears, the behaviour is identical, and the one sentence that
 * tells an operator the run may be green for a bad reason is gone — #747
 * names it and it is strictly worse than doing nothing. The cases here do
 * NOT survive it: the DELETED round asserts that sentence reached the
 * operator AND that the run refused, so a repair that drops either half is
 * red. The second cheapest wrong fix is to refuse BEFORE the retry gate,
 * which makes the sentence unreachable; "the retry gate still ran" is the
 * case that catches that one.
 *
 * THE FIXTURES ARE READINGS, NOT TYPED-IN WORDS. Every artefact below comes
 * back from the real `deletionReading`/`deletionArtefact` in
 * `lib/test-case-deletion.ts`, so a case about DELETED is a case about a
 * reading that measured a deletion, and the signature the relay recomputes
 * is the one the script would have written.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  deletionArtefact,
  deletionReading,
  type DeletionArtefact,
  type PassLedger,
} from "../lib/test-case-deletion";

const REPO_ROOT = join(import.meta.dir, "..");
const SHIP_PATH = join(REPO_ROOT, "workflows", "ship.js");
const SHIP = readFileSync(SHIP_PATH, "utf-8");

/** The block holding the one reading binding (#684). */
const VERDICT_BLOCK = "DELETION-VERDICT";
/** The block holding the refusal this file is about (#747). */
const ENFORCEMENT_BLOCK = "DELETION-ENFORCEMENT";

/**
 * Cut a marked block out of the source.
 *
 * A block that cannot be found THROWS. An empty cut would make every case
 * below assert over text it typed itself, and zero statements refusing
 * nothing reads exactly like a block that was satisfied
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 */
function cutBlock(source: string, name: string): string {
  const startMarker = `// ──── ${name}-START ────`;
  const endMarker = `// ──── ${name}-END ────`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `the ${name} block is not in the source handed to this check — the deleted-tests ` +
        `refusal could not be read, which is UNMEASURED and never agreement (#747)`,
    );
  }
  if (source.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`the ${name} block opens more than once, so the cut is about an unknown one`);
  }
  return source.slice(start, end);
}

// ── driving the round ───────────────────────────────────────────────────────

interface RoundOutcome {
  /** What the block returned: a terminal result, or the completion sentinel. */
  result: Record<string, unknown>;
  /** Every line the block logged, in order. */
  logs: string[];
  /** How many times the retry verify gate was run. */
  retryRuns: number;
  /** True when the block fell out of the bottom rather than refusing. */
  completed: boolean;
}

/**
 * Run the two blocks over an injected recommit reply.
 *
 * The verdict block is concatenated ABOVE the enforcement block rather than
 * stubbed, so the verdict the enforcement acts on is the one the shipped
 * reading produces. A stubbed reading would make this a test of an `if`.
 */
async function driveRound(opts: {
  reply: unknown;
  /** What the retry verify gate reports. `null` stands for a gate that returned nothing. */
  retryResult?: string | null;
  source?: string;
}): Promise<RoundOutcome> {
  const source = opts.source ?? SHIP;
  const logs: string[] = [];
  let retryRuns = 0;

  const body =
    `${cutBlock(source, VERDICT_BLOCK)}\n` +
    `return (async () => {\n` +
    `${cutBlock(source, ENFORCEMENT_BLOCK)}\n` +
    `return { completed: true }\n` +
    `})()`;

  const run = new Function(
    "reCommit",
    "log",
    "runGateWithHeal",
    "terminalFailure",
    "verifyResult",
    "commitDir",
    body,
  ) as (
    reCommit: unknown,
    log: (line: string) => void,
    runGateWithHeal: (...args: unknown[]) => Promise<unknown>,
    terminalFailure: (status: string, extra: Record<string, unknown>) => Promise<unknown>,
    verifyResult: unknown,
    commitDir: string,
  ) => Promise<Record<string, unknown>>;

  const result = await run(
    opts.reply,
    (line: string) => logs.push(String(line)),
    async () => {
      retryRuns += 1;
      return opts.retryResult === null ? undefined : { result: opts.retryResult ?? "PASS" };
    },
    async (status: string, extra: Record<string, unknown>) => ({ terminal: true, status, ...extra }),
    { result: "FAIL", regressionTarget: "BUILD" },
    "/tmp/does-not-need-to-exist",
  );

  return { result, logs, retryRuns, completed: result?.completed === true };
}

// ── fixtures: artefacts the real library produced ───────────────────────────

const PREV = "1111111111111111111111111111111111111111";
const CUR = "2222222222222222222222222222222222222222";
const CASE = { file: "test/alpha.test.ts", name: "the baseline row is read first" };

const ledgerSaying = (passed: string[]): PassLedger => ({ status: "MEASURED", passed, failed: [] });
const UNREADABLE_LEDGER: PassLedger = { status: "UNMEASURED", reason: "no --ledger was given" };

const artefactOf = (
  deleted: Array<{ file: string; name: string }>,
  ledger: PassLedger,
): DeletionArtefact =>
  deletionArtefact(deletionReading(deleted, ledger, { cases: [], reason: "" }), PREV, CUR);

/** Nothing that passed at the previous build commit is gone. */
const cleanArtefact = (): DeletionArtefact => artefactOf([], ledgerSaying([CASE.name]));
/** A case the previous build commit proved green is gone. This is the defect. */
const deletedArtefact = (): DeletionArtefact => artefactOf([CASE], ledgerSaying([CASE.name]));
/** Something left and nothing establishes whether it was green. */
const unmeasuredArtefact = (): DeletionArtefact => artefactOf([CASE], UNREADABLE_LEDGER);

/** A whole reply, as the recommit-verify agent would return it. */
const replyFor = (artefact: DeletionArtefact) => ({
  commitSha: CUR,
  parentSha: PREV,
  stateRecorded: true,
  deletionVerdict: artefact.verdict,
  deletion: artefact,
});

const GATE_SENTENCE = "a gate that passes because its test is gone is not a gate that passed";

// ── the fixtures are non-vacuous ────────────────────────────────────────────

describe("the fixtures' verdicts came back from the real reading", () => {
  test("the three artefacts carry the three verdicts", () => {
    // Without this every case below could be about a hand-written word, and
    // a battery whose fixtures never reached a state measures nothing past it.
    expect(cleanArtefact().verdict).toBe("CLEAN");
    expect(deletedArtefact().verdict).toBe("DELETED");
    expect(unmeasuredArtefact().verdict).toBe("UNMEASURED");
  });

  test("the deleted artefact names the case the ledger proved green", () => {
    const artefact = deletedArtefact();
    expect(artefact.cases?.map((c) => c.name)).toEqual([CASE.name]);
    expect(typeof artefact.signature).toBe("string");
    expect(artefact.signature).not.toBe("");
  });
});

// ── the refusal ─────────────────────────────────────────────────────────────

describe("a verify repair round whose deletions are not CLEAN ends the run", () => {
  test("a DELETED round refuses, and the run does not continue", async () => {
    const round = await driveRound({ reply: replyFor(deletedArtefact()) });

    expect(round.completed).toBe(false);
    expect(round.result.terminal).toBe(true);
    expect(round.result.status).toBe("VERIFY_FAILED");
    expect(round.result.deletionVerdict).toBe("DELETED");
    expect(String(round.result.reason)).toContain("DELETED");
    expect(String(round.result.reason)).toContain(GATE_SENTENCE);
  });

  test("the operator is told what was removed before the run ends", async () => {
    const round = await driveRound({ reply: replyFor(deletedArtefact()) });
    const text = round.logs.join("\n");

    // Both halves. The refusal without the detection is a run that stops for
    // a reason nobody can act on; the detection without the refusal is #747.
    expect(text).toContain("REPAIR_DELETED_TESTS (DELETED)");
    expect(text).toContain(CASE.name);
    expect(text).toContain(GATE_SENTENCE);
  });

  test("the retry verify gate still ran — the refusal is after it, not instead of it", async () => {
    // Refusing above the retry would make GATE_SENTENCE unreachable, which
    // is the cheapest wrong fix wearing a different hat. This is the case
    // that would go red if someone moved the refusal up.
    const round = await driveRound({ reply: replyFor(deletedArtefact()) });
    expect(round.retryRuns).toBe(1);
    expect(round.logs.join("\n")).toContain("Verify gate passed after BUILD regression fix");
  });

  test("a DELETED round whose retry gate FAILED also refuses", async () => {
    const round = await driveRound({ reply: replyFor(deletedArtefact()), retryResult: "FAIL" });
    expect(round.completed).toBe(false);
    expect(round.result.status).toBe("VERIFY_FAILED");
    // The sentence above is about a PASS, so it must NOT be claimed here.
    expect(round.logs.join("\n")).not.toContain(GATE_SENTENCE);
  });

  test("an UNMEASURED round refuses on the same path", async () => {
    const round = await driveRound({ reply: replyFor(unmeasuredArtefact()) });
    expect(round.completed).toBe(false);
    expect(round.result.status).toBe("VERIFY_FAILED");
    expect(round.result.deletionVerdict).toBe("UNMEASURED");
  });

  test("a reply that omits the reading entirely refuses rather than completing", async () => {
    // The blast radius, stated as a case. `deletionVerdictReading` never
    // returns CLEAN on a reading it could not take, so an agent that drops
    // the field now ends the run — intended, and a behaviour change for runs
    // that pass today.
    const round = await driveRound({
      reply: { commitSha: CUR, parentSha: PREV, stateRecorded: true },
    });
    expect(round.completed).toBe(false);
    expect(round.result.status).toBe("VERIFY_FAILED");
    expect(round.result.deletionVerdict).toBe("UNMEASURED");
    expect(round.logs.join("\n")).toContain("UNMEASURED deletion");
  });

  test("a round that reported CLEAN beside a DELETED artefact refuses", async () => {
    // The restatement door #684 closed, now carried through to a refusal
    // rather than a log line.
    const artefact = deletedArtefact();
    const round = await driveRound({
      reply: { ...replyFor(artefact), deletionVerdict: "CLEAN" },
    });
    expect(round.completed).toBe(false);
    expect(round.result.deletionVerdict).toBe("UNMEASURED");
    expect(round.logs.join("\n")).toContain("DELETION_VERDICT_DISAGREEMENT");
  });
});

// ── the control: a CLEAN round is untouched ─────────────────────────────────

describe("a CLEAN round still completes", () => {
  test("nothing refuses, and the run falls out of the block", async () => {
    // A refusal that fires on every round is not a refusal, and this is the
    // only thing that says so.
    const round = await driveRound({ reply: replyFor(cleanArtefact()) });
    expect(round.completed).toBe(true);
    expect(round.result.terminal).toBeUndefined();
    expect(round.retryRuns).toBe(1);
    expect(round.logs.join("\n")).toContain("Verify passed after BUILD regression fix");
    expect(round.logs.join("\n")).not.toContain(GATE_SENTENCE);
  });
});

// ── the mutation is performed, not described ────────────────────────────────

describe("the pre-#747 source is what this file is measured against", () => {
  /** The refusal, removed from a copy of the source. Throws when it has moved. */
  function withoutRefusal(source: string): string {
    const block = cutBlock(source, ENFORCEMENT_BLOCK);
    const anchor = "      if (deletionVerdict !== 'CLEAN') {";
    const at = block.indexOf(anchor);
    if (at < 0) {
      throw new Error(
        "could not build the mutant: the deleted-tests refusal appears 0 times in the " +
          "enforcement block, so there is nothing to remove and this case would measure nothing",
      );
    }
    if (block.indexOf(anchor, at + 1) >= 0) {
      throw new Error("could not build the mutant: the refusal appears more than once");
    }
    const close = "\n      }\n";
    const closing = block.indexOf(close, at);
    if (closing < 0) throw new Error("could not build the mutant: the refusal's block does not close");
    const mutatedBlock = block.slice(0, at) + block.slice(closing + close.length);
    if (mutatedBlock === block) throw new Error("could not build the mutant: the source is unchanged");
    return source.replace(block, mutatedBlock);
  }

  test("with the refusal removed, the DELETED round completes — which is #747", async () => {
    const mutant = withoutRefusal(SHIP);
    const round = await driveRound({ reply: replyFor(deletedArtefact()), source: mutant });

    // The defect, reproduced: logged, and shipped anyway.
    expect(round.completed).toBe(true);
    expect(round.logs.join("\n")).toContain("REPAIR_DELETED_TESTS (DELETED)");
    expect(round.logs.join("\n")).toContain(GATE_SENTENCE);
  });

  test("the mutant still completes a CLEAN round, so the mutation is local", async () => {
    // A mutant that changed every outcome would make the row above a
    // measurement of a broken copy rather than of the refusal.
    const round = await driveRound({ reply: replyFor(cleanArtefact()), source: withoutRefusal(SHIP) });
    expect(round.completed).toBe(true);
  });
});

// ── one decider ─────────────────────────────────────────────────────────────

describe("the refusal and the reporting read one verdict", () => {
  test("the enforcement block never re-derives a verdict from the reply", () => {
    const block = cutBlock(SHIP, ENFORCEMENT_BLOCK);
    // Reading the agent's own restatement again would be a second decider
    // that always agrees with the first, so no behavioural case could tell
    // them apart and a mutation of either would leave the other refusing.
    //
    // The pattern is composed rather than written out, because a grep that
    // cannot tell a citation from a use would be satisfied by this comment
    // and the block's — the trap `.claude/rules/claiming-sc-coverage.md` is
    // about, met from the checker's side.
    const restatementField = ["deletion", "Verdict"].join("");
    const reDerivations = block.match(new RegExp(`reCommit[?.]*\\.${restatementField}`, "g")) ?? [];
    expect(reDerivations).toEqual([]);

    // The control: the pattern finds the pre-#684 read in the source it was
    // written against, so an empty match above is a reading and not a
    // broken instrument.
    const preFix = `const x = reCommit?.${restatementField} || 'UNMEASURED'`;
    expect(preFix.match(new RegExp(`reCommit[?.]*\\.${restatementField}`, "g"))).toHaveLength(1);
  });

  test("the reading binding is called exactly once in the block", () => {
    const block = cutBlock(SHIP, ENFORCEMENT_BLOCK);
    expect((block.match(/deletionVerdictReading\(/g) ?? []).length).toBe(1);
  });

  test("the run ends through the funnel every other terminal failure uses", () => {
    const block = cutBlock(SHIP, ENFORCEMENT_BLOCK);
    // Not a bare `return`, and not a status invented here: `terminalFailure`
    // is what preserves the worktrees and restores the shared checkout, and
    // an exit that skips it loses the round's work.
    expect(block).toContain("terminalFailure('VERIFY_FAILED'");
  });
});
