/**
 * #1001 — one declaration of the git-config isolation set, two projections,
 * and a confinement for the directory `CommitEnforcement` runs git in.
 *
 * ## Why these two are one PR
 *
 * `CommitEnforcement` takes a worktree path out of `payload.tool_response` —
 * the subagent's own reply — and runs `git -C <that>` twice. Two separate
 * things are wrong with that and neither fixes the other:
 *
 * 1. a regex match is not a confinement, so the path can be anywhere;
 * 2. **git executes the config of whatever repository it is pointed at**, so
 *    even a confined path in a repo someone else controls runs their
 *    `core.fsmonitor`.
 *
 * #971/#999's argv conversion addresses neither. Fixing only (1) leaves a
 * hostile repo inside the base; fixing only (2) leaves the reading pointed
 * at the wrong tree.
 *
 * ## The real finding, recorded because it is about process not code
 *
 * The isolation set was **already measured**, under #960/#965, with
 * `core.fsmonitor` proven to execute (*marker written, git ran it*). It then
 * lived as a shell-prefix string inside one module, so the only other caller
 * in the repo that runs git in an untrusted directory could not reuse it
 * even in principle — its call sites are `execFileSync`. The lesson was
 * learned once and propagated nowhere. That is what the single declaration
 * and `AC-D2` are for.
 *
 * Issue: #1001. Refs #960, #965, #971, #999.
 */

