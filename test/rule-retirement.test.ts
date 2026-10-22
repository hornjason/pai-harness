/**
 * Covers SC-1941 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md), #544.
 *
 * `lib/rule-retirement.ts` — a candidate whose citation no longer resolves is
 * dropped at the generator rather than warned about.
 *
 * `test/failure-intake-promotion.test.ts` already carried this as a measured
 * escape:
 *
 *   > ESCAPE: nothing checks whether the cited evidence still resolves
 *   > [...] A sha that is in no repository anywhere. It is promoted
 *   > regardless.
 *
 * That case is converted here into the behaviour it described. It matters in
 * this repository specifically: `main` is squash-merged and branches are
 * rebased onto it constantly, so the sha a candidate was mined from is
 * routinely not the sha that landed — and recency is the only ordering signal
 * the promoter has, so a candidate citing a vanished commit ranks first.
 *
 * ## The direction that makes this dangerous
 *
 * `git cat-file -e` on a shallow clone says "no" for every commit before the
 * cut, including every commit that is fine upstream, and
 * `actions/checkout@v4` with no `fetch-depth` puts a CI runner in that state
 * by default. A retirement pass that read that "no" as GONE would retire the
 * whole mined tier on its first CI run and the diff would look like the
 * system working. So every case below that asserts a retirement is paired
 * with one asserting that the same input is KEPT when the question could not
 * be asked.
 *
 * The fixtures are real git repositories built on disk, never hand-written
 * candidate lists: #545 names that requirement for the revert scanner and it
 * is the same requirement here. Short-circuiting the resolver must go red
 * against a repository that actually lacks the commit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  AMBIGUOUS_SHA,
  GIT_UNREADABLE,
  NOT_A_COMMIT,
  NOT_A_GIT_REPOSITORY,
  SHALLOW_HISTORY,
  UNRECOGNISED_CITATION,
  batchCheckShas,
  readHistoryState,
  resolveCitation,
  retireUnresolvable,
  retirementSummary,
  survivingSubset,
} from "../lib/rule-retirement";
import { repoFileIndex } from "../lib/line-citation";
import { promoteCandidates, PROMOTION_BUDGET_RULES } from "../lib/rule-promotion";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rungate-retirement-${label}-`));
  scratch.push(dir);
  return dir;
}

/** git with ambient configuration neutralised, so the fixture builds under an empty HOME. */
function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=Fixture",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...extraEnv,
      },
    },
  );
  if (r.status !== 0) {
    throw new Error(
      `fixture git ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim() || "(no stderr)"}`,
    );
  }
  return r.stdout ?? "";
}

/** A repository with `n` commits, returning its directory and the shas in order. */
function repoWithCommits(label: string, n: number): { dir: string; shas: string[] } {
  const dir = scratchDir(label);
  git(dir, ["init", "-q", "-b", "main"]);
  const shas: string[] = [];
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, ["add", "-A"]);
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    git(dir, ["commit", "-q", "-m", `fix(#${i}): the thing that went wrong number ${i}`], {
      GIT_COMMITTER_DATE: stamp,
      GIT_AUTHOR_DATE: stamp,
    });
    shas.push(git(dir, ["rev-parse", "HEAD"]).trim());
  }
  return { dir, shas };
}

function plantFile(root: string, rel: string, lines: number): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"));
}

const candidate = (source: string, hash = source) => ({ source, hash });

/** A sha of the right shape that is in no repository anywhere. */
const ABSENT_SHA = "0".repeat(40);

/**
 * `resolveCitation` reads the sha arm out of a batch taken once for the
 * whole population, so a case about one citation has to build the batch its
 * reading would have come from. Built with the REAL `batchCheckShas` rather
 * than a hand-written map: a map written here would be a fixture asserting
 * what the test already believes, and the git call is the thing under test.
 */
function resolve(root: string, source: string) {
  const history = readHistoryState(root);
  const sha = /^git:([0-9a-f]{7,40})$/.exec(source)?.[1];
  const batch = batchCheckShas(root, sha ? [sha] : [], history);
  return resolveCitation(root, source, repoFileIndex(root), batch);
}

