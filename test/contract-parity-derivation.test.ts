/**
 * Covers AC-6, AC-7, AC-8, AC-9 (#637 — #626 Phase 2).
 *
 * Phase 1 proved the contract-parity command RUNS: six verdicts, an exit code
 * that follows them, coverage beside every reading, UNMEASURED where it could
 * not compare. What it did not establish is that each category catches **the
 * specific defect it was derived from**. Without that the six categories are a
 * paraphrase of #626's twelve-row table rather than a test of it.
 *
 * ## What a derivation case is, and what it is not
 *
 * Each case below reconstructs the condition of ONE row of that table and
 * names the issue number in the case, and each is paired with a control in
 * which exactly one thing is different. The pairing is the point: a case that
 * only shows the category refusing is satisfied by a category that refuses
 * everything, and a case that only shows it passing is satisfied by a category
 * that passes everything.
 *
 * **The pre-fix condition is PLANTED, never reached for.** Four of the six
 * derivation issues are fixed and on main, so the live tree cannot witness
 * them — and category 4 is the sharp instance: #597 merged as `41f2e640`, CI
 * now installs `a pinned `agnix`` before `bun test`, so a case that probes the
 * ambient environment for a missing `agnix` passes today for a reason that has
 * nothing to do with the check. Nothing below reads an external tool that may
 * or may not be installed.
 *
 * ## The derivation issue per category, read off #626's table
 *
 * | # | category | derived from | what is planted here |
 * |---|---|---|---|
 * | 1 | command parity | **#621** | config says `--parallel --no-isolate`, AGENTS.md and ci.yml say `bun test` |
 * | 2 | toolchain parity | **#622** | `.bun-version` 1.3.14, ci.yml `latest`, release.yml 1.4.3 |
 * | 3 | transport parity | **#600**, #614 | the `$1` payload through the pre-#614 double-quoted `bun -e` hop |
 * | 4 | probe honesty | **#597** | a source file asking `spawnSync("agnix", ["--version"])` itself |
 * | 5 | field reachability | **#530** | a prompt reading `testsSha`, a schema that never declared it, and a state file that carries it |
 * | 6 | write accountability | **#624** | a writer of a tracked brief that nothing commits, reverts or declares |
 *
 * ## AC-8 is three violation classes out of ONE binding
 *
 * `parityBindingViolations` in `lib/parity-binding.ts`. Two deciders that
 * agree are behaviourally one guard and a mutation of either leaves the other
 * holding the case up, so there is one exported function and three inputs,
 * each of which reaches exactly one class. Which decider each case is for is
 * written down beside it — without that, the next person to simplify the code
 * deletes a line that has a test and watches it stay green.
 *
 * The mutation battery for all of this, predicted before it was run, is in
 * `.claude/rules/checks-must-be-able-to-fail.md` under "When the derivation of
 * a check is the thing being tested (#637)".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { setupBunDeclarations } from "../lib/bun-version";
import { suiteJobName } from "../lib/ci-checkout";
import { acPayloadJson, acPayloadReadExpression, acPayloadShellArgument } from "../lib/evidence-command-transport";
import {
  FOREIGN_PARITY_WORD,
  PARITY_BINDING,
  PARITY_SCAN_DIRS,
  declarationsNaming,
  parityBindingViolations,
} from "../lib/parity-binding";
import {
  AGENTS_MD,
  CI_YML,
  CONFIG_JSON,
  testCommandAgreement,
  testCommandsNamedByAgentsMd,
  testCommandsNamedByCiWorkflow,
  testCommandsNamedByConfig,
} from "../lib/test-command-positions";
import {
  HOSTILE_EVIDENCE_COMMAND,
  commandParity,
  fieldReachability,
  probeExternalToolOutcomes,
  probeHonesty,
  toolchainParity,
  transportParity,
  writeAccountability,
  type CategoryReport,
} from "../scripts/contract-parity";

const REPO_ROOT = join(import.meta.dir, "..");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `parity-derivation-637-${label}-`));
  scratch.push(dir);
  return dir;
}

function put(root: string, relative: string, text: string): void {
  const dest = join(root, relative);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
}

/** Every violation and every unmeasured reason, as one searchable list. */
function said(report: CategoryReport): string[] {
  return [...report.violations, ...report.unmeasured.map(u => `UNMEASURED(${u.kind}) ${u.site}: ${u.reason}`)];
}

function says(report: CategoryReport, fragment: string): boolean {
  return said(report).some(s => s.includes(fragment));
}

// ── AC-6 category 1: #621 ───────────────────────────────────────────────────

/**
 * The exact string `.claude/rungate/config.json` held on the day #621 was
 * filed. The `--parallel` is what starved 122 I/O-bound tests past bun's
 * per-test timeout, so every ship run reported `SHIP_PASSED_SUITE_FAILED` over
 * a tree with zero real failures.
 */
const COMMAND_621 = "bun test --parallel --no-isolate";

function agentsMd(command: string): string {
  return (
    `# demo\n\n## Commands\n\n| Action | Command |\n|---|---|\n` +
    `| Test | \`${command}\` |\n| Type check | \`bun run typecheck\` |\n` +
    `\n## Workflow\n- **Test:** \`${command}\`\n`
  );
}

function ciYml(command: string): string {
  return (
    `name: CI\n\njobs:\n  test:\n    runs-on: "ubuntu-latest"\n    steps:\n` +
    `      - uses: actions/checkout@v4\n      - run: bun install\n      - run: ${command}\n` +
    `      - run: bun run typecheck\n`
  );
}

