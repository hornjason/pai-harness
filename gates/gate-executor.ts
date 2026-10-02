import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
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
import { harnessRoot } from "../lib/paths";
import { safeParseProjectHarness, type ProjectHarness } from "../lib/rungate-schema";
import {
  slugExists,
  shouldRebuildContainer,
  shouldRefreshScaffold,
  worktreeBranchName,
  checkPortCollision,
  trackPreExistingFailures,
  releaseLock,
  detectFileSetOverlap,
  sequentialMergeOrder,
  shouldRunCIVerification,
  requiresResearchEscalation,
} from "./ship-orchestrator";
import { prevalidateEvidence } from "../lib/evidence-prevalidator";
import { scanGaps, type GapScanResult } from "../lib/gap-scanner";
import { deepMerge } from "../lib/deep-merge";
import { createGitHubClient, getIssue, addLabels } from "../lib/github";
// ── Test output parser (moved here from run-gate.ts to break circular dep) ──

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

// ── Test baseline functions (#599) ───────────────────────────────────────

/**
 * Extract the failure count from bun test output.
 * Uses the last "N fail" line (bun may print intermediate summaries).
 */
export function extractTestFailureCount(testOutput: string): number {
  const failMatches = [...testOutput.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  if (failMatches.length === 0) return 0;
  return parseInt(failMatches[failMatches.length - 1][1]);
}

/**
 * Subtract test baseline from total failures to get new-only failure count.
 * Clamps to 0 — if baseline exceeds total (tests were fixed), result is 0.
 */
export function subtractTestBaseline(totalFailures: number, baseline: number): number {
  return Math.max(0, totalFailures - baseline);
}

/**
 * Capture test baseline by running the project test suite at scope time.
 * Returns the number of pre-existing test failures.
 */
function captureTestBaseline(state: Record<string, any>): number {
  const projectRoot = state.projectRoot || process.cwd();
  const harnessPath = join(projectRoot, ".claude", "rungate.json");
  if (!existsSync(harnessPath)) return 0;

  const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
  const testCmd = harness.test?.command;
  if (!testCmd) return 0;

  const timeout = harness.test?.timeout || 300000;
  console.log(`Test baseline: running "${testCmd}" to capture pre-existing failures...`);

  try {
    const output = execSync(`${testCmd} 2>&1`, {
      encoding: "utf-8",
      timeout,
      cwd: projectRoot,
    });
    return extractTestFailureCount(output);
  } catch (e: any) {
    const stdout = e.stdout || "";
    return extractTestFailureCount(stdout);
  }
}

// ── Gate executor contract interfaces (SC-373, SC-376) ───────────────────

export interface GateExecutorInput {
  gate: string;
  slug: string;
  issue: number;
  workDir: string;
  stateFilePath: string;
}

export interface GateExecutorResult {
  resultVal: "PASS" | "FAIL";
  passes: number;
  fails: number;
  warns: number;
  results: GateResult[];
  attempt: number;
  exitCode: number;
}

// ── State + harness loading ──────────────────────────────────────────────

function loadAndValidateHarness(projectRoot: string): ProjectHarness | null {
  const projectHarnessPath = projectRoot
    ? join(projectRoot, ".claude", "rungate.json")
    : "";
  if (projectHarnessPath && existsSync(projectHarnessPath)) {
    const rawHarness = JSON.parse(readFileSync(projectHarnessPath, "utf-8"));
    const result = safeParseProjectHarness(rawHarness);
    if (!result.success) {
      console.warn(`WARN: rungate.json schema validation failed:`);
      for (const err of result.error.issues) {
        console.warn(`  - ${err.path.join(".")}: ${err.message}`);
      }
      return null;
    }
    return result.data;
  }
  return null;
}

function autoPopulateACs(state: Record<string, any>, sf: string): void {
  let acUpdated = false;
  for (let i = 0; i < (state.acs || []).length; i++) {
    const ac = state.acs[i];
    if (ac.verdict && ac.verdict !== "PENDING" && ac.verdict !== "FAIL") continue;
    const cmd = ac.evidenceMethod?.command;
    if (!cmd) continue;
    try {
      const evidenceCwd = process.env.EVIDENCE_CWD || state.projectRoot || process.cwd();
      const isTestRunner = /bun test\b/.test(cmd);
      const cmdTimeout = isTestRunner ? 300000 : 10000;
      const output = execSync(cmd, { encoding: "utf-8", timeout: cmdTimeout, cwd: evidenceCwd }).trim();
      const lastLine = output.split("\n").pop() || "";
      let verdict: "PASS" | "FAIL" = "FAIL";
      if (isTestRunner) {
        verdict = "PASS";
      }
      const { op, value } = ac.threshold || {};
      if (!isTestRunner && op && value !== undefined) {
        const num = parseFloat(lastLine);
        const exp = parseFloat(String(value));
        switch (op) {
          case "==": verdict = lastLine === String(value) || (!isNaN(num) && num === exp) ? "PASS" : "FAIL"; break;
          case "!=": verdict = lastLine !== String(value) ? "PASS" : "FAIL"; break;
          case ">=": verdict = !isNaN(num) && num >= exp ? "PASS" : "FAIL"; break;
          case "<=": verdict = !isNaN(num) && num <= exp ? "PASS" : "FAIL"; break;
          case ">": verdict = !isNaN(num) && num > exp ? "PASS" : "FAIL"; break;
          case "<": verdict = !isNaN(num) && num < exp ? "PASS" : "FAIL"; break;
          case "contains": verdict = output.includes(String(value)) ? "PASS" : "FAIL"; break;
        }
      }
      state.acs[i].verdict = verdict;
      state.acs[i].evidence = { type: "command-output", content: lastLine };
      acUpdated = true;
    } catch (e: any) {
      // grep returns exit 1 on zero matches — valid result, not an error
      const stderr = e.stderr?.toString?.() || "";
      const stdout = (e.stdout?.toString?.() || "").trim();
      if (stdout !== "" || e.status === 1) {
        const lastLine = stdout.split("\n").pop() || "0";
        let verdict: "PASS" | "FAIL" = "FAIL";
        const { op, value } = ac.threshold || {};
        if (op && value !== undefined) {
          const num = parseFloat(lastLine);
          const exp = parseFloat(String(value));
          switch (op) {
            case "==": verdict = lastLine === String(value) || (!isNaN(num) && num === exp) ? "PASS" : "FAIL"; break;
            case "!=": verdict = lastLine !== String(value) ? "PASS" : "FAIL"; break;
            case ">=": verdict = !isNaN(num) && num >= exp ? "PASS" : "FAIL"; break;
            case "<=": verdict = !isNaN(num) && num <= exp ? "PASS" : "FAIL"; break;
            case ">": verdict = !isNaN(num) && num > exp ? "PASS" : "FAIL"; break;
            case "<": verdict = !isNaN(num) && num < exp ? "PASS" : "FAIL"; break;
            case "contains": verdict = stdout.includes(String(value)) ? "PASS" : "FAIL"; break;
          }
        }
        state.acs[i].verdict = verdict;
        state.acs[i].evidence = { type: "command-output", content: lastLine };
        acUpdated = true;
      } else {
        console.warn(`WARN: AC ${ac.id} evidence command failed: ${e.message?.slice(0, 100) || 'unknown'}`);
      }
    }
  }
  // #513 SC-A1: ACs without evidenceMethod.command get SKIP, not generic output
  const skipped = markCommandlessACsAsSkip(sf);
  if (skipped > 0) {
    const refreshed = JSON.parse(readFileSync(sf, "utf-8"));
    Object.assign(state, refreshed);
  } else if (acUpdated) {
    writeFileSync(sf, JSON.stringify(state, null, 2));
  }
}

// ── Verify-gate early checks ────────────────────────────────────────────

function checkVerifyPendingACs(state: Record<string, any>): { results: GateResult[]; failCount: number } {
  const results: GateResult[] = [];
  let failCount = 0;
  const pendingCodeACs = (state.acs || []).filter(
    (ac: any) => ac.type !== "OUTCOME" && (!ac.verdict || ac.verdict === "PENDING")
  );
  if (pendingCodeACs.length > 0) {
    for (const ac of pendingCodeACs) {
      failCount++;
      results.push({
        check: `verify-ac-evidence-gap: ${ac.id} still PENDING after auto-populate`,
        result: "FAIL" as const,
        detail: `${ac.id} evidence command may be broken or matching 0 tests — check evidenceMethod.command: ${ac.evidenceMethod?.command || "(none)"}`,
      });
    }
    console.log(`Verify AC evidence gap: ${pendingCodeACs.length} CODE AC(s) still PENDING — ${pendingCodeACs.map((ac: any) => ac.id).join(", ")}`);
  }
  return { results, failCount };
}

// ── Prove reproducer (B3) ───────────────────────────────────────────────

async function runProveReproducer(state: Record<string, any>, issue: number, issueRepo: string, workDir: string): Promise<void> {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") {
    console.log("prove gate: LIGHT tier — skipping reproducer (API check only)");
    return;
  }

  let issueBody = "";
  let issueTitle = "";
  if (issue && issueRepo) {
    try {
      const github = createGitHubClient();
      const issueData = await getIssue(github, issueRepo, issue);
      issueBody = issueData.body || "";
      issueTitle = issueData.title || "";
      console.log(`prove gate: read issue #${issue} from GitHub (${issueTitle.slice(0, 60)})`);
    } catch (e: any) {
      console.error(`prove gate: FAIL — could not read issue from GitHub: ${e.message?.slice(0, 200)}`);
      process.exit(1);
    }
  } else {
    console.error("prove gate: FAIL — issue number and repo required for prove");
    process.exit(1);
  }

  const projectRoot = state.projectRoot || "";
  const harnessPath = join(projectRoot, ".claude", "rungate.json");
  let apiBase = "";
  let uiBase = "";
  let devStart = "";
  if (existsSync(harnessPath)) {
    const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
    apiBase = harness.dev?.apiBase || "";
    uiBase = harness.dev?.uiBase || "";
    devStart = harness.dev?.start || "";
  }

  if (apiBase) {
    try {
      execSync(`curl -sf ${apiBase}/api/admin/health`, { timeout: 10000, encoding: "utf-8" });
      console.log(`prove gate: health check PASS (${apiBase})`);
    } catch {
      console.error(`prove gate: FAIL — dev server not responding at ${apiBase}`);
      if (devStart) console.error(`Start it with: ${devStart}`);
      process.exit(1);
    }
  }

  // Prod health check — WARN only
  const prodApiBase = (() => {
    if (existsSync(harnessPath)) {
      const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
      return harness.prod?.apiBase || "";
    }
    return "";
  })();
  if (prodApiBase) {
    try {
      execSync(`curl -sf ${prodApiBase}/api/admin/health`, { timeout: 10000, encoding: "utf-8" });
      console.log(`prove gate: prod health check PASS (${prodApiBase})`);
    } catch {
      console.warn(`WARN: prove gate — prod server not responding at ${prodApiBase} (STANDARD+ requires prod evidence)`);
    }
  }

  const proveInput = {
    issueBody, issueTitle, issueNumber: issue,
    acs: state.acs || [], apiBase, uiBase,
    beforeState: state.beforeState || null, projectRoot,
  };
  const proveInputPath = join(workDir, "prove-input.json");
  writeFileSync(proveInputPath, JSON.stringify(proveInput, null, 2));

  const proveProjectPrompt = join(__dirname, "prompts", "prove-reproducer.md");
  const proveHomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "prove-reproducer.md");
  const provePromptPath = existsSync(proveProjectPrompt) ? proveProjectPrompt : proveHomePrompt;
  if (existsSync(provePromptPath)) {
    console.log("B3: Spawning Prove Reproducer (Sonnet)...");
    let reproducerOutput = "";
    try {
      reproducerOutput = execSync(
        `cat '${proveInputPath}' | claude -p - --model sonnet --system-prompt-file "${provePromptPath}" --output-format text --allowedTools "Bash,Read" --max-turns 10`,
        { encoding: "utf-8", timeout: 180000, cwd: harnessRoot() }
      );
    } catch (e: any) {
      reproducerOutput = e.stdout || "";
      console.warn(`WARN: B3 reproducer process exited with error: ${e.message?.slice(0, 200)}`);
    }

    const jsonMatch = reproducerOutput.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const proveEvidence = {
          issueNumber: issue, verdict: parsed.verdict || "INCONCLUSIVE",
          commitSHA: execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: projectRoot || undefined }).trim(),
          capturedAt: new Date().toISOString(),
          criteriaResults: parsed.criteriaResults || [],
          reproduced: parsed.reproduced ?? false,
          evidence: parsed.evidence || [],
          source: "B3-prove-reproducer",
        };
        writeFileSync(join(workDir, "prove-evidence.json"), JSON.stringify(proveEvidence, null, 2));
        console.log(`B3: prove-evidence.json written — verdict: ${proveEvidence.verdict}`);
      } catch {
        console.warn("WARN: B3 reproducer JSON parse failed");
      }
    } else {
      console.warn("WARN: B3 reproducer produced no parseable JSON — prove.test.ts will generate evidence");
    }
  }
}

