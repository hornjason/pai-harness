import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, unlinkSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { createHash, createHmac, randomBytes } from "crypto";
import { execSync } from "child_process";
import { WorkflowStateSchema, ACSchema, AfkBatchPlanSchema, REJECTED_SKIP_REASONS } from "./schema";
import { ZodError } from "zod";

export interface GateResult {
  check: string;
  result: "PASS" | "FAIL" | "WARN";
  detail: string;
}

interface WorkflowState {
  [key: string]: any;
}

function readState(sf: string): WorkflowState {
  return JSON.parse(readFileSync(sf, "utf-8"));
}

function writeState(sf: string, state: WorkflowState): void {
  const tmp = `${sf}.${process.pid}.tmp`;
  const json = JSON.stringify(state, null, 2);
  writeFileSync(tmp, json);
  try {
    JSON.parse(readFileSync(tmp, "utf-8"));
    const { renameSync } = require("fs");
    renameSync(tmp, sf);
  } catch {
    try { unlinkSync(tmp); } catch {}
    throw new Error("writeState produced invalid JSON");
  }
}

function gitSha(cwd?: string): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", timeout: 5000, cwd }).trim();
  } catch {
    return "unknown";
  }
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const PHASE_ADVANCE: Record<string, string> = {
  scope: "BUILD",
  verify: "SHIP",
  ship: "DONE",
};

