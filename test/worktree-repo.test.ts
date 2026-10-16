/**
 * #218 — an isolated agent resolves its repo from ambient cwd.
 *
 * Covers SC-1441, SC-1442, SC-1443, SC-1444, SC-1445, SC-1446
 * (HARNESS-STANDARD.md).
 *
 * On run `wf_5e3ed885-98c` (`projectRoot: …/rungate`, `repo:
 * hornjason/pai-harness`) the first Marcus got a worktree under
 * `…/rungate/.claude/worktrees/` and the remediation Marcus got one under
 * `…/DailyBriefDashboard/.claude/worktrees/` — a checkout of
 * `hornjason/asaCommandCenter`. The operator had changed directory mid-run,
 * and `isolation: "worktree"` is resolved by the agent runtime against the
 * session's cwd rather than the workflow's `projectRoot`.
 *
 * The agent refused and named the reason, which is the only thing that made
 * this a near miss rather than rungate's changes being committed into a
 * consumer repository. **The harness did nothing with that refusal**: the
 * Verify BUILD-regression branch read `if (reimpl.success)` with no `else`,
 * so a remediation that performed no work was indistinguishable from one that
 * was never attempted, and the run advanced to rook-scope and rook.
 *
 * ## Why the fix is a reading and not a better derivation
 *
 * `workflows/ship.js` has pinned `opts.cwd = PROJECT_ROOT` for every isolated
 * spawn since 2026-09-23 — three weeks BEFORE this incident. The pin did not
 * hold. A path-prefix check would answer "is this under the directory I
 * expected", which is the question whose answer already drifted. The remote
 * slug is a fact about the checkout, read from the checkout, compared against
 * the identity the run was handed.
 *
 * ## What is executed here, and what is not
 *
 * `readWorktreeRemote` runs against real `git init` fixtures in a temp
 * directory, because a reader asserted only against stubs is a reader nobody
 * has watched read anything. The pure decision runs over a shared matrix in
 * BOTH copies — the library and ship.js's inlined block — since the Workflow
 * sandbox cannot import (#69) and an extracted function that never matched
 * its inlined copy is how `computeACHash` drifted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { assertMarkedBlockReachable } from "../lib/reachability";
import {
  readWorktreeRemote,
  redactRemote,
  repoSlug,
  worktreeIdentity,
  worktreeIdentityViolations,
} from "../lib/worktree-repo";

const REPO_ROOT = join(import.meta.dir, "..");
const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

function sliceBlock(name: string): string {
  const start = shipSource.indexOf(`// ──── ${name}-START ────`);
  const end = shipSource.indexOf(`// ──── ${name}-END ────`);
  if (start < 0 || end < 0) throw new Error(`${name} markers missing from workflows/ship.js`);
  return shipSource.slice(start, end);
}

/**
 * ship.js's inlined copy of the decision.
 *
 * `new Function` over an interpolated body is a code-injection shape and a
 * scanner will flag it. The interpolated value is this repository's own
 * `workflows/ship.js`, read off disk at test time — the same trust boundary
 * as importing it, which the Workflow sandbox makes impossible (#69). It must
 * never be given a source from anywhere else.
 */
const shipBlock = new Function(
  `${sliceBlock("WORKTREE-IDENTITY")}\nreturn { repoSlug, redactRemote, worktreeIdentity, worktreeIdentityViolations, worktreeRecords }`,
)() as {
  repoSlug: typeof repoSlug;
  redactRemote: typeof redactRemote;
  worktreeIdentity: typeof worktreeIdentity;
  worktreeIdentityViolations: typeof worktreeIdentityViolations;
  /** ship.js only — the agent results reshaped for the #414 gate. The library
   *  has no counterpart because nothing outside the workflow produces them. */
  worktreeRecords: (r: unknown) => Array<{ path: string; reportedRepo?: string }>;
};

const { worktreeRecords } = shipBlock;

/** The mirrored surface, which `worktreeRecords` is deliberately not part of. */
const inlined = {
  repoSlug: shipBlock.repoSlug,
  redactRemote: shipBlock.redactRemote,
  worktreeIdentity: shipBlock.worktreeIdentity,
  worktreeIdentityViolations: shipBlock.worktreeIdentityViolations,
};

const COPIES: Array<[string, typeof inlined]> = [
  ["lib/worktree-repo.ts", { repoSlug, redactRemote, worktreeIdentity, worktreeIdentityViolations }],
  ["workflows/ship.js (inlined)", inlined],
];

