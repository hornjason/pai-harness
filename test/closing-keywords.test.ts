/**
 * #590 — what GitHub will close when a session record becomes a PR.
 *
 * PR #588's squash commit carried the line `Filed and not fixed: #586`,
 * rendered from `project-state.json`'s session-49 summary. GitHub's
 * closing-keyword parser reads `fixed: #586` and has no concept of the `not`
 * in front of it, so #586 closed one second after the merge with
 * `stateReason: COMPLETED`, having shipped nothing.
 *
 * This is the second instance of the shape. `lib/issue-closure-audit.ts` says
 * so in its own docstring: on 2026-10-08 a commit body reading "not yet
 * fixed: #178" auto-closed #178, and that audit deliberately does NOT catch
 * it — a close with a `commit_id` is attributable, and attribution is what it
 * asks about. So nothing in this repo looks at the question these cases share:
 * *does the text we are about to push close an issue we did not mean to
 * close?*
 *
 * "Filed and not fixed" is the phrase this project uses for deliberately
 * deferred work, which is what makes it dangerous rather than unlucky: the
 * more honest the session record, the more issues it wrongly closes.
 *
 * The detector lives in `scripts/check-state-record-closes.ts` rather than
 * `lib/` for the reason `scripts/rook-review-scope.ts` gives — the mutation
 * in `test/state-record-closes-mutation.test.ts` runs a copy of the script
 * from a temp directory, and a relative import would make every mutant die on
 * module resolution rather than on the merits.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLOSING_KEYWORDS,
  StateCloseRefused,
  closingReferences,
  parseDeclaredCloses,
  stateRecordCloseViolations,
} from "../scripts/check-state-record-closes";

const ROOT = join(import.meta.dir, "..");

/** The repository the form table is written against. */
const TABLE_REPO = "hornjason/pai-harness";

/** The session-49 clause, verbatim from `project-state.json`. */
const SESSION_49_CLAUSE =
  "`testable:` was read as === \"true\", so `yes` meant false. " +
  "Filed and not fixed: #586, where a scaffold run rewrites spec criteria text";

/**
 * The other `fixed` in the same summary, which must NOT be read as a close.
 *
 * It is the control the table needs most: a session summary is full of the
 * word "fixed", and a detector that read this one would refuse every honest
 * record and be switched off inside a week.
 */
const SESSION_49_NON_CLAUSE =
  "every scaffold run fetched an undeclared tool from the npm registry because " +
  "lib/conformity.ts fixed that for itself in #510 and never told scripts/generate-code-map.ts";

/**
 * The shape of the commit message PR #588 actually pushed: a declared closure
 * written the way the record writes them (`#582 closed #508`), and the
 * deferral clause beside it.
 */
const SESSION_49_MESSAGE =
  `docs: record session 49 — #582 closed #508: HYGIENE-6's body was expect(true). ` +
  SESSION_49_CLAUSE;

// ── The form table ────────────────────────────────────────────────────────
//
// Each row is a reference FORM and the issues GitHub closes from it in
// TABLE_REPO. `.claude/rules/checks-must-be-able-to-fail.md` calls the
// failure this guards against "a detector narrower than what it detects", and
// the remedy it prescribes is to assert on the detector's view of the input —
// so the table carries both matching and non-matching forms, and a row whose
// expectation is `[]` is as load-bearing as one that closes.

interface FormRow {
  /** Begins `FORM:` — the marker AC-3 counts, one per distinct form. */
  name: string;
  text: string;
  /** Issue numbers GitHub would close in TABLE_REPO. */
  closes: number[];
}

