/**
 * ci-shard-aggregate-measured.test.ts — the aggregate asserts that it
 * MEASURED, not merely that it did not fail (#1181), and it does so without
 * `gh` or `actions: read` (#1190).
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
 * **cause of the non-conclusion is unknown**. Nothing below depends on why
 * the shards stalled. The fix must not either.
 *
 * ## Why `if: always()` was never going to cover it
 *
 * `always()` was added so a **failed or cancelled** shard reaches the
 * aggregate instead of skipping it. It is about REACHING the job. The hole is
 * what the job then reads: `needs.<job>.result` collapses a whole matrix into
 * one word, and for a matrix that produced no results that word was
 * `success`.
 *
 * ## What changed in #1190, and why the cases below look different
 *
 * #1189 closed the hole by asking the Actions jobs API, with `gh api`. That
 * worked, and it made every consumer's required check depend on two things
 * the generated `test` job never needed before: **`gh` on the runner image**,
 * which is a GitHub-hosted-image fact and not a runner fact — `ci.runner` is
 * consumer-settable, and a self-hosted or container runner has no `gh` — and
 * **`actions: read` on the job's token**.
 *
 * The evidence is now a **marker the shard writes about itself**: one file
 * per matrix leg, carrying that leg's own `job.status`, uploaded as a tiny
 * artifact and counted by the aggregate. Same-run artifact traffic takes no
 * token and no `permissions:` scope — `actions/download-artifact`'s README
 * says a `github-token` and `actions: read` are "required when downloading
 * artifacts from a different repository or from a different workflow run".
 *
 * A marker is also *stronger* evidence than a conclusion: the API reports
 * what GitHub recorded about a job, while a marker is a file the job's own
 * shell wrote. A leg that was created and never executed leaves nothing,
 * which is exactly `39799846607`'s three queued shards.
 *
 * ## What is executed here, and why it is the shipped text
 *
 * `buildShardAggregateScript()` returns the script the generator writes into
 * `ci.yml`, and it holds **no `${{ }}` expression** — every GitHub-side value
 * arrives through the step's `env:`. That is the property that makes the
 * negative control constructible: the cases below run the real text against a
 * **planted marker directory**, so "a shard never ran" is an input a test can
 * supply rather than a state a test has to describe.
 *
 * `#826`'s lesson is the reason the `env:` block is asserted separately
 * (AC-E below): a script proved correct under an environment the generated
 * step does not supply is a script the suite has never actually exercised.
 *
 * ## The shell, which is half of what #1191 was about
 *
 * Every case runs under **`-e`**, and under `/usr/bin/bash` wherever that
 * path exists — the runner's own `shell: /usr/bin/bash -e {0}`, read off run
 * `39830860194`'s step echo. #1191 shipped a defect on this exact step that
 * existed only under errexit, because the suite proved the script correct
 * under a shell the generated step does not use. `RESOLVED_SHELL` below
 * refuses outright rather than quietly dropping to a shell nobody chose, and
 * `errexit is live` is the harness's own negative control.
 *
 * ## Predicted before the battery ran
 *
 * Shipped script, 10 cases: 2 green (P1, P2), 8 red (N1–N8).
 *
 * Mutant (`SHARD_AGGREGATE_REFUSAL_EXIT` → `0`), 8 red cases: 8 flip to
 * green. A row that cannot move is a row that witnessed nothing.
 *
 * **The cheapest wrong fix, named and measured rather than dismissed:** keep
 * the refusal for a reading it CAN take, and treat a reading it cannot take
 * as nothing to object to — `[ -d "$dir" ] || exit 0`. That is the shape a
 * "don't break consumers who have no `gh`" patch arrives in, and it is the
 * fail-open #1181 is about wearing #1190's clothes. Predicted: **0 of 3** no-
 * evidence cases caught. `M1` below is that fix applied and run.
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
 * developer box has only `/bin/bash`. Both are run with `-e`, which is the
 * property #1191 turned on. Neither present is a REFUSAL — a case that
 * silently fell back to `sh` would be measuring a different program.
 */
