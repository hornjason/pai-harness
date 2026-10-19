/**
 * Every position in a tree that NAMES the project's test command, and the
 * comparison between them (#621, #626 category 1, relocated here by #637).
 *
 * ## Why this is a library module and not a section of a script
 *
 * It was written inside `test/test-command-agreement.test.ts` (#621), moved
 * into `scripts/contract-parity.ts` when the parity check came to need it
 * (#626), and moved HERE by #637 — because a script cannot be imported by a
 * script, and the moment a second consumer appears the only two options are an
 * importable module or a second copy. A second copy of the three extractors is
 * a producer and a consumer that must agree with nothing comparing them, which
 * is the exact defect this whole family of checks exists to find.
 *
 * `lib/` is the position that makes the question answerable in one place:
 * `test/test-command-agreement.test.ts`, `test/ci-global-tools.test.ts`,
 * `test/contract-parity.test.ts` and `scripts/contract-parity.ts` all import
 * these bindings from here, and there is one site to mutate.
 *
 * ## The decider this is NOT a second copy of
 *
 * `lib/test-command.ts`'s `testCommandDecision` answers "what command should
 * this project RUN", with a config rung, a `package.json` rung and a default.
 * This module answers "what command does each position in the tree SAY", which
 * is a different question with a different failure mode: the decision has to
 * produce an answer for every project, and this has to refuse when a position
 * says nothing.
 *
 * They are not two deciders that agree, and the input that proves it is a tree
 * with `test.command` set, no `dev.testCmd`, and a `package.json` `scripts.test`
 * naming something else: `testCommandsNamedByConfig` reports `test.command` and
 * `testCommandDecision` reports the package script. `commandParity` reads both
 * on purpose, and a disagreement between them is a finding rather than noise.
 *
 * ## Where `suiteJobName` lives, and why it is not here
 *
 * #735 made `lib/ci-checkout.ts`'s `suiteJobName` the one binding for "which
 * job in a generated `ci.yml` runs the suite" — `test` normally, `test-shard`
 * under a matrix, where `test` becomes an aggregate that runs nothing. It was
 * exported precisely so `scripts/contract-parity.ts` could ask rather than
 * carry a copy.
 *
 * The CI extractor moved here, so the IMPORT moved with it and
 * `scripts/contract-parity.ts` no longer names `suiteJobName` at all — its
 * only use there was inside the function below. That is the same arrangement
 * #735 asked for, one position further out: one declaration in
 * `lib/ci-checkout.ts`, one consumer here, nothing to disagree. Leaving the
 * import behind in the script would have been an unused specifier, not a
 * second reader, but it would also have been the first thing to tempt someone
 * into re-adding a local copy.
 *
 * ## Finding nothing in every file is perfect agreement
 *
 * Zero strings are trivially all equal, so every extractor here REFUSES when it
 * finds no command rather than returning `[]`, and the refusal is let out of
 * `testCommandAgreement` rather than folded into an empty violation list. A
 * template edit that moves a table row or renames a CI step must turn this red,
 * not quiet (`.claude/rules/checks-must-be-able-to-fail.md`, third shape).
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { suiteJobName } from "./ci-checkout";
import { RUNGATE_CONFIG_RELATIVE_PATH, resolveConfig } from "./config-loader";

/**
 * The three positions compared, as repo-relative paths.
 *
 * `CONFIG_JSON` is a LABEL, not a path: the config's location is asked of
 * `lib/config-loader.ts` (`rungateConfigPath` below), because this repository
 * supports two layouts indefinitely and a reader that knows only the directory
 * form silently gets nothing from a consumer on the monolith
 * (`.claude/rules/config-access.md`, and CONFIG-1 enforces it).
 */
export const AGENTS_MD = "AGENTS.md";
export const CONFIG_JSON = RUNGATE_CONFIG_RELATIVE_PATH;
export const CI_YML = join(".github", "workflows", "ci.yml");
export const AGREEMENT_FILES = [AGENTS_MD, CONFIG_JSON, CI_YML] as const;

