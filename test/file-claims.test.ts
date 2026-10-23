/**
 * #1413: a lock an agent can take without a coordinator.
 *
 * The issue's acceptance has three parts and this file carries all three:
 * one command answers whether a path has a live writer; a negative control
 * replays the sequence that motivated it and shows the mechanism orders it;
 * and the population the check covers is stated rather than implied.
 *
 * The reading that shaped the design, from the issue's own measurements:
 * detection is non-viable here. `find -newermt` silently matches nothing on
 * this platform, and `git worktree add` bumps every mtime, so a sweep over
 * 233 worktrees reported 36,939 "recently edited" files. Every accurate
 * instrument — `gh pr list`, `closingIssuesReferences`, the tracker —
 * describes PUSHED state, and the dangerous window is before the push. So
 * the signal must be written by the writer, and the cases below are about a
 * declaration rather than about the disk.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  FILE_CLAIMS_CONTROL_KEY,
  FILE_CLAIMS_PATH,
  allClaims,
  claimCovers,
  contention,
  liveClaims,
  ownerState,
  readFileClaims,
  type FileClaim,
  type PullState,
} from "../lib/file-claims";
import { repoSlug } from "../scripts/claim-files";

const REPO = join(import.meta.dir, "..");
const PAIR = ["lib/scaffold/ai-review-step.ts", ".github/workflows/ai-review.yml"];

const store = (claims: unknown[]) => JSON.stringify({ [FILE_CLAIMS_CONTROL_KEY]: claims });
const claim = (owner: string, paths: string[], over: Partial<FileClaim> = {}): FileClaim => ({
  owner,
  paths,
  ...over,
});

describe("#1413: three readings, and an unreadable registry is not an empty one", () => {
  test("a registry that declares nothing is READ, not absent", () => {
    // The distinction this mechanism turns on. "Nobody holds anything" is a
    // fact a registry can state; "there is no registry" is a different one,
    // and a caller that collapsed them would report free under both.
    const r = readFileClaims(store([]));
    expect(r.status).toBe("read");
    expect(r.claims).toEqual([]);
  });

  test("no registry at all is ABSENT, and says so", () => {
    const r = readFileClaims(null);
    expect(r.status).toBe("absent");
    expect(r.reason).toBeDefined();
  });

  test("`{}` is UNREADABLE, because it cannot be told from a file that lost its contents", () => {
    const r = readFileClaims("{}");
    expect(r.status).toBe("unreadable");
    expect(r.reason, "the control key is not named in the refusal").toContain(
      FILE_CLAIMS_CONTROL_KEY,
    );
  });

  test.each([
    ["not JSON at all", "{nope", "not JSON"],
    ["an array rather than a store", "[]", "not an object"],
    ["a non-array under the key", `{"${FILE_CLAIMS_CONTROL_KEY}":{}}`, "not an array"],
  ])("UNREADABLE: %s", (_label, raw, fragment) => {
    const r = readFileClaims(raw);
    expect(r.status).toBe("unreadable");
    expect(r.reason).toContain(fragment);
  });

  test.each([
    ["an entry that is not an object", [42], "is not an object"],
    ["no owner", [{ paths: ["a"] }], "has no owner"],
    ["an empty owner", [{ owner: "   ", paths: ["a"] }], "has no owner"],
    ["no paths", [{ owner: "b" }], "claims no paths"],
    ["an empty path list", [{ owner: "b", paths: [] }], "claims no paths"],
    ["a non-string path", [{ owner: "b", paths: [7] }], "is not a path"],
    ["an absolute path", [{ owner: "b", paths: ["/etc/passwd"] }], "is absolute"],
    ["a path escaping the repo", [{ owner: "b", paths: ["../x"] }], "escapes the repository"],
    ["a non-integer issue", [{ owner: "b", paths: ["a"], issue: "7" }], "non-integer issue"],
  ])("one bad entry refuses the WHOLE store: %s", (_label, claims, fragment) => {
    // Dropping the entry instead would release a lock silently, which is the
    // one failure this file must not have.
    const r = readFileClaims(store(claims));
    expect(r.status).toBe("unreadable");
    expect(r.reason).toContain(fragment);
    expect(r.claims, "a refused store handed back claims anyway").toEqual([]);
  });

  test("CONTROL: a well-formed store with every optional field reads clean", () => {
    // Without this the nine rows above are satisfied by a reader that refuses
    // everything, which would also report every file held forever.
    const r = readFileClaims(
      store([{ owner: "rg/x", paths: ["lib/a.ts", "test/"], issue: 1413, note: "why" }]),
    );
    expect(r.status).toBe("read");
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].issue).toBe(1413);
  });
});

describe("#1413: a directory claims what is beneath it, and nothing else", () => {
  test.each([
    ["the file itself", "lib/a.ts", "lib/a.ts", true],
    ["a directory covers a child", "lib", "lib/a.ts", true],
    ["a trailing slash is the same claim", "lib/", "lib/a.ts", true],
    ["a directory covers a grandchild", "lib", "lib/deep/a.ts", true],
    ["a prefix that is not a path boundary does NOT match", "lib", "library/a.ts", false],
    ["a sibling is not covered", "lib/a.ts", "lib/b.ts", false],
    ["the parent of a claimed file is not covered", "lib/a.ts", "lib", false],
  ])("%s", (_label, claimed, path, want) => {
    expect(claimCovers(claimed, path)).toBe(want);
  });
});

describe("#1413: liveness is resolved from git, never trusted from the file", () => {
  const claims = [
    claim("rg/merged-and-forgotten", PAIR, { issue: 1 }),
    claim("rg/still-working", PAIR, { issue: 2 }),
  ];

  test("a claim whose owner branch is gone holds nothing", () => {
    // `.claude/rules/parallel-sessions.md`: a block nobody prunes is headroom
    // nobody can use. Here it would be worse — a file nobody may ever work on
    // again, on the say-so of a branch that merged days ago.
    const live = new Set(["rg/still-working"]);
    const held = liveClaims(claims, PAIR[0], live);
    expect(held.map(c => c.owner)).toEqual(["rg/still-working"]);
  });

  test("the dead claim is still READABLE, so a report can say it is dead", () => {
    // Filtering it out of the data as well as out of the decision would make
    // "free, and here is the stale entry you should prune" unsayable.
    expect(allClaims(claims, PAIR[0]).map(c => c.owner)).toEqual([
      "rg/merged-and-forgotten",
      "rg/still-working",
    ]);
  });

  test("CONTROL: with every owner live, both claims hold", () => {
    const live = new Set(["rg/merged-and-forgotten", "rg/still-working"]);
    expect(liveClaims(claims, PAIR[0], live)).toHaveLength(2);
  });

  test("CONTROL: with no owner live, the same paths are free", () => {
    // The discrimination. A `liveClaims` that ignored its third argument
    // passes the first case above and fails here.
    expect(liveClaims(claims, PAIR[0], new Set())).toEqual([]);
  });
});

/**
 * The negative control the issue asks for: replay the sequence that motivated
 * it, and show the mechanism orders it.
 *
 * #1351, #1386, #1379, #1369 and #1370 all edited the generated pair on
 * 2026-10-23. #1370 went DIRTY five times in three hours, #1387 rebased four
 * times, and every conflict was the same file with the same three-step
 * resolution. Replayed here as the five branches arriving one after another.
 */
