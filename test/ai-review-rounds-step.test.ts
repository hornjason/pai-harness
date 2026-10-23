/**
 * The generated round-counting step, and its agreement with the library that
 * decides the same thing (#1168).
 *
 * Covers CRC-N1 (CODE-REVIEW-CONVERGENCE-SPEC.md).
 *
 * `AC-S1` binds the cap to the library's, `AC-S2` holds the bash and the
 * library to one at-cap decision, `AC-S3` makes an unreadable count red
 * rather than a first round, `AC-S4` finds the step in the COMMITTED
 * workflow, and `AC-S5` reads the at-cap branch asking the reviewer for an
 * approach assessment and refusing silence. That conjunction is the
 * criterion. No new assertion is added for the id.
 *
 * `lib/ai-review-rounds.ts` is the source of truth and it delegates the
 * budget arithmetic to `reReviewDecision` in `lib/security-verdict.ts`.
 * `lib/scaffold/ai-review-step.ts` cannot import it — a relative import
 * added to that file resolves to nothing inside the `mkdtemp` directory the
 * ai-review mutation batteries copy it into, so the mutant fails to LOAD and
 * every case comparing real against mutant goes red while witnessing nothing
 * (`.claude/rules/self-referential-tests.md`, Tier 1, last row). The rule's
 * own remedy for a file that must stay import-free is an agreement
 * assertion, and this file is it.
 *
 *  - AC-S1  the two cap literals equal the library's
 *  - AC-S2  the generated bash agrees with the library over one input matrix
 *  - AC-S3  the refusal is routed through one constant, and it can fail
 *  - AC-S4  the step is in the committed workflow, with the permission it needs
 *  - AC-S5  nothing the branch under review wrote reaches the prompt
 *  - AC-S8  the query carries no `status=` term, and must not grow one
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND,
  AI_REVIEW_ROUND_CAP,
  AI_REVIEW_ROUND_AT_CAP,
  AI_REVIEW_ROUND_OPEN,
  REVIEW_SCOPE_DIFF,
  REVIEW_SCOPE_FULL,
  reviewScopeForRound,
  roundOutcome,
} from "../lib/ai-review-rounds.ts";
import {
  AI_REVIEW_AT_CAP_OUTPUT,
  AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL,
  AI_REVIEW_FINDINGS_COMMAND,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_JOB,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_ROUNDS_STEP_ID,
  AI_REVIEW_ROUNDS_TITLE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_ROUND_CAP_LITERAL,
  AI_REVIEW_ROUND_OUTPUT,
  AI_REVIEW_ROUND_PATH_VAR,
  AI_REVIEW_RUN_STEP_ID,
  buildReviewPrompt,
  buildRoundsScript,
} from "../lib/scaffold/ai-review-step.ts";
import { gitFixtureTestTimeout } from "./helpers/git-fixture-budget";

/**
 * The second file in the state #1402 was filed about, and it was NOT the one
 * reported — it was found by supplying `AC-5` the JUnit reading it says it
 * needs, instead of accepting its UNMEASURED.
 *
 * `AC-S3: a count that cannot be read refuses, and names the permission` ran
 * 6284.99ms against the 5,000ms this file inherits — 125.7% of it, so already
 * over, on a machine fast enough to keep CI green. The sibling that prompted
 * the issue was at 100.1%; this one is worse and nobody had looked.
 *
 * Same remedy and the same reason as `ai-review-ledger-step.test.ts`: the
 * quantity that varies is the machine, so the budget is calibrated against
 * the machine rather than guessed at as a literal.
 */
setDefaultTimeout(gitFixtureTestTimeout());

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = join(ROOT, ".github/workflows/ai-review.yml");

describe("AC-S1: the literals are bound to the library", () => {
  test("AC-S1: the cap and the diff floor agree", () => {
    expect(
      AI_REVIEW_ROUND_CAP_LITERAL,
      "lib/scaffold/ai-review-step.ts spells the cap as a literal because it " +
        "may not import; change one and change the other",
    ).toBe(AI_REVIEW_ROUND_CAP);
    expect(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL).toBe(AI_REVIEW_DIFF_SCOPE_FROM_ROUND);
  });

  test("AC-S1: ai-review-step.ts still has no relative import of the library", () => {
    // The property the agreement assertion exists to preserve. If somebody
    // "fixes" the duplication with an import, the mutation batteries that
    // copy this file into an mkdtemp stop loading it.
    //
    // Matched on the IMPORT and not on the name: the file names
    // `lib/ai-review-rounds.ts` in prose, deliberately, and a `toContain`
    // over the bare name forbids explaining where the source of truth is.
    const src = readFileSync(join(ROOT, "lib/scaffold/ai-review-step.ts"), "utf8");
    const relativeImports = [
      ...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm),
    ].map(m => m[1]!);
    expect(relativeImports.filter(s => s.includes("ai-review-rounds"))).toEqual([]);
    expect(src).not.toContain('require("../ai-review-rounds');
  });
});

/**
 * Run the generated script under the shell the runner uses, with the
 * environment the generated step supplies, and a `curl` that answers from a
 * fixture.
 *
 * `bash -e` and not a plain `bash`: a GitHub `run:` block executes
 * under `bash -e`, and spawning a plain shell runs a different program
 * (`.claude/rules/…`, and #1191 in this file's own history).
 */