// ── Scope pre-flight checks ─────────────────────────────────────────────

function runScopePreflights(state: Record<string, any>): void {
  // Duplicate slug check (SC-44)
  const existingSlug = slugExists(state.issue);
  if (existingSlug && existingSlug !== state.slug) {
    console.warn(`WARN: Issue #${state.issue} already has slug "${existingSlug}" — current slug is "${state.slug}"`);
  }

  // Container rebuild check (SC-7)
  const canRebuild = shouldRebuildContainer(state.projectRoot || process.cwd());
  if (!canRebuild) {
    console.log("Container rebuild: SKIP (prod.rebuild is null)");
  }

  // Worktree branch naming (SC-136)
  if (state.worktree) {
    const branch = worktreeBranchName(state.issue, state.slug);
    console.log(`Worktree branch: ${branch}`);
    if (state.worktree?.activePorts) {
      const collision = checkPortCollision(state.worktree.basePort || 3000, state.worktree.offset || 0, state.worktree.activePorts);
      if (collision) console.error(`WARN: Port collision detected for offset ${state.worktree.offset}`);
    }
  }

  // File-set overlap detection (SC-69)
  if (state.parallelFiles && state.briefFiles) {
    const overlap = detectFileSetOverlap(state.parallelFiles, state.briefFiles);
    if (overlap.length > 0) {
      console.error(`WARN: File overlap with parallel issue: ${overlap.join(", ")}`);
    }
  }

  // Spec-compliance check
  try {
    execSync(`bun scripts/sync-spec-tests.ts 2>&1`, { encoding: "utf-8", timeout: 10000, cwd: harnessRoot() });
  } catch { /* sync script failure is non-blocking */ }

  try {
    const complianceOutput = execSync(
      `bun test test/spec-compliance.test.ts test/spec-compliance-auto.test.ts 2>&1`,
      { encoding: "utf-8", timeout: 30000, cwd: harnessRoot() }
    );
    const complianceFails = complianceOutput.match(/(\d+)\s+fail/);
    if (complianceFails && parseInt(complianceFails[1]) > 0) {
      console.error(`SPEC DRIFT DETECTED: ship.js has diverged from HARNESS-SKILL-CHAIN.md`);
      console.error(`Run: bun test test/spec-compliance.test.ts — to see which claims drifted`);
      console.error(complianceOutput.split("\n").filter(l => l.includes("(fail)")).join("\n"));
    } else {
      const compliancePasses = complianceOutput.match(/(\d+)\s+pass/);
      console.log(`Spec compliance: ${compliancePasses ? compliancePasses[1] : '?'} checks PASS — ship.js matches spec`);
    }
  } catch (e: any) {
    const out = e.stdout || "";
    console.error(`SPEC DRIFT DETECTED: spec-compliance tests failed`);
    console.error(out.split("\n").filter((l: string) => l.includes("(fail)")).join("\n"));
  }

  // Capture test baseline — pre-existing failures (#599)
  const testBaseline = captureTestBaseline(state);
  state.gateContract = state.gateContract || {};
  state.gateContract.baselines = state.gateContract.baselines || {};
  state.gateContract.baselines.testBaseline = testBaseline;
  if (testBaseline > 0) {
    console.log(`Test baseline: ${testBaseline} pre-existing failure(s) captured — will be subtracted at verify`);
  } else {
    console.log(`Test baseline: 0 pre-existing failures — clean suite`);
  }

  // Track pre-existing failures (SC-33)
  if (state.preExistingFailures?.length > 0) {
    trackPreExistingFailures(state.slug, state.preExistingFailures);
  }

  // Evidence command pre-validation (#598) — dry-run AC evidence commands
  // to catch broken commands BEFORE Marcus runs
  if (state.acs?.length > 0) {
    const projectRoot = state.projectRoot || process.cwd();
    prevalidateEvidence(state.acs, projectRoot).then((prevalidationResults) => {
      const broken = prevalidationResults.filter((r) => r.status === "broken");
      const empty = prevalidationResults.filter((r) => r.status === "empty");
      const autoFixed = prevalidationResults.filter((r) => r.autoFixed);

      if (broken.length > 0) {
        console.error(`EVIDENCE PRE-VALIDATION: ${broken.length} AC(s) have broken evidence commands:`);
        for (const r of broken) {
          console.error(`  - ${r.id}: ${r.diagnostic}`);
        }
      }
      if (empty.length > 0) {
        console.warn(`EVIDENCE PRE-VALIDATION: ${empty.length} AC(s) have evidence commands that return empty output:`);
        for (const r of empty) {
          console.warn(`  - ${r.id}: command runs but produces no output`);
        }
      }
      if (autoFixed.length > 0) {
        console.log(`EVIDENCE PRE-VALIDATION: ${autoFixed.length} AC(s) auto-fixed: ${autoFixed.map((r) => r.id).join(", ")}`);
      }
      if (broken.length === 0 && empty.length === 0) {
        console.log(`EVIDENCE PRE-VALIDATION: all ${prevalidationResults.filter((r) => r.status === "ok").length} evidence commands validated OK`);
      }
    }).catch((e) => {
      console.warn(`WARN: Evidence pre-validation failed: ${e.message?.slice(0, 100) || "unknown"}`);
    });
  }
}

