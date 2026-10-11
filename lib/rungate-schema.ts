import { z } from "zod";

export const DevSchema = z.object({
  start: z.string(),
  apiBase: z.string().url(),
  uiBase: z.string().url(),
  preStart: z.string().optional(),
  testCmd: z.string().optional(),
  typeCheck: z.string().optional(),
  note: z.string().optional(),
});

/**
 * `command`/`timeout` were read by gate-executor.ts, ship.js and prove.js and
 * declared by none of them in zod, so validation deleted the two keys the
 * readers depend on. ship.js's own inline JSON schema (`:1651`) has always
 * declared both — this brings zod up to what the harness already assumed.
 */
export const TestSchema = z.object({
  start: z.string().optional(),
  apiBase: z.string().url().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  note: z.string().optional(),
});

/**
 * The test container. Shape taken verbatim from ship.js's setup-agent schema
 * (`:1651`) and read by its container-verify block (`:3754`). Undeclared here
 * until now, so a validated config lost it and the container path rested on a
 * key the validator removed.
 *
 * NOTE: `ProdSchema.rebuild` and `container.rebuildCommand` now coexist. They
 * are different things — `prod.rebuild` is the production rebuild a human
 * runs, `container.rebuildCommand` is interpolated into an AGENT PROMPT at
 * ship.js:3766. Declaring the key does not constrain its value: a consumer
 * must never put a command its own CLAUDE.md forbids (DDB: `make rebuild`)
 * behind this key.
 */
export const ContainerSchema = z.object({
  port: z.number().optional(),
  rebuildCommand: z.string().optional(),
  healthPath: z.string().optional(),
  hosts: z.array(z.string()).optional(),
});

export type ContainerConfig = z.infer<typeof ContainerSchema>;

export const ProdSchema = z.object({
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
});

export type ProjectHarness = z.infer<typeof ProjectHarnessSchema>;

export function parseProjectHarness(raw: unknown): ProjectHarness {
  return ProjectHarnessSchema.parse(raw);
}

export function safeParseProjectHarness(raw: unknown) {
  return ProjectHarnessSchema.safeParse(raw);
}