import { afterAll, describe, test, expect } from "bun:test";
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { realpathSync } from "fs";
import {
  GIT_ISOLATION_CONFIG,
  GIT_ISOLATION_ENV,
  gitIsolatedArgs,
  gitIsolatedEnv,
  gitIsolatedShellPrefix,
} from "../lib/git-isolation";
import { agentWorktreesBase, confinedWorktreePath } from "../lib/agent-worktree";
import { AI_REVIEW_GIT_ISOLATED } from "../lib/scaffold/ai-review-step";

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gitiso-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe("#1001 — the isolation set is declared once and projected twice", () => {
  test("AC-D1: the shell projection is BYTE-IDENTICAL to the literal it replaced", () => {
    // The literal, as it stood on origin/main before this change. If the
    // derivation ever stops reproducing it, the generated workflow changes
    // and this says so rather than letting it drift.
    const LITERAL =
      "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 " +
      "git -c core.fsmonitor= -c core.excludesFile=/dev/null -c core.hooksPath=/dev/null " +
      "-c safe.directory='*'";
    expect(gitIsolatedShellPrefix()).toBe(LITERAL);
    expect(AI_REVIEW_GIT_ISOLATED, "ai-review-step no longer derives its prefix").toBe(LITERAL);
  });

  test("AC-D2: every production spelling of the set AGREES with the declaration", () => {
    // Deliberately NOT "nobody else may mention it". `ai-review-step.ts`
    // keeps a literal — it is import-free because 27 suites stage it into a
    // tmpdir, and adding an import turned three CI shards red with
    // `Cannot find module` in suites with nothing to do with git config.
    //
    // The alternative to an import is not an allowlist naming that file as
    // exempt: an allowlist is a third position, and naming a file in one
    // becomes the evidence that it was considered. So the rule is
    // AGREEMENT. A production file may spell the set, and if it does, every
    // fragment of the canonical prefix must be present in it. A file that
    // declares a DIFFERENT set — one key dropped, one value changed — is
    // red, which is the defect; a file that reproduces this one exactly is
    // not.
    //
    // Population is production TypeScript. Tests are excluded because a
    // test asserting about these strings is doing its job and AC-D1 is
    // itself one; a spelling in a test changes no behaviour.
    const canonical = gitIsolatedShellPrefix();
    const fragments = [
      ...Object.entries(GIT_ISOLATION_ENV).map(([k, v]) => `${k}=${v}`),
      ...GIT_ISOLATION_CONFIG.map(([k, v]) => `-c ${k}=${/[*?[\]]/.test(v) ? `'${v}'` : v}`),
    ];
    const disagreements: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = p.slice(ROOT.length + 1);
        if (rel === "lib/git-isolation.ts") continue;
        const src = readFileSync(p, "utf-8");
        // A file is "spelling the set" if it assigns any of its env vars.
        // The bare NAME is a citation — other modules quote this docblock in
        // prose — and a citation is not a declaration
        // (`.claude/rules/self-referential-tests.md`).
        if (!/GIT_CONFIG_NOSYSTEM\s*=/.test(src)) continue;
        const missing = fragments.filter(f => !src.includes(f));
        if (missing.length > 0) disagreements.push(`${rel} is missing: ${missing.join(", ")}`);
      }
    };
    for (const d of ["lib", "hooks", "gates", "scripts"]) walk(join(ROOT, d));
    expect(disagreements, `a production spelling disagrees with lib/git-isolation.ts:\n${disagreements.join("\n")}`).toEqual([]);
    // And the one known spelling is exactly the declaration, not merely a
    // superset of its fragments.
    expect(AI_REVIEW_GIT_ISOLATED).toBe(canonical);
  });

  test("AC-D3: the argv projection passes `*` LITERALLY, not shell-quoted", () => {
    // The projections differ in exactly one place and it matters. `'*'`
    // reaching git through execFileSync is three characters matching no
    // directory — isolation that silently does not apply. A single shared
    // string could not have got this right for both callers, which is why
    // the declaration is data.
    const args = gitIsolatedArgs();
    expect(args).toContain("safe.directory=*");
    expect(args.some(a => a.includes("'")), "a shell quote leaked into the argv projection").toBe(false);
    expect(gitIsolatedShellPrefix()).toContain("safe.directory='*'");
  });

  test("AC-D4: the argv flags precede the caller's own arguments", () => {
    const args = gitIsolatedArgs(["-C", "/x", "status", "--porcelain"]);
    expect(args.slice(-4)).toEqual(["-C", "/x", "status", "--porcelain"]);
    expect(args.indexOf("-c")).toBe(0);
  });

  test("AC-D5 WITNESS: an isolated `git` does NOT execute a poisoned core.fsmonitor", () => {
    // #960's measurement, re-run against the ARGV projection — the one that
    // did not exist when it was taken. Without this arm the projection is a
    // string-shaped claim; this is the behaviour.
    const home = tmp();
    const repo = tmp();
    const marker = join(home, "FSMONITOR-RAN");
    const hook = join(home, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(hook, 0o755);
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
    writeFileSync(join(repo, "planted.txt"), "x");
    // Poison the CHECKOUT's own config — the scope env vars cannot reach and
    // the `-c` flags exist for.
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook], { stdio: "ignore" });

    const run = (args: string[], env: NodeJS.ProcessEnv) =>
      execFileSync("git", args, { cwd: repo, env, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

    // Unisolated: the negative control. Without it a clean marker below is
    // equally consistent with git never consulting fsmonitor at all here.
    rmSync(marker, { force: true });
    try { run(["status", "--porcelain"], { ...process.env, HOME: home }); } catch {}
    const unisolatedRan = readdirSync(home).includes("FSMONITOR-RAN");

    rmSync(marker, { force: true });
    run(gitIsolatedArgs(["status", "--porcelain"]), gitIsolatedEnv({ ...process.env, HOME: home }));
    const isolatedRan = readdirSync(home).includes("FSMONITOR-RAN");

    expect(unisolatedRan, "git never ran fsmonitor even unisolated — this arm witnesses nothing").toBe(true);
    expect(isolatedRan, "the isolated argv STILL executed the repository's core.fsmonitor").toBe(false);
  });

  test("AC-D6: the env projection sets all three file-neutralising vars", () => {
    const env = gitIsolatedEnv({ PATH: "/usr/bin" });
    expect(env.PATH, "the base environment was discarded").toBe("/usr/bin");
    for (const [k, v] of Object.entries(GIT_ISOLATION_ENV)) expect(env[k]).toBe(v);
    expect(GIT_ISOLATION_CONFIG.map(([k]) => k)).toEqual([
      "core.fsmonitor", "core.excludesFile", "core.hooksPath", "safe.directory",
    ]);
  });
});

