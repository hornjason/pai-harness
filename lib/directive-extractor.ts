/**
 * Directive extractor — parses agent brief markdown for actionable instructions.
 *
 * Extracts Read X, Run Y, Never Z, Always W patterns mechanically
 * from brief markdown content. No manual directive list required.
 *
 * SC-401: Directive extractor parses brief mechanically
 */

export type DirectiveType = "read" | "run" | "never" | "always";

export interface Directive {
  text: string;
  type: DirectiveType;
  line: number;
  section: string;
  target?: string;
}

// ── Pattern matchers ──────────────────────────────────────

const FILE_EXT = /\.(?:md|ts|json|yml|yaml|js|toml|sh)$/;
const READ_PATTERN = /(?:Read|read)\s+[`"*]*([^\s`"*]+(?:\.(?:md|ts|json|yml|yaml|js|toml|sh)))[`"*]*/;
const BOLD_FILE_PATTERN = /\*\*([^\s*]+(?:\.(?:md|ts|json)))\*\*/;
const BACKTICK_PATH_PATTERN = /[`]([^\s`]+(?:\.(?:md|ts|json|yml|yaml)))[`]/;
const RUN_PATTERN = /(?:Run|run)\s+[`]([^`]+)[`]/;
const BUN_TEST_PATTERN = /`(bun test[^`]*)`/;
const TSC_PATTERN = /`(bunx? tsc[^`]*)`/;

function isFilePath(s: string): boolean {
  return s.includes("/") || FILE_EXT.test(s);
}

// ── Extraction ────────────────────────────────────────────

export function extractDirectives(briefContent: string): Directive[] {
  const directives: Directive[] = [];
  const lines = briefContent.split("\n");
  let currentSection = "top";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track sections
    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim();
      continue;
    }

    // Skip comments and blank lines
    if (line.startsWith("//") || line.startsWith("#") || !line.trim()) continue;

    const sectionLower = currentSection.toLowerCase();
    const trimmedLine = line.trim().replace(/^[-\d.]+\s*/, "");

    // ── Never classification (HIGHEST PRIORITY — before all content patterns) ──
    // Priority 1: Lines starting with "Never" regardless of section or content
    if (/^never\b/i.test(trimmedLine) && !directives.some(d => d.line === lineNum)) {
      directives.push({ text: trimmedLine, type: "never", line: lineNum, section: currentSection });
      continue;
    }

    // Priority 2: All bullet items in "Never Do" or "Additional Never Do" sections
    if ((sectionLower.includes("never") || sectionLower.includes("additional never")) && line.trim().startsWith("- ")) {
      if (!directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "never", line: lineNum, section: currentSection });
        continue;
      }
    }

    // ── Read patterns ──
    // Read X patterns — "Read `file`", "Read file.md", numbered items with file refs
    const readMatch = line.match(READ_PATTERN);
    if (readMatch) {
      const target = readMatch[1].replace(/[`"*]/g, "");
      if (isFilePath(target)) {
        directives.push({ text: trimmedLine, type: "read", line: lineNum, section: currentSection, target });
      }
    }

    // Context section numbered items — "1. **AGENTS.md** — MANDATORY"
    if (sectionLower.includes("context") && /^\d+\./.test(line.trim())) {
      const boldMatch = line.match(BOLD_FILE_PATTERN);
      const pathMatch = line.match(BACKTICK_PATH_PATTERN);
      const target = boldMatch?.[1] || pathMatch?.[1];
      if (target && !directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "read", line: lineNum, section: currentSection, target });
      }
    }

    // Before writing code / Before reporting done sections with file refs
    if ((sectionLower.includes("before") || sectionLower.includes("reference")) && /^\d+\./.test(line.trim())) {
      const boldMatch = line.match(BOLD_FILE_PATTERN);
      const pathMatch = line.match(BACKTICK_PATH_PATTERN);
      const target = boldMatch?.[1] || pathMatch?.[1];
      if (target && !directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "read", line: lineNum, section: currentSection, target });
      }
    }

    // ── Run patterns (only after never checks pass) ──
    const runMatch = line.match(RUN_PATTERN);
    if (runMatch && !directives.some(d => d.line === lineNum)) {
      directives.push({ text: trimmedLine, type: "run", line: lineNum, section: currentSection, target: runMatch[1] });
    }

    // Inline bun test pattern
    const bunTestMatch = line.match(BUN_TEST_PATTERN);
    if (bunTestMatch && !directives.some(d => d.line === lineNum)) {
      directives.push({ text: trimmedLine, type: "run", line: lineNum, section: currentSection, target: bunTestMatch[1] });
    }

    // tsc --noEmit pattern
    const tscMatch = line.match(TSC_PATTERN);
    if (tscMatch && !directives.some(d => d.line === lineNum)) {
      directives.push({ text: trimmedLine, type: "run", line: lineNum, section: currentSection, target: tscMatch[1] });
    }

    // Always patterns — in "Always Do" or "Always" sections
    if (sectionLower.includes("always") && line.trim().startsWith("- ")) {
      if (!directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "always", line: lineNum, section: currentSection });
      }
    }

    // Core Principles section — treat as "always"
    if (sectionLower.includes("core principles") && line.trim().startsWith("- ")) {
      if (!directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "always", line: lineNum, section: currentSection });
      }
    }

    // Rules section — treat bullet points as "always"
    if (sectionLower === "rules" && line.trim().startsWith("- ")) {
      if (!directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "always", line: lineNum, section: currentSection });
      }
    }

    // Items in "Before writing code" or "Before reporting done" sections
    if (sectionLower.includes("before") && /^\d+\.\s/.test(line.trim())) {
      const match = line.match(RUN_PATTERN) || line.match(BUN_TEST_PATTERN) || line.match(TSC_PATTERN);
      if (match && !directives.some(d => d.line === lineNum)) {
        directives.push({ text: trimmedLine, type: "run", line: lineNum, section: currentSection, target: match[1] });
      }
    }
  }

  return directives;
}
