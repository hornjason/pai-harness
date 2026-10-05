import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateAgentBriefsStep } from "../../lib/scaffold/steps";
import { DEFAULT_AGENT_META } from "../../lib/create-brief";

/**
 * buildAgentMeta was declared twice with different parameter shapes. The second
 * declaration won, so the scaffold call site — which passed `harness.roles`
 * rather than the whole config — got an empty map and DEFAULT_AGENT_META always
 * won. Unit tests on buildAgentMeta itself passed throughout, because nothing
 * covered a project's rungate.json actually reaching a generated brief.
 */
function withProject(roles: Record<string, unknown>, fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "brief-routing-"));
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "consumer-proj" }));
    writeFileSync(join(root, ".claude", "rungate.json"), JSON.stringify({ roles }, null, 2));
    generateAgentBriefsStep(root, []);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function briefModel(root: string, role: string): string | undefined {
  const src = readFileSync(join(root, ".claude", "agents", `${role}.md`), "utf-8");
  return src.match(/^model:\s*(\S+)/m)?.[1];
}

describe("agent briefs honor the project's rungate.json roles config", () => {
  it("a role model from config overrides DEFAULT_AGENT_META", () => {
    // Pick a value the defaults do not already use, so a pass cannot come
    // from the fallback happening to agree.
    expect(DEFAULT_AGENT_META.rook.model).not.toBe("haiku");

    withProject({ rook: { description: "Security engineer", tools: "[Bash, Read]", model: "haiku" } }, root => {
      expect(briefModel(root, "rook")).toBe("haiku");
    });
  });

  it("a role description from config reaches the brief", () => {
    withProject(
      { serena: { description: "Consumer-specific architect role", tools: "[Read]", model: "sonnet" } },
      root => {
        const src = readFileSync(join(root, ".claude", "agents", "serena.md"), "utf-8");
        expect(src).toContain("Consumer-specific architect role");
      },
    );
  });

  it("roles absent from config still fall back to the defaults", () => {
    withProject({ rook: { description: "Security engineer", tools: "[Bash, Read]", model: "haiku" } }, root => {
      expect(briefModel(root, "marcus")).toBe(DEFAULT_AGENT_META.marcus.model);
    });
  });

  it("an empty roles config leaves every default intact", () => {
    withProject({}, root => {
      for (const [role, meta] of Object.entries(DEFAULT_AGENT_META)) {
        expect(briefModel(root, role)).toBe(meta.model);
      }
    });
  });
});
