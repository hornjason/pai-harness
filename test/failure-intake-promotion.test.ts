/**
 * Covers SC-1939 (RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md), for #544 and
 * #545.
 *
 * #545 produces candidates that carry a dated observation; #544 decides which
 * of them survive and which are evicted. This file drives both ends over real
 * git repositories built under `mkdtemp`, never over hand-written candidate
 * lists — #545 says so by name: *"short-circuiting the revert scanner to
 * `return []` must turn tests red against a fixture repo that actually
 * contains a revert, not against a hand-written candidate list."*
 *
 * ## Where the corpus comes from, and why that matters
 *
 * Every subject in `REAL_FIX_SUBJECTS` and `REAL_OTHER_SUBJECTS` below is a
 * verbatim commit subject from `hornjason/pai-harness` `main`, read with
 * `git log --format=%s` and pasted unchanged. None is generated from, or
 * spelled after, the patterns in `lib/failure-intake.ts`.
 *
 * That is not pedantry. `.claude/rules/checks-must-be-able-to-fail.md` records
 * a battery that measured 0 because its witnesses were built out of the very
 * array under test: the mutant plants the mutant's own spelling, and the two
 * agree with each other no matter what either says. A corpus read from the
 * emitting module cannot see that module drift.
 *
 * ## Running it the way CI runs it
 *
 * The fixture builder neutralises ambient git configuration on every run —
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at `/dev/null`, identity passed
 * with `-c` — so a repository is built the same way on a laptop with a
 * populated `~/.gitconfig` and on a runner with an empty `HOME`. A fixture
 * that only builds because the developer has `user.email` set is a fixture
 * that does not exist in CI, and a test whose input is absent there has no
 * failing input there.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyCommitSubject,
  mineFixCommits,
  NOT_A_GIT_REPOSITORY,
  SHALLOW_HISTORY,
  GIT_LOG_FAILED,
  type EvidenceCandidate,
} from "../lib/failure-intake";
import {
  promoteCandidates,
  rankForPromotion,
  promotionSummary,
  PROMOTION_BUDGET_RULES,
  NON_POSITIVE_BUDGET,
  type PromotableCandidate,
} from "../lib/rule-promotion";

// ── The corpus ───────────────────────────────────────────────────

/**
 * Verbatim `fix:` subjects from `main`. Four of the five are the commits that
 * produced the hand-written rules in the fleet's own notes, which is the
 * argument for mining this source at all: the sentence an agent needs was
 * already written, by the person who fixed the thing, on the day they fixed
 * it.
 */
const REAL_FIX_SUBJECTS = [
  "fix(#506): CONFIG-1 reads the source it could not reach, instead of refusing over it (#975)",
  "fix(#957, #955): the merge can tell its own old output from the consumer's, and puts back what #941 dropped (#972)",
  "fix(#960): the drift reading stops consulting a config the reviewer can write (#965)",
  "fix(#921): take the containment reading off $HOME (#936)",
  "fix(#926, #962): give the bookkeeping list a reachability witness, and drop a dead import (#964)",
] as const;

/**
 * Verbatim NON-`fix` subjects from the same stretch of `main`. A corpus in
 * which everything matches cannot witness a detector that has been widened
 * until it refuses nothing, so these are controls and not filler.
 */
const REAL_OTHER_SUBJECTS = [
  "feat(#892): the collect refusal says whether the copies it refuses are the same bytes (#950)",
  "feat(#804): a suite margin reading over reports that exist (#811)",
] as const;

/**
 * Two real commits from `main` whose committer dates carry DIFFERENT offsets,
 * chosen so that BOTH of the cheap orderings get them the wrong way round:
 * a descending string compare, and a sort that fell back to the content hash.
 *
 * The pair was selected that way on purpose, and the case below asserts both
 * properties before it asserts anything else. An earlier pair discriminated
 * the string compare and happened to have its hashes in the right order, so
 * the hash-order mutation came back green over it — the margin set by
 * something outside the case (#507's shape, in a fixture).
 */
