#!/usr/bin/env bun
/**
 * Render PROJECT-STATE.md from project-state.json (one-way, never parses markdown).
 *
 * Usage:
 *   bun scripts/update-project-state.ts              # Sync SC status from specs + render
 *   bun scripts/update-project-state.ts --skip-tests # Same but skip test count update
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/** How many sessions the handoff shows. One site, so the count can be mutated. */
const RENDERED_SESSIONS = 3;
import { missingStateVerdict, projectStateViolations, selectRecentSessions } from "../lib/project-state-shape";
import { localCalendarDay } from "../lib/local-calendar-day";

/**
 * The one exit code every refusal here routes through, per
 * `.claude/rules/checks-must-be-able-to-fail.md`. Declared once so a test can
 * build a mutant with it set to 0 and watch the refusals stop refusing.
 */
export const PROJECT_STATE_REFUSE_EXIT = 1;

const ROOT = join(import.meta.dir, "..");
const STATE_JSON = join(ROOT, "project-state.json");
const STATE_MD = join(ROOT, "PROJECT-STATE.md");
const SPECS_DIR = join(ROOT, "specs");

interface SC { id: string; what: string; done: boolean }
/** `note` is written for every phase in project-state.json and read by phaseEmoji. */
interface Phase { name: string; scs: SC[]; note?: string }
interface Session { date: string; items: string[] }
interface CurrentSession {
  number: number;
  date: string;
  summary: string;
  suite: string;
  // The DA has always written these as arrays of issue numbers. They were
  // declared `string`, and `render` interpolated them, so the document
  // carried `1675,1676` through Array.prototype.toString where every other
  // issue reference in it reads `#1675`.
  //
  // ARRAY ONLY, and that is the narrower choice on purpose. A `| string`
  // union would oblige this file to split a comma-separated value, and
  // `parseDeclaredCloses` in `scripts/check-state-record-closes.ts` already
  // splits this exact field — two deciders for one question, each invisible
  // to any behavioural test of the other. `projectStateViolations` refuses
  // the string shape by name before the renderer sees it, so there is one
  // shape here and a clear message for every other.
  issues_created?: readonly (number | string)[];
  issues_closed?: readonly (number | string)[];
}

/**
 * An issue list as issue REFERENCES, or nothing at all.
 *
 * Returning `null` for an empty list is the point. `[]` is truthy, so a
 * session that closed nothing used to render the label `Issues closed:`
 * with nothing after it — byte-identical to a session that never recorded
 * the field. Two different facts, one rendering: *Silent Default
 * Substitution* (`.claude/rules/config-access.md`), in the document every
 * session is told to read first.
 */
function issueList(v: CurrentSession["issues_created"]): string | null {
  if (v === undefined) return null;
  const items = v.map(String).filter(s => s.trim() !== "");
  if (items.length === 0) return null;
  return items.map(s => (s.startsWith("#") ? s : `#${s}`)).join(", ");
}

interface ProjectState {
  updated: string;
  priorities: string[];
  notes?: string;
  phases: Phase[];
  sessions: Session[];
  /** Written every session; was never declared here and never rendered. */
  session?: CurrentSession;
}

function scanSpecSCStatus(): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  if (!existsSync(SPECS_DIR)) return status;
  for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: SPECS_DIR, absolute: true })) {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const done = line.match(/^- \[x\] (SC-\d+):/i);
      if (done) { status[done[1].toUpperCase()] = true; continue; }
      const open = line.match(/^- \[ \] (SC-\d+):/i);
      if (open) status[open[1].toUpperCase()] = false;
    }
  }
  return status;
}

function phaseEmoji(phase: Phase): string {
  if (phase.scs.length === 0) {
    return phase.note?.toLowerCase().includes("complete") ? "✅" : "⬜";
  }
  const done = phase.scs.filter(sc => sc.done).length;
  if (done === phase.scs.length) return "✅";
  if (done > 0) return "🔄";
  return "⬜";
}

function phaseStatus(phase: Phase): string {
  const e = phaseEmoji(phase);
  if (e === "✅") return "COMPLETE";
  if (e === "🔄") return "IN PROGRESS";
  return "NOT STARTED";
}

