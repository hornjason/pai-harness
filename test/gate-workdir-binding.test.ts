/**
 * #700 — the gate suite resolved this run's artifacts from a mutable global.
 *
 * `gates/workflow.test.ts` is handed the run's directory. `gate-executor.ts:1523`
 * spawns it with `TEST_WORK_DIR: workDir`, and the suite reads its state out of
 * that directory at `:48`. Six checks then threw that away and rebuilt the same
 * path a second way — `RUNGATE_WORK_DIR` (or a `$HOME/.rungate` fallback) plus
 * the state's slug — which is two deciders for one question
 * (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape) with the
 * weaker one winning.
 *
 * ## What made it a bug rather than a redundancy
 *
 * The second derivation reads a process global, and `bun test gates/` runs
 * every file in that directory in ONE process — measured, same pid across
 * files. `gates/ship-orchestrator.test.ts:37` assigns
 * `process.env.RUNGATE_WORK_DIR = /tmp/ship-orch-test-${process.pid}` at module
 * scope and never restores it. Whichever of the two files reaches its
 * assignment first decides what the other one resolves.
 *
 * That is why #700 was six red CI runs and zero local ones. The order is bun's
 * walk over `gates/`, which is filesystem order and not alphabetical: measured
 * on this machine's APFS, `ship-orchestrator.test.ts` runs LAST of the thirteen
 * (position 70 in the junit) and `workflow.test.ts` at 42, so the pollution
 * lands after every check that could see it. On CI's ext4 it does not.
 *
 * The CI log names the resolved path, which is what settled it:
 *
 *     brief-ac-alignment: Marcus was spawned but no brief exists at
 *     /tmp/ship-orch-test-3026/standard/marcus-brief.md
 *
 * `standard` is the contract fixture's slug; `/tmp/ship-orch-test-3026` is the
 * orchestrator test's base. One string from each file, in one path. Exactly one
 * file in the tree produces `ship-orch-test-`.
 *
 * ## The cheapest wrong fix, named before the repair
 *
 * **Make `gates/ship-orchestrator.test.ts` save and restore `RUNGATE_WORK_DIR`,
 * the way `gates/adversarial.test.ts:31` already does, and stop there.** It is a
 * three-line edit, it is a real improvement, and CI goes green — that file is
 * the only producer of the polluted string, so removing it removes every
 * observed failure.
 *
 * It leaves the six checks resolving a per-run path from a process-global that
 * any future test file, any imported module, or the CI runner's own environment
 * can set. The defect is not that one file was rude; it is that a check which
 * was HANDED its directory went and derived it again from somewhere weaker.
 *
 * Do these cases survive it? Yes, non-vacuously, and by construction: AC-1
 * drives `gates/workflow.test.ts` directly with a deliberately wrong
 * `RUNGATE_WORK_DIR`, and never loads `ship-orchestrator.test.ts` at all. The
 * save/restore repair cannot change its verdict. AC-4 is the case that WOULD go
 * green under it, and it is here deliberately — it holds the hygiene line the
 * cheap fix buys, so that fix is recorded as the second half rather than
 * silently skipped.
 *
 * ## Why these cases model the race instead of racing
 *
 * The failure needs `ship-orchestrator.test.ts` to win a nondeterministic
 * ordering. Reproducing that on APFS failed three times — the polluter runs
 * last here no matter what order it is given on the command line. So AC-1 does
 * not try to win the race; it injects **the state the race produces** (a
 * `RUNGATE_WORK_DIR` disagreeing with `TEST_WORK_DIR`) and asserts the check is
 * immune. A case that depends on an ordering it cannot control is #507's shape,
 * and this file is the reason that is worth avoiding.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const GATES_DIR = join(REPO, "gates");
const CHECK = "brief-ac-alignment";

interface Run {
  /** How many cases bun actually executed. Read before any verdict. */
  ran: number;
  pass: number;
  fail: number;
  output: string;
}

/**
 * Drive the real `gates/workflow.test.ts` over a planted run directory.
 *
 * Spawned rather than imported: the thing under test is how the suite resolves
 * a path from its own process environment, and an in-process call would resolve
 * it from THIS process's environment instead.
 */
