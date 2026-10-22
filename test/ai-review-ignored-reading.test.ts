/**
 * ai-review-ignored-reading.test.ts — the drift reading stops taking its
 * answer off ignore files the reviewer can write (#969), without reading the
 * review tool's own scratch as a reviewer edit (#1002, #1008).
 *
 * ## What #965 left open
 *
 * PR #965 put `AI_REVIEW_GIT_ISOLATED` in front of the two git calls in
 * `AI_REVIEW_TREE_READER`, closing the GLOBAL config door. Three doors are
 * inside the checkout the reviewer sits in, and #965 names them in its own
 * `## Scope` paragraph as out of scope:
 *
 * - `.git/info/exclude` — fixed path, never reported by `git status` at any
 *   setting, and `core.excludesFile=/dev/null` does not touch it;
 * - `.gitignore` at any depth, including one that hides itself;
 * - `.git/config`, whose `core.*` keys the `-c` flags DO outrank — measured by
 *   `test/ai-review-git-config-isolation.test.ts` AC-2/3/4, and the control
 *   here is AC-5.
 *
 * **"Neutralise them" and "review them" are the same action** for the middle
 * one, which is why this file does not neutralise anything. A reader that
 * ignores `.gitignore` reports every build artefact as an untracked plant and
 * refuses every pull request, which is #871's cheapest wrong fix. The fix is
 * `--ignored=matching`: the ignore files keep working and the reader stops
 * depending on them, because an ignored path is still enumerated and still
 * cancels against the baseline.
 *
 * ## THE SECOND HALF, which the first attempt did not have
 *
 * #1002 shipped the flag with 824 lines of tests, every one green, and broke
 * **every pull request in this repository**. None of those tests ran the
 * reviewer. `anthropics/claude-code-action` copies the pull request's
 * sensitive config into `.claude-pr/` mid-review and calls
 * `ensureClaudePrExcludedFromGit()`, which appends its own pattern to
 * `.git/info/exclude` — so the directory is ignored by a mid-review write to
 * the very file this flag exists to stop trusting, `matching` collapses it to
 * one entry, and the comparison read the review tool's own scratch as the
 * reviewer deleting something: `absent .claude-pr/`.
 *
 * Measured by me on attempt 1 of every run in the window, because the
 * run-level conclusion hides it — four of the five were re-run after the
 * revert and `gh run list` reports the latest attempt:
 *
 * ```
 * 22:01:23  refuse=success     22:20:44  refuse=FAILURE
 * 22:03:34  refuse=success     22:23:16  refuse=FAILURE
 * ---- #1002 merges 22:04:58 ----  22:26:02  refuse=FAILURE
 *                                22:29:17  refuse=FAILURE
 *                                22:30:38  refuse=FAILURE
 * ---- #1008 reverts 22:40:05 ----
 * ```
 *
 * So **AC-7 is the acceptance**, not AC-1 to AC-6: the review tool's own
 * scratch appears between the two readings, exactly as the action makes it
 * appear, and the drift step stays GREEN. AC-8 is the other half — the
 * exemption that buys AC-7 is exactly one entry and buys nothing else.
 *
 * ## Why an exemption at all, and why not the shape that was suggested
 *
 * The suggestion was to distinguish a collapsed DIRECTORY entry from a file's
 * bytes changing — a directory appearing and vanishing is not the same event.
 * That is true and it does not separate this directory from a plant: a
 * reviewer that writes `evil/` and an ignore pattern for it produces exactly
 * the same shape. Taking the route would have been legibility dressed as a
 * mechanism, and AC-8/directory is the case that says so — an ignored
 * directory the reviewer creates is still drift.
 *
 * There is no structural property that separates the action's scratch from a
 * plant, because the action creates it inside the checkout, mid-review, and
 * ignores it. The choice is between naming one path and not closing the
 * ignore-file door at all. What keeps the name from being a subtraction list
 * is that it is an EXACT match on a path that can only ever be a directory:
 * `.claude-pr-evil/`, `src/.claude-pr/` and `.claude-pr/plant.md` are all
 * still reported, and AC-8 refuses each of them.
 *
 * ## Everything below is executed
 *
 * #952 shipped 17 green cases over a fix that did not work, because every one
 * asserted that the repaired string appeared in the emitted YAML. So every
 * behavioural case here plants a real file in a real repository, poisons a
 * real in-repo ignore file, and runs the real emitted bash twice — hardened,
 * and with the mechanism stripped back out MECHANICALLY from
 * `AI_REVIEW_IGNORED_READING`, the single constant that carries it. A
 * hand-written copy of the old command would stay green while the shipped
 * constant was gutted.
 *
 * ## The measured battery, and WHICH assertion each row reddens
 *
 * Run over this file alone. `lib/scaffold/ai-review-step.ts` was restored from
 * a `cp` backup after every row — never `git checkout --` — and confirmed
 * byte-identical by sha256 afterwards. **The baseline row was read before any
 * mutation row.** Every count was predicted before the battery ran, and the
 * `Predicted` column is that prediction, kept rather than quietly corrected.
 *
 * | Row | Mutation | Predicted | Measured | Which assertions |
 * |---|---|---|---|---|
 * | **baseline** | unmutated | 20 pass, 0 fail | **20 pass, 0 fail** | — |
 * | **M1** | `AI_REVIEW_IGNORED_READING` = `--ignored=no` — the pre-#969 reader | 12 | **12 of 20** | AC-1 ×2, AC-2, AC-3, AC-4/hardened, AC-6 ×3, AC-7/control, AC-8/sibling, AC-8/nested, AC-8/directory |
 * | **M4** | `--ignored=traditional` instead of `matching` | 5 | **6 of 20** | AC-3, AC-6/volume, AC-6/limit, AC-7/green, AC-8/inside, **+ AC-7/control** |
 * | **M7** | the scratch exemption removed | 3 | **3 of 20** | AC-7/green, AC-7/control, AC-8/exactly-one |
 * | **M8** | the exemption widened to a PREFIX (trailing slash dropped) | 1 | **3 of 20** | AC-8/sibling, **+ AC-7/control, AC-8/exactly-one** |
 * | **M9** | the exemption widened to a SUBSTRING match | 1 | **1 of 20** | AC-8/nested |
 *
 * M1's value is `--ignored=no` rather than the empty string on purpose: an
 * empty constant makes `unignore` split on a bare space and join the whole
 * command back together without any, so the mutant would be a syntax error
 * rather than the pre-#969 reader.
 *
 * **Before believing any row, the input on which mutant and original differ,
 * named and run rather than assumed.** M1: a `.git/info/exclude` holding one
 * line — the original reports `<sha1> planted-by-the-reviewer.md`, the mutant
 * reports nothing. M4: a tree with 60 files under an ignored `node_modules/` —
 * the original reads 1 line for it, the mutant 60. M7: the action's own
 * scratch created between the two readings — the original's drift step exits
 * 0, the mutant's exits 1 with `absent .claude-pr/`, which IS the outage.
 * M8: `.claude-pr-evil/`, which the original reports and the mutant does not.
 * M9: `src/.claude-pr/`, same.
 *
 * ### The rows that came back high, and why every extra is the real kind
 *
 * **M4's extra is AC-7/control.** `traditional` enumerates the scratch file by
 * file, and the exemption is an exact match on the directory entry, so
 * `.claude-pr/CLAUDE.md` is reported WITH the exemption in place — the half
 * of that case asserting the exemption exempts correctly reds.
 *
 * **M8's two extras are the vacuity guards working.** Widening the match also
 * changes the spelling, so the reader no longer contains the constant:
 * AC-8/exactly-one counts zero occurrences, and AC-7/control can no longer
 * strip what it is supposed to strip, which is exactly what that assertion is
 * for. Neither is a case reddening for an unrelated reason.
 *
 * **No row collapses the file**, and the one row that could — M1, the whole
 * flag — leaves eight cases green, including both halves of AC-4's pair and
 * the `.git/config` control.
 *
 * **AC-7/cleanup reds under no row, and that is recorded rather than hidden.**
 * A directory git no longer sees produces no line at all, so every mutant
 * passes it. It is a control over the stated acceptance — "appears and
 * disappears" — not a witness of anything, and its witnesses are AC-7/green
 * and AC-7/control. The whole battery was re-taken after it was added; every
 * count is unchanged and the denominator is 20.
 *
 * ## UNMEASURED, said out loud
 *
 * 1. **A write inside a directory that was already collapsed-ignored at
 *    baseline** — `node_modules/evil.js` — is still invisible. `matching`
 *    reports the directory as one entry in both readings and the entry does
 *    not change. AC-6/limit ASSERTS the blindness, so it is recorded rather
 *    than implied, and whoever makes it visible deletes the note rather than
 *    leaving it to outlive its subject.
 * 2. **A write inside `.claude-pr/`** is invisible for the same reason plus
 *    the exemption. AC-8/inside asserts it. The action populates that
 *    directory with copies of the pull request's own config, which the
 *    reviewer is allowed to read and which is not the code under review.
 * 3. **`.git/config` as a door is covered by #965's `-c` flags, not by
 *    anything here.** AC-5 is the control that says so by measurement rather
 *    than by citation.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AI_REVIEW_ACTION_SCRATCH,
  AI_REVIEW_BASE_REMOTE_VAR,
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_PRESENT_UNHASHABLE,
  AI_REVIEW_IGNORED_READING,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_TREE_READER,
  buildBaselineScript,
  buildDriftScript,
} from "../lib/scaffold/ai-review-step";

/** The file the reviewer wants the detector not to see. */
const PLANT = "planted-by-the-reviewer.md";

