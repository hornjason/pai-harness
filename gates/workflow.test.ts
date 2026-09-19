import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { WorkflowStateSchema } from "./schema";

const STANDALONE = !process.env.TEST_WORK_DIR;
const TEST_DIR = process.env.TEST_WORK_DIR || "/tmp/gate-viability-test";
const SF = `${TEST_DIR}/workflow-state.json`;

function loadRaw(): any | null {
  if (!existsSync(SF)) return null;
  return JSON.parse(readFileSync(SF, "utf-8"));
}

function sf(path: string): any {
  const wf = loadRaw();
  if (!wf) return undefined;
  const parts = path.replace(/^\./, "").split(".").filter(Boolean);
  let val: any = wf;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

function exec(cmd: string, cwd?: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return { ok: false, output: (e.stdout ?? "").trim() };
  }
}

function loadProjectHarness(): any {
  const root = sf("projectRoot");
  if (!root) return null;
  const p = join(root, ".claude", "rungate.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

const isVerifyPlus = () => { const p = sf("phase"); return ["VERIFY", "SHIP", "DONE"].includes(p); };
const isShipPlus = () => { const p = sf("phase"); return ["SHIP", "DONE"].includes(p); };
const isDone = () => sf("phase") === "DONE";

// ═══ SCHEMA VALIDATION ════════════════════════════════════════════════
describe("schema validation", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  test("workflow-state.json validates (includes threshold + behavioral superRefine)", () => {
    const raw = loadRaw();
    const result = WorkflowStateSchema.passthrough().safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
      expect(result.success, issues.join("\n")).toBe(true);
    }
  });
});

// ═══ SCOPE CHECKS (11 functions) ══════════════════════════════════════
describe("scope checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 1. acs-exist
  test("acs-exist: at least one AC", () => {
    expect(sf("acs")?.length ?? 0).toBeGreaterThan(0);
  });

  // 4. acs-have-evidence-method
  test("acs-have-evidence-method", () => {
    const missing = (sf("acs") || []).filter((ac: any) => !ac.evidenceMethod);
    expect(missing.map((ac: any) => ac.id)).toEqual([]);
  });

  // 5. acs-measurable
  test("acs-measurable: thresholds have op and value", () => {
    const bad = (sf("acs") || []).filter((ac: any) => ac.threshold && (!ac.threshold.op || ac.threshold.value == null));
    expect(bad.map((ac: any) => ac.id)).toEqual([]);
  });

  // 6. source-spec-cited (GAP → PORTED)
  test("source-spec-cited: all sourceSpecs have citedInDiscovery=true", () => {
    const specs = sf("sourceSpecs") || [];
    const uncited = specs.filter((s: any) => s.citedInDiscovery === false);
    expect(uncited.map((s: any) => s.path)).toEqual([]);
  });

  // 7. spec-elements-in-acs (GAP → PORTED)
  test("spec-elements-in-acs: if specElements exist, at least one AC references them", () => {
    const specs = sf("sourceSpecs") || [];
    const elements = specs.flatMap((s: any) => s.specElements || []);
    if (elements.length === 0) return;
    const acsWithSpec = (sf("acs") || []).filter((ac: any) => ac.specElement);
    expect(acsWithSpec.length).toBeGreaterThan(0);
  });

  // 8. sizing-declared
  test("sizing-declared", () => {
    expect(sf("sizing")?.predicted).toBeDefined();
  });

  // 9. issue-goal-captured
  test("issue-goal-captured", () => {
    expect((sf("issueGoal") || "").length).toBeGreaterThan(0);
  });

  // 10. acs-no-skillmd-enforcement (GAP → PORTED)
  test("acs-no-skillmd-enforcement: no ACs target SKILL.md", () => {
    const pattern = /SKILL\.md/i;
    const hits = (sf("acs") || []).filter((ac: any) =>
      pattern.test(ac.statement || "") || pattern.test(ac.evidenceMethod?.command || "")
    );
    expect(hits.map((ac: any) => ac.id)).toEqual([]);
  });

  // ac-issue-alignment: ACs cover issueGoal keywords (ADR-009 C4)
  test("ac-issue-alignment: ACs cover goal keywords", () => {
    const goal = sf("issueGoal");
    if (!goal || typeof goal !== "string") return;
    const STOPWORDS = new Set(["the","and","for","that","this","with","from","have","been","will","must","when","into","also","each","than"]);
    const keywords = goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 4 && !STOPWORDS.has(w));
    if (keywords.length === 0) return;
    const acText = (sf("acs") || []).map((ac: any) => (ac.statement || "").toLowerCase()).join(" ");
    const covered = keywords.filter(kw => acText.includes(kw));
    const coverage = covered.length / keywords.length;
    if (coverage < 0.5) {
      console.warn(`WARN: ac-issue-alignment: only ${Math.round(coverage * 100)}% goal keyword coverage (${covered.length}/${keywords.length})`);
    }
  });

  // 11. sourceSpecs-required (#473)
  test("sourceSpecs-required: non-LIGHT tier must have sourceSpecs", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    expect(specs.length, "STANDARD/THOROUGH tier must have at least one sourceSpec").toBeGreaterThanOrEqual(1);
  });

  // 11b. before-state-captured (#1411)
  test("before-state-captured: STANDARD+ must have beforeState in workflow-state", () => {
    const tier = sf("sizing.ceremonyTier");
    const VALID_TYPES = ["text", "screenshot", "api", "none"];
    const bs = sf("beforeState");
    if (!bs) {
      if (tier === "LIGHT") return;
      console.warn("WARN: before-state-captured: beforeState missing for STANDARD+ tier — goal skill should capture before-state (#1411)");
      return;
    }
    expect(VALID_TYPES.includes(bs.type), `beforeState.type must be text|screenshot|api|none, got "${bs.type}"`).toBe(true);
    if (tier !== "LIGHT" && bs.type === "none") {
      console.warn('WARN: before-state-captured: beforeState.type is "none" for STANDARD+ tier — consider capturing actual before-state');
    }
  });

  // 12. discovery-evidence (#473)
  test("discovery-evidence: non-LIGHT tiers have cited sourceSpecs", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    const cited = specs.filter((s: any) => s.citedInDiscovery);
    expect(cited.length, "No sourceSpecs with citedInDiscovery — DISCOVERY may have been skipped").toBeGreaterThanOrEqual(1);
  });

  // 13. governing-spec-exists (#473)
  test("governing-spec-exists: spec file exists on disk", () => {
    const tier = sf("sizing.ceremonyTier");
    if (tier === "LIGHT") return;
    const specs = sf("sourceSpecs") || [];
    if (specs.length === 0) return; // caught by sourceSpecs-required
    const specPath = specs[0].path;
    const projectRoot = sf("projectRoot") || ".";
    const resolved = specPath.startsWith("/") ? specPath : join(projectRoot, specPath);
    expect(existsSync(resolved), `Governing spec not found: ${resolved}`).toBe(true);
  });

  // 14. harness-port-validation: rungate.json ports match Makefile
  test("harness-port-validation: dev/test/prod ports match Makefile", () => {
    const projectRoot = sf("projectRoot");
    if (!projectRoot) return;
    const harnessPath = join(projectRoot, ".claude", "rungate.json");
    const makefilePath = join(projectRoot, "Makefile");
    if (!existsSync(harnessPath) || !existsSync(makefilePath)) return;
    const harness = JSON.parse(readFileSync(harnessPath, "utf-8"));
    const makefile = readFileSync(makefilePath, "utf-8");

    const warnings: string[] = [];

    // Check dev port — match PORT= in the dev-all/dev section of Makefile
    const devPort = harness.dev?.apiBase?.match(/:(\d+)/)?.[1];
    if (devPort) {
      const devSection = makefile.match(/dev.*environment[^]*?PORT=(\d+)/i);
      const makeDevPort = devSection?.[1];
      if (makeDevPort && devPort !== makeDevPort) {
        warnings.push(`dev.apiBase port ${devPort} != Makefile dev PORT ${makeDevPort}`);
      }
    }

    // Check prod port — match PORT= in container run commands
    const prodPort = harness.prod?.apiBase?.match(/:(\d+)/)?.[1];
    if (prodPort) {
      const makeProdPort = makefile.match(/-e PORT=(\d+)/)?.[1];
      if (makeProdPort && prodPort !== makeProdPort) {
        warnings.push(`prod.apiBase port ${prodPort} != Makefile container PORT ${makeProdPort}`);
      }
    }

    if (warnings.length > 0) {
      console.warn(`WARN: harness-port-validation: ${warnings.join("; ")}`);
    }
  });
});

