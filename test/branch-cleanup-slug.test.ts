/**
 * #1079: the open-PR guard must ask about the repository the branch is IN.
 *
 * `lib/branch-cleanup.ts` defaulted its slug to `hornjason/pai-harness`, and
 * the answer to that question gates a `git push origin --delete` against the
 * CALLER's origin. On any other project every branch came back "no open PR"
 * — because the branch is not in the repository being asked about — and was
 * deleted. The guard did not fail; it answered confidently about the wrong
 * resource, which is worse, because `0`, `{}` and silence at least look like
 * missing readings.
 *
 * ## What is asserted, and what is deliberately not
 *
 * Every case drives the real `executor` through a RECORDING double and reads
 * the commands it was handed. Asserting on the return value would pass over a
 * version that deleted and then reported cleanly, which is the failure mode
 * the issue names.
 *
 * ## The cheapest wrong fix, named
 *
 * **Make `repo` a required parameter and update the one call site.** The
 * symptom goes away and the types enforce it, and the next caller is free to
 * pass a slug from a config, an env var or a cache — the guard wrong again
 * with no default to blame. A case asserting only "the function throws
 * without `repo`" is GREEN under that fix. Nothing here asserts that. Every
 * case asserts that an UNRESOLVABLE slug produces NO deletion, which that fix
 * does not provide: the hook would simply start passing something.
 *
 * ## The control, and why the obvious fixture is not one
 *
 * A zero in `push --delete` is only evidence if the same fixture produces a
 * NON-zero count when the one thing under test is varied. So AC-1 and AC-1c
 * share a branch list, a clock and a PR set, and differ in exactly one
 * executor response: whether `git remote get-url origin` succeeds.
 *
 * A `git archive` export is NOT such a control. It has no `.git` and no
 * remote, so it manufactures its own "cannot resolve the slug" reading, and a
 * refusal measured on one is a refusal of the fixture rather than of the
 * code. AC-4's real-git pair is the distinguishing form: one `.git`, created
 * once, read twice, with the remote removed between the readings.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import type { CommandExecutor } from "../lib/branch-cleanup";
import {
  branchCleanupArmedFromEnv,
  cleanupBranch,
  cleanupStaleBranches,
  githubSlugFromRemoteUrl,
  resolveRepoSlug,
  runBranchCleanupArm,
} from "../lib/branch-cleanup";

// ── Doubles ─────────────────────────────────────────────────

interface Recorder {
  readonly executor: CommandExecutor;
  /** Every `cmd arg arg …` the code under test issued, in order. */
  readonly commands: string[];
  /** Just the remote deletions — the irreversible ones. */
  deletions(): string[];
}

/**
 * Records every command and answers the two reads the code performs.
 *
 * `originUrl: null` makes `git remote get-url origin` exit 128 the way a repo
 * with no `origin` really does. Everything else succeeds, so a `push --delete`
 * that the code decides to issue is recorded rather than suppressed by the
 * double — the double must never be the reason a deletion did not happen.
 */
