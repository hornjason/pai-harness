#!/usr/bin/env bun
/**
 * One mechanical comparison over the class of defect this harness keeps
 * shipping: **a producer and a consumer that must agree, with nothing
 * comparing them** (#626).
 *
 * Twelve defects in one session were that shape. Each was detectable in
 * seconds by reading two files; each cost between a ten-minute hand re-measure
 * and a seventy-minute run. The table is on the issue; the six categories
 * below are drawn from it rather than invented:
 *
 * | Category | The producer | The consumer | The row it comes from |
 * |---|---|---|---|
 * | `command-parity` | `.claude/rungate/config.json` | `AGENTS.md`, `ci.yml`, the scaffold | #621 |
 * | `toolchain-parity` | `.bun-version` / `ci.bunVersion` | every workflow's `setup-bun`, the running runtime | #622, #622b, #622c |
 * | `transport-parity` | the evidence-command transport | `workflows/ship.js`'s inlined copy and its call sites | #614, #600 |
 * | `probe-honesty` | an external tool's absence | a check reading one boolean | #597 |
 * | `field-reachability` | whatever writes the shared state | every gate that reads it | #530, #611 |
 * | `write-accountability` | code that writes a tracked file | git, and the managed-file table | #624 |
 *
 * ## Three properties, and none of them is the verdict
 *
 * **1. A comparison that could not be performed is UNMEASURED, never PASS.**
 * A check that reads N positions and compares what it found is satisfied by
 * finding nothing in all N — zero strings are trivially all equal. That is the
 * third shape in `.claude/rules/checks-must-be-able-to-fail.md` and the way
 * this check is most likely to die, because most of what it reads is
 * generated: a template edit moves a table row, a regex stops matching, and
 * the category goes quiet rather than red. So every unreadable position is
 * recorded, with WHICH of the three ways it was unreadable — an absent file,
 * an unparseable one, and a declared source that cannot be resolved stay three
 * things. `.claude/rules/config-access.md`: a corrupt config is never a
 * missing config.
 *
 * **2. Every verdict carries its own coverage.** `36/426` and `426/426` are
 * the same PASS today and no reader can tell them apart from the output —
 * that is #492, recorded in the rules file as the reporting fix a scan owes
 * its reader. Each category here reports sites examined over sites visible,
 * so a category that quietly stopped reading four of its six positions says so
 * while still passing.
 *
 * **3. The check is against the contract, not against an artefact.** #530 is
 * the worked example: a permissive store answers yes to every question of the
 * form "is this here", because you put it there. `field-reachability` walks
 * the Zod shape rather than the JSON, and `toolchain-parity` reads what the
 * generator would EMIT rather than only the checked-in copies — which is
 * #622c, where a fix that edited only the committed workflows would have left
 * every scaffolded consumer unpinned.
 *
 * ## What this is not
 *
 * Not a preflight. Two unrelated things in this repository already wear that
 * name — `preflightResults` in `workflows/ship.js` is SSH host reachability,
 * and `lib/release-preflight.ts` is npm release verification — and a third
 * meaning would be its own parity defect.
 *
 * ## Usage
 *
 *   bun scripts/contract-parity.ts [--root <dir>] [--category <name>] [--json]
 *
 * Exits `REFUSE_EXIT` when any category reports a violation or could not be
 * measured. UNMEASURED is not a pass: `0`, `{}`, `null` and silence are all
 * indistinguishable from success, which is the whole subject of this file.
 *
 * ## Where the comparisons live
 *
 * `testCommandAgreement` and the state-contract walk were written as part of
 * `test/test-command-agreement.test.ts` (#621) and `test/state-contract.test.ts`
 * (#317). They are HERE now and those two files import them, so there is one
 * binding per comparison rather than one in a test and a second one in this
 * script — which would be this issue's own defect, committed by the thing
 * built to detect it.
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  BUN_VERSION_FILE,
  bunVersionDeclarations,
  bunVersionReading,
  bunVersionSourceLabel,
  declaredBunVersion,
  isPinnedBunVersion,
  setupBunWith,
} from "../lib/bun-version";
import { acPayloadReadExpression, acPayloadShellArgument } from "../lib/evidence-command-transport";
import { shellSingleQuote } from "../lib/phase2-decomposition";
import { RUNGATE_CONFIG_RELATIVE_PATH, resolveConfig } from "../lib/config-loader";
import { testCommandDecision } from "../lib/test-command";
import { TOOL_PROBE_OUTCOMES, probeExternalTool, type ToolProbeOutcome } from "../lib/tool-probe";

/**
 * The one exit code every refusal travels through, declared exactly once, so a
 * test can build a mutant copy with it set to 0 and watch a refusal stop
 * refusing — `.claude/rules/checks-must-be-able-to-fail.md`, "For a script
 * whose job is to exit non-zero". Do not inline a literal non-zero exit
 * anywhere below. (The mutant battery itself is #637.)
 */
export const REFUSE_EXIT = 1;

export const REPO_ROOT = join(import.meta.dir, "..");

// ── the shape of a reading ──────────────────────────────────────────────────

export type ParityVerdict = "PASS" | "FAIL" | "UNMEASURED";

/**
 * The three ways a comparison fails to happen. They stay three, because a
 * corrupt config is never a missing config and neither of those is a source
 * that exists, is readable, and points somewhere that is not there.
 */
export const UNMEASURED_KINDS = ["absent-file", "unparseable-file", "unresolved-source"] as const;
export type UnmeasuredKind = (typeof UNMEASURED_KINDS)[number];

export interface Unmeasurable {
  kind: UnmeasuredKind;
  /** The position that could not be read, named so a reader can go and look. */
  site: string;
  reason: string;
  /** Whether this absence is what stops the category reaching a verdict. */
  blocking: boolean;
}

/** One position that was read, and what it said. */
export interface ParitySite {
  site: string;
  value: string;
}

export interface Coverage {
  examined: number;
  visible: number;
  /** Rendered, so two readings cannot look identical in the output (#492). */
  reading: string;
}

export interface CategoryReport {
  category: string;
  title: string;
  verdict: ParityVerdict;
  coverage: Coverage;
  sites: ParitySite[];
  violations: string[];
  unmeasured: Unmeasurable[];
  /** Banked known gaps, with their issue. Present only where a ratchet applies. */
  known?: string[];
}

export interface ContractParityReport {
  root: string;
  verdict: ParityVerdict;
  categories: CategoryReport[];
}

export const PARITY_CATEGORIES = [
  "command-parity",
  "toolchain-parity",
  "transport-parity",
  "probe-honesty",
  "field-reachability",
  "write-accountability",
] as const;
export type ParityCategory = (typeof PARITY_CATEGORIES)[number];

