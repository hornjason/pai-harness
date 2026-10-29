/**
 * Repairing an issue's link back to the spec — step 4 of ADR-003, in reverse.
 *
 * `plan-spec` derives milestones from the spec and `plan-deps` derives the
 * order from the milestones. Both read DOWN from the spec. This reads a
 * repair plan a person wrote and applies it UP: an issue that names no
 * criterion is invisible to `criterion-inventory`, to `plan-spec`'s coverage
 * report and to `board-mirror`'s Criteria column, because all three match the
 * criterion id as literal text in the body.
 *
 * Measured 2026-10-29: 11 of 39 open convergence issues named no criterion.
 * The classification of all eleven is
 * `docs/adr/ADR-005-backlog-criterion-repair.md`, approved by Jason.
 *
 * ## The judgement is in the plan file, never here
 *
 * Which criterion an issue serves is an adjudication. This file parses a
 * table somebody reviewed and refuses anything it cannot read, rather than
 * inferring a link from an issue's title — a tool that guessed would write a
 * criterion id into a body and make `plan-spec` report a phase as covered
 * when nothing is working on it. That is the coverage report lying in the
 * direction that hides a gap.
 *
 * ## DEMOTE removes the milestone, and that is not a close
 *
 * A phase milestone means *this phase of the spec*. An issue in it serving no
 * criterion keeps the milestone open after every criterion is true, so nobody
 * can tell real remaining work from a stray card — and `plan-deps` blocks the
 * whole next phase on it. Closing instead would destroy the measurements in
 * those bodies and move both sides of the opened-against-closed ratio
 * `AGENTS.md` rule 7 asks us to watch.
 */

/** The section a repaired body carries. One spelling, by fiat. */
export const CRITERIA_HEADING = "## Criteria this serves";

export type RepairKind = "annotate" | "demote";

export interface RepairRow {
  issue: number;
  phase: number;
  kind: RepairKind;
  /** Criterion ids, in table order. Always empty for `demote`. */
  criteria: string[];
  confidence: string;
  /** 1-indexed line of the row, for a message somebody can act on. */
  line: number;
}

export interface RepairReading {
  /** UNMEASURED FAILS. An empty row list from an unfound table is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  rows: RepairRow[];
  /** Rows the parser reached and rejected, with why. */
  rejected: { line: number; text: string; why: string }[];
}

/** The header the table must open with, so another table is never read as one. */
const HEADER = /^\|\s*Issue\s*\|\s*Phase\s*\|\s*Repair\s*\|/;

/**
 * Every row of a repair plan's table.
 *
 * A row the parser cannot read is a **rejection with a reason**, never a row
 * skipped. An unreadable row and an absent row produce the same empty result
 * otherwise, and only one of them is a plan somebody can act on
 * (`.claude/rules/config-access.md`, *Silent Default Substitution*).
 */
export function parseRepairPlan(content: string): RepairReading {
  const lines = content.split("\n");
  const start = lines.findIndex(l => HEADER.test(l));
  const reasons: string[] = [];
  if (start === -1) {
    return {
      reading: "UNMEASURED",
      unmeasuredReasons: [
        "no `| Issue | Phase | Repair |` table — a plan with no table reads exactly " +
          "like a plan with nothing left to do",
      ],
      rows: [],
      rejected: [],
    };
  }

  const rows: RepairRow[] = [];
  const rejected: { line: number; text: string; why: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    const at = i + 1;
    if (cells.length < 5) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `only ${cells.length} cells, need 5` });
      continue;
    }
    const issue = Number((cells[0].match(/#(\d+)/) ?? [])[1]);
    const phase = Number(cells[1]);
    const kindCell = cells[2].replaceAll("*", "").trim();
    const kind: RepairKind | null =
      kindCell === "(a)" ? "annotate" : kindCell === "(b)" ? "demote" : null;
    const criteria = [...cells[3].matchAll(/\b[A-Z]+(?:-[A-Z]?\d+)+\b/g)].map(m => m[0]);

    if (!Number.isInteger(issue)) {
      rejected.push({ line: at, text: line.slice(0, 70), why: "first cell holds no #<number>" });
      continue;
    }
    if (!Number.isInteger(phase)) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `phase "${cells[1]}" is not a number` });
      continue;
    }
    if (kind === null) {
      rejected.push({ line: at, text: line.slice(0, 70), why: `repair "${kindCell}" is neither (a) nor (b)` });
      continue;
    }
    // The two halves must agree. An `(a)` naming nothing would annotate a body
    // with an empty list, and a `(b)` naming criteria is a row whose author
    // changed their mind in one cell and not the other.
    if (kind === "annotate" && criteria.length === 0) {
      rejected.push({ line: at, text: line.slice(0, 70), why: "(a) names no criterion" });
      continue;
    }
    if (kind === "demote" && criteria.length > 0) {
      rejected.push({
        line: at,
        text: line.slice(0, 70),
        why: `(b) names ${criteria.join(", ")} — demote and a criterion disagree`,
      });
      continue;
    }
    rows.push({ issue, phase, kind, criteria, confidence: cells[4], line: at });
  }

  if (rows.length === 0 && rejected.length === 0) {
    reasons.push("the table has a header and no rows");
  }
  const seen = new Map<number, number>();
  for (const r of rows) {
    const first = seen.get(r.issue);
    if (first !== undefined) {
      reasons.push(`#${r.issue} appears twice, at lines ${first} and ${r.line}`);
    }
    seen.set(r.issue, r.line);
  }
  if (rejected.length > 0) {
    reasons.push(
      `${rejected.length} row(s) could not be read — a plan that is partly unreadable is ` +
        `not a plan that is partly done`,
    );
  }

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    rows,
    rejected,
  };
}

/**
 * The body an `annotate` row should produce, and whether it differs.
 *
 * Appends `## Criteria this serves` when absent and REPLACES its contents
 * when present, so a re-run with an edited plan converges rather than
 * stacking a second section. The rest of the body is untouched — those
 * bodies carry the measurements that make the issues worth keeping.
 */
export function annotatedBody(body: string, criteria: readonly string[]): string {
  const ids = criteria.join(", ");
  const section = `${CRITERIA_HEADING}\n\n${ids}\n`;
  const at = body.indexOf(CRITERIA_HEADING);
  if (at === -1) return `${body.replace(/\s*$/, "")}\n\n${section}`;
  // Up to the next `## ` heading, or the end.
  const rest = body.slice(at + CRITERIA_HEADING.length);
  const nextAt = rest.search(/^## /m);
  return nextAt === -1
    ? `${body.slice(0, at)}${section}`
    : `${body.slice(0, at)}${section}\n${rest.slice(nextAt)}`;
}

/** True when the body already names every criterion the row asks for. */
export function alreadyAnnotated(body: string, criteria: readonly string[]): boolean {
  return annotatedBody(body, criteria) === body;
}
