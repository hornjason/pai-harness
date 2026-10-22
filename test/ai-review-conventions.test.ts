/**
 * ai-review-conventions.test.ts — the reviewer is handed this repository's
 * review conventions, and a separate check says whether it loaded them
 * (#1167).
 *
 * ## The defect
 *
 * `claude_args` carries `--setting-sources user`, so project settings never
 * load and none of the eleven files in `.claude/rules/` reaches the agent
 * reviewing against them. There was no `REVIEW.md`, no `CODEOWNERS` and no PR
 * template either: `git ls-tree origin/main .github/` returned `workflows/`
 * and `copilot-instructions.md`. The reviewer got a diff and the generic
 * prompt, and nothing else.
 *
 * ## Why the loader alone would have been half the work
 *
 * Anthropic's own write-up of this (`solving-code-review-at-anthropic`)
 * describes `REVIEW.md` as the code owners' statement of what matters in
 * their part of the tree, and then adds the sentence this file is built to:
 * *"We check separately whether the reviewer actually follows it."*
 *
 * This repository already has eleven rule files' worth of the other thing —
 * an instruction with no compliance reading — and `#1009` is the record of
 * what that costs. A loader with no check would have made twelve.
 *
 * ## The three positions that must agree, and the one constant behind them
 *
 * `AI_REVIEW_CONVENTIONS_FILE` is read in three places and spelled in none
 * of them:
 *
 *   1. `buildReviewPrompt` tells the reviewer to read that name first;
 *   2. `AI_REVIEW_UNTRUSTED_PATHS` restores that name from the pull
 *      request BASE before the reviewer starts, so a branch cannot write
 *      the instructions its own reviewer runs under;
 *   3. `buildReviewRunScript` refuses a payload whose execution transcript
 *      carries no read of that name.
 *
 * A prompt naming one file and a check looking for another is a check that
 * is green on every tree. `AC-C6` is the case that holds them together.
 *
 * ## The evidence is third-party, and that is the whole design
 *
 * The reading comes out of the action's own execution transcript — the
 * `tool_use` blocks the SDK recorded — and never out of the findings payload.
 * A payload field saying "I read the conventions" is the agent grading its
 * own gate, and a reviewer that ignored the file is precisely the reviewer
 * whose self-report is worth nothing.
 *
 * ## An absent transcript REFUSES, and the premise for that was measured
 *
 * The first draft warned there and passed. Two readings turned it round:
 *
 *   * Across this repository's last 40 `ai-review` runs, the step's
 *     `AI_REVIEW_EXECUTION_FILE` is EMPTY on every run the action skipped on
 *     its workflow-validation guard — which is a run with no payload — and
 *     SET on all five where the agent executed. Run `39835040833` is the
 *     decisive one: a findings payload on disk, the adjudicator unable to
 *     fetch, and `/home/runner/work/_temp/claude-execution-output.json` in
 *     the step's env. This block runs only inside `[ -s findings-path ]`, so
 *     wherever it runs a payload exists, so the transcript is there.
 *   * `ai-review-workflow.test.ts` AC-9a asserts a CLEAN adjudication's
 *     output contains no `UNMEASURED` anywhere, so an operator grepping a
 *     green run gets a true answer. A fail-open warning on the success path
 *     breaks that invariant for every consumer.
 *
 * ## The cheapest wrong fix, named
 *
 * **Grep the transcript for the bare filename.** It is shorter, it passes
 * `AC-C1` and `AC-C2`, and it is wrong in the direction that matters: a
 * finding ABOUT `REVIEW.md`, or a `Grep` whose pattern contains the name,
 * puts the string in the transcript without the reviewer having opened the
 * file — so the check certifies the reviewer it exists to catch. `AC-C1b`
 * and `AC-C1c` are the cases that survive that repair, and `M3` below is the
 * repair applied.
 *
 * ## What was broken to prove it
 *
 * Counts predicted before the battery ran and the baseline row read first.
 * Mutations applied by hand to `lib/scaffold/ai-review-step.ts`, reverted,
 * and the file confirmed byte-identical by SHA-256. Measured over this file
 * alone (14 cases).
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 0 fail | **14 pass, 0 fail** | — |
 * | M1 the whole conventions block deleted from the shell template | 8 — C1, C1b, C1c, C2, C4, C6, and C8/C9 on "the mutation did not apply" | **8 of 14** | a payload whose transcript never read the file: original refuses, mutant adjudicates it clean |
 * | M2 the `[ -f ]` guard replaced by `true` | 2 — C3, and C6 on the missing literal | **2 of 14** | a consumer checkout with no conventions file: original passes, mutant refuses |
 * | M3 **the cheapest wrong fix**: the `file_path` anchor dropped for a bare `REVIEW\.md` | 3 — C1b, C1c, and C9 on "the mutation did not apply" | **3 of 14** | a transcript that MENTIONS the file without reading it: original refuses, mutant passes |
 * | M4 the absent-transcript branch returned to a warning and no exit | 1, and it is C4 | **1 of 14** | a payload with no transcript: original refuses, mutant reports a green check |
 * | M5 the conventions entry removed from `AI_REVIEW_UNTRUSTED_PATHS` | 1, and it is C6 | **1 of 14** | the restore list: a branch could then supply its own reviewer's instructions |
 *
 * Three rows redden a case on *"the mutation did not apply"* rather than on
 * behaviour, and that is the guard working rather than noise: C8 and C9 build
 * their mutants by rewriting a string in the generated script, so a mutation
 * that already removed that string leaves them witnessing nothing, and both
 * assert they still differ before they assert anything else.
 *
 * ## What this does NOT claim
 *
 * It does not claim the reviewer OBEYS the conventions — only that it loaded
 * them. The cap on non-blocking findings and the evidence each finding
 * carries are properties of the payload, adjudicated by
 * `lib/scaffold/ai-review-findings.ts`, and are not this file's subject.
 * Saying so is better than a case whose name implies a reading it does not
 * take.
 *
 * It does not assert anything about the reviewer's INTENT input — the linked
 * issue and the pull request body, which is #1167's second acceptance
 * bullet. The prompt may carry no `${{ }}` expression at all (an expression
 * is substituted before the action sees it, so a repository variable inside
 * the prompt is text an attacker who can set a variable controls), so intent
 * needs a step that writes it to a file under the granted `--add-dir` and a
 * prompt that names the path. That is a second mechanism and it is not here.
 */