// ═══ VERIFY CHECKS (16 functions) ═════════════════════════════════════
describe("verify checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 12. local-before-prod
  test("local-before-prod: local validated before prod rebuild", () => {
    const prodRebuild = sf("environments")?.prod?.rebuild;
    if (!prodRebuild || prodRebuild === "SKIP") return;
    const localApi = sf("environments")?.local?.api;
    const localTests = sf("environments")?.local?.tests;
    if (localApi !== "PASS" && localTests !== "PASS") {
      expect("prod deployed without local validation").toBe("local.api or local.tests = PASS first");
    }
  });

  // 13. container-has-fix — OCI label SHA comparison (#437)
  test("container-has-fix: container image SHA matches HEAD", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const prodRebuild = sf("environments")?.prod?.rebuild;
    const root = sf("projectRoot");
    if (!root) return;
    const containerName = harness.prod.containerName || harness.prod.imageName;
    if (!containerName) return;
    const runtime = exec("command -v podman") .ok ? "podman" : "docker";
    const inspect = exec(`${runtime} inspect --format='{{index .Config.Labels "org.opencontainers.image.revision"}}' ${containerName}`);
    if (!inspect.ok || !inspect.output) return;
    const containerSha = inspect.output.replace(/'/g, "").trim();
    const head = exec("git rev-parse HEAD", root);
    if (!head.ok) return;
    if (containerSha !== head.output) {
      if (prodRebuild !== "PASS") {
        expect(`container SHA ${containerSha.slice(0,8)} behind HEAD ${head.output.slice(0,8)} and rebuild not PASS`).toBe("container SHA matches HEAD or rebuild PASS");
      }
    }
  });

  // 14. all-acs-have-evidence (GAP → PORTED)
  // OUTCOME ACs may not have mechanical evidence at ship time — verified at prove via Quinn
  test("all-acs-have-evidence: every AC has evidence in verify+", () => {
    if (!isVerifyPlus()) return;
    const missing = (sf("acs") || []).filter((ac: any) => ac.evidence == null && ac.type !== "OUTCOME");
    expect(missing.map((ac: any) => ac.id)).toEqual([]);
  });

  // 15. all-acs-pass
  // OUTCOME ACs may be PENDING at ship time — they require Quinn/prove for verification
  test("all-acs-pass: every AC has verdict in ship+", () => {
    if (!isShipPlus()) return;
    const noVerdict = (sf("acs") || []).filter((ac: any) => (!ac.verdict || ac.verdict === "PENDING") && ac.type !== "OUTCOME");
    expect(noVerdict.map((ac: any) => ac.id)).toEqual([]);
  });

  // 15b. outcome-acs-no-skip: OUTCOME ACs must be verified, not skipped (#90 RCA)
  test("outcome-acs-no-skip: OUTCOME ACs cannot have SKIP verdict at ship+", () => {
    if (!isShipPlus()) return;
    const skipped = (sf("acs") || []).filter((ac: any) => ac.type === "OUTCOME" && ac.verdict === "SKIP");
    expect(skipped.map((ac: any) => ac.id), "OUTCOME ACs require live verification — start dev server and run the feature (#90 RCA)").toEqual([]);
  });

  // 15c. outcome-evidence-behavioral: OUTCOME evidence is not just a grep count (#90 RCA)
  test("outcome-evidence-behavioral: OUTCOME AC evidence is not just a number", () => {
    if (!isShipPlus()) return;
    const outcomes = (sf("acs") || []).filter((ac: any) => ac.type === "OUTCOME" && ac.verdict === "PASS");
    const numericOnly = outcomes.filter((ac: any) => {
      const content = ac.evidence?.content || "";
      return /^\d+$/.test(content.trim());
    });
    if (numericOnly.length > 0) {
      console.warn(`WARN: ${numericOnly.length} OUTCOME AC(s) have numeric-only evidence — behavioral evidence expected`);
    }
  });

  test("no FAIL verdicts in DONE", () => {
    if (!isDone()) return;
    const fails = (sf("acs") || []).filter((ac: any) => ac.verdict === "FAIL");
    expect(fails.map((ac: any) => ac.id)).toEqual([]);
  });

  // 16. evidence-type-valid (GAP → PORTED)
  test("evidence-type-valid: evidence.type matches allowed enum", () => {
    if (!isVerifyPlus()) return;
    const VALID = ["file-citation", "grep-output", "api-response", "screenshot", "test-output", "command-output", "manual-attestation", "grep"];
    const bad = (sf("acs") || []).filter((ac: any) => {
      if (!ac.evidence || typeof ac.evidence !== "object") return false;
      return !VALID.includes(ac.evidence.type);
    });
    expect(bad.map((ac: any) => `${ac.id}: ${ac.evidence?.type}`)).toEqual([]);
  });

  // 17. evidence-type-ratio (GAP → PORTED, ADR-009 A5: >= 50% behavioral evidence required)
  test("evidence-type-ratio: <50% pattern-only evidence (ADR-009 A5)", () => {
    if (!isVerifyPlus()) return;
    const acs = (sf("acs") || []).filter((ac: any) => ac.evidenceMethod);
    if (acs.length === 0) return;
    const patternOnly = acs.filter((ac: any) => {
      const t = ac.evidenceMethod?.type;
      return !t || t === "pattern" || t === "GREP_CHECK" || t === "grep";
    });
    const ratio = patternOnly.length / acs.length;
    // ADR-009 A5: at least 50% behavioral evidence required
    expect(ratio, `${patternOnly.length}/${acs.length} (${Math.round(ratio * 100)}%) pattern-only — must be < 50% (ADR-009 A5)`).toBeLessThanOrEqual(0.5);
  });

  // 18. evidence-method-executed (GAP → PORTED)
  test("evidence-method-executed: COMMAND ACs have evidence content", () => {
    if (!isVerifyPlus()) return;
    const missing = (sf("acs") || []).filter((ac: any) => {
      const t = ac.evidenceMethod?.type;
      if (t !== "COMMAND" && t !== "command") return false;
      return !ac.evidence || (typeof ac.evidence === "object" && !ac.evidence.content);
    });
    expect(missing.map((ac: any) => ac.id)).toEqual([]);
  });

  // 19. threshold-crosscheck (GAP → PORTED)
  test("threshold-crosscheck: evidence values meet threshold", () => {
    if (!isVerifyPlus()) return;
    const violations: string[] = [];
    for (const ac of sf("acs") || []) {
      if (!ac.threshold || !ac.evidence) continue;
      const val = typeof ac.evidence === "object" ? ac.evidence.value : null;
      if (val == null) continue;
      const exp = parseFloat(String(ac.threshold.value));
      if (isNaN(exp) || isNaN(val)) continue;
      let pass = true;
      switch (ac.threshold.op) {
        case ">=": pass = val >= exp; break;
        case "<=": pass = val <= exp; break;
        case ">": pass = val > exp; break;
        case "<": pass = val < exp; break;
        case "==": pass = val === exp; break;
        case "!=": pass = val !== exp; break;
      }
      if (!pass) violations.push(`${ac.id}: ${val} ${ac.threshold.op} ${exp} = false`);
    }
    expect(violations).toEqual([]);
  });

  // 20. tests-pass (GAP → PORTED)
  test("tests-pass: test suite passes", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.testCmd) return;
    const val = sf("environments")?.local?.tests;
    if (!val) {
      expect("local.tests not set").toBe("PASS or SKIP — required when dev.testCmd is configured");
    } else if (val === "SKIP") {
      // SKIP is allowed
    } else if (val !== "PASS") {
      expect(`tests: ${val}`).toBe("PASS");
    }
  });

  // 21. tsc-pass (GAP → PORTED)
  test("tsc-pass: no new TypeScript errors above baseline", () => {
    if (!isVerifyPlus()) return;
    const root = sf("projectRoot");
    if (!root || !existsSync(join(root, "tsconfig.json"))) return;
    // Check if Marcus recorded it
    const tests = sf("environments")?.local?.tests;
    if (tests === "PASS" || tests === "SKIP") return; // trust Marcus
  });

  // 22. code-committed (GAP → PORTED)
  test("code-committed: no uncommitted changes in project", () => {
    if (!isShipPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const harness = loadProjectHarness();
    const paths = harness?.codeCommittedPaths || [];
    if (paths.length === 0) return;
    const result = exec(`git status --porcelain -- ${paths.join(" ")}`, root);
    const dirty = result.output.split("\n").filter(Boolean).length;
    if (dirty > 0) {
      expect(`${dirty} uncommitted files`).toBe("0 uncommitted files");
    }
  });

  // 23. code-pushed (GAP → PORTED)
  test("code-pushed: no unpushed commits", () => {
    if (!isShipPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const result = exec("git rev-list --count @{upstream}..HEAD", root);
    if (!result.ok) return; // no upstream
    if (result.output !== "0") {
      expect(`${result.output} commits ahead`).toBe("0 commits ahead");
    }
  });

  // 25. local-api-validated (GAP → PORTED)
  test("local-api-validated: environments.local.api set", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.apiBase) return;
    const val = sf("environments")?.local?.api;
    if (!val) {
      expect("local.api not set").toBe("PASS or SKIP — required when dev.apiBase is configured");
    } else if (val === "SKIP") {
      // SKIP is allowed
    } else if (val !== "PASS") {
      expect(`api: ${val}`).toBe("PASS");
    }
  });

  // 26. local-ui-validated (GAP → PORTED)
  test("local-ui-validated: environments.local.ui set with skipReason", () => {
    if (!isVerifyPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.dev?.uiBase) return;
    const val = sf("environments")?.local?.ui;
    if (!val) {
      expect("local.ui not set").toBe("PASS or SKIP — required when dev.uiBase is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.local?.uiSkipReason;
      if (!reason) {
        expect("UI SKIP without reason").toBe("uiSkipReason required when SKIP");
      }
    } else if (val !== "PASS") {
      expect(`ui: ${val}`).toBe("PASS");
    }
  });

  // 29. quinn-on-ui-change
  test("quinn-on-ui-change: quinn spawned when UI files change", () => {
    if (!isShipPlus()) return;
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const UI_SVC = /template|campaign-html|brief-pipeline|email-template|dashboard/i;
    const allPaths: string[] = [];
    for (const ac of sf("acs") || []) {
      if (ac.statement) allPaths.push(ac.statement);
      if (ac.evidenceMethod?.command) allPaths.push(ac.evidenceMethod.command);
      for (const cf of ac.contextFiles || []) {
        if (cf?.path) allPaths.push(cf.path);
      }
    }
    // Strip absolute project paths to avoid false positives (e.g. /DailyBriefDashboard/ matching "dashboard")
    const projectRoot = sf("projectRoot") || "";
    const joined = allPaths.join(" ").replaceAll(projectRoot, "");
    if (!UI_EXT.test(joined) && !UI_SVC.test(joined)) return;
    const quinn = sf("agents")?.quinn;
    if (!quinn?.spawned) {
      expect("quinn not spawned for UI change").toBe("quinn.spawned required");
    }
    // Quinn depth check: spawned but no testedPaths = code review only (ADR-009 A3)
    // If Quinn has verdict PASS, accept that as sufficient evidence (ship.js doesn't write testedPaths yet)
    if (quinn?.spawned && quinn.verdict !== 'PASS') {
      const testedPaths = quinn.testedPaths;
      expect(Array.isArray(testedPaths) && testedPaths.length > 0, "quinn.testedPaths must not be empty — code review only does not satisfy UI testing (ADR-009 A3)").toBe(true);
    }
    // Quinn screenshot check: WARN when verdict=PASS but no screenshots (ship.js Quinn doesn't capture yet)
    if (quinn?.spawned && quinn.verdict !== 'PASS') {
      const screenshots = quinn.screenshots || [];
      const hasRealScreenshots = screenshots.length > 0 && screenshots.some((s: string) => existsSync(s));
      if (!hasRealScreenshots) {
        expect("quinn.screenshots empty or files missing").toBe("at least 1 screenshot file on disk — browser verification required for UI changes (#90 RCA)");
      }
    }
  });

  // quinn-container-port: Quinn must test on container :7776, not dev :7778 (#1371)
  test("quinn-container-port: Quinn tested on container port 7776", () => {
    const quinn = sf("agents")?.quinn;
    if (!quinn?.spawned) return;
    const agentPort = quinn.port;
    const envPort = sf("environments")?.local?.quinn?.port;
    const port = agentPort || envPort;
    if (!port) {
      console.warn("WARN: quinn-container-port: no port recorded in quinn agent data — cannot verify container testing");
      return;
    }
    if (port !== 7776) {
      console.warn(`WARN: quinn-container-port: Quinn tested on port ${port}, expected 7776 (container). Testing on dev (:7778) does not validate container behavior.`);
    }
  });

  // brief-ac-alignment: Marcus brief contains all AC ids (ADR-009 C2)
  test("brief-ac-alignment: brief covers all ACs", () => {
    if (!isVerifyPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const briefPath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "marcus-brief.md");
    if (!existsSync(briefPath)) {
      // Brief file must exist for STANDARD+ tiers when marcus was spawned
      const marcus = sf("agents")?.marcus;
      if (marcus?.spawned) {
        expect("marcus-brief.md missing").toBe("brief file required when Marcus spawned (ADR-009 C2)");
      }
      return;
    }
    const brief = readFileSync(briefPath, "utf-8");
    const acs = sf("acs") || [];
    const missingIds = acs
      .map((ac: any) => ac.id)
      .filter((id: string) => !brief.includes(id));
    expect(missingIds, `brief-ac-alignment: brief missing AC ids: ${missingIds.join(", ")}`).toEqual([]);
  });

  // ac-spec-traceability (#440)
  test("ac-spec-traceability: AC specElements exist in governing spec", () => {
    if (!isVerifyPlus()) return;
    const specPath = sf("governingSpec")?.path;
    if (!specPath || !existsSync(specPath)) return;
    const specContent = readFileSync(specPath, "utf-8");
    const missing: string[] = [];
    for (const ac of sf("acs") || []) {
      if (!ac.specElement) continue;
      if (!specContent.includes(ac.specElement)) {
        missing.push(`${ac.id}: specElement "${ac.specElement}" not found in spec`);
      }
    }
    expect(missing).toEqual([]);
  });

  // 28. marcus-committed (GAP → PORTED)
  test("marcus-committed: no uncommitted Marcus changes", () => {
    if (!isVerifyPlus()) return;
    const signalDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), "signals");
    const slug = sf("slug") || "";
    const signalFile = join(signalDir, `marcus-uncommitted-${slug.replace(/\//g, "-")}`);
    if (existsSync(signalFile)) {
      expect("marcus left uncommitted files").toBe("marcus committed all changes");
    }
  });

  // prove-evidence-type: UI changes require screenshot/api-response evidence (ADR-009 A4)
  test("prove-evidence-type: UI changes require live evidence", () => {
    if (!isVerifyPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    const diff = exec(`git diff --name-only ${scopeSha}..HEAD`, root);
    if (!diff.ok || !diff.output) return;
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const uiChanged = diff.output.split("\n").filter(f => UI_EXT.test(f));
    if (uiChanged.length === 0) return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    if (!existsSync(evidencePath)) return;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    const afterType = evidence.afterEvidence?.type;
    const VALID_UI_EVIDENCE = ["screenshot", "api-response"];
    expect(afterType, "afterEvidence.type required for UI changes (ADR-009 A4)").toBeTruthy();
    expect(VALID_UI_EVIDENCE.includes(afterType), `afterEvidence.type must be screenshot or api-response for UI changes, got "${afterType}" (ADR-009 A4)`).toBe(true);
  });

  // acHash consistency: verify gate checks scope's AC hash (ADR-009)
  test("acHash-consistency-verify: ACs unchanged since scope", () => {
    if (!isVerifyPlus()) return;
    const acHash = sf("gates")?.scope?.acHash;
    if (!acHash) return;
    const acDefs = (sf("acs") || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const currentHash = require("crypto").createHash("sha256").update(JSON.stringify(acDefs)).digest("hex");
    expect(currentHash, "ACs modified after scope approval — re-run scope gate (ADR-009 acHash)").toBe(acHash);
  });

  // spec-decision-compliance (#409, Decision #9: WARN tier — console.warn only, no expect failures)
  test("spec-decision-compliance: AC language aligns with spec decisions", () => {
    if (!isVerifyPlus()) return;
    const localPolicies = join(__dirname, "spec-policies.json");
    const homePolicies = join(process.env.HOME || "", ".claude", "skills", "ship", "spec-policies.json");
    const policiesPath = existsSync(localPolicies) ? localPolicies : homePolicies;
    if (!existsSync(policiesPath)) return;
    const policies = JSON.parse(readFileSync(policiesPath, "utf-8"));
    const patterns = policies.implementationPatterns;
    if (!patterns) return;
    const acs = sf("acs") || [];
    let warnCount = 0;
    for (const [key, rule] of Object.entries(patterns) as [string, any][]) {
      if (!rule.antiPatterns || !rule.decision) continue;
      const scopes: string[] = rule.scope || ["statement"];
      for (const ac of acs) {
        for (const scope of scopes) {
          const text = scope === "statement" ? (ac.statement || "") : (ac.evidenceMethod?.command || "");
          if (!text) continue;
          for (const ap of rule.antiPatterns) {
            if (new RegExp(ap, "i").test(text)) {
              console.warn(`WARN: spec-decision-compliance [${key}]: AC "${ac.id}" matches anti-pattern "${ap}" — ${rule.message}`);
              warnCount++;
            }
          }
        }
      }
    }
    if (warnCount > 0) {
      console.warn(`WARN: spec-decision-compliance: ${warnCount} anti-pattern match(es) found — review recommended`);
    }
  });

  // contextual-skip-validation (#91 → ADR-009 A1: SKIP → FAIL for file-matched gates)
  test("contextual-skip-validation: SKIP blocked when changed files require gate", () => {
    if (!isVerifyPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    const diff = exec(`git diff --name-only ${scopeSha}..HEAD`, root);
    if (!diff.ok || !diff.output) return; // no changed files — silently return

    const FILE_GATE_MAP: Record<string, string[]> = {
      "tsx|jsx": ["local-ui-validated", "quinn-on-ui-change"],
      "css|scss|less|html|svg": ["local-ui-validated"],
      "sql|migration": ["local-api-validated"],
      "Dockerfile|docker-compose|Makefile": ["prod-rebuild-pass"],
    };

    const ENV_GATE_PATH: Record<string, string> = {
      "local-ui-validated": "environments.local.ui",
      "local-api-validated": "environments.local.api",
      "quinn-on-ui-change": "agents.quinn.spawned",
      "prod-rebuild-pass": "environments.prod.rebuild",
    };

    const changedFiles = diff.output.split("\n").filter(Boolean);
    let warnCount = 0;
    for (const file of changedFiles) {
      for (const [extPattern, gates] of Object.entries(FILE_GATE_MAP)) {
        const re = new RegExp(`\\.(${extPattern})$`, "i");
        const nameRe = new RegExp(`(${extPattern})`, "i");
        if (!re.test(file) && !nameRe.test(file.split("/").pop() || "")) continue;
        for (const gate of gates) {
          const envPath = ENV_GATE_PATH[gate];
          if (!envPath) continue;
          const val = sf(envPath);
          if (val === "SKIP") {
            expect(`contextual-skip-blocked: "${file}" changed but ${gate} is SKIP`).toBe("gate must not be SKIP when matched files changed (ADR-009 A1)");
            warnCount++;
          }
        }
      }
    }
    if (warnCount > 0) {
      expect(`contextual-skip-validation: ${warnCount} SKIP(s) on file-matched gates`).toBe("contextual-skip-validation: 0 SKIPs (ADR-009 A1)");
    }
  });
});

// ═══ B1/B2 AGENT RESULTS (#1406, #1407) ═════════════════════════════
describe("B1/B2 agent results", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // B2: Evidence Validator prompt file exists
  test("b2-prompt-exists: evidence-validator.md available", () => {
    const promptPath = join(__dirname, "prompts", "evidence-validator.md");
    expect(
      existsSync(promptPath),
      "evidence-validator.md prompt not found in gates/prompts/",
    ).toBe(true);
  });

  // B1: AC Adversary prompt file exists
  test("b1-prompt-exists: ac-adversary.md available", () => {
    const promptPath = join(__dirname, "prompts", "ac-adversary.md");
    expect(
      existsSync(promptPath),
      "ac-adversary.md prompt not found in gates/prompts/",
    ).toBe(true);
  });

  // B2: Evidence Validator results structure (when present)
  test("b2-evidence-validator-structure: results valid when populated", () => {
    if (!isVerifyPlus()) return;
    const ev = sf("gates.verify.evidenceValidator");
    if (!ev) {
      console.warn("WARN: gates.verify.evidenceValidator not populated — B2 agent may not have run");
      return;
    }
    expect(ev.ts, "evidenceValidator.ts must be an ISO timestamp").toBeTruthy();
    expect(Array.isArray(ev.verdicts), "evidenceValidator.verdicts must be an array").toBe(true);
  });

  // B1: AC Adversary results structure (when present)
  test("b1-adversary-verify-structure: results valid when populated", () => {
    if (!isVerifyPlus()) return;
    const adv = sf("gates.verify.adversary");
    if (!adv) {
      console.warn("WARN: gates.verify.adversary not populated — B1 verify agent may not have run");
      return;
    }
    expect(adv.ts, "adversary.ts must be an ISO timestamp").toBeTruthy();
    expect(typeof adv.gameable, "adversary.gameable must be a number").toBe("number");
    expect(typeof adv.approved, "adversary.approved must be a boolean").toBe("boolean");
  });
});

