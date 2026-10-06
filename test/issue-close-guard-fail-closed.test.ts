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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRepoSlug } from "../hooks/lib/utils";

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
    expect(parseRepoSlug(command)).toBe(expected);
  });

  test.each([
    ["no --repo at all", `gh issue close 23`],
    ["a bare word that is not a slug", `gh issue close 23 --repo garbage`],
    ["a flag value that is another flag", `gh issue close 23 --repo --json`],
  ])("returns undefined for %s, so the caller's default applies", (_label, command) => {
    expect(parseRepoSlug(command)).toBeUndefined();
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