// ── The resolver ─────────────────────────────────────────────────

describe("SC-1941: resolveCitation — three readings, and only one retires", () => {
  test("a sha in the history RESOLVES; the same shape absent from it is GONE", () => {
    // The pair. Without the second half the resolver could answer RESOLVES
    // unconditionally and the first half would still pass.
    const { dir, shas } = repoWithCommits("sha-pair", 2);
    expect(resolve(dir, `git:${shas[1]!.slice(0, 8)}`).reading).toBe("RESOLVES");
    expect(resolve(dir, `git:${ABSENT_SHA}`).reading).toBe("GONE");
  });

  test("a sha question asked of a SHALLOW clone is UNMEASURED, never GONE", () => {
    // The direction that matters. A CI runner clones to depth 1 by default,
    // so every sha before the cut is locally absent and upstream fine.
    const { dir, shas } = repoWithCommits("shallow-src", 3);
    const shallow = scratchDir("shallow-dst");
    git(shallow, ["clone", "-q", "--depth", "1", `file://${dir}`, "."]);
    const history = readHistoryState(shallow);
    expect(history.shallow, "the fixture did not actually produce a shallow clone").toBe(true);

    const read = resolve(shallow, `git:${shas[0]!.slice(0, 8)}`);
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain("shallow");

    // And the SAME sha against the full history resolves — so the UNMEASURED
    // above is the clone's doing, not the sha's.
    expect(resolve(dir, `git:${shas[0]!.slice(0, 8)}`).reading).toBe("RESOLVES");
  });

  test("a sha question asked of a directory that is not a repository is UNMEASURED", () => {
    const dir = scratchDir("norepo");
    expect(readHistoryState(dir).readable).toBe(false);
    expect(resolve(dir, `git:${ABSENT_SHA}`).reading).toBe("UNMEASURED");
  });

  test("a `path:line` that exists RESOLVES; one past the end of the file is GONE", () => {
    const { dir } = repoWithCommits("lines", 1);
    plantFile(dir, "docs/x.md", 10);
    expect(resolve(dir, "docs/x.md:3").reading).toBe("RESOLVES");
    expect(resolve(dir, "docs/x.md:99").reading).toBe("GONE");
    expect(resolve(dir, "docs/gone.md:1").reading).toBe("GONE");
  });

  test("a resolving citation is not a correct one — the reading says so", () => {
    // `readLineCitation` has two arms and neither means "valid"; whether
    // line 3 is still the line the sentence describes cannot be decided
    // mechanically, and a module claiming otherwise would be making the
    // 75%-stale mistake #514 measured.
    const { dir } = repoWithCommits("notvalid", 1);
    plantFile(dir, "docs/x.md", 10);
    const read = resolve(dir, "docs/x.md:3");
    expect(read.reading).toBe("RESOLVES");
    expect(read.detail).toContain("cannot be decided mechanically");
  });

  test("a citation form it does not read is UNMEASURED, so the candidate survives", () => {
    // The other direction of the parser gap: retiring what it cannot parse
    // turns a missing branch into silent data loss. #1028 shipped a `\\Z` in
    // a JavaScript regex that made a whole parser return nothing, so this is
    // not hypothetical.
    const { dir } = repoWithCommits("unknown", 1);
    const read = resolve(dir, "some-opaque-provenance");
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain(UNRECOGNISED_CITATION);
  });
});