/**
 * The pattern the review action appends to `.git/info/exclude`, spelled as it
 * spells it (`CLAUDE_PR_EXCLUDE_PATTERN` in `restore-config.ts`). Leading
 * slash: anchored at the repository root, which is why `src/.claude-pr/` is
 * not ignored by it and AC-8 can use that path as a control.
 */
const ACTION_EXCLUDE_PATTERN = "/.claude-pr/";

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
 * test sets `GIT_CONFIG_GLOBAL=/dev/null`, which is part of the isolation the
 * reader relies on — a case written with it would be measuring the harness.
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
  const path = join(scratchDir("ai-review-ig-script-"), "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", path], { cwd, env });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

interface Fixture {
  home: string;
  work: string;
  runnerTemp: string;
  git: (...a: string[]) => void;
  write: (rel: string, body: string) => void;
}

/**
 * A committed repository with one tracked file plus the untracked `PLANT`.
 * Everything the fixture writes lands before any baseline is taken, so the
 * drift step's `-newer` walk over `HOME` has nothing of the fixture's to
 * complain about.
 */
function checkout(): Fixture {
  const home = scratchDir("ai-review-ig-home-");
  const work = join(home, "work", "repo");
  const runnerTemp = join(home, "work", "_temp");
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
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  writeFileSync(join(work, PLANT), "the reviewer wrote this\n");

  return { home, work, runnerTemp, git, write };
}

