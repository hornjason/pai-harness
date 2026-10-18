/**
 * Covers SC-1856, SC-1857 (HARNESS-STANDARD.md), #550.
 *
 * `tsc-pass` spawns `bunx tsc --noEmit` with `timeout: 240000`. The `test()`
 * around it took no timeout argument, so it got bun's default 5000ms. The
 * compiler is allowed four minutes by a call that is killed after five
 * seconds, which means **the check could not pass on any project whose
 * typecheck takes longer than that** — which is every project large enough
 * to have a gate run. Observed live: the gate printed
 * `Type check PASS: bunx tsc --noEmit` to its own stdout and recorded FAIL.
 *
 * The 240000 reads as deliberate and was unreachable, and nothing in the
 * suite could say so, because a timeout and a genuine failure are the same
 * red.
 *
 * TWO CHECKS, AND THE SECOND IS THE ONE THAT MATTERS. The first is a fact
 * about the source: the declared default must exceed every subprocess
 * timeout the file can start. The second runs the real check against a real
 * slow spawn, because a source assertion stays true after the mechanism
 * stops working — every source-text assertion in this repo has survived its
 * first mutation.
 *
 * WHY A FILE-LEVEL DEFAULT AND NOT A PER-TEST ARGUMENT. `}, 300000);` on
 * `tsc-pass` is the repair somebody reaches for at 5pm, and it fixes exactly
 * one check: `exec`, `execArgv` and `execArgvOf` each spawn with
 * `timeout: 30000` and are called from dozens of checks, and the next check
 * to spawn inherits nothing. A rule naming one test is a rule the next one
 * evades (.claude/rules/checks-must-be-able-to-fail.md, the fifth shape), so
 * the requirement below is on the file's declared default — which covers a
 * spawning check added tomorrow, without anybody remembering this issue.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  EXEC_TIMEOUT_MS,
  GATE_SUITE_TIMEOUT_MS,
  GATE_TEST_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
  gateTimeoutOrderingViolations,
} from "../lib/gate-timeouts";
// The bunfig reading lives beside the timeout-population check it was
// written for (#621, lib/junit-checks.ts). One owner, one binding to
// mutate — a second parser here would survive any mutation of that one.
import { bunfigTestTimeoutMs } from "../lib/junit-checks";

const REPO_ROOT = join(import.meta.dir, "..");
const GATE_SUITE = join(REPO_ROOT, "gates", "workflow.test.ts");
const GATE_SOURCE = readFileSync(GATE_SUITE, "utf-8");
const EXECUTOR_SOURCE = readFileSync(join(REPO_ROOT, "gates", "gate-executor.ts"), "utf-8");

let SCRATCH = "";
let WORK = "";
let PROJECT = "";

beforeEach(() => {
  SCRATCH = mkdtempSync(join(tmpdir(), "gate-timeouts-"));
  WORK = join(SCRATCH, "work");
  PROJECT = join(SCRATCH, "project");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(join(PROJECT, "node_modules", ".bin"), { recursive: true });
});

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

// ── the ordering ────────────────────────────────────────────────────────────

describe("#550: each layer outlives the process it starts", () => {
  test("SC-1856: the four nested budgets are strictly increasing", () => {
    // Three layers deep, and two of the three orderings were backwards: the
    // compiler was allowed 240000ms by a test allowed 5000ms inside a run
    // allowed 120000ms.
    expect(
      gateTimeoutOrderingViolations({
        exec: EXEC_TIMEOUT_MS,
        typecheck: TYPECHECK_TIMEOUT_MS,
        test: GATE_TEST_TIMEOUT_MS,
        suite: GATE_SUITE_TIMEOUT_MS,
      }),
    ).toEqual([]);
  });

  test("the same function refuses the arrangement #550 was filed about", () => {
    // Performed, not argued. Without this SC-1856 is satisfied by a function
    // that returns [] for every input — and it is driven over VALUES rather
    // than over the constants, so the comparison is not the constants
    // against themselves.
    const asItWas = gateTimeoutOrderingViolations({
      exec: 30_000,
      typecheck: 240_000,
      test: 5_000,
      suite: 120_000,
    });
    // ONE, and the arithmetic is the finding rather than a disappointment.
    // The prediction was 2, on the grounds that the typecheck's 240000 also
    // outlived the suite's 120000 — but the layers are a chain, so
    // `typecheck < test < suite` already says that, and naming it twice
    // would be two deciders answering one question
    // (.claude/rules/checks-must-be-able-to-fail.md). The row that breaks is
    // the innermost one that is wrong, which is where a reader should look.
    expect(asItWas.length, "the live arrangement #550 describes was accepted").toBe(1);
    expect(asItWas[0]).toContain("240000ms inside the test around it's 5000ms");

    // And the transitive case on its own, so the chain is shown to carry it:
    // a correct per-test budget with an outer kill below it.
    const outerTooSmall = gateTimeoutOrderingViolations({
      exec: 30_000,
      typecheck: 90_000,
      test: 120_000,
      suite: 60_000,
    });
    expect(outerTooSmall).toHaveLength(1);
    expect(outerTooSmall[0]).toContain("the gate suite run's 60000ms");
  });

  test("equal is refused, not just greater", () => {
    // A spawn killed at the same instant as its test is a race, and which of
    // the two messages you get is not decided by this repo. The cheapest
    // wrong repair is setting the outer to match the inner.
    expect(
      gateTimeoutOrderingViolations({ exec: 30_000, typecheck: 90_000, test: 90_000, suite: 180_000 }),
    ).toHaveLength(1);
  });

  // ── the constants are the only numbers ─────────────────────────────────

  /**
   * A bare `timeout: 30000` beside the constants is a fourth number nobody
   * compares. The ordering above would stay green over it, which is the
   * whole reason this is a separate row.
   */
  function bareTimeoutLiterals(src: string): string[] {
    return [...src.matchAll(/^.*\btimeout:\s*\d+\s*,.*$/gm)].map(m => m[0].trim());
  }

  test("SC-1862: neither file hardcodes a timeout the ordering cannot see", () => {
    for (const [name, src] of [
      ["gates/workflow.test.ts", GATE_SOURCE],
      ["gates/gate-executor.ts", EXECUTOR_SOURCE],
    ] as const) {
      const bare = bareTimeoutLiterals(src).filter(
        // The gate executor owns timeouts for processes that are not part of
        // this ordering at all — evidence commands, remote fetches, the
        // prove reproducer. Only the gate SUITE spawn is in scope here, and
        // it is the one `runGateTests` makes.
        line => name === "gates/workflow.test.ts",
      );
      expect(bare, `${name} hardcodes a subprocess timeout:\n${bare.join("\n")}`).toEqual([]);
    }
    // The instrument: the regex still finds literals where they do exist, so
    // an empty result above is a fact about the file and not about the regex.
    expect(
      bareTimeoutLiterals(EXECUTOR_SOURCE).length,
      "the literal extraction found nothing anywhere — it has stopped matching",
    ).toBeGreaterThan(0);
    expect(
      bareTimeoutLiterals("x = { timeout: 1234, }"),
      "the extraction does not match a plain literal",
    ).toHaveLength(1);
  });

  test("#621: the per-test default is declared in code, because the bunfig key is inert", () => {
    // MEASURED on bun 1.3.14 by test/test-timeout-population.test.ts, which
    // runs the probe rather than asserting the claim here twice: `[test]
    // timeout` in a bunfig.toml is NOT read by the test runner. The repo's
    // own bunfig declared 30000 while all 112 of #621's timeouts died at
    // 5000.
    //
    // The consequence for THIS file is the whole of #550 restated: the only
    // thing standing between a 90-second typecheck and bun's five-second
    // default is `setDefaultTimeout(GATE_TEST_TIMEOUT_MS)`, asserted below.
    // A bunfig cannot take its place, and `gates/bunfig.toml` must not carry
    // a second declaration of the number — that would be a fifth timeout
    // beside the four the ordering compares, and the ordering cannot see it.
    const gateBunfig = readFileSync(join(REPO_ROOT, "gates", "bunfig.toml"), "utf-8");
    expect(
      bunfigTestTimeoutMs(gateBunfig),
      `gates/bunfig.toml declares a per-test timeout the runner will ignore:\n${gateBunfig}`,
    ).toBeNull();

    // The instrument: the reader finds the root declaration, so the null
    // above is a fact about gates/bunfig.toml and not about a reader that
    // always says no.
    const rootDeclared = bunfigTestTimeoutMs(readFileSync(join(REPO_ROOT, "bunfig.toml"), "utf-8"));
    expect(rootDeclared, "the root bunfig.toml declares no per-test timeout for #621 to read").not.toBeNull();
    // And the gate suite's own budget outlives the repo-wide one. A gate
    // check spawns processes the ordinary suite never does.
    expect(GATE_TEST_TIMEOUT_MS).toBeGreaterThan(rootDeclared!);
  });

  test("the gate suite declares the default, and the executor uses the constant", () => {
    // The wiring, which the ordering cannot see: four correct constants in a
    // file nobody imports is four correct constants.
    expect(GATE_SOURCE, "the gate suite declares no default test timeout")
      .toContain("setDefaultTimeout(GATE_TEST_TIMEOUT_MS)");
    expect(GATE_SOURCE).toContain("timeout: TYPECHECK_TIMEOUT_MS");
    expect(GATE_SOURCE).toContain("timeout: EXEC_TIMEOUT_MS");
    expect(EXECUTOR_SOURCE, "the gate suite run no longer uses the shared constant")
      .toContain("timeout: GATE_SUITE_TIMEOUT_MS");
  });
});

