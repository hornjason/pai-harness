/**
 * Git fixture repos that do not borrow the developer's machine.
 *
 * Issue #71. Seven CI failures across six test files came from fixture repos
 * built with a bare `git init` followed by `git commit`:
 *
 *   fatal: empty ident name (for <runner@...>) not allowed
 *   fatal: invalid reference: main
 *
 * Both are the same mistake. `git init` inherits the initial branch name and the
 * author identity from the developer's global config, so a fixture repo is only
 * reproducible on a machine that already has one. Jason's `~/.gitconfig` sets
 * `init.defaultBranch=main` and an identity; a fresh GitHub runner has neither,
 * so the fixtures were silently depending on the host and the suite was green
 * locally and red in CI for six months of commits.
 *
 * The fix belongs here rather than in `.github/workflows/ci.yml`. Configuring
 * the runner would turn CI green while leaving the real defect in place: the
 * next contributor to clone this repo onto a fresh machine would hit exactly
 * the same seven failures, and so would any consumer that inherits these tests
 * through the scaffold. A fixture should carry its own identity.
 */

import { execFileSync } from "child_process";

/** Committer the fixtures attribute to — never the developer running the suite. */
const FIXTURE_IDENTITY = {
  name: "rungate fixtures",
  email: "fixtures@rungate.invalid",
} as const;

/**
 * `git init` a reproducible fixture repo.
 *
 * Every setting is written to the repo's own config rather than passed through
 * the environment, so it survives nested `execSync` calls in the tests that use
 * these fixtures — several of them shell out to the scaffold, which runs git
 * again in a subprocess that would not inherit `-c` flags.
 */
export function initFixtureRepo(cwd: string, branch = "main"): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

  // -b pins the initial branch. Without it the name comes from the host's
  // init.defaultBranch, which is how `git worktree add ... main` hit
  // "invalid reference: main" on a runner that defaulted to master.
  git("init", "-b", branch);
  git("config", "user.email", FIXTURE_IDENTITY.email);
  git("config", "user.name", FIXTURE_IDENTITY.name);
  // A developer with commit.gpgsign=true globally cannot sign as a fake identity,
  // so the fixture would fail for them and nobody else — the same class of
  // host dependency this helper exists to remove.
  git("config", "commit.gpgsign", "false");
}

/**
 * Stage and commit inside a fixture repo.
 *
 * `--allow-empty` because several callers commit a fixture tree that the
 * scaffold has not modified yet, and a no-op commit failing the run would be a
 * fixture artefact rather than a real signal.
 */
export function commitFixture(
  cwd: string,
  message: string,
  opts: { paths?: string[]; date?: string } = {},
): void {
  const env = opts.date
    ? { ...process.env, GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date }
    : process.env;
  const run = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env });

  run("add", ...(opts.paths?.length ? opts.paths : ["-A"]));
  run("commit", "--allow-empty", "-m", message);
}
