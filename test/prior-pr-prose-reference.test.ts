/**
 * Covers AC-1, AC-2, AC-3, AC-4 (#687).
 *
 * A PR body is free text, and `detectExistingPR` matched a BARE NUMBER in it.
 * So a PR that merely mentioned another issue's branch name in a sentence
 * became that issue's prior work, and the issue could not be shipped until
 * that PR closed.
 *
 * Measured, not hypothesised. Ship run `wf_4b5a4d83-fa4` for issue #631
 * refused at SCOPE with:
 *
 *     PRIOR_WORK_OPEN_PR — Issue #631 already has open PR #686 on branch
 *     "fix/644-launch-base"
 *
 * PR #686 is #644's work: head ref `fix/644-launch-base`, title
 * `fix(#644): refuse a launch whose session cwd is not the tree it was
 * handed`, body referencing `#644` and no other issue. What matched was line
 * 42 of the body —
 *
 *     and projectRoot is on rungate/run-631 ...
 *
 * a sample refusal message quoted as evidence. `-` is a word boundary and so
 * is the end of the token, so `\b631\b` fired.
 *
 * `detectExistingPR`'s own comment names the hazard two lines above the
 * matcher: refusing on `pr.number` "is a false positive on the one path
 * where a false positive stops a correct run from ever starting". A
 * bare-number body reading is that same false positive, and it sat directly
 * beneath that sentence.
 *
 * The fix is two readings with two bounds. A head ref is an IDENTIFIER and
 * keeps the bare number — `209-deep-modules` carries no `#` and never will.
 * A title and a body are PROSE and must carry `#`, which every form this
 * repository produces already does: `Fixes #209`, which ship.js writes into
 * every body, and `fix(#209):`, which it writes into every subject.
 *
 * ── Mutation battery (AC-4), measured 2026-10-19 ────────────────────────
 *
 * Over the four files that read `lib/prior-branch.ts`:
 * `prior-pr-prose-reference`, `prior-work-detection`, `prior-branch-reference`,
 * `prior-branch`. Each mutant applied to the real source, not reconstructed.
 *
 *   row                                        predicted  measured
 *   BASELINE (unmutated)                            0/99      0/99
 *   M1  `prose(title)||prose(body)` → `refs(..)`    ≥1        4
 *   M2  prose bound `#N\b` → `#?N\b`               ≥1        7
 *   M3  `refs(c.branch)` → `prose(c.branch)`       ≥1        1
 *   M4  `refs(headRef)` → `prose(headRef)`         ≥1        4
 *   RESTORED                                        0/99      0/99
 *
 * M1 is the pre-#687 reading exactly, and it takes down AC-1's three cases
 * plus AC-4 — the defect reproduces. M2 is the near-miss that matters most:
 * making `#` optional in the prose bound collapses the two readings into
 * one, and AC-3 catches it as well as AC-1, which is why AC-3 exists.
 * M3 and M4 are the opposite error — narrowing the IDENTIFIER side — and
 * each is caught by a case that was already in the repo (#223's
 * "the name still wins when it has the number") plus AC-2's head-ref case.
 * No row scored zero, so no criterion here is satisfied by a detector that
 * matches nothing (`.claude/rules/checks-must-be-able-to-fail.md`).
 */

import { describe, expect, test } from "bun:test";

import {
  detectExistingPR,
  issueProseReference,
  issueReference,
} from "../lib/prior-branch";

/** A PR listing client, planted. Nothing here reaches the network. */
function fakeClient(prs: unknown[]) {
  return {
    rest: { pulls: { list: async () => ({ data: prs }) } },
  } as never;
}

/**
 * A PR that references issue 644 and nothing else, by every field.
 *
 * Built once and varied by exactly one field per case, so a case cannot pass
 * because two things changed (#585's pair discipline). The default carries NO
 * mention of 631 at all — each case plants the one it is about.
 */
const pr686 = (over: Record<string, unknown> = {}) => ({
  number: 686,
  title: "fix(#644): refuse a launch whose session cwd is not the tree it was handed",
  body: "Fixes #644.\n\nThe pin predates the run by three weeks.",
  head: { ref: "fix/644-launch-base" },
  ...over,
});