/** The #621 tree: three documents, two spellings, nothing comparing them. */
function tree621(configCommand: string): string {
  const root = scratchDir("621");
  put(root, AGENTS_MD, agentsMd("bun test"));
  put(root, CI_YML, ciYml("bun test"));
  put(root, CONFIG_JSON, JSON.stringify({ project: "demo", test: { command: configCommand } }, null, 2));
  put(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "bun test" } }, null, 2));
  return root;
}

describe("#637 AC-6 category 1: command parity catches #621", () => {
  test("AC-6/#621: the config saying `bun test --parallel --no-isolate` while AGENTS.md and ci.yml say `bun test` is a violation", () => {
    const defective = commandParity(tree621(COMMAND_621));

    // The instrument before the finding: a reading that extracted nothing
    // reports no disagreement for a reason that has nothing to do with the
    // tree, and looks exactly like the control below.
    expect(defective.coverage.examined, `nothing was read:\n${JSON.stringify(defective, null, 2)}`).toBeGreaterThan(3);
    expect(defective.verdict, said(defective).join("\n")).toBe("FAIL");
    // Named positions, not a count. #532: a count is the proxy, membership is
    // the property — a violation saying "2 spellings" and naming neither is
    // satisfied by any two.
    expect(says(defective, COMMAND_621)).toBe(true);
    expect(says(defective, AGENTS_MD)).toBe(true);
    expect(says(defective, CI_YML)).toBe(true);
    expect(says(defective, CONFIG_JSON)).toBe(true);
  });

  test("AC-6/#621 control: the same tree with the config agreeing reports no violation", () => {
    // Exactly one thing differs from the case above — the config's string. A
    // pair that varied the fixture shape as well would measure neither (#585).
    const repaired = commandParity(tree621("bun test"));

    expect(repaired.violations, said(repaired).join("\n")).toEqual([]);
    expect(repaired.verdict).toBe("PASS");
    expect(repaired.coverage.reading).toBe("5/6");
  });

  test("AC-6/#621: the three-file binding reaches the same verdict on the same tree", () => {
    // `testCommandAgreement` compares three positions and `commandParity`
    // compares six. They are not two deciders that agree: the input that
    // separates them is the two positions the three-file reading cannot see —
    // AGENTS.md's Workflow line and the command the scaffold would generate.
    const root = tree621(COMMAND_621);
    const three = testCommandAgreement(root);
    expect(three.violations.length).toBe(1);
    expect(three.commands.map(c => c.command).sort()).toEqual(["bun test", "bun test", COMMAND_621].sort());
    // Six positions, and the two extra are both present and both read.
    expect(commandParity(root).sites.length).toBe(5);
  });
});

// ── AC-6 category 2: #622 ───────────────────────────────────────────────────

/**
 * The #622 tree. Four positions named a runtime and nothing compared any of
 * them: the development machine ran 1.3.14, `ci.yml` and `gates.yml` said
 * `latest` (which resolved to 1.4.3), and `release.yml` was pinned — so the
 * PUBLISHED ARTIFACT was built on a runtime CI never tested (#622b).
 */
function tree622(opts: { ci: string; release: string }): string {
  const root = scratchDir("622");
  put(root, ".bun-version", "1.3.14\n");
  put(
    root,
    CI_YML,
    `name: CI\n\njobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n` +
      `          bun-version: "${opts.ci}"\n      - run: bun test\n`,
  );
  put(
    root,
    join(".github", "workflows", "release.yml"),
    `name: Release\n\njobs:\n  publish:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n` +
      `          bun-version: "${opts.release}"\n      - run: bun publish\n`,
  );
  return root;
}

describe("#637 AC-6 category 2: toolchain parity catches #622", () => {
  test("AC-6/#622: an unpinned `latest` in CI beside a pinned release workflow is two violations, not none", () => {
    const defective = toolchainParity(tree622({ ci: "latest", release: "1.4.3" }), "1.3.14");

    expect(defective.coverage.examined, JSON.stringify(defective, null, 2)).toBeGreaterThan(2);
    expect(defective.verdict, said(defective).join("\n")).toBe("FAIL");
    // #622: `latest` is not a pin — the runtime executing a given commit can
    // change between two runs of it, with nothing in the diff to explain a new
    // failure. That is what made the original unbisectable.
    expect(says(defective, "which is not a pin")).toBe(true);
    expect(says(defective, "#622")).toBe(true);
    // #622b: and the positions that ARE pinned do not agree with each other,
    // which is the half that shipped an artifact on an untested runtime.
    expect(says(defective, "spelled 2 different ways")).toBe(true);
    expect(says(defective, "1.4.3")).toBe(true);
  });

  test("AC-6/#622 control: every position naming 1.3.14 reports neither violation", () => {
    const repaired = toolchainParity(tree622({ ci: "1.3.14", release: "1.3.14" }), "1.3.14");

    expect(repaired.violations, said(repaired).join("\n")).toEqual([]);
    expect(repaired.verdict).toBe("PASS");
  });

  test("AC-6/#622c: the position a reviewer cannot see is the step the scaffold would EMIT", () => {
    // #622c is the row that bounds what the check has to look at: the
    // declaration this repository ships to consumers is emitted by a
    // generator, so a check reading only `.github/workflows/` in this tree
    // passes while every scaffolded project disagrees with it. The reading and
    // the generator are one module now (#637 AC-9), so the round trip is an
    // import rather than a second copy of this regex.
    const emitted = toolchainParity(tree622({ ci: "1.3.14", release: "1.3.14" }), "1.3.14");
    expect(emitted.sites.map(s => s.site)).toContain("lib/bun-version.ts — the step the scaffold would emit");

    // The generator's own output, read back by the reader in the same module.
    const declarations = setupBunDeclarations(
      `      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: ".bun-version"\n`,
    );
    expect(declarations).toEqual([{ key: "bun-version-file", value: ".bun-version" }]);
  });
});

