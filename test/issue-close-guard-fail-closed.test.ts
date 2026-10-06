/**
 * #140: IssueCloseGuard must not permit a close it was unable to check.
 *
 * The guard's blocking branch lived inside a `try` whose `catch {}` was empty:
 *
 *     try {
 *       const github = createGitHubClient();
 *       const issueData = await getIssue(github, repo, issueNum);
 *       if (labelNames.includes('p1-ship-next') || ...) block(...);
 *     } catch {}
 *     console.log('WARNING: ...');
 *     process.exit(0);
 *
 * So anything throwing before `block()` — a missing token (#139), a rate
 * limit, a network blip — fell through to a warning and exit 0. Measured on
 * 2026-10-06: the same close of the same p1-labelled issue blocked with
 * GITHUB_TOKEN set and was waved through without it. The environment of the
 * day was the second one.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` names this shape directly:
 * fail-open error handling in a guard, where the `catch` resolves to "no
 * problem found".
 *
 * These drive the real hook as a subprocess, the way Claude Code runs it, so
 * the thing under test is the decision that actually reaches the caller. No
 * network: every case here is one the guard cannot reach GitHub for, which is
 * exactly the condition being tested.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRepoSlug, parseCloseTarget, redactSecrets } from "../hooks/lib/utils";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK = join(REPO_ROOT, "hooks", "IssueCloseGuard.hook.ts");

let workBase: string;

/** `hooks/lib/utils.ts` joins `.rungate` onto RUNGATE_WORK_DIR. */
const workDir = () => join(workBase, ".rungate");

beforeEach(() => {
  workBase = mkdtempSync(join(tmpdir(), "close-guard-"));
  mkdirSync(workDir(), { recursive: true });
});

afterEach(() => {
  if (workBase) rmSync(workBase, { recursive: true, force: true });
});

function runGuard(
  command: string,
  env: Record<string, string | undefined> = {},
): { stdout: string; decision: string | null } {
  const childEnv: Record<string, string> = { ...process.env } as any;
  // Both names, always, so the test does not inherit whichever one the
  // developer's shell happens to export.
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_TOKEN;
  childEnv.RUNGATE_WORK_DIR = workBase;
  // Belt and braces: even a case that unexpectedly acquires a credential
  // cannot reach the real API from here. The spec forbids tests touching
  // GitHub, and a guard test that silently started making live calls would
  // be slow, flaky, and rate-limited long before anyone noticed why.
  childEnv.GITHUB_API_URL = "http://127.0.0.1:1";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }

  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf-8",
    env: childEnv,
    timeout: 30000,
  });
  const stdout = r.stdout || "";
  let decision: string | null = null;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      decision = JSON.parse(t).decision ?? null;
    } catch {}
  }
  return { stdout, decision };
}

const CLOSE = "gh issue close 23 --repo hornjason/pai-harness";

describe("#140: a close the guard could not verify is not permitted", () => {
  test("no credential of any name — blocks instead of warning", () => {
    // Pre-fix this printed "WARNING: Closing #23 but no workflow-state.json
    // found" and exited 0, and the close proceeded.
    const { decision, stdout } = runGuard(CLOSE);
    expect(decision, `guard permitted an unverifiable close:\n${stdout}`).toBe("block");
  });

  test("the refusal says it could not check, not that a label was found", () => {
    // An operator has to be able to tell "this issue is protected" from "I am
    // not able to tell whether it is" — they are different problems with
    // different fixes, and conflating them trains people to ignore the guard.
    const { stdout } = runGuard(CLOSE);
    expect(stdout.toLowerCase()).toMatch(/could not|unable|cannot verify/);
    expect(
      stdout,
      "the guard claimed a specific label it never managed to read",
    ).not.toMatch(/has p1-ship-next label/);
  });

  test("a failure that is not the token blocks too", () => {
    // The missing token is only the most common way this throws, and a fix
    // that special-cased it would pass the two tests above while still
    // failing open on everything else — which is the half of #140 that
    // outlives #139.
    //
    // A credential is present, so construction succeeds; the API base points
    // at a closed port on loopback, so the request fails as a network error
    // inside the same `try`. Nothing leaves the machine, which also keeps the
    // spec constraint that tests never reach the real GitHub API.
    const { decision, stdout } = runGuard(CLOSE, {
      GITHUB_TOKEN: "syntactically-fine-but-never-used",
      GITHUB_API_URL: "http://127.0.0.1:1",
    });
    expect(decision, `guard permitted a close it could not check:\n${stdout}`).toBe("block");
  });
});

