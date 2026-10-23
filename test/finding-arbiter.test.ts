/**
 * The filing arbiter, stage 1 (#1187).
 *
 * The suite is built around one requirement: **the gate must be able to
 * fail.** A filter that passes everything and a filter that works are
 * indistinguishable without a planted pair, so `arbitrate` is driven over a
 * known-good finding and a known-duplicate finding **through the same call
 * the production caller makes**, and the separation is the assertion
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The duplicate fixtures are excerpts of the two real pairs that motivated
 * the issue — #1175/#1177 and #1195/#1196 — carrying the sentences that hold
 * their measurements. Both pairs have **completely different titles**, which
 * is why `TITLE-SIMILARITY` below runs the cheapest wrong fix over the same
 * four bodies and records what it catches.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  arbitrate,
  arbitrateBatch,
  containedCitationPath,
  containmentOf,
  DUPLICATE_CONTAINMENT_MIN_KEYS,
  DUPLICATE_MIN_SHARED_QUANTITIES,
  FILING_BUDGET_FINDINGS,
  citedLines,
  citedSymbols,
  duplicateOverlap,
  sharedKeys,
  symptomHash,
  symptomKeys,
  UNFILED_ID,
  BALLOT_AMBIGUOUS,
  BALLOT_COUNT_MISMATCH,
  SHARED_BALLOT,
  type Finding,
} from "../lib/finding-arbiter";
import type { CandidateRecord } from "../lib/finding-arbiter";
import { INCOMPLETE_GROUP, juryReading, SEVERITY_RANK, type VerifierVote } from "../lib/finding-jury";
import {
  compareReviewOutcomes,
  readFindingOutcomes,
  summariseFindingOutcomes,
  type FindingDisposition,
  type ReviewFinding,
} from "../evals/ai-review-control/outcomes";

/**
 * A full, agreeing verifier group.
 *
 * Every case below that expects a finding to survive supplies one, because
 * **an absent vote is UNMEASURED and UNMEASURED fails.** That is not
 * ceremony: a suite that could reach `COMMENT` without a jury would be
 * asserting the opposite of the gate it is testing.
 */
const AGREED: readonly VerifierVote[] = [
  { verifier: "v1", real: true, reason: "reproduced" },
  { verifier: "v2", real: true, reason: "reproduced" },
  { verifier: "v3", real: false, reason: "could not reproduce" },
];

// ── The two real duplicate pairs, excerpted ──────────────────────────────

const I1175: Finding = {
  id: "1175",
  title:
    "PROTECTED_FILES matches by basename with no notion of tree: 144 of 234 " +
    "newly-blocked commands are agents writing legitimate /tmp test fixtures",
  body:
    "`PROTECTED_FILES` in the Bash write guard matches by **basename**. Measured on a " +
    "5,060-command real corpus during the rework: of 234 commands the hardened guard " +
    "newly blocks, **144 are interpreter writes to `workflow-state.json` under " +
    "`mkdtemp` or `/tmp`.**\n\n" +
    "`specs/HOOK-ARCHITECTURE-SPEC.md` already defers the same question for the " +
    "`*.hook.ts` arm. Scoping to the project root makes every guard decision depend " +
    "on resolving that root, and `nonCanonicalRoots()` compared a canonicalised path " +
    "against an un-`resolve()`d root, breaking containment in `collectDestination` at " +
    "5 of 6 spellings.",
};

const I1177: Finding = {
  id: "1177",
  title:
    "`PROTECTED_FILES` matches by basename, so BashWriteGuard refuses 144 " +
    "legitimate test fixtures under `/tmp` and `mkdtemp`",
  body:
    "Sweeping 5,060 unique real commands through `lib/bash-write-guard.ts`:\n\n" +
    "| Reading | Count |\n|---|---|\n| newly blocked | 234 |\n" +
    "| of those, interpreter writes to a gate-artifact basename | **144** |\n\n" +
    "`PROTECTED_FILES` is tested with `String.includes` against a resolved-ish " +
    "target string. `specs/HOOK-ARCHITECTURE-SPEC.md` already defers exactly this " +
    "question. `nonCanonicalRoots()` compared a canonicalised path against an " +
    "un-`resolve()`d root, so containment broke in `collectDestination` — measured, " +
    "5 of 6 spellings. `WRITE_INTENT`'s docblock already warns about the failure mode.",
};

const I1195: Finding = {
  id: "1195",
  title:
    "PR introduced two guard defects, measured on merged main: an assignment prefix " +
    "flips 3 of 10 blocked writes to allowed, and cp/mv decisions depend on filesystem state",
  body:
    "`commandWord` now reads `dequote(stripHeredocs(segment))`. That is the right " +
    "direction — it is what fixes the case where `stripQuoted` deleted the verb " +
    "outright. But `dequote` keeps the bytes, so a quoted multi-word assignment value " +
    "survives the split.\n\n" +
    "Ten write commands, each run bare and again prefixed: 3 of 10 flip from blocked " +
    "to allowed, among them `chmod 777 …/hooks/x.hook.ts`. 15 further spellings were " +
    "swept. Tokenise quote-aware rather than dequoting then splitting: walk the " +
    "segment with `readWord`.\n\n" +
    "`isDirDestination` makes the decision from filesystem state. Delete " +
    "`isDirDestination` and the `statSync` import, and always push the destination " +
    "basename for every non-last argument. Assertions must be on `commandWord` and " +
    "`writeTargets` directly, not only through `decideBashWrite`.",
};

const I1196: Finding = {
  id: "1196",
  title: "Two regressions shipped to main, plus H6: `<<WORD` inside a quoted span drops the lines after it",
  body:
    "R1 — a quoted multi-word assignment prefix hides the verb. `commandWord` was " +
    "changed to read `dequote(stripHeredocs(segment))`; `dequote` strips the quote " +
    "characters but keeps the bytes, so a quoted assignment VALUE survives the " +
    "whitespace split.\n\n" +
    "WITNESS rows cover `chmod 777 <hook>` and the copying verbs; 15 spellings were " +
    "checked in total. The fix is to tokenise quote-aware so a quoted span stays " +
    "inside its word — `readWord` in the same module already does exactly this.\n\n" +
    "R2 — the decision depends on filesystem state at decision time. " +
    "`isDirDestination` calls `statSync`. The trailing-slash row isolates `statSync` " +
    "as the cause.",
};

describe("AR-1: dedupe keys on the measured symptom, not the title", () => {
  test("#1175 and #1177 are the same symptom under completely different titles", () => {
    const overlap = duplicateOverlap(I1175, I1177);
    expect(overlap.duplicate).toBe(true);
    // The readings, not the prose, are what agree.
    expect(overlap.keys).toContain("qty:144");
    expect(overlap.keys).toContain("qty:234");
    expect(overlap.keys).toContain("qty:5060");
    expect(overlap.keys).toContain("sym:PROTECTED_FILES");
  });

  test("#1195 and #1196 are the same symptom, filed one minute apart", () => {
    const overlap = duplicateOverlap(I1195, I1196);
    expect(overlap.duplicate).toBe(true);
    expect(overlap.keys).toContain("sym:commandWord");
    expect(overlap.keys).toContain("sym:isDirDestination");
    expect(overlap.keys).toContain("sym:statSync");
  });

  /**
   * THE CHEAPEST WRONG FIX, measured rather than argued.
   *
   * Token-Jaccard over titles at the usual 0.5 threshold catches **neither**
   * pair — 0.348 and 0.100. Over the 40-issue corpus these came from it
   * flags zero pairs of any kind. The row is here so that a later change
   * that quietly reverts to a title key goes red instead of looking cheaper.
   */
  test("TITLE-SIMILARITY: the cheap deduper catches 0 of 2", () => {
    const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
    const jaccard = (a: string, b: string) => {
      const [A, B] = [tokens(a), tokens(b)];
      const shared = [...A].filter(t => B.has(t)).length;
      return shared / (A.size + B.size - shared);
    };
    expect(jaccard(I1175.title, I1177.title)).toBeLessThan(0.5);
    expect(jaccard(I1195.title, I1196.title)).toBeLessThan(0.5);
  });

  test("a finding that cites the other by number is building on it, not duplicating it", () => {
    const citing: Finding = { ...I1177, id: "9999", body: `Follow-on from #1175.\n\n${I1177.body}` };
    expect(duplicateOverlap(citing, I1175).duplicate).toBe(false);
  });

  test("sharing an area of code without sharing a reading is not a duplicate", () => {
    // The shape that produced 17 false positives at a flat key threshold: two
    // findings naming the same functions in the same file, measuring nothing
    // in common.
    const other: Finding = {
      id: "8888",
      title: "A different defect in the same guard",
      body:
        "`commandWord` and `stripHeredocs` are also reached by the hook arm, and " +
        "`writeTargets` drops the operand. 41 spellings were swept, 7 newly blocked.",
    };
    expect(duplicateOverlap(other, I1195).duplicate).toBe(false);
    // ...and it does share the area, which is what makes this a control.
    expect(sharedKeys(other, I1195)).toContain("sym:commandWord");
  });
});

describe("AR-2: extraction refuses the shapes that are not readings", () => {
  test("an issue reference is not a quantity", () => {
    const keys = symptomKeys({ id: "x", title: "t", body: "Caused by #1188 and #1184, see SC-453." });
    expect(keys.filter(k => k.startsWith("qty:"))).toEqual([]);
  });

  test("a hyphenated filename does not yield three symbols", () => {
    const keys = symptomKeys({ id: "x", title: "t", body: "see `specs/HOOK-ARCHITECTURE-SPEC.md`" });
    expect(keys).not.toContain("sym:HOOK");
    expect(keys).not.toContain("sym:ARCHITECTURE");
    expect(keys).toContain("file:specs/hook-architecture-spec.md");
  });

  test("a path:line citation is read as a citation", () => {
    expect(citedLines({ id: "x", title: "t", body: "`hooks/BashWriteGuard.hook.ts:81` and `:115`" }))
      .toEqual([{ path: "hooks/BashWriteGuard.hook.ts", line: 81 }]);
  });

  // #1333. The ISO form was already masked; a clock time written apart from
  // its date was not, because the `:\d+` rule took the minutes and left the
  // hour standing as an ordinary integer over the `n >= 10` floor.
  const qty = (body: string) => symptomKeys({ id: "x", title: "t", body }).filter(k => k.startsWith("qty:"));

  test("a clock time is not a quantity", () => {
    expect(qty("the run started at 15:24 and ended at 16:02")).toEqual([]);
    expect(qty("it timed out at 23:59:01")).toEqual([]);
    // The ISO form, which was always masked — here so a fix that moved the
    // clock rule ahead of the date rule cannot pass by shadowing it.
    expect(qty("the run started at 2026-10-23T15:24:00Z")).toEqual([]);
  });

  test("masking a clock time does not mask a reading", () => {
    // The positive control. A fix that widened far enough to swallow ordinary
    // integers would satisfy the case above and break the function's purpose,
    // so the two assertions have to sit together.
    expect(qty("it found 15 violations")).toEqual(["qty:15"]);
    expect(qty("41 spellings were swept, 7 newly blocked")).toEqual(["qty:41"]);
    expect(qty("the ratio moved from 1,024 to 2,048")).toEqual(["qty:1024", "qty:2048"]);
  });

  /**
   * ## #1385: every row above hands the guard the SAME SHAPE of input
   *
   * `15:24`, `16:02`, `23:59:01` — a bare clock time with a non-word
   * character after it, three times. The mask shipped as
   * `/\b\d{1,2}:\d{2}(?::\d{2})?\b/` and **every one of these passed with
   * the defect open**, because `\b` only fails when the character after the
   * match is a word character and none of them had one.
   *
   * That is the seventh shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`, named by the battery it
   * got past: the rows varied the guard and held the input shape fixed, so
   * no count could come back wrong about an input nobody wrote. The axis
   * that mattered was the character AFTER the time, and nothing varied it.
   *
   * The three rows below vary exactly that, and they are three different
   * things — which is the point, so say which is which:
   */
  test("#1385: the character after a clock time is the axis nothing varied", () => {
    // 1. THE DEFECT. `Z` is a word character, so the trailing `\b` failed,
    //    the `:\d+` rule then ate `:05`, and `19:05Z` scored `qty:19`. This
    //    row is RED before the fix. It has a live instance: #1226 says
    //    "served 0.8.1 at roughly 19:05Z" and #1162 says "19 distinct check
    //    names", and that collision was one of only two cross-issue
    //    duplicate pairs on the open corpus.
    expect(qty("registry served 0.8.1 at roughly 19:05Z, most of it the suite")).toEqual([]);
    expect(qty("the window (19:05Z) closed")).toEqual([]);

    // 2. ALREADY GREEN, FOR A REASON THE FIX CHANGES. The space after
    //    `19:05` supplies the word boundary, so this passed with the defect
    //    open and passes now — but it used to pass BECAUSE of `\b` and now
    //    passes because of `(?!\d)`. Pinned so the two readings stay
    //    distinguishable from the row above.
    expect(qty("at 19:05 UTC we saw it")).toEqual([]);

    // 3. GREEN BY ACCIDENT BEFORE, GREEN BY DESIGN NOW. `18:48:45Z` could
    //    not match whole — `\b` failed before the `Z` — but the regex
    //    BACKTRACKED to the `HH:MM` form `18:48`, whose boundary held, and
    //    the `:\d+` rule swallowed the `:45Z` remainder. So it was masked
    //    without the full-length alternative ever matching. After the fix it
    //    matches outright. The assertion is the same; what it witnesses is
    //    not, and a reader who assumed this row covered the seconds form
    //    would have been wrong before today.
    expect(qty("published 18:48:45Z and then waited")).toEqual([]);
  });

  test("#1385: the fix does not start a match inside a longer number", () => {
    // The negative control for `(?<![\d:])`. Without it the `48:30` of
    // `15:48:30` is a second candidate match, and a lookbehind that admitted
    // it would mask more than a clock time.
    expect(qty("the gap was 15:48:30 exactly")).toEqual([]);
    // And the positive control, restated against the NEW boundary: widening
    // to swallow ordinary integers would satisfy every row above.
    expect(qty("it found 19 violations")).toEqual(["qty:19"]);
    expect(qty("105 checks ran")).toEqual(["qty:105"]);
  });

  test("a clock hour and a reading of the same number do not collide", () => {
    // The defect stated as the thing it costs: these two findings measure
    // nothing in common, and before #1333 they shared `qty:15`.
    const clock = symptomKeys({ id: "a", title: "t", body: "the run started at 15:24" });
    const reading = symptomKeys({ id: "b", title: "t", body: "it found 15 violations" });
    expect(clock.filter(k => reading.includes(k))).toEqual([]);
  });
});

