import { test, expect, describe, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { extractConstraints, contentHash } from "../../scripts/extract-constraints";

function createTempDir(): string {
  const dir = join("/tmp", `ec-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("extract-constraints: signal phrase extraction", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("finds 'do not remove' pattern", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "docs", "RULES.md"),
      "# Rules\n\nThis is a guard. Do not remove the safety check or tests will break.\n\nMore text here.\n"
    );
    const result = await extractConstraints(tmpDir);
    const found = result.candidates.some((c) => /do not remove/i.test(c.rule));
    expect(found).toBe(true);
  });

  test("finds 'intentional' pattern", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "specs", "DESIGN.md"),
      "---\ntestable: true\ndoc-type: spec\n---\n# Design\n\nThe duplication here is intentional because each consumer has different lifetimes.\n"
    );
    const result = await extractConstraints(tmpDir);
    const found = result.candidates.some((c) => /intentional/i.test(c.rule));
    expect(found).toBe(true);
  });
});

describe("extract-constraints: deduplication", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("removes candidates matching existing Hard Constraints", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "AGENTS.md"),
      "## Hard Constraints (non-inferrable)\n\n- **Safety check** — never remove the safety check from the pipeline\n"
    );
    writeFileSync(
      join(tmpDir, "docs", "RULES.md"),
      "# Rules\n\n- Agents must never remove the safety check from the pipeline.\n"
    );
    const result = await extractConstraints(tmpDir);
    expect(result.deduped.existingConstraints).toBeGreaterThanOrEqual(1);
    const found = result.candidates.some((c) => /never remove the safety check/i.test(c.rule));
    expect(found).toBe(false);
  });

  test("content hash dedup works for rejected-constraints.md", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    mkdirSync(join(tmpDir, "reference"), { recursive: true });

    const rule = "Do not remove the legacy adapter until migration completes";
    const hash = contentHash(rule.replace(/^[-*] /, "").trim().replace(/[.;]$/, ""));

    writeFileSync(
      join(tmpDir, "reference", "rejected-constraints.md"),
      `# Rejected Constraints\n\n| Hash | Rule | Source | Rejected |\n|------|------|--------|----------|\n| ${hash} | Do not remove the legacy... | RULES.md:5 | 2026-09-18 |\n`
    );
    writeFileSync(
      join(tmpDir, "docs", "RULES.md"),
      `# Rules\n\n${rule}.\n`
    );

    const result = await extractConstraints(tmpDir);
    expect(result.deduped.rejectedPrior).toBeGreaterThanOrEqual(1);
  });
});

describe("extract-constraints: output structure", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("output JSON has correct structure", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "docs", "GUIDE.md"),
      "# Guide\n\nThis flag is permanently disabled for compliance reasons.\n"
    );
    const result = await extractConstraints(tmpDir);

    expect(result).toHaveProperty("candidates");
    expect(result).toHaveProperty("deduped");
    expect(result).toHaveProperty("staleness");
    expect(result.deduped).toHaveProperty("existingConstraints");
    expect(result.deduped).toHaveProperty("rejectedPrior");
    expect(result.deduped).toHaveProperty("candidatesRemoved");
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(Array.isArray(result.staleness)).toBe(true);

    if (result.candidates.length > 0) {
      const c = result.candidates[0];
      expect(c).toHaveProperty("rule");
      expect(c).toHaveProperty("source");
      expect(c).toHaveProperty("context");
      expect(c).toHaveProperty("hash");
    }
  });
});

describe("extract-constraints: ADR staleness exemption", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("ADR files are included in scan but exempt from staleness", async () => {
    tmpDir = createTempDir();
    mkdirSync(join(tmpDir, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(tmpDir, "docs", "adr", "ADR-001.md"),
      "# ADR-001\n\nThis decision is intentional and by design — we chose X over Y.\n"
    );
    const result = await extractConstraints(tmpDir);
    const adrCandidate = result.candidates.some((c) => c.source.includes("ADR-001"));
    expect(adrCandidate).toBe(true);
    const adrStale = result.staleness.some((s) => s.file.includes("ADR-001"));
    expect(adrStale).toBe(false);
  });
});