describe("#140: the repo slug is parsed precisely enough to act on", () => {
  // `--repo (\S+)` swallowed everything up to the next space, so a close
  // appearing inside a nested shell string captured `owner/name"}}'` and the
  // lookup 404'd on the mangled slug. Harmless while the catch was empty;
  // once an unreadable label set blocks, a sloppy parse refuses a legitimate
  // close. Found by running the fixed hook and having it block this very
  // test's own command line.
  test.each([
    // The case that caught this: a close nested inside another shell string.
    [`gh issue close 23 --repo hornjason/pai-harness"}}'`, "hornjason/pai-harness"],
    [`gh issue close 23 --repo owner/name`, "owner/name"],
    [`gh issue close 23 --repo "owner/name"`, "owner/name"],
    [`gh issue close 23 --repo 'owner/name'`, "owner/name"],
    [`gh issue close 23 --repo=owner/name`, "owner/name"],
    [`gh issue close 23 --repo owner/name && echo done`, "owner/name"],
    [`gh issue close 23 --repo my.org/some_repo-2`, "my.org/some_repo-2"],
  ])("%s -> %s", (command, expected) => {
    // Explicit empty env everywhere: `parseRepoSlug` now consults GH_REPO, so
    // defaulting to process.env would make these pass or fail on whether the
    // developer's shell exports it.
    expect(parseRepoSlug(command, {})).toBe(expected);
  });

  /**
   * Checked against the real binary rather than assumed. Each row is a way
   * `gh` resolves the target that the first version of this parser got wrong,
   * and every disagreement means the guard vets one repository's labels while
   * `gh` closes an issue in another.
   */
  describe("agreement with what gh actually does", () => {
    test("the LAST --repo wins, as gh does — this one was a bypass", () => {
      // Verified: `gh issue view 23 --repo hornjason/pai-config --repo
      // hornjason/pai-harness` returns the pai-harness issue. Taking the
      // first let `--repo unprotected/x --repo protected/y` be vetted
      // against unprotected/x and closed in protected/y.
      expect(
        parseRepoSlug(`gh issue close 23 --repo unprotected/x --repo protected/y`, {}),
        "the guard would check a different repo than gh closes",
      ).toBe("protected/y");
    });

    test("-R is recognised, as gh does", () => {
      // Verified: `gh issue view 23 -R hornjason/pai-harness` works. Missing
      // it sent the guard to the caller's default instead.
      expect(parseRepoSlug(`gh issue close 23 -R owner/name`, {})).toBe("owner/name");
    });

    test("GH_REPO is used when no flag is given, as gh does", () => {
      // Verified: `GH_REPO=hornjason/pai-harness gh issue view 23` works.
      expect(parseRepoSlug(`gh issue close 23`, { GH_REPO: "owner/name" })).toBe("owner/name");
    });

    test("an explicit flag beats GH_REPO, as gh does", () => {
      expect(
        parseRepoSlug(`gh issue close 23 --repo flag/wins`, { GH_REPO: "env/loses" }),
      ).toBe("flag/wins");
    });

    test("a malformed GH_REPO is refused rather than passed through", () => {
      expect(parseRepoSlug(`gh issue close 23`, { GH_REPO: "../.." })).toBeUndefined();
      expect(parseRepoSlug(`gh issue close 23`, { GH_REPO: "notaslug" })).toBeUndefined();
    });
  });

  test.each([
    ["no --repo at all", `gh issue close 23`],
    ["a bare word that is not a slug", `gh issue close 23 --repo garbage`],
    ["a flag value that is another flag", `gh issue close 23 --repo --json`],
  ])("returns undefined for %s, so the caller's default applies", (_label, command) => {
    expect(parseRepoSlug(command, {})).toBeUndefined();
  });

  test.each([
    ["../.."],
    ["../etc"],
    ["owner/.."],
    ["./x"],
    ["owner/."],
  ])("refuses the relative segment in --repo %s", slug => {
    // `[A-Za-z0-9._-]+` admits `.` and `..`, so these parsed as slugs and
    // reached Octokit, which built `/repos/../../issues/N` and sent it. Seen
    // for real: the guard reported "Not Found - https://docs.github.com/rest"
    // for a crafted `--repo`, which is a different endpoint than the one it
    // meant to ask about.
    expect(parseRepoSlug(`gh issue close 23 --repo ${slug}`, {})).toBeUndefined();
  });

  test("a legitimate name that merely contains dots still parses", () => {
    // The guard must reject `..` as a whole segment, not punish dots.
    expect(parseRepoSlug(`gh issue close 23 --repo my.org/v1.2.3-repo`, {})).toBe("my.org/v1.2.3-repo");
  });
});