// ── SC-1441: the slug ────────────────────────────────────────

const SLUGS: Array<[string, string | null]> = [
  ["git@github.com:hornjason/pai-harness.git", "hornjason/pai-harness"],
  ["git@github.com:hornjason/pai-harness", "hornjason/pai-harness"],
  ["https://github.com/hornjason/pai-harness.git", "hornjason/pai-harness"],
  ["https://github.com/hornjason/pai-harness", "hornjason/pai-harness"],
  ["https://github.com/hornjason/pai-harness/", "hornjason/pai-harness"],
  ["https://github.com/hornjason/pai-harness.git/", "hornjason/pai-harness"],
  // The form a CI checkout leaves behind. The credential is in the authority,
  // and a parser that took the first two path segments would read it as the
  // owner.
  ["https://x-access-token:SECRET@github.com/hornjason/pai-harness.git", "hornjason/pai-harness"],
  // The spoofing path, and the reason this is EXACTLY two segments rather
  // than the last two. git reads this path as the repository
  // `evil/repo/hornjason/pai-harness`; a tail-taking parser reads it as
  // `hornjason/pai-harness` and reports a MATCH. The string comes from an
  // agent reply, so a parser that can be talked into agreeing IS the guard.
  ["https://github.com/evil/repo/hornjason/pai-harness.git", null],
  // The cost of that choice, stated: a self-hosted layout with a group
  // prefix is unreadable rather than wrong. It lands in the `unreadable`
  // refusal, which names the string — loud, which is the direction a check
  // should be wrong in.
  ["https://git.example.com/eng/tools/hornjason/pai-harness.git", null],
  ["git@git.example.com:eng/tools/hornjason/pai-harness.git", null],
  // GitHub slugs are case-insensitive; a clone URL need not match the
  // canonical casing, and a case-sensitive compare would refuse a correct
  // worktree. That refusal is worse than it sounds: it fires on the run that
  // is doing the right thing.
  ["git@github.com:HornJason/PAI-Harness.git", "hornjason/pai-harness"],
  // The run's own `repo` argument arrives as a bare slug.
  ["hornjason/pai-harness", "hornjason/pai-harness"],
  ["asaCommandCenter", null],
  ["", null],
  ["   ", null],
  ["https://github.com/", null],
  ["not a url at all", null],
];

describe("SC-1441: a remote URL becomes owner/name or nothing", () => {
  for (const [copy, api] of COPIES) {
    for (const [input, want] of SLUGS) {
      test(`${copy}: ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
        expect(api.repoSlug(input)).toBe(want);
      });
    }
  }

  test("a non-string is null rather than a throw", () => {
    // This runs on a value an agent reported, so the inputs include whatever
    // a model decided to put in the field. A throw here would be a refusal
    // the caller's error handling turns back into a pass.
    for (const [, api] of COPIES) {
      for (const bad of [null, undefined, 42, {}, []] as unknown[]) {
        expect(api.repoSlug(bad as string)).toBeNull();
      }
    }
  });
});

// ── SC-1447: a refusal does not log a credential ─────────────

const WT = "/Users/jhorn/Projects/DailyBriefDashboard/.claude/worktrees/wf_5e3ed885-98c-12";
const RIGHT = "/Users/jhorn/Projects/rungate/.claude/worktrees/wf_5e3ed885-98c-9";
const RUN_REPO = "hornjason/pai-harness";

/**
 * Deliberately NOT shaped like a real key.
 *
 * The pre-commit scan matches `ghp_[A-Za-z0-9]{36}` on added lines and
 * refused this file when the fixture looked the part — correctly, and the
 * right way round: a hook that waved through "it's only a test" would be the
 * exemption that eventually waves through a real one.
 */
const SECRET = "NOT-A-REAL-TOKEN-0123456789";

describe("SC-1447: a quoted remote has its credential blanked", () => {
  for (const [copy, api] of COPIES) {
    test(`${copy}: the authority's credential never survives into the text`, () => {
      const forms = [
        `https://x-access-token:${SECRET}@github.com/owner/name/extra`,
        `https://user:${SECRET}@git.example.com/a/b/c`,
        `git@github.com:${SECRET}@owner/name/extra`,
      ];
      for (const url of forms) {
        expect(api.redactRemote(url), url).not.toContain(SECRET);
        expect(api.redactRemote(url)).toContain("<redacted>");
      }
    });

    test(`${copy}: a refusal that quotes an unreadable remote is redacted`, () => {
      // The reachable path, not just the helper. A refusal is LOGGED, and a
      // live token in a run log gets read, pasted into an issue, and kept.
      const got = api.worktreeIdentity(
        RIGHT,
        RUN_REPO,
        `https://x-access-token:${SECRET}@github.com/evil/repo/owner/name`,
      );
      expect(got.verdict).toBe("unreadable");
      expect(got.refusal, "the refusal logged the token verbatim").not.toContain(SECRET);
      expect(got.refusal).toContain("<redacted>");
    });

    test(`${copy}: a credential outside the authority is blanked too`, () => {
      // The push security review called the authority-only version
      // incomplete sanitisation, and it was right: these strings reach the
      // redactor BECAUSE they could not be parsed, so they are exactly the
      // ones not in the well-formed shape the first rule assumes.
      const forms = [
        `https://github.com/owner/name?access_token=${SECRET}`,
        `https://github.com/owner/name?a=1&private_token=${SECRET}&b=2`,
        `https://github.com/owner/name?AUTH_KEY=${SECRET}`,
        `ghp_${"a".repeat(36)}`,
        `https://github.com/owner/ghp_${"b".repeat(36)}`,
      ];
      for (const url of forms) {
        const out = api.redactRemote(url);
        expect(out, url).toContain("<redacted>");
        expect(out, url).not.toContain(SECRET);
        expect(out, url).not.toMatch(/ghp_[A-Za-z0-9]{16,}/);
      }
    });

    test(`${copy}: a remote with no credential is left exactly as it was`, () => {
      // The control. A redactor that mangled every URL would satisfy both
      // cases above and make every refusal unreadable.
      for (const url of [
        "git@github.com:owner/name.git",
        "https://github.com/owner/name",
        "/a/local/path",
        "",
      ]) {
        expect(api.redactRemote(url)).toBe(url);
      }
    });
  }
});

