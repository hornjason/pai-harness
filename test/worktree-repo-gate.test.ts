/**
 * Covers SC-1540..SC-1546 (GATE-CONTRACTS-SPEC.md), issue #414. Follow-up to #218.
 *
 * #218 made the ship workflow refuse a worktree whose `origin` does not match
 * the run's repo. The comparison it runs is **self-reported**: `workflows/ship.js`
 * has no subprocess (#69), so the remote it compares is the one the agent said
 * it read when asked to run `git remote get-url origin`.
 *
 * That catches the incident it was built for, and the worse variant where an
 * agent does not notice and reports success. It does not catch an agent that
 * reports the repository named in its brief rather than the one its checkout
 * actually has — and that reply is indistinguishable from a correct one.
 *
 * A gate can read the disk. These tests drive the reading against real
 * `git init` checkouts, because a stubbed reader proves the comparison can
 * compare and proves nothing about whether git was ever asked.
 *
 * ## The three answers that must stay apart
 *
 *   match    — the checkout is the run's repository
 *   forged   — the agent reported the RIGHT repository and the disk disagrees.
 *              This is the case #218 cannot see and the only reason #414
 *              exists. It must not read as an ordinary mismatch, because the
 *              cause is different: the reply was wrong, not the worktree.
 *   missing  — the worktree is gone by gate time. A removed worktree and a
 *              matching one must not produce the same answer (SC-3), which is
 *              the fail-open `.claude/rules/checks-must-be-able-to-fail.md`
 *              names: nothing to read, read as nothing to report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

import { worktreeDiskIdentity, type RemoteReading } from "../lib/worktree-repo";
import { worktreeRepoViolations } from "../gates/workflow.test";

const RUN_REPO = "hornjason/pai-harness";
/** A second slug, never this repo's. The harness must not name a consumer (#304). */
const OTHER_REPO = "example-owner/example-project";

let root = "";
let right = "";
let wrong = "";
let noOrigin = "";
let gone = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rungate-wt-gate-"));
  right = join(root, "right");
  wrong = join(root, "wrong");
  noOrigin = join(root, "no-origin");
  gone = join(root, "removed-before-the-gate-ran");
  for (const d of [right, wrong, noOrigin]) {
    execFileSync("mkdir", ["-p", d]);
    execFileSync("git", ["init", "-q", d]);
  }
  execFileSync("git", ["-C", right, "remote", "add", "origin", `git@github.com:${RUN_REPO}.git`]);
  execFileSync("git", ["-C", wrong, "remote", "add", "origin", `https://github.com/${OTHER_REPO}.git`]);
  writeFileSync(join(right, "a.ts"), "export const a = 1;\n");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ── SC-1540: the verdict comes off the disk ──────────────────

describe("SC-1540: the reading is the checkout, not the reply", () => {
  test("a checkout that IS the run's repository matches", () => {
    const got = worktreeDiskIdentity(right, RUN_REPO, `git@github.com:${RUN_REPO}.git`);
    expect(got.verdict).toBe("match");
    expect(got.refusal).toBeNull();
    expect(got.actual).toBe(RUN_REPO);
  });

  test("a checkout of another repository is refused even when nothing was reported", () => {
    // The self-reported check cannot fire here: there is no reply to compare.
    const got = worktreeDiskIdentity(wrong, RUN_REPO, null);
    expect(got.verdict).toBe("mismatch");
    expect(got.actual).toBe(OTHER_REPO);
    expect(got.refusal).toContain(OTHER_REPO);
    expect(got.refusal).toContain(RUN_REPO);
  });

  test("git really ran — the reading is not a parse of the reported string", () => {
    // If the comparison read `reportedRepo` instead of the disk, this would
    // match: the reply is correct and the checkout is not. That substitution
    // is exactly #414, so it is asserted rather than assumed.
    const got = worktreeDiskIdentity(wrong, RUN_REPO, `git@github.com:${RUN_REPO}.git`);
    expect(got.verdict).not.toBe("match");
    expect(got.actual).toBe(OTHER_REPO);
  });

  test("a checkout with no origin is a refusal, not an empty pass", () => {
    const got = worktreeDiskIdentity(noOrigin, RUN_REPO, null);
    expect(got.refusal, "a repository with no origin read as clean").not.toBeNull();
    expect(got.verdict).not.toBe("match");
  });
});