/** Run `read_tree` on its own and hand back what it printed. */
function readTree(f: Fixture, v: Variant): Run {
  const script = `set -uo pipefail\n${readerVariant(v)}\nread_tree\n`;
  return sh(script, f.work, stepEnv(f.home));
}

/**
 * What `anthropics/claude-code-action` does to the checkout mid-review,
 * reproduced from its own source at the pinned SHA rather than described.
 *
 * `src/github/operations/restore-config.ts` copies the pull request's
 * sensitive config into `.claude-pr/` for the review agents to read and then
 * calls `ensureClaudePrExcludedFromGit()`, which appends its pattern to
 * whatever `git rev-parse --git-path info/exclude` resolves to, creating the
 * file if it is absent. It logs `Preserved PR's sensitive paths -> .claude-pr/
 * for review agents (not executed)`.
 *
 * The ORDER matters and is the action's: the copy lands first, the exclude
 * line second. A fixture that excluded first would hide the directory from a
 * reading taken in between, which is not the window the outage happened in.
 */
function actionScratch(f: Fixture, name = ".claude-pr"): void {
  f.write(`${name}/CLAUDE.md`, "the PR's own CLAUDE.md, preserved for the agents\n");
  f.write(`${name}/.claude/settings.json`, "{}\n");

  const excludePath = join(f.work, ".git", "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const contents = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const prefix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  appendFileSync(excludePath, `${prefix}/${name}/\n`);
}

/** The baseline step, run for real, handing back the pair the drift step needs. */
function runBaseline(f: Fixture, v: Variant): { path: string; sha: string } {
  const out = join(f.runnerTemp, "github-output");
  writeFileSync(out, "");
  const swap = (s: string) => (v === "hardened" ? s : unignore(s));
  const run = sh(
    swap(buildBaselineScript()),
    f.work,
    stepEnv(f.home, {
      RUNNER_TEMP: f.runnerTemp,
      GITHUB_WORKSPACE: f.work,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: out,
    }),
  );
  expect(run.code, `the baseline step refused:\n${run.stderr}`).toBe(0);
  const outputs = readFileSync(out, "utf-8");
  const path = /^path=(.*)$/m.exec(outputs)?.[1] ?? "";
  const sha = /^sha256=(.*)$/m.exec(outputs)?.[1] ?? "";
  expect(path, `the baseline emitted no path:\n${outputs}`).not.toBe("");
  return { path, sha };
}

/** The drift step, run for real against a baseline this fixture took. */
function runDrift(
  f: Fixture,
  v: Variant,
  before: { path: string; sha: string },
  extra: Record<string, string> = {},
): Run {
  const swap = (s: string) => (v === "hardened" ? s : unignore(s));
  return sh(
    swap(buildDriftScript()),
    f.work,
    stepEnv(f.home, {
      RUNNER_TEMP: f.runnerTemp,
      GITHUB_WORKSPACE: f.work,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      AI_REVIEW_MODE: "vertex",
      [AI_REVIEW_TREE_BEFORE_VAR]: before.path,
      [AI_REVIEW_TREE_BEFORE_SHA_VAR]: before.sha,
      ...extra,
    }),
  );
}

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

      const before = runBaseline(f, v);

      // The reviewer writes into the tree it was told only to read, and hides
      // the write the only way #965 left open.
      writeFileSync(join(f.work, ".git", "info", "exclude"), `${PLANT}\n`);
      writeFileSync(join(f.work, PLANT), "written while the reviewer was running\n");

      const drift = runDrift(f, v, before);

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

// ── AC-7: THE ACCEPTANCE — the reviewer's own scratch, end to end ─────────

describe("AC-7 (#969): the review tool's own scratch is not the reviewer editing the tree", () => {
  test("green: the scratch appears between the readings and the drift step passes", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");

    // What the action does, in the order it does it.
    actionScratch(f);

    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      "the drift step refuses a run in which the review tool created its own scratch — this " +
        "is the #1002 outage, which turned every pull request in the repository red:\n" +
        `${drift.stdout}\n${drift.stderr}`,
    ).toBe(0);
    expect(
      drift.stderr,
      "the refusal names the review tool's scratch, so the fixture reproduced the outage " +
        "rather than the fix",
    ).not.toContain(".claude-pr");
  });

  test("green: the scratch appears AND is cleaned up, and the drift step still passes", () => {
    // The stated acceptance is "appears and disappears". On the runs that
    // went red it did not disappear — the refusal read `absent .claude-pr/`,
    // and a directory git no longer sees produces no line at all. Both halves
    // are run rather than argued, because "it cannot happen" is the sentence
    // #1002's 824 green cases were built on.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");

    actionScratch(f);
    rmSync(join(f.work, ".claude-pr"), { recursive: true, force: true });

    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      `the drift step refuses a run whose scratch was created and then removed:\n${drift.stdout}\n${drift.stderr}`,
    ).toBe(0);
  });

  test("the fixture really is the outage: the pre-exemption reading reports it", () => {
    // Without this half, AC-7 above is satisfied by a fixture whose scratch
    // was never visible to the reading in the first place — a green that
    // measures nothing. The reader is run WITHOUT the exemption, by stripping
    // the one constant that carries it, and must report the scratch.
    const f = checkout();
    actionScratch(f);

    const withExemption = readTree(f, "hardened").stdout;
    const noExemption = sh(
      `set -uo pipefail\n${AI_REVIEW_TREE_READER.split(AI_REVIEW_ACTION_SCRATCH).join("\\0_never_a_path")}\nread_tree\n`,
      f.work,
      stepEnv(f.home),
    ).stdout;

    expect(
      noExemption,
      "the scratch is invisible even WITHOUT the exemption, so AC-7 is green for a reason " +
        "that has nothing to do with this change — check that the fixture's exclude write " +
        "and --ignored=matching are both in force",
    ).toContain(".claude-pr/");
    expect(
      withExemption,
      "the exemption does not exempt, so AC-7 cannot be measuring it",
    ).not.toContain(".claude-pr/");
  });

  test("the scratch is ignored by the action's own write, not by anything of ours", () => {
    // If `.claude-pr/` were covered by a pattern this repository ships, the
    // exemption would be dead code and the outage would have had another
    // cause. Measured: the directory is reported by a reading that honours
    // ignores, and NOT reported by one that does not ask for ignored paths.
    const f = checkout();
    actionScratch(f);
    const plain = readTree(f, "unhardened").stdout;
    expect(
      plain,
      "the scratch shows up WITHOUT --ignored, so it is not ignored at all and the mechanism " +
        "described in AI_REVIEW_ACTION_SCRATCH is not what happened",
    ).not.toContain(".claude-pr");
    expect(
      readFileSync(join(f.work, ".git", "info", "exclude"), "utf-8"),
      "the fixture did not reproduce ensureClaudePrExcludedFromGit's append",
    ).toContain(ACTION_EXCLUDE_PATTERN);
  });
});