const FORM_TABLE: FormRow[] = [
  // The nine keywords, one row each. GitHub documents exactly these; an
  // inflection outside the nine is not a keyword, which rows 23 and 24 pin.
  { name: "FORM: `Close #586` — the bare stem", text: "Close #586", closes: [586] },
  { name: "FORM: `Closes #586` — third person", text: "Closes #586", closes: [586] },
  { name: "FORM: `Closed #586` — past tense", text: "Closed #586", closes: [586] },
  { name: "FORM: `Fix #586` — the bare stem", text: "Fix #586", closes: [586] },
  { name: "FORM: `Fixes #586` — third person", text: "Fixes #586", closes: [586] },
  { name: "FORM: `Fixed #586` — past tense", text: "Fixed #586", closes: [586] },
  { name: "FORM: `Resolve #586` — the bare stem", text: "Resolve #586", closes: [586] },
  { name: "FORM: `Resolves #586` — third person", text: "Resolves #586", closes: [586] },
  { name: "FORM: `Resolved #586` — past tense", text: "Resolved #586", closes: [586] },

  // Spacing, punctuation and case. The colon is the form that shipped the
  // defect, so it is here twice — spaced and unspaced.
  { name: "FORM: `fixed: #586` — a colon between keyword and reference", text: "fixed: #586", closes: [586] },
  { name: "FORM: `fixes:#586` — a colon with no space", text: "fixes:#586", closes: [586] },
  { name: "FORM: `FIXES #586` — upper case", text: "FIXES #586", closes: [586] },
  { name: "FORM: `fix    #586` — repeated spaces", text: "fix    #586", closes: [586] },
  { name: "FORM: `Fixes #586.` — trailing sentence punctuation", text: "Fixes #586.", closes: [586] },
  { name: "FORM: `(closes #586)` — inside parentheses", text: "a note (closes #586) in passing", closes: [586] },
  {
    name: "FORM: `Filed and not fixed: #586` — a negation GitHub does not read",
    text: SESSION_49_CLAUSE,
    closes: [586],
  },

  // Qualified references.
  {
    name: "FORM: `fixes hornjason/pai-harness#586` — this repo, named",
    text: "fixes hornjason/pai-harness#586",
    closes: [586],
  },
  {
    name: "FORM: `closes https://github.com/hornjason/pai-harness/issues/586` — the URL form",
    text: "closes https://github.com/hornjason/pai-harness/issues/586",
    closes: [586],
  },
  {
    name: "FORM: `fixes other-owner/other-repo#586` — a different repository",
    text: "fixes other-owner/other-repo#586",
    closes: [],
  },

  // The non-closing half. Every one of these appears in ordinary session
  // prose, and a detector that flagged any of them would be worse than none.
  { name: "FORM: `#586` — a reference with no keyword", text: "see #586 for the detail", closes: [] },
  {
    name: "FORM: `Fixes #585 and #586` — the keyword binds to one reference",
    text: "Fixes #585 and #586",
    closes: [585],
  },
  { name: "FORM: `prefixes #586` — the keyword inside a longer word", text: "prefixes #586", closes: [] },
  {
    name: "FORM: `fixed that for itself in #510` — words between keyword and reference",
    text: SESSION_49_NON_CLAUSE,
    closes: [],
  },
  { name: "FORM: `closing #586` — an inflection outside the nine", text: "closing #586", closes: [] },
];

const closesIn = (text: string) =>
  closingReferences(text, { label: "t", repo: TABLE_REPO })
    .filter(r => r.target === "this-repo")
    .map(r => r.number)
    .sort((a, b) => a - b);

