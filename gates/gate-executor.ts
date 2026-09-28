/**
 * Gate executor — extracted orchestration logic from run-gate.ts (SC-376).
 * Contains the heavy gate execution functions that run-gate.ts delegates to.
 * Follows the deep module / thin consumer pattern established by orchestrator.ts.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { type GateResult, writeGateResult } from "./orchestrator";
import { harnessRoot } from "../lib/paths";
import {
  slugExists,
  shouldRebuildContainer,
  worktreeBranchName,
  checkPortCollision,
  trackPreExistingFailures,
  shouldRefreshScaffold,
  releaseLock,
  detectFileSetOverlap,
  sequentialMergeOrder,
  shouldRunCIVerification,
  requiresResearchEscalation,
} from "./ship-orchestrator";
import { parseTestResults } from "./run-gate";

// ── Gate contract interfaces (SC-373) ─────────────────────────────────────

export interface GateExecutorInput {
  gate: string;
  slug: string;
  issue: number;
  workDir: string;
  stateFilePath: string;
  projectRoot: string;
  issueRepo: string;
}

export interface GateExecutorResult {
  passes: number;
  fails: number;
  warns: number;
  results: GateResult[];
  testOutput: string;
}

// ── AC auto-population ────────────────────────────────────────────────────

export function populateACVerdicts(
  state: Record<string, unknown>,
  sf: string,
  evidenceCwd: string,
): boolean {
  let acUpdated = false;
  const acs = (state.acs as Array<Record<string, unknown>>) || [];
  for (let i = 0; i < acs.length; i++) {
    const ac = acs[i];
    if (ac.verdict && ac.verdict !== "PENDING" && ac.verdict !== "FAIL") continue;
    const em = ac.evidenceMethod as Record<string, unknown> | undefined;
    const cmd = em?.command as string | undefined;
    if (!cmd) continue;
    try {
      const isTestRunner = /bun test\b/.test(cmd);
      const cmdTimeout = isTestRunner ? 300000 : 10000;
      const output = execSync(cmd, { encoding: "utf-8", timeout: cmdTimeout, cwd: evidenceCwd }).trim();
      const lastLine = output.split("\n").pop() || "";
      let verdict: "PASS" | "FAIL" = "FAIL";
      if (isTestRunner) {
        verdict = "PASS";
      }
      const threshold = ac.threshold as Record<string, unknown> | undefined;
      const op = threshold?.op as string | undefined;
      const value = threshold?.value;
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
      acs[i].verdict = verdict;
      acs[i].evidence = { type: "command-output", content: lastLine };
      acUpdated = true;
    } catch (e: unknown) {
      const msg = (e as Error)?.message?.slice(0, 100) || "unknown";
      console.warn(`WARN: AC ${ac.id} evidence command failed: ${msg}`);
    }
  }
  if (acUpdated) {
    writeFileSync(sf, JSON.stringify(state, null, 2));
  }
  return acUpdated;
}

// ── Verify PENDING AC check ───────────────────────────────────────────────

export function checkVerifyPendingACs(
  state: Record<string, unknown>,
): { earlyResults: GateResult[]; earlyFails: number } {
  const earlyResults: GateResult[] = [];
  let earlyFails = 0;
  const acs = (state.acs as Array<Record<string, unknown>>) || [];
  const pendingCodeACs = acs.filter(
    (ac) => ac.type !== "OUTCOME" && (!ac.verdict || ac.verdict === "PENDING"),
  );
  if (pendingCodeACs.length > 0) {
    for (const ac of pendingCodeACs) {
      earlyFails++;
      const em = ac.evidenceMethod as Record<string, unknown> | undefined;
      earlyResults.push({
        check: `verify-ac-evidence-gap: ${ac.id} still PENDING after auto-populate`,
        result: "FAIL" as const,
        detail: `${ac.id} evidence command may be broken or matching 0 tests — check evidenceMethod.command: ${em?.command || "(none)"}`,
      });
    }
    console.log(`Verify AC evidence gap: ${pendingCodeACs.length} CODE AC(s) still PENDING — ${pendingCodeACs.map((ac) => ac.id).join(", ")}`);
  }
  return { earlyResults, earlyFails };
}

// ── Prove reproducer (B3) ─────────────────────────────────────────────────

export function runProveReproducer(
  state: Record<string, unknown>,
  issue: number,
  issueRepo: string,
  workDir: string,
): void {
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") {
    console.log("prove gate: LIGHT tier — skipping reproducer (API check only)");
    return;
  }

  let issueBody = "";
  let issueTitle = "";
  if (issue && issueRepo) {
    try {
      const ghOut = execSync(
        `gh issue view ${issue} --repo ${issueRepo} --json body,title`,
        { encoding: "utf-8", timeout: 15000 },
      );
      const parsed = JSON.parse(ghOut);
      issueBody = parsed.body || "";
      issueTitle = parsed.title || "";
      console.log(`prove gate: read issue #${issue} from GitHub (${issueTitle.slice(0, 60)})`);
    } catch (e: unknown) {
      console.error(`prove gate: FAIL — could not read issue from GitHub: ${(e as Error)?.message?.slice(0, 200)}`);
      process.exit(1);
    }
  } else {
    console.error("prove gate: FAIL — issue number and repo required for prove");
    process.exit(1);
  }

  const projectRoot = (state.projectRoot as string) || "";
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
    acs: (state.acs as unknown[]) || [], apiBase, uiBase,
    beforeState: (state as Record<string, unknown>).beforeState || null, projectRoot,
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
        { encoding: "utf-8", timeout: 180000, cwd: harnessRoot() },
      );
    } catch (e: unknown) {
      reproducerOutput = (e as { stdout?: string })?.stdout || "";
      console.warn(`WARN: B3 reproducer process exited with error: ${(e as Error)?.message?.slice(0, 200)}`);
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

// ── Scope pre-flight checks ───────────────────────────────────────────────

export function runScopePreflights(state: Record<string, unknown>): void {
  // Duplicate slug check (SC-44)
  const existingSlug = slugExists(state.issue as number);
  if (existingSlug && existingSlug !== state.slug) {
    console.warn(`WARN: Issue #${state.issue} already has slug "${existingSlug}" — current slug is "${state.slug}"`);
  }

  // Container rebuild check (SC-7)
  const canRebuild = shouldRebuildContainer((state.projectRoot as string) || process.cwd());
  if (!canRebuild) {
    console.log("Container rebuild: SKIP (prod.rebuild is null)");
  }

  // Worktree branch naming (SC-136)
  const worktree = state.worktree as Record<string, unknown> | undefined;
  if (worktree) {
    const branch = worktreeBranchName(state.issue as number, state.slug as string);
    console.log(`Worktree branch: ${branch}`);
    if (worktree.activePorts) {
      const collision = checkPortCollision(
        (worktree.basePort as number) || 3000,
        (worktree.offset as number) || 0,
        worktree.activePorts as number[],
      );
      if (collision) console.error(`WARN: Port collision detected for offset ${worktree.offset}`);
    }
  }

  // File-set overlap detection for parallel work (SC-69)
  if (state.parallelFiles && state.briefFiles) {
    const overlap = detectFileSetOverlap(state.parallelFiles as string[], state.briefFiles as string[]);
    if (overlap.length > 0) {
      console.error(`WARN: File overlap with parallel issue: ${overlap.join(", ")}`);
    }
  }

  // Spec-compliance check (runs at scope gate — catches spec<>code drift)
  try {
    execSync(`bun scripts/sync-spec-tests.ts 2>&1`, { encoding: "utf-8", timeout: 10000, cwd: harnessRoot() });
  } catch { /* sync script failure is non-blocking */ }

  try {
    const complianceOutput = execSync(
      `bun test test/spec-compliance.test.ts test/spec-compliance-auto.test.ts 2>&1`,
      { encoding: "utf-8", timeout: 30000, cwd: harnessRoot() },
    );
    const complianceFails = complianceOutput.match(/(\d+)\s+fail/);
    if (complianceFails && parseInt(complianceFails[1]) > 0) {
      console.error(`SPEC DRIFT DETECTED: ship.js has diverged from HARNESS-SKILL-CHAIN.md`);
      console.error(`Run: bun test test/spec-compliance.test.ts — to see which claims drifted`);
      console.error(complianceOutput.split("\n").filter((l: string) => l.includes("(fail)")).join("\n"));
    } else {
      const compliancePasses = complianceOutput.match(/(\d+)\s+pass/);
      console.log(`Spec compliance: ${compliancePasses ? compliancePasses[1] : "?"} checks PASS — ship.js matches spec`);
    }
  } catch (e: unknown) {
    const out = (e as { stdout?: string })?.stdout || "";
    console.error(`SPEC DRIFT DETECTED: spec-compliance tests failed`);
    console.error(out.split("\n").filter((l: string) => l.includes("(fail)")).join("\n"));
  }

  // Track pre-existing failures (SC-33)
  if ((state.preExistingFailures as string[] | undefined)?.length) {
    trackPreExistingFailures(state.slug as string, state.preExistingFailures as string[]);
  }
}