/**
 * Assemble a category reading.
 *
 * `visible` is passed in rather than derived from `sites.length`, and that is
 * the whole of property 2: a category that read two of its six positions must
 * report six, or the coverage number is the examined count wearing a fraction.
 */
function categoryReport(
  category: ParityCategory,
  title: string,
  parts: {
    visible: number;
    sites: ParitySite[];
    violations: string[];
    unmeasured: Unmeasurable[];
    known?: string[];
  },
): CategoryReport {
  const examined = parts.sites.length;
  const unmeasured = [...parts.unmeasured];
  // "Nothing was examined" is recorded as a blocking absence rather than
  // asked as a second question beside the first. Two deciders answering
  // "may this report PASS" are behaviourally one, and a mutation of either
  // leaves the other holding every case up — the fourth shape in
  // `.claude/rules/checks-must-be-able-to-fail.md`, measured here: zeroing
  // the `blocking` reading left the empty-reading case green on its own.
  if (examined === 0 && !unmeasured.some(u => u.blocking)) {
    unmeasured.push(
      unmeasurable("unresolved-source", category, `${category} examined none of the ${parts.visible} positions it can see`),
    );
  }
  const blocked = unmeasured.some(u => u.blocking);
  const verdict: ParityVerdict = parts.violations.length > 0 ? "FAIL" : blocked ? "UNMEASURED" : "PASS";
  const visible = Math.max(parts.visible, examined);
  return {
    category,
    title,
    verdict,
    coverage: { examined, visible, reading: `${examined}/${visible}` },
    sites: parts.sites,
    violations: parts.violations,
    unmeasured,
    ...(parts.known ? { known: parts.known } : {}),
  };
}

function unmeasurable(kind: UnmeasuredKind, site: string, reason: string, blocking = true): Unmeasurable {
  return { kind, site, reason, blocking };
}

/** The first line of whatever an unknown throw turns out to be. */
function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0];
}

// ── category 1: command parity ──────────────────────────────────────────────
//
// The extractors and `testCommandAgreement` below are #621's, moved here from
// test/test-command-agreement.test.ts so that the test and this script compare
// the same way. They refuse rather than returning nothing, because three files
// naming nothing are not three files that agree.

/**
 * The three files, by the name each extractor is pointed at.
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
 * a month, and the one AC-4 keeps as two separate UNMEASURED kinds.
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

/** The violation text, shared by the three-file binding and the category. */
function disagreement(commands: NamedTestCommand[]): string[] {
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
  return { commands, violations: disagreement(commands) };
}

/**
 * Category 1, which is `testCommandAgreement` plus the two positions a
 * three-file comparison cannot see: AGENTS.md's Workflow line, and the command
 * the SCAFFOLD would generate.
 *
 * The generator is in here because of #622c: the declaration this repository
 * ships to consumers is emitted by code, so a parity check reading only the
 * checked-in copies passes while every scaffolded project disagrees with it.
 */
export function commandParity(root: string): CategoryReport {
  const sites: ParitySite[] = [];
  const unmeasured: Unmeasurable[] = [];
  const commands: NamedTestCommand[] = [];
  const record = (found: NamedTestCommand[]) => {
    for (const c of found) {
      commands.push(c);
      sites.push({ site: `${c.file} — ${c.where}`, value: c.command });
    }
  };

  // AGENTS.md: the Commands row (required) and the Workflow line (optional).
  const agentsPath = join(root, AGENTS_MD);
  if (!existsSync(agentsPath)) {
    unmeasured.push(unmeasurable("absent-file", AGENTS_MD, `${AGENTS_MD} does not exist under ${root}`));
  } else {
    const text = readFileSync(agentsPath, "utf-8");
    try {
      record(testCommandsNamedByAgentsMd(text));
    } catch (e) {
      unmeasured.push(unmeasurable("unresolved-source", `${AGENTS_MD} — Commands table`, firstLine(e)));
    }
    const workflow = testCommandNamedByAgentsWorkflow(text);
    if (workflow.length > 0) record(workflow);
  }

  // The rungate config: both declared fields, and the two ways it can fail to
  // be read, which must not collapse into each other. The location comes from
  // the loader; the BYTES are then read directly, because the loader
  // normalises `dev.testCmd` over `test.command` and the question here is
  // which positions declare what, not which one wins.
  let configPath: string | null = null;
  let configAbsent = false;
  let configReadable = false;
  try {
    configPath = rungateConfigPath(root);
    configAbsent = configPath === null;
  } catch (e) {
    unmeasured.push(unmeasurable("unparseable-file", CONFIG_JSON, firstLine(e)));
  }
  if (configAbsent) {
    unmeasured.push(unmeasurable("absent-file", CONFIG_JSON, `${CONFIG_JSON} does not exist under ${root}`));
  } else if (configPath !== null) {
    try {
      record(testCommandsNamedByConfig(readFileSync(configPath, "utf-8")));
      configReadable = true;
    } catch (e) {
      const kind: UnmeasuredKind = e instanceof NoTestCommandError ? "unresolved-source" : "unparseable-file";
      unmeasured.push(unmeasurable(kind, CONFIG_JSON, firstLine(e)));
    }
  }

  // CI, which is the only position in the list a machine obeys.
  const ciPath = join(root, CI_YML);
  if (!existsSync(ciPath)) {
    unmeasured.push(unmeasurable("absent-file", CI_YML, `${CI_YML} does not exist under ${root}`));
  } else {
    try {
      record(testCommandsNamedByCiWorkflow(readFileSync(ciPath, "utf-8")));
    } catch (e) {
      unmeasured.push(unmeasurable("unresolved-source", `${CI_YML} — the test job`, firstLine(e)));
    }
  }

  // The generator. A built-in default is not a declaration — substituting one
  // silently is the anti-pattern `.claude/rules/config-access.md` names — so
  // it is reported as a position that said nothing rather than as agreement.
  if (configReadable || configAbsent) {
    try {
      const decision = testCommandDecision(root);
      if (decision.source === "default") {
        unmeasured.push(
          unmeasurable(
            "unresolved-source",
            "lib/test-command.ts — the command the scaffold would generate",
            `the generator falls back to the built-in default (${decision.reason}), which is not a declaration`,
            false,
          ),
        );
      } else {
        commands.push({ file: "lib/test-command.ts", where: `the generated command (${decision.source})`, command: decision.command });
        sites.push({ site: "lib/test-command.ts — the command the scaffold would generate", value: decision.command });
      }
    } catch (e) {
      unmeasured.push(
        unmeasurable("unparseable-file", "lib/test-command.ts", `the generator could not resolve a command: ${firstLine(e)}`),
      );
    }
  }

  return categoryReport("command-parity", "every position naming the project's test command names one string", {
    // Six: two in AGENTS.md, two in the config, the CI step, and the generator.
    visible: 6,
    sites,
    violations: disagreement(commands),
    unmeasured,
  });
}

