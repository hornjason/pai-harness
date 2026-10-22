/**
 * ci-shard-aggregate-measured.test.ts — the aggregate asserts that it
 * MEASURED, not merely that it did not fail (#1181); it does so without `gh`
 * or `actions: read` (#1190); and the evidence it counts is bound to one leg
 * of THIS run attempt (#1190 follow-up).
 *
 * ## The run
 *
 * PR #1154 merged on run `39799846607`. `test-shard (1)`, `(2)` and `(3)`
 * were `queued`, `completed_at: null`, **no conclusion**. Only shard 4
 * completed. The aggregate `test` job read `needs.test-shard.result` as
 * `success`, printed "All 4 shards passed", and went green in three seconds.
 * `test` is a required check and auto-merge is armed repo-wide, so a quarter
 * of the suite authorised the merge.
 *
 * `always()` was added so a **failed or cancelled** shard reaches the
 * aggregate. It is about REACHING the job. The hole is what the job then
 * reads: `needs.<job>.result` collapses a whole matrix into one word, and for
 * a matrix that produced no results that word was `success`.
 *
 * ## The evidence channel, and why it is not the Actions API
 *
 * #1189 asked the jobs API with `gh api`. That worked, and it made every
 * consumer's required check depend on **`gh` on the runner image** — a
 * GitHub-hosted-image fact, not a runner fact, and `ci.runner` is
 * consumer-settable — and on **`actions: read`**. Neither is needed to read a
 * marker: `actions/download-artifact`'s README says a `github-token` and
 * `actions: read` are "required when downloading artifacts from a different
 * repository or from a different workflow run".
 *
 * A marker is also stronger evidence than a conclusion. The API reports what
 * GitHub *recorded* about a job; a marker is a file the job's own shell
 * *wrote*. A leg created and never executed leaves nothing, which is exactly
 * `39799846607`'s three queued shards.
 *
 * ## Why the attempt is part of the evidence — MEASURED, not assumed
 *
 * **Artifacts are scoped to the RUN, not the attempt.** Run `39835866754`, a
 * two-leg matrix re-run with "Re-run failed jobs": on attempt 2 the
 * aggregate's download reported `Found 2 artifact(s)` and handed back
 * `shard-1 => success attempt=1` — written by a leg that **did not execute in
 * attempt 2 at all**. Read as evidence about attempt 2, that is #1181
 * reintroduced: a required check green over a shard that did not run.
 *
 * So the attempt is bound in **two independent places**: the artifact's name
 * and the marker's body. A name is a convention the generator controls; a
 * body is a reading. `M2` below is the name-only fix, run, and it goes green
 * on a marker whose body disagrees with its own name.
 *
 * ## And why the leg is part of it too
 *
 * The first draft uploaded the whole marker directory and downloaded with
 * `merge-multiple: true`, which flattens every artifact into one directory —
 * so the reading was filenames alone and the name's per-leg binding was
 * discarded. A leg writing `shard-1`, `shard-2`, `shard-3` into its own temp
 * directory would contribute evidence for legs it is not. Now the upload
 * names a single FILE and the download keeps one directory per artifact.
 * Measured on run `39836500284`: the leg writes a decoy `shard-99` and the
 * artifact carries only `shard-<its own index>`.
 *
 * ## What is executed here, and why it is the shipped text
 *
 * `buildShardAggregateScript()` returns the script the generator writes into
 * `ci.yml`, and it holds **no `${{ }}` expression** — every GitHub-side value
 * arrives through the step's `env:`. The cases below run the real text
 * against a planted artifact tree, so "a shard never ran" and "a shard's only
 * evidence is from attempt 1" are inputs a test can supply.
 *
 * ## The shell, which is half of what #1191 was about
 *
 * Every case runs under **`-e`**, and under `/usr/bin/bash` wherever that
 * path exists — the runner's own `shell: /usr/bin/bash -e {0}`, read off run
 * `39834155753`'s step echo. #1191 shipped a defect on this exact step that
 * existed only under errexit. `RESOLVED_SHELL` refuses outright rather than
 * dropping to a shell nobody chose, and `errexit is live` is the harness's
 * own control.
 *
 * ## Predicted before the battery ran
 *
 * Shipped script, 16 rows: 3 green (P1, P2, P3), 13 red (N1–N12, two of them
 * two-rowed). Measured 3/13, 0 rows off prediction.
 * Mutant (`SHARD_AGGREGATE_REFUSAL_EXIT` → `0`): 13 of 13 reds flip green.
 *
 * P3 is the row that keeps the refusal honest rather than obstructive: N3
 * tells the operator to re-run ALL jobs, and P3 is that remedy, run.
 *
 * **Two cheapest wrong fixes, named and measured rather than dismissed:**
 * - `M1` — treat a reading you cannot take as nothing to object to
 *   (`[ -d "$dir" ] || exit 0`). Predicted **0 of 3** no-evidence cases.
 * - `M2` — the fix for the re-run hole that stops at the artifact NAME, with
 *   no body cross-check. Predicted **0 of 1** on a marker whose body
 *   disagrees with its name, against 1 of 1 for the shipped script.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SHARD_AGGREGATE_ENV,
  SHARD_AGGREGATE_REFUSAL_EXIT,
  SHARD_MARKER_ARTIFACT_PREFIX,
  SHARD_MARKER_ENV,
  SHARD_MARKER_FILE_PREFIX,
  buildShardAggregateScript,
  createCiWorkflows,
} from "../lib/scaffold/steps";

const E = SHARD_AGGREGATE_ENV;

/**
 * The shell the generated step runs under, resolved rather than assumed.
 *
 * `/usr/bin/bash` is the runner's path and is what CI resolves to; a macOS
 * developer box has only `/bin/bash`. Both are run with `-e`, the property
 * #1191 turned on. Neither present is a REFUSAL — a case that silently fell
 * back to `sh` would be measuring a different program.
 */