describe("#590 AC-2/AC-3: the closing-keyword form table", () => {
  test("the form table enumerates at least twelve distinct forms", () => {
    const names = new Set(FORM_TABLE.map(r => r.name));
    expect(names.size, "duplicate rows would inflate the count without widening it")
      .toBe(FORM_TABLE.length);
    expect(FORM_TABLE.length, "no single example can satisfy the assertion alone")
      .toBeGreaterThanOrEqual(12);
  });

  test("the form table carries both closing and non-closing forms", () => {
    // A table of positives measures nothing about over-detection, which is
    // the direction that gets a check switched off.
    expect(FORM_TABLE.filter(r => r.closes.length > 0).length).toBeGreaterThan(0);
    expect(FORM_TABLE.filter(r => r.closes.length === 0).length).toBeGreaterThan(0);
  });

  test("the form table exercises all nine closing keywords", () => {
    // Without this the table could silently lose a keyword and stay green:
    // the rows that remained would all still pass.
    expect(CLOSING_KEYWORDS.length, "GitHub documents nine closing keywords").toBe(9);
    const corpus = FORM_TABLE.map(r => r.text.toLowerCase()).join("\n");
    for (const keyword of CLOSING_KEYWORDS) {
      expect(corpus, `no form table row uses the keyword "${keyword}"`)
        .toContain(`${keyword} `.trimEnd());
    }
  });

  for (const row of FORM_TABLE) {
    test(`${row.name} -> closes [${row.closes.join(", ")}]`, () => {
      expect(closesIn(row.text)).toEqual(row.closes);
    });
  }

  test("a qualified reference with no repository to compare against is UNKNOWN, not clean", () => {
    // Silent Default Substitution: guessing "it is probably ours" and
    // guessing "it is probably not" are both a verdict nobody measured.
    const refs = closingReferences("fixes some-owner/some-repo#586", { label: "t", repo: null });
    expect(refs.length).toBe(1);
    expect(refs[0].target).toBe("unknown");
  });
});

// ── The comparison ────────────────────────────────────────────────────────

const record = (over: Partial<Parameters<typeof stateRecordCloseViolations>[0]> = {}) => ({
  texts: [{ label: "commit message", text: "docs: record session 49" }],
  declared: [] as number[],
  repo: TABLE_REPO,
  ...over,
});

describe("#590 AC-1: the session-49 record is refused", () => {
  test("the session 49 phrase 'Filed and not fixed' puts 586 in the keyword-derived close set", () => {
    expect(closesIn(SESSION_49_CLAUSE)).toEqual([586]);
  });

  test("session 49 is refused while 586 is absent from 'Issues closed:'", () => {
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "commit message", text: SESSION_49_MESSAGE }],
      declared: [508],
    }));
    expect(found.length, "the close that shipped #586 was not refused").toBe(1);
    expect(found[0]).toContain("586");
    expect(found[0]).toContain("Filed and not fixed");
  });

  test("session 49 with 586 declared is accepted — the positive control", () => {
    // Without this, a check that refused every record would satisfy the case
    // above and be worse than nothing.
    expect(stateRecordCloseViolations(record({
      texts: [{ label: "commit message", text: SESSION_49_MESSAGE }],
      declared: [508, 586],
    }))).toEqual([]);
  });

  test("the other 'fixed' in the same summary is not refused", () => {
    expect(stateRecordCloseViolations(record({
      texts: [{ label: "commit message", text: SESSION_49_NON_CLAUSE }],
      declared: [],
    }))).toEqual([]);
  });
});

