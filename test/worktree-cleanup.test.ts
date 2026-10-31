import { test, expect, describe } from "bun:test";
import { cleanupWorktrees, type CleanupResult, type CleanupOptions } from "../lib/worktree-cleanup";
import { join } from "path";
import { existsSync } from "fs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { strandedBranches, rescueStrandedBranches, rescueReportLines, protectedFromRescue, checkedOutBranches, RESCUE_BUDGET_MS } from "../lib/worktree-cleanup";

describe("worktree-cleanup", () => {
  test("cleanupWorktrees function exists and is importable", () => {
    expect(typeof cleanupWorktrees).toBe("function");
  });

  test("returns correct CleanupResult shape", async () => {
    const result = await cleanupWorktrees({
      projectRoot: "/nonexistent/path",
    });

    expect(result).toHaveProperty("removed");
    expect(result).toHaveProperty("kept");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test("handles non-existent worktrees directory gracefully", async () => {
    const result = await cleanupWorktrees({
      projectRoot: "/nonexistent/path",
    });

    expect(result.removed.length).toBe(0);
    expect(result.kept.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  test("with real repo: verifies function runs without crashing", async () => {
    const projectRoot = join(import.meta.dir, "..");
    const worktreesDir = join(projectRoot, ".claude", "worktrees");

    // Only run this test if worktrees directory exists
    if (!existsSync(worktreesDir)) {
      expect(true).toBe(true); // Skip test
      return;
    }

    const result = await cleanupWorktrees({
      projectRoot,
      maxAgeMs: 365 * 24 * 60 * 60 * 1000, // 1 year — don't actually remove anything
    });

    // Verify result structure
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.kept)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);

    // With 1-year age filter, nothing should be removed
    expect(result.removed.length).toBe(0);
  });

  test("respects maxAgeMs filter", async () => {
    const projectRoot = join(import.meta.dir, "..");
    const worktreesDir = join(projectRoot, ".claude", "worktrees");

    if (!existsSync(worktreesDir)) {
      expect(true).toBe(true); // Skip test
      return;
    }

    // With very high maxAgeMs, nothing should qualify
    const result = await cleanupWorktrees({
      projectRoot,
      maxAgeMs: 999 * 365 * 24 * 60 * 60 * 1000, // 999 years
    });

    expect(result.removed.length).toBe(0);
  });

  test("CleanupOptions interface accepts projectRoot", () => {
    const opts: CleanupOptions = {
      projectRoot: "/some/path",
    };
    expect(opts.projectRoot).toBe("/some/path");
  });

  test("CleanupOptions interface accepts optional maxAgeMs", () => {
    const opts: CleanupOptions = {
      projectRoot: "/some/path",
      maxAgeMs: 1000,
    };
    expect(opts.maxAgeMs).toBe(1000);
  });

  test("CleanupResult interface has correct shape", () => {
    const result: CleanupResult = {
      removed: ["a", "b"],
      kept: ["c"],
      skipped: ["e"],
      // #436. Required rather than optional, so a bucket cannot be added to
      // the classifier and left out of a caller's total — which is #431's
      // defect, and the reason the summary line reconciles.
      orphaned: ["f"],
      errors: ["d"],
    };
    expect(result.removed).toEqual(["a", "b"]);
    expect(result.kept).toEqual(["c"]);
    expect(result.orphaned).toEqual(["f"]);
    expect(result.errors).toEqual(["d"]);
  });
});

/**
 * Covers SC-2630, SC-2631 (PARALLEL-AGENT-COORDINATION-SPEC.md) — #1038.
 *
 * Driven against a real bare remote rather than a stub, because the fact
 * under test is what `--not --remotes=origin` answers, and a stub that
 * returns what the test already set would hold vacuously.
 */
describe("#1038: commits that exist here and nowhere else", () => {
  const git = (cwd: string, ...a: string[]) =>
    spawnSync("git", a, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

  /**
   * The fixture spawns that take their path as an ARGUMENT rather than a cwd —
   * `init`, `init --bare`, `clone`. One seam, and it passes the environment
   * explicitly.
   *
   * Not a style preference. The last case in this file writes
   * `process.env.GIT_CONFIG_GLOBAL`, and a Bun child given no `env` key does
   * not observe a write that happened after startup (#1096) — so a bare
   * `spawnSync` here would silently run against a DIFFERENT git config from
   * the `git()` helper two lines up, which does pass one. Two environments in
   * one fixture is the shape that makes a red case look like a flake.
   */
  const gitPlain = (...a: string[]) =>
    spawnSync("git", a, { encoding: "utf-8", env: { ...process.env } });

  /** A repo with `origin` pointing at a real bare remote, one commit on main, pushed. */
  function plant(): { repo: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-"));
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    gitPlain("init", "--bare", "-b", "main", remote);
    gitPlain("init", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    return { repo, root };
  }

  const commitOn = (repo: string, branch: string, body: string) => {
    git(repo, "checkout", "-b", branch);
    writeFileSync(join(repo, `${branch.replace(/\//g, "-")}.txt`), body);
    git(repo, "add", "-A"); git(repo, "commit", "-m", `work on ${branch}`);
    git(repo, "checkout", "main");
  };

  test("a never-pushed branch is found with its count, and a pushed one is not", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/stranded", "x\n");
      commitOn(repo, "feat/landed", "y\n");
      git(repo, "push", "origin", "feat/landed");

      const found = strandedBranches(repo)!;
      const names = found.stranded.map(f => f.branch).sort();

      // The control. Without it a finder that returns every branch passes the
      // positive case and is wrong about the only question that matters.
      expect(names, "a branch already on origin must not be reported").toEqual(["feat/stranded"]);
      expect(found.stranded[0].commits).toBe(1);
      expect(found.unreadable, "every branch was countable here").toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a repo with no origin reports nothing stranded, not every branch", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-noorigin-"));
    try {
      const repo = join(root, "repo");
      gitPlain("init", "-b", "main", repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
      // There is nowhere the work could have been pushed TO, so the question
      // does not apply. Answering it literally flags every branch forever.
      expect(strandedBranches(repo)).toEqual({ stranded: [], unreadable: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the rescue pushes the stranded branch, and the tree is then clean", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/stranded", "x\n");
      expect(strandedBranches(repo)!.stranded.length, "precondition: something must be stranded").toBe(1);

      const r = rescueStrandedBranches(repo);
      expect(r.unmeasured).toBeNull();
      expect(r.pushed.map(p => p.branch)).toEqual(["feat/stranded"]);
      expect(r.failed).toEqual([]);

      // The assertion that matters: ask git again, not the return value.
      // A rescue that reports success while pushing nothing is the shape
      // this whole issue is about.
      expect(strandedBranches(repo), "after the rescue nothing is local-only").toEqual({ stranded: [], unreadable: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the default branch is never pushed by the rescue", () => {
    const { repo, root } = plant();
    try {
      // main is ahead of origin/main — exactly the state that tempts a rescue.
      writeFileSync(join(repo, "b.txt"), "b\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "local main commit");

      expect(strandedBranches(repo)!.stranded.map(b => b.branch)).toContain("main");
      const r = rescueStrandedBranches(repo);
      expect(r.pushed.map(p => p.branch), "main must never be pushed unattended").not.toContain("main");
      expect(r.examined, "main is excluded before the denominator, not after").toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("examined separates a clean tree from an instrument that did not run", () => {
    const { repo, root } = plant();
    try {
      // Nothing stranded: pushed:[] and examined:0 — and that is INDISTINGUISHABLE
      // from a failed reading unless `unmeasured` carries the difference.
      const clean = rescueStrandedBranches(repo);
      expect(clean.pushed).toEqual([]);
      expect(clean.unmeasured).toBeNull();

      const broken = rescueStrandedBranches("/nonexistent/path");
      expect(broken.pushed).toEqual([]);
      expect(broken.unmeasured, "a reading that could not be taken says so").toBeTruthy();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a branch whose count cannot be read is reported, not dropped", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/stranded", "x\n");
      // A ref pointing at an object that is not in this repository. git can
      // list it, and `rev-list --count` on it fails — which is exactly the
      // shape the first version swallowed with a bare `continue`.
      writeFileSync(join(repo, ".git", "refs", "heads", "feat-broken"),
        "0000000000000000000000000000000000000001\n");

      const found = strandedBranches(repo)!;
      expect(found.unreadable, "an uncountable branch is named").toContain("feat-broken");
      expect(found.stranded.map(b => b.branch), "and it is NOT reported as clean or as stranded")
        .not.toContain("feat-broken");

      // The half that matters: it survives into the rescue's own report, so a
      // reader of the log sees it. A branch nobody could count is the likeliest
      // place for the work this feature exists to find.
      const r = rescueStrandedBranches(repo);
      expect(r.unreadable).toContain("feat-broken");
      expect(rescueReportLines(r).join("\n")).toContain("STRANDED unreadable: feat-broken");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the protected branch is the repo's real default, never the literal main", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-master-"));
    try {
      // A repository whose default is `master`. The old fallback returned
      // "main" here, so `master` — the one branch that must not be pushed —
      // was the only one left unprotected. The inverse of the intent.
      const bare = join(root, "origin.git");
      gitPlain("init", "--bare", "-b", "master", bare);
      const repo = join(root, "repo");
      gitPlain("clone", bare, repo);
      git(repo, "config", "user.email", "t@example.com");
      git(repo, "config", "user.name", "t");
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
      git(repo, "push", "origin", "master");

      // Remove the cached symref so resolution must reach the remote — the
      // state `git remote add` by hand leaves behind.
      rmSync(join(repo, ".git", "refs", "remotes", "origin", "HEAD"), { force: true });

      expect(protectedFromRescue(repo), "resolved from the remote, not guessed").toBe("master");

      writeFileSync(join(repo, "b.txt"), "b\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "local master commit");
      const r = rescueStrandedBranches(repo);
      expect(r.pushed.map(p => p.branch), "master must never be pushed unattended").not.toContain("master");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an unresolvable default branch refuses the rescue instead of guessing", () => {
    const { repo, root } = plant();
    try {
      // The case the `master` test above CANNOT see. There, ls-remote answers,
      // so the fallback line is never reached and a mutant restoring the old
      // `return "main"` stays green — measured, not assumed. Here BOTH routes
      // fail: no local symref, and a remote that does not exist. The only
      // honest answer is "I could not tell", and the rescue must refuse rather
      // than protect a branch name it guessed.
      rmSync(join(repo, ".git", "refs", "remotes", "origin", "HEAD"), { force: true });
      git(repo, "remote", "set-url", "origin", join(root, "no-such-remote.git"));
      commitOn(repo, "feat/stranded", "x\n");

      expect(protectedFromRescue(repo), "unresolvable is null, never a guess").toBeNull();

      const r = rescueStrandedBranches(repo);
      expect(r.unmeasured, "the refusal says WHICH reading failed").toContain("default branch");
      expect(r.pushed, "nothing is pushed when the protected branch is unknown").toEqual([]);
      expect(r.examined, "and the denominator is not quietly a success").toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a repo with no origin is CLEAN, and costs no network call", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-cleanroom-"));
    try {
      const repo = join(root, "repo");
      gitPlain("init", "-b", "main", repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "base");

      // `strandedBranches` already answers "the question does not apply" here.
      // The rescue must agree. Asking protectedFromRescue anyway would reach
      // for ls-remote on a repo with no remote, get null, and report
      // UNMEASURED — a clean tree rendered as an instrument failure, which is
      // this issue's own defect with the sign flipped.
      const r = rescueStrandedBranches(repo);
      expect(r.unmeasured, "nothing stranded is a reading, not a failure").toBeNull();
      expect(r.pushed).toEqual([]);
      expect(r.examined).toBe(0);
      expect(rescueReportLines(r), "and it says nothing at all").toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * The combination the other cases do not reach: NOTHING stranded and
   * something unreadable at the same time.
   *
   * Raised on #1687 as a conflation — `found.stranded.length === 0`
   * short-circuits to a CLEAN reading, and that predicate is true both when
   * the tree is genuinely clean and when every branch in it failed to count.
   * The two must not produce the same bytes. They do not: `unreadable` is
   * carried through the short-circuit and `rescueReportLines` prints it, so
   * a reader of the log sees the branch nobody could measure.
   *
   * The control is the no-origin case above, which asserts
   * `rescueReportLines(r)` is EXACTLY empty on a genuinely clean tree. Without
   * it this case passes against a reporter that narrates on every run.
   */
  test("nothing stranded AND something unreadable is not the same reading as clean", () => {
    const { repo, root } = plant();
    try {
      // A ref pointing at an object this repository does not have. It lists,
      // and it cannot be counted — so `stranded` stays empty while
      // `unreadable` does not.
      writeFileSync(join(repo, ".git", "refs", "heads", "feat-uncountable"),
        "0000000000000000000000000000000000000001\n");

      const found = strandedBranches(repo)!;
      expect(found.stranded, "precondition: nothing may be stranded here").toEqual([]);
      expect(found.unreadable, "precondition: something must be uncountable").toContain("feat-uncountable");

      const r = rescueStrandedBranches(repo);
      expect(r.unmeasured, "the rescue itself took a reading").toBeNull();
      expect(r.pushed).toEqual([]);
      expect(r.unreadable, "the uncountable branch survives the short-circuit").toContain("feat-uncountable");
      // The half that makes the two readings distinguishable to a HUMAN, which
      // is the whole point: the clean tree above prints nothing, this prints.
      expect(rescueReportLines(r).join("\n")).toContain("STRANDED unreadable: feat-uncountable");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * Raised on #1687 round 8, and the most serious thing found in the whole
   * PR: this arm pushes at EVERY SessionStart with no opt-in flag, from
   * whatever checkout the session happens to be in — which is normally one
   * somebody is working in, not an abandoned worktree. Commit WIP, start a
   * session, and unfinished work is on the remote with nobody having asked.
   *
   * The control is the second half: a stranded branch that is NOT checked
   * out still gets pushed in the same sweep. Without it, "decline
   * everything" passes the first assertion and silently disables the
   * feature — which is the state #1038 existed to get out of.
   */
  test("the branch this checkout is ON is never published, and the others still are", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/left-behind", "x\n");   // stranded, not checked out
      commitOn(repo, "feat/live-work", "y\n");     // stranded, about to be checked out
      git(repo, "checkout", "feat/live-work");

      expect(strandedBranches(repo)!.stranded.map(b => b.branch).sort(),
        "precondition: both must be stranded, or this measures nothing")
        .toEqual(["feat/left-behind", "feat/live-work"]);

      const r = rescueStrandedBranches(repo);

      expect(r.declined, "the checked-out branch is live work").toEqual(["feat/live-work"]);
      expect(r.pushed.map(p => p.branch), "and it was not published").not.toContain("feat/live-work");
      // The control. A rescue that declines everything also satisfies the two
      // assertions above while doing nothing at all.
      expect(r.pushed.map(p => p.branch), "the genuinely stranded branch still is")
        .toEqual(["feat/left-behind"]);
      expect(rescueReportLines(r).join("\n"), "and the log says WHY it was held back")
        .toContain("STRANDED declined: feat/live-work");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * Round 9: the decline guard must fail CLOSED.
   *
   * The first version defaulted `active` to "" when `rev-parse` failed. No
   * branch equals "", so nothing was declined and every stranded branch —
   * including the live one the guard exists to protect — was published,
   * precisely when git was in the state least worth trusting. That is the
   * fail-open shape `.claude/rules/checks-must-be-able-to-fail.md` names
   * first: a guard reporting "nothing to protect" because it could not look.
   *
   * The unreadable HEAD is made by pointing `.git/HEAD` at a ref that cannot
   * resolve, which is what a half-written HEAD during a concurrent operation
   * looks like. The precondition asserts the push WOULD otherwise have
   * happened, so a green row cannot come from there being nothing to push.
   */
  /**
   * Round 9's high finding, and the population #1038 is actually about.
   *
   * An agent works in `.claude/worktrees/wt-a` on a branch with a local
   * commit. SessionStart fires the hook, which resolves `PROJECT_ROOT` via
   * `repoRootFrom` — that runs `rev-parse --git-common-dir`, so from a
   * worktree it names the MAIN checkout. Two earlier versions of this guard
   * read the main checkout's HEAD, did not match the worktree's branch, and
   * published somebody's live work.
   *
   * The control is the third branch: stranded, checked out NOWHERE, and
   * still pushed in the same sweep. Without it "decline everything" passes.
   */
  test("a branch live in a LINKED WORKTREE is declined, not just the main checkout's", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/in-worktree", "x\n");
      commitOn(repo, "feat/nowhere", "y\n");

      const wt = join(root, "wt-a");
      git(repo, "worktree", "add", wt, "feat/in-worktree");

      // The main checkout is on main; the live branch is only in the worktree.
      expect(gitPlain("-C", repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim(),
        "precondition: main's HEAD is NOT the branch under test, or this measures nothing")
        .toBe("main");
      expect(strandedBranches(repo)!.stranded.map(b => b.branch).sort(),
        "precondition: both are stranded")
        .toEqual(["feat/in-worktree", "feat/nowhere"]);

      const r = rescueStrandedBranches(repo);

      expect(r.declined, "the worktree's branch is live work").toEqual(["feat/in-worktree"]);
      expect(r.pushed.map(p => p.branch), "and it was not published").not.toContain("feat/in-worktree");
      // The control.
      expect(r.pushed.map(p => p.branch), "a branch checked out nowhere is still rescued")
        .toEqual(["feat/nowhere"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * Round 10: `examined: 0` is overdetermined, so the fields that separate
   * its causes must actually differ.
   *
   * Adding `declined` created a third way to reach `examined: 0, pushed: [],
   * unmeasured: null` — "every stranded branch is live work" — alongside
   * "nothing was stranded". Those are different facts about somebody's
   * machine: one means there is nothing to save, the other means there is
   * unsaved work and this deliberately did not publish it.
   *
   * Asserted as a contrast over ONE varying input: the same repository, with
   * and without the stranded branch being checked out. Both rows produce
   * `examined: 0`, which is the point — the discriminator has to be
   * something else, and it is `declined` and the log line.
   */
  test("examined: 0 from all-declined is distinguishable from examined: 0 from nothing-stranded", () => {
    const a = plant();
    const b = plant();
    try {
      // Row 1 — stranded AND checked out: live work, nothing to push.
      commitOn(a.repo, "feat/live", "x\n");
      git(a.repo, "checkout", "feat/live");
      const allDeclined = rescueStrandedBranches(a.repo);

      // Row 2 — genuinely nothing stranded.
      const nothingStranded = rescueStrandedBranches(b.repo);

      // The collision both rows share. If this stops holding the case is
      // asserting something other than what it claims.
      expect(allDeclined.examined, "row 1 reaches examined 0").toBe(0);
      expect(nothingStranded.examined, "row 2 reaches examined 0").toBe(0);
      expect(allDeclined.pushed).toEqual([]);
      expect(nothingStranded.pushed).toEqual([]);
      expect(allDeclined.unmeasured).toBeNull();
      expect(nothingStranded.unmeasured).toBeNull();

      // The discriminator.
      expect(allDeclined.declined, "live work is named").toEqual(["feat/live"]);
      expect(nothingStranded.declined, "and an empty tree names nothing").toEqual([]);
      expect(rescueReportLines(allDeclined).join("\n"),
        "a reader of the log is told work was held back").toContain("STRANDED declined: feat/live");
      expect(rescueReportLines(nothingStranded),
        "and told nothing at all when there is nothing to say").toEqual([]);
    } finally {
      rmSync(a.root, { recursive: true, force: true });
      rmSync(b.root, { recursive: true, force: true });
    }
  });

  // The `examined` doc comment used to list "only the default branch was
  // stranded" as a cause of `examined: 0` alongside "nothing was stranded",
  // with the same discriminators on both. This is the measurement that
  // showed the row was not merely indistinguishable but unreachable: a
  // default branch that is itself stranded has no ref on origin, so no
  // default can be resolved and the honest answer is UNMEASURED. Asserting
  // it here means the comment cannot quietly regain the wrong row.
  test("a stranded default branch reports UNMEASURED, never a clean examined: 0", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-strand-"));
    try {
      const remote = join(root, "remote.git");
      const repo = join(root, "repo");
      gitPlain("init", "--bare", "-b", "main", remote);
      gitPlain("init", "-b", "main", repo);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
      // An origin exists, so this is not the no-remote short circuit — but
      // main was never pushed, so main is the one stranded branch.
      git(repo, "remote", "add", "origin", remote);

      const found = strandedBranches(repo);
      expect(found?.stranded.map(b => b.branch),
        "the premise: the default branch, and only it, is stranded").toEqual(["main"]);

      const r = rescueStrandedBranches(repo);
      expect(r.examined, "nothing reached the push loop").toBe(0);
      expect(r.pushed, "and nothing was published").toEqual([]);
      expect(r.unmeasured,
        "an examined: 0 here must carry a reason — a null would spell this " +
          "state the same way as a repository with nothing stranded at all",
      ).toContain("default branch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The fail-CLOSED contract, asserted where it can actually be driven.
   *
   * `null` and an empty Set must not be the same value: an empty set
   * declines nothing, so returning one on a failed read publishes every live
   * branch — which is how the two previous versions of this guard were
   * wrong. A repository that cannot be listed is the only input that
   * distinguishes them.
   *
   * The refusal WIRING — that `rescueStrandedBranches` turns a null into an
   * UNMEASURED rather than an empty decline list — is proved by mutation
   * rather than here, because `worktree list` fails only when the repository
   * is broken enough that `strandedBranches` has already refused, so no
   * fixture reaches that branch through the front door.
   */
  test("checkedOutBranches answers null on a repository it cannot list, never an empty set", () => {
    expect(checkedOutBranches("/nonexistent/path/not/a/repo"),
      "an unlistable repository must not spell the same as one with no branches checked out")
      .toBeNull();

    const { repo, root } = plant();
    try {
      const live = checkedOutBranches(repo);
      expect(live, "a readable repository answers a set, so the null above is not vacuous").not.toBeNull();
      expect([...live!], "and it names the branch the main checkout is on").toEqual(["main"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * The other half of round 8: the sweep runs synchronously from
   * SessionStart with a 120s timeout per push and no overall cap, so an
   * unreachable origin costs 120s times the number of stranded branches.
   * This machine had 14 when #1038 was written — 28 minutes before a
   * session starts.
   *
   * Driven by setting the budget to zero rather than by waiting: the
   * assertion is that the deadline is CONSULTED and that a branch it stops
   * becomes a named `failed` row, which is the part that must not be a
   * silent omission. A branch missing from every list reads as "nothing was
   * stranded".
   */
  test("a spent budget stops the sweep and names what it did not attempt", () => {
    const { repo, root } = plant();
    try {
      commitOn(repo, "feat/one", "x\n");
      commitOn(repo, "feat/two", "y\n");
      expect(strandedBranches(repo)!.stranded.length, "precondition: two stranded").toBe(2);

      expect(RESCUE_BUDGET_MS, "the budget is a real wall-clock, not a sentinel").toBeGreaterThan(0);

      // A deadline already in the past when the loop starts: every candidate
      // takes the not-attempted branch, and none is dropped.
      const r = rescueStrandedBranches(repo, 0);
      expect(r.pushed, "nothing is pushed once the budget is spent").toEqual([]);
      expect(r.failed.map(f => f.branch).sort(), "and every one is named, not omitted")
        .toEqual(["feat/one", "feat/two"]);
      for (const f of r.failed) expect(f.reason).toContain("budget");
      expect(r.examined, "the denominator still counts what was in scope").toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the push reads the user's git config, or it cannot authenticate at all", () => {
    const { repo, root } = plant();
    const saved = process.env.GIT_CONFIG_GLOBAL;
    try {
      // The control that can actually tell the two git environments apart.
      // A `file://` remote needs no credential, so an ordinary push test
      // passes under isolation OR without it and proves nothing. This makes
      // the push depend on a setting that lives ONLY in the global config:
      // an insteadOf rewrite. Under `GIT_CONFIG_GLOBAL=/dev/null` the rewrite
      // is gone and the remote name does not resolve — which is the same
      // mechanism by which `credential.helper` disappeared on the real repo.
      const bare = join(root, "remote.git"); // the name plant() gives it
      const cfg = join(root, "global.gitconfig");
      writeFileSync(cfg, `[url "file://${bare}"]\n\tinsteadOf = rescue-test://origin\n`);
      git(repo, "remote", "set-url", "origin", "rescue-test://origin");
      process.env.GIT_CONFIG_GLOBAL = cfg;

      commitOn(repo, "feat/needs-config", "x\n");
      const r = rescueStrandedBranches(repo);

      expect(r.unmeasured).toBeNull();
      expect(r.failed, "a push run under config isolation fails here").toEqual([]);
      expect(r.pushed.map(p => p.branch)).toEqual(["feat/needs-config"]);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
