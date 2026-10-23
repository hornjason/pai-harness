/**
 * The reviewer is told which paths it is reading the BASE copy of (#1449).
 *
 * Covers AC-RP1..AC-RP4, CRC-M11 (specs/CODE-REVIEW-CONVERGENCE-SPEC.md) by
 * removing a standing contributor to rounds-to-pass.
 *
 * ## The defect, measured twice on one pull request
 *
 * `ai-review.yml`'s *"Restore untrusted paths from the pull request base"*
 * step deletes twelve paths from the checkout and restores the base branch's
 * copy before the reviewer runs. `.claude` is one of them. So a pull request
 * editing `.claude/rules/*` hands the reviewer a diff that makes the edit and
 * a working tree that does not, and *"claimed but not done"* is the correct
 * inference from that evidence.
 *
 * PR #1430 was blocked by exactly that, twice, differently worded. Attempt 2
 * gave away the mechanism in its own text: *"the row ON DISK still lists only
 * the three original tests."* The reviewer looked, and reported what it saw.
 *
 * The restore is right and stays — it is what stops a pull request editing
 * the agent rules its own reviewer runs under. What was missing is that the
 * prompt explained the restore for `AI_REVIEW_CONVENTIONS_FILE` and for none
 * of the other eleven paths.
 *
 * ## Why this is a throughput test and not a correctness one
 *
 * A false blocking finding is a whole extra review round, and this one fires
 * on the class of pull request that carries this repository's conventions.
 * The first reading CRC-M11 was able to take put mean rounds-to-pass at
 * **2.64** against a target of 1.32 — worse than the 2.08 the source was
 * improving from. A deterministic artefact on a common PR shape is the
 * cheapest thing on that number to remove.
 *
 * ## The two readings are of the GENERATED file, on purpose
 *
 * Both the restore loop and the prompt interpolate
 * `AI_REVIEW_UNTRUSTED_PATHS`, so asserting the constant against itself would
 * be two readings of one value agreeing by construction —
 * `.claude/rules/checks-must-be-able-to-fail.md`, *two deciders*. These cases
 * read the EMITTED workflow instead: the `for path in …` list is parsed back
 * out of the step's shell, the prompt is taken from the action's `with:` as
 * the agent receives it after YAML block-scalar folding, and the two strings
 * are compared. A hand-edit to either, or a prompt that stops interpolating,
 * reddens this.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, test } from "bun:test";

import {
  AI_REVIEW_CONVENTIONS_FILE,
  AI_REVIEW_UNTRUSTED_PATHS,
  buildReviewPrompt,
} from "../lib/scaffold/ai-review-step.ts";

/**
 * The prompt as `anthropics/claude-code-action` receives it, after the YAML
 * block scalar has folded and re-emitted it.
 *
 * `ai-review-verdict-contract.test.ts` exports an identical reader and this
 * does NOT import it: importing a `.test.ts` file executes its suites, so
 * fifteen unrelated cases would run inside this file's result and a failure
 * in either would be reported against both. Nine lines of duplication is the
 * cheaper of the two, and both readers are over the same committed artefact
 * so they cannot disagree about it silently.
 *
 * `null` on every way the read can fail, and every case REFUSES on `null`
 * rather than treating it as "nothing wrong found".
 */
function promptAsReceived(workflowText: string): string | null {
  let doc: any;
  try {
    doc = Bun.YAML.parse(workflowText);
  } catch {
    return null;
  }
  const steps = doc?.jobs?.["ai-review"]?.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const prompt = step?.with?.prompt;
    if (typeof prompt === "string" && prompt.length > 0) return prompt;
  }
  return null;
}

/**
 * The COMMITTED workflow, which is the subject — not the constant, and not a
 * regeneration. `ai-review-surface-census.test.ts` AC-12 already binds this
 * file to the generator's output byte for byte, so reading the committed copy
 * here asserts the shipped artefact without re-deriving that agreement.
 */
const workflow = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "ai-review.yml"),
  "utf-8",
);

/**
 * The paths the RESTORE LOOP actually iterates, read back out of the emitted
 * shell rather than out of the constant that produced it.
 *
 * `null` on any failure to find the loop, and every case refuses on `null`.
 * A reader that returned `[]` for "I could not find the loop" would make
 * every comparison below pass vacuously, which is the shape this whole file
 * exists to avoid.
 */
/**
 * The string that locates the restore loop. One binding, so AC-RP1's
 * uniqueness assertion and this parser cannot drift apart — two spellings of
 * the anchor would let the count be taken over a string nobody parses.
 */
const RESTORE_LOOP_ANCHOR = "for path in ";

function restoredPathsInWorkflow(text: string): string[] | null {
  const at = text.indexOf(RESTORE_LOOP_ANCHOR);
  if (at === -1) return null;
  const line = text.slice(at, text.indexOf("\n", at));
  const quoted = line.match(/'([^']+)'/g);
  if (quoted === null || quoted.length === 0) return null;
  return quoted.map(q => q.slice(1, -1));
}

