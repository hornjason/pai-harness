/**
 * What `rungate <command>` dispatches to (#363).
 *
 * Data, not a switch in the bin, because three separate things have to agree
 * and only one of them is code:
 *
 *   1. `bin/rungate.ts` can run the command
 *   2. `package.json`'s `files` ships the script it runs
 *   3. the AGENTS.md generator publishes the command to every consumer
 *
 * Before this existed they did not agree, and the disagreement was invisible
 * from every direction. `AGENTS.md` published `bunx rungate create-spec`;
 * `package.json` declared no `bin`, so the command could not run at all; and
 * `scripts/create-spec.ts` was not in `files`, so even a correct `bin` would
 * have shipped a dispatcher pointing at a script the consumer never received.
 * Three defects, each hiding behind the next.
 *
 * An agent reading `AGENTS.md` ran the command and it failed. An agent
 * reading `package.json` saw no `bin`, concluded rungate had no CLI and was
 * not distributable, and recommended hand-scaffolding a project. Both
 * readings of the repo were wrong, which is the state a single source fixes.
 *
 * ## A command script is run as an ENTRY MODULE, not imported
 *
 * This section used to read: "None of them guards on `import.meta.main`
 * … Adding an `import.meta.main` guard to any of them would silently turn its
 * subcommand into a no-op, so `test/cli-contract.test.ts` runs every command
 * for real." The hazard was named exactly. Both mitigations were false.
 *
 * Three scripts acquired the guard — and `import.meta.main` is FALSE for a
 * dynamically imported module, so `await import(script)` loaded them, ran
 * nothing, and exited 0. Measured on `3da782dc`, dispatcher against the same
 * script run directly, in bytes of output:
 *
 *   audit-specs          0  vs  2092     silent
 *   sync-spec-tests      0  vs  1254     silent
 *   extract-constraints  0  vs    57     silent
 *   ai-review-findings 270  vs   270     reached — see below
 *
 * Three of ten commands reported success having done nothing. The second
 * mitigation is why nobody saw it: `test/cli-contract.test.ts` ran ONE
 * command for real, `create-sc --list`, and its comment names this defect in
 * as many words. One member of the population was enough to hold the
 * assertion up while the other nine went unmeasured — the battery varied the
 * dispatcher and held the COMMAND fixed, and the defect was on that axis
 * (`.claude/rules/checks-must-be-able-to-fail.md`, seventh shape).
 *
 * `scripts/ai-review-findings.ts` is the one that still worked, and it is the
 * prior art rather than the exception: #675 hit this, documented the
 * mechanism in its docblock, and worked around it by calling `main`
 * unconditionally from a wrapper. That fixed one command and left the
 * dispatcher as it was.
 *
 * So the fix is here, in the one place that decides how a command is invoked,
 * rather than three more wrappers — a per-script workaround is three more
 * places to forget, and the forgetting reads as the command succeeding.
 * `runCommandScript` spawns the script with the running bun binary, which
 * makes it the entry module and `import.meta.main` true, exactly as
 * `bun scripts/audit-specs.ts` already was. A guard is now the normal thing
 * for a script to have, instead of a trap.
 */
import { spawnSync } from "child_process";

export interface CliCommand {
  /** The script this runs, relative to the package root. Must be in `files`. */
  script: string;
  /** One line for `rungate --help`. */
  summary: string;
  /** Shown under the summary; the form a consumer types. */
  usage: string;
  /**
   * The script defaults its project root to its OWN location, so the
   * dispatcher must pass `--project-root <cwd>` or the command writes into
   * the installed package.
   *
   * `scripts/create-spec.ts` ends with
   * `const root = projectRoot ?? join(import.meta.dir, "..")`, which is
   * correct for `bun scripts/create-spec.ts` inside this repo and wrong for
   * every consumer: `bunx rungate create-spec "Title"` would write
   * `node_modules/rungate/specs/TITLE-SPEC.md` and print `Created
   * specs/TITLE-SPEC.md`, so the command reports success and the consumer's
   * project is untouched. That is the #363 defect one layer in — the
   * documented interface existing and doing the wrong thing.
   *
   * Flagged per-command rather than passed to everything, because a script
   * that does not accept the flag would take it as a positional argument.
   */
  projectRootFlag?: true;
}

