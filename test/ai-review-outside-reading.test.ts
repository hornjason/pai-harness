/**
 * ai-review-outside-reading.test.ts — something reads outside the checkout
 * (#843 finding 1).
 *
 * ## Why this is not the spelling change the issue asks for
 *
 * Finding 1 says the reviewer "can create files anywhere the runner user can
 * write", and asks for a run proving writes are refused inside and outside
 * the workspace. Two things are already settled and neither of them is in the
 * issue:
 *
 * - **The issue's stated reason is wrong.** It says `Write` "is a separate
 *   tool and is not covered" by `Edit(./**)`. Claude Code's permission
 *   documentation says the opposite in terms: *"Claude Code checks file
 *   permissions against `Edit(path)` and `Read(path)` rules only… Use
 *   `Edit(docs/**)` in place of `Write(docs/**)`."* `Edit` IS the check that
 *   governs `Write`. `AI_REVIEW_WORKSPACE_WRITE_DENY`'s docblock has carried
 *   that quote since #817.
 * - **The exposure is real anyway, for a different reason.** A rule with no
 *   leading slash anchors at the session's working directory, so `Edit(./**)`
 *   covers the checkout and nothing else. #836 measured exactly that against
 *   the real CLI: `Edit(./**)` is BLOCKED inside the checkout and **WROTE**
 *   to a path outside it.
 *
 * ## Why the fix is coupled to #824, and this file is what ships instead
 *
 * #836's table has four rows. The two that close the exposure —
 * `Edit(**)` and `Edit(<abs>/**)` — are BLOCKED in *both* columns, so each
 * of them also denies the findings write. That is why
 * `AI_REVIEW_WORKSPACE_WRITE_DENY` names respelling as its cheapest wrong
 * fix, and why `test/ai-review-untrusted-restore.test.ts` holds a case
 * against it.
 *
 * So "where may the reviewer write" is one decision, not two, and the other
 * half of it is #824. Shipping a tighter spelling here would close a HIGH
 * finding by silently closing the payload path, which is the trade the
 * module already measured and rejected.
 *
 * **What can ship without that decision is a READING.** Today the drift step
 * reads the tree and nothing reads anywhere else, so every write the grant
 * permits outside the checkout is unobserved — which is precisely the harm
 * finding 1 describes: a write that "survives into other repositories' jobs
 * on the same host". A permission is a claim and a diff is a reading; this
 * file adds the reading.
 *
 * ## It WARNS, and that is a decision with a reason
 *
 * A self-hosted runner writes under `$HOME` constantly for reasons that have
 * nothing to do with the reviewer, and the noise floor has never been
 * measured. A refusal that fires on every run is a gate consumers delete,
 * which is strictly worse than the silence it replaces. So the first version
 * names what it found and does not touch the exit code — and this
 * repository's own ai-review job is the run that measures the floor.
 *
 * `AC-4` asserts the exit code is unmoved, in both directions, so that
 * decision cannot be reversed by accident; reversing it on purpose means
 * editing a case and saying why.
 *
 * ## The time reference is the baseline file, and what that does not cover
 *
 * The reading is `find -newer <the tree baseline>`, reusing the file
 * #843 finding 2 already seals rather than adding a second artefact. Honest
 * limit, stated rather than left for a reader to discover: the seal is over
 * the baseline's CONTENT, so `touch` moves its mtime without breaking the
 * checksum. An agent that back-dates the marker hides writes from this
 * reading and is still caught by the tree comparison. That is a gap, it is
 * narrower than the gap it replaces, and it is written down.
 *
 * ## The cheapest wrong fix, named
 *
 * **Scope the `find` to a list of interesting directories** — `~/.ssh`,
 * `~/.config`, `~/.docker` — when the full `$HOME` walk turns out noisy. It
 * makes the noise go away and it is a detector narrower than what it
 * detects: the finding's own example is a `auth.json` left in gharunner's
 * home by an unrelated job, and nobody predicts the next filename. `AC-6`
 * plants a write at a path no allowlist would name and asserts it is
 * reported.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `test/ai-review-baseline-seal.test.ts` +
 * `test/ai-review-untrusted-restore.test.ts` (34 tests). Every count was
 * predicted before the battery ran, in `/tmp/f1b/predictions.md`, and the
 * **baseline row was read first**.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 0 fail | **34 pass, 0 fail** |
 * | M1 the whole outside-reading block removed — the pre-fix state | 5 | **6 of 34** |
 * | M2 **the cheapest wrong fix**: the `find` scoped to an allowlist | 1 | **3 of 34** |
 * | M3 the `-newer` test removed | 2 | **1 of 34** |
 * | M4 the `GITHUB_WORKSPACE` exclusion removed | 1 | **1 of 34** |
 * | M5 the `RUNNER_TEMP` exclusion removed | 2 | **3 of 34** |
 * | M6 the warning turned into a refusal | 1 | **1 of 34** |
 * | M7 the no-`HOME` branch removed | 1 | **1 of 34** |
 * | M8 `-maxdepth` removed | 1 | **1 of 34** |
 *
 * **M1 at 6 against 5: the extra red is `AC-7`, and the reason is its
 * control.** `AC-7` asserts a deep file is NOT reported, which a reading
 * that reports nothing satisfies — I predicted it would pass vacuously. It
 * is red because the case also asserts a SHALLOW file IS reported in the
 * same run. That half was added on #500's rule — *what would this test
 * report if the feature were deleted* — and it is the difference between a
 * case and a sentence.
 *
 * **M2 at 3 against 1, and all three are the real kind.** Besides `AC-6`,
 * the allowlist misses `AC-4`'s `escaped.sh` and `AC-7`'s `shallow.bin`,
 * neither of which is a dotfile or under `.ssh`/`.config`. Three cases
 * catch the scoped walk, not one; mutant not broken, 31 still pass.
 *
 * **M3 at 1 against 2 — the prediction was wrong, not the check.** I
 * expected `AC-7`'s control to red as well, on the theory that dropping
 * `-newer` would surface the deep file. It does not: `-maxdepth` excludes
 * depth 6 whatever the time test says, and the two options are independent.
 * The one red is real — a `.npmrc` with a day-old mtime is reported by the
 * mutant and not by the original.
 *
 * **M5 at 3 against 2.** The extra is `AC-3`'s in-checkout case: the
 * baseline step writes `github-output` into `RUNNER_TEMP`, so removing that
 * exclusion fires the outside warning in a case that is about the tree.
 * Squarely the mutated behaviour.
 *
 * **Which cells are witnesses and which are controls.** `AC-3`'s two
 * "must NOT report" cases are controls — green on the pre-fix source by
 * construction, because a reading that reports nothing reports nothing
 * wrongly either. They exist so that a reading which fires on everything
 * cannot read as a reading that found something, and M4 and M5 are the rows
 * that make them earn it.
 *
 * None of the eight mutations is left in the tree; all were restored from a
 * `cp` backup — never `git checkout --` — and `lib/scaffold/ai-review-step.ts`
 * was confirmed byte-identical afterwards by sha256.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_OUTSIDE_MAXDEPTH,
  AI_REVIEW_OUTSIDE_TITLE,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_UNMEASURED_TITLE,
  buildBaselineScript,
  buildDriftScript,
} from "../lib/scaffold/ai-review-step";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const GIT_ENV = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function sh(script: string, cwd: string, env: Record<string, string>): Run {
  const dir = scratchDir("ai-review-outside-script-");
  const path = join(dir, "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", path], { cwd, env: { ...GIT_ENV(), HOME: env.HOME ?? "/tmp", ...env } });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/**
 * A full fixture: a committed checkout INSIDE a fake `$HOME`, which is the
 * layout a GitHub runner has — `/home/runner/work/<repo>/<repo>`. Getting
 * that wrong would make the workspace exclusion untestable, because a
 * workspace outside `$HOME` is excluded by the walk's root rather than by
 * the rule under test.
 */
