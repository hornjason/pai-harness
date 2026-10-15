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

interface Plant {
  /** Contents of `test/scaffold-conformity.test.ts`, or null to omit the file. */
  suite: string | null;
  /** Written AND committed. */
  tracked?: Record<string, string>;
  /** Written and left untracked — the `.gitignore`d lockfile case. */
  untracked?: Record<string, string>;
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

  return { root, sha: git("rev-parse", "HEAD").trim() };
}

interface Run { code: number; out: string }

/** Run a hook script in a planted repo as git would: push line on stdin. */
function runHook(repo: { root: string; sha: string }, script: string): Run {
  const path = join(repo.root, `hook-${Math.abs(hash(script))}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  const r = spawnSync("sh", [path], {
    cwd: repo.root,
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
    const steps = readFileSync(join(import.meta.dir, "..", "lib", "scaffold", "steps.ts"), "utf-8");
    expect(steps).toContain("writeFileSync(prePush, prePushHookScript());");
    expect(steps).not.toContain("bun install --frozen-lockfile");
    expect(steps).not.toContain("Conformity tests failed");
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