// ── SC-1442: the four verdicts ───────────────────────────────

describe("SC-1442: the identity verdict, and every refusal names both sides", () => {
  for (const [copy, api] of COPIES) {
    test(`${copy}: the matching worktree is accepted`, () => {
      const got = api.worktreeIdentity(RIGHT, RUN_REPO, "git@github.com:hornjason/pai-harness.git");
      expect(got.verdict).toBe("match");
      expect(got.refusal).toBeNull();
    });

    test(`${copy}: wf_5e3ed885-98c replayed - the other project's worktree is refused`, () => {
      const got = api.worktreeIdentity(WT, RUN_REPO, "git@github.com:hornjason/asaCommandCenter.git");
      expect(got.verdict).toBe("mismatch");
      expect(got.actual).toBe("hornjason/asacommandcenter");
      expect(got.expected).toBe(RUN_REPO);
      // Both sides, or an operator has to go to the transcript — which is
      // exactly what made this incident expensive to understand.
      expect(got.refusal).toContain("hornjason/asacommandcenter");
      expect(got.refusal).toContain(RUN_REPO);
      expect(got.refusal).toContain(WT);
      expect(got.refusal).toContain("#218");
    });

    test(`${copy}: a worktree that reported no remote is refused`, () => {
      const got = api.worktreeIdentity(RIGHT, RUN_REPO, undefined);
      expect(got.verdict).toBe("unreported");
      expect(got.refusal).toContain("no origin remote");
    });

    test(`${copy}: an unparseable remote is refused and quotes what it got`, () => {
      const got = api.worktreeIdentity(RIGHT, RUN_REPO, "asaCommandCenter");
      expect(got.verdict).toBe("unreadable");
      expect(got.refusal).toContain("asaCommandCenter");
    });

    test(`${copy}: the no-repo refusal redacts whatever was passed instead`, () => {
      // This branch fires precisely when `repo` was NOT a bare slug, so
      // "whatever was passed instead" is exactly the value most likely to
      // be a URL with a credential in it.
      const got = api.worktreeIdentity(RIGHT, `https://user:${SECRET}@host/a/b/c`, "git@github.com:a/b.git");
      expect(got.verdict).toBe("unreported");
      expect(got.refusal, "the run's own repo argument was logged verbatim").not.toContain(SECRET);
    });

    test(`${copy}: a run with no repo of its own refuses rather than passing`, () => {
      // The fail-open that would matter most. With no expected slug there is
      // nothing to compare, and returning "match" would make the guard
      // silently inert for exactly the misconfigured run most likely to need
      // it — shape 1 of .claude/rules/checks-must-be-able-to-fail.md.
      for (const missing of [undefined, null, "", "   ", "garbage"]) {
        const got = api.worktreeIdentity(RIGHT, missing as string, "git@github.com:hornjason/pai-harness.git");
        expect(got.verdict, JSON.stringify(missing)).toBe("unreported");
        expect(got.refusal).toContain("did not state a repository");
      }
    });

    test(`${copy}: the four refusals are distinguishable from one another`, () => {
      // Three checks that each pass against one generic string is the vacuous
      // assertion .claude/rules/checks-must-be-able-to-fail.md names (#300).
      const refusals = [
        api.worktreeIdentity(WT, RUN_REPO, "git@github.com:a/b.git").refusal,
        api.worktreeIdentity(WT, RUN_REPO, undefined).refusal,
        api.worktreeIdentity(WT, RUN_REPO, "nonsense").refusal,
        api.worktreeIdentity(WT, "", "git@github.com:a/b.git").refusal,
      ];
      expect(refusals.every(r => typeof r === "string" && r.length > 0)).toBe(true);
      expect(new Set(refusals).size, "two refusal kinds read identically").toBe(4);
    });
  }
});

