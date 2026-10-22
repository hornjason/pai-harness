/**
 * ai-review-git-config-isolation.test.ts — the drift detector does not read a
 * configuration the thing it is measuring can write (#960).
 *
 * ## The defect
 *
 * `AI_REVIEW_TREE_READER` is the one reading of the tree, shared by the
 * baseline step and the drift step. It ran `git status --porcelain
 * --untracked-files=all` and `git hash-object` with no configuration
 * isolation at all — `GIT_CONFIG_GLOBAL` had zero occurrences in the module.
 * The reviewer runs as the same user, on a pool where `$HOME` persists
 * between jobs, so `~/.gitconfig` is writable by the process being measured.
 * The gate read a value the thing it gates can set.
 *
 * ## Everything below is executed, because the alternative is what #952 cost
 *
 * #952 shipped 17 green cases on a fix that did not work, because every case
 * asserted that the repaired string appeared in the emitted YAML rather than
 * that the repaired script behaved differently. A test of this change that
 * greps `buildDriftScript()` for `GIT_CONFIG_GLOBAL` would pass against a
 * `GIT_CONFIG_GLOBAL` in a bash COMMENT.
 *
 * So every case here plants a real file in a real repository, poisons a real
 * `~/.gitconfig` (valid INI — arbitrary bytes make `git status` exit 128 and
 * the step refuses UNMEASURED, which would measure git's config parser
 * instead of this change), and runs the real emitted bash twice:
 *
 * - **hardened** — `AI_REVIEW_TREE_READER` exactly as it ships;
 * - **unhardened** — the same script with every occurrence of
 *   `AI_REVIEW_GIT_ISOLATED` replaced by a bare `git`, which is the state of
 *   the file before this change.
 *
 * The unhardened run is not decoration. It is the proof that the poison
 * WORKS: a case that only asserts the hardened reading sees the plant cannot
 * tell a fix from a fixture that was never poisoned in the first place. And
 * the two variants are derived from ONE exported constant, so weakening the
 * constant collapses them onto each other and the `INVISIBLE` half reds —
 * which is what makes M1 below a real mutation and not a hope.
 *
 * ## What was measured, and which assertion each row reddens
 *
 * Run over this file alone (16 cases). `lib/scaffold/ai-review-step.ts`
 * restored from a `cp` backup after every row — never `git checkout --` —
 * and confirmed byte-identical by sha256 (`cd09ee3f…`) after the battery.
 * **Which assertion each row reddens is named, because a count that is right
 * about the wrong assertion is not coverage.**
 *
 * | Row | Mutation | Reds | Which assertions |
 * |---|---|---|---|
 * | **baseline** | unmutated | **16 pass, 0 fail** | — |
 * | **M1** | `AI_REVIEW_GIT_ISOLATED` = `"git"` — the pre-#960 file | **11 of 16** | AC-1 ×2, AC-2, AC-3 ×2, AC-4 ×2, AC-5, AC-6 hardened, AC-7 ×2 |
 * | **M2** | the three env vars dropped, `-c` flags kept | **1 of 16** | AC-7/1 only — a TEXT assertion. See UNMEASURED below |
 * | **M3** | all four `-c` flags dropped, env vars kept | **5 of 16** | AC-2, AC-3 local, AC-4 local, AC-5, AC-7/1 |
 * | **M4** | `-c core.excludesFile=/dev/null` dropped only | **2 of 16** | AC-2 local `.git/config`, AC-7/1 |
 * | **M5** | `-c core.fsmonitor=` dropped only | **2 of 16** | AC-3 local `.git/config`, AC-7/1 |
 * | **M6** | `-c core.hooksPath=/dev/null` dropped only | **2 of 16** | AC-4 local `.git/config`, AC-7/1 |
 * | **M7** | `-c safe.directory='*'` dropped only | **2 of 16** | AC-5 dubious ownership, AC-7/1 |
 * | **M8** | only the `status` call isolated, `hash-object` left bare | **1 of 16** | AC-7/2 no-bare-git |
 *
 * **Provenance, since the tree underneath this table has moved (#969).** The
 * rows above were measured on the tree #965 shipped. #969 added
 * `AI_REVIEW_IGNORED_READING` to the same `status` call, and `unharden` below
 * now strips that flag as well — without which the pre-#960 variant would be
 * a tree nobody ever shipped and three "the poison worked" halves go red
 * (AC-1, AC-2, AC-6/unhardened; measured). The counts have NOT been re-taken
 * against the post-#969 tree, so they describe the mutations on the tree they
 * name. Re-run them before citing them as current.
 *
 * **M4 to M7 red a BEHAVIOURAL case each, and the case is always the local
 * one.** That is the finding, not a detail: every `-c` flag earns its place
 * on the checkout's own `.git/config`, which the env vars cannot reach and
 * which sits inside the directory the reviewer is in. Whether the reviewer
 * can write there is the claim this gate exists to check rather than assume.
 *
 * **M2 reds one assertion and it is a text assertion, so the env-var half is
 * UNMEASURED.** With `core.excludesFile`, `core.fsmonitor` and
 * `core.hooksPath` all pinned on the command line — which outranks every
 * file scope — no poisoned key could be found that the env vars catch and
 * the `-c` flags miss. Four candidates were tried and all four are beaten by
 * the `-c` flags alone or are not config-reachable: `include.path` into a
 * file setting any of the three (`-c` still wins),
 * `status.showUntrackedFiles=no` (the explicit `--untracked-files=all` flag
 * wins), `core.sparseCheckout=true` with a reviewer-written
 * `.git/info/sparse-checkout` (measured: the modification and the untracked
 * file are both still reported, because the skip-worktree bits live in the
 * index and config alone does not set them), and a global `core.worktree`
 * (git ignores it outside local scope).
 *
 * So the env vars ship as defence in depth against keys not enumerated in
 * the `-c` list — which is what the issue asks for — and **no case here
 * witnesses them**. Said plainly, because a mutation row of ~0 presented as
 * covered is worse than no row at all.
 *
 * **M8 also reds only a structural assertion**, for the same honest reason:
 * `git hash-object --no-filters` takes the bytes off disk, and no
 * configuration key could be found that changes its answer. Isolating it is
 * consistency, not a closed vector, and AC-7/2 is the only thing holding it.
 *
 * ## The cheapest wrong fixes, named, each with a case pointed at it
 *
 * - **Isolate the `status` and stop.** It is the only call the issue quotes
 *   and it carries the headline vector. `AC-7` case 2 reds (M8): it walks
 *   the EMITTED bash of both steps for a git invocation in command position
 *   that is not behind the prefix, and `hash-object` is one.
 * - **Ship the env vars and skip the `-c` flags.** Three fewer moving parts
 *   and it closes every vector the issue's prose names, because the issue's
 *   prose only names `~/.gitconfig`. M3 reds four behavioural cases: the
 *   checkout's own `.git/config` is reviewer-reachable and the env vars do
 *   not touch it.
 * - **Refuse when `~/.gitconfig` exists.** Tempting and catastrophic:
 *   `actions/checkout` writes that file on every single job
 *   (`http.https://github.com/.extraheader`, `safe.directory`), so the gate
 *   would be red on every pull request forever. `AC-8` is the control — a
 *   `~/.gitconfig` shaped exactly like checkout's own must read exit 0.
 * - **Copy the issue's command verbatim.** It omits `safe.directory`, and
 *   neutralising the global file discards the `safe.directory` entry
 *   `actions/checkout` wrote for the workspace. On a runner whose workspace
 *   is owned by another uid, `git status` then exits 128 with *"detected
 *   dubious ownership"*, `read_tree` propagates it and the step refuses
 *   UNMEASURED on every run — the issue's own "must not become a refusal",
 *   through a different door. `AC-5` is red under it.
 *
 * ## One thing this file must not inherit
 *
 * Every other ai-review test in this repo builds its environment with
 * `GIT_CONFIG_GLOBAL: "/dev/null"` for determinism. That is precisely the
 * isolation under test, so a case written with the house helper would have
 * been green before this change and after it. This file sets `HOME` at a
 * poisoned directory and deliberately leaves `GIT_CONFIG_GLOBAL` unset, and
 * `AC-9` asserts that the harness itself has not quietly re-isolated.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_GIT_ISOLATED,
  AI_REVIEW_IGNORED_READING,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_TREE_READER,
  buildBaselineScript,
  buildDriftScript,
} from "../lib/scaffold/ai-review-step";

/** The file the reviewer wants the detector not to see. */
const PLANT = "planted-by-the-reviewer.md";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Strip the isolation back out, mechanically, from the one constant that
 * carries it. Not a hand-written copy of the old command: a copy would stay
 * green while the shipped constant was gutted, and this collapses onto the
 * hardened variant the moment the constant stops isolating anything.
 */