describe("#140: a command the parser cannot read unambiguously is refused", () => {
  // Third round of security review found a third parser differential, which
  // is the signal to stop tightening the regex. The parse now reports whether
  // the command is simple enough to vet; anything else is a refusal. These
  // are the shapes where our view and the shell's can diverge.
  test("two closes in one command — the bypass that forced this", () => {
    // `closeMatch` took the FIRST issue, the repo scan took the LAST slug, so
    // this vetted issue 1's labels against protected/y and then closed 99.
    const t = parseCloseTarget(
      `gh issue close 1 --repo unprotected/x; gh issue close 99 --repo protected/y`,
      {},
    );
    expect(t.kind, "the guard paired one issue with another's repo").toBe("ambiguous");
  });

  test.each([
    ["a command substitution", `gh issue close 23 --repo $(cat repo.txt)`],
    ["backticks", "gh issue close 23 --repo `cat repo.txt`"],
    ["parameter expansion", `gh issue close 23 --repo \${REPO}`],
    ["an eval", `eval "gh issue close 23 --repo a/b"`],
  ])("%s is refused rather than guessed at", (_label, command) => {
    expect(parseCloseTarget(command, {}).kind).toBe("ambiguous");
  });

  test("a substitution that adds a second --repo we cannot see", () => {
    // The cases above are all shielded by the "--repo value is not a literal
    // slug" rule, so a mutation deleting the substitution check survived
    // them — they prove the wrong thing. This one has a perfectly literal
    // `--repo owner/name` AND a readable issue number, so every other rule
    // is satisfied; only the substitution check stands between the guard and
    // a confident wrong answer.
    //
    // At runtime the expansion appends a second `--repo other/repo`, and gh
    // takes the last one. Vetting owner/name would approve a close that
    // lands in other/repo.
    const t = parseCloseTarget(
      `gh issue close 23 --repo owner/name $(echo --repo other/repo)`,
      {},
    );
    expect(t.kind, "an unexpanded substitution was treated as readable").toBe("ambiguous");
  });

  test.each([
    ["a trailing chained command", `gh issue close 23 --repo a/b && echo done`],
    ["a pipe", `gh issue close 23 --repo a/b | tee log`],
    ["a following line", `gh issue close 23 --repo a/b\necho done`],
  ])("%s is vetted, because only one segment closes anything", (_label, command) => {
    // Earlier these were refused outright, on the theory that any separator
    // made the command unreadable. That was too blunt: it refuses the most
    // ordinary shapes people actually type, and a guard that blocks routine
    // work is a guard that gets turned off. Splitting on separators and
    // requiring exactly one closing segment keeps the protection — two real
    // gh invocations cannot share a line without a separator — while letting
    // these through.
    expect(parseCloseTarget(command, {})).toEqual({ kind: "one", issue: "23", repo: "a/b" });
  });

  test("a close mentioned inside a comment body is not a second close", () => {
    // I previously asserted the opposite, and it was wrong. The shell runs
    // exactly one gh here; the second "close" is quoted prose in the comment
    // text. Vetting issue 1 is the correct answer, and refusing it was a
    // false positive that would have blocked a reasonable command.
    //
    // Two REAL invocations cannot share a line without a separator, which is
    // what the segment split counts — so nothing is lost by allowing this.
    expect(
      parseCloseTarget(`gh issue close 1 --repo a/b --comment "supersedes gh issue close 99"`, {}),
    ).toEqual({ kind: "one", issue: "1", repo: "a/b" });
  });

  test("a quoted separator before a second close still refuses", () => {
    // The split is textual, so a `;` inside quotes splits too. That makes
    // this look like two closing segments and it is refused. A false
    // positive, and the safe direction: the alternative is parsing shell
    // quoting correctly, which is the differential this design exists to
    // stop relying on.
    const t = parseCloseTarget(
      `gh issue close 1 --repo a/b --comment "done; gh issue close 99"`,
      {},
    );
    expect(t.kind).toBe("ambiguous");
  });

  test("a --repo that is a variable is refused, not silently defaulted", () => {
    // Falling back to the caller's default here would vet a completely
    // different repository than the one gh resolves at runtime.
    const t = parseCloseTarget(`gh issue close 23 --repo "$REPO"`, {});
    expect(t.kind).toBe("ambiguous");
  });

  test.each([
    // THE bypass class: the detector missing a close entirely means the guard
    // steps aside and the close is never vetted at all. The old pattern
    // demanded `close\s+(\d+)`, so every one of these returned "none".
    ["flag before the number", `gh issue close --repo owner/name 23`, "23", "owner/name"],
    ["a quoted number", `gh issue close "23" --repo owner/name`, "23", "owner/name"],
    ["a hash-prefixed number", `gh issue close #23 --repo owner/name`, "23", "owner/name"],
    ["an absolute path to gh", `/opt/homebrew/bin/gh issue close 23 --repo owner/name`, "23", "owner/name"],
    ["an issue URL instead of a number", `gh issue close https://github.com/owner/name/issues/23`, "23", "owner/name"],
  ])("%s is still detected and vetted", (_label, command, issue, repo) => {
    expect(parseCloseTarget(command, {})).toEqual({ kind: "one", issue, repo });
  });

  test("a benign chained command is vetted, not refused", () => {
    // Rejecting every separator outright would have made the guard
    // intolerable for ordinary use, and an intolerable guard gets disabled.
    expect(parseCloseTarget(`cd /tmp/x && gh issue close 23 --repo owner/name`, {})).toEqual({
      kind: "one",
      issue: "23",
      repo: "owner/name",
    });
  });

  test("digits elsewhere do not displace the number after close", () => {
    expect(
      parseCloseTarget(`gh issue close 23 --repo owner/name --comment "fixed in 5 minutes"`, {}),
    ).toEqual({ kind: "one", issue: "23", repo: "owner/name" });
  });

  test("a URL that disagrees with --repo is refused", () => {
    // gh takes the repo from the URL; a guard reading --repo would vet the
    // wrong one.
    const t = parseCloseTarget(
      `gh issue close https://github.com/owner/name/issues/23 --repo other/repo`,
      {},
    );
    expect(t.kind).toBe("ambiguous");
  });

  test("no readable issue number is refused, not skipped", () => {
    const t = parseCloseTarget(`gh issue close --repo owner/name`, {});
    expect(t.kind).toBe("ambiguous");
  });

  test("several candidate numbers after close are refused", () => {
    const t = parseCloseTarget(`gh issue close --repo owner/name 23 99`, {});
    expect(t.kind).toBe("ambiguous");
  });

  test("a plain, readable close is still handled, not refused", () => {
    // The refusals must not swallow the ordinary case — a guard that blocks
    // everything gets switched off.
    expect(parseCloseTarget(`gh issue close 23 --repo owner/name`, {})).toEqual({
      kind: "one",
      issue: "23",
      repo: "owner/name",
    });
  });

  test("a command with no close at all is left alone", () => {
    expect(parseCloseTarget(`git status --porcelain`, {}).kind).toBe("none");
  });

  test("the reason names what to do about it", () => {
    const t = parseCloseTarget(`gh issue close 1 --repo a/b; gh issue close 2 --repo c/d`, {});
    expect(t.kind).toBe("ambiguous");
    if (t.kind === "ambiguous") expect(t.reason).toMatch(/separately|on its own|literally/);
  });
});