describe("#1413: the five PRs that motivated this are serialised, not merged together", () => {
  const SEQUENCE: [string, number][] = [
    ["rg/1351-shell-parity", 1351],
    ["rg/1386-bot-login", 1386],
    ["rg/1379-path-resolve", 1379],
    ["rg/1369-pagination", 1369],
    ["rg/1370-ledger-pages", 1370],
  ];

  test("each arrival after the first is told the pair has a live writer", () => {
    const held: FileClaim[] = [];
    const seen: string[] = [];
    for (const [owner, issue] of SEQUENCE) {
      const live = new Set(held.map(c => c.owner));
      const hits = contention(held, PAIR, live);
      seen.push(hits.size === 0 ? `${owner}: free` : `${owner}: HELD by ${[...hits.values()][0][0].owner}`);
      // Only the agent told "free" starts work, so only it declares.
      if (hits.size === 0) held.push(claim(owner, PAIR, { issue }));
    }
    expect(seen).toEqual([
      "rg/1351-shell-parity: free",
      "rg/1386-bot-login: HELD by rg/1351-shell-parity",
      "rg/1379-path-resolve: HELD by rg/1351-shell-parity",
      "rg/1369-pagination: HELD by rg/1351-shell-parity",
      "rg/1370-ledger-pages: HELD by rg/1351-shell-parity",
    ]);
    expect(held, "more than one branch was allowed into the pair").toHaveLength(1);
  });

  test("and the queue drains in order as each one merges", () => {
    // The other half. A mechanism that serialises by never letting anybody in
    // satisfies the case above, and this is what tells them apart.
    let held: FileClaim[] = [];
    const order: string[] = [];
    for (const [owner, issue] of SEQUENCE) {
      const live = new Set(held.map(c => c.owner));
      if (contention(held, PAIR, live).size === 0) {
        held.push(claim(owner, PAIR, { issue }));
        order.push(owner);
        held = []; // merged, branch gone, claim released
      }
    }
    expect(order).toEqual(SEQUENCE.map(([o]) => o));
  });

  test("a branch claiming a DIFFERENT file is not blocked by the pair's writer", () => {
    // The population statement, as a case. This serialises the paths that are
    // declared and nothing else; it is not a global lock on the repository.
    const held = [claim("rg/1351-shell-parity", PAIR, { issue: 1351 })];
    const live = new Set(["rg/1351-shell-parity"]);
    expect(contention(held, ["lib/ai-review-rounds.ts"], live).size).toBe(0);
    expect(contention(held, PAIR, live).size).toBe(2);
  });
});