// ── SC-1443: the list helper ─────────────────────────────────

describe("SC-1443: a run's reports become refusals in order", () => {
  for (const [copy, api] of COPIES) {
    test(`${copy}: a pathless row is skipped - a non-isolated spawn has no worktree`, () => {
      // Refusing these would fire the guard on every non-isolated agent in
      // the run, which is how a correct guard gets reverted.
      expect(api.worktreeIdentityViolations([{ worktreePath: "" }, {}, { worktreePath: "  " }], RUN_REPO))
        .toEqual([]);
    });

    test(`${copy}: requirePath refuses the same rows - the bypass closed`, () => {
      // The default above is a bypass wherever the caller is about to ACT on
      // the rows: omit one field and the guard never runs. Callers at a
      // collection boundary opt in.
      const rows = [{ worktreePath: "" }, {}, { filesChanged: ["lib/a.ts"] }];
      const out = api.worktreeIdentityViolations(rows, RUN_REPO, { requirePath: true });
      expect(out, "a pathless row still skipped the check").toHaveLength(3);
      for (const r of out) expect(r).toContain("(no path reported)");
    });

    test(`${copy}: requirePath does not refuse a row that is fine`, () => {
      // The control. Without it, the case above is satisfied by an option
      // that refuses everything.
      expect(
        api.worktreeIdentityViolations(
          [{ worktreePath: RIGHT, worktreeRepo: "git@github.com:hornjason/pai-harness.git" }],
          RUN_REPO,
          { requirePath: true },
        ),
      ).toEqual([]);
    });

    test(`${copy}: a row with a path and no remote IS refused`, () => {
      // The other half of the rule above, and the distinction that matters:
      // "never asked" and "asked and did not answer" are different states.
      const out = api.worktreeIdentityViolations([{ worktreePath: RIGHT }], RUN_REPO);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain("no origin remote");
    });

    test(`${copy}: the good rows in a mixed run produce nothing`, () => {
      const out = api.worktreeIdentityViolations(
        [
          { worktreePath: RIGHT, worktreeRepo: "git@github.com:hornjason/pai-harness.git" },
          { worktreePath: WT, worktreeRepo: "git@github.com:hornjason/asaCommandCenter.git" },
          { worktreePath: `${RIGHT}-2`, worktreeRepo: "https://github.com/hornjason/pai-harness" },
        ],
        RUN_REPO,
      );
      expect(out, "a correct worktree was refused, or the wrong one was not").toHaveLength(1);
      expect(out[0]).toContain("asacommandcenter");
    });

    test(`${copy}: a non-array is empty rather than a throw`, () => {
      for (const bad of [null, undefined, "x", 7, {}] as unknown[]) {
        expect(api.worktreeIdentityViolations(bad as never, RUN_REPO)).toEqual([]);
      }
    });
  }
});

// ── SC-1444: the reader, executed against real checkouts ─────