function fixture() {
  const home = scratchDir("ai-review-outside-home-");
  const runnerTemp = join(home, "work", "_temp");
  const work = join(home, "work", "repo", "repo");
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(work, { recursive: true });

  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", work, ...args], { env: GIT_ENV() });
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "tracked.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  return { home, work, runnerTemp };
}

function runBaseline(f: ReturnType<typeof fixture>) {
  const out = join(f.runnerTemp, "github-output");
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), f.work, {
    HOME: f.home,
    RUNNER_TEMP: f.runnerTemp,
    GITHUB_OUTPUT: out,
  });
  const text = readFileSync(out, "utf-8");
  return {
    run,
    path: /^path=(.*)$/m.exec(text)?.[1] ?? "",
    sha: /^sha256=(.*)$/m.exec(text)?.[1] ?? "",
  };
}

function runDrift(f: ReturnType<typeof fixture>, before: string, sha: string): Run {
  return sh(buildDriftScript(), f.work, {
    AI_REVIEW_MODE: "vertex",
    HOME: f.home,
    RUNNER_TEMP: f.runnerTemp,
    GITHUB_WORKSPACE: f.work,
    [AI_REVIEW_TREE_BEFORE_VAR]: before,
    [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
  });
}

/** Write a file and force its mtime well before the baseline was taken. */
function writeOld(path: string, body: string): void {
  writeFileSync(path, body);
  const longAgo = new Date(Date.now() - 86_400_000);
  utimesSync(path, longAgo, longAgo);
}

// ── AC-1 / AC-2: the reading exists, and it is a reading ─────────────────

describe("AC-1 (#843/1): a write outside the checkout is reported", () => {
  test("a file the reviewer left in $HOME is named", () => {
    const f = fixture();
    const { path, sha } = runBaseline(f);
    writeFileSync(join(f.home, ".npmrc"), "//registry/:_authToken=stolen\n");
    const r = runDrift(f, path, sha);
    const text = r.stdout + r.stderr;
    expect(text, `drift output was:\n${text}`).toContain(
      `::warning title=${AI_REVIEW_OUTSIDE_TITLE}`,
    );
    expect(text, "the warning does not name what it found").toContain(".npmrc");
  });

  test("AC-2, the PAIR: one thing varies — WHEN the file was written", () => {
    // Same path, same content, same tree. Only the mtime differs, so a
    // difference in what is reported is a measurement of the time reference
    // and of nothing else. A pair that also varied the filename would be
    // measuring the filename.
    const f = fixture();
    writeOld(join(f.home, ".npmrc"), "//registry/:_authToken=legitimate\n");
    const { path, sha } = runBaseline(f);
    const before = runDrift(f, path, sha);
    expect(
      before.stdout + before.stderr,
      "a file that predates the review is being blamed on the reviewer",
    ).not.toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);

    writeFileSync(join(f.home, ".npmrc"), "//registry/:_authToken=stolen\n");
    const after = runDrift(f, path, sha);
    expect(after.stdout + after.stderr).toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });
});

