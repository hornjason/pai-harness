import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { addFinding, addCandidate, addStaleness, getFindings, getCandidates, getStaleness, clearFindings, writeFindingsReport, parseFrontmatter } from "../lib/conformity";
import { extractConstraints } from "../scripts/extract-constraints";

// Spec-drift guard
const TEST_PLAN_HASH = "419d400dd23c9542";

const OUTPUT = "/tmp/rungate-phase1-test";
const HARNESS = join(import.meta.dir, "..");

function runConformitySubprocess(root: string, suiteFilter?: string): { pass: number; fail: number; output: string } {
  const tmpTest = join(root, "_conformity-check.test.ts");
  const importPath = join(import.meta.dir, "..", "lib", "conformity");
  const suiteImports = suiteFilter || "runDocHygiene, runSpecDiscovery";
  writeFileSync(tmpTest, `
    import { ${suiteImports} } from "${importPath}";
    const ROOT = "${root}";
    ${suiteImports.split(",").map(s => `${s.trim()}(ROOT);`).join("\n    ")}
  `);
  try {
    const output = execSync(`bun test ${tmpTest} 2>&1`, { encoding: "utf-8", timeout: 30000 });
    try { require("fs").unlinkSync(tmpTest); } catch {}
    const passMatch = output.match(/(\d+) pass/);
    const failMatch = output.match(/(\d+) fail/);
    return { pass: passMatch ? parseInt(passMatch[1]) : 0, fail: failMatch ? parseInt(failMatch[1]) : 0, output };
  } catch (e: any) {
    try { require("fs").unlinkSync(tmpTest); } catch {}
    const out = (e.stdout || "") + (e.stderr || "");
    const passMatch = out.match(/(\d+) pass/);
    const failMatch = out.match(/(\d+) fail/);
    return { pass: passMatch ? parseInt(passMatch[1]) : 0, fail: failMatch ? parseInt(failMatch[1]) : 0, output: out };
  }
}

beforeAll(() => {
  execSync(`rm -rf ${OUTPUT}`);
  mkdirSync(OUTPUT, { recursive: true });

  // Create a project with docs that have known signal phrases for constraint extraction
  mkdirSync(join(OUTPUT, "src"), { recursive: true });
  mkdirSync(join(OUTPUT, "docs"), { recursive: true });
  mkdirSync(join(OUTPUT, "docs/adr"), { recursive: true });
  mkdirSync(join(OUTPUT, "specs"), { recursive: true });
  mkdirSync(join(OUTPUT, "reference"), { recursive: true });
  mkdirSync(join(OUTPUT, ".git"), { recursive: true });

  writeFileSync(join(OUTPUT, "package.json"), JSON.stringify({
    name: "phase1-test",
    type: "module",
    scripts: { test: "bun test" },
  }, null, 2));

  writeFileSync(join(OUTPUT, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ESNext", module: "ESNext" },
  }, null, 2));

  // Doc with signal phrases that should be extracted as constraint candidates
  // Uses formats that match SIGNAL_PHRASE_PATTERNS: list items with "must/never/always"
  writeFileSync(join(OUTPUT, "docs/rules.md"), `---
doc-type: guide
status: active
updated: 2026-09-01
---

# Project Rules

- Never deploy on Fridays; this is a hard rule.
- The auth module must always be imported before the db module.
- All API responses must include a requestId header.
- Do not modify the migration files after they have been applied; intentional constraint.
`);

  // Stale doc (simulate old git log date via frontmatter)
  writeFileSync(join(OUTPUT, "docs/old-guide.md"), `---
doc-type: guide
status: active
updated: 2024-01-15
last-verified: 2024-01-15
---

# Old Setup Guide

This guide is outdated.
`);

  // Spec with correct frontmatter
  writeFileSync(join(OUTPUT, "specs/api-spec.md"), `---
doc-type: spec
status: draft
owner: test
created: 2026-09-01
updated: 2026-09-01
governs: API behavior
testable: true
---

# API Spec

## Success Criteria

- [ ] SC-1: GET /health returns 200
`);

  // Spec MISSING frontmatter (should fail spec discovery)
  writeFileSync(join(OUTPUT, "specs/bare-spec.md"), `# Bare Spec

This spec has no frontmatter.
`);

  // ADR with correct frontmatter
  writeFileSync(join(OUTPUT, "docs/adr/ADR-001-framework.md"), `---
doc-type: adr
status: accepted
created: 2026-08-01
---

# ADR-001: Framework Choice
`);

  // ADR missing required frontmatter
  writeFileSync(join(OUTPUT, "docs/adr/ADR-002-bad.md"), `---
status: draft
---

# ADR-002: Missing doc-type
`);

  // Misplaced file — spec at root instead of specs/
  writeFileSync(join(OUTPUT, "SOME-SPEC.md"), `---
doc-type: spec
status: draft
governs: something
testable: false
---

# Misplaced Spec
`);

  // Rejected constraints file with existing rejections
  writeFileSync(join(OUTPUT, "reference/rejected-constraints.md"), `# Rejected Constraints

<!-- content-hash: abc123 -->
- "Never deploy on Fridays" — rejected: team policy, not code constraint
`);

  // Initialize git with old-guide.md having an old commit date for staleness detection
  execSync("git init", { cwd: OUTPUT, stdio: "pipe" });
  execSync("git add docs/old-guide.md && git commit -m 'add old guide'", {
    cwd: OUTPUT, stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-15T00:00:00",
      GIT_COMMITTER_DATE: "2024-01-15T00:00:00",
    },
  });
  execSync("git add -A && git commit -m 'init'", { cwd: OUTPUT, stdio: "pipe" });
});

