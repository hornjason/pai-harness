/**
 * A closing keyword GitHub will never act on (#1362).
 *
 * The live instance these cases are built from: PR #1208's body opens with the
 * keyword and `#1157` wrapped in backticks, the pull request merged, and
 * #1157 is still open while the same body says in prose that the work is done
 * and verified. `closingIssuesReferences` is empty.
 */

import { describe, expect, test } from "bun:test";
import {
  CLOSING_KEYWORDS,
  inertClosingMessage,
  inertClosingReferences,
} from "../lib/closing-reference-audit";

// The real shape, reduced to the two lines that matter. Built by string
// concatenation so the backticks that cause the defect are unambiguous in the
// source rather than fighting with a template literal.
const BACKTICKED = "Fixes #1157".replace(/^/, "`").replace(/$/, "`");
const PR_1208_BODY = `${BACKTICKED}\n\n## #1157 — no code change; already fixed on main, and verified here\n`;

describe("a closing keyword inside markup GitHub does not scan", () => {
  test("the live instance: a backticked keyword is reported", () => {
    const refs = inertClosingReferences(PR_1208_BODY);
    expect(refs.map(r => r.issue)).toEqual([1157]);
    expect(refs[0]!.reason).toBe("code-span");
    // The heading two lines down names the same issue with NO keyword, and
    // must not be read as a second occurrence.
    expect(refs).toHaveLength(1);
  });

  test("a fenced block swallows it too", () => {
    const body = "Here is what not to write:\n\n```\nFixes #42\n```\n";
    const refs = inertClosingReferences(body);
    expect(refs.map(r => r.issue)).toEqual([42]);
    expect(refs[0]!.reason).toBe("fenced-block");
  });

  test("a keyword in ordinary prose is NOT reported — it works, so it is not a finding", () => {
    // The control. Without it every case above is satisfied by a function
    // that reports every closing keyword it sees, which would fire on every
    // correctly written pull request in the repository.
    expect(inertClosingReferences("Fixes #1157\n")).toEqual([]);
    expect(inertClosingReferences("Closes #42 and resolves #43\n")).toEqual([]);
  });

  test("every documented keyword is recognised, and the list is the binding", () => {
    for (const kw of CLOSING_KEYWORDS) {
      const refs = inertClosingReferences("`" + kw + " #7`");
      expect(refs.map(r => r.issue), `${kw} should be recognised`).toEqual([7]);
    }
    // Something that is not a closing keyword must not be read as one.
    expect(inertClosingReferences("`addresses #7`")).toEqual([]);
    expect(inertClosingReferences("`see #7`")).toEqual([]);
  });
});

describe("the negations this repository actually writes", () => {
  // The negative control, pinned to the corpus rather than to an opinion about
  // it: these six lines are VERBATIM from merged pull request bodies on
  // hornjason/pai-harness, read at 2026-10-23T15:31Z and quoted character for
  // character. Loosening adjacency to "within 40 characters" over the same 65
  // merged pull requests fires on 21 candidates, 19 of them false; every line
  // below is one of those 19.
  const NEGATIONS = [
    // PR #1233
    "Fixes nothing automatically; #1167 stays open for its intent half.",
    // PR #1020
    "Closes nothing — #523 stays open, and the reason is in the last section.",
    // PR #1006
    "Fixes nothing on its own — leaving #713 open for SC-4 and SC-5.",
    // PR #976
    "Refs #910, #713. Neither issue is closed by this PR — #910 SC-5 and #713 SC-4/SC-5 are still open, for the reasons recorded on each.",
    // PR #1308 — prose about a DIFFERENT issue, not a denial about this one.
    "| #1281 | the count keyed on head branch NAME | fixed, merged as #1288 |",
    // PR #1236
    "Read, not fixed, and none made trivial by this: #1173, #1186, #1167, #1204. #1207 is already closed.",
  ];

  test("none of them is reported, in prose or in backticks", () => {
    for (const line of NEGATIONS) {
      expect(inertClosingReferences(line), line).toEqual([]);
      expect(inertClosingReferences("`" + line + "`"), "backticked: " + line).toEqual([]);
    }
  });

  test("a backticked keyword with no number beside it is not a reference", () => {
    // Verbatim from PR #1236, and the sharpest near-miss in the corpus: a
    // backticked number and a backticked keyword, in the same sentence, in
    // separate code spans. Everything this detector looks for is present
    // except the one thing it requires.
    const line = "so `Part of #1168` and not `Fixes`.";
    expect(inertClosingReferences(line)).toEqual([]);
  });

  test("a keyword bound to ONE number does not capture the next number", () => {
    // `Fixes #1237` followed by `#1226 stays open` — the real PR #1252 shape.
    // The keyword is live and belongs to 1237; 1226 is a bystander.
    const body = "`Fixes #1237`\n\n#1226 stays open: the tolerance is separate.\n";
    expect(inertClosingReferences(body).map(r => r.issue)).toEqual([1237]);
  });
});

describe("the report", () => {
  test("one issue named twice is one finding", () => {
    const body = "`Fixes #1157` and again `closes #1157`\n";
    expect(inertClosingReferences(body)).toHaveLength(1);
  });

  test("the message names the issue, the markup and the remedy", () => {
    const msg = inertClosingMessage(inertClosingReferences(PR_1208_BODY), 1208);
    expect(msg).toContain("#1157");
    expect(msg).toContain("code-span");
    expect(msg).toContain("closingIssuesReferences");
    // A check without a remedy is an obstacle — self-referential-tests.md.
    expect(msg).toContain("Remove the backticks");
  });
});
