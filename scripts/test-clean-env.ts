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
 * only honest way to find them is to take the machine away.
 *
 * ## The environment was only half of it (#168)
 *
 * The sentence that used to end the paragraph above — "a test that passes here
 * passes in CI for the same reason" — was absolute and wrong. This script
 * stripped the developer's *environment* and ran in the developer's
 * *checkout*: a full clone with every ref and all of history. CI runs
 * `actions/checkout@v4`, which fetches one commit onto a detached HEAD with no
 * local branches. On 2026-10-07 this reported 2998 pass / 0 fail on a tree
 * where CI reported 2 fail, and both were real — `test/prior-branch.test.ts`
 * counts `main..<ref>`, which resolves here and does not resolve there.
 *
 * So the run now happens inside a CI checkout built to match: a shallow clone
 * at the workflow's own `fetch-depth`, detached, with the local branches a
 * `git clone` invents deleted and the workflow's own fetch steps replayed.
 * The shape is read out of `.github/workflows/ci.yml` rather than assumed —
 * see `lib/ci-checkout.ts` for why that distinction is load-bearing. A
 * hardcoded "shallow and no main" model was wrong the day it was written,
 * because #347 had already added a fetch of `origin/main` to the job.
 *
 * ## what this does NOT model
 *
 * Six things, listed as `UNMODELLED` in `lib/ci-checkout.ts` and printed on
 * every run: the runner OS, a fresh `bun install`, the bun version, the
 * pull-request merge commit, network and API availability, and files git
 * ignores. The claim this replaces failed by being unqualified, so the
 * replacement is qualified, in writing, where a reader of the output sees it.
 *
 * The bun version is still unmodelled — this runs whatever is on PATH, and
 * nothing here installs a runtime — but since #622 it is no longer
 * unreported: the run prints the version it is under and says whether it
 * matches `ci.bunVersion`, so a pasted result carries its own provenance
 * and a run on the wrong runtime announces itself instead of looking
 * identical to a run on the right one.
 *
 * Usage:
 *   bun scripts/test-clean-env.ts                    # whole suite, CI-shaped checkout
 *   bun scripts/test-clean-env.ts test/foo.test.ts   # targeted, CI-shaped checkout
 *   bun scripts/test-clean-env.ts --no-ci-checkout   # the developer's tree, env stripped only
 *
 * A full run takes a concurrency slot from the same pool `bun test` uses. It has
 * to: the TestSuiteGuard hook matches on the text of a Bash command, so it
 * cannot see a suite running inside a subprocess, and a runner the guard cannot
 * see is a hole in the guard rather than a tool. Targeted runs are cheap and
 * take nothing, matching how the hook treats `bun test <path>`.
 */

import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { acquireFullSuiteSlot, isFullSuiteCommand, releaseFullSuiteSlot } from "../lib/test-suite-lock";
import { CLEAN_ENV_REFUSE_EXIT, prepareCiCheckout, type Runner } from "../lib/ci-checkout";
import { bunVersionDecision, bunVersionReading } from "../lib/bun-version";

const ROOT = join(import.meta.dir, "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const CI_JOB = "test";

const argv = process.argv.slice(2);
const modelCheckout = !argv.includes("--no-ci-checkout");
const paths = argv.filter(a => a !== "--no-ci-checkout");
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

const run: Runner = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Translate the library's outcome into an exit, and nothing else.
 *
 * The decision itself lives in `prepareCiCheckout` because, measured, a
 * refusal written inline here could be replaced with "warn and run in the
 * working tree anyway" and nothing went red. That is the worst fail-open
 * this change could produce: a caller who asked for the strict check, was
 * told it could not be built, and got the unmodelled run #168 is about,
 * reported as the strict one.
 */
function buildCiCheckout(source: string): string {
  const outcome = prepareCiCheckout({
    source,
    workflowPath: CI_WORKFLOW,
    jobName: CI_JOB,
    tmpRoot: mkdtempSync(join(tmpdir(), "rungate-ci-checkout-")),
    readFile: p => readFileSync(p, "utf-8"),
    run,
    carryOver: (rel, from, to) => {
      const src = join(from, rel);
      if (!existsSync(src)) { rmSync(join(to, rel), { recursive: true, force: true }); return; }
      cpSync(src, join(to, rel), { recursive: true });
    },
    link: (from, to) => symlinkSync(from, to),
    exists: existsSync,
    log: line => console.error(`[clean-env] ${line}`),
  });

  if (!outcome.ok) {
    console.error(`[clean-env] refused: ${outcome.why}`);
    console.error(`[clean-env] ${outcome.hint}`);
    process.exit(CLEAN_ENV_REFUSE_EXIT);
  }
  return outcome.dir;
}

const home = mkdtempSync(join(tmpdir(), "rungate-clean-home-"));
const sessionId = process.env.CLAUDE_SESSION_ID || `clean-env-${process.pid}`;
let slotHeld = false;
let checkoutDir: string | null = null;

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
  // #622. A pasted result used to carry no record of the runtime that
  // produced it, and the runtime was the one thing CI did not share — CI
  // resolved `bun-version: latest` while this ran whatever was on PATH. One
  // line, in the same reported block as the checkout and the UNMODELLED
  // list, and it is one line in all three states: a mismatch line that
  // spelled the running version twice would report two provenance lines for
  // one run.
  const bun = bunVersionDecision(ROOT);
  console.error(
    `[clean-env] ${bunVersionReading({ running: Bun.version, declared: bun.version, where: bun.where }).line}`,
  );
  if (modelCheckout) {
    checkoutDir = buildCiCheckout(ROOT);
  } else {
    console.error(`[clean-env] --no-ci-checkout: running in the working tree, so any test that depends on a ref or on history is NOT modelled (#168)`);
  }

  const result = spawnSync("bun", ["test", ...paths], {
    cwd: checkoutDir ?? ROOT,
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
  // dirname, not the clone: the temp parent holds it, and leaving a 150MB
  // clone per run behind would fill /tmp within a day of ordinary use.
  if (checkoutDir) rmSync(dirname(checkoutDir), { recursive: true, force: true });
}
