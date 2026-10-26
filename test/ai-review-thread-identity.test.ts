/**
 * A posted review thread carries the identity it was raised under.
 *
 * Increment 1's prerequisite, and the ACs at #1614 do not name it because it
 * is only visible once you try to write AC-1. AC-1 says the suppression gate
 * decides "already raised" from `pulls/{n}/comments` plus GraphQL
 * `isResolved` rather than from the ledger snapshot. To decide that, a thread
 * fetched from the API has to be reducible to the SAME key `carryKey`
 * produces for a fresh finding — and measured on `origin/main` at `aed22884`,
 * `threadBody` emits severity, summary and failure scenario and nothing else.
 * There is no key in a posted thread, so "is this finding already a thread"
 * is not a question the thread list can answer, at any amount of care in the
 * caller.
 *
 * The near-miss is matching on the rendered text. It works on the happy path
 * and that is exactly what makes it the wrong fix: a summary is prose written
 * by a model, it is re-wrapped by GitHub, and `checkoutLineText`'s docblock
 * already records what happens when two sides of a dedupe compute keys in
 * different namespaces — `kept: 1, suppressed: 0` on a planted exact repeat,
 * silently, forever.
 *
 * So the thread carries the key, in an HTML comment GitHub does not render.
 *
 * ## What was broken to prove each case can fail
 *
 * TI-1 goes red if the marker is not emitted at all (the state on `main`).
 * TI-2 goes red under the FIRST fix anybody writes — spelling the key into
 * the comment as raw text. A key whose line text contains `-->` closes the
 * comment early, and every assertion in TI-1 still passes, so TI-2 is the
 * only row that separates the encoded fix from the unencoded one.
 * TI-3 and TI-4 go red if a missing or corrupt marker is read as a key
 * instead of as an absence; both directions suppress a live finding.
 * TI-5 goes red if the writer and the reader stop agreeing on the marker.
 * TI-6 goes red if a caller that supplies no key still gets a marker, which
 * would make "no key recorded" and "key recorded" the same bytes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  reviewThreadRequests,
  threadBody,
  threadKeyFrom,
  type AiReviewFindingsReading,
} from "../lib/scaffold/ai-review-findings.ts";
import { AI_REVIEW_THREAD_KEY_MARKER } from "../lib/scaffold/ai-review-step.ts";
import { carryKey } from "../lib/ai-review-rounds.ts";
import { postReviewThreads } from "../lib/ai-review-threads.ts";

/** A finding of the shape the reviewer's payload actually carries. */
const FINDING = {
  severity: "Important",
  file: "lib/widget.ts",
  line: 42,
  summary: "the guard reads the wrong field",
  failure_scenario: "a fork pull request receives a write token",
};

/** A reading the thread producer will accept, holding exactly these findings. */
function reading(findings: unknown[]): AiReviewFindingsReading {
  return {
    outcome: "REPORTED",
    reported: findings,
    unlocatableReported: null,
  } as unknown as AiReviewFindingsReading;
}

