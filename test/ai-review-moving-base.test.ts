/**
 * ai-review-moving-base.test.ts — a third party moving the base branch during
 * the job is not the reviewer writing a file (#989).
 *
 * ## The race
 *
 * `.claude` and seven siblings are restored from the base branch **twice** in
 * one job, by two different actors resolving the branch NAME at two different
 * moments:
 *
 *   1. `buildRestoreScript` — `git fetch origin +refs/heads/<base>:…` then
 *      `git checkout <base> -- <path>`, before the drift baseline.
 *   2. `anthropics/claude-code-action`, inside the review step and therefore
 *      AFTER the baseline. At the pinned SHA `5eb090f3`,
 *      `src/github/operations/restore-config.ts`: `rmSync` each path at
 *      `:304-306`, **its own** `git fetch origin <baseBranch>` at `:310-323`,
 *      `git checkout origin/<baseBranch> -- <path>` at `:325-333`.
 *
 * #836/#841 moved restore (1) above the baseline, which closes this for a
 * **static** base. It does not close it for a base that MOVES between the two
 * fetches: restore (2) then brings in bytes restore (1) never had, the
 * after-reading sees them as new, and the guard names the reviewer for a
 * commit somebody else pushed.
 *
 * Measured on #908, `origin/main` @ `b7cbabd9`: the drift step quoted blob
 * `3fd1794cd1be316d86f53ecd659e0c80f7abaebd`, which is byte-identical to that
 * file's blob on the base branch and **absent from the head** the reviewer was
 * reading. Commit `b68666d` landed between the two restores. The reviewer did
 * not write it and could not have.
 *
 * With a swarm merging, the window — about fifteen seconds, measured on run
 * `39683654861` between the baseline and the action's restore log line — is
 * the normal case rather than the edge case.
 *
 * ## Three states the old reading collapsed into one
 *
 * #989 names them and insists they stay apart:
 *
 *   1. the reviewer wrote a file — the real violation, must REFUSE
 *   2. a third party moved the base between the two restores — not a
 *      violation, must not accuse
 *   3. the comparison could not be performed — UNMEASURED, must REFUSE and
 *      must not read as clean
 *
 * ## Why this is content classification after all, and not the second decider #824 retired
 *
 * #824's AC-3 asked for exactly this and its closing comment retired it:
 * *"Implementing it on top of that would be a second decider for a question
 * already answered."* That was right **for a static base**, where the restore
 * reorder answers it. For a base that moves, nothing answers it — the reorder
 * cannot, because the second restore has not happened when the baseline is
 * taken. So there is no first decider here for this to be the second of, and
 * #824's own comment says so: *"The residual case … is real and is #989."*
 *
 * ## The comparison, and what it costs
 *
 * At drift time, `refs/remotes/origin/<base>` in the checkout is whatever the
 * ACTION's fetch left there — which is the commit the action restored from.
 * So for a changed path the question *"did the action restore this?"* is
 * answerable locally, with no new fetch and no network: does the working
 * tree's blob equal that path's blob at `origin/<base>` now?
 *
 * `read_tree` hashes with `git hash-object --no-filters`, which is the same
 * object id git stores, so the comparison is sha-to-sha.
 *
 * **What it costs, named rather than hidden.** A reviewer that writes a file
 * whose bytes exactly equal the base's copy of that path is not caught — in
 * practice, a reviewer reverting the pull request's own change. That is a
 * real gap and it is strictly narrower than the alternative this cluster
 * keeps being offered, which is excluding `.claude/**` by pattern and going
 * blind to every write under it.
 *
 * **A second cost, in the safe direction.** Under a `text`/`eol` attribute
 * that rewrites the working tree, the checked-out bytes differ from the blob
 * and the comparison does not fire — so the path stays in the refusal and the
 * run refuses exactly as it does today. The classification can fail to
 * acquit; it cannot fail toward passing.
 *
 * ## Narrowed to the paths that are actually restored twice
 *
 * Only `AI_REVIEW_UNTRUSTED_PATHS` is classified — the set this job restores,
 * a superset of the action's eight. A write to `src/` matching the base is
 * still refused, because no second restore touches `src/`. `AC-M5` is that
 * case.
 *
 * ## The cheapest wrong fix, named
 *
 * **Exclude `.claude/**` from the drift reading by pattern.** It makes every
 * instance of this symptom go away and blinds the guard to a reviewer editing
 * a rules file — which is the write #817 was filed about. `AC-M2` is the case
 * that survives it: a path under `.claude/` whose bytes match NEITHER the head
 * nor the base still refuses, so the pattern exclusion turns it red.
 *
 * **The second cheapest: #908's option 3**, punching a reviewer-writable hole
 * in the guard. `AC-M2` and `AC-M5` both red on it.
 *
 * ## What was broken to prove it
 *
 * Counts predicted before the battery ran, with the assertion each row should
 * redden named. Baseline read first. Mutations applied by hand to
 * `lib/scaffold/ai-review-step.ts`, reverted, and the file confirmed
 * byte-identical by SHA-256 — never by `git checkout --`. Over this file plus
 * `ai-review-untrusted-restore.test.ts` and `ai-review-restore-index.test.ts`.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 40 pass, 0 fail | **40 pass, 0 fail** | — |
 * | N1 the whole classification block deleted | 4 | **6 of 40** | a base that moved: original acquits, mutant names the reviewer |
 * | N2 **the cheapest wrong fix**: the agent-config directory dropped from the reading by pattern | 1, and it is AC-M2's verdict | **11 of 40** | a reviewer write under that directory: original refuses, mutant cannot see it |
 * | N3 the per-path narrowing removed, so everything is classified | 1 | **0 of 40, THEN 1 of 41** | see below — the row was 0 because the mutation was never reached |
 * | N4 the UNMEASURED refusal downgraded to a warning | 2 | **1 of 41, CONFOUNDED** | the mutant dies on `set -u` rather than degrading, so the row is about a crash. Re-run as N4b |
 * | N4b the UNMEASURED guard exits 0 instead of refusing | 1, and it is AC-M3's verdict | **1 of 41** | no base ref with a changed restored path: original exits 1, mutant exits 0 |
 * | N5 the `absent` branch collapsed into the refusal | 0 | **0 of 41, THEN 1 of 42** | see below — the branch had no case at all |
 * | N6 the blob comparison flipped to `!=` | 4 | **10 of 42** | both directions at once: every restore is accused and every reviewer write acquitted |
 *
 * ### N3 and N5 are the two rows that found something
 *
 * **N3 came back 0, and a 0 means nothing until an input is named on which
 * the mutant and the original differ.** On AC-M5's input they do not. Only
 * `tracked.ts` changes there, nothing is in the restored set, so the
 * `ambiguous` pre-check skips the whole block and the per-path narrowing
 * inside it is never reached — the mutation was applied to code the case does
 * not execute. The two checks are not a duplicate decider (one asks *is ANY
 * path ambiguous*, the other *is THIS one*), but no case told them apart.
 * `AC-M5c` is the run that does: an ambiguous path to open the block and a
 * non-restored path reverted to the base's bytes inside it. N3 is **1 of 41**
 * with it.
 *
 * **N5 came back 0 as predicted, and the prediction was right for a reason
 * worth keeping.** The `absent` branch had no case at all. The route everyone
 * reaches for — a path the PULL REQUEST introduces — is deleted by the
 * harness restore BEFORE the baseline, so both readings agree and it never
 * reaches the comparison. The route that does reach it is a third party
 * DELETING the path from the base mid-job. `AC-M1c` is that run, and N5 is
 * **1 of 42** with it.
 *
 * ### The rows that came back high
 *
 * **N2 is 11 against a predicted 1, and that is the wrong fix being refused
 * from every side.** Beyond AC-M2, dropping the directory from the reading
 * also blinds four pre-existing cases in `ai-review-restore-index.test.ts`
 * that assert an edit to a restored path is refused, and empties `ambiguous`
 * so the AC-M1/AC-M3 family stops firing at all.
 *
 * **N1 is 6 against 4**: AC-M3c and AC-M5b also red, and the prediction
 * forgot both. AC-M3 does NOT red on N1 — the old behaviour refuses too —
 * which is exactly why AC-M3c is written as the direction check beside it:
 * refusing is necessary and is not sufficient.
 *
 * **N4 is recorded rather than dropped.** The mutant exits on an unbound
 * variable instead of warning and continuing, so its count is about a crash
 * and not about the posture. N4b is the clean row.
 *
 * ## The fixture was green here and red on CI, and why
 *
 * First push: 448 pass locally, and shard 1 red with "the second restore did
 * not bring in the moved base, so the fixture is not the race" seven times.
 * The bare origin was created with `git init --bare` and no `-b`, so its HEAD
 * came from whatever default the machine's git carries. Apple's git 2.50.1
 * answers `main` — from the SYSTEM gitconfig under CommandLineTools, which
 * `env -i` does not strip, and from its own compiled default besides. An
 * ubuntu runner answers `master`. A clone then follows a HEAD naming a ref
 * that does not exist, checks out nothing, and the third party's commit lands
 * on an unborn branch whose push is rejected non-fast-forward — so the base
 * never moved and the assertion blamed the race.
 *
 * Measured, not inferred: with `init.defaultBranch=master` injected, the
 * pre-fix file is **9 of 13 red** and the fixed file is **13 of 13 green**.
 * Two repairs, because the symptom had two causes:
 *
 * - `-b main` on the bare init, and `GIT_CONFIG_SYSTEM`/`GIT_CONFIG_GLOBAL`
 *   pointed at `/dev/null`, so this file no longer reads a setting CI lacks.
 *   The difference is removed rather than the failure
 *   (`.claude/rules/checks-must-be-able-to-fail.md`).
 * - Every fixture git call now goes through `gitIn`, which REFUSES on a
 *   non-zero exit. The rejected push above was silent for a whole CI round
 *   trip; it now names itself at the call that failed.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_BASE_REMOTE_VAR,
  AI_REVIEW_UNTRUSTED_PATHS,
  buildBaselineScript,
  buildDriftScript,
  buildRestoreScript,
} from "../lib/scaffold/ai-review-step";
import { configureFixtureIdentity, initFixtureRepo } from "./helpers/git-fixture";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

type Run = { code: number; stdout: string; stderr: string };

/**
 * A git environment that reads NO config this machine happens to carry.
 *
 * `env -i` is not enough: the system gitconfig is found by a compiled-in path,
 * not through the environment, and Apple's CommandLineTools puts
 * `init.defaultBranch=main` in it. Dropping HOME therefore removed the
 * developer's `~/.gitconfig` while leaving a setting the ubuntu runner does
 * not have, which is precisely the gap a fixture must not sit in — it is the
 * difference between this suite and CI, so it is removed rather than papered
 * over. Everything the fixture needs is written into each repo's own config
 * by `test/helpers/git-fixture.ts`.
 */