// ── A repository to read `origin/main` out of ────────────────────────────

let root = "";

/**
 * `git init` gives a repository with **no remote**, so `origin/main` does not
 * resolve and both repo-backed checks would report UNMEASURED for a reason
 * that is an artefact of the fixture rather than of the finding. The ref is
 * created explicitly for that reason.
 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "arbiter-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, "widget.ts"), Array.from({ length: 12 }, (_, i) =>
    i === 4 ? "export function widgetHandler() {" : `// line ${i + 1}`).join("\n"));
  git("add", "-A");
  git("commit", "--quiet", "-m", "seed");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * The environment for a spawn of `scripts/arbitrate-finding.ts` (#1467).
 *
 * Since CRC-B4 the script appends an adjudication to `ledgerPath()`, which
 * defaults to `~/.rungate/finding-ledger.jsonl` — the real one, shared by
 * every agent on this machine. A suite that left it there would write test
 * ballots into the corpus the quorum's cardinality is supposed to be derived
 * from, and nothing downstream could tell them from decisions somebody took.
 *
 * Passed explicitly rather than set on `process.env`: bun does not hand a
 * child a parent's late environment edits when the spawn declares no `env`.
 */
const scratchLedgerEnv = (dir: string): Record<string, string | undefined> => ({
  ...process.env,
  RUNGATE_FINDING_LEDGER: join(dir, "finding-ledger.jsonl"),
});

const onMain = (body: string, id = "new"): Finding => ({ id, title: "a finding", body });
const opts = (extra: Record<string, unknown> = {}) => ({
  projectRoot: root,
  existing: [] as Finding[],
  votes: AGREED,
  ...extra,
});

/**
 * One group's verdict, repeated once per finding — written out, because
 * `arbitrateBatch` refuses a single `votes` for a batch of several (#1297).
 *
 * **This is the expansion the production path will not do for you**, and
 * spelling it at every call site is the point rather than the cost. Seventeen
 * cases in this file were handing one ballot to a multi-finding batch before
 * #1297, and each was asserting something about the dedupe or the budget
 * while quietly also asserting that one vote about one finding settled the
 * quorum for all the others. Here, that second claim is written down.
 *
 * `votes: undefined` is not tidiness: supplying both is `BALLOT_AMBIGUOUS`,
 * two instructions about one batch with no tie-break.
 */
const eachVotedTheSame = (votes: readonly VerifierVote[], n: number) => ({
  votes: undefined,
  ballots: Array.from({ length: n }, () => votes),
});

describe("AR-3: branch scope is a reading, not a refusal", () => {
  /**
   * THE INVERSION. `OFF_MAIN` used to refuse. A finding about code that
   * exists only on the branch under review is not a bad finding — it is
   * exactly what an inline comment is for, and refusing it was the old
   * two-outcome world where the only alternative to an issue was nothing.
   */
  test("a symbol that exists only on an unmerged branch becomes a comment on that branch", () => {
    const v = arbitrate(onMain("`branchOnlyHelper` drops the operand in `widget.ts`."), opts());
    expect(v.scope).toBe("branch");
    expect(v.refusal).toBeNull();
    expect(v.disposition).toBe("COMMENT");
  });

  test("CONTROL: the same shape naming a symbol on origin/main reads main", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts());
    expect(v.scope).toBe("main");
    expect(v.disposition).toBe("COMMENT");
  });

  test("a branch-only finding can never be routed to ISSUE, however it is declared", () => {
    // It cannot be out-of-scope work for a PR whose branch is the only place
    // the symbol exists.
    const v = arbitrate(
      { ...onMain("`branchOnlyHelper` drops the operand."), outOfScope: { reason: "different subsystem" } },
      opts(),
    );
    expect(v.scope).toBe("branch");
    expect(v.disposition).toBe("COMMENT");
  });
});

describe("AR-4: citation currency — is this current?", () => {
  test("a line past the end of the file is dropped before any investigation", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:81` and again at `widget.ts:115`."), opts());
    expect(v.refusal).toBe("STALE_CITATION");
    expect(v.reason).toContain("widget.ts:81");
    expect(v.reason).toContain("12 lines");
    expect(v.disposition).toBe("DROP");
  });

  test("CONTROL: a line inside the file posts", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `widget.ts:5`."), opts());
    expect(v.disposition).toBe("COMMENT");
    expect(v.refusal).toBeNull();
  });
});

describe("AR-5: UNMEASURED fails, it never skips", () => {
  test("a finding with nothing extractable does not post", () => {
    const v = arbitrate({ id: "new", title: "it feels slow", body: "it feels slow lately" }, opts());
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("a finding citing a reading but no symbol does not post", () => {
    const v = arbitrate(onMain("We saw 412 of these and then 913 more."), opts());
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("an unreadable repository refuses rather than passing", () => {
    const barren = mkdtempSync(join(tmpdir(), "arbiter-barren-"));
    try {
      const v = arbitrate(onMain("`widgetHandler` drops the operand."), opts({ projectRoot: barren }));
      expect(v.refusal).toBe("UNMEASURED");
      expect(v.disposition).toBe("DROP");
      expect(v.reason).toContain("origin/main");
    } finally {
      rmSync(barren, { recursive: true, force: true });
    }
  });

  test("skipRepoChecks reports UNMEASURED, not a pass", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand."), opts({ skipRepoChecks: true }));
    expect(v.disposition).toBe("DROP");
    expect(v.refusal).toBe("UNMEASURED");
  });

  /**
   * THE ONE WITH NO ESCAPE HATCH. A finding nobody voted on has not cleared a
   * quorum; it has not had one. There is deliberately no `skipJury`, because
   * a caller may genuinely have no repository and no caller genuinely has no
   * verifiers.
   */
  test("no verifier group at all is UNMEASURED, not a quiet pass", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), {
      projectRoot: root,
      existing: [],
    });
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.disposition).toBe("DROP");
    expect(v.jury).toBeNull();
  });

  test("a short verifier group is UNMEASURED even when everyone present agreed", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts({
      votes: [{ verifier: "v1", real: true, reason: "yes" }, { verifier: "v2", real: true, reason: "yes" }],
    }));
    expect(v.refusal).toBe("UNMEASURED");
    expect(v.jury?.agree).toBe(2);
  });

  test("a group that voted it down is NO_QUORUM — measured, and distinct from unreadable", () => {
    const v = arbitrate(onMain("`widgetHandler` drops the operand in `widget.ts`."), opts({
      votes: [
        { verifier: "v1", real: true, reason: "yes" },
        { verifier: "v2", real: false, reason: "no" },
        { verifier: "v3", real: false, reason: "no" },
      ],
    }));
    expect(v.refusal).toBe("NO_QUORUM");
    expect(v.jury?.reading).toBe("MEASURED");
    expect(v.disposition).toBe("DROP");
  });

  test("a dropped category never reaches the repository checks", () => {
    const v = arbitrate(
      { id: "new", title: "Nit: rename the variable in widget.ts", body: "`widgetHandler` could be clearer." },
      opts(),
    );
    expect(v.refusal).toBe("DROPPED_CATEGORY");
    expect(v.category).toBe("style");
    // Reached before stage 4, so the branch-scope reading was never taken.
    expect(v.scope).toBeNull();
  });
});

describe("AR-6: the planted pair — the gate separates them under the real call", () => {
  /**
   * One batch, one `arbitrate` invocation per finding with identical options,
   * exactly as `scripts/arbitrate-finding.ts` calls it. A control run through
   * a convenience wrapper can be structurally sound and never ask the
   * question the production path asks.
   */
  test("a known-good finding files and a known-duplicate does not", () => {
    const filed: Finding = {
      id: "7001",
      title: "already filed",
      body: "`widgetHandler` mishandles 311 of 742 operands in `widget.ts`.",
    };
    const knownDuplicate: Finding = {
      id: "new-dup",
      title: "worded nothing like the one above",
      body: "Sweeping the corpus: 742 operands, of which `widgetHandler` mishandles 311.",
    };
    const knownGood: Finding = {
      id: "new-good",
      title: "an unrelated reading",
      body: "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.",
    };

    const options = opts({ existing: [filed] });
    const dup = arbitrate(knownDuplicate, options);
    const good = arbitrate(knownGood, options);

    expect(dup.disposition).toBe("DROP");
    expect(dup.refusal).toBe("DUPLICATE");
    expect(dup.duplicateOf).toEqual(["7001"]);
    expect(dup.occurrences).toBe(2);
    // The refusal names its evidence, so it is reviewable rather than silent.
    expect(dup.collidingKeys).toContain("qty:311");
    expect(dup.collidingKeys).toContain("qty:742");

    expect(good.disposition).toBe("COMMENT");
    expect(good.refusal).toBeNull();

    // The separation itself, stated as one assertion: the gate let exactly
    // one of the two through.
    expect([dup, good].filter(v => v.disposition !== "DROP").length).toBe(1);
  });
});

describe("AR-7: the issue budget is rule-promotion's, not a second one", () => {
  // Each is DECLARED out of scope, which is the only route to ISSUE. The
  // budget caps filings because filings accumulate; comments are not capped
  // because a comment blocks the merge until it is answered.
  const batchOf = (n: number): Finding[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `b${i}`,
      title: `reading ${i}`,
      // Distinct readings, so none of these is a duplicate of another.
      body: `\`widgetHandler\` leaks ${100 + i} descriptors across ${900 + i} runs.`,
      outOfScope: { reason: "a different subsystem owns this" },
    }));

  test("a batch over budget is evicted by promoteCandidates, not filed", () => {
    const batch = batchOf(FILING_BUDGET_FINDINGS + 3);
    const r = arbitrateBatch(batch, opts(eachVotedTheSame(AGREED, batch.length)));
    expect(r.verdicts.every(v => v.disposition === "ISSUE")).toBe(true);
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS);
    expect(r.promotion.withheld.filter(w => w.reason === "OVER_BUDGET").length).toBe(3);
    expect(r.promotion.reading).toBe("MEASURED");
  });

  test("CONTROL: a batch under budget files all of it", () => {
    const batch = batchOf(FILING_BUDGET_FINDINGS - 2);
    const r = arbitrateBatch(batch, opts(eachVotedTheSame(AGREED, batch.length)));
    expect(r.toFile.length).toBe(FILING_BUDGET_FINDINGS - 2);
    expect(r.promotion.withheld).toEqual([]);
  });

  test("one UNMEASURED finding makes the whole batch reading UNMEASURED", () => {
    const r = arbitrateBatch([...batchOf(2), { id: "vague", title: "slow", body: "it feels slow" }], opts(eachVotedTheSame(AGREED, 3)));
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.promotion.unmeasuredReasons.some(x => x.startsWith("vague:"))).toBe(true);
  });

  /**
   * THE DISCRIMINATOR IS CONSULTED, not merely computed.
   *
   * `promoteCandidates` returns a POPULATED `promoted` under an UNMEASURED
   * reading — only its `budget < 1` branch empties it. So this is the case
   * that separates "the batch reading was computed" from "the batch reading
   * decided anything", and without it `arbitrateBatch`'s own header claim —
   * that an unevaluable batch "does not report a measured zero" — would be
   * false while every other row here stayed green.
   */
  test("an UNMEASURED batch files nothing, even though the promoter still ranked a list", () => {
    const r = arbitrateBatch([...batchOf(2), { id: "vague", title: "slow", body: "it feels slow" }], opts(eachVotedTheSame(AGREED, 3)));
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.promotion.promoted.length).toBeGreaterThan(0); // the shape being guarded against
    expect(r.toFile).toEqual([]);
  });

  test("comments come back ranked Important, Pre-existing, Nit", () => {
    const sev = (s: "Important" | "Nit" | "Pre-existing"): VerifierVote[] => [
      { verifier: "v1", real: true, reason: "y", severity: s },
      { verifier: "v2", real: true, reason: "y", severity: s },
      { verifier: "v3", real: true, reason: "y", severity: s },
    ];
    const mk = (id: string, n: number): Finding => ({
      id,
      title: `reading ${id}`,
      body: `\`widgetHandler\` leaks ${n} descriptors across ${900 + n} runs.`,
    });
    // Arbitrated one at a time so each carries its own severity, then ranked
    // the way the batch ranks.
    const got = [
      { v: arbitrate(mk("low", 10), opts({ votes: sev("Nit") })), id: "low" },
      { v: arbitrate(mk("high", 20), opts({ votes: sev("Important") })), id: "high" },
      { v: arbitrate(mk("old", 30), opts({ votes: sev("Pre-existing") })), id: "old" },
    ];
    expect(got.map(g => g.v.severity)).toEqual(["Nit", "Important", "Pre-existing"]);
    const ranked = [...got].sort((a, b) => SEVERITY_RANK[a.v.severity!] - SEVERITY_RANK[b.v.severity!]);
    expect(ranked.map(r => r.id)).toEqual(["high", "old", "low"]);
  });
});

