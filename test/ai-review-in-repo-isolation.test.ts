/**
 * ai-review-in-repo-isolation.test.ts — the doors #965 could not close from
 * outside the repository (#969), and the restore step's own git calls (#967).
 *
 * ## What #965 left open
 *
 * PR #965 put `AI_REVIEW_GIT_ISOLATED` in front of the two git calls in
 * `AI_REVIEW_TREE_READER`. That closes the GLOBAL config door: the reviewer
 * can no longer point `core.excludesFile` at its own ignore file, relocate
 * hooks, or name an fsmonitor command through a `~/.gitconfig` it wrote.
 *
 * Three doors are inside the checkout the reviewer sits in, and #965 names
 * them in its own `## Scope` paragraph as out of scope:
 *
 * - `.git/info/exclude` — fixed path, never reported by `git status` at any
 *   setting, and `core.excludesFile=/dev/null` does not touch it;
 * - `.gitignore` at any depth, including one that hides itself;
 * - `.git/config`, whose `core.*` keys the `-c` flags DO outrank — measured
 *   by `test/ai-review-git-config-isolation.test.ts` AC-2/3/4, and the
 *   control here is AC-5.
 *
 * **"Neutralise them" and "review them" are the same action for the middle
 * one**, which is why this file does not neutralise anything. A reader that
 * ignores `.gitignore` reports every build artefact as an untracked plant and
 * refuses every pull request, which is #871's cheapest wrong fix. The fix is
 * `--ignored=matching`: the ignore files keep working and the reader stops
 * depending on them, because an ignored path is still enumerated and still
 * cancels against the baseline.
 *
 * ## Everything below is executed
 *
 * #952 shipped 17 green cases over a fix that did not work, because every one
 * asserted that the repaired string appeared in the emitted YAML. So every
 * behavioural case here plants a real file in a real repository, poisons a
 * real in-repo file or a real `~/.gitconfig`, and runs the real emitted bash
 * twice — hardened, and with the mechanism stripped back out MECHANICALLY
 * from the single constant that carries it:
 *
 * | issue | the one constant | stripped to |
 * |---|---|---|
 * | #969 | `AI_REVIEW_IGNORED_READING` | removed from the `status` line |
 * | #967 | `AI_REVIEW_GIT_KEYS_ONLY` | a bare `git` |
 *
 * A hand-written copy of the old command would stay green while the shipped
 * constant was gutted. These collapse onto the hardened variant the moment
 * the constant stops carrying anything, which is what makes the INVISIBLE
 * halves real.
 *
 * ## The measured battery, and WHICH assertion each row reddens
 *
 * Run over this file alone (21 cases), except M6 which is counted over this
 * file plus `test/ai-review-git-config-isolation.test.ts` (37) because the
 * key list it mutates is shared with that file's subject.
 * `lib/scaffold/ai-review-step.ts` was restored from a `cp` backup after
 * every row — never `git checkout --` — and confirmed byte-identical by
 * sha256 (`20784e94…`) afterwards. **The baseline row was read before any
 * mutation row.** Every count was predicted before the battery ran; the
 * `Predicted` column is that prediction, kept rather than quietly corrected,
 * because a row that MOVED is the finding.
 *
 * **Which assertion each row reddens is named, not just how many: a count
 * that is right about the wrong assertion is not coverage.**
 *
 * | Row | Mutation | Predicted | Measured | Which assertions |
 * |---|---|---|---|---|
 * | **baseline** | unmutated | 21 pass, 0 fail | **21 pass, 0 fail** | — |
 * | **M1** | `${AI_REVIEW_IGNORED_READING}` removed from the `status` line — the pre-#969 reader | 6 | **9 of 21** | AC-1 ×2, AC-2, AC-3, AC-4/hardened, AC-6 ×3, AC-12/1 |
 * | **M2** | `AI_REVIEW_GIT_KEYS_ONLY` = `"git"` — the pre-#967 restore step | 6 | **5 of 21** | AC-7 ×2, AC-8, AC-10/bare-git, AC-10/no-env |
 * | **M3** | `AI_REVIEW_GIT_KEYS_ONLY` = `AI_REVIEW_GIT_ISOLATED` — the shape #967 rejects | 2 | **2 of 21** | AC-9/insteadOf, AC-10/no-env |
 * | **M4** | `--ignored=traditional` instead of `matching` | 1 | **3 of 21** | AC-6/volume, AC-6/limit, AC-3 |
 * | **M5** | the porcelain status letters put back into `read_tree`'s output | 1 | **2 of 21** | AC-6/cancels, AC-1/content-hash |
 * | **M6** | `-c core.fsmonitor=` dropped from the shared key list | 3 | **5 of 37** | AC-7 ×2, AC-10/one-key-list, and the #960 file's AC-3 local and AC-7/fragments |
 *
 * **Before believing any row, the input on which mutant and original differ,
 * named and run rather than assumed.** M1: a `.git/info/exclude` holding one
 * line — the original reports `<sha1> planted-by-the-reviewer.md`, the mutant
 * reports nothing. M2 and M6: a `~/.gitconfig` naming a marker-writing
 * `core.fsmonitor` — the marker exists after the mutant's restore step and
 * not after the original's. M3: an `origin` of `rungate-test://upstream` with
 * only a `~/.gitconfig` `insteadOf` to resolve it — the original fetches
 * (exit 0), the mutant exits 128 with `'remote-rungate-test' is not a git
 * command`. M4: a tree with 60 files under an ignored `node_modules/` — the
 * original reads 1 line for it, the mutant 60. M5: the same tree before and
 * after one `.git/info/exclude` write — the original's two readings are
 * byte-identical, the mutant's differ by `??` against `!!`.
 *
 * **Three rows came back HIGH, and the extra reds are the real kind — every
 * one of them is about the mutated behaviour, and no row collapses the file.**
 * M1's three extras: the plant has no line at all so its hash assertion has
 * nothing to read; the cancellation case sees a reading that DID change on an
 * ignore-state change; and the limit case's own control — "the fixture built
 * an ignored directory" — is false, because a pre-#969 reader cannot see one.
 * M4's two extras are the point of choosing `matching`: `traditional`
 * enumerates `build/artifact.js` and it makes the `node_modules/` write
 * visible, so the UNMEASURED limit case correctly reds under the setting that
 * would close it. M5's extra is the hash assertion reading `!! <sha1> path`.
 *
 * **One row came back LOW and it is recorded rather than smoothed.** M2 was
 * predicted to red AC-12/2 as well; it does not. With the prefix set to a
 * bare `git`, `unprefix` becomes the identity and AC-12/2's two assertions
 * are both satisfied by the pre-#967 script. **AC-12/2 is therefore a
 * vacuity guard against a stripper that fails to strip, not a witness of
 * M2** — its witnesses are AC-7, AC-8 and AC-10.
 *
 * **M3 is the row that argues the deliverable.** #967's real decision is the
 * SHAPE, not the hardening: dropping #965's full prefix in front of a network
 * call discards a proxy, a CA bundle or an `insteadOf` rewrite that a
 * self-hosted runner legitimately keeps in `~/.gitconfig`. AC-9 measures that
 * directly rather than arguing it — the restore step fetches through an
 * `insteadOf` rewrite under the shipped prefix and exits 128 under #965's.
 *
 * ## The cheapest wrong fixes, named, each with a case pointed at it
 *
 * - **#969: hash `.git/info/exclude`, `.gitignore` and `.git/config` into the
 *   reading as synthetic lines.** The issue offers it, and it is rejected in
 *   writing in `AI_REVIEW_IGNORED_READING`'s docblock. It watches the
 *   dependence instead of removing it, and it manufactures the false drift
 *   `read_tree` dropped the status letters to avoid (#815) — an ignore-state
 *   change that moves a path from `??` to `!!` currently cancels. **AC-6/cancels
 *   is the case pointed at it** (M5), and it survives that repair
 *   non-vacuously: a synthetic hash line turns that case red.
 * - **#969: use `--ignored=traditional`, which sees strictly more.** It
 *   enumerates every file inside an ignored directory and `read_tree` spawns
 *   one `hash-object` per path — 1508 lines on this repository's own checkout
 *   against 1. **AC-6/volume is red under it** (M4).
 * - **#967: paste #965's prefix in front of the restore step.** One line, and
 *   it closes both measured execution vectors. It also breaks the fetch on
 *   the runners the hardening exists for. **AC-9 is red under it** (M3).
 * - **#967: harden `rm`/`checkout` and leave the `fetch` alone**, since the
 *   fetch is the one with the network trade-off. The `fetch` is the ONLY call
 *   that fires the `reference-transaction` hook. **AC-8 is red under it.**
 *
 * ## UNMEASURED, said out loud
 *
 * 1. **A write inside a directory that was already collapsed-ignored at
 *    baseline** — `node_modules/evil.js` — is still invisible. `matching`
 *    reports the directory as one entry in both readings and the entry does
 *    not change. Measured in AC-6/limit, which ASSERTS the blindness so it is
 *    recorded rather than implied. Unchanged by this PR, not closed by it.
 * 2. **The env-var half of the restore step's prefix does not exist**, by
 *    choice (#967). A `~/.gitconfig` key outside the three in
 *    `AI_REVIEW_GIT_NEUTRALISED_KEYS` that makes `fetch`, `rm`, `cat-file` or
 *    `checkout` execute something is still read by the restore step. No case
 *    here witnesses a key the env vars would catch and the `-c` flags miss —
 *    #965 looked for one over the reader and found none, and that search is
 *    not repeated here.
 * 3. **`.git/config` as a #969 door is covered by #965's `-c` flags, not by
 *    anything in this PR.** AC-5 is the control that says so by measurement
 *    rather than by citation; the behavioural cases for it live in
 *    `test/ai-review-git-config-isolation.test.ts`.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_GIT_ISOLATED,
  AI_REVIEW_GIT_KEYS_ONLY,
  AI_REVIEW_GIT_NEUTRALISED_KEYS,
  AI_REVIEW_IGNORED_READING,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_TREE_READER,
  buildBaselineScript,
  buildDriftScript,
  buildRestoreScript,
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

type Variant = "hardened" | "unhardened";

/**
 * Strip #969's mechanism back out, from the one constant that carries it.
 * The leading space goes with it, so the pre-#969 `status` line is recovered
 * exactly rather than left with a trailing space nobody would notice.
 */
