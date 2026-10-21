/**
 * #987: the generated CI jobs clone to depth 1, so the failure intake reports
 * UNMEASURED on every runner.
 *
 * The defect is not that a reading was occasionally missing. It is that the
 * reading has been **uniformly absent** since `lib/failure-intake.ts` shipped,
 * on every run of every workflow this harness generates, and absence looked
 * like quiet.
 *
 * ## What is driven, and what is merely read
 *
 * Nothing here asserts a template literal of the YAML. Two kinds of case:
 *
 * - **Parsed** — the real `createCiWorkflows` writes a workflow into a planted
 *   project, and the real `parseCheckoutModel` / `suiteJobName` from
 *   `lib/ci-checkout.ts` read it back. The generator and the reader are the
 *   two the production code already uses; a third copy of "what depth does
 *   this job use" here would survive any mutation of either.
 * - **Executed** — a real git repository is built under `mkdtemp`, cloned to
 *   the model the generated workflow declares using the real
 *   `ciCheckoutPlan` / `executeCheckoutPlan`, and the real `mineFixCommits` is
 *   run against the result. That is the only case that can tell a prediction
 *   from a fact, and it is what holds `ciHistoryReading` to the intake instead
 *   of letting the two agree with each other.
 *
 * ## Why there is no skip in this file
 *
 * UNMEASURED failing rather than skipping is literally #987's subject, so a
 * case here that skipped when the ambient checkout was shallow would be the
 * defect, reintroduced by its own regression test. Every fixture builds its
 * own repository; none reads the repository this file lives in, and none is
 * conditional.
 *
 * ## What was broken to prove it
 *
 * Run and counted over this file + `test/commit-classifier-rates.test.ts`
 * (38 tests), under `HOME` at an empty `mkdtemp`. Every count AND the named
 * set of reddened assertions was predicted before the battery ran. **The
 * baseline row was read first** — and had to be read twice, because the first
 * instrument reported a blank: the harness word-split its file list in zsh,
 * which does not split an unquoted variable, so bun received one argument
 * naming no file. A blank is not a zero.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** | 38 pass, 0 fail | **38 pass, 0 fail** | — |
 * | M1 `ciHistoryReading` short-circuited to MEASURED | 9 | **9 of 38** | `{depth: 1, fetches: []}` — original UNMEASURED, mutant MEASURED |
 * | M2 `CI_SUITE_FETCH_DEPTH` back to `1`, the pre-#987 value | 4 | **4 of 38** | the freshly generated `ci.yml` — original emits full history, mutant emits depth 1 and a bounded fetch |
 * | M3 `baseRefFetchDepth` always `200` | 4 | **4 of 38** | `baseRefFetchDepth(0)` — original `null`, mutant `200`: the inert fix, generated |
 * | M4 the `RESHALLOWED_BY_FETCH` loop deleted | 3 | **3 of 38** | `{depth: null, fetches: [{depth: 200}]}` — original UNMEASURED, mutant MEASURED |
 * | M5 the `SHALLOW_CHECKOUT` branch deleted | 7 | **7 of 38** | `{depth: 1, fetches: []}`, as M1 |
 *
 * Every row reddened exactly the assertions predicted. M2 is the issue's own
 * acceptance — *"setting the depth back to 1 reds the case, with the count
 * recorded"* — and M3 is the inert fix, which is the repair a reader of #987
 * would reach for first.
 *
 * **Which cells are witnesses and which are controls.** `AC-4: the control:
 * the source repository itself is MEASURED` is a positive control: it reds
 * only if the fixture broke, and it DID red in the classifier battery next
 * door, which is the control doing its job rather than a finding.
 * `AC-3: the emitted depth is the declaration` is an INSTRUMENT control — it
 * compares the emitted YAML to `CI_SUITE_FETCH_DEPTH` on both sides, so M2
 * cannot red it; it witnesses that the generator reads the declaration, never
 * that the value is right. `AC-1: #987's own proposal` spells
 * `MAX_COMMITS_SCANNED` on both sides and is likewise insensitive to that
 * constant's VALUE; the assertion bound to the number is AC-4's
 * `expect(MAX_COMMITS_SCANNED).toBeGreaterThan(COMMITS)`.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `lib/ci-history-depth.ts` was confirmed byte-identical by sha256
 * afterwards.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createCiWorkflows } from "../lib/scaffold/steps";
import {
  ciCheckoutPlan,
  executeCheckoutPlan,
  parseCheckoutModel,
  suiteJobName,
  type CheckoutModel,
} from "../lib/ci-checkout";
import {
  MAX_COMMITS_SCANNED,
  SHALLOW_HISTORY,
  mineFixCommits,
} from "../lib/failure-intake";
import {
  CI_SUITE_FETCH_DEPTH,
  RESHALLOWED_BY_FETCH,
  SHALLOW_CHECKOUT,
  baseRefFetchDepth,
  ciHistoryReading,
} from "../lib/ci-history-depth";

const scratch: string[] = [];
function scratchDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `rungate-987-${label}-`));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/**
 * Ambient git configuration neutralised on every call, the way
 * `test/failure-intake-promotion.test.ts` does it: a fixture that only builds
 * because the developer has `user.email` set is a fixture that does not exist
 * under the empty `HOME` CI runs with.
 */