// ── Verify pre-flight checks ────────────────────────────────────────────

function runVerifyPreflights(state: Record<string, any>): void {
  // Blast radius check (SC-59, SC-60)
  if (state.blastRadius) {
    const { filesRead = 0, filesChanged = 0 } = state.blastRadius;
    if (filesRead < filesChanged) {
      console.error(`WARN: Blast radius — read ${filesRead} files but changed ${filesChanged} (read should be >= changed)`);
    }
    const readWriteRatio = filesRead / Math.max(filesChanged, 1);
    if (readWriteRatio < 3) {
      console.error(`WARN: Read/write ratio ${readWriteRatio.toFixed(1)} (target >= 3:1)`);
    }
  }

  // Fix-on-find check (SC-109)
  if (state.foundIssues) {
    const dropped = (state.foundIssues || []).filter((i: any) => !i.disposition);
    if (dropped.length > 0) {
      console.error(`FAIL: ${dropped.length} found issues silently dropped — must be fixed, filed, or scoped out`);
    }
  }

  // Files changed outside brief scope (SC-134)
  if (state.filesChangedOutsideBrief?.length > 0) {
    console.error(`WARN: Files changed outside brief: ${state.filesChangedOutsideBrief.join(", ")}`);
  }

  // Scaffold refresh check (SC-38)
  if (shouldRefreshScaffold(state.slug)) {
    console.log("Post-verify: scaffold refresh recommended (verify gate PASS)");
  }

  // Research escalation check (SC-112)
  if (requiresResearchEscalation(state.slug)) {
    console.log("Research escalation: iteration 2+ — research tool invocation required before next attempt");
  }
}

// ── Type check ──────────────────────────────────────────────────────────

