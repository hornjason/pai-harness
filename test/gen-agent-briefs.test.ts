/**
 * Generator unit test: agent-briefs
 * AC-4: Tests generators with mock ProjectScan data
 */
import { test, expect, describe } from "bun:test";
import { generateAgentBriefs } from "../lib/generators/agent-briefs";
import { mockProjectScan, type ProjectScan } from "../lib/generators/types";

describe("generateAgentBriefs with mock ProjectScan", () => {
  test("returns record of agent name to content string", () => {
    const scan = mockProjectScan({
      name: "test-project",
      identity: "Test project for brief generation",
      sourceDirs: ["src", "lib"],
    });
    const result = generateAgentBriefs(scan);
    expect(typeof result).toBe("object");
    expect(result.marcus).toBeDefined();
    expect(typeof result.marcus).toBe("string");
  });

  test("generated marcus brief has frontmatter with name", () => {
    const scan = mockProjectScan({ name: "brief-test" });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toMatch(/^---\n/);
    expect(result.marcus).toContain("name: marcus");
  });

  test("no unfilled ${VAR} template variables remain", () => {
    const scan = mockProjectScan({
      name: "clean-vars",
      identity: "Clean variable test",
      sourceDirs: ["src"],
    });
    const result = generateAgentBriefs(scan);
    for (const [agent, content] of Object.entries(result)) {
      const unfilled = content.match(/\$\{[A-Z_]+\}/g);
      expect(unfilled).toBeNull();
    }
  });

  test("fills PROJECT_IDENTITY from scan.identity", () => {
    const scan = mockProjectScan({
      name: "identity-test",
      identity: "Unique identity for AC4 testing",
    });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toContain("Unique identity for AC4 testing");
  });

  test("fills SHARED_RULES from _shared.md partial", () => {
    const scan = mockProjectScan({ name: "shared-test" });
    const result = generateAgentBriefs(scan);
    // _shared.md contains "Verify before asserting"
    expect(result.marcus).toContain("Verify before asserting");
  });

  test("includes source dirs when present", () => {
    const scan = mockProjectScan({
      name: "dirs-test",
      sourceDirs: ["src", "lib", "gates"],
    });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toContain("`src/`");
    expect(result.marcus).toContain("`lib/`");
  });

  test("includes prompt routing when provided", () => {
    const scan = mockProjectScan({
      name: "routing-test",
      promptRouting: {
        marcus: [
          { file: "prompts/coding.md", when: "Coding standards" },
        ],
      },
    });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toContain("prompts/coding.md");
    expect(result.marcus).toContain("Coding standards");
  });

  test("uses agentMeta from scan for frontmatter", () => {
    const scan = mockProjectScan({
      name: "meta-test",
      agentMeta: {
        marcus: {
          description: "Custom description for marcus",
          tools: "[Bash, Read, Write]",
          model: "sonnet",
        },
      },
    });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toContain("description: Custom description for marcus");
  });
});