// ── AC-8: the exemption is exactly one entry and buys nothing else ────────

describe("AC-8 (#969): the exemption is one exact path, not a prefix and not a class", () => {
  test("exactly one: the constant is a single rooted directory name", () => {
    expect(AI_REVIEW_ACTION_SCRATCH, "the exemption is not a directory entry").toEndWith("/");
    expect(
      AI_REVIEW_ACTION_SCRATCH.split("/").filter(s => s.length > 0).length,
      "the exemption names a nested path, so it exempts more than one directory level",
    ).toBe(1);
    expect(
      AI_REVIEW_TREE_READER.split(AI_REVIEW_ACTION_SCRATCH).length - 1,
      "the reader exempts the scratch in more than one place, so a later reader could skip " +
        "one of them and nobody would notice",
    ).toBe(1);
  });

  test("sibling: a directory merely STARTING with the name is still reported", () => {
    const f = checkout();
    actionScratch(f, ".claude-pr-evil");
    const out = readTree(f, "hardened").stdout;
    expect(
      out,
      "the exemption matched a path that only starts with the scratch's name, so a reviewer " +
        "hides anything by prefixing it",
    ).toContain(".claude-pr-evil/");
  });

  test("nested: the same name under a subdirectory is still reported", () => {
    const f = checkout();
    f.write("src/.claude-pr/plant.md", "the reviewer wrote this\n");
    f.write("src/.gitignore", ".claude-pr/\n");
    const out = readTree(f, "hardened").stdout;
    expect(
      out,
      "the exemption matched the scratch's name at a depth the action never writes it, so a " +
        "reviewer hides anything by putting it in a directory of that name",
    ).toContain("src/.claude-pr/");
  });

  test("directory: an ignored directory the REVIEWER creates is still drift", () => {
    // The shape the exemption deliberately did NOT take. "A collapsed
    // directory entry is not a file's bytes changing" is true and does not
    // separate the action's scratch from a plant — a reviewer that writes a
    // directory and an ignore pattern for it produces exactly this.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");
    actionScratch(f, "evil-scratch");
    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      "an ignored directory the reviewer created mid-review is waved through, so the " +
        "exemption became a rule about directories rather than about one path",
    ).not.toBe(0);
    expect(drift.stderr).toContain("evil-scratch/");
  });

  test("limit (UNMEASURED): a plant INSIDE the scratch is not seen", () => {
    // Asserted so the note cannot outlive its subject. The action populates
    // this directory with copies of the pull request's own config, which the
    // reviewer may read and which is not the code under review.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    actionScratch(f);
    const before = readTree(f, "hardened").stdout;
    f.write(".claude-pr/EVIL.md", "the reviewer wrote this\n");
    const after = readTree(f, "hardened").stdout;
    expect(
      after,
      "a write inside the scratch is now visible — good, and the UNMEASURED note in this " +
        "file's docblock and in AI_REVIEW_ACTION_SCRATCH is stale",
    ).toBe(before);
  });
});