describe("#590 AC-4/AC-5: the refusal, in both directions", () => {
  test("an extra keyword-derived close is refused, and the refusal names both sets", () => {
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478. Also fixes #586." }],
      declared: [478],
    }));
    expect(found.length).toBe(1);
    expect(found[0]).toContain("#586");
    expect(found[0]).toContain("pull request body");
    // Both sets, named, so a reader can act without re-deriving either.
    expect(found[0], "the refusal does not name the keyword-derived set").toContain("478, 586");
    expect(found[0], "the refusal does not name the declared set").toContain("Issues closed:");
  });

  test("a missing declared close is refused, with text distinct from the extra case", () => {
    const missing = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478." }],
      declared: [478, 586],
    }));
    const extra = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478. Also fixes #586." }],
      declared: [478],
    }));
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain("#586");
    expect(missing[0]).toContain("Issues closed:");
    expect(missing[0], "the refusal does not name the keyword-derived set").toContain("478");
    // Two directions, two sentences. One shared message would make the
    // refusal unreadable in exactly the case a reader has to act on.
    expect(missing[0], "the two directions refuse with the same words").not.toBe(extra[0]);
  });

  test("the two directions are reported together, not one at a time", () => {
    // A validator that stops at the first finding turns one bad record into
    // two round-trips, which is lib/project-state-shape.ts's lesson.
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478. Fixes #586." }],
      declared: [478, 999],
    }));
    expect(found.length).toBe(2);
    expect(found.join("\n")).toContain("586");
    expect(found.join("\n")).toContain("999");
  });

  test("a record whose sets agree is accepted", () => {
    expect(stateRecordCloseViolations(record({
      texts: [
        { label: "pull request title", text: "docs: record session 49" },
        { label: "pull request body", text: "Closes #478, closes #508." },
      ],
      declared: [478, 508],
    }))).toEqual([]);
  });

  test("a record with nothing to read is refused rather than passed", () => {
    // "No problems found in zero texts" and "no problems found" are the same
    // string, which is #129's whole subject.
    const found = stateRecordCloseViolations(record({ texts: [], declared: [478] }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toMatch(/no text|nothing/i);
  });

  test("a blank text is refused the same way an absent one is", () => {
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "commit message", text: "   \n  " }],
      declared: [],
    }));
    expect(found.length).toBeGreaterThan(0);
  });

  test("a qualified reference the comparison cannot place is refused", () => {
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "commit message", text: "fixes some-owner/some-repo#586" }],
      declared: [],
      repo: null,
    }));
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/which repository|unknown/i);
  });

  test("the same issue closed twice in two texts is one finding, not two", () => {
    const found = stateRecordCloseViolations(record({
      texts: [
        { label: "pull request title", text: "fixes #586" },
        { label: "commit message", text: "fixes #586" },
      ],
      declared: [],
    }));
    expect(found.length).toBe(1);
  });
});

describe("#590: the declared list is parsed from what the record actually holds", () => {
  test("an array of numbers, which is what project-state.json carries", () => {
    expect(parseDeclaredCloses([478, 508])).toEqual([478, 508]);
  });

  test("the comma-joined string the renderer writes into PROJECT-STATE.md", () => {
    expect(parseDeclaredCloses("478,508,579,581")).toEqual([478, 508, 579, 581]);
  });

  test("an absent list is empty, not an excuse", () => {
    expect(parseDeclaredCloses(undefined)).toEqual([]);
    expect(parseDeclaredCloses(null)).toEqual([]);
  });

  test("an unreadable entry refuses instead of silently dropping", () => {
    // Dropping it would make a typo the cheapest way past the comparison.
    expect(() => parseDeclaredCloses("478,not-a-number")).toThrow(StateCloseRefused);
  });
});

// ── The live record ───────────────────────────────────────────────────────

describe("#590: the live project-state.json, read by the real comparison", () => {
  const live = JSON.parse(readFileSync(join(ROOT, "project-state.json"), "utf-8"));
  const session = live.session ?? {};
  const texts = [{ label: "session summary", text: String(session.summary ?? "") }];

  test("the live record is read, and the reading is not empty", () => {
    // The instrument check. A violation count means nothing beside a reading
    // that found no references at all — that is the same number a broken
    // regex produces.
    const refs = closingReferences(texts[0].text, { label: "session summary", repo: TABLE_REPO });
    expect(texts[0].text.length, "the live session summary is empty").toBeGreaterThan(200);
    expect(refs.length, "no closing keyword at all was found in the live summary")
      .toBeGreaterThan(0);
  });

  test("every undeclared close in the live record is one this commit banked", () => {
    // Banked, not asserted equal: #586 is the live exposure this issue is
    // about, and project-state.json is DA-owned (#296) so a worktree cannot
    // rephrase it. A NEW undeclared close turns this red; a record that
    // becomes clean leaves it green, so the DA is not blocked on deleting an
    // entry in the same commit that earns it.
    const BANKED = [586];
    const found = stateRecordCloseViolations({
      texts,
      declared: parseDeclaredCloses(session.issues_closed),
      repo: TABLE_REPO,
    });
    const undeclared = found
      .map(f => Number(/#(\d+)/.exec(f)?.[1]))
      .filter(n => Number.isFinite(n));
    const unexpected = undeclared.filter(n => !BANKED.includes(n));
    expect(unexpected, `the live session record would close issues nobody declared:\n${found.join("\n")}`)
      .toEqual([]);
  });
});
