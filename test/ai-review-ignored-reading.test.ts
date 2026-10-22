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
 * 2. **A write inside `.claude-pr/` under a name the action snapshots** —
 *    `.claude-pr/.claude/EVIL.md` — is invisible for the same reason plus the
 *    exemption. AC-8/limit asserts it. The TOP of that directory is read as
 *    of #1071 and AC-12 is that half; what is left is one level down.
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
  AI_REVIEW_SCRATCH_SCAN_LIMIT,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_TREE_READER,
  AI_REVIEW_UNTRUSTED_PATHS,
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

  test("limit (UNMEASURED): a plant under a MIRRORED name inside the scratch is not seen", () => {
    // #1071 moved this bound rather than removing it, and the case moved with
    // it rather than being deleted. The TOP of the scratch is now read (AC-12
    // below); what is still invisible is a write under one of the names the
    // action itself snapshots, because `matching` collapses the subtree and
    // the reader descends exactly one level.
    //
    // Asserted so the note cannot outlive its subject: the day the reader
    // goes deeper, this reds and whoever made it true deletes the note in
    // AI_REVIEW_SCRATCH_SCAN_LIMIT rather than leaving it standing.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    actionScratch(f);
    const before = readTree(f, "hardened").stdout;
    f.write(".claude-pr/.claude/EVIL.md", "the reviewer wrote this\n");
    const after = readTree(f, "hardened").stdout;
    expect(
      after,
      "a write under a mirrored name inside the scratch is now visible — good, and the " +
        "UNMEASURED note in this file's docblock and in AI_REVIEW_SCRATCH_SCAN_LIMIT is stale",
    ).toBe(before);
    expect(
      before,
      "the fixture never built the scratch, so the blindness this records is the fixture's",
    ).not.toContain(".claude-pr");
  });
});

// ── AC-12: the exempted subtree is read one level down (#1071) ────────────

/**
 * The exemption above dropped the ONLY line. `--ignored=matching` collapses
 * the whole ignored subtree to `!! .claude-pr/`, and that entry is the one
 * exempted, so the reading was EMPTY and the drift step had nothing to
 * compare — `.claude-pr/EVIL.md` was invisible at any depth.
 *
 * The exemption is unavoidable and stays. What changed is that the reader
 * DESCENDS one level instead of returning, drops the names the action
 * snapshots, and classifies the rest through the same `classify_path` the
 * rest of the reading goes through.
 *
 * ## The mutant, and why it is this one
 *
 * `AI_REVIEW_SCRATCH_SCAN_LIMIT` is driven to 0, mechanically, from the
 * exported constant. The counter starts at 1, so the walk breaks on its first
 * entry and the reader is the pre-#1071 reader exactly — an empty reading for
 * the scratch — without a hand-written copy of the old bash that would stay
 * green while the shipped one was gutted.
 *
 * ## The measured battery, and WHICH assertion each row reddens
 *
 * Run over this file alone, 37 cases, on the tree that carries #1070.
 * `lib/scaffold/ai-review-step.ts` was restored from a `cp` backup after every
 * row — never `git checkout --` — and confirmed byte-identical by sha256
 * afterwards. **The baseline row was read before any mutation row.**
 *
 * | Row | Mutation | Measured | Which assertions |
 * |---|---|---|---|
 * | **baseline** | unmutated | **37 pass, 0 fail** | — |
 * | **M10** | the descent stripped: `AI_REVIEW_SCRATCH_SCAN_LIMIT` driven to 0 | **5 of 37** | AC-12 ×5 — empty, end-to-end, directory, symlink, bound |
 * | **M11** | the `-L` half of the glob guard dropped | **1 of 37** | AC-12/symlink |
 * | **M12** | the mirror filter removed — every scratch entry reported | **7 of 37** | AC-7/green, AC-7/control, AC-8/limit, AC-10/control, AC-12/CONTROL, AC-12/volume, AC-12/widening |
 * | **M13** | **the cheapest wrong fix** — the conditional exemption #1071 proposes | **5 of 37** | the same five as M10 |
 *
 * **The input on which mutant and original differ, named and run rather than
 * assumed.** M10: `.claude-pr/EVIL.md` written after the action's scratch —
 * the original reports `<sha1> .claude-pr/EVIL.md`, the mutant reports
 * nothing. M11: a dangling `.claude-pr/evil-link` — `[ -e ]` follows the link
 * and is false, so the mutant drops the entry before anything classifies it.
 * M12: `.claude-pr/.claude/settings.json`, which the action itself writes —
 * the mutant reports it and the drift step refuses, which IS PR #1002's
 * outage.
 *
 * **There is no row for the directory shape, and that is the composition with
 * #1070 rather than an omission.** An earlier draft of the walk tested
 * `[ -d ]` so it could hand a directory on in git's collapsed shape, and that
 * draft HAD such a row. #1070 landed first and taught `classify_path` to ask
 * the property, so the shape test was deleted rather than rebased: there is
 * nothing left in the walk to mutate, and `AC-12/ONE decider` is what says so
 * — it reds under M10 because the entry vanishes, and it would red again the
 * day someone re-introduces a second decider that answers `absent`.
 *
 * **M13 is the cheapest wrong fix and it is run, not argued.** #1071 measured
 * the conditional exemption as a no-op — the collapsed form only exists once
 * the action has written `/.claude-pr/` to `.git/info/exclude`, which is
 * after the baseline, so the baseline can never carry it and the guard's
 * condition is always true. Implemented faithfully (`grep -F -x -q` against
 * the baseline file, the descent removed) it reds exactly the five rows M10
 * reds, which is the measurement agreeing with the issue. The five are REAL,
 * not vacuous: each one asserts an observable difference in the reading, and
 * the mutant produces the pre-#1071 reading.
 *
 * **M12 is the row that matters most**, because it is the only mutation that
 * can take the fleet down: it reds both #1002 controls plus this suite's new
 * one. The thing keeping every pull request green is witnessed, not assumed.
 */