describe("SC-1444: readWorktreeRemote reads a real checkout", () => {
  let dir = "";
  let withOrigin = "";
  let noOrigin = "";
  let notARepo = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rungate-wt-repo-"));
    withOrigin = join(dir, "with-origin");
    noOrigin = join(dir, "no-origin");
    notARepo = join(dir, "not-a-repo");
    for (const d of [withOrigin, noOrigin, notARepo]) {
      execFileSync("mkdir", ["-p", d]);
    }
    writeFileSync(join(notARepo, "file.txt"), "not a checkout\n");
    for (const d of [withOrigin, noOrigin]) {
      execFileSync("git", ["init", "-q", d]);
    }
    execFileSync("git", [
      "-C", withOrigin, "remote", "add", "origin", "git@github.com:hornjason/pai-harness.git",
    ]);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a checkout with an origin yields a slug the identity check accepts", () => {
    const reading = readWorktreeRemote(withOrigin);
    expect(reading.error, reading.error || "").toBeNull();
    expect(repoSlug(reading.url)).toBe(RUN_REPO);
    expect(worktreeIdentity(withOrigin, RUN_REPO, reading.url).verdict).toBe("match");
  });

  test("a checkout with no origin is an error, not an empty pass", () => {
    const reading = readWorktreeRemote(noOrigin);
    expect(reading.url).toBeNull();
    expect(reading.error, "a repo with no origin read as a successful empty url").not.toBeNull();
    expect(worktreeIdentity(noOrigin, RUN_REPO, reading.url).refusal).not.toBeNull();
  });

  test("a directory that is not a checkout is an error, not a throw", () => {
    // This runs on a path that is already suspected of being wrong. A throw
    // would become a refusal somebody's catch turns back into a pass.
    const reading = readWorktreeRemote(notARepo);
    expect(reading.url).toBeNull();
    expect(reading.error).not.toBeNull();
  });

  test("a missing path and an empty path are errors with no subprocess at all", () => {
    for (const bad of ["", "   ", null, undefined] as unknown[]) {
      const reading = readWorktreeRemote(bad as string);
      expect(reading.url).toBeNull();
      expect(reading.error).not.toBeNull();
    }
  });

  test("git's own stderr is redacted on the way out", () => {
    // The second channel for the same credential: git quotes the path or
    // the remote back at you in its error text, so a caller that redacted
    // only `url` would leak it through `error`. Executed against a real
    // failing `git -C`, not a stubbed string.
    const token = `ghp_${"c".repeat(36)}`;
    const reading = readWorktreeRemote(join(dir, "missing", token));
    expect(reading.url).toBeNull();
    expect(reading.error, "the reader returned git's stderr unredacted").not.toContain(token);
  });

  test("a remote with no credential survives the reader intact", () => {
    // The control for the case above: a redactor applied to every error
    // string must not mangle an ordinary one into uselessness.
    const reading = readWorktreeRemote(join(dir, "definitely-missing"));
    expect(reading.error).not.toContain("<redacted>");
  });

  test("the real rungate checkout reads as the repo this run targets", () => {
    // The positive control over live state: without it every case above is
    // satisfied by a reader that always errors.
    const reading = readWorktreeRemote(REPO_ROOT);
    expect(reading.error, reading.error || "").toBeNull();
    expect(repoSlug(reading.url)).toBe(RUN_REPO);
  });
});

// ── SC-1445: the cwd pin, executed ───────────────────────────

const AGENT_TIMING = "AGENT-TIMING";
const BRIEFED = "BRIEFED-AGENT";
const PRECEDENCE = "BRIEF-PRECEDENCE";
/** The single site. Removing it is the mutation; a rename aborts the build. */
const CWD_PIN = "if (opts.isolation === 'worktree') opts.cwd = PROJECT_ROOT";

interface Captured {
  prompt: string;
  opts: Record<string, unknown>;
}