// ── AC-6 category 3: #600 / #614 ────────────────────────────────────────────

describe("#637 AC-6 category 3: transport parity catches #600 and #614", () => {
  test("AC-6/#614: the pre-fix transport eats the `$1` and the shipped transport does not", () => {
    // #600 and #614 both PASSED the evidence pre-validator and died anyway:
    // the pre-validator executed the command directly, and the pipeline
    // additionally pushed it through a double-quoted `bun -e "…"` hop that ate
    // the `$`. Run `wf_c92dd0a7-fe6` persisted `awk '{s+=} END {print s+0}'`
    // for a command the agent wrote as `awk '{s+=$1} END {print s+0}'`.
    //
    // This is that hop, rebuilt. Nothing is mutated: the defect is a
    // DIFFERENT transport, so it is written out here and run beside the real
    // one.
    //
    // **The pair varies exactly one thing and cannot carry a second
    // difference** (#585). ONE payload string is produced by `acPayloadJson`
    // and quoted two ways — single, which has no expansion inside it at all,
    // and double, which is the only other way to pass a string with spaces
    // and is what the pre-#614 hop did. Same program, same argv index, same
    // reader. Two literals would be two literals, and the next edit touches
    // one of them.
    const roundTrip = (word: string) =>
      spawnSync("sh", ["-c", `bun -e "console.log(JSON.stringify(${acPayloadReadExpression()}))" ${word}`], {
        encoding: "utf-8",
        timeout: 30_000,
      });
    // Only `"` and `\` are escaped — which is exactly as much as the pre-#614
    // hop escaped. `$` and a backtick are left alone, because leaving them
    // alone IS the defect; escaping them here would be writing the fix into
    // the fixture and measuring nothing.
    const doubleQuoted = (json: string) => `"${json.replace(/(["\\])/g, "\\$1")}"`;
    const commandOf = (r: ReturnType<typeof roundTrip>) =>
      (JSON.parse(r.stdout) as Array<{ evidenceMethod?: { command?: string } }>)[0]?.evidenceMethod?.command;

    // Reading 1 — the run's own command. `$1` and nothing else, which is the
    // mangling that was actually persisted.
    const RUN_COMMAND = "awk '{s+=$1} END {print s+0}'";
    const one = [{ id: "AC-1", evidenceMethod: { command: RUN_COMMAND } }];
    const before = roundTrip(doubleQuoted(acPayloadJson(one)));
    const after = roundTrip(acPayloadShellArgument(one));
    expect(before.status, `the pre-#614 hop could not be run at all: ${before.stderr}`).toBe(0);
    expect(after.status, `the shipped transport could not be run: ${after.stderr}`).toBe(0);

    // The distinguishing input, named and run rather than assumed: `$1`
    // inside a double-quoted shell word expands to the empty string.
    expect(commandOf(before), "the pre-#614 hop delivered it intact, so this case measures nothing").not.toBe(
      RUN_COMMAND,
    );
    expect(commandOf(before)).toBe("awk '{s+=} END {print s+0}'");
    expect(commandOf(after)).toBe(RUN_COMMAND);

    // Reading 2 — all four constructs, which is why the category's payload
    // carries more than the one the run happened to die on. `$(cmd)` and a
    // backtick do not merely expand: the shell RUNS the agent's text.
    const hostile = [{ id: "AC-1", evidenceMethod: { command: HOSTILE_EVIDENCE_COMMAND } }];
    const mangled = roundTrip(doubleQuoted(acPayloadJson(hostile)));
    const survived = roundTrip(acPayloadShellArgument(hostile));
    expect(mangled.status, `the pre-#614 hop: ${mangled.stderr}`).toBe(0);
    expect(survived.status, survived.stderr).toBe(0);
    expect(commandOf(mangled)).not.toBe(HOSTILE_EVIDENCE_COMMAND);
    // Each construct named separately, because "it differs" is satisfied by
    // any one of the four and this is a claim about all four.
    const eatenHostile = commandOf(mangled)!;
    expect(eatenHostile, "`$1` survived").toContain("{s+=} END");
    expect(eatenHostile, "`${HOME}` survived").not.toContain("${HOME}");
    expect(eatenHostile, "`$(echo no)` survived").not.toContain("$(echo no)");
    expect(eatenHostile, "the backtick survived").not.toContain("`echo no`");
    // Both substitutions were EXECUTED, and their output is what arrived in
    // place of the text the agent wrote.
    expect(eatenHostile).toContain("no no");
    expect(commandOf(survived)).toBe(HOSTILE_EVIDENCE_COMMAND);
  });

  test("AC-6/#600: the category reports PASS on this tree, which is a different reading from UNMEASURED", () => {
    // The prep for this phase names the trap: category 3 is the one with a
    // proven live finding, and a case that does not distinguish FAIL from
    // UNMEASURED passes over the regression. A foreign root is UNMEASURED
    // BECAUSE nothing ran; this root is PASS because both transports ran and
    // agreed. Asserting "not FAIL" would accept both.
    const here = transportParity(REPO_ROOT);
    expect(here.verdict, said(here).join("\n")).toBe("PASS");
    expect(here.coverage.reading).toBe("3/3");
    expect(here.sites.map(s => s.value)).toContain("byte-identical");

    const foreign = scratchDir("foreign");
    put(foreign, join("workflows", "ship.js"), "// AC-PAYLOAD-TRANSPORT-START\n// AC-PAYLOAD-TRANSPORT-END\n");
    const elsewhere = transportParity(foreign);
    expect(elsewhere.verdict).toBe("UNMEASURED");
    // `0/3`, not `0/0`: a refusal hiding behind a full fraction is a refusal
    // no reader can tell from a complete reading.
    expect(elsewhere.coverage.reading).toBe("0/3");
    expect(elsewhere.sites).toEqual([]);
  });
});