function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-C", cwd, ...args],
    {
      encoding: "utf-8",
      maxBuffer: 1 << 26,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Four subjects read verbatim off `hornjason/pai-harness` main, never spelled after the regex they feed. */
const REAL_SUBJECTS = [
  "fix(#921): take the containment reading off $HOME (#936)",
  "fix(#960): the drift reading stops consulting a config the reviewer can write (#965)",
  "fix(#506): CONFIG-1 reads the source it could not reach, instead of refusing over it (#975)",
  "fix(#883): one binding decides what a test declaration is (#890)",
];

/** A repository with `count` commits, every one of them a mineable subject. */
function repoWith(label: string, count: number): string {
  const dir = join(scratchDir(label), "origin");
  mkdirSync(dir, { recursive: true });
  expect(git(dir, ["init", "-q", "-b", "main"]).status).toBe(0);
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    expect(git(dir, ["add", "-A"]).status).toBe(0);
    const subject = REAL_SUBJECTS[i % REAL_SUBJECTS.length].replace("fix(#", `fix(#${i}0`);
    expect(git(dir, ["commit", "-q", "-m", subject]).status).toBe(0);
  }
  return dir;
}

/** Emit a real ci.yml / gates.yml pair into a planted project and return the directory. */
function emitWorkflows(shards?: number): string {
  const root = scratchDir("emit");
  mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "rungate", "config.json"),
    JSON.stringify({
      slug: "depthfix",
      test: { command: "bun test", timeout: 300000 },
      ci: shards === undefined ? {} : { shards },
    }),
  );
  writeFileSync(join(root, ".bun-version"), "1.4.3\n");
  createCiWorkflows(root, [], { force: true });
  return root;
}

const workflow = (root: string, name: string): string =>
  readFileSync(join(root, ".github", "workflows", name), "utf-8");

/** Parse a job out of a workflow, refusing rather than defaulting when it cannot be read. */
function modelOf(yaml: string, jobName: string): CheckoutModel {
  const { model, why } = parseCheckoutModel(yaml, jobName);
  if (!model) throw new Error(`could not read the "${jobName}" job: ${why}`);
  return model;
}

// ── The decider ──────────────────────────────────────────────────

