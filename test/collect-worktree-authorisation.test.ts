/**
 * #120: authorised worktree roots come from git, not from caller arguments.
 *
 * `git worktree add` run from inside a linked worktree resolves against the
 * COMMON dir, so agent worktrees land under the main checkout no matter which
 * worktree the caller is in. `authorisedWorktrees` was handed `projectRoot`
 * and `harnessRoot` and intersected git's worktree list with those — which
 * covers the usual case by luck, and silently authorises nothing when neither
 * argument is the main checkout.
 *
 * That is not hypothetical: #77 recorded projectRoot=rungate-65 with every
 * worktree under rungate, and #120 recorded the same failure one stage later
 * in Verify. Both ended as SHIP_FAILED on a completed implementation.
 *
 * These build a real repo with a real linked worktree rather than faking git
 * output, because the behaviour under test IS git's path resolution.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { authorisedWorktrees, gitWorktreeBase } from "../scripts/collect-worktree-files";

let root: string;
let mainRepo: string;
let sideWorktree: string;
let agentWorktree: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wt-auth-")));
  mainRepo = join(root, "project");
  mkdirSync(mainRepo, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main", mainRepo], { stdio: "pipe" });
  git(mainRepo, "config", "user.email", "t@example.com");
  git(mainRepo, "config", "user.name", "t");
  writeFileSync(join(mainRepo, "README.md"), "x\n");
  git(mainRepo, "add", "README.md");
  git(mainRepo, "commit", "-q", "-m", "init");

  // The layout from #77: a dedicated per-session checkout alongside the main
  // repo. This is what gets passed as projectRoot.
  sideWorktree = join(root, "project-65");
  git(mainRepo, "worktree", "add", "-q", "-b", "session-65", sideWorktree);

  // The agent worktree. Created from INSIDE the side worktree, which is how
  // the harness does it — and it still lands under the main repo, which is
  // the whole point.
  agentWorktree = join(mainRepo, ".claude", "worktrees", "wf_test-1");
  mkdirSync(join(mainRepo, ".claude", "worktrees"), { recursive: true });
  git(sideWorktree, "worktree", "add", "-q", "-b", "agent-1", agentWorktree);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("#120: worktree authorisation is derived from git", () => {
  test("the agent worktree really does land under the main repo", () => {
    // Guards the premise. If git ever stopped resolving against the common
    // dir, every assertion below would pass for the wrong reason and this
    // whole file would be testing nothing.
    const listed = git(sideWorktree, "worktree", "list", "--porcelain");
    expect(listed).toContain(realpathSync(agentWorktree));
    expect(realpathSync(agentWorktree).startsWith(realpathSync(mainRepo))).toBe(true);
  });

  test("authorises the agent worktree when the caller knows only its own checkout", () => {
    // The #77 / #120 failure, exactly: the caller passes the side worktree as
    // both roots, so `project-65/.claude/worktrees` is the only base offered
    // and it does not exist. Before the fix this returned [] and the
    // collection refused everything.
    const allowed = authorisedWorktrees(sideWorktree, [
      join(sideWorktree, ".claude", "worktrees"),
    ]);
    expect(allowed, "git's own worktree location was ignored").toContain(
      realpathSync(agentWorktree),
    );
  });

  test("authorises it even when the caller passes a base that is plain wrong", () => {
    const allowed = authorisedWorktrees(sideWorktree, [join(root, "nowhere")]);
    expect(allowed).toContain(realpathSync(agentWorktree));
  });

  test("caller-supplied bases are still honoured, not replaced", () => {
    // The derived base is added, not substituted. A layout that legitimately
    // puts worktrees somewhere else must keep working.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const other = join(elsewhere, "wf_other");
    git(mainRepo, "worktree", "add", "-q", "-b", "agent-2", other);

    const allowed = authorisedWorktrees(sideWorktree, [elsewhere]);
    expect(allowed).toContain(realpathSync(other));
    expect(allowed, "the derived base was lost when a caller base was given")
      .toContain(realpathSync(agentWorktree));
  });

  test("a worktree outside every authorised base is still refused", () => {
    // The check must keep refusing. Without this the fix could be "authorise
    // everything", which passes all of the above and removes the boundary.
    const outside = join(root, "unauthorised", "wf_rogue");
    mkdirSync(join(root, "unauthorised"), { recursive: true });
    git(mainRepo, "worktree", "add", "-q", "-b", "agent-3", outside);

    const allowed = authorisedWorktrees(sideWorktree, [
      join(sideWorktree, ".claude", "worktrees"),
    ]);
    expect(allowed, "an unauthorised worktree was accepted").not.toContain(
      realpathSync(outside),
    );
  });

  test("gitWorktreeBase points at the main checkout, from either checkout", () => {
    const fromMain = gitWorktreeBase(mainRepo);
    const fromSide = gitWorktreeBase(sideWorktree);
    const expected = join(realpathSync(mainRepo), ".claude", "worktrees");
    expect(realpathSync(fromMain!.replace(/\/\.claude\/worktrees$/, ""))).toBe(
      realpathSync(mainRepo),
    );
    expect(fromSide, "the side worktree resolved to its own path, not the common dir")
      .toBe(fromMain);
    expect(realpathSync(fromSide!.replace(/\/\.claude\/worktrees$/, ""))).toBe(
      realpathSync(expected.replace(/\/\.claude\/worktrees$/, "")),
    );
  });

  test("returns null outside a repository rather than throwing", () => {
    const notARepo = join(root, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    expect(gitWorktreeBase(notARepo)).toBeNull();
  });
});

/**
 * Security review on the commit above raised authorization-scope-expansion:
 * the derived base widens what the caller asked for, silently. These pin the
 * bounds that make the widening acceptable, so a later change cannot quietly
 * remove them.
 */
