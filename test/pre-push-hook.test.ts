/**
 * #397 — the generated pre-push hook could not pass, and said the wrong thing
 * about why.
 *
 * Covers SC-1504, SC-1505, SC-1506, SC-1507, SC-1508 (HARNESS-STANDARD.md).
 *
 * The hook compared `$TOPLEVEL/bun.lock` with `$tmp/bun.lock`, where `$tmp` is
 * a checkout of the commit being pushed. A gitignored lockfile is not in a
 * checkout, so the comparison could not be taken, every push fell through to
 * `bun install --frozen-lockfile` with nothing to freeze, and the hook printed
 * "Conformity tests failed against the commits being pushed" over a suite that
 * was green. Found on agentgrit on 2026-10-14 at 43 pass, 0 fail.
 *
 * Everything here drives the real script against planted repositories. The
 * hook's output is the only thing asserted, because the hook's output is the
 * only thing a developer sees — `.claude/rules/checks-must-be-able-to-fail.md`
 * warns specifically against source-text assertions standing in for behaviour,
 * and this bug is one a source-text assertion would have shipped.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  PRE_PUSH_REFUSE_EXIT, PRE_PUSH_SUITE, prePushHookScript,
} from "../lib/scaffold/pre-push-hook";
import { createGitHooks } from "../lib/scaffold/steps";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const PASSING_SUITE = `import { expect, test } from "bun:test";
test("conformity", () => { expect(1).toBe(1); });
`;
const FAILING_SUITE = `import { expect, test } from "bun:test";
test("conformity", () => { expect(1).toBe(2); });
`;
const EMPTY_SUITE = `export const nothing = true;\n`;
const UNRESOLVABLE_SUITE = `import { thing } from "./a-module-that-is-not-here";
import { test } from "bun:test";
test("conformity", () => { thing(); });
`;
/**
 * A suite that can only load if `node_modules` reached the temp checkout.
 *
 * `PASSING_SUITE` imports nothing but `bun:test`, so it is green over a
 * dangling symlink and over no symlink at all — it cannot witness #728.
 */
const DEP_SUITE = `import { expect, test } from "bun:test";
import { answer } from "dep-under-test";
test("conformity", () => { expect(answer).toBe(42); });
`;
const DEP_MODULE: Record<string, string> = {
  "dep-under-test/package.json": JSON.stringify({
    name: "dep-under-test", version: "1.0.0", type: "module", main: "index.js",
  }),
  "dep-under-test/index.js": "export const answer = 42;\n",
};

interface Plant {
  /** Contents of `test/scaffold-conformity.test.ts`, or null to omit the file. */
  suite: string | null;
  /** Written AND committed. */
  tracked?: Record<string, string>;
  /** Written and left untracked — the `.gitignore`d lockfile case. */
  untracked?: Record<string, string>;
  /**
   * Files under `node_modules/`, written into the MAIN checkout after the
   * commit. A repository being pushed from has installed dependencies, and
   * since #728 the hook refuses by name when it cannot find them — so the
   * default is an empty `node_modules/`, which is what every pre-#728 fixture
   * was implicitly relying on the hook not looking at.
   */
  modules?: Record<string, string>;
  /** Omit `node_modules/` entirely — the "nothing is installed" case (#728). */
  noModules?: boolean;
}

/** A real repository with one commit, returned with its HEAD sha. */
function plant(name: string, p: Plant): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), `prepush-${name}-`));
  roots.push(root);
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");

  const write = (rel: string, body: string) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  write("package.json", JSON.stringify({ name: `prepush-${name}`, private: true }));
  if (p.suite !== null) write(PRE_PUSH_SUITE, p.suite);
  for (const [rel, body] of Object.entries(p.tracked ?? {})) write(rel, body);

  git("add", "-A");
  git("commit", "-qm", "planted");
  // After the commit, so they are genuinely absent from the checkout the hook
  // makes — writing them earlier would track them and prove nothing.
  for (const [rel, body] of Object.entries(p.untracked ?? {})) write(rel, body);
  if (!p.noModules) {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    for (const [rel, body] of Object.entries(p.modules ?? {})) write(join("node_modules", rel), body);
  }

  return { root, sha: git("rev-parse", "HEAD").trim() };
}