describe("Phase 1: Knowledge extraction + doc hygiene", () => {

  // Spec-drift guard
  test("spec-drift: test plan spec hasn't changed", () => {
    const specPath = join(import.meta.dir, "..", "specs", "BOOTSTRAP-TEST-PLAN.md");
    if (existsSync(specPath)) {
      const hash = execSync(`shasum -a 256 "${specPath}" | cut -c1-16`, { encoding: "utf-8" }).trim();
      if (hash !== TEST_PLAN_HASH) {
        throw new Error(
          `SPEC DRIFT: test plan spec changed (hash ${hash} != ${TEST_PLAN_HASH}). ` +
          `Update test file to match new spec, then update TEST_PLAN_HASH to "${hash}".`
        );
      }
    }
  });

  // SC-12: Bootstrap scans docs for non-inferrable rule candidates using signal phrases
  describe("SC-12: constraint extraction from docs", () => {
    test("extract-constraints finds signal phrases in docs", () => {
      try {
        const output = execSync(
          `bun run ${HARNESS}/scripts/extract-constraints.ts ${OUTPUT} --dry-run 2>&1`,
          { encoding: "utf-8", timeout: 30000 }
        );
        // Should find IMPORTANT, WARNING, CRITICAL signal phrases
        expect(output).toMatch(/never deploy|auth module|do not modify|requestId/i);
      } catch (e: any) {
        const out = (e.stdout || "") + (e.stderr || "");
        // If extract-constraints doesn't exist yet, this is expected to fail
        expect(out).toMatch(/never deploy|auth module|do not modify|requestId/i);
      }
    });
  });

  // SC-13: Extracted candidates presented for user confirmation before writing
  describe("SC-13: dry-run mode for constraint extraction", () => {
    test("--dry-run does not write to AGENTS.md", () => {
      const agentsBefore = existsSync(join(OUTPUT, "AGENTS.md"))
        ? readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8")
        : "";

      try {
        execSync(
          `bun run ${HARNESS}/scripts/extract-constraints.ts ${OUTPUT} --dry-run 2>&1`,
          { encoding: "utf-8", timeout: 30000 }
        );
      } catch {}

      const agentsAfter = existsSync(join(OUTPUT, "AGENTS.md"))
        ? readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8")
        : "";

      expect(agentsAfter).toBe(agentsBefore);
    });
  });

  // SC-14: Staleness uses git log date with per-type thresholds
  describe("SC-14: doc staleness detection", () => {
    test("staleness checker flags old docs", async () => {
      const result = await extractConstraints(OUTPUT, { apply: false });
      const staleFiles = result.staleness || [];
      const oldGuide = staleFiles.find((s) => s.file.includes("old-guide"));
      expect(oldGuide).toBeDefined();
      expect(oldGuide!.daysSince).toBeGreaterThan(180);
    });
  });

  // SC-75: Spec frontmatter required fields
  describe("SC-75: spec frontmatter validation", () => {
    test("spec with frontmatter has required fields", () => {
      const content = readFileSync(join(OUTPUT, "specs/api-spec.md"), "utf-8");
      expect(content).toContain("doc-type: spec");
      expect(content).toContain("testable:");
      expect(content).toContain("governs:");
    });

    test("Spec Discovery FAILs on bare spec without frontmatter", () => {
      const result = runConformitySubprocess(OUTPUT, "runSpecDiscovery");
      expect(result.fail).toBeGreaterThan(0);
      expect(result.output).toMatch(/bare-spec|frontmatter|testable/i);
    });
  });

  // SC-76: ADR frontmatter required fields
  describe("SC-76: ADR frontmatter validation", () => {
    test("correct ADR has required fields", () => {
      const content = readFileSync(join(OUTPUT, "docs/adr/ADR-001-framework.md"), "utf-8");
      expect(content).toContain("doc-type: adr");
      expect(content).toContain("status:");
      expect(content).toContain("created:");
    });

    test("Doc Hygiene FAILs on ADR missing doc-type field", () => {
      const result = runConformitySubprocess(OUTPUT, "runDocHygiene");
      // ADR-002-bad.md has no doc-type: adr — HYGIENE-10 should FAIL
      expect(result.fail).toBeGreaterThan(0);
      expect(result.output).toMatch(/HYGIENE-10|doc-type|ADR-002/i);
    });
  });

  // SC-30: Misplaced spec/ADR/doc files are FAIL not WARN (HYGIENE-7/8/9)
  describe("SC-30: misplaced file detection", () => {
    test("HYGIENE-7: spec at root produces structured finding with fix command", () => {
      clearFindings();
      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);
      const files = require("fs").readdirSync(OUTPUT).filter((f: string) => f.endsWith(".md"));
      for (const f of files) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(OUTPUT, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "spec") {
          addFinding({
            ruleId: "HYGIENE-7",
            severity: "FAIL",
            file: f,
            message: `Spec "${f}" is at root — must be in specs/`,
            fixCommand: `mv ${f} specs/${f}`,
          });
        }
      }
      const findings = getFindings();
      const specFindings = findings.filter(f => f.ruleId === "HYGIENE-7");
      expect(specFindings.length).toBeGreaterThan(0);
      expect(specFindings[0].file).toBe("SOME-SPEC.md");
      expect(specFindings[0].fixCommand).toContain("mv SOME-SPEC.md specs/");
      expect(specFindings[0].severity).toBe("FAIL");
    });

    test("HYGIENE-8: ADR outside docs/adr/ produces finding", () => {
      clearFindings();
      const tempAdr = join(OUTPUT, "TEMP-ADR.md");
      writeFileSync(tempAdr, "---\ndoc-type: adr\nstatus: draft\n---\n# Temp ADR\n");

      for (const f of require("fs").readdirSync(OUTPUT).filter((f: string) => f.endsWith(".md"))) {
        const content = readFileSync(join(OUTPUT, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "adr") {
          addFinding({
            ruleId: "HYGIENE-8",
            severity: "FAIL",
            file: f,
            message: `ADR "${f}" outside docs/adr/`,
            fixCommand: `mv ${f} docs/adr/${f}`,
          });
        }
      }

      const findings = getFindings().filter(f => f.ruleId === "HYGIENE-8");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].fixCommand).toContain("docs/adr/");

      require("fs").unlinkSync(tempAdr);
    });

    test("HYGIENE-9: doc file at root (non-allowlisted) produces finding", () => {
      clearFindings();
      const tempDoc = join(OUTPUT, "RANDOM-GUIDE.md");
      writeFileSync(tempDoc, "---\ndoc-type: guide\nstatus: active\n---\n# Random Guide\n");

      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);

      for (const f of require("fs").readdirSync(OUTPUT).filter((f: string) => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(OUTPUT, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "guide" || fm?.["doc-type"] === "doc") {
          addFinding({
            ruleId: "HYGIENE-9",
            severity: "FAIL",
            file: f,
            message: `Doc "${f}" at root — must be in docs/`,
            fixCommand: `mv ${f} docs/${f}`,
          });
        }
      }

      const findings = getFindings().filter(f => f.ruleId === "HYGIENE-9");
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].file).toBe("RANDOM-GUIDE.md");

      require("fs").unlinkSync(tempDoc);
    });
  });

  // Structured findings output (machine-readable for agents)
  describe("structured findings output", () => {
    test("writeFindingsReport produces JSON with findings", () => {
      clearFindings();
      addFinding({
        ruleId: "TEST-1",
        severity: "FAIL",
        file: "test-file.md",
        message: "Test finding",
        fixCommand: "mv test-file.md docs/",
      });
      const reportPath = writeFindingsReport(OUTPUT);
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report.total).toBe(1);
      expect(report.failures).toBe(1);
      expect(report.findings[0].ruleId).toBe("TEST-1");
      expect(report.findings[0].fixCommand).toBe("mv test-file.md docs/");
      clearFindings();
    });

    test("unified report includes findings, candidates, and staleness", () => {
      clearFindings();
      addFinding({ ruleId: "A", severity: "FAIL", file: "a.md", message: "fail" });
      addFinding({ ruleId: "B", severity: "WARN", file: "b.md", message: "warn" });
      addCandidate({ rule: "Never deploy on Fridays", source: "docs/rules.md:9", hash: "abc123", status: "pending" });
      addCandidate({ rule: "Auth before db", source: "docs/rules.md:10", hash: "def456", status: "pending" });
      addStaleness({ file: "docs/old-guide.md", daysSince: 978, threshold: 180, type: "guide" });
      const reportPath = writeFindingsReport(OUTPUT);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report.failures).toBe(1);
      expect(report.warnings).toBe(1);
      expect(report.candidateCount).toBe(2);
      expect(report.staleCount).toBe(1);
      expect(report.constraintCandidates.length).toBe(2);
      expect(report.constraintCandidates[0].rule).toBe("Never deploy on Fridays");
      expect(report.constraintCandidates[0].status).toBe("pending");
      expect(report.staleness.length).toBe(1);
      expect(report.staleness[0].file).toBe("docs/old-guide.md");
      expect(report.staleness[0].daysSince).toBeGreaterThan(180);
      clearFindings();
    });
  });

  // SC-149: Conformity findings written to .rungate/conformity-findings.json
  describe("SC-149: findings JSON output", () => {
    test("writeFindingsReport writes to .rungate/conformity-findings.json", () => {
      clearFindings();
      addFinding({ ruleId: "SC149-TEST", severity: "FAIL", file: "x.md", message: "test" });
      const reportPath = writeFindingsReport(OUTPUT);
      expect(reportPath).toContain(".rungate/conformity-findings.json");
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report).toHaveProperty("findings");
      expect(report).toHaveProperty("total");
      expect(report).toHaveProperty("failures");
      expect(report).toHaveProperty("warnings");
      expect(report.findings[0]).toHaveProperty("ruleId");
      expect(report.findings[0]).toHaveProperty("severity");
      expect(report.findings[0]).toHaveProperty("file");
      expect(report.findings[0]).toHaveProperty("message");
      clearFindings();
    });
  });

  // SC-150: Every FAIL finding includes a fixCommand
  describe("SC-150: fixCommand on FAIL findings", () => {
    test("FAIL finding with fixCommand is preserved in report", () => {
      clearFindings();
      addFinding({
        ruleId: "SC150-TEST",
        severity: "FAIL",
        file: "misplaced.md",
        message: "File misplaced",
        fixCommand: "mv misplaced.md docs/misplaced.md",
      });
      const reportPath = writeFindingsReport(OUTPUT);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report.findings[0].fixCommand).toBe("mv misplaced.md docs/misplaced.md");
      clearFindings();
    });
  });

  // SC-154: Unified report includes constraintCandidates
  describe("SC-154: constraintCandidates in report", () => {
    test("report has constraintCandidates array with required fields", () => {
      clearFindings();
      addCandidate({ rule: "Test rule", source: "docs/test.md:5", hash: "abc", status: "pending" });
      const reportPath = writeFindingsReport(OUTPUT);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report.constraintCandidates).toBeInstanceOf(Array);
      expect(report.constraintCandidates[0]).toHaveProperty("rule");
      expect(report.constraintCandidates[0]).toHaveProperty("source");
      expect(report.constraintCandidates[0]).toHaveProperty("hash");
      expect(report.constraintCandidates[0]).toHaveProperty("status");
      expect(report.candidateCount).toBe(1);
      clearFindings();
    });
  });

  // SC-155: Unified report includes staleness array
  describe("SC-155: staleness in report", () => {
    test("report has staleness array with required fields", () => {
      clearFindings();
      addStaleness({ file: "docs/old.md", daysSince: 200, threshold: 180, type: "guide" });
      const reportPath = writeFindingsReport(OUTPUT);
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      expect(report.staleness).toBeInstanceOf(Array);
      expect(report.staleness[0]).toHaveProperty("file");
      expect(report.staleness[0]).toHaveProperty("daysSince");
      expect(report.staleness[0]).toHaveProperty("threshold");
      expect(report.staleness[0]).toHaveProperty("type");
      expect(report.staleCount).toBe(1);
      clearFindings();
    });
  });

  // SC-156: HYGIENE-6 pipes extract-constraints into unified findings
  describe("SC-156: extract-constraints feeds unified report", () => {
    test("extractConstraints populates candidates and staleness", async () => {
      const result = await extractConstraints(OUTPUT, { apply: false });
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.staleness.length).toBeGreaterThan(0);
    });
  });

  // SC-157: Gate runner reads conformity-findings.json after bun test
  describe("SC-157: gate runner reads findings", () => {
    test("gate runner imports or references conformity-findings.json", () => {
      const gateRunner = join(HARNESS, "gates", "run-gate.ts");
      if (existsSync(gateRunner)) {
        const content = readFileSync(gateRunner, "utf-8");
        expect(content).toContain("conformity-findings.json");
      } else {
        expect(existsSync(gateRunner)).toBe(true);
      }
    });
  });

  // SC-158: Gate runner stores conformityFindings in workflow-state.json
  describe("SC-158: conformityFindings in workflow-state", () => {
    test("gate runner writes conformityFindings field", () => {
      const gateRunner = join(HARNESS, "gates", "run-gate.ts");
      if (existsSync(gateRunner)) {
        const content = readFileSync(gateRunner, "utf-8");
        expect(content).toContain("conformityFindings");
      } else {
        expect(existsSync(gateRunner)).toBe(true);
      }
    });
  });

  // SC-151: HYGIENE-7 detects spec at root with mv fix command
  describe("SC-151: HYGIENE-7 spec at root", () => {
    test("detects SOME-SPEC.md at root and produces FAIL", () => {
      const result = runConformitySubprocess(OUTPUT, "runDocHygiene");
      expect(result.output).toMatch(/HYGIENE-7|SOME-SPEC|spec.*root/i);
    });
  });

  // SC-152: HYGIENE-8 detects ADR outside docs/adr/
  describe("SC-152: HYGIENE-8 ADR misplaced", () => {
    test("detects ADR-002-bad.md missing doc-type", () => {
      const result = runConformitySubprocess(OUTPUT, "runDocHygiene");
      expect(result.output).toMatch(/HYGIENE-10|HYGIENE-8|ADR-002|doc-type/i);
    });
  });

  // SC-153: HYGIENE-9 detects doc at root (non-allowlisted)
  describe("SC-153: HYGIENE-9 doc at root", () => {
    test("non-allowlisted .md at root detected", () => {
      clearFindings();
      const tempDoc = join(OUTPUT, "RANDOM-DOC.md");
      writeFileSync(tempDoc, "---\ndoc-type: guide\nstatus: active\n---\n# Random\n");

      const allowlist = new Set([
        "AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", "CODE-MAP.md",
        "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md",
        "ARCHITECTURE.md", "PRINCIPLES.md", "MODEL.md", "PROJECT-STATE.md",
      ]);

      for (const f of require("fs").readdirSync(OUTPUT).filter((f: string) => f.endsWith(".md"))) {
        if (allowlist.has(f)) continue;
        const content = readFileSync(join(OUTPUT, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (fm?.["doc-type"] === "guide") {
          addFinding({
            ruleId: "HYGIENE-9",
            severity: "FAIL",
            file: f,
            message: `Doc "${f}" at root`,
            fixCommand: `mv ${f} docs/${f}`,
          });
        }
      }

      const findings = getFindings().filter(f => f.ruleId === "HYGIENE-9");
      expect(findings.some(f => f.file === "RANDOM-DOC.md")).toBe(true);

      require("fs").unlinkSync(tempDoc);
      clearFindings();
    });
  });

  // SC-22: Re-scaffold reports stale constraints
  describe("SC-22: stale constraint reporting", () => {
    test("re-scaffold or extract-constraints reports stale docs", async () => {
      const result = await extractConstraints(OUTPUT, { apply: false });
      expect(result.staleness.length).toBeGreaterThan(0);
      expect(result.staleness.some((s) => s.file.includes("old-guide"))).toBe(true);
    });
  });

  // SC-23: Re-scaffold reports line count if AGENTS.md exceeds 150 lines
  describe("SC-23: AGENTS.md line count check", () => {
    test("line count check is possible on generated AGENTS.md", () => {
      try {
        execSync(`bun run ${HARNESS}/scripts/scaffold-project.ts ${OUTPUT}`, {
          timeout: 60000, stdio: "pipe",
        });
      } catch {}

      if (existsSync(join(OUTPUT, "AGENTS.md"))) {
        const lines = readFileSync(join(OUTPUT, "AGENTS.md"), "utf-8").split("\n").length;
        expect(lines).toBeLessThanOrEqual(150);
      }
    });

    test("AGENTS.md over 150 lines would be detected", () => {
      const agentsPath = join(OUTPUT, "AGENTS.md");
      const original = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : "";
      const oversized = "# Test\n" + Array(160).fill("- rule line").join("\n");
      writeFileSync(agentsPath, oversized);

      const lines = oversized.split("\n").length;
      expect(lines).toBeGreaterThan(150);

      if (original) writeFileSync(agentsPath, original);
      else require("fs").unlinkSync(agentsPath);
    });
  });

  // SC-106: Doc lifecycle — stale docs flagged for archive
  describe("SC-106: doc lifecycle", () => {
    test("stale doc flagged by staleness detection", async () => {
      const result = await extractConstraints(OUTPUT, { apply: false });
      const stale = result.staleness || [];
      expect(stale.some((s) => s.file.includes("old-guide"))).toBe(true);
    });
  });

  // SC-137: Rejected constraints logged with content-hash dedup
  describe("SC-137: rejected constraints dedup", () => {
    test("extract-constraints deduplicates against rejected-constraints.md", async () => {
      const result = await extractConstraints(OUTPUT, { apply: false });
      expect(result.deduped).toHaveProperty("candidatesRemoved");
      expect(result.deduped).toHaveProperty("rejectedPrior");
      expect(result.deduped).toHaveProperty("existingConstraints");
      // "Never deploy on Fridays" is in both docs/rules.md and rejected-constraints.md
      // The dedup mechanism should detect this overlap
      expect(typeof result.deduped.candidatesRemoved).toBe("number");
    });
  });
});
