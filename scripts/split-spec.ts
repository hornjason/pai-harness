#!/usr/bin/env bun

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface SplitBoundary {
  heading: string;
  startLine: number;
  lineCount: number;
}

export interface SplitFile {
  filename: string;
  content: string;
  governs: string;
  lineCount: number;
}

export function deriveDirectoryName(filename: string): string {
  // Strip .md extension
  let name = filename.replace(/\.md$/i, "");
  // Strip -spec suffix (case insensitive)
  name = name.replace(/-spec$/i, "");
  // Lowercase
  return name.toLowerCase();
}

export function detectSplitBoundaries(content: string): SplitBoundary[] {
  const lines = content.split("\n");
  const boundaries: SplitBoundary[] = [];

  // Find all ## headings (but not ### or deeper)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ## followed by space, but not ###
    if (/^## (?!#)/.test(line)) {
      const heading = line.replace(/^## /, "").trim();
      boundaries.push({
        heading,
        startLine: i + 1, // 1-indexed
        lineCount: 0, // Will calculate below
      });
    }
  }

  // Calculate line counts for each section
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const nextBoundary = boundaries[i + 1];
    const startIdx = boundary.startLine - 1; // Convert to 0-indexed
    const endIdx = nextBoundary ? nextBoundary.startLine - 1 : lines.length;
    boundary.lineCount = endIdx - startIdx;
  }

  return boundaries;
}

export function shouldSplit(content: string): boolean {
  // Check if already split
  if (content.includes("status: split")) {
    return false;
  }

  const lines = content.split("\n");
  const totalLines = lines.length;

  // If under 500 lines, no split needed
  if (totalLines < 500) {
    return false;
  }

  // Detect boundaries to check section sizes
  const boundaries = detectSplitBoundaries(content);

  // If any individual section exceeds 500 lines, split
  for (const boundary of boundaries) {
    if (boundary.lineCount > 500) {
      return true;
    }
  }

  // If over 500 lines total with multiple sections, split
  if (totalLines >= 500 && boundaries.length > 1) {
    return true;
  }

  return false;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const yaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

export interface GroupedBoundary {
  headings: string[];
  startLine: number;
  endLine: number;
  lineCount: number;
}

export function groupBoundaries(boundaries: SplitBoundary[], totalLines: number, maxLines: number = 500): GroupedBoundary[] {
  if (boundaries.length === 0) return [];

  const groups: GroupedBoundary[] = [];
  let currentGroup: GroupedBoundary = {
    headings: [boundaries[0].heading],
    startLine: boundaries[0].startLine,
    endLine: 0,
    lineCount: boundaries[0].lineCount,
  };

  for (let i = 1; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    if (currentGroup.lineCount + boundary.lineCount <= maxLines) {
      currentGroup.headings.push(boundary.heading);
      currentGroup.lineCount += boundary.lineCount;
    } else {
      const prevBoundary = boundaries[i - 1];
      currentGroup.endLine = boundary.startLine - 1;
      groups.push(currentGroup);
      currentGroup = {
        headings: [boundary.heading],
        startLine: boundary.startLine,
        endLine: 0,
        lineCount: boundary.lineCount,
      };
    }
  }
  currentGroup.endLine = totalLines;
  groups.push(currentGroup);

  return groups;
}

export function generateSplitFiles(
  content: string,
  boundaries: SplitBoundary[],
  metadata: { owner: string; testable: boolean }
): SplitFile[] {
  const lines = content.split("\n");
  const now = new Date().toISOString().split("T")[0];
  const groups = groupBoundaries(boundaries, lines.length);

  return groups.map((group) => {
    const filename = `${slugify(group.headings[0])}.md`;
    const governs = group.headings.length === 1
      ? group.headings[0]
      : `${group.headings[0]} + ${group.headings.length - 1} more`;

    const startIdx = group.startLine - 1;
    const endIdx = group.endLine;
    const sectionLines = lines.slice(startIdx, endIdx);

    const frontmatter = `---
doc-type: spec
status: active
owner: ${metadata.owner}
created: ${now}
updated: ${now}
governs: ${governs}
testable: ${metadata.testable}
---`;

    const fileContent = `${frontmatter}\n\n${sectionLines.join("\n")}`;

    return {
      filename,
      content: fileContent,
      governs,
      lineCount: fileContent.split("\n").length,
    };
  });
}

export function generateRedirect(
  originalPath: string,
  splitDir: string,
  splitFiles: SplitFile[]
): string {
  const frontmatter = `---
status: split
---`;

  const fileList = splitFiles
    .map((f) => `- [${f.filename}](${splitDir}/${f.filename}) — ${f.governs}`)
    .join("\n");

  return `${frontmatter}

This file has been split. See:

${fileList}`;
}

export function generateIndex(
  splitFiles: SplitFile[],
  originalGoverns: string
): string {
  const frontmatter = `---
doc-type: index
governs: ${originalGoverns}
---`;

  const tableHeader = `| File | Governs | Lines |
|------|---------|-------|`;

  const tableRows = splitFiles
    .map(
      (f) => `| [${f.filename}](${f.filename}) | ${f.governs} | ${f.lineCount} |`
    )
    .join("\n");

  return `${frontmatter}

# INDEX.md

${tableHeader}
${tableRows}`;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun scripts/split-spec.ts <spec-file.md>");
    process.exit(1);
  }

  const specPath = args[0];
  const content = readFileSync(specPath, "utf-8");

  // Check if split needed
  if (!shouldSplit(content)) {
    console.log("File does not need splitting (< 500 lines or already split)");
    process.exit(0);
  }

  // Detect boundaries
  const boundaries = detectSplitBoundaries(content);
  if (boundaries.length === 0) {
    console.log("No ## sections found to split");
    process.exit(0);
  }

  // Parse original frontmatter for metadata
  const { frontmatter } = parseFrontmatter(content);
  const owner = frontmatter.owner || "jason";
  const testable = frontmatter.testable === "true" || frontmatter.testable === true;
  const originalGoverns = frontmatter.governs || "Spec content";

  // Generate split files
  const splitFiles = generateSplitFiles(content, boundaries, {
    owner,
    testable,
  });

  // Derive directory name
  const filename = specPath.split("/").pop() || "";
  const dirName = deriveDirectoryName(filename);
  const parentDir = dirname(specPath);
  const splitDir = join(parentDir, dirName);

  // Create directory
  mkdirSync(splitDir, { recursive: true });

  // Write split files
  for (const file of splitFiles) {
    const filePath = join(splitDir, file.filename);
    writeFileSync(filePath, file.content);
    console.log(`Created: ${filePath} (${file.lineCount} lines)`);
  }

  // Write INDEX.md
  const indexContent = generateIndex(splitFiles, originalGoverns);
  const indexPath = join(splitDir, "INDEX.md");
  writeFileSync(indexPath, indexContent);
  console.log(`Created: ${indexPath}`);

  // Replace original with redirect
  const redirectContent = generateRedirect(specPath, splitDir, splitFiles);
  writeFileSync(specPath, redirectContent);
  console.log(`Updated: ${specPath} (now a redirect)`);

  console.log(
    `\nSplit ${filename} into ${splitFiles.length} files in ${splitDir}/`
  );
}