const GIT_ENV = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

/**
 * Run git in `cwd` and REFUSE on a non-zero exit.
 *
 * The first cut of this file discarded `Bun.spawnSync`'s exit code, which is
 * the shell `x=$(...)` mistake in another language: a fixture step that fails
 * leaves the repository in a shape nobody asked for, and the ASSERTION three
 * calls later reports the damage rather than the cause. Seven cases came back
 * from CI saying "the fixture is not the race" when what had happened was a
 * push rejected much earlier, for a reason the output never carried.
 */
function gitIn(cwd: string, ...a: string[]): void {
  const r = Bun.spawnSync(["git", ...a], { cwd, env: GIT_ENV() });
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${a.join(" ")} exited ${r.exitCode} in ${cwd}:\n` +
        new TextDecoder().decode(r.stderr),
    );
  }
}

/**
 * Run git in `cwd` and TOLERATE a non-zero exit, deliberately.
 *
 * Only for the two calls inside `actionRestore` that reproduce upstream's own
 * tolerance: `restore-config.ts:330-332` catches a failed `git checkout` and
 * leaves a path that is absent on the base deleted, which is the whole of
 * AC-M1c's route. Checking the code there would make the fixture refuse the
 * case it exists to build.
 */
function gitMay(cwd: string, ...a: string[]): void {
  Bun.spawnSync(["git", ...a], { cwd, env: GIT_ENV() });
}

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const file = join(scratchDir("ai-review-moving-sh-"), "step.sh");
  writeFileSync(file, script);
  const r = Bun.spawnSync(["bash", file], {
    cwd,
    // A scratch HOME: the drift step walks `$HOME` for writes outside the
    // checkout (#843 finding 1), and pointing that at a developer's home
    // makes the case non-hermetic and slow.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratchDir("ai-review-moving-home-"), ...env },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/** The file this repository's own run reported, so the fixture is the case. */
const RESTORED_FILE = ".claude/rules/self-referential-tests.md";

interface Fixture {
  work: string;
  origin: string;
  git: (...a: string[]) => void;
  write: (rel: string, body: string) => void;
}

/**
 * A checkout shaped like `actions/checkout@v4` with `fetch-depth: 1` on a
 * pull request: detached at the head commit, an `origin` remote, and no
 * `refs/remotes/origin/<base>` — so the restore step's own fetch is
 * load-bearing rather than decoration.
 */
function checkout(): Fixture {
  const work = scratchDir("ai-review-moving-work-");
  const origin = scratchDir("ai-review-moving-origin-");
  const git = (...a: string[]) => gitIn(work, ...a);
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  initFixtureRepo(work);

  write("tracked.ts", "export const a = 1;\n");
  write(RESTORED_FILE, "BASE\n");
  write("CLAUDE.md", "BASE\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  // `-b main` is load-bearing on the BARE repo too, and its absence is what
  // made this file green here and red on CI. Apple's CommandLineTools ships
  // `init.defaultBranch=main` in the SYSTEM gitconfig — which `env -i` does
  // not strip — so the bare origin's HEAD was `main` on this machine and
  // `master` on an ubuntu runner. A clone then follows a HEAD pointing at a
  // ref that does not exist, checks out nothing, and every later commit and
  // push in `moveBase` lands on an unborn branch. Same defect as #71, one
  // repo over.
  gitIn(origin, "init", "-q", "--bare", "-b", "main");
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  // The pull request's own commit, editing a file inside the restored set —
  // exactly what PR #815 did.
  write(RESTORED_FILE, "THE PULL REQUEST'S OWN EDIT\n");
  git("add", "-A");
  git("commit", "-qm", "head");

  git("checkout", "-q", "--detach", "HEAD");
  git("update-ref", "-d", "refs/remotes/origin/main");

  return { work, origin, git, write };
}

/**
 * A second clone of the origin, carrying the fixture identity.
 *
 * The identity comes from `test/helpers/git-fixture.ts` rather than from a
 * `git config user.email` written here: a clone inherits no identity, and a
 * second site for the fixture identity is both a host dependency and the thing
 * `test/unit/git-identity-isolation.test.ts` scans for.
 */
function cloneOrigin(f: Fixture, prefix: string): string {
  const other = scratchDir(prefix);
  gitIn(other, "clone", "-q", `file://${f.origin}`, other);
  configureFixtureIdentity(other);
  return other;
}