function render(state: ProjectState): string {
  const lines: string[] = [];

  // The current phase is the first one `phaseEmoji` does not call complete.
  //
  // It used to be the first phase with an OPEN SC, which is a second notion
  // of "complete" answering the same question as `phaseEmoji` — and a phase
  // carrying no SCs at all, the shape every planning phase has before its
  // criteria are bound, is invisible to it. So the document opened with
  // "All phases complete" above a section reading "NOT STARTED" whose own
  // note said 30 engineering items remained. One decider now, and the label
  // falls back to the phase's status word when there are no SCs to count,
  // because "0 SCs open" is exactly as misleading.
  const current = state.phases.find(p => phaseEmoji(p) !== "✅");
  const currentLabel = !current
    ? "All phases complete"
    : current.scs.length > 0
      ? `${current.name} — ${current.scs.filter(sc => !sc.done).length} SCs open`
      : `${current.name} — ${phaseStatus(current)}`;

  lines.push("# Project State");
  lines.push("");
  lines.push(`**Current phase: ${currentLabel}**`);

  // `session` was written into project-state.json every session and rendered
  // nowhere, so the suite number and session count a reader needs first were
  // dead data in the file.
  if (state.session) {
    lines.push("");
    lines.push(`**Session ${state.session.number} (${state.session.date})** — ${state.session.summary}`);
    lines.push("");
    lines.push(`Suite: ${state.session.suite}`);
    // `!== null`, NOT truthiness. A truthy test re-decides "is there
    // anything to show" here, which `issueList` has already decided, and two
    // deciders agreeing means no case can tell them apart: with the empty
    // guard removed, `issueList` returns `""` and the falsy test suppresses
    // the line anyway, so the suppression reads as covered while the only
    // thing holding it up is this line. Measured — a mutant that deleted the
    // guard left the suite green.
    const opened = issueList(state.session.issues_created);
    const closed = issueList(state.session.issues_closed);
    if (opened !== null) lines.push(`Issues opened: ${opened}`);
    if (closed !== null) lines.push(`Issues closed: ${closed}`);
  }

  if (state.notes) lines.push(`\n${state.notes}`);
  lines.push("");

  // Priorities
  if (state.priorities.length > 0) {
    lines.push("**Next priorities:**");
    state.priorities.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
  }

  // Phases
  for (const phase of state.phases) {
    const emoji = phaseEmoji(phase);
    lines.push(`## ${emoji} ${phase.name} (${phaseStatus(phase)})`);
    lines.push("");
    if (phase.scs.length > 0) {
      lines.push("| Status | SC | What |");
      lines.push("|---|---|---|");
      for (const sc of phase.scs) {
        lines.push(`| ${sc.done ? "✅" : "⬜"} | ${sc.id} | ${sc.what} |`);
      }
      lines.push("");
    }
  }

  // Sessions
  if (state.sessions.length > 0) {
    lines.push("---");
    lines.push("");
    // By DATE, not by position in the array (#572). Twice now this has been
    // a positional guess: `slice(0, 3)` rendered the three OLDEST entries,
    // and `.reverse().slice(0, 3)` rendered the last three of the array —
    // correct only while the array is in append order, which nothing
    // enforces. Session 48 was written to `sessions[0]` and eight merged
    // issues never reached this file, while the script reported success on
    // every run because it had in fact rewritten it.
    for (const session of selectRecentSessions(state.sessions, RENDERED_SESSIONS).rendered) {
      lines.push(`**Session ${session.date}:**`);
      session.items.forEach(item => lines.push(`- ${item}`));
      lines.push("");
    }
  }

  return lines.join("\n");
}

// --- Main ---
const missing = missingStateVerdict({
  jsonExists: existsSync(STATE_JSON),
  markdownExists: existsSync(STATE_MD),
});
if (missing.verdict === "SKIP") {
  console.log(`project-state: ${missing.detail}`);
  process.exit(0);
}
if (missing.verdict === "REFUSE") {
  console.error(`project-state: ${missing.detail}`);
  process.exit(PROJECT_STATE_REFUSE_EXIT);
}

/**
 * The interfaces above are erased at runtime, so the parse below believes
 * whatever is in the file. An archived session carrying `summary` instead of
 * `items` used to reach the renderer and die with
 * `TypeError: undefined is not an object (evaluating 'session.items.forEach')`
 * and a line number into this script — from a pre-commit hook, to a committer
 * who did not open it. Checked here instead, with every problem named at
 * once and the path into the document said out loud.
 */
let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
} catch (e) {
  console.error(`project-state: ${STATE_JSON} is not valid JSON — ${(e as Error).message}`);
  process.exit(PROJECT_STATE_REFUSE_EXIT);
}

