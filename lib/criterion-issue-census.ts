/**
 * Which ticked criteria an open issue NAMES — and nothing else.
 *
 * ## The one design decision in this file, stated out loud
 *
 * The column is **"an open issue names this criterion"**. It is mechanical,
 * re-derivable from the tree and the tracker by anyone at any time, and two
 * people running it get the same answer.
 *
 * The column is **not** "an open issue contradicts this criterion". That
 * sounds like the useful question and it is the one that must not be a
 * column, because it is a judgement. A boolean nobody can re-derive, settable
 * by whoever is looking, is exactly the defect this whole line of work exists
 * to escape: a tick in a checkbox is a human-settable boolean asserting that
 * something is true, and `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` is bound to
 * the evidence rule precisely so that a tick has to name what proved it. A
 * "contradicts" column rebuilds the mechanical-tick-is-proof defect one level
 * up, in the instrument built to measure it.
 *
 * So the judgement is recorded **separately, dated and attributed**, in the
 * shape OSCAL gives an observation: a thing somebody observed, when, and by
 * what method — never a property of the subject. {@link Adjudication} is that
 * record. A row carries at most one, and carries it only while the criterion's
 * wording is unchanged: an adjudication whose fingerprint no longer matches is
 * reported **STALE**, not silently carried onto text nobody adjudicated. That
 * is the same rule `lib/spec-evidence.ts` applies to `proved-by:`.
 *
 * ## Signal to noise, measured before this was written
 *
 * A sweep of every ticked criterion in the tree against every open issue on
 * 2026-10-28 produced **12 raw hits, of which 2 were confirmed and 1
 * plausible**: CRC-M11 (#1592 — the metric counts run ATTEMPTS, the sentence
 * says ROUNDS), CRC-B7 (#1567 — nobody has observed a demotion on the live
 * path), and SC-518 (#1585). Three were citations, where the issue names the
 * criterion because it is working on it. Six were ambiguous-id noise.
 *
 * ## What this instrument cannot see, found by using it
 *
 * **It reads OPEN issues only, so a contradiction recorded in a closed issue
 * is invisible.** That is not hypothetical: the first run adjudicated SC-453
 * against #1162, which names the criterion only inside a *Related* line
 * pointing at #1161 — *"SC-453 ticked without an implementation"* — and #1161
 * is closed. So the census reports the citation and cannot report the claim
 * the citation points at. Widening to closed issues is not obviously right
 * either: most closed issues are closed because the thing was done, so the
 * population would be mostly noise. Stated here rather than fixed, because an
 * instrument whose blind spot is written down is a different thing from one
 * whose blind spot is not.
 *
 * Which is why the two ambiguity classes below are excluded rather than
 * reported and filtered later: an `SC-1`..`SC-9` match is as likely to be an
 * issue's own numbering as a reference to a spec's criterion, and an `SC-A<n>`
 * anti-criterion is numbered per spec so the id alone does not identify one.
 * Reporting them would make the mechanical column itself unreliable, and a
 * mechanical column that needs a human to discount half its rows is a
 * judgement wearing a census's clothes.
 */

import { criterionFingerprint, isIsoDay, parseCriteria } from "./spec-evidence";
import { isAntiCriterion, isIssueShaped, isTemplateSpec, oneScMentionPattern } from "./sc-ids";

/** An open issue, reduced to the two fields a name-match can read. */
export interface IssueRef {
  number: number;
  title: string;
  body: string;
}

/** A spec, as read off disk. `file` is repo-relative. */
export interface SpecRef {
  file: string;
  content: string;
}

/**
 * A judgement somebody made about one (criterion, issue) pair.
 *
 * `collected` and `by` are not optional and not defaulted. An observation with
 * no date and no observer is an assertion, which is the thing this record
 * exists not to be.
 */
export interface Adjudication {
  criterion: string;
  issue: number;
  /**
   * `contradicts` — the issue says the ticked criterion is not true.
   * `cites` — the issue names the criterion as the work it is doing.
   * `unrelated` — the id matched and the issue is about something else.
   */
  verdict: "contradicts" | "cites" | "unrelated";
  by: string;
  /** YYYY-MM-DD, the day the judgement was made. */
  collected: string;
  note: string;
  /** The criterion's fingerprint when the judgement was made. */
  fingerprint: string;
}

/** What the adjudication record says about a row, right now. */
export type AdjudicationStanding =
  | { status: "none" }
  | { status: "current"; record: Adjudication }
  | { status: "stale"; record: Adjudication; fingerprint: string };

