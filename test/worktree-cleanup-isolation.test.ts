/**
 * #1097 — the deleter must not ask a tamperable git whether work exists.
 *
 * `cleanupWorktrees` decides by asking `git status --porcelain` whether a
 * worktree is dirty, and a clean answer falls through to
 * `git worktree remove --force`. `core.excludesFile` makes an untracked
 * file invisible to that reading, so a checkout holding uncommitted work
 * reports clean and is deleted: the guard meant to spare the work is the
 * reading that was tampered with.
 *
 * #1090 isolated `scripts/worktree-census.ts`, which only REPORTS. This
 * file is about the module that DELETES.
 *
 * ## The rows, and why two of them are controls
 *
 *   1. poisoned + untracked work → KEPT. The witness. Red before the fix.
 *   2. unpoisoned + untracked work → KEPT. Without it, a "keep everything"
 *      repair satisfies row 1 while being the wrong fix.
 *   3. poisoned + genuinely clean → REMOVED. The control in the other
 *      direction: a guard that never deletes passes rows 1 and 2.
 *
 * Every row asserts the CONTROL READING first — what an unisolated git
 * says about the same tree — so a row cannot pass because this git stopped
 * honouring `core.excludesFile`, which would leave it witnessing nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { cleanupWorktrees } from "../lib/worktree-cleanup";

let TMP = "";
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

beforeAll(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), "rungate-1097-")));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe", env: ENV });

const PLANT = "uncommitted-work.txt";

/**
 * A repo with an origin, one linked worktree, and whatever poison the row
 * needs.
 *
 * The branch is pushed so `originState` answers `on-origin` and the branch
 * is an ancestor of `main`, which makes the worktree removable by every
 * check EXCEPT the dirty one. That is deliberate: the dirty check has to be
 * the only thing standing between the fixture and `worktree remove --force`,
 * or a row that passes tells us nothing about it.
 *
 * The poison goes in the repository's own `.git/config` — a linked worktree
 * shares it — which is the scope `GIT_CONFIG_GLOBAL=/dev/null` cannot reach
 * and the `-c` flags can.
 */
function fixture(tag: string, opts: { poison: boolean; untracked: boolean }) {
  const root = join(TMP, tag);
  const origin = join(TMP, `${tag}-origin.git`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: ENV });
  git(root, ["config", "user.email", "f@f.invalid"]);
  git(root, ["config", "user.name", "f"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "-u", "origin", "main"]);

  const wt = join(root, ".claude", "worktrees", "wt-a");
  mkdirSync(join(root, ".claude", "worktrees"), { recursive: true });
  git(root, ["worktree", "add", "-q", "-b", "feature", wt]);
  git(root, ["push", "-q", "origin", "feature"]);

  if (opts.untracked) writeFileSync(join(wt, PLANT), "work that exists in exactly one place\n");
  if (opts.poison) {
    const excludes = join(TMP, `${tag}-excludes`);
    writeFileSync(excludes, `${PLANT}\n`);
    git(root, ["config", "core.excludesFile", excludes]);
  }
  return { root, wt };
}

/** What an UNISOLATED `git status --porcelain` says — the pre-#1097 reading. */
const unisolatedStatus = (wt: string) =>
  execFileSync("git", ["status", "--porcelain"], {
    cwd: wt, encoding: "utf-8", stdio: "pipe", env: ENV,
  }).trim();