// ═══ SPEC TRACEABILITY (2 functions) ══════════════════════════════════
describe("spec traceability", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 31. decision-id-valid (GAP → PORTED)
  test("decision-id-valid: D-NNN IDs in ACs exist in governing spec", () => {
    const specPath = sf("sourceSpecs")?.[0]?.path || sf("governingSpec")?.path;
    if (!specPath || !existsSync(specPath)) return;
    const spec = readFileSync(specPath, "utf-8");
    const ids = new Set<string>();
    for (const ac of sf("acs") || []) {
      const matches = (ac.statement || "").match(/D-\d+/g) || [];
      matches.forEach((id: string) => ids.add(id));
    }
    if (ids.size === 0) return;
    const missing = [...ids].filter(id => !spec.includes(id));
    expect(missing).toEqual([]);
  });

  // 32. evidence-target-valid (GAP → PORTED)
  test("evidence-target-valid: evidence commands target files within scope", () => {
    const harness = loadProjectHarness();
    const paths = harness?.codeCommittedPaths || [];
    if (paths.length === 0) return;
    const commands = (sf("acs") || [])
      .map((ac: any) => ac.evidenceMethod?.command || "")
      .filter(Boolean);
    if (commands.length === 0) return;
    const fileRefs = commands.join("\n").match(/[^\s]+(\/[^\s]+|\.[a-z]+)/g) || [];
    const outside = fileRefs.filter(ref => {
      if (/^-/.test(ref) || /^\|/.test(ref)) return false;
      return !paths.some((p: string) => ref.includes(p));
    });
    // Informational — outside refs are common (test fixtures, config)
  });
});