/**
 * A THIRD PARTY pushes to the base branch, which is what makes this issue's
 * scenario different from #836's. Done through a second clone so the commit
 * genuinely arrives from outside this job's checkout.
 */
function moveBase(f: Fixture, body: string): void {
  const other = cloneOrigin(f, "ai-review-moving-other-");
  const g = (...a: string[]) => gitIn(other, ...a);
  mkdirSync(dirname(join(other, RESTORED_FILE)), { recursive: true });
  writeFileSync(join(other, RESTORED_FILE), body);
  g("add", "-A");
  g("commit", "-qm", "a third party's commit");
  g("push", "-q", "origin", "HEAD:refs/heads/main");
}

/**
 * The ACTION's restore, reproduced from `restore-config.ts` at the pinned SHA:
 * delete, ITS OWN fetch, checkout from `origin/<base>`. The second fetch is
 * the whole mechanism — it is what re-resolves the branch name.
 */
function actionRestore(f: Fixture): void {
  for (const p of [".claude", ".mcp.json", ".claude.json", "CLAUDE.md"]) {
    rmSync(join(f.work, p), { recursive: true, force: true });
  }
  f.git("fetch", "-q", "origin", "main");
  f.git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
  for (const p of [".claude", "CLAUDE.md"]) {
    gitMay(f.work, "checkout", "refs/remotes/origin/main", "--", p);
  }
  gitMay(f.work, "reset", "-q", "--", ".claude", "CLAUDE.md");
}

