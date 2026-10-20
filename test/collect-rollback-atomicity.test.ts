/**
 * #750 — `collectWorktreeFiles` copied file-by-file with no rollback, so a
 * throw after the first copy left a half-written project root.
 *
 * Eleven throw sites sit between the group loop and the `copyFileSync`. Any
 * of them firing after the first successful copy left copied files in the
 * project root with nothing putting them back, and `workflows/ship.js` then
 * reported a failed collect over a tree nobody had validated — the property
 * SC-413 exists for, one layer down.
 *
 * ## What these cases assert, and the thing they deliberately do not
 *
 * **The resulting TREE, never the order the checks run in.** #750 names the
 * cheapest wrong fix: *move the throwing checks to the top of the loop*. It
 * makes the obvious fixture go green and still copies file 1 before file 2
 * throws on an `lstat` race or a mid-run filesystem change, because every one
 * of those checks reads a path the AGENT controls and the answer can change
 * between the validating pass and the copying pass.
 *
 * A case asserting "no copy happened before the refusal" survives that fix. A
 * case asserting "the project root is byte-identical to its pre-call state"
 * does not. `AC-4` is the one that makes the difference measurable: it throws
 * from inside `copyFileSync` itself, with an `EACCES` no pre-validation pass
 * in this function looks for and none could be moved to the top to catch.
 *
 * ## The two halves a "remove what we created" rollback gets wrong
 *
 * Both are cases here because both are states the naive journal produces:
 *
 * - `AC-2` — a destination that ALREADY EXISTED must come back with its own
 *   bytes, not be deleted. Removing it turns a refused collect into data loss.
 * - `AC-3b` — a directory that already existed must NOT be removed, even
 *   though the call wrote into it.
 *
 * ## What is NOT driven end-to-end, said rather than left as an omission
 *
 * `CollectRollbackError` — the state where the copy failed AND the undo also
 * failed — is asserted as a contract (`AC-5`), not reached through a real
 * collect. Forcing a restore to fail needs the filesystem to change between
 * the copy and the undo, inside one synchronous call, and there is no seam to
 * inject that through. A fixture that faked it would be asserting the test's
 * own `throw`, so the honest claim is the narrower one: the class carries
 * both the cause and every failed undo, and says the tree is unknown.
 *
 * ## What was broken to prove these can fail
 *
 * Run over this file + `test/collect-worktree-authorisation.test.ts` +
 * `test/ship-collect-destination.test.ts` (48 tests). Counts predicted in
 * `/tmp/750-battery/predictions.md` before the battery ran, and **the
 * baseline row read first.**
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 48 pass, 0 fail | **48 pass, 0 fail** | — |
 * | M1 **the defect restored**: the catch stops calling `undoAll` — pre-#750 | 7 | **7 of 48** | a group of `["good.ts", "bad.ts"]` where `bad.ts` is a symlink: the original leaves an empty project root, the mutant leaves `good.ts` in it |
 * | M2 **the cheapest wrong fix**: validate every file in a first pass, no journal | 1 | **1 of 48** | a read-only destination directory — `copyFileSync` raises EACCES, which no pre-pass looks for |
 * | M3 rollback only REMOVES, never restores | 2 | **2 of 48** | a project root already holding `shared.ts`: the original restores `ORIGINAL`, the mutant deletes the file |
 * | M4 created directories are not journaled | 1 | **1 of 48** | `newdir/deep/a.ts` followed by a throw: the original leaves no `newdir`, the mutant leaves an empty tree |
 * | M6 the `utimesSync` restore dropped | 2 | **2 of 48** | a restored file whose mtime was `2020-01-02T03:04:05Z` |
 * | M8 `collectBackupRoot` stages under `process.cwd()` | 2 | **1 of 48** | the returned path, which is no longer under the OS temp directory |
 * | M8a the call site inlines `mkdtempSync(projectRoot)` beside the binding | 2 | **1 of 48** | the module source: two `mkdtempSync` call sites instead of one |
 *
 * **Every row matched prediction except M8, and M8 is the one that taught
 * something.** Its first two measurements were **0 of 47**, in both
 * directions, and neither zero was a gap: the backup directory is removed on
 * the success path AND the failure path, so mutant and original are
 * byte-identical in every post-call observation. There is no input on which
 * they differ — which means the case asserting "the backup is never written
 * inside the project root" was asserting nothing at all. Naming the
 * differing input before recording the zero is what exposed it
 * (`.claude/rules/checks-must-be-able-to-fail.md`).
 *
 * The repair was to give the property a binding to witness: `collectBackupRoot`
 * is exported and asserted to sit under the OS temp directory, and a second
 * case holds `mkdtempSync` to one call site so a perfect binding cannot sit
 * beside an inlined one. Two rows, 1 red each, where there had been two
 * zeros.
 *
 * **M2's first mutant was not the wrong fix.** It applied validate-first on
 * top of the journal, so the journal still rescued AC-4 and the row measured
 * 0 — a mutation that was never really applied, not a case that failed to
 * catch it. Re-run as the repair somebody would actually ship — validate
 * first *instead of* a journal — it is 1, and the single red is AC-4. Every
 * other refusal case is green under it, which is exactly the issue's own
 * prediction and the reason AC-4 exists.
 *
 * None of the mutations is left in the tree; all were run and reverted from
 * a `cp` backup, never `git checkout --`, and `lib/worktree-collect.ts` was
 * confirmed byte-identical to the measured source by sha256 after every row.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import {
  CollectRollbackError,
  collectBackupRoot,
  collectWorktreeFiles,
} from "../lib/worktree-collect";

/** One scratch tree per case, removed afterwards whatever happened. */
function withScratch<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "rungate-750-"));
  try {
    return fn(root);
  } finally {
    try {
      // Restore any permission a case removed, or the cleanup cannot recurse.
      for (const d of walkDirs(root)) chmodSync(d, 0o755);
    } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true });
  }
}

