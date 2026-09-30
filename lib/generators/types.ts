/**
 * ProjectScan — typed interface for scaffold scan data.
 *
 * Scanner produces this; generators consume it.
 * No shared mutable state (D-5 from SCAFFOLD-DECOMPOSITION-SPEC).
 */

export type ProjectType = "code" | "content" | "infra" | "workflow";

export interface KeyFile {
  file: string;
  what: string;
  when: string;
}

export interface SpecEntry {
  file: string;
  governs: string;
  testable: string;
}

export interface TestFile {
  label: string;
  file: string;
}

export interface RefFile {
  file: string;
  what: string;
}

export interface DocRoute {
  need: string;
  file: string;
}

export interface Category {
  dir: string;
  label: string;
  frontmatter: string;
  notes: string;
}

export interface DirEntry {
  name: string;
  fileCount: number;
  types: string[];
}

export interface ModuleEntry {
  file: string;
  exports: string[];
}

export interface RouteEntry {
  method: string;
  path: string;
  file: string;
}

export interface PromptRoute {
  file: string;
  when: string;
}

export interface AgentMeta {
  description: string;
  tools: string;
  model: string;
  tiers?: Record<string, string[]>;
}

export interface ProjectScan {
  /** Project name (from package.json or directory name) */
  name: string;
  /** Detected project type */
  type: ProjectType;
  /** Absolute path to project root */
  root: string;
  /** Project identity/description */
  identity: string;
  /** Detected tech stack entries */
  techStack: string[];
  /** Git remote URL */
  repoUrl: string;
  /** Test command (e.g., "bun test") */
  testCmd: string;
  /** Key files for agent reference */
  keyFiles: KeyFile[];
  /** Spec files with governs/testable metadata */
  specs: SpecEntry[];
  /** Test files found */
  testFiles: TestFile[];
  /** Reference files */
  refFiles: RefFile[];
  /** Documentation routing entries */
  docRouting: DocRoute[];
  /** Document categories for "Where to Create" section */
  categories: Category[];
  /** Consumer projects */
  consumers: string[];
  /** Whether CODE-MAP.md exists */
  hasCodeMap: boolean;
  /** Makefile targets string */
  makeTargets: string;
  /** Source directories found */
  sourceDirs: string[];
  /** Per-agent prompt routing */
  promptRouting: Record<string, PromptRoute[]>;
  /** Harness config from .claude/rungate.json */
  harnessConfig: Record<string, any> | null;
  /** Agent metadata (from roles config or defaults) */
  agentMeta: Record<string, AgentMeta>;
  /** Directory entries for code-map */
  dirs: DirEntry[];
  /** Dependency count */
  deps: number;
  /** Dev dependency count */
  devDeps: number;
  /** Source modules with exports */
  modules: ModuleEntry[];
  /** API routes detected */
  routes: RouteEntry[];
  /** Harness templates directory (absolute path) */
  harnessTemplatesDir: string;
  /** Prompt prefix for self-scaffolding detection */
  promptPrefix: string;
}

/**
 * Create a ProjectScan with sensible defaults for testing.
 * Override any field by passing partial data.
 */
export function mockProjectScan(overrides: Partial<ProjectScan> = {}): ProjectScan {
  return {
    name: "mock-project",
    type: "code",
    root: "/tmp/mock-project",
    identity: "Mock project for testing",
    techStack: [],
    repoUrl: "",
    testCmd: "bun test",
    keyFiles: [
      { file: "AGENTS.md", what: "Project entry point", when: "Always first" },
    ],
    specs: [],
    testFiles: [],
    refFiles: [],
    docRouting: [],
    categories: [
      { dir: "specs", label: "Specs", frontmatter: "`doc-type: spec`", notes: "SCs auto-generate tests" },
      { dir: "docs/adr", label: "ADRs", frontmatter: "`doc-type: adr`", notes: "Architecture decisions" },
    ],
    consumers: [],
    hasCodeMap: false,
    makeTargets: "",
    sourceDirs: [],
    promptRouting: {},
    harnessConfig: null,
    agentMeta: {
      marcus: {
        description: "Principal engineer",
        tools: "[Bash, Read, Write, Edit]",
        model: "sonnet",
        tiers: { reinforcement: ["Testing Rules"], mechanical: ["Workflow"] },
      },
    },
    dirs: [],
    deps: 0,
    devDeps: 0,
    modules: [],
    routes: [],
    harnessTemplatesDir: "",
    promptPrefix: "node_modules/rungate/prompts",
    ...overrides,
  };
}