// ── AC-6 category 4: #597 ───────────────────────────────────────────────────

describe("#637 AC-6 category 4: probe honesty catches #597", () => {
  test("AC-6/#597: a file asking whether a tool exists with its own spawn is a violation", () => {
    // #597: `checkToolAvailable` returned `false` for "tool absent", "network
    // timed out" and "tool ran and found nothing" alike, so three compliance
    // tests' verdicts turned on whether `npx @reporails/cli version` reached
    // the registry — proven by re-running an identical SHA red to green.
    //
    // PLANTED, not probed. #597 merged as `41f2e640` and CI now installs
    // a pinned `agnix` before `bun test`, so the pre-fix condition — agnix absent
    // — is no longer the ambient state. A case that shelled out to the real
    // `agnix` here would pass for a reason that has nothing to do with the
    // check.
    const root = scratchDir("597");
    put(
      root,
      join("lib", "compliance.ts"),
      `import { spawnSync } from "child_process";\n` +
        `export function checkToolAvailable(tool: string): boolean {\n` +
        `  return spawnSync(tool, ["--version"]).status === 0;\n` +
        `}\n`,
    );
    const defective = probeHonesty(root);

    expect(defective.verdict, said(defective).join("\n")).toBe("FAIL");
    expect(says(defective, "lib/compliance.ts:3")).toBe(true);
    expect(says(defective, "#597")).toBe(true);
    expect(says(defective, "absent, errored and clean come back as one value")).toBe(true);
  });

  test("AC-6/#597 control: the same file routed through lib/tool-probe.ts reports no violation", () => {
    const root = scratchDir("597-ok");
    put(
      root,
      join("lib", "compliance.ts"),
      `import { probeExternalTool } from "./tool-probe";\n` +
        `export function checkToolAvailable(tool: string): boolean {\n` +
        `  return probeExternalTool(tool, ["--version"]).available;\n` +
        `}\n`,
    );
    const repaired = probeHonesty(root);
    expect(repaired.violations, said(repaired).join("\n")).toEqual([]);
    expect(repaired.verdict).toBe("PASS");
  });

  test("AC-6/#597: the collapse itself — absent and errored are two outcomes, measured by running the probe", () => {
    // The half a source scan cannot see. The three conditions are a
    // nonexistent binary, a command that exits 3, and a command that succeeds
    // — none of them an external tool whose installation state can move under
    // the case.
    const outcomes = probeExternalToolOutcomes();
    expect(outcomes).toEqual(["absent", "errored", "available"]);
    expect(new Set(outcomes).size, "the probe reports one value for three conditions, which is #597").toBe(3);
  });
});

// ── AC-6 category 5: #530 ───────────────────────────────────────────────────

/** Twelve declared fields, which is above `declaredFields`' vacuity floor. */
const SCHEMA_530_FIELDS = [
  "issue",
  "phase",
  "slug",
  "repo",
  "branch",
  "acs",
  "gates",
  "agents",
  "artifacts",
  "suiteMeasurement",
  "environments",
  "security",
];

/**
 * The #530 tree: a consumer reading a field, a schema that never declared it,
 * and a state file on disk that carries it anyway.
 *
 * `declared` is the schema's field list, so the control adds one name and
 * changes nothing else.
 */
function tree530(declared: string[]): string {
  const root = scratchDir("530");
  put(
    root,
    join("gates", "schema.ts"),
    `import { z } from "zod";\n\nexport const WorkflowStateSchema = z.object({\n` +
      declared.map(f => `  ${f}: z.any(),\n`).join("") +
      `}).passthrough();\n`,
  );
  // The consumer. It must mention workflow-state.json to be a state-touching
  // file at all, and it mentions every declared name so the orphan reading —
  // a different violation class — stays out of this case's way.
  put(
    root,
    join("lib", "suite-currency.ts"),
    `// Reads workflow-state.json.\n` +
      `// Fields this module knows about: ${declared.join(", ")}.\n` +
      `export function suiteCurrency(sf: (p: string) => unknown) {\n` +
      `  return sf("testsSha") ?? "UNRECORDED";\n` +
      `}\n`,
  );
  // The artifact everyone reaches for as ground truth, which always agrees:
  // `writeWorkflowState` parses with `.passthrough()` and writes the ORIGINAL
  // object, so an undeclared key persists and reads back exactly like a
  // declared one.
  put(root, "workflow-state.json", JSON.stringify({ issue: 530, testsSha: "deadbeef" }, null, 2));
  return root;
}

