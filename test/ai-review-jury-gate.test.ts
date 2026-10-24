/**
 * The verifier quorum, in the deployed adjudication path (#1476, CRC-B4).
 *
 * `lib/finding-jury.ts` has had the group size, the quorum, the per-verifier
 * ballot and the disagreement flag since #1187, and #1468 made the ledger row
 * able to HOLD a reading. Neither put a vote in front of anything: `arbitrate`
 * had one caller and it was hand-run. This file binds the half that was
 * missing — a group that votes on the findings that would otherwise BLOCK, in
 * the path `bunx rungate ai-review-findings` runs.
 *
 * ## What the criterion forbids, and what that costs this file
 *
 * CRC-B4 ends *"a reading the mechanism produces whether or not it works does
 * not satisfy this criterion."* So "the ledger has a `jury` field with numbers
 * in it" is not a case. The named counterfeit is a quorum wired to a constant
 * — `const agree = groupSize` in `juryReading` — which produces a populated,
 * plausible ballot on every finding and filters nothing.
 *
 * `JG-7` is the battery that separates them. It copies `lib/finding-jury.ts`
 * into a scratch directory with that one line rewritten, re-imports the gate
 * against the mutant, and runs the SAME ballot through both. Real: the finding
 * is withheld, `disagreed` is false, the three votes are on the ledger row.
 * Mutant: the finding blocks. The discriminator is the ledger row and the
 * withheld set, not the exit code — a status code is almost never specific to
 * one mechanism (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * `JG-8` is the degenerate control the spec asks for in the same breath. A
 * group of size one is not a quorum, and a suite that stays green with
 * `VERIFIER_GROUP_SIZE = 1` is testing nothing about the group. Every case
 * below therefore takes the DEFAULT cardinality — no case passes an explicit
 * `groupSize` — so a mutant that sets the constant to 1 reaches all of them,
 * and `JG-8` asserts it reddens the withheld case rather than leaving it
 * green.
 *
 * ## Why these are not two deciders
 *
 * `main` reads the payload twice with the same function. Pass one has no
 * ballot and produces `blockingReported`; the group votes on exactly that
 * list; pass two is the same `readAiReviewFindings` with the withheld keys
 * subtracted. The jury never decides whether a finding blocks — it removes
 * findings from a set the one existing decider produced. See
 * `.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import {
  AI_REVIEW_BALLOT_KEY,
  AI_REVIEW_JURY_TITLE,
  BALLOT_UNREADABLE_PREFIX,
  NO_GROUP_CONVENED,
  aiReviewJuryGate,
  juryGate,
  readBallotDirectory,
  readBallots,
  type JuryGateOutcome,
} from "../lib/ai-review-jury";
import {
  AI_REVIEW_BLOCK_VERDICT,
  AI_REVIEW_JURY_UNMEASURED_TITLE,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_PASS_VERDICT,
  main,
  readAiReviewFindings,
} from "../lib/scaffold/ai-review-findings";
import { VERIFIER_GROUP_SIZE, VERIFIER_QUORUM } from "../lib/finding-jury";
import {
  AI_REVIEW_BALLOT_BASENAME,
  AI_REVIEW_BALLOT_DIR_ENV,
} from "../lib/scaffold/ai-review-step";
import { LEDGER_SESSION_ENV, type FilingLedgerRow } from "../lib/issue-filing-gate";

let SCRATCH: string;

beforeAll(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ai-review-jury-"));
});

afterAll(() => {
  if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────

/** A blocking finding carrying every field the contract declares. */
function blocking(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "high",
    file: "lib/example.ts",
    line: 42,
    summary: "the reading is not checked",
    failure_scenario: "a caller acts on a value nobody read",
    ...over,
  };
}

function vote(verifier: string, real: boolean): Record<string, unknown> {
  return { verifier, real, reason: real ? "reproduced it" : "the cited symbol is present" };
}

/**
 * A ballot in which `agree` of the default group call the finding real.
 *
 * Built from `VERIFIER_GROUP_SIZE` rather than from three hand-written
 * entries, so the degenerate control in `JG-8` actually reaches the fixture
 * instead of comparing a hard-coded three against a mutated constant.
 */
function ballotFor(agree: number, size: number = VERIFIER_GROUP_SIZE): Record<string, unknown>[] {
  return Array.from({ length: size }, (_, i) => vote(`verifier-${i}`, i < agree));
}

/**
 * The ballot as the verifier group writes it: a list of entries, each naming
 * its finding by the finding's own `file` and `summary`.
 *
 * The map this takes is keyed by `advisoryKey` because that is what the gate
 * works in; the payload it produces carries the pair instead, which is the
 * contract an agent can actually honour. Both sides of that translation are
 * exercised by every case below rather than asserted once.
 */
function ballotPayload(
  entries: Array<[Record<string, unknown>, Record<string, unknown>[]]>,
): string {
  return JSON.stringify({
    [AI_REVIEW_BALLOT_KEY]: entries.map(([finding, votes]) => ({
      file: finding.file,
      summary: finding.summary,
      votes,
    })),
  });
}