/**
 * Liveness, and the two git-only rules that were wrong before this one.
 *
 * This repository squash-merges and `RUNGATE_BRANCH_CLEANUP` is deliberately
 * unset, so merged refs are never deleted. Any rule that reads a merged
 * branch as live therefore makes its claim IMMORTAL — the registry holds
 * every interesting file on behalf of branches that landed last week, and a
 * lock nobody can release is one people route around.
 *
 * **Rule 1, ancestry.** `git merge-base --is-ancestor` and `git branch -r
 * --no-merged` compare commits, and a squash commit is a new object. Both
 * report every merged branch unmerged forever. `rg/1168-eviction-note` merged
 * at 17:43 on 2026-10-23 and `--no-merged` still listed it.
 *
 * **Rule 2, subjects.** "Every subject the branch carries ahead of the base
 * also appears among the base's subjects." True for a SINGLE-commit pull
 * request, whose squash subject is the commit subject plus ` (#N)`. False for
 * every other one: GitHub's squash subject for a multi-commit branch is the
 * PULL REQUEST TITLE, and the commit subjects go into the squash BODY as `* `
 * bullets, where `git log --format=%s` cannot see them. Read directly off
 * `72e3012361e5`, the squash of the two-commit #1438 — subject
 * `the scratch exemption … not one (#1438)`, and the second commit's subject
 * `use .match, not .exec: …` present only in the body.
 *
 * That rule passed review on a battery of five branches. Four were
 * single-commit and the fifth was open, so not one row could discriminate —
 * the sample had no case the mutation could move. Re-measured against the 15
 * most recently merged pull requests, all of them merged, so `landed=true` is
 * the right answer for all 15:
 *
 * | population                         | rule 2 says landed |
 * |------------------------------------|--------------------|
 * | 11 multi-commit, refs surviving    | 0 of 11            |
 * | 1 single-commit, ref surviving     | 1 of 1             |
 * | 3 single-commit, refs deleted      | not measurable     |
 *
 * **11 of 12 wrong, every one in the fail-open direction.**
 *
 * So liveness is asked of the tracker, where a pull request's state is a fact
 * somebody recorded rather than a shape inferred from a graph squashing has
 * already flattened. The rows below are the five states of
 * {@link ownerState}; each is reachable, and the two UNMEASURED ones are the
 * reason it does not return a boolean.
 */
