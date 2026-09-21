import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const HARNESS_ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || "";
const CLAUDE_MD = join(HOME, ".claude", "CLAUDE.md");
const HARNESS_MD = join(HARNESS_ROOT, "HARNESS.md");

function extractExternalDeps(harnessContent: string): string[] {
  const section = harnessContent.split("## External Dependencies")[1];
  if (!section) return [];
  const nextSection = section.indexOf("\n## ");
  const block = nextSection > -1 ? section.slice(0, nextSection) : section;
  const deps: string[] = [];
  for (const line of block.split("\n")) {
    const match = line.match(/^- `([^`]+)`/);
    if (match) deps.push(match[1]);
  }
  return deps;
}

describe("ED-1: HARNESS.md has External Dependencies section", () => {
  test("section exists", () => {
    const content = readFileSync(HARNESS_MD, "utf8");
    expect(content).toContain("## External Dependencies");
  });
});

describe.skip("ED-2: Each external dependency exists in CLAUDE.md — skipped: tests user's global CLAUDE.md, not RunGate-owned", () => {
  const harness = readFileSync(HARNESS_MD, "utf8");
  const deps = extractExternalDeps(harness);
  const claudeContent = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : "";

  for (const dep of deps) {
    test(`rule "${dep}" exists in CLAUDE.md`, () => {
      expect(claudeContent).toContain(dep);
    });
  }
});

describe("ED-3: At least 5 external dependencies listed", () => {
  test("minimum dependency count", () => {
    const content = readFileSync(HARNESS_MD, "utf8");
    const deps = extractExternalDeps(content);
    expect(deps.length).toBeGreaterThanOrEqual(5);
  });
});