/**
 * The group as the deployed contract has it: ONE DIRECTORY PER VERIFIER,
 * each holding one file with one vote per finding.
 *
 * Not one file carrying three votes, and the difference is the point. The
 * review action runs with `Task` denied and `Read,Grep,Glob,Write` allowed,
 * so one invocation cannot spawn verifiers — a single file claiming a group
 * is exactly what one model in one context produces, and the merge can only
 * count independence if independence has a shape. Every case that goes
 * through `aiReviewJuryGate` builds its ballot this way.
 */
function ballotDir(
  entries: Array<[Record<string, unknown>, number]>,
  size: number = VERIFIER_GROUP_SIZE,
): string {
  const dir = join(SCRATCH, `ballots-${seq++}`);
  for (let i = 0; i < size; i++) {
    const own = join(dir, `verifier-${i}`);
    mkdirSync(own, { recursive: true });
    writeFileSync(
      join(own, AI_REVIEW_BALLOT_BASENAME),
      JSON.stringify({
        [AI_REVIEW_BALLOT_KEY]: entries.map(([finding, agree]) => ({
          file: finding.file,
          summary: finding.summary,
          votes: [vote(`verifier-${i}`, i < agree)],
        })),
      }),
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The gate as `main` takes it: the ballot directory bound in, so the
 * reader is handed a function of the findings alone.
 *
 * This is the same binding `scripts/ai-review-findings.ts` performs out of
 * `AI_REVIEW_BALLOT_DIR_ENV`, and `JG-6d` runs that one for real rather
 * than trusting this helper to stand for it.
 */
function gateFor(dir: string): (blocking: readonly unknown[]) => JuryGateOutcome {
  return blocking => aiReviewJuryGate(blocking, dir);
}

let seq = 0;
function fixture(body: string, ext = "json"): string {
  const path = join(SCRATCH, `fixture-${seq++}.${ext}`);
  writeFileSync(path, body);
  return path;
}

/** The key the gate files a finding's ballot under, as the gate computes it. */
function keyOf(finding: Record<string, unknown>): string {
  return juryGate([finding], null).verdicts[0].key;
}

/** Run `fn` with a private ledger, and return every row it appended. */
function withLedger(fn: () => void): FilingLedgerRow[] {
  const path = join(SCRATCH, `ledger-${seq++}.jsonl`);
  const before = { ledger: process.env.RUNGATE_FINDING_LEDGER, session: process.env[LEDGER_SESSION_ENV] };
  process.env.RUNGATE_FINDING_LEDGER = path;
  process.env[LEDGER_SESSION_ENV] = "jurygate-session-id";
  try {
    fn();
  } finally {
    if (before.ledger === undefined) delete process.env.RUNGATE_FINDING_LEDGER;
    else process.env.RUNGATE_FINDING_LEDGER = before.ledger;
    if (before.session === undefined) delete process.env[LEDGER_SESSION_ENV];
    else process.env[LEDGER_SESSION_ENV] = before.session;
  }
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as FilingLedgerRow);
}

/** Everything `main` writes, on both streams, as GitHub's parser sees it. */
function captureBoth(fn: () => number): { lines: string[]; code: number } {
  const written: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void written.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void written.push(a.map(String).join(" "));
  try {
    return { code: fn(), lines: written };
  } finally {
    console.log = log;
    console.error = err;
  }
}

// ── JG-1: only findings that would otherwise block are voted on ──────────

describe("JG-1: the group votes on the blocking findings and no others", () => {
  test("JG-1: an advisory finding is never handed to the gate", () => {
    const high = blocking();
    const info = blocking({ severity: "info", summary: "a nit about naming" });
    const reading = readAiReviewFindings(
      JSON.stringify({ findings: [high, info], verdict: AI_REVIEW_BLOCK_VERDICT }),
    );
    expect(reading.blockingReported).toEqual([high]);

    const result = juryGate(reading.blockingReported as unknown[], {});
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].key).toBe(keyOf(high));
  });
});

// ── JG-2: a quorum that is reached surfaces; one that is not withholds ───

describe("JG-2: the quorum decides whether a blocking finding survives", () => {
  test("JG-2a: a finding the group votes down is withheld", () => {
    const f = blocking();
    const result = juryGate([f], { [keyOf(f)]: ballotFor(VERIFIER_QUORUM - 1) });
    expect(result.withheld).toHaveLength(1);
    expect(result.withheld[0]).not.toBeNull();
    expect(result.verdicts[0].surfaced).toBe(false);
    expect(result.verdicts[0].reading?.reading).toBe("MEASURED");
    expect(result.verdicts[0].reading?.passed).toBe(false);
  });

  test("JG-2b: a finding the group agrees on keeps blocking", () => {
    const f = blocking();
    const result = juryGate([f], { [keyOf(f)]: ballotFor(VERIFIER_GROUP_SIZE) });
    expect(result.withheld).toEqual([null]);
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.verdicts[0].reading?.passed).toBe(true);
    expect(result.verdicts[0].reading?.disagreed).toBe(false);
  });

  test("JG-2c: a split that still clears the quorum surfaces, and says it disagreed", () => {
    const f = blocking();
    const result = juryGate([f], { [keyOf(f)]: ballotFor(VERIFIER_QUORUM) });
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.verdicts[0].reading?.disagreed).toBe(true);
  });
});

// ── JG-3: a group that could not be convened keeps blocking ──────────────