// ── AC-3 / AC-4 / AC-5: what it must NOT report, and what it must not do ─

describe("AC-3 (#843/1): the reading does not double-count or misfire", () => {
  test("a write INSIDE the checkout is not reported by the outside reading", () => {
    // The tree comparison already owns that, and reporting it twice would
    // make the outside reading look like it had found something it did not.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    writeFileSync(join(f.work, "evil.ts"), "export const owned = true;\n");
    const r = runDrift(f, path, sha);
    expect(r.code, "the tree comparison stopped catching an in-tree write").not.toBe(0);
    expect(
      r.stdout + r.stderr,
      "the in-tree write is reported by the outside reading as well",
    ).not.toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });

  test("a write inside RUNNER_TEMP is not reported", () => {
    // The payload, the tree baseline and the relocated credential all live
    // there, and the directory is this job's own scratch. Reporting it would
    // fire on every single run, which is the state that gets a gate deleted.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    writeFileSync(join(f.runnerTemp, "findings.json"), '{"findings":[]}');
    const r = runDrift(f, path, sha);
    expect(r.stdout + r.stderr).not.toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });

  test("AC-4: it WARNS — the exit code is unmoved, in both directions", () => {
    // Deliberate, and asserted so it cannot be reversed by accident. The
    // noise floor on a self-hosted runner has never been measured, and a
    // refusal that fires every run is a gate consumers delete.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const clean = runDrift(f, path, sha);
    expect(clean.code, `a clean run was refused:\n${clean.stderr}`).toBe(0);

    writeFileSync(join(f.home, "escaped.sh"), "#!/bin/sh\necho owned\n");
    const dirty = runDrift(f, path, sha);
    expect(dirty.code, "the outside reading became a refusal").toBe(0);
    expect(dirty.stdout + dirty.stderr).toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });
});

