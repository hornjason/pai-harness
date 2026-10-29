/**
 * The citations in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` resolve.
 *
 * That spec is an alignment reference rather than a design: it reads an
 * external document and records, criterion by criterion, which mechanisms
 * this repo has already built and where they live. Its criteria are
 * deliberately unticked — the spec states a target, and nothing in it claims
 * coverage.
 *
 * So the usual spec checks have almost nothing to bite on here. `DRIFT-2`
 * asks that some test reference a testable spec; `ticked-sc-cover` and
 * `sc-binding-split` are satisfied vacuously while every box is `- [ ]`. The
 * one part of the document that can go wrong on its own, with no edit to the
 * spec at all, is the set of paths it points at. `evals/ai-review-control/`
 * is cited as the clean-PR control that already exists; `REVIEW.md` is cited
 * as shipped. Either can be moved or deleted by work in another subsystem,
 * and the spec would keep asserting them.
 *
 * That is the whole of what is asserted here, and it is asserted because it
 * is the only claim in the file that the tree can contradict. A test that
 * re-read the criteria and agreed with them would be reading the document to
 * confirm the document.
 *
 * ## What separates pass from fail
 *
 * Changing `evals/ai-review-control/` to `evals/ai-review-controls/` in the
 * spec reds the second case; so does deleting the directory. Measured on this
 * tree at the time of writing: four paths extracted, four resolved. The third
 * case plants the mis-citation rather than describing it, because a matcher
 * that had stopped matching would pass the second case with an empty list and
 * say nothing — which is why the first case asserts the extraction is not
 * empty before the second case reads it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PLACEMENT_HEADING, parsePlacementRows } from "../lib/spec-placement";

const REPO = join(import.meta.dir, "..");
const SPEC = "specs/CODE-REVIEW-CONVERGENCE-SPEC.md";

/**
 * A backticked repo path: either something with a directory separator, or a
 * bare filename with a known source extension.
 *
 * Narrow on purpose. The spec backticks a good deal that is not a path —
 * `full`, `UNMEASURED`, `noiseRate`, `DROP_SIGNALS` — and crediting those as
 * missing files would make the check fire on prose.
 */
const CITED_PATH = /`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+|[A-Za-z0-9_-]+\.(?:ts|md|json|yml))`/g;

function citedPaths(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(CITED_PATH)) found.add(m[1]);
  return [...found].sort();
}

/** One row of the *Readings taken* table. */
type Reading = {
  phase: string;
  verdict: string;
  pr: string;
  head: string;
  criteria: string;
  observed: string;
};

/**
 * Rows of the *Readings taken* table, found by their shape rather than by a
 * heading offset — a heading is renamed far more often than a six-column row
 * whose first cell is a bolded digit is invented elsewhere.
 */
function readingRows(body: string): Reading[] {
  const rows: Reading[] = [];
  for (const line of body.split("\n")) {
    const m = /^\|\s*\*\*(\d)\*\*\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    rows.push({
      phase: m[1],
      verdict: m[2].trim(),
      pr: m[3].trim(),
      head: m[4].trim(),
      criteria: m[5].trim(),
      observed: m[6].trim(),
    });
  }
  return rows;
}

/**
 * Every criterion id this spec DECLARES — the checkbox lines, which are the
 * only position that creates one. Cited ids elsewhere in the document are
 * references to these and cannot add to the set.
 */
function declaredCriteria(body: string): Set<string> {
  return new Set(
    [...body.matchAll(/^- \[[ xX]\] (CRC-[A-Z]?\d+):/gm)].map(m => m[1]),
  );
}

/**
 * Rows of the *Work in flight* table: `| PR | phase | criteria | state |`.
 *
 * There is deliberately no branch column — a branch is deleted on merge, so
 * citing one here is a citation that rots on the single event the table
 * exists to survive. It is also not merely untidy: the path check in this
 * file reads a backticked `rg/some-branch` as a repo path and reports it
 * missing, which is how the absence of this column got decided.
 */
function inFlightRows(body: string): { pr: string; criteria: string[] }[] {
  const at = body.indexOf("| PR | Phase / increment |");
  if (at < 0) return [];
  const rows: { pr: string; criteria: string[] }[] = [];
  for (const line of body.slice(at).split("\n")) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 4 || cells[0].includes("---") || cells[0].trim() === "PR") continue;
    rows.push({
      pr: cells[0].trim(),
      criteria: [...cells[2].matchAll(/CRC-[A-Z]?\d+/g)].map(m => m[0]),
    });
  }
  return rows;
}

/**
 * The traceability binding. Both tables point at criteria by id, and an id
 * that does not resolve is the whole failure mode of a cross-reference table:
 * it reads as a link and goes nowhere. One function so there is one thing to
 * mutate.
 */
function danglingCriteria(body: string): string[] {
  const declared = declaredCriteria(body);
  const out: string[] = [];
  for (const r of inFlightRows(body)) {
    if (r.criteria.length === 0) out.push(`in-flight row "${r.pr}" names no criterion`);
    for (const id of r.criteria) {
      if (!declared.has(id)) out.push(`in-flight row "${r.pr}" names ${id}, which this spec does not declare`);
    }
  }
  for (const r of readingRows(body)) {
    for (const id of r.criteria.matchAll(/CRC-[A-Z]?\d+/g)) {
      if (!declared.has(id[0])) out.push(`reading for phase ${r.phase} names ${id[0]}, which this spec does not declare`);
    }
  }
  return out;
}

/**
 * The single binding. One function turns the table into a violation list, so
 * there is one thing to mutate and the planted case below drives exactly the
 * code the live case drives.
 *
 * A full 40-character SHA, not an abbreviation: an abbreviated hash stops
 * being unique as the repo grows, and a reader checking a two-month-old
 * reading needs the one that still resolves.
 */