function unharden(script: string): string {
  // `AI_REVIEW_IGNORED_READING` goes too, and it is not optional (#969).
  // That flag enumerates ignored paths, so a plant hidden by
  // `core.excludesFile` is visible WITH it no matter what the config says —
  // leaving it in makes every "the poison worked" half of this file red, and
  // the quiet version of the same problem would be a pre-#960 variant that
  // is really pre-#960-plus-#969 and measures a tree nobody ever shipped.
  // Measured: AC-1, AC-2 and AC-6/unhardened, three of this file's sixteen.
  return script
    .split(AI_REVIEW_GIT_ISOLATED)
    .join("git")
    .split(` ${AI_REVIEW_IGNORED_READING}`)
    .join("");
}

type Variant = "hardened" | "unhardened";

function variantOf(script: string, v: Variant): string {
  return v === "hardened" ? script : unharden(script);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment a runner step actually has: a `HOME` git will read, and no
 * `GIT_CONFIG_*` of our own. Committer identity goes through `GIT_AUTHOR_*`
 * env vars rather than config, so the fixture never needs a `~/.gitconfig`
 * it did not choose to write.
 */
function stepEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    ...extra,
  };
}

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const path = join(scratchDir("ai-review-gci-script-"), "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", path], { cwd, env });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