describe("AC-RP1 (#1449): the reviewer is told which paths it holds the base copy of", () => {
  test("AC-RP1: the instrument found a real loop and a real prompt", () => {
    // The control, first and separately. Both readers return null rather
    // than empty on failure, and every case below would pass against an
    // empty list — so this is the row that says the others measured
    // something. #1449's own finding was a reviewer reporting confidently
    // about a file it could not see; a test doing the same would be worse.
    const paths = restoredPathsInWorkflow(workflow);
    expect(paths, "the restore loop was not found in the emitted workflow").not.toBeNull();
    expect(paths!.length).toBeGreaterThan(1);
    expect(promptAsReceived(workflow), "the prompt was not found in the action step").not.toBeNull();
    // And that the parser bound the loop it MEANT to. `restoredPathsInWorkflow`
    // locates by first occurrence, so a second `for path in ` emitted earlier
    // would silently retarget every case in this file onto the wrong loop and
    // all of them would keep passing — an instrument that stopped reporting
    // without saying so, which is the shape this file exists to prevent
    // (#1460). The other restore loops in the workflow spell it `for u in`,
    // so this is one today; nothing but this line keeps it one.
    expect(
      workflow.split(RESTORE_LOOP_ANCHOR).length - 1,
      `${JSON.stringify(RESTORE_LOOP_ANCHOR)} must occur exactly once — the parser takes the ` +
        "FIRST, so a second loop would retarget every case below while they all stayed green",
    ).toBe(1);
  });

  test.each([...AI_REVIEW_UNTRUSTED_PATHS])(
    "AC-RP2: the prompt names %s, which the restore reverts",
    path => {
      const prompt = promptAsReceived(workflow);
      if (prompt === null) throw new Error("no prompt in the emitted workflow");
      expect(
        prompt.includes(path),
        `the restore loop reverts ${path} and the prompt never names it, so a pull ` +
          `request editing it draws a finding that the working tree disagrees with the diff`,
      ).toBe(true);
    },
  );

  test("AC-RP3: the loop and the prompt agree in BOTH directions", () => {
    // A path the loop reverts and the prompt omits is the #1430 bug. A path
    // the prompt excuses and the loop does NOT revert is the opposite and is
    // worse: it tells the reviewer to disregard the working tree for a file
    // whose working tree is this pull request's, which licenses ignoring a
    // real discrepancy. Equality, so neither can drift.
    const paths = restoredPathsInWorkflow(workflow);
    const prompt = promptAsReceived(workflow);
    if (paths === null || prompt === null) throw new Error("instrument failed; see AC-RP1");
    expect(paths.slice().sort()).toEqual([...AI_REVIEW_UNTRUSTED_PATHS].slice().sort());
    expect(paths.filter(p => !prompt.includes(p)), "reverted and unexplained").toEqual([]);
  });

  test("AC-RP4: the prompt says the DIFF wins, not merely that a restore happened", () => {
    // Naming the paths is not the fix on its own. A reviewer told "these are
    // restored" and nothing else can still conclude the author failed to make
    // the change — that is a true statement about the mechanism that does not
    // answer the question the reviewer is about to get wrong. The instruction
    // has to be what to DO.
    const prompt = promptAsReceived(workflow);
    if (prompt === null) throw new Error("no prompt in the emitted workflow");
    expect(prompt).toContain("THE DIFF IS AUTHORITATIVE");
    expect(prompt, "the prompt does not say a tree/diff disagreement is not a finding").toMatch(
      /not .{0,40}raise a finding|is not a finding/i,
    );
    // And the negative half: everywhere else the tree still counts. Without
    // this sentence the paragraph reads as a general licence to ignore the
    // checkout, which is a wider instruction than the defect warrants.
    expect(prompt).toMatch(/Everywhere else .{0,80}working tree IS this pull request/s);
  });

  test("AC-RP5: the conventions file keeps its own, different explanation", () => {
    // `REVIEW.md` is restored for the same reason and is told something
    // extra — that it is SAFE TO FOLLOW. The new paragraph must not have
    // replaced that: "ignore the tree for this path" and "obey this file"
    // are different instructions and the conventions file needs both.
    const prompt = promptAsReceived(workflow);
    if (prompt === null) throw new Error("no prompt in the emitted workflow");
    expect(prompt).toContain(AI_REVIEW_CONVENTIONS_FILE);
    expect(prompt, "the conventions file lost its safe-to-follow framing").toContain(
      "It is safe to follow",
    );
  });

  test("AC-RP6: the shipped prompt is the generator's, so the rows above bind the artefact", () => {
    // `buildReviewPrompt()` is what the cases would read if `shippedPrompt`
    // ever stopped resolving. Asserting the emitted one CONTAINS the built
    // one keeps the subject the artefact while naming the generator that
    // owns it — a prompt that stopped interpolating the paths would fail
    // here and in AC-RP2, and a YAML fold that mangled it would fail only
    // here, which is the distinction worth keeping.
    //
    // That last clause used to be a claim this row could not support (#1460).
    // It asserted `prompt.length >= built.length - 200`, which no mutation in
    // #1452's battery ever reached — every red came from the `includes` loop
    // above — and which a fold truncating 199 characters passes. 199
    // characters is most of a paragraph, so the line that was supposed to
    // catch a mangled fold was the one line here that could not fail.
    //
    // Containment is the honest version, and it is taken over whitespace-
    // NORMALISED text rather than raw. A YAML block scalar legitimately
    // re-indents and re-wraps; that is formatting, not mangling, and a raw
    // `includes` would redden on it. Collapsing whitespace runs leaves
    // exactly the difference that matters: dropped or reordered words.
    const prompt = promptAsReceived(workflow);
    if (prompt === null) throw new Error("no prompt in the emitted workflow");
    const built = buildReviewPrompt();
    for (const path of AI_REVIEW_UNTRUSTED_PATHS) {
      expect(built.includes(path), `buildReviewPrompt() omits ${path}`).toBe(true);
    }
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(
      squash(prompt).includes(squash(built)),
      "the emitted prompt does not contain the generator's output word for word (whitespace " +
        "aside), so the YAML step dropped or reordered part of it and the rows above are " +
        "binding a prompt the reviewer does not receive",
    ).toBe(true);
  });
});