describe("AR-8: checks run in cost order", () => {
  test("a duplicate is never paid a git grep", () => {
    const filed: Finding = { id: "7002", title: "filed", body: "`absentSymbolXyz` fails 311 of 742 times." };
    // The symbol is absent from origin/main, so stage 4 would read scope=branch.
    // The verdict is DUPLICATE, which is only reachable if stage 1 short-circuited.
    const v = arbitrate(
      { id: "new", title: "reworded", body: "742 runs, 311 failures in `absentSymbolXyz`." },
      opts({ existing: [filed] }),
    );
    expect(v.refusal).toBe("DUPLICATE");
    expect(v.scope).toBeNull();
  });

  test("a duplicate is never paid a verifier group either — the vote is the dearest instrument", () => {
    const filed: Finding = { id: "7003", title: "filed", body: "`absentSymbolXyz` fails 311 of 742 times." };
    const v = arbitrate(
      { id: "new", title: "reworded", body: "742 runs, 311 failures in `absentSymbolXyz`." },
      { projectRoot: root, existing: [filed] }, // no votes at all
    );
    expect(v.refusal).toBe("DUPLICATE");
  });

  test("citedSymbols is capped so an essay cannot cost an unbounded number of greps", () => {
    const body = Array.from({ length: 40 }, (_, i) => `\`someSymbol${i}X\``).join(" ");
    expect(citedSymbols(onMain(body)).length).toBeLessThanOrEqual(8);
  });

  /**
   * The asymmetry that ran the wrong way: the CHEAP probe was bounded and
   * the expensive one — a `readFileSync`, or a `git show origin/main:<path>`
   * per citation — was not.
   */
  test("citedLines is capped the same way, and the expensive probe is the one that needed it", () => {
    const body = Array.from({ length: 400 }, (_, i) => `\`lib/file${i}.ts:${i + 1}\``).join(" ");
    expect(citedLines(onMain(body)).length).toBeLessThanOrEqual(8);
  });
});

describe("AR-9: the incident that motivated #1187, driven through the real function", () => {
  /**
   * #1195 and #1196: the same symptom, filed **one minute apart** — close
   * enough that neither was in the tracker when the other was arbitrated.
   *
   * The first cut of `arbitrateBatch` compared every finding against a fixed
   * `options.existing` snapshot, so **both read as new** and the PR claiming
   * to close #1187 would not have stopped the incident it cites. These are
   * the real titles and bodies, fetched from the tracker and committed, not
   * a synthetic pair reworded to collide.
   */
  const incident = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "finding-incident-1195-1196.json"), "utf-8"),
  ) as Finding[];

  test("the fixture is the real pair", () => {
    expect(incident.map(f => f.id).sort()).toEqual(["1195", "1196"]);
    // Guards against the fixture being silently emptied, which would make
    // every row below pass vacuously.
    for (const f of incident) expect(f.body.length).toBeGreaterThan(1000);
  });

  /** The distinct finding the pair is tied with. A DIFFERENT write-guard
   * defect — an escaped quote inside `$( )` — in the same subsystem. */
  const distinct = (
    JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "finding-distinct-1239.json"), "utf-8"),
    ) as Finding[]
  )[0]!;

  /**
   * ## THE BATCH-MECHANICS PAIR, AND WHY IT IS A SECOND FIXTURE (#1333)
   *
   * Four rows below are about `arbitrateBatch` MECHANICS — self-skip by
   * reference rather than by id, in-batch collision against an empty
   * tracker, walk-order determinism, and the mutation showing a fixed
   * snapshot misses all of it. None of them is about #1195/#1196; that pair
   * was simply the duplicate they were driven on, and after the clock-time
   * mask it is no longer a duplicate at all.
   *
   * So they were repointed rather than weakened. `#1175`/`#1177` are a real
   * tracker pair that is still a duplicate on three genuine shared
   * quantities, with 7 and 14 keys — the mask does not touch them.
   *
   * The repoint is not optional housekeeping. Left on the incident pair,
   * `MUTATION: against a fixed snapshot` would have stayed GREEN while
   * asserting nothing: it expects zero duplicates, and zero is what a
   * non-duplicate pair gives with or without the mutation applied. That is
   * the third shape in `.claude/rules/checks-must-be-able-to-fail.md`, and
   * it arrives silently, on a case nobody had to touch.
   */
  const batchPair = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "finding-incident-1175-1177.json"), "utf-8"),
  ) as Finding[];

  test("the batch-mechanics pair is a real duplicate, or the four rows below say nothing", () => {
    expect(batchPair.map(f => f.id).sort()).toEqual(["#1175", "#1177"]);
    for (const f of batchPair) expect(f.body.length).toBeGreaterThan(1000);
    // The premise every mechanics row rests on, asserted once, here.
    expect(duplicateOverlap(batchPair[0]!, batchPair[1]!).duplicate).toBe(true);
  });

  test("the two share a measured symptom under completely different titles", () => {
    const [a, b] = incident;
    const overlap = duplicateOverlap(a, b);
    expect(overlap.keys).toContain("sym:commandWord");
    expect(overlap.keys).toContain("sym:isDirDestination");
    expect(overlap.keys).toContain("sym:statSync");
  });

  /**
   * ## THEY SHARE A SYMPTOM AND ARE NOT DETECTED, AND THAT IS NOT A BUG (#1333)
   *
   * These rows used to assert `duplicate === true`. That verdict was real
   * and its cause was not: both findings say "merged 15:48", and
   * `quantitiesIn` leaked the hour as `qty:15` — the same key `"it found 15
   * violations"` emits. That one spurious key was the second of exactly two
   * quantities they share, and `qty >= 2` is the first arm's threshold.
   *
   * **We are not losing a capability here; we are finding out we never had
   * one, because the only reason that pair was ever caught was two findings
   * mentioning the same time of day.**
   *
   * So these rows now assert the measurement instead of the verdict. They
   * are still able to fail, and the thing that reddens them is the thing
   * worth hearing about: a change to key extraction.
   */
  test("#1333: the pair is no longer detected, and the numbers say why", () => {
    const [a, b] = incident;
    const overlap = duplicateOverlap(a, b);
    expect(overlap.duplicate).toBe(false);
    // One shared quantity, against a threshold of two. Before the mask it
    // was two, and the second was a clock hour.
    const quantities = overlap.keys.filter(k => k.startsWith("qty:"));
    expect(quantities.length).toBeLessThan(DUPLICATE_MIN_SHARED_QUANTITIES);
    // The leaked key, named, so a regression puts it back in front of a reader.
    expect(quantities).not.toContain("qty:15");
  });

  /**
   * ## THE TIE IS THE FINDING, SO IT IS ASSERTED AS A TIE
   *
   * #1195/#1196 are the same incident. #1195/#1239 are different defects in
   * the same subsystem. On clean keys **both pairs have identical
   * containment**, so no value of `DUPLICATE_CONTAINMENT_RATIO` admits the
   * first and excludes the second. The docblock's claim that 0.8 is
   * separated from 0.6 by "a single pair" was true only while the leak
   * inflated that pair above the other.
   *
   * Written as an EQUALITY BETWEEN THE TWO, deliberately. Two bare
   * assertions on 0.750 would stay green under a change that moved both,
   * and a change that moved both is not news. A change that *separates*
   * them is news, and reddens this.
   */
  test("#1333: the true pair and a distinct pair are tied, so no containment cut separates them", () => {
    const [a, b] = incident;
    const truePair = containmentOf(a, b);
    const distinctPair = containmentOf(a, distinct);

    expect(truePair).toBe(distinctPair);

    // The tie is only meaningful if both are live readings rather than two
    // pairs the key floor refused. A refusal scores 0 and would tie too.
    expect(truePair).toBeGreaterThan(0);
    expect(symptomKeys(distinct).length).toBeGreaterThanOrEqual(DUPLICATE_CONTAINMENT_MIN_KEYS);

    // And the distinct pair really is distinct, or the tie proves nothing.
    expect(duplicateOverlap(a, distinct).duplicate).toBe(false);
  });

  /**
   * THE PAIR IS THE TEST, NOT EITHER ROW.
   *
   * The row below runs the fixtures under their real tracker ids, and it was
   * green on the merged code. The CLI does not produce that input:
   * it labels every unfiled finding `UNFILED_ID`, so the real batch is two
   * findings both carrying `"new"` — and the self-skip guard, keyed on the id
   * string, made each skip the other AS ITSELF. Measured on merged main: 2
   * survivors under `"new"`/`"new"`, 1 under the real ids. A case that is
   * green for a true reason about an input the production caller never sends
   * is the fifth shape in `.claude/rules/checks-must-be-able-to-fail.md`.
   */
  test("BOTH IDS UNFILED — the input the CLI actually sends — still yields one survivor", () => {
    const asNew = batchPair.map(f => ({ ...f, id: UNFILED_ID }));
    const r = arbitrateBatch(asNew, opts({ existing: [], ...eachVotedTheSame(AGREED, asNew.length) }));
    expect(r.toComment.length).toBe(1);
    expect(r.verdicts.filter(v => v.refusal === "DUPLICATE").length).toBe(1);
  });

  test("a finding is never a duplicate of itself, by reference, even when ids collide", () => {
    const [a] = incident;
    const self = arbitrate(a, opts({ existing: [a] }));
    expect(self.refusal).not.toBe("DUPLICATE");
  });

  test("ONE BATCH, EMPTY TRACKER: exactly one of them survives", () => {
    const r = arbitrateBatch(batchPair, opts({ existing: [], ...eachVotedTheSame(AGREED, batchPair.length) }));
    // One posts as a comment on the branch it describes; the other collides
    // with it INSIDE THE BATCH, which is the whole fix.
    expect(r.toComment.length).toBe(1);
    const duplicates = r.verdicts.filter(v => v.refusal === "DUPLICATE");
    expect(duplicates.length).toBe(1);
    expect(duplicates[0].duplicateOf.length).toBeGreaterThan(0);
  });

  test("MUTATION: against a fixed snapshot — the shape this replaced — both read as new", () => {
    // The cheapest wrong fix, performed and measured rather than described:
    // arbitrate each against the SAME empty snapshot, as the first cut did.
    const fixed = batchPair.map(f => arbitrate(f, opts({ existing: [] })));
    expect(fixed.filter(v => v.refusal === "DUPLICATE").length).toBe(0);
    // The control the zero above needs: the SAME pair, through the batch
    // path, does find the duplicate. Without this the row reads the same
    // whether the snapshot is the cause or the pair simply does not collide
    // — which is exactly how it survived #1333 looking healthy.
    const batched = arbitrateBatch(batchPair, opts({ existing: [], ...eachVotedTheSame(AGREED, batchPair.length) }));
    expect(batched.verdicts.filter(v => v.refusal === "DUPLICATE").length).toBe(1);
  });

  test("the walk order is pinned, so the survivor does not depend on array position", () => {
    const forwards = arbitrateBatch(batchPair, opts(eachVotedTheSame(AGREED, batchPair.length)));
    const backwards = arbitrateBatch([...batchPair].reverse(), opts(eachVotedTheSame(AGREED, batchPair.length)));
    const dupOf = (r: typeof forwards) => r.verdicts.find(v => v.refusal === "DUPLICATE")!.id;
    expect(dupOf(forwards)).toBe(dupOf(backwards));
  });
});

describe("AR-10: the dedupe threshold against a real long issue", () => {
  /**
   * The review's hypothesis: *"two shared quantities and one shared location
   * is an absolute threshold, and a long issue that happens to quote many
   * numbers matches almost anything."* Measured rather than accepted, over
   * today's 27 open issues:
   *
   *     gh issue list --repo hornjason/pai-harness --state open \
   *       --limit 400 --json number,title,body
   *
   * All pairs: **1 flagged of 351**, and it is the known class — #1187
   * against #1194, because #1187 quotes other findings' readings verbatim in
   * order to argue from them. The six issues with the most keys (40, 39, 26,
   * 19, 16, 13) were each run against an unrelated new finding and shared
   * **0 or 1** key, never reaching the threshold. #1205 and #1207, named in
   * the review as the shape to check, share **zero** keys with each other.
   *
   * So the fraction-of-the-smaller-set threshold the review proposed as the
   * fallback is **not** taken, and this row is why. The case below is the
   * regression: a key-rich finding must not collide with an unrelated one.
   */
  test("a key-rich finding does not collide with an unrelated one", () => {
    const keyRich: Finding = {
      id: "9100",
      title: "A long finding that quotes many readings",
      body:
        "`collectDestination`, `nonCanonicalRoots`, `PROTECTED_FILES`, `stripHeredocs`, `readWord` " +
        "in `lib/bash-write-guard.ts` and `specs/HOOK-ARCHITECTURE-SPEC.md`. Readings: 144, 234, " +
        "5060, 15, 777, 41, 62, 88, 91, 103, 117, 128, 139, 151, 166.",
    };
    const unrelated: Finding = {
      id: "new",
      title: "The release tag fetch depth drops annotated tags",
      body:
        "`fetchTagDepth` in `lib/release-tags.ts` requests 50 refs but the repo carries 312 tags, " +
        "so 262 annotated tags are invisible. Measured over 4 runs.",
    };
    expect(symptomKeys(keyRich).length).toBeGreaterThan(15);
    expect(duplicateOverlap(keyRich, unrelated).duplicate).toBe(false);
  });
});