describe("the deleter reads an isolated git (#1097)", () => {
  /**
   * Row 1 — the witness. Red before the fix: the plant is invisible, every
   * remaining check passes, and `worktree remove --force` takes the tree.
   */
  test("a poisoned config cannot hide uncommitted work from the delete decision", async () => {
    const { root, wt } = fixture("row1", { poison: true, untracked: true });

    expect(
      unisolatedStatus(wt),
      "the control saw the plant, so core.excludesFile is not hiding anything here and this row witnesses nothing",
    ).toBe("");

    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.removed, "a worktree holding uncommitted work was deleted").toEqual([]);
    expect(result.kept.join("\n")).toContain("uncommitted changes");
    expect(existsSync(join(wt, PLANT)), "the uncommitted file is gone").toBe(true);
  });

  /**
   * Row 1b — the same decision, poisoned through the GLOBAL file.
   *
   * `gitIsolatedArgs` alone leaves `~/.gitconfig` live and `gitIsolatedEnv`
   * alone leaves the repository's own config live. Neither covers the
   * other, so the env half needs its own witness or it is held up only by
   * a source-text assertion.
   *
   * Two things make this a subprocess rather than an in-process poison.
   * `-c` is COMMAND scope and outranks global, so a global
   * `core.excludesFile` is already covered by the flags and would witness
   * nothing — the key has to be one the flags do not name, and
   * `status.showUntrackedFiles = no` hides the same plant by another
   * route. And in Bun, editing `process.env` after startup does NOT reach
   * a child given no explicit `env` (#1096), so a case that set it
   * in-process would be green either way. The environment is poisoned at
   * the child's START.
   */
  test("a global config cannot hide uncommitted work from the delete decision", () => {
    const { root, wt } = fixture("row1b", { poison: false, untracked: true });
    const cfg = join(TMP, "row1b-gitconfig");
    writeFileSync(cfg, "[status]\n\tshowUntrackedFiles = no\n");
    const env = { ...ENV, GIT_CONFIG_GLOBAL: cfg };

    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf-8", stdio: "pipe", env }).trim(),
      "the control saw the plant, so this key is not hiding anything and this row witnesses nothing",
    ).toBe("");

    const probe = join(TMP, "row1b-probe.ts");
    writeFileSync(probe, `
const { cleanupWorktrees } = await import(${JSON.stringify(join(import.meta.dir, "..", "lib", "worktree-cleanup.ts"))});
console.log("RESULT " + JSON.stringify(await cleanupWorktrees({ projectRoot: process.argv[2] })));
`);
    const p = Bun.spawnSync(["bun", probe, root], { env });
    const out = new TextDecoder().decode(p.stdout);
    expect(p.exitCode, `the probe did not run:\n${new TextDecoder().decode(p.stderr)}`).toBe(0);
    const result = JSON.parse(out.split("RESULT ")[1]);

    expect(result.removed, "a worktree holding uncommitted work was deleted").toEqual([]);
    expect(existsSync(join(wt, PLANT)), "the uncommitted file is gone").toBe(true);
  });

  /**
   * Row 2 — control against "keep everything". The same tree with no
   * poison must also be kept, and for the same stated reason.
   */
  test("an unpoisoned worktree holding uncommitted work is kept, for the dirty reason", async () => {
    const { root, wt } = fixture("row2", { poison: false, untracked: true });

    expect(
      unisolatedStatus(wt),
      "the fixture is not dirty, so this control establishes nothing",
    ).toContain(PLANT);

    const result = await cleanupWorktrees({ projectRoot: root });

    expect(result.removed).toEqual([]);
    expect(result.kept.join("\n")).toContain("uncommitted changes");
    expect(existsSync(wt)).toBe(true);
  });

  /**
   * Row 3 — control in the other direction. A guard that refuses to delete
   * anything passes rows 1 and 2; only this one can tell them apart.
   */
  test("a genuinely clean worktree is still removed, poison or no poison", async () => {
    const { root, wt } = fixture("row3", { poison: true, untracked: false });

    expect(unisolatedStatus(wt), "the fixture is dirty, so it cannot test removal").toBe("");

    const result = await cleanupWorktrees({ projectRoot: root });

    expect(
      result.removed,
      `a clean worktree was not removed; kept=${JSON.stringify(result.kept)} errors=${JSON.stringify(result.errors)}`,
    ).toEqual(["wt-a"]);
    expect(existsSync(wt)).toBe(false);
  });

  /**
   * One decider, so a NINTH call site cannot quietly skip it.
   *
   * The three rows above are about the two sites that gate and perform the
   * delete. They are silent about the other six, and silent about any site
   * added next month — which is the shape of this defect: `lib/paths.ts`
   * and `lib/scaffold/steps.ts` still ask an unisolated `status
   * --porcelain` each, and neither was written by someone who had decided
   * not to isolate. Nobody was deciding.
   *
   * So the population is counted, not the flags. The cheapest wrong fix for
   * #1097 is to paste the `-c` flags at the two sites the issue names: the
   * three rows above all go green, six sites stay unisolated, and a second
   * spelling of the isolation set lands in this file. This case is what
   * that repair fails.
   */
  test("exactly one spawnSync reaches git, and it is the isolated seam", () => {
    const src = readFileSync(join(import.meta.dir, "..", "lib", "worktree-cleanup.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // Every reach for git, not only the ones that look isolated — a site
    // passing a bare array has to be counted or it is the site that hides.
    const reaches = [...src.matchAll(/spawnSync\(\s*"git"\s*,/g)];
    expect(
      reaches.length,
      "every git invocation in this module must go through one seam; a second door is a site that can drift",
    ).toBe(1);

    const doors = [...src.matchAll(/spawnSync\(\s*"git"\s*,\s*([A-Za-z_$][\w$]*)\(/g)];
    expect(doors.length, "the one git invocation does not call anything to build its argv").toBe(1);
    expect(doors[0][1], "the one door does not apply lib/git-isolation.ts").toBe("gitIsolatedArgs");

    // The env half used to be asserted as the literal `env: gitIsolatedEnv()`,
    // which was exact while this module had ONE kind of git call. It now has
    // two: a `push`/`ls-remote` must NOT null the global and system config,
    // because `credential.helper` lives there and nulling it makes every push
    // fail to authenticate (#1038).
    //
    // So the property asserted is the stronger one that survives that: the
    // choice between the two environments is a single expression, both sides
    // come from lib/git-isolation.ts, and the sides are not swapped. An
    // inversion — handing the isolated env to the remote call — is the failure
    // this replaces the literal with, and a bare `.toContain` of either name
    // could not have caught it.
    expect(
      src.replace(/\s+/g, " "),
      "the env half must be ONE expression routing to lib/git-isolation.ts, with remote on the credential side",
    ).toContain('reach === "remote" ? gitCredentialEnv() : gitIsolatedEnv()');
    expect(
      [...src.matchAll(/env:\s*\{/g)].length,
      "no inline env object — lib/git-isolation.ts is the declaring position for both modes",
    ).toBe(0);
    // Only remote-reaching verbs may ask for the credential environment.
    // `[^;]` keeps the match inside ONE statement. A `[\s\S]*?` here spanned
    // from `cleanupGit(["remote"], …)` to the `"remote"` argument of a later
    // call and reported the verb `remote`, which does not exist.
    const remoteCalls = [...src.matchAll(/cleanupGit\(\s*\[\s*"([a-z-]+)"[^;]*?"remote"\s*\)/g)].map(m => m[1]);
    expect(
      remoteCalls.filter(v => !["push", "ls-remote", "fetch"].includes(v)),
      "a local verb asking for the credential env is a read that stopped being reproducible",
    ).toEqual([]);
    expect(remoteCalls.length, "the remote mode is reached, so the check is not vacuous").toBeGreaterThan(0);
    expect(
      src.includes("core.fsmonitor") || src.includes("core.excludesFile") || src.includes("GIT_CONFIG_GLOBAL"),
      "the isolation set must not be re-spelled here — lib/git-isolation.ts is the declaring position",
    ).toBe(false);
  });
});