const RESOLVED_SHELL = ((): string => {
  for (const candidate of ["/usr/bin/bash", "/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "neither /usr/bin/bash nor /bin/bash exists, so these cases cannot run the shell GitHub runs. UNMEASURED, not a pass.",
  );
})();

/**
 * One artifact as `download-artifact` lays it out with no `merge-multiple`:
 * a directory named after the artifact, holding the files that leg uploaded.
 */
type Artifact = {
  attempt: number;
  shard: number;
  /** Files inside, by name. The shipped marker step writes exactly one. */
  files: Record<string, string>;
};

/** The marker body the shard step writes: `<status> <attempt> <shard>`. */
const body = (status: string, attempt: number, shard: number): string =>
  `${status} ${attempt} ${shard}\n`;

/** One well-formed artifact for a leg that executed and reported `status`. */
const leg = (shard: number, status: string, attempt = 2): Artifact => ({
  attempt,
  shard,
  files: { [`${SHARD_MARKER_FILE_PREFIX}${shard}`]: body(status, attempt, shard) },
});

/** An ordinary fully-measured attempt of `n` shards, all green. */
const allGreen = (n: number, attempt = 2): Artifact[] =>
  Array.from({ length: n }, (_, i) => leg(i + 1, "success", attempt));

/**
 * Run `39799846607` at attempt 2: shards 1–3 never executed and left nothing
 * at all, shard 4 ran and passed.
 */
const RUN_39799846607: Artifact[] = [leg(4, "success")];

/**
 * Run `39835866754`'s own shape: a partial re-run. Leg 1 passed in attempt 1
 * and GitHub did not re-run it, so its only evidence is attempt 1's; leg 2
 * failed, was re-run, and passed in attempt 2. Measured, not invented — the
 * three directories below are the three the probe's attempt 2 listed.
 */
const PARTIAL_RERUN: Artifact[] = [
  leg(1, "success", 1),
  leg(2, "failure", 1),
  leg(2, "success", 2),
];

type Run = { code: number | null; out: string; err: string; shell: string };

/** Execute a shard-aggregate script against a planted artifact tree. */
function runAggregate(opts: {
  artifacts: Artifact[];
  rollup: string;
  expected?: string;
  attempt?: string;
  script?: string;
  /** Plant no download directory at all — the download produced nothing. */
  noMarkerDir?: boolean;
  /** Leave `SHARD_MARKER_DIR` out of the step's env entirely. */
  unsetMarkerDir?: boolean;
  /** Leave `SHARD_ATTEMPT` out of the step's env entirely. */
  unsetAttempt?: boolean;
}): Run {
  const root = mkdtempSync(join(tmpdir(), "rungate-shard-aggregate-"));
  const dir = join(root, "markers");

  if (!opts.noMarkerDir) {
    mkdirSync(dir, { recursive: true });
    for (const art of opts.artifacts) {
      const artDir = join(dir, `${SHARD_MARKER_ARTIFACT_PREFIX}${art.attempt}-${art.shard}`);
      mkdirSync(artDir, { recursive: true });
      for (const [name, content] of Object.entries(art.files)) {
        writeFileSync(join(artDir, name), content);
      }
    }
  }

  const scriptPath = join(root, "aggregate.sh");
  writeFileSync(scriptPath, opts.script ?? buildShardAggregateScript());

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    [E.rollup]: opts.rollup,
    [E.expected]: opts.expected ?? "4",
    [E.jobName]: "test-shard",
  };
  if (!opts.unsetAttempt) env[E.attempt] = opts.attempt ?? "2";
  if (!opts.unsetMarkerDir) env[E.markerDir] = dir;

  const r = Bun.spawnSync([RESOLVED_SHELL, "-e", scriptPath], { cwd: root, env });

  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
    shell: RESOLVED_SHELL,
  };
}

