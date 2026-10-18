/**
 * Covers AC-1, AC-2, AC-3, AC-4, AC-5, AC-10 (#626).
 *
 * Twelve defects in one session were one shape: **a producer and a consumer
 * that must agree, with nothing comparing them.** `scripts/contract-parity.ts`
 * is the thing that compares them, and this file is what stops it becoming a
 * line in a report.
 *
 * ## What the cases here are guarding against
 *
 * A check that reads N positions and compares what it found is satisfied by
 * finding nothing in all N — zero strings are trivially all equal. That is the
 * third shape in `.claude/rules/checks-must-be-able-to-fail.md`, and it is how
 * a parity check dies: a template edit moves a table row, the regex stops
 * matching, and a category that now examines two of its six positions reports
 * exactly the same `PASS` as one that examined all six.
 *
 * So two properties are asserted here that no verdict can carry on its own:
 *
 *  - **Coverage is part of the reading.** `6/6` and `2/6` are distinguishable
 *    in the output (AC-3). `36/426` and `426/426` reading as one PASS is the
 *    defect that rule names by number.
 *  - **A comparison that could not be performed is UNMEASURED, never PASS**
 *    (AC-4) — and the three ways it fails to be performed stay three things:
 *    an absent file, an unparseable one, and a declared source that cannot be
 *    resolved. A corrupt config is never a missing config
 *    (`.claude/rules/config-access.md`).
 *
 * ## Why AC-5 runs against an exported tree
 *
 * Command parity is green on this repository today, and a check that has only
 * ever been green over the tree it ships with is a check whose ability to fail
 * is an assertion about the author's intent. `0357c06c` is the commit that
 * made the three files agree, so its parent is a real tree — not a fixture —
 * in which they do not. The same binding is run over both.
 *
 * ## Why the timeouts are declared
 *
 * AC-2 asserts a full run finishes under sixty seconds. Bun's per-test default
 * is 5000ms and is declared nowhere, so a sixty-second assertion written
 * without saying so is a case that can only ever be killed by the thing
 * measuring it — which is #550 exactly (`lib/gate-timeouts.ts`). The budget and
 * the timeout around it are two named constants here, and their ordering is
 * itself a case.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  AGENTS_MD,
  CI_YML,
  CONFIG_JSON,
  PARITY_CATEGORIES,
  REFUSE_EXIT,
  commandParity,
  contractParity,
  fieldReachability,
  parityExitCode,
  probeExternalToolOutcomes,
  probeHonesty,
  toolchainParity,
  transportParity,
  writeAccountability,
  type CategoryReport,
} from "../scripts/contract-parity";
import { TOOL_PROBE_OUTCOMES, probeExternalTool } from "../lib/tool-probe";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * The budget AC-2 measures a full run against, and the per-test timeout it
 * sits inside.
 *
 * Each layer must strictly outlive the one inside it — `lib/gate-timeouts.ts`
 * is the same rule for the gate run's three layers, and the reason it exists
 * is that `tsc-pass` spent months unable to pass because a 240000ms spawn sat
 * inside a 5000ms test.
 */
export const CONTRACT_PARITY_BUDGET_MS = 60_000;
export const PARITY_TEST_TIMEOUT_MS = 180_000;
setDefaultTimeout(PARITY_TEST_TIMEOUT_MS);

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `contract-parity-626-${label}-`));
  scratch.push(dir);
  return dir;
}

function put(root: string, relative: string, text: string): void {
  const dest = join(root, relative);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
}

/** An AGENTS.md carrying the Commands table row, and optionally the Workflow line. */
function agentsMd(command: string, opts?: { workflowLine?: boolean }): string {
  return (
    `# demo\n\n## Commands\n\n| Action | Command |\n|---|---|\n` +
    `| Test | \`${command}\` |\n| Type check | \`bun run typecheck\` |\n` +
    (opts?.workflowLine === false ? "\n" : `\n## Workflow\n- **Test:** \`${command}\`\n`)
  );
}

function ciYml(command: string, bunVersion?: string): string {
  const setup =
    bunVersion === undefined
      ? ""
      : `      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "${bunVersion}"\n`;
  return `name: CI\n\njobs:\n  test:\n    runs-on: "ubuntu-latest"\n    steps:\n      - uses: actions/checkout@v4\n${setup}      - run: bun install\n      - run: ${command}\n      - run: bun run typecheck\n`;
}