describe("#637 AC-6 category 5: field reachability catches #530", () => {
  test("AC-6/#530: a consumer reading a field the schema never declared is a violation", () => {
    const root = tree530(SCHEMA_530_FIELDS);
    const defective = fieldReachability(root);

    expect(defective.coverage.examined, JSON.stringify(defective, null, 2)).toBeGreaterThan(0);
    expect(defective.verdict, said(defective).join("\n")).toBe("FAIL");
    expect(says(defective, "a consumer reads a field the schema does not declare: testsSha")).toBe(true);
  });

  test("AC-6/#530: the ARTIFACT answers yes to the same question, which is why the check reads the schema", () => {
    // The instrument you reach for cannot see it. A round trip through the
    // state file confirms any field you ask it about, because you put it
    // there — so a reading taken off the JSON is the question restated.
    const root = tree530(SCHEMA_530_FIELDS);
    const artifact = JSON.parse(readFileSync(join(root, "workflow-state.json"), "utf-8")) as Record<string, unknown>;

    expect(artifact.testsSha, "the fixture does not reproduce #530's artifact at all").toBe("deadbeef");
    // Opposite answers over one tree, in one case, which is the whole of #530.
    expect(fieldReachability(root).verdict).toBe("FAIL");
  });

  test("AC-6/#530 control: declaring the field in the schema clears exactly that violation", () => {
    const repaired = fieldReachability(tree530([...SCHEMA_530_FIELDS, "testsSha"]));
    expect(repaired.violations, said(repaired).join("\n")).toEqual([]);
    expect(repaired.verdict).toBe("PASS");
  });
});

// ── AC-6 category 6: #624 ───────────────────────────────────────────────────

/**
 * The #624 tree, which has to be a real git repository: the category asks
 * `git ls-files` what is tracked, and a hand-written list would be the
 * artifact-that-always-agrees shape (#530) one category over.
 *
 * `managed` is the body of `.claude/rules/harness-managed.md`'s table, so the
 * control adds one row and changes nothing else.
 */
function tree624(managed: string[]): string {
  const root = scratchDir("624");
  put(
    root,
    join(".claude", "rules", "harness-managed.md"),
    `| File | Strategy |\n|---|---|\n` + managed.map(f => `| \`${f}\` | regenerate |\n`).join(""),
  );
  // The writer #624 is about: reinforcement lines into an agent brief, and
  // nothing commits them, so every reinforcement the learning loop ever made
  // was discarded with the worktree.
  put(
    root,
    join("lib", "compliance-report.ts"),
    `import { writeFileSync } from "fs";\n` +
      `export function writeBriefRules(root: string, rules: string): void {\n` +
      `  const brief = join(root, ".claude", "agents", "marcus.md");\n` +
      `  writeFileSync(brief, rules);\n` +
      `}\n`,
  );
  put(root, join(".claude", "agents", "marcus.md"), "# Marcus\n");
  put(root, "CODE-MAP.md", "# map\n");
  execFileSync("git", ["-C", root, "init", "-q"], { encoding: "utf-8" });
  execFileSync("git", ["-C", root, "add", "-A"], { encoding: "utf-8" });
  return root;
}

/** The #624 violation, by the property rather than by a count. */
const UNACCOUNTED_624 = "lib/compliance-report.ts → .claude";

describe("#637 AC-6 category 6: write accountability catches #624", () => {
  test("AC-6/#624: a writer of a tracked brief that nothing commits, reverts or declares is a violation", () => {
    const defective = writeAccountability(tree624(["CODE-MAP.md"]));

    expect(defective.coverage.visible, JSON.stringify(defective, null, 2)).toBeGreaterThan(0);
    expect(defective.verdict, said(defective).join("\n")).toBe("FAIL");
    // Membership, not a count. The both-directions ratchet over
    // `KNOWN_UNDECLARED_WRITES` also fires on any tree that is not this
    // repository, so the number here is about the fixture and the NAME is
    // about #624 (#532: ask whether the defect changes the number or only the
    // membership).
    expect(says(defective, UNACCOUNTED_624)).toBe(true);
    expect(says(defective, "#624")).toBe(true);
    expect(says(defective, "nothing commits it, reverts it, or declares it")).toBe(true);
  });

  test("AC-6/#624 control: declaring the destination in harness-managed.md clears exactly that violation", () => {
    const repaired = writeAccountability(tree624(["CODE-MAP.md", ".claude"]));

    // The specific violation is gone. The ratchet entries are still there,
    // because this is not the repository they were measured on — asserting an
    // empty list here would be an assertion about the fixture, not about #624.
    expect(said(repaired).some(s => s.includes(UNACCOUNTED_624))).toBe(false);
    expect(repaired.sites.map(s => `${s.site} ${s.value}`)).toContain(
      `${UNACCOUNTED_624} declared in harness-managed.md`,
    );
    // …and the control is a control: the reading is not empty, so "no #624
    // violation" is a statement about a scan that ran.
    expect(repaired.violations.length, "the repaired tree reported nothing at all").toBeGreaterThan(0);
  });

  test("AC-6/#624: this repository reports no unaccounted writer", () => {
    const here = writeAccountability(REPO_ROOT);
    expect(here.violations, said(here).join("\n")).toEqual([]);
    expect(here.verdict).toBe("PASS");
  });
});