describe("#1413: liveness comes from the tracker, not from the commit graph", () => {
  const OPEN: PullState[] = [{ number: 1420, state: "OPEN" }];
  const MERGED: PullState[] = [{ number: 1399, state: "MERGED" }];

  test("an open pull request is LIVE, and says which", () => {
    const r = ownerState(OPEN, true, true);
    expect(r.state).toBe("live");
    expect(r.why).toContain("#1420");
  });

  test("a DRAFT pull request is live — gh reports a draft as OPEN", () => {
    expect(ownerState([{ number: 7, state: "OPEN" }], true, true).state).toBe("live");
  });

  test("merged is LANDED even though the branch ref is still on the remote", () => {
    // The whole defect in one row. Both earlier rules answered "live" here,
    // and `refExists: true` is the normal state because refs are never
    // deleted in this project.
    expect(ownerState(MERGED, true, true).state).toBe("landed");
  });

  test("a multi-commit merge is LANDED — the case rule 2 got wrong 11 times", () => {
    // #1438: two commits, squash subject is the PR title, so neither commit
    // subject appears in `git log --format=%s origin/main`. The tracker does
    // not care how many commits there were.
    expect(ownerState([{ number: 1438, state: "MERGED" }], true, true).state).toBe("landed");
  });

  test("a CLOSED pull request is landed too — nobody is writing either way", () => {
    expect(ownerState([{ number: 9, state: "CLOSED" }], true, true).state).toBe("landed");
  });

  test("one open among several closed keeps the owner live", () => {
    const r = ownerState(
      [{ number: 9, state: "CLOSED" }, { number: 10, state: "OPEN" }, { number: 11, state: "MERGED" }],
      true,
      true,
    );
    expect(r.state).toBe("live");
    expect(r.why).toContain("#10");
  });

  test("pushed with no pull request yet is LIVE — the earliest moment a claim matters", () => {
    expect(ownerState([], true, true).state).toBe("live");
  });

  test("no pull request and no ref, refs refreshed, is LANDED", () => {
    expect(ownerState([], false, true).state).toBe("landed");
  });

  test("no pull request and no ref WITHOUT a refresh is UNMEASURED, never landed", () => {
    // A branch nobody fetched and a branch somebody deleted look identical.
    const r = ownerState([], false, false);
    expect(r.state).toBe("unmeasured");
    expect(r.why).toContain("refreshed");
  });

  test("an unread tracker is UNMEASURED, and is not an empty one", () => {
    // `null` vs `[]`. If these collapsed, a `gh` outage would report every
    // claimed file free — the one fail-open this mechanism must not have.
    expect(ownerState(null, true, true).state).toBe("unmeasured");
    expect(ownerState(null, false, true).state).toBe("unmeasured");
    expect(ownerState([], true, true).state).not.toBe("unmeasured");
  });

  test("CONTROL: refExists only decides when the tracker reports no pull request", () => {
    // If the ref reading leaked into the pull-request cases, the merged row
    // above would answer live again and the fix would be inert.
    for (const refExists of [true, false]) {
      for (const refreshed of [true, false]) {
        expect(ownerState(OPEN, refExists, refreshed).state).toBe("live");
        expect(ownerState(MERGED, refExists, refreshed).state).toBe("landed");
      }
    }
  });
});