function runTypeCheck(state: Record<string, any>): void {
  const harnessPath = join(state.projectRoot || process.cwd(), ".claude", "rungate.json");
  const harnessConfig = existsSync(harnessPath) ? JSON.parse(readFileSync(harnessPath, "utf-8")) : null;
  const typeCheckCmd = state.dev?.typeCheck || harnessConfig?.dev?.typeCheck;
  if (typeCheckCmd) {
    try {
      execSync(typeCheckCmd, { encoding: "utf-8", timeout: 30000, cwd: state.projectRoot || process.cwd() });
      console.log(`Type check PASS: ${typeCheckCmd}`);
    } catch (e: any) {
      console.error(`Type check FAIL: ${typeCheckCmd}`);
      console.error((e.stdout || "").split("\n").slice(0, 10).join("\n"));
    }
  }
}

// ── Test execution ──────────────────────────────────────────────────────

function runGateTests(gate: string, workDir: string, state: Record<string, any>): { testOutput: string; testExitCode: number } {
  let testOutput: string;
  let testExitCode = 0;
  try {
    testOutput = execSync(
      `bun test gates/ --test-name-pattern "${gate === 'scope' ? 'schema|scope' : gate === 'verify' ? 'schema|scope|verify|B1|B2' : gate === 'ship' ? 'schema|scope|verify|ship|B1|B2' : gate === 'prove' ? 'prove' : '.*'}" 2>&1`,
      {
        encoding: "utf-8",
        timeout: 120000,
        cwd: harnessRoot(),
        env: { ...process.env, TEST_WORK_DIR: workDir, GATE: gate, PROJECT_ROOT: state.projectRoot || process.cwd() },
      },
    );
  } catch (e: any) {
    testOutput = e.stdout || "";
    testExitCode = e.status || 1;
  }
  return { testOutput, testExitCode };
}

// ── Result parsing ──────────────────────────────────────────────────────

