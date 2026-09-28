#!/usr/bin/env bun
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { type GateResult } from "./orchestrator";
import { executeGate, type GateExecutorInput, type GateExecutorResult } from "./gate-executor";

// ── Gate contract interfaces (SC-373) ─────────────────────────────────────

export interface RunGateInput {
  gate: string;
  slug: string;
  issue: number;
}

export type ParseTestOutput = GateResult[];

if (!import.meta.main) {
  // Imported as module — skip main execution
} else {

const args = process.argv.slice(2);
let gate = "";
let slug = "";
let issue = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--gate" && args[i + 1]) gate = args[++i];
  if (args[i] === "--slug" && args[i + 1]) slug = args[++i];
  if (args[i] === "--issue" && args[i + 1]) issue = parseInt(args[++i]);
}

if (!gate || !["scope", "verify", "ship", "merge", "prove"].includes(gate)) {
  console.error("Usage: bun run gates/run-gate.ts --gate scope|verify|ship|merge|prove --slug SLUG [--issue NUM]");
  process.exit(1);
}

const WORK_DIR = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug);
const SF = join(WORK_DIR, "workflow-state.json");

if (!existsSync(SF)) {
  console.error(`BLOCKED — ${SF} not found`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(SF, "utf-8"));
if (!issue) issue = state.issue || 0;
if (!slug) slug = state.slug || "";

// Gate idempotency guard
if (!process.argv.includes("--force") && state.gates?.[gate]?.result === "PASS") {
  console.log(`Gate ${gate}: already PASSED (attempt ${state.gates[gate].attempt}). Use --force to re-run.`);
  console.log(`\n${gate} GATE: PASS (cached)`);
  process.exit(0);
}

// Delegate to gate executor
const result = executeGate({ gate, slug, issue, workDir: WORK_DIR, stateFilePath: SF });

process.exit(result.exitCode);
} // end if (import.meta.main)
