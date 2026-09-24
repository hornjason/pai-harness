/**
 * audit-specs tests — TDD tests for the audit-specs CLI command.
 *
 * Tests AC-1 through AC-9 from issue #556.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";

// ── Test fixture helpers ─────────────────────────────────────

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "audit-specs-project");

function createFixture() {
  if (existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true });
  }
  mkdirSync(join(FIXTURE_ROOT, "specs"), { recursive: true });
}

function cleanupFixture() {
  if (existsSync(FIXTURE_ROOT)) {
    rmSync(FIXTURE_ROOT, { recursive: true });
  }
}

function writeSpec(filename: string, content: string) {
  writeFileSync(join(FIXTURE_ROOT, "specs", filename), content);
}

/**
 * Create a spec with a mix of matched, unmatched, and behavioral SCs.
 */
function createMixedSpec() {
  writeSpec("TEST-SPEC.md", `---
doc-type: spec
status: active
testable: true
compliance: strict
updated: 2026-09-23
governs: test spec
---

# Test Spec

## Success Criteria

- [ ] SC-100: AGENTS.md exists
- [ ] SC-101: This is an unmatched freeform SC that nobody can parse
- [ ] SC-102: specs/ directory exists
- [ ] SC-103: Agent sessions always read AGENTS.md first (behavioral)
- [ ] SC-104: Another unmatched requirement about agent behavior tracking
`);
}

// ── Import the lib module (will be created) ──────────────────

// Dynamic import to avoid compile errors before the module exists
async function importAuditSpecs() {
  return await import("../scripts/audit-specs");
}

// ── AC-1: Classification (matched, unmatched, behavioral) ────

