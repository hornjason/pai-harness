#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  writeGateResult,
  generateHmac,
  generateShipEvidence,
  runConvergence,
  writeGateSummary,
  markCommandlessACsAsSkip,
  type GateResult,
} from "./orchestrator";
import { writeWitness } from "./witness";
import { safeParseProjectHarness, type ProjectHarness } from "../lib/rungate-schema";
import {
  populateACVerdicts,
  checkVerifyPendingACs,
  runProveReproducer,
  runScopePreflights,
  runTypeCheck,
  runVerifyChecks,
  executeGateTests,
  parseGateTestResults,
  processConformityFindings,
  logBatchDiagnosis,
  spawnScopeAdversary,
  checkDevServerLiveness,
  checkB1AdversaryReport,
  runB2EvidenceValidation,
  spawnB2ValidatorAgent,
  spawnB1VerifyAgent,
  executeMergeGate,
  handleProveGateExit,
  runPostShipChecks,
} from "./gate-executor";

// ── Gate contract interfaces (SC-373) ─────────────────────────────────────

export interface RunGateInput {
  gate: string;
  slug: string;
  issue: number;
}

export type ParseTestOutput = GateResult[];

// ── Implementation ────────────────────────────────────────────────────────

export function parseTestResults(output: string): GateResult[] {
  const results: GateResult[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/\(pass\)\s+(.+?)(?:\s+\[|$)/);
    if (pm) {
      results.push({ check: pm[1].trim(), result: "PASS", detail: "passed" });
      continue;
    }
    const fm = lines[i].match(/\(fail\)\s+(.+?)(?:\s+\[|$)/);
    if (fm) {
      const detailLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/\(pass\)\s+/.test(lines[j]) || /\(fail\)\s+/.test(lines[j])) break;
        const trimmed = lines[j].trim();
        if (trimmed) detailLines.push(trimmed);
      }
      results.push({ check: fm[1].trim(), result: "FAIL", detail: detailLines.length > 0 ? detailLines.join("\n") : "failed" });
    }
  }
  return results;
}

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
const CEREMONY_PROFILE = existsSync(join(__dirname, "ceremony-profiles.json"))
  ? join(__dirname, "ceremony-profiles.json")
  : join(process.env.HOME || "", ".claude", "skills", "ship", "ceremony-profiles.json");

if (!existsSync(SF)) {
  console.error(`BLOCKED — ${SF} not found`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(SF, "utf-8"));
if (!issue) issue = state.issue || 0;
if (!slug) slug = state.slug || "";
const issueRepo = state.issueRepo || state.repo || "";

// Gate idempotency guard
if (!process.argv.includes("--force") && state.gates?.[gate]?.result === "PASS") {
  console.log(`Gate ${gate}: already PASSED (attempt ${state.gates[gate].attempt}). Use --force to re-run.`);
  console.log(`\n${gate} GATE: PASS (cached)`);
  process.exit(0);
}

// Validate rungate.json against Zod schema (SC-6)
let validatedHarness: ProjectHarness | null = null;
const projectHarnessPath = state.projectRoot
  ? join(state.projectRoot, ".claude", "rungate.json")
  : "";
if (projectHarnessPath && existsSync(projectHarnessPath)) {
  const rawHarness = JSON.parse(readFileSync(projectHarnessPath, "utf-8"));
  const result = safeParseProjectHarness(rawHarness);
  if (!result.success) {
    console.warn(`WARN: rungate.json schema validation failed:`);
    for (const err of result.error.issues) {
      console.warn(`  - ${err.path.join(".")}: ${err.message}`);
    }
  } else {
    validatedHarness = result.data;
  }
}

// AC auto-population
const evidenceCwd = process.env.EVIDENCE_CWD || state.projectRoot || process.cwd();
populateACVerdicts(state, SF, evidenceCwd);

// Mark commandless ACs as SKIP
const skipped = markCommandlessACsAsSkip(SF);
if (skipped > 0) {
  const refreshed = JSON.parse(readFileSync(SF, "utf-8"));
  Object.assign(state, refreshed);
}

// Early results accumulator
let earlyResults: GateResult[] = [];
let earlyFails = 0;

// Verify gate: check for PENDING ACs
if (gate === "verify") {
  const pendingCheck = checkVerifyPendingACs(state);
  earlyResults = pendingCheck.earlyResults;
  earlyFails = pendingCheck.earlyFails;
}

// B3: Prove Reproducer (ADR-009)
if (gate === "prove") {
  runProveReproducer(state, issue, issueRepo, WORK_DIR);
}

// Scope pre-flights
if (gate === "scope") {
  runScopePreflights(state);
}

// Type check (SC-10)
if (gate === "scope" || gate === "verify") {
  runTypeCheck(state);
}

// Verify-time checks
if (gate === "verify") {
  runVerifyChecks(state);
}

// Post-ship checks (SC-47, SC-72)
if (gate === "ship") {
  runPostShipChecks(state);
}

// Set phase to gate level BEFORE tests execute
const GATE_PHASE_MAP: Record<string, string> = { scope: "SCOPE", verify: "VERIFY", ship: "SHIP", prove: "DONE" };
const gatePhase = GATE_PHASE_MAP[gate];
if (gatePhase && state.phase !== gatePhase) {
  const priorPhase = state.phase;
  state.phase = gatePhase;
  writeFileSync(SF, JSON.stringify(state, null, 2));
  console.log(`Phase set to ${gatePhase} for gate tests (was ${priorPhase})`);
}

// Run tests
const { testOutput, testExitCode } = executeGateTests(gate, WORK_DIR, state);

// Parse test results
let { passes, fails, warns, results } = parseGateTestResults(testOutput, testExitCode, earlyResults, earlyFails);
console.log(`\nTest results: ${passes} pass, ${fails} fail, ${warns} warn`);

// Conformity findings
const projectRoot = state.projectRoot || process.cwd();
processConformityFindings(state, projectRoot);

// Batch diagnosis
logBatchDiagnosis(results, fails);

// Agent result collectors
let b2AgentResult: Record<string, unknown> | null = null;
let b1VerifyAgentResult: Record<string, unknown> | null = null;

// B1: AC Adversary at scope (ADR-009)
if (gate === "scope" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
  spawnScopeAdversary(state, WORK_DIR);
}

// Dev server liveness check
if (gate === "verify" && fails === 0 && testExitCode === 0) {
  const { addedFails } = checkDevServerLiveness(state, results);
  fails += addedFails;
}

// B1/B2 agents at verify (ADR-009)
if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
  const b1Report = checkB1AdversaryReport(state, WORK_DIR, results);
  fails += b1Report.addedFails;
  warns += b1Report.addedWarns;

  if (fails === 0) {
    runB2EvidenceValidation(state);

    const b2 = spawnB2ValidatorAgent(state, WORK_DIR, results);
    warns += b2.addedWarns;
    b2AgentResult = b2.agentResult;

    const b1v = spawnB1VerifyAgent(state, WORK_DIR, results);
    warns += b1v.addedWarns;
    b1VerifyAgentResult = b1v.agentResult;
  }
}