/** A tree in which all six command-parity positions name a command. */
function treeNamingSixPositions(command = "bun test"): string {
  const root = scratchDir("six");
  put(root, AGENTS_MD, agentsMd(command));
  put(root, CONFIG_JSON, JSON.stringify({ project: "demo", test: { command }, dev: { testCmd: command } }, null, 2));
  put(root, CI_YML, ciYml(command));
  put(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: command } }, null, 2));
  return root;
}

/**
 * A tree in which only two of the six positions name anything.
 *
 * No rungate config at all, no Workflow line, and no package.json — so the two
 * config fields and the generator's own answer have nothing to say. The point
 * of the fixture is the COVERAGE, which is why it is not simply a smaller
 * check: the two positions it does read agree with each other.
 */
function treeNamingTwoPositions(command = "bun test"): string {
  const root = scratchDir("two");
  put(root, AGENTS_MD, agentsMd(command, { workflowLine: false }));
  put(root, CI_YML, ciYml(command));
  return root;
}

function named(report: CategoryReport, fragment: string): boolean {
  return [...report.violations, ...report.unmeasured.map(u => u.reason)].some(s => s.includes(fragment));
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [join(REPO_ROOT, "scripts", "contract-parity.ts"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: PARITY_TEST_TIMEOUT_MS,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe("#626 AC-1: one command, six category verdicts, and an exit code that follows them", () => {
  test("AC-1: the run reports a verdict for each of the six parity categories", () => {
    const report = contractParity(REPO_ROOT);

    expect(report.categories.map(c => c.category)).toEqual([...PARITY_CATEGORIES]);
    expect(report.categories.length).toBe(6);
    for (const c of report.categories) {
      expect(["PASS", "FAIL", "UNMEASURED"], `${c.category} reported ${c.verdict}`).toContain(c.verdict);
      // A verdict with no coverage beside it is the reading this issue exists
      // to stop: it cannot be told from a verdict over nothing.
      expect(c.coverage.visible, `${c.category} can see no sites at all`).toBeGreaterThan(0);
      expect(c.coverage.reading).toBe(`${c.coverage.examined}/${c.coverage.visible}`);
    }
  });

  test("AC-1: the exit code is non-zero when any one category reports a violation", () => {
    // Driven over constructed readings rather than over the repository, so the
    // binding is observed on an input where exactly one thing differs. A tree
    // that happens to be clean today cannot witness the red half at all.
    const clean = PARITY_CATEGORIES.map(category => ({
      category,
      title: category,
      verdict: "PASS" as const,
      coverage: { examined: 1, visible: 1, reading: "1/1" },
      sites: [],
      violations: [],
      unmeasured: [],
    }));
    expect(parityExitCode({ root: ".", verdict: "PASS", categories: clean })).toBe(0);

    for (let i = 0; i < clean.length; i++) {
      const one = clean.map((c, j) => (i === j ? { ...c, verdict: "FAIL" as const, violations: ["x"] } : c));
      expect(parityExitCode({ root: ".", verdict: "FAIL", categories: one }), `${clean[i].category} FAIL`).toBe(
        REFUSE_EXIT,
      );
      const un = clean.map((c, j) => (i === j ? { ...c, verdict: "UNMEASURED" as const } : c));
      // UNMEASURED is not a pass. `0`, `{}`, `null` and SKIP are
      // indistinguishable from success; this must not join them.
      expect(parityExitCode({ root: ".", verdict: "UNMEASURED", categories: un }), `${clean[i].category} UNMEASURED`)
        .toBe(REFUSE_EXIT);
    }
  });

  test("AC-1: the CLI prints the six category verdicts and refuses a tree that disagrees", () => {
    const ok = runCli(["--json"]);
    expect((ok.stdout.match(/"category"/g) || []).length, `stdout was:\n${ok.stdout}\n${ok.stderr}`).toBe(6);

    const divergent = scratchDir("cli-divergent");
    put(divergent, AGENTS_MD, agentsMd("bun test"));
    put(divergent, CONFIG_JSON, JSON.stringify({ project: "demo", test: { command: "bun test --parallel" } }));
    put(divergent, CI_YML, ciYml("bun test"));
    const red = runCli(["--json", "--root", divergent, "--category", "command-parity"]);
    expect(red.status, `the CLI accepted a tree whose three files disagree:\n${red.stdout}`).toBe(REFUSE_EXIT);
    expect(red.stdout).toContain("bun test --parallel");
  });
});

// ── AC-2 ────────────────────────────────────────────────────────────────────

describe("#626 AC-2: a full run finishes inside its budget", () => {
  test("AC-2: a full contract-parity run on this repository finishes under 60 seconds", () => {
    const started = Date.now();
    const report = contractParity(REPO_ROOT);
    const elapsed = Date.now() - started;

    // The control: a run that examined nothing is fast and means nothing.
    const examined = report.categories.reduce((n, c) => n + c.coverage.examined, 0);
    expect(examined, "the run examined no sites at all, so its duration measures nothing").toBeGreaterThan(10);
    expect(elapsed, `a full run took ${elapsed}ms`).toBeLessThan(CONTRACT_PARITY_BUDGET_MS);
  });

  test("AC-2: the 60-second budget sits strictly inside the timeout around it", () => {
    // #550: the compiler was allowed four minutes by a call killed after five
    // seconds. Equal is not enough — a measurement killed at the same instant
    // as its budget is a race, and which message you get is not decided here.
    expect(CONTRACT_PARITY_BUDGET_MS).toBeLessThan(PARITY_TEST_TIMEOUT_MS);
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe("#626 AC-3: every verdict carries its own coverage", () => {
  test("AC-3: a six-of-six reading and a two-of-six reading are distinguishable in the output", () => {
    const six = commandParity(treeNamingSixPositions());
    const two = commandParity(treeNamingTwoPositions());

    expect(six.coverage.visible).toBe(6);
    expect(two.coverage.visible).toBe(6);
    expect(six.coverage.examined, `six-of-six examined:\n${JSON.stringify(six.sites, null, 2)}`).toBe(6);
    expect(two.coverage.examined, `two-of-six examined:\n${JSON.stringify(two.sites, null, 2)}`).toBe(2);

    // The claim is about the OUTPUT, not about two numbers a reader has to
    // compute: the rendered reading must differ.
    expect(six.coverage.reading).toBe("6/6");
    expect(two.coverage.reading).toBe("2/6");
    expect(JSON.stringify(six)).not.toBe(JSON.stringify(two));
  });

  test("AC-3: two PASS readings with different coverage do not render the same", () => {
    // The shape `.claude/rules/checks-must-be-able-to-fail.md` names by number:
    // 36/426 and 426/426 are the same PASS today, and no reader can tell them
    // apart from the output.
    // A tree naming the same command in five of the six positions — the sixth
    // (`dev.testCmd`) is simply not declared, which is not a defect and is not
    // a reason to report less than it found.
    const root = treeNamingSixPositions();
    const config = JSON.parse(readFileSync(join(root, CONFIG_JSON), "utf-8")) as Record<string, unknown>;
    delete config.dev;
    writeFileSync(join(root, CONFIG_JSON), JSON.stringify(config, null, 2));
    const five = commandParity(root);
    const six = commandParity(treeNamingSixPositions());

    expect(six.verdict).toBe("PASS");
    expect(five.verdict).toBe("PASS");
    expect(six.coverage.reading).toBe("6/6");
    expect(five.coverage.reading).toBe("5/6");
    // Both PASS; the readings are still told apart by what each examined.
    expect(`${five.verdict} ${five.coverage.reading}`).not.toBe(`${six.verdict} ${six.coverage.reading}`);
  });

  test("AC-3: every category reports sites examined over sites visible", () => {
    const categories = [
      commandParity(REPO_ROOT),
      toolchainParity(REPO_ROOT),
      transportParity(REPO_ROOT),
      probeHonesty(REPO_ROOT),
      fieldReachability(REPO_ROOT),
      writeAccountability(REPO_ROOT),
    ];
    for (const c of categories) {
      expect(c.coverage.examined, `${c.category} examined more than it could see`).toBeLessThanOrEqual(
        c.coverage.visible,
      );
      expect(c.coverage.visible, `${c.category} sees nothing`).toBeGreaterThan(0);
    }
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe("#626 AC-4: a comparison that could not be performed records UNMEASURED", () => {
  test("AC-4: an absent file is UNMEASURED, not a clean reading", () => {
    const root = treeNamingTwoPositions();
    const reading = commandParity(root);

    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.unmeasured.map(u => u.kind)).toContain("absent-file");
    expect(named(reading, CONFIG_JSON), JSON.stringify(reading.unmeasured)).toBe(true);
    // The whole point: two positions naming one string is not agreement over a
    // tree whose third position was never read.
    expect(reading.violations).toEqual([]);
  });

  test("AC-4: an unparseable file is UNMEASURED and is NOT the absent case", () => {
    const root = scratchDir("corrupt");
    put(root, AGENTS_MD, agentsMd("bun test"));
    put(root, CI_YML, ciYml("bun test"));
    put(root, CONFIG_JSON, "{ not json");

    const reading = commandParity(root);
    expect(reading.verdict).toBe("UNMEASURED");
    const kinds = reading.unmeasured.map(u => u.kind);
    expect(kinds, JSON.stringify(reading.unmeasured)).toContain("unparseable-file");
    // `.claude/rules/config-access.md`: a corrupt config is never a missing
    // config, and conflating them is how #70 stayed silent for a month.
    expect(kinds).not.toContain("absent-file");
  });

  test("AC-4: a declared source that cannot be resolved is UNMEASURED", () => {
    const root = scratchDir("unresolved");
    put(root, AGENTS_MD, agentsMd("bun test"));
    put(root, CONFIG_JSON, JSON.stringify({ project: "demo", test: { command: "bun test" } }));
    // The project DOES declare a version, so three positions are read and the
    // reading is not held up by having examined nothing — the unresolved
    // source is the only thing standing between it and PASS. Without that the
    // case would be carried by the empty-reading guard and would stay green
    // under a mutation of the one it is written for.
    put(root, ".bun-version", "1.3.14\n");
    // CI points setup-bun at a declaration file that is not in the tree. What
    // CI installs is therefore unknowable from here — a third thing, and
    // neither of the two above.
    put(
      root,
      CI_YML,
      `name: CI\n\njobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: ".bun-version-ci"\n      - run: bun test\n`,
    );

    const reading = toolchainParity(root, "1.3.14");
    expect(reading.coverage.examined, "nothing was read, so a second guard would carry this case").toBeGreaterThan(0);
    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.unmeasured.map(u => u.kind), JSON.stringify(reading.unmeasured)).toContain("unresolved-source");
    expect(named(reading, ".bun-version-ci")).toBe(true);
    expect(reading.violations).toEqual([]);
  });

  test("AC-4: the three unmeasurable conditions stay three distinct kinds", () => {
    const absent = commandParity(treeNamingTwoPositions());
    const corrupt = (() => {
      const root = scratchDir("corrupt-kinds");
      put(root, AGENTS_MD, agentsMd("bun test"));
      put(root, CI_YML, ciYml("bun test"));
      put(root, CONFIG_JSON, "{ not json");
      return commandParity(root);
    })();
    const unresolved = (() => {
      const root = scratchDir("unresolved-kinds");
      put(root, CI_YML, `jobs:\n  test:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: ".bun-version"\n`);
      return toolchainParity(root, "1.3.14");
    })();

    const kinds = new Set([
      ...absent.unmeasured.map(u => u.kind),
      ...corrupt.unmeasured.map(u => u.kind),
      ...unresolved.unmeasured.map(u => u.kind),
    ]);
    expect([...kinds].sort()).toEqual(["absent-file", "unparseable-file", "unresolved-source"]);
  });
});

// ── AC-5 ────────────────────────────────────────────────────────────────────

const PRE_FIX = "0357c06c^";
const preFixAvailable =
  spawnSync("git", ["-C", REPO_ROOT, "cat-file", "-e", `${PRE_FIX}{commit}`], { encoding: "utf-8" }).status === 0;

/** `git archive` of a commit, extracted into a scratch directory. */
function exportTree(ref: string, label: string): string {
  const root = scratchDir(label);
  const tar = join(root, "tree.tar");
  const archive = spawnSync("git", ["-C", REPO_ROOT, "archive", "--format=tar", "-o", tar, ref], {
    encoding: "utf-8",
  });
  if (archive.status !== 0) throw new Error(`git archive ${ref} failed: ${archive.stderr}`);
  const extract = spawnSync("tar", ["-x", "-f", tar, "-C", root], { encoding: "utf-8" });
  if (extract.status !== 0) throw new Error(`tar -x failed: ${extract.stderr}`);
  rmSync(tar, { force: true });
  return root;
}

describe("#626 AC-5: command parity over the tree that had the #621 defect", () => {
  test.skipIf(!preFixAvailable)(
    "AC-5: the pre-fix tree (before 0357c06c) reports a violation and the current tree reports none",
    () => {
      const before = commandParity(exportTree(PRE_FIX, "pre-fix"));
      const now = commandParity(REPO_ROOT);

      // The instrument first: a reading that extracted nothing from the export
      // would report no violations for a reason that has nothing to do with the
      // tree, and would look exactly like the clean half below.
      expect(before.coverage.examined, "nothing was extracted from the exported tree").toBeGreaterThan(2);
      expect(before.verdict, `the pre-fix tree read clean:\n${JSON.stringify(before, null, 2)}`).toBe("FAIL");
      expect(before.violations.join("\n")).toContain("bun test --parallel --no-isolate");

      expect(now.verdict, `the current tree reports: ${now.violations.join("; ")}`).toBe("PASS");
      expect(now.violations).toEqual([]);
    },
  );
});

// ── AC-10 ───────────────────────────────────────────────────────────────────

describe("#626 AC-10: an external-tool probe has three outcomes, not one", () => {
  test("AC-10: an absent tool, an errored probe and a clean result are three distinct outcomes", () => {
    const absent = probeExternalTool("rungate-no-such-tool-626", ["--version"]);
    const errored = probeExternalTool("sh", ["-c", "exit 3"]);
    const clean = probeExternalTool("sh", ["-c", "echo 1.0.0"]);

    expect(absent.outcome).toBe("absent");
    expect(errored.outcome).toBe("errored");
    expect(clean.outcome).toBe("available");
    expect(new Set([absent.outcome, errored.outcome, clean.outcome]).size).toBe(3);
    expect([...TOOL_PROBE_OUTCOMES].sort()).toEqual(["absent", "available", "errored"]);

    // Each outcome says WHY, because a probe that cannot be acted on is the
    // silent default under another name.
    for (const r of [absent, errored, clean]) expect(r.reason.length).toBeGreaterThan(10);
    expect(absent.reason).toContain("rungate-no-such-tool-626");
    expect(errored.reason).toContain("3");
  });

  test("AC-10: an absent tool and an errored probe are not both reported as 'not available'", () => {
    // The collapse this replaces: `checkToolAvailable` returned `false` for
    // "tool absent", "network timed out" and "tool ran and found nothing"
    // alike, so #597's recurring red CI could not be told from a clean result.
    const absent = probeExternalTool("rungate-no-such-tool-626", ["--version"]);
    const errored = probeExternalTool("sh", ["-c", "exit 3"]);
    expect(absent.outcome).not.toBe(errored.outcome);
    expect(absent.available).toBe(false);
    expect(errored.available).toBe(false);
    // …and the boolean both of them share is exactly what used to be the whole
    // reading, which is why the outcome is the field consumers must look at.
    expect(absent.available).toBe(errored.available);
  });

  test("AC-10: a second probe that asks the question itself is caught, and routing it clears the violation", () => {
    // Paired on purpose: a check that refuses unconditionally satisfies the
    // red half on its own. The green half is the same tree with the same file
    // asking through the one binding.
    const root = scratchDir("raw-probe");
    put(
      root,
      join("lib", "raw.ts"),
      `import { spawnSync } from "child_process";\nexport function hasTool(): boolean {\n  return spawnSync("agnix", ["--version"]).status === 0;\n}\n`,
    );
    const red = probeHonesty(root);
    expect(red.verdict, JSON.stringify(red.sites)).toBe("FAIL");
    expect(red.violations.join("\n")).toContain("lib/raw.ts:3");

    put(
      root,
      join("lib", "raw.ts"),
      `import { probeExternalTool } from "./tool-probe";\nexport function hasTool(): boolean {\n  return probeExternalTool("agnix", ["--version"]).available;\n}\n`,
    );
    const green = probeHonesty(root);
    expect(green.verdict, green.violations.join("; ")).toBe("PASS");
  });

  test("AC-10: probe honesty is measured by running the probe, not by reading it", () => {
    const reading = probeHonesty(REPO_ROOT);
    const outcomes = probeExternalToolOutcomes();

    expect(outcomes.sort()).toEqual(["absent", "available", "errored"]);
    expect(reading.coverage.examined, "the probe binding was never exercised").toBeGreaterThan(0);
    expect(reading.verdict, `probe honesty: ${[...reading.violations, ...reading.unmeasured.map(u => u.reason)].join("; ")}`)
      .toBe("PASS");
  });
});

// ── the categories this file does not otherwise drive ───────────────────────

describe("#626: the remaining categories read a real corpus", () => {
  test("transport parity round-trips a payload full of shell metacharacters", () => {
    const reading = transportParity(REPO_ROOT);
    expect(reading.coverage.examined, "the transport was never exercised").toBeGreaterThan(1);
    expect(reading.verdict, `transport parity: ${reading.violations.join("; ")}`).toBe("PASS");
  });

  /**
   * Transport parity is the only category that EXECUTES the inspected tree —
   * `new Function` over a block sliced out of `<root>/workflows/ship.js`. A
   * security review flagged that `--root` therefore chooses whose code runs,
   * and the first draft answered it with a comment saying "first-party by
   * assumption". This is that assumption made executable.
   *
   * The canary is the point. Asserting UNMEASURED on its own is satisfied by a
   * run that compiled the foreign block, executed it, and then happened to
   * discard the result — so the fixture's block is written to be LOUD if it is
   * ever evaluated: its transports return `CANARY-EXECUTED`, which disagrees
   * with the library and would push a violation and turn the category FAIL.
   * UNMEASURED and an empty site list is the only reading in which nothing ran.
   */
  test("transport parity refuses a foreign root instead of compiling its code", () => {
    const root = scratchDir("foreign-transport");
    put(
      root,
      join("workflows", "ship.js"),
      [
        "// AC-PAYLOAD-TRANSPORT-START",
        "function acPayloadShellArgument() { return 'CANARY-EXECUTED' }",
        "function acPayloadReadExpression() { return 'CANARY-EXECUTED' }",
        "// AC-PAYLOAD-TRANSPORT-END",
        "writeACs({})",
      ].join("\n"),
    );

    const reading = transportParity(root);

    expect(reading.verdict).toBe("UNMEASURED");
    expect(reading.unmeasured.map(u => u.kind)).toContain("unresolved-source");
    expect(named(reading, "is a different tree")).toBe(true);
    // The canary: any of these three means the foreign block was evaluated.
    expect(JSON.stringify(reading)).not.toContain("CANARY-EXECUTED");
    expect(reading.sites).toEqual([]);
    expect(reading.violations).toEqual([]);
    // Coverage still reports what the category CAN see, not what it read —
    // `0/3`, not `0/0`, which would be a refusal hiding behind a full fraction.
    expect(reading.coverage.reading).toBe("0/3");
  });

  test("field reachability and write accountability see more than a handful of sites", () => {
    const fields = fieldReachability(REPO_ROOT);
    const writes = writeAccountability(REPO_ROOT);

    // The control: every assertion a filter over an extracted set makes is
    // satisfied by extracting nothing.
    expect(fields.coverage.examined, "no state-touching files were read").toBeGreaterThan(20);
    expect(writes.coverage.visible, "no tracked-file writers were found").toBeGreaterThan(5);
    expect(fields.verdict, `field reachability: ${fields.violations.join("; ")}`).toBe("PASS");
    expect(writes.verdict, `write accountability: ${writes.violations.join("; ")}`).toBe("PASS");
  });
});
