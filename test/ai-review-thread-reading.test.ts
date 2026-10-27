/**
 * Turning a pull request's review threads into a `ThreadReading`.
 *
 * Increment 1b's other half. `carryForwardFromThreads` takes the reading as a
 * PARAMETER so it can be handed a negative control; this is the thing that
 * produces one from what GitHub actually returns, and it is where every way
 * the API can disappoint us has to be decided.
 *
 * ## Why the mapping is not trivial
 *
 * A thread is only usable here if it carries the key its finding was raised
 * under — the base64 marker #1618 added. Every thread posted before #1618,
 * and every thread a human opened, carries none. Those threads are real and
 * they are not evidence about any finding, so they are DROPPED rather than
 * keyed to the empty string: two things nobody can identify are not the same
 * thing, and collapsing them means one resolved human comment answers every
 * unkeyable finding at once.
 *
 * ## What was broken to prove each case can fail
 *
 * TR-1  a keyed thread survives with its resolution — or the reading is empty
 *       and every downstream case is vacuous.
 * TR-2  an absent list is UNMEASURED and keeps its reason.
 * TR-3  an EMPTY list is MEASURED. "Nobody has commented" is a reading.
 * TR-4  an unmarked thread is dropped, not keyed `""`.
 * TR-5  a non-boolean `isResolved` reads as NOT resolved. A partial GraphQL
 *       response must not answer a finding by omission.
 * TR-6  end to end: a real reading drives `carryForwardFromThreads`.
 */
import { describe, expect, test } from "bun:test";

import { carryForwardFromThreads, type ReviewFinding } from "../lib/ai-review-rounds.ts";
import {
  THREADS_NOT_A_LIST,
  THREADS_NOT_READ,
  THREADS_UNPARSEABLE,
  threadReading,
  threadReadingFromJson,
} from "../lib/ai-review-threads.ts";
import { threadBody } from "../lib/scaffold/ai-review-findings.ts";

const KEY = "lib/a.ts\u0000t:const x = 1;\u0000a is wrong";

/** A thread body as the poster really writes one, marker and all. */
const keyed = (key: string) => threadBody({ severity: "high", summary: "a is wrong" }, key);

describe("reading a pull request's review threads", () => {
  test("TR-1: a keyed thread survives with its resolution", () => {
    const r = threadReading([{ isResolved: true, body: keyed(KEY) }], "unused");
    expect(r.status).toBe("MEASURED");
    expect(
      r.status === "MEASURED" ? r.threads : null,
      "the body is built by the real poster, so this fails if either side of the marker moves",
    ).toEqual([{ key: KEY, isResolved: true }]);
  });

  test("TR-2: an absent list is UNMEASURED and keeps its reason", () => {
    const r = threadReading(null, "the GraphQL query returned an error");
    expect(r.status).toBe("UNMEASURED");
    expect(r.status === "UNMEASURED" ? r.reason : null).toBe("the GraphQL query returned an error");
  });

  test("TR-3: an EMPTY list is MEASURED, not UNMEASURED", () => {
    // "Nobody has opened a thread" is a fact about the pull request. Reporting
    // it as unreadable would make every first round look like a failed fetch,
    // which is the state this whole split exists to keep separate.
    const r = threadReading([], "unused");
    expect(r.status).toBe("MEASURED");
    expect(r.status === "MEASURED" ? r.threads : null).toEqual([]);
  });

  test("TR-4: a thread with no marker is DROPPED, not keyed to the empty string", () => {
    // Every thread predating #1618, and every thread a person opened. If these
    // collapse to `""`, one resolved human comment answers every unkeyable
    // finding on the pull request at once.
    const r = threadReading(
      [
        { isResolved: true, body: "Looks good to me" },
        { isResolved: true, body: keyed(KEY) },
      ],
      "unused",
    );
    expect(r.status === "MEASURED" ? r.threads : null).toEqual([{ key: KEY, isResolved: true }]);
  });

  test("TR-5: a non-boolean isResolved reads as NOT resolved", () => {
    // A partial GraphQL response drops fields rather than failing. A finding
    // answered by an omission is the silent direction, so only the literal
    // `true` counts.
    for (const bad of [undefined, null, "true", 1, {}]) {
      const r = threadReading([{ isResolved: bad, body: keyed(KEY) }], "unused");
      expect(
        r.status === "MEASURED" ? r.threads : null,
        `isResolved ${JSON.stringify(bad) ?? "undefined"} must not read as resolved`,
      ).toEqual([{ key: KEY, isResolved: false }]);
    }
  });

  test("TR-7: a NULL node is dropped, and does not throw past the caller", () => {
    // Raised on #1620. A GraphQL connection returns a null node for an entry
    // the token cannot see — a thread on a deleted file, one hidden by a
    // permission — and `t.body` on it throws a TypeError straight past this
    // function. That is the one failure mode the module is built to not have:
    // every undecidable thread degrades to a drop, which CARRIES its finding.
    //
    // Asserted as a non-throw AND on the surviving element, because a
    // `toThrow`-free call that silently returned UNMEASURED would also pass a
    // bare "does not throw".
    const raw = [null, { isResolved: true, body: keyed(KEY) }, undefined, 7, "x"] as never;
    let captured: ReturnType<typeof threadReading> | undefined;
    expect(() => {
      captured = threadReading(raw, "unused");
    }, "a null node must not throw past threadReading").not.toThrow();
    // Bound to a const so the discriminated union narrows — a `!` on a `let`
    // does not, and the first draft of this case failed typecheck on it.
    const r = captured as ReturnType<typeof threadReading>;
    expect(r.status, "and it must still be a reading, not a refusal").toBe("MEASURED");
    expect(r.status === "MEASURED" ? r.threads : null).toEqual([{ key: KEY, isResolved: true }]);
  });

  test("TR-6: end to end — the reading drives the carry decision", () => {
    const finding: ReviewFinding = { severity: "high", file: "lib/a.ts", summary: "a is wrong" };
    const keyFor = () => KEY;

    const answered = carryForwardFromThreads(
      [{ finding }],
      threadReading([{ isResolved: true, body: keyed(KEY) }], "unused"),
      keyFor,
    );
    const open = carryForwardFromThreads(
      [{ finding }],
      threadReading([{ isResolved: false, body: keyed(KEY) }], "unused"),
      keyFor,
    );
    const unread = carryForwardFromThreads([{ finding }], threadReading(null, "no token"), keyFor);

    expect(answered.carried, "resolved upstream means dropped downstream").toEqual([]);
    expect(open.carried).toEqual([finding]);
    expect(unread.carried).toEqual([finding]);
    expect(unread.unmeasured).toBe("no token");
  });
});

