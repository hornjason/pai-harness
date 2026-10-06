/**
 * Recover the compliance grades that every ship run produced and then threw away.
 *
 * Each run writes `compliance-grade.json` into its work directory under
 * `~/.rungate/<slug>/`. Nothing ever moved those into
 * `~/.rungate/compliance-history.jsonl`, which is the file that
 * `generateComplianceReport` reads for every trend line, every "declining"
 * verdict, and every hill-climb decision. The history held four entries, all
 * synthetic, all named `#compliance-test-N`, while 149 real role-records sat
 * on disk.
 *
 * So: the compliance system has been reporting trends over a fixture, and the
 * real measurements were discarded at the end of each run.
 *
 * WHAT THIS MODULE IS CAREFUL ABOUT
 *
 * - **Order.** `generateComplianceReport` treats the LAST five entries per role
 *   as the recent window. Appending September records to a file ending in
 *   October would make the oldest runs the newest, producing confident trend
 *   lines that run backwards. `mergeHistory` sorts; it never appends.
 * - **Re-runs.** This is the sort of script someone runs twice. Identity is
 *   `source + role`, so a second pass adds nothing — and the two roles inside
 *   one grade file stay distinct rather than one being eaten as a duplicate.
 * - **Provenance.** Backfilled entries are marked `backfilled: true` and keep
 *   their `slug`. The slug matters because #114 means runs were filed under a
 *   hardcoded `ddb-` prefix regardless of repo; normalising it away would
 *   destroy the only record of which runs were misattributed.
 * - **Nothing silently skipped.** Unparseable and grade-less files are returned
 *   in their own buckets and the counts are made to add up, rather than a quiet
 *   `continue` that leaves an unexplained gap between 59 files and 57 results.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, relative } from "path";

import type { ComplianceEntry } from "./compliance-report";

/** A grade file on disk, before it becomes history entries. */
interface GradeRule {
  id?: string;
  verdict?: string;
}

interface Grade {
  role: string;
  total: number;
  followed: number;
  rules?: GradeRule[];
  flagged?: string[];
}

export interface BackfillPlan {
  /** Grade files examined, whatever became of them. */
  scanned: number;
  /** New entries, in no particular order — pass them through mergeHistory. */
  added: BackfilledEntry[];
  /** Role-records already represented in the supplied history. */
  alreadyPresent: number;
  /** Paths whose JSON did not parse. */
  unparseable: string[];
  /** Paths that parsed but carried no grades — 2 of the 59 real files. */
  emptyGrades: string[];
}

export interface BackfilledEntry extends ComplianceEntry {
  /** Work-directory name, e.g. `ddb-588-stale`. Evidence for #114. */
  slug: string;
  /** Path of the grade file this was reconstructed from, relative to the root. */
  source: string;
  /**
   * Which grading of this role within this run, 0-based.
   *
   * A run can grade the same role more than once — 57 usable files hold 91
   * marcus records. Keying identity on `source + role` alone silently dropped
   * 35 of 149, and every count still looked plausible.
   */
  ordinal: number;
  /** Always true here. Distinguishes a reconstruction from a live measurement. */
  backfilled: true;
}

/** Identical to scripts/persist-compliance.ts:69. Two rounding rules in one
 *  trend line would silently put backfilled and live entries on different
 *  scales, and `0/0` as NaN serialises to null and poisons every average. */
const pct = (g: Grade) => (g.total > 0 ? Math.round((100 * g.followed) / g.total) : 0);

/**
 * `source + role + ordinal` — the only key under which 149 records stay 149.
 *
 * `source + role` looks sufficient and is not: a run can grade the same role
 * repeatedly (hill-climb iterations), and 57 usable files hold 91 marcus
 * records. The narrower key dropped 35 of them with no error and no gap in any
 * count that was being printed.
 */
const identity = (e: { source?: string; slug?: string; role: string; ordinal?: number }) =>
  `${e.source ?? e.slug ?? ""}::${e.role}::${e.ordinal ?? 0}`;