describe("a posted thread carries the key it was raised under", () => {
  test("TI-1: the key in the body is byte-identical to carryKey, and the prose is untouched", () => {
    const lineText = "  if (event === 'workflow_dispatch') return true;";
    const key = carryKey(FINDING, lineText);
    expect(key, "the fixture must be keyable, or every row below is vacuous").not.toBeNull();

    const body = threadBody(FINDING, key);

    expect(
      threadKeyFrom(body),
      "a thread the gate cannot re-key is a thread it must re-post, which is the duplicate Increment 1 exists to stop",
    ).toBe(key!);

    // The marker must not have eaten the part a human reads. Without this,
    // TI-1 passes for an implementation that replaces the body with the key.
    expect(body.startsWith(threadBody(FINDING)), "the rendered prose must be unchanged").toBe(true);
    expect(body).toContain(FINDING.summary);
    expect(body).toContain(FINDING.failure_scenario);
  });

  test("TI-2: a cited line containing the comment terminator still round-trips", () => {
    // THE ROW THAT SEPARATES THE ENCODED FIX FROM THE UNENCODED ONE.
    // `carryKey` anchors on the TEXT at the cited line, and the cited line is
    // source code — in this repository, HTML comment terminators appear in
    // the generated-workflow sources and in every markdown emitter. Spelled
    // raw, this key closes its own comment and the reader recovers a prefix.
    const hostile = 'const close = "-->"; // and a > and a <!-- too';
    const key = carryKey(FINDING, hostile);
    expect(key).not.toBeNull();

    const body = threadBody(FINDING, key);
    expect(
      threadKeyFrom(body),
      "a key is arbitrary source text and must survive being carried in an HTML comment",
    ).toBe(key!);

    // And the encoding must actually be an encoding: the hostile text must
    // not appear raw. A reader could otherwise recover it by luck on this
    // input and not on the next one.
    expect(body, "the key must be encoded, not spelled").not.toContain(hostile);
  });

  test("TI-2b: a key containing a newline and a NUL round-trips", () => {
    // `carryKey` joins its three parts with \u0000, so EVERY key contains a
    // byte that cannot appear in a single-line marker. A multi-line cited
    // line is rarer but the NUL is universal — if this row is red, no key
    // round-trips and TI-1 was passing on a reader that re-derived rather
    // than recovered.
    const key = "lib/a.ts\u0000t:line one\nline two\u0000summary";
    expect(threadKeyFrom(threadBody(FINDING, key))).toBe(key);
  });

  test("TI-3: a body with no marker reads as ABSENT, not as a key", () => {
    expect(
      threadKeyFrom(threadBody(FINDING)),
      "a thread posted before this shipped has no key, and reading one out of it would suppress a live finding",
    ).toBeNull();
    expect(threadKeyFrom("")).toBeNull();
    expect(threadKeyFrom("**Important** — something"), "plain prose carries no key").toBeNull();
    expect(threadKeyFrom(undefined), "an unreadable body is not a key").toBeNull();
  });

  test("TI-4: a corrupt payload reads as ABSENT, and two corruptions never agree", () => {
    const truncated = `x\n\n<!-- ${AI_REVIEW_THREAD_KEY_MARKER} -->`;
    const notBase64 = `x\n\n<!-- ${AI_REVIEW_THREAD_KEY_MARKER} @@@not base64@@@ -->`;

    expect(threadKeyFrom(truncated), "a marker with no payload is not a key").toBeNull();
    expect(threadKeyFrom(notBase64), "a payload that is not the encoding is not a key").toBeNull();

    // The direction this is allowed to be wrong in is toward REPORTING. Two
    // different corruptions decoding to the same non-null string would make
    // every corrupt thread a repeat of every other corrupt thread.
    const both = [threadKeyFrom(truncated), threadKeyFrom(notBase64)];
    expect(both.filter(k => k !== null), "a corruption must never produce a key").toEqual([]);
  });

  test("TI-5: the writer and the reader agree on one declared marker", () => {
    const key = carryKey(FINDING, "x");
    const body = threadBody(FINDING, key);
    expect(
      body,
      "the marker is declared once in lib/scaffold/ai-review-step.ts; a second spelling is a second decider",
    ).toContain(AI_REVIEW_THREAD_KEY_MARKER);
  });

  test("TI-6: a caller that supplies no key gets no marker", () => {
    // `reviewThreadRequests` is reached by a consumer that has not
    // re-scaffolded. Emitting an empty marker there would make "this round
    // recorded no key" and "this round recorded a key" the same bytes, which
    // is the Silent Default Substitution `.claude/rules/config-access.md`
    // names.
    const without = reviewThreadRequests(reading([FINDING]));
    expect(without).toHaveLength(1);
    expect(without[0]!.body).not.toContain(AI_REVIEW_THREAD_KEY_MARKER);
    expect(threadKeyFrom(without[0]!.body)).toBeNull();

    const with_ = reviewThreadRequests(reading([FINDING]), f => carryKey(f, "some line text"));
    expect(with_).toHaveLength(1);
    expect(threadKeyFrom(with_[0]!.body)).toBe(carryKey(FINDING, "some line text")!);

    // The two bodies differ ONLY by the marker. If they differ elsewhere the
    // keyed path is posting different prose, and a human reading the two
    // threads would see two different findings.
    expect(with_[0]!.body.startsWith(without[0]!.body)).toBe(true);
  });

  test("TI-7: an unkeyable finding posts a thread with no marker rather than no thread", () => {
    // `carryKey` returns null for a finding with neither file nor summary.
    // The thread must still be posted — the direction of error is toward
    // reporting — and it must be honestly markerless.
    const bare = { severity: "Nit", file: "lib/widget.ts", line: 3 };
    const out = reviewThreadRequests(reading([bare]), f => carryKey(f, undefined));
    expect(out, "a finding that cannot be keyed is still a finding").toHaveLength(1);
    expect(threadKeyFrom(out[0]!.body)).not.toBeNull();

    const unkeyable = { severity: "Nit", file: "lib/widget.ts", line: 3 };
    const out2 = reviewThreadRequests(reading([unkeyable]), () => null);
    expect(out2).toHaveLength(1);
    expect(threadKeyFrom(out2[0]!.body), "null from keyFor means no marker").toBeNull();
  });
});

describe("the production path emits the key, not just the library", () => {
  test("TI-8: postReviewThreads posts a body the reader can re-key", async () => {
    // Asserted on the PAYLOAD THE POSTER RECEIVES, not on the function. A
    // parameter nothing passes is a flag with no reader, and the module
    // would look wired while every posted thread stayed unkeyed.
    const seen: { path: string; line: number | null; body: string }[] = [];
    const result = await postReviewThreads(
      reading([FINDING]),
      async r => {
        seen.push(r);
        return { ok: true };
      },
      f => carryKey(f, "the cited line"),
    );
    expect(result.posted, "the fixture must post, or the assertion below is vacuous").toBe(1);
    expect(seen).toHaveLength(1);
    expect(threadKeyFrom(seen[0]!.body)).toBe(carryKey(FINDING, "the cited line")!);
  });

  test("TI-9: the deployed command constructs a key, and keys it the way the gate does", () => {
    // `lib/` being correct is not the same statement as the shipped command
    // using it. This reads the source because the alternative is running a
    // CI entry point that needs a GitHub client.
    const src = readFileSync(join(import.meta.dir, "..", "scripts", "ai-review-threads.ts"), "utf8");
    expect(
      src.includes("postReviewThreads(reading, post)"),
      "the command must not call the unkeyed arity — that is the state this increment exists to leave",
    ).toBe(false);
    expect(src, "the command must form the key with the shared rule").toContain("carryKey");
    expect(
      src,
      "and anchor it on the SAME line text the suppression gate reads, or the two key in different namespaces",
    ).toContain("checkoutLineText");
  });
});