function walkDirs(dir: string): string[] {
  const out = [dir];
  let entries: ReturnType<typeof readdirSync>;
  try { entries = readdirSync(dir, { withFileTypes: true }) as never; } catch { return out; }
  for (const e of entries as unknown as { name: string; isDirectory(): boolean }[]) {
    if (e.isDirectory()) out.push(...walkDirs(join(dir, e.name)));
  }
  return out;
}

/**
 * Every path under `dir`, with the content and mtime of each file.
 *
 * Directories are listed too, with a trailing slash. Without them a rollback
 * that removed the files but left an empty directory tree behind would
 * compare equal, and that empty tree is a side effect of a refused call.
 */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const abs = join(cur, e.name);
      const rel = relative(dir, abs);
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs);
      } else if (e.isSymbolicLink()) {
        out.push(`${rel} -> symlink`);
      } else {
        const st = lstatSync(abs);
        out.push(`${rel} = ${readFileSync(abs, "utf-8")} @${st.mtime.getTime()}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function write(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe("#750 AC-1: a throw after the first copy leaves the project root as it was", () => {
  test("the copied file is not left behind when a later file refuses", () =>
    withScratch(root => {
      const project = join(root, "project");
      const wt = join(root, "wt");
      mkdirSync(project, { recursive: true });
      write(join(wt, "good.ts"), "copied content\n");
      // A source symlink: throw site `refusing to collect a symlink`.
      write(join(root, "outside.ts"), "not yours\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      const before = snapshot(project);
      expect(before, "the fixture's project root is not empty to begin with").toEqual([]);

      expect(() =>
        collectWorktreeFiles([{ worktreePath: wt, files: ["good.ts", "bad.ts"] }], project, [wt]),
      ).toThrow(/symlink/);

      expect(
        snapshot(project),
        "good.ts survived a refused collect — the project root is half-written",
      ).toEqual(before);
    }));

  test("AC-1b: the positive control — that same first file DOES copy when nothing throws", () =>
    withScratch(root => {
      // Without this, AC-1 is satisfied by a collect that never copies
      // anything at all, which is the fixture reaching its assertion without
      // the feature (#500).
      const project = join(root, "project");
      const wt = join(root, "wt");
      mkdirSync(project, { recursive: true });
      write(join(wt, "good.ts"), "copied content\n");

      const r = collectWorktreeFiles([{ worktreePath: wt, files: ["good.ts"] }], project, [wt]);
      expect(r.copied).toEqual(["good.ts"]);
      expect(readFileSync(join(project, "good.ts"), "utf-8")).toBe("copied content\n");
    }));

  test("a throw in the SECOND group does not keep the first group's files", () =>
    withScratch(root => {
      // The outer loop, which the per-file cases never reach. The second
      // group's worktree is unauthorised — throw site `refusing a worktree
      // the caller did not authorise`, which fires before any of its files
      // are looked at.
      const project = join(root, "project");
      const wtA = join(root, "wtA");
      const wtB = join(root, "wtB");
      mkdirSync(project, { recursive: true });
      write(join(wtA, "a.ts"), "from A\n");
      write(join(wtB, "b.ts"), "from B\n");

      const before = snapshot(project);
      expect(() =>
        collectWorktreeFiles(
          [
            { worktreePath: wtA, files: ["a.ts"] },
            { worktreePath: wtB, files: ["b.ts"] },
          ],
          project,
          [wtA], // wtB deliberately not authorised
        ),
      ).toThrow(/did not authorise/);

      expect(snapshot(project), "group A's files survived group B's refusal").toEqual(before);
    }));
});

