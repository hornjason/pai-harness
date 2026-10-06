/**
 * #81 — parallel ship cannot commit.
 *
 * `workflows/ship.js` dispatches sub-issues to N Marcus agents, each in its own
 * worktree. The aggregation at ship.js:1231 flattens every agent's
 * `filesChanged` into one list, then ship.js:1242 keeps only the LAST agent's
 * `worktreePath`. `relativizePaths` only ever tries `[commitDir, PROJECT_ROOT]`,
 * so paths from the other N-1 worktrees stay absolute, `buildSafeGitAdd`
 * rejects them (correctly — it refuses absolute paths), and the commit aborts.
 *
 * Observed on run wf_5e32e9d4-dd2: eleven agents, zero errors, 612k tokens, 37
 * minutes of work, and nothing could be committed. Seven paths from worktrees
 * -8/-9/-10 were rejected; the six from -11 went through, which is the tell —
 * -11 was the last agent, so it was the only worktree `commitDir` pointed at.
 *
 * The security check is right. The input it is handed is wrong. The fix is to
 * keep each agent's files paired with the worktree they came from, and collect
 * them into the project root before staging.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { groupFilesByWorktree, collectWorktreeFiles } from "../../lib/worktree-collect";

let root: string;
let projectRoot: string;

function makeWorktree(name: string, files: Record<string, string>): string {
  const wt = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(wt, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return wt;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rg-wt-collect-"));
  projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("#81: groupFilesByWorktree", () => {
  test("pairs each agent's files with the worktree they came from", () => {
    const groups = groupFilesByWorktree([
      { worktreePath: "/wt/-8", filesChanged: ["/wt/-8/lib/config-loader.ts"] },
      { worktreePath: "/wt/-9", filesChanged: ["/wt/-9/lib/scanner.ts"] },
    ]);
    expect(groups).toEqual([
      { worktreePath: "/wt/-8", files: ["lib/config-loader.ts"] },
      { worktreePath: "/wt/-9", files: ["lib/scanner.ts"] },
    ]);
  });

  test("the regression itself: files from every worktree survive, not just the last", () => {
    // Exactly the shape of run wf_5e32e9d4-dd2.
    const groups = groupFilesByWorktree([
      { worktreePath: "/w/wf-8", filesChanged: ["/w/wf-8/lib/config-loader.ts", "/w/wf-8/test/config-loader.test.ts"] },
      { worktreePath: "/w/wf-9", filesChanged: ["/w/wf-9/lib/scanner.ts", "/w/wf-9/test/scanner.test.ts"] },
      { worktreePath: "/w/wf-10", filesChanged: ["/w/wf-10/lib/scaffold/steps.ts"] },
      { worktreePath: "/w/wf-11", filesChanged: ["/w/wf-11/lib/other.ts"] },
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.flatMap(g => g.files)).toHaveLength(6);
  });

  test("accepts files already relative to their worktree", () => {
    const groups = groupFilesByWorktree([{ worktreePath: "/wt/-8", filesChanged: ["lib/a.ts"] }]);
    expect(groups[0].files).toEqual(["lib/a.ts"]);
  });

  test("drops a file that escapes its declared worktree", () => {
    // An agent reporting a path outside its own worktree is either confused or
    // hostile; either way copying it would write somewhere nobody authorised.
    const groups = groupFilesByWorktree([
      { worktreePath: "/wt/-8", filesChanged: ["/etc/passwd", "../../outside.ts", "/wt/-8/ok.ts"] },
    ]);
    expect(groups[0].files).toEqual(["ok.ts"]);
  });

  test("ignores agents that reported no worktree", () => {
    const groups = groupFilesByWorktree([{ worktreePath: "", filesChanged: ["lib/a.ts"] }]);
    expect(groups).toEqual([]);
  });
});

describe("#81: collectWorktreeFiles", () => {
  test("copies every worktree's files into the project root", () => {
    const a = makeWorktree("wt-a", { "lib/config-loader.ts": "A", "test/config-loader.test.ts": "AT" });
    const b = makeWorktree("wt-b", { "lib/scanner.ts": "B" });

    const result = collectWorktreeFiles(
      [
        { worktreePath: a, files: ["lib/config-loader.ts", "test/config-loader.test.ts"] },
        { worktreePath: b, files: ["lib/scanner.ts"] },
      ],
      projectRoot,
    );

    expect(result.copied.sort()).toEqual(["lib/config-loader.ts", "lib/scanner.ts", "test/config-loader.test.ts"]);
    expect(result.missing).toEqual([]);
    expect(readFileSync(join(projectRoot, "lib/config-loader.ts"), "utf-8")).toBe("A");
    expect(readFileSync(join(projectRoot, "lib/scanner.ts"), "utf-8")).toBe("B");
    expect(readFileSync(join(projectRoot, "test/config-loader.test.ts"), "utf-8")).toBe("AT");
  });

  test("returns paths relative to the project root, so buildSafeGitAdd accepts them", () => {
    const a = makeWorktree("wt-a", { "lib/a.ts": "A" });
    const { copied } = collectWorktreeFiles([{ worktreePath: a, files: ["lib/a.ts"] }], projectRoot);
    for (const p of copied) expect(p.startsWith("/")).toBe(false);
  });

  test("reports a declared file that does not exist instead of inventing one", () => {
    const a = makeWorktree("wt-a", { "lib/a.ts": "A" });
    const { copied, missing } = collectWorktreeFiles(
      [{ worktreePath: a, files: ["lib/a.ts", "lib/never-written.ts"] }],
      projectRoot,
    );
    expect(copied).toEqual(["lib/a.ts"]);
    expect(missing).toEqual([join(a, "lib/never-written.ts")]);
  });

  test("refuses to write outside the project root", () => {
    const a = makeWorktree("wt-a", { "lib/a.ts": "A" });
    expect(() => collectWorktreeFiles([{ worktreePath: a, files: ["../../escape.ts"] }], projectRoot)).toThrow();
    expect(existsSync(join(root, "escape.ts"))).toBe(false);
  });

  // Lexical containment (resolve + relative) never touches the filesystem, so a
  // path can sit inside the worktree by string while pointing anywhere on disk.
  // copyFileSync follows links, so the agent would exfiltrate a file it was
  // never given, or overwrite one outside the project.
  test("refuses a source file that is a symlink", () => {
    const a = makeWorktree("wt-a", { "placeholder": "x" });
    const secret = join(root, "outside-secret.txt");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(a, "lib-a.ts"));

    expect(() => collectWorktreeFiles([{ worktreePath: a, files: ["lib-a.ts"] }], projectRoot)).toThrow(/symlink/i);
    expect(existsSync(join(projectRoot, "lib-a.ts"))).toBe(false);
  });

  test("refuses when a destination directory is a symlink pointing out of the project", () => {
    const a = makeWorktree("wt-a", { "lib/a.ts": "A" });
    const escape = join(root, "escape-dir");
    mkdirSync(escape, { recursive: true });
    symlinkSync(escape, join(projectRoot, "lib"));

    expect(() => collectWorktreeFiles([{ worktreePath: a, files: ["lib/a.ts"] }], projectRoot)).toThrow();
    expect(existsSync(join(escape, "a.ts"))).toBe(false);
  });

  test("refuses a source reached through a symlinked directory inside the worktree", () => {
    const a = makeWorktree("wt-a", { "placeholder": "x" });
    const outside = join(root, "outside-dir");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "a.ts"), "SECRET");
    symlinkSync(outside, join(a, "lib"));

    expect(() => collectWorktreeFiles([{ worktreePath: a, files: ["lib/a.ts"] }], projectRoot)).toThrow();
  });

  test("refuses when the destination FILE is a symlink out of the project", () => {
    // The directory check is not enough: the leaf itself can be a link, and
    // copyFileSync writes through it to the target.
    const a = makeWorktree("wt-a", { "a.ts": "A" });
    const secret = join(root, "outside-secret.txt");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(projectRoot, "a.ts"));

    expect(() => collectWorktreeFiles([{ worktreePath: a, files: ["a.ts"] }], projectRoot)).toThrow(/symlink/i);
    expect(readFileSync(secret, "utf-8")).toBe("SECRET");
  });

  test("a single-worktree run is unchanged — same worktree as the project root is a no-op copy", () => {
    writeFileSync(join(projectRoot, "a.ts"), "A");
    const { copied, missing } = collectWorktreeFiles([{ worktreePath: projectRoot, files: ["a.ts"] }], projectRoot);
    expect(copied).toEqual(["a.ts"]);
    expect(missing).toEqual([]);
    expect(readFileSync(join(projectRoot, "a.ts"), "utf-8")).toBe("A");
  });
});
