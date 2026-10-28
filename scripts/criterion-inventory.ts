#!/usr/bin/env bun
/**
 * The criterion inventory: for every criterion in one spec, what state it is
 * in and who has been near it.
 *
 *   bun scripts/criterion-inventory.ts --snapshot <dir> [--spec <path>] [--json]
 *
 * ## Why this takes a snapshot directory instead of fetching
 *
 * The three readings it needs are a full issue list, a full pull-request list,
 * and the changed files of every pull request that names a criterion. The
 * third is one API call per pull request — sixty-two of them on the first run
 * — so a tool that fetched on every invocation would be slow enough that
 * nobody re-ran it, and a number nobody re-runs is the defect
 * `.claude/rules/checks-must-be-able-to-fail.md` is about.
 *
 * So the fetch is a separate, explicit step and the snapshot is an input you
 * can point at, date, and keep. Take one with:
 *
 *   mkdir -p <dir>
 *   gh issue list --state all --limit 3000 \
 *     --json number,title,body,state > <dir>/issues.json
 *   gh pr list --state all --limit 3000 \
 *     --json number,title,body,state,mergedAt > <dir>/prs.json
 *   # then, for each number this script reports as UNCLASSIFIED:
 *   gh pr view <n> --json number,files \
 *     -q '{number:.number,files:[.files[].path]}' -c >> <dir>/pr-files.jsonl
 *
 * A snapshot missing any of the three is a **refusal**, not a partial
 * reading: a pull-request list that silently came back empty would report
 * every criterion as NOT STARTED, which is the one direction that reads as
 * good news.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseCriteria } from "../lib/spec-evidence";
import { oneScMentionPattern } from "../lib/sc-ids";
import { localCalendarDay } from "../lib/local-calendar-day";

/** Every refusal exits through this, so a test can mutate one site. */
export const EXIT_REFUSED = 1;

export const STATES = [
  "DONE",
  "WAIVED",
  "BOUND",
  "TOUCHED",
  "DOCUMENT ONLY",
  "NOT STARTED",
] as const;
export type State = (typeof STATES)[number];

/**
 * A pull request counts as having changed code when it touched one of these.
 * Everything else — `specs/`, `docs/`, `reference/`, a README — is writing
 * about the criterion rather than building it, and the distinction is the
 * whole reason TOUCHED and DOCUMENT ONLY are different columns: six of the
 * most-cited pull requests in this repository are spec revisions that name
 * every id in the document by construction.
 */
export const CODE_DIRS = [
  "lib",
  "test",
  "scripts",
  "gates",
  "hooks",
  "bin",
  "workflows",
  "config",
  "evals",
  "prompts",
  ".github",
] as const;

export function changedCode(files: readonly string[]): boolean {
  return files.some(f => CODE_DIRS.some(d => f.startsWith(`${d}/`)));
}

export interface Tracked {
  number: number;
  title: string;
  body: string | null;
  state: string;
  mergedAt?: string | null;
}

export interface InventoryRow {
  id: string;
  ticked: boolean;
  waived: boolean;
  needs: string | null;
  provedBy: string | null;
  text: string;
  openIssues: number[];
  closedIssues: number[];
  mergedPrs: number[];
  tests: string[];
  state: State;
}

export interface Snapshot {
  issues: Tracked[];
  prs: Tracked[];
  /** PR number → whether that PR changed code. Absent = unclassified. */
  prChangedCode: Record<number, boolean>;
}

export function classify(
  row: Omit<InventoryRow, "state">,
  prChangedCode: Record<number, boolean>,
): State {
  if (row.waived) return "WAIVED";
  if (row.ticked) return "DONE";
  if (row.tests.length > 0) return "BOUND";
  if (row.mergedPrs.some(n => prChangedCode[n] === true)) return "TOUCHED";
  if (row.mergedPrs.length > 0 || row.openIssues.length > 0 || row.closedIssues.length > 0) {
    return "DOCUMENT ONLY";
  }
  return "NOT STARTED";
}