describe("JG-3: an unconvened group is UNMEASURED, never a pass", () => {
  test("JG-3a: no ballot for a blocking finding keeps it blocking", () => {
    const f = blocking();
    const result = juryGate([f], {});
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.verdicts[0].reading).toBeNull();
    expect(result.verdicts[0].reason).toContain(NO_GROUP_CONVENED);
    expect(result.withheld).toEqual([null]);
  });

  test("JG-3b: a short ballot is UNMEASURED and keeps blocking", () => {
    const f = blocking();
    const result = juryGate([f], { [keyOf(f)]: ballotFor(0, VERIFIER_GROUP_SIZE - 1) });
    expect(result.verdicts[0].reading?.reading).toBe("UNMEASURED");
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.withheld).toEqual([null]);
  });

  test("JG-3c: an unreadable vote refuses the ballot rather than reading a dissent", () => {
    const f = blocking();
    const result = juryGate([f], {
      [keyOf(f)]: [{ verifier: "a", real: "false", reason: "x" }, vote("b", false), vote("c", false)],
    });
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.withheld).toEqual([null]);
    expect(result.verdicts[0].reason).toMatch(/real|read/i);
  });

  test("JG-3d: an empty ballot is not a quorum of zero", () => {
    const f = blocking();
    const result = juryGate([f], { [keyOf(f)]: [] });
    expect(result.verdicts[0].surfaced).toBe(true);
    expect(result.verdicts[0].reading?.agree).toBe(0);
    expect(result.verdicts[0].reading?.reading).toBe("UNMEASURED");
  });
});

// ── JG-4: the ballot source itself ───────────────────────────────────────

describe("JG-4: an unreadable ballot source is a reading that failed", () => {
  test("JG-4a: a missing file is UNREADABLE, not an empty ballot", () => {
    const r = readBallots(null);
    expect(r.ballots).toBeNull();
    expect(r.unmeasured).toContain(BALLOT_UNREADABLE_PREFIX);
  });

  test("JG-4b: a payload with no ballots key is UNREADABLE", () => {
    const r = readBallots(JSON.stringify({ votes: {} }));
    expect(r.ballots).toBeNull();
    expect(r.unmeasured).toContain(AI_REVIEW_BALLOT_KEY);
  });

  test("JG-4c: a declared, empty ballot set is readable and convenes nobody", () => {
    const r = readBallots(ballotPayload([]));
    expect(r.unmeasured).toBeNull();
    expect(r.ballots).toEqual({});
  });

  test("JG-4d: an entry naming no finding refuses the whole source", () => {
    const r = readBallots(
      JSON.stringify({ [AI_REVIEW_BALLOT_KEY]: [{ summary: "x", votes: ballotFor(0) }] }),
    );
    expect(r.ballots).toBeNull();
    expect(r.unmeasured).toContain("file");
  });

  test("JG-4e: an entry with no votes list is malformed, not an abstention", () => {
    const f = blocking();
    const r = readBallots(
      JSON.stringify({ [AI_REVIEW_BALLOT_KEY]: [{ file: f.file, summary: f.summary }] }),
    );
    expect(r.ballots).toBeNull();
    expect(r.unmeasured).toContain("votes");
  });

  test("JG-4f: two ballots for one finding cannot be chosen between", () => {
    const f = blocking();
    const r = readBallots(ballotPayload([[f, ballotFor(0)], [f, ballotFor(VERIFIER_GROUP_SIZE)]]));
    expect(r.ballots).toBeNull();
    expect(r.unmeasured).toContain("second ballot");
  });

  test("JG-4g: the pair the writer copies resolves to the key the gate uses", () => {
    const f = blocking();
    const r = readBallots(ballotPayload([[f, ballotFor(VERIFIER_GROUP_SIZE)]]));
    // The whole point of the pair contract: no agent reproduces the hash,
    // and the hash is still the one identity.
    expect(Object.keys(r.ballots ?? {})).toEqual([keyOf(f)]);
  });

  /**
   * THE COUNTERFEIT, ARRIVING THROUGH THE FILE FORMAT.
   *
   * Found by this pull request's own `ai-review` run, against
   * `lib/ai-review-jury.ts:readBallotDirectory`, and it is the same shape
   * as the constant `agree` the issue names — a quorum that is populated,
   * plausible and filtered nothing — reached by a different route.
   *
   * One verifier directory, one file, `VERIFIER_GROUP_SIZE` votes under
   * distinct names. `juryReading` sees a full group: the names differ so
   * `REPEATED_VERIFIER` does not fire, the count is right so
   * `INCOMPLETE_GROUP` does not fire, and nothing else knows how many
   * files those votes came out of. That is exactly the artefact one model
   * in one context produces, and `AI_REVIEW_BALLOT_BASENAME`'s docblock
   * already said so — "once written down it is indistinguishable from a
   * real group" — while the code it documents merged the array whole.
   *
   * The count of files is the ONLY independence signal this layer has, so
   * it has to be spent here: one vote per file, and a file carrying more
   * is refused rather than truncated. Truncating would read as a group
   * that met and fell short; this is a ballot nobody can count.
   */
  test("JG-4h: one file cannot be a whole group — a multi-vote file is refused", () => {
    const f = blocking();
    const dir = join(SCRATCH, `stuffed-${seq++}`);
    const own = join(dir, "verifier-0");
    mkdirSync(own, { recursive: true });
    writeFileSync(
      join(own, AI_REVIEW_BALLOT_BASENAME),
      JSON.stringify({
        [AI_REVIEW_BALLOT_KEY]: [
          { file: f.file, summary: f.summary, votes: ballotFor(VERIFIER_GROUP_SIZE) },
        ],
      }),
    );

    const read = readBallotDirectory(dir);
    expect(read.ballots, "one file supplied a whole quorum").toBeNull();
    expect(read.unmeasured).toContain(BALLOT_UNREADABLE_PREFIX);
    expect(read.unmeasured).toContain("verifier-0");

    // And the gate reports it as a group that did not meet, with the
    // finding still blocking — never as a quorum.
    const out = withLedgerResult(() => aiReviewJuryGate([f], dir));
    expect(out.unmeasured).not.toBeNull();
    expect(out.wouldWithhold).toEqual([]);
  });

  test("JG-4i: one vote per file IS the readable case — the control for JG-4h", () => {
    // Without this, JG-4h could pass on a reader that refuses every
    // directory, and the refusal would look like a working cap.
    const f = blocking();
    const read = readBallotDirectory(ballotDir([[f, VERIFIER_GROUP_SIZE]]));
    expect(read.unmeasured).toBeNull();
    expect((read.ballots ?? {})[keyOf(f)]).toHaveLength(VERIFIER_GROUP_SIZE);
  });
});

