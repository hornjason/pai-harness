#!/usr/bin/env bun
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
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

// Auto-populate AC verdicts (ported from ac-populate.sh)
let acUpdated = false;
for (let i = 0; i < (state.acs || []).length; i++) {
  const ac = state.acs[i];
  if (ac.verdict && ac.verdict !== "PENDING" && ac.verdict !== "FAIL") continue;
  const cmd = ac.evidenceMethod?.command;
  if (!cmd) continue;
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: state.projectRoot || process.cwd() }).trim();
    const lastLine = output.split("\n").pop() || "";
    let verdict: "PASS" | "FAIL" = "FAIL";
    // BUN_TEST detection: bun test outputs results to stderr; execSync captures
    // stdout only (version header). Since execSync throws on non-zero exit,
    // reaching here means exit 0 = all tests passed.
    const isTestRunner = /^bun test\b/.test(cmd);
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
  } catch { /* command failed — leave as PENDING */ }
}
// #513 SC-A1: ACs without evidenceMethod.command get SKIP, not generic output
const skipped = markCommandlessACsAsSkip(SF);
if (skipped > 0) {
  // Re-read state after markCommandlessACsAsSkip wrote it
  const refreshed = JSON.parse(readFileSync(SF, "utf-8"));
  Object.assign(state, refreshed);
} else if (acUpdated) {
  writeFileSync(SF, JSON.stringify(state, null, 2));
}

// B3: Prove Reproducer — runs BEFORE test suite so prove.test.ts can verify/override (ADR-009)
if (gate === "prove") {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier === "LIGHT") {
    console.log("prove gate: LIGHT tier — skipping reproducer (API check only)");
  } else {
    let issueBody = "";
    let issueTitle = "";
    if (issue && issueRepo) {
      try {
        const ghOut = execSync(
          `gh issue view ${issue} --repo ${issueRepo} --json body,title`,
          { encoding: "utf-8", timeout: 15000 }
        );
        const parsed = JSON.parse(ghOut);
        issueBody = parsed.body || "";
        issueTitle = parsed.title || "";
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

    // Prod health check — WARN only (prove.test.ts enforces the hard gate via #294/#484)
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
    const proveInputPath = join(WORK_DIR, "prove-input.json");
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
          writeFileSync(join(WORK_DIR, "prove-evidence.json"), JSON.stringify(proveEvidence, null, 2));
          console.log(`B3: prove-evidence.json written — verdict: ${proveEvidence.verdict}`);
        } catch {
          console.warn("WARN: B3 reproducer JSON parse failed");
        }
      } else {
        console.warn("WARN: B3 reproducer produced no parseable JSON — prove.test.ts will generate evidence");
      }
    }
  }
}

// Pre-flight: duplicate slug check (SC-44)
if (gate === "scope") {
  const existingSlug = slugExists(state.issue);
  if (existingSlug && existingSlug !== state.slug) {
    console.warn(`WARN: Issue #${state.issue} already has slug "${existingSlug}" — current slug is "${state.slug}"`);
  }
}

// Pre-flight: container rebuild check (SC-7)
if (gate === "scope") {
  const canRebuild = shouldRebuildContainer(state.projectRoot || process.cwd());
  if (!canRebuild) {
    console.log("Container rebuild: SKIP (prod.rebuild is null)");
  }
}

// Pre-flight: worktree branch naming (SC-136)
if (gate === "scope" && state.worktree) {
  const branch = worktreeBranchName(state.issue, state.slug);
  console.log(`Worktree branch: ${branch}`);
  if (state.worktree?.activePorts) {
    const collision = checkPortCollision(state.worktree.basePort || 3000, state.worktree.offset || 0, state.worktree.activePorts);
    if (collision) console.error(`WARN: Port collision detected for offset ${state.worktree.offset}`);
  }
}

// Pre-flight: file-set overlap detection for parallel work (SC-69)
if (gate === "scope" && state.parallelFiles && state.briefFiles) {
  const overlap = detectFileSetOverlap(state.parallelFiles, state.briefFiles);
  if (overlap.length > 0) {
    console.error(`WARN: File overlap with parallel issue: ${overlap.join(", ")}`);
  }
}

// Pre-flight: spec-compliance check (runs at scope gate — catches spec↔code drift)
if (gate === "scope") {
  // Auto-regenerate spec tests from spec before checking (closed-loop sync)
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
}