// ── category 2: toolchain parity ────────────────────────────────────────────

/** Every `.github/workflows/*.yml`, sorted, or an empty list when there are none. */
function workflowFiles(root: string): string[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map(f => join(".github", "workflows", f));
}

/** What a `setup-bun` step's `with:` block names, one entry per step. */
export function setupBunDeclarations(text: string): Array<{ key: "bun-version" | "bun-version-file"; value: string }> {
  const out: Array<{ key: "bun-version" | "bun-version-file"; value: string }> = [];
  for (const m of text.matchAll(/^\s*(bun-version|bun-version-file):\s*"?([^"\s#]+)"?\s*$/gm)) {
    out.push({ key: m[1] as "bun-version" | "bun-version-file", value: m[2] });
  }
  return out;
}

/**
 * Category 2. The runtime a job installs, everywhere it is named — including
 * the position a reviewer cannot see, which is what the SCAFFOLD emits.
 *
 * #622 is the whole table: `ci.yml` and `gates.yml` said `latest`, `release.yml`
 * said `1.3.14`, the development machine ran `1.3.14`, and CI's `latest`
 * resolved to `1.4.3`. The published artifact was built on a runtime CI never
 * tested, and nothing compared any of the four.
 */
export function toolchainParity(root: string, running: string = Bun.version): CategoryReport {
  const sites: ParitySite[] = [];
  const unmeasured: Unmeasurable[] = [];
  const violations: string[] = [];
  const pinned: Array<{ site: string; version: string }> = [];
  const add = (site: string, version: string) => {
    sites.push({ site, value: version });
    pinned.push({ site, version });
  };

  // The two declarations. `declaredBunVersion` is the decider (#622's model
  // answer: it reports the disagreement rather than silently taking a winner),
  // and the file is also read directly so both positions appear as positions.
  let decision;
  try {
    decision = declaredBunVersion(root);
  } catch (e) {
    return categoryReport("toolchain-parity", "every position naming the Bun runtime names one version", {
      visible: 4,
      sites,
      violations,
      unmeasured: [unmeasurable("unparseable-file", CONFIG_JSON, `the config could not be read: ${firstLine(e)}`)],
    });
  }
  if (decision.conflict) violations.push(decision.conflict);

  // Both declaration positions, whichever of them won. Asking the decision
  // alone would report one of two disagreeing sources as "the" version, which
  // is the silent-winner reading #622 shipped the conflict field to replace.
  const declarations = bunVersionDeclarations(root);
  for (const declared of declarations) add(bunVersionSourceLabel(declared.source), declared.version);
  if (existsSync(join(root, BUN_VERSION_FILE)) && !declarations.some(d => d.source === "bun-version-file")) {
    unmeasured.push(
      unmeasurable("unresolved-source", BUN_VERSION_FILE, `${BUN_VERSION_FILE} exists and is empty, so it declares nothing`),
    );
  }

  // Every workflow that installs bun, and the file each one points at.
  const ymls = workflowFiles(root);
  let setupSteps = 0;
  for (const yml of ymls) {
    const text = readFileSync(join(root, yml), "utf-8");
    for (const declared of setupBunDeclarations(text)) {
      setupSteps++;
      if (declared.key === "bun-version") {
        if (!isPinnedBunVersion(declared.value)) {
          violations.push(
            `${yml} installs \`${declared.value}\`, which is not a pin: the runtime executing a given commit ` +
              `can change between two runs of it, with nothing in the diff to explain a new failure (#622)`,
          );
          sites.push({ site: `${yml} — setup-bun`, value: declared.value });
        } else {
          add(`${yml} — setup-bun`, declared.value);
        }
        continue;
      }
      const pointed = join(root, declared.value);
      if (!existsSync(pointed)) {
        unmeasured.push(
          unmeasurable(
            "unresolved-source",
            `${yml} — setup-bun`,
            `it installs the version in \`${declared.value}\`, and ${declared.value} is not in this tree — ` +
              `so what CI installs cannot be read from here`,
          ),
        );
        continue;
      }
      const resolved = readFileSync(pointed, "utf-8").trim();
      if (resolved === "") {
        unmeasured.push(
          unmeasurable("unresolved-source", `${yml} — setup-bun`, `${declared.value} is empty, so it resolves to nothing`),
        );
        continue;
      }
      add(`${yml} — setup-bun via ${declared.value}`, resolved);
    }
  }

  // What the scaffold would EMIT, which is the position #622c is about: a fix
  // editing only the checked-in copies leaves every consumer unpinned.
  const emitted = setupBunWith(decision, "");
  const emittedDeclarations = setupBunDeclarations(emitted);
  if (decision.source === "undeclared") {
    unmeasured.push(
      unmeasurable(
        "unresolved-source",
        "lib/bun-version.ts — the step the scaffold would emit",
        `${decision.reason}, so the emitted step is an UNPINNED \`latest\` rather than a declaration`,
      ),
    );
  } else {
    for (const declared of emittedDeclarations) {
      if (declared.key === "bun-version") add("lib/bun-version.ts — the step the scaffold would emit", declared.value);
      else {
        const pointed = join(root, declared.value);
        if (!existsSync(pointed)) {
          unmeasured.push(
            unmeasurable(
              "unresolved-source",
              "lib/bun-version.ts — the step the scaffold would emit",
              `it would point CI at \`${declared.value}\`, which is not in this tree`,
            ),
          );
        } else {
          add("lib/bun-version.ts — the step the scaffold would emit", readFileSync(pointed, "utf-8").trim());
        }
      }
    }
  }

  // The runtime actually running this, which is the comparison no static read
  // can make and the one #622 was lost in.
  const reading = bunVersionReading(decision, running);
  if (reading.state === "undeclared") {
    unmeasured.push(unmeasurable("unresolved-source", "the running runtime", reading.line));
  } else {
    sites.push({ site: "the running runtime", value: running });
    if (reading.state === "mismatch") violations.push(reading.line);
  }

  const distinct = [...new Set(pinned.map(p => p.version))];
  if (distinct.length > 1) {
    violations.push(
      `the Bun version is spelled ${distinct.length} different ways: ` +
        pinned.map(p => `${p.site} says ${p.version}`).join("; "),
    );
  }

  return categoryReport("toolchain-parity", "every position naming the Bun runtime names one version", {
    // Two declarations, one setup step per workflow that has one, the emitted
    // step, and the runtime this process is.
    visible: 2 + setupSteps + 1 + 1,
    sites,
    violations,
    unmeasured,
  });
}

// ── category 3: transport parity ────────────────────────────────────────────
//
// STATED LIMIT, because it is the one thing in this file that executes rather
// than reads: proving two transports agree means RUNNING both, so this
// category evaluates the marked block of the inspected tree's
// `workflows/ship.js` and spawns one `bun -e` with a payload this file
// authored. Both are first-party by assumption — `--root` is meant for this
// repository and for `git archive` exports of its own history, which is how
// AC-5 uses it. Do not point it at a tree you would not run `bun test` in;
// the same is true of `test/evidence-command-roundtrip.test.ts`, which has
// extracted and executed that block since #614.

/**
 * A payload built to be destroyed by a shell.
 *
 * `$1` expands to the empty string inside double quotes, `${VAR}` to the
 * environment, `$(cmd)` by RUNNING it, and a backtick the same. Run
 * `wf_c92dd0a7-fe6` persisted `awk '{s+=} END {print s+0}'` for a command the
 * agent wrote as `awk '{s+=$1} END {print s+0}'`, and the AC could never
 * produce evidence (#614). The apostrophes are here too: single quoting is the
 * only shell construct with no expansion inside it, and an apostrophe is the
 * one character it cannot carry verbatim.
 */
export const HOSTILE_EVIDENCE_COMMAND =
  "grep -rhcE '^export function x' lib | awk '{s+=$1} END {print s+0}' ${HOME} $(echo no) `echo no`";

const TRANSPORT_MARKERS = { start: "AC-PAYLOAD-TRANSPORT-START", end: "AC-PAYLOAD-TRANSPORT-END" };

/** The block `workflows/ship.js` carries because it cannot import (#69). */
export function inlinedTransportBlock(shipSource: string): string {
  const start = shipSource.indexOf(TRANSPORT_MARKERS.start);
  const end = shipSource.indexOf(TRANSPORT_MARKERS.end);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`workflows/ship.js has no ${TRANSPORT_MARKERS.start}…${TRANSPORT_MARKERS.end} block`);
  }
  return shipSource.slice(shipSource.indexOf("\n", start) + 1, shipSource.lastIndexOf("\n", end));
}

