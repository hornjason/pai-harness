import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

export interface HealResult {
  result: "PASS" | "FAIL";
  attempts: number;
  failures?: Array<{ check: string; result: string; detail: string }>;
  circuitBroken?: boolean;
}

const VALID_GATES = ["scope", "verify", "ship", "prove", "merge"] as const;
type GateName = (typeof VALID_GATES)[number];

export async function runWithHeal(opts: {
  gate: string;
  slug: string;
  issue: number;
  projectRoot: string;
  workDir: string;
  maxAttempts?: number;
  dryRun?: boolean;
}): Promise<HealResult> {
  const { gate, slug, issue, projectRoot, workDir, maxAttempts = 3, dryRun = false } = opts;

  if (!VALID_GATES.includes(gate as GateName)) {
    throw new Error(`Invalid gate: "${gate}". Must be one of: ${VALID_GATES.join(", ")}`);
  }

  const sf = join(workDir, "workflow-state.json");
  if (!existsSync(sf)) {
    throw new Error(`workflow-state.json not found at ${sf}`);
  }

  // Snapshot protected fields before gate execution for integrity check
  const preState = JSON.parse(readFileSync(sf, "utf-8"));
  const beforeSnapshot = snapshotProtectedFields(preState);

  if (!dryRun) {
    try {
      execFileSync("bun", [
        "run", join(projectRoot, "gates", "run-gate.ts"),
        "--gate", gate,
        "--slug", slug,
        "--issue", String(issue),
      ], { timeout: 120_000, cwd: projectRoot });
    } catch {
      // Gate process exits non-zero on FAIL — that's expected
    }
  }

  const state = JSON.parse(readFileSync(sf, "utf-8"));

  // Integrity check: verify protected fields weren't tampered with outside gate system
  const afterSnapshot = snapshotProtectedFields(state);
  const integrity = checkIntegrity(beforeSnapshot, afterSnapshot);
  if (integrity.violated) {
    console.error(`[self-heal] Integrity violation detected: ${integrity.changes.join("; ")}`);
  }

  const gateResult = state.gates?.[gate];

  if (!gateResult) {
    return { result: "FAIL", attempts: 1, failures: [{ check: "gate-execution", result: "FAIL", detail: `No gate result found for ${gate}` }] };
  }

  const attempt = gateResult.attempt ?? 1;

  if (gateResult.result === "PASS") {
    return { result: "PASS", attempts: attempt };
  }

  const failures = gateResult.failures ?? [];

  if (attempt >= maxAttempts) {
    return { result: "FAIL", attempts: attempt, failures, circuitBroken: true };
  }

  return { result: "FAIL", attempts: attempt, failures };
}

export function snapshotProtectedFields(state: Record<string, any>): Record<string, any> {
  const gates = JSON.parse(JSON.stringify(state.gates ?? {}));
  const acs = (state.acs ?? []).map((ac: any) => ({
    id: ac.id,
    verdict: ac.verdict,
    evidence: JSON.parse(JSON.stringify(ac.evidence ?? null)),
  }));
  return { gates, acs };
}

export function checkIntegrity(
  before: Record<string, any>,
  after: Record<string, any>,
): { violated: boolean; changes: string[] } {
  const changes: string[] = [];

  if (JSON.stringify(before.gates) !== JSON.stringify(after.gates)) {
    changes.push("gates: protected field modified");
  }

  const beforeAcs: any[] = before.acs ?? [];
  const afterAcs: any[] = after.acs ?? [];

  for (let i = 0; i < beforeAcs.length; i++) {
    const b = beforeAcs[i];
    const a = afterAcs.find((x: any) => x.id === b.id);
    if (!a) {
      changes.push(`${b.id}: AC removed`);
      continue;
    }
    if (b.verdict !== a.verdict) {
      changes.push(`${b.id}: verdict changed (${b.verdict} -> ${a.verdict})`);
    }
    if (JSON.stringify(b.evidence) !== JSON.stringify(a.evidence)) {
      changes.push(`${b.id}: evidence modified`);
    }
  }

  return { violated: changes.length > 0, changes };
}