// ── AC-8: one named binding ─────────────────────────────────────────────────

/**
 * A tree holding declarations, for `parityBindingViolations` to read.
 *
 * Each case below supplies ONE source file and varies ONE thing, so each
 * reaches exactly one violation class. A fixture that varied two would be red
 * under either and would measure neither (#585).
 */
function parityTree(label: string, files: Record<string, string>): string {
  const root = scratchDir(label);
  for (const [relative, text] of Object.entries(files)) put(root, relative, text);
  return root;
}

const GOOD_PARITY_SOURCE = `export function contractParity(root: string) {\n  return { root };\n}\n`;

describe("#637 AC-8: the contract-parity binding has one name and one home", () => {
  test("AC-8: this repository declares `contractParity` exactly once across lib, scripts, gates and workflows", () => {
    expect(parityBindingViolations(REPO_ROOT)).toEqual([]);

    // The instrument, read before the verdict is believed: a scan that matched
    // nothing reports the same empty list as a tree in order.
    const declared = declarationsNaming(REPO_ROOT, "parity").filter(d => d.exported);
    expect(declared.filter(d => d.name === PARITY_BINDING).map(d => d.file)).toEqual(["scripts/contract-parity.ts"]);
    expect(declared.length, "the scan found no exported parity declarations at all").toBeGreaterThan(5);
    // The control string: this repository has a `preflight` family that cannot
    // all have vanished, so a zero here is an absent instrument rather than an
    // absent problem (#646, #657).
    //
    // A FLOOR, not an equality, and the distinction cost a red on #637's own
    // rebase. The first draft asserted exactly 7, which is a number any
    // unrelated PR can move — #721 added `actionPinParity` and took the parity
    // count from 12 to 13 while this case was in flight. A control whose
    // margin is set by something outside the fixture stops witnessing the day
    // someone else edits a file it does not name (#507). What the control has
    // to establish is that the scan READ something, and a floor says that.
    expect(
      declarationsNaming(REPO_ROOT, FOREIGN_PARITY_WORD).length,
      "the scan found no `preflight` declaration in a tree that has a family of them",
    ).toBeGreaterThan(4);
  });

  test("AC-8: the DUPLICATE_PARITY_BINDING decider — a second declaration of the same name", () => {
    // For the duplicate decider only. `contractParity` exists in both files
    // and nothing else about the tree differs from the control.
    const root = parityTree("ac8-duplicate", {
      "scripts/contract-parity.ts": GOOD_PARITY_SOURCE,
      "workflows/ship.js": `export function contractParity(root) {\n  return { root };\n}\n`,
    });
    const violations = parityBindingViolations(root);

    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toStartWith("DUPLICATE_PARITY_BINDING:");
    expect(violations[0]).toContain("scripts/contract-parity.ts:1");
    expect(violations[0]).toContain("workflows/ship.js:1");
  });

  test("AC-8: the duplicate decider survives the CHEAPEST wrong fix — dropping `export`", () => {
    // Still the duplicate decider, on the one input that separates the
    // property from AC-8's wording. The symptom of a duplicate is a red
    // DUPLICATE_PARITY_BINDING, and the 5pm repair is to delete one word from
    // the second declaration: `export` goes, a check reading only exported
    // symbols goes green, and the tree still holds two deciders answering one
    // question — each still called from inside its own module, and a mutation
    // of either still leaves the other holding every case up.
    //
    // This case is the protection. The three cases around it survive that
    // repair VACUOUSLY — none of their fixtures contains an unexported
    // duplicate, so none of them changes verdict — and a vacuous survival is
    // not coverage.
    const root = parityTree("ac8-wrong-fix", {
      "scripts/contract-parity.ts": GOOD_PARITY_SOURCE,
      "workflows/ship.js": `function contractParity(root) {\n  return { root };\n}\n`,
    });
    const violations = parityBindingViolations(root);

    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toStartWith("DUPLICATE_PARITY_BINDING:");
    expect(violations[0]).toContain("workflows/ship.js:1");
    // The second declaration really is unexported, so this case cannot be
    // satisfied by the exported-only reading it exists to outlive.
    const declared = declarationsNaming(root, "parity").filter(d => d.name === PARITY_BINDING);
    expect(declared.map(d => d.exported)).toEqual([true, false]);
  });

  test("AC-8: the PREFLIGHT_NAMED_PARITY decider — a parity binding wearing the other word", () => {
    // For the preflight-naming decider only. `contractParity` is present and
    // singular, so neither of the other two classes can reach this input.
    const root = parityTree("ac8-preflight", {
      "scripts/contract-parity.ts": GOOD_PARITY_SOURCE,
      "lib/preflight-parity.ts": `export const preflightParity = (root: string) => ({ root });\n`,
    });
    const violations = parityBindingViolations(root);

    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toStartWith("PREFLIGHT_NAMED_PARITY:");
    expect(violations[0]).toContain("lib/preflight-parity.ts:1");
    // The reason, which is #626's own argument: two unrelated things already
    // wear the word.
    expect(violations[0]).toContain("lib/release-preflight.ts");
  });

  test("AC-8: the UNMEASURED_PARITY_SCAN decider — a scan that found no binding at all", () => {
    // For the instrument decider only. An empty violation list over a tree
    // with no `contractParity` in it is indistinguishable from a tree in
    // order, which is how a regex that stopped matching becomes a green check.
    const root = parityTree("ac8-unmeasured", {
      "scripts/something-else.ts": `export function somethingElse() {\n  return 1;\n}\n`,
    });
    const violations = parityBindingViolations(root);

    expect(violations.length, violations.join("\n")).toBe(1);
    expect(violations[0]).toStartWith("UNMEASURED_PARITY_SCAN:");
    expect(violations[0]).toContain(PARITY_BINDING);
    // A refusal that says only "nothing found" cannot be acted on: it must say
    // what it DID see, or a renamed binding and a broken scan read the same.
    expect(violations[0]).toContain("0 parity declaration(s)");
  });

  test("AC-8: the three classes are three, and no input reaches two of them", () => {
    // The matrix's own trap (#652): three cells green everywhere looks the
    // same whether each cell witnesses its class or merely sits beside it.
    const classes = [
      parityBindingViolations(
        parityTree("ac8-m1", {
          "scripts/a.ts": GOOD_PARITY_SOURCE,
          "lib/b.ts": GOOD_PARITY_SOURCE,
        }),
      ),
      parityBindingViolations(
        parityTree("ac8-m2", {
          "scripts/a.ts": GOOD_PARITY_SOURCE,
          "lib/b.ts": `export function preflightParity() {}\n`,
        }),
      ),
      parityBindingViolations(parityTree("ac8-m3", { "scripts/a.ts": `export function nothing() {}\n` })),
    ];
    expect(classes.map(v => v.length)).toEqual([1, 1, 1]);
    expect(classes.map(v => v[0].split(":")[0])).toEqual([
      "DUPLICATE_PARITY_BINDING",
      "PREFLIGHT_NAMED_PARITY",
      "UNMEASURED_PARITY_SCAN",
    ]);
  });

  test("AC-8: `contractParity` is not spelled preflight anywhere the scan can see", () => {
    // The naming half of AC-8, asserted separately from the count half. One
    // assertion carrying both questions goes green under half a repair (#484).
    const parity = declarationsNaming(REPO_ROOT, "parity");
    // A loop over an empty list passes no matter what it asserts. The battery
    // found this one: with `declarationsNaming` short-circuited to `[]` this
    // case stayed GREEN, which is the third shape — an assertion that holds
    // vacuously — sitting inside a file about assertions that hold vacuously.
    expect(parity.length, "the scan found no parity declarations, so this loop asserts nothing").toBeGreaterThan(5);
    for (const d of parity) {
      expect(d.name.toLowerCase(), `${d.file}:${d.line}`).not.toContain(FOREIGN_PARITY_WORD);
    }
    expect([...PARITY_SCAN_DIRS]).toEqual(["lib", "scripts", "gates", "workflows"]);
  });
});