/**
 * Category 3. The dry-run and the real execution must be the same transport.
 *
 * The harness already dry-ran every AC's evidence command before Marcus ran,
 * and #600 and #614 both passed that check and died anyway: the pre-validator
 * executed the command directly, and the pipeline additionally pushed it
 * through a double-quoted `bun -e "…"` hop that ate the `$`. The preflight was
 * itself an instance of the defect it was built to prevent.
 */
export function transportParity(root: string): CategoryReport {
  const sites: ParitySite[] = [];
  const violations: string[] = [];
  const unmeasured: Unmeasurable[] = [];
  const acs = [{ id: "AC-1", evidenceMethod: { command: HOSTILE_EVIDENCE_COMMAND } }];
  const argument = acPayloadShellArgument(acs);

  // 1. The library transport, through a real shell. Not a model of the hop —
  //    the hop, with a shell in it, because a stand-in for the execution path
  //    is exactly what #614 was.
  const program = `console.log(JSON.stringify(${acPayloadReadExpression()}))`;
  const probe = spawnSync("sh", ["-c", `bun -e "${program}" ${argument}`], { encoding: "utf-8", timeout: 30_000 });
  if (probe.status !== 0) {
    unmeasured.push(
      unmeasurable(
        "unresolved-source",
        "lib/evidence-command-transport.ts — the round trip",
        `the payload could not be round-tripped through a shell: ${(probe.stderr || "").split("\n")[0]}`,
      ),
    );
  } else {
    let delivered = "";
    try {
      delivered = (JSON.parse(probe.stdout) as Array<{ evidenceMethod?: { command?: string } }>)[0]?.evidenceMethod
        ?.command ?? "";
    } catch (e) {
      unmeasured.push(
        unmeasurable("unparseable-file", "lib/evidence-command-transport.ts — the round trip", firstLine(e)),
      );
    }
    if (delivered !== "") {
      sites.push({ site: "lib/evidence-command-transport.ts — the round trip", value: delivered === HOSTILE_EVIDENCE_COMMAND ? "byte-identical" : delivered });
      if (delivered !== HOSTILE_EVIDENCE_COMMAND) {
        violations.push(
          `the evidence command does not survive the transport: the agent wrote \`${HOSTILE_EVIDENCE_COMMAND}\` ` +
            `and \`${delivered}\` arrived (#614)`,
        );
      }
    }
  }

  // 2. The inlined copy in ship.js, driven over the same payload. Two copies
  //    of one transport is the same defect as two files naming two commands.
  const shipPath = join(root, "workflows", "ship.js");
  if (!existsSync(shipPath)) {
    unmeasured.push(unmeasurable("absent-file", "workflows/ship.js", `workflows/ship.js does not exist under ${root}`));
  } else {
    const shipSource = readFileSync(shipPath, "utf-8");
    try {
      const block = inlinedTransportBlock(shipSource);
      const build = new Function(
        "shellSingleQuote",
        `${block}\nreturn { acPayloadShellArgument, acPayloadReadExpression }`,
      ) as (q: typeof shellSingleQuote) => {
        acPayloadShellArgument: (acs: unknown) => string;
        acPayloadReadExpression: () => string;
      };
      const inlined = build(shellSingleQuote);
      const inlinedArgument = inlined.acPayloadShellArgument(acs);
      sites.push({
        site: "workflows/ship.js — the inlined AC-PAYLOAD-TRANSPORT copy",
        value: inlinedArgument === argument ? "byte-identical to the library" : inlinedArgument,
      });
      if (inlinedArgument !== argument || inlined.acPayloadReadExpression() !== acPayloadReadExpression()) {
        violations.push(
          `workflows/ship.js's inlined transport disagrees with lib/evidence-command-transport.ts on the same payload`,
        );
      }
    } catch (e) {
      unmeasured.push(
        unmeasurable("unresolved-source", "workflows/ship.js — the inlined copy", firstLine(e)),
      );
    }

    // 3. The call sites. The payload must sit AFTER the closing quote of the
    //    `bun -e "…"` program as a single-quoted argument; interpolating it
    //    into the program is the #614 defect itself.
    const writeAcCalls = [...shipSource.matchAll(/writeACs\(/g)].length;
    const argumentUses = [...shipSource.matchAll(/\$\{acPayloadShellArgument\(/g)].length;
    const readUses = [...shipSource.matchAll(/\$\{acPayloadReadExpression\(\)\}/g)].length;
    const interpolated = [...shipSource.matchAll(/JSON\.stringify\(\s*discovery\.acs/g)].length;
    if (writeAcCalls === 0) {
      unmeasured.push(
        unmeasurable("unresolved-source", "workflows/ship.js — the writeACs call sites", "no writeACs call was found"),
      );
    } else {
      sites.push({
        site: "workflows/ship.js — the writeACs call sites",
        value: `${writeAcCalls} call(s), ${argumentUses} single-quoted payload argument(s), ${readUses} argv read(s)`,
      });
      if (argumentUses < writeAcCalls || readUses < writeAcCalls) {
        violations.push(
          `workflows/ship.js has ${writeAcCalls} writeACs call(s) but ${argumentUses} single-quoted payload ` +
            `argument(s) and ${readUses} argv read(s) — a call that does not use both is carrying agent-authored ` +
            `text where a shell looks (#614)`,
        );
      }
      if (interpolated > 0) {
        violations.push(
          `workflows/ship.js interpolates discovery.acs into a prompt ${interpolated} time(s); inside a double-quoted ` +
            `shell string a \`$\` is expanded, which is #614 verbatim`,
        );
      }
    }
  }

  return categoryReport("transport-parity", "an evidence command survives the path it is actually executed through", {
    visible: 3,
    sites,
    violations,
    unmeasured,
  });
}

// ── category 4: probe honesty ───────────────────────────────────────────────

/** The outcomes the probe produces when it is actually run over the three conditions. */
export function probeExternalToolOutcomes(): ToolProbeOutcome[] {
  return [
    probeExternalTool("rungate-no-such-tool-contract-parity", ["--version"]).outcome,
    probeExternalTool("sh", ["-c", "exit 3"]).outcome,
    probeExternalTool("sh", ["-c", "echo ok"]).outcome,
  ];
}

/** A spawn whose argument list is an availability question rather than a job. */
const AVAILABILITY_QUERY = /(?:Bun\.spawnSync|spawnSync|execFileSync|execSync|Bun\.spawn)\s*\([^;]{0,200}?["'`](?:--version|-v|version|--help)["'`]/g;

/**
 * Category 4. An external tool's absence, its failure and its silence are
 * three facts, and a boolean carries one.
 *
 * #597: CI installs neither `agnix` nor `@reporails/cli`, so whether
 * `npx @reporails/cli version` reaches the registry decided three compliance
 * tests' verdicts — proven by re-running an identical SHA red to green with no
 * code change. The probe is EXERCISED here rather than read, because a probe
 * with three outcome strings in its source and one reachable branch reads
 * exactly like a probe with three.
 */
export function probeHonesty(root: string): CategoryReport {
  const sites: ParitySite[] = [];
  const violations: string[] = [];
  const unmeasured: Unmeasurable[] = [];

  const outcomes = probeExternalToolOutcomes();
  const distinct = new Set(outcomes);
  sites.push({ site: "lib/tool-probe.ts — the probe, run over the three conditions", value: outcomes.join(", ") });
  if (distinct.size !== TOOL_PROBE_OUTCOMES.length) {
    violations.push(
      `the external-tool probe collapses its outcomes: an absent tool, an errored probe and a clean result ` +
        `reported ${[...distinct].join(", ")} — ${distinct.size} distinct value(s) for ${TOOL_PROBE_OUTCOMES.length} conditions (#597)`,
    );
  }

  // Every other position that asks the same question must ask it here. A
  // second probe would answer identically today and survive any mutation of
  // this one — two deciders that agree are behaviourally one.
  let scanned = 0;
  for (const file of harnessSources(root)) {
    const text = readFileSync(join(root, file), "utf-8");
    if (file === join("lib", "tool-probe.ts")) continue;
    scanned++;
    const routed = [...text.matchAll(/probeExternalTool\s*\(/g)].length;
    if (routed > 0) sites.push({ site: `${file} — availability probe`, value: `${routed} routed through lib/tool-probe.ts` });
    const raw = [...text.matchAll(AVAILABILITY_QUERY)];
    for (const m of raw) {
      violations.push(
        `${file}:${text.slice(0, m.index).split("\n").length} asks whether a tool is available with its own spawn ` +
          `rather than through lib/tool-probe.ts, so absent, errored and clean come back as one value (#597)`,
      );
    }
  }
  if (scanned === 0) {
    unmeasured.push(unmeasurable("absent-file", "the harness sources", `no harness source was found under ${root}`));
  }

  return categoryReport("probe-honesty", "an external-tool probe reports absent, errored and clean as three things", {
    visible: sites.length + violations.length,
    sites,
    violations,
    unmeasured,
  });
}

// ── category 5: field reachability ──────────────────────────────────────────
//
// #317's reconciliation, moved here from test/state-contract.test.ts so the
// gate's walk and the test's walk are one walk. The sets are extracted from
// source on every run rather than listed, because a hand-maintained inventory
// goes stale in exactly the hands of the person whose change it exists to
// catch.

/** The directories the state reconciliation reads. Exported so a planted tree can be built from the same list. */
export const SOURCE_DIRS = ["gates", "lib", "scripts", "workflows"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // Dotted entries are caches and scratch trees, never harness source.
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(p)) out.push(p);
  }
  return out;
}

/** Thrown when a reading this script depends on cannot be taken at all. */
export class UnreadableSource extends Error {}

/**
 * The files that touch the shared state, DERIVED rather than enumerated.
 *
 * A list would have to be edited by whoever adds the next writer, which is
 * precisely the person whose change this exists to catch.
 */
export function stateTouchingFiles(root = REPO_ROOT): string[] {
  return SOURCE_DIRS.flatMap(d => walk(join(root, d))).filter(f => {
    const src = readFileSync(f, "utf-8");
    return src.includes("workflow-state.json") || src.includes("writeWorkflowState");
  });
}

/** Top-level field names of `WorkflowStateSchema`. */
export function declaredFields(root = REPO_ROOT): Set<string> {
  const schemaPath = join(root, "gates", "schema.ts");
  if (!existsSync(schemaPath)) throw new UnreadableSource(`gates/schema.ts does not exist under ${root}`);
  const schema = readFileSync(schemaPath, "utf-8");
  const start = schema.indexOf("export const WorkflowStateSchema");
  if (start === -1) throw new UnreadableSource("WorkflowStateSchema is not where this reading expects it");
  const body = schema.slice(start);
  const end = body.indexOf("\n})");
  if (end === -1) throw new UnreadableSource("could not find the end of WorkflowStateSchema");
  const names = (body.slice(0, end).match(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm) || []).map(m => m.trim().replace(":", ""));
  // A zero-length reading is the vacuous case: every comparison below is a
  // filter over this set, and an empty one makes all of them pass over
  // anything.
  if (names.length <= 10) throw new UnreadableSource("no fields parsed out of WorkflowStateSchema");
  return new Set(names);
}

/** Every `sf("<field>")` the gate suites read, root segment only. */
export function readFields(root = REPO_ROOT): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of stateTouchingFiles(root)) {
    for (const m of readFileSync(f, "utf-8").matchAll(/sf\("([a-zA-Z][a-zA-Z0-9]*)/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1])!.push(f.replace(`${root}/`, ""));
    }
  }
  return found;
}

/**
 * Every `<ident>.<field> =` assignment onto a state object.
 *
 * Test files are excluded, and deliberately: a fixture planting a field is not
 * a producer. Counting one would let a dead schema term stay alive on the
 * strength of the fixture that mentions it.
 */
export function writtenFields(root = REPO_ROOT): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of stateTouchingFiles(root)) {
    if (/\.test\.(ts|js)$/.test(f)) continue;
    const src = readFileSync(f, "utf-8");
    for (const m of src.matchAll(/\b(?:state|s|ws|st)\.([a-zA-Z][a-zA-Z0-9]*)\s*(?:=[^=]|\?\?=)/g)) {
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1])!.push(f.replace(`${root}/`, ""));
    }
  }
  return found;
}

/**
 * Whether a field name appears at all in non-test harness source, outside the
 * schema that declares it.
 *
 * Deliberately the weakest of the three readings. Most of the state is built
 * as an object literal at bootstrap, which the assignment regex cannot see, so
 * a stricter reading here would report a dozen live fields as dead. What it
 * still catches admits no innocent reading: a field the contract declares
 * whose NAME occurs nowhere in the harness at all.
 */
export function mentionedInSource(field: string, root = REPO_ROOT): string[] {
  const word = new RegExp(`\\b${field}\\b`);
  return SOURCE_DIRS.flatMap(d => walk(join(root, d)))
    .filter(f => !/\.test\.(ts|js)$/.test(f))
    .filter(f => f !== join(root, "gates", "schema.ts"))
    .filter(f => word.test(readFileSync(f, "utf-8")))
    .map(f => f.replace(`${root}/`, ""));
}

/** A check reading a field the contract does not describe. */
export function undeclaredReadViolations(root = REPO_ROOT): string[] {
  const declared = declaredFields(root);
  return [...readFields(root).entries()]
    .filter(([field]) => !declared.has(field))
    .map(([field, files]) => `${field} — read by ${[...new Set(files)].join(", ")}`);
}

/** A producer writing a field nothing promises to keep. */
export function undeclaredWriteViolations(root = REPO_ROOT): string[] {
  const declared = declaredFields(root);
  return [...writtenFields(root).entries()]
    .filter(([field]) => !declared.has(field))
    .map(([field, files]) => `${field} — written by ${[...new Set(files)].join(", ")}`);
}

/** A contract term nothing in the harness honours. */
export function orphanDeclarationViolations(root = REPO_ROOT): string[] {
  const read = readFields(root);
  const written = writtenFields(root);
  return [...declaredFields(root)].filter(
    f => !read.has(f) && !written.has(f) && mentionedInSource(f, root).length === 0,
  );
}

/**
 * Category 5. Every path a gate or a prompt reads is declared by the schema
 * that governs it.
 *
 * #530 is why this reads the SCHEMA and not the state file: `writeWorkflowState`
 * validates with `.passthrough()` and then writes the original object, so an
 * undeclared key validates, persists and reads back exactly like a declared
 * one. The artefact confirms any field you ask it about; the schema is the
 * statement about what has a producer.
 */
export function fieldReachability(root: string): CategoryReport {
  const sites: ParitySite[] = [];
  const violations: string[] = [];
  const unmeasured: Unmeasurable[] = [];

  let files: string[] = [];
  try {
    files = stateTouchingFiles(root);
  } catch (e) {
    return categoryReport("field-reachability", "every state path a consumer reads is declared by the schema", {
      visible: 1,
      sites,
      violations,
      unmeasured: [unmeasurable("absent-file", "the harness sources", firstLine(e))],
    });
  }
  if (files.length === 0) {
    return categoryReport("field-reachability", "every state path a consumer reads is declared by the schema", {
      visible: 1,
      sites,
      violations,
      unmeasured: [unmeasurable("absent-file", "the state-touching sources", `nothing under ${root} touches workflow-state.json`)],
    });
  }

  try {
    const read = readFields(root);
    const written = writtenFields(root);
    for (const f of files) {
      const relative = f.replace(`${root}/`, "");
      const reads = [...read.entries()].filter(([, where]) => where.includes(relative)).length;
      const writes = [...written.entries()].filter(([, where]) => where.includes(relative)).length;
      sites.push({ site: relative, value: `${reads} field(s) read, ${writes} written` });
    }
    violations.push(
      ...undeclaredReadViolations(root).map(v => `a consumer reads a field the schema does not declare: ${v}`),
      ...undeclaredWriteViolations(root).map(v => `a producer writes a field the schema does not declare: ${v}`),
      ...orphanDeclarationViolations(root).map(
        v => `the schema declares \`${v}\` and nothing in the harness produces or consumes it — every reader of it reads undefined forever (#530)`,
      ),
    );
  } catch (e) {
    unmeasured.push(unmeasurable("unparseable-file", "gates/schema.ts", firstLine(e)));
  }

  return categoryReport("field-reachability", "every state path a consumer reads is declared by the schema", {
    visible: files.length,
    sites,
    violations,
    unmeasured,
  });
}

// ── category 6: write accountability ────────────────────────────────────────

const WRITE_CALL = /\b(writeFileSync|appendFileSync)\(\s*([A-Za-z0-9_.]+|join\([^)]*\)|resolve\([^)]*\)|`[^`]*`|"[^"]*")/g;

/** Identifiers a path is anchored to when it is inside the project being written. */
const PROJECT_ROOTS = new Set([
  "root",
  "ROOT",
  "projectRoot",
  "PROJECT_ROOT",
  "projectPath",
  "consumerRoot",
  "harnessRoot",
  "HARNESS_ROOT",
  "targetRoot",
]);

/** Non-test harness source, repo-relative. */
function harnessSources(root: string): string[] {
  return ["lib", "gates", "scripts", "hooks", "workflows", "bin"]
    .flatMap(d => walk(join(root, d)))
    .filter(f => !/\.test\.(ts|js)$/.test(f))
    .map(f => f.replace(`${root}/`, ""));
}

/** The files `.claude/rules/harness-managed.md` says the harness owns. */
export function declaredManagedFiles(root: string): string[] {
  const path = join(root, ".claude", "rules", "harness-managed.md");
  if (!existsSync(path)) throw new UnreadableSource(`.claude/rules/harness-managed.md does not exist under ${root}`);
  const text = readFileSync(path, "utf-8");
  const rows = [...text.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(m => m[1].trim());
  if (rows.length === 0) throw new UnreadableSource("the harness-managed table has no rows");
  return rows;
}

function matchesManaged(destination: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(destination));
}

export interface TrackedWrite {
  /** Repo-relative source file. */
  file: string;
  line: number;
  /** The tracked path it writes, or null when the destination is not static. */
  destination: string | null;
  /** The expression the destination was read from, for a reader to go and look at. */
  expression: string;
}

/**
 * Every position in harness source that writes a file the repository tracks.
 *
 * Two kinds, and the second is the one #624 needs: a direct write whose path
 * is built from literals, and a CALL to a function that writes a path it was
 * handed. The hill-climb write is the second — the write is in
 * `lib/compliance-report.ts`, the path comes from a config lookup three frames
 * up, and a literal scan sees nothing at either end.
 *
 * Nothing below may be written here as a call with a bare identifier argument,
 * prose included: this scanner reads raw source on purpose (#89 — a detector
 * that strips comments is a detector whose view of the input can shrink), so a
 * docstring naming a sink the way a caller does would plant a site that does
 * not exist. It did, on the first run of this scanner, in this very comment.
 */
export function trackedWriteSites(root: string, tracked: Set<string>): TrackedWrite[] {
  const trackedDirs = new Set<string>();
  for (const t of tracked) {
    const parts = t.split("/");
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join("/"));
  }
  const sources = harnessSources(root);
  const out: TrackedWrite[] = [];

  // Functions that write a path they were given — the sinks.
  const sinks = new Map<string, string>();
  for (const file of sources) {
    const text = readFileSync(join(root, file), "utf-8");
    for (const m of text.matchAll(/export function ([A-Za-z0-9_]+)\(\s*([A-Za-z0-9_]+)\s*:\s*string/g)) {
      const body = text.slice(m.index!, text.indexOf("\nexport ", m.index! + 1) === -1 ? undefined : text.indexOf("\nexport ", m.index! + 1));
      if (new RegExp(`(writeFileSync|appendFileSync)\\(\\s*${m[2]}\\b`).test(body)) sinks.set(m[1], file);
    }
  }

  for (const file of sources) {
    const text = readFileSync(join(root, file), "utf-8");
    const lineOf = (index: number) => text.slice(0, index).split("\n").length;

    for (const m of text.matchAll(WRITE_CALL)) {
      let expression = m[2];
      if (/^[A-Za-z0-9_]+$/.test(expression)) {
        const assigned = new RegExp(`(?:const|let)\\s+${expression}\\s*=\\s*([^;\\n]+)`).exec(text);
        if (assigned) expression = assigned[1].trim();
      }
      // Only paths anchored to the project being written. A write under $HOME
      // or a work directory is not a tracked file and must not be counted as
      // one — a site that is not a site is a coverage number nobody can read.
      const anchor = /^(?:join|resolve)\(\s*([A-Za-z0-9_.]+)/.exec(expression)?.[1];
      if (!anchor || !PROJECT_ROOTS.has(anchor)) continue;
      const literals = [...expression.matchAll(/["'`]([^"'`]+)["'`]/g)].map(x => x[1]).filter(x => !x.includes("${"));
      const candidates: string[] = [];
      for (let a = 0; a < literals.length; a++)
        for (let b = a; b < literals.length; b++) candidates.push(literals.slice(a, b + 1).join("/").replace(/^\/+|\/+$/g, ""));
      const hit = candidates.find(c => c !== "" && (tracked.has(c) || trackedDirs.has(c)));
      if (hit) out.push({ file, line: lineOf(m.index!), destination: hit, expression: expression.replace(/\s+/g, " ").slice(0, 120) });
    }

    for (const [sink, owner] of sinks) {
      if (owner === file) continue;
      for (const m of text.matchAll(new RegExp(`\\b${sink}\\s*\\(\\s*([A-Za-z0-9_.]+)`, "g"))) {
        out.push({ file, line: lineOf(m.index!), destination: null, expression: `${sink}(${m[1]}) → ${owner}` });
      }
    }
  }
  return out;
}

