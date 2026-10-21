/**
 * #988: the commit-subject classifier's false positive and false negative
 * rate, measured over a hand-labelled census.
 *
 * `docs/research/commit-classifier-rates.md` is the write-up. This file is the
 * instrument: it reads the frozen labels out of
 * `test/fixtures/commit-classifier-corpus.json` and recomputes every number in
 * that document by running the REAL `classifyCommitSubject` over each subject.
 *
 * ## Why the labels are frozen and the classification is not
 *
 * The two halves of a rate rot differently. A human judgement about whether
 * `fix(#921): take the containment reading off $HOME` describes an incident is
 * a fact about that sentence and does not change; which subjects the regex
 * admits is a fact about the code and changes whenever somebody edits it. So
 * the labels are committed and the mining is re-derived on every run — which
 * makes this a guard rather than a record. Narrow or widen the classifier and
 * these numbers move, and the cases say by how much.
 *
 * Storing the mined/skipped verdict in the corpus instead would have produced
 * a file that agrees with whatever the classifier does, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s artifact-that-always-agrees
 * exactly.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * Asserted as cases at the bottom of this file rather than described here. The
 * short version, because it is the most important sentence in the issue:
 * **these rates are measured on the corpus the classifier was tuned on**, so
 * they are a fact about this repository and not about the classifier. The
 * generalisation is UNMEASURED, and the research document says what measuring
 * it would require.
 *
 * ## What was broken to prove it
 *
 * Counted over this file + `test/ci-history-depth.test.ts` (38 tests), under
 * `HOME` at an empty `mkdtemp`, with every count and named assertion set
 * predicted before the run. The baseline row — 38 pass, 0 fail — was read
 * first. The full table lives in the sibling file's docblock; the three rows
 * about this one:
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | M6 `CONVENTIONAL_FIX` matches nothing | 10 | **11 of 38** | `fix(#921): take the containment reading off $HOME` — original classifies `fix-commit`, mutant returns null |
 * | M7 the classifier widened to every conventional type | 7 | **7 of 38** | `docs: record session 50 (#604)` — original null, mutant `fix-commit` |
 * | M8 **instrument control** — one corpus row deleted | 3 | **3 of 38** | the corpus itself |
 *
 * **M6 came back HIGH, and the extra red is the real kind.** The eleventh is
 * `#987 AC-4: the control: the source repository itself is MEASURED` in the
 * sibling file — a positive control whose fixture repository is built out of
 * `fix:` subjects, so a classifier that matches nothing leaves it with no
 * candidates. Squarely about the mutated behaviour, and not a crashing mutant:
 * 27 cases still pass and every red is classification-related. Per
 * `.claude/rules/checks-must-be-able-to-fail.md`'s arithmetic that is "the
 * prediction was wrong and the check is better than you thought", and the fact
 * it records is that the #987 fixture depends on the classifier — which is why
 * it is labelled a control there rather than a witness.
 *
 * **M8 is an instrument control and is labelled as one.** It measures that the
 * corpus is load-bearing, not that any code is correct. Its `lines changed`
 * read 0 while it was plainly working, because the corpus was untracked at the
 * time and `git diff` says nothing about an untracked file — recorded because
 * a 0 there would otherwise read as a failed edit, which is the standing
 * hazard pointing the other way.
 *
 * Neither classifier mutation is left in the tree; both were run and reverted,
 * and `lib/failure-intake.ts` and the corpus were confirmed byte-identical by
 * sha256 afterwards. **`lib/failure-intake.ts` is unmodified by this issue** —
 * #988 asks for a measurement before any narrowing or widening, and this is
 * the measurement.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyCommitSubject } from "../lib/failure-intake";

interface CorpusRow {
  n: number;
  sha: string;
  date: string;
  label: "incident" | "not-incident";
  category: string;
  subject: string;
}
interface Corpus {
  window: { repo: string; ref: string; head: string; commits: number; selector: string };
  measuredOn: string;
  rows: CorpusRow[];
}

const CORPUS: Corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "commit-classifier-corpus.json"), "utf-8"),
);

/** The whole measurement, recomputed from the live classifier every run. */
function measure() {
  const tp: CorpusRow[] = [];
  const fp: CorpusRow[] = [];
  const fn: CorpusRow[] = [];
  const tn: CorpusRow[] = [];
  for (const r of CORPUS.rows) {
    const mined = classifyCommitSubject(r.subject) !== null;
    const incident = r.label === "incident";
    if (mined && incident) tp.push(r);
    else if (mined) fp.push(r);
    else if (incident) fn.push(r);
    else tn.push(r);
  }
  return { tp, fp, fn, tn };
}

// ── The corpus is a census, and says so ──────────────────────────

