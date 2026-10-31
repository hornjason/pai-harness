/**
 * Did a refused filing become the comment the refusal told it to be?
 *
 * ## The question, and why nothing answered it before
 *
 * `lib/issue-filing-gate.ts` refuses a filing and routes it to a comment. It
 * does not WRITE the comment — it returns a refusal naming where one should
 * go, and the finding survives only if the agent then writes it. So the gate
 * can be working perfectly while findings are being deleted, and the ledger
 * records the refusal either way. **Compliance with a refusal is the one
 * thing nothing in this tree records.**
 *
 * It matters more than it sounds. The measure the cap was shipped against is
 * issues opened per day, and that number falls **identically** whether the
 * agent writes the comment or drops the finding on the floor. A metric that
 * reads the same on the good outcome and the bad one is not measuring the
 * thing anybody wants.
 *
 * ## A rate of zero and a denominator of zero are different readings
 *
 * This module exists in a world where the honest answer is *nobody has been
 * refused yet*: measured 2026-10-25, the production ledger holds 261 rows
 * and **zero** `OVER_CAP` and **zero** `COMMENT_INSTEAD`. So `rate` is
 * `number | null` and is `null` whenever `observable === 0`. Not `0`, and
 * not a thrown error — `0` is the reading that says agents ignore refusals,
 * which is a serious claim to make about a population that does not exist.
 *
 * `unobservableByRefusal` is beside it so the gap is attributable: a reader
 * learns *which* refusals could not be followed up, which is what decides
 * whether the fix is to persist a field or to wait for traffic.
 *
 * ## Why it is an UPPER BOUND and says so in the field name
 *
 * The ledger does not record WHO attempted the filing. So a comment landing
 * on the target inside the window cannot be attributed to the agent that was
 * refused; it may be anyone's, including a human answering something else.
 * Counting it as compliance can only ever overstate.
 *
 * That is still worth having, because the bound is informative in one
 * direction: an upper bound of zero is decisive, and that is the reading we
 * expect to be arguing about. `compliedUpperBound` is named rather than
 * called `complied` so a later reader cannot quote it as a compliance rate.
 *
 * ## A comment is a TIMELINE EVENT. An issue-body edit is not.
 *
 * Measured on this tracker, 2026-10-25: #1592 carries four `commented`
 * timeline events, while #1476 — edited twice on 10-24, at `00:29:52Z` and
 * `01:32:24Z` — carries **no timeline event for either edit**. The edits
 * exist only under GraphQL `userContentEdits`, which nothing subscribes to.
 *
 * So an answer appended to an issue BODY notifies nobody and is not
 * compliance in any sense a human experiences. `ghIssueComments` reads the
 * comments endpoint and never the body, and a `CommentReading` carries only
 * comment timestamps, so no caller of this module can accidentally count a
 * body edit.
 *
 * ## The target is only recoverable for one refusal class today
 *
 * The refusal MESSAGE names a comment target, computed at refusal time. The
 * ledger ROW does not persist it. The one exception is `DUPLICATE`, whose
 * `duplicateOf` holds the issues the finding collided with — so those rows
 * carry their own target and are the only historical population this can
 * read. Everything else is `UNOBSERVABLE`, by name, with the refusal in the
 * reason. Persisting the target on the row is the change that would widen
 * the denominator; that is a decision for whoever reads this output, and it
 * is deliberately not made here.
 */

import { spawnSync } from "node:child_process";

/**
 * The fields of a ledger row this reading needs.
 *
 * Deliberately a structural subset of `FilingLedgerRow` rather than an
 * import of it: rows are read back from JSONL written by two different
 * writers over two days, and several of them predate fields the current
 * interface declares. A reader that required the full shape would refuse
 * the population it exists to measure.
 */
