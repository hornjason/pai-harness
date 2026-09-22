import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { extractDirectives, type Directive } from "../lib/directive-extractor.js";

const ROOT = join(import.meta.dir, "..");

describe("directive-extractor", () => {
  test("extracts >= 10 directives from marcus.md (AC-2)", () => {
    const briefPath = join(ROOT, ".claude/agents/marcus.md");
    const content = readFileSync(briefPath, "utf-8");
    const directives = extractDirectives(content);

    expect(directives.length).toBeGreaterThanOrEqual(10);
  });

  test("extracts read directives with file targets", () => {
    const brief = `## Context (MANDATORY)
1. **AGENTS.md** — MANDATORY FIRST READ
2. **PROJECT-STATE.md** — current priorities
3. Read \`prompts/coding-principles.md\`
`;
    const directives = extractDirectives(brief);
    const reads = directives.filter((d) => d.type === "read");

    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.some((d) => d.target === "AGENTS.md")).toBe(true);
    expect(reads.some((d) => d.target === "PROJECT-STATE.md")).toBe(true);
    expect(reads.some((d) => d.target === "prompts/coding-principles.md")).toBe(true);
  });

  test("extracts run directives with command targets", () => {
    const brief = `## Always Do
- Run \`bun test\` after every change
- Run \`bunx tsc --noEmit\` — no type errors
`;
    const directives = extractDirectives(brief);
    const runs = directives.filter((d) => d.type === "run");

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.some((d) => d.target?.includes("bun test"))).toBe(true);
    expect(runs.some((d) => d.target?.includes("tsc"))).toBe(true);
  });

  test("extracts never directives", () => {
    const brief = `## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
- Use \`cat\` via Bash — use Read tool instead
`;
    const directives = extractDirectives(brief);
    const nevers = directives.filter((d) => d.type === "never");

    expect(nevers.length).toBeGreaterThanOrEqual(3);
  });

  test("extracts always directives", () => {
    const brief = `## Always Do
- Run \`bun test\` after every change
- Read AGENTS.md before starting work
- Verify before asserting
`;
    const directives = extractDirectives(brief);
    // Run/Read patterns take priority over section-based typing
    // "Verify before asserting" is the pure always directive
    const always = directives.filter((d) => d.type === "always");
    expect(always.length).toBeGreaterThanOrEqual(1);

    // All directives from Always Do section should be extracted
    expect(directives.length).toBeGreaterThanOrEqual(2);
  });

  test("captures line number and section for each directive", () => {
    const brief = `## Context
1. **AGENTS.md** — read first

## Never Do
- Skip tests
`;
    const directives = extractDirectives(brief);

    expect(directives.length).toBeGreaterThanOrEqual(2);
    for (const d of directives) {
      expect(d.line).toBeGreaterThan(0);
      expect(d.section).toBeTruthy();
    }
  });

  test("does not extract from comments or headers", () => {
    const brief = `# Header line
// Comment with Read \`file.md\`
## Section
- Read \`real-file.md\`
`;
    const directives = extractDirectives(brief);
    // Only the real-file.md should be extracted
    const reads = directives.filter((d) => d.type === "read");
    expect(reads.length).toBe(1);
    expect(reads[0].target).toBe("real-file.md");
  });

  test("extracts from Additional Never Do section", () => {
    const brief = `## Additional Never Do
- Read the same file twice
- Run \`bun test\` more than twice
`;
    const directives = extractDirectives(brief);
    // "Read the same file twice" stays as never (no file extension target)
    // "Run `bun test` more than twice" may be classified as run due to pattern match
    // At least 1 never directive should be extracted
    const nevers = directives.filter((d) => d.type === "never");
    expect(nevers.length).toBeGreaterThanOrEqual(1);

    // Both lines should produce directives regardless of type
    expect(directives.length).toBeGreaterThanOrEqual(2);
  });

  test("extracts from Core Principles section as always", () => {
    const brief = `## Core Principles
- Verify before asserting
- Never report PASS with known gaps
`;
    const directives = extractDirectives(brief);
    const always = directives.filter((d) => d.type === "always");
    const nevers = directives.filter((d) => d.type === "never");

    // "Verify before asserting" is always, "Never report..." is never
    expect(always.length).toBeGreaterThanOrEqual(1);
    expect(nevers.length).toBeGreaterThanOrEqual(1);
    expect(directives.length).toBeGreaterThanOrEqual(2);
  });

  test("classifies 'Never run make rebuild' as never, not run (bug fix)", () => {
    const brief = `## Rules

- Never run \`make rebuild\` — only the DA does that
- Dev server: \`make dev-all\`
`;
    const directives = extractDirectives(brief);
    const neverRebuild = directives.find((d) => d.text.includes("make rebuild"));

    expect(neverRebuild).toBeDefined();
    expect(neverRebuild!.type).toBe("never");
  });

  test("classifies Never-prefixed lines as never regardless of section", () => {
    const brief = `## Always Do
- Never skip the verification step
- Run \`bun test\` after changes
`;
    const directives = extractDirectives(brief);
    const neverSkip = directives.find((d) => d.text.includes("Never skip"));

    expect(neverSkip).toBeDefined();
    expect(neverSkip!.type).toBe("never");
  });

  test("does not duplicate directives at same line", () => {
    const brief = `## Context
1. Read \`AGENTS.md\` — **AGENTS.md** mandatory first
`;
    const directives = extractDirectives(brief);
    const lines = directives.map((d) => d.line);
    const uniqueLines = [...new Set(lines)];
    expect(lines.length).toBe(uniqueLines.length);
  });

  test("all directive types are present in marcus.md", () => {
    const briefPath = join(ROOT, ".claude/agents/marcus.md");
    const content = readFileSync(briefPath, "utf-8");
    const directives = extractDirectives(content);

    const types = new Set(directives.map((d) => d.type));
    expect(types.has("read")).toBe(true);
    expect(types.has("never")).toBe(true);
    expect(types.has("always")).toBe(true);
  });
});
