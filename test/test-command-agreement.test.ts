/**
 * Covers AC-4a, AC-4b, AC-8a, AC-8b (#621).
 *
 * #621's smallest finding is the one that explains all the others: three
 * files in this tree name the project's test command, and on the day the
 * issue was filed they named three different things.
 *
 * | File | What it named |
 * |---|---|
 * | `AGENTS.md` Commands table | `bun test` |
 * | `.github/workflows/ci.yml` test job | `bun test` |
 * | `.claude/rungate/config.json` `test.command` | `bun test --parallel --no-isolate` |
 *
 * The third is the one the ship gate measures with, and `--parallel` is what
 * starved 122 I/O-bound tests past bun's per-test timeout. Nothing compared
 * the three, so the spelling the gate depended on appeared in no document any
 * human read.
 *
 * ## Why the extractors throw instead of returning nothing
 *
 * A check that reads three files and compares what it found is satisfied by
 * finding nothing in all three — zero strings are trivially all equal. That
 * is `.claude/rules/checks-must-be-able-to-fail.md`'s third shape, and it is
 * the way this particular check is most likely to die: the files are all
 * generated, so a template change moves a row or renames a step and the
 * regex quietly stops matching. So every extractor REFUSES when it finds no
 * command, and `testCommandAgreement` lets the refusal out rather than
 * folding it into an empty violation list.
 *
 * ## Why the slice
 *
 * Each extractor cuts the region it is about out of the file first and
 * refuses an empty cut — `AGENTS.md` carries a `**Test:** \`bun test\`` line
 * in its Workflow section and a `Test as CI sees it` row beside the one we
 * want, and `ci.yml` carries jobs this harness does not own. Asserting
 * against the whole document is how a claim about one section gets satisfied
 * by a match somewhere else (#297, #484, #60).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export const REPO_ROOT = join(import.meta.dir, "..");

/** The three files, by the repo-relative path each extractor is pointed at. */
export const AGENTS_MD = "AGENTS.md";
export const CONFIG_JSON = join(".claude", "rungate", "config.json");
export const CI_YML = join(".github", "workflows", "ci.yml");
export const AGREEMENT_FILES = [AGENTS_MD, CONFIG_JSON, CI_YML] as const;

/**
 * The root the agreement case reads. A spawned mutant points it at a planted
 * fixture; nothing else sets it.
 */
const AGREEMENT_ROOT = process.env.TEST_COMMAND_AGREEMENT_ROOT ?? REPO_ROOT;
const IS_MUTANT_RUN = process.env.TEST_COMMAND_AGREEMENT_ROOT !== undefined;

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
 * The cell must be exactly `Test`: `Test as CI sees it` is a different
 * command on purpose, and matching it here would make the check compare a
 * row against itself.
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
 * Every test command the rungate config declares.
 *
 * Both fields, because both are read: `test.command` is what the ship run
 * measures with (`workflows/ship.js`, which cannot import — #69) and
 * `dev.testCmd` is the top rung of `lib/test-command.ts`, which is what the
 * scaffold writes into AGENTS.md and CI. Two fields in one file naming two
 * commands is the same defect as two files doing it, so they are returned
 * separately and compared alongside everything else.
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
 * Named rather than positional: "the second run step" is a proxy, and a
 * proxy is a thing a template edit can satisfy while the property breaks.
 */
const NOT_THE_TEST_STEP = new Set(["bun install", "bun run typecheck"]);

/** The test step of the generated `test` job in ci.yml. */
export function testCommandsNamedByCiWorkflow(text: string): NamedTestCommand[] {
  const start = text.indexOf("\n  test:");
  if (start === -1) refuse(CI_YML, "it has no `test:` job");
  const rest = text.slice(start + 1);
  // The next job at the same indent ends this one. Jobs a consumer added are
  // theirs (#216) and must not be read as this project's test command.
  const end = /\n {2}[A-Za-z_][\w-]*:/.exec(rest.slice("  test:".length));
  const job = end === null ? rest : rest.slice(0, "  test:".length + end.index);
  if (job.trim() === "") refuse(CI_YML, "its `test:` job is empty");

  const runs = job
    .split("\n")
    .map(line => /^\s+- run:\s*(\S.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => m[1].trim())
    // `run: |` opens a block scalar; the body is not a command on this line.
    .filter(cmd => cmd !== "|" && !cmd.startsWith("|"))
    .filter(cmd => !NOT_THE_TEST_STEP.has(cmd));

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
 * The single binding. Reads all three files, extracts what each names, and
 * reports a violation when the set of distinct strings is larger than one.
 *
 * A missing file and a file that names nothing both THROW. Neither is a
 * clean reading, and both would otherwise arrive here as "no disagreement".
 */
export function testCommandAgreement(root: string): TestCommandAgreement {
  const commands: NamedTestCommand[] = [];
  for (const file of AGREEMENT_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      throw new NoTestCommandError(`${file} does not exist under ${root}, so it names no test command`);
    }
    commands.push(...EXTRACTORS[file](readFileSync(path, "utf-8")));
  }

  const distinct = [...new Set(commands.map(c => c.command))];
  const violations =
    distinct.length <= 1
      ? []
      : [
          `the test command is spelled ${distinct.length} different ways: ` +
            commands.map(c => `${c.file} (${c.where}) says \`${c.command}\``).join("; "),
        ];
  return { commands, violations };
}

// ── fixtures ────────────────────────────────────────────────────────────────

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the three real files, optionally with one of them rewritten. */
function plantedTree(edit?: (file: string, text: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), "test-cmd-agreement-621-"));
  scratch.push(root);
  for (const file of AGREEMENT_FILES) {
    const dest = join(root, file);
    mkdirSync(dirname(dest), { recursive: true });
    if (edit) writeFileSync(dest, edit(file, readFileSync(join(REPO_ROOT, file), "utf-8")));
    else copyFileSync(join(REPO_ROOT, file), dest);
  }
  return root;
}