describe("AR-11: the citation path is contained before anything is read", () => {
  /**
   * The input on this path is an AI reviewer's output — the one input here
   * nobody audits — and it reaches `readFileSync`. The regex cannot emit a
   * leading `/`, so an absolute path never arrives; `../` does, and
   * `../../../../Users/…/settings.json` carries an allowlisted extension.
   * The payoff is a line count and an existence oracle rather than content,
   * which is why this is a containment check and not a subsystem.
   */
  test("a traversing citation resolves to nothing", () => {
    expect(containedCitationPath(root, "../../../../Users/someone/.claude/settings.json")).toBeNull();
    expect(containedCitationPath(root, "a/../../escape.ts")).toBeNull();
  });

  /**
   * An absolute path is rejected BY CONTAINMENT, not by a second check.
   * `resolve(root, "/etc/hosts.json")` is `/etc/hosts.json`, which is not
   * under the root. A separate `isAbsolute` rejection was written, and
   * removing it changed 0 of 63 cases — so it was deleted rather than kept
   * as a guard no mutation could reach.
   */
  test("an absolute citation resolves to nothing, via the same one check", () => {
    expect(containedCitationPath(root, "/etc/hosts.json")).toBeNull();
  });

  test("CONTROL: an in-tree citation resolves, including through a harmless `..`", () => {
    expect(containedCitationPath(root, "lib/widget.ts")).toBe(join(root, "lib", "widget.ts"));
    expect(containedCitationPath(root, "lib/../widget.ts")).toBe(join(root, "widget.ts"));
  });

  test("a finding citing a traversing path is not refused for staleness it cannot have", () => {
    const v = arbitrate(onMain("`widgetHandler` is wrong at `../../../../etc/passwd.json:99999`."), opts());
    expect(v.refusal).not.toBe("STALE_CITATION");
  });
});

/**
 * The CLI's exit status IS the answer, so the exit codes are the contract and
 * are asserted by spawning the script rather than by calling the library it
 * wraps. `0` posts, `3` files, `1` drops — and the flip is visible right
 * here: the default outcome of a good finding is a comment.
 */