// ── AC-5 / AC-6: unmeasured states, and the allowlist that must not exist ─

describe("AC-5 (#843/1): a reading that could not be taken says so", () => {
  test("no usable HOME: UNMEASURED, and the tree comparison still runs", () => {
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const r = sh(buildDriftScript(), f.work, {
      AI_REVIEW_MODE: "vertex",
      HOME: "",
      RUNNER_TEMP: f.runnerTemp,
      GITHUB_WORKSPACE: f.work,
      [AI_REVIEW_TREE_BEFORE_VAR]: path,
      [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
    });
    expect(r.stdout + r.stderr).toContain(`::warning title=${AI_REVIEW_UNMEASURED_TITLE}`);
    expect(r.code, "a run with no HOME was refused outright").toBe(0);

    // And the comparison it sits beside is unaffected: an in-tree write is
    // still caught. Without this half, deleting the whole drift step would
    // leave the case above green.
    writeFileSync(join(f.work, "evil.ts"), "x\n");
    const drifted = sh(buildDriftScript(), f.work, {
      AI_REVIEW_MODE: "vertex",
      HOME: "",
      RUNNER_TEMP: f.runnerTemp,
      GITHUB_WORKSPACE: f.work,
      [AI_REVIEW_TREE_BEFORE_VAR]: path,
      [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
    });
    expect(drifted.code).not.toBe(0);
    expect(drifted.stderr).toContain(`::error title=${AI_REVIEW_DRIFT_TITLE}`);
  });

  test("AC-7: what the depth bound COSTS, asserted rather than described", () => {
    // Not a property anyone wants — it is the price of `-maxdepth`, and an
    // unbounded walk is not shippable (the same step over a developer's home
    // had not finished after ten minutes). A limit written only in prose is
    // a limit nobody re-measures when the number changes, so it is a case.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const deep = join(f.home, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "too-deep.bin"), "x");
    const r = runDrift(f, path, sha);
    expect(
      r.stdout + r.stderr,
      `AI_REVIEW_OUTSIDE_MAXDEPTH is ${AI_REVIEW_OUTSIDE_MAXDEPTH}; if the bound was raised, ` +
        `move this fixture deeper rather than deleting the case`,
    ).not.toContain("too-deep.bin");

    // The control, without which this is satisfied by a reading that found
    // nothing at all: a file inside the bound, in the same run.
    writeFileSync(join(f.home, "shallow.bin"), "x");
    const again = runDrift(f, path, sha);
    expect(again.stdout + again.stderr).toContain("shallow.bin");
    expect(again.stdout + again.stderr).not.toContain("too-deep.bin");
  });

  test("AC-6: a path no allowlist would name is still reported", () => {
    // The cheapest wrong fix, refused by a case rather than by a comment:
    // when the full $HOME walk turns out noisy, scope it to ~/.ssh, ~/.config
    // and friends. The finding's own example is an `auth.json` left in
    // gharunner's home by an unrelated job; nobody predicts the next name.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const odd = join(f.home, "zz-nobody-would-list-this");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, "payload.bin"), "x");
    const r = runDrift(f, path, sha);
    expect(r.stdout + r.stderr).toContain(`::warning title=${AI_REVIEW_OUTSIDE_TITLE}`);
    expect(r.stdout + r.stderr).toContain("payload.bin");
  });
});