const shapeProblems = projectStateViolations(parsed);
if (shapeProblems.length > 0) {
  console.error(`project-state: ${STATE_JSON} does not have the shape the renderer reads:`);
  for (const p of shapeProblems) console.error(`  - ${p}`);
  console.error(`project-state: nothing was written. Fix the entries above and re-run.`);
  process.exit(PROJECT_STATE_REFUSE_EXIT);
}

const state: ProjectState = parsed as ProjectState;
// #600. This was the UTC calendar day, so an evening EDT session stamped
// tomorrow — and the hook that reads this field back only staged a diff on
// the hours when the two disagreed, which is what made #599 intermittent.
state.updated = localCalendarDay();

// Sync SC status from spec files (promote-only: specs can mark done, never undo)
const specStatus = scanSpecSCStatus();
for (const phase of state.phases) {
  for (const sc of phase.scs) {
    const key = sc.id.toUpperCase();
    if (specStatus[key] === true) sc.done = true;
  }
}

// Update SC count in notes field
const done = state.phases.reduce((n, p) => n + p.scs.filter(s => s.done).length, 0);
const total = state.phases.reduce((n, p) => n + p.scs.length, 0);
const scCountPattern = /\d+\/\d+ SCs done/;
if (state.notes && scCountPattern.test(state.notes)) {
  state.notes = state.notes.replace(scCountPattern, `${done}/${total} SCs done`);
} else {
  const suffix = `Suite: ${done}/${total} SCs done.`;
  state.notes = state.notes ? `${state.notes}\n${suffix}` : suffix;
}

/**
 * Report what actually changed, not that the script ran.
 *
 * This printed `✅ Updated PROJECT-STATE.md (25/25 SCs done)` on every commit
 * unconditionally — the pre-commit hook calls it every time. It only ever
 * RE-RENDERS the markdown from `project-state.json`; nothing here writes new
 * session content, which is the DA's job. So across eight commits on
 * 2026-10-12 it reported success eight times while the latest recorded
 * session stayed at 38, dated the previous day. A green line for work that
 * was never done, in the file whose entire purpose is telling a human where
 * the project is.
 *
 * The SC count was the same shape: `25/25` comes from Phase 0+1, which has
 * been complete for weeks, and has nothing to do with the work being
 * committed. A number that cannot move is not a status.
 */
const jsonBefore = existsSync(STATE_JSON) ? readFileSync(STATE_JSON, "utf-8") : "";
const mdBefore = existsSync(STATE_MD) ? readFileSync(STATE_MD, "utf-8") : "";
const jsonAfter = JSON.stringify(state, null, 2) + "\n";
const mdAfter = render(state) + "\n";

writeFileSync(STATE_JSON, jsonAfter);
writeFileSync(STATE_MD, mdAfter);

const changed = [
  jsonBefore !== jsonAfter ? "project-state.json" : null,
  mdBefore !== mdAfter ? "PROJECT-STATE.md" : null,
].filter(Boolean);

/**
 * What the run RENDERED, not that it ran.
 *
 * "rewrote PROJECT-STATE.md" was true on every one of the runs that
 * dropped session 48, so the summary has to name the sessions that reached
 * the file. A reader who sees yesterday's date at the top of this line
 * knows immediately; a reader who sees "rewrote" learns nothing.
 */
const selection = selectRecentSessions(state.sessions, RENDERED_SESSIONS);
const latest = state.session?.date ?? "(none recorded)";
if (changed.length === 0) {
  console.log(`project-state: unchanged — latest recorded session is ${latest}. ` +
    `This script re-renders; it does not write session content.`);
} else {
  console.log(`✅ project-state: rewrote ${changed.join(" + ")} — latest recorded session ${latest} (${done}/${total} Phase 0+1 SCs)`);
}
console.log(
  `project-state: rendered ${selection.rendered.length} of ${state.sessions.length} session(s) — ` +
    `${selection.rendered.map(s => s.date.split(" ")[0]).join(", ") || "none"}`,
);
if (selection.undated.length > 0) {
  // UNMEASURED, by name. An entry with no readable date ranks below every
  // dated one however old, which is surprising if you cannot see it — and
  // silence here is indistinguishable from an entry that is merely old.
  console.warn(
    `project-state: ${selection.undated.length} session entr(ies) have no ISO date, so they rank below every dated one:`,
  );
  for (const u of selection.undated) console.warn(`  - ${JSON.stringify(u.date)}`);
}
