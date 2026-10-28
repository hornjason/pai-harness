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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isIsoDay, parseCriteria } from "../lib/spec-evidence";
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
  /**
   * Why a waiver on this row does not settle it, or `null`.
   *
   * Reported rather than silently swallowed: a row that falls out of WAIVED
   * looks identical to one that never had a waiver, and those are different
   * facts. The script prints these by name.
   */
  waiverProblem: string | null;
}

export interface Snapshot {
  issues: Tracked[];
  prs: Tracked[];
  /** PR number → whether that PR changed code. Absent = unclassified. */
  prChangedCode: Record<number, boolean>;
}

/**
 * Why a waiver does not settle this criterion — or `null` if it does.
 *
 * Three ways a waiver fails to settle anything, all raised by the required
 * reviewer on #1642 and all of them states `lib/spec-evidence.ts` already
 * treats as violations:
 *
 * - **It sits on an unticked box.** `parseCriteria` records a waiver whenever
 *   any `waived-*` field appears, ticked or not, deliberately — *"a
 *   half-written waiver on an unticked criterion is still a waiver nobody can
 *   act on"*. Reading that as a settled state is the opposite of what the
 *   annotation means.
 * - **It is incomplete.** All three of reason, signer and expiry must carry
 *   content, or `evidenceViolations` refuses it.
 * - **It has expired.** `lib/spec-evidence.ts`: a waiver past its date is *"a
 *   violation again"*. An expired excuse reading as a settled state is the
 *   single most flattering way this report could be wrong.
 *
 * `today` is passed in rather than read, so the expiry boundary is testable
 * and so this function has no clock of its own.
 */
export function waiverProblem(
  row: Pick<InventoryRow, "ticked">,
  waiver: { reason: string; by: string; until: string } | null,
  today: string,
): string | null {
  if (!waiver) return null;
  if (!row.ticked) return "a waiver on an unticked criterion settles nothing";
  const missing = (["reason", "by", "until"] as const).filter(k => waiver[k].trim() === "");
  if (missing.length > 0) return `the waiver is missing: ${missing.join(", ")}`;
  if (!isIsoDay(waiver.until)) return `\`waived-until: ${waiver.until}\` is not a real day`;
  if (waiver.until < today) return `the waiver expired on ${waiver.until}`;
  return null;
}

export function classify(
  row: Omit<InventoryRow, "state">,
  prChangedCode: Record<number, boolean>,
): State {
  // A waiver settles the row only when nothing is wrong with it. Otherwise it
  // falls through the ladder on its other evidence, and `waiverProblem` says
  // why — an expired or misplaced waiver must never read as settled.
  if (row.waived && row.waiverProblem === null) return "WAIVED";
  // DONE requires the proof, not just the tick. A ticked criterion whose
  // waiver has expired would otherwise land in DONE — a worse reading than
  // the one the expiry check was added to prevent. A tick with neither proof
  // nor a standing waiver falls through on its other evidence, and the script
  // names it as a false tick rather than letting it pass as finished.
  if (row.ticked && (row.provedBy ?? "").trim() !== "") return "DONE";
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
  today: string,
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
      waiverProblem: waiverProblem({ ticked: c.ticked }, c.waiver, today),
    };
    return { ...partial, state: classify(partial, snapshot.prChangedCode) };
  });
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

const HEADING: Record<State, string> = {
  DONE: "DONE — ticked, and it names what proved it",
  WAIVED: "WAIVED — ticked against a signed, unexpired excuse",
  BOUND: "BOUND — a test names it, and the box is not ticked",
  TOUCHED: "TOUCHED — a pull request that changed code names it; no test does",
  "DOCUMENT ONLY": "DOCUMENT ONLY — the spec and the tracker discuss it; nothing has been built",
  "NOT STARTED": "NOT STARTED — nothing anywhere names it",
};

/** First sentence only. Three criteria in this spec carry a page of reasoning. */
function gist(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.match(/^.{0,170}?[.?!](?=\s|$)/);
  const short = cut ? cut[0] : flat.slice(0, 170);
  return (short.length < flat.length ? `${short} …` : short).replace(/\|/g, "\\|");
}

