/**
 * Reading a goal and its criteria out of an issue body (#210, #202).
 *
 * Covers SC-1454, SC-1455, SC-1456, SC-1457, SC-1458 (HARNESS-STANDARD.md).
 *
 * Both defects were found by a human reading pipeline output before relaunching
 * a run. Neither was found by the suite, and neither could have been: the
 * extraction lived at module top level in `scripts/precompute-goal.ts`, so the
 * only way to exercise it was to run the whole script against a live `gh`.
 *
 * The cases below are the two measured readings plus the control that makes
 * each one mean something:
 *
 *  - #210's reading was an illustration inside a fenced block. The control is
 *    a real criterion OUTSIDE a fence in the same body — a stripper that
 *    blanked everything would satisfy the first and lose the second.
 *  - #202's reading was a harness-authored blockquote banner. The control is
 *    a blockquote the AUTHOR wrote — a parser that discarded every leading
 *    quote would satisfy the first and lose the goal of any issue that opens
 *    with one.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  stripCodeBlocks,
  successCriteriaSection,
  extractSuccessCriteria,
  extractGoal,
  isPlaceholder,
  HARNESS_BANNER_MARKERS,
  HARNESS_PREAMBLE_MARKERS,
  GOAL_REFUSE_EXIT,
  MIN_GOAL_CHARS,
} from "../lib/issue-extraction";

const REPO = join(import.meta.dir, "..");

/** #209's body, reduced to the shape that produced #210's reading. */
const FENCED_BODY = [
  "The marker extraction cannot detect a disabled guard, which is the defect.",
  "",
  "## Stage 3",
  "",
  "The proposed pattern looks like this:",
  "",
  "```",
  "- [ ] SC-N: `workflows/ship.js` executes [MARKER-NAME]",
  "```",
  "",
  "## Success Criteria",
  "",
  "- [ ] SC-700: lib/reachability.ts contains [assertMarkedBlockReachable] — the real one",
  "",
  "## Scope",
  "",
  "- [ ] ship the sub-issue as well",
].join("\n");

/** #200's body after run `wf_831f1294-088` rescoped it. */
const BANNERED_BODY = [
  "> **Rescoped to Phase 1 only.** This issue exceeded the 6-AC ship limit (7 ACs).",
  "> The governing spec has no phase headers, so the ACs were split sequentially.",
  ">",
  "> Sub-issues: #201 (Phase 2)",
  "",
  "Marker extraction cannot detect a disabled guard: wrapping the block in",
  "`if (false)` outside the markers leaves the extracted bytes byte-identical.",
  "",
  "## Success Criteria",
  "",
  "- [ ] SC-701: lib/reachability.ts contains [enclosing chain] — real",
].join("\n");

// ── SC-1454 ─────────────────────────────────────────────────────────────────

describe("SC-1454: a line inside a code fence is not a criterion", () => {
  test("the placeholder illustration that produced #210 is not extracted", () => {
    const got = extractSuccessCriteria(FENCED_BODY);
    expect(got.criteria.join(" "), "the fenced illustration became an AC again")
      .not.toContain("MARKER-NAME");
    // The control: the real criterion, outside the fence, IS extracted. A
    // stripper that blanked the whole body passes the line above for free.
    expect(got.criteria).toEqual([
      "SC-700: lib/reachability.ts contains [assertMarkedBlockReachable] — the real one",
    ]);
  });

  test("tildes fence too and a shorter run does not close a longer one", () => {
    const body = [
      "## Success Criteria",
      "",
      "~~~~",
      "- [ ] SC-N: fake",
      "~~~",
      "- [ ] SC-N: also fake",
      "~~~~",
      "- [ ] SC-800: real",
    ].join("\n");
    expect(extractSuccessCriteria(body).criteria).toEqual(["SC-800: real"]);
  });

  test("indented code is stripped but a nested checkbox is not", () => {
    const indented = ["## Success Criteria", "", "    - [ ] SC-N: fake", "", "- [ ] SC-9441: real"].join("\n");
    expect(extractSuccessCriteria(indented).criteria).toEqual(["SC-9441: real"]);

    // Four-space indentation is also how a nested checkbox is written. This
    // is the whole reason indented-code detection is list-aware: treating it
    // as code would delete real criteria to catch a rare fake one.
    const nested = ["## Success Criteria", "", "- [ ] SC-9442: parent", "    - [ ] SC-9443: child"].join("\n");
    expect(extractSuccessCriteria(nested).criteria).toEqual(["SC-9442: parent", "SC-9443: child"]);
  });

  test("stripping preserves line count so section boundaries do not move", () => {
    const before = FENCED_BODY.split("\n").length;
    expect(stripCodeBlocks(FENCED_BODY).split("\n").length).toBe(before);
  });
});

