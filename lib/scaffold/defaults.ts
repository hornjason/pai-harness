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
  /**
   * Which settings file is supposed to register this hook (#479).
   *
   * `user` — machine-wide, registered in `~/.claude/settings.json`, as
   * `HOOK-ARCHITECTURE-SPEC.md` SC-518 requires for anything that must fire in
   * sessions rooted outside the project. The repo cannot read that file, so
   * the reconciler reports these UNMEASURED and never counts them as checked.
   *
   * `project` — acts on the current project's own files or agents, registered
   * in the committed `.claude/settings.json`. Repo-owned, so "is it
   * registered" is a fact CI can check — which is the half #199 concluded was
   * impossible, having measured only the user-scoped eleven.
   *
   * Required, deliberately. An absent scope defaulting to `user` would excuse
   * every entry that forgot one, and that is how sixteen entries came to claim
   * `enabled: true` with five of them inert.
   */
  scope: "project" | "user";
  matcher?: string;
  description: string;
  /**
   * Whether a scaffolded consumer project receives this hook (#1047).
   *
   * Required, and for the same reason `scope` is. Before #1047 this was
   * optional and `deployHooksToConsumers` tested it with `!== true`, so
   * "decided no" and "nobody looked" were one value — `undefined` — and all
   * twenty entries held it. The deployment path built for SC-472 was wired
   * into three scaffold modules and reached zero hooks on every run that has
   * ever happened, and the run reported success, because zero deployed is
   * what a project wanting no hooks also looks like.
   *
   * An optional field cannot carry that decision: the next hook added would
   * default to `false` silently, which is the state this issue was filed
   * about. `test/hook-traceability.test.ts` AC-10 refuses an entry that omits
   * it, so the fourth position a new hook has to touch now has an answer that
   * someone wrote down.
   */
  deployToConsumers: boolean;
  /**
   * Why a `deployToConsumers: false` entry does not travel. Required when it
   * is false (#1047 AC-11), mirroring `disabledReason` below.
   *
   * Two different facts hide under `false`, and the reason is the only place
   * they are told apart: a hook about THIS repository's shared checkout,
   * worktree pool or swarm, which no consumer should ever receive; and a hook
   * coupled to something a consumer does not have yet — specs, an issue
   * tracker, a gate salt — which ships in the tarball and is registered once
   * the project has the thing it guards.
   */
  notDeployedReason?: string;
  /**
   * Why an `enabled: false` entry is off. Required when it is (#479 SC-1662).
   *
   * Off and never-registered look identical in a file; the difference is
   * whether anyone decided. Without the reason, the next person to read the
   * inventory cannot tell a considered no from an oversight, and the fastest
   * way to resolve that ambiguity is to flip it back on.
   */
  disabledReason?: string;
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
 *
 * Every entry carries a `scope` (#479). It is not decoration: it is the only
 * thing that tells a reconciler whether "not registered here" is a defect or
 * a fact about a file the repo does not own.
 */
export function buildDefaultHooks(): HookRegistration[] {
  return [
    {
      name: "BashToolGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/BashToolGuard.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: "Bash",
      description: "Blocks cat/head/tail file reading — agents must use the Read tool",
    },
    {
      name: "TestSuiteGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/TestSuiteGuard.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: "Bash",
      description: "Blocks a third full test suite run in one session — forces targeted tests",
    },
    {
      // Paired with TestSuiteGuard above, and added here by #1047 because the
      // pair is one mechanism. The guard takes a concurrency slot; this hands
      // it back when the suite exits. A greenfield project given the guard
      // alone gets every slot held for the full 420s TTL after a run that
      // finished in 190 — strictly worse than receiving neither, and the
      // classification pass that set `deployToConsumers` on the guard is what
      // made the one-sidedness visible.
      name: "TestSuiteRelease",
      hookFor: "PostToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/TestSuiteRelease.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: "Bash",
      description: "Hands a full suite its concurrency slot back when it finishes (#67)",
    },
    {
      name: "AgentBriefGuard",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/AgentBriefGuard.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "project",
      matcher: "Agent",
      description: "Validates agent brief templates and enforces the ship-active marker",
    },
    {
      name: "AgentVerdictCapture",
      hookFor: "SubagentStop",
      command: "bun ${RUNGATE_HOOKS_DIR}/AgentVerdictCapture.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      description: "Captures agent verdicts and writes them to workflow-state.json",
    },
    {
      name: "AutoVerifyGate",
      hookFor: "PostToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/AutoVerifyGate.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: "Agent",
      description: "Nudges the DA to run the verify gate after an agent completes",
    },
    {
      name: "CommitEnforcement",
      hookFor: "PostToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/CommitEnforcement.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: "Agent",
      description: "Detects uncommitted changes left behind in agent worktrees",
    },
    {
      name: "GateEnforcement",
      hookFor: "PreToolUse",
      command: "bun ${RUNGATE_HOOKS_DIR}/GateEnforcement.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      matcher: ".*",
      description: "Nags on gate failures and blocks Skill calls after max strikes",
    },
    {
      name: "PostCompact",
      hookFor: "PostCompact",
      command: "bun ${RUNGATE_HOOKS_DIR}/PostCompact.hook.ts",
      enabled: true,
      deployToConsumers: true,
      scope: "user",
      description: "Re-injects critical rules after context window compaction",
    },
    {
      // NOT deployed, and the description below is why the first pass got it
      // wrong: it says "stale workflow-state.json and ship-active files", and
      // the hook's first screen agrees. The branch deletion is sixty lines
      // down behind an `await import`. See `notDeployedReason` on this entry
      // in `.claude/rungate/hooks.json` for the full reading and for the two
      // things that would have to change before it could be reconsidered.
      //
      // Short form: at every SessionStart it runs
      // `cleanupStaleBranches({maxAgeDays: 7})`, which issues
      // `git push origin --delete` per stale branch, gated by an open-PR
      // check that `lib/branch-cleanup.ts` USED to default to the slug
      // `hornjason/pai-harness` — so on a consumer the guard asked about THIS
      // repository and could never say stop. A classification made by reading
      // a hook's header is not a classification; follow the dynamic imports.
      //
      // #1079 closed the slug half: the slug is resolved from the project's
      // own `origin` and an unresolvable one REFUSES the delete, and the arm
      // is disarmed unless `RUNGATE_BRANCH_CLEANUP=1`. That is necessary and
      // not sufficient — the worktree, scratch-dir and orphan-reaper arms of
      // this same hook have never been separately cleared for consumer use.
      name: "StaleTTLCleanup",
      hookFor: "SessionStart",
      command: "bun ${RUNGATE_HOOKS_DIR}/StaleTTLCleanup.hook.ts",
      enabled: true,
      deployToConsumers: false,
      notDeployedReason:
        "HARNESS-ONLY. Can delete remote branches at SessionStart via cleanupStaleBranches. " +
        "#1079 removed the slug default that made the open-PR guard ask about THIS repository " +
        "on a consumer, and disarmed the arm behind RUNGATE_BRANCH_CLEANUP — necessary, not " +
        "sufficient. Its worktree, scratch-dir and orphan-reaper arms have never been cleared " +
        "for consumer use and need their own reading. See the registry entry.",
      scope: "user",
      description: "Cleans up stale workflow-state.json and ship-active files",
    },
  ];
}