// ── Type check ────────────────────────────────────────────────────────────

export function runTypeCheck(state: Record<string, unknown>): void {
  const harnessPath = join((state.projectRoot as string) || process.cwd(), ".claude", "rungate.json");
  const harnessConfig = existsSync(harnessPath) ? JSON.parse(readFileSync(harnessPath, "utf-8")) : null;
  const dev = state.dev as Record<string, unknown> | undefined;
  const typeCheckCmd = (dev?.typeCheck as string) || harnessConfig?.dev?.typeCheck;
  if (typeCheckCmd) {
    try {
      execSync(typeCheckCmd, { encoding: "utf-8", timeout: 30000, cwd: (state.projectRoot as string) || process.cwd() });
      console.log(`Type check PASS: ${typeCheckCmd}`);
    } catch (e: unknown) {
      console.error(`Type check FAIL: ${typeCheckCmd}`);
      console.error(((e as { stdout?: string })?.stdout || "").split("\n").slice(0, 10).join("\n"));
    }
  }
}

// ── Verify-time checks ───────────────────────────────────────────────────

export function runVerifyChecks(state: Record<string, unknown>): void {
  // Blast radius check (SC-59, SC-60)
  const blastRadius = state.blastRadius as Record<string, number> | undefined;
  if (blastRadius) {
    const { filesRead = 0, filesChanged = 0 } = blastRadius;
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
    const dropped = ((state.foundIssues as Array<Record<string, unknown>>) || []).filter((i) => !i.disposition);
    if (dropped.length > 0) {
      console.error(`FAIL: ${dropped.length} found issues silently dropped — must be fixed, filed, or scoped out`);
    }
  }

  // Files changed outside brief scope (SC-134)
  const outsideBrief = state.filesChangedOutsideBrief as string[] | undefined;
  if (outsideBrief?.length) {
    console.error(`WARN: Files changed outside brief: ${outsideBrief.join(", ")}`);
  }

  // Scaffold refresh check (SC-38)
  if (shouldRefreshScaffold(state.slug as string)) {
    console.log("Post-verify: scaffold refresh recommended (verify gate PASS)");
  }

  // Research escalation check (SC-112)
  if (requiresResearchEscalation(state.slug as string)) {
    console.log("Research escalation: iteration 2+ — research tool invocation required before next attempt");
  }
}

