import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { join, relative } from "path";
import { harnessRoot } from "../lib/paths";
import { measureEvidencePrevalidation, prevalidateEvidence } from "../lib/evidence-prevalidator";

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

  test("CHAIN-1: Quinn local gates on ceremonyTier, not hasUIChanges", () => {
    // Spec Layer 1: "Quinn validates on local dev"
    // Ceremony table: STANDARD = Quinn, THOROUGH = Quinn + Rook
    // Quinn local MUST NOT gate on file extensions — backend fixes with UI impact need Quinn too
    const validateSection = sliceBetween(SHIP_JS, "PHASE 5: VALIDATE", "PHASE 6: COMMIT");
    expect(validateSection).not.toContain("if (hasUIChanges)");
    expect(validateSection).toContain("ceremonyTier !== 'LIGHT'");
  });

  test("CHAIN-2: Container Quinn gates on ceremonyTier, not hasUIChanges", () => {
    // Spec Layer 2: "make test-up → Quinn validates on container"
    // Must gate on ceremonyTier !== 'LIGHT', not file type checks
    const verifySection = sliceBetween(SHIP_JS, "PHASE 7: VERIFY", "PHASE 8: SHIP");
    expect(verifySection).toContain("ceremonyTier !== 'LIGHT'");
    expect(verifySection).not.toContain("hasUIChanges");
  });

  test("CHAIN-3: Rook gates on ceremonyTier", () => {
    // Ceremony table: THOROUGH = Quinn + Rook parallel
    // Spec line 94 says "STANDARD+ tiers" — conflict with ceremony table
    // Code follows ceremony table (THOROUGH only) — this test documents current behavior
    const verifySection = sliceBetween(SHIP_JS, "PHASE 7: VERIFY", "PHASE 8: SHIP");
    expect(verifySection).toMatch(/ceremonyTier.*===.*'THOROUGH'/);
  });

  test("CHAIN-4: LIGHT tier skips scope gate", () => {
    // SKILL.md: "LIGHT tier: scope gate is skipped"
    expect(SHIP_JS).toMatch(/skipScope\s*=\s*discovery\.ceremonyTier\s*===\s*'LIGHT'/);
  });

  test("CHAIN-5: LIGHT tier gets simplified log when Quinn skipped", () => {
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
    // The commit step used to inline a `bun -e` one-liner that named
    // `environments.local.api` and friends literally. #166 moved the write
    // into scripts/record-build-commit.ts, because an instruction an agent
    // can skip without the reply changing is not a step — so the evidence is
    // now in two places and BOTH are asserted. Checking only the call site
    // would pass while the script recorded nothing; checking only the script
    // would pass while the workflow stopped calling it.
    const commitSection = sliceBetween(SHIP_JS, "PHASE 6: COMMIT", "PHASE 7: VERIFY");
    expect(commitSection).toContain("record-build-commit.ts");
    expect(commitSection).toContain("--quinn");
    // #176: `--api` and `--ui` are NOT asserted here any more — their absence
    // is. They were `projectConfig.apiUrl ? 'PASS' : 'SKIP'` and
    // `hasUI ? 'PASS' : 'SKIP'`, which is the config file talking, not a
    // measurement, and it overwrote Quinn's. Same reversal `tests` got in
    // #173, and for the same reason.
    expect(
      commitSection.match(/--(api|ui)\b/g) || [],
      "the commit step is reporting an environment verdict it did not measure",
    ).toEqual([]);

    const recorder = readFileSync(
      join(import.meta.dir, "..", "scripts", "record-build-commit.ts"),
      "utf-8",
    );
    expect(recorder).toContain("local: {");
    expect(recorder).toContain("buildLocalEnvironment");
    // `tests` is NOT in that list any more (#173). It was the literal string
    // "PASS" written by a script that runs no tests, over the top of whatever
    // the Verify phase measured — so this asserts its absence, not its
    // presence. The `tests-pass` check in gates/workflow.test.ts reads this
    // field, which is what made the constant load-bearing.
    expect(
      recorder.match(/tests:\s*['"]PASS['"]/g) || [],
      "the recorder is inventing a test verdict again",
    ).toEqual([]);
  });

  test("ER-1a: the recorder actually writes environments.local", () => {
    // The executing half of ER-1 — a grep over the recorder stays true after
    // its body is emptied. test/record-build-commit.test.ts owns the full
    // matrix; this is the one assertion that keeps ER-1 from being three
    // string searches.
    const dir = mkdtempSync(join(tmpdir(), "er1-"));
    try {
      const state = join(dir, "workflow-state.json");
      // The suite result is already in the file, measured by the Verify phase.
      // #173: the recorder used to replace `environments.local` wholesale and
      // set tests to a constant PASS, so this fixture carries a FAIL — the
      // value the old code destroyed.
      writeFileSync(state, JSON.stringify({
        schemaVersion: 2, issue: 166, slug: "er-1", phase: "BUILD",
        issueGoal: "environment evidence is recorded after the commit",
        acs: [{
          id: "AC-1", type: "CODE",
          statement: "environments.local is present after the commit step runs",
          threshold: { op: "==", value: 0, unit: "exit code" },
          evidenceMethod: { type: "BUN_TEST" },
        }],
        environments: { local: { tests: "FAIL" } },
      }));
      const r = spawnSync("bun", [
        join(import.meta.dir, "..", "scripts", "record-build-commit.ts"),
        "--state", state,
        "--sha", "dd242a62aea9371d788abb58f3d26922d5dd6cbc",
        "--branch", "ship-166", "--quinn", "SKIP", "--api", "PASS", "--ui", "SKIP",
        "--ui-skip-reason", "No UI configured",
      ], { encoding: "utf-8" });
      expect(r.status, r.stderr ?? "").toBe(0);
      const written = JSON.parse(readFileSync(state, "utf-8"));
      // A caller that measured both still gets both recorded (#176); what
      // changed is that ship.js no longer claims to have measured them.
      expect(written.environments.local).toEqual({
        api: "PASS", ui: "SKIP", uiSkipReason: "No UI configured", tests: "FAIL",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(discoveryPrompt).toContain("Start from the issue SCs");
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

  test("gate-executor.ts re-evaluates FAIL verdicts (stale verdict fix)", () => {
    const gateTS = readFileSync(join(HR, "gates/gate-executor.ts"), "utf-8");
    expect(gateTS).toContain('ac.verdict !== "FAIL"');
  });

  test("gate-executor.ts handles grep exit code 1 (zero matches) as valid evidence", () => {
    const gateTS = readFileSync(join(HR, "gates/gate-executor.ts"), "utf-8");
    // grep returns exit 1 on zero matches — must capture stdout, not discard as error
    expect(gateTS).toContain("e.status === 1");
    expect(gateTS).toContain("e.stdout");
  });
});

// ── #589: ship-and-heal grading, classification, and remediation ─────
describe("#589: ship-and-heal grading and violation handling", () => {
  const HEAL_JS = readFileSync(join(HR, "workflows/ship-and-heal.js"), "utf-8");

  test("AC-1: GRADE section appears before any SHIPPED return", () => {
    const gradeLine = HEAL_JS.indexOf("GRADE");
    const shippedLine = HEAL_JS.indexOf("'SHIPPED'");
    expect(gradeLine).toBeGreaterThan(-1);
    expect(shippedLine).toBeGreaterThan(-1);
    expect(gradeLine).toBeLessThan(shippedLine);
  });

  test("AC-2: quality violations trigger remediation in a worktree", () => {
    expect(HEAL_JS).toContain("qualityViolations.length > 0");
    expect(HEAL_JS).toContain("label: 'remediate'");
    expect(HEAL_JS).toContain("isolation: 'worktree'");
  });

  test("AC-3: remediation prompt loads the violated role brief template", () => {
    // The remediation section (label: 'remediate') must reference brief templates
    const remediateIdx = HEAL_JS.indexOf("label: 'remediate'");
    // Find the agent prompt string that precedes the remediate label
    const remediatePromptStart = HEAL_JS.lastIndexOf("await agent(`", remediateIdx);
    const remediateSection = HEAL_JS.substring(remediatePromptStart, remediateIdx);
    expect(remediateSection).toContain("templates/agent-briefs/");
    expect(remediateSection).toMatch(/Read.*brief.*template|brief.*template/i);
  });

  test("AC-4: process violations trigger test-brief verification after healing", () => {
    expect(HEAL_JS).toContain("test-brief");
    expect(HEAL_JS).toMatch(/verify.*brief|brief.*verif/i);
  });

  test("AC-5: compliance threshold reads from rungate.json with default 80", () => {
    // Must read compliance.threshold from rungate.json config, not just parsedArgs
    expect(HEAL_JS).toMatch(/rungate\.json.*compliance.*threshold|compliance\.threshold.*rungate/i);
    // Default of 80 when not configured
    expect(HEAL_JS).toContain("|| 80");
  });

  test("AC-6: clean success returns SHIPPED with healed:false and gradeResult", () => {
    expect(HEAL_JS).toContain("status: 'SHIPPED'");
    expect(HEAL_JS).toContain("healed: false");
    expect(HEAL_JS).toContain("gradeResult");
  });
});

// ── One AC-evidence pre-validation implementation (#235) ────────
//
// These replace the two #573 tests that pinned a prompt-based pre-validation
// INTO workflows/ship.js:
//
//   #573: ship.js has AC evidence pre-validation step after scope
//   #573: pre-validation checks numeric vs string threshold types
//
// The claim they guarded — the pipeline dry-runs AC evidence commands before
// Marcus runs, and notices output a threshold cannot evaluate — is still
// covered. What changed is WHERE it is asserted: against the one
// implementation that actually executes, lib/evidence-prevalidator.ts, instead
// of against prompt text that only runs if a model chooses to follow it. Two
// implementations of the same check is worse than one, because the prompt
// copy could silently disagree with the code copy and nothing would notice.

describe("prevalidation-singleton: exactly one AC-evidence pre-validation (#235)", () => {
  const PREVALIDATION_OWNER = "lib/evidence-prevalidator.ts";
  const SOURCE_DIRS = ["lib", "gates", "workflows", "scripts", "hooks"];

  // An implementation of this check takes one of exactly two shapes, so the
  // detector is the union of two precise probes rather than one loose one:
  //
  //   CODE    — a function that dry-runs AC evidence commands. There is one,
  //             and its name is the capability: prevalidateEvidence.
  //   PROMPT  — agent instructions that tell a model to do it by hand. This is
  //             the shape that was deleted, and the shape most likely to come
  //             back, because a prompt is cheap to paste into a workflow.
  //
  // Neither probe is file-level "mentions evidence AND mentions dry-run": that
  // version flagged workflows/ship.js forever, because ship.js legitimately
  // normalises `ac.evidenceMethod.command` at Discovery and legitimately runs
  // evidence commands at Verify. A detector that cannot tell those from a
  // pre-check would have to be silenced to go green, and a silenced detector
  // is the decorative check .claude/rules/checks-must-be-able-to-fail.md is
  // about. The PROMPT probe looks at a 4-line window and additionally requires
  // an imperative "run them" instruction, which is what separates a prompt
  // that performs the check from a comment that points at where it lives.
  const DEFINES_CAPABILITY = /export\s+(?:async\s+)?function\s+prevalidateEvidence\b/;
  const EVIDENCE_REF = /evidenceMethod\s*\??\.\s*command|evidence commands?|AC evidence/i;
  const PRECHECK_INTENT = /pre-?validat|dry-?run|before Marcus/i;
  // IMPERATIVE ONLY. `dry-?run(?:ning|s)?` used to be admitted here, and the
  // inflected forms are the ones prose uses to DESCRIBE the check rather than
  // to perform it: gates/schema.ts:223 says "The scope gate dry-runs every AC's
  // evidence command before Marcus runs", and that sentence alone was enough to
  // report the schema module as a second pre-validation implementation. That is
  // precisely the "comment that points at where it lives" this detector claims
  // two paragraphs above to be able to tell from a prompt that performs the
  // check — it could not, so the claim is narrowed to the bare imperative,
  // which is the only form an agent instruction takes. The boundary is asserted
  // below rather than left to this comment.
  const RUN_INSTRUCTION =
    /Run the command|Run each|Run every|Execute the command|Execute each|dry-?run\s+(?:the|every|each|all)/i;
  const PROMPT_WINDOW_LINES = 4;

  interface SourceFile {
    path: string;
    src: string;
  }

  function collectSources(root: string): SourceFile[] {
    const out: SourceFile[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return; // an optional directory (hooks/) may not exist
      }
      for (const entry of entries) {
        if (entry === "node_modules") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js)$/.test(entry) && !/\.test\.(ts|js)$/.test(entry)) {
          out.push({ path: relative(root, full), src: readFileSync(full, "utf-8") });
        }
      }
    };
    for (const dir of SOURCE_DIRS) walk(join(root, dir));
    return out;
  }

  /** Line numbers where instructions to dry-run AC evidence commands appear. */
  function prevalidationPromptLines(src: string): number[] {
    const lines = src.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + PROMPT_WINDOW_LINES).join("\n");
      if (EVIDENCE_REF.test(window) && PRECHECK_INTENT.test(window) && RUN_INSTRUCTION.test(window)) {
        hits.push(i + 1);
      }
    }
    return hits;
  }

  function prevalidationImplementations(files: SourceFile[]): string[] {
    return files
      .filter((f) => DEFINES_CAPABILITY.test(f.src) || prevalidationPromptLines(f.src).length > 0)
      .map((f) => f.path)
      .sort();
  }

  // Verbatim from the `ac-prevalidation` timedAgent prompt deleted from
  // workflows/ship.js in #235. The mutation test below feeds this back in as a
  // synthetic second implementation; if the detector stopped recognising it,
  // the singleton assertion above would be passing because it looks at
  // nothing, which is the failure mode this file exists to rule out.
  const REINTRODUCED_SECOND_IMPLEMENTATION = `
const preflightResult = await timedAgent(\`
AC pre-validation (evidence/threshold type checking):
Read \${WORK_DIR}/workflow-state.json. For each AC with evidenceMethod.command:
  Run the command (timeout 10s, allow non-zero exit). Check if threshold can evaluate output:
  - Numeric ops (>=, <=, ==, !=): output must be numeric (parseFloat succeeds)
  - String ops (op:"contains"): output must be non-empty string
Report: totalACs, validated, fixed, fixes array.
\`, { label: 'ac-prevalidation', phase: 'Scope' })
`;

  test("#235: exactly one pre-validation implementation exists, and it is lib/evidence-prevalidator.ts", () => {
    const found = prevalidationImplementations(collectSources(HR));
    expect(found).toEqual([PREVALIDATION_OWNER]);
  });

  test("#235: the singleton check goes red when a second implementation is reintroduced", () => {
    const real = collectSources(HR);
    const mutated = prevalidationImplementations([
      ...real,
      { path: "lib/second-prevalidator.ts", src: REINTRODUCED_SECOND_IMPLEMENTATION },
    ]);
    // The mutation is performed and observed here rather than asserted in
    // prose: the detector sees two, so the singleton test above is reporting
    // one because there IS one, not because it cannot see.
    expect(mutated).toEqual([PREVALIDATION_OWNER, "lib/second-prevalidator.ts"].sort());
  });

  test("#235: the prompt probe reads an imperative as an implementation and prose as prose", () => {
    // The narrowing above is the kind of change that makes a detector quieter,
    // so the line it was narrowed to is pinned here in both directions. Drop
    // the first assertion and the detector may be blind; drop the second and
    // every docblock in the repo becomes a second implementation again.
    const DESCRIPTIVE = "// The scope gate dry-runs every AC's evidence command before Marcus runs.";
    const IMPERATIVE = "Dry-run every AC evidence command before Marcus runs, as a pre-validation.";

    expect(prevalidationPromptLines(IMPERATIVE), "the probe stopped recognising an agent instruction").toEqual([1]);
    expect(prevalidationPromptLines(DESCRIPTIVE), "a sentence describing the check counts as performing it").toEqual([]);

    // And the verbatim prompt #235 deleted is still caught — the narrowing is
    // not allowed to buy its precision by losing the case it exists for.
    expect(prevalidationPromptLines(REINTRODUCED_SECOND_IMPLEMENTATION).length).toBeGreaterThan(0);
  });

  test("#235 (replaces #573 'ship.js has AC evidence pre-validation'): no agent prompt in ship.js dry-runs AC evidence commands", () => {
    expect(SHIP_JS).not.toContain("ac-prevalidation");
    expect(SHIP_JS).not.toContain("evidence/threshold");
    expect(prevalidationPromptLines(SHIP_JS)).toEqual([]);
  });

  test("#235 (replaces #573 'ship.js has AC evidence pre-validation'): the pipeline calls the one implementation at Scope", async () => {
    // The gate does not call `prevalidateEvidence` directly — it calls
    // `measureEvidencePrevalidation`, the three-verdict wrapper that turns a
    // throw into a recorded UNMEASURED instead of an unhandled rejection. So
    // the chain has two links, and asserting only the first would pass while
    // the wrapper quietly stopped delegating to anything.
    const executor = readFileSync(join(HR, "gates/gate-executor.ts"), "utf-8");
    expect(executor).toMatch(
      /import\s*\{[^}]*measureEvidencePrevalidation[^}]*\}\s*from\s*["'][^"']*evidence-prevalidator["']/,
    );
    // Awaited, not fired and forgotten — the orphaned `.then()` is the whole of
    // #235, and a call site that loses the `await` reintroduces it verbatim.
    expect(executor).toContain("await measureEvidencePrevalidation(state.acs");

    // The second link, executed rather than grepped: the wrapper is driven over
    // one command that cannot succeed and one that can, and the reading has to
    // carry what `prevalidateEvidence` classified. A wrapper that returned a
    // hardcoded PASS, or stopped calling the owner at all, fails here.
    const reading = await measureEvidencePrevalidation(
      [
        { id: "AC-broken", evidenceMethod: { command: "nonexistent-binary-xyzzy-235-singleton" }, threshold: { op: "==", value: 0 } },
        { id: "AC-ok", evidenceMethod: { command: "printf 'hello'" }, threshold: { op: "contains", value: "hello" } },
      ],
      HR,
    );
    expect(reading.verdict).toBe("FAIL");
    expect(reading.acs.find((a) => a.id === "AC-broken")?.status).toBe("broken");
    expect(reading.acs.find((a) => a.id === "AC-ok")?.status).toBe("ok");
  });

  test("#235 (replaces #573 'pre-validation checks numeric vs string threshold types'): pre-validation flags output no numeric threshold can evaluate", async () => {
    const results = await prevalidateEvidence(
      [
        { id: "AC-numeric", evidenceMethod: { command: "printf ''" }, threshold: { op: ">=", value: 1 } },
        { id: "AC-string", evidenceMethod: { command: "printf 'hello'" }, threshold: { op: "contains", value: "hello" } },
      ],
      HR,
    );
    // A `>=` threshold over empty output is the exact mismatch the deleted
    // prompt described in words; here it is produced and caught.
    expect(results.find((r) => r.id === "AC-numeric")?.status).toBe("empty");
    expect(results.find((r) => r.id === "AC-string")?.status).toBe("ok");
  });

  test("#235 (replaces #573 'pre-validation checks numeric vs string threshold types'): the threshold evaluator still handles numeric and string ops", () => {
    const executor = readFileSync(join(HR, "gates/gate-executor.ts"), "utf-8");
    expect(executor).toContain("parseFloat");
    expect(executor).toMatch(/case "contains":/);
  });
});