describe("AR-12: the CLI contract", () => {
  const script = join(import.meta.dir, "..", "scripts", "arbitrate-finding.ts");
  let scratch = "";

  const run = (args: string[]): { code: number; out: string } => {
    const r = Bun.spawnSync(["bun", script, "--project-root", root, ...args],
      { stdout: "pipe", stderr: "pipe", env: scratchLedgerEnv(scratch) });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "arbiter-cli-"));
    writeFileSync(join(scratch, "votes.json"), JSON.stringify(AGREED));
    writeFileSync(join(scratch, "body.md"), "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.");
    writeFileSync(join(scratch, "empty.json"), "[]");
    // The shape caught end-to-end: entries with neither `number` nor `id`.
    writeFileSync(join(scratch, "nameless.json"), JSON.stringify([{ title: "t", body: "b" }]));
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const base = (extra: string[] = []) => [
    "--title", "an unrelated reading",
    "--body-file", join(scratch, "body.md"),
    "--existing", join(scratch, "empty.json"),
    ...extra,
  ];

  test("a good finding exits 0 and says COMMENT — filing is no longer the default", () => {
    const r = run(base(["--votes", join(scratch, "votes.json")]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("COMMENT");
  });

  test("the same finding declared out of scope exits 3 and says ISSUE", () => {
    const r = run(base(["--votes", join(scratch, "votes.json"), "--out-of-scope", "another subsystem owns it"]));
    expect(r.code).toBe(3);
    expect(r.out).toContain("ISSUE");
  });

  test("no --votes exits 1 — a finding nobody voted on has not cleared a quorum", () => {
    const r = run(base());
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
  });

  /**
   * A DUPLICATE withholds a finding, so it has to name WHERE the symptom is
   * already reported or it is not reviewable. A population entry with no
   * identifier produced `"already reported as undefined, undefined"` — a
   * refusal nobody can act on, which is worse than no refusal.
   */
  test("a population entry with no identifier refuses, rather than refusing by name of nothing", () => {
    const r = run([
      "--title", "an unrelated reading",
      "--body-file", join(scratch, "body.md"),
      "--existing", join(scratch, "nameless.json"),
      "--votes", join(scratch, "votes.json"),
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).not.toContain("undefined, undefined");
  });

  test("--comment renders the posted text, carrying the obligation to answer", () => {
    const r = run(base(["--votes", join(scratch, "votes.json"), "--comment"]));
    expect(r.out).toContain("resolve this thread with a reason");
    expect(r.out).toContain("**Important**");
  });
});

/**
 * NON-TRANSITIVITY IS DELIBERATE, and this is the control that says so.
 *
 * A peer measuring this repo's tracker found that declared duplicates are
 * filed in CHAINS — #547 names #530, which is itself a duplicate — and that a
 * one-hop reader misses most of them. That is true of their instrument and
 * false of this one, and the difference is the whole reason this case exists:
 * **their links are DECLARED and this key's edges are INFERRED.** Transitivity
 * is sound over a declaration and unsound over a similarity.
 *
 * Measured over 220 issues from this tracker:
 *
 *     gh issue list --repo hornjason/pai-harness --state all --limit 220 \
 *       --json number,title,body,state,stateReason
 *
 * 37 edges, and **50 open two-paths** of exactly the shape below — so the
 * chain shape is common, not rare. Closing them transitively would merge the
 * largest connected component, which holds **12 manifestly different issues**
 * (a timezone-frame comparison, a test-census disagreement, a consumer
 * tarball test, a hook registration 178 commits behind) into one symptom,
 * withholding eleven real findings.
 *
 * The component is also held up by one node: **9 of its 12 edges touch #1187
 * itself**, which is an issue *about* other findings and quotes their
 * readings in order to argue from them. And the edges are weak — 3 to 5
 * shared keys, typically a commonly-cited rules file plus two incidental
 * integers — where both genuinely-duplicate pairs score **7**, and
 * #1195/#1196's seven include five symbols naming the same functions.
 *
 * So the greedy one-hop walk is the correct instrument here, and a later
 * change to a transitive or union-find dedupe is a regression. This case
 * turns that change red.
 */
describe("AR-13: the dedupe is one-hop on purpose", () => {
  // A and B share a reading; B and C share a different one; A and C share
  // only the file. The same shape as the 50 measured on the real tracker.
  const A: Finding = { id: "A", title: "alpha reading", body: "`alphaHandler` in `lib/x.ts` mishandles 111 of 222 operands." };
  const B: Finding = { id: "B", title: "both readings", body: "`alphaHandler` in `lib/x.ts` mishandles 111 of 222 operands, and `betaHandler` leaks 333 across 444 runs." };
  const C: Finding = { id: "C", title: "beta reading", body: "`betaHandler` in `lib/x.ts` leaks 333 descriptors across 444 runs." };

  test("the fixture is a chain, not a clique — the premise this rests on", () => {
    expect(duplicateOverlap(A, B).duplicate).toBe(true);
    expect(duplicateOverlap(B, C).duplicate).toBe(true);
    // The open edge. Without this the case would be about a clique and would
    // prove nothing about transitivity.
    expect(duplicateOverlap(A, C).duplicate).toBe(false);
  });

  test("a batch drops the middle and KEEPS both ends", () => {
    const r = arbitrateBatch([A, B, C].map(f => ({ ...f, id: UNFILED_ID })), opts({ existing: [], ...eachVotedTheSame(AGREED, 3) }));
    expect(r.verdicts.filter(v => v.refusal === "DUPLICATE").length).toBe(1);
    // Two survivors, not one. A transitive dedupe would return one here and
    // would be withholding a finding nothing says is a duplicate of anything.
    expect(r.toComment.length).toBe(2);
  });
});

/**
 * AR-14: the candidate ledger.
 *
 * Every number this module's two filters rest on is a default rather than a
 * measurement, and the reason is the same in both cases: **nothing records a
 * finding before it is filed.** The tracker is post-filing by construction.
 * So the population that would price the quorum and the category filter is
 * not somewhere we have not looked — it does not exist, and the only moment
 * it can be written down is the moment a candidate is withheld.
 *
 * That makes the WITHHELD rows the entire point of this structure, and it is
 * what every case below is pointed at. A ledger that recorded only what got
 * posted would be a second copy of `toComment`.
 */
describe("AR-14: the candidate ledger — the withheld rows are the point", () => {
  /** Distinct measured readings, so no two of these collide by symptom. */
  const outOfScope = (n: number): Finding => ({
    id: `s${n}`,
    title: `reading ${n}`,
    body: `\`widgetHandler\` leaks ${100 + n} descriptors across ${900 + n} runs.`,
    outOfScope: { reason: "a different subsystem owns this" },
  });
  const inScope = (n: number): Finding => ({
    id: `c${n}`,
    title: `reading ${n}`,
    body: `\`alphaHandler${n}\` drops ${200 + n} of ${800 + n} messages.`,
  });
  /** `typo` is `DROP_SIGNALS`' style vocabulary, and the scope is the title. */
  const styleNit: Finding = {
    id: "nitpicked",
    title: "fix the typo in the banner",
    body: "`bannerText` is spelled wrong in 1 of 2 places.",
  };

  /**
   * One batch carrying every bucket the ledger can report except
   * `NO_QUORUM`, which is batch-wide — `ArbitrateOptions.votes` is one ballot
   * for the whole call, so a dissenting group cannot sit beside an agreeing
   * one in a single batch. It gets its own case below.
   *
   * The integers are predicted here and asserted, rather than read off the
   * run: `FILING_BUDGET_FINDINGS + 2` out-of-scope findings file the budget
   * and evict exactly two.
   */
  const mixed = () => {
    const filed: Finding = {
      id: "9001",
      title: "already filed",
      body: "`zetaHandler` fails 311 of 742 times.",
    };
    const dup: Finding = {
      id: UNFILED_ID,
      title: "reworded, same symptom",
      body: "742 runs, 311 failures in `zetaHandler`.",
    };
    const findings = [
      inScope(1),
      styleNit,
      dup,
      ...Array.from({ length: FILING_BUDGET_FINDINGS + 2 }, (_, i) => outOfScope(i)),
    ];
    return {
      findings,
      reading: arbitrateBatch(findings, opts({ existing: [filed], ...eachVotedTheSame(AGREED, findings.length) })),
    };
  };

  test("THE POPULATION: one row per input finding, in input order, ids included", () => {
    const { findings, reading } = mixed();
    expect(reading.candidates.length).toBe(findings.length);
    expect(reading.candidates.map(c => c.id)).toEqual(findings.map(f => f.id));
  });

  /**
   * THE CONTROL FOR EVERY ZERO BELOW.
   *
   * Read this row first. The counts here are the planted ones, so a later
   * assertion that some bucket is empty means the bucket was looked at and
   * found empty — rather than the ledger having stopped reporting.
   */
  test("CONTROL: the planted batch reaches four distinct buckets, at the predicted counts", () => {
    const { reading } = mixed();
    const count = (w: string) => reading.candidates.filter(c => c.withheldBy === w).length;
    expect(count("DUPLICATE")).toBe(1);
    expect(count("DROPPED_CATEGORY")).toBe(1);
    expect(count("OVER_BUDGET")).toBe(2);
    expect(reading.candidates.filter(c => c.emitted).length).toBe(1 + FILING_BUDGET_FINDINGS);
    expect(reading.candidates.filter(c => c.withheldBy === "UNACCOUNTED")).toEqual([]);
  });

  test("emitted and withheldBy are one fact: null exactly when it reached a reader", () => {
    const { reading } = mixed();
    for (const c of reading.candidates) {
      expect(c.emitted).toBe(c.withheldBy === null);
    }
    const emitted = reading.candidates.filter(c => c.emitted).map(c => c.id).sort();
    expect(emitted).toEqual([...reading.toComment, ...reading.toFile].sort());
  });

  /**
   * THE TWO FILTERS STAY IN SEPARATE BUCKETS.
   *
   * This is the property the A/B rests on, and it is the one a tidy-up would
   * take away first: `NO_QUORUM` and `DROPPED_CATEGORY` are both "a filter
   * withheld it", and folding them into one `SUPPRESSED` would read as a
   * simplification. It would also make the quorum and the category filter
   * impossible to price apart, because the attribution lives in which pair of
   * summaries you compare and nowhere else.
   */
  test("NO_QUORUM and DROPPED_CATEGORY are different values, not one 'suppressed'", () => {
    const dissent: VerifierVote[] = [
      { verifier: "v1", real: true, reason: "reproduced" },
      { verifier: "v2", real: false, reason: "could not reproduce" },
      { verifier: "v3", real: false, reason: "could not reproduce" },
    ];
    const noQuorum = arbitrateBatch([inScope(1), inScope(2)], opts(eachVotedTheSame(dissent, 2)));
    expect(noQuorum.candidates.map(c => c.withheldBy)).toEqual(["NO_QUORUM", "NO_QUORUM"]);
    expect(noQuorum.candidates.every(c => c.emitted)).toBe(false);

    const dropped = mixed().reading.candidates.filter(c => c.withheldBy === "DROPPED_CATEGORY");
    expect(dropped.length).toBe(1);
    // The separation itself, stated as the assertion rather than implied by
    // the two rows above being in different tests.
    expect(new Set([...noQuorum.candidates, ...dropped].map(c => c.withheldBy)).size).toBe(2);
  });

  /**
   * THE INPUT THE CLI ACTUALLY SENDS.
   *
   * Every unfiled finding carries `UNFILED_ID`, so ids are not unique within
   * a batch. Keying emission on the id — the obvious way to write this —
   * marks BOTH incident rows emitted the moment either one is, so the
   * duplicate that was withheld is recorded as having been posted. The
   * ledger would then report the opposite of the thing it exists to record.
   *
   * The subject is that cross-contamination, NOT the #1195/#1196 pair, and
   * the input used to be the incident fixture. #1333 removed a key leak
   * that was the only reason that pair read as a duplicate at all, so the
   * fixture stopped exercising this property — and the fixture was swapped
   * rather than the claim weakened, because any duplicate pair in one batch
   * will do. Two re-reports of one symptom under different titles are a
   * duplicate for a reason nothing in #1333 touches.
   */
  test("duplicate ids do not cross-contaminate: one row emitted, one withheld", () => {
    const sameSymptom = (title: string): Finding => ({
      id: UNFILED_ID,
      title,
      body: "`zetaHandler` fails 311 of 742 times in `lib/z.ts`.",
    });
    const incident = [sameSymptom("one wording"), sameSymptom("another wording")];
    const r = arbitrateBatch(incident, opts({ existing: [], ...eachVotedTheSame(AGREED, incident.length) }));
    // The premise, asserted rather than assumed: this input really is a
    // duplicate pair, or every row below holds vacuously.
    expect(duplicateOverlap(incident[0]!, incident[1]!).duplicate).toBe(true);
    expect(r.candidates.map(c => c.id)).toEqual([UNFILED_ID, UNFILED_ID]);
    expect(r.candidates.filter(c => c.emitted).length).toBe(1);
    expect(r.candidates.filter(c => c.withheldBy === "DUPLICATE").length).toBe(1);
    // The symptom hash is what distinguishes them, and it is the only join
    // key a never-filed candidate has. Both rows carry one.
    expect(r.candidates.every(c => c.symptomHash.length > 0)).toBe(true);
  });

  /**
   * A candidate refused UNMEASURED and a candidate the BATCH could not
   * evaluate are different rows, and the first set is what explains the
   * second. Collapsing them loses the only evidence of why the fold happened.
   */
  test("BATCH_UNMEASURED is distinguishable from the row that caused it", () => {
    const vague: Finding = { id: "vague", title: "slow", body: "it feels slow" };
    const r = arbitrateBatch([outOfScope(1), outOfScope(2), vague], opts(eachVotedTheSame(AGREED, 3)));
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.toFile).toEqual([]);
    const by = Object.fromEntries(r.candidates.map(c => [c.id, c.withheldBy]));
    expect(by["vague"]).toBe("UNMEASURED");
    expect(by["s1"]).toBe("BATCH_UNMEASURED");
    expect(by["s2"]).toBe("BATCH_UNMEASURED");
    // The shape being guarded against: the promoter still ranked a list, so
    // "over budget" is available here and would be the plausible wrong answer.
    expect(r.promotion.promoted.length).toBeGreaterThan(0);
  });

  /**
   * THE CASE THAT BINDS THE PRECEDENCE, found by the mutation that was meant
   * to break the row above and broke nothing.
   *
   * In that row the promoter withheld nothing, so consulting it first or
   * second gave the same answer and the ordering was a second decider no
   * case could see (`.claude/rules/checks-must-be-able-to-fail.md`, fourth
   * shape). This input separates them: the batch is UNMEASURED **and** over
   * budget, so the promoter has a real `OVER_BUDGET` reason for two rows.
   *
   * `BATCH_UNMEASURED` has to win. Nothing was filed at all — `toFile` is
   * empty — so recording two of eight candidates as "ranked below the cut"
   * describes a cut that was never applied, off a ranking taken over a
   * population that could not be evaluated.
   */
  test("an UNMEASURED batch that is ALSO over budget reports the fold, not the cut", () => {
    const vague: Finding = { id: "vague", title: "slow", body: "it feels slow" };
    const over = Array.from({ length: FILING_BUDGET_FINDINGS + 2 }, (_, i) => outOfScope(i));
    const r = arbitrateBatch([...over, vague], opts(eachVotedTheSame(AGREED, over.length + 1)));
    expect(r.promotion.reading).toBe("UNMEASURED");
    expect(r.toFile).toEqual([]);
    // The promoter really did produce the plausible wrong answer for two of
    // them — without this the row below could be vacuous.
    expect(r.promotion.withheld.filter(w => w.reason === "OVER_BUDGET").length).toBe(2);
    expect(r.candidates.filter(c => c.withheldBy === "OVER_BUDGET")).toEqual([]);
    expect(r.candidates.filter(c => c.withheldBy === "BATCH_UNMEASURED").length).toBe(over.length);
  });

  test("the withheld reason is the promoter's own, read rather than re-derived", () => {
    const { reading } = mixed();
    const overBudget = reading.candidates.filter(c => c.withheldBy === "OVER_BUDGET").map(c => c.id);
    const promoterSaid = reading.promotion.withheld
      .filter(w => w.reason === "OVER_BUDGET")
      .map(w => reading.candidates[Number(w.candidate.source.replace(/^finding:/, ""))]!.id);
    expect(overBudget.sort()).toEqual(promoterSaid.sort());
    expect(overBudget.length).toBe(2);
  });
});

/**
 * AR-15: the ledger is sufficient for `compareReviewOutcomes`, and the two
 * filters come out priced apart.
 *
 * `compareReviewOutcomes` refuses a population mismatch by design, so a
 * filter can only be graded against a corpus of the SAME size in which the
 * withheld rows are present and flagged. That corpus is exactly this ledger,
 * read three times:
 *
 * | summary | rows flagged `suppressed` |
 * |---|---|
 * | baseline | none |
 * | quorum-only | `withheldBy === "NO_QUORUM"` |
 * | both | `NO_QUORUM` or `DROPPED_CATEGORY` |
 *
 * `compare(baseline, quorumOnly)` prices the quorum; `compare(quorumOnly,
 * both)` prices the category filter on top of it. Nothing in the comparison
 * says which filter it is looking at — the attribution is entirely in which
 * pair you compare, which is why the ledger has to keep the two buckets
 * apart and why folding them into one `SUPPRESSED` would end this.
 *
 * ## WHAT THIS IS NOT
 *
 * **It is not a measurement of either filter.** The outcomes below are
 * planted so the two comparisons come out in OPPOSITE directions, which is
 * the demonstration: one ledger, two prices, one of them a regression. The
 * real numbers need a corpus of live batches with real outcomes attached
 * later, and the whole reason this structure exists is that no such corpus
 * can be reconstructed from anything we have today.
 *
 * ## Why the corpus is two batches
 *
 * The quorum runs BEFORE the category check in `arbitrate`, and a batch
 * carries one ballot, so a `NO_QUORUM` row and a `DROPPED_CATEGORY` row
 * cannot come from the same call. Ledgers concatenate — which is how a real
 * A/B would run it anyway, one batch per pull request.
 */
describe("AR-15: one ledger, three summaries, the two filters priced apart", () => {
  const measurable = (n: number): Finding => ({
    id: `m${n}`,
    title: `reading ${n}`,
    body: `\`alphaHandler${n}\` drops ${200 + n} of ${800 + n} messages.`,
  });
  const styleNit: Finding = {
    id: "nitpicked",
    title: "fix the typo in the banner",
    body: "`bannerText` is spelled wrong in 1 of 2 places.",
  };
  const DISSENT: VerifierVote[] = [
    { verifier: "v1", real: true, reason: "reproduced" },
    { verifier: "v2", real: false, reason: "could not reproduce" },
    { verifier: "v3", real: false, reason: "could not reproduce" },
  ];

  // Each batch names itself, which is what makes `key` usable as the corpus
  // id across the concatenation. Two batches, because the quorum runs before
  // the category check and one call carries one ballot.
  const corpus = (): CandidateRecord[] => [
    ...arbitrateBatch([measurable(11), measurable(12)], opts({ batch: "pr-a", ...eachVotedTheSame(DISSENT, 2) })).candidates,
    ...arbitrateBatch([measurable(21), styleNit, measurable(22)], opts({ batch: "pr-b", ...eachVotedTheSame(AGREED, 3) })).candidates,
  ];

  /**
   * What each candidate WOULD have come to had nothing withheld it. In a real
   * A/B these arrive from the tracker months later; here they are planted, and
   * they are the only planted thing.
   */
  type Known = { closed: boolean; declared: FindingDisposition | null; fixed?: boolean };
  const KNOWN: Known[] = [
    { closed: true, declared: "wrong" }, // 0  NO_QUORUM, and it was noise
    { closed: true, declared: null }, // 1  NO_QUORUM, closed with nothing landed
    { closed: true, declared: null, fixed: true }, // 2  posted, and fixed
    { closed: true, declared: null, fixed: true }, // 3  DROPPED_CATEGORY, and REAL
    { closed: true, declared: "intentional" }, // 4  posted, and noise
  ];

  const bridge = (
    ledger: readonly CandidateRecord[],
    suppress: (c: CandidateRecord) => boolean,
  ): ReviewFinding[] =>
    ledger.map((c, i) => ({
      // `CandidateRecord.key` — the landed form of what #1273 wrote this
      // line as a placeholder for.
      //
      // #1258 keyed this on `c.symptomHash` and that was wrong (#1272).
      // `symptomHash` hashes the SORTED SYMPTOM KEY SET, so one reading
      // written two ways hashes the same — while the dedupe matches on the
      // key INTERSECTION, so two genuine duplicates can hash differently. It
      // is a similarity identity, and a row identity is a different thing.
      // Keying a corpus on it collides exactly on the pair the ledger exists
      // to record, trips the duplicate refusal added in #1253, and reads as a
      // broken emitter rather than as the wrong key.
      //
      // #1273 then keyed it on the position in this ledger, which is unique
      // by construction and correct for a single corpus. It does not survive
      // a join to anything outside one — and this corpus is already two
      // batches concatenated, so the index is global here only because the
      // test happens to build both halves in one expression. `key` is
      // `${batch}/${index}`: unique across every ledger produced under
      // distinct batch names, `null` when the caller names none. AR-17
      // measures why neither of the other two fields can do it.
      id: c.key!,
      filedAt: 1_000,
      closed: KNOWN[i]!.closed,
      citations: KNOWN[i]!.fixed === true ? [{ sha: `c${i}`, at: 2_000, filesChanged: 3 }] : [],
      closedInFavourOf: [],
      declared: KNOWN[i]!.declared,
      suppressed: suppress(c),
    }));

  const summarise = (ledger: readonly CandidateRecord[], label: string, s: (c: CandidateRecord) => boolean) =>
    summariseFindingOutcomes(readFindingOutcomes(bridge(ledger, s), new Set<string>()), label);

  test("CONTROL: the corpus carries both buckets, at the positions the outcomes assume", () => {
    const ledger = corpus();
    expect(ledger.length).toBe(KNOWN.length);
    expect(ledger.map(c => c.withheldBy)).toEqual([
      "NO_QUORUM",
      "NO_QUORUM",
      null,
      "DROPPED_CATEGORY",
      null,
    ]);
  });

  test("the quorum reads IMPROVED and the category filter on top of it reads REGRESSION", () => {
    const ledger = corpus();
    const baseline = summarise(ledger, "every candidate, nothing withheld", () => false);
    const quorumOnly = summarise(ledger, "quorum applied", c => c.withheldBy === "NO_QUORUM");
    const both = summarise(ledger, "quorum and category applied", c =>
      c.withheldBy === "NO_QUORUM" || c.withheldBy === "DROPPED_CATEGORY");

    // Same corpus three times. A size difference here is the one thing
    // `compareReviewOutcomes` refuses outright, so it is asserted and not
    // assumed.
    expect([baseline.population, quorumOnly.population, both.population]).toEqual([5, 5, 5]);
    expect([baseline.suppressed, quorumOnly.suppressed, both.suppressed]).toEqual([0, 2, 3]);

    const quorumPrice = compareReviewOutcomes(baseline, quorumOnly);
    expect(quorumPrice.verdict).toBe("IMPROVED");
    expect(quorumPrice.fixedDelta).toBe(0);
    expect(quorumPrice.costDelta).toBe(-2);

    const categoryPrice = compareReviewOutcomes(quorumOnly, both);
    expect(categoryPrice.verdict).toBe("REGRESSION");
    expect(categoryPrice.fixedDelta).toBe(-1);
  });

  /**
   * THE FOLD, PERFORMED. If the ledger named one `SUPPRESSED` for both
   * filters, the only summary a consumer could build is the "both" one — and
   * the regression the category filter caused would be reported as the
   * quorum's price, with no second comparison available to separate them.
   */
  test("MUTATION: with the buckets folded, the quorum is blamed for the category filter's loss", () => {
    const ledger = corpus();
    const folded = ledger.map(c => ({
      ...c,
      withheldBy: c.withheldBy === "DROPPED_CATEGORY" ? "NO_QUORUM" : c.withheldBy,
    })) as CandidateRecord[];
    const baseline = summarise(folded, "every candidate", () => false);
    const oneBucket = summarise(folded, "the only filter a folded ledger can describe", c =>
      c.withheldBy === "NO_QUORUM");
    const priced = compareReviewOutcomes(baseline, oneBucket);
    expect(priced.verdict).toBe("REGRESSION");
    // The quorum lost nothing. Under the fold it is charged for the one real
    // finding the CATEGORY filter dropped, and no further comparison exists
    // that could tell them apart.
    expect(priced.fixedDelta).toBe(-1);
  });

  // #1272: the bridge's key must be unique by construction, and `symptomHash`
  // is not. It hashes the SORTED SYMPTOM KEY SET, so one reading written two
  // ways hashes the same — while the dedupe matches on the key INTERSECTION,
  // so two genuine duplicates can hash differently. Neither a unique key nor
  // a duplicate key: a similarity identity, which is a different thing from a
  // row identity.
  //
  // The five candidates above happen to hash distinctly, so keying on the
  // hash passed every case in this file while the property it implied was
  // false — `.claude/rules/checks-must-be-able-to-fail.md`, third shape. The
  // pair below is the one the ledger EXISTS to record: an original and the
  // exact re-report that was withheld against it.
  test("#1272: two wordings of one reading are two rows, so the bridge keys them apart", () => {
    const wordedA: Finding = {
      id: "w1",
      title: "`alphaHandler11` drops messages",
      body: "`alphaHandler11` drops 211 of 811 messages.",
    };
    const wordedB: Finding = {
      id: "w2",
      title: "messages lost in `alphaHandler11`",
      body: "Of 811 handled, `alphaHandler11` loses 211.",
    };

    // CONTROL: without this the case is vacuous — it would assert that two
    // rows with different hashes get different ids, which any keying does.
    expect(symptomHash(wordedA)).toBe(symptomHash(wordedB));

    // The batch is named, because `key` is `null` without one and a null id
    // would make this case pass or fail for a reason about the fixture
    // rather than about the keying. AR-17 covers the unnamed reading.
    const pair = arbitrateBatch([wordedA, wordedB], opts({ batch: "pr-1272", ...eachVotedTheSame(DISSENT, 2) })).candidates;
    expect(pair.length).toBe(2);

    const ids = bridge(pair, () => false).map(f => f.id);
    expect(new Set(ids).size).toBe(2);

    // And the consequence, which is why the key matters rather than being
    // tidiness: a duplicate id makes `summariseFindingOutcomes` refuse the
    // whole corpus (#1253), so a collision here reads as a broken emitter
    // rather than as the wrong key.
    const read = summariseFindingOutcomes(
      readFindingOutcomes(bridge(pair, () => false), new Set<string>()),
      "#1272 colliding pair",
    );
    expect(read.detail.join(" ")).not.toContain("duplicate finding ids");
  });
});

/**
 * AR-16: a malformed ballot is UNMEASURED, not a dissent (#1235).
 *
 * `readVotes` cast the parsed JSON to `VerifierVote[]` with no shape check, and
 * `juryReading` counts agreement with `votes.filter(v => v.real)` — a truthy
 * test. **The string `"false"` is truthy**, so a verifier who wrote
 * `"real": "false"` was counted as agreeing. Measured on `origin/main` through
 * the CLI below before the fix: a ballot in which all three verifiers rejected
 * the finding, two of them spelling it `"false"`, exited **0** and printed
 * `2 of 3 verifiers agree`. The jury passed a finding its verifiers rejected,
 * which is the one outcome it exists to prevent.
 *
 * ## The two cases are doing different jobs, and the battery says which
 *
 * The cheapest wrong fix — coerce `"false"` to `false` and count it as a no —
 * was applied by hand to `parseVotes` and measured. Both cases stay red under
 * it, **on different assertions**, and that is the whole reason there are two:
 *
 * | case | coerced reading | red on |
 * |---|---|---|
 * | `A` | `exit 1` · `DROP new (NO_QUORUM): 0 of 3 verifiers called it real` | the reading only |
 * | `B` | `exit 0` · `COMMENT … 2 of 3 verifiers agree` | the exit code |
 *
 * `A` is the defect — a rejection read as agreement — and it is the direction
 * assertion the issue asks for. But its exit code is `1` under **both** fixes,
 * so an exit-code-only `A` would have gone green and certified the coercion.
 * The `toContain("UNMEASURED")` line is what separates them, and it is load-
 * bearing rather than decorative.
 *
 * `B` is the case that chose the fix on behaviour: under coercion the ballot
 * still clears a 2-of-3 quorum and the finding still posts. Coercion is
 * rejected because a vote nobody can read is not a vote somebody cast —
 * inventing the dissent is a second reading nobody took
 * (`.claude/rules/config-access.md`'s *Silent Default Substitution*, and the
 * standing position that a reading which could not be taken is not a reading
 * that passed).
 *
 * Nor is the bad entry dropped from the ballot. That would leave two votes
 * against a declared group of three and refuse as `INCOMPLETE_GROUP` — "a
 * verifier did not report", when in fact it reported unreadably. Different
 * facts, and the refusal has to name the right one.
 */
describe("AR-16: a malformed ballot is UNMEASURED, not a dissent", () => {
  const script = join(import.meta.dir, "..", "scripts", "arbitrate-finding.ts");
  let scratch = "";

  const run = (votesFile: string): { code: number; out: string } => {
    const r = Bun.spawnSync(
      ["bun", script, "--project-root", root,
       "--title", "an unrelated reading",
       "--body-file", join(scratch, "body.md"),
       "--existing", join(scratch, "empty.json"),
       "--votes", join(scratch, votesFile)],
      { stdout: "pipe", stderr: "pipe", env: scratchLedgerEnv(scratch) },
    );
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  };

  const ballot = (name: string, votes: unknown): string => {
    writeFileSync(join(scratch, name), JSON.stringify(votes));
    return name;
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "arbiter-ballot-"));
    writeFileSync(join(scratch, "body.md"), "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.");
    writeFileSync(join(scratch, "empty.json"), "[]");

    // A — all three verifiers rejected it; two spelled the rejection `"false"`.
    ballot("A.json", [
      { verifier: "v1", real: "false", reason: "could not reproduce" },
      { verifier: "v2", real: "false", reason: "could not reproduce" },
      { verifier: "v3", real: false, reason: "could not reproduce" },
    ]);
    // B — one unreadable vote among two genuine yeses. Coercion leaves this at
    // 2 of 3 and still passing; only a refusal of the whole ballot turns it red.
    ballot("B.json", [
      { verifier: "v1", real: "false", reason: "could not reproduce" },
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: true, reason: "reproduced" },
    ]);
    ballot("no-verifier.json", [
      { real: true, reason: "reproduced" },
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: true, reason: "reproduced" },
    ]);
    ballot("not-an-object.json", [
      "v1 says yes",
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: true, reason: "reproduced" },
    ]);
    // The control. Every refusal above has to be the ballot's shape and not the
    // finding, so the same finding on a well-formed ballot must still post.
    ballot("control.json", [
      { verifier: "v1", real: true, reason: "reproduced" },
      { verifier: "v2", real: true, reason: "reproduced" },
      { verifier: "v3", real: false, reason: "could not reproduce" },
    ]);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("the control posts — the refusals below are about the ballot, not the finding", () => {
    const r = run("control.json");
    expect(r.code).toBe(0);
    expect(r.out).toContain("COMMENT");
  });

  test('A: `real: "false"` from every verifier no longer reads as agreement', () => {
    const r = run("A.json");
    // Before the fix this was `0` and `2 of 3 verifiers agree`, on a ballot
    // where nobody agreed. The count is asserted as well as the exit, because
    // a refusal for some unrelated reason would satisfy the exit alone.
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).not.toContain("verifiers agree");
  });

  test('B: one `"false"` among two yeses refuses — it is not silently a no vote', () => {
    const r = run("B.json");
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    // The refusal must name the unreadable vote, not a short group: dropping
    // the entry instead of refusing the ballot would report INCOMPLETE_GROUP.
    expect(r.out).toContain("vote 0");
    expect(r.out).not.toContain(INCOMPLETE_GROUP);
  });

  test("a vote with no `verifier` refuses — an anonymous vote is not independence", () => {
    const r = run("no-verifier.json");
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    expect(r.out).toContain("verifier");
  });

  test("an entry that is not an object refuses", () => {
    const r = run("not-an-object.json");
    expect(r.code).toBe(1);
    expect(r.out).toContain("UNMEASURED");
  });
});


