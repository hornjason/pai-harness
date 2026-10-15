/**
 * #433 — `issueReference` matched digits inside generated run ids.
 *
 * Covers SC-1499, SC-1500 (HARNESS-STANDARD.md).
 *
 * The bound was `[^\d]`, which is right about the case it was written for —
 * `55` must not match `550` — and wrong about the case this repo actually
 * generates. Fan-out worktrees are branches named `worktree-wf_<runid>-<n>`
 * with a hex run id, and in `worktree-wf_55baa4aa-a00-9` the `55` is
 * preceded by `_` and followed by `b`. Both are non-digits, so it matched,
 * and `detectPriorBranch` reported a stranger's abandoned worktree as issue
 * 55's prior work. There were 149 such branches when this was found.
 *
 * It surfaced as `test/prior-branch.test.ts` passing locally and failing in
 * CI on a PR that touched neither that file nor anything it imports, because
 * that test asks the LIVE repository which branches exist and asserts on
 * whichever one wins. Its verdict was a property of the week. Everything
 * here is stated instead.
 */

import { describe, expect, test } from "bun:test";

import { issueReference } from "../lib/prior-branch";

describe("SC-1499: a digit run inside a generated id is not an issue reference", () => {
  test.each([
    // The branch that broke CI, and its shape generally.
    [55, "worktree-wf_55baa4aa-a00-9"],
    [55, "worktree-wf_a55f0000-1"],
    // The case the original bound existed for. Still rejected.
    [55, "550-matcher-registry"],
    [515, "5150"],
    [5, "worktree-wf_24377f41-275-20"],
  ])("issue %i does not match %s", (n, text) => {
    expect(issueReference(n)(text)).toBe(false);
  });
});

describe("SC-1500: the residual limit, stated rather than assumed away", () => {
  test("the fan-out INDEX is still indistinguishable from an issue reference", () => {
    // `worktree-wf_<hex>-<n>` ends in the fan-out index, delimited by
    // hyphens — a bare decimal number in exactly the position a real
    // reference occupies. No rule about neighbouring characters can tell
    // `...-0be-16` from `fix/16`, and inventing one would reject real
    // branches. This is a limit of the matcher, so it is pinned here rather
    // than left for someone to rediscover: the fix belongs in which
    // candidates `detectPriorBranch` considers, not in what counts as a
    // reference. Low issue numbers only — the index is bounded by the
    // fan-out width.
    expect(issueReference(16)("worktree-wf_be8d195f-0be-16")).toBe(true);
  });
});

describe("SC-1500: every form a real reference takes still matches", () => {
  // #223's docblock names three spellings and they are the reason the bound
  // cannot simply be "surrounded by punctuation". Widening the bound to hex
  // is only safe because each of these separates the number with a character
  // that is not a hex digit and not an underscore — asserted, not assumed.
  test.each([
    [55, "55-real"],
    [55, "fix/55"],
    [55, "run/55-rescue"],
    [55, "Closes #55"],
    [55, "fix(#55): the subject ship.js writes"],
    [209, "209-deep-modules"],
    [209, "Closes #209"],
    [209, "fix(#209): thing"],
    [1, "#1"],
    [1, "1"],
  ])("issue %i matches %s", (n, text) => {
    expect(issueReference(n)(text)).toBe(true);
  });

  test("the predicate is total over non-strings", () => {
    // `pr.body` is null for a PR opened with an empty body, and a throw
    // there is a refusal the caller's error handling turns into a ship.
    const m = issueReference(55);
    for (const v of [null, undefined, 55, {}, []]) expect(m(v)).toBe(false);
  });

  test("a non-integer issue number throws rather than never matching", () => {
    // A matcher that silently never fires reads exactly like an issue with
    // no prior work — the vacuous assertion
    // `.claude/rules/checks-must-be-able-to-fail.md` is about.
    expect(() => issueReference(NaN)).toThrow(TypeError);
    expect(() => issueReference(-1)).toThrow(TypeError);
    expect(() => issueReference(1.5)).toThrow(TypeError);
  });

  test("the issue number is not interpolated as a pattern", () => {
    // It is built into a RegExp, so a caller reaching here with `".*"` off a
    // workflow arg or a JSON reply would match every PR in the repo.
    expect(() => issueReference(".*" as unknown as number)).toThrow(TypeError);
  });
});