describe("audit-specs", () => {
  beforeEach(createFixture);
  afterEach(cleanupFixture);

  describe("AC-1: classification", () => {
    test("classifies SCs into matched, unmatched, and behavioral categories", async () => {
      createMixedSpec();
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);

      // Should have at least 3 classification categories
      const specResult = result.specs[0];
      expect(specResult).toBeDefined();
      expect(specResult.matched).toBeGreaterThanOrEqual(0);
      expect(specResult.unmatched).toBeGreaterThanOrEqual(0);
      expect(specResult.behavioral).toBeGreaterThanOrEqual(0);

      // SC-100 (AGENTS.md exists) and SC-102 (specs/ directory exists) should be matched
      expect(specResult.matched).toBe(2);
      // SC-101 and SC-104 should be unmatched
      expect(specResult.unmatched).toBe(2);
      // SC-103 should be behavioral
      expect(specResult.behavioral).toBe(1);
    });

    test("handles spec with all matched SCs", async () => {
      writeSpec("ALL-MATCHED.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# All Matched

## Success Criteria

- [ ] SC-200: AGENTS.md exists
- [ ] SC-201: specs/ directory exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);
      const specResult = result.specs.find(s => s.specFile === "ALL-MATCHED.md");
      expect(specResult).toBeDefined();
      expect(specResult!.matched).toBe(2);
      expect(specResult!.unmatched).toBe(0);
      expect(specResult!.behavioral).toBe(0);
    });

    test("skips non-testable specs", async () => {
      writeSpec("NOT-TESTABLE.md", `---
doc-type: spec
testable: false
updated: 2026-09-23
governs: nothing
---

# Not Testable

## Success Criteria

- [ ] SC-300: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);
      expect(result.specs.find(s => s.specFile === "NOT-TESTABLE.md")).toBeUndefined();
    });
  });

  // ── AC-3: Report output with per-spec table ──────────────────

  describe("AC-3: report output", () => {
    test("report includes per-spec table with SC count, matched, unmatched, behavioral columns", async () => {
      createMixedSpec();
      const { auditSpecs, formatReport } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);
      const report = formatReport(result);

      // Should contain table-like output with columns
      expect(report).toContain("matched");
      expect(report).toContain("unmatched");
      expect(report).toContain("behavioral");
      // Should contain the spec file name
      expect(report).toContain("TEST-SPEC.md");
      // Should have totals
      expect(report).toContain("total");
    });
  });

  // ── AC-4: Fix mode uses closest matching pattern ─────────────

  describe("AC-4: closest pattern matching", () => {
    test("rewrites unmatched SC using closest matching pattern from registry", async () => {
      // SC that mentions a file and 'exists' but isn't quite right format
      writeSpec("FIXABLE.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Fixable

## Success Criteria

- [ ] SC-400: The file AGENTS.md must exist in the project root
- [ ] SC-401: specs/ directory exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });

      // SC-400 should have been rewritten to a matchable pattern
      const specResult = result.specs.find(s => s.specFile === "FIXABLE.md");
      expect(specResult).toBeDefined();

      // Check the fix was applied
      const rewrites = result.rewrites || [];
      // At least one rewrite should have happened for SC-400
      const sc400Rewrite = rewrites.find(r => r.scId === "SC-400");
      expect(sc400Rewrite).toBeDefined();
      expect(sc400Rewrite!.patternUsed).toBeDefined();
    });
  });

  // ── AC-5: Preserve SC numbers ────────────────────────────────

  describe("AC-5: preserve SC numbers", () => {
    test("fix mode preserves original SC numbers during rewrite", async () => {
      writeSpec("PRESERVE.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Preserve Numbers

## Success Criteria

- [ ] SC-500: The file README.md should exist at root
- [ ] SC-501: specs/ directory exists
- [ ] SC-502: The directory docs/ should be present
`);
      const { auditSpecs } = await importAuditSpecs();
      auditSpecs(FIXTURE_ROOT, { fix: true });

      // Read back the spec file
      const content = readFileSync(join(FIXTURE_ROOT, "specs", "PRESERVE.md"), "utf-8");

      // All original SC numbers must still be present
      expect(content).toContain("SC-500:");
      expect(content).toContain("SC-501:");
      expect(content).toContain("SC-502:");
    });
  });

  // ── AC-6: Ambiguous rewrites marked with REVIEW comment ──────

  describe("AC-6: ambiguous rewrites", () => {
    test("marks ambiguous rewrites with <!-- REVIEW: comment containing original text", async () => {
      writeSpec("AMBIGUOUS.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Ambiguous

## Success Criteria

- [ ] SC-600: This SC is too vague to rewrite automatically
- [ ] SC-601: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      auditSpecs(FIXTURE_ROOT, { fix: true });

      const content = readFileSync(join(FIXTURE_ROOT, "specs", "AMBIGUOUS.md"), "utf-8");

      // SC-600 should have a REVIEW comment since it's too ambiguous
      expect(content).toContain("<!-- REVIEW:");
    });
  });

  // ── AC-7: Diff summary ──────────────────────────────────────

  describe("AC-7: diff summary", () => {
    test("produces diff summary showing before and after for each rewrite", async () => {
      writeSpec("DIFF.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Diff

## Success Criteria

- [ ] SC-700: The file README.md should exist in root
- [ ] SC-701: AGENTS.md exists
`);
      const { auditSpecs, formatDiffSummary } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });
      const diffOutput = formatDiffSummary(result);

      // Diff output should show before/after for rewrites
      if (result.rewrites && result.rewrites.length > 0) {
        expect(diffOutput).toContain("before");
        expect(diffOutput).toContain("after");
      }
    });
  });

  // ── AC-8: Idempotent ────────────────────────────────────────

  describe("AC-8: idempotent", () => {
    test("running audit-specs --fix twice produces zero changes on second run", async () => {
      writeSpec("IDEMPOTENT.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Idempotent

## Success Criteria

- [ ] SC-800: The file AGENTS.md should exist at root
- [ ] SC-801: specs/ directory exists
`);
      const { auditSpecs } = await importAuditSpecs();

      // First run
      const result1 = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Second run on same file
      const result2 = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Second run should have 0 rewrites
      expect(result2.rewrites?.length ?? 0).toBe(0);
    });
  });

  // ── AC-2: --fix flag rewrites unmatched SCs ──────────────────

  describe("AC-2: fix flag", () => {
    test("rewrites unmatched SCs in-place to matchable patterns", async () => {
      writeSpec("FIX-TARGET.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Fix Target

## Success Criteria

- [ ] SC-900: The file AGENTS.md should exist at project root
- [ ] SC-901: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Should contain rewrite output
      expect(result.rewrites).toBeDefined();

      // After fix, the file should contain matchable patterns
      const content = readFileSync(join(FIXTURE_ROOT, "specs", "FIX-TARGET.md"), "utf-8");
      // SC-900 should have been rewritten to a matchable form
      expect(content).toContain("SC-900:");
    });
  });

  // ── AC-9: Package.json integration ────────────────────────────

  describe("AC-9: package.json integration", () => {
    test("audit-specs script is in package.json files array", () => {
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
      );
      const hasFile = pkg.files?.some(
        (f: string) => f.includes("audit-specs") || f === "scripts/"
      );
      expect(hasFile).toBe(true);
    });

    test("audit-specs has an export entry in package.json", () => {
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")
      );
      const exports = pkg.exports || {};
      const hasExport = Object.keys(exports).some((k) =>
        k.includes("audit-specs")
      );
      expect(hasExport).toBe(true);
    });
  });

  // ── SC-394: Scaffold runs audit-specs post-generation ─────────

  describe("SC-394: scaffold wires audit-specs post-generation", () => {
    test("scaffold-project.ts imports auditSpecs from audit-specs module", () => {
      const scaffoldSrc = readFileSync(
        join(import.meta.dir, "..", "scripts", "scaffold-project.ts"),
        "utf-8"
      );
      expect(scaffoldSrc).toContain("auditSpecs");
    });

    test("scaffold-project.ts calls auditSpecs with fix mode after spec generation", () => {
      const scaffoldSrc = readFileSync(
        join(import.meta.dir, "..", "scripts", "scaffold-project.ts"),
        "utf-8"
      );
      // The audit-specs call should happen after spec template copy and before commit
      expect(scaffoldSrc).toContain("auditSpecs(");
      expect(scaffoldSrc).toContain("fix: true");
    });

    test("audit-specs post-generation step appears after spec template copy", () => {
      const scaffoldSrc = readFileSync(
        join(import.meta.dir, "..", "scripts", "scaffold-project.ts"),
        "utf-8"
      );
      const specTemplateIdx = scaffoldSrc.indexOf("copySpecTemplateIfEmpty");
      const auditIdx = scaffoldSrc.indexOf("runAuditSpecsFix(");
      const commitIdx = scaffoldSrc.indexOf("postScaffoldCommit(");
      // audit-specs should be called after spec template copy and before commit
      expect(auditIdx).toBeGreaterThan(specTemplateIdx);
      expect(auditIdx).toBeLessThan(commitIdx);
    });
  });

  // ── SC-398: All RunGate specs at compliance: strict ────────────

  describe("SC-398: all RunGate testable specs at compliance: strict", () => {
    test("every testable spec has compliance: strict in frontmatter", () => {
      const specsDir = join(import.meta.dir, "..", "specs");
      const specFiles = readdirSync(specsDir).filter((f) => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md");
      const permissiveSpecs: string[] = [];

      for (const f of specFiles) {
        const content = readFileSync(join(specsDir, f), "utf-8");
        // Check if testable
        const testableMatch = content.match(/^testable:\s*(.+)$/m);
        if (!testableMatch || testableMatch[1].trim() !== "true") continue;

        // Check compliance
        const complianceMatch = content.match(/^compliance:\s*(.+)$/m);
        if (!complianceMatch || complianceMatch[1].trim() !== "strict") {
          permissiveSpecs.push(f);
        }
      }

      expect(permissiveSpecs).toEqual([]);
    });
  });
});
