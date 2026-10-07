/**
 * #129 / SC-567 / SC-568 — the security review's scope comes from git, and an
 * unusable scope stops the run.
 *
 * Two independent holes, both measured in live runs (see #129):
 *
 *   1. rook runs in a worktree cut from `origin/main`, so the
 *      `git diff --name-only origin/main...HEAD` it was told to run is EMPTY.
 *   2. An empty scope produced a PASS. "No changed files, nothing to review"
 *      and "reviewed everything, found nothing" are the same verdict shape, so
 *      a security gate that sees nothing reports clean.
 *
 * `scripts/rook-review-scope.ts` is the fix: the workflow resolves the commit
 * and the file list from git itself and refuses to emit a scope it cannot
 * stand behind. This file proves the refusals are real.
 *
 * HOW THE NEGATIVE TESTS ARE SHOWN TO BE ABLE TO FAIL
 * (`.claude/rules/checks-must-be-able-to-fail.md`):
 *
 * Every fail-closed path in the script exits with `SCOPE_FAILURE_EXIT`, a
 * single exported constant. Each negative test runs the real script AND a
 * mutant copy whose only difference is `SCOPE_FAILURE_EXIT = 0`, and asserts
 * the mutant exits 0. That is the removal of the non-zero exit, performed and
 * observed: if a future edit makes a case pass by accident, the mutant and the
 * original agree and the test fails on the spot. An assertion that only read
 * `code !== 0` without the mutant would stay green for a script that exited 1
 * for an unrelated reason — a missing shebang, a syntax error, a bad import.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initFixtureRepo, commitFixture } from "./helpers/git-fixture";
import { parseChangedFiles, ScopeError, SCOPE_FAILURE_EXIT } from "../scripts/rook-review-scope";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "rook-review-scope.ts");

let tmpRoot: string;
let repo: string;
let headSha: string;
let baseSha: string;
/** A copy of the script with every fail-closed exit neutered to 0. */
let mutantScript: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync("bun", [script, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const runScope = (args: string[], env?: NodeJS.ProcessEnv) => runScript(SCRIPT, args, env);
const runMutant = (args: string[], env?: NodeJS.ProcessEnv) => runScript(mutantScript, args, env);

/**
 * The script runs in a temp directory as a mutant, so it must not reach back
 * into `lib/` through a relative import. Asserted rather than assumed — a
 * later refactor that adds one would turn every mutant run into a module
 * resolution error, which exits non-zero and would make the mutation look
 * like it had been rejected on the merits.
 */
function buildMutant(dest: string): void {
  const src = readFileSync(SCRIPT, "utf-8");
  const marker = "export const SCOPE_FAILURE_EXIT = 1;";
  const occurrences = src.split(marker).length - 1;
  expect(occurrences).toBe(1);
  expect(src).not.toMatch(/from\s+["']\.\.?\//);
  writeFileSync(dest, src.replace(marker, "export const SCOPE_FAILURE_EXIT = 0;"));
}

beforeAll(() => {
  // realpath: on macOS /tmp is a symlink to /private/tmp, and git reports the
  // resolved path back, so an unresolved base makes the path comparisons miss.
  tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), "rook-scope-"));

  repo = join(tmpRoot, "repo");
  mkdirSync(repo);
  initFixtureRepo(repo, "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  commitFixture(repo, "base");
  baseSha = git("rev-parse", "HEAD");

  git("checkout", "-b", "feature");
  mkdirSync(join(repo, "lib"));
  writeFileSync(join(repo, "lib", "a.ts"), "export const a = 1\n");
  writeFileSync(join(repo, "lib", "b.ts"), "export const b = 2\n");
  commitFixture(repo, "feature work");
  headSha = git("rev-parse", "HEAD");

  mutantScript = join(tmpRoot, "rook-review-scope.mutant.ts");
  buildMutant(mutantScript);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("rook-review-scope — success path", () => {
  test("prints the resolved commit and the git-derived file list on stdout", () => {
    const { code, stdout, stderr } = runScope([repo, "main"]);
    expect({ code, stderr }).toMatchObject({ code: 0 });

    const scope = JSON.parse(stdout);
    expect(scope.commit).toBe(headSha);
    expect(scope.base).toBe(baseSha);
    expect(scope.baseRef).toBe("main");
    expect([...scope.files].sort()).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  test("stdout is machine-readable on its own — diagnostics go to stderr", () => {
    const { stdout, stderr } = runScope([repo, "main"]);
    // The whole of stdout parses. A diagnostic line leaking in here is the
    // defect: the caller is `workflows/ship.js`, which parses this.
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain("rook-scope:");
  });

  test("an explicit head ref reviews that commit, not the worktree's HEAD", () => {
    // SC-567: the worktree rook is handed may sit on origin/main. The scope is
    // whatever commit the workflow names, so naming it must actually work.
    const { code, stdout } = runScope([repo, "main", headSha]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).commit).toBe(headSha);
  });
});

describe("rook-review-scope — the file list comes only from git", () => {
  test("a caller-supplied file list is refused, not merged in", () => {
    // The #115 defect: an LLM-formatted field decided what was in scope.
    // Anything that looks like a file list is rejected outright rather than
    // ignored, so a caller that thinks it is narrowing the scope finds out.
    for (const extra of [["--files", "lib/a.ts"], ["--files=lib/a.ts"], ["lib/a.ts"]]) {
      const { code, stdout } = runScope([repo, "main", headSha, ...extra]);
      expect({ extra, code }).toMatchObject({ extra, code: SCOPE_FAILURE_EXIT });
      expect(stdout).toBe("");

      const mutant = runMutant([repo, "main", headSha, ...extra]);
      expect({ extra, code: mutant.code }).toMatchObject({ extra, code: 0 });
    }
  });

  test("a ref that could be read as an option is refused", () => {
    const { code, stdout } = runScope([repo, "--upload-pack=touch pwned"]);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");
  });
});

describe("rook-review-scope — empty scope is a hard failure (SC-568)", () => {
  test("zero changed files exits non-zero and prints no scope", () => {
    // head === base: exactly the live failure — a worktree cut from the base
    // ref, where `git diff base...HEAD` is empty.
    const { code, stdout, stderr } = runScope([repo, headSha, headSha]);

    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/no changed files/i);
    // Not merely "no files listed" — nothing on stdout at all, so there is no
    // partial scope for a caller to read as a successful empty review.
    expect(stdout).toBe("");
  });

  test("...and the non-zero exit is what the assertion above rests on", () => {
    const mutant = runMutant([repo, headSha, headSha]);
    expect(mutant.code).toBe(0);
    expect(mutant.stderr).toMatch(/no changed files/i);
  });
});

describe("rook-review-scope — a missing report is a hard failure", () => {
  test("a base ref git cannot resolve exits non-zero", () => {
    const { code, stdout, stderr } = runScope([repo, "origin/does-not-exist"]);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/does-not-exist/);

    expect(runMutant([repo, "origin/does-not-exist"]).code).toBe(0);
  });

  test("a worktree that is not a repository exits non-zero", () => {
    const notARepo = join(tmpRoot, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });

    const { code, stdout } = runScope([notARepo, "main"]);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([notARepo, "main"]).code).toBe(0);
  });

  test("a worktree path that does not exist exits non-zero", () => {
    const missing = join(tmpRoot, "no-such-worktree");
    const { code, stdout } = runScope([missing, "main"]);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([missing, "main"]).code).toBe(0);
  });

  test("no arguments at all exits non-zero", () => {
    const { code, stdout } = runScope([]);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([]).code).toBe(0);
  });
});