// Type check (reads typeCheck from rungate.json — SC-10)
if (gate === "scope" || gate === "verify") {
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

// Blast radius check — filesRead ≥ filesChanged (SC-59, SC-60)
if (gate === "verify" && state.blastRadius) {
  const { filesRead = 0, filesChanged = 0 } = state.blastRadius;
  if (filesRead < filesChanged) {
    console.error(`WARN: Blast radius — read ${filesRead} files but changed ${filesChanged} (read should be ≥ changed)`);
  }
  const readWriteRatio = filesRead / Math.max(filesChanged, 1);
  if (readWriteRatio < 3) {
    console.error(`WARN: Read/write ratio ${readWriteRatio.toFixed(1)} (target ≥ 3:1)`);
  }
}

// Fix-on-find check — silently dropped issues = FAIL (SC-109)
if (gate === "verify" && state.foundIssues) {
  const dropped = (state.foundIssues || []).filter((i: any) => !i.disposition);
  if (dropped.length > 0) {
    console.error(`FAIL: ${dropped.length} found issues silently dropped — must be fixed, filed, or scoped out`);
  }
}

// Files changed outside brief scope = WARN (SC-134)
if (gate === "verify" && state.filesChangedOutsideBrief?.length > 0) {
  console.error(`WARN: Files changed outside brief: ${state.filesChangedOutsideBrief.join(", ")}`);
}

// Track pre-existing failures at scope (SC-33)
if (gate === "scope" && state.preExistingFailures?.length > 0) {
  trackPreExistingFailures(state.slug, state.preExistingFailures);
}

// Post-verify: scaffold refresh check (SC-38)
if (gate === "verify" && shouldRefreshScaffold(state.slug)) {
  console.log("Post-verify: scaffold refresh recommended (verify gate PASS)");
}

// Research escalation check — iteration 2+ requires research before retry (SC-112)
if (gate === "verify" && requiresResearchEscalation(state.slug)) {
  console.log("Research escalation: iteration 2+ — research tool invocation required before next attempt");
}

// Post-ship: release lock and check merge queue (SC-47, SC-72)
if (gate === "ship") {
  releaseLock(state.slug);
  if (state.mergeQueue) {
    const ordered = sequentialMergeOrder(state.mergeQueue);
    const next = ordered[0];
    if (next && shouldRunCIVerification(next)) {
      console.log(`Next in merge queue: ${next.slug} (CI verification required)`);
    }
  }
}

// Run tests
let testOutput: string;
let testExitCode = 0;
try {
  testOutput = execSync(
    `bun test gates/ --test-name-pattern "${gate === 'scope' ? 'schema|scope' : gate === 'verify' ? 'schema|scope|verify|B1|B2' : gate === 'ship' ? 'schema|scope|verify|ship|B1|B2' : gate === 'prove' ? 'prove' : '.*'}" 2>&1`,
    {
      encoding: "utf-8",
      timeout: 120000,
      cwd: harnessRoot(),
      env: { ...process.env, TEST_WORK_DIR: WORK_DIR, GATE: gate, PROJECT_ROOT: state.projectRoot || process.cwd() },
    },
  );
} catch (e: any) {
  testOutput = e.stdout || "";
  testExitCode = e.status || 1;
}

// Parse test results from Bun text output
let passes = 0;
let fails = 0;
let warns = 0;
const results: GateResult[] = [];

// Extract pass/fail counts from Bun's summary (last occurrence: " 139 pass\n 5 fail")
const allPassMatches = [...testOutput.matchAll(/^\s*(\d+)\s+pass\s*$/gm)];
const allFailMatches = [...testOutput.matchAll(/^\s*(\d+)\s+fail\s*$/gm)];
const passMatch = allPassMatches.length > 0 ? allPassMatches[allPassMatches.length - 1] : null;
const failMatch = allFailMatches.length > 0 ? allFailMatches[allFailMatches.length - 1] : null;
if (passMatch) passes = parseInt(passMatch[1]);
if (failMatch) fails = parseInt(failMatch[1]);

// Extract individual test results: "(pass) name" or "(fail) name"
results.push(...parseTestResults(testOutput));

// Fallback: if no individual results parsed, create summary entry
if (results.length === 0) {
  if (fails > 0 || testExitCode !== 0) {
    results.push({ check: "test-suite", result: "FAIL", detail: `${fails} tests failed` });
  } else {
    results.push({ check: "test-suite", result: "PASS", detail: `${passes} tests passed` });
  }
}

console.log(`\nTest results: ${passes} pass, ${fails} fail, ${warns} warn`);

// Read conformity findings from project (if bun test wrote them)
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
    // Store in workflow state for agents to read
    if (!state.conformityFindings) {
      state.conformityFindings = findings;
    }
  } catch {}
}