function unignore(script: string): string {
  return script.split(` ${AI_REVIEW_IGNORED_READING}`).join("");
}

/** Strip #967's mechanism back out, from the one constant that carries it. */
function unprefix(script: string): string {
  return script.split(AI_REVIEW_GIT_KEYS_ONLY).join("git");
}

function readerVariant(v: Variant): string {
  return v === "hardened" ? AI_REVIEW_TREE_READER : unignore(AI_REVIEW_TREE_READER);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment a runner step actually has: a `HOME` git will read, and no
 * `GIT_CONFIG_*` of our own. The house helper used by every other ai-review
 * test sets `GIT_CONFIG_GLOBAL=/dev/null`, which is part of the isolation
 * under test — a case written with it would be green before the fix and
 * after it. AC-11 asserts this one has not quietly re-isolated.
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
  const path = join(scratchDir("ai-review-ir-script-"), "step.sh");
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
  /** The bare repository `origin` points at, for the restore step's fetch. */
  origin: string;
  git: (...a: string[]) => void;
  write: (rel: string, body: string) => void;
}

/**
 * A committed repository with one tracked file and an `origin` the restore
 * step can fetch from, plus the untracked `PLANT`. Everything the fixture
 * writes lands before any baseline is taken, so the drift step's `-newer`
 * walk over `HOME` has nothing of the fixture's to complain about.
 */