describe("AC-12 (#1071): a reviewer write at the top of the scratch is REFUSED", () => {
  /** The pre-#1071 reader: the descent, stripped from the constant that bounds it. */
  const noDescent = (s: string) =>
    s.split(`-gt ${AI_REVIEW_SCRATCH_SCAN_LIMIT}`).join("-gt 0");

  test("the reading was EMPTY and is now one line naming the path", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT));
    actionScratch(f);
    f.write(".claude-pr/EVIL.md", "the reviewer wrote this\n");

    const before = sh(
      `set -uo pipefail\n${noDescent(AI_REVIEW_TREE_READER)}\nread_tree\n`,
      f.work,
      stepEnv(f.home),
    );
    expect(before.code, `the pre-#1071 reader failed outright:\n${before.stderr}`).toBe(0);
    expect(
      before.stdout.trim(),
      "the pre-#1071 reading is not empty, so the defect this case is about was never " +
        "reproduced and the hardened half below proves nothing",
    ).toBe("");

    const after = readTree(f, "hardened");
    expect(after.code, `the shipped reader failed outright:\n${after.stderr}`).toBe(0);
    expect(
      after.stdout,
      "a reviewer write at the top of the exempted subtree is still invisible",
    ).toContain(".claude-pr/EVIL.md");
    expect(
      after.stdout.split("\n").find(l => l.endsWith(".claude-pr/EVIL.md")),
      "the plant came back without a content hash, so it is enumerated but not read",
    ).toMatch(/^[0-9a-f]{40} /);
  });

  test("end to end: the real baseline and drift steps refuse it and name it", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");

    // The action, then the reviewer, in that order — the only order in which
    // the exemption is in force when the reviewer writes.
    actionScratch(f);
    f.write(".claude-pr/EVIL.md", "the reviewer wrote this\n");

    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      "the drift step waved through a reviewer write inside the exempted subtree:\n" +
        `${drift.stdout}\n${drift.stderr}`,
    ).not.toBe(0);
    expect(drift.stderr, "the refusal does not name the path").toContain(".claude-pr/EVIL.md");
    expect(drift.stderr).toContain(AI_REVIEW_DRIFT_TITLE);
  });

  test("THE CONTROL: every name the action snapshots is still exempt, so #1002 stays closed", () => {
    // The case this whole issue was deferred for. The scratch is built with a
    // top-level entry for EVERY name in AI_REVIEW_UNTRUSTED_PATHS — driven
    // from the constant the reader reads, so a name added to one and not the
    // other reds here rather than on every pull request in the repository.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");

    // Both shapes the snapshot produces: `cpSync` of a directory, and of a
    // single file. Alternated rather than picked, because the mirror test
    // runs before the reader knows which it is.
    AI_REVIEW_UNTRUSTED_PATHS.forEach((p, i) => {
      if (i % 2 === 0) f.write(`.claude-pr/${p}/nested/copy.md`, "snapshotted by the action\n");
      else f.write(`.claude-pr/${p}`, "snapshotted by the action\n");
    });
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      "the exemption broke: this is PR #1002's outage, a REQUIRED check red on every pull " +
        `request in the repository\n${drift.stdout}\n${drift.stderr}`,
    ).toBe(0);
  });

  test("volume: a mirrored subtree is NOT enumerated — the walk is one level", () => {
    // `.claude-pr/` holds a copy of the pull request's own `.claude/` tree, so
    // its size is attacker-influenced. The reading must stay proportional to
    // the number of top-level entries, not to the size of that copy.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    for (let i = 0; i < 60; i++) f.write(`.claude-pr/.claude/rules/r${i}.md`, "x\n");
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    const lines = readTree(f, "hardened")
      .stdout.split("\n")
      .filter(l => l.length > 0);
    expect(
      lines.filter(l => l.includes(".claude-pr/")).length,
      `the reader enumerated the scratch (${lines.length} lines):\n${lines.join("\n")}`,
    ).toBe(0);
  });

  test("ONE decider: a planted DIRECTORY gets #1070's token, not `absent`", () => {
    // Composed rather than duplicated. The walk asks nothing about what kind
    // of thing the entry is — it hands the path to `classify_path`, which
    // #1070 taught to ask the PROPERTY. So a directory planted at the top of
    // the scratch is answered by the same branch that answers one planted
    // anywhere else, and no `[ -d ]` test lives in the walk to disagree with
    // it later. `absent` is the lie #1061/#1070 are about, and it is a value
    // #989's classifier branches on.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    f.write(".claude-pr/evil/payload.md", "the reviewer wrote this\n");
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.endsWith(" .claude-pr/evil"));
    expect(line, "a directory planted at the top of the scratch is not reported at all").toBeDefined();
    expect(
      line,
      "a directory sitting on disk is reported `absent`, which is false about it AND is the " +
        "token #989 reads as the action having deleted a restored path",
    ).toBe(`${AI_REVIEW_PRESENT_UNHASHABLE} .claude-pr/evil`);
  });

  test("a DANGLING symlink at the top of the scratch is still reported", () => {
    // `-e` follows symlinks and is false for a dangling one, so the glob
    // guard needs `-L` as well or the entry is dropped before it is ever
    // classified. That omission is how #1061 came up short (#1070), met here
    // in a new walk. The TOKEN is #1070's to decide; what this asserts is
    // that the path reaches the reading at all.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    mkdirSync(join(f.work, ".claude-pr"), { recursive: true });
    symlinkSync("/nonexistent/target", join(f.work, ".claude-pr", "evil-link"));
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    expect(
      readTree(f, "hardened").stdout,
      "a dangling symlink the reviewer planted at the top of the scratch is invisible — " +
        "the glob guard dropped it before anything could classify it",
    ).toContain(".claude-pr/evil-link");
  });

  test("ONE classifier: the reader turns a path into a token in exactly one place", () => {
    // The walk is a second place paths enter the reading, and the cheapest
    // way to write it was to inline the hashing. Two copies of `[ -f ]` +
    // `hash-object` is two deciders for one question, and #1070 is already
    // open against the single copy — a fork here would be fixed in one of
    // them (`.claude/rules/checks-must-be-able-to-fail.md`).
    expect(
      AI_REVIEW_TREE_READER.split("hash-object").length - 1,
      "the reader hashes a path in more than one place, so a change to how a path becomes a " +
        "token can land in one of them and leave the other behind",
    ).toBe(1);
    expect(
      AI_REVIEW_TREE_READER.split("h=absent").length - 1,
      "the reader decides `absent` in more than one place",
    ).toBe(1);
    expect(
      AI_REVIEW_TREE_READER.split(/^\s*classify_path "/m).length - 1,
      "the reader does not route both of its path sources through one classifier",
    ).toBeGreaterThan(1);
  });

  test("the bound truncates the reading, and truncation cannot flip the verdict", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT));
    const before = runBaseline(f, "hardened");
    for (let i = 0; i < AI_REVIEW_SCRATCH_SCAN_LIMIT + 20; i++) {
      f.write(`.claude-pr/EVIL-${i}.md`, "the reviewer wrote this\n");
    }
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    const lines = readTree(f, "hardened")
      .stdout.split("\n")
      .filter(l => l.includes(".claude-pr/"));
    expect(
      lines.length,
      `the walk is unbounded (${lines.length} lines), so a reviewer sets the cost of the step`,
    ).toBeLessThanOrEqual(AI_REVIEW_SCRATCH_SCAN_LIMIT);
    expect(lines.length, "the bound truncated the reading to nothing").toBeGreaterThan(0);

    const drift = runDrift(f, "hardened", before);
    expect(
      drift.code,
      `a truncated reading went green, so the bound is a bypass:\n${drift.stdout}\n${drift.stderr}`,
    ).not.toBe(0);
  });

  test("the widening is stated and asserted: `.claude-pr/.gitignore` is exempt", () => {
    // AI_REVIEW_UNTRUSTED_PATHS is a SUPERSET of the action's snapshot list —
    // `.gitignore` and `.gitattributes` were added by #856 and the action does
    // not snapshot them. Using it as the mirror list therefore exempts two
    // names nothing writes. Recorded rather than hidden, and not repaired with
    // a second list: a SUBSET reds every pull request the first time the
    // action's list grows, and a superset costs these two names.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    f.write(".claude-pr/.gitignore", "the reviewer wrote this\n");
    appendFileSync(join(f.work, ".git", "info", "exclude"), `${ACTION_EXCLUDE_PATTERN}\n`);

    expect(
      readTree(f, "hardened").stdout,
      "`.claude-pr/.gitignore` is now reported — good, and the widening paragraph in " +
        "AI_REVIEW_SCRATCH_SCAN_LIMIT is stale",
    ).not.toContain(".claude-pr/.gitignore");
    expect(
      AI_REVIEW_UNTRUSTED_PATHS,
      "the widening this case records is gone from the list it comes from",
    ).toContain(".gitignore");
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

// ── AC-13: a scratch entry's NAME cannot forge a record (#1071 follow-up) ──

/**
 * `read_scratch` (#1071) is the first path source in this reader that does not
 * come from git, and #1071 shipped without noticing what that costs.
 *
 * `classify_path`'s quoting guard was anchored at position 0 — `'"'*` — and it
 * is right for git: porcelain v1 C-quotes any path carrying a newline, a quote
 * or a backslash, so a git-derived path arrives already wrapped. The walk globs
 * the FILESYSTEM. Nothing wraps those names, nothing rejected them, and the
 * last line of `classify_path` prints the path. So an entry named with an
 * embedded newline printed as TWO lines, and the second was indistinguishable
 * from a record the reader produced — written by the exact actor the reader
 * exists to measure, because #1071's whole premise is that a reviewer can
 * write under that path.
 *
 * ## Measured on `origin/main` at `77dd0f7f`, the merge commit of #1081
 *
 * The reviewer creates one file, named `p<newline>absent .ripgreprc`:
 *
 * ```
 * reading : de12637f… .claude-pr/p
 *           absent .ripgreprc        <-- FORGED, and not a path on disk
 * ```
 *
 * End to end through the real baseline and drift steps, with a base that does
 * not carry `.ripgreprc`: the forged line reaches #989's twice-restored
 * classifier, is acquitted, and is named in the UNMEASURED warning as
 * *"restored a SECOND time by the review action"*. A reader of that annotation
 * has been told the reviewer's own filename was the action's work.
 *
 * ## What it is NOT, stated so the fix is not oversold
 *
 * It is **not** a detection bypass. `added = after − before` only ADDS, so the
 * entry's own genuine first line — `<sha> .claude-pr/p`, not under an untrusted
 * path — stays in `added` and the step still exits 1. What the injection buys
 * is a false attribution and attacker-chosen text in an annotation, which is
 * the harm #1061 and #1070 each argued is worse than silence. AC-13/refuses is
 * the case that pins the exit code so this stays honest in both directions.
 *
 * ## The fix is ONE decision, and the slash is why the witness looks like this
 *
 * A filename cannot contain `/`, so a forged record can only name a
 * single-component path. That is not a mitigation: `.ripgreprc`, `.claude` and
 * `CLAUDE.md` are all single components and all in `AI_REVIEW_UNTRUSTED_PATHS`,
 * which is exactly the set #989's classifier acts on. The first draft of this
 * case used `absent .claude/evil/` and could not be written to disk at all —
 * kept here because a fixture that cannot be created is a case that would have
 * gone green by erroring in setup.
 *
 * The guard lives in `classify_path`, not in the walk: "is this path safe to
 * print" has one answer, and a second guard beside it is one decider with a
 * spare. The redaction is unconditional on the `printf` for the same reason —
 * a branch there would be that second decider, and for every git-derived path
 * the expression is the identity.
 *
 * ## The measured battery, and which half does which job
 *
 * Run over this file alone. The source was restored from a `cp` backup after
 * every row and confirmed byte-identical by sha256. **The baseline row was
 * read before any mutation row.**
 *
 * | Row | Mutation | Measured | Which assertions |
 * |---|---|---|---|
 * | **baseline** | unmutated | **42 pass, 0 fail** | — |
 * | **N1** | **the cheapest wrong fix** — `*'"'*` (a quote anywhere) instead of the newline | **1 of 42** | AC-13/REDACTED |
 * | **N2** | the `printf` redaction removed, the `case` arm kept | **2 of 42** | AC-13/one-line, AC-13/end-to-end |
 * | **N3** | both removed — the state shipped in #1081 | **3 of 42** | all three behavioural AC-13 cases |
 *
 * **The input on which mutant and original differ**: a scratch entry named
 * `p<newline>absent .ripgreprc`. N3 prints two lines and the second is the
 * forged record; the original prints `unquotable .claude-pr/p`.
 *
 * **N1 corrected a claim the first draft of this fix made.** The `case` arm
 * was described as what closes the forgery. It is not — with a wrong arm and
 * the truncation in place the reading is already one line, and only the TOKEN
 * is wrong. So the two halves do different jobs: the truncation closes the
 * forgery, the arm stops the reader asserting a content hash about a name it
 * did not print and routes the entry into the UNMEASURED annotation. N2 and N3
 * take them apart, and the source comment was rewritten to say so.
 *
 * **Would a quote-only case have survived the cheapest wrong fix? No — it
 * would have been VACUOUS.** A name carrying a `"` and no newline matches
 * `*'"'*`, so N1 goes green on it and the case witnesses nothing. That is
 * exactly why every behavioural case here is built around the newline: the
 * newline is what forges a record, and it is the input the cheapest wrong fix
 * does not cover.
 */
describe("AC-13 (#1071 follow-up): a filesystem-derived name cannot forge a record", () => {
  /** The injected record the reviewer wants in the reading. */
  const FORGED = "absent .ripgreprc";
  /** One file, one name, one newline. `.ripgreprc` is in AI_REVIEW_UNTRUSTED_PATHS. */
  const FORGING_NAME = `p\n${FORGED}`;

  test("the reading carries ONE line for the entry, and it is not the forged record", () => {
    const f = checkout();
    rmSync(join(f.work, PLANT));
    actionScratch(f);
    writeFileSync(join(f.work, ".claude-pr", FORGING_NAME), "the reviewer wrote this\n");

    const out = readTree(f, "hardened");
    expect(out.code, `the reader failed outright:\n${out.stderr}`).toBe(0);
    const lines = out.stdout.split("\n").filter(l => l.length > 0);

    expect(
      lines,
      "the reviewer's FILENAME is a record in the tree reading — it was printed unescaped, " +
        "split on its own newline, and the second half is indistinguishable from a line this " +
        "reader produced",
    ).not.toContain(FORGED);
    expect(
      lines.filter(l => l.includes(".claude-pr/p")).length,
      `the entry produced ${lines.length} lines, not one:\n${lines.join("\n")}`,
    ).toBe(1);
  });

  test("REDACTED, not dropped: the entry still produces a line, with a token #989 cannot acquit", () => {
    // Silence here would be the blindness #1071 closed, re-entered through its
    // own fix: an entry that prints nothing is an entry the reviewer suppresses
    // by choosing a name. The token matters as much as the line — `unquotable`
    // is fixed by position, so the record cannot read `absent` and #989's
    // deleted-path branch cannot claim it.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    actionScratch(f);
    writeFileSync(join(f.work, ".claude-pr", FORGING_NAME), "the reviewer wrote this\n");

    const line = readTree(f, "hardened")
      .stdout.split("\n")
      .find(l => l.includes(".claude-pr/p"));
    expect(
      line,
      "the entry produced no line at all, so a reviewer hides a write by putting a newline " +
        "in its name — which is the blindness this reader exists to close",
    ).toBeDefined();
    expect(line, "the redacted record is not a single whole line").toBe("unquotable .claude-pr/p");
  });

  test("end to end: REFUSED, and the forged path is in no annotation", () => {
    // Both directions. The exit code is the half that keeps this honest: the
    // defect was never a bypass, and a case asserting only "it now refuses"
    // would have been green BEFORE the fix too.
    const f = checkout();
    rmSync(join(f.work, PLANT));
    // The base must NOT carry `.ripgreprc`, or #989 keeps the forged line for
    // the ordinary reason and the acquittal this case is about never happens.
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    const before = runBaseline(f, "hardened");

    actionScratch(f);
    writeFileSync(join(f.work, ".claude-pr", FORGING_NAME), "the reviewer wrote this\n");

    const drift = runDrift(f, "hardened", before, {
      [AI_REVIEW_BASE_REMOTE_VAR]: "refs/remotes/origin/main",
    });
    expect(
      drift.code,
      `the reviewer's write inside the scratch was waved through:\n${drift.stdout}\n${drift.stderr}`,
    ).not.toBe(0);
    expect(
      drift.stdout,
      "the reviewer's filename was attributed to the review action's second restore (#989) — " +
        "a false attribution the reviewer authored by choosing a name",
    ).not.toContain(FORGED);
    expect(
      drift.stderr,
      "the reviewer's filename reaches the refusal as a forged record rather than as a path",
    ).not.toContain(FORGED);
    expect(drift.stderr, "the refusal does not name the entry").toContain(".claude-pr/p");
  });

  test("the guard is ONE decider: the walk adds no quoting test of its own", () => {
    // Two guards answering "is this path safe to print" are one decider with a
    // spare — a mutation of either leaves the other holding every case up
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). The walk
    // is allowed to find paths; it is not allowed to decide this.
    const reader = AI_REVIEW_TREE_READER;
    const walk = reader.slice(reader.indexOf("read_scratch() {"), reader.indexOf("read_tree() {"));
    expect(walk, "the walk was not located, so the assertion below passes vacuously").toContain(
      "classify_path",
    );
    expect(
      walk.includes("unquotable"),
      "the walk decides quoting for itself, so `classify_path` is no longer the one place " +
        "that answers it and the two can be changed apart",
    ).toBe(false);
    // The ASSIGNMENT, not the word. The first draft counted `unquotable` over
    // the whole reader and reddened on the prose in the comment explaining the
    // guard — searching the document instead of the slice, which is the trap
    // `.claude/rules/checks-must-be-able-to-fail.md` names.
    expect(
      reader.split("h=unquotable").length - 1,
      "the reader decides `unquotable` in more than one place, so the two can disagree",
    ).toBe(1);
  });

  test("the control: a git-derived path is untouched by the redaction", () => {
    // The redaction is unconditional, so it runs over every path the reader
    // reports. Git quotes a path carrying a newline, so for every git-derived
    // path the expression must be the identity — if it is not, this change
    // silently truncates ordinary filenames.
    const f = checkout();
    f.write("sub/dir/ordinary name with spaces.md", "x\n");
    const out = readTree(f, "hardened").stdout;
    expect(
      out,
      "an ordinary path came back truncated, so the redaction is not the identity on the " +
        "source it was never meant to touch",
    ).toContain("sub/dir/ordinary name with spaces.md");
    expect(out, "the fixture's own plant went missing").toContain(PLANT);
  });
});
