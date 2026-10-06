/**
 * Backfilling 57 discarded compliance grades into compliance-history.jsonl.
 *
 * Every ship run graded its agents and wrote `compliance-grade.json` into its
 * work directory. `compliance-history.jsonl` — the file every trend line, every
 * "declining" verdict and every hill-climb decision reads — had four entries,
 * all synthetic, all named `#compliance-test-N`. 149 real role-records existed
 * on disk and none of them had ever reached the history.
 *
 * So the compliance system has been reporting trends over a fixture.
 *
 * TWO FAILURE MODES THIS GUARDS
 *
 * 1. APPEND-AT-END. `generateComplianceReport` takes `roleHistory.slice(-5)` —
 *    the last five entries are "recent". Appending a September run to the end
 *    of the file makes it the newest thing that ever happened. A backfill that
 *    appends is worse than no backfill, because it produces confident trend
 *    lines that run backwards. Hence mergeHistory sorts.
 *
 * 2. RE-RUN DUPLICATION. A backfill is run more than once in practice — it is
 *    the kind of script someone reaches for after a crash. Without a stable
 *    identity per record it silently doubles every data point and halves the
 *    apparent variance.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ComplianceEntry } from "../../lib/compliance-report";
import { planComplianceBackfill, mergeHistory } from "../../lib/compliance-backfill";

let root: string;

/** Write a work dir the way a real ship run leaves one behind. */
function workDir(
  slug: string,
  grades: unknown,
  opts: { issue?: number | string; mtime?: Date; archived?: boolean; raw?: string } = {},
): string {
  const dir = opts.archived ? join(root, ".archive", slug) : join(root, slug);
  mkdirSync(dir, { recursive: true });
  const gradePath = join(dir, "compliance-grade.json");
  writeFileSync(gradePath, opts.raw ?? JSON.stringify({ grades }));
  if (opts.issue !== undefined) {
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({ issue: opts.issue }));
  }
  if (opts.mtime) utimesSync(gradePath, opts.mtime, opts.mtime);
  return gradePath;
}

const grade = (role: string, followed: number, total: number, rules: unknown[] = []) => ({
  role, followed, total, rules, flagged: [],
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "backfill-")); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("reading the grades off disk", () => {
  test("produces one entry per ROLE, not one per run", () => {
    // 57 files but 149 role-records. A per-file backfill would lose 92 of them.
    workDir("ddb-42", [grade("marcus", 10, 14), grade("discovery", 3, 6)], { issue: 42 });

    const plan = planComplianceBackfill(root, []);
    expect(plan.added.map(e => e.role).sort()).toEqual(["discovery", "marcus"]);
  });

  test("scans .archive/ as well as the top level", () => {
    // The archive is a DOT-directory. Both a shell glob and Python's glob skip
    // those by default, and both of us miscounted this directory on the way
    // here — in opposite directions. The scan has to name it explicitly.
    workDir("ddb-1", [grade("marcus", 1, 2)], { issue: 1 });
    workDir("ddb-2", [grade("marcus", 1, 2)], { issue: 2, archived: true });

    const plan = planComplianceBackfill(root, []);
    expect(plan.added.map(e => e.issue).sort()).toEqual(["#1", "#2"]);
  });

  test("computes pct exactly as the live path does, including total=0", () => {
    // Must match scripts/persist-compliance.ts:69. A second rounding rule would
    // put backfilled and live entries on different scales in one trend line,
    // and `0/0` as NaN serialises to `null` and poisons every average
    // downstream of it.
    workDir("a", [grade("marcus", 10, 14)], { issue: 1 });
    workDir("b", [grade("marcus", 0, 0)], { issue: 2 });

    const byIssue = Object.fromEntries(planComplianceBackfill(root, []).added.map(e => [e.issue, e.pct]));
    expect(byIssue["#1"]).toBe(71);
    expect(byIssue["#2"]).toBe(0);
  });

  test("carries the per-rule verdicts into scores", () => {
    workDir("a", [grade("marcus", 1, 2, [
      { id: "COMP-7", rule: "No cat/head via Bash", verdict: "FOLLOWED" },
      { id: "COMP-12", rule: "Grep before Read", verdict: "IGNORED" },
      { rule: "a rule with no id", verdict: "FOLLOWED" },
    ])], { issue: 9 });

    const [entry] = planComplianceBackfill(root, []).added;
    expect(entry.scores).toEqual({ "COMP-7": "FOLLOWED", "COMP-12": "IGNORED" });
  });
});