/**
 * The restore step, with a real `GITHUB_OUTPUT` — it publishes the base ref
 * the drift step classifies against (#989) and refuses without somewhere to
 * publish it, which is the same shape the credential step already uses.
 */
function runRestore(f: Fixture): Run & { baseRemote: string } {
  const out = join(scratchDir("ai-review-moving-out-"), "github-output");
  writeFileSync(out, "");
  const run = sh(buildRestoreScript(), f.work, {
    [AI_REVIEW_BASE_REF_VAR]: "main",
    GITHUB_OUTPUT: out,
  });
  const baseRemote = /^base_remote=(.*)$/m.exec(readFileSync(out, "utf-8"))?.[1] ?? "";
  return { ...run, baseRemote };
}

function runBaseline(f: Fixture): string {
  const runnerTemp = scratchDir("ai-review-moving-temp-");
  const out = join(runnerTemp, "github-output");
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), f.work, { RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: out });
  expect(run.code, `the baseline step refused:\n${run.stderr}`).toBe(0);
  const text = readFileSync(out, "utf-8");
  const path = /^path=(.*)$/m.exec(text)?.[1] ?? "";
  const sha = /^sha256=(.*)$/m.exec(text)?.[1] ?? "";
  expect(path, "the baseline wrote no path").not.toBe("");
  return `${path}\u0000${sha}`;
}