export interface CensusRow {
  spec: string;
  id: string;
  ticked: boolean;
  fingerprint: string;
  /** Open issues naming this criterion, ascending. The mechanical column. */
  namedBy: number[];
  /** One standing per naming issue, keyed by issue number. */
  standing: Record<number, AdjudicationStanding>;
}

/**
 * Ids whose match carries no information, and why each is excluded.
 *
 * Exported so a test can assert the exclusion is the one documented rather
 * than whatever the predicate happens to do today.
 */
export function isAmbiguousId(id: string): boolean {
  return isIssueShaped(id) || isAntiCriterion(id);
}

/**
 * The spec template is a worked example, not a document making claims.
 *
 * `specs/SPEC-TEMPLATE.md` ships `- [x] SC-2: [second criterion]` to show an
 * author what a ticked line looks like. That placeholder stays out of the
 * census today only because `SC-2` is single-digit and therefore ambiguous —
 * renumber it to `SC-10` while leaving it ticked and the template's
 * boilerplate becomes a row indistinguishable from a real contested
 * criterion. Excluding the file by name is what `buildScRegistry` already
 * does, and it does not depend on how the example happens to be numbered.
 * Raised by the required reviewer on #1641.
 */
// `isTemplateSpec` from `./sc-ids` — the function `buildScRegistry` itself
// calls — rather than a second list here. The first draft of this shipped its
// own `EXCLUDED_SPECS` array while the comment above claimed it did what
// `buildScRegistry` does; that is the "two deciders that agree" shape
// `.claude/rules/checks-must-be-able-to-fail.md` names, and the failure is
// silent — a mutation of either leaves the other holding every case up, so
// both read as covered and nobody can see which one is dead. Raised by the
// required reviewer on #1641, round 4.

/**
 * Refuse an adjudication record this module cannot read, naming it.
 *
 * The store is hand-maintained JSON, so `"issue": "1567"` as a string is a
 * plausible typo — and it would throw nowhere: the lookup in {@link
 * censusRows} is a strict `===`, so the record simply never matches and the
 * row reports UNADJUDICATED while a human's judgement sits in the file. That
 * is the same corruption-as-absence the file-level read was fixed for, one
 * level down. Raised by the required reviewer on #1641.
 */
export function assertAdjudicationShape(
  record: unknown,
  at: string,
): asserts record is Adjudication {
  if (record === null || typeof record !== "object") {
    throw new Error(`${at} is not an object. A record this module cannot read is a refusal.`);
  }
  const r = record as Partial<Adjudication>;
  const problems: string[] = [];
  for (const key of ["criterion", "by", "fingerprint"] as const) {
    if (typeof r[key] !== "string" || r[key]!.length === 0) {
      problems.push(`\`${key}\` must be a non-empty string, got ${JSON.stringify(r[key])}`);
    }
  }
  if (typeof r.note !== "string") {
    problems.push(`\`note\` must be a string, got ${JSON.stringify(r.note)}`);
  }
  // Named rather than coerced. `"1567"` is a typo somebody should see, and
  // silently accepting it teaches the store that either spelling works.
  if (typeof r.issue !== "number" || !Number.isInteger(r.issue)) {
    problems.push(`\`issue\` must be an integer, got ${JSON.stringify(r.issue)}`);
  }
  if (!["contradicts", "cites", "unrelated"].includes(r.verdict as string)) {
    problems.push(
      `\`verdict\` must be contradicts, cites or unrelated, got ${JSON.stringify(r.verdict)}`,
    );
  }
  // `isIsoDay` from `lib/spec-evidence.ts`, not a second regex. The pattern
  // alone accepts `2026-02-30`, which is not a day, and a record dated to a
  // day that does not exist prints in the view as though somebody looked at
  // the issue on it. Reusing the module's own validator also keeps this from
  // becoming the "two deciders that agree" shape
  // `.claude/rules/checks-must-be-able-to-fail.md` names: a second copy here
  // would survive any mutation of the first and nobody could tell which one
  // the suite was holding up. Raised by the required reviewer on #1641.
  if (!isIsoDay(r.collected ?? "")) {
    problems.push(`\`collected\` must be a real YYYY-MM-DD day, got ${JSON.stringify(r.collected)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${at} is malformed and would silently report as UNADJUDICATED: ${problems.join("; ")}.`,
    );
  }
}

