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
import {
  agentWorktreeSubject,
  gitWorktreeBase,
  mostRecentAgentWorktree,
  registeredWorktreePath,
  registeredWorktrees,
} from "../lib/agent-worktree";
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

describe("#1001 — the subject is a REGISTERED worktree, not a path shape", () => {
  /**
   * A real repository with one commit and two linked worktrees, created the
   * way the harness creates them: `git worktree add` under `.claude/worktrees`
   * relative to the main checkout.
   */
  function repo(): { root: string; base: string; agent: string; other: string; workflow: string } {
    const root = realpathSync(tmp());
    const g = (...a: string[]) =>
      execFileSync("git", gitIsolatedArgs(["-C", root, ...a]), { stdio: "ignore", env: gitIsolatedEnv() });
    execFileSync("git", gitIsolatedArgs(["-C", root, "init", "-q", "-b", "main"]), { stdio: "ignore", env: gitIsolatedEnv() });
    writeFileSync(join(root, "seed.txt"), "x");
    g("add", "seed.txt");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");
    const base = join(root, ".claude", "worktrees");
    const agent = join(base, "agent-abc123");
    const other = join(base, "agent-def456");
    // A WORKFLOW worktree, registered and newer than both agent ones. The
    // fallback must not pick it: `CommitEnforcement`'s subject is a subagent
    // worktree, and attributing a subagent's uncommitted work to the
    // workflow tree is the misattribution in a different costume.
    const workflow = join(base, "wf_01234567-abc-9");
    g("worktree", "add", "-q", "-b", "wt-a", agent);
    g("worktree", "add", "-q", "-b", "wt-b", other);
    g("worktree", "add", "-q", "-b", "wt-w", workflow);
    return { root, base, agent, other, workflow };
  }

  test("AC-R1 CONTROL: a registered linked worktree IS the subject", () => {
    // Without this the refusals below are equally consistent with a
    // confinement that refuses everything — which is exactly the state this
    // PR exists to fix, reported as success.
    const { root, agent } = repo();
    const wts = registeredWorktrees(root);
    expect(wts, "git could not be asked — every arm below is vacuous").not.toBeNull();
    expect(registeredWorktreePath(agent, wts)).toBe(realpathSync(agent));
  });

  test("AC-R2: an UNREGISTERED directory in the right place is refused", () => {
    // The arm the previous fix could not express, and the whole reason for
    // this one. A path-confined check accepts this: it is under the base,
    // it resolves, and its name is `agent-<hex>`. Only asking git refuses
    // it. `Write` can create this directory; `Write` cannot register it.
    const { root, base } = repo();
    const planted = join(base, "agent-f00ba7");
    mkdirSync(planted, { recursive: true });
    const wts = registeredWorktrees(root);
    expect(planted.startsWith(realpathSync(base)), "the arm's input is not under the base").toBe(true);
    expect(registeredWorktreePath(planted, wts)).toBeNull();
  });

  test("AC-R3: the PRIMARY checkout is not an agent worktree", () => {
    const { root } = repo();
    const wts = registeredWorktrees(root)!;
    expect(wts).not.toContain(root);
    expect(registeredWorktreePath(root, wts)).toBeNull();
  });

  test("AC-R4: a `..` escape is refused, and it matches the hook's regex", () => {
    // Concatenated, NOT `join`: `join` normalises `..` away, so an input
    // built with it never contains the escape and the arm witnesses nothing.
    const { root, base } = repo();
    const escape = `${base}${sep}agent-abc123${sep}..${sep}..${sep}..${sep}..${sep}etc`;
    expect(escape).toContain("..");
    expect(/\/[^\s]*worktrees\/agent-[a-f0-9]+[^\s]*/i.test(escape), "the input does not reach the defect").toBe(true);
    expect(registeredWorktreePath(escape, registeredWorktrees(root))).toBeNull();
  });

  test("AC-R5: a symlink out of the tree is refused", () => {
    const { root, base } = repo();
    const outside = tmp();
    const link = join(base, "agent-deadbe");
    symlinkSync(outside, link);
    expect(registeredWorktreePath(link, registeredWorktrees(root))).toBeNull();
  });

  test("AC-R6: `could not ask git` is NULL, not an empty list", () => {
    // Two different answers, and collapsing them is how a refusal becomes
    // "nothing matched, carry on". A repo with no linked worktrees answers
    // [] and still refuses; a non-repo answers null.
    const notARepo = realpathSync(tmp());
    expect(registeredWorktrees(notARepo)).toBeNull();

    const bare = realpathSync(tmp());
    execFileSync("git", gitIsolatedArgs(["-C", bare, "init", "-q"]), { stdio: "ignore", env: gitIsolatedEnv() });
    expect(registeredWorktrees(bare), "a repo with no linked worktrees should answer []").toEqual([]);
    expect(registeredWorktreePath(bare, registeredWorktrees(bare))).toBeNull();
  });

  test("AC-R7: a named-but-unregistered candidate is TERMINAL", () => {
    // The misattribution. PR #1024 refused the candidate and then fell
    // through to "most recently modified", so a reply naming a worktree the
    // confinement did not recognise produced a signal about a DIFFERENT
    // agent's tree. The fallback must not be reachable from a refusal.
    const { root, base, agent } = repo();
    const planted = join(base, "agent-f00ba7");
    mkdirSync(planted, { recursive: true });
    const wts = registeredWorktrees(root);

    // A registered worktree exists and is exactly what the fallback would
    // pick, so "null" here cannot be mistaken for "there was nothing to
    // fall back to".
    expect(mostRecentAgentWorktree(wts), "the fallback has nothing to return — the arm proves nothing").not.toBeNull();
    expect(agentWorktreeSubject(`done in ${planted}`, "T", {}, wts)).toBeNull();
    // And the reply that names NOTHING still reaches the fallback.
    expect(agentWorktreeSubject("done, no path here", "T", {}, wts)).toBe(realpathSync(mostRecentAgentWorktree(wts)!));
    // A named, registered candidate is returned rather than the most recent.
    expect(agentWorktreeSubject(`done in ${agent}`, "T", {}, wts)).toBe(realpathSync(agent));
  });

  test("AC-R8: the fallback returns a REGISTERED worktree named like an agent", () => {
    const { root, base, workflow } = repo();
    mkdirSync(join(base, "agent-f00ba7"), { recursive: true });
    const wts = registeredWorktrees(root)!;
    const picked = mostRecentAgentWorktree(wts);
    expect(picked).not.toBeNull();
    expect(wts).toContain(picked!);
    // The workflow worktree is registered and was created LAST, so a
    // fallback without the name test picks it. This is the input that makes
    // the name test measurable rather than decorative.
    expect(wts, "the fixture has no workflow worktree — the name test is unmeasured here")
      .toContain(realpathSync(workflow));
    expect(picked, "the fallback picked a workflow worktree").not.toBe(realpathSync(workflow));
    expect(mostRecentAgentWorktree(null), "a null list must not become a pick").toBeNull();
    expect(mostRecentAgentWorktree([]), "an empty list must not become a pick").toBeNull();
  });

  test("AC-R9: the derived base is where registered worktrees ACTUALLY are", () => {
    // The arm that would have caught the defect this PR fixes. The previous
    // base was `$HOME/.claude/.claude/worktrees`; on this machine it holds
    // 16 stale directories and ZERO registered worktrees, while 136 live
    // ones sit under the repo-local base. A base nothing is registered
    // under is a confinement that cannot fail.
    const { root } = repo();
    const derived = gitWorktreeBase(root);
    expect(derived, "git could not say where worktrees live").not.toBeNull();
    const wts = registeredWorktrees(root)!;
    expect(wts.length, "no linked worktrees in the fixture — the arm is vacuous").toBeGreaterThan(0);
    for (const wt of wts) {
      expect(wt.startsWith(realpathSync(derived!) + sep), `${wt} is not under the derived base ${derived}`).toBe(true);
    }
  });

  test("AC-R10: `gitWorktreeBase` has ONE definition", () => {
    // It moved here from `scripts/collect-worktree-files.ts` because a hook
    // cannot import a script, and the hook guessed instead. A re-export
    // keeps that script's callers working; a second `function` body would
    // be the drift starting again.
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = p.slice(ROOT.length + 1);
        if (rel === "lib/agent-worktree.ts") continue;
        if (/function\s+gitWorktreeBase\s*\(/.test(readFileSync(p, "utf-8"))) offenders.push(rel);
      }
    };
    for (const d of ["lib", "hooks", "gates", "scripts"]) walk(join(ROOT, d));
    expect(offenders, `a second definition of gitWorktreeBase: ${offenders.join(", ")}`).toEqual([]);
  });

  test("AC-R11: the hook reaches git only through the subject and the isolation", () => {
    // A source assertion, deliberately: driving the hook to each exec needs
    // a live agent worktree registered to THIS repository, which a CI runner
    // does not have — an arm whose input is absent there passes vacuously.
    // This one a runner can answer.
    const hook = readFileSync(join(ROOT, "hooks", "CommitEnforcement.hook.ts"), "utf-8");
    const calls = [...hook.matchAll(/execFileSync\('git',\s*([^,]+),/g)].map(m => m[1]);
    expect(calls.length, "the hook no longer has two git call sites — re-read this arm").toBe(2);
    for (const c of calls) expect(c, `a git call site bypasses the isolation: ${c}`).toContain("gitIsolatedArgs(");
    expect((hook.match(/env: gitIsolatedEnv\(\)/g) ?? []).length).toBe(2);
    expect((hook.match(/agentWorktreeSubject\(/g) ?? []).length, "the subject is resolved somewhere else").toBe(1);
    // And no path-shaped base survives in the hook.
    expect(hook, "a worktrees base literal is back in the hook").not.toContain("'.claude', '.claude', 'worktrees'");
    expect(hook, "the hook is scanning a directory again").not.toContain("readdirSync");
  });
});
