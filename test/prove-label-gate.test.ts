/**
 * The close gate's label check, and the transport it was entangled with (#395).
 *
 * Covers SC-1416, SC-1417, SC-1418 of HARNESS-STANDARD.md.
 *
 * `gates/workflow.test.ts` read an issue's labels by shelling out to the
 * GitHub CLI. GITHUB-API-MIGRATION-SPEC.md's SC-502 forbids exactly that,
 * and SC-502 was TICKED over it for the criterion's whole life.
 *
 * How it survived is the point. The call put the exec on one line and the
 * command on the next, so every line-oriented search for it found nothing —
 * "a detector narrower than what it detects", the second shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. #327 classified SC-502
 * "satisfied, needs a test" on the strength of one of those searches. The
 * test it implied found the violation on its first run.
 *
 * SC-502 also carried a `(behavioral)` tag, which exempted it from every
 * mechanical check. A mechanical absence check wearing a behavioural tag is
 * the worst of both: nothing runs it, and its tick reads as proof. The tag
 * is removed in this change because the criterion is mechanically checkable
 * and always was.
 *
 * ## Why these cases use a stub and not the source text
 *
 * SC-4 of the issue asks for it by name, and the reason is this issue's own
 * history: a source-text search is exactly what could not see the call. So
 * the read is DRIVEN — against a fake Octokit — rather than asserted to
 * exist. `test/ticked-sc-cover.test.ts` keeps the absence scan; this keeps
 * the behaviour.
 */
import { describe, expect, test } from "bun:test";

import { getIssueLabels } from "../lib/github";
import { proveLabelViolation } from "../lib/prove-label-gate";

/** A fake Octokit that records what it was asked for. */
function stubClient(labels: unknown, seen: Record<string, unknown> = {}) {
  return {
    rest: {
      issues: {
        get: async (params: Record<string, unknown>) => {
          Object.assign(seen, params);
          return { data: { labels } };
        },
      },
    },
  } as never;
}

describe("SC-1416: labels are read through Octokit, with the inputs as arguments", () => {
  test("the owner, repo and issue number arrive as fields rather than a command", async () => {
    // The injection half of #395. Both values come out of workflow state and
    // used to be interpolated into a shell string; here they can only land
    // in named parameters, so there is no command line to break out of.
    const seen: Record<string, unknown> = {};
    await getIssueLabels(stubClient([{ name: "proven" }], seen), "hornjason/pai-harness", 395);
    expect(seen).toMatchObject({
      owner: "hornjason",
      repo: "pai-harness",
      issue_number: 395,
    });
  });

  test("a shell-shaped repo slug is refused outright", async () => {
    // Stronger than the old call could be, and stronger than this case was
    // first written to expect: `parseOwnerRepo` VALIDATES the slug rather
    // than passing it through to a parameter. Under the subprocess the same
    // text was concatenated into a command; here it never reaches the API.
    const seen: Record<string, unknown> = {};
    await expect(
      getIssueLabels(stubClient([], seen), "owner/repo; rm -rf /", 1),
    ).rejects.toThrow(/Invalid repo format/);
    expect(seen, "a malformed slug still reached the client").toEqual({});
  });

  test("a well-formed slug is NOT refused", async () => {
    // The positive control for the case above. A validator that rejected
    // everything would satisfy it and break every real call.
    await expect(
      getIssueLabels(stubClient([{ name: "x" }]), "owner/repo", 1),
    ).resolves.toEqual(["x"]);
  });

  test("label objects and bare strings both come back as names", async () => {
    // The API returns either shape. A reader that handled only one would
    // return an empty list for the other — and an empty list is indistinguishable
    // from an issue with no labels, so the gate would pass over a blocked issue.
    expect(
      await getIssueLabels(stubClient([{ name: "needs-prove" }, "proven"]), "o/r", 1),
    ).toEqual(["needs-prove", "proven"]);
  });

  test("a malformed labels payload yields no names rather than throwing", async () => {
    expect(await getIssueLabels(stubClient(null), "o/r", 1)).toEqual([]);
    expect(await getIssueLabels(stubClient([{}, 3, "", "ok"]), "o/r", 1)).toEqual(["ok"]);
  });
});

describe("SC-1417: the decision is one predicate over a list of names", () => {
  test("needs-prove without proven is refused, and the refusal says what to do", () => {
    const refusal = proveLabelViolation(["needs-prove", "bug"]);
    expect(refusal).toBeTruthy();
    expect(refusal, "the refusal does not name the step that clears it").toContain("/prove");
  });

  test("needs-prove WITH proven is allowed", () => {
    // The positive control. A predicate that refused whenever `needs-prove`
    // was present would satisfy the case above and block every proven issue.
    expect(proveLabelViolation(["needs-prove", "proven"])).toBeNull();
  });

  test("an issue carrying neither label is allowed", () => {
    expect(proveLabelViolation([])).toBeNull();
    expect(proveLabelViolation(["bug", "follow-up"])).toBeNull();
  });

  test("proven alone is allowed — it is not a requirement on its own", () => {
    expect(proveLabelViolation(["proven"])).toBeNull();
  });

  test("the match is exact, not a substring", () => {
    // `needs-proven` and `not-proven` are not these labels. A substring rule
    // would read `needs-proven` as both set and satisfied at once.
    expect(proveLabelViolation(["needs-proven"])).toBeNull();
    expect(proveLabelViolation(["needs-prove", "not-proven"])).toBeTruthy();
  });
});

describe("SC-1418: read and decision compose the way the gate uses them", () => {
  // No comma in this title on purpose: SC-1418 quotes it verbatim, and the
  // conformity parser splits an SC's token list on commas, so a comma here
  // would silently become two tokens neither of which appears in the file.
  test("a blocked issue - end to end from the API payload", async () => {
    // The two halves are separate so each can be mutated; this is the one
    // case that proves they still meet. Driving only the predicate would
    // leave a reader that returns [] looking exactly like a clean issue.
    const labels = await getIssueLabels(
      stubClient([{ name: "needs-prove" }, { name: "bug" }]),
      "o/r",
      1,
    );
    expect(proveLabelViolation(labels)).toBeTruthy();
  });

  test("a proven issue - end to end from the API payload", async () => {
    const labels = await getIssueLabels(
      stubClient([{ name: "needs-prove" }, { name: "proven" }]),
      "o/r",
      1,
    );
    expect(proveLabelViolation(labels)).toBeNull();
  });
});