function runRounds(
  env: Record<string, string>,
  totalCount: string | null,
  // The script under test. Defaulted, so every existing case runs the real
  // one; passed explicitly only to run a mutant through the identical rig
  // (#1255), because a mutant executed by different plumbing is a second
  // experiment rather than a control.
  script_ = buildRoundsScript(),
) {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-rounds-"));
  try {
    const out = join(dir, "out.txt");
    writeFileSync(out, "");
    // The reviewer's copy of the round state. This is the file #1241's scope
    // actually travelled on — not the step output, which nothing reads — so
    // a case about what the reviewer is told has to assert on THIS.
    const roundPath = join(dir, "round.txt");
    const bin = join(dir, "bin");
    require("node:fs").mkdirSync(bin);
    // The REQUEST, not just the response. #1281 was a defect in what the step
    // ASKED FOR — a branch name with no pull-request scope — and a fake curl
    // that only answers cannot see that. It records its own argv first.
    const argvPath = join(dir, "curl-argv.txt");
    const record = `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}\n`;
    // A curl that answers from the fixture. `--fail-with-body` semantics are
    // reproduced by exiting non-zero when the fixture is null.
    writeFileSync(
      join(bin, "curl"),
      totalCount === null
        ? `${record}exit 22\n`
        : `${record}printf '%s' '{"total_count":${totalCount},"workflow_runs":[]}'\n`,
      { mode: 0o755 },
    );
    const script = join(dir, "step.sh");
    writeFileSync(script, script_);
    const r = spawnSync("bash", ["-e", script], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: out,
        [AI_REVIEW_ROUND_PATH_VAR]: roundPath,
        AI_REVIEW_ROUNDS_BRANCH: "rg/1168",
        // Required since #1281 — the step refuses without it rather than
        // widening the query to the branch name. Defaulted here so every
        // case that is not ABOUT the scope term keeps its own subject;
        // the cases that are about it pass their own value, including "".
        AI_REVIEW_ROUNDS_SINCE: "2026-01-01T00:00:00Z",
        AI_REVIEW_ROUNDS_REPO: "o/r",
        AI_REVIEW_ROUNDS_API: "https://api.github.test",
        AI_REVIEW_ROUNDS_TOKEN: "t",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
    }
    const roundFile = existsSync(roundPath) ? readFileSync(roundPath, "utf8") : null;
    const argv = existsSync(argvPath) ? readFileSync(argvPath, "utf8").split("\n").filter(Boolean) : [];
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", outputs, roundFile, argv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("AC-S2: the bash and the library agree", () => {
  // Every row the library has an opinion about, run through both.
  const MATRIX = ["1", "2", "3", "4", "5", "12"];

  test("AC-S2: the open/at-cap decision is the same in both", () => {
    for (const round of MATRIX) {
      const lib = roundOutcome(round);
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, round);
      expect(sh.status, `round ${round}: ${sh.stderr}`).toBe(0);
      expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT], `round ${round}`).toBe(round);
      const shAtCap = sh.outputs[AI_REVIEW_AT_CAP_OUTPUT] === "1";
      expect(shAtCap, `round ${round}: bash says at_cap=${shAtCap}`).toBe(
        lib.decision === AI_REVIEW_ROUND_AT_CAP,
      );
      expect(lib.decision === AI_REVIEW_ROUND_OPEN || shAtCap).toBe(true);
    }
  }, 30_000);

  test("AC-S2: the step decides NO scope, on any round, in the file or the outputs", () => {
    // #1241 pinned the value to `full` and kept the variable, the output and
    // the round-file field. #1255 removes them: a second site that decides a
    // scope is a second decider `reviewScopeForRound` cannot see, and a
    // hardcoded safe value one line from the edit that reopens #244 is the
    // fifth shape — green today, green under the cheapest wrong fix.
    for (const round of MATRIX) {
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, round);
      expect(sh.roundFile, `round ${round}: no round file written`).not.toBeNull();
      expect(sh.roundFile, `round ${round}: the reviewer is told a scope`).not.toContain(
        "review_scope",
      );
      expect(Object.keys(sh.outputs), `round ${round}`).not.toContain("scope");
      // The control for the two negatives above: the file was written and
      // carries the state it is supposed to, so "no scope" is a reading of a
      // real file and not of an empty one.
      expect(sh.roundFile, `round ${round}`).toContain(`review_round=${round}`);
    }
    // The second control: a round at or past the old floor is in the matrix,
    // so the rows above are not green for never having reached one.
    expect(MATRIX.some(r => Number(r) >= AI_REVIEW_DIFF_SCOPE_FROM_ROUND)).toBe(true);
  }, 30_000);

  test("AC-S2: the MUTANT — the #1241 scope block restored — reaches the reviewer", () => {
    // The removal, performed and observed. Without this the case above is a
    // pair of `not.toContain`s that would also be green if the round file had
    // stopped mentioning anything at all, or if `runRounds` had quietly
    // stopped planting the path.
    //
    // The mutant is the code #1255 deleted, re-inserted verbatim in shape: a
    // round-number floor and the field it used to write. Nothing else differs
    // and it runs through the same rig.
    const real = buildRoundsScript();
    const mutant = real
      .replace(
        'round="${total}"',
        `round="\${total}"\nscope=full\nif [ "\${round}" -ge ${AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL} ]; then\n  scope=diff\nfi`,
      )
      .replace(
        "printf 'round_budget_spent=%s\\n'",
        "printf 'review_scope=%s\\n' \"${scope}\"\n    printf 'round_budget_spent=%s\\n'",
      );
    expect(mutant, "the mutation did not apply — this measures nothing").not.toBe(real);

    const past = String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL);
    const mut = runRounds({ AI_REVIEW_EVENT: "pull_request" }, past, mutant);
    const realRun = runRounds({ AI_REVIEW_EVENT: "pull_request" }, past);
    // One input, one rig, two scripts. The reviewer is handed a narrowed
    // scope by the mutant and nothing by the real step — which is the whole
    // of #1241 reproduced on the path it actually travelled.
    expect(mut.roundFile, `round ${past}: mutant`).toContain(`review_scope=${REVIEW_SCOPE_DIFF}`);
    expect(realRun.roundFile, `round ${past}: real`).not.toContain("review_scope");
  }, 30_000);
});

