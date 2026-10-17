/**
 * Covers SC-1878..SC-1882 (HARNESS-STANDARD.md), #531.
 *
 * Three gate checks decide what a run must prove from a list of changed
 * files, and all three built it with `git diff --name-only ${scopeSha}..HEAD`.
 * Two dots compares two commits directly, so when `scopeSha` is not an
 * ancestor of HEAD the list also carries everything on the other side of the
 * fork. On run `wf_e230fddc-a71` the branch touched 3 files, the gate saw 78,
 * and it refused twice over a `Dockerfile` and seven `.tsx` files that do not
 * exist on the branch.
 *
 * The sha was wrong for a second, independent reason: `writeGateResult`
 * recorded `gitSha(state.projectRoot)` while the run was shipping a
 * worktree, so it captured whatever branch the MAIN CHECKOUT happened to be
 * sitting on. Both halves are exercised here, because either one alone still
 * mis-attributes.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { branchDiffArgs, readBranchDiff } from "../lib/branch-diff";
import { writeGateResult } from "../gates/orchestrator";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

/**
 * A repository with a FORK, which is the only shape that separates two dots
 * from three.
 *
 *   main          A ── B(other.txt, docs/other.tsx)
 *                  \
 *   feature         └─ C(mine.txt)
 *
 * `B..C` reports both sides. `B...C` reports only `mine.txt`.
 */