/**
 * Writers of tracked content that `.claude/rules/harness-managed.md` does not
 * list, as measured on 2026-10-18.
 *
 * A known-violations ratchet, refusing in BOTH directions: a writer that is
 * not on this list fails, and a list entry nothing writes any more fails. So a
 * new unaccounted writer is red while the total is above zero, and clearing one
 * means deleting its line in the same commit.
 *
 * What the number means: the harness writes these paths into a project, and
 * the document that tells a consumer which files the harness owns does not
 * mention them. That is the #622c shape — the behaviour and the declaration
 * are produced by different hands and nothing compared them — not a claim that
 * any individual write is wrong.
 */
export const KNOWN_UNDECLARED_WRITES: Record<string, string> = {
  "lib/scaffold/steps.ts → .claude": "the scaffolder writes .claude/rungate.json and settings.local.json",
  "lib/scaffold/steps.ts → tsconfig.json": "scaffold seeds a tsconfig for a project that has none",
  "lib/scaffold/steps.ts → .gitignore": "scaffold appends ignore rules",
  "lib/scaffold/steps.ts → CLAUDE.md": "scaffold seeds CLAUDE.md",
  "lib/scaffold/steps.ts → package.json": "scaffold adds scripts",
  "scripts/sync-spec-tests.ts → test/spec-compliance-auto.test.ts": "generated test file, regenerated on demand",
  "scripts/generate-spec-template-patterns.ts → specs/SPEC-TEMPLATE.md": "generated spec template",
  "scripts/typecheck.ts → .claude": "the typecheck baseline ratchet",
};