// ── SC-1455 ─────────────────────────────────────────────────────────────────

describe("SC-1455: criteria come from the Success Criteria section and nowhere else", () => {
  test("a checklist under another heading is not promoted", () => {
    const got = extractSuccessCriteria(FENCED_BODY);
    expect(got.criteria.join(" "), "the Scope checklist became an AC")
      .not.toContain("ship the sub-issue");
  });

  test("the section ends at the next heading of the same level and not before", () => {
    const body = [
      "## Success Criteria",
      "",
      "- [ ] SC-1: first",
      "",
      "### Phase 2",
      "",
      "- [ ] SC-2: still criteria",
      "",
      "## Acceptance",
      "",
      "- [ ] AC-1: not criteria",
    ].join("\n");
    expect(extractSuccessCriteria(body).criteria).toEqual(["SC-1: first", "SC-2: still criteria"]);
  });

  test("no section is an empty list that says so rather than a refusal", () => {
    // Most issues in this repo have no Success Criteria section, and
    // Discovery authoring the ACs is the designed path. Refusing here would
    // block the normal case to catch the abnormal one.
    const got = extractSuccessCriteria("Just a description.\n\n## Cause\n\n- [ ] not a criterion");
    expect(got.criteria).toEqual([]);
    expect(got.source).toBe("none");
    expect(got.refusal).toBeNull();
  });

  test("the SC prefix is not decorative - a bare checkbox under the heading still counts", () => {
    // The old pattern's `|.+` branch made every `- [ ]` line qualify anywhere
    // in the body. Section scoping is what replaced it; inside the section a
    // bare checkbox is a criterion the author wrote on purpose.
    expect(extractSuccessCriteria("## Success Criteria\n\n- [ ] the thing works end to end").criteria)
      .toEqual(["the thing works end to end"]);
  });

  test("the fixture this repo already ships still reads four criteria", () => {
    const fixture = JSON.parse(
      readFileSync(join(REPO, "test", "fixtures", "github", "issue-48.json"), "utf-8"),
    );
    const body = (Array.isArray(fixture) ? fixture[0] : fixture).body as string;
    expect(extractSuccessCriteria(body).criteria.length).toBeGreaterThanOrEqual(4);
  });
});

// ── SC-1456 ─────────────────────────────────────────────────────────────────

describe("SC-1456: an acceptance list made of placeholders refuses", () => {
  test("the exact #210 reading refuses rather than returning", () => {
    const body = "## Success Criteria\n\n- [ ] SC-N: `workflows/ship.js` executes [MARKER-NAME]";
    const got = extractSuccessCriteria(body);
    expect(got.criteria).toEqual([]);
    expect(got.refusal, "a list of placeholders was briefed as acceptance criteria").toMatch(/placeholder/i);
  });

  test("a real criterion beside a placeholder is kept, because refusing all of them loses work", () => {
    const body = [
      "## Success Criteria",
      "",
      "- [ ] SC-N: template",
      "- [ ] SC-702: lib/x.ts contains [a real token] — real",
    ].join("\n");
    const got = extractSuccessCriteria(body);
    expect(got.refusal).toBeNull();
    expect(got.criteria.length).toBe(2);
  });

  test("the placeholder predicate separates notation from prose", () => {
    expect(isPlaceholder("SC-N: anything")).toBe(true);
    expect(isPlaceholder("executes [MARKER-NAME]")).toBe(true);
    expect(isPlaceholder("replace <the thing> here")).toBe(true);
    expect(isPlaceholder("TBD")).toBe(true);
    // Controls. A predicate that returned true for everything would satisfy
    // every case above and refuse every real issue.
    expect(isPlaceholder("SC-702: lib/x.ts contains [assertMarkedBlockReachable]")).toBe(false);
    expect(isPlaceholder("SC-A1: no file outside lib/ reads the config")).toBe(false);
    expect(isPlaceholder("the <strong>tag</strong> renders")).toBe(false);
  });
});

// ── SC-1457 ─────────────────────────────────────────────────────────────────

