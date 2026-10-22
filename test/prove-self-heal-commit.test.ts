/**
 * #1082: prove.js self-heal committed with `add -A` and pushed with no
 * `main|master` refusal, where ship.js has one.
 *
 * The prompt is text, so the temptation is to assert on the string. This
 * evaluates the SELF-HEAL-COMMIT block out of `workflows/prove.js` and runs
 * what it produces against real repositories, the same shape as
 * `test/commit-staging-from-git.test.ts` — because a guard that is present in
 * the string and does not refuse reads exactly like one that works.
 *
 * The cheapest wrong fix, named: add the `main|master` case and leave the
 * staging alone. The refusal cases below go green under it. `stages nothing
 * until the branch has been read` and `a clean tree refuses loudly` do not,
 * and neither does the ordering case — the guard has to come BEFORE the
 * staging, and a guard appended after `add -A` passes a string match.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const proveSource = readFileSync(join(REPO_ROOT, "workflows", "prove.js"), "utf-8");

const START = "// ──── SELF-HEAL-COMMIT-START ────";
const END = "// ──── SELF-HEAL-COMMIT-END ────";

function selfHealBlock(): string {
  const s = proveSource.indexOf(START);
  const e = proveSource.indexOf(END);
  if (s === -1 || e === -1) throw new Error("prove.js is missing the SELF-HEAL-COMMIT markers");
  return proveSource.slice(s + START.length, e);
}

type ScriptFn = (dir: string, subject: string) => string;

function load(block = selfHealBlock()): ScriptFn {
  return new Function(`${block}; return selfHealCommitScript`)() as ScriptFn;
}

const selfHealCommitScript = load();
const SUBJECT = "fix(#1082): prove self-heal iteration 1";

let repo: string;
let origin: string;
let sandbox: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();

/** Run the generated snippet the way prove.js hands it to an agent: via sh. */
function run(script: string, cwd = sandbox): { code: number; out: string } {
  try {
    const out = execFileSync("sh", ["-c", script], { encoding: "utf-8", stdio: "pipe", cwd });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const staged = () => git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
const head = () => git("rev-parse", "HEAD");

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "prove-selfheal-cwd-"));
  origin = mkdtempSync(join(tmpdir(), "prove-selfheal-origin-"));
  repo = mkdtempSync(join(tmpdir(), "prove-selfheal-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", origin);
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  git("push", "-q", "-u", "origin", "main");
});

afterEach(() => {
  for (const d of [repo, origin, sandbox]) if (d) rmSync(d, { recursive: true, force: true });
});

/** The witness input from the issue: a checkout on `main` with one unrelated edit. */
function oneUnrelatedEdit() {
  writeFileSync(join(repo, "someone-elses-work.ts"), "export const uncommitted = 1;\n");
}

describe("#1082: the self-heal commit refuses the default branch", () => {
  test.each([["main"], ["master"]])(
    "a checkout on %s is refused, and nothing is staged or committed",
    (branch) => {
      if (branch !== "main") git("checkout", "-q", "-b", branch);
      oneUnrelatedEdit();
      const before = head();

      const { code, out } = run(selfHealCommitScript(repo, SUBJECT));

      expect(code, `self-heal committed onto ${branch}`).not.toBe(0);
      expect(out).toContain("REFUSING");
      expect(out).toContain(branch);
      expect(staged(), "the unrelated edit was swept into the index").toEqual([]);
      expect(head()).toBe(before);
    },
  );

  test("a detached HEAD refuses — an unread branch is not a permitted branch", () => {
    // `branch --show-current` prints nothing here. Falling through to `*)`
    // is the Silent Default Substitution shape: "" is indistinguishable from
    // a branch that was read and allowed.
    git("checkout", "-q", "--detach");
    oneUnrelatedEdit();
    const before = head();

    const { code, out } = run(selfHealCommitScript(repo, SUBJECT));

    expect(code, "a detached HEAD fell through to the permitted arm").not.toBe(0);
    expect(out).toContain("REFUSING");
    expect(staged()).toEqual([]);
    expect(head()).toBe(before);
  });

  test("the refusal comes BEFORE any staging, not after it", () => {
    // The cheapest wrong fix appends the guard and leaves `add -A` where it
    // was. A string match for `main|master` cannot tell the two apart.
    const script = selfHealCommitScript(repo, SUBJECT);
    const guard = script.indexOf('case "$branch" in');
    const add = script.indexOf("add -A");
    expect(guard, "the generated script has no branch guard").toBeGreaterThan(-1);
    expect(add, "the generated script does not stage").toBeGreaterThan(-1);
    expect(guard, "the guard runs after the index has already been written").toBeLessThan(add);
  });
});