describe("AC-S7 (#1281): the count is scoped to THIS pull request", () => {
  const SINCE = "2026-10-22T21:40:11Z";

  test("AC-S7: the request carries the PR's creation time, not a branch name alone", () => {
    // A branch NAME is not a pull request. The runs API has no
    // `pull_request=` filter, so the scope has to come from somewhere else:
    // this asks for runs at or after the PR opened, and an earlier PR on the
    // same branch name is strictly before that (GitHub permits only one open
    // PR per head). Measured against the real API while writing this:
    // `created=>=2020-01-01` returns 2 for rg/1241 and `>=2030-01-01`
    // returns 0, so the filter is honoured and is not a no-op.
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request", AI_REVIEW_ROUNDS_SINCE: SINCE }, "2");
    expect(sh.status, sh.stderr).toBe(0);
    expect(sh.argv, "the step never called curl").not.toEqual([]);
    expect(sh.argv).toContain(`created=>=${SINCE}`);
    // The control: the branch filter is still sent, so the row above is not
    // green because the query lost its other terms.
    expect(sh.argv).toContain("branch=rg/1168");
  }, 30_000);

  test("AC-S7: the MUTANT — the scope term removed — asks the branch-name question", () => {
    // The removal, performed and observed. This is the query #1281 reported,
    // reproduced exactly, so the case above is red for the defect and not
    // for some other difference between two requests.
    const real = buildRoundsScript();
    const mutant = real.replace(/\n\s*--data-urlencode "created=>=\$\{AI_REVIEW_ROUNDS_SINCE\}" \\/, "");
    expect(mutant, "the mutation did not apply — this measures nothing").not.toBe(real);

    const env = { AI_REVIEW_EVENT: "pull_request", AI_REVIEW_ROUNDS_SINCE: SINCE };
    const mut = runRounds(env, "2", mutant);
    const realRun = runRounds(env, "2");
    expect(mut.argv.some(a => a.startsWith("created=")), "mutant still scopes").toBe(false);
    expect(realRun.argv.some(a => a.startsWith("created="))).toBe(true);
    // Both still ask the branch question, so the pair differs in one term.
    expect(mut.argv).toContain("branch=rg/1168");
  }, 30_000);

  test("AC-S7: an absent creation time is UNMEASURED, never a wider query", () => {
    // The fail-open this is built against: defaulting the term away leaves a
    // well-formed request, a plausible integer, and the #1281 defect back —
    // silently. So its absence refuses, with the annotation and not merely
    // the status (the sixth shape).
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request", AI_REVIEW_ROUNDS_SINCE: "" }, "2");
    expect(sh.status).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(sh.stderr).toContain(AI_REVIEW_ROUNDS_TITLE);
    // It refuses BEFORE asking, so no branch-name count is ever taken.
    expect(sh.argv, "it queried anyway, with no pull-request scope").toEqual([]);
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
  }, 30_000);

  test("AC-S7: the committed workflow feeds it from the event payload", () => {
    const doc = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as any;
    const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
      (s: any) => s?.id === AI_REVIEW_ROUNDS_STEP_ID,
    );
    // No extra API call: the PR's creation time is already in the payload.
    expect(step?.env?.AI_REVIEW_ROUNDS_SINCE).toBe(
      "${{ github.event.pull_request.created_at }}",
    );
  });
});