interface Fixture {
  /** A `HOME` the fixture owns and may poison. */
  home: string;
  /** The checkout, inside `home`, the way a runner workspace is. */
  work: string;
  /** `RUNNER_TEMP`, inside `home`, the way a runner's is. */
  runnerTemp: string;
  /** Somewhere a hook can leave a marker WITHOUT tripping the outside walk. */
  marker: string;
  git: (...a: string[]) => void;
}

/**
 * A committed repository with one tracked file, plus the untracked `PLANT`
 * the reader is supposed to report. Everything the fixture writes lands
 * before any baseline is taken, so the drift step's `-newer` walk over `HOME`
 * has nothing of the fixture's to complain about.
 */
function checkout(): Fixture {
  const home = scratchDir("ai-review-gci-home-");
  const work = join(home, "work", "repo");
  const runnerTemp = join(home, "work", "_temp");
  const marker = scratchDir("ai-review-gci-marker-");
  mkdirSync(work, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", work, ...a], {
      env: stepEnv(home, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }),
    });
    if (r.exitCode !== 0) {
      throw new Error(`git ${a.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };

  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(work, PLANT), "the reviewer wrote this\n");

  return { home, work, runnerTemp, marker, git };
}

/** Run `read_tree` on its own and hand back what it printed. */
function readTree(f: Fixture, v: Variant, extraEnv: Record<string, string> = {}): Run {
  const script = `set -uo pipefail\n${variantOf(AI_REVIEW_TREE_READER, v)}\nread_tree\n`;
  return sh(script, f.work, stepEnv(f.home, extraEnv));
}

/** Point `core.excludesFile` at an ignore file that hides the plant. */
function ignoreFileHidingThePlant(f: Fixture): string {
  const p = join(f.home, "poison-ignores");
  writeFileSync(p, `${PLANT}\n`);
  return p;
}

/** Valid INI. Arbitrary bytes here would measure git's parser, not this fix. */
function writeGlobalConfig(f: Fixture, body: string): void {
  writeFileSync(join(f.home, ".gitconfig"), body);
}

/** A script that records that git executed it, outside `HOME`. */
function markerScript(f: Fixture, name: string, extra = ""): string {
  const p = join(f.marker, name);
  writeFileSync(p, `#!/bin/sh\n: > "${join(f.marker, `${name}.fired`)}"\n${extra}`);
  chmodSync(p, 0o755);
  return p;
}

function fired(f: Fixture, name: string): boolean {
  try {
    readFileSync(join(f.marker, `${name}.fired`));
    return true;
  } catch {
    return false;
  }
}

// ── AC-1: a poisoned ~/.gitconfig hides a plant from the unisolated read ──

describe("AC-1 (#960): core.excludesFile in ~/.gitconfig cannot hide a plant", () => {
  test("the unisolated reader CANNOT see it and the isolated reader can", () => {
    const f = checkout();
    writeGlobalConfig(f, `[core]\n\texcludesFile = ${ignoreFileHidingThePlant(f)}\n`);

    const before = readTree(f, "unhardened");
    expect(before.code, `the unisolated reader failed outright:\n${before.stderr}`).toBe(0);
    expect(
      before.stdout,
      "the poison did not work, so this case cannot tell a fix from a fixture that was " +
        "never poisoned — check that git still honours core.excludesFile from the global file",
    ).not.toContain(PLANT);

    const after = readTree(f, "hardened");
    expect(after.code, `the isolated reader failed outright:\n${after.stderr}`).toBe(0);
    expect(
      after.stdout,
      "a reviewer-written ~/.gitconfig still hides its own plant from the drift reading",
    ).toContain(PLANT);
  });

  test("the isolated reading is a CONTENT reading, not just a path list", () => {
    const f = checkout();
    writeGlobalConfig(f, `[core]\n\texcludesFile = ${ignoreFileHidingThePlant(f)}\n`);
    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.endsWith(PLANT));
    expect(line, "the plant is reported with no line of its own").toBeDefined();
    expect(
      line,
      "the plant came back without a hash, so the isolation restored the path and lost the content",
    ).toMatch(/^[0-9a-f]{40} /);
  });
});

