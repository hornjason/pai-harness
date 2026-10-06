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
  issues_created?: string;
  issues_closed?: string;
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

  // Find current phase
  const current = state.phases.find(p => p.scs.length > 0 && p.scs.some(sc => !sc.done));
  const openCount = current ? current.scs.filter(sc => !sc.done).length : 0;
  const currentLabel = current ? `${current.name} — ${openCount} SCs open` : "All phases complete";

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
    if (state.session.issues_created) lines.push(`Issues opened: ${state.session.issues_created}`);
    if (state.session.issues_closed) lines.push(`Issues closed: ${state.session.issues_closed}`);
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
    // Newest first. This was `slice(0, 3)`, which rendered the three OLDEST
    // entries — so every session appended to the array was invisible, and
    // PROJECT-STATE.md showed ancient history to the next session while
    // AGENTS.md instructs reading it first as the handoff. The generator
    // printed "✅ Updated" the whole time, because it had in fact rewritten
    // the file; it just never rendered the new rows.
    for (const session of [...state.sessions].reverse().slice(0, 3)) {
      lines.push(`**Session ${session.date}:**`);
      session.items.forEach(item => lines.push(`- ${item}`));
      lines.push("");
    }
  }

  return lines.join("\n");
}

// --- Main ---
if (!existsSync(STATE_JSON)) {
  console.log("project-state.json not found, skipping");
  process.exit(0);
}

const state: ProjectState = JSON.parse(readFileSync(STATE_JSON, "utf-8"));
state.updated = new Date().toISOString().split("T")[0];

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

writeFileSync(STATE_JSON, JSON.stringify(state, null, 2) + "\n");
writeFileSync(STATE_MD, render(state) + "\n");
console.log(`✅ Updated PROJECT-STATE.md (${state.phases.reduce((n, p) => n + p.scs.filter(s => s.done).length, 0)}/${state.phases.reduce((n, p) => n + p.scs.length, 0)} SCs done)`);