/** Plant a command nothing else in the tree names, into the config. */
const DIVERGENT = "bun test --parallel";
function divergentConfig(file: string, text: string): string {
  if (file !== CONFIG_JSON) return text;
  const config = JSON.parse(text);
  config.test = { ...(config.test ?? {}), command: DIVERGENT };
  return JSON.stringify(config, null, 2);
}

/**
 * Run the agreement case by itself against a planted root.
 *
 * `ran` is not a formality: a `-t` filter that matches nothing leaves bun
 * reporting zero failures, which is indistinguishable from the check
 * passing, and is also what a run that failed to resolve its imports looks
 * like. Every assertion below goes through it first.
 */
function runAgreementCase(root: string): { ran: number; failed: number; output: string } {
  const r = spawnSync("bun", ["test", join("test", "test-command-agreement.test.ts"), "-t", "AC-4a"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, TEST_COMMAND_AGREEMENT_ROOT: root },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  const passed = count("pass");
  const failed = count("fail");
  return { ran: passed + failed, failed, output };
}

// ── the cases ───────────────────────────────────────────────────────────────

describe("#621: the test command is one string", () => {
  test("AC-4a: AGENTS.md, the rungate config and CI name one test command", () => {
    const { commands, violations } = testCommandAgreement(AGREEMENT_ROOT);

    // Coverage first: a verdict over an unread file is not a verdict (#492).
    for (const file of AGREEMENT_FILES) {
      expect(commands.filter(c => c.file === file).length, `nothing was extracted from ${file}`)
        .toBeGreaterThan(0);
    }
    expect(violations).toEqual([]);
  });

  test("AC-4b: a file that names no test command refuses instead of agreeing", () => {
    // AGENTS.md with the section but no Test row — the shape a template edit
    // produces, and the one that would otherwise read as agreement.
    expect(() => testCommandsNamedByAgentsMd("# x\n\n## Commands\n\n| Action | Command |\n|---|---|\n| Lint | `x` |\n"))
      .toThrow(NoTestCommandError);
    expect(() => testCommandsNamedByAgentsMd("# x\n\n## Workflow\n\n| Test | `bun test` |\n"))
      .toThrow(/no .## Commands. section/);

    // …and the row outside the section does not rescue it, which is what
    // makes the slice load-bearing rather than decoration.
    expect(() => testCommandsNamedByAgentsMd("# x\n\n## Commands\n\n(none)\n\n## Workflow\n\n| Test | `bun test` |\n"))
      .toThrow(NoTestCommandError);

    expect(() => testCommandsNamedByConfig(JSON.stringify({ project: "demo" }))).toThrow(NoTestCommandError);
    expect(() => testCommandsNamedByConfig(JSON.stringify({ test: { command: "  " } }))).toThrow(NoTestCommandError);
    // A corrupt config is never a missing config — it must not be swallowed
    // into "this file names nothing", which is a clean-looking reading.
    expect(() => testCommandsNamedByConfig("{ not json")).toThrow(SyntaxError);

    const ciNoTest = [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: bun install",
      "      - run: bun run typecheck",
      "",
    ].join("\n");
    expect(() => testCommandsNamedByCiWorkflow(ciNoTest)).toThrow(NoTestCommandError);
    expect(() => testCommandsNamedByCiWorkflow("jobs:\n  lint:\n    steps:\n      - run: bun test\n"))
      .toThrow(/no .test:. job/);

    // The whole point: the agreement function lets the refusal out. Folding
    // it into an empty violation list is how three files naming nothing
    // would report as three files that agree.
    const blank = plantedTree((file, text) => (file === CONFIG_JSON ? JSON.stringify({ project: "demo" }) : text));
    expect(() => testCommandAgreement(blank)).toThrow(NoTestCommandError);

    const missing = mkdtempSync(join(tmpdir(), "test-cmd-agreement-621-empty-"));
    scratch.push(missing);
    expect(() => testCommandAgreement(missing)).toThrow(NoTestCommandError);
  });

  test("AC-8a: a divergent command planted in a fixture copy is reported", () => {
    const planted = plantedTree(divergentConfig);
    const { commands, violations } = testCommandAgreement(planted);

    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(DIVERGENT);
    // The instrument: the planted string must be one no other position in
    // the tree names, or the divergence could be a coincidence of defaults.
    expect(commands.filter(c => c.command === DIVERGENT).map(c => c.file)).toEqual([CONFIG_JSON]);

    // …and the unmutated copy of the same three files is clean, so the red
    // above is the plant and not the copying.
    expect(testCommandAgreement(plantedTree()).violations).toEqual([]);
  });

  test.skipIf(IS_MUTANT_RUN)(
    "AC-8a/AC-8b: the agreement case itself goes red on the planted tree, run and counted",
    () => {
      // Asserting that `violations` is non-empty proves the function can
      // disagree. It does not prove the CASE fails — a case that computed a
      // verdict and never asserted on it would pass either way. So the case
      // is spawned against both trees and the colours are counted.
      const control = runAgreementCase(plantedTree());
      expect(control.ran, `the filter matched nothing:\n${control.output}`).toBe(1);
      expect(control.failed, `the unmutated copy was already red:\n${control.output}`).toBe(0);

      const mutant = runAgreementCase(plantedTree(divergentConfig));
      expect(mutant.ran, `the filter matched nothing:\n${mutant.output}`).toBe(1);
      expect(mutant.failed, `a planted divergence did not turn the case red:\n${mutant.output}`).toBe(1);
    },
    180000,
  );
});