// ── AC-9: the comparisons are importable library modules ────────────────────

describe("#637 AC-9: the moved copy is #735's code, not the pre-shard code", () => {
  /**
   * A relocation is a copy until something holds it to the original's
   * BEHAVIOUR (#484). These cases exist because of what the rebase onto
   * `c664837a` could have silently done: this module was taken out of
   * `scripts/contract-parity.ts` before #735 sharded CI, so resolving that
   * conflict by keeping my side wholesale would have compiled, passed every
   * case in this file, and reverted #735 with nothing to show it.
   *
   * Nothing above can see that. Every other fixture here writes a
   * single-job `ci.yml`, which the pre-shard and post-shard readers agree on
   * exactly — the precondition every fixture held fixed (#492), and these are
   * the fixtures built to not meet it.
   */
  const MATRIX_CI = [
    "name: CI",
    "",
    "jobs:",
    "  test-shard:",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    "        shard: [1, 2, 3, 4]",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: bun install",
    "      - run: bun test --shard=${{ matrix.shard }}/4",
    "  test:",
    "    needs: test-shard",
    "    steps:",
    "      - run: echo aggregate",
    "",
  ].join("\n");

  test("AC-9/#735: a matrix ci.yml is read from `test-shard`, not from the aggregate `test`", () => {
    // Under a matrix the job named `test` runs no tests at all. A reader that
    // only knows `test` reports that CI names no test command — which is what
    // turned #621's agreement check red on the first sharded run, correctly.
    expect(suiteJobName(MATRIX_CI)).toBe("test-shard");
    const named = testCommandsNamedByCiWorkflow(MATRIX_CI);
    expect(named.map(c => c.command)).toEqual(["bun test"]);

    // The control, varying exactly one thing: the same file without the
    // matrix job resolves the ordinary name and still reads a command.
    const single = MATRIX_CI.replace("  test-shard:", "  other-shard:").replace(
      "    needs: test-shard",
      "    needs: other-shard",
    );
    expect(suiteJobName(single)).toBe("test");
    expect(testCommandsNamedByCiWorkflow(single).map(c => c.command)).toEqual(["echo aggregate"]);
  });

  test("AC-9/#735: `--shard=N/M` compares equal to the unsharded command; `--parallel` does not", () => {
    // The shard selector is a CI PARTITION, not a different command — it runs
    // a quarter of the FILES, not the files differently. Stripping it is what
    // lets AGENTS.md keep the spelling a human copies to run the suite
    // locally, which is the cheapest wrong fix #735 names and declines.
    const sharded = testCommandsNamedByCiWorkflow(MATRIX_CI)[0].command;
    const plain = testCommandsNamedByCiWorkflow(
      MATRIX_CI.replace(" --shard=${{ matrix.shard }}/4", ""),
    )[0].command;
    expect(sharded).toBe(plain);

    // …and the stripping is narrow. A genuinely different command still
    // disagrees, which is the half that stops this reading as "any CI flag is
    // noise" — #621's whole property is that one command is named everywhere.
    const parallel = testCommandsNamedByCiWorkflow(
      MATRIX_CI.replace("bun test --shard=${{ matrix.shard }}/4", "bun test --parallel"),
    )[0].command;
    expect(parallel).toBe("bun test --parallel");
    expect(parallel).not.toBe(plain);

    // A shard selector in the MIDDLE is not a trailing partition and is left
    // alone, and a command that differs before the flag still differs.
    const differsBefore = testCommandsNamedByCiWorkflow(
      MATRIX_CI.replace("bun test --shard=${{ matrix.shard }}/4", "bun run ci --shard=2/4"),
    )[0].command;
    expect(differsBefore).toBe("bun run ci");
    expect(differsBefore).not.toBe(plain);
  });

  test("AC-9/#735: the suite-job rule is declared once, and this module asks rather than copies", () => {
    // Two readers that agree today are one decider too many, which is why
    // #735 exported `suiteJobName` instead of letting contract-parity carry
    // its own. The move did not add a third: the import travelled with the
    // function, so the script no longer names it at all.
    const declarations = execFileSync(
      "grep",
      ["-rno", "function suiteJobName(", ...PARITY_SCAN_DIRS.map(d => join(REPO_ROOT, d))],
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n");
    expect(declarations.length, declarations.join("\n")).toBe(1);
    expect(declarations[0]).toContain("/lib/ci-checkout.ts:");

    const moved = readFileSync(join(REPO_ROOT, "lib", "test-command-positions.ts"), "utf-8");
    expect(moved).toContain('import { suiteJobName } from "./ci-checkout";');
    // The rule itself must NOT be restated here. A QUOTED `test-shard` in
    // this module would be the second decider #735 declined to write. The
    // word in prose is not — this module explains where the rule lives, and
    // a check that forbade saying so would be satisfied by deleting the
    // explanation. The control for that distinction: the prose IS there.
    expect(moved).toContain("`test-shard` under a matrix");
    expect(moved).not.toContain('"test-shard"');
    expect(moved).not.toContain("'test-shard'");
  });

  test("AC-9: the category-one extractors are declared in lib/ and nowhere else", () => {
    const moved = [
      "testCommandsNamedByAgentsMd",
      "testCommandNamedByAgentsWorkflow",
      "testCommandsNamedByConfig",
      "testCommandsNamedByCiWorkflow",
      "testCommandAgreement",
      "commandDisagreement",
    ];
    for (const name of moved) {
      const declarations = execFileSync(
        "grep",
        ["-rno", `export function ${name}(`, ...PARITY_SCAN_DIRS.map(d => join(REPO_ROOT, d))],
        { encoding: "utf-8" },
      )
        .trim()
        .split("\n");
      expect(declarations.length, `${name}:\n${declarations.join("\n")}`).toBe(1);
      expect(declarations[0], `${name} is not in lib/`).toContain("/lib/test-command-positions.ts:");
    }
  });

  test("AC-9: category two's reader sits beside its generator in lib/bun-version.ts", () => {
    const declarations = execFileSync(
      "grep",
      ["-rno", "export function setupBunDeclarations(", ...PARITY_SCAN_DIRS.map(d => join(REPO_ROOT, d))],
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n");
    expect(declarations.length, declarations.join("\n")).toBe(1);
    expect(declarations[0]).toContain("/lib/bun-version.ts:");
  });

  test("AC-9: the existing suites import the comparisons from lib/, not through the script", () => {
    const consumers = [
      "test/test-command-agreement.test.ts",
      "test/ci-global-tools.test.ts",
      "test/contract-parity.test.ts",
    ];
    for (const file of consumers) {
      const text = readFileSync(join(REPO_ROOT, file), "utf-8");
      expect(text, `${file} does not import the moved module at all`).toContain("../lib/test-command-positions");
      // The import must be an import. A comment naming the path satisfies the
      // line above, which is why the module is also CALLED — asserted by the
      // suites themselves, which is why they are run beside this one.
      expect(/^import[\s\S]*?from "\.\.\/lib\/test-command-positions";/m.test(text), `${file}`).toBe(true);
    }
  });

  test("AC-9: the moved bindings behave identically to what the script used to hold", () => {
    // The move is only safe if the behaviour travelled with it. Driven over
    // the live tree's own three files, which is the input the script read.
    const agreement = testCommandAgreement(REPO_ROOT);
    expect(agreement.violations).toEqual([]);
    expect(agreement.commands.length).toBeGreaterThan(2);
    expect(testCommandsNamedByAgentsMd(readFileSync(join(REPO_ROOT, AGENTS_MD), "utf-8"))[0].command).toBe("bun test");
    expect(testCommandsNamedByCiWorkflow(readFileSync(join(REPO_ROOT, CI_YML), "utf-8"))[0].command).toBe("bun test");
    expect(
      testCommandsNamedByConfig(readFileSync(join(REPO_ROOT, CONFIG_JSON), "utf-8")).map(c => c.where),
    ).toContain("test.command");
  });
});