// ── SC-1541: "the disk disagrees with the reply" is its own answer ──

describe("SC-1541: a correct reply over a wrong checkout is its own verdict", () => {
  test("reported right, disk wrong, is `forged` and says both", () => {
    const got = worktreeDiskIdentity(wrong, RUN_REPO, `git@github.com:${RUN_REPO}.git`);
    expect(got.verdict).toBe("forged");
    expect(got.reported).toBe(RUN_REPO);
    expect(got.actual).toBe(OTHER_REPO);
    // An operator fixes these two differently: one is an agent that answered
    // from its brief, the other is a worktree in the wrong place.
    expect(got.refusal).toContain("reported");
    expect(got.refusal).toContain(OTHER_REPO);
  });

  test("forged and mismatch do not read alike once the paths are blanked", () => {
    // Both interpolate the path, so two refusals about different worktrees
    // differ as strings however identical the wording. Compared on the shape.
    const blank = (s: string, p: string) => s.split(p).join("<path>");
    const forged = blank(worktreeDiskIdentity(wrong, RUN_REPO, `git@github.com:${RUN_REPO}.git`).refusal!, wrong);
    const mismatch = blank(worktreeDiskIdentity(wrong, RUN_REPO, null).refusal!, wrong);
    expect(forged).not.toBe(mismatch);
    expect(forged.includes(mismatch)).toBe(false);
    expect(mismatch.includes(forged)).toBe(false);
  });

  test("the gate's refusal is distinguishable from ship.js's self-reported one", () => {
    // SC-2 of #414. ship.js says "<path> is a worktree of X, but this run
    // targets Y" from the REPLY. If the gate said the same sentence, an
    // operator could not tell which reading refused, and the two have
    // different causes and different fixes.
    const gate = worktreeDiskIdentity(wrong, RUN_REPO, null).refusal!;
    expect(gate).toContain("read from the checkout");
    expect(gate).toContain("#414");
  });
});

// ── SC-1542: a worktree that is gone is not a worktree that matched ──

describe("SC-1542: a removed worktree is its own verdict", () => {
  test("a path that does not exist is `missing`, never `match`", () => {
    const got = worktreeDiskIdentity(gone, RUN_REPO, `git@github.com:${RUN_REPO}.git`);
    expect(got.verdict).toBe("missing");
    expect(got.refusal, "a removed worktree produced no refusal").not.toBeNull();
    expect(got.refusal).toContain(gone);
  });

  test("missing and match are not the same answer for the same reply", () => {
    // The fail-open this rules out: both are "no evidence of a wrong repo".
    const reply = `git@github.com:${RUN_REPO}.git`;
    expect(worktreeDiskIdentity(gone, RUN_REPO, reply).verdict).not.toBe(
      worktreeDiskIdentity(right, RUN_REPO, reply).verdict,
    );
  });

  test("a missing path is distinguished from an unreadable one", () => {
    // "the worktree is gone" and "git could not read it" have different
    // causes. Collapsing them is the #218 docblock's own stated rule.
    expect(worktreeDiskIdentity(gone, RUN_REPO, null).verdict).toBe("missing");
    expect(worktreeDiskIdentity(noOrigin, RUN_REPO, null).verdict).not.toBe("missing");
  });
});

// ── SC-1543: the run must know its own repository ────────────

describe("SC-1543: no expected repository is a refusal, not a pass", () => {
  for (const [label, repo] of [
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["unparseable", "not a slug or a url"],
  ] as Array<[string, unknown]>) {
    test(`${label} repo refuses rather than letting any checkout through`, () => {
      const got = worktreeDiskIdentity(right, repo as string, null);
      expect(got.verdict).toBe("unreported");
      expect(got.refusal, `a ${label} repo passed, so a worktree of anything would`).not.toBeNull();
    });
  }
});

// ── SC-1544: the gate's single refusal binding ───────────────

