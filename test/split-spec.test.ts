import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Import the functions we'll build (these will FAIL until implementation exists — that's RED phase)
import {
  deriveDirectoryName,
  detectSplitBoundaries,
  generateSplitFiles,
  generateRedirect,
  generateIndex,
  shouldSplit,
  type SplitBoundary,
  type SplitFile,
} from "../scripts/split-spec";

describe("split-spec command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "split-spec-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("deriveDirectoryName", () => {
    test("strips -SPEC.md suffix (uppercase)", () => {
      expect(deriveDirectoryName("BOOTSTRAP-DATA-FLOW-SPEC.md")).toBe(
        "bootstrap-data-flow"
      );
    });

    test("strips -spec.md suffix (lowercase)", () => {
      expect(deriveDirectoryName("my-feature-spec.md")).toBe("my-feature");
    });

    test("strips -Spec.md suffix (mixed case)", () => {
      expect(deriveDirectoryName("My-Feature-Spec.md")).toBe("my-feature");
    });

    test("handles simple filename without SPEC suffix", () => {
      expect(deriveDirectoryName("simple.md")).toBe("simple");
    });

    test("handles multi-word spec filename", () => {
      expect(deriveDirectoryName("AGENTS-MD-TEMPLATE-SPEC.md")).toBe(
        "agents-md-template"
      );
    });

    test("lowercases all output", () => {
      expect(deriveDirectoryName("UPPERCASE-SPEC.md")).toBe("uppercase");
    });
  });

  describe("detectSplitBoundaries", () => {
    test("detects multiple ## headings as split boundaries", () => {
      const content = generateTestContent([
        { heading: "Section One", lines: 200 },
        { heading: "Section Two", lines: 200 },
        { heading: "Section Three", lines: 200 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      expect(boundaries).toHaveLength(3);
      expect(boundaries[0].heading).toBe("Section One");
      expect(boundaries[1].heading).toBe("Section Two");
      expect(boundaries[2].heading).toBe("Section Three");
    });

    test("detects when individual section exceeds 500 lines", () => {
      const content = generateTestContent([
        { heading: "Small Section", lines: 100 },
        { heading: "Large Section", lines: 600 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      expect(boundaries).toHaveLength(2);
      expect(boundaries[1].lineCount).toBeGreaterThan(500);
    });

    test("ignores ### and deeper headings", () => {
      const content = `## Main Section
Some content here
### Subsection
More content
#### Deep Section
Even more content`;

      const boundaries = detectSplitBoundaries(content);
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].heading).toBe("Main Section");
    });

    test("handles content with frontmatter", () => {
      const content = `---
doc-type: spec
status: active
---

## First Section
Content here

## Second Section
More content`;

      const boundaries = detectSplitBoundaries(content);
      expect(boundaries).toHaveLength(2);
    });
  });

  describe("shouldSplit", () => {
    test("returns false for file under 500 lines", () => {
      const content = generateTestContent([
        { heading: "Small Section", lines: 100 },
      ]);
      expect(shouldSplit(content)).toBe(false);
    });

    test("returns true for file over 500 lines with multiple sections", () => {
      const content = generateTestContent([
        { heading: "Section One", lines: 300 },
        { heading: "Section Two", lines: 300 },
      ]);
      expect(shouldSplit(content)).toBe(true);
    });

    test("returns false for already-split file (status: split)", () => {
      const content = `---
status: split
---

See split files in specs/my-feature/`;
      expect(shouldSplit(content)).toBe(false);
    });

    test("returns true when any section exceeds 500 lines", () => {
      const content = generateTestContent([
        { heading: "Small Section", lines: 100 },
        { heading: "Huge Section", lines: 600 },
      ]);
      expect(shouldSplit(content)).toBe(true);
    });
  });

  describe("generateSplitFiles", () => {
    test("groups small sections together, splits when over 500 lines", () => {
      const content = generateTestContent([
        { heading: "Section One", lines: 300 },
        { heading: "Section Two", lines: 300 },
        { heading: "Section Three", lines: 300 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      const splitFiles = generateSplitFiles(content, boundaries, {
        owner: "jason",
        testable: true,
      });

      // 300+300=600 > 500, so first two can't fit together. Should produce 2-3 groups.
      expect(splitFiles.length).toBeGreaterThanOrEqual(2);
      expect(splitFiles.length).toBeLessThanOrEqual(3);
    });

    test("each file has YAML frontmatter with required fields", () => {
      const content = generateTestContent([
        { heading: "Test Section", lines: 200 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      const splitFiles = generateSplitFiles(content, boundaries, {
        owner: "jason",
        testable: true,
      });

      const fileContent = splitFiles[0].content;
      expect(fileContent).toContain("---");
      expect(fileContent).toContain("doc-type: spec");
      expect(fileContent).toContain("status: active");
      expect(fileContent).toContain("owner: jason");
      expect(fileContent).toContain("created:");
      expect(fileContent).toContain("updated:");
      expect(fileContent).toContain("governs:");
      expect(fileContent).toContain("testable: true");
    });

    test("each file is under 500 lines", () => {
      const content = generateTestContent([
        { heading: "Section One", lines: 400 },
        { heading: "Section Two", lines: 400 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      const splitFiles = generateSplitFiles(content, boundaries, {
        owner: "jason",
        testable: true,
      });

      for (const file of splitFiles) {
        const lineCount = file.content.split("\n").length;
        expect(lineCount).toBeLessThan(500);
      }
    });

    test("filename derived from heading (slugified)", () => {
      const content = generateTestContent([
        { heading: "Bootstrap Phase 0", lines: 200 },
      ]);

      const boundaries = detectSplitBoundaries(content);
      const splitFiles = generateSplitFiles(content, boundaries, {
        owner: "jason",
        testable: true,
      });

      expect(splitFiles[0].filename).toBe("bootstrap-phase-0.md");
    });

    test("preserves section content", () => {
      const content = `## Test Section
This is test content
With multiple lines
That should be preserved`;

      const boundaries = detectSplitBoundaries(content);
      const splitFiles = generateSplitFiles(content, boundaries, {
        owner: "jason",
        testable: false,
      });

      expect(splitFiles[0].content).toContain("This is test content");
      expect(splitFiles[0].content).toContain("With multiple lines");
      expect(splitFiles[0].content).toContain("That should be preserved");
    });
  });

  describe("generateRedirect", () => {
    test("creates redirect with status: split in frontmatter", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "phase-0.md",
          content: "...",
          governs: "Phase 0 bootstrap",
          lineCount: 200,
        },
        {
          filename: "phase-1.md",
          content: "...",
          governs: "Phase 1 bootstrap",
          lineCount: 200,
        },
      ];

      const redirect = generateRedirect(
        "specs/BOOTSTRAP-DATA-FLOW-SPEC.md",
        "specs/bootstrap-data-flow",
        splitFiles
      );

      expect(redirect).toContain("status: split");
    });

    test("lists all split files with their governs", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "section-a.md",
          content: "...",
          governs: "Section A functionality",
          lineCount: 100,
        },
        {
          filename: "section-b.md",
          content: "...",
          governs: "Section B functionality",
          lineCount: 100,
        },
      ];

      const redirect = generateRedirect(
        "specs/MY-SPEC.md",
        "specs/my-spec",
        splitFiles
      );

      expect(redirect).toContain("section-a.md");
      expect(redirect).toContain("Section A functionality");
      expect(redirect).toContain("section-b.md");
      expect(redirect).toContain("Section B functionality");
    });

    test("redirect file is under 30 lines", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "one.md",
          content: "...",
          governs: "First",
          lineCount: 100,
        },
        {
          filename: "two.md",
          content: "...",
          governs: "Second",
          lineCount: 100,
        },
        {
          filename: "three.md",
          content: "...",
          governs: "Third",
          lineCount: 100,
        },
      ];

      const redirect = generateRedirect(
        "specs/TEST-SPEC.md",
        "specs/test",
        splitFiles
      );

      const lineCount = redirect.split("\n").length;
      expect(lineCount).toBeLessThan(30);
    });

    test("includes path to split directory", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "part.md",
          content: "...",
          governs: "Part",
          lineCount: 100,
        },
      ];

      const redirect = generateRedirect(
        "specs/ORIGINAL.md",
        "specs/original",
        splitFiles
      );

      expect(redirect).toContain("specs/original");
    });
  });

  describe("generateIndex", () => {
    test("creates INDEX.md with table of split files", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "phase-0.md",
          content: "...",
          governs: "Phase 0 bootstrap",
          lineCount: 200,
        },
        {
          filename: "phase-1.md",
          content: "...",
          governs: "Phase 1 bootstrap",
          lineCount: 250,
        },
      ];

      const index = generateIndex(splitFiles, "Bootstrap data flow phases");

      expect(index).toContain("INDEX.md");
      expect(index).toContain("phase-0.md");
      expect(index).toContain("phase-1.md");
      expect(index).toContain("Phase 0 bootstrap");
      expect(index).toContain("Phase 1 bootstrap");
    });

    test("includes line counts for each file", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "small.md",
          content: "...",
          governs: "Small section",
          lineCount: 150,
        },
        {
          filename: "large.md",
          content: "...",
          governs: "Large section",
          lineCount: 450,
        },
      ];

      const index = generateIndex(splitFiles, "Test sections");

      expect(index).toContain("150");
      expect(index).toContain("450");
    });

    test("frontmatter inherits original governs", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "part.md",
          content: "...",
          governs: "Part",
          lineCount: 100,
        },
      ];

      const index = generateIndex(
        splitFiles,
        "Original governing description"
      );

      expect(index).toContain("governs: Original governing description");
    });

    test("has frontmatter with correct doc-type", () => {
      const splitFiles: SplitFile[] = [
        {
          filename: "test.md",
          content: "...",
          governs: "Test",
          lineCount: 100,
        },
      ];

      const index = generateIndex(splitFiles, "Test");

      expect(index).toContain("doc-type: index");
      expect(index).toContain("---");
    });
  });

  describe("idempotency", () => {
    test("split-spec on already-split file is no-op", () => {
      const alreadySplitContent = `---
status: split
---

This file has been split. See specs/my-feature/`;

      expect(shouldSplit(alreadySplitContent)).toBe(false);
    });

    test("split-spec on small file is no-op", () => {
      const smallContent = generateTestContent([
        { heading: "Only Section", lines: 100 },
      ]);

      expect(shouldSplit(smallContent)).toBe(false);
    });
  });
});

// Helper function to generate test markdown content with specified sections and line counts
function generateTestContent(
  sections: Array<{ heading: string; lines: number }>
): string {
  const frontmatter = `---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Test spec
testable: true
---
`;

  const sectionContents = sections.map((section) => {
    const heading = `## ${section.heading}`;
    const lines = Array.from(
      { length: section.lines - 1 },
      (_, i) => `Line ${i + 1} of ${section.heading} content.`
    );
    return [heading, ...lines].join("\n");
  });

  return [frontmatter, ...sectionContents].join("\n\n");
}