// ── AC-2: the checkout's OWN .git/config, which the env vars do not reach ──

describe("AC-2 (#960): core.excludesFile in the checkout's .git/config cannot hide a plant", () => {
  test("only the -c flag covers this, and it does", () => {
    const f = checkout();
    // Local scope. `GIT_CONFIG_GLOBAL=/dev/null` does nothing to this file,
    // and this file is INSIDE the directory the reviewer is sitting in.
    f.git("config", "core.excludesFile", ignoreFileHidingThePlant(f));

    const before = readTree(f, "unhardened");
    expect(before.code, `the unisolated reader failed outright:\n${before.stderr}`).toBe(0);
    expect(before.stdout, "the local-config poison did not work; the case proves nothing").not.toContain(
      PLANT,
    );

    const after = readTree(f, "hardened");
    expect(after.code, `the isolated reader failed outright:\n${after.stderr}`).toBe(0);
    expect(
      after.stdout,
      "a core.excludesFile in the checkout's own .git/config still hides a plant — the " +
        "env vars neutralise FILES outside the repo and this one is inside it",
    ).toContain(PLANT);
  });
});

/**
 * Both executable keys, in BOTH scopes a reviewer can reach.
 *
 * `~/.gitconfig` is the scope the issue names and the env vars close it. The
 * checkout's own `.git/config` is the one that only the `-c` flags close, and
 * it is the stronger vector: the reviewer is already sitting in that
 * directory, and whether it can write there is exactly the claim the drift
 * gate exists to check rather than to assume. Measured — a local
 * `core.fsmonitor` and a local `core.hooksPath` both fire under env-var-only
 * isolation and neither fires with the `-c` flags.
 */
