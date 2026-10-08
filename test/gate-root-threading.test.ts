/**
 * The gate's root comes from the run, not from whoever imported the module (#190)
 *
 * SC-388 (GATE-CONTRACTS-SPEC.md), AC-1/AC-4/AC-6 of #190.
 *
 * `gates/gate-executor.ts` called `harnessRoot()` at seven separate `cwd:`
 * sites. Each call re-resolved a root from the environment and from the
 * location of whichever copy of `lib/paths.ts` had been loaded, so the tree the
 * gate RAN its subprocesses in was decided seven times, independently, by
 * something other than the run. One of those subprocesses is
 * `bun scripts/sync-spec-tests.ts`, which WRITES — so the drift was not only
 * observed in the wrong tree, it was created there.
 *
 * The root is now resolved ONCE, in `resolveRunRoot()` here in `gates/`, and
 * threaded in through `GateExecutorInput.harnessRoot`.
 *
 * Two cases carry this file, and they are opposites on purpose:
 *
 *   - a gate run from a worktree executes against THAT worktree — the
 *     regression, asserted in-process, in a fresh process from an unrelated
 *     cwd, and by running a real gate twice with two different roots;
 *   - a gate run with NO root is refused — the fail-closed control. It used to
 *     be `process.env.HARNESS_ROOT || <fallback>`, so `HARNESS_ROOT=` set to
 *     the empty string (an unset shell variable interpolated into a command —
 *     the single most ordinary way this is misconfigured) silently took the
 *     fallback. `harnessRootFor` throws instead.
 *
 * The refusal case runs twice: against the real module, and against a mutant
 * copy of it whose `harnessRootFor` is the identity function. The mutant MUST
 * NOT refuse. Without that second half, "it threw" is indistinguishable from
 * "it threw for some unrelated reason", which is the defect
 * .claude/rules/checks-must-be-able-to-fail.md is about.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { resolveRunRoot } from "../gates/run-gate";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATES_DIR = join(REPO_ROOT, "gates");
const EXECUTOR_SRC = readFileSync(join(GATES_DIR, "gate-executor.ts"), "utf-8");
const RUN_GATE_PATH = join(GATES_DIR, "run-gate.ts");
const RUN_GATE_SRC = readFileSync(RUN_GATE_PATH, "utf-8");

const cleanup: string[] = [];
afterAll(() => {
  for (const p of cleanup) rmSync(p, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

/** The MAIN checkout, via --git-common-dir. Equals REPO_ROOT only outside a worktree. */
function mainCheckoutRoot(): string {
  const gitCommonDir = execSync("git rev-parse --git-common-dir", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).trim();
  return dirname(resolve(REPO_ROOT, gitCommonDir));
}

// ── AC-1: the executor resolves no root of its own ───────────────────────