/**
 * Every `compliance-grade.json` one level under the root, INCLUDING `.archive/`.
 *
 * The archive is a dot-directory, which a shell glob and Python's `glob` both
 * skip by default. Counting it wrongly is not hypothetical: two sessions
 * miscounted this exact directory on the way here, in opposite directions. So
 * it is named explicitly rather than left to a pattern.
 */
function findGradeFiles(root: string): string[] {
  const out: string[] = [];
  const sweep = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const workDir = join(dir, name);
      let isDir = false;
      try { isDir = statSync(workDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const grade = join(workDir, "compliance-grade.json");
      if (existsSync(grade)) out.push(grade);
    }
  };
  sweep(root);
  sweep(join(root, ".archive"));
  return out.sort();
}

/**
 * Issue number for a work directory.
 *
 * `workflow-state.json` wins because it is what the run itself recorded; the
 * slug is what the harness guessed. They disagree in 5 of the 57 real cases.
 * A slug with no trailing number yields `#unknown` rather than being dropped —
 * dropping it would shrink the dataset this exists to recover.
 */
function resolveIssue(workDir: string, slug: string): string {
  const wsPath = join(workDir, "workflow-state.json");
  if (existsSync(wsPath)) {
    try {
      const issue = JSON.parse(readFileSync(wsPath, "utf-8"))?.issue;
      if (issue !== undefined && issue !== null && `${issue}`.trim() !== "") return `#${issue}`;
    } catch {
      // Fall through to the slug. A corrupt workflow-state.json is a reason to
      // use the weaker source, not a reason to lose the grades next to it.
    }
  }
  const trailing = slug.match(/(\d+)(?!.*\d)/);
  return trailing ? `#${trailing[1]}` : "#unknown";
}

export function planComplianceBackfill(root: string, existing: ComplianceEntry[]): BackfillPlan {
  const seen = new Set(existing.map(e => identity(e as BackfilledEntry)));
  const plan: BackfillPlan = { scanned: 0, added: [], alreadyPresent: 0, unparseable: [], emptyGrades: [] };

  for (const gradePath of findGradeFiles(root)) {
    plan.scanned++;
    const workDir = dirname(gradePath);
    const slug = basename(workDir);
    const source = relative(root, gradePath);

    let parsed: { grades?: Grade[] };
    try {
      parsed = JSON.parse(readFileSync(gradePath, "utf-8"));
    } catch {
      plan.unparseable.push(source);
      continue;
    }

    const grades = parsed?.grades ?? [];
    if (grades.length === 0) {
      plan.emptyGrades.push(source);
      continue;
    }

    // The run did not stamp a time, so the grade file's mtime is the best
    // available. It is the moment grading finished, which is what a trend
    // over runs wants.
    const timestamp = new Date(statSync(gradePath).mtime).toISOString();
    const issue = resolveIssue(workDir, slug);

    const roleSeq: Record<string, number> = {};
    for (const g of grades) {
      const ordinal = roleSeq[g.role] ?? 0;
      roleSeq[g.role] = ordinal + 1;
      const entry: BackfilledEntry = {
        timestamp,
        issue,
        role: g.role,
        scores: Object.fromEntries(
          (g.rules ?? []).filter(r => r.id).map(r => [r.id as string, r.verdict || "N/A"]),
        ),
        total: g.total,
        followed: g.followed,
        pct: pct(g),
        flagged: g.flagged ?? [],
        slug,
        source,
        ordinal,
        backfilled: true,
      };
      if (seen.has(identity(entry))) {
        plan.alreadyPresent++;
        continue;
      }
      seen.add(identity(entry));
      plan.added.push(entry);
    }
  }

  return plan;
}

/**
 * Chronological merge. Never an append.
 *
 * The synthetic `#compliance-test-N` entries are kept: they are the only record
 * of what the trend system was reporting before the backfill, and deleting data
 * to make a graph look better is not a backfill.
 */
export function mergeHistory(existing: ComplianceEntry[], added: ComplianceEntry[]): ComplianceEntry[] {
  return [...existing, ...added].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}
