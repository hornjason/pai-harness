/**
 * scaffold/defaults.ts — what a GREENFIELD scaffold writes into
 * `.claude/rungate/roles.json` and `.claude/rungate/hooks.json`.
 *
 * Both scaffold entry points (lib/scaffold/steps.ts and
 * scripts/scaffold-rungate-config.ts) used to hardcode `{}` and `[]` here.
 * A project scaffolded that way looks configured and is not: ship.js finds no
 * role to dispatch and no hook to deploy, and nothing says so out loud (#70).
 *
 * Roles are DERIVED from DEFAULT_AGENT_META rather than restated, so the role
 * set a project is scaffolded with and the role set brief generation falls back
 * to cannot drift apart. Only the two fields DEFAULT_AGENT_META has no opinion
 * about — the brief path and the standard task — are added here.
 *
 * The migration path (splitMonolithToDirectory) must NOT use any of this: an
 * existing project's roles and hooks are the answer, and injecting defaults
 * into a split would silently rewrite someone's config.
 */
import { DEFAULT_AGENT_META } from "../create-brief";

export interface HookRegistration {
  name: string;
  hookFor: string;
  command: string;
  enabled: boolean;
  matcher?: string;
  description: string;
  deployToConsumers?: boolean;
}

/**
 * Project-agnostic smoke task per role, used by `test-brief` and
 * `fresh-eyes-test` when no task is given. Deliberately phrased against things
 * every scaffolded project has (a test command, a source tree, a brief) rather
 * than against rungate's own files.
 */
const DEFAULT_STANDARD_TASKS: Record<string, string> = {
  discovery: "Read the issue, size the work, and write ACs with evidence commands",
  marcus: "Add config/test.json with {name: test} and write a unit test for it",
  quinn: "Validate the latest commit passes all tests and type checks, report AC evidence",
  rook: "Review the changed files for input validation, path traversal, and command injection",
  serena: "Review the largest source module and propose a decomposition into smaller modules",
  aditi: "Review the primary user-facing surface for layout, hierarchy, and accessibility",
};

function standardTaskFor(role: string, description: string): string {
  return DEFAULT_STANDARD_TASKS[role] ?? `Perform ${description.toLowerCase()} tasks as assigned`;
}

/**
 * The role map a greenfield `.claude/rungate/roles.json` is written with.
 *
 * Every entry satisfies RoleSchema (brief + standardTask required) and carries
 * the full agent meta, because buildAgentMeta fills a missing `tools`/`model`
 * with its own generic default — an entry that omits them would quietly
 * downgrade marcus from opus to sonnet on the next brief generation.
 */
export function buildDefaultRoles(): Record<string, Record<string, unknown>> {
  const roles: Record<string, Record<string, unknown>> = {};

  for (const [name, meta] of Object.entries(DEFAULT_AGENT_META)) {
    roles[name] = {
      brief: `.claude/agents/${name}.md`,
      ...(meta.isolation ? { isolation: meta.isolation } : {}),
      standardTask: standardTaskFor(name, meta.description),
      description: meta.description,
      tools: meta.tools,
      model: meta.model,
      ...(meta.tiers ? { tiers: meta.tiers } : {}),
      ...(meta.memory ? { memory: meta.memory } : {}),
      ...(meta.maxTurns ? { maxTurns: meta.maxTurns } : {}),
      ...(meta.effort ? { effort: meta.effort } : {}),
      ...(meta.disallowedTools ? { disallowedTools: meta.disallowedTools } : {}),
      ...(meta.omitClaudeMd ? { omitClaudeMd: meta.omitClaudeMd } : {}),
    };
  }

  return roles;
}

/**
 * Hook registrations a greenfield `.claude/rungate/hooks.json` is written with.
 *
 * Curated rather than "every file in hooks/": each entry below names a hook
 * implementation that ships with the harness AND is meaningful in a project
 * that has no specs, no issue tracker wiring and no gates configured yet.
 * Spec- and issue-coupled hooks (SpecSCGuard, IssueCloseGuard, MergeGuard, …)
 * are left for a project to opt into once it has the thing they guard.
 *
 * `${RUNGATE_HOOKS_DIR}` stays unexpanded on disk — deployHooksToConsumers
 * resolves it at deploy time, so the file survives the harness moving.
 */
export function buildDefaultHooks(): HookRegistration[] {
  return [
    {
      name: "BashToolGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/BashToolGuard.hook.ts",
      enabled: true,
      matcher: "Bash",
      description: "Blocks cat/head/tail file reading — agents must use the Read tool",
    },
    {
      name: "TestSuiteGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/TestSuiteGuard.hook.ts",
      enabled: true,
      matcher: "Bash",
      description: "Blocks a third full test suite run in one session — forces targeted tests",
    },
    {
      name: "AgentBriefGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/AgentBriefGuard.hook.ts",
      enabled: true,
      matcher: "Agent",
      description: "Validates agent brief templates and enforces the ship-active marker",
    },
    {
      name: "AgentVerdictCapture",
      hookFor: "SubagentStop",
      command: "bun ${RUNGATE_HOOKS_DIR}/AgentVerdictCapture.hook.ts",
      enabled: true,
      description: "Captures agent verdicts and writes them to workflow-state.json",
    },
    {
      name: "AutoVerifyGate",
      hookFor: "PostToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/AutoVerifyGate.hook.ts",
      enabled: true,
      matcher: "Agent",
      description: "Nudges the DA to run the verify gate after an agent completes",
    },
    {
      name: "CommitEnforcement",
      hookFor: "PostToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/CommitEnforcement.hook.ts",
      enabled: true,
      matcher: "Agent",
      description: "Detects uncommitted changes left behind in agent worktrees",
    },
    {
      name: "GateEnforcement",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/GateEnforcement.hook.ts",
      enabled: true,
      matcher: ".*",
      description: "Nags on gate failures and blocks Skill calls after max strikes",
    },
    {
      name: "PostCompact",
      hookFor: "PostCompact",
      command: "bun ${RUNGATE_HOOKS_DIR}/PostCompact.hook.ts",
      enabled: true,
      description: "Re-injects critical rules after context window compaction",
    },
    {
      name: "StaleTTLCleanup",
      hookFor: "SessionStart",
      command: "bun ${RUNGATE_HOOKS_DIR}/StaleTTLCleanup.hook.ts",
      enabled: true,
      description: "Cleans up stale workflow-state.json and ship-active files",
    },
  ];
}
