import { z } from "zod";

export const DevSchema = z.object({
  start: z.string(),
  apiBase: z.string().url(),
  uiBase: z.string().url(),
  preStart: z.string().optional(),
  testCmd: z.string().optional(),
  typeCheck: z.string().optional(),
  note: z.string().optional(),
  /**
   * The path the dev-server liveness probe requests, relative to `apiBase`.
   *
   * #304. `checkDevServerLiveness` used to curl a literal
   * `${apiBase}/api/admin/health` — one consumer's route written into
   * the harness. It worked for exactly one consumer by coincidence, and the
   * first consumer with a different health route would be told its running
   * server was DOWN and to start it. `container.healthPath` was already a
   * declared concept; `dev` had no equivalent, so this is it.
   *
   * No default. A probe that guesses a path reports DOWN for a server that is
   * up, and "could not check" must never become "it is down".
   *
   * **Nullable as well as optional (#346.)** The scaffold detects a health
   * route rather than defaulting one, and writes `null` when it looked and
   * found nothing. Absent and null are different facts — "nobody configured
   * this" versus "we scanned the conventional entry points and there is no
   * health endpoint there" — and collapsing them loses exactly the
   * distinction the liveness record exists to carry. `probeTarget` treats
   * both as UNMEASURED, which is correct for both.
   */
  healthPath: z.string().nullable().optional(),
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
  /** See `DevSchema.healthPath` — the prove gate probes this tier too (#304). */
  healthPath: z.string().nullable().optional(),
  /**
   * The promoted container `container-has-fix` inspects, and which runtime to
   * ask (#341).
   *
   * All three were read by `gates/workflow.test.ts` and declared by none of
   * them. That check loads `rungate.json` with a bare `JSON.parse`, so they
   * reached it — but a key no schema mentions is a key nothing validates, and
   * `ProdSchema` is not `passthrough()`, so any caller that *does* go through
   * zod silently drops them.
   *
   * `containerRuntime` is new. The old code chose by probe —
   * `podman` if present, otherwise `docker` whether docker existed or not —
   * and with neither installed the inspect failed and the check passed. Config
   * first, probe as a fallback, and "neither" is now its own outcome.
   */
  containerName: z.string().optional(),
  imageName: z.string().optional(),
  containerRuntime: z.string().optional(),
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
  /**
   * Commands an agent must never run in this project (#343).
   *
   * `lib/transcript-checker.ts` used to hardcode `make rebuild` — one
   * consumer's rule — so for every other consumer the forbidden-command
   * directive fell through to N/A, which `computeScore` drops from its
   * denominator. The rule went unenforced and the score did not move.
   *
   * No default. A guessed prohibition is worse than none: agent briefs quote
   * it, agents obey it, and nobody finds out it was invented.
   */
  forbiddenCommands: z.array(z.string()).optional(),
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