// ── Test execution ────────────────────────────────────────────────────────

export function executeGateTests(
  gate: string,
  workDir: string,
  state: Record<string, unknown>,
): { testOutput: string; testExitCode: number } {
  let testOutput: string;
  let testExitCode = 0;
  try {
    testOutput = execSync(
      `bun test gates/ --test-name-pattern "${gate === "scope" ? "schema|scope" : gate === "verify" ? "schema|scope|verify|B1|B2" : gate === "ship" ? "schema|scope|verify|ship|B1|B2" : gate === "prove" ? "prove" : ".*"}" 2>&1`,
      {
        encoding: "utf-8",
        timeout: 120000,
        cwd: harnessRoot(),
        env: { ...process.env, TEST_WORK_DIR: workDir, GATE: gate, PROJECT_ROOT: (state.projectRoot as string) || process.cwd() },
      },
    );
  } catch (e: unknown) {
    testOutput = (e as { stdout?: string })?.stdout || "";
    testExitCode = (e as { status?: number })?.status || 1;
  }
  return { testOutput, testExitCode };
}

// ── Test result parsing ───────────────────────────────────────────────────

export function parseGateTestResults(
  testOutput: string,
  testExitCode: number,
  earlyResults: GateResult[],
  earlyFails: number,
): { passes: number; fails: number; warns: number; results: GateResult[] } {
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
    if (fails > 0 || testExitCode !== 0) {
      results.push({ check: "test-suite", result: "FAIL", detail: `${fails} tests failed` });
    } else {
      results.push({ check: "test-suite", result: "PASS", detail: `${passes} tests passed` });
    }
  }

  return { passes, fails, warns, results };
}