export function inventory(
  specText: string,
  snapshot: Snapshot,
  testFiles: readonly { file: string; content: string }[],
): InventoryRow[] {
  return parseCriteria(specText).map(c => {
    const names = oneScMentionPattern(c.id);
    const hits = (xs: readonly Tracked[]) =>
      xs.filter(x => names.test(x.title) || names.test(x.body ?? ""));
    const issues = hits(snapshot.issues);
    const prs = hits(snapshot.prs);
    const partial: Omit<InventoryRow, "state"> = {
      id: c.id,
      ticked: c.ticked,
      waived: Boolean(c.waiver),
      needs: c.needs,
      provedBy: c.provedBy,
      text: c.text,
      openIssues: issues.filter(i => i.state === "OPEN").map(i => i.number),
      closedIssues: issues.filter(i => i.state !== "OPEN").map(i => i.number),
      mergedPrs: prs.filter(p => p.mergedAt).map(p => p.number),
      tests: testFiles.filter(t => names.test(t.content)).map(t => t.file),
    };
    return { ...partial, state: classify(partial, snapshot.prChangedCode) };
  });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function readSnapshot(dir: string): Snapshot {
  const need = (name: string): string => {
    const path = join(dir, name);
    if (!existsSync(path)) {
      throw new Error(
        `UNMEASURED: ${path} is absent. A snapshot missing one of its three readings ` +
          `reports criteria as NOT STARTED that the tracker names — see this file's header ` +
          `for the commands that take one.`,
      );
    }
    return readFileSync(path, "utf-8");
  };
  const issues: Tracked[] = JSON.parse(need("issues.json"));
  const prs: Tracked[] = JSON.parse(need("prs.json"));
  if (issues.length === 0 || prs.length === 0) {
    throw new Error(
      `UNMEASURED: the snapshot holds ${issues.length} issue(s) and ${prs.length} pull ` +
        `request(s). An empty reading is a failed fetch, not an empty tracker.`,
    );
  }
  const prChangedCode: Record<number, boolean> = {};
  for (const line of need("pr-files.jsonl").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as { number: number; files: string[] };
    prChangedCode[parsed.number] = changedCode(parsed.files);
  }
  return { issues, prs, prChangedCode };
}

function main(): number {
  const argv = process.argv.slice(2);
  const dir = flag(argv, "--snapshot");
  if (!dir) {
    console.error("usage: bun scripts/criterion-inventory.ts --snapshot <dir> [--spec <path>]");
    return EXIT_REFUSED;
  }
  const root = join(import.meta.dir, "..");
  const specPath = flag(argv, "--spec") ?? join(root, "specs/CODE-REVIEW-CONVERGENCE-SPEC.md");

  const snapshot = readSnapshot(dir);
  const testDir = join(root, "test");
  const testFiles = require("node:fs")
    .readdirSync(testDir)
    .filter((f: string) => f.endsWith(".test.ts"))
    .map((f: string) => ({ file: f, content: readFileSync(join(testDir, f), "utf-8") }));

  const rows = inventory(readFileSync(specPath, "utf-8"), snapshot, testFiles);

  const unclassified = [
    ...new Set(rows.flatMap(r => r.mergedPrs).filter(n => snapshot.prChangedCode[n] === undefined)),
  ].sort((a, b) => a - b);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ taken: localCalendarDay(), rows, unclassified }, null, 2));
    return 0;
  }

  console.log(`criterion inventory — ${specPath.split("/").pop()}, ${localCalendarDay()}`);
  console.log(`  ${rows.length} criteria, ${snapshot.issues.length} issues, ${snapshot.prs.length} PRs read\n`);
  for (const state of STATES) {
    const group = rows.filter(r => r.state === state);
    console.log(`${state} — ${group.length} of ${rows.length}`);
    for (const r of group) {
      const bits = [
        r.tests.length > 0 ? `tests: ${r.tests.join(" ")}` : "",
        r.openIssues.length > 0 ? `open issues: ${r.openIssues.map(n => `#${n}`).join(" ")}` : "",
        r.mergedPrs.length > 0 ? `PRs: ${r.mergedPrs.map(n => `#${n}`).join(" ")}` : "",
      ].filter(Boolean);
      console.log(`  ${r.id.padEnd(9)} ${bits.join("  |  ") || "nothing names it"}`);
    }
    console.log();
  }
  if (unclassified.length > 0) {
    console.log(
      `UNCLASSIFIED: ${unclassified.length} merged PR(s) have no changed-file reading, so ` +
        `TOUCHED is a lower bound. Fetch them:\n  ${unclassified.map(n => `#${n}`).join(" ")}`,
    );
  }
  return 0;
}

if (import.meta.main) process.exit(main());
