/**
 * Read a decomposition plan — step 4 of ADR-003.
 *
 * `plan-spec` turns a spec's Phase placement table into milestones and
 * `plan-deps` turns the order of those milestones into edges. Between them sits
 * the step nothing performed: turning ONE criterion into the RIGHT NUMBER of
 * issues. Measured on 2026-10-29, 42 of the 47 covered criteria sat at exactly
 * one issue — a 1:1 shape nobody chose, produced by hand one issue at a time.
 *
 * The judgement stays in a reviewed file in git. This reads that file; it
 * never decides how many issues a criterion deserves, and it never invents a
 * row. That is the same split `parseRepairPlan` uses, and it is why the
 * refusal below is the interesting half of this module.
 *
 * ## A row the parser cannot read is a rejection with a reason
 *
 * Never a row skipped. An unreadable row and an absent row produce the same
 * shorter list otherwise, and only one of them is a plan somebody can act on
 * (`.claude/rules/config-access.md`, *Silent Default Substitution*). Any
 * rejection makes the whole reading UNMEASURED: a plan that is partly
 * unreadable is not a plan that is partly done, and creating issues is not an
 * operation you want performed from half a table.
 *
 * ## Two of this repository's own rules are enforced here
 *
 * AGENTS.md rule 2 — an issue names the files it will change, and one that
 * cannot is not ready — and rule 3 — under ten files. Both are refusals at
 * plan time rather than findings at review time, because the point of the
 * plan file is that the shape is settled before anything is created.
 */

/** Criterion ids: `CRC-C2`, `SC-640`, `AR-20`. Same shape `parseRepairPlan` reads. */
const CRITERION = /\b[A-Z]+(?:-[A-Z]?\d+)+\b/g;

/** AGENTS.md rule 3. Google's distribution: ~90% of changes touch fewer than ten files. */
export const MAX_FILES = 9;

/**
 * An outcome shorter than this is a title that says nothing, and it becomes
 * the issue's title verbatim. Chosen so "fix the parser" (16) passes and "wip"
 * does not — the bar is a sentence fragment, not a word.
 */
export const MIN_OUTCOME = 12;

export interface DecompositionRow {
  /** The criterion this issue proves. Several rows MAY name the same one — that is decomposition. */
  criterion: string;
  /** Becomes the issue title, verbatim. */
  outcome: string;
  /** Paths this issue will change. Never empty (rule 2), never over MAX_FILES (rule 3). */
  files: string[];
  /** Milestone title, or null for work that belongs to no phase. */
  milestone: string | null;
  /**
   * What must land first. A `#<n>` is an existing issue; anything else is read
   * as another row's outcome in THIS plan, resolved after every row is read.
   */
  blockedBy: string[];
  /** 1-indexed line of the row, for a message somebody can act on. */
  line: number;
}

export interface DecompositionReading {
  /** UNMEASURED FAILS. An empty row list from an unfound table is not a clean one. */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  rows: DecompositionRow[];
  rejected: { line: number; text: string; why: string }[];
}

/** The header the table must open with, so another table is never read as one. */
const HEADER = /^\|\s*Criterion\s*\|\s*Outcome\s*\|\s*Files\s*\|/;

/**
 * Split a row on its UNESCAPED pipes, and turn `\|` back into `|`.
 *
 * `line.split("|")` read the escape as a separator, which made the refusal
 * message for an over-wide row a lie: it told the author to write `\|` and
 * the parser then produced the identical cell count and the identical
 * refusal, with nothing to distinguish the fixed plan from the broken one.
 * Found by the AI review of this change.
 *
 * Measured against `POST /markdown` with `mode=gfm` on 2026-10-30, because
 * the reviewer of a plan reads what GitHub RENDERS and this function reads
 * bytes — a disagreement is a plan somebody approved without seeing:
 *
 * | the row says | GFM renders |
 * |---|---|
 * | `an outcome with a \| pipe in it` | 5 cells, cell 2 holds a literal `\|` |
 * | `an outcome with a \| pipe in it` unescaped | 5 cells — split across two, and the row's LAST cell silently dropped |
 *
 * The second line is why `c.length !== 5` refuses rather than truncating. An
 * over-wide row renders as a well-formed five-column row with a cell missing,
 * so there is nothing in the rendered table for a reviewer to notice.
 */
function rowCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (line[i] === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += line[i];
  }
  out.push(cur);
  return out.slice(1, -1).map(s => s.trim());
}

