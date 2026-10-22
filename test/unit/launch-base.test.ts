/**
 * #644 SC-1 and SC-2 (restated) — the session's cwd is checked against
 * projectRoot before any agent is spawned.
 *
 * ## The fixture this file exists for
 *
 * #644 names it: **a session whose cwd is a git repository on a branch
 * unrelated to the issue, while `projectRoot` is correct.** Every natural
 * fixture runs from the right directory, so that branch is outside an
 * ordinary battery's reach entirely — the precondition-blindness shape in
 * `.claude/rules/checks-must-be-able-to-fail.md`. A file that only covers
 * "cwd is not a repo" catches failure 1 and leaves failure 2, the silent
 * one, completely untested.
 *
 * So the cases below build, under `mkdtemp`:
 *
 *   - two linked worktrees of ONE repository, on different branches — the
 *     shared-primary state, where the repository matches and the tree does
 *     not;
 *   - two separate repositories with different origins — the #218 state;
 *   - a directory that is no repository at all — failure 1;
 *   - a tree with no origin remote — the reading that must not pass.
 *
 * ## What it does NOT assert, and why that is the point
 *
 * It does not assert that `ship.js` derives the base from `projectRoot`.
 * `ship.js:1235` has done that since 2026-09-23 and the failures happened
 * anyway, so a case asserting it is green over both of them. See the note
 * on #644: that criterion as filed is satisfied before any fix.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { launchBaseReading, launchBaseRefusal, type LaunchBaseReading } from "../../lib/launch-base";

/**
 * The refusal a reading carries, or a throw.
 *
 * A throw rather than a `?? ""`: an empty string contains nothing, and a
 * `toContain` against one is an assertion that cannot fail.
 */
function refusalOf(r: LaunchBaseReading): string {
  if (r.reading === "SAME_CHECKOUT") throw new Error("expected a refusal, got SAME_CHECKOUT");
  return r.refusal;
}

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * A temp directory that is its own canonical path on every platform.
 *
 * `realpathSync` is not decoration (#1129). On Linux, where CI runs,
 * `tmpdir()` is `/tmp` and is not a symlink. On macOS it is
 * `/var/folders/...`, and `/var` is itself a symlink to `/private/var` — so
 * every fixture built here was non-canonical on one platform and canonical
 * on the other, which is invisible until something in the module under test
 * starts caring about the difference. `launchBaseReading` now does: it
 * refines SAME_CHECKOUT into NON_CANONICAL_ROOT when a root has two
 * spellings, and without this call five cases below read NON_CANONICAL_ROOT
 * on a developer's Mac and SAME_CHECKOUT in CI.
 *
 * Resolving the fixture is the fix rather than relaxing the assertions: the
 * cases here are about cwd-versus-projectRoot, and a platform's own symlink
 * is a confound in that measurement, not a subject of it. The case that IS
 * about symlinks builds its own, in `test/unit/root-canonicality.test.ts`.
 */
function scratch(tag: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `launch-base-${tag}-`)));
  made.push(d);
  return d;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository with one commit and an `origin` pointing at `slug`. */
