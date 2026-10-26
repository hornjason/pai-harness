/**
 * Carry-forward decided from review threads rather than from line text.
 *
 * Increment 1b (AC-2 and AC-4 at #1614#issuecomment-6419432224). `carryForward`
 * today decides "still unanswered" by comparing the text at a finding's cited
 * line against the text recorded when it was raised. That is a heuristic over
 * a moving document, and #1601 is the instance of it failing in the costly
 * direction: a required check reported CLEAN over a live blocker for two
 * rounds because unrelated edits shifted the file.
 *
 * A review thread answers the same question authoritatively, because
 * `isResolved` is a thing a person did. #1618 made a posted thread carry the
 * key it was raised under, which is what lets a thread be matched to a
 * finding at all.
 *
 * ## The direction of error, and it is the whole design
 *
 * Every way of failing to establish an answer CARRIES the finding. Re-raising
 * something already dealt with is loud, cheap and self-correcting; dropping a
 * live finding is silent and permanent, and #1601 is what that costs. So an
 * unreadable thread list, a finding with no key, and a key no thread carries
 * all carry — and each says something DIFFERENT about why, because "no thread
 * answered this" and "nothing could be read" are different facts.
 *
 * ## What was broken to prove each case can fail
 *
 * TC-1  a resolved thread must DROP, or the function carries everything and
 *       its only behaviour is the identity.
 * TC-2  an open thread must CARRY.
 * TC-3  an UNMEASURED reading must carry EVERYTHING and say so by name.
 * TC-4  a key no thread holds must carry — the finding predates #1618, or
 *       the thread was never posted.
 * TC-5  an unkeyable finding must carry.
 * TC-6  **duplicates.** A finding with two threads, one resolved and one
 *       open, must CARRY. Measured on #1614: one observation produced twelve
 *       threads, so "a thread with this key is resolved" is not the same
 *       claim as "this finding is answered", and a reader that stops at the
 *       first match answers a live finding by coincidence of ordering.
 * TC-7  the reason strings must be distinguishable, or UNMEASURED and
 *       "nothing was answered" collapse into one report.
 */
import { describe, expect, test } from "bun:test";

import {
  CARRY_THREADS_UNMEASURED,
  carryForwardFromThreads,
  type CarriedFinding,
  type ReviewFinding,
  type ThreadReading,
} from "../lib/ai-review-rounds.ts";

const A: ReviewFinding = { severity: "high", file: "lib/a.ts", line: 10, summary: "a is wrong" };
const B: ReviewFinding = { severity: "low", file: "lib/b.ts", line: 20, summary: "b is wrong" };

/** Key a finding the way the producer does, without reaching for the real one. */
const keyFor = (f: ReviewFinding): string | null =>
  f.file === undefined || f.summary === undefined ? null : `${f.file}\u0000t:x\u0000${f.summary}`;

const prior = (...f: ReviewFinding[]): CarriedFinding[] => f.map(finding => ({ finding }));

function measured(...threads: { key: string; isResolved: boolean }[]): ThreadReading {
  return { status: "MEASURED", threads };
}

