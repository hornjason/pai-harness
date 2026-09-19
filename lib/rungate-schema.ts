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

const TestSchema = z.object({
  start: z.string().optional(),
  apiBase: z.string().url().optional(),
  note: z.string().optional(),
});

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

const ProjectHarnessSchema = z.object({
  project: z.string(),
  repo: z.string(),
  issueRepo: z.string(),
  dev: DevSchema.optional(),
  test: TestSchema.optional(),
  prod: ProdSchema.optional(),
  pages: z.record(z.string()).optional(),
  codeCommittedPaths: z.array(z.string()).optional(),
  consumers: z.array(z.string()).optional(),
  contextDocs: z.record(z.string().nullable()).optional(),
  mcp: z.array(McpServerSchema).optional(),
  research: z.array(ResearchToolSchema).optional(),
  schemaVersion: z.number().default(1),
});

export type ProjectHarness = z.infer<typeof ProjectHarnessSchema>;

export function parseProjectHarness(raw: unknown): ProjectHarness {
  return ProjectHarnessSchema.parse(raw);
}

export function safeParseProjectHarness(raw: unknown) {
  return ProjectHarnessSchema.safeParse(raw);
}
