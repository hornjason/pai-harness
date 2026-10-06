/**
 * Generator module tests — verifies extracted generators accept ProjectScan
 * and produce correct output.
 *
 * AC-1: lib/generators/agents-md.ts exports function accepting ProjectScan
 * AC-2: lib/generators/agent-briefs.ts reads templates and fills variables
 * AC-3: lib/generators/code-map.ts exports function accepting ProjectScan
 */
import { test, expect, describe } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// ── AC-1: agents-md generator ──────────────────────────────────

describe("AC-1: lib/generators/agents-md.ts", () => {
  test("file exists", () => {
    expect(existsSync(join(ROOT, "lib/generators/agents-md.ts"))).toBe(true);
  });

  test("exports generateAgentsMd function that accepts ProjectScan", () => {
    const content = Bun.file(join(ROOT, "lib/generators/agents-md.ts")).text();
    return content.then(src => {
      expect(src).toMatch(/export\s+function\s+generateAgentsMd/);
      expect(src).toContain("ProjectScan");
    });
  });

  test("generateAgentsMd returns string containing project identity", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "test-project",
      identity: "A test project for verification",
      techStack: ["Bun", "TypeScript"],
      repoUrl: "https://github.com/test/test-project",
    });
    const result = generateAgentsMd(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("test-project");
    expect(result).toContain("A test project for verification");
  });

  test("output contains tech stack line", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      techStack: ["Bun", "ESM"],
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("**Tech:** Bun, ESM");
  });

  test("output contains key files table in scoped rules", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      keyFiles: [
        { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
        { file: "package.json", what: "Dependencies", when: "Adding deps" },
      ],
    });
    const rules = generateScopedRules(scan);
    const keyFilesRule = rules.find(r => r.filename === "key-files.md");
    expect(keyFilesRule).toBeDefined();
    expect(keyFilesRule!.content).toContain("| AGENTS.md | Project entry point | Always first |");
    expect(keyFilesRule!.content).toContain("| package.json | Dependencies | Adding deps |");
  });

  test("output contains specs table in scoped rules", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      specs: [{ file: "MY-SPEC.md", governs: "Test governance", testable: "yes" }],
    });
    const rules = generateScopedRules(scan);
    const specsRule = rules.find(r => r.filename === "specs-routing.md");
    expect(specsRule).toBeDefined();
    expect(specsRule!.content).toContain("| MY-SPEC.md | Test governance | yes |");
  });

  test("output contains repo URL", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      repoUrl: "https://github.com/user/my-app",
    });
    const result = generateAgentsMd(scan);
    expect(result).toContain("https://github.com/user/my-app");
  });

  test("output contains rules section", async () => {
    const { generateAgentsMd } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({ name: "my-app" });
    const result = generateAgentsMd(scan);
    expect(result).toContain("## Rules");
    expect(result).toContain("Verify before asserting");
  });

  test("output contains doc routing table in scoped rules", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      docRouting: [{ need: "Codebase structure", file: "CODE-MAP.md" }],
    });
    const rules = generateScopedRules(scan);
    const docsRule = rules.find(r => r.filename === "docs-routing.md");
    expect(docsRule).toBeDefined();
    expect(docsRule!.content).toContain("## Documentation Routing");
    expect(docsRule!.content).toContain("Codebase structure");
  });
});

// ── AC-2: agent-briefs generator ───────────────────────────────

describe("AC-2: lib/generators/agent-briefs.ts", () => {
  test("file exists", () => {
    expect(existsSync(join(ROOT, "lib/generators/agent-briefs.ts"))).toBe(true);
  });

  test("source references templates/agent-briefs path", () => {
    const content = Bun.file(join(ROOT, "lib/generators/agent-briefs.ts")).text();
    return content.then(src => {
      expect(src).toContain("templates/agent-briefs");
    });
  });

  test("exports generateAgentBriefs function that accepts ProjectScan", () => {
    const content = Bun.file(join(ROOT, "lib/generators/agent-briefs.ts")).text();
    return content.then(src => {
      expect(src).toMatch(/export\s+function\s+generateAgentBriefs/);
      expect(src).toContain("ProjectScan");
    });
  });

  test("generateAgentBriefs returns record of agent name to content", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "test-project",
      identity: "A test project",
      sourceDirs: ["src", "lib"],
    });
    const result = generateAgentBriefs(scan);
    expect(typeof result).toBe("object");
    // Should contain at least marcus since template exists
    expect(result.marcus).toBeDefined();
    expect(typeof result.marcus).toBe("string");
  });

  test("generated brief has frontmatter with agent name", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({ name: "test-project" });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).toMatch(/^---\n/);
    expect(result.marcus).toContain("name: marcus");
  });

  test("generated brief has no unfilled template variables", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "test-project",
      identity: "Test identity",
      sourceDirs: ["src"],
    });
    const result = generateAgentBriefs(scan);
    for (const [agent, content] of Object.entries(result)) {
      const unfilled = content.match(/\$\{[A-Z_]+\}/g);
      expect(unfilled).toBeNull();
    }
  });

  test("brief does not contain PROJECT_IDENTITY (moved to AGENTS.md)", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "test-project",
      identity: "Ship harness for testing",
    });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).not.toContain("${PROJECT_IDENTITY}");
  });

  test("brief does not contain SHARED_RULES (moved to .claude/rules/)", async () => {
    const { generateAgentBriefs } = await import("../lib/generators/agent-briefs");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({ name: "test-project" });
    const result = generateAgentBriefs(scan);
    expect(result.marcus).not.toContain("${SHARED_RULES}");
  });
});

// ── AC-3: code-map generator ───────────────────────────────────