describe("#140: a block reason never carries a credential", () => {
  // Tested as a function, not through the hook: `runGuard` uses spawnSync,
  // which blocks the event loop, so a Bun.serve in this process can never
  // answer the subprocess's request. The first attempt at a live-server
  // version deadlocked for 30s and timed out.
  test.each([
    ["classic PAT", "Bad credentials ghp_AAAAAAAAAAAAAAAAAAAA", "ghp_AAAAAAAAAAAAAAAAAAAA"],
    ["OAuth token", "401 for gho_BBBBBBBBBBBBBBBBBBBB", "gho_BBBBBBBBBBBBBBBBBBBB"],
    ["fine-grained PAT", "github_pat_11ABCDE_xyz rejected", "github_pat_11ABCDE_xyz"],
    ["basic auth in a URL", "GET http://someuser:s3cr3t@host/repos/a/b", "s3cr3t"],
  ])("%s is removed", (_label, message, secret) => {
    const out = redactSecrets(message);
    expect(out, "a credential survived redaction").not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  test("ordinary error text is left intact", () => {
    // Over-redaction would make block reasons useless to act on.
    const msg = "Not Found - https://docs.github.com/rest/issues/issues#get-an-issue";
    expect(redactSecrets(msg)).toBe(msg);
  });

  test("the guard routes its error text through the redactor", () => {
    // The functions above prove the redactor works; this proves it is wired
    // in. Without it a future edit could print `e.message` directly and every
    // test above would still pass.
    const hook = readFileSync(join(REPO_ROOT, "hooks", "IssueCloseGuard.hook.ts"), "utf-8");
    const codeLines = hook
      .split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const detail = codeLines.find(l => /const detail\s*=/.test(l));
    expect(detail, "the catch no longer builds a detail string").toBeDefined();
    expect(detail!, "the error text is printed without redaction").toContain("redactSecrets(");
  });
});

describe("#140: the guard still gets out of the way when it can decide", () => {
  const writeState = (slug: string, state: unknown) => {
    const dir = join(workDir(), slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow-state.json"), JSON.stringify(state, null, 2));
  };

  test("a run that passed the ship gate closes without consulting GitHub", () => {
    // The fix must not turn into "block everything when there is no token".
    // This path never needed GitHub: the evidence is on disk. If this goes
    // red, the guard has started refusing legitimate closes offline.
    writeState("pai-harness-23", {
      issue: 23,
      phase: "DONE",
      gates: { ship: { result: "PASS" } },
    });
    const { decision, stdout } = runGuard(CLOSE);
    expect(decision, `a shipped issue was refused:\n${stdout}`).not.toBe("block");
  });

  test("a command that is not an issue close is untouched", () => {
    const { decision } = runGuard("git status --porcelain");
    expect(decision).toBeNull();
  });
});