// Write gate result
const { resultVal, attempt } = writeGateResult(SF, gate, passes, fails, warns, results, state.projectRoot);
console.log(`Gate ${gate}: ${resultVal} (attempt ${attempt})`);

// Persist B1/B2 agent results
if (gate === "verify" && (b2AgentResult || b1VerifyAgentResult)) {
  const freshState = JSON.parse(readFileSync(SF, "utf-8"));
  freshState.gates = freshState.gates || {};
  freshState.gates.verify = freshState.gates.verify || {};
  if (b2AgentResult) freshState.gates.verify.evidenceValidator = b2AgentResult;
  if (b1VerifyAgentResult) freshState.gates.verify.adversary = b1VerifyAgentResult;
  if (state.conformityFindings) freshState.conformityFindings = state.conformityFindings;
  writeFileSync(SF, JSON.stringify(freshState, null, 2));
}

// Write tamper-evident witness
try {
  const witnessPath = writeWitness(slug, gate, resultVal, testOutput, issue, state.projectRoot);
  console.log(`Witness: ${witnessPath}`);
} catch (e: unknown) {
  console.error(`Witness write failed: ${(e as Error).message}`);
}

// Gate-specific exit handlers
if (gate === "merge") {
  executeMergeGate(state, SF);
}

if (gate === "prove") {
  handleProveGateExit(issue, issueRepo, WORK_DIR, resultVal);
}

// Ship-specific: HMAC + evidence
if (gate === "ship" && resultVal === "PASS") {
  const hash = generateHmac(SF, slug, issue, state.projectRoot);
  console.log(`HMAC: ${hash}`);
  const evidencePath = generateShipEvidence(SF, WORK_DIR, issue, issueRepo, passes, fails, warns);
  console.log(`Ship evidence: ${evidencePath}`);
}

// Verify-specific: convergence
if (gate === "verify" && resultVal === "FAIL" && existsSync(CEREMONY_PROFILE)) {
  const convergenceResult = runConvergence(SF, gate, resultVal, CEREMONY_PROFILE);
  if (convergenceResult.action === "circuit-break") {
    console.log(`CIRCUIT BREAK — iteration ${convergenceResult.iteration}`);
    process.exit(2);
  } else if (convergenceResult.action === "stall") {
    console.log(`STALL DETECTED — same failures, iteration ${convergenceResult.iteration}`);
  } else if (convergenceResult.action === "loop-back") {
    console.log(`LOOP-BACK — iteration ${convergenceResult.iteration}`);
  }
}

// Gate summary
const sessionId = process.env.SESSION_ID || "unknown";
const summaryResult = writeGateSummary(gate, passes, fails, warns, results, issue, slug, sessionId);

process.exit(summaryResult === "BLOCKED" ? 1 : 0);
} // end if (import.meta.main)
