#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

export const MAX_ITERATIONS = 3;

function workDirBase(): string {
  return process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate");
}
const GATES_DIR = __dirname;

export type GateName = "scope" | "verify" | "ship";

const PHASE_GATE: Record<string, GateName> = {
  SCOPE: "scope",
  BUILD: "verify",
  SHIP: "ship",
};

const DIRECT_ADVANCE: Record<string, string> = {
  GOAL: "DISCOVERY",
  DISCOVERY: "SCOPE",
  VERIFY: "SHIP",
};

const GATE_TARGET: Record<string, string> = {
  scope: "BUILD",
  verify: "SHIP",
  ship: "DONE",
};

export interface AdvanceResult {
  phase: string;
  gateResult: "PASS" | "FAIL" | "SKIPPED";
  failures?: string[];
  iteration?: number;
  circuitBreaker?: boolean;
}

function statePath(slug: string): string {
  return join(workDirBase(), slug, "workflow-state.json");
}

function readState(slug: string): Record<string, any> {
  const sf = statePath(slug);
  if (!existsSync(sf)) {
    throw new Error(`workflow-state.json not found: ${sf}`);
  }
  return JSON.parse(readFileSync(sf, "utf-8"));
}

function writeStateFile(slug: string, state: Record<string, any>): void {
  const sf = statePath(slug);
  writeFileSync(sf, JSON.stringify(state, null, 2));
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function currentState(slug: string): Promise<Record<string, any>> {
  return readState(slug);
}

export function getIterationCount(slug: string): number {
  const state = readState(slug);
  return (state.changelog || []).filter(
    (e: any) => e.event === "iteration-loopback",
  ).length;
}

export function isCircuitBroken(slug: string): boolean {
  const state = readState(slug);
  if (state.phase === "CIRCUIT_BREAK") return true;
  return getIterationCount(slug) >= MAX_ITERATIONS;
}

export function getRequiredGate(phase: string): GateName | null {
  return PHASE_GATE[phase] || null;
}

export function validatePhaseTransition(from: string, to: string): boolean {
  if (from === "DONE" || from === "CIRCUIT_BREAK") return false;

  const gate = PHASE_GATE[from];
  if (gate) {
    return GATE_TARGET[gate] === to;
  }

  return DIRECT_ADVANCE[from] === to;
}

type GateExecutor = (gate: GateName, slug: string, issue: number) => void;

let _gateExecutor: GateExecutor | null = null;

export function setGateExecutor(executor: GateExecutor | null): void {
  _gateExecutor = executor;
}

function defaultGateExecutor(gate: GateName, slug: string, issue: number): void {
  execFileSync(
    "bun",
    ["run", join(GATES_DIR, "run-gate.ts"), "--gate", gate, "--slug", slug, "--issue", String(issue)],
    {
      encoding: "utf-8",
      timeout: 180000,
      cwd: join(process.env.HOME || "", ".claude"),
      env: { ...process.env, TEST_WORK_DIR: join(workDirBase(), slug) },
    },
  );
}

export async function runGate(slug: string, gate: GateName): Promise<AdvanceResult> {
  const state = readState(slug);
  const currentPhase = state.phase;

  const expectedGate = getRequiredGate(currentPhase);
  if (expectedGate !== gate) {
    throw new Error(
      `Cannot run ${gate} gate from phase ${currentPhase} — ` +
      (expectedGate ? `expected ${expectedGate}` : "no gate required"),
    );
  }

  if (isCircuitBroken(slug)) {
    return {
      phase: "CIRCUIT_BREAK",
      gateResult: "FAIL",
      failures: ["Circuit breaker: maximum iterations reached"],
      circuitBreaker: true,
    };
  }

  const issue = state.issue || 0;
  const executor = _gateExecutor || defaultGateExecutor;

  try {
    executor(gate, slug, issue);
  } catch {
    // gate failure — result read from workflow-state.json below
  }

  const updatedState = readState(slug);
  const gateResult: "PASS" | "FAIL" = updatedState.gates?.[gate]?.result || "FAIL";
  const failures = (updatedState.gates?.[gate]?.failures || [])
    .map((f: any) => f.check || f.detail || JSON.stringify(f));
  const iteration = updatedState.gates?.[gate]?.attempt || 1;

  return {
    phase: updatedState.phase,
    gateResult,
    failures: gateResult === "FAIL" ? failures : undefined,
    iteration,
    circuitBreaker: updatedState.phase === "CIRCUIT_BREAK",
  };
}

export async function advancePhase(slug: string): Promise<AdvanceResult> {
  const state = readState(slug);
  const currentPhase = state.phase;

  if (currentPhase === "DONE" || currentPhase === "CIRCUIT_BREAK") {
    return { phase: currentPhase, gateResult: "SKIPPED" };
  }

  const gate = getRequiredGate(currentPhase);

  if (gate) {
    return runGate(slug, gate);
  }

  const nextPhase = DIRECT_ADVANCE[currentPhase];
  if (!nextPhase) {
    throw new Error(`No transition defined for phase: ${currentPhase}`);
  }

  const ts = isoNow();
  state.phase = nextPhase;
  state.updatedTs = ts;
  state.changelog = state.changelog || [];
  state.changelog.push({
    ts,
    event: "phase-advance",
    detail: `${currentPhase} → ${nextPhase}`,
    actor: "gate-runner",
  });

  state.phaseTimings = state.phaseTimings || {};
  const currentTimings = state.phaseTimings[currentPhase] || [];
  if (currentTimings.length > 0) {
    currentTimings[currentTimings.length - 1].exitedTs = ts;
  }
  state.phaseTimings[currentPhase] = currentTimings;
  state.phaseTimings[nextPhase] = (state.phaseTimings[nextPhase] || []).concat([
    { enteredTs: ts, source: "gate-runner" },
  ]);

  writeStateFile(slug, state);

  return { phase: nextPhase, gateResult: "SKIPPED" };
}

// ── CLI ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  let slug = "";
  let action = "";
  let gate = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--slug" && args[i + 1]) slug = args[++i];
    if (args[i] === "--action" && args[i + 1]) action = args[++i];
    if (args[i] === "--gate" && args[i + 1]) gate = args[++i];
  }

  if (!slug) {
    console.error("Usage: bun run gates/ship-orchestrator.ts --slug SLUG --action advance|status|gate [--gate scope|verify|ship]");
    process.exit(1);
  }

  if (!action || !["advance", "status", "gate"].includes(action)) {
    console.error("--action must be one of: advance, status, gate");
    process.exit(1);
  }

  try {
    if (action === "status") {
      const state = await currentState(slug);
      console.log(JSON.stringify({
        phase: state.phase,
        issue: state.issue,
        slug: state.slug,
        iteration: getIterationCount(slug),
        circuitBroken: isCircuitBroken(slug),
        gates: state.gates,
      }, null, 2));
    } else if (action === "advance") {
      const result = await advancePhase(slug);
      console.log(JSON.stringify(result, null, 2));
      if (result.gateResult === "FAIL") process.exit(1);
      if (result.circuitBreaker) process.exit(2);
    } else if (action === "gate") {
      const validGates = Object.values(PHASE_GATE);
      if (!gate || !validGates.includes(gate as GateName)) {
        console.error("--gate must be one of: scope, verify, ship");
        process.exit(1);
      }
      const result = await runGate(slug, gate as GateName);
      console.log(JSON.stringify(result, null, 2));
      if (result.gateResult === "FAIL") process.exit(1);
      if (result.circuitBreaker) process.exit(2);
    }
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