const find = (issueNumber: number, prs: unknown[]) =>
  detectExistingPR({ issueNumber, repo: "owner/repo", client: fakeClient(prs) });

// ── AC-1: the measured false positive ───────────────────────────────────

describe("AC-1: a PR quoting another issue's branch name is not its prior work", () => {
  test("AC-1: the run that was blocked — `rungate/run-631` in a body, no `#631`", async () => {
    // Verbatim from PR #686's body, line 42.
    const body =
      "Fixes #644.\n\n" +
      "Its live reading on the current state:\n" +
      "`DIFFERENT_CHECKOUT — cwd is on fix/661-waiver-and-mutation " +
      "and projectRoot is on rungate/run-631 ...`\n";

    // The fixture must really contain the thing, or the case passes without
    // the input — assert the premise before the conclusion.
    expect(body, "the fixture does not carry the string that matched").toContain(
      "rungate/run-631",
    );
    expect(body, "the fixture carries a real reference, so it is the wrong fixture")
      .not.toContain("#631");

    expect(
      await find(631, [pr686({ body })]),
      "a PR mentioning another issue's branch name blocked that issue's run",
    ).toBeNull();
  });

  test("AC-1: and the same prose in a TITLE is not a reference either", async () => {
    const title = "fix(#644): stop reporting rungate/run-631 as the caller's tree";
    expect(title).toContain("631");
    expect(title).not.toContain("#631");
    expect(await find(631, [pr686({ title })])).toBeNull();
  });

  test("AC-1: a bare number in prose with no branch around it is still not a reference", async () => {
    // The general form. A body is where people write line counts, SHA
    // prefixes, ports and durations.
    for (const body of [
      "Fixes #644. The suite reports 631 pass, 0 fail.",
      "Fixes #644. Took 631ms on the second run.",
      "Fixes #644. See 631-deep-modules, which is a different branch.",
    ]) {
      expect(await find(631, [pr686({ body })]), body).toBeNull();
    }
  });
});

// ── AC-2: everything that IS a reference still is ───────────────────────

describe("AC-2: every real reference is still found, by prose and by ref", () => {
  test("AC-2: `Fixes #631` in a body — the form ship.js writes into every PR", async () => {
    const found = await find(631, [pr686({ body: "Fixes #631.\n\nDetail." })]);
    expect(found, "the form the harness itself produces stopped matching").not.toBeNull();
    expect(found).toMatchObject({ prNumber: 686 });
  });

  test("AC-2: `fix(#631):` in a title — the form ship.js writes into every subject", async () => {
    const found = await find(631, [pr686({ title: "fix(#631): the reviewer reviews a tree" })]);
    expect(found).toMatchObject({ prNumber: 686 });
  });

  test("AC-2: a HEAD REF keeps the bare-number reading — no `#` anywhere", async () => {
    // The half that must NOT be narrowed. A ref is an identifier: every
    // branch this repo opens is `rungate/run-N`, `fix/N-slug` or
    // `N-deep-modules`, and none of them can carry a `#`.
    for (const ref of ["rungate/run-631", "fix/631-pr-reference", "631-deep-modules"]) {
      const found = await find(631, [
        // Title and body reference a DIFFERENT issue, so the ref is the only
        // thing that can match — the case cannot pass through another field.
        pr686({ head: { ref }, title: "fix(#644): x", body: "Fixes #644." }),
      ]);
      expect(found, `head ref ${ref} was not read as a reference`).toMatchObject({
        prNumber: 686,
        branch: ref,
      });
    }
  });

  test("AC-2: a harness branch name with no number at all still matches via the body", async () => {
    // #223's original case, which is why bodies are read in the first place.
    const found = await find(209, [
      pr686({
        number: 219,
        head: { ref: "worktree-wf_5e3ed885-98c-9" },
        title: "worktree wave 3",
        body: "Closes #209.\n\nDetail.",
      }),
    ]);
    expect(found).toMatchObject({ prNumber: 219 });
  });
});

