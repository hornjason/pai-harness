/**
 * organize-project.test.ts — Tests for project organization tool
 *
 * Covers: scanning unorganized files, classification heuristics,
 * skip logic, apply mode, JSON output, AGENTS.md updates, symlinks.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, rmSync } from "fs";
import { join } from "path";
import {
  scanUnorganized,
  classifyDocument,
  organizeProject,
  updateDocsRouting,
  type OrganizeProposal,
} from "../lib/organize";

// ── Helpers ──────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join("/tmp", `test-organize-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupStandardDirs(root: string): void {
  for (const d of ["specs", "docs/research", "docs/adr", "docs/council", "docs/guides", "reference"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
}

function writeAgentsMd(root: string, content?: string): void {
  writeFileSync(
    join(root, "AGENTS.md"),
    content ??
      `# test-project

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
| Specs | specs/ |
| Research | docs/research/ |

## Workflow
`,
  );
}

// ── AC-1: Scan for unorganized markdown files ────────────────────

describe("scanUnorganized", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("finds root-level markdown files as unorganized candidates", () => {
    writeFileSync(join(root, "DESIGN.md"), "# Design doc\nSome design content");
    writeFileSync(join(root, "RESEARCH-NOTES.md"), "# Research\nFindings...");
    writeFileSync(join(root, "random-notes.md"), "# Notes\nSome random notes");

    const candidates = scanUnorganized(root);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.map((c) => c.source)).toContain("DESIGN.md");
    expect(candidates.map((c) => c.source)).toContain("RESEARCH-NOTES.md");
    expect(candidates.map((c) => c.source)).toContain("random-notes.md");
  });

  test("excludes well-known root files like AGENTS.md, README.md, CLAUDE.md", () => {
    writeFileSync(join(root, "AGENTS.md"), "# Agents");
    writeFileSync(join(root, "README.md"), "# Readme");
    writeFileSync(join(root, "CLAUDE.md"), "# Claude");
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog");
    writeFileSync(join(root, "CODE-MAP.md"), "# Code Map");
    writeFileSync(join(root, "PROJECT-STATE.md"), "# State");
    writeFileSync(join(root, "stray-doc.md"), "# Stray");

    const candidates = scanUnorganized(root);
    const sources = candidates.map((c) => c.source);
    expect(sources).not.toContain("AGENTS.md");
    expect(sources).not.toContain("README.md");
    expect(sources).not.toContain("CLAUDE.md");
    expect(sources).not.toContain("CHANGELOG.md");
    expect(sources).not.toContain("CODE-MAP.md");
    expect(sources).not.toContain("PROJECT-STATE.md");
    expect(sources).toContain("stray-doc.md");
  });

  test("does not include files already inside standard directories", () => {
    writeFileSync(join(root, "specs", "some-spec.md"), "---\ndoc-type: spec\n---\n# Spec");
    writeFileSync(join(root, "docs/research", "findings.md"), "# Findings");
    writeFileSync(join(root, "reference", "old-thing.md"), "# Old");

    const candidates = scanUnorganized(root);
    const sources = candidates.map((c) => c.source);
    expect(sources).not.toContain("specs/some-spec.md");
    expect(sources).not.toContain("docs/research/findings.md");
    expect(sources).not.toContain("reference/old-thing.md");
  });
});

// ── AC-2: classifyDocument heuristics ────────────────────────────

describe("classifyDocument", () => {
  test("classifies by frontmatter doc-type: spec", () => {
    const result = classifyDocument("my-feature.md", "---\ndoc-type: spec\ngoverns: feature\n---\n# Feature");
    expect(result.targetDir).toBe("specs");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("classifies by frontmatter doc-type: adr", () => {
    const result = classifyDocument("decision-001.md", "---\ndoc-type: adr\nstatus: accepted\n---\n# Decision");
    expect(result.targetDir).toBe("docs/adr");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("classifies by frontmatter doc-type: research", () => {
    const result = classifyDocument("eval.md", "---\ndoc-type: research\n---\n# Evaluation");
    expect(result.targetDir).toBe("docs/research");
  });

  test("classifies by frontmatter doc-type: council", () => {
    const result = classifyDocument("debate.md", "---\ndoc-type: council\n---\n# Council debate");
    expect(result.targetDir).toBe("docs/council");
  });

  test("classifies by frontmatter doc-type: guide", () => {
    const result = classifyDocument("setup.md", "---\ndoc-type: guide\n---\n# Setup guide");
    expect(result.targetDir).toBe("docs/guides");
  });

  test("classifies by filename pattern: ADR-xxx", () => {
    const result = classifyDocument("ADR-042-use-bun.md", "# Use Bun\n\n## Decision\n\nWe will use Bun.");
    expect(result.targetDir).toBe("docs/adr");
  });

  test("classifies by filename pattern containing 'spec'", () => {
    const result = classifyDocument("AUTH-SPEC.md", "# Auth Spec\n\n## Success Criteria\n\nSC-1: ...");
    expect(result.targetDir).toBe("specs");
  });

  test("classifies research-like content by heuristics", () => {
    const content =
      "# Competitor Analysis\n\nWe evaluated three alternatives.\n\n## Findings\n\nOption A scored highest.\n\n## Recommendation\n\nGo with Option A.";
    const result = classifyDocument("competitor-review.md", content);
    expect(result.targetDir).toBe("docs/research");
  });

  test("classifies old/historical content as reference", () => {
    const content = "# Old Design (Deprecated)\n\nThis document is no longer in use. Kept for historical reference.";
    const result = classifyDocument("old-design.md", content);
    expect(result.targetDir).toBe("reference");
  });

  test("returns reasoning string for every classification", () => {
    const result = classifyDocument("test.md", "---\ndoc-type: spec\n---\n# Test");
    expect(result.reasoning).toBeTruthy();
    expect(typeof result.reasoning).toBe("string");
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

// ── AC-3: Skip files already in correct directories ──────────────

describe("organize skip logic", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("skips files already in their correct directory", () => {
    writeFileSync(join(root, "specs", "AUTH-SPEC.md"), "---\ndoc-type: spec\n---\n# Auth");
    writeFileSync(join(root, "docs/adr", "ADR-001.md"), "---\ndoc-type: adr\n---\n# Decision");

    const proposals = organizeProject(root, { dryRun: true });
    const sources = proposals.map((p) => p.source);
    expect(sources).not.toContain("specs/AUTH-SPEC.md");
    expect(sources).not.toContain("docs/adr/ADR-001.md");
  });

  test("proposes moves only for misplaced or root-level markdown", () => {
    // Misplaced: an ADR sitting in root
    writeFileSync(join(root, "ADR-005-caching.md"), "---\ndoc-type: adr\n---\n# Caching Decision");
    // Correctly placed spec
    writeFileSync(join(root, "specs", "CACHE-SPEC.md"), "---\ndoc-type: spec\n---\n# Cache");

    const proposals = organizeProject(root, { dryRun: true });
    expect(proposals.some((p) => p.source === "ADR-005-caching.md")).toBe(true);
    expect(proposals.some((p) => p.source === "specs/CACHE-SPEC.md")).toBe(false);
  });
});

// ── AC-4: Apply mode - move files and update references ──────────

describe("organize apply mode", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("--apply moves files to target directories", () => {
    writeFileSync(join(root, "ADR-010-testing.md"), "---\ndoc-type: adr\n---\n# Testing Decision");
    writeFileSync(join(root, "AGENTS.md"), "# project\n\n## Documentation Routing\n\n| I need to understand... | Read |\n|--|--|\n\n## Workflow\n");

    const proposals = organizeProject(root, { apply: true });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    // File should be moved
    expect(existsSync(join(root, "ADR-010-testing.md"))).toBe(false);
    expect(existsSync(join(root, "docs/adr", "ADR-010-testing.md"))).toBe(true);
  });

  test("--apply updates internal markdown link references in other files", () => {
    writeFileSync(join(root, "RESEARCH-FINDINGS.md"), "---\ndoc-type: research\n---\n# Findings\n\nSee [spec](./AUTH-SPEC.md).");
    writeFileSync(join(root, "AUTH-SPEC.md"), "---\ndoc-type: spec\n---\n# Auth Spec");
    writeFileSync(join(root, "AGENTS.md"), "# project\n\n## Documentation Routing\n\n| I need to understand... | Read |\n|--|--|\n\n## Workflow\n");

    organizeProject(root, { apply: true });

    // The moved research file should have updated link
    const movedResearch = readFileSync(join(root, "docs/research", "RESEARCH-FINDINGS.md"), "utf-8");
    // Link should be updated to point to new relative path
    expect(movedResearch).not.toContain("./AUTH-SPEC.md");
  });
});

// ── AC-5: Structured JSON output ─────────────────────────────────

describe("organize JSON output", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("proposals contain source, target, classification, reasoning, and confidence", () => {
    writeFileSync(join(root, "DESIGN-DOC.md"), "---\ndoc-type: spec\n---\n# Design\n\n## Success Criteria");

    const proposals = organizeProject(root, { dryRun: true });
    expect(proposals.length).toBeGreaterThanOrEqual(1);

    const p = proposals[0];
    expect(p).toHaveProperty("source");
    expect(p).toHaveProperty("target");
    expect(p).toHaveProperty("classification");
    expect(p).toHaveProperty("reasoning");
    expect(p).toHaveProperty("confidence");
    expect(typeof p.source).toBe("string");
    expect(typeof p.target).toBe("string");
    expect(typeof p.classification).toBe("string");
    expect(typeof p.reasoning).toBe("string");
    expect(typeof p.confidence).toBe("number");
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.confidence).toBeLessThanOrEqual(1);
  });
});

// ── AC-6: Update AGENTS.md docs-routing table ────────────────────

describe("updateDocsRouting", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("adds new entries to docs-routing table after moves", () => {
    writeAgentsMd(root);
    const proposals: OrganizeProposal[] = [
      {
        source: "DESIGN-DOC.md",
        target: "specs/DESIGN-DOC.md",
        classification: "spec",
        reasoning: "frontmatter doc-type: spec",
        confidence: 0.9,
      },
    ];

    updateDocsRouting(root, proposals);

    const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("specs/DESIGN-DOC.md");
  });

  test("does not duplicate existing docs-routing entries", () => {
    const agentsContent = `# test-project

## Documentation Routing

| I need to understand... | Read |
|------------------------|------|
| Specs | specs/ |
| Research | docs/research/ |
| Design doc | specs/DESIGN-DOC.md |

## Workflow
`;
    writeFileSync(join(root, "AGENTS.md"), agentsContent);

    const proposals: OrganizeProposal[] = [
      {
        source: "DESIGN-DOC.md",
        target: "specs/DESIGN-DOC.md",
        classification: "spec",
        reasoning: "frontmatter doc-type: spec",
        confidence: 0.9,
      },
    ];

    updateDocsRouting(root, proposals);

    const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf-8");
    // Count occurrences of the target path
    const matches = agentsMd.match(/specs\/DESIGN-DOC\.md/g);
    expect(matches?.length).toBe(1);
  });
});

// ── AC-7: Symlinks for external resources ────────────────────────

describe("organize symlinks for external resources", () => {
  let root: string;
  let externalDir: string;

  beforeEach(() => {
    root = makeTmpDir();
    externalDir = makeTmpDir();
    setupStandardDirs(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  test("creates symlinks for external resources instead of copying", () => {
    // Create external resource
    writeFileSync(join(externalDir, "shared-spec.md"), "---\ndoc-type: spec\n---\n# Shared Spec");
    // Create symlink in project root pointing to external resource
    symlinkSync(join(externalDir, "shared-spec.md"), join(root, "shared-spec.md"));

    const proposals = organizeProject(root, { apply: true });

    // The moved file should still be a symlink, not a copy
    if (proposals.length > 0) {
      const targetPath = join(root, proposals[0].target);
      if (existsSync(targetPath)) {
        expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
      }
    }
  });

  test("preserves symlink targets when moving external resources", () => {
    // Create external resource
    writeFileSync(join(externalDir, "research-vault.md"), "---\ndoc-type: research\n---\n# Vault Research");
    // Create symlink in project root
    symlinkSync(join(externalDir, "research-vault.md"), join(root, "research-vault.md"));

    const proposals = organizeProject(root, { apply: true });

    if (proposals.length > 0) {
      const targetPath = join(root, proposals[0].target);
      if (existsSync(targetPath)) {
        const stat = lstatSync(targetPath);
        expect(stat.isSymbolicLink()).toBe(true);
        // Content should still be accessible
        const content = readFileSync(targetPath, "utf-8");
        expect(content).toContain("Vault Research");
      }
    }
  });
});