/**
 * The script with its one refusal constant removed.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: each red row is run twice,
 * and the second run is the removal of the non-zero exit, performed and
 * observed. Without it a row that goes red for an unrelated reason is
 * indistinguishable from a row that caught what it was pointed at.
 */
function mutantScript(): string {
  const real = buildShardAggregateScript();
  const needle = `exit ${SHARD_AGGREGATE_REFUSAL_EXIT}`;
  const occurrences = real.split(needle).length - 1;
  if (occurrences < 1) {
    throw new Error(
      `the refusal constant is spelled '${needle}' nowhere in the script — the mutation would be a no-op and every case below would witness nothing.`,
    );
  }
  return real.split(needle).join("exit 0");
}

/** Assert one case is red for its own reason, by flipping the refusal off. */
function refusesAndTheMutantDoesNot(opts: Parameters<typeof runAggregate>[0], ...says: string[]): void {
  const r = runAggregate(opts);
  expect(r.code, `expected a refusal under ${r.shell} -e, got ${r.code}:\n${r.out}${r.err}`).not.toBe(0);
  for (const sentence of says) {
    // The annotation, not only the exit code. Under `bash -e` a script can
    // abort before its handler and go red with nothing said — #1191 on this
    // same step — and red-and-silent is the expensive half.
    expect(r.out + r.err, `refused without saying "${sentence}"`).toContain(sentence);
  }
  expect(
    runAggregate({ ...opts, script: mutantScript() }).code,
    "the mutant still refused, so this row's red did not come from the refusal",
  ).toBe(0);
}

/**
 * M1 — the cheapest wrong fix for #1190: make the reading optional.
 *
 * The rollup check is kept verbatim; a reading the script cannot take becomes
 * a pass instead of a refusal. That is what "don't break consumers whose
 * runner cannot do this" looks like written in a hurry, and it is #1181
 * arriving through a new door.
 */
const M1_READING_IS_OPTIONAL = `set -uo pipefail
rollup="\${${E.rollup}:-}"
if [ "$rollup" != "success" ]; then
  echo "::error::test-shard concluded '$rollup' — the suite is not green."
  exit 1
fi
expected="\${${E.expected}:-4}"
dir="\${${E.markerDir}:-}"
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "no shard markers available on this runner; skipping the count."
  exit 0
fi
found=0
for art in "$dir"/${SHARD_MARKER_ARTIFACT_PREFIX}*; do
  [ -d "$art" ] || continue
  found=$((found + 1))
done
if [ "$found" -eq 0 ]; then
  echo "no shard markers found; skipping the count."
  exit 0
fi
echo "All $expected shards passed."
`;