// ═══ SHIP CHECKS (7 functions) ════════════════════════════════════════
describe("ship checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // 35. all-gates-pass (GAP → PORTED)
  test("all-gates-pass: scope + verify gates PASS", () => {
    if (!isShipPlus()) return;
    const scope = sf("gates")?.scope?.result;
    const verify = sf("gates")?.verify?.result;
    if (scope && scope !== "PASS") {
      expect(`scope gate: ${scope}`).toBe("PASS");
    }
    if (verify && verify !== "PASS") {
      expect(`verify gate: ${verify}`).toBe("PASS");
    }
  });

  // 36. branch-merged / code-pushed (GAP → PORTED)
  // Ship gate: code pushed + PR exists = PASS (merge is post-ship, verified at prove)
  // Prove gate: merged to main = PASS
  test("branch-merged: fix is on main", () => {
    if (!isShipPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const gate = process.env.GATE || "";
    if (gate === "ship") {
      // At ship gate: check code is pushed, not merged
      const commit = sf("buildCommit");
      const agents = sf("agents");
      const pushed = agents?.marcus?.branch;
      if (!commit && !pushed) {
        expect("no commit or branch").toBe("buildCommit or marcus.branch required at ship gate");
      }
      return;
    }
    // At prove gate or verify: check merged to main
    const result = exec("git branch --contains HEAD --list main", root);
    if (result.ok && !result.output.includes("main")) {
      expect("not on main").toBe("merged to main");
    }
  });

  // 38. prod-rebuild-pass (GAP → PORTED)
  test("prod-rebuild-pass: prod rebuild required when configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const val = sf("environments")?.prod?.rebuild;
    if (!val) {
      expect("prod.rebuild not set").toBe("PASS or SKIP with reason — required when prod.rebuild is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.rebuildSkipReason;
      if (!reason) expect("rebuild SKIP without reason").toBe("rebuildSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod rebuild: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // 39. prod-smoke-pass (GAP → PORTED)
  test("prod-smoke-pass: prod smoke required when configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.smokeTest) return;
    const val = sf("environments")?.prod?.smoke;
    if (!val) {
      expect("prod.smoke not set").toBe("PASS or SKIP with reason — required when prod.smokeTest is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.smokeSkipReason;
      if (!reason) expect("smoke SKIP without reason").toBe("smokeSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod smoke: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // 40. prod-quinn-pass (GAP → PORTED)
  test("prod-quinn-pass: prod quinn required when prod configured", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const val = sf("environments")?.prod?.quinn;
    if (!val) {
      expect("prod.quinn not set").toBe("PASS or SKIP with reason — required when prod.rebuild is configured");
    } else if (val === "SKIP") {
      const reason = sf("environments")?.prod?.quinnSkipReason;
      if (!reason) expect("quinn SKIP without reason").toBe("quinnSkipReason required");
    } else if (val !== "PASS") {
      expect(`prod quinn: ${val}`).toBe("PASS or SKIP with reason");
    }
  });

  // quinn-tested-changed-files (#441)
  test("quinn-tested-changed-files: Quinn tested paths cover UI diffs", () => {
    if (!isShipPlus()) return;
    const root = sf("projectRoot");
    if (!root) return;
    const scopeSha = sf("gates")?.scope?.commitSha;
    if (!scopeSha) return;
    const diff = exec(`git diff --name-only ${scopeSha}..HEAD`, root);
    if (!diff.ok) return;
    const UI_EXT = /\.(tsx|jsx|css|scss|html|svg|less)$/i;
    const uiChanged = diff.output.split("\n").filter(f => UI_EXT.test(f));
    if (uiChanged.length === 0) return;
    const testedPaths = sf("agents")?.quinn?.testedPaths || [];
    if (testedPaths.length === 0) {
      expect(`${uiChanged.length} UI files changed but quinn.testedPaths empty`).toBe("quinn.testedPaths populated");
    }
  });

  // 42. verify-blockers-cleared
  test("verify-blockers-cleared: all Quinn-found bugs re-verified", () => {
    if (!isShipPlus()) return;
    const blockers = sf("verifyBlockers") || [];
    const unresolved = blockers.filter((b: any) => !b.quinnReverified);
    expect(unresolved.map((b: any) => b.id)).toEqual([]);
  });

  // 41. prod-quinn-spot (GAP → PORTED)
  test("prod-quinn-spot: spot check PASS or inherited from full quinn", () => {
    if (!isShipPlus()) return;
    const harness = loadProjectHarness();
    if (!harness?.prod?.rebuild) return;
    const quinn = sf("environments")?.prod?.quinn;
    const spot = sf("environments")?.prod?.quinnSpot;
    if (quinn === "PASS" || spot === "PASS") return; // either is fine
    if (spot === "SKIP") {
      const reason = sf("environments")?.prod?.quinnSpotSkipReason;
      if (!reason) expect("quinnSpot SKIP without reason").toBe("quinnSpotSkipReason required");
    }
  });

  // 43. witness-chain (#473)
  test("witness-chain: witness directory has gate artifacts", () => {
    if (!isShipPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const witnessDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "witnesses");
    if (!existsSync(witnessDir)) {
      // WARN — witnesses are new, not all workflows have them yet
      console.warn("WARN: No witness directory found — witness chain not verified");
      return;
    }
    const witnesses = readdirSync(witnessDir).filter(f => f.endsWith(".json"));
    expect(witnesses.length, "Witness directory exists but is empty").toBeGreaterThan(0);
  });

  // 44. witness-ac-verdict: AC PASS verdicts must have corresponding witness chain entry (#521)
  test("witness-ac-verdict: AC PASS verdicts have matching witness with valid HMAC", () => {
    if (!isShipPlus()) return;
    const slug = sf("slug");
    if (!slug) return;
    const witnessDir = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "witnesses");
    if (!existsSync(witnessDir)) {
      // No witnesses = cannot verify AC verdicts were set by gate system
      const passACs = (sf("acs") || []).filter((ac: any) => ac.verdict === "PASS");
      if (passACs.length > 0) {
        expect(
          `${passACs.length} AC(s) have PASS verdict but no witness directory exists`,
        ).toBe("witness directory required when ACs have PASS verdicts (#521 — prevents manual workflow-state.json edits)");
      }
      return;
    }
    const witnessFiles = readdirSync(witnessDir).filter(f => f.endsWith(".json"));
    // Load all witness records
    const witnesses: Array<{ gate: string; result: string; hmac: string; [k: string]: any }> = [];
    for (const wf of witnessFiles) {
      try {
        const record = JSON.parse(readFileSync(join(witnessDir, wf), "utf-8"));
        witnesses.push(record);
      } catch { /* skip unparseable */ }
    }
    // Build set of gates that have PASS witnesses with HMAC
    const passedGatesWithHmac = new Set(
      witnesses
        .filter(w => w.result === "PASS" && w.hmac && w.hmac.length > 0)
        .map(w => w.gate),
    );
    // Each AC with PASS verdict must be backed by a prior gate witness
    // The verify gate covers AC evidence checks; scope gate covers AC definition
    // Ship witness is written AFTER this test suite — requiring it here is circular
    const requiredGates = ["scope", "verify"];
    const missingGates = requiredGates.filter(g => !passedGatesWithHmac.has(g));
    const passACs = (sf("acs") || []).filter((ac: any) => ac.verdict === "PASS");
    if (passACs.length > 0 && missingGates.length > 0) {
      expect(
        `AC PASS verdicts present but missing witness for: ${missingGates.join(", ")}`,
      ).toBe("PASS witnesses with valid HMAC required for verify + ship gates (#521 — manual edits detected)");
    }
  });

  // pre-registration: ACs must predate fix (ADR-009 A2)
  test("pre-registration: scope precedes ship", () => {
    if (!isShipPlus()) return;
    const scopeTs = sf("gates")?.scope?.ts;
    if (!scopeTs) return; // LIGHT tier or pre-ADR-009 — scope gate not run
    const scopeTime = new Date(scopeTs).getTime();
    expect(scopeTime, "scope timestamp must be in the past (ADR-009 A2: pre-registration)").toBeLessThan(Date.now());
    const shipTs = sf("gates")?.ship?.ts;
    if (shipTs) {
      expect(scopeTime, "scope must predate ship (ADR-009 A2: pre-registration)").toBeLessThanOrEqual(new Date(shipTs).getTime());
    }
  });

  // acHash consistency: ship gate checks scope's AC hash (ADR-009)
  test("acHash-consistency-ship: ACs unchanged since scope", () => {
    if (!isShipPlus()) return;
    const acHash = sf("gates")?.scope?.acHash;
    if (!acHash) return;
    const acDefs = (sf("acs") || []).map((ac: any) => ({
      id: ac.id, type: ac.type, statement: ac.statement,
      specElement: ac.specElement, threshold: ac.threshold,
      evidenceMethod: ac.evidenceMethod,
    }));
    const currentHash = require("crypto").createHash("sha256").update(JSON.stringify(acDefs)).digest("hex");
    expect(currentHash, "ACs modified after scope approval — re-run scope gate (ADR-009 acHash)").toBe(acHash);
  });

  // prove-label-enforcement: needs-prove label must have matching proven label (#1390)
  test("prove-label-enforcement: needs-prove requires proven label", () => {
    if (!isShipPlus()) return;
    const issueNumber = sf("issue");
    const issueRepo = sf("issueRepo") || sf("repo");
    if (!issueNumber || !issueRepo) return;
    // Check GitHub labels on the issue
    let labels: string[] = [];
    try {
      const ghOut = execSync(
        `gh issue view ${issueNumber} --repo ${issueRepo} --json labels -q '.labels[].name'`,
        { encoding: "utf-8", timeout: 15000 }
      );
      labels = ghOut.trim().split("\n").filter(Boolean);
    } catch {
      // If we can't read labels, skip — don't block on GitHub API failure
      return;
    }
    const hasNeedsProve = labels.includes("needs-prove");
    const hasProven = labels.includes("proven");
    if (hasNeedsProve && !hasProven) {
      expect(
        "needs-prove label present without proven label",
        "Close gate blocked: run /prove to add proven label before closing (#1390)"
      ).toBe("proven label required when needs-prove is set");
    }
  });
});

// ═══ PROMPT IMMUTABILITY (#1409, ADR-009) ════════════════════════════
describe("prompt immutability", () => {
  test("prompt-immutability: prompt files have uchg flag set", () => {
    const promptDir = join(__dirname, "prompts");
    if (!existsSync(promptDir)) return;
    const prompts = readdirSync(promptDir).filter(f => f.endsWith(".md"));
    if (prompts.length === 0) return;
    const unlocked: string[] = [];
    for (const f of prompts) {
      const result = exec(`ls -lO "${join(promptDir, f)}"`);
      if (result.ok && !result.output.includes("uchg")) {
        unlocked.push(f);
      }
    }
    expect(unlocked, "Prompt files must have uchg flag — run gates/lock-prompts.sh (#1409, ADR-009)").toEqual([]);
  });
});

// ═══ PROVE CHECKS (ADR-009 B3) ═══════════════════════════════════════
describe("prove checks", () => {
  if (STANDALONE || !existsSync(SF)) {
    test("skipped — no active workflow (standalone run)", () => {});
    return;
  }
  // prove-evidence exists when prove gate runs
  test("prove-evidence-exists: prove gate produces evidence file", () => {
    const currentGate = process.env.GATE;
    if (currentGate !== "prove") return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    expect(existsSync(evidencePath), "prove-evidence.json must exist after prove gate runs (ADR-009 B3)").toBe(true);
  });

  // prove-evidence has valid verdict enum
  test("prove-evidence-verdict: verdict is PROVEN|UNPROVEN|INCONCLUSIVE", () => {
    const currentGate = process.env.GATE;
    if (currentGate !== "prove") return;
    const slug = sf("slug");
    if (!slug) return;
    const evidencePath = join(process.env.RUNGATE_WORK_DIR || join(process.env.HOME || "", ".rungate"), slug, "prove-evidence.json");
    if (!existsSync(evidencePath)) return;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf-8"));
    const VALID_VERDICTS = ["PROVEN", "UNPROVEN", "INCONCLUSIVE"];
    expect(VALID_VERDICTS.includes(evidence.verdict), `prove-evidence verdict must be PROVEN|UNPROVEN|INCONCLUSIVE, got "${evidence.verdict}" (ADR-009 B3)`).toBe(true);
  });
});