// ── AC-3: two bindings, two bounds ──────────────────────────────────────

describe("AC-3: the identifier reading and the prose reading are separate bindings", () => {
  test("AC-3: the two disagree on exactly the input that caused #687", () => {
    // If they agreed everywhere, they would be one decider wearing two names
    // and a mutation of either would leave the other holding every case up
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). This
    // is the input only one of them accepts.
    expect(issueReference(631)("rungate/run-631")).toBe(true);
    expect(issueProseReference(631)("rungate/run-631")).toBe(false);

    // …and one they agree on, so the prose reading is not simply broken.
    expect(issueReference(631)("Fixes #631")).toBe(true);
    expect(issueProseReference(631)("Fixes #631")).toBe(true);
  });

  test("AC-3: the prose bound rejects a superset in both directions", () => {
    const p = issueProseReference(209);
    expect(p("#2091"), "a trailing digit made a longer number match").toBe(false);
    expect(p("#1209"), "a leading digit made a longer number match").toBe(false);
    expect(p("#209"), "the exact reference stopped matching").toBe(true);
    expect(p("(#209)"), "a parenthesised reference stopped matching").toBe(true);
    expect(p("fix(#209): x")).toBe(true);
  });

  test("AC-3: the prose predicate is total over non-strings", () => {
    // `pr.body` is `null` for a PR opened with an empty body, and a throw
    // there is a refusal the caller's error handling turns into a ship.
    const p = issueProseReference(209);
    for (const v of [null, undefined, 209, {}, []]) expect(p(v as never)).toBe(false);
  });

  test("AC-3: a bad issue number throws rather than never firing", () => {
    // Same reasoning as `issueReference`: a predicate that silently matches
    // nothing reads exactly like an issue with no prior work.
    for (const bad of [".*", "209", 1.5, -1, NaN, Infinity, null, undefined, {}]) {
      expect(() => issueProseReference(bad as never), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

// ── AC-4: the mutation, performed ───────────────────────────────────────

describe("AC-4: restoring the bare-number body reading turns AC-1 red", () => {
  test("AC-4: the pre-#687 reading reports PR #686 as issue 631's prior work", async () => {
    // The mutation is the OLD code, reconstructed at the one line that
    // changed: `prose(pr.body)` back to `refs(pr.body)`. Running it here
    // rather than describing it is what makes AC-1 a measurement — without
    // this, AC-1 is satisfied by a detector that matches nothing at all.
    const body =
      "Fixes #644.\n\nand projectRoot is on rungate/run-631 ...\n";

    const prs = [pr686({ body })];
    const refs = issueReference(631);
    const prose = issueProseReference(631);

    const preFix = prs.find((p: any) =>
      refs(p.head?.ref) || refs(p.title) || refs(p.body));
    const postFix = prs.find((p: any) =>
      refs(p.head?.ref) || prose(p.title) || prose(p.body));

    expect(
      preFix,
      "the mutant did not reproduce the defect — the fixture is not the one that failed",
    ).toBeDefined();
    expect((preFix as any).number).toBe(686);
    expect(postFix, "the real reading still refuses").toBeUndefined();

    // And the real detector agrees with the post-fix half, so the
    // reconstruction is faithful rather than merely plausible.
    expect(await find(631, prs)).toBeNull();
  });

  test("AC-4: the cheapest wrong fix — excluding the word `rungate/run-` — does not satisfy AC-1", () => {
    // Named per `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape.
    // What an operator sees is one branch name matching, so the 5pm repair is
    // to strip that one prefix before testing. It fixes this body and nothing
    // else: `631 pass, 0 fail` and `took 631ms` still match, and AC-1's third
    // case asserts both of those, so it stays red under that repair.
    const stripped = (text: string) => text.replace(/rungate\/run-\d+/g, "");
    const refs = issueReference(631);
    expect(refs(stripped("and projectRoot is on rungate/run-631 ..."))).toBe(false);
    expect(
      refs(stripped("The suite reports 631 pass, 0 fail.")),
      "the cheap repair would have satisfied AC-1 — it must not",
    ).toBe(true);
  });
});