describe("#1001 — the worktree path is confined, not just matched", () => {
  /** A base with one real worktree directory in it. */
  function base(): { base: string; wt: string } {
    const home = tmp();
    const b = join(home, ".claude", ".claude", "worktrees");
    const wt = join(b, "agent-abc123");
    mkdirSync(wt, { recursive: true });
    return { base: b, wt };
  }

  test("AC-W1: a path inside the base resolves", () => {
    const { base: b, wt } = base();
    expect(confinedWorktreePath(wt, b)).toBe(realpathSync(wt));
  });

  test("AC-W2: a `..` escape is REFUSED, and it matches the hook's regex", () => {
    // The regex accepts this: it is a slash, a non-space run, `worktrees/`,
    // `agent-<hex>`, and a non-space run. A string prefix test accepts it
    // too. Only resolution rejects it.
    const { base: b } = base();
    // Concatenated, NOT `join`: `join` normalises `..` away, so building the
    // input with it produces a path that never contained the escape and an
    // arm that passes while witnessing nothing. Caught by the reachability
    // assertion below, which is why it is here.
    const escape = `${b}${sep}agent-abc123${sep}..${sep}..${sep}..${sep}..${sep}etc`;
    expect(escape).toContain("..");
    expect(/\/[^\s]*worktrees\/agent-[a-f0-9]+[^\s]*/i.test(escape), "the arm's input does not reach the defect").toBe(true);
    expect(confinedWorktreePath(escape, b)).toBeNull();
  });

  test("AC-W3: a SYMLINK out of the base is REFUSED", () => {
    const { base: b } = base();
    const outside = tmp();
    const link = join(b, "agent-deadbeef");
    symlinkSync(outside, link);
    expect(confinedWorktreePath(link, b)).toBeNull();
  });

  test("AC-W4: a sibling whose name EXTENDS the base is refused", () => {
    // `…/worktrees-evil` passes `startsWith("…/worktrees")`. The separator
    // in the comparison is what stops it.
    const { base: b } = base();
    const evil = b + "-evil";
    mkdirSync(join(evil, "agent-abc123"), { recursive: true });
    expect(evil.startsWith(b), "the arm's input does not exercise the separator").toBe(true);
    expect(confinedWorktreePath(join(evil, "agent-abc123"), b)).toBeNull();
  });

  test("AC-W5: a path outside the base entirely is refused", () => {
    const { base: b } = base();
    expect(confinedWorktreePath(tmp(), b)).toBeNull();
    expect(confinedWorktreePath("/etc", b)).toBeNull();
  });

  test("AC-W6: the base itself is not a worktree", () => {
    const { base: b } = base();
    expect(confinedWorktreePath(b, b)).toBeNull();
  });

  test("AC-W7: an absent base refuses everything", () => {
    // MEASURED LIMIT, stated rather than implied. This arm reddens when
    // confinement is removed wholesale (mutant N1), so it is not inert. It
    // does NOT distinguish the module's `catch { return null }` on the base
    // from a `catch` that fell through to the unresolved path: mutant N3
    // made exactly that change and reddened **0 of 16**.
    //
    // The reason is structural, not a gap in the inputs: if the base cannot
    // be resolved, no candidate under it can be resolved either, so the
    // prefix test refuses on its own and the explicit refusal is already
    // implied. I could not name an input on which mutant and original
    // differ, and per `.claude/rules/checks-must-be-able-to-fail.md` that
    // zero is recorded here rather than left to look like coverage. The
    // `catch` stays because a reader should not have to re-derive this.
    const absent = join(tmp(), "no-such-base");
    expect(confinedWorktreePath("/etc", absent)).toBeNull();
    expect(confinedWorktreePath(absent, absent)).toBeNull();
  });

  test("AC-W8: a nonexistent path inside the base is refused", () => {
    const { base: b } = base();
    expect(confinedWorktreePath(join(b, "agent-ffffff"), b)).toBeNull();
  });

  test("AC-W9: the base is read from the environment, not hardcoded", () => {
    expect(agentWorktreesBase({ HOME: "/h" })).toBe(join("/h", ".claude", ".claude", "worktrees"));
    // And it is the spelling the hook's fallback branch already used, so
    // this is a consolidation rather than a new declaring position.
    const hook = readFileSync(join(ROOT, "hooks", "CommitEnforcement.hook.ts"), "utf-8");
    expect(hook).toContain("agentWorktreesBase()");
    expect(hook, "the inline base literal is still in the hook").not.toContain("'.claude', '.claude', 'worktrees'");
  });

  test("AC-W10: both git call sites in the hook are isolated AND confined", () => {
    // A source assertion, deliberately: driving the hook to each exec needs
    // a real agent worktree under a real HOME, and a check that can only run
    // on this machine is one CI answers vacuously. This one a runner can
    // answer.
    const hook = readFileSync(join(ROOT, "hooks", "CommitEnforcement.hook.ts"), "utf-8");
    const calls = [...hook.matchAll(/execFileSync\('git',\s*([^,]+),/g)].map(m => m[1]);
    expect(calls.length, "the hook no longer has two git call sites — re-read this arm").toBe(2);
    for (const c of calls) expect(c, `a git call site bypasses the isolation: ${c}`).toContain("gitIsolatedArgs(");
    expect((hook.match(/confinedWorktreePath\(/g) ?? []).length, "a worktree candidate reaches git unconfined").toBe(2);
    expect((hook.match(/env: gitIsolatedEnv\(\)/g) ?? []).length).toBe(2);
  });
});