/**
 * M2 — the cheapest wrong fix for the re-run hole: bind the attempt in the
 * artifact NAME and stop there.
 *
 * It is a real improvement — it catches the stale-marker case the probe
 * measured — and it is still one binding. A name is written by the generator
 * from `${{ github.run_attempt }}`; nothing re-reads the marker to confirm
 * the leg agrees. So a marker whose body says a different attempt passes,
 * and the test that cannot tell M2 from the shipped script is a test that is
 * not measuring the second binding.
 */
const M2_NAME_ONLY = `set -uo pipefail
rollup="\${${E.rollup}:-}"
if [ "$rollup" != "success" ]; then
  echo "::error::test-shard concluded '$rollup' — the suite is not green."
  exit 1
fi
expected="\${${E.expected}:-4}"
attempt="\${${E.attempt}:-}"
dir="\${${E.markerDir}:-}"
if [ -z "$dir" ] || [ ! -d "$dir" ] || [ -z "$attempt" ]; then
  echo "::error::UNMEASURED, so refusing."
  exit 1
fi
passed=0
n=1
while [ "$n" -le "$expected" ]; do
  marker="$dir/${SHARD_MARKER_ARTIFACT_PREFIX}$attempt-$n/${SHARD_MARKER_FILE_PREFIX}$n"
  if [ ! -f "$marker" ]; then
    echo "::error::shard $n left no marker for attempt $attempt. Refusing."
    exit 1
  fi
  st=""
  read -r st _rest < "$marker" || true
  if [ "$st" = "success" ]; then passed=$((passed + 1)); fi
  n=$((n + 1))
done
if [ "$passed" -ne "$expected" ]; then
  echo "::error::$passed of $expected shards concluded success."
  exit 1
fi
echo "All $passed shards concluded, and all $passed passed."
`;