// ── Conformity findings ───────────────────────────────────────────────────

export function processConformityFindings(
  state: Record<string, unknown>,
  projectRoot: string,
): void {
  const findingsPath = join(projectRoot, ".rungate", "conformity-findings.json");
  if (!existsSync(findingsPath)) return;
  try {
    const findings = JSON.parse(readFileSync(findingsPath, "utf-8"));
    if (findings.total > 0) {
      console.log(`\n-- CONFORMITY FINDINGS (${findingsPath}) --`);
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
      console.log(`------------------------------------------`);
    }
    if (!state.conformityFindings) {
      state.conformityFindings = findings;
    }
  } catch { /* conformity read failure is non-blocking */ }
}

// ── Batch diagnosis ───────────────────────────────────────────────────────

export function logBatchDiagnosis(results: GateResult[], fails: number): void {
  if (fails <= 0) return;
  const failResults = results.filter((r) => r.result === "FAIL");
  const infra = failResults.filter((r) => /B1|B2|B3|adversary|reproducer|health|port/.test(r.check));
  const acRelated = failResults.filter((r) => /evidence|verdict|AC|ac[- ]|threshold/.test(r.check));
  const chain = failResults.filter((r) => /hash|chain|pushed|merge|spec-trace/.test(r.check));
  const other = failResults.filter((r) => !infra.includes(r) && !acRelated.includes(r) && !chain.includes(r));

  console.log(`\nBATCH DIAGNOSIS: ${failResults.length} failures — fix all before re-running`);
  if (infra.length) console.log(`  Infrastructure (${infra.length}): ${infra.map((r) => r.check.split(" > ").pop()).join(", ")}`);
  if (acRelated.length) console.log(`  AC/Evidence (${acRelated.length}): ${acRelated.map((r) => r.check.split(" > ").pop()).join(", ")}`);
  if (chain.length) console.log(`  Chain integrity (${chain.length}): ${chain.map((r) => r.check.split(" > ").pop()).join(", ")}`);
  if (other.length) console.log(`  Other (${other.length}): ${other.map((r) => r.check.split(" > ").pop()).join(", ")}`);
}

// ── B1: AC Adversary at scope ─────────────────────────────────────────────