describe("#988 AC-1: the corpus is a complete window, explicitly labelled", () => {
  test("every commit in the window is present exactly once", () => {
    expect(CORPUS.rows).toHaveLength(CORPUS.window.commits);
    expect(CORPUS.window.commits).toBe(500);
    expect(new Set(CORPUS.rows.map((r) => r.sha)).size).toBe(500);
    expect(CORPUS.rows.map((r) => r.n)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 1),
    );
  });

  test("no row is unlabelled — a census with a default is not a census", () => {
    // The thing this guards is the labelling shortcut: grade the interesting
    // rows, leave the rest to a rule, and report the result as a hand audit.
    // An absent label would be indistinguishable from a considered one.
    const bad = CORPUS.rows.filter(
      (r) => (r.label !== "incident" && r.label !== "not-incident") || !r.category || !r.subject,
    );
    expect(bad.map((r) => r.n)).toEqual([]);
  });

  test("the label and the category agree in both directions", () => {
    const disagreeing = CORPUS.rows.filter(
      (r) => (r.category === "incident") !== (r.label === "incident"),
    );
    expect(disagreeing.map((r) => r.n)).toEqual([]);
  });

  test("the subjects are verbatim, not re-spelled after the pattern they feed", () => {
    // A corpus written to match the regex measures the regex against itself.
    // Every subject carries the squash-merge's trailing `(#N)` or is one of
    // the handful of direct commits that never had one, which is what a real
    // `git log` looks like and not what a fixture author writes.
    const withPr = CORPUS.rows.filter((r) => /\(#\d+\)\s*$/.test(r.subject));
    expect(withPr.length).toBeGreaterThan(400);
  });
});

// ── The rates ────────────────────────────────────────────────────

describe("#988 AC-2: the false positive rate, with its denominator", () => {
  test("6 of 302 mined candidates are not incidents", () => {
    const { tp, fp } = measure();
    expect(tp.length + fp.length).toBe(302);
    expect(fp.length).toBe(6);
    // 2.0%. Written as the fraction rather than the percentage so the
    // denominator cannot go missing from the claim.
  });

  test("and here is each one, by number", () => {
    // "Low false positives" is not a result. These six are the result, and
    // naming them is what lets a reader disagree with a label instead of with
    // a rate.
    expect(measure().fp.map((r) => r.n)).toEqual([25, 28, 201, 257, 316, 457]);
  });

  test("every false positive is a feature or a test shipped under `fix:`", () => {
    // Not one of them is trivial. That matters because it falsifies the
    // narrowing #988 was weighing — see the escape case below.
    expect(new Set(measure().fp.map((r) => r.category))).toEqual(
      new Set(["feature", "test-only"]),
    );
  });

  test("#988's motivating false positive does not occur in the window", () => {
    // The issue's example is `fix(#1): the typo in the README heading (#2)`,
    // and the classifier does mine it — `test/failure-intake-promotion.test.ts`
    // asserts that as an escape. What this census adds is that the shape has
    // ZERO instances in 500 commits. The escape is real and the population is
    // empty, which are different facts and only the second is a rate.
    const trivial = CORPUS.rows.filter((r) => r.category === "trivial");
    expect(trivial).toEqual([]);
    // The classifier would still mine one, so this is a fact about the
    // corpus and not about the code.
    expect(classifyCommitSubject("fix(#1): the typo in the README heading (#2)")).not.toBeNull();
  });
});

describe("#988 AC-3: the false negative rate, with its denominator", () => {
  test("92 of 198 skipped subjects are incidents the miner cannot see", () => {
    const { fn, tn } = measure();
    expect(fn.length + tn.length).toBe(198);
    expect(fn.length).toBe(92);
    // 46.5% of what it skips, and 92 of 388 — 23.7% — of every incident in
    // the window.
  });

  test("the miner sees 296 of the 388 incidents in the window", () => {
    const { tp, fn } = measure();
    expect(tp.length).toBe(296);
    expect(tp.length + fn.length).toBe(388);
  });

  test("the escapes are dominated by subjects with NO conventional prefix", () => {
    // The finding, and it is the one #988 did not anticipate. The issue
    // scopes the false-negative question to `feat:`/`refactor:`/`perf:`. That
    // population is 5 of 92. Eighty-five of the ninety-two are subjects this
    // repository wrote as a plain sentence or under its later `#N:`
    // convention, and no widening over conventional types reaches any of
    // them.
    const byPrefix: Record<string, number> = {};
    for (const r of measure().fn) {
      const m = /^([a-zA-Z]+)(\([^)]*\))?!?:/.exec(r.subject);
      const key = m ? m[1] : /^#\d+/.test(r.subject) ? "issue-ref" : "free-form";
      byPrefix[key] = (byPrefix[key] ?? 0) + 1;
    }
    expect(byPrefix).toEqual({ "free-form": 62, "issue-ref": 23, feat: 5, test: 1, chore: 1 });
  });

  test("widening to every conventional type would recover 7 of 92", () => {
    // Measured, so the move #988 warns against is costed rather than feared.
    const conventional = measure().fn.filter((r) => /^[a-zA-Z]+(\([^)]*\))?!?:/.test(r.subject));
    expect(conventional).toHaveLength(7);
  });

  test("and it would admit 92 non-incidents to do it", () => {
    // The trade, costed. Of the non-incidents in the window, 98 carry some
    // conventional prefix and 6 of those are the `fix:` false positives
    // already counted — so widening to every type recovers 7 real incidents
    // and admits 92 new wrong ones. That is a worse classifier by both
    // measures at once, which is why #988 says to measure before widening.
    const admitted = CORPUS.rows.filter(
      (r) => r.label === "not-incident" && /^[a-zA-Z]+(\([^)]*\))?!?:/.test(r.subject),
    );
    expect(admitted).toHaveLength(98);
    expect(admitted.filter((r) => /^fix/.test(r.subject))).toHaveLength(6);
    // The largest single class is documentation, by a distance.
    expect(admitted.filter((r) => /^docs/.test(r.subject))).toHaveLength(43);
  });
});