const RESOLVED_SHELL = ((): string => {
  for (const candidate of ["/usr/bin/bash", "/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "neither /usr/bin/bash nor /bin/bash exists, so these cases cannot run the shell GitHub runs. UNMEASURED, not a pass.",
  );
})();

/** One matrix leg's marker, or its absence. `null` means the leg left nothing. */
type Marker = string | null;

/** Run `39799846607` itself: shards 1–3 never executed, shard 4 ran and passed. */
const RUN_39799846607: Marker[] = [null, null, null, "success"];

type Run = { code: number | null; out: string; err: string; shell: string };

/**
 * Execute a shard-aggregate script against a planted marker directory.
 *
 * `markers[i]` is what leg `i + 1` left behind: a status string, or `null`
 * for a leg that never executed and so uploaded nothing. `extra` plants
 * markers at indexes the matrix does not declare.
 */
function runAggregate(opts: {
  markers: Marker[];
  rollup: string;
  expected?: string;
  script?: string;
  /** Plant no marker directory at all — the download produced nothing. */
  noMarkerDir?: boolean;
  /** Leave `SHARD_MARKER_DIR` out of the step's env entirely. */
  unsetMarkerDir?: boolean;
  /** Extra marker files, by index, that the matrix never declared. */
  extra?: Record<number, string>;
}): Run {
  const root = mkdtempSync(join(tmpdir(), "rungate-shard-aggregate-"));
  const dir = join(root, "markers");

  if (!opts.noMarkerDir) {
    mkdirSync(dir, { recursive: true });
    opts.markers.forEach((status, i) => {
      if (status === null) return;
      writeFileSync(join(dir, `${SHARD_MARKER_FILE_PREFIX}${i + 1}`), `${status}\n`);
    });
    for (const [index, status] of Object.entries(opts.extra ?? {})) {
      writeFileSync(join(dir, `${SHARD_MARKER_FILE_PREFIX}${index}`), `${status}\n`);
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
 * observed. Without it a row that goes red for an unrelated reason — a typo
 * in the script, a planted directory that never got written — is
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
 * The cheapest wrong fix for #1190: make the reading optional.
 *
 * The rollup check is kept verbatim; the measurement is kept for a reading it
 * can take; and a reading it cannot take becomes a pass instead of a refusal.
 * That is what "don't break consumers whose runner cannot do this" looks like
 * when it is written in a hurry, and it is #1181 arriving through a new door.
 */
const M1_CHEAPEST_WRONG_FIX = `set -uo pipefail
rollup="\${${E.rollup}:-}"
if [ "$rollup" != "success" ]; then
  echo "::error::test-shard concluded '$rollup' — the suite is not green."
  exit 1
fi
expected="\${${E.expected}:-4}"
dir="\${${E.markerDir}:-}"
# "Nothing to read" treated as "nothing to object to".
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "no shard markers available on this runner; skipping the count."
  exit 0
fi
found=0
for marker in "$dir"/${SHARD_MARKER_FILE_PREFIX}*; do
  [ -f "$marker" ] || continue
  found=$((found + 1))
done
if [ "$found" -eq 0 ]; then
  echo "no shard markers found; skipping the count."
  exit 0
fi
echo "All $expected shards passed."
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
    // THE case. If this passes before the fix, nothing has been fixed.
    refusesAndTheMutantDoesNot(
      { markers: RUN_39799846607, rollup: "success" },
      "3 of 4 shards left NO marker",
      '"test-shard (1)"=no-marker',
      "UNMEASURED",
    );
  });

  test("N2 — every shard queued, so not one marker exists, goes RED", () => {
    refusesAndTheMutantDoesNot(
      { markers: [null, null, null, null], rollup: "success" },
      "4 of 4 shards left NO marker",
      "UNMEASURED",
    );
  });

  test("N3 — no marker directory at all is UNMEASURED, and UNMEASURED is red", () => {
    // The download produced nothing. This is the branch most likely to be
    // written fail-open, and fail-open here reproduces the defect exactly —
    // it is also the branch a "degrade gracefully where gh is absent" patch
    // reaches for first.
    refusesAndTheMutantDoesNot(
      { markers: RUN_39799846607, rollup: "success", noMarkerDir: true },
      "no shard markers were downloaded",
      "UNMEASURED",
    );
  });

  test("N4 — an unset marker directory is UNMEASURED, and UNMEASURED is red", () => {
    refusesAndTheMutantDoesNot(
      { markers: RUN_39799846607, rollup: "success", unsetMarkerDir: true },
      `${E.markerDir} is unset`,
      "UNMEASURED",
    );
  });

  test("N5 — a shard whose own marker says failure goes RED even when the rollup says success", () => {
    refusesAndTheMutantDoesNot(
      { markers: ["success", "success", "failure", "success"], rollup: "success" },
      "3 of 4 shards concluded success",
      '"test-shard (3)"=failure',
    );
  });

  test("N6 — a marker that is empty is not a pass", () => {
    // `printf '%s\\n' "$SHARD_STATUS"` with an empty status writes a file
    // that EXISTS and says nothing. Present-but-silent must not count as
    // success, which is the `[ -f ]`-only reading's blind spot.
    refusesAndTheMutantDoesNot(
      { markers: ["success", "", "success", "success"], rollup: "success" },
      "3 of 4 shards concluded success",
      '"test-shard (2)"=empty-marker',
    );
  });

  test("N7 — more markers than the matrix declares goes RED", () => {
    // The evidence and the declaration disagree. A loop that only ever looked
    // at 1..expected would never see this, which is why `found` is counted
    // off the directory rather than off the walk.
    refusesAndTheMutantDoesNot(
      {
        markers: ["success", "success", "success", "success"],
        rollup: "success",
        extra: { 5: "success" },
      },
      "this run left 5 shard markers, and the matrix declares 4",
    );
  });

  test("N8 — a failed and a cancelled rollup still refuse, with the sentences they print today", () => {
    for (const rollup of ["failure", "cancelled"]) {
      refusesAndTheMutantDoesNot(
        { markers: ["success", rollup, "success", "success"], rollup },
        `test-shard concluded '${rollup}' — the suite is not green.`,
      );
    }
  });

  test("P1 — the positive control: an ordinary 4/4 run still passes", () => {
    // Without this, every refusal above is satisfied by a script that
    // refuses everything, which is a gate nobody can ship through.
    const r = runAggregate({ markers: ["success", "success", "success", "success"], rollup: "success" });
    expect(r.code, `an ordinary green run must pass:\n${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 4 shards concluded, and all 4 passed.");
  });

  test("P2 — the printed count is the measured one, not the generated one", () => {
    // "All 4 shards passed" was true-shaped and false on 39799846607 because
    // the 4 came from the generator. Drive a 2-shard matrix and the sentence
    // must follow the evidence.
    const r = runAggregate({ markers: ["success", "success"], rollup: "success", expected: "2" });
    expect(r.code, `${r.out}${r.err}`).toBe(0);
    expect(r.out).toContain("All 2 shards concluded, and all 2 passed.");
    expect(r.out).not.toContain("All 4");
  });

  test("a malformed or zero shard count is UNMEASURED, not an assertion about nothing", () => {
    for (const expected of ["", "four", "0"]) {
      refusesAndTheMutantDoesNot(
        { markers: ["success", "success", "success", "success"], rollup: "success", expected },
        "UNMEASURED",
      );
    }
  });
});

describe("#1190: M1, the cheapest wrong fix, measured", () => {
  const noEvidenceCases: Array<[string, Parameters<typeof runAggregate>[0]]> = [
    ["run 39799846607", { markers: RUN_39799846607, rollup: "success" }],
    ["every shard queued", { markers: [null, null, null, null], rollup: "success" }],
    ["no marker directory at all", { markers: RUN_39799846607, rollup: "success", noMarkerDir: true }],
  ];

  test("it catches 0 of the 3 cases #1181 is about", () => {
    const caught = noEvidenceCases.filter(
      ([, opts]) => runAggregate({ ...opts, script: M1_CHEAPEST_WRONG_FIX }).code !== 0,
    );
    expect(caught.map(([name]) => name), "predicted 0 of 3").toEqual([]);
  });

  test("and the shipped script catches 3 of 3 — the differing input, named", () => {
    // Same three plantings, same rollup. The only thing that changed is the
    // script, so the contrast cannot be explained by the fixture.
    const missed = noEvidenceCases.filter(([, opts]) => runAggregate(opts).code === 0);
    expect(missed.map(([name]) => name), "predicted 3 of 3 caught").toEqual([]);
  });

  test("the two it does catch are the two already caught today, so it buys nothing", () => {
    for (const rollup of ["failure", "cancelled"]) {
      const markers = ["success", rollup, "success", "success"];
      expect(runAggregate({ markers, rollup, script: M1_CHEAPEST_WRONG_FIX }).code).not.toBe(0);
    }
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
    // #826's defect, which is the one this whole file would otherwise repeat:
    // the cases above supply an environment, and a generated step that does
    // not supply the same one leaves them measuring a script nothing calls
    // that way.
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
    // Otherwise the cases above and the generator are two deciders: a
    // generator that stopped calling the builder would leave every case
    // green while `ci.yml` carried something nobody executed
    // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: { test: { steps: Array<{ run?: string }> } };
    };
    const fromFile = parsed.jobs.test.steps.find(s => typeof s.run === "string")?.run ?? "";
    expect(fromFile.trimEnd()).toBe(buildShardAggregateScript().trimEnd());

    // And it refuses run 39799846607 when executed straight off the file.
    expect(runAggregate({ markers: RUN_39799846607, rollup: "success", script: fromFile }).code).not.toBe(0);
    expect(
      runAggregate({ markers: ["success", "success", "success", "success"], rollup: "success", script: fromFile }).code,
    ).toBe(0);
  });

  test("#1190 — the aggregate asks for no scope beyond contents, and no token", () => {
    // The whole of #1190. `actions: read` and `GH_TOKEN` were what #1189 made
    // every consumer's required check depend on.
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

  test("#1190 — each shard uploads a marker, and the aggregate downloads exactly those", () => {
    // Two sides of one fan-in. They must agree through the declaration, not
    // by two hand-written strings that happen to match today.
    const parsed = Bun.YAML.parse(emit(4)) as {
      jobs: {
        "test-shard": { steps: Array<{ uses?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }> };
        test: { steps: Array<{ uses?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean }> };
      };
    };

    const marker = parsed.jobs["test-shard"].steps.find(s => s.env?.[SHARD_MARKER_ENV.status] !== undefined);
    expect(marker, "no shard step records this leg's own status").toBeDefined();
    expect(marker?.if, "a FAILED leg still executed; only an absent marker means it never ran").toBe("always()");

    const upload = parsed.jobs["test-shard"].steps.find(s => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload, "the marker never leaves the shard runner").toBeDefined();
    expect(upload?.if).toBe("always()");
    expect(String(upload?.with?.name)).toStartWith(SHARD_MARKER_ARTIFACT_PREFIX);
    // A warn-only upload is a shard that can lose its evidence quietly, which
    // is the fail-open this whole file exists to refuse.
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    // v4 artifact names are unique per RUN, so "Re-run failed jobs" collides
    // without this and the leg goes red for a reason that is not the suite.
    expect(upload?.with?.overwrite).toBe(true);

    const download = parsed.jobs.test.steps.find(s => s.uses?.startsWith("actions/download-artifact"));
    expect(download, "the aggregate downloads nothing, so it counts nothing").toBeDefined();
    expect(download?.["continue-on-error"], "the REFUSAL must be the script's, with a sentence").toBe(true);
    expect(String(download?.with?.pattern)).toBe(`${SHARD_MARKER_ARTIFACT_PREFIX}*`);
    expect(download?.with?.["merge-multiple"]).toBe(true);
    // The directory the action writes to is the directory the script reads.
    const aggEnv = parsed.jobs.test.steps.find(s => (s as { env?: Record<string, string> }).env?.[E.markerDir]) as
      | { env: Record<string, string> }
      | undefined;
    expect(aggEnv?.env[E.markerDir]).toBe(String(download?.with?.path));
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