function parseGateResults(testOutput: string, earlyResults: GateResult[], earlyFails: number): { passes: number; fails: number; warns: number; results: GateResult[] } {
  let passes = 0;
  let fails = 0;
  const warns = 0;
  const results: GateResult[] = [];

  const allPassMatches = [...testOutput.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
  const allFailMatches = [...testOutput.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
  const passMatch = allPassMatches.length > 0 ? allPassMatches[allPassMatches.length - 1] : null;
  const failMatch = allFailMatches.length > 0 ? allFailMatches[allFailMatches.length - 1] : null;
  if (passMatch) passes = parseInt(passMatch[1]);
  if (failMatch) fails = parseInt(failMatch[1]);

  results.push(...parseTestResults(testOutput));

  if (earlyResults.length > 0) {
    results.push(...earlyResults);
    fails += earlyFails;
  }

  if (results.length === earlyResults.length) {
    if (fails > 0) {
      results.push({ check: "test-suite", result: "FAIL", detail: `${fails} tests failed` });
    } else {
      results.push({ check: "test-suite", result: "PASS", detail: `${passes} tests passed` });
    }
  }

  return { passes, fails, warns, results };
}

// ── Conformity findings ─────────────────────────────────────────────────

function readConformityFindings(state: Record<string, any>): void {
  const projectRoot = state.projectRoot || process.cwd();
  const findingsPath = join(projectRoot, ".rungate", "conformity-findings.json");
  if (existsSync(findingsPath)) {
    try {
      const findings = JSON.parse(readFileSync(findingsPath, "utf-8"));
      if (findings.total > 0) {
        console.log(`\n── CONFORMITY FINDINGS (${findingsPath}) ──`);
        if (findings.findings?.length > 0) {
          console.log(`  Issues: ${findings.failures} FAIL, ${findings.warnings} WARN`);
          for (const f of findings.findings) {
            console.log(`  ${f.severity}: ${f.file} — ${f.message}`);
            if (f.fixCommand) console.log(`    Fix: ${f.fixCommand}`);
          }
        }
        if (findings.constraintCandidates?.length > 0) {
          console.log(`  Constraint candidates: ${findings.candidateCount} pending review`);
          for (const c of findings.constraintCandidates) {
            console.log(`    "${c.rule}" (${c.source})`);
          }
        }
        if (findings.staleness?.length > 0) {
          console.log(`  Stale docs: ${findings.staleCount}`);
          for (const s of findings.staleness) {
            console.log(`    ${s.file} — ${s.daysSince}d old (${s.type} threshold: ${s.threshold}d)`);
          }
        }
        console.log(`──────────────────────────────────────────`);
      }
      if (!state.conformityFindings) {
        state.conformityFindings = findings;
      }
    } catch {}
  }
}

// ── Batch diagnosis ─────────────────────────────────────────────────────

function printBatchDiagnosis(fails: number, results: GateResult[]): void {
  if (fails > 0) {
    const failResults = results.filter(r => r.result === "FAIL");
    const infra = failResults.filter(r => /B1|B2|B3|adversary|reproducer|health|port/.test(r.check));
    const acRelated = failResults.filter(r => /evidence|verdict|AC|ac[- ]|threshold/.test(r.check));
    const chain = failResults.filter(r => /hash|chain|pushed|merge|spec-trace/.test(r.check));
    const other = failResults.filter(r => !infra.includes(r) && !acRelated.includes(r) && !chain.includes(r));

    console.log(`\nBATCH DIAGNOSIS: ${failResults.length} failures — fix all before re-running`);
    if (infra.length) console.log(`  Infrastructure (${infra.length}): ${infra.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (acRelated.length) console.log(`  AC/Evidence (${acRelated.length}): ${acRelated.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (chain.length) console.log(`  Chain integrity (${chain.length}): ${chain.map(r => r.check.split(" > ").pop()).join(", ")}`);
    if (other.length) console.log(`  Other (${other.length}): ${other.map(r => r.check.split(" > ").pop()).join(", ")}`);
  }
}

// ── B1/B2 agent logic ───────────────────────────────────────────────────

function spawnB1AdversaryAtScope(state: Record<string, any>, workDir: string): void {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return;

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const promptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(promptPath)) {
    console.warn("WARN: ac-adversary.md prompt not found — adversary will not run");
    return;
  }

  const reportPath = join(workDir, "adversary-report.json");
  try { unlinkSync(reportPath); } catch {}
  const acInputFile = join(workDir, "adversary-input.json");
  writeFileSync(acInputFile, JSON.stringify(state.acs || [], null, 2));
  const { spawn } = require("child_process");
  const child = spawn("sh", ["-c",
    `claude -p "$(cat '${acInputFile}')" --model haiku --system-prompt-file "${promptPath}" --output-format json --allowedTools "" --max-turns 3 > "${reportPath}.tmp" 2>/dev/null && mv "${reportPath}.tmp" "${reportPath}"`
  ], { detached: true, stdio: "ignore", cwd: harnessRoot() });
  child.unref();
  console.log("B1: AC Adversary spawned in background — verify gate will check result");
}

function checkDevServerLiveness(state: Record<string, any>, results: GateResult[]): number {
  let addedFails = 0;
  const hasOutcomeACs = (state.acs || []).some((ac: any) => ac.type === "OUTCOME");
  if (hasOutcomeACs && state.projectRoot) {
    const harnessPath = join(state.projectRoot, ".claude", "rungate.json");
    if (existsSync(harnessPath)) {
      const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
      const apiBase = harness?.dev?.apiBase;
      if (apiBase) {
        try {
          execSync(`curl -sf ${apiBase}/api/admin/health`, { timeout: 5000, encoding: "utf-8" });
          console.log(`Dev server liveness: ${apiBase} — UP`);
        } catch {
          addedFails++;
          results.push({ check: "dev-server-liveness: OUTCOME ACs require running dev server", result: "FAIL" as const, detail: `${apiBase} not responding — run '${harness?.dev?.start || "make dev-all"}' first` });
          console.log(`Dev server liveness: ${apiBase} — DOWN. Start with: ${harness?.dev?.start || "make dev-all"}`);
        }
      }
    }
  }
  return addedFails;
}

function checkB1ReportAtVerify(state: Record<string, any>, workDir: string, results: GateResult[]): { fails: number; warns: number } {
  let addedFails = 0;
  let addedWarns = 0;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return { fails: 0, warns: 0 };

  const reportPath = join(workDir, "adversary-report.json");
  if (!existsSync(reportPath)) {
    addedFails++;
    results.push({ check: "B1-adversary: report missing", result: "FAIL" as const, detail: "adversary-report.json not found — adversary may still be running or failed. Re-run verify." });
    console.log("B1: adversary report not yet available — verify FAIL");
  } else {
    try {
      const raw = readFileSync(reportPath, "utf-8");
      const jsonMatch = raw.match(/\{[\s\S]*"gameable"[\s\S]*\}/);
      if (jsonMatch) {
        const report = JSON.parse(jsonMatch[0]);
        console.log(`B1: Adversary report — gameable: ${report.gameable}, approved: ${report.approved}`);
        if (report.gameable > 0) {
          let outcomeCount = 0;
          for (const exploit of report.exploits || []) {
            const ac = (state.acs || []).find((a: any) => a.id === exploit.acId);
            const isOutcome = ac?.type === "OUTCOME";
            if (isOutcome) {
              addedFails++;
              outcomeCount++;
              results.push({ check: `B1-adversary: ${exploit.acId} gameable (OUTCOME)`, result: "FAIL" as const, detail: exploit.exploit });
            } else {
              addedWarns++;
              results.push({ check: `B1-adversary: ${exploit.acId} gameable`, result: "WARN" as const, detail: exploit.exploit });
            }
          }
          if (outcomeCount > 0) console.log(`B1: ${outcomeCount} OUTCOME AC(s) gameable — FAIL (need behavioral evidence)`);
          const codeCount = (report.gameable || 0) - outcomeCount;
          if (codeCount > 0) console.log(`B1: ${codeCount} CODE AC(s) gameable — WARN`);
        }
      } else {
        console.warn("WARN: B1 adversary report has no parseable JSON — treating as incomplete");
      }
    } catch (e: any) {
      console.warn(`WARN: B1 report read failed: ${e.message?.slice(0, 200)}`);
    }
  }
  return { fails: addedFails, warns: addedWarns };
}

function runB2EvidenceValidation(state: Record<string, any>): void {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return;

  const scopeSha = state.gates?.scope?.commitSha;
  const fixSha = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();

  if (!scopeSha || !state.projectRoot) return;

  console.log("B2: Running evidence commands in clean worktree...");
  const tmpWorktree = join("/tmp", `pai-evidence-${Date.now()}`);

  try {
    execSync(`git worktree add "${tmpWorktree}" ${fixSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });

    const verdicts: any[] = [];
    for (const ac of state.acs || []) {
      if (!ac.evidenceMethod?.command) continue;
      const cmd = ac.evidenceMethod.command;

      let fixOutput = "";
      try {
        fixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: tmpWorktree }).trim();
      } catch (e: any) {
        fixOutput = (e.stdout || "").trim() || `ERROR: ${e.message?.slice(0, 100)}`;
      }

      let preFixOutput = "";
      const scopeWorktree = join("/tmp", `pai-metamorphic-${Date.now()}`);
      try {
        execSync(`git worktree add "${scopeWorktree}" ${scopeSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });
        preFixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: scopeWorktree }).trim();
      } catch {
        preFixOutput = "METAMORPHIC_SKIP";
      } finally {
        try { execSync(`git worktree remove "${scopeWorktree}" --force`, { cwd: state.projectRoot }); } catch {}
      }

      const actual = parseFloat(fixOutput) || 0;
      const expected = parseFloat(ac.threshold?.value || "0");
      const op = ac.threshold?.op || ">=";
      let passes = false;
      if (op === ">=") passes = !isNaN(actual) && actual >= expected;
      else if (op === "==") passes = fixOutput === String(ac.threshold?.value) || (!isNaN(actual) && actual === expected);
      else if (op === "!=") passes = fixOutput !== String(ac.threshold?.value);
      else if (op === ">") passes = !isNaN(actual) && actual > expected;
      else if (op === "<=") passes = !isNaN(actual) && actual <= expected;
      else if (op === "<") passes = !isNaN(actual) && actual < expected;
      else if (op === "contains") passes = fixOutput.includes(String(ac.threshold?.value || ""));
      else if (op === "exists") passes = fixOutput.length > 0;

      if (fixOutput === preFixOutput && preFixOutput !== "METAMORPHIC_SKIP") {
        console.warn(`WARN: metamorphic — ${ac.id} evidence identical pre/post fix (trivially satisfiable)`);
      }

      verdicts.push({
        acId: ac.id, command: cmd, rawOutput: fixOutput,
        threshold: ac.threshold, actual: fixOutput,
        verdict: passes ? "PASS" : "FAIL",
        metamorphic: fixOutput === preFixOutput ? "IDENTICAL" : "DIFFERENT",
      });
    }

    for (const v of verdicts) {
      const ac = (state.acs || []).find((a: any) => a.id === v.acId);
      if (ac) {
        ac.verdict = v.verdict;
        ac.evidence = { type: "command-output", content: v.rawOutput };
      }
    }

    console.log(`B2: ${verdicts.filter(v => v.verdict === "PASS").length}/${verdicts.length} evidence commands PASS`);
  } catch (e: any) {
    console.warn(`WARN: B2 worktree setup failed: ${e.message?.slice(0, 200)}`);
  } finally {
    try { execSync(`git worktree remove "${tmpWorktree}" --force`, { cwd: state.projectRoot }); } catch {}
  }
}

