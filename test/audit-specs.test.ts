/**
 * audit-specs tests — TDD tests for the audit-specs CLI command.
 *
 * Tests AC-1 through AC-9 from issue #556.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { scaffoldPipelineSource } from "./helpers/scaffold-fixture";
import { loadRungateConfig } from "../lib/config-loader";

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

      // Covers SC-100, SC-102 — AGENTS.md exists, and specs/ directory
      // exists. Both should be matched.
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

- [ ] SC-9430: This SC is too vague to rewrite automatically
- [ ] SC-9431: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      auditSpecs(FIXTURE_ROOT, { fix: true });

      const content = readFileSync(join(FIXTURE_ROOT, "specs", "AMBIGUOUS.md"), "utf-8");

      // SC-9430 should have a REVIEW comment since it's too ambiguous
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

- [ ] SC-9441: The file AGENTS.md should exist at project root
- [ ] SC-9442: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Should contain rewrite output
      expect(result.rewrites).toBeDefined();

      // After fix, the file should contain matchable patterns
      const content = readFileSync(join(FIXTURE_ROOT, "specs", "FIX-TARGET.md"), "utf-8");
      // SC-9441 should have been rewritten to a matchable form
      expect(content).toContain("SC-9441:");
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
    test("scaffold pipeline imports auditSpecs from audit-specs module", () => {
      // After decomposition, this logic lives in lib/scaffold/steps.ts
      const stepsSrc = readFileSync(
        join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"),
        "utf-8"
      );
      expect(stepsSrc).toContain("auditSpecs");
    });

    test("scaffold pipeline calls auditSpecs with fix mode after spec generation", () => {
      // After decomposition, this logic lives in lib/scaffold/steps.ts
      const stepsSrc = readFileSync(
        join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"),
        "utf-8"
      );
      // The audit-specs call should happen in runAuditSpecsFix
      expect(stepsSrc).toContain("auditSpecs(");
      expect(stepsSrc).toContain("fix: true");
    });

    test("audit-specs post-generation step appears after spec template copy", () => {
      // Read from the pipeline rather than scripts/scaffold-project.ts, which
      // held the write body until #398 split it so audit could rehearse the
      // real steps against a clone. The ordering property is unchanged; only
      // the file it lives in moved.
      const src = scaffoldPipelineSource();
      const specTemplateIdx = src.indexOf("copySpecTemplateIfEmpty");
      const auditIdx = src.indexOf("runAuditSpecsFix(");
      const commitIdx = src.indexOf("postScaffoldCommit(");
      // An index of -1 orders earlier than everything, so a call that vanished
      // would satisfy `auditIdx < commitIdx` while measuring nothing.
      expect([specTemplateIdx, auditIdx, commitIdx].filter(i => i < 0)).toEqual([]);
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
        // Check if testable (accept both "true" and "yes")
        const testableMatch = content.match(/^testable:\s*(.+)$/m);
        const testableValue = testableMatch?.[1].trim();
        if (!testableValue || (testableValue !== "true" && testableValue !== "yes")) continue;

        // Check compliance
        const complianceMatch = content.match(/^compliance:\s*(.+)$/m);
        if (!complianceMatch || complianceMatch[1].trim() !== "strict") {
          permissiveSpecs.push(f);
        }
      }

      expect(permissiveSpecs).toEqual([]);
    });
  });

  // ── AC-5: Non-zero exit for strict specs with unmatched SCs ────

  describe("AC-5: strict spec exit code", () => {
    test("strictUnmatched counts only SCs from strict specs", async () => {
      writeSpec("STRICT-SPEC.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Strict Spec

## Success Criteria

- [ ] SC-9470: AGENTS.md exists
- [ ] SC-9471: This is an unmatched freeform SC that nobody can parse
`);
      writeSpec("PERMISSIVE-SPEC.md", `---
doc-type: spec
testable: true
compliance: permissive
updated: 2026-09-23
governs: test
---

# Permissive Spec

## Success Criteria

- [ ] SC-9472: AGENTS.md exists
- [ ] SC-9473: Another unmatched freeform SC nobody can parse
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);

      // Total unmatched should include both specs
      expect(result.totalUnmatched).toBe(2);
      // strictUnmatched should only count from strict spec
      expect(result.strictUnmatched).toBe(1);
    });

    test("auditSpecs result includes compliance per spec", async () => {
      writeSpec("COMP-STRICT.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Strict

## Success Criteria

- [ ] SC-9480: AGENTS.md exists
`);
      writeSpec("COMP-PERMISSIVE.md", `---
doc-type: spec
testable: true
compliance: permissive
updated: 2026-09-23
governs: test
---

# Permissive

## Success Criteria

- [ ] SC-9481: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);

      const strictSpec = result.specs.find((s: any) => s.specFile === "COMP-STRICT.md");
      const permissiveSpec = result.specs.find((s: any) => s.specFile === "COMP-PERMISSIVE.md");
      expect(strictSpec?.compliance).toBe("strict");
      expect(permissiveSpec?.compliance).toBe("permissive");
    });

    test("defaults to strict when compliance field is absent", async () => {
      writeSpec("NO-COMPLIANCE.md", `---
doc-type: spec
testable: true
updated: 2026-09-23
governs: test
---

# No Compliance

## Success Criteria

- [ ] SC-9490: AGENTS.md exists
`);
      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);

      const spec = result.specs.find((s: any) => s.specFile === "NO-COMPLIANCE.md");
      expect(spec?.compliance).toBe("strict");
    });
  });

  // ── AC-6: Consumer specs excluded from strict migration ────────

  describe("AC-6: consumer specs excluded", () => {
    test("the resolved config's consumers array is empty", () => {
      // #1035: read `.claude/rungate.json` by path until ADR-001 Step E
      // deleted it. `loadRungateConfig` throws on a missing or malformed
      // config, which is the behaviour this arm wants — an unreadable config
      // is not a config with no consumers in it.
      const config = loadRungateConfig(join(import.meta.dir, ".."));
      expect(config.consumers).toEqual([]);
    });

    test("audit-specs scopes to project specs/ directory only", async () => {
      // Create a mock project with specs in a non-standard location
      const otherDir = join(FIXTURE_ROOT, "other-specs");
      mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, "CONSUMER-SPEC.md"), `---
doc-type: spec
testable: true
compliance: permissive
updated: 2026-09-23
governs: test
---

# Consumer Spec

## Success Criteria

- [ ] SC-9495: AGENTS.md exists
`);
      // Also create a normal spec in specs/
      writeSpec("LOCAL-SPEC.md", `---
doc-type: spec
testable: true
compliance: strict
updated: 2026-09-23
governs: test
---

# Local Spec

## Success Criteria

- [ ] SC-9496: AGENTS.md exists
`);

      const { auditSpecs } = await importAuditSpecs();
      const result = auditSpecs(FIXTURE_ROOT);

      // Should only include specs from specs/, not other-specs/
      const specFiles = result.specs.map((s: any) => s.specFile);
      expect(specFiles).toContain("LOCAL-SPEC.md");
      expect(specFiles).not.toContain("CONSUMER-SPEC.md");
    });
  });

  // ── AC-3: No flagged markers in specs ──────────────────────────

  describe("AC-3: no flagged markers remain", () => {
    test("no FLAGGED, AMBIGUOUS, or pending-REVIEW markers in any RunGate spec", () => {
      const specsDir = join(import.meta.dir, "..", "specs");
      const specFiles = readdirSync(specsDir).filter(
        (f) => f.endsWith(".md") && f !== "SPEC-TEMPLATE.md"
      );
      const flaggedSpecs: string[] = [];

      for (const f of specFiles) {
        if (pendingReviewMarker(readFileSync(join(specsDir, f), "utf-8"))) {
          flaggedSpecs.push(f);
        }
      }

      // Non-empty first: a census over zero files is perfect agreement.
      expect(specFiles.length).toBeGreaterThan(5);
      expect(flaggedSpecs).toEqual([]);
    });

    test("#827: a parked original is still refused", () => {
      expect(
        pendingReviewMarker("- [ ] SC-1: x\n<!-- REVIEW: original — the words it used to have -->\n"),
      ).toBe("<!-- REVIEW: original");
    });

    test("#827: a coverage record on an untouched line is not a pending marker", () => {
      // The exact string `scripts/audit-specs.ts` writes for a KEPT line.
      expect(
        pendingReviewMarker("- [ ] SC-1: x\n<!-- REVIEW: unmatched (no registry pattern was close enough) -->\n"),
      ).toBeNull();
    });
  });

  /**
   * The reporter reads `lib/sc-ids.ts`, not a private regex of its own.
   *
   * `extractSCs` was `/^- \[ \] (SC-\w+):\s*(.+)$/gm`, which is wrong in two
   * independent directions:
   *
   * - `SC-\w+` cannot match a `CRC-` id, so
   *   `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` reported `total 0` for 56
   *   criteria, on a `compliance: strict` spec, exiting clean.
   * - the `- [ ] ` literal cannot match a TICKED criterion in any namespace,
   *   so the `SC-` side had been under-reporting since the script was
   *   written. Nobody noticed because 66 is a plausible number.
   *
   * Measured over the 21 testable top-level specs, before and after:
   * **66 reported → 1409 declared**, the difference being 1287 ticked and 56
   * `CRC-`. The reporter was seeing 4.7% of the corpus.
   *
   * Both halves need their own case, because each alone goes green under a
   * fix for the other: widening the prefix without the checkbox still misses
   * 1287, and widening the checkbox without the prefix still misses 56.
   */
  describe("the reporter and the flipper agree on what a criterion is", () => {
    function writeTickedAndCrcSpec() {
      writeSpec("BINDING-SPEC.md", `---
doc-type: spec
status: active
testable: true
compliance: strict
updated: 2026-10-23
governs: binding fixture
---

## Success Criteria

- [ ] SC-9601: An unmatched open criterion nobody can bind to a pattern
- [x] SC-9602: A ticked criterion that no registry pattern can bind either
- [ ] CRC-9603: An unmatched open criterion in the second namespace
- [x] CRC-9604: A ticked criterion in the second namespace
`);
    }

    test("a CRC criterion is counted — the prefix half", async () => {
      writeTickedAndCrcSpec();
      const { auditSpecs } = await importAuditSpecs();
      const spec = auditSpecs(FIXTURE_ROOT).specs.find(s => s.specFile === "BINDING-SPEC.md")!;
      const seen = [...spec.matchedSCs, ...spec.unmatchedSCs, ...spec.behavioralSCs].map(c => c.id);
      expect(seen, "a CRC- criterion was invisible to the reporter").toContain("CRC-9603");
      // Control: the SC- criterion beside it was always visible, so a change
      // that lost it would be caught here rather than read as success.
      expect(seen).toContain("SC-9601");
    });

    test("a ticked criterion is counted — the checkbox half", async () => {
      writeTickedAndCrcSpec();
      const { auditSpecs } = await importAuditSpecs();
      const spec = auditSpecs(FIXTURE_ROOT).specs.find(s => s.specFile === "BINDING-SPEC.md")!;
      expect(spec.total, "ticked criteria are missing from the denominator").toBe(4);
      expect(spec.ticked).toBe(2);
    });

    test("ticked criteria stay OUT of the three-way split", async () => {
      // `unmatched` feeds `strictUnmatched`, the exit code and the `--fix`
      // candidate set. Widening `total` to the whole corpus must not widen
      // it, or the number stops meaning "open work the engine cannot bind"
      // and `--fix` is pointed at finished specs.
      writeTickedAndCrcSpec();
      const { auditSpecs } = await importAuditSpecs();
      const r = auditSpecs(FIXTURE_ROOT);
      const spec = r.specs.find(s => s.specFile === "BINDING-SPEC.md")!;
      const classified = [...spec.matchedSCs, ...spec.unmatchedSCs, ...spec.behavioralSCs].map(
        c => c.id,
      );
      expect(classified.sort()).toEqual(["CRC-9603", "SC-9601"]);
      expect(spec.unmatched, "a ticked criterion reached `unmatched`").toBe(2);
      expect(r.strictUnmatched).toBe(2);
    });

    test("the columns account for every criterion", async () => {
      // total = ticked + matched + unmatched + behavioral, over the REAL
      // tree. A fixture cannot show this: the identity is what says no
      // criterion was dropped between the parse and the report, and the
      // tree is the only population big enough for a drop to hide in.
      const { auditSpecs } = await importAuditSpecs();
      const r = auditSpecs(join(import.meta.dir, ".."));
      expect(r.totalSCs, "the real spec scan found nothing").toBeGreaterThan(500);
      expect(r.totalTicked, "no ticked criteria — the checkbox half regressed").toBeGreaterThan(0);
      expect(r.totalTicked + r.totalMatched + r.totalUnmatched + r.totalBehavioral).toBe(r.totalSCs);
    });

    test("--fix touches exactly what it touched before, and nothing new", async () => {
      // The safety property, and the reason the reporter and the writer
      // widened differently. Reporting a criterion costs a row; rewriting
      // one edits a spec, and #1286 is open about `--fix` damaging a file it
      // should not have touched. Widening the reporter alone would have
      // handed the writer 1287 ticked lines and 55 CRC ones.
      writeTickedAndCrcSpec();
      const path = join(FIXTURE_ROOT, "specs", "BINDING-SPEC.md");
      const before = readFileSync(path, "utf-8");
      const { auditSpecs } = await importAuditSpecs();
      auditSpecs(FIXTURE_ROOT, { fix: true });
      const after = readFileSync(path, "utf-8");

      const lineFor = (text: string, id: string) =>
        text.split("\n").findIndex(l => l.includes(id));
      // Nothing ticked moved, in either namespace.
      for (const id of ["SC-9602", "CRC-9604"]) {
        const line = (t: string) => t.split("\n").find(l => l.includes(id));
        expect(line(after), `${id} was rewritten`).toBe(line(before));
      }
      // Nothing in the second namespace moved either, ticked or not: the
      // writer's population is unchanged by this PR.
      expect(
        after.split("\n")[lineFor(after, "CRC-9603") + 1],
        "--fix annotated a CRC- criterion; the writer widened",
      ).not.toContain("REVIEW:");

      // Control: --fix is NOT inert here. The open SC- criterion is the one
      // it is allowed to touch, and without this the assertions above are
      // green for a run that did nothing at all.
      expect(before, "--fix changed nothing, so this proves nothing").not.toBe(after);
      expect(after.split("\n")[lineFor(after, "SC-9601") + 1]).toContain("REVIEW:");
    });
  });
});

