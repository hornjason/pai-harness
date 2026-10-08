#!/usr/bin/env bun
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { type GateResult } from "./orchestrator";
import { executeGate, parseTestResults, type GateExecutorInput, type GateExecutorResult } from "./gate-executor";
import { harnessRootFor } from "../lib/paths";

export { parseTestResults };

/**
 * The tree the gate runs its own subprocesses in, resolved ONCE per run (#190).
 *
 * `gates/gate-executor.ts` used to call `harnessRoot()` at each of seven `cwd:`
 * sites, so the tree a gate EXECUTED in was decided seven times over, by the
 * environment and by wherever `lib/paths.ts` had been loaded from — never by
 * the run. One of those subprocesses is `bun scripts/sync-spec-tests.ts`, which
 * WRITES, so a misresolved root did not merely read the wrong tree, it edited
 * it. The executor now receives a root and resolves none.
 *
 * Resolution order, and why:
 *
 *   1. `HARNESS_ROOT` when the caller set it. This is the override CI and the
 *      ship workflow use to name a tree on purpose, and it is the mitigation
 *      in use today; it has to keep winning.
 *   2. Otherwise the checkout THIS FILE lives in. Not the main repository —
 *      `git rev-parse --git-common-dir` hands back the main checkout from
 *      inside a linked worktree, which is the opposite of what a gate needs.
 *      The files a worktree run is grading are the worktree's, so that is
 *      where its subprocesses belong.
 *
 * `harnessRootFor` rather than a bare string: it refuses an empty root instead
 * of resolving one. `HARNESS_ROOT=` — an unset shell variable interpolated into
 * a command — used to fall through `process.env.HARNESS_ROOT || <fallback>`
 * silently and run the gate somewhere nobody chose. A run with no root is now a
 * refusal, which is a thing you can see.
 *
 * `env` is a parameter so the refusal can be exercised without mutating the
 * process; test/gate-root-threading.test.ts runs the empty-root case against
 * both this module and a mutant whose `harnessRootFor` is the identity, and
 * requires that the mutant does NOT refuse.
 */
export function resolveRunRoot(env: Record<string, string | undefined> = process.env): string {
  const named = env.HARNESS_ROOT;
  if (named !== undefined) return harnessRootFor(named);
  return harnessRootFor(resolve(import.meta.dir, ".."));
}

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

if (!gate || !["scope", "verify", "ship", "merge", "prove", "gaps"].includes(gate)) {
  console.error("Usage: bun run gates/run-gate.ts --gate scope|verify|ship|merge|prove|gaps --slug SLUG [--issue NUM]");
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

// Delegate to gate executor.
// executeGate is async — without the await, result.exitCode was undefined and
// process.exit(undefined) exited 0, so every gate reported PASS and the
// executor was killed mid-flight.
const result = await executeGate({ gate, slug, issue, workDir: WORK_DIR, stateFilePath: SF, harnessRoot: resolveRunRoot() });

process.exit(result.exitCode);
} // end if (import.meta.main)