describe("#1413: the repository is parsed from origin, never assumed", () => {
  test("both GitHub remote spellings resolve to the same slug", () => {
    expect(repoSlug("git@github.com:hornjason/pai-harness.git")).toBe("hornjason/pai-harness");
    expect(repoSlug("https://github.com/hornjason/pai-harness.git")).toBe("hornjason/pai-harness");
    expect(repoSlug("https://github.com/hornjason/pai-harness")).toBe("hornjason/pai-harness");
    expect(repoSlug("https://github.com/hornjason/pai-harness/\n")).toBe("hornjason/pai-harness");
  });

  test("ssh:// and a bare git@ host both resolve", () => {
    expect(repoSlug("ssh://git@github.com/hornjason/pai-harness.git")).toBe("hornjason/pai-harness");
    expect(repoSlug("github.com:hornjason/pai-harness.git")).toBe("hornjason/pai-harness");
  });

  test("a non-GitHub remote is null, not a guess", () => {
    // A slug guessed off the wrong host would make `gh` answer "no pull
    // request" with total confidence, which reads as landed.
    expect(repoSlug("https://gitlab.com/x/y.git")).toBeNull();
    expect(repoSlug("/Users/jhorn/Projects/some-local-clone")).toBeNull();
    expect(repoSlug("")).toBeNull();
    expect(repoSlug("   ")).toBeNull();
  });

  /**
   * The host is COMPARED, not pattern-matched.
   *
   * Raised by a push review on PR #1436. The first version of `repoSlug`
   * was unanchored, so `github.com` anywhere in the URL satisfied it. The
   * slug is the key a file claim is recorded and released under, so two
   * remotes resolving to one slug is two projects sharing a lock namespace
   * — a lock released on a key its holder never took.
   *
   * The two rows that ALREADY returned null are here on purpose. Without
   * them a later rewrite can lose that behaviour silently, which is the
   * same reason `test/census-routing.test.ts` keeps its non-firing paths.
   */
  test.each([
    ["https://gitlab.com/github.com/org/repo.git", "a github.com PATH SEGMENT on another host"],
    ["https://mygithub.com/org/repo.git", "a host whose name merely ends in github.com"],
    ["https://github.com@evil.com/org/repo.git", "github.com as USERINFO, not the host"],
    ["https://github.com./org/repo.git", "a trailing dot makes it a different host"],
    ["git@gitlab.com:org/repo.git", "the scp-like form on another host"],
    ["https://notgithub.com/org/repo.git", "a host with github.com as a suffix of one label"],
  ])("%s is null — %s", url => {
    expect(repoSlug(url)).toBeNull();
  });
});

/**
 * The writer cannot produce a store the reader refuses.
 *
 * Raised by the AI review on PR #1436. `--claim` built an entry and wrote it
 * with no validation, so `--claim /etc/passwd` would have written an absolute
 * path — and since one bad entry refuses the WHOLE store, that single
 * careless claim makes every path read UNMEASURED for every other session.
 * The writer could brick the lock for everybody.
 *
 * Driven through the real script rather than the helper, because the defect
 * was in the path from argv to disk and a case calling `writeStore` directly
 * would not have covered the thing that was wrong.
 */
