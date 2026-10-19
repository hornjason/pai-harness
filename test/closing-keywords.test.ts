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
 *
 * ## #605 — the two questions, separated
 *
 * #590 shipped both directions as text comparisons, and the second one was
 * wrong about what `issues_closed` MEANS. It records what the SESSION closed,
 * through whatever PRs it merged; the check read it as what THIS PR will
 * close. Those coincide only when the state PR happens to carry a closing
 * keyword for every id, which for a session that shipped its work through its
 * own PRs means writing keywords that close nothing.
 *
 * Four records in a row did exactly that, and the last of them wrote
 * `Closes #669:` as the opening two words of an ordinary narrative sentence
 * in `session.summary` — a position GitHub never parses, whose only reader is
 * this file. The check was pushing authors toward #588's shape to satisfy it.
 *
 * So the file now exercises two deciders, and each one gets an input the
 * other cannot reach:
 *
 *   | decider | its input | the input only it can reach |
 *   |---|---|---|
 *   | `keywordCloseViolations` | `texts` | a record that declares NOTHING |
 *   | `declaredClosureViolations` | `issueStates` | a record with NO keyword anywhere |
 *
 * Both are written down below as separate cases saying which is which, as
 * `.claude/rules/checks-must-be-able-to-fail.md` requires of a pair kept
 * rather than collapsed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLOSING_KEYWORDS,
  type IssueState,
  type IssueStateReading,
  StateCloseRefused,
  closingReferences,
  declaredClosureViolations,
  fetchIssueStates,
  keywordCloseViolations,
  parseDeclaredCloses,
  parseIssueStatesFile,
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

/** A reading in which every id named is CLOSED on GitHub. */
const allClosed = (...ids: number[]): IssueStateReading => ({
  states: Object.fromEntries(ids.map(n => [n, "CLOSED" as IssueState])),
  source: "fixture",
});

/**
 * A record for the KEYWORD question's cases.
 *
 * The GitHub reading defaults to "everything this record declares is already
 * CLOSED", which is held fixed on purpose: every case below varies the TEXT,
 * so a case that also varied the reading would be measuring two things at
 * once and could not say which one its verdict came from (#585's pair
 * discipline). The declared-side cases set the reading explicitly and leave
 * the text alone.
 */