const MIXED_OFFSET = {
  /** 2026-10-21T15:01:51-04:00 is 19:01:51Z — the LATER of the two instants. */
  later: {
    date: "2026-10-21T15:01:51-04:00",
    subject: "fix(#910, #713): read every settings scope, and make a fired hook leave evidence (#970)",
  },
  /** 17:06:12Z is the earlier instant, and sorts FIRST under a string compare. */
  earlier: {
    date: "2026-10-21T17:06:12Z",
    subject: "fix(#940): the generated CI workflows can be re-run on demand (#945)",
  },
} as const;

// ── Fixture repositories ─────────────────────────────────────────

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rungate-failure-intake-${label}-`));
  scratch.push(dir);
  return dir;
}

/**
 * Run git with ambient configuration neutralised and an identity supplied, so
 * the fixture builds identically under an empty `HOME`. Throws on failure:
 * a fixture that half-built is the worst input a test can have, because every
 * assertion downstream of it is then measuring the fixture.
 */
function git(cwd: string, args: string[]): string {
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

/**
 * A repository whose history is the given subjects, oldest first, each one
 * second apart so the committer dates are strictly ordered.
 */
function repoWith(label: string, subjects: readonly string[]): string {
  const dir = scratchDir(label);
  git(dir, ["init", "-q", "-b", "main"]);
  subjects.forEach((subject, i) => {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, ["add", "-A"]);
    // One second apart, so `%cI` is strictly increasing and a test about
    // recency has an ordering to be right or wrong about. Commits made in the
    // same second give git a tie the reading cannot break, which would make
    // the eviction case pass or fail on how fast the machine is.
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
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
        dir,
        "commit",
        "-q",
        "-m",
        subject,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_COMMITTER_DATE: stamp,
          GIT_AUTHOR_DATE: stamp,
        },
      },
    );
    if (r.status !== 0) {
      throw new Error(`fixture commit failed: ${(r.stderr ?? "").trim()}`);
    }
  });
  return dir;
}

// ── The detector ─────────────────────────────────────────────────

describe("#545 classifyCommitSubject — the detector", () => {
  test("every real fix subject on main is classified, and the description is cut out of it", () => {
    // The control first: the corpus has to be non-empty and the classifier has
    // to see all of it, or every assertion below holds over nothing.
    expect(REAL_FIX_SUBJECTS.length).toBeGreaterThan(0);
    const classified = REAL_FIX_SUBJECTS.map((s) => classifyCommitSubject(s));
    expect(classified.filter((c) => c === null)).toEqual([]);

    for (const [i, c] of classified.entries()) {
      expect(c!.kind).toBe("fix-commit");
      // The rule is the sentence, not the subject: the `fix(#N):` prefix and
      // the squash merge's trailing `(#PR)` are both gone. Asserting the rule
      // is merely non-empty would be satisfied by returning the whole subject.
      expect(c!.rule).not.toBe(REAL_FIX_SUBJECTS[i]);
      expect(c!.rule.startsWith("fix")).toBe(false);
      expect(c!.rule).not.toMatch(/\(#\d+\)$/);
    }

    // One exact reading, spelled out, so a widening that starts returning the
    // whole subject cannot hide behind the shape assertions above.
    expect(classifyCommitSubject(REAL_FIX_SUBJECTS[0])).toEqual({
      kind: "fix-commit",
      rule: "CONFIG-1 reads the source it could not reach, instead of refusing over it",
      issues: [506, 975],
    });
  });

  test("every `#N` the subject cites is collected, in order, deduplicated", () => {
    // Two issue numbers in the scope, one in the prose, one trailing PR.
    expect(classifyCommitSubject(REAL_FIX_SUBJECTS[1])!.issues).toEqual([957, 955, 941, 972]);
  });

  test("a real `feat:` subject is NOT classified — the control on widening", () => {
    expect(REAL_OTHER_SUBJECTS.length).toBeGreaterThan(0);
    for (const subject of REAL_OTHER_SUBJECTS) {
      expect(classifyCommitSubject(subject)).toBeNull();
    }
  });

  test("a revert is classified as a revert, and carries the reverted subject's text", () => {
    const reverted = classifyCommitSubject(`Revert "${REAL_FIX_SUBJECTS[2]}"`);
    expect(reverted).not.toBeNull();
    expect(reverted!.kind).toBe("revert-commit");
    expect(reverted!.rule).toBe("the drift reading stops consulting a config the reviewer can write");
  });

  test("a subject that merely mentions the word fix is not a fix commit", () => {
    expect(classifyCommitSubject("docs: explain how to fix a broken worktree")).toBeNull();
    expect(classifyCommitSubject("chore: bump deps")).toBeNull();
  });
});