describe("SC-1544: worktreeRepoViolations is the one refusal site", () => {
  test("every entry is read, and only the bad ones refuse", () => {
    const out = worktreeRepoViolations(
      [
        { path: right, reportedRepo: `git@github.com:${RUN_REPO}.git` },
        { path: wrong, reportedRepo: `git@github.com:${RUN_REPO}.git` },
        { path: gone },
      ],
      RUN_REPO,
    );
    expect(out).toHaveLength(2);
    expect(out.join("\n")).toContain(OTHER_REPO);
    expect(out.join("\n")).toContain(gone);
  });

  test("a clean run produces no violations", () => {
    expect(worktreeRepoViolations([{ path: right }], RUN_REPO)).toEqual([]);
  });

  test("an entry with no path is refused, not skipped", () => {
    // At a gate there is no "surveying" caller. A row naming no worktree is a
    // row whose origin cannot be checked, and skipping it would let one
    // omitted field switch the check off — the bypass #218's `requirePath`
    // already had to close on the collection side.
    expect(worktreeRepoViolations([{ path: "" }], RUN_REPO)).toHaveLength(1);
    expect(worktreeRepoViolations([{}], RUN_REPO)).toHaveLength(1);
  });

  test("no entries at all is UNMEASURED, not clean", () => {
    // A gate that scans zero worktrees reports zero violations and is
    // indistinguishable from compliance. Every run this gate fires on has at
    // least a tree under test, so an empty list means the state stopped
    // naming them.
    const out = worktreeRepoViolations([], RUN_REPO);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("UNMEASURED");
  });

  test("duplicate paths are read once and reported once", () => {
    // ship.js records one row per agent result, and a worktree that reported
    // in two parts (#228) appears twice. Two identical refusals for one
    // worktree is noise an operator has to deduplicate by hand.
    const out = worktreeRepoViolations([{ path: wrong }, { path: wrong }], RUN_REPO);
    expect(out).toHaveLength(1);
  });

  test("the reader is injectable, and the default is the real one", () => {
    // Injected only so a test can plant a reading git cannot produce. The
    // default must be `readWorktreeRemote` — a gate whose default reader is a
    // stub is the check that never looked.
    const reads: string[] = [];
    const stub = (p: string): RemoteReading => {
      reads.push(p);
      return { url: `https://github.com/${OTHER_REPO}`, error: null };
    };
    const out = worktreeRepoViolations([{ path: right }], RUN_REPO, stub);
    expect(reads).toEqual([right]);
    expect(out).toHaveLength(1);
    // And without the stub, the same path is clean — which is only true if
    // the default actually ran git against it.
    expect(worktreeRepoViolations([{ path: right }], RUN_REPO)).toEqual([]);
  });
});

// ── SC-1545: the field is authored, not merely read ──────────

/**
 * A reader keyed on a field nothing writes is #315 exactly: `code-committed`
 * early-returned on `harness?.codeCommittedPaths || []`, nothing authored
 * that key, and the check whose whole job was confirming the work is
 * committed had never run. So both ends are driven here — ship.js's producer
 * is EXECUTED, and run-gate.ts's threading is run as a real subprocess.
 */
