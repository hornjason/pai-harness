import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { harnessRoot } from "../lib/paths";

const HR = harnessRoot();
const SHIP_JS = readFileSync(join(HR, "workflows/ship.js"), "utf-8");
const SPEC_MD = readFileSync(join(HR, "specs/HARNESS-SKILL-CHAIN.md"), "utf-8");
const SKILL_MD = readFileSync(join(HR, "reference/prompts/ship-skill.md"), "utf-8");

function sliceBetween(src: string, start: string, end: string): string {
  const s = src.indexOf(start);
  const e = end ? src.indexOf(end, s + 1) : src.length;
  if (s < 0) throw new Error(`Start marker not found: "${start}"`);
  if (e < 0) throw new Error(`End marker not found: "${end}"`);
  return src.slice(s, e);
}

// ── Ceremony Tier Gating ───────────────────────────────────────
// Spec: HARNESS-SKILL-CHAIN.md Layer 1-2-3 + SKILL.md ceremony table
// LIGHT = skip Quinn/Rook. STANDARD = Quinn. THOROUGH = Quinn + Rook.

describe("ceremony-tier: Quinn gating matches spec", () => {

  test("SC-1: Quinn local gates on ceremonyTier, not hasUIChanges", () => {
    // Spec Layer 1: "Quinn validates on local dev"
    // Ceremony table: STANDARD = Quinn, THOROUGH = Quinn + Rook
    // Quinn local MUST NOT gate on file extensions — backend fixes with UI impact need Quinn too
    const validateSection = sliceBetween(SHIP_JS, "PHASE 5: VALIDATE", "PHASE 6: COMMIT");
    expect(validateSection).not.toContain("if (hasUIChanges)");
    expect(validateSection).toContain("ceremonyTier !== 'LIGHT'");
  });

  test("SC-2: Container Quinn gates on ceremonyTier, not hasUIChanges", () => {
    // Spec Layer 2: "make test-up → Quinn validates on container"
    // Must gate on ceremonyTier !== 'LIGHT', not file type checks
    const verifySection = sliceBetween(SHIP_JS, "PHASE 7: VERIFY", "PHASE 8: SHIP");
    expect(verifySection).toContain("ceremonyTier !== 'LIGHT'");
    expect(verifySection).not.toContain("hasUIChanges");
  });

  test("SC-3: Rook gates on ceremonyTier", () => {
    // Ceremony table: THOROUGH = Quinn + Rook parallel
    // Spec line 94 says "STANDARD+ tiers" — conflict with ceremony table
    // Code follows ceremony table (THOROUGH only) — this test documents current behavior
    const verifySection = sliceBetween(SHIP_JS, "PHASE 7: VERIFY", "PHASE 8: SHIP");
    expect(verifySection).toMatch(/ceremonyTier.*===.*'THOROUGH'/);
  });

  test("SC-4: LIGHT tier skips scope gate", () => {
    // SKILL.md: "LIGHT tier: scope gate is skipped"
    expect(SHIP_JS).toMatch(/skipScope\s*=\s*discovery\.ceremonyTier\s*===\s*'LIGHT'/);
  });

  test("SC-5: LIGHT tier gets simplified log when Quinn skipped", () => {
    expect(SHIP_JS).toContain("Quinn local: SKIPPED (LIGHT tier)");
  });
});

// ── Phase Ordering ─────────────────────────────────────────────
// Spec Layer 1→2→3: local dev → container → PR + ship gate