const record = (over: Partial<Parameters<typeof stateRecordCloseViolations>[0]> = {}) => {
  const base = {
    texts: [{ label: "commit message", text: "docs: record session 49" }],
    declared: [] as number[],
    repo: TABLE_REPO as string | null,
    ...over,
  };
  return { issueStates: allClosed(...base.declared), ...base };
};

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

  test("a declared id that is not closed is refused, with text distinct from the extra case", () => {
    // #605 replaced "declared with no keyword behind it" with "declared and
    // not CLOSED on GitHub". The two refusals must still read differently:
    // one shared message would make the refusal unreadable in exactly the
    // case a reader has to act on.
    const missing = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478." }],
      declared: [478, 586],
      issueStates: { states: { 478: "CLOSED", 586: "OPEN" }, source: "fixture" },
    }));
    const extra = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478. Also fixes #586." }],
      declared: [478],
    }));
    expect(missing.length).toBe(1);
    expect(missing[0]).toContain("#586");
    expect(missing[0]).toContain("OPEN on GitHub");
    expect(missing[0], "the two directions refuse with the same words").not.toBe(extra[0]);
  });

  test("the two directions are reported together, not one at a time", () => {
    // A validator that stops at the first finding turns one bad record into
    // two round-trips, which is lib/project-state-shape.ts's lesson. The two
    // findings here come from the two DIFFERENT deciders — #586 from the
    // keyword side, #999 from the GitHub side — so this also asserts the
    // composer runs both rather than returning at the first non-empty list.
    const found = stateRecordCloseViolations(record({
      texts: [{ label: "pull request body", text: "Closes #478. Fixes #586." }],
      declared: [478, 999],
      issueStates: { states: { 478: "CLOSED", 999: "OPEN" }, source: "fixture" },
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

  /**
   * ## What `BANKED` means, and what clears an entry (#605)
   *
   * An entry is ONE issue number that the LIVE `project-state.json` currently
   * puts in the keyword-derived close set without declaring it. It is a
   * grandfathered instance of the #588 defect sitting in a file a worktree
   * may not write (`project-state.json` is DA-owned, #296), parked here so
   * the guard can ship red-free while the record is repaired by its owner.
   *
   * **An entry means: "this record would close #N, nobody declared it, and
   * we are knowingly not refusing."** It does not mean "#N is fine", it does
   * not mean "#N was checked", and it is not a place to put an id to make a
   * failure stop.
   *
   * **What clears an entry:** the DA rewording the live summary so the id is
   * no longer in the keyword-derived set, or declaring it in
   * `issues_closed`. Nothing else. In particular a code change cannot clear
   * one, because nothing in code decides what is in this list.
   *
   * **The ratchet runs in BOTH directions, and that is new in #605.** Over
   * its number fails, as before — a NEW undeclared close is refused. UNDER
   * its number now fails too: an id banked here that the live record does
   * not actually produce is refused, naming it, and the fix is to delete the
   * entry. `.claude/rules/checks-must-be-able-to-fail.md` is blunt about why
   * — *a ratchet nobody can interpret becomes a number nobody lowers* — and
   * a one-way bank is exactly that, because adding an id is free and nothing
   * ever asks whether an old one still earns its place.
   *
   * It also closes the cheapest wrong fix for #605 by name. The one-line
   * repair for any refusal this case produces is to append the id to
   * `BANKED`. Under the two-way ratchet that only works while the live
   * record really does produce the violation — the moment it does not, the
   * stale entry is itself a failure. The #605 cases below are immune to it
   * for a second, independent reason: they are synthetic records with ids of
   * their own, and `BANKED` is read only here, against the live file.
   *
   * It is `[]` today, measured: the live session-54 summary's five closing
   * keywords are all declared, so the keyword side finds nothing. #586 — the
   * entry #590 banked — left the record when session 49 did.
   */
  const BANKED: number[] = [];

  test("every undeclared close in the live record is one this commit banked", () => {
    // The KEYWORD decider only. The declared side asks GitHub, and the suite
    // takes no network — so this case says nothing about whether the live
    // record's declared ids are closed, and says so rather than appearing to
    // have checked. `--issue-states github` is where that question is asked,
    // before a state PR is opened.
    const found = keywordCloseViolations({
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

    // The other direction. A banked id the record no longer produces is a
    // number nobody will ever lower unless something asks.
    const stale = BANKED.filter(n => !undeclared.includes(n));
    expect(
      stale,
      `these ids are banked in test/closing-keywords.test.ts but the live record no longer ` +
        `closes them undeclared — delete them from BANKED in the same commit that reads this`,
    ).toEqual([]);
  });
});

// ── #605: the declared side asks GitHub, not the text ────────────────────
//
// `issues_closed` records what the SESSION closed, not what this PR will
// close. Every case here holds the TEXT fixed at a summary with no closing
// keyword in it and varies only the GitHub reading, so a verdict can only
// have come from the declared-side decider.

/** A session summary with no closing keyword anywhere in it. */
const NO_KEYWORD_SUMMARY =
  "Session 54 recorded five merges and one reopened issue. The hill-climb receipt now " +
  "accounts for every action it did not apply, and the absent-claim refusal grew a third arm.";

const noKeywordRecord = (declared: number[], issueStates: IssueStateReading | null) => ({
  texts: [{ label: "session summary", text: NO_KEYWORD_SUMMARY }],
  declared,
  repo: TABLE_REPO,
  issueStates,
});

describe("#605 AC-1/AC-2: a declared id is checked against GitHub, not against prose", () => {
  test("the fixture summary really carries no closing keyword — the premise", () => {
    // Without this the cases below could be green because the keyword side
    // happened to agree, which is a verdict from the wrong decider.
    expect(closesIn(NO_KEYWORD_SUMMARY), "the fixture closes something after all").toEqual([]);
  });

  test("AC-1: a declared id that is CLOSED on GitHub passes with no keyword anywhere", () => {
    // The input only the declared-side decider can reach: no keyword exists,
    // so `keywordCloseViolations` has nothing to iterate. Under #590 this
    // refused, and the only way to clear it was to write `Fixes #662` into
    // narrative prose — the #588 shape the check exists to prevent.
    expect(stateRecordCloseViolations(noKeywordRecord([662], allClosed(662)))).toEqual([]);
  });

  test("AC-2: a declared id that is still OPEN refuses, naming it", () => {
    const found = stateRecordCloseViolations(
      noKeywordRecord([640], { states: { 640: "OPEN" }, source: "fixture" }),
    );
    expect(found.length).toBe(1);
    expect(found[0]).toContain("#640");
    expect(found[0]).toContain("OPEN on GitHub");
    // The refusal has to be actionable without re-deriving the reading.
    expect(found[0], "the refusal does not name the reading it acted on").toContain("GitHub states");
  });

  test("a record declaring a mix reports only the ids that are not closed", () => {
    const found = stateRecordCloseViolations(noKeywordRecord(
      [629, 640, 662],
      { states: { 629: "CLOSED", 640: "OPEN", 662: "CLOSED" }, source: "fixture" },
    ));
    expect(found.length).toBe(1);
    expect(found[0]).toContain("#640");
  });

  test("AC-3: a record that declares NOTHING is still refused for an undeclared keyword", () => {
    // The input only the KEYWORD decider can reach: with `declared` empty,
    // `declaredClosureViolations` returns [] before it looks at anything, so
    // this verdict cannot have come from it. The pair is written down as two
    // cases, which is what stops the next person deleting one of the two
    // deciders and watching the suite stay green.
    const found = stateRecordCloseViolations({
      texts: [{ label: "pull request body", text: "Filed and not fixed: #586, where a scaffold run rewrites text" }],
      declared: [],
      repo: TABLE_REPO,
      issueStates: allClosed(),
    });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("will CLOSE #586");
    expect(declaredClosureViolations([], allClosed()), "the declared side saw this input at all")
      .toEqual([]);
  });
});

describe("#605: an unreachable GitHub is UNMEASURED, and UNMEASURED is not clean", () => {
  test("a declared id with no reading behind it refuses, naming the state", () => {
    const found = stateRecordCloseViolations(noKeywordRecord([662], null));
    expect(found.length).toBe(1);
    expect(found[0]).toContain("#662");
    expect(found[0]).toContain("UNMEASURED");
  });

  test("a declared id the reading did not reach is UNMEASURED, not CLOSED", () => {
    // Silent Default Substitution: an id the reader could not resolve must
    // not inherit the verdict of the ids it could.
    const found = declaredClosureViolations([629, 662], {
      states: { 629: "CLOSED" },
      reasons: { 662: "GitHub answered HTTP 403" },
      source: "github:hornjason/pai-harness",
    });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("#662");
    expect(found[0]).toContain("UNMEASURED");
    expect(found[0], "the refusal does not say why it could not read").toContain("HTTP 403");
  });

  test("an UNMEASURED refusal reads differently from an OPEN one", () => {
    const unmeasured = declaredClosureViolations([662], null);
    const open = declaredClosureViolations([662], { states: { 662: "OPEN" } });
    expect(unmeasured[0]).not.toBe(open[0]);
    expect(open[0]).not.toContain("UNMEASURED");
  });

  test("a record declaring nothing, with no reading, is not refused", () => {
    // The positive control for the whole declared side. A check that refused
    // every record would satisfy all three cases above and be worse than
    // nothing.
    expect(declaredClosureViolations([], null)).toEqual([]);
    expect(stateRecordCloseViolations(noKeywordRecord([], null))).toEqual([]);
  });
});

describe("#605: the GitHub reading itself", () => {
  const response = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  test("open and closed are read, and the URL names the repository and the id", async () => {
    const asked: string[] = [];
    const reading = await fetchIssueStates("hornjason/pai-harness", [640, 662], {
      fetchImpl: (async (url: string) => {
        asked.push(String(url));
        return response(200, { state: String(url).endsWith("/640") ? "open" : "closed" });
      }) as unknown as typeof fetch,
    });
    expect(asked).toEqual([
      "https://api.github.com/repos/hornjason/pai-harness/issues/640",
      "https://api.github.com/repos/hornjason/pai-harness/issues/662",
    ]);
    expect(reading.states).toEqual({ 640: "OPEN", 662: "CLOSED" });
  });

  test("a non-OK response leaves the id out of the reading rather than guessing", async () => {
    const reading = await fetchIssueStates("hornjason/pai-harness", [662], {
      fetchImpl: (async () => response(404, {})) as unknown as typeof fetch,
    });
    expect(reading.states[662]).toBeUndefined();
    expect(reading.reasons?.[662]).toContain("404");
    expect(declaredClosureViolations([662], reading)[0]).toContain("UNMEASURED");
  });

  test("a thrown request is UNMEASURED, not a clean record", async () => {
    const reading = await fetchIssueStates("hornjason/pai-harness", [662], {
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
    });
    expect(reading.states[662]).toBeUndefined();
    expect(reading.reasons?.[662]).toContain("ENOTFOUND");
  });

  test("no repository to ask is UNMEASURED, and nothing is requested", async () => {
    let called = 0;
    const reading = await fetchIssueStates(null, [662], {
      fetchImpl: (async () => {
        called++;
        return response(200, { state: "closed" });
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(0);
    expect(reading.states[662]).toBeUndefined();
    expect(reading.reasons?.[662]).toContain("--repo");
  });

  test("a token is sent when one is supplied, and no header is invented when none is", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const impl = (async (_u: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return response(200, { state: "closed" });
    }) as unknown as typeof fetch;
    await fetchIssueStates("o/r", [1], { token: "t0ken", fetchImpl: impl });
    await fetchIssueStates("o/r", [1], { token: null, fetchImpl: impl });
    expect(seen[0]?.authorization).toBe("Bearer t0ken");
    expect(seen[1]?.authorization).toBeUndefined();
  });
});

describe("#605: the states file, which is how the suite drives the CLI offline", () => {
  test("an object of issue number to state is read", () => {
    const reading = parseIssueStatesFile('{"640":"open","662":"CLOSED"}', "states.json");
    expect(reading.states).toEqual({ 640: "OPEN", 662: "CLOSED" });
    expect(reading.source).toBe("states.json");
  });

  test("an unreadable state refuses instead of being dropped", () => {
    // Dropping it would make a typo the cheapest way past the comparison,
    // which is the reason parseDeclaredCloses throws.
    expect(() => parseIssueStatesFile('{"662":"probably"}', "s.json")).toThrow(StateCloseRefused);
    expect(() => parseIssueStatesFile('{"not-a-number":"OPEN"}', "s.json")).toThrow(StateCloseRefused);
    expect(() => parseIssueStatesFile("[]", "s.json")).toThrow(StateCloseRefused);
    expect(() => parseIssueStatesFile("{", "s.json")).toThrow(StateCloseRefused);
  });
});