function runCheck(workDir: string, rungateWorkDir: string | null): Run {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TEST_WORK_DIR: workDir,
  };
  if (rungateWorkDir === null) delete env.RUNGATE_WORK_DIR;
  else env.RUNGATE_WORK_DIR = rungateWorkDir;

  const cmd = `bun test ${JSON.stringify(join(GATES_DIR, "workflow.test.ts"))} --test-name-pattern ${JSON.stringify(CHECK)} 2>&1`;
  let output = "";
  try {
    output = execSync(cmd, { cwd: REPO, encoding: "utf-8", timeout: 120_000, env });
  } catch (e: any) {
    output = (e.stdout || "") + (e.stderr || "");
  }
  const num = (re: RegExp): number => {
    const m = output.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    ran: num(/Ran (\d+) tests? across/),
    pass: num(/^\s*(\d+) pass\s*$/m),
    fail: num(/^\s*(\d+) fail\s*$/m),
    output,
  };
}

/** A run directory the check should be satisfied by: a brief naming every AC. */
function plantGoodRun(): string {
  const base = mkdtempSync(join(tmpdir(), "rungate-700-"));
  const dir = join(base, "p700");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow-state.json"), JSON.stringify({
    schemaVersion: 2, issue: 9999, repo: "test/repo", issueRepo: "test/repo",
    projectRoot: "/tmp/test-project", slug: "p700", phase: "VERIFY",
    issueGoal: "probe for the #700 work-dir binding",
    acs: [
      { id: "AC-1", type: "CODE", statement: "first", verdict: "PASS" },
      { id: "AC-2", type: "CODE", statement: "second", verdict: "PASS" },
    ],
    gates: {}, changelog: [],
    agents: { marcus: { spawned: true, verdict: "PASS" } },
  }, null, 2));
  writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\n## AC-1\nfirst\n\n## AC-2\nsecond\n");
  return dir;
}