describe("where the issue number comes from", () => {
  test("workflow-state.json wins over the directory name", () => {
    // They disagree in 5 of 57 real cases. workflow-state.json is what the run
    // itself recorded; the slug is what the harness guessed, and #114 is open
    // precisely because that guess hardcodes a `ddb-` prefix.
    workDir("ddb-999", [grade("marcus", 1, 2)], { issue: 42 });
    expect(planComplianceBackfill(root, []).added[0].issue).toBe("#42");
  });

  test("falls back to the trailing digits of the slug", () => {
    workDir("ddb-77", [grade("marcus", 1, 2)]);
    expect(planComplianceBackfill(root, []).added[0].issue).toBe("#77");
  });

  test("a slug with no number is recorded as unknown, not dropped", () => {
    // Dropping it would silently shrink the dataset the whole exercise exists
    // to recover.
    workDir("pai-harness", [grade("marcus", 1, 2)]);
    expect(planComplianceBackfill(root, []).added[0].issue).toBe("#unknown");
  });

  test("the slug is preserved alongside the issue", () => {
    // #114: runs were filed under a `ddb-` slug regardless of repo, so the slug
    // is evidence of misattribution. Normalising it away during the backfill
    // would destroy the only record of which runs were affected.
    workDir("ddb-588-stale", [grade("marcus", 1, 2)], { issue: 588 });
    const [e] = planComplianceBackfill(root, []).added;
    expect(e.slug).toBe("ddb-588-stale");
    expect(e.issue).toBe("#588");
  });
});

describe("ordering", () => {
  test("entries are timestamped from the grade file, not from now", () => {
    const when = new Date("2026-09-14T08:00:00.000Z");
    workDir("ddb-5", [grade("marcus", 1, 2)], { issue: 5, mtime: when });
    expect(planComplianceBackfill(root, []).added[0].timestamp).toBe(when.toISOString());
  });

  test("mergeHistory interleaves by time instead of appending", () => {
    // The whole point. generateComplianceReport reads the LAST five entries per
    // role as "recent"; appending September data to a file ending in October
    // makes the oldest runs the newest. Mutation check: replacing the sort with
    // `[...existing, ...added]` fails here.
    const at = (t: string, pct: number): ComplianceEntry => ({
      timestamp: t, issue: "#1", role: "marcus", scores: {}, total: 1, followed: 1, pct, flagged: [],
    });
    const existing = [at("2026-09-29T00:00:00.000Z", 58), at("2026-10-05T00:00:00.000Z", 90)];
    const added = [at("2026-09-14T00:00:00.000Z", 10), at("2026-10-01T00:00:00.000Z", 70)];

    expect(mergeHistory(existing, added).map(e => e.pct)).toEqual([10, 58, 70, 90]);
  });

  test("merge keeps the synthetic entries rather than discarding them", () => {
    // They are the only record of what the trend system was reporting before
    // the backfill, and deleting data to make a graph look better is not a
    // backfill.
    const synthetic: ComplianceEntry = {
      timestamp: "2026-09-29T18:30:00Z", issue: "#compliance-test-1", role: "marcus",
      scores: {}, total: 3, followed: 2, pct: 58, flagged: [],
    };
    workDir("ddb-5", [grade("marcus", 1, 2)], { issue: 5, mtime: new Date("2026-10-01T00:00:00.000Z") });

    const merged = mergeHistory([synthetic], planComplianceBackfill(root, [synthetic]).added);
    expect(merged.map(e => e.issue)).toEqual(["#compliance-test-1", "#5"]);
  });
});