function checkout(): Fixture {
  const home = scratchDir("ai-review-ir-home-");
  const work = join(home, "work", "repo");
  const runnerTemp = join(home, "work", "_temp");
  const marker = scratchDir("ai-review-ir-marker-");
  const origin = scratchDir("ai-review-ir-origin-");
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

  const write = (rel: string, body: string) => {
    mkdirSync(join(work, rel, "..").replace(/\/\.\.$/, ""), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  Bun.spawnSync(["git", "init", "-q", "--bare", origin], {
    env: stepEnv(home, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }),
  });
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");
  git("update-ref", "-d", "refs/remotes/origin/main");

  writeFileSync(join(work, PLANT), "the reviewer wrote this\n");

  return { home, work, runnerTemp, marker, origin, git, write };
}

/** Run `read_tree` on its own and hand back what it printed. */
function readTree(f: Fixture, v: Variant, extraEnv: Record<string, string> = {}): Run {
  const script = `set -uo pipefail\n${readerVariant(v)}\nread_tree\n`;
  return sh(script, f.work, stepEnv(f.home, extraEnv));
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

function clearMarker(f: Fixture, name: string): void {
  rmSync(join(f.marker, `${name}.fired`), { force: true });
}

// ══ #969 ═════════════════════════════════════════════════════════════════

// ── AC-1: .git/info/exclude, the door no config flag can reach ────────────

describe("AC-1 (#969): a reviewer-written .git/info/exclude cannot hide a plant", () => {
  test("the pre-#969 reader CANNOT see it and the shipped reader can", () => {
    const f = checkout();
    // Inside `.git`, so `git status` never reports this write itself at any
    // setting; and its path is fixed, so `core.excludesFile=/dev/null` —
    // which #965 ships — does not relocate or empty it.
    writeFileSync(join(f.work, ".git", "info", "exclude"), `${PLANT}\n`);

    const before = readTree(f, "unhardened");
    expect(before.code, `the pre-#969 reader failed outright:\n${before.stderr}`).toBe(0);
    expect(
      before.stdout,
      "the poison did not work, so this case cannot tell a fix from a fixture that was " +
        "never poisoned — check that git still honours .git/info/exclude",
    ).not.toContain(PLANT);

    const after = readTree(f, "hardened");
    expect(after.code, `the shipped reader failed outright:\n${after.stderr}`).toBe(0);
    expect(
      after.stdout,
      "one line in .git/info/exclude still hides the reviewer's own plant from the drift reading",
    ).toContain(PLANT);
  });

  test("the reported plant still carries a CONTENT hash, not just a path", () => {
    const f = checkout();
    writeFileSync(join(f.work, ".git", "info", "exclude"), `${PLANT}\n`);
    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.endsWith(PLANT));
    expect(line, "the plant is reported with no line of its own").toBeDefined();
    expect(
      line,
      "the plant came back without a hash, so an ignored path is enumerated but not read — " +
        "a reviewer could then edit it between the two readings undetected",
    ).toMatch(/^[0-9a-f]{40} /);
  });
});

// ── AC-2: a .gitignore that hides itself ──────────────────────────────────

describe("AC-2 (#969): a nested .gitignore cannot hide itself and its plant", () => {
  test("both files are INVISIBLE pre-#969 and both are reported now", () => {
    const f = checkout();
    // `.gitignore` is not special-cased for ignore purposes, so `*` hides the
    // ignore file as well as everything beside it. The root `.gitignore` is
    // in AI_REVIEW_UNTRUSTED_PATHS and restored from the base before the
    // baseline; a nested one the reviewer creates is not.
    f.write("sub/.gitignore", "*\n");
    f.write(`sub/${PLANT}`, "the reviewer wrote this too\n");

    const before = readTree(f, "unhardened");
    expect(before.code, `the pre-#969 reader failed outright:\n${before.stderr}`).toBe(0);
    expect(before.stdout, "the self-hiding ignore did not work; the case proves nothing").not.toContain(
      "sub/",
    );

    const after = readTree(f, "hardened");
    expect(after.code, `the shipped reader failed outright:\n${after.stderr}`).toBe(0);
    expect(after.stdout, "the plant under a self-hiding .gitignore is still invisible").toContain(
      `sub/${PLANT}`,
    );
    expect(
      after.stdout,
      "the ignore file the reviewer wrote is itself still invisible, so the reading cannot " +
        "say how the plant was hidden",
    ).toContain("sub/.gitignore");
  });
});

// ── AC-3: the tracked root .gitignore ─────────────────────────────────────

describe("AC-3 (#969): a committed .gitignore naming the plant cannot hide it", () => {
  test("INVISIBLE pre-#969, reported now, with the ignore file left working", () => {
    const f = checkout();
    // Committed, so the ignore file is CLEAN: nothing about it appears in
    // either reading, and the head that carries it is a legitimate pull
    // request change. This is the case where "neutralise it" and "review it"
    // are the same action — the reader must keep honouring this file for
    // every other path while refusing to be blinded by it.
    f.write(".gitignore", `${PLANT}\nbuild/\n`);
    f.git("add", "-A");
    f.git("commit", "-qm", "ignore");
    f.write("build/artifact.js", "legitimately ignored\n");

    const before = readTree(f, "unhardened");
    expect(before.code, `the pre-#969 reader failed outright:\n${before.stderr}`).toBe(0);
    expect(before.stdout, "the committed-ignore poison did not work").not.toContain(PLANT);

    const after = readTree(f, "hardened");
    expect(after.code, `the shipped reader failed outright:\n${after.stderr}`).toBe(0);
    expect(after.stdout, "a committed .gitignore still hides a plant").toContain(PLANT);
    // And the ignore file is still DOING something: `build/` collapses to one
    // entry rather than enumerating its contents, which is the whole reason
    // `matching` was chosen over `traditional`.
    expect(
      after.stdout,
      "the ignored directory was enumerated file by file, so the reading no longer honours " +
        "the ignore file at all",
    ).not.toContain("build/artifact.js");
    expect(after.stdout).toContain("build/");
  });
});

// ── AC-4: the whole gate, not the reader on its own ───────────────────────

describe("AC-4 (#969): the baseline+drift pair refuses a plant .git/info/exclude hid", () => {
  for (const v of ["unhardened", "hardened"] as const) {
    test(`${v}: the reviewer's write is ${v === "hardened" ? "REFUSED" : "invisible"}`, () => {
      const f = checkout();
      // Nothing planted yet: the plant is what the "reviewer" does BETWEEN
      // the two readings, which is the only thing the gate claims to measure.
      rmSync(join(f.work, PLANT));

      const out = join(f.runnerTemp, "github-output");
      writeFileSync(out, "");
      const baseEnv = {
        RUNNER_TEMP: f.runnerTemp,
        GITHUB_WORKSPACE: f.work,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const swap = (s: string) => (v === "hardened" ? s : unignore(s));
      const baseline = sh(
        swap(buildBaselineScript()),
        f.work,
        stepEnv(f.home, { ...baseEnv, GITHUB_OUTPUT: out }),
      );
      expect(baseline.code, `the baseline step refused:\n${baseline.stderr}`).toBe(0);
      const outputs = readFileSync(out, "utf-8");
      const path = /^path=(.*)$/m.exec(outputs)?.[1] ?? "";
      const sha = /^sha256=(.*)$/m.exec(outputs)?.[1] ?? "";
      expect(path, `the baseline emitted no path:\n${outputs}`).not.toBe("");

      // The reviewer writes into the tree it was told only to read, and hides
      // the write the only way #965 left open.
      writeFileSync(join(f.work, ".git", "info", "exclude"), `${PLANT}\n`);
      writeFileSync(join(f.work, PLANT), "written while the reviewer was running\n");

      const drift = sh(
        swap(buildDriftScript()),
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
        `the gate waved through a write the reviewer hid in .git/info/exclude:\n${drift.stdout}\n${drift.stderr}`,
      ).not.toBe(0);
      expect(drift.stderr, "the refusal does not name the file").toContain(PLANT);
      expect(drift.stderr).toContain(AI_REVIEW_DRIFT_TITLE);
    });
  }
});

// ── AC-5: the control for the door this PR does NOT close ─────────────────

describe("AC-5 (#969): .git/config is the third in-repo door and #965 already holds it", () => {
  test("a local core.excludesFile cannot hide a plant, with the ignore flag stripped", () => {
    const f = checkout();
    const ignores = join(f.home, "poison-ignores");
    writeFileSync(ignores, `${PLANT}\n`);
    f.git("config", "core.excludesFile", ignores);

    // Deliberately the PRE-#969 reader. If this were run hardened it would
    // pass because of `--ignored=matching`, and the claim "#965 holds this
    // door" would be unwitnessed — two deciders agreeing, which is one
    // decider (`.claude/rules/checks-must-be-able-to-fail.md`).
    const run = readTree(f, "unhardened");
    expect(run.code, `the reader failed outright:\n${run.stderr}`).toBe(0);
    expect(
      run.stdout,
      "the checkout's own .git/config can hide a plant from the reader even with #965's " +
        "-c flags in place, so this PR's claim that the third door is already shut is false",
    ).toContain(PLANT);
  });
});

// ── AC-6: the costs, all three measured rather than asserted ──────────────

describe("AC-6 (#969): the flag's price, and what it still cannot see", () => {
  /** A tree shaped like a real checkout: a big ignored dir, and some files. */
  function noisy(f: Fixture): void {
    f.write(".gitignore", "node_modules/\ndist\n*.log\n");
    f.git("add", "-A");
    f.git("commit", "-qm", "ignore");
    for (let i = 0; i < 60; i++) f.write(`node_modules/pkg/lib/f${i}.js`, "x\n");
    for (let i = 0; i < 10; i++) f.write(`dist/d${i}.js`, "x\n");
    for (let i = 0; i < 5; i++) f.write(`x${i}.log`, "x\n");
  }

  test("volume: an ignored DIRECTORY collapses to one line, it is not enumerated", () => {
    const f = checkout();
    noisy(f);
    const lines = readTree(f, "hardened")
      .stdout.split("\n")
      .filter(l => l.length > 0);
    expect(
      lines.filter(l => l.includes("node_modules/pkg/lib/")).length,
      `the reading enumerated the ignored directory file by file (${lines.length} lines in total), ` +
        `so every pull request now spawns one hash-object per ignored file`,
    ).toBe(0);
    expect(lines.some(l => l.endsWith(" node_modules/")), "the ignored directory is not reported at all").toBe(
      true,
    );
    // 75 files behind the ignores; the reading must stay in the same order of
    // magnitude as the tree's own non-ignored content.
    expect(lines.length, `the reading is ${lines.length} lines:\n${lines.join("\n")}`).toBeLessThan(15);
  });

  test("cancels: a path moving from untracked to ignored is NOT drift", () => {
    const f = checkout();
    // `read_tree` emits `<hash> <path>` with the porcelain status letters
    // removed (#815). So a reviewer-written ignore that reclassifies an
    // existing untracked file produces a byte-identical line and the two
    // readings cancel. This is the case the rejected alternative — synthetic
    // hash lines over the ignore files — turns into a false refusal.
    const before = readTree(f, "hardened").stdout;
    expect(before, "the fixture's plant is not in the baseline, so nothing can cancel").toContain(PLANT);

    writeFileSync(join(f.work, ".git", "info", "exclude"), `${PLANT}\n`);
    const after = readTree(f, "hardened").stdout;
    expect(
      after,
      "reclassifying an existing file as ignored changed the reading, so an ignore-state " +
        "change is now reported as a tree modification",
    ).toBe(before);
  });

  test("limit (UNMEASURED): a write inside an already-ignored directory is NOT seen", () => {
    const f = checkout();
    noisy(f);
    const before = readTree(f, "hardened").stdout;
    f.write("node_modules/pkg/lib/EVIL.js", "the reviewer wrote this\n");
    const after = readTree(f, "hardened").stdout;
    // Asserted, not merely written down: if a later change makes this visible
    // the case reds and the UNMEASURED note in the docblock gets deleted by
    // whoever made it true, rather than outliving its subject.
    expect(
      after,
      "a write inside an already-ignored directory is now visible — good, and the UNMEASURED " +
        "note in this file's docblock and in AI_REVIEW_IGNORED_READING is stale",
    ).toBe(before);
    expect(before, "the fixture never built the ignored directory").toContain("node_modules/");
  });
});

// ══ #967 ═════════════════════════════════════════════════════════════════

/** The restore step, run for real, against a fixture with a live origin. */
function runRestore(f: Fixture, v: Variant, extraEnv: Record<string, string> = {}): Run {
  const script = v === "hardened" ? buildRestoreScript() : unprefix(buildRestoreScript());
  return sh(script, f.work, stepEnv(f.home, { [AI_REVIEW_BASE_REF_VAR]: "main", ...extraEnv }));
}

type Scope = "~/.gitconfig" | "the checkout's .git/config";

function poison(f: Fixture, scope: Scope, key: string, value: string): void {
  if (scope === "~/.gitconfig") writeFileSync(join(f.home, ".gitconfig"), `[core]\n\t${key} = ${value}\n`);
  else f.git("config", `core.${key}`, value);
}

// ── AC-7: core.fsmonitor, in both scopes the reviewer can reach ───────────

describe("AC-7 (#967): the restore step does not execute a reviewer-named fsmonitor", () => {
  for (const scope of ["~/.gitconfig", "the checkout's .git/config"] as const) {
    test(`set in ${scope}: it runs pre-#967 and does not run now`, () => {
      const f = checkout();
      // The fsmonitor protocol wants a NUL-terminated path list on stdout;
      // `/` means "assume everything changed", which keeps the step correct
      // while proving the process ran.
      poison(f, scope, "fsmonitor", markerScript(f, "fsmonitor", `printf '/\\0'\n`));

      const before = runRestore(f, "unhardened");
      expect(before.code, `the pre-#967 restore step refused outright:\n${before.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `git did not execute a core.fsmonitor set in ${scope} during the restore step, so this ` +
          `case is not measuring the vector it claims`,
      ).toBe(true);

      clearMarker(f, "fsmonitor");
      const after = runRestore(f, "hardened");
      expect(after.code, `the hardened restore step refused outright:\n${after.stderr}`).toBe(0);
      expect(
        fired(f, "fsmonitor"),
        `the restore step still executes a command named by core.fsmonitor in ${scope} — the step ` +
          `whose job is to replace reviewer-influenced files runs the reviewer's code`,
      ).toBe(false);
    });
  }
});

// ── AC-8: the reference-transaction hook, which ONLY the fetch fires ──────

describe("AC-8 (#967): the restore step's fetch does not fire reviewer-relocated hooks", () => {
  test("a reference-transaction hook fires pre-#967 and does not fire now", () => {
    const f = checkout();
    const hooks = scratchDir("ai-review-ir-hooks-");
    const hook = join(hooks, "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\n: > "${join(f.marker, "reftx.fired")}"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(f.home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);

    // The fixture deletes `refs/remotes/origin/main` after pushing, so the
    // restore step's fetch really does create a ref — a fetch with nothing to
    // update opens no reference transaction and fires nothing, which would
    // make this case green for a reason unrelated to the fix.
    const before = runRestore(f, "unhardened");
    expect(before.code, `the pre-#967 restore step refused outright:\n${before.stderr}`).toBe(0);
    expect(
      fired(f, "reftx"),
      "the fetch fired no reference-transaction hook, so this case is not measuring the vector " +
        "it claims — check that the fixture's fetch actually updates a ref",
    ).toBe(true);

    clearMarker(f, "reftx");
    f.git("update-ref", "-d", "refs/remotes/origin/main");
    const after = runRestore(f, "hardened");
    expect(after.code, `the hardened restore step refused outright:\n${after.stderr}`).toBe(0);
    expect(
      fired(f, "reftx"),
      "the restore step's fetch still fires hooks from a directory core.hooksPath names",
    ).toBe(false);
  });
});

// ── AC-9: the control that decides the SHAPE, which is the deliverable ────

describe("AC-9 (#967): the restore step keeps the runner's network configuration", () => {
  test("a ~/.gitconfig insteadOf rewrite still resolves, and #965's prefix would break it", () => {
    const f = checkout();
    // A self-hosted runner legitimately keeps `http.proxy`, `http.sslCAInfo`
    // and `url.<base>.insteadOf` here. `insteadOf` is the one of the three
    // whose effect is observable without a network: point `origin` at a
    // scheme git has no helper for, and the fetch succeeds only if the global
    // file was read.
    f.git("remote", "set-url", "origin", "rungate-test://upstream");
    writeFileSync(
      join(f.home, ".gitconfig"),
      `[url "file://${f.origin}"]\n\tinsteadOf = rungate-test://upstream\n`,
    );

    const shipped = runRestore(f, "hardened");
    expect(
      shipped.code,
      "the restore step took the runner's own url.insteadOf rewrite with it, so every fetch on a " +
        `runner that needs a proxy, a CA bundle or a rewrite now refuses UNMEASURED:\n${shipped.stderr}`,
    ).toBe(0);

    // The rejected shape, applied: #965's full prefix in front of the same
    // step. Without this half the case above is satisfied by a fixture whose
    // remote never needed the rewrite.
    const f2 = checkout();
    f2.git("remote", "set-url", "origin", "rungate-test://upstream");
    writeFileSync(
      join(f2.home, ".gitconfig"),
      `[url "file://${f2.origin}"]\n\tinsteadOf = rungate-test://upstream\n`,
    );
    const envNeutralised = sh(
      buildRestoreScript().split(AI_REVIEW_GIT_KEYS_ONLY).join(AI_REVIEW_GIT_ISOLATED),
      f2.work,
      stepEnv(f2.home, { [AI_REVIEW_BASE_REF_VAR]: "main" }),
    );
    expect(
      envNeutralised.code,
      "neutralising the global config file did NOT break the rewrite, so the shape argument in " +
        "AI_REVIEW_GIT_KEYS_ONLY's docblock is unwitnessed and the env vars could simply be added",
    ).not.toBe(0);
  });

  test("control: the hardened restore step still restores, with no poison at all", () => {
    const f = checkout();
    const run = runRestore(f, "hardened");
    expect(run.code, `the hardened restore step refused a clean fixture:\n${run.stderr}`).toBe(0);
    expect(run.stdout, "the step reported no restore").toContain("ai-review restored from");
  });
});

// ── AC-10: every git call in the step, not just the two measured ones ─────

describe("AC-10 (#967): no git invocation in the restore step runs unprefixed", () => {
  test("the EMITTED bash has no bare git in command position", () => {
    const script = buildRestoreScript();
    const stripped = script.split(AI_REVIEW_GIT_KEYS_ONLY).join("<prefixed>");
    const bare = stripped
      .split("\n")
      .filter(l => !l.trimStart().startsWith("#"))
      .filter(l => /(?:^|[|&;(]|\$\()[ \t]*git[ \t]/.test(l));
    expect(
      bare,
      `the restore step runs git without the prefix, so the reviewer's ~/.gitconfig still names ` +
        `commands it executes:\n${bare.join("\n")}`,
    ).toEqual([]);
    expect(
      (stripped.match(/<prefixed>/g) ?? []).length,
      "the restore step prefixes a different number of git calls than its four",
    ).toBe(4);
  });

  test("the prefix carries the -c keys and deliberately NOT the env vars", () => {
    expect(
      AI_REVIEW_GIT_KEYS_ONLY,
      "the restore prefix does not carry the shared key list, so it can drift from the reader's",
    ).toContain(AI_REVIEW_GIT_NEUTRALISED_KEYS);
    for (const absent of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "safe.directory"]) {
      expect(
        AI_REVIEW_GIT_KEYS_ONLY,
        `the restore prefix carries ${absent}. The env vars discard the whole global file, and ` +
          `the fetch is a NETWORK call — see AC-9. safe.directory is then unnecessary too, ` +
          `because actions/checkout's own entry is still being read`,
      ).not.toContain(absent);
    }
  });

  test("both prefixes are built from ONE key list, so neither can drift", () => {
    expect(
      AI_REVIEW_GIT_ISOLATED,
      "the reader's prefix spells its -c keys itself, so a key added to one prefix would " +
        "silently not reach the other",
    ).toContain(AI_REVIEW_GIT_NEUTRALISED_KEYS);
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.fsmonitor=");
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.hooksPath=/dev/null");
    expect(AI_REVIEW_GIT_NEUTRALISED_KEYS).toContain("-c core.excludesFile=/dev/null");
  });
});

// ── AC-11 / AC-12: the harness and the mutants are honest ─────────────────

describe("AC-11: this file's own environment can still be poisoned", () => {
  test("stepEnv sets no GIT_CONFIG_* of its own", () => {
    const env = stepEnv("/tmp/anywhere");
    for (const k of Object.keys(env)) {
      expect(
        k.startsWith("GIT_CONFIG_"),
        `${k} is set by the harness, which is part of the isolation under test — every case in ` +
          `this file would then be green before the fix and after it`,
      ).toBe(false);
    }
    expect(env.HOME, "the cases have no HOME to poison").toBe("/tmp/anywhere");
  });
});

describe("AC-12: the stripped variants really are the pre-fix scripts", () => {
  test("#969: the stripped reader is the pre-#969 status line", () => {
    // Search the SLICE, not the document: the shipped reader explains the
    // flag in a bash COMMENT, and a whole-script `not.toContain` would be
    // satisfied by the prose rather than by the command
    // (`.claude/rules/checks-must-be-able-to-fail.md`).
    const statusLine = (s: string) =>
      s.split("\n").find(l => l.includes("status --porcelain")) ?? "";
    expect(statusLine(AI_REVIEW_TREE_READER), "the reader runs no status at all").not.toBe("");
    expect(
      statusLine(unignore(AI_REVIEW_TREE_READER)),
      "the stripped reader still asks for ignored paths, so every INVISIBLE assertion is vacuous",
    ).not.toContain("--ignored");
    expect(
      statusLine(unignore(AI_REVIEW_TREE_READER)),
      "the stripped reader is not the pre-#969 command, so the cases measure something else",
    ).toContain("status --porcelain --untracked-files=all 2>&1");
    expect(AI_REVIEW_TREE_READER, "the shipped reader does not ask for ignored paths at all").toContain(
      `--untracked-files=all ${AI_REVIEW_IGNORED_READING}`,
    );
  });

  test("#967: the stripped restore step runs git with no prefix", () => {
    const stripped = unprefix(buildRestoreScript());
    expect(
      stripped,
      "the stripped restore step still neutralises keys, so every FIRED assertion is vacuous",
    ).not.toContain("-c core.fsmonitor=");
    expect(stripped).toContain("git rm -rfq --ignore-unmatch");
    expect(stripped).toContain("fetch --no-tags --depth=1");
  });
});