// ── JG-9: one vote may not decide two findings ───────────────────────────

/**
 * The defect a security review found in this file's first cut, and the row
 * rather than the sentence.
 *
 * The verdict used to be carried back to the reader as a map from
 * `advisoryKey` to a reason, re-derived in the reader's own second pass. Two
 * blocking findings that share that identity then shared a vote: the group
 * votes the one it saw real, and the other is upheld or withheld on a
 * verdict that was never about it. `lib/finding-arbiter.ts` had already
 * refused exactly this — `SHARED_BALLOT`, *"a vote is about a finding"* —
 * and named the remedy: one group per finding, in input order.
 *
 * **The mutation a positional carry survives and a hash lookup does not** is
 * `JG-9c`: the reader's `withheld[blockingIndex]` rewritten to
 * `withheld[advisoryKey(finding)]`, which is the code this replaced. Under
 * it the second of two colliding findings takes the first's verdict. Under
 * the positional carry each finding takes its own, and the gate refuses the
 * collision before either is voted on at all.
 */
describe("JG-9: a shared identity does not become a shared quorum", () => {
  /** Two findings, one identity: `advisoryKey` reads file and summary only. */
  function collidingPair(): [Record<string, unknown>, Record<string, unknown>] {
    const a = blocking({ line: 42, failure_scenario: "the first caller acts on it" });
    const b = blocking({ line: 907, failure_scenario: "a different caller, a different path" });
    return [a, b];
  }

  test("JG-9a: the pair really does collide, or the rest of this proves nothing", () => {
    const [a, b] = collidingPair();
    expect(keyOf(a)).toBe(keyOf(b));
    expect(a).not.toEqual(b);
  });

  test("JG-9b: a ballot under the shared identity decides neither", () => {
    const [a, b] = collidingPair();
    // The group votes the finding down. Under the keyed carry this withheld
    // BOTH of them on one ballot.
    const result = juryGate([a, b], { [keyOf(a)]: ballotFor(VERIFIER_QUORUM - 1) });
    expect(result.withheld).toEqual([null, null]);
    expect(result.verdicts.map(v => v.surfaced)).toEqual([true, true]);
    for (const v of result.verdicts) {
      expect(v.reading).toBeNull();
      expect(v.refusal).toBe("UNMEASURED");
      expect(v.reason).toContain("share the identity");
    }
  });

  test("JG-9c: the verdict list is built by position, never keyed", () => {
    const source = readFileSync(join(LIB, "ai-review-jury.ts"), "utf-8");
    // One append per finding, in the order they arrive, from the single
    // `record` site. A keyed assignment — `withheld[key] = reason` — was
    // the first cut and is what let two findings share a vote.
    expect(source).toContain("withheld.push(");
    expect(source).not.toMatch(/withheld\[[A-Za-z]/);
  });

  test("JG-9d: two distinct findings each take their own verdict, in order", () => {
    const first = blocking({ summary: "the first defect" });
    const second = blocking({ summary: "the second defect" });
    const result = juryGate([first, second], {
      [keyOf(first)]: ballotFor(VERIFIER_QUORUM - 1),
      [keyOf(second)]: ballotFor(VERIFIER_GROUP_SIZE),
    });
    expect(result.withheld[0]).not.toBeNull();
    expect(result.withheld[1]).toBeNull();
  });

  test("JG-9e: one verdict per blocking finding, in input order — the positional precondition", () => {
    const first = blocking({ summary: "the first defect" });
    const second = blocking({ summary: "the second defect" });
    // Distinct identities, and only the second is voted down. A keyed carry
    // that collapsed the two would have to put the verdict somewhere, and
    // the only wrong places left are index 0 or both indices.
    const dir = ballotDir([
      [first, VERIFIER_GROUP_SIZE],
      [second, VERIFIER_QUORUM - 1],
    ]);
    const out = aiReviewJuryGate([first, second], dir);
    expect(out.unmeasured).toBeNull();
    expect(out.wouldWithhold).toHaveLength(2);
    expect(out.wouldWithhold[0]).toBeNull();
    expect(out.wouldWithhold[1]).not.toBeNull();
  });

  test("JG-9f: the reader subtracts nothing, so nothing can be subtracted wrongly", () => {
    const source = readFileSync(join(LIB, "scaffold", "ai-review-findings.ts"), "utf-8");
    // The strongest form of the collision fix available this round: the
    // consumer never looks a verdict up at all, by key OR by index. `JG-6b`
    // is the behavioural half — a ballot voting a finding down leaves the
    // run byte-identical to one with no ballot at all.
    expect(source).not.toMatch(/withheld\[/);
    expect(source).not.toMatch(/wouldWithhold\[/);
  });
});

// ── JG-5: the ledger carries the ballot, written at decision time ────────

describe("JG-5: every verifier's vote and the disagreement flag reach the ledger", () => {
  test("JG-5a: a finding the group votes down is on the ledger with its whole ballot", () => {
    const f = blocking();
    const dir = ballotDir([[f, VERIFIER_QUORUM - 1]]);
    const rows = withLedger(() => void aiReviewJuryGate([f], dir));

    expect(rows).toHaveLength(1);
    expect(rows[0].jury).not.toBeNull();
    expect(rows[0].jury?.ballot).toHaveLength(VERIFIER_GROUP_SIZE);
    expect(rows[0].jury?.ballot.map(v => v.verifier)).toEqual(
      Array.from({ length: VERIFIER_GROUP_SIZE }, (_, i) => `verifier-${i}`),
    );
    expect(rows[0].jury?.agree).toBe(VERIFIER_QUORUM - 1);
    expect(rows[0].jury?.disagreed).toBe(VERIFIER_QUORUM - 1 > 0);
    // DROP on the row, and the finding still blocks. The ledger records what
    // the group decided; the pull request records what the adjudicator did,
    // and this round those are deliberately different.
    expect(rows[0].emitted).toBe(false);
  });

  test("JG-5b: a finding the group upholds is recorded too — the population is both", () => {
    const f = blocking();
    const rows = withLedger(() => void aiReviewJuryGate([f], ballotDir([[f, VERIFIER_GROUP_SIZE]])));
    expect(rows).toHaveLength(1);
    expect(rows[0].emitted).toBe(true);
    expect(rows[0].jury?.passed).toBe(true);
    expect(rows[0].jury?.ballot).toHaveLength(VERIFIER_GROUP_SIZE);
  });

  test("JG-5c: a finding nobody voted on is on the ledger with a null reading", () => {
    const f = blocking();
    const rows = withLedger(() => void aiReviewJuryGate([f], ballotDir([])));
    expect(rows).toHaveLength(1);
    expect(rows[0].jury).toBeNull();
    expect(rows[0].emitted).toBe(true);
  });

  test("JG-5d: every vote carries the verifier's own reason, not a summary", () => {
    const f = blocking();
    const rows = withLedger(() => void aiReviewJuryGate([f], ballotDir([[f, VERIFIER_QUORUM - 1]])));
    for (const v of rows[0].jury?.ballot ?? []) {
      expect(v.reason.length).toBeGreaterThan(0);
    }
    expect(new Set((rows[0].jury?.ballot ?? []).map(v => v.verifier)).size).toBe(
      VERIFIER_GROUP_SIZE,
    );
  });
});

// ── JG-6: the deployed CLI records the vote and acts on nothing ──────────

describe("JG-6: main records the quorum and changes no verdict", () => {
  test("JG-6a: with no ballot argument the reading is exactly what it was", () => {
    const payload = fixture(JSON.stringify({ findings: [blocking()], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const { code, lines } = captureBoth(() => main([payload]));
    expect(code).not.toBe(0);
    expect(lines.some(l => l.includes(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`))).toBe(true);
  });

  /**
   * THE CASE THAT GUARDS THE DECISION, not an omission.
   *
   * A group that votes a finding down changes nothing: the outcome, the exit
   * code and the blocking count are byte-for-byte what they are with no
   * ballot at all. Delete the two reasons in `main`'s CRC-B4 block — the
   * denied `Task` grant and the head-checkout read — and this case is what
   * has to be rewritten, which is the point of writing it as an equality
   * against the no-ballot run rather than as an assertion about BLOCKED.
   */
  test("JG-6b: a ballot the group votes down does NOT un-block the finding", () => {
    const f = blocking();
    const payload = fixture(JSON.stringify({ findings: [f], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const dir = ballotDir([[f, VERIFIER_QUORUM - 1]]);

    const without = captureBoth(() => main([payload]));
    const withBallot = withLedgerResult(() =>
      captureBoth(() => main([payload], gateFor(dir))),
    );

    expect(withBallot.code).toBe(without.code);
    expect(withBallot.lines[0]).toBe(without.lines[0]);
    expect(withBallot.lines.some(l => l.includes(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`))).toBe(true);
    // And it is not silent about having voted.
    expect(withBallot.lines.some(l => l.includes(AI_REVIEW_JURY_TITLE))).toBe(true);
    expect(withBallot.lines.join("\n")).toContain("RECORDED AND CHANGES");
  });

  test("JG-6c: a ballot that clears the quorum also changes nothing", () => {
    const f = blocking();
    const payload = fixture(JSON.stringify({ findings: [f], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const dir = ballotDir([[f, VERIFIER_GROUP_SIZE]]);
    const { code, lines } = withLedgerResult(() =>
      captureBoth(() => main([payload], gateFor(dir))),
    );
    expect(lines.some(l => l.includes(`${AI_REVIEW_OUTCOME_LINE} BLOCKED`))).toBe(true);
    expect(code).not.toBe(0);
  });

  /**
   * THE DEPLOYED PATH, spawned, not the in-process seam.
   *
   * Every other case in this file hands `main` a gate directly, which
   * proves the reader records a vote and proves nothing about whether the
   * published entry point ever supplies one. `scripts/ai-review-findings.ts`
   * is where the directory binds, out of `AI_REVIEW_BALLOT_DIR_ENV`, and a
   * wrapper that forgot the binding would leave all of CRC-B4 dead with
   * every case above still green.
   *
   * Spawned rather than imported because the binding happens at module
   * load from `process.env`, and `.../feedback` on late env edits applies:
   * a child gets the environment it was spawned with.
   */
  test("JG-6d: the published entry point supplies the gate when the env names a directory", () => {
    const f = blocking();
    const payload = fixture(JSON.stringify({ findings: [f], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const dir = ballotDir([[f, VERIFIER_QUORUM - 1]]);
    const ledger = join(SCRATCH, `wrapper-ledger-${seq++}.jsonl`);

    const run = (env: Record<string, string>): { code: number; out: string } => {
      const r = spawnSync("bun", [join(ROOT, "scripts", "ai-review-findings.ts"), payload], {
        encoding: "utf-8",
        env: { ...process.env, RUNGATE_FINDING_LEDGER: ledger, [LEDGER_SESSION_ENV]: "jg6d", ...env },
      });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    };

    const voted = run({ [AI_REVIEW_BALLOT_DIR_ENV]: dir });
    expect(voted.out, "the wrapper did not wire the quorum").toContain(AI_REVIEW_JURY_TITLE);
    expect(voted.out).toContain("RECORDED AND CHANGES");

    // The control, and the half that makes the first assertion mean
    // something: with the variable unset the same payload prints no jury
    // annotation at all, and the exit code is identical either way.
    const silent = run({ [AI_REVIEW_BALLOT_DIR_ENV]: "" });
    expect(silent.out, "a jury annotation appeared with no ballot directory").not.toContain(
      AI_REVIEW_JURY_TITLE,
    );
    expect(voted.code).toBe(silent.code);
    expect(voted.code).not.toBe(0);

    // And the vote reached the ledger from the spawned process, which is
    // the only evidence that the deployed path records anything.
    const rows = readFileSync(ledger, "utf-8").split("\n").filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(l => (JSON.parse(l) as FilingLedgerRow).jury !== null)).toBe(true);
  });

  test("JG-6e: a ballot directory that cannot be listed is UNMEASURED, not fatal", () => {
    const f = blocking();
    const payload = fixture(JSON.stringify({ findings: [f], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const without = captureBoth(() => main([payload]));
    const { code, lines } = withLedgerResult(() =>
      captureBoth(() => main([payload], gateFor(join(SCRATCH, "absent-dir")))),
    );
    expect(lines.some(l => l.includes(AI_REVIEW_JURY_UNMEASURED_TITLE))).toBe(true);
    // An unreadable quorum must not change a verdict in either direction.
    expect(code).toBe(without.code);
  });

  test("JG-6f: a CLEAN run is untouched by the quorum, whatever the ballot says", () => {
    const payload = fixture(
      JSON.stringify({
        findings: [blocking({ severity: "info", summary: "a nit" })],
        verdict: AI_REVIEW_PASS_VERDICT,
      }),
    );
    const { code, lines } = withLedgerResult(() =>
      captureBoth(() => main([payload], gateFor(join(SCRATCH, "absent-dir")))),
    );
    expect(lines.some(l => l.includes(`${AI_REVIEW_OUTCOME_LINE} CLEAN`))).toBe(true);
    expect(code).toBe(0);
  });

  /**
   * THE THIRD COLUMN OF `JG-6b`, and the one that was missing.
   *
   * `JG-6b` compares a ballot against no ballot. Both of those are the
   * gate behaving. A gate that THROWS was the third state, and nothing
   * held it: the call sat outside any `try`, so the exception propagated
   * out of `main` and `process.exit(main(...))` never ran. A CLEAN review
   * would have died non-zero — and worse than an exit flip, the throw
   * happens ABOVE `AI_REVIEW_OUTCOME_LINE`, which the generated step greps
   * for before it will read an exit code as a verdict. No marker is an
   * adjudicator that could not run, not a verdict.
   *
   * Three things inside the real gate are outside any catch and can
   * throw: `juryReading`, `advisoryKey` over a hostile payload, and all
   * of `juryLedgerRow` — `symptomHash`, `filingBatch`, `juryCategory`,
   * `severityOf`, `classifyCategory`. Unreachable today only because
   * nothing sets `AI_REVIEW_BALLOT_DIR`; reachable the moment the
   * workflow half lands, which is this issue's remaining work.
   */
  test("JG-6h: a gate that throws changes neither the exit code nor the first line", () => {
    const payload = fixture(
      JSON.stringify({ findings: [blocking()], verdict: AI_REVIEW_BLOCK_VERDICT }),
    );
    const thrower = (): never => {
      throw new Error("the quorum exploded");
    };

    const without = captureBoth(() => main([payload]));
    const thrown = captureBoth(() => main([payload], thrower));

    expect(thrown.code, "a throwing gate changed the verdict").toBe(without.code);
    expect(thrown.lines[0], "the outcome marker moved or vanished").toBe(without.lines[0]);
    expect(thrown.lines[0]).toContain(AI_REVIEW_OUTCOME_LINE);
    // And it is named, not swallowed. A fail-open that says nothing is the
    // first shape `checks-must-be-able-to-fail.md` warns about.
    expect(thrown.lines.some(l => l.includes(AI_REVIEW_JURY_UNMEASURED_TITLE))).toBe(true);
    expect(thrown.lines.join("\n")).toContain("the quorum exploded");
  });

  /**
   * Written as a CALL COUNT, after the first draft of it was vacuous.
   *
   * That draft ran a CLEAN payload through a gate that throws and
   * asserted exit 0 — and it passed before the `try` existed, because a
   * CLEAN run has no blocking findings and the gate is never reached. It
   * asserted a true thing by a path that cannot reach the mechanism:
   * `checks-must-be-able-to-fail.md`'s third shape, in a case written to
   * guard against the sixth.
   *
   * The property worth holding is the one that made it vacuous. A quorum
   * is spent per blocking finding, so a CLEAN run must not convene one at
   * all, and a count is the only reading that can tell "did not throw"
   * from "was never called".
   */
  test("JG-6i: a CLEAN run never convenes the group — zero calls, not a safe one", () => {
    let calls = 0;
    const counting = (b: readonly unknown[]): JuryGateOutcome => {
      calls += 1;
      return { wouldWithhold: b.map(() => null), unmeasured: null, detail: [] };
    };

    const clean = fixture(
      JSON.stringify({
        findings: [blocking({ severity: "info", summary: "a nit" })],
        verdict: AI_REVIEW_PASS_VERDICT,
      }),
    );
    const { code } = captureBoth(() => main([clean], counting));
    expect(code).toBe(0);
    expect(calls, "a CLEAN run spent a verifier group").toBe(0);

    // The positive control, and the half that makes the zero mean
    // something: the same gate IS called on a payload that blocks.
    const blocked = fixture(
      JSON.stringify({ findings: [blocking()], verdict: AI_REVIEW_BLOCK_VERDICT }),
    );
    captureBoth(() => main([blocked], counting));
    expect(calls, "the gate was never called on a blocking payload either").toBe(1);
  });

  test("JG-6g: the finding is still reported — nothing is silently dropped", () => {
    const f = blocking();
    const payload = fixture(JSON.stringify({ findings: [f], verdict: AI_REVIEW_BLOCK_VERDICT }));
    const dir = ballotDir([[f, VERIFIER_QUORUM - 1]]);
    const { lines } = withLedgerResult(() =>
      captureBoth(() => main([payload], gateFor(dir))),
    );
    expect(lines.join("\n")).toContain(String(f.summary));
  });
});

/** `withLedger`, for a body that returns something. */
function withLedgerResult<T>(fn: () => T): T {
  let out!: T;
  withLedger(() => {
    out = fn();
  });
  return out;
}

// ── JG-7: the mutation battery CRC-B4 names ──────────────────────────────

/**
 * The counterfeit the criterion names, built and run.
 *
 * `const agree = votes.filter(v => v.real).length` becomes
 * `const agree = groupSize`. Everything downstream still works: the ballot is
 * populated, `votes` is right, the reading is MEASURED, the ledger row carries
 * three named verifiers and their reasons. The only thing that changes is that
 * nothing is ever withheld.
 */
const AGREE_BINDING = "const agree = votes.filter(v => v.real).length;";
const AGREE_MUTANT = "const agree = groupSize;";

const ROOT = join(import.meta.dir, "..");
const LIB = join(ROOT, "lib");

/**
 * A copy of the gate whose `lib/finding-jury.ts` is `mutate(source)` and
 * whose every OTHER dependency is the real one in this tree.
 *
 * Copying the dependency closure by hand was the first attempt and it is the
 * wrong shape: `lib/finding-arbiter.ts` imports `./content-hash`, which
 * imports more, and a file the copier forgets dies on module resolution —
 * which reads exactly like the mutation being rejected on the merits rather
 * than like a copier bug. So the gate's sibling specifiers are rewritten to
 * absolute paths into this tree and only `./finding-jury` is redirected at
 * the mutant.
 *
 * Both halves are asserted, not assumed: the mutation changed the source,
 * and the rewrite changed the gate. A battery whose mutant did not apply
 * reports a clean row (`.claude/rules/checks-must-be-able-to-fail.md`, the
 * seventh shape).
 */
async function mutantGate(
  name: string,
  mutate: (source: string) => string,
): Promise<typeof import("../lib/ai-review-jury")> {
  const dir = join(SCRATCH, `mutant-${name}`);
  mkdirSync(dir, { recursive: true });

  const jurySource = readFileSync(join(LIB, "finding-jury.ts"), "utf-8");
  const mutated = mutate(jurySource);
  expect(mutated, `the mutation for ${name} did not change lib/finding-jury.ts`).not.toBe(
    jurySource,
  );
  // The mutant's OWN sibling specifiers, rewritten the same way the gate's
  // are. `lib/finding-jury.ts` carried only a type-only import until CRC-B7
  // moved `SEVERITY_RANK` into `./scaffold/ai-review-step` — one declaration,
  // reachable from the deployed CI path — and a type import is erased at
  // transpile while a value import is not. Without this the mutant dies on
  // module resolution, which reads exactly like the mutation being rejected
  // on the merits (`.claude/rules/self-referential-tests.md`, Tier 1, last
  // row). Asserted rather than assumed, so a future import that this rewrite
  // does not cover reds here instead of going quiet.
  const juryRewritten = mutated
    .replace(/from "\.\/scaffold\//g, `from "${join(LIB, "scaffold")}/`)
    .replace(/from "\.\//g, `from "${LIB}/`);
  expect(
    juryRewritten,
    `the mutant copy of finding-jury.ts for ${name} kept a relative import, so it would ` +
      `die on module resolution and read as the mutation being rejected`,
  ).not.toContain('from "./');
  writeFileSync(join(dir, "finding-jury.ts"), juryRewritten);

  const gateSource = readFileSync(join(LIB, "ai-review-jury.ts"), "utf-8");
  const rewritten = gateSource
    .replace(/from "\.\/scaffold\//g, `from "${join(LIB, "scaffold")}/`)
    .replace(/from "\.\/(?!finding-jury")/g, `from "${LIB}/`);
  expect(rewritten, `the gate copy for ${name} kept a relative sibling import`).not.toBe(
    gateSource,
  );
  expect(rewritten).toContain('from "./finding-jury"');
  writeFileSync(join(dir, "ai-review-jury.ts"), rewritten);

  return (await import(join(dir, "ai-review-jury.ts"))) as typeof import("../lib/ai-review-jury");
}

describe("JG-7: a quorum wired to a constant is told apart from a vote", () => {
  test("JG-7a: the binding the mutation rewrites appears exactly once", () => {
    const source = readFileSync(join(import.meta.dir, "..", "lib", "finding-jury.ts"), "utf-8");
    expect(source.split(AGREE_BINDING).length - 1).toBe(1);
  });

  test("JG-7b: real withholds the finding; the constant-quorum mutant blocks it", async () => {
    const mutant = await mutantGate("agree", s => s.replace(AGREE_BINDING, AGREE_MUTANT));
    const f = blocking();
    const votes = { [keyOf(f)]: ballotFor(VERIFIER_QUORUM - 1) };

    const real = juryGate([f], votes);
    const forged = mutant.juryGate([f], votes);

    expect(forged.verdicts[0].reading).not.toBeNull();
    expect(forged.verdicts[0].reading?.reading).toBe("MEASURED");
    expect(forged.verdicts[0].reading?.ballot).toHaveLength(VERIFIER_GROUP_SIZE);

    // Same input, opposite outcome.
    expect(real.verdicts[0].surfaced).toBe(false);
    expect(forged.verdicts[0].surfaced).toBe(true);
    expect(real.withheld.filter(Boolean)).toHaveLength(1);
    expect(forged.withheld.filter(Boolean)).toHaveLength(0);
    // The ledger row is the discriminator, not the exit code.
    expect(real.verdicts[0].reading?.agree).toBe(VERIFIER_QUORUM - 1);
    expect(forged.verdicts[0].reading?.agree).toBe(VERIFIER_GROUP_SIZE);
    expect(real.verdicts[0].reading?.disagreed).toBe(VERIFIER_QUORUM - 1 > 0);
  });
});

// ── JG-8: the degenerate control — a group of one is not a quorum ────────

describe("JG-8: the suite is not green with a group of one", () => {
  test("JG-8: VERIFIER_GROUP_SIZE = 1 breaks the withheld case", async () => {
    const mutant = await mutantGate("size-one", s =>
      s.replace("export const VERIFIER_GROUP_SIZE = 3;", "export const VERIFIER_GROUP_SIZE = 1;"),
    );
    const f = blocking();
    // The SAME three-verifier ballot JG-2a withholds on.
    const votes = { [keyOf(f)]: ballotFor(VERIFIER_QUORUM - 1) };
    const forged = mutant.juryGate([f], votes);

    // Under a group of one the three-vote ballot is not a reading at all, so
    // the case JG-2a asserts cannot hold: nothing is withheld, and the reason
    // is the cardinality rather than the vote.
    expect(forged.verdicts[0].reading?.reading).toBe("UNMEASURED");
    expect(forged.withheld.filter(Boolean)).toHaveLength(0);
    expect(juryGate([f], votes).verdicts[0].surfaced).toBe(false);
  });
});