/**
 * AR-17: the corpus key.
 *
 * `evals/ai-review-control/outcomes.ts` scores a corpus keyed by one field,
 * and a repeated key there does not weaken a score — it inverts one. Two
 * rows sharing a key meant the second overwrote the first, so a finding with
 * a real fixing commit read `NO_ACTION` and landed in `cost`: noise
 * manufactured out of a fix, which `compareReviewOutcomes` would then grade
 * as a regression that never happened.
 *
 * The obvious key for a candidate nobody filed is its symptom hash. The
 * rows below measure why that is wrong, and why the ledger reports an absent
 * key rather than a plausible one.
 */
describe("AR-17: the corpus key is unique by construction, or it is absent", () => {
  /** Identical readings under different wordings. Both unfiled. */
  const reReport = (title: string): Finding => ({
    id: UNFILED_ID,
    title,
    body: "`zetaHandler` fails 311 of 742 times in `lib/z.ts`.",
  });

  /**
   * THE CONTROL, AND THE MEASUREMENT. Read this before the rows after it:
   * it establishes that the collision is real and present in this fixture,
   * so a later assertion about distinct keys is not holding vacuously.
   */
  test("CONTROL: symptomHash collides — 1 distinct hash across 2 rows", () => {
    const r = arbitrateBatch([reReport("one wording"), reReport("another wording")], opts(eachVotedTheSame(AGREED, 2)));
    expect(r.candidates.length).toBe(2);
    expect(new Set(r.candidates.map(c => c.symptomHash)).size).toBe(1);
    // And the ids collide too, for the separate reason that neither is filed.
    expect(new Set(r.candidates.map(c => c.id))).toEqual(new Set([UNFILED_ID]));
    // One posted, one withheld: exactly the pair a corpus must keep apart.
    expect(r.candidates.map(c => c.withheldBy)).toEqual([null, "DUPLICATE"]);
  });

  /**
   * The hash does not identify the collision either, which is the half that
   * is easy to miss: the dedupe matches on SHARED keys, not on the whole
   * set, so two findings can be duplicates of each other and hash apart.
   *
   * This read `#1195`/`#1196` until #1333. That pair's only shared quantity
   * was `qty:15`, extracted out of the clock time `15:48` by a `:\d+` rule
   * that ate the minutes and left the hour, and masking the leak drops them
   * below the quantity floor — so the pair can no longer carry the premise
   * this case needs. `#1175`/`#1177` are a duplicate on three real shared
   * quantities (`144`, `234`, `5060`) and 7-vs-14 keys, which is the same
   * property measured on a pair the mask does not touch.
   */
  test("the real #1175/#1177 pair are duplicates with DIFFERENT hashes", () => {
    const incident = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "finding-incident-1175-1177.json"), "utf-8"),
    ) as Finding[];
    expect(duplicateOverlap(incident[0]!, incident[1]!).duplicate).toBe(true);
    // Named, so the next leak of this shape reddens here instead of being
    // absorbed: the match must not rest on a fragment of a clock time.
    expect(duplicateOverlap(incident[0]!, incident[1]!).keys.filter(k => k.startsWith("qty:")))
      .toEqual(["qty:144", "qty:234", "qty:5060"]);
    const r = arbitrateBatch(incident.map(f => ({ ...f, id: UNFILED_ID })), opts(eachVotedTheSame(AGREED, incident.length)));
    expect(new Set(r.candidates.map(c => c.symptomHash)).size).toBe(2);
  });

  test("named a batch, every key is distinct even where the hash and the id are not", () => {
    const r = arbitrateBatch([reReport("one wording"), reReport("another wording")], opts({ batch: "pr-1251", ...eachVotedTheSame(AGREED, 2) }));
    expect(r.candidates.map(c => c.key)).toEqual(["pr-1251/0", "pr-1251/1"]);
    expect(new Set(r.candidates.map(c => c.key)).size).toBe(r.candidates.length);
  });

  test("two batches concatenate without collision, which is the corpus a consumer builds", () => {
    const a = arbitrateBatch([reReport("one wording"), reReport("another wording")], opts({ batch: "pr-1" }));
    const b = arbitrateBatch([reReport("one wording"), reReport("another wording")], opts({ batch: "pr-2" }));
    const corpus = [...a.candidates, ...b.candidates];
    expect(new Set(corpus.map(c => c.key)).size).toBe(4);
  });

  /**
   * NOT A GAP. A ledger whose caller named no batch cannot be concatenated
   * with another, and `null` says so at the point of use. A key invented
   * here would collide with the next batch's first row and shrink the corpus
   * silently, which is the one direction the instrument must not fail in.
   */
  test("unnamed, the key is absent rather than plausible", () => {
    const r = arbitrateBatch([reReport("one wording"), reReport("another wording")], opts(eachVotedTheSame(AGREED, 2)));
    expect(r.candidates.map(c => c.key)).toEqual([null, null]);
  });

  /**
   * WHAT EVERY ROW ABOVE HOLDS FIXED: each `arbitrateBatch` call is given a
   * batch name no other call uses. That is the axis the mutations never
   * vary, so none of their counts could have come back wrong about it
   * (`.claude/rules/checks-must-be-able-to-fail.md`, seventh shape).
   *
   * Written out, the gap is the caller's obligation and the ledger cannot
   * discharge it: `arbitrateBatch` sees one call and has no way to know a
   * name was used before. Reusing one collides exactly as a default would,
   * and the row below is here so that is discovered on this line rather
   * than in a corpus that quietly halved.
   */
  test("the batch name must be unique PER CALL — the ledger cannot check this for you", () => {
    const one = arbitrateBatch([reReport("one wording")], opts({ batch: "pr-1" }));
    const two = arbitrateBatch([reReport("another wording")], opts({ batch: "pr-1" }));
    const corpus = [...one.candidates, ...two.candidates];
    expect(corpus.length).toBe(2);
    // Not an endorsement — a statement of the contract's edge. Downstream,
    // `summariseFindingOutcomes` refuses a repeated key rather than scoring
    // it, so this surfaces as a refusal and never as a quiet shrink.
    expect(new Set(corpus.map(c => c.key)).size).toBe(1);
  });
});

