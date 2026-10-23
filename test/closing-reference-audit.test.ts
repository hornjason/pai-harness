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
  // Measured over all 46 open issues on 2026-10-23: loosening adjacency to
  // "within 40 characters" produced eight candidates and every one was a
  // negation. These are the real strings, so the precision is pinned to the
  // corpus rather than to an opinion about it.
  const NEGATIONS = [
    "Closes nothing — #523 stays open until the dry-run lands.",
    "Fixes nothing on its own — leaving #713 open deliberately.",
    "Fixes nothing automatically; #1167 stays open.",
    "Read, not fixed, and none made trivial by this: #1173, #1186.",
    "**filed, not fixed here** (#1211), because the predicate is elsewhere.",
    "| #1290 | the reviewer is sampled | fixed, merged as #1288 |",
  ];

  test("none of them is reported, in prose or in backticks", () => {
    for (const line of NEGATIONS) {
      expect(inertClosingReferences(line), line).toEqual([]);
      expect(inertClosingReferences("`" + line + "`"), "backticked: " + line).toEqual([]);
    }
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
