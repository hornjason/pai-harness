/**
 * Config path naming — generated guidance must point agents at the rungate
 * config directory (`.claude/rungate/`), never the retired monolith
 * `.claude/rungate.json`.
 *
 * AC-1: generated AGENTS.md harness-owned table names the rungate directory
 *       for ci.yml, gates.yml, and agent briefs
 * AC-2: Dev UI / Dev API not-configured fallbacks name the rungate directory
 * AC-3: no agent-brief template names .claude/rungate.json
 * AC-4: regression — .claude/rungate.json must not reappear in generated
 *       AGENTS.md content or generated brief content
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const TEMPLATES_DIR = join(ROOT, "templates/agent-briefs");

/** The retired monolith path. Must never appear in generated guidance. */
const MONOLITH = ".claude/rungate.json";
/** The directory that replaced it. */
const CONFIG_DIR = ".claude/rungate/";

/** Matches `.claude/rungate.json` but not `.claude/rungate/config.json`. */
const MONOLITH_RE = /\.claude\/rungate\.json/;

async function scopedRules() {
  const { generateScopedRules } = await import("../lib/generators/agents-md");
  const { mockProjectScan } = await import("../lib/generators/types");
  return generateScopedRules(mockProjectScan({ name: "test-project" }));
}

async function harnessManagedRule() {
  const rules = await scopedRules();
  const rule = rules.find(r => r.filename === "harness-managed.md");
  expect(rule).toBeDefined();
  return rule!;
}

// ── AC-1: harness-owned table names the rungate directory ──────────────

describe("AC-1: generated AGENTS.md harness-owned table", () => {
  test("ci.yml row names the rungate directory, not the monolith", async () => {
    const rule = await harnessManagedRule();
    const row = rule.content.split("\n").find(l => l.includes("ci.yml"));
    expect(row).toBeDefined();
    expect(row!).toContain(CONFIG_DIR);
    expect(row!).not.toMatch(MONOLITH_RE);
  });

  test("gates.yml row names the rungate directory, not the monolith", async () => {
    const rule = await harnessManagedRule();
    const row = rule.content.split("\n").find(l => l.includes("gates.yml"));
    expect(row).toBeDefined();
    expect(row!).toContain(CONFIG_DIR);
    expect(row!).not.toMatch(MONOLITH_RE);
  });

  test("agent briefs row names the rungate directory, not the monolith", async () => {
    const rule = await harnessManagedRule();
    const row = rule.content.split("\n").find(l => l.includes(".claude/agents/*.md"));
    expect(row).toBeDefined();
    expect(row!).toContain(CONFIG_DIR);
    expect(row!).not.toMatch(MONOLITH_RE);
  });
});

// ── AC-2: Dev UI / Dev API fallbacks ───────────────────────────────────

describe("AC-2: not-configured fallback lines", () => {
  test("agent-briefs.ts fallbacks name the rungate directory", () => {
    const src = readFileSync(join(ROOT, "lib/generators/agent-briefs.ts"), "utf-8");
    const fallbacks = src.split("\n").filter(l => l.includes("not configured"));
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
    for (const line of fallbacks) {
      expect(line).toContain(CONFIG_DIR);
      expect(line).not.toMatch(MONOLITH_RE);
    }
  });

  test("generated briefs render the directory path when dev is unconfigured", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const briefs = generateAgentBriefs(mockProjectScan({
      name: "test-project",
      harnessTemplatesDir: TEMPLATES_DIR,
    }));
    const rendered = Object.values(briefs).join("\n");
    expect(rendered.length).toBeGreaterThan(0);

    const notConfigured = rendered.split("\n").filter(l => l.includes("not configured"));
    expect(notConfigured.length).toBeGreaterThanOrEqual(2);
    for (const line of notConfigured) {
      expect(line).toContain(CONFIG_DIR);
    }
  });
});

// ── AC-3: no template names the monolith ───────────────────────────────

describe("AC-3: agent-brief templates", () => {
  const templates = readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".md"));

  test("template directory is non-empty", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const file of templates) {
    test(`${file} does not name ${MONOLITH}`, () => {
      const content = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
      expect(content).not.toMatch(MONOLITH_RE);
    });
  }
});

// ── AC-4: regression guard on generated output ─────────────────────────

describe("AC-4: regression — monolith path must not reappear", () => {
  test("generated AGENTS.md body is free of the monolith path", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const md = generateAgentsMd(mockProjectScan({ name: "test-project" }));
    expect(md).not.toMatch(MONOLITH_RE);
  });

  test("every generated scoped rule file is free of the monolith path", async () => {
    const rules = await scopedRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.content).not.toMatch(MONOLITH_RE);
    }
  });

  test("every generated agent brief is free of the monolith path", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const briefs = generateAgentBriefs(mockProjectScan({
      name: "test-project",
      harnessTemplatesDir: TEMPLATES_DIR,
    }));
    expect(Object.keys(briefs).length).toBeGreaterThan(0);
    for (const [name, content] of Object.entries(briefs)) {
      expect(`${name}: ${content}`).not.toMatch(MONOLITH_RE);
    }
  });
});