export const CLI_COMMANDS: Record<string, CliCommand> = {
  scaffold: {
    script: "scripts/scaffold-project.ts",
    summary: "Generate or refresh a project's agent files, rules and conformity suite",
    usage: "rungate scaffold <path> [--type code|workflow] [--fix] [--force] [--commit] [--no-auto-fix] [--prune-consumers]",
  },
  "create-spec": {
    script: "scripts/create-spec.ts",
    summary: "Create a spec file with the required frontmatter",
    usage: 'rungate create-spec "Title" ["what it governs"] [--sc "statement"]',
    projectRootFlag: true,
  },
  "create-success": {
    script: "scripts/create-success.ts",
    summary: "Seed SUCCESS.md — what this project is for, and the claims that prove it",
    usage: "rungate create-success [--owner <name>] [--force]",
    projectRootFlag: true,
  },
  "create-sc": {
    script: "scripts/create-sc.ts",
    summary: "Generate a matchable success-criterion line from a registered pattern",
    usage: "rungate create-sc --pattern <name> --params '<json>' [--spec <file>]",
  },
  "convert-spec": {
    script: "scripts/convert-spec.ts",
    summary: "Convert an existing document into a testable spec",
    usage: 'rungate convert-spec <file> [--dry-run] [--title "..."] [--governs "..."]',
    projectRootFlag: true,
  },
  "audit-specs": {
    script: "scripts/audit-specs.ts",
    summary: "Report which success criteria are matched, unmatched or uncovered",
    usage: "rungate audit-specs",
  },
  "sync-spec-tests": {
    script: "scripts/sync-spec-tests.ts",
    summary: "Regenerate the conformity suite from the specs",
    usage: "rungate sync-spec-tests",
  },
  "generate-code-map": {
    script: "scripts/generate-code-map.ts",
    summary: "Regenerate CODE-MAP.md from the source tree",
    usage: "rungate generate-code-map",
  },
  "extract-constraints": {
    script: "scripts/extract-constraints.ts",
    summary: "Extract constraints from a project's docs into agent rules",
    usage: "rungate extract-constraints",
  },
  // Registered so the GENERATED ai-review workflow has something to run. The
  // reader has existed and been tested since #631 and nothing executed it:
  // `lib/scaffold/ai-review-step.ts` emitted a warning saying so by name,
  // because a scaffolded consumer has no copy of rungate's sources at a path
  // the workflow could hardcode. This registry is the path (#675).
  //
  // No `projectRootFlag`: the argument is the findings payload, which lives
  // outside the checkout by design (`RUNNER_TEMP`), and appending
  // `--project-root <cwd>` would arrive as a second positional and be read as
  // a second payload.
  "ai-review-findings": {
    script: "scripts/ai-review-findings.ts",
    summary: "Adjudicate an AI review's findings payload — exits non-zero on a blocking finding",
    usage: "rungate ai-review-findings <path-to-findings.json>",
  },
};

/** The commands the AGENTS.md generator may publish to a consumer. */
export function publishedCommands(): string[] {
  return Object.keys(CLI_COMMANDS);
}

/** What a dispatched command returned, and what it wrote when captured. */
export interface CommandRun {
  /** The code to exit with. Never `null` — a killed or unspawnable child is non-zero. */
  code: number;
  /** Present only when `capture` was asked for. */
  stdout?: string;
  stderr?: string;
}

/**
 * Run a command's script AS AN ENTRY MODULE, and return the code to exit with.
 *
 * THE single binding for how a subcommand is invoked. The dispatcher calls
 * nothing else, so there is one place to mutate and a test can watch the
 * invocation stop being an entry-module run — see the docblock at the top of
 * this file for the three commands that were silently no-ops when this was
 * `await import(script)`.
 *
 * `process.execPath` rather than the string `"bun"`: the child must be the
 * same runtime the parent is already running under, and a consumer's PATH is
 * not ours to assume.
 *
 * ## Every way this can fail to run is non-zero
 *
 * `spawnSync` reports `status: null` for a child that never produced an exit
 * code — killed by a signal, or never spawned at all. Mapping that to 0 would
 * reinstate the defect this function exists to remove, one layer out: a
 * command that did not run, reporting success.
 *
 * ONE `??`, not a `signal` branch beside it. The first version had both, and
 * the separate branch made `?? 1` unreachable — no input could distinguish it
 * from `?? 0`, so the case asserting "a script that cannot run is a failure"
 * passed under that mutation. It was green because a missing script makes
 * *bun* exit non-zero, which is a real status the `??` never sees
 * (`.claude/rules/checks-must-be-able-to-fail.md`, third shape: an assertion
 * holding for a reason that is not the one claimed). Collapsed to one path,
 * a SIGKILLed child reaches it and the mutation is caught.
 */
export function runCommandScript(
  script: string,
  args: string[],
  opts?: { capture?: boolean },
): CommandRun {
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: opts?.capture ? "pipe" : "inherit",
    encoding: "utf-8",
  });
  const captured = opts?.capture ? { stdout: r.stdout ?? "", stderr: r.stderr ?? "" } : {};
  // A spawn error is not a verdict the script reached. Say so on stderr —
  // under `stdio: "inherit"` the child wrote nothing and a bare exit code
  // would be the silent failure again, one layer out.
  if (r.error) {
    const why = `rungate: could not run ${script}: ${r.error.message}`;
    if (!opts?.capture) console.error(why);
    return { code: 1, ...captured, ...(opts?.capture ? { stderr: why } : {}) };
  }
  return { code: r.status ?? 1, ...captured };
}

export function helpText(): string {
  const rows = Object.entries(CLI_COMMANDS).map(
    ([name, c]) => `  ${name.padEnd(20)}${c.summary}\n  ${" ".repeat(20)}${c.usage}`,
  );
  return [
    "rungate — ship harness: conformity tests, scaffold, and agent briefs",
    "",
    "Usage: rungate <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Run a command with no arguments for its own usage where it has one.",
  ].join("\n");
}

/**
 * Every `bunx <pkg> <cmd>` invocation in a markdown command table.
 *
 * Used in both directions by `test/cli-contract.test.ts`: a published command
 * must dispatch, and a dispatching command's script must be shipped. Written
 * to find the invocation ANYWHERE in the text rather than only in a table
 * row, because a documented-but-broken command is just as broken in a prose
 * sentence as in a table.
 */
export function bunxInvocations(markdown: string, pkg: string): string[] {
  const pattern = new RegExp(String.raw`\bbunx\s+${pkg}\s+([a-z][a-z0-9-]*)`, "g");
  return [...new Set([...markdown.matchAll(pattern)].map(m => m[1]))];
}