function runB2EvidenceValidatorAgent(state: Record<string, any>, workDir: string, results: GateResult[]): { agentResult: any; warns: number } {
  let addedWarns = 0;
  let agentResult: any = null;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return { agentResult, warns: 0 };

  const b2ProjectPrompt = join(__dirname, "prompts", "evidence-validator.md");
  const b2HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "evidence-validator.md");
  const b2PromptPath = existsSync(b2ProjectPrompt) ? b2ProjectPrompt : b2HomePrompt;
  if (!existsSync(b2PromptPath)) {
    console.warn("WARN: evidence-validator.md prompt not found — B2 agent will not run");
    return { agentResult, warns: 0 };
  }

  console.log("B2: Spawning Evidence Validator agent...");
  const b2Input = JSON.stringify({
    acs: (state.acs || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
      evidenceMethod: ac.evidenceMethod,
    })),
  }, null, 2);
  const b2InputPath = join(workDir, "b2-input.json");
  writeFileSync(b2InputPath, b2Input);

  let b2Output = "";
  try {
    b2Output = execSync(
      `cat '${b2InputPath}' | claude -p - --model haiku --system-prompt-file "${b2PromptPath}" --output-format text --allowedTools "" --max-turns 3`,
      { encoding: "utf-8", timeout: 60000, cwd: harnessRoot() },
    );
  } catch (e: any) {
    b2Output = e.stdout || "";
    console.warn(`WARN: B2 Evidence Validator exited with error: ${e.message?.slice(0, 200)}`);
  }

  const b2Json = b2Output.match(/\{[\s\S]*"verdicts"[\s\S]*\}/);
  if (b2Json) {
    try {
      const b2Report = JSON.parse(b2Json[0]);
      agentResult = {
        ts: new Date().toISOString(),
        verdicts: b2Report.verdicts || [],
        source: "B2-evidence-validator-agent",
      };
      const b2Fails = (b2Report.verdicts || []).filter((v: any) => v.verdict === "FAIL");
      if (b2Fails.length > 0) {
        for (const v of b2Fails) {
          addedWarns++;
          results.push({ check: `B2-validator: ${v.acId} evidence gap`, result: "WARN" as const, detail: v.rawOutput || "threshold not met" });
        }
        console.log(`B2: ${b2Fails.length} evidence gap(s) found — WARN`);
      } else {
        console.log(`B2: All evidence validated — ${(b2Report.verdicts || []).length} ACs checked`);
      }
    } catch {
      console.warn("WARN: B2 Evidence Validator JSON parse failed");
    }
  } else {
    console.warn("WARN: B2 Evidence Validator produced no parseable JSON");
  }

  return { agentResult, warns: addedWarns };
}

function runB1AdversaryAtVerify(state: Record<string, any>, workDir: string, results: GateResult[]): { agentResult: any; warns: number } {
  let addedWarns = 0;
  let agentResult: any = null;
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") return { agentResult, warns: 0 };

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const b1PromptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(b1PromptPath)) return { agentResult, warns: 0 };

  console.log("B1: Spawning AC Adversary agent at verify...");
  const b1Input = JSON.stringify({
    acs: (state.acs || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
      evidenceMethod: ac.evidenceMethod,
    })),
  }, null, 2);
  const b1InputPath = join(workDir, "b1-verify-input.json");
  writeFileSync(b1InputPath, b1Input);

  let b1Output = "";
  try {
    b1Output = execSync(
      `cat '${b1InputPath}' | claude -p - --model haiku --system-prompt-file "${b1PromptPath}" --output-format text --allowedTools "" --max-turns 3`,
      { encoding: "utf-8", timeout: 60000, cwd: harnessRoot() },
    );
  } catch (e: any) {
    b1Output = e.stdout || "";
    console.warn(`WARN: B1 AC Adversary exited with error: ${e.message?.slice(0, 200)}`);
  }

  const b1Json = b1Output.match(/\{[\s\S]*"gameable"[\s\S]*\}/);
  if (b1Json) {
    try {
      const b1Report = JSON.parse(b1Json[0]);
      agentResult = {
        ts: new Date().toISOString(),
        gameable: b1Report.gameable || 0,
        approved: b1Report.approved ?? true,
        exploits: b1Report.exploits || [],
        source: "B1-adversary-verify-agent",
      };
      if (b1Report.gameable > 0) {
        for (const exploit of b1Report.exploits || []) {
          addedWarns++;
          results.push({ check: `B1-adversary-verify: ${exploit.acId} gameable`, result: "WARN" as const, detail: exploit.exploit });
        }
        console.log(`B1: ${b1Report.gameable} gameable AC(s) found at verify — WARN`);
      } else {
        console.log(`B1: All ACs approved at verify — no exploits found`);
      }
    } catch {
      console.warn("WARN: B1 AC Adversary JSON parse failed");
    }
  } else {
    console.warn("WARN: B1 AC Adversary produced no parseable JSON");
  }

  return { agentResult, warns: addedWarns };
}

// ── Ship post-processing ────────────────────────────────────────────────

function runShipPreflights(state: Record<string, any>): void {
  releaseLock(state.slug);
  if (state.mergeQueue) {
    const ordered = sequentialMergeOrder(state.mergeQueue);
    const next = ordered[0];
    if (next && shouldRunCIVerification(next)) {
      console.log(`Next in merge queue: ${next.slug} (CI verification required)`);
    }
  }
}

// ── Merge gate ──────────────────────────────────────────────────────────