// ── the executed fact ───────────────────────────────────────────────────────

/**
 * A project whose `bunx tsc --noEmit` takes longer than bun's default
 * timeout, and nothing else.
 *
 * `bunx` prefers `./node_modules/.bin`, so a shell script there IS the
 * compiler as far as the check is concerned. Measured: `bunx tsc --noEmit`
 * in such a directory takes the script's sleep and no more.
 *
 * A fixture that made a REAL tsc slow would be a fixture whose running time
 * depends on the machine, and the property under test is not about
 * TypeScript at all — it is that the check outlives the process it starts.
 * The shim makes the one variable that matters exact.
 */
function plantSlowTypecheck(seconds: number): void {
  const bin = join(PROJECT, "node_modules", ".bin", "tsc");
  writeFileSync(bin, `#!/bin/sh\nsleep ${seconds}\nexit 0\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(PROJECT, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ name: "slow-typecheck-fixture" }, null, 2));
}

function plantState(): void {
  writeFileSync(
    join(WORK, "workflow-state.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        issue: 550,
        slug: "pai-harness-550",
        phase: "VERIFY",
        projectRoot: PROJECT,
        treeUnderTest: PROJECT,
        issueGoal: "the check outlives the process it starts",
        sizing: { predicted: "S", ceremonyTier: "STANDARD" },
        acs: [
          {
            id: "AC-1",
            type: "CODE",
            statement: "the typecheck gate survives a slow compiler",
            threshold: { op: "==", value: 0, unit: "errors" },
            evidenceMethod: { type: "COMMAND" },
          },
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * `ran` is not a formality: a `-t` filter that matches nothing leaves bun
 * reporting zero failures, which is indistinguishable from the check passing
 * — and is also what a mutant that failed to resolve its imports looks like.
 */
function runCheck(suitePath: string): { ran: boolean; red: boolean; output: string } {
  const r = spawnSync("bun", ["test", suitePath, "-t", "tsc-pass"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180000,
    env: { ...process.env, TEST_WORK_DIR: WORK },
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const count = (label: string) => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  return { ran: count("pass") + count("fail") === 1, red: count("fail") === 1, output };
}

describe("#550: tsc-pass against a typecheck slower than bun's default", () => {
  test("SC-1857: the check survives a compiler that takes longer than 5s", () => {
    plantSlowTypecheck(8);
    plantState();

    // The instrument first: the fixture really is slower than the default
    // this issue is about. A shim that had stopped sleeping would make the
    // row below pass for the wrong reason.
    const started = Date.now();
    const probe = spawnSync("bunx", ["tsc", "--noEmit"], { cwd: PROJECT, encoding: "utf-8", timeout: 60000 });
    const elapsed = Date.now() - started;
    expect(probe.status, `the shim did not run cleanly: ${probe.stderr ?? ""}`).toBe(0);
    expect(elapsed, `the fixture typecheck took ${elapsed}ms, which is not slower than bun's 5000ms default`)
      .toBeGreaterThan(5000);

    const r = runCheck(GATE_SUITE);
    expect(r.ran, `tsc-pass never ran — the filter matched nothing:\n${r.output}`).toBe(true);
    expect(r.red, `a clean but slow typecheck failed tsc-pass:\n${r.output}`).toBe(false);
  }, 240000);

  test("the same fixture times out once the declaration is removed", () => {
    // THE MUTATION, performed and observed. The real source passing is not on
    // its own evidence that the declaration is what carried it; the mutant
    // failing on the same input is — and failing with bun's own timeout
    // sentence, rather than merely failing.
    plantSlowTypecheck(8);
    plantState();

    const mutantPath = join(SCRATCH, "workflow-mutant.ts");
    const mutated = GATE_SOURCE.replace(/\bsetDefaultTimeout\([^)]*\)\s*;?/, "");
    expect(mutated, "nothing was removed — the declaration moved").not.toBe(GATE_SOURCE);
    // The mutant runs from a temp directory, so every relative specifier has
    // to become absolute. A survivor would make the mutant die on module
    // resolution, and that non-zero exit reads as a refusal it never made.
    const relocated = mutated.replace(
      /from "(\.\.?\/[A-Za-z0-9._\-/]+)"/g,
      (_m, spec: string) => `from "${join(REPO_ROOT, "gates", spec)}"`,
    );
    const leftover = relocated.match(/from "\.\.?\//g) || [];
    expect(leftover.length, "relative imports were not rewritten; the mutant would die on resolution").toBe(0);
    writeFileSync(mutantPath, relocated);

    const r = runCheck(mutantPath);
    expect(r.ran, `tsc-pass never ran in the mutant — resolution or the filter, not a verdict:\n${r.output}`)
      .toBe(true);
    expect(r.red, `removing the declaration did not break the slow typecheck — it was never load-bearing:\n${r.output}`)
      .toBe(true);
    // Red for the stated reason. A mutant that failed to load is also red.
    expect(r.output, "red, but not from the timeout").toContain("timed out after");
  }, 240000);
});