describe("SC-1545: ship.js produces the list and run-gate.ts persists it", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const shipSource = readFileSync(join(REPO_ROOT, "workflows", "ship.js"), "utf-8");

  function loadWorktreeRecords(): (r: unknown) => Array<{ path: string; reportedRepo?: string }> {
    const start = shipSource.indexOf("// ──── WORKTREE-IDENTITY-START ────");
    const end = shipSource.indexOf("// ──── WORKTREE-IDENTITY-END ────");
    if (start < 0 || end < 0) throw new Error("WORKTREE-IDENTITY markers not found in ship.js");
    return new Function(`${shipSource.slice(start, end)}\nreturn worktreeRecords`)();
  }

  test("agent results become worktree records, pathless rows dropped", () => {
    const worktreeRecords = loadWorktreeRecords();
    expect(
      worktreeRecords([
        { worktreePath: " /tmp/a ", worktreeRepo: "git@github.com:o/n.git" },
        { worktreePath: "", worktreeRepo: "git@github.com:o/n.git" },
        { worktreePath: "/tmp/b" },
        null,
      ]),
    ).toEqual([
      { path: "/tmp/a", reportedRepo: "git@github.com:o/n.git" },
      { path: "/tmp/b" },
    ]);
  });

  test("a credential in the reported remote is redacted before it reaches a prompt", () => {
    // This list is interpolated into an agent prompt. A CI checkout's origin
    // carries a token, and a prompt is a transcript.
    const worktreeRecords = loadWorktreeRecords();
    const token = `ghp_${"f".repeat(36)}`;
    const got = worktreeRecords([
      { worktreePath: "/tmp/a", worktreeRepo: `https://x-access-token:${token}@github.com/${RUN_REPO}.git` },
    ]);
    expect(got[0]!.reportedRepo, "the token survived into the record").not.toContain(token);
    // And the slug still parses, or the gate's forged-versus-mismatch
    // distinction would be destroyed by the redaction that protects it.
    expect(worktreeDiskIdentity(wrong, RUN_REPO, got[0]!.reportedRepo).verdict).toBe("forged");
  });

  test("ship.js threads the list into the gate command", () => {
    // The producer and the reader are both proven; this is the wire between
    // them, and it is the one link that cannot be executed here because the
    // Workflow sandbox is not available to a test.
    expect(shipSource).toContain("runWorktrees = worktreeRecords(");
    expect(shipSource).toContain("--worktrees ${shellQuote(JSON.stringify(runWorktrees))}");
    expect(shipSource).toContain("--tree-under-test ${gateCwd}${worktreesFlag}");
  });

  test("run-gate.ts persists a supplied list and clears a stale one", () => {
    const work = mkdtempSync(join(tmpdir(), "rungate-run-gate-"));
    const sf = join(work, "workflow-state.json");
    const base = {
      schemaVersion: 2, issue: 414, slug: "s", phase: "SHIP", issueGoal: "g",
      acs: [], worktrees: [{ path: "/tmp/left-behind-by-an-earlier-gate" }],
    };
    try {
      writeFileSync(sf, JSON.stringify(base));
      // Supplied: persisted.
      runGate(work, ["--worktrees", JSON.stringify([{ path: right, reportedRepo: "git@github.com:o/n.git" }])]);
      expect(JSON.parse(readFileSync(sf, "utf-8")).worktrees).toEqual([
        { path: right, reportedRepo: "git@github.com:o/n.git" },
      ]);
      // Not supplied: CLEARED, not inherited. ship.js runs four gates against
      // one state file, and by the Ship phase an earlier gate's worktrees may
      // have been collected away.
      runGate(work, []);
      expect(JSON.parse(readFileSync(sf, "utf-8")).worktrees).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120000);

  test("an unparseable list refuses rather than clearing", () => {
    // "nothing was sent" and "something unreadable was sent" are different
    // facts, and treating the second as the first switches the check off at
    // exactly the moment its input is suspect.
    const work = mkdtempSync(join(tmpdir(), "rungate-run-gate-bad-"));
    const sf = join(work, "workflow-state.json");
    try {
      writeFileSync(sf, JSON.stringify({ schemaVersion: 2, issue: 414, slug: "s", phase: "SHIP", issueGoal: "g", acs: [] }));
      const bad = runGate(work, ["--worktrees", "{not json"]);
      expect(bad.status, "unparseable --worktrees did not refuse").not.toBe(0);
      expect(bad.output).toContain("BLOCKED");

      const wrongShape = runGate(work, ["--worktrees", JSON.stringify([{ nope: 1 }])]);
      expect(wrongShape.status, "a list without paths did not refuse").not.toBe(0);
      expect(wrongShape.output).toContain("BLOCKED");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120000);
});

/** Run `gates/run-gate.ts` against a planted work dir. */
function runGate(work: string, extra: string[]): { status: number; output: string } {
  const r = spawnSync(
    "bun",
    [
      "run", join(import.meta.dir, "..", "gates", "run-gate.ts"),
      "--gate", "ship", "--slug", basename(work), ...extra,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf-8",
      timeout: 60000,
      env: { ...process.env, RUNGATE_WORK_DIR: dirname(work) },
    },
  );
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── SC-1546: credentials do not reach the refusal ────────────

describe("SC-1546: a refusal never quotes a credential", () => {
  test("a token in the reported remote is redacted in the refusal", () => {
    const token = `ghp_${"d".repeat(36)}`;
    const got = worktreeDiskIdentity(
      wrong,
      RUN_REPO,
      `https://x-access-token:${token}@github.com/${RUN_REPO}.git`,
    );
    expect(got.refusal, "the refusal quoted the reported remote unredacted").not.toContain(token);
  });

  test("a token in the path reaches neither the refusal nor the log", () => {
    const token = `ghp_${"e".repeat(36)}`;
    const got = worktreeDiskIdentity(join(root, token), RUN_REPO, null);
    expect(got.verdict).toBe("missing");
    expect(got.refusal, "the missing-worktree refusal quoted the path unredacted").not.toContain(token);
  });
});