describe("#120: the scope expansion stays bounded", () => {
  test("another repository's worktrees are never authorised", () => {
    // The hard bound. Candidates come from `git worktree list` for THIS repo,
    // so no base — derived or supplied — can reach into a different project.
    const other = join(root, "other-project");
    mkdirSync(other, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", other], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "config", "user.email", "t@example.com"], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "config", "user.name", "t"], { stdio: "pipe" });
    writeFileSync(join(other, "f.txt"), "x\n");
    execFileSync("git", ["-C", other, "add", "f.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", other, "commit", "-q", "-m", "init"], { stdio: "pipe" });
    const otherAgent = join(other, ".claude", "worktrees", "wf_other-1");
    execFileSync("git", ["-C", other, "worktree", "add", "-q", "-b", "a", otherAgent], { stdio: "pipe" });

    // Hand our repo's authorisation the OTHER project's worktrees dir as a base.
    const allowed = authorisedWorktrees(sideWorktree, [join(other, ".claude", "worktrees")]);
    expect(allowed, "a foreign repository's worktree was authorised").not.toContain(
      realpathSync(otherAgent),
    );
  });

  test("a repo path that itself contains '.git' is not truncated", () => {
    // The strip is anchored to a trailing /.git segment. Unanchored, a repo
    // living under a directory with ".git" in its name gets cut at the first
    // occurrence and the derived base points somewhere else entirely —
    // silently authorising nothing, which is #120 all over again. No fixture
    // here had such a path, so the unanchored version survived mutation.
    const awkward = join(root, "my.github-mirror", "project");
    mkdirSync(awkward, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", awkward], { stdio: "pipe" });
    execFileSync("git", ["-C", awkward, "config", "user.email", "t@example.com"], { stdio: "pipe" });
    execFileSync("git", ["-C", awkward, "config", "user.name", "t"], { stdio: "pipe" });
    writeFileSync(join(awkward, "f.txt"), "x\n");
    execFileSync("git", ["-C", awkward, "add", "f.txt"], { stdio: "pipe" });
    execFileSync("git", ["-C", awkward, "commit", "-q", "-m", "init"], { stdio: "pipe" });

    const base = gitWorktreeBase(awkward);
    expect(base, "the repo path was truncated at an embedded '.git'").toBe(
      join(realpathSync(awkward), ".claude", "worktrees"),
    );
  });

  test("the derived base is the agent-worktree dir, not the whole main checkout", () => {
    // If it resolved to <main> rather than <main>/.claude/worktrees, every
    // worktree anywhere under the main repo would be authorised, including
    // the main checkout itself.
    const base = gitWorktreeBase(sideWorktree)!;
    expect(base.endsWith(join(".claude", "worktrees"))).toBe(true);
    const allowed = authorisedWorktrees(sideWorktree, []);
    expect(allowed, "the main checkout authorised itself").not.toContain(realpathSync(mainRepo));
    expect(allowed, "a sibling checkout was authorised").not.toContain(realpathSync(sideWorktree));
  });
});
