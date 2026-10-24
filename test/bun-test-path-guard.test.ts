/**
 * bun-test-path-guard.test.ts — #1544
 *
 * Covers SC-2540, SC-2541, SC-2542, SC-2543, SC-2544, SC-2545, SC-2546 (HOOK-ARCHITECTURE-SPEC.md).
 *
 * `bun test <path>` treats a path argument that matches no file as a name
 * FILTER. On bun 1.3.14, measured in this tree:
 *
 * | command | exit | summary |
 * |---|---|---|
 * | `bun test <absent>` | **1** | no test files matched at all |
 * | `bun test <real> <absent>` | **0** | `Ran 4 tests across 1 file.` |
 * | `bun test <real> ./<absent>` | **0** | no message about the absent path at all |
 *
 * So the issue's headline — a LONE absent path exiting 0 — does not reproduce;
 * that reading came from a pipeline, where `$?` is the last element's. The
 * defect is the MIXED command, which is the shape that actually bit: on
 * 2026-10-24 a verification command for #1536 named six paths, one of which
 * (`test/sc-reservations.test.ts`) did not exist. Five ran, the run exited 0
 * and reported `181 pass, 0 fail`, and the suite that would have caught the
 * defect was never opened. CI found it afterwards.
 *
 * The `./` prefix bun itself suggests is measured in AC-1c and is NOT a
 * remedy: alongside a path that does match, it exits 0 AND prints nothing.
 * It is quieter than the bare form, not louder.
 *
 * ## The one tell, and why the guard does not use it
 *
 * `Ran N tests across M files` is the only line that distinguishes the two
 * cases — M must equal the number of path arguments. That is a POST-HOC
 * reading: it requires the run to have happened and the reader to have
 * thought to check. The guard below refuses BEFORE bun is invoked, which
 * costs nothing and does not depend on anyone remembering.
 *
 * ## The mutation a weaker guard would survive
 *
 * A guard that inspected only the FIRST path argument passes every row of a
 * battery that puts the absent path first — and the live instance had it
 * SIXTH of six. AC-2c is that row: four present paths and an absent one last.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  BUN_TEST_PATH_GUARD_DECISION,
  bunTestPathGuardMode,
  bunTestPathRefusal,
} from "../lib/bun-test-paths";
import { suitePathArguments } from "../lib/test-suite-lock";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "hooks", "BunTestPathGuard.hook.ts");
const DECIDER = join(ROOT, "lib", "bun-test-paths.ts");

/** A real, cheap, passing test file — the "present path" in every mixed case. */
const PASSING = `import { expect, test } from "bun:test";
test("present", () => { expect(1).toBe(1); });
`;

/**
 * A scratch project with N passing test files. Written to FILES, never a
 * heredoc: a shell heredoc eats backticks and an inline fixture routinely
 * fails to carry its own premise.
 */