describe("SC-1457: the rescope banner is not the goal and a blockquote the author wrote is kept", () => {
  test("#200's bannered body yields the defect description, not the split", () => {
    const got = extractGoal(BANNERED_BODY, "some title");
    expect(got.skippedBanner).toBe(true);
    expect(got.goal, "the banner is still the goal").not.toContain("Rescoped to Phase");
    expect(got.goal).toContain("Marker extraction cannot detect a disabled guard");
  });

  test("an author's own opening blockquote is kept", () => {
    // The positive control, and the reason the markers exist. A parser that
    // discarded every leading blockquote passes the case above for free.
    const body = [
      "> The scaffold cannot produce this state, which is the whole problem.",
      "",
      "## Cause",
      "",
      "something",
    ].join("\n");
    const got = extractGoal(body, "t");
    expect(got.skippedBanner).toBe(false);
    expect(got.goal).toContain("The scaffold cannot produce this state");
  });

  test("a sub-issue's Parent line is front matter and not the goal", () => {
    // Found by this change, not reported. `issue-48.json` is a sub-issue, its
    // body opens with `Parent: #47`, and the old regex took the first
    // paragraph — so EVERY decomposed run has briefed its agent with eleven
    // characters of cross-reference as the problem statement.
    const fixture = JSON.parse(
      readFileSync(join(REPO, "test", "fixtures", "github", "issue-48.json"), "utf-8"),
    );
    const body = (Array.isArray(fixture) ? fixture[0] : fixture).body as string;
    const got = extractGoal(body, "t");
    expect(got.goal, "the Parent line is still the goal").not.toBe("Parent: #47");
    expect(got.goal).toContain("Replace `read-issue`");
  });

  test("prose that opens with a front-matter word is kept", () => {
    // The control for the paragraph above. A skipper matching any line that
    // starts with "Spec: " would pass it and eat a real goal.
    const body =
      "Spec: the contract says the gate refuses, and it does not — the reading is\n" +
      "discarded by a catch block that converts the throw back into a null.\n\n## Cause\n\nx";
    const got = extractGoal(body, "t");
    expect(got.goal).toContain("the contract says the gate refuses");
  });

  test("a single long line opening with a front-matter word is prose", () => {
    // The multi-line control above is saved by the every-line rule, not by
    // the length limit — measured: removing the limit scored ZERO against
    // this file until this case existed. A one-line paragraph is the only
    // shape where the length is what decides, and it is a shape an author
    // writes.
    const body =
      "Spec: the contract in HARNESS-STANDARD says the gate refuses on an absent " +
      "reading, and gates/gate-executor.ts returns zero instead, so a run with no " +
      "measurement is indistinguishable from a clean one.\n\n## Cause\n\nx";
    const got = extractGoal(body, "t");
    expect(got.goal, "a long prose line was eaten as front matter").toContain("HARNESS-STANDARD");
    expect(got.skippedBanner).toBe(false);
  });

  test("the markers are the ones ship.js tells the agent to write", () => {
    // "Fails loudly here rather than silently returning it as the goal": the
    // banner is written by an agent instructed with this wording, so changing
    // the instruction without changing the marker list turns this red instead
    // of quietly handing the banner back.
    const ship = readFileSync(join(REPO, "workflows", "ship.js"), "utf-8");
    for (const marker of [...HARNESS_BANNER_MARKERS, ...HARNESS_PREAMBLE_MARKERS]) {
      expect(ship, `ship.js no longer writes ${JSON.stringify(marker)}`).toContain(marker);
    }
  });
});

// ── SC-1458 ─────────────────────────────────────────────────────────────────

describe("SC-1458: a goal that is only metadata refuses instead of returning the title", () => {
  test("a body that is nothing but a banner refuses", () => {
    const got = extractGoal("> **Rescoped to Phase 1 only.**\n>\n> Sub-issues: #201", "a title");
    expect(got.goal).toBeNull();
    expect(got.refusal, "the title was handed back as a problem statement").toMatch(/goal/i);
  });

  test("a goal under the minimum refuses and says how short it was", () => {
    const got = extractGoal("Broken.\n\n## Cause\n\nx", "t");
    expect(got.goal).toBeNull();
    expect(got.refusal).toContain(String(MIN_GOAL_CHARS));
    expect(got.refusal).toContain("Broken.");
  });

  test("the refusal exit is one constant and is not the usage exit", () => {
    // Routed through one site so a mutant can zero it, per
    // .claude/rules/checks-must-be-able-to-fail.md. Not 1: that is the
    // missing-arguments exit, and a caller that cannot tell "you called me
    // wrong" from "this issue cannot be read" learns nothing from either.
    expect(GOAL_REFUSE_EXIT).not.toBe(0);
    expect(GOAL_REFUSE_EXIT).not.toBe(1);
    const script = readFileSync(join(REPO, "scripts", "precompute-goal.ts"), "utf-8");
    expect((script.match(/process\.exit\(GOAL_REFUSE_EXIT\)/g) || []).length).toBe(2);
    expect(script, "a second refusal path would survive the mutation")
      .not.toMatch(/process\.exit\(3\)/);
  });
});