/**
 * AR-18: the ballot is about a finding (#1297).
 *
 * `arbitrateBatch` used to hand `options.votes` — one ballot — to every
 * finding in the call. A batch of eight was decided by one vote about one of
 * them, and `VERIFIER_QUORUM = 2` then counted agreement that had never been
 * about the other seven.
 *
 * **The size of it, measured rather than argued:** applying the refusal
 * turned **17 existing cases in this file red** at once. Every one had been
 * asserting something true about the dedupe or the budget while silently also
 * asserting that one group's vote settled the quorum for findings it had
 * never seen.
 *
 * One of those seventeen is worth naming, because it did not go red — *"one
 * UNMEASURED finding makes the whole batch reading UNMEASURED"* kept passing,
 * because under the new refusal all three of its findings are UNMEASURED and
 * its assertion only asks that one of them is. Green, for a true reason,
 * about a mechanism it was no longer reaching: the fifth shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`, created and caught inside
 * one change.
 */
describe("AR-18: one ballot per finding, and no way to spread one across a batch", () => {
  const DISSENT: readonly VerifierVote[] = [
    { verifier: "v1", real: true, reason: "reproduced" },
    { verifier: "v2", real: false, reason: "could not reproduce" },
    { verifier: "v3", real: false, reason: "could not reproduce" },
  ];
  const reading = (id: string, n: number): Finding => ({
    id,
    title: `reading ${id}`,
    body: `\`queueHandler${n}\` drops ${300 + n} of ${900 + n} messages.`,
  });

  /**
   * THE CAPABILITY, and it did not exist before this change: two findings in
   * one call, judged by two different groups, reaching two different
   * verdicts. With a single batch-wide `votes` this reading is unreachable —
   * both findings get whichever ballot the caller passed.
   */
  test("CONTROL: two groups, two verdicts, one call", () => {
    const r = arbitrateBatch([reading("a", 1), reading("b", 2)], opts({
      votes: undefined,
      ballots: [AGREED, DISSENT],
    }));
    expect(r.verdicts.map(v => v.refusal)).toEqual([null, "NO_QUORUM"]);
    expect(r.verdicts[0]!.disposition).toBe("COMMENT");
    // The jury reading is per finding too, not one reading restated twice.
    expect(r.verdicts.map(v => v.jury?.agree)).toEqual([2, 1]);
  });

  /**
   * THE BALLOTS ARE INDEXED BY INPUT POSITION, NOT BY WALK ORDER.
   *
   * `walkOrder` sorts numeric ids numerically, so a batch given as
   * `["10", "9"]` is WALKED as `9, 10`. A ballot list indexed by walk
   * position therefore hands each finding the other one's group — an
   * inversion no single-ballot test could ever show, because with one ballot
   * every order gives the same answer.
   */
  test("ballots follow the input order, not the order the batch is walked in", () => {
    const ten = reading("10", 1);
    const nine = reading("9", 2);
    // The premise, asserted rather than assumed: the walk really does
    // reorder these. Without this the case is about nothing.
    const walked = arbitrateBatch([ten, nine], opts({
      votes: undefined,
      ballots: [AGREED, AGREED],
    }));
    expect(walked.verdicts.map(v => v.id)).toEqual(["10", "9"]);

    const r = arbitrateBatch([ten, nine], opts({ votes: undefined, ballots: [AGREED, DISSENT] }));
    // Input position 0 is `10` and it was given AGREED.
    expect(r.verdicts[0]!.id).toBe("10");
    expect(r.verdicts[0]!.refusal).toBeNull();
    expect(r.verdicts[1]!.id).toBe("9");
    expect(r.verdicts[1]!.refusal).toBe("NO_QUORUM");
  });

  test("a multi-finding batch given ONE ballot refuses, and says why", () => {
    const r = arbitrateBatch([reading("a", 1), reading("b", 2)], opts({ votes: AGREED }));
    expect(r.verdicts.map(v => v.refusal)).toEqual(["UNMEASURED", "UNMEASURED"]);
    expect(r.verdicts[0]!.reason).toBe(SHARED_BALLOT);
    // UNMEASURED, not NO_QUORUM. These findings did not fail a vote; they
    // did not have one, and only one of those is a reading.
    expect(r.verdicts.some(v => v.refusal === "NO_QUORUM")).toBe(false);
  });

  test("a SINGLE-finding batch given one ballot is unaffected", () => {
    const r = arbitrateBatch([reading("a", 1)], opts({ votes: AGREED }));
    expect(r.verdicts[0]!.refusal).toBeNull();
    expect(r.verdicts[0]!.disposition).toBe("COMMENT");
  });

  test("a ballot list shorter than the batch refuses rather than padding", () => {
    const r = arbitrateBatch([reading("a", 1), reading("b", 2)], opts({
      votes: undefined,
      ballots: [AGREED],
    }));
    expect(r.verdicts.map(v => v.refusal)).toEqual(["UNMEASURED", "UNMEASURED"]);
    expect(r.verdicts[0]!.reason).toBe(BALLOT_COUNT_MISMATCH);
  });

  test("a ballot list LONGER than the batch refuses rather than truncating", () => {
    const r = arbitrateBatch([reading("a", 1)], opts({
      votes: undefined,
      ballots: [AGREED, AGREED],
    }));
    expect(r.verdicts.map(v => v.refusal)).toEqual(["UNMEASURED"]);
    expect(r.verdicts[0]!.reason).toBe(BALLOT_COUNT_MISMATCH);
  });

  /**
   * Two instructions about one batch. Letting `ballots` win silently would
   * be a precedence rule nobody wrote down, and a caller who passed both
   * believes something about the one that lost.
   */
  test("both `votes` and `ballots` refuses — no silent precedence", () => {
    const r = arbitrateBatch([reading("a", 1), reading("b", 2)], opts({
      votes: AGREED,
      ballots: [AGREED, AGREED],
    }));
    expect(r.verdicts.map(v => v.refusal)).toEqual(["UNMEASURED", "UNMEASURED"]);
    expect(r.verdicts[0]!.reason).toBe(BALLOT_AMBIGUOUS);
  });

  /**
   * WHAT EVERY ROW ABOVE HOLDS FIXED (seventh shape): every ballot in them is
   * a well-formed three-vote group. The per-ballot shape is `juryReading`'s
   * business and it has its own cases, but nothing above would notice if the
   * batch stopped passing a malformed ballot through to it — so the row that
   * does not hold it fixed is here.
   */
  test("a malformed ballot inside the list still reaches the jury's own refusal", () => {
    const r = arbitrateBatch([reading("a", 1), reading("b", 2)], opts({
      votes: undefined,
      // Two votes where the declared group is three: INCOMPLETE_GROUP.
      ballots: [AGREED, AGREED.slice(0, 2)],
    }));
    expect(r.verdicts[0]!.refusal).toBeNull();
    expect(r.verdicts[1]!.refusal).toBe("UNMEASURED");
    // The jury's sentence, not the batch's — proof the ballot was forwarded
    // rather than pre-judged here.
    expect(r.verdicts[1]!.reason).not.toBe(SHARED_BALLOT);
    expect(r.verdicts[1]!.reason).toContain("ballot");
  });
});

/**
 * AR-19: a re-filing of an existing finding is a different question from a
 * paraphrase of one, and only the second was being asked (#1301).
 *
 * `duplicateOverlap` asks "do these two share enough to be the same
 * symptom?" — two shared quantities and one shared location. Measured over
 * the live tracker on 2026-10-23, **26 of 38 open findings re-filed
 * BYTE-IDENTICALLY were refused and 12 were allowed**, and the twelve split
 * on exactly one axis: every one of them carries fewer than two quantity
 * keys. They are not key-poor — median 7.5 location keys, one with nineteen
 * — they are quantity-poor, naming symbols and files while reporting no
 * measured numbers.
 *
 * Lowering `DUPLICATE_MIN_SHARED_QUANTITIES` is the cheap fix and the wrong
 * one: at 1 the self-refile rate reaches 82% and the six-issue
 * `lib/bash-write-guard.ts` cluster the threshold exists to keep apart comes
 * back, in the direction this file calls worse — a false DUPLICATE withholds
 * a real finding.
 *
 * So CONTAINMENT is added as a second arm, OR-ed with the first and never
 * replacing it. Measured over all 44 findings (38 open plus the six closed
 * cluster issues, which a sweep of open issues alone cannot see), 946 pairs:
 *
 *     current rule            4 pairs   1175/1177, 1195/1196, 1269/1286, 1162/1226
 *     containment >= 0.6      3 pairs   1175/1177, 1195/1196, 1195/1239
 *     containment >= 0.8      1 pair    1175/1177
 *
 * The two pairs the quantity threshold was tuned to CATCH are the top two by
 * containment (1.00 and 0.78). The four inside the cluster it was tuned to
 * KEEP APART top out at 0.44. At 0.8 the arm adds **zero** cross-issue pairs
 * over the whole corpus and takes the self-refile rate to 38/38.
 *
 * The honest caveat, in the same terms the original tuning states: 0.8 is
 * tuned on 44 findings, and on this corpus the only thing separating it from
 * 0.6 is one pair. It is chosen for the error direction, not for a margin the
 * data supports.
 */
describe("AR-19: a byte-identical re-filing is a duplicate, whatever it counts", () => {
  // Quantity-poor and location-rich: the shape of all twelve that got
  // through. No digits anywhere, so `qty:` keys are empty by construction
  // and the quantity arm cannot be what refuses it.
  const QUANTITY_POOR: Finding = {
    id: "1297",
    title: "The scaffold rewrites a hand-edited brief without saying so",
    body:
      "`scaffoldProject` in lib/scaffold-project.ts calls `writeBrief` through " +
      "`renderAgentBrief`, and lib/agents-md-sections.ts never reports the overwrite.",
  };
  const refile = (f: Finding): Finding => ({ id: UNFILED_ID, title: f.title, body: f.body });

  test("AR-19 BASELINE: re-filing a quantity-poor finding against itself is a DUPLICATE", () => {
    // The whole defect in one row. Before the containment arm this returned
    // `duplicate: false` while sharing every key the candidate has.
    const overlap = duplicateOverlap(refile(QUANTITY_POOR), QUANTITY_POOR);
    expect(symptomKeys(QUANTITY_POOR).filter(k => k.startsWith("qty:")), "the fixture must be quantity-poor, or this row proves nothing").toEqual([]);
    expect(overlap.duplicate).toBe(true);
  });

  test("AR-19 CONTROL: a genuinely novel finding is still allowed", () => {
    // The control against "refuse everything", which would make the row
    // above green and the gate useless.
    const novel: Finding = {
      id: UNFILED_ID,
      title: "The census router cannot see a tick inside a spec",
      body: "`censusTestsFor` in scripts/census-routing.ts reads `git diff --name-only`.",
    };
    expect(duplicateOverlap(novel, QUANTITY_POOR).duplicate).toBe(false);
  });

  test("AR-19 CONTROL: partial overlap is NOT containment — the cluster stays apart", () => {
    // Shares the file and one symbol with the fixture and nothing else. At
    // 0.44 the worst real cluster pair sits below the cut; this sits lower
    // still. A containment arm that fired here would be re-joining the six
    // findings the quantity threshold was tuned to separate.
    const sibling: Finding = {
      id: "1298",
      title: "A rename between branch and main reads as a different symbol",
      body:
        "`renderAgentBrief` in lib/scaffold-project.ts resolves the template path, " +
        "and `templateFor` in lib/brief-templates.ts picks the wrong one for a role " +
        "whose name was changed on the branch. `roleKey` and `briefPath` disagree.",
    };
    const overlap = duplicateOverlap(sibling, QUANTITY_POOR);
    expect(overlap.duplicate, `shared ${overlap.keys.length} keys and that is not enough`).toBe(false);
  });

  test("AR-19: a finding with one key is not swallowed by anything that mentions it", () => {
    // The floor. Without it, containment is 1.0 for any finding whose single
    // key appears in a large issue — a false DUPLICATE manufactured out of
    // one word. A one-key finding is already UNMEASURED upstream; this row
    // asserts the arm does not reach it anyway.
    const oneKey: Finding = { id: UNFILED_ID, title: "scaffoldProject misbehaves", body: "" };
    expect(symptomKeys(oneKey).length).toBeLessThan(2);
    expect(duplicateOverlap(oneKey, QUANTITY_POOR).duplicate).toBe(false);
  });

  test("AR-19: the two real pairs the quantity threshold was tuned on still refuse", () => {
    // Not vacuous: the containment arm is ADDITIONAL, so the rows the
    // original tuning earned must not move. If a later change makes
    // containment a replacement rather than a second arm, this is what sees
    // it — 1195/1196 is at 0.78, below the 0.8 cut, and is held by the
    // quantity arm alone.
    const a: Finding = {
      id: "1175",
      title: "The retry budget gives up early",
      body:
        "`retryBudget` in lib/command-retry.ts completed 144 of 234. " +
        "`sweepPlan`, `attemptCursor` and `backoffTable` are the callers.",
    };
    const b: Finding = {
      id: "1177",
      title: "Long sweeps lose their last attempts",
      body:
        "144 of 234 reached the end, in lib/command-retry.ts. " +
        "`drainQueue`, `resumeToken`, `frameBudget` and `lastAttempt` disagree.",
    };
    // The pair MUST be below the containment cut, or this row is green by the
    // arm it is here to control for and proves nothing about the other.
    const ratio = Math.max(
      sharedKeys(a, b).length / symptomKeys(a).length,
      sharedKeys(a, b).length / symptomKeys(b).length,
    );
    expect(ratio, "the fixture must sit below the containment cut").toBeLessThan(0.8);
    expect(duplicateOverlap(a, b).duplicate).toBe(true);
  });
});

