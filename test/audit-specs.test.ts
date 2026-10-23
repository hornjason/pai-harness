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
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Read back the spec file
      const content = readFileSync(join(FIXTURE_ROOT, "specs", "PRESERVE.md"), "utf-8");

      // All original SC numbers must still be present
      expect(content).toContain("SC-500:");
      expect(content).toContain("SC-501:");
      expect(content).toContain("SC-502:");

      // #1345: the three above are perfectly satisfied by a file nobody
      // touched, so on their own they say nothing about PRESERVING ids
      // THROUGH a rewrite. The claim is "preserved during rewrite", so a
      // rewrite has to have happened for the claim to be about anything.
      const rewritten = (result.rewrites ?? []).filter((r) => r.after !== r.before);
      expect(rewritten.length, "nothing was rewritten, so nothing was preserved").toBeGreaterThan(0);
      // Every id this run rewrote is still the id it rewrote — a renumbering
      // writer is what this case exists to catch, and it can only be caught
      // on lines that were written.
      for (const r of rewritten) expect(content).toContain(`${r.scId}:`);
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

      // #1345: both assertions used to sit INSIDE this condition, so zero
      // rewrites meant zero assertions executed and the case passed having
      // tested nothing. The condition is now the first assertion.
      expect(result.rewrites?.length ?? 0, "no rewrite to summarise").toBeGreaterThan(0);
      expect(diffOutput).toContain("before");
      expect(diffOutput).toContain("after");
      // A summary that names no criterion is not a summary of these rewrites.
      for (const r of result.rewrites!) expect(diffOutput).toContain(r.scId);
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

      // #1345: the second-run assertion below is ALSO what a writer that
      // never rewrites anything produces, so "idempotent" and "inert" were
      // one reading. Idempotence is a claim about a run that DID something,
      // so establish that first — this is the fifth shape, where the cheapest
      // wrong fix (break the writer) turns the case green.
      const rewritten1 = (result1.rewrites ?? []).filter((r) => r.after !== r.before);
      expect(rewritten1.length, "run 1 rewrote nothing, so run 2 has nothing to be idempotent about")
        .toBeGreaterThan(0);
      const afterFirst = readFileSync(join(FIXTURE_ROOT, "specs", "IDEMPOTENT.md"), "utf-8");

      // Second run on same file
      const result2 = auditSpecs(FIXTURE_ROOT, { fix: true });

      // Second run should have 0 rewrites — and leave the bytes alone, which
      // a rewrite that is a no-op per line would not.
      expect(result2.rewrites?.length ?? 0).toBe(0);
      expect(readFileSync(join(FIXTURE_ROOT, "specs", "IDEMPOTENT.md"), "utf-8")).toBe(afterFirst);
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
      const before = readFileSync(join(FIXTURE_ROOT, "specs", "FIX-TARGET.md"), "utf-8");
      const result = auditSpecs(FIXTURE_ROOT, { fix: true });

      // #1345: this case used to assert `result.rewrites` was DEFINED (`[]`
      // is) and that `SC-9441:` was still in the file — which is what NOT
      // rewriting looks like. Its comment said "SC-9441 should have been
      // rewritten to a matchable form" and nothing below it tested that.
      // Assert the rewrite, which only a writer that ran can satisfy.
      const rewritten = (result.rewrites ?? []).find((r) => r.scId === "SC-9441");
      expect(rewritten, "SC-9441 was never rewritten").toBeDefined();
      expect(rewritten!.after).not.toBe(rewritten!.before);

      const content = readFileSync(join(FIXTURE_ROOT, "specs", "FIX-TARGET.md"), "utf-8");
      // The id survives — that was the original claim, and it is still true.
      expect(content).toContain("SC-9441:");
      // …and the STATEMENT it carried does not, which is the half that
      // separates "rewritten" from "untouched".
      expect(content).not.toContain("The file AGENTS.md should exist at project root");
      expect(content).not.toBe(before);
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