type Scope = "~/.gitconfig" | "the checkout's .git/config";

function poison(f: Fixture, scope: Scope, key: string, value: string): void {
  if (scope === "~/.gitconfig") writeGlobalConfig(f, `[core]\n\t${key} = ${value}\n`);
  else f.git("config", `core.${key}`, value);
}

// ── AC-3: core.fsmonitor names a command git EXECUTES ─────────────────────

describe("AC-3 (#960): core.fsmonitor cannot run the reviewer's command", () => {
  for (const scope of ["~/.gitconfig", "the checkout's .git/config"] as const) {
    test(`set in ${scope}: it runs unisolated and does not run isolated`, () => {
      const f = checkout();
      // The fsmonitor protocol wants a NUL-terminated path list on stdout;
      // `/` means "assume everything changed", which keeps the reading
      // correct while proving the process ran.
      poison(f, scope, "fsmonitor", markerScript(f, "fsmonitor", `printf '/\\0'\n`));

      const before = readTree(f, "unhardened");
      expect(before.code, `the unisolated reader failed outright:\n${before.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `git did not execute a core.fsmonitor set in ${scope}, so this case is not ` +
          `measuring the vector it claims`,
      ).toBe(true);

      rmSync(join(f.marker, "fsmonitor.fired"));
      const after = readTree(f, "hardened");
      expect(after.code, `the isolated reader failed outright:\n${after.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `the drift reading still executes a command named by core.fsmonitor in ${scope}`,
      ).toBe(false);
      expect(after.stdout, "the isolated reading lost the plant").toContain(PLANT);
    });
  }
});

// ── AC-4: core.hooksPath relocates hooks the reading fires ────────────────

describe("AC-4 (#960): core.hooksPath cannot point the reading at the reviewer's hooks", () => {
  for (const scope of ["~/.gitconfig", "the checkout's .git/config"] as const) {
    test(`set in ${scope}: post-index-change fires unisolated and not isolated`, () => {
      const f = checkout();
      const hooks = scratchDir("ai-review-gci-hooks-");
      const hook = join(hooks, "post-index-change");
      writeFileSync(hook, `#!/bin/sh\n: > "${join(f.marker, "hook.fired")}"\n`);
      chmodSync(hook, 0o755);
      poison(f, scope, "hooksPath", hooks);

      // `git status` refreshes and WRITES the index when a tracked file's
      // stat data has moved, and that write is what fires post-index-change.
      writeFileSync(join(f.work, "tracked.ts"), "export const a = 1;\n");

      const before = readTree(f, "unhardened");
      expect(before.code, `the unisolated reader failed outright:\n${before.stderr}`).toBe(0);
      expect(
        fired(f, "hook"),
        `git fired no hook from a core.hooksPath set in ${scope}, so this case is not ` +
          `measuring the vector it claims`,
      ).toBe(true);

      rmSync(join(f.marker, "hook.fired"));
      writeFileSync(join(f.work, "tracked.ts"), "export const a = 1;\n");
      const after = readTree(f, "hardened");
      expect(after.code, `the isolated reader failed outright:\n${after.stderr}`).toBe(0);
      expect(
        fired(f, "hook"),
        `the drift reading still fires hooks from a directory core.hooksPath names in ${scope}`,
      ).toBe(false);
    });
  }
});

// ── AC-5: the isolation must not create a refusal of its own ──────────────

describe("AC-5 (#960): dropping the global file must not drop actions/checkout's safe.directory", () => {
  test("an ownership-mismatched workspace still reads, and does so BECAUSE of safe.directory", () => {
    const f = checkout();
    // git's own hook for exercising the dubious-ownership path without a
    // second uid. If git ever stops honouring it the CONTROL below goes
    // green and this case reds — which is the right direction: it would mean
    // the case can no longer tell the two invocations apart.
    const mismatch = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };

    const control = sh(
      `set -uo pipefail\n${AI_REVIEW_TREE_READER.split(" -c safe.directory='*'").join("")}\nread_tree\n`,
      f.work,
      stepEnv(f.home, mismatch),
    );
    expect(
      control.code,
      "the ownership mismatch did not reproduce, so this case cannot show safe.directory " +
        "doing anything and the shipped flag is unwitnessed",
    ).not.toBe(0);
    expect(control.stdout + control.stderr).toContain("dubious ownership");

    const shipped = readTree(f, "hardened", mismatch);
    expect(
      shipped.code,
      "the isolation discarded actions/checkout's safe.directory entry, so every job on a " +
        `runner with an ownership mismatch now refuses UNMEASURED:\n${shipped.stderr}`,
    ).toBe(0);
    expect(shipped.stdout, "the reading came back empty under the mismatch").toContain(PLANT);
  });
});