describe("running it twice does nothing the second time", () => {
  test("entries already in the history are not added again", () => {
    workDir("ddb-5", [grade("marcus", 1, 2), grade("discovery", 1, 2)], { issue: 5 });

    const first = planComplianceBackfill(root, []);
    expect(first.added).toHaveLength(2);

    const second = planComplianceBackfill(root, mergeHistory([], first.added));
    expect(second.added, "a re-run duplicated every record").toEqual([]);
    expect(second.alreadyPresent).toBe(2);
  });

  test("two roles in one file stay distinct", () => {
    // Keying on the file alone would treat the discovery record as a duplicate
    // of the marcus one and silently drop 58 of 149 rows.
    workDir("ddb-5", [grade("marcus", 1, 2), grade("discovery", 1, 2)], { issue: 5 });
    const added = planComplianceBackfill(root, []).added;
    expect(new Set(added.map(e => e.source)).size).toBe(1);
    expect(added).toHaveLength(2);
  });

  test("the SAME role graded twice in one run stays two records", () => {
    // Found by the conservation check below against real data: 57 usable files
    // hold 91 marcus records, because a run grades a role again after a
    // hill-climb iteration. `source + role` as the identity dropped 35 of 149
    // and every printed count still looked plausible — the planner reported
    // "114 role-records" with nothing to compare it against.
    workDir("ddb-5", [grade("marcus", 1, 4), grade("marcus", 3, 4)], { issue: 5 });

    const added = planComplianceBackfill(root, []).added;
    expect(added, "a repeated grading of one role was swallowed as a duplicate").toHaveLength(2);
    expect(added.map(e => e.ordinal)).toEqual([0, 1]);
    expect(added.map(e => e.pct)).toEqual([25, 75]);

    // ...and the ordinal is stable, so a re-run still adds nothing.
    expect(planComplianceBackfill(root, mergeHistory([], added)).added).toEqual([]);
  });

  test("every grade on disk becomes exactly one record", () => {
    // The conservation law. Without it, any future change to the identity key
    // can drop records silently: the plan's own totals are self-consistent
    // whatever it decides to skip, so the only honest check is against the
    // input.
    workDir("a", [grade("marcus", 1, 2), grade("marcus", 2, 2), grade("discovery", 1, 2)], { issue: 1 });
    workDir("b", [grade("marcus", 1, 2)], { issue: 2, archived: true });
    workDir("empty", []);

    const plan = planComplianceBackfill(root, []);
    expect(plan.added.length + plan.alreadyPresent, "grades on disk were lost between scan and plan").toBe(4);
  });

  test("backfilled entries are marked, live entries are not", () => {
    // Someone reading a declining trend needs to know whether they are looking
    // at a measurement or at a reconstruction.
    workDir("ddb-5", [grade("marcus", 1, 2)], { issue: 5 });
    expect(planComplianceBackfill(root, []).added[0].backfilled).toBe(true);
  });
});

describe("files that cannot be used are reported, never skipped quietly", () => {
  test("unparseable JSON is listed", () => {
    workDir("bad", null, { raw: "{not json" });
    const plan = planComplianceBackfill(root, []);
    expect(plan.added).toEqual([]);
    expect(plan.unparseable).toHaveLength(1);
    expect(plan.unparseable[0]).toContain("bad");
  });

  test("a file with no grades is listed as empty, not as a success", () => {
    // 2 of the 59 real files are in this state. A silent skip would make the
    // run report "57 added" out of 59 with no explanation of the gap — the
    // fail-open shape .claude/rules/checks-must-be-able-to-fail.md describes.
    workDir("empty", []);
    const plan = planComplianceBackfill(root, []);
    expect(plan.added).toEqual([]);
    expect(plan.emptyGrades).toHaveLength(1);
  });

  test("every input file is accounted for in exactly one bucket", () => {
    // The arithmetic IS the check: scanned must equal added-sources + empty +
    // unparseable + alreadyPresent-sources. Without it a future refactor can
    // drop a file on the floor and every number still looks plausible.
    workDir("good", [grade("marcus", 1, 2), grade("discovery", 1, 2)], { issue: 1 });
    workDir("empty", []);
    workDir("bad", null, { raw: "}" });
    workDir("archived", [grade("marcus", 1, 2)], { issue: 2, archived: true });

    const plan = planComplianceBackfill(root, []);
    expect(plan.scanned).toBe(4);
    const usedSources = new Set(plan.added.map(e => e.source)).size;
    expect(usedSources + plan.emptyGrades.length + plan.unparseable.length).toBe(plan.scanned);
  });
});