function runMergeGate(state: Record<string, any>, sf: string): never {
  const marcusBranch = state.agents?.marcus?.branch;
  const scopeSha = state.gates?.scope?.commitSha;

  let diffBase: string;
  if (marcusBranch && marcusBranch !== "main") {
    diffBase = `main...${marcusBranch}`;
  } else if (scopeSha) {
    diffBase = `${scopeSha}...HEAD`;
  } else {
    console.log("merge gate: no branch or scope SHA — skipping diff checks");
    const { resultVal, attempt } = writeGateResult(sf, "merge", 1, 0, 0, [], state.projectRoot);
    console.log(`Gate merge: ${resultVal} (attempt ${attempt})`);
    process.exit(0);
  }

  let mergePass = 0;
  let mergeFail = 0;
  const mergeResults: any[] = [];

  const deletedResult = execSync(`git diff ${diffBase} --diff-filter=D --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const deletedTests = deletedResult.split("\n").filter(f => /\.test\.(ts|tsx)$/.test(f));
  if (deletedTests.length > 0) {
    mergeFail++;
    mergeResults.push({ check: "merge: no test file deletions", result: "FAIL", detail: deletedTests.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: no test file deletions", result: "PASS" });
  }

  const changedResult = execSync(`git diff ${diffBase} --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const gateHookChanges = changedResult.split("\n").filter(f => /^(gates|hooks)\//.test(f));
  const issueTargetsGates = (state.issueGoal || "").toLowerCase().includes("gate");
  if (gateHookChanges.length > 0 && !issueTargetsGates) {
    mergeResults.push({ check: "merge: gate/hook modifications", result: "WARN", detail: gateHookChanges.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: gate/hook modifications", result: "PASS" });
  }

  const statResult = execSync(`git diff ${diffBase} --shortstat`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const insertions = parseInt((statResult.match(/(\d+) insertion/) || ["0","0"])[1]);
  const size = state.sizing?.predicted || "M";
  if ((size === "XS" && insertions > 200) || (size === "S" && insertions > 500)) {
    mergeResults.push({ check: "merge: scope proportionality", result: "WARN", detail: `${insertions} insertions for ${size} issue` });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: scope proportionality", result: "PASS" });
  }

  const { resultVal: mergeResultVal, attempt: mergeAttempt } = writeGateResult(sf, "merge", mergePass, mergeFail, 0, mergeResults, state.projectRoot);
  console.log(`Gate merge: ${mergeResultVal} (attempt ${mergeAttempt})`);
  process.exit(mergeResultVal === "PASS" ? 0 : 1);
}

// ── Prove gate post-processing ──────────────────────────────────────────

async function runProvePostProcessing(state: Record<string, any>, workDir: string, issue: number, issueRepo: string, resultVal: string): Promise<never> {
  const proveEvidencePath = join(workDir, "prove-evidence.json");
  if (existsSync(proveEvidencePath)) {
    try {
      const proveEvidence = JSON.parse(readFileSync(proveEvidencePath, "utf-8"));
      if (proveEvidence.verdict === "PROVEN" && issue && issueRepo) {
        try {
          // Use Octokit addLabels (POST additive — D-5) instead of gh CLI
          const github = createGitHubClient();
          await addLabels(github, issueRepo, issue, ["proven"]);
          console.log(`prove gate: added "proven" label to #${issue}`);
        } catch (e: any) {
          console.warn(`WARN: prove gate — failed to add proven label: ${e.message?.slice(0, 200)}`);
        }
      }
    } catch {
      // prove-evidence.json parse failure — already warned earlier
    }
  }
  process.exit(resultVal === "PASS" ? 0 : 1);
  throw new Error("unreachable");
}

// ── Ceremony override support ───────────────────────────────────────────

const PROTECTED_CHECKS = [
  "tests-pass",
  "tsc-pass",
  "code-committed",
  "all-acs-have-evidence",
  "all-acs-pass",
  "branch-merged",
  "code-pushed",
];

/**
 * Apply ceremony overrides from rungate.json and ensure protected checks are present.
 * Returns path to the modified ceremony profile (written to temp location).
 */
export function applyCeremonyOverrides(
  baseCeremonyPath: string,
  harnessConfig: ProjectHarness | null,
  projectRoot: string
): string {
  if (!existsSync(baseCeremonyPath)) {
    return baseCeremonyPath;
  }

  const baseProfile = JSON.parse(readFileSync(baseCeremonyPath, "utf-8"));

  // No overrides? Use base profile as-is
  if (!harnessConfig?.ceremonyOverrides) {
    return baseCeremonyPath;
  }

  // Deep merge overrides into base tiers
  const mergedProfile = { ...baseProfile };
  mergedProfile.tiers = deepMerge(baseProfile.tiers || {}, harnessConfig.ceremonyOverrides);

  // Validate protected checks are present in all tiers
  for (const [tierName, tierConfig] of Object.entries(mergedProfile.tiers)) {
    const checks = (tierConfig as any)?.checks;
    if (!checks || typeof checks !== "object") continue;

    for (const [gateName, checkList] of Object.entries(checks)) {
      if (!Array.isArray(checkList)) continue;

      // Find which protected checks apply to this gate
      const gateProtectedChecks = PROTECTED_CHECKS.filter(pc => {
        // tests-pass, tsc-pass, code-committed, all-acs-* belong to verify gate
        if (gateName === "verify" && ["tests-pass", "tsc-pass", "code-committed", "all-acs-have-evidence", "all-acs-pass"].includes(pc)) {
          return true;
        }
        // branch-merged, code-pushed belong to ship gate
        if (gateName === "ship" && ["branch-merged", "code-pushed"].includes(pc)) {
          return true;
        }
        return false;
      });

      // Re-add any missing protected checks
      const missing = gateProtectedChecks.filter(pc => !checkList.includes(pc));
      if (missing.length > 0) {
        console.warn(`WARN: Protected checks re-added to ${tierName}.${gateName}: ${missing.join(", ")}`);
        (checks as any)[gateName] = [...checkList, ...missing];
      }
    }
  }

  // Write merged profile to temp location
  const tempDir = join(projectRoot, ".rungate");
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  const tempProfilePath = join(tempDir, "ceremony-profile-merged.json");
  writeFileSync(tempProfilePath, JSON.stringify(mergedProfile, null, 2));

  return tempProfilePath;
}

// ── Main executor ───────────────────────────────────────────────────────

export async function executeGate(input: GateExecutorInput): Promise<GateExecutorResult> {
  const { gate, slug, issue, workDir, stateFilePath: sf } = input;

  const baseCeremonyProfile = existsSync(join(__dirname, "ceremony-profiles.json"))
    ? join(__dirname, "ceremony-profiles.json")
    : join(process.env.HOME || "", ".claude", "skills", "ship", "ceremony-profiles.json");

  const state = JSON.parse(readFileSync(sf, "utf-8"));
  const issueRepo = state.issueRepo || state.repo || "";

  // Validate rungate.json (SC-6)
  const harnessConfig = loadAndValidateHarness(state.projectRoot || "");

  // Apply ceremony overrides from rungate.json
  const CEREMONY_PROFILE = applyCeremonyOverrides(
    baseCeremonyProfile,
    harnessConfig,
    state.projectRoot || process.cwd()
  );

  // Auto-populate AC verdicts
  autoPopulateACs(state, sf);

  // Gaps gate: WARN-only mechanical drift detection
  if (gate === "gaps") {
    const projectRoot = state.projectRoot || process.cwd();
    const gapResults = scanGaps(projectRoot, workDir);

    console.log("\n── GAP SCANNER ──");
    console.log(`Drift checks: ${gapResults.warnings} WARN, ${gapResults.passes} PASS\n`);

    const results: GateResult[] = [];
    for (const gapResult of gapResults.results) {
      // Map SKIP to PASS for GateResult (which only supports PASS|FAIL|WARN)
      const mappedStatus = gapResult.status === "SKIP" ? "PASS" : gapResult.status;
      results.push({
        check: gapResult.check,
        result: mappedStatus,
        detail: gapResult.detail,
      });
      console.log(`${gapResult.status}: ${gapResult.check} — ${gapResult.detail}`);
    }

    // Gaps gate is WARN-only: never fails, never blocks ship
    const { resultVal, attempt } = writeGateResult(sf, "gaps", gapResults.passes, 0, gapResults.warnings, results, projectRoot);
    console.log(`\nGate gaps: ${resultVal} (attempt ${attempt}) — informational only, does not block ship`);

    return {
      resultVal: "PASS" as const,
      passes: gapResults.passes,
      fails: 0,
      warns: gapResults.warnings,
      results,
      attempt,
      exitCode: 0,
    };
  }

  // Early results accumulator
  let earlyResults: GateResult[] = [];
  let earlyFails = 0;

  // Verify gate: check for PENDING ACs
  if (gate === "verify") {
    const pending = checkVerifyPendingACs(state);
    earlyResults = pending.results;
    earlyFails = pending.failCount;
  }

  // B3: Prove Reproducer
  if (gate === "prove") {
    await runProveReproducer(state, issue, issueRepo, workDir);
  }

  // Scope pre-flight checks
  if (gate === "scope") {
    runScopePreflights(state);
  }

  // Type check (scope or verify)
  if (gate === "scope" || gate === "verify") {
    runTypeCheck(state);
  }

  // Verify pre-flight checks
  if (gate === "verify") {
    runVerifyPreflights(state);
  }

  // Ship pre-flight checks
  if (gate === "ship") {
    runShipPreflights(state);
  }

  // Set phase for gate tests
  const GATE_PHASE_MAP: Record<string, string> = { scope: "SCOPE", verify: "VERIFY", ship: "SHIP", prove: "DONE" };
  const gatePhase = GATE_PHASE_MAP[gate];
  if (gatePhase && state.phase !== gatePhase) {
    const priorPhase = state.phase;
    state.phase = gatePhase;
    writeFileSync(sf, JSON.stringify(state, null, 2));
    console.log(`Phase set to ${gatePhase} for gate tests (was ${priorPhase})`);
  }

  // Run tests
  const { testOutput, testExitCode } = runGateTests(gate, workDir, state);

  // Parse results
  let { passes, fails, warns, results } = parseGateResults(testOutput, earlyResults, earlyFails);

  // Subtract test baseline at verify gate (#599) — pre-existing failures don't block
  if (gate === "verify") {
    const testBaseline = state.gateContract?.baselines?.testBaseline ?? 0;
    if (testBaseline > 0) {
      const originalFails = fails;
      fails = subtractTestBaseline(fails, testBaseline);
      console.log(`Test baseline subtraction: ${originalFails} total - ${testBaseline} baseline = ${fails} new failure(s)`);
    }
  }

  console.log(`\nTest results: ${passes} pass, ${fails} fail, ${warns} warn`);

  // Conformity findings
  readConformityFindings(state);

  // Batch diagnosis
  printBatchDiagnosis(fails, results);

  // B1/B2 agent logic
  let b2AgentResult: any = null;
  let b1VerifyAgentResult: any = null;

  if (gate === "scope" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    spawnB1AdversaryAtScope(state, workDir);
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0) {
    fails += checkDevServerLiveness(state, results);
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    const b1Report = checkB1ReportAtVerify(state, workDir, results);
    fails += b1Report.fails;
    warns += b1Report.warns;
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    runB2EvidenceValidation(state);
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    const b2 = runB2EvidenceValidatorAgent(state, workDir, results);
    b2AgentResult = b2.agentResult;
    warns += b2.warns;
  }

  if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
    const b1 = runB1AdversaryAtVerify(state, workDir, results);
    b1VerifyAgentResult = b1.agentResult;
    warns += b1.warns;
  }

  // Write gate result
  const { resultVal, attempt } = writeGateResult(sf, gate, passes, fails, warns, results, state.projectRoot);
  console.log(`Gate ${gate}: ${resultVal} (attempt ${attempt})`);

  // Persist B1/B2 agent results
  if (gate === "verify" && (b2AgentResult || b1VerifyAgentResult)) {
    const freshState = JSON.parse(readFileSync(sf, "utf-8"));
    freshState.gates = freshState.gates || {};
    freshState.gates.verify = freshState.gates.verify || {};
    if (b2AgentResult) {
      freshState.gates.verify.evidenceValidator = b2AgentResult;
    }
    if (b1VerifyAgentResult) {
      freshState.gates.verify.adversary = b1VerifyAgentResult;
    }
    if (state.conformityFindings) {
      freshState.conformityFindings = state.conformityFindings;
    }
    writeFileSync(sf, JSON.stringify(freshState, null, 2));
  }

  // Write tamper-evident witness
  try {
    const witnessPath = writeWitness(slug, gate, resultVal, testOutput, issue, state.projectRoot);
    console.log(`Witness: ${witnessPath}`);
  } catch (e: any) {
    console.error(`Witness write failed: ${e.message}`);
  }

  // Gate-specific post-processing (merge and prove exit directly)
  if (gate === "merge") {
    runMergeGate(state, sf);
  }

  if (gate === "prove") {
    await runProvePostProcessing(state, workDir, issue, issueRepo, resultVal);
  }

  // Ship-specific: HMAC + evidence
  if (gate === "ship" && resultVal === "PASS") {
    const hash = generateHmac(sf, slug, issue, state.projectRoot);
    console.log(`HMAC: ${hash}`);
    const evidencePath = generateShipEvidence(sf, workDir, issue, issueRepo, passes, fails, warns);
    console.log(`Ship evidence: ${evidencePath}`);
  }

  // Verify-specific: convergence
  if (gate === "verify" && resultVal === "FAIL" && existsSync(CEREMONY_PROFILE)) {
    const convergenceResult = runConvergence(sf, gate, resultVal, CEREMONY_PROFILE);
    if (convergenceResult.action === "circuit-break") {
      console.log(`CIRCUIT BREAK — iteration ${convergenceResult.iteration}`);
      return { resultVal, passes, fails, warns, results, attempt, exitCode: 2 };
    } else if (convergenceResult.action === "stall") {
      console.log(`STALL DETECTED — same failures, iteration ${convergenceResult.iteration}`);
    } else if (convergenceResult.action === "loop-back") {
      console.log(`LOOP-BACK — iteration ${convergenceResult.iteration}`);
    }
  }

  // Gate summary
  const sessionId = process.env.SESSION_ID || "unknown";
  const summaryResult = writeGateSummary(gate, passes, fails, warns, results, issue, slug, sessionId);
  const exitCode = summaryResult === "BLOCKED" ? 1 : 0;

  return { resultVal, passes, fails, warns, results, attempt, exitCode };
}
