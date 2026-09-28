/**
 * Generator unit test: agents-md
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateAgentsMd } from "../lib/generators/agents-md";
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

  test("includes key files table rows", () => {
    const scan = mockProjectScan({
      name: "gamma",
      keyFiles: [
        { file: "AGENTS.md", what: "Entry point", when: "Always" },
        { file: "Makefile", what: "Build commands", when: "Deploying" },
      ],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("| AGENTS.md | Entry point | Always |");
    expect(result).toContain("| Makefile | Build commands | Deploying |");
  });

  test("includes specs table", () => {
    const scan = mockProjectScan({
      name: "delta",
      specs: [
        { file: "AUTH-SPEC.md", governs: "Authentication flow", testable: "yes" },
      ],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("| AUTH-SPEC.md | Authentication flow | yes |");
  });

  test("includes repo URL", () => {
    const scan = mockProjectScan({
      name: "epsilon",
      repoUrl: "https://github.com/org/epsilon",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("https://github.com/org/epsilon");
  });

  test("includes doc routing entries", () => {
    const scan = mockProjectScan({
      name: "zeta",
      docRouting: [
        { need: "API reference", file: "docs/api.md" },
      ],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("API reference");
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
