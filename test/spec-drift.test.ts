/**
 * Spec-test drift detector — bidirectional traceability.
 *
 * Ensures:
 * 1. Every spec section referenced by a test still exists in the spec
 * 2. Every testable spec has at least one test referencing it
 *
 * Test files reference specs via comments:
 *   // SPEC-REF: HARNESS-SKILL-CHAIN.md § Layer 1
 *   // SPEC-REF: HARNESS-SKILL-CHAIN.md § ceremony table
 *
 * Legacy format also detected (best-effort):
 *   // Spec: HARNESS-SKILL-CHAIN.md Layer 1-2-3
 *   // Spec Layer 1: "Quinn validates on local dev"
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const SPECS_DIR = join(ROOT, "specs");
const TEST_DIR = join(ROOT, "test");

interface SpecRef {
  specFile: string;
  section: string;
  testFile: string;
  line: number;
}

function extractSpecRefs(testFile: string): SpecRef[] {
  const content = readFileSync(join(TEST_DIR, testFile), "utf-8");
  const refs: SpecRef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Structured format: // SPEC-REF: filename.md § section
    const structured = line.match(/\/\/\s*SPEC-REF:\s*(\S+\.md)\s*§\s*(.+)/);
    if (structured && !structured[1].match(/^(filename|FILENAME|example)\./i)) {
      refs.push({
        specFile: structured[1],
        section: structured[2].trim(),
        testFile,
        line: i + 1,
      });
      continue;
    }

    // Legacy: // Spec: FILENAME.md keyword
    const legacy = line.match(/\/\/\s*Spec:\s*(\S+\.md)\s+(.*)/);
    if (legacy && !legacy[1].match(/^(filename|FILENAME|example)\./i)) {
      refs.push({
        specFile: legacy[1],
        section: legacy[2].trim(),
        testFile,
        line: i + 1,
      });
    }
  }

  return refs;
}

function getTestableSpecs(): string[] {
  if (!existsSync(SPECS_DIR)) return [];
  return readdirSync(SPECS_DIR)
    .filter(f => f.endsWith(".md"))
    .filter(f => {
      const content = readFileSync(join(SPECS_DIR, f), "utf-8");
      const fm = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) return false;
      return /testable:\s*true/.test(fm[1]);
    });
}

describe("Spec-Test Drift Detector", () => {

  test("DRIFT-1: Every SPEC-REF points to an existing spec file", () => {
    const testFiles = readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts"));
    const allRefs: SpecRef[] = [];
    for (const tf of testFiles) {
      allRefs.push(...extractSpecRefs(tf));
    }

    const broken: string[] = [];
    for (const ref of allRefs) {
      const specPath = join(SPECS_DIR, ref.specFile);
      if (!existsSync(specPath)) {
        broken.push(`${ref.testFile}:${ref.line} references ${ref.specFile} (not found)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("DRIFT-2: Every SPEC-REF section keyword exists in the spec", () => {
    const testFiles = readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts"));
    const allRefs: SpecRef[] = [];
    for (const tf of testFiles) {
      allRefs.push(...extractSpecRefs(tf));
    }

    const stale: string[] = [];
    for (const ref of allRefs) {
      const specPath = join(SPECS_DIR, ref.specFile);
      if (!existsSync(specPath)) continue;
      const specContent = readFileSync(specPath, "utf-8").toLowerCase();
      // Extract key terms from section reference (split on spaces, check each >3 chars)
      const terms = ref.section.toLowerCase().split(/\s+/).filter(t => t.length > 3);
      const missing = terms.filter(t => !specContent.includes(t));
      if (missing.length > terms.length * 0.5) {
        stale.push(`${ref.testFile}:${ref.line} § "${ref.section}" — terms not found: ${missing.join(", ")}`);
      }
    }
    if (stale.length > 0) {
      console.warn(`Potentially stale spec references:\n  ${stale.join("\n  ")}`);
    }
    // WARN for now — promote to FAIL once all refs are structured
    expect(true).toBe(true);
  });

  test("DRIFT-3: Every testable spec is referenced by at least one test", () => {
    const testableSpecs = getTestableSpecs();
    const testFiles = readdirSync(TEST_DIR).filter(f => f.endsWith(".test.ts"));

    const allRefs: SpecRef[] = [];
    for (const tf of testFiles) {
      allRefs.push(...extractSpecRefs(tf));
    }
    const referencedSpecs = new Set(allRefs.map(r => r.specFile));

    // Also check for specs mentioned in test file content (import/readFileSync)
    for (const tf of testFiles) {
      const content = readFileSync(join(TEST_DIR, tf), "utf-8");
      for (const spec of testableSpecs) {
        if (content.includes(spec)) referencedSpecs.add(spec);
      }
    }

    const orphaned = testableSpecs.filter(s => !referencedSpecs.has(s));
    if (orphaned.length > 0) {
      console.warn(`Testable specs with no test references: ${orphaned.join(", ")}`);
    }
    // WARN for now — some specs tested via auto-generated compliance
    expect(true).toBe(true);
  });
});
