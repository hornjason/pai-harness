/**
 * Generator unit test: agents-md
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateAgentsMd, generateScopedRules } from "../lib/generators/agents-md";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";

describe("generateAgentsMd with mock ProjectScan", () => {
  test("returns string containing project name and identity", () => {
    const scan = mockProjectScan({
      name: "alpha-project",
      identity: "Alpha project for testing generators",
      techStack: ["Bun", "TypeScript"],
      repoUrl: "https://github.com/test/alpha",
    });
    const result = generateAgentsMd(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("alpha-project");
    expect(result).toContain("Alpha project for testing generators");
  });

  test("includes tech stack in output", () => {
    const scan = mockProjectScan({
      name: "beta",
      techStack: ["Node.js", "ESM", "React"],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("**Tech:** Node.js, ESM, React");
  });

  test("includes key files table rows in scoped rules", () => {
    const scan = mockProjectScan({
      name: "gamma",
      keyFiles: [
        { file: "AGENTS.md", what: "Entry point", when: "Always" },
        { file: "Makefile", what: "Build commands", when: "Deploying" },
      ],
    });
    const rules = generateScopedRules(scan);
    const keyFilesRule = rules.find(r => r.filename === "key-files.md");
    expect(keyFilesRule).toBeDefined();
    expect(keyFilesRule!.content).toContain("| AGENTS.md | Entry point | Always |");
    expect(keyFilesRule!.content).toContain("| Makefile | Build commands | Deploying |");
  });

  test("includes specs table in scoped rules", () => {
    const scan = mockProjectScan({
      name: "delta",
      specs: [
        { file: "AUTH-SPEC.md", governs: "Authentication flow", testable: "yes" },
      ],
    });
    const rules = generateScopedRules(scan);
    const specsRule = rules.find(r => r.filename === "specs-routing.md");
    expect(specsRule).toBeDefined();
    expect(specsRule!.content).toContain("| AUTH-SPEC.md | Authentication flow | yes |");
  });

  test("includes repo URL", () => {
    const scan = mockProjectScan({
      name: "epsilon",
      repoUrl: "https://github.com/org/epsilon",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("https://github.com/org/epsilon");
  });

  test("includes doc routing entries in scoped rules", () => {
    const scan = mockProjectScan({
      name: "zeta",
      docRouting: [
        { need: "API reference", file: "docs/api.md" },
      ],
    });
    const rules = generateScopedRules(scan);
    const docsRule = rules.find(r => r.filename === "docs-routing.md");
    expect(docsRule).toBeDefined();
    expect(docsRule!.content).toContain("API reference");
  });

  test("includes consumers section when present", () => {
    const scan = mockProjectScan({
      name: "eta",
      consumers: ["project-a", "project-b"],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("Consumers (2)");
    expect(result).toContain("project-a");
  });

  test("omits consumers section when empty", () => {
    const scan = mockProjectScan({
      name: "theta",
      consumers: [],
    });
    const result = generateAgentsMd(scan);
    expect(result).not.toContain("Consumers");
  });

  test("includes test command in output", () => {
    const scan = mockProjectScan({
      name: "iota",
      testCmd: "npm test",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("npm test");
  });
});