/**
 * Does `content` carry a marker that means a human still has to look?
 *
 * One exported binding, so there is one thing to mutate and one place that
 * decides. Returns the offending marker text, or `null`. Declared after the
 * describe block it serves; hoisting makes it reachable from inside it.
 *
 * #827: this used to refuse every `<!-- REVIEW:` comment, and
 * `scripts/audit-specs.ts` writes TWO comments under that prefix, for
 * opposite reasons:
 *
 * - `<!-- REVIEW: original — … -->` is parked text. The criterion WAS
 *   rewritten, ambiguously, and the words it used to have are kept beside it
 *   so somebody can choose. That is a to-do and it must not survive.
 * - `<!-- REVIEW: unmatched (…) -->` is a durable record. The criterion was
 *   NOT touched — #426 says so where it is written: *"a line we decline to
 *   rewrite keeps its text exactly … the marker records that the matcher
 *   could not bind it, which is a coverage gap worth seeing"* — and #586
 *   then made it per-criterion so two criteria could not share one. Nothing
 *   is pending on it.
 *
 * Sweeping both up made this repository unable to be both green and a fixed
 * point of its own generator: `bun bin/rungate.ts scaffold . --fix` writes 19
 * `unmatched` markers into `RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md`, and
 * committing the generator's own output turned AC-3 red. Two positions
 * deciding one question with nothing comparing them, which is
 * `.claude/rules/checks-must-be-able-to-fail.md`'s #621 shape — and the side
 * with two issues of deliberation behind it is not the regex.
 *
 * The narrowing is bounded: `REVIEW: original` is still refused, and the two
 * cases beside AC-3 are the proof, because a detector narrowed until the
 * symptom goes away is the cheapest wrong fix there is.
 */
export function pendingReviewMarker(content: string): string | null {
  // `REVIEW: unmatched` is deliberate, durable output — every other
  // `REVIEW:` is parked work. Matching the admitted form explicitly rather
  // than subtracting it keeps a third marker spelled tomorrow refused by
  // default, which is the direction this is allowed to be wrong in.
  const review = content.match(/<!-- REVIEW: (?!unmatched\b)/);
  if (review) return "<!-- REVIEW: original";
  const other = content.match(/FLAGGED|AMBIGUOUS.*SC|TODO.*rewrite.*SC|FIXME.*SC/);
  return other ? other[0] : null;
}