/**
 * Category 6. A code path that modifies a tracked file either commits it,
 * reverts it, or is declared as a file the harness owns.
 *
 * #624: `lib/compliance-report.ts` writes reinforcement lines into an agent
 * brief and nothing commits them, so every reinforcement the learning loop has
 * ever made was discarded with the worktree. The comparison that would have
 * caught it is `git status --porcelain`, and nobody ran it.
 *
 * The sink-caller half of the reading cannot resolve its destination — it is a
 * config lookup, not a literal — and says so rather than counting it as clean.
 * A site whose destination is unknown is an UNMEASURED site, which is the
 * reading this category can honestly take today, and the coverage number is
 * what stops that passing for a full one.
 */
export function writeAccountability(root: string): CategoryReport {
  const sites: ParitySite[] = [];
  const violations: string[] = [];
  const unmeasured: Unmeasurable[] = [];

  let tracked: Set<string>;
  try {
    tracked = new Set(
      execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf-8", timeout: 30_000 })
        .split("\n")
        .filter(Boolean),
    );
  } catch (e) {
    return categoryReport("write-accountability", "a writer of tracked content commits it, reverts it, or is declared", {
      visible: 1,
      sites,
      violations,
      unmeasured: [unmeasurable("unresolved-source", "git", `the tracked file set could not be read: ${firstLine(e)}`)],
    });
  }
  if (tracked.size === 0) {
    return categoryReport("write-accountability", "a writer of tracked content commits it, reverts it, or is declared", {
      visible: 1,
      sites,
      violations,
      unmeasured: [unmeasurable("unresolved-source", "git", `${root} tracks no files, so no write can be checked against it`)],
    });
  }

  let managed: string[];
  try {
    managed = declaredManagedFiles(root);
  } catch (e) {
    return categoryReport("write-accountability", "a writer of tracked content commits it, reverts it, or is declared", {
      visible: 1,
      sites,
      violations,
      unmeasured: [unmeasurable("absent-file", ".claude/rules/harness-managed.md", firstLine(e))],
    });
  }

  const found = trackedWriteSites(root, tracked);
  const unaccounted = new Set<string>();
  for (const write of found) {
    if (write.destination === null) {
      unmeasured.push(
        unmeasurable(
          "unresolved-source",
          `${write.file}:${write.line}`,
          `${write.expression} hands a path resolved at runtime to a writer, so whether it lands on tracked content ` +
            `cannot be read from here — which is how #624 went unseen`,
          false,
        ),
      );
      continue;
    }
    const key = `${write.file} → ${write.destination}`;
    // Accountability is the DECLARATION, and nothing else. An earlier draft
    // also accepted "this file mentions `git add` somewhere", which read as
    // accountable for five scaffold writes that nothing commits: a file-level
    // grep is a proxy, and a proxy is a thing a comment can satisfy directly
    // (`.claude/rules/checks-must-be-able-to-fail.md`, on wording a refusal
    // after the property rather than after the cheapest reading of it).
    if (matchesManaged(write.destination, managed)) {
      sites.push({ site: key, value: "declared in harness-managed.md" });
      continue;
    }
    unaccounted.add(key);
    sites.push({ site: key, value: "UNDECLARED — no commit, no revert, not in harness-managed.md" });
  }

  for (const key of unaccounted) {
    if (!(key in KNOWN_UNDECLARED_WRITES)) {
      violations.push(
        `${key} writes content this repository tracks, and nothing commits it, reverts it, or declares it in ` +
          `.claude/rules/harness-managed.md (#624)`,
      );
    }
  }
  for (const key of Object.keys(KNOWN_UNDECLARED_WRITES)) {
    if (!unaccounted.has(key)) {
      violations.push(
        `the known-undeclared list still carries \`${key}\`, and the scan no longer finds it — either it was fixed ` +
          `and the entry must go in the same commit, or the scan stopped seeing it`,
      );
    }
  }

  return categoryReport("write-accountability", "a writer of tracked content commits it, reverts it, or is declared", {
    visible: found.length,
    sites,
    violations,
    unmeasured,
    known: [...unaccounted].sort().map(k => `${k} — ${KNOWN_UNDECLARED_WRITES[k] ?? "unaccounted"}`),
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

const RUNNERS: Record<ParityCategory, (root: string) => CategoryReport> = {
  "command-parity": commandParity,
  "toolchain-parity": root => toolchainParity(root),
  "transport-parity": transportParity,
  "probe-honesty": probeHonesty,
  "field-reachability": fieldReachability,
  "write-accountability": writeAccountability,
};

export function contractParity(root: string, only?: ParityCategory[]): ContractParityReport {
  const wanted = only && only.length > 0 ? only : [...PARITY_CATEGORIES];
  const categories = wanted.map(c => RUNNERS[c](root));
  const verdict: ParityVerdict = categories.some(c => c.verdict === "FAIL")
    ? "FAIL"
    : categories.some(c => c.verdict === "UNMEASURED")
      ? "UNMEASURED"
      : "PASS";
  return { root, verdict, categories };
}

/**
 * The exit code. UNMEASURED refuses as hard as FAIL: a comparison nobody could
 * perform is not a comparison that passed, and letting it exit zero is the
 * silent default this whole file exists to remove.
 */
export function parityExitCode(report: ContractParityReport): number {
  return report.categories.every(c => c.verdict === "PASS") ? 0 : REFUSE_EXIT;
}

export function renderParity(report: ContractParityReport): string {
  const lines = [`contract parity over ${report.root}`, ""];
  for (const c of report.categories) {
    lines.push(`${c.verdict.padEnd(10)} ${c.category}  (${c.coverage.reading} sites)  — ${c.title}`);
    for (const v of c.violations) lines.push(`             VIOLATION: ${v}`);
    for (const u of c.unmeasured) lines.push(`             UNMEASURED (${u.kind}) ${u.site}: ${u.reason}`);
    for (const k of c.known ?? []) lines.push(`             known: ${k}`);
  }
  lines.push("", `verdict: ${report.verdict}`);
  return lines.join("\n");
}

export function parseArgs(argv: string[]): { root: string; json: boolean; categories: ParityCategory[] } {
  const out = { root: REPO_ROOT, json: false, categories: [] as ParityCategory[] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--root needs a value");
      out.root = value;
      continue;
    }
    if (arg === "--category") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--category needs a value");
      if (!(PARITY_CATEGORIES as readonly string[]).includes(value)) {
        throw new Error(`unknown category "${value}" — one of ${PARITY_CATEGORIES.join(", ")}`);
      }
      out.categories.push(value as ParityCategory);
      continue;
    }
    throw new Error(`unexpected argument "${arg.slice(0, 80)}" — every input is a --flag`);
  }
  return out;
}

// Guarded so the module can be imported without running the comparison and
// calling process.exit.
if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = contractParity(args.root, args.categories);
    console.log(args.json ? JSON.stringify(report, null, 2) : renderParity(report));
    process.exit(parityExitCode(report));
  } catch (e) {
    console.error(`contract parity could not run: ${firstLine(e)}`);
    process.exit(REFUSE_EXIT);
  }
}