// ── AC-6: the whole gate, end to end, not the reader on its own ───────────

describe("AC-6 (#960): the baseline+drift pair refuses a plant a poisoned ~/.gitconfig hides", () => {
  for (const v of ["unhardened", "hardened"] as const) {
    test(`${v}: the reviewer's write is ${v === "hardened" ? "REFUSED" : "invisible"}`, () => {
      const f = checkout();
      // Nothing planted yet: the plant is what the "reviewer" does BETWEEN
      // the two readings, which is the only thing the gate claims to measure.
      rmSync(join(f.work, PLANT));
      writeGlobalConfig(f, `[core]\n\texcludesFile = ${ignoreFileHidingThePlant(f)}\n`);

      const out = join(f.runnerTemp, "github-output");
      writeFileSync(out, "");
      const baseEnv = {
        RUNNER_TEMP: f.runnerTemp,
        GITHUB_WORKSPACE: f.work,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const baseline = sh(
        variantOf(buildBaselineScript(), v),
        f.work,
        stepEnv(f.home, { ...baseEnv, GITHUB_OUTPUT: out }),
      );
      expect(baseline.code, `the baseline step refused:\n${baseline.stderr}`).toBe(0);
      const outputs = readFileSync(out, "utf-8");
      const path = /^path=(.*)$/m.exec(outputs)?.[1] ?? "";
      const sha = /^sha256=(.*)$/m.exec(outputs)?.[1] ?? "";
      expect(path, `the baseline emitted no path:\n${outputs}`).not.toBe("");

      // The reviewer writes into the tree it was told only to read.
      writeFileSync(join(f.work, PLANT), "written while the reviewer was running\n");

      const drift = sh(
        variantOf(buildDriftScript(), v),
        f.work,
        stepEnv(f.home, {
          ...baseEnv,
          AI_REVIEW_MODE: "vertex",
          [AI_REVIEW_TREE_BEFORE_VAR]: path,
          [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
        }),
      );

      if (v === "unhardened") {
        expect(
          drift.code,
          "the poison did not work end to end, so the hardened half below proves nothing",
        ).toBe(0);
        expect(drift.stderr).not.toContain(PLANT);
        return;
      }
      expect(
        drift.code,
        `the gate waved through a write a reviewer-written ~/.gitconfig hid:\n${drift.stdout}\n${drift.stderr}`,
      ).not.toBe(0);
      expect(drift.stderr, "the refusal does not name the file").toContain(PLANT);
      expect(drift.stderr).toContain(AI_REVIEW_DRIFT_TITLE);
    });
  }
});

// ── AC-7: EVERY git invocation in both steps, not just the quoted one ─────

describe("AC-7 (#960): no git invocation in the baseline or drift step runs unisolated", () => {
  test("the prefix neutralises all four keys and both config files", () => {
    for (const fragment of [
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "-c core.fsmonitor=",
      "-c core.excludesFile=/dev/null",
      "-c core.hooksPath=/dev/null",
      "-c safe.directory='*'",
    ]) {
      expect(AI_REVIEW_GIT_ISOLATED, `the isolation prefix dropped ${fragment}`).toContain(fragment);
    }
  });

  test("the EMITTED bash of both steps has no bare git in command position", () => {
    // Per-script counts. One shared number held while both steps ran the
    // same two calls — the tree status and the content hash, both inside the
    // shared reader. #989 gave the DRIFT step three more of its own, to
    // classify a changed path against the base branch: resolve the base
    // commit, test whether the base carries the path, and read the path's
    // blob there. The baseline takes none of them, so a single expected
    // count can no longer be true of both, and raising it to 5 for the pair
    // would stop the baseline's own number from being asserted at all.
    for (const [name, script, isolated] of [
      ["baseline", buildBaselineScript(), 2],
      ["drift", buildDriftScript(), 5],
    ] as const) {
      // Remove the prefix, then look for a git that is still being RUN —
      // start of line, after `$(`, or after a shell operator. Prose that
      // mentions git inside an `echo` is preceded by other characters and is
      // not matched, which is why this is a position test and not a grep.
      const stripped = script.split(AI_REVIEW_GIT_ISOLATED).join("<isolated>");
      const bare = stripped
        .split("\n")
        .filter(l => !l.trimStart().startsWith("#"))
        .filter(l => /(?:^|[|&;(]|\$\()[ \t]*git[ \t]/.test(l));
      expect(
        bare,
        `the ${name} step runs git without the isolation prefix, so the reviewer's ` +
          `~/.gitconfig is still an input to it:\n${bare.join("\n")}`,
      ).toEqual([]);

      expect(
        (script.match(/<isolated>/g) ?? []).length,
        `the ${name} step does not interpolate the prefix at all`,
      ).toBe(0);
      expect(
        (stripped.match(/<isolated>/g) ?? []).length,
        `the ${name} step isolates a different number of git calls than expected — ` +
          `a NEW git call must be isolated and counted here, and a count that ` +
          `rose without one being added is a call nobody declared`,
      ).toBe(isolated);
    }
  });
});

// ── AC-8: the control. A NORMAL ~/.gitconfig is not a refusal ─────────────

describe("AC-8 (#960): the fix stops READING ~/.gitconfig, it does not start refusing it", () => {
  test("a ~/.gitconfig shaped like actions/checkout's own reads exit 0", () => {
    const f = checkout();
    // Byte-for-byte the shape `actions/checkout` leaves behind on every job.
    writeGlobalConfig(
      f,
      `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ***\n` +
        `[safe]\n\tdirectory = ${f.work}\n`,
    );
    const run = readTree(f, "hardened");
    expect(
      run.code,
      `a ~/.gitconfig that actions/checkout writes on EVERY job became a refusal:\n${run.stderr}`,
    ).toBe(0);
    expect(run.stdout, "the reading lost the plant").toContain(PLANT);
  });

  test("an absent ~/.gitconfig reads the same tree", () => {
    const f = checkout();
    const run = readTree(f, "hardened");
    expect(run.code, `the isolated reader refused a clean HOME:\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(PLANT);
  });
});

// ── AC-9: the harness has not re-isolated behind the cases' back ──────────

describe("AC-9 (#960): this file's own environment can still be poisoned", () => {
  test("stepEnv sets no GIT_CONFIG_* of its own", () => {
    const env = stepEnv("/tmp/anywhere");
    for (const k of Object.keys(env)) {
      expect(
        k.startsWith("GIT_CONFIG_"),
        `${k} is set by the harness, which is the isolation under test — every case in ` +
          `this file would then be green before the fix and after it`,
      ).toBe(false);
    }
    expect(env.HOME, "the cases have no HOME to poison").toBe("/tmp/anywhere");
  });

  test("the unhardened variant really is the pre-fix script", () => {
    expect(
      unharden(AI_REVIEW_TREE_READER),
      "the unhardened variant still isolates, so every INVISIBLE assertion is vacuous",
    ).not.toContain("GIT_CONFIG_GLOBAL");
    expect(unharden(AI_REVIEW_TREE_READER)).toContain("git status --porcelain --untracked-files=all");
    expect(unharden(AI_REVIEW_TREE_READER)).toContain("git hash-object --no-filters");
  });
});