export function spawnScopeAdversary(
  state: Record<string, unknown>,
  workDir: string,
): void {
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") return;

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const promptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(promptPath)) {
    console.warn("WARN: ac-adversary.md prompt not found — adversary will not run");
    return;
  }

  const reportPath = join(workDir, "adversary-report.json");
  try { unlinkSync(reportPath); } catch { /* ignore */ }
  const acInputFile = join(workDir, "adversary-input.json");
  writeFileSync(acInputFile, JSON.stringify((state.acs as unknown[]) || [], null, 2));

  const { spawn } = require("child_process");
  const child = spawn("sh", ["-c",
    `claude -p "$(cat '${acInputFile}')" --model haiku --system-prompt-file "${promptPath}" --output-format json --allowedTools "" --max-turns 3 > "${reportPath}.tmp" 2>/dev/null && mv "${reportPath}.tmp" "${reportPath}"`,
  ], { detached: true, stdio: "ignore", cwd: harnessRoot() });
  child.unref();
  console.log("B1: AC Adversary spawned in background — verify gate will check result");
}

// ── Dev server liveness check ─────────────────────────────────────────────

export function checkDevServerLiveness(
  state: Record<string, unknown>,
  results: GateResult[],
): { addedFails: number } {
  let addedFails = 0;
  const hasOutcomeACs = ((state.acs as Array<Record<string, unknown>>) || []).some((ac) => ac.type === "OUTCOME");
  if (!hasOutcomeACs || !state.projectRoot) return { addedFails };

  const harnessPath = join(state.projectRoot as string, ".claude", "rungate.json");
  if (!existsSync(harnessPath)) return { addedFails };

  const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
  const apiBase = harness?.dev?.apiBase;
  if (!apiBase) return { addedFails };

  try {
    execSync(`curl -sf ${apiBase}/api/admin/health`, { timeout: 5000, encoding: "utf-8" });
    console.log(`Dev server liveness: ${apiBase} — UP`);
  } catch {
    addedFails = 1;
    results.push({
      check: "dev-server-liveness: OUTCOME ACs require running dev server",
      result: "FAIL" as const,
      detail: `${apiBase} not responding — run '${harness?.dev?.start || "make dev-all"}' first`,
    });
    console.log(`Dev server liveness: ${apiBase} — DOWN. Start with: ${harness?.dev?.start || "make dev-all"}`);
  }
  return { addedFails };
}

// ── B1 report check at verify ─────────────────────────────────────────────

export function checkB1AdversaryReport(
  state: Record<string, unknown>,
  workDir: string,
  results: GateResult[],
): { addedFails: number; addedWarns: number } {
  let addedFails = 0;
  let addedWarns = 0;
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") return { addedFails, addedWarns };

  const reportPath = join(workDir, "adversary-report.json");
  if (!existsSync(reportPath)) {
    addedFails = 1;
    results.push({
      check: "B1-adversary: report missing",
      result: "FAIL" as const,
      detail: "adversary-report.json not found — adversary may still be running or failed. Re-run verify.",
    });
    console.log("B1: adversary report not yet available — verify FAIL");
    return { addedFails, addedWarns };
  }

  try {
    const raw = readFileSync(reportPath, "utf-8");
    const jsonMatch = raw.match(/\{[\s\S]*"gameable"[\s\S]*\}/);
    if (jsonMatch) {
      const report = JSON.parse(jsonMatch[0]);
      console.log(`B1: Adversary report — gameable: ${report.gameable}, approved: ${report.approved}`);
      if (report.gameable > 0) {
        let outcomeCount = 0;
        for (const exploit of report.exploits || []) {
          const ac = ((state.acs as Array<Record<string, unknown>>) || []).find((a) => a.id === exploit.acId);
          const isOutcome = ac?.type === "OUTCOME";
          if (isOutcome) {
            addedFails++;
            outcomeCount++;
            results.push({
              check: `B1-adversary: ${exploit.acId} gameable (OUTCOME)`,
              result: "FAIL" as const,
              detail: exploit.exploit,
            });
          } else {
            addedWarns++;
            results.push({
              check: `B1-adversary: ${exploit.acId} gameable`,
              result: "WARN" as const,
              detail: exploit.exploit,
            });
          }
        }
        if (outcomeCount > 0) console.log(`B1: ${outcomeCount} OUTCOME AC(s) gameable — FAIL (need behavioral evidence)`);
        const codeCount = (report.gameable || 0) - outcomeCount;
        if (codeCount > 0) console.log(`B1: ${codeCount} CODE AC(s) gameable — WARN`);
      }
    } else {
      console.warn("WARN: B1 adversary report has no parseable JSON — treating as incomplete");
    }
  } catch (e: unknown) {
    console.warn(`WARN: B1 report read failed: ${(e as Error)?.message?.slice(0, 200)}`);
  }
  return { addedFails, addedWarns };
}