/**
 * A LINKED worktree of a planted repo — the shape #728 is about.
 *
 * It has no `node_modules` of its own and never will: `node_modules` is
 * gitignored, so it exists only in the main checkout. `--show-toplevel` from
 * in here answers the worktree's own root, which is the wrong root.
 */
function addWorktree(repo: { root: string; sha: string }, name: string): string {
  const wt = mkdtempSync(join(tmpdir(), `prepush-wt-${name}-`));
  roots.push(wt);
  rmSync(wt, { recursive: true, force: true }); // git worktree add wants a path that is not there
  const r = spawnSync("git", ["worktree", "add", "--detach", "--quiet", wt, repo.sha],
    { cwd: repo.root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git worktree add: ${r.stderr}`);
  return wt;
}

interface Run { code: number; out: string }

/**
 * Run a hook script in a planted repo as git would: push line on stdin.
 *
 * `cwd` defaults to the main checkout. Git runs a hook from the top level of
 * the working tree the push came from, so a linked worktree is modelled by
 * passing that worktree's path.
 */
function runHook(repo: { root: string; sha: string }, script: string, cwd = repo.root): Run {
  const path = join(cwd, `hook-${Math.abs(hash(script))}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  const r = spawnSync("sh", [path], {
    cwd,
    encoding: "utf-8",
    input: `refs/heads/main ${repo.sha} refs/heads/main 0000000000000000000000000000000000000000\n`,
    timeout: 120_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Replace a single anchor, refusing to produce a mutant that changed nothing.
 *
 * A mutation harness that silently no-ops when its target moves is the
 * decorative check this whole rule file is about, so the count is asserted
 * rather than hoped for.
 */
function mutate(anchor: string, replacement: string): string {
  const src = prePushHookScript();
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`could not build the mutant: ${JSON.stringify(anchor)} appears ${n} times`);
  return src.replace(anchor, replacement);
}

/**
 * What a refusal exits with, written as a literal on purpose.
 *
 * Every behavioural assertion below said `toBe(PRE_PUSH_REFUSE_EXIT)`, which
 * made the whole suite a tautology: setting the constant to `0` zeroed the
 * script's refusal AND the expected value at the same time, and the mutation
 * scored 0 of 29. A test parameterised by the thing it is checking cannot
 * check it. The constant is still asserted — once, below — but the behaviour
 * is pinned to a number.
 */
const REFUSES = 1;
const REFUSE_DECL = "REFUSE=1";
const LOCKFILE_ARM = `if [ ! -f "$tmp/bun.lock" ]; then`;
const COUNTED_ERRORS = `if echo "$out" | grep -qE '^[[:space:]]*[1-9][0-9]* error'; then`;
const COUNTED_TESTS = `elif echo "$out" | grep -qE '^[[:space:]]*[1-9][0-9]* (pass|fail)'; then`;
const MODULES_ROOT_DECL = `MODULES_ROOT=$(cd "$TOPLEVEL" && cd "$(git rev-parse --git-common-dir)/.." && pwd) || exit $REFUSE`;
const MODULES_ABSENT_GUARD = `  if [ ! -d "$MODULES_ROOT/node_modules" ]; then`;

describe("SC-1504: a gitignored lockfile does not block a passing push", () => {
  // agentgrit's shape, reproduced rather than approximated: the lockfile is
  // in the working tree and absent from the commit, and the package depends
  // on a sibling by relative path, so an install from a temp directory
  // cannot resolve it. Both halves are needed — the first is what makes the
  // old hook install at all, the second is what makes that install fail.
  const repo = () => plant("ignored-lock", {
    suite: PASSING_SUITE,
    tracked: {
      ".gitignore": "bun.lock\nnode_modules\n",
      "package.json": JSON.stringify({
        name: "prepush-ignored-lock", private: true,
        dependencies: { sib: "file:../a-sibling-that-is-not-beside-tmp" },
      }),
    },
    untracked: { "bun.lock": "# a real lockfile, untracked\n" },
  });

  test("the push is allowed", () => {
    const r = runHook(repo(), prePushHookScript());
    expect(r.out).not.toContain("Conformity tests failed");
    expect(r.out).not.toContain("did NOT run");
    expect(r.code).toBe(0);
  });

  test("it did not fall through to an install", () => {
    // The fall-through is the mechanism, and asserting only the exit code
    // would stay green if some later change made the install succeed by
    // accident — a pass for a reason unrelated to the fix.
    expect(runHook(repo(), prePushHookScript()).out)
      .not.toContain("dependencies differ from the working tree");
  });

  test("MUTATION: with the absent-lockfile arm unreachable, the push is refused", () => {
    // The fix, removed and observed. Before #397 this arm did not exist and
    // this is exactly what the hook did.
    const r = runHook(repo(), mutate(LOCKFILE_ARM, "if false; then"));
    expect(r.out).toContain("dependencies differ from the working tree");
    expect(r.code).toBe(REFUSES);
  });
});

describe("SC-1505: a real conformity failure is still refused, and says so", () => {
  const repo = () => plant("red", { suite: FAILING_SUITE });

  test("refused as a conformity failure", () => {
    const r = runHook(repo(), prePushHookScript());
    expect(r.out).toContain("Conformity tests failed against the commits being pushed");
    expect(r.out).not.toContain("did NOT run");
    expect(r.code).toBe(REFUSES);
  });

  test("MUTATION: zeroing the refusal constant lets the failure through", () => {
    // The positive control for every refusal in this file. Without it, a
    // suite of refusals is indistinguishable from a hook that refuses
    // everything — which is what the hook under repair actually was.
    const r = runHook(repo(), mutate(REFUSE_DECL, "REFUSE=0"));
    expect(r.out).toContain("Conformity tests failed");
    expect(r.code).toBe(0);
  });

  test("the refusal constant appears exactly once", () => {
    // Otherwise a later `exit 1` inlined somewhere would bypass the mutation
    // and every control above would pass for the wrong reason.
    expect(PRE_PUSH_REFUSE_EXIT, "a refusal that exits 0 is not a refusal").toBe(REFUSES);
    const occurrences = prePushHookScript().split(REFUSE_DECL).length - 1;
    expect(occurrences).toBe(1);
    // Including the two early `|| exit 1`s this found: a hook that cannot
    // read its own toplevel or make a temp directory is refusing a push, and
    // a refusal outside the constant is a refusal no mutation can remove.
    expect(prePushHookScript()).not.toMatch(/\bexit 1\b/);
  });
});

describe("SC-1506: a suite that never ran is UNMEASURED, not a failure", () => {
  test.each([
    ["the file is not in the pushed commit", plant, { suite: null }],
    ["the file's imports do not resolve", plant, { suite: UNRESOLVABLE_SUITE }],
    ["the file contains no tests", plant, { suite: EMPTY_SUITE }],
  ] as const)("%s", (label, make, p) => {
    const r = make(label.replace(/\W+/g, "-"), p as Plant);
    const run = runHook(r, prePushHookScript());
    expect(run.out).toContain("did NOT run the conformity suite");
    expect(run.out).toContain("your conformity tests may be green");
    // The distinction is the entire issue: a developer told "conformity
    // failed" goes and reads a green suite.
    expect(run.out).not.toContain("Conformity tests failed against the commits");
  });

  test("an install that cannot happen is UNMEASURED too, not a conformity failure", () => {
    // A lockfile that is tracked, differs from the working tree's, and cannot
    // be frozen. This is the shape a `file:`/`link:` sibling dependency takes
    // when the install runs from a temp directory — the second, independent
    // way #397 failed.
    const repo = plant("badlock", {
      suite: PASSING_SUITE,
      tracked: { "bun.lock": "this is not a lockfile\n" },
      untracked: { "bun.lock.working": "x\n" },
    });
    writeFileSync(join(repo.root, "bun.lock"), "a different not-a-lockfile\n");
    const r = runHook(repo, prePushHookScript());
    expect(r.out).toContain("dependencies differ from the working tree");
    expect(r.out).toContain("did NOT run the conformity suite");
    // The CAUSE, not just the bucket. Asserting only "did NOT run" left
    // emptying this reason scoring 0 red — the developer would be told the
    // suite was not measured and not told that the install is why.
    expect(r.out).toContain("dependencies could not be installed in the temporary checkout");
    expect(r.out).not.toContain("Conformity tests failed against the commits");
    expect(r.code).toBe(REFUSES);
  });

  test("MUTATION: with the counted-tests discriminator always true, a missing suite becomes a conformity failure", () => {
    // Which is the pre-#397 behaviour, stated as a mutation so the
    // distinction cannot quietly collapse back.
    const repo = plant("nosuite-mutant", { suite: null });
    const r = runHook(repo, mutate(COUNTED_TESTS, `elif true; then`));
    expect(r.out).toContain("Conformity tests failed against the commits being pushed");
    expect(r.out).not.toContain("did NOT run");
    expect(r.code).toBe(REFUSES);
  });

  test("MUTATION: with the error-count arm removed, an unresolvable import becomes a conformity failure", () => {
    // This arm is separate from the one above and neither covers the other:
    // bun reports a module that will not resolve as `1 fail` AND `1 error`,
    // so the counted-tests test alone is satisfied and calls it red. Found
    // by this test going green on the wrong branch.
    const repo = plant("import-mutant", { suite: UNRESOLVABLE_SUITE });
    const r = runHook(repo, mutate(COUNTED_ERRORS, `if false; then`));
    expect(r.out).toContain("Conformity tests failed against the commits being pushed");
    expect(r.out).not.toContain("did NOT run");
    expect(r.code).toBe(REFUSES);
  });
});

describe("SC-1507: UNMEASURED blocks, and the decision is recorded", () => {
  test("the push is refused and the escape hatch is named in the message", () => {
    // Recorded here rather than only in a docblock, because the alternative —
    // waving the push through when the suite could not run — is the fail-open
    // `.claude/rules/config-access.md` names: SKIP is indistinguishable from
    // success. The cost of blocking is that someone must be told how to
    // proceed, so the message must carry it.
    const r = runHook(plant("unmeasured-blocks", { suite: null }), prePushHookScript());
    expect(r.code).toBe(REFUSES);
    expect(r.out).toContain("--no-verify");
    expect(r.out).toContain(PRE_PUSH_SUITE);
  });

  test("MUTATION: zeroing the refusal constant lets an unmeasured push through", () => {
    const r = runHook(plant("unmeasured-control", { suite: null }), mutate(REFUSE_DECL, "REFUSE=0"));
    expect(r.out).toContain("did NOT run the conformity suite");
    expect(r.code).toBe(0);
  });
});

describe("SC-1509: the generator writes this script, and not a copy of it", () => {
  // Every test above drives `prePushHookScript()`. None of them would notice
  // if `createGitHooks` kept its own template literal — the decider would be
  // right and the caller would not be asking it, which is the zero this repo
  // keeps measuring (#431, #235, #224).
  test("createGitHooks writes exactly prePushHookScript()", () => {
    const root = mkdtempSync(join(tmpdir(), "prepush-generated-"));
    roots.push(root);
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    createGitHooks(root, []);
    expect(readFileSync(join(root, ".git", "hooks", "pre-push"), "utf-8"))
      .toBe(prePushHookScript());
  });

  test("the script is the only place the hook body is written", () => {
    // A second literal would survive any mutation of the first.
    //
    // The probe was `writeFileSync(prePush, prePushHookScript());` and went
    // red in #891, when `createGitHooks` became a loop over `GENERATED_HOOKS`
    // and the write became `hook.script(root)`. The property did not move —
    // the body still comes from `prePushHookScript` and from nowhere else —
    // so what is asserted is the property: the generator calls it, names it
    // exactly once, and holds no copy of the text.
    const steps = readFileSync(join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"), "utf-8");
    const code = steps.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const named = code.match(/\bprePushHookScript\b/g) || [];
    expect(
      named.length,
      "prePushHookScript is named more than once in the generator, which is a second " +
        "position deciding what the pre-push hook is",
    ).toBe(2); // the import, and the GENERATED_HOOKS entry
    expect(code).toContain("script: () => prePushHookScript()");
    expect(steps).not.toContain("bun install --frozen-lockfile");
    expect(steps).not.toContain("Conformity tests failed");
  });
});

/**
 * #728 — the hook asked `--show-toplevel` where the dependencies are.
 *
 * In a linked worktree that is the worktree's own root, which has no
 * `node_modules` and never will: it is gitignored and lives only in the main
 * checkout. `ln -s` does not look at its target, so the link succeeded, the
 * suite died on an import error, and the hook refused every worktree push
 * with "the conformity suite did not load". Three agent sessions in agentgrit
 * reached for `--no-verify` instead.
 *
 * The same wrong root makes the lockfile arm vacuous: `cmp` read the
 * WORKTREE's `bun.lock` against the pushed commit's copy of itself, which
 * agree whenever you push what you committed. The guard exists to check that
 * the modules being linked were installed from the pushed lockfile, so it has
 * to read the lockfile beside those modules.
 *
 * These ids need allocating against the spec registry; the criteria are
 * described by the test names.
 */
describe("#728: the hook links the MAIN checkout's dependencies, not the pushing worktree's", () => {
  /** A main checkout with the dependency installed, pushed from a linked worktree. */
  const depRepo = () => plant("wt-dep", { suite: DEP_SUITE, modules: DEP_MODULE });

  test("a push from a linked worktree resolves its dependencies and is allowed", () => {
    const repo = depRepo();
    const wt = addWorktree(repo, "dep");
    const r = runHook(repo, prePushHookScript(), wt);
    expect(r.out).not.toContain("did NOT run the conformity suite");
    expect(r.out).not.toContain("Conformity tests failed");
    expect(r.code).toBe(0);
  });

  test("the same push from the main checkout is allowed too — the non-worktree case is unchanged", () => {
    // --git-common-dir resolves to plain `.git` in a primary checkout, so this
    // is the control that the fix did not buy the worktree case by breaking
    // the one that already worked.
    const r = runHook(depRepo(), prePushHookScript());
    expect(r.out).not.toContain("did NOT run the conformity suite");
    expect(r.code).toBe(0);
  });

  test("the lockfile compared is the one beside the node_modules being linked", () => {
    // The worktree's lockfile IS the pushed commit's lockfile, so a `cmp`
    // rooted at --show-toplevel compares the pushed tree against itself and
    // passes. The main checkout's lockfile is what those modules were
    // installed from, and here it differs — so the hook must install rather
    // than reuse them.
    const repo = plant("wt-lock", {
      suite: PASSING_SUITE,
      tracked: { "bun.lock": "committed lockfile\n" },
    });
    const wt = addWorktree(repo, "lock");
    writeFileSync(join(repo.root, "bun.lock"), "the lockfile the modules came from\n");

    const r = runHook(repo, prePushHookScript(), wt);
    expect(r.out, "a cmp rooted at the worktree compares the pushed tree with itself")
      .toContain("dependencies differ from the working tree");
  });

  test("node_modules absent from the main checkout is refused BY NAME, not left dangling", () => {
    const repo = plant("wt-nomodules", { suite: DEP_SUITE, noModules: true });
    const wt = addWorktree(repo, "nomodules");
    const r = runHook(repo, prePushHookScript(), wt);
    expect(r.out).toContain("no node_modules at ");
    expect(r.out).toContain(join(repo.root, "node_modules"));
    expect(r.out).toContain("did NOT run the conformity suite");
    // The whole point of naming it: an import error tells the developer
    // nothing about which directory is missing or where to run bun install.
    expect(r.out).not.toContain("the conformity suite did not load");
    expect(r.out).not.toContain("Conformity tests failed");
    expect(r.code).toBe(REFUSES);
  });

  test("MUTATION: the modules root restored to --show-toplevel refuses the worktree push", () => {
    // The pre-#728 source, and the cheapest wrong fix at the same time: the
    // absent-target guard above stays in place, so this is "check the link
    // target exists and skip the symlink" with the wrong root underneath it.
    // The symptom changes wording; the worktree push is still refused.
    const repo = depRepo();
    const wt = addWorktree(repo, "dep-mutant");
    const r = runHook(repo, mutate(MODULES_ROOT_DECL, "MODULES_ROOT=$TOPLEVEL"), wt);
    expect(r.out).toContain("did NOT run the conformity suite");
    expect(r.code).toBe(REFUSES);
  });

  test("MUTATION: with the wrong root, the lockfile arm compares the pushed tree with itself", () => {
    const repo = plant("wt-lock-mutant", {
      suite: PASSING_SUITE,
      tracked: { "bun.lock": "committed lockfile\n" },
    });
    const wt = addWorktree(repo, "lock-mutant");
    writeFileSync(join(repo.root, "bun.lock"), "the lockfile the modules came from\n");
    const r = runHook(repo, mutate(MODULES_ROOT_DECL, "MODULES_ROOT=$TOPLEVEL"), wt);
    expect(r.out).not.toContain("dependencies differ from the working tree");
  });

  test("MUTATION: with the absent-target guard removed, the link dangles and says nothing", () => {
    const repo = plant("wt-nomodules-mutant", { suite: DEP_SUITE, noModules: true });
    const wt = addWorktree(repo, "nomodules-mutant");
    const r = runHook(repo, mutate(MODULES_ABSENT_GUARD, "  if false; then"), wt);
    expect(r.out).not.toContain("no node_modules at ");
    expect(r.out).toContain("the conformity suite did not load");
    expect(r.code).toBe(REFUSES);
  });

  test("the hook asks --git-common-dir, and asks it once", () => {
    // A second root computation would survive any mutation of the first, and
    // both would read correctly in the diff
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    const src = prePushHookScript();
    expect(src.split("git rev-parse --git-common-dir").length - 1).toBe(1);
    expect(src).not.toContain(`"$TOPLEVEL/node_modules"`);
    expect(src).not.toContain(`"$TOPLEVEL/bun.lock"`);
  });
});

describe("SC-1508: the hook still does what #85 and #68 made it do", () => {
  test("a branch deletion has nothing to check and is allowed", () => {
    const repo = plant("delete", { suite: FAILING_SUITE });
    const path = join(repo.root, "hook-del.sh");
    writeFileSync(path, prePushHookScript(), { mode: 0o755 });
    const r = spawnSync("sh", [path], {
      cwd: repo.root, encoding: "utf-8", timeout: 60_000,
      input: `(delete) 0000000000000000000000000000000000000000 refs/heads/gone ${repo.sha}\n`,
    });
    // The failing suite is in the repo; if the hook ran it anyway, the zero
    // sha guard is not doing its job.
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain("Conformity tests failed");
  });

  test("it checks the pushed commit, not the working tree (#85)", () => {
    // The commit is green and the working tree is red. A hook that tested the
    // working tree would refuse; this one must not.
    const repo = plant("worktree-drift", { suite: PASSING_SUITE });
    writeFileSync(join(repo.root, PRE_PUSH_SUITE), FAILING_SUITE);
    const r = runHook(repo, prePushHookScript());
    expect(r.out).not.toContain("Conformity tests failed");
    expect(r.code).toBe(0);
  });

  test("it leaves no worktree behind, on either outcome (#68)", () => {
    for (const suite of [PASSING_SUITE, FAILING_SUITE]) {
      const repo = plant(`leak-${suite === PASSING_SUITE ? "green" : "red"}`, { suite });
      runHook(repo, prePushHookScript());
      const list = spawnSync("git", ["worktree", "list"], { cwd: repo.root, encoding: "utf-8" });
      expect(list.stdout.trim().split("\n")).toHaveLength(1);
    }
  });
});