export interface FilingComplianceRow {
  at: string;
  title: string;
  refusal: string | null;
  emitted: boolean;
  /**
   * **Written as STRINGS by the live writer**, and typed to say so.
   *
   * Measured on the production ledger 2026-10-25: all 14 elements across 261
   * rows are decimal strings — `["1214"]` — and the first version of this
   * module accepted only `number`, so it discarded every target it had and
   * reported a denominator of zero for the entire file. That is the failure
   * this module is otherwise built to refuse, arriving through the parser
   * instead of through the data: an empty population and a population the
   * reader could not see are the same output.
   */
  duplicateOf?: readonly (number | string)[];
}

/** Where a refused finding was told to go, or why that cannot be read. */
export type ComplianceTarget =
  | { reading: "NAMED"; issues: number[] }
  | { reading: "UNOBSERVABLE"; why: string };

/**
 * The comments on one target, or the sentence saying why none were read.
 *
 * **An `UNMEASURED` lookup must never render as "no comment".** They are the
 * two readings this whole module exists to keep apart, and a lookup that
 * returned `[]` on an HTTP error would collapse them at the one place a
 * caller cannot see.
 */
export type CommentReading =
  | { reading: "MEASURED"; comments: readonly { at: string }[] }
  | { reading: "UNMEASURED"; why: string };

export type CommentLookup = (issue: number) => Promise<CommentReading>;

export type RowReading =
  | { state: "COMPLIED"; title: string; target: number; at: string }
  | { state: "NOT_OBSERVED"; title: string; targets: number[] }
  | { state: "UNOBSERVABLE"; title: string; why: string };

export interface ComplianceReading {
  rows: RowReading[];
  /** Rows on which compliance could be read at all. The denominator. */
  observable: number;
  /** Rows with no recoverable target, or whose lookup failed. */
  unobservable: number;
  /** See the header: an upper bound, because comments are unattributed. */
  compliedUpperBound: number;
  /** `null` when `observable === 0`. Never `0` for an empty population. */
  rate: number | null;
  /** Which refusals could not be followed up, and how many of each. */
  unobservableByRefusal: Record<string, number>;
}

/** A row that was never refused has nothing to comply with. */
const NOT_REFUSED = "NOT_REFUSED";

/**
 * One `duplicateOf` element as an issue number, or `null`.
 *
 * One binding, so there is one thing to mutate and one place that decides
 * what counts as a target. A value that names no issue returns `null` and
 * the row goes UNOBSERVABLE — never `NaN`, which would be carried into a
 * lookup and come back as an error that reads like a tracker fault.
 */
function issueNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/^#/, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function targetOf(row: FilingComplianceRow): ComplianceTarget {
  if (row.emitted) {
    return {
      reading: "UNOBSERVABLE",
      why: "this filing was not refused — it reached the tracker, so there is no comment to look for",
    };
  }
  const issues = (row.duplicateOf ?? [])
    .map(issueNumber)
    .filter((n): n is number => n !== null);
  if (issues.length > 0) return { reading: "NAMED", issues: [...issues] };
  return {
    reading: "UNOBSERVABLE",
    why:
      `the ledger records no comment target for a ${row.refusal ?? NOT_REFUSED} refusal. ` +
      "The refusal message named one, computed at refusal time; the row does not persist it",
  };
}

/**
 * Was there a comment on this target inside the window?
 *
 * The window is closed at both ends on purpose. A comment written BEFORE the
 * refusal cannot be an answer to it — that is the reading that would turn
 * every duplicate-of-a-busy-issue into compliance — and one written after the
 * window is not evidence about this refusal either.
 */
function commentInWindow(
  reading: CommentReading,
  fromMs: number,
  windowMs: number,
): string | null {
  if (reading.reading !== "MEASURED") return null;
  for (const c of reading.comments) {
    const at = Date.parse(c.at);
    if (Number.isNaN(at)) continue;
    if (at >= fromMs && at <= fromMs + windowMs) return c.at;
  }
  return null;
}