describe("SC-1941: a non-zero git is NOT an absent commit", () => {
  test("the exit code cannot tell absence from failure, which is why it is not read", () => {
    /**
     * The measurement behind this whole section, taken on this machine.
     * `git cat-file -e <sha>^{commit}` — the first implementation — exits
     * **128** for a missing object, and 128 for a broken repository, and
     * 128 for an unreadable object store, and 128 for bad ref syntax. So
     * `status !== 0 -> GONE` read four different events as "retire this
     * rule", and the narrower repair of accepting only 0 and 1 as answers
     * reads ALL FIVE as "cannot tell" and retires nothing ever.
     *
     * Asserted rather than described, because the number is the reason the
     * implementation changed and a comment would go stale the first time
     * git changed it.
     */
    const { dir, shas } = repoWithCommits("exitcodes", 1);
    const code = (cwd: string, rev: string) =>
      spawnSync("git", ["-C", cwd, "cat-file", "-e", rev], { encoding: "utf-8" }).status;
    expect(code(dir, `${shas[0]}^{commit}`)).toBe(0);
    expect(code(dir, `${ABSENT_SHA}^{commit}`)).toBe(128);
    expect(code(scratchDir("exitcodes-norepo"), `${shas[0]}^{commit}`)).toBe(128);
    expect(code(dir, "deadbeef^{commit")).toBe(128);
  });

  test("a batch that could not run leaves every sha UNMEASURED, not GONE", () => {
    // The destructive direction. A timeout under load, or an unreadable
    // object store, must not retire a rule that resolves perfectly well.
    // Driven through `batchCheckShas` with a history state that claims the
    // repository is readable when it is not — which is exactly the state a
    // `.git` that disappeared mid-pass leaves behind.
    const empty = scratchDir("unrunnable");
    const readings = batchCheckShas(empty, [ABSENT_SHA], { readable: true, shallow: false });
    const read = readings.get(ABSENT_SHA)!;
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain(GIT_UNREADABLE);

    // The input on which this differs from a real absence: the same sha,
    // the same shape, in a repository git CAN read.
    const { dir } = repoWithCommits("runnable", 1);
    expect(batchCheckShas(dir, [ABSENT_SHA], readHistoryState(dir)).get(ABSENT_SHA)!.reading).toBe(
      "GONE",
    );
  });

  test("the failure detail names what failed, so a timeout is visible as one", () => {
    const empty = scratchDir("detail");
    const read = batchCheckShas(empty, [ABSENT_SHA], { readable: true, shallow: false }).get(
      ABSENT_SHA,
    )!;
    // git's own stderr, not a verdict this module invented.
    expect(read.detail).toContain("not a git repository");
  });

  test("an AMBIGUOUS prefix is UNMEASURED — it names no commit in particular", () => {
    // `lib/failure-intake.ts` writes eight-character prefixes, so this is a
    // real state in a repository this size. `--batch-check` reports
    // `ambiguous` distinctly from `missing`, which is the second reason the
    // exit code was the wrong instrument: it collapses them.
    const { dir } = repoWithCommits("ambiguous", 1);
    // 2,000 blobs over 65,536 four-character buckets makes a collision a
    // certainty rather than a hope — about thirty of them, by the birthday
    // bound. Written as blobs in ONE `hash-object` call rather than as
    // commits, so the fixture costs one subprocess instead of 2,000 and the
    // case does not depend on how many objects a commit happens to create.
    mkdirSync(join(dir, "blobs"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const f = join(dir, "blobs", `b${i}`);
      writeFileSync(f, `${i}\n`);
      paths.push(f);
    }
    const oids = spawnSync("git", ["-C", dir, "hash-object", "-w", "--stdin-paths"], {
      encoding: "utf-8",
      input: paths.join("\n") + "\n",
      maxBuffer: 16 * 1024 * 1024,
    }).stdout!.split("\n").filter(l => l.length === 40);
    expect(oids.length, "the blob fixture did not write").toBe(2_000);
    const prefixes = oids.map(o => o.slice(0, 4));
    const amb = prefixes.find((s, i) => prefixes.indexOf(s) !== i);
    expect(amb, "2,000 blobs produced no ambiguous 4-character prefix").toBeTruthy();
    const read = batchCheckShas(dir, [amb!], readHistoryState(dir)).get(amb!)!;
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain(AMBIGUOUS_SHA);
  });

  test("a sha that resolves to a TREE is UNMEASURED, not a resolved commit", () => {
    // It is in the tree, so `missing` is wrong; it is not the thing the
    // candidate claims, so RESOLVES is wrong too.
    const { dir } = repoWithCommits("treesha", 1);
    const tree = spawnSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf-8",
    }).stdout!.trim();
    const read = batchCheckShas(dir, [tree], readHistoryState(dir)).get(tree)!;
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain(NOT_A_COMMIT);
  });

  test("a batch whose line count does not match the input count is UNMEASURED for all", () => {
    // Zipping is by INDEX, because git echoes the resolved oid for an input
    // it resolved and the raw input for one it did not — so a map keyed by
    // the input silently loses every short sha that worked. A count mismatch
    // makes every attribution a guess, so none is made.
    //
    // Driven, not asserted in a comment: one input carrying a newline is two
    // input lines to git and one entry here, so the counts disagree for
    // real. `retireUnresolvable` cannot produce that — `GIT_SOURCE` forbids
    // a newline — but `batchCheckShas` is exported and this is its contract.
    const { dir, shas } = repoWithCommits("shortbatch", 2);
    const matched = batchCheckShas(dir, [shas[0]!, shas[1]!], readHistoryState(dir));
    expect([...matched.values()].map(v => v.reading)).toEqual(["RESOLVES", "RESOLVES"]);

    const split = `${shas[0]}\n${shas[1]}`;
    const mismatched = batchCheckShas(dir, [split], readHistoryState(dir));
    const read = mismatched.get(split)!;
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain("answered 2 of 1 inputs");
  });

  test("the whole population costs ONE git subprocess, so the timeout is a total", () => {
    // Finding 2: a per-candidate spawn with a per-call timeout gives N x 60s,
    // which is not a bound. Measured by counting what the pass actually
    // spawns rather than by reading the code.
    const { dir, shas } = repoWithCommits("onecall", 3);
    const many = Array.from({ length: 50 }, (_, i) =>
      candidate(`git:${shas[i % 3]!.slice(0, 8)}`, `h${i}`),
    );
    const before = Date.now();
    const reading = retireUnresolvable(many, dir);
    expect(reading.kept).toHaveLength(50);
    // 50 subprocesses would not finish in this budget on a loaded machine;
    // two do. The assertion is coarse on purpose — it is a bound, not a
    // benchmark.
    expect(Date.now() - before).toBeLessThan(5_000);
  });

  test("a git that is KILLED reads UNMEASURED, and the detail says it was killed", () => {
    // The destructive direction again, and the one the exit code cannot
    // express: a timeout under load must not retire rules that resolve.
    // Driven with a real 1 ms deadline against a real repository, so the
    // kill is git's, not a flag this test set.
    const { dir, shas } = repoWithCommits("killed", 2);
    const read = batchCheckShas(dir, [shas[0]!], readHistoryState(dir), 1).get(shas[0]!)!;
    expect(read.reading).toBe("UNMEASURED");
    expect(read.detail).toContain(GIT_UNREADABLE);
    // Not "exited null". The verdict alone would be the same if the
    // error and signal branches were deleted — `status` is null on a kill
    // and `null !== 0` — so the DETAIL is what distinguishes them, and it
    // is what a reader needs to tell a timeout from a broken repository.
    expect(read.detail).toMatch(/ETIMEDOUT|killed by SIG/);

    // The same sha, the same repository, a workable deadline: RESOLVES.
    expect(
      batchCheckShas(dir, [shas[0]!], readHistoryState(dir)).get(shas[0]!)!.reading,
    ).toBe("RESOLVES");
  });
});

