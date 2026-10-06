/**
 * #115 / #120: what gets staged is decided by git, not by the agent.
 *
 * ship.js asked Marcus which files it changed and made that answer
 * load-bearing for `git add`. Two behaviours fell out of one LLM-formatted
 * string, and they were the wrong way round:
 *
 *   reported nothing          -> `git add .`, stage the whole worktree
 *   reported annotated paths  -> SHIP_FAILED, discard the finished work
 *
 * Run wf_e750572e-153 died the second way with four files written and
 * fourteen new tests green. #120 was the same defect one stage later, where
 * the Verify re-implementation returned absolute paths inside its own
 * worktree and relativizePaths knew only two prefixes.
 *
 * ship.js is not importable in the Workflow sandbox, so this pulls the
 * COMMIT-STAGING block out by marker and evaluates it, then runs the shell it
 * produces against a real repository. Running it matters: the point of the
 * fix is what git actually stages, and a test that only asserted on the
 * command string would pass for a command that does not work.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

const START = "// ──── COMMIT-STAGING-START ────";
const END = "// ──── COMMIT-STAGING-END ────";

function loadGitDerivedStaging(): (dir: string) => string {
  const s = shipSource.indexOf(START);
  const e = shipSource.indexOf(END);
  if (s === -1 || e === -1) throw new Error("ship.js is missing the COMMIT-STAGING markers");
  const block = shipSource.slice(s + START.length, e);
  // shellQuote is defined elsewhere in ship.js; supply the real one.
  const shellQuote = (w: string) => `'${String(w).replace(/'/g, "'\\''")}'`;
  return new Function("shellQuote", `${block}; return gitDerivedStaging`)(shellQuote);
}

const gitDerivedStaging = loadGitDerivedStaging();

let repo: string;
let sandbox: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" });

/**
 * Run the generated snippet the way ship.js hands it to an agent: via sh.
 *
 * `cwd` is pinned to a scratch directory. The first version of this let sh
 * inherit the test runner's cwd, and when the shell-quoting mutation was
 * applied the injected `touch pwned` landed in the rungate checkout instead
 * of anywhere the assertions looked — so the injection test passed while a
 * real injection was happening, and left three stray files in the repo.
 */
function runStaging(dir: string, cwd = sandbox): { code: number; out: string } {
  try {
    const out = execFileSync("sh", ["-c", gitDerivedStaging(dir)], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const staged = () =>
  git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "commit-stage-cwd-"));
  repo = mkdtempSync(join(tmpdir(), "commit-stage-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("#115: annotated filesChanged no longer discards the work", () => {
  test("the payload that killed wf_e750572e-153 stages the real files", () => {
    // Verbatim shape from the issue: absolute worktree paths with trailing
    // prose. Every one of these would have been rejected by the shell-safety
    // validator, and the run reported SHIP_FAILED after a clean implement.
    const annotated = [
      `${repo}/lib/scaffold/defaults.ts (NEW, 165 lines — buildDefaultRoles:58, buildDefaultHooks:93)`,
      `${repo}/lib/scaffold/steps.ts (L17-18 imports; L848-857 greenfield emission site)`,
      `${repo}/scripts/scaffold-rungate-config.ts (L8 import; L96-105 writes populated roles/hooks)`,
      `${repo}/test/scaffold-greenfield-config.test.ts (NEW, 315 lines, 14 tests)`,
    ];

    mkdirSync(join(repo, "lib", "scaffold"), { recursive: true });
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "lib/scaffold/defaults.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "lib/scaffold/steps.ts"), "export const b = 2;\n");
    writeFileSync(join(repo, "scripts/scaffold-rungate-config.ts"), "export const c = 3;\n");
    writeFileSync(join(repo, "test/scaffold-greenfield-config.test.ts"), "export const d = 4;\n");

    // The annotated list is deliberately never passed anywhere. That is the
    // fix: it cannot influence staging, so it cannot break it.
    expect(annotated.length).toBe(4);

    const { code } = runStaging(repo);
    expect(code, "a completed implementation was refused at staging").toBe(0);
    expect(staged()).toEqual([
      "lib/scaffold/defaults.ts",
      "lib/scaffold/steps.ts",
      "scripts/scaffold-rungate-config.ts",
      "test/scaffold-greenfield-config.test.ts",
    ]);
  });

  test("deletions are staged, not just additions", () => {
    // A refactor that removes a file must commit a tree that still builds.
    // This does NOT discriminate `-A` from `.` — under `-C <root>` those
    // stage the same set, and a mutation swapping them correctly survives.
    // It asserts the outcome that matters regardless of which is used.
    writeFileSync(join(repo, "gone.ts"), "x\n");
    git("add", "gone.ts");
    git("commit", "-q", "-m", "add");
    rmSync(join(repo, "gone.ts"));
    writeFileSync(join(repo, "added.ts"), "y\n");

    const { code } = runStaging(repo);
    expect(code).toBe(0);
    expect(staged()).toEqual(["added.ts", "gone.ts"]);
  });

  test("an untracked file in a new directory is staged", () => {
    mkdirSync(join(repo, "deep", "nested"), { recursive: true });
    writeFileSync(join(repo, "deep/nested/new.ts"), "z\n");
    const { code } = runStaging(repo);
    expect(code).toBe(0);
    expect(staged()).toEqual(["deep/nested/new.ts"]);
  });

  test("a filename containing a space survives", () => {
    // The reason this stages via `git add -A` rather than splitting
    // `git status --porcelain` in shell: the portable splits mangle these,
    // and the NUL-safe one needs GNU `cut -z`.
    writeFileSync(join(repo, "a file with spaces.ts"), "q\n");
    const { code } = runStaging(repo);
    expect(code).toBe(0);
    expect(staged()).toEqual(["a file with spaces.ts"]);
  });

  test("SC-5: an empty worktree fails loudly and distinctly", () => {
    // Must be distinguishable from "your paths were rejected" — the old code
    // could not tell those apart, and a clean tree silently became
    // `git add .` staging nothing.
    const { code, out } = runStaging(repo);
    expect(code, "a worktree with no changes reported success").not.toBe(0);
    expect(out).toContain("RUNGATE_NO_CHANGES");
    expect(staged()).toEqual([]);
  });

  test("a directory name containing shell metacharacters is quoted, not executed", () => {
    // commitDir traces back to an agent-reported worktreePath, and ship.js
    // interpolates it into a shell string. Unquoted, `d; touch pwned` runs
    // `touch pwned` in whatever directory the shell happens to be in — which
    // is exactly what the first version of this test failed to notice,
    // because it looked for the artefact in the wrong place.
    const nasty = join(sandbox, "d; touch pwned");
    mkdirSync(nasty, { recursive: true });
    const { code } = runStaging(nasty);
    expect(code, "a non-repository directory staged successfully").not.toBe(0);

    // Assert against every directory the injected command could plausibly
    // have written to, not just the one that seemed likely.
    for (const dir of [sandbox, repo, process.cwd()]) {
      let pwned = false;
      try {
        readFileSync(join(dir, "pwned"));
        pwned = true;
      } catch {}
      expect(pwned, `the directory name executed as a command, writing into ${dir}`).toBe(false);
    }
  });
});