function loadBriefedAgent(source = shipSource) {
  const block = (name: string) => {
    const start = source.indexOf(`// ──── ${name}-START ────`);
    const end = source.indexOf(`// ──── ${name}-END ────`);
    if (start < 0 || end < 0) throw new Error(`${name} markers missing`);
    return source.slice(start, end);
  };
  const calls: Captured[] = [];
  const factory = new Function(
    "ROLES", "PROJECT_ROOT", "HARNESS_ROOT", "WORK_DIR", "log", "agent",
    "loadContextPaths", "loadReinforcementRules", "noteWorktrees",
    // `shellQuote` first: AGENT-TIMING's instruction builder calls it, and
    // omitting it throws ReferenceError at spawn time rather than at load,
    // which reads as the block being broken. Same assembly as
    // test/briefed-agent-model.test.ts.
    // BRIEF-PRECEDENCE likewise: briefedAgent appends its notice (#180), so
    // without the block the composed prompt dies on a free reference.
    `${source.match(/function shellQuote\(word\)[\s\S]*?\n}/)?.[0] ?? ""}\n` +
      `${block(PRECEDENCE)}\n${block(AGENT_TIMING)}\n${block(BRIEFED)}\nreturn briefedAgent;`,
  );
  const call = factory(
    { marcus: { brief: ".claude/agents/marcus.md" } },
    "/runs/project-root",
    "/runs/harness-root",
    "/work",
    () => {},
    async (prompt: string, opts: Record<string, unknown>) => {
      calls.push({ prompt, opts: { ...opts } });
      return { ok: true };
    },
    async () => [],
    async () => [],
    () => {},
  ) as (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;
  return { call, calls };
}

describe("SC-1445: an isolated spawn is pinned to the run's root, whatever the cwd", () => {
  test("the pin has exactly one site, so the mutation below is total", () => {
    expect(
      shipSource.split(CWD_PIN).length - 1,
      "a second pin would survive the mutation and the mutant would go green for the wrong reason",
    ).toBe(1);
  });

  test("the same spawn resolves to the same root from two different cwds", async () => {
    // The cwd-independence property #218 asks for, run rather than argued:
    // the same workflow, twice, from two working directories, asserting one
    // worktree root. `process.chdir` is restored in a finally so a failure
    // here cannot leak into every later test in the file.
    const original = process.cwd();
    const seen: unknown[] = [];
    try {
      for (const where of [REPO_ROOT, tmpdir()]) {
        process.chdir(where);
        const { call, calls } = loadBriefedAgent();
        await call("work", { role: "marcus", label: "marcus" });
        seen.push(calls[0]!.opts.cwd);
      }
    } finally {
      process.chdir(original);
    }
    expect(seen, "the worktree root followed the process cwd").toEqual([
      "/runs/project-root",
      "/runs/project-root",
    ]);
  });

  test("the isolated spawn carries cwd at all", async () => {
    const { call, calls } = loadBriefedAgent();
    await call("work", { role: "marcus", label: "marcus" });
    expect(calls[0]!.opts.isolation).toBe("worktree");
    expect(calls[0]!.opts.cwd).toBe("/runs/project-root");
  });

  test("MUTANT: with the pin removed the spawn carries no root at all", async () => {
    const mutated = shipSource.replace(CWD_PIN, "");
    if (mutated === shipSource) throw new Error("could not build the mutant: the pin appears 0 times");
    const { call, calls } = loadBriefedAgent(mutated);
    await call("work", { role: "marcus", label: "marcus" });
    expect(calls[0]!.opts.isolation, "the mutation removed the isolation too").toBe("worktree");
    expect(
      calls[0]!.opts.cwd,
      "the pin was removed and the spawn still carried a root — the assertion above reads something else",
    ).toBeUndefined();
  });

  test("a caller that sets isolation to undefined is NOT pinned", () => {
    // The Validate marcus-fix spawn names an absolute worktree in its prompt
    // and deliberately takes no isolation. Pinning it would be a change this
    // issue did not ask for, and asserting it stays unpinned is what stops a
    // future widening of the pin going unnoticed.
    const line = shipSource.includes("isolation: undefined");
    expect(line, "the non-isolated spawns are gone — re-read this assertion").toBe(true);
  });
});

// ── SC-1448: the collection boundary, executed ───────────────

/**
 * The real COLLECT-IDENTITY block, wrapped so its top-level `return` is
 * legal, with everything it reaches for injected.
 *
 * Executed rather than grepped. The first version of this criterion had only
 * source-text assertions, and the mutation that deletes the block scored
 * **ZERO** — the log line it removed was the only thing any assertion read,
 * and the refusal itself went unobserved. That zero is why this runs.
 */
function loadCollectBoundary(source = shipSource) {
  const start = source.indexOf("// ──── COLLECT-IDENTITY-START ────");
  const end = source.indexOf("// ──── COLLECT-IDENTITY-END ────");
  if (start < 0 || end < 0) throw new Error("COLLECT-IDENTITY markers missing from ship.js");
  const logs: string[] = [];
  const body = source.slice(start, end);
  if (!body.includes("worktreeIdentityViolations(")) {
    throw new Error("could not build the harness: the block no longer calls the collector");
  }
  // `runWorktrees` is declared here the way ship.js declares it in the
  // FAILURE-LEDGER block, and returned, so the recording this block performs
  // for the #414 gate is OBSERVED rather than merely tolerated. Without the
  // declaration the assignment would create a sloppy-mode global and the
  // control tests below would pass over a block that recorded nothing.
  const run = new Function(
    "implementResult", "REPO", "log", "terminalFailure",
    "worktreeIdentityViolations", "redactRemote", "worktreeRecords",
    `let runWorktrees = []\nreturn (async () => {\n${body}\nreturn { shipped: true, runWorktrees }\n})()`,
  );
  return {
    logs,
    call: (agentResults: unknown, repo: string) =>
      run(
        { buildResult: { agentResults } },
        repo,
        (m: string) => logs.push(String(m)),
        async (status: string, extra: Record<string, unknown>) => ({ status, ...extra }),
        worktreeIdentityViolations,
        redactRemote,
        worktreeRecords,
      ) as Promise<Record<string, unknown>>,
  };
}

describe("SC-1448: the run stops at the collection boundary, not after it", () => {
  test("the block is at module top level, so a wrapper cannot switch it off", () => {
    // A wrapper outside the markers leaves the extracted bytes identical and
    // every assertion in this file green while the guard never runs (#266).
    expect(assertMarkedBlockReachable(shipSource, "COLLECT-IDENTITY")).toEqual(["Program"]);
  });

  test("it runs before anything is staged", () => {
    // "Last statement before the collector" is the property that makes this
    // the authorization point rather than one more check.
    //
    // #420 added a SECOND staging point — a wave commit, which runs while
    // this block is still waiting for the decomposition to return. The
    // original form of this assertion took the FIRST `collectAgentWork(` in
    // the file and so went red the moment that happened, which was correct
    // of it: the block's own docblock warns that "a THIRD path added later …
    // would be committed from without passing either of them". The answer is
    // not to relax the ordering but to state it per staging point, so a
    // fourth one cannot be added without either passing the guard or turning
    // this red.
    const guardAt = shipSource.indexOf("// ──── COLLECT-IDENTITY-START ────");
    const mainCollectAt = shipSource.indexOf(
      "await collectAgentWork(agentResults, collectInto, 'Commit', 'collect-worktrees')",
    );
    expect(guardAt).toBeGreaterThan(-1);
    expect(mainCollectAt, "nothing calls the collector — this ordering measures nothing")
      .toBeGreaterThan(-1);
    expect(guardAt, "the guard moved below the main collection").toBeLessThan(mainCollectAt);
  });

  test("every staging point asks the same question first (#420)", () => {
    // The wave path stages inside the RUN-REF block, long before the
    // top-level guard runs. Asserted on the block rather than on the file so
    // the ordering is read where it actually holds.
    const a = shipSource.indexOf("// ──── RUN-REF-START ────");
    const b = shipSource.indexOf("// ──── RUN-REF-END ────");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    const block = shipSource.slice(a, b);

    const asks = block.indexOf("worktreeIdentityViolations(");
    const stages = block.indexOf("await collectAgentWork(");
    expect(stages, "the wave path no longer stages — this ordering measures nothing")
      .toBeGreaterThan(-1);
    expect(asks, "the wave path stages without asking whose worktree it is")
      .toBeGreaterThan(-1);
    expect(asks, "the wave path stages before it asks").toBeLessThan(stages);
    // The same binding, not a private re-implementation of it: a second
    // decider would survive any mutation of the first.
    expect(block).toContain("{ requirePath: true }");
  });

  test("a worktree in another repository ends the run", async () => {
    const { call, logs } = loadCollectBoundary();
    const got = await call(
      [
        { worktreePath: RIGHT, worktreeRepo: "git@github.com:hornjason/pai-harness.git" },
        { worktreePath: WT, worktreeRepo: "git@github.com:hornjason/asaCommandCenter.git" },
      ],
      RUN_REPO,
    );
    expect(got.status, "the run carried on past a worktree in another repository")
      .toBe("WORKTREE_REPO_MISMATCH");
    expect(String(got.reason)).toContain("asacommandcenter");
    expect(logs.join("\n")).toContain("COLLECT REFUSED");
  });

  test("a run whose worktrees all match is not stopped", async () => {
    // The control. Without it, "it refused" is satisfied by a boundary that
    // refuses every run, which would be found on the next real ship and
    // reverted.
    const { call, logs } = loadCollectBoundary();
    const got = await call(
      [{ worktreePath: RIGHT, worktreeRepo: "https://github.com/HornJason/PAI-Harness.git" }],
      RUN_REPO,
    );
    expect(got.shipped, JSON.stringify(got)).toBe(true);
    expect(logs).toEqual([]);
    // #414: a run that passes the self-reported check records where it was,
    // so a gate can ask the disk the same question. A boundary that refuses
    // correctly and records nothing leaves the gate with an empty list and
    // nothing to read.
    expect(got.runWorktrees).toEqual([
      { path: RIGHT, reportedRepo: "https://github.com/HornJason/PAI-Harness.git" },
    ]);
  });

  test("a run with no agent results at all is not stopped", async () => {
    // The single-agent path that reported no worktree has its own refusal
    // inside runImplement. Refusing again here would make the boundary fire
    // on shapes it is not the right place to judge.
    const { call } = loadCollectBoundary();
    expect((await call(undefined, RUN_REPO)).shipped).toBe(true);
    expect((await call([], RUN_REPO)).shipped).toBe(true);
  });

  test("the terminal status carries the results it refused", async () => {
    const { call } = loadCollectBoundary();
    const rows = [{ worktreePath: WT, worktreeRepo: "git@github.com:other/thing.git" }];
    const got = await call(rows, RUN_REPO);
    expect(got.agentResults, "the refusal dropped the evidence for it").toEqual(rows);
  });

  test("a row with no worktree path is refused here, not skipped", async () => {
    // The authorization bypass the push security review named. The list
    // helper skips pathless rows by default — correct for a survey, wrong
    // here, where every row WILL be committed from. Omitting one field
    // would otherwise switch the guard off at the only place it is
    // load-bearing.
    const { call, logs } = loadCollectBoundary();
    const got = await call([{ filesChanged: ["lib/a.ts"] }], RUN_REPO);
    expect(got.status, "a pathless row walked past the collection boundary")
      .toBe("WORKTREE_REPO_MISMATCH");
    expect(logs.join("\n")).toContain("COLLECT REFUSED");
  });

  test("the terminal payload redacts a credential in a reported remote", async () => {
    // This payload becomes the run's result: printed, stored, pasted into an
    // issue. `worktreeRepo` is a URL an agent reported and a CI checkout's
    // carries a token.
    const secret = "NOT-A-REAL-TOKEN-0123456789";
    const { call } = loadCollectBoundary();
    const got = await call(
      [{ worktreePath: WT, worktreeRepo: `https://x-access-token:${secret}@github.com/other/thing` }],
      RUN_REPO,
    );
    expect(JSON.stringify(got), "the run result carried the token").not.toContain(secret);
    expect(JSON.stringify(got.agentResults)).toContain("<redacted>");
  });
});

// ── SC-1446: the call sites, and the remediation else ────────

describe("SC-1446: the guard is wired in, and a dead remediation stops the run", () => {
  test("both isolated marcus spawns ask for the remote and check it", () => {
    // Source text, deliberately narrow: the executed proof is the matrix
    // above, and what source text can add is that the decision is REACHED
    // from the two places an isolated agent reports back.
    const calls = shipSource.match(/worktreeIdentity\(buildResult\.worktreePath/g) || [];
    expect(calls.length, "an isolated implement path stopped checking its worktree").toBe(2);
    const asks = shipSource.match(/Also report worktreeRepo:/g) || [];
    expect(asks.length, "a spawn is checked for a field it was never asked for").toBe(2);
    expect(shipSource).toContain("worktreeRepo: { type: 'string' }");
  });

  test("the Verify BUILD regression has an else, and it is terminal", () => {
    // #218's other half: `if (reimpl.success)` had no else, so a remediation
    // that performed no work was indistinguishable from one never attempted
    // and the run advanced to rook-scope and rook.
    const at = shipSource.indexOf("Verify CODE regression #${regressionCount}");
    expect(at, "the Verify regression branch moved — this assertion is reading nothing").toBeGreaterThan(-1);
    const region = shipSource.slice(at, at + 6000);
    expect(region).toContain("VERIFY BUILD regression produced no work");
    expect(region).toContain("terminalFailure('VERIFY_FAILED'");
  });

  test("both regression refusals carry the agent's own reason", () => {
    // "BUILD regression failed" is the status restated. The cause lived in
    // the agent's findings, and on wf_5e3ed885-98c that was the whole
    // diagnosis.
    const reasons = shipSource.match(/the remediation agent reported failure with no detail/g) || [];
    expect(reasons.length, "a regression refusal went back to naming only itself").toBe(2);
  });
});