function scratchProject(count: number): { dir: string; present: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rg1544-"));
  mkdirSync(join(dir, "test"), { recursive: true });
  // The hook scopes itself to harnessed projects via lib/harness-project.ts,
  // so a scratch tree with no `.claude/rungate` is declined before the parse.
  // Without this the hook cases below pass over an empty stdout and witness
  // nothing — which is how AC-5b first went red.
  mkdirSync(join(dir, ".claude", "rungate"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rungate", "config.json"), "{}\n");
  const present: string[] = [];
  for (let i = 0; i < count; i++) {
    const rel = join("test", `present-${i}.test.ts`);
    writeFileSync(join(dir, rel), PASSING);
    present.push(rel);
  }
  return { dir, present };
}

function runBun(dir: string, args: string[]) {
  const r = spawnSync("bun", ["test", ...args], { cwd: dir, encoding: "utf-8", timeout: 60_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ---------------------------------------------------------------------------
// AC-1 — the premise, EXECUTED. If these ever go red, bun has been fixed and
// the guard below is no longer load-bearing. That is a thing worth being told.
// ---------------------------------------------------------------------------

describe("#1544 AC-1: what bun actually does with a path that matches no file", () => {
  test("AC-1a: a LONE absent path exits 1 — the issue's `exit=0` was a pipeline artefact", () => {
    const { dir } = scratchProject(1);
    try {
      const r = runBun(dir, ["test/zz-absent.test.ts"]);
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-1b: a real path PLUS an absent one exits 0 and runs only the real one", () => {
    const { dir, present } = scratchProject(1);
    try {
      const r = runBun(dir, [present[0], "test/zz-absent.test.ts"]);
      expect(r.code).toBe(0);
      // Two path arguments, one file. This is the whole defect in one line.
      expect(r.out).toContain("across 1 file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-1c: the `./` prefix bun suggests is not a remedy — exit 0, and silent", () => {
    const { dir, present } = scratchProject(1);
    try {
      const r = runBun(dir, [present[0], "./test/zz-absent.test.ts"]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("zz-absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 — the refusal fires, and names the path.
// ---------------------------------------------------------------------------

describe("#1544 AC-2: the guard refuses a bun test naming a path that matches no file", () => {
  test("AC-2a: a mixed command is refused and the refusal NAMES the missing path", () => {
    const { dir, present } = scratchProject(1);
    try {
      const refusal = bunTestPathRefusal(`bun test ${present[0]} test/zz-absent.test.ts`, dir);
      expect(refusal).not.toBeNull();
      expect(refusal!.missing.map(m => m.argument)).toEqual(["test/zz-absent.test.ts"]);
      // A refusal that does not say which path is a refusal nobody can act on.
      expect(refusal!.message).toContain("test/zz-absent.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-2b: the `./` form is refused too — same absence, different spelling", () => {
    const { dir, present } = scratchProject(1);
    try {
      const refusal = bunTestPathRefusal(`bun test ${present[0]} ./test/zz-absent.test.ts`, dir);
      expect(refusal).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-2c: the absent path is found LAST of five — the live instance's shape", () => {
    // A guard reading only the first path argument is green on every other row
    // in this file. #1536's typo was the sixth argument of six.
    const { dir, present } = scratchProject(4);
    try {
      const refusal = bunTestPathRefusal(`bun test ${present.join(" ")} test/zz-absent.test.ts`, dir);
      expect(refusal).not.toBeNull();
      expect(refusal!.missing.map(m => m.argument)).toEqual(["test/zz-absent.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-2d: every missing path is named, not just the first", () => {
    const { dir, present } = scratchProject(1);
    try {
      const refusal = bunTestPathRefusal(
        `bun test ${present[0]} test/zz-a.test.ts test/zz-b.test.ts`,
        dir,
      );
      expect(refusal!.missing.map(m => m.argument)).toEqual(["test/zz-a.test.ts", "test/zz-b.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-2e: a `cd … && bun test` chain is read — the segment, not the whole string", () => {
    const { dir, present } = scratchProject(1);
    try {
      const refusal = bunTestPathRefusal(`echo hi && bun test ${present[0]} test/zz-absent.test.ts`, dir);
      expect(refusal).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3 — the control. A guard that refuses everything also refuses nothing
// usefully, which is the issue's own acceptance wording.
// ---------------------------------------------------------------------------

describe("#1544 AC-3: the control — the guard does NOT fire on a clean command", () => {
  test("AC-3a: every path present → no refusal", () => {
    const { dir, present } = scratchProject(4);
    try {
      expect(bunTestPathRefusal(`bun test ${present.join(" ")}`, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3b: a bare full suite has no path arguments and is never refused", () => {
    const { dir } = scratchProject(1);
    try {
      expect(bunTestPathRefusal("bun test", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3c: a non-path name filter is left alone — `bun test -t foo` is legitimate", () => {
    const { dir, present } = scratchProject(1);
    try {
      expect(bunTestPathRefusal(`bun test ${present[0]} -t somepattern`, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3d: a command that is not a bun test at all is not this guard's business", () => {
    const { dir } = scratchProject(1);
    try {
      expect(bunTestPathRefusal("git status && ls test/zz-absent.test.ts", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3f: an unexpanded GLOB is not refused — the shell expands it, not bun", () => {
    // `existsSync("test/*.test.ts")` is false for every tree that ever
    // existed. Resolving it would make the guard fire on correct commands.
    const { dir } = scratchProject(2);
    try {
      expect(bunTestPathRefusal("bun test test/*.test.ts", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3g: a variable or substitution is not refused — the hook has no shell state", () => {
    const { dir } = scratchProject(1);
    try {
      expect(bunTestPathRefusal("bun test $SUITE", dir)).toBeNull();
      expect(bunTestPathRefusal("bun test $(bun scripts/census-routing.ts)", dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-3e: a flag's value is not a path argument", () => {
    const { dir, present } = scratchProject(1);
    try {
      expect(
        bunTestPathRefusal(`bun test ${present[0]} --reporter=junit --reporter-outfile=out.xml`, dir),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 — the tree bun will actually run in. Raised by the AI review on PR
// #1562, verified in both directions, and it was right.
//
// `splitTopLevel` does not track parenthesis depth, and this project MANDATES
// `( cd <dir> && … )` for every command that works outside the session's own
// directory. So the guard was resolving path arguments against the session's
// cwd while bun would run in the cd'd tree. Measured before the fix:
//
//   `( cd <target> && bun test test/real.test.ts )`  →  REFUSED a correct
//   command, naming a path that exists exactly where bun would have looked.
//
// The fix does not try to model subshell scoping. A path argument is refused
// only when it is absent under EVERY candidate root — the tool call's cwd and
// every `cd` target the command names. A typo is absent under all of them; a
// correct path exists under at least one. That makes the scoping question
// stop mattering, which is better than answering it with a depth counter that
// the next spelling defeats.
// ---------------------------------------------------------------------------

describe("#1544 AC-7: paths resolve against the tree bun will run in", () => {
  test("AC-7a: `( cd <dir> && bun test <path> )` is NOT refused when the path exists there", () => {
    const session = scratchProject(0);
    const target = scratchProject(1);
    try {
      const cmd = `( cd ${target.dir} && bun test ${target.present[0]} )`;
      // Before the fix this refused, naming a path that exists exactly where
      // bun would have looked. It is the form this project mandates.
      expect(bunTestPathRefusal(cmd, session.dir)).toBeNull();
    } finally {
      rmSync(session.dir, { recursive: true, force: true });
      rmSync(target.dir, { recursive: true, force: true });
    }
  });

  test("AC-7b: a flat `cd <dir> && bun test <path>` chain resolves there too", () => {
    const session = scratchProject(0);
    const target = scratchProject(1);
    try {
      const cmd = `cd ${target.dir} && bun test ${target.present[0]}`;
      expect(bunTestPathRefusal(cmd, session.dir)).toBeNull();
    } finally {
      rmSync(session.dir, { recursive: true, force: true });
      rmSync(target.dir, { recursive: true, force: true });
    }
  });

  test("AC-7c: a typo inside a cd'd subshell is still refused — absent under EVERY root", () => {
    // The guard must not be bought off by widening the roots: this is the
    // #1536 shape wearing the mandated command form.
    const session = scratchProject(0);
    const target = scratchProject(1);
    try {
      const cmd = `( cd ${target.dir} && bun test ${target.present[0]} test/zz-absent.test.ts )`;
      const refusal = bunTestPathRefusal(cmd, session.dir);
      expect(refusal).not.toBeNull();
      expect(refusal!.missing.map(m => m.argument)).toEqual(["test/zz-absent.test.ts"]);
    } finally {
      rmSync(session.dir, { recursive: true, force: true });
      rmSync(target.dir, { recursive: true, force: true });
    }
  });

  test("AC-7d: an unresolvable cd target skips the command rather than guessing", () => {
    const session = scratchProject(0);
    try {
      // The roots cannot be enumerated, so nothing can be said about the paths.
      expect(bunTestPathRefusal("( cd $WORKTREE && bun test test/zz-absent.test.ts )", session.dir)).toBeNull();
    } finally {
      rmSync(session.dir, { recursive: true, force: true });
    }
  });

  test("AC-7e: the refusal names every root it searched", () => {
    const session = scratchProject(0);
    const target = scratchProject(1);
    try {
      const cmd = `( cd ${target.dir} && bun test test/zz-absent.test.ts )`;
      const refusal = bunTestPathRefusal(cmd, session.dir);
      // A refusal that names one root while bun would have used another is
      // the thing that made this finding hard to see from the outside.
      expect(refusal!.message).toContain(target.dir);
    } finally {
      rmSync(session.dir, { recursive: true, force: true });
      rmSync(target.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8 — a duplicate-fd redirect is self-contained. Second finding from the
// AI review on PR #1562, verified against the regex before being accepted.
//
// `REDIRECT` consumed the NEXT token whenever its target group was empty, and
// `2>&1` has an empty target group — the `&1` is matched by a non-capturing
// `(?:&\d+)?` and thrown away. So the argument after `2>&1` was dropped from
// the extraction entirely and never stat'd: an absent path in that position
// was green while witnessing nothing. A bare `>` DOES consume the next token
// and must keep doing so, which is why AC-8b exists.
// ---------------------------------------------------------------------------

describe("#1544 AC-8: a duplicate-fd redirect does not swallow the next path", () => {
  test("AC-8a: an absent path after `2>&1` is still refused", () => {
    const { dir, present } = scratchProject(1);
    try {
      const refusal = bunTestPathRefusal(`bun test ${present[0]} 2>&1 test/zz-absent.test.ts`, dir);
      expect(refusal).not.toBeNull();
      expect(refusal!.missing.map(m => m.argument)).toEqual(["test/zz-absent.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-8a2: the extractor keeps the argument after `2>&1`", () => {
    expect(suitePathArguments("bun test test/a.test.ts 2>&1 test/b.test.ts")).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });

  test("AC-8b: a bare `>` still consumes its target — that is a sink, not a path", () => {
    // The control for the fix. Widening the redirect rule must not start
    // treating a redirect target as a test path.
    expect(suitePathArguments("bun test test/a.test.ts > out/report.txt")).toEqual(["test/a.test.ts"]);
    const { dir, present } = scratchProject(1);
    try {
      expect(bunTestPathRefusal(`bun test ${present[0]} > out/report.txt`, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-8d: `&>` is a redirect operator too, not a separator", () => {
    // Same mechanism, the other spelling. Asserted rather than described, so
    // that a later change to the splitter cannot quietly drop it again.
    expect(suitePathArguments("bun test test/a.test.ts &> log test/b.test.ts")).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });

  test("AC-8e: a real `&&` chain still splits — the fix did not eat the separator", () => {
    // The control for the splitter change. `&&` and a backgrounding `&` must
    // keep ending a segment, or the concurrency guard's reading changes too.
    expect(suitePathArguments("bun test test/a.test.ts && bun test test/b.test.ts")).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
    expect(suitePathArguments("echo hi & bun test test/a.test.ts")).toEqual(["test/a.test.ts"]);
  });

  test("AC-8c: a redirect carrying its own target still consumes nothing extra", () => {
    expect(suitePathArguments("bun test test/a.test.ts 2>/dev/null test/b.test.ts")).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — one extractor, shared with the concurrency guard.
// ---------------------------------------------------------------------------

describe("#1544 AC-4: the path arguments come from ONE extractor", () => {
  test("AC-4a: suitePathArguments returns the path-shaped arguments of every invocation", () => {
    expect(suitePathArguments("bun test test/a.test.ts test/b.test.ts")).toEqual([
      "test/a.test.ts",
      "test/b.test.ts",
    ]);
  });

  test("AC-4b: it returns nothing for a bare full suite", () => {
    expect(suitePathArguments("bun test")).toEqual([]);
  });

  test("AC-4c: it does not treat a flag or its value as a path", () => {
    expect(suitePathArguments("bun test test/a.test.ts -t name --coverage")).toEqual(["test/a.test.ts"]);
  });

  test("AC-4d: the full-suite decider still answers the opposite question on the same input", async () => {
    const { isFullSuiteCommand } = await import("../lib/test-suite-lock");
    // Two consumers, one extractor: a path-shaped argument means NOT a full
    // suite, and means a path this guard must stat.
    expect(isFullSuiteCommand("bun test test/a.test.ts")).toBe(false);
    expect(isFullSuiteCommand("bun test")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 — the mutation. The refusal routes through ONE exported constant, and
// a mutant with it neutralised stops refusing. Without this the cases above
// are a line in a report.
// ---------------------------------------------------------------------------

describe("#1544 AC-5: the guard is proved able to fail", () => {
  test("AC-5a: the decision constant appears exactly once in the decider", () => {
    const source = readFileSync(DECIDER, "utf-8");
    const occurrences = source.split("BUN_TEST_PATH_GUARD_DECISION").length - 1;
    // Once at the declaration. Any second spelling is a refusal path the
    // mutation below cannot reach, and it would read as covered.
    expect(occurrences).toBe(1);
  });

  test("AC-5b: the hook refuses an absent path, and a mutant decider does not", () => {
    const { dir, present } = scratchProject(1);
    const command = `bun test ${present[0]} test/zz-absent.test.ts`;
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: dir,
      session_id: "rg1544",
    });

    try {
      const real = spawnSync("bun", [HOOK], {
        input: payload,
        cwd: dir,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, RUNGATE_BUN_TEST_PATH_GUARD: "block" },
      });
      expect(real.stdout).toContain(BUN_TEST_PATH_GUARD_DECISION);
      expect(real.stdout).toContain("test/zz-absent.test.ts");

      // The mutant: the same decider with the refusal neutralised. This is
      // the removal of the refusal, performed and observed — so a case that
      // later passes for an unrelated reason stops being indistinguishable
      // from a case that is genuinely caught.
      //
      // It is written as a SIBLING in lib/, not into a temp directory. The
      // decider imports `./test-suite-lock`, so a copy anywhere else dies on
      // module resolution and the empty stdout reads exactly like a mutant
      // that refused nothing. That is the trap in
      // `.claude/rules/checks-must-be-able-to-fail.md`, and this case fell
      // into it on the first run.
      const stamp = `${process.pid}-${Date.now()}`;
      const mutantPath = join(ROOT, "lib", `zz-mutant-1544-${stamp}.ts`);
      const driverPath = join(ROOT, "lib", `zz-driver-1544-${stamp}.ts`);
      try {
        const source = readFileSync(DECIDER, "utf-8");
        const mutated = source.replace(
          "if (missing.length === 0) return null;",
          "if (missing.length >= 0) return null;",
        );
        // A replace that matched nothing is a mutant identical to the source,
        // which would go green having witnessed nothing.
        expect(mutated).not.toBe(source);
        writeFileSync(mutantPath, mutated);
        writeFileSync(
          driverPath,
          `import { bunTestPathRefusal } from "./zz-mutant-1544-${stamp}";\n` +
            `console.log(JSON.stringify(bunTestPathRefusal(${JSON.stringify(command)}, ${JSON.stringify(dir)})));\n`,
        );

        const m = spawnSync("bun", [driverPath], { encoding: "utf-8", timeout: 60_000 });
        // The mutant must have RUN. A module that failed to load prints
        // nothing, and nothing is not the same observation as `null`.
        expect(m.status).toBe(0);
        expect(m.stdout.trim()).toBe("null");
      } finally {
        rmSync(mutantPath, { force: true });
        rmSync(driverPath, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC-5c: the control runs through the hook too — a clean command is not blocked", () => {
    const { dir, present } = scratchProject(2);
    try {
      const r = spawnSync("bun", [HOOK], {
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: `bun test ${present.join(" ")}` },
          cwd: dir,
          session_id: "rg1544",
        }),
        cwd: dir,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, RUNGATE_BUN_TEST_PATH_GUARD: "block" },
      });
      expect(r.stdout.trim()).toBe("");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6 — the rung, and the registration.
// ---------------------------------------------------------------------------

describe("#1544 AC-6: the rung and the four registration positions", () => {
  test("AC-6a: the default rung is block, and the env var reverses it without code", () => {
    expect(bunTestPathGuardMode({} as NodeJS.ProcessEnv).mode).toBe("block");
    expect(bunTestPathGuardMode({ RUNGATE_BUN_TEST_PATH_GUARD: "off" } as NodeJS.ProcessEnv).mode).toBe("off");
    expect(bunTestPathGuardMode({ RUNGATE_BUN_TEST_PATH_GUARD: "warn" } as NodeJS.ProcessEnv).mode).toBe("warn");
  });

  test("AC-6b: an unrecognised mode refuses — it does not silently turn the guard off", () => {
    const reading = bunTestPathGuardMode({ RUNGATE_BUN_TEST_PATH_GUARD: "yes" } as NodeJS.ProcessEnv);
    expect(reading.mode).toBe("block");
    expect(reading.unrecognised).toBe("yes");
  });

  test("AC-6c: the hook is registered in all four positions", () => {
    const hookSource = readFileSync(HOOK, "utf-8");
    expect(hookSource).toContain("SC-2543");

    const registry = JSON.parse(readFileSync(join(ROOT, ".claude", "rungate", "hooks.json"), "utf-8"));
    const entry = Object.values(registry).find(
      (h: unknown) => (h as { name?: string })?.name === "BunTestPathGuard",
    ) as { matcher?: string; hookFor?: string; scope?: string; enabled?: boolean } | undefined;
    expect(entry).toBeDefined();
    expect(entry!.hookFor).toBe("PreToolUse");
    expect(entry!.matcher).toBe("Bash");
    expect(entry!.scope).toBe("project");
    expect(entry!.enabled).toBe(true);

    const settings = readFileSync(join(ROOT, ".claude", "settings.json"), "utf-8");
    expect(settings).toContain("BunTestPathGuard.hook.ts");

    const spec = readFileSync(join(ROOT, "specs", "HOOK-ARCHITECTURE-SPEC.md"), "utf-8");
    expect(spec).toContain("BunTestPathGuard");
  });

  test("AC-6d: the hook stays a thin trigger — under the 150-line SC-371 cap", () => {
    expect(readFileSync(HOOK, "utf-8").split("\n").length).toBeLessThanOrEqual(150);
  });
});