/**
 * Where this project's rungate config actually is, or null when it has none.
 *
 * Through `resolveConfig`, so both layouts are honoured and a corrupt config
 * THROWS rather than arriving as an absent one — the distinction #70 lost for
 * a month, and the one #626 AC-4 keeps as two separate UNMEASURED kinds.
 */
export function rungateConfigPath(root: string): string | null {
  const resolution = resolveConfig(root);
  if (resolution.status === "absent") return null;
  return resolution.source === "directory" ? join(resolution.path, "config.json") : resolution.path;
}

/** One test command, and the position in the tree that names it. */
export interface NamedTestCommand {
  /** Repo-relative path. */
  file: string;
  /** Where inside the file — the row, the field, the step. */
  where: string;
  command: string;
}

/** Thrown when a file this check reads names no test command at all. */
export class NoTestCommandError extends Error {}

function refuse(file: string, why: string): never {
  throw new NoTestCommandError(
    `${file} names no test command: ${why}. ` +
      `Three files naming nothing are not three files that agree — ` +
      `see .claude/rules/checks-must-be-able-to-fail.md.`,
  );
}

/**
 * The `| Test | \`…\` |` row of AGENTS.md's Commands table.
 *
 * The cell must be exactly `Test`: `Test as CI sees it` is a different command
 * on purpose, and matching it here would make the check compare a row against
 * itself. The section is sliced out first — asserting against the whole
 * document is how a claim about one section gets satisfied by a match
 * somewhere else (#297, #484, #60).
 */
export function testCommandsNamedByAgentsMd(text: string): NamedTestCommand[] {
  const start = text.indexOf("\n## Commands");
  if (start === -1) refuse(AGENTS_MD, "it has no `## Commands` section");
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  if (section.trim() === "") refuse(AGENTS_MD, "its `## Commands` section is empty");

  const row = /^\|\s*Test\s*\|\s*`([^`]+)`\s*\|/m.exec(section);
  if (!row) refuse(AGENTS_MD, "its Commands table has no `| Test | \\`…\\` |` row");
  return [{ file: AGENTS_MD, where: "the Commands table's Test row", command: row![1].trim() }];
}

/**
 * The `**Test:** \`…\`` line of AGENTS.md's Workflow section.
 *
 * A second position in the same generated file, and the reason the slice above
 * matters: the two have always agreed here, so the live tree cannot witness a
 * reader that confuses them.
 */
