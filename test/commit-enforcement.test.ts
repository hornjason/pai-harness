import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

describe("CommitEnforcement hook", () => {
  test("hook file exists", () => {
    expect(existsSync(join(ROOT, "hooks/CommitEnforcement.hook.ts"))).toBe(true);
  });

  test("hook detects any agent, not just marcus", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    // Should NOT have marcus-only filter
    expect(content).not.toContain("=== 'marcus'");
    // Should use generic agent detection
    expect(content).toContain("detectAgent(toolInput)");
  });

  test("hook requires worktree isolation", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    expect(content).toContain("isolation");
    expect(content).toContain("worktree");
  });

  test("signal uses agent key, not hardcoded marcus", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    expect(content).not.toContain("marcus-uncommitted");
    expect(content).toContain("agent-uncommitted");
  });

  test("system-reminder includes agent name variable", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    // Should use agent.name, not hardcoded "Marcus"
    expect(content).toContain("agent.name");
    expect(content).not.toContain("MARCUS UNCOMMITTED");
  });

  test("UI signal uses agent key dynamically", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    expect(content).toContain("quinn-required-${agent.key}");
  });

  test("skips when no agent detected", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    // Should check if agent is null/undefined
    expect(content).toContain("if (!agent)");
  });

  test("imports detectAgent from lib", async () => {
    const content = await Bun.file(join(ROOT, "hooks/CommitEnforcement.hook.ts")).text();
    expect(content).toContain("from './lib/agentDetection'");
  });
});
