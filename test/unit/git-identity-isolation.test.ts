/**
 * Tests must not write git identity into a real repository (#84).
 *
 * rungate's own .git/config carried `user.name = Test` / `user.email =
 * test@test.com`, which beats global config — so every commit on main was
 * attributed to "Test" instead of to Jason, across months of history, and
 * nothing noticed because git never complains about a working identity.
 *
 * The first version of this file checked for the literal token `cwd:` on the
 * same line and never looked at what it pointed to, and its regex only matched
 * the shell form `git config user.email X`. That missed `--global` (which
 * writes ~/.gitconfig — strictly worse than the local override this exists to
 * prevent), `--system`, and the `execFileSync("git", ["config", ...])` argv
 * form that is the dominant shape in this codebase. It could not see the very
 * helper written to fix the problem, and it marked the most likely source of
 * #84 as safe. A checker that cannot detect the bug it was written for is worse
 * than none, because it closes the question.
 */

import { describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..", "..");
const SELF = "test/unit/git-identity-isolation.test.ts";

/** Shell form: `git [-C dir] config [--local|--global|--system] user.name ...` */
const SHELL_FORM = /\bgit\s+(?:-C\s+(\S+)\s+)?config\s+((?:--\S+\s+)*)user\.(?:name|email)\b/;
/** argv form: "git", ["config", ..., "user.email", ...] */
const ARGV_FORM = /["'`]config["'`]\s*,[\s\S]{0,120}?["'`](--global|--system|--local|user\.(?:name|email))["'`]/;
/** A helper wrapping git, e.g. `git("config", "user.email", ...)` in git-fixture.ts */
const HELPER_FORM = /\bgit\(\s*["'`]config["'`]\s*,\s*["'`]user\.(?:name|email)["'`]/;

interface Offender { where: string; why: string }

/**
 * Single-line verdict, shared by scan() and its own tests.
 *
 * This used to be a SECOND copy of the classification logic living inside one
 * test, so "the checker detects every form it claims to" validated the copy
 * rather than the checker. The two could drift and the tests would still pass
 * — a checker that tests a different implementation than the one that runs.
 * The agreement test below pins them together.
 */
export function detect(line: string, wrapperBindsDir = false): boolean {
  if (/^\s*(\/\/|\*|#)/.test(line)) return false;
  const shell = line.match(SHELL_FORM);
  if (shell) {
    const [, dir, flags = ""] = shell;
    return /--global|--system/.test(flags) || !dir || dir === "." || dir === "$PWD" || dir === '"$PWD"';
  }
  if (HELPER_FORM.test(line) || ARGV_FORM.test(line)) {
    if (/--global|--system/.test(line)) return true;
    // `"-C", <dir>` in the argv names the target more explicitly than cwd.
    // ...but only if <dir> is a REAL target. `-C "."`, `-C process.cwd()` and
    // `-C $PWD` all resolve to wherever the process is standing, which is the
    // exact hazard #84 exists for. The shell form already rejects `git -C .`;
    // accepting its argv twin would be the same directory, opposite verdict.
    // Found by security review on the first version of this allowance.
    const argvDir = line.match(/["']-C["']\s*,\s*([^,\]]+)/)?.[1]?.trim();
    const dirIsCurrent = !argvDir
      || /^["'`]?\.["'`]?$/.test(argvDir)
      || /process\.cwd|\$PWD|__dirname/.test(argvDir);
    const namesDirInArgv = !!argvDir && !dirIsCurrent;
    return !/\bcwd\s*:/.test(line) && !namesDirInArgv && !wrapperBindsDir;
  }
  return false;
}

function scan(): Offender[] {
  const offenders: Offender[] = [];

  for (const rel of new Glob("{test,scripts,evals,lib,gates,hooks,workflows}/**/*.{ts,js,sh}").scanSync({ cwd: ROOT })) {
    if (rel.includes("worktrees/") || rel.includes("node_modules/")) continue;
    // Exact path, not endsWith: `evals-git-identity-isolation.test.ts` would
    // otherwise be silently exempt too.
    if (rel === SELF) continue;

    const src = readFileSync(join(ROOT, rel), "utf-8");
    // A file may bind the directory once, in a local wrapper:
    //   const git = (...args) => execFileSync("git", args, { cwd, ... })
    // Calls through that wrapper are safe even though no `cwd:` appears on
    // them. The binding is what matters, not where it is written — demanding it
    // at every call site would only push people to rename the wrapper.
    const wrapperBindsDir = /execFileSync\(\s*["'`]git["'`][\s\S]{0,200}?\bcwd\b/.test(src)
      || /spawnSync\(\s*["'`]git["'`][\s\S]{0,200}?\bcwd\b/.test(src);

    src.split("\n").forEach((line, i) => {
      // Comments never run. Flagging prose about the rule trains people to
      // ignore the check.
      if (/^\s*(\/\/|\*|#)/.test(line)) return;
      const at = `${rel}:${i + 1}`;

      const shell = line.match(SHELL_FORM);
      if (shell) {
        const [, dir, flags = ""] = shell;
        if (/--global|--system/.test(flags)) {
          offenders.push({ where: at, why: "writes --global/--system identity (the developer's machine, not a fixture)" });
        } else if (!dir) {
          offenders.push({ where: at, why: "no `git -C <dir>` — writes to whatever repo the process is standing in" });
        } else if (dir === "." || dir === '"$PWD"' || dir === "$PWD") {
          offenders.push({ where: at, why: `\`git -C ${dir}\` is the current directory — identical to no -C at all` });
        }
        return;
      }

      if (HELPER_FORM.test(line) || ARGV_FORM.test(line)) {
        if (/--global|--system/.test(line)) {
          offenders.push({ where: at, why: "writes --global/--system identity" });
          return;
        }
        // argv/helper forms pass the directory out-of-band: accept a `cwd:` on
        // the call, or a wrapper in this file that already binds one.
        //
        // Also accept an explicit `"-C", <dir>` in the argv itself. That is
        // STRONGER than cwd, not weaker: cwd can be inherited or changed by a
        // parent, while -C names the repo on the command git actually runs.
        // Rejecting it pushed callers toward the weaker form to satisfy the
        // checker, which is the wrong direction for a safety rule.
        // Delegate the verdict to detect() so there is exactly ONE rule.
        // scan() keeps the reporting; detect() owns the decision.
        if (detect(line, wrapperBindsDir)) {
          offenders.push({
            where: at,
            why: "argv-form `git config user.*` with no `cwd:` and no explicit `\"-C\", <dir>`",
          });
        }
        return;
      }
    });
  }
  return offenders;
}

describe("#84: git identity isolation", () => {
  test("this repo has no local user identity override", () => {
    // --local only. A global identity is correct and expected; it is the
    // repo-scoped override that silently replaces the author of every commit.
    const read = (key: string): string => {
      try {
        return execFileSync("git", ["config", "--local", "--get", key], { cwd: ROOT, encoding: "utf-8" }).trim();
      } catch {
        return ""; // exit 1 means unset, which is the passing case
      }
    };
    expect(read("user.name")).toBe("");
    expect(read("user.email")).toBe("");
  });

  test("no code writes git identity without naming a target directory", () => {
    const offenders = scan();
    expect(
      offenders,
      `unsafe git identity writes:\n${offenders.map((o) => `  ${o.where} — ${o.why}`).join("\n")}`,
    ).toEqual([]);
  });

  test("the checker detects every form it claims to", () => {
    // A checker nobody has tried to evade is a checker nobody has tested. These
    // are the exact forms the first version of this file was blind to.
    // Must be caught.
    expect(detect(`git config user.email x`)).toBe(true);
    expect(detect(`git config --global user.email x`)).toBe(true);
    expect(detect(`git config --system user.name x`)).toBe(true);
    expect(detect(`git -C . config user.name x`)).toBe(true);
    expect(detect(`git -C "$PWD" config user.name x`)).toBe(true);
    expect(detect(`execFileSync("git", ["config", "user.email", v]);`)).toBe(true);
    expect(detect(`git("config", "user.email", FIXTURE.email);`)).toBe(true);

    // Must be allowed.
    expect(detect(`git -C "$WORKSPACE" config user.email x`)).toBe(false);
    expect(detect(`execFileSync("git", ["config", "user.email", v], { cwd: tempDir });`)).toBe(false);
    expect(detect(`// git config user.email x`)).toBe(false);
  });
});

describe("the -C allowance does not open a hole", () => {
  test('explicit "-C", dir in argv is accepted', () => {
    expect(detect(`sh("git", ["-C", project, "config", "user.email", v], project);`)).toBe(false);
  });

  test("a bare argv call with neither cwd nor -C is still rejected", () => {
    expect(detect(`sh("git", ["config", "user.email", v]);`)).toBe(true);
  });

  test('-C pointing at the current directory is still rejected', () => {
    expect(detect(`spawnSync("git", ["-C", ".", "config", "user.email", v]);`)).toBe(true);
  });

  test("--global is still rejected even with -C", () => {
    expect(detect(`sh("git", ["-C", dir, "config", "--global", "user.email", v]);`)).toBe(true);
  });
});

describe("scan() and detect() cannot drift apart", () => {
  test("they agree on every line in the real corpus", () => {
    // The pin. scan() keeps its own classification so it can report WHY, and
    // detect() exists so the evasion tests have something to call. Two
    // implementations of one rule is how a checker ends up testing a copy of
    // itself — so compare them over the actual repo, not over fixtures.
    const flaggedByScan = new Set(scan().map(o => o.where));
    const flaggedByDetect: string[] = [];

    for (const rel of new Glob("{test,scripts,evals,lib,gates,hooks,workflows}/**/*.{ts,js,sh}").scanSync({ cwd: ROOT })) {
      if (rel.includes("worktrees/") || rel.includes("node_modules/")) continue;
      if (rel === SELF) continue;
      const src = readFileSync(join(ROOT, rel), "utf-8");
      // Same file-level wrapper flag scan() derives, so the comparison is
      // like-for-like. Without it the two disagree on wrapper-bound helpers
      // for a reason that is about missing context, not a differing rule.
      const wrapperBindsDir = /execFileSync\(\s*["'`]git["'`][\s\S]{0,200}?\bcwd\b/.test(src)
        || /spawnSync\(\s*["'`]git["'`][\s\S]{0,200}?\bcwd\b/.test(src);
      src.split("\n").forEach((line, i) => {
        if (detect(line, wrapperBindsDir)) flaggedByDetect.push(`${rel}:${i + 1}`);
      });
    }

    const onlyDetect = flaggedByDetect.filter(w => !flaggedByScan.has(w));
    const onlyScan = [...flaggedByScan].filter(w => !flaggedByDetect.includes(w));
    expect(
      { onlyDetect, onlyScan },
      "scan() and detect() disagree — one of them is now the wrong rule",
    ).toEqual({ onlyDetect: [], onlyScan: [] });
  });
});

describe("the -C allowance rejects directories that are just cwd", () => {
  // The first version of this allowance accepted any token after -C, so
  // `-C process.cwd()` bought an exemption while the shell form `git -C .`
  // was correctly rejected: same directory, opposite verdict.
  for (const [line, label] of [
    ['spawnSync("git", ["-C", process.cwd(), "config", "user.email", v]);', "process.cwd()"],
    ['spawnSync("git", ["-C", ".", "config", "user.email", v]);', "literal dot"],
    ['spawnSync("git", ["-C", __dirname, "config", "user.email", v]);', "__dirname"],
  ] as Array<[string, string]>) {
    test(`rejects -C ${label}`, () => {
      expect(detect(line)).toBe(true);
    });
  }

  test("still accepts a real target directory", () => {
    expect(detect('sh("git", ["-C", project, "config", "user.email", v], project);')).toBe(false);
    expect(detect('spawnSync("git", ["-C", tempDir, "config", "user.name", n]);')).toBe(false);
  });
});