describe("#1181/#1190: the shard aggregate refuses a run it did not measure", () => {
  test("the harness's own control: errexit is live under the resolved shell", () => {
    // If this is green while `-e` is off, every case below is measuring a
    // different program from the one GitHub runs. #1191 is that defect.
    const root = mkdtempSync(join(tmpdir(), "rungate-shard-errexit-"));
    const probe = join(root, "probe.sh");
    writeFileSync(probe, "false\necho REACHED\n");
    const r = Bun.spawnSync([RESOLVED_SHELL, "-e", probe], { cwd: root, env: { PATH: "/usr/bin:/bin" } });
    expect(r.exitCode, `${RESOLVED_SHELL} -e did not abort on a failing command`).not.toBe(0);
    expect(new TextDecoder().decode(r.stdout)).not.toContain("REACHED");
  });

  test("N1 — the defect, reproduced: three shards that left no marker go RED", () => {
    // THE case. If this passes, nothing has been fixed.
    refusesAndTheMutantDoesNot(
      { artifacts: RUN_39799846607, rollup: "success" },
      "3 of 4 shards left NO marker",
      '"test-shard (1)"=no-marker',
      "UNMEASURED",
    );
  });

  test("N2 — every shard queued, so not one artifact exists, goes RED", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: [], rollup: "success" },
      "4 of 4 shards left NO marker",
      "UNMEASURED",
    );
  });

  test("N3 — run 39835866754's partial re-run: a leg whose only evidence is attempt 1 goes RED", () => {
    // The security review's finding 1, as the probe measured it. Leg 1 did
    // not execute in attempt 2; its attempt-1 marker says `success` and must
    // not be read as evidence about attempt 2.
    refusesAndTheMutantDoesNot(
      { artifacts: PARTIAL_RERUN, rollup: "success", expected: "2", attempt: "2" },
      "1 of 2 shards left no marker for attempt 2",
      `only-from: ${SHARD_MARKER_ARTIFACT_PREFIX}1-1`,
      "Re-run ALL jobs",
      "UNMEASURED",
    );
  });

  test("N4 — a stale marker is told apart from no marker at all", () => {
    // Two different diagnoses with two different remedies. Collapsing them
    // would make a partial re-run read as "your shards never ran".
    const stale = runAggregate({ artifacts: PARTIAL_RERUN, rollup: "success", expected: "2" });
    const absent = runAggregate({ artifacts: [leg(2, "success")], rollup: "success", expected: "2" });
    expect(stale.out + stale.err).toContain("left no marker for attempt 2, only for an earlier one");
    expect(stale.out + stale.err).not.toContain("left NO marker, so they never executed");
    expect(absent.out + absent.err).toContain("left NO marker, so they never executed");
    expect(absent.out + absent.err).not.toContain("only for an earlier one");
  });

  test("N5 — no download directory at all is UNMEASURED, and UNMEASURED is red", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: RUN_39799846607, rollup: "success", noMarkerDir: true },
      "no shard markers were downloaded",
      "UNMEASURED",
    );
  });

  test("N6 — an unset marker directory is UNMEASURED, and UNMEASURED is red", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: allGreen(4), rollup: "success", unsetMarkerDir: true },
      `${E.markerDir} is unset`,
      "UNMEASURED",
    );
  });

  test("N7 — an unset or malformed run attempt is UNMEASURED, because no marker can be dated", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: allGreen(4), rollup: "success", unsetAttempt: true },
      `${E.attempt} is ''`,
      "UNMEASURED",
    );
    refusesAndTheMutantDoesNot(
      { artifacts: allGreen(4), rollup: "success", attempt: "two" },
      "is not a run attempt",
      "UNMEASURED",
    );
  });

  test("N8 — a marker whose BODY disagrees with its own artifact name goes RED", () => {
    // The second binding, and the row that separates the shipped script from
    // M2. The directory says attempt 2; the body says attempt 1.
    const forged: Artifact[] = [
      leg(1, "success"),
      { attempt: 2, shard: 2, files: { [`${SHARD_MARKER_FILE_PREFIX}2`]: body("success", 1, 2) } },
    ];
    refusesAndTheMutantDoesNot(
      { artifacts: forged, rollup: "success", expected: "2" },
      "do not identify the leg and attempt that wrote them",
      "marker-says-attempt-'1'-shard-'2'",
      "UNMEASURED",
    );
  });

  test("N9 — an artifact carrying a marker for a leg it is not goes RED", () => {
    // The security review's findings 2 and 3. The upload names one file, so
    // this is unreachable from the shipped workflow — which is the point:
    // the CLAIM is "each leg produced its own marker", and a reading that
    // could not tell otherwise would not be measuring the claim.
    const smuggled: Artifact[] = [
      leg(1, "success"),
      {
        attempt: 2,
        shard: 2,
        files: {
          [`${SHARD_MARKER_FILE_PREFIX}2`]: body("success", 2, 2),
          [`${SHARD_MARKER_FILE_PREFIX}1`]: body("success", 2, 1),
        },
      },
    ];
    refusesAndTheMutantDoesNot(
      { artifacts: smuggled, rollup: "success", expected: "2" },
      "do not identify the leg and attempt that wrote them",
      "artifact-holds-2-file",
      "UNMEASURED",
    );
  });

  test("N10 — a shard whose own marker says failure goes RED even when the rollup says success", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: [leg(1, "success"), leg(2, "success"), leg(3, "failure"), leg(4, "success")], rollup: "success" },
      "3 of 4 shards concluded success",
      '"test-shard (3)"=failure',
    );
  });

  test("N11 — more artifacts for this attempt than the matrix declares goes RED", () => {
    refusesAndTheMutantDoesNot(
      { artifacts: [...allGreen(4), leg(5, "success")], rollup: "success" },
      "attempt 2 left 5 shard-marker artifacts, and the matrix declares 4",
    );
  });

  test("N12 — a failed and a cancelled rollup still refuse, with the sentences they print today", () => {
    for (const rollup of ["failure", "cancelled"]) {
      refusesAndTheMutantDoesNot(
        { artifacts: [leg(1, "success"), leg(2, rollup), leg(3, "success"), leg(4, "success")], rollup },
        `test-shard concluded '${rollup}' — the suite is not green.`,
      );
    }
  });

  test("P1 — the positive control: an ordinary 4/4 attempt still passes", () => {
    // Without this, every refusal above is satisfied by a script that
    // refuses everything, which is a gate nobody can ship through.
    const r = runAggregate({ artifacts: allGreen(4), rollup: "success" });
    expect(r.code, `an ordinary green run must pass:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 4 shards concluded, and all 4 passed.");
  });

  test("P2 — a FIRST attempt passes, and the printed count is the measured one", () => {
    // attempt=1 is the overwhelmingly common case and must not be collateral
    // damage of the attempt binding. Also drives a 2-shard matrix: the
    // sentence must follow the evidence, not the generator — "All 4 shards
    // passed" was true-shaped and false on 39799846607 for that reason.
    const r = runAggregate({ artifacts: allGreen(2, 1), rollup: "success", expected: "2", attempt: "1" });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 2 shards concluded, and all 2 passed.");
    expect(r.out).not.toContain("All 4");
  });

  test("P3 — a re-run of ALL jobs passes, so the remedy the refusal names actually works", () => {
    // N3 tells the operator to re-run all jobs. A refusal whose remedy also
    // refuses is an obstacle, not a check. Attempt 2 with every leg fresh,
    // and attempt 1's markers still sitting in the download beside them.
    const r = runAggregate({
      artifacts: [leg(1, "failure", 1), leg(2, "failure", 1), ...allGreen(2, 2)],
      rollup: "success",
      expected: "2",
      attempt: "2",
    });
    expect(r.code, `a full re-run must pass:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 2 shards concluded, and all 2 passed.");
  });

  test("a malformed or zero shard count is UNMEASURED, not an assertion about nothing", () => {
    for (const expected of ["", "four", "0"]) {
      refusesAndTheMutantDoesNot({ artifacts: allGreen(4), rollup: "success", expected }, "UNMEASURED");
    }
  });
});