export async function complianceReading(input: {
  rows: readonly FilingComplianceRow[];
  lookup: CommentLookup;
  windowMs: number;
}): Promise<ComplianceReading> {
  const rows: RowReading[] = [];
  const unobservableByRefusal: Record<string, number> = {};

  const countUnobservable = (row: FilingComplianceRow) => {
    const key = row.emitted ? NOT_REFUSED : (row.refusal ?? NOT_REFUSED);
    unobservableByRefusal[key] = (unobservableByRefusal[key] ?? 0) + 1;
  };

  for (const row of input.rows) {
    const target = targetOf(row);
    if (target.reading === "UNOBSERVABLE") {
      rows.push({ state: "UNOBSERVABLE", title: row.title, why: target.why });
      countUnobservable(row);
      continue;
    }

    const from = Date.parse(row.at);
    if (Number.isNaN(from)) {
      rows.push({
        state: "UNOBSERVABLE",
        title: row.title,
        why: `the row's timestamp \`${row.at}\` could not be read, so no window could be opened`,
      });
      countUnobservable(row);
      continue;
    }

    // A single COMPLIED is decisive, so an unreadable sibling target does not
    // demote it. The reverse is not true: NOT_OBSERVED over a target we could
    // not read is the conflation this module exists to refuse.
    let complied: { target: number; at: string } | null = null;
    let unreadable: string | null = null;
    for (const issue of target.issues) {
      const reading = await input.lookup(issue);
      if (reading.reading === "UNMEASURED") {
        unreadable ??= `#${issue} could not be read: ${reading.why}`;
        continue;
      }
      const at = commentInWindow(reading, from, input.windowMs);
      if (at !== null) {
        complied = { target: issue, at };
        break;
      }
    }

    if (complied !== null) {
      rows.push({
        state: "COMPLIED",
        title: row.title,
        target: complied.target,
        at: complied.at,
      });
      continue;
    }
    if (unreadable !== null) {
      rows.push({ state: "UNOBSERVABLE", title: row.title, why: unreadable });
      countUnobservable(row);
      continue;
    }
    rows.push({ state: "NOT_OBSERVED", title: row.title, targets: [...target.issues] });
  }

  const observable = rows.filter(r => r.state !== "UNOBSERVABLE").length;
  const compliedUpperBound = rows.filter(r => r.state === "COMPLIED").length;
  return {
    rows,
    observable,
    unobservable: rows.length - observable,
    compliedUpperBound,
    // The whole point of the module, in one expression: an empty denominator
    // withholds the number rather than printing the most alarming one.
    rate: observable === 0 ? null : compliedUpperBound / observable,
    unobservableByRefusal,
  };
}

/**
 * The real lookup: the tracker's COMMENTS endpoint, never the issue body.
 *
 * Separate from the pure reading above so the cases can drive every state
 * without a network, and exported so the reading can be run from a one-liner
 * rather than needing a script nothing else references:
 *
 * ```
 * bun -e 'import {complianceReading, ghIssueComments} from "./lib/filing-compliance";
 *   const rows = (await Bun.file(process.env.HOME + "/.rungate/finding-ledger.jsonl").text())
 *     .trim().split("\n").map(l => JSON.parse(l));
 *   console.log(await complianceReading({rows, lookup: ghIssueComments("hornjason/pai-harness"),
 *     windowMs: 24 * 3_600_000}));'
 * ```
 *
 * Every failure is `UNMEASURED` carrying its own sentence. There is no path
 * here that returns an empty comment list for a request that did not succeed.
 */
export function ghIssueComments(repo: string): CommentLookup {
  return async (issue: number): Promise<CommentReading> => {
    const run = spawnSync(
      "gh",
      ["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--jq", ".[].created_at"],
      { encoding: "utf-8" },
    );
    if (run.error) return { reading: "UNMEASURED", why: `gh could not be run: ${run.error.message}` };
    if (run.status !== 0) {
      return {
        reading: "UNMEASURED",
        why: `gh exited ${run.status}: ${(run.stderr ?? "").trim() || "no stderr"}`,
      };
    }
    const comments = (run.stdout ?? "")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l !== "")
      .map(at => ({ at }));
    return { reading: "MEASURED", comments };
  };
}