// ── The reading, and the three states that are refusals ──────────

describe("#545 mineFixCommits — the reading says what it could not read", () => {
  test("a repository of real fix commits is MEASURED, and every candidate carries its evidence", () => {
    const dir = repoWith("mixed", [...REAL_OTHER_SUBJECTS, ...REAL_FIX_SUBJECTS]);
    const reading = mineFixCommits(dir);

    // Instrument first: a reading over zero commits produces an empty
    // candidate list for a reason that has nothing to do with the detector.
    expect(reading.commitsScanned).toBe(REAL_OTHER_SUBJECTS.length + REAL_FIX_SUBJECTS.length);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.unmeasuredReasons).toEqual([]);

    expect(reading.candidates.length).toBe(REAL_FIX_SUBJECTS.length);
    for (const c of reading.candidates) {
      expect(c.evidence.kind).toBe("fix-commit");
      expect(c.evidence.citation).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(Date.parse(c.evidence.date))).toBe(false);
      expect(c.evidence.issues.length).toBeGreaterThan(0);
      expect(c.source).toBe(`git:${c.evidence.citation.slice(0, 8)}`);
      expect(c.hash).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test("a revert in a real history produces a candidate citing the revert commit", () => {
    // #545 names this fixture explicitly: a revert scanner must be measured
    // against a repository that contains a revert.
    const dir = repoWith("revert", [
      REAL_FIX_SUBJECTS[3],
      `Revert "${REAL_FIX_SUBJECTS[3]}"`,
    ]);
    const reading = mineFixCommits(dir);
    expect(reading.reading).toBe("MEASURED");
    const kinds = reading.candidates.map((c) => c.evidence.kind).sort();
    expect(kinds).toEqual(["fix-commit", "revert-commit"]);

    // This case is why the dedup key carries the kind and the hash does not,
    // and it is the first red this battery produced. The two candidates share
    // a SENTENCE — so one veto removes both, which is the intended reading of
    // the permanent-veto criterion — and they are different OBSERVATIONS,
    // so both are mined.
    const hashes = new Set(reading.candidates.map((c) => c.hash));
    expect(hashes.size).toBe(1);
    const vetoed = promoteCandidates(reading.candidates, {
      budget: PROMOTION_BUDGET_RULES,
      rejectedHashes: hashes,
    });
    expect(vetoed.promoted).toEqual([]);
    expect(vetoed.withheld.map((w) => w.reason)).toEqual(["REJECTED", "REJECTED"]);
  });

  test("a directory that is not a repository is UNMEASURED, not an empty result", () => {
    const dir = scratchDir("bare");
    const reading = mineFixCommits(dir);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toEqual([NOT_A_GIT_REPOSITORY]);
    expect(reading.candidates).toEqual([]);
  });

  test("a repository with no commits at all is UNMEASURED, not a history with no fixes", () => {
    const dir = scratchDir("empty");
    git(dir, ["init", "-q", "-b", "main"]);
    const reading = mineFixCommits(dir);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons.some((r) => r.startsWith(GIT_LOG_FAILED))).toBe(true);
  });

  test("a SHALLOW clone is UNMEASURED — the state every CI runner is in by default", () => {
    // `.github/workflows/ci.yml` uses `actions/checkout@v4` with no
    // `fetch-depth`, which is depth 1. Without this refusal the intake reads
    // one commit on every CI run and reports an empty candidate list that is
    // indistinguishable from a repository with nothing to mine.
    const origin = repoWith("deep", REAL_FIX_SUBJECTS);
    const target = join(scratchDir("shallow-parent"), "clone");
    const r = spawnSync(
      "git",
      ["clone", "-q", "--depth=1", `file://${origin}`, target],
      {
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      },
    );
    if (r.status !== 0) throw new Error(`fixture clone failed: ${r.stderr}`);

    const reading = mineFixCommits(target);
    expect(reading.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    expect(reading.reading).toBe("UNMEASURED");
    // The candidates it DID find are still returned. Withholding them would
    // make a truncated history and an empty one look alike from outside.
    expect(reading.candidates.length).toBe(1);
    expect(reading.commitsScanned).toBe(1);

    // And the control, so the row above is a measurement of the DEPTH and not
    // of anything else: the same history, unshallowed, is MEASURED and holds
    // every one of them.
    const full = mineFixCommits(origin);
    expect(full.reading).toBe("MEASURED");
    expect(full.candidates.length).toBe(REAL_FIX_SUBJECTS.length);
  });

  test("the same history mined twice produces identical candidates", () => {
    // Idempotency over the intake. The spec's byte-identical-rules-directory
    // criterion is a wider claim about the scaffold and nothing here performs
    // a scaffold run, so this covers a part of it and does not claim it.
    const dir = repoWith("idempotent", REAL_FIX_SUBJECTS);
    expect(mineFixCommits(dir)).toEqual(mineFixCommits(dir));
  });

  test("a sentence committed twice yields one candidate, and it is the newer commit", () => {
    const dir = repoWith("dupe", [REAL_FIX_SUBJECTS[0], REAL_FIX_SUBJECTS[0]]);
    const reading = mineFixCommits(dir);
    expect(reading.commitsScanned).toBe(2);
    expect(reading.candidates.length).toBe(1);
    const shas = git(dir, ["log", "--format=%H"]).trim().split("\n");
    expect(reading.candidates[0].evidence.citation).toBe(shas[0]);
  });
});

// ── The promotion criterion ──────────────────────────────────────

function prose(rule: string): PromotableCandidate {
  // Shaped exactly like what `extractSignalPhrases` emits: no `evidence` key.
  return { rule, source: "CLAUDE.md:12", hash: `prose${rule.length}`.padEnd(12, "0") };
}

describe("#544 promoteCandidates — evidence is a gate, not a tiebreak", () => {
  test("SC-1939: a candidate with no evidence is never promoted, at any budget", () => {
    const dir = repoWith("gate", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    expect(mined.candidates.length).toBeGreaterThan(0);

    const docs = [
      prose("All configuration reads must go through the loader"),
      prose("Never commit secrets or credentials to the repository"),
      prose("Tests must always be written before the implementation"),
    ];

    // A budget with room to spare for every candidate of both kinds. If
    // evidence were a tiebreak rather than a gate, all of them would land.
    const budget = mined.candidates.length + docs.length + 5;
    const reading = promoteCandidates([...mined.candidates, ...docs], { budget });

    expect(reading.promoted.length).toBe(mined.candidates.length);
    expect(reading.promoted.filter((c) => !c.evidence)).toEqual([]);
    const refused = reading.withheld.filter((w) => w.reason === "NO_EVIDENCE");
    expect(refused.map((w) => w.candidate.rule).sort()).toEqual(docs.map((d) => d.rule).sort());
  });

  test("SC-1939: the weaker form too — no evidence-less candidate outranks an evidence-backed one", () => {
    // Asserted on the ORDER as well as on admission, because the spec states
    // the criterion as an ordering and a future relaxation of the gate must
    // not silently take the ordering with it.
    const dir = repoWith("order", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    const reading = promoteCandidates([prose("Always verify before asserting"), ...mined.candidates], {
      budget: PROMOTION_BUDGET_RULES,
    });
    const firstWithoutEvidence = reading.promoted.findIndex((c) => !c.evidence);
    expect(firstWithoutEvidence).toBe(-1);
  });

  test("a hash in the veto table is withheld as REJECTED and never promoted", () => {
    // The never-re-promoted half of the spec's permanent-veto criterion. The
    // criterion also requires a rejection to WRITE the hash to
    // `reference/rejected-constraints.md`, and nothing in this increment
    // writes it — that file does not exist in this repository. So the id is
    // deliberately not claimed anywhere in this file: crediting half a
    // criterion is the failure `.claude/rules/claiming-sc-coverage.md` says
    // to err away from.
    const dir = repoWith("veto", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    const vetoed = mined.candidates[0];
    const reading = promoteCandidates(mined.candidates, {
      budget: PROMOTION_BUDGET_RULES,
      rejectedHashes: new Set([vetoed.hash]),
    });

    expect(reading.promoted.map((c) => c.hash)).not.toContain(vetoed.hash);
    expect(reading.withheld.filter((w) => w.reason === "REJECTED").map((w) => w.candidate.hash))
      .toEqual([vetoed.hash]);
    // The veto outranks the evidence, which is the whole point of a veto: the
    // candidate it removes is evidence-backed and would otherwise be promoted.
    expect(vetoed.evidence).toBeDefined();
  });

  test("the budget evicts, and it evicts the OLDEST evidence", () => {
    const dir = repoWith("evict", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    expect(mined.candidates.length).toBe(5);

    const reading = promoteCandidates(mined.candidates, { budget: 2 });
    expect(reading.reading).toBe("MEASURED");
    expect(reading.promoted.length).toBe(2);
    expect(reading.withheld.filter((w) => w.reason === "OVER_BUDGET").length).toBe(3);

    // Named, not counted: `3 evicted` is satisfied by evicting the wrong
    // three. The two kept must be the two most recent commits in the history.
    const newestFirst = git(dir, ["log", "--format=%H"]).trim().split("\n").slice(0, 2);
    expect(reading.promoted.map((c) => c.evidence!.citation)).toEqual(newestFirst);
  });

  test("a non-positive budget is UNMEASURED, not an empty promotion", () => {
    const dir = repoWith("nobudget", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    const reading = promoteCandidates(mined.candidates, { budget: 0 });
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toContain(NON_POSITIVE_BUDGET);
    expect(reading.promoted).toEqual([]);
  });

  test("an UNMEASURED intake makes the promotion UNMEASURED, however many it promoted", () => {
    const dir = repoWith("upstream", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    const reading = promoteCandidates(mined.candidates, {
      budget: PROMOTION_BUDGET_RULES,
      upstream: { reading: "UNMEASURED", unmeasuredReasons: [SHALLOW_HISTORY] },
    });
    expect(reading.promoted.length).toBeGreaterThan(0);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    expect(promotionSummary(reading)).toContain(SHALLOW_HISTORY);
  });

  test("ranking parses dates — two real commits whose offsets differ sort by instant, not by string", () => {
    const later = evidenceCandidate(MIXED_OFFSET.later.subject, MIXED_OFFSET.later.date, "a".repeat(40));
    const earlier = evidenceCandidate(MIXED_OFFSET.earlier.subject, MIXED_OFFSET.earlier.date, "b".repeat(40));

    // The two preconditions that make this case a witness rather than a
    // coincidence, asserted here so they cannot stop being true in silence.
    //
    // 15:01:51-04:00 is 19:01:51Z and is the LATER instant, while '15' sorts
    // below '17' — so a descending STRING compare gets it wrong. And the
    // later commit's content hash is the GREATER of the two, so a sort that
    // fell back to hash order gets it wrong as well.
    expect(Date.parse(later.evidence.date)).toBeGreaterThan(Date.parse(earlier.evidence.date));
    expect(later.evidence.date > earlier.evidence.date).toBe(false);
    expect(later.hash > earlier.hash).toBe(true);

    expect([earlier, later].sort(rankForPromotion)[0].evidence!.date).toBe(MIXED_OFFSET.later.date);
    expect([later, earlier].sort(rankForPromotion)[0].evidence!.date).toBe(MIXED_OFFSET.later.date);

    // And through the budget, which is where it costs something: with room
    // for one, the one kept is the later commit.
    const reading = promoteCandidates([earlier, later], { budget: 1 });
    expect(reading.promoted[0].evidence!.date).toBe(MIXED_OFFSET.later.date);
  });

  test("ranking is deterministic for candidates sharing an instant", () => {
    const a = evidenceCandidate(REAL_FIX_SUBJECTS[0], MIXED_OFFSET.earlier.date, "c".repeat(40));
    const b = evidenceCandidate(REAL_FIX_SUBJECTS[1], MIXED_OFFSET.earlier.date, "d".repeat(40));
    expect([a, b].sort(rankForPromotion).map((c) => c.hash)).toEqual(
      [b, a].sort(rankForPromotion).map((c) => c.hash),
    );
  });
});

function evidenceCandidate(subject: string, date: string, sha: string): EvidenceCandidate {
  const classified = classifyCommitSubject(subject);
  if (!classified) throw new Error(`fixture subject is not classified: ${subject}`);
  // Hash derived through the same producer the real path uses, so a candidate
  // built here cannot differ in shape from one the miner emits.
  const mined = mineFixCommits(repoWith(`one-${sha.slice(0, 4)}`, [subject]));
  expect(mined.candidates.length).toBe(1);
  return {
    ...mined.candidates[0],
    source: `git:${sha.slice(0, 8)}`,
    evidence: { ...mined.candidates[0].evidence, date, citation: sha },
  };
}

// ── WHAT THIS DOES NOT COVER ─────────────────────────────────────

describe("WHAT THIS DOES NOT COVER — the classifier's measured escapes", () => {
  // Each case below asserts an escape the shipped code leaves open. They are
  // here so the boundary is measured rather than described: a documented
  // limitation nobody ran is a sentence, and the next person to widen the
  // detector needs to know which direction it is already wrong in.

  test("ESCAPE: a trivial fix is mined as though it were an incident", () => {
    const trivial = classifyCommitSubject("fix(#1): the typo in the README heading (#2)");
    expect(trivial).not.toBeNull();
    expect(trivial!.kind).toBe("fix-commit");
    // It carries a sha, a date and two issue numbers, so it outranks every
    // doc-prose candidate in the repository. Nothing here reads the diff.
  });

  test("ESCAPE: a defect fixed under `feat:` is invisible to the miner", () => {
    // This subject is on `main` and is as rule-shaped as any `fix:` in the
    // corpus. Widening to every conventional type would admit `chore` and
    // `docs` with it, so the false negative is kept deliberately.
    expect(classifyCommitSubject(REAL_OTHER_SUBJECTS[0])).toBeNull();
  });

  test("ESCAPE: a revert of a revert is a re-land and is still read as a failure", () => {
    const reland = classifyCommitSubject(`Revert "Revert \\"${REAL_FIX_SUBJECTS[0]}\\""`);
    expect(reland).not.toBeNull();
    expect(reland!.kind).toBe("revert-commit");
  });

  test("ESCAPE: a fix with no description is dropped silently, counted and nowhere else", () => {
    expect(classifyCommitSubject("fix(#5):")).toBeNull();
    const dir = repoWith("nodesc", ["fix(#5): oops", ...REAL_FIX_SUBJECTS]);
    const reading = mineFixCommits(dir);
    expect(reading.commitsScanned).toBe(REAL_FIX_SUBJECTS.length + 1);
    expect(reading.candidates.length).toBe(REAL_FIX_SUBJECTS.length);
    expect(reading.unmeasuredReasons).toEqual([]);
  });

  test("ESCAPE: the budget is a count of rules, not the concurrent-load reading", () => {
    // The max-concurrent-load budget the spec specifies is the criterion
    // numbered one below the first budget id in that section, and nothing
    // here computes it: no `paths:` globs are emitted, so there is no glob to
    // intersect with the file list. A count is strictly more pessimistic, so
    // this cannot under-report — it can refuse a set that path-scoping would
    // have made fine.
    expect(PROMOTION_BUDGET_RULES).toBe(16);
    const dir = repoWith("count", REAL_FIX_SUBJECTS);
    const mined = mineFixCommits(dir);
    const reading = promoteCandidates(mined.candidates, { budget: 1 });
    expect(reading.promoted.length).toBe(1);
    // Every candidate mined from a commit subject carries no `paths`, so a
    // concurrent-load budget would currently see all of them loading at once
    // and agree with the count. The two diverge only once scoping exists.
    expect(reading.promoted.every((c) => !("paths" in c))).toBe(true);
  });

  test("ESCAPE: nothing checks whether the cited evidence still resolves", () => {
    // Auto-retirement of a rule whose citation no longer resolves is a
    // criterion this spec states and this increment does not implement.
    const candidate = evidenceCandidate(
      REAL_FIX_SUBJECTS[4],
      MIXED_OFFSET.later.date,
      "0".repeat(40),
    );
    // A sha that is in no repository anywhere. It is promoted regardless.
    const reading = promoteCandidates([candidate], { budget: PROMOTION_BUDGET_RULES });
    expect(reading.promoted.length).toBe(1);
    expect(reading.reading).toBe("MEASURED");
  });
});

// ── The production caller ────────────────────────────────────────

describe("#544/#545 the wiring: extractConstraints is the one function both callers go through", () => {
  test("a scaffolded project directory gets an intake reading and a promotion reading", async () => {
    const { extractConstraints } = await import("../scripts/extract-constraints");
    const dir = repoWith("wired", [...REAL_FIX_SUBJECTS, ...REAL_OTHER_SUBJECTS]);
    mkdirSync(join(dir, "specs"), { recursive: true });
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# fixture\n\n## Hard Constraints\n\n- nothing yet\n",
    );
    // One document carrying a signal phrase, so the doc population is not
    // empty: an evidence gate that withholds nothing because there is nothing
    // to withhold is the vacuous half of this claim.
    writeFileSync(
      join(dir, "specs", "fixture.md"),
      "# fixture spec\n\n- The container must always be rebuilt before promotion\n",
    );

    const result = await extractConstraints(dir, { apply: false });

    expect(result.evidence.reading).toBe("MEASURED");
    expect(result.evidence.candidates.length).toBe(REAL_FIX_SUBJECTS.length);
    expect(result.candidates.length).toBeGreaterThan(0);

    // The headline: the doc candidates reach the promoter and not one of them
    // survives the criterion. That is the measurement #544 is about, produced
    // by the real pipeline rather than described.
    expect(result.promotion.reading).toBe("MEASURED");
    expect(result.promotion.promoted.map((c) => c.source).every((s) => s.startsWith("git:"))).toBe(true);
    const withheldProse = result.promotion.withheld.filter((w) => w.reason === "NO_EVIDENCE");
    expect(withheldProse.length).toBe(result.candidates.length);
  });
});