describe("#1190: the cheapest wrong fixes, measured", () => {
  const noEvidenceCases: Array<[string, Parameters<typeof runAggregate>[0]]> = [
    ["run 39799846607", { artifacts: RUN_39799846607, rollup: "success" }],
    ["every shard queued", { artifacts: [], rollup: "success" }],
    ["no download directory at all", { artifacts: RUN_39799846607, rollup: "success", noMarkerDir: true }],
  ];

  test("M1 — 'the reading is optional' catches 0 of the 3 cases #1181 is about", () => {
    const caught = noEvidenceCases.filter(
      ([, opts]) => runAggregate({ ...opts, script: M1_READING_IS_OPTIONAL }).code !== 0,
    );
    expect(caught.map(([name]) => name), "predicted 0 of 3").toEqual([]);
  });

  test("and the shipped script catches 3 of 3 — the differing input, named", () => {
    // Same three plantings. The only thing that changed is the script, so
    // the contrast cannot be explained by the fixture.
    const missed = noEvidenceCases.filter(([, opts]) => runAggregate(opts).code === 0);
    expect(missed.map(([name]) => name), "predicted 3 of 3 caught").toEqual([]);
  });

  const forged: Parameters<typeof runAggregate>[0] = {
    artifacts: [
      leg(1, "success"),
      { attempt: 2, shard: 2, files: { [`${SHARD_MARKER_FILE_PREFIX}2`]: body("success", 1, 2) } },
    ],
    rollup: "success",
    expected: "2",
  };

  test("M2 — binding the attempt in the NAME only goes green on a body that disagrees", () => {
    // If this row ever goes red, the two scripts have become the same script
    // and the body cross-check is no longer load-bearing. Predicted: green.
    expect(runAggregate({ ...forged, script: M2_NAME_ONLY }).code, "predicted 0 of 1 caught").toBe(0);
  });

  test("and the shipped script refuses it — one binding is not two", () => {
    expect(runAggregate(forged).code, "predicted 1 of 1 caught").not.toBe(0);
  });

  test("M2 does catch the stale-marker case, so it is a real improvement and still not enough", () => {
    // Priced honestly: M2 is not a strawman. It closes the probe's own
    // finding. It is rejected for what it leaves open, not for doing nothing.
    const r = runAggregate({ artifacts: PARTIAL_RERUN, rollup: "success", expected: "2", script: M2_NAME_ONLY });
    expect(r.code).not.toBe(0);
  });
});