describe("rook-review-scope — a malformed report is a hard failure", () => {
  /**
   * Shim `git` on PATH so the diff step returns something that is not a
   * NUL-separated path list, while every other git call still works.
   *
   * This case cannot be produced with the real git, which is the reason to
   * force it: the handling of it would otherwise never execute, and untested
   * fail-closed handling is how fail-OPEN handling survives review.
   */
  function shimDir(diffOutput: string): string {
    const dir = mkdtempSync(join(tmpRoot, "shim-"));
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    writeFileSync(
      join(dir, "git"),
      `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then\n    printf %s ${JSON.stringify(diffOutput)}\n    exit 0\n  fi\ndone\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(dir, "git"), 0o755);
    return dir;
  }

  const withShim = (out: string) => ({ PATH: `${shimDir(out)}:${process.env.PATH}` });

  test("a report that is not a NUL-separated list exits non-zero", () => {
    const env = withShim('{"files":["lib/a.ts"]}\n');

    const { code, stdout, stderr } = runScope([repo, "main"], env);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/not a NUL-terminated|unparseable/i);

    expect(runMutant([repo, "main"], env).code).toBe(0);
  });

  test("a report holding an absolute path exits non-zero", () => {
    // git never emits one for an in-repo diff, so this is git not being git.
    // Passing it through would hand the reviewer a path outside the worktree.
    const env = withShim("/etc/passwd\0");

    const { code, stdout } = runScope([repo, "main"], env);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([repo, "main"], env).code).toBe(0);
  });

  test("a report holding a traversing path exits non-zero", () => {
    const env = withShim("../../../etc/shadow\0");

    const { code, stdout } = runScope([repo, "main"], env);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([repo, "main"], env).code).toBe(0);
  });

  test("a report that is only NUL padding exits non-zero", () => {
    const env = withShim("\0\0");

    const { code, stdout } = runScope([repo, "main"], env);
    expect(code).toBe(SCOPE_FAILURE_EXIT);
    expect(stdout).toBe("");

    expect(runMutant([repo, "main"], env).code).toBe(0);
  });
});

describe("parseChangedFiles — never returns a scope it cannot stand behind", () => {
  // The CLI cases above prove the exits; these pin the classification, so a
  // "missing" report cannot quietly be reclassified as "empty" (which a future
  // caller might decide is benign).
  const kindOf = (raw: unknown): string => {
    try {
      parseChangedFiles(raw);
      return "RETURNED";
    } catch (e) {
      return e instanceof ScopeError ? e.kind : `THREW ${(e as Error).message}`;
    }
  };

  test("a well-formed report is the only input that returns", () => {
    expect(parseChangedFiles("lib/a.ts\0lib/b.ts\0")).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(parseChangedFiles("lib/a.ts\0")).toEqual(["lib/a.ts"]);
  });

  test("a missing report is 'missing'", () => {
    expect(kindOf(undefined)).toBe("missing");
    expect(kindOf(null)).toBe("missing");
  });

  test("a report that is not a list is 'not-a-list'", () => {
    expect(kindOf(42)).toBe("not-a-list");
    expect(kindOf(["lib/a.ts"])).toBe("not-a-list");
    expect(kindOf({ files: ["lib/a.ts"] })).toBe("not-a-list");
    expect(kindOf(true)).toBe("not-a-list");
  });

  test("a report that is not NUL-terminated is 'unparseable'", () => {
    expect(kindOf("lib/a.ts\nlib/b.ts\n")).toBe("unparseable");
    expect(kindOf('{"files":[]}')).toBe("unparseable");
    expect(kindOf("lib/a.ts\0lib/b.ts")).toBe("unparseable");
  });

  test("a report holding a path git would not emit is 'unparseable'", () => {
    expect(kindOf("/etc/passwd\0")).toBe("unparseable");
    expect(kindOf("../outside.ts\0")).toBe("unparseable");
    expect(kindOf("lib/../../outside.ts\0")).toBe("unparseable");
    expect(kindOf("lib/a.ts\0\0")).toBe("unparseable");
  });

  test("a well-formed report with zero entries is 'empty'", () => {
    expect(kindOf("")).toBe("empty");
  });

  test("no input of any shape yields an empty list", () => {
    const inputs: unknown[] = [
      undefined, null, "", "\0", "\0\0", 0, 42, true, false, [], ["lib/a.ts"],
      {}, { files: [] }, "lib/a.ts", "[]", "{}", "\n", "   ", "/etc/passwd\0",
    ];
    for (const raw of inputs) {
      let returned: string[] | undefined;
      try {
        returned = parseChangedFiles(raw);
      } catch {
        continue;
      }
      // Reached only when parseChangedFiles returned. The scope must be real.
      expect({ raw, returned }).toMatchObject({ raw });
      expect(returned!.length).toBeGreaterThan(0);
    }
  });
});