// ── AC-9: the stripped variant really is the pre-fix script ───────────────

describe("AC-9: the mutants are honest", () => {
  test("the stripped reader is the pre-#969 status line", () => {
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
});

// ── AC-10: a collapsed ignored DIRECTORY is not reported as absent (#1061) ──

/**
 * `AI_REVIEW_IGNORED_READING` made `git status` emit directory entries for
 * the first time, and `read_tree`'s `[ -f ]` is false for one, so a present
 * directory was stamped `absent`. That token is not cosmetic: #989's
 * twice-restored classifier branches on it to mean *the action deleted a
 * restored path* and ACQUITS, so a reviewer that writes an ignored directory
 * under one of the untrusted paths was passed AND attributed to the action.
 */
describe("AC-10 (#1061): an ignored directory the reviewer creates is not `absent`", () => {
  /** The two things the reviewer does, and nothing else. */
  function plantIgnoredDir(f: Fixture, dir: string): void {
    appendFileSync(join(f.work, ".git", "info", "exclude"), `/${dir}/\n`);
    f.write(`${dir}/payload.md`, "the reviewer wrote this\n");
  }

  test("the token says directory, so #989's deleted-path branch cannot claim it", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    plantIgnoredDir(f, "ignored-tree");

    const out = readTree(f, "hardened").stdout;
    const line = out.split("\n").find(l => l.endsWith(" ignored-tree/"));
    expect(line, `the fixture's ignored directory is not in the reading:\n${out}`).toBeDefined();
    expect(
      line,
      "a directory sitting on disk is reported `absent`, which is false about it AND is the " +
        "token #989 reads as the action having deleted a restored path",
    ).toBe(`${AI_REVIEW_PRESENT_UNHASHABLE} ignored-tree/`);
  });

  test("end to end: the plant under an untrusted path is REFUSED, not acquitted", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    // Under `.claude`, so the line reaches #989's twice-restored classifier
    // — which is the whole of this defect. A plant anywhere else never gets
    // there and was refused before this change.
    //
    // The base ref is REQUIRED for this fixture to measure anything. Without
    // it the classifier refuses UNMEASURED two branches earlier, and the
    // case goes green on a tree carrying the defect — measured, and the
    // first draft of this case did exactly that.
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const before = runBaseline(f, "hardened");
    plantIgnoredDir(f, ".claude/evil");

    const run = runDrift(f, "hardened", before, {
      [AI_REVIEW_BASE_REMOTE_VAR]: "refs/remotes/origin/main",
    });
    expect(
      run.code,
      "the drift step ACQUITTED a directory the reviewer created under an untrusted path — " +
        `one line in .git/info/exclude and the gate passes:\n${run.stdout}\n${run.stderr}`,
    ).not.toBe(0);
    expect(run.stderr, "the refusal does not name the plant").toContain(".claude/evil/");
    expect(run.stderr).toContain(AI_REVIEW_DRIFT_TITLE);
    // The direction matters as much as the refusal: reported as the action's
    // own restore is the acquittal this case exists against, and it is a
    // WARNING, so a case reading only the exit code would not see it.
    expect(
      run.stdout,
      "the plant was attributed to the review action's second restore (#989) rather than to " +
        "the reviewer — a false attribution is worse than silence",
    ).not.toContain(".claude/evil/");
  });

  test("control: the action's own scratch is still exempt, so #1002 stays closed", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    const before = runBaseline(f, "hardened");
    actionScratch(f);
    const run = runDrift(f, "hardened", before);
    expect(
      run.code,
      "the exemption broke: this is PR #1002's outage, a REQUIRED check red on every pull " +
        `request in the repository\n${run.stdout}\n${run.stderr}`,
    ).toBe(0);
  });

  test("control: the token is not a reason to enumerate — one line per ignored tree", () => {
    const f = checkout();
    f.write(".gitignore", "node_modules/\n");
    f.git("add", "-A");
    f.git("commit", "-qm", "ignore");
    for (let i = 0; i < 40; i++) f.write(`node_modules/pkg/f${i}.js`, "x\n");

    const lines = readTree(f, "hardened").stdout.split("\n").filter(l => l.length > 0);
    expect(
      lines.filter(l => l.includes("node_modules/pkg/")).length,
      `the ignored tree was enumerated file by file (${lines.length} lines)`,
    ).toBe(0);
    expect(
      lines.filter(l => l === `${AI_REVIEW_PRESENT_UNHASHABLE} node_modules/`).length,
      "the ignored tree is not reported as one directory line",
    ).toBe(1);
  });
});