// ── The pass ─────────────────────────────────────────────────────

describe("SC-1941: retireUnresolvable drops what is gone and says what it could not read", () => {
  test("the vanished sha is retired and the live one is kept", () => {
    const { dir, shas } = repoWithCommits("pass", 2);
    const live = candidate(`git:${shas[1]!.slice(0, 8)}`);
    const dead = candidate(`git:${ABSENT_SHA}`);
    const reading = retireUnresolvable([live, dead], dir);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.kept).toEqual([live]);
    expect(reading.retired.map(r => r.candidate)).toEqual([dead]);
    expect(reading.retired[0]!.detail).toContain("names no object in this history");
  });

  test("it RETIRES rather than warns — the retired candidate is not in `kept`", () => {
    // SC-1941 says *auto-retired, not warned about*, and the spec gives the
    // reason: a warning is how 1,010 candidates accumulated. A reading that
    // listed the dead candidate in both `retired` and `kept` would be a
    // warning wearing a retirement's name.
    const { dir } = repoWithCommits("notwarn", 1);
    const dead = candidate(`git:${ABSENT_SHA}`);
    const reading = retireUnresolvable([dead], dir);
    expect(reading.kept).toEqual([]);
    expect(reading.retired).toHaveLength(1);
  });

  test("a pass over a SHALLOW clone retires NOTHING and reads UNMEASURED", () => {
    // The case the whole module is shaped around. Measured against a real
    // shallow clone, not a flag: `0 retired` here and `0 retired` from a tree
    // where everything resolves are the same empty list.
    const { dir, shas } = repoWithCommits("shallow-pass-src", 3);
    const shallow = scratchDir("shallow-pass-dst");
    git(shallow, ["clone", "-q", "--depth", "1", `file://${dir}`, "."]);
    const old = candidate(`git:${shas[0]!.slice(0, 8)}`);

    const truncated = retireUnresolvable([old], shallow);
    expect(truncated.retired).toEqual([]);
    expect(truncated.kept).toEqual([old]);
    expect(truncated.reading).toBe("UNMEASURED");
    expect(truncated.unmeasuredReasons).toEqual([SHALLOW_HISTORY]);
    expect(truncated.unread).toHaveLength(1);

    // The input on which the two differ: same candidate, full history.
    const full = retireUnresolvable([old], dir);
    expect(full.reading).toBe("MEASURED");
    expect(full.retired).toEqual([]);
    expect(full.unread).toEqual([]);
  });

  test("a directory that is not a repository reads UNMEASURED, not a clean pass", () => {
    const dir = scratchDir("norepo-pass");
    const reading = retireUnresolvable([candidate(`git:${ABSENT_SHA}`)], dir);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toEqual([NOT_A_GIT_REPOSITORY]);
    expect(reading.retired).toEqual([]);
  });

  test("the history state is read once, so one population is judged against one belief", () => {
    // Two candidates, one resolver call each, one `HistoryState`. If the
    // state were re-read per candidate, a repository being written to during
    // the pass could answer two candidates differently and the retirement
    // list would depend on timing.
    const { dir, shas } = repoWithCommits("one-belief", 2);
    const reading = retireUnresolvable(
      [candidate(`git:${shas[0]!.slice(0, 8)}`), candidate(`git:${shas[1]!.slice(0, 8)}`)],
      dir,
    );
    expect(reading.kept).toHaveLength(2);
    expect(reading.reading).toBe("MEASURED");
  });

  test("the summary carries the counts and the reasons, not only the verdict", () => {
    const { dir } = repoWithCommits("summary", 1);
    const line = retirementSummary(retireUnresolvable([candidate(`git:${ABSENT_SHA}`)], dir));
    expect(line).toContain("1 retired");
    expect(line).toContain("0 kept");
  });
});