/**
 * Refuse a store holding two judgements for the same (criterion, issue).
 *
 * The lookup below is a `find`, so it takes the FIRST match and the rest are
 * invisible — and the store is hand-maintained and append-ordered, which makes
 * appending a correction the obvious way to change your mind. Under a `find`
 * that correction never takes effect and the view keeps printing the judgement
 * it replaced, with its original date and signer, looking entirely current.
 *
 * Taking the last record instead would be the cheap fix and the wrong one: it
 * makes the store's meaning depend on line order, which nothing states and no
 * reader can see. Two records for one pair is somebody's unresolved
 * disagreement, and the only honest reading of it is a refusal. Raised by the
 * required reviewer on #1641 — the same corruption-as-absence shape as the
 * file read and the per-record validation, one level further out.
 */
export function assertOneJudgementPerPair(adjudications: readonly Adjudication[]): void {
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  adjudications.forEach((a, at) => {
    const key = `${a.criterion}/#${a.issue}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, at);
    else duplicates.push(`${key} (records ${first} and ${at})`);
  });
  if (duplicates.length > 0) {
    throw new Error(
      `the adjudication store holds more than one judgement for: ${duplicates.join("; ")}. ` +
        `The lookup takes the first match, so every later record — including a correction ` +
        `appended deliberately — would be silently ignored. Edit the existing record instead.`,
    );
  }
}

/** Does this issue name this criterion, on a word boundary? */
export function issueNames(issue: IssueRef, id: string): boolean {
  const pattern = oneScMentionPattern(id);
  return pattern.test(issue.title) || pattern.test(issue.body ?? "");
}

/**
 * The census.
 *
 * Only ticked criteria are rows: an open issue naming an UNTICKED criterion is
 * the normal way work is tracked and says nothing is wrong. The question this
 * answers is narrower and is the one with a defect behind it — *this document
 * says we have done something, and the tracker has something open that names
 * it.*
 */
export function censusRows(
  specs: readonly SpecRef[],
  issues: readonly IssueRef[],
  adjudications: readonly Adjudication[],
): CensusRow[] {
  assertOneJudgementPerPair(adjudications);
  const rows: CensusRow[] = [];

  for (const spec of specs) {
    if (isTemplateSpec(spec.file)) continue;
    for (const c of parseCriteria(spec.content)) {
      if (!c.ticked) continue;
      if (isAmbiguousId(c.id)) continue;

      const namedBy = issues
        .filter(i => issueNames(i, c.id))
        .map(i => i.number)
        .sort((a, b) => a - b);
      if (namedBy.length === 0) continue;

      const fingerprint = criterionFingerprint(c.text);
      const standing: Record<number, AdjudicationStanding> = {};
      for (const issue of namedBy) {
        const record = adjudications.find(
          a => a.criterion === c.id && a.issue === issue,
        );
        if (!record) {
          standing[issue] = { status: "none" };
        } else if (record.fingerprint === fingerprint) {
          standing[issue] = { status: "current", record };
        } else {
          standing[issue] = { status: "stale", record, fingerprint };
        }
      }

      rows.push({ spec: spec.file, id: c.id, ticked: true, fingerprint, namedBy, standing });
    }
  }

  return rows;
}

/**
 * Rows a person still owes a judgement on: named by an issue, and either never
 * adjudicated or adjudicated against wording that has since changed.
 */
export function unadjudicated(rows: readonly CensusRow[]): CensusRow[] {
  return rows.filter(r =>
    r.namedBy.some(i => r.standing[i].status !== "current"),
  );
}

/** The view, as text. One line per (criterion, issue) pair. */
export function renderCensus(rows: readonly CensusRow[], taken: string): string {
  const out: string[] = [
    `criterion/issue census — ${taken}`,
    `  ${rows.length} ticked criterion(s) are named by an open issue.`,
    "",
  ];
  for (const r of rows) {
    for (const issue of r.namedBy) {
      const s = r.standing[issue];
      const verdict =
        s.status === "none"
          ? "UNADJUDICATED"
          : s.status === "stale"
            ? `STALE (judged ${s.record.verdict} by ${s.record.by} on ${s.record.collected}, ` +
              `against fingerprint ${s.record.fingerprint}; the text now hashes to ${s.fingerprint})`
            : `${s.record.verdict.toUpperCase()} (${s.record.by}, ${s.record.collected})`;
      out.push(`  ${r.id} (${r.spec}) named by #${issue} — ${verdict}`);
      if (s.status !== "none" && s.record.note) out.push(`      ${s.record.note}`);
    }
  }
  return out.join("\n");
}