describe("#700 AC-1: a wrong RUNGATE_WORK_DIR cannot move the check off its own run", () => {
  test("the check passes with RUNGATE_WORK_DIR pointing somewhere else entirely", () => {
    const dir = plantGoodRun();
    try {
      // Exactly the state the CI race produces: the suite is handed the real
      // directory and the global disagrees with it. `/tmp/ship-orch-test-…` is
      // the literal shape `gates/ship-orchestrator.test.ts` leaves behind.
      const r = runCheck(dir, `/tmp/ship-orch-test-${process.pid}`);
      // `ran` first: a --test-name-pattern that matches nothing reports zero
      // failures, which is indistinguishable from the check passing, and is
      // also what a suite that failed to load looks like.
      expect(r.ran, `the check did not run at all. Output:\n${r.output}`).toBe(1);
      expect(r.fail, `${CHECK} refused a run whose brief is present. Output:\n${r.output}`).toBe(0);
      expect(r.pass).toBe(1);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  }, 180_000);

  test("…and with RUNGATE_WORK_DIR removed from the environment altogether", () => {
    // The `$HOME/.rungate` fallback is the other way the second derivation
    // lands somewhere real and wrong. Varying exactly one input from the case
    // above (#585): same planted run, same assertion, the global absent rather
    // than wrong.
    const dir = plantGoodRun();
    try {
      const r = runCheck(dir, null);
      expect(r.ran, `the check did not run at all. Output:\n${r.output}`).toBe(1);
      expect(r.fail, `${CHECK} fell back to $HOME/.rungate. Output:\n${r.output}`).toBe(0);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  }, 180_000);
});

describe("#700 AC-2: the control — the check is not simply always green", () => {
  test("a run whose brief is genuinely missing is still refused", () => {
    // Without this, "resolve from TEST_DIR" is satisfied by deleting the check.
    // Same env as AC-1's first case, one file removed.
    const dir = plantGoodRun();
    rmSync(join(dir, "marcus-brief.md"));
    try {
      const r = runCheck(dir, `/tmp/ship-orch-test-${process.pid}`);
      expect(r.ran, `the check did not run at all. Output:\n${r.output}`).toBe(1);
      expect(r.fail, `${CHECK} passed a run with no brief at all. Output:\n${r.output}`).toBe(1);
      // And the refusal names the directory it actually looked in, which is the
      // half of #700 that PR #738 shipped. A refusal naming the polluted path
      // would mean the check is still reading the global.
      expect(r.output).toContain(dir);
      expect(r.output).not.toContain("ship-orch-test");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  }, 180_000);

  test("a brief that omits an AC is still refused", () => {
    const dir = plantGoodRun();
    writeFileSync(join(dir, "marcus-brief.md"), "# Marcus Brief\n\n## AC-1\nfirst only\n");
    try {
      const r = runCheck(dir, `/tmp/ship-orch-test-${process.pid}`);
      expect(r.ran).toBe(1);
      expect(r.fail, `${CHECK} passed a brief missing AC-2. Output:\n${r.output}`).toBe(1);
      expect(r.output).toContain("AC-2");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  }, 180_000);
});

describe("#700 AC-3: one binding for this run's directory", () => {
  const SRC = readFileSync(join(GATES_DIR, "workflow.test.ts"), "utf-8");

  test("no per-run artifact path is rebuilt from RUNGATE_WORK_DIR and a slug", () => {
    // The shape that was the bug: the global, the HOME fallback, and `slug`
    // joined together — a second derivation of the directory the suite was
    // handed. Asserted on the composition rather than on a count, because a
    // count is satisfied by any N (#532).
    const lines = SRC.split("\n");
    const offenders = lines
      .map((l, i) => ({ line: i + 1, text: l.trim() }))
      .filter(({ text }) =>
        text.includes("process.env.RUNGATE_WORK_DIR") &&
        /\bslug\b/.test(text));
    expect(offenders, `these rebuild the run directory instead of using the one the ` +
      `gate passed in TEST_WORK_DIR:\n${offenders.map(o => `  :${o.line} ${o.text}`).join("\n")}`)
      .toEqual([]);
  });

  test("the helper exists and is the thing those checks call", () => {
    // Without this, the case above is satisfied by inlining `join(TEST_DIR, …)`
    // at six sites, which is six bindings again — just quieter ones.
    expect(SRC).toContain("function runArtifact(");
    const calls = SRC.match(/runArtifact\(/g) || [];
    expect(calls.length, "runArtifact is declared and barely used").toBeGreaterThanOrEqual(7);
  });

  test("the signals directory is NOT moved under the run directory", () => {
    // `signals` is shared across runs and is the one site that legitimately
    // wants the base. A fix that swept it up with the other six would be a
    // behaviour change wearing a refactor.
    expect(SRC).toContain('"signals"');
    const signalLine = SRC.split("\n").find(l => l.includes('"signals"')) || "";
    expect(signalLine).toContain("RUNGATE_WORK_DIR");
    expect(signalLine).not.toContain("runArtifact");
  });
});

describe("#700 AC-4: no gate test file edits the shared environment and leaves it edited", () => {
  /**
   * The class guard, and the one that would have caught this before CI did.
   *
   * `bun test gates/` is ONE process — measured: two probe files in one run
   * reported the same pid. So a module-scope `process.env.X = …` in any file
   * under `gates/` is a write to every other file's environment, and the order
   * that decides who sees it is a filesystem walk.
   *
   * Detection is by INDENTATION, and that is a proxy: module-scope statements
   * sit at column zero and anything inside a `describe`, `beforeEach` or
   * `test` is indented. It is the same proxy `scripts/validate-workflow.ts`
   * uses, and it is wrong in the safe direction — a module-scope assignment
   * somebody indents by hand escapes, which costs a missed violation, not a
   * false one.
   */
  const files = readdirSync(GATES_DIR).filter(f => f.endsWith(".test.ts"));

  test("the scan has something to scan", () => {
    // An empty population agrees with every rule. The thirteen files are the
    // reason this guard means anything.
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  test("no file assigns process.env at module scope", () => {
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(GATES_DIR, f), "utf-8");
      text.split("\n").forEach((line, i) => {
        if (/^(process\.env\.[A-Za-z_][A-Za-z_0-9]*|process\.env\[)\s*=/.test(line)) {
          violations.push(`${f}:${i + 1}  ${line.trim()}`);
        }
        if (/^delete\s+process\.env\./.test(line)) {
          violations.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(violations, "gates/ runs as one process, so these are writes to every " +
      "other gate test file's environment, resolved in filesystem-walk order " +
      "(#700). Move them into beforeEach/afterEach and restore the prior value, " +
      `the way gates/adversarial.test.ts does:\n${violations.join("\n")}`).toEqual([]);
  });
});