/**
 * Increment 1a. The reading above takes PARSED nodes; the runner has a FILE,
 * written by a bash step that fetched the threads before the reviewer ran.
 * Everything between those two is this function, and every way the file can
 * disappoint has to produce a sentence rather than an empty list — AC-4:
 * *"an unreadable thread list is UNMEASURED by name, distinguishable from
 * 'no earlier findings'."*
 *
 * What was broken to prove each can fail is in the battery at the foot of
 * `test/ai-review-suppression.test.ts`; these rows fix the sentences.
 */
describe("reading the thread list off the runner's disk", () => {
  test("TR-8: a written list parses, and the keys survive the round trip through JSON", () => {
    // The whole join: bash writes what GraphQL returned, this reads it back.
    // If the marker does not survive a `JSON.stringify`/`parse` the reading is
    // MEASURED with zero keys, which suppresses nothing and is indistinguishable
    // from a pull request nobody has reviewed.
    const text = JSON.stringify([
      { isResolved: false, body: keyed(KEY) },
      { isResolved: true, body: keyed(`${KEY} (other)`) },
    ]);
    const r = threadReadingFromJson(text);
    expect(r.status).toBe("MEASURED");
    expect(r.status === "MEASURED" ? r.threads : null).toEqual([
      { key: KEY, isResolved: false },
      { key: `${KEY} (other)`, isResolved: true },
    ]);
  });

  test("TR-9: an absent file is UNMEASURED, and says the list was not read", () => {
    for (const absent of [null, undefined, ""]) {
      const r = threadReadingFromJson(absent);
      expect(r.status, `${JSON.stringify(absent)} was read as a list`).toBe("UNMEASURED");
      expect(r.status === "UNMEASURED" ? r.reason : "").toBe(THREADS_NOT_READ);
    }
  });

  test("TR-10: a file that is not JSON is UNMEASURED, and says so in DIFFERENT words", () => {
    // A truncated write — the step was killed between the fetch and the flush.
    // Reported as "not read" it would be indistinguishable from no fetch at
    // all, and reported as MEASURED it would suppress nothing while claiming
    // to have looked.
    const r = threadReadingFromJson('[{"isResolved": false, "body": "half');
    expect(r.status).toBe("UNMEASURED");
    expect(r.status === "UNMEASURED" ? r.reason : "").toBe(THREADS_UNPARSEABLE);
    expect(THREADS_UNPARSEABLE, "two facts sharing one sentence is one fact").not.toBe(
      THREADS_NOT_READ,
    );
  });

  test("TR-11: JSON that is not a list is UNMEASURED, in its own words", () => {
    // What a GraphQL error response is: valid JSON, an object, `{"errors":[…]}`
    // and no data. Read as an empty list it is a pull request with no threads,
    // which is the exact silent failure this split exists to prevent.
    const r = threadReadingFromJson('{"errors":[{"message":"Bad credentials"}]}');
    expect(r.status).toBe("UNMEASURED");
    expect(r.status === "UNMEASURED" ? r.reason : "").toBe(THREADS_NOT_A_LIST);
    expect(new Set([THREADS_NOT_READ, THREADS_UNPARSEABLE, THREADS_NOT_A_LIST]).size).toBe(3);
  });

  test("TR-12: an EMPTY list read off disk is MEASURED — a first round is not a failure", () => {
    expect(threadReadingFromJson("[]").status).toBe("MEASURED");
    expect(threadReadingFromJson("[]")).toEqual({ status: "MEASURED", threads: [] });
  });
});