function runDrift(f: Fixture, baseline: string, opts: { baseRemote?: string } = {}): Run {
  const [path, sha] = baseline.split("\u0000");
  const env: Record<string, string> = {
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_TREE_BEFORE: path!,
    AI_REVIEW_TREE_BEFORE_SHA: sha ?? "",
  };
  const remote = opts.baseRemote ?? "refs/remotes/origin/main";
  if (remote !== "") env[AI_REVIEW_BASE_REMOTE_VAR] = remote;
  return sh(buildDriftScript(), f.work, env);
}

/** restore -> baseline -> (the action's restore, after the base moved) -> drift */
function raced(body = "A THIRD PARTY'S COMMIT\n"): { f: Fixture; baseline: string } {
  const f = checkout();
  expect(runRestore(f).code, "the restore step refused").toBe(0);
  expect(
    readFileSync(join(f.work, RESTORED_FILE), "utf-8"),
    "the first restore did not take, so the fixture is not the race",
  ).toBe("BASE\n");

  const baseline = runBaseline(f);

  moveBase(f, body);
  actionRestore(f);
  expect(
    readFileSync(join(f.work, RESTORED_FILE), "utf-8"),
    "the second restore did not bring in the moved base, so the fixture is not the race",
  ).toBe(body);

  return { f, baseline };
}

// ── AC-M1: state 2 — a third party moved the base, and is not the reviewer ──

describe("AC-M1 (#989): a base that moved between the two restores does not accuse the reviewer", () => {
  test("AC-M1: the second restore's bytes are classified as a restore, not a write", () => {
    const { f, baseline } = raced();
    const drift = runDrift(f, baseline);
    expect(
      drift.code,
      `the reviewer was blamed for a third party's commit:\n${drift.stderr}`,
    ).toBe(0);
    expect(drift.stderr, "the refusal still names the reviewer").not.toContain(
      "The reviewer modified the tree",
    );
  });

  test("AC-M1c: a third party DELETING a restored path is a restore too, not a reviewer deletion", () => {
    // Added because the battery's N5 row came back 0 as predicted, and a 0
    // is only a finding once an input is named on which the mutant and the
    // original differ. The `absent` branch had none: the route everyone
    // reaches for — a path the PULL REQUEST introduces — is deleted by the
    // harness restore BEFORE the baseline, so both readings agree and it
    // never reaches the comparison.
    //
    // This is the route that does reach it: the base carries the file when
    // this job restores, a third party DELETES it on the base during the
    // job, and the action's restore leaves it deleted
    // (restore-config.ts:330-332 — absent on base, stays deleted). The
    // after-reading then has it absent where the baseline had its content.
    // Collapse the branch and this is refused as a reviewer deleting a file.
    const f = checkout();
    expect(runRestore(f).code).toBe(0);
    const baseline = runBaseline(f);

    // The third party removes it from the base entirely.
    const other = cloneOrigin(f, "ai-review-moving-del-");
    const g = (...a: string[]) => gitIn(other, ...a);
    g("rm", "-q", "--", RESTORED_FILE);
    g("commit", "-qm", "a third party deletes it");
    g("push", "-q", "origin", "HEAD:refs/heads/main");

    actionRestore(f);
    expect(
      existsSync(join(f.work, RESTORED_FILE)),
      "the action's restore did not leave it deleted, so the fixture is not the route",
    ).toBe(false);

    const drift = runDrift(f, baseline);
    expect(
      drift.code,
      `the reviewer was blamed for a third party's deletion:\n${drift.stderr}`,
    ).toBe(0);
    expect(drift.stdout, "the deletion was subtracted in silence").toContain(RESTORED_FILE);
  });

  test("AC-M1b: it is REPORTED, not passed over in silence", () => {
    // A restore that is subtracted without a word is the same output as a
    // run in which nothing happened, and this job's standing convention is
    // that a subtraction says what it subtracted.
    const { f, baseline } = raced();
    const drift = runDrift(f, baseline);
    expect(drift.stdout, "the classified restore is invisible in the log").toContain(
      RESTORED_FILE,
    );
  });
});