// Batch diagnosis output — enumerate ALL failures grouped by category (#485)
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

// Agent result collectors for B1/B2 verify-time spawns
let b2AgentResult: any = null;
let b1VerifyAgentResult: any = null;

// B1: AC Adversary — fire-and-forget at scope, checked at verify (ADR-009)
if (gate === "scope" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier !== "LIGHT") {
    const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
    const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
    const promptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
    if (!existsSync(promptPath)) {
      console.warn("WARN: ac-adversary.md prompt not found — adversary will not run");
    } else {
      const reportPath = join(WORK_DIR, "adversary-report.json");
      // Remove stale report so verify can detect fresh vs missing
      try { unlinkSync(reportPath); } catch {}
      const acInputFile = join(WORK_DIR, "adversary-input.json");
      writeFileSync(acInputFile, JSON.stringify(state.acs || [], null, 2));
      // Spawn adversary in background — text-only, no tools needed
      const { spawn } = require("child_process");
      const child = spawn("sh", ["-c",
        `claude -p "$(cat '${acInputFile}')" --model haiku --system-prompt-file "${promptPath}" --output-format json --allowedTools "" --max-turns 3 > "${reportPath}.tmp" 2>/dev/null && mv "${reportPath}.tmp" "${reportPath}"`
      ], { detached: true, stdio: "ignore", cwd: harnessRoot() });
      child.unref();
      console.log("B1: AC Adversary spawned in background — verify gate will check result");
    }
  }
}

// Dev server liveness — OUTCOME ACs require running server (#90 RCA)
if (gate === "verify" && fails === 0 && testExitCode === 0) {
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
          fails++;
          results.push({ check: "dev-server-liveness: OUTCOME ACs require running dev server", result: "FAIL" as const, detail: `${apiBase} not responding — run '${harness?.dev?.start || "make dev-all"}' first` });
          console.log(`Dev server liveness: ${apiBase} — DOWN. Start with: ${harness?.dev?.start || "make dev-all"}`);
        }
      }
    }
  }
}

// B1 report check — verify gate reads adversary result (ADR-009)
if (gate === "verify" && fails === 0 && testExitCode === 0) {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier !== "LIGHT") {
    const reportPath = join(WORK_DIR, "adversary-report.json");
    if (!existsSync(reportPath)) {
      fails++;
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
                fails++;
                outcomeCount++;
                results.push({ check: `B1-adversary: ${exploit.acId} gameable (OUTCOME)`, result: "FAIL" as const, detail: exploit.exploit });
              } else {
                warns++;
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
  }
}