function recorder(opts: {
  originUrl: string | null;
  refLines?: string[];
}): Recorder {
  const commands: string[] = [];
  const executor: CommandExecutor = (cmd, args) => {
    const full = `${cmd} ${args.join(" ")}`;
    commands.push(full);
    if (/remote get-url origin/.test(full)) {
      return opts.originUrl === null
        ? { stdout: "", stderr: "error: No such remote 'origin'", status: 128 }
        : { stdout: `${opts.originUrl}\n`, stderr: "", status: 0 };
    }
    if (/for-each-ref/.test(full)) {
      return { stdout: (opts.refLines ?? []).join("\n"), stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  return {
    executor,
    commands,
    deletions: () =>
      commands
        .filter(c => c.includes("push origin --delete"))
        .map(c => c.slice(c.lastIndexOf(" ") + 1)),
  };
}

/** A GitHub double that records WHICH repository each question was about. */
function prClient(openPRs: Array<{ repo: string; branch: string }>) {
  const asked: string[] = [];
  const client = {
    rest: {
      issues: {
        get: async () => ({ data: {} }),
        createComment: async () => ({ data: {} }),
        addLabels: async () => ({ data: [] }),
        update: async () => ({ data: {} }),
      },
      pulls: {
        create: async () => ({ data: {} }),
        update: async () => ({ data: {} }),
        list: async (p: any) => {
          const slug = `${p.owner}/${p.repo}`;
          asked.push(slug);
          return {
            data: openPRs
              .filter(pr => pr.repo === slug && pr.branch === p.head)
              .map((pr, i) => ({ number: i + 1, head: { ref: pr.branch } })),
          };
        },
      },
    },
  } as any;
  return { client, asked };
}

const DAY = 24 * 60 * 60;
const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * DAY;

/** Two stale branches. Shared by the witness and its control, byte for byte. */
const STALE_REFS = [
  `${eightDaysAgo}\trefs/remotes/origin/old-one`,
  `${eightDaysAgo}\trefs/remotes/origin/old-two`,
];

// ── AC-1: an unresolvable slug deletes nothing ──────────────

describe("#1079 AC-1: an unresolvable slug refuses the deletion", () => {
  test("cleanupStaleBranches issues ZERO push --delete when origin cannot be read", async () => {
    const rec = recorder({ originUrl: null, refLines: STALE_REFS });
    const { client, asked } = prClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual([]);
    // And the question was never ASKED of anybody. A refusal that still
    // consulted some repository would mean a slug came from somewhere.
    expect(asked).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.reading).toBe("UNMEASURED");
    expect(result.errors.join(" ")).toContain("refusing to delete");
  });

  test("AC-1b: a non-GitHub origin is unresolvable, not a guess", async () => {
    const rec = recorder({
      originUrl: "/srv/git/mirrors/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual([]);
    expect(asked).toEqual([]);
    expect(result.reading).toBe("UNMEASURED");
  });

  /**
   * The control for AC-1. Same refs, same clock, same empty PR set — the only
   * difference is that `git remote get-url origin` succeeds. Without this row
   * the zero above is equally explained by a fixture in which nothing was
   * eligible, and a battery cannot tell those apart.
   */
  test("AC-1c CONTROL: the same fixture with a resolvable origin deletes 2", async () => {
    const rec = recorder({
      originUrl: "git@github.com:acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual(["old-one", "old-two"]);
    expect(result.deleted).toEqual(["old-one", "old-two"]);
    expect(result.reading).toBe("MEASURED");
    expect(asked).toEqual(["acme/widgets", "acme/widgets"]);
  });
});

// ── AC-2: the question is asked about the resolved repository ──

describe("#1079 AC-2: the PR check is made against the project's own slug", () => {
  test("a resolved slug that is not this repository is the one consulted", async () => {
    const rec = recorder({
      originUrl: "https://github.com/acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([]);

    await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
    });

    expect(asked).toEqual(["acme/widgets", "acme/widgets"]);
    expect(asked).not.toContain("hornjason/pai-harness");
  });

  /**
   * The issue's named witness: a stale branch that HAS an open PR in its own
   * repository. Pre-#1079 the PR is invisible — the question went to
   * `hornjason/pai-harness`, which has no such branch — and the branch is
   * deleted. The PR set here is deliberately registered under BOTH slugs, so
   * a version that asked the wrong repository could not be excused by the
   * double simply having no data for it.
   */
  test("a stale branch with an open PR in its OWN repo survives", async () => {
    const rec = recorder({
      originUrl: "git@github.com:acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([
      { repo: "acme/widgets", branch: "old-two" },
    ]);

    const result = await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual(["old-one"]);
    expect(rec.deletions()).not.toContain("old-two");
    expect(result.skipped.some(s => s.includes("old-two"))).toBe(true);
    expect(asked).toEqual(["acme/widgets", "acme/widgets"]);
  });

  test("an explicit repo still wins, and no remote is read for it", async () => {
    const rec = recorder({
      originUrl: "git@github.com:acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([]);

    await cleanupStaleBranches({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      executor: rec.executor,
      githubClient: client,
      repo: "caller/supplied",
    });

    expect(asked).toEqual(["caller/supplied", "caller/supplied"]);
    expect(rec.commands.some(c => c.includes("remote get-url"))).toBe(false);
  });
});

// ── AC-3: cleanupBranch, the other entry point ──────────────

describe("#1079 AC-3: cleanupBranch refuses on an unresolvable slug", () => {
  test("neither the local nor the remote deletion is issued", async () => {
    const rec = recorder({ originUrl: null });
    const { client, asked } = prClient([]);

    const result = await cleanupBranch({
      branch: "ship-42-feature",
      projectRoot: "/tmp/not-a-real-project",
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual([]);
    // `branch -D` is local and recoverable, but it is still a deletion taken
    // on an unanswered question, so it must not happen either.
    expect(rec.commands.some(c => c.includes("branch -D"))).toBe(false);
    expect(asked).toEqual([]);
    expect(result.deleted).toBe(false);
    expect(result.error).toContain("refusing to delete");
  });

  test("AC-3b CONTROL: the same call with a resolvable origin deletes", async () => {
    const rec = recorder({ originUrl: "git@github.com:acme/widgets.git" });
    const { client, asked } = prClient([]);

    const result = await cleanupBranch({
      branch: "ship-42-feature",
      projectRoot: "/tmp/not-a-real-project",
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual(["ship-42-feature"]);
    expect(result.deleted).toBe(true);
    expect(asked).toEqual(["acme/widgets"]);
  });
});

// ── AC-4: the real git reading, with a real negative control ──

describe("#1079 AC-4: resolveRepoSlug over a real .git", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function git(root: string, args: string[]) {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }

  /**
   * One repository, read twice, differing only in whether `origin` exists.
   *
   * This is the pair a `git archive` export cannot be: an export has no
   * `.git` at all, so its refusal is produced by the fixture rather than by
   * the code, and the positive half is unavailable entirely. Here the
   * positive half is a real `git remote get-url origin` returning a real URL,
   * which absence cannot manufacture.
   *
   * It calls `resolveRepoSlug` and nothing else, so no deletion of any kind
   * is reachable from this case with the default executor.
   */
  test("a real origin resolves, and removing it is the only difference", () => {
    const root = mkdtempSync(join(tmpdir(), "rg1079-realgit-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);

    const present = resolveRepoSlug({ projectRoot: root });
    expect(present.slug).toBe("acme/widgets");
    expect(present.source).toBe("origin");
    expect(present.reason).toBeUndefined();

    git(root, ["remote", "remove", "origin"]);

    const absent = resolveRepoSlug({ projectRoot: root });
    expect(absent.slug).toBeNull();
    expect(absent.reason).toBeTruthy();
  });
});

// ── AC-5: the parser, and the absence of any fallback ───────

describe("#1079 AC-5: githubSlugFromRemoteUrl", () => {
  test.each([
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["git@github.com:acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets/", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
    ["  https://github.com/acme/widgets\n", "acme/widgets"],
  ])("%s resolves to %s", (url, slug) => {
    expect(githubSlugFromRemoteUrl(url)).toBe(slug);
  });

  test.each([
    ["an empty remote", ""],
    ["a local path", "/srv/git/mirrors/widgets.git"],
    ["a non-GitHub host", "https://gitlab.com/acme/widgets.git"],
    ["one path segment", "https://github.com/acme"],
    ["three path segments", "https://github.com/acme/widgets/extra"],
    ["a traversal", "git@github.com:../../etc/passwd"],
  ])("%s resolves to nothing", (_label, url) => {
    expect(githubSlugFromRemoteUrl(url)).toBeNull();
  });

  /**
   * The rule the issue is actually about, asserted structurally rather than
   * behaviourally. Every behavioural case above would stay green if someone
   * reintroduced a literal behind one more condition; this would not.
   */
  test("the module contains no hardcoded consumer repository slug", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(
      join(import.meta.dir, "..", "lib", "branch-cleanup.ts"),
      "utf-8",
    );
    // Strip the block comments — the header explains the defect by name, and
    // a scan that cannot tell prose from code reports the explanation as the
    // thing it explains.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Two shapes are `owner/repo` without being one: a git ref path
    // (`refs/remotes/...`) and a relative module specifier (`./github`).
    // Everything else of that shape in a string literal is the defect.
    const slugs = (code.match(/["'`][A-Za-z0-9._-]+\/[A-Za-z0-9._-]+["'`]/g) ?? [])
      .filter(s => !/^["'`](?:refs|\.|\.\.)\//.test(s));
    expect(
      slugs,
      "lib/branch-cleanup.ts must contain no repository slug literal: the slug " +
        "is an authorization input, and a default that is wrong for every caller " +
        "but one is #1079. Resolve it from the project's own origin and refuse " +
        "when it cannot be resolved.",
    ).toEqual([]);
  });
});

// ── AC-6: the arming binding ────────────────────────────────

describe("#1079 AC-6: the branch-deletion arm is disarmed by default", () => {
  test.each([
    ["unset", {}, false],
    ["explicitly undefined", { RUNGATE_BRANCH_CLEANUP: undefined }, false],
    ["empty", { RUNGATE_BRANCH_CLEANUP: "" }, false],
    ["0", { RUNGATE_BRANCH_CLEANUP: "0" }, false],
    ["true", { RUNGATE_BRANCH_CLEANUP: "true" }, false],
    ["TRUE", { RUNGATE_BRANCH_CLEANUP: "TRUE" }, false],
    ["yes", { RUNGATE_BRANCH_CLEANUP: "yes" }, false],
    ["10 (a prefix match)", { RUNGATE_BRANCH_CLEANUP: "10" }, false],
    ["' 1' (padded)", { RUNGATE_BRANCH_CLEANUP: " 1" }, false],
    ["1", { RUNGATE_BRANCH_CLEANUP: "1" }, true],
  ])("%s arms: %s", (_label, env, armed) => {
    expect(branchCleanupArmedFromEnv(env as Record<string, string | undefined>))
      .toBe(armed);
  });

  /**
   * A disarm nobody consults is the second shape in
   * `.claude/rules/checks-must-be-able-to-fail.md`, so the arm is DRIVEN
   * rather than grepped: a disarmed run must issue no git command at all,
   * not merely skip the delete.
   */
  test("a disarmed arm issues no git command whatsoever", async () => {
    const rec = recorder({
      originUrl: "git@github.com:acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client, asked } = prClient([]);

    const report = await runBranchCleanupArm({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      env: {},
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.commands).toEqual([]);
    expect(asked).toEqual([]);
    expect(report.armed).toBe(false);
    expect(report.deleted).toBe(0);
    expect(report.lines.join(" ")).toContain("disarmed");
  });

  /**
   * The control. Same fixture, same recorder, one environment variable
   * different — without it the zero above is equally explained by a fixture
   * in which nothing was eligible.
   */
  test("CONTROL: the same arm, armed, deletes 2", async () => {
    const rec = recorder({
      originUrl: "git@github.com:acme/widgets.git",
      refLines: STALE_REFS,
    });
    const { client } = prClient([]);

    const report = await runBranchCleanupArm({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      env: { RUNGATE_BRANCH_CLEANUP: "1" },
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual(["old-one", "old-two"]);
    expect(report.armed).toBe(true);
    expect(report.deleted).toBe(2);
    expect(report.lines.join(" ")).toContain("armed, deleted 2");
  });

  /** Armed, but the repository cannot be resolved: still no deletion. */
  test("armed plus an unresolvable slug is UNMEASURED and deletes nothing", async () => {
    const rec = recorder({ originUrl: null, refLines: STALE_REFS });
    const { client } = prClient([]);

    const report = await runBranchCleanupArm({
      projectRoot: "/tmp/not-a-real-project",
      maxAgeDays: 7,
      env: { RUNGATE_BRANCH_CLEANUP: "1" },
      executor: rec.executor,
      githubClient: client,
    });

    expect(rec.deletions()).toEqual([]);
    expect(report.armed).toBe(true);
    expect(report.reading).toBe("UNMEASURED");
    expect(report.lines.join(" ")).toContain("UNMEASURED");
  });

  /**
   * The hook is the only caller, so the arm is only reached if the hook calls
   * it. `specs/HOOK-ARCHITECTURE-SPEC.md` makes the hook a thin trigger, so
   * this asserts the LINKAGE and nothing about the logic — that is above.
   */
  test("the hook delegates to the arm and decides nothing itself", async () => {
    const { readFileSync } = await import("fs");
    const hook = readFileSync(
      join(import.meta.dir, "..", "hooks", "StaleTTLCleanup.hook.ts"),
      "utf-8",
    );
    expect(hook).toContain("runBranchCleanupArm({");
    // And must not reach the raw sweep, which carries no arming of its own.
    expect(hook).not.toContain("cleanupStaleBranches(");
  });
});