describe("carry-forward reads the thread, not the line", () => {
  test("TC-1: a RESOLVED thread answers its finding, and it is dropped", () => {
    const out = carryForwardFromThreads(prior(A), measured({ key: keyFor(A)!, isResolved: true }), keyFor);
    expect(out.unmeasured).toBeNull();
    expect(
      out.carried,
      "resolution is a human act; re-raising what a person closed is the behaviour this replaces",
    ).toEqual([]);
  });

  test("TC-2: an OPEN thread means the finding stands", () => {
    const out = carryForwardFromThreads(prior(A), measured({ key: keyFor(A)!, isResolved: false }), keyFor);
    expect(out.carried).toEqual([A]);
    expect(out.unmeasured).toBeNull();
  });

  test("TC-3: an UNMEASURED reading carries EVERYTHING and names itself", () => {
    const out = carryForwardFromThreads(
      prior(A, B),
      { status: "UNMEASURED", reason: "the thread list could not be read" },
      keyFor,
    );
    expect(out.carried, "a reading that could not be taken answers nothing").toEqual([A, B]);
    expect(out.unmeasured).toBe("the thread list could not be read");
    expect(
      CARRY_THREADS_UNMEASURED,
      "the state has a name, so a caller can report it rather than printing zero",
    ).toBeTruthy();
  });

  test("TC-4: a key no thread holds carries, and does not read as answered", () => {
    // The finding predates #1618 and its thread has no marker, or no thread
    // was ever posted. Either way nothing answered it.
    const out = carryForwardFromThreads(prior(A), measured({ key: keyFor(B)!, isResolved: true }), keyFor);
    expect(out.carried, "another finding's resolved thread is not this finding's answer").toEqual([A]);
  });

  test("TC-5: an unkeyable finding carries, even against an EMPTY-keyed thread", () => {
    // The hostile input, and the only one that makes this path reachable.
    // `threadKeyFrom` returns null for a thread with no marker — every thread
    // posted before #1618 — and a caller that spells null as "" hands us a
    // resolved thread keyed "". An unkeyable finding keys to the same empty
    // string, so a decider that does not refuse the empty key on BOTH sides
    // reads "nobody could identify either of these" as "these are the same
    // finding, and it was answered". Every unkeyable finding then disappears
    // the moment one unmarked thread is resolved.
    //
    // Measured: with no empty-keyed thread in the reading this case cannot
    // fail under any single mutation of the decider, because the map never
    // holds an empty key. The thread below is what gives it something to be
    // wrong about.
    const bare = { severity: "low", line: 3 } as ReviewFinding;
    expect(keyFor(bare), "the fixture must really be unkeyable").toBeNull();
    const out = carryForwardFromThreads(
      prior(bare),
      measured({ key: "", isResolved: true }),
      keyFor,
    );
    expect(out.carried, "two things nobody could identify are not the same thing").toEqual([bare]);
  });

  test("TC-6: one resolved and one OPEN thread for the same finding carries", () => {
    // THE ROW THE DUPLICATE MEASUREMENT DEMANDS. On #1614 a single observation
    // produced twelve threads. A reader that stops at the first key match
    // answers a live finding by coincidence of ordering, and the ordering is
    // the API's, not ours — so both orders are asserted.
    const k = keyFor(A)!;
    const resolvedFirst = carryForwardFromThreads(
      prior(A),
      measured({ key: k, isResolved: true }, { key: k, isResolved: false }),
      keyFor,
    );
    const openFirst = carryForwardFromThreads(
      prior(A),
      measured({ key: k, isResolved: false }, { key: k, isResolved: true }),
      keyFor,
    );
    expect(resolvedFirst.carried, "resolved-first must not answer it").toEqual([A]);
    expect(openFirst.carried, "open-first must not answer it either").toEqual([A]);

    // And the control: ALL resolved does drop it, or TC-6 passes for an
    // implementation that simply never drops anything.
    const allResolved = carryForwardFromThreads(
      prior(A),
      measured({ key: k, isResolved: true }, { key: k, isResolved: true }),
      keyFor,
    );
    expect(allResolved.carried, "every thread resolved IS an answer").toEqual([]);
  });

  test("TC-7: 'nothing was answered' and 'nothing could be read' are different reports", () => {
    const nothingAnswered = carryForwardFromThreads(prior(A), measured(), keyFor);
    const nothingRead = carryForwardFromThreads(
      prior(A),
      { status: "UNMEASURED", reason: "the thread list could not be read" },
      keyFor,
    );
    expect(nothingAnswered.carried).toEqual([A]);
    expect(nothingRead.carried).toEqual([A]);
    // Same carried set, different fact. If these collapse, a broken fetch
    // reads as a pull request on which nobody resolved anything.
    expect(nothingAnswered.unmeasured).toBeNull();
    expect(nothingRead.unmeasured).not.toBeNull();
  });

  test("TC-8: the mixed case — one answered, one not — drops exactly one", () => {
    const out = carryForwardFromThreads(
      prior(A, B),
      measured({ key: keyFor(A)!, isResolved: true }, { key: keyFor(B)!, isResolved: false }),
      keyFor,
    );
    expect(out.carried, "a partition, not an all-or-nothing").toEqual([B]);
  });
});