export function writeGateResult(
  sf: string,
  gate: string,
  passes: number,
  fails: number,
  warns: number,
  results: GateResult[],
  projectRoot?: string,
): { resultVal: "PASS" | "FAIL"; attempt: number } {
  const state = readState(sf);
  let resultVal: "PASS" | "FAIL" = fails === 0 ? "PASS" : "FAIL";

  // #514: Block phase advance when non-OUTCOME ACs have FAIL verdicts
  if ((gate === "verify" || gate === "ship") && resultVal === "PASS") {
    const failedACs = (state.acs || []).filter(
      (ac: any) => ac.verdict === "FAIL" && ac.type !== "OUTCOME"
    );
    if (failedACs.length > 0) {
      resultVal = "FAIL";
      for (const ac of failedACs) {
        results.push({
          check: `ac-verdict-fail: ${ac.id}`,
          result: "FAIL",
          detail: `${ac.id} has FAIL verdict`,
        });
      }
      fails += failedACs.length;
    }
  }

  const prev = state.gates?.[gate]?.attempt ?? 0;
  const attempt = prev + 1;
  const ts = isoNow();
  const sha = gitSha(projectRoot);

  const failures = results.filter(r => r.result === "FAIL");

  state.gates = state.gates || {};
  state.gates[gate] = {
    result: resultVal,
    attempt,
    failures,
    ts,
    commitSha: sha,
  };
  state.updatedTs = ts;
  state.changelog = state.changelog || [];
  state.changelog.push({
    ts,
    event: `gate-${gate}`,
    detail: `${passes} pass, ${fails} fail, ${warns} warn`,
    actor: "gate-runner",
  });

  // ADR-009: Record AC hash at scope PASS for cross-gate consistency
  // Hash only AC definitions (inputs), not verdicts/evidence (outputs populated by gates)
  if (gate === "scope" && resultVal === "PASS") {
    const acDefs = (state.acs || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const acHash = createHash("sha256").update(JSON.stringify(acDefs)).digest("hex");
    state.gates.scope.acHash = acHash;
  }

  if (gate === "ship" && resultVal === "PASS") {
    state.mergeCommitSha = sha;
  }

  // #514 SC-2: Ship gate failure resets phase to VERIFY for re-iteration
  if (gate === "ship" && resultVal === "FAIL") {
    state.phase = "VERIFY";
    state.changelog.push({
      ts,
      event: "ship-fail-regression",
      detail: "Ship gate FAIL — resetting to VERIFY for re-iteration",
      actor: "gate-runner",
    });
  }

  const next = resultVal === "PASS" ? PHASE_ADVANCE[gate] : undefined;
  if (next) {
    state.phaseTimings = state.phaseTimings || {};
    const currentPhase = state.phase;
    const currentTimings = state.phaseTimings[currentPhase] || [];
    if (currentTimings.length > 0) {
      currentTimings[currentTimings.length - 1].exitedTs = ts;
    }
    state.phaseTimings[currentPhase] = currentTimings;

    state.phaseTimings[next] = (state.phaseTimings[next] || []).concat([
      { enteredTs: ts, source: "gate-runner" },
    ]);
    state.phase = next;
  }

  writeState(sf, state);
  return { resultVal, attempt };
}

import { gateSaltPath } from "../lib/paths";

const GATE_SALT_PATH = gateSaltPath();

export function generateHmac(sf: string, slug: string, issue: number, projectRoot?: string): string {
  if (!existsSync(GATE_SALT_PATH)) {
    mkdirSync(dirname(GATE_SALT_PATH), { recursive: true });
    writeFileSync(GATE_SALT_PATH, randomBytes(32).toString("hex") + "\n");
    chmodSync(GATE_SALT_PATH, 0o600);
  }

  const perms = statSync(GATE_SALT_PATH).mode & 0o777;
  if (perms !== 0o600) {
    chmodSync(GATE_SALT_PATH, 0o600);
  }

  const salt = readFileSync(GATE_SALT_PATH, "utf-8").trim();
  const sha = gitSha(projectRoot);
  const input = `${slug}:${issue}:PASS:${sha}`;
  const hash = createHmac("sha256", salt).update(input).digest("hex").slice(0, 16);

  const state = readState(sf);
  state.gates = state.gates || {};
  state.gates.ship = state.gates.ship || {};
  state.gates.ship.hash = hash;
  writeState(sf, state);

  return hash;
}

export function runConvergence(
  sf: string,
  gate: string,
  resultVal: string,
  ceremonyProfilePath: string,
): { action: "circuit-break" | "stall" | "loop-back" | "skip"; iteration?: number } {
  if (gate !== "verify" || resultVal !== "FAIL") {
    return { action: "skip" };
  }

  const state = readState(sf);
  const profile = JSON.parse(readFileSync(ceremonyProfilePath, "utf-8"));
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  const maxIter = profile.tiers?.[tier]?.maxIterations ?? 5;

  const loopbacks = (state.changelog || []).filter(
    (e: any) => e.event === "iteration-loopback",
  );
  const iterCount = loopbacks.length;

  const failNames = (state.gates?.verify?.failures || [])
    .map((f: any) => f.check)
    .sort()
    .join(",");

  // Read previous hash BEFORE appending new one
  let prevHash = "";
  if (iterCount >= 1) {
    prevHash = loopbacks[loopbacks.length - 1]?.failureHash || "";
  }

  const ts = isoNow();
  const newIter = iterCount + 1;

  state.changelog = state.changelog || [];
  state.changelog.push({
    ts,
    event: "iteration-loopback",
    detail: `iteration ${newIter} — failures: ${failNames}`,
    failureHash: failNames,
    actor: "gate-runner",
  });

  // Circuit breaker
  if (newIter >= maxIter) {
    state.phaseTimings = state.phaseTimings || {};
    const currentPhase = state.phase;
    const currentTimings = state.phaseTimings[currentPhase] || [];
    if (currentTimings.length > 0) {
      currentTimings[currentTimings.length - 1].exitedTs = ts;
    }
    state.phaseTimings[currentPhase] = currentTimings;
    state.phaseTimings["CIRCUIT_BREAK"] = [{ enteredTs: ts, source: "gate-runner" }];
    state.phase = "CIRCUIT_BREAK";
    writeState(sf, state);
    return { action: "circuit-break", iteration: newIter };
  }

  // Stall detection
  if (prevHash && prevHash === failNames) {
    state.changelog.push({
      ts,
      event: "council-recommended",
      detail: "same failure hash in consecutive iterations — consider council review",
      actor: "gate-runner",
    });
  }

  // Loop back to BUILD
  state.phaseTimings = state.phaseTimings || {};
  const currentPhase = state.phase;
  const currentTimings = state.phaseTimings[currentPhase] || [];
  if (currentTimings.length > 0) {
    currentTimings[currentTimings.length - 1].exitedTs = ts;
  }
  state.phaseTimings[currentPhase] = currentTimings;

  const buildTimings = state.phaseTimings["BUILD"] || [];
  state.phaseTimings["BUILD"] = buildTimings.concat([
    { enteredTs: ts, source: "gate-runner", iteration: buildTimings.length + 1 },
  ]);
  state.phase = "BUILD";
  writeState(sf, state);

  const isStall = prevHash !== "" && prevHash === failNames;
  return { action: isStall ? "stall" : "loop-back", iteration: newIter };
}

export function generateShipEvidence(
  sf: string,
  workDir: string,
  issue: number,
  issueRepo: string,
  passes: number,
  fails: number,
  warns: number,
): string {
  const state = readState(sf);
  const sha = gitSha();
  const ts = isoNow();

  const loopbacks = (state.changelog || []).filter(
    (e: any) => e.event === "iteration-loopback",
  );
  const iterCount = loopbacks.length + 1;
  const predicted = state.sizing?.predicted || "unknown";

  const acEvidence = (state.acs || []).map((ac: any) => ({
    criterion: `${ac.id}: ${ac.statement}`,
    result: ac.verdict || "SKIP",
    detail: ac.evidence?.content || ac.evidence || "no evidence",
  }));

  const evidence = {
    contractVersion: "1.0",
    issueNumber: issue,
    gateOut: { status: "PASS" as const, evidence: acEvidence },
    mergeCommitSha: sha,
    capturedAt: ts,
    iterationCount: iterCount,
    sizing: { predicted, actual: predicted },
  };

  const evidencePath = join(workDir, "ship-evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

  // GitHub: add shipped label + post comment (best-effort)
  if (issueRepo && issue > 0) {
    try {
      execSync(`gh issue edit ${issue} --repo ${issueRepo} --add-label shipped`, {
        timeout: 15000,
        stdio: "pipe",
      });
    } catch {}

    const scTable = (state.acs || [])
      .map((ac: any) => `| ${ac.id} | ${ac.verdict || "SKIP"} | ${ac.evidence?.content || "—"} |`)
      .join("\n");

    const comment = [
      "## Ship Complete (automated)\n",
      `**Commit:** ${sha}`,
      `**Gate:** ${passes} pass, ${fails} fail, ${warns} warn\n`,
      "### SC Results",
      "| SC | Verdict | Evidence |",
      "|---|---|---|",
      scTable,
      "\nChain mode — issue stays open for /prove.",
    ].join("\n");

    try {
      execSync(`gh issue comment ${issue} --repo ${issueRepo} --body-file -`, {
        input: comment,
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}

    // Auto-push
    try {
      const ahead = execSync("git rev-list --count @{upstream}..HEAD", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (parseInt(ahead) > 0) {
        execSync("git push", {
          timeout: 30000,
          env: { ...process.env, GATE_PASSED_PUSH: "1" },
          stdio: "pipe",
        });
      }
    } catch {}
  }

  return evidencePath;
}

const GATE_PENDING_PATH = join(
  process.env.HOME || "",
  ".claude",
  "MEMORY",
  "STATE",
  "gate-pending.json",
);

export function writeGateSummary(
  gate: string,
  passes: number,
  fails: number,
  warns: number,
  results: GateResult[],
  issue: number,
  slug: string,
  sessionId: string,
): "BLOCKED" | "ALL CLEAR" {
  console.log("-----------------------------------");
  console.log(`${gate} GATE: ${passes} pass, ${fails} fail, ${warns} warn`);

  if (fails > 0) {
    mkdirSync(dirname(GATE_PENDING_PATH), { recursive: true });
    const failItems = results
      .filter(r => r.result === "FAIL")
      .map(r => ({ check: r.check, detail: r.detail }));

    const pending = {
      session_id: sessionId || "unknown",
      gate,
      issue,
      slug,
      failures: failItems,
      strike_count: 0,
      max_strikes: 3,
      outcome_ac_failure: false,
      created_at: isoNow(),
      expires_ts: Math.floor(Date.now() / 1000) + 14400,
    };

    writeFileSync(GATE_PENDING_PATH, JSON.stringify(pending, null, 2));
    console.log("BLOCKED");
    return "BLOCKED";
  }

  try { unlinkSync(GATE_PENDING_PATH); } catch {}
  console.log("ALL CLEAR");
  return "ALL CLEAR";
}

// ── Write-time Zod validation (#453) ─────────────────────────────────────

export function writeWorkflowState(sf: string, state: object): void {
  try {
    WorkflowStateSchema.passthrough().parse(state);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.issues.map(issue => {
        if (issue.code === "invalid_enum_value") {
          return `${issue.path.join(".")}: expected one of [${issue.options.join(", ")}], got "${issue.received}"`;
        }
        return `${issue.path.join(".")}: ${issue.message}`;
      });
      throw new Error(`Workflow state validation failed:\n${messages.join("\n")}`);
    }
    throw err;
  }
  writeState(sf, state as WorkflowState);
}

// ── Structured workflow authoring (#454) ─────────────────────────────────

export function initWorkflow(sf: string, opts: {
  issue: number;
  repo: string;
  issueRepo?: string;
  projectRoot: string;
  slug: string;
  issueGoal: string;
  sizing?: { predicted?: string; ceremonyTier?: string };
  sourceSpecs?: Array<{ path: string; citedInDiscovery: boolean; specElements?: string[] }>;
  bootstrappedFrom?: string;
}): void {
  const ts = isoNow();
  const state: Record<string, any> = {
    schemaVersion: 2,
    issue: opts.issue,
    repo: opts.repo,
    issueRepo: opts.issueRepo || opts.repo,
    projectRoot: opts.projectRoot,
    slug: opts.slug,
    issueGoal: opts.issueGoal,
    phase: "GOAL",
    acs: [],
    gates: {},
    changelog: [],
    startTs: ts,
    updatedTs: ts,
  };

  if (opts.sizing) state.sizing = opts.sizing;
  if (opts.sourceSpecs) state.sourceSpecs = opts.sourceSpecs;
  if (opts.bootstrappedFrom) state.bootstrappedFrom = opts.bootstrappedFrom;

  WorkflowStateSchema.passthrough().parse(state);
  mkdirSync(dirname(sf), { recursive: true });
  writeState(sf, state);
}

export function writeACs(sf: string, acs: Array<{
  id: string;
  type?: string;
  statement: string;
  threshold?: { op: string; value: string | number; unit?: string };
  evidenceMethod?: { type: string; command?: string };
  specElement?: string;
}>): void {
  const state = readState(sf);

  state.acs = acs.map(ac => {
    const enriched = { ...ac, evidence: null, verdict: "PENDING" as const };
    ACSchema.parse(enriched);
    return enriched;
  });

  writeState(sf, state);
}

// ── AFK batch plan helpers (#468) ──────────────────────────────────────

const AFK_BATCH_FILE = "afk-batch.json";

function readBatchPlan(dir: string): any {
  const fp = join(dir, AFK_BATCH_FILE);
  return JSON.parse(readFileSync(fp, "utf-8"));
}

function writeBatchPlanFile(dir: string, plan: any): void {
  AfkBatchPlanSchema.parse(plan);
  const fp = join(dir, AFK_BATCH_FILE);
  writeFileSync(fp, JSON.stringify(plan, null, 2));
}

export function initBatchPlan(dir: string, planned: number[]): void {
  mkdirSync(dir, { recursive: true });
  const plan = {
    approvedAt: isoNow(),
    planned,
    shipped: [],
    skipped: [],
    inProgress: null,
  };
  writeBatchPlanFile(dir, plan);
}

export function recordBatchShipped(dir: string, issue: number): void {
  const plan = readBatchPlan(dir);
  if (!plan.shipped.includes(issue)) {
    plan.shipped.push(issue);
  }
  if (plan.inProgress === issue) {
    plan.inProgress = null;
  }
  writeBatchPlanFile(dir, plan);
}

export function recordBatchSkipped(dir: string, issue: number, reason: string, delegationAction?: string): void {
  // Enforce rejection rules before mutating state
  if (REJECTED_SKIP_REASONS.includes(reason.toLowerCase())) {
    throw new Error(`Rejected skip reason: "${reason}" — must delegate instead`);
  }
  const plan = readBatchPlan(dir);
  const entry: any = { issue, reason };
  if (delegationAction !== undefined) {
    entry.delegationAction = delegationAction;
  }
  plan.skipped.push(entry);
  if (plan.inProgress === issue) {
    plan.inProgress = null;
  }
  writeBatchPlanFile(dir, plan);
}

// #513: Mark ACs without evidenceMethod.command as SKIP
export function markCommandlessACsAsSkip(sf: string): number {
  const state = readState(sf);
  let count = 0;
  for (const ac of state.acs || []) {
    if (ac.verdict && ac.verdict !== "PENDING") continue;
    if (!ac.evidenceMethod?.command) {
      ac.verdict = "SKIP";
      ac.evidence = { type: "manual-attestation", content: "No evidenceMethod.command defined" };
      count++;
    }
  }
  if (count > 0) writeState(sf, state);
  return count;
}

export function validateBatchComplete(dir: string): { complete: boolean; missing: number[] } {
  const plan = readBatchPlan(dir);
  const resolved = new Set([
    ...plan.shipped,
    ...plan.skipped.map((s: any) => s.issue),
  ]);
  const missing = plan.planned.filter((n: number) => !resolved.has(n));
  return { complete: missing.length === 0, missing };
}
