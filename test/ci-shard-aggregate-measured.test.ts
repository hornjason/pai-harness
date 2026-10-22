/**
 * ci-shard-aggregate-measured.test.ts — the aggregate asserts that it
 * MEASURED, not merely that it did not fail (#1181).
 *
 * ## The run
 *
 * PR #1154 merged on run `39799846607`. `test-shard (1)`, `(2)` and `(3)`
 * were `queued`, `completed_at: null`, **no conclusion**. Only shard 4
 * completed. The aggregate `test` job read `needs.test-shard.result` as
 * `success`, printed "All 4 shards passed", and went green in three seconds.
 * The run's own conclusion was `completed/success`. `test` is one of two
 * required checks and auto-merge is armed repo-wide, so a quarter of the
 * suite authorised the merge.
 *
 * The three preceding `main` runs — `39798459849`, `39797839728`,
 * `39794992247` — were 4/4. This is an anomaly, not the pattern, and the
 * **cause of the non-conclusion is unknown**: the issue body blamed runner
 * saturation and cited host load averages, and its author retracted that in a
 * comment — the shards ran on GitHub's runners, this repo has zero
 * self-hosted ones, and load average was separately measured to be a bad
 * instrument. Nothing below depends on why the shards stalled. The fix must
 * not either.
 *
 * ## Why `if: always()` was never going to cover it
 *
 * `always()` was added so a **failed or cancelled** shard reaches the
 * aggregate instead of skipping it. It is about REACHING the job. The hole is
 * what the job then reads: `needs.<job>.result` collapses a whole matrix into
 * one word, and for a matrix that produced no results that word was
 * `success`. A guard against two failure modes, blind to the third.
 *
 * ## What is executed here, and why it is the shipped text
 *
 * `buildShardAggregateScript()` returns the script the generator writes into
 * `ci.yml`, and it holds **no `${{ }}` expression** — every GitHub-side value
 * arrives through the step's `env:`. That is the property that makes the
 * negative control constructible: the cases below run the real text under
 * `/bin/bash` with a stubbed `gh` on PATH, so "a shard never concluded" is an
 * input a test can supply rather than a state a test has to describe.
 *
 * `#826`'s lesson is the reason the `env:` block is asserted separately
 * (AC-E below): a script proved correct under an environment the generated
 * step does not supply is a script the suite has never actually exercised.
 *
 * ## Predicted before the battery ran
 *
 * Shipped script, 8 cases: 2 green (P1, P2), 6 red (N1, N2, N3, N4, N5, N6).
 *
 * Mutant (`SHARD_AGGREGATE_REFUSAL_EXIT` → `0`), 6 red cases: 6 flip to
 * green. A row that cannot move is a row that witnessed nothing.
 *
 * **The cheapest wrong fix, named and measured rather than dismissed:** keep
 * reading only `needs.test-shard.result` and add an empty-string guard —
 * `[ -z "$result" ]` — on the theory that an unconcluded matrix yields an
 * empty rollup. Predicted: **0 of 3** no-conclusion cases caught, because the
 * rollup on `39799846607` was literally the word `success`. The two cases it
 * does catch (failure, cancelled) are the two already caught today, so the
 * repair buys nothing. `M1` below is that fix applied and run.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SHARD_AGGREGATE_ENV,
  SHARD_AGGREGATE_REFUSAL_EXIT,
  buildShardAggregateScript,
  createCiWorkflows,
} from "../lib/scaffold/steps";

const E = SHARD_AGGREGATE_ENV;

/** One matrix leg as the Actions jobs API reports it. */
type JobRow = { name: string; conclusion: string | null; status: string };

const shardJobs = (conclusions: readonly (string | null)[]): JobRow[] =>
  conclusions.map((conclusion, i) => ({
    name: `test-shard (${i + 1})`,
    conclusion,
    status: conclusion === null ? "queued" : "completed",
  }));

/** Run `39799846607` itself: shards 1–3 queued with no conclusion, shard 4 completed. */
const RUN_39799846607 = shardJobs([null, null, null, "success"]);