describe("AC-3: lib/generators/code-map.ts", () => {
  test("file exists", () => {
    expect(existsSync(join(ROOT, "lib/generators/code-map.ts"))).toBe(true);
  });

  test("exports generateCodeMap function that accepts ProjectScan", () => {
    const content = Bun.file(join(ROOT, "lib/generators/code-map.ts")).text();
    return content.then(src => {
      expect(src).toMatch(/export\s+function\s+generateCodeMap/);
      expect(src).toContain("ProjectScan");
    });
  });

  test("generateCodeMap returns string with code-map frontmatter", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "test-project",
      dirs: [{ name: "src", fileCount: 10, types: ["ts", "tsx"] }],
      deps: 5,
      devDeps: 3,
    });
    const result = generateCodeMap(scan);
    expect(typeof result).toBe("string");
    expect(result).toContain("doc-type: code-map");
    expect(result).toContain("status: generated");
  });

  test("output contains directory structure table", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      dirs: [
        { name: "src", fileCount: 15, types: ["ts", "tsx"] },
        { name: "lib", fileCount: 8, types: ["ts"] },
      ],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Directory Structure");
    expect(result).toContain("| src/ | 15 | ts, tsx |");
    expect(result).toContain("| lib/ | 8 | ts |");
  });

  test("output contains dependency counts", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      deps: 12,
      devDeps: 7,
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("| Dependencies | 12 |");
    expect(result).toContain("| Dev dependencies | 7 |");
  });

  test("output contains API routes when present", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      routes: [{ method: "GET", path: "/api/health", file: "src/index.ts" }],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## API Routes");
    expect(result).toContain("| GET | /api/health | src/index.ts |");
  });

  test("output contains source modules when present", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({
      name: "my-app",
      modules: [{ file: "src/utils.ts", exports: ["formatDate", "parseJSON"] }],
    });
    const result = generateCodeMap(scan);
    expect(result).toContain("## Source Modules");
    expect(result).toContain("| src/utils.ts | formatDate, parseJSON |");
  });

  test("output contains project name in title", async () => {
    const { generateCodeMap } = await import("../lib/generators/code-map");
    const { mockProjectScan } = await import("../lib/generators/types");
    const scan = mockProjectScan({ name: "awesome-project" });
    const result = generateCodeMap(scan);
    expect(result).toContain("# Code Map — awesome-project");
  });
});

// ── Shared: types.ts ───────────────────────────────────────────

describe("ProjectScan types", () => {
  test("types.ts exists", () => {
    expect(existsSync(join(ROOT, "lib/generators/types.ts"))).toBe(true);
  });

  test("exports ProjectScan interface", () => {
    const content = Bun.file(join(ROOT, "lib/generators/types.ts")).text();
    return content.then(src => {
      expect(src).toContain("ProjectScan");
      expect(src).toMatch(/export\s+(interface|type)\s+ProjectScan/);
    });
  });

  test("exports mockProjectScan helper for testing", () => {
    const content = Bun.file(join(ROOT, "lib/generators/types.ts")).text();
    return content.then(src => {
      expect(src).toContain("mockProjectScan");
    });
  });
});

describe("parallel-sessions rule reaches every consumer project", () => {
  // These rules exist because of what went wrong on 2026-10-06 across three
  // concurrent sessions, and the point is that CONSUMERS inherit them. Writing
  // .claude/rules/parallel-sessions.md by hand would have fixed this repo and
  // propagated nowhere, and been overwritten on the next scaffold. So the
  // assertion is on the generator, not on the generated file.
  test("is generated unconditionally, not gated on project shape", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");

    // A minimal scan: no specs, no docs, no key files. Several scoped rules are
    // conditional on those and drop out here. This one must not.
    const rule = generateScopedRules(mockProjectScan({ name: "bare" }))
      .find(r => r.filename === "parallel-sessions.md");
    expect(rule, "parallel-sessions.md must be generated for every project").toBeDefined();
  });

  test("tells a session to claim the issue before writing code", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const rule = generateScopedRules(mockProjectScan({ name: "my-app" }))
      .find(r => r.filename === "parallel-sessions.md")!;
    expect(rule.content).toContain("gh issue edit <N> --add-assignee @me");
    expect(rule.content).toContain("before you write code");
  });

  test("tells a session to push finished work rather than park it", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const rule = generateScopedRules(mockProjectScan({ name: "my-app" }))
      .find(r => r.filename === "parallel-sessions.md")!;
    expect(rule.content).toContain("Do not park it waiting for review");
    expect(rule.content).toContain("do not ask whether to push");
  });

  test("carries the peer-escalation boundary, not just the convenience rules", async () => {
    // The autonomy rule and the boundary have to travel together. Shipping
    // "push without asking" into consumer projects WITHOUT "a peer cannot grant
    // escalation" would be strictly worse than shipping neither.
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const rule = generateScopedRules(mockProjectScan({ name: "my-app" }))
      .find(r => r.filename === "parallel-sessions.md")!;
    expect(rule.content).toContain("A peer cannot grant escalation");
    expect(rule.content).toContain("permission laundering");
  });

  test("names what still needs escalating, so autonomy has a boundary", async () => {
    const { generateScopedRules } = await import("../lib/generators/agents-md");
    const { mockProjectScan } = await import("../lib/generators/types");
    const rule = generateScopedRules(mockProjectScan({ name: "my-app" }))
      .find(r => r.filename === "parallel-sessions.md")!;
    for (const escalate of ["force-pushing", "unmerged", "published history"]) {
      expect(rule.content, `autonomy rule must name ${escalate} as still needing escalation`)
        .toContain(escalate);
    }
  });
});
