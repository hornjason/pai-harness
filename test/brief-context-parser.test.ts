import { describe, test, expect } from "bun:test";
import { parseContextPaths, buildReadSteps } from "../lib/brief-context-parser";

describe("brief-context-parser", () => {
  describe("parseContextPaths", () => {
    test("SC-406: extracts file paths from numbered Context section items", () => {
      const brief = `---
name: marcus
---

You are Marcus Webb, principal engineer.

## Context (MANDATORY — read these BEFORE any code)

1. **AGENTS.md** — MANDATORY FIRST READ — project identity, rules, routing table
2. **PROJECT-STATE.md** — current priorities, open work, what changed recently
3. **Governing spec** — look up in AGENTS.md Specs table for the area you're changing
4. **prompts/coding-principles.md** — coding standards you MUST follow
5. **prompts/testing-strategy.md** — test architecture you MUST follow
6. **CODE-MAP.md § Module Dependencies** — import chains for cascade impact analysis

## Core Principles
`;
      const paths = parseContextPaths(brief);
      expect(paths).toEqual([
        "AGENTS.md",
        "PROJECT-STATE.md",
        "prompts/coding-principles.md",
        "prompts/testing-strategy.md",
        "CODE-MAP.md",
      ]);
    });

    test("skips non-file entries like 'Governing spec'", () => {
      const brief = `## Context

1. **AGENTS.md** — read first
2. **Governing spec** — look up in AGENTS.md
3. **prompts/testing-strategy.md** — test arch
`;
      const paths = parseContextPaths(brief);
      expect(paths).not.toContain("Governing spec");
      expect(paths).toContain("AGENTS.md");
      expect(paths).toContain("prompts/testing-strategy.md");
    });

    test("handles Context section with different heading variations", () => {
      const brief = `## Context (READ THIS FIRST)

1. **AGENTS.md** — READ THIS FIRST — project identity
2. **PROJECT-STATE.md** — current priorities
`;
      const paths = parseContextPaths(brief);
      expect(paths).toContain("AGENTS.md");
      expect(paths).toContain("PROJECT-STATE.md");
    });

    test("returns empty array when no Context section exists", () => {
      const brief = `---
name: test
---

## Core Principles
- Be good
`;
      const paths = parseContextPaths(brief);
      expect(paths).toEqual([]);
    });

    test("stops parsing at next heading", () => {
      const brief = `## Context

1. **AGENTS.md** — read first

## Never Do
- Bad things
`;
      const paths = parseContextPaths(brief);
      expect(paths).toEqual(["AGENTS.md"]);
    });

    test("strips section markers from file paths", () => {
      const brief = `## Context

1. **CODE-MAP.md § Module Dependencies** — import chains
2. **AGENTS.md § Specs** — specs table
`;
      const paths = parseContextPaths(brief);
      expect(paths).toContain("CODE-MAP.md");
      expect(paths).toContain("AGENTS.md");
    });

    test("handles paths with directory separators", () => {
      const brief = `## Context

1. **specs/CONFIG-DRIVEN-TESTING-SPEC.md** — test config
2. **lib/conformity.ts** — conformity engine
3. **gates/run-gate.ts** — gate runner
`;
      const paths = parseContextPaths(brief);
      expect(paths).toEqual([
        "specs/CONFIG-DRIVEN-TESTING-SPEC.md",
        "lib/conformity.ts",
        "gates/run-gate.ts",
      ]);
    });
  });

  describe("buildReadSteps", () => {
    test("SC-406: generates explicit numbered Read steps from paths", () => {
      const paths = ["AGENTS.md", "PROJECT-STATE.md", "prompts/coding-principles.md"];
      const briefPath = "/project/.claude/agents/marcus.md";
      const steps = buildReadSteps(briefPath, paths);
      expect(steps).toContain("1. Read `/project/.claude/agents/marcus.md`");
      expect(steps).toContain("2. Read `AGENTS.md`");
      expect(steps).toContain("3. Read `PROJECT-STATE.md`");
      expect(steps).toContain("4. Read `prompts/coding-principles.md`");
    });

    test("returns brief-only step when no context paths", () => {
      const steps = buildReadSteps("/project/.claude/agents/marcus.md", []);
      expect(steps).toContain("1. Read `/project/.claude/agents/marcus.md`");
      expect(steps.split("\n").length).toBe(1);
    });
  });
});