describe("#1413: --claim refuses to write a registry the reader cannot read", () => {
  const run = (dir: string, ...args: string[]) =>
    spawnSync("bun", [join(REPO, "scripts", "claim-files.ts"), "--project", dir, ...args], {
      encoding: "utf-8",
    });

  test("an absolute path is refused and NOTHING is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg1413-"));
    try {
      mkdirSync(join(dir, "specs"));
      const r = run(dir, "--claim", "/etc/passwd", "--owner", "rg/x");
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stdout).toContain("refusing to write");
      expect(
        existsSync(join(dir, FILE_CLAIMS_PATH)),
        "a refused claim left a registry behind anyway",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path escaping the repository is refused the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg1413-"));
    try {
      mkdirSync(join(dir, "specs"));
      const r = run(dir, "--claim", "../elsewhere/x.ts", "--owner", "rg/x");
      expect(r.status).not.toBe(0);
      expect(existsSync(join(dir, FILE_CLAIMS_PATH))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: an ordinary claim IS written, and reads back", () => {
    // Without this the two rows above are satisfied by a `--claim` that
    // refuses everything, which is a lock nobody can take.
    const dir = mkdtempSync(join(tmpdir(), "rg1413-"));
    try {
      mkdirSync(join(dir, "specs"));
      const r = run(dir, "--claim", "lib/a.ts", "--owner", "rg/x", "--issue", "1413");
      expect(r.status, r.stdout).toBe(0);
      const back = readFileClaims(readFileSync(join(dir, FILE_CLAIMS_PATH), "utf-8"));
      expect(back.status).toBe("read");
      expect(back.claims).toEqual([{ owner: "rg/x", paths: ["lib/a.ts"], issue: 1413 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a second claim by the same owner REPLACES the first", () => {
    // The registry is a set of owners, not an append log. Two rows for one
    // branch would both have to be released, and the second release would
    // find nothing.
    const dir = mkdtempSync(join(tmpdir(), "rg1413-"));
    try {
      mkdirSync(join(dir, "specs"));
      run(dir, "--claim", "lib/a.ts", "--owner", "rg/x");
      run(dir, "--claim", "lib/b.ts", "--owner", "rg/x");
      const back = readFileClaims(readFileSync(join(dir, FILE_CLAIMS_PATH), "utf-8"));
      if (back.status !== "read") throw new Error(back.reason);
      expect(back.claims).toHaveLength(1);
      expect(back.claims[0].paths).toEqual(["lib/b.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * An owner whose ref this worktree has never seen must not read as free.
 *
 * Raised as CRITICAL by the AI review on PR #1436, round 2. `origin/<owner>`
 * is a local remote-tracking ref, and the first version fetched only the
 * default branch — so a peer's branch this worktree had never fetched failed
 * `rev-parse` and fell straight through to "ref gone: holds nothing". A
 * fresh worktree has fetched almost nothing, and a fresh worktree is exactly
 * the state an agent is in when it asks the question, so the common case
 * reported FREE on a file somebody was actively writing.
 *
 * A branch nobody fetched and a branch somebody deleted look identical from
 * here. Only one of them is safe to call free, so without a refresh the
 * answer is UNMEASURED and `--check` refuses.
 */
describe("#1413: an owner this worktree cannot resolve is UNMEASURED, never free", () => {
  /** A repo with a registry on a local branch, and no remote at all. */
  function fixture(claims: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), "rg1413-live-"));
    const g = (...a: string[]) =>
      spawnSync("git", ["-C", dir, ...a], {
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
    g("init", "-q", "-b", "trunk", ".");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    mkdirSync(join(dir, "specs"));
    writeFileSync(
      join(dir, FILE_CLAIMS_PATH),
      `${JSON.stringify({ [FILE_CLAIMS_CONTROL_KEY]: claims }, null, 2)}\n`,
    );
    g("add", "-A");
    g("commit", "-q", "-m", "registry");
    return dir;
  }

  const check = (dir: string, ...args: string[]) =>
    spawnSync(
      "bun",
      [join(REPO, "scripts", "claim-files.ts"), "--project", dir, "--ref", "trunk", ...args],
      { encoding: "utf-8" },
    );

  test("--check REFUSES when the claimed owner's ref is not in this worktree", () => {
    const dir = fixture([{ owner: "rg/never-fetched", paths: ["lib/a.ts"], issue: 1413 }]);
    try {
      const r = check(dir, "--check", "lib/a.ts", "--no-fetch");
      expect(r.stdout, "a claim on an unresolvable owner reported free").toContain("UNMEASURED");
      expect(r.stdout).toContain("rg/never-fetched");
      expect(r.status, "an unmeasured owner exited 0, which reads as free").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--list marks it `?`, not DEAD", () => {
    // DEAD invites the next agent to prune a live lock, and the prune is the
    // irreversible half.
    const dir = fixture([{ owner: "rg/never-fetched", paths: ["lib/a.ts"] }]);
    try {
      const r = check(dir, "--list", "--no-fetch");
      expect(r.stdout).toContain("?");
      expect(r.stdout, "an unresolvable owner was reported DEAD").not.toContain("DEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a path no claim covers is still free in the same repo", () => {
    // The discrimination. A `--check` that refused everything would pass both
    // rows above and be useless, and this is what tells them apart.
    const dir = fixture([{ owner: "rg/never-fetched", paths: ["lib/a.ts"] }]);
    try {
      const r = check(dir, "--check", "lib/elsewhere.ts", "--no-fetch");
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain("free");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: an empty registry in the same repo reads free, not UNMEASURED", () => {
    const dir = fixture([]);
    try {
      const r = check(dir, "--check", "lib/a.ts", "--no-fetch");
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain("free");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A ref that does not resolve is not a ref with no registry on it.
   *
   * Raised as HIGH by the AI review on PR #1436 — the fourth finding on that
   * pull request and the fourth in the fail-open direction. `readFromRemote`
   * classified `git show`'s failure by its MESSAGE, and treated `unknown
   * revision` and `invalid object name` as "the path is not on that ref".
   * Those two mean the REF did not resolve. Measured before the fix:
   *
   *     $ claim-files --check lib/file-claims.ts --ref origin/no-such-ref
   *     free: there is no registry at specs/file-claims.json … yet
   *     exit=0
   *
   * So a typo in `--ref`, or an `origin/main` this worktree had never
   * fetched, reported every path free. The ref is now resolved on its own,
   * which also takes the question off git's wording: what remains to
   * classify is only about the path.
   */
  const refCheck = (dir: string, ref: string) =>
    spawnSync(
      "bun",
      [join(REPO, "scripts", "claim-files.ts"), "--project", dir, "--ref", ref, "--check", "lib/a.ts", "--no-fetch"],
      { encoding: "utf-8" },
    );

  test("a ref that does not resolve is UNMEASURED, never an absent registry", () => {
    const dir = fixture([{ owner: "rg/x", paths: ["lib/a.ts"] }]);
    try {
      const r = refCheck(dir, "no-such-ref-at-all");
      expect(r.stdout, "an unresolvable ref reported the registry absent, which reads free").toContain("UNMEASURED");
      expect(r.stdout).toContain("does not resolve");
      expect(r.status, "exited 0 on a ref it could not read").not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CONTROL: a ref that DOES resolve but carries no registry is free", () => {
    // The discrimination, and the row that stops the fix from becoming "every
    // reading refuses". `trunk~` here is the repository's root commit, which
    // predates `specs/file-claims.json` — a resolvable ref with the file
    // genuinely absent, which is the one case that may read free.
    const dir = mkdtempSync(join(tmpdir(), "rg1413-refctl-"));
    try {
      const g = (...a: string[]) =>
        spawnSync("git", ["-C", dir, ...a], {
          encoding: "utf-8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
      g("init", "-q", "-b", "trunk", ".");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "README.md"), "before the registry existed\n");
      g("add", "-A");
      g("commit", "-q", "-m", "no registry yet");

      const r = refCheck(dir, "trunk");
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain("there is no registry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The class, closed once, instead of five patches to five call sites.
 *
 * The AI review on PR #1436 made this point three times — rounds 5, 6 and 7
 * — and it was right: every round found a new instance of ONE shape, a git
 * or `gh` lookup that could not be resolved defaulting to the safe-looking
 * answer, and each was fixed where it was caught. Five instances: the
 * owner-ref fetch scope, the `writeStore` round trip, the base-ref
 * resolution, the `repoSlug` host anchoring, and `defaultBranch` silently
 * returning "main".
 *
 * So the list of lookups is an EXECUTED census rather than a paragraph. A
 * tenth lookup added later has to join it or redden this row, which is the
 * difference between closing a class and patching its instances.
 *
 * It is a census of the SOURCE because the alternative — one behavioural
 * row per lookup — is what the previous seven rounds already were, and they
 * did not stop the eighth being written. This asks the question the author
 * of the eighth will not think to ask.
 */
describe("#1413: no lookup in claim-files.ts may default to the safe-looking answer", () => {
  const SCRIPT = readFileSync(join(REPO, "scripts", "claim-files.ts"), "utf-8");

  /** Every `git(...)`/`spawnSync` lookup in the file, and its refusal. */
  const LOOKUPS = [
    "defaultBranch",
    "repoSlug",
    "refreshRefs",
    "pullsForBranch",
    "readFromRemote",
    "readLocal",
    "writeStore",
  ] as const;

  test("the audit table names every lookup the file performs", () => {
    // The table is in the file header. If a reader cannot find a lookup in
    // it, the table has stopped being the audit it claims to be.
    for (const name of LOOKUPS) {
      expect(SCRIPT, `the header audit table does not mention ${name}`).toContain(name);
    }
  });

  test("the file starts no process this census does not cover", () => {
    // The census's own population check. Counting the call sites rather than
    // trusting the list: a lookup added through a new `spawnSync` is exactly
    // the case the previous seven rounds missed, and a list nobody bounds is
    // a list that silently stops being complete.
    const spawns = [...SCRIPT.matchAll(/\bspawnSync\(/g)].length;
    expect(
      spawns,
      `claim-files.ts now makes ${spawns} spawnSync calls; the audit table in its header covers 4 ` +
        "(git, gh, git show, rev-parse). Add the new one to the table and to LOOKUPS here, " +
        "and say what it does when it cannot resolve.",
    ).toBe(4);
  });

  test("defaultBranch refuses rather than assuming main", () => {
    // The fifth instance, and the one that proves the audit was not
    // retrospective decoration: it was found by the review at round 7 and
    // fixed as part of writing this census.
    expect(SCRIPT).toContain("origin/HEAD is not set in this tree");
    expect(SCRIPT, "defaultBranch still falls back to a literal main").not.toMatch(
      /return\s+["']main["']\s*;/,
    );
  });

  test("CONTROL: the census can fail — a literal main fallback is detectable", () => {
    // Names what the row above can show. Without this, `not.toMatch` on a
    // pattern that never appears in any version of the file would be green
    // by construction — the seventh shape in checks-must-be-able-to-fail.md.
    const mutated = SCRIPT.replace(
      "  return r.ok && r.out !== \"\" ? r.out.replace(\"refs/remotes/origin/\", \"\") : null;",
      "  return 'main';",
    );
    expect(mutated, "the anchor the mutant replaces is no longer in the file").not.toBe(SCRIPT);
    expect(mutated).toMatch(/return\s+["']main["']\s*;/);
  });
});

describe("#1413: the registry committed in this repository is readable", () => {
  test("specs/file-claims.json parses and every entry is usable", () => {
    // The instrument, pointed at the real artifact. A registry that ships
    // unreadable reports every path UNMEASURED and gets ignored within a day.
    const raw = readFileSync(join(REPO, FILE_CLAIMS_PATH), "utf-8");
    const r = readFileClaims(raw, FILE_CLAIMS_PATH);
    expect(r.status, `the committed registry is ${r.status}: ${r.reason ?? ""}`).toBe("read");
  });

  test("every claimed path exists, or is a directory prefix that does", () => {
    // A claim on a path that was renamed away locks nothing and reads as
    // coverage, which is the `every routed test exists on disk` lesson from
    // test/census-routing.test.ts applied to this registry.
    const r = readFileClaims(readFileSync(join(REPO, FILE_CLAIMS_PATH), "utf-8"), FILE_CLAIMS_PATH);
    if (r.status !== "read") throw new Error(`registry unreadable: ${r.reason}`);
    const missing: string[] = [];
    for (const c of r.claims) {
      // `existsSync`, not a size check: a zero-byte file is a path this tree
      // has, and reporting it missing would send someone hunting a rename
      // that never happened.
      for (const p of c.paths) if (!existsSync(join(REPO, p))) missing.push(`${c.owner}: ${p}`);
    }
    expect(missing, "a claim names a path this tree does not have").toEqual([]);
  });

  test("CONTROL: the case above can see a path that is not there", () => {
    // Otherwise an empty `missing` means "the registry is clean" and "the
    // check looked at nothing" equally well.
    expect(existsSync(join(REPO, "lib/scaffold/ai-review-step.ts"))).toBe(true);
    expect(existsSync(join(REPO, "lib/scaffold/renamed-away.ts"))).toBe(false);
  });
});