function forkedRepo(): { root: string; forkSha: string } {
  const root = mkdtempSync(join(tmpdir(), "branch-diff-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "A");
  const base = git(root, "rev-parse", "HEAD");

  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "other.txt"), "other\n");
  writeFileSync(join(root, "docs", "other.tsx"), "export const x = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "B");
  const forkSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "feature", base);
  writeFileSync(join(root, "mine.txt"), "mine\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "C");

  return { root, forkSha };
}

const runner = (root: string) => (args: string[]) => {
  try {
    return { ok: true, output: execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim() };
  } catch (e: any) {
    return { ok: false, output: (e.stdout ?? "").trim() };
  }
};

describe("#531: the changed-file list is branch-relative", () => {
  test("SC-1878: a commit on the other side of the fork is not this branch's change", () => {
    const { root, forkSha } = forkedRepo();

    const reading = readBranchDiff(forkSha, runner(root), "contextual-skip-validation");
    expect(reading.files, `the diff could not be read — ${reading.reason}`).not.toBeNull();
    expect(reading.files).toEqual(["mine.txt"]);

    // The instrument, and it is not optional: the fixture has to be a tree
    // on which two dots and three dots DISAGREE, or the row above passes
    // against either spelling and witnesses nothing. Measured here rather
    // than asserted, because a fixture whose branches share a tip gives the
    // same answer both ways and looks identical in the diff.
    const twoDot = execFileSync(
      "git", ["diff", "--name-only", `${forkSha}..HEAD`],
      { cwd: root, encoding: "utf-8" },
    ).trim().split("\n").filter(Boolean).sort();
    expect(twoDot, "the fixture has no fork in it — two dots and three agree, so it proves nothing")
      .toEqual(["docs/other.tsx", "mine.txt", "other.txt"]);
    // And `docs/other.tsx` is the shape that refused: a UI file the branch
    // has never contained.
    expect(reading.files).not.toContain("docs/other.tsx");
  });

  test("SC-1879: a diff git could not answer is UNMEASURED, never an empty list", () => {
    // The old call sites read `if (!diff.ok || !diff.output) return; // no
    // changed files`. Those are opposite facts: an empty list waves every
    // file-matched gate below through, and so does a failure
    // (.claude/rules/config-access.md, Silent Default Substitution).
    const { root } = forkedRepo();
    const unknown = "0".repeat(40);
    const failed = readBranchDiff(unknown, runner(root), "quinn-tested-changed-files");
    expect(failed.files, "an unresolvable sha read as 'nothing changed'").toBeNull();
    expect(failed.reason).toContain("UNMEASURED");
    expect(failed.reason, "the UNMEASURED line does not name the check that could not measure")
      .toContain("quinn-tested-changed-files");

    // …and a branch that genuinely changed nothing is an empty list, which
    // is a measurement. Without this row the two could be collapsed into one
    // and everything above still passes.
    const head = git(root, "rev-parse", "HEAD");
    const none = readBranchDiff(head, runner(root), "contextual-skip-validation");
    expect(none.files).toEqual([]);
  });

  test("SC-1880: a scope sha that is not a git object name gets no command built for it", () => {
    // It is read out of workflow-state.json, which this run's own agents
    // write, and the three call sites used to interpolate it into a shell.
    // The runner is argv-form now; this is the second half, and the one a
    // later edit is most likely to widen.
    const calls: string[][] = [];
    const spy = (args: string[]) => { calls.push(args); return { ok: true, output: "" }; };
    for (const bad of ["$(touch /tmp/pwned)", "HEAD; echo hi", "", "main", null, undefined, 42]) {
      const r = readBranchDiff(bad as unknown, spy, "prove-evidence-type");
      expect(r.files, `${JSON.stringify(bad)} was accepted as a sha`).toBeNull();
    }
    expect(calls, "git was invoked for a value that is not a sha").toEqual([]);

    // The control: a real sha IS passed through, or the row above is
    // satisfied by a function that refuses everything.
    const ok = readBranchDiff("a".repeat(40), spy, "prove-evidence-type");
    expect(ok.files).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["diff", "--name-only", `${"a".repeat(40)}...HEAD`]);
  });

  test("SC-1881: the scope commit is read from the tree under test", () => {
    // Three dots alone still mis-attributes when the recorded sha came from
    // the wrong tree, which is how `wf_e230fddc-a71` got a sha from a branch
    // it was not shipping. The two halves are independent and this is the
    // producer one.
    const { root } = forkedRepo();
    const wt = join(root, "..", `wt-${process.pid}-${scratch.length}`);
    git(root, "worktree", "add", "-q", "-b", "shipped", wt, "HEAD");
    scratch.push(wt);
    writeFileSync(join(wt, "worktree-only.txt"), "x\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "D");
    const worktreeHead = git(wt, "rev-parse", "HEAD");
    const mainHead = git(root, "rev-parse", "HEAD");
    expect(worktreeHead, "the fixture's two trees share a HEAD, so it cannot tell them apart")
      .not.toBe(mainHead);

    const sf = join(mkdtempSync(join(tmpdir(), "branch-diff-state-")), "workflow-state.json");
    scratch.push(join(sf, ".."));
    writeFileSync(sf, JSON.stringify({
      schemaVersion: 2, issue: 1, slug: "s", phase: "SCOPE",
      projectRoot: root, treeUnderTest: wt, acs: [], gates: {}, changelog: [],
    }));

    writeGateResult(sf, "scope", 1, 0, 0, [{ check: "c", result: "PASS" }], root);
    const recorded = JSON.parse(readFileSync(sf, "utf-8")).gates.scope.commitSha;
    expect(recorded, "the gate recorded the main checkout's HEAD, not the tree it measured")
      .toBe(worktreeHead);
  });
});

describe("#531: the call sites go through the reading", () => {
  const SRC = readFileSync(join(import.meta.dir, "..", "gates", "workflow.test.ts"), "utf-8");

  test("SC-1882: no gate check builds a two-dot diff against the scope sha", () => {
    // The reintroduction guard. Everything above drives the library, and
    // none of it would notice a fourth check — or a revert of one of the
    // three — spelling the command inline again.
    const twoDot = SRC.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /diff --name-only\s+\$\{[^}]*[Ss]ha[^}]*\}\.\.(?!\.)/.test(line))
      .map(([n, line]) => `gates/workflow.test.ts:${n}: ${line.trim()}`);
    expect(twoDot, `a two-dot scope diff is back:\n${twoDot.join("\n")}`).toEqual([]);

    // The instrument: the pattern matches the line that was there, so an
    // empty result means the line is gone rather than that the regex is.
    expect(/diff --name-only\s+\$\{[^}]*[Ss]ha[^}]*\}\.\.(?!\.)/
      .test('const diff = exec(`git diff --name-only ${scopeSha}..HEAD`, root);')).toBe(true);
    // …and it does NOT match the three-dot spelling, or it would fire on the
    // fix and the guard would have to be deleted to go green.
    expect(/diff --name-only\s+\$\{[^}]*[Ss]ha[^}]*\}\.\.(?!\.)/
      .test('git diff --name-only ${scopeSha}...HEAD')).toBe(false);

    // All three checks reach the shared reading, named one by one — a count
    // would stay right while one of them drifted back.
    for (const check of [
      "prove-evidence-type",
      "contextual-skip-validation",
      "quinn-tested-changed-files",
    ]) {
      expect(SRC, `${check} no longer reads the branch diff through the shared binding`)
        .toContain(`readBranchDiff(scopeSha, a => execArgvOf("git", a, root), "${check}")`);
    }
    expect(branchDiffArgs("abc1234")[2], "the shared binding stopped using three dots")
      .toBe("abc1234...HEAD");
  });
});