describe("phase-ordering: spec-mandated sequence preserved", () => {

  test("PO-1: Validate (Quinn local) runs BEFORE Commit", () => {
    // Spec: "GATE: Quinn local PASS before container build"
    // Commit must not happen until Quinn local passes
    const validateIdx = SHIP_JS.indexOf("PHASE 5: VALIDATE");
    const commitIdx = SHIP_JS.indexOf("PHASE 6: COMMIT");
    expect(validateIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(validateIdx);
  });

  test("PO-2: Commit runs BEFORE Verify (container)", () => {
    const commitIdx = SHIP_JS.indexOf("PHASE 6: COMMIT");
    const verifyIdx = SHIP_JS.indexOf("PHASE 7: VERIFY");
    expect(commitIdx).toBeGreaterThan(0);
    expect(verifyIdx).toBeGreaterThan(commitIdx);
  });

  test("PO-3: Container Quinn runs BEFORE PR creation", () => {
    // Spec: "GATE: Quinn container PASS before PR is opened"
    const containerQuinnIdx = SHIP_JS.indexOf("quinn-container");
    const createPrIdx = SHIP_JS.indexOf("create-pr");
    expect(containerQuinnIdx).toBeGreaterThan(0);
    expect(createPrIdx).toBeGreaterThan(containerQuinnIdx);
  });

  test("PO-4: PR creation runs BEFORE ship gate", () => {
    const createPrIdx = SHIP_JS.indexOf("create-pr");
    const shipGateIdx = SHIP_JS.indexOf("Running ship gate");
    expect(createPrIdx).toBeGreaterThan(0);
    expect(shipGateIdx).toBeGreaterThan(createPrIdx);
  });

  test("PO-5: Ship gate runs BEFORE Prove", () => {
    const shipGateIdx = SHIP_JS.indexOf("Running ship gate");
    const proveIdx = SHIP_JS.indexOf("PHASE 9: PROVE");
    expect(shipGateIdx).toBeGreaterThan(0);
    expect(proveIdx).toBeGreaterThan(shipGateIdx);
  });

  test("PO-6: Implement runs BEFORE Validate", () => {
    const implIdx = SHIP_JS.indexOf("PHASE 4: IMPLEMENT");
    const validateIdx = SHIP_JS.indexOf("PHASE 5: VALIDATE");
    expect(implIdx).toBeGreaterThan(0);
    expect(validateIdx).toBeGreaterThan(implIdx);
  });
});

// ── Prove Integration ──────────────────────────────────────────
// Spec Step 4: PROVE is post-merge, runs prove.js workflow (not gate test)

describe("prove-integration: prove.js workflow, not gate test", () => {

  test("PI-1: Main path uses workflow() for prove, not runGateWithHeal", () => {
    const proveSection = sliceBetween(SHIP_JS, "PHASE 9: PROVE", "Telemetry");
    expect(proveSection).toContain("workflow(");
    expect(proveSection).toContain("prove.js");
    expect(proveSection).not.toContain("runGateWithHeal('prove')");
  });

  test("PI-2: ALREADY_SHIPPED path returns early with status", () => {
    const alreadySection = sliceBetween(SHIP_JS, "ALREADY_SHIPPED", "Prior work:");
    expect(alreadySection).toContain("return {");
    expect(alreadySection).toContain("status: 'ALREADY_SHIPPED'");
  });

  test("PI-3: Prove passes issue + project args to child workflow", () => {
    const proveSection = sliceBetween(SHIP_JS, "PHASE 9: PROVE", "Telemetry");
    expect(proveSection).toContain("issue: ISSUE");
    expect(proveSection).toContain("projectRoot: PROJECT_ROOT");
  });
});

// ── Evidence Requirements ──────────────────────────────────────
// SKILL.md: environment evidence recorded, AC anchoring, evidence type ratio

describe("evidence-requirements: mechanical evidence checks", () => {

  test("ER-1: Environment evidence recorded after commit", () => {
    const commitSection = sliceBetween(SHIP_JS, "PHASE 6: COMMIT", "PHASE 7: VERIFY");
    expect(commitSection).toContain("environments.local.api");
    expect(commitSection).toContain("environments.local.ui");
    expect(commitSection).toContain("environments.local.tests");
  });

  test("ER-1b: Environment values enforced via schema enum (not agent prose)", () => {
    // Schema: EnvironmentLocalSchema uses z.enum(["PASS", "FAIL", "SKIP"])
    // ship.js must use structured output schema with enum constraint for env checks
    const commitSection = sliceBetween(SHIP_JS, "PHASE 6: COMMIT", "PHASE 7: VERIFY");
    expect(commitSection).toContain("enum: ['PASS', 'FAIL', 'SKIP']");
    expect(commitSection).toContain("ENV_CHECK_SCHEMA");
  });

  test("ER-1c: Container rebuild is config-driven (not hardcoded)", () => {
    const verifySection = sliceBetween(SHIP_JS, "PHASE 7: VERIFY", "PHASE 8: SHIP");
    expect(verifySection).toContain("containerConfig");
    expect(verifySection).toContain("rebuildCommand");
  });

  test("ER-2: AC anchoring instruction in discovery prompt", () => {
    const discoveryPrompt = sliceBetween(SHIP_JS, "You are performing DISCOVERY", "DISCOVERY_SCHEMA");
    expect(discoveryPrompt).toContain("1:1");
    expect(discoveryPrompt).toContain("Success Criteria");
    expect(discoveryPrompt).toContain("AC ANCHORING");
  });

  test("ER-3: Evidence type ratio instruction in discovery prompt", () => {
    const discoveryPrompt = sliceBetween(SHIP_JS, "You are performing DISCOVERY", "DISCOVERY_SCHEMA");
    expect(discoveryPrompt).toContain("50%");
    expect(discoveryPrompt).toContain("non-grep");
  });

  test("ER-4: Prior work check instruction in discovery prompt", () => {
    const discoveryPrompt = sliceBetween(SHIP_JS, "You are performing DISCOVERY", "DISCOVERY_SCHEMA");
    expect(discoveryPrompt).toContain("PRIOR WORK CHECK");
    expect(discoveryPrompt).toContain("MET");
    expect(discoveryPrompt).toContain("UNMET");
  });
});

// ── Gate Paths ─────────────────────────────────────────────────
// Gates consolidated to ~/.claude/gates/ (PR #499)

describe("gate-paths: gates run from consolidated location", () => {

  test("GP-1: runGateWithHeal gate command uses HARNESS_ROOT-based gate paths", () => {
    const gateRunner = sliceBetween(SHIP_JS, "async function runGateWithHeal", "PHASE 1: GOAL");
    expect(gateRunner).toContain("gates/run-gate.ts");
    expect(gateRunner).toContain("gates/error-classifier.ts");
  });

  test("GP-2: No PROJECT_ROOT reference in gate paths", () => {
    // All gate invocations should use HOME-relative paths
    const gateRuns = SHIP_JS.match(/bun run .*gates\/run-gate\.ts/g) || [];
    expect(gateRuns.length).toBeGreaterThan(0);
    for (const run of gateRuns) {
      expect(run).not.toContain("PROJECT_ROOT");
    }
  });
});

// ── Workflow Structure ─────────────────────────────────────────
// ship.js must have all 9 phases from meta block

describe("workflow-structure: all phases present", () => {

  test("WS-1: All 9 phases declared in meta block", () => {
    const metaBlock = sliceBetween(SHIP_JS, "export const meta", "// ── Structured");
    const expectedPhases = ["Goal", "Discovery", "Scope", "Implement", "Validate", "Commit", "Verify", "Ship", "Prove"];
    for (const p of expectedPhases) {
      expect(metaBlock).toContain(`title: '${p}'`);
    }
  });

  test("WS-2: All phases have phase() calls in body", () => {
    const phaseCalls = SHIP_JS.match(/phase\('(\w+)'\)/g) || [];
    const called = phaseCalls.map(p => p.match(/phase\('(\w+)'\)/)![1]);
    expect(called).toContain("Goal");
    expect(called).toContain("Discovery");
    expect(called).toContain("Scope");
    expect(called).toContain("Implement");
    expect(called).toContain("Validate");
    expect(called).toContain("Commit");
    expect(called).toContain("Verify");
    expect(called).toContain("Ship");
    expect(called).toContain("Prove");
  });
});

// ── Prove Integration ──────────────────────────────────────────
// Spec Step 4: PROVE uses make prove-up with prod data, Quinn on :7776

describe("prove-workflow: prove.js matches spec", () => {
  const PROVE_JS = readFileSync(join(HR, "workflows/prove.js"), "utf-8");

  test("PW-1: Prove container startup is config-driven", () => {
    expect(PROVE_JS).toContain("containerConfig");
    expect(PROVE_JS).toContain("proveUpCommand");
  });

  test("PW-2: Quinn told to test on prove container (config-driven URL), not dev server", () => {
    expect(PROVE_JS).toContain("PROVE CONTAINER");
    expect(PROVE_JS).toContain("NOT dev server");
  });

  test("PW-3: Prove container cleanup is config-driven", () => {
    expect(PROVE_JS).toContain("proveDownCommand");
  });

  test("PW-4: Quinn instructed to use customers with real contacts", () => {
    // Prove uses prod data — Quinn must test with real customers, not empty test accounts
    expect(PROVE_JS).toMatch(/customer.*contact|prod.*data|real.*customer/i);
  });
});

// ── Spec Sync Check ────────────────────────────────────────────
// Verify the spec itself contains the claims we're testing against

describe("spec-sync: HARNESS-SKILL-CHAIN.md contains required claims", () => {

  test("SS-1: Spec documents 3-layer verification", () => {
    expect(SPEC_MD).toContain("Layer 1");
    expect(SPEC_MD).toContain("Layer 2");
    expect(SPEC_MD).toContain("Layer 3");
  });

  test("SS-2: Spec documents Quinn local PASS before commit", () => {
    expect(SPEC_MD).toContain("Quinn local PASS before commit");
  });

  test("SS-3: Spec documents CI runs for Layer 2", () => {
    expect(SPEC_MD).toContain("CI runs");
    expect(SPEC_MD).toContain("Layer 2");
  });

  test("SS-4: Spec documents production-like environment for Layer 3 (post-merge)", () => {
    expect(SPEC_MD).toContain("production-like environment");
    expect(SPEC_MD).toContain("post-merge");
  });

  test("SS-5: Spec documents Rook security scan", () => {
    expect(SPEC_MD).toContain("Rook security scan");
  });

  test("SS-6: SKILL.MD ceremony table exists", () => {
    expect(SKILL_MD).toContain("LIGHT");
    expect(SKILL_MD).toContain("STANDARD");
    expect(SKILL_MD).toContain("THOROUGH");
    expect(SKILL_MD).toContain("Quinn");
    expect(SKILL_MD).toContain("Rook");
  });
});

// ── Harness Bug Fixes (#573-576) ────────────────────────────────

describe("harness-fixes: ship.js and ship-and-heal.js structural checks", () => {
  const HEAL_JS = readFileSync(join(HR, "workflows/ship-and-heal.js"), "utf-8");

  test("#573: ship.js has AC evidence pre-validation step after scope", () => {
    expect(SHIP_JS).toContain("ac-prevalidation");
    expect(SHIP_JS).toContain("evidence/threshold");
  });

  test("#573: pre-validation checks numeric vs string threshold types", () => {
    expect(SHIP_JS).toContain("parseFloat");
    expect(SHIP_JS).toContain("op:\"contains\"");
  });

  test("#574: GRADE phase runs before SHIP phase, not after PROVE", () => {
    const gradeIdx = SHIP_JS.indexOf("label: 'grade'");
    const shipPhaseIdx = SHIP_JS.indexOf("phase('Ship')");
    expect(gradeIdx).toBeGreaterThan(-1);
    expect(shipPhaseIdx).toBeGreaterThan(-1);
    expect(gradeIdx).toBeLessThan(shipPhaseIdx);
  });

  test("#574: no duplicate GRADE section after PROVE", () => {
    const gradeOccurrences = SHIP_JS.match(/label: 'grade'/g) || [];
    expect(gradeOccurrences.length).toBe(1);
  });

  test("#575: ship-and-heal RCA prompt includes generator fix guidance", () => {
    expect(HEAL_JS).toContain("generator fix");
    expect(HEAL_JS).toContain("ship.js");
  });

  test("#575: ship-and-heal fix prompt mentions both instance and generator fixes", () => {
    expect(HEAL_JS).toContain("instance");
    expect(HEAL_JS).toContain("generator");
  });

  test("#576: ship-and-heal has nesting fallback with try/catch", () => {
    expect(HEAL_JS).toContain("nesting");
    expect(HEAL_JS).toContain("ship-fallback");
  });

  test("run-gate.ts re-evaluates FAIL verdicts (stale verdict fix)", () => {
    const gateTS = readFileSync(join(HR, "gates/run-gate.ts"), "utf-8");
    expect(gateTS).toContain('ac.verdict !== "FAIL"');
  });
});
