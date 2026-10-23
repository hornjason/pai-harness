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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  FILE_CLAIMS_CONTROL_KEY,
  FILE_CLAIMS_PATH,
  allClaims,
  claimCovers,
  contention,
  isLandedBySubject,
  liveClaims,
  readFileClaims,
  type FileClaim,
} from "../lib/file-claims";

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
 * Liveness, and why ancestry is the wrong instrument for it.
 *
 * This repository squash-merges and `RUNGATE_BRANCH_CLEANUP` is deliberately
 * unset, so merged refs are never deleted. Under an ancestry rule no claim
 * would ever die and the registry would hold every interesting file on behalf
 * of branches that landed last week.
 *
 * Measured against five real branches before this rule was written, with
 * `git branch -r --no-merged origin/main` as the control:
 *
 * | branch                       | subject rule | `--no-merged` | truth  |
 * |------------------------------|--------------|---------------|--------|
 * | `rg/1168-eviction-note`      | LANDED       | live          | merged |
 * | `rg/1426-dochygiene-witness` | LANDED       | live          | merged |
 * | `rg/1405-window-writer`      | LIVE         | live          | open   |
 * | `rg/1406-anchor-absent`      | LIVE         | live          | open   |
 * | `rg/1401-census-generated`   | LIVE         | live          | open   |
 *
 * 5 of 5 against 3 of 5. The control is not merely less precise — it is
 * wrong in the one direction that matters, because a rule that never says
 * LANDED is a lock nobody can ever release.
 */
describe("#1413: a landed branch is told apart from a live one by SUBJECT", () => {
  const BASE = [
    "fix(#1394): the eviction note says how many went (#1399)",
    "feat(#713): migrate seven PRODUCT-classified hooks (#1118)",
    "chore: unrelated",
  ];

  test("a squash-merged subject is found inside the base's `(#N)` form", () => {
    expect(isLandedBySubject(["fix(#1394): the eviction note says how many went"], BASE)).toBe(true);
  });

  test("a branch the base has never seen is LIVE", () => {
    expect(isLandedBySubject(["feat(#1405): the ledger writes its window count"], BASE)).toBe(false);
  });

  test("EVERY subject must be found — one unlanded commit keeps the branch live", () => {
    // The `.some`/`.every` inversion is the bug this row exists for. A branch
    // that was merged and then pushed to is still being written.
    expect(
      isLandedBySubject(
        ["fix(#1394): the eviction note says how many went", "fixup: one more thing"],
        BASE,
      ),
    ).toBe(false);
  });

  test("a branch with nothing ahead has landed, vacuously", () => {
    expect(isLandedBySubject([], BASE)).toBe(true);
    expect(isLandedBySubject(["", "   "], BASE)).toBe(true);
  });

  test("an EMPTY base reads LIVE, never landed", () => {
    // The fail-closed direction. A `git log` that returned nothing would
    // otherwise release every claim in the registry at once.
    expect(isLandedBySubject(["anything at all"], [])).toBe(false);
  });

  test("CONTROL: the containment is a substring test, not an equality one", () => {
    // If it were equality, row 1 would be false and every squash merge would
    // read live — which is precisely the defect being fixed.
    expect(BASE).not.toContain("fix(#1394): the eviction note says how many went");
    expect(isLandedBySubject(["fix(#1394): the eviction note says how many went"], BASE)).toBe(true);
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
