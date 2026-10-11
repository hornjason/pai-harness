/**
 * A collection that resolved nothing must refuse, and an annotated path must
 * still resolve (#279)
 *
 * Run `wf_ea3e428f-64f` (#273) produced 926 lines of correct, tested work and
 * dropped every line of it while exiting 0. The agent reported five files:
 *
 *     "lib/strip-js-comments.ts (NEW, 178 lines)"
 *     "test/spec-compliance.test.ts (MOD: +SHIP_CODE at L8-28, ...)"
 *     ...
 *
 * Each entry carries a trailing human annotation, and the collector joins the
 * whole string onto the worktree path, so every lookup missed. That is the
 * parsing half, and on its own it would have cost one round.
 *
 * The expensive half is that nothing noticed. `scripts/collect-worktree-files.ts`
 * already carries a guard written for exactly this, and its comment says so:
 *
 *     if (groups.length === 0) {
 *       // ... Silence here would commit nothing and call it a success.
 *
 * It tests `groups.length` — the number of WORKTREES — not the number of files
 * resolved. This run had one worktree, so the guard passed; all five files then
 * failed to resolve, the misses were printed as warnings, and the script exited
 * zero. The refusal message it would have printed, "no files resolved to any
 * worktree", is the condition it claims to detect and is not the condition it
 * tests.
 *
 * The two halves are tested apart on purpose. Fixing the annotation makes the
 * #273 inputs resolve and leaves the guard exactly as blind as it was; the next
 * unparseable shape would be dropped just as quietly. A test that only exercised
 * the real inputs would go green on half a fix.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "collect-worktree-files.ts");

let root: string;
let mainRepo: string;
let agentWorktree: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" });

/** Run the real script the way ship.js runs it, and report its exit code. */
function runCollect(groups: unknown): { status: number; stderr: string; stdout: string } {
  const groupsPath = join(root, "groups.json");
  writeFileSync(groupsPath, JSON.stringify(groups, null, 2));
  const r = spawnSync(
    "bun",
    [SCRIPT, groupsPath, mainRepo, join(mainRepo, ".claude", "worktrees")],
    { encoding: "utf-8", cwd: mainRepo },
  );
  return { status: r.status ?? -1, stderr: r.stderr || "", stdout: r.stdout || "" };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "collect-279-")));
  mainRepo = join(root, "project");
  mkdirSync(mainRepo, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main", mainRepo], { stdio: "pipe" });
  git(mainRepo, "config", "user.email", "t@example.com");
  git(mainRepo, "config", "user.name", "t");
  writeFileSync(join(mainRepo, "README.md"), "x\n");
  git(mainRepo, "add", "README.md");
  git(mainRepo, "commit", "-q", "-m", "init");

  agentWorktree = join(mainRepo, ".claude", "worktrees", "wf_test-24");
  mkdirSync(join(mainRepo, ".claude", "worktrees"), { recursive: true });
  git(mainRepo, "worktree", "add", "-q", "-b", "agent-24", agentWorktree);

  // One real file the agent "wrote", so the resolving cases have something to
  // find and the refusing cases are refusing for the reason under test rather
  // than because the fixture is empty.
  mkdirSync(join(agentWorktree, "lib"), { recursive: true });
  writeFileSync(join(agentWorktree, "lib", "strip-js-comments.ts"), "export const x = 1\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("#279: the fixture is real before anything is asserted about it", () => {
  test("the agent worktree exists and carries the file", () => {
    // Guards the premise. Every refusal case below would pass for the wrong
    // reason against a fixture with no worktree at all.
    expect(existsSync(agentWorktree)).toBe(true);
    expect(existsSync(join(agentWorktree, "lib", "strip-js-comments.ts"))).toBe(true);
    expect(git(mainRepo, "worktree", "list", "--porcelain")).toContain(realpathSync(agentWorktree));
  });
});

describe("#279: a collection that resolved nothing refuses", () => {
  test("one worktree, one unresolvable file — exits non-zero", () => {
    // THE REGRESSION. Before the fix this exits 0 having collected nothing,
    // and ship.js commits an empty tree believing the agent produced nothing
    // worth keeping. `groups.length` is 1 here, which is why the existing
    // guard sails past it.
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["lib/does-not-exist-9f3a.ts"] },
    ]);
    expect(
      r.status,
      "a collection that resolved zero files reported success — this is #81 and #279",
    ).not.toBe(0);
  });

  test("the refusal names the entries that did not resolve", () => {
    // A refusal that says "nothing collected" costs a round and teaches
    // nothing. The next reader has to be able to see WHICH entry was wrong,
    // because the failure mode is a path shape nobody anticipated.
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["lib/does-not-exist-9f3a.ts"] },
    ]);
    expect(r.stderr).toContain("does-not-exist-9f3a.ts");
  });

  test("the refusal message describes the condition actually tested", () => {
    // The old message claimed "no files resolved to any worktree" while
    // testing the worktree count. A message that names a different fact than
    // the one it checked is how this went unnoticed through a whole run.
    const r = runCollect([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to report an empty collection as success/);
  });

  test("many worktrees, none resolving, still refuses", () => {
    // `groups.length` grows with worktrees, so the broken guard gets MORE
    // confident as the run gets bigger. Three groups and nothing found is the
    // worst case, not the safest one.
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["a.ts"] },
      { worktreePath: agentWorktree, filesChanged: ["b.ts"] },
      { worktreePath: agentWorktree, filesChanged: ["c.ts"] },
    ]);
    expect(r.status).not.toBe(0);
  });
});

describe("#279: an annotated path resolves to the file it names", () => {
  test("the #273 entry, verbatim", () => {
    // Taken from ~/.rungate/pai-harness-273/worktree-groups.json rather than
    // invented, so the test cannot drift from the shape that actually broke.
    const r = runCollect([
      {
        worktreePath: agentWorktree,
        filesChanged: ["lib/strip-js-comments.ts (NEW, 178 lines)"],
      },
    ]);
    expect(
      r.status,
      "the annotated entry did not resolve — the whole #273 change set was dropped this way",
    ).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/does not exist/);
  });

  test("a bare path keeps working", () => {
    // The annotation fix must not become a requirement. Most agents report a
    // plain path and those runs must not start refusing.
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["lib/strip-js-comments.ts"] },
    ]);
    expect(r.status).toBe(0);
  });

  test("an annotation is not an excuse to accept a path that is really missing", () => {
    // The cheap wrong fix is to strip everything after the first space and
    // hope. A file that does not exist must still be a miss after stripping,
    // or the annotation fix becomes a second way to drop work silently.
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["lib/not-here-7c2b.ts (NEW, 40 lines)"] },
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("not-here-7c2b.ts");
  });

  test("a path containing a space is not mangled into a miss", () => {
    // Stripping at the first space would break a legitimate path and trade a
    // silent drop for a silent rejection. Only a trailing parenthesised
    // annotation is an annotation.
    mkdirSync(join(agentWorktree, "docs"), { recursive: true });
    writeFileSync(join(agentWorktree, "docs", "my notes.md"), "x\n");
    const r = runCollect([
      { worktreePath: agentWorktree, filesChanged: ["docs/my notes.md"] },
    ]);
    expect(r.status, "a real path with a space in it was rejected").toBe(0);
  });
});