describe("#190: the gate executor takes the run's root from its input", () => {
  test("gate-executor calls no root resolver and imports none", () => {
    expect(EXECUTOR_SRC).not.toMatch(/harnessRoot\s*\(\s*\)/);
    expect(EXECUTOR_SRC).not.toMatch(
      /import\s*\{[^}]*\bharnessRoot\b[^}]*\}\s*from\s*["']\.\.\/lib\/paths["']/,
    );
  });

  test("GateExecutorInput declares harnessRoot as a required string", () => {
    const iface = EXECUTOR_SRC.match(/export interface GateExecutorInput \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(iface).not.toBe("");
    expect(iface).toContain("harnessRoot: string;");
    expect(iface).not.toContain("harnessRoot?:");
  });

  test("all seven cwd sites read the threaded root rather than calling for one", () => {
    // `cwd: harnessRoot` with no following `(` — the binding, not a call.
    const threaded = [...EXECUTOR_SRC.matchAll(/cwd:\s*harnessRoot\b(?!\s*\()/g)];
    expect(threaded.length).toBe(7);
  });
});

// ── AC-6: the root is resolved once, in run-gate, and threaded ───────────

describe("#190: run-gate resolves the run's root once and threads it", () => {
  test("resolveRunRoot is exported and is the only resolution in the file", () => {
    expect(RUN_GATE_SRC).toMatch(/export function resolveRunRoot\s*\(/);
    const declarations = [...RUN_GATE_SRC.matchAll(/function resolveRunRoot\s*\(/g)];
    expect(declarations.length).toBe(1);
  });

  test("the single executeGate call is given the resolved root", () => {
    const call = RUN_GATE_SRC.match(/executeGate\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(call).not.toBe("");
    expect(call).toContain("harnessRoot: resolveRunRoot()");
  });

  test("HARNESS_ROOT wins when set — it is the override CI and the harness use", () => {
    expect(resolveRunRoot({ HARNESS_ROOT: "/tmp/explicit-harness-root" })).toBe(
      "/tmp/explicit-harness-root",
    );
  });
});

// ── AC-4, case 1: a gate run from a worktree runs against that worktree ──

describe("#190: a gate run from a worktree executes against that worktree", () => {
  test("with no HARNESS_ROOT the root is the checkout run-gate.ts lives in", () => {
    // NOT the main checkout. The recovered design resolved --git-common-dir,
    // which hands back the main repo from inside a linked worktree — the
    // opposite of what the gate needs, because the files the gate is grading
    // are the ones in the worktree.
    expect(resolveRunRoot({})).toBe(REPO_ROOT);
  });

  test("a fresh process from an unrelated cwd still resolves this checkout", () => {
    // In-process the answer could come from the test runner's own cwd. A gate
    // is launched as its own process from wherever the workflow happens to be,
    // so resolve it that way too.
    const elsewhere = temp("gate-root-cwd-");
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.HARNESS_ROOT;
    const proc = Bun.spawnSync(
      ["bun", "-e", `import {resolveRunRoot} from ${JSON.stringify(RUN_GATE_PATH)}; console.log(resolveRunRoot())`],
      { cwd: elsewhere, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.stderr.toString()).toBe("");
    expect(proc.stdout.toString().trim()).toBe(REPO_ROOT);
  });

  test("the threaded root, not the environment, decides where subprocesses run", () => {
    // The differential, and the reason the two assertions above are not
    // enough: they describe a VALUE. This shows the value is load-bearing.
    //
    // Deliberately a CROSSOVER — `harnessRoot` and `HARNESS_ROOT` point at
    // opposite trees in both directions. Running the gate twice with the env
    // var alone would prove nothing, because the old `harnessRoot()` call
    // honoured `HARNESS_ROOT` too and would have produced the same two
    // outcomes. Only the crossover separates "the executor was told" from
    // "the executor looked it up": with the threaded root winning, the run
    // aimed at a directory that is not a checkout finds no tests to run
    // (0 pass) even though the environment names a real one, and vice versa.
    const work = temp("gate-root-work-");
    const dir = join(work, "threading");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
      schemaVersion: 2, issue: 9993, repo: "test/repo", issueRepo: "test/repo",
      projectRoot: "/tmp/test", slug: "threading", phase: "DONE",
      issueGoal: "Gate root threading", sizing: { predicted: "XS", ceremonyTier: "LIGHT" },
      acs: [{
        id: "AC-1", type: "CODE", statement: "Unit tests pass including canary test suite",
        threshold: { op: ">=", value: 10 }, evidenceMethod: { type: "BUN_TEST", command: "bun test" },
        evidence: { type: "command-output", content: "24 pass" }, verdict: "PASS",
      }],
      gates: {}, environments: { local: { api: "PASS", ui: "PASS", tests: "PASS" } },
      agents: { marcus: { spawned: true, verdict: "PASS" } },
      buildCommit: "abc1234", changelog: [], bootstrappedFrom: "ship-workflow",
    }, null, 2));
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\nCovers: AC-1\n\n## AC-1\nUnit tests pass\n");

    const notAHarness = temp("gate-root-empty-");

    /** Run the real executor with these two roots disagreeing, return its pass count. */
    function passesWith(threaded: string, envRoot: string): number {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        HARNESS_ROOT: envRoot,
        RUNGATE_WORK_DIR: work,
        RUNGATE_SKIP_AGENTS: "1",
      };
      const proc = Bun.spawnSync(
        ["bun", "-e",
          `const {executeGate} = await import(${JSON.stringify(join(GATES_DIR, "gate-executor.ts"))});` +
          `const r = await executeGate({gate:"scope",slug:"threading",issue:9993,` +
          `workDir:${JSON.stringify(dir)},stateFilePath:${JSON.stringify(join(dir, "workflow-state.json"))},` +
          `harnessRoot:${JSON.stringify(threaded)}});` +
          `console.log("PASSES:"+r.passes)`],
        { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" },
      );
      const m = (proc.stdout.toString() + proc.stderr.toString()).match(/PASSES:(\d+)/);
      if (!m) throw new Error(`executor produced no result:\n${proc.stdout.toString()}\n${proc.stderr.toString()}`);
      return Number(m[1]);
    }

    // Told this checkout, environment says otherwise → the gate's tests run.
    expect(passesWith(REPO_ROOT, notAHarness)).toBeGreaterThan(0);

    // Told a directory that is not a checkout, environment says otherwise →
    // nothing to run. Under the old `cwd: harnessRoot()` this was the line
    // that could not fail: `harnessRoot()` would have read HARNESS_ROOT,
    // found the real checkout and reported the same count as above.
    expect(passesWith(notAHarness, REPO_ROOT)).toBe(0);
  }, { timeout: 300_000 });
});

// ── AC-4, case 2: a gate run with no root is refused (fail-closed) ───────

describe("#190: a gate run with no root is refused", () => {
  test("an empty HARNESS_ROOT is refused, not quietly replaced by a fallback", () => {
    expect(() => resolveRunRoot({ HARNESS_ROOT: "" })).toThrow(/empty root/);
  });

  test("the positive control: with harnessRootFor neutered, nothing refuses", () => {
    // The mutant lives in gates/ so its `../lib/paths` style relative imports
    // still resolve; a temp directory would make it die on module resolution,
    // and "it threw" would then look exactly like "it refused on the merits".
    const mutantPath = join(GATES_DIR, `__run-gate-mutant-${process.pid}.ts`);
    const IMPORT_RE = /import \{ harnessRootFor \} from "\.\.\/lib\/paths";/;
    expect(RUN_GATE_SRC).toMatch(IMPORT_RE);
    const mutantSrc = RUN_GATE_SRC.replace(
      IMPORT_RE,
      'const harnessRootFor = (r: string) => r;',
    );
    expect(mutantSrc).not.toBe(RUN_GATE_SRC);

    writeFileSync(mutantPath, mutantSrc);
    try {
      const proc = Bun.spawnSync(
        ["bun", "-e",
          `const m = await import(${JSON.stringify(mutantPath)});` +
          `try { console.log("RESULT:" + JSON.stringify(m.resolveRunRoot({ HARNESS_ROOT: "" }))) }` +
          `catch (e) { console.log("THREW:" + e.message) }`],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const out = proc.stdout.toString().trim();
      // The mutation removed the refusal and the empty root sails through.
      // That is the whole point: the real module's throw above is attributable
      // to harnessRootFor and to nothing else.
      expect(out).toBe('RESULT:""');
    } finally {
      if (existsSync(mutantPath)) rmSync(mutantPath, { force: true });
    }
  }, { timeout: 60_000 });

  test("the main checkout is reachable, so the worktree assertion is not vacuous", () => {
    // If --git-common-dir and import.meta.dir resolved to the same place
    // everywhere, the first case above would pass under the recovered design
    // too and would prove nothing about which one was chosen. Confirm the two
    // notions exist and that resolveRunRoot picked the module-relative one.
    const main = mainCheckoutRoot();
    expect(existsSync(join(main, "HARNESS.md"))).toBe(true);
    expect(resolveRunRoot({})).toBe(REPO_ROOT);
  });
});
