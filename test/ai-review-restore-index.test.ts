/**
 * ai-review-restore-index.test.ts — the drift reading measures CONTENT, not
 * index state (#853).
 *
 * ## The reported defect
 *
 * `buildRestoreScript` restores with `git rm -rfq --ignore-unmatch` followed
 * by `git checkout <base> -- <path>`. Both write the index, so the baseline
 * records a **staged** modification. By the time the drift step reads the
 * tree the same path is **unstaged**, and the verdict is `grep -F -x -v` over
 * whole lines with the two-letter status prefix inside the line:
 *
 * ```
 * baseline:  [M  .claude/rules/<a restored file>]
 * after:     [ M .claude/rules/<a restored file>]
 * ```
 *
 * Same path, same bytes, one space moved — reported as something the reviewer
 * added. PR #815 is the live reproduction, run `39529882923`.
 *
 * ## The fix the issue proposes is neither necessary nor sufficient, measured
 *
 * #853 proposes `git reset -q -- <path>` after the checkout, and says *"it
 * does not weaken the check: a reviewer that edits a restored path still
 * produces a line the baseline does not contain."* Both halves are wrong, and
 * in opposite directions. The whole flow, run in a scratch repository with
 * the drift step's own `grep -F -x -v` applied verbatim:
 *
 * | reading | baseline | after a reviewer edits a RESTORED path | verdict |
 * |---|---|---|---|
 * | today, no reset | `M  doc.md` | `MM doc.md` | REFUSED |
 * | reset only — #853's fix | ` M doc.md` | ` M doc.md` | **exit 0, INVISIBLE** |
 * | hash, no prefix, no reset | `1523f288… doc.md` | `65f7fba8… doc.md` | REFUSED |
 *
 * **Not sufficient**, row two: porcelain reports *that* a file differs from
 * the index, never *how*. The restore has already made every restored path
 * dirty, so a further edit to one produces a byte-identical line. Today's
 * refusal is real but accidental — `MM` differs from `M ` because of the
 * staged/unstaged distinction, which is exactly what the reset removes. The
 * mechanism that falsely refuses #815 is the mechanism that catches a real
 * reviewer edit, so the reset retires both at once.
 *
 * **Not necessary**, row three: with the XY prefix gone and a content hash in
 * its place, index state is not in the reading at all. Every case below runs
 * against a restore that does NOT reset, and `AC-1` perturbs the index
 * between the two readings on purpose. So no `git reset` is shipped: it is a
 * line of code no case here can distinguish, which is the thing
 * `.claude/rules/checks-must-be-able-to-fail.md` exists to stop.
 *
 * ## What the reading is
 *
 * `AI_REVIEW_TREE_READER` replaces the two-letter prefix with `git
 * hash-object` of the path's worktree content, and writes `absent` where the
 * path is gone. The prefix carried exactly one thing the comparison needed —
 * modification against deletion against untracked-add — and the hash carries
 * it better: a deletion reads `absent`, a modification reads a different
 * hash, and a file the reviewer created is a path the baseline has no line
 * for at all.
 *
 * One binding, interpolated into the baseline step and the drift step, so
 * there is one thing to mutate. Two copies would be two deciders that agree
 * — `.claude/rules/checks-must-be-able-to-fail.md`, fourth shape — and
 * `AC-8` counts the `hash-object` call sites for that reason.
 *
 * ## Two cheapest wrong fixes, both named, both with a case pointed at them
 *
 * - **#853's own, halved: strip the prefix and stop.** It is one `cut`, #815
 *   goes green, and a reviewer that DELETES a file it was told only to read
 *   becomes byte-indistinguishable from the restore that made it dirty.
 *   `AC-5` is the control.
 * - **Ship the reset and stop.** The more likely one, because the issue asks
 *   for it by name. It makes #815 green, which is the reported symptom, and
 *   it silently retires the only thing that catches a reviewer editing an
 *   agent-rules file — the behaviour #817 observed happening for real.
 *   `AC-2` goes red under it.
 *
 * ## Everything here is executed
 *
 * Real repositories, the real scripts, run as bash. #853's SC-5 asks for
 * exactly this: *"a test takes two porcelain readings and compares them,
 * rather than asserting the script's text."* The guard and the thing it
 * guards were one `git status` apart, and asserting the script's shape is
 * what let that happen.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `test/ai-review-baseline-seal.test.ts` +
 * `test/ai-review-untrusted-restore.test.ts` + `test/ai-review-workflow.test.ts`
 * (95 tests). Every count was predicted before the battery ran, in
 * `/tmp/853-battery/predictions.md`, and **the baseline row was read first**.
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** — unmutated | 0 fail | **95 pass, 0 fail** |
 * | M1 the reader reverted to plain porcelain — the pre-#853 state | 8 | **9 of 95** |
 * | M2 **wrong fix A**: the prefix stripped, no hash put in its place | 4 | **10 of 95** |
 * | M3 **wrong fix B**: #853's own `git reset`, pre-#853 reader | 5 | **8 of 95** |
 * | M4 `absent` replaced by the empty string | 2 | **2 of 95** |
 * | M5 the `unquotable` branch made unreachable | 2 | **1 of 95** |
 * | M6 the UNMEASURED warning removed from the drift step | 1 | **1 of 95** |
 * | M7 the rename/copy branch made unreachable | 0 | **0, then 1 of 95** |
 * | M8 the porcelain prefix kept alongside the hash | 3 | **6 of 95** |
 * | M9 `read_tree` stops propagating git's non-zero exit | 2 | **2 of 95** |
 *
 * **M3 is the row this issue turns on, and it is not a number — it is which
 * cases moved.** The issue's own fix, applied faithfully, DOES cure the
 * reported symptom: both `SC-1` cases are green under it. It also reds
 * *"SC-2: an edit to a RESTORED path is refused and names it"*, **which M1 —
 * the defective tree — does not**. So the repair that makes #815 pass is the
 * repair that stops catching a reviewer editing an agent-rules file, and the
 * only reason the defective tree catches one at all is the staged/unstaged
 * distinction #815 is a false positive of. One mutation, a fix in one
 * direction and a regression in the other, which is why "does the case
 * survive the cheapest wrong fix" has to be asked of a named fix and not of
 * a count.
 *
 * **M7 came back 0, and that was a finding about this change rather than
 * about the cases.** The `R*|C*` branch had no fixture: nothing here staged
 * a rename, so a mutation making it unreachable changed no observable
 * behaviour. Code no case can witness is not shippable, so rather than
 * delete the branch — which would read `absent` for a renamed file that is
 * sitting on disk, and agree with itself across a reviewer's edit to it —
 * the case *"a renamed path is hashed at its DESTINATION"* was added, and
 * the row is 1. The baseline moved 94 → 95 and **every row above was
 * re-measured against it** rather than carried over.
 *
 * **M5 missed LOW, and the prediction was wrong rather than the check.**
 * I expected `AC-7` to red as well; it has no quoted path in its fixture, so
 * it cannot. Before recording the 1, the input on which mutant and original
 * differ, printed rather than assumed: a tree holding `we"ird.md` reads
 * `unquotable "we\"ird.md"` on the real reader and `absent "we\"ird.md"` on
 * the mutant.
 *
 * **M2, M3 and M8 all came back HIGH, and the extra reds are the real kind.**
 * Each is squarely about the mutated behaviour — M2 kills content so every
 * content case reds, M8 re-admits index state so every index case reds, and
 * both change the reading's line format, which reds
 * `ai-review-baseline-seal`'s forgery case because its planted line no
 * longer matches what the reader emits. None is a crashing mutant: 85, 87
 * and 89 cases still pass respectively, and the file parses and runs.
 *
 * `AC-2`'s unstaged case and `AC-3`'s two cases are **controls**, not
 * witnesses: today's reading already refuses all three, so there is no state
 * of the code in which they go red for this defect. They are here so that a
 * reading which refuses nothing cannot read as one that found nothing.
 *
 * None of the nine mutations is left in the tree; all were restored from a
 * `cp` backup — never `git checkout --` — and `lib/scaffold/ai-review-step.ts`
 * was confirmed byte-identical after every row by sha256.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AI_REVIEW_BASE_REF_VAR,
  AI_REVIEW_DRIFT_TITLE,
  AI_REVIEW_TREE_BEFORE_SHA_VAR,
  AI_REVIEW_TREE_BEFORE_VAR,
  AI_REVIEW_TREE_READER,
  AI_REVIEW_UNMEASURED_TITLE,
  buildBaselineScript,
  buildDriftScript,
  buildRestoreScript,
} from "../lib/scaffold/ai-review-step";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * #1140: these cases are built on real `git` subprocesses and inherit bun's
 * 5000ms default, which was never derived from what they cost. The budget is
 * calibrated on the machine running the suite — see `helpers/git-fixture-budget.ts`
 * for the measurements and the headroom.
 */