/** Split a cell on commas, drop the empties. `—` and `-` both mean "none". */
function cells(text: string): string[] {
  const t = text.trim();
  if (t === "" || t === "—" || t === "-") return [];
  return t
    .split(",")
    .map(s => s.trim().replace(/^`|`$/g, ""))
    .filter(s => s !== "");
}

export function parseDecompositionPlan(content: string): DecompositionReading {
  const lines = content.split("\n");
  const start = lines.findIndex(l => HEADER.test(l));
  if (start === -1) {
    return {
      reading: "UNMEASURED",
      unmeasuredReasons: [
        "no `| Criterion | Outcome | Files |` table — a plan with no table reads " +
          "exactly like a plan with nothing left to create",
      ],
      rows: [],
      rejected: [],
    };
  }

  const rows: DecompositionRow[] = [];
  const rejected: { line: number; text: string; why: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const c = rowCells(line);
    const at = i + 1;
    const reject = (why: string): void => {
      rejected.push({ line: at, text: line.slice(0, 70), why });
    };
    // Exactly five. `< 5` let a row with a leaked `|` — an unescaped pipe in
    // an outcome or a blocked-by — through, and only c[0]..c[4] are ever
    // read, so its tail was silently truncated. That is the one thing this
    // module promises not to do. Found by the AI review of this change.
    if (c.length !== 5) {
      reject(
        c.length < 5
          ? `only ${c.length} cells, need 5`
          : `${c.length} cells, need 5 — an unescaped \`|\` in a cell splits the row, and the ` +
            `extra cells would be dropped without this refusal; write it as \`\\|\``,
      );
      continue;
    }
    const criteria = [...c[0].matchAll(CRITERION)].map(m => m[0]);
    if (criteria.length !== 1) {
      reject(
        criteria.length === 0
          ? `first cell holds no criterion id`
          : `first cell names ${criteria.length} criteria (${criteria.join(", ")}) — one row is one issue serving one criterion`,
      );
      continue;
    }
    const outcome = c[1].replaceAll("`", "").trim();
    if (outcome.length < MIN_OUTCOME) {
      reject(`outcome "${outcome}" is ${outcome.length} characters — it becomes the issue title`);
      continue;
    }
    // A `Blocked by` cell is a comma-separated list, and an outcome is how a
    // row is referenced, so an outcome containing a comma is a row no other
    // row can ever name: `cells()` would split the reference into fragments
    // and each fragment fails the "outcome of another row" test. Refused HERE
    // rather than discovered there, because the failure lands on the row
    // doing the referencing and the message blames a table that is correct.
    // Found by the AI review of this change.
    if (outcome.includes(",")) {
      reject(
        `outcome "${outcome}" contains a comma — a \`Blocked by\` cell is a comma-separated ` +
          `list, so no other row could ever reference this one; rewrite the outcome without it`,
      );
      continue;
    }
    const files = cells(c[2]);
    if (files.length === 0) {
      reject("names no file — AGENTS.md rule 2 says that is not ready, so split it before creating it");
      continue;
    }
    if (files.length > MAX_FILES) {
      reject(`names ${files.length} files and the limit is ${MAX_FILES} — AGENTS.md rule 3`);
      continue;
    }
    const m = c[3].trim();
    rows.push({
      criterion: criteria[0],
      outcome,
      files,
      milestone: m === "" || m === "—" || m === "-" ? null : m,
      blockedBy: cells(c[4]),
      line: at,
    });
  }

  const reasons: string[] = [];
  if (rows.length === 0 && rejected.length === 0) {
    reasons.push("the table has a header and no rows");
  }

  // Two rows with the same outcome would create two issues with one title, and
  // nothing downstream could then say which one a `blocked by` reference meant.
  const byOutcome = new Map<string, number>();
  for (const r of rows) {
    const first = byOutcome.get(r.outcome);
    if (first !== undefined) {
      reasons.push(`"${r.outcome}" appears twice, at lines ${first} and ${r.line}`);
    }
    byOutcome.set(r.outcome, r.line);
  }

  // A blocker naming neither an existing issue nor another row in this plan is
  // an order nothing can apply. Silently dropping it is the failure mode rule 4
  // exists to prevent: the edge would be absent and the plan would read as
  // satisfied.
  for (const r of rows) {
    for (const b of r.blockedBy) {
      if (/^#\d+$/.test(b)) continue;
      // ANOTHER row, which the message below already said and the check did
      // not: `byOutcome` holds every row including this one, so a row naming
      // its own outcome passed. `--write` then resolved both ends of the edge
      // to one freshly created number and called `addBlockedBy(n, n)` — an
      // issue blocked by itself, which is never startable. Found by the AI
      // review of this change.
      if (b === r.outcome) {
        reasons.push(`line ${r.line}: blocked by itself — an issue that blocks itself never starts`);
        continue;
      }
      if (byOutcome.has(b)) continue;
      reasons.push(
        `line ${r.line}: blocked by "${b}", which is neither #<issue> nor the outcome of another row`,
      );
    }
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

/** What the tracker already holds, so a re-run creates nothing twice. */
export interface LiveTracker {
  /** Title → number, for every OPEN issue. The idempotence key. */
  openTitles: Map<string, number>;
  /** Milestone titles that exist. A plan naming one that does not is refused. */
  milestones: Set<string>;
}

export type DecomposeAction =
  /** Nothing on the tracker has this title; create it. */
  | { kind: "create"; row: DecompositionRow; title: string; body: string }
  /** An open issue already has this exact title. Re-runs land here. */
  | { kind: "exists"; row: DecompositionRow; number: number };

export interface DecompositionPlan {
  /** UNMEASURED means apply NOTHING — not "apply the readable part". */
  reading: "MEASURED" | "UNMEASURED";
  unmeasuredReasons: string[];
  actions: DecomposeAction[];
  /** `blocked` and `blocker` are row outcomes or `#<n>`, resolved by the caller. */
  edges: { blocked: string; blocker: string }[];
}

/**
 * Turn rows into what would be done, against the tracker as it is now.
 *
 * Pure, and the only place that decides. The script holds the IO and restates
 * this reading rather than taking its own view — one binding to mutate, so a
 * test can prove the refusals are what a case observed.
 *
 * ## Re-running is the normal case, not the exceptional one
 *
 * The title is the identity. An open issue whose title equals a row's outcome
 * IS that row, already created, so the row becomes `exists` and its edges are
 * still wired. Without that, the second run of a plan whose first run died
 * halfway creates duplicates of everything that succeeded — and `plannedTitles`
 * would authorise every one of them, because the plan still names them.
 *
 * The match is exact, for the reason `lib/filing-plan.ts` gives about
 * substrings. A CLOSED issue with the same title does not count: closing it is
 * how somebody says the work is done, and reopening that argument by refusing
 * to create is worse than a duplicate somebody can close.
 */
export function planDecomposition(
  rows: readonly DecompositionRow[],
  live: LiveTracker,
  planPath: string,
  criteriaHeading: string,
): DecompositionPlan {
  const reasons: string[] = [];

  // A milestone that does not exist is a refusal, never a creation. `plan-spec`
  // owns making them; creating one here would mean this command invented a
  // phase nobody put in a spec's placement table.
  for (const r of rows) {
    if (r.milestone !== null && !live.milestones.has(r.milestone)) {
      reasons.push(
        `line ${r.line}: milestone "${r.milestone}" does not exist — run \`rungate plan-spec\` ` +
          `so the spec's placement table creates it, or correct the row`,
      );
    }
  }

  const actions: DecomposeAction[] = [];
  for (const r of rows) {
    const existing = live.openTitles.get(r.outcome);
    if (existing !== undefined) {
      actions.push({ kind: "exists", row: r, number: existing });
      continue;
    }
    actions.push({
      kind: "create",
      row: r,
      title: r.outcome,
      body: decomposedBody(r, criteriaHeading, planPath),
    });
  }

  const edges: { blocked: string; blocker: string }[] = [];
  for (const r of rows) {
    for (const b of r.blockedBy) edges.push({ blocked: r.outcome, blocker: b });
  }

  return {
    reading: reasons.length > 0 ? "UNMEASURED" : "MEASURED",
    unmeasuredReasons: reasons,
    actions,
    edges,
  };
}

/**
 * The body a created issue carries.
 *
 * It names the criterion in the section `lib/issue-repair.ts` already owns the
 * spelling of, so one reader finds both a created issue and a repaired one.
 * The files are listed because rule 2 is about the issue, not about the plan:
 * an issue whose file list lives only in a plan file is one nobody can check.
 */
export function decomposedBody(
  row: DecompositionRow,
  criteriaHeading: string,
  planPath: string,
): string {
  return [
    `## Criterion`,
    ``,
    `${row.outcome}`,
    ``,
    `## Files this will change`,
    ``,
    ...row.files.map(f => `- \`${f}\``),
    ``,
    criteriaHeading,
    ``,
    row.criterion,
    ``,
    `---`,
    ``,
    `Created by \`rungate plan-issues --decompose ${planPath}\` from a reviewed plan.`,
    `The plan is the record of why this is one issue and not two.`,
  ].join("\n");
}