// ── AC-11: the property, not the shape (#1070) ────────────────────────────

/**
 * #1061 keyed the discriminator on git's trailing slash, which is the shape
 * of a collapsed directory and not the property either shape has. `[ -f ]`
 * is false for a dangling symlink, a fifo and a socket too, and none of
 * those carries a slash — so a second route to #989's acquittal survived.
 */
describe("AC-11 (#1070): PRESENT-but-not-a-file is not a deletion, whatever its shape", () => {
  test("a dangling symlink under an untrusted path is REFUSED, not acquitted", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    // Committed BEFORE the baseline, so the directory the plant goes into is
    // not itself drift and the base carries it.
    f.write(".claude/settings.json", "{}\n");
    f.git("add", "-A");
    f.git("commit", "-qm", "claude dir");
    // Required, or #989's classifier refuses UNMEASURED two branches earlier
    // and this case passes on a tree carrying the defect.
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const before = runBaseline(f, "hardened");

    // No directory and no trailing slash: the shape #1061's arm cannot see.
    // `[ -e ]` follows the link and is false, which is why the reader needs
    // `[ -L ]` as well.
    symlinkSync("/nonexistent/target", join(f.work, ".claude", "evil-link"));

    const run = runDrift(f, "hardened", before, {
      [AI_REVIEW_BASE_REMOTE_VAR]: "refs/remotes/origin/main",
    });
    expect(
      run.code,
      "the drift step ACQUITTED a dangling symlink the reviewer created under an untrusted " +
        `path — one symlink and the gate passes:\n${run.stdout}\n${run.stderr}`,
    ).not.toBe(0);
    expect(run.stderr, "the refusal does not name the plant").toContain(".claude/evil-link");
    expect(
      run.stdout,
      "the plant was credited to the review action's second restore (#989) rather than to " +
        "the reviewer — a false attribution is worse than silence",
    ).not.toContain(".claude/evil-link");
  });

  test("the reader distinguishes present-but-unhashable from gone", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    symlinkSync("/nonexistent/target", join(f.work, "dangling"));
    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.endsWith(" dangling"));
    expect(line, "the dangling symlink is not in the reading at all").toBeDefined();
    expect(
      line,
      "a path sitting on disk is reported `absent`, which is the token #989 reads as the " +
        "action having deleted a restored file",
    ).toBe(`${AI_REVIEW_PRESENT_UNHASHABLE} dangling`);
  });

  test("deletion control: `absent` still means gone, so this is a repair not a widening", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT), { force: true });
    // A TRACKED file, deleted. Without this the change could have retired
    // the `absent` branch altogether and every case above would still pass.
    rmSync(join(f.work, "tracked.ts"));
    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.endsWith(" tracked.ts"));
    expect(line, "the deleted file is not in the reading").toBeDefined();
    expect(
      line,
      "a genuinely deleted file no longer reads `absent`, so #989's deleted-path branch has " +
        "been made unreachable — that is a widening, not the repair this claims to be",
    ).toBe("absent tracked.ts");
  });

  test("one decider: the trailing-slash arm is gone, not kept beside the -e test", () => {
    // Two guards answering one question are behaviourally one, and a
    // mutation of either leaves the other holding every case up
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    expect(
      AI_REVIEW_TREE_READER,
      "the reader still carries a trailing-slash case beside the -e/-L test, which is a " +
        "second decider for the question that test already answers",
    ).not.toContain("*/) h=");
    expect(
      AI_REVIEW_TREE_READER,
      "the reader does not test for a dangling symlink, so `-e` alone decides and a dangling " +
        "link is still read as gone",
    ).toContain('[ -L "${p}" ]');
  });
});