// SPEC-REF: HARNESS-STANDARD.md § Success Criteria

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AI_REVIEW_CONVENTIONS_FILE,
  AI_REVIEW_CONVENTIONS_FILE_PATTERN,
  AI_REVIEW_CONVENTIONS_TITLE,
  AI_REVIEW_EXECUTION_FILE_VAR,
  AI_REVIEW_FINDINGS_PATH_VAR,
  AI_REVIEW_OUTCOME_LINE,
  AI_REVIEW_REQUIRED_EXIT,
  AI_REVIEW_UNMEASURED_TITLE,
  AI_REVIEW_UNTRUSTED_PATHS,
  buildReviewPrompt,
  buildReviewRunScript,
} from "../lib/scaffold/ai-review-step";
import { stubBunx } from "./helpers/stub-bunx";

/**
 * A fixture version for the adjudicator's `bunx` pin, never the real one —
 * `ai-review-failure-route.test.ts` gives the reason: passing the tree's own
 * version makes every assertion agree with the generator by construction.
 */
const FIXTURE_VERSION = "0.0.0-fixture";

const scratch: string[] = [];
afterAll(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

/** A clean payload, so every case here is about the conventions reading. */
const PAYLOAD = '{"findings": [], "verdict": "PASS"}';

/**
 * A transcript in the shape the action writes: a JSON array of SDK messages,
 * a tool call being a `tool_use` content block on an assistant message.
 *
 * Built from parts rather than from a literal so a case can vary exactly one
 * thing — which path the reviewer read — and nothing else.
 */
function transcript(reads: string[], extra: unknown[] = []): string {
  return JSON.stringify([
    { type: "system", subtype: "init", message: "Claude Code initialized" },
    {
      type: "assistant",
      message: {
        content: [
          ...reads.map(p => ({
            type: "tool_use",
            name: "Read",
            input: { file_path: p },
          })),
          ...extra,
        ],
      },
    },
    { type: "result", subtype: "success", is_error: false, num_turns: 9 },
  ]);
}

/**
 * Drive the real report step over a workspace this case owns.
 *
 * `cwd` is the scratch directory and not this repository, because the
 * property under test is whether the CHECKOUT carries a conventions file —
 * the step's working directory on a runner is `GITHUB_WORKSPACE`, the tree
 * under review. Inheriting the suite's own cwd would make every case read
 * this repository's `REVIEW.md` and `AC-C3`, the consumer case, could not be
 * written at all.
 *
 * The adjudicator is planted (`stubBunx`) for the reason that helper gives:
 * the real command names this tree's version and would reach the registry.
 * Its default here ANSWERS CLEAN, so a case that reaches it exits 0 — which
 * makes "the conventions refusal fired" and "the adjudication failed"
 * distinguishable by exit code alone.
 */
function runReport(opts: {
  /** `null` writes no conventions file into the workspace. */
  conventions?: string | null;
  /** `null` sets no transcript variable; `"unreadable"` names a missing path. */
  transcript?: string | null | "unreadable";
  payload?: string | null;
  adjudicator?: string;
  script?: string;
}): Run {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-conventions-"));
  scratch.push(dir);

  const sh = join(dir, "report.sh");
  writeFileSync(sh, opts.script ?? buildReviewRunScript(FIXTURE_VERSION));
  writeFileSync(join(dir, "github_output"), "");

  if (opts.conventions !== null) {
    writeFileSync(join(dir, AI_REVIEW_CONVENTIONS_FILE), opts.conventions ?? "# conventions\n");
  }

  const env: Record<string, string> = {
    PATH: stubBunx(opts.adjudicator ?? `echo "${AI_REVIEW_OUTCOME_LINE} CLEAN"; exit 0`),
    HOME: process.env.HOME ?? dir,
    GITHUB_OUTPUT: join(dir, "github_output"),
    AI_REVIEW_MODE: "vertex",
    AI_REVIEW_ACTION_OUTCOME: "success",
  };

  const payload = opts.payload === undefined ? PAYLOAD : opts.payload;
  if (payload !== null) {
    const findings = join(dir, "ai-review-findings.json");
    writeFileSync(findings, payload);
    env[AI_REVIEW_FINDINGS_PATH_VAR] = findings;
  }

  if (opts.transcript === "unreadable") {
    env[AI_REVIEW_EXECUTION_FILE_VAR] = join(dir, "claude-execution-output.json");
  } else if (opts.transcript !== null && opts.transcript !== undefined) {
    const p = join(dir, "claude-execution-output.json");
    writeFileSync(p, opts.transcript);
    env[AI_REVIEW_EXECUTION_FILE_VAR] = p;
  }

  const r = Bun.spawnSync(["bash", "-e", sh], { cwd: dir, env });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

/** A read of the conventions at the path a runner checkout puts them at. */
const RUNNER_PATH = `/home/runner/work/pai-harness/pai-harness/${AI_REVIEW_CONVENTIONS_FILE}`;

describe("AC-C: the reviewer's load of the conventions is read, not assumed (#1167)", () => {
  test("AC-C1: a review whose transcript never read the conventions is refused", () => {
    const run = runReport({
      transcript: transcript(["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"]),
    });

    expect(
      run.code,
      `a review that ignored the conventions reported a green check:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.err, "the refusal does not name the file it is about").toContain(
      AI_REVIEW_CONVENTIONS_FILE,
    );
    expect(run.err, "the refusal is not titled as unmeasured").toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );
    // BEFORE the adjudication, which is the placement claim and not a
    // decoration: the planted adjudicator answers CLEAN and exits 0, so its
    // outcome line in the log would mean the refusal came after a verdict
    // had already been taken over findings produced without the conventions.
    expect(
      run.out,
      "the adjudicator ran anyway, so a verdict was taken over an unconventioned review",
    ).not.toContain(AI_REVIEW_OUTCOME_LINE);
  });

  test("AC-C1b: a transcript that MENTIONS the conventions without reading them is refused", () => {
    // The input the cheapest wrong fix cannot tell apart. The reviewer
    // grepped for the name and wrote a finding about the file; it never
    // opened it.
    const run = runReport({
      transcript: transcript(
        ["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"],
        [
          {
            type: "tool_use",
            name: "Grep",
            input: { pattern: AI_REVIEW_CONVENTIONS_FILE, path: "." },
          },
          { type: "text", text: `No ${AI_REVIEW_CONVENTIONS_FILE} conventions were applicable.` },
        ],
      ),
    });

    expect(
      run.code,
      `a mention of the file was accepted as a read of it:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C1c: a read of a DIFFERENT file whose name ends in the same word is refused", () => {
    // The anchor. `docs/OLD-REVIEW.md` contains `REVIEW.md` as a substring,
    // and an unanchored match would credit it.
    const run = runReport({
      transcript: transcript([
        `/home/runner/work/pai-harness/pai-harness/docs/OLD-${AI_REVIEW_CONVENTIONS_FILE}`,
      ]),
    });

    expect(
      run.code,
      `a read of a different file was credited as the conventions:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
  });

  test("AC-C2: THE CONTROL — a transcript carrying the read passes, and says so", () => {
    // Without this the refusal above is indistinguishable from a gate stuck
    // closed, which is the state `ai-review-workflow.test.ts` AC-9a exists to
    // rule out one branch further on.
    const run = runReport({ transcript: transcript([RUNNER_PATH]) });

    expect(
      run.code,
      `a review that DID read the conventions was refused:\n${run.out}\n${run.err}`,
    ).toBe(0);
    expect(run.out, "the positive reading was not emitted").toContain(
      AI_REVIEW_CONVENTIONS_TITLE,
    );
    expect(run.out, "the adjudication did not run after the conventions reading").toContain(
      AI_REVIEW_OUTCOME_LINE,
    );
    // The invariant AC-9a holds elsewhere, asserted here for the one branch
    // this change added to the green path.
    expect(run.out, "a passing conventions reading still reported UNMEASURED").not.toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );
  });

  test("AC-C2b: a relative read of the conventions counts", () => {
    // The agent's cwd is the workspace, so a bare `REVIEW.md` is a legitimate
    // spelling of the same read. The pattern anchors at a path separator OR
    // at the opening quote for exactly this.
    const run = runReport({ transcript: transcript([AI_REVIEW_CONVENTIONS_FILE]) });
    expect(
      run.code,
      `a relative read of the conventions was not credited:\n${run.out}\n${run.err}`,
    ).toBe(0);
  });

  test("AC-C3: a consumer checkout with no conventions file is not refused", () => {
    // This generator writes jobs for repositories that have never heard of
    // the file. A gate that refuses them is a gate that gets deleted.
    const run = runReport({
      conventions: null,
      transcript: transcript(["/home/runner/work/consumer/consumer/src/index.ts"]),
    });

    expect(
      run.code,
      `a consumer with no conventions document was refused:\n${run.out}\n${run.err}`,
    ).toBe(0);
    expect(
      run.out + run.err,
      "a repository with no conventions file was told about conventions",
    ).not.toContain(AI_REVIEW_CONVENTIONS_TITLE);
    expect(run.out, "the adjudication did not run").toContain(AI_REVIEW_OUTCOME_LINE);
  });

  test("AC-C4: a payload with no readable transcript is refused, and says something else", () => {
    const run = runReport({ transcript: "unreadable" });

    expect(
      run.code,
      `a payload nothing can be read about reported a green check:\n${run.out}\n${run.err}`,
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(run.err, "the refusal is not titled as unmeasured").toContain(
      AI_REVIEW_UNMEASURED_TITLE,
    );

    // A DIFFERENT sentence from AC-C1's. Two states wearing one message is
    // two states nobody can tell apart from outside the job — the defect
    // `ai-review-failure-route.test.ts` AC-F6c is the control for.
    const ignored = runReport({
      transcript: transcript(["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"]),
    });
    expect(
      run.err,
      "an absent transcript and an ignored file produce the same sentence",
    ).not.toBe(ignored.err);
  });

  test("AC-C5: no payload means no conventions reading — the states do not merge", () => {
    // The block is inside the payload branch on purpose. With no payload the
    // review did not happen at all, and that is already reported by #1180's
    // refusal; reporting it twice under two titles is one state as two.
    const run = runReport({ payload: null, transcript: transcript([RUNNER_PATH]) });
    expect(
      run.out + run.err,
      "a run with no payload was adjudicated on its conventions",
    ).not.toContain(AI_REVIEW_CONVENTIONS_TITLE);
  });

  test("AC-C6: the prompt, the restore list and the check all name ONE file", () => {
    // Three literals that agree today are two deciders too many. Changing
    // the constant must move all three or this case reds.
    expect(
      buildReviewPrompt(),
      "the prompt does not tell the reviewer to read the conventions",
    ).toContain(AI_REVIEW_CONVENTIONS_FILE);

    expect(
      AI_REVIEW_UNTRUSTED_PATHS,
      "the conventions are not restored from the base, so a branch can write its own reviewer's instructions",
    ).toContain(AI_REVIEW_CONVENTIONS_FILE);

    const script = buildReviewRunScript(FIXTURE_VERSION);
    expect(script, "the check does not test for the file in the checkout").toContain(
      `[ -f "${AI_REVIEW_CONVENTIONS_FILE}" ]`,
    );
    expect(script, "the check does not grep the transcript for a read of it").toContain(
      AI_REVIEW_CONVENTIONS_FILE_PATTERN,
    );
  });

  test("AC-C6b: the escaped pattern is DERIVED, so a rename cannot leave it behind", () => {
    // `REVIEW.md` and `REVIEW\.md` differ by one backslash, which is the
    // kind of difference a reader checks once and never again.
    expect(AI_REVIEW_CONVENTIONS_FILE_PATTERN.replace(/\\/g, "")).toBe(
      AI_REVIEW_CONVENTIONS_FILE,
    );
    expect(
      new RegExp(`^${AI_REVIEW_CONVENTIONS_FILE_PATTERN}$`).test(AI_REVIEW_CONVENTIONS_FILE),
      "the escaped pattern does not match the name it was derived from",
    ).toBe(true);
    expect(
      new RegExp(`^${AI_REVIEW_CONVENTIONS_FILE_PATTERN}$`).test(
        AI_REVIEW_CONVENTIONS_FILE.replace(".", "X"),
      ),
      "the pattern's `.` is unescaped, so it matches any character",
    ).toBe(false);
  });

  test("AC-C7: the COMMITTED workflow carries the check, not only the generator", () => {
    // `ai-review-surface-census.test.ts` compares the whole file against a
    // regeneration, which covers this and everything else. Named here too
    // because a generator change that was never scaffolded is the one way
    // this work ships inert, and a case that says so by name is cheaper to
    // read than a byte diff.
    const committed = readFileSync(
      join(import.meta.dir, "..", ".github", "workflows", "ai-review.yml"),
      "utf8",
    );
    expect(committed, "the committed workflow has no conventions check").toContain(
      `[ -f "${AI_REVIEW_CONVENTIONS_FILE}" ]`,
    );
    expect(committed, "the committed prompt does not name the conventions").toContain(
      `\`${AI_REVIEW_CONVENTIONS_FILE}\``,
    );
  });

  test("AC-C8: THE MUTANT — the refusals stop when the exit constant is zeroed", () => {
    // `.claude/rules/checks-must-be-able-to-fail.md`, "For a script whose job
    // is to exit non-zero". Both refusals are observed STOPPING, which is the
    // removal of the non-zero exit performed rather than argued about.
    const real = buildReviewRunScript(FIXTURE_VERSION);
    const mutant = real.replace(
      new RegExp(`exit ${AI_REVIEW_REQUIRED_EXIT}\\n(\\s*)fi\\n(\\s*)else`),
      "exit 0\n$1fi\n$2else",
    );
    expect(mutant, "the mutation did not apply").not.toBe(real);

    const ignoredReal = runReport({
      transcript: transcript(["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"]),
    });
    const ignoredMutant = runReport({
      transcript: transcript(["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"]),
      script: mutant,
    });

    expect(ignoredReal.code, "the real script did not refuse").toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      ignoredMutant.code,
      "the mutant did not differ — this case witnesses nothing about the refusal",
    ).toBe(0);
  });

  test("AC-C9: THE CHEAPEST WRONG FIX — the bare-name grep, run", () => {
    // Shorter, green on AC-C1 and AC-C2, and it certifies the reviewer the
    // check exists to catch. Applied here rather than described.
    const real = buildReviewRunScript(FIXTURE_VERSION);
    const naive = real.replace(
      `'"file_path"[[:space:]]*:[[:space:]]*"([^"]*/)?${AI_REVIEW_CONVENTIONS_FILE_PATTERN}"'`,
      `'${AI_REVIEW_CONVENTIONS_FILE_PATTERN}'`,
    );
    expect(naive, "the mutation did not apply").not.toBe(real);

    const mention = transcript(
      ["/home/runner/work/pai-harness/pai-harness/lib/scanner.ts"],
      [{ type: "text", text: `No ${AI_REVIEW_CONVENTIONS_FILE} conventions were applicable.` }],
    );

    expect(
      runReport({ transcript: mention }).code,
      "the real check accepted a mention as a read",
    ).toBe(AI_REVIEW_REQUIRED_EXIT);
    expect(
      runReport({ transcript: mention, script: naive }).code,
      "the cheap fix is not actually green here, so AC-C1b is not the case that survives it",
    ).toBe(0);

    // And it is a PLAUSIBLE fix, which is what makes it the dangerous one.
    expect(
      runReport({ transcript: transcript([RUNNER_PATH]), script: naive }).code,
      "the cheap fix is not a plausible repair, so naming it proves nothing",
    ).toBe(0);
  });

  test("AC-C10: the conventions document the prompt points at exists", () => {
    // A prompt telling an agent to read a doc that is not there is the
    // `.claude/rules/self-referential-tests.md` row, applied to the one
    // reader that cannot ask anybody.
    const path = join(import.meta.dir, "..", AI_REVIEW_CONVENTIONS_FILE);
    const body = readFileSync(path, "utf8");
    expect(body.length, "the conventions document is empty").toBeGreaterThan(0);
    // The three things the prompt promises it states. Checked as subjects
    // rather than as wording: this document is prose a human owns, and a
    // byte-comparison against the prompt would make editing it a test
    // failure.
    for (const subject of ["flag", "evidence", "generated"]) {
      expect(
        body.toLowerCase(),
        `the prompt tells the reviewer this document covers "${subject}" and it does not`,
      ).toContain(subject);
    }
  });
});