function readingDefects(body: string): string[] {
  const out: string[] = [];
  for (const r of readingRows(body)) {
    if (!/^EXITED/.test(r.verdict)) continue;
    if (!/#\d+/.test(r.pr)) out.push(`phase ${r.phase} is EXITED and names no pull request`);
    if (!/`[0-9a-f]{40}`/.test(r.head))
      out.push(`phase ${r.phase} is EXITED and names no full head SHA`);
    // The PR→spec half of the cross-reference. A reading that moved nothing
    // in this document is a reading with no reason to be recorded in it.
    if (!/CRC-[A-Z]?\d+/.test(r.criteria))
      out.push(`phase ${r.phase} is EXITED and names no criterion it evidences`);
    if (r.observed.replace(/[—\-\s]/g, "").length < 40)
      out.push(`phase ${r.phase} is EXITED and records no observation`);
  }
  return out;
}

/**
 * The "Not done — the remainder" bullet list, and the sentence that tallies it.
 *
 * This exists because the tally drifted three times in one pull request
 * (#1619), each time in the same way: a number hand-counted into prose, read
 * by nobody until a reviewer re-counted it by eye. A fourth manual recount is
 * the same instrument that produced the first three. The reviewer's own
 * meta-finding on round 4 said so and was right — so the count is now
 * recomputed from the bullets themselves and the prose has to agree with it.
 *
 * Three different quantities live in that sentence and conflating any two is
 * exactly how it drifted:
 *   - **bullets** — lines beginning `- **CRC-…`
 *   - **leading ids** — ids in the bold lead of a bullet. One bullet leads
 *     with TWO (`**CRC-E3, CRC-E9**`), so this exceeds the bullet count.
 *   - **mentioned ids** — every id anywhere in the section, including ones
 *     only named inside another bullet's prose.
 */
interface BulletTally {
  bullets: number;
  leading: string[];
  mentioned: string[];
  namedNotLeading: string[];
}

function remainderSection(body: string): string | null {
  const at = body.indexOf("**29 bullets");
  const start = at === -1 ? body.search(/^\*\*\d+ bullets/m) : at;
  if (start === -1) return null;
  const rest = body.slice(start);
  const end = rest.search(/^### /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every measurement in *Measured non-obvious facts* must be RE-TAKEABLE.
 *
 * This document separates two kinds of number, and the separation is stated
 * in the remainder tally's note above. Document-derived ones are properties
 * of this file and are recomputed by the cases above. World-derived ones —
 * `15 ai-review runs`, `147 parseable ledgers`, a blame walk over a merged
 * branch — cannot be recomputed by a test, because re-measuring gives a
 * DIFFERENT answer when the world moves. A check that reddened on that would
 * fire on the truth.
 *
 * So their obligation is not verification. It is that a reader can **take
 * the reading again**: the bullet must name a date, a run, a commit, or the
 * command. That IS a property of the document, so it is checkable here, and
 * making it checkable is the point.
 *
 * ## Why this exists rather than another recount
 *
 * Rounds 4, 5, 6 and 7 of #1619 all raised the same thing — hand-tallied
 * counts in prose with nothing binding them — and the first three fixes each
 * narrowed to the one instance cited. Round 7 was right that this does not
 * converge. It was also right about something sharper: the previous round
 * DECLARED the re-takeability obligation and then did not discharge it on
 * the bullets already in the file. Measured when this case was written, six
 * of them stated numbers and named no date, run, commit or command.
 *
 * A declared obligation with no reader is the same defect as a flag with no
 * reader. This is the reader.
 *
 * ## WHAT THIS CANNOT DO, stated because round 8 was right about it
 *
 * **It is BULLET-granular. It cannot tie a specific number to a specific
 * marker.** A bullet that already carries a date clears every number in it,
 * including one appended later that the date does not govern — round 8's
 * mutant is *"and 73% of all merges are affected"* added to a bullet already
 * reading `19:15Z on 2026-10-23`, and this check stays green on it.
 *
 * That is not fixable by tightening the regex, and the attempt is worse than
 * the gap. Per-sentence granularity reds the real content: *"33 distinct
 * defects were dropped at least once. 2 were raised again. 31 were never
 * seen again."* is three sentences and three numbers, all governed by a
 * Method clause above them. Demanding the date be restated in each is noise,
 * and noise is how a check gets routed around. Marker-must-precede-number
 * does not help either — an APPENDED number is preceded by the marker.
 *
 * So the claim is narrowed to what is true rather than left overclaiming:
 * **every bullet stating a measurement declares a provenance.** Accretion
 * inside an already-marked bullet is out of scope and is named here, in the
 * failure message, and in the spec. A check that says what it measures is
 * this project's own rule; one that implies more is the defect rounds 4-8
 * kept finding.
 */
/**
 * The audit section, cut the same way `measuredFactsSection` cuts its own.
 *
 * Scoped deliberately. A whole-document search for the guard below would be
 * satisfied or defeated by prose anywhere in the file, which is how the
 * first version of that guard passed by coincidence.
 */
function untickedBoxSection(body: string): string | null {
  const start = body.search(/^## What an unticked box means here/m);
  if (start === -1) return null;
  const rest = body.slice(start).replace(/^## .*\n/, "");
  // Stops at the first `###` as well as the next `##`. The audit SUMMARY is
  // the prose before the per-bucket subsections; running to the next `##`
  // swallows those tables, whose cells legitimately carry dates, percentages
  // and round numbers in bold. The first draft did that and reported nine
  // matches, none of them a tally.
  const end = rest.search(/^#{2,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

function measuredFactsSection(body: string): string | null {
  const start = body.search(/^## Measured non-obvious facts/m);
  if (start === -1) return null;
  const rest = body.slice(start).replace(/^## .*\n/, "");
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The *Not done* remainder, which states measurements too.
 *
 * Added because round 6 of #1637 pointed out that the re-takeability rule is
 * declared for every world-derived number in the document and was enforced
 * over ONE section — so the rule's own examples sat outside its reader. That
 * is the shape this file already names twice: a declared obligation whose
 * reader covers less than the declaration.
 *
 * Widening it cost one bullet, measured before the scope moved: 1 of 33 here
 * against 0 of 22 in *Measured non-obvious facts*. A scope change that
 * reddened nothing would have been scope on paper, so the count is recorded.
 */
function notDoneSection(body: string): string | null {
  const start = body.search(/^### Not done — the remainder/m);
  if (start === -1) return null;
  const rest = body.slice(start).replace(/^#{2,3} .*\n/, "");
  const end = rest.search(/^#{2,3} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Bullets that state a measurement and give no way to take it again. */
function unretakeableBullets(section: string): string[] {
  const out: string[] = [];
  for (const bullet of section.split(/\n(?=- )/)) {
    if (!bullet.startsWith("- ")) continue;
    // Strip the things that are IDENTIFIERS rather than measurements. An
    // issue number, a criterion id and a success-criterion id all carry
    // digits and none of them is a reading. Leaving them in would make every
    // bullet look like a measurement and the check would demand provenance
    // for prose that states none — noise, which is how a check gets ignored.
    const prose = bullet
      .replace(/#\d+/g, "")
      .replace(/\b(?:CRC|SC|AC|TC|TR|JG|FG|AR|M|N|B|E|F|H)-[A-Z]*\d+[a-z]?/g, "")
      .replace(/\bv\d+(?:\.\d+)*/g, "");
    // A measurement is a number of two or more digits, or a percentage.
    if (!/\b\d{2,}\b|\d+%/.test(prose)) continue;

    const retakeable =
      /20\d\d-\d\d-\d\d/.test(bullet) || // a date
      /`\d{8,}`|run `\d+`|runs? `\d+`/.test(bullet) || // a workflow run
      /`[0-9a-f]{7,40}`/.test(bullet) || // a commit
      /`(?:gh|git|bun|bunx|jq|curl|npm) /.test(bullet); // the command itself

    if (!retakeable) out.push(bullet.slice(2, 110).replace(/\s+/g, " "));
  }
  return out;
}

function tally(section: string): BulletTally {
  const bulletLines = section.match(/^- \*\*CRC-.*$/gm) ?? [];
  const leading = new Set<string>();
  for (const line of bulletLines) {
    const lead = line.match(/^- \*\*((?:CRC-[A-Z]+\d+)(?:, CRC-[A-Z]+\d+)*)\*\*/);
    for (const id of lead?.[1].match(/CRC-[A-Z]+\d+/g) ?? []) leading.add(id);
  }
  const mentioned = new Set(section.match(/CRC-[A-Z]+\d+/g) ?? []);
  const sort = (s: Set<string>) => [...s].sort();
  return {
    bullets: bulletLines.length,
    leading: sort(leading),
    mentioned: sort(mentioned),
    namedNotLeading: sort(mentioned).filter(id => !leading.has(id)),
  };
}

describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: the remainder tally is recomputed, not retyped", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;
  const section = body === null ? null : remainderSection(body);

  test("the section parses and holds bullets, so the tallies below are not vacuous", () => {
    // The positive control. Every assertion here is over a parse, and a parse
    // that found nothing satisfies all of them.
    expect(section, "the '<N> bullets' paragraph was not found in the spec").not.toBeNull();
    const t = tally(section!);
    expect(t.bullets, "no `- **CRC-…` bullets parsed out of the section").toBeGreaterThan(10);
    expect(t.mentioned.length).toBeGreaterThanOrEqual(t.leading.length);
  });

  test("the stated bullet count equals the bullets", () => {
    // Guarded here too, not only in the control above. Each `test()` runs
    // independently, so a `section` that failed to parse would reach `tally`
    // as null and throw a bare TypeError rather than saying what went wrong
    // (raised on #1619). The suite still goes red either way; this is about
    // whether the next reader can tell WHY.
    expect(section, "the '<N> bullets' paragraph was not found in the spec").not.toBeNull();
    const t = tally(section!);
    const stated = section!.match(/^\*\*(\d+) bullets/m);
    expect(stated, "the paragraph must open `**<N> bullets`").not.toBeNull();
    expect(
      Number(stated![1]),
      `the prose says ${stated![1]} bullets; ${t.bullets} parse out of the section. ` +
        "Recompute, do not retype — this sentence has drifted three times.",
    ).toBe(t.bullets);
  });

  test("the stated id count equals the ids, and names the right non-leading ones", () => {
    expect(section, "the '<N> bullets' paragraph was not found in the spec").not.toBeNull();
    const t = tally(section!);
    // Matched against COLLAPSED whitespace. The paragraph is hard-wrapped, so
    // a literal space in the pattern breaks the moment an edit rewraps the
    // line — a detector narrower than what it detects, and it was: the first
    // version of this case went red on a rewrap rather than on a wrong count.
    const flat = section!.replace(/\s+/g, " ");
    const m = flat.match(
      /without leading one \(([^)]*)\);[^.]*?why (\d+) ids appear here and (\d+) is the right count/,
    );
    expect(
      m,
      "the reconciliation sentence must keep its shape: `… without leading one (<ids>); … " +
        "why <N> ids appear here and <M> is the right count …`",
    ).not.toBeNull();
    // Spread before sorting: `String.match` returns a `RegExpMatchArray`, and
    // `toEqual` has no overload for one against a `string[]`. Caught by
    // typecheck in CI rather than locally, because the suite is outside
    // `tsconfig` — `bun test` green does not mean `bun run typecheck` green.
    const named: string[] = [...(m![1].match(/CRC-[A-Z]+\d+/g) ?? [])].sort();
    expect(
      named,
      "the ids the sentence names as mentioned-but-not-leading are not the ones that are. " +
        "CRC-E9 CO-LEADS a bullet with CRC-E3 and is a leading id.",
    ).toEqual(t.namedNotLeading);
    expect(Number(m![2]), "the stated total id count").toBe(t.mentioned.length);
    expect(Number(m![3]), "the stated bullet count, restated in the same sentence").toBe(t.bullets);
  });
});

describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: every measurement can be taken again", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;
  const facts = body === null ? null : measuredFactsSection(body);

  test("the section parses and holds bullets that state measurements", () => {
    // The positive control, and it carries the sharper half: a parse that
    // found no MEASURING bullets would satisfy the case below vacuously,
    // which is the shape this document spends its length warning about.
    expect(facts, "'## Measured non-obvious facts' was not found").not.toBeNull();
    const bullets = facts!.split(/\n(?=- )/).filter(b => b.startsWith("- "));
    expect(bullets.length, "no top-level bullets parsed").toBeGreaterThan(10);
    const measuring = bullets.filter(b => /\b\d{2,}\b/.test(b.replace(/#\d+/g, "")));
    expect(
      measuring.length,
      "no bullet reads as stating a measurement, so the retakeability case below would pass over nothing",
    ).toBeGreaterThan(5);
  });

  test("a bullet stating a measurement declares a date, a run, a commit or the command", () => {
    expect(facts, "'## Measured non-obvious facts' was not found").not.toBeNull();
    expect(
      unretakeableBullets(facts!),
      "These bullets state a number and declare no way to take the reading again. " +
        "A world-derived number cannot be recomputed by a test — re-measuring gives a " +
        "different answer when the world moves — so the obligation is RE-TAKEABILITY: " +
        "name the date it was read, the workflow run, the commit, or the command. " +
        "SCOPE, and it is narrower than it sounds: this is BULLET-granular and cannot " +
        "tie a particular number to a particular marker, so a number appended to a " +
        "bullet that already carries one passes. That gap is real, is not closable by " +
        "a tighter regex without reddening correct prose, and is recorded at " +
        "`unretakeableBullets` and in the spec rather than implied away.",
    ).toEqual([]);
  });

  test("the *Not done* remainder is held to the same rule", () => {
    // Round 6 of #1637: the document declares the re-takeability rule for
    // every world-derived number and enforced it over one section, so the
    // rule's own examples sat outside its reader. Same function, second
    // section — the fix is the scope, not another regex.
    const notDone = body === null ? null : notDoneSection(body);
    expect(notDone, "'### Not done — the remainder' was not found").not.toBeNull();
    const bullets = notDone!.split(/\n(?=- )/).filter(b => b.startsWith("- "));
    expect(bullets.length, "no bullets parsed, so the assertion below is over nothing")
      .toBeGreaterThan(10);
    expect(
      unretakeableBullets(notDone!),
      "These *Not done* bullets state a number and name no date, run, commit or command. " +
        "Same obligation, same scope note as the case above.",
    ).toEqual([]);
  });
});

/**
 * A figure cited from elsewhere in this document must still be there.
 *
 * Round 7 of #1637 named the gap precisely: the four example figures in
 * *Round 5 then asked the right question* sit in PROSE, and
 * `unretakeableBullets` skips anything not starting with `- `, so if the
 * dated readings they cite are renumbered, re-measured or deleted, the
 * citation goes stale and nothing reds.
 *
 * The fix is not to widen the retakeability scanner over them — they are
 * citations, and the obligation on a citation is that its SOURCE resolves,
 * not that it restates the source's date. So this binds the citation to the
 * home reading instead: every figure that paragraph names must still appear
 * in *Measured non-obvious facts*. Delete or re-measure the bullet and this
 * goes red naming the figure.
 *
 * Narrow on purpose, and the narrowness is the claim. A whole-body scan was
 * proposed as the alternative and is refuted by class rather than by cost:
 * the retakeability rule is the WORLD-DERIVED rule, and a scan over every
 * block would demand a date and a command from document-derived numbers
 * (which a guard already recomputes) and from cited ones (which owe a
 * primary source, not a date). Re-taken 2026-10-28 against `e7e12ed9` with
 * the command recorded in the spec's own paragraph: 68 of 240 non-heading,
 * non-table blocks state a multi-digit number and name no date, run, commit
 * or command — and a large share of those are exactly the two classes the
 * rule does not govern.
 *
 * That figure was first written here, and in the spec, as 63 of 292. It is
 * WITHDRAWN: it carried a date and no command, so when round 10 asked for
 * the command there was nothing to re-run, and the re-take against the same
 * revision did not reproduce it. The spec records the withdrawal and the
 * command; this docstring was the second, independent copy left stale by the
 * fix — which is the meta-finding this PR has now reproduced seven times. A
 * number restated in prose is a copy, and a copy is a thing that goes stale.
 */
describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: a cited figure's source still exists", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;

  test("every figure the class paragraph cites is still in *Measured non-obvious facts*", () => {
    expect(body, `${SPEC} is missing`).not.toBeNull();
    const paragraph = body!.match(
      /hand-types dozens of other tallies —([\s\S]*?)— none of them bound by anything/,
    );
    expect(
      paragraph,
      "the citing sentence was reworded and this guard no longer finds it, so the four " +
        "figures it names are unchecked again. Re-point the pattern or delete this case — " +
        "a text guard whose pattern stops matching stops guarding, silently.",
    ).not.toBeNull();

    const cited = [...paragraph![1].matchAll(/\*(\d[\d,]*)[^*]*\*/g)].map(m => m[1]);
    expect(
      cited.length,
      "no italicised figures parsed out of the citing sentence, so the loop below is empty",
    ).toBeGreaterThanOrEqual(4);

    const facts = measuredFactsSection(body!);
    expect(facts, "'## Measured non-obvious facts' was not found").not.toBeNull();

    const orphaned = cited.filter(n => !new RegExp(`\\b${n}\\b`).test(facts!));
    expect(
      orphaned,
      `These figures are cited as examples of the class and their home readings are no ` +
        `longer in *Measured non-obvious facts*. A citation whose source has moved reads ` +
        `exactly like a fresh reading nobody dated. Either restore the reading, or stop ` +
        `citing the figure.`,
    ).toEqual([]);
  });
});

/**
 * The document counts its own criteria in prose, and prose drifts.
 *
 * Round 6 of #1637 found "this spec holds 56 criteria" off by five, in the
 * same section whose own rule is that a document-derived number must be
 * computed rather than typed. It was wrong in THREE places — the standing
 * practice, the work-in-flight note and the readings-table rationale — which
 * is the shape round 5 named: a fact corrected at one site while independent
 * copies are left stale.
 *
 * So the count stops being hand-maintained. Each pattern below is also
 * asserted to match at least once, because a reword that silently stops
 * matching is a check that silently stops checking — and that is the failure
 * mode of every text-scanning guard in this repository.
 */
describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: its own counts are computed, not typed", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;

  test("every stated criterion count equals the criteria actually declared", () => {
    expect(body, `${SPEC} is missing`).not.toBeNull();
    const declared = [...body!.matchAll(/^- \[([ xX])\] (CRC-[A-Z]?\d+):/gm)];
    const total = declared.length;
    const ticked = declared.filter(m => m[1].toLowerCase() === "x").length;
    expect(total, "no criteria parsed, so every claim below would be compared to zero")
      .toBeGreaterThan(40);
    expect(ticked, "no criterion is ticked, so the ticked claims would be vacuous")
      .toBeGreaterThan(0);

    const claims: { what: string; pattern: RegExp; expected: number[] }[] = [
      { what: "This spec holds N criteria", pattern: /This spec holds (\d+) criteria/g, expected: [total] },
      {
        what: "this spec's N criteria as T ticked and U unticked",
        pattern: /this spec's\s+(\d+) criteria as (\d+) ticked and (\d+) unticked/g,
        expected: [total, ticked, total - ticked],
      },
      { what: "N ticked of M", pattern: /(\d+) ticked of (\d+)/g, expected: [ticked, total] },
    ];

    const wrong: string[] = [];
    for (const claim of claims) {
      const hits = [...body!.matchAll(claim.pattern)];
      // Anti-vacuity, per claim. A reworded sentence that no longer matches
      // leaves the number unchecked while the suite stays green, which is
      // worse than the drift this case was written for.
      expect(
        hits.length,
        `no sentence in ${SPEC} matches "${claim.what}". Either the claim was removed — ` +
          `then delete this row — or it was reworded and is now unchecked. A text guard ` +
          `whose pattern stops matching stops guarding, silently.`,
      ).toBeGreaterThan(0);
      for (const hit of hits) {
        claim.expected.forEach((want, i) => {
          const got = Number(hit[i + 1]);
          if (got !== want) wrong.push(`"${hit[0]}" — group ${i + 1} says ${got}, the file has ${want}`);
        });
      }
    }

    expect(
      wrong,
      `${SPEC} states a count of its own criteria that disagrees with the criteria it ` +
        `declares. This is document-derived — the document's own table says such a number ` +
        `"must be computed. A hand-typed one is a defect." Update the prose; do not raise ` +
        `the number here.`,
    ).toEqual([]);
  });
});

/**
 * The class behind rounds 4 through 7 of #1647, closed rather than patched.
 *
 * Each of those rounds found one more hand-typed cross-reference in the prose
 * AROUND the placement table drifting from the table itself, and each was
 * fixed as the single sentence a reviewer happened to read: Phase 5's "Six
 * more belong here" naming five criteria, the PR body claiming CRC-M8 joins
 * Phase 5 when the table places it under *Not adopted — deliberate*, and
 * ADR-003 stating a milestone count the table's rule cannot produce. The
 * reviewer's standing objection across three rounds was that the TABLE gained
 * a guard and the prose narrating it did not, so the next edit reproduces the
 * defect. It was right.
 *
 * These three cases bind the prose to the table. They would each have gone
 * red on the shipped text before this commit, which is the only reason to
 * believe they will catch the next one.
 */
describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: the prose around the table cannot drift from it", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };

  /**
   * Each `### Phase N — …` section's text, keyed by phase number.
   *
   * The LAST section must stop at the placement table, not at the end of the
   * document. The first version of this ended it at `### Exit conditions`,
   * which sits after the table — so Phase 6's "prose" contained every row of
   * the table and the case reported 38 violations, every one an artefact. An
   * instrument that swallows the thing it is comparing against reports total
   * disagreement, which is at least loud; the same slip one boundary smaller
   * would have reported a believable number.
   */
  const phaseSections = (src: string): Map<number, string> => {
    const out = new Map<number, string>();
    const heads = [...src.matchAll(/^#{2,4} Phase (\d+)\b.*$/gm)];
    const stops = [src.indexOf(`\n${PLACEMENT_HEADING}`), src.indexOf("\n### Exit conditions")]
      .filter(i => i > 0);
    heads.forEach((h, i) => {
      const start = h.index! + h[0].length;
      const after = i + 1 < heads.length ? heads[i + 1].index! : src.length;
      const end = Math.min(after, ...stops.filter(s => s > start));
      out.set(Number(h[1]), src.slice(start, end));
    });
    return out;
  };

  test("a `**<Word> more belong here**` count equals the ids that sentence then names", () => {
    expect(body, `${SPEC} is missing`).not.toBeNull();
    const hits = [...body!.matchAll(/\*\*([A-Za-z]+) more belong here[^*]*\.\*\*([\s\S]*?)(?=\n\n|\n\*\*)/g)];
    expect(
      hits.length,
      `no "**<Word> more belong here**" sentence matches any more. Either it was removed — ` +
        `then delete this case — or reworded, and the count is now unchecked.`,
    ).toBeGreaterThan(0);

    const wrong: string[] = [];
    for (const h of hits) {
      const stated = WORDS[h[1].toLowerCase()];
      if (stated === undefined) {
        wrong.push(`"${h[1]} more belong here" — "${h[1]}" is not a number word this case knows`);
        continue;
      }
      const named = new Set([...h[2].matchAll(/\bCRC-[A-Z]?\d+\b/g)].map(m => m[0]));
      if (named.size !== stated) {
        wrong.push(`"${h[1]} more belong here" names ${named.size}: ${[...named].join(", ")}`);
      }
    }
    expect(
      wrong,
      `a phase's prose states a count that disagrees with the criteria it then names. ` +
        `Found on rounds 4, 6 and 7 of #1647, in the same sentence each time.`,
    ).toEqual([]);
  });

  // The third drift rounds 4-7 found — the PR body claiming CRC-M8 joins
  // Phase 5 while the table places it under "Not adopted — deliberate" — has
  // NO guard here, and the reason is worth stating rather than leaving as an
  // apparent oversight.
  //
  // It was in the pull request DESCRIPTION, which is not a file in this tree
  // and which no test can read. A case over the spec's prose cannot reach it.
  //
  // One was attempted and withdrawn: "every criterion a phase section names
  // is in that phase's row". It cannot be written against this document,
  // because the claim/citation distinction here is not structural. Phase 0's
  // prose says *"the same 'needs a second person' constraint CRC-E5 and
  // CRC-E7 carry"* and *"two further criteria — CRC-E6 and CRC-M9 —"*; both
  // are citations, both are correct, and neither is distinguishable by shape
  // from a placement claim. The attempted case reported all four as defects.
  // A guard that reddens correct prose is deleted by the third person it
  // blocks, so it is not shipped — `.claude/rules/checks-must-be-able-to-fail.md`
  // on erring toward NOT reporting.
  //
  // The two cases that remain cover the two drifts that actually recurred in
  // files, and both were proved to catch their own instance.

  test("ADR-003's milestone count is the number of phase rows, spelled as a word", () => {
    // The cross-document half, and the one that took three rounds. ADR-003
    // says milestones are derived one per phase; a count in it that the table
    // cannot produce is the rule and its illustration disagreeing.
    const adrPath = join(REPO, "docs/adr/ADR-003-spec-to-tracker-mapping.md");
    expect(existsSync(adrPath), "ADR-003 is gone — delete this case or re-point it").toBe(true);
    const adr = readFileSync(adrPath, "utf-8");
    const phases = parsePlacementRows(body!).filter(r => /^Phase \d+$/.test(r.placement)).length;
    expect(phases, "no phase rows, so the claim below is compared to zero").toBeGreaterThan(5);

    const claim = adr.match(/\*\*Milestones: ([a-z]+) derived, one not\.\*\*/);
    expect(
      claim,
      "ADR-003 no longer states its derived-milestone count in the form this case reads. " +
        "Reword the case with it, or the count goes unchecked.",
    ).not.toBeNull();
    expect(
      WORDS[claim![1]],
      `ADR-003 says "${claim![1]} derived" and the placement table has ${phases} phase rows`,
    ).toBe(phases);
  });

  test("the Increment-1 plan's issue count is the number of rows it lists", () => {
    // Same class, caught on this document the day it was written: the plan
    // said "sixteen" in three places and listed eighteen rows. A count typed
    // beside a list it does not come from is the drift this whole suite is
    // about, and writing the guard is cheaper than reading the list again.
    const planPath = join(REPO, "docs/adr/ADR-003-increment-1-issue-plan.md");
    expect(
      existsSync(planPath),
      "the Increment-1 plan is gone — delete this case or re-point it",
    ).toBe(true);
    const plan = readFileSync(planPath, "utf-8");

    // A row opens with `**P<phase>-<n> · `. Nothing else in the file does.
    const rows = plan.match(/^\*\*P\d+-\d+ · /gm) ?? [];
    expect(rows.length, "no rows matched, so the claim below is compared to zero").toBeGreaterThan(
      5,
    );

    const heading = plan.match(/^## The ([a-z]+) new issues$/m);
    expect(
      heading,
      "the plan no longer states its issue count in the form this case reads. " +
        "Reword the case with it, or the count goes unchecked.",
    ).not.toBeNull();
    expect(
      WORDS[heading![1]],
      `the plan's heading says "${heading![1]}" and it lists ${rows.length} rows`,
    ).toBe(rows.length);

    // And the two restatements further down, which is where the first draft
    // left two of its three wrong numbers after the heading was corrected.
    for (const m of plan.matchAll(/\b(?:before these|^)([A-Za-z]+) (?:against one|new issues)\b/gm)) {
      const word = m[1].toLowerCase();
      if (WORDS[word] === undefined) continue;
      expect(WORDS[word], `the plan restates its count as "${m[1]}" and lists ${rows.length}`).toBe(
        rows.length,
      );
    }
  });
});

describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: its citations resolve", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;

  test("the spec is present and states criteria, so the readings below are not empty", () => {
    // The positive control. Every assertion in this file is a property of a
    // document, and a missing or emptied document satisfies all of them.
    expect(body, `${SPEC} is missing`).not.toBeNull();
    // The id prefix is not pinned here. Which namespace this spec's criteria
    // live in is a live decision — `SC-<letter><n>` is the per-spec
    // anti-criterion form (`isAntiCriterion`, lib/sc-ids.ts), which is not
    // what these are — and this case is a control on the parse, not a vote on
    // the outcome. The checkbox shape is what makes a line a criterion.
    const criteria = body!.match(/^- \[[ xX]\] [A-Z]+-[A-Z]?\d+:/gm) ?? [];
    expect(criteria.length, "the spec states no criteria, so there is nothing to keep aligned")
      .toBeGreaterThan(40);
    expect(citedPaths(body!).length, "the path extractor matched nothing in a spec that cites paths")
      .toBeGreaterThan(0);
  });

  test("every repo path the spec cites exists", () => {
    // A spec that says a mechanism shipped, naming a file that is not there,
    // is the drift this document exists to prevent — pointed the other way.
    const missing = citedPaths(body!).filter(p => !existsSync(join(REPO, p)));
    expect(
      missing,
      `${SPEC} cites ${missing.length} path(s) that do not exist. Either the artefact moved ` +
        `and the spec is stale, or the citation was wrong when it was written. Fix whichever ` +
        `it is — do not drop the citation.`,
    ).toEqual([]);
  });

  test("every criterion is accounted for in exactly one bucket", () => {
    // The audit section sorts every criterion into five states, and the
    // difference between them is the whole point of it: "nobody can observe
    // this", "this would measure a constant here", "somebody has to decide",
    // "we decided against it" and "nobody has built it" are four different
    // things that an unticked checkbox renders identically.
    //
    // Asserted rather than stated. A document that sorts its own criteria
    // and then says "5 / 8 / 4 / 3 / 2 / 34" in prose is a document making a
    // claim nothing checks, which is the defect
    // `.claude/rules/checks-must-be-able-to-fail.md` names in *In practice*:
    // the sentence answers, in the right file, the question that would have
    // prompted a check. Ticking a criterion without moving it out of its
    // bucket now reds this.
    const declared = [...body!.matchAll(/^- \[([ xX])\] (CRC-[A-Z]?\d+):/gm)];
    expect(declared.length, "no criteria parsed, so the partition below is over nothing")
      .toBeGreaterThan(40);

    // MEMBERSHIP IS A DECLARING POSITION, not a mention — the first cell of a
    // row, or a bullet's leading bold. The same claim-vs-citation distinction
    // `.claude/rules/claiming-sc-coverage.md` draws, one level up, and it is
    // not theoretical here: a first draft of this case read every id in each
    // section and reported CRC-A6 as unobservable (it is cited in CRC-N3's
    // row) and CRC-C2 and CRC-B8 as blocked-on-owner (both cited in prose
    // there). Three false memberships from one loose matcher.
    const ID = /CRC-[A-Z]?\d+/g;
    const section = (heading: string): string => {
      const at = body!.indexOf(heading);
      expect(at, `the audit section "${heading}" is gone — rename it here too`)
        .toBeGreaterThan(-1);
      const ends = [body!.indexOf("\n### ", at + 1), body!.indexOf("\n## ", at + 1)]
        .filter(i => i > 0);
      return body!.slice(at, ends.length > 0 ? Math.min(...ends) : body!.length);
    };
    const firstCells = (s: string) =>
      s.split("\n")
        .filter(l => l.startsWith("| ") && !l.startsWith("|---"))
        .flatMap(l => [...(l.split("|")[1] ?? "").matchAll(ID)].map(m => m[0]));
    const leadingBold = (s: string) =>
      s.split("\n")
        .filter(l => l.startsWith("- **"))
        .flatMap(l => [...(/^- \*\*(.+?)\*\*/.exec(l)?.[1] ?? "").matchAll(ID)].map(m => m[0]));

    const buckets: Record<string, string[]> = {
      bound: declared.filter(m => m[1] !== " ").map(m => m[2]),
      unobservable: firstCells(section("### A mechanism exists; this repository cannot observe it")),
      "not meaningful": firstCells(section("### Cannot be meaningful in this deployment")),
      "blocked on an owner": firstCells(section("### Blocked on an owner decision")),
      // #1469. A sixth state, and NOT a shade of the one above it: blocked
      // means nobody has answered, contested means this repository answers
      // twice in opposite directions and both answers are current. The
      // distinction is what an agent does next — a blocked item waits, a
      // contested one must not be actioned from either document alone — and
      // the cost of not drawing it is on record: CRC-F1 was read out of the
      // Phase 0 list as a setting costing no engineering, applied, and
      // refused every session's push repo-wide through the pre-push hook.
      contested: firstCells(section("### Contested — this repository gives two opposite instructions")),
      "not adopted": firstCells(section("### Deliberately not adopted")),
      "not done": leadingBold(section("### Not done — the remainder")),
    };

    const placements = new Map(
      declared.map(m => [
        m[2],
        Object.entries(buckets).filter(([, ids]) => ids.includes(m[2])).map(([name]) => name),
      ]),
    );
    expect(
      [...placements].filter(([, w]) => w.length === 0).map(([id]) => id),
      "criteria in NO bucket: the audit does not account for them. Add each to one " +
        "of the six sections, or tick it.",
    ).toEqual([]);
    expect(
      [...placements].filter(([, w]) => w.length > 1).map(([id, w]) => `${id} in ${w.join(" and ")}`),
      "criteria in TWO buckets: the states are meant to be exclusive, so one of the " +
        "two placements is wrong. CRC-B8 is the one that looks like an exception and " +
        "is not — its deviations-table row says it is the defect rather than a " +
        "deviation, which is why that table is not a bucket.",
    ).toEqual([]);

    // Every bucket carries somebody, or a section silently emptied and the
    // two assertions above still hold over what is left.
    for (const [name, ids] of Object.entries(buckets)) {
      expect(ids.length, `the "${name}" bucket is empty — did its section lose its rows?`)
        .toBeGreaterThan(0);
    }
  });

  test("the audit section carries no hand-written count", () => {
    // This REPLACES an agreement between the summary sentence and the ticked
    // count, and the replacement is the point.
    //
    // That comparison is *why* the sentence drifted. It held a present-tense
    // claim about a document that moves underneath it, so every criterion
    // that changed bucket silently falsified it, and the repair was always
    // another hand-edit to one sentence. Successive review rounds on #1627
    // each found a DIFFERENT miscount in it — the signature of a class being
    // patched one instance at a time rather than closed. The running count of
    // those rounds is NOT repeated here: an earlier draft of this comment said
    // "three", the spec's own prose later said "five", and the two disagreed
    // for four rounds. A comment restating a number the spec already carries
    // is the same defect this guard exists to catch, in a file no guard reads.
    //
    // The general property that replaces it: this spec may state bucket
    // counts only as a reading taken on a named day. A dated reading cannot
    // drift, because it describes that day rather than this tree. Live
    // counts come from `bun bin/rungate.ts audit-specs`, which derives them
    // instead of restating them.
    const section = untickedBoxSection(body!);
    expect(section, "the audit section is gone, so this guard reads nothing").not.toBeNull();

    // ANY digit, not a list of bucket names. The previous version of this
    // guard matched `bound|not done|contested` and the original sentence
    // bolded all SEVEN buckets, so four spellings walked straight past it —
    // a detector narrower than the thing it detects, which is the shape
    // `.claude/rules/checks-must-be-able-to-fail.md` names and which this
    // very guard committed on the round that introduced it.
    // `[^*\n]` and not `[^*]`: a bolded span is within a line, and letting
    // the class cross newlines pairs the opening `**` with one paragraphs
    // away, so the match swallows prose that contains a digit incidentally.
    // The first draft of this line did exactly that and reported 267 lines.
    const bolded = [...section!.matchAll(/\*\*([^*\n]*\d[^*\n]*)\*\*/g)].map(m => m[1]);
    expect(
      bolded,
      "a bolded number is back in the audit section. Nothing derives it, so it " +
        "drifts the moment a criterion changes bucket — this sentence did, four " +
        "times, and two successive guards were themselves too narrow to catch it. " +
        "Counts belong in `bun bin/rungate.ts audit-specs`, which computes them, " +
        "or in the per-criterion sections below, which are the truth they summarise.",
    ).toEqual([]);
  });

  /**
   * The *Readings taken* table is the only place this spec may call a phase
   * done, and it is a different claim from a ticked checkbox:
   * `audit-specs` reports whether a criterion is BOUND BY A TEST, and a phase
   * exit is an observation on a live pull request that no unit test can name.
   *
   * Which makes the table the easiest thing in the document to lie in. These
   * cases do not — cannot — verify that the observation happened; they verify
   * that a row claiming `EXITED` carries the evidence a reader needs to go and
   * check it themselves: a pull request, the head it was read at, and what was
   * seen. A row that asserts progress and cites nothing fails the suite.
   */
  test("the readings table parses, and at least one row is EXITED", () => {
    // The positive control, and it is load-bearing twice over: a table that
    // stopped parsing and a project with no phase yet exited produce the same
    // empty list, and `readingDefects` would return [] for both.
    const rows = readingRows(body!);
    expect(rows.length, "the Readings-taken table did not parse").toBeGreaterThanOrEqual(7);
    expect(
      rows.filter(r => /^EXITED/.test(r.verdict)).length,
      "no row is EXITED, so the evidence case below asserts nothing",
    ).toBeGreaterThan(0);
  });

  test("every EXITED phase cites a pull request, a head, and what was observed", () => {
    expect(
      readingDefects(body!),
      "a phase is recorded as EXITED without the evidence to check it. An exit is an " +
        "observation on a real pull request, so the row must name the PR, the full head SHA " +
        "it was read at, and what was seen. If the reading has not been taken, the verdict " +
        "is PENDING or UNMEASURED — do not write EXITED and fill the cells in later.",
    ).toEqual([]);
  });

  test("an EXITED row with no evidence is caught, so the case above can fail", () => {
    // Planted, not described. The real table cannot be made to lie on demand,
    // and the previous case passes against a tree where every phase is PENDING
    // for reasons that have nothing to do with the check working.
    const planted = [
      "| Phase | Verdict | PR | Head | Criteria evidenced | What was observed |",
      "|---|---|---|---|---|---|",
      "| **0** | EXITED 2026-10-26 | — | — | — | — |",
      "| **1** | EXITED 2026-10-26 | #1616 | `short` | CRC-C2 | it looked fine |",
      "| **2** | PENDING | — | — | — | — |",
    ].join("\n");
    const defects = readingDefects(planted);
    // Membership, not the count. The count is a poor predictor here and
    // predicting it wrong was the first thing this case caught: one bad row
    // yields up to FOUR defects, so "two bad rows" is not "two defects".
    // What the check must get right is WHICH phases it flags — a check that
    // also flagged the PENDING row would return a longer list and be wrong.
    const flagged = [...new Set(defects.map(d => /phase (\d)/.exec(d)![1]))].sort();
    expect(flagged, "the PENDING row must not be flagged and both EXITED rows must be")
      .toEqual(["0", "1"]);
    // Phase 0 is missing all four; phase 1 has a PR and a criterion but an
    // abbreviated SHA and a one-line observation.
    expect(defects.filter(d => d.startsWith("phase 0")).length).toBe(4);
    expect(defects.filter(d => d.startsWith("phase 1")).map(d => d.replace("phase 1 is EXITED and ", ""))).toEqual([
      "names no full head SHA",
      "records no observation",
    ]);
  });

  /**
   * The cross-reference, both directions. *Work in flight* answers
   * spec→PR — open the document, see which branches are serving it — and the
   * readings table's criteria column answers PR→spec.
   *
   * Neither can be checked for truthfulness offline: whether #1614 is still
   * open is a fact about GitHub. What IS checkable, and is the way a table
   * like this actually rots, is an id that resolves to nothing — a typo, a
   * renamed criterion, or one invented to make a row look connected.
   */
  test("the in-flight table parses and carries rows, so the case below is not vacuous", () => {
    // The positive control. A renamed heading or a reformatted table empties
    // `inFlightRows`, and an empty list satisfies every assertion below it.
    const rows = inFlightRows(body!);
    expect(rows.length, "the Work-in-flight table did not parse").toBeGreaterThanOrEqual(3);
    expect(
      rows.flatMap(r => r.criteria).length,
      "no in-flight row names a criterion, so the resolution check reads nothing",
    ).toBeGreaterThan(0);
    expect(declaredCriteria(body!).size, "no criteria parsed, so every id would read as dangling")
      .toBeGreaterThan(40);
  });

  test("every criterion named by a PR or a reading is one this spec declares", () => {
    expect(
      danglingCriteria(body!),
      "a traceability row points at a criterion id that does not exist in this spec. Either " +
        "the id is a typo, or the criterion was renamed and the row was left behind. Fix the " +
        "row — do not delete the criteria column, which is the only thing connecting a branch " +
        "to the part of this document it is meant to move.",
    ).toEqual([]);
  });

  test("a fabricated criterion id and an empty criteria cell are both caught", () => {
    // Planted. The live tables cannot be made to dangle on demand, and the
    // case above passes on a document whose rows happen to be correct for
    // reasons that say nothing about the check working.
    const planted = [
      "- [ ] CRC-N4: findings do not repeat across rounds",
      "- [x] CRC-C2: a pull request cannot merge while a finding is open",
      "",
      "| PR | Phase / increment | Criteria it is pointed at | State |",
      "|---|---|---|---|",
      "| #1614 | increment 1 | CRC-N4 | open |",
      "| #1620 | increment 9 | CRC-Z9, CRC-C2 | open |",
      "| — | unclaimed | — | not started |",
      "",
      "| Phase | Verdict | PR | Head | Criteria evidenced | What was observed |",
      "|---|---|---|---|---|---|",
      `| **0** | EXITED | #1616 | \`${"a".repeat(40)}\` | CRC-Q1 | ${"x".repeat(50)} |`,
    ].join("\n");
    // Membership, not a count — a bad row can yield more than one defect, and
    // predicting the total wrong is what this file's other planted case
    // already caught once.
    expect(danglingCriteria(planted)).toEqual([
      'in-flight row "#1620" names CRC-Z9, which this spec does not declare',
      'in-flight row "—" names no criterion',
      "reading for phase 0 names CRC-Q1, which this spec does not declare",
    ]);
    // CRC-N4 and CRC-C2 are declared in the planted body and must NOT be
    // flagged — without that the check could be reporting every id it sees.
    expect(danglingCriteria(planted).some(d => /CRC-N4|CRC-C2/.test(d))).toBe(false);
    // And the EXITED row above satisfies the other three evidence clauses, so
    // a missing criteria cell is what `readingDefects` is being asked about.
    const noCriteria = planted.replace("| CRC-Q1 |", "| — |");
    expect(readingDefects(noCriteria)).toEqual([
      "phase 0 is EXITED and names no criterion it evidences",
    ]);
  });

  test("a mis-cited path is caught, so the case above is not green by construction", () => {
    // Driven over a planted body. The real spec cannot be made to mis-cite on
    // demand, and a case that cannot be staged is a case that never runs.
    const planted = "see `evals/ai-review-controls/` and `REVIEW.md` for the control";
    const found = citedPaths(planted);
    expect(found, "the extractor read the planted body differently than intended")
      .toEqual(["REVIEW.md", "evals/ai-review-controls/"]);
    expect(found.filter(p => !existsSync(join(REPO, p)))).toEqual(["evals/ai-review-controls/"]);
  });
});

describe("specs/CODE-REVIEW-CONVERGENCE-SPEC.md: every criterion has exactly one phase", () => {
  const body = existsSync(join(REPO, SPEC)) ? readFileSync(join(REPO, SPEC), "utf-8") : null;
  const HEADING = "### Phase placement — every criterion has exactly one home";

  // The placement table's rows, as {placement, ids}. MEMBERSHIP IS THE SECOND
  // CELL and nothing else — the same claim-vs-citation discipline the bucket
  // partition above draws, and for the same measured reason: a scan of the
  // phase prose reported four criteria placed that Phase 0 only mentions, and
  // missed three that Phase 5 writes as one slash-joined run headed by CRC-M1,
  // in which they never appear whole. Two errors in opposite directions, one
  // believable total.
  //
  // It takes the document rather than closing over it, so the staged case at
  // the bottom runs the REAL heading-lookup, section-slice and cell-split over
  // a planted table. A staged case that reimplements the parse proves
  // `Array.filter` works and nothing about this parser — if `rows()` ever
  // de-duplicated while reading `cells[2]`, the duplicate check would pass
  // vacuously and a reimplemented control would pass with it, which is the
  // *two deciders that agree* shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`. Raised by the reviewer on
  // #1647 and it was right.
  //
  // It is `parsePlacementRows` and not a copy of it for the SAME reason, one
  // level out. `rungate plan-spec` derives this repository's milestones from
  // this table, and a second parser here would be a second decider: a
  // disagreement between what the test polices and what the command creates
  // would be invisible from both sides, and the command is the one that
  // writes to GitHub.
  const rows = (src: string): { placement: string; ids: string[] }[] => {
    expect(src.includes(HEADING), `the placement section is gone or renamed — rename it here too`)
      .toBe(true);
    return parsePlacementRows(src);
  };

  test("the table parses and carries every placement value, so the cases below are not vacuous", () => {
    expect(body, `${SPEC} is missing`).not.toBeNull();
    const parsed = rows(body!);
    expect(parsed.length, "the placement table parsed no rows").toBeGreaterThan(5);
    // The value set is closed and three of the values are deliberately not
    // phases. A row that loses its ids, or a value nobody uses, is the way
    // this table goes quietly wrong.
    for (const row of parsed) {
      expect(row.ids.length, `the "${row.placement}" row lists no criteria`).toBeGreaterThan(0);
    }
    expect(
      parsed.map(r => r.placement).filter(p => !/^Phase [0-6]$/.test(p)).sort(),
      "the non-phase placement values changed. They are deliberate — see the section's " +
        "second paragraph — so if one is gone, say where its criteria went.",
    ).toEqual(["Blocked — needs a second person", "Done", "Not adopted — deliberate", "Not observable here"]);
  });

  test("every criterion this spec declares is placed exactly once", () => {
    const declared = [...body!.matchAll(/^- \[([ xX])\] (CRC-[A-Z]?\d+):/gm)].map(m => m[2]);
    expect(declared.length, "no criteria parsed, so the partition below is over nothing")
      .toBeGreaterThan(40);
    const placed = rows(body!).flatMap(r => r.ids);

    expect(
      declared.filter(id => !placed.includes(id)),
      `criteria with NO phase. The backlog is built from this document and an unplaced ` +
        `criterion reads as finished. Add each to a row of the placement table — ` +
        `"${HEADING.replace("### ", "")}".`,
    ).toEqual([]);
    expect(
      placed.filter((id, i) => placed.indexOf(id) !== i),
      "criteria placed TWICE. The placements are exclusive, so one of the two is wrong.",
    ).toEqual([]);
  });

  test("the table places nothing this spec does not declare", () => {
    // The other direction, and the one a rename breaks. A placement for an id
    // that no longer exists is a row nobody will ever clear.
    const declared = new Set([...body!.matchAll(/^- \[[ xX]\] (CRC-[A-Z]?\d+):/gm)].map(m => m[1]));
    expect(
      rows(body!).flatMap(r => r.ids).filter(id => !declared.has(id)),
      `the placement table names criteria this spec does not declare. Either the id was ` +
        `renamed — fix the row — or the placement was invented.`,
    ).toEqual([]);
  });

  test("a missing and a duplicated placement are both caught, so the cases above can fail", () => {
    // Driven over a PLANTED DOCUMENT through the real `rows()` — the heading
    // lookup, the section slice and the cell split all run. The real table
    // cannot be made wrong on demand, and a case that cannot be staged is a
    // case that never ran.
    const plant = (phase1: string, phase2: string) =>
      [
        "# planted",
        "",
        "- [ ] CRC-A1: one",
        "- [ ] CRC-A2: two",
        "- [ ] CRC-A3: three",
        "",
        HEADING,
        "",
        "| Placement | Criteria | What the value means |",
        "|---|---|---|",
        `| **Phase 1** | ${phase1} | first |`,
        `| **Phase 2** | ${phase2} | second |`,
        "",
        "### Something else",
      ].join("\n");
    const declared = ["CRC-A1", "CRC-A2", "CRC-A3"];

    // The positive control FIRST: a correct table is a clean partition, or
    // the two negatives below could be red for a reason unrelated to the
    // defect they name.
    const ok = rows(plant("CRC-A1, CRC-A2", "CRC-A3")).flatMap(r => r.ids);
    expect(ok.sort(), "the planted document did not parse as intended").toEqual(declared);
    expect(declared.filter(id => !ok.includes(id))).toEqual([]);
    expect(ok.filter((id, i) => ok.indexOf(id) !== i)).toEqual([]);

    // Missing: CRC-A3 placed nowhere.
    const short = rows(plant("CRC-A1, CRC-A2", "CRC-A2")).flatMap(r => r.ids);
    expect(declared.filter(id => !short.includes(id))).toEqual(["CRC-A3"]);

    // Duplicated: CRC-A1 placed under two phases. This is the one that goes
    // vacuous if `rows()` ever de-duplicates while reading the cell, which is
    // why it runs through `rows()` rather than beside it.
    const twice = rows(plant("CRC-A1, CRC-A2", "CRC-A3, CRC-A1")).flatMap(r => r.ids);
    expect(twice.filter((id, i) => twice.indexOf(id) !== i)).toEqual(["CRC-A1"]);

    // And the header row must not be read as a placement, or every count
    // above is off by whatever the header happens to contain.
    expect(rows(plant("CRC-A1, CRC-A2", "CRC-A3")).map(r => r.placement))
      .toEqual(["Phase 1", "Phase 2"]);
  });
});