// B2: Evidence Validator — run evidence commands in clean worktree (ADR-009)
if (gate === "verify" && fails === 0 && testExitCode === 0) {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier !== "LIGHT") {
    const scopeSha = state.gates?.scope?.commitSha;
    const fixSha = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();

    if (scopeSha && state.projectRoot) {
      console.log("B2: Running evidence commands in clean worktree...");
      const tmpWorktree = join("/tmp", `pai-evidence-${Date.now()}`);

      try {
        // Create worktree at fix commit
        execSync(`git worktree add "${tmpWorktree}" ${fixSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });

        const verdicts: any[] = [];
        for (const ac of state.acs || []) {
          if (!ac.evidenceMethod?.command) continue;
          const cmd = ac.evidenceMethod.command;

          // Run in fix worktree
          let fixOutput = "";
          try {
            fixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: tmpWorktree }).trim();
          } catch (e: any) {
            fixOutput = (e.stdout || "").trim() || `ERROR: ${e.message?.slice(0, 100)}`;
          }

          // Metamorphic: run same command at scope SHA
          let preFixOutput = "";
          const scopeWorktree = join("/tmp", `pai-metamorphic-${Date.now()}`);
          try {
            execSync(`git worktree add "${scopeWorktree}" ${scopeSha} --detach`, { cwd: state.projectRoot, encoding: "utf-8" });
            preFixOutput = execSync(cmd, { encoding: "utf-8", timeout: 15000, cwd: scopeWorktree }).trim();
          } catch (e: any) {
            preFixOutput = "METAMORPHIC_SKIP";
          } finally {
            try { execSync(`git worktree remove "${scopeWorktree}" --force`, { cwd: state.projectRoot }); } catch {}
          }

          // Compare thresholds
          const actual = parseFloat(fixOutput) || 0;
          const expected = parseFloat(ac.threshold?.value || "0");
          const op = ac.threshold?.op || ">=";
          let passes = false;
          if (op === ">=") passes = actual >= expected;
          else if (op === "==") passes = actual === expected;
          else if (op === ">") passes = actual > expected;
          else if (op === "<=") passes = actual <= expected;

          // Metamorphic check
          if (fixOutput === preFixOutput && preFixOutput !== "METAMORPHIC_SKIP") {
            console.warn(`WARN: metamorphic — ${ac.id} evidence identical pre/post fix (trivially satisfiable)`);
          }

          verdicts.push({
            acId: ac.id,
            command: cmd,
            rawOutput: fixOutput,
            threshold: ac.threshold,
            actual: fixOutput,
            verdict: passes ? "PASS" : "FAIL",
            metamorphic: fixOutput === preFixOutput ? "IDENTICAL" : "DIFFERENT",
          });
        }

        // Write verdicts to workflow-state (gate-runner writes, not DA)
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
  }
}

// B2 Agent: Evidence Validator — LLM review of evidence quality (#1407, ADR-009)
if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier !== "LIGHT") {
    const b2ProjectPrompt = join(__dirname, "prompts", "evidence-validator.md");
    const b2HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "evidence-validator.md");
    const b2PromptPath = existsSync(b2ProjectPrompt) ? b2ProjectPrompt : b2HomePrompt;
    if (existsSync(b2PromptPath)) {
      console.log("B2: Spawning Evidence Validator agent...");
      const b2Input = JSON.stringify({
        acs: (state.acs || []).map((ac: any) => ({
          id: ac.id, type: ac.type, statement: ac.statement,
          threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
          evidenceMethod: ac.evidenceMethod,
        })),
      }, null, 2);
      const b2InputPath = join(WORK_DIR, "b2-input.json");
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
          b2AgentResult = {
            ts: new Date().toISOString(),
            verdicts: b2Report.verdicts || [],
            source: "B2-evidence-validator-agent",
          };
          const b2Fails = (b2Report.verdicts || []).filter((v: any) => v.verdict === "FAIL");
          if (b2Fails.length > 0) {
            for (const v of b2Fails) {
              warns++;
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
    } else {
      console.warn("WARN: evidence-validator.md prompt not found — B2 agent will not run");
    }
  }
}

// B1 Agent: AC Adversary at verify — challenges evidence with full context (#1406, ADR-009)
if (gate === "verify" && fails === 0 && testExitCode === 0 && !process.env.RUNGATE_SKIP_AGENTS) {
  const tier = state.sizing?.ceremonyTier || "STANDARD";
  if (tier !== "LIGHT") {
    const b1ProjectPrompt = join(__dirname, "prompts", "ac-adversary.md");
    const b1HomePrompt = join(process.env.HOME || "", ".claude", "gates", "prompts", "ac-adversary.md");
    const b1PromptPath = existsSync(b1ProjectPrompt) ? b1ProjectPrompt : b1HomePrompt;
    if (existsSync(b1PromptPath)) {
      console.log("B1: Spawning AC Adversary agent at verify...");
      const b1Input = JSON.stringify({
        acs: (state.acs || []).map((ac: any) => ({
          id: ac.id, type: ac.type, statement: ac.statement,
          threshold: ac.threshold, evidence: ac.evidence, verdict: ac.verdict,
          evidenceMethod: ac.evidenceMethod,
        })),
      }, null, 2);
      const b1InputPath = join(WORK_DIR, "b1-verify-input.json");
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
          b1VerifyAgentResult = {
            ts: new Date().toISOString(),
            gameable: b1Report.gameable || 0,
            approved: b1Report.approved ?? true,
            exploits: b1Report.exploits || [],
            source: "B1-adversary-verify-agent",
          };
          if (b1Report.gameable > 0) {
            for (const exploit of b1Report.exploits || []) {
              warns++;
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
    }
  }
}

// Write gate result (pass projectRoot for cross-repo SHA accuracy, #91)
const { resultVal, attempt } = writeGateResult(SF, gate, passes, fails, warns, results, state.projectRoot);
console.log(`Gate ${gate}: ${resultVal} (attempt ${attempt})`);

// Persist B1/B2 agent results to workflow-state.json AFTER writeGateResult (#1406, #1407)
if (gate === "verify" && (b2AgentResult || b1VerifyAgentResult)) {
  const freshState = JSON.parse(readFileSync(SF, "utf-8"));
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
  writeFileSync(SF, JSON.stringify(freshState, null, 2));
}

// Write tamper-evident witness for every gate
try {
  const witnessPath = writeWitness(slug, gate, resultVal, testOutput, issue, state.projectRoot);
  console.log(`Witness: ${witnessPath}`);
} catch (e: any) {
  console.error(`Witness write failed: ${e.message}`);
}

if (gate === "merge") {
  // C3 diff-validator: lightweight pre-merge checks (ADR-009)
  const marcusBranch = state.agents?.marcus?.branch;
  const scopeSha = state.gates?.scope?.commitSha;

  // Determine diff base: worktree branch or scope SHA for non-worktree
  let diffBase: string;
  if (marcusBranch && marcusBranch !== "main") {
    diffBase = `main...${marcusBranch}`;
  } else if (scopeSha) {
    diffBase = `${scopeSha}...HEAD`;
  } else {
    console.log("merge gate: no branch or scope SHA — skipping diff checks");
    // Still write gate result
    const { resultVal, attempt } = writeGateResult(SF, gate, 1, 0, 0, [], state.projectRoot);
    console.log(`Gate ${gate}: ${resultVal} (attempt ${attempt})`);
    process.exit(0);
  }

  let mergePass = 0;
  let mergeFail = 0;
  const mergeResults: any[] = [];

  // Check 1: no test file deletions
  const deletedResult = execSync(`git diff ${diffBase} --diff-filter=D --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const deletedTests = deletedResult.split("\n").filter(f => /\.test\.(ts|tsx)$/.test(f));
  if (deletedTests.length > 0) {
    mergeFail++;
    mergeResults.push({ check: "merge: no test file deletions", result: "FAIL", detail: deletedTests.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: no test file deletions", result: "PASS" });
  }

  // Check 2: no gate/hook modifications outside scope (WARN only)
  const changedResult = execSync(`git diff ${diffBase} --name-only`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const gateHookChanges = changedResult.split("\n").filter(f => /^(gates|hooks)\//.test(f));
  const issueTargetsGates = (state.issueGoal || "").toLowerCase().includes("gate");
  if (gateHookChanges.length > 0 && !issueTargetsGates) {
    mergeResults.push({ check: "merge: gate/hook modifications", result: "WARN", detail: gateHookChanges.join(", ") });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: gate/hook modifications", result: "PASS" });
  }

  // Check 3: scope proportionality
  const statResult = execSync(`git diff ${diffBase} --shortstat`, { encoding: "utf-8", cwd: state.projectRoot || undefined }).trim();
  const insertions = parseInt((statResult.match(/(\d+) insertion/) || ["0","0"])[1]);
  const size = state.sizing?.predicted || "M";
  if ((size === "XS" && insertions > 200) || (size === "S" && insertions > 500)) {
    mergeResults.push({ check: "merge: scope proportionality", result: "WARN", detail: `${insertions} insertions for ${size} issue` });
  } else {
    mergePass++;
    mergeResults.push({ check: "merge: scope proportionality", result: "PASS" });
  }

  const { resultVal: mergeResultVal, attempt: mergeAttempt } = writeGateResult(SF, gate, mergePass, mergeFail, 0, mergeResults, state.projectRoot);
  console.log(`Gate ${gate}: ${mergeResultVal} (attempt ${mergeAttempt})`);
  process.exit(mergeResultVal === "PASS" ? 0 : 1);
}

// Prove gate: add proven label on PROVEN verdict, exit based on test results (#1390)
if (gate === "prove") {
  // Read prove-evidence.json for verdict
  const proveEvidencePath = join(WORK_DIR, "prove-evidence.json");
  if (existsSync(proveEvidencePath)) {
    try {
      const proveEvidence = JSON.parse(readFileSync(proveEvidencePath, "utf-8"));
      if (proveEvidence.verdict === "PROVEN" && issue && issueRepo) {
        // Add proven label to issue via gh CLI
        try {
          execSync(`gh issue edit ${issue} --repo ${issueRepo} --add-label "proven"`, {
            encoding: "utf-8",
            timeout: 15000,
          });
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