setDefaultTimeout(gitFixtureTestTimeout());

/** Inside the restored set, and modified by the pull request — like #815. */
const RESTORED = ".claude/rules/a-restored-rule.md";
/** Inside the restored set, added by the pull request, so the restore deletes it. */
const PR_ADDED = ".claude/rules/added-by-the-pr.md";
/** Outside the restored set. */
const UNRESTORED = "src/app.ts";

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
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  work: string;
  home: string;
  runnerTemp: string;
  git: (...a: string[]) => void;
  write: (rel: string, body: string) => void;
}

function sh(script: string, f: Fixture, env: Record<string, string>): Run {
  const path = join(scratchDir("ai-review-ri-script-"), "step.sh");
  writeFileSync(path, script);
  const r = Bun.spawnSync(["bash", "-e", path], {
    cwd: f.work,
    env: { ...GIT_ENV(), HOME: f.home, RUNNER_TEMP: f.runnerTemp, GITHUB_WORKSPACE: f.work, ...env },
  });
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

/**
 * A checkout shaped like `actions/checkout` on a pull request: detached at
 * the head, an `origin` remote, and no `refs/remotes/origin/<base>` — so the
 * restore step's own fetch is load-bearing rather than decorative.
 *
 * The pull request edits one file inside the restored set and adds another,
 * which is what #815 does and is the only shape that can witness this issue:
 * a PR whose restored paths already match the base leaves the restore nothing
 * to change and leaves the index nothing to differ about.
 */
function checkout(): Fixture {
  const home = scratchDir("ai-review-ri-home-");
  const work = join(home, "work", "repo", "repo");
  const runnerTemp = join(home, "work", "_temp");
  mkdirSync(work, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const origin = scratchDir("ai-review-ri-origin-");

  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", work, ...a], { env: GIT_ENV() });
    if (r.exitCode !== 0) {
      throw new Error(`git ${a.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
    }
  };
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  };

  Bun.spawnSync(["git", "init", "-q", "-b", "main", work], { env: GIT_ENV() });
  write(UNRESTORED, "export const a = 1;\n");
  write(RESTORED, "BASE\n");
  write("CLAUDE.md", "BASE\n");
  git("add", "-A");
  git("commit", "-qm", "base");

  Bun.spawnSync(["git", "init", "-q", "--bare", origin], { env: GIT_ENV() });
  git("remote", "add", "origin", `file://${origin}`);
  git("push", "-q", "origin", "HEAD:refs/heads/main");

  write(RESTORED, "THE PULL REQUEST'S OWN EDIT\n");
  write(PR_ADDED, "ADDED BY THE PULL REQUEST\n");
  git("add", "-A");
  git("commit", "-qm", "head");

  git("checkout", "-q", "--detach", "HEAD");
  Bun.spawnSync(["git", "-C", work, "update-ref", "-d", "refs/remotes/origin/main"], {
    env: GIT_ENV(),
  });
  const probe = Bun.spawnSync(
    ["git", "-C", work, "rev-parse", "--verify", "-q", "refs/remotes/origin/main"],
    { env: GIT_ENV() },
  );
  expect(
    probe.exitCode,
    "the fixture already has origin/main, so the restore step's fetch is not load-bearing",
  ).not.toBe(0);

  return { work, home, runnerTemp, git, write };
}

/** restore → baseline: the two steps the generated job runs, in that order. */
function restoreAndBaseline(f: Fixture) {
  // #989 gave the restore step a second job — publishing the base ref the
  // drift step classifies against — and it refuses without somewhere to put
  // it, so the fixture supplies a real GITHUB_OUTPUT.
  const restoreOut = join(f.runnerTemp, `restore-output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(restoreOut, "");
  const restore = sh(buildRestoreScript(), f, {
    [AI_REVIEW_BASE_REF_VAR]: "main",
    GITHUB_OUTPUT: restoreOut,
  });
  expect(restore.code, `the restore step refused:\n${restore.stderr}`).toBe(0);

  const out = join(f.runnerTemp, `github-output-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, "");
  const run = sh(buildBaselineScript(), f, { GITHUB_OUTPUT: out });
  expect(run.code, `the baseline step refused:\n${run.stderr}`).toBe(0);
  const text = readFileSync(out, "utf-8");
  const path = /^path=(.*)$/m.exec(text)?.[1] ?? "";
  expect(path, `the baseline step emitted no path:\n${text}`).not.toBe("");
  return { path, sha: /^sha256=(.*)$/m.exec(text)?.[1] ?? "" };
}

/**
 * `AI_REVIEW_BASE_REMOTE` is the ref the restore step publishes. #989 made
 * the drift step refuse UNMEASURED without it rather than compare against
 * nothing, so omitting it here would exercise that refusal instead of the
 * index reading these cases are about.
 */
function runDrift(f: Fixture, before: string, sha: string): Run {
  return sh(buildDriftScript(), f, {
    AI_REVIEW_MODE: "vertex",
    [AI_REVIEW_TREE_BEFORE_VAR]: before,
    [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
    AI_REVIEW_BASE_REMOTE: "refs/remotes/origin/main",
  });
}

/** The line the reading produced for one path, or undefined. */
function lineFor(readingFile: string, path: string): string | undefined {
  return readFileSync(readingFile, "utf-8")
    .split("\n")
    .find(l => l.endsWith(` ${path}`));
}

// ── AC-1: the #853 regression, and the property that actually fixes it ──

describe("AC-1 (#853): index state is not a difference", () => {
  test("SC-1: the index moving between the two readings is not drift", () => {
    // The #815 failure, rebuilt. The perturbation is modelled rather than
    // explained: run 39529882923 recorded `M ` at baseline and ` M` at drift,
    // and what re-wrote the index in between was never established. `git
    // reset` is the cheapest thing with that effect and is also the state
    // #853's own proposed fix produces, so it is the one to be robust to.
    //
    // The direction matters and cost one wrong fixture: a `git add` leaves
    // the restored paths exactly as the restore staged them, so it perturbs
    // nothing and this case passed on the defective reading.
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    expect(lineFor(path, RESTORED), "the baseline has no line for the restored path").toBeDefined();
    f.git("reset", "-q");
    const r = runDrift(f, path, sha);
    expect(
      r.code,
      `a PR touching a restored path was refused with no file changed:\n${r.stderr}`,
    ).toBe(0);
  });

  test("SC-1: the same holds for a path the restore DELETED", () => {
    // The other half of the restore's index writes, and the one a prefix-only
    // repair gets wrong: `D ` before, ` D` after, nothing on disk either way.
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    expect(
      lineFor(path, PR_ADDED),
      `the baseline has no line for the path the restore deleted:\n${readFileSync(path, "utf-8")}`,
    ).toBeDefined();
    f.git("reset", "-q");
    expect(runDrift(f, path, sha).code).toBe(0);
  });

  test("the PAIR: one thing varies between the readings — the index, or a file", () => {
    // Same fixture, same path, same perturbation to the index. The only
    // difference between the two halves is whether a file changed on disk, so
    // a difference in verdict is a measurement of that and of nothing else.
    const indexOnly = checkout();
    const a = restoreAndBaseline(indexOnly);
    indexOnly.git("reset", "-q");
    expect(runDrift(indexOnly, a.path, a.sha).code, "an index move was refused").toBe(0);

    const contentToo = checkout();
    const b = restoreAndBaseline(contentToo);
    contentToo.write(RESTORED, "BASE\nreviewer was here\n");
    contentToo.git("reset", "-q");
    expect(
      runDrift(contentToo, b.path, b.sha).code,
      "a content edit hid behind the same index move",
    ).not.toBe(0);
  });
});

// ── AC-2 / AC-3: the reviewer is still caught ───────────────────────────

describe("AC-2 (#853): a reviewer edit is still refused", () => {
  test("SC-2: an edit to a RESTORED path is refused and names it", () => {
    // The witness for the hash, and the case that reds under the reset-only
    // repair. A restored path is ALREADY dirty in the baseline, so the
    // porcelain line alone is identical before and after.
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    f.write(RESTORED, "BASE\nthe reviewer appended this\n");
    const r = runDrift(f, path, sha);
    expect(r.code, "a reviewer edit to a restored path was invisible").not.toBe(0);
    expect(r.stderr).toContain(`::error title=${AI_REVIEW_DRIFT_TITLE}`);
    expect(r.stderr, "the refusal does not name the file").toContain(RESTORED);
  });

  test("SC-2: an edit to a restored path the reviewer also STAGED is refused", () => {
    // The sharpest form, and the one that is invisible today: staging the
    // edit collapses `MM` back to `M `, which is byte-identical to the line
    // the restore itself produced. No prefix distinguishes these two trees —
    // only the bytes on disk do.
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    f.write(RESTORED, "BASE\nthe reviewer appended this\n");
    f.git("add", "-A");
    const r = runDrift(f, path, sha);
    expect(r.code, "a staged reviewer edit was invisible").not.toBe(0);
    expect(r.stderr).toContain(RESTORED);
  });

  test("SC-3: an edit to a NON-restored path is refused", () => {
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    f.write(UNRESTORED, "export const a = 2;\n");
    const r = runDrift(f, path, sha);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(UNRESTORED);
  });

  test("a file the reviewer created is refused", () => {
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    f.write("evil.ts", "export const owned = true;\n");
    const r = runDrift(f, path, sha);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("evil.ts");
  });
});

// ── AC-5: the negative control for #853's own cheapest wrong fix ────────

describe("AC-5 (#853): deletion and modification stay distinguishable", () => {
  test("SC-4: a reviewer DELETING a restored path is refused, and differently", () => {
    // Stripping the two-letter prefix is the one-`cut` repair, and the prefix
    // is what separated ` M` from ` D`. The hash has to carry that or the
    // repair makes a reviewer deleting an agent-rules file read exactly like
    // the restore. Both halves are asserted: the deletion is refused, AND its
    // refusal differs from the modification's.
    const deleted = checkout();
    const a = restoreAndBaseline(deleted);
    rmSync(join(deleted.work, RESTORED));
    const delRun = runDrift(deleted, a.path, a.sha);

    const modified = checkout();
    const b = restoreAndBaseline(modified);
    modified.write(RESTORED, "BASE\nthe reviewer appended this\n");
    const modRun = runDrift(modified, b.path, b.sha);

    expect(delRun.code, "a reviewer deletion was not refused").not.toBe(0);
    expect(modRun.code, "a reviewer modification was not refused").not.toBe(0);
    expect(
      delRun.stderr,
      "a deletion and a modification produce the same refusal, so the reading cannot tell them apart",
    ).not.toBe(modRun.stderr);
    expect(delRun.stderr, "a deleted path does not read as absent").toContain(`absent ${RESTORED}`);
  });
});

// ── AC-6 / AC-7 / AC-8: unreadable states, the mechanism, one binding ───

describe("AC-6 (#853): the unreadable cases and the shared binding", () => {
  test("SC-6: a tree that cannot be read is UNMEASURED, not clean", () => {
    const f = checkout();
    const { path, sha } = restoreAndBaseline(f);
    const notARepo = scratchDir("ai-review-ri-notgit-");
    const r = sh(
      buildDriftScript(),
      { ...f, work: notARepo },
      {
        AI_REVIEW_MODE: "vertex",
        [AI_REVIEW_TREE_BEFORE_VAR]: path,
        [AI_REVIEW_TREE_BEFORE_SHA_VAR]: sha,
      },
    );
    expect(r.code, "a tree nobody could read passed").not.toBe(0);
    expect(r.stderr).toContain("UNMEASURED");
  });

  test("SC-6: a path git had to quote is UNMEASURED, not silently absent", () => {
    // The honest limit of reading porcelain v1. A path with a quote or a
    // newline in it comes back quoted and escaped, so the hash cannot be
    // taken — and `absent` is the WRONG answer for a file that is sitting
    // right there. `-z` is not available instead: bash drops NUL bytes in
    // command substitution. The line is still compared, so drift is still
    // caught; what is unmeasured is that path's content.
    const f = checkout();
    f.write('we"ird.md', "present in both readings\n");
    const { path, sha } = restoreAndBaseline(f);
    const r = runDrift(f, path, sha);
    expect(r.stdout + r.stderr, `drift output was:\n${r.stdout}${r.stderr}`).toContain(
      `::warning title=${AI_REVIEW_UNMEASURED_TITLE}`,
    );
    expect(r.code, "an unquotable path turned the whole run red").toBe(0);
  });

  test("AC-7: the reading carries content, and says `absent` for what is gone", () => {
    // The mechanism, asserted directly. Without it the cases above could pass
    // over a reading that happened to differ for some other reason, and
    // nobody could say which property was load-bearing.
    const f = checkout();
    const { path } = restoreAndBaseline(f);
    const modified = lineFor(path, RESTORED);
    expect(modified, `the baseline has no line for the restored path`).toBeDefined();
    expect(modified!, "the baseline line carries no content hash").toMatch(/^[0-9a-f]{40} /);

    const deleted = lineFor(path, PR_ADDED);
    expect(deleted, "the deleted path vanished from the reading entirely").toBeDefined();
    expect(deleted!, "a path that is gone is not marked absent").toBe(`absent ${PR_ADDED}`);

    // And the two-letter index prefix is gone, which is the part that makes
    // the reading index-independent rather than merely content-bearing.
    expect(modified!, "the porcelain status prefix is still in the reading").not.toMatch(
      /^[0-9a-f]{40} [ MADRCU?!]{2} /,
    );
  });

  test("AC-7: a renamed path is hashed at its DESTINATION, not read as absent", () => {
    // `R  old -> new` puts two paths on one line and only the second exists.
    // Without the rename branch the whole field is taken as a filename, `-f`
    // fails, and the line reads `absent` for a file that is sitting there —
    // which is wrong in the quiet direction: the two readings agree on
    // `absent` whatever the reviewer then does to the destination.
    //
    // This case exists because the battery measured the rename branch at 0
    // red. Code no case can witness is the thing this repo does not ship.
    const f = checkout();
    const RENAMED = "src/renamed.ts";
    f.git("mv", UNRESTORED, RENAMED);
    const { path, sha } = restoreAndBaseline(f);

    const line = lineFor(path, RENAMED);
    expect(line, `the reading has no line for the rename destination`).toBeDefined();
    expect(line!, "the rename destination was not hashed").toMatch(/^[0-9a-f]{40} /);

    // And the consequence, which is the half that matters: an edit to the
    // destination is still caught. A reading stuck on `absent` would agree
    // with itself across this.
    f.write(RENAMED, "export const a = 99;\n");
    const r = runDrift(f, path, sha);
    expect(r.code, "a reviewer edit to a renamed path was invisible").not.toBe(0);
    expect(r.stderr).toContain(RENAMED);
  });

  test("AC-8: ONE reader, interpolated into both steps", () => {
    // Two copies would be two deciders that agree, and a mutation of either
    // would leave the other holding every case above up.
    expect(buildBaselineScript()).toContain(AI_REVIEW_TREE_READER);
    expect(buildDriftScript()).toContain(AI_REVIEW_TREE_READER);
    expect(AI_REVIEW_TREE_READER.length, "the shared reader is empty").toBeGreaterThan(50);

    // Counted over the EMITTED bash, not over the TypeScript source. The
    // module documents the reading in prose, and a scan of the source would
    // be satisfied — or broken — by a docblock. What has to be true is a
    // property of the script that runs on the runner.
    for (const [name, script] of [
      ["baseline", buildBaselineScript()],
      ["drift", buildDriftScript()],
    ] as const) {
      // Matched without the leading `git`, because #960 put an isolation
      // prefix between the two — `… -c safe.directory='*' hash-object`. The
      // property is still "one call site", which is what this counts; the
      // prefix itself is AC-7's subject in
      // test/ai-review-git-config-isolation.test.ts.
      expect(
        (script.match(/\bhash-object\b/g) ?? []).length,
        `the ${name} step emits a second hash-object call, so there are two readers`,
      ).toBe(1);
      expect(
        (script.match(/\bstatus --porcelain\b/g) ?? []).length,
        `the ${name} step reads the tree without going through the shared reader`,
      ).toBe(1);
    }
  });
});
