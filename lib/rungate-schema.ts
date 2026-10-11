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
 * `command` and `timeout` were read by `workflows/ship.js` (its inline setup
 * schema declares both at :1651) and written by rungate's own
 * `.claude/rungate.json`, but were undeclared here — so every validated read
 * stripped them and the validated path was lossier than the raw one (ADR-002
 * D3, consequence 2). They are the authored rungate shape; `dev.testCmd` is
 * the authored DDB shape, and `lib/config-loader.ts` normalises the two.
 */
const TestSchema = z.object({
  start: z.string().optional(),
  apiBase: z.string().url().optional(),
  note: z.string().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
});

/**
 * The test-container block `workflows/ship.js:3753` reads. ship.js has
 * declared this shape in its own inline setup schema since :1651; declaring it
 * here is what stops zod deleting the key before it reaches the conditional.
 *
 * NOTE — `rebuildCommand` is interpolated VERBATIM into an agent prompt at
 * `ship.js:3766` (`cd ${PROJECT_ROOT} && ${rebuildCmd}`). Declaring the field
 * constrains its type, not its value: a config handing `make rebuild` to an
 * agent still validates. DDB's CLAUDE.md forbids that and its Makefile carries
 * a worktree guard, so the forbidden-command rule stays a config review
 * concern — ADR-002 Step 1 does not refine it, and PROJECT-STATE item 8 is the
 * standing instruction.
 *
 * NOTE — `ProdSchema.rebuild` already exists and is a different thing: prod
 * promotion, not the test container. The two rebuild-ish keys coexist
 * deliberately. `prod.rebuild` is DDB's `make rebuild`; `container.
 * rebuildCommand` is the 7776 build/test-down/test-up sequence.
 */
const ContainerSchema = z.object({
  port: z.number().optional(),
  rebuildCommand: z.string().optional(),
  healthPath: z.string().optional(),
  hosts: z.array(z.string()).optional(),
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

const ProjectHarnessSchema = z.object({
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

// ── Compliance policy (was hand-declared in lib/config-loader.ts) ──────────

const ComplianceRuleSchema = z.object({
  description: z.string(),
  directives: z.array(z.string()),
  reinforcement: z.string(),
  tiers: z.record(z.object({ action: z.string(), hook: z.string().optional() })),
  threshold: z.object({ consecutive: z.number(), promote: z.number() }),
});

const OrganizeExternalSourceSchema = z.object({
  path: z.string(),
  type: z.string(),
  target: z.string().nullable(),
  method: z.enum(["symlink", "copy", "discover"]),
  matchBy: z.string(),
});

export const ComplianceConfigSchema = z.object({
  rules: z.record(ComplianceRuleSchema),
  defaults: z.object({
    consecutiveFailThreshold: z.number(),
    tierPromotionThreshold: z.number(),
  }),
  organize: z.object({
    fileTypes: z.array(z.string()),
    artifactClassification: z.record(z.string()),
    externalSources: z.array(OrganizeExternalSourceSchema),
  }),
});

export type ComplianceRule = z.infer<typeof ComplianceRuleSchema>;
export type OrganizeExternalSource = z.infer<typeof OrganizeExternalSourceSchema>;
export type ComplianceConfig = z.infer<typeof ComplianceConfigSchema>;

// ── The resolved shape the loader emits (ADR-002 D3) ───────────────────────

/**
 * `timeout` is required here and optional in `TestSchema` because the loader
 * always supplies `DEFAULT_TEST_TIMEOUT`. `command` stays optional: a project
 * with no test command configured must be distinguishable from one configured
 * with `""`, which is what `|| 'bun test'` could never express.
 */
const ResolvedTestSchema = TestSchema.extend({ timeout: z.number() });

/**
 * ADR-002 D3. `ResolvedConfig` is the single config type, derived here with
 * `z.infer` rather than hand-declared a second time in `config-loader.ts`.
 * The contradiction that motivated it: `RungateConfig.test.command` was
 * REQUIRED at `config-loader.ts:44` and absent from `TestSchema` — two
 * hand-written types for one file, disagreeing.
 *
 * `hooks`, `compliance` and `remoteHosts` are not part of the authored
 * harness schema (`hooks.json` and `compliance.json` are separate files under
 * the directory layout) but they are part of what the loader merges and
 * returns, so they are declared on the resolved shape and nowhere else.
 */
export const ResolvedConfigSchema = ProjectHarnessSchema.extend({
  apiUrl: z.string().optional(),
  uiUrl: z.string().optional(),
  test: ResolvedTestSchema,
  // `roles` and `hooks` are always present on a resolved config, empty when
  // unconfigured. Optional here would be a fifth falsy value for callers to
  // absorb, which is the defect class ADR-002 D2(a) is about.
  roles: z.record(RoleSchema),
  hooks: z.array(z.unknown()),
  compliance: ComplianceConfigSchema.optional(),
  remoteHosts: z.record(z.unknown()).optional(),
});

export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

export function parseProjectHarness(raw: unknown): ProjectHarness {
  return ProjectHarnessSchema.parse(raw);
}

export function safeParseProjectHarness(raw: unknown) {
  return ProjectHarnessSchema.safeParse(raw);
}
