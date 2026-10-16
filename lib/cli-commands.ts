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
 * ## The scripts execute on import
 *
 * None of them guards on `import.meta.main`; each reads `process.argv` at the
 * top level. That is why the dispatcher uses a dynamic `import()` and rewrites
 * `process.argv` first — the import IS the invocation. Adding an
 * `import.meta.main` guard to any of them would silently turn its subcommand
 * into a no-op, so `test/cli-contract.test.ts` runs every command for real.
 */

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
    usage: "rungate scaffold <path> [--type code|workflow] [--fix] [--force] [--commit]",
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
};

/** The commands the AGENTS.md generator may publish to a consumer. */
export function publishedCommands(): string[] {
  return Object.keys(CLI_COMMANDS);
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
