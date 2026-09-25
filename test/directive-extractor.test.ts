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

  // ── SC-465: Directive category field ──

  test("every directive has a category field (SC-465)", () => {
    const brief = `## Context (MANDATORY)
1. **AGENTS.md** — read first

## Workflow
1. Run \`bun test\` — baseline

## Never Do
- Use cat via Bash
`;
    const directives = extractDirectives(brief);
    for (const d of directives) {
      expect(d.category).toBeDefined();
      expect(["quality", "process"]).toContain(d.category);
    }
  });

  // ── SC-466: Context, Always Do, Ask First → process ──

  test("Context section directives are process (SC-466)", () => {
    const brief = `## Context (READ THIS FIRST)
1. **AGENTS.md** — MANDATORY FIRST READ
2. **PROJECT-STATE.md** — current priorities
`;
    const directives = extractDirectives(brief);
    expect(directives.length).toBeGreaterThanOrEqual(2);
    for (const d of directives) {
      expect(d.category).toBe("process");
    }
  });

  test("Always Do section directives are process (SC-466)", () => {
    const brief = `## Always Do
- Read AGENTS.md before starting work
- Verify before asserting
`;
    const directives = extractDirectives(brief);
    expect(directives.length).toBeGreaterThanOrEqual(2);
    for (const d of directives) {
      expect(d.category).toBe("process");
    }
  });

  test("Ask First section directives are process (SC-466)", () => {
    const brief = `## Ask First
- Modifying files outside the brief scope
- Adding new dependencies
`;
    const directives = extractDirectives(brief);
    for (const d of directives) {
      expect(d.category).toBe("process");
    }
  });

  // ── SC-467: All other sections default to quality ──

  test("Workflow section directives are quality (SC-467)", () => {
    const brief = `## Workflow
1. Run \`bun test\` — establish baseline
- Never skip the governing spec
`;
    const directives = extractDirectives(brief);
    expect(directives.length).toBeGreaterThanOrEqual(1);
    for (const d of directives) {
      expect(d.category).toBe("quality");
    }
  });

  test("Never Do section directives default to quality (SC-467)", () => {
    const brief = `## Never Do
- Self-attest evidence (tier F)
- Skip ACs without rationale
`;
    const directives = extractDirectives(brief);
    expect(directives.length).toBeGreaterThanOrEqual(2);
    for (const d of directives) {
      expect(d.category).toBe("quality");
    }
  });

  test("Testing Rules section directives are quality (SC-467)", () => {
    const brief = `## Testing Rules
- Run \`bun test\` exactly twice: once for baseline, once after changes
`;
    const directives = extractDirectives(brief);
    expect(directives.length).toBeGreaterThanOrEqual(1);
    for (const d of directives) {
      expect(d.category).toBe("quality");
    }
  });

  // ── SC-468: process_overrides frontmatter ──

  test("process_overrides demotes matching directives to process (SC-468)", () => {
    const brief = `---
name: marcus
process_overrides:
  - "Use cat via Bash"
  - "Read the same file twice"
---

## Never Do
- Self-attest evidence (tier F)
- Use \`cat\` via Bash — use Read tool instead
- Read the same file twice
`;
    const directives = extractDirectives(brief);
    const selfAttest = directives.find(d => d.text.includes("Self-attest"));
    const cat = directives.find(d => d.text.includes("cat"));
    const duplicate = directives.find(d => d.text.includes("same file twice"));

    expect(selfAttest?.category).toBe("quality");
    expect(cat?.category).toBe("process");
    expect(duplicate?.category).toBe("process");
  });

  test("process_overrides with no matching text has no effect (SC-468)", () => {
    const brief = `---
name: test
process_overrides:
  - "nonexistent rule"
---

## Workflow
1. Run \`bun test\` — baseline
`;
    const directives = extractDirectives(brief);
    for (const d of directives) {
      expect(d.category).toBe("quality");
    }
  });

  // ── Category on real briefs ──

  test("marcus.md has both quality and process directives", () => {
    const briefPath = join(ROOT, ".claude/agents/marcus.md");
    const content = readFileSync(briefPath, "utf-8");
    const directives = extractDirectives(content);

    const categories = new Set(directives.map(d => d.category));
    expect(categories.has("quality")).toBe(true);
    expect(categories.has("process")).toBe(true);

    const contextDirectives = directives.filter(d => d.section.toLowerCase().includes("context"));
    for (const d of contextDirectives) {
      expect(d.category).toBe("process");
    }
  });
});