// ── AC-M2: state 1 — a genuine reviewer write still refuses ─────────────

describe("AC-M2 (#989): a reviewer write is still refused after the fix", () => {
  test("AC-M2: bytes matching NEITHER the head nor the base refuse, and name the file", () => {
    // Without this the battery cannot tell the fix from simply disabling the
    // guard, which is this issue's own acceptance text. It is also the case
    // that survives the cheapest wrong fix: excluding `.claude/**` by
    // pattern makes AC-M1 green and this one red.
    const { f, baseline } = raced();
    writeFileSync(join(f.work, RESTORED_FILE), "THE REVIEWER WROTE THIS\n");

    const drift = runDrift(f, baseline);
    expect(drift.code, "a reviewer write was waved through").not.toBe(0);
    expect(drift.stderr).toContain("The reviewer modified the tree");
    expect(drift.stderr, "the refusal does not name the file").toContain(RESTORED_FILE);
  });

  test("AC-M2b: a reviewer write OUTSIDE the restored set is refused", () => {
    const { f, baseline } = raced();
    writeFileSync(join(f.work, "tracked.ts"), "export const a = 2;\n");

    const drift = runDrift(f, baseline);
    expect(drift.code, "a write to a path no restore touches was waved through").not.toBe(0);
    expect(drift.stderr).toContain("tracked.ts");
  });
});

// ── AC-M3: state 3 — a comparison that could not be taken REFUSES ───────

describe("AC-M3 (#989): an unperformable comparison is UNMEASURED, never clean", () => {
  test("AC-M3: no base remote at all — the classification cannot run, so it refuses", () => {
    const { f, baseline } = raced();
    const drift = runDrift(f, baseline, { baseRemote: "" });
    expect(
      drift.code,
      "with nothing to compare against, the changed path read as clean",
    ).not.toBe(0);
  });

  test("AC-M3b: a base remote naming a ref that is not there refuses", () => {
    const { f, baseline } = raced();
    const drift = runDrift(f, baseline, { baseRemote: "refs/remotes/origin/nonexistent" });
    expect(drift.code, "an unresolvable base ref read as clean").not.toBe(0);
  });

  test("AC-M3c: the two unmeasured states are not reported as a reviewer write", () => {
    // The direction that keeps AC-M3 from being satisfied by the OLD
    // behaviour: refusing is necessary and is not sufficient. A run nobody
    // could measure must not be reported as one somebody measured.
    const { f, baseline } = raced();
    const drift = runDrift(f, baseline, { baseRemote: "" });
    expect(
      drift.stderr,
      "an unmeasurable comparison is reported as a reviewer who wrote a file",
    ).toContain("UNMEASURED");
  });
});

// ── AC-M4: the static case #836 closed is unchanged ─────────────────────