// ── B2: Evidence Validator in worktree ────────────────────────────────────

export function runB2EvidenceValidation(
  state: Record<string, unknown>,
): void {
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") return;

  const scopeSha = (state.gates as Record<string, Record<string, unknown>>)?.scope?.commitSha as string;
  const projectRoot = state.projectRoot as string;
  if (!scopeSha || !projectRoot) return;

  const fixSha = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: projectRoot }).trim();
  console.log("B2: Running evidence commands in clean worktree...");
  const tmpWorktree = join("/tmp", `pai-evidence-${Date.now()}`);

  try {
    execSync(`git worktree add "${tmpWorktree}" ${fixSha} --detach`, { cwd: projectRoot, encoding: "utf-8" });

    const verdicts: Array<Record<string, unknown>> = [];
    for (const ac of (state.acs as Array<Record<string, unknown>>) || []) {
      const em = ac.evidenceMethod as Record<string, unknown> | undefined;
      if (!em?.command) continue;
      const cmd = em.command as string;

      let fixOutput = "";
      try {
        fixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: tmpWorktree }).trim();
      } catch (e: unknown) {
        fixOutput = ((e as { stdout?: string })?.stdout || "").trim() || `ERROR: ${(e as Error)?.message?.slice(0, 100)}`;
      }

      let preFixOutput = "";
      const scopeWorktree = join("/tmp", `pai-metamorphic-${Date.now()}`);
      try {
        execSync(`git worktree add "${scopeWorktree}" ${scopeSha} --detach`, { cwd: projectRoot, encoding: "utf-8" });
        preFixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: scopeWorktree }).trim();
      } catch {
        preFixOutput = "METAMORPHIC_SKIP";
      } finally {
        try { execSync(`git worktree remove "${scopeWorktree}" --force`, { cwd: projectRoot }); } catch { /* ignore */ }
      }

      const threshold = ac.threshold as Record<string, unknown> | undefined;
      const actual = parseFloat(fixOutput) || 0;
      const expected = parseFloat(String(threshold?.value || "0"));
      const op = (threshold?.op as string) || ">=";
      let passes = false;
      if (op === ">=") passes = !isNaN(actual) && actual >= expected;
      else if (op === "==") passes = fixOutput === String(threshold?.value) || (!isNaN(actual) && actual === expected);
      else if (op === "!=") passes = fixOutput !== String(threshold?.value);
      else if (op === ">") passes = !isNaN(actual) && actual > expected;
      else if (op === "<=") passes = !isNaN(actual) && actual <= expected;
      else if (op === "<") passes = !isNaN(actual) && actual < expected;
      else if (op === "contains") passes = fixOutput.includes(String(threshold?.value || ""));
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
      const ac = ((state.acs as Array<Record<string, unknown>>) || []).find((a) => a.id === v.acId);
      if (ac) {
        ac.verdict = v.verdict;
        ac.evidence = { type: "command-output", content: v.rawOutput };
      }
    }

    console.log(`B2: ${verdicts.filter((v) => v.verdict === "PASS").length}/${verdicts.length} evidence commands PASS`);
  } catch (e: unknown) {
    console.warn(`WARN: B2 worktree setup failed: ${(e as Error)?.message?.slice(0, 200)}`);
  } finally {
    try { execSync(`git worktree remove "${tmpWorktree}" --force`, { cwd: projectRoot }); } catch { /* ignore */ }
  }
}

// ── B2 Agent: Evidence Validator ──────────────────────────────────────────