describe("#1082: staging is derived from git, and is reachable only past the guard", () => {
  test("on a feature branch the fix is committed and pushed", () => {
    git("checkout", "-q", "-b", "rungate/run-1082");
    git("push", "-q", "-u", "origin", "rungate/run-1082");
    writeFileSync(join(repo, "fix.ts"), "export const fixed = true;\n");
    const before = head();

    const { code, out } = run(selfHealCommitScript(repo, SUBJECT));

    expect(code, out).toBe(0);
    expect(head()).not.toBe(before);
    expect(git("log", "-1", "--pretty=%s")).toBe(SUBJECT);
    const remote = execFileSync("git", ["-C", origin, "rev-parse", "rungate/run-1082"], {
      encoding: "utf-8",
    }).trim();
    expect(remote, "the commit was not pushed").toBe(head());
  });

  test("a clean tree refuses loudly and distinctly, rather than committing nothing", () => {
    git("checkout", "-q", "-b", "rungate/run-1082");
    const { code, out } = run(selfHealCommitScript(repo, SUBJECT));
    expect(code).not.toBe(0);
    expect(out).toContain("RUNGATE_NO_CHANGES");
    expect(out, "the message no longer names the directory").toContain(repo);
  });

  test.each([
    ["semicolon", "d; touch pwned"],
    ["command substitution", "d$(touch pwned)"],
    ["backticks", "d`touch pwned`"],
  ])("a project root using %s is quoted, not executed", (_name, nasty) => {
    const dir = join(sandbox, nasty);
    run(selfHealCommitScript(dir, SUBJECT));
    for (const where of [sandbox, repo, origin, process.cwd()]) {
      expect(
        existsSync(join(where, "pwned")),
        `the project root executed as a command, writing into ${where}`,
      ).toBe(false);
    }
  });

  test("a project root containing a space is passed as one argument", () => {
    // The #1086 shape, for the one path this change touches: unquoted,
    // `git -C /tmp/My Project status` is read as `-C /tmp/My` plus a stray.
    const spaced = mkdtempSync(join(tmpdir(), "prove-selfheal-My Project-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "wip", spaced], { stdio: "pipe" });
      execFileSync("git", ["-C", spaced, "config", "user.email", "t@example.com"]);
      execFileSync("git", ["-C", spaced, "config", "user.name", "t"]);
      writeFileSync(join(spaced, "f.ts"), "x\n");

      const { out } = run(selfHealCommitScript(spaced, SUBJECT));

      // Assert the commit LANDED, not merely that no refusal printed: a
      // command that died on the split path prints neither string either.
      expect(out, "the path was split on its space").not.toContain("REFUSING");
      const subject = execFileSync("git", ["-C", spaced, "log", "-1", "--pretty=%s"], {
        encoding: "utf-8",
      }).trim();
      expect(subject, out).toBe(SUBJECT);
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });
});

/**
 * Scoped to `workflows/prove.js`, deliberately — read this before widening it.
 *
 * `workflows/ship.js` has two commit instructions with no `main|master`
 * refusal either — the Verify and Ship regression re-commits, built from
 * `reimplGitAdd` and `reimplShipGitAdd` (`ship.js:7604` and `:9757` as of
 * 2026-10-21; grep the two names, the lines will move). Each is a
 * `${gitAdd} && git -C <dir> commit && git -C <dir> push` chain. Point this
 * census at ship.js and both go red.
 *
 * They are not the defect #1082 fixed, and adding the guard there would be
 * cargo-culting it. Both push to an EXPLICIT `HEAD:${shipBranch}` rather than
 * to whatever branch the checkout is on, and `establishRunRef` has already
 * put that ref off the default branch before either can run — so the input
 * this file's refusal cases are built on cannot reach them. The other half of
 * #1082, the staging, they already have: both go through `gitDerivedStaging`.
 *
 * The remaining gap is consistency, not exposure. Widen this census to ship.js
 * only together with a reason that survives the paragraph above.
 */
describe("#1082: the prompt carries no second, unguarded commit path", () => {
  test("every `add -A` and every `git … push` in prove.js is inside the block", () => {
    // No exemption list by design: a second commit instruction added outside
    // the block reddens this rather than inheriting the guard by proximity.
    const block = selfHealBlock();
    const count = (hay: string, re: RegExp) => (hay.match(re) ?? []).length;
    const ADD = /add -A/g;
    const PUSH = /git -C [^\n]*\bpush\b/g;

    expect(count(proveSource, ADD), "an `add -A` outside the guarded block").toBe(
      count(block, ADD),
    );
    expect(count(proveSource, PUSH), "a `git … push` outside the guarded block").toBe(
      count(block, PUSH),
    );
  });

  test("the chained `add -A && commit && push` one-liner is gone", () => {
    expect(/add -A[^\n]*&&[^\n]*commit/.test(proveSource)).toBe(false);
  });
});

describe("#1082: the guard is what refuses — mutation", () => {
  /** The block with one line removed, so a case can observe its absence. */
  function withoutLine(match: string): ScriptFn {
    const block = selfHealBlock();
    const kept = block
      .split("\n")
      .filter((l) => !l.includes(match))
      .join("\n");
    expect(kept.length, `the mutation removed nothing — "${match}" is not in the block`).toBeLessThan(
      block.length,
    );
    return load(kept);
  }

  test("removing the branch case lets the commit land on main", () => {
    const mutant = withoutLine('case "$branch" in');
    oneUnrelatedEdit();
    const before = head();

    const { code } = run(mutant(repo, SUBJECT));

    expect(code, "the mutant refused anyway — something else is doing the refusing").toBe(0);
    expect(head(), "the mutant did not commit, so the real refusal was not witnessed").not.toBe(
      before,
    );
  });

  test("removing the porcelain check loses the distinct empty-tree reading", () => {
    // `git commit` on a clean tree exits non-zero either way, so the code is
    // not the witness here — the message is.
    const mutant = withoutLine("RUNGATE_NO_CHANGES");
    git("checkout", "-q", "-b", "rungate/run-1082");

    const { out } = run(mutant(repo, SUBJECT));

    expect(out).not.toContain("RUNGATE_NO_CHANGES");
  });
});