describe("AC-M4 (#989): the base that did NOT move still behaves as #836 left it", () => {
  test("AC-M4: restore then baseline, no second restore, no drift", () => {
    const f = checkout();
    expect(runRestore(f).code).toBe(0);
    const baseline = runBaseline(f);
    const drift = runDrift(f, baseline);
    expect(drift.code, `a tree nobody touched was refused:\n${drift.stderr}`).toBe(0);
  });

  test("AC-M4b: a HARNESS restore landing late is acquitted too, and the order keeps its own reading", () => {
    // Predicted as a risk before this was written and then measured: the
    // classification acquits a late restore by THIS job as well, because its
    // bytes are also the base's. That is the correct answer — the reviewer
    // did not write them — and it costs the behavioural proxy that
    // `ai-review-untrusted-restore.test.ts` used for #836's reorder. That
    // case is repointed there, with the reason, and the ORDER itself is
    // asserted directly over both the generated and the committed workflow
    // by `orders restore before baseline`, which no content comparison can
    // satisfy.
    //
    // Asserted here as well, so the two files cannot drift apart silently:
    // if the drift step ever starts refusing a late harness restore again,
    // one of these two goes red whichever direction the change came from.
    const f = checkout();
    const baseline = runBaseline(f);
    expect(runRestore(f).code).toBe(0);
    const drift = runDrift(f, baseline);
    expect(
      drift.code,
      `a harness restore was blamed on the reviewer:\n${drift.stderr}`,
    ).toBe(0);
    expect(drift.stdout, "the classification fired without naming the file").toContain(
      RESTORED_FILE,
    );
  });
});

// ── AC-M5: the classification is narrowed to the twice-restored set ─────

describe("AC-M5 (#989): only the paths two restores touch are classified", () => {
  test("AC-M5: a non-restored path matching the base is still refused", () => {
    // `tracked.ts` is in neither restore set, so no second actor can have
    // written it. Reverting it to the base's bytes is a REVIEWER write and
    // must refuse — otherwise the classification is a hole the width of the
    // whole tree rather than the width of the race.
    const f = checkout();
    f.write("tracked.ts", "export const a = 2;\n");
    f.git("add", "-A");
    f.git("commit", "-qm", "the PR edits a non-restored file");
    expect(runRestore(f).code).toBe(0);
    const baseline = runBaseline(f);

    // The reviewer puts it back to the base's content.
    writeFileSync(join(f.work, "tracked.ts"), "export const a = 1;\n");

    const drift = runDrift(f, baseline);
    expect(
      drift.code,
      "a reviewer reverting a file no restore touches was classified as a restore",
    ).not.toBe(0);
    expect(drift.stderr).toContain("tracked.ts");
  });

  test("AC-M5c: a non-restored path is still refused in a run that ALSO has an ambiguous one", () => {
    // Added because the battery's N3 row came back 0 against a predicted 1,
    // and a 0 means nothing until an input is named on which the mutant and
    // the original differ. On AC-M5's input they do not: only `tracked.ts`
    // changes, nothing is in the restored set, so the `ambiguous` pre-check
    // skips the whole block and the per-path narrowing inside it is never
    // reached. The mutation was not applied to anything.
    //
    // The two checks are not a duplicate decider — the pre-check asks "is
    // ANY path ambiguous", the loop asks "is THIS one" — and this is the run
    // that tells them apart: an ambiguous path opens the block, and a
    // non-restored path reverted to the base's bytes must still refuse
    // inside it. Delete the per-path narrowing and this goes red; N3 is 0
    // without it.
    const f = checkout();
    f.write("tracked.ts", "export const a = 2;\n");
    f.git("add", "-A");
    f.git("commit", "-qm", "the PR edits a non-restored file too");
    expect(runRestore(f).code).toBe(0);
    const baseline = runBaseline(f);

    // The ambiguous one: the action restores a base that moved.
    moveBase(f, "A THIRD PARTY'S COMMIT\n");
    actionRestore(f);
    // And the reviewer reverts a path no restore touches.
    writeFileSync(join(f.work, "tracked.ts"), "export const a = 1;\n");

    const drift = runDrift(f, baseline);
    expect(
      drift.code,
      "a reviewer reverting a non-restored path was acquitted because another path was ambiguous",
    ).not.toBe(0);
    expect(drift.stderr).toContain("tracked.ts");
    expect(
      drift.stderr,
      "the third party's restore was dragged into the refusal with it",
    ).not.toContain(RESTORED_FILE);
  });

  test("AC-M5b: the classified set is the declared constant, not a literal", () => {
    const script = buildDriftScript();
    for (const p of AI_REVIEW_UNTRUSTED_PATHS) {
      expect(script, `${p} is restored twice and the drift step does not know it`).toContain(p);
    }
  });
});