describe("#987 AC-1: ciHistoryReading is the one decider, and it refuses both ways", () => {
  const model = (depth: number | null, fetchDepths: (number | null)[]): CheckoutModel => ({
    jobName: "test",
    depth,
    fetches: fetchDepths.map((d) => ({ refspec: "+refs/heads/main:refs/remotes/origin/main", depth: d })),
  });

  test("a full checkout with no bounded fetch is MEASURED", () => {
    const r = ciHistoryReading(model(null, []));
    expect(r.reading).toBe("MEASURED");
    expect(r.reasons).toEqual([]);
  });

  test("a full checkout whose base-ref fetch is unbounded is MEASURED", () => {
    expect(ciHistoryReading(model(null, [null])).reading).toBe("MEASURED");
  });

  test("the default checkout — no fetch-depth, which is depth 1 — is UNMEASURED", () => {
    const r = ciHistoryReading(model(1, []));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.reasons).toEqual([`${SHALLOW_CHECKOUT}: fetch-depth 1`]);
  });

  test("#987's own proposal — a bounded depth of MAX_COMMITS_SCANNED — is UNMEASURED", () => {
    // The issue argues a depth of MAX_COMMITS_SCANNED "would make the reading
    // MEASURED at a bounded cost — and is the option that matches what the
    // code actually asks for". Measured against real git, it does not:
    // `--is-shallow-repository` reads `.git/shallow`, which a bounded fetch
    // writes whatever its depth. The executed case below runs the real intake
    // over a clone at exactly this depth and gets UNMEASURED.
    //
    // Asserted here so the proposal cannot be re-adopted without this case
    // saying no, and written against MAX_COMMITS_SCANNED rather than against
    // the literal, so raising the intake's window cannot silently retire it.
    const r = ciHistoryReading(model(MAX_COMMITS_SCANNED, []));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.reasons).toEqual([`${SHALLOW_CHECKOUT}: fetch-depth ${MAX_COMMITS_SCANNED}`]);
  });

  test("a full checkout followed by a bounded fetch is UNMEASURED — the inert fix", () => {
    // The cheapest wrong fix for #987 is `fetch-depth: 0` on the checkout and
    // nothing else. The generated job's very next step is a bounded
    // `git fetch`, which re-shallows the complete clone, so that repair buys
    // nothing. This is the case that refuses it.
    const r = ciHistoryReading(model(null, [200]));
    expect(r.reading).toBe("UNMEASURED");
    expect(r.reasons).toEqual([
      `${RESHALLOWED_BY_FETCH}: git fetch --depth=200 +refs/heads/main:refs/remotes/origin/main`,
    ]);
  });

  test("both faults at once are reported as two reasons, not one", () => {
    expect(ciHistoryReading(model(1, [200])).reasons).toHaveLength(2);
  });
});

describe("#987 AC-2: the base-ref fetch depth is derived from the checkout's", () => {
  test("a full checkout gets an unbounded base-ref fetch", () => {
    expect(baseRefFetchDepth(0)).toBeNull();
  });

  test("a bounded checkout keeps the bounded base-ref fetch", () => {
    // Nothing is gained by unbounding a fetch into a clone that is shallow
    // anyway, and #302's ratchet only ever needed the tip plus some history.
    expect(baseRefFetchDepth(1)).toBe(200);
    expect(baseRefFetchDepth(500)).toBe(200);
  });
});

// ── The generated workflows ──────────────────────────────────────

