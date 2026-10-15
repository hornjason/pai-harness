/**
 * #430 — running the test suite pushed the real repository.
 *
 * Covers SC-1495, SC-1496, SC-1497 (HARNESS-STANDARD.md).
 *
 * `gates/orchestrator.ts` guards its auto-push with `if (issueRepo && issue
 * > 0)` and then pushes `process.cwd()`. `test/contract.test.ts` runs the
 * ship gate over a fixture whose state says `issueRepo: "test/repo"` and
 * `issue: 9998` — both truthy — while the process is sitting in the real
 * rungate checkout. So the guard passed, the push ran, and the repository it
 * reached was the one that must not be touched.
 *
 * The cwd choice is deliberate and stays (its reasoning is in the comment
 * above that call: letting a state file pick the repo a push runs against is
 * a privileged operation taking its target from data). What was missing is
 * the other half — when the state is a fixture, `process.cwd()` is precisely
 * the wrong tree, and the two facts have to be compared rather than assumed
 * to agree.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { originIdentity, originSlug, parseRemoteSlug, repoMatches, verifiedPush } from "../lib/verified-push";

let TMP = "";
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "rungate-430-"));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe", env: ENV });
}

/** A clone of a bare remote, on a correctly-tracking branch, one commit ahead. */
function repo(name: string, remoteUrl?: string) {
  const origin = join(TMP, `${name}.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe", env: ENV });

  const work = join(TMP, `${name}-work`);
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe", env: ENV });
  git(work, ["config", "user.email", "fixtures@rungate.invalid"]);
  git(work, ["config", "user.name", "rungate fixtures"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(work, "README.md"), "seed\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "seed"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  if (remoteUrl) git(work, ["remote", "set-url", "origin", remoteUrl]);
  writeFileSync(join(work, "work.txt"), "local\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "work"]);

  return { work, origin, mainSha: () => mainSha(origin) };
}

function mainSha(bare: string): string | null {
  const out = execFileSync("git", ["ls-remote", "--", bare, "refs/heads/main"], {
    encoding: "utf-8", stdio: "pipe", env: ENV,
  });
  return out.split("\t")[0]?.trim() || null;
}

describe("SC-1495: a push whose expected repo is not the cwd's repo is refused", () => {
  test("the fixture slug from #430 does not push the real tree", () => {
    // `test/repo` and `issue: 9998` verbatim from test/contract.test.ts's
    // fixture — the exact pair that was truthy enough to push.
    const r = repo("fixture-slug");
    const before = r.mainSha();
    const outcome = verifiedPush(r.work, { env: ENV, expectRepo: "test/repo" });

    expect(outcome.kind).toBe("repo-mismatch");
    expect(r.mainSha(), "a gate run for a fixture issueRepo pushed a real tree").toBe(before);
  });

  test("the refusal names both repositories, because either one could be the mistake", () => {
    const r = repo("named-both", "https://github.com/hornjason/pai-harness.git");
    const outcome = verifiedPush(r.work, { env: ENV, expectRepo: "test/repo" });
    expect(outcome.detail).toContain("test/repo");
    expect(outcome.detail).toContain("hornjason/pai-harness");
  });

  test("an unreadable origin refuses rather than pushing", () => {
    // Fail closed. "I could not tell which repo this is" and "it is the right
    // repo" are different facts, and only one of them licenses a push.
    const noRemote = join(TMP, "no-remote");
    execFileSync("git", ["init", "-b", "main", noRemote], { stdio: "pipe", env: ENV });
    const outcome = verifiedPush(noRemote, { env: ENV, expectRepo: "test/repo" });
    expect(["repo-mismatch", "unmeasured", "no-upstream"]).toContain(outcome.kind);
    expect(outcome.kind).not.toBe("pushed");
  });
});

describe("SC-1496: the control — a matching repo still pushes", () => {
  // A matching repo cannot be pushed end-to-end in a test, and the reason is
  // the security property itself: `originIdentity` requires the configured
  // url and the effective push url to be the same parseable slug, so a
  // fixture can have an origin that PARSES (a https url, unreachable) or one
  // that RESOLVES (a local bare path, unparseable), never both. The first
  // draft used `url.<local>.insteadOf` to get both and that is exactly the
  // rewrite the check now refuses — it was the test demonstrating the hole.
  //
  // So the control is split, and both halves are real: the decision permits,
  // and a push with nothing to compare against still reaches a remote.

  test("the decision permits when configured and effective urls agree", () => {
    const r = repo("matching", "https://github.com/test-owner/test-name.git");
    const identity = originIdentity(r.work, "test-owner/test-name", ENV);
    expect(identity.ok, `a matching repo must be permitted: ${JSON.stringify(identity)}`).toBe(true);
  });

  test("omitting expectRepo leaves the old behaviour untouched, remote and all", () => {
    // The option is opt-in, so a caller with no repository to compare
    // against is not silently blocked — and this half proves the push path
    // the control above cannot reach still works.
    const r = repo("no-expectation");
    expect(verifiedPush(r.work, { env: ENV }).kind).toBe("pushed");
    expect(r.mainSha()).toBe(git(r.work, ["rev-parse", "HEAD"]).trim());
  });

});

describe("SC-1497: slug comparison handles the URL forms git actually produces", () => {
  test.each([
    ["https://github.com/hornjason/pai-harness.git", "hornjason/pai-harness"],
    ["https://github.com/hornjason/pai-harness", "hornjason/pai-harness"],
    ["git@github.com:hornjason/pai-harness.git", "hornjason/pai-harness"],
    ["ssh://git@github.com/hornjason/pai-harness.git", "hornjason/pai-harness"],
    ["https://x-access-token:TOKEN@github.com/hornjason/pai-harness.git", "hornjason/pai-harness"],
  ])("%s → %s", (url, slug) => {
    expect(repoMatches(url, slug)).toBe(true);
  });

  test("a different repo on the same host does not match", () => {
    expect(repoMatches("https://github.com/hornjason/pai-harness.git", "hornjason/other")).toBe(false);
    expect(repoMatches("https://github.com/someone/pai-harness.git", "hornjason/pai-harness")).toBe(false);
  });

  test("the comparison is case-insensitive, as GitHub is", () => {
    expect(repoMatches("https://github.com/HornJason/PAI-Harness.git", "hornjason/pai-harness")).toBe(true);
  });

  test("an unparseable url matches nothing", () => {
    // Not "matches everything", which is the fail-open shape.
    expect(repoMatches("", "hornjason/pai-harness")).toBe(false);
    expect(repoMatches("not a url", "hornjason/pai-harness")).toBe(false);
  });

  test("a local path remote does not accidentally match a slug", () => {
    // Every fixture in this suite has a filesystem origin, so this is the
    // case that decides whether the whole test suite can push anything.
    expect(repoMatches("/tmp/rungate-430-abc/fixture.git", "test/repo")).toBe(false);
  });
});

describe("SC-1497: the gate passes its issueRepo through", () => {
  test("the orchestrator's auto-push call supplies expectRepo", () => {
    const src = require("fs").readFileSync(join(import.meta.dir, "..", "gates", "orchestrator.ts"), "utf-8");
    const at = src.indexOf("verifiedPush(process.cwd()");
    expect(at, "the auto-push call moved — this guard is reading nothing").toBeGreaterThan(-1);
    const end = src.indexOf("});", at);
    expect(end, "the auto-push call has no end — the slice would be the rest of the file")
      .toBeGreaterThan(at);
    const call = src.slice(at, end);
    expect(call, "the gate must tell verifiedPush which repo it believes it is shipping")
      .toContain("expectRepo");
  });
});

/**
 * Found by the background security review of the first commit, not by me.
 * Both are recorded here because a finding without a test is a finding that
 * comes back.
 */
describe("SC-1498: the check cannot be disabled or sidestepped", () => {
  test("a rewrite that redirects the push is refused, not approved", () => {
    // The gate/action field mismatch. `git push` resolves
    // `url.<base>.insteadOf`; the first draft read only the CONFIGURED url,
    // so a rewrite could satisfy the check and then write somewhere else.
    // A guard that approves one destination and permits a push to another
    // is not a guard.
    const r = repo("rewritten");
    const url = "https://github.com/test-owner/test-name.git";
    git(r.work, ["config", `url.${r.origin}.insteadOf`, url]);
    git(r.work, ["remote", "set-url", "origin", url]);

    const before = r.mainSha();
    const outcome = verifiedPush(r.work, { env: ENV, expectRepo: "test-owner/test-name" });
    expect(outcome.kind).toBe("repo-mismatch");
    expect(outcome.detail).toContain("insteadOf");
    expect(r.mainSha(), "a rewritten push url reached a remote the check never approved").toBe(before);
  });

  test("a blank expectRepo refuses rather than skipping the check", () => {
    // The fail-open. `expectRepo !== undefined && expectRepo.trim() !== ""`
    // meant an empty value turned the guard off and restored the
    // unconditional push — malformed input disabling the check.
    const r = repo("blank-expectation");
    const before = r.mainSha();
    for (const expectRepo of ["", "   "]) {
      expect(verifiedPush(r.work, { env: ENV, expectRepo }).kind).toBe("repo-mismatch");
    }
    expect(r.mainSha()).toBe(before);
  });

  test("the host is not part of the comparison, and that is stated", () => {
    // Recorded as a KNOWN limit rather than silently relied on. `issueRepo`
    // is `owner/name` and carries no host, so there is nothing here to
    // compare one against. If this ever becomes false the docblock is wrong
    // and this test should be the thing that says so.
    expect(parseRemoteSlug("https://example.invalid/hornjason/pai-harness.git"))
      .toBe(parseRemoteSlug("https://github.com/hornjason/pai-harness.git"));
    const src = require("fs").readFileSync(join(import.meta.dir, "..", "lib", "verified-push.ts"), "utf-8");
    expect(src, "an undocumented limit is a limit someone will assume away")
      .toContain("What this does NOT check");
  });
});