export function renderMarkdown(
  rows: readonly InventoryRow[],
  snapshot: Snapshot,
  unclassified: readonly number[],
  today: string,
): string {
  const prs = (ns: readonly number[]): string => {
    if (ns.length === 0) return "—";
    const desc = [...ns].sort((a, b) => b - a);
    const shown = desc
      .slice(0, 4)
      .map(n => (snapshot.prChangedCode[n] === false ? `#${n}*` : `#${n}`))
      .join(" ");
    return desc.length > 4 ? `${shown} (+${desc.length - 4})` : shown;
  };
  const issues = (r: InventoryRow): string => {
    if (r.openIssues.length === 0 && r.closedIssues.length === 0) return "—";
    const open = [...r.openIssues].sort((a, b) => b - a).map(n => `**#${n}**`);
    const closed = [...r.closedIssues].sort((a, b) => b - a).slice(0, 3).map(n => `#${n}`);
    const more = r.closedIssues.length > 3 ? ` (+${r.closedIssues.length - 3} closed)` : "";
    return [...open, ...closed].join(" ") + more;
  };
  const evidence = (r: InventoryRow): string => {
    if (r.state === "DONE") return `\`${(r.provedBy ?? "").replace(/\s+/g, " ").trim()}\``;
    if (r.state === "WAIVED") return "a waiver that still stands";
    if (r.tests.length > 0) return r.tests.map(t => `\`${t.replace(".test.ts", "")}\``).join(" ");
    return "—";
  };

  const n = rows.length;
  const count = (s: State) => rows.filter(r => r.state === s).length;
  const out: string[] = [
    "---",
    "doc-type: research",
    "status: active",
    "owner: jason",
    `updated: ${today}`,
    "governs: Increment 1 of the code-review convergence work — which criteria have been started, by which pull request, against which issue",
    "---",
    "",
    "# Increment 1 — what has actually been built, criterion by criterion",
    "",
    "**Generated. Do not hand-edit** — `bun scripts/criterion-inventory.ts --snapshot <dir> --markdown`.",
    "That script's header states the commands that take a snapshot.",
    "",
    `Every criterion in \`specs/CODE-REVIEW-CONVERGENCE-SPEC.md\`, with the issues and the pull`,
    "requests that name it. This is the baseline for a board: one row is one card, and the state",
    "is the column it starts in.",
    "",
    "## The headline",
    "",
    `${count("DONE") + count("WAIVED")} of ${n} are ticked, and ${count("WAIVED")} of those are ticked against a waiver rather than a`,
    `proof. ${count("BOUND")} more have a test naming them and no tick. The remaining ${count("TOUCHED") + count("DOCUMENT ONLY") + count("NOT STARTED")} divide into`,
    "work that touched code, work that exists only as writing, and work nobody has started — and",
    "before this inventory all of them looked identical, because a checkbox has two states.",
    "",
    "## How the state was derived",
    "",
    "Mechanical, from the spec and the tracker only. No judgement is recorded here.",
    "",
    "| State | Rule |",
    "|---|---|",
    "| DONE | ticked, **and** carrying a `proved-by:` naming what ran |",
    "| WAIVED | ticked, with a complete, signed, unexpired waiver |",
    "| BOUND | not ticked, and a file in `test/` names the id |",
    "| TOUCHED | not ticked, no test names it, and a merged pull request that changed code names it |",
    "| DOCUMENT ONLY | not ticked, and every pull request naming it changed only prose |",
    "| NOT STARTED | not ticked, and nothing in the tracker or `test/` names the id |",
    "",
    "A pull request counts as *changing code* when it touched any of " +
      CODE_DIRS.map(d => `\`${d}/\``).join(", ") +
      ". Pull requests marked `*` changed prose only.",
    "",
    "A tick alone never reaches DONE, and an expired or misplaced waiver never reaches WAIVED —",
    "both fall through onto whatever other evidence exists, and the script names them.",
    "",
    "## What this cannot tell you",
    "",
    "Every column is a word-boundary name match, so a pull request naming an id may have *touched*",
    "the criterion rather than satisfied it, and a test naming an id may be citing it in a comment",
    "rather than claiming it. TOUCHED means *somebody has been here*, never *this is nearly done*.",
    "",
    "**The state cannot say how far along something is.** A criterion is a checkbox: done, or not",
    "done. Splitting a broad criterion into narrow ones that can each be proved is a change to the",
    "spec, and it is the main thing this inventory argues for.",
    "",
    `Taken ${today} over ${snapshot.issues.length} issues and ${snapshot.prs.length} pull requests.`,
    unclassified.length === 0
      ? "Every merged pull request named below has a changed-file reading, so the split between" +
        " TOUCHED and DOCUMENT ONLY is complete rather than a lower bound."
      : `${unclassified.length} merged pull request(s) have no changed-file reading, so TOUCHED is a lower bound.`,
    "**Open issues are bold.** Long criteria are cut to their first sentence.",
    "",
  ];
  for (const state of STATES) {
    const group = rows.filter(r => r.state === state);
    out.push(`## ${HEADING[state]} — ${group.length} of ${n}`, "");
    out.push("| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |");
    out.push("|---|---|---|---|---|---|");
    for (const r of group) {
      out.push(
        `| **${r.id}** | ${gist(r.text)} | ${r.needs} | ${evidence(r)} | ${issues(r)} | ${prs(r.mergedPrs)} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Every `*.test.ts` under `test/`, at any depth, except fixtures.
 *
 * The first draft used a flat `readdirSync`, which silently skipped the 70
 * test files in `test/unit/`, `test/helpers/` and `test/types/` — a directory
 * entry named `unit` does not end in `.test.ts`, so it was filtered out rather
 * than descended into, and the criteria those files bind read as unbound.
 * Raised by the required reviewer on #1642.
 *
 * `test/fixtures/` is excluded on purpose and not by accident of the glob: a
 * fixture plants criterion ids deliberately, so counting one as a binding
 * would report a criterion as BOUND on the strength of a test's own scratch
 * input.
 */
export function collectTestFiles(testDir: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name);
      const relNext = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "fixtures") continue;
        walk(next, relNext);
      } else if (entry.name.endsWith(".test.ts")) {
        out.push({ file: relNext, content: readFileSync(next, "utf-8") });
      }
    }
  };
  walk(testDir, "");
  return out;
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
  const testFiles = collectTestFiles(join(root, "test"));
  if (testFiles.length === 0) {
    console.error(`UNMEASURED: no test files under ${join(root, "test")}. Every criterion would read as unbound.`);
    return EXIT_REFUSED;
  }
  const today = localCalendarDay();
  const rows = inventory(readFileSync(specPath, "utf-8"), snapshot, testFiles, today);

  const unclassified = [
    ...new Set(rows.flatMap(r => r.mergedPrs).filter(n => snapshot.prChangedCode[n] === undefined)),
  ].sort((a, b) => a - b);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ taken: today, rows, unclassified }, null, 2));
    return 0;
  }

  if (argv.includes("--markdown")) {
    // `docs/research/increment-1-criterion-inventory.md` is written by this
    // branch and by nothing else. An earlier draft rendered it from a
    // throwaway script in a scratch directory, which made the committed
    // document a reading nobody could retake — the exact defect the document
    // is about.
    console.log(renderMarkdown(rows, snapshot, unclassified, today));
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
  const falseTicks = rows.filter(r => r.ticked && r.state !== "DONE" && r.state !== "WAIVED");
  if (falseTicks.length > 0) {
    console.log(`FALSE TICKS: ${falseTicks.length} criterion(s) are ticked with neither a \`proved-by:\` nor a standing waiver:`);
    for (const r of falseTicks) {
      console.log(`  ${r.id} — ${r.waiverProblem ?? "no proof recorded"} (reported as ${r.state})`);
    }
    console.log();
  }
  const waiverProblems = rows.filter(r => r.waiverProblem !== null && !falseTicks.includes(r));
  if (waiverProblems.length > 0) {
    console.log("WAIVERS THAT SETTLE NOTHING:");
    for (const r of waiverProblems) console.log(`  ${r.id} — ${r.waiverProblem}`);
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