/**
 * AR-20: the arm must also LEAVE THINGS ALONE, and nothing asserted that
 * until now (#1318).
 *
 * Every containment case in AR-19 asks the same question — *does it catch a
 * duplicate?* None asks *does it leave a non-duplicate alone?* That is the
 * seventh shape in `.claude/rules/checks-must-be-able-to-fail.md` with the
 * axes swapped: the rows vary the fixture and hold the DIRECTION fixed, so no
 * count in them can come back wrong about a false refusal.
 *
 * It matters here more than it usually would, because the two directions are
 * not symmetric. A missed duplicate costs a tracker row somebody closes. A
 * false DUPLICATE **withholds a real finding**, and an arbiter that silently
 * eats novel findings converts a visible backlog into an invisible one —
 * which is worse than the backlog it exists to shrink.
 *
 * **The floor moved from 2 to 4, measured on the live tracker rather than
 * argued.** At ratio 0.8 over the 35 findings the corpus filters to:
 *
 *     floor=2   self-refile 35/35   cross-issue pairs 0
 *     floor=3   self-refile 34/35   cross-issue pairs 0
 *     floor=4   self-refile 32/35   cross-issue pairs 0
 *     floor=5   self-refile 30/35   cross-issue pairs 0
 *
 * No floor in that range costs a single cross-issue pair, so the self-refile
 * column is the whole price: three of thirty-five. What it buys is the row
 * below. #1162 carries 40 keys, and at floor 2 a two-key finding whose keys
 * both appear in it is refused as a duplicate of it — a real finding eaten by
 * an unrelated issue, reachable on the tracker as it stands today.
 *
 * **What this does NOT close, stated rather than left to be discovered:** a
 * FOUR-key finding wholly inside that same issue is still refused, at floor 2
 * and at floor 4 alike. The floor shortens the reach of the swallow; it does
 * not remove it. An absolute shared-key minimum beside the ratio would not
 * help that case either, since four keys are genuinely shared.
 */
describe("AR-20: a small finding is not swallowed by a large unrelated issue", () => {
  // A big issue naming many symbols. Not stuffed past the corpus cap — this
  // is an ordinary long finding, which is the point: nothing filters it out.
  const BIG: Finding = {
    id: "1162",
    title: "The scan reports a roster that the matcher never receives",
    body: [
      "`rosterFor`, `scanRoster`, `matcherRegistry`, `applyMatchers`, `resolveRole`,",
      "`roleKey`, `briefPath`, `renderBrief` and `writeBrief` in lib/scanner.ts,",
      "lib/matchers.ts and lib/scaffold-project.ts disagree about 12 of 31 roles.",
    ].join(" "),
  };

  const small = (n: number): Finding => ({
    id: UNFILED_ID,
    title: "a finding",
    body: symptomKeys(BIG).filter(k => k.startsWith("sym:")).slice(0, n).map(k => `\`${k.slice(4)}\``).join(" "),
  });

  test("AR-20 BASELINE: a two-key finding inside a large issue is NOT a duplicate", () => {
    const f = small(2);
    // The premise: its keys really are a subset, so containment is 1.0 and
    // the ratio arm alone would refuse it. Without this the row could pass
    // because the fixture shares nothing, which proves nothing at all.
    expect(symptomKeys(f).length, "the fixture must sit at the floor").toBe(2);
    expect(sharedKeys(f, BIG).length, "and be wholly contained").toBe(2);
    expect(duplicateOverlap(f, BIG).duplicate).toBe(false);
  });

  test("AR-20: a three-key finding inside a large issue is NOT a duplicate either", () => {
    const f = small(3);
    expect(symptomKeys(f).length).toBe(3);
    expect(sharedKeys(f, BIG).length).toBe(3);
    expect(duplicateOverlap(f, BIG).duplicate).toBe(false);
  });

  test("AR-20 CONTROL: the arm still fires, so this is not 'refuse nothing'", () => {
    // The control against the cheapest wrong fix for the two rows above —
    // raising the floor until the arm never fires — which would make them
    // green and delete the mechanism AR-19 exists for.
    const refile: Finding = { id: UNFILED_ID, title: BIG.title, body: BIG.body };
    expect(duplicateOverlap(refile, BIG).duplicate).toBe(true);
  });

  test("AR-20: the floor is what decides it, not the ratio", () => {
    // Names the binding. A two-key finding and a five-key finding differ
    // only in size here — both are wholly contained, both are at ratio 1.0 —
    // so a row that moved because the RATIO changed would not separate them.
    const two = small(2);
    const five = small(5);
    for (const f of [two, five]) {
      expect(sharedKeys(f, BIG).length / symptomKeys(f).length, "both are at containment 1.0").toBe(1);
    }
    expect(symptomKeys(five).length).toBeGreaterThanOrEqual(DUPLICATE_CONTAINMENT_MIN_KEYS);
    expect(duplicateOverlap(five, BIG).duplicate, "above the floor, the arm reaches it").toBe(true);
    expect(duplicateOverlap(two, BIG).duplicate, "below it, the arm does not").toBe(false);
  });
});

/**
 * AR-21..AR-26 — the ballot reaches the ledger (#1467).
 *
 * Covers CRC-B4 (CODE-REVIEW-CONVERGENCE-SPEC.md), recording half:
 * *"The ledger records every verifier's individual vote and whether the
 * verifiers disagreed, both as first-class fields written at decision time.
 * Without them every threshold except the one actually used is permanently
 * UNMEASURED, and re-running to recover the votes re-samples the thing being
 * measured."*
 *
 * ## What was true before this block
 *
 * `juryReading` was handed `VerifierVote[]` and returned two integers. No
 * verifier id and no reason survived the call, so `Verdict.jury` —
 * everything downstream has — could say *2 of 3* and could not say which two,
 * or why the third said no. `scripts/arbitrate-finding.ts`, the only caller
 * in the tree that takes a ballot at all, wrote nothing anywhere: the ballot
 * lived for the length of one process.
 *
 * ## AR-23 is the case that chooses the fix
 *
 * The cheapest wrong fix is to record the findings you SURFACE. It satisfies
 * "the ledger records the votes" for every row anybody looks at, and it
 * leaves the withheld population exactly as unrecoverable as it was — which
 * is the population the quorum's own cardinality would have to be derived
 * from (`CandidateRecord`: *"written down at the moment the candidate is
 * withheld, or never"*). So the row that must be asserted is the one at
 * `exit 1`.
 *
 * ## The dissent is a real one
 *
 * `SPLIT`'s dissenting reason is from a two-verifier quorum run by hand on
 * 2026-10-23, before this existed. The verifiers split 1-1 on a candidate
 * finding; the dissent had read the generated workflow and found the line
 * that made the finding's premise false, and the filing was dropped. That is
 * the first variance datapoint the jury path has, and it is the one thing a
 * count of `agree` cannot carry.
 */
describe("AR-21: every verifier's vote, and the disagreement, reach the ledger", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "arbitrate-finding.ts");
  const REPO = join(import.meta.dir, "..");
  /** The one site the mutant neutralises. Asserted unique by AR-26. */
  const BINDING = "jury: verdict.jury,";

  let scratch = "";
  let mutant = "";
  let runs = 0;

  const UNANIMOUS: VerifierVote[] = [
    { verifier: "v1", real: true, reason: "reproduced against origin/main" },
    { verifier: "v2", real: true, reason: "reproduced against origin/main" },
    { verifier: "v3", real: true, reason: "reproduced against origin/main" },
  ];
  const SPLIT: VerifierVote[] = [
    { verifier: "v1", real: true, reason: "read the adjudicator module and the tracker" },
    { verifier: "v2", real: true, reason: "read the adjudicator module and the tracker" },
    { verifier: "v3", real: false, reason: "the generated workflow carries the line that makes the premise false" },
  ];
  const REJECTED: VerifierVote[] = [
    { verifier: "v1", real: true, reason: "looks real to me" },
    { verifier: "v2", real: false, reason: "the cited symbol is not in the tree" },
    { verifier: "v3", real: false, reason: "the cited symbol is not in the tree" },
  ];
  /** Two votes against a declared group of three: UNMEASURED, not a dissent. */
  const SHORT: VerifierVote[] = SPLIT.slice(0, 2);

  interface Run {
    code: number | null;
    out: string;
    rows: Array<Record<string, unknown>>;
  }

  const run = (script: string, votes: readonly VerifierVote[]): Run => {
    const ledger = join(scratch, `ledger-${runs++}.jsonl`);
    const votesFile = join(scratch, `votes-${runs}.json`);
    writeFileSync(votesFile, JSON.stringify(votes));
    const r = Bun.spawnSync(
      ["bun", script, "--project-root", root,
       "--title", "`widgetHandler` leaks descriptors",
       "--body-file", join(scratch, "body.md"),
       "--existing", join(scratch, "empty.json"),
       "--votes", votesFile],
      {
        stdout: "pipe",
        stderr: "pipe",
        // Explicit env: bun does not hand a child a `process.env` mutated in
        // the parent, and the whole point of the variable is that no run
        // here touches the real `~/.rungate/finding-ledger.jsonl`.
        env: { ...process.env, RUNGATE_FINDING_LEDGER: ledger },
      },
    );
    const rows = existsSync(ledger)
      ? readFileSync(ledger, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), rows };
  };

  const jury = (r: Run): Record<string, unknown> => {
    expect(r.rows.length, `the run wrote ${r.rows.length} ledger rows, not 1\n${r.out}`).toBe(1);
    const j = r.rows[0].jury;
    expect(j, "the row carries no jury reading at all").not.toBeNull();
    return j as Record<string, unknown>;
  };

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "arbiter-ballot-ledger-"));
    writeFileSync(join(scratch, "body.md"),
      "`widgetHandler` leaks 58 descriptors across 19 runs in `widget.ts`.");
    writeFileSync(join(scratch, "empty.json"), "[]");

    // ── The mutant: the recording, removed, and nothing else ──────────────
    const src = readFileSync(SCRIPT, "utf-8");
    const n = src.split(BINDING).length - 1;
    if (n !== 1) {
      throw new Error(`could not build the mutant: \`${BINDING}\` appears ${n} times in the script, not once`);
    }
    let out = src.replace(BINDING, "jury: null,");
    out = out.replace(/from "(\.\.?\/[^"]+)"/g,
      (_m, spec: string) => `from ${JSON.stringify(join(REPO, "scripts", spec))}`);
    if (/from "\.\.?\//.test(out)) {
      throw new Error("could not build the mutant: a relative import survived rewriting, so it would die on module resolution and read as a refusal");
    }
    mutant = join(scratch, "arbitrate.mutant.ts");
    writeFileSync(mutant, out);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("AR-21: a unanimous ballot is recorded in full, and says the group did not disagree", () => {
    const r = run(SCRIPT, UNANIMOUS);
    expect(r.code, r.out).toBe(0);
    const j = jury(r);
    expect(j.disagreed).toBe(false);
    expect((j.ballot as VerifierVote[]).map(v => v.verifier)).toEqual(["v1", "v2", "v3"]);
    expect(r.rows[0].emitted).toBe(true);
  });

  test("AR-22: a 2-1 ballot records the dissenter by name and carries their reasoning", () => {
    const r = run(SCRIPT, SPLIT);
    expect(r.code, r.out).toBe(0);
    const j = jury(r);
    expect(j.disagreed, "a split ballot must not read as agreement").toBe(true);
    const ballot = j.ballot as VerifierVote[];
    expect(ballot).toHaveLength(3);
    const dissent = ballot.find(v => !v.real);
    expect(dissent?.verifier).toBe("v3");
    // The half a count of `agree` can never carry. Re-running to recover it
    // re-samples the thing being measured.
    expect(dissent?.reason).toContain("makes the premise false");
  });

  test("AR-23: a finding the quorum voted DOWN is recorded, with every vote on it", () => {
    const r = run(SCRIPT, REJECTED);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("NO_QUORUM");
    const j = jury(r);
    expect(j.agree).toBe(1);
    expect(j.disagreed).toBe(true);
    expect((j.ballot as VerifierVote[]).map(v => v.reason))
      .toContain("the cited symbol is not in the tree");
    expect(r.rows[0].emitted, "a withheld finding did not reach a reader").toBe(false);
    expect(r.rows[0].withheldBy).toBe("NO_QUORUM");
  });

  test("AR-24: an UNMEASURED reading still records the ballot it could not count", () => {
    const r = run(SCRIPT, SHORT);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("UNMEASURED");
    const j = jury(r);
    expect(j.reading).toBe("UNMEASURED");
    // Decision time, not outcome time: the two votes that WERE cast are the
    // only record that the group was convened at all.
    expect((j.ballot as VerifierVote[])).toHaveLength(2);
  });

  test("AR-25: the mutant writes the row and loses the ballot — real red, mutant green", () => {
    for (const ballot of [UNANIMOUS, SPLIT, REJECTED]) {
      const real = run(SCRIPT, ballot);
      const mut = run(mutant, ballot);

      // Observed running, before any claim about what it observed: a mutant
      // that failed to load writes no row and would otherwise read exactly
      // like a mutant whose recording was correctly neutralised.
      expect(mut.rows.length, `the mutant wrote no ledger row — it may not have loaded\n${mut.out}`).toBe(1);
      expect(mut.code, "the mutant must differ in the FIELD, not in the verdict").toBe(real.code);

      expect(real.rows[0].jury, "the real script lost the ballot").not.toBeNull();
      expect(mut.rows[0].jury, "the mutation did not apply: the mutant still recorded a jury").toBeNull();
    }
  });

  test("AR-26: the recording has one site, so no branch can bypass the mutation", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    expect(src.split(BINDING).length - 1,
      `more than one \`${BINDING}\` — the mutant would neutralise only one of them`).toBe(1);
    // And the reading itself carries both fields rather than leaving a
    // consumer to re-derive `disagreed` from the counts, which would be two
    // deciders over one question.
    const split = juryReading(SPLIT);
    const unanimous = juryReading(UNANIMOUS);
    expect(split.disagreed).toBe(true);
    expect(unanimous.disagreed).toBe(false);
    expect(split.ballot).toEqual(SPLIT);
  });
});