describe("#1181/#1190: the generated workflow supplies what the script reads", () => {
  const emit = (shards: number): string => {
    const root = mkdtempSync(join(tmpdir(), "rungate-shard-aggregate-yml-"));
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({
        slug: "shardagg",
        test: { command: "bun test", timeout: 300000 },
        ci: { shards },
      }),
    );
    writeFileSync(join(root, ".bun-version"), "1.4.3\n");
    createCiWorkflows(root, [], { force: true });
    const out = join(root, ".github", "workflows", "ci.yml");
    if (!existsSync(out)) {
      throw new Error(`the generator wrote no ci.yml for shards=${shards}. UNMEASURED, not a pass.`);
    }
    return readFileSync(out, "utf8");
  };

  test("AC-E — every variable the script reads is set by the step's env", () => {
    // #826's defect: the cases above supply an environment, and a generated
    // step that does not supply the same one leaves them measuring a script
    // nothing calls that way.
    const yml = emit(4);
    const script = buildShardAggregateScript();
    for (const name of Object.values(E)) {
      if (!script.includes(name)) continue;
      expect(yml, `${name} is read by the script and never set by the workflow`).toContain(`          ${name}:`);
    }
  });

  test("the aggregate holds no GitHub expression, so the shipped text is the text under test", () => {
    expect(buildShardAggregateScript()).not.toContain("${{");
  });

  test("the script the FILE carries is the script the cases ran", () => {
    // Otherwise the cases and the generator are two deciders: a generator
    // that stopped calling the builder would leave every case green while
    // `ci.yml` carried something nobody executed.
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: { test: { steps: Array<{ run?: string }> } };
    };
    const fromFile = parsed.jobs.test.steps.find(s => typeof s.run === "string")?.run ?? "";
    expect(fromFile.trimEnd()).toBe(buildShardAggregateScript().trimEnd());

    expect(runAggregate({ artifacts: RUN_39799846607, rollup: "success", script: fromFile }).code).not.toBe(0);
    expect(runAggregate({ artifacts: allGreen(4), rollup: "success", script: fromFile }).code).toBe(0);
  });

  test("#1190 — the aggregate asks for no scope beyond contents, and no token", () => {
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: { test: { permissions: Record<string, string>; steps: Array<{ env?: Record<string, string> }> } };
    };
    expect(parsed.jobs.test.permissions).toEqual({ contents: "read" });
    for (const step of parsed.jobs.test.steps) {
      expect(Object.keys(step.env ?? {})).not.toContain("GH_TOKEN");
    }
  });

  test("#1190 — nothing in the generated test job shells out to gh", () => {
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    for (const [name, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps) {
        expect(step.run ?? "", `the generated ${name} job invokes gh`).not.toMatch(/(^|[\s|&;(])gh\s/);
      }
    }
  });

  test("#1190 — the evidence is bound to one leg of one attempt, in the name and in the body", () => {
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: {
        "test-shard": {
          steps: Array<{ uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }>;
        };
        test: { steps: Array<{ uses?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean; env?: Record<string, string> }> };
      };
    };

    const marker = parsed.jobs["test-shard"].steps.find(s => s.env?.[SHARD_MARKER_ENV.status] !== undefined);
    expect(marker, "no shard step records this leg's own status").toBeDefined();
    expect(marker?.if, "a FAILED leg still executed; only an absent marker means it never ran").toBe("always()");
    // The body carries the attempt, which is the binding a name cannot be.
    expect(marker?.env?.[SHARD_MARKER_ENV.attempt]).toBe("${{ github.run_attempt }}");
    expect(marker?.run ?? "").toContain(`"$${SHARD_MARKER_ENV.attempt}"`);
    // Fresh directory, so nothing an earlier step left behind ships.
    expect(marker?.run ?? "").toContain(`rm -r "$${SHARD_MARKER_ENV.dir}"`);

    const upload = parsed.jobs["test-shard"].steps.find(s => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload, "the marker never leaves the shard runner").toBeDefined();
    expect(upload?.if).toBe("always()");
    // Name: attempt AND leg. Artifacts live on the run, so without the
    // attempt a stale marker is downloadable here (run 39835866754).
    expect(upload?.with?.name).toBe(
      `${SHARD_MARKER_ARTIFACT_PREFIX}\${{ github.run_attempt }}-\${{ matrix.shard }}`,
    );
    // One FILE, not the directory: a directory upload plus merge-multiple
    // discards the per-leg binding on the reading side.
    expect(String(upload?.with?.path)).toContain(`${SHARD_MARKER_FILE_PREFIX}\${{ matrix.shard }}`);
    expect(String(upload?.with?.path).endsWith("/"), "uploading the directory re-opens the leg-binding hole").toBe(false);
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    // Attempt-unique names collide with nothing, so no deletion primitive.
    expect(Object.keys(upload?.with ?? {})).not.toContain("overwrite");

    const download = parsed.jobs.test.steps.find(s => s.uses?.startsWith("actions/download-artifact"));
    expect(download, "the aggregate downloads nothing, so it counts nothing").toBeDefined();
    expect(download?.["continue-on-error"], "the REFUSAL must be the script's, with a sentence").toBe(true);
    // Every attempt, so a stale leg gets "re-run all jobs" and not "never ran".
    expect(String(download?.with?.pattern)).toBe(`${SHARD_MARKER_ARTIFACT_PREFIX}*`);
    // No flattening: the artifact directory IS the per-leg binding.
    expect(Object.keys(download?.with ?? {})).not.toContain("merge-multiple");

    const aggEnv = parsed.jobs.test.steps.find(s => s.env?.[E.markerDir]);
    expect(aggEnv?.env?.[E.markerDir]).toBe(String(download?.with?.path));
    expect(aggEnv?.env?.[E.attempt]).toBe("${{ github.run_attempt }}");
  });

  test("#1190 — no SHARD_POLL_* knob survives, because there is no poll to tune", () => {
    const yml = emit(4);
    expect(yml).not.toContain("SHARD_POLL");
    expect(buildShardAggregateScript()).not.toContain("sleep ");
  });

  test("the matrix width and the asserted width come from one declaration", () => {
    for (const shards of [2, 4, 7]) {
      const yml = emit(shards);
      expect(yml).toContain(`shard: [${Array.from({ length: shards }, (_, i) => i + 1).join(", ")}]`);
      expect(yml).toContain(`${E.expected}: "${shards}"`);
    }
  });

  test("an unsharded consumer gets no aggregate, no marker and no extra scope", () => {
    const root = mkdtempSync(join(tmpdir(), "rungate-shard-aggregate-plain-"));
    mkdirSync(join(root, ".claude", "rungate"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rungate", "config.json"),
      JSON.stringify({ slug: "shardagg", test: { command: "bun test", timeout: 300000 }, ci: {} }),
    );
    writeFileSync(join(root, ".bun-version"), "1.4.3\n");
    createCiWorkflows(root, [], { force: true });
    const yml = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(yml).not.toContain("test-shard");
    expect(yml).not.toContain(E.expected);
    expect(yml).not.toContain("actions: read");
    expect(yml).not.toContain(SHARD_MARKER_ARTIFACT_PREFIX);
  });
});