export function testCommandNamedByAgentsWorkflow(text: string): NamedTestCommand[] {
  const line = /^\s*-?\s*\*\*Test:\*\*\s*`([^`]+)`/m.exec(text);
  return line ? [{ file: AGENTS_MD, where: "the Workflow section's Test line", command: line[1].trim() }] : [];
}

/**
 * Every test command the rungate config declares.
 *
 * Both fields, because both are read: `test.command` is what the ship run
 * measures with (`workflows/ship.js`, which cannot import — #69) and
 * `dev.testCmd` is the top rung of `lib/test-command.ts`, which is what the
 * scaffold writes into AGENTS.md and CI.
 */
export function testCommandsNamedByConfig(text: string): NamedTestCommand[] {
  // Deliberately not caught: a corrupt config is never a missing config
  // (.claude/rules/config-access.md).
  const config = JSON.parse(text) as { test?: { command?: unknown }; dev?: { testCmd?: unknown } };
  const found: NamedTestCommand[] = [];
  const declared = (where: string, value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") {
      found.push({ file: CONFIG_JSON, where, command: value.trim() });
    }
  };
  declared("test.command", config?.test?.command);
  declared("dev.testCmd", config?.dev?.testCmd);
  if (found.length === 0) refuse(CONFIG_JSON, "neither `test.command` nor `dev.testCmd` is set");
  return found;
}

/**
 * Steps that are part of running CI but are not the project's test command.
 * Named rather than positional: "the second run step" is a proxy, and a proxy
 * is a thing a template edit can satisfy while the property breaks.
 */
const NOT_THE_TEST_STEP = new Set(["bun install", "bun run typecheck"]);

/**
 * The shard selector is a CI PARTITION, not a different test command (#735).
 *
 * `bun test --shard=2/4` runs a quarter of the files of `bun test`; it does
 * not run them differently. The property #621 protects is that one command
 * is named everywhere, and appending a partition selector in CI does not
 * break it — but comparing the raw strings says it does, and the cheap fix
 * for that red is to add the sharded spelling to AGENTS.md, which would put
 * a CI-only flag in the row a human copies to run the suite locally.
 *
 * Stripped only at the END and only with a `N/M` argument, so a command that
 * genuinely differs before the flag still disagrees.
 *
 * `\S+` will not do for the numerator: the generated value is the GitHub
 * expression `${{ matrix.shard }}`, which contains spaces.
 */
const SHARD_SELECTOR = /\s+--shard=.+?\/\d+\s*$/;

/** The test step of the generated suite job in ci.yml. */
export function testCommandsNamedByCiWorkflow(text: string): NamedTestCommand[] {
  // `suiteJobName` is the one binding for "which job runs the suite" — it is
  // `test` normally and `test-shard` under a matrix, where `test` becomes the
  // aggregate and runs no tests at all. A second copy of that rule here would
  // survive any mutation of the first and both would read as covered.
  const anchor = `\n  ${suiteJobName(text)}:`;
  const start = text.indexOf(anchor);
  if (start === -1) refuse(CI_YML, "it has no `test:` job");
  const rest = text.slice(start + 1);
  // The next job at the same indent ends this one. Jobs a consumer added are
  // theirs (#216) and must not be read as this project's test command.
  const head = anchor.slice(1);
  const end = /\n {2}[A-Za-z_][\w-]*:/.exec(rest.slice(head.length));
  const job = end === null ? rest : rest.slice(0, head.length + end.index);
  if (job.trim() === "") refuse(CI_YML, "its `test:` job is empty");

  const runs = job
    .split("\n")
    .map(line => /^\s+- run:\s*(\S.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => m[1].trim())
    // `run: |` opens a block scalar; the body is not a command on this line.
    .filter(cmd => cmd !== "|" && !cmd.startsWith("|"))
    .filter(cmd => !NOT_THE_TEST_STEP.has(cmd))
    .map(cmd => cmd.replace(SHARD_SELECTOR, ""));

  if (runs.length === 0) {
    refuse(CI_YML, "its `test:` job runs nothing but setup and the type check");
  }
  return [{ file: CI_YML, where: "the test job's run step", command: runs[0] }];
}

const EXTRACTORS: Record<string, (text: string) => NamedTestCommand[]> = {
  [AGENTS_MD]: testCommandsNamedByAgentsMd,
  [CONFIG_JSON]: testCommandsNamedByConfig,
  [CI_YML]: testCommandsNamedByCiWorkflow,
};

export interface TestCommandAgreement {
  commands: NamedTestCommand[];
  /** Empty when every position names the same string. */
  violations: string[];
}

/**
 * The violation text, shared by the three-file binding and the category.
 *
 * Exported because `commandParity` compares SIX positions and this one
 * compares three — a second copy of the sentence would be a second decider
 * that agrees with this one on every input either has ever seen.
 */
export function commandDisagreement(commands: NamedTestCommand[]): string[] {
  const distinct = [...new Set(commands.map(c => c.command))];
  if (distinct.length <= 1) return [];
  return [
    `the test command is spelled ${distinct.length} different ways: ` +
      commands.map(c => `${c.file} (${c.where}) says \`${c.command}\``).join("; "),
  ];
}

/**
 * The three-file binding #621 shipped. Reads all three files, extracts what
 * each names, and reports a violation when the set of distinct strings is
 * larger than one.
 *
 * A missing file and a file that names nothing both THROW. Neither is a clean
 * reading, and both would otherwise arrive here as "no disagreement".
 */
export function testCommandAgreement(root: string): TestCommandAgreement {
  const commands: NamedTestCommand[] = [];
  for (const file of AGREEMENT_FILES) {
    const path = file === CONFIG_JSON ? rungateConfigPath(root) : join(root, file);
    if (path === null || !existsSync(path)) {
      throw new NoTestCommandError(`${file} does not exist under ${root}, so it names no test command`);
    }
    commands.push(...EXTRACTORS[file](readFileSync(path, "utf-8")));
  }
  return { commands, violations: commandDisagreement(commands) };
}
