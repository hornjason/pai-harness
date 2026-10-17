/**
 * Covers SC-1908..SC-1911 (HARNESS-STANDARD.md), #503.
 *
 * Two sessions allocated `SC-1706..1710` within minutes of each other on
 * 2026-10-16, in two worktrees of this repository. Each read the highest id
 * in its own `specs/` and took the next block. Each was right. The guard that
 * exists to catch a duplicate id, `test/spec-sc-ids-unique.test.ts`, was green
 * in both trees independently and stayed green until a rebase put the two
 * blocks in one place.
 *
 * ## The fixtures are real git repositories, not directories
 *
 * The thing under test is `git worktree list`, so a fixture that fakes its
 * output would be testing the parser and nothing else. Each case below runs
 * `git init` and `git worktree add`, which costs about a second for the file
 * and buys the only thing worth having here: the sibling is a sibling for the
 * same reason the one that bit us was.
 *
 * ## Why the ids are computed rather than written
 *
 * `test/sc-fixture-namespace.test.ts` (SC-1522) requires every SC id spelled
 * literally in source to be a real registry id or to sit at or above the
 * 9000 fixture floor. Both are wrong here: a real id would make this file
 * claim coverage it does not provide, and a 9000-range id is exactly what
 * `readScNamespace` is specified to DROP, so a fixture built from one could
 * not witness the feature at all. The ids below are assembled at runtime, so
 * they are absent from the source text that both guards read, and present in
 * the temp repositories where the behaviour lives.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { allocateScNumber, nextSCNumber } from "../lib/create-sc";
import { readScNamespace, siblingWorktrees } from "../lib/sc-id-cross-tree";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** An id as a string, never as a literal — see the header. */
const id = (n: number): string => `SC-${n}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
}

function writeSpec(root: string, name: string, ids: string[]): void {
  mkdirSync(join(root, "specs"), { recursive: true });
  const body = ["# Fixture spec", "", "## Success Criteria", "", ...ids.map(i => `- [ ] ${i}: a criterion`), ""];
  writeFileSync(join(root, "specs", name), body.join("\n"));
}

/** A git repository with one commit, so branches and worktrees are possible. */
function repo(specIds: string[]): string {
  // realpath, because on macOS `/var` is a symlink to `/private/var` and git
  // reports the resolved path. A fixture comparing the two spellings fails
  // for a reason that has nothing to do with the feature.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sc-xtree-")));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "fixture"]);
  writeSpec(root, "MAIN-SPEC.md", specIds);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

describe("#503: the SC namespace is the machine, not the checkout", () => {
  test("SC-1908: an id only a sibling worktree has typed is already taken", () => {
    const mine = id(4101);
    const theirs = id(4102);
    const root = repo([mine]);
    const sibling = join(root, "..", `sib-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "theirs", sibling]);
    roots.push(sibling);
    // UNCOMMITTED in the sibling, which is the state the collision happened
    // in: a session that has written the SC line and not yet committed.
    writeSpec(sibling, "THEIR-SPEC.md", [theirs]);

    const reading = readScNamespace(root);

    // The instrument first: this id exists in NO tree but the sibling, so a
    // reading that found it through the root's own specs or through a commit
    // would be satisfying the assertion by a route that bypasses the feature.
    expect(
      readFileSync(join(root, "specs", "MAIN-SPEC.md"), "utf-8"),
      "the fixture leaked the sibling's id into the root tree",
    ).not.toContain(theirs);
    expect(committedAnywhere(root, theirs), "the fixture committed the id, so the ref scan would find it").toBe(false);

    expect([...reading.ids.keys()], "a sibling worktree's uncommitted id is invisible").toContain(theirs);
    expect(reading.ids.get(theirs)).toContain(sibling);
  });

  test("SC-1909: an id committed on a branch with no worktree is already taken", () => {
    const theirs = id(4203);
    const root = repo([id(4201)]);
    const sibling = join(root, "..", `gone-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "abandoned", sibling]);
    writeSpec(sibling, "ABANDONED-SPEC.md", [theirs]);
    git(sibling, ["add", "-A"]);
    git(sibling, ["commit", "-q", "-m", "their block"]);
    // The worktree goes away; the branch does not. This is the half the
    // worktree walk cannot see and the ref scan exists for.
    // `worktree remove`, not a delete plus `prune`: prune honours
    // `gc.worktreePruneExpire`, which defaults to three months, so the
    // deleted tree is still listed and the fixture would not be testing the
    // branch-with-no-worktree case at all.
    git(root, ["worktree", "remove", "--force", sibling]);
    expect(siblingWorktrees(root).paths, "the fixture did not actually remove the worktree").toHaveLength(0);

    const reading = readScNamespace(root);
    expect([...reading.ids.keys()], "an id on an unmerged branch is invisible").toContain(theirs);
    expect(reading.ids.get(theirs)).toContain("refs");
  });

  test("SC-1910: a source it could not read is named, never dropped", () => {
    const root = repo([id(4301)]);
    const sibling = join(root, "..", `broken-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "broken", sibling]);
    roots.push(sibling);
    // A worktree git still lists whose tree is not there. `git worktree list`
    // reports it without `prunable` until a prune runs, so the reading meets
    // a path it cannot open — the case where returning silently would make an
    // unread tree indistinguishable from a tree with no ids in it.
    rmSync(join(sibling, "specs"), { recursive: true, force: true });

    const reading = readScNamespace(root);
    const skipped = reading.sources.filter(s => s.status === "skipped");
    expect(skipped.map(s => s.label), "an unreadable worktree was dropped silently").toContain(sibling);
    expect(skipped.every(s => (s.reason ?? "") !== ""), "a skipped source carries no reason").toBe(true);
    expect(reading.unmeasured.join("\n")).toContain(sibling);

    // And on a clean read it is still not empty: no process on this machine
    // can see a clone on another one, and `0`, `{}` and `SKIP` are
    // indistinguishable from success (`.claude/rules/config-access.md`).
    const clean = readScNamespace(repo([id(4302)]));
    expect(clean.sources.filter(s => s.status === "skipped")).toHaveLength(0);
    expect(clean.unmeasured.length, "a fully-read namespace claims to be complete").toBeGreaterThan(0);

    // "asked and there are none" and "could not ask" are opposite facts, and
    // an empty array says both. A directory that is not a repository at all
    // is the second one, and it must not read as the first.
    const notARepo = mkdtempSync(join(tmpdir(), "sc-xtree-bare-"));
    roots.push(notARepo);
    const asked = siblingWorktrees(notARepo);
    expect(asked.paths).toHaveLength(0);
    expect(asked.failure, "a repository that could not be asked reported no siblings").not.toBeNull();
  });

  test("SC-1912: the allocator composes all three widths, not two of them", () => {
    // SC-1911 drives `nextSCNumber` with ids the test assembled itself, so it
    // cannot witness a CALLER that reads the namespace and forgets to pass
    // it, or passes the registry alone. `allocateScNumber` is the one place
    // the three widths compose, and this drives that.
    const mine = 4501;
    const theirs = 4502;
    const root = repo([id(mine)]);
    const sibling = join(root, "..", `compose-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "compose", sibling]);
    roots.push(sibling);
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs)]);

    const own = `- [ ] ${id(mine)}: a criterion\n`;
    const first = allocateScNumber(root, own);
    expect(first.number, "the allocator re-issued a number a sibling already took").toBeGreaterThan(theirs);
    // The reading travels with the number, because the number is a floor.
    expect(first.namespace.unmeasured.length).toBeGreaterThan(0);

    // A second value, or "reads the namespace" is indistinguishable from
    // "adds a constant to what the spec content says".
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs + 60)]);
    expect(allocateScNumber(root, own).number).toBeGreaterThan(theirs + 60);
  });

  test("SC-1911: the allocator does not re-issue a sibling's number", () => {
    const mine = 4401;
    const theirs = 4402;
    const root = repo([id(mine)]);
    const sibling = join(root, "..", `alloc-${Date.now() % 100000}`);
    git(root, ["worktree", "add", "-q", "-b", "alloc", sibling]);
    roots.push(sibling);
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs)]);

    const own = `- [ ] ${id(mine)}: a criterion\n`;
    // What the pre-fix allocator does, and it is correct about its own tree.
    expect(nextSCNumber(own), "the fixture does not reproduce the collision").toBe(theirs);

    const namespace = readScNamespace(root);
    const withNamespace = nextSCNumber(own, undefined, [...namespace.ids.keys()]);
    expect(withNamespace, "the allocator handed out a number the sibling already took").toBeGreaterThan(theirs);

    // Two different sibling values, because one cannot tell "reads the
    // namespace" from "adds a constant".
    writeSpec(sibling, "THEIR-SPEC.md", [id(theirs + 40)]);
    const again = readScNamespace(root);
    expect(nextSCNumber(own, undefined, [...again.ids.keys()])).toBeGreaterThan(theirs + 40);

    // The reserved range stays reserved: a fixture id is spelled, not claimed,
    // and counting one as taken would push every future criterion past 9000.
    writeSpec(sibling, "THEIR-SPEC.md", [id(9500)]);
    const reserved = readScNamespace(root);
    expect([...reserved.ids.keys()]).not.toContain(id(9500));
    expect(nextSCNumber(own, undefined, [...reserved.ids.keys()])).toBe(mine + 1);
  });
});

/** Is this id committed anywhere reachable? `git grep` exits 1 on no match. */
function committedAnywhere(root: string, scId: string): boolean {
  try {
    git(root, ["grep", "-q", scId, "HEAD"]);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}