// ── WHAT THIS DOES NOT COVER ─────────────────────────────────────

describe("#988: WHAT THIS DOES NOT COVER", () => {
  test("ESCAPE: the corpus is the tuning corpus, so both rates flatter the classifier", () => {
    // `lib/failure-intake.ts` was written against this repository's commit
    // convention — its own docblock quotes four subjects from this `main` as
    // the evidence that a commit subject is a rule candidate at all. Measuring
    // it here asks whether it reads the sentences it was shaped around.
    //
    // The 2.0% false-positive rate is therefore a fact about this repository's
    // commit hygiene and NOT a property of the classifier. Any repository
    // whose `fix:` commits say "fix build" would score differently, and
    // nothing here can say by how much. That number is UNMEASURED; the
    // research document says what measuring it would require.
    expect(CORPUS.window.repo).toBe("this repository");
    // The control: the classifier's own module cites this history as its
    // justification, which is what makes the corpus the tuning corpus.
    const src = readFileSync(join(import.meta.dir, "..", "lib", "failure-intake.ts"), "utf-8");
    // A boolean, not `toContain`: a failing `toContain` against a 14KB source
    // prints the whole file into the run's output, and a test that floods the
    // log is a test nobody reads the result of.
    expect(src.includes("subjects from `main`, unaltered")).toBe(true);
    // And the stronger form of the same control: subjects the module quotes
    // as its justification are IN this corpus, mined, and labelled incidents.
    const quoted = CORPUS.rows.filter((r) =>
      r.subject.startsWith("fix(#921): take the containment reading off $HOME"),
    );
    expect(quoted).toHaveLength(1);
    expect(quoted[0].label).toBe("incident");
  });

  test("ESCAPE: a subject line is the only input, so a mislabelled commit is unreachable", () => {
    // Every label here was assigned by reading the subject, which is also all
    // the classifier reads. A commit whose subject misdescribes its diff is
    // scored consistently wrong by both, and the agreement is invisible to
    // this instrument. Reading diffs would answer it and is a different
    // measurement.
    const r = CORPUS.rows.find((x) => x.n === 457)!;
    expect(r.subject).toContain("Scaffold generates tsconfig.json");
    expect(r.label).toBe("not-incident");
    // Mined anyway, because the subject opens `fix(`.
    expect(classifyCommitSubject(r.subject)).not.toBeNull();
  });

  test("ESCAPE: one window, one labeller, and no second opinion", () => {
    // A single person labelled all 500 rows with no adjudication, so there is
    // no inter-rater agreement figure and the boundary cases are one
    // judgement rather than a consensus. The rows are committed with their
    // categories precisely so a disagreement lands on a row instead of on the
    // rate.
    expect(CORPUS.rows.every((r) => r.category.length > 0)).toBe(true);
    expect(CORPUS.window.selector).toContain("-n500");
  });

  test("ESCAPE: the revert half of the classifier has a denominator of zero here", () => {
    // Every mined candidate in the window is a `fix-commit`. The
    // `revert-commit` branch therefore has no rate at all in this
    // measurement — not a low one, none — and the re-land escape
    // `test/failure-intake-promotion.test.ts` asserts is unquantified.
    const kinds = new Set(
      CORPUS.rows
        .map((r) => classifyCommitSubject(r.subject)?.kind)
        .filter((k): k is NonNullable<typeof k> => k !== undefined),
    );
    expect([...kinds]).toEqual(["fix-commit"]);
  });

  test("ESCAPE: the window moves, and these numbers are pinned to one head", () => {
    // `git log -n500` means something different next week. The corpus freezes
    // the window at a named commit so the rates stay reproducible, which also
    // means they stop describing the repository the moment 500 more commits
    // land.
    expect(CORPUS.window.head).toHaveLength(40);
    expect(CORPUS.measuredOn).toBe("2026-10-21");
  });
});
