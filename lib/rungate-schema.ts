import { z } from "zod";

const DevSchema = z.object({
  start: z.string(),
  apiBase: z.string().url(),
  uiBase: z.string().url(),
  preStart: z.string().optional(),
  testCmd: z.string().optional(),
  typeCheck: z.string().optional(),
  note: z.string().optional(),
});

/**
 * `command` and `timeout` are the keys `workflows/ship.js` has always assumed
 * — its setup-agent JSON schema declares both (`ship.js:1651`) and rungate's
 * own `.claude/rungate.json` authors both. Until they were declared here, zod
 * stripped them on every validated read, so the validated path was lossier
 * than the raw one and #254's container path rested on keys the validator
 * deleted. Nothing is deprecated by declaring them: per ADR-002 D3 `dev.*` is
 * canonical as the authored shape and `test.command` keeps being read.
 */
const TestSchema = z.object({
  start: z.string().optional(),
  apiBase: z.string().url().optional(),
  note: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
});

/**
 * The test-container block `ship.js:3754` reads and `ship.js:1651` declares.
 *
 * `rebuildCommand` is interpolated verbatim into an agent prompt, so the
 * *shape* being declared here constrains nothing about its *value* — the
 * "never hand `make rebuild` to an agent" rule (PROJECT-STATE item 8, DDB's
 * CLAUDE.md, and DDB's Makefile worktree guard) is enforced by test, not by
 * this type.
 *
 * It sits beside `prod.rebuild` rather than merging with it on purpose: `prod`
 * describes promotion to the production container, `container` describes the
 * throwaway test container the verify phase rebuilds. Two rebuild-ish keys
 * coexist, and collapsing them would make a verify-phase rebuild able to touch
 * production.
 */
const ContainerSchema = z.object({
  port: z.number().optional(),
  rebuildCommand: z.string().optional(),
  healthPath: z.string().optional(),
  hosts: z.array(z.string()).optional(),
});

export type ContainerConfig = z.infer<typeof ContainerSchema>;

const ProdSchema = z.object({
  rebuild: z.string().optional(),
  apiBase: z.string().url().optional(),
  uiBase: z.string().url().optional(),
  smokeTest: z.string().optional(),
});

const McpServerSchema = z.object({
  name: z.string(),
  tools: z.array(z.string()).optional(),
});

const ResearchToolSchema = z.object({
  name: z.string(),
  type: z.enum(["mcp", "cli", "api"]).optional(),
});

const RoleSchema = z.object({
  brief: z.string(),
  isolation: z.string().optional(),
  standardTask: z.string(),
  description: z.string().optional(),
  tools: z.string().optional(),
  model: z.string().optional(),
  tiers: z.record(z.array(z.string())).optional(),
});

export type RoleConfig = z.infer<typeof RoleSchema>;

const CeremonyTierOverrideSchema = z.object({
  maxIterations: z.number().optional(),
  checks: z.record(z.array(z.string())).optional(),
  skipScopeGate: z.boolean().optional(),
  githubComments: z.number().optional(),
  stopMarkers: z.number().optional(),
  agents: z.record(z.union([z.boolean(), z.string()])).optional(),
}).passthrough();

export const ProjectHarnessSchema = z.object({
  project: z.string(),
  repo: z.string(),
  issueRepo: z.string(),
  dev: DevSchema.optional(),
  test: TestSchema.optional(),
  prod: ProdSchema.optional(),
  container: ContainerSchema.optional(),
  pages: z.record(z.string()).optional(),
  codeCommittedPaths: z.array(z.string()).optional(),
  consumers: z.array(z.string()).optional(),
  promptKeywords: z.record(z.array(z.string())).optional(),
  contextDocs: z.record(z.string().nullable()).optional(),
  mcp: z.array(McpServerSchema).optional(),
  research: z.array(ResearchToolSchema).optional(),
  roles: z.record(RoleSchema).optional(),
  stalenessThreshold: z.number().optional(),
  ceremonyOverrides: z.record(CeremonyTierOverrideSchema).optional(),
  schemaVersion: z.number().default(1),
}).passthrough();
// `.passthrough()` because declaring a key must be how a reader gets a TYPE,
// not how a key earns the right to exist. Stripping by default made the
// validated read lossier than `JSON.parse` — DDB's `remoteHosts` and the
// directory form's merged `hooks`/`compliance` all vanished through it — which
// gave every caller a reason to bypass the validator. Passthrough can only
// preserve more, never less.

export type ProjectHarness = z.infer<typeof ProjectHarnessSchema>;

export function parseProjectHarness(raw: unknown): ProjectHarness {
  return ProjectHarnessSchema.parse(raw);
}

export function safeParseProjectHarness(raw: unknown) {
  return ProjectHarnessSchema.safeParse(raw);
}