export function spawnB2ValidatorAgent(
  state: Record<string, unknown>,
  workDir: string,
  results: GateResult[],
): { addedWarns: number; agentResult: Record<string, unknown> | null } {
  let addedWarns = 0;
  let agentResult: Record<string, unknown> | null = null;
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") return { addedWarns, agentResult };

  const b2ProjectPrompt = join(__dirname, "prompts", "evidence-validator.md");
  const b2HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "evidence-validator.md");
  const b2PromptPath = existsSync(b2ProjectPrompt) ? b2ProjectPrompt : b2HomePrompt;
  if (!existsSync(b2PromptPath)) {
    console.warn("WARN: evidence-validator.md prompt not found — B2 agent will not run");
    return { addedWarns, agentResult };
  }

  console.log("B2: Spawning Evidence Validator agent...");
  const b2Input = JSON.stringify({
    acs: ((state.acs as Array<Record<string, unknown>>) || []).map((ac) => ({
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
  } catch (e: unknown) {
    b2Output = (e as { stdout?: string })?.stdout || "";
    console.warn(`WARN: B2 Evidence Validator exited with error: ${(e as Error)?.message?.slice(0, 200)}`);
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
      const b2Fails = (b2Report.verdicts || []).filter((v: Record<string, unknown>) => v.verdict === "FAIL");
      if (b2Fails.length > 0) {
        for (const v of b2Fails) {
          addedWarns++;
          results.push({
            check: `B2-validator: ${v.acId} evidence gap`,
            result: "WARN" as const,
            detail: (v.rawOutput as string) || "threshold not met",
          });
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
  return { addedWarns, agentResult };
}

// ── B1 Agent: AC Adversary at verify ──────────────────────────────────────

export function spawnB1VerifyAgent(
  state: Record<string, unknown>,
  workDir: string,
  results: GateResult[],
): { addedWarns: number; agentResult: Record<string, unknown> | null } {
  let addedWarns = 0;
  let agentResult: Record<string, unknown> | null = null;
  const tier = ((state.sizing as Record<string, unknown>)?.ceremonyTier as string) || "STANDARD";
  if (tier === "LIGHT") return { addedWarns, agentResult };

  const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
  const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
  const b1PromptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
  if (!existsSync(b1PromptPath)) return { addedWarns, agentResult };

  console.log("B1: Spawning AC Adversary agent at verify...");
  const b1Input = JSON.stringify({
    acs: ((state.acs as Array<Record<string, unknown>>) || []).map((ac) => ({
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
  } catch (e: unknown) {
    b1Output = (e as { stdout?: string })?.stdout || "";
    console.warn(`WARN: B1 AC Adversary exited with error: ${(e as Error)?.message?.slice(0, 200)}`);
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
          results.push({
            check: `B1-adversary-verify: ${exploit.acId} gameable`,
            result: "WARN" as const,
            detail: exploit.exploit,
          });
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
  return { addedWarns, agentResult };
}

// ── Merge gate ────────────────────────────────────────────────────────────

export function executeMergeGate(
  state: Record<string, unknown>,
  sf: string,
): void {
  const marcusBranch = (state.agents as Record<string, Record<string, unknown>>)?.marcus?.branch as string | undefined;
  const scopeSha = (state.gates as Record<string, Record<string, unknown>>)?.scope?.commitSha as string | undefined;

  let diffBase: string;
  if (marcusBranch && marcusBranch !== "main") {
    diffBase = `main...${marcusBranch}`;
  } else if (scopeSha) {
    diffBase = `${scopeSha}...HEAD`;
  } else {
    console.log("merge gate: no branch or scope SHA — skipping diff checks");
    const { resultVal, attempt } = writeGateResult(sf, "merge", 1, 0, 0, [], state.projectRoot as string);
    console.log(`Gate merge: ${resultVal} (attempt ${attempt})`);
    process.exit(0);
  }

  let mergePass = 0;
  let mergeFail = 0;
  const mergeResults: GateResult[] = [];

  // Check 1: no test file deletions
  const deletedResult = execSync(`git diff ${diffBase} --diff-filter=D --name-only`, { encoding: "utf-8", cwd: (state.projectRoot as string) || undefined }).trim();
  const deletedTests = deletedResult.split("\n").filter((f: string) => /\.test\.(ts|tsx)$/.test(f));
  if (deletedTests.length > 0) {
    mergeFail++;
    mergeResults.push({ check: "merge: no test file deletions", result: "FAIL", detail: deletedTests.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: no test file deletions", result: "PASS", detail: "no test files deleted" });
  }

  // Check 2: no gate/hook modifications outside scope (WARN only)
  const changedResult = execSync(`git diff ${diffBase} --name-only`, { encoding: "utf-8", cwd: (state.projectRoot as string) || undefined }).trim();
  const gateHookChanges = changedResult.split("\n").filter((f: string) => /^(gates|hooks)\//.test(f));
  const issueTargetsGates = ((state.issueGoal as string) || "").toLowerCase().includes("gate");
  if (gateHookChanges.length > 0 && !issueTargetsGates) {
    mergeResults.push({ check: "merge: gate/hook modifications", result: "WARN", detail: gateHookChanges.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: gate/hook modifications", result: "PASS", detail: "no unexpected gate/hook changes" });
  }

  // Check 3: scope proportionality
  const statResult = execSync(`git diff ${diffBase} --shortstat`, { encoding: "utf-8", cwd: (state.projectRoot as string) || undefined }).trim();
  const insertions = parseInt((statResult.match(/(\d+) insertion/) || ["0", "0"])[1]);
  const size = ((state.sizing as Record<string, unknown>)?.predicted as string) || "M";
  if ((size === "XS" && insertions > 200) || (size === "S" && insertions > 500)) {
    mergeResults.push({ check: "merge: scope proportionality", result: "WARN", detail: `${insertions} insertions for ${size} issue` });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: scope proportionality", result: "PASS", detail: `${insertions} insertions within ${size} bounds` });
  }

  const { resultVal: mergeResultVal, attempt: mergeAttempt } = writeGateResult(sf, "merge", mergePass, mergeFail, 0, mergeResults, state.projectRoot as string);
  console.log(`Gate merge: ${mergeResultVal} (attempt ${mergeAttempt})`);
  process.exit(mergeResultVal === "PASS" ? 0 : 1);
}

// ── Prove gate exit ───────────────────────────────────────────────────────

export function handleProveGateExit(
  issue: number,
  issueRepo: string,
  workDir: string,
  resultVal: "PASS" | "FAIL",
): void {
  const proveEvidencePath = join(workDir, "prove-evidence.json");
  if (existsSync(proveEvidencePath)) {
    try {
      const proveEvidence = JSON.parse(readFileSync(proveEvidencePath, "utf-8"));
      if (proveEvidence.verdict === "PROVEN" && issue && issueRepo) {
        try {
          execSync(`gh issue edit ${issue} --repo ${issueRepo} --add-label "proven"`, {
            encoding: "utf-8",
            timeout: 15000,
          });
          console.log(`prove gate: added "proven" label to #${issue}`);
        } catch (e: unknown) {
          console.warn(`WARN: prove gate — failed to add proven label: ${(e as Error)?.message?.slice(0, 200)}`);
        }
      }
    } catch {
      // prove-evidence.json parse failure — already warned earlier
    }
  }
  process.exit(resultVal === "PASS" ? 0 : 1);
}

// ── Post-ship checks ─────────────────────────────────────────────────────

export function runPostShipChecks(state: Record<string, unknown>): void {
  releaseLock(state.slug as string);
  if (state.mergeQueue) {
    const ordered = sequentialMergeOrder(state.mergeQueue as Array<Record<string, unknown>>);
    const next = ordered[0];
    if (next && shouldRunCIVerification(next)) {
      console.log(`Next in merge queue: ${(next as Record<string, unknown>).slug} (CI verification required)`);
    }
  }
}