describe("#750 AC-2: a destination that already existed comes back, it is not deleted", () => {
  test("the previous bytes are restored, not removed", () =>
    withScratch(root => {
      // The half a "remove everything we wrote" rollback gets wrong, and it
      // turns a refused collect into data loss rather than a no-op.
      const project = join(root, "project");
      const wt = join(root, "wt");
      write(join(project, "shared.ts"), "ORIGINAL\n");
      write(join(wt, "shared.ts"), "REPLACEMENT\n");
      write(join(root, "outside.ts"), "not yours\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      const before = snapshot(project);

      expect(() =>
        collectWorktreeFiles([{ worktreePath: wt, files: ["shared.ts", "bad.ts"] }], project, [wt]),
      ).toThrow(/symlink/);

      expect(
        readFileSync(join(project, "shared.ts"), "utf-8"),
        "the pre-existing file was left overwritten, or deleted outright",
      ).toBe("ORIGINAL\n");
      expect(snapshot(project)).toEqual(before);
    }));

  test("AC-2b: and its mtime comes back too, so nothing keyed on time sees a change", () =>
    withScratch(root => {
      // Bytes alone are not "as it was" for a build cache, a watcher or
      // `make`. The snapshot above compares mtimes, so this case states the
      // property the snapshot is quietly enforcing and pins a value a
      // bytes-only restore cannot produce.
      const project = join(root, "project");
      const wt = join(root, "wt");
      write(join(project, "shared.ts"), "ORIGINAL\n");
      const old = new Date("2020-01-02T03:04:05Z");
      utimesSync(join(project, "shared.ts"), old, old);
      write(join(wt, "shared.ts"), "REPLACEMENT\n");
      write(join(root, "outside.ts"), "x\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      expect(() =>
        collectWorktreeFiles([{ worktreePath: wt, files: ["shared.ts", "bad.ts"] }], project, [wt]),
      ).toThrow(/symlink/);

      expect(lstatSync(join(project, "shared.ts")).mtime.getTime()).toBe(old.getTime());
    }));

  test("the backup is never written inside the project root", () =>
    withScratch(root => {
      // A backup staged inside the tree being collected into is a file the
      // caller stages and commits the moment the cleanup that removes it
      // does not run.
      //
      // **This asserts the binding, not the post-call tree, and the battery
      // is why.** The first version of this case ran a collect and compared
      // the project root afterwards — which is identical whether the backup
      // was staged inside it or not, because the cleanup removes it on both
      // the success and the failure path. Pointing `mkdtempSync` at
      // `projectRoot` measured **0 red**: there is no input on which mutant
      // and original differ in any post-call observation, so the case was
      // asserting nothing (`.claude/rules/checks-must-be-able-to-fail.md`,
      // the third shape).
      const backupRoot = collectBackupRoot();
      try {
        expect(existsSync(backupRoot), "collectBackupRoot did not create a directory").toBe(true);
        expect(
          relative(tmpdir(), backupRoot).startsWith(".."),
          `backups are staged at ${backupRoot}, which is not under the OS temp directory — ` +
            `any project root is a tree somebody stages and commits`,
        ).toBe(false);
      } finally {
        rmSync(backupRoot, { recursive: true, force: true });
      }
    }));

  test("and that binding is the only place the backup location is decided", () =>
    withScratch(() => {
      // The half the case above cannot see. `collectBackupRoot` can be
      // perfect while the call site inlines its own `mkdtempSync(projectRoot)`
      // beside it — measured as battery row M8a, **0 red**, because nothing
      // observed which of the two the copy used.
      //
      // So: one `mkdtempSync` in the module, and `backupOf` reaches the
      // location through the exported binding. A second one makes this red
      // rather than making the guard above decorative.
      const src = readFileSync(join(import.meta.dir, "..", "lib", "worktree-collect.ts"), "utf-8");
      const calls = [...src.matchAll(/mkdtempSync\(/g)].length;
      expect(
        calls,
        `mkdtempSync appears ${calls} times in lib/worktree-collect.ts; a second one is a ` +
          `second decider for where backups go, and no behavioural case can tell them apart`,
      ).toBe(1);
      expect(src, "backupOf no longer routes through collectBackupRoot").toContain(
        "backupDir ??= collectBackupRoot();",
      );
    }));

  test("and the succeeding path leaves nothing behind but the copied file", () =>
    withScratch(root => {
      // The complement: whatever directory the backup went to, it is gone by
      // the time the call returns, and the overwrite itself landed.
      const project = join(root, "project");
      const wt = join(root, "wt");
      write(join(project, "shared.ts"), "ORIGINAL\n");
      write(join(wt, "shared.ts"), "REPLACEMENT\n");

      collectWorktreeFiles([{ worktreePath: wt, files: ["shared.ts"] }], project, [wt]);

      const mtime = lstatSync(join(project, "shared.ts")).mtime.getTime();
      expect(snapshot(project)).toEqual([`shared.ts = REPLACEMENT\n @${mtime}`]);
    }));
});

describe("#750 AC-3: directories created for the copy do not survive the refusal", () => {
  test("a directory that only exists because of this call is removed", () =>
    withScratch(root => {
      const project = join(root, "project");
      const wt = join(root, "wt");
      mkdirSync(project, { recursive: true });
      write(join(wt, "newdir", "deep", "a.ts"), "from A\n");
      write(join(root, "outside.ts"), "x\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      expect(() =>
        collectWorktreeFiles(
          [{ worktreePath: wt, files: ["newdir/deep/a.ts", "bad.ts"] }],
          project,
          [wt],
        ),
      ).toThrow(/symlink/);

      expect(
        existsSync(join(project, "newdir")),
        "an empty directory tree survived a refused collect",
      ).toBe(false);
      expect(snapshot(project)).toEqual([]);
    }));

  test("AC-3b: a directory that already existed is NOT removed", () =>
    withScratch(root => {
      // The converse, and the one a too-eager rollback breaks: the call wrote
      // into `lib/`, but `lib/` and its other contents are not this call's to
      // delete.
      const project = join(root, "project");
      const wt = join(root, "wt");
      write(join(project, "lib", "untouched.ts"), "keep me\n");
      write(join(wt, "lib", "a.ts"), "from A\n");
      write(join(root, "outside.ts"), "x\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      const before = snapshot(project);
      expect(() =>
        collectWorktreeFiles([{ worktreePath: wt, files: ["lib/a.ts", "bad.ts"] }], project, [wt]),
      ).toThrow(/symlink/);

      expect(existsSync(join(project, "lib", "untouched.ts")), "a pre-existing directory was removed").toBe(true);
      expect(snapshot(project)).toEqual(before);
    }));
});

describe("#750 AC-4: a throw no pre-validation pass could have predicted", () => {
  test("an EACCES from the copy itself still leaves the tree as it was", () =>
    withScratch(root => {
      // **The case that separates the fix from the cheapest wrong fix.**
      //
      // Moving the eleven checks to the top of the loop makes every fixture
      // above go green, because each of those throws is one the function
      // raises itself. This one is not: the destination directory is
      // read-only, so `copyFileSync` raises EACCES at WRITE time. No check in
      // this function reads write permission, and none could be reordered to
      // catch it — which is the general point, since the same is true of any
      // `lstat` answer that changes between a validating pass and a copying
      // pass.
      const project = join(root, "project");
      const wt = join(root, "wt");
      write(join(project, "ok.ts"), "pre-existing\n");
      write(join(project, "locked", "keep.ts"), "keep\n");
      write(join(wt, "a.ts"), "copied first\n");
      write(join(wt, "locked", "b.ts"), "never lands\n");
      chmodSync(join(project, "locked"), 0o555);

      const before = snapshot(project);

      let threw: unknown = null;
      try {
        collectWorktreeFiles(
          [{ worktreePath: wt, files: ["a.ts", "locked/b.ts"] }],
          project,
          [wt],
        );
      } catch (e) { threw = e; }

      expect(threw, "a read-only destination directory did not stop the copy").not.toBeNull();
      expect(
        String(threw),
        "the throw was one of the function's own refusals, so this is not the unpredictable case",
      ).not.toMatch(/refusing/);

      chmodSync(join(project, "locked"), 0o755);
      expect(
        snapshot(project),
        "a.ts survived a copy that failed for a reason no check looks for",
      ).toEqual(before);
    }));
});

describe("#750 AC-5: a rollback that cannot complete is its own state", () => {
  test("the error carries the original cause AND every undo that failed", () => {
    // Asserted as a contract, not reached through a real collect — see the
    // file docblock. Swallowing the undo failures would make a half-restored
    // tree indistinguishable from a clean refusal, which is the whole class
    // of defect this issue sits in.
    const cause = new Error("refusing to collect a symlink: bad.ts");
    const err = new CollectRollbackError(cause, ["created-file /p/a.ts: EPERM"]);

    expect(err).toBeInstanceOf(Error);
    expect(err.cause).toBe(cause);
    expect(err.rollbackFailures).toEqual(["created-file /p/a.ts: EPERM"]);
    expect(err.message, "the original reason was lost").toContain("refusing to collect a symlink");
    expect(err.message, "the failed undo was not named").toContain("EPERM");
    expect(
      err.message,
      "the message does not tell the caller the tree is unsafe to commit",
    ).toContain("do not stage or commit it");
  });

  test("a collect that rolls back cleanly throws the ORIGINAL error, not the wrapper", () =>
    withScratch(root => {
      // The discrimination that makes the case above mean something: a
      // successful rollback must not dress a clean refusal up as an unknown
      // tree, or every refusal reads as the worst case.
      const project = join(root, "project");
      const wt = join(root, "wt");
      mkdirSync(project, { recursive: true });
      write(join(wt, "good.ts"), "x\n");
      write(join(root, "outside.ts"), "y\n");
      symlinkSync(join(root, "outside.ts"), join(wt, "bad.ts"));

      let threw: unknown = null;
      try {
        collectWorktreeFiles([{ worktreePath: wt, files: ["good.ts", "bad.ts"] }], project, [wt]);
      } catch (e) { threw = e; }

      expect(threw).toBeInstanceOf(Error);
      expect(threw).not.toBeInstanceOf(CollectRollbackError);
      expect((threw as Error).message).toMatch(/refusing to collect a symlink/);
    }));
});

describe("#750 AC-6: the succeeding path is unchanged", () => {
  test("multiple groups copy, and missing files are still reported rather than thrown", () =>
    withScratch(root => {
      // The regression guard. A rollback that fired on the happy path, or a
      // journal that changed what `copied`/`missing` report, would break the
      // caller in a way none of the refusal cases can see.
      const project = join(root, "project");
      const wtA = join(root, "wtA");
      const wtB = join(root, "wtB");
      mkdirSync(project, { recursive: true });
      write(join(wtA, "lib", "a.ts"), "from A\n");
      write(join(wtB, "b.ts"), "from B\n");

      const r = collectWorktreeFiles(
        [
          { worktreePath: wtA, files: ["lib/a.ts", "gone.ts"] },
          { worktreePath: wtB, files: ["b.ts"] },
        ],
        project,
        [wtA, wtB],
      );

      expect(r.copied.sort()).toEqual(["b.ts", "lib/a.ts"]);
      expect(r.missing.map(m => m.endsWith("gone.ts"))).toEqual([true]);
      expect(readFileSync(join(project, "lib", "a.ts"), "utf-8")).toBe("from A\n");
      expect(readFileSync(join(project, "b.ts"), "utf-8")).toBe("from B\n");
    }));
});
