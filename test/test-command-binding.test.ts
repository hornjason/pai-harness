/**
 * Covers SC-1904..SC-1907 (HARNESS-STANDARD.md), #488.
 *
 * `createCiWorkflows` emitted `- run: bun test` while `harness` was in
 * scope and three of its siblings read `harness?.ci?.*` four lines above.
 * Every other consumer of `dev.testCmd` honoured it, so a consumer who set
 * the field got agent briefs, an AGENTS.md row and a ship workflow using
 * their command, and a CI workflow using a different one.
 *
 * The issue's SC-2 is the one that shapes this file: the CI step and the
 * AGENTS.md row must resolve through ONE binding, because two sites that
 * agree today are one decider too many and no behavioural test can tell
 * them apart. So every case below drives `testCommandDecision` or the real
 * generators, and SC-1906 asserts that short-circuiting the binding moves
 * BOTH outputs — the property a pair of agreeing literals cannot have.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DEFAULT_TEST_COMMAND, testCommandDecision } from "../lib/test-command";
import { createCiWorkflows, generateAgentsMdContent } from "../lib/scaffold/steps";
import { readFileSync } from "fs";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function project(opts: { testCmd?: string; script?: string; pkg?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "test-cmd-488-"));
  roots.push(root);
  if (opts.pkg !== false) {
    const scripts = opts.script === undefined ? {} : { test: opts.script };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts }));
  }
  if (opts.testCmd !== undefined) {
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ project: "demo", dev: { testCmd: opts.testCmd } }),
    );
  }
  return root;
}

/** The `run:` line of the generated CI test job, by generating it. */
function ciTestStep(root: string): string {
  createCiWorkflows(root, [], { force: true });
  const yml = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8");
  const job = yml.slice(yml.indexOf("  test:"));
  const runs = job.split("\n").filter(l => /^\s+- run: /.test(l)).map(l => l.replace(/^\s+- run: /, ""));
  // `bun install` is always first and is not the test step.
  return runs.filter(r => r !== "bun install")[0] ?? "";
}

describe("#488: one binding decides the test command", () => {
  test("SC-1904: the generated CI job runs the consumer's dev.testCmd", () => {
    const root = project({ testCmd: "bun test --coverage" });
    expect(testCommandDecision(root).command).toBe("bun test --coverage");
    expect(ciTestStep(root), "CI still runs its own command over the operator's")
      .toBe("bun test --coverage");
  });

  test("SC-1905: a consumer declaring neither still gets bun test", () => {
    // SC-3 of the issue: the default is unchanged for every existing
    // consumer. Without this row the fix is free to redefine the default
    // while satisfying everything above.
    const bare = project({ pkg: false });
    expect(testCommandDecision(bare).command).toBe(DEFAULT_TEST_COMMAND);
    expect(ciTestStep(bare)).toBe("bun test");

    // …and a package.json with no `test` script is the same answer by a
    // different route, which is the rung most likely to be dropped.
    const noScript = project({});
    expect(testCommandDecision(noScript).source).toBe("default");
    expect(ciTestStep(noScript)).toBe("bun test");

    // The middle rung, verbatim and NOT `bun run test`: that spelling
    // fires pre/post hooks, which on this repo means CI running
    // sync-sc-status and writing to the tree.
    const scripted = project({ script: "vitest run" });
    expect(testCommandDecision(scripted)).toMatchObject({
      command: "vitest run",
      source: "package-script",
    });
    expect(ciTestStep(scripted)).toBe("vitest run");

    // And config beats the script, or the ladder is in the wrong order.
    const both = project({ testCmd: "bun test --bail", script: "vitest run" });
    expect(testCommandDecision(both).command).toBe("bun test --bail");
  });

  test("SC-1906: the CI step and the AGENTS.md row move together", () => {
    // SC-2 of the issue, and the only shape that can witness it. Two sites
    // holding the same literal pass every assertion above; what a shared
    // binding has that a coincidence does not is that ONE value changes
    // both outputs.
    const root = project({ testCmd: "bun test --coverage --bail" });
    const agentsMd = generateAgentsMdContent(root, "code", []);
    expect(agentsMd, "AGENTS.md does not document the operator's test command")
      .toContain("bun test --coverage --bail");
    expect(ciTestStep(root)).toBe("bun test --coverage --bail");

    // The INSTRUMENT: the string has to be one neither site would produce
    // on its own, or both could be printing a hardcoded default that
    // happens to match.
    expect("bun test --coverage --bail").not.toBe(DEFAULT_TEST_COMMAND);
    // …and the second value, because a single value cannot distinguish
    // "reads the binding" from "echoes whatever the fixture wrote last".
    const other = project({ testCmd: "make check" });
    expect(generateAgentsMdContent(other, "code", [])).toContain("make check");
    expect(ciTestStep(other)).toBe("make check");
  });

  test("SC-1907: a malformed package.json loses the scan, not the command", () => {
    // The scaffold must not die on a file it only consulted for a default.
    const root = mkdtempSync(join(tmpdir(), "test-cmd-488-bad-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(testCommandDecision(root)).toMatchObject({
      command: DEFAULT_TEST_COMMAND,
      source: "default",
    });
  });
});