function repo(tag: string, slug: string): string {
  const root = scratch(tag);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  git(root, "remote", "add", "origin", `https://github.com/${slug}.git`);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

/** A second working tree of `root`, checked out on a new branch. */
function linkedWorktree(root: string, branch: string): string {
  const holder = scratch("wt");
  const path = join(holder, "tree");
  git(root, "worktree", "add", "-q", "-b", branch, path);
  return path;
}

describe("#644 SC-1: the launch is refused when cwd is not the tree the run was handed", () => {
  test("cwd IS projectRoot — the only reading that clears", () => {
    const root = repo("same", "hornjason/pai-harness");
    const r = launchBaseReading(root, root);
    expect(r.reading).toBe("SAME_CHECKOUT");
    expect(launchBaseRefusal(root, root)).toBeNull();
  });

  test("a subdirectory of projectRoot clears — the toplevel is what is compared", () => {
    // Otherwise every run launched from `<root>/scripts` would be refused,
    // which is a refusal everyone learns to click past.
    const root = repo("subdir", "hornjason/pai-harness");
    const sub = join(root, "scripts", "deep");
    mkdirSync(sub, { recursive: true });
    expect(launchBaseRefusal(sub, root)).toBeNull();
  });

  test("failure 1: cwd is not a git repository at all", () => {
    const root = repo("f1", "hornjason/pai-harness");
    const notARepo = scratch("plain");
    const r = launchBaseReading(notARepo, root);
    expect(r.reading).toBe("CWD_NOT_A_REPO");
    // SC-2: the refusal names the input at fault and contradicts the
    // runtime's own message, which sends a reader to configure hooks.
    expect(refusalOf(r)).toContain(notARepo);
    expect(refusalOf(r)).toContain(root);
    expect(refusalOf(r), "the runtime blames VCS configuration; this must not")
      .toContain("WorktreeCreate hooks will not fix it");
  });

  /**
   * Failure 2, loud half. The #218 state: cwd is a perfectly good
   * repository belonging to another project.
   */
  test("failure 2a: cwd is a repository in a DIFFERENT project", () => {
    const root = repo("f2a-root", "hornjason/pai-harness");
    const other = repo("f2a-other", "hornjason/DailyBriefDashboard");
    const r = launchBaseReading(other, root);
    expect(r.reading).toBe("DIFFERENT_REPO");
    expect(refusalOf(r)).toContain("hornjason/dailybriefdashboard");
    expect(refusalOf(r)).toContain("hornjason/pai-harness");
  });

  /**
   * Failure 2, quiet half — and the fixture #644 says nobody builds by
   * accident.
   *
   * cwd is the SAME repository as projectRoot. A check comparing only
   * repositories passes here, and the run goes on to cut its worktrees
   * from a tree parked on another issue's branch. That is the shared
   * primary's steady state (#640), not a hypothetical.
   */
  test("failure 2b: same repository, a DIFFERENT working tree on another branch", () => {
    const root = repo("f2b", "hornjason/pai-harness");
    const parked = linkedWorktree(root, "rungate/run-631");

    // The premise, measured rather than assumed: a slug comparison alone
    // cannot see this. Both trees resolve to the same repository.
    expect(git(parked, "remote", "get-url", "origin")).toBe(git(root, "remote", "get-url", "origin"));

    const r = launchBaseReading(parked, root);
    expect(r.reading, "a repo-only check would call this clean").toBe("DIFFERENT_CHECKOUT");
    expect(refusalOf(r)).toContain("rungate/run-631");
    expect(refusalOf(r)).toContain("main");
    expect(refusalOf(r)).toContain("two different working trees of the same repository");
  });

  test("a tree with no origin remote is UNMEASURED, not clean", () => {
    const root = repo("nor-root", "hornjason/pai-harness");
    const bare = scratch("nor-cwd");
    git(bare, "init", "-q", "-b", "main");
    git(bare, "config", "user.email", "t@example.com");
    git(bare, "config", "user.name", "t");
    writeFileSync(join(bare, "a.txt"), "x\n");
    git(bare, "add", "-A");
    git(bare, "commit", "-q", "-m", "one");

    const r = launchBaseReading(bare, root);
    expect(r.reading).toBe("UNMEASURED");
    expect(refusalOf(r)).toContain("unknown is not clean");
  });

  test("an absent or unresolvable projectRoot is UNMEASURED, and says it is not the cwd problem", () => {
    const cwd = repo("pr", "hornjason/pai-harness");
    expect(launchBaseReading(cwd, "").reading).toBe("UNMEASURED");
    const r = launchBaseReading(cwd, scratch("not-a-repo-root"));
    expect(r.reading).toBe("UNMEASURED");
    expect(refusalOf(r), "blaming cwd for the run's own bad argument sends the operator to the wrong place")
      .toContain("not the launching session's working directory");
  });

  test("the refusal and the reading are one decision, not two", () => {
    // `launchBaseRefusal` must be a projection of `launchBaseReading`. Two
    // probes would be two deciders that agree, and a mutation of either
    // would leave the other refusing
    // (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape).
    const root = repo("proj", "hornjason/pai-harness");
    const other = repo("proj-other", "hornjason/other-thing");
    const noRemote = scratch("proj-noremote");
    git(noRemote, "init", "-q", "-b", "main");
    git(noRemote, "config", "user.email", "t@example.com");
    git(noRemote, "config", "user.name", "t");
    writeFileSync(join(noRemote, "a.txt"), "x\n");
    git(noRemote, "add", "-A");
    git(noRemote, "commit", "-q", "-m", "one");

    // An UNMEASURED input is in this list deliberately. Without one, a
    // projection that waved UNMEASURED through as clean is invisible here
    // AND in every case above, because the UNMEASURED cases assert on
    // `.reading` and never ask for the refusal. Measured: that mutation
    // was 0 of 14 before this input was added.
    const inputs = [root, other, scratch("proj-plain"), noRemote];
    let sawUnmeasured = false;
    for (const cwd of inputs) {
      const reading = launchBaseReading(cwd, root);
      if (reading.reading === "UNMEASURED") sawUnmeasured = true;
      const refusal = launchBaseRefusal(cwd, root);
      expect(refusal).toBe(reading.reading === "SAME_CHECKOUT" ? null : refusalOf(reading));
    }
    expect(sawUnmeasured, "the UNMEASURED arm must actually be reached, or this proves nothing").toBe(true);
  });

  test("UNMEASURED refuses — a reading that could not be taken is not a pass", () => {
    const root = repo("unm", "hornjason/pai-harness");
    // Both routes to UNMEASURED, asked through the BOOLEAN rather than the
    // reading, which is the position the other UNMEASURED cases do not use.
    const noRemote = scratch("unm-noremote");
    git(noRemote, "init", "-q", "-b", "main");
    git(noRemote, "config", "user.email", "t@example.com");
    git(noRemote, "config", "user.name", "t");
    writeFileSync(join(noRemote, "a.txt"), "x\n");
    git(noRemote, "add", "-A");
    git(noRemote, "commit", "-q", "-m", "one");

    expect(launchBaseReading(noRemote, root).reading).toBe("UNMEASURED");
    expect(launchBaseRefusal(noRemote, root), "no origin to compare is not a clear launch").not.toBeNull();
    expect(launchBaseRefusal(root, scratch("unm-badroot")), "an unresolvable projectRoot is not a clear launch")
      .not.toBeNull();
  });

  test("every non-SAME_CHECKOUT reading carries a refusal, so none can clear by omission", () => {
    const root = repo("tot", "hornjason/pai-harness");
    // Each input is paired with the reading it must produce. A COUNT of
    // distinct readings is the proxy, and the property is the membership:
    // a defect that swaps one reading for another leaves the count at four
    // and is invisible (#532). Measured: collapsing CWD_NOT_A_REPO into
    // UNMEASURED kept `seen.size` at 4 under the count form.
    const cases: Array<[string, LaunchBaseReading["reading"]]> = [
      [root, "SAME_CHECKOUT"],
      [repo("tot-other", "hornjason/x-y"), "DIFFERENT_REPO"],
      [scratch("tot-plain"), "CWD_NOT_A_REPO"],
      [linkedWorktree(root, "feat/other"), "DIFFERENT_CHECKOUT"],
    ];
    for (const [cwd, expected] of cases) {
      const r = launchBaseReading(cwd, root);
      expect(r.reading, `${cwd} should read ${expected}`).toBe(expected);
      if (r.reading !== "SAME_CHECKOUT") {
        expect(typeof refusalOf(r)).toBe("string");
        expect(refusalOf(r).length).toBeGreaterThan(40);
      }
    }
  });
});

describe("#644: what the reading reports is redacted, and what it probes is not", () => {
  /**
   * The sibling control `worktreeDiskIdentity` redacts everything it
   * interpolates; this one did not until the commit security review of
   * `819f584b` pointed at the parity gap. A sanitiser nobody asserts is
   * one the next edit removes, so it is asserted here.
   */
  test("a key-shaped token in a path is redacted out of the refusal AND the reading", () => {
    const root = repo("redact-root", "hornjason/pai-harness");
    const holder = scratch("redact");
    // A path a worktree could genuinely sit under: somebody's scratch
    // directory named after the token they were debugging with.
    // Constructed, not spelled (#1036); the bytes are unchanged.
    const keyShaped = "ghp_" + "0123456789abcdefghij";
    const leaky = join(holder, keyShaped);
    mkdirSync(leaky, { recursive: true });

    const r = launchBaseReading(leaky, root);
    expect(r.reading, "the probe must have run against the REAL path").toBe("CWD_NOT_A_REPO");
    expect(refusalOf(r)).not.toContain(keyShaped);
    expect(refusalOf(r)).toContain("<redacted>");
    // The whole object is serialised by the script, so the fields carry it
    // too — a caller that had to remember to redact is one that forgets.
    expect(JSON.stringify(r)).not.toContain(keyShaped);
  });

  test("an ordinary path is left exactly as it was — the redactor stays narrow", () => {
    // A redactor that mangled every path would make every refusal
    // unreadable, which is worse than the leak for the ordinary case.
    const root = repo("redact-plain", "hornjason/pai-harness");
    const plain = scratch("redact-plain-cwd");
    const r = launchBaseReading(plain, root);
    expect(r.cwd).toBe(plain);
    expect(r.projectRoot).toBe(root);
    expect(refusalOf(r)).toContain(plain);
  });

  test("the probe uses the raw path, not the redacted one", () => {
    // The trap this guards: redacting before probing sends `git -C` to a
    // directory that does not exist, which resolves to CWD_NOT_A_REPO —
    // byte-identical to the finding the module exists to report. A real
    // repository under a key-shaped directory name must read SAME_CHECKOUT.
    const holder = scratch("raw-probe");
    const under = join(holder, "ghp_" + "abcdefghij0123456789");
    mkdirSync(under, { recursive: true });
    git(under, "init", "-q", "-b", "main");
    git(under, "config", "user.email", "t@example.com");
    git(under, "config", "user.name", "t");
    git(under, "remote", "add", "origin", "https://github.com/hornjason/pai-harness.git");
    writeFileSync(join(under, "a.txt"), "x\n");
    git(under, "add", "-A");
    git(under, "commit", "-q", "-m", "one");

    const r = launchBaseReading(under, under);
    expect(r.reading, "redacting before probing would make this CWD_NOT_A_REPO").toBe("SAME_CHECKOUT");
    expect(launchBaseRefusal(under, under)).toBeNull();
  });
});

describe("#644 SC-2: the launcher's gate exits non-zero, and says which reading", () => {
  const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-launch-base.ts");
  const run = (args: string[]) =>
    spawnSync("bun", [SCRIPT, ...args], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });

  test("a matching cwd exits zero and prints the reading", () => {
    const root = repo("cli-ok", "hornjason/pai-harness");
    const r = run(["--project-root", root, "--cwd", root]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).reading).toBe("SAME_CHECKOUT");
    expect(r.stderr).toBe("");
  });

  test("a parked sibling worktree exits non-zero, named by reading", () => {
    const root = repo("cli-parked", "hornjason/pai-harness");
    const parked = linkedWorktree(root, "rungate/run-999");
    const r = run(["--project-root", root, "--cwd", parked]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("LAUNCH_BASE_DIFFERENT_CHECKOUT");
    // The reading still goes to stdout on a refusal: a launcher that wants
    // the detail must not have to parse the human sentence for it.
    expect(JSON.parse(r.stdout).reading).toBe("DIFFERENT_CHECKOUT");
  });

  test("cwd defaults to the session's own directory — the value under test", () => {
    // Run with NO --cwd, from a directory that is not the project root.
    // This is the only case that proves the default is the measurement
    // rather than a parameter every caller has to remember to pass.
    const root = repo("cli-default", "hornjason/pai-harness");
    const elsewhere = scratch("cli-default-cwd");
    const r = spawnSync("bun", [SCRIPT, "--project-root", root], {
      encoding: "utf-8",
      cwd: elsewhere,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("LAUNCH_BASE_CWD_NOT_A_REPO");
    expect(JSON.parse(r.stdout).cwd).toContain("cli-default-cwd");
  });

  test("a bad argument is REFUSED, and a refusal is not a reading", () => {
    const root = repo("cli-bad", "hornjason/pai-harness");
    const r = run(["--project-root", root, "--nonsense", "x"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSED");
    expect(r.stdout.trim(), "a refused run must not print a verdict").toBe("");
  });

  test("--project-root is required", () => {
    const r = run([]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--project-root is required");
  });
});
