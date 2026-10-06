#!/usr/bin/env bun
/**
 * Run the test suite the way CI runs it: with no developer machine behind it.
 *
 * Issue #71. CI reported 2034 pass / 28 fail on a tree where `bun test` was
 * green locally. Twenty-four of those 28 failures were one defect wearing four
 * masks — the test asked the developer's `$HOME` a question a fresh runner
 * cannot answer:
 *
 *   - `$HOME/.pai/hooks/*.hook.ts`        (10) — exec'd a hook from a PAI install
 *   - live `gh issue view`                 (6) — read the developer's gh credentials
 *   - fixture `git commit`                 (7) — needed a global user.name/user.email
 *   - `$HOME/.claude/hooks/lib/.gate-salt` (1) — stat'd a file only this machine has
 *
 * None of them are detectable by reading the code and none fail locally, so the
 * only honest way to find them is to take the machine away. That is all this
 * script does: point HOME at an empty directory, strip GitHub credentials, and
 * run the suite. A test that passes here passes in CI for the same reason.
 *
 * Usage:
 *   bun scripts/test-clean-env.ts                    # whole suite
 *   bun scripts/test-clean-env.ts test/foo.test.ts   # targeted
 *
 * A full run takes a concurrency slot from the same pool `bun test` uses. It has
 * to: the TestSuiteGuard hook matches on the text of a Bash command, so it
 * cannot see a suite running inside a subprocess, and a runner the guard cannot
 * see is a hole in the guard rather than a tool. Targeted runs are cheap and
 * take nothing, matching how the hook treats `bun test <path>`.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireFullSuiteSlot, isFullSuiteCommand, releaseFullSuiteSlot } from "../lib/test-suite-lock";

const ROOT = join(import.meta.dir, "..");
const paths = process.argv.slice(2);
// Delegate the "is this the whole suite?" decision to the one implementation
// that already makes it. A local `paths.length === 0` looked equivalent but
// counted `--bail` as a targeted run, so `test-clean-env.ts --coverage` would
// run all 2200 tests while taking no concurrency slot — the uncapped condition
// that rebooted this machine. Two implementations of one decision is one too
// many, and the new one was the wrong one.
const isFullSuite = isFullSuiteCommand(["bun", "test", ...paths].join(" "));

/**
 * Everything that leaks the developer's machine into a test.
 *
 * XDG_CONFIG_HOME earns its place next to HOME: both `git` and `gh` read config
 * from it directly, so moving HOME alone leaves a configured machine visible
 * through the side door. GIT_CONFIG_GLOBAL is belt-and-braces for the same
 * reason — it overrides HOME outright, so an inherited value would quietly
 * restore the git identity this run is trying to remove.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // GIT_AUTHOR_* / GIT_COMMITTER_* / EMAIL override every config file, so a
  // developer with any of them exported would still get a working git identity
  // and a non-hermetic run — in exactly the identity class this script hunts.
  for (const key of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST",
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "EMAIL", "GIT_CONFIG_SYSTEM",
  ]) {
    delete env[key];
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  // Deliberately NOT setting a "this run is hermetic" marker. Nothing needs one,
  // and the only use a test could make of it is skipping itself — which is
  // precisely the defect this script exists to expose.
  return env;
}

const home = mkdtempSync(join(tmpdir(), "rungate-clean-home-"));
const sessionId = process.env.CLAUDE_SESSION_ID || `clean-env-${process.pid}`;
let slotHeld = false;

try {
  if (isFullSuite) {
    const slot = acquireFullSuiteSlot(sessionId);
    if (!slot.ok) {
      const held = (slot.holders ?? [])
        .map((h) => `${h.sessionId} (${h.ageSeconds}s)`)
        .join(", ");
      console.error(`[clean-env] refused: all full-suite slots are held${held ? ` by ${held}` : ""}.`);
      console.error(`[clean-env] wait, or run targeted paths: bun scripts/test-clean-env.ts test/foo.test.ts`);
      process.exit(2);
    }
    // A degraded acquire means the guard could not function and let the run
    // through. Say so — a cap that silently stopped capping is how the machine
    // got rebooted the first time.
    if (slot.degraded) console.error(`[clean-env] WARNING: suite guard degraded, concurrency is NOT capped`);
    slotHeld = true;
  }

  console.error(`[clean-env] HOME=${home}  gh credentials stripped  git identity unset`);
  const result = spawnSync("bun", ["test", ...paths], {
    cwd: ROOT,
    env: hermeticEnv(home),
    stdio: "inherit",
  });

  // spawnSync reports a failure to launch through .error, and signals through
  // .signal with a null status. Exiting 0 on either would report a clean suite
  // for a run that never produced a result.
  if (result.error) {
    console.error(`[clean-env] could not run the suite: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status === null) {
    console.error(`[clean-env] suite terminated by signal ${result.signal}`);
    process.exit(1);
  }
  process.exitCode = result.status;
} finally {
  if (slotHeld) releaseFullSuiteSlot(sessionId);
  rmSync(home, { recursive: true, force: true });
}