describe("AC-S3: UNMEASURED is red, and the refusal can fail", () => {
  test("AC-S3: a count that cannot be read refuses, and names the permission", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, null);
    expect(sh.status).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(sh.stderr).toContain(AI_REVIEW_ROUNDS_TITLE);
    expect(sh.stderr).toContain("actions: read");
    // Not a skip and not a pass. The three outputs must be absent, or a
    // later step reads an empty round as round 1.
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
  }, 30_000);

  // The three cases below each assert the ANNOTATION as well as the status,
  // and that is the point rather than belt-and-braces. `bash -e` aborts this
  // script on any unguarded command failure, with the very status the refusal
  // exits on and nothing on stderr — so a status-only assertion is green for
  // an abort and green for the refusal alike, and cannot tell them apart.
  // That is the sixth shape in `.claude/rules/checks-must-be-able-to-fail.md`
  // and it was live in this file (#1236): assert something only the intended
  // mechanism can produce.
  test("AC-S3: a count of ZERO refuses — it has not counted this run", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "pull_request" }, "0");
    expect(sh.status).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(sh.stderr, "exited with the right status but wrote no annotation").toContain(
      AI_REVIEW_ROUNDS_TITLE,
    );
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
  }, 30_000);

  test("AC-S3: a missing branch or token refuses before it calls anything", () => {
    for (const blank of ["AI_REVIEW_ROUNDS_BRANCH", "AI_REVIEW_ROUNDS_TOKEN"]) {
      const sh = runRounds({ AI_REVIEW_EVENT: "pull_request", [blank]: "" }, "2");
      expect(sh.status, blank).toBe(AI_REVIEW_REQUIRED_EXIT);
      expect(sh.stderr, `${blank}: right status, no annotation`).toContain(
        AI_REVIEW_ROUNDS_TITLE,
      );
    }
  }, 30_000);

  test("AC-S3: the MUTANT — exit 0 instead of the constant — stops refusing", () => {
    // The removal of the non-zero exit, performed and observed. Without it a
    // case that later passes for an unrelated reason is indistinguishable
    // from one that is genuinely caught
    // (`.claude/rules/checks-must-be-able-to-fail.md`).
    const real = buildRoundsScript();
    const occurrences = real.split(`exit ${AI_REVIEW_REQUIRED_EXIT}`).length - 1;
    expect(occurrences, "every refusal must route through the one constant").toBe(2);
    const mutant = real.replaceAll(`exit ${AI_REVIEW_REQUIRED_EXIT}`, "exit 0");

    const dir = mkdtempSync(join(tmpdir(), "ai-review-rounds-mut-"));
    try {
      const out = join(dir, "out.txt");
      writeFileSync(out, "");
      const bin = join(dir, "bin");
      require("node:fs").mkdirSync(bin);
      writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nexit 22\n", { mode: 0o755 });
      const script = join(dir, "mutant.sh");
      writeFileSync(script, mutant);
      const r = spawnSync("bash", ["-e", script], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: out,
          AI_REVIEW_ROUNDS_BRANCH: "rg/1168",
          AI_REVIEW_ROUNDS_REPO: "o/r",
          AI_REVIEW_ROUNDS_API: "https://api.github.test",
          AI_REVIEW_ROUNDS_TOKEN: "t",
          AI_REVIEW_EVENT: "pull_request",
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      // Real: 1. Mutant: 0. One input, both observed.
      expect(r.status, "the mutant must NOT refuse, or the case witnessed nothing").toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("AC-S3: merge_group is not a round, and is not a refusal either", () => {
    const sh = runRounds({ AI_REVIEW_EVENT: "merge_group" }, null);
    expect(sh.status).toBe(0);
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBe("");
    // No scope here either (#1255). The early-exit branch used to emit one,
    // which made the merge_group path a THIRD place deciding a scope.
    expect(Object.keys(sh.outputs)).not.toContain("scope");
  });
});

describe("AC-S4: the step is in the committed workflow", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  test("AC-S4: the step, its id, and the permission it needs", () => {
    expect(yml).toContain(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    expect(yml).toContain("actions: read");
  });

  test("AC-S4: it runs BEFORE the review action, or its outputs are unreadable", () => {
    const rounds = yml.indexOf(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    const review = yml.indexOf("id: ai-review-action");
    expect(rounds).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(-1);
    expect(rounds).toBeLessThan(review);
  });

  test("AC-S4: the committed workflow carries the generated script verbatim", () => {
    // The drift this catches is a hand-edit of the generated file. The
    // refusal line is the one worth pinning: it is the whole gate.
    expect(yml).toContain(AI_REVIEW_ROUNDS_TITLE);
    expect(yml).toContain("cannot tell which review round it is on");
    expect(yml).toContain(`exit ${AI_REVIEW_REQUIRED_EXIT}`);
  });

  test("AC-S4: the step has no continue-on-error — a counted round or a red check", () => {
    const at = yml.indexOf(`id: ${AI_REVIEW_ROUNDS_STEP_ID}`);
    const next = yml.indexOf("- name:", at);
    const block = yml.slice(at, next === -1 ? undefined : next);
    expect(block).not.toContain("continue-on-error");
  });
});

describe("AC-S5: nothing from the branch under review reaches the prompt", () => {
  const prompt = buildReviewPrompt();
  // The prompt is hard-wrapped, so a phrase spanning a line break is still
  // one phrase. Asserted over the unwrapped text; the `${{` case below
  // deliberately reads the RAW prompt, because a wrap cannot hide one.
  const flat = prompt.replace(/\s+/g, " ");

  test("AC-S5: the round state reaches the reviewer as a FILE, not an expression", () => {
    // AC-6b in test/ai-review-credentialed-job.test.ts forbids any `${{` in
    // the prompt, and it is right: an expression is substituted before the
    // action sees the text, so it is content rather than instruction. The
    // first draft of #1168 interpolated three closed-set values and argued
    // they were safe. They were; the rule is still right, because "this one
    // is a closed set" is how the next one gets in. Asserted here as well as
    // there, because this is the change that would have broken it.
    expect(prompt).not.toContain("${{");
    expect(prompt).toContain(AI_REVIEW_ROUND_PATH_VAR);
  });

  test("AC-S5: the prompt names the three fields the state file carries", () => {
    for (const field of ["review_round", "round_budget", "round_budget_spent"]) {
      expect(prompt, `the prompt never tells the reviewer to read ${field}`).toContain(field);
      expect(
        buildRoundsScript(),
        `the step never writes ${field}, so the prompt asks for a field nobody emits`,
      ).toContain(field);
    }
  });

  test("AC-S5: the at-cap branch asks for an approach assessment and refuses silence", () => {
    expect(prompt).toContain("THE ROUND BUDGET IS SPENT");
    expect(prompt).toContain("APPROACH");
    expect(prompt).toContain("non-blocking severity");
    expect(flat).toContain("Do not stay silent");
  });

  test("AC-S5: the prompt names no scope at all, and says to read everything", () => {
    // The field is gone from the file (#1255), so the prompt may not name it:
    // a prompt describing a field nobody writes is an instruction the
    // reviewer cannot follow, and the previous wording explained a narrowing
    // that no longer has a mechanism behind it.
    expect(flat, "the prompt names a field the step no longer writes").not.toContain(
      "review_scope",
    );
    // Said positively too, so the absence above is not the only thing
    // standing between here and a reviewer inventing its own scope.
    expect(flat).toContain("READ THE WHOLE BRANCH, ON EVERY ROUND");
    expect(flat).toContain("nothing carries its findings forward for you");
  });

  test("AC-S5: an absent state file is a stated case, not an undefined one", () => {
    // The file can be missing — the step refuses before writing it when the
    // count is unreadable, and that refusal reds the job, but the reviewer
    // action carries `continue-on-error` and the prompt must still say what
    // to do rather than leave the reviewer to invent a round.
    expect(flat).toContain("absent or unreadable");
  });

  test("AC-S5: the cap the prompt describes is the library's", () => {
    // The prompt says `round_budget` rather than a literal, so the number
    // itself lives in one place. This is the binding that keeps that true.
    expect(buildRoundsScript()).toContain(`round_budget=%s\\n' '${AI_REVIEW_ROUND_CAP}'`);
  });
});

// ── AC-S6 (#1241): the cap bounds re-litigation, never the gate ─────────

/**
 * The defect this block exists for, as it shipped in #1236.
 *
 * A pull request reaches round 4 carrying an unfixed blocking finding from
 * round 2. The prompt told the reviewer the finding was "carried forward for
 * you" — nothing carried it — and told it not to use a blocking severity. The
 * required check went green over a live finding.
 *
 * So two properties, and they are different in kind:
 *
 *  - the cap may not reach the BLOCKING DECISION. Asserted behaviourally,
 *    against the committed verdict step, with a mutant to show the case is
 *    not vacuous.
 *  - the cap may not tell the REVIEWER to withhold a blocking severity, and
 *    the prompt may not promise an enforcement nothing performs. Asserted
 *    over the prompt text, which is the only instruction the reviewer gets.
 */
describe("AC-S6 (#1241): the cap bounds re-litigation, never the gate", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  /** The committed verdict step's bash — the thing that actually decides. */
  function committedVerdictScript(): string {
    const doc = Bun.YAML.parse(yml) as any;
    const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
      (s: any) => s?.id === AI_REVIEW_RUN_STEP_ID,
    );
    if (step === undefined) throw new Error(`no ${AI_REVIEW_RUN_STEP_ID} step in the workflow`);
    const script = String(step.run ?? "");
    if (!script.includes(AI_REVIEW_FINDINGS_COMMAND)) {
      throw new Error(
        `the committed ${AI_REVIEW_RUN_STEP_ID} step does not invoke ` +
          `'${AI_REVIEW_FINDINGS_COMMAND}', so these cases would drive a step that ` +
          `adjudicates nothing`,
      );
    }
    return script;
  }

  /**
   * Run a verdict script with a BLOCKING adjudication, at the cap.
   *
   * The at-cap state is put in the environment under every spelling the step
   * could plausibly read it by, so a step that grew a dependency on it is
   * caught whichever name it used.
   */
  function runVerdict(script: string): { status: number | null; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-cap-gate-"));
    try {
      const bin = join(dir, "bin");
      require("node:fs").mkdirSync(bin);
      writeFileSync(
        join(bin, "bunx"),
        `#!/bin/sh\necho "${AI_REVIEW_OUTCOME_LINE} BLOCKED"\nexit ${AI_REVIEW_REQUIRED_EXIT}\n`,
        { mode: 0o755 },
      );
      const payload = join(dir, "ai-review-findings.json");
      writeFileSync(
        payload,
        JSON.stringify({
          findings: [
            {
              severity: "high",
              file: "lib/a.ts",
              line: 1,
              summary: "raised on round 2 and never fixed",
              failure_scenario: "any input",
            },
          ],
          verdict: "BLOCK",
        }),
      );
      const sh = join(dir, "verdict.sh");
      writeFileSync(sh, script);
      const r = spawnSync("bash", ["-e", sh], {
        encoding: "utf8",
        cwd: dir,
        timeout: 60_000,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: dir,
          AI_REVIEW_MODE: "vertex",
          AI_REVIEW_ACTION_OUTCOME: "success",
          [AI_REVIEW_FINDINGS_PATH_VAR]: payload,
          // Every spelling of "the budget is spent".
          AI_REVIEW_AT_CAP: "1",
          [AI_REVIEW_AT_CAP_OUTPUT.toUpperCase()]: "1",
          AI_REVIEW_ROUND: "4",
          [AI_REVIEW_ROUND_OUTPUT.toUpperCase()]: "4",
        },
      });
      return { status: r.status, stdout: r.stdout ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("AC-S6: at cap, an unresolved blocking finding still fails the check", () => {
    // #1241's acceptance criterion, stated in its own words.
    const r = runVerdict(committedVerdictScript());
    expect(
      r.status,
      "a blocking adjudication at the round cap must still exit non-zero — a cap that " +
        "downgrades the verdict is a required check turning itself off",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  }, 30_000);

  test("AC-S6: the MUTANT — a step that honours the cap — goes green, so the case is not vacuous", () => {
    // Without this row the one above is the third shape in
    // `.claude/rules/checks-must-be-able-to-fail.md`: an assertion that holds
    // because the input it varies reaches nothing. This performs the
    // regression — a verdict step that reads the cap and exits 0 — and
    // observes it, so real-red / mutant-green is one measured pair.
    const mutant =
      `if [ "\${AI_REVIEW_AT_CAP:-}" = "1" ]; then\n  exit 0\nfi\n` + committedVerdictScript();
    const r = runVerdict(mutant);
    expect(
      r.status,
      "the mutant must NOT refuse, or the case above witnessed nothing",
    ).toBe(0);
  }, 30_000);

  test("AC-S6: no step in the committed job reads the cap output", () => {
    // The structural half of the behavioural pair. The only producer of
    // `at_cap` is the rounds step; the only legitimate consumer is its own
    // annotation. Any OTHER step referencing it is a route by which the cap
    // could reach a verdict, and this names them rather than waiting for one
    // to change an exit code.
    const doc = Bun.YAML.parse(yml) as any;
    const steps = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []) as any[];
    const readers = steps
      .filter(s => s?.id !== AI_REVIEW_ROUNDS_STEP_ID)
      .filter(s => JSON.stringify(s ?? {}).includes(`outputs.${AI_REVIEW_AT_CAP_OUTPUT}`))
      .map(s => String(s?.id ?? s?.name ?? "(unnamed)"));
    expect(
      readers,
      "a step other than the rounds step reads the at-cap output — the cap must not be " +
        "an input to anything that decides whether this check fails (#1241)",
    ).toEqual([]);
  });

  test("AC-S6: the prompt does not forbid a blocking severity at cap", () => {
    const prompt = buildReviewPrompt();
    const flat = prompt.replace(/\s+/g, " ");
    expect(
      flat,
      "the at-cap arm told the reviewer not to raise a blocking severity, which is how a " +
        "live finding reached a green check (#1241)",
    ).not.toContain("Do not raise it to a blocking severity");
    // And it says the opposite, positively, so the absence above is not the
    // only thing standing between here and the regression.
    expect(flat).toContain("CHANGES NOTHING ABOUT WHAT BLOCKS");
    expect(flat).toContain("exactly as you would on round 1");
  });

  test("AC-S6: the prompt promises no carry-forward while nothing carries forward", () => {
    // The promise and the mechanism are asserted TOGETHER, in one case, so
    // they cannot be re-separated: the sentence is allowed back the moment a
    // production caller exists, and not before.
    const prompt = buildReviewPrompt();
    const flat = prompt.replace(/\s+/g, " ");
    // Detect an IMPORT of the module, not a mention of the symbols. A prose
    // mention is a citation, not a claim — `.claude/rules/claiming-sc-coverage.md`
    // — and the first draft of this case was red because the comment this very
    // change added to `lib/scaffold/ai-review-step.ts` says the word
    // `carryForward` while calling nothing. An importer is the thing a caller
    // cannot be without: the library is a module, so no import, no call site.
    // POSIX ERE, not PCRE: `git grep -E` has no `\s`, and a pattern it cannot
    // match is indistinguishable from a tree with no callers — which is what
    // the control below caught when this line was first written with `\s+`.
    const IMPORTS = String.raw`from[[:space:]]+"[^"]*ai-review-rounds(\.ts)?"`;
    const callers = spawnSync(
      "git",
      ["grep", "-l", "-E", IMPORTS, "--", "lib", "gates", "scripts", "workflows", "bin"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const production = (callers.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .filter(f => f !== "lib/ai-review-rounds.ts");
    // The control: the detector finds an importer when there is one. Without
    // this row, a pattern that matches nothing at all reads exactly like a
    // tree with no production callers, and the branch below holds vacuously.
    const anyImporter = spawnSync(
      "git",
      ["grep", "-l", "-E", IMPORTS, "--", "test"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(
      (anyImporter.stdout ?? "").split("\n").filter(Boolean),
      "the import pattern matches no file anywhere, so it cannot distinguish " +
        "'no production caller' from 'broken detector'",
    ).toContain("test/ai-review-rounds-step.test.ts");
    if (production.length === 0) {
      expect(
        flat,
        `nothing in lib/, gates/, scripts/, workflows/ or bin/ calls carryForward or ` +
          `suppressRepeats, so the prompt may not tell the reviewer a finding "is carried ` +
          `forward for you" — it would stop reporting a live finding on that promise (#1241)`,
      ).not.toContain("carried forward for you");
    } else {
      // A caller exists, so the sentence is earned. Require it, in the other
      // direction, rather than letting the case quietly stop asserting.
      expect(flat, `production callers exist (${production.join(", ")})`).toContain(
        "carried forward",
      );
    }
  }, 30_000);

  test("AC-S6: the committed workflow's rounds step names no scope at all", () => {
    const doc = Bun.YAML.parse(yml) as any;
    const step = (doc?.jobs?.[AI_REVIEW_JOB]?.steps ?? []).find(
      (s: any) => s?.id === AI_REVIEW_ROUNDS_STEP_ID,
    );
    const code = String(step?.run ?? "")
      .split("\n")
      .filter(l => !l.trim().startsWith("#"))
      .join("\n");
    // #1241 asserted the absence of `scope=diff` and the PRESENCE of
    // `scope=full`. That pair cannot refuse the thing it was written to
    // refuse: a hardcoded safe value is one edit from the unsafe one, and the
    // control demanded the very line that makes the edit available. #1255
    // deletes the decision instead, so the assertion is the absence of ANY
    // scope — which the cheapest wrong fix cannot satisfy.
    // `scope=` and not the bare word: every form that EMITS a scope carries
    // it — `scope=full`, `scope=diff`, `review_scope=%s` — while prose about
    // scoping does not. A bare `scope` was the second shape, a detector
    // wider than what it detects: #1281's refusal annotation says "scopes
    // the count" and reddened this for a sentence.
    expect(
      code,
      "the rounds step decides a review scope again. Only `reviewScopeForRound` may, and " +
        "only from a held verdict: a round-number scope is #244, and the fail-open " +
        "46034035 was reverted for it (#1241, #1255)",
    ).not.toContain("scope=");
    // The control: the step is non-empty and still does its actual job, so
    // the negative above is a reading of real code.
    expect(code).toContain(`${AI_REVIEW_ROUND_OUTPUT}=`);
  });

  test("AC-S6: the library still refuses to diff-scope a held FAIL at the floor", () => {
    // Unchanged and re-stated here, because the bash now pins `full` and can
    // no longer disagree with it. When the adjudicator is wired and the pin
    // comes off, this is the rule the bash has to restate.
    expect(reviewScopeForRound(String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL), { verdict: "FAIL", failures: ["x"] }))
      .toBe(REVIEW_SCOPE_FULL);
    expect(reviewScopeForRound(String(AI_REVIEW_DIFF_SCOPE_FROM_ROUND_LITERAL), { verdict: "PASS" }))
      .toBe(REVIEW_SCOPE_DIFF);
  });
});

/**
 * AC-S8 (#1295): the count is an UPPER BOUND, and `status=` is the wrong knob.
 *
 * #1295 reported that the query carries no `status` filter, so a run in which
 * nothing was reviewed still spends a round, and named `status=completed` as
 * the obvious addition. It is not merely insufficient — **it is inverted**,
 * and this block is the measurement that says so plus the guard that keeps it
 * out.
 *
 * Everything below was read off the live API on 2026-10-23 against
 * hornjason/pai-harness. The numbers are fixtures here because a test may not
 * reach the network; the commands that produced them are beside each one.
 */
describe("AC-S8 (#1295): the round count is an upper bound, and status= is the wrong knob", () => {
  /**
   * A curl that answers AS A FUNCTION OF THE REQUEST.
   *
   * `runRounds` above holds the response fixed and varies the script, so no
   * row of it can come back wrong about a request nobody wrote — the seventh
   * shape, with the input on the fixed axis. This rig puts the request on the
   * moving axis: it holds a run list and applies the `status=` term the way
   * GitHub does, so the script's own query decides the integer it reads back.
   */
  function runStatusAware(
    runs: { status: "completed" | "in_progress"; conclusion: string | null }[],
    script_: string,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "ai-review-rounds-status-"));
    try {
      const out = join(dir, "out.txt");
      writeFileSync(out, "");
      const bin = join(dir, "bin");
      require("node:fs").mkdirSync(bin);
      const argvPath = join(dir, "curl-argv.txt");
      const all = runs.length;
      const completed = runs.filter(r => r.status === "completed").length;
      const success = runs.filter(r => r.conclusion === "success").length;
      // The filter table, spelled as the API behaves: `status` accepts a
      // status OR a conclusion, one value, and selects on it.
      writeFileSync(
        join(bin, "curl"),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" >> ${JSON.stringify(argvPath)}
n=${all}
for a in "$@"; do
  case "$a" in
    status=completed) n=${completed} ;;
    status=success)   n=${success} ;;
  esac
done
printf '%s' "{\\"total_count\\":\${n},\\"workflow_runs\\":[]}"
`,
        { mode: 0o755 },
      );
      const script = join(dir, "step.sh");
      writeFileSync(script, script_);
      const r = spawnSync("bash", ["-e", script], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_OUTPUT: out,
          AI_REVIEW_EVENT: "pull_request",
          AI_REVIEW_ROUNDS_BRANCH: "rg/1297-per-finding-ballot",
          AI_REVIEW_ROUNDS_SINCE: "2026-10-23T00:25:53Z",
          AI_REVIEW_ROUNDS_REPO: "o/r",
          AI_REVIEW_ROUNDS_API: "https://api.github.test",
          AI_REVIEW_ROUNDS_TOKEN: "t",
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      const outputs: Record<string, string> = {};
      for (const line of readFileSync(out, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
      }
      const argv = existsSync(argvPath)
        ? readFileSync(argvPath, "utf8").split("\n").filter(Boolean)
        : [];
      return { status: r.status, stderr: r.stderr ?? "", outputs, argv };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The state of a pull request having its FIRST review: one run, this one,
  // in progress. Measured 2026-10-23T00:2{5,6}Z on PRs #1303 and #1304, whose
  // ai-review runs were live at the time:
  //
  //   gh api -X GET .../workflows/ai-review.yml/runs \
  //     -f branch=rg/1297-per-finding-ballot -f 'created=>=2026-10-23T00:25:53Z' \
  //     -f event=pull_request -f per_page=1 -q .total_count
  //   → 1                                        (no status term)
  //   … -f status=completed …                    → 0
  //
  // Both PRs read the same pair. The step counts ITSELF — "a run exists
  // before its first job starts" — and an in-progress run is not `completed`.
  const FIRST_ROUND_LIVE: { status: "completed" | "in_progress"; conclusion: string | null }[] = [
    { status: "in_progress", conclusion: null },
  ];

  test("AC-S8: the query carries no status term, and reads round 1 on a live first round", () => {
    const sh = runStatusAware(FIRST_ROUND_LIVE, buildRoundsScript());
    expect(sh.status, sh.stderr).toBe(0);
    expect(sh.outputs[AI_REVIEW_ROUND_OUTPUT]).toBe("1");
    expect(sh.argv.some(a => a.startsWith("status=")), "the step grew a status filter").toBe(false);
    // Controls: the request still carries the two terms it is supposed to, so
    // the negative above is a reading of a real query and not of an empty one.
    expect(sh.argv).toContain("branch=rg/1297-per-finding-ballot");
    expect(sh.argv).toContain("created=>=2026-10-23T00:25:53Z");
  }, 30_000);

  test("AC-S8: the MUTANT — status=completed — refuses every first round", () => {
    // The cheapest wrong fix, applied and measured, because #1295 names it
    // as the obvious one. `status=completed` excludes exactly one run on a
    // first round: THIS one. The count falls to 0, and 0 is already refused
    // by the fail-closed case above it — so the whole repair turns a working
    // first review into a hard red on a required check.
    const real = buildRoundsScript();
    const mutant = real.replace(
      '--data "event=pull_request" \\',
      '--data "event=pull_request" \\\n    --data "status=completed" \\',
    );
    expect(mutant, "the mutation did not apply — this measures nothing").not.toBe(real);

    const mut = runStatusAware(FIRST_ROUND_LIVE, mutant);
    const realRun = runStatusAware(FIRST_ROUND_LIVE, real);

    // The mutation is observed in the request, so the pair differs in one term.
    expect(mut.argv).toContain("status=completed");
    expect(realRun.argv.some(a => a.startsWith("status="))).toBe(false);

    // The reading, on one input: the wrong fix refuses, the real step does not.
    expect(mut.status, "status=completed did not refuse — the fake ignored the term").toBe(
      AI_REVIEW_REQUIRED_EXIT,
    );
    expect(mut.stderr).toContain(AI_REVIEW_ROUNDS_TITLE);
    expect(mut.outputs[AI_REVIEW_ROUND_OUTPUT]).toBeUndefined();
    expect(realRun.status, realRun.stderr).toBe(0);
    expect(realRun.outputs[AI_REVIEW_ROUND_OUTPUT]).toBe("1");
  }, 30_000);

  test("AC-S8: no run-level status is ever the non-review state #1295 describes", () => {
    // #1295 enumerates `cancelled`, `skipped` and `in progress` as rounds the
    // count spends on nothing. Measured over the whole population —
    //
    //   gh api -X GET .../workflows/ai-review.yml/runs \
    //     -f event=pull_request -f status=<s> -f per_page=1 -q .total_count
    //
    // on 2026-10-23, 622 `pull_request` runs of this workflow:
    const POPULATION = 622;
    const BY_STATUS = { completed: 620, cancelled: 0, skipped: 0, in_progress: 2 };
    expect(Object.values(BY_STATUS).reduce((a, b) => a + b, 0)).toBe(POPULATION);
    // Not one cancelled run and not one skipped run, ever. The only
    // non-completed runs were the two live ones — i.e. the current run, which
    // the step counts on purpose. So on this repository `status=completed`
    // would subtract the current run and nothing else, which is the previous
    // case: the knob the issue reaches for has no correct effect available.
    expect(BY_STATUS.cancelled + BY_STATUS.skipped).toBe(0);
  });

  test("AC-S8: a conclusion filter is wrong in BOTH directions, so no filter makes the count exact", () => {
    // The over-count #1295 is really about is entirely inside COMPLETED runs,
    // and it is invisible to every filter the runs API offers. Measured over
    // the 40 most recent completed `pull_request` runs on 2026-10-23, by
    // reading each run's check-run annotations for AI_REVIEW_ADJUDICATED_TITLE
    // — the notice #1087 added so this exact question is answerable from
    // outside the job:
    //
    //   gh api check-suites/<check_suite_id>/check-runs -q '…|select(.name=="ai-review")|.id'
    //   gh api check-runs/<id>/annotations -q '.[].title'
    //
    const CROSSTAB = {
      success: { reviewed: 24, notReviewed: 4 },
      failure: { reviewed: 7, notReviewed: 5 },
    };
    const runs = Object.values(CROSSTAB).reduce((a, c) => a + c.reviewed + c.notReviewed, 0);
    expect(runs).toBe(40);

    const reviewed = CROSSTAB.success.reviewed + CROSSTAB.failure.reviewed;
    const bySuccess = CROSSTAB.success.reviewed + CROSSTAB.success.notReviewed;
    expect(reviewed).toBe(31);
    expect(bySuccess).toBe(28);

    // The point is not that 28 ≠ 31. It is that the error has BOTH signs, so
    // no choice of filter value gets closer: `status=success` drops 7 runs in
    // which a review genuinely happened (a blocking verdict fails the check,
    // and that is a review) and keeps 4 in which none did (the
    // workflow-validation guard exits SUCCESS with no payload — the state
    // `skipped` in buildReportScript is about).
    //
    // These two assertions are the falsifiable ones. Had the data separated
    // cleanly — all reviews green, all non-reviews red — one of them would be
    // zero and a conclusion filter WOULD be the fix. Neither is.
    expect(CROSSTAB.failure.reviewed, "a blocking verdict is a review that happened").toBeGreaterThan(0);
    expect(CROSSTAB.success.notReviewed, "a guard skip exits zero having reviewed nothing").toBeGreaterThan(0);

    // So "a review happened" is a property of the findings payload, as #1295
    // says, and the only thing outside the job that carries it is the
    // adjudicated notice. Reading it costs two requests per prior run plus
    // `checks: read`, and the step today makes one request and holds
    // `actions: read` — which is why this block pins the count as an UPPER
    // BOUND rather than making it exact. An upper bound errs toward ending
    // review early; the alternative knob errs toward a cap that never fires,
    // and reReviewDecision already refuses that direction.
    expect(reviewed).toBeLessThanOrEqual(runs);
  });
});
