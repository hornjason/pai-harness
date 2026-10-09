/**
 * #228: a refused collection must not leave the only copy of the work loose in
 * a worktree.
 *
 * Run wf_74366574-136 did the implementation, refused to collect it, returned
 * SHIP_FAILED, and left every changed file uncommitted in an agent worktree —
 * reachable from no ref at all, and one `git worktree remove --force` away
 * from gone. `scripts/preserve-worktree-work.ts` is the half of the fix that
 * touches disk: before the refusal returns, each participating worktree's
 * dirty tree is committed onto that worktree's OWN current branch, so the
 * content survives cleanup and the operator can reach it by name.
 *
 * Real repositories, real worktrees, real commits — the behaviour under test
 * is git's, and faking git output would only test the fake. Same style as
 * test/collect-worktree-authorisation.test.ts.
 *
 * What was broken to prove these can fail, run and reverted: dropping the
 * linked-worktree guard turns "the main checkout is refused" red (it commits
 * the main checkout instead), and replacing the `rev-parse --abbrev-ref HEAD`
 * lookup with a hardcoded "main" turns "the branch is read, never assumed"
 * red on the oddly-named branch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "preserve-worktree-work.ts");

interface Entry {
  worktreePath: string;
  branch: string | null;
  sha: string | null;
  status: "committed" | "clean" | "failed";
  detail?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
}

function run(args: string[]) {
  const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8" });
  const out = r.stdout ?? "";
  let entries: Entry[] = [];
  const firstLine = out.split("\n").find(l => l.trim().startsWith("["));
  if (firstLine) entries = JSON.parse(firstLine) as Entry[];
  return { code: r.status ?? -1, out, err: r.stderr ?? "", entries };
}

let root = "";
let mainRepo = "";

function freshWorktree(name: string, branch: string): string {
  const wt = join(mainRepo, ".claude", "worktrees", name);
  git(mainRepo, "worktree", "add", "-q", "-b", branch, wt);
  return realpathSync(wt);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "preserve-wt-")));
  mainRepo = join(root, "project");
  mkdirSync(mainRepo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", mainRepo], { stdio: "pipe" });
  git(mainRepo, "config", "user.email", "t@example.com");
  git(mainRepo, "config", "user.name", "t");
  mkdirSync(join(mainRepo, "lib"), { recursive: true });
  writeFileSync(join(mainRepo, "lib", "a.ts"), "original\n");
  git(mainRepo, "add", "-A");
  git(mainRepo, "commit", "-qm", "init");
  mkdirSync(join(mainRepo, ".claude", "worktrees"), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ── The thing the issue is about ─────────────────────────────────────────

describe("#228: uncollected work is committed onto the worktree's own branch", () => {
  let wt = "";

  beforeAll(() => {
    wt = freshWorktree("wf_dirty", "agent-dirty");
    writeFileSync(join(wt, "lib", "a.ts"), "CHANGED BY THE AGENT\n");
    writeFileSync(join(wt, "lib", "new.ts"), "BRAND NEW FILE\n"); // untracked
  });

  test("the run reports the worktree as committed, on its own branch", () => {
    const r = run([wt]);
    expect(r.code, r.err).toBe(0);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    expect(e.worktreePath).toBe(wt);
    expect(e.status).toBe("committed");
    expect(e.branch).toBe("agent-dirty");
    expect(e.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(r.out).toContain("PRESERVED 1");
  });

  test("the worktree is left clean — nothing uncommitted survives the refusal", () => {
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  test("the content is reachable from the branch ref, from the main checkout", () => {
    // The whole point: the operator has a NAME, and the name resolves even
    // after the worktree directory is removed.
    expect(git(mainRepo, "cat-file", "-p", "agent-dirty:lib/a.ts")).toBe("CHANGED BY THE AGENT");
    expect(git(mainRepo, "cat-file", "-p", "agent-dirty:lib/new.ts")).toBe("BRAND NEW FILE");
  });

  test("it survives the worktree being removed, which is the failure mode", () => {
    git(mainRepo, "worktree", "remove", "--force", wt);
    expect(existsSync(wt)).toBe(false);
    expect(git(mainRepo, "cat-file", "-p", "agent-dirty:lib/a.ts")).toBe("CHANGED BY THE AGENT");
  });
});

describe("#228: the branch is read, never assumed", () => {
  test("an oddly named branch is the one that receives the commit", () => {
    // lib/worktree-isolation.ts names branches `test-brief-<ts>-<rand>`, ship
    // names them something else again, and a caller may have renamed one. A
    // preserve step that reconstructed the name from a scheme would commit to
    // the wrong ref or fail outright.
    const branch = "feature/odd_name-42";
    const wt = freshWorktree("wf_odd", branch);
    writeFileSync(join(wt, "lib", "a.ts"), "ODD\n");

    const r = run([wt]);
    expect(r.code, r.err).toBe(0);
    expect(r.entries[0]!.branch).toBe(branch);
    expect(git(mainRepo, "cat-file", "-p", `${branch}:lib/a.ts`)).toBe("ODD");
  });

  test("a detached HEAD still ends up reachable from a branch ref", () => {
    // Commits on a detached HEAD are reachable from nothing, so preserving
    // onto one would satisfy "committed" and still lose the work.
    const wt = freshWorktree("wf_detached", "agent-detached");
    git(wt, "checkout", "-q", "--detach");
    writeFileSync(join(wt, "lib", "a.ts"), "DETACHED\n");

    const r = run([wt]);
    expect(r.code, r.err).toBe(0);
    const e = r.entries[0]!;
    expect(e.status).toBe("committed");
    expect(e.branch, "no branch was created for a detached worktree").toBeTruthy();
    expect(git(mainRepo, "cat-file", "-p", `${e.branch}:lib/a.ts`)).toBe("DETACHED");
  });
});

describe("#228: a clean worktree is left alone", () => {
  test("nothing to preserve reports clean and creates no commit", () => {
    const wt = freshWorktree("wf_clean", "agent-clean");
    const before = git(wt, "rev-parse", "HEAD");

    const r = run([wt]);
    expect(r.code, r.err).toBe(0);
    expect(r.entries[0]!.status).toBe("clean");
    expect(git(wt, "rev-parse", "HEAD"), "an empty commit was created").toBe(before);
  });
});

describe("#228: several worktrees are each preserved on their own branch", () => {
  test("two dirty worktrees, two branches, no cross-contamination", () => {
    const a = freshWorktree("wf_multi_a", "agent-multi-a");
    const b = freshWorktree("wf_multi_b", "agent-multi-b");
    writeFileSync(join(a, "lib", "a.ts"), "FROM A\n");
    writeFileSync(join(b, "lib", "a.ts"), "FROM B\n");

    const r = run([a, b]);
    expect(r.code, r.err).toBe(0);
    expect(r.entries.map(e => [e.worktreePath, e.branch, e.status])).toEqual([
      [a, "agent-multi-a", "committed"],
      [b, "agent-multi-b", "committed"],
    ]);
    expect(git(mainRepo, "cat-file", "-p", "agent-multi-a:lib/a.ts")).toBe("FROM A");
    expect(git(mainRepo, "cat-file", "-p", "agent-multi-b:lib/a.ts")).toBe("FROM B");
  });
});

// ── Refusals. Each one must be able to fail. ─────────────────────────────

describe("#228: the preserve step fails closed", () => {
  test("no arguments is a refusal, not a silent success", () => {
    const r = run([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/usage/i);
  });

  test("the main checkout is refused — it is not an agent worktree", () => {
    // A preserve step that would `git add -A && git commit` the main checkout
    // is strictly worse than the bug it fixes: it commits whatever the
    // developer happened to have in progress.
    writeFileSync(join(mainRepo, "lib", "a.ts"), "DEVELOPER WORK IN PROGRESS\n");
    const before = git(mainRepo, "rev-parse", "HEAD");

    const r = run([mainRepo]);
    expect(r.code, "the main checkout was accepted").not.toBe(0);
    expect(r.entries[0]!.status).toBe("failed");
    expect(r.entries[0]!.detail || "").toMatch(/linked worktree/i);
    expect(git(mainRepo, "rev-parse", "HEAD"), "the main checkout was committed").toBe(before);
    expect(git(mainRepo, "status", "--porcelain")).toContain("lib/a.ts");

    // Leave the fixture as we found it.
    writeFileSync(join(mainRepo, "lib", "a.ts"), "original\n");
  });

  test("a path that does not exist is reported failed and exits non-zero", () => {
    const r = run([join(root, "nope")]);
    expect(r.code).not.toBe(0);
    expect(r.entries[0]!.status).toBe("failed");
  });

  test("a directory that is not a repository at all is reported failed", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "f.txt"), "x\n");
    const r = run([plain]);
    expect(r.code).not.toBe(0);
    expect(r.entries[0]!.status).toBe("failed");
  });

  test("one failure does not stop the others being preserved", () => {
    // The refusal path handles several worktrees at once; abandoning the list
    // on the first bad entry would lose exactly the work this exists to save.
    const ok = freshWorktree("wf_partial", "agent-partial");
    writeFileSync(join(ok, "lib", "a.ts"), "PARTIAL OK\n");

    const r = run([join(root, "nope-again"), ok]);
    expect(r.code, "a partial failure must still be reported as a failure").not.toBe(0);
    expect(r.entries.map(e => e.status)).toEqual(["failed", "committed"]);
    expect(git(mainRepo, "cat-file", "-p", "agent-partial:lib/a.ts")).toBe("PARTIAL OK");
  });
});

describe("#228: the refusal is routed through one exit code", () => {
  const source = readFileSync(SCRIPT, "utf-8");

  test("FAIL_EXIT is declared once and every process.exit goes through it", () => {
    expect((source.match(/FAIL_EXIT\s*=/g) || []).length).toBe(1);
    const exits = source.match(/process\.exit\(([^)]*)\)/g) || [];
    expect(exits.length, "no process.exit at all — nothing can refuse").toBeGreaterThan(0);
    for (const e of exits) expect(e).toBe("process.exit(FAIL_EXIT)");
  });
});