type Run = { code: number | null; out: string; err: string; ghArgs: string };

/**
 * Execute a shard-aggregate script against a planted jobs payload.
 *
 * `gh` is stubbed with a script that pipes the fixture through the REAL `jq`
 * using the expression the shipped script passed it, so the `--jq` filter is
 * exercised rather than modelled. A stub that answered with a hand-written
 * TSV would agree with any filter at all.
 */
function runAggregate(opts: {
  jobs: JobRow[];
  rollup: string;
  expected?: string;
  script?: string;
  ghFails?: boolean;
}): Run {
  const dir = mkdtempSync(join(tmpdir(), "rungate-shard-aggregate-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  const fixture = join(dir, "jobs.json");
  writeFileSync(fixture, JSON.stringify({ total_count: opts.jobs.length, jobs: opts.jobs }));

  const argsLog = join(dir, "gh-args.txt");
  const ghStub = join(bin, "gh");
  writeFileSync(
    ghStub,
    [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      opts.ghFails ? 'echo "gh: HTTP 403 Resource not accessible by integration" >&2; exit 4' : "",
      'expr=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--jq" ]; then expr="$a"; fi',
      '  prev="$a"',
      "done",
      `/usr/bin/jq -r "$expr" < ${JSON.stringify(fixture)}`,
    ].join("\n"),
  );
  chmodSync(ghStub, 0o755);

  const scriptPath = join(dir, "aggregate.sh");
  writeFileSync(scriptPath, opts.script ?? buildShardAggregateScript());

  // `-e`, because that is the shell GitHub runs a `run:` block under. Read
  // off run 39806067718's own step echo: `shell: /usr/bin/bash -e {0}`.
  // Without it these cases supply a shell the generated step does not, and
  // the first version of this file did exactly that — the API-failure case
  // passed here and would have skipped its own annotation on the runner.
  const r = Bun.spawnSync(["/bin/bash", "-e", scriptPath], {
    cwd: dir,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      [E.rollup]: opts.rollup,
      [E.expected]: opts.expected ?? "4",
      [E.jobName]: "test-shard",
      [E.repo]: "hornjason/pai-harness",
      [E.runId]: "39799846607",
      [E.runAttempt]: "1",
      // One attempt, no sleep. The poll exists for API propagation lag on a
      // real run; a case that waited for it would measure the sleep.
      [E.pollAttempts]: "1",
      [E.pollSeconds]: "0",
    },
  });

  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
    ghArgs: existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "",
  };
}

/**
 * The script with its one refusal constant removed.
 *
 * `.claude/rules/checks-must-be-able-to-fail.md`: each red row is run twice,
 * and the second run is the removal of the non-zero exit, performed and
 * observed. Without it a row that goes red for an unrelated reason — a typo
 * in the script, a stub that failed to start — is indistinguishable from a
 * row that caught what it was pointed at.
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

/**
 * `origin/main`'s aggregate script at `b7281397`, plus the cheapest wrong fix.
 *
 * The real one interpolates `${{ needs.test-shard.result }}` inline; here the
 * rollup is read from the same variable the cases set, which is the same
 * value by a different route. `[ -z "$result" ]` is the added guard.
 */
const M1_CHEAPEST_WRONG_FIX = `set -uo pipefail
result="\${${E.rollup}:-}"
if [ -z "$result" ]; then
  echo "::error::test-shard produced no result — the suite is not green."
  exit 1
fi
if [ "$result" != "success" ]; then
  echo "::error::test-shard concluded '$result' — the suite is not green."
  exit 1
fi
echo "All 4 shards passed."
`;