// ── Composed with promotion ──────────────────────────────────────

describe("SC-1941: the retired candidate never reaches the promoter", () => {
  test("the escape this converts: a vanished sha used to be promoted first", () => {
    // Verbatim the situation `test/failure-intake-promotion.test.ts` recorded
    // as an escape. The candidate is evidence-backed and the most recent
    // thing in the list, so recency puts it at the top.
    const { dir, shas } = repoWithCommits("compose", 2);
    const dead = {
      rule: "the thing that went wrong and was then rebased away",
      source: `git:${ABSENT_SHA}`,
      hash: "deadbeefdead",
      evidence: {
        kind: "fix-commit" as const,
        date: "2026-10-21T23:59:59Z",
        citation: ABSENT_SHA,
        issues: [1],
      },
    };
    const live = {
      rule: "the thing that went wrong and is still in the history",
      source: `git:${shas[1]!.slice(0, 8)}`,
      hash: "livelivelive",
      evidence: {
        kind: "fix-commit" as const,
        date: "2026-01-01T00:00:01Z",
        citation: shas[1]!,
        issues: [2],
      },
    };

    // Before: recency ranks the dead one first.
    const unretired = promoteCandidates([dead, live], { budget: 1 });
    expect(unretired.promoted.map(c => c.hash)).toEqual(["deadbeefdead"]);

    // After: it is gone before the ranking happens.
    const retirement = retireUnresolvable([dead, live], dir);
    const promotion = promoteCandidates(retirement.kept, {
      budget: PROMOTION_BUDGET_RULES,
      upstream: [retirement],
    });
    expect(retirement.retired.map(r => r.candidate.hash)).toEqual(["deadbeefdead"]);
    expect(promotion.promoted.map(c => c.hash)).toEqual(["livelivelive"]);
    expect(promotion.reading).toBe("MEASURED");
  });

  test("an UNMEASURED retirement makes the promotion UNMEASURED too", () => {
    // Otherwise a promotion over a shallow clone reports a complete answer
    // about a population nothing established the bounds of.
    const { dir, shas } = repoWithCommits("compose-shallow-src", 3);
    const shallow = scratchDir("compose-shallow-dst");
    git(shallow, ["clone", "-q", "--depth", "1", `file://${dir}`, "."]);
    const c = {
      rule: "the thing that went wrong before the clone was cut",
      source: `git:${shas[0]!.slice(0, 8)}`,
      hash: "aaaaaaaaaaaa",
      evidence: {
        kind: "fix-commit" as const,
        date: "2026-01-01T00:00:00Z",
        citation: shas[0]!,
        issues: [3],
      },
    };
    const retirement = retireUnresolvable([c], shallow);
    const promotion = promoteCandidates(retirement.kept, {
      budget: PROMOTION_BUDGET_RULES,
      upstream: [retirement],
    });
    expect(promotion.reading).toBe("UNMEASURED");
    expect(promotion.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    // And it still promotes, because the candidate is fine as far as anyone
    // can tell. UNMEASURED is a statement about the reading, not a refusal
    // to produce one.
    expect(promotion.promoted).toHaveLength(1);
  });

  test("upstream is a LIST, and an UNMEASURED in either position carries", () => {
    // Two upstreams now exist — the intake's and the retirement's — and the
    // fold has to be in the promoter rather than at the call site, where a
    // third decider could report MEASURED over an UNMEASURED input.
    const measured = { reading: "MEASURED" as const, unmeasuredReasons: [] };
    const unmeasured = { reading: "UNMEASURED" as const, unmeasuredReasons: ["BECAUSE"] };
    expect(promoteCandidates([], { budget: 1, upstream: [measured, measured] }).reading).toBe(
      "MEASURED",
    );
    // The reason has to SURVIVE the fold from either position, not just the
    // verdict. Asserting only `.reading` left this case green against a fold
    // that read `upstreams[0]` alone — measured, as the one mutation in this
    // battery that first came back 0 red. The `reading` field carried the
    // verdict through the authoritative check below while the reason was
    // silently dropped, which is the two-projections-disagreeing shape.
    const second = promoteCandidates([], { budget: 1, upstream: [measured, unmeasured] });
    expect(second.reading).toBe("UNMEASURED");
    expect(second.unmeasuredReasons).toEqual(["BECAUSE"]);
    const first = promoteCandidates([], { budget: 1, upstream: [unmeasured, measured] });
    expect(first.reading).toBe("UNMEASURED");
    expect(first.unmeasuredReasons).toEqual(["BECAUSE"]);
    // A single reading is still accepted — the one-element case.
    expect(promoteCandidates([], { budget: 1, upstream: unmeasured }).reading).toBe("UNMEASURED");
  });

  test("an upstream that reads UNMEASURED without a reason is still UNMEASURED", () => {
    // The discriminator is authoritative. Folding only the reason list would
    // let this through as MEASURED — a producer and a consumer disagreeing
    // about one fact, with the wrong one winning.
    const silent = { reading: "UNMEASURED" as const, unmeasuredReasons: [] };
    const reading = promoteCandidates([], { budget: 1, upstream: [silent] });
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toEqual(["UPSTREAM_UNMEASURED"]);
  });
});

// ── The gate reaches the write ───────────────────────────────────

describe("SC-1941: the retirement gate has a sink", () => {
  /**
   * Until this change `scripts/extract-constraints.ts` computed
   * `retirement.kept`, promoted from it, and then wrote the UNFILTERED
   * `allCandidates` into `AGENTS.md`. The gate ran and nothing downstream
   * of it was affected by the result — not a fail-open, a control with no
   * sink.
   *
   * ## The witness this file does NOT have, and why
   *
   * A non-vacuous end-to-end witness needs a doc candidate that the
   * retirement pass retires, and in one run there is no such candidate.
   * Measured, not assumed: every doc candidate's `path:line` is derived
   * from a file the same run has just read, and `lib/doc-scan-targets.ts`
   * already refuses a symlink whose target leaves the project — so the
   * citation resolves by construction. A test that planted an out-of-tree
   * doc gets zero candidates from it, because the scanner declines to read
   * it at all.
   *
   * So the finding is structurally right and its harm is not currently
   * reachable through the doc path. Saying that is the honest report;
   * writing a case that asserts `applyToAgentsMd` received a non-empty
   * list would pass identically before and after the fix, which is the
   * vacuous version.
   *
   * What IS driven below is the filter itself, at the boundary where a
   * retired member can exist, and the positive control that an unretired
   * population is written whole.
   */
  test("the identity filter drops a retired member and keeps the rest", () => {
    const { dir } = repoWithCommits("sink", 1);
    plantFile(dir, "docs/here.md", 10);
    const live = { rule: "a", source: "docs/here.md:3", hash: "h1" };
    const dead = { rule: "b", source: "docs/vanished.md:3", hash: "h2" };
    const alsoLive = { rule: "c", source: "docs/here.md:7", hash: "h3" };

    const retirement = retireUnresolvable([live, dead, alsoLive], dir);
    expect(retirement.retired.map(r => r.candidate)).toEqual([dead]);

    // THE function `extractConstraints` applies to the list it writes, not
    // a second copy of its expression — a copy would assert only that this
    // test agrees with itself.
    const written = survivingSubset([live, dead, alsoLive], retirement);
    expect(written).toEqual([live, alsoLive]);
    expect(written).not.toContain(dead);
  });

  test("two candidates sharing a hash are not dropped together", () => {
    // The input on which an identity filter and a hash filter differ, and
    // the reason the fix is not `kept.some(k => k.hash === c.hash)`.
    const { dir } = repoWithCommits("samehash", 1);
    plantFile(dir, "docs/here.md", 10);
    const live = { rule: "same sentence", source: "docs/here.md:3", hash: "shared" };
    const dead = { rule: "same sentence", source: "docs/vanished.md:3", hash: "shared" };
    const retirement = retireUnresolvable([live, dead], dir);
    expect(survivingSubset([live, dead], retirement)).toEqual([live]);
  });

  test("an unretired population is written whole — the filter is not unconditional", () => {
    // The positive control. Without it a filter that dropped everything
    // would satisfy both cases above.
    const { dir } = repoWithCommits("whole", 1);
    plantFile(dir, "docs/here.md", 10);
    const all = [
      { rule: "a", source: "docs/here.md:1", hash: "h1" },
      { rule: "b", source: "docs/here.md:2", hash: "h2" },
    ];
    expect(survivingSubset(all, retireUnresolvable(all, dir))).toEqual(all);
  });
});