describe("#987 AC-3: every generated job that runs the intake keeps its history", () => {
  // `test/scaffold-conformity.test.ts` calls `runDocHygiene`, and HYGIENE-6
  // inside it is the intake's only caller. That file runs in BOTH generated
  // jobs — the gates job names it directly, and the suite job reaches it
  // through `bun test`. #987 says "the gates and ai-review jobs have no
  // git-history reader"; the gates job is the one job that runs the reader by
  // name, so both are asserted here.

  test("the sharded suite job", () => {
    const yaml = workflow(emitWorkflows(4), "ci.yml");
    expect(suiteJobName(yaml)).toBe("test-shard");
    const r = ciHistoryReading(modelOf(yaml, "test-shard"));
    expect(r.reasons).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("the unsharded suite job — the shape every consumer with no shard config gets", () => {
    const yaml = workflow(emitWorkflows(), "ci.yml");
    expect(suiteJobName(yaml)).toBe("test");
    const r = ciHistoryReading(modelOf(yaml, "test"));
    expect(r.reasons).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("the gates job, which names the conformity suite directly", () => {
    const yaml = workflow(emitWorkflows(), "gates.yml");
    const r = ciHistoryReading(modelOf(yaml, "gates"));
    expect(r.reasons).toEqual([]);
    expect(r.reading).toBe("MEASURED");
  });

  test("the emitted depth is the declaration, not a literal written twice", () => {
    const yaml = workflow(emitWorkflows(), "ci.yml");
    expect(modelOf(yaml, "test").depth).toBe(
      CI_SUITE_FETCH_DEPTH === 0 ? null : CI_SUITE_FETCH_DEPTH,
    );
  });

  test("this repository's own committed workflows, not only freshly generated ones", () => {
    // The generator could be correct while the file on disk is stale. These
    // read `.github/workflows/*.yml` as committed.
    const root = join(import.meta.dir, "..");
    for (const [file, job] of [
      ["ci.yml", suiteJobName(readFileSync(join(root, ".github/workflows/ci.yml"), "utf-8"))],
      ["gates.yml", "gates"],
    ] as const) {
      const yaml = readFileSync(join(root, ".github/workflows", file), "utf-8");
      const r = ciHistoryReading(modelOf(yaml, job));
      expect(`${file}:${job} ${r.reasons.join("; ")}`).toBe(`${file}:${job} `);
      expect(r.reading).toBe("MEASURED");
    }
  });
});

// ── Executed against real git and the real intake ────────────────

describe("#987 AC-4: the real intake, over a checkout built to the generated model", () => {
  /** Replay a parsed checkout model against a real repository, the way `scripts/test-clean-env.ts` does. */
  function buildCheckout(source: string, model: CheckoutModel): string {
    const parent = scratchDir("checkout");
    const dest = join(parent, "repo");
    const run = (argv: string[], cwd: string) => {
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const result = executeCheckoutPlan(
      ciCheckoutPlan({ source, dest, model }),
      dest,
      parent,
      run,
    );
    if (!result.ok) throw new Error(`fixture checkout failed: ${result.why}`);
    return dest;
  }

  // One source repository for every case below, so the only thing that varies
  // between them is the checkout model. A pair that varies two things at once
  // measures neither.
  const COMMITS = 30;
  const source = repoWith("source", COMMITS);

  test("the control: the source repository itself is MEASURED", () => {
    const reading = mineFixCommits(source);
    expect(reading.unmeasuredReasons).toEqual([]);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.commitsScanned).toBe(COMMITS);
    expect(reading.candidates.length).toBeGreaterThan(0);
  });

  test("the generated model yields MEASURED, and the prediction agreed", () => {
    const yaml = workflow(emitWorkflows(), "ci.yml");
    const model = modelOf(yaml, "test");
    // The prediction and the fact, in one case, so neither can drift from the
    // other unnoticed.
    expect(ciHistoryReading(model).reading).toBe("MEASURED");
    const reading = mineFixCommits(buildCheckout(source, model));
    expect(reading.unmeasuredReasons).toEqual([]);
    expect(reading.reading).toBe("MEASURED");
    expect(reading.commitsScanned).toBe(COMMITS);
  });

  test("the pre-#987 model — depth 1 — yields UNMEASURED, and the prediction agreed", () => {
    const model: CheckoutModel = { jobName: "test", depth: 1, fetches: [] };
    expect(ciHistoryReading(model).reading).toBe("UNMEASURED");
    const reading = mineFixCommits(buildCheckout(source, model));
    expect(reading.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    expect(reading.reading).toBe("UNMEASURED");
    expect(reading.commitsScanned).toBe(1);
  });

  test("a bounded depth below the history length yields UNMEASURED against real git", () => {
    // #987's proposed fix, executed at this fixture's scale. The relation
    // that matters is `depth < commits`, not the particular number: a
    // depth-20 clone of a 30-commit repository is the same state a
    // depth-MAX_COMMITS_SCANNED clone of this repository's 1090-commit `main`
    // is in, and it costs 30 commits to build instead of 520.
    //
    // The relation was also measured at the real scale once, by hand and not
    // in the suite: a depth-500 clone of a 520-commit repository reports
    // `is-shallow-repository true` holding exactly 500 commits.
    expect(MAX_COMMITS_SCANNED).toBeGreaterThan(COMMITS);
    const bounded = COMMITS - 10;
    const model: CheckoutModel = { jobName: "test", depth: bounded, fetches: [] };
    expect(ciHistoryReading(model).reading).toBe("UNMEASURED");
    const dest = buildCheckout(source, model);
    expect(git(dest, ["rev-parse", "--is-shallow-repository"]).stdout.trim()).toBe("true");
    const reading = mineFixCommits(dest);
    expect(reading.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    expect(reading.reading).toBe("UNMEASURED");
  });

  test("the inert fix — full checkout, bounded fetch — yields UNMEASURED against real git", () => {
    // `fetch-depth: 0` with the generated base-ref fetch left alone. The
    // clone starts complete and the next command re-shallows it.
    const model: CheckoutModel = {
      jobName: "test",
      depth: null,
      fetches: [{ refspec: "+refs/heads/main:refs/remotes/origin/main", depth: 20 }],
    };
    expect(ciHistoryReading(model).reading).toBe("UNMEASURED");
    const dest = buildCheckout(source, model);
    expect(git(dest, ["rev-parse", "--is-shallow-repository"]).stdout.trim()).toBe("true");
    const reading = mineFixCommits(dest);
    expect(reading.unmeasuredReasons).toContain(SHALLOW_HISTORY);
    expect(reading.reading).toBe("UNMEASURED");
    // And the sibling fact, measured rather than asserted: the bounded fetch
    // did not merely leave a flag behind, it threw history away.
    expect(Number(git(dest, ["rev-list", "--count", "HEAD"]).stdout.trim())).toBeLessThan(COMMITS);
  });

  // ── WHAT THIS DOES NOT COVER ───────────────────────────────────

  test("ESCAPE: a bounded depth longer than the whole history is MEASURED, and the prediction says otherwise", () => {
    // The one input on which `ciHistoryReading` and `mineFixCommits`
    // disagree, asserted rather than described. git removes `.git/shallow`
    // when the requested depth reaches the root commit, so a young repository
    // cloned at a generous bounded depth really is complete.
    //
    // The prediction refuses it anyway. A generator does not know how long a
    // consumer's history is, and a repository that is short today is not
    // short next year — so "a bounded depth will truncate" is the only
    // reading available at generation time, and the cost of being wrong is a
    // young repository keeping history it already had.
    const model: CheckoutModel = { jobName: "test", depth: COMMITS + 50, fetches: [] };
    expect(ciHistoryReading(model).reading).toBe("UNMEASURED");

    const dest = buildCheckout(source, model);
    expect(git(dest, ["rev-parse", "--is-shallow-repository"]).stdout.trim()).toBe("false");
    const reading = mineFixCommits(dest);
    expect(reading.reading).toBe("MEASURED");
    // Stated as the disagreement it is, so a later change that accidentally
    // closed it would be visible here rather than silently fine.
    expect(reading.reading).not.toBe(ciHistoryReading(model).reading);
  });

  test("ESCAPE: nothing here reads a job that acquires history outside the checkout", () => {
    // A `run:` step containing its own `git clone --filter=blob:none`, a
    // cache restore, a submodule — all of them produce a history the parsed
    // model cannot see, and all of them read UNMEASURED here. The refusal is
    // one-directional on purpose: an over-strict reading costs a
    // conversation, an over-permissive one costs the whole of #987.
    const model: CheckoutModel = { jobName: "test", depth: 1, fetches: [] };
    expect(ciHistoryReading(model).reading).toBe("UNMEASURED");
    // The history such a job would really have is not modelled anywhere, so
    // there is no second reading to compare this against. That absence is the
    // escape.
    expect(ciHistoryReading(model).reasons).toEqual([`${SHALLOW_CHECKOUT}: fetch-depth 1`]);
  });
});