describe("#1181: the shard aggregate refuses a run it did not measure", () => {
  test("N1 — the defect, reproduced: three shards with no conclusion go RED", () => {
    // THE case. If this passes before the fix, nothing has been fixed.
    const r = runAggregate({ jobs: RUN_39799846607, rollup: "success" });
    expect(r.code, `run 39799846607's own job payload must refuse:\n${r.out}${r.err}`).not.toBe(0);
    expect(r.out + r.err).toContain("3 of 4 shards produced NO conclusion");
    expect(r.out + r.err).toContain('"test-shard (1)"=no-conclusion');
    // And the measured removal: with the refusal constant gone it must pass.
    expect(
      runAggregate({ jobs: RUN_39799846607, rollup: "success", script: mutantScript() }).code,
      "the mutant still refused, so this row's red did not come from the refusal",
    ).toBe(0);
  });

  test("N2 — a matrix leg that was never created at all goes RED", () => {
    // Not the same shape as N1: here the API reports no job, rather than a
    // job with no conclusion. A count read off the payload catches both; a
    // check that only inspects conclusions catches only the first.
    const r = runAggregate({ jobs: shardJobs(["success"]), rollup: "success" });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("the matrix declares 4");
    expect(runAggregate({ jobs: shardJobs(["success"]), rollup: "success", script: mutantScript() }).code).toBe(0);
  });

  test("N3 — a shard whose conclusion is not success goes RED even when the rollup says success", () => {
    const jobs = shardJobs(["success", "success", "failure", "success"]);
    const r = runAggregate({ jobs, rollup: "success" });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("3 of 4 shards concluded success");
    expect(runAggregate({ jobs, rollup: "success", script: mutantScript() }).code).toBe(0);
  });

  test("N4 — an unreadable Actions API is UNMEASURED, and UNMEASURED is red", () => {
    // The branch most likely to be written fail-open. Fail-open here is the
    // defect again, arriving through a different door.
    const r = runAggregate({ jobs: RUN_39799846607, rollup: "success", ghFails: true });
    expect(r.code).not.toBe(0);
    // The annotation, not just the exit code. Under `bash -e` a bare
    // `rows="$(gh …)"` followed by `api_status=$?` aborts at the assignment
    // and this line never prints: red, with no sentence saying why. That is
    // what the `|| api_status=$?` form in the generator is for, and this
    // assertion is what holds it in place.
    expect(r.out + r.err).toContain("UNMEASURED");
    expect(r.out + r.err).toContain("could not read this run's jobs from the Actions API");
    expect(
      runAggregate({ jobs: RUN_39799846607, rollup: "success", ghFails: true, script: mutantScript() }).code,
    ).toBe(0);
  });

  test("N5 — a failed shard still refuses, with the sentence it prints today", () => {
    const jobs = shardJobs(["success", "failure", "success", "success"]);
    const r = runAggregate({ jobs, rollup: "failure" });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("test-shard concluded 'failure' — the suite is not green.");
    expect(runAggregate({ jobs, rollup: "failure", script: mutantScript() }).code).toBe(0);
  });

  test("N6 — a cancelled shard still refuses, with the sentence it prints today", () => {
    const jobs = shardJobs(["success", "cancelled", "success", "success"]);
    const r = runAggregate({ jobs, rollup: "cancelled" });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("test-shard concluded 'cancelled' — the suite is not green.");
    expect(runAggregate({ jobs, rollup: "cancelled", script: mutantScript() }).code).toBe(0);
  });

  test("P1 — the positive control: an ordinary 4/4 run still passes", () => {
    // Without this, every refusal above is satisfied by a script that
    // refuses everything, which is a gate nobody can ship through.
    const r = runAggregate({ jobs: shardJobs(["success", "success", "success", "success"]), rollup: "success" });
    expect(r.code, `an ordinary green run must pass:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 4 shards concluded, and all 4 passed.");
  });

  test("P2 — the printed count is the measured one, not the generated one", () => {
    // "All 4 shards passed" was true-shaped and false on 39799846607 because
    // the 4 came from the generator. Drive a 2-shard matrix and the sentence
    // must follow the payload.
    const r = runAggregate({
      jobs: shardJobs(["success", "success"]),
      rollup: "success",
      expected: "2",
    });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 2 shards concluded, and all 2 passed.");
    expect(r.out).not.toContain("All 4");
  });

  test("the reading is taken against this run's own attempt", () => {
    // A jobs listing defaulting to another attempt would answer with a
    // previous run's conclusions, which is a measurement of the wrong thing
    // that looks exactly like a measurement of the right one.
    const r = runAggregate({ jobs: shardJobs(["success", "success", "success", "success"]), rollup: "success" });
    expect(r.ghArgs).toContain("repos/hornjason/pai-harness/actions/runs/39799846607/attempts/1/jobs");
  });
});

describe("#1181: M1, the cheapest wrong fix, measured", () => {
  const noConclusionCases: Array<[string, JobRow[]]> = [
    ["run 39799846607", RUN_39799846607],
    ["every shard queued", shardJobs([null, null, null, null])],
    ["a leg that was never created", shardJobs(["success"])],
  ];

  test("it catches 0 of the 3 cases #1181 is about", () => {
    const caught = noConclusionCases.filter(
      ([, jobs]) => runAggregate({ jobs, rollup: "success", script: M1_CHEAPEST_WRONG_FIX }).code !== 0,
    );
    expect(caught.map(([name]) => name), "predicted 0 of 3").toEqual([]);
  });

  test("and the shipped script catches 3 of 3 — the differing input, named", () => {
    // Same three payloads, same rollup. The only thing that changed is the
    // script, so the contrast cannot be explained by the fixture.
    const missed = noConclusionCases.filter(([, jobs]) => runAggregate({ jobs, rollup: "success" }).code === 0);
    expect(missed.map(([name]) => name), "predicted 3 of 3 caught").toEqual([]);
  });

  test("the two it does catch are the two already caught today, so it buys nothing", () => {
    for (const rollup of ["failure", "cancelled"]) {
      const jobs = shardJobs(["success", rollup, "success", "success"]);
      expect(runAggregate({ jobs, rollup, script: M1_CHEAPEST_WRONG_FIX }).code).not.toBe(0);
    }
  });
});

describe("#1181: the generated workflow supplies what the script reads", () => {
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
    // #826's defect, which is the one this whole file would otherwise repeat:
    // the cases above supply an environment, and a generated step that does
    // not supply the same one leaves them measuring a script nothing calls
    // that way.
    const yml = emit(4);
    const script = buildShardAggregateScript();
    for (const name of Object.values(E)) {
      if (!script.includes(name)) continue;
      // The poll knobs are deliberately defaulted in-script rather than set
      // in YAML; the rest must appear as keys in the step's env block.
      if (name === E.pollAttempts || name === E.pollSeconds) continue;
      expect(yml, `${name} is read by the script and never set by the workflow`).toContain(`          ${name}:`);
    }
    expect(yml).toContain("GH_TOKEN: ${{ github.token }}");
  });

  test("the aggregate holds no GitHub expression, so the shipped text is the text under test", () => {
    expect(buildShardAggregateScript()).not.toContain("${{");
  });

  test("the script the FILE carries is the script the cases ran", () => {
    // Otherwise the cases above and the generator are two deciders: a
    // generator that stopped calling the builder would leave every case
    // green while `ci.yml` carried something nobody executed
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: { test: { steps: Array<{ run?: string }> } };
    };
    const fromFile = parsed.jobs.test.steps[0]?.run ?? "";
    expect(fromFile.trimEnd()).toBe(buildShardAggregateScript().trimEnd());

    // And it refuses run 39799846607 when executed straight off the file.
    expect(runAggregate({ jobs: RUN_39799846607, rollup: "success", script: fromFile }).code).not.toBe(0);
    expect(
      runAggregate({ jobs: shardJobs(["success", "success", "success", "success"]), rollup: "success", script: fromFile })
        .code,
    ).toBe(0);
  });

  test("the job grants itself the scope the reading needs", () => {
    const yml = emit(4);
    expect(yml).toContain("actions: read");
  });

  test("the matrix width and the asserted width come from one declaration", () => {
    for (const shards of [2, 4, 7]) {
      const yml = emit(shards);
      expect(yml).toContain(`shard: [${Array.from({ length: shards }, (_, i) => i + 1).join(", ")}]`);
      expect(yml).toContain(`${E.expected}: "${shards}"`);
    }
  });

  test("an unsharded consumer gets no aggregate and no API reading", () => {
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
  });
});
